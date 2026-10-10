// ── الخيط: كل ما تبادلناه مع هذه الشركة ───────────────────────────
// المسودة كانت تُكتب على معلومتين: عنوان رسالةٍ واحدة أرسلناها، ونص
// الرسالة التي وصلت الآن. فكان المندوب يعيد تقديم نفسه لمن راسله أربع
// مرات، ويسأل سؤالاً أُجيب في الشهر الماضي، ويلحّ على من قال «سنراجع
// داخلياً ونعود إليكم» بعد ثلاثة أيام.
//
// هذا ما تقرؤه هذه الوحدة: الرسائل التي أرسلناها بنصوصها، وردودهم
// بأنواعها ونيّاتها، مرتّبة، مع الأرقام التي تحكم الخطوة التالية —
// كم أُرسل، كم فُتح، متى آخر لمسة، وهل قالوا موعداً نلتزم به.

import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db, emailMessagesTable, emailInboundTable, emailCampaignsTable,
  emailSequencesTable, emailSequenceJobsTable, emailContactsTable,
} from "@workspace/db";
import { htmlToText, personalize } from "./tracking";
import { INTENT_AR, KIND_AR, type EmailIntent, type MailKind } from "./classify";

export interface ThreadTurn {
  who: "us" | "them";
  at: Date | null;
  subject: string;
  body: string;
  /** للرسائل الصادرة: هل فُتحت ونُقر فيها. السكوت معلومة أيضاً. */
  opened?: number;
  clicked?: number;
  source?: string;
  kind?: MailKind | null;
  intent?: EmailIntent | null;
}

export interface ThreadStats {
  sent: number;
  opens: number;
  clicks: number;
  replies: number;
  /** أيامٌ منذ أول رسالة أرسلناها، ومنذ آخرها، ومنذ آخر ردٍّ منهم. */
  daysSinceFirst: number | null;
  daysSinceLast: number | null;
  daysSinceReply: number | null;
  /** آخر نيّةٍ صرّحوا بها — هي التي تحكم الخطوة، لا آخر رسالةٍ أرسلناها. */
  lastIntent: EmailIntent | null;
  /** صمتٌ تام: أرسلنا ولم يُفتح شيء ولم يردّ أحد. */
  silent: boolean;
}

const DAY = 86_400_000;
const days = (d: Date | null | undefined): number | null => d ? Math.floor((Date.now() - new Date(d).getTime()) / DAY) : null;

/** نصُّ ما أرسلناه فعلاً — من جسم الحملة أو درجة التتابع، مُقتطعاً. */
async function bodyOf(campaignId: number | null, sequenceJobId: number | null, cache: Map<string, string>, vars: Record<string, string | null | undefined> = {}): Promise<{ body: string; source: string }> {
  const key = campaignId ? `c${campaignId}` : sequenceJobId ? `j${sequenceJobId}` : "-";
  const hit = cache.get(key);
  if (hit != null) return { body: hit, source: cache.get(`${key}:src`) ?? "" };
  let body = "", source = "";
  if (campaignId) {
    const [c] = await db.select({ html: emailCampaignsTable.html, name: emailCampaignsTable.name })
      .from(emailCampaignsTable).where(eq(emailCampaignsTable.id, campaignId)).limit(1);
    body = htmlToText(c?.html ?? ""); source = c?.name ? `حملة: ${c.name}` : "حملة";
  } else if (sequenceJobId) {
    const [j] = await db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.id, sequenceJobId)).limit(1);
    const [seq] = j ? await db.select().from(emailSequencesTable).where(eq(emailSequencesTable.id, j.sequenceId)).limit(1) : [null];
    const step = ((seq?.steps as Array<{ html?: string }> | null) ?? [])[j?.stepIndex ?? 0];
    body = htmlToText(step?.html ?? ""); source = seq?.name ? `${seq.name} — الخطوة ${(j?.stepIndex ?? 0) + 1}` : "متابعة";
  }
  // بمتغيّراته مُستبدَلة: المندوب يقرأ ما وصل الشركة فعلاً، لا القالب.
  // كان يقرأ «Hello {{first_name|team}}» ويبني عليها.
  body = personalize(body, vars);
  cache.set(key, body); cache.set(`${key}:src`, source);
  return { body, source };
}

