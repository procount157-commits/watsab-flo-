// Deals, proposals and meetings, against the real tables for user 1 and
// without a model or a mail server: one company is one deal across channels;
// a deal only moves forward on its own; free times respect the owner's hours,
// the notice, the buffer and what is booked, in Gulf time; a link booking
// takes only a free time and moves the deal to a meeting; the reminder goes
// once; and a proposal with a blank or an unknown number cannot go out.

export {};
const { and, eq } = await import("drizzle-orm");
const { db, dealsTable, clientMeetingsTable, meetingSettingsTable, proposalsTable, socialThreadsTable, socialMessagesTable } = await import("@workspace/db");
const { openDeal, advance, timeline, pipeline } = await import("../deals/deals");
const { freeSlots, spread, settingsFor, availableSlots, book, remindMeetings, ics, slotLabel } = await import("../deals/meetings");
const { issuesOf, sendProposal, setOutcome } = await import("../deals/proposals");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  await db.delete(clientMeetingsTable).where(eq(clientMeetingsTable.userId, USER));
  await db.delete(dealsTable).where(eq(dealsTable.userId, USER));
  await db.delete(meetingSettingsTable).where(eq(meetingSettingsTable.userId, USER));
  await db.delete(socialThreadsTable).where(and(eq(socialThreadsTable.userId, USER), eq(socialThreadsTable.handle, "deal.test.handle")));
}
await clean();

// ── One company, one deal ────────────────────────────────────────
const a = await openDeal(USER, { channel: "whatsapp", ref: "971501234567", phone: "971501234567", company: "النور العقارية" });
const b = await openDeal(USER, { channel: "email", ref: "ceo@alnoor.ae", email: "ceo@alnoor.ae", phone: "+971 50 123 4567", contactName: "أحمد" });
check("a hot lead opens a deal", a.created && a.deal.stage === "lead");
check("the same company on another channel is the same deal", !b.created && b.deal.id === a.deal.id, `${a.deal.id}/${b.deal.id}`);
const [merged] = await db.select().from(dealsTable).where(eq(dealsTable.id, a.deal.id));
check("...and what the new channel knew is added", merged!.email === "ceo@alnoor.ae" && merged!.contactName === "أحمد" && merged!.company === "النور العقارية");
check("a different company is a different deal", (await openDeal(USER, { channel: "instagram", ref: "deal.test.handle", contactName: "Palm" })).created);
await advance(USER, a.deal.id, "proposal");
await advance(USER, a.deal.id, "meeting");
const [adv] = await db.select().from(dealsTable).where(eq(dealsTable.id, a.deal.id));
check("a deal only moves forward on its own", adv!.stage === "proposal");

const [thread] = await db.insert(socialThreadsTable).values({ userId: USER, platform: "instagram", handle: "deal.test.handle", origin: "outreach" }).returning();
await db.insert(socialMessagesTable).values([{ userId: USER, platform: "instagram", threadId: thread!.id, fromMe: true, text: "مرحباً، رأينا أنكم وسطاء في دبي", status: "sent", sentAt: new Date(Date.now() - 3_600_000) },
  { userId: USER, platform: "instagram", threadId: thread!.id, fromMe: false, text: "نعم مهتمين، كم التكلفة؟", status: "received" }]);
const [palm] = await db.select().from(dealsTable).where(and(eq(dealsTable.userId, USER), eq(dealsTable.ref, "deal.test.handle")));
const tl = await timeline(USER, palm!);
check("the deal's history reads the channel's messages, in order", tl.length === 2 && tl[0]!.fromUs && !tl[1]!.fromUs);

