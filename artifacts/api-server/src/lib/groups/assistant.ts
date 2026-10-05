// ── The groups agent: learns, suggests, never sends ───────────────
// سارة reads the customer groups the owner chose to watch. When a customer
// writes, she waits a minute — customers send three lines, not one — and then
// suggests the reply the owner would give: in the owner's own style, learned
// from how the owner actually answered similar messages before, with what the
// firm's knowledge base says, and what she understood of this group.
//
// She does not send. The suggestion waits on the dashboard. When the owner
// answers from the phone, his answer is set beside hers and scored; when he
// marks a suggestion right, wrong or edits it, that is written into her
// memory. The score over time is how the owner decides whether she is ready
// to answer by herself — that switch is not built until the numbers say so.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, botEmployeesTable, agentTasksTable, businessProfileTable, waGroupsTable, waGroupMessagesTable, waGroupSuggestionsTable } from "@workspace/db";
import { complete } from "../llm";
import { retrieve, terms } from "../knowledge";
import { memoryPreamble, remember } from "../agent-memory";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { seedSkills } from "../skills";
import { briefFor, briefLines, noteMessage, teach } from "./training";
import { logger } from "../logger";
import type { ParsedGroupMessage } from "./store";

export const GROUPS_ROLE = "groups";
const WAIT_MS = 60_000;          // quiet time after the last customer line before suggesting
const DAILY_CAP = 400;           // suggestions per account per day
const READY_MIN = 50;            // decided suggestions before "ready" means anything
const READY_RATE = 0.8;

const AGENT = {
  name: "سارة", title: "مسؤولة قروبات العملاء", avatar: "👥",
  persona: [
    "مسؤولة متابعة العملاء في قروبات واتساب لمكتب محاسبة وضرائب وامتثال في الإمارات.",
    "تقرأ القروب كله قبل أن تكتب: من العميل، ما الخدمة التي نقدمها له، ما الذي طلبه وما الذي ينتظره، ومن في القروب من فريقنا ومن فريقه.",
    "ترد كما يرد صاحب العمل نفسه في هذا القروب: نفس اللغة واللهجة والطول ومستوى الرسمية — غالباً سطر أو سطرين، مهذب ومباشر.",
    "لا تعطي رقماً أو موعداً أو مبلغاً أو رأياً ضريبياً ليس في المحادثة أو معرفة الشركة؛ حين لا تعرف تكتب ردّاً يطمئن العميل ويحدد الخطوة: «سنراجع ونعود لكم اليوم».",
    "لا ترد على الشكر والتحيات العابرة والرسائل بين أعضاء فريق العميل أنفسهم — تقول إنها لا تحتاج رداً.",
  ].join(" "),
  tasks: [
    "اقرئي القروب وافهمي العميل وخدماته وطلباته المفتوحة قبل أي اقتراح.",
    "اقترحي الرد فقط حين يحتاج العميل رداً منا، بأسلوب صاحب العمل في هذا القروب.",
    "لا تذكري مبلغاً أو موعداً أو حكماً ضريبياً ليس في المحادثة أو معرفة الشركة.",
  ],
};

export async function ensureGroupsAgent(userId: number) {
  const [row] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, GROUPS_ROLE))).limit(1);
  if (row) return row;
  const [made] = await db.insert(botEmployeesTable).values({ userId, name: AGENT.name, role: GROUPS_ROLE, kind: "internal", title: AGENT.title, avatar: AGENT.avatar, persona: AGENT.persona, specialties: [], priority: 996, handoffTo: null } as any).returning();
  const has = await db.select({ id: agentTasksTable.id }).from(agentTasksTable).where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, GROUPS_ROLE))).limit(1);
  if (!has.length) await db.insert(agentTasksTable).values(AGENT.tasks.map((task, i) => ({ userId, role: GROUPS_ROLE, task, sortOrder: (i + 1) * 10 })));
  await seedSkills(userId).catch(() => {});
  logger.info({ userId }, "وُظّفت سارة (القروبات)");
  return made!;
}

// ── Similarity: how close the owner's real reply was to hers ─────
export function similarity(a: string, b: string): number {
  const A = new Set(terms(a)), B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  // Overlap over the shorter: a short correct reply inside a longer one still counts.
  return Math.round((both / Math.min(A.size, B.size)) * 100) / 100;
}

// ── Live: wait, then suggest; and learn from the owner's own reply ─
const timers = new Map<string, NodeJS.Timeout>();

