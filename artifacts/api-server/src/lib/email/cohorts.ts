// ── كل الداتا، مُصنَّفة ────────────────────────────────────────────
// الطلب كان: «يرتّب كل الداتا — اللي استهدفناها، واللي فتح، واللي ما
// فتح، واللي تم التواصل معه». وهذا لا يُحلّ بتعليماتٍ لموظف: النموذج لا
// يرى ثمانية آلاف صفٍّ ولا يُفترض به أن يراها. يُحلّ بمحرّك يقرأ القاعدة
// ويضع كل جهةٍ في **حالةٍ واحدة** لا تشبه غيرها، ثم يُعطى الموظفُ
// الأرقام فيحكم عليها.
//
// مبدأ التصميم: الحالات متعارضة تماماً — لا جهة في حالتين. فمجموعها
// يساوي عدد الجهات بالضبط، ولو زاد أو نقص فذاك خطأٌ يُرى فوراً لا
// تقديرٌ يُجمَّل. وترتيب الأولوية هو الحكم: من ألغى اشتراكه لا يُسأل
// بعدها هل فتح.
//
// وفوق الحالة طبقةٌ ثانية: جودة الصف نفسه — بلا اسم شركة، بلا قطاع،
// عنوانٌ عام (info@) لا شخص، نطاقٌ لا يستقبل، صفٌّ مضى عليه شهور ولم
// يُراسَل. هذه ليست حالاتٍ متعارضة بل عيوبٌ تتجمّع، فتُعدّ وحدها.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Cohort =
  // أُغلقت
  | "unsubscribed" | "bounced" | "suppressed" | "bad_domain"
  // تنتظر بطلبها
  | "truce"
  // ردّت — مقسومةٌ بما قالته، فالخطوة تختلف اختلافاً كاملاً
  | "replied_interested" | "replied_question" | "replied_considering"
  | "replied_later" | "replied_referral" | "replied_wrong_person"
  | "replied_negative" | "replied_other"
  // قيد الإرسال الآن
  | "in_flight"
  // راسلناها ولم تردّ
  | "clicked" | "opened" | "silent_many" | "silent_one"
  // لم تُراسَل
  | "unchecked" | "fresh";

export interface CohortInfo {
  /** بالعربية لصاحب العمل. */
  label: string;
  /** ما يعنيه وجود جهةٍ هنا — جملةٌ واحدة. */
  means: string;
  /** الخطوة التالية لهذه الفئة كلها. */
  next: string;
  /** الموظف الذي يملكها. */
  owner: string;
  /** هل تصلح لإعادة استهداف — وهذا هو السؤال الذي تُبنى عليه الموجات. */
  retarget: boolean;
  /** ترتيب العرض: الأقرب للمال أولاً. */
  rank: number;
}

