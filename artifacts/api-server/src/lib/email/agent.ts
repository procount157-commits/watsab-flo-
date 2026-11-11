// ── نورة: the email agent ─────────────────────────────────────────
// An employee of her own, because the owner asked for one to train: she
// holds knowledge the owner gives her — about the service, about each
// sector, about how the firm talks — each item tagged with the sector it
// applies to, and she brings the right part of it to whatever she writes.
// She writes the campaign for a target the owner picks, and the follow-ups
// for the two audiences a campaign leaves behind (opened and did not reply;
// never opened). After a subject test she writes down which subject won for
// that sector, so the next campaign for it starts from what worked.
//
// Everything she writes comes back in labelled blocks and is parsed here,
// because the model answering may be whatever free tier is up, and a weak
// model mislabels a block far less often than it breaks JSON.

import { lessonsFor } from "../feedback";
import { asAgent, asWorker } from "../agent-context";
import { companyKnowledge, knowledgeLines } from "../company-knowledge";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, agentMemoryTable, botEmployeesTable, businessProfileTable, DEFAULT_EMPLOYEES, type SegmentFilter } from "@workspace/db";
import { complete } from "../llm";
import { retrieve } from "../knowledge";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { seedSkills } from "../skills";
import { logger } from "../logger";
import { count, describe, resolve } from "./segments";
import { passages } from "./knowledge-docs";
import { COLD_CRAFT, HOOK_CRAFT, WRITER_EXAMPLE } from "./prompts";
import { FOLLOWUP_CRAFT } from "../followup-doctrine";
import { getSettings } from "./service";
import { teamVoice, onDuty, type EmailRole } from "./team";
import { asLanguage, languageRule } from "./language";
import { INTENSITY, FOLLOW_PROMPT, asIntensity } from "./intensity";
import { isShop } from "./seed";
import { markUsed, writerGuidance } from "../org/handoffs";
import { dryRun, personaFor } from "../org/simulation";

export const EMAIL_ROLE = "email";
const KNOWLEDGE = "knowledge";

// ── The employee ──────────────────────────────────────────────────
/** Hire نورة on an account that has a team but not her. */
export async function ensureEmailAgent(userId: number) {
  const [row] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, EMAIL_ROLE))).limit(1);
  if (row) return row;
  const def = DEFAULT_EMPLOYEES.find((e) => e.role === EMAIL_ROLE)!;
  const [made] = await db.insert(botEmployeesTable).values({ userId, ...def, specialties: [] } as any).returning();
  await seedSkills(userId).catch(() => {});
  logger.info({ userId }, "وُظّفت نورة (البريد)");
  return made!;
}

// ── What she knows ────────────────────────────────────────────────
export async function rememberKnowledge(userId: number, content: string, topic: string | null, docId: number | null = null) {
  const text = content.trim().slice(0, 1500);
  if (!text) return;
  await db.execute(sql`
    INSERT INTO agent_memory (user_id, role, kind, content, topic, doc_id)
    VALUES (${userId}, ${EMAIL_ROLE}, ${KNOWLEDGE}, ${text}, ${topic}, ${docId})
    ON CONFLICT (user_id, role, kind, md5(content))
    DO UPDATE SET times = agent_memory.times + 1, topic = coalesce(EXCLUDED.topic, agent_memory.topic),
      doc_id = coalesce(agent_memory.doc_id, EXCLUDED.doc_id), updated_at = NOW()
  `);
}

/** `pending`: نصٌّ كتبه نموذج لا حسبه كود. يبقى معلّقاً ولا يصل أي prompt حتى يُعتمد. */
export async function rememberLesson(userId: number, kind: "win" | "loss" | "instruction", content: string, topic: string | null, opts: { pending?: boolean } = {}) {
  const text = content.trim().slice(0, 500);
  if (!text) return;
  await db.execute(sql`
    INSERT INTO agent_memory (user_id, role, kind, content, topic, approval_status)
    VALUES (${userId}, ${EMAIL_ROLE}, ${kind}, ${text}, ${topic}, ${opts.pending ? "pending" : "approved"})
    ON CONFLICT (user_id, role, kind, md5(content))
    DO UPDATE SET times = agent_memory.times + 1, updated_at = NOW()
  `);
}

export async function memory(userId: number) {
  return db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE)))
    .orderBy(desc(agentMemoryTable.updatedAt));
}

/** Words worth matching on: lowercase, three letters or more, Arabic or Latin. */
export const queryWords = (q: string): string[] =>
  [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3))];

