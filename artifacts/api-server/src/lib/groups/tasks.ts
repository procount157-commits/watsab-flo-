// ── What customers asked for, as tasks ────────────────────────────
// A request in a group — "send us the March statement", "when is the VAT
// return ready?" — used to live only as a line in the chat and a note in
// سارة's file on the group. Now each becomes a task with a due time: read out
// of the conversation when she learns from it, or added by the owner; closed
// when the conversation shows it was done, or by hand. One that passes its
// due time is told to the owner before the customer has to ask again.

import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, waGroupTasksTable, waGroupsTable, type WaGroupTask } from "@workspace/db";
import { notify, esc } from "../telegram";
import { logger } from "../logger";

/** Without a date in the request, a customer expects an answer within a working day. */
export const TASK_SLA_HOURS = 24;

export async function openTasks(userId: number, jid: string) {
  return db.select().from(waGroupTasksTable).where(and(eq(waGroupTasksTable.userId, userId), eq(waGroupTasksTable.groupJid, jid), eq(waGroupTasksTable.status, "open"))).orderBy(asc(waGroupTasksTable.requestedAt));
}

/** The lines the learning prompt is given, numbered so the model can say which were done. */
export function openTaskLines(tasks: WaGroupTask[]) {
  return tasks.map((t, i) => `${i + 1}. ${t.text}${t.requestedBy ? ` (طلبه ${t.requestedBy})` : ""}`).join("\n");
}

export type ParsedTasks = { added: Array<{ text: string; due: Date | null; by: string | null }>; done: number[] };

/**
 * The model's answer, read: new requests as "- what | YYYY-MM-DD | who" (date
 * and who optional), and finished ones as the numbers of the open list.
 * A date is taken only as the customer wrote it — nothing is inferred.
 */
export function parseTasks(text: string, now = new Date()): ParsedTasks {
  const block = (name: string) => new RegExp(`\\[${name}\\]([\\s\\S]*?)(\\[\\/${name}\\]|\\n\\[|$)`).exec(text)?.[1] ?? "";
  const added = block("طلبات").split("\n").map((l) => l.replace(/^\s*[-•*\d.)]+\s*/, "").trim())
    .filter((l) => l.length >= 6 && !/^<.*>$/.test(l) && !/^(لا يوجد|لا طلبات|none)/i.test(l))
    .map((l) => {
      const [what, a, b] = l.split("|").map((x) => x.trim());
      const dateStr = [a, b].find((x) => x && /^\d{4}-\d{2}-\d{2}$/.test(x));
      const by = [a, b].find((x) => x && !/^\d{4}-\d{2}-\d{2}$/.test(x) && !/^(بلا|لا|—|-)$/.test(x)) ?? null;
      const due = dateStr ? new Date(`${dateStr}T18:00:00+04:00`) : null;
      return { text: what!.slice(0, 400), due: due && due.getTime() > now.getTime() - 86_400_000 ? due : null, by: by?.slice(0, 120) ?? null };
    }).slice(0, 8);
  const done = [...block("أُنجز").matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < 100);
  return { added, done };
}

/** Apply what was read: new tasks in, finished ones closed. Duplicates of an open task are not added twice. */
export async function applyTasks(userId: number, jid: string, open: WaGroupTask[], parsed: ParsedTasks, at = new Date()) {
  let added = 0, closed = 0;
  const same = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();
  for (const t of parsed.added) {
    if (open.some((o) => same(o.text, t.text))) continue;
    await db.insert(waGroupTasksTable).values({ userId, groupJid: jid, text: t.text, requestedBy: t.by, requestedAt: at, dueAt: t.due ?? new Date(at.getTime() + TASK_SLA_HOURS * 3_600_000), origin: "learned" });
    added++;
  }
  const ids = parsed.done.map((n) => open[n - 1]?.id).filter((x): x is number => !!x);
  if (ids.length) {
    const r = await db.update(waGroupTasksTable).set({ status: "done", doneAt: new Date(), doneNote: "أُنجز بحسب المحادثة" }).where(and(inArray(waGroupTasksTable.id, ids), eq(waGroupTasksTable.status, "open"))).returning({ id: waGroupTasksTable.id });
    closed = r.length;
  }
  return { added, closed };
}

/** Every open task past its due time and not yet told, to the owner in one message per sweep. */
export async function remindOverdue(userId?: number) {
  const due = await db.select({ t: waGroupTasksTable, subject: waGroupsTable.subject }).from(waGroupTasksTable)
    .leftJoin(waGroupsTable, and(eq(waGroupsTable.userId, waGroupTasksTable.userId), eq(waGroupsTable.jid, waGroupTasksTable.groupJid)))
    .where(and(eq(waGroupTasksTable.status, "open"), lt(waGroupTasksTable.dueAt, new Date()), isNull(waGroupTasksTable.remindedAt), userId ? eq(waGroupTasksTable.userId, userId) : sql`true`));
  const byUser = new Map<number, typeof due>();
  for (const r of due) byUser.set(r.t.userId, [...(byUser.get(r.t.userId) ?? []), r]);
  for (const [uid, rows] of byUser) {
    await notify(uid, [`<b>⏰ طلبات عملاء تأخّرت (${rows.length})</b>`, ...rows.slice(0, 15).map((r) => `• <b>${esc(r.subject ?? "قروب")}</b>: ${esc(r.t.text.slice(0, 160))}`), rows.length > 15 ? `و${rows.length - 15} أخرى — في صفحة القروبات` : ""].filter(Boolean).join("\n"), "groups").catch(() => {});
    await db.update(waGroupTasksTable).set({ remindedAt: new Date() }).where(inArray(waGroupTasksTable.id, rows.map((r) => r.t.id)));
  }
  return due.length;
}

export function startTaskReminders() {
  setInterval(() => void remindOverdue().catch((err) => logger.warn({ err: String(err) }, "task reminders failed")), 30 * 60_000);
}
