// ── Running a social desk ─────────────────────────────────────────
// One round, the same on every platform:
//
//   guard      is the account signed in and unrestricted? if not, stop here
//   watcher    find our new posts; read the comments on the watched ones
//   triage     judge each new comment; writer drafts the public reply
//   dm         read the inbox; draft the reply to whoever is waiting
//   prospector draft a first message to the next people on the chosen lists
//   followup   draft the one follow-up for whoever has not answered
//   send       whatever is approved, inside the gate
//
// Nothing leaves while the account is in dry run, which is how every desk
// ships. In "approve" mode every draft waits for the owner; in "auto" the
// guard's pass is enough. The gate is checked before every single action, so
// a restriction that appears mid-round stops the rest of it.

import crypto from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  db, socialAccountsTable, socialPostsTable, socialCommentsTable, socialTargetsTable, socialThreadsTable,
  socialMessagesTable, socialContentTable, socialActionsTable, knowledgeBaseTable, businessProfileTable,
  type SocialAccount,
} from "@workspace/db";
import { openSession } from "../browser-agent";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { ACTION_KINDS, COUNTS_AS, PLATFORM, capsFor, gulfHour, type ActionKind, type SocialPlatform } from "./platforms";
import { driverFor, DRIVEN } from "./drivers";
import { human } from "./drivers/common";
import { activity, onDuty, roleOf, type Job } from "./team";
import * as agent from "./agent";
import { dealFromHotLead } from "../deals/deals";

// ── The account ──────────────────────────────────────────────────
export async function account(userId: number, p: SocialPlatform): Promise<SocialAccount | null> {
  const [a] = await db.select().from(socialAccountsTable).where(and(eq(socialAccountsTable.userId, userId), eq(socialAccountsTable.platform, p))).limit(1);
  return a ?? null;
}

export async function ensureAccount(userId: number, p: SocialPlatform): Promise<SocialAccount> {
  const a = await account(userId, p);
  if (a) return a;
  const [made] = await db.insert(socialAccountsTable).values({ userId, platform: p, profile: `${PLATFORM[p].prefix}_desk` })
    .onConflictDoNothing().returning();
  return made ?? (await account(userId, p))!;
}

export async function record(userId: number, p: SocialPlatform, job: Job, action: string, opts: { target?: string; ok?: boolean; detail?: string } = {}) {
  await db.insert(socialActionsTable).values({
    userId, platform: p, role: roleOf(p, job), action, target: opts.target?.slice(0, 200) ?? null, ok: opts.ok !== false, detail: opts.detail?.slice(0, 500) ?? null,
  }).catch(() => {});
}

/** What the account has done in the last day, by kind — what the caps measure. */
export async function todayCounts(userId: number, p: SocialPlatform) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db.select({ action: socialActionsTable.action, ok: socialActionsTable.ok, n: sql<number>`count(*)`, last: sql<Date | null>`max(${socialActionsTable.createdAt})` })
    .from(socialActionsTable).where(and(eq(socialActionsTable.userId, userId), eq(socialActionsTable.platform, p), gte(socialActionsTable.createdAt, since)))
    .groupBy(socialActionsTable.action, socialActionsTable.ok);
  const used = Object.fromEntries(ACTION_KINDS.map((k) => [k, rows.filter((r) => r.ok && COUNTS_AS[k].includes(r.action)).reduce((a, r) => a + Number(r.n), 0)])) as Record<ActionKind, number>;
  const fails = rows.filter((r) => !r.ok).reduce((a, r) => a + Number(r.n), 0);
  // The gap is measured between actions that touch other people, not reads.
  const acting = rows.filter((r) => Object.values(COUNTS_AS).flat().includes(r.action)).map((r) => r.last).filter(Boolean) as Date[];
  const last = acting.length ? new Date(Math.max(...acting.map((d) => new Date(d).getTime()))) : null;
  return { used, fails, last };
}

export type Gate = { allowed: boolean; reason?: string; waitMs?: number };

