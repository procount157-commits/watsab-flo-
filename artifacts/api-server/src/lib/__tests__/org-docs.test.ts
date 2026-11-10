// ملف الموظف بلا قاعدة: الأقسام التسعة عشر لكل مدخل، السطور الصريحة من §3، التمايز، طول
// التعليمات المجمَّعة، العزل بين الحسابين، مكتبات الاعتراضات، حارس الحقن، الفرق، والترحيل.
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-docs.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { PROMPT_LIBRARY, renderPrompt } = await import("../org/prompts/index");
const M = await import("../org/docs/model");
const P = await import("../org/docs/persuasion");
const O = await import("../org/docs/objections/index");
const { DOCS_TABLES_SQL } = await import("../org/docs/schema");
const { ROLE_MAP } = await import("../org/departments");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

const FLORET = { name: "فلوريت للذهب والمجوهرات (FLORET JEWELRY)", vertical: "jewelry" };
const PROCOUNT = { name: "Pro Count for Accounting", vertical: "accounting" };
const OTHER = { name: "مطعم الأصيل", vertical: "restaurant" };
const ACCOUNTS = [FLORET, PROCOUNT, OTHER];
const keys = Object.keys(PROMPT_LIBRARY);
const meta = (k: string) => ({ version: 1, author: "system.seed", reason: "بذرة", libraryVersion: PROMPT_LIBRARY[k]!.version });
const build = (k: string, a: { name: string; vertical: string }) => M.buildDossierSections(k, PROMPT_LIBRARY[k]!, a, meta(k));

// ── المفاتيح والأقسام ─────────────────────────────────────────────
check("55 entries, unique keys", keys.length === 55 && new Set(keys).size === 55, keys.length);
check("nineteen dossier sections, unique", M.DOSSIER_KEYS.length === 19 && new Set(M.DOSSIER_KEYS).size === 19);
check("every section has a title", M.DOSSIER_KEYS.every((k) => !!M.DOSSIER_TITLES[k]?.trim()));
const incomplete = keys.flatMap((k) => ACCOUNTS.flatMap((a) => M.missingSections(build(k, a)).map((s) => `${k}@${a.name.slice(0, 4)}/${s}`)));
check("every entry × account: 19 non-empty sections", incomplete.length === 0, incomplete.slice(0, 6));
check("every entry has its own diagnosis and handoff", keys.every((k) => !!M.extraOf(k)?.diagnosis && !!M.extraOf(k)?.handoff), keys.filter((k) => !M.extraOf(k)));
check("no stray extra for a key the library does not have", Object.keys((await import("../org/prompts/dossier-extra")).DOSSIER_EXTRA).every((k) => !!PROMPT_LIBRARY[k]));

// ── السطور الصريحة من §3 ─────────────────────────────────────────
const REQUIRED: Array<[string, keyof typeof M.STANDARD, string]> = [
  ["stay in role", "stayInRole", "identity"], ["verified knowledge only", "verifiedOnly", "inputs"], ["ask/escalate, never fabricate", "askNotFabricate", "escalation"],
  ["assumptions, uncertainty, evidence", "explain", "quality"], ["diagnose before prescribing", "diagnoseFirst", "diagnosis"], ["actionable with impact/risk/validation", "actionable", "decisionFramework"],
  ["create/update tickets", "tickets", "tickets"], ["no completion before the execution service", "noFalseCompletion", "workflow"], ["owner-level decisions escalate", "ownerDecisions", "escalation"],
];
for (const [n, s, sec] of REQUIRED) {
  const missed = keys.filter((k) => !(build(k, PROCOUNT) as any)[sec].includes(M.STANDARD[s]));
  check(`§3: ${n} in every dossier (${sec})`, missed.length === 0, missed.slice(0, 4));
}
check("no claimed human credentials, and the line saying so", keys.every((k) => build(k, OTHER).expertise.includes(M.STANDARD.noCredentials)));
const generic = keys.filter((k) => /you are an expert|أنت خبير|سنوات من الخبرة|years of experience|certified|معتمد من/i.test(M.dossierText(build(k, OTHER))));
check("no generic «you are an expert» and no years/credentials claimed", generic.length === 0, generic);

