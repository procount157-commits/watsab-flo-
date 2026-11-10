// ── سجل الأفعال ───────────────────────────────────────────────────
// كل فعلٍ له معنى سطرٌ تحت تذكرته في ticket_action_events: قرار البوابة (سُمح أو رُفض)،
// تغيير الحالة، الموافقة، التسليم، التعليق. ملخص نداءات النموذج في receipts و
// employee_executions، ويُربط برقم التنفيذ (execution_id) ولا يُنسخ.
//
// التذكرة الحالية تأتي من سياق runAs (withTicket). إن لم يكن ثمة سياق، أو كان سياق جولةٍ
// بلا تذكرة، يُعلَّق الفعل على «سجل عمليات» يومي لهذا الموظف وهذا النوع، فلا يبقى فعلٌ
// يتيماً، ولا تُفتح تذكرة لدقّةٍ لم تفعل شيئاً: السجل اليومي لا يُنشأ إلا عند أول فعل.
//
// الكتابة هنا لا ترمي أبداً: سجلٌ تعذّر لا يفتح البوابة ولا يغلقها، لكنه يُقال في اللوق.
// إعادة المحاولة محاولةٌ تحت مفتاح التكرار نفسه (attempt_no يزيد)، لا تذكرة جديدة.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { ensureOrgTables } from "./schema";
import { employeeKeyOf, orgDepartmentOf } from "./departments";

