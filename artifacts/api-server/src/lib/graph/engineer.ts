// ── The engineer: the one employee above the team ─────────────────
// The owner's words: «أريد موظفاً فوقهم بمفهوم الجراف إنجنير — خبير في تجربة
// المستخدم والمبيعات والواتساب والوكلاء، هو من يوظّف وهو من يحلّ وهو من
// يدرّب. أعطيه هدفاً ويقوم بكل شيء.» So this is not another persona that
// answers customers. He talks to the owner only, is handed a goal, and runs
// the graph: measures it from the receipts, decides what is missing, hires
// (or, first, reuses) the employee for it, writes their brief, assigns their
// tasks, teaches the ones who fail, and reports in numbers.
//
// He does it through actions, not words: his reply carries a JSON block the
// code executes, and every action is a receipt under his role. What he may
// not do on his own: send anything to a customer, switch sending on, raise
// a cap, or hire anyone who talks to customers without the owner saying so
// in this very thread — those actions are executed only when the owner's
// last message approves them.
//
// The design follows what works in the published practice (AOrchestra,
// ICML 2026; the chief-of-staff pattern): an orchestrator that executes no
// task itself, creates a specialist only when no existing one fits, gives
// each a four-field spec (instruction, context, tools, model), verifies
// every claim against the record before believing it, and plans as data.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, assistantThreadsTable, assistantMessagesTable, botEmployeesTable, businessProfileTable, agentTasksTable,
} from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { receipt } from "./receipts";
import { goalsWithProgress, setGoal, MEASURES } from "./goals";
import { whoDidWhat } from "./backfill";
import { remember } from "../agent-memory";
import { gather, decide } from "../ops-agent";
import { runSmartFollowUps } from "../smart-followup";
import { keeperRound } from "../list-keeper";
import { setTeamPaused } from "./switch";
import { logger } from "../logger";

export const ENGINEER_ROLE = "engineer";
export const ENGINEER = { name: "غانم", title: "مهندس الجراف — مدير الفريق", avatar: "🧭" };
const THREAD_KIND = "engineer";
const HISTORY_TURNS = 20;

