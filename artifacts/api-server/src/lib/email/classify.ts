// ── ما وصل فعلاً: نوع الرسالة قبل نيّتها ──────────────────────────
// كان الوارد يُصنَّف بمصنّف الواتساب. ذاك المصنّف يقرأ نيّة شخصٍ نكلّمه
// أصلاً — مهتم، سؤال، اعتراض — ولا يعرف ثلاث حقائق يعرفها أي صندوق
// بريد: أن الرد قد يكون آلةً لا إنساناً، وأن الرسالة قد تكون ارتداداً،
// وأن أكثر ما يصل بريدَ شركةٍ هو من يبيع لها لا من يشتري منها.
//
// فصار «Monthly Active Plan — SEO» إعلاناً صنّفه النظام «عميلاً حاراً»،
// و«Ticket Received» ردّاً آلياً صنّفه «تحية»، وبُنيت على ذلك صفقات.
//
// العلاج: نوعٌ قبل نيّة، وبوابةٌ صلبة قبل كليهما — هل أرسلنا لهذا
// العنوان رسالةً من قبل. ما لم نراسلهم فما وصل ليس رداً، وأي شيء ليس
// رداً لا يصبح عميلاً حاراً ولا صفقة ولا إشعاراً بنار.
//
// لماذا ليس contact_id: المستورد ينشئ جهةً لكل مُرسِل لحظة وصول رسالته،
// فالعمود ممتلئ لكل صفٍّ في القاعدة ولا يميّز شيئاً. قياسٌ على البيانات
// الحقيقية: ٢٥ رسالة واردة، ٢٥ لها جهة، وواحدة فقط راسلناها فعلاً.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, emailMessagesTable } from "@workspace/db";
import { type Intent } from "../intent";

/** نوع الرسالة الواردة — سؤالٌ مستقل تماماً عن نيّة كاتبها. */
export type MailKind =
  | "reply"        // إنسانٌ يرد على رسالةٍ أرسلناها — وهذا وحده قد يكون عميلاً
  | "auto_reply"   // آلة: خارج المكتب، تم استلام تذكرتكم، لا تردّوا على هذا البريد
  | "bounce"       // العنوان لم يستلم
  | "cold_pitch"   // من يبيع لنا: سيو، تصميم مواقع، برمجيات، خدمات
  | "newsletter"   // نشرة أو قائمة بريدية
  | "job_application" // باحثٌ عن عمل أرسل سيرته — لا عميل ولا إزعاج
  | "spam";        // إزعاج

export interface MailVerdict {
  kind: MailKind;
  /**
   * يطلب أن نكفّ عن مراسلته — ويُحسَب مستقلاً عن النوع تماماً.
   *
   * لأن «إلغاء الاشتراك» كلمةٌ ذات وجهين: في تذييل نشرةٍ هي علامة
   * إرسالٍ جماعي، وفي رسالةٍ من سطرٍ واحد هي إنسانٌ يطلب أن يُترك. وقد
   * صنّف النظام طلب إيقافٍ حقيقياً «نشرةً» لهذا السبب بالضبط، فلم
   * يُنفَّذ الطلب وبقيت الجهة نشطة.
   *
   * فلا يُعلَّق هذا على النوع ولا على سجل الإرسال: من طلب أن نكفّ
   * يُستجاب له، ولو لم نعرف كيف وصل إلينا.
   */
  asksToStop: boolean;
  /** هل سبق أن أرسلنا إلى هذا العنوان، أو ردّ على رسالةٍ منّا بالترويسة. */
  solicited: boolean;
  /** نيّة الكاتب — تُقرأ للرد الحقيقي فقط، وتبقى null لكل ما سواه. */
  intent: EmailIntent | null;
  confidence: number;
  /** بالعربية، لتُعرض لصاحب العمل: لماذا صُنّفت هكذا. */
  reasons: string[];
  classifier: "rules" | "rules+ai";
}

export interface ClassifyInput {
  from: string;
  subject?: string | null;
  /** نص الرسالة بعد تجريد المقتبس. */
  text?: string | null;
  /** النص الخام قبل التجريد — فيه المقتبس الذي يثبت أنهم يردّون علينا. */
  raw?: string | null;
  headers?: Record<string, string> | null;
  inReplyTo?: string | null;
  references?: string | null;
  /** بريدنا المُرسِل — وجوده في المقتبس دليل أنهم يردّون على رسالتنا. */
  ourEmail?: string | null;
}

