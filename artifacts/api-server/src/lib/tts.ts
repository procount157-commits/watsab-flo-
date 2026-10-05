// ── Speaking ──────────────────────────────────────────────────────
// The other half of voice: a customer who sends voice notes expects one back,
// and in the Gulf that is most customers. Text is turned into an OGG/Opus
// voice note — the format WhatsApp plays as a voice bubble, with no
// transcoding and no ffmpeg — through the Microsoft Edge "Read Aloud" voices,
// which are free and include natural Emirati Arabic.
//
// What is said is not quite what was written: links, emoji, markdown and
// bracketed asides are stripped, because a voice that reads "https colon
// slash slash" is worse than silence. Anything with a price, a number list or
// a link is better left as text, and sayable() says so.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import ffmpegStatic from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { logger } from "./logger";

// Edge's own OGG stream closes early (a known fault of the service); its WebM
// stream is sound. The Opus packets are the same, so ffmpeg re-wraps them
// into Ogg without re-encoding — the container WhatsApp plays as a voice
// bubble. Without ffmpeg, MP3 goes instead, which plays as an audio file.
let ffmpegPath: string | null | undefined;
function ffmpeg(): string | null {
  if (ffmpegPath !== undefined) return ffmpegPath;
  ffmpegPath = process.env["FFMPEG_PATH"] || (typeof ffmpegStatic === "string" ? ffmpegStatic : null);
  if (ffmpegPath && !existsSync(ffmpegPath)) ffmpegPath = null;
  return ffmpegPath;
}

export const VOICES = {
  ar: { male: "ar-AE-HamdanNeural", female: "ar-AE-FatimaNeural" },
  en: { male: "en-GB-RyanNeural", female: "en-GB-SoniaNeural" },
} as const;
export type Lang = keyof typeof VOICES;
export type Gender = "male" | "female";

const MAX_CHARS = 1_200;

/** Whether a reply reads well aloud: no links, no tables of numbers, not too long. */
export function sayable(text: string): { ok: boolean; why?: string } {
  if (/https?:\/\/|www\./i.test(text)) return { ok: false, why: "فيه رابط" };
  if ((text.match(/[\d٠-٩]/g) ?? []).length > 12) return { ok: false, why: "فيه أرقام كثيرة" };
  if (/\n\s*[-•\d٠-٩][.)]?\s/.test(text) && (text.match(/\n/g) ?? []).length > 3) return { ok: false, why: "قائمة طويلة" };
  if (text.length > MAX_CHARS) return { ok: false, why: "طويل" };
  return { ok: true };
}

/** The text as a person would read it out. */
export function speakable(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/[*_~`#>]+/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_CHARS);
}

export const languageOf = (text: string): Lang => ((text.match(/[؀-ۿ]/g)?.length ?? 0) >= (text.match(/[A-Za-z]/g)?.length ?? 0) * 0.5 ? "ar" : "en");

export type VoiceNote = { audio: Buffer; mimetype: "audio/ogg; codecs=opus" | "audio/mpeg"; ptt: boolean; voice: string; seconds: number };

async function synth(voice: string, text: string, format: OUTPUT_FORMAT, timeoutMs: number): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, format);
  const { audioStream } = tts.toStream(text);
  const chunks: Buffer[] = [];
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("TTS timeout")), timeoutMs);
      audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      audioStream.on("end", () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      audioStream.on("error", (e: Error) => { clearTimeout(timer); reject(e); });
    });
  } finally { tts.close(); }
}

/** How long an Ogg/Opus file plays: the last page's granule position, in 48 kHz samples. */
export function oggSeconds(ogg: Buffer): number {
  const at = ogg.lastIndexOf("OggS");
  if (at < 0 || at + 14 > ogg.length) return Math.max(1, Math.round(ogg.length / 6_000));
  const granule = Number(ogg.readBigUInt64LE(at + 6));
  return Math.max(1, Math.round(granule / 48_000));
}

/** WebM/Opus → Ogg/Opus, packets copied, no re-encoding. */
function webmToOgg(webm: Buffer, bin: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-loglevel", "error", "-i", "pipe:0", "-c:a", "copy", "-f", "ogg", "pipe:1"]);
    const out: Buffer[] = [], err: Buffer[] = [];
    p.stdout.on("data", (c) => out.push(c)); p.stderr.on("data", (c) => err.push(c));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${Buffer.concat(err).toString().slice(0, 160)}`))));
    p.stdin.end(webm);
  });
}

export async function speak(text: string, opts: { lang?: Lang; gender?: Gender; timeoutMs?: number } = {}): Promise<VoiceNote | null> {
  const say = speakable(text);
  if (say.length < 2) return null;
  const lang = opts.lang ?? languageOf(say);
  const voice = VOICES[lang][opts.gender ?? "male"];
  const t0 = Date.now(), timeout = opts.timeoutMs ?? 30_000;
  try {
    const bin = ffmpeg();
    if (bin) {
      const webm = await synth(voice, say, OUTPUT_FORMAT.WEBM_24KHZ_16BIT_MONO_OPUS, timeout);
      const audio = await webmToOgg(webm, bin);
      if (audio.length < 200 || audio.subarray(0, 4).toString("ascii") !== "OggS") throw new Error("not Ogg after remux");
      const seconds = oggSeconds(audio);
      logger.info({ voice, chars: say.length, bytes: audio.length, seconds, ms: Date.now() - t0 }, "voice note made");
      return { audio, mimetype: "audio/ogg; codecs=opus", ptt: true, voice, seconds };
    }
    const mp3 = await synth(voice, say, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, timeout);
    if (mp3.length < 200) throw new Error("empty mp3");
    logger.info({ voice, chars: say.length, bytes: mp3.length, ms: Date.now() - t0 }, "voice made as mp3 — no ffmpeg, goes as an audio file");
    return { audio: mp3, mimetype: "audio/mpeg", ptt: false, voice, seconds: Math.max(1, Math.round(mp3.length / 6_000)) };
  } catch (err: any) {
    logger.warn({ voice, err: String(err?.message ?? err).slice(0, 160) }, "voice note failed — text will go instead");
    return null;
  }
}

/** The same voice as MP3 — for a browser to play, where Ogg is not certain (Safari). */
export async function speakMp3(text: string, opts: { lang?: Lang; gender?: Gender } = {}): Promise<{ audio: Buffer; voice: string } | null> {
  const say = speakable(text);
  if (say.length < 2) return null;
  const voice = VOICES[opts.lang ?? languageOf(say)][opts.gender ?? "male"];
  try {
    const audio = await synth(voice, say, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, 30_000);
    return audio.length > 200 ? { audio, voice } : null;
  } catch (err: any) {
    logger.warn({ voice, err: String(err?.message ?? err).slice(0, 160) }, "browser voice failed");
    return null;
  }
}
