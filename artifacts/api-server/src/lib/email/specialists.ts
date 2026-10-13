// ── الأربعة يعملون ────────────────────────────────────────────────
// موظفٌ بشخصيةٍ وتعليماتٍ بلا أرقام يؤلّف. وقد رأينا ذلك في هذا النظام
// نفسه: مديرُ إنستجرام أعلن في اجتماعٍ أن الحساب «قُيّد بعد خمس
// تحذيرات» — ولم يكن الحساب قد سُجّل دخوله أصلاً — فبنى ثلاثة من
// زملائه خطّةً على حادثةٍ لم تقع.
//
// فلكل واحدٍ من هؤلاء الأربعة ملفُّ وقائعه، ولا يُعطى غيره:
//   راشد  → reconcile()      ثمانية فحوص مطابقة
//   بدور  → dataPicture()    الحالات والجودة
//   مريم  → retargetPlans()  الخطط والمؤهّل منها
//   حصّة  → opensReport()     العنوان والساعة والقطاع
//
// وثلاثة قيودٍ على كل واحد: لا رقم ليس في وقائعه، ولا حدث لم يُذكر
// فيها، وإن كان رقمه غائباً لأن القياس معطَّل قال ذلك ولم يحلّله.

import { and, desc, eq, sql } from "drizzle-orm";
import { db, emailAgentActivityTable } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { notify, esc } from "../telegram";
import { logger } from "../logger";
import { activity, onDuty, teamVoice, type EmailRole } from "./team";
import { reconcile } from "./ledger";
import { dataPicture } from "./cohorts";
import { retargetPlans } from "./retarget";
import { opensReport } from "./opens";
import { trackingState } from "./public-url";
import { resultsReport, resultsFacts } from "./results";

export type SpecialistRole = "email_registrar" | "email_data" | "email_retarget" | "email_opens" | "email_analyst";

export const SPECIALISTS: Record<SpecialistRole, { name: string; title: string; question: string }> = {
  email_registrar: { name: "راشد", title: "أمين سجل الإرسال", question: "هل السجل صادق — وما التناقض الذي يجب إصلاحه اليوم؟" },
  email_data:      { name: "بدور", title: "أمينة تصنيف البيانات", question: "أين الداتا الآن، وأي عيبٍ فيها يكلّفنا ردوداً فعلاً؟" },
  email_retarget:  { name: "مريم", title: "أخصائية إعادة الاستهداف", question: "ما الموجة الواحدة التي تُرسل غداً، ولمن، وبأي زاوية؟" },
  email_opens:     { name: "حصّة", title: "محللة الفتح والتوقيت", question: "ما الذي يرفع الفتح والرد في الموجة القادمة بالتحديد؟" },
  email_analyst:   { name: "جاسم", title: "محلل النتائج", question: "ما الذي نفع مما أُرسل وما الذي لم ينفع — وأيّ زاويةٍ تُوسَّع وأيّها يُعاد كتابته؟" },
};

