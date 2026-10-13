// الهدف ← الخطة، والقراف ← البرمبت. دوالّ صِرفة.
export {};
const { planForGoal, DEFAULT_RATES, WAVE_BOUNDS } = await import("../email/goal-plan");
const { EMAIL_GRAPH, contractProblems, nodeBrief } = await import("../graph/contracts");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };
const day = 86_400_000, now = new Date("2026-10-13T00:00:00Z");
const base = { metric: "clients_won" as const, target: 20, current: 0, startsAt: new Date(now.getTime() - 10 * day), deadline: new Date(now.getTime() + 80 * day), now,
  observed: { companies: 964, replied: 5, positive: 0, meetings: 0, clients: 0 }, dailyCapacity: 300, readyAudience: 8000, waveSize: 200, approvalMode: true };

const p = planForGoal(base);
check("عميل · القمع الافتراضي ١٣٣٤ شركة", p.companiesPerUnit === Math.ceil(1 / (DEFAULT_RATES.positivePerCompany * DEFAULT_RATES.meetingPerPositive * DEFAULT_RATES.clientPerMeeting)), String(p.companiesPerUnit));
check("عميل · الحاجة اليومية على ٨٠ يوماً", p.perDay === Math.ceil(p.companiesNeeded / 80), String(p.perDay));
check("عميل · الافتراض يُعلن", p.assumptions.length >= 3);
check("عميل · فوق السعة يُقال", p.blockers.some((b) => b.includes("سعة الإرسال")));
check("عميل · فوق الجمهور يُقال", p.blockers.some((b) => b.includes("ارفع قوائم")));
check("عميل · وضع الموافقة يُقال", p.blockers.some((b) => b.includes("موافقتك")));
check("عميل · غير ممكن بالحال", !p.feasible);
check("موجة · لا تتجاوز السعة ولا الحد", p.waveSize <= Math.min(WAVE_BOUNDS.max, 300), String(p.waveSize));
const small = planForGoal({ ...base, metric: "email_positive", target: 5, approvalMode: false });
check("ردود نافعة · ممكن", small.feasible, small.summary);
check("ردود نافعة · الموجة لا تنزل تحت الحد", small.waveSize >= WAVE_BOUNDS.min, String(small.waveSize));
const measured = planForGoal({ ...base, metric: "email_positive", observed: { ...base.observed, companies: 1000, positive: 20 } });
check("نسبة مقاسة بعد العيّنة", measured.rates.positive.measured && measured.companiesPerUnit === 50, String(measured.companiesPerUnit));
check("تحقّق · لا خطة", planForGoal({ ...base, current: 20 }).state === "done");
check("متأخر حين دون المتوقّع", p.state === "behind");

check("قراف البريد · العقود سليمة", contractProblems(EMAIL_GRAPH).length === 0, contractProblems(EMAIL_GRAPH).join(" · "));
check("قراف · المحلّل يسلّم للمدير", EMAIL_GRAPH.edges.some((e) => e.from === "email_analyst" && e.to === "email_manager"));
check("قراف · الحلقة تُغلق إلى الكاتبة", EMAIL_GRAPH.edges.some((e) => e.from === "email_analyst" && e.to === "email"));
check("قراف · الهدف من صاحب العمل للمدير", EMAIL_GRAPH.edges.some((e) => e.from === "owner" && e.to === "email_manager"));
const b = nodeBrief(EMAIL_GRAPH, "email_strategist");
check("برمبت · يعرف من يسلّمه ولمن يسلّم", b.includes("منصور") && b.includes("نورة"));
const broken = { ...EMAIL_GRAPH, edges: EMAIL_GRAPH.edges.filter((e) => e.from !== "email_analyst") };
check("قراف · محلّلٌ لا يسلّم حكمه يُرفض", contractProblems(broken).some((x) => x.includes("email_analyst")));
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
if (pass !== total) process.exit(1);
