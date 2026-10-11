// ── نسبة الفتح: ما تقوله، وما لا تقوله ────────────────────────────
// أول ما يجب أن يقوله أخصائي الفتح في هذا الحساب أن الرقم المعروض ليس
// نسبة فتحٍ منخفضة بل **غياب قياس**: ٥٦٠ رسالة خرجت ولا حدث «open»
// واحد في القاعدة، لأن بكسل التتبّع لم يُركَّب أصلاً (لا عنوان عام).
// وأخصائيٌّ يحلّل «٠٪» على أنها نتيجة يبني وهماً على فراغ.
//
// وحتى بعد ضبط العنوان، نسبة الفتح أضعف الأرقام الثلاثة:
//   · Apple Mail Privacy Protection يفتح كل رسالةٍ آلياً قبل أن يراها
//     صاحبها، وGmail يُمرّر الصور عبر وسيطه. فالفتح سقفٌ متضخّم لا حقيقة.
//   · حاجب الصور يجعل قارئاً حقيقياً «لم يفتح».
// فالترتيب الصادق: ردٌّ ← نقرة ← فتح. والفتح يُقرأ **مقارنةً** — عنوانٌ
// مقابل عنوان، ساعةٌ مقابل ساعة، قطاعٌ مقابل قطاع — لا مطلقاً.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { trackingState } from "./public-url";

export interface OpensReport {
  /** هل يُقاس الفتح أصلاً. كل ما بعده مشروطٌ بهذا. */
  measurable: boolean;
  blocker: string | null;
  totals: { sent: number; opened: number; clicked: number; replied: number; openRate: number; clickRate: number; replyRate: number; proxied: number };
  /** العنوان مقابل العنوان — وهذا أول ما يرفع الفتح. */
  subjects: Array<{ subject: string; sent: number; opened: number; replied: number; rate: number }>;
  /** الساعة مقابل الساعة، بتوقيت الإمارات. */
  hours: Array<{ hour: number; sent: number; opened: number; replied: number; rate: number }>;
  /** القطاع مقابل القطاع. */
  sectors: Array<{ sector: string; sent: number; opened: number; replied: number; rate: number }>;
  /** نتائج اختبارات العنوان التي حُسمت. */
  tests: Array<{ campaign: string; winner: string | null; a: string; b: string | null; decidedAt: Date | null }>;
  /** ما يُفعل غداً — مرتّباً بالأثر. */
  actions: string[];
}

const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const rows = <T = any>(r: any): T[] => (r.rows ?? r) as T[];

/** عنوانٌ بأقل من هذا العدد لا يُقارن: فرقُه ضجيج. */
const MIN_SAMPLE = 30;

