// ── الظل: التعليمات الحالية مقابل المقترحة، على مدخلات الحساب الحقيقية ─────
// لكل موظفٍ له نسخة في المكتبة: يُؤخذ من حسابه هو وحده حتى ٣ مدخلات حديثة، ويكتب عليها
// مرتين بمسار الكتابة الحقيقي نفسه داخل المحاكاة — بشخصيته المحفوظة، ثم بالنص المقترح —
// ثم تُطبَّق فحوص الكود الحقيقية على الاثنين. الحكم بالكود وحده، على «قواعد» المخالفات
// لا نصّها (issueRule: «الرسالة ١٢٦ كلمة» و«الرسالة ١٢١ كلمة» قاعدةٌ واحدة: length):
//   better: قواعد المقترح جزءٌ من قواعد الحالي وأقل · same: القواعد نفسها (سليمان، أو خالفا الفحص نفسه)
//   failed_checks: المقترح جاء بقاعدةٍ لم يخالفها الحالي ولم يُصلح شيئاً
//   mixed: أصلح قاعدةً وجاء بأخرى — يحجب التفعيل الآلي ويُعرض بالقائمتين · no_output: المقترح لم يكتب
//   no_model_path: موظفٌ بالكود وحده فعلاً (model-paths.ts) — بلا أي نداء
//   not_covered: له مسار نموذج لا يمرّ به الظل بعد — «لم يُجرَّب»، لا يُفعَّل آلياً ولا جماعياً.
// المحاكاة تعني: البوابة ترفض كل إرسال، ولا صف عمل يُكتب، ولا إيصال ولا استهلاك ولا مقياس
// مزوّد ولا نبض ولا تنفيذ يُحسب. سقف ٦٠ نداء نموذج للحساب في اليوم، وترتيب الموظفين يدور يومياً:
// يبدأ اليوم من الموظف الذي توقف عنده السقف في آخر دفعة سابقة، فلا يأخذ البريد الميزانية كل يوم
// ويبقى الواتساب «budget» (2026-11-11). لا شيء يُفعَّل هنا.

