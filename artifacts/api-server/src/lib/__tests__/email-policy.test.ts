// سياسة الاستهداف وأحكام المحلّل. كلها دوالّ صِرفة: قرار صاحب العمل
// مكتوبٌ مرةً، وهذه تتحقّق أن الكود يقوله كما قاله هو.
//
//   · كل الحملات بالإنجليزية
//   · ٨٠٪ AML / ٢٠٪ بقية الخدمات
//   · AML: العقارات، الوساطة العقارية، المحامون، الذهب والمجوهرات
//   · المحاسبة وبقية الخدمات: المطاعم، المقاولات، العقارات

export {};
const P = await import("../email/policy");
const { judge, MIN_SAMPLE, FAIL_SAMPLE } = await import("../email/results");
const { classifySendFailure } = await import("../email/provider");
const { classifySector } = await import("../email/sector");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

// ── اللغة والنسبة ──
check("اللغة · الإنجليزية وحدها", P.CAMPAIGN_LANGUAGE === "en");
check("النسبة · ٨٠ / ٢٠", P.MIX.aml === 0.8 && P.MIX.services === 0.2);
check("النسبة · مجموعها واحد", Math.abs(P.MIX.aml + P.MIX.services - 1) < 1e-9);

// ── من يُراسَل بماذا ──
const want: Array<[string, string[]]> = [
  ["عقارات", ["aml", "services"]], ["قانونية", ["aml"]], ["ذهب ومجوهرات", ["aml"]],
  ["مطاعم ومقاهي", ["services"]], ["مقاولات", ["services"]],
];
for (const [sector, tracks] of want) check(`استهداف · ${sector} ← ${tracks.join(" + ")}`, JSON.stringify(P.tracksFor(sector)) === JSON.stringify(tracks), P.tracksFor(sector).join("+"));
for (const s of ["سياحة وسفر", "تقنية", "تجارة عامة", "مالية وتأمين", "استشارات", "محاسبة وتدقيق", null]) {
  check(`خارج الاستهداف · ${s ?? "بلا قطاع"}`, !P.isTargeted(s));
}
// الوساطة العقارية والمحامون بأسمائهم كما تصل من الملفات
check("الوساطة العقارية تُصنَّف عقارات", classifySector({ company: "Prime Real Estate Brokers L.L.C" }) === "عقارات");
check("مكتب محاماة يُصنَّف قانونية", classifySector({ company: "Al Noor Advocates & Legal Consultants" }) === "قانونية");
check("محل ذهب يُصنَّف ذهب ومجوهرات", classifySector({ company: "Golden Star Jewellery L.L.C" }) === "ذهب ومجوهرات");

// ── الزوايا ──
for (const t of ["aml", "services"] as const) for (const s of P.TARGETS[t]) {
  const a = P.anglesFor(t, s);
  check(`زوايا · ${s} / ${t}: اثنتان على الأقل`, a.length >= 2, `${a.length}`);
  check(`زوايا · ${s} / ${t}: بلا رقمٍ مُختلق`, a.every((x) => !/\d{2,}|%|٪|درهم|AED/.test(x.goal)), a.find((x) => /\d{2,}|%|٪|درهم|AED/.test(x.goal))?.id ?? "");
}
const ids = [...new Set((["aml", "services"] as const).flatMap((t) => P.TARGETS[t].flatMap((s) => P.anglesFor(t, s).map((a) => a.id))))];
// مواد البناء والخدمات الفنية تكتب بزوايا المقاولات، والأغذية بزوايا المطاعم:
// المعرّف يتكرّر بين قطاعات العائلة عمداً، ويبقى فريداً داخل قطاعه.
check("زوايا · فريدة داخل كل قطاع", (["aml", "services"] as const).every((t) => P.TARGETS[t].every((s) => { const a = P.anglesFor(t, s).map((x) => x.id); return new Set(a).size === a.length; })));
check("زوايا · عائلة المقاولات تكتب بزواياها", P.anglesFor("services", "مواد بناء")[0]?.id === P.anglesFor("services", "مقاولات")[0]?.id && P.anglesFor("services", "أغذية")[0]?.id === P.anglesFor("services", "مطاعم ومقاهي")[0]?.id);
check("زوايا · كلها تُعرف مسارها", ids.every((id) => P.trackOfAngle(id) !== null));
check("زوايا · AML للمحامين لا تعمّم الخضوع", P.anglesFor("aml", "قانونية").some((a) => /تتوقف|حين يباشرون|ينطبق عليها/.test(a.goal)));
check("زوايا · AML للعقارات لا تعدّ goAML امتثالاً", /لا التسجيل في goAML وحده/.test(P.anglesFor("aml", "عقارات")[0]!.goal));

