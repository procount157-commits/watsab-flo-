// ── بطاقات الأداء ─────────────────────────────────────────────────
// كل درجة استعلامٌ على صفوف حقيقية، ومعها كيف حُسبت، وعلى كم صفّ، وأرقام الصفوف نفسها.
// عيّنةٌ دون الحد: الحالة الحرفية INSUFFICIENT DATA، بلا رقم. موظفٌ جديد: بلا درجة.
//
// لا مقياس هنا يكافئ الكمّ: الردود النافعة تُقسم على الشركات التي وصلها الكاتب، لا تُعدّ
// مجرّدة. والفتح لا يدخل أي درجة: فتحات الآلة لها سطرها (machine_open في routes/track.ts)،
// والفتح الباقي إشارةٌ لا نتيجة.
//
// الدرجة المجمَّعة متوسط موزون لما توفّرت عيّنته، ولا تُعطى إلا إن غطّى الموفَّر نصف وزن
// النموذج على الأقل. أوزان الدور ٦٠ وأوزان العموم ٤٠: موظفٌ لا نتيجة تُقاس له لا يأخذ درجة
// من مجرّد أنه يعمل بلا أخطاء.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { employeeKeyOf, intervalOf } from "./departments";
import { ensureOrgTables } from "./schema";
import { FREE_MAIL } from "../email/service";
import { MIN_SAMPLE as RESULTS_MIN_SAMPLE, SCALE_RATE } from "../email/results";
import { REAL_TASK } from "./sim-schema";

export const INSUFFICIENT = "INSUFFICIENT DATA" as const;
export type ScoreStatus = "OK" | typeof INSUFFICIENT;
export type PeriodName = "weekly" | "monthly";
export type Confidence = "none" | "low" | "medium" | "high";
export type ModelName = "general" | "copywriter" | "analyst" | "reply_specialist" | "conversation" | "followup" | "researcher" | "operations";
export type EvidenceRefs = Record<string, Array<number | string>>;

export const PERIOD_DAYS: Record<PeriodName, number> = { weekly: 7, monthly: 30 };
/** من وُظّف قبل أقل من هذا لا درجة له: لم يُعطَ وقتاً يُحكم به عليه. */
export const NEW_EMPLOYEE_DAYS = 14;
/** أقل وزنٍ موفَّر من وزن النموذج لتُعطى درجة مجمَّعة. */
export const MIN_WEIGHT_SHARE = 0.5;
const EVIDENCE_CAP = 20;

export interface Metric {
  key: string; label: string; status: ScoreStatus;
  value: number | null; unit: "ratio" | "ms" | "count"; score: number | null;
  weight: number; sampleSize: number; minSample: number; calculation: string; evidence: EvidenceRefs;
}
export interface Trend { direction: "up" | "down" | "flat" | "unknown"; previousScore: number | null; delta: number | null }
export interface Scorecard {
  employeeKey: string; role: string; model: ModelName; period: PeriodName; periodKey: string; periodStart: string; periodEnd: string;
  status: ScoreStatus; score: number | null; calculation: string; sampleSize: number; confidence: Confidence; trend: Trend;
  evidence: EvidenceRefs; metrics: Metric[]; note?: string; live?: boolean;
}

