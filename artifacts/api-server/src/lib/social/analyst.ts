// ── محلل التفاعل: تحليل يومي، الوقائع بالكود والنموذج يصوغ فقط ──────────
// لكل حسابٍ له صف في social_accounts (إنستغرام وتيك توك): آخر ٧ أيام من جداول التواصل —
// المنشورات والتعليقات والفرص والرسائل وردود القوائم. لا شيء فيها = INSUFFICIENT DATA بلا نداء.
// النداء داخل runAs بدور المحلل (المفاتيح: الموظف وقسمه وحسابه) وasAgent (قواعد نموذج الحساب)،
// وكل رقمٍ في الصياغة يجب أن يكون في الوقائع وإلا تُكتب الوقائع كما هي. لا يرسل شيئاً: سطر نشاط فقط.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { dubaiNow } from "../accounts/pure";
import { accountHalted } from "../org/controls";
import { runAs } from "../org/runtime";
import { activity, roleOf } from "./team";
import type { SocialPlatform } from "./platforms";

export const ANALYST_WINDOW_DAYS = 7;
export const ANALYST_PLATFORMS: SocialPlatform[] = ["instagram", "tiktok"];
export const INSUFFICIENT = "INSUFFICIENT DATA";

export interface EngagementFacts {
  platform: SocialPlatform; days: number;
  posts: number; comments: number; leadComments: number; questions: number; praise: number; repliesPublished: number;
  dmsReceived: number; messagesSent: number; outreachSent: number; outreachReplied: number;
  topPost: { url: string; questions: number } | null;
  bestList: { name: string; sent: number; replied: number } | null;
}