/** May the account do one more of this, right now? */
export async function mayAct(userId: number, p: SocialPlatform, kind: ActionKind): Promise<Gate> {
  const a = await account(userId, p);
  const P = PLATFORM[p];
  if (!a) return { allowed: false, reason: `لم يُضبط حساب ${P.labelAr} بعد` };
  if (!driverFor(p)) return { allowed: false, reason: `لا يعمل الفريق على موقع ${P.labelAr} بعد` };
  if (a.state === "restricted") return { allowed: false, reason: `${P.labelAr} قيّد الحساب — كل شيء موقوف حتى يزول` };
  if (a.state === "checkpoint") return { allowed: false, reason: `${P.labelAr} يطلب تأكيد هويتك — افتح النافذة وأكمله` };
  if (a.state !== "logged_in") return { allowed: false, reason: "الحساب غير مسجّل دخول" };
  const h = gulfHour();
  if (h < P.pace.hours[0] || h >= P.pace.hours[1]) return { allowed: false, reason: `خارج ساعات النشاط (${P.pace.hours[0]}–${P.pace.hours[1]} بتوقيت الخليج)` };
  const t = await todayCounts(userId, p);
  if (t.fails >= 5) return { allowed: false, reason: `${t.fails} محاولات فشلت اليوم — أوقفت النشاط حتى تُراجَع` };
  const cap = capsFor(p, a.caps)[kind];
  if (t.used[kind] >= cap) return { allowed: false, reason: `بلغت حد اليوم (${t.used[kind]}/${cap})` };
  if (t.last) {
    const gap = Date.now() - new Date(t.last).getTime();
    if (gap < P.pace.minGapMs) return { allowed: false, reason: "الفاصل بين الأفعال قصير", waitMs: P.pace.minGapMs - gap };
  }
  return { allowed: true };
}

/** Wait out a short gap rather than give up the round over forty seconds. */
async function gate(userId: number, p: SocialPlatform, kind: ActionKind): Promise<Gate> {
  let g = await mayAct(userId, p, kind);
  if (!g.allowed && g.waitMs && g.waitMs < 3 * 60_000) { await human(g.waitMs + 2_000, g.waitMs + 15_000); g = await mayAct(userId, p, kind); }
  return g;
}

async function pageFor(userId: number, a: SocialAccount) {
  return (await openSession(userId, a.profile)).page;
}

const hash = (fromMe: boolean, text: string) => crypto.createHash("sha1").update(`${fromMe ? 1 : 0}|${text.replace(/\s+/g, " ").trim()}`).digest("hex");

async function knowledgeText(userId: number) {
  const [rows, [profile]] = await Promise.all([
    db.select({ c: knowledgeBaseTable.content }).from(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.isActive, true))).limit(400),
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1),
  ]);
  return [profile?.description ?? "", ...rows.map((r) => r.c)].join("\n").slice(0, 200_000);
}

/** In auto mode a draft the guard passes is approved at once; otherwise it waits for the owner. */
async function settle(userId: number, p: SocialPlatform, a: SocialAccount, text: string, recentSent: string[]): Promise<"approved" | "drafted"> {
  if (a.mode !== "auto") return "drafted";
  const issues = agent.guardText(text, await knowledgeText(userId), recentSent);
  if (issues.length) { await activity(userId, p, "guard", "held", `أوقفت مسودة للمراجعة: ${issues.join("، ")}`); return "drafted"; }
  return "approved";
}

// ── Guard ────────────────────────────────────────────────────────
export async function guardCheck(userId: number, p: SocialPlatform) {
  const a = await ensureAccount(userId, p);
  const d = driverFor(p);
  if (!d) return { state: a.state, changed: false, note: "لا سائق لهذا الموقع" };
  let r: { state: string; username?: string; note?: string };
  try { r = await d.loginState(await pageFor(userId, a)); }
  catch (err: any) { r = { state: "unknown", note: String(err?.message ?? err).slice(0, 140) }; }
  await record(userId, p, "guard", "login_check", { detail: r.state });
  const changed = r.state !== a.state;
  await db.update(socialAccountsTable).set({ state: r.state, stateNote: r.note ?? null, lastCheckAt: new Date(), username: r.username ?? a.username }).where(eq(socialAccountsTable.id, a.id));
  if (changed && ["restricted", "checkpoint", "logged_out"].includes(r.state)) {
    const P = PLATFORM[p];
    const msg = r.state === "restricted" ? `${P.labelAr} قيّد النشاط. أوقفت كل شيء.` : r.state === "checkpoint" ? `${P.labelAr} يطلب تأكيد هويتك. افتح النافذة وأكمله بنفسك.` : "الحساب خرج من الجلسة. سجّل دخولك من صفحة الحساب.";
    await activity(userId, p, "guard", "alert", msg);
    await notify(userId, [`<b>🛡️ حارس ${esc(P.labelAr)}</b>`, esc(msg), r.note ? esc(r.note) : ""].filter(Boolean).join("\n"), p).catch(() => {});
  }
  return { state: r.state, note: r.note, changed };
}