export async function onGroupMessage(userId: number, group: { jid: string; watch: boolean; isCustomer: boolean }, p: ParsedGroupMessage) {
  const key = `${userId}:${group.jid}`;
  // Every message — the customer's and ours — is something to learn from.
  noteMessage(userId, group);
  if (p.fromMe) {
    clearTimeout(timers.get(key)); timers.delete(key);
    if (p.text) await recordOwnerReply(userId, group.jid, p.text);
    return;
  }
  if (!group.watch) return;
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => { timers.delete(key); void suggestFor(userId, group.jid).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "اقتراح القروب فشل")); }, WAIT_MS));
}

/** The owner answered: set his words beside her suggestion and score it. */
export async function recordOwnerReply(userId: number, jid: string, text: string) {
  const since = new Date(Date.now() - 6 * 3_600_000);
  const open = await db.select().from(waGroupSuggestionsTable)
    .where(and(eq(waGroupSuggestionsTable.userId, userId), eq(waGroupSuggestionsTable.groupJid, jid), inArray(waGroupSuggestionsTable.status, ["pending", "skip"]), gte(waGroupSuggestionsTable.createdAt, since)))
    .orderBy(desc(waGroupSuggestionsTable.createdAt));
  if (!open.length) return;
  const [latest, ...older] = open;
  // "No reply needed" and the owner replied anyway: that judgement was a miss.
  const score = latest!.status === "skip" ? 0 : similarity(latest!.suggestion, text);
  await db.update(waGroupSuggestionsTable).set({ status: "answered", ownerReply: text.slice(0, 4000), matchScore: score, decidedAt: new Date() }).where(eq(waGroupSuggestionsTable.id, latest!.id));
  if (older.length) await db.update(waGroupSuggestionsTable).set({ status: "expired", decidedAt: new Date() }).where(inArray(waGroupSuggestionsTable.id, older.map((o) => o.id)));
}

// ── What she knows when she writes ───────────────────────────────
/** Past moments like this one: what a customer wrote and how the owner answered it, in any group. */
export async function similarExamples(userId: number, text: string, limit = 5) {
  const r = await db.execute<{ q: string; a: string; subject: string | null }>(sql`
    WITH ordered AS (
      SELECT m.group_jid, m.text, m.from_me, m.created_at,
        lead(m.text) OVER w AS next_text, lead(m.from_me) OVER w AS next_me, lead(m.created_at) OVER w AS next_at
      FROM wa_group_messages m WHERE m.user_id = ${userId} AND m.text IS NOT NULL
      WINDOW w AS (PARTITION BY m.group_jid ORDER BY m.created_at)
    )
    SELECT o.text AS q, o.next_text AS a, g.subject
    FROM ordered o LEFT JOIN wa_groups g ON g.user_id = ${userId} AND g.jid = o.group_jid
    WHERE NOT o.from_me AND o.next_me AND o.next_text IS NOT NULL AND o.next_at - o.created_at < interval '6 hours'
      AND length(o.text) > 3
    ORDER BY o.created_at DESC LIMIT 4000`);
  return r.rows.map((x) => ({ ...x, score: similarity(text, x.q) })).filter((x) => x.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, limit);
}

async function voice(userId: number) {
  const agent = await ensureGroupsAgent(userId);
  const [profile] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  return [
    `اسمك ${agent.name}، ${agent.title ?? AGENT.title}.`,
    agent.persona ?? AGENT.persona,
    profile?.name ? `تعملين لدى ${profile.name}${profile.industry ? ` — ${profile.industry}` : ""}.` : "",
    profile?.description ? `عن الشركة: ${profile.description}` : "",
    profile?.guardrails ? `ما لا يُقال أبداً: ${profile.guardrails}` : "",
    await memoryPreamble(userId, GROUPS_ROLE).catch(() => ""),
    skillsPreamble(await skillsFor(userId, GROUPS_ROLE, "internal").catch(() => [])),
  ].filter(Boolean).join("\n");
}

const who = (m: { fromMe: boolean; senderName: string | null; senderPhone: string | null }) => (m.fromMe ? "نحن" : m.senderName || (m.senderPhone ? `+${m.senderPhone}` : "عضو"));
const line = (m: any) => `${who(m)}: ${m.text || (m.msgType === "document" ? `[أرسل ملفاً${m.fileName ? `: ${m.fileName}` : ""}]` : `[${m.msgType}]`)}`;

