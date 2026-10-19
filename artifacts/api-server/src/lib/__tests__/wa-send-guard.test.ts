import assert from "node:assert/strict";
import { phoneKey, waitFor, uniquePeople, GUARD_RULES } from "../wa-send-guard";
import { strictSector } from "../email/sector";
import { addressed } from "../wa-autopilot";
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
// one person, any spelling
ok(phoneKey("971501071611") === phoneKey("0501071611") && phoneKey("+971 50 107 1611") === phoneKey("971501071611:0@s.whatsapp.net"), "one person, four spellings");
ok(uniquePeople([{ phone: "0501071611" }, { phone: "971501071611" }, { phone: "0502000061" }]).length === 2, "a list keeps one copy of each person");
// pace across all campaigns
const now = 10_000_000;
ok(waitFor([], now, 40_000) === 0, "first message goes now");
ok(waitFor([now - 10_000], now, 40_000) === 30_000, "40 s after the last");
const eight = Array.from({ length: GUARD_RULES.per10Min }, (_, i) => now - 500_000 + i * 60_000);
ok(waitFor(eight, now, 40_000) >= 100_000, "eight in ten minutes: waits for the window");
// the right sector by the company's own name
ok(strictSector("Al Futtaim Residence Building") === null, "a residence is no contractor");
ok(strictSector("City Tower Building Residence") === null, "nor a tower");
ok(strictSector("Trust Speed Contracting") === "مقاولات", "a contracting company is");
ok(strictSector("ASAD Building Contracting-L.L.C") === "مقاولات", "building contracting is contracting");
ok(strictSector("Dar Al Sahil Building") === null, "'building' alone is not contracting");
ok(strictSector("Gulf Properties Real Estate Brokers") === "عقارات", "real estate by name");
// the name
ok(addressed("نتولّى ملفات goAML.", false).startsWith("السادة {اسم_الشركة|شركتكم} المحترمين،"), "Pro Count names the company");
ok(!/\{/.test(addressed("{الاسم}، طقم العروس هنا", true)) && !addressed("{الاسم}، طقم العروس هنا", true).includes("السادة"), "Floret names nobody");
ok(addressed("We prepare your goAML file.", false, "en").startsWith("Dear {اسم_الشركة|Sir/Madam} team,"), "English message, English greeting");
console.log(`wa-send-guard: ${n}/${n} ✅`);
