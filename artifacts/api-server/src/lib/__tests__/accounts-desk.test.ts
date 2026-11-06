export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const P = await import("../accounts/pure");
const { senderFirstName } = await import("../accounts/pipeline");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };

// ── نمط البريد ───────────────────────────────────────────────────
check("h.khan → {f}.{last}", P.patternOf("h.khan@x.com") === "{f}.{last}");
check("catalin → {first}", P.patternOf("catalin@x.com") === "{first}");
check("john.smith → {first}.{last}", P.patternOf("john.smith@x.com") === "{first}.{last}");
check("info@ بلا نمط", P.patternOf("info@x.com") === null);
check("اسمٌ معروف يحسم: jsmith = {f}{last}", P.patternOf("jsmith@x.com", ["John Smith"]) === "{f}{last}");
check("نمط الشركة: الأغلب", P.domainPattern(["h.khan@x.com", "a.rao@x.com", "sara@x.com", "info@x.com"]) === "{f}.{last}");
check("لا عناوين شخصية ← لا نمط", P.domainPattern(["info@x.com", "sales@x.com"]) === null);
check("Al Mansoori → almansoori", P.renderPattern("{first}.{last}", "Ahmed Al Mansoori", "x.ae") === "ahmed.almansoori@x.ae");
check("بلا اسم عائلة لا نمط يحتاجه", P.renderPattern("{f}.{last}", "Catalin", "x.ae") === null);

const c1 = P.emailCandidates("Hamza Khan", "x.com", { published: ["info@x.com", "hamza@x.com"], pattern: "{f}.{last}" });
check("المنشور أولاً ثم نمط الشركة", c1[0] === "hamza@x.com" && c1[1] === "h.khan@x.com", c1.join(" "));
const c2 = P.emailCandidates("Hamza Khan", "x.com", { pattern: "{f}.{last}" });
check("بلا منشور: النمط ثم الشائعة بلا تكرار", c2[0] === "h.khan@x.com" && c2.includes("hamza@x.com") && c2.includes("hamza.khan@x.com") && c2.includes("hkhan@x.com") && new Set(c2).size === c2.length, c2.join(" "));
check("الحد الأقصى خمسة", P.emailCandidates("Ahmed Al Mansoori", "x.ae").length <= 5);
check("عنوانٌ منشور لشخصٍ آخر لا يُنسب له", P.personalMatch(["sara@x.com"], "Hamza Khan", "x.com") === null);
check("العنوان العام: info أولاً", P.roleAddress(["sales@x.com", "info@x.com", "h.khan@x.com"], "x.com") === "info@x.com");
check("استخراج العناوين: mailto و [at] بلا صور", (() => {
  const e = P.extractEmails(`<a href="mailto:Info@X.com">x</a> h.khan [at] x.com <img src="logo@2x.png"> john@example.com`);
  return e.includes("info@x.com") && e.includes("h.khan@x.com") && !e.some((x) => x.includes("png")) && !e.includes("john@example.com");
})());