// ── الحساب النقي ──────────────────────────────────────────────────
const clamp = (x: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface MetricSpec { key: string; label: string; weight: number; minSample: number; unit?: Metric["unit"] }

/** مقياسٌ من عدّه وقيمته. دون الحد: لا قيمة ولا درجة، أيّاً كان ما حُسب. Pure. */
export function buildMetric(spec: MetricSpec, n: number, value: number | null, score: number | null, calculation: string, evidence: EvidenceRefs = {}): Metric {
  const base = { key: spec.key, label: spec.label, unit: spec.unit ?? "ratio" as const, weight: spec.weight, sampleSize: n, minSample: spec.minSample, evidence };
  if (n < spec.minSample || value == null || !Number.isFinite(value)) {
    return { ...base, status: INSUFFICIENT, value: null, score: null, calculation: `${INSUFFICIENT}: العيّنة ${n} والحد ${spec.minSample}. ${calculation}` };
  }
  return { ...base, status: "OK", value: Math.round(value * 10000) / 10000, score: score == null ? null : round2(clamp(score)), calculation };
}

/** ثقةٌ من حجم العيّنة بالنسبة إلى حدّها. Pure. */
export function confidenceFrom(n: number, min: number): Confidence {
  if (min <= 0 || n < min) return "none";
  if (n < 2 * min) return "low";
  return n < 5 * min ? "medium" : "high";
}

/** ما يدخل الدرجة: وزنٌ موجب ورقم. */
const scored = (m: Metric) => m.status === "OK" && m.weight > 0 && m.score != null;

/** الدرجة المجمَّعة. دون نصف وزن النموذج: لا رقم. Pure. */
export function composite(metrics: Metric[]): { score: number | null; status: ScoreStatus; sampleSize: number; confidence: Confidence; calculation: string } {
  const total = metrics.reduce((a, m) => a + m.weight, 0);
  const ok = metrics.filter(scored);
  const okWeight = ok.reduce((a, m) => a + m.weight, 0);
  const sampleSize = ok.reduce((a, m) => a + m.sampleSize, 0);
  if (!total || okWeight / total < MIN_WEIGHT_SHARE) {
    return { score: null, status: INSUFFICIENT, sampleSize: metrics.reduce((a, m) => a + m.sampleSize, 0), confidence: "none", calculation: `${INSUFFICIENT}: توفّر ${okWeight} من وزن ${total}، والمطلوب نصفه على الأقل. ما نقص: ${metrics.filter((m) => m.weight > 0 && !scored(m)).map((m) => m.key).join("، ") || "لا شيء"}.` };
  }
  const score = round2(ok.reduce((a, m) => a + m.score! * m.weight, 0) / okWeight);
  const order: Confidence[] = ["none", "low", "medium", "high"];
  const confidence = ok.map((m) => confidenceFrom(m.sampleSize, m.minSample)).reduce((lo, c) => (order.indexOf(c) < order.indexOf(lo) ? c : lo), "high" as Confidence);
  return { score, status: "OK", sampleSize, confidence, calculation: `متوسط موزون: ${ok.map((m) => `${m.key}=${m.score}×${m.weight}`).join(" + ")} ÷ ${okWeight}. دون العيّنة ولم يدخل: ${metrics.filter((m) => m.weight > 0 && !scored(m)).map((m) => m.key).join("، ") || "لا شيء"}.` };
}

/**
 * الاتجاه مقارنةً بالفترة السابقة، على المقاييس التي توفّرت في الفترتين فقط، فالاختلاف
 * لا يأتي من أن سجل التنفيذ يُحذف بعد ثلاثين يوماً. Pure.
 */
export function trendOf(cur: Metric[], prev: Metric[], eps = 1): Trend {
  const p = new Map(prev.filter(scored).map((m) => [m.key, m]));
  const common = cur.filter((m) => scored(m) && p.has(m.key));
  const weight = common.reduce((a, m) => a + m.weight, 0);
  if (!weight) return { direction: "unknown", previousScore: null, delta: null };
  const a = common.reduce((s, m) => s + m.score! * m.weight, 0) / weight;
  const b = common.reduce((s, m) => s + p.get(m.key)!.score! * m.weight, 0) / weight;
  const delta = round2(a - b);
  return { direction: Math.abs(delta) < eps ? "flat" : delta > 0 ? "up" : "down", previousScore: round2(b), delta };
}

export const isNewEmployee = (createdAt: Date | string | null | undefined, now = Date.now()) =>
  !createdAt || now - new Date(createdAt).getTime() < NEW_EMPLOYEE_DAYS * 86_400_000;

const isoWeek = (t: Date) => {
  const d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d.getTime() - y.getTime()) / 86_400_000 + 1) / 7)).padStart(2, "0")}`;
};
/** مفتاح الفترة بتوقيت دبي: weekly:2026-W46 أو monthly:2026-11. Pure. */
export function periodKeyOf(period: PeriodName, now = new Date()): string {
  const d = new Date(now.getTime() + 4 * 3_600_000);
  return period === "weekly" ? `weekly:${isoWeek(d)}` : `monthly:${d.toISOString().slice(0, 7)}`;
}

/** زمن الرد: ساعةٌ فأقل كاملة، ويوم فأكثر صفر، وخطي بينهما. Pure. */
export function responseTimeScore(ms: number): number {
  const h = ms / 3_600_000;
  return clamp(100 * (1 - (h - 1) / 23));
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** ردود نافعة لكل شركة: عتبة «وسِّع» في results.ts درجةٌ كاملة. لا يزيدها الكمّ. Pure. */
export const positiveRateScore = (positive: number, companies: number) => (companies > 0 ? clamp(((positive / companies) * 100 / SCALE_RATE) * 100) : 0);

/** تذبذب النجاح اليومي: انحراف ٠٫٥ (نصف الأيام كلها فشل) درجة صفر. Pure. */
export function consistencyOf(dailyRates: number[]): { stddev: number; score: number } | null {
  if (!dailyRates.length) return null;
  const mean = dailyRates.reduce((a, b) => a + b, 0) / dailyRates.length;
  const stddev = Math.sqrt(dailyRates.reduce((a, x) => a + (x - mean) ** 2, 0) / dailyRates.length);
  return { stddev, score: clamp(100 * (1 - stddev / 0.5)) };
}

export interface ReviewVerdict { key: string; verdict: string; why?: string; sent: number; positive?: number }
/** حكمٌ صدر بعيّنته: «راقب» دون الحد، والبقية عند الحد أو بسبب رفض المزوّد (يسقط بأي عيّنة). Pure. */
export function verdictDisciplined(v: ReviewVerdict, min = RESULTS_MIN_SAMPLE): boolean {
  if (v.verdict === "watch") return v.sent < min;
  return v.sent >= min || /رفض/.test(v.why ?? "");
}

export interface DailyResult { day: string; companies: number; positive: number }
export const IMPROVEMENT_WINDOW_DAYS = 14;
export const IMPROVEMENT_MIN_COMPANIES = 30;

/**
 * هل تحسّنت نسبة الردود النافعة في الأيام التي تلت الحكم عمّا قبلها؟ يُعدّ الحكم إن بلغ كل
 * جانب العيّنة. لا يقول إن الحكم سبب التحسّن، بل إنه سبقه: هذا كل ما يُرى من هنا. Pure.
 */
export function verdictsImprovement(decisions: Array<{ at: string; ref: number | string }>, daily: DailyResult[], days = IMPROVEMENT_WINDOW_DAYS, min = IMPROVEMENT_MIN_COMPANIES): { judged: number; improved: number; refs: Array<number | string> } {
  const dayMs = 86_400_000;
  let judged = 0, improved = 0;
  const refs: Array<number | string> = [];
  for (const d of decisions) {
    const t = new Date(d.at).getTime();
    const side = (from: number, to: number) => daily.reduce((a, r) => {
      const x = new Date(`${r.day}T00:00:00Z`).getTime();
      return x >= from && x < to ? { c: a.c + r.companies, p: a.p + r.positive } : a;
    }, { c: 0, p: 0 });
    const before = side(t - days * dayMs, t), after = side(t, t + days * dayMs);
    if (before.c < min || after.c < min) continue;
    judged++; refs.push(d.ref);
    if (after.p / after.c > before.p / before.c) improved++;
  }
  return { judged, improved, refs };
}

// ── أي نموذج لأي دور ──────────────────────────────────────────────
const MODEL_BY_ROLE: Record<string, ModelName> = {
  email: "copywriter", email_creator: "copywriter", email_followup: "copywriter", accounts_writer: "copywriter",
  email_analyst: "analyst", email_replies: "reply_specialist",
  sales: "conversation", support: "conversation", followup: "followup",
  accounts_researcher: "researcher", accounts_analyst: "researcher", accounts_email: "researcher",
};
/** النموذج: الدور المعروف بعمله، ومن له عامل خلفي عمليات، وغيره العموم (السوشيال ما له بيانات نتيجة منسوبة). Pure. */
export function modelFor(role: string): ModelName {
  const known = MODEL_BY_ROLE[role];
  if (known) return known;
  if (/^(ig|tt|li)_/.test(role)) return "general";
  return intervalOf(role) ? "operations" : "general";
}

// ── الاستعلامات ───────────────────────────────────────────────────
interface Window { from: Date; to: Date; days: number }
const n = (v: unknown) => Number(v ?? 0);
const ids = (v: unknown): Array<number | string> => (Array.isArray(v) ? v.slice(0, EVIDENCE_CAP).map((x) => (typeof x === "string" && /^\d{1,15}$/.test(x) ? Number(x) : x)) : []);
const texts = (v: unknown): string[] => (Array.isArray(v) ? v.slice(0, EVIDENCE_CAP).map(String) : []);
const POSITIVE_INTENTS = ["interested", "question", "considering", "later", "referral"];
const positiveList = sql.join(POSITIVE_INTENTS.map((x) => sql`${x}`), sql`, `);
const REAL_REPLY = sql`coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true)`;
const freeList = () => sql.join([...FREE_MAIL].map((d) => sql`${d}`), sql`, `);
const companyOf = (col: any) => sql`CASE WHEN lower(split_part(${col}, '@', 2)) IN (${freeList()}) THEN lower(${col}) ELSE lower(split_part(${col}, '@', 2)) END`;

// رفضٌ من المفتاح ليس خطأ موظف، والتكرار حارسٌ لا مخالفة. المخالفة: من طلب الإيقاف، أو غير صندوق صاحب العمل.
const NOT_A_SWITCH = sql`(why LIKE 'opted_out%' OR why LIKE 'not_owner%')`;

async function generalMetrics(userId: number, role: string, key: string, w: Window): Promise<Metric[]> {
  const [ex] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS bad, avg(duration_ms) AS avg_ms,
      count(duration_ms)::int AS timed, (array_agg(id ORDER BY id DESC))[1:${EVIDENCE_CAP}] AS ids
    FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${key} AND status IN ('succeeded','failed') AND started_at >= ${w.from} AND started_at < ${w.to}`)).rows;
  const total = n(ex?.ok) + n(ex?.bad);
  const success = buildMetric({ key: "success_rate", label: "نسبة النجاح", weight: 10, minSample: 10 }, total, total ? n(ex.ok) / total : null, total ? (n(ex.ok) / total) * 100 : null,
    `تنفيذات ناجحة ${n(ex?.ok)} ÷ منتهية ${total} (employee_executions، بلا الموقوف).`, { employee_executions: ids(ex?.ids) });

  const [dl] = (await db.execute<any>(sql`SELECT count(*)::int AS deadlines, count(*) FILTER (WHERE status = 'expired')::int AS missed, (array_agg(task_id ORDER BY task_id DESC) FILTER (WHERE status = 'expired'))[1:${EVIDENCE_CAP}] AS ids
    FROM employee_tasks WHERE user_id = ${userId} AND owner_role = ${role} AND expires_at >= ${w.from} AND expires_at < ${w.to} AND ${REAL_TASK}`)).rows;
  const [hb] = (await db.execute<any>(sql`SELECT count(*)::int AS missed, (array_agg(id ORDER BY id DESC))[1:${EVIDENCE_CAP}] AS ids FROM org_audit_log
    WHERE user_id = ${userId} AND action = 'watchdog.finding' AND kind = 'missed_heartbeat' AND meta->>'subject' = ${key} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const [days] = (await db.execute<any>(sql`SELECT count(DISTINCT (started_at at time zone 'Asia/Dubai')::date)::int AS n FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${key} AND started_at >= ${w.from} AND started_at < ${w.to}`)).rows;
  const deadlines = n(dl?.deadlines) + n(days?.n) + n(hb?.missed), missed = n(dl?.missed) + n(hb?.missed);
  const missedM = buildMetric({ key: "missed_deadlines", label: "المواعيد الفائتة", weight: 8, minSample: 5 }, deadlines, deadlines ? missed / deadlines : null, deadlines ? (1 - missed / deadlines) * 100 : null,
    `فائت ${missed} (مهام انتهت مهلتها ${n(dl?.missed)} + نبض فائت ${n(hb?.missed)}) من ${deadlines} موعد (مهام بمهلة + أيام عمل).`, { employee_tasks: ids(dl?.ids), org_audit_log: ids(hb?.ids) });

  const [rc] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'failed')::int AS bad, (array_agg(id ORDER BY id DESC) FILTER (WHERE status = 'failed'))[1:${EVIDENCE_CAP}] AS ids
    FROM receipts WHERE user_id = ${userId} AND node = ${role.slice(0, 40)} AND status <> 'blocked' AND at >= ${w.from} AND at < ${w.to}`)).rows;
  const errorM = buildMetric({ key: "error_rate", label: "نسبة الخطأ", weight: 6, minSample: 20 }, n(rc?.total), n(rc?.total) ? n(rc.bad) / n(rc.total) : null, n(rc?.total) ? (1 - n(rc.bad) / n(rc.total)) * 100 : null,
    `إيصالات فاشلة ${n(rc?.bad)} ÷ ${n(rc?.total)} (receipts، بلا المحظور بمفتاح).`, { receipts: ids(rc?.ids) });

  const duration = buildMetric({ key: "avg_duration", label: "متوسط المدة", weight: 0, minSample: 10, unit: "ms" }, n(ex?.timed), ex?.avg_ms == null ? null : Math.round(Number(ex.avg_ms)), null, `متوسط duration_ms على ${n(ex?.timed)} تنفيذاً. للمعرفة لا للدرجة: لا هدف زمني مقرَّر لكل عمل.`, {});

  const [gate] = (await db.execute<any>(sql`SELECT count(*)::int AS refused, (array_agg(id ORDER BY id DESC))[1:${EVIDENCE_CAP}] AS ids FROM org_audit_log
    WHERE user_id = ${userId} AND action = 'gate.refused' AND role = ${role} AND ${NOT_A_SWITCH} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const [acts] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${userId} AND node = ${role.slice(0, 40)} AND status = 'ok'
    AND (action LIKE 'send%' OR action LIKE 'followup.sent%' OR action = 'reply') AND at >= ${w.from} AND at < ${w.to}`)).rows;
  const attempts = n(gate?.refused) + n(acts?.n);
  const compliance = buildMetric({ key: "instruction_compliance", label: "الالتزام بالضوابط", weight: 8, minSample: 10 }, attempts, attempts ? n(gate.refused) / attempts : null, attempts ? (1 - n(gate.refused) / attempts) * 100 : null,
    `رفض البوابة ${n(gate?.refused)} (بلا رفض المفاتيح) ÷ محاولات إرسال ${attempts}. القيمة نسبة الرفض.`, { org_audit_log: ids(gate?.ids) });

  const dayRows = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'succeeded')::int AS ok FROM employee_executions
    WHERE user_id = ${userId} AND employee_key = ${key} AND status IN ('succeeded','failed') AND started_at >= ${w.from} AND started_at < ${w.to}
    GROUP BY (started_at at time zone 'Asia/Dubai')::date HAVING count(*) >= 3`)).rows;
  const c = consistencyOf(dayRows.map((r: any) => n(r.ok) / n(r.total)));
  const consistency = buildMetric({ key: "consistency", label: "الثبات", weight: 8, minSample: 5 }, dayRows.length, c?.stddev ?? null, c?.score ?? null, `انحراف نسبة النجاح بين ${dayRows.length} يوماً (في كلٍّ ٣ تنفيذات فأكثر).`, {});
  return [success, missedM, errorM, duration, compliance, consistency];
}

/** رسائل هذا الكاتب التي خرجت في الفترة، بالمهمة التي كتبها لها. */
const writerMessages = (userId: number, role: string, w: Window) => sql`
  WITH msgs AS (
    SELECT m.id, m.to_email FROM email_missions ms
    JOIN LATERAL (
      SELECT m1.id, m1.to_email, m1.sent_at, m1.bounced_at FROM email_messages m1 WHERE m1.user_id = ms.user_id AND m1.campaign_id = ms.campaign_id
      UNION
      SELECT m2.id, m2.to_email, m2.sent_at, m2.bounced_at FROM email_sequence_jobs j JOIN email_messages m2 ON m2.sequence_job_id = j.id
      WHERE m2.user_id = ms.user_id AND j.sequence_id IN (ms.warm_sequence_id, ms.cold_sequence_id)
    ) m ON true
    WHERE ms.user_id = ${userId} AND coalesce(ms.agent_role, 'email') = ${role} AND m.sent_at >= ${w.from} AND m.sent_at < ${w.to} AND m.bounced_at IS NULL)`;

async function copywriterMetrics(userId: number, role: string, key: string, w: Window): Promise<Metric[]> {
  if (role === "accounts_writer") return deskWriterMetrics(userId, key, w);
  const decided = (await db.execute<any>(sql`SELECT a.id, a.action, a.ref FROM email_agent_activity a JOIN email_missions ms ON ms.id = (a.ref->>'missionId')::int AND ms.user_id = a.user_id
    WHERE a.user_id = ${userId} AND a.role = 'email_guard' AND a.action IN ('pass','skip') AND coalesce(ms.agent_role, 'email') = ${role} AND a.created_at >= ${w.from} AND a.created_at < ${w.to} AND a.ref ? 'missionId'`)).rows;
  const clean = decided.filter((a: any) => a.action === "pass" && !a.ref?.issues);
  const acceptance = buildMetric({ key: "guard_acceptance", label: "قبول الحارس من أول مرة", weight: 20, minSample: 5 }, decided.length, decided.length ? clean.length / decided.length : null, decided.length ? (clean.length / decided.length) * 100 : null,
    `مرّت بلا ملاحظة ${clean.length} من ${decided.length} قراراً للحارس (email_agent_activity).`, { email_agent_activity: decided.slice(0, EVIDENCE_CAP).map((a: any) => Number(a.id)) });

  const missionIds = [...new Set(decided.map((a: any) => Number(a.ref.missionId)))];
  const [holds] = missionIds.length ? (await db.execute<any>(sql`SELECT count(*)::int AS n FROM email_mission_log WHERE mission_id IN (${sql.join(missionIds.map((i) => sql`${i}`), sql`, `)}) AND text LIKE 'أوقفها حارس الجودة%'`)).rows : [{ n: 0 }];
  const avg = missionIds.length ? n(holds?.n) / missionIds.length : null;
  const revisions = buildMetric({ key: "revision_frequency", label: "تكرار إعادة الكتابة", weight: 10, minSample: 5, unit: "count" }, missionIds.length, avg, avg == null ? null : (1 - Math.min(1, avg / 2)) * 100,
    `إعادات بأمر الحارس ${n(holds?.n)} ÷ ${missionIds.length} مهمة. مرتان لكل مهمة = صفر، فبعدها يصلحها الحارس بنفسه.`, { email_missions: missionIds.slice(0, EVIDENCE_CAP) });

  const [res] = (await db.execute<any>(sql`${writerMessages(userId, role, w)}
    SELECT count(DISTINCT ${companyOf(sql`msgs.to_email`)})::int AS companies,
      count(DISTINCT ${companyOf(sql`msgs.to_email`)}) FILTER (WHERE i.id IS NOT NULL)::int AS positive,
      (array_agg(i.id ORDER BY i.id DESC) FILTER (WHERE i.id IS NOT NULL))[1:${EVIDENCE_CAP}] AS ids
    FROM msgs LEFT JOIN email_inbound i ON i.user_id = ${userId} AND i.message_id = msgs.id AND ${REAL_REPLY} AND i.intent IN (${positiveList})`)).rows;
  return [acceptance, revisions, positivePerCompany(n(res?.companies), n(res?.positive), ids(res?.ids), "email_inbound")];
}

function positivePerCompany(companies: number, positive: number, refs: Array<number | string>, table: string): Metric {
  return buildMetric({ key: "positive_per_company", label: "ردود نافعة لكل شركة", weight: 30, minSample: RESULTS_MIN_SAMPLE }, companies, companies ? positive / companies : null, positiveRateScore(positive, companies),
    `شركات ردّت رداً نافعاً منسوباً ${positive} ÷ شركات وصلها ${companies}. ${SCALE_RATE}٪ درجة كاملة. لا درجة للحجم.`, { [table]: refs });
}

/** هند: تكتب لشخصٍ بعينه، فمقياسها من target_accounts ومن خطوة ماجد في سير عملها. */
async function deskWriterMetrics(userId: number, key: string, w: Window): Promise<Metric[]> {
  const guard = (await db.execute<any>(sql`SELECT id, detail FROM execution_events WHERE user_id = ${userId} AND employee_key = 'email.guard' AND event = 'quality' AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const pass = guard.filter((g: any) => g.detail?.pass === true);
  const acceptance = buildMetric({ key: "guard_acceptance", label: "قبول الحارس", weight: 20, minSample: 5 }, guard.length, guard.length ? pass.length / guard.length : null, guard.length ? (pass.length / guard.length) * 100 : null,
    `مرّت ${pass.length} من ${guard.length} خطوة جودة (execution_events).`, { execution_events: guard.slice(0, EVIDENCE_CAP).map((g: any) => Number(g.id)) });
  const [fb] = (await db.execute<any>(sql`SELECT coalesce(sum(coalesce((evidence->>'times')::int, 1)), 0)::int AS n, (array_agg(id ORDER BY id DESC))[1:${EVIDENCE_CAP}] AS ids FROM employee_feedback
    WHERE user_id = ${userId} AND employee_key = ${key} AND from_role = 'email_guard' AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const avg = guard.length ? n(fb?.n) / guard.length : null;
  const revisions = buildMetric({ key: "revision_frequency", label: "ملاحظات الحارس لكل مسودة", weight: 10, minSample: 5, unit: "count" }, guard.length, avg, avg == null ? null : (1 - Math.min(1, avg / 2)) * 100,
    `ملاحظات ${n(fb?.n)} ÷ ${guard.length} مسودة.`, { employee_feedback: ids(fb?.ids) });
  const [res] = (await db.execute<any>(sql`SELECT count(*)::int AS companies, count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM email_inbound i WHERE i.user_id = t.user_id AND lower(split_part(i.from_email, '@', 2)) = t.domain AND i.received_at >= t.sent_at AND ${REAL_REPLY} AND i.intent IN (${positiveList})))::int AS positive,
      (array_agg(t.id ORDER BY t.id DESC))[1:${EVIDENCE_CAP}] AS ids
    FROM target_accounts t WHERE t.user_id = ${userId} AND t.sent_at >= ${w.from} AND t.sent_at < ${w.to}`)).rows;
  return [acceptance, revisions, positivePerCompany(n(res?.companies), n(res?.positive), ids(res?.ids), "target_accounts")];
}

async function analystMetrics(userId: number, role: string, w: Window): Promise<Metric[]> {
  const tasks = (await db.execute<any>(sql`SELECT task_id, created_at, input_refs FROM employee_tasks WHERE user_id = ${userId} AND task_type = 'review_results' AND created_by_role = ${role}
    AND created_at >= ${w.from} AND created_at < ${w.to} ORDER BY task_id`)).rows;
  const latest = tasks[tasks.length - 1];
  const judged = new Set<string>((latest?.input_refs?.angles ?? []).map((a: any) => String(a.key)));
  const sentAngles = (await db.execute<any>(sql`SELECT DISTINCT ms.angle FROM email_missions ms JOIN email_messages m ON m.user_id = ms.user_id AND m.campaign_id = ms.campaign_id
    WHERE ms.user_id = ${userId} AND ms.angle IS NOT NULL AND m.sent_at >= ${w.from} AND m.sent_at < ${w.to}`)).rows.map((r: any) => String(r.angle));
  const covered = sentAngles.filter((a) => judged.has(a));
  const coverage = buildMetric({ key: "verdict_coverage", label: "تغطية الأحكام", weight: 20, minSample: 3 }, sentAngles.length, sentAngles.length ? covered.length / sentAngles.length : null, sentAngles.length ? (covered.length / sentAngles.length) * 100 : null,
    `زوايا خرجت في الفترة ولها حكم ${covered.length} من ${sentAngles.length}.`, { employee_tasks: latest ? [Number(latest.task_id)] : [] });

  const entries: ReviewVerdict[] = tasks.flatMap((t: any) => (t.input_refs?.angles ?? []) as ReviewVerdict[]);
  const good = entries.filter((v) => verdictDisciplined(v));
  const discipline = buildMetric({ key: "sample_discipline", label: "انضباط العيّنة", weight: 20, minSample: 5 }, entries.length, entries.length ? good.length / entries.length : null, entries.length ? (good.length / entries.length) * 100 : null,
    `أحكام احترمت حد العيّنة ${good.length} من ${entries.length} (${RESULTS_MIN_SAMPLE} شركة، أو رفض مزوّد).`, { employee_tasks: tasks.slice(0, EVIDENCE_CAP).map((t: any) => Number(t.task_id)) });

  const seen = new Set<string>();
  const decisions: Array<{ at: string; ref: number }> = [];
  for (const t of tasks) for (const v of (t.input_refs?.angles ?? []) as ReviewVerdict[]) {
    if (!["scale", "rewrite", "hold"].includes(v.verdict) || seen.has(v.key)) continue;
    seen.add(v.key);
    decisions.push({ at: new Date(t.created_at).toISOString(), ref: Number(t.task_id) });
  }
  const from = new Date(w.from.getTime() - IMPROVEMENT_WINDOW_DAYS * 86_400_000);
  const daily = (await db.execute<any>(sql`SELECT to_char((m.sent_at at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day, count(DISTINCT ${companyOf(sql`m.to_email`)})::int AS companies,
      count(DISTINCT ${companyOf(sql`m.to_email`)}) FILTER (WHERE i.id IS NOT NULL)::int AS positive
    FROM email_messages m LEFT JOIN email_inbound i ON i.user_id = m.user_id AND i.message_id = m.id AND ${REAL_REPLY} AND i.intent IN (${positiveList})
    WHERE m.user_id = ${userId} AND m.sent_at >= ${from} AND m.sent_at < ${new Date(w.to.getTime() + IMPROVEMENT_WINDOW_DAYS * 86_400_000)} GROUP BY 1`)).rows
    .map((r: any) => ({ day: r.day, companies: n(r.companies), positive: n(r.positive) }));
  const imp = verdictsImprovement(decisions, daily);
  const improvement = buildMetric({ key: "verdicts_preceded_improvement", label: "أحكام سبقت تحسّناً", weight: 20, minSample: 3 }, imp.judged, imp.judged ? imp.improved / imp.judged : null, imp.judged ? (imp.improved / imp.judged) * 100 : null,
    `أحكام فاصلة تحسّنت بعدها نسبة الردود النافعة ${imp.improved} من ${imp.judged} (${IMPROVEMENT_WINDOW_DAYS} يوماً قبل وبعد، و${IMPROVEMENT_MIN_COMPANIES} شركة في كل جانب). سبق لا سببية.`, { employee_tasks: imp.refs.slice(0, EVIDENCE_CAP) });
  return [coverage, discipline, improvement];
}

async function replyMetrics(userId: number, w: Window): Promise<Metric[]> {
  const answered = (await db.execute<any>(sql`SELECT i.id, EXTRACT(EPOCH FROM (r.sent_at - i.received_at)) * 1000 AS ms FROM email_inbound i
    JOIN LATERAL (SELECT m.sent_at FROM email_messages m WHERE m.user_id = i.user_id AND lower(m.to_email) = lower(i.from_email) AND m.campaign_id IS NULL AND m.sequence_job_id IS NULL AND m.sent_at > i.received_at ORDER BY m.sent_at LIMIT 1) r ON true
    WHERE i.user_id = ${userId} AND i.state = 'sent' AND ${REAL_REPLY} AND i.received_at >= ${w.from} AND i.received_at < ${w.to} ORDER BY i.id DESC`)).rows;
  const med = median(answered.map((a: any) => Number(a.ms)));
  const speed = buildMetric({ key: "response_time", label: "زمن الرد (الوسيط)", weight: 25, minSample: 5, unit: "ms" }, answered.length, med, med == null ? null : responseTimeScore(med),
    `وسيط الزمن من وصول الرد إلى خروج جوابنا على ${answered.length} رداً. ساعةٌ فأقل كاملة، ويوم فأكثر صفر.`, { email_inbound: answered.slice(0, EVIDENCE_CAP).map((a: any) => Number(a.id)) });

  // ما كان يجب أن يُصعَّد: رد نافع ظل بلا جواب ولا موعد إرسال فوق ساعتين (قاعدة escalateStaleHotDrafts).
  const esc = (await db.execute<any>(sql`SELECT i.id, i.intent, i.state, (i.intent IN (${positiveList}) AND i.auto_send_at IS NULL AND i.state IN ('drafted','new','held') AND i.received_at < now() - interval '2 hours') AS should,
      EXISTS (SELECT 1 FROM email_agent_activity a WHERE a.user_id = i.user_id AND a.action = 'escalate' AND (a.ref->>'inboundId')::int = i.id) AS did
    FROM email_inbound i WHERE i.user_id = ${userId} AND ${REAL_REPLY} AND i.received_at >= ${w.from} AND i.received_at < ${w.to}`)).rows.filter((r: any) => r.should || r.did);
  const right = esc.filter((r: any) => r.should && r.did);
  const escalation = buildMetric({ key: "correct_escalation", label: "صحة التصعيد", weight: 20, minSample: 5 }, esc.length, esc.length ? right.length / esc.length : null, esc.length ? (right.length / esc.length) * 100 : null,
    `تصعيد في محله ${right.length} من ${esc.length} (ما كان يجب أن يُصعَّد أو صُعِّد).`, { email_inbound: esc.slice(0, EVIDENCE_CAP).map((r: any) => Number(r.id)) });

  const [fb] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE verdict IN ('edited','rejected'))::int AS changed, (array_agg(id ORDER BY id DESC) FILTER (WHERE verdict IN ('edited','rejected')))[1:${EVIDENCE_CAP}] AS ids
    FROM agent_feedback WHERE user_id = ${userId} AND kind = 'email_reply' AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const overridden = buildMetric({ key: "overridden_by_owner", label: "ما عدّله صاحب العمل", weight: 15, minSample: 5 }, n(fb?.total), n(fb?.total) ? n(fb.changed) / n(fb.total) : null, n(fb?.total) ? (1 - n(fb.changed) / n(fb.total)) * 100 : null,
    `عدّل أو رفض ${n(fb?.changed)} من ${n(fb?.total)} مسودة (agent_feedback). القيمة نسبة التعديل.`, { agent_feedback: ids(fb?.ids) });
  return [speed, escalation, overridden];
}

/** مبيعات ودعم واتساب: المحادثات التي يملكها الموظف ومآلها، لا عدد رسائله. */
async function conversationMetrics(userId: number, role: string, w: Window): Promise<Metric[]> {
  const [c] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE r.label IN ('hot','interested','order'))::int AS good,
      (array_agg(r.phone) FILTER (WHERE r.label IN ('hot','interested','order')))[1:${EVIDENCE_CAP}] AS refs
    FROM conversation_reviews r JOIN conversation_owner o ON o.user_id = r.user_id AND o.phone = r.phone AND o.role = ${role}
    WHERE r.user_id = ${userId} AND r.label NOT IN ('machine','not_customer') AND r.last_at >= ${w.from} AND r.last_at < ${w.to}`)).rows;
  const outcome = buildMetric({ key: "conversation_outcome", label: "محادثات تقدّمت", weight: 40, minSample: 20 }, n(c?.total), n(c?.total) ? n(c.good) / n(c.total) : null, n(c?.total) ? Math.min(100, (n(c.good) / n(c.total)) / 0.2 * 100) : null,
    `حار أو مهتم أو طلب ${n(c?.good)} من ${n(c?.total)} محادثة يملكها (conversation_reviews). ٢٠٪ درجة كاملة.`, { conversation_reviews: texts(c?.refs) });
  const [fb] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE verdict IN ('edited','rejected'))::int AS changed, (array_agg(id ORDER BY id DESC) FILTER (WHERE verdict IN ('edited','rejected')))[1:${EVIDENCE_CAP}] AS ids
    FROM agent_feedback WHERE user_id = ${userId} AND role = ${role} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const overridden = buildMetric({ key: "overridden_by_owner", label: "ما عدّله صاحب العمل", weight: 20, minSample: 5 }, n(fb?.total), n(fb?.total) ? n(fb.changed) / n(fb.total) : null, n(fb?.total) ? (1 - n(fb.changed) / n(fb.total)) * 100 : null,
    `عدّل أو رفض ${n(fb?.changed)} من ${n(fb?.total)}. القيمة نسبة التعديل.`, { agent_feedback: ids(fb?.ids) });
  return [outcome, overridden];
}

