// ── مفاتيح الإيقاف وسجلّها ────────────────────────────────────────
// صاحب الحساب يرى مفاتيحه ويضعها على حسابه. المنصة كلها والمفاتيح العامة للمدير
// وحده (session.isAdmin، كما في routes/admin.ts).

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { audit, controlScopeFor, setControl } from "../lib/org/controls";
import { ensureOrgTables } from "../lib/org/schema";
import { orgRegistry } from "../lib/org/registry";
import { approveTask, cancelTask, listTasks, rejectTask, retryTask } from "../lib/org/tasks";
import { watchdogFindings } from "../lib/org/watchdog";
import { applyQueueReview, queueReview, releaseStale } from "../lib/org/queue";

const router = Router();
router.use(requireAuth);

router.get("/controls", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const r = await db.execute(sql`SELECT id, scope, user_id, target, engaged, reason, set_by, set_at FROM org_controls
    WHERE user_id = ${userId} OR user_id IS NULL ${req.session.isAdmin && req.query["all"] ? sql`OR true` : sql``} ORDER BY set_at DESC`);
  res.json({ controls: r.rows, isAdmin: !!req.session.isAdmin });
});

router.put("/controls", async (req, res) => {
  const userId = req.session.userId!;
  const b = (req.body ?? {}) as { scope?: string; target?: string; engaged?: unknown; reason?: string; userId?: unknown; platformWide?: unknown };
  if (typeof b.engaged !== "boolean") return res.status(400).json({ error: "engaged: true أو false" });
  const v = controlScopeFor({ scope: String(b.scope ?? ""), target: b.target, engaged: b.engaged, reason: b.reason }, {
    userId, isAdmin: !!req.session.isAdmin, platformWide: b.platformWide === true,
    forUserId: b.userId === undefined ? null : Number(b.userId),
  });
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  await setControl({ scope: v.scope, userId: v.userId, target: v.target, engaged: b.engaged, reason: b.reason?.slice(0, 500) ?? null, actor: userId });
  res.json({ ok: true, scope: v.scope, target: v.target, userId: v.userId, engaged: b.engaged });
});

router.get("/audit", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 100, 1), 500);
  // المدير يرى كل شيء بطلبه؛ غيره سجلّ حسابه فقط — لا صفوف المنصة ولا حساب غيره.
  const r = await db.execute(sql`SELECT id, user_id, action, scope, channel, kind, recipient, role, actor, why, count, meta, created_at FROM org_audit_log
    WHERE ${req.session.isAdmin && req.query["all"] ? sql`true` : sql`user_id = ${userId}`} ORDER BY id DESC LIMIT ${limit}`);
  res.json({ audit: r.rows });
});

// ── التشغيل: الجرد، النبض، المهام، الحارس. كلٌّ مقيَّد بحساب الجلسة. ──
router.get("/inventory", async (req, res) => {
  res.json({ employees: await orgRegistry(req.session.userId!) });
});

router.get("/heartbeats", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const r = await db.execute(sql`SELECT employee_key, status, last_beat_at AS last_heartbeat_at, last_started_at, last_completed_at, last_success_at, last_failure_at,
      consecutive_failures, last_error, last_execution_id, worker_id, next_beat_at AS next_run_at, interval_sec, detail
    FROM employee_heartbeats WHERE user_id = ${userId} ORDER BY employee_key`);
  res.json({ heartbeats: r.rows });
});

router.get("/tasks", async (req, res) => {
  const limit = Number(req.query["limit"]) || 100;
  res.json({ tasks: await listTasks(req.session.userId!, { status: req.query["status"] ? String(req.query["status"]) : undefined, limit }) });
});

