// Adaptive follow-ups (the owner, 2026-11-06: «المتابعات متكيّفة»): their
// hours, their reply speed, how they write, what we already sent them, and a
// time they named. All pure — no DB, no model.
import assert from "node:assert/strict";
export {};
const {
  bestHourFor, withinPersonalWindow, nextPersonalHour, personalTiming, hourAr, arDigits,
  engagementPlan, PAUSE_TAG, PAUSE_DAYS, styleNote, repeatsSent, adaptLines, timeCue, dayAr, CUE_CAP_DAYS, dueRung, hourIn,
} = await import("../smart-followup");

let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const H = 3_600_000, D = 86_400_000;
// Dubai is UTC+4: 15:00Z is 19:00 there. Friday 6 Nov 2026.
const dubai = (day: number, hour: number, min = 0) => new Date(Date.UTC(2026, 10, day, hour - 4, min));
const her = (d: Date, text = "تمام") => ({ fromMe: false, text, at: d });
const us = (d: Date, text = "هلا") => ({ fromMe: true, text, at: d });

// ── 1. Their hours ────────────────────────────────────────────────
const evening = [her(dubai(1, 19)), us(dubai(1, 19, 5)), her(dubai(2, 20, 30)), her(dubai(3, 21, 10)), us(dubai(3, 9))];
const p = bestHourFor(evening, "Asia/Dubai")!;
ok(p && p.n === 3 && p.from === 19 && p.to === 21, `evening writer reads 19–21 (${JSON.stringify(p)})`);
ok(bestHourFor(evening.slice(0, 3), "Asia/Dubai") === null, "fewer than three of their messages is no reading");
ok(withinPersonalWindow(17, p) && withinPersonalWindow(23, p) && !withinPersonalWindow(12, p), "±2h around their usual hours");
ok(withinPersonalWindow(3, null), "no reading → any hour is theirs");
ok(nextPersonalHour(10, p, 9, 21) === 17, "from 10am the next hour inside both windows is 5pm");
const night = bestHourFor([her(dubai(1, 23)), her(dubai(2, 0, 20)), her(dubai(3, 1))], "Asia/Dubai")!;
ok(night.from === 23 && night.to === 1, `the arc wraps midnight (${night.from}–${night.to})`);
const lateOnly = bestHourFor([her(dubai(1, 2)), her(dubai(2, 3)), her(dubai(3, 4))], "Asia/Dubai")!;
ok(nextPersonalHour(10, lateOnly, 9, 21) === null, "their hours never meet the sending hours → null");
ok(personalTiming(dubai(6, 10).getTime(), lateOnly, true, "Asia/Dubai", 9, 21).ok, "…and then their hours hold nothing");
const t10 = personalTiming(dubai(6, 10, 25).getTime(), p, true, "Asia/Dubai", 9, 21);
ok(!t10.ok && hourIn((t10 as any).at, "Asia/Dubai") === 17 && (t10 as any).at === dubai(6, 17).getTime(), "due at 10:25 → deferred to 5pm today");
ok(t10.why.includes("أُجّلت إلى الساعة ٥ عصراً") && t10.why.includes("تكتب عادة بين ٧ مساءً و٩ مساءً"), `the owner reads why: ${t10.why}`);
const t19 = personalTiming(dubai(6, 19, 40).getTime(), p, false, "Asia/Dubai", 9, 21);
ok(t19.ok && t19.why.includes("الساعة ٧ مساءً") && t19.why.includes("يكتب عادة"), `inside the window it goes, and says so: ${t19.why}`);
ok(personalTiming(dubai(6, 10).getTime(), null).ok && personalTiming(dubai(6, 10).getTime(), null).why === "", "no reading → no deferral, no line");
ok(hourAr(20) === "٨ مساءً" && hourAr(9) === "٩ صباحاً" && hourAr(0) === "١٢ فجراً" && arDigits(45) === "٤٥", "Arabic hours");

