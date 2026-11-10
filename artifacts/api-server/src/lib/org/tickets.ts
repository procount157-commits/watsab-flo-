// ── التذاكر ───────────────────────────────────────────────────────
// كل عملٍ تذكرة، والتذكرة هي employee_tasks نفسها بحقول العمل (ledger.ts TICKET_SQL).
// دورة حياتها:
//
//   intake (draft) → classify → assign (مفتاح موظف بعينه، لا اسم عرض) → plan → بوابة الموافقة
//   (مربوطة ببصمة الحمولة) → execute → validate → handoff (تذكرة ابنة) → close → learning
//
// الإغلاق مكتملاً يتطلب المخرج الفعلي والدليل الذي يطلبه نوع الفعل؛ والفشل والحجب يتطلبان
// السبب، وهل يُعاد، ومن المسؤول، والحل المقترح. كل تغيير حالة وكل تعديل وكل موافقة سطرٌ في
// org_audit_log (رقمه في audit_event_ids) وسطرٌ في ticket_action_events.
//
// الإيقاف المؤقت والإلغاء يضعان مفتاح التذكرة (org_controls scope 'task')، فيحترمه runAs
// والبوابة حتى في منتصف الجولة. إعادة الفتح ترفعه.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import { ROLE_MAP, WORKER_MAP, employeeKeyOf, orgDepartmentOf } from "./departments";
import { forgetControls, taskHalted } from "./controls";
import { ensureTicketTables, payloadHash, recordAction, ticketPayload, withTicket, noteHandoff } from "./ledger";
import {
  approvalMatches, approveTask, closeDependents, createTask, priorityLevelOf, PRIORITY_VALUE, refuseChangedPayload, rejectTask, releaseDependents, toTask,
  type Actor, type PriorityLevel, type Task, type TaskStatus,
} from "./tasks";

export class TicketRefused extends Error {
  constructor(message: string, public status = 409, public code = "refused") { super(message); }
}

// ── القواعد ───────────────────────────────────────────────────────
const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled", "expired"];
export const OPEN_STATUSES: TaskStatus[] = ["draft", "pending", "queued", "running", "waiting_for_dependency", "waiting_for_approval", "waiting_for_owner", "blocked"];

/** الانتقالات المسموحة. ما ليس هنا مرفوض. Pure. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["pending", "queued", "waiting_for_approval", "waiting_for_dependency", "waiting_for_owner", "cancelled"],
  pending: ["queued", "waiting_for_dependency", "waiting_for_approval", "waiting_for_owner", "blocked", "cancelled"],
  queued: ["running", "waiting_for_approval", "waiting_for_owner", "blocked", "cancelled", "expired"],
  running: ["completed", "failed", "blocked", "waiting_for_owner", "queued", "cancelled"],
  waiting_for_dependency: ["queued", "blocked", "failed", "cancelled", "expired"],
  waiting_for_approval: ["queued", "waiting_for_dependency", "cancelled", "expired"],
  waiting_for_owner: ["queued", "pending", "blocked", "cancelled", "expired"],
  blocked: ["queued", "pending", "cancelled"],
  completed: ["queued"],
  failed: ["queued"],
  cancelled: ["queued"],
  expired: ["queued"],
};
export const canTransition = (from: TaskStatus, to: TaskStatus) => (TRANSITIONS[from] ?? []).includes(to);

/** ما يُقبل دليلاً لكل نوع فعل. ما لا يُعرف نوعه يكفيه دليلٌ واحد بأي نوع. */
export const EVIDENCE_RULES: Record<string, string[]> = {
  send_message: ["gate_event", "message_id", "receipt"],
  send_email: ["gate_event", "message_id", "receipt"],
  report: ["report_id", "execution"],
  ceo_recommendation: ["metric", "report_id", "execution"],
  review_results: ["execution", "task"],
  delivery_failure: ["execution", "ledger"],
  ops_log: ["action_events", "execution"],
};

export interface Evidence { type: string; id?: string | number | null; ref?: string | null; note?: string | null }
export interface FailureInfo { reason?: string | null; retryable?: boolean | null; responsibleParty?: string | null; suggestedResolution?: string | null; failureCode?: string | null }

/** ما ينقص الإغلاق بهذه الحالة. فارغ = يُغلق. Pure. */
export function closureProblems(status: "completed" | "failed" | "blocked", t: { actionType?: string | null; taskType: string }, i: { actualOutput?: unknown; evidence?: Evidence[] } & FailureInfo): string[] {
  const out: string[] = [];
  if (status === "completed") {
    const empty = i.actualOutput == null || i.actualOutput === "" || (typeof i.actualOutput === "object" && !Array.isArray(i.actualOutput) && !Object.keys(i.actualOutput as object).length);
    if (empty) out.push("actual_output مطلوب");
    const ev = (i.evidence ?? []).filter((e) => e && typeof e.type === "string" && (e.id != null || e.ref));
    const allowed = EVIDENCE_RULES[t.actionType ?? t.taskType];
    if (!ev.length) out.push("دليلٌ واحد على الأقل مطلوب");
    else if (allowed && !ev.some((e) => allowed.includes(e.type))) out.push(`دليل ${t.actionType ?? t.taskType} يكون من: ${allowed.join("، ")}`);
    return out;
  }
  if (!i.reason?.trim()) out.push("السبب مطلوب");
  if (typeof i.retryable !== "boolean") out.push("هل يُعاد؟ (retryable) مطلوب");
  if (!i.responsibleParty?.trim()) out.push("المسؤول مطلوب");
  if (!i.suggestedResolution?.trim()) out.push("الحل المقترح مطلوب");
  return out;
}

