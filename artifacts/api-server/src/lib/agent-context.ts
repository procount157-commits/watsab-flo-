// ── Who is thinking right now ─────────────────────────────────────
// A model call does not know which employee made it: complete() takes
// messages and nothing else, and it is called from thirty places. Rather than
// thread a role through every one of them, the employee's work runs inside
// asAgent(), and complete() reads who it is working for from here — which is
// how the team page can say what each employee costs.

import { AsyncLocalStorage } from "node:async_hooks";

type Agent = { userId: number; role: string; keepRoute?: boolean };
const store = new AsyncLocalStorage<Agent>();

export function asAgent<T>(userId: number, role: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId, role }, fn);
}
export const currentAgent = (): Agent | undefined => store.getStore();

/**
 * Work that belongs to an account and an employee, but was never billed to one.
 *
 * The off switches and the receipts need to know whose thinking this is; the
 * model route must not change because of it. Inside asAgent an account named in
 * THEGRID_USERS goes to its paid keys first and the email team to its own models
 * (llm.ts), so wrapping a background job in plain asAgent would have moved it onto
 * the owner's paid provider and changed what answers. `keepRoute` is the difference.
 * Inside an existing asAgent it changes nothing: that employee already owns the work.
 */
export function asWorker<T>(userId: number, role: string, fn: () => Promise<T>): Promise<T> {
  return store.getStore() ? fn() : store.run({ userId, role, keepRoute: true }, fn);
}
/** The employee whose model route applies: none for work that only carries a name for the switches. */
export const routedAgent = (): Agent | undefined => { const a = store.getStore(); return a?.keepRoute ? undefined : a; };

// ── What a run cost ───────────────────────────────────────────────
// lib/org/runtime.ts opens a meter around one employee's run; complete() adds
// to it. Separate from the agent store: asAgent inside the run must not lose it.
export type Meter = { calls: number; tokensIn: number; tokensOut: number; model: string | null };
const meters = new AsyncLocalStorage<Meter>();
export function withMeter<T>(m: Meter, fn: () => Promise<T>): Promise<T> { return meters.run(m, fn); }
export const currentMeter = (): Meter | undefined => meters.getStore();
