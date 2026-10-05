// The email flows against the real tables, for user 1: a list queued into a
// campaign, a subject test held and released, a sequence enrolled and
// cancelled by a reply, a bounce and an unsubscribe recorded, a reply
// matched to the message it answers.

import { and, eq, inArray } from "drizzle-orm";
import {
  db, emailSettingsTable, emailContactsTable, emailListsTable, emailListMembersTable, emailCampaignsTable,
  emailSequencesTable, emailSequenceJobsTable, emailMessagesTable, emailEventsTable, emailInboundTable,
} from "@workspace/db";
import { startCampaign, enrolInSequence, recordEvent, decideAbTests, enqueueDueSequenceSteps } from "../email/service";
import { handleInbound } from "../email/inbound";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

async function clean() {
  await db.delete(emailInboundTable).where(eq(emailInboundTable.userId, USER));
  await db.delete(emailEventsTable).where(eq(emailEventsTable.userId, USER));
  await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
  await db.delete(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.userId, USER));
  await db.delete(emailSequencesTable).where(eq(emailSequencesTable.userId, USER));
  await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
  await db.delete(emailListsTable).where(eq(emailListsTable.userId, USER));
  await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));
}
await clean();

// A configured sender that nothing will actually send through in this test.
await db.insert(emailSettingsTable).values({ userId: USER, provider: "smtp", smtpHost: "smtp.invalid", smtpUser: "u", smtpPass: "p", fromEmail: "test@procount.invalid", fromName: "بروكاونت" });

const contacts = await db.insert(emailContactsTable).values(
  Array.from({ length: 60 }, (_, i) => ({ userId: USER, email: `c${i}@firm${i}.ae`, company: `شركة ${i}`, status: i === 0 ? "unsubscribed" : "active", mxOk: i === 1 ? false : true })),
).returning();
const [list] = await db.insert(emailListsTable).values({ userId: USER, name: "اختبار" }).returning();
await db.insert(emailListMembersTable).values(contacts.map((c) => ({ listId: list!.id, contactId: c.id })));

// ── A campaign ───────────────────────────────────────────────────
const [camp] = await db.insert(emailCampaignsTable).values({ userId: USER, name: "حملة", listId: list!.id, subject: "Subject A", html: "<p>x</p>" }).returning();
let r = await startCampaign(USER, camp!.id);
check("the unsubscribed and the dead domain are skipped", r.queued === 58 && r.skipped === 2, `${r.queued}/${r.skipped}`);
r = await startCampaign(USER, camp!.id);
check("starting again does not double up", r.queued === 0);

// ── A subject test ───────────────────────────────────────────────
const [ab] = await db.insert(emailCampaignsTable).values({ userId: USER, name: "اختبار عنوان", listId: list!.id, subject: "A", subjectB: "B", abPct: 20, abWaitHours: 1, html: "<p>x</p>" }).returning();
await startCampaign(USER, ab!.id);
const abMsgs = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, ab!.id));
const nA = abMsgs.filter((m) => m.variant === "A").length, nB = abMsgs.filter((m) => m.variant === "B").length, held = abMsgs.filter((m) => m.status === "ab_hold").length;
check("the test slice is split and the rest held", nA === 10 && nB === 10 && held === 38, `${nA}/${nB}/${held}`);
check("B carries the other subject", abMsgs.filter((m) => m.variant === "B").every((m) => m.subject === "B"));
// Pretend the slice went out two hours ago and B was opened more.
const past = new Date(Date.now() - 2 * 3_600_000);
await db.update(emailMessagesTable).set({ status: "sent", sentAt: past }).where(and(eq(emailMessagesTable.campaignId, ab!.id), inArray(emailMessagesTable.variant, ["A", "B"])));
const bIds = abMsgs.filter((m) => m.variant === "B").slice(0, 4).map((m) => m.id);
await db.update(emailMessagesTable).set({ openedAt: past }).where(inArray(emailMessagesTable.id, bIds));
await db.update(emailCampaignsTable).set({ status: "sending" }).where(eq(emailCampaignsTable.id, ab!.id));
check("the test is decided", (await decideAbTests()) >= 1);
const [abAfter] = await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, ab!.id));
const released = await db.select().from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, ab!.id), eq(emailMessagesTable.status, "queued")));
check("...B wins", abAfter?.abWinner === "B");
check("...and the held rest is released under B's subject", released.length === 38 && released.every((m) => m.subject === "B"));

