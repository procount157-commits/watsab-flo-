// ── What an employee carries between conversations ────────────────
// The knowledge base is shared: it describes the company, and every employee
// reads it. This is the part that is one employee's own.
//
// Four kinds, and the reason for each:
//
//   instruction  A standing order the owner wrote — "do not quote a price
//                before they tell you their size". It used to require editing
//                a prompt in the source; now it is a row.
//
//   win / loss   What actually worked. An employee that has sent four hundred
//                replies and learnt nothing from any of them is a template,
//                not an agent. Learnt from what the customer said next, which
//                is the only outcome signal a WhatsApp thread gives.
//
//   gap          A question it could not answer. Already surfaced on the
//                dashboard; here it is something the employee itself can act
//                on, by saying it will find out rather than going quiet.

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import {
  db, agentMemoryTable, autoReplyLogTable, agentTasksTable,
  type AgentMemory,
} from "@workspace/db";
import type { Intent } from "./intent";
import { logger } from "./logger";

export type MemoryKind = "instruction" | "win" | "loss" | "gap" | "playbook";

/**
 * Write a lesson down, or note that it happened again.
 *
 * Counting repeats rather than appending rows is what makes the memory
 * readable back: an approach that has failed nine times should outrank one
 * that failed once, and a list of four hundred undifferentiated rows cannot
 * express that.
 */
export async function remember(
  userId: number, role: string, kind: MemoryKind, content: string, phone?: string,
): Promise<void> {
  const text = content.trim().slice(0, 500);
  if (!text) return;
  // Raw, because the unique index is on md5(content) — an expression, which
  // the query builder's onConflictDoUpdate target cannot name. Doing this as
  // select-then-update instead would lose the atomicity, and two messages
  // arriving together is the normal case here.
  await db.execute(sql`
    INSERT INTO agent_memory (user_id, role, kind, content, phone)
    VALUES (${userId}, ${role}, ${kind}, ${text}, ${phone ?? null})
    ON CONFLICT (user_id, role, kind, md5(content))
    DO UPDATE SET times = agent_memory.times + 1, updated_at = NOW()
  `);
}

export async function forget(userId: number, id: number): Promise<void> {
  await db.delete(agentMemoryTable)
    .where(and(eq(agentMemoryTable.id, id), eq(agentMemoryTable.userId, userId)));
}

/** Intents that mean the last reply moved the customer forward, or did not. */
const GOOD: Intent[] = ["interested"];
const BAD:  Intent[] = ["not_interested", "opt_out", "complaint"];

// Every reply gets an outcome now, not only the ones followed by a verdict.
// 103 replies on this account had none — a customer says "مهتم" or "لا" far
// less often than they ask another question, tell you their licence type,
// or simply stop answering — and the coach and the meeting, which need
// outcomes to work from, sat idle on a busy desk.
//
//   win        the customer said they were interested
//   qualified  their next message taught the card a fact — the reply pulled
//              something out of them, which is what discovery is for
//   engaged    they answered with anything at all
//   loss       a refusal, a complaint, or a stop
//   quiet      nothing for a day (set by the sweep below)
export const WIN_OUTCOMES  = ["win", "qualified"] as const;
export const LOSS_OUTCOMES = ["loss", "quiet"] as const;

/**
 * Judge the employee's last reply by what the customer said next.
 *
 * Called when a message arrives, before the reply to it is composed. The
 * signal is weak — a customer who loses interest may have a dozen reasons —
 * so what is stored is the opening of the reply rather than a confident
 * causal claim, and the count is what makes a pattern out of it.
 *
 * Nothing is recorded when the previous reply is older than a day: by then
 * whatever the customer is reacting to is not that message.
 */
const OUTCOME_WINDOW_MS = 24 * 60 * 60_000;

export async function learnFromOutcome(
  userId: number, phone: string, newIntent: Intent,
  opts: { qualified?: boolean } = {},
): Promise<void> {
  const outcome =
    GOOD.includes(newIntent) ? "win" :
    BAD.includes(newIntent)  ? "loss" :
    opts.qualified           ? "qualified" : "engaged";

  const [prev] = await db.select({
    id: autoReplyLogTable.id, reply: autoReplyLogTable.reply,
    role: autoReplyLogTable.agentRole, at: autoReplyLogTable.createdAt,
    outcome: autoReplyLogTable.outcome,
  }).from(autoReplyLogTable)
    .where(and(
      eq(autoReplyLogTable.userId, userId),
      eq(autoReplyLogTable.phone, phone),
      isNotNull(autoReplyLogTable.reply),
    ))
    .orderBy(desc(autoReplyLogTable.createdAt)).limit(1);

  if (!prev?.reply || !prev.role) return;
  if (prev.outcome) return;   // already judged; a second message is not a second outcome
  if (Date.now() - new Date(prev.at).getTime() > OUTCOME_WINDOW_MS) return;

  await db.update(autoReplyLogTable).set({ outcome })
    .where(eq(autoReplyLogTable.id, prev.id));

  // Only a verdict is worth remembering as a pattern. "They answered" is an
  // outcome for the statistics, not a lesson about the opening line.
  if (outcome !== "win" && outcome !== "loss") return;

  // The opening is what the customer reacted to first, and it is short enough
  // to be a recognisable pattern rather than a transcript.
  const opening = prev.reply.trim().split(/\n/)[0]!.slice(0, 180);
  await remember(userId, prev.role, outcome, opening, phone);
  logger.info({ userId, phone, role: prev.role, outcome }, "سُجّلت نتيجة رد");
}

