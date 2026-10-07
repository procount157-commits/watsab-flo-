// The restructure, without a model: every employee has a charter and it
// reaches their instructions; the sales playbook is in the prompt; what we
// sent the customer is readable; a template blank never goes; and the
// follow-up ladder chases only those who spoke and went quiet.

export {};
const { charterOf, charterBlock } = await import("../roles/charters");
const { corePrompt } = await import("../prompt-core");
const { buildSystemPrompt, SALES_JOB } = await import("../knowledge");
const { readableTemplate, outreachPreamble } = await import("../outreach-context");
const { checkReply, blocksSend } = await import("../reply-check");
const { dueRung, overlap, LADDER, MAX_RUNGS, RUNG_ANGLE } = await import("../smart-followup");
const { db, botEmployeesTable } = await import("@workspace/db");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── Charters ─────────────────────────────────────────────────────
const roles = (await db.selectDistinct({ role: botEmployeesTable.role }).from(botEmployeesTable)).map((r) => r.role);
const without = roles.filter((r) => !charterOf(r));
check("every employee in the database has a charter", without.length === 0, without.join(", "));
const b = charterBlock("sales");
check("a charter says mission, delivery, measure and handoff", ["مهمتك", "ما تسلّمه", "تُقاس بـ", "تسلّم إلى"].every((k) => b.includes(k)));
check("social roles share their job's charter across platforms", charterOf("ig_writer")?.mission === charterOf("tt_writer")?.mission && !!charterOf("ig_writer"));
const core = corePrompt({ channel: "email", role: "email_guard", identity: "اسمك ماجد." });
check("the charter sits right after who they are", core.indexOf("دورك في الفريق") > core.indexOf("اسمك ماجد") && core.indexOf("دورك في الفريق") < core.indexOf("طريقة العمل"));

// ── Sales playbook and the campaign context ─────────────────────
const sys = buildSystemPrompt(null, [], [], "اسمك هال.", undefined, undefined, 1, "═══ ما أرسلناه له ═══");
check("the sales prompt carries the playbook's situations", sys.includes("ردّ على حملتنا") && sys.includes("«مهتم» أو ضغط زر الاهتمام") && sys.includes("يسأل عن السعر"));
check("licence is no longer the question for every topic", SALES_JOB.some((l) => l.includes("لا تُسأل إلا إن كان الموضوع ضريبة")));
const t = readableTemplate("{تحية} {اسم_الشركة|شركتكم} 👋\n{هل تعلم|هل تعرف} أن goAML إلزامي؟\n{cta}\n\n━━━━━━━━━━\n🔕 لإيقاف الرسائل أرسل: 0", "WEST LEGEND REAL ESTATE BROKERS L.L.C");
check("a campaign reads as the customer saw it", t.startsWith("West Legend Real Estate Brokers 👋") && t.includes("هل تعلم أن goAML") && !t.includes("{") && !t.includes("أرسل: 0"), JSON.stringify(t));
const pre = outreachPreamble({ campaign: "عقارات AML", text: "x", buttons: ["مهتم"], daysAgo: 2, read: true }, "West Legend");
check("the employee is told what we sent and to continue it", pre.includes("قبل 2 أيام") && pre.includes("أكمل موضوعها") && pre.includes("West Legend") && pre.includes("مهتم"));

// ── The blank that went to a customer ────────────────────────────
const q = checkReply("Hi, this is [Name] from the sales team. What do you need?", { customer: "Thank you for reaching us" });
check("«[Name]» is caught and stops the send", q.issues.some((i) => i.code === "placeholder") && blocksSend(q));
check("an ordinary reply is not blocked", !blocksSend(checkReply("هلا، أرسلنا لكم بخصوص goAML — مسجلين فيه؟", { customer: "مين معي" })));

// ── The follow-up ladder ────────────────────────────────────────
const H = 3_600_000, now = Date.UTC(2026, 9, 7, 9);
const at = (h: number) => new Date(now - h * H);
const spoke = [{ fromMe: true, text: "campaign", at: at(100) }, { fromMe: false, text: "كم السعر؟", at: at(50) }, { fromMe: true, text: "يعتمد على…", at: at(49) }];
check("someone who spoke and went quiet a day+ is due rung 1", dueRung(spoke, [], false, now)?.rung === 0);
check("...not before the day is up", dueRung(spoke.map((x, i) => i === 2 ? { ...x, at: at(10) } : x), [], false, now) === null);
check("a warm lead is followed after 4 hours", dueRung(spoke.map((x, i) => i === 2 ? { ...x, at: at(5) } : x), [], true, now)?.rung === 0);
check("a campaign recipient who never replied is never chased", dueRung([{ fromMe: true, text: "campaign", at: at(500) }], [], false, now) === null);
check("an unanswered message from them is the reply path's, not ours", dueRung([...spoke, { fromMe: false, text: "؟", at: at(30) }], [], false, now) === null);
const older = [{ fromMe: false, text: "كم السعر؟", at: at(150) }, { fromMe: true, text: "يعتمد على…", at: at(149) }];
check("rung 2 waits three days after rung 1", dueRung(older, [at(40)], false, now) === null && dueRung(older, [at(100)], false, now)?.rung === 1);
check("four at most, then silence", dueRung(spoke, [at(48), at(47), at(46), at(45)], false, now) === null && MAX_RUNGS === 4 && LADDER.cold.length === 4);
check("their reply resets the ladder", dueRung([...spoke, { fromMe: false, text: "تمام", at: at(30) }, { fromMe: true, text: "…", at: at(29) }], [at(45), at(44)], false, now)?.rung === 0);
check("four rungs, four different angles", new Set(RUNG_ANGLE).size === 4);
check("a near-copy of an earlier follow-up is recognised", overlap("هل تحب نرتب لك مكالمة قصيرة مع المختص بخصوص goAML", "تحب نرتب لك مكالمة قصيرة مع المختص بخصوص goAML؟") > 0.6 && overlap("مكالمة قصيرة", "ملخص مكتوب عن الضريبة") < 0.3);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
