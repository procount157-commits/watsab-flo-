// ── حدود غرفة التحكّم، وما يُنظَّف قبل الحفظ ───────────────────────
// كل ما هنا Pure: الحدود ثوابت، والعدّاد في الذاكرة لكل عملية. لا شيء يتصل بشبكة.

/** نداءات النموذج القصوى في مكالمة واحدة (الردود + الملخص). */
export const MAX_CALL_MODEL_CALLS = 40;
/** في اجتماع واحد. يُحجز آخرها للقرارات. */
export const MAX_MEETING_MODEL_CALLS = 30;
/** أطول مقطع صوتي للدور الواحد. */
export const MAX_TURN_AUDIO_MS = 60_000;
/** حجم المقطع: ٦٠ ثانية opus/webm أقل من ١ ميغا عادةً؛ ٤ ميغا هامش لـ mp4/wav القصير. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_ATTENDEES = 6;
export const MAX_TICKETS_PER_SESSION = 8;
/** مكالمة متصلة بلا دور منذ هذا الوقت تُنهى عند أول نظر. */
export const STALE_CALL_MS = 30 * 60_000;

export const AUDIO_MIME = ["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/m4a", "audio/x-m4a", "audio/aac"] as const;
/** "audio/webm;codecs=opus" → "audio/webm". ما ليس في القائمة: null. */
export function audioMime(m: string | null | undefined): string | null {
  const base = String(m ?? "").toLowerCase().split(";")[0]!.trim();
  return (AUDIO_MIME as readonly string[]).includes(base) ? base : null;
}

// ── معدّل الطلبات لكل مستخدم ───────────────────────────────────────
export const RATE = {
  callStart: { max: 10, windowMs: 10 * 60_000 },
  turn: { max: 20, windowMs: 60_000 },
  tts: { max: 40, windowMs: 60_000 },
  meetingStart: { max: 6, windowMs: 10 * 60_000 },
} as const;
const hits = new Map<string, number[]>();
/** يسجّل محاولة ويقول هل تُقبل، وكم ثانية للتالية إن لم تُقبل. */
export function rateHit(kind: keyof typeof RATE, userId: number, now = Date.now()): { ok: boolean; retryAfterSec: number } {
  const { max, windowMs } = RATE[kind];
  const k = `${kind}:${userId}`;
  const xs = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
  if (xs.length >= max) { hits.set(k, xs); return { ok: false, retryAfterSec: Math.ceil((windowMs - (now - xs[0]!)) / 1000) }; }
  xs.push(now); hits.set(k, xs);
  return { ok: true, retryAfterSec: 0 };
}
export const forgetRates = () => hits.clear();

// ── الأسرار والبيانات الشخصية ─────────────────────────────────────
// ما يُحفظ نصاً يمرّ من هنا: مفاتيح وكلمات مرور وبطاقات لا تدخل محضراً، والأرقام الطويلة
// (هاتف، حساب بنكي) تُقنَّع بآخر أربعة. البريد يُقنَّع اسمه ويبقى نطاقه.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|gsk|pk|rk|xox[abp]|ghp|gho|github_pat|AKIA|AIza)[-_A-Za-z0-9]{12,}\b/g, "[سرّ محذوف]"],
  [/\bBearer\s+[A-Za-z0-9._\-]{12,}/gi, "[سرّ محذوف]"],
  [/((?:password|passwd|pwd|كلمة\s*(?:ال)?(?:سر|مرور)|الباسوورد|الرقم\s*السري)\s*[:=：]?\s*)\S+/gi, "$1[محذوف]"],
  [/((?:api[\s_-]?key|token|secret|مفتاح)\s*[:=：]\s*)\S+/gi, "$1[محذوف]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[سرّ محذوف]"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}/g, "[سرّ محذوف]"],
];
export function redact(text: string): string {
  let t = String(text ?? "");
  for (const [re, by] of SECRET_PATTERNS) t = t.replace(re, by);
  // أرقام البطاقات والهواتف والحسابات: ٩ أرقام فأكثر متتالية (مع مسافات أو شرطات).
  t = t.replace(/(?:\+?[\d٠-٩][\s-]?){9,}/g, (m) => {
    const digits = m.replace(/[^\d٠-٩]/g, "");
    return digits.length >= 9 ? `[رقم ••${digits.slice(-4)}]` : m;
  });
  t = t.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, "$1•••@$2");
  return t;
}