// ── لا اسم إلا ما رأيناه ─────────────────────────────────────────
const src = "Our Team\nMohammed Al Hashimi — Managing Director\nSara Ahmed, Compliance Officer (MLRO)\nhttps://www.linkedin.com/in/sara-ahmed-123";
const g = P.groundPeople([
  { name: "Mohammed Al Hashimi", title: "Managing Director", isDecisionMaker: false },
  { name: "Sara Ahmed", title: "MLRO", isDecisionMaker: true, linkedinUrl: "https://www.linkedin.com/in/sara-ahmed-123" },
  { name: "John Invented", title: "CEO", isDecisionMaker: true },
  { name: "Mohammed Al Hashimi", title: "dup" },
  { name: "Ali", title: "CFO" },
], src);
check("الاسم المخترع يُحذف", !g.some((p) => p.name === "John Invented"));
check("المكرر والاسم المفرد يُحذفان", g.length === 2, g.map((p) => p.name).join(" | "));
check("صاحب قرارٍ واحد بالضبط", g.filter((p) => p.isDecisionMaker).length === 1 && g.find((p) => p.isDecisionMaker)!.name === "Sara Ahmed");
check("لينكدإن الذي رأيناه يبقى", g.find((p) => p.name === "Sara Ahmed")!.linkedinUrl === "https://www.linkedin.com/in/sara-ahmed-123");
const g2 = P.groundPeople([{ name: "Mohammed Al Hashimi", linkedinUrl: "https://www.linkedin.com/in/made-up" }], src);
check("لينكدإن لم نره يُفرَّغ", g2[0]?.linkedinUrl === null);
check("كلمة كاملة: Ali Khan ليس في Mali Khanna", !P.nameInSource("Ali Khan", "Mali Khanna joined"));
check("الحروف والفراغات لا تهم", P.nameInSource("sara  ahmed", "SARA AHMED, MLRO"));
check("لقبٌ ليس اسماً", !P.looksLikeName("Managing Director"));

// ── ترتيب الشركات ────────────────────────────────────────────────
const rows = [
  { domain: "a.ae", company: "A", city: "Abu Dhabi", sector: "عقارات", addresses: 9, engaged: false },
  { domain: "b.ae", company: "B", city: "Dubai", sector: "عقارات", addresses: 2, engaged: false },
  { domain: "c.ae", company: "C", city: "Sharjah", sector: "عقارات", addresses: 1, engaged: true },
  { domain: "d.ae", company: "D", city: "Dubai", sector: "عقارات", addresses: 5, engaged: false },
];
const ranked = P.rankCandidates(rows).map((r) => r.domain).join(",");
check("من تفاعل ← دبي ← الأكبر", ranked === "c.ae,d.ae,b.ae,a.ae", ranked);
check("فلتر الإمارة", P.rankCandidates(rows, ["Abu Dhabi"]).map((r) => r.domain).join(",") === "a.ae");
check("اسم الشركة بلا L.L.C", P.shortCompany("EMAAR PROPERTIES L.L.C", "emaar.com") === "Emaar Properties", P.shortCompany("EMAAR PROPERTIES L.L.C", "emaar.com"));
check("بلا اسم: من النطاق", P.shortCompany(null, "dubaihomes.ae") === "Dubaihomes");

// ── الإشارة ──────────────────────────────────────────────────────
const html = `<html><body><header><a href="/about">About</a></header><script>var launch=1</script>
<h1>Welcome</h1><p>We are a boutique brokerage.</p><p>We are proud to announce the launch of Marina Heights, our new project in Dubai Marina.</p>
<footer>ORN 12345 · RERA registered</footer></body></html>`;
const sig = P.extractSignal([{ url: "https://x.ae/", text: P.visibleText(html) }]);
check("الإطلاق قبل الترخيص، بجملته ورابطه", sig?.kind === "launch" && sig.text.includes("Marina Heights") && sig.source === "https://x.ae/", sig?.text ?? "");
check("النص بلا سكربت والتذييل باقٍ", !P.visibleText(html).includes("var launch") && P.visibleText(html).includes("ORN 12345"));
const sig2 = P.extractSignal([{ url: "https://y.ae/contact", text: P.visibleText("<footer>Licensed by RERA, ORN 4567. Office 12, Business Bay.</footer>") }]);
check("الترخيص إشارةٌ حين لا غيره", sig2?.kind === "licence");
check("لا إشارة ← null", P.extractSignal([{ url: "https://z.ae", text: "Welcome to our website. We sell homes." }]) === null);
check("صفحات الفريق قبل التواصل والمدونة خارجاً", (() => {
  const p = P.pickPages(["https://x.ae/contact-us", "https://x.ae/blog/post-1", "https://x.ae/our-team", "https://x.ae/about-us", "https://x.ae/careers", "https://x.ae/"]);
  return p[0] === "https://x.ae/our-team" && p[1] === "https://x.ae/about-us" && !p.some((u) => u.includes("blog")) && !p.includes("https://x.ae");
})());