// ── المكلَّف ──────────────────────────────────────────────────────
const KEY_SHAPE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
const KEY_TO_ROLE = new Map<string, string>();
for (const [role, e] of Object.entries(ROLE_MAP)) KEY_TO_ROLE.set(e.key, role);
for (const [role, w] of Object.entries(WORKER_MAP)) KEY_TO_ROLE.set(w.key, role);

/** مفتاح الموظف إلى دوره، أو null إن لم يكن مفتاحاً. اسم العرض («نورة») ليس مفتاحاً أبداً. Pure للمعروف. */
export async function roleForKey(userId: number, key: string): Promise<string | null> {
  const k = String(key ?? "").trim();
  if (!KEY_SHAPE.test(k)) return null;
  const known = KEY_TO_ROLE.get(k);
  if (known) return known;
  // موظفٌ وظّفه المهندس: custom.<role>، ولا يُقبل إلا إن كان في هذا الحساب.
  if (!k.startsWith("custom.")) return null;
  const role = k.slice(7);
  const [r] = (await db.execute(sql`SELECT 1 FROM bot_employees WHERE user_id = ${userId} AND (employee_key = ${k} OR role = ${role}) LIMIT 1`)).rows;
  return r ? role : null;
}

// ── السجل ─────────────────────────────────────────────────────────

/** سطرٌ في org_audit_log ورقمه على التذكرة، وسطرٌ في سجل أفعالها. */
async function trail(t: Task, action: string, actor: Actor, o: { why?: string | null; meta?: Record<string, unknown>; status?: "ok" | "refused" | "info" } = {}): Promise<number | null> {
  const [a] = (await db.execute<{ id: number }>(sql`INSERT INTO org_audit_log (user_id, action, kind, role, actor, why, meta)
    VALUES (${t.userId}, ${`ticket.${action}`.slice(0, 40)}, 'ticket', ${t.ownerRole.slice(0, 60)}, ${actor.kind === "owner" ? Number(actor.id) : null}, ${o.why ?? null},
      ${JSON.stringify({ taskId: t.taskId, actor, ...(o.meta ?? {}) })}::jsonb) RETURNING id`)).rows;
  if (a) await db.execute(sql`UPDATE employee_tasks SET audit_event_ids = CASE WHEN jsonb_array_length(audit_event_ids) >= 200 THEN audit_event_ids - 0 ELSE audit_event_ids END || ${JSON.stringify([Number(a.id)])}::jsonb
    WHERE task_id = ${t.taskId} AND user_id = ${t.userId}`);
  await recordAction({ userId: t.userId, ticketId: t.taskId, role: t.ownerRole, actor, actionType: `ticket.${action}`, status: o.status ?? "ok", output: { why: o.why ?? null, ...(o.meta ?? {}) } });
  return a ? Number(a.id) : null;
}

async function load(userId: number, id: number): Promise<Task> {
  await ensureTicketTables();
  const [r] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE task_id = ${id} AND user_id = ${userId}`)).rows;
  // تذكرة حسابٍ آخر لا تُرى، ولا يُقال إنها موجودة.
  if (!r) throw new TicketRefused("التذكرة غير موجودة", 404, "not_found");
  return toTask(r);
}
export const getTicket = (userId: number, id: number) => load(userId, id);

/** تغيير الحالة، مشروطاً بأن الحالة لم تتغيّر منذ القراءة. */
async function transition(t: Task, to: TaskStatus, actor: Actor, set: SQL = sql``, why?: string | null, meta?: Record<string, unknown>): Promise<Task> {
  if (!canTransition(t.status, to)) throw new TicketRefused(`لا انتقال من ${t.status} إلى ${to}`, 409, "bad_transition");
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = ${to}, updated_at = now() ${set}
    WHERE task_id = ${t.taskId} AND user_id = ${t.userId} AND status = ${t.status} RETURNING *`)).rows;
  if (!r) throw new TicketRefused("تغيّرت التذكرة منذ قُرئت — أعد التحميل", 409, "stale");
  const next = toTask(r);
  await trail(next, "status", actor, { why, meta: { from: t.status, to, ...(meta ?? {}) } });
  return next;
}

// ── مفتاح التذكرة ─────────────────────────────────────────────────
async function setTaskSwitch(t: Task, engaged: boolean, reason: string | null, actor: Actor) {
  await db.execute(sql`INSERT INTO org_controls (scope, user_id, target, engaged, reason, set_by, set_at)
    VALUES ('task', ${t.userId}, ${String(t.taskId)}, ${engaged}, ${reason}, ${actor.kind === "owner" ? Number(actor.id) : null}, now())
    ON CONFLICT (scope, COALESCE(user_id, 0), target) DO UPDATE SET engaged = EXCLUDED.engaged, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`);
  forgetControls(t.userId);
}

// ── الدورة ────────────────────────────────────────────────────────
export interface Intake {
  userId: number; title: string; createdBy: Actor;
  objective?: string | null; description?: string | null; actionType?: string | null; priority?: PriorityLevel | null;
  input?: unknown; expectedOutput?: string | null; dueAt?: Date | null; idempotencyKey?: string | null; parentTicketId?: number | null;
  relatedCustomerId?: number | null; relatedCampaignId?: number | null; relatedConversationId?: string | null;
  taskType?: string;
}

