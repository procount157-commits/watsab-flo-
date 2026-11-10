// ── الرئيس التنفيذي الآلي ─────────────────────────────────────────
// الوقائع بالكود، والنص والترتيب وحدهما من النموذج، ويُفحصان بالكود: كل رقمٍ في النص يجب
// أن يكون في حزمة الوقائع، وإلا يُعاد مرةً، ثم يُحفظ التقرير بوقائعه بلا نص. لا يملك أن
// يغيّر إعداداً ولا أن يتجاوز موافقة: ما ينتجه مهامٌ، وما يتطلب موافقة ينتظرها.
//
// لكل حساب تقريره، ولا عرض عام إلا عدّاد المدير بلا محتوى.

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, agentTasksTable, botEmployeesTable } from "@workspace/db";
import { complete } from "../llm";
import { logger } from "../logger";
import { accountHalted } from "./controls";
import { employeeKeyOf, orgDepartmentOf, DEPARTMENTS } from "./departments";
import { parseStructured } from "./providers";
import { classify, seedPromptProposals, type Category } from "./proposals";
import { backfillRegistry } from "./registry";
import { execute } from "./runtime";
import { ensureOrgTables } from "./schema";
import { scoreAccount, INSUFFICIENT } from "./scorecards";
import { createTask } from "./tasks";
import { WAIT_APPROVAL_DAYS, watchdogFindings } from "./watchdog";
import { lessonOutcome } from "./memory";
import { dubaiNow } from "../accounts/pure";
import { queueReview } from "./queue";
import { noteQuality } from "./providers";
import { ensureSimTables, REAL_TASK } from "./sim-schema";
import { everyMs } from "./workers";

export const CEO_ROLE = "ceo_agent";
export const CEO_KEY = "executive.ceo";
export const CEO_PERSONA = [
  "الرئيس التنفيذي الآلي للمنظّمة في هذا الحساب. عمله أن يقرأ وقائع الحساب كما حسبها الكود، ويقول لصاحب العمل بصدق: ما الذي ينجح، وما الذي يتعثر، وماذا يُفعل أولاً.",
  "لا يخترع رقماً أبداً: كل رقمٍ يكتبه موجودٌ في الوقائع التي أُعطيها، وما ليس فيها لا يُذكر. إن كانت الوقائع قليلة قال ذلك صراحةً ولم يملأ الفراغ بكلام.",
  "لا يخلط النشاط بالنجاح: عدد الرسائل والتنفيذات والمهام ليس نتيجة، والنتيجة ردٌّ نافع أو عميل مؤهل أو اجتماع. موظفٌ مشغول بلا نتيجة ليس موظفاً ناجحاً.",
  "لا يرفع حجم الإرسال بلا دليل، ولا يقترح زيادة حدٍّ أو تشغيل قناة إلا بدليلٍ من الوقائع، ولصاحب العمل القرار.",
  "لا يغيّر إعداداً، ولا يتجاوز موافقة، ولا يراسل أحداً: يكتب تقريراً ويقترح، والموافقة لصاحب الحساب.",
].join(" ");

/** يوظَّف كما يُوظَّف فريق البريد والمكتب: صفٌّ داخلي في bot_employees، وما أوقفه صاحب العمل يبقى موقوفاً. */
export async function ensureCeo(userId: number): Promise<void> {
  const have = await db.select({ id: botEmployeesTable.id }).from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, CEO_ROLE))).limit(1);
  if (have.length) return;
  await db.insert(botEmployeesTable).values({ userId, name: "الرئيس التنفيذي", role: CEO_ROLE, kind: "internal", title: "Chief Executive AI", avatar: "🏛️", persona: CEO_PERSONA, specialties: [], priority: 900, handoffTo: null, employeeKey: CEO_KEY, department: "executive", heartbeatIntervalSec: 86400 } as any);
  const tasks = ["اجمع وقائع الحساب كل صباح", "رتّب المشكلات واكتب ما يُفعل أولاً", "قِس هل حرّكت تحسينات الأسبوع الماضي شيئاً"];
  const hasTasks = await db.select({ id: agentTasksTable.id }).from(agentTasksTable).where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, CEO_ROLE))).limit(1);
  if (!hasTasks.length) await db.insert(agentTasksTable).values(tasks.map((task, i) => ({ userId, role: CEO_ROLE, task, sortOrder: (i + 1) * 10 })));
  logger.info({ userId }, "وُظّف الرئيس التنفيذي");
}

// ── التحقق من الأرقام ─────────────────────────────────────────────
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩", FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
/** أرقام هندية وفارسية إلى لاتينية، والفاصلة العشرية العربية نقطة، وفاصل الآلاف يُحذف. Pure. */
export function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d))).replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d))).replace(/٫/g, ".").replace(/(?<=\d)[٬,](?=\d{3}\b)/g, "");
}

const NUMBER_WORDS: Record<string, number> = {
  ثلاث: 3, ثلاثة: 3, أربع: 4, أربعة: 4, خمس: 5, خمسة: 5, ست: 6, ستة: 6, سبع: 7, سبعة: 7, ثمان: 8, ثماني: 8, ثمانية: 8, تسع: 9, تسعة: 9, عشر: 10, عشرة: 10,
  عشرون: 20, عشرين: 20, ثلاثون: 30, ثلاثين: 30, أربعون: 40, أربعين: 40, خمسون: 50, خمسين: 50, ستون: 60, ستين: 60, سبعون: 70, سبعين: 70, ثمانون: 80, ثمانين: 80, تسعون: 90, تسعين: 90,
  مئة: 100, مائة: 100, مئتان: 200, مئتين: 200, ألف: 1000, آلاف: 1000, مليون: 1000000, نصف: 0.5, ثلث: 0.3333, ربع: 0.25, ضعف: 2, ضعفين: 2,
};
const stripPrefix = (w: string) => w.replace(/^(وال|بال|فال|لل|ال|و|ف|ب|ل)(?=.{2,})/, "");