/** الوقائع من الجداول، لحسابٍ واحد ومنصة واحدة. */
export async function engagementFacts(userId: number, p: SocialPlatform, now = new Date()): Promise<EngagementFacts> {
  const since = new Date(now.getTime() - ANALYST_WINDOW_DAYS * 86_400_000);
  const one = async (q: any) => ((await db.execute<any>(q)).rows[0] ?? {}) as any;
  const c = await one(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE is_lead)::int AS leads, count(*) FILTER (WHERE intent IN ('question','interested'))::int AS q,
      count(*) FILTER (WHERE intent = 'praise')::int AS praise, count(*) FILTER (WHERE status = 'replied')::int AS replied
    FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND created_at >= ${since}`);
  const posts = await one(sql`SELECT count(DISTINCT post_id)::int AS n FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND created_at >= ${since}`);
  const m = await one(sql`SELECT count(*) FILTER (WHERE NOT from_me)::int AS inbound, count(*) FILTER (WHERE from_me AND status = 'sent')::int AS sent
    FROM social_messages WHERE user_id = ${userId} AND platform = ${p} AND created_at >= ${since}`);
  const t = await one(sql`SELECT count(*) FILTER (WHERE sent_at >= ${since})::int AS sent, count(*) FILTER (WHERE replied_at >= ${since})::int AS replied
    FROM social_targets WHERE user_id = ${userId} AND platform = ${p}`);
  const top = await one(sql`SELECT po.url, count(*)::int AS q FROM social_comments c JOIN social_posts po ON po.id = c.post_id
    WHERE c.user_id = ${userId} AND c.platform = ${p} AND c.created_at >= ${since} AND c.intent IN ('question','interested') GROUP BY po.url ORDER BY 2 DESC LIMIT 1`);
  const list = await one(sql`SELECT l.name, count(*) FILTER (WHERE t.sent_at >= ${since})::int AS sent, count(*) FILTER (WHERE t.replied_at >= ${since})::int AS replied
    FROM social_targets t JOIN social_lists l ON l.id = t.list_id WHERE t.user_id = ${userId} AND t.platform = ${p}
    GROUP BY l.name HAVING count(*) FILTER (WHERE t.sent_at >= ${since}) > 0 ORDER BY 3 DESC, 2 DESC LIMIT 1`);
  const n = (v: unknown) => Number(v ?? 0);
  return {
    platform: p, days: ANALYST_WINDOW_DAYS,
    posts: n(posts.n), comments: n(c.n), leadComments: n(c.leads), questions: n(c.q), praise: n(c.praise), repliesPublished: n(c.replied),
    dmsReceived: n(m.inbound), messagesSent: n(m.sent), outreachSent: n(t.sent), outreachReplied: n(t.replied),
    topPost: top.url ? { url: String(top.url), questions: n(top.q) } : null,
    bestList: list.name ? { name: String(list.name), sent: n(list.sent), replied: n(list.replied) } : null,
  };
}

/** لا شيء يُحلَّل؟ Pure. */
export const insufficient = (f: EngagementFacts) => f.comments + f.dmsReceived + f.messagesSent + f.outreachSent + f.outreachReplied === 0;

/** الوقائع نصاً، كما هي بلا نموذج. Pure. */
export function factsText(f: EngagementFacts): string {
  const lines = [
    `آخر ${f.days} أيام: ${f.comments} تعليقاً على ${f.posts} منشوراً، منها ${f.questions} سؤالاً أو اهتماماً و${f.praise} مديحاً، و${f.leadComments} فرصة.`,
    `الرسائل: ${f.dmsReceived} واردة، و${f.messagesSent} خرجت؛ التواصل الأول: ${f.outreachSent} أُرسلت و${f.outreachReplied} ردّت.`,
  ];
  if (f.topPost) lines.push(`أكثر منشور جلب أسئلة: ${f.topPost.url} (${f.topPost.questions}).`);
  if (f.bestList) lines.push(`أفضل قائمة ردّاً: ${f.bestList.name} (${f.bestList.replied} من ${f.bestList.sent}).`);
  return lines.join("\n");
}

/** كل رقمٍ في الصياغة موجودٌ في الوقائع؟ Pure. */
export function numbersGrounded(text: string, f: EngagementFacts): boolean {
  const known = new Set<string>([...(JSON.stringify(f).match(/\d+/g) ?? []), String(f.days)]);
  const toLatin = (s: string) => s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  return (toLatin(text).match(/\d+/g) ?? []).every((x) => known.has(x));
}

export type Phrase = (userId: number, role: string, facts: EngagementFacts) => Promise<string | null>;
const modelPhrase: Phrase = async (userId, role, f) => asAgent(userId, role, async () => {
  const out = await complete([
    { role: "system", content: [
      "أنت محلل التفاعل. اكتب ثلاث جمل عربية قصيرة: ما نجح، ما لم ينجح، ماذا نكرر.",
      "استعمل الأرقام الواردة في الوقائع فقط، ولا تضف رقماً ولا واقعة ولا نسبة. لا تعد بشيء ولا تقترح إرسالاً.",
    ].join("\n") },
    { role: "user", content: `<facts>\n${JSON.stringify(f)}\n</facts>` },
  ], 25_000);
  return out?.text?.trim() ?? null;
});

export interface AnalysisResult { status: "INSUFFICIENT DATA" | "phrased" | "facts_only" | "halted" | "no_account"; text: string | null; facts: EngagementFacts | null }

/** تحليل حسابٍ ومنصة. لا حساب منصة: no_account بلا نبض. موقوف: halted (runAs يكتبها). */
export async function runEngagementAnalysis(userId: number, p: SocialPlatform, o: { phrase?: Phrase; now?: Date } = {}): Promise<AnalysisResult> {
  const [acc] = (await db.execute<any>(sql`SELECT 1 FROM social_accounts WHERE user_id = ${userId} AND platform = ${p} LIMIT 1`)).rows;
  if (!acc) return { status: "no_account", text: null, facts: null };
  const role = roleOf(p, "analyst");
  const r = await runAs(userId, role, { kind: "social_analysis", respect: "employee", intervalSec: 86_400 }, async (): Promise<AnalysisResult> => {
    const facts = await engagementFacts(userId, p, o.now);
    if (insufficient(facts)) {
      await activity(userId, p, "analyst", "analysis", `${INSUFFICIENT}: لا تعليقات ولا رسائل ولا تواصل في آخر ${facts.days} أيام`, { facts, status: INSUFFICIENT });
      return { status: INSUFFICIENT, text: null, facts };
    }
    const phrased = await (o.phrase ?? modelPhrase)(userId, role, facts).catch(() => null);
    const ok = !!phrased && phrased.length <= 1500 && numbersGrounded(phrased, facts);
    const text = ok ? phrased! : factsText(facts);
    await activity(userId, p, "analyst", "analysis", text, { facts, status: ok ? "phrased" : "facts_only" });
    return { status: ok ? "phrased" : "facts_only", text, facts };
  });
  return r ?? { status: "halted", text: null, facts: null };
}

// ── الجدول: مرةً في اليوم بعد 09:00 دبي ──────────────────────────────
const ANALYST_HOUR = 9;
const ranOn = new Map<string, string>();

export async function analystTick(now = new Date(), run: typeof runEngagementAnalysis = runEngagementAnalysis): Promise<string[]> {
  const t = dubaiNow(now);
  if (t.hour < ANALYST_HOUR) return [];
  const desks = (await db.execute<any>(sql`SELECT user_id, platform FROM social_accounts WHERE platform IN ('instagram','tiktok') ORDER BY user_id, platform`)).rows;
  const done: string[] = [];
  const from = new Date(`${t.date}T00:00:00+04:00`);
  for (const d of desks) {
    const key = `${d.user_id}:${d.platform}`;
    if (ranOn.get(key) === t.date) continue;
    ranOn.set(key, t.date);
    if (await accountHalted(Number(d.user_id), "social.analyst")) continue;
    const [seen] = (await db.execute(sql`SELECT 1 FROM social_activity WHERE user_id = ${d.user_id} AND platform = ${d.platform} AND role = ${roleOf(d.platform, "analyst")}
      AND action = 'analysis' AND created_at >= ${from} LIMIT 1`)).rows;
    if (seen) continue;
    await run(Number(d.user_id), d.platform as SocialPlatform).catch((err) => logger.warn({ key, err: String(err?.message ?? err).slice(0, 200) }, "تحليل التفاعل فشل"));
    done.push(key);
  }
  return done;
}

let timer: NodeJS.Timeout | null = null;
export function startEngagementAnalyst(): void {
  if (timer) return;
  timer = setInterval(() => void analystTick().catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "مرور المحلل فشل")), 30 * 60_000);
  timer.unref();
}
export const forgetAnalystSchedule = () => ranOn.clear();
