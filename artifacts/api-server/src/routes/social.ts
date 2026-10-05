// ── /api/social/:platform — one desk per platform ─────────────────
import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { and, asc, desc, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  db, socialAccountsTable, socialPostsTable, socialCommentsTable, socialListsTable, socialTargetsTable,
  socialThreadsTable, socialMessagesTable, socialContentTable, socialActionsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { openSession, closeSession } from "../lib/browser-agent";
import { ACTION_KINDS, PLATFORM, isPlatform, postIdOf, type SocialPlatform } from "../lib/social/platforms";
import { driverFor } from "../lib/social/drivers";
import * as engine from "../lib/social/engine";
import * as agent from "../lib/social/agent";
import { activity } from "../lib/social/team";
import { addTargets, createList, dashboard, listsWithFunnel, rowsFromSheet, searchIntoList } from "../lib/social/desk";

const router = Router();
router.use(requireAuth);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const P = (req: Request) => req.params["platform"] as SocialPlatform;
router.param("platform", (req: Request, res: Response, next: NextFunction, v: string) => (isPlatform(v) ? next() : res.status(404).json({ error: "منصة غير معروفة" })));
const uid = (req: Request) => req.session.userId!;
const mine = (t: { userId: any; platform: any; id: any }, req: Request, id: number) => and(eq(t.id, id), eq(t.userId, uid(req)), eq(t.platform, P(req)));
const fail = (res: Response, err: any) => res.status(400).json({ error: String(err?.message ?? err).slice(0, 300) });

router.get("/:platform", async (req, res) => {
  try { res.json(await dashboard(uid(req), P(req), Math.min(90, Number(req.query["days"]) || 14))); } catch (e) { fail(res, e); }
});

// ── Account ──────────────────────────────────────────────────────
router.post("/:platform/login-window", async (req, res) => {
  const p = P(req);
  if (!driverFor(p)) return res.status(400).json({ error: `لا يعمل الفريق على ${PLATFORM[p].labelAr} بعد` });
  const a = await engine.ensureAccount(uid(req), p);
  try {
    const s = await openSession(uid(req), a.profile, { visible: true });
    await s.page.goto(p === "tiktok" ? `${PLATFORM[p].home}/login` : p === "instagram" ? `${PLATFORM[p].home}/accounts/login/` : `${PLATFORM[p].home}/login`, { waitUntil: "domcontentloaded", timeout: 40_000 });
    res.json({ ok: true, note: "نافذة Chrome فُتحت على هذا الجهاز — سجّل دخولك بيدك ثم اضغط «افحص الحالة»" });
  } catch (e) { fail(res, e); }
});
router.post("/:platform/check", async (req, res) => { try { res.json(await engine.guardCheck(uid(req), P(req))); } catch (e) { fail(res, e); } });
router.delete("/:platform/window", async (req, res) => {
  const a = await engine.account(uid(req), P(req));
  if (a) await closeSession(uid(req), a.profile).catch(() => {});
  res.json({ ok: true });
});

router.patch("/:platform/settings", async (req, res) => {
  const p = P(req), b = req.body ?? {};
  const a = await engine.ensureAccount(uid(req), p);
  const set: Record<string, unknown> = {};
  if (typeof b.dryRun === "boolean") set["dryRun"] = b.dryRun;
  if (typeof b.autopilot === "boolean") set["autopilot"] = b.autopilot;
  if (b.mode === "approve" || b.mode === "auto") set["mode"] = b.mode;
  if (Array.isArray(b.listIds)) set["listIds"] = b.listIds.map(Number).filter(Number.isFinite).slice(0, 50);
  if (b.caps && typeof b.caps === "object") {
    const caps: Record<string, number> = { ...(a.caps as any) };
    for (const k of ACTION_KINDS) if (b.caps[k] !== undefined) caps[k] = Math.max(0, Math.min(PLATFORM[p].caps[k] * 3, Math.round(Number(b.caps[k]) || 0)));
    set["caps"] = caps;
  }
  const [row] = await db.update(socialAccountsTable).set(set).where(eq(socialAccountsTable.id, a.id)).returning();
  if (set["dryRun"] === false) await activity(uid(req), p, "manager", "settings", "صاحب العمل شغّل الإرسال الفعلي");
  if (set["autopilot"] !== undefined) await activity(uid(req), p, "manager", "settings", set["autopilot"] ? "صاحب العمل شغّل الطيار الآلي" : "صاحب العمل أوقف الطيار الآلي");
  res.json(row);
});

// ── Posts and comments ───────────────────────────────────────────
router.get("/:platform/posts", async (req, res) => {
  res.json(await db.select().from(socialPostsTable).where(and(eq(socialPostsTable.userId, uid(req)), eq(socialPostsTable.platform, P(req)))).orderBy(desc(socialPostsTable.createdAt)).limit(100));
});
router.post("/:platform/posts", async (req, res) => {
  const url = String(req.body?.url ?? "").trim(), id = postIdOf(P(req), url);
  if (!id) return res.status(400).json({ error: `ليس رابط منشور في ${PLATFORM[P(req)].labelAr}` });
  const [row] = await db.insert(socialPostsTable).values({ userId: uid(req), platform: P(req), externalId: id, url }).onConflictDoUpdate({ target: [socialPostsTable.userId, socialPostsTable.platform, socialPostsTable.externalId], set: { watching: true } }).returning();
  res.json(row);
});
router.patch("/:platform/posts/:id", async (req, res) => {
  const [row] = await db.update(socialPostsTable).set({ watching: !!req.body?.watching }).where(mine(socialPostsTable, req, Number(req.params["id"]))).returning();
  res.json(row ?? null);
});
router.delete("/:platform/posts/:id", async (req, res) => {
  await db.delete(socialPostsTable).where(mine(socialPostsTable, req, Number(req.params["id"])));
  res.json({ ok: true });
});
router.post("/:platform/discover", async (req, res) => { try { res.json({ added: await engine.discoverPosts(uid(req), P(req), true) }); } catch (e) { fail(res, e); } });

router.get("/:platform/comments", async (req, res) => {
  const status = String(req.query["status"] ?? "drafted");
  const rows = await db.select({ c: socialCommentsTable, url: socialPostsTable.url }).from(socialCommentsTable).leftJoin(socialPostsTable, eq(socialPostsTable.id, socialCommentsTable.postId))
    .where(and(eq(socialCommentsTable.userId, uid(req)), eq(socialCommentsTable.platform, P(req)), status === "all" ? sql`true` : eq(socialCommentsTable.status, status)))
    .orderBy(desc(socialCommentsTable.createdAt)).limit(150);
  const counts = await db.select({ status: socialCommentsTable.status, n: sql<number>`count(*)::int` }).from(socialCommentsTable).where(and(eq(socialCommentsTable.userId, uid(req)), eq(socialCommentsTable.platform, P(req)))).groupBy(socialCommentsTable.status);
  res.json({ rows: rows.map((r) => ({ ...r.c, postUrl: r.url })), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) });
});
router.post("/:platform/comments/:id/approve", async (req, res) => {
  const set: Record<string, unknown> = { status: "approved" };
  if (typeof req.body?.draft === "string" && req.body.draft.trim()) set["draft"] = req.body.draft.trim().slice(0, 2_000);
  const [row] = await db.update(socialCommentsTable).set(set).where(mine(socialCommentsTable, req, Number(req.params["id"]))).returning();
  res.json(row ?? null);
});
router.post("/:platform/comments/:id/skip", async (req, res) => {
  const [row] = await db.update(socialCommentsTable).set({ status: "skipped", skipReason: "تخطّاه صاحب العمل" }).where(mine(socialCommentsTable, req, Number(req.params["id"]))).returning();
  res.json(row ?? null);
});
router.post("/:platform/comments/approve-all", async (req, res) => {
  const r = await db.update(socialCommentsTable).set({ status: "approved" }).where(and(eq(socialCommentsTable.userId, uid(req)), eq(socialCommentsTable.platform, P(req)), eq(socialCommentsTable.status, "drafted"))).returning({ id: socialCommentsTable.id });
  res.json({ approved: r.length });
});

