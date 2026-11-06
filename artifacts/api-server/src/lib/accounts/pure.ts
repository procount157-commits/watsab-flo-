// ── مكتب الحسابات المستهدفة: ما يُحسب بلا قاعدة ولا شبكة ─────────────
// كل ما هنا Pure، ومختبرٌ في __tests__/accounts-desk.test.ts:
// اختيار الشركات، وقراءة الإشارة من الصفحة، ونمط البريد ومرشّحوه،
// وقاعدة «لا اسم إلا ما رأيناه مكتوباً»، وحدّ ملاحظة لينكدإن.

// ── اختيار الشركات ────────────────────────────────────────────────
export interface CandidateRow {
  domain: string;
  company: string | null;
  city: string | null;
  sector: string | null;
  addresses: number;
  /** فتح أو نقر رسالة سابقة منا. */
  engaged: boolean;
  lastOpenedAt?: Date | string | null;
}

const DUBAI = /dubai|دبي/i;

/** Who first: engaged (opened/clicked us before), then Dubai, then the bigger company (more addresses held). Pure. */
export function rankCandidates<T extends CandidateRow>(rows: T[], emirates: string[] = []): T[] {
  const wanted = emirates.map((e) => e.toLowerCase().trim()).filter(Boolean);
  const inEmirates = (c: T) => !wanted.length || wanted.some((e) => (c.city ?? "").toLowerCase().includes(e) || (e === "dubai" && DUBAI.test(c.city ?? "")) || (e === "دبي" && DUBAI.test(c.city ?? "")));
  return rows.filter(inEmirates).sort((a, b) =>
    Number(b.engaged) - Number(a.engaged)
    || Number(DUBAI.test(b.city ?? "")) - Number(DUBAI.test(a.city ?? ""))
    || b.addresses - a.addresses
    || a.domain.localeCompare(b.domain));
}

/** A company's display name: the legal suffix off, the case tidied. Pure. */
export function shortCompany(name: string | null | undefined, domain: string): string {
  const raw = String(name ?? "").replace(/\s+/g, " ").trim();
  const cut = raw.replace(/\b(l\.?\s?l\.?\s?c\.?|llc|fze|fzco|fz[- ]?llc|dmcc|est\.?|establishment|co\.?|company|limited|ltd\.?|\(.*?\))\s*$/gi, "").replace(/[\s,.\-–]+$/, "").trim();
  if (cut.length >= 2) return cut.length > 4 && cut === cut.toUpperCase() ? cut.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : cut;
  const base = domain.split(".")[0] ?? domain;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// ── الصفحات التي تُقرأ ────────────────────────────────────────────
const PEOPLE_PAGE = /about|who-we-are|our-story|team|our-team|people|management|leadership|board|founder|contact|careers|jobs|join|news|media|press|projects|من-نحن|فريق|تواصل/i;
/** Up to `max` same-site pages about the people, the company and its news; shorter paths first. Pure. */
export function pickPages(links: string[], max = 6): string[] {
  const score = (u: string) => {
    let p = "";
    try { p = decodeURIComponent(new URL(u).pathname); } catch { return -99; }
    const depth = p.split("/").filter(Boolean).length;
    if (!depth) return -99;
    let s = -depth;
    if (/team|management|leadership|board|founder|people|فريق/i.test(p)) s += 6;
    else if (/about|who-we-are|our-story|من-نحن/i.test(p)) s += 5;
    else if (/contact|تواصل/i.test(p)) s += 4;
    else if (/careers|jobs|join/i.test(p)) s += 3;
    else if (/news|media|press|projects/i.test(p)) s += 2;
    return s;
  };
  const seen = new Set<string>();
  return links.filter((u) => PEOPLE_PAGE.test(u)).map((u) => u.replace(/\/+$/, ""))
    .filter((u) => !seen.has(u) && (seen.add(u), true))
    .sort((a, b) => score(b) - score(a)).filter((u) => score(u) > -99).slice(0, max);
}

/** The page's readable text — header and footer kept (that is where the emails and the licence numbers live). Pure. */
export function visibleText(html: string, max = 12_000): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article|tr|td|span)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;|&rsquo;/g, "'").replace(/&#64;|&commat;/g, "@")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, max);
}

// ── الإشارة: لماذا الآن ───────────────────────────────────────────
export interface Signal { kind: "launch" | "hiring" | "branch" | "licence" | "news" | "engaged"; label: string; text: string; source: string }

