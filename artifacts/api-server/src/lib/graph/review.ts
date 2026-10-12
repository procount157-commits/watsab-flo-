// ── ريم reads the conversations and files the customers ──────────
// The owner: «عندي مية محادثة، أريده يقرأها ويفهمها ويصنّف العملاء من الرسائل
// العادية». So every conversation on the account is read whole — our words
// and theirs — and filed: what the person wanted, how close they are to
// buying (0–100), which piece, in which dialect, what to do next, and a
// one-line summary a human would write. Machines (other businesses'
// autoresponders) and non-customers are filed as such, so the lists the
// team works stay people.
//
// Deterministic first, model second: a thread of only machine greetings is
// «machine» without a call; the rest go to the model one at a time with
// the whole thread, and its answer is parsed strictly — a label outside the
// list is «question», a score outside 0–100 is clamped.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { detectAutoresponder } from "../autoresponder";
import { dialectOf } from "../reply-brain";
import { receipt } from "./receipts";
import { logger } from "../logger";

export const REVIEW_ROLE = "collector";
export const LABELS = {
  hot: "مهتم جداً — قريب من الشراء", order: "طلب أو يريد أن يطلب", price: "سأل عن السعر", photo: "أرسل صورة قطعة", question: "استفسار عام",
  cold: "فاتر — رد ولم يُكمل", refused: "رفض أو لا يريد", machine: "رد آلي لشركة", not_customer: "ليس عميلاً (عرض خدماته / خطأ)", silent: "وصلته رسالتنا ولم يرد",
} as const;
export type Label = keyof typeof LABELS;

export type Review = { label: Label; score: number; piece: string | null; summary: string; nextAction: string; dialect: string };

type Turn = { fromMe: boolean; text: string; at: Date };

/** The strict reading of the model's answer. Pure. */
export function parseReview(text: string): Omit<Review, "dialect"> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let j: any; try { j = JSON.parse(m[0]); } catch { return null; }
  const label = (Object.keys(LABELS) as Label[]).includes(j.label) ? j.label as Label : "question";
  const score = Math.max(0, Math.min(100, Math.round(Number(j.score) || 0)));
  return { label, score, piece: j.piece ? String(j.piece).slice(0, 200) : null, summary: String(j.summary ?? "").slice(0, 500), nextAction: String(j.next ?? j.nextAction ?? "").slice(0, 300) };
}

/** What needs no model: nobody wrote, or only a machine did. Pure. */
export function quickLabel(turns: Turn[]): Label | null {
  const theirs = turns.filter((t) => !t.fromMe && t.text.trim());
  if (!theirs.length) return "silent";
  if (theirs.every((t) => detectAutoresponder(t.text).isAuto)) return "machine";
  return null;
}

async function threadOf(userId: number, phone: string): Promise<Turn[]> {
  const r = await db.execute<{ from_me: boolean; text: string; created_at: Date }>(sql`
    SELECT from_me, coalesce(text, '') AS text, created_at FROM wa_thread_messages WHERE user_id = ${userId} AND phone = ${phone} AND coalesce(text, '') <> '' ORDER BY created_at LIMIT 60`);
  return r.rows.map((x) => ({ fromMe: !!x.from_me, text: x.text, at: new Date(x.created_at) }));
}

export async function reviewOne(userId: number, phone: string, vertical: string | null): Promise<Review | null> {
  const turns = await threadOf(userId, phone);
  if (!turns.length) return null;
  const theirs = turns.filter((t) => !t.fromMe).map((t) => t.text).join(" ");
  const dialect = dialectOf(theirs);
  const quick = quickLabel(turns);
  if (quick) return { label: quick, score: quick === "silent" ? 5 : 0, piece: null, summary: quick === "silent" ? "لم يرد على رسالتنا." : "رد آلي من شركة، لا شخص.", nextAction: quick === "silent" ? "متابعة بفائدة" : "لا شيء — ليس عميلاً", dialect };

  const transcript = turns.map((t) => `${t.fromMe ? "نحن" : "هو/هي"}: ${t.text.slice(0, 400)}`).join("\n");
  const out = await asAgent(userId, REVIEW_ROLE, () => complete([
    { role: "system", content: [
      `أنت ريم، محللة بيانات ${vertical === "jewelry" ? "في محل ذهب ومجوهرات" : "في شركة خدمات"}. تقرئين محادثة واتساب كاملة وتصنّفين العميل من كلامه هو، لا من كلامنا.`,
      "أجيبي بـ JSON واحد فقط بلا أي نص خارجه:",
      `{"label": "<${Object.keys(LABELS).join("|")}>", "score": <0-100 قربه من الشراء>, "piece": "<القطعة أو الخدمة التي يريدها إن ذُكرت، وإلا null>", "summary": "<سطر واحد كما تكتبه موظفة لزميلتها: من هو وماذا يريد>", "next": "<الخطوة التالية في سطر: ماذا نرسل له ومتى>"}`,
      "القواعد: hot = طلب سعراً وتفاعل أو قال مهتم بوضوح؛ order = قال أبغى أطلب/أحجز أو سأل عن التوصيل والدفع؛ price = سأل عن السعر ولم يُكمل؛ photo = أرسل صورة؛ question = سؤال عام؛ cold = رد بكلمة ولم يُكمل؛ refused = لا/غير مهتم/عندنا؛ machine = رسالة ترحيب آلية لشركة؛ not_customer = يعرض خدماته علينا أو رقم خاطئ؛ silent = لم يكتب شيئاً.",
      "لا تخترعي قطعة لم تُذكر. الدرجة من كلامه لا من أمنياتنا.",
    ].join("\n") },
    { role: "user", content: transcript },
  ], 40_000));
  const parsed = out?.text ? parseReview(out.text) : null;
  if (!parsed) return null;
  return { ...parsed, dialect };
}

