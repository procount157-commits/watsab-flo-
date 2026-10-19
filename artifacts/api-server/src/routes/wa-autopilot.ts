// حملات واتساب التلقائية: الإعداد، التجارب، الموافقة، والتشغيل الآن.
import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, waAutopilotTestsTable, contactsTable, contactGroupsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { getConfig, saveConfig, runCycle, launchTest } from "../lib/wa-autopilot";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  const [config, tests] = await Promise.all([
    getConfig(userId),
    db.select().from(waAutopilotTestsTable).where(eq(waAutopilotTestsTable.userId, userId)).orderBy(desc(waAutopilotTestsTable.createdAt)).limit(30),
  ]);
  res.json({ config, tests });
});

router.put("/", async (req, res) => res.json(await saveConfig(req.session.userId!, req.body ?? {})));

/** The owner's yes to a written test: both halves go out now. */
router.post("/tests/:id/approve", async (req, res) => {
  const [t] = await db.select().from(waAutopilotTestsTable).where(and(eq(waAutopilotTestsTable.id, Number(req.params.id)), eq(waAutopilotTestsTable.userId, req.session.userId!))).limit(1);
  if (!t || t.status !== "awaiting_approval") return res.status(400).json({ error: "لا تجربة تنتظر الموافقة" });
  await launchTest(t);
  res.json({ ok: true, note: "انطلقت التجربة: النسختان تُرسلان الآن ضمن حدّ اليوم." });
});

router.post("/tests/:id/cancel", async (req, res) => {
  await db.update(waAutopilotTestsTable).set({ status: "cancelled" }).where(and(eq(waAutopilotTestsTable.id, Number(req.params.id)), eq(waAutopilotTestsTable.userId, req.session.userId!), eq(waAutopilotTestsTable.status, "awaiting_approval")));
  res.json({ ok: true });
});

/**
 * Clear a cancelled test from the record — one, or all of them. Only
 * cancelled ones: a test that ran is the autopilot's evidence. The lists it
 * made for its halves go with it; nothing was ever sent to them.
 */
async function removeCancelled(userId: number, id?: number) {
  const rows = await db.select().from(waAutopilotTestsTable).where(and(eq(waAutopilotTestsTable.userId, userId), eq(waAutopilotTestsTable.status, "cancelled"),
    ...(id ? [eq(waAutopilotTestsTable.id, id)] : [])));
  for (const t of rows) {
    const lists = ((t.variants as any[]) ?? []).filter((v) => v?.listId && !v?.campaignId).map((v) => Number(v.listId));
    if (lists.length) {
      await db.delete(contactsTable).where(inArray(contactsTable.groupId, lists));
      await db.delete(contactGroupsTable).where(and(eq(contactGroupsTable.userId, userId), inArray(contactGroupsTable.id, lists)));
    }
    await db.delete(waAutopilotTestsTable).where(eq(waAutopilotTestsTable.id, t.id));
  }
  return rows.length;
}
router.delete("/tests/cancelled", async (req, res) => res.json({ removed: await removeCancelled(req.session.userId!) }));
router.delete("/tests/:id", async (req, res) => {
  const n = await removeCancelled(req.session.userId!, Number(req.params.id));
  if (!n) return res.status(400).json({ error: "تُحذف التجارب الملغاة فقط" });
  res.json({ removed: n });
});

/** One cycle now: judge what finished, write the next test. */
router.post("/run", async (req, res) => res.json(await runCycle(req.session.userId!)));

export default router;