/** خالد: مآل من تابعهم فعلاً، ومن طلب الإيقاف بعد متابعته، وهل خرج ما قرّر إرساله عبر الحاجز. */
async function followupMetrics(userId: number, w: Window): Promise<Metric[]> {
  const [d] = (await db.execute<any>(sql`SELECT count(DISTINCT d.phone)::int AS sent,
      count(DISTINCT d.phone) FILTER (WHERE r.label IN ('hot','interested','order') AND r.reviewed_at > d.created_at)::int AS good,
      count(DISTINCT d.phone) FILTER (WHERE u.id IS NOT NULL AND u.created_at > d.created_at)::int AS stopped,
      (array_agg(d.id ORDER BY d.id DESC))[1:${EVIDENCE_CAP}] AS ids
    FROM followup_deliberations d LEFT JOIN conversation_reviews r ON r.user_id = d.user_id AND r.phone = d.phone
      LEFT JOIN unsubscribed_phones u ON u.user_id = d.user_id AND u.phone = d.phone
    WHERE d.user_id = ${userId} AND d.executed AND d.created_at >= ${w.from} AND d.created_at < ${w.to}`)).rows;
  const sent = n(d?.sent);
  const outcome = buildMetric({ key: "followup_outcome", label: "متابعات تقدّمت", weight: 30, minSample: 20 }, sent, sent ? n(d.good) / sent : null, sent ? Math.min(100, (n(d.good) / sent) / 0.1 * 100) : null,
    `أشخاص تقدّموا بعد متابعة ${n(d?.good)} من ${sent} (followup_deliberations). ١٠٪ درجة كاملة.`, { followup_deliberations: ids(d?.ids) });
  const harm = buildMetric({ key: "followup_harm", label: "إيقافات بعد المتابعة", weight: 15, minSample: 20 }, sent, sent ? n(d.stopped) / sent : null, sent ? Math.max(0, (1 - (n(d.stopped) / sent) / 0.05) * 100) : null,
    `طلبوا الإيقاف بعد متابعة ${n(d?.stopped)} من ${sent}. ٥٪ فأكثر صفر. القيمة نسبة الإيقاف.`, {});
  const [f] = (await db.execute<any>(sql`SELECT count(*)::int AS decided, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_firewall_sends s WHERE s.user_id = d.user_id AND s.phone = d.phone AND s.kind = 'followup' AND s.at >= d.created_at AND s.at < d.created_at + interval '1 day'))::int AS through
    FROM followup_deliberations d WHERE d.user_id = ${userId} AND d.verdict = 'send' AND d.executed AND d.created_at >= ${w.from} AND d.created_at < ${w.to}`)).rows;
  const adherence = buildMetric({ key: "firewall_adherence", label: "الخروج عبر الحاجز", weight: 15, minSample: 20 }, n(f?.decided), n(f?.decided) ? n(f.through) / n(f.decided) : null, n(f?.decided) ? (n(f.through) / n(f.decided)) * 100 : null,
    `قرارات إرسال لها سطر في wa_firewall_sends ${n(f?.through)} من ${n(f?.decided)}.`, {});
  return [outcome, harm, adherence];
}