/** كل رقمٍ في نص، بالأرقام أو بالكلمات. «أولاً» و«واحد» و«اثنان» لا تُعدّ: لا تُكتب أرقاماً غالباً. Pure. */
export function numbersIn(text: string): number[] {
  const t = normalizeDigits(text);
  const out = (t.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  for (const raw of t.split(/[^\p{L}]+/u)) {
    if (!raw) continue;
    const v = NUMBER_WORDS[raw] ?? NUMBER_WORDS[stripPrefix(raw)];
    if (v != null) out.push(v);
  }
  return out;
}

const fmt = (x: number) => String(Math.round(x * 10000) / 10000);
/** كل صورة صحيحة لرقمٍ في الوقائع: نفسه، مقرَّباً، وإن كان نسبةً فمئوياً أيضاً. Pure. */
function variants(v: number): string[] {
  const out = new Set<string>([fmt(v), fmt(Math.round(v)), fmt(Math.round(v * 10) / 10), fmt(Math.round(v * 100) / 100)]);
  if (Math.abs(v) <= 1) { const p = v * 100; out.add(fmt(p)); out.add(fmt(Math.round(p))); out.add(fmt(Math.round(p * 10) / 10)); }
  return [...out];
}

/** أرقام الحزمة كلها: كل ورقة رقمية، وكل رقم داخل نص. Pure. */
export function factNumbers(pack: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (x: unknown) => {
    if (x == null) return;
    if (typeof x === "number") { if (Number.isFinite(x)) for (const s of variants(x)) out.add(s); return; }
    if (typeof x === "string") { for (const n of numbersIn(x)) for (const s of variants(n)) out.add(s); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") Object.values(x as object).forEach(walk);
  };
  walk(pack);
  return out;
}

/** الأرقام التي في النص وليست في الوقائع. فارغة = النص سليم. Pure. */
export function unknownNumbers(narrative: string, pack: unknown): number[] {
  const known = factNumbers(pack);
  return [...new Set(numbersIn(narrative))].filter((n) => !known.has(fmt(n)));
}

// ── الوقائع ───────────────────────────────────────────────────────
const num = (v: unknown) => Number(v ?? 0);
const POSITIVE = sql`('interested','question','considering','later','referral')`;
const LEAD_LABELS = sql`('hot','interested','order')`;

export interface Problem {
  id: string; severity: "critical" | "warn"; problem: string; why: string; owner: string; category: Category;
  metric: { key: string; value: number; better: "higher" | "lower" } | null; evidence?: unknown;
}
export interface DepartmentFact { department: string; executions: number; failed: number; successRate: number | null; tokens: number; calls: number; costUsd: number | null; outcome: number | null; outcomeLabel: string | null }

export interface FactPack {
  accountId: number; day: string; windowDays: number;
  activity: { executions: number; emailsSent: number; inbound: number; waSends: number; tasksClosed: number };
  outcomes: { positiveReplies: number; companiesPositive: number; qualifiedLeads: number; meetings: number; bounced: number; bounceRate: number | null; humanOpens: number };
  departments: DepartmentFact[];
  overdueEmployees: Array<{ employeeKey: string; overdue: number }>;
  failingEmployees: Array<{ employeeKey: string; consecutiveFailures: number; lastError: string | null }>;
  noExecutionEmployees: string[];
  failingWorkflows: Array<{ workflow: string; failed: number; total: number }>;
  campaignsWithLeads: Array<{ campaignId: number; name: string; positive: number }>;
  channels: Array<{ channel: string; state: string; sent: number; positive: number | null }>;
  queue: { emailQueued: number; heldStale: number };
  approvalsWaiting: number;
  problems: Problem[];
  thin: boolean;
}

/** أقل من هذا من مجموع الأعمال: «الوقائع قليلة» ويقولها التقرير. */
export const THIN_ACTIVITY = 10;
export const WASTE_MIN_TOKENS = 1000;
const BOUNCE_ALERT_PCT = 5, BOUNCE_ALERT_MIN = 50;

/** أعلى قسمٍ نتيجةً تجارية. لا نتيجة = لا أحد. Pure. */
export function bestDepartment(ds: DepartmentFact[]) {
  const top = ds.filter((d) => (d.outcome ?? 0) > 0).sort((a, b) => b.outcome! - a.outcome!)[0];
  return top ? { department: top.department, value: top.outcome!, basis: top.outcomeLabel ?? "" } : null;
}
/**
 * أكثر قسمٍ استهلاكاً بلا نتيجة. Pure. قسمٌ لا نتيجة تجارية له بطبيعته (المشترك، التنفيذي:
 * outcomeLabel فارغ) لا يُحكم عليه بالهدر: عمله خدمة غيره، لا ردود ولا اجتماعات.
 */
export function wastefulDepartment(ds: DepartmentFact[]) {
  const top = ds.filter((d) => d.outcomeLabel != null && d.tokens >= WASTE_MIN_TOKENS && !d.outcome).sort((a, b) => b.tokens - a.tokens)[0];
  return top ? { department: top.department, tokens: top.tokens, calls: top.calls, costUsd: top.costUsd, outcome: top.outcome ?? 0 } : null;
}

// ── حقول §8: بالكود وحده ───────────────────────────────────────────
export interface VerifiedMetric { key: string; value: number | null; source: string; windowDays: number; note?: string }
/** الأرقام التي جاءت من صفوف، بمصدرها. نسبةٌ بلا عيّنتها الدنيا null لا صفر. Pure. */
export function verifiedMetrics(p: FactPack): VerifiedMetric[] {
  const w = p.windowDays;
  const m = (key: string, value: number | null, source: string, note?: string): VerifiedMetric => ({ key, value, source, windowDays: w, ...(note ? { note } : {}) });
  return [
    m("emails_sent", p.activity.emailsSent, "email_messages.sent_at"),
    m("positive_replies", p.outcomes.positiveReplies, "email_inbound.intent"),
    m("companies_positive", p.outcomes.companiesPositive, "email_inbound.from_email (نطاق)"),
    m("qualified_leads", p.outcomes.qualifiedLeads, "conversation_reviews.label"),
    m("meetings", p.outcomes.meetings, "target_accounts.meeting_at"),
    m("bounced", p.outcomes.bounced, "email_messages.bounced_at"),
    m("bounce_rate", p.outcomes.bounceRate, "email_messages", p.outcomes.bounceRate == null ? `أقل من ${BOUNCE_ALERT_MIN} رسالة: لا نسبة` : undefined),
    m("wa_sends", p.activity.waSends, "wa_firewall_sends"),
    m("executions", p.activity.executions, "employee_executions"),
    m("tasks_closed", p.activity.tasksClosed, "employee_tasks (بلا تذاكر المحاكاة)"),
  ];
}
export interface DataGap { key: string; detail: string }
/** ما لا تكفي له البيانات، مسمّى. Pure. */
export function dataGaps(p: FactPack): DataGap[] {
  const out: DataGap[] = [];
  if (p.thin) out.push({ key: "thin", detail: `أقل من ${THIN_ACTIVITY} عملاً في ${p.windowDays} أيام` });
  if (p.outcomes.bounceRate == null) out.push({ key: "bounce_rate", detail: `أقل من ${BOUNCE_ALERT_MIN} رسالة بريد: نسبة الارتداد غير محسوبة` });
  for (const d of p.departments) if (d.executions > 0 && d.successRate == null) out.push({ key: `success_rate:${d.department}`, detail: `قسم ${d.department}: ${d.executions} تنفيذ، أقل من ١٠ لنسبة نجاح` });
  for (const k of p.noExecutionEmployees) out.push({ key: `no_execution:${k}`, detail: `${k} بلا تنفيذ مسجَّل` });
  for (const c of p.channels) if (["unknown", "no_session", "no_account", "no_driver"].includes(c.state)) out.push({ key: `channel:${c.channel}`, detail: `قناة ${c.channel}: ${c.state}` });
  return out;
}
/** ثقة التقرير: قليل الوقائع منخفض، وكثير الفجوات أو نصٌّ لم يُتحقق منه متوسط. Pure. */
export function reportConfidence(p: FactPack, gaps: DataGap[], status: string): "low" | "medium" | "high" {
  if (p.thin || gaps.length >= 6) return "low";
  if (gaps.length >= 3 || status !== "validated") return "medium";
  return "high";
}
export interface OverdueTicket { taskId: number; ownerRole: string; taskType: string; status: string; dueAt: unknown; expiresAt: unknown }

export async function collectFacts(userId: number, now = new Date()): Promise<FactPack> {
  const days = 7, from = new Date(now.getTime() - days * 86_400_000);
  const today = dubaiNow(now).date;
  const fromDay = new Date(from.getTime() + 4 * 3_600_000).toISOString().slice(0, 10);
  const [ex] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM employee_executions WHERE user_id = ${userId} AND started_at >= ${from}`)).rows;
  const [mail] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE sent_at >= ${from})::int AS sent, count(*) FILTER (WHERE bounced_at >= ${from})::int AS bounced, count(*) FILTER (WHERE opened_at >= ${from})::int AS opens FROM email_messages WHERE user_id = ${userId} AND (sent_at >= ${from} OR bounced_at >= ${from} OR opened_at >= ${from})`)).rows;
  const [inb] = (await db.execute<any>(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE i.intent IN ${POSITIVE})::int AS positive, count(DISTINCT lower(split_part(i.from_email, '@', 2))) FILTER (WHERE i.intent IN ${POSITIVE})::int AS companies FROM email_inbound i
    WHERE i.user_id = ${userId} AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true) AND i.received_at >= ${from}`)).rows;
  const [deskPos] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM email_inbound i WHERE i.user_id = ${userId} AND i.intent IN ${POSITIVE} AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true) AND i.received_at >= ${from}
    AND EXISTS (SELECT 1 FROM target_accounts t WHERE t.user_id = i.user_id AND t.domain = lower(split_part(i.from_email, '@', 2)))`)).rows;
  const [wa] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND at >= ${from}`)).rows;
  const [leads] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM conversation_reviews WHERE user_id = ${userId} AND label IN ${LEAD_LABELS} AND reviewed_at >= ${from}`)).rows;
  const [meet] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM target_accounts WHERE user_id = ${userId} AND meeting_at >= ${from}`)).rows;
  const [closed] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM employee_tasks WHERE user_id = ${userId} AND status IN ('completed','failed') AND updated_at >= ${from} AND ${REAL_TASK}`)).rows;

  // ما استهلكه كل قسم: توكنات الإيصالات، ونداءات llm_usage، وتجمعان بالدور إلى القسم.
  const receiptRows = (await db.execute<any>(sql`SELECT node, coalesce(sum(tokens_in), 0)::bigint + coalesce(sum(tokens_out), 0)::bigint AS tokens FROM receipts WHERE user_id = ${userId} AND action = 'llm.call' AND at >= ${from} GROUP BY node`)).rows;
  const usageRows = (await db.execute<any>(sql`SELECT role, sum(calls)::bigint AS calls FROM llm_usage WHERE user_id = ${userId} AND day >= ${fromDay}::date GROUP BY role`)).rows;
  // الكلفة من provider_prices عبر سطر التنفيذ (runtime.meterFacts). جولةٌ نادت نموذجاً بلا سعر تجعل
  // كلفة القسم null («غير متاح»): جمع المسعَّر وحده يقول رقماً أصغر من الحقيقة.
  const costRows = (await db.execute<any>(sql`SELECT employee_key, coalesce(sum(cost_usd), 0) AS cost, count(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced,
      count(*) FILTER (WHERE cost_usd IS NULL AND model_calls > 0)::int AS unpriced
    FROM employee_executions WHERE user_id = ${userId} AND started_at >= ${from} GROUP BY employee_key`)).rows;
  const execRows = (await db.execute<any>(sql`SELECT e.employee_key, b.role, count(*)::int AS total, count(*) FILTER (WHERE e.status = 'failed')::int AS failed FROM employee_executions e LEFT JOIN bot_employees b ON b.user_id = e.user_id AND b.employee_key = e.employee_key
    WHERE e.user_id = ${userId} AND e.started_at >= ${from} AND e.status IN ('succeeded','failed') GROUP BY 1, 2`)).rows;
  const emailPositive = Math.max(0, num(inb?.positive) - num(deskPos?.n));
  const outcomeOf: Partial<Record<string, { value: number; label: string }>> = {
    email: { value: emailPositive, label: "ردود نافعة على الموجات" },
    target_accounts: { value: num(deskPos?.n) + num(meet?.n), label: "ردود نافعة واجتماعات من الحسابات المستهدفة" },
    whatsapp: { value: num(leads?.n), label: "محادثات حارة أو مهتمة أو طلب" },
  };
  const departments: DepartmentFact[] = DEPARTMENTS.map((d) => {
    const execs = execRows.filter((r: any) => (r.role ? orgDepartmentOf(r.role) : String(r.employee_key).split(".")[0]) === d);
    const executions = execs.reduce((a: number, r: any) => a + num(r.total), 0), failed = execs.reduce((a: number, r: any) => a + num(r.failed), 0);
    const costs = costRows.filter((r: any) => String(r.employee_key).split(".")[0] === d);
    const cost = costs.reduce((a: number, r: any) => a + Number(r.cost), 0);
    const costKnown = costs.some((r: any) => num(r.priced) > 0) && !costs.some((r: any) => num(r.unpriced) > 0);
    return {
      department: d, executions, failed, successRate: executions >= 10 ? (executions - failed) / executions : null,
      tokens: receiptRows.filter((r: any) => orgDepartmentOf(r.node) === d).reduce((a: number, r: any) => a + num(r.tokens), 0),
      calls: usageRows.filter((r: any) => orgDepartmentOf(r.role) === d).reduce((a: number, r: any) => a + num(r.calls), 0),
      costUsd: costKnown ? Math.round(cost * 100_000) / 100_000 : null,
      outcome: outcomeOf[d]?.value ?? null, outcomeLabel: outcomeOf[d]?.label ?? null,
    };
  });

  const findings = await watchdogFindings(userId);
  const overdue = (await db.execute<any>(sql`SELECT owner_role, count(*)::int AS n FROM employee_tasks WHERE user_id = ${userId} AND ${REAL_TASK} AND ((status IN ('queued','pending','waiting_for_dependency') AND expires_at IS NOT NULL AND expires_at <= now()) OR (status = 'expired' AND updated_at >= ${from}) OR (status = 'running' AND lease_expires_at <= now())) GROUP BY 1`)).rows
    .map((r: any) => ({ employeeKey: employeeKeyOf(r.owner_role), overdue: num(r.n) }));
  for (const f of findings.filter((x) => x.kind === "missed_heartbeat")) {
    const hit = overdue.find((o: any) => o.employeeKey === f.subject);
    if (hit) hit.overdue++; else overdue.push({ employeeKey: f.subject, overdue: 1 });
  }
  const failing = (await db.execute<any>(sql`SELECT employee_key, consecutive_failures, last_error FROM employee_heartbeats WHERE user_id = ${userId} AND consecutive_failures >= 3 ORDER BY consecutive_failures DESC LIMIT 20`)).rows
    .map((r: any) => ({ employeeKey: r.employee_key, consecutiveFailures: num(r.consecutive_failures), lastError: r.last_error ? String(r.last_error).slice(0, 160) : null }));
  const noExec = (await db.execute<any>(sql`SELECT b.employee_key FROM bot_employees b LEFT JOIN employee_heartbeats h ON h.user_id = b.user_id AND h.employee_key = b.employee_key
    WHERE b.user_id = ${userId} AND b.is_active AND b.employee_key IS NOT NULL AND b.role <> ${CEO_ROLE} AND h.employee_key IS NULL
      AND b.employee_key NOT LIKE 'linkedin.%'
      AND NOT (b.role IN ('ig_inviter','ig_analyst','tt_inviter','tt_analyst') AND NOT EXISTS (SELECT 1 FROM social_accounts sa WHERE sa.user_id = b.user_id
        AND sa.platform = CASE WHEN b.role LIKE 'ig_%' THEN 'instagram' ELSE 'tiktok' END)) ORDER BY 1`)).rows.map((r: any) => String(r.employee_key));
  const flows = (await db.execute<any>(sql`SELECT workflow, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total FROM workflow_executions WHERE user_id = ${userId} AND started_at >= ${from} GROUP BY 1 HAVING count(*) FILTER (WHERE status = 'failed') > 0 ORDER BY 2 DESC LIMIT 10`)).rows
    .map((r: any) => ({ workflow: r.workflow, failed: num(r.failed), total: num(r.total) }));
  const campaigns = (await db.execute<any>(sql`SELECT c.id, c.name, count(DISTINCT lower(split_part(i.from_email, '@', 2)))::int AS positive FROM email_inbound i JOIN email_messages m ON m.id = i.message_id AND m.user_id = i.user_id JOIN email_campaigns c ON c.id = m.campaign_id
    WHERE i.user_id = ${userId} AND i.intent IN ${POSITIVE} AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true) AND i.received_at >= ${from} GROUP BY c.id, c.name ORDER BY 3 DESC LIMIT 10`)).rows
    .map((r: any) => ({ campaignId: num(r.id), name: String(r.name), positive: num(r.positive) }));
  const social = (await db.execute<any>(sql`SELECT a.platform, a.state, a.dry_run, (SELECT count(*)::int FROM social_actions x WHERE x.user_id = a.user_id AND x.platform = a.platform AND x.ok AND x.created_at >= ${from}) AS sent FROM social_accounts a WHERE a.user_id = ${userId}`)).rows;
  let waState = "unknown";
  try {
    const { waManager } = await import("../whatsapp");
    const st = waManager.allStates().find((x) => x.userId === userId);
    waState = !st ? "no_session" : st.connected ? "connected" : st.status;
  } catch {}
  const channels = [
    { channel: "email", state: num(mail?.sent) ? "sending" : "idle", sent: num(mail?.sent), positive: num(inb?.positive) },
    { channel: "whatsapp", state: waState, sent: num(wa?.n), positive: num(leads?.n) },
    ...["instagram", "tiktok"].map((p) => {
      const a = social.find((x: any) => x.platform === p);
      return { channel: p, state: a ? `${a.state}${a.dry_run ? ", dry_run" : ""}` : "no_account", sent: num(a?.sent), positive: null };
    }),
    { channel: "linkedin", state: "no_driver", sent: 0, positive: null },
  ];
  const q = await queueReview(userId);
  const [appr] = (await db.execute<any>(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE updated_at < now() - make_interval(days => ${WAIT_APPROVAL_DAYS}))::int AS old FROM employee_tasks WHERE user_id = ${userId} AND status = 'waiting_for_approval' AND ${REAL_TASK}`)).rows;

  const sent = num(mail?.sent), bounced = num(mail?.bounced);
  const bounceRate = sent >= BOUNCE_ALERT_MIN ? bounced / sent : null;
  const activityTotal = num(ex?.n) + sent + num(inb?.n) + num(wa?.n) + num(closed?.n);
  const problems: Problem[] = [];
  for (const f of failing) problems.push({ id: `failing:${f.employeeKey}`, severity: "critical", problem: `${f.employeeKey} يفشل تكراراً`, why: `${f.consecutiveFailures} فشل متتالٍ${f.lastError ? `: ${f.lastError}` : ""}`, owner: "ops", category: "internal_analytics", metric: { key: `failures:${f.employeeKey}`, value: f.consecutiveFailures, better: "lower" } });
  if (bounceRate != null && bounceRate * 100 >= BOUNCE_ALERT_PCT) problems.push({ id: "bounce", severity: "critical", problem: "الارتداد فوق الحد", why: `${bounced} من ${sent} في ${days} أيام`, owner: "email_guard", category: "limits", metric: { key: "bounce_rate", value: bounceRate, better: "lower" } });
  if (waState !== "connected" && num(wa?.n) > 0) problems.push({ id: "wa_down", severity: "critical", problem: "واتساب غير متصل وعليه عمل", why: `الحالة ${waState}، وخرج ${num(wa?.n)} رسالة في ${days} أيام`, owner: "ops", category: "channel_activation", metric: null });
  if (q.heldStale > 0) problems.push({ id: "queue_stale", severity: "warn", problem: "رسائل بريد ممسوكة أقدم من أسبوع", why: `${q.heldStale} رسالة تنتظر قرارك من أصل ${q.total} في الطابور`, owner: "email_guard", category: "external_strategy", metric: { key: "held_stale", value: q.heldStale, better: "lower" } });
  if (num(appr?.old) > 0) problems.push({ id: "approvals_old", severity: "warn", problem: "موافقات تنتظرك منذ أكثر من أسبوع", why: `${num(appr.old)} من ${num(appr.n)} مهمة تنتظر موافقة`, owner: "ops", category: "internal_analytics", metric: { key: "approvals_waiting", value: num(appr.n), better: "lower" } });
  for (const f of flows.slice(0, 2)) problems.push({ id: `flow:${f.workflow}`, severity: "warn", problem: `سير عمل ${f.workflow} يفشل`, why: `${f.failed} من ${f.total}`, owner: "ops", category: "internal_analytics", metric: { key: `flow_failed:${f.workflow}`, value: f.failed, better: "lower" } });
  const waste = wastefulDepartment(departments);
  if (waste) problems.push({ id: `waste:${waste.department}`, severity: "warn", problem: `قسم ${waste.department} يستهلك النموذج بلا نتيجة`, why: `${waste.tokens} توكن تقديري و${waste.calls} نداء، ونتيجته ${waste.outcome}`, owner: "ops", category: "internal_analytics", metric: { key: `waste_tokens:${waste.department}`, value: waste.tokens, better: "lower" } });
  for (const o of overdue.slice(0, 3)) problems.push({ id: `overdue:${o.employeeKey}`, severity: "warn", problem: `${o.employeeKey} فاتته مواعيد`, why: `${o.overdue} موعداً فائتاً`, owner: "ops", category: "internal_analytics", metric: { key: `overdue:${o.employeeKey}`, value: o.overdue, better: "lower" } });

  return {
    accountId: userId, day: today, windowDays: days,
    activity: { executions: num(ex?.n), emailsSent: sent, inbound: num(inb?.n), waSends: num(wa?.n), tasksClosed: num(closed?.n) },
    outcomes: { positiveReplies: num(inb?.positive), companiesPositive: num(inb?.companies), qualifiedLeads: num(leads?.n), meetings: num(meet?.n), bounced, bounceRate, humanOpens: num(mail?.opens) },
    departments, overdueEmployees: overdue, failingEmployees: failing, noExecutionEmployees: noExec, failingWorkflows: flows, campaignsWithLeads: campaigns, channels,
    queue: { emailQueued: q.total, heldStale: q.heldStale }, approvalsWaiting: num(appr?.n), problems, thin: activityTotal < THIN_ACTIVITY,
  };
}

/** رقمٌ من حزمة اليوم بمفتاحه، لقياس توصية الأسبوع الماضي. غياب المشكلة اليوم = صفر للأعداد، و null لما لا عيّنة له. Pure. */
export function metricValue(pack: FactPack, key: string): number | null {
  if (key === "bounce_rate") return pack.outcomes.bounceRate;
  if (key === "held_stale") return pack.queue.heldStale;
  if (key === "approvals_waiting") return pack.approvalsWaiting;
  const [kind, subject] = key.split(/:(.*)/s);
  if (kind === "failures") return pack.failingEmployees.find((f) => f.employeeKey === subject)?.consecutiveFailures ?? 0;
  if (kind === "overdue") return pack.overdueEmployees.find((f) => f.employeeKey === subject)?.overdue ?? 0;
  if (kind === "flow_failed") return pack.failingWorkflows.find((f) => f.workflow === subject)?.failed ?? 0;
  if (kind === "waste_tokens") return pack.departments.find((d) => d.department === subject)?.tokens ?? null;
  return null;
}

// ── النص ──────────────────────────────────────────────────────────
export type NarrativeStatus = "validated" | "facts_only" | "model_unavailable";
export interface Narrative { summary: string | null; ranking: string[]; status: NarrativeStatus; violations: number[] }

const NARRATIVE_SHAPE = { executive_summary: "string", ranking: "string[]" } as const;

/** ما يُعطى للنموذج: الوقائع كما هي، بلا نصوص أخطاء طويلة. */
const packForModel = (p: FactPack) => JSON.stringify(p);

/** يكتب النموذج، ويفحص الكود. مرةٌ ثانية عند مخالفة، ثم بلا نص. لا يرمي. */
export async function writeNarrative(pack: FactPack, persona: string, llm: typeof complete = complete): Promise<Narrative> {
  const ids = pack.problems.map((p) => p.id);
  const base = [
    { role: "system" as const, content: `${persona}\n\nاكتب بالعربية لصاحب العمل، بأسطر قصيرة. لا تكتب أي رقم غير موجود حرفياً في الوقائع، ولا تحسب نسبة جديدة، ولا ترقّم القوائم. النشاط ليس نتيجة. لا تقترح رفع الحجم. أعد JSON وحده بالشكل: {"executive_summary": "نص", "ranking": ["معرّف مشكلة", ...]} حيث ranking يرتّب معرّفات المشكلات المعطاة من الأهم إلى الأقل، بلا معرّف جديد.` },
    { role: "user" as const, content: `الوقائع (JSON):\n${packForModel(pack)}\n\nمعرّفات المشكلات: ${JSON.stringify(ids)}` },
  ];
  let violations: number[] = [];
  let answered = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const msgs = attempt === 0 ? base : [...base, { role: "user" as const, content: `النص السابق فيه أرقام ليست في الوقائع أو شكله غير صحيح: ${JSON.stringify(violations)}. أعد الكتابة بلا هذه الأرقام، وJSON وحده.` }];
    const res = await llm(msgs, 60_000, { maxTokens: 1500 }).catch(() => null);
    if (!res?.text) continue;
    answered = true;
    const parsed = parseStructured<{ executive_summary: string; ranking: string[] }>(res.text, NARRATIVE_SHAPE);
    if (!parsed.ok || !parsed.value.executive_summary.trim()) { violations = []; noteQuality(false, res, "narrative"); continue; }
    violations = unknownNumbers(parsed.value.executive_summary, pack);
    // جودة السرد: شكلٌ صحيح وكل رقمٍ فيه من الوقائع (routing.ts).
    noteQuality(!violations.length, res, "narrative");
    if (violations.length) continue;
    return { summary: parsed.value.executive_summary.trim().slice(0, 6000), ranking: parsed.value.ranking.filter((x) => ids.includes(x)), status: "validated", violations: [] };
  }
  return { summary: null, ranking: [], status: answered ? "facts_only" : "model_unavailable", violations };
}

/** ترتيب النموذج ما صحّ منه، ثم ترتيب الكود لما تركه: لا مشكلة تضيع ولا مشكلة تُختلق. Pure. */
export function rankProblems(problems: Problem[], ranking: string[]): Problem[] {
  const by = new Map(problems.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const out: Problem[] = [];
  for (const id of ranking) { const p = by.get(id); if (p && !seen.has(id)) { seen.add(id); out.push(p); } }
  for (const p of problems) if (!seen.has(p.id)) out.push(p);
  return out;
}

/** الوقائع بالكود إذا غاب النص: يبقى للتقرير جسمٌ يُقرأ. Pure. */
export function factsBody(p: FactPack): string {
  return [
    `آخر ${p.windowDays} أيام: ${p.activity.executions} تنفيذ، ${p.activity.emailsSent} رسالة بريد، ${p.activity.waSends} رسالة واتساب.`,
    `النتائج: ${p.outcomes.positiveReplies} رد نافع من ${p.outcomes.companiesPositive} شركة، ${p.outcomes.qualifiedLeads} محادثة مؤهلة، ${p.outcomes.meetings} اجتماع.`,
    p.problems.length ? `المشكلات: ${p.problems.slice(0, 3).map((x) => x.problem).join(" · ")}` : "لا مشكلة مرصودة.",
  ].join("\n");
}

// ── ما يُفعل ──────────────────────────────────────────────────────
const weekKey = (now: Date) => { const d = new Date(now.getTime() + 4 * 3_600_000); return `${d.getUTCFullYear()}-${Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / (7 * 86_400_000))}`; };
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** كل مشكلة في أعلى القائمة مهمةٌ لصاحبها مرةً في الأسبوع: تنتظر موافقة إن كانت فئتها تتطلبها. */
export async function issueRecommendations(userId: number, ranked: Problem[], now = new Date()): Promise<{ all: Array<Record<string, unknown>>; approval: Array<Record<string, unknown>> }> {
  const all: Array<Record<string, unknown>> = [], approval: Array<Record<string, unknown>> = [];
  for (const p of ranked.slice(0, 3)) {
    const cls = classify(p.category);
    const need = cls.risk === "approval_required";
    const { task } = await createTask({
      userId, ownerRole: p.owner, createdByRole: CEO_ROLE, taskType: "ceo_recommendation", approvalRequired: need, priority: p.severity === "critical" ? 20 : 60,
      input: { title: p.problem, why: p.why, category: p.category, baseline: p.metric, problemId: p.id },
      idempotencyKey: `ceo_rec:${weekKey(now)}:${hash(p.id)}`, expiresAt: new Date(now.getTime() + 14 * 86_400_000),
      // المدير يكلّف بتذكرة: المكلَّف مفتاح موظف بعينه، ومنشئها المدير نفسه.
      title: p.problem.slice(0, 300), objective: p.why, actionType: "ceo_recommendation", assignedTo: employeeKeyOf(p.owner),
      createdBy: { kind: "employee", id: employeeKeyOf(CEO_ROLE) }, dueAt: new Date(now.getTime() + 7 * 86_400_000),
      expectedOutput: "حركة المقياس المذكور في الأسبوع التالي (measureImprovements)",
    });
    const row = { title: p.problem, why: p.why, taskId: task.taskId, approvalRequired: need, category: p.category, evidence: p.metric };
    all.push(row);
    if (need) approval.push({ title: p.problem, taskId: task.taskId, category: p.category });
  }
  return { all, approval };
}

export interface ImprovementResult { taskId?: number; changeId?: number; title: string; metric: string | null; before: number | null; after: number | null; verdict: string }

/** هل تحرّك ما أوصى به الأسبوع الماضي؟ رقمان من الوقائع، وإلا INSUFFICIENT DATA. والنتيجة تُحفظ. */
export async function measureImprovements(userId: number, pack: FactPack, now = new Date()): Promise<ImprovementResult[]> {
  const tasks = (await db.execute<any>(sql`SELECT task_id, input_refs FROM employee_tasks WHERE user_id = ${userId} AND task_type = 'ceo_recommendation'
    AND created_at <= ${new Date(now.getTime() - 7 * 86_400_000)} AND created_at > ${new Date(now.getTime() - 30 * 86_400_000)} ORDER BY task_id DESC LIMIT 20`)).rows;
  const out: ImprovementResult[] = [];
  for (const t of tasks) {
    const b = t.input_refs?.baseline;
    const after = b?.key ? metricValue(pack, b.key) : null;
    const verdict = lessonOutcome(b?.value ?? null, after, b?.better ?? "lower");
    out.push({ taskId: Number(t.task_id), title: String(t.input_refs?.title ?? ""), metric: b?.key ?? null, before: b?.value ?? null, after, verdict });
    await db.execute(sql`INSERT INTO learning_events (user_id, employee_key, department, event_type, outcome, evidence)
      SELECT ${userId}, ${CEO_KEY}, 'executive', 'ceo_rec_outcome', ${verdict === INSUFFICIENT ? "insufficient" : verdict}, ${JSON.stringify({ taskId: Number(t.task_id), metric: b?.key ?? null, before: b?.value ?? null, after, day: pack.day })}::jsonb
      WHERE NOT EXISTS (SELECT 1 FROM learning_events WHERE user_id = ${userId} AND event_type = 'ceo_rec_outcome' AND evidence->>'day' = ${pack.day} AND (evidence->>'taskId')::int = ${Number(t.task_id)})`);
  }
  // تعليمات فُعّلت: درجة الموظف قبلها وبعدها من البطاقات المحفوظة.
  const applied = (await db.execute<any>(sql`SELECT change_id, target, applied_at FROM improvement_proposals WHERE user_id = ${userId} AND status = 'applied' AND target LIKE 'prompt:%' AND applied_at > ${new Date(now.getTime() - 30 * 86_400_000)} ORDER BY change_id DESC LIMIT 10`)).rows;
  for (const a of applied) {
    const key = String(a.target).slice(7);
    const score = async (cond: any) => {
      const [r] = (await db.execute<any>(sql`SELECT score FROM employee_scorecards WHERE user_id = ${userId} AND employee_key = ${key} AND period_key LIKE 'weekly:%' AND score IS NOT NULL AND ${cond} ORDER BY created_at DESC LIMIT 1`)).rows;
      return r ? Number(r.score) : null;
    };
    const before = await score(sql`created_at <= ${a.applied_at}`), after = await score(sql`created_at > ${a.applied_at}`);
    out.push({ changeId: Number(a.change_id), title: `تعليمات ${key}`, metric: "weekly_score", before, after, verdict: lessonOutcome(before, after, "higher", 1) });
  }
  return out;
}

/** خلاصة: هل تحرّكت؟ Pure. */
export function improvementsVerdict(rows: ImprovementResult[]): "improved" | "worse" | "mixed" | "none" | typeof INSUFFICIENT {
  if (!rows.length) return "none";
  const known = rows.filter((r) => r.verdict !== INSUFFICIENT);
  if (!known.length) return INSUFFICIENT;
  const up = known.some((r) => r.verdict === "improved"), down = known.some((r) => r.verdict === "worse");
  return up && down ? "mixed" : up ? "improved" : down ? "worse" : "mixed";
}

// ── التقرير ───────────────────────────────────────────────────────
export interface CeoRunResult { ran: boolean; reason?: string; report?: any }

const REPORT_COLUMNS = sql`id, user_id AS account_id, period, period_key, created_at, narrative_status, executive_summary, thin_data, department_performance, employee_alerts, operational_risks, revenue_opportunities, resource_issues, top_priorities, recommended_actions, actions_requiring_approval, previous_improvement_results, answers, verified_metrics, overdue_tickets, assigned_ticket_ids, data_gaps, confidence`;

async function buildReport(userId: number, llm: typeof complete, now: Date) {
  await ensureSimTables();
  const pack = await collectFacts(userId, now);
  const [emp] = (await db.execute<any>(sql`SELECT persona FROM bot_employees WHERE user_id = ${userId} AND role = ${CEO_ROLE}`)).rows;
  const narrative: Narrative = pack.thin
    ? { summary: `الوقائع قليلة (${pack.activity.executions} تنفيذ و${pack.activity.emailsSent} رسالة في ${pack.windowDays} أيام): لا يكفي هذا لاستنتاج. ما يُرى كما هو أدناه.`, ranking: [], status: "facts_only", violations: [] }
    : await writeNarrative(pack, emp?.persona || CEO_PERSONA, llm);
  const ranked = rankProblems(pack.problems, narrative.ranking);
  const rec = await issueRecommendations(userId, ranked, now);
  const improvements = await measureImprovements(userId, pack, now);
  const waste = wastefulDepartment(pack.departments);
  const findings = await watchdogFindings(userId);
  const answers = {
    bestDepartment: bestDepartment(pack.departments), wastefulDepartment: waste,
    missingDeadlines: pack.overdueEmployees.map((o) => o.employeeKey), failingWorkflows: pack.failingWorkflows,
    campaignsWithLeads: pack.campaignsWithLeads, channels: pack.channels,
    topProblems: ranked.slice(0, 3).map((p) => p.problem), doFirst: ranked[0]?.problem ?? null, lastWeekImprovements: improvementsVerdict(improvements),
  };
  const alerts = [
    ...pack.overdueEmployees.map((o) => ({ employeeKey: o.employeeKey, kind: "missed_deadline", detail: `${o.overdue} موعداً فائتاً`, value: o.overdue })),
    ...pack.failingEmployees.map((f) => ({ employeeKey: f.employeeKey, kind: "failing", detail: f.lastError ?? "فشل متتالٍ", value: f.consecutiveFailures })),
    ...pack.noExecutionEmployees.map((k) => ({ employeeKey: k, kind: "no_execution", detail: "لا تنفيذ مسجَّل له", value: 0 })),
  ];
  const summary = narrative.summary;
  const period = "daily", periodKey = pack.day;
  const J = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;
  const opportunities = pack.campaignsWithLeads.map((c) => ({ kind: "campaign_leads", subject: c.name, detail: `${c.positive} شركة ردّت رداً نافعاً`, ref: c.campaignId }));
  const resources = waste ? [{ department: waste.department, tokens: waste.tokens, calls: waste.calls, costUsd: waste.costUsd, outcome: waste.outcome, detail: "يستهلك النموذج بلا نتيجة مقاسة" }] : [];
  const risks = findings.map((f) => ({ kind: f.kind, subject: f.subject, severity: f.severity, detail: f.detail }));
  const priorities = ranked.slice(0, 3).map((p, i) => ({ rank: i + 1, problem: p.problem, why: p.why, id: p.id }));
  // §8: بالكود من الصفوف نفسها.
  const overdueTickets: OverdueTicket[] = (await db.execute<any>(sql`SELECT task_id, owner_role, task_type, status, due_at, expires_at FROM employee_tasks WHERE user_id = ${userId} AND ${REAL_TASK}
      AND ((due_at IS NOT NULL AND due_at < now() AND status NOT IN ('completed','cancelled','failed','expired')) OR (status = 'running' AND lease_expires_at <= now())
        OR (expires_at IS NOT NULL AND expires_at <= now() AND status IN ('pending','queued','waiting_for_dependency','waiting_for_approval')))
      ORDER BY coalesce(due_at, expires_at, lease_expires_at) LIMIT 20`)).rows
    .map((r: any) => ({ taskId: Number(r.task_id), ownerRole: r.owner_role, taskType: r.task_type, status: r.status, dueAt: r.due_at, expiresAt: r.expires_at }));
  const assignedTicketIds = rec.all.map((r) => Number(r["taskId"])).filter((x) => Number.isFinite(x));
  const gaps = dataGaps(pack);
  const confidence = reportConfidence(pack, gaps, narrative.status);
  const [row] = (await db.execute<any>(sql`INSERT INTO executive_reports (user_id, period, period_key, body, metrics, created_by, executive_summary, narrative_status, thin_data, department_performance, employee_alerts, operational_risks,
      revenue_opportunities, resource_issues, top_priorities, recommended_actions, actions_requiring_approval, previous_improvement_results, answers, verified_metrics, overdue_tickets, assigned_ticket_ids, data_gaps, confidence)
    VALUES (${userId}, ${period}, ${periodKey}, ${summary ?? factsBody(pack)}, ${J(pack)}, ${CEO_ROLE}, ${summary}, ${narrative.status}, ${pack.thin}, ${J(pack.departments)}, ${J(alerts)}, ${J(risks)}, ${J(opportunities)}, ${J(resources)}, ${J(priorities)}, ${J(rec.all)}, ${J(rec.approval)}, ${J(improvements)}, ${J(answers)},
      ${J(verifiedMetrics(pack))}, ${J(overdueTickets)}, ${J(assignedTicketIds)}, ${J(gaps)}, ${confidence})
    ON CONFLICT (user_id, period, period_key) DO UPDATE SET body = EXCLUDED.body, metrics = EXCLUDED.metrics, executive_summary = EXCLUDED.executive_summary, narrative_status = EXCLUDED.narrative_status, thin_data = EXCLUDED.thin_data,
      department_performance = EXCLUDED.department_performance, employee_alerts = EXCLUDED.employee_alerts, operational_risks = EXCLUDED.operational_risks, revenue_opportunities = EXCLUDED.revenue_opportunities, resource_issues = EXCLUDED.resource_issues,
      top_priorities = EXCLUDED.top_priorities, recommended_actions = EXCLUDED.recommended_actions, actions_requiring_approval = EXCLUDED.actions_requiring_approval, previous_improvement_results = EXCLUDED.previous_improvement_results, answers = EXCLUDED.answers,
      verified_metrics = EXCLUDED.verified_metrics, overdue_tickets = EXCLUDED.overdue_tickets, assigned_ticket_ids = EXCLUDED.assigned_ticket_ids, data_gaps = EXCLUDED.data_gaps, confidence = EXCLUDED.confidence, created_at = now()
    RETURNING ${REPORT_COLUMNS}`)).rows;
  return row;
}

/** تقرير اليوم لحسابٍ واحد. يمرّ على runAs: المفتاح والنبض والتنفيذ من مكانٍ واحد. */
export async function runCeoDaily(userId: number, o: { llm?: typeof complete; now?: Date } = {}): Promise<CeoRunResult> {
  await ensureOrgTables();
  await ensureCeo(userId);
  await backfillRegistry(userId);
  const out = await execute(userId, CEO_ROLE, { kind: "ceo_daily" }, () => buildReport(userId, o.llm ?? complete, o.now ?? new Date()));
  return out.ran ? { ran: true, report: out.value } : { ran: false, reason: out.halt.reason ?? "موقوف" };
}

export async function listReports(userId: number, limit = 30): Promise<any[]> {
  await ensureOrgTables();
  await ensureSimTables();
  const r = await db.execute<any>(sql`SELECT ${REPORT_COLUMNS} FROM executive_reports WHERE user_id = ${userId} ORDER BY period_key DESC, id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
  return r.rows;
}