export const COHORTS: Record<Cohort, CohortInfo> = {
  replied_interested: { label: "ردّوا: مهتمون", means: "طلبوا سعراً أو موعداً أو تفاصيل", next: "لا حملة ولا متابعة آلية — ردٌّ بشري اليوم", owner: "ليلى", retarget: false, rank: 1 },
  replied_question:   { label: "ردّوا: يسألون", means: "سؤالٌ محدّد ينتظر جواباً", next: "أجب على سؤاله بالتحديد، ثم اطلب خطوة", owner: "ليلى", retarget: false, rank: 2 },
  clicked:            { label: "نقروا ولم يردّوا", means: "فتحوا ونقروا رابطاً — أقوى إشارة بلا كلام", next: "دعوةٌ مباشرة لمكالمة قصيرة: الاهتمام ثابت والكلام ناقص", owner: "يوسف", retarget: true, rank: 3 },
  replied_considering: { label: "ردّوا: تحت المراجعة", means: "عرضنا داخل الشركة ويُدرَس", next: "لا تُلِحّ — هدنةٌ ثم سؤالٌ واحد عن نتيجة المراجعة", owner: "ليلى", retarget: false, rank: 4 },
  replied_later:      { label: "ردّوا: ليس الآن", means: "ذكروا موعداً أو مناسبة", next: "يُراسَلون في الموعد الذي ذكروه، لا قبله", owner: "يوسف", retarget: false, rank: 5 },
  replied_referral:   { label: "ردّوا: حوّلونا", means: "أحالونا إلى شخصٍ أو قسمٍ آخر", next: "راسل من أحالوك إليه ذاكراً اسم من أحالك", owner: "ليلى", retarget: false, rank: 6 },
  opened:             { label: "فتحوا ولم يردّوا", means: "قرأوا ولم يتكلّموا", next: "زاويةٌ جديدة من قطاعهم وسؤال تأهيل واحد", owner: "يوسف", retarget: true, rank: 7 },
  replied_wrong_person: { label: "ردّوا: ليس الشخص المناسب", means: "العنوان خطأ أو غادر الشركة", next: "اسأل عن المسؤول، وغيّر العنوان في القائمة", owner: "سالم", retarget: false, rank: 8 },
  silent_many:        { label: "راسلناهم مراراً بلا أثر", means: "رسالتان أو أكثر، ولا فتح ولا ردّ", next: "غيّر الزاوية والعنوان تماماً — أو راجع صحة العنوان نفسه", owner: "يوسف", retarget: true, rank: 9 },
  silent_one:         { label: "رسالةٌ واحدة بلا ردّ", means: "لمسةٌ واحدة فقط — لم يُستنفد شيء", next: "أكمل سلّم المتابعة، فأغلب الردود تأتي من الثانية والثالثة", owner: "يوسف", retarget: true, rank: 10 },
  fresh:              { label: "لم تُراسَل — جاهزة", means: "عنوانٌ صالح لم يُلمَس بعد", next: "تدخل موجةً جديدة بحملة قطاعها", owner: "سلمى", retarget: true, rank: 11 },
  in_flight:          { label: "قيد الإرسال الآن", means: "لها رسالةٌ في الطابور أو خطوةٌ قادمة", next: "لا شيء — انتظر خروجها قبل أي قرار", owner: "ماجد", retarget: false, rank: 12 },
  unchecked:          { label: "لم تُراسَل — نطاقها غير مفحوص", means: "لا نعرف إن كان النطاق يستقبل بريداً", next: "فحص النطاق قبل أي إرسال — الإرسال الأعمى يُحرق السمعة", owner: "ماجد", retarget: false, rank: 13 },
  truce:              { label: "هدنة بطلبهم", means: "طلبوا أن نمهلهم إلى تاريخٍ ذكروه", next: "لا تُراسَل قبل تاريخها — والنظام يمنع ذلك تلقائياً", owner: "يوسف", retarget: false, rank: 14 },
  replied_negative:   { label: "ردّوا: غير مهتمين", means: "رفضٌ صريح", next: "تُحترم ولا تُراسَل — ومن يُحترم رفضه يعود بعد سنة", owner: "ليلى", retarget: false, rank: 15 },
  replied_other:      { label: "ردّوا: غير واضح", means: "ردٌّ لم يُفهم مراده", next: "يقرؤه صاحب العمل بنفسه قبل أي رد", owner: "ليلى", retarget: false, rank: 16 },
  bad_domain:         { label: "نطاقٌ لا يستقبل", means: "فحص النطاق فشل — الإرسال إليه ارتدادٌ مؤكّد", next: "تُستبعَد من كل موجة، وتُصحَّح العناوين إن كان الخطأ كتابياً", owner: "ماجد", retarget: false, rank: 17 },
  bounced:            { label: "ارتدّ بريدها", means: "العنوان غير موجود أو مرفوض", next: "لا تُراسَل أبداً — كل محاولةٍ تضرّ سمعة النطاق", owner: "ماجد", retarget: false, rank: 18 },
  unsubscribed:       { label: "ألغوا الاشتراك", means: "طلبوا التوقف", next: "لا تُراسَل أبداً، ولا تُحذف — السجل هو ما يحمينا", owner: "ماجد", retarget: false, rank: 19 },
  suppressed:         { label: "مُستبعَدة — ليست عميلاً", means: "دخلت القائمة لأنها راسلتنا: بائع، نشرة، طلب وظيفة", next: "تبقى مُستبعَدة — ولا تُدخل أي موجة", owner: "سالم", retarget: false, rank: 20 },
};

