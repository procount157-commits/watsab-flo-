// ── إعادة الاستهداف ───────────────────────────────────────────────
// إعادة الاستهداف ليست إعادة إرسال. من فتح رسالتك ولم يردّ قرأ ما
// عندك وقرّر ألا يجيب — فإرسال الرسالة نفسها إليه يُثبّت قراره. ومن لم
// يفتح لم يرَ شيئاً، فمشكلته العنوان أو الساعة أو العنوان البريدي، لا
// المحتوى. ومن نقر رابطاً أراد شيئاً محدّداً ثم خرج.
//
// فلكل حالةٍ زاويةٌ لا تشبه غيرها، وحدٌّ لعدد اللمسات، وشرطٌ يمنع
// الموجة إن كانت ستؤذي: من راسلناه أمس لا يُراسَل اليوم، ومن طلب هدنةً
// يُمهَل، والنطاق الواحد لا يستقبل أربع رسائل في يوم.
//
// وما يُخرجه هذا الملف **خطّةٌ تُعرض ولا تُنفَّذ**: من الجمهور، وكم
// سيصل، وبأي زاوية، ولماذا الآن — ثم يضغط صاحب العمل.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { COHORTS, cohortCounts, cohortScope, type Cohort } from "./cohorts";

export interface RetargetPlan {
  cohort: Cohort;
  label: string;
  /** العدد في الحالة، والعدد الذي يصلح فعلاً للموجة الآن. */
  inCohort: number;
  eligible: number;
  /** الزاوية — ما يُكتب، وبأي عنوان، ولماذا يختلف عن السابق. */
  angle: { brief: string; subjectHint: string; why: string; cta: string };
  /** شروط تُطبَّق على الموجة قبل خروجها. */
  guards: string[];
  /** الأولوية: ما أقرب إلى المال أولاً. */
  priority: number;
  /** ما يُستبعد ولماذا — بالأرقام. */
  excluded: Array<{ reason: string; n: number }>;
  /** لا موجة الآن — والسبب. */
  blocked: string | null;
}

/**
 * الزوايا. كل واحدةٍ تُجيب سؤالاً واحداً: ماذا تغيّر منذ رسالتنا
 * السابقة ليستحق رسالةً أخرى؟ وما لا جواب له لا يُرسَل.
 */
const ANGLES: Partial<Record<Cohort, RetargetPlan["angle"]>> = {
  clicked: {
    brief: "نقر رابطاً ثم لم يكتب. الاهتمام ثابتٌ بفعلٍ لا بكلام، والناقص هو الخطوة لا الإقناع. اكتب أقصر رسالةٍ في الخيط — أربع جُمل — تفترض الاهتمام ولا تُعيد شرحه، وتقترح وقتين محدّدين لمكالمة ربع ساعة.",
    subjectHint: "سؤالٌ واحد قصير يُجاب بنعم أو لا، فيه اسم شركته. ولا تذكر أنه نقر — ذاك يُشعره بالمراقبة.",
    why: "نقر ولم يتكلّم: أقوى إشارةٍ عندك بلا ردّ.",
    cta: "وقتان محدّدان لمكالمة ربع ساعة",
  },
  opened: {
    brief: "قرأ ولم يجب. فهو يعرف من نحن وما نعرضه، ورفض الردّ على تلك الزاوية. لا تُعِد العرض: اختر ألماً واحداً محدّداً في قطاعه لم تذكره قبلاً، واطرح سؤال تأهيلٍ واحداً يُجاب بكلمة.",
    subjectHint: "زاويةٌ مختلفة تماماً عن عنوان الرسالة الأولى — إن كان الأول سؤالاً فاجعل الثاني معلومة، وبالعكس.",
    why: "فتح ولم يردّ: الرسالة وصلت وقُرئت، والزاوية هي التي فشلت.",
    cta: "سؤال تأهيل واحد يُجاب بكلمة",
  },
  silent_many: {
    brief: "رسالتان أو أكثر، ولا فتح ولا ردّ. والاحتمال الأكبر أن الرسالة لا تُرى: عنوانٌ عام يقرؤه موظف استقبال، أو تصنيفٌ في مجلد الإعلانات، أو عنوانٌ بريدي مهجور. غيّر العنوان والساعة والزاوية معاً — ولا ترسل رابعةً بالصيغة نفسها.",
    subjectHint: "أقصر ما يمكن: ثلاث أو أربع كلمات، بلا اسم خدمة، بلا كلمة عرض، وكأنها من شخصٍ لا من نظام.",
    why: "ثلاث لمساتٍ بلا أثر تعني أن العنوان أو التوقيت خطأ — لا أن الرسالة تحتاج رابعة.",
    cta: "سؤالٌ واحد قصير جداً",
  },
  silent_one: {
    brief: "لمسةٌ واحدة فقط — لم يُستنفد شيء. أغلب الردود تأتي من الرسالة الثانية والثالثة، فهذه ليست إعادة استهداف بل إكمال سلّم لم يُكمل. ابنِ على الأولى بقيمةٍ جديدة لا بتذكير.",
    subjectHint: "استمرارٌ لا تكرار: لا تبدأ بـ«متابعةً لرسالتي».",
    why: "واحدة فقط أُرسلت، والسلّم لم يُكمل.",
    cta: "قيمةٌ واحدة جديدة ثم سؤال",
  },
  fresh: {
    brief: "لم تُلمَس بعد. ليست إعادة استهداف بل استهدافٌ أول: تُختار لها حملة قطاعها من المكتبة، وتُرسل بالموجات.",
    subjectHint: "عنوان الحملة المعتمد لقطاعها.",
    why: "لم يُراسَل أحدٌ منها بعد.",
    cta: "دعوة الحملة المعتمدة لقطاعها",
  },
  replied_later: {
    brief: "ذكر موعداً، والموعد عقد. لا رسالة قبله — والنظام يمنعها. وعند حلوله: رسالةٌ تبدأ بتذكيره بما قاله هو، لا بما قلناه نحن.",
    subjectHint: "اذكر المناسبة التي ذكرها («بعد التدقيق» / «الربع الجديد»).",
    why: "موعدٌ ذكره هو، ويُحترم.",
    cta: "تأكيد الموعد الذي اختاره",
  },
  replied_considering: {
    brief: "عرضنا داخل الشركة ويُدرَس. سؤالٌ واحد بعد مهلته: هل ظهر في المراجعة ما يحتاج توضيحاً. ولا شيء غير ذلك.",
    subjectHint: "قصيرٌ ومحدّد، بلا إلحاح.",
    why: "تحت المراجعة الداخلية — والإلحاح يُخرجنا منها.",
    cta: "عرض الإجابة عن أي سؤالٍ يظهر",
  },
  replied_wrong_person: {
    brief: "العنوان خطأ. لا تبِع له: اطلب اسم المسؤول في سطرين، ثم ابنِ رسالةً جديدة للعنوان الصحيح.",
    subjectHint: "سؤالٌ عن الشخص المناسب، لا عن الخدمة.",
    why: "العنوان لا يصل صاحب القرار.",
    cta: "من المسؤول عن هذا عندكم؟",
  },
};

