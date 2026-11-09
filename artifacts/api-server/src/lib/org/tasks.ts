// ── طابور مهام الموظفين ───────────────────────────────────────────
// مهمةٌ محفوظة في القاعدة لا رسالةٌ في جدول لا يقرؤه أحد: تُنشأ مرةً بمفتاح تكرارها،
// تنتظر ما تعتمد عليه وموافقة صاحب العمل إن لزمت، ويأخذها عاملٌ بعقد إيجار، وتُعاد
// بمهلةٍ متزايدة حين تفشل، ثم تُركن في dead letter بدل أن تدور إلى الأبد.
//
// نوعان من المهام. ما له معالج مسجَّل يأخذه العامل كل ٣٠ ثانية عبر runAs. وما لا معالج
// له (توجيه منصور، إرشاد العناوين، مقترح مريم) يبقى queued في صندوق موظفه، ويقرؤه
// الكود الذي يغيّر عمله فعلاً، ويُعلَّم مكتملاً عند أول استعمالٍ حقيقي.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { audit, platformHalted } from "./controls";
import { execute, workerId } from "./runtime";
import { ensureOrgTables } from "./schema";
import { orgDepartmentOf } from "./departments";

export type TaskStatus = "pending" | "queued" | "running" | "waiting_for_dependency" | "waiting_for_approval" | "completed" | "failed" | "cancelled" | "expired";
export interface Task {
  taskId: number; userId: number; department: string | null; ownerRole: string; createdByRole: string | null; parentTaskId: number | null;
  taskType: string; priority: number; status: TaskStatus; inputRefs: any; outputRefs: any; approvalRequired: boolean; approvalStatus: string | null;
  failureReason: string | null; retryCount: number; maxRetries: number; idempotencyKey: string | null; leaseOwner: string | null;
  leaseExpiresAt: Date | null; nextAttemptAt: Date | null; deadLetter: boolean; expiresAt: Date | null; createdAt: Date; updatedAt: Date;
}
const date = (v: unknown) => (v == null ? null : new Date(v as string));
const toTask = (r: any): Task => ({
  taskId: Number(r.task_id), userId: Number(r.user_id), department: r.department, ownerRole: r.owner_role, createdByRole: r.created_by_role, parentTaskId: r.parent_task_id,
  taskType: r.task_type, priority: Number(r.priority), status: r.status, inputRefs: r.input_refs, outputRefs: r.output_refs, approvalRequired: !!r.approval_required, approvalStatus: r.approval_status,
  failureReason: r.failure_reason, retryCount: Number(r.retry_count), maxRetries: Number(r.max_retries), idempotencyKey: r.idempotency_key, leaseOwner: r.lease_owner,
  leaseExpiresAt: date(r.lease_expires_at), nextAttemptAt: date(r.next_attempt_at), deadLetter: !!r.dead_letter, expiresAt: date(r.expires_at), createdAt: date(r.created_at)!, updatedAt: date(r.updated_at)!,
});

// ── المعالجات ─────────────────────────────────────────────────────
export interface TaskHandler {
  /** له أثرٌ خارج النظام؟ عقدٌ انتهى في منتصفه لا يُعاد عمياناً، بل ينتظر من يراجعه. */
  external: boolean;
  leaseSec?: number;
  run: (task: Task) => Promise<unknown>;
}
const handlers = new Map<string, TaskHandler>();
export const registerTaskHandler = (type: string, h: TaskHandler) => { handlers.set(type, h); };
export const handlerFor = (type: string) => handlers.get(type);
export const forgetHandlers = () => handlers.clear();

/** مهلة المحاولة التالية: دقيقة، ثم تتضاعف، ولا تتجاوز ساعة. Pure. */
export function backoffSec(retry: number, base = 60, cap = 3600): number {
  return Math.min(cap, base * 2 ** Math.max(0, retry));
}

/** أول حالة لمهمة جديدة. الموافقة قبل الاعتماد: لا معنى لانتظار ما لن يُوافَق عليه. Pure. */
export function initialStatus(i: { approvalRequired?: boolean; unmetDeps: number }): TaskStatus {
  if (i.approvalRequired) return "waiting_for_approval";
  return i.unmetDeps > 0 ? "waiting_for_dependency" : "queued";
}