// ── What he reads before every answer ────────────────────────────
export async function engineerContext(userId: number): Promise<string> {
  const [goals, team, acts, profile, replies, situations, followups, ops, stops, tasks] = await Promise.all([
    goalsWithProgress(userId).catch(() => []),
    db.select({ role: botEmployeesTable.role, name: botEmployeesTable.name, title: botEmployeesTable.title, kind: botEmployeesTable.kind, active: botEmployeesTable.isActive }).from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId)).orderBy(botEmployeesTable.priority),
    whoDidWhat(userId, 7).catch(() => []),
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1).then((r) => r[0] ?? null),
    db.execute<any>(sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE reply IS NOT NULL)::int AS replied, round(avg(quality_score))::int AS q,
        count(*) FILTER (WHERE skipped LIKE 'رد آلي%')::int AS machines, count(*) FILTER (WHERE rewritten)::int AS rewritten
      FROM auto_reply_log WHERE user_id = ${userId} AND created_at > now() - interval '7 days'`).then((r) => r.rows[0]),
    db.execute<any>(sql`SELECT coalesce(evidence->>'situation', intent, '?') AS s, count(*)::int AS n FROM receipts WHERE user_id = ${userId} AND action IN ('reply','decide') AND at > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`).then((r) => r.rows),
    db.execute<any>(sql`SELECT verdict, executed, count(*)::int AS n FROM followup_deliberations WHERE user_id = ${userId} AND step >= 100 AND created_at > now() - interval '7 days' GROUP BY 1, 2`).then((r) => r.rows),
    gather(userId).then(decide).catch(() => null),
    db.execute<any>(sql`SELECT count(*)::int AS n FROM unsubscribed_phones WHERE user_id = ${userId} AND created_at > now() - interval '7 days'`).then((r) => Number(r.rows[0]?.n ?? 0)),
    db.select({ role: agentTasksTable.role, task: agentTasksTable.task }).from(agentTasksTable).where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.isActive, true))),
  ]);
  const byRole = new Map(acts.map((a) => [a.node, a]));
  const line = (e: typeof team[number]) => {
    const a = byRole.get(e.role);
    return `- ${e.role} «${e.name}» (${e.title ?? ""}, ${e.kind}${e.active ? "" : ", موقوف"}): ${a ? `${a.acts} حركة/٧ أيام، ${a.ok} نجح، ${a.blocked} حُجب، ${a.failed} فشل، ${a.tokens} رمز` : "بلا أي إيصال"}`;
  };
  const taskLines = tasks.reduce((m, t) => { (m[t.role] ??= []).push(t.task); return m; }, {} as Record<string, string[]>);
  const routines = await db.execute<any>(sql`SELECT role, name, trigger_kind, every_minutes, at_hour, is_active, last_run_at FROM agent_routines WHERE user_id = ${userId} ORDER BY role`).then((r) => r.rows).catch(() => []);
  return [
    `═══ الشركة ═══\n${profile?.name ?? "—"} · ${profile?.industry ?? ""} · النشاط: ${profile?.vertical ?? "accounting"} · اللهجة: ${profile?.dialect ?? "تتبع العميل"} · الرد التلقائي: ${profile?.autoReply ? "يعمل" : "متوقف"} · المتابعة: ${profile?.smartFollowup ?? "dry"} (${profile?.followupScope ?? "spoke"}، سلم ${JSON.stringify(profile?.followupLadder ?? "افتراضي")}) · الفريق ${profile?.teamPaused ? "موقوف" : "يعمل"}`,
    `═══ الأهداف ═══\n${goals.length ? goals.map((g: any) => `- «${g.title}»: ${g.progress.current}/${g.target} (${g.progress.state}، باقي ${g.progress.daysLeft} يوماً، المطلوب ${g.progress.perWeek}/أسبوع). مؤشرات مبكرة: ${g.leading.map((l: any) => `${l.label} ${l.value}`).join("، ")}. الثمن: ${g.counters.map((c: any) => `${c.label} ${c.value}${c.unit}`).join("، ")}.`).join("\n") : "- لا هدف بعد. اطلب من صاحب العمل هدفاً برقم وموعد قبل أي شيء."}`,
    `═══ الفريق (${team.length}) وما فعله كل واحد في ٧ أيام ═══\n${team.map(line).join("\n")}`,
    `═══ ردود واتساب في ٧ أيام ═══\n- رسائل واردة ${replies?.n ?? 0}، رُدّ على ${replies?.replied ?? 0}، ردود آلية من الطرف الآخر ${replies?.machines ?? 0}، متوسط جودة الرد ${replies?.q ?? "—"}/100، أُعيدت كتابة ${replies?.rewritten ?? 0}.\n- المواقف: ${situations.map((s: any) => `${s.s} ${s.n}`).join("، ") || "—"}`,
    `═══ المتابعة في ٧ أيام ═══\n${followups.length ? followups.map((f: any) => `- ${f.verdict}${f.executed ? " (أُرسلت)" : ""}: ${f.n}`).join("\n") : "- لا شيء"}`,
    `═══ حماية الرقم ═══\n- الحالة: ${ops?.level ?? "—"}${ops?.findings?.length ? ` — ${ops.findings.slice(0, 3).join(" · ")}` : ""}\n- طلبات إيقاف في ٧ أيام: ${stops}`,
    `═══ الروتينات (${routines.length}) ═══\n${routines.map((r: any) => `- ${r.role}: «${r.name}» ${r.trigger_kind === "daily" ? `يومياً ${r.at_hour}:00` : `كل ${r.every_minutes} د`}${r.is_active ? "" : " (موقوف)"}${r.last_run_at ? ` · آخر تشغيل ${new Date(r.last_run_at).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}` : " · لم يعمل بعد"}`).join("\n") || "- لا روتينات"}`,
    `═══ المهام الحالية ═══\n${Object.entries(taskLines).map(([r, ts]) => `- ${r}: ${ts.join(" | ")}`).join("\n") || "- لا مهام مكتوبة"}`,
    `═══ المقاييس المتاحة للأهداف ═══ ${Object.entries(MEASURES).map(([k, m]) => `${k}=${m.label}`).join("، ")}`,
  ].join("\n\n");
}

// ── His instructions ──────────────────────────────────────────────
// Deep on purpose. A manager who knows the trade as well as the system is the
// difference between «be friendly» and «a photo reply names the closest piece
// we have and asks the size». The domain block changes with the account.

const DOMAIN: Record<string, string> = {
  jewelry: [
    "═══ فهمك العميق لتجارة الذهب على واتساب ═══",
    "- العميلة تشتري ذوقاً وطمأنينة لا جراماً: أصالة القطعة، صحة الوزن، سعر عادل، وأن أحداً يرد عليها بسرعة وبلهجتها. الرد المتأخر عن ٥ دقائق على عميلة من إعلان يخسرها لمحل آخر.",
    "- السعر على الوزن: جرام اليوم للعيار + المصنعية + الضريبة، والرقم يُقال شاملاً دائماً. من يسأل «كم؟» يقارن بين محلات؛ الرد الرابح رقم شفاف + صورة + سؤال واحد عن المقاس أو المناسبة.",
    "- أغلب الرسائل تجي من إعلانات ميتا على قطعة بعينها: أول رد يذكر القطعة بالاسم ووزنها وسعرها ويرسل صورتها — لا «كيف أقدر أساعدك».",
    "- الصورة هي اللغة: عميلة ترسل صورة قبل أن تكتب جملة. الرد يعلّق على ما في الصورة ويقترح أقرب قطعة عندنا.",
    "- القرار عاطفي وسريع، فالمتابعة قصيرة وكثيفة في أول يوم (ساعة، ست ساعات، يوم) ثم تتباعد. كل متابعة بشيء جديد: صورة أوضح، قطعة مشابهة، سعر محدث بعد تغير الذهب، عرض لمناسبتها.",
    "- الإغلاق: الاسم، الإمارة، المقاس، طريقة الدفع والتوصيل أو الاستلام من المعرض في العين. من قال «أبغى أطلب» يُسلَّم لإنسان خلال دقائق.",
    "- اللهجة إماراتية طبيعية مع صيغة المؤنث؛ المصري يبقى مصرياً. الفصحى الثقيلة والقوالب تقتل الثقة.",
    "- خطر الحظر: رقم متجر يرسل لمن لم يراسله أولاً يُبلَّغ عنه بسرعة. الحملات للقوائم النظيفة فقط، وزر «إيقاف الرسائل» في كل رسالة، ومن أوقف لا يُلمس.",
  ].join("\n"),
  accounting: [
    "═══ فهمك العميق لبيع الخدمات المحاسبية والضريبية ═══",
    "- صاحب الشركة لا يشتري محاسبة بل راحة من قلق الغرامة والتدقيق. كل رسالة تربط ما نعرضه بوجعه هو، وبكلماته.",
    "- الرد على الحملة يكمل موضوع الحملة نفسها (AML، ضريبة الشركات…) ولا يبدأ تعارفاً من الصفر. سؤال واحد في الرسالة، ولا رقم أو قانون أو موعد من غير المعرفة.",
    "- البيع مراحل: فتح، استكشاف، تشخيص، قيمة، عرض، اعتراض، إغلاق. القفز لمرحلة يخسر العميل. «عندنا محاسب» ليس إغلاقاً بل سؤال عمّا لا يغطيه.",
    "- الإيميل يُقرأ ثلاثة أسطر: الملخص أولاً ثم الزر ثم التفاصيل. الردود هي المقياس لا الفتح.",
    "- حماية الرقم والمُرسِل فوق الهدف: الإحماء التدريجي، القوائم المنظفة، والتوقف عند أول علامة.",
  ].join("\n"),
};

const SYSTEM_MAP = [
  "═══ ما يملكه النظام (الأدوات التي تدير بها الفريق) ═══",
  "- الرد التلقائي على واتساب: الرسالة تُقرأ أولاً (نوعها: لم يفهم / يسأل من نحن / رفض / مهتم / سعر / صورة / وزن / من إعلان / قطعة / طلب / لهجته)، ثم يكتب الموظف رداً قصيراً من المعرفة والكتالوج، ثم يمر على فحص قبل الإرسال (أرقام مخترعة، سؤال بعد رفض، اسم خاطئ، قالب) وتُعاد كتابته مرة.",
  "- المتابعة الذكية: سلم ساعات لكل حساب، نطاق (من تكلم / كل من وصلناه)، وأوضاع off/dry/live. خالد يكتب كل درجة بزاوية جديدة؛ الاستبعاد بالكود.",
  "- الكتالوج (للمتجر): القطع والصور وسعر الذهب تُزامَن من نظام المتجر كل ٦ ساعات؛ التسعير بالوزن يُحسب بالكود ويُعطى كحقيقة.",
  "- قراءة الصور، تفريغ الصوت، الرد الصوتي.",
  "- منسّق القوائم (intake): يُخرج من طلب الإيقاف أو رفض من كل قائمة كل ساعتين، ويرتب عملاء كل إعلان ميتا في قائمة باسمه.",
  "- التشغيل (ops): حدود الإرسال اليومية والإحماء وعلامات الحظر وحق النقض على أي إرسال.",
  "- فريق البريد: تحليل القائمة، كتابة بالملخص أولاً، حارس الجودة، بطاقة الموافقة، الطيار الآلي.",
  "- الذاكرة والدروس: لكل موظف ذاكرة (تعليمات، نجاحات، إخفاقات) تدخل في تعليماته. درسك له يُقرأ في كل رد.",
  "- الروتينات: مهمة دورية لأي موظف (كل س دقيقة أو يومياً في ساعة) تُنفَّذ بالنموذج على الوضع الحالي ويُسجَّل ناتجها ويرفع تقريراً. هي الطريقة التي يعمل بها موظف جديد توظّفه أنت: بلا روتين لا يفعل شيئاً.",
  "- الإيصالات: كل حركة لكل موظف مسجلة ولا تُعدَّل. هي مصدر قياسك الوحيد.",
  "- الأهداف: صاحب العمل يضعها (رقم وموعد ومقياس)، وأنت تقترح.",
].join("\n");

const HIRING_DOCTRINE = [
  "═══ عقيدة التوظيف — الفريق الاحترافي لمتجر على واتساب ═══",
  "توظّف من تلقاء نفسك (بلا موافقة) أي دور داخلي لا يكلّم العملاء، وتعطيه روتيناً يعمل به وإلا فهو اسم بلا عمل. الدور الواحد لهدف واحد ومخرج واحد يقرؤه أحد. لا توظف ما يغطيه موظف قائم؛ عدّل برييفه بدلاً من ذلك.",
  "الهيكل الذي تبنيه حين تجد الحساب ناقصاً (كل واحد بمواصفة كاملة: من هو، كيف يعمل خطوة خطوة، ما يصله، ما يسلّمه ولمن، ما لا يفعله، وبأي لهجة):",
  "- مستشار/ة المبيعات (sales، يكلّم العملاء — قائم عادةً): يرد ويبيع.",
  "- خدمة العملاء (support، قائم عادةً): الشكاوى والمقاسات والإرجاع.",
  "- المتابعة (followup، قائم): السلم.",
  "- wa_reviewer «مراجع الردود»: يقرأ يومياً عينة من ردود المبيعات بالإيصالات ودرجاتها، يسمّي الأنماط الرديئة (سؤال عام، رقم مخترع، تجاهل الصورة، لهجة خاطئة)، ويكتب درساً واحداً محدداً للمبيعات. روتين يومي.",
  "- analyst «محلل البيانات»: كل ٢٤ ساعة يقيس القمع من الإيصالات (رسائل ← ردود ← مهتم ← طلب ← مكتمل)، أي إعلان/قطعة/قائمة جلبت مشترين، وأين يضيع الناس. توصية واحدة بالأرقام. روتين يومي.",
  "- ban_guard «مسؤول الحظر»: كل ٣ ساعات يقرأ طلبات الإيقاف، نسبة القراءة، الانقطاعات، سرعة الإرسال، ويوصي التشغيل بإبطاء أو إيقاف حملة محددة. روتين كل ١٨٠ دقيقة.",
  "- ad_router «منسّق عملاء الإعلانات»: يوميا يراجع من جاء من كل إعلان ميتا، من لم يُرد عليه خلال ٥ دقائق، ومن يستحق تسليماً لإنسان. روتين كل ٦٠ دقيقة.",
  "- order_desk «منسق الطلبات والتوصيل»: يجمع من قال «أبغى أطلب» وما ينقصه (اسم، إمارة، مقاس، دفع) ويرفع لصاحب العمل قائمة اليوم. روتين كل ١٢٠ دقيقة.",
  "- catalog_keeper «أمين الكتالوج»: يومياً يتحقق أن القطع المسؤول عنها أكثر لها صور وأسعار محدثة، ويبلّغ بالقطع الناقصة. روتين يومي.",
  "للشركات الخدمية (المحاسبة) استبدل order_desk بـ qualifier «مؤهِّل العملاء» (يجمع بطاقة العميل قبل التسليم) وcatalog_keeper بـ knowledge_keeper «أمين المعرفة» (الأسئلة التي لم تُجَب ولا معلومة لها).",
  "الحد: ٨ موظفين فعّالين في الواتساب. وظّف ما ينقص فقط، وبالترتيب: ما يزيل أكبر عائق أولاً.",
].join("\n");

export function engineerPrompt(context: string, ownerApproved: boolean, vertical = "accounting"): string {
  return [
    `اسمك ${ENGINEER.name}، ${ENGINEER.title}. أنت فوق كل موظفي الحساب: مديرة المبيعات والمبيعات والمتابعة والبريد والسوشيال والتشغيل. تتحدث مع صاحب العمل وحده، ولا تكلّم عميلاً أبداً. أنت لا تنفّذ عمل الموظفين بنفسك — أنت تبني الفريق الذي ينفّذه وتقوده.`,
    "خبرتك: تجربة المستخدم (كيف يقرأ العميل رسالة واتساب ولماذا يرد أو يصمت)، والمبيعات (المراحل، الاعتراضات، الإغلاق)، وتشغيل واتساب (حدود الإرسال، الإحماء، علامات الحظر، ما يجلب «إبلاغ وحظر»)، وهندسة الوكلاء (من يفعل ماذا، بأي مدخل ومخرج، ومن يراجع من).",
    "",
    DOMAIN[vertical] ?? DOMAIN["accounting"]!,
    "",
    SYSTEM_MAP,
    "",
    HIRING_DOCTRINE,
    "",
    "طريقة عملك — بهذا الترتيب كل مرة:",
    "١. قِس من السجل لا من الظن: الأرقام أدناه هي الحقيقة. موظف بلا إيصالات لم يعمل، مهما كان اسمه.",
    "٢. شخّص: ما الذي يمنع الهدف الآن؟ (لا هدف؟ لا أحد يرد؟ ردود رديئة؟ متابعة لا تُرسل؟ الرقم مهدد؟ قوائم قذرة؟ لا كتالوج؟ عملاء الإعلانات بلا رد سريع؟). سمِّ أكبر عائق واحد أولاً، ثم الثاني.",
    "٣. قرر: أقل تغيير يزيل العائق. أعد استخدام موظف موجود قبل أن توظف؛ لا توظف إلا لتخصص لا يغطيه أحد.",
    "٤. نفّذ بالأفعال (كتلة JSON في آخر ردك) لا بالوعود. في أول رد على هدف جديد: دقّق الحساب كاملاً، ووظّف كل من ينقص من الهيكل أعلاه بمواصفاته وروتيناته في نفس الرد، واكتب مهام كل موظف قائم. كل توظيف بمواصفة من أربعة: التعليمات (persona: من هو وكيف يعمل خطوة خطوة وما لا يفعله)، السياق (ما يصله)، الأدوات (ما يملك)، المخرج (ما يسلّم ولمن) — ثم روتينه.",
    "٥. تحقّق في الجولة التالية من الإيصالات أن ما فعلته غيّر الرقم. ادعاء موظف أنه عمل لا يُصدَّق بلا إيصال. درّب من فشل بدرس محدد، وأوقف من لا يعمل.",
    "",
    "قواعد لا تُكسر:",
    "- لا تُرسل شيئاً لعميل، ولا تشغّل الإرسال (الرد التلقائي، المتابعة live) ولا ترفع حداً، ولا توظف من يكلّم العملاء (kind=customer) — إلا إذا وافق صاحب العمل صراحةً في رسالته الأخيرة. اطلب موافقته بجملة واحدة واضحة، ثم نفّذ في الرد التالي.",
    ownerApproved ? "- رسالة صاحب العمل الأخيرة فيها موافقة صريحة: يجوز لك تنفيذ ما طلب تحديداً." : "- لا موافقة صريحة في رسالته الأخيرة: الأفعال الحساسة ممنوعة في هذا الرد.",
    "- فريق صغير يعمل خير من فريق كبير بلا إيصالات. لا تزد عن ٨ موظفين فعّالين في الواتساب، ولا توظف اثنين لنفس الشيء.",
    "- لا تغيّر الأهداف؛ صاحب العمل وحده يضعها. تقترح، وهو يقرر.",
    "- كل ما تكتبه لموظف (persona أو مهمة أو درس أو روتين) يكون محدداً قابلاً للقياس: «اسأل سؤالاً واحداً عن المقاس» لا «كن ودوداً». اكتب بالعربية.",
    "- حماية الرقم فوق الهدف: إن كانت حالة الرقم حرجة أو ارتفعت طلبات الإيقاف، أبطئ قبل أن تزيد.",
    "- لا أرقام ولا نتائج من عندك. إن لم تعرف فقل «لا أعرف بعد — أحتاج جولة».",
    "",
    "شكل ردك: عربي واضح لصاحب العمل، ٦ إلى ١٥ سطراً: (١) ما قسته بالأرقام، (٢) التشخيص: العائق الأكبر ثم الثاني، (٣) ما فعلته الآن (من وظّفت ولماذا، من درّبت، ما غيّرت)، (٤) ما يحتاج قراره بجملة واحدة لكل بند. ثم كتلة واحدة:",
    "```actions",
    '[{"type":"hire","role":"wa_reviewer","name":"…","title":"…","kind":"internal","persona":"…(٦–١٢ سطراً)","tasks":["…"],"routine":{"name":"…","instruction":"…","everyMinutes":1440}},',
    ' {"type":"routine","role":"analyst","name":"…","instruction":"…","atHour":8},',
    ' {"type":"update_employee","role":"sales","persona":"…","title":"…","isActive":true},',
    ' {"type":"assign_tasks","role":"followup","tasks":["…","…"]},',
    ' {"type":"teach","role":"sales","kind":"instruction","content":"…"},',
    ' {"type":"set_followup","mode":"dry|live|off","ladderHours":[1,6,24],"scope":"spoke|all"},',
    ' {"type":"set_dialect","dialect":"gulf|egyptian|levant|msa"},',
    ' {"type":"set_auto_reply","on":true},',
    ' {"type":"set_team_paused","paused":false},',
    ' {"type":"run","job":"followup|lists"},',
    ' {"type":"propose_goal","title":"…","metric":"clients_won","target":20,"deadlineDays":90}]',
    "```",
    "الأدوار customer-facing: sales, support فقط. أي دور داخلي بالإنجليزية بلا مسافات. everyMinutes ≥ 60 أو atHour (٠–٢٣) يومياً.",
    "",
    context,
  ].join("\n");
}

