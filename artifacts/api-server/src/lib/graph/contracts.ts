// ── The two graphs, as contracts ─────────────────────────────────
// The diagram is not the system; these are. Each node says what it is for,
// what it reads and writes, which tools it may use, what side effect it has,
// and who may authorise that effect. Each edge says when it fires, what it
// carries, and where the work goes when it fails. The tests hold the code to
// them: every node here exists, every one leaves receipts, every side effect
// that reaches a customer passes a gate that is code or a person — never the
// model's own judgement.
//
// Phase one keeps it small on purpose: five working nodes per graph at most,
// plus the code nodes (router, gate, sender) that are not employees.

export type SideEffect = "none" | "idempotent" | "compensatable" | "approval";
export type NodeKind = "agent" | "reviewer" | "code" | "human";

export type NodeContract = {
  id: string;                 // the role in bot_employees, or a code node's name
  kind: NodeKind;
  responsibility: string;
  reads: string[];
  writes: string[];
  tools: string[];
  sideEffect: SideEffect;
  /** Who authorises the side effect — never "model". */
  authorisedBy: "code" | "owner" | "none";
  /** A reviewer never reviews its own output. */
  reviews?: string[];
};

export type EdgeContract = {
  from: string; to: string;
  when: string;               // the activation condition, in words
  carries: string;            // the payload
  onFail: string;             // retry, fallback or hold
  timeout?: string;
};

export type GraphContract = {
  id: string; goal: string; oneBreath: string; nodes: NodeContract[]; edges: EdgeContract[];
  /** How many working nodes this graph may hold — five in phase one, more once its loop is measured. */
  maxWorking?: number;
  /** The loop that closes the graph: results back into the next decision. */
  loop?: string;
};

