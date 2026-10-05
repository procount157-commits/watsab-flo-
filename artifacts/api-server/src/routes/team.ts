// ── /api/team — every employee on one page ────────────────────────
import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { teamOverview, tryEmployee } from "../lib/team-overview";

const router = Router();
router.use(requireAuth);
router.get("/", async (req, res) => res.json(await teamOverview(req.session.userId!)));
router.post("/:role/try", async (req, res) => {
  const msg = String(req.body?.message ?? "").trim();
  if (!msg) return res.status(400).json({ error: "اكتب رسالة أو مهمة للتجربة" });
  try { res.json(await tryEmployee(req.session.userId!, String(req.params["role"]), msg)); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
export default router;
