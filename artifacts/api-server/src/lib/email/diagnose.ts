// ── Why the email is not going out ────────────────────────────────
// The owner's words were "I cannot understand why it is not sending". They
// could not, and the system was not telling them: an empty audience, a dead
// SMTP connection, a laptop that fell asleep and a mission paused three days
// ago all presented the same way — nothing happens, no reason given.
//
// Every check here answers one question with evidence and says what to do
// about it. Nothing is inferred: if SMTP is reported working it is because the
// server was asked, now.

import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import {
  db, emailSettingsTable, emailContactsTable, emailMissionsTable, emailCampaignsTable,
  emailMessagesTable, emailListsTable, emailListMembersTable, telegramSettingsTable,
} from "@workspace/db";
import { count as countSegment, describe as describeSegment } from "./segments";
import { outboxState } from "../telegram";
import { trackingState, probePublicUrl } from "./public-url";
import type { SegmentFilter } from "@workspace/db";

export type Check = {
  id: string;
  title: string;
  state: "ok" | "warn" | "fail";
  /** What was actually found. Numbers, not adjectives. */
  detail: string;
  /** What the owner does about it, when there is something to do. */
  fix?: string;
};

const ok   = (id: string, title: string, detail: string): Check => ({ id, title, state: "ok", detail });
const warn = (id: string, title: string, detail: string, fix?: string): Check => ({ id, title, state: "warn", detail, fix });
const fail = (id: string, title: string, detail: string, fix?: string): Check => ({ id, title, state: "fail", detail, fix });

/** Ask the mail server, rather than assuming the settings are right. */
async function probeSmtp(s: typeof emailSettingsTable.$inferSelect): Promise<Check> {
  if (s.provider !== "smtp") {
    return s.apiKey
      ? ok("smtp", "مزوّد البريد", `${s.provider} — المفتاح مضبوط`)
      : fail("smtp", "مزوّد البريد", `${s.provider} بلا مفتاح`, "أضف مفتاح المزوّد في إعدادات البريد.");
  }
  if (!s.smtpHost || !s.smtpUser || !s.smtpPass) {
    return fail("smtp", "خادم البريد", "الإعدادات ناقصة", "أكمل الخادم والمستخدم وكلمة المرور في إعدادات البريد.");
  }
  // Both ports, because this account's 465 failed intermittently while 587
  // answered in 620ms — and a transient failure on one port looks exactly like
  // a wrong password if only one is tried.
  const tries: Array<{ port: number; secure: boolean }> = [
    { port: s.smtpPort ?? 465, secure: !!s.smtpSecure },
    ...(s.smtpPort !== 587 ? [{ port: 587, secure: false }] : []),
  ];
  const errors: string[] = [];
  for (const t of tries) {
    const t0 = Date.now();
    try {
      const tx = nodemailer.createTransport({
        host: s.smtpHost, port: t.port, secure: t.secure,
        auth: { user: s.smtpUser, pass: s.smtpPass },
        connectionTimeout: 15_000, greetingTimeout: 15_000,
      });
      await tx.verify();
      const ms = Date.now() - t0;
      return t.port === (s.smtpPort ?? 465)
        ? ok("smtp", "خادم البريد", `${s.smtpHost}:${t.port} — المصادقة نجحت في ${ms}ms`)
        : warn("smtp", "خادم البريد", `المنفذ ${s.smtpPort} لم يستجب، لكن ${t.port} نجح في ${ms}ms`,
            `غيّر المنفذ إلى ${t.port} في إعدادات البريد — الحالي يفشل من هذه الشبكة.`);
    } catch (err: any) {
      errors.push(`${t.port}: ${String(err?.message ?? err).slice(0, 70)}`);
    }
  }
  return fail("smtp", "خادم البريد", errors.join(" · "),
    "راجع كلمة المرور، أو جرّب المنفذ 587، أو تأكد أن الشبكة لا تحجب البريد.");
}