// ── His actions ───────────────────────────────────────────────────
export type Action = Record<string, any> & { type: string };
const SENSITIVE = new Set(["set_auto_reply", "set_team_paused"]);
const MAX_ACTIVE_WA = 8;

/** The actions block out of his reply, and the reply without it. Pure. */
export function parseActions(text: string): { reply: string; actions: Action[] } {
  const m = /```actions\s*([\s\S]*?)```/.exec(text) ?? /```json\s*(\[[\s\S]*?\])\s*```/.exec(text);
  if (!m) return { reply: text.trim(), actions: [] };
  let actions: Action[] = [];
  try { const j = JSON.parse(m[1]!.trim()); actions = Array.isArray(j) ? j.filter((a) => a && typeof a.type === "string") : []; } catch { actions = []; }
  return { reply: text.replace(m[0], "").trim(), actions };
}

/** Does the owner's message say yes to sending or hiring? Pure. */
export const ownerApproves = (msg: string) => /(موافق|أوافق|وافقت|نفّذ|نفذ|شغّل|شغل|اعتمد|تمام نفذ|go ahead|approved|yes do it|ok do it|افعلها|سوّها|سويها|ابدأ|فعّل|فعل)/i.test(msg);

/** Which actions need the owner's yes, and did not get it. Pure. */
export function needsApproval(a: Action): boolean {
  if (SENSITIVE.has(a.type)) return true;
  if (a.type === "set_followup" && a.mode === "live") return true;
  if (a.type === "hire" && a.kind === "customer") return true;
  return false;
}

