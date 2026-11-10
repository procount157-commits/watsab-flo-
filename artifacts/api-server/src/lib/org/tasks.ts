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
import { employeeKeyOf, orgDepartmentOf } from "./departments";
import { ensureTicketTables, payloadHash, recordAction, ticketPayload } from "./ledger";

export type TaskStatus = "draft" | "pending" | "queued" | "running" | "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_owner" | "blocked" | "completed" | "failed" | "cancelled" | "expired";
export type PriorityLevel = "critical" | "high" | "normal" | "low";
/** الاسم إلى الرقم القديم (الأصغر أولاً). Pure. */
export const PRIORITY_VALUE: Record<PriorityLevel, number> = { critical: 10, high: 50, normal: 100, low: 200 };
/** الرقم إلى اسمه، كما يحسبه Postgres في priority_level. Pure. */
export const priorityLevelOf = (p: number): PriorityLevel => (p <= 25 ? "critical" : p <= 75 ? "high" : p <= 150 ? "normal" : "low");
export interface Actor { kind: "owner" | "employee" | "system"; id: string | number }
export interface Task {
  taskId: number; userId: number; department: string | null; ownerRole: string; createdByRole: string | null; parentTaskId: number | null;
  taskType: string; priority: number; status: TaskStatus; inputRefs: any; outputRefs: any; approvalRequired: boolean; approvalStatus: string | null;
  failureReason: string | null; retryCount: number; maxRetries: number; idempotencyKey: string | null; leaseOwner: string | null;
  leaseExpiresAt: Date | null; nextAttemptAt: Date | null; deadLetter: boolean; expiresAt: Date | null; createdAt: Date; updatedAt: Date;
  // ── حقول التذكرة (ledger.ts TICKET_SQL). فارغة للمهام القديمة. ──
  title: string | null; objective: string | null; description: string | null; assignedTo: string | null; createdBy: { kind: string | null; id: string | null };
  related: { customerId: number | null; campaignId: number | null; conversationId: string | null };
  actionType: string | null; evidence: any[]; expectedOutput: string | null; actualOutput: any; durationMs: number | null; attemptCount: number;
  failureCode: string | null; nextAction: string | null; handoffTarget: string | null; auditEventIds: number[]; priorityLevel: PriorityLevel;
  retryable: boolean | null; responsibleParty: string | null; approvalPayloadHash: string | null; approvedPayloadHash: string | null;
  approvedBy: number | null; approvedAt: Date | null; dueAt: Date | null; startedAt: Date | null; completedAt: Date | null;
}
const date = (v: unknown) => (v == null ? null : new Date(v as string));
const toTask = (r: any): Task => ({
  taskId: Number(r.task_id), userId: Number(r.user_id), department: r.department, ownerRole: r.owner_role, createdByRole: r.created_by_role, parentTaskId: r.parent_task_id,
  taskType: r.task_type, priority: Number(r.priority), status: r.status, inputRefs: r.input_refs, outputRefs: r.output_refs, approvalRequired: !!r.approval_required, approvalStatus: r.approval_status,
  failureReason: r.failure_reason, retryCount: Number(r.retry_count), maxRetries: Number(r.max_retries), idempotencyKey: r.idempotency_key, leaseOwner: r.lease_owner,
  leaseExpiresAt: date(r.lease_expires_at), nextAttemptAt: date(r.next_attempt_at), deadLetter: !!r.dead_letter, expiresAt: date(r.expires_at), createdAt: date(r.created_at)!, updatedAt: date(r.updated_at)!,
  title: r.title ?? null, objective: r.objective ?? null, description: r.description ?? null, assignedTo: r.assigned_to ?? null,
  createdBy: { kind: r.created_by_kind ?? null, id: r.created_by_id ?? null },
  related: { customerId: r.related_customer_id ?? null, campaignId: r.related_campaign_id ?? null, conversationId: r.related_conversation_id ?? null },
  actionType: r.action_type ?? null, evidence: Array.isArray(r.evidence_references) ? r.evidence_references : [], expectedOutput: r.expected_output ?? null,
  actualOutput: r.actual_output ?? null, durationMs: r.duration_ms == null ? null : Number(r.duration_ms), attemptCount: Number(r.attempt_count ?? 0),
  failureCode: r.failure_code ?? null, nextAction: r.next_action ?? null, handoffTarget: r.handoff_target ?? null,
  auditEventIds: Array.isArray(r.audit_event_ids) ? r.audit_event_ids.map(Number) : [], priorityLevel: (r.priority_level as PriorityLevel) ?? priorityLevelOf(Number(r.priority)),
  retryable: r.retryable ?? null, responsibleParty: r.responsible_party ?? null, approvalPayloadHash: r.approval_payload_hash ?? null,
  approvedPayloadHash: r.approved_payload_hash ?? null, approvedBy: r.approved_by ?? null, approvedAt: date(r.approved_at), dueAt: date(r.due_at),
  startedAt: date(r.started_at), completedAt: date(r.completed_at),
});
export { toTask };

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
export function initialStatus(i: { approvalRequired?: boolean; unmetDeps: number; draft?: boolean }): TaskStatus {
  if (i.draft) return "draft";
  if (i.approvalRequired) return "waiting_for_approval";
  return i.unmetDeps > 0 ? "waiting_for_dependency" : "queued";
}

