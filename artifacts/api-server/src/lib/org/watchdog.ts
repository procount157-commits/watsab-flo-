// ── الحارس ────────────────────────────────────────────────────────
// كل دقيقتين: من لم ينبض، وأي عقد انتهى، وأي تنفيذ علق، ومن يفشل مراراً، وما طال انتظاره.
// يكتب في السجل وفي execution_events مرةً لكل نتيجة في اليوم، ويُصلح ما يُصلَح بأمان
// (إعادة مهمة بلا أثر خارجي، إغلاق تنفيذ مات عامله). لا يراسل عميلاً أبداً، ولا يستدعي
// نموذجاً. الجداول لا تكبر بدقّاته: مفتاح التكرار في org_audit_log يمنع التكرار.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { MISSED_FACTOR, backfillRegistry } from "./registry";
import { expireTasks, reclaimExpiredLeases } from "./tasks";
import { ensureOrgTables } from "./schema";
import { ledgerMaintenance } from "./ledger";
import { everyMs, stuckWorkers, workerRetention, WORKER_STUCK_FACTOR } from "./workers";

export type FindingKind = "missed_heartbeat" | "lease_requeued" | "lease_needs_review" | "lease_dead_letter" | "stuck_execution" | "repeated_failures" | "queue_age" | "waiting_too_long" | "duplicate_task" | "duplicate_execution" | "stuck_worker";
export interface Finding { userId: number | null; kind: FindingKind; subject: string; severity: "warn" | "critical"; detail: string; ref?: Record<string, unknown> }

export const STUCK_AFTER_SEC = 2 * 3600;
export const QUEUE_AGE_SEC = 3600;
export const WAIT_APPROVAL_DAYS = 7;
export const WAIT_DEPENDENCY_DAYS = 3;
export const REPEATED_FAILURES = 3;