// ── Conversations ────────────────────────────────────────────────
router.get("/:platform/threads", async (req, res) => {
  const f = String(req.query["filter"] ?? "all");
  const rows = await db.execute<any>(sql`
    SELECT t.*, (SELECT text FROM social_messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC LIMIT 1) AS last_text,
      (SELECT count(*) FROM social_messages m WHERE m.thread_id = t.id AND m.status = 'drafted')::int AS drafts
    FROM social_threads t WHERE t.user_id = ${uid(req)} AND t.platform = ${P(req)}
      ${f === "waiting" ? sql`AND t.last_from_them` : f === "outreach" ? sql`AND t.origin = 'outreach'` : f === "hot" ? sql`AND t.temperature = 'hot'` : sql``}
    ORDER BY t.last_message_at DESC NULLS LAST LIMIT 150`);
  res.json(rows.rows);
});
router.get("/:platform/threads/:id", async (req, res) => {
  const [t] = await db.select().from(socialThreadsTable).where(mine(socialThreadsTable, req, Number(req.params["id"]))).limit(1);
  if (!t) return res.status(404).json({ error: "المحادثة غير موجودة" });
  const messages = await db.select().from(socialMessagesTable).where(eq(socialMessagesTable.threadId, t.id)).orderBy(asc(socialMessagesTable.createdAt)).limit(200);
  const [target] = t.targetId ? await db.select().from(socialTargetsTable).where(eq(socialTargetsTable.id, t.targetId)).limit(1) : await db.select().from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)), eq(socialTargetsTable.handle, t.handle))).limit(1);
  res.json({ thread: t, messages, target: target ?? null });
});
router.post("/:platform/threads/:id/draft", async (req, res) => {
  const [t] = await db.select().from(socialThreadsTable).where(mine(socialThreadsTable, req, Number(req.params["id"]))).limit(1);
  if (!t) return res.status(404).json({ error: "المحادثة غير موجودة" });
  await db.update(socialMessagesTable).set({ status: "skipped" }).where(and(eq(socialMessagesTable.threadId, t.id), eq(socialMessagesTable.status, "drafted")));
  await db.update(socialThreadsTable).set({ lastFromThem: true }).where(eq(socialThreadsTable.id, t.id));
  try { res.json({ drafted: await engine.draftReplies(uid(req), P(req)) }); } catch (e) { fail(res, e); }
});
router.post("/:platform/threads/:id/stop", async (req, res) => {
  const [t] = await db.update(socialThreadsTable).set({ status: "stopped" }).where(mine(socialThreadsTable, req, Number(req.params["id"]))).returning();
  if (t) {
    await db.update(socialMessagesTable).set({ status: "skipped" }).where(and(eq(socialMessagesTable.threadId, t.id), inArray(socialMessagesTable.status, ["drafted", "approved"])));
    await db.update(socialTargetsTable).set({ status: "declined", nextAt: null }).where(and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)), eq(socialTargetsTable.handle, t.handle)));
  }
  res.json({ ok: !!t });
});
router.get("/:platform/messages", async (req, res) => {
  const rows = await db.select({ m: socialMessagesTable, handle: socialThreadsTable.handle, name: socialThreadsTable.displayName }).from(socialMessagesTable).innerJoin(socialThreadsTable, eq(socialThreadsTable.id, socialMessagesTable.threadId))
    .where(and(eq(socialMessagesTable.userId, uid(req)), eq(socialMessagesTable.platform, P(req)), eq(socialMessagesTable.status, String(req.query["status"] ?? "drafted")))).orderBy(asc(socialMessagesTable.createdAt)).limit(100);
  res.json(rows.map((r) => ({ ...r.m, handle: r.handle, name: r.name })));
});
router.post("/:platform/messages/:id/approve", async (req, res) => {
  const set: Record<string, unknown> = { status: "approved" };
  if (typeof req.body?.text === "string" && req.body.text.trim()) set["text"] = req.body.text.trim().slice(0, 2_000);
  const [row] = await db.update(socialMessagesTable).set(set).where(and(mine(socialMessagesTable, req, Number(req.params["id"])), eq(socialMessagesTable.fromMe, true))).returning();
  res.json(row ?? null);
});
router.post("/:platform/messages/:id/skip", async (req, res) => {
  const [row] = await db.update(socialMessagesTable).set({ status: "skipped" }).where(and(mine(socialMessagesTable, req, Number(req.params["id"])), eq(socialMessagesTable.fromMe, true))).returning();
  res.json(row ?? null);
});

