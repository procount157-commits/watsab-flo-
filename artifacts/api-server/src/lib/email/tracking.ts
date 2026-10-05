// ── What goes into an email, and what comes back from it ─────────
// Pure functions: merge fields, the tracking pixel, the click redirect, the
// unsubscribe footer, and the token that ties every one of those back to
// the message it came from. The token is random and stored, not signed —
// the store is the source of truth and an unknown token is simply ignored.

import { createHmac, randomBytes } from "node:crypto";
import { wrapBranded, styleBody, directionOf, preheaderOf, type Brand } from "./layout";

export function newToken(): string { return randomBytes(18).toString("base64url"); }

/** {{name}}, {{company}}, {{first_name}}, {{sender}} … with a fallback: {{name|صاحب الشركة}} */
export function personalize(text: string, vars: Record<string, string | null | undefined>): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_, key: string, fallback?: string) => {
    const v = vars[key.toLowerCase()];
    return (v && String(v).trim()) || (fallback ?? "").trim();
  });
}

export function firstName(name?: string | null): string {
  const n = (name ?? "").trim();
  if (!n) return "";
  const w = n.split(/\s+/);
  // Titles and honorifics are not names.
  const skip = new Set(["mr", "mr.", "mrs", "ms", "dr", "dr.", "eng", "eng.", "السيد", "الأستاذ", "المهندس", "الدكتور", "أ.", "م.", "د."]);
  const first = w.find((x) => !skip.has(x.toLowerCase())) ?? w[0]!;
  return first;
}

/** The click redirect keeps the destination in the query, signed so it cannot be pointed elsewhere. */
export function signUrl(secret: string, token: string, url: string): string {
  return createHmac("sha256", secret).update(`${token}|${url}`).digest("base64url").slice(0, 16);
}

export interface TrackOptions {
  base: string;          // https://site.example — "" means tracking cannot be embedded
  token: string;
  secret: string;
  pixel: boolean;
  links: boolean;
}

/** Rewrite every http(s) link through the redirect. Mailto and anchors are left alone. */
export function rewriteLinks(html: string, o: TrackOptions): string {
  if (!o.links || !o.base) return html;
  return html.replace(/href=(["'])(https?:\/\/[^"']+)\1/gi, (_, q, url) => {
    if (url.startsWith(`${o.base}/t/e/`)) return `href=${q}${url}${q}`;
    const sig = signUrl(o.secret, o.token, url);
    return `href=${q}${o.base}/t/e/${o.token}/c?u=${encodeURIComponent(url)}&s=${sig}${q}`;
  });
}

export function pixelTag(o: TrackOptions): string {
  if (!o.pixel || !o.base) return "";
  return `<img src="${o.base}/t/e/${o.token}.gif" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0.01">`;
}

/**
 * The footer every marketing email carries: who sent it and how to stop it.
 * Required by the bulk-sender rules Gmail and Yahoo enforce, and by simple
 * decency. The link works without the base URL only as a mailto.
 */
export function unsubscribeFooter(o: { base: string; token: string; fromName: string; fromEmail: string; lang?: "ar" | "en" }): string {
  const url = o.base ? `${o.base}/t/e/${o.token}/u` : `mailto:${o.fromEmail}?subject=unsubscribe`;
  const ar = `<p style="margin:0 0 6px">هذه الرسالة من ${esc(o.fromName)} &lt;${esc(o.fromEmail)}&gt;. إن لم ترغب في رسائل أخرى: <a href="${url}" style="color:#6b7280">إلغاء الاشتراك</a>.</p>`;
  const en = `<p style="margin:0">Sent by ${esc(o.fromName)}. Don't want these? <a href="${url}" style="color:#6b7280">Unsubscribe</a>.</p>`;
  // An English email carries an English footer only; Arabic keeps both, since
  // the unsubscribe line is the one thing every reader must be able to read.
  if (o.lang === "en") return `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;font:12px/1.6 Arial,sans-serif;color:#6b7280" dir="ltr">${en}</div>`;
  return `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #e5e7eb;font:12px/1.6 Arial,sans-serif;color:#6b7280" dir="rtl">${ar}${en}</div>`;
}

export function unsubscribeUrl(base: string, token: string): string | null {
  return base ? `${base}/t/e/${token}/u` : null;
}

/** A readable plain-text part from the HTML, for clients and filters that want one. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<a [^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, u, t) => `${t.replace(/<[^>]+>/g, "")} (${u})`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The whole outgoing body: personalised, tracked, footed — in the firm's branded layout unless it chose plain. */
export function renderEmail(html: string, vars: Record<string, string | null | undefined>, track: TrackOptions, footer: Parameters<typeof unsubscribeFooter>[0], brand?: Brand): { html: string; text: string } {
  const body = rewriteLinks(personalize(html, vars), track);
  if (brand && brand.layout === "branded" && brand.name) {
    const dir = directionOf(body);
    const url = footer.base ? `${footer.base}/t/e/${footer.token}/u` : `mailto:${footer.fromEmail}?subject=unsubscribe`;
    const lines = dir === "rtl"
      ? `أُرسلت هذه الرسالة من ${esc(footer.fromName)} إلى شركتكم. إن لم ترغبوا في رسائل أخرى: <a href="${url}" style="color:#64748b">إلغاء الاشتراك</a>.`
      : `You received this email from ${esc(/[\u0600-\u06FF]/.test(footer.fromName) ? brand.name : footer.fromName)} as a business contact. Prefer not to hear from us? <a href="${url}" style="color:#64748b">Unsubscribe</a>.`;
    const full = wrapBranded(styleBody(body, brand, dir), brand, lines, preheaderOf(personalize(html, vars)), dir).replace("</body>", `${pixelTag(track)}</body>`);
    return { html: full, text: htmlToText(personalize(html, vars)) + `\n\n—\n${brand.name}${brand.phone ? ` · ${brand.phone}` : ""}${brand.website ? ` · ${brand.website}` : ""}\n${unsubscribeUrl(footer.base, footer.token) ?? ""}`.trimEnd() };
  }
  const dir = directionOf(body), lang = dir === "rtl" ? "ar" : "en";
  const full = `<!doctype html><html dir="${dir}" lang="${lang}"><body style="margin:0;padding:0;background:#ffffff"><div style="max-width:640px;margin:0 auto;padding:24px 16px;font:15px/1.8 Arial,Helvetica,sans-serif;color:#111827">${body}${unsubscribeFooter({ ...footer, lang })}</div>${pixelTag(track)}</body></html>`;
  return { html: full, text: htmlToText(personalize(html, vars)) + `\n\n—\n${footer.fromName}\n${unsubscribeUrl(footer.base, footer.token) ?? ""}`.trimEnd() };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
