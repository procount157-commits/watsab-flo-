// ── من النص إلى الصوت: أصوات Edge الموجودة ─────────────────────────
// MP3 لأن المتصفح (سفاري خاصةً) لا يضمن Ogg. صوتٌ لكل لغة، وجنسٌ ثابت لكل موظف حتى
// يُميَّز المتكلم في الاجتماع: المدير التنفيذي ذكر، والبقية بحسب مفتاحهم.

import { speakMp3, VOICES, type Gender } from "../../tts";

export type TtsFn = (text: string, lang: "ar" | "en", gender: Gender) => Promise<{ audio: Buffer; voice: string } | null>;

export const edgeTts: TtsFn = (text, lang, gender) => speakMp3(text, { lang, gender });

/** جنس الصوت لموظف: ثابت لمفتاحه. Pure. */
export function genderFor(employeeKey: string | null | undefined): Gender {
  if (!employeeKey || employeeKey === "executive.ceo") return "male";
  let h = 0;
  for (const c of employeeKey) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 2 ? "female" : "male";
}
export const voiceName = (lang: "ar" | "en", g: Gender) => VOICES[lang][g];