/** وصل عمل: تذكرةٌ draft قبل أي عمل. المفتاح نفسه يعيد التذكرة نفسها، لا ثانية. */
export async function intakeTicket(i: Intake): Promise<{ ticket: Task; duplicate: boolean }> {
  if (!i.title?.trim()) throw new TicketRefused("العنوان مطلوب", 400, "invalid");
  if (!(await ensureTicketTables())) throw new TicketRefused("جداول التذاكر غير جاهزة", 503, "unavailable");
  if (i.parentTicketId != null) await load(i.userId, i.parentTicketId);
  const r = await createTask({
    userId: i.userId, ownerRole: "unassigned", taskType: (i.taskType ?? i.actionType ?? "ticket").slice(0, 60), draft: true, input: i.input ?? {},
    title: i.title.trim(), objective: i.objective ?? null, description: i.description ?? null, actionType: i.actionType ?? null, createdBy: i.createdBy,
    priorityLevel: i.priority ?? "normal", expectedOutput: i.expectedOutput ?? null, dueAt: i.dueAt ?? null, idempotencyKey: i.idempotencyKey ?? null,
    parentTaskId: i.parentTicketId ?? null, relatedCustomerId: i.relatedCustomerId, relatedCampaignId: i.relatedCampaignId, relatedConversationId: i.relatedConversationId,
  });
  return { ticket: r.task, duplicate: r.duplicate };
}

/** التصنيف: القسم ونوع الفعل والأولوية. تعديلٌ يُسجَّل. */
export async function classifyTicket(userId: number, id: number, c: { department?: string | null; actionType?: string | null; priority?: PriorityLevel | null }, actor: Actor): Promise<Task> {
  const t = await load(userId, id);
  if (TERMINAL.includes(t.status)) throw new TicketRefused("تذكرة مغلقة لا تُصنَّف", 409, "closed");
  if (c.priority && !(c.priority in PRIORITY_VALUE)) throw new TicketRefused("أولوية غير معروفة", 400, "invalid");
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET updated_at = now(),
      department = COALESCE(${c.department?.slice(0, 40) ?? null}, department), action_type = COALESCE(${c.actionType?.slice(0, 60) ?? null}, action_type),
      priority = COALESCE(${c.priority ? PRIORITY_VALUE[c.priority] : null}, priority)
    WHERE task_id = ${id} AND user_id = ${userId} RETURNING *`)).rows;
  const next = toTask(r);
  await trail(next, "classified", actor, { meta: { department: next.department, actionType: next.actionType, priority: next.priorityLevel } });
  return next;
}

/** التكليف: مفتاح موظف بعينه. اسم العرض مرفوض. */
export async function assignTicket(userId: number, id: number, employeeKey: string, actor: Actor, why?: string | null): Promise<Task> {
  const t = await load(userId, id);
  const role = await roleForKey(userId, employeeKey);
  if (!role) throw new TicketRefused("التكليف لمفتاح موظف بعينه (مثل email.copywriter)، لا لاسمٍ ولا لقسم", 400, "invalid_assignee");
  if (TERMINAL.includes(t.status) || t.status === "running") throw new TicketRefused("لا يُعاد تكليف تذكرة تعمل الآن أو أُغلقت", 409, "closed");
  const reassign = !!t.assignedTo && t.assignedTo !== employeeKey;
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET assigned_to = ${employeeKey}, owner_role = ${role}, department = ${orgDepartmentOf(role)}, updated_at = now(),
      status = CASE WHEN status = 'draft' THEN 'pending' ELSE status END
    WHERE task_id = ${id} AND user_id = ${userId} AND status = ${t.status} RETURNING *`)).rows;
  if (!r) throw new TicketRefused("تغيّرت التذكرة منذ قُرئت — أعد التحميل", 409, "stale");
  const next = toTask(r);
  await trail(next, reassign ? "reassigned" : "assigned", actor, { why, meta: { from: t.assignedTo, to: employeeKey, role, status: { from: t.status, to: next.status } } });
  return next;
}

export interface Plan { expectedOutput?: string | null; nextAction?: string | null; dependsOn?: number[]; requiresApproval?: boolean; dueAt?: Date | null }

/** الخطة: المخرج المنتظر، الخطوة التالية، الاعتماد، وهل ينتظر موافقة صاحب العمل. */
export async function planTicket(userId: number, id: number, p: Plan, actor: Actor): Promise<Task> {
  const t = await load(userId, id);
  if (!t.assignedTo) throw new TicketRefused("تُكلَّف التذكرة قبل خطتها", 409, "unassigned");
  if (!["draft", "pending", "waiting_for_owner"].includes(t.status)) throw new TicketRefused("الخطة قبل التنفيذ فقط", 409, "bad_transition");
  const deps = [...new Set(p.dependsOn ?? [])].filter((d) => d !== id);
  let unmet = 0;
  for (const d of deps) {
    const dep = await load(userId, d).catch(() => { throw new TicketRefused(`اعتمادٌ على تذكرة ليست لهذا الحساب (#${d})`, 400, "invalid"); });
    if (dep.status !== "completed") unmet++;
    await db.execute(sql`INSERT INTO employee_task_dependencies (task_id, depends_on, user_id) VALUES (${id}, ${d}, ${userId}) ON CONFLICT DO NOTHING`);
  }
  const hash = payloadHash(ticketPayload(t));
  const to: TaskStatus = p.requiresApproval ? "waiting_for_approval" : unmet ? "waiting_for_dependency" : "queued";
  return transition(t, to, actor, sql`, expected_output = COALESCE(${p.expectedOutput ?? null}, expected_output), next_action = ${p.nextAction ?? null},
      due_at = COALESCE(${p.dueAt ?? null}, due_at), approval_required = ${!!p.requiresApproval || t.approvalRequired},
      approval_status = ${p.requiresApproval ? "pending" : t.approvalStatus}, approval_payload_hash = ${p.requiresApproval ? hash : t.approvalPayloadHash}`, null, { dependsOn: deps, payloadHash: p.requiresApproval ? hash : undefined });
}

/** موافقة صاحب العمل على بصمة الحمولة التي رآها. حمولةٌ تغيّرت: 409. */
/** تذاكر المكالمات والاجتماعات: قرار صاحب الحساب هو العمل كله، فلا تدخل الطابور (لا معالج لها). */
export const OWNER_ACTION_TYPE = "owner_action";

