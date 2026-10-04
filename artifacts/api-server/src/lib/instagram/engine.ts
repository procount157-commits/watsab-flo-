// ── Running the Instagram desk ────────────────────────────────────
// Watch the posts, judge what arrives, draft a reply, and — once the owner
// allows it — send. Nothing reaches anyone while the account is in dry run,
// which is how it ships: a week of reading the team's drafts costs nothing and
// an account restriction costs the channel.
//
// The pacing is the part that matters. Instagram does not refuse an action it
// dislikes; it accepts it and quietly stops showing your comments to anyone.
// So the limiter is hard, the gaps are random, and the guard stops everything
// on the first sign rather than the third.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  db, instagramAccountsTable, instagramPostsTable, instagramCommentsTable,
  instagramThreadsTable, instagramMessagesTable, instagramActionsTable,
  type InstagramAccount,
} from "@workspace/db";
import { complete } from "../llm";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { loginState, readComments, replyToComment, readInbox, sendDm, human, record } from "./browser";
import { IG_DOCTRINE, IG_TEAM_DEFS, type IgRole } from "./team";

/** The whole team shares one account, so the budget is the account's. */
export const PACE = {
  /** Never two actions closer together than this. */
  minGapMs: 45_000,
  /** And a long pause every so often, because people put the phone down. */
  restEvery: 8,
  restMs: [4 * 60_000, 11 * 60_000] as const,
  /** Outside these Gulf hours nothing goes out: a business that answers at 4am is a bot. */
  hours: [8, 23] as const,
};

export async function account(userId: number): Promise<InstagramAccount | null> {
  const [a] = await db.select().from(instagramAccountsTable)
    .where(eq(instagramAccountsTable.userId, userId)).limit(1);
  return a ?? null;
}

export async function ensureAccount(userId: number, role = "ig_dm"): Promise<InstagramAccount> {
  const existing = await account(userId);
  if (existing) return existing;
  const [a] = await db.insert(instagramAccountsTable).values({ userId, role }).returning();
  return a!;
}

/** What the account has done today, which is what the caps are measured against. */
export async function todayCounts(userId: number) {
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [row] = await db.select({
    replies: sql<number>`count(*) filter (where ${instagramActionsTable.action} = 'reply_comment' and ${instagramActionsTable.ok})`,
    dms:     sql<number>`count(*) filter (where ${instagramActionsTable.action} = 'send_dm' and ${instagramActionsTable.ok})`,
    fails:   sql<number>`count(*) filter (where not ${instagramActionsTable.ok})`,
    last:    sql<Date | null>`max(${instagramActionsTable.createdAt})`,
  }).from(instagramActionsTable)
    .where(and(eq(instagramActionsTable.userId, userId), gte(instagramActionsTable.createdAt, since)));
  return {
    replies: Number(row?.replies ?? 0),
    dms: Number(row?.dms ?? 0),
    fails: Number(row?.fails ?? 0),
    last: row?.last ?? null,
  };
}

export type Gate = { allowed: boolean; reason?: string; waitMs?: number };

/**
 * May the account act right now?
 *
 * Checked before every single action rather than once per run: a restriction
 * that appears mid-run must stop the rest of it, and a run that checked at the
 * start would keep going for an hour into a wall.
 */
