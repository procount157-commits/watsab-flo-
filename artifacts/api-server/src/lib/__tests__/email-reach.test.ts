// فحص النص: ما يقرؤه المرشِّح قبل الإنسان. ولا واحدة من هذه القواعد
// «كلمة ممنوعة» — لا مرشِّح يرفض لكلمة. لكن اجتماع كلمات الإعلانات مع
// الروابط الكثيرة والصراخ هو ما يُصنِّف الرسالة، فتُعدّ كلٌّ وحدها.

export {};
const { contentSignals } = await import("../email/deliverability");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(56)} ${d}`); };
const of = (subj: string, html: string, id: string) => contentSignals(subj, html).find((c) => c.id === id)!;

const GOOD_BODY = `<p>Hello team,</p><p>Most real estate agencies we speak to focus on goAML registration, but inspectors require the complete framework: risk assessment, customer due diligence, beneficial ownership and training. Obligations depend on your activity and supervisory authority.</p><p><a href="https://wa.me/971542328336">Review your AML readiness</a></p><p>Best regards,<br>The Pro Count team</p>`;

check("نصٌّ سليم · الطول", of("Is your AML framework inspection-ready?", GOOD_BODY, "c_words").state === "ok");
check("نصٌّ سليم · الروابط", of("x", GOOD_BODY, "c_links").state === "ok");
check("نصٌّ سليم · بلا كلمات إعلانات", of("Is your AML framework inspection-ready?", GOOD_BODY, "c_spam").state === "ok");
check("نصٌّ سليم · بلا صراخ", of("Is your AML framework inspection-ready?", GOOD_BODY, "c_shout").state === "ok");

// الاختصارات المهنية ليست صراخاً: AML وVAT وMLRO تُكتب كبيرةً بطبيعتها،
// وفحصٌ يُنذر منها يُنذر من كل رسالةٍ تكتبها هذه الشركة.
check("الاختصارات المهنية ليست صراخاً",
  of("AML and VAT obligations for DNFBP under FTA", GOOD_BODY, "c_shout").state === "ok",
  of("AML VAT DNFBP FTA MLRO", GOOD_BODY, "c_shout").detail);

check("صراخٌ حقيقي يُرصد",
  of("URGENT LIMITED OFFER INSIDE", GOOD_BODY, "c_shout").state === "warn");
check("علامة التعجّب في العنوان تُرصد",
  of("Your AML framework!", GOOD_BODY, "c_shout").state === "warn");

const SPAMMY = `<p>FREE audit, 100% free, guaranteed results. Act now — limited time! Click here to buy now.</p>`;
check("كلمات الإعلانات تُرصد وتُعدّ", of("Act now — free!", SPAMMY, "c_spam").state === "fail",
  of("Act now — free!", SPAMMY, "c_spam").detail.slice(0, 50));
check("وبالعربية أيضاً",
  of("عرض محدود", `<p>اربح مجاناً — سارع، اضغط هنا واشتر الآن بخصم هائل بدون التزام.</p>`, "c_spam").state === "fail");

const MANY_LINKS = `<p>${"<a href='https://a.b'>x</a> ".repeat(9)}</p><p>${"word ".repeat(60)}</p>`;
check("الروابط الكثيرة تُرصد", of("x", MANY_LINKS, "c_links").state === "warn",
  of("x", MANY_LINKS, "c_links").detail);

check("رسالةٌ كلها صورة تُرصد",
  of("x", `<p><img src="a.png"><img src="b.png"></p><p>short</p>`, "c_img").state === "warn");
check("صورةُ توقيعٍ مع نصٍّ كافٍ لا تُرصد",
  of("x", `<p>${"word ".repeat(80)}</p><img src="sig.png">`, "c_img").state === "ok");
check("نصٌّ قصير جداً يُرصد", of("x", "<p>Hi</p>", "c_words").state === "warn");

// لكل ملاحظةٍ أثرٌ مكتوب وإصلاح — لا تصنيفٌ معلّق في الهواء.
const all = contentSignals("Act now!", SPAMMY);
check("لكل ملاحظة أثرٌ وإصلاح",
  all.filter((c) => c.state !== "ok").every((c) => (c.why?.length ?? 0) > 20 && (c.fix?.length ?? 0) > 15),
  `${all.filter((c) => c.state !== "ok").length} ملاحظة`);
check("ولكل بندٍ وزن", all.every((c) => c.weight > 0));

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