export async function approveTicket(userId: number, id: number, ownerId: number, shownHash: string, note?: string | null): Promise<Task> {
  const t = await load(userId, id);
  const awaiting = t.status === "waiting_for_approval" || (t.status === "waiting_for_owner" && t.approvalRequired && t.approvalStatus === "pending");
  if (!awaiting) throw new TicketRefused("التذكرة لا تنتظر موافقة", 409, "bad_transition");
  if (!/^[a-f0-9]{64}$/.test(String(shownHash ?? ""))) throw new TicketRefused("بصمة الحمولة (payloadHash) مطلوبة", 400, "invalid");
  const r = await approveTask(userId, id, ownerId, shownHash);
  if (!r) {
    await trail(t, "approve_refused", { kind: "owner", id: ownerId }, { status: "refused", why: "الحمولة تغيّرت منذ عُرضت", meta: { shown: shownHash, current: payloadHash(ticketPayload(t)) } });
    throw new TicketRefused("الحمولة تغيّرت منذ عُرضت عليك — راجعها من جديد", 409, "payload_changed");
  }
  const eventId = await trail(r, "status", { kind: "owner", id: ownerId }, { meta: { from: t.status, to: r.status, payloadHash: shownHash } });
  if (r.taskType === OWNER_ACTION_TYPE && r.status === "queued") return completeOwnerAction(r, ownerId, eventId, shownHash, note ?? null);
  return r;
}

/** بعد موافقةٍ من أي باب (المهام، الاعتماد الجماعي): owner_action في الطابور تُكمَل بقرار صاحبها. */
export async function settleOwnerAction(userId: number, taskId: number, ownerId: number, note?: string | null): Promise<Task | null> {
  const t = await load(userId, taskId).catch(() => null);
  if (!t || t.taskType !== OWNER_ACTION_TYPE || t.status !== "queued" || t.approvalStatus !== "approved") return t;
  const [ev] = (await db.execute<any>(sql`SELECT id FROM org_audit_log WHERE user_id = ${userId} AND action IN ('task.approved','ticket.status')
    AND meta->>'taskId' = ${String(taskId)} ORDER BY id DESC LIMIT 1`)).rows;
  return completeOwnerAction(t, ownerId, ev ? Number(ev.id) : null, t.approvedPayloadHash ?? "", note ?? null);
}

