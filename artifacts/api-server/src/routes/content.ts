// ── /api/content — the weekly content calendar ────────────────────
import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { CHANNELS, calendar, deletePlan, makePlan } from "../lib/content/plans";

const router = Router();
router.use(requireAuth);
const iso = (d: Date) => d.toISOString().slice(0, 10);

router.get("/", async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query["from"])) ? String(req.query["from"]) : iso(new Date());
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query["to"])) ? String(req.query["to"]) : iso(new Date(Date.now() + 6 * 86_400_000));
  res.json({ plans: await calendar(req.session.userId!, from, to), channels: CHANNELS });
});
router.post("/", async (req, res) => {
  const b = req.body ?? {}, topic = String(b.topic ?? "").trim();
  if (topic.length < 4) return res.status(400).json({ error: "اكتب الموضوع" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.publishOn))) return res.status(400).json({ error: "اختر يوم النشر" });
  try { res.json(await makePlan(req.session.userId!, { topic, publishOn: b.publishOn, channels: Array.isArray(b.channels) ? b.channels : [...CHANNELS], notes: b.notes ?? null })); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.delete("/:id", async (req, res) => { await deletePlan(req.session.userId!, Number(req.params["id"])); res.json({ ok: true }); });
export default router;