// ── Watching ─────────────────────────────────────────────────────
const discovered = new Map<string, number>();

/** Our own newest posts join the watch list by themselves, twice a day. */
export async function discoverPosts(userId: number, p: SocialPlatform, force = false) {
  const a = await account(userId, p);
  const d = driverFor(p);
  const key = `${userId}:${p}`;
  if (!a?.username || !d || (!force && Date.now() - (discovered.get(key) ?? 0) < 12 * 3_600_000)) return 0;
  discovered.set(key, Date.now());
  const posts = await d.myPosts(await pageFor(userId, a), a.username, 6).catch(() => []);
  let added = 0;
  for (const x of posts) {
    const r = await db.insert(socialPostsTable).values({ userId, platform: p, externalId: x.externalId, url: x.url }).onConflictDoNothing().returning({ id: socialPostsTable.id });
    added += r.length;
  }
  await record(userId, p, "watcher", "discover_posts", { detail: `${posts.length} منشور، ${added} جديد` });
  if (added) await activity(userId, p, "watcher", "discover", `أضفت ${added} منشوراً جديداً للمراقبة`);
  return added;
}

export async function collectComments(userId: number, p: SocialPlatform) {
  const a = await account(userId, p);
  const d = driverFor(p);
  if (!a || !d) return { found: 0, fresh: 0 };
  const posts = await db.select().from(socialPostsTable).where(and(eq(socialPostsTable.userId, userId), eq(socialPostsTable.platform, p), eq(socialPostsTable.watching, true)))
    .orderBy(desc(socialPostsTable.createdAt)).limit(8);
  let found = 0, fresh = 0;
  const page = await pageFor(userId, a);
  for (const post of posts) {
    const r = await d.readComments(page, post.url, 50).catch((e) => ({ comments: [], error: String(e?.message ?? e), caption: null }));
    await record(userId, p, "watcher", "read_comments", { target: post.url, ok: !r.error || r.comments.length > 0, detail: r.error ?? `${r.comments.length} تعليق` });
    found += r.comments.length;
    for (const c of r.comments) {
      // Our own comments come back in the read; they are not for answering.
      if (a.username && c.author.toLowerCase() === a.username.toLowerCase()) continue;
      const row = await db.insert(socialCommentsTable).values({ userId, platform: p, postId: post.id, externalId: c.externalId.slice(0, 300), author: c.author.slice(0, 160), authorUrl: c.authorUrl ?? null, text: c.text })
        .onConflictDoNothing().returning({ id: socialCommentsTable.id });
      fresh += row.length;
    }
    await db.update(socialPostsTable).set({ lastSeenAt: new Date(), commentCount: r.comments.length, caption: r.caption ?? post.caption }).where(eq(socialPostsTable.id, post.id));
    await human(6_000, 15_000);
  }
  if (fresh) await activity(userId, p, "watcher", "collect", `وجدت ${fresh} تعليقاً جديداً على ${posts.length} منشور`);
  return { found, fresh };
}

