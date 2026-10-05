// Sectors, segments, نورة's drafts, and a mission from approval to the
// follow-up split — against the real tables for user 1, with no model call:
// the draft is supplied, the way the owner's approval supplies it.

import { and, eq, inArray, like } from "drizzle-orm";
import {
  db, emailSettingsTable, emailContactsTable, emailListsTable, emailListMembersTable, emailCampaignsTable, emailSegmentsTable,
  emailSequencesTable, emailSequenceJobsTable, emailMessagesTable, emailEventsTable, emailInboundTable, emailMissionsTable, agentMemoryTable,
} from "@workspace/db";
import { classifySector } from "../email/sector";
import { parseDraft, toHtml, rememberKnowledge, brief, rememberLesson } from "../email/agent";
import { cleanFilter, count, facets, describe, resolve } from "../email/segments";
import { createMission, approve, runMission } from "../email/missions";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

// ── Sectors, from names on the owner's own list ──────────────────
const s = (company: string, extra: any = {}) => classifySector({ company, ...extra });
check("…Real Estate", s("Zahrat Al Orchid Real Estate") === "عقارات");
check("…PROPERTIES", s("DCODE PROPERTIES") === "عقارات");
check("…VACATION HOMES RENTAL", s("ARAMI VACATION HOMES RENTAL CO. L.L.C") === "عقارات");
check("Contracting", s("Al Noor General Contracting LLC") === "مقاولات");
check("building materials before contracting", s("Emirates Building Materials Trading") === "مواد بناء");
check("foodstuff before general trading", s("Gulf Foodstuff Trading") === "أغذية");
check("general trading", s("Star General Trading LLC") === "تجارة عامة");
check("Arabic: مؤسسة للمقاولات", s("مؤسسة النور للمقاولات العامة") === "مقاولات");
check("gold", s("Malabar Gold & Diamonds") === "ذهب ومجوهرات");
check("auditing", s("ABC Chartered Accountants & Auditors") === "محاسبة وتدقيق");
check("activity column wins over the name", classifySector({ company: "Al Noor Properties", industry: "Restaurant" }) === "مطاعم ومقاهي");
check("the file name is a last hint", classifySector({ company: "Ahmed Mohamed Ahmed Abdelgawad Shaftar", hint: "real-estate-companies-ALL" }) === "عقارات");
check("nothing to go on is unclassified", classifySector({ company: "Zelin" }) === null);

// ── Drafts ───────────────────────────────────────────────────────
const raw = `[عنوان] {{company|شركتكم}} ومتطلبات مكافحة غسل الأموال
[عنوان] سؤال عن مسؤول الامتثال لديكم
[الرسالة]
{{first_name|أهلاً}}،

الوسطاء العقاريون ملزمون **بالتسجيل**.
- تقييم مخاطر
- مسؤول امتثال

هل لديكم مسؤول امتثال؟
{{sender}}
[/الرسالة]
[متابعة بعد=72 جمهور=دافئ]
عنوان: مثال من وسيط في دبي
قصة قصيرة.
[/متابعة]
[متابعة بعد=96 جمهور=بارد]
عنوان: سؤال واحد
أقصر.
[/متابعة]
[السبب] الوسطاء يعرفون الالتزام ولا يعرفون من يطبّقه.`;
const d = parseDraft(raw)!;
check("two subjects", d.subjects.length === 2 && d.subjects[1] === "سؤال عن مسؤول الامتثال لديكم");
check("the body becomes HTML with bold and a list", d.html.includes("<b>بالتسجيل</b>") && d.html.includes("<li") && d.html.includes("{{first_name|أهلاً}}"));
check("a warm and a cold follow-up", d.followups.length === 2 && d.followups[0]!.audience === "warm" && d.followups[1]!.audience === "cold" && d.followups[1]!.afterHours === 96);
check("the reason", /الوسطاء/.test(d.why));
check("a draft without a body is refused", parseDraft("[عنوان] x") === null);
check("HTML is escaped", toHtml("<script>x</script>").includes("&lt;script&gt;"));

// ── Setup ────────────────────────────────────────────────────────
async function clean() {
  await db.delete(emailMissionsTable).where(eq(emailMissionsTable.userId, USER));
  await db.delete(emailInboundTable).where(eq(emailInboundTable.userId, USER));
  await db.delete(emailEventsTable).where(eq(emailEventsTable.userId, USER));
  await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
  await db.delete(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.userId, USER));
  await db.delete(emailSequencesTable).where(eq(emailSequencesTable.userId, USER));
  await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
  await db.delete(emailSegmentsTable).where(eq(emailSegmentsTable.userId, USER));
  await db.delete(emailListsTable).where(eq(emailListsTable.userId, USER));
  await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), eq(agentMemoryTable.role, "email")));
}
await clean();
await db.insert(emailSettingsTable).values({ userId: USER, provider: "smtp", smtpHost: "smtp.invalid", smtpUser: "u", smtpPass: "p", fromEmail: "t@procount.invalid" });
const rows = [
  ...Array.from({ length: 30 }, (_, i) => ({ userId: USER, email: `re${i}@x.ae`, company: `RE ${i} Real Estate`, sector: "عقارات", city: i < 20 ? "Dubai" : "Ajman" })),
  ...Array.from({ length: 12 }, (_, i) => ({ userId: USER, email: `co${i}@x.ae`, company: `CO ${i} Contracting`, sector: "مقاولات", city: "Dubai", phone: "971500000000" })),
  { userId: USER, email: "none@x.ae", company: "Zelin", sector: null, city: "Dubai" },
  { userId: USER, email: "gone@x.ae", company: "Gone Real Estate", sector: "عقارات", city: "Dubai", status: "unsubscribed" },
];
await db.insert(emailContactsTable).values(rows as any);

