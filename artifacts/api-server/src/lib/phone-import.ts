// ── Reading phone numbers out of a spreadsheet nobody prepared ────
// One reader for both doors: the WhatsApp number lists and the email
// import. Both get the same file — a directory export, a scraped list, a
// client's CRM dump — and both need the same three things out of it: the
// WhatsApp-capable number, the company's name, and (for email) the address.
//
// What the old browser-side parser got wrong, each of which dropped real
// numbers without a word:
//
//   - only the first sheet was read;
//   - headers had to match exactly, so "Company Name", "Mobile No." and
//     "اسم الشركة التجارية" were not recognised;
//   - one phone column was taken — the first — so a file with "Phone"
//     (landline) before "Mobile" lost every mobile to the landline filter;
//   - a cell holding two numbers failed as a whole;
//   - the person's name was saved and the company's ignored;
//   - every local number was assumed to be Emirati, so a Saudi 05xxxxxxxx
//     became +971 and was sent to someone else, or to nobody.
//
// Everything here is pure; the route does the saving.

import * as XLSX from "xlsx";
import { normalizeArabic } from "./intent";

// ── Countries ─────────────────────────────────────────────────────
// Local length is without the trunk 0. `mobile` is tested against the local
// part. Only the countries this product sells into are described; any other
// international number is kept as valid with its mobility unknown.
interface Country { cc: string; iso: string; local: number[]; mobile: RegExp }
export const COUNTRIES: Country[] = [
  { cc: "971", iso: "AE", local: [8, 9], mobile: /^5[0-9]\d{7}$/ },
  { cc: "966", iso: "SA", local: [8, 9], mobile: /^5\d{8}$/ },
  { cc: "974", iso: "QA", local: [8],    mobile: /^[3567]\d{7}$/ },
  { cc: "965", iso: "KW", local: [8],    mobile: /^[569]\d{7}$/ },
  { cc: "973", iso: "BH", local: [8],    mobile: /^[36]\d{7}$/ },
  { cc: "968", iso: "OM", local: [8],    mobile: /^[79]\d{7}$/ },
  { cc: "20",  iso: "EG", local: [9, 10], mobile: /^1[0125]\d{8}$/ },
  { cc: "962", iso: "JO", local: [8, 9], mobile: /^7[789]\d{7}$/ },
  { cc: "961", iso: "LB", local: [7, 8], mobile: /^(3\d{6}|7[0-9]\d{6}|81\d{6})$/ },
  { cc: "963", iso: "SY", local: [9],    mobile: /^9\d{8}$/ },
  { cc: "964", iso: "IQ", local: [9, 10], mobile: /^7\d{9}$/ },
  { cc: "212", iso: "MA", local: [9],    mobile: /^[67]\d{8}$/ },
  { cc: "249", iso: "SD", local: [9],    mobile: /^[19]\d{8}$/ },
  { cc: "967", iso: "YE", local: [9],    mobile: /^7\d{8}$/ },
  { cc: "216", iso: "TN", local: [8],    mobile: /^[2459]\d{7}$/ },
  { cc: "213", iso: "DZ", local: [9],    mobile: /^[567]\d{8}$/ },
  { cc: "91",  iso: "IN", local: [10],   mobile: /^[6-9]\d{9}$/ },
  { cc: "92",  iso: "PK", local: [10],   mobile: /^3\d{9}$/ },
];
const BY_ISO = new Map(COUNTRIES.map((c) => [c.iso, c]));
// Longest code first, so 971 is tried before 97 would be.
const BY_CC = [...COUNTRIES].sort((a, b) => b.cc.length - a.cc.length);

export type CountryIso = string;

export interface Phone {
  /** International digits, no + — what WhatsApp and the contacts table use. */
  e164: string;
  iso: string | null;
  /** true mobile, false landline, null for a country not described above. */
  mobile: boolean | null;
}

const toLatinDigits = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/**
 * One number, as it was written, to international digits.
 *
 * `fallback` is the country a number with no international prefix belongs
 * to — the import's default, or the row's own country when the file says.
 */