/** للمدير: أعداد على المنصة كلها، بلا اسم ولا محتوى حساب. */
export async function adminOverview() {
  await ensureOrgTables();
  const [r] = (await db.execute<any>(sql`SELECT
      (SELECT count(DISTINCT user_id)::int FROM bot_employees) AS accounts, (SELECT count(*)::int FROM bot_employees WHERE employee_key IS NOT NULL) AS employees,
      (SELECT count(*)::int FROM employee_tasks WHERE status IN ('queued','running','waiting_for_dependency','waiting_for_approval','pending') AND ${REAL_TASK}) AS active_tasks,
      (SELECT count(*)::int FROM employee_tasks WHERE status = 'failed' AND ${REAL_TASK}) AS failed_tasks,
      (SELECT count(*)::int FROM executive_reports WHERE created_at > now() - interval '7 days') AS reports_7d,
      (SELECT count(*)::int FROM improvement_proposals WHERE status = 'proposed') AS proposals_pending`)).rows;
  return { accounts: num(r.accounts), employees: num(r.employees), activeTasks: num(r.active_tasks), failedTasks: num(r.failed_tasks), reports7d: num(r.reports_7d), proposalsPending: num(r.proposals_pending) };
}

// ── الجدول ────────────────────────────────────────────────────────
const SCORE_AT = { hour: 7, minute: 0 }, CEO_AT = { hour: 7, minute: 30 };
const scoredOn = new Map<number, string>(), reportedOn = new Map<number, string>();