// ── Target lists ─────────────────────────────────────────────────
router.get("/:platform/lists", async (req, res) => res.json(await listsWithFunnel(uid(req), P(req))));
router.post("/:platform/lists", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "اكتب اسم القائمة" });
  res.json(await createList(uid(req), P(req), name, { sector: req.body?.sector ?? null }));
});
router.patch("/:platform/lists/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) set["name"] = req.body.name.trim().slice(0, 160);
  if (req.body?.folderId !== undefined) set["folderId"] = req.body.folderId === null ? null : Number(req.body.folderId);
  const [row] = await db.update(socialListsTable).set(set).where(mine(socialListsTable, req, Number(req.params["id"]))).returning();
  res.json(row ?? null);
});
router.delete("/:platform/lists/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  // People never reached go with the list; anyone already written to stays, so their history does.
  await db.delete(socialTargetsTable).where(and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)), eq(socialTargetsTable.listId, id), inArray(socialTargetsTable.status, ["new", "drafted", "skipped", "unreachable", "failed"])));
  await db.delete(socialListsTable).where(mine(socialListsTable, req, id));
  const a = await engine.account(uid(req), P(req));
  if (a?.listIds?.includes(id)) await db.update(socialAccountsTable).set({ listIds: a.listIds.filter((x) => x !== id) }).where(eq(socialAccountsTable.id, a.id));
  res.json({ ok: true });
});

