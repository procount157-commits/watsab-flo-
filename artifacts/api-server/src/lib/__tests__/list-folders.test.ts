// كل قائمة واتساب في مجلد: القرار من القائمة نفسها. دوالّ صِرفة، بأسماء القوائم الحقيقية.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { folderFor, batchName, FROM_ADS, FROM_WHATSAPP, OTHER } = await import("../folders");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(54)} ${d}`); };

check("دفعة · الرقم في الآخر يسقط", batchName("مستخرج من واتساب - 7") === "مستخرج من واتساب");
check("دفعة · (2) يسقط", batchName("Dubai list (2)") === "Dubai list");
check("دفعة · التاريخ يسقط", batchName("عملاء المعرض 2026-10-11") === "عملاء المعرض");
check("دفعة · اسم بلا رقم يبقى", batchName("استشارات هندسيه") === "استشارات هندسيه");

const f = (name: string, segment: string | null = null, sib = 1, member: string | null = null) => folderFor({ name, segment }, sib, member);
check("مفروز — مقاولات ← مجلد القطاع", f("مفروز — مقاولات", "مقاولات").name === "مقاولات" && f("مفروز — مقاولات", "مقاولات").kind === "sector");
check("مفروز بلا segment ← من الاسم", f("مفروز — ذهب ومجوهرات").name === "ذهب ومجوهرات");
check("من إعلان ← عملاء الإعلانات", f("من إعلان: دردش معنا").name === FROM_ADS);
check("مستخرج من واتساب - 3 ← مجلد واحد", f("مستخرج من واتساب - 3", null, 13).name === FROM_WHATSAPP);
check("leads ليست إعلانات", f("Dubai leads", null, 1).name !== FROM_ADS, f("Dubai leads").name);
check("دفعة من اسمين ← مجلد باسمها", f("عملاء المعرض - 2", null, 2).name === "عملاء المعرض");
check("قائمة وحيدة بلا قطاع ← قوائم أخرى", f("قائمة جديدة", null, 1).name === OTHER);
check("قطاع أعضائها يغلب", f("قائمة جديدة", null, 1, "عقارات").name === "عقارات");
check("اسم يدل على قطاع", f("شركات مقاولات دبي").kind === "sector", f("شركات مقاولات دبي").name);
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