async function researcherMetrics(userId: number, role: string, w: Window): Promise<Metric[]> {
  const out: Metric[] = [];
  if (role === "accounts_email") {
    const [p] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE email_status IN ('verified','published'))::int AS ok, (array_agg(id ORDER BY id DESC) FILTER (WHERE email_status IN ('verified','published')))[1:${EVIDENCE_CAP}] AS ids
      FROM target_people WHERE user_id = ${userId} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
    out.push(buildMetric({ key: "verified_email_rate", label: "بريد متحقَّق", weight: 40, minSample: 10 }, n(p?.total), n(p?.total) ? n(p.ok) / n(p.total) : null, n(p?.total) ? (n(p.ok) / n(p.total)) * 100 : null,
      `منشور أو متحقَّق ${n(p?.ok)} من ${n(p?.total)} شخصاً (target_people). المخمَّن وcatch-all لا يُعدّان.`, { target_people: ids(p?.ids) }));
  } else if (role === "accounts_analyst") {
    const [p] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE source_url IS NOT NULL AND source_url <> '')::int AS ok, (array_agg(id ORDER BY id DESC) FILTER (WHERE source_url IS NOT NULL AND source_url <> ''))[1:${EVIDENCE_CAP}] AS ids
      FROM target_people WHERE user_id = ${userId} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
    out.push(buildMetric({ key: "evidence_backed_rate", label: "أسماء بمصدر", weight: 40, minSample: 10 }, n(p?.total), n(p?.total) ? n(p.ok) / n(p.total) : null, n(p?.total) ? (n(p.ok) / n(p.total)) * 100 : null,
      `أسماء لها رابط مصدر ${n(p?.ok)} من ${n(p?.total)} (target_people).`, { target_people: ids(p?.ids) }));
  } else {
    const [a] = (await db.execute<any>(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE signal_source IS NOT NULL AND signal_source <> '')::int AS ok, (array_agg(id ORDER BY id DESC) FILTER (WHERE signal_source IS NOT NULL AND signal_source <> ''))[1:${EVIDENCE_CAP}] AS ids
      FROM target_accounts WHERE user_id = ${userId} AND created_at >= ${w.from} AND created_at < ${w.to} AND status <> 'no_site'`)).rows;
    out.push(buildMetric({ key: "evidence_backed_rate", label: "إشارات بمصدر", weight: 40, minSample: 10 }, n(a?.total), n(a?.total) ? n(a.ok) / n(a.total) : null, n(a?.total) ? (n(a.ok) / n(a.total)) * 100 : null,
      `شركات لها إشارة برابط ${n(a?.ok)} من ${n(a?.total)} (target_accounts).`, { target_accounts: ids(a?.ids) }));
  }
  // أخذت الخطوة وقتها من سير عمل الشركة: من أول حدث إلى خروجها، في execution_events.
  const flows = (await db.execute<any>(sql`SELECT id, EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 AS ms FROM workflow_executions
    WHERE user_id = ${userId} AND workflow LIKE 'account%' AND finished_at IS NOT NULL AND started_at >= ${w.from} AND started_at < ${w.to} ORDER BY id DESC`)).rows;
  const med = median(flows.map((f: any) => Number(f.ms)));
  out.push(buildMetric({ key: "completion_time", label: "زمن إنجاز الشركة (الوسيط)", weight: 20, minSample: 5, unit: "ms" }, flows.length, med, med == null ? null : Math.max(0, 100 * (1 - med / (24 * 3_600_000))),
    `وسيط زمن سير عمل الشركة على ${flows.length}. يوم فأكثر صفر.`, { workflow_executions: flows.slice(0, EVIDENCE_CAP).map((f: any) => Number(f.id)) }));
  return out;
}

async function operationsMetrics(userId: number, role: string, key: string, w: Window): Promise<Metric[]> {
  const [t] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE status = 'completed')::int AS done, count(*) FILTER (WHERE status IN ('failed','expired'))::int AS bad, (array_agg(task_id ORDER BY task_id DESC) FILTER (WHERE status IN ('failed','expired')))[1:${EVIDENCE_CAP}] AS ids
    FROM employee_tasks WHERE user_id = ${userId} AND owner_role = ${role} AND updated_at >= ${w.from} AND updated_at < ${w.to} AND status IN ('completed','failed','expired') AND ${REAL_TASK}`)).rows;
  const closed = n(t?.done) + n(t?.bad);
  const completion = buildMetric({ key: "task_completion", label: "إنجاز المهام", weight: 25, minSample: 5 }, closed, closed ? n(t.done) / closed : null, closed ? (n(t.done) / closed) * 100 : null,
    `أُنجز ${n(t?.done)} من ${closed} مهمة أُغلقت.`, { employee_tasks: ids(t?.ids) });
  const [h] = (await db.execute<any>(sql`SELECT count(DISTINCT (created_at at time zone 'Asia/Dubai')::date)::int AS missed, (array_agg(id ORDER BY id DESC))[1:${EVIDENCE_CAP}] AS ids FROM org_audit_log
    WHERE user_id = ${userId} AND action = 'watchdog.finding' AND kind = 'missed_heartbeat' AND meta->>'subject' = ${key} AND created_at >= ${w.from} AND created_at < ${w.to}`)).rows;
  const [run] = (await db.execute<any>(sql`SELECT count(DISTINCT (started_at at time zone 'Asia/Dubai')::date)::int AS days FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${key} AND started_at >= ${w.from} AND started_at < ${w.to}`)).rows;
  const observed = n(run?.days) + n(h?.missed);
  const misses = buildMetric({ key: "heartbeat_misses", label: "أيام فاتها النبض", weight: 15, minSample: 5 }, observed, observed ? n(h.missed) / observed : null, observed ? (1 - n(h.missed) / observed) * 100 : null,
    `أيام فيها نبض فائت ${n(h?.missed)} من ${observed} يوماً مرصوداً.`, { org_audit_log: ids(h?.ids) });
  const [rec] = (await db.execute<any>(sql`SELECT count(*)::int AS failures, count(*) FILTER (WHERE EXISTS (SELECT 1 FROM employee_executions o WHERE o.user_id = f.user_id AND o.employee_key = f.employee_key AND o.status = 'succeeded' AND o.started_at > f.started_at AND o.started_at < f.started_at + interval '1 day'))::int AS recovered,
      (array_agg(f.id ORDER BY f.id DESC))[1:${EVIDENCE_CAP}] AS ids
    FROM employee_executions f WHERE f.user_id = ${userId} AND f.employee_key = ${key} AND f.status = 'failed' AND f.started_at >= ${w.from} AND f.started_at < ${w.to}`)).rows;
  const recovery = buildMetric({ key: "recovery", label: "التعافي بعد الفشل", weight: 20, minSample: 3 }, n(rec?.failures), n(rec?.failures) ? n(rec.recovered) / n(rec.failures) : null, n(rec?.failures) ? (n(rec.recovered) / n(rec.failures)) * 100 : null,
    `فشل تلاه نجاح خلال يوم ${n(rec?.recovered)} من ${n(rec?.failures)}.`, { employee_executions: ids(rec?.ids) });
  return [completion, misses, recovery];
}

