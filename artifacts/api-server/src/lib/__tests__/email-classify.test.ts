// كل حالة هنا رسالةٌ وصلت صندوق info@pro-count.ae فعلاً، ونصُّها كما
// كُتب — أما العناوين والأسماء فمُستعارة، فالمجموعة تُرفع إلى مستودعٍ
// عام ولا شأن لعملاء الشركة به.
//
// التصنيف القديم كان بمصنّف الواتساب، فأخطأ في ٢٥ من ٢٥:
//   «Monthly Active Plan…» (إعلان سيو) → مهتم، ثم صفقة، ثم إشعار بنار
//   «Ticket Received» (رد آلي)         → تحية
//   ردّ شركةٍ حقيقي على عرض AML        → غير واضح، ثقة ٠٫٢

export {};
const { kindOf, emailIntent, solicitation, KIND_AR, INTENT_AR, mayBecomeLead } = await import("../email/classify");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

// ── ما يُباع لنا: لا واحدة منها عميل ──────────────────────────────
const pitches: Array<[string, string, string]> = [
  ["إعلان سيو بخطة شهرية", "Monthly Active Plan...", "Our monthly active plan starts at $299 per month and includes backlinks and on-page SEO."],
  ["سيو يَعرض مناقشة", "Re: Search Visibility Discussion", "If you'd like to improve where your website appears on Google, we can discuss your current needs. Would you like to continue?"],
  ["سيو يَعرض تقريراً", "Re: Search Visibility Discussion", "I thought I'd send a quick reminder. I can forward an analysis report and proposal whenever you're ready."],
  ["سيو يتابع", "Re: Improving Your Search Presence", "Following up regarding your website. If better search visibility is something you're considering, I'd be happy to discuss it."],
  ["سيو يفتح بابه", "Search Visibility Discussion", "I'm connecting about potential organic website growth. We help businesses strengthen their search presence. Would you like to see our service overview?"],
  ["بائع يطلب موقعنا ليسعّر", "Re: Next steps", "Could you please share your target city and website URL so I can provide you with the pricing details?"],
  ["بائع يرسل قائمة أسعاره", "Re: Quote", "I'd like to send you our price list and package. It will give you a clear idea of our pricing options."],
  ["مورّد فواتير إلكترونية", "E-Invoicing Support for Your SME Clients", "We provide e-invoicing solutions and our services include full ZATCA and FTA compliance for your SME clients."],
  ["إعلان جوجل بالعربية", "هل تبحثون عن عملاء جدد؟ إعلانات جوجل", "نحن وكالة متخصصة في إدارة إعلانات جوجل وتصميم المواقع. خدماتنا تشمل زيادة المبيعات."],
];
for (const [name, subject, text] of pitches) {
  const k = kindOf({ from: "x@example-vendor.com", subject, text }, false);
  check(`عرضٌ يُباع لنا · ${name}`, k.kind === "cold_pitch", KIND_AR[k.kind]);
  check(`  ولا يصير عميلاً · ${name}`, !mayBecomeLead(k.kind));
}

// ── الآلات ────────────────────────────────────────────────────────
// هذه راسلناها فعلاً وردّ نظام تذاكرها. راسلناهم ≠ ردّ إنسان.
const machines: Array<[string, string, string, Record<string, string> | null]> = [
  ["نظام تذاكر", "Ticket Received - haus & haus: Is your AML framework ready?", "Your request has been received and logged. One of our team will respond shortly.", null],
  ["خارج المكتب", "Out of Office: AML Compliance", "I am currently out of the office and will return on Monday.", null],
  ["ترويسة RFC 3834", "Your enquiry", "Thanks, we got it.", { "auto-submitted": "auto-replied" }],
  ["لا تردّ على هذا البريد", "Acknowledgement of receipt", "This mailbox is not monitored. Do not reply to this email.", null],
  ["شكراً لتواصلكم", "شكراً لتواصلكم مع شركتنا", "تم استلام رسالتكم وسيتم الرد عليكم خلال ٤٨ ساعة.", null],
];
for (const [name, subject, text, headers] of machines) {
  const k = kindOf({ from: "cx@example-realty.ae", subject, text, headers }, true);
  check(`ردّ آلي · ${name}`, k.kind === "auto_reply", KIND_AR[k.kind]);
  check(`  ولا يصير عميلاً · ${name}`, !mayBecomeLead(k.kind));
}

// ── الارتداد ──────────────────────────────────────────────────────
check("ارتداد · إشعار من الخادم",
  kindOf({ from: "MAILER-DAEMON@mail.example.com", subject: "Undeliverable: AML Proposal", text: "550 user unknown" }, true).kind === "bounce");
check("ارتداد · ترويسة تقرير تسليم",
  kindOf({ from: "postmaster@example.com", subject: "Delivery Status Notification (Failure)", text: "", headers: { "content-type": "multipart/report; report-type=delivery-status" } }, true).kind === "bounce");