// الدوران: النص الواحد مئات المرات هو ما رفضه المزوّد
const re = P.anglesFor("aml", "عقارات").map((a) => a.id);
check("دوران · الأولى حين لا سابق", P.nextAngle("aml", "عقارات", [])!.id === re[0]);
check("دوران · لا تُعاد المستعملة والباقي لم يُجرَّب", P.nextAngle("aml", "عقارات", [re[0]!])!.id === re[1]);
check("دوران · تدور على الثلاث", P.nextAngle("aml", "عقارات", [re[0]!, re[1]!])!.id === re[2]);
check("دوران · ثم تعود للأبعد عهداً", P.nextAngle("aml", "عقارات", [re[0]!, re[1]!, re[2]!])!.id === re[0]);
check("دوران · ما حكم عليه المحلّل يُتخطّى", P.nextAngle("aml", "عقارات", [], [re[0]!])!.id === re[1]);
check("دوران · وإن حُكم على الكل بقيت واحدة", P.nextAngle("aml", "عقارات", [], re) !== null);
check("دوران · قطاعٌ بلا زوايا يُرجع null", P.nextAngle("aml", "سياحة وسفر", []) === null);

// ── النسبة: الخدمات لا تتجاوز خُمس الحجم ──
const al = (aml: number, services: number, amlHasAudience = true) => P.servicesAllowance({ aml, services }, { amlHasAudience });
check("نسبة · لا خدمات قبل أي AML", al(0, 0).allowed === 0);
check("نسبة · ٨٠٠ AML تتّسع لـ٢٠٠ خدمات", al(800, 0).allowed === 200);
check("نسبة · عند ٨٠/٢٠ بالضبط لا مزيد", al(800, 200).allowed === 0);
check("نسبة · فوق السقف لا سالب", al(800, 300).allowed === 0);
check("نسبة · ما يتّسع ينقص بما أُخذ", al(800, 150).allowed === 50);
check("نسبة · بلا جمهورٍ لـAML يُرفع السقف", al(0, 500, false).lifted === true);
// بعد أن تأخذ الخدمات ما يتّسع، النسبة لا تتجاوز ٢٠٪
{ const a = 1000, sv = al(a, 0).allowed; check("نسبة · الحدّ يحفظ ٢٠٪ بالضبط", Math.abs(sv / (a + sv) - 0.2) < 0.001, `${(sv / (a + sv) * 100).toFixed(1)}٪`); }

const ct = (sector: string, aml: number, services: number, amlHasAudience = true) => P.chooseTrack(sector, { aml, services }, { amlHasAudience, minWave: 15 });
check("مسار · العقارات تبدأ AML", ct("عقارات", 0, 0)!.track === "aml");
check("مسار · العقارات تأخذ خدمات حين يتّسع سقفها", ct("عقارات", 800, 0)!.track === "services" && ct("عقارات", 800, 0)!.take === 200);
check("مسار · والعقارات تعود AML عند امتلاء السقف", ct("عقارات", 800, 200)!.track === "aml");
check("مسار · المحامون AML دائماً", ct("قانونية", 800, 0)!.track === "aml");
check("مسار · المطاعم تنتظر حين يمتلئ السقف", ct("مطاعم ومقاهي", 800, 200) === null);
check("مسار · والمطاعم تأخذ حين يتّسع", ct("مطاعم ومقاهي", 800, 100)!.track === "services");
check("مسار · سقفٌ أضيق من موجةٍ لا يُطلق خدمات", ct("عقارات", 40, 0)!.track === "aml");
check("مسار · خارج الاستهداف لا مسار", ct("سياحة وسفر", 800, 0) === null);

