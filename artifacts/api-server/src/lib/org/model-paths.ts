// ── من يستدعي نموذجاً في عمله؟ خريطة ثابتة، يختبرها org-shadow.test.ts بقراءة الملفات ──────
// كل موظفٍ في المكتبة له سطرٌ هنا: model = في مسار تنفيذه نداء complete() (ولو لصياغة تقرير
// فوق قرارٍ محسوب)، والملفات التي فيها ذلك المسار نسبةً إلى src/lib. ما model: false فيه هو
// وحده «بلا مسار نموذج» (no_model_path)؛ ومن له مسار لا يمرّ به الظل حكمه «لم يُجرَّب»
// (not_covered) ولا يُفعَّل آلياً أبداً. الاختبار يقرأ الملفات: موظفٌ بالكود وحده لا يحوي ملفه
// ولا الدوال التي يستوردها منها complete()، وموظفٌ له نموذج فيه complete() فعلاً.

export interface ModelPath { model: boolean; files: string[]; where: string }

const m = (files: string[], where: string): ModelPath => ({ model: true, files, where });
const codeOnly = (files: string[], where: string): ModelPath => ({ model: false, files, where });

const SPEC = ["email/specialists.ts"];
const SPEC_WHY = "runSpecialist → specialistRun: النموذج يصوغ تقرير الأخصائي فوق وقائعه المحسوبة";

export const MODEL_PATHS: Record<string, ModelPath> = {
  "executive.ceo": m(["org/ceo.ts"], "runCeoDaily → writeNarrative: سرد التقرير اليومي"),
  "executive.chief": m(["wa-manager.ts"], "runWaManagerCycle: تقرير المديرة وتوجيهاتها"),
  "executive.engineer": m(["graph/engineer.ts"], "dailyRound: خطة المهندس"),
  "email.director": m(["email/manager.ts"], "runManagerCycle: موجز المدير اليومي"),
  "email.strategist": m(["email/pipeline.ts"], "pipeline.insights: توصيات المخطط"),
  "email.copywriter": m(["email/agent.ts"], "writeCampaign"),
  "email.followup": m(["email/agent.ts"], "writeCampaign بدور المتابعة"),
  "email.replies": m(["email/inbound.ts"], "draftReply"),
  "email.guard": codeOnly(["email/caretaker.ts", "email/hygiene.ts", "email/dns.ts", "email/diagnose.ts"], "caretakerRound: فحوص DNS والقوائم والطابور بالكود"),
  "email.creator": m(["email/creator.ts", "email/missions.ts", "email/agent.ts"], "createWithCreator → runMission → writeCampaign بدور المنشئ"),
  "email.registrar": m(SPEC, SPEC_WHY),
  "email.data": m(SPEC, SPEC_WHY),
  "email.retarget": m(SPEC, SPEC_WHY),
  "email.opens": m(SPEC, SPEC_WHY),
  "email.analyst": m(SPEC, SPEC_WHY),
  "target_accounts.researcher": m(["accounts/pipeline.ts"], "research"),
  "target_accounts.analyst": m(["accounts/pipeline.ts"], "findPeople"),
  "target_accounts.email_finder": m(["accounts/pipeline.ts"], "findEmail ضمن مسار المكتب"),
  "target_accounts.writer": m(["accounts/pipeline.ts"], "writeFor"),
  "whatsapp.sales": m(["arena.ts", "knowledge.ts", "intent.ts"], "handleInbound → classify وanswerFromKnowledge"),
  "whatsapp.support": m(["arena.ts", "knowledge.ts", "intent.ts"], "handleInbound → classify وanswerFromKnowledge"),
  "whatsapp.followup": m(["smart-followup.ts"], "compose"),
  "whatsapp.campaigns": m(["wa-autopilot.ts"], "runCycle: متغيرات الحملة"),
  "whatsapp.chat_lead": m(["chat-lead.ts"], "runChatLead: قراءة محادثات الأسبوع"),
  "whatsapp.list_keeper": codeOnly(["list-keeper.ts"], "keeperRound: نقل الأرقام بين القوائم بالكود"),
  "whatsapp.vetter": codeOnly(["wa-vetting.ts"], "vetPending: فحص onWhatsApp بالكود"),
  "whatsapp.groups": m(["groups/assistant.ts"], "suggestFor"),
  "ops.controller": m(["ops-agent.ts"], "runOpsAgent → narrate: نص التنبيه فوق قرارٍ محسوب"),
  "ops.monitor": codeOnly(["monitor-agent.ts"], "runMonitorFor: فحوص الجلسة والطابور والموارد بالكود"),
  "shared.collector": m(["graph/review.ts", "collector-agent.ts"], "reviewOne وتقرير الشرائح"),
  "shared.proposals": m(["deals/proposals.ts"], "مسودة العرض"),
};

// التواصل: إنستجرام وتيك توك بالوظائف نفسها.
const SOCIAL: Record<string, ModelPath> = {
  manager: m(["social/engine.ts", "social/agent.ts"], "runRound → processComments/syncInbox → social/agent"),
  watcher: codeOnly(["social/engine.ts:discoverPosts", "social/engine.ts:collectComments"], "discoverPosts + collectComments: قراءة بالمتصفح"),
  triage: m(["social/agent.ts"], "agent.triage"),
  writer: m(["social/agent.ts"], "agent.draftCommentReply"),
  inviter: codeOnly(["social/engine.ts:inviteCommenters"], "inviteCommenters: نقل المعلّق المهتم بالكود"),
  dm: m(["social/agent.ts"], "syncInbox → draftReplies"),
  prospector: m(["social/agent.ts"], "prepareOutreach → agent.draftFirstMessage"),
  qualify: m(["social/agent.ts"], "agent.triage داخل draftReplies"),
  followup: m(["social/agent.ts"], "prepareFollowups → agent.draftFollowup"),
  creator: m(["social/agent.ts"], "agent.draftPost"),
  guard: codeOnly(["social/engine.ts:guardCheck"], "guardCheck: حالة الدخول بالسائق"),
  analyst: m(["social/analyst.ts"], "runEngagementAnalysis: النموذج يصوغ التحليل"),
};
for (const p of ["instagram", "tiktok"]) for (const [job, v] of Object.entries(SOCIAL)) MODEL_PATHS[`${p}.${job}`] = v;

/** بالكود وحده فعلاً: لا نداء نموذج في مساره. مفتاحٌ لا تعرفه الخريطة يُعامَل كأن له نموذجاً. Pure. */
export const isCodeOnly = (key: string): boolean => MODEL_PATHS[key]?.model === false;
