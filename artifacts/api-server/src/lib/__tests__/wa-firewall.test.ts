// The ban shield's pure rules: the ladder to 1,500 and what climbs or drops
// it, the pace each rung needs, the tripwires, WhatsApp's own standing, and
// the downgrade while convalescent. No database.
import assert from "node:assert/strict";
import { LADDER, TOP_RUNG, RULES, startRung, budgetFor, paceFor, coldWait, nextRung, tripwire, readStanding, downgrade, key9, type RungStats } from "../wa-firewall-rules";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

// the ladder
ok(LADDER[0] === 20 && LADDER[TOP_RUNG] === 1500 && LADDER.length === 14, "20 at the bottom, 1,500 at the top");
ok(startRung(3) === 0 && startRung(10) === 1 && startRung(20) === 2 && startRung(82) === 3, "a number starts by age: 20, 35, 50, then 80");
ok(budgetFor({ rung: 3, mode: "normal", convalescentDay: 0, ownerCap: null, waRemaining: null }) === 80, "the rung is the budget");
ok(budgetFor({ rung: 13, mode: "normal", convalescentDay: 0, ownerCap: null, waRemaining: null }) === 1500, "the top rung is 1,500");
ok(budgetFor({ rung: 3, mode: "convalescent", convalescentDay: 2, ownerCap: null, waRemaining: null }) === 26, "first convalescent week: a third");
ok(budgetFor({ rung: 3, mode: "convalescent", convalescentDay: 9, ownerCap: null, waRemaining: null }) === 52, "second week: two thirds");
ok(budgetFor({ rung: 3, mode: "frozen", convalescentDay: 0, ownerCap: null, waRemaining: null }) === 0, "frozen: nothing");
ok(budgetFor({ rung: 3, mode: "normal", convalescentDay: 0, ownerCap: 30, waRemaining: null }) === 30, "the owner can only lower it");
ok(budgetFor({ rung: 3, mode: "normal", convalescentDay: 0, ownerCap: 500, waRemaining: null }) === 80, "not raise it");
ok(budgetFor({ rung: 13, mode: "normal", convalescentDay: 0, ownerCap: null, waRemaining: 300 }) === 300, "WhatsApp's remaining quota caps the day");

// the pace follows the budget
const low = paceFor(20), top = paceFor(1500);
ok(low.perHour === 6 && low.per10Min === 2 && low.gapMs[1] === 240_000, "20 a day: six an hour, two in ten minutes, four minutes apart");
ok(top.perHour === 160 && top.gapMs[0] === 20_000 && top.gapMs[1] <= 32_000, "1,500 a day: 160 an hour, 20–32 s apart");
ok(top.firstHourCap === 60 && low.firstHourCap === 4, "the first hour is half the pace, 4…60");
ok(paceFor(240).perHour === 26, "240 a day over twelve hours: 26 an hour");

// pacing waits
const t0 = 10_000_000, day = t0 - 2 * 3_600_000;
ok(coldWait([], t0, 100_000, day, low) === 0, "first goes now");
ok(coldWait([t0 - 30_000], t0, 100_000, day, low) === 70_000, "then the gap");
const two = [t0 - 300_000, t0 - 100_000];
ok(coldWait(two, t0, 1, day, low) >= 300_000, "two in ten minutes at the first rung: wait for the window");
const six = Array.from({ length: 6 }, (_, i) => t0 - 3_500_000 + i * 500_000);
ok(coldWait(six, t0, 1, day, low) > 0, "six in an hour at the first rung: wait");
ok(coldWait(six, t0, 1, day, top) === 0, "...and nothing at the top rung");
const four = Array.from({ length: 4 }, (_, i) => t0 - 1000 * (4 - i));
ok(coldWait(four, t0, 1, t0 - 60_000, low) >= 3_480_000, "four in the first hour at the first rung: the rest of the hour waits");

