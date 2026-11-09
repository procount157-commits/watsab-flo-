// ── سلامة طابور البريد ────────────────────────────────────────────
// ثلاثة أشياء لا يقولها المصرف: أن رسالةً انتظرت أسبوعين قد لا تصلح الآن، وأن موجةً قد
// تسبق رسالة مكتب الحسابات الشخصية فتؤخرها خمسة أيام بفاصل الشركة (٤ من ٩ يوم ٩ نوفمبر)،
// وأن شركةً واحدة قد تكون في حملتين نشطتين.
//
// قرار صاحب العمل: ما انتظر أكثر من أسبوع لا يخرج وحده، أيّاً كان نوعه (حملة، متابعة، أو
// مكتب). يبقى queued، ويمسكه شرط المصرف، حتى يُفرج عنه بعد إعادة التقييم. وما دون الأسبوع
// لا يُمسّ هنا أبداً.
//
// لا إلغاء جماعي: queueReview يعدّ ولا يمسّ. الإلغاء لما هو قديم وغير مؤهل بوضوح فقط: ردّ،
// طلب إيقاف، ارتدّ، أو ردّت شركته.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { audit } from "./controls";
import { FREE_MAIL } from "../email/service";

export const STALE_DAYS = 7;
const freeList = () => sql.join([...FREE_MAIL].map((d) => sql`${d}`), sql`, `);

// ── حجز مكتب الحسابات ─────────────────────────────────────────────
/** نطاقات اختارها المكتب: ما دام يعمل عليها ثلاثين يوماً، وأبداً إن ردّت أو حُجز اجتماع. */
export const reservedDomains = (userId: number) => sql`(SELECT t.domain FROM target_accounts t WHERE t.user_id = ${userId}
  AND (t.status IN ('replied','meeting') OR (t.status IN ('researching','ready','needs_review','sent') AND t.created_at > now() - interval '30 days')))`;

/**
 * شرط SQL للمصرف: رسالةٌ عادية لا تخرج إلى نطاق له عند المكتب رسالةٌ لم تخرج أو متابعةٌ
 * تنتظر. رسالة المكتب نفسها معفاة. `deskPrefix` بادئة أسماء تسلسلات المكتب.
 */
export const notBlockedByDesk = (contactId: any, sequenceJobId: any, deskPrefix: string) => sql`(
  EXISTS (SELECT 1 FROM email_sequence_jobs dj JOIN email_sequences dq ON dq.id = dj.sequence_id WHERE dj.id = ${sequenceJobId} AND dq.name LIKE ${deskPrefix + "%"})
  OR NOT EXISTS (
    SELECT 1 FROM email_contacts bc JOIN target_accounts bt ON bt.user_id = bc.user_id AND bt.domain = lower(split_part(bc.email, '@', 2))
    WHERE bc.id = ${contactId} AND (bt.status IN ('researching','ready')
      OR (bt.status = 'sent' AND bt.sequence_id IS NOT NULL AND (bt.sent_at IS NULL
        OR EXISTS (SELECT 1 FROM email_sequence_jobs bj WHERE bj.sequence_id = bt.sequence_id AND bj.status = 'pending'))))))`;

/** شرط المصرف: أقدم من أسبوع لا تخرج إلا إن أُفرج عنها. */
export const notHeldStale = (createdAt: any, releasedAt: any) => sql`(${createdAt} >= now() - make_interval(days => ${STALE_DAYS}) OR ${releasedAt} IS NOT NULL)`;

/** أُفرج عنها ثم تُركت مهمتها: تعود ممسوكة. */
export const notFromDeadMission = (campaignId: any, createdAt: any) => sql`NOT (
  ${campaignId} IS NOT NULL AND ${createdAt} < now() - make_interval(days => ${STALE_DAYS})
  AND EXISTS (SELECT 1 FROM email_missions ms WHERE ms.campaign_id = ${campaignId} AND ms.status <> 'active'))`;

