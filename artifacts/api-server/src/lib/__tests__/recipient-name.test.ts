// The customer's company in a WhatsApp message: cleaned of its legal suffix
// and its shouting, cut to the half in the message's language, with a fallback
// for a number saved without a name — and the bar of that fallback not taken
// for spintax.

export {};
const { displayCompany, fillRecipient, languageOfText, variesPerRecipient } = await import("../recipient-name");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

check("a shouted legal name reads as a person writes it", displayCompany("RENDEZVOUS REAL ESTATE BROKER L.L.C") === "Rendezvous Real Estate Broker");
const both = "الاطلالة للمقاولات العامة Al Etlala General Contracting";
check("a bilingual name gives the Arabic half to an Arabic message", displayCompany(both, "ar") === "الاطلالة للمقاولات العامة", displayCompany(both, "ar"));
check("...and the English half to an English one", displayCompany(both, "en") === "Al Etlala General Contracting", displayCompany(both, "en"));
check("an Arabic legal form is dropped", displayCompany("شركة النور للمقاولات ذ.م.م", "ar") === "شركة النور للمقاولات" && displayCompany("مؤسسة الريان ش.ذ.م.م", "ar") === "مؤسسة الريان");
check("an English-only name still serves an Arabic message", displayCompany("Arcadia Properties", "ar") === "Arcadia Properties");
check("a phone saved as the name is no name", displayCompany("+971 50 123 4567") === "");
check("a very long name is cut at a word", displayCompany("Al Mansoori International General Trading and Contracting Company for Building Materials", "en").length <= 48);

check("the message's language is read from its letters", languageOfText("هلا فريق {اسم_الشركة}") === "ar" && languageOfText("Hi {client} team") === "en");
check("the company goes into the message", fillRecipient("هلا فريق {اسم_الشركة|شركتكم}، عندي سؤال", "WEST LEGEND REAL ESTATE BROKERS L.L.C") === "هلا فريق West Legend Real Estate Brokers، عندي سؤال");
check("...in the message's language", fillRecipient("Hi {اسم_الشركة|there} team", both) === "Hi Al Etlala General Contracting team");
check("no name: the fallback speaks", fillRecipient("هلا فريق {اسم_الشركة|شركتكم}", null) === "هلا فريق شركتكم");
check("no name and no fallback: nothing, not the tag", fillRecipient("هلا {اسم_الشركة}", "") === "هلا ");
check("{الاسم|…} takes a fallback too", fillRecipient("مرحباً {الاسم|أخي}", null) === "مرحباً أخي");
check("spintax is left for later, untouched", fillRecipient("{مرحباً|هلا} {اسم_الشركة|شركتكم}", "Arcadia Properties") === "{مرحباً|هلا} Arcadia Properties");

check("a message with the company varies per recipient", variesPerRecipient("هلا {اسم_الشركة|شركتكم}"));
check("one with only fixed words does not", !variesPerRecipient("مرحباً، عندنا عرض على خدمات المحاسبة"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