/** ما لا يُعاد استهدافه أبداً، ولماذا — يُقال صريحاً لا يُخفى. */
const NEVER: Partial<Record<Cohort, string>> = {
  unsubscribed: "طلبوا التوقف. لا تُراسَل أبداً — والاحترام هو ما يُعيد بعضهم بعد سنة.",
  bounced: "بريدهم يرتدّ. كل محاولةٍ ترفع نسبة الارتداد وتضرّ سمعة نطاقنا لا نطاقهم.",
  bad_domain: "نطاقٌ لا يستقبل بريداً: الإرسال ارتدادٌ مؤكّد.",
  suppressed: "دخلت القائمة لأنها راسلتنا — بائع أو نشرة أو طلب وظيفة. ليست عميلاً.",
  replied_negative: "رفضوا صريحاً. الرفض يُحترم من أول مرة.",
  replied_interested: "مهتمون الآن: هؤلاء لشخصٍ يردّ اليوم، لا لحملة.",
  replied_question: "يسألون سؤالاً محدّداً: الجواب بشريٌّ لا حملة.",
  replied_referral: "أحالونا إلى غيرهم: يُراسَل من أحالوا إليه برسالةٍ جديدة.",
  truce: "طلبوا مهلةً إلى تاريخٍ ذكروه، والنظام يمنع مراسلتهم قبله.",
  in_flight: "لها رسالةٌ في الطابور الآن. انتظر خروجها.",
  unchecked: "نطاقها غير مفحوص: الفحص أولاً، فالإرسال الأعمى يُحرق السمعة.",
  replied_other: "ردٌّ لم يُفهم مراده: يقرؤه صاحب العمل بنفسه أولاً.",
};

/**
 * من في هذه الحالة يصلح للموجة الآن — والباقي يُستبعَد بسببٍ معدود.
 * المعرّفات تُمرَّر معاملاً مربوطاً لا نصاً مُدمجاً: أول صيغةٍ بنتها
 * بـ`sql.raw` وتسلسل أرقام، وهو نمطٌ لا يصحّ ولو كانت الأرقام من
 * القاعدة نفسها — فمن يقرؤه بعد سنة قد ينسخه إلى حيث المُدخل مستخدم.
 */