/**
 * How much a knowledge row is about the query: distinct query words it
 * contains. A goal of «AML real-estate inspection» should pull the Ministry's
 * real-estate fine ahead of the VAT threshold even when the latter was
 * taught more often. Pure, exported for tests.
 */
export function overlap(text: string, words: string[]): number {
  if (!words.length) return 0;
  const t = text.toLowerCase();
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

/**
 * What applies to these sectors: their own items first, then the general ones, within a budget.
 *
 * `query`: the facts are ranked by overlap with it (then by how often they were
 * taught), and the top-scoring one that carries a digit is named as the official
 * fact the summary opens on — the writer no longer has to find it in 3.5k chars.
 * `lessons: false`: knowledge only. writeCampaign already gets the owner's
 * instructions, wins and losses through memoryPreamble (teamVoice), and the
 * same lines twice in one prompt cost tokens and taught nothing.
 */
export async function brief(userId: number, sectors: string[] = [], budget = 3500, opts: { lessons?: boolean; query?: string } = {}) {
  const rows = await db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE), eq(agentMemoryTable.approvalStatus, "approved"),
      sectors.length ? or(isNull(agentMemoryTable.topic), inArray(agentMemoryTable.topic, sectors))! : sql`true`))
    .orderBy(desc(agentMemoryTable.times), desc(agentMemoryTable.updatedAt));
  const words = queryWords(opts.query ?? "");
  const pick = (kind: string) => rows.filter((r) => r.kind === kind)
    .map((r) => ({ r, score: overlap(r.content, words) }))
    .sort((a, b) => b.score - a.score || Number(!!b.r.topic) - Number(!!a.r.topic) || b.r.times - a.r.times)
    .map((x) => x.r);
  const take = (items: typeof rows, max: number) => {
    const out: string[] = []; let used = 0;
    for (const r of items) { const line = `- ${r.topic ? `[${r.topic}] ` : ""}${r.content}`; if (used + line.length > max) break; out.push(line); used += line.length; }
    return out;
  };
  const facts = pick(KNOWLEDGE);
  const knowledge = take(facts, budget);
  const official = words.length ? facts.find((r) => /\d|[٠-٩]/.test(r.content) && overlap(r.content, words) > 0) : undefined;
  const withLessons = opts.lessons !== false;
  const rules = withLessons ? take(pick("instruction"), 900) : [];
  const wins = withLessons ? take(pick("win"), 600) : [];
  const losses = withLessons ? take(pick("loss"), 500) : [];
  return [
    knowledge.length ? `${official ? `الحقيقة الرسمية التي يبدأ بها الملخص: ${official.content}\n` : ""}ما تعرفينه عن عملنا وعن هذا القطاع:\n${knowledge.join("\n")}` : "",
    rules.length ? `تعليمات صاحب العمل — التزمي بها:\n${rules.join("\n")}` : "",
    wins.length ? `ما نجح من قبل:\n${wins.join("\n")}` : "",
    losses.length ? `ما لم ينجح — لا تكرريه:\n${losses.join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

async function voice(userId: number) {
  const agent = await ensureEmailAgent(userId);
  const [profile] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const skills = await skillsFor(userId, EMAIL_ROLE, "internal").catch(() => []);
  return {
    agent, profile,
    head: [
      `اسمك ${agent.name}${agent.title ? `، ${agent.title}` : ""}.`,
      personaFor(EMAIL_ROLE, agent.persona) ?? "",
      profile?.name ? `تعملين لدى ${profile.name}${profile.industry ? ` — ${profile.industry}` : ""}.` : "",
      profile?.description ? `عن الشركة: ${profile.description}` : "",
      profile?.guardrails ? `ما لا يُقال أبداً: ${profile.guardrails}` : "",
      skillsPreamble(skills),
    ].filter(Boolean).join("\n"),
  };
}

// ── Teaching ──────────────────────────────────────────────────────
/**
 * The owner explains in their own words — or pastes a document — and she
 * writes it down as separate facts, each tied to a sector when it is about
 * one. Without a model the text is kept in paragraphs, so nothing the owner
 * taught is lost to an outage.
 */
export async function teach(userId: number, text: string, topic: string | null = null, docId: number | null = null): Promise<Array<{ content: string; topic: string | null }>> {
  await ensureEmailAgent(userId);
  const src = text.trim().slice(0, 12_000);
  if (!src) return [];
  const out = await asWorker(userId, "email", () => complete([
    { role: "system", content: [
      "أنت تحفظين معرفة علّمك إياها صاحب العمل لتستخدميها في كتابة البريد التسويقي.",
      "استخرجي من النص الحقائق المفيدة للبيع: ما نقدّمه، لمن، ما يقلق كل قطاع، الالتزامات والمواعيد كما وردت حرفياً، أسلوبنا، ما لا يُقال.",
      "كل حقيقة في سطر مستقل مكتفٍ بذاته، بهذا الشكل بالضبط:",
      "حقيقة: <الحقيقة> | القطاع: <اسم القطاع أو عام>",
      "لا تخترعي شيئاً ليس في النص. انقلي الأرقام والمواعيد كما هي. من ٣ إلى ٢٠ سطراً.",
      topic ? `النص كله عن قطاع: ${topic} — إلا ما كان عاماً بوضوح.` : "",
    ].filter(Boolean).join("\n") },
    { role: "user", content: src },
  ], 60_000));

  const items: Array<{ content: string; topic: string | null }> = [];
  if (out?.text) {
    for (const line of out.text.split("\n")) {
      const m = /حقيقة\s*[:：]\s*(.+?)(?:\s*\|\s*القطاع\s*[:：]\s*(.+))?$/.exec(line.trim());
      if (!m?.[1]) continue;
      const t = (m[2] ?? "").trim();
      items.push({ content: m[1].trim(), topic: !t || /^عام/.test(t) ? topic : t.slice(0, 80) });
    }
  }
  if (!items.length) {
    for (const para of src.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
      for (let i = 0; i < para.length; i += 1400) items.push({ content: para.slice(i, i + 1400), topic });
    }
  }
  for (const it of items) await rememberKnowledge(userId, it.content, it.topic, docId);
  logger.info({ userId, items: items.length, viaModel: !!out?.text }, "نورة تعلّمت");
  return items;
}

// ── Writing ───────────────────────────────────────────────────────
export interface EmailDraft {
  subjects: string[];
  html: string;
  /** warm: opened, no reply · cold: did not open (resent, new subject) · value: a useful insight to all who have not replied · breakup: the last note */
  followups: Array<{ audience: "warm" | "cold" | "value" | "angle" | "bump" | "breakup"; afterHours: number; subject: string; html: string }>;
  why: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Plain paragraphs to email HTML. **bold** survives; merge fields are left alone. */
export function toHtml(text: string): string {
  // Paragraphs by blank lines; within one, a run of "- " lines is a list
  // and the rest are lines of the same paragraph.
  // «[ملخص]» alone on a line with the summary on the next (weak models do
  // this) used to give an empty lead and the summary as a plain paragraph:
  // the mark is pulled onto the line that follows it, across a blank line too.
  const src = text.trim().replace(/^(\s*\**\[(?:ملخص|summary)\]\**)\s*\n+\s*(?=\S)/gim, "$1 ");
  return src.split(/\n\s*\n/).map((para) => {
    const lines = para.split("\n").map((l) => esc(l.trim()).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")).filter(Boolean);
    const out: string[] = [];
    let text: string[] = [], items: string[] = [];
    // Plain tags: the layout styles them, in the message's own direction.
    const flushText = () => { if (text.length) out.push(`<p>${text.join("<br>")}</p>`); text = []; };
    const flushList = () => { if (items.length) out.push(`<ul>${items.map((l) => `<li>${l}</li>`).join("")}</ul>`); items = []; };
    for (const l of lines) {
      // "[زر] Book a call" — the call to action as a button; its link is filled in by whoever sends.
      const button = /^\[(?:زر|button)\]\s*(.+)$/i.exec(l);
      if (button) { flushText(); flushList(); out.push(`<p class="cta"><a href="#cta">${button[1]!.trim()}</a></p>`); continue; }
      // A line that is nothing but [Book a call] is a button written without its mark —
      // it went out as bracketed text in one campaign.
      const bare = /^\[([^\]\[]{3,40})\]$/.exec(l);
      if (bare && !/^(ملخص|تفاصيل|summary|details)$/i.test(bare[1]!.trim())) { flushText(); flushList(); out.push(`<p class="cta"><a href="#cta">${bare[1]!.trim()}</a></p>`); continue; }
      // The preview line beside the subject in the inbox: hidden in the body.
      const pre = /^\[(?:معاينة|preview)\]\s*(.+)$/i.exec(l);
      if (pre) { flushText(); flushList(); out.push(`<p class="pre" style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:transparent">${pre[1]!.trim()}</p>`); continue; }
      const hook = /^\[(?:عنوان كبير|headline)\]\s*(.+)$/i.exec(l);
      if (hook) { flushText(); flushList(); out.push(`<h2 class="hook">${hook[1]!.trim()}</h2>`); continue; }
      const note = /^\[(?:إبراز|highlight)\]\s*(.+)$/i.exec(l);
      if (note) { flushText(); flushList(); out.push(`<div class="note">${note[1]!.trim()}</div>`); continue; }
      const lead = /^\[(?:ملخص|summary)\]\s*(.*)$/i.exec(l);
      if (lead) { flushText(); flushList(); if (lead[1]!.trim()) out.push(`<p class="lead">${lead[1]!.trim()}</p>`); continue; }
      if (/^\[(?:تفاصيل|details)\]\s*$/i.test(l)) { flushText(); flushList(); out.push(`<hr class="more">`); continue; }
      if (/^[-•]\s+/.test(l)) { flushText(); items.push(l.replace(/^[-•]\s+/, "")); }
      else { flushList(); text.push(l); }
    }
    flushText(); flushList();
    return out.join("");
  }).join("");
}

