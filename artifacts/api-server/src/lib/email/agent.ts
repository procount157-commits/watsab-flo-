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

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, agentMemoryTable, botEmployeesTable, businessProfileTable, DEFAULT_EMPLOYEES, type SegmentFilter } from "@workspace/db";
import { complete } from "../llm";
import { retrieve } from "../knowledge";
import { skillsFor, skillsPreamble } from "../agent-skills";
import { seedSkills } from "../skills";
import { logger } from "../logger";
import { count, describe, resolve } from "./segments";
import { passages } from "./knowledge-docs";
import { getSettings } from "./service";
import { teamVoice, onDuty, type EmailRole } from "./team";
import { asLanguage, languageRule } from "./language";
import { INTENSITY, FOLLOW_PROMPT, asIntensity } from "./intensity";

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

export async function rememberLesson(userId: number, kind: "win" | "loss" | "instruction", content: string, topic: string | null) {
  const text = content.trim().slice(0, 500);
  if (!text) return;
  await db.execute(sql`
    INSERT INTO agent_memory (user_id, role, kind, content, topic)
    VALUES (${userId}, ${EMAIL_ROLE}, ${kind}, ${text}, ${topic})
    ON CONFLICT (user_id, role, kind, md5(content))
    DO UPDATE SET times = agent_memory.times + 1, updated_at = NOW()
  `);
}

export async function memory(userId: number) {
  return db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE)))
    .orderBy(desc(agentMemoryTable.updatedAt));
}

/** What applies to these sectors: their own items first, then the general ones, within a budget. */
export async function brief(userId: number, sectors: string[] = [], budget = 3500) {
  const rows = await db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE),
      sectors.length ? or(isNull(agentMemoryTable.topic), inArray(agentMemoryTable.topic, sectors))! : sql`true`))
    .orderBy(desc(agentMemoryTable.times), desc(agentMemoryTable.updatedAt));
  const pick = (kind: string) => rows.filter((r) => r.kind === kind)
    .sort((a, b) => Number(!!b.topic) - Number(!!a.topic));
  const take = (items: typeof rows, max: number) => {
    const out: string[] = []; let used = 0;
    for (const r of items) { const line = `- ${r.topic ? `[${r.topic}] ` : ""}${r.content}`; if (used + line.length > max) break; out.push(line); used += line.length; }
    return out;
  };
  const knowledge = take(pick(KNOWLEDGE), budget);
  const rules = take(pick("instruction"), 900);
  const wins = take(pick("win"), 600);
  const losses = take(pick("loss"), 500);
  return [
    knowledge.length ? `ما تعرفينه عن عملنا وعن هذا القطاع:\n${knowledge.join("\n")}` : "",
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
      agent.persona ?? "",
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
  const out = await complete([
    { role: "system", content: [
      "أنت تحفظين معرفة علّمك إياها صاحب العمل لتستخدميها في كتابة البريد التسويقي.",
      "استخرجي من النص الحقائق المفيدة للبيع: ما نقدّمه، لمن، ما يقلق كل قطاع، الالتزامات والمواعيد كما وردت حرفياً، أسلوبنا، ما لا يُقال.",
      "كل حقيقة في سطر مستقل مكتفٍ بذاته، بهذا الشكل بالضبط:",
      "حقيقة: <الحقيقة> | القطاع: <اسم القطاع أو عام>",
      "لا تخترعي شيئاً ليس في النص. انقلي الأرقام والمواعيد كما هي. من ٣ إلى ٢٠ سطراً.",
      topic ? `النص كله عن قطاع: ${topic} — إلا ما كان عاماً بوضوح.` : "",
    ].filter(Boolean).join("\n") },
    { role: "user", content: src },
  ], 60_000);

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
  return text.trim().split(/\n\s*\n/).map((para) => {
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
      if (/^[-•]\s+/.test(l)) { flushText(); items.push(l.replace(/^[-•]\s+/, "")); }
      else { flushList(); text.push(l); }
    }
    flushText(); flushList();
    return out.join("");
  }).join("");
}

