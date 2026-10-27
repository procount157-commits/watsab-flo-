// Email follow-ups as replies in the thread, and the machine opens kept out (2026-10-27). Pure.
import assert from "node:assert/strict";
const { replySubject } = await import("../email/service");
const { isMachineOpen } = await import("../../routes/track");
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
ok(replySubject("AML readiness for your agency") === "Re: AML readiness for your agency", "the first subject with Re:");
ok(replySubject("Re: RE: Fwd: AML readiness") === "Re: AML readiness", "Re: only once");
ok(replySubject("رد: الامتثال") === "Re: الامتثال", "an Arabic reply prefix too");
ok(isMachineOpen("Mozilla/5.0", 5 * 3_600_000), "Apple's bare agent is a machine");
ok(isMachineOpen("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120", 30_000), "thirty seconds after sending is a gateway");
ok(isMachineOpen("", 3_600_000), "no agent at all is a machine");
ok(!isMachineOpen("Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)", 3_600_000), "Gmail's proxy an hour later is her opening it");
ok(!isMachineOpen("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit", 2 * 3_600_000), "a phone two hours later is a person");
console.log(`email-followup-thread: ${n}/${n} ✅`);