/** Judge every new comment; draft a reply to those that deserve one. */
export async function processComments(userId: number, p: SocialPlatform, max = 15) {
  const a = await account(userId, p);
  if (!a) return { drafted: 0, skipped: 0 };
  const fresh = await db.select().from(socialCommentsTable).where(and(eq(socialCommentsTable.userId, userId), eq(socialCommentsTable.platform, p), eq(socialCommentsTable.status, "new"))).orderBy(asc(socialCommentsTable.createdAt)).limit(max);
  const recent = (await db.select({ d: socialCommentsTable.draft }).from(socialCommentsTable).where(and(eq(socialCommentsTable.userId, userId), eq(socialCommentsTable.platform, p), eq(socialCommentsTable.status, "replied"))).orderBy(desc(socialCommentsTable.repliedAt)).limit(8)).map((r) => r.d ?? "").filter(Boolean);
  let drafted = 0, skipped = 0;
  for (const c of fresh) {
    const t = await agent.triage(userId, p, c.text, c.author);
    const reply = await agent.draftCommentReply(userId, p, { author: c.author, text: c.text, intent: t.intent }, recent);
    const status = reply ? await settle(userId, p, a, reply, recent) : "skipped";
    await db.update(socialCommentsTable).set({ intent: t.intent, isLead: t.isLead, draft: reply, status, skipReason: reply ? null : t.why || "لا يحتاج رداً" }).where(eq(socialCommentsTable.id, c.id));
    if (reply) { drafted++; recent.unshift(reply); } else skipped++;
    // A commenter who asked about a service is someone to talk to in private.
    if (t.isLead && c.authorUrl) await db.insert(socialTargetsTable).values({ userId, platform: p, handle: c.author.toLowerCase().slice(0, 200), profileUrl: c.authorUrl, source: "comment", note: `علّق: ${c.text.slice(0, 200)}` }).onConflictDoNothing();
  }
  if (drafted || skipped) await activity(userId, p, "writer", "draft", `صنّفت ${fresh.length} تعليقاً وكتبت ${drafted} رداً${skipped ? `، وتركت ${skipped} بلا رد` : ""}`);
  return { drafted, skipped };
}

// ── The inbox ────────────────────────────────────────────────────
/** Read who is waiting, keep what they said, and draft the reply. */
export async function syncInbox(userId: number, p: SocialPlatform, maxThreads = 8) {
  const a = await account(userId, p);
  const d = driverFor(p);
  if (!a || !d) return { threads: 0, received: 0, drafted: 0 };
  const page = await pageFor(userId, a);
  const inbox = await d.readInbox(page, 30).catch((e) => ({ threads: [], error: String(e?.message ?? e) }));
  await record(userId, p, "dm", "read_inbox", { ok: !inbox.error || inbox.threads.length > 0, detail: inbox.error ?? `${inbox.threads.length} محادثة` });
  let received = 0, drafted = 0, opened = 0;
  for (const t of inbox.threads) {
    const handle = t.handle.toLowerCase().slice(0, 200);
    const [existing] = await db.select().from(socialThreadsTable).where(and(eq(socialThreadsTable.userId, userId), eq(socialThreadsTable.platform, p), eq(socialThreadsTable.handle, handle))).limit(1);
    // Only threads with something new are opened: an unread mark, or a preview we have not stored.
    const known = existing ? await db.select({ id: socialMessagesTable.id }).from(socialMessagesTable).where(and(eq(socialMessagesTable.threadId, existing.id), eq(socialMessagesTable.text, t.preview))).limit(1) : [];
    if (existing && !t.unread && known.length) continue;
    if (opened >= maxThreads) break;
    opened++;
    const [thread] = existing ? [existing] : await db.insert(socialThreadsTable).values({ userId, platform: p, handle, displayName: t.name ?? null, threadUrl: t.threadUrl ?? null, origin: "inbound" }).onConflictDoNothing().returning();
    if (!thread) continue;
    const r = await d.readThread(page, { handle, name: t.name ?? thread.displayName, threadUrl: t.threadUrl ?? thread.threadUrl }, 30).catch((e) => ({ messages: [], error: String(e?.message ?? e) }));
    for (const m of r.messages) {
      const ins = await db.insert(socialMessagesTable).values({ userId, platform: p, threadId: thread.id, fromMe: m.fromMe, text: m.text.slice(0, 4_000), status: m.fromMe ? "sent" : "received", hash: hash(m.fromMe, m.text) })
        .onConflictDoNothing().returning({ id: socialMessagesTable.id });
      if (ins.length && !m.fromMe) received++;
    }
    const lastFromThem = r.messages.length ? !r.messages[r.messages.length - 1]!.fromMe : thread.lastFromThem;
    await db.update(socialThreadsTable).set({ lastMessageAt: new Date(), lastFromThem, unread: lastFromThem, threadUrl: (r as any).threadUrl ?? thread.threadUrl, displayName: t.name ?? thread.displayName }).where(eq(socialThreadsTable.id, thread.id));
    // A target who answered is out of the outreach path, whatever they said.
    if (lastFromThem) await db.update(socialTargetsTable).set({ status: "replied", repliedAt: new Date(), nextAt: null, updatedAt: new Date() })
      .where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.handle, handle), inArray(socialTargetsTable.status, ["sent", "invited"])));
    await human(4_000, 9_000);
  }
  drafted = await draftReplies(userId, p);
  if (received) await activity(userId, p, "dm", "inbox", `قرأت ${received} رسالة جديدة في ${opened} محادثة، وكتبت ${drafted} رداً`);
  return { threads: inbox.threads.length, received, drafted };
}