// محاكاة: قائمة عقاراتٍ وحدها، موجةً بعد موجة — إلى أين تستقرّ النسبة؟
{ const s = { aml: 0, services: 0 };
  for (let i = 0; i < 40; i++) { const p = ct("عقارات", s.aml, s.services)!; s[p.track] += Math.min(200, p.take ?? 200); }
  const sh = P.mixShare(s);
  check("محاكاة · ٤٠ موجة عقارات تستقرّ قرب ٨٠/٢٠", sh.aml >= 0.78 && sh.aml <= 0.84, `AML ${(sh.aml * 100).toFixed(1)}٪ · خدمات ${(sh.services * 100).toFixed(1)}٪`); }

// ── أحكام المحلّل ──
const j = (sent: number, positive: number, bounced = 0, rejected = 0, scope: "unit" | "aggregate" = "unit") => judge({ sent, positive, bounced, rejected }, scope).verdict;
check("حكم · عيّنة صغيرة تُراقَب ولا يُحكم عليها", j(MIN_SAMPLE - 1, 0) === "watch");
check("حكم · عشرون بلا ردٍّ لم تفشل", j(20, 0) === "watch");
check("حكم · ردٌّ نافع من كل مئة: وسِّع", j(200, 2) === "scale");
check("حكم · دون العتبة: استمر", j(300, 1) === "continue");
check("حكم · صفرٌ قبل مئةٍ وخمسين ليس فشلاً", j(FAIL_SAMPLE - 1, 0) === "continue");
check("حكم · صفرٌ بعدها: أعد الكتابة", j(FAIL_SAMPLE, 0) === "rewrite");
check("حكم · ارتدادٌ فوق الحد يسبق الردود: أوقِف", j(200, 5, 12) === "hold");
check("حكم · رفض المزوّد يُسقط الزاوية ولو صغُرت العيّنة", j(30, 0, 0, 5) === "rewrite");
// الأرقام نفسها، بنطاقين: حملةٌ رُفض منها ثلاثون تُعاد كتابتها، والمسار
// الذي فيه تلك الحملة وفيه اثنا عشر رداً نافعاً يُوسَّع.
check("حكم · رفض المزوّد يُسقط الحملة", judge({ sent: 900, positive: 12, bounced: 10, rejected: 30 }, "unit").verdict === "rewrite");
check("حكم · ولا يُسقط المسار كله", judge({ sent: 900, positive: 12, bounced: 10, rejected: 30 }, "aggregate").verdict === "scale");
check("حكم · المسار بتسعمئةٍ بلا ردٍّ يُعاد كتابته بسببه هو", judge({ sent: 900, positive: 0, bounced: 10, rejected: 30 }, "aggregate").why.includes("ولا ردّ نافع"));

// ── رفض المزوّد ليس ارتداداً ──
// «554 5.7.1 Spam message rejected» أخرج ثلاثين شركة سليمة من القوائم.
check("فشل · 554 5.7.1 Spam message rejected ← سياسة", classifySendFailure("554", "Message failed: 554 5.7.1 Spam message rejected") === "policy");
check("فشل · 550 5.1.1 user unknown ← عنوان", classifySendFailure("550", "550 5.1.1 The email account that you tried to reach does not exist. User unknown") === "address");
check("فشل · mailbox unavailable ← عنوان", classifySendFailure("550", "550 Requested action not taken: mailbox unavailable") === "address");
check("فشل · 5.7.26 مصادقة ← سياسة", classifySendFailure("550", "550 5.7.26 This mail is unauthenticated") === "policy");
check("فشل · حدّ المعدّل ← عابر", classifySendFailure("550", "550 Too many messages, rate limit exceeded") === "transient");
check("فشل · 421 ← عابر", classifySendFailure("421", "421 Service not available, try again later") === "transient");
check("فشل · 5xx بلا دلالة لا يُعاقَب به عنوان", classifySendFailure("554", "554 Transaction failed") !== "address");

// ── السياسة كما تُعطى للمدير ──
const brief = P.policyBrief();
check("السياسة · فيها النسبة", brief.includes("80٪") && brief.includes("20٪"));
check("السياسة · فيها الإنجليزية", brief.includes("بالإنجليزية"));
check("السياسة · فيها قطاعات المسارين", ["عقارات", "قانونية", "ذهب ومجوهرات", "مطاعم ومقاهي", "مقاولات"].every((s) => brief.includes(s)));

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
