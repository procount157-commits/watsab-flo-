// ── Goals, and the three numbers each one is judged by ───────────
// A goal is the owner's: a number, a deadline, and nothing an employee can
// edit. Each is read through three kinds of measure, because a team pushed
// at one number learns to move the number rather than the business:
//
//   the target    what the team chases            — meetings, clients
//   the counters  what chasing it must not cost   — stops, bounces
//   the anchor    a fact the system cannot write  — a deal the owner marked won
//
// Measures are named here and computed by fixed queries. A goal row names
// one; nothing reaches the database as free SQL from a goal or an agent.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Window = { userId: number; from: Date; to: Date };
type Measure = { label: string; unit?: string; read: (w: Window) => Promise<number> };

const one = async (q: ReturnType<typeof sql>) => Number(((await db.execute<{ n: number }>(q)).rows[0] as any)?.n ?? 0);

export const MEASURES: Record<string, Measure> = {
  // The anchor: the owner marks a deal won; no employee can.
  clients_won: { label: "عملاء موقّعون", read: (w) => one(sql`SELECT count(*)::int AS n FROM deals WHERE user_id = ${w.userId} AND stage = 'won' AND won_at >= ${w.from} AND won_at < ${w.to}`) },
  meetings: { label: "صفقات وصلت لاجتماع أو أبعد", read: (w) => one(sql`SELECT count(*)::int AS n FROM deals WHERE user_id = ${w.userId} AND stage IN ('meeting','proposal','negotiation','won') AND updated_at >= ${w.from} AND updated_at < ${w.to}`) },
  new_leads: { label: "عملاء محتملون جدد في الصفقات", read: (w) => one(sql`SELECT count(*)::int AS n FROM deals WHERE user_id = ${w.userId} AND created_at >= ${w.from} AND created_at < ${w.to}`) },
  wa_replies: { label: "عملاء ردّوا على واتساب (أشخاص لا ردود آلية)", read: (w) => one(sql`SELECT count(DISTINCT phone)::int AS n FROM auto_reply_log WHERE user_id = ${w.userId} AND created_at >= ${w.from} AND created_at < ${w.to} AND coalesce(skipped,'') NOT LIKE 'رد آلي%'`) },
  email_replies: { label: "ردود على الإيميل", read: (w) => one(sql`SELECT count(*)::int AS n FROM email_inbound WHERE user_id = ${w.userId} AND received_at >= ${w.from} AND received_at < ${w.to}`) },
  // Counters: what the chase must not cost.
  stops: { label: "طلبات إيقاف وضغطات «إيقاف الرسائل»", read: (w) => one(sql`SELECT count(*)::int AS n FROM unsubscribed_phones WHERE user_id = ${w.userId} AND created_at >= ${w.from} AND created_at < ${w.to}`) },
  email_bounce_pct: { label: "نسبة ارتداد الإيميل", unit: "%", read: async (w) => {
    const r = (await db.execute<{ sent: number; bounced: number }>(sql`SELECT count(*) FILTER (WHERE status IN ('sent','bounced'))::int AS sent, count(*) FILTER (WHERE status = 'bounced')::int AS bounced
      FROM email_messages WHERE user_id = ${w.userId} AND coalesce(sent_at, created_at) >= ${w.from} AND coalesce(sent_at, created_at) < ${w.to}`)).rows[0] as any;
    return Number(r?.sent) ? Math.round((1000 * Number(r.bounced)) / Number(r.sent)) / 10 : 0;
  } },
};

export type GoalRow = { id: number; title: string; metric: string; target: number; starts_at: Date; deadline: Date; counter_metrics: string[]; anchor: string | null; status: string };

/** Where a goal stands: how far, how fast it has to go now, and what it is costing. Pure over the numbers. */
export function pace(current: number, target: number, start: Date, deadline: Date, now = new Date()) {
  const total = Math.max(1, deadline.getTime() - start.getTime());
  const elapsed = Math.min(total, Math.max(0, now.getTime() - start.getTime()));
  const daysLeft = Math.max(0, Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000));
  const expected = Math.round((target * elapsed) / total * 10) / 10;
  const remaining = Math.max(0, target - current);
  const perWeek = daysLeft ? Math.round((remaining / daysLeft) * 7 * 10) / 10 : remaining;
  const state = current >= target ? "done" : now > deadline ? "missed" : current >= expected ? "on_track" : "behind";
  return { current, target, expected, remaining, daysLeft, perWeek, state } as const;
}

export async function goalsWithProgress(userId: number, now = new Date()) {
  const rows = (await db.execute<GoalRow>(sql`SELECT * FROM goals WHERE user_id = ${userId} AND status = 'active' ORDER BY id`)).rows;
  return Promise.all(rows.map(async (g) => {
    const w = { userId, from: new Date(g.starts_at), to: new Date(Math.min(now.getTime() + 1, new Date(g.deadline).getTime())) };
    const m = MEASURES[g.metric];
    const current = m ? await m.read(w) : 0;
    const counters = await Promise.all((g.counter_metrics ?? []).filter((k) => MEASURES[k]).map(async (k) => ({ key: k, label: MEASURES[k]!.label, unit: MEASURES[k]!.unit ?? "", value: await MEASURES[k]!.read(w) })));
    const leading = await Promise.all(["new_leads", "meetings", "wa_replies", "email_replies"].filter((k) => k !== g.metric).map(async (k) => ({ key: k, label: MEASURES[k]!.label, value: await MEASURES[k]!.read(w) })));
    return { ...g, label: m?.label ?? g.metric, progress: pace(current, g.target, new Date(g.starts_at), new Date(g.deadline), now), counters, leading };
  }));
}

/** The owner sets a goal. Employees have no path here. */
export async function setGoal(userId: number, g: { title: string; metric: string; target: number; deadline: Date; counters?: string[]; anchor?: string | null }) {
  if (!MEASURES[g.metric]) throw new Error(`مقياس غير معروف: ${g.metric}`);
  const r = await db.execute<{ id: number }>(sql`INSERT INTO goals (user_id, title, metric, target, deadline, counter_metrics, anchor)
    VALUES (${userId}, ${g.title}, ${g.metric}, ${g.target}, ${g.deadline}, ${JSON.stringify((g.counters ?? []).filter((k) => MEASURES[k]))}::jsonb, ${g.anchor ?? null}) RETURNING id`);
  return Number(r.rows[0]!.id);
}
