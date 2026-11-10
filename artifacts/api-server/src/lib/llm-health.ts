// ── Choosing a model by what it has actually done ─────────────────
// The fallback chain used to be ordered by hand: the account's provider, then
// whoever had a key, then a keyless last resort. That order encodes an opinion
// about which model is best, and the opinion was wrong — measured on
// 2026-09-25, Gemini returned 503 on every single attempt while Groq answered
// in under 1.5s every time, and four of OpenRouter's most popular free models
// were permanently rate-limited upstream.
//
// So the order is derived from outcomes instead. Two things matter and they
// pull in different directions: a model that answers is worth more than a fast
// one, and a model that has just failed four times in a row is worth skipping
// entirely rather than waiting on its timeout every call.

import { sql } from "drizzle-orm";
import { db, llmHealthTable, type LlmHealth } from "@workspace/db";
import { logger } from "./logger";

// Minutes to rest after the 1st, 2nd, 3rd… consecutive failure. The first is
// zero: one timeout is a blip, and a model that is genuinely down reaches the
// next rung on its very next call anyway. Capped at an hour so nothing is ever
// written off permanently — the upstream that is rate-limited this afternoon is
// the one this account depends on tonight.
const COOLDOWNS_MIN = [0, 1, 5, 15, 60];
const cooldownFor = (streak: number) =>
  COOLDOWNS_MIN[Math.min(Math.max(streak, 1) - 1, COOLDOWNS_MIN.length - 1)]!;

/** Weight on latency. One second of delay is worth ~5% of success rate. */
const MS_PER_POINT = 20_000;

/**
 * Higher is better.
 *
 * The success rate dominates: a model that answers 90% of the time beats one
 * that answers 60% however fast the second one is. Latency only separates
 * models that are both reliable.
 *
 * An unmeasured model scores 0.7 — below anything proven good, above anything
 * proven bad. Optimism would put an untried model ahead of a known-good one on
 * every call; pessimism would mean a newly added key is never reached.
 */
export function score(h: Pick<LlmHealth, "ok" | "fail" | "avgMs">): number {
  const tried = h.ok + h.fail;
  if (tried === 0) return 0.7;
  // Laplace: one success in one attempt is not a 100% model.
  const rate = (h.ok + 1) / (tried + 2);
  return rate - Math.min(0.3, (h.avgMs || 0) / MS_PER_POINT);
}

export type Candidate = { provider: string; model: string; apiKey: string };

/**
 * Order candidates best-first and drop the ones in cooldown.
 *
 * `pinned` is the account's own choice. It is tried first even when its score
 * is poor — the owner picked it, and silently ignoring that would make the
 * setting a lie — but only while it is not in cooldown. A provider that has
 * failed four times running is not a preference, it is an outage.
 */
export async function rank(
  candidates: Candidate[], pinned?: { provider: string; model: string },
  /** يُملأ بمفاتيح `provider|model` لمن في التهدئة: التوجيه بالدليل لا يقدّمهم. */
  restingOut?: Set<string>,
): Promise<Candidate[]> {
  if (candidates.length <= 1) return candidates;

  const rows = await db.select().from(llmHealthTable);
  const now = Date.now();
  const keyOf = (c: { provider: string; model: string }) => `${c.provider}|${c.model}`;
  const health = new Map(rows.map((r) => [`${r.provider}|${r.model}`, r]));

  const usable: Array<Candidate & { s: number; pin: boolean }> = [];
  const resting: Candidate[] = [];

  for (const c of candidates) {
    const h = health.get(keyOf(c));
    const cool = h?.cooldownUntil ? new Date(h.cooldownUntil).getTime() : 0;
    if (cool > now) { resting.push(c); restingOut?.add(keyOf(c)); continue; }
    usable.push({
      ...c,
      s: score(h ?? { ok: 0, fail: 0, avgMs: 0 }),
      pin: !!pinned && pinned.provider === c.provider && pinned.model === c.model,
    });
  }

  usable.sort((a, b) => (a.pin !== b.pin ? (a.pin ? -1 : 1) : b.s - a.s));

  // Cooling models go last rather than being dropped: if every candidate is
  // cooling, one of them still has to be asked.
  return [...usable.map(({ s, pin, ...c }) => c), ...resting];
}

export async function recordOk(provider: string, model: string, ms: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO llm_health (provider, model, ok, avg_ms, last_ok_at, streak_fails, cooldown_until)
    VALUES (${provider}, ${model}, 1, ${ms}, NOW(), 0, NULL)
    ON CONFLICT (provider, model) DO UPDATE SET
      ok = llm_health.ok + 1,
      -- Exponential moving average, so a model that got slower looks slower
      -- within a handful of calls rather than a thousand.
      avg_ms = CASE WHEN llm_health.avg_ms = 0 THEN ${ms}
                    ELSE (llm_health.avg_ms * 3 + ${ms}) / 4 END,
      last_ok_at = NOW(), streak_fails = 0, cooldown_until = NULL
  `);
}

export async function recordFail(provider: string, model: string, error: string): Promise<void> {
  const [row] = await db.select().from(llmHealthTable)
    .where(sql`${llmHealthTable.provider} = ${provider} AND ${llmHealthTable.model} = ${model}`).limit(1);
  const streak = (row?.streakFails ?? 0) + 1;
  const mins = cooldownFor(streak);

  await db.execute(sql`
    INSERT INTO llm_health (provider, model, fail, streak_fails, last_fail_at, last_error, cooldown_until)
    VALUES (${provider}, ${model}, 1, ${streak}, NOW(), ${error.slice(0, 300)},
            ${mins > 0 ? sql`NOW() + (${mins} || ' minutes')::interval` : sql`NULL`})
    ON CONFLICT (provider, model) DO UPDATE SET
      fail = llm_health.fail + 1,
      streak_fails = ${streak},
      last_fail_at = NOW(), last_error = ${error.slice(0, 300)},
      cooldown_until = ${mins > 0 ? sql`NOW() + (${mins} || ' minutes')::interval` : sql`NULL`}
  `);

  if (mins > 0) {
    logger.warn({ provider, model, streak, cooldownMin: mins }, "موديل موضوع في فترة تهدئة");
  }
}

/** For the settings page: what every model has been doing. */
export async function healthReport(): Promise<Array<LlmHealth & { score: number; resting: boolean }>> {
  const rows = await db.select().from(llmHealthTable);
  const now = Date.now();
  return rows
    .map((r) => ({
      ...r,
      score: Math.round(score(r) * 1000) / 1000,
      resting: !!r.cooldownUntil && new Date(r.cooldownUntil).getTime() > now,
    }))
    .sort((a, b) => b.score - a.score);
}