/**
 * الحالة الواحدة لكل جهة، بترتيب أولويةٍ هو نفسه حكمُ العمل:
 * من أُغلق ملفه لا يُسأل هل فتح، ومن ردّ لا يُعدّ صامتاً.
 */
const COHORT_SQL = sql`
  CASE
    WHEN c.status = 'unsubscribed'                      THEN 'unsubscribed'
    WHEN c.status = 'bounced'                           THEN 'bounced'
    WHEN c.status = 'suppressed'                        THEN 'suppressed'
    WHEN c.mx_ok = false                                THEN 'bad_domain'
    WHEN c.quiet_until IS NOT NULL
     AND c.quiet_until > now()                          THEN 'truce'
    WHEN c.last_replied_at IS NOT NULL THEN
      CASE li.last_intent
        WHEN 'interested'     THEN 'replied_interested'
        WHEN 'question'       THEN 'replied_question'
        WHEN 'considering'    THEN 'replied_considering'
        WHEN 'later'          THEN 'replied_later'
        WHEN 'referral'       THEN 'replied_referral'
        WHEN 'wrong_person'   THEN 'replied_wrong_person'
        WHEN 'not_interested' THEN 'replied_negative'
        WHEN 'opt_out'        THEN 'replied_negative'
        WHEN 'complaint'      THEN 'replied_negative'
        ELSE 'replied_other'
      END
    WHEN f.in_flight > 0                                THEN 'in_flight'
    WHEN f.clicks  > 0                                  THEN 'clicked'
    WHEN f.opens   > 0                                  THEN 'opened'
    WHEN f.sent   >= 2                                  THEN 'silent_many'
    WHEN f.sent    = 1                                  THEN 'silent_one'
    WHEN c.mx_ok IS NULL                                THEN 'unchecked'
    ELSE 'fresh'
  END`;

/** الوقائع التي يُبنى عليها الحكم — مرةً واحدة لكل جهة. */
const FACTS = sql`
  LEFT JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE m.sent_at IS NOT NULL)::int                        AS sent,
      coalesce(sum(m.open_count)  FILTER (WHERE m.sent_at IS NOT NULL), 0)::int AS opens,
      coalesce(sum(m.click_count) FILTER (WHERE m.sent_at IS NOT NULL), 0)::int AS clicks,
      count(*) FILTER (WHERE m.status IN ('queued','ab_hold'))::int             AS in_flight,
      max(m.sent_at)                                                            AS last_sent
    FROM email_messages m WHERE m.contact_id = c.id
  ) f ON true
  LEFT JOIN LATERAL (
    SELECT i.intent AS last_intent
    FROM email_inbound i
    WHERE i.contact_id = c.id AND coalesce(i.kind, 'reply') = 'reply'
    ORDER BY i.received_at DESC LIMIT 1
  ) li ON true`;

export interface CohortCount { cohort: Cohort; n: number; info: CohortInfo }

/**
 * العدد في كل حالة. ومجموعُها يساوي عدد الجهات بالضبط — وهذا
 * مُختبَر، لأن تصنيفاً تتسرّب منه الصفوف أسوأ من لا تصنيف.
 */
export async function cohortCounts(userId: number, listId?: number | null): Promise<CohortCount[]> {
  const scope = listId
    ? sql`AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${listId})`
    : sql``;
  const r = await db.execute<{ cohort: string; n: number }>(sql`
    SELECT cohort, count(*)::int AS n FROM (
      SELECT ${COHORT_SQL} AS cohort
      FROM email_contacts c
      ${FACTS}
      WHERE c.user_id = ${userId} ${scope}
    ) q GROUP BY cohort`);
  const rows = (r as any).rows ?? r;
  const found = new Map<string, number>(rows.map((x: any) => [x.cohort, Number(x.n)]));
  return (Object.keys(COHORTS) as Cohort[])
    .map((cohort) => ({ cohort, n: found.get(cohort) ?? 0, info: COHORTS[cohort] }))
    .sort((a, b) => a.info.rank - b.info.rank);
}

