// ── ما أُرسل فعلاً، وكيف كان شكله ─────────────────────────────────
// «سجل الإرسال» الموجود صفٌّ لكل شركة: كم رسالة تلقّت، وآخر عنوان،
// وأين وصلت في سلّم المتابعة. مفيدٌ للمتابعة، وعاجزٌ عن السؤال الذي
// يسأله صاحب العمل: أيّ رسالةٍ خرجت من هنا، ومتى، وكيف كانت تُقرأ في
// بريد المستلم.
//
// والجسم لا يُخزَّن مع الرسالة — العمود غير موجود، وتخزينه لثمانية آلاف
// رسالةٍ تكرارٌ لنصٍّ واحد. فالمعاينة تُعاد بناءً: جسم الحملة نفسه،
// ومتغيّرات الجهة نفسها، ورمز التتبّع نفسه، وهوية الشركة نفسها، عبر
// `renderEmail` ذاتها التي أرسلت. فما يُعرض هو ما وصل حرفاً بحرف —
// ومعه ما لم يصل: البكسل الغائب يظهر غائباً.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, emailMessagesTable, emailContactsTable, emailCampaignsTable,
  emailSequencesTable, emailSequenceJobsTable, emailEventsTable, type EmailStep,
} from "@workspace/db";
import { renderEmail, personalize } from "./tracking";
import { brandOf } from "./layout";
import { getSettings, varsFor } from "./service";
import { publicBase } from "./public-url";

const SECRET = () => process.env["SESSION_SECRET"] ?? "wam";

export type SentFilter = "all" | "opened" | "clicked" | "replied" | "bounced" | "failed" | "unopened";

const WHERE: Record<Exclude<SentFilter, "all">, ReturnType<typeof sql>> = {
  opened:   sql`m.opened_at IS NOT NULL`,
  clicked:  sql`m.clicked_at IS NOT NULL`,
  replied:  sql`m.replied_at IS NOT NULL`,
  bounced:  sql`m.bounced_at IS NOT NULL`,
  failed:   sql`m.status = 'failed'`,
  unopened: sql`m.sent_at IS NOT NULL AND m.opened_at IS NULL`,
};

/**
 * صفٌّ لكل رسالةٍ خرجت — لا لكل شركة. مع من استلمها، ومن أي حملة، وما
 * حدث لها بعد الإرسال.
 */
export async function sentList(userId: number, opts: {
  filter?: SentFilter; q?: string; campaignId?: number | null;
  page?: number; limit?: number;
} = {}) {
  const limit = Math.min(200, opts.limit ?? 50), offset = (opts.page ?? 0) * limit;
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  // `sql``` الفارغة كائنٌ صادق، فـ `filter ? sql`AND ${filter}` : …` كان
  // يُخرج «AND» بلا شيء بعدها ويُفسد الاستعلام. الشرط على المفتاح نفسه.
  const named = opts.filter && opts.filter !== "all" ? opts.filter : null;
  const where = sql`m.user_id = ${userId} AND (m.sent_at IS NOT NULL OR m.status = 'failed')
    ${q ? sql`AND (m.to_email ILIKE ${q} OR m.subject ILIKE ${q} OR c.company ILIKE ${q})` : sql``}
    ${opts.campaignId ? sql`AND m.campaign_id = ${opts.campaignId}` : sql``}
    ${named ? sql`AND ${WHERE[named]}` : sql``}`;

  const [rows, count] = await Promise.all([
    db.execute<any>(sql`
      SELECT m.id, m.to_email AS "toEmail", m.subject, m.status, m.sent_at AS "sentAt",
        m.opened_at AS "openedAt", m.open_count AS "opens", m.clicked_at AS "clickedAt", m.click_count AS "clicks",
        m.replied_at AS "repliedAt", m.bounced_at AS "bouncedAt", m.error, m.variant,
        c.company, c.name AS "contactName", c.sector, c.city,
        cp.id AS "campaignId", cp.name AS "campaignName",
        sq.name AS "sequenceName", j.step_index AS "stepIndex"
      FROM email_messages m
      LEFT JOIN email_contacts c       ON c.id = m.contact_id
      LEFT JOIN email_campaigns cp     ON cp.id = m.campaign_id
      LEFT JOIN email_sequence_jobs j  ON j.id = m.sequence_job_id
      LEFT JOIN email_sequences sq     ON sq.id = j.sequence_id
      WHERE ${where}
      ORDER BY m.sent_at DESC NULLS LAST, m.id DESC
      LIMIT ${limit} OFFSET ${offset}`),
    db.execute<any>(sql`SELECT count(*)::int AS n FROM email_messages m LEFT JOIN email_contacts c ON c.id = m.contact_id WHERE ${where}`),
  ]);
  const list = (rows as any).rows ?? rows;
  const total = (((count as any).rows ?? count)[0]?.n) ?? 0;
  return { rows: list, total: Number(total), page: opts.page ?? 0, limit };
}

