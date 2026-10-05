// ── What سارة knows beyond the transcript ─────────────────────────
// Two sources, kept in one table so the owner can see and switch off both:
//
//   taught   — what the owner sends her: standing instructions, a customer
//              question with the answer he wants given, pasted text, a file
//              (a price list, a procedure, a service sheet).
//   learned  — what she draws herself from reading the groups. Every message
//              a group receives moves it forward; when the group goes quiet,
//              she reads what is new since last time, updates her file on the
//              group, and writes down any lesson that holds beyond it — how
//              the owner answers a kind of request, how the office works.
//
// When she suggests a reply, the instructions always come with her, and the
// examples, passages and lessons closest to what the customer wrote.

import { asAgent } from "../agent-context";
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db, waGroupsTable, waGroupMessagesTable, waGroupKnowledgeTable, type WaGroupKnowledge } from "@workspace/db";
import { complete } from "../llm";
import { terms } from "../knowledge";
import { extractText } from "../email/knowledge-docs";
import { applyTasks, openTaskLines, openTasks, parseTasks } from "./tasks";
import { logger } from "../logger";

export const TAUGHT_KINDS = ["instruction", "qa", "text", "document"] as const;
export type TaughtKind = typeof TAUGHT_KINDS[number];

const MAX_DOC = 200_000;          // characters kept from one file
const PASSAGE = 700;              // characters per passage she is shown
const LEARN_QUIET_MS = 10 * 60_000; // the group's quiet time before she reads what is new
const LEARN_MIN = 5;              // new messages that are worth a reading at once…
const LEARN_STALE_MS = 6 * 3_600_000; // …or fewer, when her last reading is this old
const LEARN_BATCH = 150;          // messages read in one go
const LEARN_DAILY_CAP = 150;      // readings per account per day
const LESSONS_KEPT = 300;         // learned lessons kept active per account

// ── Similarity, the same measure the suggestions are scored by ───
export function overlap(a: string, b: string): number {
  const A = new Set(terms(a)), B = new Set(terms(b));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return both / Math.min(A.size, B.size);
}

