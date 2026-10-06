import * as XLSX from "xlsx";
import { normalizePhone, phonesInCell, headerField, readWorkbook, readText, mapColumns, parseTables, whatsappEntries, countryOf } from "../phone-import";

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };
const e = (raw: unknown, c = "AE") => normalizePhone(raw, c)?.e164 ?? null;
const mob = (raw: unknown, c = "AE") => normalizePhone(raw, c)?.mobile ?? null;

// ── One number ───────────────────────────────────────────────────
check("UAE local with zero", e("050 123 4567") === "971501234567");
check("UAE local without zero", e("501234567") === "971501234567");
check("UAE international forms", e("+971 50 123 4567") === "971501234567" && e("00971501234567") === "971501234567" && e("971-50-123-4567") === "971501234567");
check("+971 0 50… with the stray zero", e("+971 050 1234567") === "971501234567");
check("a number cell that lost its zero", e(501234567) === "971501234567");
check("a number cell with the country code", e(971501234567) === "971501234567");
check("Arabic-Indic digits", e("٠٥٠١٢٣٤٥٦٧") === "971501234567");
check("UAE mobile vs landline", mob("0501234567") === true && mob("04 123 4567") === false);
check("UAE landline is kept as a number", e("04 123 4567") === "97141234567");

// The fault that sent Saudi numbers to the UAE.
check("a Saudi local number under a Saudi default", e("0551234567", "SA") === "966551234567");
check("...is a mobile", mob("0551234567", "SA") === true);
check("Saudi international", e("+966 55 123 4567") === "966551234567");
check("a Saudi landline", mob("011 234 5678", "SA") === false);

check("Qatar", e("+974 5512 3456") === "97455123456" && mob("+974 5512 3456") === true);
check("Kuwait", e("+965 9123 4567") === "96591234567");
check("Egypt mobile", e("+20 100 123 4567") === "201001234567" && mob("+20 100 123 4567") === true);
check("an unknown country is kept with mobility unknown", normalizePhone("+49 1512 3456789")?.mobile === null && e("+49 1512 3456789") === "4915123456789");
check("scientific notation is refused, not guessed", e("9.71501E+11") === null);
check("too short is refused", e("12345") === null);
check("empty is refused", e("") === null && e(null) === null);

// ── A cell with several ──────────────────────────────────────────
const two = phonesInCell("050 123 4567 / 04 123 4567");
check("two numbers split on a slash", two.length === 2 && two[0]!.mobile === true && two[1]!.mobile === false, two.map((p) => p.e164).join(","));
check("labelled numbers in one cell", phonesInCell("Tel: 04 123 4567, Mob: 055 765 4321").map((p) => p.e164).join(",") === "97141234567,971557654321");
check("two mobiles run together with spaces", phonesInCell("0501234567 0557654321").length === 2);
check("a number cell", phonesInCell(971501234567).length === 1);

// ── Headers ──────────────────────────────────────────────────────
check("'Company Name' is the company", headerField("Company Name") === "company");
check("'اسم الشركة التجارية' is the company", headerField("اسم الشركة التجارية") === "company");
check("'اسم الشركة' is the company, not the person", headerField("اسم الشركة") === "company");
check("'Mobile No.' is a mobile", headerField("Mobile No.") === "mobile");
check("'رقم الجوال' is a mobile", headerField("رقم الجوال") === "mobile");
check("'WhatsApp' is WhatsApp", headerField("WhatsApp Number") === "whatsapp");
check("'Fax' is never a phone", headerField("Fax") === "fax");
check("'Email Address' is the email", headerField("Email Address") === "email");
check("'الاسم' is a person", headerField("الاسم") === "person");
check("'Emirate' is the city", headerField("Emirate") === "city");
check("country from a city", countryOf("Riyadh") === "SA" && countryOf("دبي") === "AE" && countryOf("الدوحة") === "QA");

