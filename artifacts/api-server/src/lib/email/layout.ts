// ── How an email looks ────────────────────────────────────────────
// The firm's branded layout: a header in its colour with its logo, the
// message in a white card, and a footer with who sent it, how to reach them
// and how to stop. Built the way email has to be built — tables and inline
// styles, because Gmail, Outlook and phone clients ignore most CSS — and
// sized for a phone first.
//
// The message itself stays simple HTML (paragraphs, lists, links), so the
// owner and the agents write content, not layout. Four marks give it shape:
//   <p class="lead">…</p>                            → the summary: the whole point in 2–3 lines
//   <p class="cta"><a href="…">Book a call</a></p>   → a button
//   <hr class="more">                                → "in more detail", for whoever reads on
//   <div class="note">…</div>                        → a highlighted box
//
// Read first, detail after: a busy manager reads the summary and the button
// and decides; the details are there for the one who wants them. The order
// is enforced here, so a button written at the bottom still sits under the
// summary.
// and the layout styles every paragraph, list, heading and link inline.

export interface Brand {
  layout: "branded" | "plain";
  name: string;
  tagline?: string | null;
  color: string;      // header and headings
  accent: string;     // buttons and links
  logoUrl?: string | null;
  website?: string | null;
  phone?: string | null;
  address?: string | null;
}

