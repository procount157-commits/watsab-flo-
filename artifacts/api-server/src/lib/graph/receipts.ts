// ── Receipts: what every employee did, kept where it cannot be rewritten ──
// The team's work was scattered over seven tables — model usage in one,
// email activity in another, social in a third, follow-up decisions, auto-
// reply logs, handoffs, messages between employees — and nothing read them
// together. So nobody could answer the owner's plainest question: which of
// my employees did what today, and did any of it bring a client closer?
//
// A receipt is one line per act: a model call, a message sent, a decision
// taken, a veto, a clean-up, a handoff. Who, what, about whom, with which
// model and how many tokens, whether it worked, where the work went next,
// and why — in a sentence. The database chains each to the one before it
// (migration 047), so a changed or missing row is found by
// receipts_first_broken().
//
// Writing one never stops the work it records: it is fire-and-forget, and a
// failure to write is logged, not thrown.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { currentAgent } from "../agent-context";
import { logger } from "../logger";

export type ReceiptStatus = "ok" | "failed" | "blocked" | "retried" | "deferred";

export type Receipt = {
  userId: number;
  node?: string;            // defaults to the employee whose work is running (asAgent)
  graph?: string;           // defaults from the node
  action: string;
  status?: ReceiptStatus;
  subject?: string | null;  // phone, address or campaign — kept here, never exported
  inputRef?: string | null;
  outputRef?: string | null;
  evidence?: unknown;
  metric?: unknown;
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
  edge?: string | null;
  why?: string | null;
  goalId?: number | null;
  runId?: string | null;
  at?: Date;
  inferred?: boolean;
};

/** Which graph a node belongs to. Pure. */
export function graphOf(node: string): string {
  if (/^(ig|tt|li|fb|x)_/.test(node)) return "social";
  if (node.startsWith("email") || node === "email") return "email";
  if (["sales", "support", "followup", "router", "gate", "sender", "campaign", "reviewer"].includes(node)) return "whatsapp";
  if (node === "groups") return "groups";
  if (["ops", "monitor", "intake", "collector"].includes(node)) return "ops";
  if (node === "chief") return "manager";
  return "other";
}

/** Tokens from characters, when the provider did not say. Arabic runs denser than English; four is the honest middle. */
export const tokensOf = (chars: number) => Math.max(0, Math.round(chars / 4));

let unattributed = 0;

export function receipt(r: Receipt): void {
  const node = r.node ?? currentAgent()?.role ?? "unattributed";
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  void db.execute(sql`
    INSERT INTO receipts (user_id, at, graph, node, goal_id, run_id, action, status, subject, input_ref, output_ref,
                          evidence, metric, model, tokens_in, tokens_out, duration_ms, edge, why, inferred)
    VALUES (${r.userId}, ${r.at ?? new Date()}, ${r.graph ?? graphOf(node)}, ${node.slice(0, 40)}, ${r.goalId ?? null}, ${r.runId?.slice(0, 64) ?? null},
            ${r.action.slice(0, 40)}, ${r.status ?? "ok"}, ${r.subject?.slice(0, 160) ?? null}, ${r.inputRef?.slice(0, 160) ?? null}, ${r.outputRef?.slice(0, 160) ?? null},
            ${json(r.evidence)}::jsonb, ${json(r.metric)}::jsonb, ${r.model?.slice(0, 80) ?? null}, ${r.tokensIn ?? null}, ${r.tokensOut ?? null},
            ${r.durationMs ?? null}, ${r.edge?.slice(0, 60) ?? null}, ${r.why?.slice(0, 1000) ?? null}, ${!!r.inferred})`)
    .catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200), action: r.action, node }, "receipt not written"));
}

/** A model call made outside any employee's work — counted so it can be found and attributed. */
export function noteUnattributedCall() {
  unattributed++;
  if (unattributed === 1 || unattributed % 50 === 0) logger.warn({ unattributed }, "model call with no employee attached — it has no receipt");
}

/** The first row of an account's ledger that fails its hash — null when intact. */
export async function firstBroken(userId: number): Promise<number | null> {
  const r = await db.execute<{ id: string | null }>(sql`SELECT receipts_first_broken(${userId}) AS id`);
  const id = r.rows[0]?.id;
  return id == null ? null : Number(id);
}