async function eligibility(userId: number, cohort: Cohort, minGapDays: number) {
  const r = await db.execute<any>(sql`
    WITH base AS (${cohortScope(userId, cohort)}),
    q AS (
      SELECT id, email, last_sent_at, quiet_until,
             split_part(lower(email), '@', 2) AS dom,
             (company IS NULL OR btrim(company) = '') AS no_company,
             (sector  IS NULL OR btrim(sector)  = '') AS no_sector
      FROM base WHERE status = 'active'
    )
    SELECT
      count(*)::int                                                                   AS total,
      count(*) FILTER (WHERE last_sent_at > now() - (${minGapDays} || ' days')::interval)::int AS too_soon,
      count(*) FILTER (WHERE quiet_until IS NOT NULL AND quiet_until > now())::int     AS in_truce,
      count(*) FILTER (WHERE no_company)::int                                          AS no_company,
      count(*) FILTER (WHERE no_sector)::int                                           AS no_sector,
      (SELECT coalesce(sum(n - 1), 0)::int FROM (SELECT count(*) n FROM q GROUP BY dom HAVING count(*) > 1) d) AS same_domain
    FROM q`);
  return (((r as any).rows ?? r) as any[])[0] ?? {};
}

/**
 * الخطط كاملةً، مرتّبةً بالأولوية. تُقرأ ولا تُنفّذ.
 * `minGapDays` هو أقل ما يُحترم بين رسالتين للشركة نفسها.
 */
export async function retargetPlans(userId: number, opts: { minGapDays?: number } = {}): Promise<{ plans: RetargetPlan[]; excludedCohorts: Array<{ label: string; n: number; why: string }>; headline: string }> {
  const minGapDays = opts.minGapDays ?? 3;
  const counts = await cohortCounts(userId);

  const plans: RetargetPlan[] = [];
  for (const { cohort, n, info } of counts) {
    const angle = ANGLES[cohort];
    if (!angle || n === 0) continue;
    const e = await eligibility(userId, cohort, minGapDays);
    const excluded = [
      { reason: `راسلناهم قبل أقل من ${minGapDays} أيام`, n: Number(e.too_soon ?? 0) },
      { reason: "هدنة بطلبهم", n: Number(e.in_truce ?? 0) },
      { reason: "عناوين إضافية لنطاقٍ موجود في الموجة", n: Number(e.same_domain ?? 0) },
      { reason: "بلا اسم شركة — الشخصنة مستحيلة", n: Number(e.no_company ?? 0) },
    ].filter((x) => x.n > 0);
    const eligible = Math.max(0, Number(e.total ?? 0) - excluded.reduce((s, x) => s + x.n, 0));
    plans.push({
      cohort, label: info.label, inCohort: n, eligible, angle,
      priority: info.rank, excluded,
      guards: [
        `لا رسالة لشركةٍ راسلناها خلال ${minGapDays} أيام.`,
        "عنوانٌ واحد لكل نطاق في هذه الموجة — والبقية تنتظر من لم يردّ.",
        "من طلب هدنةً أو رفض أو ارتدّ بريده لا يدخل، ولا يُمكن أن يدخل.",
        `الحصة اليومية تُوزّع الموجة على أيام: ${eligible > 300 ? `${Math.ceil(eligible / 300)} أيام على الأقل` : "يوم واحد"}.`,
      ],
      blocked: eligible === 0
        ? Number(e.too_soon ?? 0) > 0
          ? `لا أحد الآن: كل من في هذه الحالة راسلناه خلال ${minGapDays} أيام. انتظر.`
          : "لا أحد مؤهّلاً الآن في هذه الحالة."
        : null,
    });
  }

  const excludedCohorts = counts
    .filter((c) => c.n > 0 && NEVER[c.cohort])
    .map((c) => ({ label: c.info.label, n: c.n, why: NEVER[c.cohort]! }));

  const top = plans.filter((p) => p.eligible > 0).sort((a, b) => a.priority - b.priority)[0];
  return {
    plans: plans.sort((a, b) => a.priority - b.priority),
    excludedCohorts,
    headline: top
      ? `ابدأ بـ«${top.label}»: ${top.eligible} جهة مؤهّلة الآن، و${top.angle.why}`
      : "لا موجة إعادة استهدافٍ مؤهّلة الآن — كل من يصلح راسلناه حديثاً.",
  };
}

/**
 * الملخّص الذي يُعطى للموظف في تعليماته: مضغوطٌ بحساب، فالمزوّد المجاني
 * يعطي ٨٠٠٠ رمزاً في الدقيقة لكل شيء.
 */
export function retargetBrief(r: Awaited<ReturnType<typeof retargetPlans>>, limit = 4): string {
  const lines = r.plans.filter((p) => p.eligible > 0).slice(0, limit).map((p) =>
    `• ${p.label}: ${p.eligible} مؤهّلة من ${p.inCohort}. الزاوية: ${p.angle.brief.slice(0, 190)} الدعوة: ${p.angle.cta}.`);
  const skipped = r.excludedCohorts.slice(0, 4).map((x) => `${x.label} (${x.n})`).join("، ");
  return [
    "— حالة الجمهور الآن —",
    r.headline,
    ...lines,
    skipped ? `ولا تُمسّ: ${skipped}.` : "",
    "— انتهت الحالة —",
  ].filter(Boolean).join("\n");
}
