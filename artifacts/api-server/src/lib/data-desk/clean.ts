// ── المنظِّف: ما يصلح للمراسلة، وما أُصلح، وما رُدّ ولماذا ─────────
// المستورد ينظّف أصلاً — يوحّد الأرقام، ويُسقط المكرّر والباطل. لكنه
// يفعل ذلك بصمت: صاحب العمل يرفع ألف صفٍّ فيدخل سبعمئة، ولا يعرف ما
// الذي رُدّ ولا لماذا، ولا ما الذي أُصلح في الطريق.
//
// فالمنظّف هنا لا يحذف شيئاً: يحكم على كل صفٍّ بواحدٍ من ثلاثة — سليم،
// أُصلح (وما الذي أُصلح)، مردود (وسببه) — ويعدّ كل سببٍ وحده. والمردود
// يبقى في التقرير بمثاله، فملفٌ رُدّ ربعه لخطأٍ في عمودٍ واحد يُرى من
// أول نظرة.
//
// ودوالّه صِرفة: تُختبر بلا قاعدة، وتعمل على أي منصة.

import { normalizePhone } from "../phone-import";
import { normalizeEmail, isRoleAddress } from "../email/importer";

export type Verdict = "ok" | "fixed" | "rejected";

export interface CleanRow<T> { row: T; verdict: Verdict; fixes: string[]; reason: string | null; flags: string[] }

// أخطاء الكتابة الشائعة في النطاقات: حرفٌ منقلب يحوّل عنواناً سليماً إلى ارتداد.
const DOMAIN_TYPOS: Record<string, string> = {
  "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gmail.co": "gmail.com", "gmail.con": "gmail.com", "gamil.com": "gmail.com", "gnail.com": "gmail.com", "gmaill.com": "gmail.com",
  "hotmial.com": "hotmail.com", "hotmai.com": "hotmail.com", "hotmail.con": "hotmail.com", "hotmil.com": "hotmail.com", "hotnail.com": "hotmail.com",
  "yaho.com": "yahoo.com", "yahooo.com": "yahoo.com", "yahoo.con": "yahoo.com", "yhoo.com": "yahoo.com",
  "outlok.com": "outlook.com", "outlook.con": "outlook.com", "outloook.com": "outlook.com",
  "icloud.con": "icloud.com", "iclod.com": "icloud.com",
};
const TLD_TYPOS: Array<[RegExp, string]> = [[/\.con$/, ".com"], [/\.cmo$/, ".com"], [/\.comm$/, ".com"], [/\.co,$/, ".com"], [/\.ea$/, ".ae"], [/\.aee$/, ".ae"]];

const DISPOSABLE = /@(mailinator|guerrillamail|10minutemail|tempmail|temp-mail|yopmail|trashmail|throwaway|sharklasers|getnada|maildrop|dispostable|fakeinbox)\./i;
const PLACEHOLDER = /^(test|testing|example|sample|demo|none|null|na|n\/a|xxx+|abc|asdf|email|name|user|no-?reply|noreply|donotreply|do-not-reply)@|@(example|test|domain|email|company|yourcompany|yourdomain|sample)\.(com|net|org|ae)$/i;
const FREE = /@(gmail|hotmail|outlook|yahoo|live|aol|icloud|protonmail|yandex|msn|ymail)\./i;