// ── Reading the draft ─────────────────────────────────────────────
// The format is asked for exactly, and the free-tier models answer it
// loosely: «[Subject]» for «[عنوان]», «**[عنوان]**», «1. [عنوان]», a bare
// «Subject:», «[message]» or «[body]» for «[الرسالة]», a closing mark left
// out, «Subject:» inside a follow-up instead of «عنوان:». Each of those
// used to make the whole draft unreadable — a null, a warning, and a wave
// written again next round for nothing. So every mark below is read in all
// the ways it has been seen written. The strict shape still parses first.
const SUBJECT_LINE = /^\s*(?:\d+[.)]\s*)?\**\[(?:عنوان|subject)\]\**\s*[:：]?\s*(.+)$/gim;
const BARE_SUBJECT = /^\s*\**(?:Subject|العنوان|عنوان)\**\s*[:：]\s*(.+)$/gim;
const BODY_OPEN = /\**\[(?:الرسالة|message|body|email)\]\**[ \t]*\n?/i;
const BODY_CLOSE = /\**\[\/(?:الرسالة|message|body|email)\]\**/i;
/** Where the body ends when its closing mark is missing: the first follow-up or the reason, else EOF. */
const NEXT_BLOCK = /\**\[(?:متابعة|follow|السبب|why)/i;
const FOLLOW_BLOCK = /\**\[(?:متابعة|follow-?up)([^\]]*)\]\**[ \t]*\n?([\s\S]*?)(?=\**\[\/(?:متابعة|follow-?up)\]|\**\[(?:متابعة|follow-?up)[^\]]*\]|\**\[(?:السبب|why)\]|$(?![\s\S]))/gi;
const FOLLOW_START = /\**\[(?:متابعة|follow-?up)[^\]]*\]/i;
const FOLLOW_SUBJECT =/^\s*\**(?:عنوان|العنوان|subject)\**\s*[:：]\s*(.+)$/im;
const WHY_LINE = /^\s*\**\[(?:السبب|why)\]\**\s*[:：]?\s*(.+)$/im;
const unquote = (x: string) => x.trim().replace(/^["«“]|["»”]$/g, "").replace(/\*\*/g, "").trim();

