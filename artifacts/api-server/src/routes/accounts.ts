// ── مكتب الحسابات المستهدفة ───────────────────────────────────────
// العقد الذي تبني عليه الواجهة (artifacts/whatsapp-blast) — لا يتغيّر شكله.

import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { deskSettings, settingsView, updateSettings, startRun, todayView, listAccounts, markAccount } from "../lib/accounts/desk";
import { TARGET_STATUSES } from "@workspace/db";

const router = Router();
router.use(requireAuth);

const uid = (req: any) => req.session.userId! as number;
const fail = (res: any, e: any) => res.status(e?.status ?? 500).json({ error: String(e?.message ?? e) });

router.get("/today", async (req, res) => {
  try { res.json(await todayView(uid(req))); } catch (e) { fail(res, e); }
});

router.get("/settings", async (req, res) => {
  try { res.json(settingsView(await deskSettings(uid(req)))); } catch (e) { fail(res, e); }
});

router.put("/settings", async (req, res) => {
  try { res.json(await updateSettings(uid(req), req.body ?? {})); } catch (e) { fail(res, e); }
});

router.post("/run", async (req, res) => {
  try { res.json(await startRun(uid(req), { manual: true })); } catch (e) { fail(res, e); }
});

router.get("/", async (req, res) => {
  try {
    const status = typeof req.query["status"] === "string" && (TARGET_STATUSES as readonly string[]).includes(req.query["status"]) ? req.query["status"] : undefined;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query["limit"] ?? "50")) || 50));
    const offset = Math.max(0, parseInt(String(req.query["offset"] ?? "0")) || 0);
    res.json(await listAccounts(uid(req), { status, limit, offset }));
  } catch (e) { fail(res, e); }
});

const action = (what: "linkedin" | "skip" | "meeting") => async (req: any, res: any) => {
  try {
    const id = parseInt(String(req.params.id));
    if (!Number.isFinite(id)) return res.status(400).json({ error: "معرّف غير صالح" });
    if (!(await markAccount(uid(req), id, what))) return res.status(404).json({ error: "الشركة غير موجودة" });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
};
router.post("/:id/linkedin-done", action("linkedin"));
router.post("/:id/skip", action("skip"));
router.post("/:id/meeting", action("meeting"));

export default router;
