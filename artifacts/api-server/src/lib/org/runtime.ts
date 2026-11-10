// ── تشغيل موظف ────────────────────────────────────────────────────
// كل جولةٍ حقيقية تمرّ من هنا: تسأل المفتاح، تفتح سطر تنفيذ، تكتب النبض، وتعدّ نداءات
// النموذج. لا نبض من مؤقتٍ فارغ: الصف لا يُكتب إلا من شيفرةٍ تعمل فعلاً، فموظفٌ بلا
// عامل يبقى بلا صف، ويقول الجرد عنه no_execution.
//
// المراقبة لا توقف العمل: فشل كتابة النبض يُسجَّل في اللوق وتكمل الجولة. أما فشل قراءة
// المفاتيح فيُغلق (controls.ts)، كما كان.

import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { asWorker, withMeter, type Meter } from "../agent-context";
import { isHalted, taskHalted, type Halt } from "./controls";
import { opsTicketFor, withTicket, type TicketContext } from "./ledger";
import { employeeKeyOf, intervalOf } from "./departments";

export const workerId = () => `${hostname()}:${process.pid}`.slice(0, 80);

export interface RunOpts {
  kind: string;
  taskId?: number | null;
  /**
   * من يوقف هذه الجولة: employee (الافتراضي) الموظف وقسمه وحسابه؛ account الحساب والمنصة
   * فقط، لعاملٍ له مفاتيح موظفيه بداخله (الطيار يسأل عن يوسف وسلمى كلاً على حدة)؛
   * none للمعفى عمداً (AUDIT-P0: المراقب والتشغيل) أو لمن سأل قبل أن يصل هنا.
   */
  respect?: "employee" | "account" | "none";
  /** عاملٌ كثير الدقّات: النبض وحده، وسطر تنفيذ كل هذا العدد من الدقائق على الأكثر. */
  sampleMin?: number;
  intervalSec?: number | null;
}
export type RunOutcome<T> = { ran: true; value: T; executionId: number | null } | { ran: false; halt: Halt };

const warn = (what: string, err: unknown) => logger.warn({ err: String((err as any)?.message ?? err).slice(0, 200) }, what);
const short = (e: unknown) => String((e as any)?.message ?? e).slice(0, 500);

// ── الكتابة ───────────────────────────────────────────────────────
/** أقل فاصل بين كتابتين لنبض عاملٍ كثير الدقّات: الصف يُحدَّث ولا ينمو، لكن كل تحديث صفٌّ ميت. */
export const BEAT_COALESCE_MS = 60_000;
const lastWrite = new Map<string, { at: number; status: string }>();
const lastSample = new Map<string, number>();

interface Beat {
  userId: number; key: string; status: string; intervalSec: number | null; kind: string;
  executionId?: number | null; started?: boolean; completed?: boolean; ok?: boolean; error?: string | null; n?: number | null;
}

async function writeBeat(b: Beat) {
  const wid = workerId();
  const next = b.intervalSec ? sql`now() + make_interval(secs => ${b.intervalSec})` : sql`NULL::timestamptz`;
  const failed = b.completed && b.ok === false;
  const detail = JSON.stringify({ kind: b.kind, ...(b.n == null ? {} : { n: b.n }) });
  await db.execute(sql`
    INSERT INTO employee_heartbeats AS h (user_id, employee_key, status, last_beat_at, next_beat_at, last_error, detail, last_started_at, last_completed_at,
        last_success_at, last_failure_at, consecutive_failures, last_execution_id, worker_id, interval_sec)
    VALUES (${b.userId}, ${b.key}, ${b.status}, now(), ${next}, ${b.error ?? null}, ${detail}::jsonb,
        ${b.started ? sql`now()` : sql`NULL::timestamptz`}, ${b.completed ? sql`now()` : sql`NULL::timestamptz`},
        ${b.completed && b.ok ? sql`now()` : sql`NULL::timestamptz`}, ${failed ? sql`now()` : sql`NULL::timestamptz`},
        ${failed ? 1 : 0}, ${b.executionId ?? null}, ${wid}, ${b.intervalSec})
    ON CONFLICT (user_id, employee_key) DO UPDATE SET
      status = EXCLUDED.status, last_beat_at = now(), next_beat_at = COALESCE(EXCLUDED.next_beat_at, h.next_beat_at),
      last_error = ${b.completed ? sql`EXCLUDED.last_error` : sql`h.last_error`}, detail = EXCLUDED.detail,
      last_started_at = COALESCE(EXCLUDED.last_started_at, h.last_started_at),
      last_completed_at = COALESCE(EXCLUDED.last_completed_at, h.last_completed_at),
      last_success_at = COALESCE(EXCLUDED.last_success_at, h.last_success_at),
      last_failure_at = COALESCE(EXCLUDED.last_failure_at, h.last_failure_at),
      consecutive_failures = ${b.completed ? (failed ? sql`h.consecutive_failures + 1` : sql`0`) : sql`h.consecutive_failures`},
      last_execution_id = COALESCE(EXCLUDED.last_execution_id, h.last_execution_id),
      worker_id = EXCLUDED.worker_id, interval_sec = COALESCE(EXCLUDED.interval_sec, h.interval_sec)`);
}