// ── Free times ───────────────────────────────────────────────────
// Monday 6 Oct 2026, 05:00 Gulf (01:00 UTC). Hours Mon 10:00–12:00, 30 min + 15 buffer, 3 h notice.
const s = { slots: [{ dow: 1, from: "10:00", to: "12:00" }], durationMin: 30, bufferMin: 15, noticeHours: 3 };
const from = new Date("2026-10-05T01:00:00Z");
const free = freeSlots(s, [], from, 1);
check("free times follow the owner's hours in Gulf time, the last one ending at closing", free.map((d) => d.toISOString().slice(11, 16)).join(",") === "06:00,06:45,07:30", free.map((d) => d.toISOString()).join(","));
check("...not inside the notice period", freeSlots(s, [], new Date("2026-10-05T05:00:00Z"), 1).length === 0);
const clash = freeSlots(s, [{ startsAt: new Date("2026-10-05T06:20:00Z"), durationMin: 30 }], from, 1);
check("a booked meeting and its buffer take the times around it", clash.map((d) => d.toISOString().slice(11, 16)).join(",") === "07:30", clash.map((d) => d.toISOString()).join(","));
check("a day the owner does not work has no times", freeSlots(s, [], new Date("2026-10-06T01:00:00Z"), 1).length === 0);
const sp = spread([new Date("2026-10-05T06:00:00Z"), new Date("2026-10-05T06:45:00Z"), new Date("2026-10-06T06:00:00Z"), new Date("2026-10-07T06:00:00Z")], 3);
check("offered times are spread over days", sp.length === 3 && new Set(sp.map((d) => d.toISOString().slice(0, 10))).size === 3);
check("a time reads in Gulf time", slotLabel(new Date("2026-10-05T06:00:00Z"), "en").includes("10:00"));

// ── Booking ──────────────────────────────────────────────────────
const st = await settingsFor(USER);
check("every owner gets a booking link token", /^[a-f0-9]{36}$/.test(st.bookingToken));
await db.update(meetingSettingsTable).set({ slots: [1, 2, 3, 4, 5, 6, 7].map((dow) => ({ dow, from: "00:00", to: "23:59" })), noticeHours: 1 }).where(eq(meetingSettingsTable.userId, USER));
const avail = await availableSlots(USER, 3, 10);
let refused = "";
try { await book(USER, { name: "x", email: "x@x.ae", startsAt: new Date(avail[0]!.getTime() + 7 * 60_000), source: "link" }); } catch (e: any) { refused = e.message; }
check("a link booking takes only a time on offer", /لم يعد متاحاً/.test(refused));
const m = await book(USER, { name: "أحمد", company: "النور العقارية", email: "ceo@alnoor.ae", startsAt: avail[0]!, topic: "ضريبة الشركات", source: "link" });
const [afterBook] = await db.select().from(dealsTable).where(eq(dealsTable.id, m.dealId!));
check("the booking lands on the company's existing deal", m.dealId === a.deal.id && afterBook!.stage === "proposal" && !!afterBook!.nextAt);
try { await book(USER, { name: "y", email: "y@y.ae", startsAt: avail[0]!, source: "link" }); refused = ""; } catch (e: any) { refused = e.message; }
check("the same time cannot be booked twice", /لم يعد متاحاً/.test(refused));
await db.update(clientMeetingsTable).set({ startsAt: new Date(Date.now() + 10 * 60_000) }).where(eq(clientMeetingsTable.id, m.id));
const r1 = await remindMeetings(new Date(), USER), r2 = await remindMeetings(new Date(), USER);
check("the reminder before a meeting goes once", r1 === 1 && r2 === 0);
const cal = ics({ ...m, startsAt: new Date("2026-10-05T06:00:00Z") }, "Flow Hub");
check("the calendar file has the meeting's time", cal.includes("DTSTART:20261005T060000Z") && cal.includes("DTEND:20261005T063000Z") && cal.includes("BEGIN:VEVENT"));

// ── Proposals ────────────────────────────────────────────────────
const iss = issuesOf("<p>الرسوم: [[السعر]] شهرياً، وغرامة التأخير 10,000 درهم</p>", "خدمة مسك الدفاتر الشهرية");
check("a blank and an unknown number are both caught", iss.some((x) => x.includes("[[السعر]]")) && iss.some((x) => x.includes("10,000")), iss.join(" | "));
check("a clean proposal has no issues", issuesOf("<p>We will keep your books monthly.</p>", "").length === 0);
const [prop] = await db.insert(proposalsTable).values({ userId: USER, dealId: a.deal.id, title: "عرض", html: "<p>الرسوم: [[السعر]]</p>" }).returning();
try { await sendProposal(USER, prop!.id, { to: "ceo@alnoor.ae" }); refused = ""; } catch (e: any) { refused = e.message; }
check("a proposal with a blank cannot be sent", /خانات لم تُملأ/.test(refused));
await setOutcome(USER, prop!.id, "accepted");
const [won] = await db.select().from(dealsTable).where(eq(dealsTable.id, a.deal.id));
check("an accepted proposal wins the deal", won!.stage === "won" && !!won!.wonAt);
const pl = await pipeline(USER);
check("the pipeline counts by stage", pl.totals.won.n === 1 && pl.won30.n === 1);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
