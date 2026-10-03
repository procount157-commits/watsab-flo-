// ── Reading a spreadsheet nobody prepared ─────────────────────────
// The owner uploads the Excel file as it came — a directory export, a
// scraped list, a client's CRM dump — and this works out which column is
// the email, which the company, which the phone, cleans what it finds, and
// says exactly what it kept and what it threw away. Column detection is by
// header name first and by the look of the values second, because half the
// files have no usable headers.

import { promises as dns } from "node:dns";

export interface ImportRow {
  email: string;
  name?: string;
  company?: string;
  phone?: string;
  industry?: string;
  city?: string;
}

export interface ImportReport {
  rows: ImportRow[];
  total: number;
  kept: number;
  invalid: number;
  duplicates: number;
  roleAddresses: number;       // info@, sales@ … kept, but counted
  columns: Record<string, string | null>;
  sample: ImportRow[];
  /** Rows carrying a phone and no address at all. */
  phoneOnly: PhoneOnlyRow[];
  /** More than one address against one company. */
  extraAddresses: number;
}

/**
 * A row with a phone and no e-mail.
 *
 * These used to be counted as invalid and dropped on the floor. A directory
 * export is full of them, and a company with a phone is worth something to the
 * WhatsApp side of this system even when it is worth nothing to the e-mail
 * side — losing it silently is the one outcome that helps nobody.
 */
export interface PhoneOnlyRow {
  phone: string;
  company?: string;
  name?: string;
  city?: string;
  industry?: string;
}

const EMAIL_RE = /^[a-z0-9._%+\-']+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
// The same pattern unanchored, for pulling several addresses out of one cell.
// Files arrive with "a@x.ae, b@x.ae" and with "Email / Email 2 / Email 3"
// columns, and the single-address version threw away the whole cell.
const EMAIL_SCAN = /[a-z0-9._%+\-']+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const ROLE_LOCAL = /^(info|sales|admin|contact|support|hello|office|accounts|hr|marketing|noreply|no-reply|enquiry|enquiries|inquiry|help|mail)$/i;

// Header words, in the languages the files come in.
const H = {
  email:    /^(e-?mail|البريد|الايميل|الإيميل|ايميل|إيميل|بريد|mail)/i,
  name:     /^(name|full ?name|contact|الاسم|اسم|المسؤول|person|owner|manager|مدير)/i,
  company:  /^(company|business|firm|organi[sz]ation|الشركة|شركة|المنشأة|المؤسسة|اسم الشركة|trade ?name|establishment)/i,
  phone:    /^(phone|mobile|tel|whatsapp|الهاتف|هاتف|جوال|الجوال|رقم|موبايل|واتساب)/i,
  industry: /^(industry|activity|sector|category|type|النشاط|نشاط|القطاع|قطاع|التصنيف|المجال)/i,
  city:     /^(city|emirate|location|area|المدينة|مدينة|الإمارة|إمارة|الموقع|المنطقة)/i,
};

export function normalizeEmail(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "").replace(/[<>()\[\]"'\s]/g, "");
  if (!EMAIL_RE.test(s)) return null;
  if (s.length > 254) return null;
  return s;
}

/**
 * Every address in one cell.
 *
 * A directory export puts two or three in a field separated by commas, slashes
 * or newlines, and the row-level validator rejected the lot — so a company
 * with two addresses contributed neither, and the company itself was lost with
 * them.
 */
export function emailsIn(raw: unknown): string[] {
  const s = String(raw ?? "").replace(/mailto:/gi, " ");
  const found = s.match(EMAIL_SCAN) ?? [];
  const out: string[] = [];
  for (const m of found) {
    const e = normalizeEmail(m);
    if (e && !out.includes(e)) out.push(e);
  }
  return out;
}

export function isRoleAddress(email: string): boolean {
  return ROLE_LOCAL.test(email.split("@")[0]!);
}

function looksLikePhone(v: unknown): boolean {
  const s = String(v ?? "").replace(/[\s\-\+\(\)\.]/g, "");
  return /^\d{7,15}$/.test(s);
}

/**
 * Decide which column is which. Headers win when they say something; the
 * values decide otherwise (a column where most cells contain @ is the email
 * column whatever it is called).
 */
export function detectColumns(rows: Array<Record<string, unknown>>): Record<keyof ImportRow, string | null> {
  const out: Record<keyof ImportRow, string | null> = { email: null, name: null, company: null, phone: null, industry: null, city: null };
  if (!rows.length) return out;
  const headers = Object.keys(rows[0]!);

  // "اسم الشركة" starts with "اسم", so company is tried before name.
  const ORDER: Array<keyof typeof H> = ["company", "email", "phone", "industry", "city", "name"];
  for (const k of ORDER) {
    for (const h of headers) {
      if (out[k]) break;
      if (H[k].test(h.trim()) && !Object.values(out).includes(h)) out[k] = h;
    }
  }

  const sample = rows.slice(0, 200);
  const score = (h: string, f: (v: unknown) => boolean) => sample.filter((r) => f(r[h])).length / sample.length;
  if (!out.email) {
    const best = headers.map((h) => [h, score(h, (v) => !!normalizeEmail(v))] as const).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 0.3) out.email = best[0];
  }
  if (!out.phone) {
    const best = headers.filter((h) => h !== out.email).map((h) => [h, score(h, looksLikePhone)] as const).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 0.5) out.phone = best[0];
  }
  if (!out.company) {
    // The widest text column that is not the email, phone or name.
    const taken = new Set([out.email, out.phone, out.name, out.industry, out.city].filter(Boolean));
    const best = headers.filter((h) => !taken.has(h))
      .map((h) => [h, sample.reduce((a, r) => a + String(r[h] ?? "").length, 0)] as const)
      .sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) out.company = best[0];
  }
  return out;
}

