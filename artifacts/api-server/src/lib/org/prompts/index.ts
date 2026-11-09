// ── مكتبة تعليمات موظفي Flow Hub ───────────────────────────────────
// مصدرها الشيفرة: ما تقرؤه المحلّلات وما تفعله الأدوات. غير مفعّلة: لا يستوردها أي
// مسار تشغيل حتى يوافق صاحب العمل؛ وprompt-core يُضاف فوقها وقت التشغيل ولا يُكرَّر هنا.
// لينكدإن خارجها عمداً: بلا مشغّل، جاهزية على الورق فقط.

import { EMAIL_PROMPTS } from "./email";
import { EXECUTIVE_PROMPTS } from "./executive";
import { INSTAGRAM_PROMPTS } from "./instagram";
import { SHARED_PROMPTS } from "./shared";
import { TARGET_ACCOUNTS_PROMPTS } from "./target-accounts";
import { TIKTOK_PROMPTS } from "./tiktok";
import type { PromptLibrary } from "./types";
import { WHATSAPP_PROMPTS } from "./whatsapp";

export const PROMPT_LIBRARY: PromptLibrary = {
  ...EXECUTIVE_PROMPTS,
  ...EMAIL_PROMPTS,
  ...TARGET_ACCOUNTS_PROMPTS,
  ...WHATSAPP_PROMPTS,
  ...SHARED_PROMPTS,
  ...INSTAGRAM_PROMPTS,
  ...TIKTOK_PROMPTS,
};

export { renderPrompt, accountBlock, accountKind, type PromptAccount } from "./accounts";
export { SECTION_KEYS, SECTION_TITLES, type PromptEntry, type PromptLibrary, type PromptSections, type SectionKey } from "./types";
