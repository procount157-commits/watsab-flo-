// جدول المُرسَل ومعاينته. والمرشّحات هنا ليست تفصيلاً: أول نسخةٍ منها
// بَنَت الشرط بـ `filter ? sql`AND ${filter}` : sql``` — و`sql``` الفارغة
// كائنٌ صادق، فخرجت «AND» بلا شيء بعدها وانكسر الاستعلام على بيانات
// حقيقية بينما مرّت كل الاختبارات. فكل مرشّح يُنفَّذ هنا على القاعدة.

export {};
const { db, emailContactsTable, emailMessagesTable, emailCampaignsTable, emailSettingsTable } = await import("@workspace/db");
const { and, eq, inArray } = await import("drizzle-orm");
const { sentList, sentSummary, sentPreview } = await import("../email/sent");
const { validatePublicUrl } = await import("../email/public-url");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

// تنظيف ما تملكه هذه المجموعة
await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));

await db.insert(emailSettingsTable).values({
  userId: USER, provider: "smtp", smtpHost: "smtp.invalid", smtpUser: "u", smtpPass: "p",
  fromName: "Pro Count", fromEmail: "info@procount.invalid", tracking: true,
  signature: "Pro Count", publicUrl: null,
} as any);

const [c1] = await db.insert(emailContactsTable).values({ userId: USER, email: "a@one.invalid", company: "ONE TRADING L.L.C", name: "Sara" }).returning();
const [c2] = await db.insert(emailContactsTable).values({ userId: USER, email: "b@two.invalid", company: "TWO GROUP" }).returning();
const [cam] = await db.insert(emailCampaignsTable).values({
  userId: USER, name: "موجة الاختبار", subject: "{{company}}: جاهزية ملفاتكم",
  html: "<p>Hello {{first_name|team}}, a line about {{company}}.</p><p><a href=\"https://procount.invalid/aml\">Read</a></p>",
  status: "completed",
} as any).returning();

const now = new Date();
const day = (n: number) => new Date(now.getTime() - n * 86_400_000);
await db.insert(emailMessagesTable).values([
  { userId: USER, campaignId: cam!.id, contactId: c1!.id, toEmail: c1!.email, subject: "{{company}}: جاهزية ملفاتكم", token: `st-a-${Date.now()}`, status: "sent", sentAt: day(3), openedAt: day(2), openCount: 2 },
  { userId: USER, campaignId: cam!.id, contactId: c2!.id, toEmail: c2!.email, subject: "TWO GROUP: جاهزية ملفاتكم", token: `st-b-${Date.now()}`, status: "sent", sentAt: day(2) },
  { userId: USER, campaignId: cam!.id, contactId: c2!.id, toEmail: c2!.email, subject: "تابع", token: `st-c-${Date.now()}`, status: "failed", error: "Mailbox full" },
  { userId: USER, campaignId: cam!.id, contactId: c1!.id, toEmail: c1!.email, subject: "ردّوا", token: `st-d-${Date.now()}`, status: "sent", sentAt: day(1), repliedAt: day(1) },
  { userId: USER, campaignId: cam!.id, contactId: c1!.id, toEmail: c1!.email, subject: "نقروا", token: `st-e-${Date.now()}`, status: "sent", sentAt: day(1), openedAt: day(1), openCount: 1, clickedAt: day(1), clickCount: 3 },
  { userId: USER, campaignId: cam!.id, contactId: c2!.id, toEmail: c2!.email, subject: "ارتدّت", token: `st-f-${Date.now()}`, status: "sent", sentAt: day(4), bouncedAt: day(4) },
  { userId: USER, campaignId: cam!.id, contactId: c1!.id, toEmail: c1!.email, subject: "في الطابور", token: `st-g-${Date.now()}`, status: "queued" },
] as any);

const sum = await sentSummary(USER);
check("الملخّص · يعدّ ما خرج لا ما في الطابور", sum.sent === 5, `${sum.sent}`);
check("الملخّص · يعدّ الفاشلة", sum.failed === 1, `${sum.failed}`);
check("الملخّص · الفتح والنقر والرد والارتداد", sum.opened === 2 && sum.clicked === 1 && sum.replied === 1 && sum.bounced === 1,
  `فتح ${sum.opened} نقر ${sum.clicked} رد ${sum.replied} ارتداد ${sum.bounced}`);
check("الملخّص · النِسَب محسوبة على ما خرج", sum.openRate === 40 && sum.replyRate === 20, `${sum.openRate}% / ${sum.replyRate}%`);