async function roleMetrics(userId: number, role: string, key: string, model: ModelName, w: Window): Promise<Metric[]> {
  switch (model) {
    case "copywriter": return copywriterMetrics(userId, role, key, w);
    case "analyst": return analystMetrics(userId, role, w);
    case "reply_specialist": return replyMetrics(userId, w);
    case "conversation": return conversationMetrics(userId, role, w);
    case "followup": return followupMetrics(userId, w);
    case "researcher": return researcherMetrics(userId, role, w);
    case "operations": return operationsMetrics(userId, role, key, w);
    default: return [];
  }
}

const allMetrics = async (userId: number, role: string, key: string, model: ModelName, w: Window) =>
  [...(await roleMetrics(userId, role, key, model, w)), ...(await generalMetrics(userId, role, key, w))];

function mergeEvidence(metrics: Metric[]): EvidenceRefs {
  const out: EvidenceRefs = {};
  for (const m of metrics) for (const [t, xs] of Object.entries(m.evidence)) out[t] = [...new Set([...(out[t] ?? []), ...xs])].slice(0, EVIDENCE_CAP);
  return out;
}

/** بطاقة موظفٍ واحد. جديد: كل مقاييسه تُحسب ليراها صاحب العمل، ولا درجة. */
export async function computeScorecard(userId: number, e: { role: string; employeeKey?: string; createdAt?: Date | string | null }, period: PeriodName, now = new Date()): Promise<Scorecard> {
  const key = e.employeeKey ?? employeeKeyOf(e.role);
  const days = PERIOD_DAYS[period], dayMs = 86_400_000;
  const cur: Window = { from: new Date(now.getTime() - days * dayMs), to: now, days };
  const prev: Window = { from: new Date(now.getTime() - 2 * days * dayMs), to: cur.from, days };
  const model = modelFor(e.role);
  const metrics = await allMetrics(userId, e.role, key, model, cur);
  const previous = await allMetrics(userId, e.role, key, model, prev);
  const base = { employeeKey: key, role: e.role, model, period, periodKey: periodKeyOf(period, now), periodStart: cur.from.toISOString(), periodEnd: cur.to.toISOString(), metrics, evidence: mergeEvidence(metrics) };
  if (isNewEmployee(e.createdAt, now.getTime())) {
    return { ...base, status: INSUFFICIENT, score: null, sampleSize: metrics.reduce((a, m) => a + m.sampleSize, 0), confidence: "none", trend: { direction: "unknown", previousScore: null, delta: null },
      calculation: `${INSUFFICIENT}: موظف جديد، لا درجة قبل ${NEW_EMPLOYEE_DAYS} يوماً من توظيفه.`, note: "موظف جديد" };
  }
  const c = composite(metrics);
  return { ...base, status: c.status, score: c.score, sampleSize: c.sampleSize, confidence: c.confidence, calculation: c.calculation,
    trend: c.status === "OK" ? trendOf(metrics, previous) : { direction: "unknown", previousScore: null, delta: null } };
}

