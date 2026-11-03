// خارج المكتب: متى يعود. التاريخ يُقرأ من نص الرد الآلي بصيغه الكثيرة،
// والمهلة تُبنى عليه — لا تصله المتابعة وهو غائب.

export {};
const { oooReturnDate } = await import("../email/inbound");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };
const now = new Date(2026, 10, 3, 10);   // 3 نوفمبر 2026
const ymd = (d: Date | null) => d ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : "null";
const is = (name: string, text: string, want: string) => { const got = ymd(oooReturnDate(text, now)); check(name, got === want, got); };

is("back on 12 November", "I am out of the office and will be back on 12 November.", "2026-11-12");
is("return on 12/11 (يوم/شهر)", "I will return on 12/11 and respond then.", "2026-11-12");
is("until 15 Nov", "I'm on annual leave until 15 Nov with limited access to email.", "2026-11-15");
is("ISO", "Out of office until 2026-11-20.", "2026-11-20");
is("November 18th, 2026", "I will be returning to the office on November 18th, 2026.", "2026-11-18");
is("من … إلى … (الثاني هو العودة)", "أنا في إجازة من 1 نوفمبر إلى 10 نوفمبر، وسأرد عند عودتي.", "2026-11-10");
is("from 1/11 to 9/11", "I am away from 1/11 to 9/11.", "2026-11-9");
is("أرقام مشرقية", "خارج المكتب حتى ١٦ نوفمبر.", "2026-11-16");
is("السنة القادمة ضمناً (يناير)", "I'm away until 5 January.", "2027-1-5");
is("back on Monday ← أقرب اثنين", "I'm out today, back on Monday.", "2026-11-9");
is("لا تاريخ", "I am currently out of the office with limited access.", "null");
is("تاريخٌ بعيد جداً لا يُصدَّق إجازةً", "Back on 2027-09-01.", "null");
is("ليس رقم هاتف", "Call +971 50 123 4567 for urgent matters.", "null");

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
