// الظل والمحاكاة وحقول المدير وإصلاحات المسار D. الجزء الأول بلا قاعدة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-shadow.test.ts
// والبقية على قاعدة الاختبار وحدها، بلا شبكة ولا إرسال ولا نموذج حقيقي:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55447/t npx tsx src/lib/__tests__/org-shadow.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

let fetched = 0;
globalThis.fetch = (async (url: any) => { fetched++; throw new Error(`no network in this test: ${url}`); }) as any;
process.env["GEMINI_API_KEY"] = "test-key";
process.env["GROQ_API_KEY"] = "test-key";

const SIM = await import("../org/simulation");
const SH = await import("../org/shadow");
const { ORG_SIM_SQL } = await import("../org/sim-schema");
const C = await import("../org/ceo");
const R = await import("../org/readiness");
const { corePrompt } = await import("../prompt-core");
const { personaPreamble } = await import("../agent-router");
const { gateSend } = await import("../org/gateway");
const { listPlans } = await import("../../routes/plans");
const E = await import("../org/sandbox-e2e");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

// ── بلا قاعدة ─────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(["075_shadow.sql", "080_shadow_verdicts.sql"].map((f) => readFileSync(join(here, `../../../../../lib/db/migrations/${f}`), "utf8")).join("\n"));
check("075 و080 يحملان كل عبارة في ORG_SIM_SQL", ORG_SIM_SQL.every((q) => mig.includes(norm(q))), ORG_SIM_SQL.find((q) => !mig.includes(norm(q))));

// الحكم بالكود
const ok = (text: string) => ({ text, issues: [] as string[] });
const bad = (text: string, ...issues: string[]) => ({ text, issues });
check("المقترح لم يكتب: no_output", SH.verdictOf(ok("x"), { text: null, issues: [] }).verdict === "no_output");
check("أصلح قاعدةً وجاء بأخرى: mixed", SH.verdictOf(bad("x", "a"), bad("y", "b")).verdict === "mixed");
check("الحالي سليم والمقترح خالف: failed_checks", SH.verdictOf(ok("x"), bad("y", "b")).verdict === "failed_checks");
check("الحالي لم يكتب والمقترح خالف: failed_checks", SH.verdictOf({ text: null, issues: [] }, bad("y", "b")).verdict === "failed_checks");
check("الحالي خالف والمقترح سليم: better", SH.verdictOf(bad("x", "a"), ok("y")).verdict === "better");
check("الحالي لم يكتب والمقترح سليم: better", SH.verdictOf({ text: null, issues: [] }, ok("y")).verdict === "better");
check("كلاهما سليم: same", SH.verdictOf(ok("x"), ok("y")).verdict === "same");
check("تصنيفٌ بلا نص يُعدّ مخرجاً", SH.verdictOf(ok("x"), { text: null, label: "hot", issues: [] }).verdict === "same");

// ── الحكم بالقواعد على أمثلة الإنتاج الحية (shadow_runs، 2026-11-10، الحساب ٢) ──
// النصوص من الفحوص الحقيقية نفسها، لا منسوخة: إن تغيّرت صياغة فحصٍ فشل الاختبار هنا.
const TEAM = await import("../email/team");
const { writingIssues } = await import("../accounts/pure");
const { LABELS } = await import("../graph/review");
const mail = (n: number, lead = true) => `${lead ? `<p class="lead">${"word ".repeat(20)}</p>` : ""}<p>${"word ".repeat(Math.max(0, n - (lead ? 20 : 0)))}</p><p class="cta"><a href="#">Reply</a></p>`;
const len = (n: number, kind: "first" | "followup") => TEAM.formatIssues(mail(n), kind);
const KNOW = "Pro Count knowledge: AML/CFT obligations depend on activity. goAML registration.";
const num = (t: string) => TEAM.guardCheck([t], KNOW);
check("الفحص الحقيقي: ١٢٦ و١٢١ كلمة يخالفان الطول، والمبلغ المخترع رقمٌ ليس في المعرفة",
  len(126, "first").length === 1 && len(121, "first").length === 1 && num("AED 55,000.").some((i) => /رقم ليس في معرفة الشركة/.test(i)));
check("issueRule: الرقم ليس القاعدة", SH.issueRule(len(126, "first")[0]!) === "length" && SH.issueRule(len(121, "first")[0]!) === "length"
  && SH.issueRule(num("AED 42")[0]!) === SH.issueRule(num("AED 18.5")[0]!) && SH.issueRule("صنّف machine والمسجَّل not_customer") === "label:machine≠not_customer");