// ── التمايز ───────────────────────────────────────────────────────
// المقياس نفسه في org-prompts.test.ts، على ما يدخل التعليمات من المهمة وسير العمل (بلا سطور ▪ والسطور الثابتة).
const wordsOf = (s: string) => new Set(s.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().split(" ").filter((w) => w.length > 1));
const live = (t: string) => t.split("\n").filter((l) => !l.startsWith(M.DOC_ONLY) && !Object.values(M.STANDARD).includes(l as any)).join(" ");
const roleText = (k: string) => { const s = build(k, OTHER); return `${live(s.mission)} ${live(s.workflow)}`; };
const bags = keys.map((k) => ({ k, w: wordsOf(roleText(k)) }));
const close: string[] = [];
let worst = { pair: "", v: 0 };
for (let i = 0; i < bags.length; i++) for (let j = i + 1; j < bags.length; j++) {
  const a = bags[i]!, b = bags[j]!;
  const v = [...a.w].filter((w) => b.w.has(w)).length / Math.min(a.w.size, b.w.size);
  if (v > worst.v) worst = { pair: `${a.k}×${b.k}`, v };
  if (v > 0.6) close.push(`${a.k}×${b.k}=${v.toFixed(2)}`);
}
check("distinct dossiers: no two share over 60% of mission+workflow words", close.length === 0, close.slice(0, 5).join(", ") || `${worst.pair} ${worst.v.toFixed(2)}`);
const diag = new Set(keys.map((k) => M.extraOf(k)!.diagnosis));
check("diagnosis text distinct per role and platform", diag.size === keys.length, `${diag.size}/${keys.length}`);
const runtimes = new Set(keys.map((k) => M.renderRuntime({ employeeKey: k, sections: build(k, PROCOUNT), externalBehavior: PROMPT_LIBRARY[k]!.externalBehavior, account: PROCOUNT })));
check("distinct runtime prompts for every entry", runtimes.size === keys.length);

// ── التعليمات المجمَّعة ───────────────────────────────────────────
// أسوأ حال: كل اعتراض وكتيب للحساب معتمد.
const approvedAll = (a: { name: string; vertical: string }) => { const lib = O.libraryFor(a); return lib ? O.libraryRows(lib).map((r) => ({ key: r.key, value: r.value })) : []; };
const lens: Array<{ k: string; n: number }> = [];
for (const k of keys) for (const a of ACCOUNTS) for (const kn of [[], approvedAll(a)]) {
  const t = M.renderRuntime({ employeeKey: k, sections: build(k, a), externalBehavior: PROMPT_LIBRARY[k]!.externalBehavior, account: a, knowledge: kn });
  lens.push({ k: `${k}@${a.name.slice(0, 4)}${kn.length ? "+k" : ""}`, n: t.length });
}
const over = lens.filter((x) => x.n > M.RUNTIME_LIMIT);
check(`every runtime prompt ≤ ${M.RUNTIME_LIMIT} characters, with all objections approved`, over.length === 0, over.slice(0, 5));
console.log(`      longest runtime: ${Math.max(...lens.map((x) => x.n))}`);
const rt = (k: string, a = PROCOUNT, kn: any[] = []) => M.renderRuntime({ employeeKey: k, sections: build(k, a), externalBehavior: PROMPT_LIBRARY[k]!.externalBehavior, account: a, knowledge: kn });
check("the output schema survives verbatim in the runtime", keys.every((k) => rt(k).includes(PROMPT_LIBRARY[k]!.sections.outputSchema)));
check("documentation lines stay out of the runtime", keys.every((k) => !rt(k).includes(M.DOC_ONLY)));
check("the runtime keeps the standard lines", keys.every((k) => rt(k).includes("قواعد ثابتة:") && rt(k).includes("لا «تم» قبل أن تؤكد خدمة التنفيذ")));
const external = keys.filter((k) => PROMPT_LIBRARY[k]!.externalBehavior);
check("prompt-injection guard in every customer-facing runtime", external.every((k) => rt(k, FLORET).includes(M.STANDARD.injectionGuard)), external.filter((k) => !rt(k, FLORET).includes(M.STANDARD.injectionGuard)));
check("...and in their dossiers", external.every((k) => build(k, OTHER).prohibited.includes(M.STANDARD.injectionGuard) && build(k, OTHER).inputs.includes(M.STANDARD.injectionGuard)));
check("Floret's rules in every Floret runtime", keys.every((k) => /لا سعر ولا وزن/.test(rt(k, FLORET)) && rt(k, FLORET).includes("https://floret-royal.io") && /«هلا وغلا»/.test(rt(k, FLORET))));
check("Pro Count's no-fabrication rule in every Pro Count runtime", keys.every((k) => /اختراع قانون أو نسبة أو غرامة أو مهلة أو سعر/.test(rt(k))));
check("approved objections enter a sales runtime", rt("whatsapp.sales", PROCOUNT, approvedAll(PROCOUNT)).includes("«How much do you charge?»"));
check("one approved objection enters on its own", rt("whatsapp.sales", PROCOUNT, approvedAll(PROCOUNT).filter((k) => k.key === "objection.competitor.have_accountant")).includes("«We already have an accountant.» ← That can work well."));
check("one of each type before a second of any", (() => { const t = rt("email.replies", PROCOUNT, approvedAll(PROCOUNT)); return t.includes("«How much do you charge?»") && t.includes("«Not now — maybe next quarter.»") && !t.includes("«That is more than we pay today.»"); })());
check("...and not an internal one", !rt("ops.monitor", PROCOUNT, approvedAll(PROCOUNT)).includes("We already have an accountant."));
check("...nor a role the item is not for", !rt("whatsapp.support", PROCOUNT, approvedAll(PROCOUNT)).includes("We would rather hire"));
check("the persuasion standard enters sales runtimes", ["whatsapp.sales", "email.replies", "instagram.dm", "executive.chief"].every((k) => rt(k).includes("معيار الإقناع:")));
check("a needs-owner-approval proof never enters a runtime", !rt("whatsapp.sales", PROCOUNT, approvedAll(PROCOUNT)).includes("Client names, client counts"));