// ── «موافق» بالكلام ───────────────────────────────────────────────
// قد يقولها المالك، وقد يقولها صوتٌ في الخلفية، وقد يخطئ التفريغ. لا تعني شيئاً هنا:
// الموافقة على تذكرة من صفحة الموافقات وحدها، بجلسة صاحب الحساب.
const APPROVAL_WORDS = /(^|[\s،,.!؟?])(موافق|موافقة|وافقت|أوافق|اوافق|اعتمد|اعتمدت|معتمد|نفّذ|نفذ|توكل|تمام\s+نفذ|approved?|go ahead|ship it|do it|i approve)([\s،,.!؟?]|$)/i;
export const isSpokenApproval = (text: string) => APPROVAL_WORDS.test(String(text ?? ""));
export const SPOKEN_APPROVAL_NOTE =
  "قلتَ ما يشبه «موافق» بالكلام — هذه ليست موافقة ولا يتغيّر بها شيء. الموافقة على أي تذكرة تكون من صفحة الموافقات فقط.";

// ── ما يُقرأ من ردّ النموذج ───────────────────────────────────────
/** أول كائن JSON في النص (قد يلفّه النموذج بشرح أو ```json). null إن لا كائن صالح. */
export function extractObject(text: string): Record<string, any> | null {
  const s = String(text ?? "").replace(/```(?:json)?/gi, "");
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { const v = JSON.parse(s.slice(start, i + 1)); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
    }
  }
  return null;
}

/** معرّفات الدليل المذكورة بين أقواس في النص: [task:12] [scorecard:weekly:2026-W46]. */
export function citedIds(text: string): string[] {
  return [...new Set([...String(text ?? "").matchAll(/\[([a-z_]+:[^\]\s]{1,80})\]/g)].map((m) => m[1]!))];
}

export interface Proposal { title: string; expectedOutcome: string; dueInDays: number; metric: string | null; employeeKey?: string | null }
/** المقترحات كما يكتبها النموذج، منظّفة ومحدودة. ما ينقصه عنوان أو نتيجة متوقعة يسقط. */
export function cleanProposals(v: unknown, max = 5): Proposal[] {
  if (!Array.isArray(v)) return [];
  const out: Proposal[] = [];
  for (const p of v) {
    if (!p || typeof p !== "object") continue;
    const title = redact(String((p as any).title ?? "").trim()).slice(0, 200);
    const expectedOutcome = redact(String((p as any).expected_outcome ?? (p as any).expectedOutcome ?? "").trim()).slice(0, 400);
    if (title.length < 3 || expectedOutcome.length < 3) continue;
    const d = Math.round(Number((p as any).due_in_days ?? (p as any).dueInDays ?? 7));
    const metric = (p as any).metric ? redact(String((p as any).metric)).slice(0, 200) : null;
    const employeeKey = (p as any).employee_key ?? (p as any).employeeKey ?? null;
    out.push({ title, expectedOutcome, dueInDays: Number.isFinite(d) ? Math.min(90, Math.max(1, d)) : 7, metric, employeeKey: employeeKey ? String(employeeKey).slice(0, 60) : null });
    if (out.length >= max) break;
  }
  return out;
}

/** لغة المكالمة كما يرسلها المتصفح. */
export const langOf = (v: unknown): "ar" | "en" | "auto" => (v === "en" ? "en" : v === "ar" ? "ar" : "auto");