/** موافقة على تذكرة owner_action: مكتملة، مخرجها قرار صاحب الحساب، ودليلها حدث الموافقة. */
async function completeOwnerAction(t: Task, ownerId: number, eventId: number | null, payloadHash: string, note: string | null): Promise<Task> {
  const output = { decision: "approved", by: ownerId, note: note?.slice(0, 1000) || "وافق صاحب الحساب على هذا البند كما عُرض", payloadHash, title: t.title ?? null };
  const evidence = [{ type: "approval_event", id: eventId, ref: `org_audit_log:${eventId}`, note: "موافقة صاحب الحساب على بصمة الحمولة" }];
  const [row] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = 'completed', completed_at = now(), updated_at = now(), actual_output = ${JSON.stringify(output)}::jsonb,
      evidence_references = evidence_references || ${JSON.stringify(evidence)}::jsonb, lease_owner = NULL, lease_expires_at = NULL
    WHERE task_id = ${t.taskId} AND user_id = ${t.userId} AND status = 'queued' RETURNING *`)).rows;
  if (!row) return load(t.userId, t.taskId);
  const done = toTask(row);
  await trail(done, "status", { kind: "owner", id: ownerId }, { why: "قرار صاحب الحساب هو المخرج", meta: { from: "queued", to: "completed", approvalEventId: eventId } });
  await releaseDependents(t.taskId);
  return done;
}

export async function rejectTicket(userId: number, id: number, ownerId: number, why?: string | null): Promise<Task> {
  const t = await load(userId, id);
  const r = await rejectTask(userId, id, ownerId, why);
  if (!r) throw new TicketRefused("التذكرة لا تنتظر موافقة", 409, "bad_transition");
  const eventId = await trail(r, "rejected", { kind: "owner", id: ownerId }, { why, meta: { from: t.status } });
  if (r.taskType === OWNER_ACTION_TYPE) {
    // ملغاة بسببها: القرار والسبب يُحفظان مخرجاً، وحدث الرفض دليلاً.
    const reason = why?.trim() || "رفضها صاحب الحساب";
    const [row] = (await db.execute<any>(sql`UPDATE employee_tasks SET failure_reason = ${reason.slice(0, 500)}, failure_code = 'owner_rejected', retryable = false, responsible_party = 'owner',
        actual_output = ${JSON.stringify({ decision: "rejected", by: ownerId, reason })}::jsonb,
        evidence_references = evidence_references || ${JSON.stringify([{ type: "approval_event", id: eventId, ref: `org_audit_log:${eventId}`, note: "رفض صاحب الحساب" }])}::jsonb
      WHERE task_id = ${id} AND user_id = ${userId} AND status = 'cancelled' RETURNING *`)).rows;
    if (row) return toTask(row);
  }
  return r;
}

/** قبل أي عمل: المفتاح، والموافقة على الحمولة بعينها. يرمي TicketRefused. */
export async function assertExecutable(t: Task, payload: unknown = ticketPayload(t)): Promise<void> {
  const h = await taskHalted(t.userId, t.taskId);
  if (h.halted) throw new TicketRefused(h.reason ?? "التذكرة موقوفة", 409, "halted");
  if (!approvalMatches(t, payload)) {
    if (t.approvalStatus === "approved") await refuseChangedPayload(t, payload);
    throw new TicketRefused(t.approvalStatus === "approved" ? "الحمولة تختلف عمّا وافق عليه صاحب العمل" : "تنتظر موافقة صاحب العمل", 409, "approval");
  }
}

/**
 * التنفيذ: الحمولة المعطاة هي ما سيُفعل، وتُقارن ببصمة الموافقة قبل أي شيء. العمل يجري في
 * سياق التذكرة، فكل قرار بوابة فيه سطرٌ تحتها ومفتاحها يوقفه. ينتهي running، والإغلاق بعده.
 */
export async function executeTicket<T>(userId: number, id: number, payload: unknown, fn: () => Promise<T>, actor: Actor = { kind: "system", id: "executor" }): Promise<{ ticket: Task; value: T }> {
  let t = await load(userId, id);
  try { await assertExecutable(t, payload); }
  catch (err) {
    await recordAction({ userId, ticketId: id, role: t.ownerRole, actor, actionType: "execute.refused", status: "refused", input: { payloadHash: payloadHash(payload) }, output: { why: (err as Error).message } });
    throw err;
  }
  if (t.status !== "running") t = await transition(t, "running", actor, sql`, started_at = now(), attempt_count = attempt_count + 1`);
  else await db.execute(sql`UPDATE employee_tasks SET attempt_count = attempt_count + 1 WHERE task_id = ${id}`);
  const t0 = Date.now();
  const value = await withTicket({ userId, role: t.ownerRole, kind: t.taskType, ticketId: id, executionId: null }, fn);
  await db.execute(sql`UPDATE employee_tasks SET duration_ms = COALESCE(duration_ms, 0) + ${Date.now() - t0} WHERE task_id = ${id}`);
  return { ticket: await load(userId, id), value };
}

export interface Closing extends FailureInfo { status: "completed" | "failed" | "blocked"; actualOutput?: unknown; evidence?: Evidence[] }

/** الإغلاق، أو الفشل أو الحجب، بما يتطلبه كلٌّ منها. */
export async function closeTicket(userId: number, id: number, c: Closing, actor: Actor): Promise<Task> {
  const t = await load(userId, id);
  const problems = closureProblems(c.status, t, { ...c, evidence: [...t.evidence, ...(c.evidence ?? [])] });
  if (problems.length) throw new TicketRefused(problems.join(" · "), 400, "closure_incomplete");
  if (c.status === "completed") {
    const next = await transition(t, "completed", actor, sql`, completed_at = now(), actual_output = ${JSON.stringify(c.actualOutput)}::jsonb,
        evidence_references = evidence_references || ${JSON.stringify(c.evidence ?? [])}::jsonb, failure_reason = NULL, failure_code = NULL,
        lease_owner = NULL, lease_expires_at = NULL, duration_ms = COALESCE(duration_ms, (EXTRACT(EPOCH FROM (now() - COALESCE(started_at, created_at))) * 1000)::int)`);
    await releaseDependents(id);
    return next;
  }
  const next = await transition(t, c.status, actor, sql`, failure_reason = ${c.reason!.slice(0, 1000)}, failure_code = ${c.failureCode?.slice(0, 40) ?? c.status},
      retryable = ${c.retryable!}, responsible_party = ${c.responsibleParty!.slice(0, 60)}, next_action = ${c.suggestedResolution!},
      evidence_references = evidence_references || ${JSON.stringify(c.evidence ?? [])}::jsonb, lease_owner = NULL, lease_expires_at = NULL,
      ${c.status === "failed" ? sql`completed_at = now(),` : sql``} actual_output = COALESCE(${c.actualOutput === undefined ? null : JSON.stringify(c.actualOutput)}::jsonb, actual_output)`, c.reason);
  if (c.status === "failed") await closeDependents(id, "failed", `ما تعتمد عليه فشل (#${id})`);
  return next;
}

/** تسليمٌ إلى موظف: تذكرةٌ ابنة، والأب يعرف لمن سلّم. */
export async function handoffTicket(userId: number, parentId: number, h: { to: string; title: string; objective?: string | null; input?: unknown; actionType?: string | null; expectedOutput?: string | null; priority?: PriorityLevel | null; idempotencyKey?: string | null }, actor: Actor): Promise<Task> {
  const parent = await load(userId, parentId);
  const role = await roleForKey(userId, h.to);
  if (!role) throw new TicketRefused("التسليم لمفتاح موظف بعينه", 400, "invalid_assignee");
  const r = await createTask({
    userId, ownerRole: role, createdByRole: parent.ownerRole, parentTaskId: parentId, taskType: (h.actionType ?? "handoff").slice(0, 60), input: h.input ?? {},
    title: h.title, objective: h.objective ?? null, actionType: h.actionType ?? null, assignedTo: h.to, expectedOutput: h.expectedOutput ?? null,
    createdBy: actor, priorityLevel: h.priority ?? parent.priorityLevel, idempotencyKey: h.idempotencyKey ?? `handoff:${parentId}:${h.to}:${payloadHash(h.input ?? {}).slice(0, 16)}`,
  });
  if (!r.duplicate) await noteHandoff(userId, parentId, r.task.taskId, h.to);
  return r.task;
}

/** درسٌ مرشَّح من التذكرة: يبدأ pending ولا يدخل تعليمات أحد إلا بموافقة. */
export async function proposeLesson(userId: number, id: number, content: string, actor: Actor): Promise<number> {
  const t = await load(userId, id);
  if (!content?.trim()) throw new TicketRefused("نص الدرس مطلوب", 400, "invalid");
  const [r] = (await db.execute<{ id: number }>(sql`INSERT INTO agent_memory (user_id, role, kind, content, source_reference, approval_status)
    VALUES (${userId}, ${t.ownerRole.slice(0, 30)}, 'lesson', ${content.slice(0, 4000)}, ${`ticket:${id}`}, 'pending') RETURNING id`)).rows;
  await trail(t, "lesson_proposed", actor, { meta: { memoryId: Number(r!.id) } });
  return Number(r!.id);
}

/** يحتاج صاحب العمل: سؤالٌ أو قرارٌ ليس موافقةً على حمولة. */
export async function askOwner(userId: number, id: number, question: string, actor: Actor): Promise<Task> {
  const t = await load(userId, id);
  return transition(t, "waiting_for_owner", actor, sql`, next_action = ${question.slice(0, 1000)}`, question);
}

// ── أفعال صاحب العمل ──────────────────────────────────────────────
export async function commentTicket(userId: number, id: number, text: string, actor: Actor): Promise<void> {
  const t = await load(userId, id);
  if (!text?.trim()) throw new TicketRefused("التعليق فارغ", 400, "invalid");
  await recordAction({ userId, ticketId: id, role: t.ownerRole, actor, actionType: "ticket.comment", status: "info", input: { text: text.slice(0, 4000) } });
}

/** إيقافٌ مؤقت: مفتاح التذكرة، وتصير blocked بسببٍ مكتوب. العامل في منتصفها يتوقف عند البوابة. */
export async function pauseTicket(userId: number, id: number, actor: Actor, why?: string | null): Promise<Task> {
  const t = await load(userId, id);
  if (TERMINAL.includes(t.status) || t.status === "blocked") throw new TicketRefused("لا يُوقف ما أُغلق أو أُوقف", 409, "bad_transition");
  await setTaskSwitch(t, true, why || "أوقفها صاحب العمل مؤقتاً", actor);
  const from = t.status;
  // الانتقال المباشر إلى blocked مسموح من كل حالة مفتوحة إلا الموافقة والمسودة: هناك المفتاح وحده يكفي.
  if (!canTransition(from, "blocked")) { await trail(t, "paused", actor, { why, meta: { status: from } }); return t; }
  const next = await transition(t, "blocked", actor, sql`, failure_code = 'paused', failure_reason = ${why || "أوقفها صاحب العمل مؤقتاً"}, retryable = true,
      responsible_party = 'owner', next_action = 'يعيد صاحب العمل فتحها', lease_owner = NULL, lease_expires_at = NULL`, why);
  await trail(next, "paused", actor, { why });
  return next;
}

export async function cancelTicket(userId: number, id: number, actor: Actor, why?: string | null): Promise<Task> {
  const t = await load(userId, id);
  if (TERMINAL.includes(t.status)) throw new TicketRefused("أُغلقت من قبل", 409, "bad_transition");
  await setTaskSwitch(t, true, why || "أُلغيت", actor);
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = 'cancelled', failure_reason = ${why?.slice(0, 500) || "أُلغيت"}, failure_code = 'cancelled',
      lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE task_id = ${id} AND user_id = ${userId} AND status = ${t.status} RETURNING *`)).rows;
  if (!r) throw new TicketRefused("تغيّرت التذكرة منذ قُرئت — أعد التحميل", 409, "stale");
  const next = toTask(r);
  await trail(next, "status", actor, { why, meta: { from: t.status, to: "cancelled" } });
  await closeDependents(id, "cancelled", `ما تعتمد عليه أُلغي (#${id})`);
  return next;
}

/** إعادة الفتح: المفتاح يُرفع، والعدّاد من جديد. ما لم يُكلَّف يعود مسودة. */
export async function reopenTicket(userId: number, id: number, actor: Actor, why?: string | null): Promise<Task> {
  const t = await load(userId, id);
  if (!(TERMINAL.includes(t.status) || t.status === "blocked")) throw new TicketRefused("تُعاد المغلقة أو الموقوفة فقط", 409, "bad_transition");
  if (t.taskType === "ops_daily") throw new TicketRefused("سجل العمليات اليومي لا يُعاد فتحه", 409, "bad_transition");
  await setTaskSwitch(t, false, null, actor);
  const [r] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = CASE WHEN assigned_to IS NULL THEN 'draft' ELSE 'queued' END, retry_count = 0, dead_letter = false, next_attempt_at = NULL, completed_at = NULL,
      failure_reason = NULL, failure_code = NULL, retryable = NULL, responsible_party = NULL, updated_at = now(),
      approval_status = CASE WHEN approval_required AND approval_status = 'rejected' THEN 'pending' ELSE approval_status END
    WHERE task_id = ${id} AND user_id = ${userId} AND status = ${t.status} RETURNING *`)).rows;
  if (!r) throw new TicketRefused("تغيّرت التذكرة منذ قُرئت — أعد التحميل", 409, "stale");
  let next = toTask(r);
  // مرفوضةٌ أُعيدت: تعود تنتظر الموافقة لا الطابور.
  if (next.approvalRequired && next.approvalStatus === "pending") {
    const [w] = (await db.execute<any>(sql`UPDATE employee_tasks SET status = 'waiting_for_approval' WHERE task_id = ${id} RETURNING *`)).rows;
    next = toTask(w);
  }
  await trail(next, "reopened", actor, { why, meta: { from: t.status, to: next.status } });
  return next;
}

// ── القراءة ───────────────────────────────────────────────────────
const OVERDUE = sql`(t.due_at IS NOT NULL AND t.due_at < now() AND t.status IN ('draft','pending','queued','running','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked'))`;
const ROW = sql`t.*, ${OVERDUE} AS overdue`;

export interface TicketView extends Task { overdue: boolean; payloadHash: string }
const view = (r: any): TicketView => { const t = toTask(r); return { ...t, overdue: !!r.overdue, payloadHash: payloadHash(ticketPayload(t)) }; };

export interface TicketFilter {
  status?: string[]; department?: string | null; employee?: string | null; priority?: string | null; overdue?: boolean; approval?: boolean;
  q?: string | null; parent?: number | null; includeOps?: boolean; limit?: number; offset?: number;
}

export async function listTickets(userId: number, f: TicketFilter = {}): Promise<{ tickets: TicketView[]; total: number }> {
  await ensureTicketTables();
  const where = [sql`t.user_id = ${userId}`];
  if (f.status?.length) where.push(sql`t.status IN (${sql.join(f.status.map((s) => sql`${s}`), sql`, `)})`);
  if (f.department) where.push(sql`t.department = ${f.department}`);
  if (f.employee) where.push(sql`(t.assigned_to = ${f.employee} OR (t.assigned_to IS NULL AND t.owner_role = ${KEY_TO_ROLE.get(f.employee) ?? f.employee}))`);
  if (f.priority) where.push(sql`t.priority_level = ${f.priority}`);
  if (f.overdue) where.push(OVERDUE);
  if (f.approval) where.push(sql`t.status = 'waiting_for_approval'`);
  if (f.parent != null) where.push(sql`t.parent_task_id = ${f.parent}`);
  if (!f.includeOps) where.push(sql`t.task_type <> 'ops_daily'`);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(t.title ILIKE ${like} OR t.objective ILIKE ${like} OR t.description ILIKE ${like} OR t.task_type ILIKE ${like} OR t.assigned_to ILIKE ${like} OR t.task_id::text = ${f.q.trim()})`);
  }
  const w = sql.join(where, sql` AND `);
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const [rows, [n]] = await Promise.all([
    db.execute<any>(sql`SELECT ${ROW} FROM employee_tasks t WHERE ${w} ORDER BY t.priority, t.task_id DESC LIMIT ${limit} OFFSET ${Math.max(f.offset ?? 0, 0)}`).then((r) => r.rows),
    db.execute<any>(sql`SELECT count(*)::int AS n FROM employee_tasks t WHERE ${w}`).then((r) => r.rows),
  ]);
  return { tickets: rows.map(view), total: Number(n?.n ?? 0) };
}