export async function reviewAll(userId: number, opts: { limit?: number; onlyStale?: boolean } = {}): Promise<{ reviewed: number; byLabel: Record<string, number>; failed: number }> {
  const [p] = (await db.execute<{ vertical: string | null }>(sql`SELECT vertical FROM business_profile WHERE user_id = ${userId}`)).rows;
  const phones = (await db.execute<{ phone: string; n: number; last: Date }>(sql`
    SELECT m.phone, count(*)::int AS n, max(m.created_at) AS last FROM wa_thread_messages m
    ${opts.onlyStale ? sql`LEFT JOIN conversation_reviews r ON r.user_id = m.user_id AND r.phone = m.phone` : sql``}
    WHERE m.user_id = ${userId} ${opts.onlyStale ? sql`AND (r.phone IS NULL OR r.reviewed_at < (SELECT max(created_at) FROM wa_thread_messages x WHERE x.user_id = m.user_id AND x.phone = m.phone))` : sql``}
    GROUP BY m.phone ORDER BY max(m.created_at) DESC LIMIT ${opts.limit ?? 300}`)).rows;
  const byLabel: Record<string, number> = {}; let reviewed = 0, failed = 0;
  for (const ph of phones) {
    try {
      const r = await reviewOne(userId, ph.phone, p?.vertical ?? null);
      if (!r) { failed++; continue; }
      await db.execute(sql`INSERT INTO conversation_reviews (user_id, phone, label, score, piece, summary, next_action, dialect, msg_count, last_at, reviewed_at)
        VALUES (${userId}, ${ph.phone}, ${r.label}, ${r.score}, ${r.piece}, ${r.summary}, ${r.nextAction}, ${r.dialect}, ${Number(ph.n)}, ${ph.last}, now())
        ON CONFLICT (user_id, phone) DO UPDATE SET label = EXCLUDED.label, score = EXCLUDED.score, piece = EXCLUDED.piece, summary = EXCLUDED.summary, next_action = EXCLUDED.next_action, dialect = EXCLUDED.dialect, msg_count = EXCLUDED.msg_count, last_at = EXCLUDED.last_at, reviewed_at = now()`);
      byLabel[r.label] = (byLabel[r.label] ?? 0) + 1; reviewed++;
      receipt({ userId, node: REVIEW_ROLE, action: "review.conversation", subject: ph.phone, evidence: { label: r.label, score: r.score, piece: r.piece }, why: r.summary });
    } catch (err: any) { failed++; logger.warn({ userId, phone: ph.phone, err: String(err?.message ?? err).slice(0, 160) }, "تصنيف محادثة فشل"); }
  }
  logger.info({ userId, reviewed, failed, byLabel }, "ريم أنهت قراءة المحادثات");
  return { reviewed, byLabel, failed };
}

export async function listReviews(userId: number) {
  const r = await db.execute<any>(sql`SELECT r.*, c.name AS saved_name FROM conversation_reviews r
    LEFT JOIN LATERAL (SELECT name FROM contacts WHERE phone = r.phone AND name IS NOT NULL AND name <> '' LIMIT 1) c ON true
    WHERE r.user_id = ${userId} ORDER BY r.score DESC, r.last_at DESC`);
  return r.rows;
}

/** The numbers under a label into a list of their own, so the team can work them. */
export async function fileLabel(userId: number, label: Label): Promise<{ groupId: number; added: number }> {
  const name = `تصنيف: ${LABELS[label]}`;
  let [g] = (await db.execute<{ id: number }>(sql`SELECT id FROM contact_groups WHERE user_id = ${userId} AND name = ${name} LIMIT 1`)).rows;
  if (!g) [g] = (await db.execute<{ id: number }>(sql`INSERT INTO contact_groups (user_id, name, description) VALUES (${userId}, ${name}, 'من قراءة ريم للمحادثات') RETURNING id`)).rows;
  const r = await db.execute<{ phone: string }>(sql`INSERT INTO contacts (group_id, phone, name, status)
    SELECT ${g!.id}, split_part(r.phone, ':', 1), coalesce(c.name, r.piece), 'active' FROM conversation_reviews r
    LEFT JOIN LATERAL (SELECT name FROM contacts WHERE phone = split_part(r.phone, ':', 1) AND name IS NOT NULL AND name <> '' LIMIT 1) c ON true
    WHERE r.user_id = ${userId} AND r.label = ${label}
      AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.group_id = ${g!.id} AND x.phone = split_part(r.phone, ':', 1))
    RETURNING phone`);
  return { groupId: Number(g!.id), added: r.rows.length };
}