const out = (...issues: string[]) => ({ text: "x", issues });
// الكاتب
check("الكاتب: ١٢١ ثم ١٢٦ كلمة = same لا failed_checks", SH.verdictOf(out(...len(121, "first")), out(...len(126, "first"))).verdict === "same");
check("الكاتب: الطول نفسه + AED 55,000 مخترع = failed_checks", SH.verdictOf(out(...len(121, "first")), out(...len(126, "first"), ...num("AED 55,000."))).verdict === "failed_checks");
check("الكاتب: الحالي سليم والمقترح ١٢٦ = failed_checks", SH.verdictOf(out(...len(80, "first")), out(...len(126, "first"))).verdict === "failed_checks");
check("الكاتب: الحالي ١٢٦ والمقترح سليم = better", SH.verdictOf(out(...len(126, "first")), out(...len(80, "first"))).verdict === "better");
// المتابعة
check("المتابعة: ٨٧/٩٦/١١٢ تخالف حد ٧٠ الحقيقي", [87, 96, 112].every((n) => len(n, "followup").length === 1));
check("المتابعة: ٩٦ ثم ١١٢ = same", SH.verdictOf(out(...len(96, "followup")), out(...len(112, "followup"))).verdict === "same");
const noLead = TEAM.formatIssues(mail(87, false), "followup");
check("المتابعة: فقد [ملخص] مع الطول = failed_checks", noLead.some((i) => /لا ملخص/.test(i)) && SH.verdictOf(out(...len(96, "followup")), out(...noLead)).verdict === "failed_checks");
check("المتابعة: AED 42 مقابل AED 18.5 مع الطول = same", SH.verdictOf(out(...len(96, "followup"), ...num("AED 42")), out(...len(112, "followup"), ...num("AED 18.5"))).verdict === "same");
check("المتابعة: أسقط الرقم المخترع وبقي الطول = better", SH.verdictOf(out(...len(96, "followup"), ...num("AED 42")), out(...len(87, "followup"))).verdict === "better");
// الردود
const best = TEAM.guardCheck(["We are the best partner.", "Simply the best."], KNOW), urgent = TEAM.guardCheck(["This is urgent."], KNOW);
check("الردود: best مرتين في الحالي و urgent في المقترح = mixed", best.length === 1 && urgent.length === 1 && SH.verdictOf(out(...best), out(...urgent)).verdict === "mixed");
const mixedV = SH.verdictOf(out(...best), out(...urgent));
check("mixed يقول ما أصلح وما جاء به", /best/.test(mixedV.detail) && /urgent/.test(mixedV.detail), mixedV.detail);
// كاتب الحسابات
const written = (body: string) => ({ subject: "Compliance at Emaar", body, followups: [{ afterDays: 3, subject: "Re", body: "Short follow up here?" }, { afterDays: 7, subject: "Re", body: "Closing note?" }], linkedin: "Saw the news." });
const body = (first: string) => `${first} ${"We help firms keep their records ready for review and answer the questions that come with it. ".repeat(4)}Would that be useful for your team this quarter?`;
const named = writingIssues(written(body("Emaar Properties announced a new fund last week.")), "Emaar Properties");
const unnamed = writingIssues(written(body(`${"Real estate firms across the UAE face new rules this year and many teams feel it. ".repeat(4)}`)), "Emaar Properties");
check("كاتب الحسابات: أول سطر لا يسمّي الشركة = failed_checks (٣/٣ في الإنتاج)", !named.some((i) => /لا يذكر شركته/.test(i)) && unnamed.some((i) => /لا يذكر شركته/.test(i))
  && SH.verdictOf(out(...named), out(...unnamed)).verdict === "failed_checks", { named, unnamed });
// ريم
check("ريم: machine مقابل not_customer في الاثنين = same", "machine" in LABELS && "not_customer" in LABELS && SH.verdictOf(out("صنّف machine والمسجَّل not_customer"), out("صنّف machine والمسجَّل not_customer")).verdict === "same");
check("ريم: الحالي machine والمقترح hot (والمسجَّل not_customer) = mixed", SH.verdictOf(out("صنّف machine والمسجَّل not_customer"), out("صنّف hot والمسجَّل not_customer")).verdict === "mixed");
check("ريم: الحالي أصاب والمقترح hot = failed_checks", SH.verdictOf({ text: "x", label: "not_customer", issues: [] }, out("صنّف hot والمسجَّل not_customer")).verdict === "failed_checks");
const sumM = SH.summarize([{ verdict: "same" }, { verdict: "mixed" }]);
check("mixed: عيّنة، وإنذار، وليس ok", sumM.samples === 2 && !sumM.ok && /مختلط/.test(sumM.warnings.join()));
const sumU = SH.summarize([{ verdict: "not_covered" }]);
check("not_covered: «لم يُجرَّب» وليس ok", !sumU.ok && /لم يُجرَّب/.test(sumU.warnings.join()));

