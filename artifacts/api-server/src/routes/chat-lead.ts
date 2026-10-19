// مسؤول الشات: دليل الأسبوع، وتشغيله الآن.
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, agentMemoryTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { runChatLead } from "../lib/chat-lead";

const router = Router();
router.use(requireAuth);

/** The handbook each reader has now. */
router.get("/", async (req, res) => {
  const rows = await db.select({ role: agentMemoryTable.role, content: agentMemoryTable.content, at: agentMemoryTable.updatedAt })
    .from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.kind, "playbook")));
  res.json({ handbooks: rows });
});

/** Read this week's conversations and write the handbook now (one model call). */
router.post("/run", async (req, res) => res.json(await runChatLead(req.session.userId!)));

export default router;
