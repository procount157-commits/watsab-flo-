// تصنيفٌ تتسرّب منه الصفوف أسوأ من لا تصنيف: صاحب العمل يجمع الأعداد
// المعروضة فلا تساوي قائمته، فيفقد الثقة في كل رقمٍ في الصفحة. فأول
// فحصٍ هنا — وأهمّه — أن مجموع الحالات يساوي عدد الجهات بالضبط، وأن
// كل جهةٍ في حالةٍ واحدة لا اثنتين.

export {};
const { db, emailContactsTable, emailMessagesTable, emailInboundTable, emailCampaignsTable, emailSettingsTable } = await import("@workspace/db");
const { eq } = await import("drizzle-orm");
const { cohortCounts, cohortMembers, dataQuality, dataPicture, COHORTS } = await import("../email/cohorts");
const { retargetPlans } = await import("../email/retarget");
const { reconcile, repair } = await import("../email/ledger");
const { opensReport } = await import("../email/opens");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

const wipe = async () => {
  await db.delete(emailInboundTable).where(eq(emailInboundTable.userId, USER));
  await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
  await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
  await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
  await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));
};
await wipe();
await db.insert(emailSettingsTable).values({ userId: USER, provider: "smtp", smtpHost: "h", smtpUser: "u", smtpPass: "p", fromEmail: "info@procount.invalid", tracking: true, publicUrl: null } as any);
const [cam] = await db.insert(emailCampaignsTable).values({ userId: USER, name: "موجة", subject: "{{company}}: س", html: "<p>x</p>", status: "completed" } as any).returning();

const day = (n: number) => new Date(Date.now() - n * 86_400_000);
let tk = 0; const token = () => `ch-${Date.now()}-${++tk}`;

/** جهةٌ بحالةٍ مقصودة، لنتحقّق أن المحرّك يضعها حيث يجب. */
async function make(o: { email: string; company?: string | null; status?: string; mxOk?: boolean | null; quietUntil?: Date | null; sector?: string | null }) {
  const [c] = await db.insert(emailContactsTable).values({
    userId: USER, email: o.email, company: o.company === undefined ? "شركة" : o.company,
    status: o.status ?? "active", mxOk: o.mxOk === undefined ? true : o.mxOk,
    quietUntil: o.quietUntil ?? null, sector: o.sector === undefined ? "عقارات" : o.sector,
  } as any).returning();
  return c!;
}
const send = async (cid: number, to: string, o: Partial<{ opens: number; clicks: number; replied: Date; bounced: Date; status: string; sentAt: Date }> = {}) =>
  db.insert(emailMessagesTable).values({
    userId: USER, campaignId: cam!.id, contactId: cid, toEmail: to, subject: "س", token: token(),
    status: o.status ?? "sent", sentAt: o.status === "queued" ? null : (o.sentAt ?? day(5)),
    openCount: o.opens ?? 0, openedAt: o.opens ? day(4) : null,
    clickCount: o.clicks ?? 0, clickedAt: o.clicks ? day(4) : null,
    repliedAt: o.replied ?? null, bouncedAt: o.bounced ?? null,
  } as any);
const reply = async (cid: number, email: string, intent: string) => {
  await db.insert(emailInboundTable).values({ userId: USER, contactId: cid, fromEmail: email, subject: "ر", text: "ن", intent, kind: "reply", solicited: true } as any);
  await db.update(emailContactsTable).set({ lastRepliedAt: new Date() }).where(eq(emailContactsTable.id, cid));
};

// ── جهةٌ لكل حالةٍ متوقّعة ──
const fresh   = await make({ email: "fresh@a.invalid" });
const unchk   = await make({ email: "unchecked@b.invalid", mxOk: null });
const badDom  = await make({ email: "bad@c.invalid", mxOk: false });
const unsub   = await make({ email: "unsub@d.invalid", status: "unsubscribed" });
const bounced = await make({ email: "bounced@e.invalid", status: "bounced" });
const supp    = await make({ email: "supp@f.invalid", status: "suppressed" });
const truce   = await make({ email: "truce@g.invalid", quietUntil: new Date(Date.now() + 5 * 86_400_000) });
const one     = await make({ email: "one@h.invalid" });        await send(one.id, one.email);
const many    = await make({ email: "many@i.invalid" });       await send(many.id, many.email); await send(many.id, many.email);
const opened  = await make({ email: "opened@j.invalid" });     await send(opened.id, opened.email, { opens: 2 });
const clicked = await make({ email: "clicked@k.invalid" });    await send(clicked.id, clicked.email, { opens: 1, clicks: 3 });
const flight  = await make({ email: "flight@l.invalid" });     await send(flight.id, flight.email, { status: "queued" });
const rInt    = await make({ email: "int@m.invalid" });        await send(rInt.id, rInt.email, { replied: day(1) }); await reply(rInt.id, rInt.email, "interested");
const rCons   = await make({ email: "cons@n.invalid" });       await send(rCons.id, rCons.email, { replied: day(1) }); await reply(rCons.id, rCons.email, "considering");
const rNo     = await make({ email: "no@o.invalid" });         await send(rNo.id, rNo.email, { replied: day(1) }); await reply(rNo.id, rNo.email, "not_interested");
const rWrong  = await make({ email: "wrong@p.invalid" });      await send(rWrong.id, rWrong.email, { replied: day(1) }); await reply(rWrong.id, rWrong.email, "wrong_person");