router.get("/:platform/targets", async (req, res) => {
  const status = String(req.query["status"] ?? "all"), q = String(req.query["q"] ?? "").trim(), listId = Number(req.query["listId"]) || null;
  const page = Math.max(0, Number(req.query["page"]) || 0), limit = 100;
  const where = and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)),
    listId ? eq(socialTargetsTable.listId, listId) : sql`true`,
    status === "all" ? sql`true` : status === "reached" ? inArray(socialTargetsTable.status, ["sent", "invited", "replied", "declined"]) : eq(socialTargetsTable.status, status),
    q ? or(ilike(socialTargetsTable.handle, `%${q}%`), ilike(socialTargetsTable.name, `%${q}%`), ilike(socialTargetsTable.company, `%${q}%`), ilike(socialTargetsTable.headline, `%${q}%`)) : sql`true`);
  const [rows, counts] = await Promise.all([
    db.select().from(socialTargetsTable).where(where).orderBy(desc(socialTargetsTable.updatedAt)).limit(limit).offset(page * limit),
    db.select({ status: socialTargetsTable.status, n: sql<number>`count(*)::int` }).from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)), listId ? eq(socialTargetsTable.listId, listId) : sql`true`)).groupBy(socialTargetsTable.status),
  ]);
  res.json({ rows, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), page, limit });
});
/** Names, handles or links pasted one per line. */
router.post("/:platform/lists/:id/targets", async (req, res) => {
  const lines = String(req.body?.text ?? "").split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 2_000);
  res.json(await addTargets(uid(req), P(req), Number(req.params["id"]), lines.map((l) => ({ url: l, handle: l })), "manual"));
});
router.post("/:platform/lists/:id/import", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "اختر ملفاً" });
  try {
    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const rows = wb.SheetNames.flatMap((n) => XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[n]!, { defval: "" }));
    const inputs = rowsFromSheet(P(req), rows);
    if (!inputs.length) return res.status(400).json({ error: `لم أجد في الملف عموداً فيه روابط ${PLATFORM[P(req)].labelAr} أو أسماء حسابات` });
    res.json({ rows: rows.length, ...(await addTargets(uid(req), P(req), Number(req.params["id"]), inputs, "import")) });
  } catch (e) { fail(res, e); }
});
router.post("/:platform/search", async (req, res) => {
  const query = String(req.body?.query ?? "").trim();
  if (query.length < 2) return res.status(400).json({ error: "اكتب ما تبحث عنه — مثلاً: real estate Dubai" });
  try { res.json(await searchIntoList(uid(req), P(req), query, Number(req.body?.max) || 30, Number(req.body?.listId) || undefined)); } catch (e) { fail(res, e); }
});
/** First messages for a list now, rather than at the next round. */
router.post("/:platform/lists/:id/prepare", async (req, res) => {
  try { res.json({ drafted: await engine.prepareOutreach(uid(req), P(req), { listId: Number(req.params["id"]), max: Math.min(25, Number(req.body?.max) || 10) }) }); } catch (e) { fail(res, e); }
});
router.post("/:platform/targets/:id/approve", async (req, res) => {
  const set: Record<string, unknown> = { status: "approved", updatedAt: new Date() };
  if (typeof req.body?.draft === "string" && req.body.draft.trim()) set["draft"] = req.body.draft.trim().slice(0, PLATFORM[P(req)].firstContactMax);
  const given = typeof req.body?.draft === "string" && !!req.body.draft.trim();
  // Nothing is approved without words to send.
  const [row] = await db.update(socialTargetsTable).set(set).where(and(mine(socialTargetsTable, req, Number(req.params["id"])), given ? sql`true` : isNotNull(socialTargetsTable.draft))).returning();
  res.json(row ?? null);
});
router.post("/:platform/targets/bulk", async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Number.isFinite).slice(0, 1_000);
  const action = String(req.body?.action ?? "");
  if (!ids.length) return res.status(400).json({ error: "لم تختر أحداً" });
  const where = and(eq(socialTargetsTable.userId, uid(req)), eq(socialTargetsTable.platform, P(req)), inArray(socialTargetsTable.id, ids));
  if (action === "approve") return res.json({ n: (await db.update(socialTargetsTable).set({ status: "approved", updatedAt: new Date() }).where(and(where, eq(socialTargetsTable.status, "drafted"))).returning({ id: socialTargetsTable.id })).length });
  if (action === "skip") return res.json({ n: (await db.update(socialTargetsTable).set({ status: "skipped", updatedAt: new Date() }).where(and(where, inArray(socialTargetsTable.status, ["new", "drafted", "approved"]))).returning({ id: socialTargetsTable.id })).length });
  if (action === "reset") return res.json({ n: (await db.update(socialTargetsTable).set({ status: "new", draft: null, updatedAt: new Date() }).where(and(where, inArray(socialTargetsTable.status, ["drafted", "approved", "skipped", "failed"]))).returning({ id: socialTargetsTable.id })).length });
  if (action === "delete") return res.json({ n: (await db.delete(socialTargetsTable).where(and(where, inArray(socialTargetsTable.status, ["new", "drafted", "approved", "skipped", "unreachable", "failed"]))).returning({ id: socialTargetsTable.id })).length });
  res.status(400).json({ error: "إجراء غير معروف" });
});

