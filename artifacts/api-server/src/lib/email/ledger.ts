// ── سجلّ ما أُرسل، ومطابقته ───────────────────────────────────────
// موظف السجل لا يكتب رسالةً ولا يختار جمهوراً. وظيفته واحدة: أن يكون
// السجل صادقاً — أن يطابق ما تقوله الأرقام ما حدث فعلاً.
//
// ولماذا تلزم وظيفةٌ كهذه: في هذا الحساب نفسه كان العدّاد يقول «أُرسلت
// ٥٦٠» و«فُتحت ٠» في سطرين متجاورين فيُقرأ الثاني نتيجةً للأول، وكان
// ١٧٦٢ صفاً «فاشلاً» بلا سببٍ يُفهم، وجهاتٌ «نشطة» وقد ارتدّ بريدها.
// كل هذه تناقضاتٌ في السجل، لا في الإرسال — ولا يراها من يقرأ الملخّص.
//
// فكل فحصٍ هنا يسأل سؤالاً واحداً تُجاب عنه القاعدة بعددٍ لا بصفة، ومعه
// ما يُفعل. ولا يُصلح شيئاً من تلقاء نفسه: يُرى أولاً، ويُصلَح بطلب.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export interface LedgerFinding {
  id: string;
  title: string;
  state: "ok" | "warn" | "fail";
  /** ما وُجد — عدداً. */
  detail: string;
  /** ماذا يعني هذا التناقض فعلاً. */
  means?: string;
  fix?: string;
  n: number;
  /** هل يمكن إصلاحه بزرٍّ واحد — واسم الإصلاح. */
  repair?: "requeue_stuck" | "resync_counters" | "mark_bounced" | "cancel_orphans" | "restore_policy_rejected";
}

/** رسالةٌ رفضها المزوّد نفسه — بنصّ خطئها. يطابق `classifySendFailure` في provider.ts. */
const POLICY_SQL = sql`m.error ~* '(5\.7\.[0-9]|spam|policy|blocked|blacklist|reputation|message rejected|content rejected)'`;

const one = async <T = any>(q: ReturnType<typeof sql>): Promise<T> => {
  const r = await db.execute<any>(q);
  return (((r as any).rows ?? r) as any[])[0] as T;
};

