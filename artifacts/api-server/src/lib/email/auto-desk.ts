// ── صفحة واحدة: ارفع، أعطِ الهدف، واترك الباقي ─────────────────────
// صاحب العمل قال: «كل اللي هعمله أرفع مجلدات مسمّاة — مقاولات، عقارات —
// وأعطيه هدف: ٥٠ أو ١٠٠ lead في الشهر. هو يختار، ويعمل القوائم والحملات
// والقوالب والمتابعات». والآلة كانت موجودة قطعاً متفرّقة في سبع صفحات:
// الرفع ملفاً ملفاً، والهدف في لوحة المدير، والطيار في إعداداته، والتتبّع
// في الإعدادات. فثقلت.
//
// هنا الجواب عن ثلاثة أسئلة فقط: ماذا عندي (بالقطاع، وهل هو مستهدف)،
// إلى أين أنا من الهدف (والخطة بالأرقام)، وماذا يحتاج مني (موافقات،
// عنوان تتبّع، قوائم أكثر). وكل ما سواها يُدار وحده.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { classifySector } from "./sector";
import { tracksFor, TRACK_AR } from "./policy";
import { getAutopilot } from "./autopilot";
import { trackingState } from "./public-url";
import { managerGoal } from "./manager";
import { GOAL_METRICS } from "./goal-plan";
import { MEASURES } from "../graph/goals";

const rows = <T = any>(r: any): T[] => (r.rows ?? r) as T[];

export interface FolderMap { name: string; sector: string | null; tracks: string[]; targeted: boolean; note: string }

/** اسم المجلد ← القطاع ← هل نستهدفه. يُعرض قبل الرفع، فلا يُرفع مجلدٌ لا يُراسَل وصاحبه يظنّ أنه سيُراسَل. */
export function mapFolder(name: string): FolderMap {
  const n = name.trim();
  const sector = classifySector({ industry: n });
  const tracks = tracksFor(sector);
  return {
    name: n, sector, tracks: tracks.map((t) => TRACK_AR[t]), targeted: tracks.length > 0,
    note: !sector
      ? "لم أعرف القطاع من اسم المجلد — سأصنّف كل شركةٍ باسمها ونشاطها، وما لم يُعرف يُعرض عليك."
      : tracks.length ? `يُراسَل آلياً: ${tracks.map((t) => TRACK_AR[t]).join(" + ")}`
      : "قطاعٌ غير مستهدف — يُحفظ ويُصنَّف ولا يُراسَل آلياً.",
  };
}

/** نهاية الشهر الحالي بتوقيت الإمارات — موعد «هدف هذا الشهر». */
export function endOfMonthUae(now = new Date()): Date {
  const uae = new Date(now.getTime() + 4 * 3_600_000);
  const end = Date.UTC(uae.getUTCFullYear(), uae.getUTCMonth() + 1, 1) - 4 * 3_600_000 - 1;
  // هدفٌ في آخر يومين من الشهر يُعطى للشهر القادم: لا يُقاس في يومين شيء.
  return end - now.getTime() < 2 * 86_400_000 ? endOfMonthUae(new Date(end + 1)) : new Date(end);
}

