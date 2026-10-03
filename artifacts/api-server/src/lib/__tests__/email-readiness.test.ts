import { campaignReadiness } from "../email/readiness";
import {
  db, emailCampaignsTable, emailSettingsTable, emailContactsTable,
  emailListsTable, emailListMembersTable, emailMessagesTable,
} from "@workspace/db";
import { eq, like } from "drizzle-orm";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

async function clean() {
  await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
  await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
  await db.delete(emailListMembersTable).where(like(emailContactsTable.email, "ready-%")).catch(() => {});
  await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
  await db.delete(emailListsTable).where(eq(emailListsTable.userId, USER));
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));
}
await clean();

const GOOD_HTML = "<p>مرحباً {{company|فريقكم}}،</p><p>" + "نص كافٍ لرسالة بيع حقيقية تشرح المشكلة والحل. ".repeat(4) + "</p>";

async function makeCampaign(over: Partial<typeof emailCampaignsTable.$inferInsert> = {}) {
  const [c] = await db.insert(emailCampaignsTable).values({
    userId: USER, name: "اختبار", subject: "{{company|شركتكم}}: سؤال واحد", html: GOOD_HTML, status: "draft", ...over,
  } as any).returning();
  return c!;
}
async function makeList(contacts: Array<Partial<typeof emailContactsTable.$inferInsert>>) {
  const [l] = await db.insert(emailListsTable).values({ userId: USER, name: "قائمة" }).returning();
  for (const c of contacts) {
    const [row] = await db.insert(emailContactsTable).values({ userId: USER, status: "active", ...c } as any).returning();
    await db.insert(emailListMembersTable).values({ listId: l!.id, contactId: row!.id });
  }
  return l!;
}
const settings = () => db.insert(emailSettingsTable).values({
  userId: USER, provider: "smtp", smtpHost: "h", smtpUser: "u", smtpPass: "p", fromEmail: "a@b.ae", dailyCap: 300,
} as any);

// ── Nothing configured at all ────────────────────────────────────
let c = await makeCampaign({ subject: "", html: "" });
let r = (await campaignReadiness(USER, c.id))!;
check("حملة فارغة لا تُنشر", !r.canPublish);
check("...وتُسمّي كل مانع", ["settings", "subject", "body", "audience"].every((id) => r.checks.some((x) => x.id === id && x.state === "blocked")),
  r.checks.filter((x) => x.state === "blocked").map((x) => x.id).join(","));
check("...والحكم يذكرها بالاسم", /العنوان/.test(r.verdict) && /نص الرسالة/.test(r.verdict));
check("...ولكل مانع ما تفعله", r.checks.filter((x) => x.state === "blocked").every((x) => !!x.fix));

// ── The case the owner kept hitting ──────────────────────────────
await clean();
await settings();
let list = await makeList([
  { email: "ready-a@x.ae", status: "unsubscribed" },
  { email: "ready-b@x.ae", status: "unsubscribed" },
]);
c = await makeCampaign({ listId: list.id });
r = (await campaignReadiness(USER, c.id))!;
check("قائمة كل من فيها ملغٍ لا تُنشر", !r.canPublish, "هذا ما حدث فعلاً");
check("...ويُقال العدد لا «فشل»", /2/.test(r.checks.find((x) => x.id === "audience")!.detail));
check("...ويُسمّى السبب", r.skipReasons.some((s) => /ألغوا/.test(s.reason)));

// ── A domain that bounces everything ─────────────────────────────
await clean();
await settings();
list = await makeList([
  { email: "ready-ok@x.ae", mxOk: true },
  { email: "ready-dead@y.ae", mxOk: false },
]);
c = await makeCampaign({ listId: list.id });
r = (await campaignReadiness(USER, c.id))!;
check("من لا يستقبل بريداً يُستبعد مسبقاً", r.willSend === 1 && r.willSkip === 1);
check("...والحملة تُنشر رغم ذلك", r.canPublish);
check("...والحكم يقول كم ستصل", /1/.test(r.verdict));

// ── Already sent to everyone ─────────────────────────────────────
await clean();
await settings();
list = await makeList([{ email: "ready-done@x.ae", mxOk: true }]);
c = await makeCampaign({ listId: list.id });
const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.userId, USER));
await db.insert(emailMessagesTable).values({
  userId: USER, campaignId: c.id, contactId: contact!.id, toEmail: contact!.email,
  subject: "x", token: "t-ready-1", status: "sent",
} as any);
r = (await campaignReadiness(USER, c.id))!;
check("إعادة نشر حملة وصلت الجميع تُرفض", !r.canPublish);
check("...بسبب مفهوم لا غامض",
  /سابقاً/.test(r.checks.find((x) => x.id === "audience")!.detail));
check("...وتُقترح حملة جديدة", /حملة جديدة/.test(r.checks.find((x) => x.id === "audience")!.fix ?? ""));

// ── A campaign that is fine ──────────────────────────────────────
await clean();
await settings();
list = await makeList([{ email: "ready-1@x.ae", mxOk: true }, { email: "ready-2@x.ae", mxOk: null }]);
c = await makeCampaign({ listId: list.id });
r = (await campaignReadiness(USER, c.id))!;
check("حملة سليمة تُنشر", r.canPublish && r.willSend === 2);
check("...بلا موانع", r.checks.every((x) => x.state !== "blocked"));
check("...والشخصنة تُرصد", r.checks.find((x) => x.id === "personal")!.state === "ok");

// Unknown MX is not bad MX: never checked is not the same as known to bounce.
check("نطاق لم يُفحص لا يُعامل كميت", r.willSend === 2, "mxOk=null يُرسل له");

// ── The daily cap is a warning, not a blocker ────────────────────
await clean();
await settings();
list = await makeList(Array.from({ length: 5 }, (_, i) => ({ email: `ready-c${i}@x.ae`, mxOk: true })));
await db.update(emailSettingsTable).set({ dailyCap: 2 }).where(eq(emailSettingsTable.userId, USER));
c = await makeCampaign({ listId: list.id });
r = (await campaignReadiness(USER, c.id))!;
check("تجاوز الحصة اليومية لا يمنع النشر", r.canPublish);
check("...لكنه يقول كم يوماً", /3 أيام/.test(r.checks.find((x) => x.id === "cap")?.fix ?? ""),
  r.checks.find((x) => x.id === "cap")?.fix?.slice(0, 40));

// ── A message with no variables ──────────────────────────────────
await clean();
await settings();
list = await makeList([{ email: "ready-z@x.ae", mxOk: true }]);
c = await makeCampaign({ listId: list.id, subject: "عرض", html: "<p>" + "نص عام يصلح لأي شركة بلا استثناء. ".repeat(5) + "</p>" });
r = (await campaignReadiness(USER, c.id))!;
check("رسالة بلا شخصنة تُنبَّه لا تُمنع", r.canPublish && r.checks.find((x) => x.id === "personal")!.state === "warn");

check("حملة غير موجودة ترجع لا شيء", (await campaignReadiness(USER, 999999)) === null);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
