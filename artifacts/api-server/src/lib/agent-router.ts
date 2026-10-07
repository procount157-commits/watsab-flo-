// ── Which employee answers, and when they hand over ───────────────
// The owner hires several agents and gives each a personality. This decides
// which one a given message reaches.
//
// Two rules do most of the work, and both exist because of how a real desk
// behaves rather than for tidiness:
//
//   Specialists win over generalists. An agent declares the intents it
//   handles; a complaint goes to whoever handles complaints even when someone
//   else is mid-conversation, because the cost of a sales voice answering a
//   complaint is much higher than the cost of changing hands.
//
//   Otherwise the current owner keeps the thread. Without this a customer's
//   three messages could meet three different names and personalities, which
//   reads as a broken company rather than a helpful one.

import { and, eq } from "drizzle-orm";
import {
  db, botEmployeesTable, conversationOwnerTable, agentHandoffsTable,
  type BotEmployee,
} from "@workspace/db";
import type { Intent } from "./intent";
import { logger } from "./logger";
import { briefColleague } from "./agent-comms";
import { charterBlock } from "./roles/charters";

export type Agent = BotEmployee & { specialties: string[] };

/**
 * Who can take a customer conversation.
 *
 * "manager" is included and "internal" is not. A manager answers — Grok Bot's
 * chief of staff is the single point of contact, and delegates from there — but
 * the monitor watches the system and must never be handed a customer.
 */
async function roster(userId: number): Promise<Agent[]> {
  const rows = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.isActive, true)));
  return rows
    .filter((r) => r.kind === "customer" || r.kind === "manager")
    .map((r) => ({ ...r, specialties: Array.isArray(r.specialties) ? r.specialties as string[] : [] }))
    .sort((a, b) => a.priority - b.priority);
}

export type Routing = {
  agent: Agent;
  /** Set when the thread changed hands, so the reply can say so. */
  handoff?: { from: string; reason: string };
};

/**
 * Pick the agent for this message.
 *
 * `intent` is what the classifier made of the message. Returns null only when
 * the account has no customer-facing agent at all, in which case the caller
 * should fall back to its single-persona path.
 */
export async function route(
  userId: number,
  phone: string,
  intent: Intent,
): Promise<Routing | null> {
  const team = await roster(userId);
  if (team.length === 0) return null;

  // A specialist is one who named this intent explicitly. Sorted by priority,
  // so the first match is the most senior claim on it.
  const specialist = team.find((a) => a.specialties.includes(intent));

  const [owned] = await db.select().from(conversationOwnerTable)
    .where(and(eq(conversationOwnerTable.userId, userId), eq(conversationOwnerTable.phone, phone)))
    .limit(1);
  const current = owned ? team.find((a) => a.role === owned.role) : undefined;

  // Nobody holds it yet, or whoever held it has left the roster.
  //
  // The order is Grok Bot's delegation rule: see whether a specialist owns
  // this kind of work and give it to them; fall back to a generalist; and only
  // put the manager on it when nothing else fits. A manager that answers work
  // a specialist was hired for is not managing.
  if (!current) {
    const agent = specialist
      // A generalist: declares nothing, so takes anything.
      ?? team.find((a) => a.kind !== "manager" && a.specialties.length === 0)
      // Then the manager. Ahead of a specialist who is out of their lane: a
      // complaints agent handed a greeting answers it in the wrong register,
      // and "only handle it yourself if nothing fits" means nothing fits.
      ?? team.find((a) => a.kind === "manager")
      // Nobody fits and there is no manager. Someone has to answer.
      ?? team[0]!;
    await claim(userId, phone, agent.role);
    return { agent };
  }

  // The current owner already handles this intent, or no one claims it —
  // they keep it. This is the common case and costs one query.
  if (!specialist || specialist.role === current.role) {
    // Unless the holder is the manager and someone better has since been
    // hired: the manager took it only because nothing fitted at the time.
    if (current.kind === "manager") {
      const better = team.find((a) => a.kind !== "manager" && a.specialties.includes(intent));
      if (better) {
        const reason = `${INTENT_AR[intent] ?? intent} من اختصاص ${better.name}`;
        await handOver(userId, phone, current.role, better.role, reason);
        return { agent: better, handoff: { from: current.name, reason } };
      }
    }
    return { agent: current };
  }

  // It belongs to someone else. Move it, and say why.
  const reason = `الموضوع تحوّل إلى ${INTENT_AR[intent] ?? intent}`;
  await handOver(userId, phone, current.role, specialist.role, reason);
  return { agent: specialist, handoff: { from: current.name, reason } };
}