export function normalizePhone(raw: unknown, fallback: CountryIso = "AE"): Phone | null {
  if (raw === null || raw === undefined) return null;
  let s = typeof raw === "number"
    // A number cell: 971501234567 arrives as a number, and so does a local
    // 0501234567 with its zero already gone. Scientific notation has lost
    // digits and cannot be recovered.
    ? (Number.isInteger(raw) ? String(raw) : "")
    : toLatinDigits(String(raw));
  if (!s || /e\+?\d/i.test(s)) return null;

  const hadPlus = /^\s*\+/.test(s);
  let d = s.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);

  const tryIntl = (digits: string): Phone | null => {
    for (const c of BY_CC) {
      if (!digits.startsWith(c.cc)) continue;
      let local = digits.slice(c.cc.length);
      if (local.startsWith("0")) local = local.slice(1);     // +971 0 50… happens
      if (!c.local.includes(local.length)) continue;
      return { e164: c.cc + local, iso: c.iso, mobile: c.mobile.test(local) };
    }
    return null;
  };

  const country = BY_ISO.get(fallback) ?? BY_ISO.get("AE")!;
  const tryLocal = (digits: string): Phone | null => {
    const local = digits.startsWith("0") ? digits.slice(1) : digits;
    if (!country.local.includes(local.length)) return null;
    return { e164: country.cc + local, iso: country.iso, mobile: country.mobile.test(local) };
  };

  // Explicitly international first. Otherwise a local form wins when it
  // fits: 0501234567 is a UAE (or Saudi) mobile, not a number in country 050.
  if (hadPlus || s.trim().startsWith("00")) return tryIntl(d) ?? genericIntl(d);
  if (d.startsWith("0")) return tryLocal(d);
  return tryLocal(d) ?? tryIntl(d) ?? genericIntl(d);
}

function genericIntl(d: string): Phone | null {
  // An international number from somewhere not described above. Kept, with
  // mobility unknown, rather than thrown away.
  if (d.length < 10 || d.length > 15 || d.startsWith("0")) return null;
  return { e164: d, iso: null, mobile: null };
}

/**
 * Every number in a cell. A cell often holds two — "050 123 4567 / 04 123 4567",
 * "Tel: 04… Mob: 050…" — and space-separated numbers run together, so a run
 * of digits too long to be one number is split back into the ones it holds.
 */
export function phonesInCell(raw: unknown, fallback: CountryIso = "AE"): Phone[] {
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw === "number") { const p = normalizePhone(raw, fallback); return p ? [p] : []; }
  const s = toLatinDigits(String(raw))
    .replace(/https?:\/\/\S+|www\.\S+|\S+\.(?:com|net|org|ae|sa|io|co)(?:\/\S*)?/gi, " ")
    .replace(/\S+@\S+/g, " ")
    .replace(/-?\d{1,3}\.\d{4,}/g, " ");
  const out: Phone[] = [];
  const seen = new Set<string>();
  const push = (p: Phone | null) => { if (p && !seen.has(p.e164)) { seen.add(p.e164); out.push(p); } };

  for (const m of s.matchAll(/(?:\+|00)?\d[\d\s\-().]{5,}\d/g)) {
    const run = m[0];
    const whole = normalizePhone(run, fallback);
    if (whole && run.replace(/\D/g, "").length <= 15) { push(whole); continue; }
    // Too long for one number: rebuild numbers from the space-separated pieces.
    const pieces = run.split(/\s+/).filter(Boolean);
    let buf = "";
    for (let i = 0; i < pieces.length; i++) {
      buf += pieces[i];
      const next = pieces[i + 1];
      const here = normalizePhone(buf, fallback);
      const nextStartsNumber = !next || /^(\+|00|0)/.test(next) || next.replace(/\D/g, "").length >= 9;
      if (here && nextStartsNumber) { push(here); buf = ""; }
    }
  }
  return out;
}

// ── Columns ───────────────────────────────────────────────────────

export type Field = "company" | "person" | "email" | "phone" | "mobile" | "whatsapp" | "landline" | "fax" | "country" | "city" | "industry" | "skip";

