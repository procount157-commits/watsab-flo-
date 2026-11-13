// ── سجل العمّال: كل حلقة متكررة تُرى ─────────────────────────────
// everyMs(name, ms, fn) بدل setInterval: يسجّل الحلقة (الاسم، الفاصل، نطاق الحسابات)، ويكتب
// بعد كل دقّة last_tick_at وlast_ok_at أو last_error ومدتها وعدد الدقّات، في صفٍّ واحد لكل
// حلقة في كل عملية (worker_registry، المفتاح worker_id + name) يُحدَّث مكانه — لا صف لكل دقّة.
// ويمسك الخطأ: حلقةٌ رمت لا تُسقط العملية ولا توقف الدقّات التالية، وخطؤها يُرى.
//
// الحارس (watchdog.ts) يعلّم حلقةً «عالقة» إن مرّ على آخر دقّة أكثر من ثلاثة أضعاف فاصلها:
// دقّةٌ لم تنته أبداً (وعدٌ معلّق) لا تكتب، فيبقى آخر وقتٍ قديماً ويُرى.
//
// عملية API واحدة اليوم (حاوية واحدة): لا حاجة لقفل موزَّع، ولكلّ عملية صفوفها بمعرّفها.
// إن صارت أكثر من حاوية: الحلقات التي تكتب على حسابات (الطوابير، الإرسال) تحتاج قفلاً أو
// تقسيماً قبل ذلك — أما المهام فلها عقودها (tasks.ts lease) وتبقى كما هي.

import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { ensureOrgTables } from "./schema";

/** كما runtime.workerId، منسوخاً لا مستورداً: كل حلقة تستورد هذا الملف، وruntime يجرّ الطابور والتذاكر. */
const workerId = () => `${hostname()}:${process.pid}`.slice(0, 80);

export interface WorkerState {
  name: string; intervalMs: number; scope: string; startedAt: number; firstDueAt: number;
  lastTickAt: number | null; lastOkAt: number | null; lastError: string | null; lastErrorAt: number | null;
  lastDurationMs: number | null; ticks: number; errors: number; inFlight: number;
}
export interface EveryOpts {
  /** نطاق الحسابات: all (الافتراضي، يمرّ على كل الحسابات)، أو وصفٌ قصير (whatsapp_sessions …). */
  scope?: string;
  /** أول دقّة بعد هذا التأخير، ثم كل ms. بلا: أول دقّة بعد ms، كما setInterval. */
  firstMs?: number;
  /** لا يُبقي العملية حيّة (unref). الافتراضي false كما setInterval. */
  unref?: boolean;
}

const workers = new Map<string, WorkerState>();
const timers = new Map<string, { first?: NodeJS.Timeout; every?: NodeJS.Timeout }>();
/** أقصر فاصل يُقبل: حلقةٌ أسرع من هذا تملأ القاعدة كتابةً بلا فائدة. */
export const MIN_INTERVAL_MS = 1_000;
/** ضعف الفاصل الذي بعده تُعدّ الحلقة عالقة. */
export const WORKER_STUCK_FACTOR = 3;

const short = (e: unknown) => String((e as any)?.message ?? e).slice(0, 500);

async function persist(w: WorkerState): Promise<void> {
  if (!(await ensureOrgTables())) return;
  const ts = (n: number | null) => (n == null ? null : new Date(n).toISOString());
  await db.execute(sql`INSERT INTO worker_registry AS w (worker_id, name, interval_ms, scope, started_at, first_due_at, last_tick_at, last_ok_at, last_error, last_error_at, last_duration_ms, ticks, errors, updated_at)
    VALUES (${workerId()}, ${w.name}, ${w.intervalMs}, ${w.scope}, ${ts(w.startedAt)}::timestamptz, ${ts(w.firstDueAt)}::timestamptz, ${ts(w.lastTickAt)}::timestamptz, ${ts(w.lastOkAt)}::timestamptz,
      ${w.lastError}, ${ts(w.lastErrorAt)}::timestamptz, ${w.lastDurationMs}, ${w.ticks}, ${w.errors}, now())
    ON CONFLICT (worker_id, name) DO UPDATE SET interval_ms = EXCLUDED.interval_ms, scope = EXCLUDED.scope, started_at = EXCLUDED.started_at, first_due_at = EXCLUDED.first_due_at,
      last_tick_at = EXCLUDED.last_tick_at, last_ok_at = EXCLUDED.last_ok_at, last_error = EXCLUDED.last_error, last_error_at = EXCLUDED.last_error_at,
      last_duration_ms = EXCLUDED.last_duration_ms, ticks = EXCLUDED.ticks, errors = EXCLUDED.errors, updated_at = now()`);
}
const safePersist = (w: WorkerState) => persist(w).catch((err) => logger.warn({ worker: w.name, err: short(err).slice(0, 200) }, "سجل العامل لم يُكتب"));