const INTENT_AR: Partial<Record<Intent, string>> = {
  complaint:      "شكوى",
  interested:     "اهتمام بالخدمة",
  question:       "سؤال",
  not_interested: "عدم اهتمام",
  opt_out:        "طلب إيقاف",
};

async function claim(userId: number, phone: string, role: string): Promise<void> {
  await db.insert(conversationOwnerTable).values({ userId, phone, role })
    .onConflictDoUpdate({
      target: [conversationOwnerTable.userId, conversationOwnerTable.phone],
      set: { role, since: new Date() },
    });
}

/**
 * Move a conversation to another agent and record it. Exported because an
 * agent can also ask to hand over mid-reply, not only when an intent changes.
 */
export async function handOver(
  userId: number, phone: string,
  fromRole: string | null, toRole: string, reason: string,
): Promise<void> {
  await claim(userId, phone, toRole);
  await db.insert(agentHandoffsTable).values({ userId, phone, fromRole, toRole, reason });
  logger.info({ userId, phone, fromRole, toRole, reason }, "conversation handed to another agent");

  // The briefing costs a model call, so it must not delay the reply the
  // customer is waiting on. It lands a second later and is read on the turn
  // after — which is the right moment anyway, since the agent taking over is
  // about to answer from the transcript it can already see.
  if (fromRole) {
    void briefColleague(userId, phone, fromRole, toRole, reason).catch((err) =>
      logger.warn({ userId, phone, err: String(err?.message ?? err) }, "تعذّرت كتابة ملاحظة التسليم"));
  }
}

// What each role is actually for. A support agent handed the salesperson's
// brief argues with a complaint instead of resolving it, which is the opposite
// of why the owner hired one.
const JOBS: Record<string, string[]> = {
  support: [
    "مهمتك حلّ المشكلة، لا البيع ولا الدفاع عن الشركة:",
    "- اقرأ الشكوى كاملةً واعترف بها بوضوح قبل أي شيء آخر.",
    "- اعتذر مرةً واحدةً بصدق. لا تكرّر الاعتذار ولا تبرّر ولا تلُم العميل.",
    "- اسأل عن التفاصيل التي تُلزمك لفهم ما حدث (رقم، تاريخ، ما الذي تعطّل).",
    "- قل صراحةً إن مختصاً من الفريق سيتابع معه، ولا تَعِد بحلٍّ أو تعويض محدّد.",
    "- لا تعرض خدمةً أخرى ولا تحاول البيع في هذه المحادثة إطلاقاً.",
    "- هدفك أن يخرج من المحادثة وهو يعرف ما الخطوة التالية ومتى، لا أن يقتنع بأننا على حق.",
  ],
};

/**
 * The job brief for the routed agent, or undefined to use the sales default.
 */
export function agentJob(r: Routing): string[] | undefined {
  return JOBS[r.agent.role];
}

/**
 * The agent's own voice, for the top of its instructions.
 *
 * A handoff is stated rather than hidden: a customer who has been talking to
 * هال and suddenly reads a different tone under the same number is owed an
 * explanation, and one line gives it.
 */
export function personaPreamble(r: Routing): string {
  const lines = [`اسمك ${r.agent.name}${r.agent.title ? `، ${r.agent.title}` : ""}.`];
  if (r.agent.persona) lines.push(`شخصيتك: ${r.agent.persona}`);
  const charter = charterBlock(r.agent.role);
  if (charter) lines.push("", charter);
  if (r.handoff) {
    lines.push(
      `تسلّمت هذه المحادثة الآن من زميلك ${r.handoff.from} (${r.handoff.reason}).`,
      `ابدأ ردك بتعريف نفسك باسمك وأنك ستتابع معه من هنا، ثم تابع الموضوع. لا تُعد ما قاله زميلك.`,
    );
  }
  return lines.join("\n");
}
