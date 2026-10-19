// محل الذهب: لا سعر ولا وزن ولا تحبّب، والرد على السعر رابط القطعة. دوالّ صِرفة.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { priceOrWeight, checkReply, blocksSend } = await import("../reply-check");
const { pieceEntry, pieceUrl, shopName } = await import("../catalog/floret");
const { JEWELRY_ANGLE } = await import("../smart-followup");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(54)} ${d}`); };

const bad = ["سعره اليوم ٦٬٤٦٠ درهم شامل", "وزنه ١٢.٨٧ جم", "سعر الذهب اليوم ٤٣٣", "it is 6,460 AED", "12.5 g of 21k", "المصنعية 45 للجرام", "السعر 2300"];
for (const b of bad) check(`ممنوع · «${b}»`, priceOrWeight(b) !== null, String(priceOrWeight(b)));
const ok = ["تفضلي رابط القطعة، فيه السعر والتفاصيل: https://floret-royal.io/product/taqm-al-clover-al-mufarragh", "الأسعار والتفاصيل في الرابط", "طقم عيار ٢١ متوفر", "المعرض في العين مفتوح لين الساعة عشر"];
for (const o of ok) check(`مسموح · «${o.slice(0, 30)}…»`, priceOrWeight(o) === null, String(priceOrWeight(o)));

const ctx = { customer: "كم سعره؟", noPrices: true, strictNumbers: true, warm: true, facts: "قطعة: طقم الكلوفر · السعر 6460 درهم", catalogNames: [] };
const r = checkReply("سعره ٦٤٦٠ درهم شامل الضريبة 🌸", ctx as any);
check("السعر يُوقف الرسالة ولو كان في الحقائق", blocksSend(r) && r.issues.some((i) => i.code === "price-weight"));
check("صاحبتي تُوقف الرسالة", blocksSend(checkReply("هلا صاحبتي، تفضلي الرابط", ctx as any)));
check("رابط محترم يمر", !blocksSend(checkReply("أهلاً بك 🌸 تفضلي رابط القطعة، فيه السعر والتفاصيل: https://floret-royal.io/product/x", ctx as any)));
check("الخصم ممنوع في المحل", blocksSend(checkReply("عندنا خصم على المصنعية هالأسبوع", ctx as any)));

const e = pieceEntry({ sku: "FLR-1", slug: "taqm-x", name: "طقم", purity: 21, weightG: 12.87, priceAed: 6460, tagline: null, highlights: ["خاتم، الوزن 2.29 جم · عيار 21"], occasion: [], audience: [], inStock: true });
check("مدخل القطعة بلا وزن ولا سعر", !/درهم|جم\b|12\.87|6,460|6460/.test(e.content), e.content.split("\n")[0]);
check("ومعه رابط صفحتها", e.content.includes(pieceUrl("taqm-x")));
check("المتابعات بلا سعر ولا خصم ولا مصنعية", JEWELRY_ANGLE.every((a) => !/سعرها|خصم على|المصنعية كما|سعر الجرام/.test(a.replace("بلا خصم", ""))));
check("الاسم بلا وزنه", shopName("طقم البيضاوي بنقش المفتاح (4.07 جم)") === "طقم البيضاوي بنقش المفتاح");
check("وزن الحبة يسقط من الوصف", !pieceEntry({ sku: "H", slug: "h", name: "حيول (5.53 جم)", purity: 21, weightG: null, priceAed: null, tagline: null, highlights: ["حيول — السعر للحبة الواحدة، وزن الحبة 5.53 جم · عيار 21"], occasion: [], audience: [], inStock: true }).content.match(/جم|السعر للحبة/));
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