export async function reconcile(userId: number): Promise<{ findings: LedgerFinding[]; verdict: string; clean: boolean }> {
  const f: LedgerFinding[] = [];

  // ١ · رسالةٌ «خرجت» بلا حدث خروج. العدّاد يقول أُرسلت والسجل لا يشهد.
  const noEvent = await one(sql`
    SELECT count(*)::int AS n FROM email_messages m
    WHERE m.user_id = ${userId} AND m.sent_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM email_events e WHERE e.message_id = m.id AND e.type = 'sent')`);
  f.push(Number(noEvent?.n) > 0
    ? { id: "sent_no_event", title: "رسائل خرجت بلا حدثٍ مسجّل", state: "warn", n: Number(noEvent.n),
        detail: `${noEvent.n} رسالة عليها تاريخ خروج ولا حدث «sent» في جدول الأحداث`,
        means: "الملخّص يعدّها، والجدول الزمني لا يراها. أي تقريرٍ يُبنى على الأحداث سيُنقصها.",
        fix: "غالباً رسائل ردٍّ مباشرة أُرسلت قبل أن يُسجَّل الحدث. لا تمنع الإرسال، لكنها تُفسّر فرقاً بين رقمين." }
    : { id: "sent_no_event", title: "رسائل خرجت بلا حدثٍ مسجّل", state: "ok", n: 0, detail: "كل ما خرج له حدثٌ مسجّل" });

  // ٢ · عدّادات الحملة مقابل الواقع. العدّاد يُزاد بـ +1 عند كل إرسال،
  //     وكل إلغاءٍ أو حذفٍ أو تصحيحٍ بعده يجعله يكذب.
  const drift = await one(sql`
    SELECT count(*)::int AS n, coalesce(max(abs(diff)), 0)::int AS worst FROM (
      SELECT c.id, c.sent_count - count(m.id) FILTER (WHERE m.sent_at IS NOT NULL) AS diff
      FROM email_campaigns c LEFT JOIN email_messages m ON m.campaign_id = c.id
      WHERE c.user_id = ${userId} GROUP BY c.id, c.sent_count
    ) x WHERE diff <> 0`);
  f.push(Number(drift?.n) > 0
    ? { id: "counter_drift", title: "عدّادات حملات لا تطابق الواقع", state: "warn", n: Number(drift.n),
        detail: `${drift.n} حملة عدّادها يخالف عدد رسائلها الفعلي — أكبر فرق ${drift.worst}`,
        means: "صاحب العمل يقرأ رقماً على الحملة غير الرقم الذي في الجدول. والقرار يُبنى على المعروض.",
        fix: "يُعاد حساب العدّادات من الرسائل نفسها.", repair: "resync_counters" }
    : { id: "counter_drift", title: "عدّادات الحملات", state: "ok", n: 0, detail: "كل عدّاد يطابق رسائله" });

  // ٣ · الطابور: عمر الصف ليس دليلاً على شيء.
  //     أول صيغةٍ من هذا الفحص سمّت «٢٤٧ رسالة في الطابور منذ ٨ أكتوبر»
  //     فشلاً — وكان الطابور يتحرّك: ١٤٨ خرجت أمس و١١ اليوم. التراكم
  //     الصحّي يُصرَّف، والسؤال الصحيح ليس «كم انتظرت؟» بل «هل يتحرّك،
  //     وفي كم يُفرَغ؟». فإن كان الطابور ممتلئاً ولا شيء يخرج، فذاك
  //     توقّفٌ حقيقي يستحق أن يُسمّى فشلاً.
  const q = await one(sql`
    SELECT
      count(*) FILTER (WHERE status IN ('queued','ab_hold'))::int                       AS waiting,
      min(created_at) FILTER (WHERE status IN ('queued','ab_hold'))                     AS oldest,
      (SELECT count(*) FROM email_messages WHERE user_id = ${userId}
         AND sent_at > now() - interval '24 hours')::int                                AS drained_24h,
      (SELECT max(sent_at) FROM email_messages WHERE user_id = ${userId})               AS last_sent
    FROM email_messages WHERE user_id = ${userId}`);
  const waiting = Number(q?.waiting ?? 0), drained = Number(q?.drained_24h ?? 0);
  const idleHours = q?.last_sent ? Math.floor((Date.now() - new Date(q.last_sent).getTime()) / 3_600_000) : null;
  const days = drained > 0 ? Math.ceil(waiting / drained) : null;
  f.push(waiting === 0
    ? { id: "queue", title: "الطابور", state: "ok", n: 0, detail: "فارغ — كل ما قُرّر إرساله خرج" }
    : drained === 0
      ? { id: "queue", title: "الطابور واقف", state: "fail", n: waiting,
          detail: `${waiting} رسالة تنتظر، ولم تخرج رسالةٌ واحدة في ٢٤ ساعة${idleHours != null ? ` (آخر إرسال قبل ${idleHours} ساعة)` : ""}`,
          means: "جمهورٌ قُرّر إرساله ولا يُرسَل. الحملة تبدو «ترسل» وهي واقفة، ولا أحد يُخبَر.",
          fix: "افحص الإرسال من «التشخيص»: المنفذ، أو حجز الحارس، أو نافذة الساعات، أو نوم الجهاز." }
      : { id: "queue", title: "الطابور يُصرَّف", state: "ok", n: waiting,
          detail: `${waiting} تنتظر · ${drained} خرجت في ٢٤ ساعة · تُفرَغ في ${days} ${days === 1 ? "يوم" : "أيام"} على هذا المعدّل`,
          means: "تراكمٌ صحّي لا عائق: الحصة اليومية تُوزّع الإرسال على أيام بقصد، فالدفعة الواحدة الكبيرة تُحرق سمعة النطاق." });

  // ٤ · رسالةٌ بلا حملةٍ ولا تتابع. هذه بالضبط ما أحرق ١٧٦٢ صفاً هنا:
  //     حُذفت الحملة، فصفّر المفتاح الأجنبي الرابط، فلم يبقَ لها جسم.
  const orphan = await one(sql`
    SELECT count(*)::int AS n FROM email_messages
    WHERE user_id = ${userId} AND campaign_id IS NULL AND sequence_job_id IS NULL
      AND status IN ('queued','ab_hold')`);
  f.push(Number(orphan?.n) > 0
    ? { id: "orphans", title: "رسائل في الطابور بلا مصدر", state: "fail", n: Number(orphan.n),
        detail: `${orphan.n} رسالة لا حملة لها ولا خطوة تتابع`,
        means: "لا جسم لها، فلن تُرسَل أبداً. وهذا ما أحرق ١٧٦٢ صفاً في هذا الحساب يوم ٥ أكتوبر قبل أن يُصلَح.",
        fix: "تُلغى لتبقى شركاتها قابلةً للمراسلة في موجةٍ جديدة.", repair: "cancel_orphans" }
    : { id: "orphans", title: "رسائل بلا مصدر", state: "ok", n: 0, detail: "كل ما في الطابور له جسم" });

  // ٥ · جهةٌ «نشطة» وقد ارتدّ بريدها. كل محاولةٍ بعدها تضرّ سمعة نطاقنا.
  const activeBounced = await one(sql`
    SELECT count(DISTINCT c.id)::int AS n FROM email_contacts c
    JOIN email_messages m ON m.contact_id = c.id
    WHERE c.user_id = ${userId} AND c.status = 'active' AND m.bounced_at IS NOT NULL`);
  f.push(Number(activeBounced?.n) > 0
    ? { id: "active_bounced", title: "جهات نشطة وقد ارتدّ بريدها", state: "fail", n: Number(activeBounced.n),
        detail: `${activeBounced.n} جهة حالتها «نشط» ولها رسالة مرتدّة`,
        means: "ستُدخل الموجة التالية وترتدّ مرةً أخرى. الارتداد المتكرّر على العنوان نفسه أسوأ ما يُقال عن مُرسِل.",
        fix: "تُعلَّم «مرتدّة» فتخرج من كل موجة.", repair: "mark_bounced" }
    : { id: "active_bounced", title: "الجهات المرتدّة", state: "ok", n: 0, detail: "كل ما ارتدّ مُعلَّم" });

  // ٦ · رسالتان للعنوان نفسه في اليوم نفسه. تغطيةٌ في الورق، إزعاجٌ في بريده.
  const sameDay = await one(sql`
    SELECT count(*)::int AS n FROM (
      SELECT lower(to_email) e, date_trunc('day', sent_at) d, count(*) k
      FROM email_messages WHERE user_id = ${userId} AND sent_at IS NOT NULL
      GROUP BY 1, 2 HAVING count(*) > 1
    ) x`);
  f.push(Number(sameDay?.n) > 0
    ? { id: "same_day", title: "عنوانٌ واحد رسالتان في يومٍ واحد", state: "warn", n: Number(sameDay.n),
        detail: `${sameDay.n} حالة`,
        means: "أسرع طريقٍ إلى بلاغ إزعاج. وبلاغٌ واحد أغلى من مئة رسالة.",
        fix: "راجع تداخل الموجات: قائمتان تحملان العنوان نفسه، أو حملةٌ أُعيد بدؤها." }
    : { id: "same_day", title: "التكرار في اليوم", state: "ok", n: 0, detail: "لا عنوان تلقّى أكثر من رسالة في يوم" });

  // ٧ · إرسالٌ خارج ساعات العمل. رسالةٌ تصل الثالثة فجراً تُقرأ إعلاناً.
  const offHours = await one(sql`
    SELECT count(*)::int AS n FROM email_messages
    WHERE user_id = ${userId} AND sent_at IS NOT NULL
      AND (extract(hour from sent_at AT TIME ZONE 'Asia/Dubai') < 7
        OR extract(hour from sent_at AT TIME ZONE 'Asia/Dubai') >= 20)`);
  f.push(Number(offHours?.n) > 0
    ? { id: "off_hours", title: "إرسال خارج ساعات العمل", state: "warn", n: Number(offHours.n),
        detail: `${offHours.n} رسالة خرجت قبل السابعة صباحاً أو بعد الثامنة مساءً بتوقيت الإمارات`,
        means: "بريد عملٍ يصل فجراً يُقرأ آلياً — إن قُرئ. والتوقيت من أقوى ما يحرّك نسبة الفتح.",
        fix: "حدّد نافذة الإرسال في الإعدادات، فالمُرسِل يحترمها." }
    : { id: "off_hours", title: "نافذة الإرسال", state: "ok", n: 0, detail: "كل ما خرج خرج في ساعات العمل" });

  // ٩ · جهاتٌ عُلّمت مرتدّة لأن المزوّد رفض رسالتنا. الرفض بـ5.7.x حكمٌ
  //     على نصّنا أو سمعتنا، لا على عنوانهم — والرسالة لم تخرج أصلاً.
  const wronged = await one(sql`
    SELECT count(DISTINCT c.id)::int AS n FROM email_contacts c
    WHERE c.user_id = ${userId} AND c.status = 'bounced'
      AND EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.sent_at IS NULL AND ${POLICY_SQL})
      AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.bounced_at IS NOT NULL AND NOT (m.sent_at IS NULL AND ${POLICY_SQL}))`);
  f.push(Number(wronged?.n) > 0
    ? { id: "policy_as_bounce", title: "شركات عُلّمت مرتدّة ظلماً", state: "fail", n: Number(wronged.n),
        detail: `${wronged.n} جهة حالتها «مرتدّة» وسببها الوحيد أن مزوّد البريد رفض رسالتنا (5.7.x — إزعاج أو سياسة)`,
        means: "عناوينها سليمة، والرسالة لم تخرج إليها أصلاً. خرجت من كل قائمة ومن كل موجةٍ قادمة، ورفعت نسبة الارتداد المعروضة بما ليس ارتداداً.",
        fix: "تُعاد نشطة، وتُعلَّم رسائلها «فشلت» بسببها الحقيقي.", repair: "restore_policy_rejected" }
    : { id: "policy_as_bounce", title: "رفض المزوّد مقابل الارتداد", state: "ok", n: 0, detail: "لا جهة عُلّمت مرتدّة بسبب رفض المزوّد لرسالتنا" });

  // ٨ · حدثٌ بلا رسالة. سجلٌّ يشير إلى ما لا وجود له.
  const ghost = await one(sql`
    SELECT count(*)::int AS n FROM email_events e
    WHERE e.user_id = ${userId}
      AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.id = e.message_id)`);
  f.push(Number(ghost?.n) > 0
    ? { id: "ghost_events", title: "أحداث بلا رسالة", state: "warn", n: Number(ghost.n),
        detail: `${ghost.n} حدثاً يشير إلى رسالة محذوفة`,
        means: "تُضخّم أي عدٍّ يُحسب من جدول الأحداث وحده.", fix: "تُترك للسجل التاريخي، ولا تُحسب في تقارير اليوم." }
    : { id: "ghost_events", title: "أحداث بلا رسالة", state: "ok", n: 0, detail: "كل حدثٍ له رسالته" });

  const bad = f.filter((x) => x.state === "fail");
  const warn = f.filter((x) => x.state === "warn");
  return {
    findings: f.sort((a, b) => (a.state === b.state ? 0 : a.state === "fail" ? -1 : b.state === "fail" ? 1 : a.state === "warn" ? -1 : 1)),
    clean: bad.length === 0 && warn.length === 0,
    verdict: bad.length ? `${bad.length} تناقضاً يجب إصلاحه: ${bad.map((x) => x.title).join("، ")}.`
      : warn.length ? `السجل سليمٌ في جوهره، و${warn.length} ملاحظة تستحق النظر.`
      : "السجل مطابقٌ تماماً: كل رقمٍ معروضٍ له ما يسنده.",
  };
}

