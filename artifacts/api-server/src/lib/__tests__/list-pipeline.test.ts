// Upload a list, the team does the rest: سلمى's recommendations from the
// numbers, the problems she names, and the order of the chain.

export {};
const { recommend, problemsOf, MAX_RECOMMENDED } = await import("../email/pipeline");
const { charterOf } = await import("../roles/charters");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

const recs = recommend([
  { sector: "سياحة وسفر", n: 900 },
  { sector: "عقارات", n: 600 },
  { sector: "ذهب ومجوهرات", n: 40 },
  { sector: "مقاولات", n: 30 },
  { sector: "تقنية", n: 9 },
]);
check("at most three recommendations", recs.length === MAX_RECOMMENDED);
check("a sector with a written campaign outranks a bigger one without", recs[0]!.sector === "عقارات" && recs[1]!.sector === "سياحة وسفر", recs.map((r) => r.sector).join(" > "));
check("each carries its campaign and why", recs.every((r) => r.goal.length > 20 && r.why.length > 10 && r.angle.length > 3));
check("too small a sector gets no campaign", !recommend([{ sector: "تقنية", n: 9 }]).length);
check("the real-estate recommendation is the AML campaign", recs.find((r) => r.sector === "عقارات")!.goal.includes("AML"));

const base = { total: 1000, sendable: 900, deadDomain: 40, risk: { low: 800, medium: 100, high: 25 }, overlap: [{ listId: 7, name: "ALL", shared: 950 }], alreadyWritten: 600, role: 800 };
const p = problemsOf(base);
check("dead domains are named", p.some((x) => x.includes("40") && x.includes("خادم")));
check("high-risk addresses are named", p.some((x) => x.includes("25") && x.includes("الخطورة")));
check("a near-copy of another list is named", p.some((x) => x.includes("ALL")));
check("already written to, half or more, is named", p.some((x) => x.includes("600")));
check("mostly role addresses is named", p.some((x) => x.includes("info@")));
check("an empty list says so", problemsOf({ ...base, sendable: 0, deadDomain: 0, risk: { low: 0, medium: 0, high: 0 }, overlap: [], alreadyWritten: 0, role: 0 }).some((x) => x.includes("لا يوجد")));

check("سلمى's charter: analyse on upload, recommend, brief نورة", charterOf("email_strategist")!.when.includes("فور رفع") && charterOf("email_strategist")!.delivers.includes("موجز"));
check("طارق's charter: the approval card, then launch", charterOf("email_creator")!.delivers.includes("بطاقة موافقة") && charterOf("email_creator")!.mission.includes("بلا أن يختار"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