// ── التغطية: لا موظف له complete() في مساره يُكتب no_model_path ──
const MP = await import("../org/model-paths");
const { PROMPT_LIBRARY } = await import("../org/prompts");
const libDir = join(here, "..");
const src = (f: string) => readFileSync(join(libDir, f), "utf8");
const bodyOf = (text: string, name: string) => {
  const i = text.search(new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`));
  if (i < 0) return null;
  const j = text.indexOf("\n}\n", i);
  return text.slice(i, j < 0 ? undefined : j + 2);
};
// نداءٌ مباشر، أو complete ممرَّراً قيمةً (ceo.ts: llm = complete ثم llm(...)).
const CALL = /\bcomplete\(|(?:=|\?\?)\s*complete\b/;
/** ما في هذا الجزء من نداء نموذج: مباشرةً، أو عبر دالةٍ محلية يستدعيها (تُتبع)، أو دالةٍ مستوردة
 * (اسماً أو بمساحة اسم) في جسمها complete(. */
function modelCallsIn(spec: string, seen = new Set<string>()): string[] {
  if (seen.has(spec)) return [];
  seen.add(spec);
  const [file, fn] = spec.split(":");
  const whole = src(file!);
  const text = fn ? bodyOf(whole, fn) ?? "" : whole;
  const hits: string[] = [];
  if (CALL.test(text)) hits.push(`${spec}: complete(`);
  if (fn) for (const c of new Set([...text.matchAll(/\b(\w+)\(/g)].map((x) => x[1]!))) {
    if (c !== fn && bodyOf(whole, c)) hits.push(...modelCallsIn(`${file}:${c}`, seen));
  }
  const dir = dirname(join(libDir, file!));
  for (const m of whole.matchAll(/import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+))\s+from\s+"(\.[^"]+)"/g)) {
    const rel = [`${m[3]}.ts`, `${m[3]}/index.ts`].map((x) => relative(libDir, join(dir, x))).find((x) => { try { src(x); return true; } catch { return false; } });
    if (!rel || rel.startsWith("..")) continue;
    const mod = src(rel);
    if (!CALL.test(mod)) continue;
    const named = (m[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [orig, alias] = x.replace(/^type\s+/, "").split(/\s+as\s+/); return [orig!, alias ?? orig!] as const; });
    const used = m[1] ? named.filter(([, alias]) => new RegExp(`\\b${alias}\\(`).test(text)).map(([orig, alias]) => [orig, alias] as const)
      : [...text.matchAll(new RegExp(`\\b${m[2]}\\.(\\w+)\\(`, "g"))].map((u) => [u[1]!, `${m[2]}.${u[1]}`] as const);
    // الدالة المستوردة تُتبع هي أيضاً: agent.draftReply ← ask ← complete(.
    for (const [orig, shown] of used) if (bodyOf(mod, orig) && modelCallsIn(`${rel}:${orig}`, seen).length) hits.push(`${spec} → ${shown}()`);
  }
  return hits;
}
const libKeys = Object.keys(PROMPT_LIBRARY);
check("الخريطة تغطي كل موظف في المكتبة", libKeys.every((k) => MP.MODEL_PATHS[k]), libKeys.filter((k) => !MP.MODEL_PATHS[k]));
const lying = libKeys.filter((k) => MP.isCodeOnly(k)).flatMap((k) => MP.MODEL_PATHS[k]!.files.flatMap((f) => modelCallsIn(f)).map((h) => `${k}: ${h}`));
check("بالكود وحده: لا complete() في مساره ولا في ما يستدعيه", lying.length === 0, lying);
const unproven = libKeys.filter((k) => !MP.isCodeOnly(k) && !MP.MODEL_PATHS[k]!.files.some((f) => CALL.test(src(f.split(":")[0]!))));
check("له نموذج: complete() في أحد ملفاته فعلاً", unproven.length === 0, unproven);
check("المختصون والتشغيل لهم نموذج (يصوغون تقاريرهم)", ["email.registrar", "email.opens", "ops.controller", "executive.ceo", "executive.chief", "email.director", "email.creator", "email.strategist", "instagram.analyst"].every((k) => !MP.isCodeOnly(k)));
const noPath = libKeys.filter((k) => !SH.SHADOW_KEYS.includes(k) && SH.uncoveredVerdict(k).verdict === "no_model_path");
check("no_model_path لمن هو بالكود وحده فقط", noPath.every((k) => MP.isCodeOnly(k)) && noPath.includes("ops.monitor") && noPath.includes("whatsapp.vetter"), noPath);
check("من له نموذج ولا مسار ظل: not_covered «لم يُجرَّب»", libKeys.filter((k) => !SH.SHADOW_KEYS.includes(k) && !MP.isCodeOnly(k)).every((k) => SH.uncoveredVerdict(k).verdict === "not_covered" && /لم يُجرَّب/.test(SH.uncoveredVerdict(k).detail)));
check("الظل يغطي المدير التنفيذي والمنشئ", SH.SHADOW_KEYS.includes("executive.ceo") && SH.SHADOW_KEYS.includes("email.creator"));

const sum0 = SH.summarize([]);
check("لا تشغيل: إنذار", sum0.warnings.length === 1 && !sum0.ok);
const sumNo = SH.summarize([{ verdict: "no_samples" }]);
check("لا عيّنات: إنذار", /لا عيّنات/.test(sumNo.warnings.join()) && !sumNo.ok);
const sumF = SH.summarize([{ verdict: "same" }, { verdict: "failed_checks" }]);
check("خالف في عيّنة: إنذار، وليس ok", /خالف/.test(sumF.warnings.join()) && !sumF.ok && sumF.samples === 2);
check("كلها سليمة: ok بلا إنذار", SH.summarize([{ verdict: "same" }, { verdict: "better" }]).ok && !SH.summarize([{ verdict: "same" }]).warnings.length);
check("بلا مسار: إنذار يقوله", /لا مسار/.test(SH.summarize([{ verdict: "no_model_path" }]).warnings.join()));
check("السقف والعيّنات كما في المواصفة (٦٠ منذ 2026-11-11)", SH.SHADOW_DAILY_CALLS === 60 && SH.SHADOW_MAX_SAMPLES === 3);

// ── المتابعة (2026-11-11، الحساب ٢): ٣ عيّنات no_output والمخرجان فارغان ──
// السبب في الحزام لا في التعليمات: موجة يوسف طُلبت بقالب الرسالة الأولى ([تفاصيل]، ٤٠–٩٠ كلمة)
// بجانب صنعة المتابعة وشخصيته («بلا قسم تفاصيل»)، فيجيب النموذج بشكل المتابعة — كتل [متابعة]
// وحدها أو «Subject:» ونصاً بلا [الرسالة] — وparseDraft يقرأ ذلك null للاثنين.
const AG = await import("../email/agent");
const FU_WORDS = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const FU_ONLY = `[عنوان] Source of funds at {{company|your firm}}\n[متابعة بعد=72 جمهور=دافئ]\nعنوان: One question on files\nHello {{first_name|there}},\n[ملخص] ${FU_WORDS(30)}\n[زر] Send me the checklist\nBest regards,\nThe Pro Count team\n[/متابعة]\n[متابعة جمهور=وداع]\nعنوان: Closing the loop\nLast note from us.\n[/متابعة]\n[السبب] new angle`;
const SUBJ_ONLY = `Subject: One question on files\n\nHello {{first_name|there}},\n[ملخص] ${FU_WORDS(30)}\n[زر] Send me the checklist\nBest regards,\nThe Pro Count team\n[السبب] new angle`;
check("الرسالة الأولى كما كانت: بلا [الرسالة] لا مسودة", AG.parseDraft(FU_ONLY) === null && AG.parseDraft(SUBJ_ONLY) === null);
const fu1 = AG.parseDraft(FU_ONLY, { followup: true });
check("المتابعة: أول كتلة [متابعة] هي الجسم، والباقي متابعاتها", !!fu1 && fu1.subjects[0] === "Source of funds at {{company|your firm}}" && /class="lead"/.test(fu1.html) && /class="cta"/.test(fu1.html)
  && fu1.followups.length === 1 && fu1.followups[0]!.audience === "breakup" && TEAM.formatIssues(fu1.html, "followup").length === 0, fu1);
const fu2 = AG.parseDraft(SUBJ_ONLY, { followup: true });
check("المتابعة: «Subject:» ثم النص بلا علامات = مسودة", !!fu2 && fu2.subjects[0] === "One question on files" && /class="lead"/.test(fu2.html) && !/Subject/.test(fu2.html) && !/new angle/.test(fu2.html), fu2);
check("وبالشكل الكامل لا يتغيّر شيء", JSON.stringify(AG.parseDraft(`[عنوان] A\n[الرسالة]\n[ملخص] x\n[/الرسالة]`, { followup: true })) === JSON.stringify(AG.parseDraft(`[عنوان] A\n[الرسالة]\n[ملخص] x\n[/الرسالة]`)));
const tpl = AG.FOLLOWUP_BODY_TEMPLATE.join("\n");
check("قالب موجة المتابعة: [الرسالة] متابعةٌ ٥٠–٧٠ بلا تفاصيل", /\[الرسالة\][\s\S]*\[ملخص\][\s\S]*\[زر\][\s\S]*\[\/الرسالة\]/.test(tpl) && /50–70 words, never more than 70/.test(tpl) && !/^\[تفاصيل\]/m.test(tpl));
check("السبب يُقال: لم يرد نموذج ≠ لم يُقرأ شكله", /لم يرد نموذج/.test(SH.noteOf({ reason: "no_reply" })) && /لا يقرؤه parseDraft: «\[متابعة/.test(SH.noteOf({ reason: "unparsed", raw: "[متابعة] x" })));

// ── الدوران اليومي ──
check("rotateFrom: من حيث توقف، ثم أول القائمة", SH.rotateFrom(["a", "b", "c", "d"], "c").join() === "c,d,a,b" && SH.rotateFrom(["a", "b"], null).join() === "a,b" && SH.rotateFrom(["a", "b"], "z").join() === "a,b");
// ── same بمخالفةٍ في المقترح ليس سليماً ──
const sumDirty = SH.summarize([{ verdict: "same", proposed_issues: ["الرسالة ١٢٨ كلمة — الحد ١١٠ تقريباً"] }, { verdict: "same", proposed_issues: [] }]);
check("same والمقترح خالف (والحالي أيضاً): إنذار، وليس ok", !sumDirty.ok && /same\/better/.test(sumDirty.warnings.join()), sumDirty);

// سياق المحاكاة
check("خارج المحاكاة: لا محاكاة ولا بديل", !SIM.inSimulation() && SIM.personaFor("email", "OLD") === "OLD" && SIM.takeSimCall());
const ctx = SIM.newSimContext({ userId: 1, kind: "manual", personas: { email: "NEW", "whatsapp.sales": "SALES-NEW" }, budget: 2 });
await SIM.withSimulation(ctx, async () => {
  check("داخلها: dryRun", SIM.dryRun() && SIM.inSimulation());
  check("البديل بالدور", SIM.personaFor("email", "OLD") === "NEW");
  check("والبديل بمفتاح الموظف", SIM.personaFor("sales", "OLD") === "SALES-NEW");
  check("دور بلا بديل: المحفوظ", SIM.personaFor("email_guard", "G") === "G");
  check("الميزانية تُعدّ وتنفد", SIM.takeSimCall() && SIM.takeSimCall() && !SIM.takeSimCall() && ctx.budget.used === 2);
  await SIM.withPersona("email", null, async () => check("withPersona(null): يعود المحفوظ", SIM.personaFor("email", "OLD") === "OLD"));
  await SIM.withPersona("email", "X", async () => check("withPersona: بديل آخر", SIM.personaFor("email", "OLD") === "X"));
  const core = corePrompt({ channel: "email", role: "email", identity: "اسمك نورة", persona: "OLD-PERSONA" });
  check("corePrompt: البديل يحلّ محل الشخصية", core.includes("NEW") && !core.includes("OLD-PERSONA"));
  const pre = personaPreamble({ agent: { name: "سارة", title: null, persona: "قديمة", role: "sales" } as any });
  check("personaPreamble: البديل", pre.includes("SALES-NEW") && !pre.includes("قديمة"));
});
check("corePrompt خارجها: الشخصية المحفوظة كما هي", corePrompt({ channel: "email", role: "email", identity: "x", persona: "OLD-PERSONA" }).includes("OLD-PERSONA"));

// البوابة ترفض كل شيء في المحاكاة، قبل أي قناة وأي قراءة
const sim2 = SIM.newSimContext({ userId: 1, kind: "manual" });
const f0 = fetched;
const refused = await SIM.withSimulation(sim2, async () => Promise.all([
  gateSend({ userId: 1, channel: "whatsapp", kind: "reply", recipient: "971500000001" }),
  gateSend({ userId: 1, channel: "email", kind: "campaign", recipient: "a@b.c" }),
  gateSend({ userId: 1, channel: "email", kind: "owner_notice", recipient: "me@x", selfAddressed: true }),
  gateSend({ userId: 1, channel: "instagram", kind: "dm", recipient: "h" }),
  gateSend({ userId: 1, channel: "tiktok", kind: "post" }),
  gateSend({ userId: 1, channel: "whatsapp", kind: "manual", recipient: "971500000002" }),
]));
check("المحاكاة: كل قناة وكل نوع مرفوض بالرمز simulation", refused.every((r) => !r.allowed && r.code === "simulation"), refused);
check("...وكل محاولة تنفيذٌ تجريبي مسجَّل", sim2.sandbox.length === refused.length && sim2.sandbox[0]!.channel === "whatsapp");
check("...ولا شبكة", fetched === f0);

// حقول المدير §8 وعتبة الهدر
const pack: any = {
  accountId: 1, day: "2026-11-10", windowDays: 7, thin: false,
  activity: { executions: 400, emailsSent: 30, inbound: 4, waSends: 10, tasksClosed: 5 },
  outcomes: { positiveReplies: 2, companiesPositive: 2, qualifiedLeads: 1, meetings: 0, bounced: 1, bounceRate: null, humanOpens: 3 },
  departments: [
    // الشكل الحقيقي: المشترك ٢٬٨٩٣ نداء بلا نتيجة خاصة به.
    { department: "shared", executions: 300, failed: 2, successRate: 0.99, tokens: 1_900_000, calls: 2893, costUsd: null, outcome: null, outcomeLabel: null },
    { department: "executive", executions: 3, failed: 0, successRate: null, tokens: 40_000, calls: 30, costUsd: null, outcome: null, outcomeLabel: null },
    { department: "email", executions: 90, failed: 1, successRate: 0.98, tokens: 300_000, calls: 400, costUsd: null, outcome: 2, outcomeLabel: "ردود نافعة على الموجات" },
    { department: "whatsapp", executions: 7, failed: 0, successRate: null, tokens: 120_000, calls: 200, costUsd: null, outcome: 0, outcomeLabel: "محادثات حارة أو مهتمة أو طلب" },
  ],
  overdueEmployees: [], failingEmployees: [], noExecutionEmployees: ["whatsapp.vetter"], failingWorkflows: [], campaignsWithLeads: [],
  channels: [{ channel: "email", state: "sending", sent: 30, positive: 2 }, { channel: "linkedin", state: "no_driver", sent: 0, positive: null }],
  queue: { emailQueued: 0, heldStale: 0 }, approvalsWaiting: 0, problems: [],
};
const waste = C.wastefulDepartment(pack.departments);
check("الهدر: المشترك (٢٬٨٩٣ نداء) والتنفيذي لا يُحكم عليهما", waste?.department === "whatsapp", waste);
check("الهدر: بلا قسم ذي نتيجة لا هدر", C.wastefulDepartment(pack.departments.slice(0, 2)) === null);
const vm = C.verifiedMetrics(pack);
check("verified_metrics: كل رقم بمصدره، والنسبة بلا عيّنة null", vm.every((m) => !!m.source) && vm.find((m) => m.key === "bounce_rate")!.value === null && vm.find((m) => m.key === "emails_sent")!.value === 30);
const gaps = C.dataGaps(pack);
check("data_gaps: الارتداد، نسبة النجاح القليلة، بلا تنفيذ، القناة بلا مشغّل", ["bounce_rate", "success_rate:whatsapp", "no_execution:whatsapp.vetter", "channel:linkedin"].every((k) => gaps.some((g) => g.key === k)), gaps);
check("confidence: قليل الوقائع منخفض", C.reportConfidence({ ...pack, thin: true }, [], "validated") === "low");
check("confidence: فجوات كثيرة متوسط أو أدنى", C.reportConfidence(pack, gaps, "validated") !== "high");
check("confidence: بلا فجوات ونص متحقق عالٍ", C.reportConfidence(pack, [], "validated") === "high" && C.reportConfidence(pack, [], "facts_only") === "medium");

// الجاهزية: المتوقف عمداً
check("OPTIONAL لا يُحسب محظوراً", R.overallStatus([{ status: "READY" }, { status: "OPTIONAL" }]) === "READY");
check("OPTIONAL مع ما يحتاج اختباراً", R.overallStatus([{ status: "NEEDS_TEST" }, { status: "OPTIONAL" }]) === "NEEDS_TEST");
check("OPTIONAL وحده لا يجعل الكل جاهزاً", R.overallStatus([{ status: "OPTIONAL" }]) === "BLOCKED");
check("المحظور يبقى محظوراً", R.overallStatus([{ status: "OPTIONAL" }, { status: "BLOCKED" }]) === "BLOCKED");

// /api/plans: الجدول الغائب
const missing = async () => { throw Object.assign(new Error('relation "subscription_plans" does not exist'), { code: "42P01" }); };
check("الخطط: جدول غائب = قائمة فارغة", (await listPlans(missing as any)).length === 0);
check("الخطط: لوحة المدير كذلك", (await listPlans(missing as any, true)).length === 0);
check("الخطط: الموجود يعود كما هو", (await listPlans((async () => ({ rows: [{ id: 1 }] })) as any)).length === 1);
check("الخطط: خطأ آخر يُرمى", await listPlans((async () => { throw Object.assign(new Error("x"), { code: "57P01" }); }) as any).then(() => false, () => true));

// تحليل جاسم بالكود
const fx = E.WEAK_FIXTURE.data;
const findings = E.analyseCampaign(fx as any, () => ["مبالغة"]);
check("جاسم: فتح ضعيف، لا رد نافع، ارتداد، وحارس", ["low_open", "no_positive", "bounce", "guard", "vague_subject"].every((c) => findings.some((f) => f.code === c)), findings);
check("بيانات الاختبار معلَّمة", (fx as any).test_data === true && /اختبار/.test(fx.name));

// ── على القاعدة ───────────────────────────────────────────────────
if (!/127\.0\.0\.1:(55449|55447|55445|55444|55440)/.test(process.env["DATABASE_URL"] ?? "")) {
  console.log(`\n${pass} passed, ${fail} failed (بلا قاعدة)`);
  process.exit(fail ? 1 : 0);
}

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { ensureSimTables } = await import("../org/sim-schema");
const { setControl, forgetControls } = await import("../org/controls");
const { pendingProviderBuckets } = await import("../org/providers");
const A = 5, B = 6;
await ensureSimTables();
for (const t of ["shadow_runs", "improvement_proposals", "email_missions", "bot_employees", "receipts", "llm_usage", "employee_heartbeats", "employee_executions", "org_controls"]) {
  await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
}
forgetControls();
check("ensureSimTables مرتين بأمان", await ensureSimTables());
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES
  (${A}, 'ريم', 'collector', 'shared.collector', 'OLD-REEM'), (${A}, 'راشد', 'email_registrar', 'email.registrar', 'x'), (${A}, 'نورة', 'email', 'email.copywriter', 'OLD-NORA'),
  (${A}, 'المراقب', 'monitor', 'ops.monitor', 'x'),
  (${B}, 'نورة', 'email', 'email.copywriter', 'B-NORA')`);
const [prop] = (await db.execute<any>(sql`INSERT INTO improvement_proposals (user_id, requested_by, target, reason, new_value, category, risk)
  VALUES (${A}, 'system.seed', 'prompt:email.copywriter', 'اختبار', '{"libraryVersion":"1"}'::jsonb, 'prompt_external', 'approval_required') RETURNING change_id`)).rows;
for (const [u, n] of [[A, 4], [B, 3]] as const) for (let i = 0; i < n; i++) {
  await db.execute(sql`INSERT INTO email_missions (user_id, name, goal, filter) VALUES (${u}, ${`m${u}-${i}`}, ${`هدف ${u}-${i}`}, '{}'::jsonb)`);
}

// مسار حقيقي بلا شبكة: نورة لا تجد نموذجاً → no_output، والعزل
const r1 = await SH.runShadow(A, { employeeKey: "email.copywriter" });
const mine = (await db.execute<any>(sql`SELECT id FROM email_missions WHERE user_id = ${A}`)).rows.map((x: any) => Number(x.id));
check("الظل: ٣ عيّنات على الأكثر", r1.ran === 3, r1);
check("عزل: كل عيّنة من الحساب نفسه", r1.rows.every((x: any) => mine.includes(Number(x.sample_ref?.id))), r1.rows.map((x: any) => x.sample_ref));
check("بلا نموذج: no_output، والمقترح مربوط بمقترحه", r1.rows.every((x: any) => x.verdict === "no_output" && Number(x.proposal_id) === Number(prop.change_id)));
check("كل نسخة نداء واحد محسوب", r1.callsUsed === 6 && r1.rows.every((x: any) => Number(x.model_calls) === 2), r1.callsUsed);
check("callsToday يجمعها", (await SH.callsToday(A)) === 6 && (await SH.callsToday(B)) === 0);
const leaks = (await db.execute<any>(sql`SELECT (SELECT count(*)::int FROM receipts WHERE user_id = ${A} AND action = 'llm.call') AS r,
  (SELECT count(*)::int FROM employee_heartbeats WHERE user_id = ${A}) AS h, (SELECT count(*)::int FROM employee_executions WHERE user_id = ${A}) AS e`)).rows[0];
await new Promise((ok) => setTimeout(ok, 200));
const usage = (await db.execute<any>(sql`SELECT count(*)::int AS n FROM llm_usage WHERE user_id = ${A}`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0];
check("المحاكى خارج الإيصالات والنبض والتنفيذ والاستهلاك ومقاييس المزوّد", leaks.r === 0 && leaks.h === 0 && leaks.e === 0 && Number(usage.n) === 0 && pendingProviderBuckets() === 0, { leaks, usage, buckets: pendingProviderBuckets() });
const s1 = await SH.shadowSummary(A, { proposalId: Number(prop.change_id) });
check("خلاصة المقترح: إنذار لم يكتب", s1.samples === 3 && s1.warnings.some((w) => /لم يكتب/.test(w)) && !s1.ok, s1);

// السقف: ٤٠ في اليوم، وما لا يكفي لعيّنة يقال
const r2 = await SH.runShadow(A, { employeeKey: "email.copywriter", budget: 9 });
check("السقف: عيّنة واحدة ثم budget", r2.ran === 0 || r2.rows.some((x: any) => x.verdict === "budget"), r2.rows.map((x: any) => x.verdict));
check("ولم يتجاوز السقف", (await SH.callsToday(A)) <= 9);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);

// المفاتيح تعمل: asAgent على الدور
await setControl({ scope: "employee", userId: A, target: "email.copywriter", engaged: true, actor: A });
const r3 = await SH.runShadow(A, { employeeKey: "email.copywriter" });
check("الموظف موقوف: لا عيّنة ولا نداء", r3.ran === 0 && r3.callsUsed === 0 && r3.skipped.some((s) => /موقوف/.test(s.why)), r3);
await setControl({ scope: "employee", userId: A, target: "email.copywriter", engaged: false, actor: A });

// المدير التنفيذي موصول: وقائع قليلة = لا عيّنة (المسار الحقيقي لا يستدعي النموذج)، بلا رمي ولا نداء
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES (${A}, 'المدير', 'ceo_agent', 'executive.ceo', 'OLD-CEO')`);
const rCeo = await SH.runShadow(A, { employeeKey: "executive.ceo" });
check("المدير التنفيذي: مسار ظل، والوقائع القليلة no_samples بلا نداء", rCeo.rows.length === 1 && rCeo.rows[0].verdict === "no_samples" && rCeo.callsUsed === 0, rCeo.rows.map((x: any) => x.verdict));
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A} AND employee_key = 'executive.ceo'`);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);

// الشخصيتان: المحفوظة ثم المقترحة، والحكم بالكود
const seen: string[] = [];
const stub = (key: string, role: string, judge: (p: string) => string[]) => ({
  key, role, maxCalls: 1,
  samples: async (u: number) => (await db.execute<any>(sql`SELECT id FROM email_missions WHERE user_id = ${u} ORDER BY id LIMIT 3`)).rows.map((x: any) => ({ ref: { id: Number(x.id) }, excerpt: "x", data: x })),
  run: async () => { const p = SIM.personaFor(role, "NONE") ?? "NONE"; seen.push(p.slice(0, 20)); return { text: p, issues: judge(p) }; },
});
const r4 = await SH.runShadow(A, { adapters: [stub("shared.collector", "collector", (p) => (p.includes("##") ? ["عناوين أقسام في النص"] : []))] as any });
const reem = r4.rows.filter((x: any) => x.employee_key === "shared.collector");
check("الحالية: المحفوظة كما هي", seen[0] === "OLD-REEM", seen);
check("المقترحة: نص المكتبة لهذا الحساب", /^## /.test(seen[1] ?? ""), seen[1]);
check("المقترح خالف: failed_checks", reem.length === 3 && reem.every((x: any) => x.verdict === "failed_checks"), reem.map((x: any) => x.verdict));
const mon = r4.rows.find((x: any) => x.employee_key === "ops.monitor");
check("موظف بالكود وحده فعلاً: no_model_path بلا نداء", mon?.verdict === "no_model_path" && Number(mon.model_calls) === 0 && /بالكود/.test(mon.detail), mon);
const reg = r4.rows.find((x: any) => x.employee_key === "email.registrar");
check("المسجّل يصوغ تقريره بنموذج: not_covered «لم يُجرَّب» لا no_model_path", reg?.verdict === "not_covered" && Number(reg.model_calls) === 0 && /لم يُجرَّب/.test(reg.detail), reg);
const nora = r4.rows.filter((x: any) => x.employee_key === "email.copywriter");
check("له نموذج وبلا مسار في هذه الدفعة: not_covered", nora.length === 1 && nora[0].verdict === "not_covered");
const sNot = await SH.shadowSummary(A, { employeeKey: "email.registrar" });
check("خلاصته: «لم يُجرَّب» وليست ok", !sNot.ok && sNot.warnings.some((w) => /لم يُجرَّب/.test(w)), sNot);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);

// ── المتابعة بمسارها الحقيقي ونموذجٍ مزيّف يجيب بشكل المتابعة (إعادة إنتاج 2026-11-11) ──
const realFetch = globalThis.fetch;
const asked: string[] = [];
const fuBody = (n: number) => `[عنوان] Source of funds at {{company|your firm}}\n[متابعة بعد=72 جمهور=دافئ]\nعنوان: One question on files\nHello {{first_name|there}},\n[ملخص] ${FU_WORDS(n)}\n[زر] Send me the checklist\nBest regards,\nThe Pro Count team\n[/متابعة]\n[السبب] new angle`;
let words = 90;
globalThis.fetch = (async (url: any, init: any) => {
  const sys = (() => { try { return String(JSON.parse(init?.body ?? "{}")?.messages?.[0]?.content ?? ""); } catch { return ""; } })();
  asked.push(sys);
  const text = fuBody(words);
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }], candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { "content-type": "application/json" } });
}) as any;
// نورة في المسار الحقيقي وظّفت الفريق (ensureEmailTeam): يوسف موجود، يُعطى مفتاحه وشخصيته المحفوظة.
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A} AND role = 'email_followup'`);
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES (${A}, 'يوسف', 'email_followup', 'email.followup', 'OLD-YOUSEF')`);
await db.execute(sql`INSERT INTO email_missions (user_id, name, goal, filter, agent_role) VALUES (${A}, 'قائمة — متابعة فتحوا ولم يردّوا', 'متابعة لمن فتح رسالتنا ولم يرد. زاوية ألم جديدة', '{"listIds":[]}'::jsonb, 'email_followup')`);
const rFu = await SH.runShadow(A, { employeeKey: "email.followup" });
const fuRows = rFu.rows.filter((x: any) => x.employee_key === "email.followup");
check("المتابعة: المخرجان مكتوبان في كل عيّنة (لا no_output)", fuRows.length === 3 && fuRows.every((x: any) => x.verdict !== "no_output" && !!x.current_output && !!x.proposed_output), fuRows.map((x: any) => [x.verdict, x.detail]));
check("...ومحكومان بحد المتابعة (٧٠) لا بحد الأولى", fuRows.every((x: any) => x.proposed_issues.some((i: string) => /الحد ٧٠/.test(i)) && x.current_issues.some((i: string) => /الحد ٧٠/.test(i))), fuRows.map((x: any) => x.proposed_issues));
check("...وكلاهما خالف الحد نفسه: same، ومخالفة المقترح محفوظة", fuRows.every((x: any) => x.verdict === "same" && x.proposed_issues.length > 0));
check("...والكاتب طُلب منه [الرسالة] متابعةً، بلا قالب الرسالة الأولى", asked.length === 6 && asked.every((t) => /Structure rules for this follow-up wave/.test(t) && !/the whole email 40–90 words/.test(t)));
check("...والشخصيتان: المحفوظة ثم المقترحة", asked[0]!.includes("OLD-YOUSEF") && !asked[1]!.includes("OLD-YOUSEF"));
words = 30;
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);
const rFu2 = await SH.runShadow(A, { employeeKey: "email.followup" });
check("المتابعة بطولٍ سليم: same بلا مخالفة", rFu2.rows.every((x: any) => x.verdict === "same" && x.proposed_issues.length === 0 && !!x.proposed_output), rFu2.rows.map((x: any) => [x.verdict, x.proposed_issues]));
globalThis.fetch = realFetch;
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);
await db.execute(sql`DELETE FROM email_missions WHERE user_id = ${A} AND agent_role = 'email_followup'`);
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A} AND employee_key = 'email.followup'`);

// ── السقف ٦٠ والدوران: كل موظفٍ مغطّى يأخذ عيّناته خلال يومين ──
// تكلفة كل عيّنة ٢×maxCalls كما في المسار؛ البريد أولاً أبجدياً كان يأكل السقف كل يوم (الواتساب budget).
const costed: Array<[string, string, number]> = [["email.copywriter", "email", 1], ["email.creator", "email_creator", 1], ["email.followup", "email_followup", 1], ["email.replies", "email_replies", 1],
  ["shared.collector", "collector", 1], ["target_accounts.writer", "accounts_writer", 3], ["whatsapp.followup", "followup", 4], ["whatsapp.sales", "sales", 2], ["whatsapp.support", "support", 2]];
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A}`);
for (const [k, role] of costed) await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES (${A}, ${k}, ${role}, ${k}, 'OLD')`);
const spenders = costed.map(([key, role, maxCalls]) => ({
  key, role, maxCalls,
  samples: async () => [1, 2, 3].map((i) => ({ ref: { i }, excerpt: "x", data: {} })),
  run: async () => { for (let i = 0; i < maxCalls; i++) SIM.takeSimCall(); return { text: "ok", issues: [] }; },
}));
const sampled = (rs: any[]) => new Set(rs.filter((x: any) => SH.COMPARED.includes(x.verdict)).map((x: any) => String(x.employee_key)));
const day1 = await SH.runShadow(A, { adapters: spenders as any });
check("اليوم الأول: ٦٠ نداء على الأكثر، وتوقف عند الواتساب", day1.callsUsed <= 60 && day1.rows.some((x: any) => x.verdict === "budget" && /^whatsapp\./.test(x.employee_key)), day1.rows.map((x: any) => `${x.employee_key}:${x.verdict}`));
const firstStop = String(day1.rows.find((x: any) => x.verdict === "budget")!.employee_key);
const missed1 = costed.map(([k]) => k).filter((k) => !sampled(day1.rows).has(k));
check("...وبقي موظفٌ مغطّى بلا عيّنة في اليوم الأول", missed1.length > 0, missed1);
// اليوم التالي: صفوف الأمس تُرجَع يوماً
await db.execute(sql`UPDATE shadow_runs SET created_at = created_at - interval '1 day' WHERE user_id = ${A}`);
check("stoppedAt: أول موظفٍ كُتب له budget أمس", (await SH.stoppedAt(A)) === firstStop);
const day2 = await SH.runShadow(A, { adapters: spenders as any });
const firstKey = String(day2.rows[0]?.employee_key);
check("اليوم الثاني يبدأ من حيث توقف الأمس", firstKey === firstStop, { firstKey, firstStop });
const both = new Set([...sampled(day1.rows), ...sampled(day2.rows)]);
check("خلال يومين: كل موظفٍ مغطّى له عيّنة", costed.every(([k]) => both.has(k)), costed.map(([k]) => k).filter((k) => !both.has(k)));
check("...وسقف اليوم الثاني ٦٠ وحده", day2.callsUsed <= 60 && (await SH.callsToday(A)) <= 60);
await db.execute(sql`DELETE FROM shadow_runs WHERE user_id = ${A}`);
await db.execute(sql`DELETE FROM bot_employees WHERE user_id = ${A}`);
await db.execute(sql`INSERT INTO bot_employees (user_id, name, role, employee_key, persona) VALUES
  (${A}, 'ريم', 'collector', 'shared.collector', 'OLD-REEM'), (${A}, 'راشد', 'email_registrar', 'email.registrar', 'x'), (${A}, 'نورة', 'email', 'email.copywriter', 'OLD-NORA'),
  (${A}, 'المراقب', 'monitor', 'ops.monitor', 'x')`);

// الجدول: أيام العمل 06:30، مرة في اليوم، لمن عنده مقترح ولم يُوقَف
SH.forgetShadowSchedule();
const ran: number[] = [];
const fake = (async (u: number) => { ran.push(u); return { batchId: "", ran: 0, skipped: [], callsUsed: 0, rows: [] }; }) as any;
check("قبل 06:30 لا شيء", (await SH.shadowTick(new Date("2026-11-10T02:00:00Z"), fake)).length === 0);
check("السبت لا شيء", (await SH.shadowTick(new Date("2026-11-14T03:00:00Z"), fake)).length === 0);
const t1 = await SH.shadowTick(new Date("2026-11-10T02:45:00Z"), fake);
check("الثلاثاء 06:45: الحساب صاحب المقترح وحده", t1.includes(A) && !t1.includes(B), t1);
check("ومرة واحدة في اليوم", (await SH.shadowTick(new Date("2026-11-10T03:45:00Z"), fake)).length === 0);

// المسارات
const express = (await import("express")).default;
const simRouter = (await import("../../routes/org-sim")).default;
const orgRouter = (await import("../../routes/org")).default;
let session: any = { userId: A };
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.session = session; next(); });
app.use("/org/sim", simRouter);
app.use("/org", orgRouter);
const server = await new Promise<any>((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
const base = `http://127.0.0.1:${server.address().port}/org`;
const http = async (path: string, init?: any) => {
  const { request } = await import("node:http");
  return new Promise<{ status: number; body: any }>((ok, no) => {
    const u = new URL(base + path);
    const req = request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init?.method ?? "GET", headers: { "content-type": "application/json" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => ok({ status: res.statusCode!, body: d ? JSON.parse(d) : null }));
    });
    req.on("error", no); if (init?.body) req.write(JSON.stringify(init.body)); req.end();
  });
};
const run = await http("/sim/shadow/run", { method: "POST", body: { employeeKey: "email.copywriter" } });
check("POST /sim/shadow/run", run.status === 200 && run.body.ran === 3, run);
const res = await http(`/sim/shadow/results?proposalId=${prop.change_id}`);
check("GET النتائج بالمقترح، وخلاصته", res.status === 200 && res.body.results.length === 3 && res.body.summary?.samples === 3);
const pr = await http(`/proposals/${prop.change_id}`);
check("المقترح يحمل shadow بإنذاراته", pr.status === 200 && pr.body.shadow?.samples === 3 && pr.body.shadow.warnings.length > 0, pr.body?.shadow);
session = { userId: B };
const other = await http(`/sim/shadow/results?proposalId=${prop.change_id}`);
check("حساب آخر لا يرى ظل غيره", other.body.results.length === 0);
session = { userId: A };
const emp = await http(`/employees/email.copywriter`);
check("ملف الموظف يحمل shadow", emp.status === 200 && emp.body.shadow?.samples === 3, emp.body?.shadow);
server.close();

for (const t of ["shadow_runs", "improvement_proposals", "email_missions", "bot_employees", "agent_tasks", "org_controls", "org_audit_log"]) await db.execute(sql.raw(`DELETE FROM ${t} WHERE user_id IN (${A}, ${B})`)).catch(() => {});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