// ── A sequence ───────────────────────────────────────────────────
const [seq] = await db.insert(emailSequencesTable).values({ userId: USER, name: "متابعة", steps: [
  { afterHours: 0, subject: "مرحبا {{company}}", html: "<p>1</p>" }, { afterHours: 72, subject: "ثانية", html: "<p>2</p>" },
] }).returning();
const e = await enrolInSequence(USER, seq!.id, contacts.slice(0, 5).map((c) => c.id));
check("enrolment skips the unsubscribed and the dead domain", e.enrolled === 3 && e.skipped === 2, `${e.enrolled}/${e.skipped}`);
const again = await enrolInSequence(USER, seq!.id, contacts.slice(2, 5).map((c) => c.id));
check("someone already on the ladder is not enrolled twice", again.enrolled === 0);
// Make the first rungs due.
await db.update(emailSequenceJobsTable).set({ dueAt: new Date(Date.now() - 60_000) }).where(and(eq(emailSequenceJobsTable.sequenceId, seq!.id), eq(emailSequenceJobsTable.stepIndex, 0)));
check("due rungs become queued messages", (await enqueueDueSequenceSteps(new Date(), USER)) === 3);
const [rung] = await db.select().from(emailMessagesTable).where(and(eq(emailMessagesTable.contactId, contacts[2]!.id), inArray(emailMessagesTable.sequenceJobId, db.select({ id: emailSequenceJobsTable.id }).from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.sequenceId, seq!.id)))));
check("...with the subject personalised", rung?.subject === "مرحبا شركة 2", rung?.subject);

// ── Events ───────────────────────────────────────────────────────
const [m0] = await db.select().from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, camp!.id), eq(emailMessagesTable.contactId, contacts[3]!.id)));
await db.update(emailMessagesTable).set({ status: "sent", sentAt: new Date(), messageIdHdr: "<abc@procount.invalid>" }).where(eq(emailMessagesTable.id, m0!.id));
await recordEvent(USER, m0!.id, "open"); await recordEvent(USER, m0!.id, "open");
const [c1] = await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, camp!.id));
const [m0b] = await db.select().from(emailMessagesTable).where(eq(emailMessagesTable.id, m0!.id));
check("two opens count twice on the message, once on the campaign", m0b?.openCount === 2 && c1?.openCount === 1);

// A reply, matched by In-Reply-To, ends the ladder for that contact.
const rep = await handleInbound(USER, { from: contacts[3]!.email, subject: "Re: العنوان أ", text: "مهتمين، كم التكلفة؟\n\nOn Mon wrote:\n> العنوان", inReplyTo: "<abc@procount.invalid>" });
check("the reply is filed", !!rep && !rep.bounce);
const [inb] = await db.select().from(emailInboundTable).where(eq(emailInboundTable.userId, USER));
check("...with the quoted original stripped", inb?.text === "مهتمين، كم التكلفة؟", JSON.stringify(inb?.text));
check("...matched to our message", inb?.messageId === m0!.id);
const cancelled = await db.select().from(emailSequenceJobsTable).where(and(eq(emailSequenceJobsTable.contactId, contacts[3]!.id), eq(emailSequenceJobsTable.status, "cancelled")));
check("...and the contact's pending rungs are cancelled", cancelled.length >= 1);

// A bounce from the daemon marks the address.
await handleInbound(USER, { from: "MAILER-DAEMON@mx.invalid", subject: "Delivery Status Notification (Failure)", text: `Your message to ${contacts[4]!.email} could not be delivered.` });
const [bounced] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, contacts[4]!.id));
check("a daemon bounce marks the contact bounced", bounced?.status === "bounced");
check("...and is not filed as a reply", (await db.select().from(emailInboundTable).where(eq(emailInboundTable.fromEmail, "mailer-daemon@mx.invalid"))).length === 0);

// An unsubscribe reply.
await handleInbound(USER, { from: contacts[5]!.email, subject: "Re: x", text: "الغاء الاشتراك" });
const [unsub] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, contacts[5]!.id));
check("'إلغاء الاشتراك' by reply unsubscribes", unsub?.status === "unsubscribed", unsub?.status);

// An auto-reply is not a reply.
const auto = await handleInbound(USER, { from: contacts[6]!.email, subject: "Automatic reply: العنوان", text: "I am out of office" });
check("an out-of-office is ignored", auto === null);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
