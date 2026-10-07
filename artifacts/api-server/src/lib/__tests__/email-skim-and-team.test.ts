// The email the owner asked for — the point in two or three lines, the
// button under them, the detail for whoever reads on — and the team that
// works without being asked: a wave per sector, ماجد's checks, and the
// leftovers of deleted campaigns that used to stall everything.

export {};
const { toHtml } = await import("../email/agent");
const { skimFirst, styleBody, brandOf } = await import("../email/layout");
const { formatIssues } = await import("../email/team");
const { campaignForSector, MAX_SECTOR_WAVES } = await import("../email/autopilot");
const { sameLists } = await import("../email/caretaker");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── The writer's marks ───────────────────────────────────────────
const html = toHtml([
  "Hello {{first_name|there}},",
  "",
  "[ملخص] Your agency's AML file is what an inspector asks for. We review it with you in 20 minutes.",
  "",
  "[زر] Book a review",
  "",
  "[تفاصيل]",
  "- What they check",
  "- What we review",
  "",
  "Best regards,",
  "The Pro Count team",
].join("\n"));
check("the summary becomes the lead", /<p class="lead">Your agency's AML file/.test(html));
check("the details mark becomes the divider", html.includes('<hr class="more">'));
check("the button follows the summary", html.indexOf('class="cta"') > html.indexOf('class="lead"') && html.indexOf('class="cta"') < html.indexOf('class="more"'));
check("a bare [Review your AML readiness] is a button, not bracketed text", toHtml("[Review your AML readiness]").includes('<p class="cta"><a href="#cta">Review your AML readiness</a></p>'));

// ── The order, enforced ──────────────────────────────────────────
const late = '<p class="lead">Gist.</p><hr class="more"><ul><li>a</li></ul><p class="cta"><a href="x">Go</a></p>';
const fixed = skimFirst(late);
check("a button written at the bottom moves up under the summary", fixed.indexOf("cta") < fixed.indexOf("more") && fixed.indexOf("cta") > fixed.indexOf("lead"));
check("a message without a summary is left as written", skimFirst("<p>a</p><p class=\"cta\"><a href=\"x\">b</a></p>") === "<p>a</p><p class=\"cta\"><a href=\"x\">b</a></p>");
const styled = styleBody(html, brandOf({ brandName: "PRO COUNT" }), "ltr");
check("the divider is labelled for the reader", styled.includes("In more detail") && !styled.includes("<hr"));
check("...in Arabic for an Arabic email", styleBody('<p class="lead">ملخص</p><hr class="more">', brandOf(null), "rtl").includes("التفاصيل لمن يرغب"));

// ── ماجد's check of the shape ────────────────────────────────────
check("the right shape passes", formatIssues(html).length === 0, formatIssues(html).join(" | "));
const wall = `<p>Hello,</p><p>${"word ".repeat(220)}</p><p class="cta"><a href="x">Go</a></p>`;
const w = formatIssues(wall);
check("a wall of text is caught: no summary, too long", w.some((i) => i.includes("لا ملخص")) && w.some((i) => i.includes("كلمة")));
check("a summary of 80 words is too long", formatIssues(`<p class="lead">${"w ".repeat(80)}</p><p class="cta"><a href="x">b</a></p>`).some((i) => i.includes("الملخص")));
check("a follow-up is held to the short form", formatIssues(`<p class="lead">${"w ".repeat(40)}</p><p>${"w ".repeat(70)}</p><p class="cta"><a href="x">b</a></p>`, "followup").some((i) => i.includes("٧٠")));

// ── سلمى's waves by sector ───────────────────────────────────────
check("each sector gets its own campaign", campaignForSector("عقارات").includes("AML للعقارات") && campaignForSector("ذهب ومجوهرات").includes("DPMS"));
check("a sector with none in the library gets the default", campaignForSector("سياحة وسفر").includes("ضريبة الشركات"));
check("at most three sector waves per list", MAX_SECTOR_WAVES === 3);

// ── The same people twice ────────────────────────────────────────
const twins = sameLists([{ id: 25, name: "UAE-real-estate", n: 8238, sig: "abc" }, { id: 26, name: "UAE-real-estate — عقارات", n: 8238, sig: "abc" }, { id: 7, name: "ALL", n: 3852, sig: "xyz" }]);
check("two lists with the same people are found", twins.length === 1 && twins[0]![0].id === 25 && twins[0]![1].id === 26);
check("an empty list is no one's twin", sameLists([{ id: 1, name: "a", n: 0, sig: "e" }, { id: 2, name: "b", n: 0, sig: "e" }]).length === 0);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