/** جهات حالةٍ واحدة — للعرض، ولبناء موجة إعادة استهداف منها. */
export async function cohortMembers(userId: number, cohort: Cohort, opts: { limit?: number; page?: number; listId?: number | null } = {}) {
  const limit = Math.min(500, opts.limit ?? 100), offset = (opts.page ?? 0) * limit;
  const scope = opts.listId
    ? sql`AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${opts.listId})`
    : sql``;
  const r = await db.execute<any>(sql`
    SELECT * FROM (
      SELECT c.id, c.email, c.company, c.name, c.sector, c.city, c.status, c.tags,
             c.quiet_until AS "quietUntil", c.quiet_reason AS "quietReason",
             f.sent, f.opens, f.clicks, f.last_sent AS "lastSentAt",
             c.last_replied_at AS "repliedAt", li.last_intent AS "lastIntent",
             ${COHORT_SQL} AS cohort
      FROM email_contacts c
      ${FACTS}
      WHERE c.user_id = ${userId} ${scope}
    ) q
    WHERE cohort = ${cohort}
    ORDER BY coalesce(clicks, 0) DESC, coalesce(opens, 0) DESC, "lastSentAt" DESC NULLS LAST
    LIMIT ${limit} OFFSET ${offset}`);
  return ((r as any).rows ?? r) as any[];
}

/** معرّفات حالةٍ كاملةً — تُسلَّم لبناء الموجة، بلا صفحات. */
export async function cohortIds(userId: number, cohort: Cohort, opts: { limit?: number; listId?: number | null } = {}): Promise<number[]> {
  const limit = Math.min(20_000, opts.limit ?? 5_000);
  const scope = opts.listId
    ? sql`AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${opts.listId})`
    : sql``;
  const r = await db.execute<{ id: number }>(sql`
    SELECT id FROM (
      SELECT c.id, ${COHORT_SQL} AS cohort, f.clicks, f.opens, f.last_sent
      FROM email_contacts c ${FACTS}
      WHERE c.user_id = ${userId} ${scope}
    ) q WHERE cohort = ${cohort}
    ORDER BY coalesce(clicks,0) DESC, coalesce(opens,0) DESC, last_sent ASC NULLS FIRST
    LIMIT ${limit}`);
  return (((r as any).rows ?? r) as any[]).map((x) => Number(x.id));
}

/**
 * صفوف حالةٍ واحدة كجزءٍ من استعلامٍ أكبر — تُركَّب في `WITH` عند من
 * يحتاج أن يبني فوقها. والبديل كان تمرير عشرين ألف معرّفٍ معاملاً،
 * ودرايزل يُفرِد المصفوفات إلى معاملاتٍ منفصلة فيأخذ أولها ويسقط البقية.
 */
export function cohortScope(userId: number, cohort: Cohort, listId?: number | null) {
  const scope = listId
    ? sql`AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${listId})`
    : sql``;
  return sql`
    SELECT * FROM (
      SELECT c.id, c.email, c.company, c.sector, c.status,
             c.last_sent_at, c.quiet_until,
             ${COHORT_SQL} AS cohort
      FROM email_contacts c ${FACTS}
      WHERE c.user_id = ${userId} ${scope}
    ) z WHERE z.cohort = ${cohort}`;
}

// ── الطبقة الثانية: جودة الصف نفسه ────────────────────────────────
// هذه عيوبٌ تتجمّع ولا تتعارض: صفٌّ واحد قد يكون بلا قطاع وعنوانه عام
// ونطاقه غير مفحوص. فتُعدّ كل واحدة وحدها، ولا تُجمع.

export interface QualityFlag {
  id: string; label: string; n: number;
  /** لماذا يهمّ — لا وصفٌ للعيب بل أثره على النتيجة. */
  why: string;
  fix: string;
}

