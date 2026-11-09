// ── Reply intent ──────────────────────────────────────────────────
// Classifies what a customer's reply means, so a follow-up sequence can react
// to it instead of continuing blindly.
//
// This is deliberately rule-based rather than a model call. The free endpoint
// already wired into routes/ai.ts (Pollinations) allows one request per IP at a
// time and answers "Queue full" under any real load — measured, not assumed —
// and takes ~5s when it does answer. Classifying every inbound message through
// that would be slow, unreliable, and would send customers' messages to a third
// party. Rules run in microseconds, work offline, and keep the messages here.
//
// The vocabulary is small on purpose: replies to marketing messages are short
// and repetitive. An optional model call can refine the genuinely ambiguous
// cases — see classifyWithAI — but nothing depends on it being available.

export type Intent =
  | "opt_out"        // asked to stop
  | "complaint"      // something went wrong — a person should see this
  | "not_interested"
  | "interested"     // a buying signal
  | "question"
  | "greeting"
  | "unclear";

export interface IntentResult {
  intent:     Intent;
  confidence: number;        // 0..1
  matched:    string[];      // which cues fired, for auditing a wrong call
  source:     "rules" | "ai";
}

/**
 * Normalise Arabic so matching is not defeated by spelling variation.
 *
 * Unifies alef/hamza forms, ta marbuta, alef maqsura, strips diacritics and
 * tatweel, and folds Arabic-Indic digits — all of which appear freely in
 * customer messages.
 */
