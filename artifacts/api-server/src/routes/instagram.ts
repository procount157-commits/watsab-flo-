// ── Instagram ─────────────────────────────────────────────────────
// Signing in is the owner's: a real Chrome window opens, they type their own
// password, and the cookies persist into the employee's browser profile. This
// application never sees it.

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, instagramAccountsTable, instagramPostsTable, instagramCommentsTable,
  instagramThreadsTable, instagramMessagesTable, instagramActionsTable,
  botEmployeesTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { openSession, closeSession } from "../lib/browser-agent";
import { IG, readInbox, sendDm } from "../lib/instagram/browser";
import {
  account, ensureAccount, guardCheck, collectComments, processNew,
  sendApproved, todayCounts, mayAct, runRound, PACE,
} from "../lib/instagram/engine";
import { IG_TEAM_DEFS } from "../lib/instagram/team";

const router = Router();
router.use(requireAuth);

/** Everything the page needs, in one call. */
router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  const a = await ensureAccount(userId);
  const [counts, posts, team] = await Promise.all([
    todayCounts(userId),
    db.select().from(instagramPostsTable).where(eq(instagramPostsTable.userId, userId)).orderBy(desc(instagramPostsTable.id)),
    db.select().from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId)),
  ]);
  const [byStatus] = await db.select({
    neu:      sql<number>`count(*) filter (where ${instagramCommentsTable.status} = 'new')`,
    drafted:  sql<number>`count(*) filter (where ${instagramCommentsTable.status} = 'drafted')`,
    approved: sql<number>`count(*) filter (where ${instagramCommentsTable.status} = 'approved')`,
    replied:  sql<number>`count(*) filter (where ${instagramCommentsTable.status} = 'replied')`,
    skipped:  sql<number>`count(*) filter (where ${instagramCommentsTable.status} = 'skipped')`,
    leads:    sql<number>`count(*) filter (where ${instagramCommentsTable.isLead})`,
  }).from(instagramCommentsTable).where(eq(instagramCommentsTable.userId, userId));

  res.json({
    account: a,
    counts: {
      ...counts,
      replyCap: a.dailyCommentCap, dmCap: a.dailyDmCap,
      comments: {
        new: Number(byStatus?.neu ?? 0), drafted: Number(byStatus?.drafted ?? 0),
        approved: Number(byStatus?.approved ?? 0), replied: Number(byStatus?.replied ?? 0),
        skipped: Number(byStatus?.skipped ?? 0), leads: Number(byStatus?.leads ?? 0),
      },
    },
    posts,
    pace: { minGapSeconds: PACE.minGapMs / 1000, hours: PACE.hours },
    team: IG_TEAM_DEFS.map((d) => {
      const live = team.find((t) => t.role === d.role);
      return {
        role: d.role,
        name: live?.name ?? d.name,
        title: live?.title ?? d.title,
        avatar: live?.avatar ?? d.avatar,
        isActive: live?.isActive ?? true,
      };
    }),
  });
});