/** Read what she wrote. Pure. */
export function parseDraft(text: string): EmailDraft | null {
  const subjects = [...text.matchAll(/^\s*\[عنوان\]\s*(.+)$/gm)].map((m) => m[1]!.trim().replace(/^["«]|["»]$/g, "")).filter(Boolean).slice(0, 3);
  const body = /\[الرسالة\]\s*\n?([\s\S]*?)\[\/الرسالة\]/.exec(text)?.[1]?.trim();
  if (!subjects.length || !body) return null;
  const followups: EmailDraft["followups"] = [];
  for (const m of text.matchAll(/\[متابعة([^\]]*)\]\s*\n?([\s\S]*?)\[\/متابعة\]/g)) {
    const attrs = m[1] ?? "";
    const after = Number(/بعد\s*=\s*(\d+)/.exec(attrs)?.[1] ?? 72);
    const audience: EmailDraft["followups"][number]["audience"] = /وداع|breakup/.test(attrs) ? "breakup" : /قيمة|value/.test(attrs) ? "value" : /زاوية|angle/.test(attrs) ? "angle" : /تذكير|bump/.test(attrs) ? "bump" : /بارد|cold/.test(attrs) ? "cold" : "warm";
    const inner = m[2]!.trim();
    const subject = /^\s*عنوان\s*[:：]\s*(.+)$/m.exec(inner)?.[1]?.trim();
    const bodyText = inner.replace(/^\s*عنوان\s*[:：].*$/m, "").trim();
    if (subject && bodyText) followups.push({ audience, afterHours: Math.min(24 * 30, Math.max(24, after)), subject, html: toHtml(bodyText) });
  }
  const why = /^\s*\[السبب\]\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { subjects, html: toHtml(body), followups, why };
}


/**
 * A campaign for a target: two or three subjects to test, the body, and a
 * follow-up for each audience the campaign will leave behind.
 */
export async function writeCampaign(userId: number, input: { filter: SegmentFilter; goal: string; language?: string; tone?: string | null; notes?: string | null; role?: EmailRole; intensity?: string | null }): Promise<{ draft: EmailDraft; audience: { description: string; count: number; sample: string[] }; provider: string } | null> {
  // The writer's own voice — نورة, or يوسف for a follow-up wave — with the team's doctrine.
  const head = await teamVoice(userId, input.role ?? "email");
  const sectors = input.filter.sectors ?? [];
  const [n, sampleRows, knows, facts, docs] = await Promise.all([
    count(userId, input.filter, true),
    resolve(userId, input.filter, { sendable: true, limit: 12 }),
    brief(userId, sectors),
    retrieve(userId, `${input.goal} ${sectors.join(" ")}`, 4).catch(() => []),
    passages(userId, `${input.goal} ${sectors.join(" ")}`, { sectors, limit: 4 }).catch(() => []),
  ]);
  const sample = sampleRows.map((r) => [r.company ?? r.name, r.city].filter(Boolean).join(" — ")).filter(Boolean);
  const audience = { description: describe(input.filter), count: n, sample };

  const out = await complete([
    { role: "system", content: [
      head,
      "",
      knows,
      facts.length ? `من قاعدة معرفة الشركة:\n${facts.map((f) => `- ${f.entry.title}: ${f.entry.content.slice(0, 400)}`).join("\n")}` : "",
      docs.length ? `من مستندات الشركة التي رفعها صاحب العمل:\n${docs.map((d) => `[${d.title}]\n${d.text}`).join("\n\n")}` : "",
      "",
      "المطلوب: حملة بريد لجمهور محدد. اكتبي بهذا الشكل بالضبط ولا شيء خارجه:",
      "[عنوان] <العنوان الأول>",
      "[عنوان] <عنوان ثانٍ بزاوية مختلفة تماماً — سنختبرهما على شريحة>",
      "[الرسالة]",
      "<the email: short paragraphs separated by a blank line, opening «Hello {{first_name|there}},» or a greeting naming the company, ending with ONE request, then the button line, then «Best regards,» and «The Pro Count team»>",
      "[زر] <the call-to-action button: 2 to 5 English words, e.g. «Review your AML readiness», «Book a free consultation»> — its own line before the sign-off, in the email and in every follow-up",
      "[/الرسالة]",
      "[متابعة بعد=72 جمهور=دافئ]",
      "عنوان: <for those who OPENED and did not reply — a new pain point from their sector and ONE easy qualification question>",
      "<short body, new angle, not a repeat>",
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
  ], 90_000);
  if (!out?.text) return null;
  const draft = parseDraft(out.text);
  if (!draft) { logger.warn({ userId, sample: out.text.slice(0, 300) }, "مسودة نورة لم تُقرأ"); return null; }
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
  const out = await complete([
    { role: "system", content: [head, "",
      "أمامك نتائج حملة بريد انتهت. استخرجي ما يجب أن تتذكريه للحملة القادمة لنفس الجمهور.",
      "من ١ إلى ٤ أسطر، كل سطر بهذا الشكل: الدرس: <سلوك محدد يُكرَّر أو يُتجنَّب، مع الرقم الذي يدعمه>",
      "إن كانت العيّنة صغيرة (أقل من ٣٠ فتحاً أو ٥ ردود) فقولي ذلك في سطر واحد ولا تستنتجي أكثر.",
    ].join("\n") },
    { role: "user", content: JSON.stringify(report).slice(0, 6000) },
  ], 45_000);
  const lessons = (out?.text ?? "").split("\n").map((l) => /الدرس\s*[:：]\s*(.+)/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x).slice(0, 4);
  for (const l of lessons) await rememberLesson(userId, "instruction", l, sectors.length === 1 ? sectors[0]! : null);
  return lessons;
}
