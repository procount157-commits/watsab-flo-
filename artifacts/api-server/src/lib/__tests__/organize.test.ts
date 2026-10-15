// مجلدٌ لكل قطاع، قائمةٌ لكل ملف، وكل جهةٍ مرةً واحدة. دوالّ صِرفة، بأسماء القوائم الحقيقية.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { fixMojibake, sourceName, listSource, plan, emirateOf, NO_EMIRATE, fallbackSector } = await import("../organize");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(52)} ${d}`); };

check("ترميز معطوب يعود عربياً", fixMojibake(Buffer.from("00-الكل.csv", "utf8").toString("latin1")) === "00-الكل.csv");
check("نصٌّ سليم يبقى", fixMojibake("UAE-real-estate.csv") === "UAE-real-estate.csv" && fixMojibake("عقارات") === "عقارات");
check("المصدر · ملف: 00-الكل.csv ← 00-الكل", sourceName("ملف: 00-الكل.csv", "x") === "00-الكل");
check("المصدر · المعطوب يُصلح", sourceName("ملف: " + Buffer.from("الإمارات-يحتاج-مراجعة.csv", "utf8").toString("latin1"), "x") === "الإمارات-يحتاج-مراجعة");
check("المصدر · inbound ← اسم القائمة", sourceName("inbound", "UAE-real-estate") === "UAE-real-estate");
check("القائمة · مفروز ← من قوائم أخرى", listSource("مفروز — مقاولات") === "من قوائم أخرى");
check("القائمة · نسخة الطيار ← ملفها", listSource("UAE-real-estate — عقارات ووساطة عقارية") === "UAE-real-estate");
check("القائمة · جزء مرقّم ← ملفه", listSource("دليل دبي - 3") === "دليل دبي");

const p = plan([
  { contactId: 1, from: 10, sector: "مقاولات", source: "00-الكل" },
  { contactId: 2, from: 11, sector: "مقاولات", source: "00-الكل" },
  { contactId: 3, from: 10, sector: "مقاولات", source: "دليل دبي" },
  { contactId: 4, from: 10, sector: "عقارات", source: "00-الكل" },
  { contactId: 5, from: 12, sector: null, source: "مستخرج من واتساب" },
]);
check("الخطة · مقاولات من ملفين ← قائمتان في مجلد واحد", [...p.values()].filter((b) => b.sector === "مقاولات").length === 2);
check("الخطة · الملف نفسه من قائمتين ← قائمة واحدة", p.get("مقاولات\u000000-الكل")!.ids.join() === "1,2");
check("الخطة · قطاع آخر من الملف نفسه ← مجلده", p.get("عقارات\u000000-الكل")!.ids.join() === "4");
check("الخطة · بلا قطاع لا يُنقل", ![...p.values()].some((b) => b.ids.includes(5)));
const E: Array<[string, string]> = [["Dubai", "دبي"], ["dubai", "دبي"], ["دبي", "دبي"], ["Deira", "دبي"], ["Business Bay", "دبي"], ["Dubai Healthcare City", "دبي"],
  ["Abu Dhabi", "أبوظبي"], ["أبوظبي", "أبوظبي"], ["abudhabi / mussafah", "أبوظبي"], ["Al Ain", "أبوظبي"], ["العين", "أبوظبي"], ["الظفرة", "أبوظبي"], ["مَدينة أبوظبي الصناعية", "أبوظبي"],
  ["الشارقة", "الشارقة"], ["Sharjah", "الشارقة"], ["مدينة خور فكان", "الشارقة"], ["كلباء", "الشارقة"], ["الذيد", "الشارقة"], ["Dhaid", "الشارقة"], ["البطايح", "الشارقة"],
  ["Ajman", "عجمان"], ["Al Ajman", "عجمان"], ["Ras Al Khaimah", "رأس الخيمة"], ["Ras al-Khaimah", "رأس الخيمة"], ["راس الخيمة", "رأس الخيمة"],
  ["الفجيرة", "الفجيرة"], ["Fujairah", "الفجيرة"], ["ام القيوين", "أم القيوين"], ["Umm Al Quwain", "أم القيوين"], ["Umm al Qaiwain", "أم القيوين"], ["", NO_EMIRATE], ["Riyadh", NO_EMIRATE]];
const wrong = E.filter(([c, e]) => emirateOf(c) !== e);
check("الإمارة · كل المدن الحقيقية في إمارتها", wrong.length === 0, wrong.map(([c]) => `${c}→${emirateOf(c)}`).join(" · "));

check("غير مصنّف · قائمة «00-الكل» تُصنَّف", fallbackSector("00-الكل", "Max Fat Loss") !== null, String(fallbackSector("00-الكل", "Max Fat Loss")));
check("غير مصنّف · الاسم يُقرأ من جديد", fallbackSector("00-الكل", "Dubai Dentist - Dr. Lukman") !== "غير مصنف", String(fallbackSector("00-الكل", "Dubai Dentist - Dr. Lukman")));
check("غير مصنّف · ALL و«يحتاج مراجعة» عامّة", fallbackSector("uae-real-estate-companies-ALL", "x") !== null && fallbackSector("الإمارات-يحتاج-مراجعة", "x") !== null);
check("غير مصنّف · زبائن فلوريت يبقون", fallbackSector("مستخرج من واتساب - 3", "أم سعيد") === null && fallbackSector("من إعلان: دردش معنا", "Fatima") === null);

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
