export {};

// Training the groups agent and what she learns herself, against the real
// tables for user 1 and without a model: what the owner teaches is kept and
// checked; instructions always reach her and examples, passages and lessons
// only when they bear on what the customer wrote; a group's own training stays
// in that group; a lesson she already knows in other words is not kept twice;
// and his correction of a suggestion becomes an example.

const { and, eq, like } = await import("drizzle-orm");
const { db, waGroupsTable, waGroupMessagesTable, waGroupSuggestionsTable, waGroupKnowledgeTable, agentMemoryTable } = await import("@workspace/db");
const { teach, teachFile, briefFor, briefLines, passagesOf, parseLessons, keepLessons, learnFromGroup, listKnowledge, overlap } = await import("../groups/training");
const { feedback } = await import("../groups/assistant");

const USER = 1;
const G = "120363999000333444@g.us", OTHER = "120363999000555666@g.us";
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(62)} ${d}`); };
async function clean() {
  await db.delete(waGroupKnowledgeTable).where(eq(waGroupKnowledgeTable.userId, USER));
  for (const jid of [G, OTHER]) {
    await db.delete(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, USER), eq(waGroupMessagesTable.groupJid, jid)));
    await db.delete(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, USER), eq(waGroupSuggestionsTable.groupJid, jid)));
    await db.delete(waGroupsTable).where(and(eq(waGroupsTable.userId, USER), eq(waGroupsTable.jid, jid)));
  }
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), eq(agentMemoryTable.role, "groups"), like(agentMemoryTable.content, "%كشف حساب بنك%")));
}
await clean();

// ── Teaching ─────────────────────────────────────────────────────
const ins = await teach(USER, { kind: "instruction", content: "لا تعطي موعداً لتسليم الإقرار — قولي نراجع ونؤكد اليوم" });
check("an instruction is kept", ins.source === "owner" && ins.active && ins.groupJid === null);
let refused = "";
try { await teach(USER, { kind: "qa", question: "متى؟", answer: "" }); } catch (e: any) { refused = e.message; }
check("a question without its answer is refused", /الرد/.test(refused), refused);
try { await teach(USER, { kind: "bogus" as any, content: "x" }); refused = ""; } catch (e: any) { refused = e.message; }
check("an unknown kind is refused", !!refused);
await teach(USER, { kind: "qa", question: "ارسلوا لنا كشف حساب بنك الإمارات لشهر مارس", answer: "أكيد، نجهزه ونرسله لكم بكرة الصبح" });
await teach(USER, { kind: "qa", question: "كم رسوم التسجيل في ضريبة الشركات", answer: "نرسل لكم عرض السعر اليوم" });
await teach(USER, { kind: "text", title: "استلام المستندات", content: "إجراءات استلام المستندات: يرسل العميل الفواتير الشهرية قبل يوم ٥ من كل شهر، ونؤكد الاستلام في نفس اليوم، والكشوف البنكية تُطلب بصيغة PDF من البنك مباشرة." });
await teach(USER, { kind: "qa", groupJid: OTHER, question: "كشف حساب بنك المشرق", answer: "رد خاص بقروب آخر" });
const doc = await teachFile(USER, Buffer.from("Service sheet\n\nBookkeeping includes monthly bank reconciliation and VAT filing support.\n\nPayroll is not offered."), "services.txt");
check("a file is read and kept as a document", doc.kind === "document" && doc.title === "services.txt" && (doc.content ?? "").includes("reconciliation"));
let fileErr = "";
try { await teachFile(USER, Buffer.from("x"), "old.doc"); } catch (e: any) { fileErr = e.message; }
check("an unsupported file says why", /docx/.test(fileErr), fileErr.slice(0, 50));

// ── What reaches her ─────────────────────────────────────────────
const b = await briefFor(USER, G, "ممكن كشف حساب بنك الإمارات لشهر مارس؟");
check("instructions always come with her", b.instructions.some((t) => t.includes("الإقرار")));
check("the closest taught example comes too", b.examples.some((e) => e.a.includes("بكرة الصبح")));
check("...and an unrelated one does not", !b.examples.some((e) => e.a.includes("عرض السعر")));
check("another group's training stays in that group", !b.examples.some((e) => e.a.includes("قروب آخر")));
const b2 = await briefFor(USER, OTHER, "كشف حساب بنك المشرق لو سمحت");
check("...and reaches it there", b2.examples.some((e) => e.a.includes("قروب آخر")));
const b3 = await briefFor(USER, G, "متى نرسل الفواتير الشهرية؟");
check("a passage of pasted text is found by what was asked", b3.passages.some((p) => p.text.includes("قبل يوم ٥")));
const lines = briefLines(b).join("\n");
check("instructions are marked binding in the prompt", /ملزمة/.test(lines) && lines.indexOf("ملزمة") < lines.indexOf("أمثلة"));
const [usedRow] = await db.select().from(waGroupKnowledgeTable).where(eq(waGroupKnowledgeTable.id, ins.id));
check("what was put before her is counted", (usedRow?.used ?? 0) >= 3, `${usedRow?.used}`);
const listed = await listKnowledge(USER, { source: "owner" });
check("the list shows a file's size, not all of it", listed.some((x: any) => x.kind === "document" && x.chars > 0));

// ── Passages and lessons ─────────────────────────────────────────
const long = Array.from({ length: 30 }, (_, i) => `الفقرة ${i} فيها معلومة عن خدمة محاسبية مختلفة ومتطلباتها وما يحتاجه العميل.`).join("\n\n");
const ps = passagesOf(long);
check("a long text is cut into passages of a readable size", ps.length > 2 && ps.every((p) => p.length <= 1200), `${ps.length}`);
const parsed = parseLessons("[الملف]\nx\n[/الملف]\n[دروس]\n- صاحب العمل يطلب الكشوف بصيغة PDF من البنك مباشرة\n- <درس>\n- لا يوجد\n[/دروس]");
check("lessons are read from her answer, placeholders dropped", parsed.length === 1 && parsed[0]!.includes("PDF"), JSON.stringify(parsed));
const k1 = await keepLessons(USER, ["صاحب العمل يؤكد استلام المستندات في نفس اليوم دائماً"], []);
const k2 = await keepLessons(USER, ["صاحب العمل يؤكد استلام المستندات في نفس اليوم"], ["صاحب العمل يؤكد استلام المستندات في نفس اليوم دائماً"]);
check("a new lesson is kept, and the same lesson in other words is not", k1.length === 1 && k2.length === 0);
const b4 = await briefFor(USER, G, "وصلتكم المستندات؟");
check("what she learned reaches her when it bears on the message", b4.lessons.some((l) => l.includes("استلام المستندات")));
check("similarity is the same measure as the suggestions", overlap("كشف حساب", "ارسلوا كشف حساب البنك") === 1);

// ── Learning is paced ────────────────────────────────────────────
await db.insert(waGroupsTable).values({ userId: USER, jid: G, subject: "اختبار التدريب", watch: true, learnedAt: new Date(), learnedUpto: new Date(Date.now() - 3_600_000) } as any);
await db.insert(waGroupMessagesTable).values([
  { userId: USER, groupJid: G, messageId: "trn-1", fromMe: false, text: "السلام عليكم", msgType: "text", createdAt: new Date(Date.now() - 120_000) },
  { userId: USER, groupJid: G, messageId: "trn-2", fromMe: true, text: "وعليكم السلام", msgType: "text", createdAt: new Date(Date.now() - 60_000) },
]);
check("two new messages and a fresh reading: no model call yet", (await learnFromGroup(USER, G)) === null);

// ── His correction becomes an example ────────────────────────────
const [sug] = await db.insert(waGroupSuggestionsTable).values({ userId: USER, groupJid: G, triggerMessageId: "trn-1", triggerText: "نحتاج كشف حساب بنك أبوظبي الأول", suggestion: "حاضر", status: "pending" }).returning();
await feedback(USER, sug!.id, { verdict: "edited", text: "أكيد، أرسلوا لنا اسم الحساب والشهر ونجهزه اليوم" });
const ex = await briefFor(USER, G, "نبي كشف حساب بنك أبوظبي الأول");
check("an edited suggestion is shown to her as an example next time", ex.examples.some((e) => e.a.includes("اسم الحساب والشهر")));

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