export async function autoState(userId: number) {
  const [cfg, tracking, goal] = await Promise.all([getAutopilot(userId), trackingState(userId), managerGoal(userId)]);

  // ما عندي: كل مجلد، بقطاعاته، وكم بقي لم يُراسَل.
  const bySector = rows(await db.execute(sql`
    SELECT coalesce(f.name, 'بلا مجلد') AS folder, coalesce(c.sector, 'غير مصنّف') AS sector,
           count(DISTINCT c.id)::int AS total,
           count(DISTINCT c.id) FILTER (WHERE c.status = 'active' AND coalesce(c.mx_ok, true) AND c.last_sent_at IS NULL)::int AS fresh,
           count(DISTINCT c.id) FILTER (WHERE c.last_sent_at IS NOT NULL)::int AS reached,
           count(DISTINCT c.id) FILTER (WHERE c.last_replied_at IS NOT NULL)::int AS replied
    FROM email_lists l
    JOIN email_list_members lm ON lm.list_id = l.id
    JOIN email_contacts c ON c.id = lm.contact_id
    LEFT JOIN list_folders f ON f.id = l.folder_id
    WHERE l.user_id = ${userId} AND l.parent_list_id IS NULL
    GROUP BY 1, 2 ORDER BY 1, 3 DESC`));
  const folders = new Map<string, { name: string; total: number; fresh: number; reached: number; replied: number; sectors: Array<Record<string, unknown>> }>();
  for (const r of bySector) {
    const f = folders.get(r.folder) ?? { name: r.folder, total: 0, fresh: 0, reached: 0, replied: 0, sectors: [] as Array<Record<string, unknown>> };
    const tracks = tracksFor(r.sector);
    f.total += r.total; f.fresh += r.fresh; f.reached += r.reached; f.replied += r.replied;
    f.sectors.push({ sector: r.sector, total: r.total, fresh: r.fresh, reached: r.reached, replied: r.replied, targeted: tracks.length > 0, tracks: tracks.map((t) => TRACK_AR[t]) });
    folders.set(r.folder, f);
  }
  const all = [...folders.values()];
  const readyTargeted = all.flatMap((f) => f.sectors).filter((s) => s["targeted"]).reduce((a, s) => a + Number(s["fresh"]), 0);

  // إلى أين من الهدف: الردود النافعة منذ بدء الهدف.
  let goalView: null | { title: string; metric: string; target: number; current: number; deadline: Date; daysLeft: number; perDay: number } = null;
  if (goal) {
    // المقياس نفسه الذي يقيسه المدير — لا عدٌّ ثانٍ قد يختلف عنه.
    const current = await MEASURES[goal.metric]!.read({ userId, from: goal.startsAt, to: new Date() }).catch(() => 0);
    const daysLeft = Math.max(1, Math.ceil((goal.deadline.getTime() - Date.now()) / 86_400_000));
    goalView = { title: goal.title, metric: GOAL_METRICS[goal.metric].label, target: goal.target, current, deadline: goal.deadline, daysLeft, perDay: Math.ceil(Math.max(0, goal.target - current) / daysLeft) };
  }

  const pending = rows(await db.execute(sql`
    SELECT count(*) FILTER (WHERE status = 'draft')::int AS drafts, count(*) FILTER (WHERE status = 'active')::int AS active
    FROM email_missions WHERE user_id = ${userId}`))[0] ?? { drafts: 0, active: 0 };
  const week = rows(await db.execute(sql`
    SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent, count(*) FILTER (WHERE opened_at IS NOT NULL)::int AS opened,
           count(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied
    FROM email_messages WHERE user_id = ${userId} AND sent_at > now() - interval '7 days'`))[0] ?? {};
  const opensSince = rows(await db.execute(sql`
    SELECT min(created_at) AS at FROM email_events WHERE user_id = ${userId} AND type = 'open'`))[0]?.at ?? null;

  // ما يحتاجه مني — بالترتيب: ما يوقف كل شيء أولاً.
  const needs: string[] = [];
  if (!cfg.enabled) needs.push("الطيار الآلي مُطفأ — لا شيء يُرسَل حتى تشغّله.");
  if (!goal) needs.push("لا هدف — أعطِ عدد الـ leads المطلوب هذا الشهر.");
  if (Number(pending.drafts) > 0 && cfg.mode !== "auto") needs.push(`${pending.drafts} حملة تنتظر موافقتك (أو اختر «آلي كامل»).`);
  if (!tracking.can) needs.push(`الفتح لا يُقاس: ${tracking.why ?? ""}`);
  if (readyTargeted < cfg.waveSize) needs.push(`بقي ${readyTargeted} شركة مستهدفة لم تُراسَل — ارفع مجلدات أكثر (عقارات، ذهب ومجوهرات، محاماة، مقاولات، مطاعم).`);

  return {
    autopilot: { enabled: cfg.enabled, mode: cfg.mode, waveSize: cfg.waveSize, lastRunAt: cfg.lastRunAt },
    tracking: { can: tracking.can, base: tracking.base, why: tracking.why, since: opensSince },
    goal: goalView, folders: all, readyTargeted,
    missions: { drafts: Number(pending.drafts), active: Number(pending.active) },
    week: { sent: Number(week.sent ?? 0), opened: Number(week.opened ?? 0), clicked: Number(week.clicked ?? 0), replied: Number(week.replied ?? 0) },
    needs,
  };
}
