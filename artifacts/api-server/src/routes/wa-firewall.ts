// جدار الحماية من الحظر: الحالة، التجميد اليدوي ورفعه، والإعدادات.
import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { status, setManual, setSettings, freeze } from "../lib/wa-firewall";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => res.json(await status(req.session.userId!)));

/** The owner's own switch: freeze now, or lift the manual freeze. An automatic freeze runs its course. */
router.post("/freeze", async (req, res) => {
  await setManual(req.session.userId!, true);
  res.json(await status(req.session.userId!));
});
router.post("/lift", async (req, res) => {
  await setManual(req.session.userId!, false);
  res.json(await status(req.session.userId!));
});
/** A freeze the owner asks for with a span — after a restriction notice from WhatsApp, say. */
router.post("/freeze-hours", async (req, res) => {
  const hours = Math.min(24 * 14, Math.max(1, Number(req.body?.hours ?? 72)));
  await freeze(req.session.userId!, hours, String(req.body?.why ?? "تجميد بطلب صاحب العمل").slice(0, 200));
  res.json(await status(req.session.userId!));
});
router.put("/", async (req, res) => {
  await setSettings(req.session.userId!, { coldDailyCap: req.body?.coldDailyCap, interactiveAllowed: req.body?.interactiveAllowed });
  res.json(await status(req.session.userId!));
});

export default router;
