// ── مكتب البيانات: ما صُنّف، بماذا، وآخر الجولات ───────────────────
import { Router, type IRouter } from "express";
import { deskOverview, runDesk, runDeskAll, type Channel } from "../lib/data-desk/desk";
import { targetsBrief } from "../lib/data-desk/classify";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();
router.use(requireAuth);

router.get("/", async (req, res) => res.json({ ...(await deskOverview(req.session.userId!)), targets: targetsBrief() }));

/** جولةٌ على قائمة — أو على القناة كلها — في الخلفية: فيها نداءات نموذج بفواصل. */
router.post("/run", async (req, res) => {
  const userId = req.session.userId!;
  const channel = (req.body?.channel === "email" ? "email" : "whatsapp") as Channel;
  const listId = Number(req.body?.listId) || null;
  const file = req.body?.file === true ? true : undefined;
  if (listId || channel === "email") {
    void runDesk(userId, { channel, listId, trigger: "owner", file }).catch((err) => req.log?.warn?.({ err: String(err?.message ?? err) }, "desk run failed"));
  } else {
    void runDeskAll(userId, channel, "owner").catch((err) => req.log?.warn?.({ err: String(err?.message ?? err) }, "desk run failed"));
  }
  res.json({ started: true, note: "بدأت الجولة: التنظيف ثم التصنيف. تظهر النتيجة هنا وفي غرفة الفريق خلال دقائق — المصنّف يقرأ الأسماء على دفعات." });
});

export default router;