/** Whoever spoke last and is waiting gets a drafted reply — and a temperature. */
export async function draftReplies(userId: number, p: SocialPlatform, max = 10) {
  const a = await account(userId, p);
  if (!a) return 0;
  const waiting = await db.select().from(socialThreadsTable).where(and(eq(socialThreadsTable.userId, userId), eq(socialThreadsTable.platform, p), eq(socialThreadsTable.lastFromThem, true), ne(socialThreadsTable.status, "stopped"))).limit(max);
  let n = 0;
  for (const t of waiting) {
    const pending = await db.select({ id: socialMessagesTable.id }).from(socialMessagesTable).where(and(eq(socialMessagesTable.threadId, t.id), inArray(socialMessagesTable.status, ["drafted", "approved"]))).limit(1);
    if (pending.length) continue;
    const history = (await db.select().from(socialMessagesTable).where(and(eq(socialMessagesTable.threadId, t.id), inArray(socialMessagesTable.status, ["received", "sent"]))).orderBy(asc(socialMessagesTable.createdAt)).limit(40))
      .map((m) => ({ fromMe: m.fromMe, text: m.text }));
    const lastTheirs = history.filter((m) => !m.fromMe).slice(-1)[0]?.text ?? "";
    if (!lastTheirs) continue;
    const tri = await agent.triage(userId, p, lastTheirs, t.displayName ?? t.handle);
    if (tri.intent === "stop") {
      await db.update(socialThreadsTable).set({ status: "stopped", intent: "stop", lastFromThem: false }).where(eq(socialThreadsTable.id, t.id));
      await db.update(socialTargetsTable).set({ status: "declined", nextAt: null, updatedAt: new Date() }).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.handle, t.handle)));
      await activity(userId, p, "qualify", "stop", `@${t.handle} طلب التوقف — لن نراسله مرة أخرى`);
      continue;
    }
    await db.update(socialThreadsTable).set({ intent: tri.intent, temperature: tri.temperature }).where(eq(socialThreadsTable.id, t.id));
    if (tri.temperature === "hot" && t.temperature !== "hot") {
      dealFromHotLead(userId, { channel: p, ref: t.handle, contactName: t.displayName, notes: `${PLATFORM[p].labelAr}: ${lastTheirs.slice(0, 200)}` });
      await activity(userId, p, "qualify", "hot", `🔥 @${t.handle} عميل حار: ${tri.why}`);
      await notify(userId, `<b>🔥 عميل حار على ${esc(PLATFORM[p].labelAr)}</b>\n@${esc(t.handle)}: ${esc(lastTheirs.slice(0, 300))}`, p).catch(() => {});
    }
    const reply = await agent.draftDmReply(userId, p, t.displayName ?? t.handle, history);
    if (!reply) continue;
    const status = await settle(userId, p, a, reply, []);
    await db.insert(socialMessagesTable).values({ userId, platform: p, threadId: t.id, fromMe: true, text: reply, status, kind: "reply", role: roleOf(p, "dm") });
    n++;
  }
  return n;
}

// ── Outreach ─────────────────────────────────────────────────────
async function recentFirsts(userId: number, p: SocialPlatform) {
  return (await db.select({ d: socialTargetsTable.draft }).from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), inArray(socialTargetsTable.status, ["sent", "invited", "replied", "approved"])))
    .orderBy(desc(socialTargetsTable.updatedAt)).limit(10)).map((r) => r.d ?? "").filter(Boolean);
}

/**
 * A first message for the next people on the lists the team works — never
 * anyone else. As many as today's outreach budget can send, and a few more
 * for the owner to choose from.
 */
