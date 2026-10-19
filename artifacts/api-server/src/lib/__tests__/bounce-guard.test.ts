import assert from "node:assert/strict";
import { classifyRcpt, needsCheck } from "../email/mailbox-check";
import { decide } from "../email/bounce-guard";

let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
// خادم المستلم
ok(classifyRcpt(250, "250 2.1.5 OK") === "ok", "250 ok");
ok(classifyRcpt(550, "550-5.1.1 The email account that you tried to reach does not exist") === "invalid", "gmail no user");
ok(classifyRcpt(550, "550 5.4.1 Recipient address rejected: Access denied") === "unknown", "m365 denied is not a verdict");
ok(classifyRcpt(550, "550 5.7.1 Service unavailable; client host blocked using Spamhaus") === "unknown", "we are blocked");
ok(classifyRcpt(451, "451 4.7.1 Greylisted, try later") === "unknown", "greylist");
ok(classifyRcpt(553, "553 sorry, no mailbox here by that name") === "invalid", "no mailbox");
// إعادة السؤال
const day = 86_400_000, now = Date.now();
ok(needsCheck({ mailbox: null, mailboxCheckedAt: null }), "never checked");
ok(!needsCheck({ mailbox: "unknown", mailboxCheckedAt: new Date(now - day / 2) }, now), "unknown asked again after a day only");
ok(needsCheck({ mailbox: "unknown", mailboxCheckedAt: new Date(now - 2 * day) }, now), "unknown, two days");
ok(!needsCheck({ mailbox: "ok", mailboxCheckedAt: new Date(now - 30 * day) }, now), "ok holds 60 days");
// العيّنة
const old = new Date(now - 2 * day), fresh = new Date(now - 3_600_000);
ok(decide({ attempted: 20, bad: 5, sample: 50 }, fresh, now) === "failed", "5 bad of 50 already over 8% — fail early");
ok(decide({ attempted: 20, bad: 2, sample: 50 }, fresh, now) === "sampling", "still sampling");
ok(decide({ attempted: 50, bad: 3, sample: 50 }, fresh, now) === "sampling", "sample sent, waits for bounces");
ok(decide({ attempted: 50, bad: 3, sample: 50 }, old, now) === "passed", "6% after a day: passes");
ok(decide({ attempted: 37, bad: 5, sample: 50 }, old, now) === "failed", "منشآت أخرى 13.5% fails");
console.log(`${n}/${n} ✅`);