/** دقّة واحدة: لا ترمي أبداً. القيم في الذاكرة مطلقة، فالكتابة تكرارها آمن. */
export async function tickOnce(w: WorkerState, fn: () => unknown): Promise<void> {
  const t0 = Date.now();
  w.lastTickAt = t0;
  w.inFlight++;
  try {
    await fn();
    w.lastOkAt = Date.now();
  } catch (err) {
    w.errors++;
    w.lastError = short(err);
    w.lastErrorAt = Date.now();
    logger.warn({ worker: w.name, err: w.lastError.slice(0, 200) }, "دقّة عامل فشلت");
  } finally {
    w.inFlight--;
    w.ticks++;
    w.lastDurationMs = Date.now() - t0;
  }
  await safePersist(w);
}

/**
 * setInterval مسجَّل. نفس الاسم مرتين في العملية: الثاني يُرفض بتحذير ويعيد مؤقّت الأول
 * — الحلقة لا تُضاعف. يعيد المؤقّت كما setInterval (أو مؤقّت التأخير الأول).
 */
export function everyMs(name: string, ms: number, fn: () => unknown, o: EveryOpts = {}): NodeJS.Timeout {
  const existing = timers.get(name);
  if (existing) {
    logger.warn({ worker: name }, "عاملٌ بالاسم نفسه مسجَّل — لم يُضاعف");
    return (existing.every ?? existing.first)!;
  }
  const interval = Math.max(MIN_INTERVAL_MS, Math.round(ms));
  const now = Date.now();
  const w: WorkerState = {
    name: name.slice(0, 80), intervalMs: interval, scope: (o.scope ?? "all").slice(0, 40), startedAt: now, firstDueAt: now + (o.firstMs ?? interval),
    lastTickAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, lastDurationMs: null, ticks: 0, errors: 0, inFlight: 0,
  };
  workers.set(name, w);
  const run = () => void tickOnce(w, fn);
  const slot: { first?: NodeJS.Timeout; every?: NodeJS.Timeout } = {};
  timers.set(name, slot);
  if (o.firstMs != null) {
    slot.first = setTimeout(() => {
      run();
      slot.every = setInterval(run, interval);
      if (o.unref) slot.every.unref();
    }, Math.max(0, o.firstMs));
    if (o.unref) slot.first.unref();
  } else {
    slot.every = setInterval(run, interval);
    if (o.unref) slot.every.unref();
  }
  // التسجيل يُكتب الآن إن أمكن؛ وإلا مع أول دقّة (الجداول قد لا تكون أُنشئت بعد).
  void safePersist(w);
  return (slot.first ?? slot.every)!;
}

/** للاختبار: يوقف حلقةً وينساها. */
export function stopWorker(name: string): void {
  const t = timers.get(name);
  if (t) { if (t.first) clearTimeout(t.first); if (t.every) clearInterval(t.every); }
  timers.delete(name); workers.delete(name);
}

export const workerStates = (): WorkerState[] => [...workers.values()];

// ── الحكم ─────────────────────────────────────────────────────────
export type WorkerHealth = "ok" | "failing" | "stuck" | "waiting";
export type WorkerRow = {
  worker_id: string; name: string; interval_ms: number; scope: string; started_at: string | Date; first_due_at: string | Date | null;
  last_tick_at: string | Date | null; last_ok_at: string | Date | null; last_error: string | null; last_error_at: string | Date | null;
  last_duration_ms: number | null; ticks: number | string; errors: number | string; updated_at?: string | Date;
};
const ms = (v: string | Date | null | undefined) => (v == null ? null : new Date(v).getTime());

/**
 * حال حلقة من صفّها. Pure.
 * stuck: آخر دقّة (أو موعد الأولى إن لم تدقّ بعد) أقدم من ثلاثة أضعاف الفاصل.
 * failing: آخر دقّة انتهت بخطأ (آخر خطأ بعد آخر نجاح). waiting: لم يحن موعد أول دقّة.
 */
export function workerHealth(r: WorkerRow, now = Date.now()): { health: WorkerHealth; lateMs: number } {
  const last = ms(r.last_tick_at) ?? ms(r.first_due_at) ?? ms(r.started_at)!;
  const lateMs = Math.max(0, now - last - Number(r.interval_ms));
  if (now - last > Number(r.interval_ms) * WORKER_STUCK_FACTOR) return { health: "stuck", lateMs };
  if (r.last_tick_at == null) return { health: "waiting", lateMs: 0 };
  const err = ms(r.last_error_at), ok = ms(r.last_ok_at);
  if (err != null && (ok == null || err >= ok)) return { health: "failing", lateMs };
  return { health: "ok", lateMs };
}

