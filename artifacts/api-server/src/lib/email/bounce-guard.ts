// ── حارسا الارتداد ────────────────────────────────────────────────
// قرار صاحب العمل (١٩ أكتوبر): «نفّذ الحلول كلها».
//
//   الصندوق   قبل كل إرسالٍ يُسأل خادم المستلم عن الصندوق (mailbox-check.ts).
//             «غير موجود» لا يُرسل إليه أبداً — ارتدادٌ مُنع قبل وقوعه.
//   الملف     كل ملفٍ جديد يُرسل منه خمسون أولاً ثم يُنتظر الحكم. فوق ٨٪
//             (ارتدّ، أو رفض خادمه الصندوق) يتوقف الملف: لا يُرسل منه إلا
//             ما قال خادمه إنه موجود، والفاحص يمرّ على بقيته في الخلفية.
//             ملف «منشآت أخرى» ارتدّ ١٣٫٥٪ قبل أن يوقفه أحد.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, emailContactsTable, emailMessagesTable, emailSourceTrialsTable, emailSettingsTable, type EmailContact } from "@workspace/db";
import { checkMailboxes, needsCheck } from "./mailbox-check";
import { activity } from "./team";
import { logger } from "../logger";

export const SAMPLE = 50, MAX_BAD_RATE = 0.08;
/** يُنتظر بعد آخر رسالةٍ في العيّنة: أغلب الارتداد يصل خلال ساعات. */
const SETTLE_MS = 24 * 3_600_000;

/** حكم العيّنة. Pure. */
export function decide(t: { attempted: number; bad: number; sample: number }, lastSentAt: Date | null, now = Date.now()): "sampling" | "passed" | "failed" {
  // ارتدادٌ يتجاوز ٨٪ من العيّنة كلها قبل أن تكتمل: لا داعي لانتظارها.
  if (t.bad > Math.floor(t.sample * MAX_BAD_RATE)) return "failed";
  if (t.attempted < t.sample) return "sampling";
  if (t.bad / t.attempted > MAX_BAD_RATE) return "failed";
  return lastSentAt && now - lastSentAt.getTime() >= SETTLE_MS ? "passed" : "sampling";
}

/** ملفٌ جديد رُفع: يبدأ عيّنة. */
export async function startTrial(userId: number, source: string) {
  if (!source.startsWith("ملف:")) return;
  await db.insert(emailSourceTrialsTable).values({ userId, source }).onConflictDoNothing();
}

/** رسائل الطابور التي تنتظر حكم عيّنة ملفها — لا تُختار للإرسال. */
export const awaitingVerdict = (contactId: any) => sql`not exists (select 1 from email_contacts gc join email_source_trials gt on gt.user_id = gc.user_id and gt.source = gc.source
  where gc.id = ${contactId} and gt.status = 'sampling' and gt.attempted >= gt.sample)`;

/** في الشرائح القابلة للإرسال: ملفٌ موقوف لا يُؤخذ منه إلا صندوقٌ ثبت وجوده. */
export const notFromFailedFile = sql`not exists (select 1 from email_source_trials ft where ft.user_id = ${emailContactsTable.userId} and ft.source = ${emailContactsTable.source}
  and ft.status = 'failed' and coalesce(${emailContactsTable.mailbox}, '') <> 'ok')`;

async function trialOf(userId: number, source: string | null) {
  if (!source) return null;
  const [t] = await db.select().from(emailSourceTrialsTable).where(and(eq(emailSourceTrialsTable.userId, userId), eq(emailSourceTrialsTable.source, source))).limit(1);
  return t ?? null;
}

const bump = (id: number, bad: boolean) => db.update(emailSourceTrialsTable)
  .set({ attempted: sql`${emailSourceTrialsTable.attempted} + 1`, ...(bad ? { bad: sql`${emailSourceTrialsTable.bad} + 1` } : {}) })
  .where(and(eq(emailSourceTrialsTable.id, id), eq(emailSourceTrialsTable.status, "sampling")));

