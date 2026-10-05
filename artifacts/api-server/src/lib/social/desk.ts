// ── The desk as the owner sees it ─────────────────────────────────
// The dashboard's numbers, the target lists, and the ways a list is filled:
// a search on the platform itself, a file the owner uploads, or names pasted
// one per line.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, socialListsTable, socialTargetsTable, socialThreadsTable } from "@workspace/db";
import { classifySector } from "../email/sector";
import { ACTION_KINDS, PLATFORM, capsFor, personOf, type SocialPlatform } from "./platforms";
import { account, ensureAccount, record, todayCounts } from "./engine";
import { driverFor } from "./drivers";
import { activity, recentActivity, teamStatus } from "./team";
import { openSession } from "../browser-agent";

export async function dashboard(userId: number, p: SocialPlatform, days = 14) {
  const a = await ensureAccount(userId, p);
  const since = new Date(Date.now() - days * 86_400_000);
  const [today, team, act, lists, [k], daily, approvals, hot] = await Promise.all([
    todayCounts(userId, p),
    teamStatus(userId, p),
    recentActivity(userId, p, 50),
    listsWithFunnel(userId, p),
    db.execute<any>(sql`SELECT
      (SELECT count(*) FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND created_at >= ${since})::int AS comments,
      (SELECT count(*) FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND status = 'replied' AND replied_at >= ${since})::int AS replied,
      (SELECT count(*) FROM social_messages WHERE user_id = ${userId} AND platform = ${p} AND NOT from_me AND created_at >= ${since})::int AS received,
      (SELECT count(*) FROM social_targets WHERE user_id = ${userId} AND platform = ${p} AND sent_at >= ${since})::int AS reached,
      (SELECT count(*) FROM social_targets WHERE user_id = ${userId} AND platform = ${p} AND replied_at >= ${since})::int AS answered,
      (SELECT count(*) FROM social_threads WHERE user_id = ${userId} AND platform = ${p} AND temperature = 'hot')::int AS hot,
      (SELECT count(*) FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND is_lead AND created_at >= ${since})::int AS leads`).then((r) => r.rows),
    db.execute<any>(sql`SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE action IN ('send_dm','followup_dm'))::int AS dms,
        count(*) FILTER (WHERE action = 'outreach_dm' OR action = 'connect')::int AS outreach,
        count(*) FILTER (WHERE action = 'reply_comment')::int AS replies
      FROM social_actions WHERE user_id = ${userId} AND platform = ${p} AND ok AND created_at >= ${since} GROUP BY 1 ORDER BY 1`).then((r) => r.rows),
    db.execute<any>(sql`SELECT
      (SELECT count(*) FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND status = 'drafted')::int AS comments,
      (SELECT count(*) FROM social_messages WHERE user_id = ${userId} AND platform = ${p} AND status = 'drafted')::int AS messages,
      (SELECT count(*) FROM social_targets WHERE user_id = ${userId} AND platform = ${p} AND status = 'drafted')::int AS outreach,
      (SELECT count(*) FROM social_content WHERE user_id = ${userId} AND platform = ${p} AND status = 'draft')::int AS content`).then((r) => r.rows[0]),
    db.select().from(socialThreadsTable).where(and(eq(socialThreadsTable.userId, userId), eq(socialThreadsTable.platform, p), inArray(socialThreadsTable.temperature, ["hot", "warm"]))).orderBy(desc(socialThreadsTable.lastMessageAt)).limit(10),
  ]);
  return {
    platform: p, label: PLATFORM[p].labelAr, driven: !!driverFor(p),
    account: a, caps: capsFor(p, a.caps), today: today.used, fails: today.fails, pace: PLATFORM[p].pace, firstContact: PLATFORM[p].firstContact,
    kpi: k, daily, approvals, team, activity: act, lists, hot,
  };
}

// ── Lists ────────────────────────────────────────────────────────
export async function listsWithFunnel(userId: number, p: SocialPlatform) {
  const r = await db.execute<any>(sql`
    SELECT l.*,
      count(t.id)::int AS total,
      count(t.id) FILTER (WHERE t.status IN ('drafted','approved'))::int AS queued,
      count(t.id) FILTER (WHERE t.status IN ('sent','invited','replied','declined'))::int AS reached,
      count(t.id) FILTER (WHERE t.status = 'replied')::int AS replied,
      count(t.id) FILTER (WHERE t.status IN ('unreachable','failed','skipped','declined'))::int AS dropped
    FROM social_lists l LEFT JOIN social_targets t ON t.list_id = l.id
    WHERE l.user_id = ${userId} AND l.platform = ${p}
    GROUP BY l.id ORDER BY l.created_at DESC`);
  return r.rows;
}