// ── Segments ─────────────────────────────────────────────────────
const re = cleanFilter({ sectors: ["عقارات"] });
check("a sector selects its companies", (await count(USER, re)) === 31);
check("...and only the sendable ones when sending", (await count(USER, re, true)) === 30);
check("sector and city together", (await count(USER, cleanFilter({ sectors: ["عقارات"], cities: ["Dubai"] }))) === 21);
check("unclassified is selectable", (await count(USER, cleanFilter({ sectors: ["غير مصنف"] }))) === 1);
check("has a WhatsApp number", (await count(USER, cleanFilter({ hasPhone: true }))) === 12);
const fc = await facets(USER, cleanFilter({ cities: ["Ajman"] }));
check("facet counts respect the other filters", fc.sectors.find((x) => x.key === "عقارات")?.n === 10 && !fc.sectors.some((x) => x.key === "مقاولات"), JSON.stringify(fc.sectors));
check("...but not their own", fc.cities.find((x) => x.key === "Dubai")?.n === 34, `${fc.cities.find((x) => x.key === "Dubai")?.n}`);
check("a filter in words", describe(cleanFilter({ sectors: ["عقارات"], cities: ["Dubai"] })) === "عقارات · في Dubai");
check("junk in a filter is dropped", Object.keys(cleanFilter({ engagement: ["nonsense"], sectors: "x" })).length === 0);

// ── What she knows ───────────────────────────────────────────────
await rememberKnowledge(USER, "الوسطاء العقاريون من الجهات الملزمة بالتسجيل.", "عقارات");
await rememberKnowledge(USER, "المقاولون يهتمون بتدفق المستخلصات.", "مقاولات");
await rememberKnowledge(USER, "بروكاونت تقدّم خدمة مسؤول الامتثال بالإنابة.", null);
await rememberLesson(USER, "win", "عنوان فاز: «سؤال عن مسؤول الامتثال لديكم»", "عقارات");
const b = await brief(USER, ["عقارات"]);
check("her brief for real estate holds its own knowledge and the general", b.includes("الوسطاء العقاريون") && b.includes("بالإنابة"));
check("...not another sector's", !b.includes("المستخلصات"));
check("...and what won before", b.includes("سؤال عن مسؤول الامتثال"));

// ── A mission, from approval to the follow-up split ──────────────
const m = await createMission(USER, { name: "AML — عقارات", goal: "تعريف بخدمة الامتثال", filter: re });
// Email goes out in English: the approved draft is the English one.
const en = { ...d, subjects: ["Is {{company|your agency}} ready for an AML inspection?", "A question about your compliance officer"],
  html: "<p>Hello {{first_name|there}},</p><p>Real estate brokers are among the businesses supervised for AML. Do you have a compliance officer in place?</p>",
  followups: d.followups.map((f) => ({ ...f, subject: `A follow-up for {{company|your team}} (${f.audience})`, html: "<p>A short follow-up for your team.</p>" })) };
await db.update(emailMissionsTable).set({ stage: "awaiting_approval", pending: en as any }).where(eq(emailMissionsTable.id, m.id));
await approve(USER, m.id);
let [mm] = await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, m.id));
check("approval launches the campaign", mm!.stage === "sending" && !!mm!.campaignId && !!mm!.warmSequenceId && !!mm!.coldSequenceId);
const msgs = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, mm!.campaignId!));
check("the campaign reaches the segment's sendable companies", msgs.length === 30, `${msgs.length}`);
const [camp] = await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, mm!.campaignId!));
check("...by segment, testing no subject under 40", !!camp!.segmentId && camp!.abPct === 0 && camp!.createdBy === "agent");

// Pretend it all went out three days ago: 8 opened, 2 of them replied.
const past = new Date(Date.now() - 72 * 3_600_000);
await db.update(emailMessagesTable).set({ status: "sent", sentAt: past }).where(eq(emailMessagesTable.campaignId, camp!.id));
const ids = msgs.map((x) => x.id);
await db.update(emailMessagesTable).set({ openedAt: past }).where(inArray(emailMessagesTable.id, ids.slice(0, 8)));
await db.update(emailMessagesTable).set({ repliedAt: past }).where(inArray(emailMessagesTable.id, ids.slice(0, 2)));
await db.update(emailCampaignsTable).set({ status: "completed", completedAt: past }).where(eq(emailCampaignsTable.id, camp!.id));
[mm] = await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, m.id));
await runMission(mm!);
[mm] = await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, m.id));
check("after the wait it moves to following up", mm!.stage === "following_up");
const warm = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.sequenceId, mm!.warmSequenceId!));
const cold = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.sequenceId, mm!.coldSequenceId!));
check("openers who did not reply get the warm follow-up", warm.length === 6, `${warm.length}`);
check("non-openers get the cold one", cold.length === 22, `${cold.length}`);
check("repliers get neither", !warm.concat(cold).some((j) => msgs.slice(0, 2).some((x) => x.contactId === j.contactId)));

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