/** صفوف هذه العملية، بحالها. عمليات قديمة (قبل إعادة التشغيل) لا تُعرض ولا تُعدّ عالقة. */
export async function workerReport(now = Date.now()) {
  await ensureOrgTables();
  const r = await db.execute<WorkerRow>(sql`SELECT worker_id, name, interval_ms, scope, started_at, first_due_at, last_tick_at, last_ok_at, last_error, last_error_at,
      last_duration_ms, ticks, errors, updated_at FROM worker_registry WHERE worker_id = ${workerId()} ORDER BY name`);
  const workersOut = r.rows.map((x) => {
    const h = workerHealth(x, now);
    return {
      name: x.name, intervalSec: Math.round(Number(x.interval_ms) / 1000), scope: x.scope, health: h.health, lateSec: Math.round(h.lateMs / 1000),
      lastTickAt: x.last_tick_at, lastOkAt: x.last_ok_at, lastError: x.last_error, lastErrorAt: x.last_error_at, lastDurationMs: x.last_duration_ms == null ? null : Number(x.last_duration_ms),
      ticks: Number(x.ticks), errors: Number(x.errors),
    };
  });
  const count = (h: WorkerHealth) => workersOut.filter((w) => w.health === h).length;
  return {
    workerId: workerId(), total: workersOut.length, ok: count("ok"), failing: count("failing"), stuck: count("stuck"), waiting: count("waiting"),
    workers: workersOut,
    note: "عملية API واحدة: لا قفل موزَّع. العالقة: آخر دقّة أقدم من ثلاثة أضعاف فاصلها.",
  };
}

/** للحارس: الحلقات العالقة في هذه العملية. */
export async function stuckWorkers(now = Date.now()): Promise<Array<WorkerRow & { lateMs: number }>> {
  await ensureOrgTables();
  const r = await db.execute<WorkerRow>(sql`SELECT * FROM worker_registry WHERE worker_id = ${workerId()}`);
  return r.rows.map((x) => ({ ...x, lateMs: workerHealth(x, now).lateMs, h: workerHealth(x, now).health })).filter((x) => x.h === "stuck").map(({ h, ...x }) => x);
}

// ── تنظيف صفوف العمليات السابقة ───────────────────────────────────
// كل نشر عمليةٌ جديدة بمعرّفٍ جديد (الحاوية واسمها يتغيّران)، وصفوف القديمة تبقى: ١٠١ صفاً بعد
// أسابيع. لا يقرؤها أحد — workerReport وstuckWorkers (الجرد والحارس) يقرآن العملية الحالية
// وحدها — فحذفها لا يغيّر حكماً.
//
// يُحذف المعرّف كله أو لا شيء منه: عمليةٌ لم ينبض أيٌّ من صفوفها منذ ست ساعات. عمليةٌ شقيقة
// حية (حاويتان وقت النشر) لها حلقة دقيقة (provider_metrics_flush) تنبض كل دقيقة، فلا تُحذف
// صفوف حلقتها اليومية لأن صفها وحده قديم. وإن حُذف صفٌّ حيّ خطأً فالكتابة التالية تعيده (upsert).

/** بعد هذه المدة بلا نبض من أي صف لعمليةٍ ليست الحالية تُعدّ ميتة. */
export const WORKER_STALE_HOURS = 6;
/** فاصل التنظيف الدوري. */
export const WORKER_GC_MS = 60 * 60_000;

/** صفوف عمليات ليست الحالية ولم ينبض أيّ صفٍّ لها منذ `staleHours`: تُحذف. العملية الحية لا تُمسّ. */
export async function workerRetention(staleHours = WORKER_STALE_HOURS, current = workerId()): Promise<number> {
  if (!(await ensureOrgTables())) return 0;
  const r = await db.execute(sql`DELETE FROM worker_registry WHERE worker_id <> ${current} AND worker_id IN (
      SELECT worker_id FROM worker_registry WHERE worker_id <> ${current} GROUP BY worker_id
      HAVING max(updated_at) < now() - ${staleHours}::float8 * interval '1 hour')`);
  return r.rowCount ?? 0;
}

let gcStarted = false;
/** عند الإقلاع مرة، ثم كل ساعة. الخطأ يُسجَّل ولا يوقف شيئاً. */
export function startWorkerRegistryGc(): void {
  if (gcStarted) return;
  gcStarted = true;
  const run = async () => {
    const n = await workerRetention();
    if (n) logger.info({ deleted: n }, "حُذفت صفوف عمليات سابقة من سجل العمّال");
  };
  void run().catch((err) => logger.warn({ err: short(err).slice(0, 200) }, "تنظيف سجل العمّال فشل"));
  everyMs("org.worker_registry_gc", WORKER_GC_MS, run, { unref: true });
}
