// ── من الصوت إلى النص: Groq Whisper الموجود ─────────────────────────
// العربية تمرّ على transcribe() في lib/voice.ts كما هي (مفرداتها وفلتر الهلوسة).
// الإنجليزية والتلقائي يحتاجان لغةً أخرى أو بلا لغة، وتلك الدالة تثبّت "ar"، فهنا نداءٌ
// بالنمط نفسه: مفتاح الإيقاف أولاً، ثم النموذجان بالترتيب. لا مفتاح = null، لا نصّ مخترع.

import { logger } from "../../logger";
import { modelHalted } from "../controls";
import { transcribe } from "../../voice";
import { languageOf } from "../../tts";

export interface SttResult { text: string; model: string; ms: number; lang: "ar" | "en" }
export type SttFn = (audio: Buffer, mime: string, lang: "ar" | "en" | "auto", userId: number) => Promise<SttResult | null>;

const URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];
const SILENCE = [/^thank you( for watching)?\.?$/i, /^you\.?$/i, /^\.+$/, /^شكرا?ً?\s*(جزيلا|لك|على المشاهدة|للمشاهدة)?\.?$/, /^اشترك في القناة/, /^ترجمة/];

export const sttConfigured = () => !!process.env["GROQ_API_KEY"];

export const groqStt: SttFn = async (audio, mime, lang, userId) => {
  if (lang === "ar") {
    const t = await transcribe(audio, mime, 45_000, userId);
    return t ? { text: t.text, model: t.model, ms: t.ms, lang: "ar" } : null;
  }
  if (await modelHalted(userId)) return null;
  const key = process.env["GROQ_API_KEY"];
  if (!key) return null;
  const ext = mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac") ? "m4a" : mime.includes("mpeg") || mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : mime.includes("ogg") ? "ogg" : "webm";
  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), `turn.${ext}`);
      form.append("model", model);
      if (lang === "en") form.append("language", "en");
      form.append("response_format", "json");
      const res = await fetch(URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);
      const text = String(((await res.json()) as { text?: string }).text ?? "").trim();
      if (text.length < 3 || SILENCE.some((re) => re.test(text))) return null;
      return { text, model, ms: Date.now() - t0, lang: lang === "en" ? "en" : languageOf(text) };
    } catch (err: any) {
      logger.warn({ model, err: String(err?.message ?? err).slice(0, 160) }, "تفريغ دور المكالمة فشل");
    }
  }
  return null;
};
