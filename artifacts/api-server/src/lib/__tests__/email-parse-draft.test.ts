// The writer's answer read the way weak models actually write it — «[Subject]»,
// «**[عنوان]**», «1. [عنوان]», a bare «Subject:», «[message]», a missing
// closing mark, «Subject:» inside a follow-up — and the pieces around it: the
// summary mark on its own line, the full example, the guard's likeness check,
// the knowledge ranking, the lesson kinds and the prompt trimmed for campaigns.

export {};
const { parseDraft, toHtml, bodyOf, overlap, queryWords, lessonKind, priorWavesBlock, WRITER_MAX_TOKENS } = await import("../email/agent");
const { WRITER_EXAMPLE, HOOK_CRAFT, COLD_CRAFT } = await import("../email/prompts");
const { tooSimilar, leadOf, formatIssues, EMAIL_DOCTRINE, EMAIL_TEAM_DEFS } = await import("../email/team");
const { corePrompt, WORK_PROTOCOL, MIRROR, NEVER, finalCheck } = await import("../prompt-core");
const { FOLLOW_PROMPT, FOLLOW_WORDS } = await import("../email/intensity");
const { usableExamples } = await import("../email/creator");
const { subjectLesson } = await import("../email/missions");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── The strict shape still parses ────────────────────────────────
const strict = parseDraft(WRITER_EXAMPLE)!;
check("the writer's own example parses", !!strict && strict.subjects.length === 2, JSON.stringify(strict?.subjects));
check("...with a lead, a button and the details divider", /class="lead"/.test(strict.html) && /class="cta"/.test(strict.html) && /class="more"/.test(strict.html));
check("...a warm and a cold follow-up", strict.followups.length === 2 && strict.followups[0]!.audience === "warm" && strict.followups[1]!.audience === "cold");
check("...and the reason", /brokers/.test(strict.why));
check("the example's lead passes the shape check", formatIssues(strict.html).length === 0, formatIssues(strict.html).join(" | "));
check("the example opens on the official fact", /1,063 AML violations/.test(leadOf(strict.html)));

// ── Loose subjects ───────────────────────────────────────────────
const body = "[الرسالة]\nHello {{first_name|there}},\n\n[ملخص] Brokers face inspections on their AML files this year.\n\n[زر] Check my AML gaps\n[/الرسالة]";
check("«[Subject]» is a subject", parseDraft(`[Subject] AML and you\n${body}`)?.subjects[0] === "AML and you");
check("«**[عنوان]**» is a subject", parseDraft(`**[عنوان]** goAML gaps\n${body}`)?.subjects[0] === "goAML gaps");
check("«1. [عنوان]:» is a subject", parseDraft(`1. [عنوان]: First one\n2) [عنوان] Second one\n${body}`)?.subjects.join("|") === "First one|Second one");
check("a bare «Subject:» counts when nothing is bracketed", parseDraft(`Subject: 495 brokers fined\n${body}`)?.subjects[0] === "495 brokers fined");
check("quotes around a subject are dropped", parseDraft(`[عنوان] «Your brokerage and goAML»\n${body}`)?.subjects[0] === "Your brokerage and goAML");

// ── Loose bodies ─────────────────────────────────────────────────
check("«[message]» opens the body", !!parseDraft(`[عنوان] x\n[message]\nHello,\n[ملخص] A line about them and their files.\n[/message]`));
check("«**[body]**» opens the body", !!parseDraft(`[عنوان] x\n**[body]**\nHello,\n[ملخص] A line about them.\n**[/body]**`));
const open = `[عنوان] x\n[الرسالة]\nHello,\n\n[ملخص] Their files, before an inspector reads them.\n\n[زر] Worth a look?\n[متابعة بعد=72 جمهور=دافئ]\nSubject: A new angle\n[ملخص] One new thing.\n[/متابعة]\n[السبب] why line`;
const o = parseDraft(open);
check("a missing [/الرسالة] ends the body at the first follow-up", !!o && !/new angle/i.test(o.html) && /class="cta"/.test(o.html), o?.html.slice(0, 120));
check("...and the follow-up still parses with «Subject:»", o?.followups.length === 1 && o.followups[0]!.subject === "A new angle");
check("...and the reason is read", o?.why === "why line");
check("a body to EOF is a body", bodyOf("[الرسالة]\nHello\n[ملخص] All of it") === "Hello\n[ملخص] All of it");
check("no body at all is still refused", parseDraft("[عنوان] x") === null);
check("no subject at all is still refused", parseDraft(body) === null);

