// ── The ready-made AML outreach for بروكاونت ─────────────────────
// What a firm selling AML compliance to UAE companies sends: an opening
// that names the obligation and asks one question, a second that explains
// what compliance actually involves, and a third that offers a way out of
// the thread. Installed on the first configured account; re-seeding never
// overwrites a sequence or template the owner has edited.
//
// Everything firm-specific — fees, address, the consultant's name — is a
// bracketed placeholder the owner fills in. Nothing here states a penalty
// amount or a deadline: those are the owner's to write from the current
// rules, not this file's to guess.

import { and, eq } from "drizzle-orm";
import { db, emailSequencesTable, emailTemplatesTable, type EmailStep } from "@workspace/db";
import { seedLibrary2 } from "./library-2";
import { logger } from "../logger";

export const DEFAULT_SEQUENCE_NAME = "الامتثال لمكافحة غسل الأموال — تعريف ومتابعة";

const P = (s: string) => `<p style="margin:0 0 14px">${s}</p>`;
const UL = (items: string[]) => `<ul style="margin:0 0 14px;padding-right:22px">${items.map((i) => `<li style="margin:4px 0">${i}</li>`).join("")}</ul>`;

const STEP1: EmailStep = {
  afterHours: 0,
  subject: "{{company|شركتكم}} والتزامات مكافحة غسل الأموال في الإمارات",
  html: [
    P("السلام عليكم {{first_name|أهلاً بكم}}،"),
    P("أنا {{sender}} من <b>بروكاونت للمحاسبة</b>. نساعد الشركات في الإمارات على الالتزام بمتطلبات مكافحة غسل الأموال وتمويل الإرهاب دون أن يتحوّل الأمر إلى عبء يومي."),
    P("إن كان نشاطكم من الأنشطة المصنّفة (عقارات، ذهب ومجوهرات، مدققون ومحاسبون، خدمات الشركات، تجارة أو أنشطة مالية)، فهناك التزامات تسجيل وتعيين مسؤول امتثال وتقييم مخاطر وإجراءات تعرّف على العملاء وإبلاغ عن المعاملات المشبوهة — وعدم الالتزام بها له عواقب تنظيمية ومالية."),
    P("سؤال واحد يوفّر علينا الاثنين وقتاً: <b>هل لديكم حالياً مسؤول امتثال معيّن وتقييم مخاطر مكتوب؟</b>"),
    P("إن كانت الإجابة لا، أو لستم متأكدين، فمكالمة عشر دقائق تكفي لنعرف أين تقفون بالضبط."),
    P("مع التحية،<br>{{sender}}<br>بروكاونت للمحاسبة<br>[رقم الهاتف] · [الموقع الإلكتروني]"),
  ].join(""),
};

const STEP2: EmailStep = {
  afterHours: 72,
  subject: "ما الذي يعنيه الامتثال فعلاً — بلا مصطلحات",
  html: [
    P("{{first_name|أهلاً}}،"),
    P("كتبت لكم قبل أيام عن التزامات مكافحة غسل الأموال. أغلب من نكلّمهم يظنون أن الأمر «سياسة نطبعها ونضعها في الدرج». هو في الواقع خمسة أشياء ملموسة:"),
    UL([
      "<b>التسجيل</b> في نظام الإبلاغ الرسمي، وتحديث بياناتكم فيه.",
      "<b>مسؤول امتثال</b> معيّن باسمه، يعرف ما عليه ومتى.",
      "<b>تقييم مخاطر</b> مكتوب لنشاطكم وعملائكم ومناطقكم الجغرافية.",
      "<b>إجراءات التعرّف على العملاء</b> (KYC/CDD) موثّقة ومطبّقة، وسجلات محفوظة للمدة المطلوبة.",
      "<b>إبلاغ</b> عن المعاملات المشبوهة ضمن المهل، وتدريب للموظفين.",
    ]),
    P("نحن نبني هذه الخمسة لكم ونشغّلها معكم: التسجيل، السياسات، تعيين مسؤول الامتثال أو تقديم الخدمة بالإنابة، والمراجعة الدورية. [أدرج هنا ما يميّز باقتكم: مدة التنفيذ، ما يشمله السعر، من يتابع بعد التسليم.]"),
    P("<b>هل أرسل لكم قائمة المستندات التي نحتاجها للبدء؟</b> هي قصيرة."),
    P("مع التحية،<br>{{sender}}<br>بروكاونت للمحاسبة"),
  ].join(""),
};

