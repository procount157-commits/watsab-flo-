// ── Phase 0: what each employee actually did, before there were receipts ──
// The last fourteen days rebuilt from the seven old logs, one receipt per
// act (per day, for the counts that were only ever kept per day), marked
// `inferred` so they can never be mistaken for receipts written at the time.
// Run once per account: if inferred receipts exist, it does nothing.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export async function backfillReceipts(userId: number, days = 14): Promise<number> {
  const [done] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM receipts WHERE user_id = ${userId} AND inferred`)).rows as any[];
  if (Number(done?.n) > 0) return 0;
  const since = sql`now() - make_interval(days => ${days})`;
  const r = await db.execute(sql`
    INSERT INTO receipts (user_id, at, graph, node, action, status, subject, evidence, model, tokens_in, tokens_out, edge, why, inferred)
    SELECT ${userId}, at, graph, node, action, status, subject, evidence, NULL, tin, tout, edge, why, true FROM (
      -- WhatsApp replies and the decisions not to reply
      SELECT created_at AS at, 'whatsapp' AS graph, coalesce(agent_role, CASE WHEN reply IS NOT NULL THEN 'sales' ELSE 'router' END) AS node,
             CASE WHEN reply IS NOT NULL AND skipped IS NULL THEN 'reply' ELSE 'decide' END AS action,
             CASE WHEN reply IS NOT NULL AND skipped IS NULL THEN 'ok' ELSE 'blocked' END AS status,
             phone AS subject, jsonb_build_object('intent', intent, 'quality', quality_score) AS evidence,
             NULL::int AS tin, NULL::int AS tout, NULL AS edge, skipped AS why
        FROM auto_reply_log WHERE user_id = ${userId} AND created_at > ${since}
      UNION ALL
      -- The email team
      SELECT created_at, 'email', role, left('email.' || action, 40), CASE WHEN action IN ('hold','blocked') THEN 'blocked' ELSE 'ok' END,
             NULL, ref, NULL, NULL, NULL, left(text, 1000)
        FROM email_agent_activity WHERE user_id = ${userId} AND created_at > ${since}
      UNION ALL
      -- The social teams
      SELECT created_at, 'social', role, left('social.' || action, 40), 'ok', NULL, ref, NULL, NULL, NULL, left(text, 1000)
        FROM social_activity WHERE user_id = ${userId} AND created_at > ${since}
      UNION ALL
      -- Follow-up decisions: the old ladder (argued by the manager) and خالد's
      SELECT created_at, 'whatsapp', CASE WHEN step >= 100 THEN 'followup' ELSE 'chief' END,
             CASE WHEN executed THEN 'followup.sent' WHEN verdict = 'send' THEN 'followup.draft' ELSE 'followup.decline' END,
             CASE WHEN executed OR verdict = 'send' THEN 'ok' ELSE 'blocked' END, phone, jsonb_build_object('step', step), NULL, NULL, NULL, left(reason, 600)
        FROM followup_deliberations WHERE user_id = ${userId} AND created_at > ${since}
      UNION ALL
      -- What the employees said to one another
      SELECT created_at, NULL, from_role, left('edge.' || kind, 40), 'ok', phone, NULL, NULL, NULL, coalesce(to_role, 'all'), left(body, 300)
        FROM agent_messages WHERE user_id = ${userId} AND created_at > ${since}
      UNION ALL
      -- Model use, kept only per employee per day
      SELECT day::timestamptz + interval '23 hours 59 minutes', NULL, role, 'llm.daily', CASE WHEN failed > 0 AND failed = calls THEN 'failed' ELSE 'ok' END,
             NULL, jsonb_build_object('calls', calls, 'failed', failed, 'ms', ms), (chars_in / 4)::int, (chars_out / 4)::int, NULL, NULL
        FROM llm_usage WHERE user_id = ${userId} AND day > (now() - make_interval(days => ${days}))::date
      UNION ALL
      -- Campaign messages, per day
      SELECT date_trunc('day', m.sent_at) + interval '23 hours 58 minutes', 'whatsapp', 'campaign', 'send.whatsapp.daily', 'ok', NULL,
             jsonb_build_object('sent', count(*), 'read', count(m.read_at)), NULL, NULL, NULL, NULL
        FROM message_logs m JOIN campaigns c ON c.id = m.campaign_id
        WHERE c.user_id = ${userId} AND m.status = 'sent' AND m.sent_at > ${since} GROUP BY 1
      UNION ALL
      -- Emails, per day
      SELECT date_trunc('day', sent_at) + interval '23 hours 57 minutes', 'email', 'sender', 'send.email.daily', 'ok', NULL,
             jsonb_build_object('sent', count(*)), NULL, NULL, NULL, NULL
        FROM email_messages WHERE user_id = ${userId} AND status IN ('sent','bounced') AND sent_at > ${since} GROUP BY 1
    ) x
    ORDER BY at`);
  const n = (r as any).rowCount ?? 0;
  // Graph by node where the source did not say.
  return n;
}

/** Per employee, over the window: what they did, how much of it worked, what it cost, and when they last did anything. */
export async function whoDidWhat(userId: number, days = 14) {
  const r = await db.execute<{ node: string; graph: string | null; acts: number; ok: number; blocked: number; failed: number; tokens: number; last: Date }>(sql`
    SELECT node, max(graph) AS graph, count(*)::int AS acts,
           count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE status = 'blocked')::int AS blocked, count(*) FILTER (WHERE status = 'failed')::int AS failed,
           coalesce(sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)), 0)::int AS tokens, max(at) AS last
    FROM receipts WHERE user_id = ${userId} AND at > now() - make_interval(days => ${days})
    GROUP BY node ORDER BY count(*) DESC`);
  return r.rows;
}