const reached = (now: { hour: number; minute: number }, at: { hour: number; minute: number }) => now.hour > at.hour || (now.hour === at.hour && now.minute >= at.minute);

/** مرورٌ واحد: البطاقات والجاهزية 07:00، والتقرير 07:30 دبي. مرةً في اليوم لكل حساب، ويُكمل إن أقلع الخادم متأخراً. */
export async function ceoTick(now = new Date()): Promise<void> {
  const t = dubaiNow(now);
  if (!reached(t, SCORE_AT)) return;
  await ensureOrgTables();
  const users = (await db.execute<{ user_id: number }>(sql`SELECT DISTINCT user_id FROM bot_employees`)).rows.map((r) => Number(r.user_id));
  for (const userId of users) {
    if (await accountHalted(userId, "org_intelligence")) continue;
    if (scoredOn.get(userId) !== t.date) {
      scoredOn.set(userId, t.date);
      await ensureCeo(userId).then(() => seedPromptProposals(userId)).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "توظيف الرئيس التنفيذي تعذّر"));
      await scoreAccount(userId, ["weekly", "monthly"], now).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "بطاقات اليوم لم تُحسب"));
      const { readiness } = await import("./readiness");
      await readiness(userId, { verify: true }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "جاهزية اليوم لم تُفحص"));
    }
    if (!reached(t, CEO_AT) || reportedOn.get(userId) === t.date) continue;
    // بعد إعادة التشغيل: التقرير نفسه محفوظ، فلا نداء نموذج ثانٍ.
    const [done] = (await db.execute(sql`SELECT 1 FROM executive_reports WHERE user_id = ${userId} AND period = 'daily' AND period_key = ${t.date}`)).rows;
    reportedOn.set(userId, t.date);
    if (done) continue;
    await runCeoDaily(userId, { now }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "تقرير الرئيس التنفيذي فشل"));
  }
}

let timer: NodeJS.Timeout | null = null;
export function startCeoAgent(): void {
  if (timer) return;
  timer = everyMs("executive.ceo", 5 * 60_000, () => ceoTick(), { firstMs: 3 * 60_000, unref: true });
  logger.info("الرئيس التنفيذي بدأ — البطاقات 07:00 والتقرير 07:30 بتوقيت دبي");
}

/** للاختبار وحده. */
export const forgetCeoSchedule = () => { scoredOn.clear(); reportedOn.clear(); };