// ── الفحص قبل الإرسال ─────────────────────────────────────────────
export type Ineligible = "replied" | "opted_out" | "bounced" | "company_replied";
export const INELIGIBLE_AR: Record<Ineligible, string> = {
  replied: "ألغيت: ردّ قبل أن تخرج رسالته القديمة",
  opted_out: "ألغيت: طلب الإيقاف قبل أن تخرج رسالته القديمة",
  bounced: "ألغيت: عنوانه ارتدّ قبل أن تخرج رسالته القديمة",
  company_replied: "ألغيت: ردّت شركته قبل أن تخرج رسالته القديمة",
};
const isOld = (createdAt: Date | string, now = Date.now()) => now - new Date(createdAt).getTime() > STALE_DAYS * 86_400_000;
export const staleMessage = isOld;

/** لماذا لا تخرج — أو null. الترتيب من الأقوى. Pure. */
export function ineligibleReason(f: { contactStatus?: string | null; repliedAt?: Date | string | null; companyReplied?: boolean }): Ineligible | null {
  if (f.contactStatus === "unsubscribed" || f.contactStatus === "complained") return "opted_out";
  if (f.contactStatus === "bounced" || f.contactStatus === "invalid") return "bounced";
  if (f.repliedAt) return "replied";
  if (f.companyReplied) return "company_replied";
  return null;
}

/** المصرف يسأل عن رسالةٍ أقدم من أسبوع قبل أن يرسلها. */
export async function staleIneligible(userId: number, contact: { email: string; status: string; lastRepliedAt?: Date | string | null }): Promise<Ineligible | null> {
  const direct = ineligibleReason({ contactStatus: contact.status, repliedAt: contact.lastRepliedAt });
  if (direct) return direct;
  const domain = String(contact.email).toLowerCase().split("@")[1] ?? "";
  if (!domain || FREE_MAIL.has(domain)) return null;
  const [r] = (await db.execute(sql`SELECT 1 FROM email_inbound i WHERE i.user_id = ${userId} AND lower(split_part(i.from_email, '@', 2)) = ${domain}
    AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true) LIMIT 1`)).rows;
  return r ? "company_replied" : null;
}

// ── التقرير ───────────────────────────────────────────────────────
const QUEUED = (userId: number) => sql`
  WITH q AS (
    SELECT m.id, m.campaign_id, m.sequence_job_id, m.created_at, m.stale_released_at, lower(split_part(m.to_email, '@', 2)) AS domain,
           c.status AS cstatus, c.last_replied_at, cp.mission_id, ms.name AS mission_name, ms.status AS mission_status, cp.name AS campaign_name, cp.status AS campaign_status
    FROM email_messages m
    LEFT JOIN email_contacts c ON c.id = m.contact_id
    LEFT JOIN email_campaigns cp ON cp.id = m.campaign_id
    LEFT JOIN email_missions ms ON ms.id = cp.mission_id
    WHERE m.user_id = ${userId} AND m.status = 'queued'),
  x AS (
    SELECT q.*, CASE
        WHEN q.cstatus IN ('unsubscribed','complained') THEN 'opted_out'
        WHEN q.cstatus IN ('bounced','invalid') THEN 'bounced'
        WHEN q.last_replied_at IS NOT NULL THEN 'replied'
        WHEN q.domain NOT IN (${freeList()}) AND EXISTS (SELECT 1 FROM email_inbound i WHERE i.user_id = ${userId} AND lower(split_part(i.from_email, '@', 2)) = q.domain
             AND coalesce(i.kind, 'reply') = 'reply' AND coalesce(i.solicited, true)) THEN 'company_replied'
      END AS ineligible
    FROM q)`;

export interface QueueReview {
  total: number;
  age: { under7: number; d7to14: number; d14to30: number; over30: number; oldest: unknown };
  ineligible: Record<Ineligible, number>;
  /** أقدم من أسبوع ومؤهلة، ممسوكة في الطابور تنتظر /queue-review/release. */
  heldStale: number;
  /** أقدم من أسبوع ومهمتها تُركت: ممسوكة، والإفراج لا يخرجها. */
  heldDeadMission: number;
  /** أقدم من أسبوع وأُفرج عنها: تخرج بدورها. */
  released: number;
  duplicates: { companies: number; extraMessages: number; top: Array<{ domain: string; messages: number; campaigns: number }> };
  byMission: Array<{ missionId: number | null; name: string; status: string | null; queued: number; stale: number; ineligible: number }>;
}

