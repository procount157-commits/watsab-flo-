// صفحة التشغيل، والنفق، والخطّاف — دوالّ صِرفة. كل حالةٍ هنا من طلب
// صاحب العمل («أرفع مجلدات مسمّاة»، «الفتح صفر») أو مما وقع فعلاً.

export {};
const A = await import("../email/auto-desk");
const U = await import("../email/public-url");
const { toHtml } = await import("../email/agent");
const L = await import("../email/layout");
const T = await import("../email/tracking");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(62)} ${d}`); };

// ── اسم المجلد ← القطاع ← هل يُراسَل ──
check("مجلد · عقارات مستهدف بالمسارين", A.mapFolder("عقارات").targeted && A.mapFolder("عقارات").tracks.length === 2);
check("مجلد · ذهب ← ذهب ومجوهرات (AML)", A.mapFolder("ذهب").sector === "ذهب ومجوهرات" && A.mapFolder("ذهب").targeted);
check("مجلد · محاماة ← قانونية مستهدفة", A.mapFolder("مكاتب محاماة").sector === "قانونية" && A.mapFolder("مكاتب محاماة").targeted);
check("مجلد · مقاولات مستهدفة (خدمات)", A.mapFolder("مقاولات").targeted);
check("مجلد · اسمٌ مجهول لا يُفرض قطاعاً", A.mapFolder("ملفات قديمة").sector === null && !A.mapFolder("ملفات قديمة").targeted);
check("مجلد · قطاعٌ غير مستهدف يُقال صراحة", !A.mapFolder("تقنية").targeted && /غير مستهدف/.test(A.mapFolder("تقنية").note));

// ── هدف هذا الشهر ──
const eom = A.endOfMonthUae(new Date("2026-10-14T08:00:00Z"));
check("هدف · ينتهي آخر أكتوبر بتوقيت الإمارات", eom.toISOString() === "2026-10-31T19:59:59.999Z", eom.toISOString());
const late = A.endOfMonthUae(new Date("2026-10-30T12:00:00Z"));
check("هدف · في آخر يومين يُعطى للشهر القادم", late.toISOString() === "2026-11-30T19:59:59.999Z", late.toISOString());

// ── عنوان النفق: البكسل نعم، الروابط لا ──
check("نفق · trycloudflare مؤقّت", U.isEphemeral("https://principal-auditor-saw-distant.trycloudflare.com"));
check("نفق · ngrok مؤقّت", U.isEphemeral("https://ab12.ngrok-free.app"));
check("نفق · نطاق الشركة دائم", !U.isEphemeral("https://app.pro-count.ae") && U.durable("https://app.pro-count.ae") === "https://app.pro-count.ae");
check("نفق · المؤقّت لا يُكتب في رابطٍ يبقى", U.durable("https://x.trycloudflare.com") === "");

// ── الخطّاف في الرسالة ──
const body = toHtml("[معاينة] One question decides your next inspection\n[عنوان كبير] Is {{company|your agency}} inspection-ready?\nHello {{first_name|there}},\n\n[ملخص] The summary.\n\n[زر] Check my gaps\n\n[إبراز] A real fact from the knowledge.");
check("خطّاف · المعاينة مخفية في الجسم", /<p class="pre" style="display:none/.test(body));
check("خطّاف · العنوان الكبير h2", /<h2 class="hook">Is \{\{company/.test(body));
check("خطّاف · الإبراز صندوق", /<div class="note">A real fact/.test(body));
check("خطّاف · المعاينة هي preheader", L.preheaderOf(body) === "One question decides your next inspection", L.preheaderOf(body));
check("خطّاف · بلا معاينة: لا يُؤخذ العنوان الكبير", !/inspection-ready/.test(L.preheaderOf(body.replace(/<p class="pre"[\s\S]*?<\/p>/, ""))));
const brand = L.brandOf({ layout: "branded", brandName: "PRO COUNT", brandColor: "#111c33", brandAccent: "#0284c7", fromName: "Pro Count" });
const r = T.renderEmail(body.replace('href="#cta"', 'href="https://pro-count.ae"'), { company: "Evoke" }, { base: "https://x.trycloudflare.com", token: "TK", secret: "s", pixel: true, links: false }, { base: "", token: "TK", fromName: "Pro Count", fromEmail: "info@pro-count.ae" }, brand);
check("رسالة · المعاينة مرّة واحدة لا مرّتين", (r.html.match(/One question decides/g) ?? []).length === 1);
check("رسالة · النص العادي بلا معاينة", !/One question/.test(r.text) && /Evoke inspection-ready/.test(r.text));
check("رسالة · بكسل عبر النفق", r.html.includes("https://x.trycloudflare.com/t/e/TK.gif"));
check("رسالة · الروابط لا تُلفّ عبر النفق", !r.html.includes("/t/e/TK/c") && r.html.includes('href="https://pro-count.ae"'));
check("رسالة · الإلغاء بريدٌ لا رابط نفق", r.html.includes("mailto:info@pro-count.ae?subject=unsubscribe"));
check("رسالة · الإبراز بلون العلامة", r.html.includes(L.tint("#0284c7", 0.9)));
check("لون · tint يمزج نحو الأبيض", L.tint("#000000", 0.5) === "#808080" && L.tint("bad", 0.5) === "#f1f5f9");

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
