// ── خريطة الأدوار والأقسام ────────────────────────────────────────
// مصدرٌ واحد لسؤالٍ واحد: من هذا الموظف، وأي قسم يوقفه؟ يقرؤه decideHalt (ومنه complete
// وgateSend وrunAs كلها) وسجل الموظفين. بلا قاعدة بيانات وبلا import من controls، فلا دورة.

export const DEPARTMENTS = ["executive", "email", "target_accounts", "whatsapp", "instagram", "tiktok", "linkedin", "shared"] as const;
export type Department = (typeof DEPARTMENTS)[number];
export type ExecutionKind = "own" | "part_of" | "on_demand" | "none";

export interface StaticEntry {
  key: string; department: Department;
  prompt: string; scheduler: string | null; fn: string | null;
  execution: ExecutionKind;
  /** own: كل كم ثانية يُفترض أن ينبض. فارغ: لا موعد له (يعمل عند وصول حدث). */
  intervalSec: number | null;
  /** part_of: الموظف الذي يحمل عمله نبضُه. */
  carriedBy?: string;
  dependsOn?: string[];
}

const M = 60, H = 3600, D = 86400;
const e = (key: string, department: Department, prompt: string, scheduler: string | null, fn: string | null, execution: ExecutionKind, intervalSec: number | null, extra: Partial<StaticEntry> = {}): StaticEntry =>
  ({ key, department, prompt, scheduler, fn, execution, intervalSec, ...extra });

const EMAIL_PROMPT = "lib/email/team.ts EMAIL_TEAM_DEFS + teamVoice";
const SPEC = "lib/email/specialists.ts startSpecialistRounds (كل يوم)";
const DESK_PROMPT = "lib/accounts/team.ts ACCOUNTS_TEAM_DEFS + accountsVoice";
const DESK_SCHED = "lib/accounts/desk.ts startAccountsDesk (08:30 دبي، أيام العمل)";
const CORE_PROMPT = "lib/db schema/employees.ts DEFAULT_EMPLOYEES";