// ── الجداول عند الإقلاع (= 076_tickets.sql) ──────────────────────
const STATUS_LIST = `'draft','pending','queued','running','waiting_for_dependency','waiting_for_approval','waiting_for_owner','blocked','completed','failed','cancelled','expired'`;
export const TICKET_SQL = [
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS title text`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS objective text`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS description text`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS assigned_to varchar(60)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS created_by_kind varchar(12)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS created_by_id varchar(80)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_customer_id integer`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_campaign_id integer`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS related_conversation_id varchar(120)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS action_type varchar(60)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS evidence_references jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS expected_output text`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS actual_output jsonb`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS duration_ms integer`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS failure_code varchar(40)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS next_action text`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS handoff_target varchar(60)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS audit_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb`,
  // عمود محسوب يعيد كتابة الجدول مرةً واحدة: يُفحص أولاً فلا قفل عند كل إقلاع، وانتظار القفل محدود (lock_timeout) فلا يصطف خلفه كل ما يقرأ الجدول.
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'employee_tasks' AND column_name = 'priority_level') THEN
      SET LOCAL lock_timeout = '10s';
      ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS priority_level varchar(10) GENERATED ALWAYS AS (CASE WHEN priority <= 25 THEN 'critical' WHEN priority <= 75 THEN 'high' WHEN priority <= 150 THEN 'normal' ELSE 'low' END) STORED;
    END IF;
  END $$`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS retryable boolean`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS responsible_party varchar(60)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approval_payload_hash varchar(64)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_payload_hash varchar(64)`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_by integer`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS approved_at timestamptz`,
  `ALTER TABLE employee_tasks ADD COLUMN IF NOT EXISTS due_at timestamptz`,
  // الحالات الجديدة: يُستبدل القيد مرةً واحدة، لا عند كل إقلاع (القفل والفحص على الجدول كله).
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_tasks_status' AND pg_get_constraintdef(oid) LIKE '%waiting_for_owner%') THEN
      ALTER TABLE employee_tasks DROP CONSTRAINT IF EXISTS employee_tasks_status;
      ALTER TABLE employee_tasks ADD CONSTRAINT employee_tasks_status CHECK (status IN (${STATUS_LIST}));
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_controls_scope' AND pg_get_constraintdef(oid) LIKE '%''task''%') THEN
      ALTER TABLE org_controls DROP CONSTRAINT IF EXISTS org_controls_scope;
      ALTER TABLE org_controls ADD CONSTRAINT org_controls_scope CHECK (scope IN ('global','account','department','employee','channel','task'));
    END IF;
  END $$`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_assigned ON employee_tasks (user_id, assigned_to, status)`,
  `CREATE INDEX IF NOT EXISTS idx_employee_tasks_due_at ON employee_tasks (user_id, due_at) WHERE due_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS ticket_action_events (
    id bigserial PRIMARY KEY, ticket_id integer NOT NULL REFERENCES employee_tasks(task_id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60), actor_kind varchar(12), actor_id varchar(80),
    action_type varchar(60) NOT NULL, input jsonb, output jsonb, status varchar(20) NOT NULL, evidence jsonb,
    attempt_no integer NOT NULL DEFAULT 1, idempotency_key varchar(200), provider varchar(40), model varchar(120),
    execution_id bigint, duration_ms integer, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ticket_events_status CHECK (status IN ('ok','allowed','refused','failed','started','info')))`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_action_events (ticket_id, id)`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_events_user ON ticket_action_events (user_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_events_created ON ticket_action_events (created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_events_attempt ON ticket_action_events (user_id, idempotency_key, attempt_no) WHERE idempotency_key IS NOT NULL`,
];

let ready: Promise<boolean> | null = null;
/** مرةً في العملية، بعد جداول المنظّمة. الفشل لا يُحفظ: النداء التالي يحاول من جديد. */
export function ensureTicketTables(): Promise<boolean> {
  ready ??= (async () => {
    if (!(await ensureOrgTables())) throw new Error("جداول المنظّمة غير جاهزة");
    for (const q of TICKET_SQL) await db.execute(sql.raw(q));
    return true;
  })().catch((e) => {
    ready = null;
    logger.warn({ err: String(e?.message ?? e).slice(0, 200) }, "تعذّر إنشاء جداول التذاكر");
    return false;
  });
  return ready;
}

// ── البصمة ────────────────────────────────────────────────────────
/** JSON بمفاتيح مرتّبة: الحمولة نفسها لها النص نفسه أيّاً كان ترتيب بنائها. Pure. */
export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
/** SHA-256 للحمولة بعينها. Pure. */
export const payloadHash = (payload: unknown): string => createHash("sha256").update(stableStringify(payload)).digest("hex");
/** حمولة التذكرة التي يوافق عليها صاحب العمل: نوع الفعل ومدخله، كما سيُنفَّذان. Pure. */
export const ticketPayload = (t: { actionType?: string | null; taskType: string; inputRefs: unknown }) => ({ actionType: t.actionType ?? t.taskType, input: t.inputRefs ?? [] });

// ── السياق ────────────────────────────────────────────────────────
export interface TicketContext {
  userId: number; role: string; kind: string;
  /** تذكرة العمل المعروفة (المهمة التي أخذها العامل). فارغ: جولةٌ بلا مهمة. */
  ticketId: number | null;
  executionId: number | null;
  /** سجل العمليات اليومي، يُفتح عند أول فعل فقط. */
  lazy?: Promise<number | null>;
}
const store = new AsyncLocalStorage<TicketContext>();
export const withTicket = <T>(ctx: TicketContext, fn: () => Promise<T>): Promise<T> => store.run(ctx, fn);
export const currentTicket = (): TicketContext | undefined => store.getStore();

const dubaiDay = (now = Date.now()) => new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
const opsCache = new Map<string, Promise<number | null>>();
export const UNATTRIBUTED_ROLE = "unattributed";

/**
 * سجل العمليات اليومي لموظفٍ ونوع عمل: تذكرةٌ واحدة في اليوم، مهما كثرت الدقّات. يرمي إن
 * تعذّر، ويُنسى من الذاكرة ليُحاول من جديد.
 */
export function opsTicketFor(userId: number, role: string, kind = "ops", now = Date.now()): Promise<number | null> {
  const key = employeeKeyOf(role);
  const day = dubaiDay(now);
  const k = `${userId}:${key}:${kind}:${day}`;
  let p = opsCache.get(k);
  if (!p) {
    p = (async () => {
      if (!(await ensureTicketTables())) return null;
      const idem = `ops:${key}:${kind}:${day}`.slice(0, 200);
      const ins = await db.execute<{ task_id: number }>(sql`
        INSERT INTO employee_tasks (user_id, department, owner_role, task_type, priority, status, started_at, idempotency_key, input_refs, title, objective,
            assigned_to, created_by_kind, created_by_id, action_type, expected_output)
        VALUES (${userId}, ${orgDepartmentOf(role)}, ${role.slice(0, 60)}, 'ops_daily', 200, 'running', now(), ${idem}, ${JSON.stringify({ kind, day })}::jsonb,
            ${`سجل عمليات ${key} · ${kind} · ${day}`.slice(0, 300)}, ${"كل قرارٍ وفعلٍ لم يُنسب إلى تذكرة عمل، ليُرى ولا يضيع"},
            ${key}, 'system', 'ledger', 'ops_log', ${"سطرٌ لكل قرار بوابة وفعل؛ يُغلق في اليوم التالي بأعداده"})
        ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING task_id`);
      if (ins.rows.length) return Number(ins.rows[0]!.task_id);
      const [r] = (await db.execute<{ task_id: number }>(sql`SELECT task_id FROM employee_tasks WHERE user_id = ${userId} AND idempotency_key = ${idem}`)).rows;
      return r ? Number(r.task_id) : null;
    })().catch((err) => { opsCache.delete(k); throw err; });
    opsCache.set(k, p);
    if (opsCache.size > 5000) opsCache.delete(opsCache.keys().next().value as string);
  }
  return p;
}

/** التذكرة التي يُكتب تحتها فعلٌ الآن: الصريحة، ثم تذكرة السياق، ثم سجل العمليات اليومي. */
export async function resolveTicket(userId: number, role?: string | null, explicit?: number | null): Promise<number | null> {
  if (explicit != null) return explicit;
  const ctx = currentTicket();
  if (ctx && ctx.userId === userId) {
    if (ctx.ticketId != null) return ctx.ticketId;
    ctx.lazy ??= opsTicketFor(userId, ctx.role, ctx.kind).catch(() => null);
    return ctx.lazy;
  }
  return opsTicketFor(userId, role || ctx?.role || UNATTRIBUTED_ROLE, "ops").catch(() => null);
}

// ── الكتابة ───────────────────────────────────────────────────────
export type EventStatus = "ok" | "allowed" | "refused" | "failed" | "started" | "info";
export interface ActionEvent {
  userId: number; actionType: string; status: EventStatus;
  ticketId?: number | null; role?: string | null; employeeKey?: string | null;
  actor?: { kind: "owner" | "employee" | "system"; id: string | number } | null;
  input?: unknown; output?: unknown; evidence?: unknown;
  /** المنطق نفسه بمحاولةٍ أخرى: المفتاح نفسه، attempt_no يزيد. */
  idempotencyKey?: string | null;
  provider?: string | null; model?: string | null; executionId?: number | null; durationMs?: number | null;
}
export interface Recorded { id: number; ticketId: number; attemptNo: number }

const J = (v: unknown) => (v === undefined || v === null ? sql`NULL::jsonb` : sql`${JSON.stringify(v)}::jsonb`);

/** سطرٌ في السجل. لا يرمي: null إن تعذّر، والسبب في اللوق. */
export async function recordAction(e: ActionEvent): Promise<Recorded | null> {
  try {
    if (!(await ensureTicketTables())) return null;
    const ctx = currentTicket();
    const role = e.role ?? (ctx?.userId === e.userId ? ctx.role : null);
    const ticketId = await resolveTicket(e.userId, role, e.ticketId);
    if (ticketId == null) return null;
    const key = e.employeeKey ?? (role ? employeeKeyOf(role) : null);
    const actor = e.actor ?? (role ? { kind: "employee" as const, id: employeeKeyOf(role) } : { kind: "system" as const, id: "system" });
    const execId = e.executionId ?? (ctx?.userId === e.userId ? ctx.executionId : null) ?? null;
    const idem = e.idempotencyKey?.slice(0, 200) ?? null;
    const insert = () => db.execute<{ id: number; attempt_no: number }>(sql`
      INSERT INTO ticket_action_events (ticket_id, user_id, employee_key, actor_kind, actor_id, action_type, input, output, status, evidence,
          attempt_no, idempotency_key, provider, model, execution_id, duration_ms)
      SELECT ${ticketId}, ${e.userId}, ${key}, ${actor.kind}, ${String(actor.id).slice(0, 80)}, ${e.actionType.slice(0, 60)}, ${J(e.input)}, ${J(e.output)}, ${e.status}, ${J(e.evidence)},
          ${idem == null ? sql`1` : sql`COALESCE((SELECT max(attempt_no) FROM ticket_action_events WHERE user_id = ${e.userId} AND idempotency_key = ${idem}), 0) + 1`},
          ${idem}, ${e.provider?.slice(0, 40) ?? null}, ${e.model?.slice(0, 120) ?? null}, ${execId}, ${e.durationMs ?? null}
      RETURNING id, attempt_no`);
    // محاولتان متزامنتان بالمفتاح نفسه: الثانية تأخذ الرقم التالي.
    const r = await insert().catch((err) => (idem && /uq_ticket_events_attempt|duplicate key/.test(String(err?.message ?? err)) ? insert() : Promise.reject(err)));
    return { id: Number(r.rows[0]!.id), ticketId, attemptNo: Number(r.rows[0]!.attempt_no) };
  } catch (err: any) {
    logger.warn({ userId: e.userId, action: e.actionType, err: String(err?.message ?? err).slice(0, 200) }, "فعلٌ لم يُكتب في سجل التذاكر");
    return null;
  }
}

/** قرار البوابة سطراً: سُمح أو رُفض، بسببه. */
export function recordGate(i: { userId: number; channel: string; kind: string; recipient?: string | null; role?: string | null; idempotencyKey?: string | null; recheck?: boolean },
  r: { allowed: boolean; code: string; why: string | null; scope: string | null }): Promise<Recorded | null> {
  return recordAction({
    userId: i.userId, role: i.role ?? null, actionType: `gate.${i.channel}`.slice(0, 60), status: r.allowed ? "allowed" : "refused",
    input: { channel: i.channel, kind: i.kind, recipient: i.recipient ?? null, recheck: !!i.recheck },
    output: { code: r.code, why: r.why, scope: r.scope }, idempotencyKey: i.idempotencyKey ?? null,
  });
}

// ── الصيانة ───────────────────────────────────────────────────────
export const EVENTS_KEEP_DAYS = 90;

/** سجلات الأيام الماضية تُغلق بأعدادها دليلاً، والأحداث الأقدم من ٩٠ يوماً تُحذف. التذاكر تبقى. */
export async function ledgerMaintenance(): Promise<{ closed: number; deleted: number }> {
  if (!(await ensureTicketTables())) return { closed: 0, deleted: 0 };
  const today = dubaiDay();
  const closed = await db.execute(sql`
    UPDATE employee_tasks t SET status = 'completed', completed_at = now(), updated_at = now(),
        duration_ms = (EXTRACT(EPOCH FROM (now() - COALESCE(t.started_at, t.created_at))) * 1000)::int,
        actual_output = (SELECT jsonb_build_object('events', count(*), 'allowed', count(*) FILTER (WHERE e.status = 'allowed'), 'refused', count(*) FILTER (WHERE e.status = 'refused'))
                         FROM ticket_action_events e WHERE e.ticket_id = t.task_id),
        evidence_references = jsonb_build_array(jsonb_build_object('type', 'action_events', 'ticketId', t.task_id))
          || COALESCE((SELECT jsonb_agg(jsonb_build_object('type', 'execution', 'id', x.id)) FROM (SELECT id FROM employee_executions WHERE task_id = t.task_id ORDER BY id DESC LIMIT 20) x), '[]'::jsonb)
    WHERE t.task_type = 'ops_daily' AND t.status = 'running' AND right(t.idempotency_key, 10) < ${today}`);
  let deleted = 0;
  for (let i = 0; i < 50; i++) {
    const d = await db.execute(sql`DELETE FROM ticket_action_events WHERE id IN (SELECT id FROM ticket_action_events WHERE created_at < now() - make_interval(days => ${EVENTS_KEEP_DAYS}) LIMIT 5000)`);
    deleted += d.rowCount ?? 0;
    if ((d.rowCount ?? 0) < 5000) break;
  }
  return { closed: closed.rowCount ?? 0, deleted };
}

/** للاختبار وحده. */
export const forgetLedgerCache = () => { opsCache.clear(); };

// ── التسليم ───────────────────────────────────────────────────────
/** تذكرة السياق لهذا الحساب، أباً لما يُسلَّم منها. */
export const contextTicketId = (userId: number): number | null => {
  const c = currentTicket();
  return c && c.userId === userId ? c.ticketId : null;
};

/** سلّمت التذكرة الأب عملاً إلى موظف: يُكتب على الأب لمن، ويُسجَّل الفعل تحته. لا يرمي. */
export async function noteHandoff(userId: number, parentId: number | null | undefined, childId: number, targetKey: string): Promise<void> {
  if (parentId == null || parentId === childId) return;
  try {
    if (!(await ensureTicketTables())) return;
    const r = await db.execute(sql`UPDATE employee_tasks SET handoff_target = ${targetKey.slice(0, 60)}, updated_at = now() WHERE task_id = ${parentId} AND user_id = ${userId}`);
    if (!r.rowCount) return;
    await recordAction({ userId, ticketId: parentId, actionType: "ticket.handoff", status: "ok", output: { child: childId, to: targetKey } });
  } catch (err: any) {
    logger.warn({ userId, parentId, childId, err: String(err?.message ?? err).slice(0, 200) }, "تسليمٌ لم يُكتب على أبيه");
  }
}