/** ما يُرى الآن من القاعدة، بلا تغيير شيء. userId: حسابٌ واحد؛ بلا: كل الحسابات (الحارس). */
export async function watchdogFindings(userId?: number): Promise<Finding[]> {
  const scope = (col = "user_id") => (userId == null ? sql`` : sql`AND ${sql.raw(col)} = ${userId}`);
  const [missed, stuck, failing, oldQueue, waiting, dupTasks, dupExec] = await Promise.all([
    db.execute<any>(sql`SELECT h.user_id, h.employee_key, h.last_beat_at, h.interval_sec, h.status FROM employee_heartbeats h
      WHERE h.interval_sec IS NOT NULL AND h.status <> 'halted' AND h.last_beat_at < now() - make_interval(secs => h.interval_sec * ${MISSED_FACTOR}) ${scope("h.user_id")}`),
    db.execute<any>(sql`SELECT id, user_id, employee_key, kind, started_at, worker_id FROM employee_executions
      WHERE status = 'running' AND started_at < now() - make_interval(secs => ${STUCK_AFTER_SEC}) ${scope()}`),
    db.execute<any>(sql`SELECT user_id, employee_key, consecutive_failures, last_error FROM employee_heartbeats WHERE consecutive_failures >= ${REPEATED_FAILURES} ${scope()}`),
    db.execute<any>(sql`SELECT user_id, task_type, count(*)::int AS n, min(COALESCE(next_attempt_at, created_at)) AS since FROM employee_tasks
      WHERE status = 'queued' AND COALESCE(next_attempt_at, created_at) < now() - make_interval(secs => ${QUEUE_AGE_SEC}) AND task_type IN ('review_results','delivery_failure') ${scope()} GROUP BY 1, 2`),
    db.execute<any>(sql`SELECT task_id, user_id, status, task_type, owner_role, created_at FROM employee_tasks
      WHERE ((status = 'waiting_for_approval' AND updated_at < now() - make_interval(days => ${WAIT_APPROVAL_DAYS}))
        OR (status = 'waiting_for_dependency' AND updated_at < now() - make_interval(days => ${WAIT_DEPENDENCY_DAYS}))) ${scope()} LIMIT 100`),
    db.execute<any>(sql`SELECT user_id, owner_role, task_type, count(*)::int AS n FROM employee_tasks
      WHERE status IN ('queued','running','waiting_for_dependency','waiting_for_approval') AND task_type <> 'ops_daily' ${scope()} GROUP BY user_id, owner_role, task_type, md5(input_refs::text) HAVING count(*) > 1 LIMIT 100`),
    db.execute<any>(sql`SELECT user_id, employee_key, kind, count(*)::int AS n FROM employee_executions WHERE status = 'running' AND started_at > now() - interval '1 day' AND task_id IS NULL ${scope()}
      GROUP BY user_id, employee_key, kind HAVING count(*) > 1 LIMIT 100`),
  ]);
  const out: Finding[] = [];
  for (const r of missed.rows) out.push({ userId: Number(r.user_id), kind: "missed_heartbeat", subject: r.employee_key, severity: "warn", detail: `لم ينبض منذ ${new Date(r.last_beat_at).toISOString()} (الفترة ${r.interval_sec} ث)`, ref: { intervalSec: Number(r.interval_sec) } });
  for (const r of stuck.rows) out.push({ userId: Number(r.user_id), kind: "stuck_execution", subject: `${r.employee_key}:${r.id}`, severity: "critical", detail: `«${r.kind ?? ""}» يعمل منذ ${new Date(r.started_at).toISOString()} على ${r.worker_id ?? "?"}`, ref: { executionId: Number(r.id) } });
  for (const r of failing.rows) out.push({ userId: Number(r.user_id), kind: "repeated_failures", subject: r.employee_key, severity: "critical", detail: `${r.consecutive_failures} فشل متتالٍ: ${String(r.last_error ?? "").slice(0, 200)}` });
  for (const r of oldQueue.rows) out.push({ userId: Number(r.user_id), kind: "queue_age", subject: r.task_type, severity: "warn", detail: `${r.n} مهمة تنتظر العامل منذ ${new Date(r.since).toISOString()}` });
  for (const r of waiting.rows) out.push({ userId: Number(r.user_id), kind: "waiting_too_long", subject: `task:${r.task_id}`, severity: "warn", detail: `${r.task_type} لـ${r.owner_role} في ${r.status} منذ ${new Date(r.created_at).toISOString()}` });
  for (const r of dupTasks.rows) out.push({ userId: Number(r.user_id), kind: "duplicate_task", subject: `${r.owner_role}:${r.task_type}`, severity: "warn", detail: `${r.n} مهام مفتوحة بالمدخل نفسه` });
  for (const r of dupExec.rows) out.push({ userId: Number(r.user_id), kind: "duplicate_execution", subject: `${r.employee_key}:${r.kind ?? ""}`, severity: "warn", detail: `${r.n} تنفيذات تعمل معاً` });
  // الحلقات المتكررة (workers.ts) للمنصة كلها، لا لحساب: تُرى في مرور الحارس العام وحده.
  if (userId == null) for (const w of await stuckWorkers().catch(() => [])) out.push({ userId: null, kind: "stuck_worker", subject: `worker:${w.name}`, severity: "critical",
    detail: `«${w.name}» لم يدقّ منذ ${w.last_tick_at ? new Date(w.last_tick_at).toISOString() : "الإقلاع"} (الفاصل ${Math.round(Number(w.interval_ms) / 1000)} ث، الحد ${WORKER_STUCK_FACTOR}×)${w.last_error ? ` — آخر خطأ: ${String(w.last_error).slice(0, 160)}` : ""}`,
    ref: { intervalMs: Number(w.interval_ms), lateMs: w.lateMs } });
  return out;
}

/** مرةً لكل نتيجة في اليوم: سطرٌ في السجل وحدثٌ في التنفيذ. ما عاد لا يملأ جدولاً. */
export async function raiseFinding(f: Finding): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `watchdog:${f.kind}:${f.subject}:${day}`.slice(0, 200);
  const r = await db.execute(sql`INSERT INTO org_audit_log (user_id, action, kind, why, idempotency_key, meta)
    VALUES (${f.userId}, ${"watchdog.finding"}, ${f.kind}, ${f.detail.slice(0, 1000)}, ${key}, ${JSON.stringify({ subject: f.subject, severity: f.severity, ...(f.ref ?? {}) })}::jsonb)
    ON CONFLICT (COALESCE(user_id, 0), idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`);
  if (!r.rows.length) return false;
  if (f.userId != null) await db.execute(sql`INSERT INTO execution_events (user_id, employee_key, event, detail)
    VALUES (${f.userId}, ${f.subject.slice(0, 60)}, ${`watchdog.${f.kind}`.slice(0, 60)}, ${JSON.stringify({ detail: f.detail, severity: f.severity })}::jsonb)`);
  return true;
}

