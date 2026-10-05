// ── WhatsApp groups section ───────────────────────────────────────
// The owner's customer groups: kept, filed, understood, and answered only by
// the owner — the groups agent's replies are suggestions on this page.

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, waGroupsTable, waGroupMessagesTable, waGroupSuggestionsTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { getSocket, registerOnConnectHook } from "../lib/whatsapp";
import { FILES_ROOT, backfill, folderFor, oldestMessage, syncGroups } from "../lib/groups/store";
import { accuracy, buildProfile, ensureGroupsAgent, feedback, suggestFor } from "../lib/groups/assistant";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

// Every connect: the list of groups, their names and sizes, fresh.
registerOnConnectHook((userId) => {
  setTimeout(() => { void syncGroups(userId, getSocket(userId)).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "group sync failed")); }, 20_000);
});

async function own(userId: number, id: number) {
  const [g] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.id, id), eq(waGroupsTable.userId, userId))).limit(1);
  return g ?? null;
}

router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  await ensureGroupsAgent(userId);
  const rows = await db.execute<any>(sql`
    SELECT g.*,
      (SELECT count(*) FROM wa_group_suggestions s WHERE s.user_id = g.user_id AND s.group_jid = g.jid AND s.status = 'pending')::int AS pending,
      (SELECT count(*) FROM wa_group_messages m WHERE m.user_id = g.user_id AND m.group_jid = g.jid AND m.file_path IS NOT NULL)::int AS files,
      (SELECT json_build_object('text', m.text, 'type', m.msg_type, 'fromMe', m.from_me, 'name', m.sender_name)
         FROM wa_group_messages m WHERE m.user_id = g.user_id AND m.group_jid = g.jid ORDER BY m.created_at DESC LIMIT 1) AS last
    FROM wa_groups g WHERE g.user_id = ${userId}
    ORDER BY g.watch DESC, g.last_message_at DESC NULLS LAST, g.subject`);
  res.json(rows.rows);
});

router.get("/stats", async (req, res) => {
  const userId = req.session.userId!;
  const [[c], acc] = await Promise.all([
    db.execute<any>(sql`SELECT
      (SELECT count(*) FROM wa_groups WHERE user_id = ${userId})::int AS groups,
      (SELECT count(*) FROM wa_groups WHERE user_id = ${userId} AND watch)::int AS watched,
      (SELECT count(*) FROM wa_group_messages WHERE user_id = ${userId})::int AS messages,
      (SELECT count(*) FROM wa_group_messages WHERE user_id = ${userId} AND file_path IS NOT NULL)::int AS files,
      (SELECT count(*) FROM wa_group_messages WHERE user_id = ${userId} AND created_at > now() - interval '1 day')::int AS today`).then((r) => r.rows),
    accuracy(userId),
  ]);
  res.json({ ...c, accuracy: acc, folder: FILES_ROOT, connected: !!getSocket(userId) });
});

/** Names and members from WhatsApp, now. */
router.post("/sync", async (req, res) => {
  const sock = getSocket(req.session.userId!);
  if (!sock) return res.status(400).json({ error: "واتساب غير متصل — اربط الرقم أولاً" });
  try { res.json({ groups: await syncGroups(req.session.userId!, sock) }); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

router.patch("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const g = await own(userId, Number(req.params.id));
  if (!g) return res.status(404).json({ error: "القروب غير موجود" });
  const b = req.body ?? {}, set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.watch === "boolean") set["watch"] = b.watch;
  if (typeof b.isCustomer === "boolean") set["isCustomer"] = b.isCustomer;
  if (b.customerName !== undefined) set["customerName"] = b.customerName ? String(b.customerName).slice(0, 200) : null;
  if (b.notes !== undefined) set["notes"] = b.notes ? String(b.notes).slice(0, 4000) : null;
  const [row] = await db.update(waGroupsTable).set(set).where(eq(waGroupsTable.id, g.id)).returning();
  res.json(row);
});

/** Watch every customer group at once, or none. */
router.post("/watch-all", async (req, res) => {
  const on = req.body?.watch !== false;
  const r = await db.update(waGroupsTable).set({ watch: on, updatedAt: new Date() }).where(and(eq(waGroupsTable.userId, req.session.userId!), eq(waGroupsTable.isCustomer, true))).returning({ id: waGroupsTable.id });
  res.json({ updated: r.length });
});

router.get("/:id/messages", async (req, res) => {
  const userId = req.session.userId!;
  const g = await own(userId, Number(req.params.id));
  if (!g) return res.status(404).json({ error: "القروب غير موجود" });
  const before = req.query["before"] ? new Date(String(req.query["before"])) : null;
  const limit = Math.min(300, Number(req.query["limit"]) || 120);
  const [messages, suggestions] = await Promise.all([
    db.select().from(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, userId), eq(waGroupMessagesTable.groupJid, g.jid), before ? lt(waGroupMessagesTable.createdAt, before) : sql`true`))
      .orderBy(desc(waGroupMessagesTable.createdAt)).limit(limit),
    db.select().from(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, userId), eq(waGroupSuggestionsTable.groupJid, g.jid))).orderBy(desc(waGroupSuggestionsTable.createdAt)).limit(60),
  ]);
  res.json({ group: { ...g, folder: folderFor(g) }, messages: messages.reverse(), suggestions });
});

