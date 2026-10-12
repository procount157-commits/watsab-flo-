// ── The engineer's desk: the owner's chat with the one above the team ──
import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { chat, listThreads, threadMessages, engineerContext, ensureEngineer } from "../lib/graph/engineer";

const router = Router();
router.use(requireAuth);

router.get("/threads", async (req, res) => res.json(await listThreads(req.session.userId!)));
router.get("/threads/:id", async (req, res) => res.json(await threadMessages(req.session.userId!, Number(req.params.id))));
router.get("/context", async (req, res) => { await ensureEngineer(req.session.userId!); res.json({ context: await engineerContext(req.session.userId!) }); });
router.post("/chat", async (req, res) => {
  const message = String(req.body?.message ?? "").trim();
  if (!message) return res.status(400).json({ error: "اكتب رسالة" });
  const threadId = req.body?.threadId ? Number(req.body.threadId) : null;
  res.json(await chat(req.session.userId!, Number.isFinite(threadId!) && threadId ? threadId : null, message.slice(0, 4000)));
});

export default router;