/** مرورٌ كامل. يعيد ما وجده وما فعله. */
export async function watchdogRound(): Promise<{ findings: Finding[]; raised: number; expired: number; closed: number }> {
  await ensureOrgTables();
  const expired = await expireTasks();
  const leases = await reclaimExpiredLeases();
  const findings = await watchdogFindings();
  for (const l of leases) {
    const kind: FindingKind = l.action === "needs_review" ? "lease_needs_review" : l.action === "dead_letter" ? "lease_dead_letter" : "lease_requeued";
    findings.push({ userId: l.userId, kind, subject: `task:${l.taskId}`, severity: l.action === "requeued" ? "warn" : "critical",
      detail: l.action === "needs_review" ? `${l.taskType}: انتهى العقد ولها أثر خارجي — تنتظر مراجعة، ولم تُعد` : l.action === "dead_letter" ? `${l.taskType}: انتهى العقد ونفدت المحاولات` : `${l.taskType}: انتهى العقد، أُعيدت إلى الطابور`, ref: { taskId: l.taskId } });
  }
  // تنفيذٌ علق بعد مهلته: مات عامله في الغالب. يُغلق فاشلاً، ويبقى سطره، ولا يُعاد شيء.
  const closed = await db.execute(sql`UPDATE employee_executions SET status = 'failed', finished_at = now(), error = 'علق بعد مهلته — أغلقه الحارس'
    WHERE status = 'running' AND started_at < now() - make_interval(secs => ${STUCK_AFTER_SEC})`);
  let raised = 0;
  for (const f of findings) if (await raiseFinding(f).catch((err) => { logger.warn({ err: String(err?.message ?? err).slice(0, 160), kind: f.kind }, "نتيجة حارس لم تُكتب"); return false; })) raised++;
  return { findings, raised, expired, closed: closed.rowCount ?? 0 };
}

// ── الاحتفاظ ──────────────────────────────────────────────────────
export const EXECUTIONS_KEEP_DAYS = 30;
export const EVENTS_KEEP_DAYS = 30;
/** لسجلات workflow_executions. التذاكر نفسها لا تُحذف. */
export const TASKS_KEEP_DAYS = 90;
export const PROVIDER_METRICS_KEEP_DAYS = 180;
const BATCH = 2000;

/** يُحذف ما فات مهلته دفعاتٍ صغيرة، فلا قفل طويل على VPS متواضع.
 * التذاكر (employee_tasks) تبقى أبداً: يُحذف سجل أفعالها وحده بعد ٩٠ يوماً (ledgerMaintenance). */
export async function orgRetention(): Promise<{ executions: number; events: number; ticketEvents: number; workflows: number; providerMetrics: number; workers: number }> {
  const chunks = async (q: () => ReturnType<typeof db.execute>) => { let n = 0; for (let i = 0; i < 20; i++) { const r = await q(); n += r.rowCount ?? 0; if ((r.rowCount ?? 0) < BATCH) break; } return n; };
  const executions = await chunks(() => db.execute(sql`DELETE FROM employee_executions WHERE id IN (SELECT id FROM employee_executions WHERE started_at < now() - make_interval(days => ${EXECUTIONS_KEEP_DAYS}) AND status <> 'running' LIMIT ${BATCH})`));
  const events = await chunks(() => db.execute(sql`DELETE FROM execution_events WHERE id IN (SELECT id FROM execution_events WHERE created_at < now() - make_interval(days => ${EVENTS_KEEP_DAYS}) LIMIT ${BATCH})`));
  const ticketEvents = (await ledgerMaintenance().catch((err) => { logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "صيانة سجل التذاكر فشلت"); return { deleted: 0 }; })).deleted;
  const workflows = await chunks(() => db.execute(sql`DELETE FROM workflow_executions WHERE id IN (SELECT id FROM workflow_executions WHERE started_at < now() - make_interval(days => ${TASKS_KEEP_DAYS}) AND status <> 'running' LIMIT ${BATCH})`));
  const providerMetrics = await chunks(() => db.execute(sql`DELETE FROM provider_metrics WHERE id IN (SELECT id FROM provider_metrics WHERE day < to_char(now() - make_interval(days => ${PROVIDER_METRICS_KEEP_DAYS}), 'YYYY-MM-DD') LIMIT ${BATCH})`));
  const workers = await workerRetention().catch(() => 0);
  return { executions, events, ticketEvents, workflows, providerMetrics, workers };
}

let timer: NodeJS.Timeout | null = null;
let lastRetention = 0;
export function startWatchdog(): void {
  if (timer) return;
  const tick = async () => {
    await watchdogRound();
    if (Date.now() - lastRetention > 24 * 3_600_000) {
      lastRetention = Date.now();
      await backfillRegistry();
      await orgRetention();
    }
  };
  // بعد الإقلاع بدقيقتين، حين يكون العمّال قد بدؤوا. الخطأ يُمسك ويُسجَّل في worker_registry.
  timer = everyMs("org.watchdog", 2 * 60_000, tick, { firstMs: 2 * 60_000, unref: true });
  logger.info("حارس الموظفين بدأ — مرور كل دقيقتين");
}
