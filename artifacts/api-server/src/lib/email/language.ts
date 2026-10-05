// ── The language email goes out in ────────────────────────────────
// The owner's rule: English, unless he asks for another. The account has a
// default (English), a campaign or mission carries its own language that
// starts from it, and a message is checked against the language of its own
// campaign — an Arabic draft in an English campaign is stopped, an Arabic
// campaign the owner chose goes out in Arabic. Arabic stays the language of
// the app itself.

export type EmailLanguage = "en" | "ar" | "both";
export const EMAIL_LANGUAGE: EmailLanguage = "en";
export const LANGUAGE_AR: Record<EmailLanguage, string> = { en: "الإنجليزية", ar: "العربية", both: "العربية والإنجليزية" };

export function asLanguage(v: unknown, fallback: EmailLanguage = EMAIL_LANGUAGE): EmailLanguage {
  return v === "en" || v === "ar" || v === "both" ? v : fallback;
}

/** Mostly English, ignoring merge fields, tags and an Arabic company name or two. */
export function isEnglish(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\{\{[^}]*\}\}/g, " ").replace(/&[a-z]+;/gi, " ");
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!ar && !lat) return true;
  return ar <= lat * 0.3;
}

/** Whether a message is in the language its campaign was set to. */
export function matchesLanguage(html: string, lang: EmailLanguage): boolean {
  if (lang === "en") return isEnglish(html);
  if (lang === "ar") return !isEnglish(html) || !/[A-Za-z]{3}/.test(html.replace(/<[^>]+>|\{\{[^}]*\}\}|https?:\/\/\S+/g, ""));
  return true;
}

export function wrongLanguage(lang: EmailLanguage): string {
  return lang === "en"
    ? "لغة هذه الحملة الإنجليزية (الافتراضية) والرسالة مكتوبة بالعربية — اكتبها بالإنجليزية، أو غيّر لغة الحملة إن أردت العربية."
    : `لغة هذه الحملة ${LANGUAGE_AR[lang]} والرسالة ليست بها.`;
}

/** The line every writer is given about the language to write in. */
export function languageRule(lang: EmailLanguage): string {
  if (lang === "ar") return "LANGUAGE: the owner chose ARABIC for this campaign — write every subject, body, follow-up and button in clear professional Gulf-readable Arabic.";
  if (lang === "both") return "LANGUAGE: the owner chose BOTH — each email in English first, then the same in Arabic below it.";
  return "LANGUAGE: write every subject, body, follow-up and button in professional UAE B2B ENGLISH — even when the goal, notes or audience are written in Arabic. English is the default; only the owner changes it.";
}

/** @deprecated kept for older callers: English-only message. */
export const NOT_ENGLISH = wrongLanguage("en");