/** تاريخ الموظف: تذاكره وأعدادها بالحالة. */
export async function employeeHistory(userId: number, key: string, limit = 100) {
  const role = await roleForKey(userId, key);
  if (!role) throw new TicketRefused("مفتاح موظف غير معروف", 404, "not_found");
  const { tickets } = await listTickets(userId, { employee: key, limit, includeOps: true });
  const counts = (await db.execute<any>(sql`SELECT status, count(*)::int AS n FROM employee_tasks WHERE user_id = ${userId} AND (assigned_to = ${key} OR (assigned_to IS NULL AND owner_role = ${role})) GROUP BY 1`)).rows;
  return { employeeKey: key, role, counts: Object.fromEntries(counts.map((c: any) => [c.status, Number(c.n)])), tickets };
}

/** طوابير الأقسام: المفتوح بالحالة، والمتأخر، وما ينتظر الموافقة. */
export async function departmentQueues(userId: number) {
  await ensureTicketTables();
  const rows = (await db.execute<any>(sql`SELECT COALESCE(t.department, 'shared') AS department, t.status, count(*)::int AS n, count(*) FILTER (WHERE ${OVERDUE})::int AS overdue
    FROM employee_tasks t WHERE t.user_id = ${userId} AND t.task_type <> 'ops_daily' AND t.status IN ('draft','pending','queued','running','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked')
    GROUP BY 1, 2 ORDER BY 1`)).rows;
  const by = new Map<string, { department: string; open: number; overdue: number; byStatus: Record<string, number> }>();
  for (const r of rows) {
    const d = by.get(r.department) ?? { department: String(r.department), open: 0, overdue: 0, byStatus: {} as Record<string, number> };
    d.open += Number(r.n); d.overdue += Number(r.overdue); d.byStatus[r.status] = Number(r.n);
    by.set(r.department, d);
  }
  return { departments: [...by.values()] };
}

