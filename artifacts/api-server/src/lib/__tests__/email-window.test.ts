// نافذة البريد: أيام العمل وساعاتها بتوقيت دبي، وعنوانٌ واحد لكل شركة في الموجة. Pure — بلا قاعدة.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { isEmailSendingTime, emailWindowNote, dayHourInSendingTz, EMAIL_DAYS, EMAIL_HOUR_START, EMAIL_HOUR_END, EMAIL_FRIDAY_END } = await import("../sending-hours");
const { onePerCompany, companyGapClause, COMPANY_GAP_DAYS } = await import("../email/service");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

check("الافتراضات: الإثنين–الجمعة ٨–١٧، الجمعة ١٢", EMAIL_DAYS.join() === "1,2,3,4,5" && EMAIL_HOUR_START === 8 && EMAIL_HOUR_END === 17 && EMAIL_FRIDAY_END === 12);

const at = (iso: string) => new Date(iso);
const dh = dayHourInSendingTz(at("2026-11-07T06:00:00Z"));
check("تحويل دبي: السبت ٠٦Z = السبت ١٠", dh.day === 6 && dh.hour === 10, JSON.stringify(dh));
check("السبت ١٠:٠٠ دبي → لا", isEmailSendingTime(at("2026-11-07T06:00:00Z")) === false);
check("الأحد ١٠:٠٠ دبي → لا", isEmailSendingTime(at("2026-11-08T06:00:00Z")) === false);
check("الثلاثاء ١٠:٠٠ دبي → نعم", isEmailSendingTime(at("2026-11-03T06:00:00Z")) === true);
check("الثلاثاء ١٨:٣٠ دبي → لا", isEmailSendingTime(at("2026-11-03T14:30:00Z")) === false);
check("الثلاثاء ٠٧:٥٩ دبي → لا", isEmailSendingTime(at("2026-11-03T03:59:00Z")) === false);
check("الثلاثاء ٠٨:٠٠ دبي → نعم", isEmailSendingTime(at("2026-11-03T04:00:00Z")) === true);
check("الثلاثاء ١٦:٥٩ دبي → نعم", isEmailSendingTime(at("2026-11-03T12:59:00Z")) === true);
check("الثلاثاء ١٧:٠٠ دبي → لا", isEmailSendingTime(at("2026-11-03T13:00:00Z")) === false);
check("الجمعة ٠٩:٠٠ دبي → نعم", isEmailSendingTime(at("2026-11-06T05:00:00Z")) === true);
check("الجمعة ١٣:٠٠ دبي → لا", isEmailSendingTime(at("2026-11-06T09:00:00Z")) === false);
// منتصف الليل بتوقيت UTC هو ٠٤:٠٠ دبي من اليوم التالي: اليوم يُحسب في دبي لا في UTC.
check("الخميس ٢٣Z = الجمعة ٠٣ دبي → لا", isEmailSendingTime(at("2026-11-05T23:00:00Z")) === false);
check("الجمعة ٠٤Z = الجمعة ٠٨ دبي → نعم", isEmailSendingTime(at("2026-11-06T04:00:00Z")) === true);

const note = emailWindowNote(at("2026-11-07T06:00:00Z"));
check("السطر العربي خارج النافذة", note.startsWith("خارج نافذة البريد") && note.includes("الإثنين–الخميس ٨–١٧") && note.includes("الجمعة ٨–١٢") && note.includes("دبي"), note);
check("السطر العربي داخلها", emailWindowNote(at("2026-11-03T06:00:00Z")).startsWith("داخل نافذة البريد"));

// ── عنوانٌ واحد لكل شركة ──
const c = (email: string) => ({ email });
const r = onePerCompany([c("ahmed@acme.ae"), c("info@acme.ae"), c("sara@acme.ae"), c("x@gmail.com"), c("y@gmail.com"), c("hello@beta.com")]);
check("عنوان الدور يُفضَّل على الشخصي", r.kept.map((x) => x.email).includes("info@acme.ae") && !r.kept.some((x) => x.email === "ahmed@acme.ae" || x.email === "sara@acme.ae"));
check("البريد الحر معفى كله", r.kept.filter((x) => x.email.endsWith("@gmail.com")).length === 2);
check("الباقون يُعدّون متخطَّين", r.dropped === 2 && r.kept.length === 4, `${r.dropped}/${r.kept.length}`);
check("الترتيب الأصلي محفوظ", r.kept.map((x) => x.email).join() === "info@acme.ae,x@gmail.com,y@gmail.com,hello@beta.com", r.kept.map((x) => x.email).join());
const r2 = onePerCompany([c("ali@acme.ae"), c("omar@acme.ae")]);
check("بلا عنوان دور: الأول في الترتيب", r2.kept.length === 1 && r2.kept[0]!.email === "ali@acme.ae");
check("قائمة فارغة", onePerCompany([]).kept.length === 0);

// ── شرط فاصل الشركة ──
const { sql } = await import("drizzle-orm");
const { PgDialect } = await import("drizzle-orm/pg-core");
const q = new PgDialect().sqlToQuery(companyGapClause(sql.raw("m.contact_id")));
check("فاصل الشركة خمسة أيام", COMPANY_GAP_DAYS === 5);
check("الشرط يقارن النطاق ويستثني البريد الحر", /split_part\(c2\.email, '@', 2\)/.test(q.sql) && /not in \(/.test(q.sql) && q.params.includes("gmail.com") && q.params.includes("emirates.net.ae"));
check("ويقيس last_sent_at", /c2\.last_sent_at > now\(\) - make_interval/.test(q.sql));

console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