export async function prepareOutreach(userId: number, p: SocialPlatform, opts: { max?: number; listId?: number } = {}) {
  const a = await account(userId, p);
  if (!a) return 0;
  const lists = opts.listId ? [opts.listId] : (a.listIds ?? []);
  if (!lists.length) return 0;
  const t = await todayCounts(userId, p);
  const room = opts.max ?? Math.max(0, capsFor(p, a.caps).outreach - t.used.outreach) + 3;
  const queued = await db.select({ n: sql<number>`count(*)` }).from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), inArray(socialTargetsTable.status, ["drafted", "approved"])));
  const want = Math.max(0, room - Number(queued[0]?.n ?? 0));
  if (!want) return 0;
  const next = await db.select().from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.status, "new"), inArray(socialTargetsTable.listId, lists)))
    .orderBy(asc(socialTargetsTable.createdAt)).limit(want);
  const recent = await recentFirsts(userId, p);
  let n = 0;
  for (const x of next) {
    const draft = await agent.draftFirstMessage(userId, p, x, recent);
    if (!draft) continue;
    const status = await settle(userId, p, a, draft, recent);
    await db.update(socialTargetsTable).set({ draft, status, updatedAt: new Date() }).where(eq(socialTargetsTable.id, x.id));
    recent.unshift(draft);
    n++;
  }
  if (n) await activity(userId, p, "prospector", "draft", `كتبت ${n} رسالة أولى لأشخاص من القوائم المختارة${a.mode === "auto" ? "" : " — تنتظر موافقتك"}`);
  return n;
}

/** The one follow-up, for whoever has not answered the first message. */
export async function prepareFollowups(userId: number, p: SocialPlatform, max = 10) {
  const a = await account(userId, p);
  if (!a) return 0;
  const due = await db.select().from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.status, "sent"), eq(socialTargetsTable.followups, 0), lte(socialTargetsTable.nextAt, new Date()))).limit(max);
  let n = 0;
  for (const x of due) {
    if (!x.threadId) continue;
    const already = await db.select({ id: socialMessagesTable.id }).from(socialMessagesTable).where(and(eq(socialMessagesTable.threadId, x.threadId), eq(socialMessagesTable.kind, "followup"))).limit(1);
    if (already.length) continue;
    const text = await agent.draftFollowup(userId, p, x, x.draft ?? "");
    if (!text) continue;
    const status = await settle(userId, p, a, text, []);
    await db.insert(socialMessagesTable).values({ userId, platform: p, threadId: x.threadId, fromMe: true, text, status, kind: "followup", role: roleOf(p, "followup") });
    n++;
  }
  if (n) await activity(userId, p, "followup", "draft", `كتبت ${n} متابعة — الأخيرة لكل واحد منهم`);
  return n;
}

// ── Sending ──────────────────────────────────────────────────────
export type SendResult = { sent: number; failed: number; held: string | null };