const safeBeat = (b: Beat) => writeBeat(b).catch((err) => warn("نبضٌ لم يُكتب", err));

/** نبضٌ مجمَّع: الخطأ وتغيّر الحالة يُكتبان فوراً، والتكرار مرةً في الدقيقة. */
async function coalescedBeat(b: Beat) {
  const k = `${b.userId}:${b.key}`;
  const prev = lastWrite.get(k);
  if (prev && prev.status === b.status && b.ok !== false && Date.now() - prev.at < BEAT_COALESCE_MS) return;
  lastWrite.set(k, { at: Date.now(), status: b.status });
  await safeBeat(b);
}

async function openExecution(userId: number, key: string, o: RunOpts): Promise<number | null> {
  try {
    const r = await db.execute<{ id: number }>(sql`INSERT INTO employee_executions (user_id, employee_key, task_id, status, kind, worker_id)
      VALUES (${userId}, ${key}, ${o.taskId ?? null}, 'running', ${o.kind.slice(0, 60)}, ${workerId()}) RETURNING id`);
    return Number(r.rows[0]!.id);
  } catch (err) { warn("سطر تنفيذ لم يُكتب", err); return null; }
}

async function closeExecution(id: number, status: string, m: Meter, ms: number, error: string | null) {
  await db.execute(sql`UPDATE employee_executions SET status = ${status}, finished_at = now(), duration_ms = ${ms}, model_calls = ${m.calls},
      tokens_in = ${m.tokensIn}, tokens_out = ${m.tokensOut}, model = ${m.model?.slice(0, 120) ?? null}, error = ${error} WHERE id = ${id}`)
    .catch((err) => warn("سطر تنفيذ لم يُغلق", err));
}

/** سطر تنفيذ لجولةٍ انتهت، مرةً كل sampleMin دقيقة لهذا العامل وهذا النوع. */
async function sampledExecution(userId: number, key: string, o: RunOpts, status: string, m: Meter, ms: number, error: string | null): Promise<number | null> {
  const k = `${userId}:${key}:${o.kind}:${status}`;
  if (Date.now() - (lastSample.get(k) ?? 0) < (o.sampleMin ?? 15) * 60_000) return null;
  lastSample.set(k, Date.now());
  try {
    const r = await db.execute<{ id: number }>(sql`INSERT INTO employee_executions (user_id, employee_key, task_id, status, kind, worker_id, finished_at, duration_ms, model_calls, tokens_in, tokens_out, model, error)
      VALUES (${userId}, ${key}, ${o.taskId ?? null}, ${status}, ${o.kind.slice(0, 60)}, ${workerId()}, now(), ${ms}, ${m.calls}, ${m.tokensIn}, ${m.tokensOut}, ${m.model?.slice(0, 120) ?? null}, ${error}) RETURNING id`);
    return Number(r.rows[0]!.id);
  } catch (err) { warn("عيّنة تنفيذ لم تُكتب", err); return null; }
}

// ── التذكرة ───────────────────────────────────────────────────────
/**
 * جولةٌ بلا مهمة لا تفتح تذكرة لكل دقّة: سجل العمليات اليومي يُفتح عند أول فعلٍ فيها
 * (قرار بوابة)، أو حين نادت النموذج. حينها يُربط سطر تنفيذها به، فالنداءات في receipts
 * ومجموعها في employee_executions يُريان من التذكرة بلا نسخ.
 */
async function linkRunTicket(ctx: TicketContext, executionId: number | null, m: Meter) {
  if (!executionId || ctx.ticketId != null) return;
  const id = (await ctx.lazy?.catch(() => null)) ?? (m.calls > 0 ? await opsTicketFor(ctx.userId, ctx.role, ctx.kind).catch(() => null) : null);
  if (id == null) return;
  await db.execute(sql`UPDATE employee_executions SET task_id = ${id} WHERE id = ${executionId} AND task_id IS NULL`).catch((err) => warn("التنفيذ لم يُربط بتذكرته", err));
}

