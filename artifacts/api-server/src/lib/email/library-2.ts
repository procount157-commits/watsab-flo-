// ── القوالب الجديدة ───────────────────────────────────────────────
// المكتبة الأولى ستون قالباً، وبنيتها قصّةٌ تُقرأ من أعلى إلى أسفل:
// مقدمة، ثم شرح، ثم دعوة في الآخر. ثم تغيّرت عقيدة الفريق إلى بنيةٍ
// أخرى — «اقرأ ثلاثة أسطر وافهم كل شيء»: ملخّصٌ يُفهم وحده، ثم الزرّ
// مباشرةً تحته، ثم التفاصيل لمن أراد. والسبب أن المدير المالي يقرأ على
// هاتفه بين اجتماعين، ومن يصل إلى الدعوة في السطر العاشر لا يصل.
//
// فهذه القوالب مكتوبةٌ بالبنية الجديدة، وتملأ زوايا تركتها الأولى:
// جاهزية التدقيق، والدفاتر المتأخرة، والتدفق النقدي، والمناطق الحرة،
// والمجموعات، والمخزون، والعيادات، والتجارة الإلكترونية، والاستشارات،
// وgoAML، والمعرفة بالعميل.
//
// وليس فيها رقمٌ واحد. العقيدة تمنع اختراع رقمٍ أو مهلةٍ أو غرامة،
// والمكتبة الأولى تحمل أرقام صاحب العمل التي يملكها هو — فما يُضاف
// هنا يبيع بالسؤال الذي يعرف صاحب الشركة جوابه في نفسه، لا برقم.

import { and, eq, inArray } from "drizzle-orm";
import { db, emailTemplatesTable } from "@workspace/db";
import { logger } from "../logger";

const WA = (text: string) => `https://wa.me/971542328336?text=${encodeURIComponent(`Hello Pro Count, ${text}`)}`;

/** ملخّص ← زرّ ← تفاصيل. هذه هي البنية، ولا تُخالف. */
function tpl(o: { summary: string; cta: { label: string; ask: string }; points: string[]; note?: string }): string {
  return [
    `<p>Hello {{first_name|team}},</p>`,
    `<p>${o.summary}</p>`,
    `<p class="cta"><a href="${WA(o.cta.ask)}">${o.cta.label}</a></p>`,
    `<ul>${o.points.map((p) => `<li>${p}</li>`).join("")}</ul>`,
    o.note ? `<p>${o.note}</p>` : "",
    `<p>Best regards,<br>The Pro Count team</p>`,
  ].filter(Boolean).join("\n");
}

export interface NewTemplate { name: string; subject: string; category: string; html: string }

