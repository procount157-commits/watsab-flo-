// ── WhatsApp's own buttons, as data ───────────────────────────────
// What a campaign's buttons become in a native-flow interactive message, and
// how a tap on one comes back. Kept apart from the socket so it can be tested.

export type ButtonDef = { text: string; type?: "url" | "call" | "reply" | "interested" | "not_interested" | "stop"; url?: string; phone?: string };

/** The native-flow buttons for one message. A link or call with no target becomes a reply. */
export function nativeFlowButtons(btns: ButtonDef[]) {
  return btns.filter((b) => b.text?.trim()).slice(0, 10).map((b, i) => {
    const display_text = b.text.trim();
    if (b.type === "url" && b.url?.trim()) {
      const url = /^https?:\/\//i.test(b.url.trim()) ? b.url.trim() : `https://${b.url.trim()}`;
      return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text, url, merchant_url: url }) };
    }
    if (b.type === "call" && b.phone?.trim()) {
      const phone_number = "+" + b.phone.replace(/\D/g, "");
      return { name: "cta_call", buttonParamsJson: JSON.stringify({ display_text, phone_number }) };
    }
    return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text, id: `btn:${b.type ?? "reply"}:${i}` }) };
  });
}

/** A tapped quick-reply button: WhatsApp sends the label as the body, the id in paramsJson. */
export function interactiveReplyText(r: any): string {
  if (!r) return "";
  if (r.body?.text) return String(r.body.text);
  try {
    const p = JSON.parse(r.nativeFlowResponseMessage?.paramsJson ?? "{}");
    return String(p.display_text ?? p.title ?? p.id ?? "");
  } catch { return ""; }
}