/**
 * Clean the rows: every address found, each against the company it belongs to.
 *
 * Three things this does that the first version did not, each of which was
 * losing records on a real file. It reads *every* column for addresses rather
 * than the one detected as "the email column", because files come with "Email"
 * and "Email 2". It splits a cell holding several addresses instead of
 * rejecting it whole — a cell reading "contact@x.ae, ceo@x.ae" used to fail
 * the row-level pattern, so that company contributed nothing at all. And a row
 * with a phone and no address is handed back rather than counted as invalid,
 * since it is still a company this business can reach.
 *
 * Measured on a five-row file carrying eight addresses, the first version kept
 * three.
 */
export function cleanRows(rows: Array<Record<string, unknown>>, columns = detectColumns(rows)): ImportReport {
  const seen = new Set<string>();
  const kept: ImportRow[] = [];
  const phoneOnly: PhoneOnlyRow[] = [];
  let invalid = 0, duplicates = 0, roles = 0, extraAddresses = 0;
  const str = (r: Record<string, unknown>, k: string | null) => (k ? String(r[k] ?? "").trim().slice(0, 200) || undefined : undefined);

  // Columns that are definitely something else; everything left may hold an
  // address, whatever its header says.
  const notEmail = new Set([columns.phone, columns.city, columns.industry].filter(Boolean) as string[]);

  for (const r of rows) {
    const phoneRaw = str(r, columns.phone)?.replace(/[\s\-\+\(\)\.]/g, "").replace(/^00/, "");
    const phone = phoneRaw && /^\d{7,15}$/.test(phoneRaw) ? phoneRaw : undefined;
    const company = str(r, columns.company);
    const name = str(r, columns.name);
    const city = str(r, columns.city);
    const industry = str(r, columns.industry);

    // The detected column first, so its address is the one that keeps the
    // contact's name when a row has several.
    const found: string[] = [];
    for (const e of emailsIn(columns.email ? r[columns.email] : "")) if (!found.includes(e)) found.push(e);
    for (const [h, v] of Object.entries(r)) {
      if (h === columns.email || notEmail.has(h)) continue;
      for (const e of emailsIn(v)) if (!found.includes(e)) found.push(e);
    }

    if (!found.length) {
      // Not junk — just not an e-mail record. The phone still is one.
      if (phone) phoneOnly.push({ phone, company, name, city, industry });
      else invalid++;
      continue;
    }

    found.forEach((email, i) => {
      if (seen.has(email)) { duplicates++; return; }
      seen.add(email);
      if (isRoleAddress(email)) roles++;
      if (i > 0) extraAddresses++;
      kept.push({
        email,
        // Only the first address carries the person's name: a second address
        // on the same row belongs to the company, not to that person.
        name: i === 0 ? name : undefined,
        company, phone, industry, city,
      });
    });
  }
  return {
    rows: kept, total: rows.length, kept: kept.length, invalid, duplicates,
    roleAddresses: roles, columns, sample: kept.slice(0, 5),
    phoneOnly, extraAddresses,
  };
}

/** Group by a field for auto-splitting into lists. Unlabelled rows go under "غير محدد". */
export function splitBy(rows: ImportRow[], field: "industry" | "city"): Map<string, ImportRow[]> {
  const m = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const k = (r[field] ?? "").trim() || "غير محدد";
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(r);
  }
  return m;
}

/**
 * Does the domain accept mail at all? A domain with no MX (and no A) record
 * bounces everything, and a bounce is the one thing a new sending address
 * cannot afford. Cached per domain for the run; a lookup failure is "unknown"
 * rather than "bad".
 */
export async function checkMx(domains: Iterable<string>, concurrency = 8): Promise<Map<string, boolean | null>> {
  const out = new Map<string, boolean | null>();
  const list = [...new Set(domains)];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const d = list[i++]!;
      try {
        const mx = await dns.resolveMx(d);
        if (mx.length) { out.set(d, true); continue; }
        const a = await dns.resolve4(d).catch(() => []);
        out.set(d, a.length > 0);
      } catch (err: any) {
        const code = err?.code;
        out.set(d, code === "ENOTFOUND" || code === "ENODATA" ? false : null);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}