/** الإصلاحات — كلٌّ بطلبٍ صريح، ولا شيء من تلقاء نفسه. */
export async function repair(userId: number, what: NonNullable<LedgerFinding["repair"]>): Promise<{ done: number; what: string }> {
  switch (what) {
    case "resync_counters": {
      const r = await db.execute<any>(sql`
        UPDATE email_campaigns c SET
          sent_count   = x.sent, failed_count = x.failed,
          open_count   = x.opens, click_count = x.clicks,
          reply_count  = x.replies, bounce_count = x.bounces
        FROM (
          SELECT cp.id,
            count(m.id) FILTER (WHERE m.sent_at IS NOT NULL)::int      AS sent,
            count(m.id) FILTER (WHERE m.status = 'failed')::int        AS failed,
            count(m.id) FILTER (WHERE m.opened_at IS NOT NULL)::int    AS opens,
            count(m.id) FILTER (WHERE m.clicked_at IS NOT NULL)::int   AS clicks,
            count(m.id) FILTER (WHERE m.replied_at IS NOT NULL)::int   AS replies,
            count(m.id) FILTER (WHERE m.bounced_at IS NOT NULL)::int   AS bounces
          FROM email_campaigns cp LEFT JOIN email_messages m ON m.campaign_id = cp.id
          WHERE cp.user_id = ${userId} GROUP BY cp.id
        ) x WHERE c.id = x.id AND c.user_id = ${userId}
        RETURNING c.id`);
      return { done: (((r as any).rows ?? r) as any[]).length, what: "أُعيد حساب عدّادات الحملات من رسائلها" };
    }
    case "cancel_orphans": {
      const r = await db.execute<any>(sql`
        UPDATE email_messages SET status = 'cancelled',
          error = 'ألغيت: حُذفت حملتها أو تتابعها، فلم يبقَ لها نص. الجهة ما زالت قابلة للمراسلة.'
        WHERE user_id = ${userId} AND campaign_id IS NULL AND sequence_job_id IS NULL
          AND status IN ('queued','ab_hold') RETURNING id`);
      return { done: (((r as any).rows ?? r) as any[]).length, what: "أُلغيت الرسائل التي لا جسم لها — وشركاتها تبقى قابلة للمراسلة" };
    }
    case "mark_bounced": {
      const r = await db.execute<any>(sql`
        UPDATE email_contacts c SET status = 'bounced'
        WHERE c.user_id = ${userId} AND c.status = 'active'
          AND EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.bounced_at IS NOT NULL)
        RETURNING c.id`);
      return { done: (((r as any).rows ?? r) as any[]).length, what: "عُلِّمت الجهات المرتدّة فخرجت من كل موجة" };
    }
    case "restore_policy_rejected": {
      // الجهات أولاً — قبل أن تتغيّر حالة رسائلها التي تُعرَف بها.
      const c = await db.execute<any>(sql`
        UPDATE email_contacts c SET status = 'active'
        WHERE c.user_id = ${userId} AND c.status = 'bounced'
          AND EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.sent_at IS NULL AND ${POLICY_SQL})
          AND NOT EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.bounced_at IS NOT NULL AND NOT (m.sent_at IS NULL AND ${POLICY_SQL}))
        RETURNING c.id`);
      await db.execute(sql`
        DELETE FROM email_events e USING email_messages m
        WHERE e.message_id = m.id AND m.user_id = ${userId} AND e.type = 'bounce'
          AND m.sent_at IS NULL AND ${POLICY_SQL}`);
      await db.execute(sql`
        UPDATE email_messages m SET status = 'failed', bounced_at = NULL
        WHERE m.user_id = ${userId} AND m.status = 'bounced' AND m.sent_at IS NULL AND ${POLICY_SQL}`);
      await repair(userId, "resync_counters");
      return { done: (((c as any).rows ?? c) as any[]).length, what: "أُعيدت الجهات نشطة: المزوّد رفض رسالتنا لا عناوينها" };
    }
    case "requeue_stuck": {
      // لا يُعاد إلى الطابور ما لا جسم له: ذاك يُلغى بالإصلاح الآخر.
      const r = await db.execute<any>(sql`
        UPDATE email_messages SET status = 'queued', error = NULL
        WHERE user_id = ${userId} AND status = 'ab_hold'
          AND (campaign_id IS NOT NULL OR sequence_job_id IS NOT NULL)
          AND created_at < now() - interval '72 hours' RETURNING id`);
      return { done: (((r as any).rows ?? r) as any[]).length, what: "أُعيد إلى الطابور ما حُجز لاختبار عنوانٍ لم يُحسم" };
    }
  }
}

/** ما خرج أمس واليوم، ساعةً بساعة — يقرؤه موظف السجل في تقريره. */
export async function sendingRhythm(userId: number, days = 7) {
  const r = await db.execute<any>(sql`
    SELECT (date_trunc('day', sent_at AT TIME ZONE 'Asia/Dubai'))::date AS day,
           extract(hour from sent_at AT TIME ZONE 'Asia/Dubai')::int    AS hour,
           count(*)::int AS n,
           count(*) FILTER (WHERE opened_at IS NOT NULL)::int  AS opened,
           count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM email_messages
    WHERE user_id = ${userId} AND sent_at > now() - (${days} || ' days')::interval
    GROUP BY 1, 2 ORDER BY 1 DESC, 2`);
  return ((r as any).rows ?? r) as any[];
}
