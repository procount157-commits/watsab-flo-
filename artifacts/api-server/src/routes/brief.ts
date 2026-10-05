// ── /api/brief — شمّة's morning brief ─────────────────────────────
import { Router } from "express";
import { db, briefSettingsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { briefSettings, composeBrief, sendBrief } from "../lib/morning-brief";

const router = Router();
router.use(requireAuth);
router.get("/", async (req, res) => {
  const [s, b] = await Promise.all([briefSettings(req.session.userId!), composeBrief(req.session.userId!)]);
  res.json({ settings: s, preview: b.text });
});
router.put("/settings", async (req, res) => {
  const b = req.body ?? {}, set: Record<string, unknown> = {};
  if (typeof b.enabled === "boolean") set["enabled"] = b.enabled;
  if (b.hour !== undefined) set["hour"] = Math.max(5, Math.min(12, Number(b.hour) || 8));
  const [row] = await db.insert(briefSettingsTable).values({ userId: req.session.userId!, ...(set as any) }).onConflictDoUpdate({ target: briefSettingsTable.userId, set }).returning();
  res.json(row);
});
router.post("/send", async (req, res) => {
  const r = await sendBrief(req.session.userId!);
  res.json({ ok: r.ok, note: r.ok ? "أُرسل على تيليجرام" : "تيليجرام غير مربوط — اربطه من الإعدادات ليصلك الموجز" });
});
export default router;