// ── Loose follow-ups ─────────────────────────────────────────────
const f = parseDraft(`[عنوان] x\n${body}\n[followup after=96 audience=cold]\nSubject: Shorter\nTighter.\n[/followup]\n[follow-up audience=breakup]\nعنوان: Last note\nClosing the loop.\n[/follow-up]\n[متابعة جمهور=قيمة]\nعنوان: A tip\nUseful.\n[why] because`);
check("«[followup …]» with «Subject:» parses", f?.followups[0]?.audience === "cold" && f.followups[0]!.afterHours === 96 && f.followups[0]!.subject === "Shorter", JSON.stringify(f?.followups.map((x) => [x.audience, x.subject])));
check("«[follow-up …]» parses", f?.followups[1]?.audience === "breakup" && f.followups[1]!.subject === "Last note");
check("a follow-up without its closing mark ends at [why]", f?.followups[2]?.audience === "value" && !/because/.test(f.followups[2]!.html));
check("«[why]» is the reason", f?.why === "because");
check("a «Subject:» inside a follow-up is not a first-email subject", parseDraft(`Subject: Main\n${body}\n[متابعة]\nSubject: Inner\nText.\n[/متابعة]`)?.subjects.join("|") === "Main");

// ── The summary mark on its own line ─────────────────────────────
const lone = toHtml("Hello,\n\n[ملخص]\nYour brokerage's AML file is what an inspector reads first.\n\n[زر] Check my AML gaps");
check("[ملخص] alone on a line leads the next paragraph", /<p class="lead">Your brokerage/.test(lone), lone);
check("...with no empty lead left behind", !/<p class="lead"><\/p>/.test(lone));
check("[summary] then a blank line, then the text, works too", /<p class="lead">The gist\.<\/p>/.test(toHtml("[summary]\n\nThe gist.")));

// ── The guard's likeness check ───────────────────────────────────
const prevLead = "In H1 2025 the Ministry recorded 1,063 AML violations; 495 of them on real-estate brokers. Most brokerages registered on goAML and stopped there.";
const same = `<p>Hello there,</p><p class="lead">In H1 2025 the Ministry recorded 1,063 AML violations; 495 of them on real-estate brokers. Most brokerages registered on goAML and stopped.</p>`;
const other = `<p>Hello there,</p><p class="lead">The question inspectors ask most is where a buyer's money came from, and whether your file shows it on every closed deal.</p>`;
check("a near-identical lead is caught", tooSimilar(same, [prevLead]) === prevLead);
check("a different lead passes", tooSimilar(other, [prevLead]) === null);
check("no previous waves, nothing to compare", tooSimilar(same, []) === null);
check("a draft with no lead mark uses its first real paragraph", leadOf("<p>Hello there,</p><p>This is the first real paragraph of the email.</p>") === "This is the first real paragraph of the email.");

// ── Knowledge ranking, lessons, prior waves ──────────────────────
const q = queryWords("AML real-estate brokers عقارات goAML");
check("query words: lowercase, three letters or more", q.includes("aml") && q.includes("brokers") && q.includes("عقارات") && !q.includes("a"));
check("overlap ranks the on-topic fact higher", overlap("495 real-estate brokers fined under AML rules", q) > overlap("VAT registration threshold AED 375,000", q));
check("a lesson of failure is a loss", lessonKind("العنوان الطويل فشل: فتح منخفض") === "loss" && lessonKind("zero replies from gold traders") === "loss");
check("a lesson of success is a win", lessonKind("عنوان الرقم الرسمي جلب ٣ ردود من الوسطاء") === "win");
const pw = priorWavesBlock([{ subject: "495 brokers fined", lead: prevLead }], "kyc", ["goaml", "kyc"]);
check("prior waves are listed to avoid", pw.includes("لا تعيديه") && pw.includes("495 brokers fined"));
check("...with this wave's angle and the spent ones", pw.includes("زاوية هذه الموجة: kyc") && pw.includes("goaml") && !/استُهلكت[^\n]*kyc/.test(pw));
check("nothing before, nothing said", priorWavesBlock([], null, []) === "");
check("the subject lesson carries its rates", subjectLesson("win", { subject: "X", sent: 100, opened: 31, replied: 2 }, { subject: "Y", sent: 100, opened: 18, replied: 0 }) === "عنوان فاز في الاختبار: «X» — فتح ٣١٪، ردود ٢ (مقابل «Y» ١٨٪، ٠)");

