// ── The follow-up dashboard ───────────────────────────────────────
// What the owner watches while the team works: how many were written to,
// opened, clicked and replied — over the period and by day — how each list
// is moving through its stages, who is hot, what each agent did, and what is
// waiting for the owner's yes. One call, so the page is one request.

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, emailMissionsTable, emailCampaignsTable } from "@workspace/db";
import { getAutopilot, targetLists, STAGES } from "./autopilot";
import { recentActivity, teamStatus } from "./team";
import { getSettings } from "./service";
import { isConfigured } from "./provider";
import { INTENSITY, asIntensity } from "./intensity";

const rate = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export async function dashboard(userId: number, days = 14) {
  days = Math.min(90, Math.max(1, Math.floor(days) || 14));
  const since = sql`now() - make_interval(days => ${days})`;

  const [[k], daily, cfg, team, act, settings] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent,
        count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
        count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked,
        count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
        count(*) FILTER (WHERE status = 'bounced')::int AS bounced,
        count(*) FILTER (WHERE status IN ('queued','ab_hold'))::int AS queued,
        coalesce(sum(open_count), 0)::int AS opens,
        coalesce(sum(click_count), 0)::int AS clicks
      FROM email_messages WHERE user_id = ${userId} AND (sent_at >= ${since} OR status IN ('queued','ab_hold'))`).then((r) => r.rows),
    // Each day: sent, and the opens, clicks and replies that happened that day.
    db.execute<any>(sql`
      WITH d AS (SELECT generate_series((now() - make_interval(days => ${days - 1}))::date, now()::date, '1 day')::date AS day)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        (SELECT count(*) FROM email_messages m WHERE m.user_id = ${userId} AND m.sent_at::date = d.day)::int AS sent,
        (SELECT count(DISTINCT e.message_id) FROM email_events e WHERE e.user_id = ${userId} AND e.type = 'open' AND e.created_at::date = d.day)::int AS opened,
        (SELECT count(DISTINCT e.message_id) FROM email_events e WHERE e.user_id = ${userId} AND e.type = 'click' AND e.created_at::date = d.day)::int AS clicked,
        (SELECT count(*) FROM email_events e WHERE e.user_id = ${userId} AND e.type = 'reply' AND e.created_at::date = d.day)::int AS replied
      FROM d ORDER BY d.day`).then((r) => r.rows),
    getAutopilot(userId),
    teamStatus(userId),
    recentActivity(userId, 60),
    getSettings(userId),
  ]);

  const [unsub] = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM email_events WHERE user_id = ${userId} AND type = 'unsubscribe' AND created_at >= ${since}`)).rows;
  const kpi = {
    sent: k.sent, queued: k.queued, opened: k.opened, clicked: k.clicked, replied: k.replied, bounced: k.bounced, unsubscribed: Number(unsub?.n ?? 0),
    opens: k.opens, clicks: k.clicks,
    openRate: rate(k.opened, k.sent), clickRate: rate(k.clicked, k.sent), replyRate: rate(k.replied, k.sent), bounceRate: rate(k.bounced, k.sent),
  };

  // The lists the team works, each with its stage lists' sizes.
  const targets = await targetLists(userId, cfg);
  const listIds = targets.map((l) => l.id);
  const lists = listIds.length ? (await db.execute<any>(sql`
    SELECT l.id, l.name,
      count(c.id)::int AS total,
      (count(c.id) FILTER (WHERE c.status = 'active' AND coalesce(c.mx_ok, true)))::int AS sendable,
      (count(c.id) FILTER (WHERE c.last_sent_at IS NOT NULL))::int AS reached,
      (count(c.id) FILTER (WHERE c.last_opened_at IS NOT NULL))::int AS opened,
      (count(c.id) FILTER (WHERE EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.clicked_at IS NOT NULL)))::int AS clicked,
      (count(c.id) FILTER (WHERE c.last_replied_at IS NOT NULL))::int AS replied,
      mode() WITHIN GROUP (ORDER BY c.sector) AS sector
    FROM email_lists l LEFT JOIN email_list_members lm ON lm.list_id = l.id LEFT JOIN email_contacts c ON c.id = lm.contact_id
    WHERE l.id IN (${sql.join(listIds.map((i) => sql`${i}`), sql`, `)}) GROUP BY l.id ORDER BY l.name`)).rows : [];
  const stageRows = listIds.length ? (await db.execute<any>(sql`
    SELECT l.id, l.parent_list_id AS parent, l.stage, (SELECT count(*) FROM email_list_members m WHERE m.list_id = l.id)::int AS n
    FROM email_lists l WHERE l.parent_list_id IN (${sql.join(listIds.map((i) => sql`${i}`), sql`, `)})`)).rows : [];

  // Who is worth a call: replied hot or warm, clicked, or opened more than once.
  const hot = (await db.execute<any>(sql`
    SELECT c.id, c.email, c.company, c.name, c.phone, c.sector, c.city, c.tags, c.last_opened_at AS "lastOpenedAt", c.last_replied_at AS "lastRepliedAt",
      coalesce(sum(m.open_count), 0)::int AS opens, coalesce(sum(m.click_count), 0)::int AS clicks,
      greatest(max(m.opened_at), max(m.clicked_at), c.last_replied_at) AS "lastAt",
      (SELECT i.intent FROM email_inbound i WHERE i.contact_id = c.id ORDER BY i.received_at DESC LIMIT 1) AS intent
    FROM email_contacts c LEFT JOIN email_messages m ON m.contact_id = c.id
    WHERE c.user_id = ${userId} AND c.status = 'active'
    GROUP BY c.id
    HAVING c.tags ?| array['hot','warm'] OR coalesce(sum(m.click_count), 0) > 0 OR coalesce(sum(m.open_count), 0) >= 2 OR c.last_replied_at IS NOT NULL
    ORDER BY (c.tags ? 'hot') DESC, (c.last_replied_at IS NOT NULL) DESC, coalesce(sum(m.click_count), 0) DESC, coalesce(sum(m.open_count), 0) DESC
    LIMIT 40`)).rows;

  const [campaigns, approvals] = await Promise.all([
    db.select({ id: emailCampaignsTable.id, name: emailCampaignsTable.name, status: emailCampaignsTable.status, sent: emailCampaignsTable.sentCount, opened: emailCampaignsTable.openCount, clicked: emailCampaignsTable.clickCount, replied: emailCampaignsTable.replyCount, bounced: emailCampaignsTable.bounceCount, createdBy: emailCampaignsTable.createdBy, createdAt: emailCampaignsTable.createdAt })
      .from(emailCampaignsTable).where(eq(emailCampaignsTable.userId, userId)).orderBy(desc(emailCampaignsTable.createdAt)).limit(10),
    db.select({ id: emailMissionsTable.id, name: emailMissionsTable.name, pending: emailMissionsTable.pending, agentRole: emailMissionsTable.agentRole, createdAt: emailMissionsTable.createdAt })
      .from(emailMissionsTable).where(and(eq(emailMissionsTable.userId, userId), eq(emailMissionsTable.stage, "awaiting_approval"), eq(emailMissionsTable.status, "active"))).orderBy(desc(emailMissionsTable.createdAt)).limit(10),
  ]);

  // The sectors in the account's addresses, for choosing which the team works.
  const sectorRows = await db.execute(sql`SELECT sector, count(*)::int AS n,
      count(*) FILTER (WHERE last_sent_at IS NULL AND status = 'active')::int AS unsent
    FROM email_contacts WHERE user_id = ${userId} AND sector IS NOT NULL GROUP BY sector ORDER BY count(*) DESC`).catch(() => ({ rows: [] as any[] }));

  return {
    days, kpi, daily, autopilot: cfg, team, activity: act,
    sectors: sectorRows.rows as Array<{ sector: string; n: number; unsent: number }>,
    lists: lists.map((l: any) => ({ ...l, stages: Object.fromEntries((Object.keys(STAGES) as Array<keyof typeof STAGES>).map((s) => {
      const r = stageRows.find((x: any) => x.parent === l.id && x.stage === s); return [s, r ? { id: r.id, n: r.n } : null];
    })) })),
    hot, campaigns: campaigns.map((c) => ({ ...c, openRate: rate(c.opened, c.sent), clickRate: rate(c.clicked, c.sent), replyRate: rate(c.replied, c.sent) })),
    approvals: approvals.map((a) => ({ id: a.id, name: a.name, agentRole: a.agentRole, subject: (a.pending as any)?.subjects?.[0] ?? null, createdAt: a.createdAt })),
    configured: isConfigured(settings), tracking: !!(process.env["SITE_URL"] ?? "") && !!settings?.tracking,
    language: settings?.defaultLanguage ?? "en",
    path: { intensity: asIntensity(settings?.followIntensity), steps: INTENSITY[asIntensity(settings?.followIntensity)].steps, firstAfterHours: INTENSITY[asIntensity(settings?.followIntensity)].firstAfterHours },
    stageNames: STAGES,
  };
}
