// ── The off switch ───────────────────────────────────────────────
// One for the whole team (business_profile.team_paused) and one per employee
// (bot_employees.is_active). Checked where every employee's thinking passes —
// the model call — so nothing they do goes on while they are switched off,
// whichever of the thirty places the call came from. Read through a short
// cache: the switch takes effect within seconds, not on every call's cost.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const TTL = 5_000;
const cache = new Map<string, { at: number; off: string | null }>();

/** Why this employee may not work right now — null when they may. */
export async function offDuty(userId: number, role: string): Promise<string | null> {
  const key = `${userId}:${role}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.off;
  const r = await db.execute<{ paused: boolean | null; active: boolean | null }>(sql`
    SELECT (SELECT team_paused FROM business_profile WHERE user_id = ${userId}) AS paused,
           (SELECT is_active FROM bot_employees WHERE user_id = ${userId} AND role = ${role} LIMIT 1) AS active`).catch(() => ({ rows: [] as any[] }));
  const row = r.rows[0];
  const off = row?.paused ? "الفريق كله موقوف" : row?.active === false ? "الموظف موقوف" : null;
  cache.set(key, { at: Date.now(), off });
  return off;
}

/** The switch was just flipped: forget what was cached for this account. */
export function forgetSwitches(userId: number) {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

export async function setTeamPaused(userId: number, paused: boolean) {
  await db.execute(sql`UPDATE business_profile SET team_paused = ${paused} WHERE user_id = ${userId}`);
  forgetSwitches(userId);
}
