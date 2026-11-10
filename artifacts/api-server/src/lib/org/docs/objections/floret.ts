// ── فلوريت: الاعتراضات والكتيبات (أفراد، لهجة خليجية) ───────────────
// من معرفة الحساب القائمة وحدها: FLORET_PROFILE وFLORET_PERSONAS في
// lib/catalog/floret-account.ts، وقواعد المحل في lib/smart-followup.ts (SALES_VOICE،
// SERVICE_VOICE، BANNED_PHRASES) وكتلة الحساب. لا رقم ولا كلمة تحبّب ولا عبارة رفضها صاحب
// العمل، والرابط الوحيد https://floret-royal.io. ما ليس في المعرفة (الضمان، الإرجاع،
// الاستبدال، آراء الزبائن) مُعلَّم «يحتاج موافقة صاحب العمل». يُبذر معلّقاً.

import type { AccountLibrary } from "./index";

const SITE = "https://floret-royal.io";
const PROFILE = "lib/catalog/floret-account.ts FLORET_PROFILE";
const PERSONA = (r: string) => `lib/catalog/floret-account.ts FLORET_PERSONAS.${r}`;
const VOICE = "lib/smart-followup.ts SALES_VOICE";

export const FLORET_LIBRARY: AccountLibrary = {
  account: "floret",
  language: "ar",
  objections: [
    {
      slug: "price.how_much", type: "price", kind: "info_request",
      signal: "بكم هذي القطعة؟",
      response: `لا رقم في الرسالة: التفاصيل كاملة في صفحة القطعة على الموقع ${SITE}، وأرسلي لها رابط القطعة إن كان معروفاً في المعلومات.`,
      proof: { text: "التفاصيل كلها في صفحة كل قطعة على المتجر، ولا تُذكر في المحادثة.", status: "approved_knowledge", source: PROFILE },
      nextStep: "سؤال واحد: لمناسبة أو للبس اليومي؟",
      roles: ["sales_specialist", "reply_dm", "copywriter", "lead_qualification"],
    },
    {
      slug: "price.too_much", type: "price", kind: "objection",
      signal: "غالية علي.",
      response: "لا تدافعين ولا تساومين. اسأليها عن ذوقها أو المناسبة، واقترحي تصاميم قريبة من ذوقها على الموقع بالاسم إن وُجدت في المعلومات.",
      proof: null,
      nextStep: `رابط الموقع ${SITE} ودعوتها ترسل صورة اللي يعجبها.`,
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "timing.later", type: "timing", kind: "objection",
      signal: "بفكر وأرد عليك.",
      response: "احترمي وقتها في سطر: الموقع موجود تتصفحين على راحتك، والواتساب مفتوح لك. لا استعجال ولا «آخر قطعة».",
      proof: { text: "لا تضغطين، ولا تسألين سؤالين.", status: "approved_knowledge", source: PERSONA("sales") },
      nextStep: "لا شيء الآن؛ المتابعة يقررها النظام بسلّمها.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "trust.genuine", type: "trust", kind: "objection",
      signal: "الذهب أصلي؟",
      response: "لا تقولين «مضمون» ولا تعدين بشهادة من عندك. ادعيها تشوف القطعة بنفسها في المعرض بالعين، أو قولي «أتأكد لك وأرد عليك» وارفعي السؤال لصاحب العمل.",
      proof: { text: "ضمان الأصالة أو شهادة القطعة.", status: "needs_owner_approval", source: "ليس في المعرفة المعتمدة" },
      nextStep: "زيارة المعرض، أو جواب صاحب العمل.",
      roles: ["sales_specialist", "reply_dm", "customer_success"],
    },
    {
      slug: "trust.online", type: "trust", kind: "objection",
      signal: "أخاف أطلب أونلاين.",
      response: "طمّنيها بما هو معروف: نوصّل لكل الإمارات، ولنا معرض في العين تقدرين تستلمين منه. لا مدة توصيل من عندك.",
      proof: { text: "يبيع أونلاين لكل الإمارات مع التوصيل، وله معرض في العين.", status: "approved_knowledge", source: PROFILE },
      nextStep: "سؤال واحد: توصيل أو استلام من المعرض؟",
      roles: ["sales_specialist", "reply_dm", "lead_qualification"],
    },
    {
      slug: "risk.return", type: "risk", kind: "info_request",
      signal: "إذا ما عجبتني أقدر أرجعها؟",
      response: "السياسة فقط كما في المعلومات؛ إن لم تكن مكتوبة قولي «أتأكد لك وأرد عليك» وحوّلي لصاحب العمل.",
      proof: { text: "سياسة الإرجاع أو الاستبدال.", status: "needs_owner_approval", source: "ليست في المعرفة المعتمدة" },
      nextStep: "جواب صاحب العمل.",
      roles: ["sales_specialist", "reply_dm", "customer_success"],
    },
    {
      slug: "risk.size", type: "risk", kind: "objection",
      signal: "خايفة المقاس ما يضبط.",
      response: "خذي منها المقاس قبل الطلب، ولا تعدين بتعديل أو استبدال من عندك.",
      proof: { text: "حين تقول «أبغى أطلب»: الاسم والإمارة والمقاس، ثم التوصيل أو الاستلام من المعرض.", status: "approved_knowledge", source: PERSONA("sales") },
      nextStep: "سؤال واحد عن المقاس.",
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "competitor.other_shop", type: "competitor", kind: "objection",
      signal: "شفت مثلها في محل ثاني.",
      response: "لا تذكرين محلاً بالاسم ولا تقللين من أحد. اسأليها إيش عجبها في القطعة، واقترحي أقرب تصميم عندنا بالاسم من المعلومات.",
      proof: { text: "لا تذكر محلات أخرى بالاسم.", status: "approved_knowledge", source: PROFILE },
      nextStep: "دعوتها ترسل صورة اللي عجبها.",
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "authority.family", type: "authority", kind: "objection",
      signal: "بشاور أهلي قبل.",
      response: "قولي لها على راحتها، وأرسلي رابط القطعة تقدر تشاركه معهم. بلا ضغط.",
      proof: null,
      nextStep: "رابط القطعة من المعلومات، أو رابط الموقع.",
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "no_need.browsing", type: "no_need", kind: "objection",
      signal: "بس أتفرج.",
      response: `حياك الله، الموقع فيه التصاميم كلها بصورها: ${SITE}. سطر واحد ثم توقفي.`,
      proof: { text: "رابط الموقع هو الرابط الوحيد المسموح كما هو حرفياً.", status: "approved_knowledge", source: VOICE },
      nextStep: "لا سؤال.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "no_need.refusal", type: "no_need", kind: "refusal",
      signal: "لا شكراً، ما أبي.",
      response: "هذا رفض لا اعتراض: اشكريها وذكّريها أن المعرض موجود متى حبّت، وتوقفي. لا متابعة.",
      proof: { text: "لا تلاحقين من قالت لا: اشكريها وذكّريها أن المعرض في العين موجود.", status: "approved_knowledge", source: PERSONA("sales") },
      nextStep: "التوقف.",
      roles: ["sales_specialist", "reply_dm", "copywriter", "customer_success"],
    },
  ],
  playbooks: [
    { role: "sales_specialist", text: "اذكري القطعة بالاسم، وسؤال واحد يقرّب الطلب (لمين أو لأي مناسبة)، ورابط القطعة من المعلومات. حين تقول «أبغى أطلب»: الاسم والإمارة والمقاس، التوصيل أو الاستلام من المعرض، ثم سلّمي لمختص.", source: PERSONA("sales") },
    { role: "reply_dm", text: "صنّفي أولاً: اعتراض أو سؤال أو رفض. في العلن سطر بلا رابط ولا وعد، والتفاصيل في الخاص. الرفض: شكر وتوقف.", source: PERSONA("sales") },
    { role: "copywriter", text: "كإنسان من المحل يكتب بيده: سطران إلى ثلاثة بلهجتها، ورابط الموقع وحده كما هو، ورسالة مختلفة لكل زبونة. لا تبدئين بـ«أتابع معك» ولا «للتذكير».", source: VOICE },
    { role: "lead_qualification", text: "التأهيل من كلامها: القطعة التي سألت عنها، لمين، المناسبة، الإمارة. «أبغى أطلب» = طلب؛ «بس أتفرج» = بارد؛ «لا» = رفض يغلق البطاقة.", source: PERSONA("sales") },
    { role: "sales_director", text: "قيسي الفريق بالطلبات المكتملة لا بعدد الردود، ولا تقبلين رداً يصلح لأي زبونة. راجعي الاعتراضات المسجّلة واقترحي على صاحب العمل ما يستحق الإضافة.", source: PERSONA("chief") },
    { role: "customer_success", text: "الشكوى أولاً: اعترفي بكلماتها، واعتذري مرة، ثم خطوة ومن يتابع ومتى. لا بيع في محادثة شكوى، وكل ما فيه مال أو إرجاع لصاحب العمل فوراً بملخص.", source: PERSONA("support") },
    { role: "campaign_strategist", text: "الجمهور من سؤالها عن قطعة أو صورة أرسلتها، والزاوية قطعة بالاسم ورابطها. لا تُعاد مراسلة من رفضت أو طلبت الإيقاف.", source: VOICE },
    { role: "manager", text: "راجعوا بالعيّنة: رد بلا خطوة، أو رقم، أو تحبّب، أو وعد غير مكتوب. الأدلة الجديدة والحدود لصاحب العمل يعتمدها.", source: PROFILE },
  ],
};
