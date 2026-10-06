// ── The customer's company, as a person would write it in a message ──
// Every number in a list is saved under its company — and saved the way the
// directory spelled it: "WEST LEGEND REAL ESTATE BROKERS L.L.C", or both
// languages at once, "الاطلالة للمقاولات العامة Al Etlala General Contracting".
// Pasted into a greeting as it is, that reads as a mail merge, which is the
// one thing a personalised message must not look like.
//
// So the name is cut to the half that matches the message's language, the
// legal suffix goes (L.L.C, FZE, ذ.م.م, م.م.ح…), shouting is lowered, and a
// name too long to say in a sentence is trimmed at a word. The result is what
// {اسم_الشركة} puts in each message — different in every one, which is also
// what keeps a campaign from reading to WhatsApp as one text sent a thousand
// times.

import { companyName } from "./email/tracking";

export type Lang = "ar" | "en";

const AR = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;

/** Arabic or English, by which letters the text mostly uses. */
export function languageOfText(text: string): Lang {
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length, en = (text.match(/[A-Za-z]/g) ?? []).length;
  return ar >= en * 0.5 ? "ar" : "en";
}

/** The Arabic words and the Latin words of a mixed name, each in order. */
function halves(raw: string) {
  const words = raw.replace(/\s+/g, " ").trim().split(" ");
  const ar = words.filter((w) => AR.test(w) && !LATIN.test(w)).join(" ").trim();
  const en = words.filter((w) => LATIN.test(w) && !AR.test(w)).join(" ").trim();
  return { ar, en };
}

/** Arabic legal forms and branch notes that no one says aloud. */
function cleanArabic(s: string) {
  let n = s.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  const SUFFIX = /\s*(ش\.?\s?ذ\.?\s?م\.?\s?م\.?|ذ\.?\s?م\.?\s?م\.?|م\.?\s?م\.?\s?ح\.?|ش\.?\s?م\.?\s?خ\.?|ش\.?\s?م\.?\s?ع\.?|ش\.?\s?ش\.?\s?و\.?|شركة الشخص الواحد|فرع\s+\S+(\s+\S+)?|ـ?\s*فرع)\s*$/;
  for (let i = 0; i < 3; i++) { const m = n.replace(SUFFIX, "").trim(); if (m === n || m.length < 2) break; n = m; }
  return n.replace(/[\s،,.\-–]+$/, "");
}

/** Trim to a sayable length at a word. */
function sayable(s: string, max = 48) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 20)).trim();
}

/**
 * The company for one message. `lang` is the message's language; a name with
 * only the other language's half is still used rather than left blank.
 */
export function displayCompany(raw: string | null | undefined, lang: Lang = "ar"): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // A phone number saved as the name is no name.
  if (/^\+?[\d\s\-()]{7,}$/.test(s)) return "";
  const { ar, en } = halves(s);
  const pickAr = ar && (lang === "ar" || !en);
  const out = pickAr ? cleanArabic(ar) : en ? companyName(en) : companyName(s);
  return sayable(out || s);
}

/**
 * The per-recipient variables, with an optional fallback written after a bar:
 * {اسم_الشركة|شركتكم} gives «شركتكم» for a number saved without a name. Run
 * BEFORE spintax, which would otherwise read the bar as a choice of two.
 */
export const COMPANY_VARS = /\{\s*(اسم_الشركة|اسم الشركة|اسم_الشركه|شركة_العميل|الجهة|client|client_company|company_name)\s*(?:\|([^{}]*))?\}/gi;
export const NAME_VARS = /\{\s*(الاسم|اسم|name)\s*\|([^{}]*)\}/gi;

export function fillRecipient(template: string, contactName: string | null | undefined): string {
  const lang = languageOfText(template.replace(COMPANY_VARS, ""));
  const company = displayCompany(contactName, lang);
  return template
    .replace(COMPANY_VARS, (_, _k: string, fallback?: string) => company || (fallback ?? "").trim())
    .replace(NAME_VARS, (_, _k: string, fallback: string) => company || fallback.trim());
}

/** Whether every recipient would get the same words — the bulk pattern WhatsApp flags first. */
export function variesPerRecipient(template: string): boolean {
  return /\{[^{}]*\|[^{}]*\}/.test(template) || new RegExp(COMPANY_VARS.source, "i").test(template) || /\{(الاسم|اسم|name|تحية|ختام|cta)\}/i.test(template);
}