// Header words, normalised the way normalizeArabic writes them (ة→ه, أ→ا,
// ى→ي, lower-case, punctuation to spaces). Order matters: more specific
// fields first, so "اسم الشركه" is a company before "اسم" makes it a person.
const HEADERS: Array<[Field, RegExp]> = [
  // Never numbers, whatever digits they hold: a Facebook page id in a link
  // read as a fifteen-digit "phone" once, for half of a 1,300-row list.
  ["skip",     /(social|links?|url|website|web site|facebook|instagram|linkedin|twitter|tiktok|coordinates|lat(itude)?|lng|lon(gitude)?|confidence|score|source|حسابات|روابط|رابط|الموقع الالكتروني|موقع الكتروني|الاحداثيات|احداثيات|الثقه|المصدر|تصنيف المصدر|سبب التصنيف|ملاحظات|جاهز للتواصل)/],
  ["fax",      /\b(fax|فاكس)\b/],
  ["whatsapp", /(whats ?app|واتس ?اب|واتساب|وتساب)/],
  ["email",    /(e ?mail|البريد|الايميل|ايميل|بريد الكتروني|mail)/],
  ["mobile",   /(mobile|mob\b|cell|gsm|جوال|الجوال|موبايل|محمول|نقال)/],
  ["landline", /(landline|land line|office (phone|tel)|هاتف ثابت|الهاتف الثابت|ثابت|المكتب)/],
  ["phone",    /(phone|tel\b|telephone|contact (no|number)|number|هاتف|الهاتف|تلفون|تليفون|رقم|ارقام|(رقم|هاتف) (ال)?تواصل)/],
  ["company",  /(company|business|trade ?name|establishment|organi[sz]ation|firm|account name|brand|store|shop|agency|brokerage|office name|entity|شركه|الشركه|المنشاه|منشاه|المؤسسه|مؤسسه|الاسم التجاري|اسم تجاري|المحل|محل|المكتب العقاري|الوكاله|^الجهه$|^جهه$|اسم الجهه)/],
  ["person",   /^(name|full ?name|contact|contact (name|person)|owner|manager|first ?name|person|client|customer|الاسم|اسم|اسم العميل|العميل|الشخص|المسؤول|اسم المسؤول|المالك|صاحب|المدير|اسم الشخص)$|^(name|contact person|الاسم|اسم المسؤول)\b/],
  ["country",  /^(country|nationality|الدوله|البلد|الدول)$/],
  ["city",     /(city|emirate|region|area|location|المدينه|الاماره|الامارات?|المنطقه|الموقع)/],
  ["industry", /(industry|activity|sector|category|business type|النشاط|نشاط|القطاع|التصنيف|المجال|نوع النشاط)/],
];

export function headerField(h: unknown): Field | null {
  const n = normalizeArabic(String(h ?? "")).replace(/[_\-.#:]+/g, " ").replace(/\s+/g, " ").trim();
  if (!n || n.length > 60) return null;
  for (const [f, re] of HEADERS) if (re.test(n)) return f;
  return null;
}

// Cities and places that say which country a row is in, whatever the
// import's default. Normalised spellings.
const SA_PLACES = /(saudi|ksa|riyadh|jeddah|jiddah|dammam|khobar|makkah|mecca|madinah|medina|taif|tabuk|abha|qassim|buraidah|hail|jazan|najran|yanbu|jubail|ahsa|السعوديه|الرياض|جده|الدمام|الخبر|مكه|المدينه المنوره|الطايف|تبوك|ابها|القصيم|بريده|حايل|جازان|نجران|ينبع|الجبيل|الاحساء)/;
const AE_PLACES = /(uae|emirates|dubai|abu dhabi|sharjah|ajman|fujairah|ras al khaimah|rak|umm al quwain|al ain|الامارات|دبي|ابوظبي|ابو ظبي|الشارقه|عجمان|الفجيره|راس الخيمه|ام القيوين|العين)/;
const OTHER_PLACES: Array<[RegExp, string]> = [
  [/(qatar|doha|قطر|الدوحه)/, "QA"], [/(kuwait|الكويت)/, "KW"], [/(bahrain|manama|البحرين|المنامه)/, "BH"],
  [/(oman|muscat|عمان|مسقط)/, "OM"], [/(egypt|cairo|مصر|القاهره|الاسكندريه)/, "EG"], [/(jordan|amman|الاردن)/, "JO"],
];
export function countryOf(...values: unknown[]): CountryIso | null {
  const n = normalizeArabic(values.filter(Boolean).join(" "));
  if (!n) return null;
  if (SA_PLACES.test(n)) return "SA";
  if (AE_PLACES.test(n)) return "AE";
  for (const [re, iso] of OTHER_PLACES) if (re.test(n)) return iso;
  return null;
}

const EMAIL_RE = /[a-z0-9._%+\-']+@(?:[a-z0-9-]+\.)+[a-z]{2,}/i;
/** The same, global, for pulling every address out of a row. */
const EMAIL_SCAN = /[a-z0-9._%+\-']+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;

// ── Sheets ────────────────────────────────────────────────────────

export interface SheetTable { sheet: string; headers: string[]; rows: unknown[][] }

/**
 * Every sheet of the workbook, each with its header row found rather than
 * assumed: exported reports often open with a title and a blank line, and
 * reading row one as the headers turned the whole file into one bad column.
 */
export function readWorkbook(buf: Buffer): SheetTable[] {
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, dense: true });
  const out: SheetTable[] = [];
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name]!, { header: 1, defval: "", blankrows: false, raw: true }) as unknown[][];
    if (!grid.length) continue;
    let best = -1, bestScore = 0;
    for (let i = 0; i < Math.min(15, grid.length); i++) {
      const score = (grid[i] ?? []).filter((c) => typeof c === "string" && headerField(c)).length;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    if (best >= 0) out.push({ sheet: name, headers: (grid[best] ?? []).map((h) => String(h ?? "").trim()), rows: grid.slice(best + 1) });
    else out.push({ sheet: name, headers: [], rows: grid });
  }
  return out;
}