export const LIBRARY_2: NewTemplate[] = [
  // ── جاهزية التدقيق ──
  {
    name: "51 · Audit readiness — before it starts", category: "Outsourced Accounting",
    subject: "Will {{company|your}} books be ready when the auditor asks?",
    html: tpl({
      summary: "An audit rarely takes long because of the auditor. It takes long because every balance has to be supported after the fact — reconciliations, inventory counts, contracts, confirmations. We prepare {{company|your}} books so the auditor opens them and starts, rather than waiting on you.",
      cta: { label: "Check our audit readiness", ask: "I would like to check whether our books are ready for audit." },
      points: [
        "A review of your balances and what supports each one",
        "Reconciliations, schedules and the documents your auditor will request",
        "A short list of what is missing, in the order it should be fixed",
      ],
      note: "Most of the delay in an audit is assembled paperwork, not accounting judgement. It is far cheaper to prepare before the audit than during it.",
    }),
  },
  {
    name: "52 · Audit — last year's adjustments", category: "Outsourced Accounting",
    subject: "Did last year's audit adjustments change how {{company|you}} record things?",
    html: tpl({
      summary: "Auditors post adjustments at year end. If the bookkeeping afterwards carries on exactly as before, the same adjustments return next year — and the same questions with them. We check whether last year's findings were actually absorbed into how {{company|your}} books are kept.",
      cta: { label: "Review last year's adjustments", ask: "I would like a review of our audit adjustments and how they affected our bookkeeping." },
      points: [
        "What the auditor adjusted, and why",
        "Whether the treatment changed in your books or only in the audit file",
        "The entries that should be recorded differently from this month",
      ],
    }),
  },
  // ── الدفاتر المتأخرة ──
  {
    name: "53 · Books months behind", category: "Outsourced Accounting",
    subject: "{{company|Your}} books are behind — what gets caught up first?",
    html: tpl({
      summary: "Books that are months behind are not one problem but three: no reporting, no idea of real profit, and regulatory dates approaching with no figures to work from. Catching up in order matters more than catching up fast. We assess how far behind {{company|you}} are and what to do first.",
      cta: { label: "Assess the backlog", ask: "Our books are behind. I would like an assessment of the backlog." },
      points: [
        "How many months, and in which areas",
        "What must be done before the next filing date, and what can wait",
        "A realistic sequence — bank first, then sales, then costs",
      ],
      note: "Nothing here requires a decision today. Knowing the size of the gap is the first step, and it takes one conversation.",
    }),
  },
  {
    name: "54 · Behind because the bookkeeper left", category: "Outsourced Accounting",
    subject: "Who is keeping {{company|your}} books this month?",
    html: tpl({
      summary: "When the person who kept the books leaves, the gap is usually discovered at the worst moment — a filing, a bank request, an audit. If that has happened at {{company|your company}}, the work can be picked up without starting again from zero.",
      cta: { label: "Pick up where it stopped", ask: "Our bookkeeper has left. I would like help picking up the accounts." },
      points: [
        "A review of what was recorded and where it stopped",
        "Continuity of your existing system — no migration unless you want one",
        "Monthly closing handled from here so it does not depend on one person again",
      ],
    }),
  },
  // ── التقارير والقرار ──
  {
    name: "55 · Deciding without numbers", category: "Financial Reporting",
    subject: "A question about how decisions get made at {{company|your company}}",
    html: tpl({
      summary: "Most owners we meet decide on instinct — not by choice, but because the numbers arrive late or not at all. The question is not whether {{company|you}} have accounts; it is whether you see, each month, which line earns and which consumes.",
      cta: { label: "See a sample monthly report", ask: "I would like to see a sample of your monthly management report." },
      points: [
        "Profit by line of business, not one figure for the whole company",
        "Where cost is actually consumed",
        "A report short enough to be read in ten minutes",
      ],
      note: "Instinct built the business. It becomes expensive when the business grows past what one person can hold in mind.",
    }),
  },
  {
    name: "56 · Profit on paper, no cash", category: "Financial Reporting",
    subject: "Profitable on paper — is the cash there at {{company|your company}}?",
    html: tpl({
      summary: "A profitable year with an empty account is a normal, solvable problem: receivables collected late, stock sitting still, payments falling in the same week. It is a cash cycle issue, not a profit issue — and it is measurable.",
      cta: { label: "Review our cash cycle", ask: "I would like a review of our cash cycle and receivables." },
      points: [
        "How long your money sits in receivables and in stock",
        "Which customers consistently pay late",
        "A collection schedule, and payment timing that does not collide",
      ],
    }),
  },
  // ── المناطق الحرة ──
  {
    name: "57 · Free zone — zero tax is not zero obligation", category: "Corporate Tax",
    subject: "{{company|Your}} free zone company — registered and filing?",
    html: tpl({
      summary: "A free zone company may still owe no Corporate Tax and yet be required to register and to file. Whether a business qualifies depends on its activity and on conditions that have to be met and evidenced — not on its address. We review where {{company|you}} stand.",
      cta: { label: "Review our free zone tax position", ask: "I would like a review of our Corporate Tax position as a free zone company." },
      points: [
        "Whether your activity meets the qualifying conditions",
        "Registration and filing obligations regardless of the amount due",
        "The records that evidence the position you take",
      ],
      note: "Treatment depends on your activity and regulatory classification, and is confirmed against your own facts and current Authority guidance.",
    }),
  },
  // ── المجموعات والفروع ──
  {
    name: "58 · Which branch actually earns", category: "Financial Reporting",
    subject: "Which of {{company|your}} branches is actually profitable?",
    html: tpl({
      summary: "With several branches or companies, the group total hides the answer: one location usually carries the others. Separating them is bookkeeping work, not guesswork — and it changes where you put the next dirham.",
      cta: { label: "Separate our branch results", ask: "I would like branch-level profitability reporting for our group." },
      points: [
        "Revenue and cost allocated per branch or entity",
        "Inter-company balances reconciled rather than carried forward",
        "One consolidated report, plus one per location",
      ],
    }),
  },
  // ── المخزون ──
  {
    name: "59 · Trading — do you know your real margin?", category: "Outsourced Accounting",
    subject: "{{company|Your}} margin per item — recorded or estimated?",
    html: tpl({
      summary: "In trading, margin is decided by cost of sales, and cost of sales is usually estimated rather than recorded: freight, duty, handling and returns land somewhere other than the item. The result is a healthy-looking margin on items that lose money.",
      cta: { label: "Check our cost of sales", ask: "I would like a review of our inventory and cost of sales." },
      points: [
        "What your landed cost per item really includes",
        "Differences between physical count and the books",
        "Margin by item and by supplier, recorded not assumed",
      ],
    }),
  },
  // ── goAML والمعرفة بالعميل ──
  {
    name: "60 · Registered on goAML — and then?", category: "AML Compliance",
    subject: "{{company|Your}} goAML registration — what comes after it",
    html: tpl({
      summary: "Registering on goAML is a first step, not a compliance framework. What inspectors look at is whether someone monitors, decides and documents: who reviewed this transaction, on what basis, and where it is recorded. We review how that works at {{company|your company}}.",
      cta: { label: "Review our reporting process", ask: "I would like a review of our goAML registration and reporting process." },
      points: [
        "Who monitors, who decides, and how it is evidenced",
        "What triggers a report, and what is recorded when none is filed",
        "Whether your written procedure matches what is actually done",
      ],
      note: "Obligations depend on your activity, supervisory authority and risk profile.",
    }),
  },
  {
    name: "61 · KYC is not a passport copy", category: "AML Compliance",
    subject: "What is in {{company|your}} customer files?",
    html: tpl({
      summary: "A passport copy and a trade licence are the beginning of customer due diligence, not the whole of it. The questions asked at inspection are about the beneficial owner, the source of funds, and when the file was last updated. We review a sample of {{company|your}} files against what is expected.",
      cta: { label: "Review our customer files", ask: "I would like a review of our customer due diligence files." },
      points: [
        "Identification of the real beneficial owner, not only the signatory",
        "Source of funds, and how it is recorded",
        "Periodic review — and what triggers one early",
      ],
    }),
  },
  // ── قطاعات لم تُلمس ──
  {
    name: "62 · Clinics — profit per service", category: "Outsourced Accounting",
    subject: "Which services actually earn at {{company|your}} clinic?",
    html: tpl({
      summary: "A clinic earns from insurance and from cash, and the two behave differently: rejected claims go unchased, and the cost of delivering each service is rarely separated. Busy does not mean profitable, and the difference is visible once the books are arranged for it.",
      cta: { label: "Review our clinic accounting", ask: "I would like a review of our clinic's accounting and service profitability." },
      points: [
        "Insurance receivables, and claims rejected but not followed up",
        "Profit per service and per practitioner",
        "Monthly reporting a clinic manager can act on",
      ],
    }),
  },
  {
    name: "63 · E-commerce — where the margin goes", category: "Outsourced Accounting",
    subject: "Platform fees, returns, settlements — {{company|your}} real margin",
    html: tpl({
      summary: "Selling through platforms and payment gateways means the money that arrives is not the money that was sold: commissions, gateway fees, chargebacks and returns sit between the two. Without reconciliation, the reported margin is the wrong number.",
      cta: { label: "Reconcile our platforms", ask: "I would like our platform and payment gateway settlements reconciled." },
      points: [
        "Platform and gateway settlements reconciled to the bank",
        "Fees, refunds and chargebacks recorded where they belong",
        "Net margin per channel and per product",
      ],
    }),
  },
  {
    name: "64 · Consulting — profit per client", category: "Financial Reporting",
    subject: "Which clients are worth the hours at {{company|your company}}?",
    html: tpl({
      summary: "In professional services the cost is time, and time is the thing least often recorded against the work. Some clients pay well and cost more; some unbilled hours never become invoices. Both are visible once the accounts are arranged by client and engagement.",
      cta: { label: "See profit by client", ask: "I would like reporting on profitability by client and engagement." },
      points: [
        "Profit by client and by engagement",
        "Unbilled time, and what it costs you",
        "Collection ageing by client",
      ],
    }),
  },
  // ── مقاولات ──
  {
    name: "65 · Contracting — paid late, paying early", category: "Construction & Engineering",
    subject: "{{company|Your}} project cash: retention, certificates, subcontractors",
    html: tpl({
      summary: "Contracting cash is squeezed from both sides: certificates approved late and retention held, while subcontractors and suppliers expect payment on time. The gap is predictable per project once it is measured, and it can be planned for instead of absorbed.",
      cta: { label: "Review our project cash", ask: "I would like a review of our project cash flow, retention and certificates." },
      points: [
        "Retention held and when it is due back",
        "Certified versus invoiced versus collected, per project",
        "A payment plan that matches collection, not the calendar",
      ],
    }),
  },
  // ── أول تواصل: من نحن، بالبنية الجديدة ──
  {
    name: "66 · One finance function, outsourced", category: "About us",
    subject: "{{company|Your}} accounting, tax and compliance — in one place",
    html: tpl({
      summary: "Most businesses we work with had three separate arrangements: someone for the books, someone else at tax season, and nobody for compliance until a letter arrived. Pro Count is an outsourced finance function for UAE companies — records, reporting, tax and AML support, connected.",
      cta: { label: "Book a short consultation", ask: "I would like a short consultation about your services." },
      points: [
        "Bookkeeping and monthly reporting you can act on",
        "VAT and Corporate Tax handled on the same records",
        "AML/CFT support where obligations apply to your activity",
      ],
      note: "We are not accounting software, a company formation agent, or a payroll provider. We are the finance team you do not have to hire.",
    }),
  },
  {
    name: "67 · What one conversation covers", category: "About us",
    subject: "A short call about {{company|your}} finance function",
    html: tpl({
      summary: "No proposal, no obligation: a short call in which we ask about {{company|your}} activity, how your books are kept now, and what is due next. Most calls end with two or three specific things to check — whether or not you work with us.",
      cta: { label: "Pick a time", ask: "I would like to arrange a short call." },
      points: [
        "Where your records stand, and what that makes possible",
        "Which obligations apply to your activity — and which do not",
        "What we would do first, if anything",
      ],
    }),
  },
  // ── إغلاق الملف بكرامة ──
  {
    name: "68 · Closing the file", category: "About us",
    subject: "Should I close {{company|your}} file, {{first_name|}}?",
    html: tpl({
      summary: "I have written a few times about accounting and compliance support for {{company|your company}} and have not heard back — which usually means the timing is wrong, not the subject. I will stop here unless you tell me otherwise.",
      cta: { label: "Keep the file open", ask: "Please keep our file open — the timing was not right." },
      points: [
        "If it is timing, tell me when and I will write then — not before",
        "If it is the wrong person, point me to the right one",
        "If it is not relevant at all, say so and you will not hear from me again",
      ],
      note: "Either way, thank you for your time.",
    }),
  },
];

/** تُزرع مرةً، وما عُدّل منها يبقى لصاحبه. */
export async function seedLibrary2(userId: number): Promise<{ added: number; kept: number }> {
  const names = LIBRARY_2.map((t) => t.name);
  const have = await db.select({ name: emailTemplatesTable.name }).from(emailTemplatesTable)
    .where(and(eq(emailTemplatesTable.userId, userId), inArray(emailTemplatesTable.name, names)));
  const haveSet = new Set(have.map((h) => h.name));
  const missing = LIBRARY_2.filter((t) => !haveSet.has(t.name));
  if (missing.length) {
    await db.insert(emailTemplatesTable).values(missing.map((t) => ({
      userId, name: t.name, subject: t.subject, html: t.html, category: t.category,
    })));
    logger.info({ userId, added: missing.length }, "زُرعت قوالب المكتبة الثانية");
  }
  return { added: missing.length, kept: haveSet.size };
}