/** الأرقام فوق الجدول — وكلها من الأحداث، لا من عدّادات الحملة. */
export async function sentSummary(userId: number) {
  const r = await db.execute<any>(sql`
    SELECT
      count(*) FILTER (WHERE sent_at IS NOT NULL)::int           AS sent,
      count(*) FILTER (WHERE status = 'failed')::int             AS failed,
      count(*) FILTER (WHERE opened_at IS NOT NULL)::int         AS opened,
      count(*) FILTER (WHERE clicked_at IS NOT NULL)::int        AS clicked,
      count(*) FILTER (WHERE replied_at IS NOT NULL)::int        AS replied,
      count(*) FILTER (WHERE bounced_at IS NOT NULL)::int        AS bounced,
      count(*) FILTER (WHERE sent_at > now() - interval '24 hours')::int AS last24,
      count(*) FILTER (WHERE sent_at > now() - interval '7 days')::int   AS last7,
      min(sent_at) AS "firstSentAt", max(sent_at) AS "lastSentAt"
    FROM email_messages WHERE user_id = ${userId}`);
  const row = ((r as any).rows ?? r)[0] ?? {};
  return {
    ...row,
    openRate:  row.sent ? Math.round((row.opened  / row.sent) * 1000) / 10 : 0,
    clickRate: row.sent ? Math.round((row.clicked / row.sent) * 1000) / 10 : 0,
    replyRate: row.sent ? Math.round((row.replied / row.sent) * 1000) / 10 : 0,
  };
}

export interface SentPreview {
  id: number;
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  sentAt: Date | null;
  status: string;
  /** هل حملت هذه الرسالة بكسل فتحٍ فعلاً — أي: كان يمكن تتبّعها أصلاً. */
  hadPixel: boolean;
  hadTrackedLinks: boolean;
  /** سبب غياب التتبّع، إن غاب. */
  trackingNote: string | null;
  events: Array<{ type: string; at: Date; url: string | null }>;
  source: string;
}

/**
 * الرسالة كما وصلت المستلم — تُعاد بنفس الدوال التي أرسلتها.
 * وإن كان التتبّع غائباً فالمعاينة تقول ذلك، لا تُخفيه.
 */
export async function sentPreview(userId: number, messageId: number): Promise<SentPreview | null> {
  const [m] = await db.select().from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.id, messageId), eq(emailMessagesTable.userId, userId))).limit(1);
  if (!m) return null;

  const [contact] = m.contactId
    ? await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, m.contactId)).limit(1)
    : [null];
  const s = await getSettings(userId);

  // الجسم من حيث أُخذ وقت الإرسال.
  let html = "", source = "رد مباشر";
  if (m.campaignId) {
    const [c] = await db.select({ html: emailCampaignsTable.html, name: emailCampaignsTable.name })
      .from(emailCampaignsTable).where(eq(emailCampaignsTable.id, m.campaignId)).limit(1);
    html = c?.html ?? ""; source = c?.name ? `حملة: ${c.name}` : "حملة";
  } else if (m.sequenceJobId) {
    const [j] = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.id, m.sequenceJobId)).limit(1);
    const [seq] = j ? await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, j.sequenceId)).limit(1) : [null];
    html = ((seq?.steps as EmailStep[]) ?? [])[j?.stepIndex ?? 0]?.html ?? "";
    source = seq?.name ? `${seq.name} — الخطوة ${(j?.stepIndex ?? 0) + 1}` : "متابعة";
  }

  const base = await publicBase(userId);
  const vars = varsFor(contact, s);
  const tracking = !!s?.tracking;
  const track = { base, token: m.token, secret: SECRET(), pixel: tracking, links: tracking };
  const rendered = html
    ? renderEmail(html + (s?.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), vars, track,
        { base, token: m.token, fromName: s?.fromName ?? s?.fromEmail ?? "", fromEmail: s?.fromEmail ?? "" }, brandOf(s))
    : { html: "<p style='font:14px Arial'>لا جسم محفوظ لهذه الرسالة — رُدّ عليها مباشرة من صندوق الوارد.</p>", text: "" };

  const ev = await db.select({ type: emailEventsTable.type, at: emailEventsTable.createdAt, url: emailEventsTable.url })
    .from(emailEventsTable).where(eq(emailEventsTable.messageId, m.id)).orderBy(desc(emailEventsTable.createdAt)).limit(40);

  const hadPixel = tracking && !!base;
  return {
    id: m.id, toEmail: m.toEmail, subject: personalize(m.subject ?? "", vars),
    html: rendered.html, text: rendered.text, sentAt: m.sentAt, status: m.status,
    hadPixel, hadTrackedLinks: hadPixel,
    trackingNote: hadPixel ? null
      : !tracking ? "التتبّع مُطفأ في إعدادات البريد — فلا بكسل ولا روابط متتبَّعة في هذه الرسالة."
      : "لا عنوان عام مضبوط: خرجت هذه الرسالة بلا بكسل فتحٍ وبلا روابط متتبَّعة، ولا سبيل لمعرفة إن فُتحت.",
    events: ev as never, source,
  };
}