const taskAction = (act: (userId: number, id: number, reason: string | null) => Promise<unknown>) => async (req: any, res: any) => {
  const id = Number(req.params["id"]);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "رقم مهمة غير صالح" });
  const task = await act(req.session.userId!, id, req.body?.reason ? String(req.body.reason).slice(0, 500) : null);
  if (!task) return res.status(409).json({ error: "المهمة ليست لهذا الحساب أو حالتها لا تسمح" });
  res.json({ task });
};
router.post("/tasks/:id/approve", taskAction((u, id) => approveTask(u, id, u)));
router.post("/tasks/:id/reject", taskAction((u, id, why) => rejectTask(u, id, u, why)));
router.post("/tasks/:id/cancel", taskAction((u, id, why) => cancelTask(u, id, u, why)));
router.post("/tasks/:id/retry", taskAction((u, id) => retryTask(u, id, u)));

router.get("/watchdog", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const [findings, raised] = await Promise.all([
    watchdogFindings(userId),
    db.execute(sql`SELECT kind, why, meta, created_at FROM org_audit_log WHERE user_id = ${userId} AND action = 'watchdog.finding' ORDER BY id DESC LIMIT 100`),
  ]);
  res.json({ findings, raised: raised.rows });
});

router.get("/queue-review", async (req, res) => { res.json(await queueReview(req.session.userId!)); });
/** يلغي غير المؤهل بوضوح فقط (ردّ، طلب إيقاف، ارتدّ، ردّت شركته). لا يعمل وحده أبداً. */
router.post("/queue-review/apply", async (req, res) => {
  const userId = req.session.userId!;
  res.json({ cancelled: await applyQueueReview(userId, userId) });
});

/** يفرج عمّا انتظر أكثر من أسبوع بعد إعادة تقييمه. النطاق حملةٌ أو مهمةٌ أو الحساب كله. */
router.post("/queue-review/release", async (req, res) => {
  const userId = req.session.userId!;
  const id = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
  const b = req.body ?? {};
  if ((b.campaignId !== undefined && !id(b.campaignId)) || (b.missionId !== undefined && !id(b.missionId))) return res.status(400).json({ error: "رقم غير صالح" });
  res.json(await releaseStale(userId, { campaignId: id(b.campaignId), missionId: id(b.missionId) }, userId));
});

router.get("/workflows", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 50, 1), 200);
  const flows = await db.execute<any>(sql`SELECT id, workflow, status, input, output, error, started_at, finished_at FROM workflow_executions WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${limit}`);
  const ids = flows.rows.map((f: any) => Number(f.id));
  const events = ids.length ? await db.execute<any>(sql`SELECT workflow_id, employee_key, event, detail, created_at FROM execution_events WHERE user_id = ${userId} AND workflow_id IN (${sql.join(ids.map((i: number) => sql`${i}`), sql`, `)}) ORDER BY id`) : { rows: [] as any[] };
  res.json({ workflows: flows.rows.map((f: any) => ({ ...f, steps: events.rows.filter((e: any) => Number(e.workflow_id) === Number(f.id)) })) });
});

/** الدروس التي كتبها نموذج ولم تعتمد: لا تدخل أي prompt حتى يوافق عليها صاحب العمل. */
router.get("/lessons/pending", async (req, res) => {
  const r = await db.execute(sql`SELECT id, role, kind, content, topic, times, created_at FROM agent_memory WHERE user_id = ${req.session.userId!} AND approval_status = 'pending' ORDER BY id DESC LIMIT 200`);
  res.json({ lessons: r.rows });
});
const lessonVerdict = (status: "approved" | "rejected") => async (req: any, res: any) => {
  const userId = req.session.userId!;
  const r = await db.execute(sql`UPDATE agent_memory SET approval_status = ${status}, last_verified_at = now() WHERE id = ${Number(req.params["id"])} AND user_id = ${userId} AND approval_status = 'pending' RETURNING id, role`);
  if (!r.rows.length) return res.status(409).json({ error: "الدرس ليس لهذا الحساب أو ليس معلّقاً" });
  await audit({ userId, action: `lesson.${status}`, role: String((r.rows[0] as any).role), actor: userId, meta: { id: Number(req.params["id"]) } }).catch(() => {});
  res.json({ ok: true, status });
};
router.post("/lessons/:id/approve", lessonVerdict("approved"));
router.post("/lessons/:id/reject", lessonVerdict("rejected"));

export default router;