export async function createList(userId: number, p: SocialPlatform, name: string, opts: { sector?: string | null; query?: string | null } = {}) {
  const [l] = await db.insert(socialListsTable).values({ userId, platform: p, name: name.slice(0, 160), sector: opts.sector ?? null, query: opts.query ?? null }).returning();
  return l!;
}

export type TargetInput = { handle?: string; url?: string; name?: string; headline?: string; company?: string; city?: string; note?: string };

/** People into a list, once each per platform; a person already reached keeps their history. */
export async function addTargets(userId: number, p: SocialPlatform, listId: number, rows: TargetInput[], source: "search" | "import" | "manual") {
  let added = 0, invalid = 0, duplicate = 0;
  for (const r of rows) {
    const who = personOf(p, r.url || r.handle || "");
    if (!who) { invalid++; continue; }
    const sector = classifySector({ industry: r.headline ?? null, company: r.company ?? null, name: r.name ?? null });
    const ins = await db.insert(socialTargetsTable).values({
      userId, platform: p, listId, handle: who.handle, profileUrl: who.profileUrl, source,
      name: r.name?.slice(0, 200) ?? null, headline: r.headline ?? null, company: r.company?.slice(0, 200) ?? null, city: r.city?.slice(0, 80) ?? null, note: r.note ?? null, sector,
    }).onConflictDoNothing().returning({ id: socialTargetsTable.id });
    if (ins.length) added++; else duplicate++;
  }
  return { added, invalid, duplicate };
}

/** A search on the platform itself, as the signed-in account sees it, into a new list. */
export async function searchIntoList(userId: number, p: SocialPlatform, query: string, max = 30, listId?: number) {
  const d = driverFor(p);
  if (!d) throw new Error(`البحث في ${PLATFORM[p].labelAr} غير متاح بعد`);
  const a = await account(userId, p);
  if (!a || a.state !== "logged_in") throw new Error("سجّل دخول الحساب أولاً من صفحة الحساب");
  const page = (await openSession(userId, a.profile)).page;
  const r = await d.search(page, query, Math.min(60, max));
  await record(userId, p, "prospector", "search", { target: query, ok: !r.error || r.people.length > 0, detail: r.error ?? `${r.people.length} نتيجة` });
  if (!r.people.length) throw new Error(r.error ?? "لا نتائج");
  const list = listId ? { id: listId } : await createList(userId, p, `بحث: ${query}`, { query, sector: classifySector({ hint: query }) });
  const res = await addTargets(userId, p, list.id, r.people.map((x) => ({ url: x.profileUrl, handle: x.handle, name: x.name, headline: x.headline, city: x.city })), "search");
  await activity(userId, p, "prospector", "search", `بحثت عن «${query}» ووجدت ${r.people.length} — أضفت ${res.added} للقائمة`);
  return { listId: list.id, found: r.people.length, ...res };
}

/** Rows from an uploaded sheet: whichever column holds the link or handle, and the name and company when there. */
export function rowsFromSheet(p: SocialPlatform, rows: Array<Record<string, unknown>>): TargetInput[] {
  const host = { instagram: /instagram\.com/i, tiktok: /tiktok\.com/i, linkedin: /linkedin\.com/i }[p];
  return rows.map((r) => {
    const cells = Object.entries(r).map(([k, v]) => [k.toLowerCase(), String(v ?? "").trim()] as const);
    const url = cells.find(([, v]) => host.test(v))?.[1];
    const handle = cells.find(([k]) => /handle|user(name)?|حساب|يوزر|المعرف/.test(k))?.[1];
    const pick = (re: RegExp) => cells.find(([k]) => re.test(k))?.[1] || undefined;
    return { url, handle, name: pick(/^(name|full ?name|الاسم)/), company: pick(/company|شركة|المنشأة/), headline: pick(/title|headline|position|المسمى|الوصف|industry|النشاط/), city: pick(/city|location|المدينة|الإمارة/), note: pick(/note|ملاحظ/) };
  }).filter((x) => x.url || x.handle);
}

export async function stats(userId: number, p: SocialPlatform) {
  const [a, t] = await Promise.all([account(userId, p), todayCounts(userId, p)]);
  return { caps: capsFor(p, a?.caps), used: t.used, kinds: ACTION_KINDS };
}

