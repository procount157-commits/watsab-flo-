// The replies that went out today, held to the reading of the message they
// answered: each real bad reply must now fail, each kind of message must be
// read for what it is, and the prompt must be short.

export {};
const { situationOf, read, replyPrompt, langOf } = await import("../reply-brain");
const { checkReply, needsRewrite } = await import("../reply-check");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── What kind of message ────────────────────────────────────────
const cases: Array<[string, string]> = [
  ["What ?", "confused"], ["❓❓❓", "confused"], ["?", "confused"], ["ايش هذا", "confused"],
  ["Who is this?", "who"], ["مين معي", "who"], ["مين", "who"],
  ["No", "declined"], ["We have in house team", "declined"], ["لا شكرا عندنا محاسب", "declined"], ["not interested", "declined"],
  ["English plz", "language"], ["مهتم", "interested"], ["Interested", "interested"],
  ["How much?", "price"], ["كم السعر", "price"],
  ["***Free Visit زيارة مجانية* ❄️ Air-condition Repairing. تصليح المكيفات 🧊 Refrigerator Repair call us", "counter_pitch"],
  ["Thanks", "thanks"], ["Do you do payroll?", "question"],
  ["رخصتنا مين لاند", "other"],
];
for (const [m, want] of cases) check(`«${m.slice(0, 30)}» is ${want}`, situationOf(m) === want, situationOf(m));
check("symbols only take the language of what we sent", langOf("❓❓", "en") === "en");

// ── The real replies of today, now caught ───────────────────────
const topic = "Real Estate AML Readiness: goAML is not the framework";
const c = (customer: string, reply: string) => {
  const reading = read(customer, { campaignTopic: topic });
  return checkReply(reply, { customer, reading, names: ["هال", "Hal"] });
};
const bad: Array<[string, string, string]> = [
  ["What ?", "Hello! Just checking in about your business setup. Are you on mainland or free zone license?", "licence"],
  ["Who is this?", "Hi, I'm Hala from Pro Count. We help SMEs with accounting and tax. Could you let me know if your company is licensed on mainland or a free-zone?", "name"],
  ["No", "Understood. Is there anything specific you need help with regarding your accounts or tax filings?", "asked"],
  ["We have in house team", "Thanks. Are you looking for help with VAT filings or corporate-tax compliance?", "asked"],
  ["English plz", "Great, thanks for reaching out. Is your company registered in a Mainland or a Free Zone?", "unanswered"],
  ["It's Sajid Mahmood AC repair...how can I help you..... free visit, we provide AC maintenance and repair, call us", "Hi Sajid, how can we assist you with your AC repair needs?", "role"],
];
for (const [m, reply, code] of bad) {
  const q = c(m, reply);
  check(`today's reply to «${m.slice(0, 22)}» now fails (${code})`, q.issues.some((i) => i.code === code) && needsRewrite(q) && q.score < 80, `${q.score} ${q.issues.map((i) => i.code).join(",")}`);
}
const good: Array<[string, string]> = [
  ["What ?", "Sorry for the confusion — this is Hal from Pro Count, an accounting firm in Abu Dhabi. We wrote about AML compliance for real estate agencies; is that something you handle?"],
  ["We have in house team", "Understood, thanks for letting me know. If you ever want a second pair of eyes before a filing, we're here."],
  ["Who is this?", "Hal from Pro Count, an accounting firm in Abu Dhabi — we wrote to you about AML readiness for real estate agencies. Is that on your radar?"],
];
for (const [m, reply] of good) {
  const q = c(m, reply);
  check(`a right reply to «${m.slice(0, 22)}» passes`, !q.issues.some((i) => ["licence", "asked", "unanswered", "name", "role"].includes(i.code)), q.issues.map((i) => i.note).join(" | "));
}

// ── The reading and the prompt ──────────────────────────────────
const r = read("No", { campaignTopic: topic });
check("a decline closes the conversation and asks nothing", r.closes && !r.mayAsk);
check("the licence is forbidden when the topic is not tax", read("Thanks", { campaignTopic: topic }).forbid.some((f) => f.includes("الرخصة")));
check("...and allowed when it is", !read("Thanks", { campaignTopic: "Corporate tax registration deadline" }).forbid.some((f) => f.includes("الرخصة")));
const p = replyPrompt({ name: "هال", title: "موظف المبيعات", firm: "بروكاونت للمحاسبة (PRO COUNT)", firmLine: "فريق محاسبة ومالية خارجي للشركات في الإمارات، مقره أبوظبي", outreach: "حملة «AML»:\n«" + "x".repeat(600) + "»", known: [], reading: read("What ?", { campaignTopic: topic }), facts: "- a: " + "y".repeat(1500) });
check("the prompt is short — under 4,500 characters, not 11,400", p.length < 4500, String(p.length));
check("it names him in English for an English reply", p.includes("Your name is Hal"));
check("it carries the examples for this situation only", p.includes("What ?") && !p.includes("How much?"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