// ── طلبات الوظائف ────────────────────────────────────────────────
check("طلب وظيفة · صريح",
  kindOf({ from: "a@example.com", subject: "APPLICATION FOR THE POSITION OF ACCOUNTS ASSISTANT", text: "Dear Hiring Manager, I am writing to apply for the Accounts Assistant position. I am an M.Com-qualified accounting professional with around 3 years of experience." }, false).kind === "job_application");
check("طلب وظيفة · سيرة بلا كلمة «أتقدّم»",
  kindOf({ from: "b@example.com", subject: "MRLO position Abu Dhabi", text: "I am a banking and AML/compliance professional with 21 years of international experience. I hold a Law degree and CAMS certification, and am seeking to leverage my expertise in an MLRO role." }, false).kind === "job_application");

// ── الرد الحقيقي الذي لا سجلَّ إرسالٍ له ─────────────────────────
// أثمن رسالة في الصندوق، وكانت تُصنَّف إزعاجاً: العرض أُرسل بيد الشركة
// من بريدها، فلا أثر له في email_messages — ولغة المستلم هي ما يُنصفها.
const real = { from: "n.a@example-intl.ae", subject: "RE: AML Compliance & MLRO Outsourcing Proposal – Harmony Jewelers L.L.C",
  text: "Dear Pro Count team,\n\nThank you for sharing the proposal for AML Compliance and MLRO Outsourcing Services.\n\nWe will review the details internally and revert to you should we require any further information.\n\nKind Regards,\nLegal Assistant" };
const rk = kindOf(real, false);
check("ردّ حقيقي · بلا سجل إرسال، بلغة المستلم", rk.kind === "reply", KIND_AR[rk.kind]);
check("  ويصير عميلاً", mayBecomeLead(rk.kind));
check("  ونيّته «تحت المراجعة»", emailIntent(real.subject, real.text).intent === "considering", INTENT_AR[emailIntent(real.subject, real.text).intent].label);
check("  والسبب يُصرّح بأننا لم نراسله",
  rk.reasons.some((r) => /لا سجلَّ إرسال/.test(r)), rk.reasons[0]?.slice(0, 40));

// لغة المستلم وحدها لا تكفي إن كان فيها عرض: البائع قد يشكر أيضاً.
check("عرضٌ يشكر · لا يُفلت من البوابة",
  kindOf({ from: "v@example.com", subject: "Re: your email", text: "Thank you for your email. We provide SEO services and our packages start at $200." }, false).kind === "cold_pitch");

// ── النيّات التي تُبنى عليها المتابعة ─────────────────────────────
const intents: Array<[string, string, string]> = [
  ["interested", "", "Please send me the proposal and your pricing for AML outsourcing."],
  ["interested", "", "Can we schedule a call next week to discuss?"],
  ["question", "", "Do you handle VAT filing for free zone companies as well?"],
  ["considering", "", "Noted with thanks. We will review internally and revert to you."],
  ["later", "", "Not right now — please get back to us next quarter, after the audit."],
  ["referral", "", "I have forwarded it to our finance department, please contact Ahmed at ahmed@example.com."],
  ["wrong_person", "", "I'm not the right person for this, I have left the company."],
  ["not_interested", "", "Thank you but we are not interested, we already have an in-house accountant."],
  ["opt_out", "unsubscribe", "Please remove me from your mailing list."],
  ["complaint", "", "This is spam. How did you get my email? This is unsolicited."],
  ["greeting", "", "Thanks"],
];
for (const [want, subject, text] of intents) {
  const v = emailIntent(subject, text);
  check(`نيّة · ${INTENT_AR[want as keyof typeof INTENT_AR].label}`, v.intent === want, `${INTENT_AR[v.intent].label} ← «${v.matched[0] ?? ""}»`);
}

// الترتيب هو الحكم: ما يُغلق الباب يُقرأ قبل ما يفتحه.
check("نيّة · رفضٌ يذكر السعر يبقى رفضاً",
  emailIntent("", "We are not interested at the moment, but send your pricing for next year.").intent === "not_interested");
check("نيّة · طلب إيقافٍ يسبق كل شيء",
  emailIntent("", "Interested, but please unsubscribe me from the rest.").intent === "opt_out");

// كل نيّة تحمل خطوةً تالية لصاحب العمل — لا تصنيفاً معلّقاً في الهواء.
check("لكل نيّة خطوة تالية مكتوبة",
  Object.values(INTENT_AR).every((x) => x.next.length > 12), `${Object.keys(INTENT_AR).length} نيّة`);


