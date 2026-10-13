// The campaign's buttons as WhatsApp's own: a link opens, a call dials, the
// rest come back as a reply — and a tap reads as the button's words, so the
// interested / not-interested matcher sees it as before.

export {};
const { nativeFlowButtons, interactiveReplyText, cardBody, carouselButtons, carouselReady } = await import("../wa-buttons");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

const out = nativeFlowButtons([
  { text: "زوروا موقعنا", type: "url", url: "pro-count.ae" },
  { text: "اتصل بنا", type: "call", phone: "971 58 895 1186" },
  { text: "مهتم", type: "interested" },
  { text: "  ", type: "reply" },
  { text: "رابط بلا عنوان", type: "url" },
]);
const params = out.map((b) => JSON.parse(b.buttonParamsJson));
check("a link button opens the page, with https added", out[0]!.name === "cta_url" && params[0].url === "https://pro-count.ae");
check("a call button dials the number in international form", out[1]!.name === "cta_call" && params[1].phone_number === "+971588951186");
check("interested is a quick reply that keeps its words", out[2]!.name === "quick_reply" && params[2].display_text === "مهتم" && params[2].id.startsWith("btn:interested"));
check("an empty button is dropped", out.length === 4);
check("a link with no address becomes a reply, not a broken link", out[3]!.name === "quick_reply");
check("at most ten buttons", nativeFlowButtons(Array.from({ length: 14 }, (_, i) => ({ text: `b${i}` }))).length === 10);

check("a tap reads as the button's words", interactiveReplyText({ body: { text: "مهتم" }, nativeFlowResponseMessage: { paramsJson: '{"id":"btn:interested:2"}' } }) === "مهتم");
check("...or from the params when the body is missing", interactiveReplyText({ nativeFlowResponseMessage: { paramsJson: '{"display_text":"غير مهتم"}' } }) === "غير مهتم");
check("bad params are no text, not a crash", interactiveReplyText({ nativeFlowResponseMessage: { paramsJson: "{" } }) === "" && interactiveReplyText(undefined) === "");

// ── الكاروسيل: إعلانات بجانب بعض ──
const cards = [
  { title: "عرض الذهب", description: "عيار ٢١ بسعر اليوم", imageUrl: "/u/a.jpg", buttonText: "اطلب الآن", buttonUrl: "floret.ae" },
  { title: "طقم الكلوفر", imageUrl: "/u/b.jpg" },
];
const cb = carouselButtons(cards);
check("carousel · every card has the same number of buttons", cb.every((b) => b.length === cb[0]!.length), cb.map((b) => b.length).join(","));
check("carousel · stop is last on every card", cb.every((b) => b[b.length - 1]!.type === "stop"));
check("carousel · a card with no link still gets a button", cb[1]![0]!.type === "reply");
check("carousel · link button opens the page", nativeFlowButtons(cb[0]!)[0]!.name === "cta_url");
check("carousel · body is title bold then text", cardBody(cards[0]!) === "*عرض الذهب*\nعيار ٢١ بسعر اليوم");
check("carousel · body cut at 160", cardBody({ title: "x".repeat(300) }).length <= 160);
check("carousel · two cards with images are ready", carouselReady(cards).ok);
check("carousel · one card is not a carousel", !carouselReady([cards[0]!]).ok);
check("carousel · a card without image is refused", !carouselReady([cards[0]!, { title: "بلا صورة" }]).ok);
check("carousel · no links at all: only stop", carouselButtons([{ title: "a", imageUrl: "x" }, { title: "b", imageUrl: "y" }]).every((b) => b.length === 1));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
