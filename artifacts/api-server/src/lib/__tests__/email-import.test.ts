import { cleanRows, emailsIn, detectColumns } from "../email/importer";

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

// ── Pulling addresses out of one cell ────────────────────────────
check("عنوان واحد يُقرأ", emailsIn("info@x.ae").length === 1);
check("عنوانان بفاصلة — كانا يُرفضان معاً",
  emailsIn("contact@burj.ae, ceo@burj.ae").length === 2, "سبب ضياع شركة كاملة");
check("مفصولان بسطر", emailsIn("a@x.ae\nb@x.ae").length === 2);
check("مفصولان بشرطة مائلة", emailsIn("a@x.ae / b@x.ae").length === 2);
check("mailto: يُنظَّف", emailsIn("mailto:ops@x.ae")[0] === "ops@x.ae");
check("الحروف الكبيرة تُوحَّد", emailsIn("INFO@X.AE")[0] === "info@x.ae");
check("التكرار داخل الخلية يُحذف", emailsIn("a@x.ae, A@X.AE").length === 1);
check("النص بلا بريد لا يُنتج شيئاً", emailsIn("شركة النور للعقارات").length === 0);
check("الأرقام ليست بريداً", emailsIn("0501234567").length === 0);

// ── A file as it actually arrives ────────────────────────────────
const rows = [
  { "اسم الشركة": "النور", "الهاتف": "0501234567", "البريد": "info@alnoor.ae", "Email 2": "sales@alnoor.ae", "المدينة": "دبي" },
  { "اسم الشركة": "برج الخليج", "الهاتف": "971502223344", "البريد": "contact@burj.ae, ceo@burj.ae", "Email 2": "", "المدينة": "دبي" },
  { "اسم الشركة": "دار السلام", "الهاتف": "0559876543", "البريد": "", "Email 2": "", "المدينة": "أبوظبي" },
  { "اسم الشركة": "الواحة", "الهاتف": "", "البريد": "INFO@alwaha.AE ", "Email 2": "info@alwaha.ae", "المدينة": "الشارقة" },
];
const r = cleanRows(rows);

// Five, not six: الواحة carries the same address in both columns and it is
// deduplicated to one. The old reader produced three from this file.
check("كل العناوين تُستخرج لا الأول فقط", r.kept === 5, `${r.kept} — كان ٣`);
check("عمود البريد الثاني يُقرأ", r.rows.some((x) => x.email === "sales@alnoor.ae"));
check("خلية فيها عنوانان تُفكّ", r.rows.filter((x) => x.company === "برج الخليج").length === 2);
check("ولا تضيع الشركة معها", r.rows.some((x) => x.company === "برج الخليج"));
check("كل عنوان مقرون بشركته",
  r.rows.every((x) => !!x.company), "هذا ما طلبه صاحب العمل");
check("التكرار عبر الصفوف يُحذف مرة واحدة",
  r.rows.filter((x) => x.email === "info@alwaha.ae").length === 1);

// The row that used to vanish.
check("صف بهاتف بلا بريد لا يُحذف", r.phoneOnly.length === 1, "يُعرض على واتساب");
check("...ومعه اسم شركته", r.phoneOnly[0]?.company === "دار السلام");
check("...ورقمه", r.phoneOnly[0]?.phone === "0559876543");
check("ولا يُعدّ خطأ", r.invalid === 0);
check("والعناوين الإضافية تُحصى", r.extraAddresses === 2, `${r.extraAddresses}`);

// Only the first address on a line carries the person — the second is the
// company's, and labelling it with that person's name would be wrong.
const named = cleanRows([{ company: "ش", person: "أحمد", email: "a@x.ae", e2: "b@x.ae" }]);
check("الاسم يلزم العنوان الأول فقط",
  named.rows[0]?.name === "أحمد" && named.rows[1]?.name === undefined);

// ── Columns ──────────────────────────────────────────────────────
const cols = detectColumns(rows);
check("عمود الشركة يُكتشف بالعربية", cols.company === "اسم الشركة");
check("وعمود الهاتف لا يُخلط بالبريد", cols.phone === "الهاتف" && cols.email === "البريد");

// A file with no headers at all, which is half of them.
const bare = [{ a: "شركة أ", b: "x@a.ae", c: "0501111111" }, { a: "شركة ب", b: "y@b.ae", c: "0502222222" }];
check("ملف بلا ترويسات يُفهم من شكل القيم",
  detectColumns(bare).email === "b" && detectColumns(bare).phone === "c");

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
