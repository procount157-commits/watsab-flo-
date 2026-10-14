// مكتب البيانات، وتقييم المدير، وعقيدة المتابعة — كلها دوالّ صِرفة.
// وكل حالةٍ هنا من بيانات الحساب الحقيقية أو من خطأٍ وقع فيه أول تشغيل.

export {};
const C = await import("../data-desk/classify");
const K = await import("../data-desk/clean");
const E = await import("../team/evaluate");
const F = await import("../followup-doctrine");
const { judgeWa } = await import("../wa-manager");
const { GRAPHS, contractProblems, nodeBrief, WHATSAPP_GRAPH, EMAIL_GRAPH } = await import("../graph/contracts");
const { managerOf } = await import("../team/room");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(62)} ${d}`); };

// ── المصنِّف: القطاع، وبماذا عُرف ──
const row = (company: string, hint?: string, industry?: string) => C.classifyRow({ company, hint, industry });
check("تصنيف · اسمها يقول عقارات", row("PREMIUM GATE REAL ESTATE").sector === "عقارات" && row("PREMIUM GATE REAL ESTATE").by === "own");
check("تصنيف · وساطة عقارية", row("Wise Global Real Estate Brokers").bucket === "both");
check("تصنيف · محل ذهب تجزئة ← AML", row("Golden Star Jewellery L.L.C").bucket === "aml");
check("تصنيف · مكتب محاماة ← AML", row("Al Noor Advocates & Legal Consultants").bucket === "aml");
check("تصنيف · مقاولات ← محاسبة", row("Al Towar Contracting LLC").bucket === "services");
check("تصنيف · مطعم ← محاسبة", row("Zaatar Restaurant & Cafe").bucket === "services");
check("تصنيف · مواد بناء مع عائلة المقاولات", row("Al Rahmania Building Materials Trading").bucket === "services");
check("تصنيف · مكتب تدقيق منافس لا عميل", row("Prime Auditing & Accounting").bucket === "competitor");
check("تصنيف · قطاع معروف خارج الأهداف ثانوي", row("Smart Link Software Solutions").bucket === "secondary");
check("تصنيف · ما يُراسَل وما لا", C.sendable("aml") && C.sendable("both") && C.sendable("services") && !C.sendable("secondary") && !C.sendable("competitor") && !C.sendable("unknown"));

// الخطأ الذي كان يختبئ: فندقٌ في ملف العقارات صار عقارات.
const hotel = row("HILTON CREEK HOTEL", "UAE-real-estate");
check("غريب · فندق في ملف العقارات ليس عقارات", hotel.sector === "سياحة وسفر" && hotel.by === "own", hotel.sector ?? "");
// ومن لا يقول اسمه شيئاً يرث — لكن يُعلَّم بضعفه.
const dumb = row("Dahan Flowers", "الإمارات-مقاولات-تخصصية");
check("وراثة · اسمٌ لا يدلّ يرث من الملف ويُعلَّم", dumb.sector === "مقاولات" && dumb.by === "hint", `${dumb.sector} / ${dumb.by}`);
check("وراثة · والسبب يقول ذلك", /ورثته من الملف/.test(dumb.why));
// قائمة «ليست-مقاولات» ورّثت ٦٩ جهة قطاع «مقاولات».
const neg = row("Action Park", "الإمارات-ليست-مقاولات");
check("وراثة · اسم ملفٍ ينفي لا يورّث", neg.sector === null && neg.bucket === "unknown", neg.sector ?? "null");
check("وراثة · والنفي بالإنجليزية كذلك", row("Some Name", "not-contracting-list").sector === null);
check("تصنيف · النشاط المكتوب يسبق الاسم", row("Golden Star", "x", "Real Estate Brokerage").sector === "عقارات");
check("تصنيف · بلا اسم مجهول", C.classifyRow({}).bucket === "unknown");

// قراءة جواب النموذج بصرامة
const parsed = C.parseModel("1|تجميل وصالونات\n2|؟\n3| طبي وصحي \n4|قطاع مخترع\n9|عقارات\nكلام زائد", 4);
check("نموذج · قطاعٌ من القائمة يُقبل", parsed[0] === "تجميل وصالونات" && parsed[2] === "طبي وصحي");
check("نموذج · «؟» تبقى مجهولة", parsed[1] === null);
check("نموذج · قطاعٌ خارج القائمة يُسقَط", parsed[3] === null);
check("نموذج · رقمٌ خارج المدى يُهمَل", parsed.length === 4);
check("نموذج · التعليمات تمنع التخمين", /التخمين ممنوع/.test(C.modelPrompt(["x"]).system));

const reading = C.readList([
  ...Array(70).fill({ sector: "عقارات", by: "own" }), ...Array(20).fill({ sector: "عقارات", by: "hint" }),
  ...Array(6).fill({ sector: "سياحة وسفر", by: "own" }), ...Array(4).fill({ sector: null, by: null }),
]);
check("قراءة · القطاع الغالب", reading.dominant === "عقارات");
check("قراءة · الغرباء من قال اسمهم ذلك", reading.strangers === 6, `${reading.strangers}`);
check("قراءة · الموروث يُعدّ وحده", reading.byHintOnly === 20);
check("قراءة · المجموع لا يتسرّب", Object.values(reading.byBucket).reduce((a, b) => a + b, 0) === 100);

// ── المنظِّف ──
check("تنظيف · gmial.com يُصحَّح", K.cleanEmail("Ali@Gmial.com").email === "ali@gmail.com" && K.cleanEmail("Ali@Gmial.com").verdict === "fixed");
check("تنظيف · .con تُصحَّح", K.cleanEmail("info@firm.con").email === "info@firm.com");
check("تنظيف · زوائد حول العنوان", K.cleanEmail(" <mailto:a@b.ae>, ").email === "a@b.ae");
check("تنظيف · عنوانٌ سليم لا يُمسّ", K.cleanEmail("ceo@acme.ae").verdict === "ok");
check("تنظيف · noreply مردود بسببه", K.cleanEmail("noreply@acme.ae").verdict === "rejected" && /وهمي/.test(K.cleanEmail("noreply@acme.ae").reason ?? ""));
check("تنظيف · بريدٌ مؤقت مردود", K.cleanEmail("x@mailinator.com").verdict === "rejected");
check("تنظيف · ليس بريداً", K.cleanEmail("0501234567").verdict === "rejected");
check("تنظيف · عنوان القسم يُعلَّم ولا يُردّ", K.cleanEmail("info@acme.ae").flags.includes("role") && K.cleanEmail("info@acme.ae").verdict === "ok");
check("تنظيف · جوّال إماراتي يُوحَّد", K.cleanPhone("050 123 4567").phone === "971501234567");
check("تنظيف · أرضي مردود بسببه", K.cleanPhone("02 123 4567").verdict === "rejected" && /أرضي/.test(K.cleanPhone("02 123 4567").reason ?? ""));
check("تنظيف · اسمٌ وهمي يُفرَّغ", K.cleanName("N/A") === null && K.cleanName("12345") === null && K.cleanName("-") === null);
check("تنظيف · اسمٌ حقيقي يبقى", K.cleanName("  Nina Properties ") === "Nina Properties");
const batch = K.clearBatch(["a@x.ae", "A@X.AE", "bad", "b@gmial.com", "noreply@x.ae"], (e) => { const c = K.cleanEmail(e); return { key: c.email, verdict: c.verdict, fixes: c.fixes, reason: c.reason, flags: c.flags, shown: e }; });
check("دفعة · المكرّر يُعدّ وحده", batch.report.duplicates === 1 && batch.kept.length === 2, `kept ${batch.kept.length}`);
check("دفعة · كل سببٍ بعدده ومثاله", batch.report.reasons.length === 2 && batch.report.reasons.every((r) => r.n === 1 && r.example.length > 0));
check("دفعة · الأعداد لا تتسرّب", batch.report.ok + batch.report.fixed + batch.report.rejected + batch.report.duplicates === batch.report.total);

// ── التقييم ──
const f = (o: Partial<any>) => ({ done: 0, failed: 0, held: 0, llmCalls: 0, llmFailed: 0, decided: 0, approved: 0, edited: 0, rejected: 0, said: 0, heard: 0, lastAt: null, days: 7, ...o });
check("تقييم · بلا عمل لا درجة", E.scoreOf(f({})).grade === "idle" && E.scoreOf(f({})).score === null);
check("تقييم · عملٌ بلا تعثّر وتواصل: قوي", E.scoreOf(f({ done: 80, said: 5, heard: 3 })).grade === "strong");
check("تقييم · من يعمل صامتاً ينزل", E.scoreOf(f({ done: 80 })).score! < E.scoreOf(f({ done: 80, said: 3 })).score!);
check("تقييم · الحجز ليس تعثّراً", E.scoreOf(f({ done: 10, held: 90, said: 2 })).score === E.scoreOf(f({ done: 10, said: 2 })).score);
check("تقييم · ثلث العمل يتعثّر: ضعيف", E.scoreOf(f({ done: 20, failed: 30, said: 1 })).grade === "weak");
check("تقييم · رفض المالك يُنزل الدرجة", E.scoreOf(f({ done: 30, decided: 10, approved: 2, rejected: 8, said: 2 })).score! < E.scoreOf(f({ done: 30, decided: 10, approved: 9, rejected: 1, said: 2 })).score!);
check("تقييم · دون خمس مسودات لا يُحسب حكم المالك", E.scoreOf(f({ done: 30, decided: 3, rejected: 3, said: 2 })).parts.owner === null);
check("تقييم · الأرقام نفسها تعطي الدرجة نفسها", E.scoreOf(f({ done: 54, failed: 3 })).score === E.scoreOf(f({ done: 54, failed: 3 })).score);
const fo = (o: Partial<any>, g: any = "ok") => E.findingOf(f(o), g, "شمّة");
check("ملاحظة · التعثّر أولاً برقمه", /12 من 40/.test(fo({ done: 28, failed: 12 }, "weak").finding) && !!fo({ done: 28, failed: 12 }, "weak").task);
check("ملاحظة · الصامت يُعطى مهمة التبليغ", /في صمت/.test(fo({ done: 54 }).task ?? ""));
check("ملاحظة · فشل النموذج ليس ذنب الموظف", fo({ done: 20, llmCalls: 20, llmFailed: 10, said: 2 }).task === null);
check("ملاحظة · من لا عيب في أرقامه لا مهمة له", fo({ done: 40, said: 3, heard: 2 }, "strong").task === null);
check("ملاحظة · الموقوف لا يُقيَّم", fo({}, "off").task === null);

// ── حكم الواتساب: الإيقاف يُقرأ قبل الردود ──
check("واتساب · عيّنة صغيرة تُراقَب", judgeWa({ reached: 29, replied: 4, positive: 2, stops: 0 }).verdict === "watch");
check("واتساب · ٣٪ إيقاف توقف الحملة ولو كثر الرد", judgeWa({ reached: 200, replied: 80, positive: 20, stops: 7 }).verdict === "hold");
check("واتساب · ٣٪ نافع: وسِّع", judgeWa({ reached: 200, replied: 60, positive: 7, stops: 1 }).verdict === "scale");
check("واتساب · حملة المقاولات الحقيقية: استمر", judgeWa({ reached: 564, replied: 151, positive: 14, stops: 5 }).verdict === "continue");
check("واتساب · لا ردّ من ١٥٠: أعد الكتابة", judgeWa({ reached: 180, replied: 0, positive: 0, stops: 0 }).verdict === "rewrite");

// ── عقيدة المتابعة: تُفرَض بالكود ──
check("متابعة · «أتابع معك» تُسقط", F.followupIssues("مرحبا، أتابع معك بخصوص العرض").length > 0);
check("متابعة · «للتذكير» تُسقط", F.followupIssues("للتذكير فقط بموعدنا").length > 0);
check("متابعة · just checking in تُسقط", F.followupIssues("Hi, just checking in on my last email").length > 0);
check("متابعة · الاعتذار عن المتابعة يُسقط", F.followupIssues("آسف على الإزعاج، هل قرأتم العرض").length > 0);
check("متابعة · سؤالان يُسقطان", F.followupIssues("هل الرخصة تجارية؟ وكم عدد الموظفين؟").length > 0);
check("متابعة · الأخيرة بلا سؤال", F.followupIssues("شكراً لوقتك، هل أرسل لك شيئاً؟", { last: true }).length > 0);
check("متابعة · رسالةٌ جديدة قصيرة تمرّ", F.followupIssues("الإقرار يُبنى على دفاتر السنة كلها. أرسل لك قائمة ما يُطلب؟").length === 0);
check("متابعة · التشكيل لا يُخفي العبارة", F.followupIssues("أُتابِع معك").length > 0);
check("متابعة · الصنعة تبدأ بتشخيص الصمت", F.FOLLOWUP_CRAFT.indexOf("شخّص الصمت") < F.FOLLOWUP_CRAFT.indexOf("ما لا يُكتب"));

// ── القراف: العقود سليمة، ولكل مكتبٍ مديرٌ وحلقة ──
for (const g of GRAPHS) check(`قراف ${g.id} · العقد سليم`, contractProblems(g).length === 0, contractProblems(g).join(" | "));
check("قراف الواتساب · له مديرة تراجع", WHATSAPP_GRAPH.nodes.some((n) => n.id === "chief" && (n.reviews?.length ?? 0) > 0));
check("قراف الواتساب · له حلقة", !!WHATSAPP_GRAPH.loop);
check("قراف الواتساب · المنظّف يسلّم المصنّف", WHATSAPP_GRAPH.edges.some((e) => e.from === "intake" && e.to === "collector"));
check("قراف البريد · المنظّف يسلّم المصنّفة", EMAIL_GRAPH.edges.some((e) => e.from === "email_guard" && e.to === "email_data"));
check("قراف البريد · التصنيف يصل المدير", EMAIL_GRAPH.edges.some((e) => e.from === "email_data" && e.to === "email_manager"));
check("قراف · موقع المديرة يُكتب من العقد", /تقيّم كل موظف/.test(nodeBrief(WHATSAPP_GRAPH, "chief")));
check("إدارة · لكل دورٍ مدير", managerOf("sales") === "chief" && managerOf("email_guard") === "email_manager" && managerOf("chief") === "engineer" && managerOf("ig_writer") === "ig_manager");

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
