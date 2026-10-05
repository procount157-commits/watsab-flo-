// Speaking, the prompt core, and the guard's new bounce rule — none of it
// needs a model, a mail server or a WhatsApp line:
// what reads well aloud and what stays text; how text is cleaned for a voice;
// an Ogg file's duration read from its pages; the core's parts and order in
// every desk's prompt; and the bounce rule that slows a small bad sample
// instead of freezing the account, and stops only on a real one.

export {};
const { sayable, speakable, languageOf, oggSeconds } = await import("../tts");
const { corePrompt, finalCheck, NEVER, WORK_PROTOCOL } = await import("../prompt-core");
const { assessEmail } = await import("../email/health");
const { buildSystemPrompt } = await import("../knowledge");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── Voice ────────────────────────────────────────────────────────
check("a short reply reads well aloud", sayable("هلا أحمد، رخصتكم مين لاند ولا فري زون؟").ok);
check("a link stays text", sayable("شوف التفاصيل هنا https://pro-count.ae").why === "فيه رابط");
check("a price table stays text", sayable("١. ٥٠٠ درهم\n٢. ١٢٠٠ درهم\n٣. ٢٥٠٠ درهم\n٤. ٤٠٠٠ درهم\n٥. ٨٠٠٠ درهم").ok === false);
check("a very long reply stays text", sayable("كلام ".repeat(400)).why === "طويل");
const cleaned = speakable("مرحباً *أحمد* 😊\nشوف الرابط https://pro-count.ae\nوخبرني [ملاحظة داخلية]");
check("emoji, links, markdown and asides are stripped for the voice", cleaned === "مرحباً أحمد. شوف الرابط. وخبرني", cleaned);
check("the voice follows the language", languageOf("هلا، كيف أقدر أساعدك؟") === "ar" && languageOf("Hi, how can I help?") === "en");
// An Ogg whose last page says 48 000 × 7 samples.
const page = Buffer.alloc(28); page.write("OggS", 0, "ascii"); page.writeBigUInt64LE(BigInt(48_000 * 7), 6);
check("a voice note's length is read from its last page", oggSeconds(Buffer.concat([Buffer.from("junk"), page])) === 7);
check("...and estimated when there is no page", oggSeconds(Buffer.alloc(12_000)) === 2);

// ── The core ─────────────────────────────────────────────────────
const p = corePrompt({ channel: "whatsapp", identity: "اسمك هال، موظف المبيعات.", persona: "مندوب.", rules: ["قاعدة المكتب"], context: ["معرفة: السعر ٥٠٠"] });
const at = (t: string) => p.indexOf(t);
check("identity comes first, the check last", at("اسمك هال") === 0 && at("قبل أن تُخرج النص") > at("معرفة: السعر"));
check("the order is identity → protocol → rules → prohibitions → examples → context", at("طريقة العمل") < at("قاعدة المكتب") && at("قاعدة المكتب") < at("ما لا يُقال أبداً") && at("ما لا يُقال أبداً") < at("✗ سيئ") && at("✗ سيئ") < at("معرفة: السعر"));
check("the prohibitions name the template phrases and the AI", NEVER.includes("لا تتردد") && NEVER.includes("ذكاء اصطناعي") && NEVER.includes("منافس"));
check("the protocol says to read first and never estimate", WORK_PROTOCOL.includes("اقرأ كل ما قبل") && WORK_PROTOCOL.includes("لا تُقدّر"));
check("an internal job gets no examples or mirror", !corePrompt({ channel: "internal", identity: "x" }).includes("✗ سيئ"));
check("the check is per channel", finalCheck("email").includes("العنوان") && !finalCheck("whatsapp").includes("العنوان") && finalCheck("whatsapp").includes("واتساب"));
const wa = buildSystemPrompt(null, [], [], "اسمك هال.", ["- بع."], "═══ فحص الكتابة ═══", 1);
check("the WhatsApp prompt carries the core and ends with the writing check", wa.includes("طريقة العمل") && wa.includes("ما لا يُقال أبداً") && wa.includes("✗ سيئ") && wa.indexOf("قبل أن تُخرج النص") < wa.indexOf("فحص الكتابة"));

// ── The guard ────────────────────────────────────────────────────
const base = { complaints24h: 0, unsubscribed24h: 0, opened24h: 10, replied24h: 1, senderAgeDays: 10 };
const small = assessEmail({ ...base, sent24h: 30, bounced24h: 5 });
check("five bounces in thirty slow the sender, and do not stop it", small.holdMinutes === 0 && small.throttle === 3 && small.level === "warning", JSON.stringify(small));
const real = assessEmail({ ...base, sent24h: 80, bounced24h: 6 });
check("six in eighty is a real stop — for an hour", real.holdMinutes === 60 && real.level === "critical");
check("four bounces never stop, whatever the rate", assessEmail({ ...base, sent24h: 60, bounced24h: 4 }).holdMinutes === 0);
check("a clean day is clean", assessEmail({ ...base, sent24h: 200, bounced24h: 2 }).level === "ok");

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