/** عناوين الأقسام لا الأشخاص: تُقرأ أقل وتُحوَّل أكثر. */
const ROLE_ADDR = `^(info|sales|admin|contact|support|hello|enquiry|enquiries|inquiry|office|mail|email|general|reception|hr|careers|jobs|accounts|accounting|finance|marketing|team|service|customercare|help|no-?reply)@`;

export async function dataQuality(userId: number): Promise<{ total: number; flags: QualityFlag[] }> {
  const r = await db.execute<any>(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE c.company IS NULL OR btrim(c.company) = '')::int        AS no_company,
      count(*) FILTER (WHERE c.sector  IS NULL OR btrim(c.sector)  = '')::int        AS no_sector,
      count(*) FILTER (WHERE c.city    IS NULL OR btrim(c.city)    = '')::int        AS no_city,
      count(*) FILTER (WHERE c.name    IS NULL OR btrim(c.name)    = '')::int        AS no_person,
      count(*) FILTER (WHERE c.email ~* ${ROLE_ADDR})::int                           AS role_addr,
      count(*) FILTER (WHERE c.email ~* '@(gmail|hotmail|outlook|yahoo|live|aol|icloud|protonmail)\\.')::int AS freemail,
      count(*) FILTER (WHERE c.mx_ok IS NULL)::int                                   AS mx_unknown,
      count(*) FILTER (WHERE c.mx_ok = false)::int                                   AS mx_bad,
      count(*) FILTER (WHERE c.created_at < now() - interval '90 days'
                         AND c.last_sent_at IS NULL)::int                            AS stale,
      count(*) FILTER (WHERE c.phone IS NOT NULL AND btrim(c.phone) <> '')::int       AS has_phone
    FROM email_contacts c WHERE c.user_id = ${userId}`);
  const q = (((r as any).rows ?? r) as any[])[0] ?? {};

  // نطاقٌ واحد بعناوين كثيرة: إرسال خمسٍ إلى الشركة نفسها إزعاجٌ لا تغطية.
  const d = await db.execute<any>(sql`
    SELECT count(*)::int AS domains, coalesce(sum(n - 1), 0)::int AS extra FROM (
      SELECT split_part(lower(email), '@', 2) AS dom, count(*)::int AS n
      FROM email_contacts WHERE user_id = ${userId} AND status = 'active'
      GROUP BY 1 HAVING count(*) > 1
    ) x`);
  const dup = (((d as any).rows ?? d) as any[])[0] ?? { domains: 0, extra: 0 };

  const flags: QualityFlag[] = [
    { id: "no_company", label: "بلا اسم شركة", n: Number(q.no_company ?? 0),
      why: "الشخصنة إلزامية في عقيدة الفريق: رسالةٌ بلا اسم الشركة في العنوان أو السطر الأول رسالةٌ عامة تُحذف.",
      fix: "املأ اسم الشركة من الملف الأصلي، أو استبعدها من الموجات حتى يُملأ." },
    { id: "no_sector", label: "بلا قطاع", n: Number(q.no_sector ?? 0),
      why: "القطاع هو ما يختار الحملة: بلا قطاعٍ تذهب الجهة في حملةٍ عامة، وهي أضعف ما يُرسَل.",
      fix: "دع نورة تستنتج القطاع من اسم الشركة، أو عيّنه للملف كله عند الرفع." },
    { id: "no_person", label: "بلا اسم شخص", n: Number(q.no_person ?? 0),
      why: "{{first_name}} يسقط إلى بديله، فتبدأ الرسالة بتحيةٍ عامة.",
      fix: "ليس عائقاً — القوالب تحمل بديلاً. لكن معرفة الاسم ترفع الردّ." },
    { id: "role_addr", label: "عناوين أقسام لا أشخاص", n: Number(q.role_addr ?? 0),
      why: "info@ وsales@ يقرؤها موظف استقبال لا صاحب قرار. تُفتح أقل وتُحوَّل أقل بكثير.",
      fix: "ابحث عن عنوان المالك أو المدير المالي لهذه الشركات — أو اجعل رسالتها تطلب التحويل صريحاً." },
    { id: "freemail", label: "عناوين مجانية", n: Number(q.freemail ?? 0),
      why: "gmail وhotmail لشركةٍ يعني عملاً صغيراً جداً أو عنواناً شخصياً — ونسبة الإزعاج فيها أعلى.",
      fix: "أبقِها في موجةٍ منفصلة لتُقاس وحدها، ولا تخلطها بنطاقات الشركات." },
    { id: "mx_unknown", label: "نطاقات غير مفحوصة", n: Number(q.mx_unknown ?? 0),
      why: "إرسالٌ أعمى: كل عنوانٍ لا يستقبل يرتدّ، والارتداد يُحرق سمعة نطاقنا لا نطاقه.",
      fix: "يُفحَص تلقائياً قبل أول إرسال — أو افحصه الآن من صفحة الجمهور." },
    { id: "mx_bad", label: "نطاقات لا تستقبل", n: Number(q.mx_bad ?? 0),
      why: "ارتدادٌ مؤكّد. هذه وحدها قادرة على رفع نسبة الارتداد فوق ٣٪ وإيقاف الإرسال كله.",
      fix: "مُستبعَدة تلقائياً. راجع عيّنةً منها: كثيرٌ منها خطأٌ كتابي في الملف الأصلي." },
    { id: "stale", label: "صفوف قديمة لم تُراسَل", n: Number(q.stale ?? 0),
      why: "عناوين مضى عليها أكثر من ثلاثة أشهر بلا لمسة: نسبة منها أُغلقت أو تغيّرت، والشركة نفسها قد تكون تبدّلت.",
      fix: "أعد فحص نطاقاتها قبل إدخالها موجةً، وابدأ بأحدثها." },
    { id: "dup_domain", label: "عناوين متعدّدة لنطاقٍ واحد", n: Number(dup.extra ?? 0),
      why: `${Number(dup.domains ?? 0)} نطاقاً له أكثر من عنوان. أربع رسائل إلى الشركة نفسها في يومٍ واحد إزعاجٌ لا تغطية، وأسرع طريق إلى بلاغ.`,
      fix: "اختر عنواناً واحداً لكل نطاق في الموجة الأولى، واحتفظ بالبقية لمن لم يردّ." },
  ].filter((f) => f.n > 0).sort((a, b) => b.n - a.n);

  return { total: Number(q.total ?? 0), flags };
}

/**
 * الصورة كاملةً كما يقرؤها الموظف قبل أن يحكم: الحالات، والجودة،
 * وسطرٌ واحد يقول أين المال الآن.
 */
export async function dataPicture(userId: number, listId?: number | null) {
  const [counts, quality] = await Promise.all([cohortCounts(userId, listId), dataQuality(userId)]);
  const n = (c: Cohort) => counts.find((x) => x.cohort === c)?.n ?? 0;
  const total = counts.reduce((s, x) => s + x.n, 0);
  const reachable = n("fresh") + n("silent_one") + n("silent_many") + n("opened") + n("clicked");
  const closed = n("unsubscribed") + n("bounced") + n("suppressed") + n("bad_domain") + n("replied_negative");
  const warm = n("replied_interested") + n("replied_question") + n("clicked");

  return {
    total, counts, quality,
    summary: {
      reachable, closed, warm,
      touched: total - n("fresh") - n("unchecked"),
      untouched: n("fresh") + n("unchecked"),
      retargetable: counts.filter((x) => x.info.retarget).reduce((s, x) => s + x.n, 0),
    },
    headline: warm > 0
      ? `${warm} جهة أقرب ما لديك إلى المال الآن: ${n("replied_interested")} مهتم، ${n("replied_question")} يسأل، ${n("clicked")} نقر ولم يتكلّم.`
      : n("opened") > 0
        ? `لا ردود دافئة اليوم. أقرب ما لديك ${n("opened")} جهة فتحت ولم تردّ — تحتاج زاوية جديدة لا رسالة مكرّرة.`
        : `${n("fresh")} جهة لم تُلمَس بعد، و${n("silent_one")} لمسةٍ واحدة لم تُستكمل. العمل كله أمامك لا خلفك.`,
  };
}