/** Pasted text: one row per line, cells split on tabs, semicolons or commas. */
export function readText(text: string): SheetTable[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines.some((l) => l.includes(";")) ? ";" : ",";
  const grid = lines.map((l) => l.split(sep).map((c) => c.trim()));
  const first = grid[0] ?? [];
  const isHeader = first.filter((c) => headerField(c)).length > 0 && !first.some((c) => /\d{7,}/.test(c));
  if (isHeader) return [{ sheet: "لصق", headers: first, rows: grid.slice(1) }];
  // No headers: each line is a name and a number in any order, or a number
  // alone. Put them in two fixed columns so a bare number on one line is not
  // read as the name column of the next.
  const rows = grid.map((cells) => {
    const at = cells.findIndex((c) => phonesInCell(c).length > 0);
    if (at < 0) return [cells.join(" "), ""];
    return [cells.filter((_, i) => i !== at).join(" ").trim(), cells[at]!];
  });
  return [{ sheet: "لصق", headers: ["الاسم", "رقم"], rows }];
}

export interface ColumnMap {
  /** Columns holding numbers, most WhatsApp-likely first. */
  phones: number[];
  company: number | null;
  person: number | null;
  email: number | null;
  country: number | null;
  city: number | null;
  industry: number | null;
  /** How each was decided, for the report. */
  labels: Record<string, string>;
}

const PHONE_PRIORITY: Record<string, number> = { whatsapp: 0, mobile: 1, phone: 2, landline: 3 };