export function brandOf(s: { layout?: string | null; brandName?: string | null; brandTagline?: string | null; brandColor?: string | null; brandAccent?: string | null; logoUrl?: string | null; website?: string | null; phone?: string | null; address?: string | null; fromName?: string | null } | null | undefined): Brand {
  const hex = (v: string | null | undefined, d: string) => (v && /^#[0-9a-f]{3,8}$/i.test(v.trim()) ? v.trim() : d);
  return {
    layout: s?.layout === "plain" ? "plain" : "branded",
    name: s?.brandName?.trim() || s?.fromName?.trim() || "",
    tagline: s?.brandTagline?.trim() || null,
    color: hex(s?.brandColor, "#111c33"),
    accent: hex(s?.brandAccent, "#0284c7"),
    logoUrl: s?.logoUrl?.trim() && /^https:\/\//i.test(s.logoUrl.trim()) ? s.logoUrl.trim() : null,
    website: s?.website?.trim() || null,
    phone: s?.phone?.trim() || null,
    address: s?.address?.trim() || null,
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const FONT_AR = "Tahoma,'Segoe UI',Arial,sans-serif";

/** Right to left when the message is mostly Arabic. */
export function directionOf(html: string): "rtl" | "ltr" {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\{\{[^}]*\}\}/g, " ");
  const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
  const lat = (text.match(/[A-Za-z]/g) ?? []).length;
  return ar > lat ? "rtl" : "ltr";
}

/** Inline styles on the message's own elements, and the two marks turned into a button and a box. */
/**
 * Summary, then the button, then the details: when the message has a summary
 * and a button but the button sits below the details, the first button moves
 * up to just after the summary. Pure.
 */
export function skimFirst(html: string): string {
  if (!/class="lead"/.test(html)) return html;
  const cta = /<p[^>]*class="cta"[^>]*>[\s\S]*?<\/p>/i.exec(html);
  const more = /<hr[^>]*class="more"[^>]*\/?>/i.exec(html);
  if (!cta || !more || cta.index < more.index) return html;
  const without = html.slice(0, cta.index) + html.slice(cta.index + cta[0].length);
  const leads = [...without.matchAll(/<p[^>]*class="lead"[^>]*>[\s\S]*?<\/p>/gi)];
  const last = leads[leads.length - 1]!;
  const at = last.index! + last[0].length;
  return without.slice(0, at) + cta[0] + without.slice(at);
}

export function styleBody(html: string, brand: Brand, dir: "rtl" | "ltr"): string {
  const align = dir === "rtl" ? "right" : "left";
  html = skimFirst(html);
  const addStyle = (tag: string, style: string) => (s: string) =>
    s.replace(new RegExp(`<${tag}(?![^>]*\\bstyle=)(\\s[^>]*)?>`, "gi"), (_m, attrs = "") => `<${tag}${attrs} style="${style}">`);
  let out = html;
  // The button: a table cell, so it stays a button in Outlook.
  out = out.replace(/<p[^>]*class="cta"[^>]*>\s*<a\s+([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>\s*<\/p>/gi, (_m, _a, href, _b, label) =>
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0"><tr><td style="border-radius:8px;background:${brand.accent}">` +
    `<a href="${href}" style="display:inline-block;padding:13px 26px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;border-radius:8px">${label.replace(/<[^>]+>/g, "")}</a></td></tr></table>`);
  // The summary: larger, darker — it is the message for most readers.
  out = out.replace(/<p([^>]*)class="lead"([^>]*)>/gi, (_m, a, b) => `<p${a}${b} style="margin:0 0 12px;font:500 17px/1.6 ${dir === "rtl" ? FONT_AR : FONT};color:#0f172a;text-align:${align}">`);
  // The line between the summary and the detail, labelled for whoever reads on.
  out = out.replace(/<hr[^>]*class="more"[^>]*\/?>/gi, () =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 16px"><tr>` +
    `<td width="50%" style="vertical-align:middle"><div style="border-top:1px solid #dbe2ea;height:1px;line-height:1px;font-size:0">&nbsp;</div></td>` +
    `<td style="white-space:nowrap;vertical-align:middle;padding:0 12px;font:600 11px/1 ${dir === "rtl" ? FONT_AR : FONT};letter-spacing:${dir === "rtl" ? "0" : "1.2px"};text-transform:uppercase;color:#94a3b8">${dir === "rtl" ? "التفاصيل لمن يرغب" : "In more detail"}</td>` +
    `<td width="50%" style="vertical-align:middle"><div style="border-top:1px solid #dbe2ea;height:1px;line-height:1px;font-size:0">&nbsp;</div></td></tr></table>`);
  // The box.
  out = out.replace(/<div[^>]*class="note"[^>]*>([\s\S]*?)<\/div>/gi, (_m, inner) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0"><tr><td style="background:#f1f5f9;border-${dir === "rtl" ? "right" : "left"}:4px solid ${brand.accent};border-radius:6px;padding:14px 16px;font:14px/1.65 ${dir === "rtl" ? FONT_AR : FONT};color:#1e293b">${inner}</td></tr></table>`);
  for (const [tag, style] of [
    ["p", `margin:0 0 14px;text-align:${align}`],
    ["h2", `margin:0 0 12px;font:700 20px/1.35 ${FONT};color:${brand.color};text-align:${align}`],
    ["h3", `margin:18px 0 8px;font:700 16px/1.4 ${FONT};color:${brand.color};text-align:${align}`],
    ["ul", `margin:0 0 16px;padding-${dir === "rtl" ? "right" : "left"}:22px`],
    ["ol", `margin:0 0 16px;padding-${dir === "rtl" ? "right" : "left"}:22px`],
    ["li", "margin:0 0 7px"],
    ["a", `color:${brand.accent};text-decoration:underline`],
    ["blockquote", `margin:0 0 16px;padding:10px 14px;border-${dir === "rtl" ? "right" : "left"}:3px solid #cbd5e1;color:#475569`],
  ] as const) out = addStyle(tag, style)(out);
  return out;
}

/** The whole page around the message. `footer` is the sender-and-unsubscribe lines. */
export function wrapBranded(bodyHtml: string, brand: Brand, footerHtml: string, preheader: string, dir: "rtl" | "ltr"): string {
  const font = dir === "rtl" ? FONT_AR : FONT;
  const logo = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" width="34" height="34" alt="" style="display:block;border:0;width:34px;height:34px">`
    : "";
  const header = `
    <tr><td style="background:${brand.color};padding:20px 28px;border-radius:12px 12px 0 0">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" ${dir === "rtl" ? 'dir="rtl"' : ""}><tr>
        ${logo ? `<td style="padding-${dir === "rtl" ? "left" : "right"}:12px;vertical-align:middle">${logo}</td>` : ""}
        <td style="vertical-align:middle">
          <div style="font:800 18px/1.1 ${FONT};letter-spacing:1.5px;color:#ffffff">${esc(brand.name)}</div>
          ${brand.tagline ? `<div style="font:12px/1.4 ${FONT};color:#cbd5e1;margin-top:4px">${esc(brand.tagline)}</div>` : ""}
        </td>
      </tr></table>
    </td></tr>`;
  const contact = [
    brand.website ? `<a href="${esc(/^https?:/i.test(brand.website) ? brand.website : `https://${brand.website}`)}" style="color:${brand.accent};text-decoration:none">${esc(brand.website.replace(/^https?:\/\//i, ""))}</a>` : "",
    brand.phone ? `<a href="tel:${esc(brand.phone.replace(/[^\d+]/g, ""))}" style="color:#475569;text-decoration:none">${esc(brand.phone)}</a>` : "",
  ].filter(Boolean).join(" &nbsp;·&nbsp; ");
  return `<!doctype html>
<html lang="${dir === "rtl" ? "ar" : "en"}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title></title></head>
<body style="margin:0;padding:0;background:#eef2f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f6"><tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
    ${header}
    <tr><td dir="${dir}" style="background:#ffffff;padding:32px 28px 26px;font:15px/1.75 ${font};color:#1e293b;text-align:${dir === "rtl" ? "right" : "left"};border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0">
      ${bodyHtml}
    </td></tr>
    <tr><td style="background:#f8fafc;padding:18px 28px 22px;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 12px 12px;font:12px/1.7 ${FONT};color:#64748b;text-align:center">
      <div style="font-weight:700;color:#334155">${esc(brand.name)}</div>
      ${brand.address ? `<div>${esc(brand.address)}</div>` : ""}
      ${contact ? `<div style="margin-top:2px">${contact}</div>` : ""}
      <div style="margin-top:10px">${footerHtml}</div>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/** The first words a client shows beside the subject. */
export function preheaderOf(html: string): string {
  const paras = html.split(/<\/p>|<br\s*\/?>|\n/i).map((x) => x.replace(/<[^>]+>/g, " ").replace(/\{\{[^}]*\}\}/g, "").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  // "Hello team," says nothing beside the subject; the sentence after it does.
  if (paras.length > 1 && paras[0]!.length < 45 && /[,،:]$/.test(paras[0]!)) paras.shift();
  return paras.join(" ").slice(0, 110);
}