import { sql } from "drizzle-orm";
import { db, targetAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { dubaiNow } from "../accounts/pure";
import { accountHalted, isHalted } from "./controls";
import { isCodeOnly, MODEL_PATHS } from "./model-paths";
import { PROMPT_LIBRARY, renderPrompt } from "./prompts";
import { promptTarget } from "./proposals";
import { ensureSimTables } from "./sim-schema";
import { newSimContext, withPersona, withSimulation, type SimContext } from "./simulation";

export const SHADOW_DAILY_CALLS = 60;
export const SHADOW_MAX_SAMPLES = 3;
export type ShadowVerdict = "failed_checks" | "better" | "same" | "mixed" | "no_output" | "no_model_path" | "not_covered" | "no_samples" | "budget";
/** أحكامٌ قارنت عيّنةً فعلاً. */
export const COMPARED: ShadowVerdict[] = ["failed_checks", "better", "same", "mixed", "no_output"];

export interface Sample { ref: Record<string, unknown>; excerpt: string; data: any }
export interface Output { text: string | null; issues: string[]; label?: string | null; note?: string | null }
interface Adapter {
  key: string; role: string;
  /** أقصى ما قد يستهلكه تشغيلٌ واحد (المسار يعيد الكتابة أحياناً). */
  maxCalls: number;
  samples: (userId: number) => Promise<Sample[]>;
  run: (userId: number, s: Sample) => Promise<Output>;
}

// ── الحكم ─────────────────────────────────────────────────────────
// كل مخالفةٍ تُردّ إلى قاعدتها: الرقم والنص المقتبس فيها ليسا القاعدة.
const RULES: Array<[RegExp, string | ((m: RegExpExecArray) => string)]> = [
  [/^لا ملخص في أولها/, "lead_missing"],
  [/^الملخص \S+ كلمة/, "lead_long"],
  [/^لا زر دعوة/, "cta_missing"],
  [/^الرسالة الأولى \S+ كلمة/, "first_length"],
  [/^الرسالة \S+ كلمة/, "length"],
  [/^مبالغة أو ضمان/, "hype"],
  [/^استعجال مصطنع/, "urgency"],
  [/^يوحي بإشعار رسمي/, "official"],
  [/^رقم ليس في معرفة الشركة/, "number_not_in_knowledge"],
  [/^رقم ليس في الوقائع/, "number_not_in_facts"],
  [/^شكل السرد/, "narrative_shape"],
  [/^تشبه موجة سابقة/, "similar_wave"],
  [/^العنوان \S+ كلمة/, "subject_length"],
  [/تطلب موعداً أو مكالمة/, "asks_meeting"],
  [/^لا سؤال في الرسالة الأولى/, "no_question"],
  [/^أول الرسالة لا يذكر شركته/, "opening_no_company"],
  [/^عبارة قالب/, "cliche"],
  [/^المتابعة الثانية ناقصة/, "followup2_missing"],
  [/^المتابعة الثانية \S+ كلمة/, "followup2_length"],
  [/^المتابعة الثالثة ناقصة/, "followup3_missing"],
  [/^المتابعة الثالثة \S+ كلمة/, "followup3_length"],
  [/^ملاحظة لينكدإن ناقصة/, "linkedin_missing"],
  [/^ملاحظة لينكدإن \S+ حرفاً/, "linkedin_length"],
  [/^مال في الرسالة/, "money"],
  [/^الرد العلني أطول من سطرين/, "public_reply_long"],
  // التصنيف: الخطأ نفسه (machine بدل not_customer) قاعدة، وخطأٌ آخر (hot بدل not_customer) قاعدة أخرى.
  [/^صنّف (\S+) والمسجَّل (\S+)/, (m) => `label:${m[1]}≠${m[2]}`],
];
/** قاعدة المخالفة، بلا أرقامها ولا ما اقتُبس فيها. Pure. */
export function issueRule(issue: string): string {
  const t = issue.trim();
  for (const [re, r] of RULES) { const m = re.exec(t); if (m) return typeof r === "string" ? r : r(m); }
  return t.replace(/«[^»]*»/g, "«…»").replace(/[\d٠-٩][\d٠-٩.,٬]*/g, "#").replace(/\s+/g, " ").trim();
}
const rulesOf = (o: Output) => new Set(o.issues.map(issueRule));
const firstOf = (o: Output, rules: Set<string>) => o.issues.filter((i, n, a) => rules.has(issueRule(i)) && a.findIndex((x) => issueRule(x) === issueRule(i)) === n);

/** الحكم بالكود على عيّنةٍ واحدة، بمقارنة قواعد المخالفات. Pure. */
export function verdictOf(current: Output, proposed: Output): { verdict: ShadowVerdict; detail: string } {
  const has = (o: Output) => !!(o.text && o.text.trim()) || !!o.label;
  if (!has(proposed)) return { verdict: "no_output", detail: proposed.note ?? "المقترح لم يكتب شيئاً" };
  const P = rulesOf(proposed), C = rulesOf(current);
  const list = (xs: string[]) => xs.slice(0, 3).join(" · ");
  if (!has(current)) return P.size
    ? { verdict: "failed_checks", detail: `الحالي لم يكتب، والمقترح خالف: ${list(proposed.issues)}` }
    : { verdict: "better", detail: "الحالي لم يكتب شيئاً، والمقترح كتب وسلم من الفحوص" };
  const added = new Set([...P].filter((r) => !C.has(r))), fixed = new Set([...C].filter((r) => !P.has(r)));
  if (!added.size && !fixed.size) return P.size
    ? { verdict: "same", detail: `كلاهما خالف الفحص نفسه: ${list(firstOf(proposed, P))}` }
    : { verdict: "same", detail: "كلاهما سلم من الفحوص" };
  if (!added.size) return { verdict: "better", detail: `المقترح أصلح: ${list(firstOf(current, fixed))}${P.size ? ` · وبقي فيه ما في الحالي: ${list(firstOf(proposed, P))}` : "، وسلم من الفحوص"}` };
  if (!fixed.size) return { verdict: "failed_checks", detail: `المقترح خالف ما لم يخالفه الحالي: ${list(firstOf(proposed, added))}` };
  return { verdict: "mixed", detail: `مختلط — أصلح: ${list(firstOf(current, fixed))} · وجاء بجديد: ${list(firstOf(proposed, added))}` };
}

/** موظفٌ بلا مسار موصول للظل: بالكود وحده فعلاً، أو له نموذج لم يُجرَّب. Pure. */
export function uncoveredVerdict(key: string): { verdict: "no_model_path" | "not_covered"; detail: string } {
  if (isCodeOnly(key)) return { verdict: "no_model_path", detail: `موظف بالكود وحده: لا نداء نموذج في عمله (${MODEL_PATHS[key]!.where})` };
  const where = MODEL_PATHS[key]?.where;
  return { verdict: "not_covered", detail: `لم يُجرَّب: له مسار نموذج${where ? ` (${where})` : ""} لا يمرّ به الظل بعد — لا يُفعَّل آلياً` };
}

/** ترتيب اليوم: من الموظف الذي توقف عنده السقف، ثم الدوران إلى أول القائمة. Pure. */
export function rotateFrom(keys: string[], start: string | null | undefined): string[] {
  const i = start ? keys.indexOf(start) : -1;
  return i <= 0 ? keys : [...keys.slice(i), ...keys.slice(0, i)];
}

export interface ShadowSummary {
  runs: number; samples: number; verdicts: Partial<Record<ShadowVerdict, number>>; lastRunAt: string | null;
  warnings: string[]; ok: boolean;
}
/** خلاصة دفعة: إنذار إن لم تكن عيّنة أو خالف المقترح فحصاً واحداً. Pure. */
export function summarize(rows: Array<{ verdict: string; created_at?: unknown; proposed_issues?: unknown }>): ShadowSummary {
  const verdicts: Partial<Record<ShadowVerdict, number>> = {};
  for (const r of rows) verdicts[r.verdict as ShadowVerdict] = (verdicts[r.verdict as ShadowVerdict] ?? 0) + 1;
  const samples = rows.filter((r) => COMPARED.includes(r.verdict as ShadowVerdict)).length;
  const warnings: string[] = [];
  if (!rows.length) warnings.push("لم يُشغَّل الظل لهذا المقترح بعد");
  else if (!samples) warnings.push(verdicts.not_covered ? "لم يُجرَّب: له مسار نموذج لا يمرّ به الظل بعد" : verdicts.no_model_path ? "لا مسار نموذج لهذا الموظف (بالكود وحده): لا مقارنة ممكنة" : "لا عيّنات حقيقية من هذا الحساب للمقارنة");
  if (verdicts.failed_checks) warnings.push(`المقترح خالف فحوص الكود في ${verdicts.failed_checks} عيّنة`);
  if (verdicts.mixed) warnings.push(`مختلط في ${verdicts.mixed} عيّنة: أصلح فحصاً وخالف آخر`);
  if (verdicts.no_output) warnings.push(`المقترح لم يكتب شيئاً في ${verdicts.no_output} عيّنة`);
  // «same» لأن الاثنين خالفا الفحص نفسه ليس دليلاً على المقترح.
  const dirty = rows.filter((r) => (r.verdict === "same" || r.verdict === "better") && Array.isArray(r.proposed_issues) && r.proposed_issues.length).length;
  if (dirty) warnings.push(`المقترح خالف فحصاً في ${dirty} عيّنة حُكم عليها same/better (خالفه الحالي أيضاً)`);
  const last = rows.map((r) => (r.created_at ? new Date(r.created_at as string).getTime() : 0)).sort((a, b) => b - a)[0];
  return { runs: rows.length, samples, verdicts, lastRunAt: last ? new Date(last).toISOString() : null, warnings, ok: samples > 0 && !dirty && !verdicts.failed_checks && !verdicts.mixed && !verdicts.no_output && !verdicts.not_covered };
}

// ── المسارات ───────────────────────────────────────────────────────
const stripTags = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const cut = (s: unknown, n = 300) => String(s ?? "").slice(0, n);
const rows = async <T = any>(q: any): Promise<T[]> => (await db.execute<any>(q)).rows as T[];

async function profileOf(userId: number) {
  const [p] = await rows(sql`SELECT p.name, p.vertical, p.catalog_source, p.followup_style, u.display_name FROM users u LEFT JOIN business_profile p ON p.user_id = u.id WHERE u.id = ${userId}`);
  return p ?? {};
}
async function shopAccount(userId: number): Promise<boolean> {
  const { isShop } = await import("../email/seed");
  return isShop(await profileOf(userId));
}
/** فحوص Floret: كلماتها الممنوعة، ولا مال في أي صورة. */
async function floretIssues(text: string): Promise<string[]> {
  const { shopIssues } = await import("../email/shop-writer");
  const { MONEY } = await import("../smart-followup");
  const out = shopIssues(text);
  const m = MONEY.exec(text);
  if (m) out.push(`مال في الرسالة: «${m[0]}»`);
  return out;
}

async function thread(userId: number, phone: string, limit = 14) {
  const r = await rows<any>(sql`SELECT from_me, text, created_at, msg_type FROM wa_thread_messages WHERE user_id = ${userId} AND phone = ${phone} AND coalesce(text, '') <> '' ORDER BY created_at DESC LIMIT ${limit}`);
  return r.reverse().map((x) => ({ fromMe: !!x.from_me, text: String(x.text ?? ""), at: new Date(x.created_at), voice: x.msg_type === "voice" }));
}

/** لماذا لم تُكتب مسودة: لم يرد نموذج، أو ردّ بشكلٍ لا يقرؤه parseDraft (وأوله). Pure. */
export function noteOf(t: { reason?: "no_reply" | "unparsed"; raw?: string }): string {
  if (t.reason === "unparsed") return `كتب النموذج بشكلٍ لا يقرؤه parseDraft: «${(t.raw ?? "").replace(/\s+/g, " ").slice(0, 200)}»`;
  return "لم يرد نموذج (المزوّدون تعذّروا أو نفدت ميزانية العيّنة)";
}

function campaignAdapter(key: string, role: "email" | "email_followup" | "email_creator"): Adapter {
  return {
    key, role, maxCalls: 1,
    // موجة المتابعة عمل كاتب المتابعات وحده: أُعطيت لمنشئ الحملات يوم ١٣ نوفمبر فكتبها بقالب المتابعة
    // ولم يقرأها parseDraft («no_output» على عيّنةٍ ليست من عمله). والعكس كذلك.
    samples: async (userId) => (await rows(sql`SELECT id, user_id, name, goal, filter, language, tone, intensity, angle, source_list_id FROM email_missions WHERE user_id = ${userId} AND coalesce(goal, '') <> ''
        AND ${role === "email_followup" ? sql`coalesce(agent_role, 'email') = 'email_followup'` : sql`coalesce(agent_role, 'email') <> 'email_followup'`}
        ORDER BY (coalesce(agent_role, 'email') = ${role}) DESC, id DESC LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((m: any) => ({ ref: { table: "email_missions", id: Number(m.id) }, excerpt: `${m.name}: ${cut(m.goal, 240)}`, data: m })),
    run: async (userId, s) => {
      const { writeCampaign, brief } = await import("../email/agent");
      const { formatIssues, guardCheck, tooSimilar, leadOf } = await import("../email/team");
      const m = s.data;
      // المدخل نفسه الذي يعطيه runMission للكاتب: ما قيل لهذا الجمهور، والشدّة من الإعدادات إن لم تحملها المهمة.
      const { priorWavesFor } = await import("../email/missions");
      const { getSettings } = await import("../email/service");
      const prior = await priorWavesFor({ id: Number(m.id), userId, sourceListId: m.source_list_id ?? null, filter: m.filter ?? {} } as any);
      const intensity = m.intensity ?? (await getSettings(userId).catch(() => null))?.followIntensity ?? null;
      const trace: { reason?: "no_reply" | "unparsed"; raw?: string } = {};
      const out = await writeCampaign(userId, { filter: m.filter ?? {}, goal: m.goal, language: m.language ?? undefined, tone: m.tone, intensity, angle: m.angle, role,
        priorWaves: prior.waves, usedAngles: prior.angles, trace });
      if (!out) return { text: null, issues: [], note: noteOf(trace) };
      const d = out.draft;
      const text = `${d.subjects.join(" | ")}\n${stripTags(d.html)}`;
      if (await shopAccount(userId)) return { text, issues: [...new Set(await floretIssues(text))] };
      const knowledge = await brief(userId, m.filter?.sectors ?? [], 3500, { lessons: false }).catch(() => "");
      const previous = (await rows(sql`SELECT html FROM email_campaigns WHERE user_id = ${userId} AND coalesce(html, '') <> '' ORDER BY id DESC LIMIT 5`)).map((r: any) => leadOf(String(r.html)));
      const similar = tooSimilar(d.html, previous);
      const issues = [
        ...formatIssues(d.html, role === "email_followup" ? "followup" : "first"),
        ...guardCheck([...d.subjects, d.html, ...d.followups.map((f) => `${f.subject} ${f.html}`)], knowledge),
        ...(similar ? [`تشبه موجة سابقة: «${similar.slice(0, 80)}»`] : []),
      ];
      return { text, issues: [...new Set(issues)] };
    },
  };
}

const ADAPTERS: Adapter[] = [
  campaignAdapter("email.copywriter", "email"),
  campaignAdapter("email.followup", "email_followup"),
  // المنشئ يكتب بمسار الكاتب نفسه (runMission → writeCampaign بدوره)، فتُطبَّق عليه فحوص الكاتب نفسها.
  campaignAdapter("email.creator", "email_creator"),
  {
    // المدير التنفيذي: السرد فوق حزمة وقائع اليوم؛ الفحص هو فحص الكود نفسه — بلا رقم، أو كل رقمٍ من الوقائع.
    key: "executive.ceo", role: "ceo_agent", maxCalls: 2,
    samples: async (userId) => {
      const { collectFacts } = await import("./ceo");
      const pack = await collectFacts(userId);
      if (pack.thin) return []; // الوقائع القليلة لا تمرّ بالنموذج في المسار الحقيقي
      return [{ ref: { table: "fact_pack", day: pack.day }, excerpt: `وقائع ${pack.day}: ${pack.activity.executions} تنفيذ، ${pack.problems.length} مشكلة`, data: pack }];
    },
    run: async (userId, s) => {
      const { writeNarrative, CEO_PERSONA, CEO_ROLE } = await import("./ceo");
      const { personaFor } = await import("./simulation");
      const [emp] = await rows(sql`SELECT persona FROM bot_employees WHERE user_id = ${userId} AND role = ${CEO_ROLE} LIMIT 1`);
      const n = await writeNarrative(s.data, personaFor(CEO_ROLE, (emp as any)?.persona || CEO_PERSONA));
      if (n.status === "model_unavailable") return { text: null, issues: [], note: "لم يرد نموذج" };
      if (n.status === "validated") return { text: n.summary, issues: [] };
      const issues = n.violations.length ? n.violations.map((x) => `رقم ليس في الوقائع: «${x}»`) : ["شكل السرد غير صحيح (ليس JSON بالشكل المطلوب أو نصه فارغ)"];
      return { text: "— رُفض السرد مرتين، والتقرير بالوقائع وحدها —", issues };
    },
  },
  {
    key: "email.replies", role: "email_replies", maxCalls: 1,
    samples: async (userId) => (await rows(sql`SELECT id, subject, text, intent FROM email_inbound WHERE user_id = ${userId} AND coalesce(kind, 'reply') = 'reply' AND coalesce(text, '') <> ''
        AND coalesce(intent, '') NOT IN ('opt_out','auto_reply','bounce') ORDER BY received_at DESC LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((r: any) => ({ ref: { table: "email_inbound", id: Number(r.id) }, excerpt: `${cut(r.subject, 80)} — ${cut(r.text, 220)}`, data: r })),
    run: async (userId, s) => {
      const { draftReply } = await import("../email/inbound");
      const { brief } = await import("../email/agent");
      const { guardCheck } = await import("../email/team");
      const out = await draftReply(userId, Number(s.data.id));
      if (!out?.body) return { text: null, issues: [] };
      if (await shopAccount(userId)) return { text: out.body, issues: await floretIssues(out.body) };
      const knowledge = `${await brief(userId, [], 3500, { lessons: false }).catch(() => "")}\n${s.data.text ?? ""}`;
      return { text: out.body, issues: guardCheck([out.body], knowledge) };
    },
  },
  {
    key: "whatsapp.followup", role: "followup", maxCalls: 4,
    samples: async (userId) => (await rows(sql`SELECT phone FROM wa_thread_messages WHERE user_id = ${userId} AND created_at > now() - interval '45 days' GROUP BY phone
        HAVING count(*) FILTER (WHERE NOT from_me) > 0 AND max(created_at) FILTER (WHERE from_me) > coalesce(max(created_at) FILTER (WHERE NOT from_me), '-infinity')
        ORDER BY max(created_at) DESC LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((r: any) => ({ ref: { table: "wa_thread_messages", phone: String(r.phone) }, excerpt: `محادثة ${String(r.phone).slice(-4)}`, data: r })),
    run: async (userId, s) => {
      const { compose, MAX_RUNGS } = await import("../smart-followup");
      const p = await profileOf(userId);
      const turns = await thread(userId, s.data.phone);
      const d = await compose(userId, s.data.phone, turns, 0, [], MAX_RUNGS, p.vertical ?? null, p.followup_style ?? "rich");
      if (!d.text) return { text: null, issues: [], note: d.reason };
      const issues = d.send ? [] : [d.reason];
      if (p.vertical === "jewelry") issues.push(...(await floretIssues(d.text)));
      return { text: d.text, issues: [...new Set(issues)] };
    },
  },
  ...(["sales", "support"] as const).map((role): Adapter => ({
    key: `whatsapp.${role}`, role, maxCalls: 2,
    samples: async (userId) => (await rows(sql`SELECT phone FROM wa_thread_messages WHERE user_id = ${userId} AND NOT from_me AND coalesce(text, '') <> '' AND created_at > now() - interval '30 days'
        GROUP BY phone ORDER BY max(created_at) DESC LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((r: any) => ({ ref: { table: "wa_thread_messages", phone: String(r.phone) }, excerpt: `محادثة ${String(r.phone).slice(-4)}`, data: r })),
    run: async (userId, s) => {
      const { simulate } = await import("../arena");
      const all = await thread(userId, s.data.phone, 12);
      const lastIn = all.map((t) => !t.fromMe).lastIndexOf(true);
      const turns = all.slice(0, lastIn + 1).map((t) => ({ role: (t.fromMe ? "assistant" : "user") as "assistant" | "user", content: t.text }));
      const a = await simulate(userId, role, turns);
      if (!a.reply) return { text: null, issues: a.reason ? [a.reason] : [], note: a.reason ?? null };
      const issues = a.reason ? [a.reason] : [];
      if ((await profileOf(userId)).vertical === "jewelry") issues.push(...(await floretIssues(a.reply)));
      return { text: a.reply, issues };
    },
  })),
  {
    key: "target_accounts.writer", role: "accounts_writer", maxCalls: 3,
    samples: async (userId) => (await rows(sql`SELECT a.id, a.company, p.id AS person_id, p.name, p.title, p.why, p.linkedin_url, p.source_url, p.email_fallback FROM target_accounts a
        JOIN target_people p ON p.account_id = a.id AND p.user_id = a.user_id AND p.is_decision_maker WHERE a.user_id = ${userId} ORDER BY a.id DESC LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((r: any) => ({ ref: { table: "target_accounts", id: Number(r.id), person: Number(r.person_id) }, excerpt: `${r.company} — ${r.name}${r.title ? `، ${r.title}` : ""}`, data: r })),
    run: async (userId, s) => {
      const { writeFor } = await import("../accounts/pipeline");
      const [acc] = await db.select().from(targetAccountsTable).where(and(eq(targetAccountsTable.userId, userId), eq(targetAccountsTable.id, Number(s.data.id)))).limit(1);
      if (!acc) return { text: null, issues: [], note: "الحساب المستهدف لم يعد موجوداً" };
      const r = await writeFor(userId, acc, { name: s.data.name, title: s.data.title, why: s.data.why, linkedinUrl: s.data.linkedin_url, source: s.data.source_url, isDecisionMaker: true },
        { fallback: !!s.data.email_fallback, signal: acc.signal ? { kind: "news", label: "", text: acc.signal, source: acc.signalSource ?? "" } : null, senderFirst: "Team", siteFacts: acc.notes ?? "" });
      if (!r.written) return { text: null, issues: r.issues, note: r.issues[0] ?? null };
      return { text: `${r.written.subject}\n${r.written.body}`, issues: r.issues };
    },
  },
  {
    key: "shared.collector", role: "collector", maxCalls: 1,
    samples: async (userId) => (await rows(sql`SELECT phone, label FROM conversation_reviews WHERE user_id = ${userId} AND label IS NOT NULL ORDER BY reviewed_at DESC NULLS LAST LIMIT ${SHADOW_MAX_SAMPLES}`))
      .map((r: any) => ({ ref: { table: "conversation_reviews", phone: String(r.phone) }, excerpt: `محادثة ${String(r.phone).slice(-4)} — المسجَّل: ${r.label}`, data: r })),
    run: async (userId, s) => {
      const { reviewOne } = await import("../graph/review");
      const r = await reviewOne(userId, s.data.phone, (await profileOf(userId)).vertical ?? null);
      if (!r) return { text: null, issues: [], label: null };
      return { text: `${r.label}: ${r.summary}`, label: r.label, issues: r.label === s.data.label ? [] : [`صنّف ${r.label} والمسجَّل ${s.data.label}`] };
    },
  },
  ...(["instagram", "tiktok"] as const).flatMap((p): Adapter[] => {
    const prefix = p === "instagram" ? "ig" : "tt";
    const comments = async (userId: number) => (await rows(sql`SELECT id, author, text, intent FROM social_comments WHERE user_id = ${userId} AND platform = ${p} AND coalesce(text, '') <> ''
        ORDER BY id DESC LIMIT ${SHADOW_MAX_SAMPLES}`)).map((r: any) => ({ ref: { table: "social_comments", id: Number(r.id) }, excerpt: `@${r.author}: ${cut(r.text, 200)}`, data: r }));
    return [
      {
        key: `${p}.writer`, role: `${prefix}_writer`, maxCalls: 1, samples: comments,
        run: async (userId, s) => {
          const { draftCommentReply } = await import("../social/agent");
          const { guardCheck } = await import("../email/team");
          const r = await draftCommentReply(userId, p, { author: s.data.author, text: s.data.text, intent: s.data.intent ?? "other" }, []);
          if (!r) return { text: null, issues: [] };
          const issues = [...guardCheck([r], s.data.text ?? ""), ...(r.split(/\n+/).filter(Boolean).length > 2 ? ["الرد العلني أطول من سطرين"] : [])];
          return { text: r, issues };
        },
      },
      {
        key: `${p}.triage`, role: `${prefix}_triage`, maxCalls: 1,
        samples: async (userId) => (await comments(userId)).filter((s) => !!s.data.intent),
        run: async (userId, s) => {
          const { triage } = await import("../social/agent");
          const t = await triage(userId, p, s.data.text, s.data.author);
          return { text: `${t.intent}: ${t.why}`, label: t.intent, issues: t.intent === s.data.intent ? [] : [`صنّف ${t.intent} والمسجَّل ${s.data.intent}`] };
        },
      },
    ];
  }),
];
export const SHADOW_KEYS = ADAPTERS.map((a) => a.key);
const adapterFor = (key: string) => ADAPTERS.find((a) => a.key === key);

// ── التشغيل ───────────────────────────────────────────────────────
/** ما استُهلك اليوم (بتوقيت دبي) من نداءات الظل والسيناريو لهذا الحساب. */
export async function callsToday(userId: number, now = new Date()): Promise<number> {
  await ensureSimTables();
  const from = new Date(`${dubaiNow(now).date}T00:00:00+04:00`);
  const [r] = await rows(sql`SELECT (SELECT coalesce(sum(model_calls), 0) FROM shadow_runs WHERE user_id = ${userId} AND created_at >= ${from})::int
      + (SELECT coalesce(sum(model_calls), 0) FROM sim_e2e_runs WHERE user_id = ${userId} AND started_at >= ${from})::int AS n`);
  return Number((r as any)?.n ?? 0);
}

/**
 * أين توقف السقف في آخر دفعةٍ كاملة قبل اليوم (بتوقيت دبي): أول موظفٍ كُتب له budget فيها.
 * دفعة موظفٍ واحد لا تُحسب. لا توقف = null (الترتيب العادي).
 */
export async function stoppedAt(userId: number, now = new Date()): Promise<string | null> {
  const from = new Date(`${dubaiNow(now).date}T00:00:00+04:00`);
  const [last] = await rows<any>(sql`SELECT batch_id FROM shadow_runs WHERE user_id = ${userId} AND created_at < ${from}
      GROUP BY batch_id HAVING count(DISTINCT employee_key) > 1 ORDER BY max(id) DESC LIMIT 1`);
  if (!last) return null;
  const [b] = await rows<any>(sql`SELECT employee_key FROM shadow_runs WHERE user_id = ${userId} AND batch_id = ${last.batch_id} AND verdict = 'budget' ORDER BY id LIMIT 1`);
  return b ? String(b.employee_key) : null;
}

async function proposedPrompt(userId: number, key: string): Promise<{ text: string; version: number } | null> {
  const entry = PROMPT_LIBRARY[key];
  if (!entry) return null;
  const p = await profileOf(userId);
  return { text: renderPrompt(entry, { name: p.name ?? p.display_name ?? "", vertical: p.vertical ?? null }), version: entry.version };
}

async function storedPersona(userId: number, key: string): Promise<string | null> {
  const [e] = await rows(sql`SELECT persona FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${key} LIMIT 1`);
  return (e as any)?.persona ?? null;
}

async function insertRun(userId: number, batch: string, r: { employeeKey: string; proposalId: number | null; version: number | null; sample?: Sample; current?: Output; proposed?: Output; verdict: ShadowVerdict; detail: string; calls: number; trigger: string }) {
  const J = (v: unknown) => sql`${JSON.stringify(v ?? [])}::jsonb`;
  const [row] = await rows(sql`INSERT INTO shadow_runs (user_id, batch_id, employee_key, proposal_id, library_version, sample_ref, input_excerpt, current_output, proposed_output, current_issues, proposed_issues, verdict, detail, model_calls, trigger)
    VALUES (${userId}, ${batch}, ${r.employeeKey}, ${r.proposalId}, ${r.version == null ? null : String(r.version)}, ${r.sample ? J(r.sample.ref) : sql`NULL::jsonb`}, ${r.sample?.excerpt?.slice(0, 600) ?? null},
      ${r.current?.text?.slice(0, 6000) ?? null}, ${r.proposed?.text?.slice(0, 6000) ?? null}, ${J(r.current?.issues)}, ${J(r.proposed?.issues)}, ${r.verdict}, ${r.detail.slice(0, 1000)}, ${r.calls}, ${r.trigger}) RETURNING *`);
  return row;
}

/** تشغيل واحد بمسار الموظف داخل سياق محاكاة: الشخصية المعطاة (null = المحفوظة). لا يرمي. */
async function runVariant(ctx: SimContext, a: Adapter, userId: number, s: Sample, persona: string | null): Promise<{ out: Output; calls: number }> {
  const before = ctx.budget.used;
  const out = await withSimulation(ctx, () => withPersona(a.role, persona, () => asAgent(userId, a.role, () => a.run(userId, s))))
    .catch((e: any): Output => ({ text: null, issues: [], note: `تعذّر التشغيل: ${String(e?.message ?? e).slice(0, 160)}` }));
  return { out, calls: ctx.budget.used - before };
}

export interface ShadowResult { batchId: string; ran: number; skipped: Array<{ employeeKey: string; why: string }>; callsUsed: number; rows: any[] }

/**
 * الظل لحساب: لكل موظفٍ له نسخة في المكتبة (أو لموظفٍ واحد)، أحدث المدخلات من هذا الحساب وحده.
 * لا يفعّل شيئاً، ولا يرسل شيئاً، ولا يكتب إلا في shadow_runs.
 */
export async function runShadow(userId: number, o: { employeeKey?: string | null; trigger?: string; budget?: number; adapters?: Adapter[] } = {}): Promise<ShadowResult> {
  await ensureSimTables();
  const batchId = `shadow:${userId}:${Date.now().toString(36)}`;
  const trigger = o.trigger ?? "manual";
  const out: ShadowResult = { batchId, ran: 0, skipped: [], callsUsed: 0, rows: [] };
  if (await accountHalted(userId, "org_shadow")) { out.skipped.push({ employeeKey: o.employeeKey ?? "*", why: "الحساب موقوف" }); return out; }
  const staff = (await rows<{ employee_key: string }>(sql`SELECT employee_key FROM bot_employees WHERE user_id = ${userId} AND employee_key IS NOT NULL ORDER BY employee_key`)).map((r) => String(r.employee_key));
  const keys = rotateFrom(staff.filter((k) => PROMPT_LIBRARY[k] && (!o.employeeKey || k === o.employeeKey)), await stoppedAt(userId));
  if (o.employeeKey && !keys.length) { out.skipped.push({ employeeKey: o.employeeKey, why: "ليس موظفاً في هذا الحساب أو بلا نسخة في المكتبة" }); return out; }
  const pending = new Map((await rows<any>(sql`SELECT change_id, target FROM improvement_proposals WHERE user_id = ${userId} AND status = 'proposed' AND target LIKE 'prompt:%' ORDER BY change_id DESC`))
    .map((r) => [String(r.target).slice(7), Number(r.change_id)] as const).reverse());
  const cap = o.budget ?? SHADOW_DAILY_CALLS;
  let left = Math.max(0, cap - (await callsToday(userId)));
  const adapters = o.adapters ?? ADAPTERS;

  for (const key of keys) {
    const proposalId = pending.get(key) ?? null;
    const lib = PROMPT_LIBRARY[key]!;
    const a = adapters.find((x) => x.key === key);
    const base = { employeeKey: key, proposalId, version: lib.version, trigger };
    if (!a) {
      const u = uncoveredVerdict(key);
      out.rows.push(await insertRun(userId, batchId, { ...base, verdict: u.verdict, detail: u.detail, calls: 0 }));
      continue;
    }
    const role = a.role;
    const halt = await isHalted({ userId, role });
    if (halt.halted) { out.skipped.push({ employeeKey: key, why: `موقوف: ${halt.reason ?? ""}` }); continue; }
    const samples = (await a.samples(userId).catch(() => [] as Sample[])).slice(0, SHADOW_MAX_SAMPLES);
    if (!samples.length) { out.rows.push(await insertRun(userId, batchId, { ...base, verdict: "no_samples", detail: "لا مدخلات حديثة من هذا الحساب", calls: 0 })); continue; }
    const proposed = await proposedPrompt(userId, key);
    const current = await storedPersona(userId, key);
    for (const s of samples) {
      if (left < 2 * a.maxCalls) {
        out.rows.push(await insertRun(userId, batchId, { ...base, sample: s, verdict: "budget", detail: `سقف اليوم (${cap} نداء) لا يكفي لعيّنة أخرى`, calls: 0 }));
        break;
      }
      const ctx = newSimContext({ userId, kind: "shadow", runId: batchId, budget: Math.min(left, 2 * a.maxCalls) });
      const cur = await runVariant(ctx, a, userId, s, current);
      const prop = await runVariant(ctx, a, userId, s, proposed!.text);
      const calls = cur.calls + prop.calls;
      left -= calls; out.callsUsed += calls;
      const v = verdictOf(cur.out, prop.out);
      out.rows.push(await insertRun(userId, batchId, { ...base, sample: s, current: cur.out, proposed: prop.out, verdict: v.verdict, detail: v.detail, calls }));
      out.ran++;
    }
  }
  logger.info({ userId, batchId, ran: out.ran, calls: out.callsUsed }, "الظل انتهى");
  return out;
}

// ── القراءة ───────────────────────────────────────────────────────
export async function shadowResults(userId: number, o: { employeeKey?: string | null; proposalId?: number | null; limit?: number } = {}) {
  await ensureSimTables();
  return rows(sql`SELECT * FROM shadow_runs WHERE user_id = ${userId} ${o.employeeKey ? sql`AND employee_key = ${o.employeeKey}` : sql``}
    ${o.proposalId ? sql`AND proposal_id = ${o.proposalId}` : sql``} ORDER BY id DESC LIMIT ${Math.min(Math.max(o.limit ?? 100, 1), 500)}`);
}

/** آخر دفعة لهذا الموظف (أو لهذا المقترح) وخلاصتها. لا يرمي: الجدول الغائب = لا ظل. */
export async function shadowSummary(userId: number, o: { employeeKey?: string | null; proposalId?: number | null }): Promise<ShadowSummary & { batchId: string | null }> {
  try {
    await ensureSimTables();
    const [last] = await rows<any>(sql`SELECT batch_id FROM shadow_runs WHERE user_id = ${userId} ${o.employeeKey ? sql`AND employee_key = ${o.employeeKey}` : sql``}
      ${o.proposalId ? sql`AND proposal_id = ${o.proposalId}` : sql``} ORDER BY id DESC LIMIT 1`);
    if (!last) return { ...summarize([]), batchId: null };
    const r = await rows<any>(sql`SELECT verdict, created_at, proposed_issues FROM shadow_runs WHERE user_id = ${userId} AND batch_id = ${last.batch_id}
      ${o.employeeKey ? sql`AND employee_key = ${o.employeeKey}` : sql``} ${o.proposalId ? sql`AND proposal_id = ${o.proposalId}` : sql``}`);
    return { ...summarize(r), batchId: String(last.batch_id) };
  } catch { return { ...summarize([]), batchId: null }; }
}

/** مفتاح الموظف من هدف المقترح، لمن يريد الخلاصة بالمقترح. */
export const employeeOfTarget = (target: string | null | undefined) => (target?.startsWith("prompt:") ? target.slice(7) : null);
export { promptTarget };

// ── الجدول: أيام العمل 06:30 دبي ───────────────────────────────────
const SHADOW_AT = { hour: 6, minute: 30 };
const ranOn = new Map<number, string>();

/** مرور: الحسابات غير الموقوفة التي عندها مقترحات تعليمات معلّقة، مرةً في اليوم. */
export async function shadowTick(now = new Date(), run: typeof runShadow = runShadow): Promise<number[]> {
  const t = dubaiNow(now);
  if (!t.weekday || t.hour < SHADOW_AT.hour || (t.hour === SHADOW_AT.hour && t.minute < SHADOW_AT.minute)) return [];
  await ensureSimTables();
  const users = (await rows<any>(sql`SELECT DISTINCT p.user_id FROM improvement_proposals p WHERE p.status = 'proposed' AND p.target LIKE 'prompt:%'
      AND NOT EXISTS (SELECT 1 FROM business_profile b WHERE b.user_id = p.user_id AND b.team_paused) ORDER BY 1`)).map((r) => Number(r.user_id));
  const done: number[] = [];
  for (const userId of users) {
    if (ranOn.get(userId) === t.date) continue;
    ranOn.set(userId, t.date);
    if (await accountHalted(userId, "org_shadow")) continue;
    const [seen] = await rows(sql`SELECT 1 FROM shadow_runs WHERE user_id = ${userId} AND trigger = 'schedule' AND created_at >= ${new Date(`${t.date}T00:00:00+04:00`)} LIMIT 1`);
    if (seen) continue;
    await run(userId, { trigger: "schedule" }).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 200) }, "الظل المجدول فشل"));
    // المرحلة ٥: بعد الظل، الداخلي منخفض الخطر الذي اجتاز بوابته يُفعَّل (auto-apply.ts). لا يرمي.
    await (await import("./auto-apply")).autoApplyLowRisk(userId, { trigger: "schedule" });
    done.push(userId);
  }
  return done;
}

let timer: NodeJS.Timeout | null = null;
export function startShadowJob(): void {
  if (timer) return;
  const safe = () => void shadowTick().catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "مرور الظل فشل"));
  timer = setInterval(safe, 10 * 60_000);
  timer.unref();
  logger.info("الظل بدأ — أيام العمل 06:30 بتوقيت دبي، لمقترحات التعليمات المعلّقة");
}
export const forgetShadowSchedule = () => ranOn.clear();
export { adapterFor };