// ── الإنشاء ───────────────────────────────────────────────────────
export interface NewTask {
  userId: number; ownerRole: string; taskType: string; createdByRole?: string | null; parentTaskId?: number | null;
  input?: unknown; priority?: number; idempotencyKey?: string | null; approvalRequired?: boolean; dependsOn?: number[];
  maxRetries?: number; nextAttemptAt?: Date | null; expiresAt?: Date | null;
}

/** ينشئ المهمة، أو يعيد الموجودة بالمفتاح نفسه: duplicate = true. لا تكرار بعد إعادة التشغيل. */
export async function createTask(t: NewTask): Promise<{ task: Task; duplicate: boolean }> {
  await ensureOrgTables();
  const deps = [...new Set(t.dependsOn ?? [])];
  let unmet = 0;
  if (deps.length) {
    const ids = sql.join(deps.map((d) => sql`${d}`), sql`, `);
    const rows = (await db.execute<{ task_id: number; status: string; user_id: number }>(sql`SELECT task_id, status, user_id FROM employee_tasks WHERE task_id IN (${ids})`)).rows;
    if (rows.length !== deps.length || rows.some((r) => Number(r.user_id) !== t.userId)) throw new Error("اعتمادٌ على مهمة ليست لهذا الحساب");
    unmet = rows.filter((r) => r.status !== "completed").length;
  }
  const status = initialStatus({ approvalRequired: t.approvalRequired, unmetDeps: unmet });
  const key = t.idempotencyKey?.slice(0, 200) ?? null;
  const ins = await db.execute<any>(sql`
    INSERT INTO employee_tasks (user_id, department, owner_role, created_by_role, parent_task_id, task_type, priority, status, input_refs,
        approval_required, approval_status, max_retries, idempotency_key, next_attempt_at, expires_at)
    VALUES (${t.userId}, ${orgDepartmentOf(t.ownerRole)}, ${t.ownerRole}, ${t.createdByRole ?? null}, ${t.parentTaskId ?? null}, ${t.taskType}, ${t.priority ?? 100}, ${status},
        ${JSON.stringify(t.input ?? [])}::jsonb, ${!!t.approvalRequired}, ${t.approvalRequired ? "pending" : null}, ${t.maxRetries ?? 3}, ${key}, ${t.nextAttemptAt ?? null}, ${t.expiresAt ?? null})
    ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`);
  if (!ins.rows.length) {
    const [row] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE user_id = ${t.userId} AND idempotency_key = ${key}`)).rows;
    return { task: toTask(row), duplicate: true };
  }
  const task = toTask(ins.rows[0]);
  for (const d of deps) await db.execute(sql`INSERT INTO employee_task_dependencies (task_id, depends_on, user_id) VALUES (${task.taskId}, ${d}, ${t.userId}) ON CONFLICT DO NOTHING`);
  if (t.approvalRequired) await audit({ userId: t.userId, action: "task.awaits_approval", kind: t.taskType, role: t.ownerRole, meta: { taskId: task.taskId } }).catch(() => {});
  return { task, duplicate: false };
}

export async function getTask(userId: number, taskId: number): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE task_id = ${taskId} AND user_id = ${userId}`)).rows;
  return r ? toTask(r) : null;
}