const counts = await cohortCounts(USER);
const n = (c: string) => counts.find((x) => x.cohort === c)?.n ?? 0;
const sum = counts.reduce((a, c) => a + c.n, 0);

// الفحص الأهم
check("المجموع · مجموع الحالات = عدد الجهات بالضبط", sum === 16, `${sum} من 16`);
check("المجموع · كل حالةٍ معرَّفة لها سطرٌ في الجدول", counts.length === Object.keys(COHORTS).length, `${counts.length}`);

// كل حالةٍ في موضعها
const want: Array<[string, string]> = [
  ["fresh", "لم تُراسَل — جاهزة"], ["unchecked", "نطاق غير مفحوص"], ["bad_domain", "نطاقٌ لا يستقبل"],
  ["unsubscribed", "ألغوا الاشتراك"], ["bounced", "ارتدّ بريدها"], ["suppressed", "مُستبعَدة"],
  ["truce", "هدنة"], ["silent_one", "رسالةٌ واحدة"], ["silent_many", "مراراً بلا أثر"],
  ["opened", "فتحوا"], ["clicked", "نقروا"], ["in_flight", "قيد الإرسال"],
  ["replied_interested", "ردّوا مهتمون"], ["replied_considering", "تحت المراجعة"],
  ["replied_negative", "غير مهتمين"], ["replied_wrong_person", "ليس الشخص المناسب"],
];
for (const [cohort, label] of want) check(`حالة · ${label}`, n(cohort) === 1, `${n(cohort)}`);

// الأولوية هي حكم العمل
const u2 = await make({ email: "u2@q.invalid", status: "unsubscribed" });
await send(u2.id, u2.email, { opens: 5, clicks: 2 });
const c2 = await cohortCounts(USER);
check("الأولوية · من ألغى اشتراكه لا يُعدّ «نقر»", (c2.find((x) => x.cohort === "clicked")?.n ?? 0) === 1);
check("الأولوية · ويُعدّ ملغياً", (c2.find((x) => x.cohort === "unsubscribed")?.n ?? 0) === 2);
const t2 = await make({ email: "t2@r.invalid", quietUntil: new Date(Date.now() + 3 * 86_400_000) });
await send(t2.id, t2.email, { replied: day(1) }); await reply(t2.id, t2.email, "later");
const c3 = await cohortCounts(USER);
check("الأولوية · الهدنة تسبق «ردّوا»", (c3.find((x) => x.cohort === "truce")?.n ?? 0) === 2, `${c3.find((x) => x.cohort === "truce")?.n}`);
check("الأولوية · ولا يُعدّ ضمن «ليس الآن»", (c3.find((x) => x.cohort === "replied_later")?.n ?? 0) === 0);
check("المجموع يبقى صحيحاً بعد الإضافات", c3.reduce((a, x) => a + x.n, 0) === 18, `${c3.reduce((a, x) => a + x.n, 0)}`);

// الأعضاء
const cl = await cohortMembers(USER, "clicked", { limit: 10 });
check("الأعضاء · «نقروا» تعيد من نقر وحده", cl.length === 1 && cl[0]!.email === "clicked@k.invalid", cl[0]?.email);
check("الأعضاء · ومعها أرقامه", Number(cl[0]?.clicks) === 3 && Number(cl[0]?.sent) === 1);

// جودة الصفوف
await make({ email: "info@role.invalid", company: null, sector: null });
await make({ email: "x@gmail.com" });
const q = await dataQuality(USER);
const flag = (id: string) => q.flags.find((f) => f.id === id)?.n ?? 0;
check("الجودة · العنوان العام يُرصد", flag("role_addr") === 1, `${flag("role_addr")}`);
check("الجودة · العنوان المجاني يُرصد", flag("freemail") === 1);
check("الجودة · بلا اسم شركة", flag("no_company") === 1);
check("الجودة · بلا قطاع", flag("no_sector") === 1);
check("الجودة · لكل عيبٍ أثرٌ مكتوب وإصلاح", q.flags.every((f) => f.why.length > 20 && f.fix.length > 10), `${q.flags.length} عيباً`);

