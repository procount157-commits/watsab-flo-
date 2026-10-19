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


// ── A real carousel ───────────────────────────────────────────────
// What the big senders send (Lulu, Carrefour): a bubble of text, and under it
// cards that slide sideways — each an image, a few lines and its own buttons.
// WhatsApp draws it only if every card has an image and the same buttons, so
// every card carries its link (if any) and the stop button, in that order.

export type CarouselCardDef = { title: string; description?: string; imageUrl?: string; buttonText?: string; buttonUrl?: string; buttonType?: "url" | "call" | "reply"; phone?: string };

export const CAROUSEL_MAX_CARDS = 10;
const STOP: ButtonDef = { text: "إيقاف الرسائل", type: "stop" };

/** The card's words: its title bold, then its description — short, as WhatsApp cuts a card at 160 characters. Pure. */
export function cardBody(c: CarouselCardDef): string {
  const t = `*${c.title.trim()}*${c.description?.trim() ? `\n${c.description.trim()}` : ""}`;
  return t.length > 160 ? `${t.slice(0, 157).trimEnd()}…` : t;
}

/** Each card's buttons. All cards get the same kinds, so the carousel renders; the stop button is last on every one. Pure. */
export function carouselButtons(cards: CarouselCardDef[]): ButtonDef[][] {
  const anyLink = cards.some((c) => c.buttonText?.trim() && (c.buttonUrl?.trim() || c.phone?.trim()));
  return cards.map((c) => {
    const out: ButtonDef[] = [];
    if (anyLink) {
      const text = c.buttonText?.trim() || "التفاصيل";
      if (c.buttonType === "call" && c.phone?.trim()) out.push({ text, type: "call", phone: c.phone });
      else if (c.buttonUrl?.trim()) out.push({ text, type: "url", url: c.buttonUrl });
      else out.push({ text, type: "reply" });
    }
    out.push(STOP);
    return out;
  });
}

/** Can these cards go as a real carousel? Two to ten, each with a title and an image. Pure. */
export function carouselReady(cards: CarouselCardDef[]): { ok: boolean; why?: string } {
  const live = cards.filter((c) => c.title?.trim());
  if (live.length < 2) return { ok: false, why: "الكاروسيل يحتاج بطاقتين على الأقل" };
  if (live.length > CAROUSEL_MAX_CARDS) return { ok: false, why: `الحد ${CAROUSEL_MAX_CARDS} بطاقات` };
  if (live.some((c) => !c.imageUrl?.trim())) return { ok: false, why: "كل بطاقة تحتاج صورة" };
  return { ok: true };
}
