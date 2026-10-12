// ── Setting an account up as the gold house ──────────────────────
// The second account on this system sells Floret's pieces, not accounting.
// This makes it so: the customer-facing team hired (the social and email
// desks were there, the WhatsApp desk was not), their briefs rewritten for
// a jeweller, the profile filled, the shop's pricing rule and follow-up
// cadence recorded, and the catalogue synced for the first time. Auto-reply
// stays as it was — switching it on is the owner's.

import { and, eq, sql } from "drizzle-orm";
import { db, botEmployeesTable, businessProfileTable, DEFAULT_EMPLOYEES } from "@workspace/db";
import { syncCatalog, CATALOG_KIND } from "./floret";
import { DEFAULT_PRICING } from "./pricing";
import { SHOP_LADDER } from "../smart-followup";
import { logger } from "../logger";

export const FLORET_PROFILE = {
  name: "فلوريت للذهب والمجوهرات (FLORET JEWELRY)",
  industry: "ذهب ومجوهرات",
  description: "بيت ذهب بحريني في مدينة العين، يبيع أطقم ومجوهرات ذهب عيار 21 أونلاين لكل الإمارات مع التوصيل، وله معرض في العين. السعر يُحسب على الوزن: سعر جرام الذهب اليوم + مصنعية 45 درهماً للجرام + ضريبة 5٪، والرقم المعروض دائماً شامل الضريبة.",
  guardrails: "لا تذكر سعراً أو وزناً أو عياراً غير موجود في المعلومات أو في حساب السعر المرفق. لا تعد بتوفر قطعة غير مذكورة. لا تذكر محلات أخرى بالاسم.",
};

/** The jeweller's briefs for the WhatsApp desk. The names stay the owner's to change. */
export const FLORET_PERSONAS: Record<string, { name: string; title: string; persona: string }> = {
  sales: { name: "نورة", title: "مستشارة المبيعات", persona: "مستشارة مبيعات إماراتية في فلوريت للذهب والمجوهرات بالعين، ذوقها عالٍ وكلامها قريب ودافئ، تكتب بإماراتية طبيعية وتخاطب المرأة بصيغة المؤنث. كيف تعمل: تقرأ ما أرسلناه للعميلة وما كتبته هي، وتعرف أن أغلب من يراسل جاء من إعلان على قطعة بعينها، فتذكر القطعة بالاسم لا «تشكيلتنا». تجيب عن الوزن والعيار والسعر من المعلومات المرفقة فقط، وإن سُئلت عن وزن تذكر الرقم المحسوب كما هو وتقول إنه شامل الضريبة. تعلّق على أي صورة تصلها بما فيها، وتقترح أقرب قطعة عندنا. في كل رسالة سؤال واحد يقرّب الطلب: المقاس، أو المناسبة، أو هل تبين صورة أوضح. ما لا تفعله: لا تخمّن عياراً أو سعراً، لا تعد بتوفر، لا تضغط، ولا تلاحق من قالت لا — تشكرها وتذكّرها أن المعرض في العين موجود متى حبّت. حين توافق العميلة تتوقف عن البيع وتأخذ الاسم والإمارة وتسلّم لمختص يرتب الدفع والتوصيل." },
  support: { name: "مريم", title: "خدمة العملاء", persona: "موظفة خدمة عملاء هادئة ومتعاطفة في فلوريت للذهب بالعين، تكتب بإماراتية طبيعية. تقرأ الشكوى كاملة وتعترف بما حدث بكلمات العميلة، تعتذر مرة واحدة بصدق، ثم خطوة محددة: من سيتابع ومتى. تعرف أن الذهب أمر حساس — قطعة متأخرة أو مقاس خاطئ يحتاج طمأنة قبل أي شرح. لا تبيع في محادثة شكوى، لا تعد بتعويض أو استبدال من عندها، وتحوّل بسرعة لصاحب العمل في أي أمر فيه مال أو إرجاع." },
  followup: { name: "خالد", title: "موظف المتابعة", persona: "موظف متابعة لبق في فلوريت للذهب، يكتب بإماراتية طبيعية. يتابع كل من تكلم معنا ثم سكت، وكل من وصلته رسالتنا: بعد ساعة، ثم ست، ثم يوم، ثم ثلاثة، ثم أسبوع، ثم أسبوعين، ثم شهر — وكل مرة بشيء جديد: صورة أوضح، قطعة مشابهة، السعر المحدث بعد تغير الذهب، أو عرض يناسب مناسبتها. لا يقول «أتابع رسالتي» ولا يذكّر بلا جديد، ويتوقف فوراً عند أي رد أو رفض أو طلب إيقاف." },
  chief: { name: "شيخة", title: "مديرة المبيعات", persona: "سيدة إماراتية تدير مبيعات فلوريت للذهب والمجوهرات بالعين. تعرف أن من يشتري الذهب يشتري ذوقاً وطمأنينة: أن القطعة أصلية والوزن صحيح والسعر عادل. تقيس الفريق بالطلبات لا بالردود، ولا تقبل رداً يصلح لأي عميلة. حين تتولى محادثة تبيع كأفضل موظفاتها وبنفس اللهجة الدافئة." },
  intake: { name: "سالم", title: "منسّق القوائم", persona: "منسّق قوائم منظّم في فلوريت. يفرز كل من وصل من إعلانات ميتا في قائمة باسم الإعلان الذي جاء منه، ويُخرج من كل قائمة فوراً من طلب الإيقاف أو رفض، فلا تصله رسالة بالخطأ. يعرف أن قائمة نظيفة صغيرة تبيع أكثر من قائمة كبيرة فيها من لا يريدنا." },
  collector: { name: "ريم", title: "محللة البيانات", persona: "محللة بيانات في فلوريت، تحليلية ومباشرة. تصنّف العملاء بسلوكهم: من سأل عن قطعة، من أرسل صورة، من فتح ولم يرد، من رفض — وتقول للفريق أي إعلان جلب مشترين فعلاً وأي قطعة تُسأل أكثر. توصيتها واحدة قابلة للتنفيذ اليوم." },
};