/** The first email's text between its marks — or to the next block when the writer forgot to close it. Pure. */
export function bodyOf(text: string): string | null {
  const open = BODY_OPEN.exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = BODY_CLOSE.exec(rest);
  const end = close ? close.index : (NEXT_BLOCK.exec(rest)?.index ?? rest.length);
  const body = rest.slice(0, end).trim();
  return body || null;
}

/**
 * Read what she wrote. Pure.
 *
 * `followup`: a follow-up wave (يوسف). Its first email IS a follow-up, and the
 * models answer that request in the follow-up's own shape far more often than
 * in the first email's: only [متابعة] blocks, or «Subject:» and the text with no
 * [الرسالة] mark. Each of those used to read as no draft at all (null) — in the
 * mission a «model did not answer» and in the shadow an empty pair of outputs
 * (2026-11-11, account 2, all three samples). For that role the first [متابعة]
 * block, else the text after the subject lines, is the body. The first email's
 * reading is unchanged.
 */
export function parseDraft(text: string, opts: { followup?: boolean } = {}): EmailDraft | null {
  const bracketed = [...text.matchAll(SUBJECT_LINE)].map((m) => unquote(m[1]!)).filter(Boolean);
  // A bare «Subject: …» counts only before the body — inside a follow-up it is that follow-up's own.
  const bodyAt = BODY_OPEN.exec(text)?.index ?? FOLLOW_START.exec(text)?.index ?? text.length;
  const bare = bracketed.length ? [] : [...text.slice(0, bodyAt).matchAll(BARE_SUBJECT)].map((m) => unquote(m[1]!)).filter(Boolean);
  let subjects = [...new Set(bracketed.length ? bracketed : bare)].slice(0, 3);
  let body = bodyOf(text);
  let blocks = [...text.matchAll(FOLLOW_BLOCK)].map((m) => {
    const inner = m[2]!.trim();
    return { attrs: m[1] ?? "", subject: FOLLOW_SUBJECT.exec(inner)?.[1]?.trim() ?? "", bodyText: inner.replace(FOLLOW_SUBJECT, "").trim() };
  });
  if (!body && opts.followup) {
    const first = blocks.findIndex((b) => b.bodyText);
    if (first >= 0) {
      body = blocks[first]!.bodyText;
      if (!subjects.length && blocks[first]!.subject) subjects = [unquote(blocks[first]!.subject)];
      blocks = blocks.filter((_, i) => i !== first);
    } else if (subjects.length) {
      // «Subject: …» then the text, no marks: everything up to the reason is the body.
      const end = NEXT_BLOCK.exec(text)?.index ?? text.length;
      body = text.slice(0, end).replace(SUBJECT_LINE, "").replace(BARE_SUBJECT, "").trim() || null;
    }
  }
  if (!subjects.length || !body) return null;
  const followups: EmailDraft["followups"] = [];
  for (const b of blocks) {
    const attrs = b.attrs;
    const after = Number(/(?:بعد|after)\s*=\s*(\d+)/i.exec(attrs)?.[1] ?? 72);
    const audience: EmailDraft["followups"][number]["audience"] = /وداع|breakup/i.test(attrs) ? "breakup" : /قيمة|value/i.test(attrs) ? "value" : /زاوية|angle/i.test(attrs) ? "angle" : /تذكير|bump/i.test(attrs) ? "bump" : /بارد|cold/i.test(attrs) ? "cold" : "warm";
    if (b.subject && b.bodyText) followups.push({ audience, afterHours: Math.min(24 * 30, Math.max(24, after)), subject: unquote(b.subject), html: toHtml(b.bodyText) });
  }
  const why = WHY_LINE.exec(text)?.[1]?.trim() ?? "";
  return { subjects, html: toHtml(body), followups, why };
}