// ── A realistic, messy workbook ──────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["تقرير الشركات — سبتمبر"],
  [],
  ["#", "Company Name", "Contact Person", "Phone", "Mobile", "Fax", "Email", "City"],
  [1, "Al Noor Contracting LLC", "Ahmed", "04 123 4567", "050 111 2222", "04 999 8888", "info@alnoor.ae", "Dubai"],
  [2, "Riyadh Trading Co", "Khalid", "011 234 5678", "0551234567", "", "k@rtc.sa", "Riyadh"],
  [3, "Landline Only Est", "Omar", "06 555 4444", "", "", "o@land.ae", "Sharjah"],
  [4, "Al Noor Branch", "Sara", "", "050 111 2222", "", "s@alnoor.ae", "Dubai"],
  [5, "No Number Co", "", "", "", "", "x@nonum.ae", "Ajman"],
]), "Sheet1");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
  ["اسم المنشأة", "رقم الجوال / الهاتف", "الإمارة"],
  ["مؤسسة الخليج", "0507778888 / 04 222 3333", "دبي"],
  ["شركة الواحة", "٠٥٥٦٦٦٧٧٧٧", "العين"],
]), "الورقة الثانية");
const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

const tables = readWorkbook(buf);
check("every sheet is read", tables.length === 2);
check("the header row is found under a title", tables[0]!.headers.includes("Company Name"), tables[0]!.headers.join("|"));
const m = mapColumns(tables[0]!);
check("mobile column ranks before the phone column", tables[0]!.headers[m.phones[0]!] === "Mobile", m.labels["phones"]);
check("fax is not a phone column", !m.phones.some((i) => tables[0]!.headers[i] === "Fax"));
check("company and email columns found", tables[0]!.headers[m.company!] === "Company Name" && tables[0]!.headers[m.email!] === "Email");

const rep = parseTables(tables, "AE");
check("all non-empty rows are read", rep.total === 7, `${rep.total}`);
const riyadh = rep.rows.find((r) => r.company === "Riyadh Trading Co")!;
check("a Riyadh row gets a Saudi number despite the UAE default", riyadh.whatsapp?.e164 === "966551234567", riyadh.whatsapp?.e164);
const noor = rep.rows.find((r) => r.company === "Al Noor Contracting LLC")!;
check("the mobile is chosen over the office line", noor.whatsapp?.e164 === "971501112222");
check("the email is read", noor.email === "info@alnoor.ae");
check("a landline-only row has no WhatsApp number", rep.rows.find((r) => r.company === "Landline Only Est")!.whatsapp === null);
check("Arabic sheet: mobile out of a mixed cell", rep.rows.find((r) => r.company === "مؤسسة الخليج")!.whatsapp?.e164 === "971507778888");
check("Arabic sheet: Arabic-Indic digits", rep.rows.find((r) => r.company === "شركة الواحة")!.whatsapp?.e164 === "971556667777");
check("counts: 5 with WhatsApp, 1 landline only, 1 with none", rep.withWhatsapp === 5 && rep.landlineOnly === 1 && rep.noNumber === 1, `${rep.withWhatsapp}/${rep.landlineOnly}/${rep.noNumber}`);

const wa = whatsappEntries(rep.rows);
check("the same mobile twice is saved once", wa.entries.length === 4 && wa.duplicates === 1, `${wa.entries.length}/${wa.duplicates}`);
check("saved under the company name", wa.entries.find((x) => x.phone === "971501112222")?.name === "Al Noor Contracting LLC");
check("landlines skipped and counted", wa.skippedLandline === 1);
check("landlines kept when asked", whatsappEntries(rep.rows, { mobileOnly: false }).entries.length === 5);

// ── A headerless list ────────────────────────────────────────────
const bare = parseTables([{ sheet: "s", headers: [], rows: [["Blue Sky Travel", "0501234567"], ["Sun Cafe", "0559876543"], ["Star Motors", "0521112233"]] }]);
check("no headers: the company and the number by their values", bare.rows[0]!.company === "Blue Sky Travel" && bare.rows[0]!.whatsapp?.e164 === "971501234567");

// ── Pasted text ──────────────────────────────────────────────────
const pasted = parseTables(readText("Blue Sky Travel\t0501234567\nSun Cafe\t055 987 6543\n0521112233"));
check("pasted tab-separated name and number", pasted.rows[0]!.company === "Blue Sky Travel" && pasted.withWhatsapp === 3);