const STEP3: EmailStep = {
  afterHours: 168,
  subject: "آخر رسالة مني عن الامتثال",
  html: [
    P("{{first_name|أهلاً}}،"),
    P("لن أزعجكم أكثر من هذا. إن لم يكن موضوع مكافحة غسل الأموال أولوية الآن فأتفهم تماماً، وأترك لكم رابط التواصل حين يحين وقته."),
    P("وإن كان ما يمنعكم هو السعر أو الوقت، فاكتبوا لي كلمة واحدة وسأقترح ترتيباً يناسبكم — نبدأ بالتسجيل وتقييم المخاطر ونؤجّل الباقي."),
    P("[رابط حجز مكالمة] · [رقم الواتساب]"),
    P("مع التحية،<br>{{sender}}<br>بروكاونت للمحاسبة"),
  ].join(""),
};

const TEMPLATES: Array<{ name: string; subject: string; html: string; category: string }> = [
  { name: "AML — الرسالة الأولى", subject: STEP1.subject, html: STEP1.html, category: "AML" },
  { name: "AML — ما يعنيه الامتثال", subject: STEP2.subject, html: STEP2.html, category: "AML" },
  { name: "AML — الرسالة الأخيرة", subject: STEP3.subject, html: STEP3.html, category: "AML" },
  {
    name: "AML — English opener", category: "AML",
    subject: "AML compliance obligations for {{company|your company}} in the UAE",
    html: [
      P("Dear {{first_name|Sir/Madam}},"),
      P("I'm {{sender}} from <b>Pro Count Accounting</b>. We help UAE businesses meet their anti-money-laundering obligations without it becoming a daily burden."),
      P("If your activity is a designated one — real estate, gold and jewellery, auditing and accounting, corporate services, trading or financial activities — you are expected to register with the reporting authority, appoint a compliance officer, keep a written risk assessment, apply customer due diligence and report suspicious transactions. Non-compliance carries regulatory and financial consequences."),
      P("One question saves us both time: <b>do you currently have a named compliance officer and a written risk assessment?</b>"),
      P("If not, or if you are not sure, a ten-minute call is enough to tell exactly where you stand."),
      P("Kind regards,<br>{{sender}}<br>Pro Count Accounting<br>[phone] · [website]"),
    ].join(""),
  },
  {
    name: "التسجيل في ضريبة الشركات", category: "ضرائب",
    subject: "{{company|شركتكم}} وضريبة الشركات — هل التسجيل مكتمل؟",
    html: [
      P("{{first_name|أهلاً بكم}}،"),
      P("أنا {{sender}} من بروكاونت للمحاسبة. كثير من الشركات التي نكلّمها إما لم تسجّل بعد في ضريبة الشركات أو سجّلت ولا تعرف ما المطلوب منها بعد التسجيل."),
      P("سؤال واحد: <b>هل استلمتم شهادة التسجيل، ومن يتابع الإقرار الأول؟</b>"),
      P("إن كان الجواب غير واضح، فمكالمة قصيرة تكفي لنرتّب لكم الخطوات بالترتيب الصحيح."),
      P("مع التحية،<br>{{sender}}<br>بروكاونت للمحاسبة"),
    ].join(""),
  },
];

/** Install the sequence and the templates. `force` re-adds anything missing; nothing edited is touched. */
export async function seedEmailDefaults(userId: number, force = false): Promise<{ sequence: boolean; templates: number }> {
  let sequence = false, templates = 0;
  // المكتبة الثانية تُزرع دائماً بالاسم: قوالبها جديدة، ومن زُرع حسابه
  // قبل وجودها يأخذها الآن — ولا تُكرَّر ولا تمسّ ما عدّله صاحب العمل.
  const lib2 = await seedLibrary2(userId).catch(() => ({ added: 0 }));
  templates += lib2.added;
  const [existing] = await db.select({ id: emailSequencesTable.id }).from(emailSequencesTable)
    .where(and(eq(emailSequencesTable.userId, userId), eq(emailSequencesTable.name, DEFAULT_SEQUENCE_NAME))).limit(1);
  if (!existing) {
    await db.insert(emailSequencesTable).values({ userId, name: DEFAULT_SEQUENCE_NAME, steps: [STEP1, STEP2, STEP3], stopOnReply: true, stopOnOpen: false, isActive: true });
    sequence = true;
  }
  const have = new Set((await db.select({ name: emailTemplatesTable.name }).from(emailTemplatesTable).where(eq(emailTemplatesTable.userId, userId))).map((t) => t.name));
  for (const t of TEMPLATES) {
    if (have.has(t.name)) continue;
    if (!force && have.size > 0 && !sequence) continue;
    await db.insert(emailTemplatesTable).values({ userId, ...t });
    templates++;
  }
  if (sequence || templates) logger.info({ userId, sequence, templates }, "قوالب البريد الجاهزة ثُبّتت");
  return { sequence, templates };
}