/**
 * A campaign for a target: two or three subjects to test, the body, and a
 * follow-up for each audience the campaign will leave behind.
 */
export interface WriteInput {
  filter: SegmentFilter; goal: string; language?: string; tone?: string | null; notes?: string | null; role?: EmailRole; intensity?: string | null;
  /** The last waves this audience already read — subject and lead — so the new one says something else. */
  priorWaves?: Array<{ subject: string; lead: string }>;
  /** This wave's angle (the mission's), and the angles already spent on the audience. */
  angle?: string | null;
  usedAngles?: string[];
  /** Filled by writeCampaign when it returns null: no model answered, or one did and its text did not parse (with its start). */
  trace?: { reason?: "no_reply" | "unparsed"; raw?: string };
}

/**
 * The first email's block for a follow-up wave. يوسف's wave goes to people who
 * already got the first email, so [الرسالة] is itself a follow-up: the summary
 * and the button, 50–70 words, no details. The template used to ask him for a
 * first email with [تفاصيل] and «40–90 words» beside FOLLOWUP_CRAFT and his
 * own «no details section» — two shapes for one request. Pure, exported for tests.
 */
export const FOLLOWUP_BODY_TEMPLATE = [
  "[الرسالة]",
  "Hello {{first_name|there}},",
  "",
  "[ملخص] <THIS WAVE IS ITSELF A FOLLOW-UP — they already got our first email: ONE new angle or fact from the knowledge that they have not read, about {{company|your company}}, and ONE easy question. At most 45 words.>",
  "",
  "[زر] <the call-to-action button: 2 to 5 English words, one easy step>",
  "",
  "Best regards,",
  "The Pro Count team",
  "[/الرسالة]",
  "Structure rules for this follow-up wave: the [الرسالة] block above IS the follow-up and is never left out — 50–70 words, never more than 70; [ملخص] right after the greeting, then [زر]; no [تفاصيل], no [إبراز], no list, and not the first email again. Keep every label exactly as written.",
];

