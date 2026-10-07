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

export type GraphContract = { id: string; goal: string; oneBreath: string; nodes: NodeContract[]; edges: EdgeContract[] };

export const WHATSAPP_GRAPH: GraphContract = {
  id: "whatsapp",
  goal: "clients_won",
  oneBreath: "رسالة عميل ← يُفرز آلياً ← هال يكتب ← المراجعة تحكم ← فهد يسمح ← تُرسل؛ ومن سكت يكتب له خالد على نفس الطريق.",
  nodes: [
    { id: "router", kind: "code", responsibility: "يفرز الرسالة: نية، رد آلي، إيقاف، بشري يتولاها", reads: ["incoming", "thread", "lead_card"], writes: ["lead_card.intent"], tools: [], sideEffect: "none", authorisedBy: "none" },
    { id: "sales", kind: "agent", responsibility: "يكتب رداً واحداً يكمل موضوع الحملة ويقدّم البيع مرحلة", reads: ["thread", "outreach", "lead_card", "knowledge"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "followup", kind: "agent", responsibility: "يكتب متابعة واحدة بزاوية جديدة لمن تكلم ثم سكت، أو يرفض", reads: ["thread", "outreach", "lead_card", "knowledge", "earlier_followups"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "reviewer", kind: "reviewer", responsibility: "يحكم على المسودة بمعايير ثابتة: يمر، أو يُعاد مرة، أو يُحجز", reads: ["draft", "thread", "lead_card", "knowledge"], writes: ["verdict"], tools: ["reply-check"], sideEffect: "none", authorisedBy: "none", reviews: ["sales", "followup"] },
    { id: "gate", kind: "code", responsibility: "يسمح بالإرسال أو يمنعه: الحدود اليومية، علامات الحظر، ساعات الإرسال، الإيقاف والحظر ٥ أشهر", reads: ["ops_signals", "unsubscribed", "daily_count"], writes: ["send_permit"], tools: [], sideEffect: "none", authorisedBy: "code" },
    { id: "sender", kind: "code", responsibility: "يرسل ما سُمح به مرة واحدة فقط", reads: ["send_permit", "draft"], writes: ["thread"], tools: ["whatsapp.send"], sideEffect: "idempotent", authorisedBy: "code" },
  ],
  edges: [
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
  goal: "clients_won",
  oneBreath: "سلمى تقسّم القائمة بالقطاع وتخطط ← نورة تكتب ← ماجد يحكم ← صاحب العمل يوافق ← تُرسل ← ليلى تقرأ الردود وتسلّم المهتم.",
  nodes: [
    { id: "email_strategist", kind: "agent", responsibility: "موجة لكل قطاع بحملته", reads: ["lists", "sectors", "results"], writes: ["mission"], tools: [], sideEffect: "none", authorisedBy: "none" },
    { id: "email", kind: "agent", responsibility: "رسالة: ملخص، زر، تفاصيل لمن يرغب", reads: ["mission", "knowledge", "lessons"], writes: ["draft"], tools: ["knowledge.retrieve"], sideEffect: "none", authorisedBy: "none" },
    { id: "email_guard", kind: "reviewer", responsibility: "يحكم: أرقام من المعرفة فقط، لا مبالغة، الشكل الصحيح؛ وينظّف القوائم", reads: ["draft", "knowledge", "lists", "dns"], writes: ["verdict", "list_membership"], tools: ["guardCheck", "formatIssues", "hygiene"], sideEffect: "compensatable", authorisedBy: "code", reviews: ["email", "email_followup"] },
    { id: "owner", kind: "human", responsibility: "يوافق على الإطلاق في وضع الموافقة", reads: ["draft", "verdict"], writes: ["approval"], tools: [], sideEffect: "approval", authorisedBy: "owner" },
    { id: "sender", kind: "code", responsibility: "يرسل في حدود الإحماء والساعة", reads: ["approval", "queue"], writes: ["email_messages"], tools: ["smtp"], sideEffect: "idempotent", authorisedBy: "code" },
    { id: "email_replies", kind: "agent", responsibility: "يقرأ الرد ويصنفه ويسلّم المهتم", reads: ["inbound", "campaign", "contact"], writes: ["draft_reply", "deal"], tools: ["knowledge.retrieve"], sideEffect: "approval", authorisedBy: "owner" },
  ],
  edges: [
    { from: "email_strategist", to: "email", when: "قطاع فيه ١٥ لم يُراسَلوا على الأقل، ولا موجة جارية له", carries: "خطة: الجمهور والزاوية", onFail: "إعادة في الجولة القادمة" },
    { from: "email", to: "email_guard", when: "مسودة مقروءة", carries: "العناوين والرسالة والمتابعات", onFail: "إعادة في الجولة القادمة" },
    { from: "email_guard", to: "owner", when: "وضع الموافقة، أو وجد ماجد خللاً", carries: "المسودة + ملاحظاته", onFail: "تبقى معلقة" },
    { from: "owner", to: "sender", when: "وافق", carries: "الحملة", onFail: "—" },
    { from: "sender", to: "email_replies", when: "وصل رد", carries: "الرد + الحملة", onFail: "—" },
  ],
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
  if (working > 5) out.push(`${working} عقد عاملة — الحد في المرحلة الأولى خمس`);
  return out;
}
