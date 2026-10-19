// مسؤول الشات: ما يتعلّمه يمرّ بقواعد الحساب قبل أن يصل لأحد. دوالّ صِرفة.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { sanitize, playbookText, chatLeadPrompt } = await import("../chat-lead");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(52)} ${d}`); };

const raw = {
  questions: [{ q: "كم سعر الطقم؟", how: "قولي سعره ٦٤٦٠ درهم" }, { q: "متوفر؟", how: "أكّدي التوفر وأرسلي رابط القطعة" }],
  objections: [{ o: "غالي", how: "اعرضي خصم على المصنعية" }, { o: "أفكر", how: "اتركي الباب مفتوحاً برابط القطعة" }],
  works: ["البدء باسم القطعة ورابطها", "هلا حبيبتي ثم الرابط"],
  avoid: ["ذكر السعر في الرسالة", "سؤالان في رسالة"],
  campaignIdeas: [{ audience: "العرائس", angle: "أطقم الزفاف", hook: "طقم يليق بليلتك" }, { audience: "الكل", angle: "خصم ٢٠٪", hook: "" }],
};
const shop = sanitize(raw as any, "jewelry");
check("المحل · جواب فيه سعر يُحذف", shop.questions.length === 1 && shop.questions[0]!.q === "متوفر؟");
check("المحل · علاج بالخصم يُحذف", shop.objections.length === 1);
check("المحل · ما نجح بتحبّب يُحذف", shop.works.length === 1 && !shop.works[0]!.includes("حبيبتي"));
check("المحل · «تجنّب ذكر السعر» يبقى", shop.avoid.some((a) => a.includes("السعر")));
check("المحل · حملة بخصم تُحذف", shop.campaignIdeas.length === 1 && shop.campaignIdeas[0]!.audience === "العرائس");
const acc = sanitize(raw as any, "accounting");
check("المحاسبة · التحبّب يُحذف أيضاً", !acc.works.some((w) => w.includes("حبيبتي")));

const t = playbookText(shop, "sales", "لطيفة", "2026-10-19");
check("دليل الردود فيه الأسئلة والاعتراضات", t.includes("أسئلة تتكرر") && t.includes("اعتراضات") && t.includes("لطيفة"));
const c = playbookText(shop, "wa_campaigns", "لطيفة", "2026-10-19");
check("دليل الحملات فيه الأفكار وما يسأله الناس", c.includes("أفكار حملات") && c.includes("ما يسأل عنه الناس"));
check("دليل فارغ لا يُكتب", playbookText({ questions: [], objections: [], works: [], avoid: [], campaignIdeas: [] }, "sales", "x", "d") === "");

const pr = chatLeadPrompt("jewelry", "فلوريت", "");
check("برمبت المحل يمنع السعر والتحبّب", pr.includes("ممنوع أي سعر أو وزن") && pr.includes("صاحبتي"));
check("برمبت المحاسبة بلا قاعدة المحل", !chatLeadPrompt("accounting", "بروكاونت", "").includes("محل ذهب"));
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