export async function mayAct(userId: number, kind: "reply" | "dm"): Promise<Gate> {
  const a = await account(userId);
  if (!a) return { allowed: false, reason: "لم يُضبط حساب إنستجرام بعد" };
  if (a.state === "restricted") return { allowed: false, reason: "إنستجرام قيّد الحساب — كل شيء موقوف حتى يزول" };
  if (a.state === "checkpoint") return { allowed: false, reason: "إنستجرام يطلب تأكيد هويتك — افتح النافذة وأكمله" };
  if (a.state !== "logged_in") return { allowed: false, reason: "الحساب غير مسجّل دخول" };

  const gulfHour = (new Date().getUTCHours() + 4) % 24;
  if (gulfHour < PACE.hours[0] || gulfHour >= PACE.hours[1]) {
    return { allowed: false, reason: `خارج ساعات النشاط (${PACE.hours[0]}–${PACE.hours[1]} بتوقيت الخليج)` };
  }

  const t = await todayCounts(userId);
  // Repeated failures mean the page changed or the account is being throttled.
  // Either way, continuing makes it worse.
  if (t.fails >= 5) return { allowed: false, reason: `${t.fails} محاولات فشلت اليوم — أوقفت النشاط حتى تُراجَع` };

  const cap = kind === "reply" ? a.dailyCommentCap : a.dailyDmCap;
  const used = kind === "reply" ? t.replies : t.dms;
  if (used >= cap) return { allowed: false, reason: `بلغت حد اليوم (${used}/${cap} ${kind === "reply" ? "رد" : "رسالة"})` };

  if (t.last) {
    const gap = Date.now() - new Date(t.last).getTime();
    if (gap < PACE.minGapMs) return { allowed: false, reason: "الفاصل بين الأفعال قصير", waitMs: PACE.minGapMs - gap };
  }
  return { allowed: true };
}

// ── Judging what arrives ─────────────────────────────────────────

const INTENTS = ["question", "interested", "praise", "complaint", "spam", "other"] as const;
export type Intent = typeof INTENTS[number];

async function voiceFor(role: IgRole): Promise<string> {
  const def = IG_TEAM_DEFS.find((d) => d.role === role)!;
  return [`اسمك ${def.name}، ${def.title} لدى بروكاونت للمحاسبة.`, def.persona, "", IG_DOCTRINE].join("\n");
}

/** لمياء's job: what is this comment, and is it worth anything. */
export async function triage(userId: number, text: string, author: string): Promise<{ intent: Intent; isLead: boolean; why: string }> {
  const out = await complete([
    { role: "system", content: [
      await voiceFor("ig_triage"),
      "",
      "صنّفي التعليق التالي. أجيبي بهذا الشكل بالضبط ولا شيء غيره:",
      "النوع: question | interested | praise | complaint | spam | other",
      "فرصة: نعم | لا",
      "السبب: <سطر واحد>",
      "",
      "«ما شاء الله» و«جميل» و«❤️» = praise وليست فرصة.",
      "السؤال عن سعر أو خدمة أو موعد = interested وفرصة.",
      "سؤال عام عن المحتوى = question، وفرصة فقط إن ذكر نشاطه أو مشكلته.",
      "الترويج لحساب آخر أو رابط مشبوه = spam ولا يُرد عليه.",
    ].join("\n") },
    { role: "user", content: `@${author}: ${text}` },
  ], 15_000);

  const t = out?.text ?? "";
  const intent = (INTENTS.find((i) => new RegExp(`النوع\\s*[:：]\\s*${i}`, "i").test(t)) ?? "other") as Intent;
  return {
    intent,
    isLead: /فرصة\s*[:：]\s*نعم/.test(t),
    why: /السبب\s*[:：]\s*(.+)/.exec(t)?.[1]?.trim() ?? "",
  };
}

