// ── Seeing a photo a customer sent ───────────────────────────────
// A gold customer sends a photo before a sentence: a piece she saw
// elsewhere, a screenshot of ours, a bracelet she wants matched, a receipt.
// Until now the photo produced an empty row and the employee answered
// nothing — the most intent-laden message was the one dropped.
//
// The photo is described in Arabic by a vision model (Groq's Llama 4 Scout,
// on the same key as the transcriber), and the description is folded into
// the message text, marked as a photo, so every downstream part — the
// reading, the reply, the receipt — handles it like words. What the model
// may not do is name a price or a karat as fact: it describes what it sees,
// and the pricing is the catalogue's.

import { logger } from "./logger";

const GROQ_CHAT = "https://api.groq.com/openai/v1/chat/completions";
const MODELS = ["meta-llama/llama-4-scout-17b-16e-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct"];
const MAX_BYTES = 4 * 1024 * 1024;

const PROMPT = `أنت تصف صورة أرسلها عميل لمحل ذهب ومجوهرات على واتساب. صف بالعربية في ٢–٤ أسطر:
١) نوع القطعة (طقم، سلسلة، خاتم، أسورة، حلق، تعليقة…) وشكلها ونقشها ولونها (أصفر/أبيض/وردي) وأي أحجار.
٢) هل الصورة من موقعنا/كتالوجنا، أم من محل آخر، أم قطعة بحوزة العميل، أم لقطة شاشة، أم فاتورة/إيصال، أم ليست مجوهرات أصلاً.
٣) إن ظهر نص أو رقم أو وزن أو سعر في الصورة فانقله حرفياً.
لا تخمّن العيار ولا الوزن ولا السعر إن لم يكونا مكتوبين. لا مقدمات.`;

export type Seen = { text: string; model: string; ms: number } | null;

export async function describeImage(image: Buffer, mimetype = "image/jpeg", caption = "", timeoutMs = 40_000): Promise<Seen> {
  const key = process.env["GROQ_API_KEY"];
  if (!key) { logger.warn("لا يوجد مفتاح Groq — لا يمكن قراءة الصور"); return null; }
  if (!image.length || image.length > MAX_BYTES) { logger.warn({ bytes: image.length }, "حجم الصورة غير صالح"); return null; }
  const dataUrl = `data:${mimetype};base64,${image.toString("base64")}`;
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const res = await fetch(GROQ_CHAT, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model, temperature: 0.2, max_tokens: 400,
          messages: [{ role: "user", content: [
            { type: "text", text: caption ? `${PROMPT}\n\nكتب العميل مع الصورة: «${caption}»` : PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ] }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);
      const d = await res.json() as any;
      const text = (d?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) throw new Error("وصف فارغ");
      return { text, model, ms: Date.now() - t0 };
    } catch (err: any) {
      logger.warn({ model, err: String(err?.message ?? err).slice(0, 160) }, "فشلت قراءة الصورة");
    }
  }
  return null;
}

/** The photo as a line of the message, so the reading and the reply treat it as what was said. Pure. */
export const photoAsText = (description: string, caption = "") => `${caption ? caption + "\n" : ""}[صورة أرسلها العميل: ${description}]`;
