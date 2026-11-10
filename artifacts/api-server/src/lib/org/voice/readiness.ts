// ── جاهزية الصوت ──────────────────────────────────────────────────
// الصوت داخل التطبيق READY فقط بعد دورٍ حقيقي كامل على هذا الخادم لهذا الحساب: تفريغٌ من
// Groq (لا بديل اختبار) ثم جواب موظف ثم صوتٌ وُلّد له فعلاً. قبل ذلك NEEDS_TEST.
// الهاتف والتقويم والصوت الكامل الاتجاهين BLOCKED: لا مزوّد ولا مفاتيح، ويُقال ما ينقص.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureVoiceTables } from "./schema";
import { sttConfigured } from "./stt";
import { voiceSettings } from "./calls";
import { MAX_CALL_MODEL_CALLS, MAX_MEETING_MODEL_CALLS, MAX_TURN_AUDIO_MS } from "./limits";

export type ReadyStatus = "READY" | "BLOCKED" | "NEEDS_TEST";
export interface VoiceReadinessItem { id: string; title: string; status: ReadyStatus; detail: string; missing: string[] }

/** دليل الدور الحقيقي: سطر مالك صوتي من groq، يتبعه في المكالمة نفسها رد موظف وُلّد صوته. */
async function realTurnEvidence(userId: number): Promise<{ callId: number; at: string } | null> {
  const [r] = (await db.execute<any>(sql`SELECT o.call_id, e.created_at FROM call_transcripts o
    JOIN call_transcripts e ON e.call_id = o.call_id AND e.seq > o.seq AND e.speaker = 'employee' AND e.tts_ms IS NOT NULL
    WHERE o.user_id = ${userId} AND o.speaker = 'owner' AND o.source = 'voice' AND o.stt_model LIKE 'groq:%'
    ORDER BY e.created_at DESC LIMIT 1`)).rows;
  return r ? { callId: Number(r.call_id), at: new Date(r.created_at).toISOString() } : null;
}

export async function voiceReadiness(userId: number) {
  await ensureVoiceTables();
  const items: VoiceReadinessItem[] = [];
  const stt = sttConfigured();
  const ev = stt ? await realTurnEvidence(userId) : null;
  items.push({
    id: "voice.in_app", title: "مكالمة صوتية داخل التطبيق (نصف اتجاهية)",
    status: !stt ? "BLOCKED" : ev ? "READY" : "NEEDS_TEST",
    detail: !stt ? "لا تفريغ للصوت: GROQ_API_KEY غير مضبوط على الخادم. النص يعمل بديلاً."
      : ev ? `اختُبر دورٌ حقيقي كامل (تفريغ Groq ← جواب ← صوت Edge) في المكالمة #${ev.callId} بتاريخ ${ev.at}.`
      : "المكوّنات مضبوطة، ولم يُجرَ بعد دورٌ حقيقي كامل على هذا الخادم لهذا الحساب: صوتٌ من الميكروفون، ثم جواب، ثم تشغيل صوته.",
    missing: !stt ? ["GROQ_API_KEY"] : ev ? [] : ["تجربة حقيقية من المتصفح على الخادم"],
  });
  items.push({ id: "voice.text_fallback", title: "المكالمة نصاً عند منع الميكروفون", status: "READY", detail: "الكتابة تمرّ بالمسار نفسه بلا تفريغ.", missing: [] });
  items.push({
    id: "voice.pstn", title: "مكالمات الهاتف (PSTN)", status: "BLOCKED",
    detail: "لا مزوّد اتصالات مدمج (Twilio أو غيره) ولا رقم. لا يُتصل بأي رقم خارجي من المنتج.",
    missing: ["مزوّد اتصالات (مثل Twilio Voice)", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "رقم هاتف مُشترى ومُتحقق", "عنوان webhook عام للمكالمات"],
  });
  items.push({
    id: "voice.realtime", title: "صوت كامل الاتجاهين في الوقت الحقيقي (WebRTC)", status: "BLOCKED",
    detail: "غير مضبوط: لا مزوّد صوت لحظي. المتاح أدوارٌ متتابعة (يتكلم طرف ثم الآخر)، ولا يُعرض كأنه مكالمة متزامنة.",
    missing: ["مزوّد WebRTC/صوت لحظي (مثل LiveKit أو OpenAI Realtime)", "مفاتيحه", "خادم TURN"],
  });
  items.push({
    id: "meetings.calendar", title: "جدولة الاجتماعات في تقويم خارجي", status: "BLOCKED",
    detail: "لا تكامل تقويم. الموعد يُحفظ داخل Flow Hub فقط ولا يُرسل منه دعوة لأحد.",
    missing: ["تكامل Google Calendar أو Microsoft 365 (OAuth)", "موافقة المالك على الصلاحيات"],
  });
  const s = await voiceSettings(userId);
  items.push({ id: "voice.recording", title: "تسجيل الصوت", status: "READY", detail: s.callRecording ? "مفعّل صراحةً: يُحفظ صوت المالك مع النص." : "مطفأ (الافتراضي): يُحفظ النص فقط.", missing: [] });
  const status: ReadyStatus = items.some((x) => x.status === "BLOCKED") ? "BLOCKED" : items.some((x) => x.status === "NEEDS_TEST") ? "NEEDS_TEST" : "READY";
  return {
    status, checkedAt: new Date().toISOString(), items,
    limits: { maxCallModelCalls: MAX_CALL_MODEL_CALLS, maxMeetingModelCalls: MAX_MEETING_MODEL_CALLS, maxTurnAudioSec: MAX_TURN_AUDIO_MS / 1000, duplex: "half" },
  };
}