export async function diagnose(userId: number): Promise<{ checks: Check[]; verdict: string; canSend: boolean }> {
  const checks: Check[] = [];
  const day = new Date(Date.now() - 24 * 60 * 60_000);

  // ── Can it send at all ──
  const [s] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  if (!s) {
    checks.push(fail("settings", "إعدادات البريد", "غير مضبوطة", "افتح البريد → الإعدادات وأضف خادم الإرسال."));
  } else {
    checks.push(await probeSmtp(s));
    checks.push(s.fromEmail
      ? ok("from", "عنوان المُرسِل", `${s.fromName ? `${s.fromName} ` : ""}<${s.fromEmail}>`)
      : fail("from", "عنوان المُرسِل", "غير محدد", "أضف عنوان المُرسِل في إعدادات البريد."));
  }

  // ── Is there anyone to send to ──
  const [aud] = await db.select({
    all:    sql<number>`count(*)`,
    active: sql<number>`count(*) filter (where ${emailContactsTable.status} = 'active')`,
    mxBad:  sql<number>`count(*) filter (where ${emailContactsTable.mxOk} = false)`,
  }).from(emailContactsTable).where(eq(emailContactsTable.userId, userId));

  const all = Number(aud?.all ?? 0), active = Number(aud?.active ?? 0);
  checks.push(
    all === 0 ? fail("audience", "الجمهور", "لا توجد أي جهة بريد", "ارفع ملف جهات من البريد → القوائم.")
    : active === 0 ? fail("audience", "الجمهور", `${all} جهة، ولا واحدة نشطة`, "كلهم ملغون أو مرتدّون — ارفع قائمة جديدة.")
    : ok("audience", "الجمهور", `${active} جهة نشطة من ${all}${Number(aud?.mxBad) ? ` · ${aud!.mxBad} نطاقها لا يستقبل بريداً` : ""}`),
  );

  // ── Lists that exist but hold nobody ──
  const lists = await db.select({
    id: emailListsTable.id, name: emailListsTable.name,
    n: sql<number>`count(${emailListMembersTable.contactId})`,
  }).from(emailListsTable)
    .leftJoin(emailListMembersTable, eq(emailListMembersTable.listId, emailListsTable.id))
    .where(eq(emailListsTable.userId, userId))
    .groupBy(emailListsTable.id, emailListsTable.name);
  const empty = lists.filter((l) => Number(l.n) === 0);
  if (lists.length) {
    checks.push(empty.length === lists.length
      ? fail("lists", "القوائم", `${lists.length} قائمة، كلها فارغة`, "ارفع الملف من جديد — القوائم موجودة بلا أعضاء.")
      : empty.length
        ? warn("lists", "القوائم", `${empty.length} من ${lists.length} فارغة: ${empty.slice(0, 3).map((l) => l.name).join("، ")}`)
        : ok("lists", "القوائم", `${lists.length} قائمة، أكبرها ${Math.max(...lists.map((l) => Number(l.n)))} جهة`));
  }

  // ── Missions that are stuck, and why ──
  const missions = await db.select().from(emailMissionsTable)
    .where(and(eq(emailMissionsTable.userId, userId), inArray(emailMissionsTable.status, ["active", "paused"])));
  for (const m of missions) {
    const f = m.filter as SegmentFilter;
    const sendable = await countSegment(userId, f, true).catch(() => 0);
    const where = `${describeSegment(f)} — ${sendable} يمكن مراسلتهم`;
    if (m.status === "paused") {
      checks.push(fail(`mission-${m.id}`, `مهمة «${m.name}»`, `موقوفة · ${where}`,
        sendable > 0 ? "الجمهور صار متاحاً — شغّلها من البريد → المهام." : "جمهورها فارغ — غيّر الجمهور أو ارفع قائمة."));
    } else if (m.stage === "awaiting_approval") {
      checks.push(sendable > 0
        ? warn(`mission-${m.id}`, `مهمة «${m.name}»`, `تنتظر موافقتك · ${where}`, "افتح البريد → المهام واضغط «وافقت — أرسلي».")
        : fail(`mission-${m.id}`, `مهمة «${m.name}»`, `تنتظر موافقتك لكن ${where}`, "الموافقة سترفض — ارفع قائمة أو غيّر الجمهور أولاً."));
    } else {
      checks.push(ok(`mission-${m.id}`, `مهمة «${m.name}»`, `${m.stage} · ${where}`));
    }
  }

  // ── What the queue has been doing ──
  const [q] = await db.select({
    queued:    sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'queued')`,
    sent:      sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'sent' and ${emailMessagesTable.createdAt} >= ${day})`,
    failed:    sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'failed' and ${emailMessagesTable.createdAt} >= ${day})`,
    cancelled: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'cancelled' and ${emailMessagesTable.createdAt} >= ${day})`,
  }).from(emailMessagesTable).where(eq(emailMessagesTable.userId, userId));

  const failed = Number(q?.failed ?? 0), sent = Number(q?.sent ?? 0), queued = Number(q?.queued ?? 0);
  if (failed > 0) {
    const reasons = await db.select({ error: emailMessagesTable.error, n: sql<number>`count(*)` })
      .from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.status, "failed"), gte(emailMessagesTable.createdAt, day)))
      .groupBy(emailMessagesTable.error).orderBy(desc(sql`count(*)`)).limit(3);
    checks.push(fail("failures", "رسائل فشلت اليوم",
      reasons.map((r) => `${r.n}× ${r.error ?? "بلا سبب"}`).join(" · "),
      "افتح البريد → السجل لترى الرسائل نفسها."));
  }
  checks.push(queued > 0
    ? ok("queue", "الطابور", `${queued} في الانتظار · ${sent} أُرسلت اليوم`)
    : sent > 0 ? ok("queue", "الطابور", `فارغ · ${sent} أُرسلت اليوم`)
    : warn("queue", "الطابور", "فارغ، ولم تُرسل رسالة اليوم", "لا حملة تعمل الآن."));

  // ── Do the reports reach anyone ──
  const [tg] = await db.select().from(telegramSettingsTable).where(eq(telegramSettingsTable.userId, userId)).limit(1);
  const out = await outboxState(userId);
  checks.push(
    !tg?.chatId ? warn("telegram", "تقارير تليجرام", "غير مربوط", "اربطه من غرفة العمليات لتصلك تقارير الحملات.")
    : !tg.enabled ? warn("telegram", "تقارير تليجرام", "مربوط لكنه موقوف", "شغّله من غرفة العمليات.")
    : out.pending > 0 ? warn("telegram", "تقارير تليجرام", `${out.pending} تقرير ينتظر الإرسال — الشبكة تعذّرت`, "ستصل تلقائياً عند عودة الاتصال.")
    : out.dead > 0 ? warn("telegram", "تقارير تليجرام", `مربوط · ${out.dead} تقرير تعذّر نهائياً`)
    : ok("telegram", "تقارير تليجرام", `مربوط بـ${tg.chatTitle ?? "محادثتك"}${out.sent ? ` · ${out.sent} أُرسل بعد تأخير` : ""}`),
  );

  // ── قياس الفتح: يُفحَص فحصاً حقيقياً لا يُفترض ──
  // هذا الفحص هو ما كان ينقص التشخيص كله: النظام كان يقول «أُرسلت ٥٦٠»
  // و«فُتحت ٠» في سطرين متجاورين، كأن الثاني نتيجة الأول. ليس كذلك —
  // لم يُقَس شيء. فإن كان العنوان مضبوطاً نطلب البكسل منه كما يطلبه
  // بريد المستلم، وإن لم يكن فالسبب يُقال كما هو.
  const tr = await trackingState(userId);
  if (!tr.can) {
    const [{ n: everSent }] = (await db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), isNotNull(emailMessagesTable.sentAt))));
    checks.push({
      id: "tracking", title: "قياس الفتح والنقر",
      state: Number(everSent) > 0 ? "fail" : "warn",
      detail: `${tr.why}${Number(everSent) > 0 ? ` — و${Number(everSent)} رسالة خرجت بالفعل بلا قياس` : ""}`,
      fix: tr.howTo.join(" "),
    });
  } else {
    const probe = await probePublicUrl(tr.base!);
    checks.push(probe.ok
      ? { id: "tracking", title: "قياس الفتح والنقر", state: "ok", detail: `العنوان ${tr.base} يستجيب في ${probe.ms}ms — البكسل يصل` }
      : { id: "tracking", title: "قياس الفتح والنقر", state: "fail",
          detail: `العنوان ${tr.base} مضبوط لكنه لا يستجيب: ${probe.why}`,
          fix: "الرسائل ستُرسل وتصل، لكن الفتحات ستبقى صفراً. صحّح العنوان من: البريد → الإعدادات." });
  }

  const bad = checks.filter((c) => c.state === "fail");
  // قياس الفتح لا يمنع الإرسال — يمنع معرفة نتيجته.
  const canSend = !bad.some((c) => ["smtp", "from", "audience", "settings"].includes(c.id));
  const verdict = bad.length === 0
    ? "كل شيء جاهز للإرسال."
    : `${bad.length} ${bad.length === 1 ? "عائق يمنع" : "عوائق تمنع"} الإرسال: ${bad.map((c) => c.title).join("، ")}.`;

  return { checks, verdict, canSend };
}