/**
 * الخيط كاملاً مع جهةٍ واحدة، مرتّباً زمنياً، ومعه أرقامه.
 * يُقرأ قبل كتابة أي رسالة لهذه الشركة — أولى أو خامسة.
 */
export async function thread(userId: number, contactId: number, limit = 20): Promise<{ turns: ThreadTurn[]; stats: ThreadStats }> {
  const [ours, theirs] = await Promise.all([
    db.select({
      at: emailMessagesTable.sentAt, subject: emailMessagesTable.subject,
      opened: emailMessagesTable.openCount, clicked: emailMessagesTable.clickCount,
      campaignId: emailMessagesTable.campaignId, sequenceJobId: emailMessagesTable.sequenceJobId,
    }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.contactId, contactId), sql`${emailMessagesTable.sentAt} is not null`))
      .orderBy(asc(emailMessagesTable.sentAt)).limit(limit),
    db.select({
      at: emailInboundTable.receivedAt, subject: emailInboundTable.subject, text: emailInboundTable.text,
      kind: emailInboundTable.kind, intent: emailInboundTable.intent,
    }).from(emailInboundTable)
      .where(and(eq(emailInboundTable.userId, userId), eq(emailInboundTable.contactId, contactId)))
      .orderBy(asc(emailInboundTable.receivedAt)).limit(limit),
  ]);

  const [contact] = await db.select().from(emailContactsTable).where(eq(emailContactsTable.id, contactId)).limit(1);
  const vars: Record<string, string | null | undefined> = contact
    ? { name: contact.name ?? contact.company ?? "", first_name: (contact.name ?? "").split(/\s+/)[0] ?? "",
        company: contact.company ?? "", email: contact.email, city: contact.city ?? "", industry: contact.industry ?? "" }
    : {};

  const cache = new Map<string, string>();
  const turns: ThreadTurn[] = [];
  for (const m of ours) {
    const { body, source } = await bodyOf(m.campaignId, m.sequenceJobId, cache, vars);
    turns.push({ who: "us", at: m.at, subject: m.subject ?? "", body, opened: m.opened ?? 0, clicked: m.clicked ?? 0, source });
  }
  for (const t of theirs) {
    turns.push({ who: "them", at: t.at, subject: t.subject ?? "", body: t.text ?? "", kind: t.kind as MailKind | null, intent: t.intent as EmailIntent | null });
  }
  turns.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));

  // النيّة الحاكمة: آخر ما صرّحوا به في ردٍّ حقيقي — لا آخر ما قالته آلة.
  const lastReal = [...theirs].reverse().find((t) => t.kind === "reply" || (!t.kind && t.intent));
  const opens = ours.reduce((n, m) => n + (m.opened ?? 0), 0);
  const replies = theirs.filter((t) => t.kind === "reply" || !t.kind).length;

  return {
    turns,
    stats: {
      sent: ours.length, opens, clicks: ours.reduce((n, m) => n + (m.clicked ?? 0), 0), replies,
      daysSinceFirst: days(ours[0]?.at), daysSinceLast: days(ours[ours.length - 1]?.at),
      daysSinceReply: days(lastReal?.at),
      lastIntent: (lastReal?.intent as EmailIntent | null) ?? null,
      silent: ours.length > 0 && opens === 0 && replies === 0,
    },
  };
}

/**
 * الخيط كنصٍّ يُوضع في التعليمات — مضغوط بحساب.
 * المزوّد المجاني يعطي ٨٠٠٠ رمزاً في الدقيقة لكل شيء: التعليمات والمعرفة
 * والرد. فالخيط يأخذ آخر ست لمسات، كل واحدة بثلاثمئة حرف، ويترك البقية.
 */