/** عنوان بريدٍ واحد. يُصلح ما يُصلَح يقيناً، ويردّ ما لا يُراسَل. */
export function cleanEmail(raw: unknown): { email: string | null; verdict: Verdict; fixes: string[]; reason: string | null; flags: string[] } {
  const original = String(raw ?? "").trim();
  if (!original) return { email: null, verdict: "rejected", fixes: [], reason: "خانة فارغة", flags: [] };
  const fixes: string[] = [];
  let s = original.toLowerCase().replace(/^mailto:/, "").replace(/[<>()\[\]"'\s;,]+/g, "").replace(/\.+$/, "").replace(/\.{2,}/g, ".");
  if (s !== original.toLowerCase()) fixes.push("أُزيلت زوائد حول العنوان");
  const at = s.lastIndexOf("@");
  if (at < 1) return { email: null, verdict: "rejected", fixes: [], reason: "ليس عنوان بريد", flags: [] };
  let domain = s.slice(at + 1);
  if (DOMAIN_TYPOS[domain]) { fixes.push(`صُحّح النطاق ${domain} ← ${DOMAIN_TYPOS[domain]}`); domain = DOMAIN_TYPOS[domain]!; }
  else for (const [re, to] of TLD_TYPOS) if (re.test(domain)) { const d2 = domain.replace(re, to); fixes.push(`صُحّحت النهاية ${domain} ← ${d2}`); domain = d2; break; }
  s = `${s.slice(0, at)}@${domain}`;
  const email = normalizeEmail(s);
  if (!email) return { email: null, verdict: "rejected", fixes: [], reason: "صيغة العنوان باطلة", flags: [] };
  if (PLACEHOLDER.test(email)) return { email: null, verdict: "rejected", fixes: [], reason: "عنوانٌ وهمي أو لا يستقبل (test@، noreply@…)", flags: [] };
  if (DISPOSABLE.test(email)) return { email: null, verdict: "rejected", fixes: [], reason: "بريدٌ مؤقت يُتلف نفسه", flags: [] };
  const flags = [isRoleAddress(email) ? "role" : "", FREE.test(email) ? "free" : ""].filter(Boolean);
  return { email, verdict: fixes.length ? "fixed" : "ok", fixes, reason: null, flags };
}

/** رقمٌ للواتساب. الأرضي لا يُراسَل على واتساب — يُردّ بسببه لا بصمت. */
export function cleanPhone(raw: unknown, country = "AE"): { phone: string | null; verdict: Verdict; fixes: string[]; reason: string | null; flags: string[] } {
  const original = String(raw ?? "").trim();
  if (!original) return { phone: null, verdict: "rejected", fixes: [], reason: "خانة فارغة", flags: [] };
  const p = normalizePhone(original, country);
  if (!p) return { phone: null, verdict: "rejected", fixes: [], reason: "ليس رقم هاتف صالحاً", flags: [] };
  if (p.mobile === false) return { phone: null, verdict: "rejected", fixes: [], reason: "رقمٌ أرضي — لا واتساب عليه", flags: [] };
  const digits = original.replace(/\D/g, "");
  const fixes = digits === p.e164 ? [] : ["وُحّدت صيغته الدولية"];
  const flags = [p.mobile === null ? "unverified_mobile" : "", p.iso && p.iso !== country ? "foreign" : ""].filter(Boolean);
  return { phone: p.e164, verdict: fixes.length ? "fixed" : "ok", fixes, reason: null, flags };
}

const JUNK_NAME = /^(n\/?a|none|null|unknown|test|xxx+|---+|\.+|\d+|غير معروف|لا يوجد|بدون|-)$/i;
/** اسمٌ يصلح أن يُكتب في رسالة. الفارغ والوهمي يصير null — والقالب يحمل بديله. */
export function cleanName(raw: unknown): string | null {
  const s = String(raw ?? "").replace(/\s+/g, " ").replace(/^[\s"'«»,.;:_-]+|[\s"'«»,;:_-]+$/g, "").trim();
  if (!s || JUNK_NAME.test(s) || s.length < 2) return null;
  return s.slice(0, 200);
}

export interface Clearance {
  total: number;
  ok: number;
  fixed: number;
  rejected: number;
  duplicates: number;
  /** كل سببٍ وعدده ومثالٌ منه — ملفٌ رُدّ ربعه لسببٍ واحد يُرى من أول نظرة. */
  reasons: Array<{ reason: string; n: number; example: string }>;
  fixes: Array<{ fix: string; n: number }>;
  flags: Record<string, number>;
}

/**
 * ملفٌ كامل: كل صفٍّ يُحكم عليه، والمكرّر داخل الملف يُعدّ وحده.
 * `key` هو ما يُعرف به التكرار — العنوان أو الرقم بعد توحيده.
 */
export function clearBatch<T>(rows: T[], check: (r: T) => { key: string | null; verdict: Verdict; fixes: string[]; reason: string | null; flags: string[]; shown: string }): { kept: Array<{ row: T; key: string; flags: string[] }>; report: Clearance } {
  const seen = new Set<string>();
  const reasons = new Map<string, { n: number; example: string }>();
  const fixes = new Map<string, number>();
  const flags: Record<string, number> = {};
  const kept: Array<{ row: T; key: string; flags: string[] }> = [];
  let ok = 0, fixed = 0, rejected = 0, duplicates = 0;
  for (const row of rows) {
    const c = check(row);
    if (c.verdict === "rejected" || !c.key) {
      rejected++;
      const r = c.reason ?? "مردود";
      const e = reasons.get(r) ?? { n: 0, example: c.shown.slice(0, 60) };
      e.n++; reasons.set(r, e);
      continue;
    }
    if (seen.has(c.key)) { duplicates++; continue; }
    seen.add(c.key);
    if (c.verdict === "fixed") { fixed++; for (const f of c.fixes) { const k = f.replace(/ .+ ← .+$/, "").replace(/\s+\S+\s+←.*$/, ""); fixes.set(k, (fixes.get(k) ?? 0) + 1); } } else ok++;
    for (const f of c.flags) flags[f] = (flags[f] ?? 0) + 1;
    kept.push({ row, key: c.key, flags: c.flags });
  }
  return {
    kept,
    report: {
      total: rows.length, ok, fixed, rejected, duplicates,
      reasons: [...reasons.entries()].map(([reason, e]) => ({ reason, ...e })).sort((a, b) => b.n - a.n),
      fixes: [...fixes.entries()].map(([fix, n]) => ({ fix, n })).sort((a, b) => b.n - a.n),
      flags,
    },
  };
}

export const FLAG_AR: Record<string, string> = {
  role: "عناوين أقسام (info@، sales@) — يقرؤها موظف لا صاحب قرار",
  free: "عناوين مجانية (gmail…) — عملٌ صغير أو عنوانٌ شخصي",
  unverified_mobile: "أرقام دولٍ لا نعرف قاعدة جوّالها — تُجرَّب بحذر",
  foreign: "أرقام من خارج بلد القائمة",
};