// ── الترويسات: ما تقوله الآلة عن نفسها ────────────────────────────
// أصدق إشارة على الرد الآلي ليست في نصه بل في ترويسته. RFC 3834 يُلزم
// كل مجيبٍ آليٍّ مؤدّب بـ Auto-Submitted، وأكثرهم يفعل.
const H_AUTO = ["auto-submitted", "x-autoreply", "x-autorespond", "x-autoresponder", "x-auto-response-suppress", "x-mailer-autoreply"];
const H_LIST = ["list-id", "list-unsubscribe", "list-post", "x-campaign-id", "x-mailchimp-id", "feedback-id"];

/**
 * التطبيع العربي قبل أي مطابقة. وهذا ليس تجميلاً: اختبارٌ في هذا
 * المستودع أرسل «الغاء الاشتراك» — بلا همزة — فلم يُطابِق نمطاً مكتوباً
 * بالهمزة، وبقيت الجهة «نشطة» بعد أن طلبت الإيقاف صريحاً. وهذه أكثر
 * صيغةٍ يكتبها الناس فعلاً على لوحات المفاتيح، وإهمالُ طلب إيقافٍ ليس
 * خطأً تقنياً فقط.
 *
 * يُوحّد: الألف بأشكالها (أإآا)، والهمزة على الواو والياء، والتاء
 * المربوطة، والياء المقصورة، والتطويل، والتشكيل، وأرقام العرب الشرقية.
 */
