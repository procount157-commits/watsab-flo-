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
import { employeeProfile, employeesList, orgOverview } from "../lib/org/overview";
import { latestScorecards, scoreAccount, type PeriodName } from "../lib/org/scorecards";
import { adminOverview, listReports, runCeoDaily } from "../lib/org/ceo";
import { readiness } from "../lib/org/readiness";
import { approveProposal, createProposal, getProposal, listProposals, ProposalRefused, rejectProposal, rollbackProposal } from "../lib/org/proposals";
import { providerReport } from "../lib/org/providers";
import { listPrices, PriceRefused, setPrices } from "../lib/org/prices";
import { workerReport } from "../lib/org/workers";
import { employeeOfTarget, shadowSummary } from "../lib/org/shadow";
import { bulkApprove } from "../lib/org/bulk";
import { OWNER_ACTION_TYPE, settleOwnerAction } from "../lib/org/tickets";

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
  // العمّال (الحلقات المتكررة) للمنصة كلها، لا لحساب: أسماؤها وحالها فقط، بلا بيانات حساب.
  const [employees, workers] = await Promise.all([orgRegistry(req.session.userId!), workerReport().catch(() => null)]);
  res.json({ employees, workers });
});
router.get("/workers", async (_req, res) => { res.json(await workerReport()); });

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
router.post("/tasks/:id/approve", taskAction(async (u, id) => {
  const t = await approveTask(u, id, u);
  // تذكرة مكالمة أو اجتماع: قرار صاحب الحساب هو المخرج، فتُكمَل ولا تدخل الطابور.
  return t?.taskType === OWNER_ACTION_TYPE ? (await settleOwnerAction(u, id, u)) ?? t : t;
}));
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

// ── الحد على ما يكلّف نموذجاً أو اتصالاً خارجياً ──
const hits = new Map<string, number>();
export const CEO_RUN_LIMIT_MS = 5 * 60_000;
export const READINESS_VERIFY_LIMIT_MS = 60_000;
/** كم بقي بالمللي ثانية، أو صفر ويُسجَّل الطلب. لكل حساب في هذه العملية. */
export function rateLimited(key: string, windowMs: number, now = Date.now()): number {
  const last = hits.get(key);
  if (last != null && now - last < windowMs) return windowMs - (now - last);
  hits.set(key, now);
  return 0;
}
/** للاختبار وحده. */
export const forgetRateLimits = () => hits.clear();

router.get("/overview", async (req, res) => {
  const [overview, w] = await Promise.all([orgOverview(req.session.userId!), workerReport().catch(() => null)]);
  res.json({ ...overview, workers: w ? { total: w.total, ok: w.ok, failing: w.failing, stuck: w.stuck, waiting: w.waiting,
    problems: w.workers.filter((x) => x.health === "stuck" || x.health === "failing").map((x) => ({ name: x.name, health: x.health, lastTickAt: x.lastTickAt, lastError: x.lastError, intervalSec: x.intervalSec })) } : null });
});
router.get("/employees", async (req, res) => { res.json({ employees: await employeesList(req.session.userId!) }); });
router.get("/employees/:key", async (req, res) => {
  const p = await employeeProfile(req.session.userId!, String(req.params["key"]).slice(0, 60));
  if (!p) return res.status(404).json({ error: "لا موظف بهذا المفتاح في حسابك" });
  res.json(p);
});

const PERIODS: PeriodName[] = ["weekly", "monthly"];
router.get("/scorecards", async (req, res) => {
  const userId = req.session.userId!;
  const period = String(req.query["period"] ?? "weekly") as PeriodName;
  if (!PERIODS.includes(period)) return res.status(400).json({ error: "period: weekly أو monthly" });
  const employee = req.query["employee"] ? String(req.query["employee"]).slice(0, 60) : null;
  let cards = await latestScorecards(userId, period, employee);
  if (!cards.length) {
    // لم يمرّ العامل اليومي بعد: تُحسب الآن مرةً وتُحفظ.
    await scoreAccount(userId, [period]);
    cards = (await latestScorecards(userId, period, employee)).map((c) => ({ ...c, live: true }));
  }
  res.json({ period, scorecards: cards });
});