/** Open a real window so the owner can sign in themselves. */
router.post("/login-window", async (req, res) => {
  const userId = req.session.userId!;
  const a = await ensureAccount(userId);
  const s = await openSession(userId, a.role, { visible: true });
  await s.page.goto(`${IG}/accounts/login/`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
  res.json({ ok: true, role: a.role });
});

router.post("/check", async (req, res) => res.json(await guardCheck(req.session.userId!)));

router.delete("/window", async (req, res) => {
  const a = await account(req.session.userId!);
  if (a) await closeSession(req.session.userId!, a.role);
  res.json({ ok: true });
});

/** Settings the owner controls: the caps, and whether anything is actually sent. */
router.patch("/settings", async (req, res) => {
  const userId = req.session.userId!;
  await ensureAccount(userId);
  const set: Record<string, unknown> = {};
  if (req.body?.dryRun !== undefined) set.dryRun = req.body.dryRun !== false;
  // Capped at values that are still conservative: Instagram's real limits are
  // unpublished, and the penalty for guessing high is the account.
  if (req.body?.dailyCommentCap !== undefined) {
    set.dailyCommentCap = Math.min(120, Math.max(5, Number(req.body.dailyCommentCap) || 40));
  }
  if (req.body?.dailyDmCap !== undefined) {
    set.dailyDmCap = Math.min(60, Math.max(3, Number(req.body.dailyDmCap) || 20));
  }
  if (!Object.keys(set).length) return res.status(400).json({ error: "لا تغيير" });
  const [row] = await db.update(instagramAccountsTable).set(set)
    .where(eq(instagramAccountsTable.userId, userId)).returning();
  res.json(row);
});

// ── Posts to watch ───────────────────────────────────────────────
router.post("/posts", async (req, res) => {
  const userId = req.session.userId!;
  const url = String(req.body?.url ?? "").trim();
  const m = /instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/.exec(url);
  if (!m) return res.status(400).json({ error: "رابط منشور غير صالح — انسخ رابط المنشور من إنستجرام" });
  const [row] = await db.insert(instagramPostsTable)
    .values({ userId, shortcode: m[1]!, url: `${IG}/p/${m[1]}/` })
    .onConflictDoNothing().returning();
  if (!row) return res.status(409).json({ error: "هذا المنشور مُتابَع بالفعل" });
  res.status(201).json(row);
});

router.patch("/posts/:id", async (req, res) => {
  const [row] = await db.update(instagramPostsTable).set({ watching: req.body?.watching !== false })
    .where(and(eq(instagramPostsTable.id, Number(req.params.id)), eq(instagramPostsTable.userId, req.session.userId!)))
    .returning();
  if (!row) return res.status(404).json({ error: "المنشور غير موجود" });
  res.json(row);
});

router.delete("/posts/:id", async (req, res) => {
  await db.delete(instagramPostsTable)
    .where(and(eq(instagramPostsTable.id, Number(req.params.id)), eq(instagramPostsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Comments ─────────────────────────────────────────────────────
router.get("/comments", async (req, res) => {
  const userId = req.session.userId!;
  const status = String(req.query.status ?? "");
  const rows = await db.select({
    c: instagramCommentsTable, postUrl: instagramPostsTable.url,
  }).from(instagramCommentsTable)
    .leftJoin(instagramPostsTable, eq(instagramPostsTable.id, instagramCommentsTable.postId))
    .where(status
      ? and(eq(instagramCommentsTable.userId, userId), eq(instagramCommentsTable.status, status))
      : eq(instagramCommentsTable.userId, userId))
    .orderBy(desc(instagramCommentsTable.createdAt))
    .limit(120);
  res.json(rows.map((r) => ({ ...r.c, postUrl: r.postUrl })));
});

/** The owner's yes, with the reply as they edited it. */
router.post("/comments/:id/approve", async (req, res) => {
  const draft = typeof req.body?.draft === "string" ? req.body.draft.trim().slice(0, 400) : undefined;
  const [row] = await db.update(instagramCommentsTable)
    .set({ status: "approved", ...(draft ? { draft } : {}) })
    .where(and(eq(instagramCommentsTable.id, Number(req.params.id)), eq(instagramCommentsTable.userId, req.session.userId!)))
    .returning();
  if (!row) return res.status(404).json({ error: "التعليق غير موجود" });
  res.json(row);
});

router.post("/comments/:id/skip", async (req, res) => {
  const [row] = await db.update(instagramCommentsTable)
    .set({ status: "skipped", skipReason: "تخطّاه صاحب العمل" })
    .where(and(eq(instagramCommentsTable.id, Number(req.params.id)), eq(instagramCommentsTable.userId, req.session.userId!)))
    .returning();
  if (!row) return res.status(404).json({ error: "التعليق غير موجود" });
  res.json(row);
});

// ── Direct messages ──────────────────────────────────────────────
router.get("/inbox", async (req, res) => {
  const userId = req.session.userId!;
  const a = await account(userId);
  if (!a) return res.json({ threads: [], error: "لا حساب" });
  res.json(await readInbox(userId, a.role));
});

/**
 * Send one message, to a conversation that already exists.
 *
 * The browser layer refuses a username that is not in the inbox, which is the
 * line this system does not cross: answering someone who wrote to you is a
 * reply, and writing to someone who did not is not.
 */
router.post("/dm", async (req, res) => {
  const userId = req.session.userId!;
  const a = await account(userId);
  if (!a) return res.status(400).json({ error: "لا حساب" });
  if (a.dryRun) return res.status(409).json({ error: "وضع التجربة مفعّل — أوقفه أولاً إن أردت الإرسال فعلاً" });

  const username = String(req.body?.username ?? "").replace(/^@/, "").trim();
  const text = String(req.body?.text ?? "").trim();
  if (!username || !text) return res.status(400).json({ error: "الحساب والنص مطلوبان" });

  const gate = await mayAct(userId, "dm");
  if (!gate.allowed) return res.status(429).json({ error: gate.reason });

  const r = await sendDm(userId, a.role, username, text);
  if (!r.ok) return res.status(502).json({ error: r.error });

  // Recorded on this side too, so the thread reads as a conversation.
  const [thread] = await db.insert(instagramThreadsTable)
    .values({ userId, username, origin: "inbound", lastMessageAt: new Date(), lastFromThem: false })
    .onConflictDoUpdate({
      target: [instagramThreadsTable.userId, instagramThreadsTable.username],
      set: { lastMessageAt: new Date(), lastFromThem: false },
    }).returning();
  await db.insert(instagramMessagesTable).values({
    userId, threadId: thread!.id, fromMe: true, text, status: "sent", sentAt: new Date(),
  });
  res.json({ ok: true });
});

// ── Running a round by hand ──────────────────────────────────────
router.post("/collect", async (req, res) => res.json(await collectComments(req.session.userId!)));
router.post("/process", async (req, res) => res.json(await processNew(req.session.userId!)));
router.post("/send",    async (req, res) => res.json(await sendApproved(req.session.userId!)));
router.post("/run",     async (req, res) => res.json(await runRound(req.session.userId!)));

router.get("/actions", async (req, res) => {
  const rows = await db.select().from(instagramActionsTable)
    .where(eq(instagramActionsTable.userId, req.session.userId!))
    .orderBy(desc(instagramActionsTable.createdAt)).limit(60);
  res.json(rows);
});

export default router;
