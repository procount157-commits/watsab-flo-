// ── Who is thinking right now ─────────────────────────────────────
// A model call does not know which employee made it: complete() takes
// messages and nothing else, and it is called from thirty places. Rather than
// thread a role through every one of them, the employee's work runs inside
// asAgent(), and complete() reads who it is working for from here — which is
// how the team page can say what each employee costs.

import { AsyncLocalStorage } from "node:async_hooks";

type Agent = { userId: number; role: string };
const store = new AsyncLocalStorage<Agent>();

export function asAgent<T>(userId: number, role: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ userId, role }, fn);
}
export const currentAgent = (): Agent | undefined => store.getStore();