// ── الإنشاء ───────────────────────────────────────────────────────
export interface NewTask {
  userId: number; ownerRole: string; taskType: string; createdByRole?: string | null; parentTaskId?: number | null;
  input?: unknown; priority?: number; idempotencyKey?: string | null; approvalRequired?: boolean; dependsOn?: number[];
  maxRetries?: number; nextAttemptAt?: Date | null; expiresAt?: Date | null;
  // ── التذكرة ──
  /** draft: وصلت ولم تُصنَّف أو تُكلَّف بعد (tickets.ts intakeTicket). */
  draft?: boolean;
  title?: string | null; objective?: string | null; description?: string | null; assignedTo?: string | null; createdBy?: Actor | null;
  relatedCustomerId?: number | null; relatedCampaignId?: number | null; relatedConversationId?: string | null;
  actionType?: string | null; expectedOutput?: string | null; dueAt?: Date | null; priorityLevel?: PriorityLevel | null; handoffTarget?: string | null;
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
  const status = initialStatus({ approvalRequired: t.approvalRequired, unmetDeps: unmet, draft: t.draft });
  const key = t.idempotencyKey?.slice(0, 200) ?? null;
  // حقول التذكرة إن كانت أعمدتها جاهزة. وإلا تُنشأ المهمة كما كانت: القرّاء القدامى لا ينتظرون التذاكر.
  const ticket = await ensureTicketTables();
  const wantsTicket = !!(t.draft || t.title || t.assignedTo || t.createdBy || t.actionType || t.priorityLevel || t.dueAt);
  if (wantsTicket && !ticket) throw new Error("جداول التذاكر غير جاهزة");
  const input = t.input ?? [];
  const priority = t.priorityLevel ? PRIORITY_VALUE[t.priorityLevel] : t.priority ?? 100;
  const assigned = t.draft ? t.assignedTo ?? null : t.assignedTo ?? employeeKeyOf(t.ownerRole);
  const actor = t.createdBy ?? (t.createdByRole ? { kind: "employee" as const, id: employeeKeyOf(t.createdByRole) } : null);
  const ticketCols = ticket ? sql`, title, objective, description, assigned_to, created_by_kind, created_by_id, related_customer_id, related_campaign_id,
        related_conversation_id, action_type, expected_output, due_at, handoff_target, approval_payload_hash` : sql``;
  const ticketVals = ticket ? sql`, ${t.title?.slice(0, 300) ?? null}, ${t.objective ?? null}, ${t.description ?? null}, ${assigned}, ${actor?.kind ?? null}, ${actor == null ? null : String(actor.id).slice(0, 80)},
        ${t.relatedCustomerId ?? null}, ${t.relatedCampaignId ?? null}, ${t.relatedConversationId?.slice(0, 120) ?? null}, ${t.actionType?.slice(0, 60) ?? null},
        ${t.expectedOutput ?? null}, ${t.dueAt ?? null}, ${t.handoffTarget?.slice(0, 60) ?? null},
        ${t.approvalRequired ? payloadHash(ticketPayload({ actionType: t.actionType ?? null, taskType: t.taskType, inputRefs: JSON.parse(JSON.stringify(input)) })) : null}` : sql``;
  const ins = await db.execute<any>(sql`
    INSERT INTO employee_tasks (user_id, department, owner_role, created_by_role, parent_task_id, task_type, priority, status, input_refs,
        approval_required, approval_status, max_retries, idempotency_key, next_attempt_at, expires_at ${ticketCols})
    VALUES (${t.userId}, ${orgDepartmentOf(t.ownerRole)}, ${t.ownerRole}, ${t.createdByRole ?? null}, ${t.parentTaskId ?? null}, ${t.taskType}, ${priority}, ${status},
        ${JSON.stringify(input)}::jsonb, ${!!t.approvalRequired}, ${t.approvalRequired ? "pending" : null}, ${t.maxRetries ?? 3}, ${key}, ${t.nextAttemptAt ?? null}, ${t.expiresAt ?? null} ${ticketVals})
    ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`);
  if (!ins.rows.length) {
    const [row] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE user_id = ${t.userId} AND idempotency_key = ${key}`)).rows;
    return { task: toTask(row), duplicate: true };
  }
  const task = toTask(ins.rows[0]);
  for (const d of deps) await db.execute(sql`INSERT INTO employee_task_dependencies (task_id, depends_on, user_id) VALUES (${task.taskId}, ${d}, ${t.userId}) ON CONFLICT DO NOTHING`);
  if (t.approvalRequired) await audit({ userId: t.userId, action: "task.awaits_approval", kind: t.taskType, role: t.ownerRole, meta: { taskId: task.taskId } }).catch(() => {});
  if (ticket) await recordAction({ userId: t.userId, ticketId: task.taskId, role: t.ownerRole, actionType: "ticket.created", status: "ok", actor,
    output: { status, taskType: t.taskType, parent: t.parentTaskId ?? null, assignedTo: assigned } });
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
        started_at = now(), updated_at = now() ${(await ensureTicketTables()) ? sql`, attempt_count = t.attempt_count + 1` : sql``}
    FROM due WHERE t.task_id = due.task_id RETURNING t.*`);
  return r.rows.map(toTask);
}