// ── One set of numbers everywhere ────────────────────────────────
check("the writer has room for every follow-up", WRITER_MAX_TOKENS >= 2400);
check("the doctrine's §4 uses 40–90 and drops 160", EMAIL_DOCTRINE.includes("٤٠–٩٠") && !EMAIL_DOCTRINE.includes("١٦٠ كلمة"));
check("the doctrine's §11 keeps meetings off the first touch", !/بارد ← استشارة مجانية/.test(EMAIL_DOCTRINE) && /قائمة تحقق goAML/.test(EMAIL_DOCTRINE));
check("the final check asks for a 2–5 word subject", finalCheck("email").includes("٢–٥ كلمات") && !finalCheck("email").includes("٨ كلمات"));
check("a 100-word follow-up is too long now", formatIssues(`<p class="lead">${"w ".repeat(30)}</p><p>${"w ".repeat(55)}</p><p class="cta"><a href="x">b</a></p>`, "followup").some((i) => i.includes("كلمة")));
check("a 125-word first email is too long now", formatIssues(`<p class="lead">${"w ".repeat(40)}</p><p>${"w ".repeat(85)}</p><p class="cta"><a href="x">b</a></p>`).some((i) => i.includes("كلمة")));
check("HOOK_CRAFT no longer repeats the subject/CTA/urgency rules", !/Book a consultation|الاستعجال الحقيقي|٢–٥ كلمات/.test(HOOK_CRAFT) && /\[معاينة\]/.test(HOOK_CRAFT) && /\[إبراز\]/.test(HOOK_CRAFT));
check("COLD_CRAFT still carries them", /كلمتان إلى خمس/.test(COLD_CRAFT) && /لا موعد/.test(COLD_CRAFT));
check("every follow-up kind has a word cap and no details", (Object.keys(FOLLOW_PROMPT) as Array<keyof typeof FOLLOW_PROMPT>).every((k) => FOLLOW_PROMPT[k].join(" ").includes(`${FOLLOW_WORDS[k]} words`) && FOLLOW_PROMPT[k].join(" ").includes("no [تفاصيل]")));
check("no writer persona asks for a 160-word email", EMAIL_TEAM_DEFS.every((d) => !d.persona.includes("١٦٠ كلمة")));
check("ماجد holds at 2% bounces in his persona", EMAIL_TEAM_DEFS.find((d) => d.role === "email_guard")!.persona.includes("فوق ٢٪") && !EMAIL_TEAM_DEFS.find((d) => d.role === "email_guard")!.persona.includes("فوق ٥٪"));
check("personas stay under ~3.5k chars", EMAIL_TEAM_DEFS.every((d) => d.persona.length <= 3600), EMAIL_TEAM_DEFS.map((d) => `${d.name}:${d.persona.length}`).join(" "));

// ── The trimmed campaign prompt ──────────────────────────────────
const camp = corePrompt({ channel: "email", identity: "اسمك نورة.", campaign: true });
const conv = corePrompt({ channel: "email", identity: "اسمك ليلى." });
check("a campaign prompt skips the mirror and the protocol", !camp.includes(MIRROR) && !camp.includes(WORK_PROTOCOL));
check("...and keeps NEVER, the example and the check", camp.includes(NEVER) && camp.includes("مثال — السطر الأول") && camp.includes("قبل أن تُخرج النص"));
check("a conversation prompt keeps both", conv.includes(MIRROR) && conv.includes(WORK_PROTOCOL));

// ── طارق's examples ──────────────────────────────────────────────
const tpl = [
  { subject: "AML", html: "<p>Text</p><p class=\"cta\"><a>Book a free consultation</a></p>" },
  { subject: "Schedule a call", html: "<p>Text</p>" },
  { subject: "Plain", html: "<p>Plain</p>" },
  { subject: "Lead", html: "<p class=\"lead\">Gist</p>" },
];
const ex = usableExamples(tpl);
check("meeting-CTA templates are not shown as examples", ex.every((t) => !/consultation|Schedule/i.test(t.html + t.subject)));
check("...summary-first ones come first", ex[0]?.subject === "Lead" && ex.length === 2);
check("...and none is fine", usableExamples([tpl[0]!]).length === 0);

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