export const ROLE_MAP: Record<string, StaticEntry> = {
  // ── التنفيذي ──
  chief: e("executive.chief", "executive", CORE_PROMPT, "lib/wa-manager.ts startWaManagerLoop (٦ ساعات)", "wa-manager.runWaManagerCycle", "own", 6 * H, { dependsOn: ["whatsapp.campaigns", "whatsapp.followup"] }),
  engineer: e("executive.engineer", "executive", "lib/graph/engineer.ts", "lib/graph/engineer.ts startEngineerRounds (08:00 الخليج)", "graph/engineer.dailyRound", "own", D),
  ceo_agent: e("executive.ceo", "executive", "lib/org/ceo.ts CEO_PERSONA", "lib/org/ceo.ts startCeoAgent (07:30 دبي)", "org/ceo.runCeoDaily", "own", D),
  // ── البريد ──
  email_manager: e("email.director", "email", EMAIL_PROMPT, "lib/email/manager.ts startManagerLoop (٦ ساعات)", "email/manager.runManagerCycle", "own", 6 * H, { dependsOn: ["email.analyst"] }),
  email: e("email.copywriter", "email", EMAIL_PROMPT, "lib/email/missions.ts startMissionWorker (١٠ دقائق)", "email/missions.runMissions → writeCampaign", "own", 10 * M, { dependsOn: ["email.strategist", "email.director", "email.opens"] }),
  email_strategist: e("email.strategist", "email", EMAIL_PROMPT, "lib/email/autopilot.ts startAutopilotWorker (١٥ دقيقة)", "email/autopilot.runAutopilot", "own", 15 * M, { dependsOn: ["email.director", "email.analyst"] }),
  email_followup: e("email.followup", "email", EMAIL_PROMPT, "داخل جولة الطيار", "email/autopilot.refreshStageLists + موجات المتابعة", "part_of", 15 * M, { carriedBy: "email.strategist" }),
  email_replies: e("email.replies", "email", EMAIL_PROMPT, "lib/email/inbound.ts startInboundPolling (دقيقتان)", "email/inbound.pollAllMailboxes + sendDueAutoReplies", "own", 2 * M),
  email_guard: e("email.guard", "email", EMAIL_PROMPT, "lib/email/caretaker.ts startCaretaker (٦ ساعات)", "email/caretaker.caretakerRound", "own", 6 * H),
  email_creator: e("email.creator", "email", EMAIL_PROMPT, null, "email/creator.createWithCreator (بطلب صاحب العمل)", "on_demand", null),
  email_registrar: e("email.registrar", "email", EMAIL_PROMPT, SPEC, "email/specialists.runSpecialist", "own", D),
  email_data: e("email.data", "email", EMAIL_PROMPT, SPEC, "email/specialists.runSpecialist", "own", D),
  email_retarget: e("email.retarget", "email", EMAIL_PROMPT, SPEC, "email/specialists.runSpecialist", "own", D, { dependsOn: ["email.data"] }),
  email_opens: e("email.opens", "email", EMAIL_PROMPT, SPEC, "email/specialists.runSpecialist", "own", D),
  email_analyst: e("email.analyst", "email", EMAIL_PROMPT, SPEC, "email/specialists.runSpecialist", "own", D, { dependsOn: ["email.replies"] }),
  // ── مكتب الحسابات ── أيام العمل فقط، فيومان يكفيان نهاية الأسبوع (٢× = أربعة أيام).
  accounts_researcher: e("target_accounts.researcher", "target_accounts", DESK_PROMPT, DESK_SCHED, "accounts/desk.runDesk + pipeline.research", "own", 2 * D),
  accounts_analyst: e("target_accounts.analyst", "target_accounts", DESK_PROMPT, DESK_SCHED, "accounts/pipeline.findPeople", "own", 2 * D, { dependsOn: ["target_accounts.researcher"] }),
  accounts_email: e("target_accounts.email_finder", "target_accounts", DESK_PROMPT, DESK_SCHED, "accounts/pipeline.findEmail", "own", 2 * D, { dependsOn: ["target_accounts.analyst"] }),
  accounts_writer: e("target_accounts.writer", "target_accounts", DESK_PROMPT, DESK_SCHED, "accounts/pipeline.writeFor", "own", 2 * D, { dependsOn: ["target_accounts.email_finder"] }),
  // ── واتساب ──
  sales: e("whatsapp.sales", "whatsapp", CORE_PROMPT, "حدث: رسالة واردة", "follow-up-engine.handleInbound", "own", null),
  support: e("whatsapp.support", "whatsapp", CORE_PROMPT, "حدث: رسالة واردة", "follow-up-engine.handleInbound", "own", null),
  followup: e("whatsapp.followup", "whatsapp", CORE_PROMPT, "lib/smart-followup.ts startSmartFollowUps (٢٠ دقيقة)", "smart-followup.runSmartFollowUps", "own", 20 * M),
  wa_campaigns: e("whatsapp.campaigns", "whatsapp", "lib/wa-autopilot.ts", "lib/wa-autopilot.ts startWaAutopilot (٣٠ دقيقة)", "wa-autopilot.runCycle", "own", 30 * M),
  chat_lead: e("whatsapp.chat_lead", "whatsapp", "lib/chat-lead.ts", "lib/chat-lead.ts startChatLead (كل يوم)", "chat-lead.runChatLead", "own", D),
  intake: e("whatsapp.list_keeper", "whatsapp", CORE_PROMPT, "lib/list-keeper.ts startListKeeper (ساعتان)", "list-keeper.keeperRound", "own", 2 * H),
  vetter: e("whatsapp.vetter", "whatsapp", CORE_PROMPT, "lib/wa-vetting.ts startVetting (كل يوم، وعند الربط)", "wa-vetting.vetPending", "own", 2 * D),
  groups: e("whatsapp.groups", "whatsapp", "lib/groups/assistant.ts", "حدث: رسالة في قروب مراقَب", "groups/assistant.suggestFor", "own", null),
  // ── المشترك ──
  ops: e("ops.controller", "shared", CORE_PROMPT, "lib/ops-agent.ts startOpsAgent (١٠ دقائق)", "ops-agent.runOpsAgent", "own", 10 * M),
  monitor: e("ops.monitor", "shared", CORE_PROMPT, "lib/monitor-agent.ts startMonitorAgent (٢٠ دقيقة)", "monitor-agent.runMonitorFor", "own", 20 * M),
  collector: e("shared.collector", "shared", CORE_PROMPT, "lib/collector-agent.ts startCollector (08:00 الخليج)", "collector-agent.runCollector", "own", D),
  proposals: e("shared.proposals", "shared", "lib/deals/proposals.ts", null, "deals/proposals (بطلب من صفحة الصفقات، ومتابعات draftDueFollowups)", "on_demand", null),
};

/** عمّالٌ لا موظف لهم: ينبضون ويُراقَبون، ولا يظهرون موظفين. */
export const WORKER_MAP: Record<string, { key: string; department: Department; intervalSec: number; fn: string; serves: string }> = {
  email_queue: { key: "worker.email_queue", department: "email", intervalSec: 5 * M, fn: "email/service.drainQueues", serves: "email_guard" },
};