router.get("/ceo/reports", async (req, res) => {
  const userId = req.session.userId!;
  const limit = Number(req.query["limit"]) || 30;
  const [{ hired }] = (await db.execute<{ hired: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM bot_employees WHERE user_id = ${userId} AND role = 'ceo_agent') AS hired`)).rows as any[];
  res.json({ reports: await listReports(userId, limit), employee: { key: "executive.ceo", hired: !!hired } });
});
router.post("/ceo/run", async (req, res) => {
  const userId = req.session.userId!;
  const wait = rateLimited(`ceo:${userId}`, CEO_RUN_LIMIT_MS);
  if (wait) return res.status(429).json({ error: "شُغّل قبل قليل", retryAfterSec: Math.ceil(wait / 1000) });
  res.json(await runCeoDaily(userId));
});

router.get("/readiness", async (req, res) => {
  const userId = req.session.userId!;
  const asked = req.query["verify"] === "1" || req.query["verify"] === "true";
  // تجاوز الحد لا يخطئ: يعود الفحص بلا اتصال، وما يحتاجه NEEDS_TEST.
  const verify = asked && !rateLimited(`readiness:${userId}`, READINESS_VERIFY_LIMIT_MS);
  res.json(await readiness(userId, { verify }));
});

router.get("/proposals", async (req, res) => {
  res.json({ proposals: await listProposals(req.session.userId!, { status: req.query["status"] ? String(req.query["status"]) : undefined, target: req.query["target"] ? String(req.query["target"]) : undefined, limit: Number(req.query["limit"]) || 100 }) });
});
const refused = (res: any, err: unknown) => {
  if (err instanceof ProposalRefused) return res.status(err.status).json({ error: err.message });
  throw err;
};
router.post("/proposals", async (req, res) => {
  const b = (req.body ?? {}) as { target?: unknown; category?: unknown; reason?: unknown; newValue?: unknown; evidence?: unknown; impact?: unknown };
  if (typeof b.target !== "string" || !b.target.trim() || typeof b.reason !== "string" || !b.reason.trim()) return res.status(400).json({ error: "target وreason مطلوبان" });
  if (!b.target.startsWith("prompt:") && typeof b.category !== "string") return res.status(400).json({ error: "category مطلوبة" });
  try {
    const proposal = await createProposal({ userId: req.session.userId!, requestedBy: `user:${req.session.userId!}`, target: b.target, category: typeof b.category === "string" ? b.category : null, reason: b.reason, newValue: b.newValue, evidence: b.evidence, impact: typeof b.impact === "string" ? b.impact : null });
    res.status(201).json({ proposal });
  } catch (err) { refused(res, err); }
});
const proposalId = (req: any, res: any): number | null => {
  const id = Number(req.params["id"]);
  if (Number.isInteger(id) && id > 0) return id;
  res.status(400).json({ error: "رقم مقترح غير صالح" });
  return null;
};
router.get("/proposals/:id", async (req, res) => {
  const id = proposalId(req, res);
  if (id == null) return;
  const proposal = await getProposal(req.session.userId!, id);
  if (!proposal) return res.status(404).json({ error: "ليس لهذا الحساب" });
  // الظل (lib/org/shadow.ts): آخر مقارنة للتعليمات المقترحة على مدخلات الحساب، وإنذاراتها.
  const key = employeeOfTarget(proposal.target);
  res.json({ proposal, shadow: key ? await shadowSummary(req.session.userId!, { proposalId: id }) : null });
});
// «اعتماد كل المؤهل»: GET يعرض ما سيحدث بلا تغيير، وPOST يعتمد ما يجتاز بوابته فقط (lib/org/bulk.ts).
// حساب الجلسة وحده، والفاعل في كل سطر تدقيق صاحب الجلسة. لا يمسّ أوضاع الإرسال ولا الحدود ولا الدروس.
router.get("/approvals/bulk", async (req, res) => {
  const userId = req.session.userId!;
  res.json(await bulkApprove(userId, userId, { dryRun: true }));
});
router.post("/approvals/bulk", async (req, res) => {
  const userId = req.session.userId!;
  if (req.body?.confirm !== true) return res.status(400).json({ error: "التأكيد مطلوب (confirm: true)" });
  res.json(await bulkApprove(userId, userId));
});
router.post("/proposals/:id/approve", async (req, res) => {
  const id = proposalId(req, res);
  if (id == null) return;
  const userId = req.session.userId!;
  try { res.json(await approveProposal(userId, id, userId)); } catch (err) { refused(res, err); }
});
router.post("/proposals/:id/reject", async (req, res) => {
  const id = proposalId(req, res);
  if (id == null) return;
  const userId = req.session.userId!;
  try { res.json({ proposal: await rejectProposal(userId, id, userId, req.body?.reason ? String(req.body.reason) : null) }); } catch (err) { refused(res, err); }
});
router.post("/proposals/:id/rollback", async (req, res) => {
  const id = proposalId(req, res);
  if (id == null) return;
  const userId = req.session.userId!;
  try { res.json({ proposal: await rollbackProposal(userId, id, userId) }); } catch (err) { refused(res, err); }
});

router.get("/providers", async (req, res) => { res.json(await providerReport(req.session.userId!, Number(req.query["days"]) || 7)); });
// الأسعار عامة لكل الحسابات: يقرؤها الجميع، ويضعها المالك (المدير) وحده، ولكل سعر مصدره.
router.get("/providers/prices", async (req, res) => { res.json({ prices: await listPrices(), canEdit: !!req.session.isAdmin }); });
router.put("/providers/prices", async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: "للمالك وحده" });
  try {
    const rows = Array.isArray(req.body?.prices) ? req.body.prices : req.body && typeof req.body === "object" && req.body.provider ? [req.body] : null;
    res.json({ prices: await setPrices(req.session.userId!, rows as any) });
  } catch (err) {
    if (err instanceof PriceRefused) return res.status(400).json({ error: err.message });
    throw err;
  }
});

/** أعداد المنصة للمدير: لا اسم ولا محتوى حساب. */
router.get("/admin/overview", async (req, res) => {
  if (!req.session.isAdmin) return res.status(403).json({ error: "للمدير وحده" });
  res.json(await adminOverview());
});

export default router;