// كل مرشّح يُنفَّذ على القاعدة — لا يكفي أن يُترجم
const counts: Record<string, number> = {};
for (const f of ["all", "opened", "clicked", "replied", "bounced", "failed", "unopened"] as const) {
  const r = await sentList(USER, { filter: f, limit: 50 });
  counts[f] = r.total;
  check(`مرشّح «${f}» يعمل على القاعدة`, Number.isInteger(r.total) && r.rows.length === r.total, `${r.total}`);
}
check("مرشّح · «الكل» يضمّ الخارجة والفاشلة ولا يضمّ الطابور", counts["all"] === 6, `${counts["all"]}`);
check("مرشّح · «لم تُفتح» = ما خرج ولم يُفتح", counts["unopened"] === 3, `${counts["unopened"]}`);
check("مرشّح · «فُتحت» لا يضمّ ما لم يُفتح", counts["opened"] === 2, `${counts["opened"]}`);

const byQ = await sentList(USER, { q: "TWO" });
check("البحث · بالشركة", byQ.total >= 1, `${byQ.total}`);
const byCam = await sentList(USER, { campaignId: cam!.id });
check("التقييد بحملة", byCam.total === 6, `${byCam.total}`);
check("الصفّ يحمل اسم حملته", byCam.rows[0]?.campaignName === "موجة الاختبار", byCam.rows[0]?.campaignName);

// ── المعاينة: ما وصل المستلم، بمتغيّراته مُستبدَلة ──
const first = (await sentList(USER, { filter: "replied" })).rows[0]!;
const p = await sentPreview(USER, first.id);
check("المعاينة · العنوان مُستبدَل لا قالباً", !!p && !p.subject.includes("{{"), p?.subject);
check("المعاينة · الجسم يُستبدَل باسم الشركة", !!p?.html.includes("One Trading"), (p?.text ?? "").slice(0, 46));
check("المعاينة · لا يبقى متغيّر غير مُستبدَل", !!p && !/\{\{/.test(p.html));
check("المعاينة · فيها تذييل إلغاء الاشتراك", !!p?.html.includes("نصاً") === false && /unsubscribe|إلغاء الاشتراك/i.test(p?.html ?? ""));

// وأهمّها: بلا عنوانٍ عام لا بكسل — والمعاينة تقولها، لا تُخفيها.
check("المعاينة · بلا عنوان عام: لا بكسل", p?.hadPixel === false);
check("المعاينة · والسبب مكتوبٌ لصاحب العمل", !!p?.trackingNote && /لا عنوان عام/.test(p.trackingNote));
check("المعاينة · ولا وسم صورة تتبّع في الجسم", !/\/t\/e\/[^"']+\.gif/.test(p?.html ?? ""));

// ومع عنوانٍ عام صحيح: البكسل يظهر، والروابط تُلفّ.
await db.update(emailSettingsTable).set({ publicUrl: "https://app.procount.invalid" }).where(eq(emailSettingsTable.userId, USER));
const p2 = await sentPreview(USER, first.id);
check("المعاينة · مع عنوان عام: البكسل موجود", p2?.hadPixel === true);
check("المعاينة · ووسم الصورة في الجسم", /https:\/\/app\.procount\.invalid\/t\/e\/[^"']+\.gif/.test(p2?.html ?? ""));
check("المعاينة · والروابط تمرّ بالمحوّل", p2!.html.includes("app.procount.invalid/t/e/") && p2!.html.includes("/c?u="));
check("المعاينة · ولا ملاحظة عجزٍ حينها", p2?.trackingNote === null);

check("المعاينة · رسالةٌ غير موجودة تُرجع null", (await sentPreview(USER, 99_999_999)) === null);

// العنوان العام: ما يُقبل وما يُرفض
check("عنوان · الداخلي يُرفض", !validatePublicUrl("http://localhost:8080").ok);
check("عنوان · شبكةٌ محلية تُرفض", !validatePublicUrl("http://192.168.1.9:8080").ok);
check("عنوان · نطاقٌ عام يُقبل ويُطهَّر", validatePublicUrl("app.pro-count.ae/").url === "https://app.pro-count.ae");
check("عنوان · مسارٌ زائد يُرفض بسببٍ واضح", (validatePublicUrl("https://x.ngrok-free.app/hook").why ?? "").includes("أصل العنوان"));
check("عنوان · http يُقبل بتحذير", (() => { const v = validatePublicUrl("http://app.pro-count.ae"); return v.ok && !!v.warn; })());

await db.delete(emailMessagesTable).where(eq(emailMessagesTable.userId, USER));
await db.delete(emailCampaignsTable).where(eq(emailCampaignsTable.userId, USER));
await db.delete(emailContactsTable).where(eq(emailContactsTable.userId, USER));
await db.delete(emailSettingsTable).where(eq(emailSettingsTable.userId, USER));

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