export function threadBrief(t: { turns: ThreadTurn[]; stats: ThreadStats }, opts: { turns?: number; chars?: number } = {}): string {
  const n = opts.turns ?? 6, chars = opts.chars ?? 300;
  const { turns, stats } = t;
  if (!turns.length) return "";
  const recent = turns.slice(-n);
  const lines = recent.map((x) => {
    const when = x.at ? new Date(x.at).toISOString().slice(0, 10) : "—";
    const body = x.body.replace(/\s+/g, " ").trim().slice(0, chars);
    if (x.who === "us") {
      const seen = (x.opened ?? 0) > 0 ? `فُتحت ${x.opened}×${(x.clicked ?? 0) > 0 ? ` ونُقر فيها ${x.clicked}×` : ""}` : "لا نعلم إن فُتحت";
      return `[${when}] نحن${x.source ? ` (${x.source})` : ""} — «${x.subject}» · ${seen}\n  ${body}`;
    }
    const tag = [x.kind && x.kind !== "reply" ? KIND_AR[x.kind] : null, x.intent ? INTENT_AR[x.intent]?.label : null].filter(Boolean).join(" · ");
    return `[${when}] هم${tag ? ` (${tag})` : ""} — «${x.subject}»\n  ${body}`;
  });

  const facts = [
    `أرسلنا ${stats.sent}`,
    stats.opens ? `فُتحت ${stats.opens} مرة` : "لا فتحات مسجّلة",
    stats.clicks ? `${stats.clicks} نقرة` : null,
    stats.replies ? `ردّوا ${stats.replies} مرة` : "لم يردّوا قبل اليوم",
    stats.daysSinceFirst != null ? `أول رسالة قبل ${stats.daysSinceFirst} يوماً` : null,
    stats.daysSinceLast != null ? `آخر رسالة منّا قبل ${stats.daysSinceLast} يوماً` : null,
    stats.lastIntent ? `آخر موقفٍ صرّحوا به: ${INTENT_AR[stats.lastIntent].label}` : null,
  ].filter(Boolean).join(" · ");

  return [
    "— ما سبق مع هذه الشركة (اقرأه قبل أن تكتب حرفاً) —",
    facts,
    ...lines,
    turns.length > n ? `(وقبلها ${turns.length - n} لمسة أقدم)` : "",
    "— انتهى السابق —",
  ].filter(Boolean).join("\n");
}

/**
 * ما لا يجوز أن تكرّره. الشكوى المتكرّرة من ردود البريد أنها تُعيد
 * نفسها: التحية نفسها، والجملة الافتتاحية نفسها، والسؤال نفسه. فتُجمع
 * الأسطر الافتتاحية التي استُعملت مع هذه الشركة وتُمنع صراحة.
 */
export function openingsUsed(turns: ThreadTurn[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    if (t.who !== "us" || !t.body) continue;
    const first = t.body.replace(/\s+/g, " ").trim().split(/(?<=[.!؟?])\s/)[0];
    if (first && first.length > 15) out.push(first.slice(0, 120));
  }
  return [...new Set(out)];
}

/** هل لهذه الشركة خيطٌ أصلاً — يُسأل قبل تحميل أي شيء. */
export async function hasHistory(userId: number, contactId: number): Promise<boolean> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.contactId, contactId), sql`${emailMessagesTable.sentAt} is not null`));
  return Number(n) > 0;
}

/** الخيط بالعنوان البريدي حين لا نعرف رقم الجهة بعد. */
export async function threadByEmail(userId: number, email: string, limit = 20) {
  const [c] = await db.select({ id: emailContactsTable.id }).from(emailContactsTable)
    .where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, email.toLowerCase().trim()))).limit(1);
  return c ? thread(userId, c.id, limit) : { turns: [], stats: { sent: 0, opens: 0, clicks: 0, replies: 0, daysSinceFirst: null, daysSinceLast: null, daysSinceReply: null, lastIntent: null, silent: false } satisfies ThreadStats };
}