export async function listTasks(userId: number, o: { status?: string; limit?: number } = {}): Promise<Task[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE user_id = ${userId} ${o.status ? sql`AND status = ${o.status}` : sql``} ORDER BY task_id DESC LIMIT ${Math.min(o.limit ?? 100, 500)}`);
  return r.rows.map(toTask);
}

// ── الأخذ والإكمال ────────────────────────────────────────────────
/** يأخذ ما حان وقته بعقد إيجار. SKIP LOCKED: عاملان لا يأخذان المهمة نفسها أبداً. */
export async function claimDue(worker: string, o: { limit?: number; types?: string[]; leaseSec?: number; userId?: number } = {}): Promise<Task[]> {
  const types = o.types ?? [...handlers.keys()];
  if (!types.length) return [];
  const list = sql.join(types.map((x) => sql`${x}`), sql`, `);
  const r = await db.execute<any>(sql`
    WITH due AS (
      SELECT task_id FROM employee_tasks
      WHERE status = 'queued' AND task_type IN (${list}) AND (next_attempt_at IS NULL OR next_attempt_at <= now())
        AND (expires_at IS NULL OR expires_at > now()) ${o.userId == null ? sql`` : sql`AND user_id = ${o.userId}`}
      ORDER BY priority, next_attempt_at NULLS FIRST, task_id LIMIT ${o.limit ?? 5} FOR UPDATE SKIP LOCKED)
    UPDATE employee_tasks t SET status = 'running', lease_owner = ${worker}, lease_expires_at = now() + make_interval(secs => ${o.leaseSec ?? 600}),
        started_at = now(), updated_at = now()
    FROM due WHERE t.task_id = due.task_id RETURNING t.*`);
  return r.rows.map(toTask);
}

const STILL_MINE = (worker: string) => sql`status = 'running' AND lease_owner = ${worker}`;

export async function completeTask(t: Pick<Task, "taskId">, worker: string, output?: unknown): Promise<boolean> {
  const r = await db.execute(sql`UPDATE employee_tasks SET status = 'completed', completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
      failure_reason = NULL, output_refs = ${JSON.stringify(output ?? [])}::jsonb WHERE task_id = ${t.taskId} AND ${STILL_MINE(worker)}`);
  if (!r.rowCount) return false;
  await releaseDependents(t.taskId);
  return true;
}

/** فشل: مهلةٌ متزايدة، أو dead letter إن نفدت المحاولات، ومعها من كان ينتظرها. */
export async function failTask(t: Pick<Task, "taskId">, worker: string, reason: string): Promise<"retry" | "dead_letter" | "lost"> {
  const r = await db.execute<{ retry_count: number; max_retries: number }>(sql`UPDATE employee_tasks SET retry_count = retry_count + 1, failure_reason = ${reason.slice(0, 1000)}, updated_at = now(),
      lease_owner = NULL, lease_expires_at = NULL WHERE task_id = ${t.taskId} AND ${STILL_MINE(worker)} RETURNING retry_count, max_retries`);
  if (!r.rows.length) return "lost";
  const { retry_count, max_retries } = r.rows[0]!;
  return settleRetry(t.taskId, Number(retry_count), Number(max_retries));
}

async function settleRetry(taskId: number, retry: number, max: number): Promise<"retry" | "dead_letter"> {
  if (retry >= max) {
    await db.execute(sql`UPDATE employee_tasks SET status = 'failed', dead_letter = true, updated_at = now() WHERE task_id = ${taskId}`);
    await closeDependents(taskId, "failed", `ما تعتمد عليه فشل (#${taskId})`);
    return "dead_letter";
  }
  await db.execute(sql`UPDATE employee_tasks SET status = 'queued', next_attempt_at = now() + make_interval(secs => ${backoffSec(retry - 1)}), updated_at = now() WHERE task_id = ${taskId}`);
  return "retry";
}

/** موقوف: تعود بلا عقوبة، وتُسأل بعد خمس دقائق. */
export async function releaseTask(t: Pick<Task, "taskId">, worker: string, why: string, afterSec = 300): Promise<void> {
  await db.execute(sql`UPDATE employee_tasks SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, failure_reason = ${why.slice(0, 500)},
      next_attempt_at = now() + make_interval(secs => ${afterSec}), updated_at = now() WHERE task_id = ${t.taskId} AND ${STILL_MINE(worker)}`);
}

// ── الاعتماد ──────────────────────────────────────────────────────
/** اكتمل ما كانت تنتظره: من لم يبقَ له اعتمادٌ ناقص يعود إلى الطابور. */
export async function releaseDependents(taskId: number): Promise<number> {
  const r = await db.execute(sql`UPDATE employee_tasks t SET status = 'queued', updated_at = now()
    WHERE t.status = 'waiting_for_dependency' AND t.task_id IN (SELECT task_id FROM employee_task_dependencies WHERE depends_on = ${taskId})
      AND NOT EXISTS (SELECT 1 FROM employee_task_dependencies d JOIN employee_tasks x ON x.task_id = d.depends_on WHERE d.task_id = t.task_id AND x.status <> 'completed')`);
  return r.rowCount ?? 0;
}