/** تركي's job: the public reply, or nothing. */
export async function draftReply(
  userId: number, comment: { author: string; text: string; intent: Intent }, recent: string[],
): Promise<string | null> {
  if (comment.intent === "spam") return null;

  const out = await complete([
    { role: "system", content: [
      await voiceFor("ig_writer"),
      "",
      "اكتب الرد العلني على التعليق. سطر أو سطران كحد أقصى.",
      "رُدّ بلهجة صاحب التعليق: عربي خليجي مع العربي، إنجليزي مع الإنجليزي.",
      "لا تذكر سعراً ولا تفاصيل — ادعُه للخاص إن كان سؤاله يحتاج ذلك.",
      "لا تبدأ بـ«شكراً لتواصلك» ولا «يسعدنا». ادخل في الموضوع.",
      recent.length ? `\nردود استعملتها مؤخراً — لا تكررها ولا تقاربها:\n${recent.slice(0, 6).map((r) => `- ${r}`).join("\n")}` : "",
      "",
      "إن كان التعليق مجرد مديح فاكتب رداً قصيراً جداً بلا بيع.",
      "اكتب الرد وحده بلا مقدمات ولا علامات اقتباس.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: `@${comment.author}: ${comment.text}` },
  ], 20_000);

  const reply = out?.text?.trim().replace(/^[«"']|[»"']$/g, "");
  return reply && reply.length > 1 ? reply.slice(0, 400) : null;
}

// ── A round of work ──────────────────────────────────────────────

/** ريّان: find what is new on the watched posts. */
export async function collectComments(userId: number): Promise<{ found: number; fresh: number; error?: string }> {
  const a = await account(userId);
  if (!a) return { found: 0, fresh: 0, error: "لا حساب" };

  const posts = await db.select().from(instagramPostsTable)
    .where(and(eq(instagramPostsTable.userId, userId), eq(instagramPostsTable.watching, true)));
  if (!posts.length) return { found: 0, fresh: 0, error: "لا منشورات متابَعة — أضف رابط منشور أولاً" };

  let found = 0, fresh = 0;
  for (const p of posts) {
    const r = await readComments(userId, a.role, p.url);
    if (r.error && !r.comments.length) continue;
    found += r.comments.length;

    for (const c of r.comments) {
      const [row] = await db.insert(instagramCommentsTable).values({
        userId, postId: p.id, externalId: c.externalId, author: c.author, text: c.text,
      }).onConflictDoNothing().returning();
      if (row) fresh++;
    }
    await db.update(instagramPostsTable)
      .set({ lastSeenAt: new Date(), commentCount: r.comments.length })
      .where(eq(instagramPostsTable.id, p.id));
    // Between posts, not between reads: loading five posts in five seconds is
    // the shape of a scraper.
    await human(6_000, 15_000);
  }
  return { found, fresh };
}

/** لمياء and تركي: judge everything new, draft what deserves a reply. */
export async function processNew(userId: number, max = 15): Promise<{ judged: number; drafted: number; skipped: number }> {
  const rows = await db.select().from(instagramCommentsTable)
    .where(and(eq(instagramCommentsTable.userId, userId), eq(instagramCommentsTable.status, "new")))
    .orderBy(desc(instagramCommentsTable.createdAt))
    .limit(max);

  const recent = (await db.select({ d: instagramCommentsTable.draft })
    .from(instagramCommentsTable)
    .where(and(eq(instagramCommentsTable.userId, userId), eq(instagramCommentsTable.status, "replied")))
    .orderBy(desc(instagramCommentsTable.repliedAt)).limit(10))
    .map((r) => r.d).filter((x): x is string => !!x);

  let judged = 0, drafted = 0, skipped = 0;
  for (const c of rows) {
    const t = await triage(userId, c.text, c.author);
    judged++;

    if (t.intent === "spam") {
      await db.update(instagramCommentsTable)
        .set({ intent: t.intent, status: "skipped", skipReason: "سبام — لا يُرد عليه" })
        .where(eq(instagramCommentsTable.id, c.id));
      skipped++;
      continue;
    }

    const draft = await draftReply(userId, { author: c.author, text: c.text, intent: t.intent }, recent);
    if (!draft) {
      await db.update(instagramCommentsTable)
        .set({ intent: t.intent, isLead: t.isLead, status: "skipped", skipReason: "لا يحتاج رداً" })
        .where(eq(instagramCommentsTable.id, c.id));
      skipped++;
      continue;
    }

    await db.update(instagramCommentsTable)
      .set({ intent: t.intent, isLead: t.isLead, draft, status: "drafted" })
      .where(eq(instagramCommentsTable.id, c.id));
    recent.unshift(draft);
    drafted++;
  }
  return { judged, drafted, skipped };
}

/**
 * Send the approved replies, slowly.
 *
 * Only what the owner approved, and only while the gate allows it. The gate is
 * rechecked between every single one.
 */
export async function sendApproved(userId: number, max = 10): Promise<{ sent: number; held: number; reason?: string }> {
  const a = await account(userId);
  if (!a) return { sent: 0, held: 0, reason: "لا حساب" };
  if (a.dryRun) return { sent: 0, held: 0, reason: "وضع التجربة — لا يُرسل شيء" };

  const rows = await db.select({
    c: instagramCommentsTable, url: instagramPostsTable.url,
  }).from(instagramCommentsTable)
    .innerJoin(instagramPostsTable, eq(instagramPostsTable.id, instagramCommentsTable.postId))
    .where(and(eq(instagramCommentsTable.userId, userId), eq(instagramCommentsTable.status, "approved")))
    .limit(max);

  let sent = 0, held = 0, reason: string | undefined;
  let since = 0;
  for (const { c, url } of rows) {
    const gate = await mayAct(userId, "reply");
    if (!gate.allowed) {
      if (gate.waitMs) { await human(gate.waitMs, gate.waitMs + 15_000); }
      else { reason = gate.reason; held = rows.length - sent; break; }
    }

    const r = await replyToComment(userId, a.role, url, c.author, c.draft!);
    if (r.ok) {
      await db.update(instagramCommentsTable).set({ status: "replied", repliedAt: new Date() })
        .where(eq(instagramCommentsTable.id, c.id));
      sent++;
    } else {
      await db.update(instagramCommentsTable).set({ status: "approved", skipReason: r.error })
        .where(eq(instagramCommentsTable.id, c.id));
      held++;
    }

    if (++since % PACE.restEvery === 0) await human(PACE.restMs[0], PACE.restMs[1]);
    else await human(PACE.minGapMs, PACE.minGapMs * 2);
  }
  return { sent, held, reason };
}

/** ماجد الحارس: is the account still healthy? */
export async function guardCheck(userId: number): Promise<{ state: string; note?: string; changed: boolean }> {
  const a = await account(userId);
  if (!a) return { state: "unknown", changed: false };

  const r = await loginState(userId, a.role);
  const changed = r.state !== a.state;
  await db.update(instagramAccountsTable).set({
    state: r.state, stateNote: r.note ?? null, lastCheckAt: new Date(),
    username: r.username ?? a.username,
  }).where(eq(instagramAccountsTable.id, a.id));

  if (changed && (r.state === "restricted" || r.state === "checkpoint" || r.state === "logged_out")) {
    await notify(userId, [
      `<b>🛡️ ماجد الحارس — حساب إنستجرام</b>`,
      esc(r.state === "restricted" ? "إنستجرام قيّد النشاط. أوقفت كل شيء."
        : r.state === "checkpoint" ? "إنستجرام يطلب تأكيد هويتك. افتح النافذة وأكمله بنفسك."
        : "الحساب خرج من الجلسة. سجّل دخولك من مكتب التصفّح."),
      r.note ? esc(r.note) : "",
    ].filter(Boolean).join("\n"), "instagram").catch(() => {});
    logger.warn({ userId, state: r.state }, "حالة حساب إنستجرام تغيّرت");
  }
  return { state: r.state, note: r.note, changed };
}

/** One full round: check, collect, judge, send. */
export async function runRound(userId: number) {
  const guard = await guardCheck(userId);
  if (guard.state !== "logged_in") {
    return { guard, collected: null, processed: null, sent: null };
  }
  const collected = await collectComments(userId);
  const processed = await processNew(userId);
  const sent = await sendApproved(userId);
  return { guard, collected, processed, sent };
}

/**
 * Every twenty minutes, and only then.
 *
 * Not faster: a desk that checks its comments three times an hour is already
 * more attentive than most businesses, and the budget this spends is measured
 * in account safety rather than in compute.
 */
export function startInstagram(): void {
  const sweep = async () => {
    const accounts = await db.select({ userId: instagramAccountsTable.userId })
      .from(instagramAccountsTable).catch(() => []);
    for (const { userId } of accounts) {
      await runRound(userId).catch((err) =>
        logger.error({ userId, err: String(err?.message ?? err) }, "فشلت جولة إنستجرام"));
    }
  };
  setTimeout(() => { void sweep(); setInterval(() => void sweep(), 20 * 60_000); }, 6 * 60_000);
  logger.info("فريق إنستجرام بدأ");
}