/** The first email's block, as it always was. */
const FIRST_BODY_TEMPLATE = [
  "[الرسالة]",
  "[معاينة] <PREVIEW TEXT, 6–12 words: completes the subject, never repeats it — the second reason to open>",
  "[عنوان كبير] <HEADLINE, 4–9 words: the outcome they want or the risk they avoid — about them, not us>",
  "Hello {{first_name|there}},",
  "",
  "[ملخص] <THE WHOLE EMAIL IN 2–3 LINES, at most 45 words, opening on ONE verifiable fact about their sector from the knowledge (a Ministry fine figure, a legal deadline): their situation (name {{company|your company}}), why it matters now, and the ONE thing we offer. Someone who reads only this line must know what we want and why it is worth their time.>",
  "",
  "[زر] <the call-to-action button: 2 to 5 English words, an interest or a free resource — never a meeting on the first email, e.g. «Get the goAML checklist», «Check my AML gaps», «Worth a look?»>",
  "",
  "[تفاصيل]",
  "- <point 1: what the requirement or problem actually is — from the knowledge only>",
  "- <point 2: what we would check or do for them>",
  "- <point 3 (optional): what they get out of it>",
  "",
  "[إبراز] <ONE line, the single strongest fact in this email — from the knowledge only; omit the line if there is none>",
  "",
  "<ONE short paragraph, max 2 sentences: the reference (law/regulator) or a concrete example — only if it is in the knowledge>",
  "",
  "Best regards,",
  "The Pro Count team",
  "[/الرسالة]",
  "Structure rules: summary first and complete on its own; the button straight after it; everything else under [تفاصيل]; the whole email 40–90 words (at most 110 with the details list); no paragraph longer than 2 sentences.",
];

/** The block that keeps a wave from repeating the last one. Pure, exported for tests. */
export function priorWavesBlock(priorWaves: WriteInput["priorWaves"], angle?: string | null, usedAngles: string[] = []): string {
  const waves = (priorWaves ?? []).filter((w) => w.subject || w.lead).slice(0, 3);
  const lines: string[] = [];
  if (waves.length) lines.push("ما قيل لهذا الجمهور من قبل — لا تعيديه (لا العنوان ولا الفكرة ولا الصياغة):", ...waves.map((w, i) => `${i + 1}. العنوان: «${w.subject}» — الملخص: «${w.lead.slice(0, 220)}»`));
  if (angle) lines.push(`زاوية هذه الموجة: ${angle}.${usedAngles.length ? ` زوايا استُهلكت على هذا الجمهور: ${usedAngles.filter((a) => a !== angle).join("، ")}.` : ""}`);
  else if (usedAngles.length) lines.push(`زوايا استُهلكت على هذا الجمهور — اختاري غيرها: ${usedAngles.join("، ")}.`);
  return lines.join("\n");
}

/**
 * Output budget for the writer. Two subjects, a first email with its
 * details, a warm and a cold follow-up and up to four more run to 1200–1600
 * tokens; the chain's 800 default cut the last follow-ups off mid-block.
 */
export const WRITER_MAX_TOKENS = 2400;

