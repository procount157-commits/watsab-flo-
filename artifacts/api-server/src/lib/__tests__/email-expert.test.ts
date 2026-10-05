// The email team as experts, and English as the language the firm sends in:
// the doctrine says so and no longer caps follow-ups at three; the plain
// layout of an English email is English and left-to-right; every writer
// carries the anatomy of an English B2B email; WhatsApp's two-line skill is
// taken back from the email writers; and the intensive path is the default.

const { EMAIL_DOCTRINE, EMAIL_TEAM_DEFS } = await import("../email/team");
const { GRANTS, WITHDRAWN, LIBRARY } = await import("../skills");
const { renderEmail } = await import("../email/tracking");
const { INTENSITY, asIntensity } = await import("../email/intensity");
const { asLanguage, matchesLanguage } = await import("../email/language");
const { register } = await import("../email/register");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(62)} ${d}`); };

check("the doctrine makes English the sending language", /بالإنجليزية/.test(EMAIL_DOCTRINE) && /لا تغيّرها إلا/.test(EMAIL_DOCTRINE));
check("...with no three-message cap left over", !/ثلاث رسائل/.test(EMAIL_DOCTRINE));
check("...and English fallbacks for the company name", EMAIL_DOCTRINE.includes("{{company|your company}}") && !EMAIL_DOCTRINE.includes("{{company|شركتكم}}"));
check("no team member's brief keeps the old cap", EMAIL_TEAM_DEFS.every((d) => ![d.persona, ...d.tasks].some((t) => /ثلاث رسائل/.test(t))));
check("the reply is judged on replies, not opens", /Apple Mail/.test(EMAIL_DOCTRINE));

const writers = ["email", "email_followup", "email_replies", "email_creator", "email_guard"];
check("every writer and the guard carry the English B2B anatomy", writers.every((r) => GRANTS[r]!.includes("تشريح رسالة B2B بالإنجليزية")));
check("the strategist knows UAE timing and measurement", ["التوقيت والتقسيم لسوق الإمارات", "قياس البريد واختبار العناوين"].every((s) => GRANTS["email_strategist"]!.includes(s)));
check("WhatsApp's two-line skill is no longer granted to email writers", ["email", "email_replies", "email_creator"].every((r) => !GRANTS[r]!.includes("الكتابة البشرية")));
check("...and is withdrawn where it was", ["email", "email_replies", "email_creator"].every((r) => WITHDRAWN[r]!.includes("الكتابة البشرية")));
check("the groups agent carries her own skill", GRANTS["groups"]!.includes("الرد في قروبات العملاء"));
check("every granted skill exists in the library", Object.values(GRANTS).flat().every((n) => LIBRARY.some((s) => s.name === n)));

check("intense is the default path", asIntensity(undefined) === "intense" && asIntensity("nonsense") === "intense");
check("...six touches over three weeks", INTENSITY.intense.steps.length === 4 && INTENSITY.intense.steps.at(-1)!.day === 21, INTENSITY.intense.steps.map((s) => s.day).join(","));
check("a language not given is English", asLanguage(undefined) === "en" && asLanguage("ar") === "ar");
check("Arabic content does not pass as English", !matchesLanguage("<p>مرحباً فريق الشركة، نود أن نعرض عليكم خدماتنا</p>", "en"));

const foot = { base: "", token: "t", fromName: "Pro Count", fromEmail: "info@pro-count.ae" };
const track = { base: "", token: "t", tracking: false } as any;
const en = renderEmail("<p>Hi there,</p><p>Your books may be behind.</p>", {}, track, foot).html;
check("a plain English email is English and left-to-right", /<html dir="ltr" lang="en">/.test(en), en.slice(0, 50));
check("...with an English footer only", /Unsubscribe/.test(en) && !/إلغاء الاشتراك/.test(en));
const ar = renderEmail("<p>مرحباً فريق شركة النور، دفاتركم قد تكون متأخرة.</p>", {}, track, foot).html;
check("an Arabic one keeps right-to-left and both footers", /dir="rtl" lang="ar"/.test(ar) && /إلغاء الاشتراك/.test(ar) && /Unsubscribe/.test(ar));

const reg = await register(1, { status: "all", limit: 5 });
check("the sending register answers with rows and counts", Array.isArray(reg.rows) && typeof reg.counts === "object" && reg.limit === 5);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