export function mapColumns(t: SheetTable): ColumnMap {
  const width = Math.max(t.headers.length, ...t.rows.slice(0, 200).map((r) => r.length));
  const byHeader: Array<Field | null> = Array.from({ length: width }, (_, i) => headerField(t.headers[i]));
  const sample = t.rows.slice(0, 300);
  const share = (col: number, f: (v: unknown) => boolean) => {
    const vals = sample.map((r) => r[col]).filter((v) => v !== "" && v !== null && v !== undefined);
    return vals.length ? vals.filter(f).length / vals.length : 0;
  };
  const filled = (col: number) => sample.filter((r) => r[col] !== "" && r[col] !== null && r[col] !== undefined).length;

  const m: ColumnMap = { phones: [], company: null, person: null, email: null, country: null, city: null, industry: null, labels: {} };
  const label = (i: number) => t.headers[i] || `عمود ${i + 1}`;
  const pick = (f: "company" | "person" | "email" | "country" | "city" | "industry") => {
    const i = byHeader.findIndex((x, j) => x === f && share(j, (v) => /https?:\/\/|www\./i.test(String(v ?? ""))) < 0.3);
    if (i >= 0) { m[f] = i; m.labels[f] = label(i); }
  };
  (["company", "person", "email", "country", "city", "industry"] as const).forEach(pick);

  // Numbers: every column whose header says so, and every column whose
  // values are mostly numbers whatever it is called — but never the fax.
  const looksPhone = (v: unknown) => phonesInCell(v).length > 0;
  const phoneCols: Array<{ i: number; p: number }> = [];
  const linky = (v: unknown) => /https?:\/\/|www\.|\.(com|net|org|ae)\b/i.test(String(v ?? ""));
  for (let i = 0; i < width; i++) {
    const f = byHeader[i];
    if (f === "fax" || f === "skip" || i === m.email) continue;
    if (share(i, linky) >= 0.3) continue;
    if (f && f in PHONE_PRIORITY) phoneCols.push({ i, p: PHONE_PRIORITY[f]! });
    else if (!f && filled(i) > 0 && share(i, looksPhone) >= 0.5) phoneCols.push({ i, p: 2.5 });
  }
  // Within the same priority, the column with more mobiles first.
  const mobileShare = (i: number) => share(i, (v) => phonesInCell(v).some((p) => p.mobile));
  phoneCols.sort((a, b) => a.p - b.p || mobileShare(b.i) - mobileShare(a.i));
  m.phones = phoneCols.map((c) => c.i);
  if (m.phones.length) m.labels["phones"] = m.phones.map(label).join("، ");

  // The email by its values when the header did not say.
  if (m.email === null) {
    let best = -1, bestShare = 0;
    for (let i = 0; i < width; i++) { const s = share(i, (v) => EMAIL_RE.test(String(v ?? ""))); if (s > bestShare) { best = i; bestShare = s; } }
    if (best >= 0 && bestShare >= 0.3) { m.email = best; m.labels["email"] = label(best); }
  }

  // No company header: the text column with the most distinct, name-like
  // values that is none of the above. A list of companies with no headers is
  // mostly this shape.
  const taken = new Set([...m.phones, m.email, m.person, m.country, m.city, m.industry].filter((x) => x !== null));
  if (m.company === null) {
    let best = -1, bestScore = 0;
    for (let i = 0; i < width; i++) {
      if (taken.has(i) || byHeader[i] === "skip" || share(i, linky) >= 0.3) continue;
      const vals = sample.map((r) => String(r[i] ?? "").trim()).filter(Boolean);
      const texty = vals.filter((v) => /\p{L}{2,}/u.test(v) && !/^\d/.test(v) && !EMAIL_RE.test(v) && v.length <= 120);
      const distinct = new Set(texty).size;
      const score = distinct * (texty.length / Math.max(1, vals.length));
      if (score > bestScore) { best = i; bestScore = score; }
    }
    // A column called "name" when there is no company column is usually the
    // company in a business list; keep person for a separate person column.
    if (best >= 0 && bestScore >= Math.min(2, sample.length * 0.5)) { m.company = best; m.labels["company"] = `${label(best)} (من القيم)`; }
    else if (m.person !== null) { m.company = m.person; m.labels["company"] = `${label(m.person)} (الاسم)`; }
  }
  return m;
}

// ── Rows ──────────────────────────────────────────────────────────

export interface ParsedRow {
  company: string | null;
  person: string | null;
  /** The first address, kept for every caller that wants just one. */
  email: string | null;
  /**
   * Every address on the row.
   *
   * One was not enough. Directory exports carry "Email" and "Email 2", and put
   * two in one cell separated by a comma — and reading only the first meant a
   * company with three addresses contributed one. On a five-row sample
   * carrying eight addresses this reader produced three.
   */
  emails: string[];
  city: string | null;
  industry: string | null;
  country: CountryIso;
  /** Every number found, best WhatsApp candidate first. */
  phones: Phone[];
  /** The number to use for WhatsApp: the first mobile, or the first unknown-mobility international one. */
  whatsapp: Phone | null;
}

export interface ParseReport {
  rows: ParsedRow[];
  total: number;
  sheets: Array<{ sheet: string; rows: number; columns: Record<string, string> }>;
  withWhatsapp: number;
  landlineOnly: number;
  noNumber: number;
  byCountry: Record<string, number>;
}

