// How an email looks, without a database: the branded layout around the
// message, the button and the box, the direction read from the message, the
// line a client shows beside the subject, the plain layout when chosen, and
// a writer's "[button]" line becoming a button.

import { renderEmail } from "../email/tracking";
import { brandOf, directionOf, styleBody, preheaderOf } from "../email/layout";
import { toHtml } from "../email/agent";

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

const brand = brandOf({ layout: "branded", brandName: "PRO COUNT", brandTagline: "Accounting · Tax", brandColor: "#111c33", brandAccent: "#0284c7", logoUrl: "https://www.pro-count.ae/apple-touch-icon.png", website: "www.pro-count.ae", phone: "+971 54 232 8336", address: "Abu Dhabi" });
const track = { base: "", token: "t", secret: "x", pixel: false, links: false };
const foot = { base: "", token: "t", fromName: "بروكاونت للمحاسبه", fromEmail: "info@pro-count.ae" };
const en = renderEmail(`<p>Hello {{first_name|there}},</p><p>Your books may be behind.</p><div class="note">Key point</div><p class="cta"><a href="https://wa.me/971542328336">Book a call</a></p>`, { first_name: "Khalid" }, track, foot, brand).html;

check("the header carries the brand and the logo", en.includes("PRO COUNT") && en.includes("apple-touch-icon.png") && en.includes("#111c33"));
check("an English message reads left to right", en.includes('dir="ltr"') && en.includes('lang="en"'));
check("the button is a table cell in the accent colour", /<td style="border-radius:8px;background:#0284c7"><a href="https:\/\/wa\.me/.test(en));
check("the box is a highlighted cell", en.includes("border-left:5px solid #0284c7") && en.includes("Key point"));
check("paragraphs get their style inline", /<p style="margin:0 0 14px;text-align:left">/.test(en));
check("the footer has the website, phone and unsubscribe", en.includes("www.pro-count.ae") && en.includes("+971 54 232 8336") && en.includes("Unsubscribe"));
check("an Arabic sender name is not printed in an English footer", !/from بروكاونت/.test(en) && en.includes("from PRO COUNT"));
check("the inbox preview line skips the greeting", en.includes(">Your books may be behind.") || preheaderOf("<p>Hello there,</p><p>Your books may be behind.</p>") === "Your books may be behind.", preheaderOf("<p>Hello there,</p><p>Your books may be behind.</p>"));

const ar = renderEmail(`<p>مرحباً فريق شركة النور،</p><ul><li>تقييم المخاطر</li></ul>`, {}, track, foot, brand).html;
check("an Arabic message reads right to left", ar.includes('dir="rtl"') && ar.includes("إلغاء الاشتراك"));
check("...with its lists indented on the right", /<ul style="margin:0 0 16px;padding-right:22px">/.test(ar));
check("direction is read from the words, not the fields", directionOf("<p>{{company}} Hello team, your books</p>") === "ltr" && directionOf("<p>مرحباً {{company}}</p>") === "rtl");

const plain = renderEmail("<p>Hi</p>", {}, track, foot, { ...brand, layout: "plain" }).html;
check("plain layout when chosen: no header", !plain.includes("apple-touch-icon") && plain.includes("<p>Hi</p>"));
check("no brand at all: the plain layout", !renderEmail("<p>Hi</p>", {}, track, foot).html.includes("PRO COUNT"));
check("a style already there is kept", styleBody('<p style="color:red">x</p>', brand, "ltr") === '<p style="color:red">x</p>');

const h = toHtml("Hello,\n\nWe can help.\n\n[button] Book a free consultation\n\nBest regards");
check("a writer's [button] line becomes a button", h.includes('<p class="cta"><a href="#cta">Book a free consultation</a></p>'), h);
check("...and Arabic [زر] too", toHtml("[زر] احجزوا استشارة").includes('class="cta"'));
check("written paragraphs are plain tags for the layout to style", toHtml("a\n\n- b").startsWith("<p>a</p><ul><li>b</li></ul>"), toHtml("a\n\n- b"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