export async function writeCampaign(userId: number, input: WriteInput): Promise<{ draft: EmailDraft; audience: { description: string; count: number; sample: string[] }; provider: string } | null> {
  // A shop writes to people, in its own name, with its pieces (shop-writer.ts).
  const [prof] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  if (isShop(prof as any)) {
    const st = await getSettings(userId).catch(() => null);
    const { writeShopCampaign } = await import("./shop-writer");
    const { STORE_URL } = await import("../catalog/floret");
    return writeShopCampaign(userId, input, { name: st?.brandName ?? (prof?.name ?? "").split("(")[0]!.trim() ?? null, site: st?.website ?? STORE_URL });
  }
  // The writer's own voice — نورة, or يوسف for a follow-up wave — with the team's doctrine.
  const followupWave = (input.role ?? "email") === "email_followup";
  const head = await teamVoice(userId, input.role ?? "email");
  const sectors = input.filter.sectors ?? [];
  const query = `${input.goal} ${input.angle ?? ""} ${sectors.join(" ")}`;
  const [n, sampleRows, knows, facts, docs] = await Promise.all([
    count(userId, input.filter, true),
    resolve(userId, input.filter, { sendable: true, limit: 12 }),
    // Knowledge only: the lessons already arrive through teamVoice's memory preamble.
    brief(userId, sectors, 3500, { lessons: false, query }),
    retrieve(userId, `${input.goal} ${sectors.join(" ")}`, 4).catch(() => []),
    passages(userId, `${input.goal} ${sectors.join(" ")}`, { sectors, limit: 4 }).catch(() => []),
  ]);
  const sample = sampleRows.map((r) => [r.company ?? r.name, r.city].filter(Boolean).join(" — ")).filter(Boolean);
  const audience = { description: describe(input.filter), count: n, sample };
  const lessons = await lessonsFor(userId, input.role ?? "email", input.goal).catch(() => "");
  const more = await companyKnowledge(userId, `${input.goal} ${sectors.join(" ")}`, { limit: 3, exclude: ["kb", "docs", "facts"] }).catch(() => []);
  // ما سلّمه الفريق للكاتب: توجيه منصور، عناوين حصّة، وما أوقفه ماجد.
  const guidance = await writerGuidance(userId, input.role ?? "email").catch(() => ({ block: "", taskIds: [] as number[] }));

  const out = await asAgent(userId, input.role ?? "email", () => complete([
    { role: "system", content: [
      head,
      "",
      lessons,
      knows,
      knowledgeLines(more, "ومما علّمه صاحب العمل في تدريب القروبات:"),
      facts.length ? `من قاعدة معرفة الشركة:\n${facts.map((f) => `- ${f.entry.title}: ${f.entry.content.slice(0, 400)}`).join("\n")}` : "",
      docs.length ? `من مستندات الشركة التي رفعها صاحب العمل:\n${docs.map((d) => `[${d.title}]\n${d.text}`).join("\n\n")}` : "",
      "",
      // الشكل كان موجوداً والصنعة ناقصة: بنيةٌ صحيحة بأثرٍ بارد.
      COLD_CRAFT,
      HOOK_CRAFT,
      // والمتابعات التي تُكتب مع الحملة — ومهمات يوسف كلها — بصنعة المتابعة.
      followupWave ? FOLLOWUP_CRAFT : "المتابعات [متابعة] أدناه: كلٌّ تحمل شيئاً لم يكن في الرسالة الأولى، أقصر منها، بطلبٍ واحد — وبلا «just following up» ولا «checking in» ولا اعتذار عن المتابعة.",
      "",
      priorWavesBlock(input.priorWaves, input.angle, input.usedAngles),
      guidance.block,
      "",
      // One complete, valid answer: a weak model copies a shape far more reliably than it follows a description of one.
      WRITER_EXAMPLE,
      "",
      "المطلوب: حملة بريد لجمهور محدد. اكتبي بهذا الشكل بالضبط ولا شيء خارجه:",
      "[عنوان] <العنوان الأول>",
      "[عنوان] <عنوان ثانٍ بزاوية مختلفة تماماً — سنختبرهما على شريحة>",
      ...(followupWave ? FOLLOWUP_BODY_TEMPLATE : FIRST_BODY_TEMPLATE),
      "[متابعة بعد=72 جمهور=دافئ]",
      "عنوان: <for those who OPENED and did not reply — a new pain point from their sector and ONE easy qualification question>",
      "<[ملخص] one or two lines with the new angle, then [زر] the button — at most 70 words, no [تفاصيل] section>",
      "[/متابعة]",
      "[متابعة بعد=72 جمهور=بارد]",
      "عنوان: <for those who did NOT open — a completely different, shorter subject; the body is the first email's core message, shortened>",
      "<body: the same offer, tighter>",
      "[/متابعة]",
      // After the day-2/3 split, the follow-ups this campaign's intensity calls for, in order.
      ...INTENSITY[asIntensity(input.intensity)].steps.flatMap((st) => FOLLOW_PROMPT[st.kind]),
      "[السبب] <سطر: لماذا هذه الزاوية لهذا الجمهور>",
      "",
      // The owner's rule: every email in English, whatever language the request came in.
      `${languageRule(asLanguage(input.language))} Only the [عنوان]/[الرسالة]/[متابعة] labels stay as they are.`,
      input.tone ? `النبرة: ${input.tone}.` : "",
      "حقول الشخصنة المتاحة فقط: {{first_name}} {{company}} {{city}} {{sender}} — مع بديل بالإنجليزية: {{company|your company}}.",
      "اسم شركة المستلم {{company|your company}} في أحد العنوانين على الأقل وفي السطر الأول، والتوقيع «The Pro Count team» في آخر الرسالة وكل متابعة.",
      "لا رقماً أو غرامة أو مهلة أو سعراً ليس في معرفتك أعلاه — سيُراجع حارس الجودة كل رقم ويوقف الرسالة. لا HTML، نص فقط.",
    ].filter(Boolean).join("\n") },
    { role: "user", content: [
      `الهدف: ${input.goal}`,
      `الجمهور: ${audience.description} — ${n} شركة يمكن مراسلتها.`,
      sample.length ? `أمثلة منهم: ${sample.slice(0, 8).join("؛ ")}` : "",
      input.notes ? `ملاحظات صاحب العمل: ${input.notes}` : "",
    ].filter(Boolean).join("\n") },
  ], 90_000, { maxTokens: WRITER_MAX_TOKENS }));
  if (!out?.text) { if (input.trace) input.trace.reason = "no_reply"; return null; }
  const draft = parseDraft(out.text, { followup: followupWave });
  if (!draft) {
    if (input.trace) { input.trace.reason = "unparsed"; input.trace.raw = out.text.slice(0, 400); }
    logger.warn({ userId, role: input.role ?? "email", sample: out.text.slice(0, 300) }, "مسودة نورة لم تُقرأ");
    return null;
  }
  // كُتبت بها فعلاً: الآن فقط تُعدّ مستعملة.
  // المحاكاة لا تستهلك توجيهاً حقيقياً (lib/org/simulation.ts).
  if (!dryRun()) for (const id of guidance.taskIds) await markUsed(userId, id, { by: input.role ?? "email", subject: draft.subjects[0] ?? null }).catch(() => {});
  // A button's link: WhatsApp with the request written, else the website, else a reply.
  const s = await getSettings(userId).catch(() => null);
  const wa = (s?.phone ?? "").replace(/\D/g, "");
  const link = (label: string, ar: boolean) => wa.length >= 9
    ? `https://wa.me/${wa}?text=${encodeURIComponent(ar ? `مرحباً، أرغب في: ${label}` : `Hello, I would like to: ${label}`)}`
    : s?.website ? (/^https?:/.test(s.website) ? s.website : `https://${s.website}`) : `mailto:${s?.fromEmail ?? ""}?subject=${encodeURIComponent(label)}`;
  const fill = (html: string) => html.replace(/<a href="#cta">([^<]+)<\/a>/g, (_m, label: string) => `<a href="${link(label, /[\u0600-\u06FF]/.test(label))}">${label}</a>`);
  draft.html = fill(draft.html);
  for (const f of draft.followups) f.html = fill(f.html);
  return { draft, audience, provider: out.provider };
}