// ── لينكدإن والكتابة ─────────────────────────────────────────────
const long = "Hi Sara, I saw Marina Heights launch this week — congratulations. ".repeat(8);
const note = P.clampNote(long);
check("ملاحظة لينكدإن ≤ ٢٨٠", note.length <= 280 && note.endsWith("…"), String(note.length));
check("القصيرة كما هي", P.clampNote("Hi Sara, congrats on the launch.") === "Hi Sara, congrats on the launch.");
check("رابط بحث لينكدإن", P.linkedinSearchUrl("Sara Ahmed", "Emaar") === "https://www.linkedin.com/search/results/people/?keywords=Sara%20Ahmed%20Emaar");

const good: import("../accounts/pure").Written = {
  subject: "Marina Heights and goAML",
  body: "Hi Sara,\n\nCongratulations on the Marina Heights launch at Emaar — a new project usually brings a wave of new buyers to screen.\n\nReal estate brokers and developers in the UAE are DNFBPs and report suspicious transactions through goAML, so each new buyer needs due diligence on file before the sale closes.\n\nIs buyer screening for the launch handled in-house, or shared with an outside team?\n\nAhmed, Pro Count",
  followups: [{ afterDays: 3, subject: "Re", body: "Hi Sara, one more thought: cash buyers on off-plan units are where reviewers look first. Is that covered in your current checks?" }, { afterDays: 7, subject: "Re", body: "Hi Sara, I will leave it here. If AML support is ever useful, I am a reply away." }],
  linkedin: "Hi Sara, saw the Marina Heights launch — congratulations. I work with UAE real-estate teams on AML compliance and would be glad to connect.",
};
check("مسودة سليمة بلا ملاحظات", P.writingIssues(good, "Emaar").length === 0, P.writingIssues(good, "Emaar").join("؛ "));
const bad = { ...good, subject: "Quick question about your AML compliance programme today", body: good.body.replace("Is buyer screening", "Can we book a 15 minute call? Buyer screening") };
const bi = P.writingIssues(bad, "Emaar");
check("عنوان طويل وطلب موعد يُرفضان", bi.some((x) => x.includes("العنوان")) && bi.some((x) => x.includes("موعد")), bi.join("؛ "));
check("قراءة رد الكاتبة", (() => {
  const w = P.readWritten({ subject: "Hi", body: "b", followup2: { subject: "s2", body: "f2" }, followup3: { body: "f3" }, linkedin: "n" });
  return !!w && w.followups[0]!.afterDays === 3 && w.followups[1]!.afterDays === 7 && w.followups[1]!.subject === "Re: Hi";
})());
check("اسم المرسل الأول", senderFirstName("Ahmed from Pro Count") === "Ahmed" && senderFirstName("Pro Count") === "The team");
check("يوم دبي وأيام العمل", (() => {
  const fri = P.dubaiNow(new Date("2026-11-06T05:00:00Z")), sat = P.dubaiNow(new Date("2026-11-07T05:00:00Z"));
  return fri.date === "2026-11-06" && fri.hour === 9 && fri.weekday && !sat.weekday;
})());

// ── Cloudflare يُخفي العناوين (من موقع valtisproperties.com كما هو) ──
check("فك عنوانٍ محميّ", P.decodeCfEmail("ef86818980af998e839b869c9f9d809f8a9d9b868a9cc18c8082") === "info@valtisproperties.com");
check("العناوين المحمية تُستخرج من الصفحة", P.extractEmails('<a href="/cdn-cgi/l/email-protection#ef86818980af998e839b869c9f9d809f8a9d9b868a9cc18c8082">x</a>').includes("info@valtisproperties.com"));
check("سلسلة تالفة لا تُنتج عنواناً", P.decodeCfEmail("zz12") === null && P.decodeCfEmail("abc") === null);

console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
