// The company's knowledge read from all four sources at once, and the content
// calendar, against the real tables for user 1 and without a model: each
// source answers a question it knows; a source can be left out; the same fact
// in two places is said once; nothing comes back for a question no source
// knows; and a plan's calendar shows what each channel wrote.

export {};
const { and, eq, like } = await import("drizzle-orm");
const { db, knowledgeBaseTable, emailKnowledgeDocsTable, agentMemoryTable, waGroupKnowledgeTable, contentPlansTable, socialContentTable } = await import("@workspace/db");
const { companyKnowledge, knowledgeCounts, knowledgeLines } = await import("../company-knowledge");
const { calendar, deletePlan } = await import("../content/plans");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  await db.delete(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, USER), like(knowledgeBaseTable.title, "اختبار-موحد%")));
  await db.delete(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.userId, USER), like(emailKnowledgeDocsTable.title, "اختبار-موحد%")));
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), like(agentMemoryTable.content, "%اختبار-موحد%")));
  await db.delete(waGroupKnowledgeTable).where(and(eq(waGroupKnowledgeTable.userId, USER), like(waGroupKnowledgeTable.title, "اختبار-موحد%")));
  await db.delete(socialContentTable).where(and(eq(socialContentTable.userId, USER), like(socialContentTable.topic, "اختبار-موحد%")));
  await db.delete(contentPlansTable).where(and(eq(contentPlansTable.userId, USER), like(contentPlansTable.topic, "اختبار-موحد%")));
}
await clean();

await db.insert(knowledgeBaseTable).values({ userId: USER, title: "اختبار-موحد مسك الدفاتر", content: "خدمة مسك الدفاتر الشهرية تشمل تسوية الحسابات البنكية وإعداد التقارير الشهرية", keywords: "مسك الدفاتر, محاسبة شهرية" } as any);
await db.insert(emailKnowledgeDocsTable).values({ userId: USER, title: "اختبار-موحد قائمة الخدمات", category: "services", content: "Corporate tax registration support: we review the licence, the financial year and the registration deadline with the client before filing.", chars: 140, status: "ready" } as any);
await db.insert(agentMemoryTable).values({ userId: USER, role: "email", kind: "knowledge", content: "اختبار-موحد الوسطاء العقاريون ملزمون بتقييم مخاطر غسل الأموال لكل صفقة نقدية", topic: "AML عقارات" } as any);
await db.insert(waGroupKnowledgeTable).values({ userId: USER, kind: "text", source: "owner", title: "اختبار-موحد إجراءات الاستلام", content: "إجراءات استلام المستندات: يرسل العميل فواتير المشتريات والمبيعات قبل اليوم الخامس من كل شهر عبر القروب." });

const kb = await companyKnowledge(USER, "كم سعر مسك الدفاتر الشهرية؟");
check("the bot's knowledge answers what it knows", kb.some((k) => k.source === "kb" && k.title.includes("مسك الدفاتر")));
const docs = await companyKnowledge(USER, "corporate tax registration deadline licence");
check("the email documents answer what they know", docs.some((k) => k.source === "docs"));
const facts = await companyKnowledge(USER, "هل الوسطاء العقاريون ملزمون بتقييم مخاطر غسل الأموال؟");
check("the facts drawn from documents answer too", facts.some((k) => k.source === "facts"));
const groups = await companyKnowledge(USER, "متى يرسل العميل فواتير المشتريات والمبيعات؟");
check("what the owner taught the groups agent answers too", groups.some((k) => k.source === "groups"));
check("a source can be left out", !(await companyKnowledge(USER, "متى يرسل العميل فواتير المشتريات والمبيعات؟", { exclude: ["groups"] })).some((k) => k.source === "groups"));
check("a question nobody knows finds nothing", (await companyKnowledge(USER, "زرافة طائرة فوق المريخ")).length === 0);
await db.insert(waGroupKnowledgeTable).values({ userId: USER, kind: "text", source: "owner", title: "اختبار-موحد نسخة", content: "خدمة مسك الدفاتر الشهرية تشمل تسوية الحسابات البنكية وإعداد التقارير الشهرية" });
const dup = await companyKnowledge(USER, "خدمة مسك الدفاتر الشهرية تسوية الحسابات البنكية");
check("the same fact in two places is said once", dup.filter((k) => k.text.includes("تسوية الحسابات البنكية")).length === 1, dup.map((d) => d.source).join(","));
const lines = knowledgeLines(kb);
check("the prompt lines say where each came from", lines.includes("[معرفة البوت]") && lines.startsWith("من معرفة الشركة"));
const c = await knowledgeCounts(USER);
check("each source's size is counted", c.kb >= 1 && c.docs >= 1 && c.facts >= 1 && c.groups >= 2, JSON.stringify(c));

// ── The calendar ─────────────────────────────────────────────────
const [plan] = await db.insert(contentPlansTable).values({ userId: USER, topic: "اختبار-موحد تفتيش AML", publishOn: "2026-10-08", channels: ["linkedin", "tiktok"] }).returning();
await db.insert(socialContentTable).values([
  { userId: USER, platform: "linkedin", kind: "post", topic: "اختبار-موحد تفتيش AML", text: "What an AML inspector asks a broker for", planId: plan!.id },
  { userId: USER, platform: "tiktok", kind: "post", topic: "اختبار-موحد تفتيش AML", text: "الخطّاف: ...", planId: plan!.id, status: "published" },
]);
const cal = await calendar(USER, "2026-10-05", "2026-10-11");
const mine = cal.find((p: any) => p.id === plan!.id);
check("the week's calendar shows the plan with each channel's draft", !!mine && mine.items.length === 2 && mine.email === null);
check("...and a plan on another week is not in it", !(await calendar(USER, "2026-10-12", "2026-10-18")).some((p: any) => p.id === plan!.id));
await deletePlan(USER, plan!.id);
const left = await db.select().from(socialContentTable).where(and(eq(socialContentTable.userId, USER), like(socialContentTable.topic, "اختبار-موحد%")));
check("deleting a plan removes its drafts but keeps what was published", left.length === 1 && left[0]!.status === "published");

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