/** وقائع كل أخصائي — نصاً مضغوطاً، فالمزوّد المجاني يعطي ٨٠٠٠ رمزاً في الدقيقة. */
export async function factsFor(userId: number, role: SpecialistRole): Promise<{ text: string; raw: unknown }> {
  switch (role) {
    case "email_registrar": {
      const r = await reconcile(userId);
      return {
        raw: r,
        text: [
          `حكم المطابقة: ${r.verdict}`,
          ...r.findings.map((f) => `• [${f.state === "fail" ? "خلل" : f.state === "warn" ? "ملاحظة" : "سليم"}] ${f.title}: ${f.detail}${f.means ? ` — ${f.means}` : ""}`),
        ].join("\n"),
      };
    }
    case "email_data": {
      const p = await dataPicture(userId);
      return {
        raw: p,
        text: [
          `المجموع: ${p.total} جهة. ${p.headline}`,
          `قابلة للمراسلة ${p.summary.reachable} · لُمست ${p.summary.touched} · لم تُلمَس ${p.summary.untouched} · مُغلقة ${p.summary.closed} · دافئة ${p.summary.warm}`,
          "الحالات:",
          // ويُقال صريحاً ما يُستبعَد تلقائياً: أول تقريرٍ من بدور قال إن
          // ٩٣٠ نطاقاً «يهدّد بإيقاف الإرسال» وهي مُستبعَدة من كل موجةٍ
          // أصلاً. المحلّل يبالغ فيما لا يعرف أنه محسوم.
          ...p.counts.filter((c) => c.n > 0).map((c) =>
            `• ${c.info.label}: ${c.n} — ${c.info.next}${c.info.retarget ? "" : " [مُستبعَدة من كل موجة تلقائياً — لا تطلب استبعادها]"}`),
          "جودة الصفوف:",
          ...p.quality.flags.slice(0, 7).map((f) => `• ${f.label}: ${f.n} — ${f.why}`),
        ].join("\n"),
      };
    }
    case "email_retarget": {
      const r = await retargetPlans(userId);
      return {
        raw: r,
        text: [
          r.headline,
          ...r.plans.map((p) => `• ${p.label}: ${p.eligible} مؤهّلة من ${p.inCohort}${p.blocked ? ` — ${p.blocked}` : ""}${p.excluded.length ? ` (يُستبعَد: ${p.excluded.map((x) => `${x.reason} ${x.n}`).join("، ")})` : ""}. الزاوية: ${p.angle.why} الدعوة: ${p.angle.cta}`),
          r.excludedCohorts.length ? `لا تُمسّ: ${r.excludedCohorts.map((x) => `${x.label} ${x.n}`).join("، ")}.` : "",
        ].filter(Boolean).join("\n"),
      };
    }
    case "email_analyst": {
      const r = await resultsReport(userId);
      return { raw: r, text: resultsFacts(r) };
    }
    case "email_opens": {
      const o = await opensReport(userId);
      return {
        raw: o,
        text: [
          o.measurable ? "الفتح يُقاس." : `الفتح لا يُقاس: ${o.blocker}`,
          `خرجت ${o.totals.sent} · فُتحت ${o.totals.opened} (${o.totals.openRate}٪) · نُقر ${o.totals.clicked} · ردّوا ${o.totals.replied} (${o.totals.replyRate}٪)${o.totals.proxied ? ` · منها ${o.totals.proxied} فتحة من وسيطٍ آلي لا من إنسان` : ""}`,
          o.subjects.length ? "قوالب العناوين (٣٠ رسالة على الأقل لكل واحد):" : "لا قالب عنوانٍ بلغ ثلاثين رسالة بعد — فلا مقارنة.",
          ...o.subjects.slice(0, 6).map((s) => `• «${s.subject.slice(0, 70)}» — ${s.sent} رسالة، فتح ${s.rate}٪، ردّ ${s.replied}`),
          "الساعات (بتوقيت الإمارات):",
          ...o.hours.filter((h) => h.sent > 0).map((h) => `• ${h.hour}:00 — ${h.sent} رسالة، فتح ${h.opened}، ردّ ${h.replied}`),
          o.sectors.length ? `القطاعات: ${o.sectors.map((s) => `${s.sector} (${s.sent} رسالة، ${s.replied} ردّ)`).join("، ")}` : "",
          "ما يراه المحرّك:",
          ...o.actions.map((a) => `• ${a}`),
        ].filter(Boolean).join("\n"),
      };
    }
  }
}

const LIMITS = [
  "قيودٌ ثلاثة لا تُخالف:",
  "١. لا رقم ولا نسبة ولا حالة ولا حادثة ليست في «وقائعك» أعلاه. إن احتجت رقماً ولم تجده فقل إنه غير متاح.",
  "٢. إن كان رقمٌ صفراً لأن قياسه معطَّل فقل ذلك صريحاً ولا تحلّله ولا تبنِ عليه توصية. الصفر الناتج عن غياب القياس ليس نتيجة.",
  "٣. لا تقترح على صاحب العمل ما لا يستطيع فعله غداً. «حسّن الأداء» ليست توصية.",
].join("\n");

const SHAPE = [
  "اكتب بهذا الشكل بالضبط، ولا تزد عليه:",
  "الحكم: <سطر واحد — ما حالة مجالك اليوم بالأرقام>",
  "الأهم: <سطر واحد — الشيء الواحد الذي لو لم يُفعل غداً خسرنا>",
  "التفاصيل:",
  "- <ثلاث إلى خمس نقاط، كل واحدة برقمٍ من وقائعك>",
  "الخطوة: <جملة واحدة تنفيذية لصاحب العمل>",
].join("\n");

export interface SpecialistReport {
  role: SpecialistRole;
  name: string;
  verdict: string;
  top: string;
  points: string[];
  step: string;
  raw: unknown;
}