export function normalizeArabic(input: string): string {
  return input
    .replace(/[ً-ْـ]/g, "")                 // diacritics + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/[ىئ]/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^\p{L}\p{N}\s؟?]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Ordered by precedence: the first group with a hit wins. Opt-out and
// complaint outrank everything because both need to stop the sequence
// regardless of whatever else the message says.
const RULES: Array<{ intent: Intent; weight: number; cues: string[] }> = [
  {
    intent: "opt_out", weight: 1,
    cues: [
      "الغاء الاشتراك", "الغاء", "ايقاف", "توقف", "لا تراسلني", "لا تراسلوني",
      "شيلني", "احذفني", "ما ابي رسائل", "ما ابغى رسائل", "بلوك", "حظر",
      "stop", "unsubscribe", "remove me",
    ],
  },
  {
    intent: "complaint", weight: 0.9,
    cues: [
      "شكوى", "متاخر", "تاخر", "تالف", "مكسور", "خربان", "سيء", "سيئه", "زعلان",
      "مشكله", "ما وصل", "لم يصل", "غلط", "خطا", "خدعه", "نصب", "ارجاع", "استرجاع",
      "مو راضي", "غير راضي", "اشتكي",
    ],
  },
  {
    intent: "not_interested", weight: 0.85,
    cues: [
      "مو مهتم", "غير مهتم", "مش مهتم", "ما اهتم", "لا شكرا", "لا شكرن",
      "ما ابغى", "ما ابي", "مش عايز", "ما احتاج", "مو محتاج", "لا احتاج",
      "not interested", "no thanks",
    ],
  },
  {
    intent: "interested", weight: 0.8,
    cues: [
      "ابغى اطلب", "ابي اطلب", "اريد اطلب", "عايز اطلب", "ابغى اشتري", "ابي اشتري",
      "اريد الطلب", "كيف اطلب", "كيف الطلب", "كيف اشتري", "وش الخطوات",
      "ابغى", "ابي", "اريد", "عايز", "موافق", "تمام ارسل", "ارسل لي", "ابعث لي",
      "احجز", "احجزلي", "متى التوصيل", "كيف الدفع", "وين الفرع", "المكان",
      "interested", "i want", "how to order",
    ],
  },
  {
    intent: "question", weight: 0.6,
    cues: [
      "كم", "بكم", "هل", "وش", "ايش", "متى", "وين", "اين", "كيف", "ليش", "لماذا",
      "ممكن اعرف", "استفسار", "?", "؟",
      "how much", "what", "when", "where",
    ],
  },
  {
    intent: "greeting", weight: 0.4,
    cues: [
      "السلام عليكم", "سلام", "مرحبا", "مرحبتين", "هلا", "اهلا", "صباح الخير",
      "مساء الخير", "هاي", "hi", "hello", "شكرا", "تسلم", "الله يعطيك العافيه",
    ],
  },
];

/**
 * Does a cue appear in the message?
 *
 * Single-word cues must match a whole word. Substring matching alone turns
 * "السلام عليكم" into a question, because "عليكم" ends in "كم" — and the same
 * trap catches "بكم", "كمية" and "حكم". Multi-word phrases are specific enough
 * that a substring test is safe, and survives filler between the words.
 */
function cueMatches(norm: string, words: Set<string>, cue: string): boolean {
  const c = normalizeArabic(cue);
  if (!c) return false;
  if (c.includes(" ")) return norm.includes(c);
  if (words.has(c)) return true;
  // Arabic glues particles onto the front of words, so "وكم" is still "كم".
  // Listed explicitly rather than allowing any short prefix: a length rule
  // would also accept "علي" + "كم" and put us back where we started.
  // Two-letter cues take conjunctions only. Prepositions would let "لكم" in
  // "شكرا لكم" read as ل+كم, and "بكم" is already a cue in its own right, so
  // nothing is lost by excluding them.
  const allowed = c.length <= 2 ? AR_CONJUNCTIONS : AR_PREFIXES;
  for (const pre of allowed) {
    if (words.has(pre + c)) return true;
  }
  return false;
}

/** Particles that attach to the front of a word without changing it. */
const AR_CONJUNCTIONS = ["و", "ف"];
const AR_PREFIXES = [...AR_CONJUNCTIONS, "ب", "ل", "ك", "ال", "وال", "بال", "فال", "كال", "لل", "ولل", "وب", "ول"];

/**
 * Classify a reply using rules alone.
 *
 * Confidence reflects how much the message is the matched cue: a bare "ايقاف"
 * is unambiguous, while the same word inside a long sentence is weaker
 * evidence and gets flagged for optional refinement.
 */
export function classifyIntent(text: string): IntentResult {
  const norm = normalizeArabic(text ?? "");
  if (!norm) return { intent: "unclear", confidence: 0, matched: [], source: "rules" };

  const words = new Set(norm.split(" "));

  for (const rule of RULES) {
    const matched = rule.cues.filter((c) => cueMatches(norm, words, c));
    if (matched.length === 0) continue;

    // Longest cue wins as the evidence measure — "مو مهتم" is stronger than "ما".
    const longest  = matched.reduce((a, b) => (b.length > a.length ? b : a));
    const coverage = Math.min(1, longest.length / Math.max(norm.length, 1));

    let confidence = rule.weight * (0.55 + 0.45 * coverage);
    if (matched.length > 1) confidence = Math.min(1, confidence + 0.08);
    // A short message that is essentially the cue is as clear as it gets.
    if (norm.length <= longest.length + 3) confidence = Math.min(1, confidence + 0.15);

    return { intent: rule.intent, confidence: Number(confidence.toFixed(2)), matched, source: "rules" };
  }

  return { intent: "unclear", confidence: 0.2, matched: [], source: "rules" };
}

/** Below this, a reply is worth a second opinion if one is available. */
export const AI_REFINE_BELOW = 0.55;

const AI_LABELS: Record<string, Intent> = {
  "مهتم": "interested", "غير_مهتم": "not_interested", "سؤال": "question",
  "شكوى": "complaint", "ايقاف": "opt_out", "تحية": "greeting", "غير_واضح": "unclear",
};

/**
 * Optional second opinion from the free endpoint.
 *
 * Never on the critical path: a rules verdict is always produced first and is
 * returned unchanged if this is slow, rate-limited or nonsense. The caller
 * decides whether to even try — see FOLLOW_UP_AI_REFINE.
 */
export async function classifyWithAI(text: string, timeoutMs = 8_000, userId?: number): Promise<IntentResult | null> {
  // Pollinations directly, not complete(): the kill switch is asked here. A null is the rules' verdict standing.
  // Imported late: the rules in this file are pure and used without a database.
  const { modelHalted } = await import("./org/controls");
  if (await modelHalted(userId)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("https://text.pollinations.ai/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openai",
        messages: [
          { role: "system", content: "صنّف نية رسالة العميل. أجب بكلمة واحدة فقط، بلا شرح، من: مهتم | غير_مهتم | سؤال | شكوى | ايقاف | تحية | غير_واضح" },
          { role: "user", content: String(text).slice(0, 500) },
        ],
        seed: -1, private: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json() as { choices?: { message?: { content?: string } }[]; error?: string };
    if (data.error) return null;   // "Queue full for IP" comes back as a 200
    const raw = data?.choices?.[0]?.message?.content?.trim() ?? "";
    const key = Object.keys(AI_LABELS).find((k) => raw.includes(k));
    if (!key) return null;
    return { intent: AI_LABELS[key]!, confidence: 0.7, matched: [raw.slice(0, 40)], source: "ai" };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Rules first; a model call only for the genuinely unclear, and only if enabled. */
export async function classify(text: string, useAI = false): Promise<IntentResult> {
  const rules = classifyIntent(text);
  if (!useAI || rules.confidence >= AI_REFINE_BELOW) return rules;
  return (await classifyWithAI(text)) ?? rules;
}

export const INTENT_LABELS_AR: Record<Intent, string> = {
  opt_out: "طلب إيقاف", complaint: "شكوى", not_interested: "غير مهتم",
  interested: "مهتم", question: "سؤال", greeting: "تحية", unclear: "غير واضح",
};