/**
 * قبل إرسال رسالةٍ إلى جهة: «send» أو «cancel» بسبب. يفحص الصندوق إن لم
 * يُفحص، ويحفظ الحكم. خطأٌ في الفحص نفسه لا يمنع الإرسال.
 */
export async function beforeSend(userId: number, contact: EmailContact, from: string): Promise<{ send: true; trialId: number | null } | { send: false; why: string }> {
  const trial = await trialOf(userId, contact.source);
  let mailbox = contact.mailbox;
  if (needsCheck({ mailbox: contact.mailbox, mailboxCheckedAt: contact.mailboxCheckedAt })) {
    // عشرون ثانية على الأكثر: الفاحص في الخلفية قد يكون مشغولاً، والإرسال لا ينتظره.
    const asked = checkMailboxes([{ id: contact.id, email: contact.email }], from).catch(() => null);
    const got = await Promise.race([asked, new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
    mailbox = got?.get(contact.id) ?? mailbox;
  }
  if (mailbox === "invalid") {
    await db.update(emailContactsTable).set({ status: "invalid" }).where(eq(emailContactsTable.id, contact.id));
    if (trial) await bump(trial.id, true);
    return { send: false, why: "ألغيت قبل الإرسال: خادم المستلم قال إن هذا الصندوق غير موجود — ارتدادٌ مُنع" };
  }
  if (trial?.status === "failed" && mailbox !== "ok") {
    return { send: false, why: `ألغيت: ملف «${trial.source.replace(/^ملف:\s*/, "")}» أوقفته العيّنة (${trial.bad} من ${trial.attempted}) — يُرسل منه ما ثبت صندوقه فقط` };
  }
  return { send: true, trialId: trial?.status === "sampling" ? trial.id : null };
}

/** بعد إرسالٍ نجح: يُحسب في العيّنة. */
export async function afterSend(trialId: number | null) {
  if (trialId) await bump(trialId, false);
}

// ── الحكم والفحص في الخلفية ──────────────────────────────────────
export async function judgeTrials(): Promise<void> {
  const open = await db.select().from(emailSourceTrialsTable).where(eq(emailSourceTrialsTable.status, "sampling"));
  for (const t of open) {
    // الحقيقة من الجهات نفسها: من جُرّب، ومن ارتدّ أو رُفض صندوقه.
    const [r] = (await db.execute<{ attempted: number; bad: number; last: Date | null }>(sql`
      SELECT count(*) FILTER (WHERE last_sent_at IS NOT NULL OR status = 'invalid')::int AS attempted,
             count(*) FILTER (WHERE status IN ('bounced', 'invalid'))::int AS bad,
             max(last_sent_at) AS last
      FROM email_contacts WHERE user_id = ${t.userId} AND source = ${t.source}`)).rows;
    const attempted = Number(r?.attempted ?? 0), bad = Number(r?.bad ?? 0);
    const verdict = decide({ attempted, bad, sample: t.sample }, r?.last ? new Date(r.last) : null);
    const pct = attempted ? Math.round((bad / attempted) * 1000) / 10 : 0;
    const name = t.source.replace(/^ملف:\s*/, "");
    if (verdict === "sampling") {
      if (attempted !== t.attempted || bad !== t.bad) await db.update(emailSourceTrialsTable).set({ attempted, bad }).where(eq(emailSourceTrialsTable.id, t.id));
      continue;
    }
    const note = verdict === "failed"
      ? `أُوقف: ${bad} من ${attempted} (${pct}٪) ارتدّ أو رُفض صندوقه، والحد ${MAX_BAD_RATE * 100}٪`
      : `نجح: ${bad} من ${attempted} (${pct}٪)`;
    await db.update(emailSourceTrialsTable).set({ status: verdict, attempted, bad, note, decidedAt: new Date() }).where(eq(emailSourceTrialsTable.id, t.id));
    if (verdict === "failed") {
      // ما في الطابور منه يُلغى، إلا ما ثبت صندوقه. الجهات تبقى قابلةً للمراسلة
      // إن أثبت الفاحص صناديقها لاحقاً.
      const c = await db.execute(sql`UPDATE email_messages m SET status = 'cancelled', error = ${`ألغيت: ملف «${name}» أوقفته العيّنة`}
        FROM email_contacts c WHERE c.id = m.contact_id AND m.user_id = ${t.userId} AND m.status IN ('queued', 'ab_hold')
          AND c.source = ${t.source} AND coalesce(c.mailbox, '') <> 'ok'`);
      await activity(t.userId, "email_guard", "hold",
        `ملف «${name}» أوقفته عيّنته: ${bad} من أول ${attempted} (${pct}٪) ارتدّ أو قال خادمه إن الصندوق غير موجود. ألغيت ${c.rowCount ?? 0} رسالة في الطابور. لن يُرسل منه إلا ما يثبت الفاحص صندوقه — وهو يمرّ عليه في الخلفية.`).catch(() => {});
    } else {
      await activity(t.userId, "email_guard", "pass", `ملف «${name}» نجح في عيّنته: ${bad} من ${attempted} (${pct}٪). يُرسل منه الآن بلا قيد.`).catch(() => {});
    }
    logger.info({ userId: t.userId, source: t.source, verdict, attempted, bad }, "حُكم على عيّنة ملف");
  }
}

/**
 * يفحص مسبقاً من سيُرسل إليهم قريباً — رسائل الطابور أولاً، ثم جهات
 * الملفات الموقوفة (فيعود منها ما ثبت صندوقه) — كي لا ينتظر الإرسال.
 */
export async function precheck(): Promise<void> {
  const users = await db.select({ userId: emailSettingsTable.userId, from: emailSettingsTable.fromEmail }).from(emailSettingsTable);
  for (const u of users) {
    if (!u.from) continue;
    const queued = (await db.execute<{ id: number; email: string }>(sql`
      SELECT DISTINCT c.id, c.email, min(m.created_at) AS at FROM email_messages m JOIN email_contacts c ON c.id = m.contact_id
      WHERE m.user_id = ${u.userId} AND m.status = 'queued' AND c.status = 'active'
        AND (c.mailbox IS NULL OR (c.mailbox = 'unknown' AND c.mailbox_checked_at < now() - interval '1 day'))
      GROUP BY c.id, c.email ORDER BY at LIMIT 12`)).rows;
    const rescue = queued.length >= 12 ? [] : (await db.execute<{ id: number; email: string }>(sql`
      SELECT c.id, c.email FROM email_contacts c JOIN email_source_trials t ON t.user_id = c.user_id AND t.source = c.source
      WHERE c.user_id = ${u.userId} AND t.status = 'failed' AND c.status = 'active' AND c.last_sent_at IS NULL
        AND coalesce(c.mx_ok, true) AND c.mailbox IS NULL
      LIMIT ${12 - queued.length}`)).rows;
    const todo = [...queued, ...rescue].map((r) => ({ id: Number(r.id), email: String(r.email) }));
    if (!todo.length) continue;
    const got = await checkMailboxes(todo, u.from).catch(() => new Map());
    const invalid = [...got.entries()].filter(([, v]) => v === "invalid").map(([id]) => id);
    if (invalid.length) await db.update(emailContactsTable).set({ status: "invalid" }).where(inArray(emailContactsTable.id, invalid));
  }
}

export function startBounceGuard(): void {
  setTimeout(() => {
    const tick = async () => {
      await judgeTrials().catch((err) => logger.warn({ err: String(err) }, "judge trials failed"));
      await precheck().catch((err) => logger.warn({ err: String(err) }, "mailbox precheck failed"));
    };
    void tick();
    setInterval(() => void tick(), 5 * 60_000);
  }, 90_000);
  logger.info("حارسا الارتداد بدآ: فحص الصناديق وعيّنة الملفات");
}

void emailMessagesTable;