// ── Content ──────────────────────────────────────────────────────
router.get("/:platform/content", async (req, res) => {
  res.json(await db.select().from(socialContentTable).where(and(eq(socialContentTable.userId, uid(req)), eq(socialContentTable.platform, P(req)))).orderBy(desc(socialContentTable.createdAt)).limit(100));
});
router.post("/:platform/content", async (req, res) => {
  const p = P(req), kind = req.body?.kind === "engage" ? "engage" : "post";
  try {
    const text = typeof req.body?.text === "string" && req.body.text.trim() ? req.body.text.trim()
      : kind === "post" ? await agent.draftPost(uid(req), p, String(req.body?.topic ?? "").trim() || "خدمة من خدماتنا")
      : await agent.draftEngage(uid(req), p, String(req.body?.targetText ?? ""));
    if (!text) return res.status(400).json({ error: "لم يكتب الفريق شيئاً — حاول بموضوع أوضح" });
    const [row] = await db.insert(socialContentTable).values({ userId: uid(req), platform: p, kind, topic: req.body?.topic ?? null, targetUrl: req.body?.targetUrl ?? null, targetText: req.body?.targetText ?? null, text, role: `${PLATFORM[p].prefix}_creator`,
      scheduledAt: req.body?.scheduledAt ? new Date(req.body.scheduledAt) : null }).returning();
    await activity(uid(req), p, "creator", "draft", kind === "post" ? `كتبت منشوراً عن «${String(req.body?.topic ?? "").slice(0, 60)}»` : "كتبت تعليقاً تفاعلياً");
    res.json(row);
  } catch (e) { fail(res, e); }
});
router.patch("/:platform/content/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (typeof req.body?.text === "string") set["text"] = req.body.text.slice(0, 3_000);
  if (["draft", "approved", "skipped"].includes(req.body?.status)) set["status"] = req.body.status;
  const [row] = await db.update(socialContentTable).set(set).where(mine(socialContentTable, req, Number(req.params["id"]))).returning();
  res.json(row ?? null);
});
router.delete("/:platform/content/:id", async (req, res) => {
  await db.delete(socialContentTable).where(mine(socialContentTable, req, Number(req.params["id"])));
  res.json({ ok: true });
});

// ── Running ──────────────────────────────────────────────────────
router.post("/:platform/run", async (req, res) => {
  const p = P(req);
  if (!driverFor(p)) return res.status(400).json({ error: `لا يعمل الفريق على ${PLATFORM[p].labelAr} بعد` });
  // A round takes minutes (it paces itself like a person); it runs on, and the dashboard shows what it did.
  void engine.runRound(uid(req), p).catch(() => {});
  res.json({ started: true });
});
router.post("/:platform/send", async (req, res) => {
  void engine.sendApproved(uid(req), P(req)).catch(() => {});
  res.json({ started: true });
});
router.get("/:platform/actions", async (req, res) => {
  res.json(await db.select().from(socialActionsTable).where(and(eq(socialActionsTable.userId, uid(req)), eq(socialActionsTable.platform, P(req)))).orderBy(desc(socialActionsTable.createdAt)).limit(100));
});

export default router;