const SIGNALS: Array<{ kind: Signal["kind"]; label: string; re: RegExp }> = [
  { kind: "launch", label: "مشروع جديد", re: /\b(new (project|launch|development|tower|community|phase)|now (selling|launching|open for sale)|launch(ed|es|ing)?\b|off[- ]plan|handover in|coming soon|phase \d|grand opening)/i },
  { kind: "hiring", label: "توظيف", re: /\b(we('| a)re hiring|join our team|current (openings|vacancies)|vacanc(y|ies)|now hiring|career opportunities|open positions|job openings)\b/i },
  { kind: "branch", label: "فرع أو مكتب جديد", re: /\b(new (office|branch|showroom|headquarters)|opened (a|our) (new )?(office|branch)|expan(d|ded|sion) (to|into)|now in (abu dhabi|dubai|sharjah|ras al khaimah|ajman))/i },
  { kind: "licence", label: "ترخيص عقاري", re: /\b(ORN|RERA|BRN|Trakheesi|DLD|Dubai Land Department|ADREC|license (no|number)|licence (no|number))\b/i },
];

/** The sentence around a match, trimmed to ~200 chars. Pure. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", index), ...[". ", "! ", "? "].map((p) => text.lastIndexOf(p, index) + 1));
  const ends = ["\n", ". ", "! ", "? "].map((p) => text.indexOf(p, index)).filter((i) => i >= 0);
  const end = ends.length ? Math.min(...ends) + 1 : text.length;
  const s = text.slice(start, end).replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 197).trim()}…` : s;
}

/**
 * The strongest «why now» on these pages, in order: a launch, hiring, a new
 * branch, a licence mention. Each is the sentence it was found in, with its
 * page, so the writer quotes something real. Pure.
 */
export function extractSignal(pages: Array<{ url: string; text: string }>): Signal | null {
  for (const s of SIGNALS) {
    for (const p of pages) {
      const m = s.re.exec(p.text);
      if (!m) continue;
      const text = sentenceAround(p.text, m.index);
      if (text.split(/\s+/).length < 3 || isMenuText(text)) continue;
      return { kind: s.kind, label: s.label, text, source: p.url };
    }
  }
  return null;
}

/**
 * A site's menu read as a sentence: «Best Real Estate Company in Dubai – Buy
 * or Invest in Property Skip to…» was famproperties.com's first «signal».
 * A real sentence has small words between its nouns; a menu is a row of
 * capitalised labels. Pure.
 */
export function isMenuText(text: string): boolean {
  const words = text.replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (words.length < 5) return false;
  const caps = words.filter((w) => /^[A-Z]/.test(w)).length / words.length;
  const glue = words.filter((w) => /^(the|is|are|was|were|our|we|has|have|with|to|and|of|a|an|for|will|its|this|that|now|from|by)$/i.test(w)).length;
  return /\bskip to\b|\bmenu\b|\blog ?in\b|\bsign up\b/i.test(text) || (caps > 0.6 && glue < 2);
}

/** «Hind, Pro Count» at the end of a LinkedIn note: the owner sends it from his own profile, so it carries no signature. Pure. */
export function stripNoteSignature(text: string): string {
  const t = text.trim();
  // The last sentence, if it is only a name and the firm («Hind, Pro Count.», «— Mohamed from Pro Count»), goes.
  const m = /^([\s\S]*?[.!?])\s*[—–-]?\s*((?:best|regards|thanks|cheers)[,!]?\s*)?[\p{L} .'-]{0,40}?,?\s*(?:from\s+)?pro ?count\.?$/iu.exec(t);
  return m && m[1]!.trim().length > 20 ? m[1]!.trim() : t;
}

/** How a signal reads in the account card. Pure. */
export const signalLine = (s: Signal) => `${s.label}: ${s.text}`;

// ── «لا اسم إلا ما رأيناه» ────────────────────────────────────────
const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();

/** A person's name, as a model may give it: 2–5 words, letters only, not a job title or a company. Pure. */
export function looksLikeName(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  const words = n.split(" ");
  if (words.length < 2 || words.length > 5 || n.length > 60) return false;
  if (/\d|@|https?:|www\./i.test(n)) return false;
  if (/\b(llc|properties|real estate|group|company|team|department|manager|director|officer|ceo|cfo|mlro|founder|contact|office|sales|info)\b/i.test(n)) return false;
  return words.every((w) => /^[\p{L}][\p{L}'.\-]*$/u.test(w));
}

/** The name appears, word for word, in what we fetched. Pure. */
export function nameInSource(name: string, source: string): boolean {
  const n = norm(name).replace(/^(mr|mrs|ms|dr|eng|sheikh|h\.e)\.?\s+/i, "");
  if (n.length < 4) return false;
  const hay = norm(source);
  const at = hay.indexOf(n);
  if (at < 0) return false;
  // Whole words only: «Ali Khan» must not match inside «Mali Khanna».
  const before = hay[at - 1], after = hay[at + n.length];
  const letter = (c?: string) => !!c && /[\p{L}]/u.test(c);
  return !letter(before) && !letter(after);
}

export interface FoundPerson { name: string; title: string | null; why: string | null; linkedinUrl: string | null; source: string | null; isDecisionMaker: boolean }

const LINKEDIN_IN = /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%.]+\/?$/i;

/**
 * What the analyst returned, kept only where the source holds it: a name not
 * found verbatim is dropped, a LinkedIn link not seen literally is blanked,
 * and exactly one decision maker remains (the first marked, else the first). Pure.
 */
export function groundPeople(raw: unknown, source: string, max = 3): FoundPerson[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: FoundPerson[] = [];
  const seen = new Set<string>();
  for (const r of list as any[]) {
    const name = String(r?.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || !looksLikeName(name) || !nameInSource(name, source)) continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const li = String(r?.linkedinUrl ?? r?.linkedin ?? "").trim().split("?")[0]!;
    out.push({
      name,
      title: String(r?.title ?? "").trim().slice(0, 200) || null,
      why: String(r?.why ?? "").trim().slice(0, 300) || null,
      linkedinUrl: li && LINKEDIN_IN.test(li) && source.toLowerCase().includes(li.replace(/\/$/, "").toLowerCase()) ? li : null,
      source: /^https?:\/\//.test(String(r?.source ?? "")) ? String(r.source).slice(0, 500) : null,
      isDecisionMaker: r?.isDecisionMaker === true,
    });
    if (out.length >= max) break;
  }
  const dm = out.findIndex((p) => p.isDecisionMaker);
  out.forEach((p, i) => { p.isDecisionMaker = i === (dm >= 0 ? dm : 0); });
  return out;
}

// ── البريد: النمط والمرشّحون ──────────────────────────────────────
export const ROLE_LOCAL = /^(info|sales|contact|hello|admin|office|enquir(y|ies)|inquir(y|ies)|support|marketing|hr|careers|jobs|accounts|finance|leasing|reception|mail|team|general|customercare|customerservice|cs|booking|bookings|noreply|no-reply|webmaster|media|press|legal|compliance)\d*$/i;

export const PATTERNS = ["{first}", "{first}.{last}", "{f}{last}", "{f}.{last}", "{first}{last}", "{first}_{last}", "{first}{l}", "{last}"] as const;
export type Pattern = typeof PATTERNS[number];

/** A name split for an address: ASCII letters only, honorifics off. Null for a name that has no Latin form. Pure. */
export function nameParts(name: string): { first: string; last: string } | null {
  const tokens = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/^(mr|mrs|ms|dr|eng|sheikh)\.?\s+/i, "").split(/[\s\-]+/)
    .map((w) => w.replace(/[^a-z]/g, "")).filter(Boolean);
  const first = tokens[0];
  if (!first || first.length < 2) return null;
  const rest = tokens.slice(1);
  let last = rest.at(-1) ?? "";
  // «Ahmed Al Mansoori» → «almansoori», how Gulf addresses are usually spelled; the bare form is tried by emailCandidates.
  if (last && /^(al|el)$/.test(rest.at(-2) ?? "")) last = `${rest.at(-2)}${last}`;
  if (/^(al|el|bin|ibn|abu)$/.test(last)) last = "";
  return { first, last };
}

/** One pattern rendered for a name. Pure. */
export function renderPattern(pattern: Pattern, name: string, domain: string): string | null {
  const p = nameParts(name);
  if (!p) return null;
  if (/\{l|\{last/.test(pattern) && !p.last) return null;
  const local = pattern.replace("{first}", p.first).replace("{last}", p.last).replace("{f}", p.first[0]!).replace("{l}", p.last[0] ?? "");
  return `${local}@${domain.toLowerCase()}`;
}

/**
 * The pattern one address follows. With names we know at that company the
 * match is exact; without, the shape decides (h.khan → {f}.{last},
 * catalin → {first}). Role mailboxes have no pattern. Pure.
 */
export function patternOf(email: string, knownNames: string[] = []): Pattern | null {
  const [local, domain] = email.toLowerCase().split("@");
  if (!local || !domain || ROLE_LOCAL.test(local)) return null;
  for (const n of knownNames) for (const p of PATTERNS) if (renderPattern(p, n, domain) === `${local}@${domain}`) return p;
  if (/^[a-z]\.[a-z]{2,}$/.test(local)) return "{f}.{last}";
  if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return "{first}.{last}";
  if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return "{first}_{last}";
  if (/^[a-z]{2,}\.[a-z]$/.test(local)) return null;
  if (/^[a-z]{3,12}$/.test(local)) return "{first}";
  return null;
}

/** The company's pattern: the one most of its personal addresses follow. Pure. */
export function domainPattern(emails: string[], knownNames: string[] = []): Pattern | null {
  const count = new Map<Pattern, number>();
  for (const e of new Set(emails.map((x) => x.toLowerCase()))) {
    const p = patternOf(e, knownNames);
    if (p) count.set(p, (count.get(p) ?? 0) + 1);
  }
  let best: Pattern | null = null, n = 0;
  for (const [p, c] of count) if (c > n || (c === n && best && PATTERNS.indexOf(p) < PATTERNS.indexOf(best))) { best = p; n = c; }
  return best;
}

/** Addresses on a page: mailto links and plain text, images and placeholders out. Pure. */
/**
 * Cloudflare's «email protection» hides every address on the page behind a
 * hex string (first byte the key, the rest XOR'd with it) — valtisproperties.com
 * publishes its team's addresses only this way. Pure.
 */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]{4,}$/i.test(hex) || hex.length % 2) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out) ? out : null;
}

export function extractEmails(html: string): string[] {
  const cf = [...html.matchAll(/(?:email-protection#|data-cfemail=["'])([0-9a-f]{6,})/gi)].map((m) => decodeCfEmail(m[1]!)).filter((e): e is string => !!e);
  html = `${html}\n${cf.join("\n")}`;
  const src = html.replace(/&#64;|&commat;|\s?\[at\]\s?|\s?\(at\)\s?/gi, "@").replace(/%40/g, "@");
  const found = src.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(found.map((e) => e.toLowerCase().replace(/^mailto:/, "").replace(/\.+$/, "")))]
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e) && !/(example|domain|email|yourname|sentry|wixpress)\./.test(e));
}

/** A published address that is this person's own: its local part names them. Pure. */
export function personalMatch(emails: string[], name: string, domain: string): string | null {
  const p = nameParts(name);
  if (!p) return null;
  const lastWords = name.toLowerCase().split(/\s+/).slice(1).map((w) => w.replace(/[^a-z]/g, "")).filter((w) => w.length >= 3 && !/^(al|el|bin|ibn|abu)$/.test(w));
  for (const e of emails) {
    const [local, d] = e.toLowerCase().split("@");
    if (!local || d !== domain.toLowerCase() || ROLE_LOCAL.test(local)) continue;
    const bits = local.split(/[._\-]/);
    if (bits.includes(p.first) || local.startsWith(p.first) && local.length <= p.first.length + 1) return e;
    if (lastWords.some((w) => bits.includes(w) || local.includes(w)) && local[0] === p.first[0]) return e;
  }
  return null;
}

/**
 * Who to try, in order: a published personal address, the company's own
 * pattern, then the common ones — at most `max`, no repeats. Pure.
 */
export function emailCandidates(name: string, domain: string, o: { published?: string[]; pattern?: Pattern | null; max?: number } = {}): string[] {
  const out: string[] = [];
  const add = (e: string | null) => { if (e && !out.includes(e)) out.push(e); };
  add(personalMatch(o.published ?? [], name, domain));
  if (o.pattern) add(renderPattern(o.pattern, name, domain));
  for (const p of ["{first}", "{first}.{last}", "{f}{last}", "{f}.{last}"] as Pattern[]) add(renderPattern(p, name, domain));
  // «Al Mansoori» spelled without the article — common in the Gulf.
  const bare = name.replace(/\b(al|el)[\s\-]+/gi, "");
  if (bare !== name) { add(renderPattern("{first}.{last}", bare, domain)); add(renderPattern("{f}{last}", bare, domain)); }
  return out.slice(0, o.max ?? 5);
}

/** The company's own role address, the one the fallback goes to. info@ first. Pure. */
export function roleAddress(emails: string[], domain: string): string | null {
  const mine = emails.map((e) => e.toLowerCase()).filter((e) => e.endsWith(`@${domain.toLowerCase()}`) && ROLE_LOCAL.test(e.split("@")[0]!));
  const order = ["info", "contact", "hello", "enquiries", "enquiry", "inquiries", "office", "sales", "admin"];
  for (const l of order) { const hit = mine.find((e) => e.split("@")[0] === l); if (hit) return hit; }
  return mine.find((e) => !/noreply|no-reply|careers|jobs|hr\b/.test(e)) ?? null;
}

// ── لينكدإن والكتابة ──────────────────────────────────────────────
export const LINKEDIN_NOTE_MAX = 280;
/** A connection note within LinkedIn's 280 characters, cut at a word. Pure. */
export function clampNote(text: string, max = LINKEDIN_NOTE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:\-–]+$/, "").trim()}…`;
}

export const linkedinSearchUrl = (name: string, company: string) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${company}`)}`;

export const wordCount = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const MEETING = /\b(call|meeting|meet|schedule|calendar|calendly|zoom|teams|15[- ]minutes?|30[- ]minutes?|book a|slot|demo)\b/i;
const CLICHE = /(hope this (email|message) finds you|just checking in|touching base|circling back|synergy|leverage|cutting[- ]edge|game[- ]changer|revolutioni[sz]e)/i;

export interface Written { subject: string; body: string; followups: Array<{ afterDays: number; subject: string; body: string }>; linkedin: string }

/** What is wrong with a personal email set, in the owner's words; empty means it may go. Pure. */
export function writingIssues(w: Written, company: string): string[] {
  const issues: string[] = [];
  const sw = wordCount(w.subject);
  if (sw < 2 || sw > 5) issues.push(`العنوان ${sw} كلمة — المطلوب ٢ إلى ٥`);
  const n = wordCount(w.body);
  if (n < 45 || n > 100) issues.push(`الرسالة الأولى ${n} كلمة — المطلوب ٥٠ إلى ٩٠`);
  if (MEETING.test(w.body)) issues.push(`الرسالة الأولى تطلب موعداً أو مكالمة («${MEETING.exec(w.body)![0]}») — المطلوب سؤالٌ واحد فقط`);
  if (!/\?/.test(w.body)) issues.push("لا سؤال في الرسالة الأولى — الدعوة سؤالٌ واحد");
  const opening = w.body.split(/\s+/).slice(0, 40).join(" ").toLowerCase();
  const brand = company.toLowerCase().split(/\s+/)[0] ?? "";
  if (brand.length >= 3 && !opening.includes(brand)) issues.push("أول الرسالة لا يذكر شركته — يبدأ بالإشارة أو بحقيقةٍ عنها");
  if (CLICHE.test(`${w.subject} ${w.body}`)) issues.push(`عبارة قالب: «${CLICHE.exec(`${w.subject} ${w.body}`)![0]}»`);
  const [f2, f3] = w.followups;
  if (!f2 || !f2.body) issues.push("المتابعة الثانية ناقصة");
  else if (wordCount(f2.body) > 65) issues.push(`المتابعة الثانية ${wordCount(f2.body)} كلمة — الحد ٦٠`);
  if (!f3 || !f3.body) issues.push("المتابعة الثالثة ناقصة");
  else if (wordCount(f3.body) > 45) issues.push(`المتابعة الثالثة ${wordCount(f3.body)} كلمة — الحد ٤٠`);
  if (!w.linkedin) issues.push("ملاحظة لينكدإن ناقصة");
  else if (w.linkedin.length > LINKEDIN_NOTE_MAX) issues.push(`ملاحظة لينكدإن ${w.linkedin.length} حرفاً — الحد ٢٨٠`);
  return issues;
}

/** The writer's JSON, read loosely into the shape the desk sends. Pure. */
export function readWritten(raw: any): Written | null {
  if (!raw || typeof raw !== "object") return null;
  const s = (v: unknown) => String(v ?? "").replace(/\r/g, "").trim();
  const subject = s(raw.subject).replace(/^subject:\s*/i, "");
  const body = s(raw.body ?? raw.email);
  if (!subject || !body) return null;
  const fu = (x: any, afterDays: number) => ({ afterDays, subject: s(x?.subject) || `Re: ${subject}`, body: s(x?.body ?? x) });
  return {
    subject, body,
    followups: [fu(raw.followup2 ?? raw.followups?.[0], 3), fu(raw.followup3 ?? raw.followups?.[1], 7)],
    linkedin: s(raw.linkedin ?? raw.linkedinNote),
  };
}

/** Today in Dubai, YYYY-MM-DD, and whether it is a working day there (Mon–Fri). Pure. */
export function dubaiNow(now = new Date()) {
  const g = new Date(now.getTime() + 4 * 3_600_000);
  return { date: g.toISOString().slice(0, 10), hour: g.getUTCHours(), minute: g.getUTCMinutes(), weekday: g.getUTCDay() >= 1 && g.getUTCDay() <= 5 };
}