/** A long text, in passages of about PASSAGE characters, cut at paragraph or sentence ends. */
export function passagesOf(text: string, size = PASSAGE): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.replace(/\r/g, "").split(/\n{2,}|(?<=[.!؟?])\s+(?=\S)/)) {
    const p = para.trim();
    if (!p) continue;
    if (cur && cur.length + p.length + 1 > size) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${p}` : p;
    while (cur.length > size * 1.6) { out.push(cur.slice(0, size)); cur = cur.slice(size); }
  }
  if (cur) out.push(cur);
  return out;
}

// ── Teaching ─────────────────────────────────────────────────────
export type TeachInput = { kind: TaughtKind; title?: string | null; content?: string | null; question?: string | null; answer?: string | null; groupJid?: string | null };

export async function teach(userId: number, input: TeachInput): Promise<WaGroupKnowledge> {
  if (!TAUGHT_KINDS.includes(input.kind)) throw new Error("نوع التدريب غير معروف");
  const clean = (s?: string | null, n = MAX_DOC) => (s ?? "").replace(/\u0000/g, "").trim().slice(0, n);
  const row = { userId, groupJid: input.groupJid || null, kind: input.kind, source: "owner", title: clean(input.title, 200) || null, content: null as string | null, question: null as string | null, answer: null as string | null };
  if (input.kind === "qa") {
    row.question = clean(input.question, 2000); row.answer = clean(input.answer, 4000);
    if (!row.question || !row.answer) throw new Error("اكتب سؤال العميل والرد الذي تريده");
  } else {
    row.content = clean(input.content);
    if (row.content.length < (input.kind === "instruction" ? 4 : 20)) throw new Error(input.kind === "instruction" ? "اكتب التعليمة" : "النص قصير جداً");
  }
  const [made] = await db.insert(waGroupKnowledgeTable).values(row).returning();
  return made!;
}

/** A file the owner uploaded: its text, kept whole and shown to her in passages. */
export async function teachFile(userId: number, buffer: Buffer, fileName: string, groupJid?: string | null) {
  const text = (await extractText(buffer, fileName)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length < 20) throw new Error("لم أجد نصاً يُقرأ في الملف");
  return teach(userId, { kind: "document", title: fileName, content: text, groupJid });
}

export async function listKnowledge(userId: number, opts: { source?: "owner" | "learned"; groupJid?: string | null } = {}) {
  const rows = await db.select().from(waGroupKnowledgeTable).where(and(
    eq(waGroupKnowledgeTable.userId, userId),
    opts.source ? eq(waGroupKnowledgeTable.source, opts.source) : sql`true`,
    opts.groupJid ? or(isNull(waGroupKnowledgeTable.groupJid), eq(waGroupKnowledgeTable.groupJid, opts.groupJid)) : sql`true`,
  )).orderBy(desc(waGroupKnowledgeTable.createdAt)).limit(500);
  // A file can be long: the list shows its size and opening, not all of it.
  return rows.map((r) => r.kind === "document" ? { ...r, chars: r.content?.length ?? 0, content: (r.content ?? "").slice(0, 600) } : { ...r, chars: (r.content ?? r.answer ?? "").length });
}

export async function knowledgeCounts(userId: number) {
  const r = await db.execute<any>(sql`SELECT kind, source, count(*)::int AS n, count(*) FILTER (WHERE active)::int AS active FROM wa_group_knowledge WHERE user_id = ${userId} GROUP BY kind, source`);
  return r.rows;
}

// ── What she is given when she writes ─────────────────────────────
export type Brief = { instructions: string[]; examples: Array<{ q: string; a: string }>; passages: Array<{ title: string; text: string }>; lessons: string[] };

/**
 * Everything taught or learned that bears on this turn: every instruction
 * (they are orders, not hints), and the closest examples, passages and lessons.
 */
export async function briefFor(userId: number, jid: string, turnText: string): Promise<Brief> {
  const rows = await db.select().from(waGroupKnowledgeTable).where(and(
    eq(waGroupKnowledgeTable.userId, userId), eq(waGroupKnowledgeTable.active, true),
    or(isNull(waGroupKnowledgeTable.groupJid), eq(waGroupKnowledgeTable.groupJid, jid)),
  )).orderBy(desc(waGroupKnowledgeTable.createdAt)).limit(1000);

  const used: number[] = [];
  const instructions: string[] = [];
  let budget = 3_000;
  for (const r of rows.filter((x) => x.kind === "instruction")) {
    const t = (r.content ?? "").trim();
    if (!t || t.length > budget) continue;
    instructions.push(t); budget -= t.length; used.push(r.id);
  }

  const qa = rows.filter((x) => x.kind === "qa").map((r) => ({ r, s: overlap(turnText, r.question ?? "") }))
    .filter((x) => x.s >= 0.2).sort((a, b) => b.s - a.s).slice(0, 5);
  qa.forEach((x) => used.push(x.r.id));

  const chunks = rows.filter((x) => x.kind === "text" || x.kind === "document").flatMap((r) =>
    passagesOf(r.content ?? "").map((text) => ({ r, text, s: overlap(turnText, text) })))
    .filter((x) => x.s >= 0.2).sort((a, b) => b.s - a.s).slice(0, 3);
  chunks.forEach((x) => used.push(x.r.id));

  // This group's own lessons first, then the general ones nearest to the turn.
  const lessonRows = rows.filter((x) => x.kind === "lesson");
  const own = lessonRows.filter((x) => x.groupJid === jid).slice(0, 6);
  const general = lessonRows.filter((x) => !x.groupJid).map((r) => ({ r, s: overlap(turnText, r.content ?? "") }))
    .sort((a, b) => b.s - a.s || b.r.createdAt.getTime() - a.r.createdAt.getTime()).slice(0, 6).map((x) => x.r);
  [...own, ...general].forEach((r) => used.push(r.id));

  if (used.length) await db.update(waGroupKnowledgeTable).set({ used: sql`${waGroupKnowledgeTable.used} + 1` }).where(inArray(waGroupKnowledgeTable.id, [...new Set(used)])).catch(() => {});
  return {
    instructions,
    examples: qa.map((x) => ({ q: x.r.question ?? "", a: x.r.answer ?? "" })),
    passages: chunks.map((x) => ({ title: x.r.title ?? "من تدريب صاحب العمل", text: x.text })),
    lessons: [...own, ...general].map((r) => r.content ?? "").filter(Boolean),
  };
}

/** The brief, as the lines of her prompt. Instructions first and marked as binding. */
export function briefLines(b: Brief): string[] {
  return [
    b.instructions.length ? `تعليمات صاحب العمل لكِ — ملزمة وتتقدّم على كل ما سواها:\n${b.instructions.map((t) => `- ${t}`).join("\n")}` : "",
    b.examples.length ? `أمثلة درّبكِ عليها صاحب العمل — حين يشبه السؤالُ أحدها فهذا هو الرد المطلوب بمعناه:\n${b.examples.map((e) => `العميل: ${e.q.slice(0, 300)}\nالرد: ${e.a.slice(0, 500)}`).join("\n---\n")}` : "",
    b.passages.length ? `من المواد التي أرسلها صاحب العمل للتدريب:\n${b.passages.map((p) => `[${p.title}] ${p.text}`).join("\n\n")}` : "",
    b.lessons.length ? `ما تعلّمتِه بنفسك من القروبات:\n${b.lessons.map((t) => `- ${t}`).join("\n")}` : "",
  ].filter(Boolean);
}

// ── Learning from every message ──────────────────────────────────
const learnTimers = new Map<string, NodeJS.Timeout>();
let queue: Promise<unknown> = Promise.resolve();

/** A message arrived in a group she reads: when the group goes quiet, she reads what is new. */
export function noteMessage(userId: number, group: { jid: string; watch: boolean; isCustomer: boolean }) {
  if (!group.watch && !group.isCustomer) return;
  const key = `${userId}:${group.jid}`;
  clearTimeout(learnTimers.get(key));
  learnTimers.set(key, setTimeout(() => {
    learnTimers.delete(key);
    // One reading at a time per process: a busy morning is a queue, not a storm.
    queue = queue.then(() => learnFromGroup(userId, group.jid).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "قراءة القروب للتعلّم فشلت")));
  }, LEARN_QUIET_MS));
}

export type LearnResult = { read: number; lessons: string[]; profile: boolean; tasks?: { added: number; closed: number } } | null;

/**
 * Read what is new in a group since her last reading: update her file on it,
 * and keep the lessons that hold beyond it. `force` reads even one message.
 */
export async function learnFromGroup(userId: number, jid: string, opts: { force?: boolean } = {}): Promise<LearnResult> {
  return asAgent(userId, "groups", () => learnInner(userId, jid, opts));
}
async function learnInner(userId: number, jid: string, opts: { force?: boolean }): Promise<LearnResult> {
  const [group] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, userId), eq(waGroupsTable.jid, jid))).limit(1);
  if (!group) return null;
  const fresh = await db.select().from(waGroupMessagesTable).where(and(
    eq(waGroupMessagesTable.userId, userId), eq(waGroupMessagesTable.groupJid, jid),
    group.learnedUpto ? gt(waGroupMessagesTable.createdAt, group.learnedUpto) : sql`true`,
  )).orderBy(group.learnedUpto ? asc(waGroupMessagesTable.createdAt) : desc(waGroupMessagesTable.createdAt)).limit(LEARN_BATCH);
  if (!group.learnedUpto) fresh.reverse();
  const said = fresh.filter((m) => m.text && m.text.trim().length > 1);
  if (!said.length) return null;
  const stale = !group.learnedAt || Date.now() - group.learnedAt.getTime() > LEARN_STALE_MS;
  if (!opts.force && said.length < LEARN_MIN && !stale) return null;

  const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_groups WHERE user_id = ${userId} AND learned_at > now() - interval '1 day'`)).rows as any;
  if (!opts.force && Number(n) >= LEARN_DAILY_CAP) return null;

  const open = await openTasks(userId, jid);
  const known = await db.select({ content: waGroupKnowledgeTable.content }).from(waGroupKnowledgeTable)
    .where(and(eq(waGroupKnowledgeTable.userId, userId), eq(waGroupKnowledgeTable.kind, "lesson"), eq(waGroupKnowledgeTable.active, true)))
    .orderBy(desc(waGroupKnowledgeTable.createdAt)).limit(40);
  const who = (m: typeof fresh[number]) => (m.fromMe ? "نحن" : m.senderName || (m.senderPhone ? `+${m.senderPhone}` : "عضو"));
  const transcript = fresh.map((m) => `[${m.createdAt.toISOString().slice(0, 16).replace("T", " ")}] ${who(m)}: ${m.text || (m.fileName ? `[ملف: ${m.fileName}]` : `[${m.msgType}]`)}`).join("\n").slice(-20_000);

  const out = await complete([
    { role: "system", content: [
      "أنتِ سارة، مسؤولة قروبات العملاء في مكتب محاسبة وضرائب وامتثال في الإمارات. تتعلمين من كل رسالة.",
      "أمامك ملفك الحالي عن هذا القروب، وما قيل فيه بعد آخر قراءة لك. «نحن» هو صاحب العمل وفريقه.",
      "١. حدّثي الملف: أضيفي الجديد، صحّحي ما تغيّر، احذفي الطلبات التي أُغلقت. نفس العناوين: العميل، الأشخاص، الخدمات، المواضيع المتكررة، طلبات مفتوحة (بالتاريخ)، أسلوب التواصل.",
      "٢. استخرجي دروساً عامة تنفع في كل القروبات — كيف يرد صاحب العمل على نوع من الطلبات، ما الذي يطلبه من العملاء عادة، كيف يعمل المكتب، كلمات يستخدمها أو يتجنبها. درس = جملة واحدة محددة قابلة للتطبيق. لا دروس عن هذا العميل بالذات (هذه مكانها الملف)، ولا تكرار لما هو معروف، ولا شيء لم يحدث فعلاً في المحادثة. إن لم يوجد درس جديد فاتركي القسم فارغاً.",
      "٣. استخرجي كل طلب جديد طلبه العميل منا في الجديد — مستند، تقرير، إقرار، رد على سؤال، موعد — سطراً لكل طلب: «- <ما طلبه> | <التاريخ YYYY-MM-DD فقط إن ذكره العميل صراحة، وإلا بلا> | <من طلبه>». لا تكرري طلباً موجوداً في قائمة الطلبات المفتوحة.",
      "٤. إن ظهر في الجديد أننا أنجزنا طلباً من الطلبات المفتوحة (أرسلنا الملف، أجبنا، أكّدنا) فاكتبي رقمه في قسم «أُنجز».",
      "لا تخترعي شيئاً ليس في المحادثة.",
      "",
      "اكتبي بهذا الشكل بالضبط:",
      "[الملف]", "<الملف المحدّث>", "[/الملف]",
      "[دروس]", "- <درس>", "[/دروس]",
      "[طلبات]", "- <ما طلبه> | <YYYY-MM-DD أو بلا> | <من طلبه>", "[/طلبات]",
      "[أُنجز]", "<أرقام الطلبات المفتوحة التي أُنجزت، أو فارغ>", "[/أُنجز]",
    ].join("\n") },
    { role: "user", content: [
      `القروب: «${group.subject ?? "قروب"}»${group.customerName ? ` — العميل: ${group.customerName}` : ""}`,
      `ملفك الحالي:\n${group.profile ?? "(لا ملف بعد)"}`,
      open.length ? `الطلبات المفتوحة لهذا العميل:\n${openTaskLines(open)}` : "لا طلبات مفتوحة لهذا العميل.",
      known.length ? `دروس تعرفينها من قبل (لا تكرريها):\n${known.map((k) => `- ${k.content}`).join("\n")}` : "",
      `الجديد في القروب:\n${transcript}`,
    ].filter(Boolean).join("\n\n") },
  ], 90_000);

  // Her reading has reached the last message either way, so a model that
  // failed is not asked about the same messages forever.
  const upto = fresh[fresh.length - 1]!.createdAt;
  const set: Record<string, unknown> = { learnedUpto: upto, learnedAt: new Date() };
  const profile = out?.text ? /\[الملف\]\s*\n?([\s\S]*?)\[\/الملف\]/.exec(out.text)?.[1]?.trim() : null;
  if (profile && profile.length > 30) { set["profile"] = profile.slice(0, 6000); set["profileAt"] = new Date(); }
  await db.update(waGroupsTable).set(set).where(eq(waGroupsTable.id, group.id));

  const lessons = out?.text ? parseLessons(out.text) : [];
  const kept = await keepLessons(userId, lessons, known.map((k) => k.content ?? ""));
  // Only requests from a live conversation become tasks: a backfill of last
  // year's history would bury the board in requests long since answered.
  const recent = Date.now() - upto.getTime() < 7 * 86_400_000;
  const tasks = out?.text && recent ? await applyTasks(userId, jid, open, parseTasks(out.text), upto) : { added: 0, closed: 0 };
  return { read: fresh.length, lessons: kept, profile: !!set["profile"], tasks };
}