export async function queueReview(userId: number): Promise<QueueReview> {
  const [a] = (await db.execute<any>(sql`${QUEUED(userId)}
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS under7,
      count(*) FILTER (WHERE created_at <= now() - interval '7 days' AND created_at > now() - interval '14 days')::int AS d7,
      count(*) FILTER (WHERE created_at <= now() - interval '14 days' AND created_at > now() - interval '30 days')::int AS d14,
      count(*) FILTER (WHERE created_at <= now() - interval '30 days')::int AS d30,
      min(created_at) AS oldest,
      count(*) FILTER (WHERE ineligible = 'replied')::int AS replied, count(*) FILTER (WHERE ineligible = 'opted_out')::int AS opted_out,
      count(*) FILTER (WHERE ineligible = 'bounced')::int AS bounced, count(*) FILTER (WHERE ineligible = 'company_replied')::int AS company_replied,
      count(*) FILTER (WHERE ineligible IS NULL AND created_at <= now() - interval '7 days' AND stale_released_at IS NULL AND coalesce(mission_status, 'active') = 'active')::int AS stale_ok,
      count(*) FILTER (WHERE ineligible IS NULL AND created_at <= now() - interval '7 days' AND coalesce(mission_status, 'active') <> 'active')::int AS held,
      count(*) FILTER (WHERE ineligible IS NULL AND created_at <= now() - interval '7 days' AND stale_released_at IS NOT NULL AND coalesce(mission_status, 'active') = 'active')::int AS released
    FROM x`)).rows;
  const dups = (await db.execute<any>(sql`${QUEUED(userId)}
    SELECT domain, count(*)::int AS messages, count(DISTINCT campaign_id)::int AS campaigns FROM x
    WHERE domain NOT IN (${freeList()}) GROUP BY domain HAVING count(*) > 1 ORDER BY count(*) DESC, domain`)).rows;
  const missions = (await db.execute<any>(sql`${QUEUED(userId)}
    SELECT mission_id, coalesce(min(mission_name), min(campaign_name), 'تسلسلات') AS name, min(mission_status) AS status, count(*)::int AS queued,
      count(*) FILTER (WHERE created_at <= now() - interval '7 days')::int AS stale, count(*) FILTER (WHERE ineligible IS NOT NULL)::int AS ineligible
    FROM x GROUP BY mission_id ORDER BY count(*) DESC LIMIT 40`)).rows;
  return {
    total: Number(a?.total ?? 0),
    age: { under7: Number(a?.under7 ?? 0), d7to14: Number(a?.d7 ?? 0), d14to30: Number(a?.d14 ?? 0), over30: Number(a?.d30 ?? 0), oldest: a?.oldest ?? null },
    ineligible: { replied: Number(a?.replied ?? 0), opted_out: Number(a?.opted_out ?? 0), bounced: Number(a?.bounced ?? 0), company_replied: Number(a?.company_replied ?? 0) },
    heldStale: Number(a?.stale_ok ?? 0), heldDeadMission: Number(a?.held ?? 0), released: Number(a?.released ?? 0),
    duplicates: {
      companies: dups.length, extraMessages: dups.reduce((n: number, d: any) => n + Number(d.messages) - 1, 0),
      top: dups.slice(0, 20).map((d: any) => ({ domain: d.domain, messages: Number(d.messages), campaigns: Number(d.campaigns) })),
    },
    byMission: missions.map((m: any) => ({ missionId: m.mission_id == null ? null : Number(m.mission_id), name: m.name, status: m.status ?? null, queued: Number(m.queued), stale: Number(m.stale), ineligible: Number(m.ineligible) })),
  };
}