// ── 2. How they engage ────────────────────────────────────────────
const t0 = dubai(1, 10).getTime();
const quick = [us(new Date(t0)), her(new Date(t0 + 0.5 * H)), us(new Date(t0 + 1 * H)), her(new Date(t0 + 2 * H)), us(new Date(t0 + 3 * H))];
const lastInQ = t0 + 2 * H;
const e1 = engagementPlan(quick, [lastInQ + 5 * H, lastInQ + 30 * H], { now: lastInQ + 60 * H });
ok(e1.action === "keep" && e1.stretch === 1 && e1.medianReplyH! < 2, "answered fast before → the ladder as it is, even after two unanswered");
const slow = [us(new Date(t0)), her(new Date(t0 + 20 * H)), us(new Date(t0 + 21 * H))];
const lastInS = t0 + 20 * H;
ok(engagementPlan(slow, [lastInS + 2 * H], { now: lastInS + 10 * H }).action === "keep", "one unanswered → keep");
const e2 = engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H], { now: lastInS + 40 * H });
ok(e2.action === "pause" && e2.why.startsWith(PAUSE_TAG) && /[؀-ۿ]/.test(e2.why), `two unanswered, slow replier → 30-day pause: ${e2.why}`);
const e3 = engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H], { now: lastInS + 40 * H, label: "hot" });
ok(e3.action === "stretch" && e3.stretch === 2, "…unless ريم reads them hot: one more, gap ×2");
ok(engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H, lastInS + 30 * H], { now: lastInS + 90 * H, label: "hot" }).action === "pause", "the hot exception is one follow-up, not a ladder");
ok(engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H], { now: lastInS + 40 * H, label: "price" }).action === "pause", "a price-asker is not hot");
const pausedAt = lastInS + 40 * H;
ok(engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H], { now: pausedAt + 10 * D, pausedAt }).action === "paused", "inside the pause → nothing");
ok(engagementPlan(slow, [lastInS + 2 * H, lastInS + 8 * H], { now: pausedAt + (PAUSE_DAYS + 1) * D, pausedAt }).action === "keep", "after 30 days the count starts again");
ok(engagementPlan([...slow, her(new Date(pausedAt + 2 * D))], [lastInS + 2 * H, lastInS + 8 * H], { now: pausedAt + 3 * D, pausedAt }).action === "keep", "a reply from them lifts the pause");
// The stretch reaches the ladder's clock.
const ladder = [1, 6, 24, 72];
const th = [her(new Date(t0)), us(new Date(t0 + H))];
const taken = [new Date(t0 + 2 * H), new Date(t0 + 8 * H)];
ok(dueRung(th, taken, false, t0 + 8 * H + 25 * H, { ladder })?.rung === 2, "third rung due a day after the second…");
ok(dueRung(th, taken, false, t0 + 8 * H + 25 * H, { ladder, stretch: 2 }) === null && dueRung(th, taken, false, t0 + 8 * H + 48 * H, { ladder, stretch: 2 })?.rung === 2, "…two days when stretched");

// ── 3. How they write ─────────────────────────────────────────────
const shortAr = styleNote([her(new Date(t0), "عندكم خلخال؟"), her(new Date(t0 + H), "اوكي"), us(new Date(t0), "هلا والله، عندنا تصاميم كثيرة")]);
ok(shortAr.includes("بالعربية") && shortAr.includes("سطر واحد") && shortAr.includes("لا تضع إيموجي"), `short Arabic, no emoji: ${shortAr}`);
const en = styleNote([her(new Date(t0), "Hi, could you share your AML compliance package pricing for a small trading company please?")], false);
ok(en.includes("بالإنجليزية") && en.includes("يكتب"), `English, masculine for B2B: ${en}`);
const voice = styleNote([{ fromMe: false, text: "ابي اشوف الاطقم اللي عندكم للعرس", voice: true }, her(new Date(t0 + H), "🌸🌸")]);
ok(voice.includes("صوتية") && voice.includes("إيموجي واحد"), `voice notes and emoji: ${voice}`);
ok(styleNote([her(new Date(t0), "Hello! Can I get more info on this?")]) === "", "the ad's prefilled line is not how she writes");