export function parseLessons(text: string): string[] {
  const block = /\[دروس\]([\s\S]*?)(\[\/دروس\]|$)/.exec(text)?.[1] ?? "";
  return block.split("\n").map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, "").trim())
    .filter((l) => l.length >= 12 && l.length <= 400 && !/^<.*>$/.test(l) && !/^(لا يوجد|لا دروس|none)/i.test(l));
}

/** New lessons, minus those she already knows in other words. Old unused ones retire past the cap. */
export async function keepLessons(userId: number, lessons: string[], known: string[]): Promise<string[]> {
  const kept: string[] = [];
  for (const l of lessons.slice(0, 6)) {
    if ([...known, ...kept].some((k) => overlap(l, k) >= 0.7)) continue;
    await db.insert(waGroupKnowledgeTable).values({ userId, kind: "lesson", source: "learned", content: l });
    kept.push(l);
  }
  if (kept.length) {
    await db.execute(sql`UPDATE wa_group_knowledge SET active = false, updated_at = now() WHERE id IN (
      SELECT id FROM wa_group_knowledge WHERE user_id = ${userId} AND kind = 'lesson' AND source = 'learned' AND active
      ORDER BY used DESC, created_at DESC OFFSET ${LESSONS_KEPT})`);
  }
  return kept;
}