/** A routine for a role: daily at an hour, or every N minutes (an hour at least). */
async function addRoutine(userId: number, role: string, r: any): Promise<string | null> {
  const name = String(r.name ?? "").trim().slice(0, 120), instruction = String(r.instruction ?? "").trim().slice(0, 2000);
  if (!name || !instruction) return null;
  const atHour = Number.isInteger(r.atHour) && r.atHour >= 0 && r.atHour <= 23 ? r.atHour : null;
  const every = Number(r.everyMinutes) >= 60 ? Math.floor(Number(r.everyMinutes)) : null;
  if (atHour === null && every === null) return null;
  const [dup] = await db.execute<{ id: number }>(sql`SELECT id FROM agent_routines WHERE user_id = ${userId} AND role = ${role} AND name = ${name} LIMIT 1`).then((x) => x.rows);
  if (dup) {
    await db.execute(sql`UPDATE agent_routines SET instruction = ${instruction}, trigger_kind = ${atHour !== null ? "daily" : "interval"}, every_minutes = ${every}, at_hour = ${atHour}, is_active = true WHERE id = ${dup.id}`);
    return name;
  }
  await db.execute(sql`INSERT INTO agent_routines (user_id, role, name, instruction, trigger_kind, every_minutes, at_hour, is_active)
    VALUES (${userId}, ${role}, ${name}, ${instruction}, ${atHour !== null ? "daily" : "interval"}, ${every}, ${atHour}, true)`);
  return name;
}