/** يلغي القديم غير المؤهل بوضوح، بسببٍ مكتوب لكل رسالة، ويكتب ذلك في السجل. بيد صاحب العمل فقط، وما دون الأسبوع لا يُمسّ. */
export async function applyQueueReview(userId: number, actor: number | null, scope: { campaignId?: number | null; missionId?: number | null } = {}): Promise<Record<Ineligible, number>> {
  const out: Record<Ineligible, number> = { replied: 0, opted_out: 0, bounced: 0, company_replied: 0 };
  for (const reason of Object.keys(out) as Ineligible[]) {
    const r = await db.execute(sql`${QUEUED(userId)}
      UPDATE email_messages m SET status = 'cancelled', error = ${INELIGIBLE_AR[reason]}
      FROM x WHERE m.id = x.id AND x.ineligible = ${reason} AND m.status = 'queued' AND x.created_at < now() - make_interval(days => ${STALE_DAYS})
        ${scope.campaignId ? sql`AND x.campaign_id = ${scope.campaignId}` : sql``} ${scope.missionId ? sql`AND x.mission_id = ${scope.missionId}` : sql``}`);
    out[reason] = r.rowCount ?? 0;
  }
  await audit({ userId, action: "queue.cleaned", kind: "email", actor, meta: out }).catch(() => {});
  return out;
}

export interface ReleaseResult { released: number; cancelled: Record<Ineligible, number>; stillHeld: { deadMission: number; campaignInactive: number } }

/**
 * إفراج صاحب العمل عن الممسوك، بعد إعادة التقييم: غير المؤهل يُلغى بسببه، وما مهمته متروكة
 * أو حملته غير نشطة يبقى ممسوكاً ويُعدّ، والباقي يخرج بدوره من فلاتر المصرف كلها. النطاق حملةٌ
 * أو مهمةٌ أو الحساب كله. ما دون الأسبوع لا يدخل في أي شرط هنا.
 */
export async function releaseStale(userId: number, scope: { campaignId?: number | null; missionId?: number | null }, actor: number | null): Promise<ReleaseResult> {
  const cancelled = await applyQueueReview(userId, actor, scope);
  const inScope = sql`${scope.campaignId ? sql`AND x.campaign_id = ${scope.campaignId}` : sql``} ${scope.missionId ? sql`AND x.mission_id = ${scope.missionId}` : sql``}`;
  const old = sql`x.ineligible IS NULL AND x.stale_released_at IS NULL AND x.created_at < now() - make_interval(days => ${STALE_DAYS})`;
  const [held] = (await db.execute<{ dead: number; inactive: number }>(sql`${QUEUED(userId)}
    SELECT count(*) FILTER (WHERE coalesce(x.mission_status, 'active') <> 'active')::int AS dead,
           count(*) FILTER (WHERE coalesce(x.mission_status, 'active') = 'active' AND x.campaign_id IS NOT NULL AND x.campaign_status IS DISTINCT FROM 'sending')::int AS inactive
    FROM x WHERE ${old} ${inScope}`)).rows;
  const r = await db.execute(sql`${QUEUED(userId)}
    UPDATE email_messages m SET stale_released_at = now() FROM x
    WHERE m.id = x.id AND ${old} ${inScope} AND m.status = 'queued' AND coalesce(x.mission_status, 'active') = 'active' AND (x.campaign_id IS NULL OR x.campaign_status = 'sending')`);
  const out: ReleaseResult = { released: r.rowCount ?? 0, cancelled, stillHeld: { deadMission: Number(held?.dead ?? 0), campaignInactive: Number(held?.inactive ?? 0) } };
  await audit({ userId, action: "queue.released", kind: "email", actor, meta: { scope, ...out } });
  return out;
}

/** شركاتٌ لها الآن رسالة في حملةٍ نشطة أخرى: لا تدخل حملةً ثانية حتى تنتهي الأولى. */
export async function domainsInOtherCampaigns(userId: number, campaignId: number): Promise<Set<string>> {
  const r = await db.execute<{ domain: string }>(sql`SELECT DISTINCT lower(split_part(m.to_email, '@', 2)) AS domain FROM email_messages m
    JOIN email_campaigns c ON c.id = m.campaign_id
    WHERE m.user_id = ${userId} AND m.status IN ('queued','ab_hold') AND m.campaign_id <> ${campaignId} AND c.status IN ('sending','paused','scheduled')`);
  return new Set(r.rows.map((x) => x.domain));
}
