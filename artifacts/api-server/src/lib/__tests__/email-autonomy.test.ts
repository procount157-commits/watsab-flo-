// The team runs without the owner's yes: what the guard finds is mended, not held (2026-11-02). Pure.
import assert from "node:assert/strict";
const { repairDraft, formatIssues, guardCheck } = await import("../email/team");
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const K = "Pro Count helps UAE real estate brokers register on goAML. Fines start at AED 50,000.";

const noLead = `<p>Hello Ahmed,</p><p>Real estate brokers in Dubai must register on goAML before they take a cash deal, and many still have not.</p><p class="cta"><a href="#cta">Check your readiness</a></p><p>More details here.</p>`;
const a = repairDraft(noLead, K);
ok(!formatIssues(noLead, "first").every((i) => !/ملخص/.test(i)), "the unmarked draft is held today");
ok(formatIssues(a, "first").length === 0, "mended: the first real paragraph is the lead");
ok((a.match(/class="lead"/g) ?? []).length === 1, "only one lead");
ok(a.includes("<p>Hello Ahmed,</p>"), "the greeting is not the lead");

const hype = `<p class="lead">We are the best firm in the UAE. We register you on goAML in a week.</p><p class="cta"><a href="#cta">Talk to us</a></p>`;
const b = repairDraft(hype, K);
ok(guardCheck([b], K).length === 0, "the hype sentence is cut");
ok(b.includes("We register you on goAML"), "the rest of the paragraph stays");

const fakeNumber = `<p class="lead">Brokers face fines of AED 1,000,000 this year. We can help you register.</p><p class="cta"><a href="#cta">Talk to us</a></p>`;
const c = repairDraft(fakeNumber, K);
ok(!c.includes("1,000,000") && c.includes("We can help you register"), "a number the firm never taught is cut, the offer stays");
const known = `<p class="lead">Fines start at AED 50,000 for brokers who skip goAML. We can help.</p><p class="cta"><a href="#cta">Talk</a></p>`;
ok(repairDraft(known, K).includes("50,000"), "a number from the knowledge stays");

const longLead = `<p class="lead">${"One sentence here that runs on. ".repeat(3)}${"word ".repeat(60)}</p><p class="cta"><a href="#cta">Go</a></p>`;
ok(!formatIssues(repairDraft(longLead, K), "first").some((i) => /الملخص/.test(i)), "a long lead keeps two sentences");
const noCta = `<p>Hello,</p><p class="lead">Brokers must register on goAML before a cash deal, and many have not yet done it.</p><p>Details.</p>`;
const d = repairDraft(noCta, K, "https://wa.me/971542328336");
ok(formatIssues(d, "first").length === 0 && d.indexOf('class="cta"') > d.indexOf('class="lead"'), "a missing button is added after the lead");
ok(!/class="cta"/.test(repairDraft(noCta, K)), "no link known, no button invented");
const { companyDomain } = await import("../email/service");
ok(companyDomain("Ahmed@Emaar.AE") === "emaar.ae", "a company address gives its domain");
ok(companyDomain("someone@gmail.com") === null && companyDomain("x@eim.ae") === null, "a free mailbox is nobody's company");
console.log(`email-autonomy: ${n}/${n} ✅`);