/** Whatever is approved, in order of who has waited longest for us, inside the gate. */
export async function sendApproved(userId: number, p: SocialPlatform, max = 12): Promise<SendResult> {
  const a = await account(userId, p);
  const d = driverFor(p);
  if (!a || !d) return { sent: 0, failed: 0, held: "لا حساب" };
  if (a.dryRun) return { sent: 0, failed: 0, held: "وضع التجربة — لا يُرسل شيء" };
  const page = await pageFor(userId, a);
  let sent = 0, failed = 0, held: string | null = null;
  const stop = (g: Gate) => { held = g.reason ?? "موقوف"; return !g.allowed; };

  // 1. Replies to people who wrote to us.
  const replies = await db.select({ m: socialMessagesTable, t: socialThreadsTable }).from(socialMessagesTable).innerJoin(socialThreadsTable, eq(socialThreadsTable.id, socialMessagesTable.threadId))
    .where(and(eq(socialMessagesTable.userId, userId), eq(socialMessagesTable.platform, p), eq(socialMessagesTable.status, "approved"))).orderBy(asc(socialMessagesTable.createdAt)).limit(max);
  for (const { m, t } of replies) {
    if (sent >= max) break;
    const kind: ActionKind = m.kind === "followup" ? "followup" : "dm";
    if (t.status === "stopped" || (m.kind === "followup" && (await stillSilent(userId, p, t.handle)) === false)) {
      await db.update(socialMessagesTable).set({ status: "skipped", error: "ردّ أو طلب التوقف قبل الإرسال" }).where(eq(socialMessagesTable.id, m.id));
      continue;
    }
    if (!(await onDuty(userId, roleOf(p, kind === "followup" ? "followup" : "dm")))) continue;
    if (stop(await gate(userId, p, kind))) break;
    const r = await d.sendDm(page, { handle: t.handle, threadUrl: t.threadUrl, name: t.displayName }, m.text, { fresh: false }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    await record(userId, p, kind === "followup" ? "followup" : "dm", kind === "followup" ? "followup_dm" : "send_dm", { target: t.handle, ok: r.ok, detail: r.ok ? m.text.slice(0, 120) : r.error });
    await db.update(socialMessagesTable).set(r.ok ? { status: "sent", sentAt: new Date(), hash: hash(true, m.text) } : { error: r.error ?? "فشل" }).where(eq(socialMessagesTable.id, m.id));
    if (r.ok) {
      sent++;
      await db.update(socialThreadsTable).set({ lastFromThem: false, unread: false, lastMessageAt: new Date() }).where(eq(socialThreadsTable.id, t.id));
      if (m.kind === "followup") await db.update(socialTargetsTable).set({ followups: 1, nextAt: null, updatedAt: new Date() }).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.handle, t.handle)));
    } else { failed++; if (/تحقق|قيّدت/.test(r.error ?? "")) { held = r.error!; break; } }
  }

  // 2. Public replies to comments.
  if (!held) {
    const comments = await db.select({ c: socialCommentsTable, url: socialPostsTable.url }).from(socialCommentsTable).innerJoin(socialPostsTable, eq(socialPostsTable.id, socialCommentsTable.postId))
      .where(and(eq(socialCommentsTable.userId, userId), eq(socialCommentsTable.platform, p), eq(socialCommentsTable.status, "approved"))).orderBy(asc(socialCommentsTable.createdAt)).limit(max);
    for (const { c, url } of comments) {
      if (sent >= max || !c.draft) break;
      if (stop(await gate(userId, p, "reply"))) break;
      const r = await d.replyToComment(page, url, { author: c.author, text: c.text }, c.draft).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      await record(userId, p, "writer", "reply_comment", { target: c.author, ok: r.ok, detail: r.ok ? c.draft.slice(0, 120) : r.error });
      await db.update(socialCommentsTable).set(r.ok ? { status: "replied", repliedAt: new Date() } : { skipReason: r.error ?? "فشل" }).where(eq(socialCommentsTable.id, c.id));
      if (r.ok) sent++; else { failed++; if (/تحقق|قيّدت/.test(r.error ?? "")) { held = r.error!; break; } }
    }
  }

  // 3. First messages to the owner's chosen people.
  if (!held && (await onDuty(userId, roleOf(p, "prospector")))) {
    const targets = await db.select().from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.status, "approved"))).orderBy(asc(socialTargetsTable.updatedAt)).limit(max);
    for (const x of targets) {
      if (sent >= max || !x.draft) break;
      if (stop(await gate(userId, p, "outreach"))) break;
      const r = await d.sendDm(page, { handle: x.handle, profileUrl: x.profileUrl, name: x.name }, x.draft, { fresh: true }).catch((e) => ({ ok: false, error: String(e?.message ?? e) } as any));
      await record(userId, p, "prospector", "outreach_dm", { target: x.handle, ok: r.ok || !!r.unreachable, detail: r.ok ? x.draft.slice(0, 120) : r.error });
      if (r.ok) {
        const [thread] = await db.insert(socialThreadsTable).values({ userId, platform: p, handle: x.handle, displayName: x.name, threadUrl: r.threadUrl ?? null, origin: "outreach", targetId: x.id, lastMessageAt: new Date() })
          .onConflictDoUpdate({ target: [socialThreadsTable.userId, socialThreadsTable.platform, socialThreadsTable.handle], set: { lastMessageAt: new Date(), targetId: x.id } }).returning();
        await db.insert(socialMessagesTable).values({ userId, platform: p, threadId: thread!.id, fromMe: true, text: x.draft, status: "sent", kind: "outreach", role: roleOf(p, "prospector"), sentAt: new Date(), hash: hash(true, x.draft) }).onConflictDoNothing();
        await db.update(socialTargetsTable).set({ status: "sent", sentAt: new Date(), threadId: thread!.id, nextAt: new Date(Date.now() + PLATFORM[p].followupAfterDays * 86_400_000), updatedAt: new Date() }).where(eq(socialTargetsTable.id, x.id));
        sent++;
      } else {
        await db.update(socialTargetsTable).set({ status: r.unreachable ? "unreachable" : "failed", note: r.error ?? null, updatedAt: new Date() }).where(eq(socialTargetsTable.id, x.id));
        if (!r.unreachable) { failed++; if (/تحقق|قيّدت/.test(r.error ?? "")) { held = r.error!; break; } }
      }
    }
  }

  // 4. Posts and comments on others' posts the owner approved.
  if (!held) {
    const content = await db.select().from(socialContentTable).where(and(eq(socialContentTable.userId, userId), eq(socialContentTable.platform, p), eq(socialContentTable.status, "approved"),
      or(isNull(socialContentTable.scheduledAt), lte(socialContentTable.scheduledAt, new Date())))).orderBy(asc(socialContentTable.createdAt)).limit(4);
    for (const c of content) {
      const kind: ActionKind = c.kind === "engage" ? "engage" : "post";
      if (stop(await gate(userId, p, kind))) break;
      const r = kind === "post" ? await d.publish(page, c.text).catch((e) => ({ ok: false, error: String(e?.message ?? e) }))
        : c.targetUrl ? await d.commentOn(page, c.targetUrl, c.text).catch((e) => ({ ok: false, error: String(e?.message ?? e) })) : { ok: false, error: "لا رابط للمنشور" };
      await record(userId, p, "creator", kind === "post" ? "publish_post" : "engage_comment", { target: c.targetUrl ?? "", ok: r.ok, detail: r.ok ? c.text.slice(0, 120) : r.error });
      await db.update(socialContentTable).set(r.ok ? { status: "published", publishedAt: new Date(), url: (r as any).url ?? null } : { status: "failed", error: r.error ?? "فشل" }).where(eq(socialContentTable.id, c.id));
      if (r.ok) sent++; else failed++;
    }
  }

  if (sent || failed) await activity(userId, p, "manager", "send", `أُرسل ${sent}${failed ? `، وفشل ${failed}` : ""}${held ? ` — توقّف: ${held}` : ""}`);
  return { sent, failed, held };
}