// ── التخزين ───────────────────────────────────────────────────────
export async function storeScorecard(userId: number, c: Scorecard): Promise<void> {
  await db.execute(sql`INSERT INTO employee_scorecards (user_id, employee_key, period_key, score, metrics, note)
    VALUES (${userId}, ${c.employeeKey}, ${c.periodKey}, ${c.score}, ${JSON.stringify(c)}::jsonb, ${c.note ?? null})
    ON CONFLICT (user_id, employee_key, period_key) DO UPDATE SET score = EXCLUDED.score, metrics = EXCLUDED.metrics, note = EXCLUDED.note, created_at = now()`);
}

const employees = async (userId: number) => (await db.execute<{ role: string; employee_key: string; created_at: Date }>(sql`SELECT role, employee_key, created_at FROM bot_employees WHERE user_id = ${userId} AND employee_key IS NOT NULL ORDER BY role`)).rows;

/** بطاقات الحساب كلها للفترة. موظفٌ تعذّرت بطاقته لا يُسقط البقية. */
export async function scoreAccount(userId: number, periods: PeriodName[] = ["weekly", "monthly"], now = new Date()): Promise<number> {
  await ensureOrgTables();
  let stored = 0;
  for (const e of await employees(userId)) for (const p of periods) {
    try { await storeScorecard(userId, await computeScorecard(userId, { role: e.role, employeeKey: e.employee_key, createdAt: e.created_at }, p, now)); stored++; }
    catch (err: any) { logger.warn({ userId, key: e.employee_key, period: p, err: String(err?.message ?? err).slice(0, 200) }, "بطاقة لم تُحسب"); }
  }
  return stored;
}

/** آخر بطاقة محفوظة لكل موظف في الفترة، للحساب وحده. */
export async function latestScorecards(userId: number, period: PeriodName, employeeKey?: string | null): Promise<Scorecard[]> {
  await ensureOrgTables();
  const r = await db.execute<{ metrics: Scorecard }>(sql`SELECT DISTINCT ON (employee_key) metrics FROM employee_scorecards
    WHERE user_id = ${userId} AND period_key LIKE ${`${period}:%`} ${employeeKey ? sql`AND employee_key = ${employeeKey}` : sql``} ORDER BY employee_key, created_at DESC`);
  return r.rows.map((x) => x.metrics);
}

/** تاريخ موظف: آخر البطاقات المحفوظة. */
export async function scorecardHistory(userId: number, employeeKey: string, limit = 12): Promise<Scorecard[]> {
  const r = await db.execute<{ metrics: Scorecard }>(sql`SELECT metrics FROM employee_scorecards WHERE user_id = ${userId} AND employee_key = ${employeeKey} ORDER BY created_at DESC LIMIT ${limit}`);
  return r.rows.map((x) => x.metrics);
}