// ── التشغيل ───────────────────────────────────────────────────────
async function haltFor(userId: number, role: string, respect: RunOpts["respect"]): Promise<Halt | null> {
  if (respect === "none") return null;
  const h = respect === "account" ? await isHalted({ userId })
    : await isHalted({ userId, role });
  return h.halted ? h : null;
}

const nonClear = (h: Halt): Halt | null => (h.halted ? h : null);

/** الجولة كاملة، وتقول إن لم تعمل ولماذا. يرمي ما يرميه العمل نفسه، بعد أن يُكتب. */
export async function execute<T>(userId: number, role: string, o: RunOpts, fn: () => Promise<T>): Promise<RunOutcome<T>> {
  const key = employeeKeyOf(role);
  const interval = o.intervalSec === undefined ? intervalOf(role) : o.intervalSec;
  // مفتاح التذكرة يُسأل دائماً، حتى في الجولة المعفاة: أوقفها صاحب العمل أو ألغاها.
  const halt = await haltFor(userId, role, o.respect) ?? (o.taskId != null ? nonClear(await taskHalted(userId, o.taskId)) : null);
  if (halt) {
    // العامل حيّ وسأل، والعمل لم يبدأ: لا سطر تنفيذ. الحالة تُرى ولا تُعدّ نجاحاً.
    await coalescedBeat({ userId, key, status: "halted", intervalSec: interval, kind: o.kind });
    return { ran: false, halt };
  }
  const sampled = !!o.sampleMin;
  const executionId = sampled ? null : await openExecution(userId, key, o);
  if (!sampled) await safeBeat({ userId, key, status: "running", intervalSec: interval, kind: o.kind, executionId, started: true });
  const meter: Meter = { calls: 0, tokensIn: 0, tokensOut: 0, model: null, kind: o.kind };
  const ctx: TicketContext = { userId, role, kind: o.kind.slice(0, 60), ticketId: o.taskId ?? null, executionId };
  const t0 = Date.now();
  try {
    const value = await withTicket(ctx, () => withMeter(meter, () => asWorker(userId, role, fn)));
    await linkRunTicket(ctx, executionId, meter);
    const ms = Date.now() - t0;
    if (sampled) {
      const id = await sampledExecution(userId, key, o, "succeeded", meter, ms, null);
      await coalescedBeat({ userId, key, status: "idle", intervalSec: interval, kind: o.kind, executionId: id, started: true, completed: true, ok: true });
    } else {
      if (executionId) await closeExecution(executionId, "succeeded", meter, ms, null);
      await safeBeat({ userId, key, status: "idle", intervalSec: interval, kind: o.kind, completed: true, ok: true });
    }
    return { ran: true, value, executionId };
  } catch (err) {
    const ms = Date.now() - t0;
    const error = short(err);
    await linkRunTicket(ctx, executionId, meter);
    if (sampled) {
      const id = await sampledExecution(userId, key, o, "failed", meter, ms, error);
      await coalescedBeat({ userId, key, status: "failed", intervalSec: interval, kind: o.kind, executionId: id, started: true, completed: true, ok: false, error });
    } else {
      if (executionId) await closeExecution(executionId, "failed", meter, ms, error);
      await safeBeat({ userId, key, status: "failed", intervalSec: interval, kind: o.kind, completed: true, ok: false, error });
    }
    throw err;
  }
}

/** كما يحب المستدعي: القيمة، أو null إن كان موقوفاً. الخطأ يُرمى كما كان. */
export async function runAs<T>(userId: number, role: string, o: RunOpts, fn: () => Promise<T>): Promise<T | null> {
  const r = await execute(userId, role, o, fn);
  return r.ran ? r.value : null;
}

/**
 * نبضٌ من داخل جولةٍ تعمل الآن، لموظفٍ خطوته جزءٌ منها (يوسف داخل جولة الطيار، أو
 * عاملٌ مرّ ولم يجد ما يعمله). يُستدعى من الشيفرة العاملة فقط: لا مؤقّت خاص له.
 */
export async function beat(userId: number, role: string, o: { kind: string; ok?: boolean; error?: string | null; n?: number | null; intervalSec?: number | null }): Promise<void> {
  const ok = o.ok !== false;
  await coalescedBeat({ userId, key: employeeKeyOf(role), status: ok ? "idle" : "failed", intervalSec: o.intervalSec === undefined ? intervalOf(role) : o.intervalSec,
    kind: o.kind, started: true, completed: true, ok, error: o.error ?? null, n: o.n ?? null });
}

/** للاختبار وحده. */
export const forgetRuntimeCache = () => { lastWrite.clear(); lastSample.clear(); };