const SOCIAL: Array<{ prefix: string; department: Department; driven: boolean }> = [
  { prefix: "ig", department: "instagram", driven: true },
  { prefix: "tt", department: "tiktok", driven: true },
  { prefix: "li", department: "linkedin", driven: false },
];
const SOCIAL_SCHED = "lib/social/engine.ts startSocial (٢٠ دقيقة، لمن شغّل الطيار)";
const ANALYST_SCHED = "lib/social/analyst.ts startEngagementAnalyst (كل يوم، لكل حساب له صف في social_accounts)";
const SOCIAL_JOBS: Record<string, { fn: string | null; execution: ExecutionKind; carriedBy?: string; intervalSec?: number }> = {
  manager: { fn: "social/engine.runRound + sendApproved", execution: "own" },
  guard: { fn: "social/engine.guardCheck", execution: "own" },
  watcher: { fn: "social/engine.discoverPosts + collectComments", execution: "own" },
  triage: { fn: "social/engine.processComments", execution: "own" },
  dm: { fn: "social/engine.syncInbox", execution: "own" },
  prospector: { fn: "social/engine.prepareOutreach", execution: "own" },
  followup: { fn: "social/engine.prepareFollowups", execution: "own" },
  writer: { fn: "social/agent.draftCommentReply داخل processComments", execution: "part_of", carriedBy: "triage" },
  qualify: { fn: "social/agent.triage داخل draftReplies", execution: "part_of", carriedBy: "dm" },
  creator: { fn: "social/agent.draftPost (بطلب صاحب العمل)", execution: "on_demand" },
  // الناقل: خطوته في الجولة نفسها، بعد المصنِّفة (engine.inviteCommenters ينقل المعلّق المهتم إلى قائمة الخاص).
  inviter: { fn: "social/engine.inviteCommenters", execution: "own" },
  // المحلل: تحليل يومي بالكود من جداول التواصل، والنموذج يصوغ فقط (social/analyst.ts).
  analyst: { fn: "social/analyst.runEngagementAnalysis", execution: "own", intervalSec: D },
};
for (const s of SOCIAL) for (const [job, j] of Object.entries(SOCIAL_JOBS)) {
  const role = `${s.prefix}_${job}`;
  // لينكدإن بلا مشغّل: الفريق كله جاهزيةٌ على الورق، لا عامل يمرّ عليه.
  const execution: ExecutionKind = s.driven ? j.execution : "none";
  ROLE_MAP[role] = e(`${s.department}.${job}`, s.department, "lib/social/team.ts teamDefs + voiceFor", s.driven && j.execution !== "none" && j.execution !== "on_demand" ? (job === "analyst" ? ANALYST_SCHED : SOCIAL_SCHED) : null,
    s.driven ? j.fn : null, execution, execution === "own" || execution === "part_of" ? j.intervalSec ?? 20 * M : null,
    execution === "part_of" ? { carriedBy: `${s.department}.${j.carriedBy}` } : {});
}

/** المفتاح الثابت للدور. دورٌ وظّفه المهندس ولا يعرفه الجدول يأخذ custom.<role>. Pure. */
export function employeeKeyOf(role: string): string {
  return ROLE_MAP[role]?.key ?? WORKER_MAP[role]?.key ?? `custom.${role}`.slice(0, 60);
}
const OLD_TO_ORG: Record<string, Department> = { email: "email", accounts: "target_accounts", whatsapp: "whatsapp", operations: "shared" };
/** قسم الموظف في الهيكل. Pure. */
export function orgDepartmentOf(role: string): Department {
  return ROLE_MAP[role]?.department ?? WORKER_MAP[role]?.department ?? OLD_TO_ORG[departmentOf(role) ?? ""] ?? "shared";
}
export const intervalOf = (role: string): number | null => ROLE_MAP[role]?.intervalSec ?? WORKER_MAP[role]?.intervalSec ?? null;

// ── الأسماء القديمة ── مفاتيح P0 قد تكون مضبوطة بها (social، accounts، operations)، فتبقى تعمل.
const BY_ROLE: Array<[RegExp, string]> = [
  [/^email($|_)/, "email"],
  [/^accounts_/, "accounts"],
  [/^(ig|tt|li)_|^social_/, "social"],
  [/^(sales|support|followup|wa_|groups|intake|chat_lead|vetter)/, "whatsapp"],
];
/** قسم الموظف باسم مفاتيح P0. Pure. دورٌ لا يُعرف قسمه لا يُوقفه مفتاح قسم، ويوقفه مفتاحه هو. */
export function departmentOf(role: string | null | undefined): string | null {
  if (!role) return null;
  for (const [re, d] of BY_ROLE) if (re.test(role)) return d;
  return "operations";
}

/**
 * كل اسمٍ يصحّ أن يوقف هذا الموظف بمفتاح قسم: قسمه في الهيكل (instagram، target_accounts،
 * executive...)، واسم P0 (social، accounts...)، ومفتاحه ودوره أنفسهما. Pure.
 */
export function haltNames(role: string | null | undefined): string[] {
  if (!role) return [];
  return [...new Set([orgDepartmentOf(role), departmentOf(role), employeeKeyOf(role), role].filter((x): x is string => !!x))];
}
/** الاسمان اللذان يوقفان الموظف بمفتاح موظف. Pure. */
export const employeeNames = (role: string): string[] => [role, employeeKeyOf(role)];
