// ── Learning from every edit ──────────────────────────────────────
// Every draft an employee writes ends one of three ways: the owner sends it as
// it was, edits it, or throws it away. All three are recorded here, on every
// desk. The edits are the lessons: next time a similar case reaches the same
// employee, the closest ones are put in front of it — "you wrote this, the
// owner sent that" — and the counts are its accuracy on the team page.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, agentFeedbackTable, llmUsageTable } from "@workspace/db";
import { terms } from "./knowledge";
import { logger } from "./logger";

export type Verdict = "approved" | "edited" | "rejected";

const norm = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** How much of the shorter text the longer one keeps, by words. 1 is the same. */
export function likeness(a: string, b: string): number {
  const A = new Set(terms(norm(a))), B = new Set(terms(norm(b)));
  if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
  let both = 0;
  for (const t of A) if (B.has(t)) both++;
  return Math.round((both / Math.max(A.size, B.size)) * 100) / 100;
}

/**
 * One outcome. `final` is what was actually sent; when it is the draft with
 * only spaces changed, the verdict is approved whatever the caller said.
 */
export async function recordFeedback(f: {
  userId: number; role: string; channel: "email" | "social" | "groups" | "whatsapp"; kind: string;
  refId?: string | number | null; context?: string | null; original: string; final?: string | null; verdict: Verdict;
}) {
  if (!f.original?.trim()) return;
  let verdict = f.verdict;
  if (verdict === "edited" && f.final != null && norm(f.final) === norm(f.original)) verdict = "approved";
  const score = verdict === "approved" ? 1 : verdict === "rejected" ? 0 : f.final ? likeness(f.original, f.final) : null;
  await db.insert(agentFeedbackTable).values({
    userId: f.userId, role: f.role, channel: f.channel, kind: f.kind.slice(0, 20), refId: f.refId != null ? String(f.refId).slice(0, 60) : null,
    context: f.context?.slice(0, 2_000) ?? null, original: f.original.slice(0, 6_000), final: f.final?.slice(0, 6_000) ?? null, verdict, score,
  }).catch((err) => logger.warn({ err: String(err) }, "feedback record failed"));
}

/** Edited or rejected before → the closest such cases to this one, as lines for the prompt. */
export async function lessonsFor(userId: number, role: string, context: string, limit = 3): Promise<string> {
  const rows = await db.select().from(agentFeedbackTable)
    .where(and(eq(agentFeedbackTable.userId, userId), eq(agentFeedbackTable.role, role), sql`${agentFeedbackTable.verdict} in ('edited','rejected')`))
    .orderBy(desc(agentFeedbackTable.createdAt)).limit(200).catch(() => []);
  if (!rows.length) return "";
  const ctx = norm(context);
  const ranked = rows.map((r) => ({ r, s: ctx ? likeness(ctx, r.context ?? r.original) : 0 }))
    .sort((a, b) => b.s - a.s || b.r.createdAt.getTime() - a.r.createdAt.getTime()).slice(0, limit);
  const cut = (s: string, n: number) => { const t = norm(s); return t.length > n ? `${t.slice(0, n)}…` : t; };
  return [
    "دروس من تعديلات صاحب العمل على مسوداتك السابقة — تعلّم منها ولا تكرر ما صحّحه:",
    ...ranked.map(({ r }) => r.verdict === "edited"
      ? `- ${r.context ? `في: «${cut(r.context, 140)}» — ` : ""}كتبتَ «${cut(r.original, 220)}» فأرسل بدلاً منه «${cut(r.final ?? "", 260)}»`
      : `- ${r.context ? `في: «${cut(r.context, 140)}» — ` : ""}رفض ما كتبتَه: «${cut(r.original, 220)}»`),
  ].join("\n");
}

/** Per employee over a window: how often the owner sent their draft as it was. */
export async function accuracyByRole(userId: number, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db.select({
    role: agentFeedbackTable.role,
    approved: sql<number>`count(*) filter (where ${agentFeedbackTable.verdict} = 'approved')::int`,
    edited: sql<number>`count(*) filter (where ${agentFeedbackTable.verdict} = 'edited')::int`,
    rejected: sql<number>`count(*) filter (where ${agentFeedbackTable.verdict} = 'rejected')::int`,
    avgScore: sql<number>`avg(${agentFeedbackTable.score})`,
  }).from(agentFeedbackTable).where(and(eq(agentFeedbackTable.userId, userId), gte(agentFeedbackTable.createdAt, since))).groupBy(agentFeedbackTable.role);
  return new Map(rows.map((r) => {
    const decided = r.approved + r.edited + r.rejected;
    return [r.role, { ...r, decided, rate: decided ? Math.round((r.approved / decided) * 100) : null, avgScore: r.avgScore != null ? Math.round(Number(r.avgScore) * 100) : null }];
  }));
}

// ── What each employee costs ─────────────────────────────────────
export async function recordUsage(userId: number, role: string, u: { ok: boolean; charsIn: number; charsOut: number; ms: number }) {
  await db.insert(llmUsageTable).values({ userId, role: role.slice(0, 30), day: new Date().toISOString().slice(0, 10), calls: 1, failed: u.ok ? 0 : 1, charsIn: u.charsIn, charsOut: u.charsOut, ms: u.ms })
    .onConflictDoUpdate({ target: [llmUsageTable.userId, llmUsageTable.role, llmUsageTable.day], set: {
      calls: sql`${llmUsageTable.calls} + 1`, failed: sql`${llmUsageTable.failed} + ${u.ok ? 0 : 1}`,
      charsIn: sql`${llmUsageTable.charsIn} + ${u.charsIn}`, charsOut: sql`${llmUsageTable.charsOut} + ${u.charsOut}`, ms: sql`${llmUsageTable.ms} + ${u.ms}`,
    } }).catch(() => {});
}

export async function usageByRole(userId: number, days = 30) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.select({ role: llmUsageTable.role, calls: sql<number>`sum(${llmUsageTable.calls})::int`, failed: sql<number>`sum(${llmUsageTable.failed})::int`,
    charsIn: sql<number>`sum(${llmUsageTable.charsIn})::bigint`, charsOut: sql<number>`sum(${llmUsageTable.charsOut})::bigint` })
    .from(llmUsageTable).where(and(eq(llmUsageTable.userId, userId), gte(llmUsageTable.day, since))).groupBy(llmUsageTable.role);
  // Roughly four characters to a token across Arabic and English — close enough to compare employees.
  return new Map(rows.map((r) => [r.role, { calls: Number(r.calls), failed: Number(r.failed), tokens: Math.round((Number(r.charsIn) + Number(r.charsOut)) / 4) }]));
}