// ── Size ─────────────────────────────────────────────────────────
const big = [["Company", "Mobile"], ...Array.from({ length: 50_000 }, (_, i) => [`Co ${i}`, `05${String(i % 10).padStart(1)}${String(1_000_000 + i).slice(-7)}`])];
const bigWb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(bigWb, XLSX.utils.aoa_to_sheet(big), "big");
const t0 = Date.now();
const bigRep = parseTables(readWorkbook(XLSX.write(bigWb, { type: "buffer", bookType: "xlsx" }) as Buffer));
const ms = Date.now() - t0;
check("50,000 rows are read", bigRep.total === 50_000 && bigRep.withWhatsapp === 50_000, `${bigRep.withWhatsapp}`);
check("...in a few seconds", ms < 15_000, `${ms} ms`);

// ── A directory export with links beside the numbers ──
// The file that put 623 Facebook page ids into a list as phones: the social
// column's header said «التواصل», which read as a phone column, and the digits
// in the link were taken as a number.
check("a column of social accounts is never a phone column", headerField("حسابات التواصل") === "skip" && headerField("جاهز للتواصل") === "skip");
check("...while «رقم التواصل» still is", headerField("رقم التواصل") === "phone" && headerField("التصنيف") === "industry");
check("«الجهة» is the company", headerField("الجهة") === "company");
check("digits inside a link are not a number", phonesInCell("https://www.facebook.com/427946550588719").length === 0 && phonesInCell("www.instagram.com/971501234567").length === 0);
check("...nor inside an email or a coordinate", phonesInCell("info971501234567@x.ae").length === 0 && phonesInCell("24.97241973876953,55.17534255981445").length === 0);
check("...while a number beside a link is still found", phonesInCell("Tel 050 123 4567 · site www.x.ae")[0]?.e164 === "971501234567");
const dir = readText([
  "البريد\tالجهة\tالهاتف\tواتساب\tالموقع\tالمدينة\tحسابات التواصل",
  "-\tMills Bowley Concrete\t+97148854549\t\t\tدبي\thttps://www.facebook.com/427946550588719",
  "a@b.ae\tDigital Home\t+971561235179\t\thttp://dh.ae\tدبي\thttps://www.facebook.com/105056307532897",
  "-\tAl Etlala\t+97143334444\t+971566664999\twww.etlala.ae\tدبي\t",
].join("\n"));
const dirRep = parseTables(dir, "AE");
const dirWa = whatsappEntries(dirRep.rows, {});
check("from such a file only real mobiles are taken", dirWa.entries.map((e) => e.phone).join(",") === "971561235179,971566664999", dirWa.entries.map((e) => e.phone).join(","));
check("...each under its company, not its link", dirWa.entries[0]?.name === "Digital Home" && dirRep.sheets[0]!.columns["company"] === "الجهة");
check("...and the website column is not the city", dirRep.sheets[0]!.columns["city"] === "المدينة");

// ── Only WhatsApp-shaped numbers, from the row's own country ──
check("a UAE toll-free number is not a number in some unknown country", normalizePhone("+9718001599") === null && normalizePhone("+97180023726427") === null);
check("...nor a UAE landline of the wrong length", normalizePhone("+9717136624") === null);
check("a UK mobile is recognised as one", normalizePhone("+447360247692")?.mobile === true && normalizePhone("+442039660128")?.mobile === false);
const mixed = readText(["الجهة\tالهاتف\tالدولة", "Elithair Dubai\t+447360247692\tالإمارات", "Digital Home\t+971561235179\tالإمارات", "Heidrick\t+12023314900\tالإمارات"].join("\n"));
const mixedRows = parseTables(mixed, "AE").rows;
const home = whatsappEntries(mixedRows, {});
check("a UAE list keeps UAE mobiles only", home.entries.map((e) => e.phone).join(",") === "971561235179" && home.skippedForeign === 2, `${home.entries.map((e) => e.phone)} / ${home.skippedForeign}`);
check("...unless the owner allows other countries", whatsappEntries(mixedRows, { foreign: true }).entries.length === 3);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