// الصورة الكاملة
const pic = await dataPicture(USER);
check("الصورة · عنوانٌ يقول أين المال", pic.headline.length > 25);
check("الصورة · المجموع يطابق", pic.counts.reduce((a, c) => a + c.n, 0) === pic.total);

// إعادة الاستهداف
const rt = await retargetPlans(USER, { minGapDays: 3 });
const plan = (c: string) => rt.plans.find((p) => p.cohort === c);
check("الاستهداف · «نقروا» لها خطّة", !!plan("clicked"));
check("الاستهداف · لكل خطّة زاوية ودعوة وسبب", rt.plans.every((p) => p.angle.brief.length > 40 && p.angle.cta.length > 4 && p.angle.why.length > 10));
check("الاستهداف · من ألغى أو رفض أو ارتدّ لا خطّة له",
  !plan("unsubscribed") && !plan("bounced") && !plan("replied_negative") && !plan("bad_domain"));
check("الاستهداف · ويُقال صريحاً لماذا لا تُمسّ",
  rt.excludedCohorts.some((x) => /ألغوا/.test(x.label)) && rt.excludedCohorts.every((x) => x.why.length > 20));
check("الاستهداف · المهتم الآن لا يُدخَل حملة", !plan("replied_interested"));
check("الاستهداف · الهدنة لا خطّة لها", !plan("truce"));
// من راسلناه قبل يومين يُستبعد من موجةٍ حدُّها ثلاثة أيام
const recent = await make({ email: "recent@s.invalid" });
await send(recent.id, recent.email, { sentAt: day(1) });
await db.update(emailContactsTable).set({ lastSentAt: day(1) }).where(eq(emailContactsTable.id, recent.id));
const rt2 = await retargetPlans(USER, { minGapDays: 3 });
const p1 = rt2.plans.find((p) => p.cohort === "silent_one")!;
check("الاستهداف · من راسلناه أمس يُستبعَد بعددٍ معلن",
  p1.excluded.some((x) => /قبل أقل من 3/.test(x.reason) && x.n >= 1), JSON.stringify(p1.excluded));

// السجل
const led = await reconcile(USER);
const find = (id: string) => led.findings.find((f) => f.id === id);
check("السجل · تسعة فحوص", led.findings.length === 9, `${led.findings.length}`);
check("السجل · يميّز التراكم من التوقّف", find("queue")!.title.includes("يُصرَّف") || find("queue")!.title.includes("واقف") || find("queue")!.detail.includes("فارغ"), find("queue")?.detail);
check("السجل · لا خلل في المرتدّة قبل أن نصنعه", (find("active_bounced")?.n ?? -1) === 0, `${find("active_bounced")?.n}`);
const ab = await make({ email: "ab@t.invalid" });
await send(ab.id, ab.email, { bounced: day(2) });
const led2 = await reconcile(USER);
check("السجل · يرصد جهةً نشطة وقد ارتدّ بريدها",
  (led2.findings.find((f) => f.id === "active_bounced")?.n ?? 0) === 1,
  `${led2.findings.find((f) => f.id === "active_bounced")?.n}`);
check("السجل · ويسمّيه خللاً لا ملاحظة", led2.findings.find((f) => f.id === "active_bounced")?.state === "fail");
check("السجل · ولها إصلاحٌ باسمه", led2.findings.find((f) => f.id === "active_bounced")?.repair === "mark_bounced");
const fixed = await repair(USER, "mark_bounced");
check("السجل · الإصلاح يُعلّم المرتدّة", fixed.done === 1, `${fixed.done}`);
const led3 = await reconcile(USER);
check("السجل · ولا يبقى الخلل بعده", (led3.findings.find((f) => f.id === "active_bounced")?.n ?? 0) === 0);
check("السجل · عدّاد الحملة يُصحَّح بالطلب", (await repair(USER, "resync_counters")).done >= 1);
check("السجل · ولا يبقى انحرافٌ بعده", (await reconcile(USER)).findings.find((f) => f.id === "counter_drift")?.state === "ok");

// الفتح: بلا عنوانٍ عام لا يُحلَّل شيء
const op = await opensReport(USER);
check("الفتح · يُعلن أنه لا يُقاس", op.measurable === false && !!op.blocker);
check("الفتح · ولا يقول «أعلى فتح» بلا قياس", !op.actions.some((a) => /أعلى فتح/.test(a)), op.actions.find((a) => /أعلى فتح/.test(a)) ?? "");
check("الفتح · ويُوجّه إلى الردّ بدلاً منه", op.actions.some((a) => /الردود وحدها|الرقم الوحيد/.test(a)));
await db.update(emailSettingsTable).set({ publicUrl: "https://app.procount.invalid" }).where(eq(emailSettingsTable.userId, USER));
const op2 = await opensReport(USER);
check("الفتح · مع عنوانٍ عام يصير قابلاً للقياس", op2.measurable === true && op2.blocker === null);

await wipe();
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
