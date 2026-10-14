// ── /api/team — every employee on one page ────────────────────────
import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { teamOverview, tryEmployee } from "../lib/team-overview";
import { teamRoom, employeeDetail, ownerSays } from "../lib/team/room";
import { runWaManagerCycle, waManagerState } from "../lib/wa-manager";

const router = Router();
router.use(requireAuth);
router.get("/", async (req, res) => res.json(await teamOverview(req.session.userId!)));
// ── غرفة الفريق: الكل، وكلامهم لبعض، ومن يصمت ──
router.get("/room", async (req, res) => res.json(await teamRoom(req.session.userId!, { days: Math.min(30, Math.max(1, Number(req.query["days"]) || 7)) })));
router.get("/room/:role", async (req, res) => res.json(await employeeDetail(req.session.userId!, String(req.params["role"]))));
/** صاحب العمل يكتب لموظف: توجيهٌ يدخل تعليماته في عمله التالي. */
router.post("/room/:role/say", async (req, res) => {
  const body = String(req.body?.body ?? "").trim();
  if (body.length < 3) return res.status(400).json({ error: "اكتب التوجيه" });
  await ownerSays(req.session.userId!, String(req.params["role"]), body);
  res.json({ ok: true });
});

// ── مديرة الواتساب ──
router.get("/wa-manager", async (req, res) => res.json(await waManagerState(req.session.userId!)));
router.post("/wa-manager/run", async (req, res) => {
  const userId = req.session.userId!;
  void runWaManagerCycle(userId, { brief: true, notifyOwner: req.body?.notify !== false })
    .catch((err) => req.log?.warn?.({ err: String(err?.message ?? err) }, "wa manager cycle failed"));
  res.json({ started: true, note: "بدأت دورة شمّة: البيانات ← النتائج ← تقييم كل موظف ← المهام ← التقرير. تأخذ دقائق — المصنّف يقرأ الأسماء على دفعات." });
});

router.post("/:role/try", async (req, res) => {
  const msg = String(req.body?.message ?? "").trim();
  if (!msg) return res.status(400).json({ error: "اكتب رسالة أو مهمة للتجربة" });
  try { res.json(await tryEmployee(req.session.userId!, String(req.params["role"]), msg)); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
export default router;