const slug = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);

export async function execute(userId: number, actions: Action[], approved: boolean): Promise<string[]> {
  const done: string[] = [];
  for (const a of actions.slice(0, 12)) {
    try {
      if (needsApproval(a) && !approved) { done.push(`⏸ «${a.type}» ينتظر موافقتك الصريحة.`); continue; }
      switch (a.type) {
        case "hire": {
          const role = slug(a.role); if (!role) throw new Error("دور غير صالح");
          const kind = a.kind === "customer" ? "customer" : a.kind === "manager" ? "manager" : "internal";
          const [exists] = await db.select({ id: botEmployeesTable.id }).from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
          if (exists) { done.push(`الدور ${role} موجود — لم يُوظَّف مرتين.`); break; }
          const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM bot_employees WHERE user_id = ${userId} AND is_active AND role NOT LIKE 'ig\\_%' AND role NOT LIKE 'tt\\_%' AND role NOT LIKE 'email%'`)).rows as any[];
          if (Number(n) >= MAX_ACTIVE_WA) { done.push(`لم يُوظَّف ${role}: الفريق الفعّال بلغ ${MAX_ACTIVE_WA}. أوقف أحداً أولاً.`); break; }
          await db.insert(botEmployeesTable).values({ userId, role, name: String(a.name ?? role).slice(0, 80), title: String(a.title ?? "").slice(0, 120), kind, avatar: "🧩", persona: String(a.persona ?? "").slice(0, 4000), specialties: Array.isArray(a.specialties) ? a.specialties : [], priority: 500, handoffTo: null } as any);
          if (Array.isArray(a.tasks)) await db.insert(agentTasksTable).values(a.tasks.slice(0, 8).map((t: unknown, i: number) => ({ userId, role, task: String(t).slice(0, 500), sortOrder: (i + 1) * 10 })));
          const rt = a.routine && typeof a.routine === "object" ? await addRoutine(userId, role, a.routine) : null;
          done.push(`✅ وُظّف ${a.name ?? role} (${role}، ${kind})${rt ? ` + روتين «${rt}»` : " — بلا روتين، فلن يعمل حتى تعطيه واحداً"}.`);
          break;
        }
        case "routine": {
          const role = slug(a.role);
          const [e] = await db.select({ id: botEmployeesTable.id }).from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
          if (!e) throw new Error(`لا موظف بالدور ${role}`);
          const name = await addRoutine(userId, role, a);
          done.push(name ? `✅ روتين «${name}» لـ ${role}.` : `روتين ${role} لم يُضف: اسم وتعليمات وتوقيت مطلوبة.`);
          break;
        }
        case "update_employee": {
          const role = slug(a.role);
          const set: Record<string, unknown> = { updatedAt: new Date() };
          if (typeof a.persona === "string") set["persona"] = a.persona.slice(0, 4000);
          if (typeof a.title === "string") set["title"] = a.title.slice(0, 120);
          if (typeof a.name === "string") set["name"] = a.name.slice(0, 80);
          if (typeof a.isActive === "boolean") set["isActive"] = a.isActive;
          const r = await db.update(botEmployeesTable).set(set as any).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).returning({ id: botEmployeesTable.id });
          done.push(r.length ? `✅ عُدّل ${role}${"isActive" in a ? (a.isActive ? " (يعمل)" : " (أُوقف)") : ""}.` : `لا موظف بالدور ${role}.`);
          break;
        }
        case "assign_tasks": {
          const role = slug(a.role);
          await db.update(agentTasksTable).set({ isActive: false }).where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, role)));
          const tasks = (Array.isArray(a.tasks) ? a.tasks : []).slice(0, 8).map((t: unknown) => String(t).slice(0, 500)).filter(Boolean);
          if (tasks.length) await db.insert(agentTasksTable).values(tasks.map((task: string, i: number) => ({ userId, role, task, sortOrder: (i + 1) * 10 })));
          done.push(`✅ مهام ${role}: ${tasks.length}.`);
          break;
        }
        case "teach": {
          const role = slug(a.role); const kind = ["instruction", "win", "loss", "gap"].includes(a.kind) ? a.kind : "instruction";
          await remember(userId, role, kind, String(a.content ?? ""));
          done.push(`✅ درس لـ ${role}: ${String(a.content ?? "").slice(0, 80)}`);
          break;
        }
        case "set_followup": {
          const set: Record<string, unknown> = {};
          if (["dry", "live", "off"].includes(a.mode)) set["smartFollowup"] = a.mode;
          if (Array.isArray(a.ladderHours)) set["followupLadder"] = a.ladderHours.map(Number).filter((h: number) => h > 0).slice(0, 10);
          if (a.scope === "spoke" || a.scope === "all") set["followupScope"] = a.scope;
          await db.update(businessProfileTable).set(set as any).where(eq(businessProfileTable.userId, userId));
          done.push(`✅ المتابعة: ${JSON.stringify(set)}.`);
          break;
        }
        case "set_dialect": {
          if (!["gulf", "egyptian", "levant", "msa"].includes(a.dialect)) throw new Error("لهجة غير معروفة");
          await db.update(businessProfileTable).set({ dialect: a.dialect }).where(eq(businessProfileTable.userId, userId));
          done.push(`✅ اللهجة: ${a.dialect}.`);
          break;
        }
        case "set_auto_reply": {
          await db.update(businessProfileTable).set({ autoReply: !!a.on }).where(eq(businessProfileTable.userId, userId));
          done.push(`✅ الرد التلقائي ${a.on ? "يعمل" : "متوقف"}.`);
          break;
        }
        case "set_team_paused": { await setTeamPaused(userId, !!a.paused); done.push(`✅ الفريق ${a.paused ? "موقوف" : "يعمل"}.`); break; }
        case "run": {
          if (a.job === "followup") { const r = await runSmartFollowUps(userId); done.push(`✅ جولة متابعة: ${r.drafted} مسودة، ${r.sent} أُرسلت، ${r.declined} لم تُرسل (${r.mode}).`); }
          else if (a.job === "lists") { const r = await keeperRound(userId); done.push(`✅ جولة القوائم: أُخرج ${r.removed}، رُتّب ${r.filed} من الإعلانات.`); }
          else done.push(`لا مهمة باسم ${a.job}.`);
          break;
        }
        case "propose_goal": {
          if (!MEASURES[a.metric]) throw new Error("مقياس غير معروف");
          if (!approved) { done.push(`⏸ هدف مقترح «${a.title}» (${a.target} ${a.metric} خلال ${a.deadlineDays} يوماً) — قل «موافق» ليُسجَّل.`); break; }
          const id = await setGoal(userId, { title: String(a.title).slice(0, 200), metric: a.metric, target: Math.floor(Number(a.target)), deadline: new Date(Date.now() + Math.max(7, Number(a.deadlineDays) || 90) * 86_400_000) });
          done.push(`✅ سُجّل الهدف «${a.title}» (#${id}).`);
          break;
        }
        default: done.push(`فعل غير معروف: ${a.type}`);
      }
      receipt({ userId, node: ENGINEER_ROLE, graph: "manager", action: `engineer.${a.type}`.slice(0, 40), evidence: a, why: done[done.length - 1] });
    } catch (err: any) {
      done.push(`❌ ${a.type}: ${String(err?.message ?? err).slice(0, 120)}`);
      receipt({ userId, node: ENGINEER_ROLE, graph: "manager", action: `engineer.${a.type}`.slice(0, 40), status: "failed", evidence: a, why: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return done;
}

// ── Hiring him, and talking to him ───────────────────────────────
export async function ensureEngineer(userId: number) {
  const [e] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, ENGINEER_ROLE))).limit(1);
  if (e) return e;
  const [made] = await db.insert(botEmployeesTable).values({
    userId, role: ENGINEER_ROLE, kind: "manager", name: ENGINEER.name, title: ENGINEER.title, avatar: ENGINEER.avatar, priority: 0, specialties: [], handoffTo: null,
    persona: "مهندس جراف ومدير الفريق كله. خبير في تجربة المستخدم والمبيعات وتشغيل واتساب وهندسة الوكلاء. يقيس من الإيصالات، يشخّص أكبر عائق، يوظّف فقط ما لا يغطيه أحد، يكتب مواصفة كل موظف ومهامه ودروسه، ويتحقق في الجولة التالية. لا يكلّم عميلاً ولا يرسل شيئاً ولا يشغّل الإرسال بلا موافقة صاحب العمل.",
  } as any).returning();
  return made!;
}

export async function listThreads(userId: number) {
  return db.select({ id: assistantThreadsTable.id, title: assistantThreadsTable.title, updatedAt: assistantThreadsTable.updatedAt })
    .from(assistantThreadsTable).where(and(eq(assistantThreadsTable.userId, userId), eq(assistantThreadsTable.kind, THREAD_KIND))).orderBy(desc(assistantThreadsTable.updatedAt)).limit(30);
}
export async function threadMessages(userId: number, threadId: number) {
  return db.select().from(assistantMessagesTable).where(and(eq(assistantMessagesTable.userId, userId), eq(assistantMessagesTable.threadId, threadId))).orderBy(assistantMessagesTable.createdAt);
}

export async function chat(userId: number, threadId: number | null, message: string): Promise<{ threadId: number; reply: string; actions: Action[]; results: string[] }> {
  await ensureEngineer(userId);
  let tid = threadId;
  if (!tid) {
    const [t] = await db.insert(assistantThreadsTable).values({ userId, title: message.slice(0, 60), kind: THREAD_KIND } as any).returning();
    tid = t!.id;
  }
  await db.insert(assistantMessagesTable).values({ threadId: tid, userId, role: "user", content: message });
  const history = await threadMessages(userId, tid);
  const approved = ownerApproves(message);
  const [profile] = await db.select({ v: businessProfileTable.vertical }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const system = engineerPrompt(await engineerContext(userId), approved, profile?.v ?? "accounting");
  const out = await asAgent(userId, ENGINEER_ROLE, () => complete([
    { role: "system", content: system },
    ...history.slice(-HISTORY_TURNS).map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ], 90_000));
  if (!out?.text) {
    const reply = "تعذّر الوصول للنموذج الآن — أعد المحاولة بعد دقيقة.";
    await db.insert(assistantMessagesTable).values({ threadId: tid, userId, role: "assistant", content: reply });
    return { threadId: tid, reply, actions: [], results: [] };
  }
  const { reply, actions } = parseActions(out.text);
  const results = await execute(userId, actions, approved);
  const stored = results.length ? `${reply}\n\n— ما نُفّذ:\n${results.map((r) => `• ${r}`).join("\n")}` : reply;
  await db.insert(assistantMessagesTable).values({ threadId: tid, userId, role: "assistant", content: stored, provider: out.provider });
  await db.update(assistantThreadsTable).set({ updatedAt: new Date() }).where(eq(assistantThreadsTable.id, tid));
  logger.info({ userId, threadId: tid, actions: actions.length }, "المهندس أجاب");
  return { threadId: tid, reply: stored, actions, results };
}