const clean = (v: unknown, max = 200) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s && s !== "-" && s !== "—" && s.toLowerCase() !== "n/a" ? s.slice(0, max) : null;
};

export function parseTables(tables: SheetTable[], defaultCountry: CountryIso = "AE"): ParseReport {
  const rows: ParsedRow[] = [];
  const sheets: ParseReport["sheets"] = [];
  let total = 0, withWa = 0, landOnly = 0, none = 0;
  const byCountry: Record<string, number> = {};

  for (const t of tables) {
    const m = mapColumns(t);
    let n = 0;
    for (const r of t.rows) {
      if (!r || r.every((c) => c === "" || c === null || c === undefined)) continue;
      n++; total++;
      const city = m.city !== null ? clean(r[m.city]) : null;
      const countryCell = m.country !== null ? clean(r[m.country]) : null;
      const country = countryOf(countryCell, city) ?? defaultCountry;

      const phones: Phone[] = [];
      const seen = new Set<string>();
      for (const col of m.phones) for (const p of phonesInCell(r[col], country)) {
        if (!seen.has(p.e164)) { seen.add(p.e164); phones.push(p); }
      }
      const whatsapp = phones.find((p) => p.mobile === true) ?? phones.find((p) => p.mobile === null) ?? null;
      if (whatsapp) { withWa++; byCountry[whatsapp.iso ?? "?"] = (byCountry[whatsapp.iso ?? "?"] ?? 0) + 1; }
      else if (phones.length) landOnly++;
      else none++;

      // Scan the detected column first so its address stays first, then every
      // other column that is not a phone — an address can be anywhere, and
      // header names like "Email 2" are not worth enumerating.
      const emails: string[] = [];
      const scanCell = (v: unknown) => {
        for (const hit of String(v ?? "").replace(/mailto:/gi, " ").match(EMAIL_SCAN) ?? []) {
          const e = hit.toLowerCase();
          if (!emails.includes(e)) emails.push(e);
        }
      };
      if (m.email !== null) scanCell(r[m.email]);
      for (let c = 0; c < r.length; c++) {
        if (c === m.email || m.phones.includes(c)) continue;
        scanCell(r[c]);
      }
      const email = emails[0] ?? null;

      rows.push({
        emails,
        company: m.company !== null ? clean(r[m.company]) : null,
        person: m.person !== null && m.person !== m.company ? clean(r[m.person]) : null,
        email, city,
        industry: m.industry !== null ? clean(r[m.industry], 120) : null,
        country, phones, whatsapp,
      });
    }
    sheets.push({ sheet: t.sheet, rows: n, columns: m.labels });
  }
  return { rows, total, sheets, withWhatsapp: withWa, landlineOnly: landOnly, noNumber: none, byCountry };
}

/** The name a WhatsApp contact is saved under: the company, else the person. */
export function contactName(r: Pick<ParsedRow, "company" | "person">): string | null {
  return (r.company ?? r.person)?.slice(0, 255) ?? null;
}

/**
 * One entry per WhatsApp number, de-duplicated across the whole file. With
 * `allMobiles`, a row's second and third mobiles become entries too — a
 * company often lists the owner's and the manager's.
 */
export function whatsappEntries(rows: ParsedRow[], opts: { mobileOnly?: boolean; allMobiles?: boolean } = {}) {
  const mobileOnly = opts.mobileOnly !== false;
  const seen = new Set<string>();
  const out: Array<{ phone: string; name: string | null }> = [];
  let duplicates = 0, skippedLandline = 0;
  for (const r of rows) {
    const candidates = opts.allMobiles
      ? r.phones.filter((p) => p.mobile !== false || !mobileOnly)
      : [r.whatsapp ?? (!mobileOnly ? r.phones[0] ?? null : null)].filter(Boolean) as Phone[];
    if (!candidates.length && r.phones.length) skippedLandline++;
    for (const p of candidates) {
      if (seen.has(p.e164)) { duplicates++; continue; }
      seen.add(p.e164);
      out.push({ phone: p.e164, name: contactName(r) });
    }
  }
  return { entries: out, duplicates, skippedLandline };
}
