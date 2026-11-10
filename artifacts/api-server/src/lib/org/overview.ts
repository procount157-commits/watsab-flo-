// ── لوحة المنظّمة ─────────────────────────────────────────────────
// ما يُعرض في /org/overview و/org/employees/:key: استعلاماتٌ على حساب الجلسة وحده،
// ولا رقم يُكتب هنا لم يأتِ من صف.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { memoryFor } from "./memory";
import { listProposals, promptTarget } from "./proposals";
import { PROMPT_LIBRARY } from "./prompts";
import { orgRegistry, DEPARTMENTS, type InventoryRow } from "./registry";
import { readiness, waLoggedOut } from "./readiness";
import { latestScorecards, scorecardHistory } from "./scorecards";
import { STALE_DAYS } from "./queue";
import { watchdogFindings } from "./watchdog";
import { collectFacts } from "./ceo";
import { APPROVAL_CATEGORIES } from "./proposals";
import { REAL_TASK } from "./sim-schema";

const num = (v: unknown) => Number(v ?? 0);
const BUCKETS = { healthy: "healthy", running: "running", late: "delayed", failed: "failed", halted: "paused", no_execution: "no_execution" } as const;
export const emptyCounts = () => ({ healthy: 0, running: 0, delayed: 0, failed: 0, paused: 0, no_execution: 0 });

/** عدّ الموظفين بحالتهم، للمنظّمة أو لقسم. Pure. */
export function countStates(rows: Array<Pick<InventoryRow, "heartbeat_status">>) {
  const c = { total: rows.length, ...emptyCounts() };
  for (const r of rows) c[BUCKETS[r.heartbeat_status]]++;
  return c;
}

/** ما انقضى من مواعيد المهام: موعد فات، أو عقد انتهى، أو انتظر فوق حد الحارس. */
const OVERDUE = sql`((due_at IS NOT NULL AND due_at < now() AND status NOT IN ('completed','cancelled','failed','expired'))
  OR (status = 'running' AND lease_expires_at <= now())
  OR (expires_at IS NOT NULL AND expires_at <= now() AND status IN ('pending','queued','waiting_for_dependency','waiting_for_approval')))`;