/** Her suggestion for what was last said in the group, or nothing when we spoke last or it needs no answer. */
export async function suggestFor(userId: number, jid: string, opts: { force?: boolean } = {}) {
  const [group] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, userId), eq(waGroupsTable.jid, jid))).limit(1);
  if (!group || (!group.watch && !opts.force)) return null;
  const recent = (await db.select().from(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, userId), eq(waGroupMessagesTable.groupJid, jid))).orderBy(desc(waGroupMessagesTable.createdAt)).limit(40)).reverse();
  const lastOurs = recent.map((m) => m.fromMe).lastIndexOf(true);
  const turn = recent.slice(lastOurs + 1).filter((m) => !m.fromMe);
  if (!turn.length) return null;
  const trigger = turn[turn.length - 1]!;
  const [dup] = await db.select({ id: waGroupSuggestionsTable.id }).from(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, userId), eq(waGroupSuggestionsTable.triggerMessageId, trigger.messageId))).limit(1);
  if (dup && !opts.force) return null;
  const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_group_suggestions WHERE user_id = ${userId} AND created_at > now() - interval '1 day'`)).rows;
  if (Number(n) >= DAILY_CAP) return null;

  const turnText = turn.map((m) => m.text).filter(Boolean).join("\n");
  const [head, examples, facts, brief] = await Promise.all([
    voice(userId),
    turnText ? similarExamples(userId, turnText) : Promise.resolve([]),
    turnText ? retrieve(userId, turnText, 4).catch(() => []) : Promise.resolve([]),
    briefFor(userId, jid, turnText || line(trigger)).catch(() => ({ instructions: [], examples: [], passages: [], lessons: [] })),
  ]);

  const out = await complete([
    { role: "system", content: [
      head, "",
      `القروب: «${group.subject ?? "قروب"}»${group.customerName ? ` — العميل: ${group.customerName}` : ""}.`,
      group.profile ? `ما فهمتِه عن هذا القروب سابقاً:\n${group.profile}` : "",
      group.notes ? `ملاحظات صاحب العمل عن القروب: ${group.notes}` : "",
      ...briefLines(brief),
      facts.length ? `من معرفة الشركة:\n${facts.map((f) => `- ${f.entry.title}: ${f.entry.content.slice(0, 400)}`).join("\n")}` : "",
      examples.length ? `هكذا ردّ صاحب العمل على رسائل مشابهة من قبل — قلّدي أسلوبه وطوله ولغته:\n${examples.map((e) => `العميل: ${e.q.slice(0, 300)}\nصاحب العمل: ${e.a.slice(0, 400)}`).join("\n---\n")}` : "",
      "",
      "اكتبي بهذا الشكل بالضبط:",
      "[يحتاج رد] نعم أو لا",
      "[الرد]",
      "<نص الرد كما يرسله صاحب العمل، أو اتركيه فارغاً إن لم يحتج رداً>",
      "[/الرد]",
      "[السبب] <سطر: ما الذي يطلبه العميل ولماذا هذا الرد>",
    ].filter(Boolean).join("\n") },
    { role: "user", content: `آخر المحادثة في القروب (الأقدم أولاً):\n${recent.slice(-30).map(line).join("\n")}\n\nما الرد على آخر ما كتبه العميل؟` },
  ], 60_000);
  if (!out?.text) return null;

  const needs = !/\[يحتاج رد\]\s*لا/.test(out.text);
  const reply = /\[الرد\]\s*\n?([\s\S]*?)\[\/الرد\]/.exec(out.text)?.[1]?.trim() ?? "";
  const reason = /\[السبب\]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? null;
  const [row] = await db.insert(waGroupSuggestionsTable).values({
    userId, groupJid: jid, triggerMessageId: trigger.messageId, triggerText: turnText.slice(0, 4000) || line(trigger),
    suggestion: needs && reply ? reply.slice(0, 4000) : "(لا يحتاج رداً)", reason, status: needs && reply ? "pending" : "skip", provider: out.provider,
  }).returning();
  return row!;
}

// ── Understanding a group ────────────────────────────────────────
/** What she understands of the group, from its history: written down, and used every time she suggests. */
export async function buildProfile(userId: number, jid: string) {
  const [group] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, userId), eq(waGroupsTable.jid, jid))).limit(1);
  if (!group) throw new Error("القروب غير موجود");
  const rows = (await db.select().from(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, userId), eq(waGroupMessagesTable.groupJid, jid))).orderBy(desc(waGroupMessagesTable.createdAt)).limit(400)).reverse();
  if (rows.length < 5) throw new Error("رسائل قليلة جداً لفهم القروب — اجمع المزيد أولاً");
  const head = await voice(userId);
  const transcript = rows.map((m) => `[${m.createdAt.toISOString().slice(0, 10)}] ${line(m)}`).join("\n").slice(-24_000);
  const out = await complete([
    { role: "system", content: [head, "",
      "اقرئي محادثة قروب العميل هذه واكتبي ملفاً مختصراً عنه يساعدك على الرد لاحقاً. بهذه العناوين فقط، وبنقاط قصيرة:",
      "العميل: <الشركة ونشاطها وما نعرفه عنها>",
      "الأشخاص: <من في القروب ودوره — من فريقنا ومن فريقهم>",
      "الخدمات: <ما نقدمه لهم>",
      "المواضيع المتكررة: <ما يسألون عنه عادة>",
      "طلبات مفتوحة: <ما ينتظرونه منا الآن، بالتاريخ>",
      "أسلوب التواصل: <اللغة واللهجة والطول ومستوى الرسمية في ردودنا>",
      "لا تخترعي ما ليس في المحادثة.",
    ].join("\n") },
    { role: "user", content: transcript },
  ], 90_000);
  if (!out?.text) throw new Error("لم يستجب النموذج — حاول بعد قليل");
  await db.update(waGroupsTable).set({ profile: out.text.trim().slice(0, 6000), profileAt: new Date(), updatedAt: new Date() }).where(eq(waGroupsTable.id, group.id));
  return out.text.trim();
}

// ── The owner's verdict ──────────────────────────────────────────
export async function feedback(userId: number, id: number, input: { verdict: "correct" | "wrong" | "edited"; text?: string; note?: string }) {
  const [s] = await db.select().from(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.id, id), eq(waGroupSuggestionsTable.userId, userId))).limit(1);
  if (!s) throw new Error("الاقتراح غير موجود");
  const ownerReply = input.verdict === "edited" ? (input.text ?? "").trim() : input.verdict === "correct" ? s.suggestion : s.ownerReply;
  await db.update(waGroupSuggestionsTable).set({
    status: input.verdict, ownerReply: ownerReply ?? null, feedback: input.note?.slice(0, 1000) ?? null, decidedAt: new Date(),
    matchScore: input.verdict === "correct" ? 1 : input.verdict === "wrong" ? 0 : ownerReply ? similarity(s.suggestion, ownerReply) : null,
  }).where(eq(waGroupSuggestionsTable.id, id));
  // What she should remember.
  const q = (s.triggerText ?? "").replace(/\s+/g, " ").slice(0, 160);
  if (input.verdict === "edited" && ownerReply) {
    await remember(userId, GROUPS_ROLE, "win", `حين كتب العميل «${q}» كان الرد الصحيح: «${ownerReply.slice(0, 260)}»`);
    // His correction is the strongest training there is: it becomes an example she is shown next time.
    if (s.triggerText) await teach(userId, { kind: "qa", title: "تصحيح من صاحب العمل", question: s.triggerText, answer: ownerReply }).catch(() => {});
  }
  if (input.verdict === "correct") await remember(userId, GROUPS_ROLE, "win", `رد صحيح على «${q}»: «${s.suggestion.slice(0, 260)}»`);
  if (input.verdict === "wrong") await remember(userId, GROUPS_ROLE, input.note ? "instruction" : "loss", input.note ? input.note : `رد خاطئ على «${q}»: «${s.suggestion.slice(0, 200)}» — لا تكرريه`);
}

// ── How good she is ──────────────────────────────────────────────
/** Right means: marked correct, or the owner's own reply close to hers, or her "no reply needed" left unanswered. */
export async function accuracy(userId: number, days = 30) {
  const [r] = (await db.execute<any>(sql`
    SELECT
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      -- "No reply needed" left unanswered for six hours was the right call.
      count(*) FILTER (WHERE status IN ('correct','edited','wrong','answered') OR (status = 'skip' AND created_at < now() - interval '6 hours'))::int AS decided,
      count(*) FILTER (WHERE status = 'correct' OR (status = 'answered' AND match_score >= 0.5) OR (status = 'edited' AND match_score >= 0.7) OR (status = 'skip' AND created_at < now() - interval '6 hours'))::int AS hits,
      count(*) FILTER (WHERE status = 'correct')::int AS correct,
      count(*) FILTER (WHERE status = 'edited')::int AS edited,
      count(*) FILTER (WHERE status = 'wrong')::int AS wrong,
      count(*) FILTER (WHERE status = 'answered')::int AS answered,
      count(*) FILTER (WHERE status = 'skip')::int AS skipped,
      avg(match_score) FILTER (WHERE status = 'answered') AS avg_match
    FROM wa_group_suggestions WHERE user_id = ${userId} AND created_at > now() - make_interval(days => ${days})`)).rows;
  const decided = Number(r?.decided ?? 0), hits = Number(r?.hits ?? 0);
  const rate = decided ? hits / decided : 0;
  return {
    pending: Number(r?.pending ?? 0), decided, hits, correct: Number(r?.correct ?? 0), edited: Number(r?.edited ?? 0), wrong: Number(r?.wrong ?? 0),
    answered: Number(r?.answered ?? 0), skipped: Number(r?.skipped ?? 0), avgMatch: r?.avg_match ? Math.round(Number(r.avg_match) * 100) : null,
    rate: Math.round(rate * 100), ready: decided >= READY_MIN && rate >= READY_RATE, needed: Math.max(0, READY_MIN - decided),
  };
}