/** Ask WhatsApp for older messages of this group; they arrive through the history sync in a few seconds. */
router.post("/:id/history", async (req, res) => {
  const userId = req.session.userId!;
  const g = await own(userId, Number(req.params.id));
  if (!g) return res.status(404).json({ error: "القروب غير موجود" });
  const sock = getSocket(userId);
  if (!sock?.fetchMessageHistory) return res.status(400).json({ error: "واتساب غير متصل" });
  const oldest = await oldestMessage(userId, g.jid);
  if (!oldest) return res.status(400).json({ error: "لا رسالة محفوظة بعد لهذا القروب — انتظر أول رسالة أو أعد ربط الرقم لتزامن كامل" });
  // Up to 8 asks of 50, twenty seconds apart, in the background.
  void backfill(userId, sock, g.jid, 8).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "group backfill failed"));
  res.json({ ok: true, before: oldest.createdAt });
});

router.post("/:id/profile", async (req, res) => {
  const userId = req.session.userId!;
  const g = await own(userId, Number(req.params.id));
  if (!g) return res.status(404).json({ error: "القروب غير موجود" });
  try { res.json({ profile: await buildProfile(userId, g.jid) }); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A suggestion for the last thing said, now — to try her on a group. */
router.post("/:id/suggest", async (req, res) => {
  const userId = req.session.userId!;
  const g = await own(userId, Number(req.params.id));
  if (!g) return res.status(404).json({ error: "القروب غير موجود" });
  try {
    const s = await suggestFor(userId, g.jid, { force: true });
    if (!s) return res.json({ none: true, why: "آخر رسالة في القروب منّا — لا شيء ينتظر رداً" });
    res.json(s);
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

router.get("/suggestions/all", async (req, res) => {
  const userId = req.session.userId!;
  const status = String(req.query["status"] ?? "pending");
  const rows = await db.execute<any>(sql`
    SELECT s.*, g.id AS group_id, g.subject FROM wa_group_suggestions s
    LEFT JOIN wa_groups g ON g.user_id = s.user_id AND g.jid = s.group_jid
    WHERE s.user_id = ${userId} ${status === "all" ? sql`` : sql`AND s.status = ${status}`}
    ORDER BY s.created_at DESC LIMIT 100`);
  res.json(rows.rows);
});

router.post("/suggestions/:id/feedback", async (req, res) => {
  const b = req.body ?? {};
  if (!["correct", "wrong", "edited"].includes(b.verdict)) return res.status(400).json({ error: "الحكم غير صالح" });
  if (b.verdict === "edited" && !String(b.text ?? "").trim()) return res.status(400).json({ error: "اكتب الرد الصحيح" });
  try { await feedback(req.session.userId!, Number(req.params.id), { verdict: b.verdict, text: b.text, note: b.note }); res.json({ ok: true }); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A filed file, from inside the groups folder only. */
router.get("/files/:messageRowId", async (req, res) => {
  const userId = req.session.userId!;
  const [m] = await db.select().from(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.id, Number(req.params.messageRowId)), eq(waGroupMessagesTable.userId, userId))).limit(1);
  if (!m?.filePath) return res.status(404).json({ error: "لا ملف" });
  const full = path.resolve(m.filePath);
  if (!full.startsWith(path.resolve(FILES_ROOT) + path.sep) || !fs.existsSync(full)) return res.status(404).json({ error: "الملف غير موجود على الجهاز" });
  res.download(full, m.fileName ?? path.basename(full));
});

export default router;