export async function outcomeTrends(userId: number, now = new Date()) {
  const a = new Date(now.getTime() - 7 * 86_400_000), b = new Date(now.getTime() - 14 * 86_400_000);
  const POS = sql`i.intent IN ('interested','question','considering','later','referral') AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true)`;
  const LEADS = sql`label IN ('hot','interested','order')`;
  const [m] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE sent_at >= ${a})::int AS s1, count(*) FILTER (WHERE sent_at >= ${b} AND sent_at < ${a})::int AS s0,
      count(*) FILTER (WHERE bounced_at >= ${a})::int AS b1, count(*) FILTER (WHERE bounced_at >= ${b} AND bounced_at < ${a})::int AS b0,
      count(*) FILTER (WHERE opened_at >= ${a})::int AS o1, count(*) FILTER (WHERE opened_at >= ${b} AND opened_at < ${a})::int AS o0
    FROM email_messages WHERE user_id = ${userId} AND (sent_at >= ${b} OR bounced_at >= ${b} OR opened_at >= ${b})`)).rows;
  const [i] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE i.received_at >= ${a})::int AS p1, count(*) FILTER (WHERE i.received_at < ${a})::int AS p0,
      count(DISTINCT lower(split_part(i.from_email, '@', 2))) FILTER (WHERE i.received_at >= ${a})::int AS c1, count(DISTINCT lower(split_part(i.from_email, '@', 2))) FILTER (WHERE i.received_at < ${a})::int AS c0
    FROM email_inbound i WHERE i.user_id = ${userId} AND ${POS} AND i.received_at >= ${b}`)).rows;
  const [l] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE reviewed_at >= ${a})::int AS l1, count(*) FILTER (WHERE reviewed_at < ${a})::int AS l0 FROM conversation_reviews WHERE user_id = ${userId} AND ${LEADS} AND reviewed_at >= ${b}`)).rows;
  const [t] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE meeting_at >= ${a})::int AS m1, count(*) FILTER (WHERE meeting_at < ${a})::int AS m0 FROM target_accounts WHERE user_id = ${userId} AND meeting_at >= ${b}`)).rows;
  const [w] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE at >= ${a})::int AS w1, count(*) FILTER (WHERE at < ${a})::int AS w0 FROM wa_firewall_sends WHERE user_id = ${userId} AND at >= ${b}`)).rows;
  const row = (key: string, label: string, cur: unknown, prev: unknown) => ({ key, label, current: num(cur), previous: num(prev), delta: num(cur) - num(prev) });
  return [
    row("emails_sent", "رسائل بريد خرجت", m?.s1, m?.s0), row("positive_replies", "ردود نافعة", i?.p1, i?.p0), row("companies_positive", "شركات ردّت رداً نافعاً", i?.c1, i?.c0),
    row("bounced", "ارتدادات", m?.b1, m?.b0), row("human_opens", "فتح بشري (بلا فتحات الآلة)", m?.o1, m?.o0), row("qualified_leads", "محادثات واتساب مؤهلة", l?.l1, l?.l0),
    row("meetings", "اجتماعات", t?.m1, t?.m0), row("wa_sends", "رسائل واتساب خرجت", w?.w1, w?.w0),
  ];
}

const OVERVIEW_TTL_MS = 20_000;
const overviewCache = new Map<number, { at: number; value: Awaited<ReturnType<typeof buildOverview>> }>();
/** اللوحة تُفتح وتُحدَّث كثيراً، واستعلاماتها ليست خفيفة: عشرون ثانية لكل حساب. */
export async function orgOverview(userId: number) {
  const hit = overviewCache.get(userId);
  if (hit && Date.now() - hit.at < OVERVIEW_TTL_MS) return hit.value;
  const value = await buildOverview(userId);
  overviewCache.set(userId, { at: Date.now(), value });
  return value;
}

async function buildOverview(userId: number) {
  const staff = await orgRegistry(userId);
  const [tasks] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE status IN ('pending','queued','running','waiting_for_dependency','waiting_for_approval'))::int AS active, count(*) FILTER (WHERE ${OVERDUE})::int AS overdue FROM employee_tasks WHERE user_id = ${userId} AND ${REAL_TASK}`)).rows;
  const [q] = (await db.execute<any>(sql`SELECT count(*)::int AS n, min(created_at) AS oldest, count(*) FILTER (WHERE created_at <= now() - make_interval(days => ${STALE_DAYS}) AND stale_released_at IS NULL)::int AS held FROM email_messages WHERE user_id = ${userId} AND status = 'queued'`)).rows;
  const [qt] = (await db.execute<any>(sql`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE dead_letter)::int AS dead FROM employee_tasks WHERE user_id = ${userId} AND ${REAL_TASK}`)).rows;
  const [appr] = (await db.execute<any>(sql`SELECT (SELECT count(*)::int FROM employee_tasks WHERE user_id = ${userId} AND status = 'waiting_for_approval' AND ${REAL_TASK}) AS tasks,
      (SELECT count(*)::int FROM improvement_proposals WHERE user_id = ${userId} AND status = 'proposed') AS proposals,
      (SELECT count(*)::int FROM agent_memory WHERE user_id = ${userId} AND approval_status = 'pending') AS lessons`)).rows;
  let health = (await db.execute<any>(sql`SELECT integration, status, detail, last_ok_at, last_fail_at, checked_at FROM integration_health WHERE user_id = ${userId} ORDER BY integration`)).rows;
  if (!health.length) {
    await readiness(userId, { verify: false });
    health = (await db.execute<any>(sql`SELECT integration, status, detail, last_ok_at, last_fail_at, checked_at FROM integration_health WHERE user_id = ${userId} ORDER BY integration`)).rows;
  }
  const findings = await watchdogFindings(userId);
  const loggedOut = await waLoggedOut(userId).catch(() => null);
  const facts = await collectFacts(userId);
  const cards = await latestScorecards(userId, "weekly");
  const departments = DEPARTMENTS.map((d) => {
    const mine = staff.filter((s) => s.department === d);
    const f = facts.departments.find((x) => x.department === d);
    const scores = cards.filter((c) => c.status === "OK" && mine.some((m) => m.key === c.employeeKey)).map((c) => c.score!);
    const { total, ...states } = countStates(mine);
    return {
      department: d, employees: total, ...states, executions7d: f?.executions ?? 0, successRate: f?.successRate ?? null, tokens7d: f?.tokens ?? 0,
      avgScore: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : null,
      outcome: f?.outcome == null ? null : { label: f.outcomeLabel, value: f.outcome },
    };
  }).filter((d) => d.employees > 0);
  return {
    generatedAt: new Date().toISOString(), employees: countStates(staff), tasks: { active: num(tasks?.active), overdue: num(tasks?.overdue) }, departments,
    queue: { emailQueued: num(q?.n), emailOldest: q?.oldest ?? null, emailHeldStale: num(q?.held), tasksQueued: num(qt?.queued), deadLetter: num(qt?.dead) },
    integrations: health.map((h: any) => ({ integration: h.integration, status: h.status, detail: h.detail, lastOkAt: h.last_ok_at, lastFailAt: h.last_fail_at, checkedAt: h.checked_at })),
    risks: [
      ...(loggedOut ? [{ kind: "wa_logged_out", subject: "whatsapp", severity: "critical", detail: `خرج واتساب ${loggedOut.toISOString().slice(0, 16).replace("T", " ")} ومُسحت الجلسة: امسح رمز QR من /connect` }] : []),
      ...findings.map((f) => ({ kind: f.kind, subject: f.subject, severity: f.severity, detail: f.detail })),
    ],
    approvals: { tasks: num(appr?.tasks), proposals: num(appr?.proposals), lessons: num(appr?.lessons) },
    outcomes: await outcomeTrends(userId),
  };
}