/** The answer to a reply, in her voice and with what she knows about the sector. */
export async function replyVoice(userId: number, sector: string | null): Promise<string> {
  // ليلى answers when she is on duty; نورة otherwise.
  const role: EmailRole = (await onDuty(userId, "email_replies")) ? "email_replies" : "email";
  return [await teamVoice(userId, role), await brief(userId, sector ? [sector] : [], 2000)].filter(Boolean).join("\n\n");
}

/** A few lines on what a finished mission taught her, written into memory. */
export async function learnFrom(userId: number, sectors: string[], report: unknown): Promise<string[]> {
  const { head } = await voice(userId);
  const out = await asWorker(userId, "email", () => complete([
    { role: "system", content: [head, "",
      "أمامك نتائج حملة بريد انتهت. استخرجي ما يجب أن تتذكريه للحملة القادمة لنفس الجمهور.",
      "من ١ إلى ٤ أسطر، كل سطر بهذا الشكل: الدرس: <سلوك محدد يُكرَّر أو يُتجنَّب، مع الرقم الذي يدعمه>",
      "إن كانت العيّنة صغيرة (أقل من ٣٠ فتحاً أو ٥ ردود) فقولي ذلك في سطر واحد ولا تستنتجي أكثر.",
    ].join("\n") },
    { role: "user", content: JSON.stringify(report).slice(0, 6000) },
  ], 45_000));
  const lessons = (out?.text ?? "").split("\n").map((l) => /الدرس\s*[:：]\s*(.+)/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x).slice(0, 4);
  // A model's reading of a report is a win or a loss, never an «instruction»:
  // that kind is rendered as the owner's own order («التزم بها حرفياً»).
  // والنص نصّ نموذج ولو قرأ أرقاماً صحيحة: معلّقٌ حتى يُعتمد. دروس المدير والعنوان محسوبةٌ بالكود فتمرّ.
  for (const l of lessons) await rememberLesson(userId, lessonKind(l), l, sectors.length === 1 ? sectors[0]! : null, { pending: true });
  return lessons;
}

/** Which way a lesson points: words of failure make it a loss, anything else a win. Pure. */
export function lessonKind(line: string): "win" | "loss" {
  return /(فشل|لم\s|لا\s+يُ|صفر|منخفض|ضعيف|تجنّ|تجن|خسر|أسوأ|اسوأ|بلا رد|بلا ردود|did not|didn't|failed|zero|low\b|avoid|worse)/i.test(line) ? "loss" : "win";
}
