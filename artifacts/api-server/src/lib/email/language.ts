// ── Email goes out in English ─────────────────────────────────────
// The owner's rule: every email is English — campaigns, follow-ups, replies —
// even when he asks for one in Arabic. The firm's prospects read business
// email in English, and one language keeps the voice, the templates and the
// subject tests comparable. Arabic stays the language of the app itself.

export const EMAIL_LANGUAGE = "en" as const;

/** Mostly English, ignoring merge fields, tags and the odd Arabic company name. */
export function isEnglish(html: string): boolean {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\{\{[^}]*\}\}/g, " ").replace(/&[a-z]+;/gi, " ");
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  if (!ar && !lat) return true;
  // A company name or two in Arabic inside an English email is still English.
  return ar <= lat * 0.3;
}

export const NOT_ENGLISH = "الإيميلات بالإنجليزية فقط — هذه الرسالة مكتوبة بالعربية. اكتبها بالإنجليزية أو دع نورة تعيد كتابتها.";
