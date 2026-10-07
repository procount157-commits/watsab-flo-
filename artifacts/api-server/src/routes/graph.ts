// ── The graph, for the owner ──────────────────────────────────────
// GET   /api/graph            goals and their pace, what each employee did
//                             (today and 14 days), the ledger's integrity,
//                             the contracts, and whether the team is on.
// GET   /api/graph/receipts   the ledger itself, newest first, filterable.
// PATCH /api/graph/team       { paused } — the whole team's off switch.
// POST  /api/graph/goals      the owner sets a goal; employees cannot.
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { goalsWithProgress, setGoal, MEASURES } from "../lib/graph/goals";
import { whoDidWhat } from "../lib/graph/backfill";
import { firstBroken } from "../lib/graph/receipts";
import { setTeamPaused } from "../lib/graph/switch";
import { GRAPHS, contractProblems } from "../lib/graph/contracts";
import { liveGraph, doing } from "../lib/graph/live";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  const [goals, today, fortnight, broken, paused, totals] = await Promise.all([
    goalsWithProgress(userId),
    whoDidWhat(userId, 1),
    whoDidWhat(userId, 14),
    firstBroken(userId).catch(() => -1),
    db.execute<{ p: boolean }>(sql`SELECT team_paused AS p FROM business_profile WHERE user_id = ${userId}`),
    db.execute(sql`SELECT count(*)::int AS receipts, count(*) FILTER (WHERE NOT inferred)::int AS live, min(at) AS since FROM receipts WHERE user_id = ${userId}`),
  ]);
  res.json({
    goals, today, fortnight,
    ledger: { firstBroken: broken, ...(totals.rows[0] as any) },
    teamPaused: !!paused.rows[0]?.p,
    graphs: GRAPHS.map((g) => ({ id: g.id, oneBreath: g.oneBreath, nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, responsibility: n.responsibility })), edges: g.edges, problems: contractProblems(g) })),
    measures: Object.entries(MEASURES).map(([key, m]) => ({ key, label: m.label })),
  });
});

// The living map: desks, employees, the lines between them, and the latest receipts.
router.get("/live", async (req, res) => res.json(await liveGraph(req.session.userId!)));

router.get("/receipts", async (req, res) => {
  const userId = req.session.userId!;
  const node = typeof req.query["node"] === "string" ? req.query["node"] : null;
  const status = typeof req.query["status"] === "string" ? req.query["status"] : null;
  const limit = Math.min(300, Number(req.query["limit"]) || 100);
  const r = await db.execute(sql`SELECT id, at, graph, node, action, status, subject, model, tokens_in, tokens_out, edge, why, inferred
    FROM receipts WHERE user_id = ${userId} ${node ? sql`AND node = ${node}` : sql``} ${status ? sql`AND status = ${status}` : sql``}
    ORDER BY id DESC LIMIT ${limit}`);
  res.json(r.rows.map((x: any) => ({ ...x, label: doing(x.action, x.status) })));
});

router.patch("/team", async (req, res) => {
  const paused = !!(req.body as any)?.paused;
  await setTeamPaused(req.session.userId!, paused);
  res.json({ paused });
});

router.post("/goals", async (req, res) => {
  const b = req.body as any;
  const target = Math.floor(Number(b?.target)), deadline = new Date(b?.deadline);
  if (!b?.title || !MEASURES[b?.metric] || !(target > 0) || isNaN(deadline.getTime())) return res.status(400).json({ error: "العنوان والمقياس والرقم والموعد مطلوبة" });
  res.json({ id: await setGoal(req.session.userId!, { title: String(b.title).slice(0, 200), metric: b.metric, target, deadline, counters: Array.isArray(b.counters) ? b.counters : ["stops", "email_bounce_pct"], anchor: "clients_won" }) });
});

export default router;