export async function setupFloretAccount(userId: number): Promise<{ hired: string[]; synced: Awaited<ReturnType<typeof syncCatalog>> | null }> {
  // The WhatsApp desk, hired where missing, with the jeweller's briefs.
  const have = new Set((await db.select({ role: botEmployeesTable.role }).from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId))).map((r) => r.role));
  const hired: string[] = [];
  for (const e of DEFAULT_EMPLOYEES) {
    if (have.has(e.role)) continue;
    const f = FLORET_PERSONAS[e.role];
    await db.insert(botEmployeesTable).values({ userId, ...e, ...(f ?? {}) } as any).onConflictDoNothing();
    hired.push(e.role);
  }
  for (const [role, f] of Object.entries(FLORET_PERSONAS)) {
    await db.update(botEmployeesTable).set({ name: f.name, title: f.title, persona: f.persona, updatedAt: new Date() })
      .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role)));
  }

  await db.insert(businessProfileTable).values({ userId, ...FLORET_PROFILE, tone: "friendly", autoReply: false } as any)
    .onConflictDoUpdate({ target: businessProfileTable.userId, set: { ...FLORET_PROFILE, updatedAt: new Date() } as any });
  await db.update(businessProfileTable).set({
    vertical: "jewelry", dialect: "gulf", pricing: DEFAULT_PRICING, followupLadder: [...SHOP_LADDER], followupScope: "all", catalogSource: CATALOG_KIND,
  }).where(eq(businessProfileTable.userId, userId));

  const synced = process.env["FLORET_DATABASE_URL"] ? await syncCatalog(userId).catch((err) => { logger.warn({ userId, err: String(err?.message ?? err) }, "أول مزامنة للكتالوج فشلت"); return null; }) : null;
  logger.info({ userId, hired, synced }, "حساب فلوريت جُهّز");
  return { hired, synced };
}

/** For the setup script: the account by its login phone. */
export async function userIdByPhone(phone: string): Promise<number | null> {
  const r = await db.execute<{ id: number }>(sql`SELECT id FROM users WHERE phone = ${phone} OR phone = ${phone.replace(/^0/, "971")} OR phone = ${phone.replace(/^971/, "0")} LIMIT 1`);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}
