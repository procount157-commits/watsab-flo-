// ── Employees talking to each other ───────────────────────────────
// A handoff says a conversation moved. This says what the person taking it
// over needs to know — which is the difference between passing a customer to
// a colleague and dropping them on one.
//
// Nothing here reaches a customer. These are internal notes, and the only way
// they affect a reply is by being read into the recipient's prompt.

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  db, agentMessagesTable, botEmployeesTable, waThreadMessagesTable,
  type AgentMessage,
} from "@workspace/db";
import { complete } from "./llm";
import { logger } from "./logger";
import { receipt } from "./graph/receipts";

export type MessageKind = "handoff" | "directive" | "alert" | "report" | "question" | "answer";

export async function say(row: {
  userId: number; fromRole: string; toRole?: string | null;
  kind?: MessageKind; body: string; phone?: string | null;
}): Promise<void> {
  const body = row.body.trim().slice(0, 2_000);
  if (!body) return;
  receipt({ userId: row.userId, node: row.fromRole, action: `edge.${row.kind ?? "report"}`, subject: row.phone ?? null, edge: row.toRole ?? "all", why: body.slice(0, 300) });
  await db.insert(agentMessagesTable).values({
    userId: row.userId, fromRole: row.fromRole, toRole: row.toRole ?? null,
    kind: row.kind ?? "report", body, phone: row.phone ?? null,
  });
}

/**
 * Unread messages addressed to this employee, as prompt text.
 *
 * Marked read as they are handed over, because for a bot "read" can only mean
 * "was put in front of it when it wrote a reply" — there is no other moment
 * at which it could have taken them in.
 */
export async function inboxPreamble(
  userId: number, role: string, phone?: string,
): Promise<string> {
  const rows = await db.select().from(agentMessagesTable)
    .where(and(
      eq(agentMessagesTable.userId, userId),
      or(eq(agentMessagesTable.toRole, role), isNull(agentMessagesTable.toRole)),
      isNull(agentMessagesTable.readAt),
      // A note about another customer is noise in this conversation.
      phone ? or(eq(agentMessagesTable.phone, phone), isNull(agentMessagesTable.phone))
            : isNull(agentMessagesTable.phone),
    ))
    .orderBy(desc(agentMessagesTable.createdAt))
    .limit(6);
  if (rows.length === 0) return "";

  const names = await roleNames(userId);
  await db.update(agentMessagesTable).set({ readAt: new Date() })
    .where(sql`id = ANY(${sql.raw(`ARRAY[${rows.map((r) => r.id).join(",")}]`)})`);

  return ["رسائل من زملائك — اعمل بها ولا تذكرها للعميل:",
    ...rows.reverse().map((m) => `- ${names[m.fromRole] ?? m.fromRole}: ${m.body}`)].join("\n");
}

async function roleNames(userId: number): Promise<Record<string, string>> {
  const rows = await db.select({ role: botEmployeesTable.role, name: botEmployeesTable.name })
    .from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId));
  return Object.fromEntries(rows.map((r) => [r.role, r.name]));
}

/**
 * The note one employee leaves another when a conversation changes hands.
 *
 * Written by the model because the useful content is a judgement — what the
 * customer actually wants, what has been promised, what to avoid — and a
 * template can only restate the transcript. Falls back to a plain statement
 * of the reason when no model is reachable, which is still better than a
 * silent handover.
 */
export async function briefColleague(
  userId: number, phone: string, fromRole: string, toRole: string, reason: string,
): Promise<void> {
  const names = await roleNames(userId);
  const from = names[fromRole] ?? fromRole, to = names[toRole] ?? toRole;

  const history = await db.select({
    fromMe: waThreadMessagesTable.fromMe, text: waThreadMessagesTable.text,
  }).from(waThreadMessagesTable)
    .where(and(eq(waThreadMessagesTable.userId, userId), eq(waThreadMessagesTable.phone, phone)))
    .orderBy(desc(waThreadMessagesTable.createdAt)).limit(8);

  if (history.length === 0) {
    await say({ userId, fromRole, toRole, kind: "handoff", phone,
      body: `محادثة جديدة، ${reason}. لا سياق سابق.` });
    return;
  }

  const transcript = history.reverse()
    .map((h) => `${h.fromMe ? from : "العميل"}: ${(h.text ?? "").slice(0, 200)}`).join("\n");

  const out = await complete([
    { role: "system", content: [
      `أنت ${from}. تسلّم محادثة عميل لزميلك ${to} لأن ${reason}.`,
      "اكتب له ملاحظة داخلية قصيرة جداً — سطران على الأكثر — تخبره بما يحتاجه فقط:",
      "ماذا يريد العميل، وما الذي قيل له أو وُعد به، وما الذي عليه تجنّبه.",
      "لا تكتب رسالة للعميل، ولا تلخّص المحادثة كاملةً، ولا تحيّي زميلك.",
    ].join("\n") },
    { role: "user", content: transcript },
  ], 15_000);

  await say({
    userId, fromRole, toRole, kind: "handoff", phone,
    body: out?.text?.trim() || `${reason}. راجع المحادثة قبل ردّك.`,
  });
  logger.info({ userId, phone, fromRole, toRole }, "تُركت ملاحظة تسليم");
}

/** The whole team's traffic, newest first, with names resolved for display. */
export async function recentTraffic(userId: number, limit = 40): Promise<Array<AgentMessage & {
  fromName: string; toName: string | null;
}>> {
  const [rows, names] = await Promise.all([
    db.select().from(agentMessagesTable).where(eq(agentMessagesTable.userId, userId))
      .orderBy(desc(agentMessagesTable.createdAt)).limit(limit),
    roleNames(userId),
  ]);
  return rows.map((r) => ({
    ...r,
    fromName: names[r.fromRole] ?? r.fromRole,
    toName: r.toRole ? (names[r.toRole] ?? r.toRole) : null,
  }));
}