async function stillSilent(userId: number, p: SocialPlatform, handle: string) {
  const [x] = await db.select({ s: socialTargetsTable.status }).from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, userId), eq(socialTargetsTable.platform, p), eq(socialTargetsTable.handle, handle))).limit(1);
  return !x || x.s === "sent";
}

// ── A round ──────────────────────────────────────────────────────
const busy = new Set<string>();

export async function runRound(userId: number, p: SocialPlatform) {
  const key = `${userId}:${p}`;
  if (busy.has(key)) return { busy: true };
  busy.add(key);
  try {
    const guard = await guardCheck(userId, p);
    if (guard.state !== "logged_in") return { guard };
    await discoverPosts(userId, p).catch(() => 0);
    const collected = await collectComments(userId, p);
    const processed = await processComments(userId, p);
    const inbox = await syncInbox(userId, p);
    const outreach = await prepareOutreach(userId, p);
    const followups = await prepareFollowups(userId, p);
    const sent = await sendApproved(userId, p);
    await db.update(socialAccountsTable).set({ lastRunAt: new Date() }).where(and(eq(socialAccountsTable.userId, userId), eq(socialAccountsTable.platform, p)));
    return { guard, collected, processed, inbox, outreach, followups, sent };
  } finally { busy.delete(key); }
}

/** Every twenty minutes, for the desks whose autopilot is on. One desk at a time: they share the machine. */
export function startSocial(): void {
  const sweep = async () => {
    const desks = await db.select({ userId: socialAccountsTable.userId, platform: socialAccountsTable.platform }).from(socialAccountsTable)
      .where(and(eq(socialAccountsTable.autopilot, true), inArray(socialAccountsTable.platform, DRIVEN))).catch(() => []);
    for (const { userId, platform } of desks) {
      await runRound(userId, platform as SocialPlatform).catch((err) => logger.error({ userId, platform, err: String(err?.message ?? err) }, "فشلت جولة التواصل الاجتماعي"));
    }
  };
  setTimeout(() => { void sweep(); setInterval(() => void sweep(), 20 * 60_000); }, 6 * 60_000);
  logger.info("مكاتب التواصل الاجتماعي بدأت");
}
