// ── طلبات غرفة التحكّم، والتسجيل، والتشغيل ─────────────────────────
// التسجيل: اضغط مطوّلاً وتكلم (push-to-talk)، أو اضغط مرة فيتوقف وحده بعد صمتٍ قصير
// (كشف صوت بسيط بمستوى الطاقة)، وفي كل حال لا يتجاوز ٦٠ ثانية — حدّ الخادم نفسه.

import { useCallback, useEffect, useRef, useState } from "react";
import { orgApi, OrgError } from "../shared";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const MAX_TURN_MS = 60_000;

export const voice = <T = any,>(path: string, init?: { method?: string; body?: unknown }) => orgApi<T>(`/voice${path}`, init);

/** دورٌ صوتي: multipart بحقل audio. */
export async function voiceUpload<T = any>(path: string, blob: Blob, fields: Record<string, string>): Promise<T> {
  const fd = new FormData();
  fd.append("audio", blob, blob.type.includes("mp4") ? "turn.m4a" : blob.type.includes("ogg") ? "turn.ogg" : "turn.webm");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(`${BASE}/api/org/voice${path}`, { method: "POST", body: fd, credentials: "include" });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new OrgError(d?.error ?? "فشل الطلب", r.status);
  return d as T;
}

// ── التشغيل: صوتٌ واحد في كل مرة، ويُقاطَع ─────────────────────────
let current: HTMLAudioElement | null = null;
const cache = new Map<string, string>();
export function stopPlayback() { if (current) { current.pause(); current = null; } }
export async function playLine(path: string, onState?: (playing: boolean) => void): Promise<void> {
  stopPlayback();
  let url = cache.get(path);
  if (!url) {
    const r = await fetch(`${BASE}/api/org/voice${path}`, { credentials: "include" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "تعذّر الصوت");
    url = URL.createObjectURL(await r.blob());
    cache.set(path, url);
  }
  const a = new Audio(url);
  current = a;
  onState?.(true);
  a.onended = a.onerror = a.onpause = () => onState?.(false);
  await a.play().catch(() => onState?.(false));
}

// ── التسجيل ───────────────────────────────────────────────────────
export type RecState = "idle" | "denied" | "recording" | "unsupported";
export function useRecorder(onDone: (blob: Blob, ms: number) => void) {
  const [state, setState] = useState<RecState>(() => (typeof window !== "undefined" && "MediaRecorder" in window && navigator.mediaDevices ? "idle" : "unsupported"));
  const [level, setLevel] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const t0 = useRef(0);
  const stopTimer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  // ضغطةٌ قصيرة تُترك قبل أن يُفتح الميكروفون: يُوقَف فور بدئه، لا يبقى يسجّل.
  const pending = useRef(false), wantStop = useRef(false);
  const stop = useCallback(() => {
    if (rec.current?.state === "recording") rec.current.stop();
    else if (pending.current) wantStop.current = true;
  }, []);

  const start = useCallback(async (o: { vad?: boolean } = {}) => {
    if (rec.current?.state === "recording" || pending.current) return;
    stopPlayback();
    pending.current = true; wantStop.current = false;
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { pending.current = false; setState("denied"); return; }
    pending.current = false;
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: BlobPart[] = [];
    let ctx: AudioContext | null = null;
    r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    r.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      if (stopTimer.current) window.clearTimeout(stopTimer.current);
      if (raf.current) cancelAnimationFrame(raf.current);
      void ctx?.close().catch(() => {});
      setLevel(0); setState("idle");
      const ms = Date.now() - t0.current;
      const blob = new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] });
      if (blob.size > 1_500 && ms > 400) done.current(blob, Math.min(ms, MAX_TURN_MS));
    };
    rec.current = r;
    t0.current = Date.now();
    r.start(250);
    setState("recording");
    if (wantStop.current) { r.stop(); return; }
    stopTimer.current = window.setTimeout(() => stop(), MAX_TURN_MS - 300);
    // كشف صوت بسيط: مستوى الطاقة؛ بعد كلامٍ ثم ١٫٤ ثانية صمت يتوقف وحده.
    try {
      ctx = new AudioContext();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      let spoke = false, quietSince = 0;
      const tick = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
        const rms = Math.sqrt(sum / buf.length);
        setLevel(Math.min(1, rms * 6));
        const now = Date.now();
        if (rms > 0.04) { spoke = true; quietSince = 0; } else if (spoke && !quietSince) quietSince = now;
        if (o.vad && spoke && quietSince && now - quietSince > 1_400) { stop(); return; }
        raf.current = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* بلا مستوى: يبقى الإيقاف اليدوي والحد الأقصى */ }
  }, [stop]);

  useEffect(() => () => { stop(); stopPlayback(); }, [stop]);
  return { state, level, start, stop };
}