export function normalizeAr(text: string): string {
  return text
    .replace(/[\u0622\u0623\u0625\u0627\u0671]/g, "ا")   // آأإاٱ → ا
    .replace(/[\u0624]/g, "و").replace(/[\u0626]/g, "ي")    // ؤئ
    .replace(/\u0629/g, "ه")                                 // ة → ه
    .replace(/[\u0649\u064A]/g, "ي")                        // ىي
    .replace(/\u0640/g, "")                                   // تطويل
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")   // تشكيل
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

const header = (h: Record<string, string> | null | undefined, k: string): string =>
  (h?.[k] ?? h?.[k.toLowerCase()] ?? "").toLowerCase().trim();

// ── الارتداد ──────────────────────────────────────────────────────
const BOUNCE_FROM = /^(mailer-daemon|postmaster|no-?reply|bounce|bounces|returns?)[@+]/i;
const BOUNCE_SUBJ = /^(delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|failure notice|delivery has failed|إشعار (حالة )?تسليم|فشل تسليم)/i;

// ── الرد الآلي ────────────────────────────────────────────────────
// مُثبَّتة في أول العنوان أو عبارات لا يكتبها إنسانٌ يردّ عليك. «تم
// استلام» في وسط جملةٍ من عميل ليست رداً آلياً، ولذلك العبارات محدّدة.
const AUTO_SUBJ = /^(\s*(re|fwd?)\s*:\s*)?(auto(matic)?[\s-]?(reply|response|responder)|automatic reply|out of (the )?office|away from (the )?office|(ticket|case|request|enquiry|inquiry|your message|your email)\s+(received|created|logged|opened|#?\d+)|thank you for (contacting|your (email|enquiry|inquiry|message))|we('ve| have) received your|acknowledgement of receipt|رد تلقايي|خارج المكتب|في اجازه|تم استلام (رسالتكم|طلبكم|بريدكم)|شكرا لتواصلكم)/i;
const AUTO_BODY = /(this is an automat(ic|ed) (reply|response|message)|i am (currently )?(out of|away from) the office|i('m| am) on (annual |maternity )?leave|will be out of office|do not reply to this (e-?mail|message)|this (e-?mail|mailbox) is not monitored|your (ticket|case|request) (has been|was) (received|created|logged)|we will (get back to you|respond|reply) (within|in) \d|one of our (team|agents) will|هذا رد تلقايي|لا ترد علي هذا البريد|سيتم الرد عليكم (خلال|في)|تم استلام (رسالتكم|طلبكم))/i;

// ── من يبيع لنا ───────────────────────────────────────────────────
// الفرق بين عميلٍ محتملٍ وبائعٍ ليس الموضوع بل الاتجاه: البائع يَعرض،
// والعميل يَسأل. هذه كلها عبارات عرضٍ من المُرسِل.
const OFFER = /(we (offer|provide|supply|specialize|specialise|deliver|develop|design|build|handle|help (businesses|companies|clients|you)|are a (leading |digital |software )?(agency|company|provider|firm|team))|(send|share|forward|provide) (you|u) (with )?(our|an|a|the) ?(price|pricing|quote|quotation|proposal|analysis|report|portfolio|service overview|brochure|catalog|packages?|plans?)|(would|do) you (like|want) to (see|receive|know more about|check) (our|an|a)|our (services|solutions|packages?|price list|pricing|service overview|portfolio|offerings)|i(?:'m| am)? (connecting|reach(ing)? out|writing to (you )?(about|introduce))|(i'd|i would|we'd|we would) (like|love|be happy) to (introduce|offer|show|discuss|connect|present)|let me know if (you|your company) (are|is|would be) interested|book a (demo|call) with (us|our)|partner with us|نحن (نقدم|نوفر|شركه|وكاله|متخصصون)|خدماتنا|عروضنا|اود ان اعرض|نوفر لكم|نرسل لكم (عرض|قايمه)|يسعدنا التعاون)/i;
const PITCH_TOPIC = /(seo|search engine optimi[sz]ation|backlinks?|google ranking|first page of google|rank(ing)? (higher|on google)|web(site)? (design|development|redesign)|mobile app development|digital marketing (agency|services|package)|social media (management|marketing) (package|services)|lead generation (service|agency)|guest post|link building|domain authority|search (visibility|presence|ranking)|organic (website |business )?growth|online (discoverability|presence|visibility)|where your website appears|website (audit|analysis) (report)?|increase your (sales|traffic|revenue|visibility)|grow your business|dedicated (developer|resource)s?|staff augmentation|offshore team|crypto|forex|loan offer|تحسين محركات البحث|تصميم (موقع|مواقع)|تسويق الكتروني|اعلانات جوجل|زياده (المبيعات|الزيارات)|باك لينك)/i;
const PRICE_LIST = /(\$\s?\d{2,}|\d{2,}\s?(usd|aed|\$)\s?(\/|per )?(month|mo|year)|monthly (active )?plan|our (pricing|packages?|plans?) (start|begin)|starting (at|from) (just )?\$)/i;

/**
 * لغة المستلم: ما يكتبه من وصله عرضٌ منّا، ولا يكتبه من يعرض علينا.
 * هذه هي الإشارة التي كانت ناقصة، وغيابها كلّف أثمن رسالة في الصندوق:
 * شركة المزروعي في أبوظبي كتبت «Thank you for sharing the proposal for
 * AML Compliance… We will review the details internally and revert to
 * you» — ردٌّ دافئ على عرضٍ أرسلته الشركة بيدها من خارج هذا النظام، فلا
 * أثر له في سجل الإرسال. صنّفه النظام إزعاجاً لأن السجل كان حَكَمه الوحيد.
 */
const RECIPIENT_SIDE = /(thank you (so much |very much )?for (sharing|sending|your|the) ?(the |your )?(proposal|quotation|quote|offer|e-?mail|message|information|details|presentation|deck|reply|response|prompt)|thanks for (sharing|sending|the |your )|(we|i) (will|shall|'ll) (review|study|check|go through|discuss|consider) (the|your|this|these|it|them|details|proposal)|revert (back )?to you|get back to you (shortly|soon|after|once|internally)|(as|per) your (e-?mail|proposal|quotation|offer|message)|(have |has )?received your (proposal|quotation|offer|e-?mail|message)|noted (with thanks|your)|under (review|consideration)|forwarded (it |this )?(to|internally)|شكرا( لكم?)? علي (ارسال|العرض|عرضكم|بريدكم|رسالتكم|الاقتراح)|سنراجع|سندرس|سنعود اليكم|بناء علي (بريدكم|عرضكم)|وصلنا (عرضكم|بريدكم)|تحت الدراسه)/i;

/** طلب وظيفة: لا عميل ولا إزعاج، ويستحق مكاناً صادقاً. */
const CV_LIKE = /((i am|i'm) (a|an) [a-z ]{3,44}(professional|specialist|accountant|auditor|graduate|officer|analyst|manager) with|my (experience|expertise|background|skills) (includes?|covers?|spans?)|seeking [a-z ,]{0,70}(role|position|opportunity)|\d{1,2}\+? years of (international |professional |relevant |hands-on )?experience|i (hold|possess) (a|an) [a-z. ]{2,40}(degree|certification|certificate)|kindly (find|consider) (my|the attached))/i;
const JOB = /(apply(ing)? for the (position|post|role|vacancy)|application for the (position|post|role)|(my|attached) (cv|resume|curriculum vitae)|i am writing to apply|seeking (a |an )?(position|opportunity|job|role)|(position|vacancy|role) of [a-z]|job application|fresh graduate seeking|اتقدم بطلب|السيره الذاتيه|طلب وظيفه|ابحث عن (عمل|وظيفه))/i;

/** عناوين لا يكتب منها عميلٌ جادٌّ عرضاً تجارياً. */
const FREEMAIL = /@(gmail|hotmail|outlook|yahoo|live|aol|protonmail|yandex|mail|icloud|rediffmail)\./i;

const E_OPT_OUT   = /(unsubscribe|remove (me|us) from|take (me|us) off|stop (sending|emailing|contacting)|do not (contact|email) (me|us)|opt out|no longer wish to receive|الغاء الاشتراك|اوقفوا|لا ترسلوا|احذفوا بريدي)/i;
const MARKETING_BULK = /(unsubscribe|view (this|in) browser|you (are )?receiv(ed|ing) this (e-?mail|message) because|manage your preferences|الغاء الاشتراك|عرض في المتصفح)/i;

/**
 * هل راسلنا هذا العنوان فعلاً، أو ردّ على رسالةٍ منّا.
 * ثلاث إشارات، أيٌّ منها يكفي:
 *   ١) أرسلنا إلى عنوانه رسالةً خرجت فعلاً (sent_at غير فارغ).
 *   ٢) ترويسة In-Reply-To أو References تطابق Message-ID رسالةٍ لنا —
 *      وهذه تُنصِف من يردّ من عنوانٍ آخر: زميلٌ أُحيلت إليه رسالتنا.
 *   ٣) بريدنا المُرسِل مذكور في المقتبس داخل نص رسالته.
 */
export async function solicitation(userId: number, input: ClassifyInput): Promise<{ solicited: boolean; sentCount: number; matchedId: number | null; how: string | null }> {
  const from = input.from.toLowerCase().trim();
  const refs = [input.inReplyTo, ...(input.references ?? "").split(/\s+/)].map((r) => r?.trim()).filter(Boolean) as string[];

  let matchedId: number | null = null;
  if (refs.length) {
    const [m] = await db.select({ id: emailMessagesTable.id }).from(emailMessagesTable)
      .where(and(eq(emailMessagesTable.userId, userId), inArray(emailMessagesTable.messageIdHdr, refs))).limit(1);
    if (m) matchedId = m.id;
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(emailMessagesTable)
    .where(and(eq(emailMessagesTable.userId, userId), sql`lower(${emailMessagesTable.toEmail}) = ${from}`, sql`${emailMessagesTable.sentAt} is not null`));
  const sentCount = Number(n);

  const quotesUs = !!input.ourEmail && !!input.raw &&
    input.raw.toLowerCase().includes(input.ourEmail.toLowerCase());

  const how = matchedId ? "ترويسة الرد تطابق رسالةً أرسلناها"
    : sentCount > 0 ? `أرسلنا إلى هذا العنوان ${sentCount} رسالة`
    : quotesUs ? "نص رسالته يقتبس بريدنا المُرسِل"
    : null;
  return { solicited: !!how, sentCount, matchedId, how };
}

/**
 * النوع بالقواعد وحدها — بلا نموذج، بلا شبكة، فورية.
 * تُستدعى قبل أي ذكاء اصطناعي، ونتيجتها تحسم كل ما ليس رداً حقيقياً.
 */
/**
 * طلب الإيقاف وحده. قصيرٌ ومباشر — أو في العنوان.
 * تذييل النشرة يحمل الكلمة نفسها وسط مئاتٍ من الحروف، فالنسبة هي
 * الفاصل: من كتب «الغاء الاشتراك» ولا شيء غيره يطلب الإيقاف؛ ومن ورد
 * فيه الرابط في آخر إعلانٍ طويل لا يطلب شيئاً.
 */
export function asksToStop(subject: string | null | undefined, text: string | null | undefined): boolean {
  const subj = normalizeAr((subject ?? "").trim());
  const body = normalizeAr((text ?? "").trim());
  if (E_OPT_OUT.test(subj)) return true;
  const m = E_OPT_OUT.exec(body);
  if (!m) return false;
  // رسالةٌ قصيرة: الطلب هو كل مضمونها.
  if (body.length <= 240) return true;
  // أو جاء الطلب في أول سطرين — لا في تذييلٍ بعد صفحة.
  const head = body.split("\n").slice(0, 2).join(" ");
  return E_OPT_OUT.test(head);
}

export function kindOf(input: ClassifyInput, solicited: boolean): { kind: MailKind; confidence: number; reasons: string[] } {
  const from = input.from.toLowerCase().trim();
  const subj = (input.subject ?? "").trim();
  const body = (input.text ?? "").trim();
  // المطابقة تجري على نصٍّ مُطبَّع، والأصل يبقى للعرض في الأسباب.
  const hay = normalizeAr(`${subj}\n${body}`);
  const reasons: string[] = [];

  // ١ · الارتداد: العنوان لم يستلم. أقوى من كل ما بعده.
  const autoSubmitted = header(input.headers, "auto-submitted");
  if (BOUNCE_FROM.test(from) || BOUNCE_SUBJ.test(subj) || header(input.headers, "x-failed-recipients") ||
      /multipart\/report/.test(header(input.headers, "content-type")) || autoSubmitted.startsWith("auto-generated")) {
    reasons.push(BOUNCE_SUBJ.test(subj) ? "عنوان الرسالة إشعار فشل تسليم" : "ترويسات الرسالة ترويسات تقرير تسليم");
    return { kind: "bounce", confidence: 0.95, reasons };
  }

  // ٢ · الرد الآلي: الترويسة أصدق من النص.
  const autoHdr = H_AUTO.find((h) => {
    const v = header(input.headers, h);
    return h === "auto-submitted" ? !!v && v !== "no" : !!v;
  });
  if (autoHdr) {
    reasons.push(`ترويسة ${autoHdr} تقول إن المُرسِل آلة`);
    return { kind: "auto_reply", confidence: 0.95, reasons };
  }
  if (AUTO_SUBJ.test(subj)) {
    reasons.push(`عنوان الرسالة صيغة ردٍّ آلي: «${subj.slice(0, 60)}»`);
    return { kind: "auto_reply", confidence: 0.85, reasons };
  }
  if (AUTO_BODY.test(body)) {
    reasons.push("نص الرسالة عبارة ردٍّ آلي لا يكتبها شخص يردّ عليك");
    return { kind: "auto_reply", confidence: 0.8, reasons };
  }

  // ٣ · النشرة: قائمةٌ بريدية. ردٌّ حقيقي لا يحمل List-Id أبداً.
  const listHdr = H_LIST.find((h) => !!header(input.headers, h));
  const bulk = header(input.headers, "precedence") === "bulk";
  if ((listHdr || bulk) && !solicited) {
    reasons.push(listHdr ? `ترويسة ${listHdr} — الرسالة من قائمة بريدية` : "ترويسة precedence: bulk — إرسال جماعي");
    return { kind: "newsletter", confidence: 0.85, reasons };
  }

  // ٤ · طلب وظيفة: يُقرأ قبل كل شيء آخر، فهو لا يشبه الإعلان ولا الرد.
  if (JOB.test(hay) || (CV_LIKE.test(hay) && !OFFER.test(hay))) {
    reasons.push(JOB.test(hay)
      ? "الرسالة طلب وظيفة صريح — لا عميل ولا إزعاج"
      : "الرسالة سيرة ذاتية: كاتبها يصف مؤهلاته هو، ولا يَعرض خدمةً على الشركة");
    return { kind: "job_application", confidence: JOB.test(hay) ? 0.85 : 0.7, reasons };
  }

  // ٥ · البوابة: مفتاحان، لا مفتاح واحد.
  //
  //     سجل الإرسال وحده لم يكفِ: الشركة تراسل بعض عملائها بيدها من
  //     بريدها، فيأتي ردٌّ حقيقي لا سجلَّ له عندنا. فالمفتاح الثاني هو
  //     لغة المستلم نفسها — شكرٌ على شيءٍ وصله، ووعدٌ بالمراجعة والعودة —
  //     مع غياب لغة العرض. من يبيع لنا لا يكتب هذا أبداً، والعشرات من
  //     رسائل السيو في هذا الصندوق تثبتها: كلها تَعرض، ولا واحدة تَشكر.
  const offers = OFFER.test(hay), topic = PITCH_TOPIC.test(hay), priced = PRICE_LIST.test(hay);
  const recipientSide = RECIPIENT_SIDE.test(hay) && !offers && !topic;

  if (!solicited && recipientSide) {
    reasons.push("لا سجلَّ إرسالٍ لهذا العنوان، لكن الرسالة مكتوبة من مقعد المستلم: تشكر على عرضٍ وصلها وتَعِد بالمراجعة — ولا فيها عرضٌ علينا");
    reasons.push("يرجَّح أن العرض أُرسل بيد الشركة من خارج النظام");
    return { kind: "reply", confidence: 0.7, reasons };
  }

  if (!solicited) {
    reasons.push("لم نرسل إلى هذا العنوان شيئاً — فهذه ليست رداً علينا");
    if (offers || topic || priced) {
      if (topic) reasons.push("موضوعها خدمةٌ تُعرض علينا (سيو، تصميم، تسويق، برمجة)");
      if (offers) reasons.push("صيغتها صيغة عارضٍ لا سائل: «نحن نقدّم / خدماتنا / أود أن أعرض»");
      if (priced) reasons.push("فيها قائمة أسعار أو خطة شهرية");
      return { kind: "cold_pitch", confidence: topic && offers ? 0.9 : 0.75, reasons };
    }
    if (MARKETING_BULK.test(hay)) {
      reasons.push("فيها رابط إلغاء اشتراك أو «عرض في المتصفح» — رسالة تسويقية");
      return { kind: "newsletter", confidence: 0.7, reasons };
    }
    if (FREEMAIL.test(from)) reasons.push("عنوانٌ مجاني لا بريد شركة");
    return { kind: "spam", confidence: 0.6, reasons };
  }

  // ٦ · راسلناهم وردّوا، وليس آلة ولا ارتداداً: ردٌّ حقيقي.
  //     يبقى احتمالٌ واحد — راسلناهم فردّوا يعرضون علينا خدماتهم. ولا
  //     يُسقَط الردّ إن كان فيه لغة مستلمٍ أيضاً: من يشكر على عرضنا ثم
  //     يذكر خدماته عميلٌ يتحدث، لا بائعاً يطرق الباب.
  if (offers && topic && !RECIPIENT_SIDE.test(hay)) {
    reasons.push("راسلناهم، لكن ردّهم عرضٌ لخدماتهم علينا لا رداً على عرضنا");
    return { kind: "cold_pitch", confidence: 0.65, reasons };
  }
  reasons.push("شخصٌ يردّ على رسالةٍ أرسلناها");
  return { kind: "reply", confidence: 0.8, reasons };
}

// ── نيّة ردّ البريد ───────────────────────────────────────────────
// مصنّف الواتساب لم يُبنَ لهذا. مفرداته سبع — مهتم، سؤال، اعتراض،
// تحية… — وهي كافية لمحادثةٍ قصيرة بالعربية على الهاتف، وعاجزة عن بريد
// عملٍ إنجليزيٍّ رسمي: أعطى ردّ المزروعي «unclear» بثقة ٠٫٢، وهو من
// أوضح ما يُكتب — عرضٌ وصل، سيُراجع داخلياً، وسيعودون. ولا يميّز الفرق
// الذي تُبنى عليه المتابعة كلها: بين «لسنا مهتمين» و«ليس الآن» و«أنا
// لست الشخص المناسب» و«أرسلها لقسم الحسابات». الأول يُغلق الملف،
// والثاني يُؤجَّل، والثالث يُغيَّر فيه العنوان، والرابع يفتح باباً أوسع.

export type EmailIntent =
  | "interested"    // يريد التقدّم: سعر، موعد، عرض مفصّل
  | "question"      // سؤال محدّد يحتاج جواباً
  | "considering"   // وصل، تحت المراجعة الداخلية، سيعودون — يُتابَع بموعد
  | "later"         // ليس الآن، ومعه وقت: بعد التدقيق، الربع القادم
  | "referral"      // حوّلنا إلى شخصٍ أو قسمٍ آخر — باب أوسع لا رفض
  | "wrong_person"  // لست الشخص المناسب / غادرت الشركة
  | "not_interested"
  | "opt_out"
  | "complaint"
  | "greeting"
  | "unclear";

const E_COMPLAINT = /(this is spam|report(ing)? (you|this) (as |to )?(spam|abuse)|how did you get my (e-?mail|data)|gdpr|unsolicited|legal action|شكوي|سابلغ|من اين (حصلتم|اخذتم) بريدي)/i;
const E_NOT_INT   = /(not interested|we are not interested|no thank you|we('ll| will) pass|not (looking|a fit|relevant) (for us|at the moment)?|we (already|currently) (have|work with|use) (a|an|our)|we have (our own|an in-?house)|غير مهتم|لسنا مهتمين|لدينا بالفعل|نتعامل مع)/i;
const E_WRONG     = /(i(?:'m| am) not the (right|correct) (person|contact)|wrong (person|department|address)|no longer (with|at) (the )?(company|this)|i have left|has left the company|please (contact|reach) (the|our) [a-z ]{3,30} (department|team|manager)|لست الشخص المناسب|لم اعد اعمل)/i;
const E_REFERRAL  = /(forward(ed|ing)? (it |this |your (e-?mail|proposal) )?to (our|the|my) [a-z ]{2,30}|(please )?(contact|reach out to|speak (to|with)|send it to) (our|my|the) [a-z ]{2,30} (at |on )?[a-z0-9._%+-]*@|cc(?:'?ing|ed) (my|our)|copying (in )?(my|our)|حولت(ها)? الي|راسلوا قسم|علي بريد زميلي)/i;
const E_LATER     = /(not (right )?now|later (this|next) (year|quarter|month)|after (the|our) (audit|year[- ]end|ramadan|budget|q[1-4])|get back to (you|us) (next|in) (week|month|quarter|year)|revisit (this )?(in|next)|circle back (in|next)|budget(s)? (open|reset) (in|next)|ليس الان|لاحقا|بعد (التدقيق|رمضان|نهايه السنه)|الربع (القادم|المقبل))/i;
const E_INTEREST  = /(interested|please send (me |us )?(the |your )?(proposal|quot|price|pricing|details|fee|more)|how much|what (is|are) (the|your) (price|pricing|fee|cost|rate)|(book|schedule|set up|arrange) (a )?(call|meeting|demo)|when (are|can) you (available|free)|let('s| us) (talk|meet|discuss|proceed)|(we|i) would like to (proceed|start|engage|sign)|send (us |me )?(the )?(contract|engagement|agreement)|مهتم|ارسل(وا)? (لي |لنا )?(العرض|السعر|التفاصيل)|كم (السعر|التكلفه)|نريد (البدء|البدا|التعاقد)|موعد)/i;
const E_CONSIDER  = /((we|i) (will|shall|'ll) (review|study|go through|discuss|consider|check) (it|this|the|your|these|internally)|under (review|consideration|discussion)|revert (back )?to you|get back to you (shortly|soon|once|after|internally)|keep (it |this |your details )?on (file|record)|noted (with thanks)?|will (share|pass) (it )?internally|سنراجع|سندرس|تحت الدراسه|سنعود اليكم|سنرد عليكم)/i;
const E_GREETING  = /^(hi|hello|dear|good (morning|afternoon|day)|thanks?|thank you|noted|ok(ay)?|received|مرحبا|السلام عليكم|شكرا|تم)[\s.,!]*$/i;

/**
 * نيّة ردٍّ حقيقي، بالقواعد. الترتيب هو الحكم: ما يُغلق الباب يُقرأ قبل
 * ما يفتحه، وإلا صار «لسنا مهتمين، لكن أرسلوا السعر لاحقاً» اهتماماً.
 */
export function emailIntent(subject: string | null | undefined, text: string | null | undefined): { intent: EmailIntent; confidence: number; matched: string[] } {
  const body = (text ?? "").trim();
  const hay = normalizeAr(`${subject ?? ""}\n${body}`);
  const hit = (re: RegExp) => re.exec(hay)?.[0]?.slice(0, 40) ?? null;
  const tests: Array<[EmailIntent, RegExp, number]> = [
    ["opt_out", E_OPT_OUT, 0.95], ["complaint", E_COMPLAINT, 0.9],
    ["wrong_person", E_WRONG, 0.85], ["not_interested", E_NOT_INT, 0.85],
    ["referral", E_REFERRAL, 0.8], ["later", E_LATER, 0.8],
    ["interested", E_INTEREST, 0.8], ["considering", E_CONSIDER, 0.75],
  ];
  for (const [intent, re, c] of tests) {
    const m = hit(re);
    if (m) return { intent, confidence: c, matched: [m] };
  }
  if (E_GREETING.test(body) || body.length < 12) return { intent: "greeting", confidence: 0.6, matched: [] };
  if (/\?|؟/.test(body)) return { intent: "question", confidence: 0.55, matched: ["علامة استفهام"] };
  return { intent: "unclear", confidence: 0.3, matched: [] };
}

/** النيّات التي يفهمها باقي النظام — الحرارة، والرد التلقائي، وبطاقة العميل. */
export function toSharedIntent(i: EmailIntent): Intent {
  switch (i) {
    case "considering": case "later": case "referral": return "interested";
    case "wrong_person": return "unclear";
    case "interested": case "question": case "greeting":
    case "not_interested": case "opt_out": case "complaint": case "unclear": return i;
  }
}

/** بالعربية لصاحب العمل، ومعها ما يجب فعله. */
export const INTENT_AR: Record<EmailIntent, { label: string; next: string }> = {
  interested:     { label: "مهتم", next: "ردّ اليوم بالسعر أو بموعد — لا تؤجّل" },
  question:       { label: "سؤال", next: "أجب على سؤاله بالتحديد، ثم اطلب خطوة" },
  considering:    { label: "تحت المراجعة", next: "لا تُلِحّ — تابِع بعد ٥ أيام بسؤال عن نتيجة المراجعة" },
  later:          { label: "ليس الآن", next: "سجّل الموعد الذي ذكره وتابِع فيه، ولا ترسل قبله" },
  referral:       { label: "حوّلنا لغيره", next: "راسل الشخص الذي ذكره، واشكر من حوّلك" },
  wrong_person:   { label: "ليس الشخص المناسب", next: "اسأله عن المسؤول، وغيّر العنوان في القائمة" },
  not_interested: { label: "غير مهتم", next: "أوقف المتابعة — واحترم الرفض" },
  opt_out:        { label: "طلب الإيقاف", next: "أُلغي اشتراكه فوراً" },
  complaint:      { label: "شكوى", next: "لا رد آلي — هذه لصاحب العمل بنفسه" },
  greeting:       { label: "تحية", next: "ردّ قصير ثم اطرح سؤال التأهيل" },
  unclear:        { label: "غير واضح", next: "اقرأها بنفسك قبل أي رد" },
};

/**
 * الحكم الكامل: نوعٌ أولاً، ثم — للرد الحقيقي وحده — نيّة.
 * لا تُستدعى النيّة لغير الرد: إعلانٌ «مهتم» هو ما صنع المشكلة كلها.
 */
export async function classifyMail(userId: number, input: ClassifyInput): Promise<MailVerdict & { matchedId: number | null; sentCount: number }> {
  const sol = await solicitation(userId, input);
  const k = kindOf(input, sol.solicited);
  if (sol.how) k.reasons.unshift(sol.how);

  const stop = asksToStop(input.subject, input.text);
  if (stop) k.reasons.push("يطلب أن نكفّ عن مراسلته — يُنفَّذ أياً كان نوع الرسالة");

  if (k.kind !== "reply") {
    return { ...k, asksToStop: stop, solicited: sol.solicited, intent: null, classifier: "rules", matchedId: sol.matchedId, sentCount: sol.sentCount };
  }
  const v = emailIntent(input.subject, input.text);
  k.reasons.push(`نيّة الرد: ${INTENT_AR[v.intent].label}${v.matched[0] ? ` («${v.matched[0]}»)` : ""}`);
  // `solicited` تبقى كما هي حقاً: ردٌّ عُرف بلغة المستلم دون سجل إرسالٍ
  // عندنا يبقى غير مُستدعى، وصاحب العمل يرى ذلك في سبب التصنيف.
  return {
    ...k, asksToStop: stop, solicited: sol.solicited, intent: v.intent, classifier: "rules",
    confidence: Math.max(k.confidence, v.confidence),
    matchedId: sol.matchedId, sentCount: sol.sentCount,
  };
}

/** بالعربية لصاحب العمل. */
export const KIND_AR: Record<MailKind, string> = {
  reply: "ردّ حقيقي", auto_reply: "ردّ آلي", bounce: "ارتداد",
  cold_pitch: "عرضٌ يُباع لنا", newsletter: "نشرة بريدية",
  job_application: "طلب وظيفة", spam: "إزعاج",
};

/** الأنواع التي يجوز أن تصبح عميلاً، أو صفقةً، أو إشعاراً بنار. */
export function mayBecomeLead(kind: MailKind): boolean { return kind === "reply"; }

/** الأنواع التي تُعرض في صندوق الوارد افتراضياً — ما يستحق وقت صاحب العمل. */
export const INBOX_DEFAULT: MailKind[] = ["reply"];
