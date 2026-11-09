// ── Voice notes ───────────────────────────────────────────────────
// In the Gulf a voice note is not a fallback for typing — for many people it
// is the default, and a customer who records thirty seconds and gets no reply
// concludes the number is dead. Before this, an audio message reached
// extractText(), produced undefined, and was dropped silently: the most
// engaged kind of inbound message was the one kind the bot could not see.
//
// Transcription runs on Groq's Whisper, which is on the same free key the
// replies already use. WhatsApp sends voice notes as OGG/Opus, which Whisper
// accepts directly, so nothing has to be transcoded and the server needs no
// ffmpeg.

import { logger } from "./logger";
import { modelHalted } from "./org/controls";

const GROQ_TRANSCRIBE = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Turbo is ~4× faster and nearly as accurate; the large model is the fallback. */
const MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"];

/**
 * Vocabulary hint.
 *
 * Whisper accepts a prompt that biases its decoding, and this is where domain
 * words go: without it "فري زون" and "إقرار ضريبي" come back as something
 * phonetically close and semantically useless. It cannot fix genuinely unclear
 * audio, only tilt the decoder towards words that belong in this conversation.
 */
const VOCAB = [
  "محادثة واتساب بالعربية الخليجية عن المحاسبة والضريبة في الإمارات.",
  "مفردات متوقعة: ضريبة القيمة المضافة، ضريبة الشركات، مين لاند، فري زون،",
  "رخصة تجارية، إقرار ضريبي، غرامة، تدقيق، مقاولات، فواتير، رواتب،",
  "كم السعر، أبغى، الحين، وش، ليش، دبي، أبوظبي، الشارقة.",
].join(" ");

/** WhatsApp caps voice notes well below this; the limit guards against abuse. */
const MAX_BYTES = 20 * 1024 * 1024;

export type Transcript = { text: string; model: string; ms: number } | null;

export async function transcribe(
  audio: Buffer, mimetype = "audio/ogg", timeoutMs = 45_000, userId?: number,
): Promise<Transcript> {
  // Not through complete(), so the kill switch is asked here.
  if (await modelHalted(userId)) return null;
  const key = process.env["GROQ_API_KEY"];
  if (!key) {
    logger.warn("لا يوجد مفتاح Groq — لا يمكن تفريغ الرسائل الصوتية");
    return null;
  }
  if (audio.length === 0 || audio.length > MAX_BYTES) {
    logger.warn({ bytes: audio.length }, "حجم التسجيل غير صالح");
    return null;
  }

  // The extension matters to the API even though the bytes are what is read.
  const ext = mimetype.includes("mp4") || mimetype.includes("m4a") ? "m4a"
            : mimetype.includes("mpeg") || mimetype.includes("mp3") ? "mp3"
            : mimetype.includes("wav") ? "wav"
            : "ogg";

  for (const model of MODELS) {
    const t0 = Date.now();
    try {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(audio)], { type: mimetype }), `note.${ext}`);
      form.append("model", model);
      form.append("language", "ar");
      form.append("prompt", VOCAB);
      form.append("response_format", "json");

      const res = await fetch(GROQ_TRANSCRIBE, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 140)}`);

      const d = await res.json() as { text?: string };
      const text = (d.text ?? "").trim();
      // Whisper hallucinates a stock phrase on silence — "شكراً على المشاهدة"
      // and similar, learnt from video captions. A voice note that transcribes
      // to one of those is silence, and answering it would be answering
      // nothing.
      if (!text || isHallucinated(text)) {
        logger.info({ model, text }, "تسجيل فارغ أو بلا كلام مفهوم");
        return null;
      }
      return { text, model, ms: Date.now() - t0 };
    } catch (err: any) {
      logger.warn({ model, err: String(err?.message ?? err).slice(0, 160) }, "فشل تفريغ التسجيل");
    }
  }
  return null;
}

/** Whisper's known filler outputs for silence or noise. */
const HALLUCINATIONS = [
  /^شكرا?ً?\s*(جزيلا|لك|على المشاهدة|للمشاهدة)?\.?$/,
  /^اشترك في القناة/,
  /^ترجمة/,
  /^\.+$/,
  /^thank you( for watching)?\.?$/i,
  /^you\.?$/i,
];
function isHallucinated(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return true;
  return HALLUCINATIONS.some((re) => re.test(t));
}

/**
 * How a transcript is handed to the rest of the system.
 *
 * Marked rather than passed off as typed text, for two reasons that both
 * matter downstream: the employee should answer what was *said* rather than
 * quoting a transcript back, and a transcription error should be visible as
 * one when the owner reads the thread, instead of looking like a customer who
 * wrote nonsense.
 */
export function asMessage(t: NonNullable<Transcript>): string {
  return t.text;
}

/** For the prompt, so the employee knows it is listening rather than reading. */
export const VOICE_NOTE_HINT =
  "هذه الرسالة وصلت كتسجيل صوتي وتم تفريغها نصاً، وقد يكون في التفريغ خطأ. " +
  "رُدّ على ما قصده لا على حرفية الكلمات، ولا تذكر أنك «قرأت» رسالته ولا أنها كانت تسجيلاً " +
  "إلا إذا كان التفريغ غير مفهوم فعلاً — عندها اطلب منه يعيدها كتابةً بلطف.";