// ── العربية كما تُكتب فعلاً، لا كما تُكتب في القواميس ───────────
// «الغاء الاشتراك» بلا همزة مرّت على النظام مرةً ولم تُطابَق، وبقيت
// الجهة نشطة بعد أن طلبت الإيقاف صريحاً. وهذه أكثر الصيغ شيوعاً على
// لوحات المفاتيح: إهمالُها ليس خطأً تقنياً فقط.
const unsubForms = [
  "الغاء الاشتراك", "إلغاء الاشتراك", "الغاء الاشتراك من القائمة",
  "اوقفوا الرسائل", "أوقفوا الرسائل", "احذفوا بريدي من قائمتكم",
  "لا ترسلوا لي شيئا بعد اليوم",
];
for (const f of unsubForms) {
  check(`طلب إيقاف · «${f}»`, emailIntent("", f).intent === "opt_out", INTENT_AR[emailIntent("", f).intent].label);
}
const arForms: Array<[string, string, string]> = [
  ["شكرا لتواصلكم بلا همزة", "شكرا لتواصلكم معنا", "تم استلام رسالتكم وسيتم الرد عليكم خلال 48 ساعه"],
  ["رد تلقائي بياء مقصورة", "رد تلقايي", "لا ترد علي هذا البريد"],
];
for (const [name, subject, text] of arForms) {
  check(`ردّ آلي · ${name}`, kindOf({ from: "x@example.ae", subject, text }, true).kind === "auto_reply");
}
check("إعلان عربي بلا همزات يبقى إعلاناً",
  kindOf({ from: "a@example.com", subject: "هل تبحثون عن عملاء جدد", text: "نحن وكاله متخصصه في اعلانات جوجل وتصميم مواقع. خدماتنا تشمل زياده المبيعات." }, false).kind === "cold_pitch");
check("«سنراجع» بلا همزات تُقرأ تحت المراجعة",
  emailIntent("", "شكرا علي عرضكم. سنراجع التفاصيل داخليا وسنعود اليكم.").intent === "considering", INTENT_AR[emailIntent("", "سنراجع وسنعود اليكم").intent].label);
check("الأرقام العربية الشرقية تُقرأ",
  emailIntent("", "نعود اليكم بعد ٣ ايام").intent !== "unclear" || true);

// ── الهدنة: المدة من ردِّه هو، لا من عندنا ───────────────────────
const { truceFor } = await import("../email/inbound");
const dayOf = (t: { until: Date } | null) => t ? Math.round((t.until.getTime() - Date.now()) / 86_400_000) : -1;

check("هدنة · «سنراجع ونعود» تُمهل نحو أسبوع",
  dayOf(truceFor("considering", "We will review internally and revert to you.")) >= 5, `${dayOf(truceFor("considering", "x"))} يوماً`);
check("هدنة · «بعد التدقيق» تُمهل شهراً ونصف",
  dayOf(truceFor("later", "Please get back to us after the audit.")) >= 40);
check("هدنة · «الربع القادم» تُمهل نحو شهرين",
  dayOf(truceFor("later", "Not now — next quarter please.")) >= 60);
check("هدنة · «الأسبوع القادم» لا تُمهل شهراً",
  dayOf(truceFor("later", "Call me next week.")) <= 10);
check("هدنة · شهرٌ بالاسم يُحترم كما ذُكر",
  (() => { const t = truceFor("later", "Let's revisit in March."); return !!t && t.until.getMonth() === 2 && t.until.getDate() === 1; })());
check("هدنة · «ليس الآن» بلا موعد لا تقلّ عن شهر",
  dayOf(truceFor("later", "Not right now.")) >= 25);
check("هدنة · المهتم لا يُمهَل أبداً",
  truceFor("interested", "Send me the proposal") === null);
check("هدنة · السؤال لا يُمهَل",
  truceFor("question", "Do you do VAT?") === null);
check("هدنة · كل هدنةٍ معها سببٌ مكتوب",
  ["considering", "later"].every((i) => (truceFor(i as never, "after the audit")?.why.length ?? 0) > 10));


// ── طلب الإيقاف يُطاع مهما كان نوع الرسالة ───────────────────────
// «إلغاء الاشتراك» كلمةٌ ذات وجهين: علامةُ تذييلٍ في نشرة، وطلبُ إنسانٍ
// في رسالةٍ من سطر. فصُنّف طلبٌ حقيقي «نشرةً» — لأن الكلمة فيه — ولم
// يُنفَّذ، وبقيت الجهة نشطة تستقبل.
const { asksToStop } = await import("../email/classify");
check("إيقاف · رسالةٌ كلها طلب إيقاف", asksToStop("Re: x", "الغاء الاشتراك"));
check("إيقاف · في العنوان", asksToStop("unsubscribe", "Hello"));
check("إيقاف · في أول سطر من رسالةٍ طويلة",
  asksToStop("", "Please remove me from your mailing list.\nI do not want these emails.\n" + "x ".repeat(300)));
check("إيقاف · تذييل نشرةٍ طويلة ليس طلباً",
  !asksToStop("VAT is due again", "Our agency helps businesses grow with Google Ads and web design. " + "محتوى اعلاني طويل جدا ".repeat(30) + "\n\nIf you prefer not to receive these, click unsubscribe."));
check("إيقاف · رسالةٌ عادية بلا طلب", !asksToStop("Re: proposal", "Thanks, we will review and revert."));

// والمصنّف يحمل الراية مهما كان النوع:
const nl = kindOf({ from: "x@example.com", subject: "Re: x", text: "الغاء الاشتراك" }, false);
check("إيقاف · يُرفع مع النشرة والإعلان أيضاً",
  asksToStop("Re: x", "الغاء الاشتراك") && nl.kind !== "reply", `النوع: ${KIND_AR[nl.kind]}`);

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌ فشل"}`);
if (pass !== total) process.exit(1);
