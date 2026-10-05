// ── شمّة's morning brief ──────────────────────────────────────────
// One Telegram message at the owner's hour (8:00 Gulf by default) instead of a
// tour of fifteen pages: what waits for his approval and where, who turned hot,
// what is late, what is on today, what is broken — the WhatsApp line, a social
// account signed out, a campaign the guard paused, the machine asleep — and
// yesterday's numbers. A section with nothing in it is left out, so a quiet
// morning is a short message.

import { eq, sql } from "drizzle-orm";
import { db, briefSettingsTable, botEmployeesTable } from "@workspace/db";
import { notify, esc } from "./telegram";
import { logger } from "./logger";

const n = (v: unknown) => Number(v ?? 0).toLocaleString("ar-SA");
const gulfNow = (now = new Date()) => new Date(now.getTime() + 4 * 3_600_000);
const PLATFORM_AR: Record<string, string> = { instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن" };
const CHANNEL_AR: Record<string, string> = { whatsapp: "واتساب", email: "البريد", instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن", groups: "القروبات", manual: "يدوي" };

async function one<T = any>(q: ReturnType<typeof sql>): Promise<T> { return ((await db.execute<any>(q)).rows[0] ?? {}) as T; }
async function many<T = any>(q: ReturnType<typeof sql>): Promise<T[]> { return (await db.execute<any>(q)).rows as T[]; }

export async function composeBrief(userId: number, now = new Date()) {
  const day = new Date(now.getTime() - 86_400_000);
  const g = gulfNow(now), todayStart = new Date(Date.UTC(g.getUTCFullYear(), g.getUTCMonth(), g.getUTCDate()) - 4 * 3_600_000), todayEnd = new Date(todayStart.getTime() + 86_400_000);
  const [ap, social, newDeals, late, meetings, obligations, socialDown, paused, sleeps, y] = await Promise.all([
    one(sql`SELECT
      (SELECT count(*) FROM email_missions WHERE user_id = ${userId} AND stage = 'awaiting_approval')::int AS missions,
      (SELECT count(*) FROM email_inbound WHERE user_id = ${userId} AND state = 'drafted')::int AS email_replies,
      (SELECT count(*) FROM wa_group_suggestions WHERE user_id = ${userId} AND status = 'pending')::int AS groups,
      (SELECT count(*) FROM proposals WHERE user_id = ${userId} AND (status = 'draft' OR followup_draft IS NOT NULL))::int AS proposals`),
    many(sql`SELECT platform,
        (SELECT count(*) FROM social_comments c WHERE c.user_id = ${userId} AND c.platform = a.platform AND c.status = 'drafted')::int
      + (SELECT count(*) FROM social_messages m WHERE m.user_id = ${userId} AND m.platform = a.platform AND m.status = 'drafted')::int
      + (SELECT count(*) FROM social_targets t WHERE t.user_id = ${userId} AND t.platform = a.platform AND t.status = 'drafted')::int AS waiting
      FROM social_accounts a WHERE a.user_id = ${userId}`),
    many(sql`SELECT title, channel FROM deals WHERE user_id = ${userId} AND created_at >= ${day.toISOString()}::timestamptz ORDER BY created_at DESC LIMIT 8`),
    one(sql`SELECT
      (SELECT count(*) FROM wa_group_tasks WHERE user_id = ${userId} AND status = 'open' AND due_at < now())::int AS tasks,
      (SELECT count(*) FROM deals WHERE user_id = ${userId} AND stage NOT IN ('won','lost') AND next_at < now())::int AS deals,
      (SELECT count(*) FROM social_threads WHERE user_id = ${userId} AND last_from_them AND status <> 'stopped' AND last_message_at < now() - interval '12 hours')::int AS unanswered`),
    many(sql`SELECT name, company, starts_at FROM client_meetings WHERE user_id = ${userId} AND status = 'booked' AND starts_at >= ${todayStart.toISOString()}::timestamptz AND starts_at < ${todayEnd.toISOString()}::timestamptz ORDER BY starts_at`),
    many(sql`SELECT client_name, title, due_date FROM client_obligations WHERE user_id = ${userId} AND active AND due_date <= (now() + interval '7 days')::date ORDER BY due_date LIMIT 8`),
    many(sql`SELECT platform, state FROM social_accounts WHERE user_id = ${userId} AND (autopilot OR username IS NOT NULL) AND state <> 'logged_in'`),
    many(sql`SELECT name, pause_reason FROM email_campaigns WHERE user_id = ${userId} AND status = 'paused' AND pause_reason IS NOT NULL ORDER BY id DESC LIMIT 3`),
    one(sql`SELECT count(*)::int AS times, coalesce(sum(seconds), 0)::int AS seconds FROM host_sleeps WHERE woke_at >= ${day.toISOString()}::timestamptz`),
    one(sql`SELECT
      (SELECT count(*) FROM auto_reply_log WHERE user_id = ${userId} AND reply IS NOT NULL AND skipped IS NULL AND created_at >= ${day.toISOString()}::timestamptz)::int AS wa_replies,
      (SELECT count(*) FROM email_messages WHERE user_id = ${userId} AND status = 'sent' AND sent_at >= ${day.toISOString()}::timestamptz)::int AS emails,
      (SELECT count(*) FROM email_inbound WHERE user_id = ${userId} AND received_at >= ${day.toISOString()}::timestamptz)::int AS email_in,
      (SELECT count(*) FROM social_actions WHERE user_id = ${userId} AND ok AND action IN ('reply_comment','send_dm','outreach_dm','followup_dm','connect') AND created_at >= ${day.toISOString()}::timestamptz)::int AS social,
      (SELECT count(*) FROM deals WHERE user_id = ${userId} AND won_at >= ${day.toISOString()}::timestamptz)::int AS won`),
  ]);
  let waConnected: boolean | null = null;
  try { const { getSocket } = await import("./whatsapp"); waConnected = !!getSocket(userId); } catch { waConnected = null; }

  const waiting = [
    ap.missions ? `${n(ap.missions)} حملة بريد تنتظر موافقتك` : "",
    ap.email_replies ? `${n(ap.email_replies)} رد بريد جاهز للإرسال` : "",
    ...social.filter((s: any) => s.waiting).map((s: any) => `${n(s.waiting)} في ${PLATFORM_AR[s.platform] ?? s.platform} (ردود ورسائل أولى)`),
    ap.groups ? `${n(ap.groups)} اقتراح رد في القروبات` : "",
    ap.proposals ? `${n(ap.proposals)} عرض سعر أو متابعة` : "",
  ].filter(Boolean);
  const lateLines = [
    late.tasks ? `${n(late.tasks)} طلب عميل متأخر في القروبات` : "",
    late.unanswered ? `${n(late.unanswered)} محادثة على التواصل الاجتماعي بلا رد منذ أكثر من ١٢ ساعة` : "",
    late.deals ? `${n(late.deals)} صفقة فات موعد خطوتها التالية` : "",
  ].filter(Boolean);
  const broken = [
    waConnected === false ? "رقم الواتساب غير متصل — امسح الرمز من «ربط الواتساب»" : "",
    ...socialDown.map((s: any) => `${PLATFORM_AR[s.platform] ?? s.platform}: ${s.state === "restricted" ? "مقيَّد" : s.state === "checkpoint" ? "يطلب تأكيد الهوية" : "خارج الجلسة"}`),
    ...paused.map((c: any) => `حملة «${c.name}» موقوفة: ${String(c.pause_reason).slice(0, 90)}`),
    sleeps.times ? `الجهاز نام ${n(sleeps.times)} مرة (${n(Math.round(sleeps.seconds / 60))} دقيقة) — كل شيء توقف خلالها` : "",
  ].filter(Boolean);
  const when = (d: string | Date) => new Date(d).toLocaleTimeString("ar-AE", { timeZone: "Asia/Dubai", hour: "numeric", minute: "2-digit" });

  const sections: Array<[string, string[]]> = [
    ["⏳ ينتظر موافقتك", waiting],
    ["🔥 صفقات جديدة (٢٤ ساعة)", newDeals.map((d: any) => `${d.title} — ${CHANNEL_AR[d.channel] ?? d.channel}`)],
    ["📅 اليوم", meetings.map((m: any) => `اجتماع ${when(m.starts_at)}: ${m.name}${m.company ? ` — ${m.company}` : ""}`)],
    ["🗓 مواعيد عملاء خلال أسبوع", obligations.map((o: any) => `${o.client_name} — ${o.title}: ${o.due_date}`)],
    ["⏰ متأخر", lateLines],
    ["⚠️ يحتاج تدخلك", broken],
  ];
  const yesterday = `أمس: ${n(y.wa_replies)} رد واتساب · ${n(y.emails)} إيميل أُرسل و${n(y.email_in)} رد وصل · ${n(y.social)} رسالة ورد على التواصل الاجتماعي${y.won ? ` · ${n(y.won)} عميل تعاقد 🎉` : ""}`;
  const body = sections.filter(([, l]) => l.length).map(([h, l]) => `<b>${h}</b>\n${l.map((x) => `• ${esc(x)}`).join("\n")}`);
  const text = [`<b>☀️ صباح الخير — موجز شمّة</b>`, ...body, body.length ? "" : "لا شيء ينتظرك ولا شيء معطّل.", esc(yesterday)].filter((x) => x !== "").join("\n\n");
  return { text, sections: Object.fromEntries(sections), yesterday: y, waConnected };
}

export async function briefSettings(userId: number) {
  const [s] = await db.select().from(briefSettingsTable).where(eq(briefSettingsTable.userId, userId)).limit(1);
  return s ?? { userId, enabled: true, hour: 8, lastSentOn: null };
}

export async function sendBrief(userId: number, now = new Date()) {
  const b = await composeBrief(userId, now);
  const ok = await notify(userId, b.text, "brief").catch(() => false);
  const today = gulfNow(now).toISOString().slice(0, 10);
  await db.insert(briefSettingsTable).values({ userId, lastSentOn: today }).onConflictDoUpdate({ target: briefSettingsTable.userId, set: { lastSentOn: today } });
  return { ok, text: b.text };
}

/** Whether today's brief is due: on, past its hour but not five past it (late is fine, the evening is not), not yet sent today. */
export function briefDue(s: { enabled: boolean; hour: number; lastSentOn: string | null }, now = new Date()) {
  const g = gulfNow(now), today = g.toISOString().slice(0, 10), hour = g.getUTCHours();
  return s.enabled && hour >= s.hour && hour < s.hour + 5 && s.lastSentOn !== today;
}

/** Every ten minutes: anyone whose hour has come and who has not had today's brief gets it. */
export async function sweepBriefs(now = new Date()) {
  const users = await db.selectDistinct({ userId: botEmployeesTable.userId }).from(botEmployeesTable);
  let sent = 0;
  for (const { userId } of users) {
    if (!briefDue(await briefSettings(userId), now)) continue;
    await sendBrief(userId, now).catch((err) => logger.warn({ userId, err: String(err) }, "morning brief failed"));
    sent++;
  }
  return sent;
}

export function startMorningBrief() {
  setInterval(() => void sweepBriefs().catch(() => {}), 10 * 60_000);
}