// ── 4. Angle memory ──────────────────────────────────────────────
const sent = ["مساء الخير، عندنا قطع كثيرة في الموقع تقدرين تشوفينها على راحتك https://floret-royal.io", "هلا، تدورين على شي لمناسبة قريبة أو للبس اليومي؟"];
ok(repeatsSent("مساء الخير، عندنا قطع كثيرة في الموقع تقدرين تشوفينها https://floret-royal.io", sent), "a near-copy of a sent one is caught");
ok(!repeatsSent("أهلين، إذا عجبك تصميم أرسلي صورته هنا ونكمل معك خطوة بخطوة", sent), "a new angle passes");
ok(!repeatsSent("زوروا https://floret-royal.io", ["شوفي https://floret-royal.io"]), "the shared site link alone is not a repeat");
ok(!repeatsSent(sent[0]!, ["أ", "ب", "ج", sent[0]!]), "only our last three are compared");
const al = adaptLines({ styleNote: "ملاحظة", lastSent: ["واحد", "اثنان", "ثلاثة"] });
ok(al.includes("ملاحظة") && al.includes("واحد") && al.includes("اثنان") && !al.includes("ثلاثة") && al.includes("زاوية مختلفة"), "the prompt gets the style note and the last two");
ok(adaptLines({}) === "", "nothing learned → nothing added");

// ── 5. A time they named ─────────────────────────────────────────
const said = dubai(6, 15).getTime(); // Friday 6 Nov 2026, 3pm Dubai
const at10 = (day: number, month = 10, year = 2026) => Date.UTC(year, month, day, 6); // 10:00 Dubai
const cue = (t: string) => timeCue(t, said, "Asia/Dubai");
ok(cue("تمام بكرة أشوف")?.at === at10(7), "بكرة → tomorrow 10am");
ok(cue("أوكي وبكرا أرد عليك")?.at === at10(7), "وبكرا too");
ok(cue("بعد بكرة إن شاء الله")?.at === at10(8), "بعد بكرة → in two days");
ok(cue("I'll check tomorrow")?.at === at10(7), "tomorrow");
ok(cue("ok, next week then")?.at === at10(9), "next week → Monday");
ok(cue("الأسبوع الجاي ان شاء الله")?.at === at10(9), "الأسبوع الجاي → Monday");
ok(cue("after the 15th please")?.at === at10(16), "after the 15th → the 16th");
ok(cue("بعد ١٥ الشهر")?.at === at10(16), "بعد ١٥ → the 16th");
ok(cue("بعد 3 الشهر")?.at === at10(4, 11), "a date already past → next month's");
ok(cue("الشهر الجاي")?.at === at10(1, 11), "الشهر الجاي → the 1st");
ok(cue("next month maybe")?.at === at10(1, 11), "next month");
ok(cue("in 3 days")?.at === at10(9) && cue("بعد ٣ أيام")?.at === at10(9) && cue("بعد يومين")?.at === at10(8), "in N days / بعد يومين");
ok(cue("بعد أسبوعين")?.at === at10(20) && cue("in two weeks")?.at === at10(20), "two weeks");
ok(cue("بعد شهرين")!.at === said + CUE_CAP_DAYS * D, "بعد شهرين is capped at 45 days");
ok(cue("بعد العيد")!.at === said + CUE_CAP_DAYS * D && cue("after eid")!.at === said + CUE_CAP_DAYS * D, "بعد العيد (March 2027) is capped at 45 days");
ok(timeCue("بعد العيد", dubai(8, 15).getTime() - 250 * D, "Asia/Dubai")?.at === Date.UTC(2026, 2, 24, 6), "بعد العيد in early 2026 → four days after Eid al-Fitr");
ok(cue("بعد الراتب")?.at === at10(1, 11), "بعد الراتب → the 1st");
ok(cue("يوم الخميس أمر عليكم")?.at === at10(12), "يوم الخميس → next Thursday");
ok(cue("الويكند")?.at === at10(7), "الويكند → Saturday");
for (const none of ["ok thanks", "مبكرا شوي", "بعد الغداء", "بعد 10 دقايق", "كم السعر؟", ""]) ok(cue(none) === null, `no cue in «${none}»`);
ok(/[؀-ۿ]/.test(dayAr(at10(7))), `dayAr is Arabic: ${dayAr(at10(7))}`);

console.log(`smart-followup-adaptive: ${n}/${n} ✅`);
process.exit(0);
