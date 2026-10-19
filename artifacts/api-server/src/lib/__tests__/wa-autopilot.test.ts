// حملات واتساب التلقائية: الهدف بالنسبة، والحكم، وفحص النسخ. دوالّ صِرفة.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { nextSector, judge, variantIssues, writerPrompt, SECTOR_BRIEF } = await import("../wa-autopilot");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(52)} ${d}`); };

const all = { "عقارات": 500, "ذهب ومجوهرات": 200, "قانونية": 50, "مقاولات": 400, "مطاعم ومقاهي": 300 };
check("بلا تجارب: AML أولاً", nextSector({ aml: 0, services: 0 }, {}, all, 40)?.service === "aml");
check("AML عند ٨٠٪: الخدمات", nextSector({ aml: 8, services: 1 }, {}, all, 40)?.service === "services");
check("الأقدم تجربةً في المسار أولاً", nextSector({ aml: 0, services: 0 }, { "عقارات": 5, "ذهب ومجوهرات": 1 }, all, 40)?.sector === "قانونية");
check("قطاع بلا جمهور كافٍ يُتخطّى", nextSector({ aml: 0, services: 0 }, {}, { "عقارات": 10, "مقاولات": 100 }, 40)?.sector === "مقاولات");
check("لا جمهور أصلاً: لا هدف", nextSector({ aml: 0, services: 0 }, {}, {}, 40) === null);
check("كل قطاع مستهدف له ما يقال", ["عقارات", "ذهب ومجوهرات", "قانونية", "مقاولات", "مطاعم ومقاهي"].every((s) => !!SECTOR_BRIEF[s]));

const r = (key: string, sent: number, replied: number, interested: number, stopped: number) => ({ key, sent, replied, interested, stopped, score: 0 });
check("الأكثر ردوداً يفوز", judge([r("A", 20, 1, 0, 0), r("B", 20, 4, 1, 0)]).winner === "B");
check("الإيقاف يُخصم بثلاثة أضعاف", judge([r("A", 20, 3, 0, 2), r("B", 20, 2, 0, 0)]).winner === "B");
check("لا ردود: لا فائز", judge([r("A", 20, 0, 0, 0), r("B", 20, 0, 0, 1)]).winner === null);

check("نسخة بسعر في المحل تُرفض", variantIssues("طقم الكلوفر بسعر ٦٤٦٠ درهم 🌸 https://floret-royal.io/product/x", true, "").length > 0);
check("نسخة بتحبّب تُرفض", variantIssues("هلا حبيبتي، عندنا طقم جديد يليق بك https://floret-royal.io/product/x", true, "").length > 0);
check("نسخة نظيفة للمحل تمر", variantIssues("أهلاً بك 🌸 طقم الكلوفر المفرّغ يليق بليلة العرس، وهذه صفحته: https://floret-royal.io/product/x — تحبين نرتب لك الطلب؟", true, "").length === 0);
check("رقم مخترع للمحاسبة يُرفض", variantIssues("غرامة عدم التسجيل في goAML تصل إلى 50000 درهم — برو كاونت للمحاسبة", false, "").length > 0);
check("نسخة محاسبة نظيفة تمر", variantIssues("هل ملف مكافحة غسل الأموال في وكالتكم جاهز للتفتيش؟ برو كاونت للمحاسبة تجهّزه معكم من التسجيل في goAML إلى العناية الواجبة. اضغط «مهتم» ونتواصل.", false, "").length === 0);

const pr = writerPrompt({ vertical: "jewelry", firm: "فلوريت", description: "", target: "عملاء الإعلانات", service: "shop", brief: "", memory: "", facts: "", images: "", piece: "https://floret-royal.io/product/x" });
check("برمبت المحل يمنع السعر ويضع الرابط", pr.includes("ممنوع أي سعر") && pr.includes("https://floret-royal.io/product/x") && pr.includes("صاحبتي"));
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