export async function employeesList(userId: number) {
  const [staff, cards, versions] = await Promise.all([
    orgRegistry(userId), latestScorecards(userId, "weekly"),
    db.execute<any>(sql`SELECT employee_key, prompt_version FROM bot_employees WHERE user_id = ${userId}`),
  ]);
  const ver = new Map<string, number | null>(versions.rows.map((v: any) => [v.employee_key, v.prompt_version == null ? null : Number(v.prompt_version)]));
  return staff.map((s) => {
    const c = cards.find((x) => x.employeeKey === s.key);
    return { ...s, prompt_version: ver.get(s.key) ?? null, weekly: c ? { score: c.score, status: c.status } : null };
  });
}

export async function employeeProfile(userId: number, key: string) {
  const staff = await orgRegistry(userId);
  const profile = staff.find((s) => s.key === key);
  if (!profile) return null;
  const [emp] = (await db.execute<any>(sql`SELECT persona, prompt_version, is_active, role FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${key}`)).rows;
  const [versions, heartbeat, executions, tasks, errors, feedback, memory, trends, proposals] = await Promise.all([
    db.execute<any>(sql`SELECT version, note, active, created_by, created_at, prompt FROM employee_prompt_versions WHERE user_id = ${userId} AND employee_key = ${key} ORDER BY version DESC LIMIT 30`),
    db.execute<any>(sql`SELECT * FROM employee_heartbeats WHERE user_id = ${userId} AND employee_key = ${key}`),
    db.execute<any>(sql`SELECT id, kind, status, started_at, duration_ms, model_calls, tokens_in, tokens_out, error FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${key} ORDER BY id DESC LIMIT 50`),
    db.execute<any>(sql`SELECT * FROM employee_tasks WHERE user_id = ${userId} AND owner_role = ${emp.role} ORDER BY task_id DESC LIMIT 30`),
    db.execute<any>(sql`SELECT id, kind, error, started_at FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${key} AND status = 'failed' ORDER BY id DESC LIMIT 20`),
    db.execute<any>(sql`SELECT id, verdict, note, from_role, created_at FROM employee_feedback WHERE user_id = ${userId} AND employee_key = ${key} ORDER BY id DESC LIMIT 30`),
    memoryFor(userId, emp.role, 30), scorecardHistory(userId, key), listProposals(userId, { target: promptTarget(key), limit: 20 }),
  ]);
  const entry = PROMPT_LIBRARY[key];
  return {
    profile,
    prompt: { version: emp.prompt_version == null ? null : Number(emp.prompt_version), persona: emp.persona ?? null, versions: versions.rows, library: entry ? { version: entry.version, externalBehavior: entry.externalBehavior } : null },
    tools: entry ? entry.sections.approvedTools.split("\n").map((x: string) => x.trim()).filter(Boolean) : [],
    permissions: { status: profile.permission_status, is_active: !!emp.is_active, approvalRequiredFor: [...APPROVAL_CATEGORIES] },
    heartbeat: heartbeat.rows[0] ?? null, heartbeatHistory: executions.rows, tasks: tasks.rows, errors: errors.rows, memory, trends, feedback: feedback.rows, proposals,
    // الظل: آخر مقارنة لتعليماته المقترحة (lib/org/shadow.ts). تحميلٌ متأخر: لا دورة استيراد.
    shadow: entry ? await (await import("./shadow")).shadowSummary(userId, { employeeKey: key }) : null,
  };
}
