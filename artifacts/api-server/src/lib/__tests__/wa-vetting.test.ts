// سيف's judgement, pure: what is rejected, what waits, what goes, and why.
import assert from "node:assert/strict";
import { judge, looksFake, listCountry, REASON, type Facts } from "../wa-vetting";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

const clean: Facts = {
  phone: "971501071611", valid: true, mobile: true, iso: "AE", listIso: "AE", foreignAllowed: false, fake: false, duplicate: false,
  blacklisted: false, notInterestedDays: null, waExists: true, previouslyNotOnWa: false, sent60d: 0, delivered60d: 0,
  lastCampaignHoursAgo: null, wroteDaysAgo: null, readEver: false,
};
ok(judge(clean).verdict === "ready" && judge(clean).reasons.length === 0, "a clean, verified mobile is ready");
ok(judge({ ...clean, valid: false }).verdict === "rejected" && judge({ ...clean, valid: false }).reasons.includes(REASON.invalid), "not a number: rejected");
ok(judge({ ...clean, mobile: false }).reasons.includes(REASON.landline), "a landline: rejected");
ok(judge({ ...clean, fake: true }).reasons.includes(REASON.fake), "a made-up pattern: rejected");
ok(judge({ ...clean, duplicate: true }).reasons.includes(REASON.duplicate), "the second copy of a person: rejected");
ok(judge({ ...clean, blacklisted: true }).verdict === "rejected" && judge({ ...clean, blacklisted: true }).risk === 100, "asked to stop: rejected, risk 100");
ok(judge({ ...clean, waExists: false }).reasons.includes(REASON.notOnWa), "WhatsApp does not know it: rejected");
ok(judge({ ...clean, previouslyNotOnWa: true }).verdict === "rejected", "it failed as not-on-WhatsApp before: rejected");
ok(judge({ ...clean, blacklisted: true, waExists: null }).verdict === "rejected", "a hard no outranks a hold");

ok(judge({ ...clean, waExists: null }).verdict === "hold" && judge({ ...clean, waExists: null }).reasons.includes(REASON.unverified), "unverified: hold, never sent cold");
ok(judge({ ...clean, iso: "SA" }).reasons.includes(REASON.foreign), "another country than the list's: hold");
ok(judge({ ...clean, iso: "SA", foreignAllowed: true }).verdict === "ready", "...unless the list allows it");
ok(judge({ ...clean, iso: "SA", listIso: null }).verdict === "ready", "a mixed list has no own country");
ok(judge({ ...clean, notInterestedDays: 30 }).reasons.includes(REASON.notInterested), "said not interested a month ago: hold");
ok(judge({ ...clean, notInterestedDays: 200 }).verdict === "ready", "...but not half a year ago");
ok(judge({ ...clean, sent60d: 2, delivered60d: 0 }).reasons.includes(REASON.undelivered), "two messages, none delivered: hold");
ok(judge({ ...clean, sent60d: 1, delivered60d: 0 }).verdict === "ready", "one undelivered is not a pattern");
ok(judge({ ...clean, lastCampaignHoursAgo: 5 }).reasons.includes(REASON.recent), "a campaign message five hours ago: hold");
ok(judge({ ...clean, lastCampaignHoursAgo: 30 }).verdict === "ready", "...a day later it goes");

const r0 = judge(clean).risk, r1 = judge({ ...clean, wroteDaysAgo: 40, readEver: true, delivered60d: 1 }).risk, r2 = judge({ ...clean, waExists: null, iso: "SA" }).risk;
ok(r1 < r0 && r2 > r0 && r1 >= 0 && r2 <= 100, "risk falls for a person who wrote and read us, rises for the unknown");

ok(looksFake("971500000000") && looksFake("971501234567") && looksFake("966587654321"), "one digit repeated, or a run, is fake");
ok(!looksFake("971501071611") && !looksFake("971563998800"), "real numbers are not");
ok(listCountry(["AE", "AE", "AE", "AE", "SA"]) === "AE", "four in five agree: the list is Emirati");
ok(listCountry(["AE", "AE", "SA", "SA"]) === null, "half and half: no own country");
ok(listCountry([null, null]) === null, "nothing known: nothing said");
console.log(`wa-vetting: ${n}/${n} ✅`);
