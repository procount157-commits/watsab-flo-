// The owner's «service only» follow-up for Floret (2026-10-21): what it may
// never say, seven different moments, and never more than three days apart.
import assert from "node:assert/strict";
const { serviceIssues, SERVICE_ANGLE, angleFor, dueRung } = await import("../smart-followup");
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

for (const t of ["مساء الخير، إذا احتجتي أي شي أو عندك سؤال، إحنا موجودين 🌸", "هلا، حبيت أطمّن إذا كل شي واضح عندك، وإذا تحتاجين مساعدة قوليلي"])
  ok(serviceIssues(t).length === 0, `«${t.slice(0, 30)}…» passes`);
ok(serviceIssues("هلا حبيبتي، نحن في الخدمة").includes("فيها كلمة تحبّب"), "حبيبتي is refused");
ok(serviceIssues("هلا يا قلبي").length > 0 && serviceIssues("هلا صاحبتي").length > 0, "قلبي and صاحبتي are refused");
ok(serviceIssues("الطقم سعره مناسب").includes("فيها كلام عن سعر أو وزن أو عرض"), "a price word is refused");
ok(serviceIssues("عندنا خصم هالأسبوع").length > 0 && serviceIssues("الوزن خفيف").length > 0, "discount and weight are refused");
ok(serviceIssues("القطعة ب ٦٤٠٠").includes("فيها رقم") && serviceIssues("call 0501234567").includes("فيها رقم"), "any digit, Arabic or Latin, is refused");
ok(serviceIssues("شوفي https://floret-royal.io").includes("فيها رابط") && serviceIssues("floret-royal.io").includes("فيها رابط"), "a link is refused");
ok(serviceIssues("سطر\nسطر\nسطر\nسطر").length > 0, "four lines is too long");

ok(SERVICE_ANGLE.length === 7, "seven moments");
ok(new Set(SERVICE_ANGLE).size === 7, "seven different ones");
ok(angleFor(6, 7, "jewelry", "service") === SERVICE_ANGLE[6] && angleFor(0, 7, "jewelry", "service") === SERVICE_ANGLE[0], "the service style wins over the shop's angles");
ok(!SERVICE_ANGLE.join(" ").match(/رابط القطعة|سعر/) || SERVICE_ANGLE.every((a) => !/أرسل.*رابط/.test(a)), "no angle asks for a link");