/**
 * A reply nobody answered for a day went quiet. Run hourly.
 *
 * The strongest signal a thread offers is silence, and it was the one never
 * recorded: a reply followed by nothing stayed unjudged for ever. Bounded to
 * the last week so a restart does not rewrite history.
 */
export async function sweepQuietOutcomes(): Promise<number> {
  const rows = await db.execute(sql`
    update auto_reply_log a
       set outcome = 'quiet'
     where a.outcome is null
       and a.reply is not null
       and a.created_at < now() - interval '24 hours'
       and a.created_at > now() - interval '7 days'
       and not exists (
         select 1 from incoming_messages i
          where i.user_id = a.user_id and i.phone = a.phone
            and i.received_at > a.created_at)
    returning a.id`);
  const n = (rows as any).rowCount ?? (rows as any).rows?.length ?? 0;
  if (n > 0) logger.info({ n }, "ردود لم يُجب عنها سُجّلت «صمت»");
  return Number(n);
}

/** An employee's duties, in the order the owner put them. */
export async function tasksFor(userId: number, role: string): Promise<string[]> {
  const rows = await db.select({ task: agentTasksTable.task }).from(agentTasksTable)
    .where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, role),
               eq(agentTasksTable.isActive, true)))
    .orderBy(agentTasksTable.sortOrder);
  return rows.map((r) => r.task);
}

const MAX_PER_KIND = { instruction: 12, win: 5, loss: 5, gap: 4, playbook: 1 } as const;

export async function memoryFor(userId: number, role: string): Promise<Record<MemoryKind, AgentMemory[]>> {
  const rows = await db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, role)))
    .orderBy(desc(agentMemoryTable.times), desc(agentMemoryTable.updatedAt));

  const out: Record<MemoryKind, AgentMemory[]> = { instruction: [], win: [], loss: [], gap: [], playbook: [] };
  for (const r of rows) {
    const k = r.kind as MemoryKind;
    if (out[k] && out[k].length < MAX_PER_KIND[k]) out[k].push(r);
  }
  return out;
}

/**
 * The employee's own memory and duties, as prompt text.
 *
 * Capped hard. A prompt that grows without limit degrades: past a point the
 * model starts following the middle of a long list and dropping the ends, and
 * the personality — which is at the top — is what goes first.
 */
export async function memoryPreamble(userId: number, role: string): Promise<string> {
  const [mem, tasks] = await Promise.all([memoryFor(userId, role), tasksFor(userId, role)]);
  const parts: string[] = [];

  if (tasks.length) {
    parts.push(["مهامك:", ...tasks.map((t) => `- ${t}`)].join("\n"));
  }
  if (mem.instruction.length) {
    // Stated as binding, because that is what the owner meant by writing it.
    parts.push(["تعليمات صاحب العمل لك — التزم بها حرفياً:",
      ...mem.instruction.map((m) => `- ${m.content}`)].join("\n"));
  }
  if (mem.playbook.length) {
    // What the chat lead learnt this week from every conversation — not the
    // owner's word, and so not dressed as one; the shop's rules still win.
    parts.push(mem.playbook[0]!.content);
  }
  if (mem.win.length) {
    parts.push(["أساليب نجحت معك سابقاً:",
      ...mem.win.map((m) => `- ${m.content}${m.times > 1 ? ` (نجحت ${m.times} مرات)` : ""}`)].join("\n"));
  }
  if (mem.loss.length) {
    parts.push(["أساليب لم تنجح — لا تعدها:",
      ...mem.loss.map((m) => `- ${m.content}${m.times > 1 ? ` (فشلت ${m.times} مرات)` : ""}`)].join("\n"));
  }
  if (mem.gap.length) {
    parts.push(["أسئلة لا تعرف جوابها — إن سُئلت عنها فقل إنك ستتأكد وتعود، ولا تخترع:",
      ...mem.gap.map((m) => `- ${m.content}`)].join("\n"));
  }

  return parts.join("\n\n");
}