export const WHATSAPP_GRAPH: GraphContract = {
  id: "whatsapp",
  goal: "clients_won",
  maxWorking: 8,
  oneBreath: "صاحب العمل يرفع القائمة ← سالم ينظّفها ← ريم تصنّف كل جهةٍ في قطاعها ← الحملة تخرج لقطاعها ← رسالة العميل تُفرز آلياً ← هال يكتب ← المراجعة تحكم ← فهد يسمح ← تُرسل؛ ومن سكت يكتب له خالد؛ وشمّة تقيّم الجميع وتعطي كلاً مهمته.",
  loop: "كل ست ساعات: البيانات (سالم ← ريم) ← النتائج بالرقم لا بالرسالة ← تقييم كل موظف من أرقامه ← مهمةٌ لكلٍّ من شمّة ← مراجعة: هل تحرّك الرقم بعد المهمة السابقة. ما لا يُقاس لا يدخل التقييم.",
  nodes: [
    { id: "owner", kind: "human", responsibility: "يرفع القوائم، يُطلق الحملات، ويشغّل المتابعة الحيّة", reads: ["brief", "evaluations", "desk_report"], writes: ["lists", "campaign", "followup_mode"], tools: [], sideEffect: "approval", authorisedBy: "owner" },
    { id: "chief", kind: "agent", responsibility: "تُدير المكتب: تقيّم كل موظف من أرقامه، تعطي كلاً مهمةً واحدة، تراجع هل تحرّكت درجته، وتكتب التقرير اليومي", reads: ["receipts", "results", "desk_report", "evaluations"], writes: ["evaluations", "directives", "brief"], tools: ["evaluateDesk", "waResults", "runDeskAll"], sideEffect: "none", authorisedBy: "none", reviews: ["sales", "followup", "intake", "collector"] },
    { id: "intake", kind: "agent", responsibility: "ينظّف كل قائمة عند رفعها: المكرّر، من طلب الإيقاف، الأسماء الوهمية — ويقول ما أُصلح وما أُخرج ولماذا", reads: ["lists", "unsubscribed"], writes: ["list_membership", "clearance"], tools: ["cleanWa", "dedupe"], sideEffect: "none", authorisedBy: "none" },
    { id: "collector", kind: "agent", responsibility: "تصنّف كل جهةٍ في قطاعها وتقول بماذا عُرف (اسمها، قراءتها، أو اسم الملف)، وتفرز الملف المخلوط إلى قوائم قطاعاته", reads: ["lists", "clearance", "targets"], writes: ["sector", "sector_by", "desk_report"], tools: ["classifyRow", "modelPrompt", "fileStrangers"], sideEffect: "none", authorisedBy: "none" },
    { id: "router", kind: "code", responsibility: "يفرز الرسالة: نية، رد آلي، إيقاف، بشري يتولاها", reads: ["incoming", "thread", "lead_card"], writes: ["lead_card.intent"], tools: [], sideEffect: "none", authorisedBy: "none" },
    { id: "sales", kind: "agent", responsibility: "يكتب رداً واحداً يكمل موضوع الحملة ويقدّم البيع مرحلة", reads: ["thread", "outreach", "lead_card", "knowledge"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "followup", kind: "agent", responsibility: "يكتب متابعة واحدة بزاوية جديدة لمن تكلم ثم سكت، أو يرفض", reads: ["thread", "outreach", "lead_card", "knowledge", "earlier_followups"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "reviewer", kind: "reviewer", responsibility: "يحكم على المسودة بمعايير ثابتة: يمر، أو يُعاد مرة، أو يُحجز", reads: ["draft", "thread", "lead_card", "knowledge"], writes: ["verdict"], tools: ["reply-check"], sideEffect: "none", authorisedBy: "none", reviews: ["sales", "followup"] },
    { id: "gate", kind: "code", responsibility: "يسمح بالإرسال أو يمنعه: الحدود اليومية، علامات الحظر، ساعات الإرسال، الإيقاف والحظر ٥ أشهر", reads: ["ops_signals", "unsubscribed", "daily_count"], writes: ["send_permit"], tools: [], sideEffect: "none", authorisedBy: "code" },
    { id: "sender", kind: "code", responsibility: "يرسل ما سُمح به مرة واحدة فقط", reads: ["send_permit", "draft"], writes: ["thread"], tools: ["whatsapp.send"], sideEffect: "idempotent", authorisedBy: "code" },
  ],
  edges: [
    { from: "owner", to: "intake", when: "رُفع ملف أرقام", carries: "القائمة الخام وما قاله المستورد عنها", onFail: "تبقى القائمة كما رُفعت وتُنظَّف في دورة المديرة" },
    { from: "intake", to: "collector", when: "انتهى التنظيف", carries: "القائمة النظيفة وما أُصلح وأُخرج", onFail: "تُصنَّف في الدورة القادمة" },
    { from: "collector", to: "chief", when: "انتهى التصنيف", carries: "تقرير القائمة: القطاعات، وبماذا عُرف كلٌّ، والغرباء، والمجهول", onFail: "—" },
    { from: "chief", to: "sales", when: "حملةٌ حُكم عليها بإعادة الكتابة أو الإيقاف، أو درجته تحتاج مهمة", carries: "الحكم برقمه، والمهمة", onFail: "تُعاد في الدورة القادمة" },
    { from: "chief", to: "followup", when: "سقطت متابعاتٌ أكثر مما كُتب، أو درجته تحتاج مهمة", carries: "أكثر أسباب السقوط، والمهمة", onFail: "تُعاد في الدورة القادمة" },
    { from: "chief", to: "owner", when: "مرةً في اليوم", carries: "التقرير: الحكم، ما فُعل، المهام، وما يحتاج يده", onFail: "ينتظر في صندوق الإشعارات" },
    { from: "router", to: "sales", when: "شخص لا رد آلي، بلا إيقاف، ولا بشري يتولاها", carries: "الرسالة + بطاقة العميل", onFail: "لا رد، بإيصال السبب" },
    { from: "sales", to: "reviewer", when: "مسودة جاهزة", carries: "المسودة + سياقها", onFail: "إعادة بعد دقيقة، مرتين ثم حجز" },
    { from: "followup", to: "reviewer", when: "مسودة متابعة جاهزة", carries: "المسودة + المتابعات السابقة", onFail: "رفض بإيصال، ينتهي السلم لهذا الشخص" },
    { from: "reviewer", to: "sales", when: "خلل يمكن إصلاحه — مرة واحدة فقط", carries: "المسودة + ما يجب إصلاحه", onFail: "حجز لصاحب العمل" },
    { from: "reviewer", to: "gate", when: "مرّت", carries: "المسودة المعتمدة", onFail: "—" },
    { from: "gate", to: "sender", when: "الرقم سليم والحد يسمح", carries: "إذن إرسال", onFail: "تأجيل للجولة التالية" },
  ],
};

export const EMAIL_GRAPH: GraphContract = {
  id: "email",
  goal: "goal:email_manager",
  maxWorking: 9,
  oneBreath: "صاحب العمل يرفع الملف ← ماجد ينظّفه ← بدور تصنّف كل جهةٍ في قطاعها ومسارها ← صاحب العمل يعطي منصور الهدف ← منصور يقسمه إلى شركاتٍ في اليوم ← سلمى تختار القطاع والمسار ٨٠/٢٠ والزاوية ← نورة تكتب بالإنجليزية ← ماجد يحكم ← صاحب العمل يوافق ← تُرسل ← ليلى تقرأ الردود ← جاسم يحكم على النتائج ← منصور يقرّر الدورة التالية.",
  loop: "كل ست ساعات: النتائج (جاسم) ← القرار (منصور) ← الموجة (سلمى) ← الكتابة (نورة) ← الحكم (ماجد) ← الإرسال ← الردود (ليلى) ← النتائج. ما لا يُقاس لا يدخل القرار.",
  nodes: [
    { id: "owner", kind: "human", responsibility: "يضع الهدف والنسبة والقطاعات، ويوافق على الإطلاق في وضع الموافقة", reads: ["brief", "draft", "verdict"], writes: ["goal", "approval"], tools: [], sideEffect: "approval", authorisedBy: "owner" },
    { id: "email_manager", kind: "agent", responsibility: "يحوّل هدف صاحب العمل إلى خطة يومية بالأرقام، يوظّف الناقص، ينفّذ أحكام المحلل، يضبط حجم الموجة، ويكتب التقرير اليومي", reads: ["goal", "results", "verdicts", "audience", "capacity", "team"], writes: ["plan", "wave_size", "brief", "paused_missions"], tools: ["planForGoal", "runAutopilot", "reconcile"], sideEffect: "none", authorisedBy: "none" },
    { id: "email_strategist", kind: "agent", responsibility: "موجة لكل قطاع مستهدف: المسار بنسبة ٨٠/٢٠، والزاوية التالية التي لم يحكم عليها المحلل بالفشل", reads: ["plan", "lists", "sectors", "verdicts"], writes: ["mission"], tools: ["chooseTrack", "nextAngle"], sideEffect: "none", authorisedBy: "none" },
    { id: "email", kind: "agent", responsibility: "رسالة بالإنجليزية: ملخص، زر، تفاصيل لمن يرغب — بزاوية الموجة ودروس المحلل", reads: ["mission", "knowledge", "lessons"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "email_followup", kind: "agent", responsibility: "متابعة من فتح أو نقر ولم يرد، بزاوية جديدة", reads: ["stage_lists", "mission", "lessons"], writes: ["mission"], tools: [], sideEffect: "none", authorisedBy: "none" },
    { id: "email_guard", kind: "reviewer", responsibility: "يحكم: أرقام من المعرفة فقط، لا مبالغة، الشكل واللغة؛ وينظّف القوائم", reads: ["draft", "knowledge", "lists", "dns"], writes: ["verdict", "list_membership"], tools: ["guardCheck", "formatIssues", "hygiene"], sideEffect: "compensatable", authorisedBy: "code", reviews: ["email", "email_followup"] },
    { id: "email_data", kind: "agent", responsibility: "تصنّف كل جهةٍ في قطاعها وتقول بماذا عُرف (نشاطها أو اسمها، قراءتها، أو اسم الملف)، وأين تذهب: AML، المحاسبة والضرائب، ثانوية، منافس، مجهولة", reads: ["lists", "clearance", "targets"], writes: ["sector", "sector_by", "desk_report"], tools: ["classifyRow", "modelPrompt"], sideEffect: "none", authorisedBy: "none" },
    { id: "sender", kind: "code", responsibility: "يرسل في حدود الإحماء والساعة والسمعة", reads: ["approval", "queue"], writes: ["email_messages"], tools: ["smtp"], sideEffect: "idempotent", authorisedBy: "code" },
    { id: "email_replies", kind: "agent", responsibility: "يقرأ الرد ويصنّفه (نافع، يغلق الباب، ليس رداً) ويسلّم المهتم", reads: ["inbound", "campaign", "contact"], writes: ["intent", "draft_reply", "deal"], tools: ["knowledge.retrieve"], sideEffect: "approval", authorisedBy: "owner" },
    { id: "email_analyst", kind: "reviewer", responsibility: "يحكم على النتائج بالشركة لكل مسار وقطاع وزاوية: وسِّع، استمر، أعد الكتابة، أوقِف، راقب", reads: ["email_messages", "intent", "missions"], writes: ["verdicts", "lessons"], tools: ["resultsReport", "judge"], sideEffect: "none", authorisedBy: "none", reviews: ["email_strategist", "email"] },
  ],
  edges: [
    { from: "owner", to: "email_guard", when: "رُفع ملف عناوين", carries: "القائمة وما قاله المستورد عنها", onFail: "تُنظَّف في دورة المدير" },
    { from: "email_guard", to: "email_data", when: "انتهى التنظيف", carries: "ما أُصلح (أخطاء النطاقات) وما استُبعد (الوهمي والميت)", onFail: "تُصنَّف في الدورة القادمة" },
    { from: "email_data", to: "email_manager", when: "انتهى التصنيف", carries: "تقرير القائمة: كم يدخل كل مسار، وكم قطاعه موروثٌ من اسم الملف، وكم مجهول", onFail: "—" },
    { from: "email_data", to: "email_strategist", when: "جمهورٌ جديد صُنّف", carries: "القطاعات الجاهزة بأعدادها", onFail: "الموجة من المصنَّف سابقاً" },
    { from: "owner", to: "email_manager", when: "وضع صاحب العمل هدفاً أو غيّره", carries: "الهدف: المقياس والرقم والموعد", onFail: "يعمل المدير بالسياسة وحدها ويقول إن لا هدف" },
    { from: "email_analyst", to: "email_manager", when: "كل دورة، بعد أن تكتمل عيّنة", carries: "الأحكام برقمها وسببها", onFail: "لا قرار على عيّنة ناقصة" },
    { from: "email_manager", to: "email_strategist", when: "كل دورة", carries: "الخطة: شركات في اليوم وحجم الموجة", onFail: "تبقى الخطة السابقة" },
    { from: "email_strategist", to: "email", when: "قطاع مستهدف فيه ١٥ لم يُراسَلوا، ولا موجة جارية له، والنسبة تسمح", carries: "الجمهور والمسار والزاوية", onFail: "إعادة في الدورة القادمة" },
    { from: "email_analyst", to: "email", when: "زاوية وُسِّعت أو أُعيدت كتابتها", carries: "درس في ذاكرة الكاتبة", onFail: "—" },
    { from: "email", to: "email_guard", when: "مسودة مقروءة", carries: "العناوين والرسالة والمتابعات", onFail: "إعادة في الدورة القادمة" },
    { from: "email_followup", to: "email_guard", when: "مسودة متابعة", carries: "المسودة + ما سبقها", onFail: "لا متابعة" },
    { from: "email_guard", to: "owner", when: "وضع الموافقة، أو وجد ماجد خللاً", carries: "المسودة + ملاحظاته", onFail: "تبقى معلقة" },
    { from: "owner", to: "sender", when: "وافق", carries: "الحملة", onFail: "—" },
    { from: "sender", to: "email_replies", when: "وصل رد", carries: "الرد + الحملة", onFail: "—" },
    { from: "email_replies", to: "email_analyst", when: "صُنّف الرد", carries: "النية: نافع أو يغلق الباب أو ليس رداً", onFail: "يُعدّ رداً بلا تصنيف" },
    { from: "sender", to: "email_analyst", when: "ارتداد أو رفض من المزوّد", carries: "الفشل ونوعه", onFail: "—" },
  ],
};

/**
 * Where a node stands in its graph, in words its prompt can carry: what it is
 * for, what it reads, whom it takes work from and hands work to, and what
 * happens when its hand-off fails. The prompt is generated from the contract,
 * so the two cannot drift apart. Pure.
 */
export function nodeBrief(g: GraphContract, id: string): string {
  const me = g.nodes.find((n) => n.id === id);
  if (!me) return "";
  const name = (x: string) => NODE_AR[x] ?? x;
  const ins = g.edges.filter((e) => e.to === id), outs = g.edges.filter((e) => e.from === id);
  return [
    "═══ موقعك في القراف (عقدٌ مكتوب، لا وصف) ═══",
    `المسار كله في نفَس: ${g.oneBreath}`,
    g.loop ? `الحلقة: ${g.loop}` : "",
    `أنت عقدة «${name(id)}». مسؤوليتك الوحيدة: ${me.responsibility}.`,
    `تقرأ: ${me.reads.join("، ")}. وتكتب: ${me.writes.join("، ")}.${me.tools.length ? ` أدواتك: ${me.tools.join("، ")}.` : ""}`,
    me.sideEffect === "none" ? "لا أثر لك خارج النظام: لا ترسل لأحد، ولا تعد أحداً بشيء." : `أثرك الخارجي يأذن به: ${me.authorisedBy === "owner" ? "صاحب العمل" : "الكود"} — لا رأيك.`,
    me.reviews?.length ? `تراجع عمل: ${me.reviews.map(name).join("، ")} — ولا تراجع عملك أنت.` : "",
    ins.length ? "يصلك العمل من:" : "", ...ins.map((e) => `• ${name(e.from)} — حين ${e.when}، ويحمل ${e.carries}. إن تعثّر: ${e.onFail}.`),
    outs.length ? "تسلّم العمل إلى:" : "", ...outs.map((e) => `• ${name(e.to)} — حين ${e.when}، وتسلّم ${e.carries}. إن تعثّر: ${e.onFail}.`),
    "ما ليس في عقدك ليس عملك: إن رأيته فقله لمن هو عمله، ولا تفعله.",
  ].filter(Boolean).join("\n");
}

export const NODE_AR: Record<string, string> = {
  owner: "صاحب العمل", email_manager: "منصور (المدير)", email_strategist: "سلمى (التخطيط)", email: "نورة (الكتابة)",
  email_followup: "يوسف (المتابعة)", email_guard: "ماجد (الحارس)", sender: "المُرسِل (كود)", email_replies: "ليلى (الردود)",
  email_analyst: "جاسم (محلل النتائج)", email_data: "بدور (التصنيف)", chief: "شمّة (المديرة)", intake: "سالم (التنظيف)", collector: "ريم (التصنيف)", router: "الفرز (كود)", sales: "البائع", followup: "المتابعة", reviewer: "المراجعة", gate: "البوابة (كود)",
};

export const GRAPHS = [WHATSAPP_GRAPH, EMAIL_GRAPH];

/** What is wrong with a graph's contracts — empty when sound. Pure. */
export function contractProblems(g: GraphContract): string[] {
  const out: string[] = [];
  const ids = new Set(g.nodes.map((n) => n.id));
  for (const e of g.edges) {
    if (!ids.has(e.from)) out.push(`حافة من عقدة غير موجودة: ${e.from}`);
    if (!ids.has(e.to)) out.push(`حافة إلى عقدة غير موجودة: ${e.to}`);
  }
  for (const n of g.nodes) {
    if (n.reviews?.includes(n.id)) out.push(`${n.id} يراجع نفسه`);
    if ((n.sideEffect === "idempotent" || n.sideEffect === "compensatable" || n.sideEffect === "approval") && n.authorisedBy === "none") out.push(`${n.id} له أثر خارجي بلا جهة تأذن به`);
    if (n.kind === "agent" && n.sideEffect !== "none" && n.authorisedBy !== "owner") out.push(`${n.id} وكيل يُحدث أثراً خارجياً بلا موافقة صاحب العمل`);
  }
  const working = g.nodes.filter((n) => n.kind === "agent" || n.kind === "reviewer").length;
  const max = g.maxWorking ?? 5;
  if (working > max) out.push(`${working} عقد عاملة — الحد ${max}`);
  // A loop that does not close is a pipeline: whoever judges results must hand them back.
  for (const n of g.nodes) if (n.kind === "reviewer" && n.id !== "reviewer" && !g.edges.some((e) => e.from === n.id)) out.push(`${n.id} يحكم ولا يسلّم حكمه لأحد`);
  for (const n of g.nodes) if (n.kind !== "human" && n.kind !== "code" && !g.edges.some((e) => e.to === n.id || e.from === n.id)) out.push(`${n.id} معزول — لا حافة له`);
  return out;
}
