// The email path, against the real tables for user 1 and without a model or a
// mail server: English is the only language that goes out, a draft carries
// its four follow-ups, and the open-rate checkpoint holds the rest of a
// campaign whose test slice nobody opened — then tries new subjects on a fresh
// slice — while a healthy test releases the rest as before.

import { and, eq, inArray, like } from "drizzle-orm";
import { db, emailCampaignsTable, emailMessagesTable } from "@workspace/db";
import { isEnglish } from "../email/language";
import { parseDraft } from "../email/agent";
import { decideAbTests, retestHeld, startCampaign } from "../email/service";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };
async function clean() {
  const cs = await db.select({ id: emailCampaignsTable.id }).from(emailCampaignsTable).where(and(eq(emailCampaignsTable.userId, USER), like(emailCampaignsTable.name, "flow-test%")));
  if (cs.length) { await db.delete(emailMessagesTable).where(inArray(emailMessagesTable.campaignId, cs.map((c) => c.id))); await db.delete(emailCampaignsTable).where(inArray(emailCampaignsTable.id, cs.map((c) => c.id))); }
}
await clean();

// ── English ──────────────────────────────────────────────────────
check("an English email is English", isEnglish("<p>Hello {{first_name|there}}, is {{company|your agency}} ready?</p>"));
check("...even naming an Arabic company", isEnglish("<p>Hello team at شركة النور, your AML framework needs a review this quarter.</p>"));
check("an Arabic email is not", !isEnglish("<p>مرحباً فريق {{company|شركتكم}}، هل إطار AML لديكم جاهز؟</p>"));
let refused = "";
const [arc] = await db.insert(emailCampaignsTable).values({ userId: USER, name: "flow-test arabic", subject: "عنوان", html: "<p>رسالة بالعربية كاملة للعميل</p>", status: "draft", listId: null } as any).returning();
try { await startCampaign(USER, arc!.id); } catch (e: any) { refused = e.message; }
check("an Arabic campaign is refused at send", refused.includes("بالإنجليزية"), refused.slice(0, 40));

// ── The four follow-ups ──────────────────────────────────────────
const d = parseDraft(`[عنوان] A subject\n[عنوان] B subject\n[الرسالة]\nHello,\n\nBody.\n[/الرسالة]\n[متابعة بعد=72 جمهور=دافئ]\nعنوان: warm s\nwarm body\n[/متابعة]\n[متابعة بعد=72 جمهور=بارد]\nعنوان: cold s\ncold body\n[/متابعة]\n[متابعة بعد=168 جمهور=قيمة]\nعنوان: value s\nvalue body\n[/متابعة]\n[متابعة بعد=336 جمهور=وداع]\nعنوان: bye s\nbye body\n[/متابعة]\n[السبب] x`);
check("a draft carries all four follow-ups", d?.followups.map((f) => f.audience).join() === "warm,cold,value,breakup", d?.followups.map((f) => f.audience).join());

// ── The checkpoint ───────────────────────────────────────────────
async function campaign(name: string, aOpen: number, bOpen: number) {
  const [c] = await db.insert(emailCampaignsTable).values({ userId: USER, name, subject: "Subject A", subjectB: "Subject B", html: "<p>Hello</p>", status: "sending", abPct: 20, abWaitHours: 24 } as any).returning();
  const day = new Date(Date.now() - 30 * 3_600_000);
  const rows: any[] = [];
  for (let i = 0; i < 30; i++) rows.push({ userId: USER, campaignId: c!.id, toEmail: `a${i}@x.ae`, subject: "Subject A", token: `flow-${c!.id}-a${i}`, status: "sent", variant: "A", sentAt: day, openedAt: i < aOpen ? day : null });
  for (let i = 0; i < 30; i++) rows.push({ userId: USER, campaignId: c!.id, toEmail: `b${i}@x.ae`, subject: "Subject B", token: `flow-${c!.id}-b${i}`, status: "sent", variant: "B", sentAt: day, openedAt: i < bOpen ? day : null });
  for (let i = 0; i < 100; i++) rows.push({ userId: USER, campaignId: c!.id, toEmail: `h${i}@x.ae`, subject: "Subject A", token: `flow-${c!.id}-h${i}`, status: "ab_hold" });
  await db.insert(emailMessagesTable).values(rows);
  return c!;
}
const statusOf = async (id: number) => (await db.select().from(emailCampaignsTable).where(eq(emailCampaignsTable.id, id)))[0]!;
const held = async (id: number) => (await db.select({ id: emailMessagesTable.id }).from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, id), eq(emailMessagesTable.status, "ab_hold")))).length;

const low = await campaign("flow-test low", 1, 2);
await decideAbTests(new Date(), { tracking: async () => true, onlyCampaignIds: [low.id] });
const lowAfter = await statusOf(low.id);
check("almost nobody opened: the rest is held, not released", lowAfter.status === "paused" && !!lowAfter.lowOpenAt && (await held(low.id)) === 100, `${lowAfter.status} held=${await held(low.id)}`);
check("...and the reason says the open rate", (lowAfter.pauseReason ?? "").includes("7%"), lowAfter.pauseReason ?? "");

const r = await retestHeld(low.id, "New subject A", "New subject B");
const retest = await statusOf(low.id);
check("new subjects go to a fresh slice of the held", r.slice === 20 && (await held(low.id)) === 80 && retest.status === "sending" && retest.abRound === 1, `${r.slice}/${r.held} round=${retest.abRound}`);
const q = await db.select().from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, low.id), eq(emailMessagesTable.status, "queued")));
check("...split between the two new subjects", q.filter((m) => m.subject === "New subject A").length === 10 && q.filter((m) => m.subject === "New subject B").length === 10);

const good = await campaign("flow-test good", 6, 12);
await decideAbTests(new Date(), { tracking: async () => true, onlyCampaignIds: [good.id] });
const goodAfter = await statusOf(good.id);
check("a healthy test picks the winner and releases the rest", goodAfter.abWinner === "B" && (await held(good.id)) === 0, `${goodAfter.abWinner}`);

const blind = await campaign("flow-test blind", 0, 0);
await decideAbTests(new Date(), { tracking: async () => false, onlyCampaignIds: [blind.id] });
check("without open tracking the checkpoint cannot judge: it releases", (await held(blind.id)) === 0 && (await statusOf(blind.id)).status === "sending");

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