// ── معيار الإقناع ─────────────────────────────────────────────────
const roleMap: Array<[string, string]> = [["executive.chief", "sales_director"], ["whatsapp.sales", "sales_specialist"], ["whatsapp.support", "customer_success"], ["email.strategist", "campaign_strategist"],
  ["email.copywriter", "copywriter"], ["target_accounts.writer", "copywriter"], ["instagram.qualify", "lead_qualification"], ["email.replies", "reply_dm"], ["tiktok.dm", "reply_dm"], ["executive.ceo", "manager"], ["email.director", "manager"]];
check("each named role gets its application", roleMap.every(([k, r]) => P.persuasionRoleOf(k) === r), roleMap.filter(([k, r]) => P.persuasionRoleOf(k) !== r));
check("internal roles get none", ["ops.monitor", "email.registrar", "instagram.watcher"].every((k) => P.persuasionRoleOf(k) === null));
const std = P.standardText();
for (const [n, re] of [["discovery questions", /الاكتشاف/], ["need→value", /الحاجة إلى القيمة/], ["trade-offs", /المقايضات/], ["approved proof only", /الدليل المعتمد وحده/],
  ["objection vs info vs refusal", /اعتراض:[\s\S]*طلب معلومة:[\s\S]*رفض:/], ["negotiate within bounds", /داخل الحدود المعتمدة/], ["next step", /خطوة تالية/], ["record", /نسجّل/],
  ["stop on refusal", /يتوقف معه كل شيء فوراً/], ["no fake scarcity/urgency", /ندرة مزيفة[\s\S]*استعجال مزيف/], ["no invented testimonials", /شهادات أو آراء أو أرقام عملاء مخترعة/],
  ["no pressure after refusal", /ضغط بعد الرفض/], ["no hidden terms", /شروط مخفية/], ["no unauthorized promises", /وعد لم يعتمده صاحب العمل/]] as Array<[string, RegExp]>) check(`standard: ${n}`, re.test(std));
check("all seven objection types in the standard", P.OBJECTION_TYPES.every((t) => !!P.PERSUASION_STANDARD.objections[t]));
check("eight role applications", Object.keys(P.ROLE_APPLICATION).length === 8);

