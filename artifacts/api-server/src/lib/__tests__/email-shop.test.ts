// Email for a shop: Gmail in one step, the shop's own voice, its pieces (2026-11-02). Pure.
import assert from "node:assert/strict";
const { shopDefaults, explainGmailError, GMAIL_CAPS } = await import("../email/quick-setup");
const { shopIssues, piecesHtml } = await import("../email/shop-writer");
const { isShop } = await import("../email/seed");
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };

const floret = { name: "فلوريت للذهب والمجوهرات (FLORET JEWELRY)", vertical: "jewelry", dialect: "gulf", catalog_source: "floret", description: null };
const d = shopDefaults(floret, "0509966221");
ok(d.fromName === "فلوريت للذهب والمجوهرات", "the sender is the shop's Arabic name, without the bracket");
ok(d.phone === "+971509966221", "a local mobile becomes the international number");
ok(d.defaultLanguage === "ar", "a Gulf shop writes Arabic");
ok(d.website === "floret-royal.io" && !!d.logoUrl?.endsWith("/apple-icon.png"), "the shop's site and its icon");
ok(shopDefaults({ name: "Pro Count", vertical: null, dialect: "en", catalog_source: null, description: null }, null).defaultLanguage === "en", "an English firm stays English");
ok(GMAIL_CAPS.dailyCap < 500, "under Gmail's own daily limit");

ok(/كلمة مرور التطبيق/.test(explainGmailError("Invalid login: 535-5.7.8 Username and Password not accepted")), "a refused login says to use the app password");
ok(/أعد المحاولة/.test(explainGmailError("connect ETIMEDOUT 142.250.1.1:465")), "a timeout says try again");

ok(isShop(floret) && isShop({ vertical: "jewelry" }) && !isShop({ vertical: null, catalog_source: null }) && !isShop(null), "a shop is a shop; the firm is not");

ok(shopIssues("طقم جديد بسعر مميز").length > 0, "a price word is refused");
ok(shopIssues("هلا وغلا بك").length > 0, "«هلا وغلا» is refused");
ok(shopIssues("حبيبتي شوفي الجديد").length > 0, "an endearment is refused");
ok(shopIssues("Check our new collection today").length > 0, "English in an Arabic email is refused");
ok(shopIssues("مساء الخير، نزلت تشكيلة جديدة: https://floret-royal.io {{first_name}} FLORET").length === 0, "a link, a merge field and the brand name pass");

const h = piecesHtml([{ name: "طقم الكلوفر", tagline: "وردات <مفرّغة>", url: "https://floret-royal.io/product/x", image: "https://floret-royal.io/media/a.jpg" }]);
ok(h.includes('class="pieces"') && h.includes("https://floret-royal.io/media/a.jpg") && h.includes("/product/x"), "a piece card has its photo and its page");
ok(h.includes("&lt;مفرّغة&gt;"), "the piece's words are escaped");
ok(piecesHtml([]) === "", "no pieces, no table");
console.log(`email-shop: ${n}/${n} ✅`);