/** دورة أخصائيٍّ واحد: وقائعه، ثم حكمه عليها، ثم تسجيله. */
export async function runSpecialist(userId: number, role: SpecialistRole, opts: { notifyOwner?: boolean } = {}): Promise<SpecialistReport | null> {
  if (!(await onDuty(userId, role))) {
    logger.info({ userId, role }, "أخصائي موقوف — تُخطّى دورته");
    return null;
  }
  const spec = SPECIALISTS[role];
  const [voice, facts] = await Promise.all([teamVoice(userId, role), factsFor(userId, role)]);

  const out = await asAgent(userId, role, () => complete([
    { role: "system", content: [voice, "", LIMITS, "", SHAPE].join("\n") },
    { role: "user", content: [`السؤال: ${spec.question}`, "", "وقائعك اليوم:", facts.text].join("\n") },
  ], 60_000));

  if (!out?.text) {
    logger.warn({ userId, role }, "الأخصائي لم يستجب");
    return null;
  }
  const grab = (re: RegExp) => re.exec(out.text)?.[1]?.trim() ?? "";
  const verdict = grab(/الحكم\s*[:：]\s*(.+)/);
  const top = grab(/الأهم\s*[:：]\s*(.+)/);
  const step = grab(/الخطوة\s*[:：]\s*([\s\S]+?)(?:\n\n|$)/);
  const points = (/التفاصيل\s*[:：]\s*\n([\s\S]*?)(?=\nالخطوة|$)/.exec(out.text)?.[1] ?? "")
    .split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter((l) => l.length > 3).slice(0, 6);

  const report: SpecialistReport = { role, name: spec.name, verdict, top, points, step, raw: facts.raw };

  await activity(userId, role as EmailRole, "report",
    [verdict, top ? `الأهم: ${top}` : "", ...points.map((p) => `• ${p}`), step ? `الخطوة: ${step}` : ""].filter(Boolean).join("\n"),
    { points: points.length }).catch(() => {});

  if (opts.notifyOwner && (verdict || top)) {
    await notify(userId, [
      `<b>${esc(spec.name)}</b> — ${esc(spec.title)}`,
      verdict ? esc(verdict) : "",
      top ? `<b>الأهم:</b> ${esc(top)}` : "",
      ...points.slice(0, 4).map((p) => `• ${esc(p)}`),
      step ? `<b>الخطوة:</b> ${esc(step)}` : "",
    ].filter(Boolean).join("\n")).catch(() => {});
  }
  logger.info({ userId, role, points: points.length }, "تقرير أخصائي");
  return report;
}

/**
 * الأربعة بالترتيب الذي يخدم بعضه: بدور تصنّف، ثم مريم تبني على
 * تصنيفها، ثم حصّة تقرأ ما يرفع الفتح، ثم راشد يتحقّق أن السجل صادق.
 * بفاصلٍ بينهم، فالمزوّد المجاني محدودٌ بالدقيقة.
 */
export const SPECIALIST_ORDER: SpecialistRole[] = ["email_analyst", "email_data", "email_retarget", "email_opens", "email_registrar"];

export async function runSpecialistRound(userId: number, opts: { notifyOwner?: boolean; gapMs?: number } = {}): Promise<SpecialistReport[]> {
  const out: SpecialistReport[] = [];
  for (const role of SPECIALIST_ORDER) {
    try {
      const r = await runSpecialist(userId, role, { notifyOwner: opts.notifyOwner });
      if (r) out.push(r);
    } catch (err: any) {
      logger.warn({ userId, role, err: String(err?.message ?? err) }, "تعذّرت دورة أخصائي");
    }
    if (role !== SPECIALIST_ORDER[SPECIALIST_ORDER.length - 1]) {
      // ٨٠٠٠ رمزاً في الدقيقة على الحساب المجاني، والنداء الواحد نحو
      // ألفٍ وثمان مئة. فخمسٌ وستون ثانية بين اثنين تمرّ، وعشرون لا تمرّ:
      // أول تجربةٍ بعشرين ثانية ردّ عليها المزوّد بـ429 مرتين.
      await new Promise((r) => setTimeout(r, opts.gapMs ?? 65_000));
    }
  }
  return out;
}

/** آخر تقرير لكل أخصائي — تقرؤه الواجهة بلا استدعاء نموذج. */
export async function lastReports(userId: number) {
  const r = await db.execute<any>(sql`
    SELECT DISTINCT ON (role) role, text, created_at AS "at"
    FROM email_agent_activity
    WHERE user_id = ${userId} AND action = 'report'
      AND role IN ('email_registrar','email_data','email_retarget','email_opens','email_analyst')
    ORDER BY role, created_at DESC`);
  const rows = ((r as any).rows ?? r) as any[];
  return (Object.keys(SPECIALISTS) as SpecialistRole[]).map((role) => {
    const hit = rows.find((x) => x.role === role);
    return { role, ...SPECIALISTS[role], text: hit?.text ?? null, at: hit?.at ?? null };
  });
}

/** جولةٌ يومية واحدة، بعد أن يستقرّ الإرسال. */
export function startSpecialistRounds(): void {
  const DAY = 24 * 3_600_000;
  const run = async () => {
    const rows = await db.execute<any>(sql`SELECT user_id FROM email_settings WHERE from_email IS NOT NULL`);
    for (const u of ((rows as any).rows ?? rows) as any[]) {
      // مع مديرٍ على رأس العمل يصل صاحبَ العمل صوتٌ واحد في اليوم: تقريره.
      // وتقارير المتخصّصين تبقى في الواجهة لمن أراد التفصيل. ستُّ رسائل
      // يومياً تُقرأ أولاها وتُكتم الباقية.
      const managed = await onDuty(Number(u.user_id), "email_manager").catch(() => false);
      await runSpecialistRound(Number(u.user_id), { notifyOwner: !managed }).catch(() => {});
    }
  };
  // أول جولةٍ بعد ثلاث دقائق من الإقلاع، ثم كل يوم.
  setTimeout(() => { void run(); setInterval(() => void run(), DAY); }, 180_000);
  logger.info("جولة أخصائيي البريد اليومية مُجدولة");
}
