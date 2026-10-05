// ── Who was written to, and where each one stands ─────────────────
// The owner's register of the companies email has reached: how many emails
// each got, the last one and when, whether they opened, clicked or replied,
// and the next step on their follow-up path with its date — or why the path
// ended. One row per company, newest activity first.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type RegisterStatus = "all" | "in_path" | "replied" | "finished" | "stopped";
const HAVING: Record<Exclude<RegisterStatus, "all">, ReturnType<typeof sql>> = {
  replied:  sql`c.last_replied_at IS NOT NULL`,
  stopped:  sql`c.last_replied_at IS NULL AND c.status <> 'active'`,
  in_path:  sql`c.last_replied_at IS NULL AND c.status = 'active' AND (bool_or(m.status IN ('queued','ab_hold')) OR EXISTS (SELECT 1 FROM email_sequence_jobs j WHERE j.contact_id = c.id AND j.status = 'pending'))`,
  finished: sql`c.last_replied_at IS NULL AND c.status = 'active' AND NOT bool_or(m.status IN ('queued','ab_hold')) AND NOT EXISTS (SELECT 1 FROM email_sequence_jobs j WHERE j.contact_id = c.id AND j.status = 'pending')`,
};

export async function register(userId: number, opts: { status?: RegisterStatus; q?: string; listId?: number | null; page?: number; limit?: number } = {}) {
  const limit = Math.min(500, opts.limit ?? 100), offset = (opts.page ?? 0) * limit;
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const where = sql`c.user_id = ${userId}
    ${q ? sql`AND (c.email ILIKE ${q} OR c.company ILIKE ${q} OR c.name ILIKE ${q})` : sql``}
    ${opts.listId ? sql`AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${opts.listId})` : sql``}`;
  const having = opts.status && opts.status !== "all" ? sql`HAVING ${HAVING[opts.status]}` : sql``;
  const rows = await db.execute<any>(sql`
    SELECT c.id, c.email, c.company, c.name, c.sector, c.city, c.phone, c.status, c.tags,
      c.last_replied_at AS "repliedAt",
      (count(*) FILTER (WHERE m.sent_at IS NOT NULL))::int AS sent,
      (count(*) FILTER (WHERE m.status IN ('queued','ab_hold')))::int AS queued,
      max(m.sent_at) AS "lastSentAt",
      (array_agg(m.subject ORDER BY m.sent_at DESC NULLS LAST))[1] AS "lastSubject",
      coalesce(sum(m.open_count), 0)::int AS opens,
      coalesce(sum(m.click_count), 0)::int AS clicks,
      bool_or(m.status = 'bounced') AS bounced,
      (SELECT j.due_at FROM email_sequence_jobs j WHERE j.contact_id = c.id AND j.status = 'pending' ORDER BY j.due_at LIMIT 1) AS "nextAt",
      (SELECT s.name || ' — الخطوة ' || (j.step_index + 1) FROM email_sequence_jobs j JOIN email_sequences s ON s.id = j.sequence_id
        WHERE j.contact_id = c.id AND j.status = 'pending' ORDER BY j.due_at LIMIT 1) AS "nextStep",
      (SELECT count(*) FROM email_sequence_jobs j WHERE j.contact_id = c.id AND j.status = 'pending')::int AS "stepsLeft"
    FROM email_contacts c JOIN email_messages m ON m.contact_id = c.id
    WHERE ${where}
    GROUP BY c.id ${having}
    ORDER BY max(coalesce(m.sent_at, m.created_at)) DESC
    LIMIT ${limit} OFFSET ${offset}`);
  const counts = await db.execute<any>(sql`
    WITH x AS (
      SELECT c.id, c.status, c.last_replied_at,
        bool_or(m.status IN ('queued','ab_hold')) AS queued,
        EXISTS (SELECT 1 FROM email_sequence_jobs j WHERE j.contact_id = c.id AND j.status = 'pending') AS pending
      FROM email_contacts c JOIN email_messages m ON m.contact_id = c.id WHERE ${where} GROUP BY c.id)
    SELECT count(*)::int AS all,
      (count(*) FILTER (WHERE last_replied_at IS NOT NULL))::int AS replied,
      (count(*) FILTER (WHERE last_replied_at IS NULL AND status <> 'active'))::int AS stopped,
      (count(*) FILTER (WHERE last_replied_at IS NULL AND status = 'active' AND (queued OR pending)))::int AS in_path,
      (count(*) FILTER (WHERE last_replied_at IS NULL AND status = 'active' AND NOT queued AND NOT pending))::int AS finished
    FROM x`);
  const statusOf = (r: any) => r.repliedAt ? "replied" : r.status !== "active" ? "stopped" : (r.queued > 0 || r.stepsLeft > 0) ? "in_path" : "finished";
  return { rows: rows.rows.map((r: any) => ({ ...r, state: statusOf(r) })), counts: counts.rows[0] ?? {}, page: opts.page ?? 0, limit };
}