// up, down, hold
const good: RungStats = { daysAtRung: 2, sent2d: 120, recipients: 120, mature: { n: 60, delivered: 57 }, optOuts: 0, repliers: 4, budget: 80, mode: "normal", waWarning: "NONE", waQuota: null };
ok(nextRung(3, good).rung === 4, "two good days at 80: up to 120");
ok(nextRung(3, { ...good, daysAtRung: 1 }).rung === 3, "one day is not two");
ok(nextRung(3, { ...good, sent2d: 50 }).rung === 3, "a rung not used is not earned");
ok(nextRung(3, { ...good, mature: { n: 60, delivered: 52 } }).rung === 3, "87% delivered: hold");
ok(nextRung(3, { ...good, mature: { n: 60, delivered: 40 } }).rung === 2, "67% delivered: down");
ok(nextRung(3, { ...good, optOuts: 3 }).rung === 2, "2.5% stops: down");
ok(nextRung(3, { ...good, repliers: 1 }).rung === 3, "0.8% replies: hold");
ok(nextRung(5, { ...good, recipients: 70, repliers: 0 }).rung === 4, "seventy people and nobody answered: down");
ok(nextRung(3, { ...good, mode: "convalescent" }).rung === 3, "no climbing in convalescence");
ok(nextRung(13, good).rung === 13 && nextRung(13, good).why.includes("أعلى"), "the top holds");
ok(nextRung(3, { ...good, waQuota: 100 }).rung === 3, "the next rung must fit WhatsApp's quota");
ok(nextRung(6, { ...good, waWarning: "FIRST_WARNING" }).rung === 5, "WhatsApp's first warning: one down");
ok(nextRung(6, { ...good, waWarning: "SECOND_WARNING" }).rung === 3, "its second: three down");
ok(nextRung(6, { ...good, waWarning: "CAPPED" }).rung === 0, "capped: the bottom");
// from 80 with perfect days, the top is 20 days away
let r = 3; for (let d = 0; d < 20; d++) r = nextRung(r, { ...good, budget: LADDER[r]!, sent2d: LADDER[r]! * 2 }).rung;
ok(r === TOP_RUNG, "ten promotions of two days each: 1,500 in twenty days, never faster");

// tripwires
const calm = { any5Min: 2, mature10: { undelivered: 1, n: 10 }, mature20: { undelivered: 2, n: 20 }, closes30Min: 1, coldLast30Min: 3, optOutsToday: 0, coldToday: 10, cold60: { n: 60, oldestAgeH: 70, replied: 4 } };
ok(tripwire(calm, low) === null, "a calm account trips nothing");
ok(tripwire({ ...calm, any5Min: 7 }, low)?.freezeH === 1, "a burst at the first rung freezes an hour");
ok(tripwire({ ...calm, any5Min: 20 }, top) === null, "twenty in five minutes is the top rung's own pace");
ok(tripwire({ ...calm, any5Min: 31 }, top)?.freezeH === 1, "past the rung's ten-minute cap: a burst");
ok(tripwire({ ...calm, mature10: { undelivered: 4, n: 10 } })?.freezeH === 6, "four of ten undelivered: six hours");
ok(tripwire({ ...calm, mature20: { undelivered: 10, n: 20 } })?.freezeH === 24, "half of twenty: a day");
ok(tripwire({ ...calm, closes30Min: 4 })?.freezeH === 2, "four closes while sending: two hours");
ok(tripwire({ ...calm, closes30Min: 4, coldLast30Min: 0 }) === null, "closes while idle are not a send problem");
ok(tripwire({ ...calm, optOutsToday: 3 })?.freezeH === 24, "three stops: a day");
ok(tripwire({ ...calm, cold60: { n: 60, oldestAgeH: 70, replied: 0 } })?.freezeH === 24, "sixty cold messages and no reply: a day");
ok(tripwire({ ...calm, cold60: { n: 60, oldestAgeH: 10, replied: 0 } }) === null, "too fresh to judge replies");
ok(tripwire({ ...calm, any5Min: 32 }) !== null, "the 19 October burst trips");

// WhatsApp's own word
const now = Date.now();
const s1 = readStanding({ isActive: true, timeEnforcementEnds: new Date(now + 5 * 3_600_000), enforcementType: "BIZ_QUALITY" }, null, now);
ok(!!s1.lockedUntil && s1.lockedUntil.getTime() > now + 4 * 3_600_000 && !!s1.lockWhy?.includes("BIZ_QUALITY"), "a time-lock freezes until it ends");
ok(readStanding({ isActive: false }, null, now).lockedUntil === null, "no lock, no freeze");
const s2 = readStanding(null, { total_quota: 250, used_quota: 40, capping_status: "NONE" }, now);
ok(s2.quota === 250 && s2.remaining === 210 && s2.warning === "NONE", "the new-chat cap is read: 210 of 250 left");
ok(readStanding(null, { total_quota: 250, used_quota: 250, capping_status: "CAPPED", cycle_end_timestamp: String(Math.floor(now / 1000) + 7200) }, now).lockedUntil !== null, "capped: frozen until the cycle ends");

// downgrade
const d = downgrade("carousel", "تمهيد", null, JSON.stringify([{ title: "ملف AML", description: "نجهّزه", imageUrl: "/a.png" }, { title: "x", imageUrl: "/b.png" }]));
ok(d.messageType === "image" && d.mediaUrl === "/a.png" && d.message.includes("ملف AML") && d.buttons === null, "a carousel becomes one image with its words");
ok(downgrade("image_button", "m", "/x.png", null).messageType === "image", "image with buttons → image");
ok(downgrade("button", "m", null, null).messageType === "text", "buttons → text");
ok(key9("+971 50 107 1611") === key9("0501071611") && key9("971501071611:0@s.whatsapp.net") === "501071611", "one person, any spelling");
ok(RULES.perHour.max === 160 && RULES.gapMs.min === 20_000, "the ceiling pace: 160 an hour, 20 s apart");
console.log(`wa-firewall: ${n}/${n} ✅`);
