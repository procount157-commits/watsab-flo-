import assert from "node:assert/strict";
import { carouselBody, carouselPrompt } from "../wa-autopilot";
import { carouselButtons, carouselReady } from "../wa-buttons";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const body = carouselBody("نجهّز ملف AML لمكتبكم.", "We prepare your AML file.");
ok(body.startsWith("السادة {اسم_الشركة|شركتكم} المحترمين،") && body.includes("Dear {اسم_الشركة|Sir/Madam} team,"), "both greetings above the cards");
const cards = [
  { title: "ملف AML جاهز", description: "نجهّزه كاملاً", imageUrl: "/a.png", buttonText: "مهتم", buttonType: "interested" as const },
  { title: "AML file ready", description: "We prepare it fully", imageUrl: "/b.png", buttonText: "Interested", buttonType: "interested" as const },
];
ok(carouselReady(cards).ok, "two cards with images are a real carousel");
const btns = carouselButtons(cards);
ok(btns.every((b) => b[0]!.type === "interested" && b[b.length - 1]!.type === "stop"), "interested first, stop last, on every card");
ok(btns[1]![0]!.text === "Interested", "the English card's button is English");
const p = carouselPrompt({ firm: "برو كاونت", description: "", target: "عقارات", service: "aml", brief: "", memory: "", facts: "", plan: [{ key: "A", cards: [{ lang: "ar", vision: "تصميم عربي" }, { lang: "en", vision: "English design" }] }] });
ok(p.includes("البطاقة 1 (بالعربية)") && p.includes("البطاقة 2 (بالإنجليزية (English))"), "each card told its language");
console.log(`wa-carousel: ${n}/${n} ✅`);