// ── مكتبات الاعتراضات ─────────────────────────────────────────────
const pro = O.ACCOUNT_LIBRARIES.procount, flo = O.ACCOUNT_LIBRARIES.floret;
for (const lib of [pro, flo]) {
  check(`${lib.account}: every objection type covered`, P.OBJECTION_TYPES.every((t) => lib.objections.some((o) => o.type === t)));
  check(`${lib.account}: unique slugs`, new Set(lib.objections.map((o) => o.slug)).size === lib.objections.length);
  check(`${lib.account}: every proof has a source and a status`, lib.objections.every((o) => !o.proof || (!!o.proof.source && ["approved_knowledge", "needs_owner_approval"].includes(o.proof.status))));
  check(`${lib.account}: a proof without a source file is marked needs owner approval`, lib.objections.every((o) => !o.proof || o.proof.source.startsWith("lib/") || o.proof.status === "needs_owner_approval"));
  check(`${lib.account}: a playbook for every role`, Object.keys(P.ROLE_APPLICATION).every((r) => lib.playbooks.some((p) => p.role === r)));
  check(`${lib.account}: kinds distinguish objection, information and refusal`, lib.objections.every((o) => ["objection", "info_request", "refusal"].includes(o.kind)));
}
const proText = JSON.stringify(pro), floText = JSON.stringify(flo);
check("Pro Count: English", !/[؀-ۿ]/.test(proText.replace(/"source":"[^"]*"/g, "")));
check("Pro Count: no invented fee, fine or rate (no figures, no AED, no %)", !/\d|AED|%|درهم/.test(proText.replace(/"source":"[^"]*"/g, "")), /\d|AED|%/.exec(proText.replace(/"source":"[^"]*"/g, "")));
check("Pro Count: never promises a pass or avoided penalty", !/\b(we guarantee|guaranteed|100%|ensure you pass|avoid (all )?penalties)\b/i.test(pro.objections.map((o) => o.response).join(" ")));
check("Pro Count: references marked needs owner approval", pro.objections.some((o) => o.type === "trust" && o.proof?.status === "needs_owner_approval"));
const FLORET_BANNED = /حبيبت|حبيبي|حبيبة|صاحبت|قلبي|عمري|روحي|حياتي|يا ?قمر|يا ?عسل|غناتي|عيوني|هلا\s*و\s*غلا|حبيت\s*[أا]طم[ّ]?ن|سعر|أسعار|اسعار|وزن|جرام|غرام|خصم|تخفيض|مصنعية|درهم|\bAED\b|[0-9٠-٩]/;
const floBody = floText.replace(/"source":"[^"]*"/g, "");
check("Floret: no banned word (price, weight, discount, endearment, «هلا وغلا», digits)", !FLORET_BANNED.test(floBody), FLORET_BANNED.exec(floBody)?.[0]);
check("Floret: the site link verbatim and no other link", floText.includes("https://floret-royal.io") && (floText.match(/https?:\/\/[^\s"،)]+/g) ?? []).every((u) => u.replace(/[.،]$/, "") === "https://floret-royal.io"));
check("Floret: Gulf Arabic", /تبين|تقدرين|اسأليها|بشاور|أبغى/.test(floText));
check("Floret: guarantee and returns marked needs owner approval", flo.objections.filter((o) => /trust.genuine|risk.return/.test(o.slug)).every((o) => o.proof?.status === "needs_owner_approval"));

// ── العزل ─────────────────────────────────────────────────────────
const PROCOUNT_PRIVATE = /pro\s*-?count|بروكاونت|برو\s*كاونت|\bAML\b|\bCFT\b|\bgoAML\b|DNFBP|MLRO|DPMS|RERA|غسل الأموال|ضريب|محاسب|(?<![٠-٩])٨٠(?![٠-٩])|80\s*\/\s*20|054 232|أبوظبي|The Pro Count team|Corporate Tax|\bVAT\b/i;
const FLORET_PRIVATE = /floret|فلوريت|floret-royal|هلا وغلا|حبيت أطمّنك|مصنعية|غناتي|مدينة العين|المعرض في العين|معرض في العين|تصفّحي التشكيلة/i;
check("Floret's library carries nothing of Pro Count", !PROCOUNT_PRIVATE.test(floBody), PROCOUNT_PRIVATE.exec(floBody)?.[0]);
check("Pro Count's library carries nothing of Floret", !FLORET_PRIVATE.test(proText), FLORET_PRIVATE.exec(proText)?.[0]);
check("each account gets its own library, a third gets none", O.libraryFor(FLORET)?.account === "floret" && O.libraryFor(PROCOUNT)?.account === "procount" && O.libraryFor(OTHER) === null && O.libraryFor({ name: "ذهب النخبة", vertical: "jewelry" }) === null);
const floLeak = keys.filter((k) => PROCOUNT_PRIVATE.test(M.dossierText(build(k, FLORET)).replace(/الدور التقني: [a-z_]+/g, "")));
check("Floret's dossiers carry nothing of Pro Count", floLeak.length === 0, floLeak.slice(0, 5).map((k) => `${k}:${PROCOUNT_PRIVATE.exec(M.dossierText(build(k, FLORET)))?.[0]}`));
const proLeak = keys.filter((k) => FLORET_PRIVATE.test(M.dossierText(build(k, PROCOUNT))));
check("Pro Count's dossiers carry nothing of Floret", proLeak.length === 0, proLeak.slice(0, 5).map((k) => `${k}:${FLORET_PRIVATE.exec(M.dossierText(build(k, PROCOUNT)))?.[0]}`));
const otherLeak = keys.filter((k) => { const t = M.dossierText(build(k, OTHER)); return PROCOUNT_PRIVATE.test(t) || FLORET_PRIVATE.test(t); });
check("a third account's dossiers inherit neither", otherLeak.length === 0, otherLeak.slice(0, 5));
const rtLeak = keys.filter((k) => PROCOUNT_PRIVATE.test(rt(k, FLORET, approvedAll(FLORET))) || FLORET_PRIVATE.test(rt(k, PROCOUNT, approvedAll(PROCOUNT))));
check("runtimes with approved objections stay isolated", rtLeak.length === 0, rtLeak.slice(0, 5));
check("a knowledge row from another account is not trusted by key alone: render reads only what it is given", !rt("whatsapp.sales", FLORET, []).includes("accountant"));
const pStd = `${std} ${Object.values(P.ROLE_APPLICATION).map((r) => r.text).join(" ")}`;
check("the shared standard names neither account", !PROCOUNT_PRIVATE.test(pStd) && !FLORET_PRIVATE.test(pStd));

// ── السجل والأدوات ────────────────────────────────────────────────
check("tools come from the registry's execution function", Object.values(ROLE_MAP).filter((r) => r.fn && PROMPT_LIBRARY[r.key]).every((r) => build(r.key, OTHER).tools.includes(r.fn!)));
check("an engine-less job says so in its tools", build("instagram.analyst", OTHER).tools.includes("بلا محرّك اليوم"));
check("internal roles have no external permission", keys.filter((k) => !PROMPT_LIBRARY[k]!.externalBehavior).every((k) => build(k, OTHER).tools.includes("لا إرسال خارجي")));
check("a manager for every employee", keys.every((k) => /المدير: \S/.test(build(k, OTHER).identity)));
check("the account name is filled in, no placeholder left", keys.every((k) => !M.dossierText(build(k, PROCOUNT)).includes("{account}") && build(k, PROCOUNT).identity.includes("Pro Count for Accounting")));
check("the library's 14-section render is untouched (≤ 3500)", keys.every((k) => ACCOUNTS.every((a) => renderPrompt(PROMPT_LIBRARY[k]!, a).length <= 3500)));

// ── المحرر ────────────────────────────────────────────────────────
const base = build("whatsapp.sales", PROCOUNT);
check("cleanSections refuses an unknown section", !!M.cleanSections({ nonsense: "x" }, base).error);
check("...an empty one", !!M.cleanSections({ mission: "  " }, base).error);
check("...a non-string", !!M.cleanSections({ mission: 5 }, base).error);
check("...and keeps the server's version section", M.cleanSections({ version: "hacked", mission: "جديد" }, base).sections.version === base.version && M.cleanSections({ mission: "جديد" }, base).sections.mission === "جديد");
const d = M.lineDiff("a\nb\nc", "a\nc\nd");
check("line diff: same/del/add", JSON.stringify(d) === JSON.stringify([{ op: "same", text: "a" }, { op: "del", text: "b" }, { op: "same", text: "c" }, { op: "add", text: "d" }]), d);
check("an owner-written line enters the runtime; a ▪ line does not", (() => {
  const s = { ...base, mission: `${base.mission}\nسطر من صاحب العمل\n${M.DOC_ONLY} سطر توثيق` };
  const t = M.renderRuntime({ employeeKey: "whatsapp.sales", sections: s, externalBehavior: true, account: PROCOUNT });
  return t.includes("سطر من صاحب العمل") && !t.includes("سطر توثيق");
})());

// ── الترحيل ───────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/077_dossiers.sql"), "utf8"));
check("077 carries every statement of DOCS_TABLES_SQL", DOCS_TABLES_SQL.every((q) => mig.includes(norm(q))));
const schemaSrc = readFileSync(join(here, "../../../../../lib/db/src/schema/org-docs.ts"), "utf8");
check("the drizzle schema names the table and its five statuses", schemaSrc.includes(`pgTable("employee_documentation"`) && ["draft", "proposed", "approved", "active", "superseded"].every((s) => schemaSrc.includes(`'${s}'`)));
check("the schema index exports it", readFileSync(join(here, "../../../../../lib/db/src/schema/index.ts"), "utf8").includes(`export * from "./org-docs";`));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