/** التفاصيل: الخط الزمني (الأفعال وسجل التدقيق)، الأب والأبناء، الاعتماد في الاتجاهين، والتنفيذات. */
export async function ticketDetail(userId: number, id: number) {
  const t = await load(userId, id);
  const [[row], events, audits, children, deps, dependents, executions, parent] = await Promise.all([
    db.execute<any>(sql`SELECT ${ROW} FROM employee_tasks t WHERE t.task_id = ${id} AND t.user_id = ${userId}`).then((r) => r.rows),
    db.execute<any>(sql`SELECT id, employee_key, actor_kind, actor_id, action_type, input, output, status, evidence, attempt_no, idempotency_key, provider, model, execution_id, duration_ms, created_at
      FROM ticket_action_events WHERE ticket_id = ${id} AND user_id = ${userId} ORDER BY id DESC LIMIT 500`).then((r) => r.rows),
    db.execute<any>(sql`SELECT id, action, actor, why, meta, created_at FROM org_audit_log WHERE user_id = ${userId} AND kind = 'ticket' AND meta->>'taskId' = ${String(id)} ORDER BY id DESC LIMIT 200`).then((r) => r.rows),
    db.execute<any>(sql`SELECT ${ROW} FROM employee_tasks t WHERE t.parent_task_id = ${id} AND t.user_id = ${userId} ORDER BY t.task_id`).then((r) => r.rows),
    db.execute<any>(sql`SELECT ${ROW} FROM employee_task_dependencies d JOIN employee_tasks t ON t.task_id = d.depends_on WHERE d.task_id = ${id} AND d.user_id = ${userId} AND t.user_id = ${userId}`).then((r) => r.rows),
    db.execute<any>(sql`SELECT ${ROW} FROM employee_task_dependencies d JOIN employee_tasks t ON t.task_id = d.task_id WHERE d.depends_on = ${id} AND d.user_id = ${userId} AND t.user_id = ${userId}`).then((r) => r.rows),
    db.execute<any>(sql`SELECT id, employee_key, kind, status, model, model_calls, tokens_in, tokens_out, duration_ms, error, started_at, finished_at
      FROM employee_executions WHERE task_id = ${id} AND user_id = ${userId} ORDER BY id DESC LIMIT 50`).then((r) => r.rows),
    t.parentTaskId ? db.execute<any>(sql`SELECT ${ROW} FROM employee_tasks t WHERE t.task_id = ${t.parentTaskId} AND t.user_id = ${userId}`).then((r) => r.rows) : Promise.resolve([]),
  ]);
  const timeline = [
    ...events.map((e: any) => ({ at: e.created_at, source: "event", id: Number(e.id), action: e.action_type, status: e.status, actor: { kind: e.actor_kind, id: e.actor_id }, detail: { input: e.input, output: e.output, attemptNo: e.attempt_no, executionId: e.execution_id } })),
    ...audits.map((a: any) => ({ at: a.created_at, source: "audit", id: Number(a.id), action: a.action, status: "ok", actor: a.meta?.actor ?? null, detail: { why: a.why, meta: a.meta } })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return {
    ticket: view(row), parent: parent[0] ? view(parent[0]) : null, children: children.map(view), dependsOn: deps.map(view), dependents: dependents.map(view),
    events, timeline, executions, evidence: view(row).evidence, control: (await taskHalted(userId, id)),
  };
}

/** بيانات مخطط الاعتماد: التذاكر المفتوحة (وأقاربها)، وحواف الاعتماد والأبوّة. */
export async function dependencyGraph(userId: number, o: { root?: number | null; limit?: number } = {}) {
  await ensureTicketTables();
  const limit = Math.min(o.limit ?? 200, 500);
  const base = o.root != null
    // الأسرة: الأبناء، وما تعتمد عليه، وما يعتمد عليها، إلى عمق ستة. UNION يقطع الدوائر.
    ? sql`WITH RECURSIVE fam(id, depth) AS (SELECT ${o.root}::int, 0
          UNION SELECT x.id, fam.depth + 1 FROM fam CROSS JOIN LATERAL (
            SELECT t.task_id AS id FROM employee_tasks t WHERE t.parent_task_id = fam.id AND t.user_id = ${userId}
            UNION ALL SELECT d.depends_on FROM employee_task_dependencies d WHERE d.task_id = fam.id AND d.user_id = ${userId}
            UNION ALL SELECT d.task_id FROM employee_task_dependencies d WHERE d.depends_on = fam.id AND d.user_id = ${userId}) x WHERE fam.depth < 6)
        SELECT ${ROW} FROM employee_tasks t WHERE t.user_id = ${userId} AND t.task_id IN (SELECT id FROM fam) LIMIT ${limit}`
    : sql`SELECT ${ROW} FROM employee_tasks t WHERE t.user_id = ${userId} AND t.task_type <> 'ops_daily' AND (t.status IN ('draft','pending','queued','running','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked')
          OR EXISTS (SELECT 1 FROM employee_task_dependencies d WHERE d.depends_on = t.task_id AND d.user_id = ${userId})) ORDER BY t.task_id DESC LIMIT ${limit}`;
  const nodes = (await db.execute<any>(base)).rows.map(view);
  const ids = nodes.map((n) => n.taskId);
  if (!ids.length) return { nodes: [], edges: [] };
  const list = sql.join(ids.map((x) => sql`${x}`), sql`, `);
  const deps = (await db.execute<any>(sql`SELECT task_id, depends_on FROM employee_task_dependencies WHERE user_id = ${userId} AND task_id IN (${list}) AND depends_on IN (${list})`)).rows;
  const set = new Set(ids);
  const edges = [
    ...deps.map((d: any) => ({ from: Number(d.depends_on), to: Number(d.task_id), kind: "dependency" as const })),
    ...nodes.filter((n) => n.parentTaskId != null && set.has(n.parentTaskId)).map((n) => ({ from: n.parentTaskId!, to: n.taskId, kind: "child" as const })),
  ];
  return {
    nodes: nodes.map((n) => ({ id: n.taskId, title: n.title ?? n.taskType, status: n.status, assignedTo: n.assignedTo, priority: n.priorityLevel, overdue: n.overdue, department: n.department })),
    edges,
  };
}

/** صندوق صاحب العمل: ما ينتظر موافقته، وما ينتظر قراره، وما يستحق نظره. */
export async function ownerInbox(userId: number) {
  await ensureTicketTables();
  const q = (w: SQL) => db.execute<any>(sql`SELECT ${ROW} FROM employee_tasks t WHERE t.user_id = ${userId} AND ${w} ORDER BY t.priority, t.task_id DESC LIMIT 100`).then((r) => r.rows.map(view));
  const [approvals, waitingForOwner, escalations] = await Promise.all([
    q(sql`t.status = 'waiting_for_approval'`),
    q(sql`t.status = 'waiting_for_owner'`),
    q(sql`t.task_type <> 'ops_daily' AND (t.status = 'blocked' OR (t.status = 'failed' AND t.dead_letter AND t.updated_at > now() - interval '14 days')
      OR (${OVERDUE} AND t.priority <= 75))`),
  ]);
  return { approvals, waitingForOwner, escalations, counts: { approvals: approvals.length, waitingForOwner: waitingForOwner.length, escalations: escalations.length } };
}

export const ownerActor = (userId: number): Actor => ({ kind: "owner", id: userId });
export { priorityLevelOf };
