// مكتبة التعليمات: تغطية السجل، الأقسام الأربعة عشر، التمايز، الطول، عزل الحسابين، وموافقة شكل المخرج للمحلّلات.

export {};
const { PROMPT_LIBRARY, renderPrompt, SECTION_KEYS } = await import("../org/prompts/index");
const { ROLE_MAP, WORKER_MAP } = await import("../org/departments");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(62)} ${d}`); };

const keys = Object.keys(PROMPT_LIBRARY);
const FLORET = { name: "فلوريت للذهب والمجوهرات (FLORET JEWELRY)", vertical: "jewelry" };
const PROCOUNT = { name: "Pro Count for Accounting", vertical: "accounting" };
const OTHER = { name: "مطعم الأصيل", vertical: "restaurant" };
const LIMIT = 3500;

// ── التغطية ───────────────────────────────────────────────────────
const registry = Object.values(ROLE_MAP);
const withExecution = registry.filter((r) => r.execution !== "none").map((r) => r.key);
const missing = withExecution.filter((k) => !PROMPT_LIBRARY[k]);
check("every registry employee with an execution has an entry", missing.length === 0, missing.join(", "));
// الاستثناءات المكتوبة: لينكدإن بلا مشغّل، والعامل email_queue بلا نموذج.
const exceptions = registry.filter((r) => !PROMPT_LIBRARY[r.key]).map((r) => r.key);
check("the only registry exceptions are linkedin.*", exceptions.every((k) => k.startsWith("linkedin.")) && exceptions.length === 12, `${exceptions.length} مستثنى`);
check("workers carry no prompt", Object.values(WORKER_MAP).every((w) => !PROMPT_LIBRARY[w.key]));
check("no linkedin entry", !keys.some((k) => k.startsWith("linkedin.")));
check("the CEO is present", !!PROMPT_LIBRARY["executive.ceo"]);
check("instagram and tiktok have twelve each", keys.filter((k) => k.startsWith("instagram.")).length === 12 && keys.filter((k) => k.startsWith("tiktok.")).length === 12);
check("no entry for a key the registry does not know, but the CEO", keys.every((k) => k === "executive.ceo" || registry.some((r) => r.key === k)));

// ── الأقسام والنسخة ──────────────────────────────────────────────
const emptySections = keys.flatMap((k) => SECTION_KEYS.filter((s) => !PROMPT_LIBRARY[k]!.sections[s]?.trim()).map((s) => `${k}/${s}`));
check("all fourteen sections non-empty", SECTION_KEYS.length === 14 && emptySections.length === 0, emptySections.slice(0, 5).join(", "));
check("a version on every entry", keys.every((k) => Number.isInteger(PROMPT_LIBRARY[k]!.version) && PROMPT_LIBRARY[k]!.version >= 1));
check("externalBehavior is a boolean on every entry", keys.every((k) => typeof PROMPT_LIBRARY[k]!.externalBehavior === "boolean"));
for (const k of ["email.copywriter", "email.replies", "whatsapp.sales", "whatsapp.followup", "whatsapp.campaigns", "target_accounts.writer", "instagram.writer", "tiktok.dm"])
  check(`${k} is external`, PROMPT_LIBRARY[k]!.externalBehavior === true);
for (const k of ["email.registrar", "ops.monitor", "instagram.watcher", "tiktok.analyst"])
  check(`${k} is internal`, PROMPT_LIBRARY[k]!.externalBehavior === false);

// ── التمايز: كلمات المهمة وطريقة العمل، على الأضيق من الاثنين ──────
const wordsOf = (s: string) => new Set(s.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().split(" ").filter((w) => w.length > 1));
const bags = keys.map((k) => ({ k, w: wordsOf(`${PROMPT_LIBRARY[k]!.sections.mission} ${PROMPT_LIBRARY[k]!.sections.workflow}`) }));
let worst = { pair: "", v: 0 };
const tooClose: string[] = [];
for (let i = 0; i < bags.length; i++) for (let j = i + 1; j < bags.length; j++) {
  const a = bags[i]!, b = bags[j]!;
  const shared = [...a.w].filter((w) => b.w.has(w)).length;
  const v = shared / Math.min(a.w.size, b.w.size);
  if (v > worst.v) worst = { pair: `${a.k} × ${b.k}`, v };
  if (v > 0.6) tooClose.push(`${a.k}×${b.k}=${v.toFixed(2)}`);
}
check("no two prompts share over 60% of mission+workflow words", tooClose.length === 0, tooClose.slice(0, 5).join(", ") || `الأعلى ${worst.pair} ${worst.v.toFixed(2)}`);

// ── الطول ─────────────────────────────────────────────────────────
const lens = keys.flatMap((k) => [FLORET, PROCOUNT, OTHER].map((a) => ({ k: `${k}@${a.name.slice(0, 5)}`, n: renderPrompt(PROMPT_LIBRARY[k]!, a).length })));
const long = lens.filter((x) => x.n > LIMIT);
check(`every rendered prompt is at most ${LIMIT} characters`, long.length === 0, long.slice(0, 6).map((x) => `${x.k}=${x.n}`).join(", ") || `الأطول ${Math.max(...lens.map((x) => x.n))}`);

// ── العزل ─────────────────────────────────────────────────────────
const PROCOUNT_PRIVATE = /pro\s*-?count|بروكاونت|برو\s*كاونت|\bAML\b|\bCFT\b|\bgoAML\b|DNFBP|MLRO|DPMS|RERA|غسل الأموال|ضريب|محاسب|(?<![٠-٩])٨٠(?![٠-٩])|80\s*\/\s*20|054 232|أبوظبي|The Pro Count team/i;
const FLORET_PRIVATE = /floret|فلوريت|floret-royal|هلا وغلا|حبيت أطمّنك|مصنعية|غناتي|مدينة العين|تصفّحي التشكيلة/i;
const leaks = (re: RegExp, a: { name: string; vertical: string }) => keys.filter((k) => re.test(renderPrompt(PROMPT_LIBRARY[k]!, a)));
const floretLeaks = leaks(PROCOUNT_PRIVATE, FLORET);
check("Floret's text carries nothing of Pro Count", floretLeaks.length === 0, floretLeaks.slice(0, 6).map((k) => `${k}:${PROCOUNT_PRIVATE.exec(renderPrompt(PROMPT_LIBRARY[k]!, FLORET))?.[0]}`).join(" "));
const proLeaks = leaks(FLORET_PRIVATE, PROCOUNT);
check("Pro Count's text carries nothing of Floret", proLeaks.length === 0, proLeaks.slice(0, 6).map((k) => `${k}:${FLORET_PRIVATE.exec(renderPrompt(PROMPT_LIBRARY[k]!, PROCOUNT))?.[0]}`).join(" "));
const otherLeaks = keys.filter((k) => { const t = renderPrompt(PROMPT_LIBRARY[k]!, OTHER); return FLORET_PRIVATE.test(t) || PROCOUNT_PRIVATE.test(t); });
check("a third account inherits neither", otherLeaks.length === 0, otherLeaks.slice(0, 6).join(", "));
const rawLeaks = keys.filter((k) => Object.values(PROMPT_LIBRARY[k]!.sections).some((s) => FLORET_PRIVATE.test(s) || PROCOUNT_PRIVATE.test(s)));
check("the shared sections name neither account", rawLeaks.length === 0, rawLeaks.slice(0, 6).join(", "));
check("a third jewellery shop gets the rules without Floret's link", (() => { const t = renderPrompt(PROMPT_LIBRARY["whatsapp.sales"]!, { name: "ذهب النخبة", vertical: "jewelry" }); return /لا سعر ولا وزن/.test(t) && !FLORET_PRIVATE.test(t); })());
check("the account's name is filled in", renderPrompt(PROMPT_LIBRARY["email.director"]!, PROCOUNT).includes("Pro Count for Accounting") && !renderPrompt(PROMPT_LIBRARY["email.director"]!, PROCOUNT).includes("{account}"));

// ── قواعد صاحب العمل ─────────────────────────────────────────────
const floretRules: Array<[string, RegExp]> = [
  ["no price, weight, discount", /لا سعر ولا وزن ولا سعر ذهب اليوم ولا مصنعية ولا خصم في أي رسالة/],
  ["no endearment", /ممنوع منعاً باتاً أي تحبّب: حبيبتي، حبيبي، صاحبتي، قلبي، عمري، روحي، حياتي، يا قمر، يا عسل، غناتي/],
  ["«هلا وغلا» refused", /«هلا وغلا» و«حبيت أطمّنك» — صاحب العمل رفضهما/],
  ["the site link", /https:\/\/floret-royal\.io/],
  ["Gulf Arabic", /خليجية/],
];
for (const [n, re] of floretRules) {
  const missed = keys.filter((k) => !re.test(renderPrompt(PROMPT_LIBRARY[k]!, FLORET)));
  check(`Floret: ${n} in every prompt`, missed.length === 0, missed.slice(0, 4).join(", "));
}
const pro = (k: string) => renderPrompt(PROMPT_LIBRARY[k]!, PROCOUNT);
check("Pro Count: no fabricated numbers in every prompt", keys.every((k) => /اختراع قانون أو نسبة أو غرامة أو مهلة أو سعر/.test(pro(k))));
check("Pro Count: the 80/20 policy where it binds", ["email.director", "email.strategist", "email.analyst"].every((k) => /٨٠/.test(pro(k))));
check("Pro Count: English for writers", ["email.copywriter", "email.followup", "email.replies", "email.creator", "target_accounts.writer"].every((k) => /بالإنجليزية/.test(pro(k))));
check("the writer's numbers survive verbatim", /٤٠–٩٠ كلمة \(١١٠ مع التفاصيل\)، والمتابعة ٥٠–٧٠/.test(pro("email.copywriter")));
check("the guard's bounce rule survives verbatim", /الارتداد فوق ٢٪ أو بلاغ إزعاج \(حد Google ٠٫٣٪\) أو رفض المزوّد لرسائلنا يعني الإيقاف قبل أن يُحرق النطاق/.test(pro("email.guard")));

// ── شكل المخرج يطابق ما تقرؤه الشيفرة ─────────────────────────────
const { parseDraft } = await import("../email/agent");
const { parseReview } = await import("../graph/review");
const schema = (k: string) => PROMPT_LIBRARY[k]!.sections.outputSchema;
for (const k of ["email.copywriter", "email.followup", "email.creator"]) check(`${k}: the writer's blocks`, ["[عنوان]", "[الرسالة]", "[/الرسالة]", "[ملخص]", "[زر]", "[متابعة بعد=72 جمهور=دافئ]", "[/متابعة]", "[السبب]"].every((m) => schema(k).includes(m)));
check("a draft in the documented shape parses", !!parseDraft("[عنوان] one two\n[عنوان] three four\n[الرسالة]\nHello,\n\n[ملخص] A line about their files before an inspector reads them.\n\n[زر] Worth a look?\n[/الرسالة]\n[السبب] why")?.html);
for (const k of ["email.registrar", "email.data", "email.retarget", "email.opens", "email.analyst"]) check(`${k}: the specialists' shape`, ["الحكم:", "الأهم:", "التفاصيل:", "الخطوة:"].every((m) => schema(k).includes(m)));
for (const k of ["email.director", "executive.chief"]) check(`${k}: the manager's shape`, ["الحكم:", "فعلتُ:", "قرّرتُ:", "يحتاجك:"].every((m) => schema(k).includes(m)));
const jsonIn = (k: string) => JSON.parse(/\{[\s\S]*\}/.exec(schema(k).split("\nإن لم")[0]!.split("\nثلاثة")[0]!.split("\nوفي")[0]!)![0]!);
check("نوف's JSON parses with the people field", Array.isArray(jsonIn("target_accounts.analyst").people) && "isDecisionMaker" in jsonIn("target_accounts.analyst").people[0]);
check("the writer's JSON has the five fields", ["subject", "body", "followup2", "followup3", "linkedin"].every((f) => f in jsonIn("target_accounts.writer")));
check("the campaign JSON has variants", Array.isArray(jsonIn("whatsapp.campaigns").variants));
check("the playbook JSON has the five lists", ["questions", "objections", "works", "avoid", "campaignIdeas"].every((f) => f in jsonIn("whatsapp.chat_lead")));
check("the review shape parses", parseReview(`{"label":"hot","score":70,"piece":null,"summary":"x","next":"y"}`)?.label === "hot" && ["label", "score", "piece", "summary", "next"].every((f) => schema("shared.collector").includes(`"${f}"`) || schema("shared.collector").includes(`\\"${f}\\"`)));
check("the group's blocks", ["[يحتاج رد]", "[الرد]", "[/الرد]", "[السبب]"].every((m) => schema("whatsapp.groups").includes(m)));
for (const p of ["instagram", "tiktok"]) check(`${p}.triage: the four lines and the code's labels`, ["النوع:", "فرصة:", "الحرارة:", "السبب:", "question", "interested", "praise", "complaint", "spam", "stop", "other"].every((m) => schema(`${p}.triage`).includes(m)));
check("the DM's refusal mark", ["instagram.dm", "tiktok.dm"].every((k) => schema(k).includes("(لا رد)")));
check("tiktok's script sections", ["الخطّاف", "المشاهد:", "الختام:", "الوصف:"].every((m) => schema("tiktok.creator").includes(m)));
check("the engineer's actions block", schema("executive.engineer").includes("```actions"));
check("the email statuses are the code's", ["published", "verified", "catchall", "guessed", "invalid"].every((m) => schema("target_accounts.email_finder").includes(m)));
check("the vetter's verdicts are the code's", ["ready", "hold", "rejected"].every((m) => schema("whatsapp.vetter").includes(m)));
check("the proposal's HTML and blanks", schema("shared.proposals").includes("HTML") && PROMPT_LIBRARY["shared.proposals"]!.sections.decisionFramework.includes("[[السعر]]"));
for (const f of ["executive_summary", "period", "account_id", "department_performance", "employee_alerts", "operational_risks", "revenue_opportunities", "resource_issues", "top_priorities", "recommended_actions", "actions_requiring_approval", "previous_improvement_results"])
  check(`the CEO's field ${f}`, schema("executive.ceo").includes(f));

// ── السقوف تختلف فعلاً بين المنصتين ─────────────────────────────────
const { PLATFORM } = await import("../social/platforms");
check("instagram's caps are its own", PROMPT_LIBRARY["instagram.manager"]!.sections.decisionFramework.includes(`رد ${PLATFORM.instagram.caps.reply}`));
check("tiktok's caps are its own", PROMPT_LIBRARY["tiktok.manager"]!.sections.decisionFramework.includes(`رد ${PLATFORM.tiktok.caps.reply}`));
// الناقل والمحلل لهما محرّك الآن (النسخة 2): تعليماتهما تسمّي الدالة ولا تقول «بلا محرّك».
check("inviter and analyst name their engine (v2)", ["instagram.inviter", "tiktok.analyst"].every((k) => PROMPT_LIBRARY[k]!.version === 2 && !/بلا محرّك/.test(PROMPT_LIBRARY[k]!.sections.identity))
  && /inviteCommenters/.test(PROMPT_LIBRARY["instagram.inviter"]!.sections.approvedTools) && /runEngagementAnalysis/.test(PROMPT_LIBRARY["tiktok.analyst"]!.sections.approvedTools));

console.log(`\n${pass}/${total} passed`);
if (pass !== total) process.exit(1);
process.exit(0);