const STILL_MINE = (worker: string) => sql`status = 'running' AND lease_owner = ${worker}`;

export async function completeTask(t: Pick<Task, "taskId">, worker: string, output?: unknown, evidence?: unknown[]): Promise<boolean> {
  // المخرج الفعلي والدليل والمدة على التذكرة نفسها: عاملٌ أنهاها، فدليلها سطر تنفيذه.
  const ticket = (await ensureTicketTables()) ? sql`, actual_output = ${JSON.stringify(output ?? null)}::jsonb,
      duration_ms = (EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000)::int,
      evidence_references = evidence_references || ${JSON.stringify(evidence ?? [])}::jsonb` : sql``;
  const r = await db.execute(sql`UPDATE employee_tasks SET status = 'completed', completed_at = now(), updated_at = now(), lease_owner = NULL, lease_expires_at = NULL,
      failure_reason = NULL, output_refs = ${JSON.stringify(output ?? [])}::jsonb ${ticket} WHERE task_id = ${t.taskId} AND ${STILL_MINE(worker)}`);
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
export async function closeDependents(taskId: number, status: "failed" | "cancelled", reason: string): Promise<void> {
  const r = await db.execute<{ task_id: number }>(sql`UPDATE employee_tasks SET status = ${status}, failure_reason = ${reason.slice(0, 500)}, updated_at = now()
    WHERE status IN ('waiting_for_dependency','waiting_for_approval','queued','pending') AND task_id IN (SELECT task_id FROM employee_task_dependencies WHERE depends_on = ${taskId}) RETURNING task_id`);
  for (const x of r.rows) await closeDependents(Number(x.task_id), status, reason);
}

// ── قرارات صاحب العمل ─────────────────────────────────────────────
const OPEN = sql`('draft','pending','queued','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked')`;

/**
 * الموافقة مربوطةٌ ببصمة الحمولة كما رآها صاحب العمل (SHA-256 لنوع الفعل ومدخله، ledger.ts).
 * expectedHash: البصمة التي عُرضت عليه؛ إن تغيّرت الحمولة منذ ذلك فلا موافقة (null). بلا
 * expectedHash (المسار القديم /org/tasks/:id/approve) تُربط بالحمولة الحاضرة لحظة الموافقة.
 * والعامل لا ينفّذ إلا ما تطابق بصمته المعتمدة (runTaskWorkerOnce، tickets.ts executeApproved).
 */
/** ما ينتظر قرار صاحب العمل على حمولته: waiting_for_approval، أو waiting_for_owner بموافقةٍ معلّقة (بنود المكالمات والاجتماعات). */
const AWAITS_APPROVAL = (alias = "") => sql.raw(`(${alias}status = 'waiting_for_approval' OR (${alias}status = 'waiting_for_owner' AND ${alias}approval_required AND ${alias}approval_status = 'pending'))`);

export async function approveTask(userId: number, taskId: number, actor: number, expectedHash?: string | null): Promise<Task | null> {
  const ticket = await ensureTicketTables();
  const [cur] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE task_id = ${taskId} AND user_id = ${userId} AND ${AWAITS_APPROVAL()}`)).rows;
  if (!cur) return null;
  const hash = payloadHash(ticketPayload({ actionType: cur.action_type ?? null, taskType: cur.task_type, inputRefs: cur.input_refs }));
  if (expectedHash != null && expectedHash !== hash) return null;
  const bind = ticket ? sql`, approved_payload_hash = ${hash}, approved_by = ${actor}, approved_at = now(), approval_payload_hash = ${hash}` : sql``;
  // المدخل لم يتغيّر بين القراءة والموافقة: المقارنة على jsonb نفسه.
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks t SET approval_status = 'approved', updated_at = now(), status = CASE
        WHEN EXISTS (SELECT 1 FROM employee_task_dependencies d JOIN employee_tasks x ON x.task_id = d.depends_on WHERE d.task_id = t.task_id AND x.status <> 'completed') THEN 'waiting_for_dependency'
        ELSE 'queued' END ${bind}
    WHERE t.task_id = ${taskId} AND t.user_id = ${userId} AND ${AWAITS_APPROVAL("t.")} AND t.input_refs = ${JSON.stringify(cur.input_refs)}::jsonb
      ${ticket ? sql`AND t.action_type IS NOT DISTINCT FROM ${cur.action_type ?? null}` : sql``} RETURNING *`)).rows;
  if (!r) return null;
  await audit({ userId, action: "task.approved", kind: r.task_type, role: r.owner_role, actor, meta: { taskId, payloadHash: hash } });
  if (ticket) await recordAction({ userId, ticketId: taskId, role: r.owner_role, actionType: "ticket.approved", status: "ok", actor: { kind: "owner", id: actor }, output: { payloadHash: hash, status: r.status } });
  return toTask(r);
}

