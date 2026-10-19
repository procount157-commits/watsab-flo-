import assert from "node:assert/strict";
import { coldDailyBudget, coldWait, tripwire, downgrade, RULES } from "../wa-firewall";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
// budget by age and mode
ok(coldDailyBudget(3, "normal", 0, null) === 10, "a week-old number: 10 a day");
ok(coldDailyBudget(82, "normal", 0, null) === 80, "an old number: 80, never 1500");
ok(coldDailyBudget(82, "convalescent", 2, null) === 26, "first convalescent week: a third");
ok(coldDailyBudget(82, "convalescent", 9, null) === 52, "second week: two thirds");
ok(coldDailyBudget(82, "frozen", 0, null) === 0, "frozen: nothing");
ok(coldDailyBudget(82, "normal", 0, 30) === 30, "the owner can only lower it");
ok(coldDailyBudget(82, "normal", 0, 500) === 80, "not raise it");
// pacing
const t0 = 10_000_000, day = t0 - 2 * 3_600_000;
ok(coldWait([], t0, 100_000, day) === 0, "first goes now");
ok(coldWait([t0 - 30_000], t0, 100_000, day) === 70_000, "then the gap");
const three = [t0 - 500_000, t0 - 300_000, t0 - 100_000];
ok(coldWait(three, t0, 1, day) >= 100_000, "three in ten minutes: wait for the window");
const ten = Array.from({ length: 10 }, (_, i) => t0 - 3_500_000 + i * 300_000);
ok(coldWait(ten, t0, 1, day) > 0, "ten in an hour: wait");
const four = Array.from({ length: 4 }, (_, i) => t0 - 1000 * (4 - i));
ok(coldWait(four, t0, 1, t0 - 60_000) >= 3_480_000, "four in the first hour: the rest of the hour waits");
// tripwires
const calm = { any5Min: 2, mature10: { undelivered: 1, n: 10 }, mature20: { undelivered: 2, n: 20 }, closes30Min: 1, coldLast30Min: 3, optOutsToday: 0, coldToday: 10, cold60: { n: 60, oldestAgeH: 70, replied: 4 } };
ok(tripwire(calm) === null, "a calm account trips nothing");
ok(tripwire({ ...calm, any5Min: 7 })?.freezeH === 1, "a burst freezes an hour");
ok(tripwire({ ...calm, mature10: { undelivered: 4, n: 10 } })?.freezeH === 6, "four of ten undelivered: six hours");
ok(tripwire({ ...calm, mature20: { undelivered: 10, n: 20 } })?.freezeH === 24, "half of twenty: a day");
ok(tripwire({ ...calm, closes30Min: 4 })?.freezeH === 2, "four closes while sending: two hours");
ok(tripwire({ ...calm, closes30Min: 4, coldLast30Min: 0 }) === null, "closes while idle are not a send problem");
ok(tripwire({ ...calm, optOutsToday: 3 })?.freezeH === 24, "three stops: a day");
ok(tripwire({ ...calm, cold60: { n: 60, oldestAgeH: 70, replied: 0 } })?.freezeH === 24, "sixty cold messages and no reply: a day");
ok(tripwire({ ...calm, cold60: { n: 60, oldestAgeH: 10, replied: 0 } }) === null, "too fresh to judge replies");
// the 19 October burst would have tripped at message 7
ok(tripwire({ ...calm, any5Min: 32 }) !== null, "32 in three minutes trips");
// downgrade
const d = downgrade("carousel", "تمهيد", null, JSON.stringify([{ title: "ملف AML", description: "نجهّزه", imageUrl: "/a.png" }, { title: "x", imageUrl: "/b.png" }]));
ok(d.messageType === "image" && d.mediaUrl === "/a.png" && d.message.includes("ملف AML") && d.buttons === null, "a carousel becomes one image with its words");
ok(downgrade("image_button", "m", "/x.png", null).messageType === "image", "image with buttons → image");
ok(downgrade("button", "m", null, null).messageType === "text", "buttons → text");
ok(RULES.coldPerHour <= 10, "never more than ten cold an hour");
console.log(`wa-firewall: ${n}/${n} ✅`);