export async function opensReport(userId: number): Promise<OpensReport> {
  const tr = await trackingState(userId);

  const t = rows(await db.execute<any>(sql`
    SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int    AS sent,
           count(*) FILTER (WHERE opened_at IS NOT NULL)::int  AS opened,
           count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
           count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM email_messages WHERE user_id = ${userId}`))[0] ?? {};

  // الفتحات التي جاءت من وسيطٍ آلي لا من إنسان — تُعزل كي لا تُقرأ نجاحاً.
  const px = rows(await db.execute<any>(sql`
    SELECT count(*)::int AS n FROM email_events
    WHERE user_id = ${userId} AND type = 'open' AND (meta->>'proxied') = 'true'`))[0] ?? {};

  const sent = Number(t.sent ?? 0), opened = Number(t.opened ?? 0), clicked = Number(t.clicked ?? 0), replied = Number(t.replied ?? 0);

  // ── العنوان يُقارَن بقالبه، لا بنصّه بعد الشخصنة ──
  // `email_messages.subject` يُحفظ **مُشخصَناً** عند الإرسال، فكل صفٍّ
  // يحمل اسم شركته: «Evoke: is your AML…» و«Premier Estates: is your
  // AML…». فالتجميع عليه يعطي خمس مئة مجموعةٍ من واحدة ولا يقارن شيئاً.
  // والقالب هو الذي كُتب واحداً وأُرسل خمس مئة مرة، فهو وحدة المقارنة.
  const subjects = rows(await db.execute<any>(sql`
    SELECT coalesce(
             CASE WHEN m.variant = 'B' THEN cp.subject_b ELSE cp.subject END,
             sq.name || ' — الخطوة ' || (j.step_index + 1),
             m.subject
           ) AS subject,
           count(*)::int AS sent,
           count(*) FILTER (WHERE m.opened_at IS NOT NULL)::int  AS opened,
           count(*) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied
    FROM email_messages m
    LEFT JOIN email_campaigns cp    ON cp.id = m.campaign_id
    LEFT JOIN email_sequence_jobs j ON j.id = m.sequence_job_id
    LEFT JOIN email_sequences sq    ON sq.id = j.sequence_id
    WHERE m.user_id = ${userId} AND m.sent_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= ${MIN_SAMPLE}
    ORDER BY count(*) DESC LIMIT 25`)).map((x: any) => ({
      subject: x.subject, sent: Number(x.sent), opened: Number(x.opened), replied: Number(x.replied),
      rate: rate(Number(x.opened), Number(x.sent)),
    }));

  const hours = rows(await db.execute<any>(sql`
    SELECT extract(hour from sent_at AT TIME ZONE 'Asia/Dubai')::int AS hour, count(*)::int AS sent,
           count(*) FILTER (WHERE opened_at IS NOT NULL)::int  AS opened,
           count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM email_messages WHERE user_id = ${userId} AND sent_at IS NOT NULL
    GROUP BY 1 ORDER BY 1`)).map((x: any) => ({
      hour: Number(x.hour), sent: Number(x.sent), opened: Number(x.opened), replied: Number(x.replied),
      rate: rate(Number(x.opened), Number(x.sent)),
    }));

  const sectors = rows(await db.execute<any>(sql`
    SELECT coalesce(nullif(btrim(c.sector), ''), 'بلا قطاع') AS sector, count(*)::int AS sent,
           count(*) FILTER (WHERE m.opened_at IS NOT NULL)::int  AS opened,
           count(*) FILTER (WHERE m.replied_at IS NOT NULL)::int AS replied
    FROM email_messages m JOIN email_contacts c ON c.id = m.contact_id
    WHERE m.user_id = ${userId} AND m.sent_at IS NOT NULL
    GROUP BY 1 HAVING count(*) >= ${MIN_SAMPLE} ORDER BY 2 DESC LIMIT 15`)).map((x: any) => ({
      sector: x.sector, sent: Number(x.sent), opened: Number(x.opened), replied: Number(x.replied),
      rate: rate(Number(x.opened), Number(x.sent)),
    }));

  const tests = rows(await db.execute<any>(sql`
    SELECT name, subject AS a, subject_b AS b, ab_winner AS winner, ab_decided_at AS "decidedAt"
    FROM email_campaigns WHERE user_id = ${userId} AND subject_b IS NOT NULL
    ORDER BY coalesce(ab_decided_at, created_at) DESC LIMIT 10`)).map((x: any) => ({
      campaign: x.name, winner: x.winner, a: x.a, b: x.b, decidedAt: x.decidedAt,
    }));

  // ── ما يُفعل، مرتّباً بالأثر الحقيقي ──
  const actions: string[] = [];
  if (!tr.can) {
    actions.push(`لا شيء في هذا التقرير يُقرأ قبل ضبط العنوان العام: ${sent} رسالة خرجت بلا بكسل، فالفتحات صفرٌ لأنها لم تُقَس. هذه الخطوة الأولى ولا بديل لها.`);
    actions.push("وحتى تُضبط، اقرأ الردود وحدها: هي الرقم الوحيد الصحيح عندك الآن.");
  }
  if (sent >= MIN_SAMPLE && replied === 0) {
    actions.push(`${sent} رسالة ولا ردٌّ واحد: المشكلة ليست في العنوان بل في العرض أو الجمهور. غيّر الزاوية كاملةً قبل أن تُرسل المزيد.`);
  }
  // ما يلي يقارن الفتح — ولا يُقال حرفٌ منه حين لا يُقاس الفتح. أول
  // صيغةٍ من هذا التقرير قالت «أعلى فتحٍ في الساعة ٩ (٠٪ من ٣١)»، وهي
  // جملةٌ بلا معنى تُقرأ معلومة. الصمت أصدق.
  if (tr.can && subjects.length >= 2) {
    const best = subjects.reduce((a, b) => (b.rate > a.rate ? b : a));
    const worst = subjects.reduce((a, b) => (b.rate < a.rate ? b : a));
    if (best.rate - worst.rate >= 5) {
      actions.push(`أفضل عنوان «${best.subject.slice(0, 48)}» بـ${best.rate}٪ وأضعفه «${worst.subject.slice(0, 48)}» بـ${worst.rate}٪ — فرقٌ ${Math.round(best.rate - worst.rate)} نقطة. اكتب القادم على نمط الأول.`);
    }
    const byReply = [...subjects].sort((a, b) => rate(b.replied, b.sent) - rate(a.replied, a.sent))[0]!;
    if (byReply.replied > 0 && byReply.subject !== best.subject) {
      actions.push(`وانتبه: «${byReply.subject.slice(0, 48)}» جلب ردوداً أكثر وفتحاً أقل. الرد هو المقياس، لا الفتح.`);
    }
  }
  if (hours.length >= 3) {
    const usable = tr.can ? hours.filter((h) => h.sent >= MIN_SAMPLE) : [];
    if (usable.length >= 2) {
      const bh = usable.reduce((a, b) => (b.rate > a.rate ? b : a));
      actions.push(`أعلى فتحٍ في الساعة ${bh.hour}:00 بتوقيت الإمارات (${bh.rate}٪ من ${bh.sent}). اجعل الموجة التالية تبدأ قبلها بساعة.`);
    }
    const night = hours.filter((h) => h.hour < 7 || h.hour >= 20).reduce((n, h) => n + h.sent, 0);
    if (night > 0) actions.push(`${night} رسالة خرجت ليلاً. بريد عملٍ يصل الثالثة فجراً يُقرأ إعلاناً — ضع نافذة إرسالٍ نهارية.`);
  }
  // الردود تُقارَن دائماً: هي الرقم الوحيد الذي لا يحتاج بكسلاً.
  if (sectors.length >= 2) {
    const bs = sectors.reduce((a, b) => (rate(b.replied, b.sent) > rate(a.replied, a.sent) ? b : a));
    if (bs.replied > 0) actions.push(`أكثر قطاعٍ يردّ: ${bs.sector} (${rate(bs.replied, bs.sent)}٪ من ${bs.sent}). ضع له أكبر نصيبٍ في الموجة القادمة.`);
  } else if (sectors.length === 1 && sectors[0]!.sent >= 200) {
    actions.push(`كل ما أُرسل تقريباً لقطاعٍ واحد (${sectors[0]!.sector}: ${sectors[0]!.sent} رسالة). لا مقارنة ممكنة بين القطاعات قبل أن تُرسل لقطاعٍ ثانٍ — وفي قائمتك قطاعات أخرى لم تُلمَس.`);
  }
  const byReplyHour = hours.filter((h) => h.replied > 0).sort((a, b) => b.replied - a.replied);
  if (byReplyHour.length) {
    actions.push(`الردود وصلت من رسائل خرجت الساعات: ${byReplyHour.map((h) => `${h.hour}:00`).join("، ")} بتوقيت الإمارات. هذه إشارةٌ لا تحتاج بكسلاً — ابدأ الموجة فيها.`);
  }
  const undecided = tests.filter((x) => !x.winner);
  if (undecided.length) actions.push(`${undecided.length} اختبار عنوانٍ لم يُحسم بعد — ولن يُحسم بلا قياس فتح. احسمه بالردود أو أوقف الاختبار.`);
  if (Number(px.n) > 0 && opened > 0) {
    actions.push(`${px.n} من ${opened} فتحة جاءت من وسيط آلي (Apple أو Gmail) لا من إنسان. اخصمها قبل أن تفرح بالرقم.`);
  }
  if (!actions.length) actions.push("لا بيانات كافية بعد لحكمٍ على الفتح. أرسل موجةً واحدة كاملة ثم اقرأ هذا التقرير.");

  return {
    measurable: tr.can,
    blocker: tr.can ? null : tr.why,
    totals: { sent, opened, clicked, replied, openRate: rate(opened, sent), clickRate: rate(clicked, sent), replyRate: rate(replied, sent), proxied: Number(px.n ?? 0) },
    subjects: subjects.sort((a, b) => b.rate - a.rate),
    hours, sectors, tests, actions,
  };
}