// The ladder: seven rungs, each at most 72 hours after the one before.
const ladder = [4, 24, 48, 72, 72, 72, 72];
ok(ladder.length === 7 && Math.max(...ladder) <= 72, "seven rungs, never more than three days apart");
const H = 3_600_000, t0 = Date.UTC(2026, 9, 21, 8);
const turns = [{ fromMe: false, text: "عندكم خلخال؟", at: new Date(t0) }, { fromMe: true, text: "هلا، نعم موجود", at: new Date(t0 + H) }];
ok(dueRung(turns, [], false, t0 + 5 * H, { ladder })?.rung === 0, "the first is due four hours after our last word");
ok(dueRung(turns, [], false, t0 + 4 * H, { ladder }) === null, "not before");
const sent = [new Date(t0 + 5 * H)];
ok(dueRung(turns, sent, false, t0 + 5 * H + 23 * H, { ladder }) === null && dueRung(turns, sent, false, t0 + 5 * H + 24 * H, { ladder })?.rung === 1, "the second a day after the first");
const six = [1, 2, 3, 4, 5, 6].map((i) => new Date(t0 + i * 80 * H));
ok(dueRung(turns, six, false, t0 + 6 * 80 * H + 72 * H, { ladder })?.rung === 6, "the seventh three days after the sixth");
const seven = [...six, new Date(t0 + 7 * 80 * H)];
ok(dueRung(turns, seven, false, t0 + 30 * 24 * H, { ladder }) === null, "nothing after the seventh");
const replied = [...turns, { fromMe: false, text: "شكراً", at: new Date(t0 + 200 * H) }];
ok(dueRung(replied, six, false, t0 + 210 * H, { ladder }) === null, "her reply is answered by a person first, not a follow-up");
console.log(`followup-service: ${n}/${n} ✅`);
// Added after the first live round (2026-10-21): no reply-to-a-greeting opener, and one text is not for many.
{
  const { serviceIssues: si, overlap } = await import("../smart-followup");
  assert.ok(si("وعليكم السلام، إذا تحتاجين شي إحنا موجودين").length > 0, "a reply to an old greeting is refused");
  assert.ok(si("هلا، إذا تحتاجين شي إحنا موجودين").length === 0, "«هلا» is fine");
  const a = "Hello, I just wanted to check if you have any further questions or if there is anything else I can help you with.";
  const b = "Hello, I just wanted to check if you have any further questions or if there is anything else I can assist you with.";
  assert.ok(overlap(a, b) > 0.75, "two near-identical texts are caught as one");
  console.log("followup-service extra: 3/3 ✅");
}
// The sales style and the language rule (the owner, 2026-10-21).
{
  const { followupLanguage, salesIssues, SALES_ANGLE, angleFor: af } = await import("../smart-followup");
  let m = 0; const t = (c: boolean, msg: string) => { assert.ok(c, msg); m++; };
  t(followupLanguage(["Hello! Can I get more info on this?"]) === "ar", "the ad's prefilled English is not her language");
  t(followupLanguage(["Hello! Can I get more info on this?", "كم سعره؟"]) === "ar", "she then wrote Arabic");
  t(followupLanguage(["مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟"]) === "ar", "the Arabic prefill");
  t(followupLanguage(["Hello! Can I get more info on this?", "Hello sir, I would like to buy some gold earrings."]) === "en", "she wrote English herself");
  t(followupLanguage(["Hello! Can I get more info on this?سعر ووزن"]) === "ar", "the prefill glued to Arabic words");
  t(followupLanguage(["Hello! Can I get more info on this?", "Okay"]) === "ar", "a lone «Okay» is not a language");
  t(followupLanguage(["How much aed"]) === "en", "a real English question");
  const site = "https://floret-royal.io";
  t(salesIssues("مساء الخير 🌸 عندنا قطع كثيرة في الموقع، تقدرين تاخذين فكرة: https://floret-royal.io", site).length === 0, "the site's link is allowed");
  t(salesIssues("شوفي https://other-shop.com", site).includes("فيها رابط غير رابط الموقع"), "another site is not");
  t(salesIssues("هلا حبيبتي https://floret-royal.io", site).includes("فيها كلمة تحبّب"), "endearments still refused");
  t(salesIssues("الطقم سعره حلو https://floret-royal.io", site).length > 0, "prices still refused");
  t(salesIssues("Hello dear, check our site https://floret-royal.io", site, "ar").includes("فيها كلام بالإنجليزية والزبونة تُكتب لها بالعربية"), "English to an Arabic customer is refused");
  t(salesIssues("Good evening, you can browse our pieces here: https://floret-royal.io", site, "en").length === 0, "English is fine for one who wrote it");
  t(SALES_ANGLE.length === 7 && af(0, 7, "jewelry", "sales") === SALES_ANGLE[0], "seven sales moments");
  console.log(`followup-sales: ${m}/${m} ✅`);
}
// Variety (2026-10-22): twenty customers on one rung do not open alike.
{
  const { variety, textOverlap, OPENERS, SHAPES } = await import("../smart-followup");
  const phones = Array.from({ length: 20 }, (_, i) => `97150${(1000000 + i * 7919).toString().slice(0, 7)}:0`);
  const openers = new Set(phones.map((p) => variety(p, 0, 10).opener)), shapes = new Set(phones.map((p) => variety(p, 0, 10).shape));
  assert.ok(openers.size >= 5 && shapes.size >= 4, `twenty phones, ${openers.size} openers and ${shapes.size} shapes`);
  assert.ok(variety("971501234567:0", 2, 10).opener === variety("971501234567:0", 2, 10).opener, "the same person and rung keep their shape");
  assert.ok(variety("x", 0, 9).opener.includes("صباح") || !variety("x", 0, 9).opener.includes("مساء"), "morning in the morning");
  assert.ok(OPENERS.length >= 8 && SHAPES.length >= 5, "enough to choose from");
  const a = "هلا، عندنا قطع كثيرة في الموقع https://floret-royal.io", b = "مساء الخير، شوفي الموقع https://floret-royal.io/";
  assert.ok(textOverlap(a, b) < 0.75, "the shared link does not make two texts one");
  console.log("followup-variety: 5/5 ✅");
}
// Her last words and her last question (2026-10-22).
{
  const { herLast } = await import("../smart-followup");
  const t = (fromMe: boolean, text: string) => ({ fromMe, text });
  const a = herLast([t(false, "Hello! Can I get more info on this?"), t(true, "هلا، نعم"), t(false, "كم وزن الطقم؟"), t(true, "تفاصيله في الموقع"), t(false, "طيب")]);
  assert.ok(a.question === "كم وزن الطقم؟", `her last question: ${a.question}`);
  assert.ok(a.words?.includes("طيب") && !a.words?.includes("Can I get"), "her last words, without the ad's prefill");
  const b = herLast([t(false, "Hello! Can I get more info on this?")]);
  assert.ok(b.question === null && b.words === null, "the ad's prefill alone is not a question of hers");
  const c = herLast([t(false, "عندكم خواتم بنات")]);
  assert.ok(c.question === "عندكم خواتم بنات", "«عندكم…» without a question mark is still a question");
  console.log("followup-last: 4/4 ✅");
}