/** ما اعتمد على مهمةٍ لن تكتمل لا ينتظر إلى الأبد، ولا يُعمل بلا ما يحتاجه. */
async function closeDependents(taskId: number, status: "failed" | "cancelled", reason: string): Promise<void> {
  const r = await db.execute<{ task_id: number }>(sql`UPDATE employee_tasks SET status = ${status}, failure_reason = ${reason.slice(0, 500)}, updated_at = now()
    WHERE status IN ('waiting_for_dependency','waiting_for_approval','queued','pending') AND task_id IN (SELECT task_id FROM employee_task_dependencies WHERE depends_on = ${taskId}) RETURNING task_id`);
  for (const x of r.rows) await closeDependents(Number(x.task_id), status, reason);
}

// ── قرارات صاحب العمل ─────────────────────────────────────────────
const OPEN = sql`('pending','queued','waiting_for_dependency','waiting_for_approval')`;

export async function approveTask(userId: number, taskId: number, actor: number): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks t SET approval_status = 'approved', updated_at = now(), status = CASE
        WHEN EXISTS (SELECT 1 FROM employee_task_dependencies d JOIN employee_tasks x ON x.task_id = d.depends_on WHERE d.task_id = t.task_id AND x.status <> 'completed') THEN 'waiting_for_dependency'
        ELSE 'queued' END
    WHERE t.task_id = ${taskId} AND t.user_id = ${userId} AND t.status = 'waiting_for_approval' RETURNING *`)).rows;
  if (!r) return null;
  await audit({ userId, action: "task.approved", kind: r.task_type, role: r.owner_role, actor, meta: { taskId } });
  return toTask(r);
}

export async function rejectTask(userId: number, taskId: number, actor: number, why?: string | null): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET approval_status = 'rejected', status = 'cancelled', failure_reason = ${why?.slice(0, 500) ?? "رفضها صاحب العمل"}, updated_at = now()
    WHERE task_id = ${taskId} AND user_id = ${userId} AND status = 'waiting_for_approval' RETURNING *`)).rows;
  if (!r) return null;
  await audit({ userId, action: "task.rejected", kind: r.task_type, role: r.owner_role, actor, why: why ?? null, meta: { taskId } });
  await closeDependents(taskId, "cancelled", `ما تعتمد عليه رُفض (#${taskId})`);
  return toTask(r);
}

export async function cancelTask(userId: number, taskId: number, actor: number | null, why?: string | null): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = 'cancelled', failure_reason = ${why?.slice(0, 500) ?? "أُلغيت"}, updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
    WHERE task_id = ${taskId} AND user_id = ${userId} AND status IN ${OPEN} RETURNING *`)).rows;
  if (!r) return null;
  await audit({ userId, action: "task.cancelled", kind: r.task_type, role: r.owner_role, actor, why: why ?? null, meta: { taskId } }).catch(() => {});
  await closeDependents(taskId, "cancelled", `ما تعتمد عليه أُلغي (#${taskId})`);
  return toTask(r);
}

/** إعادة ما فشل أو مات، بيد صاحب العمل: عدّاد جديد، ويُكتب في السجل. */
export async function retryTask(userId: number, taskId: number, actor: number): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = 'queued', retry_count = 0, dead_letter = false, next_attempt_at = NULL, failure_reason = NULL, updated_at = now()
    WHERE task_id = ${taskId} AND user_id = ${userId} AND status IN ('failed','expired') RETURNING *`)).rows;
  if (!r) return null;
  await audit({ userId, action: "task.retried", kind: r.task_type, role: r.owner_role, actor, meta: { taskId } });
  return toTask(r);
}

// ── الانتهاء ──────────────────────────────────────────────────────
export async function expireTasks(): Promise<number> {
  const r = await db.execute<{ task_id: number }>(sql`UPDATE employee_tasks SET status = 'expired', updated_at = now(), failure_reason = COALESCE(failure_reason, 'انتهت مهلتها قبل أن تُعمل')
    WHERE expires_at IS NOT NULL AND expires_at <= now() AND status IN ${OPEN} RETURNING task_id`);
  for (const x of r.rows) await closeDependents(Number(x.task_id), "cancelled", `ما تعتمد عليه انتهت مهلته (#${x.task_id})`);
  return r.rows.length;
}

