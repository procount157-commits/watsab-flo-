import assert from "node:assert/strict";
import { dueRung, AD_WARM_LADDER, AD_WINDOW_H } from "../smart-followup";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const H = 3_600_000, t0 = 1_000_000_000_000;
// They wrote at t0, we answered a minute later.
const turns = [{ fromMe: false, text: "كم سعر الطقم؟", at: new Date(t0) }, { fromMe: true, text: "تفضلي الرابط", at: new Date(t0 + 60_000) }];
const opts = { ladder: AD_WARM_LADDER, scope: "all" as const, anchor: "theirs" as const, windowH: AD_WINDOW_H };
ok(AD_WARM_LADDER.length === 7 && AD_WARM_LADDER[6]! < 72, "seven rungs, all inside three days");
ok(dueRung(turns, [], true, t0 + 0.5 * H, opts) === null, "not before the first hour");
ok(dueRung(turns, [], true, t0 + 1.1 * H, opts)?.rung === 0, "rung 1 after an hour");
// Rungs already sent at their times.
const at = (h: number) => new Date(t0 + h * H);
ok(dueRung(turns, [at(1)], true, t0 + 4 * H, opts) === null, "rung 2 waits for hour 5");
ok(dueRung(turns, [at(1)], true, t0 + 5.1 * H, opts)?.rung === 1, "rung 2 at hour 5");
const six = [1, 5, 21, 27, 45, 51].map(at);
ok(dueRung(turns, six, true, t0 + 69.2 * H, opts)?.rung === 6, "rung 7 at hour 69");
ok(dueRung(turns, six, true, t0 + 71.5 * H, opts) === null, "after hour 71 nothing goes: it would be cold");
ok(dueRung(turns, [...six, at(69)], true, t0 + 70 * H, opts) === null, "seven is the end");
// A rung the night delayed: rung 3 due at 21 but sent at 30 — rung 4 waits 2h, not 0.
ok(dueRung(turns, [at(1), at(5), at(30)], true, t0 + 31 * H, opts) === null, "two hours between rungs at least");
ok(dueRung(turns, [at(1), at(5), at(30)], true, t0 + 32.1 * H, opts)?.rung === 3, "then the next");
// They reply on day 2: the three days start again, and the count too.
const replied = [...turns, { fromMe: false, text: "تمام، عندكم توصيل؟", at: at(40) }, { fromMe: true, text: "نعم", at: at(40.05) }];
ok(dueRung(replied, [at(1), at(5), at(21), at(27)], true, t0 + 41.1 * H, opts)?.rung === 0, "a reply restarts the ladder");
console.log(`ad-warm-ladder: ${n}/${n} ✅`);