/** هل هذه الحمولة هي ما وافق عليه صاحب العمل؟ موافقةٌ قديمة بلا بصمة تُقبل كما كانت. Pure. */
export function approvalMatches(t: Pick<Task, "approvalRequired" | "approvalStatus" | "approvedPayloadHash">, payload: unknown): boolean {
  if (!t.approvalRequired) return true;
  if (t.approvalStatus !== "approved") return false;
  return t.approvedPayloadHash == null || t.approvedPayloadHash === payloadHash(payload);
}

/** حمولةٌ تغيّرت بعد الموافقة: لا تُنفَّذ، وتعود تنتظر موافقةً جديدة بسببٍ مكتوب. */
export async function refuseChangedPayload(t: Task, attempted: unknown, worker?: string | null): Promise<void> {
  const h = payloadHash(attempted);
  // ما يُعرض للموافقة الجديدة هو الحمولة المحفوظة، لا ما حاول أحدٌ تنفيذه.
  await db.execute(sql`UPDATE employee_tasks SET status = 'waiting_for_approval', approval_status = 'pending', approval_payload_hash = ${payloadHash(ticketPayload(t))}, failure_code = 'payload_changed',
      failure_reason = 'الحمولة تختلف عمّا وافق عليه صاحب العمل — تنتظر موافقةً جديدة', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
    WHERE task_id = ${t.taskId} AND user_id = ${t.userId} ${worker ? sql`AND (lease_owner IS NULL OR lease_owner = ${worker})` : sql``}`);
  await audit({ userId: t.userId, action: "task.payload_refused", kind: t.taskType, role: t.ownerRole, why: "payload_changed", meta: { taskId: t.taskId, approved: t.approvedPayloadHash, attempted: h } }).catch(() => {});
  await recordAction({ userId: t.userId, ticketId: t.taskId, role: t.ownerRole, actionType: "approval.payload_mismatch", status: "refused", output: { approved: t.approvedPayloadHash, attempted: h } });
}

export async function rejectTask(userId: number, taskId: number, actor: number, why?: string | null): Promise<Task | null> {
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET approval_status = 'rejected', status = 'cancelled', failure_reason = ${why?.slice(0, 500) ?? "رفضها صاحب العمل"}, updated_at = now()
    WHERE task_id = ${taskId} AND user_id = ${userId} AND ${AWAITS_APPROVAL()} RETURNING *`)).rows;
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
    if (!approvalMatches(t, ticketPayload(t))) { await refuseChangedPayload(t, ticketPayload(t), worker); continue; }
    try {
      const out = await execute(t.userId, t.ownerRole, { kind: t.taskType, taskId: t.taskId }, () => h.run(t));
      if (out.ran) await completeTask(t, worker, out.value, out.executionId ? [{ type: "execution", id: out.executionId }] : []);
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
  // سجل الأفعال: سجلات الأمس تُغلق بأعدادها، والأحداث الأقدم من ٩٠ يوماً تُحذف. كل ساعة.
  setInterval(() => void import("./ledger").then((l) => l.ledgerMaintenance()).catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "صيانة سجل التذاكر فشلت")), 3_600_000).unref();
  timer = setInterval(() => void runTaskWorkerOnce().catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "مرور الطابور فشل")), 30_000);
  timer.unref();
  logger.info("طابور مهام الموظفين بدأ — مرور كل ٣٠ ثانية");
}