// ── العقد المنتهي ─────────────────────────────────────────────────
export interface ExpiredLease { taskId: number; userId: number; taskType: string; action: "requeued" | "needs_review" | "dead_letter" }

/**
 * عاملٌ مات في منتصف المهمة. ما لا أثر له خارج النظام يُعاد. وما له أثرٌ خارجي، أو لا
 * يُعرف معالجه، قد يكون نفّذ نصفه: لا يُعاد عمياناً بل ينتظر موافقةً بسببٍ مكتوب.
 */
export async function reclaimExpiredLeases(): Promise<ExpiredLease[]> {
  const rows = (await db.execute<any>(sql`SELECT task_id, user_id, task_type FROM employee_tasks WHERE status = 'running' AND lease_expires_at <= now() ORDER BY task_id LIMIT 50`)).rows;
  const out: ExpiredLease[] = [];
  for (const r of rows) {
    const h = handlers.get(r.task_type);
    const base = { taskId: Number(r.task_id), userId: Number(r.user_id), taskType: String(r.task_type) };
    // كل تحديث مشروطٌ بأن العقد ما زال منتهياً: عاملٌ آخر سبق، أو عاد صاحبه، فلا شيء.
    const STILL_EXPIRED = sql`task_id = ${r.task_id} AND status = 'running' AND lease_expires_at <= now()`;
    if (!h || h.external) {
      const u = await db.execute(sql`UPDATE employee_tasks SET status = 'waiting_for_approval', approval_required = true, approval_status = 'pending', lease_owner = NULL, lease_expires_at = NULL, updated_at = now(),
          failure_reason = 'انقطع العامل في منتصفها وقد يكون لها أثر خارجي — لا تُعاد إلا بمراجعة' WHERE ${STILL_EXPIRED}`);
      if (u.rowCount) out.push({ ...base, action: "needs_review" });
      continue;
    }
    const u = await db.execute<{ retry_count: number; max_retries: number }>(sql`UPDATE employee_tasks SET retry_count = retry_count + 1, lease_owner = NULL, lease_expires_at = NULL,
        failure_reason = 'انتهى عقد العامل قبل أن يكملها', updated_at = now() WHERE ${STILL_EXPIRED} RETURNING retry_count, max_retries`);
    if (!u.rows.length) continue;
    const res = await settleRetry(base.taskId, Number(u.rows[0]!.retry_count), Number(u.rows[0]!.max_retries));
    out.push({ ...base, action: res === "retry" ? "requeued" : "dead_letter" });
  }
  return out;
}

// ── العامل ────────────────────────────────────────────────────────
/** مرور واحد: كل معالج يمرّ على runAs، فالمفتاح والنبض والتنفيذ من مكانٍ واحد. */
export async function runTaskWorkerOnce(worker = workerId(), limit = 5): Promise<number> {
  if (await platformHalted()) return 0;
  const tasks = await claimDue(worker, { limit });
  for (const t of tasks) {
    const h = handlers.get(t.taskType);
    if (!h) { await releaseTask(t, worker, "لا معالج مسجَّل"); continue; }
    try {
      const out = await execute(t.userId, t.ownerRole, { kind: t.taskType, taskId: t.taskId }, () => h.run(t));
      if (out.ran) await completeTask(t, worker, out.value);
      else await releaseTask(t, worker, `موقوف: ${out.halt.reason ?? ""}`);
    } catch (err: any) {
      const res = await failTask(t, worker, String(err?.message ?? err)).catch(() => "lost");
      logger.warn({ taskId: t.taskId, type: t.taskType, res, err: String(err?.message ?? err).slice(0, 200) }, "مهمة فشلت");
    }
  }
  return tasks.length;
}

let timer: NodeJS.Timeout | null = null;
export function startTaskWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runTaskWorkerOnce().catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "مرور الطابور فشل")), 30_000);
  timer.unref();
  logger.info("طابور مهام الموظفين بدأ — مرور كل ٣٠ ثانية");
}
