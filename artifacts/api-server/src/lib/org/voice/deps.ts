// ── ما تتصل به غرفة التحكّم: التفريغ والنموذج والصوت ─────────────────
// في التشغيل: Groq Whisper وcomplete() وEdge. في الاختبار: بدائل تُسجَّل هنا، فلا شبكة.
// النموذج يُنادى دائماً داخل asAgent بدور الموظف (respond.ts)، فمفاتيح الإيقاف وقواعد
// نموذج الحساب تسري كما تسري على عمله العادي.

import { complete } from "../../llm";
import { groqStt, type SttFn } from "./stt";
import { edgeTts, type TtsFn } from "./tts";

export interface VoiceDeps { stt: SttFn; llm: typeof complete; tts: TtsFn; sttName: string }
const real: VoiceDeps = { stt: groqStt, llm: complete, tts: edgeTts, sttName: "groq" };
let current: VoiceDeps = real;

export const voiceDeps = () => current;
/** للاختبار وحده. sttName ≠ groq يعني أن الدور لا يُحسب تجربةً حقيقية في الجاهزية. */
export function setVoiceDeps(d: Partial<VoiceDeps>): void { current = { ...current, sttName: "stub", ...d }; }
export function resetVoiceDeps(): void { current = real; }
