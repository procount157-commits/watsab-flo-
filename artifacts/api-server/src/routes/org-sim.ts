// ── المحاكاة والظل والسيناريو التجريبي ─────────────────────────────
// كل شيء على حساب الجلسة وحده. لا شيء هنا يرسل أو يفعّل: الظل يقارن، والسيناريو يجري
// داخل المحاكاة حيث ترفض البوابة كل إرسال.

import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { e2eRun, e2eRuns, runE2e } from "../lib/org/sandbox-e2e";
import { autoApplyLowRisk } from "../lib/org/auto-apply";
import { callsToday, runShadow, SHADOW_DAILY_CALLS, SHADOW_KEYS, shadowResults, shadowSummary } from "../lib/org/shadow";

const router = Router();
router.use(requireAuth);

const running = new Set<string>();
/** تشغيلٌ واحد لكل حساب ونوع في الوقت نفسه: ضغطتان لا تضاعفان النداءات. */
async function once<T>(key: string, fn: () => Promise<T>): Promise<T | null> {
  if (running.has(key)) return null;
  running.add(key);
  try { return await fn(); } finally { running.delete(key); }
}

router.get("/status", async (req, res) => {
  const userId = req.session.userId!;
  res.json({ dailyCalls: SHADOW_DAILY_CALLS, usedToday: await callsToday(userId), wired: SHADOW_KEYS, schedule: "أيام العمل 06:30 دبي" });
});

router.post("/shadow/run", async (req, res) => {
  const userId = req.session.userId!;
  const key = typeof req.body?.employeeKey === "string" && req.body.employeeKey.trim() ? req.body.employeeKey.trim().slice(0, 60) : null;
  const r = await once(`shadow:${userId}`, () => runShadow(userId, { employeeKey: key, trigger: "manual" }));
  if (!r) return res.status(409).json({ error: "ظلٌّ يعمل الآن لهذا الحساب" });
  // المرحلة ٥: الداخلي منخفض الخطر الذي اجتاز الظل يُفعَّل بعد التشغيل، ويُقال ما فُعّل.
  const autoApplied = await autoApplyLowRisk(userId, { trigger: "manual" });
  res.json({ ...r, autoApplied });
});

router.get("/shadow/results", async (req, res) => {
  const userId = req.session.userId!;
  const employeeKey = typeof req.query["employeeKey"] === "string" ? String(req.query["employeeKey"]) : null;
  const proposalId = req.query["proposalId"] ? Number(req.query["proposalId"]) : null;
  if (proposalId != null && !Number.isInteger(proposalId)) return res.status(400).json({ error: "proposalId رقم" });
  const [results, summary] = await Promise.all([
    shadowResults(userId, { employeeKey, proposalId, limit: Number(req.query["limit"] ?? 100) || 100 }),
    employeeKey || proposalId ? shadowSummary(userId, { employeeKey, proposalId }) : Promise.resolve(null),
  ]);
  res.json({ results, summary });
});

router.post("/e2e/run", async (req, res) => {
  const userId = req.session.userId!;
  try {
    const r = await once(`e2e:${userId}`, () => runE2e(userId));
    if (!r) return res.status(409).json({ error: "سيناريو يعمل الآن لهذا الحساب" });
    res.json(r);
  } catch (err: any) {
    res.status(409).json({ error: String(err?.message ?? err).slice(0, 300) });
  }
});

router.get("/e2e/runs", async (req, res) => {
  res.json({ runs: await e2eRuns(req.session.userId!) });
});

router.get("/e2e/runs/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "رقم غير صالح" });
  const r = await e2eRun(req.session.userId!, id);
  if (!r) return res.status(404).json({ error: "ليس لهذا الحساب" });
  res.json(r);
});

export default router;
