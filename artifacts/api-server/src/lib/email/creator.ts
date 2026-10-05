// ── طارق: a whole campaign on request ─────────────────────────────
// The owner names a service and an audience; طارق builds the campaign — two
// subjects to test, the first email, a follow-up for those who open and do
// not reply and one for those who never open — in the language asked, with
// two of the firm's own templates for that service as examples of the voice.
// It becomes a mission that waits for the owner's approval like any other,
// so nothing goes out until the owner says so.

import { db, emailTemplatesTable, type SegmentFilter } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createMission, runMission } from "./missions";
import { count, describe } from "./segments";
import { activity, ensureEmailTeam } from "./team";
import { CONTACT } from "./procount-library";
import { logger } from "../logger";

export const SERVICES: Record<string, { label: string; category: string; goal: string }> = {
  about:           { label: "من نحن — تعريف بالشركة", category: "About us", goal: "تعريف ببروكاونت كشريك خارجي للمحاسبة والضرائب والامتثال: سجلات دقيقة ← تقارير موثوقة ← امتثال ضريبي ← رقابة مالية ← جاهزية تنظيمية." },
  accounting:      { label: "المحاسبة الخارجية ومسك الدفاتر", category: "Outsourced Accounting", goal: "المحاسبة الخارجية ومسك الدفاتر: دفاتر متأخرة، لا تقارير شهرية، صاحب العمل يدير المحاسبة بنفسه. الدعوة: نناقش حجم عملكم المحاسبي." },
  reporting:       { label: "التقارير المالية والإدارية", category: "Financial Reporting", goal: "التقارير المالية والإدارية: المبيعات ليست ربحاً — أين يُصنع الربح وأين تستهلكه التكاليف، التدفق النقدي، الذمم. الدعوة: نموذج تقارير إدارية شهرية." },
  construction:    { label: "تكاليف المشاريع للمقاولات والهندسة", category: "Construction & Engineering", goal: "محاسبة تكاليف المشاريع للمقاولين والهندسة: هل كل مشروع رابح فعلاً؟ تكلفة العمالة والمواد والمقاولين من الباطن والميزانية مقابل الفعلي." },
  restaurants:     { label: "محاسبة المطاعم والمقاهي", category: "Restaurants", goal: "محاسبة المطاعم: تكلفة الطعام والهدر والمخزون وربحية كل فرع — المبيعات ليست ربحاً." },
  corporate_tax:   { label: "ضريبة الشركات", category: "Corporate Tax", goal: "ضريبة الشركات: التسجيل، الإقرار خلال 9 أشهر من نهاية الفترة الضريبية، إعفاء الأعمال الصغيرة بشروطه، والسجلات 7 سنوات. الدعوة: نراجع وضعكم الضريبي." },
  vat:             { label: "ضريبة القيمة المضافة", category: "VAT", goal: "ضريبة القيمة المضافة: حد التسجيل الإلزامي AED 375,000، الإقرار خلال 28 يوماً، مستندات ضريبة المدخلات والتسويات. الدعوة: فحص سريع لوضع VAT." },
  einvoicing:      { label: "الفوترة الإلكترونية", category: "E-Invoicing", goal: "الفوترة الإلكترونية: الفاتورة الإلكترونية ليست PDF؛ مواعيد تعيين مزود الخدمة المعتمد والتطبيق بحسب الإيرادات. الدعوة: نقيّم جاهزيتكم." },
  aml:             { label: "الامتثال لمكافحة غسل الأموال (عام)", category: "AML Compliance", goal: "إطار AML بحسب المرسوم بقانون 10 لسنة 2025 ولائحته: تقييم المخاطر، العناية الواجبة، المستفيد الحقيقي، التدريب — والتسجيل في goAML ليس امتثالاً كاملاً. الدعوة: تقييم امتثال AML." },
  aml_real_estate: { label: "AML للوسطاء العقاريين", category: "Real Estate AML", goal: "AML للوكالات العقارية من فئات DNFBP: العناية الواجبة، المستفيد الحقيقي، مصدر الأموال، الإبلاغ، الجاهزية للتفتيش. الدعوة: نراجع جاهزيتكم لـ AML." },
  aml_gold:        { label: "الذهب والمجوهرات — DPMS", category: "Gold & Jewellery", goal: "تجار الذهب والمجوهرات: التزامات DPMS ومعاملات النقد 55,000 درهم فأكثر، مع محاسبة المخزون وتكلفة الجرام. الدعوة: نقيّم التزامات DPMS." },
  mlro:            { label: "مسؤول امتثال خارجي (MLRO)", category: "AML Compliance", goal: "دعم مسؤول امتثال خارجي للفئات الخاضعة: السياسات، المعرفة بالعميل، المراقبة، التدريب، دعم goAML — بحسب انطباق الالتزامات." },
};

const plain = (html: string) => html.replace(/<li>/g, "\n- ").replace(/<\/p>/g, "\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim();

export async function createWithCreator(userId: number, input: {
  service: string; language?: string; listIds?: number[]; folderIds?: number[]; sectors?: string[]; take?: number; notes?: string;
}): Promise<{ missionId: number; audience: number; description: string }> {
  const svc = SERVICES[input.service];
  if (!svc) throw new Error("اختر الخدمة");
  await ensureEmailTeam(userId);
  const filter: SegmentFilter = {
    ...(input.listIds?.length ? { listIds: input.listIds } : {}),
    ...(input.folderIds?.length ? { folderIds: input.folderIds } : {}),
    ...(input.sectors?.length ? { sectors: input.sectors } : {}),
    maxTouches: 3,
    ...(input.take ? { take: Math.min(2000, Math.max(10, Math.floor(input.take))) } : {}),
  };
  const n = await count(userId, filter, true);
  // Two of the firm's own templates for this service, as the voice to write in.
  const examples = await db.select().from(emailTemplatesTable)
    .where(and(eq(emailTemplatesTable.userId, userId), eq(emailTemplatesTable.category, svc.category))).limit(2);
  const notes = [
    input.notes?.trim() ? `تعليمات صاحب العمل لهذه الحملة: ${input.notes.trim()}` : "",
    `بيانات التواصل للدعوة: الهاتف وواتساب ${CONTACT.phone}، الموقع ${CONTACT.websiteLabel}.`,
    examples.length ? `أمثلة من مكتبة قوالب الشركة لهذه الخدمة — استلهم الأسلوب والبنية ولا تنسخها:\n${examples.map((t) => `العنوان: ${t.subject}\n${plain(t.html).slice(0, 900)}`).join("\n---\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const m = await createMission(userId, {
    name: `${svc.label} — ${new Date().toLocaleDateString("en-GB")}`.slice(0, 160),
    goal: `${svc.goal}\n\n${notes}`, filter, language: input.language, requireApproval: true, agentRole: "email_creator",
  });
  await activity(userId, "email_creator", "create", `بدأ بناء حملة «${svc.label}» لـ ${n} شركة (${describe(filter)}) — تنتظر موافقتك حين تُكتب.`, { missionId: m.id });
  // He writes now rather than at the next round, so the owner can read it in a minute.
  void runMission(m).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "creator write failed"));
  return { missionId: m.id, audience: n, description: describe(filter) };
}
