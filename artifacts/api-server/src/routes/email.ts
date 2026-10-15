// ── Email marketing API ───────────────────────────────────────────
// Everything the section does, behind the session. The public half — the
// pixel, the click, the unsubscribe, the inbound hook — is routes/track.ts.

import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql, gte } from "drizzle-orm";
import {
  db, listFoldersTable, emailSettingsTable, emailSendersTable, emailContactsTable, emailListsTable, emailListMembersTable,
  emailTemplatesTable, emailCampaignsTable, emailSequencesTable, emailSequenceJobsTable,
  emailMessagesTable, emailEventsTable, emailInboundTable, emailSegmentsTable, emailMissionsTable,
  botEmployeesTable, agentMemoryTable, emailKnowledgeDocsTable, type EmailStep,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { assertCanSend, assertCanAddContacts, planErrorToResponse } from "../lib/plans";
import { hygieneReport, verifyDomains, cleanList, warmupPlan } from "../lib/email/hygiene";
import { warmupCap } from "../lib/email/health";
import { getSettings, overview, startCampaign, pauseCampaign, enrolInSequence, cancelSequencesFor, recordEvent, verdictFor, signals, varsFor } from "../lib/email/service";
import { verifySettings, sendEmail, isConfigured, messageIdFor } from "../lib/email/provider";
import { sendersView, cleanSenderInput, asSettings, PRESETS } from "../lib/email/senders";
import { checkDomain } from "../lib/email/dns";
import { cleanRows, detectColumns, checkMx, splitBy, type ImportRow } from "../lib/email/importer";
import { draftReply, sendReply, pollMailbox } from "../lib/email/inbound";
import { readWorkbook, parseTables, whatsappEntries } from "../lib/phone-import";
import { saveToNewGroup, validateInBackground } from "../lib/contact-save";
import { folderForSector, listSector, ownFolder } from "../lib/folders";
import { deleteContacts, deleteList } from "../lib/email/delete";
import { diagnose } from "../lib/email/diagnose";
import { sentList, sentSummary, sentPreview, type SentFilter } from "../lib/email/sent";
import { trackingState, validatePublicUrl, probePublicUrl, publicBase } from "../lib/email/public-url";
import { reclassifyInbox } from "../lib/email/reclassify";
import { KIND_AR, INTENT_AR } from "../lib/email/classify";
import { thread, threadBrief } from "../lib/email/thread";
import { dataPicture, cohortMembers, cohortCounts, COHORTS, type Cohort } from "../lib/email/cohorts";
import { reconcile, repair, sendingRhythm, type LedgerFinding } from "../lib/email/ledger";
import { retargetPlans } from "../lib/email/retarget";
import { opensReport } from "../lib/email/opens";
import { runSpecialist, runSpecialistRound, lastReports, SPECIALISTS, type SpecialistRole } from "../lib/email/specialists";
import { seedLibrary2 } from "../lib/email/library-2";
import { reachReport, contentSignals } from "../lib/email/deliverability";
import { runDesk } from "../lib/data-desk/desk";
import { managerState, runManagerCycle, giveGoal } from "../lib/email/manager";
import { teamVoice, EMAIL_TEAM_DEFS } from "../lib/email/team";
import { EMAIL_GRAPH, contractProblems } from "../lib/graph/contracts";
import { campaignReadiness } from "../lib/email/readiness";
import { dashboard as emailDashboard } from "../lib/email/dashboard";
import { register as emailRegister } from "../lib/email/register";
import { createWithCreator, SERVICES as CREATOR_SERVICES } from "../lib/email/creator";
import { getAutopilot, saveAutopilot, runAutopilot } from "../lib/email/autopilot";
import { autoState, mapFolder, endOfMonthUae } from "../lib/email/auto-desk";
import { teamStatus, activity as teamActivity } from "../lib/email/team";
import { addDoc, extractText, learn as learnDoc, ask as askKnowledge, library as knowledgeLibrary } from "../lib/email/knowledge-docs";
import { classifySector, SECTORS, UNCLASSIFIED } from "../lib/email/sector";
import { cleanFilter, facets, resolve as resolveSegment, count as countSegment, describe as describeSegment, conditions as segmentConditions } from "../lib/email/segments";
import { ensureEmailAgent, memory as agentMemory, teach, rememberKnowledge, writeCampaign, EMAIL_ROLE } from "../lib/email/agent";
import { createMission, setAudience as setMissionAudience, approve as approveMission, runMission, missionsFor, missionReport } from "../lib/email/missions";
import { seedEmailDefaults, DEFAULT_SEQUENCE_NAME } from "../lib/email/seed";
import { newToken, renderEmail, personalize } from "../lib/email/tracking";
import { brandOf, directionOf } from "../lib/email/layout";
import { logger } from "../lib/logger";
import { runPipeline } from "../lib/email/pipeline";
import { importRows } from "../lib/email/intake";

const router = Router();
router.use(requireAuth);

/**
 * Why the email is not going out.
 *
 * One call that asks every question the owner was asking by hand — is the mail
 * server reachable, is there anyone to send to, is a mission stuck, did the
 * reports reach Telegram — and answers each with what was actually found.
 * It probes SMTP live rather than trusting the stored settings, because a
 * wrong password and a sleeping laptop fail identically from the outside.
 */
router.get("/diagnose", async (req, res) => res.json(await diagnose(req.session.userId!)));

// ── ما أُرسل فعلاً ────────────────────────────────────────────────
// صفٌّ لكل رسالةٍ خرجت، ومعاينةٌ تُعيد بناء الرسالة بنفس الدوال التي
// أرسلتها — فما يُعرض هو ما وصل، ومعه ما لم يصل.
router.get("/sent", async (req, res) => {
  const userId = req.session.userId!;
  const filter = String(req.query["filter"] ?? "all") as SentFilter;
  res.json({
    ...(await sentList(userId, {
      filter: ["all", "opened", "clicked", "replied", "bounced", "failed", "unopened"].includes(filter) ? filter : "all",
      q: req.query["q"] ? String(req.query["q"]) : undefined,
      campaignId: req.query["campaignId"] ? Number(req.query["campaignId"]) : null,
      page: Number(req.query["page"]) || 0,
      limit: Number(req.query["limit"]) || 50,
    })),
    summary: await sentSummary(userId),
    tracking: await trackingState(userId),
  });
});

router.get("/sent/:id", async (req, res) => {
  const p = await sentPreview(req.session.userId!, Number(req.params["id"]));
  if (!p) return res.status(404).json({ error: "الرسالة غير موجودة" });
  res.json(p);
});

/** جسم الرسالة وحده، ليُعرض داخل إطار معزول في المتصفح. */
router.get("/sent/:id/body", async (req, res) => {
  const p = await sentPreview(req.session.userId!, Number(req.params["id"]));
  if (!p) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // لا نصوص ولا موارد خارجية إلا الصور: هذا نصُّ رسالةٍ يُعرض، لا صفحةٌ تُشغَّل.
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src *");
  res.send(p.html);
});

/** الخيط كاملاً مع شركة واحدة — ما أرسلناه وما ردّوا، مرتّباً. */
router.get("/contacts/:id/thread", async (req, res) => {
  const t = await thread(req.session.userId!, Number(req.params["id"]), 40);
  res.json({ ...t, brief: threadBrief(t, { turns: 12, chars: 600 }) });
});

// ── العنوان العام: فحصٌ حقيقي لا تحقّقٌ من الشكل ─────────────────
router.post("/settings/public-url/check", async (req, res) => {
  const raw = String(req.body?.url ?? "").trim();
  const v = validatePublicUrl(raw);
  if (!v.ok) return res.json({ ok: false, why: v.why });
  const probe = await probePublicUrl(v.url!);
  res.json({ ok: probe.ok, url: v.url, warn: v.warn, ms: probe.ms, status: probe.status,
    why: probe.ok ? null : probe.why,
    note: probe.ok ? "الطريق مفتوح: بكسل الفتح يصل من هذا العنوان." : null });
});

router.get("/tracking", async (req, res) => {
  const userId = req.session.userId!;
  const st = await trackingState(userId);
  res.json({ ...st, probe: st.base ? await probePublicUrl(st.base) : null });
});

// ── الأربعة المتخصّصون ────────────────────────────────────────────
// كلٌّ يقرأ من محرّكه، والمحرّك يُقرأ وحده أيضاً: الواجهة تعرض الأرقام
// بلا استدعاء نموذج، والنموذج يُستدعى حين يُطلب حكمٌ عليها.

/** بدور: كل الداتا مُصنَّفة — حالةٌ واحدة لكل جهة، وجودة كل صف. */
router.get("/data", async (req, res) => {
  const listId = req.query["listId"] ? Number(req.query["listId"]) : null;
  res.json(await dataPicture(req.session.userId!, listId));
});

router.get("/data/:cohort", async (req, res) => {
  const cohort = String(req.params["cohort"]) as Cohort;
  if (!(cohort in COHORTS)) return res.status(400).json({ error: "حالة غير معروفة" });
  res.json({
    cohort, info: COHORTS[cohort],
    rows: await cohortMembers(req.session.userId!, cohort, {
      limit: Number(req.query["limit"]) || 100,
      page: Number(req.query["page"]) || 0,
      listId: req.query["listId"] ? Number(req.query["listId"]) : null,
    }),
  });
});

/** مريم: خطّة لكل حالة، بالعدد المؤهّل لا بالعدد الكلي. */
router.get("/retarget", async (req, res) => {
  res.json(await retargetPlans(req.session.userId!, {
    minGapDays: req.query["gap"] ? Math.max(1, Math.min(30, Number(req.query["gap"]))) : undefined,
  }));
});

/** حصّة: العنوان والساعة والقطاع — مقارنةً لا مطلقاً. */
router.get("/opens", async (req, res) => res.json(await opensReport(req.session.userId!)));

/** راشد: هل يطابق المعروضُ ما حدث. */
router.get("/ledger", async (req, res) => {
  const userId = req.session.userId!;
  const [r, rhythm] = await Promise.all([reconcile(userId), sendingRhythm(userId, 14)]);
  res.json({ ...r, rhythm });
});

/** الإصلاح بإذنٍ صريح — ولا شيء من تلقاء نفسه. */
router.post("/ledger/repair", async (req, res) => {
  const what = String(req.body?.what ?? "") as NonNullable<LedgerFinding["repair"]>;
  if (!["requeue_stuck", "resync_counters", "mark_bounced", "cancel_orphans"].includes(what)) {
    return res.status(400).json({ error: "إصلاح غير معروف" });
  }
  res.json(await repair(req.session.userId!, what));
});

// ── منصور: مدير البريد ────────────────────────────────────────────
/** السياسة، والنسبة الفعلية، والأحكام، وآخر تقرير — بلا نداء نموذج. */
router.get("/manager", async (req, res) => res.json(await managerState(req.session.userId!)));

/** صاحب العمل يعطي منصور الهدف، فتبدأ دورةٌ تحسب خطته فوراً (بلا تقرير). */
router.post("/manager/goal", async (req, res) => {
  const userId = req.session.userId!;
  const b = req.body ?? {};
  try {
    const id = await giveGoal(userId, { metric: String(b.metric) as any, target: Number(b.target), deadline: new Date(String(b.deadline)), title: b.title ? String(b.title) : undefined });
    void runManagerCycle(userId, { brief: false, force: true }).catch(() => {});
    res.json({ id, note: "استلم منصور الهدف. يحسب الخطة الآن ويبدأ العمل عليها." });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** ما يقرؤه كل موظف في البريد قبل أن يعمل — البرمبت كاملاً كما يُرسل للنموذج، بلا نداء نموذج. */
router.get("/team/prompts", async (req, res) => {
  const userId = req.session.userId!;
  const out = [];
  for (const d of EMAIL_TEAM_DEFS) out.push({ role: d.role, name: d.name, title: d.title, avatar: d.avatar, prompt: await teamVoice(userId, d.role) });
  res.json({ graph: { oneBreath: EMAIL_GRAPH.oneBreath, loop: EMAIL_GRAPH.loop, edges: EMAIL_GRAPH.edges, problems: contractProblems(EMAIL_GRAPH) }, team: out });
});

/** دورةٌ الآن. تجري في الخلفية: فيها نداء نموذج وجولة الطيار. */
router.post("/manager/run", async (req, res) => {
  const userId = req.session.userId!;
  void runManagerCycle(userId, { brief: true, notifyOwner: req.body?.notify !== false, force: true })
    .catch((err) => req.log?.warn?.({ err: String(err?.message ?? err) }, "manager cycle failed"));
  res.json({ started: true, note: "بدأت الدورة: الفريق ← السجل ← النتائج ← القرارات ← الموجات ← التقرير. يظهر التقرير هنا خلال دقيقة ويصلك على تليجرام." });
});

// ── الوصول: أن تصل الرسالة الصندوق لا مجلد الإعلانات ─────────────
router.get("/reach", async (req, res) => res.json(await reachReport(req.session.userId!)));

/** فحص نصِّ حملةٍ بعينها قبل إرسالها — أو نصٍّ يُكتب الآن. */
router.post("/reach/content", async (req, res) => {
  const subject = String(req.body?.subject ?? "");
  const html = String(req.body?.html ?? "");
  if (!html.trim()) return res.status(400).json({ error: "لا نص" });
  const checks = contentSignals(subject, html);
  const max = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.state === "ok" ? c.weight : c.state === "warn" ? c.weight * 0.5 : 0), 0);
  res.json({ checks, score: Math.round((got / Math.max(1, max)) * 100) });
});

/** قوالب المكتبة الثانية لمن زُرع حسابه قبل وجودها. */
router.post("/templates/library", async (req, res) => {
  res.json(await seedLibrary2(req.session.userId!));
});

/** آخر تقرير لكل أخصائي — بلا استدعاء نموذج. */
router.get("/specialists", async (req, res) => {
  res.json({ specialists: await lastReports(req.session.userId!) });
});

/** حكمٌ جديد: يُستدعى النموذج الآن. */
router.post("/specialists/:role/run", async (req, res) => {
  const role = String(req.params["role"]) as SpecialistRole;
  if (!(role in SPECIALISTS)) return res.status(400).json({ error: "أخصائي غير معروف" });
  try {
    const r = await runSpecialist(req.session.userId!, role, { notifyOwner: req.body?.notify === true });
    if (!r) return res.status(503).json({ error: "الأخصائي موقوف أو النموذج لم يستجب" });
    res.json(r);
  } catch (err: any) { res.status(500).json({ error: String(err?.message ?? err) }); }
});

/** الجولة كاملةً — في الخلفية، فهي تأخذ دقائق بفاصل المزوّد. */
router.post("/specialists/round", async (req, res) => {
  const userId = req.session.userId!;
  void runSpecialistRound(userId, { notifyOwner: true }).catch(() => {});
  res.json({ started: true, order: ["بدور", "مريم", "حصّة", "راشد"], note: "تصل التقارير على تليجرام وتظهر هنا تباعاً — بفاصل دقيقة بين كل واحد (حدّ المزوّد المجاني)." });
});

// ── إعادة تصنيف الوارد القديم ────────────────────────────────────
router.post("/inbox/reclassify", async (req, res) => {
  res.json(await reclassifyInbox(req.session.userId!, { dryRun: req.body?.dryRun === true }));
});
// ماجد's round now: check the domains, clean the lists, read the DNS, report.
router.post("/caretaker/run", async (req, res) => {
  const { caretakerRound } = await import("../lib/email/caretaker");
  res.json(await caretakerRound(req.session.userId!));
});

/**
 * Whether this campaign can be published, and what happens if it is.
 *
 * Read before the button rather than thrown after it. The old path refused
 * with one sentence and never mentioned the commonest cause — a list that
 * exists and holds nobody who can be written to.
 */
router.get("/campaigns/:id/readiness", async (req, res) => {
  const r = await campaignReadiness(req.session.userId!, Number(req.params.id));
  if (!r) return res.status(404).json({ error: "الحملة غير موجودة" });
  res.json(r);
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── Overview ──────────────────────────────────────────────────────
router.get("/overview", async (req, res) => res.json(await overview(req.session.userId!)));

router.get("/events", async (req, res) => {
  const userId = req.session.userId!;
  const since = req.query["since"] ? new Date(String(req.query["since"])) : new Date(Date.now() - 24 * 3_600_000);
  const rows = await db.select({ e: emailEventsTable, to: emailMessagesTable.toEmail, subject: emailMessagesTable.subject, campaignId: emailMessagesTable.campaignId })
    .from(emailEventsTable).leftJoin(emailMessagesTable, eq(emailMessagesTable.id, emailEventsTable.messageId))
    .where(and(eq(emailEventsTable.userId, userId), gte(emailEventsTable.createdAt, since)))
    .orderBy(desc(emailEventsTable.createdAt)).limit(200);
  res.json(rows.map((r) => ({ id: r.e.id, type: r.e.type, at: r.e.createdAt, to: r.to, subject: r.subject, url: r.e.url, campaignId: r.campaignId, meta: r.e.meta })));
});

// ── Settings ──────────────────────────────────────────────────────
const mask = (s: any) => s ? { ...s, smtpPass: s.smtpPass ? "••••••" : null, apiKey: s.apiKey ? "••••••" : null, imapPass: s.imapPass ? "••••••" : null } : null;

router.get("/settings", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  res.json({
    settings: mask(s), configured: isConfigured(s),
    trackingBase: (await publicBase(req.session.userId!)) || null,
    tracking: await trackingState(req.session.userId!),
    health: await verdictFor(req.session.userId!), signals: await signals(req.session.userId!),
  });
});

router.put("/settings", async (req, res) => {
  const userId = req.session.userId!;
  const b = req.body ?? {};
  const cur = await getSettings(userId);
  const keep = (v: unknown, old: string | null | undefined) => (v === "••••••" || v === undefined ? old ?? null : (v as string | null));
  const values = {
    userId,
    provider: ["smtp", "resend", "brevo"].includes(b.provider) ? b.provider : "smtp",
    smtpHost: b.smtpHost ?? null, smtpPort: Number(b.smtpPort) || 587, smtpSecure: !!b.smtpSecure,
    smtpUser: b.smtpUser ?? null, smtpPass: keep(b.smtpPass, cur?.smtpPass),
    apiKey: keep(b.apiKey, cur?.apiKey),
    fromName: b.fromName ?? null, fromEmail: b.fromEmail ?? null, replyTo: b.replyTo ?? null, signature: b.signature ?? null,
    layout: b.layout === "plain" ? "plain" : "branded",
    defaultLanguage: ["en", "ar", "both"].includes(b.defaultLanguage) ? b.defaultLanguage : cur?.defaultLanguage ?? "en",
    followIntensity: ["light", "normal", "intense"].includes(b.followIntensity) ? b.followIntensity : cur?.followIntensity ?? "intense",
    skipRisky: typeof b.skipRisky === "boolean" ? b.skipRisky : cur?.skipRisky ?? true,
    brandName: b.brandName ?? cur?.brandName ?? null, brandTagline: b.brandTagline ?? cur?.brandTagline ?? null,
    brandColor: b.brandColor ?? cur?.brandColor ?? null, brandAccent: b.brandAccent ?? cur?.brandAccent ?? null,
    logoUrl: b.logoUrl ?? cur?.logoUrl ?? null, website: b.website ?? cur?.website ?? null, phone: b.phone ?? cur?.phone ?? null, address: b.address ?? cur?.address ?? null,
    hourlyCap: Math.min(500, Math.max(5, Number(b.hourlyCap) || 40)),
    dailyCap: Math.min(5000, Math.max(10, Number(b.dailyCap) || 300)),
    tracking: b.tracking !== false,
    // العنوان العام: يُطهَّر قبل الحفظ. عنوانٌ داخلي يُرفض بسببه، فقبوله
    // يُعيد الصفر نفسه الذي عاش معه ٥٦٠ إرسالاً.
    publicUrl: (() => {
      if (b.publicUrl === undefined) return cur?.publicUrl ?? null;
      if (!String(b.publicUrl).trim()) return null;
      const v = validatePublicUrl(String(b.publicUrl));
      return v.ok ? v.url! : cur?.publicUrl ?? null;
    })(),
    imapHost: b.imapHost ?? null, imapPort: Number(b.imapPort) || 993, imapUser: b.imapUser ?? null, imapPass: keep(b.imapPass, cur?.imapPass),
    autoReply: !!b.autoReply,
    autoReplyDelayMin: Math.min(240, Math.max(2, Number(b.autoReplyDelayMin) || 12)),
    warmup: b.warmup !== false,
    inboundToken: cur?.inboundToken ?? randomBytes(18).toString("base64url"),
    updatedAt: new Date(),
  };
  const [row] = await db.insert(emailSettingsTable).values(values as any)
    .onConflictDoUpdate({ target: emailSettingsTable.userId, set: values as any }).returning();
  // The first configured account gets the ready-made sequence and templates.
  if (!cur) await seedEmailDefaults(userId).catch(() => {});
  res.json({ settings: mask(row), configured: isConfigured(row) });
});

// ── صناديق الإرسال الإضافية ───────────────────────────────────────
// كلمة المرور يكتبها صاحب العمل هنا، ولا تعود في أي ردّ.
router.get("/senders", async (req, res) => {
  res.json({ senders: await sendersView(req.session.userId!), presets: PRESETS });
});

router.post("/senders", async (req, res) => {
  const userId = req.session.userId!;
  try {
    const v = cleanSenderInput(req.body ?? {});
    const s = await getSettings(userId);
    if (s?.fromEmail && s.fromEmail.toLowerCase() === v.fromEmail) return res.status(400).json({ error: "هذا هو الصندوق الأول نفسه — موجود في الإعدادات" });
    const [row] = await db.insert(emailSendersTable).values({ userId, ...v }).returning();
    // يُفحص الدخول فوراً، فلا يدخل التدوير صندوقٌ لا يعمل.
    const check = await verifySettings(asSettings(s ?? ({ userId } as any), row!)).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
    if (!check.ok) await db.update(emailSendersTable).set({ status: "broken", heldReason: check.detail.slice(0, 300) }).where(eq(emailSendersTable.id, row!.id));
    res.json({ id: row!.id, check });
  } catch (err: any) {
    const dup = /unique|duplicate/i.test(String(err?.message ?? err));
    res.status(400).json({ error: dup ? "هذا الصندوق مضاف من قبل" : String(err?.message ?? err) });
  }
});

router.put("/senders/:id", async (req, res) => {
  const userId = req.session.userId!, id = Number(req.params.id);
  const [cur] = await db.select().from(emailSendersTable).where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId))).limit(1);
  if (!cur) return res.status(404).json({ error: "غير موجود" });
  try {
    const v = cleanSenderInput(req.body ?? {}, cur);
    const status = req.body?.status === "paused" ? "paused" : req.body?.status === "active" || req.body?.smtpPass ? "active" : cur.status;
    // A mailbox prepared without its password starts its warm-up the day the password arrives.
    const firstPass = !cur.smtpPass && !!req.body?.smtpPass;
    await db.update(emailSendersTable).set({ ...v, status, ...(status === "active" ? { heldReason: null } : {}), ...(firstPass ? { createdAt: new Date() } : {}) }).where(eq(emailSendersTable.id, id));
    // A new password is tried at once (no mail is sent): a wrong one never joins the rotation.
    if (req.body?.smtpPass) {
      const [now] = await db.select().from(emailSendersTable).where(eq(emailSendersTable.id, id)).limit(1);
      const check = await verifySettings(asSettings((await getSettings(userId)) ?? ({ userId } as any), now!)).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
      if (!check.ok) await db.update(emailSendersTable).set({ status: "broken", heldReason: check.detail.slice(0, 300) }).where(eq(emailSendersTable.id, id));
      return res.json({ ok: check.ok, check });
    }
    res.json({ ok: true });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

router.post("/senders/:id/test", async (req, res) => {
  const userId = req.session.userId!, id = Number(req.params.id);
  const [cur] = await db.select().from(emailSendersTable).where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId))).limit(1);
  if (!cur) return res.status(404).json({ error: "غير موجود" });
  const s = await getSettings(userId);
  const check = await verifySettings(asSettings(s ?? ({ userId } as any), cur)).catch((e) => ({ ok: false, detail: String(e?.message ?? e) }));
  await db.update(emailSendersTable).set(check.ok ? { status: cur.status === "broken" ? "active" : cur.status, heldReason: cur.status === "broken" ? null : cur.heldReason } : { status: "broken", heldReason: check.detail.slice(0, 300) }).where(eq(emailSendersTable.id, id));
  res.json(check);
});

router.delete("/senders/:id", async (req, res) => {
  await db.delete(emailSendersTable).where(and(eq(emailSendersTable.id, Number(req.params.id)), eq(emailSendersTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

router.post("/settings/test", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s) return res.status(400).json({ ok: false, detail: "لا إعدادات" });
  res.json(await verifySettings(s));
});

router.post("/settings/test-send", async (req, res) => {
  const userId = req.session.userId!;
  const s = await getSettings(userId);
  if (!isConfigured(s)) return res.status(400).json({ error: "إعدادات البريد غير مكتملة" });
  const to = String(req.body?.to || s!.fromEmail).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: "بريد الاستلام غير صالح" });
  const token = newToken();
  const base = (process.env["SITE_URL"] ?? "").replace(/\/+$/, "");
  const r = renderEmail("<p>هذه رسالة اختبار من إعدادات البريد في FLOW HUB. إن وصلتك فالمُرسِل يعمل.</p><p><a href=\"https://example.com\">رابط للتجربة</a></p>", {},
    { base, token, secret: process.env["SESSION_SECRET"] ?? "wam", pixel: !!s!.tracking, links: !!s!.tracking },
    { base, token, fromName: s!.fromName ?? s!.fromEmail!, fromEmail: s!.fromEmail! }, brandOf(s));
  try {
    const out = await sendEmail(s!, { to, subject: "اختبار الإرسال — FLOW HUB", html: r.html, text: r.text, messageId: messageIdFor(token, s!.fromEmail!), unsubscribeUrl: null });
    logger.info({ userId, to, serverReply: out.serverReply, accepted: out.accepted, rejected: out.rejected, messageId: out.providerId }, "رسالة اختبار البريد");
    res.json({ ok: true, to, providerId: out.providerId, serverReply: out.serverReply ?? null, accepted: out.accepted ?? [], rejected: out.rejected ?? [] });
  } catch (err: any) {
    logger.warn({ userId, to, err: String(err?.message ?? err) }, "رسالة اختبار البريد فشلت");
    res.status(400).json({ ok: false, error: String(err?.message ?? err) });
  }
});

router.get("/settings/dns", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s?.fromEmail) return res.status(400).json({ error: "اضبط عنوان المُرسِل أولاً" });
  res.json(await checkDomain(s.fromEmail, s.smtpHost));
});

router.post("/settings/poll", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s?.imapHost) return res.status(400).json({ error: "لا إعدادات IMAP" });
  res.json({ handled: await pollMailbox(s), lastError: (await getSettings(req.session.userId!))?.imapLastError ?? null });
});

// ── Contacts & lists ──────────────────────────────────────────────
// ── Contacts: filter, count, act ──────────────────────────────────
// The filter is a segment filter, posted as JSON (arrays do not survive a
// query string well), so the table, the counts and a saved segment all mean
// the same thing by it.
function filterFrom(req: any) {
  const raw = req.method === "GET" ? { ...req.query, sectors: req.query.sectors ? String(req.query.sectors).split("|") : undefined, cities: req.query.cities ? String(req.query.cities).split("|") : undefined, engagement: req.query.engagement ? String(req.query.engagement).split("|") : undefined, statuses: req.query.status ? [String(req.query.status)] : undefined, listIds: req.query.listId ? [Number(req.query.listId)] : undefined } : req.body?.filter ?? {};
  return cleanFilter(raw);
}

router.post("/contacts/search", async (req, res) => {
  const userId = req.session.userId!;
  const f = filterFrom(req);
  const limit = Math.min(500, Number(req.body?.limit) || 100);
  const offset = Number(req.body?.offset) || 0;
  const where = and(...segmentConditions(userId, f));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(emailContactsTable).where(where).orderBy(desc(emailContactsTable.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(emailContactsTable).where(where),
  ]);
  res.json({ rows, total: Number(n), description: describeSegment(f) });
});

router.get("/contacts", async (req, res) => {
  const userId = req.session.userId!;
  const f = filterFrom(req);
  const limit = Math.min(500, Number(req.query["limit"]) || 100);
  const offset = Number(req.query["offset"]) || 0;
  const where = and(...segmentConditions(userId, f));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(emailContactsTable).where(where).orderBy(desc(emailContactsTable.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(emailContactsTable).where(where),
  ]);
  res.json({ rows, total: Number(n) });
});

router.post("/facets", async (req, res) => res.json(await facets(req.session.userId!, filterFrom(req))));

/** Sector for every contact that has none — or for all, when the rules have improved. */
router.post("/contacts/classify", async (req, res) => {
  const userId = req.session.userId!;
  const all = req.body?.all === true;
  const rows = await db.select({ id: emailContactsTable.id, company: emailContactsTable.company, industry: emailContactsTable.industry, source: emailContactsTable.source, sector: emailContactsTable.sector })
    .from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), all ? sql`true` : sql`${emailContactsTable.sector} is null`));
  // The list a contact is in says something too: "real-estate-companies-ALL".
  const lists = await db.select({ contactId: emailListMembersTable.contactId, name: emailListsTable.name }).from(emailListMembersTable)
    .innerJoin(emailListsTable, eq(emailListsTable.id, emailListMembersTable.listId)).where(eq(emailListsTable.userId, userId));
  const listOf = new Map<number, string>(); for (const l of lists) if (!listOf.has(l.contactId)) listOf.set(l.contactId, l.name);
  const bySector = new Map<string, number[]>();
  for (const r of rows) {
    const sector = classifySector({ industry: r.industry, company: r.company, hint: [listOf.get(r.id), r.source].filter(Boolean).join(" ") });
    if (!sector || sector === r.sector) continue;
    bySector.set(sector, [...(bySector.get(sector) ?? []), r.id]);
  }
  let updated = 0;
  for (const [sector, ids] of bySector) {
    for (let i = 0; i < ids.length; i += 1000) {
      await db.update(emailContactsTable).set({ sector }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
    }
    updated += ids.length;
  }
  res.json({ checked: rows.length, updated, bySector: Object.fromEntries([...bySector].map(([k, v]) => [k, v.length])) });
});

router.get("/sectors", (_req, res) => res.json({ sectors: SECTORS, unclassified: UNCLASSIFIED }));

/**
 * One action on many contacts: the ticked ones (`ids`) or everyone the
 * filter selects (`filter`). Add to a list, a new list, set the sector,
 * enrol in a sequence, stop or restart them.
 */
router.post("/contacts/bulk", async (req, res) => {
  const userId = req.session.userId!;
  const b: any = req.body ?? {};
  let ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length && b.filter) ids = (await resolveSegment(userId, cleanFilter(b.filter))).map((c) => c.id);
  if (!ids.length) return res.status(400).json({ error: "لم تختر أحداً" });
  // Only this account's contacts, whatever was posted.
  ids = (await db.select({ id: emailContactsTable.id }).from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), inArray(emailContactsTable.id, ids)))).map((r) => r.id);

  const addTo = async (listId: number) => {
    for (let i = 0; i < ids.length; i += 1000) await db.insert(emailListMembersTable).values(ids.slice(i, i + 1000).map((contactId) => ({ listId, contactId }))).onConflictDoNothing();
  };
  switch (b.action) {
    case "addToList": {
      const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, Number(b.listId)), eq(emailListsTable.userId, userId))).limit(1);
      if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
      await addTo(l.id); return res.json({ done: ids.length, list: l });
    }
    case "newList": {
      const [l] = await db.insert(emailListsTable).values({ userId, name: String(b.name ?? "قائمة").slice(0, 160), description: b.description ?? null, folderId: Number(b.folderId) || null }).returning();
      await addTo(l!.id); return res.json({ done: ids.length, list: l });
    }
    case "setSector": {
      const sector = String(b.sector ?? "").trim().slice(0, 60) || null;
      for (let i = 0; i < ids.length; i += 1000) await db.update(emailContactsTable).set({ sector }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
      return res.json({ done: ids.length });
    }
    case "enrol": {
      try { await assertCanSend(userId); } catch (err) { if (planErrorToResponse(err, res)) return; throw err; }
      return res.json(await enrolInSequence(userId, Number(b.sequenceId), ids));
    }
    case "unsubscribe": case "activate": {
      const status = b.action === "activate" ? "active" : "unsubscribed";
      for (let i = 0; i < ids.length; i += 1000) await db.update(emailContactsTable).set({ status }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
      if (status !== "active") for (const id of ids) await cancelSequencesFor(userId, id, "أوقفه صاحب العمل");
      return res.json({ done: ids.length });
    }
    case "delete": return res.json(await deleteContacts(userId, ids));
  }
  res.status(400).json({ error: "إجراء غير معروف" });
});

// ── Segments ──────────────────────────────────────────────────────
router.get("/segments", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select().from(emailSegmentsTable).where(eq(emailSegmentsTable.userId, userId)).orderBy(desc(emailSegmentsTable.createdAt));
  res.json(await Promise.all(rows.map(async (sg) => ({ ...sg, description: describeSegment(sg.filter as any), count: await countSegment(userId, sg.filter as any), sendable: await countSegment(userId, sg.filter as any, true) }))));
});
router.post("/segments", async (req, res) => {
  const f = cleanFilter(req.body?.filter);
  const [row] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: String(req.body?.name ?? describeSegment(f)).slice(0, 160), filter: f }).returning();
  res.status(201).json(row);
});
router.delete("/segments/:id", async (req, res) => {
  await db.delete(emailSegmentsTable).where(and(eq(emailSegmentsTable.id, Number(req.params.id)), eq(emailSegmentsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── نورة ──────────────────────────────────────────────────────────
router.get("/agent", async (req, res) => {
  const userId = req.session.userId!;
  const agent = await ensureEmailAgent(userId);
  const mem = await agentMemory(userId);
  res.json({ agent, memory: mem, topics: [...new Set(mem.map((m) => m.topic).filter(Boolean))], sectors: SECTORS });
});
router.patch("/agent", async (req, res) => {
  const userId = req.session.userId!;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "title", "persona"] as const) if (typeof req.body?.[k] === "string") set[k] = req.body[k].slice(0, k === "persona" ? 3000 : 120);
  const [row] = await db.update(botEmployeesTable).set(set).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, EMAIL_ROLE))).returning();
  res.json(row ?? null);
});
/** Teach her: text in the owner's words, or a pasted document; she splits it into facts. */
router.post("/agent/teach", upload.single("file"), async (req, res) => {
  const userId = req.session.userId!;
  let text = String(req.body?.text ?? "");
  if (req.file) {
    const name = req.file.originalname.toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(name)) {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      text += "\n\n" + wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n\n");
    } else {
      text += "\n\n" + req.file.buffer.toString("utf8");
    }
  }
  if (!text.trim()) return res.status(400).json({ error: "اكتب ما تريد أن تتعلمه أو ارفع ملفاً نصياً" });
  const topic = typeof req.body?.topic === "string" && req.body.topic.trim() ? req.body.topic.trim().slice(0, 80) : null;
  res.json({ saved: await teach(userId, text, topic) });
});
router.post("/agent/memory", async (req, res) => {
  const userId = req.session.userId!;
  await ensureEmailAgent(userId);
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "فارغ" });
  await rememberKnowledge(userId, content, req.body?.topic ? String(req.body.topic).slice(0, 80) : null);
  res.json({ ok: true });
});
router.patch("/agent/memory/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.content === "string") set["content"] = req.body.content.slice(0, 1500);
  if (req.body?.topic !== undefined) set["topic"] = req.body.topic ? String(req.body.topic).slice(0, 80) : null;
  const [row] = await db.update(agentMemoryTable).set(set).where(and(eq(agentMemoryTable.id, Number(req.params.id)), eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.role, EMAIL_ROLE))).returning();
  res.json(row ?? null);
});
router.delete("/agent/memory/:id", async (req, res) => {
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.id, Number(req.params.id)), eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.role, EMAIL_ROLE)));
  res.json({ ok: true });
});
/** She writes a campaign for the target the owner picked. Nothing is sent. */
router.post("/agent/write", async (req, res) => {
  const userId = req.session.userId!;
  const goal = String(req.body?.goal ?? "").trim();
  if (!goal) return res.status(400).json({ error: "اكتب الهدف" });
  const out = await writeCampaign(userId, { filter: cleanFilter(req.body?.filter), goal, language: req.body?.language, tone: req.body?.tone, notes: req.body?.notes });
  if (!out) return res.status(502).json({ error: "تعذّرت الكتابة — النموذج لم يستجب أو خرج عن الشكل. جرّب مرة أخرى." });
  res.json(out);
});
/** Turn an approved draft into a campaign (with the subject test) and its two follow-up sequences. */
router.post("/agent/launch", async (req, res) => {
  const userId = req.session.userId!;
  const d = req.body?.draft;
  if (!d?.subjects?.length || !d?.html) return res.status(400).json({ error: "المسودة ناقصة" });
  const m = await createMission(userId, { name: String(req.body?.name ?? d.subjects[0]).slice(0, 160), goal: String(req.body?.goal ?? ""), filter: cleanFilter(req.body?.filter), language: req.body?.language, tone: req.body?.tone, requireApproval: true, followAfterHours: req.body?.followAfterHours });
  await db.update(emailMissionsTable).set({ stage: "awaiting_approval", pending: d }).where(eq(emailMissionsTable.id, m.id));
  try { await assertCanSend(userId); await approveMission(userId, m.id, d); }
  catch (err: any) { if (planErrorToResponse(err, res)) return; return res.status(400).json({ error: String(err?.message ?? err), missionId: m.id }); }
  res.json({ missionId: m.id });
});

// ── Missions ──────────────────────────────────────────────────────
router.get("/missions", async (req, res) => res.json(await missionsFor(req.session.userId!)));
router.post("/missions", async (req, res) => {
  const userId = req.session.userId!;
  const b = req.body ?? {};
  if (!String(b.goal ?? "").trim()) return res.status(400).json({ error: "اكتب هدف المهمة" });
  const f = cleanFilter(b.filter);
  await ensureEmailAgent(userId);
  const m = await createMission(userId, { name: String(b.name || describeSegment(f)), goal: String(b.goal), filter: f, language: b.language, tone: b.tone, requireApproval: b.requireApproval !== false, followAfterHours: b.followAfterHours });
  // Write straight away rather than at the next sweep — the owner is watching.
  void runMission(m).catch(() => {});
  res.status(201).json(m);
});
router.post("/missions/:id/approve", async (req, res) => {
  try { await assertCanSend(req.session.userId!); await approveMission(req.session.userId!, Number(req.params.id), req.body?.draft); res.json({ ok: true }); }
  catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.post("/missions/:id/audience", async (req, res) => {
  try { await setMissionAudience(req.session.userId!, Number(req.params.id), cleanFilter(req.body?.filter)); res.json({ ok: true }); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.post("/missions/:id/redraft", async (req, res) => {
  const [m] = await db.update(emailMissionsTable).set({ stage: "draft", pending: null, goal: req.body?.goal ? String(req.body.goal).slice(0, 2000) : sql`${emailMissionsTable.goal}` as any })
    .where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!), inArray(emailMissionsTable.stage, ["draft", "awaiting_approval"]))).returning();
  if (!m) return res.status(400).json({ error: "المهمة بدأت الإرسال — لا يمكن إعادة كتابتها" });
  void runMission(m).catch(() => {});
  res.json({ ok: true });
});
for (const action of ["pause", "resume"] as const) {
  router.post(`/missions/:id/${action}`, async (req, res) => {
    await db.update(emailMissionsTable).set({ status: action === "pause" ? "paused" : "active" })
      .where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!)));
    res.json({ ok: true });
  });
}
router.post("/missions/:id/run", async (req, res) => {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!))).limit(1);
  if (!m) return res.status(404).json({ error: "غير موجودة" });
  await runMission(m); res.json({ ok: true });
});
router.get("/missions/:id/report", async (req, res) => {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!))).limit(1);
  if (!m) return res.status(404).json({ error: "غير موجودة" });
  res.json(m.report ?? await missionReport(m));
});
router.delete("/missions/:id", async (req, res) => {
  await db.delete(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Lists ─────────────────────────────────────────────────────────
// Each list with what is in it, in one query: how many, how many can be
// written to, how many unsubscribed or bounced, with a WhatsApp number,
// reached, opened, replied, its main sector and when it was last written to.
async function listStats(userId: number, listId?: number) {
  const r = await db.execute(sql`
    SELECT l.id, l.name, l.description, l.folder_id AS "folderId", l.created_at AS "createdAt", l.parent_list_id AS "parentListId", l.stage,
      count(c.id)::int AS count,
      (count(c.id) FILTER (WHERE c.status = 'active' AND coalesce(c.mx_ok, true)))::int AS sendable,
      (count(c.id) FILTER (WHERE c.status IN ('unsubscribed','complained')))::int AS unsubscribed,
      (count(c.id) FILTER (WHERE c.status = 'bounced' OR c.mx_ok = false))::int AS bounced,
      (count(c.id) FILTER (WHERE c.phone IS NOT NULL))::int AS "withPhone",
      (count(c.id) FILTER (WHERE c.last_sent_at IS NOT NULL))::int AS reached,
      (count(c.id) FILTER (WHERE c.last_opened_at IS NOT NULL))::int AS opened,
      (count(c.id) FILTER (WHERE c.last_replied_at IS NOT NULL))::int AS replied,
      mode() WITHIN GROUP (ORDER BY c.sector) AS sector,
      max(c.last_sent_at) AS "lastSentAt"
    FROM email_lists l
    LEFT JOIN email_list_members m ON m.list_id = l.id
    LEFT JOIN email_contacts c ON c.id = m.contact_id
    WHERE l.user_id = ${userId} ${listId ? sql`AND l.id = ${listId}` : sql``}
    GROUP BY l.id
    ORDER BY l.created_at DESC`);
  return r.rows as any[];
}

router.get("/lists", async (req, res) => res.json(await listStats(req.session.userId!)));

router.get("/lists/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [l] = await listStats(userId, Number(req.params.id));
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const f = { listIds: [l.id] };
  const [fac, campaigns] = await Promise.all([
    facets(userId, f),
    db.select({ id: emailCampaignsTable.id, name: emailCampaignsTable.name, status: emailCampaignsTable.status, sentCount: emailCampaignsTable.sentCount, openCount: emailCampaignsTable.openCount, replyCount: emailCampaignsTable.replyCount, createdAt: emailCampaignsTable.createdAt })
      .from(emailCampaignsTable).where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.listId, l.id))).orderBy(desc(emailCampaignsTable.createdAt)).limit(10),
  ]);
  res.json({ list: l, facets: fac, campaigns });
});

router.post("/lists", async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: "اكتب اسم القائمة" });
  const [l] = await db.insert(emailListsTable).values({ userId: req.session.userId!, name, description: req.body?.description ?? null, folderId: Number(req.body?.folderId) || null }).returning();
  res.status(201).json(l);
});

router.patch("/lists/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) set["name"] = req.body.name.trim().slice(0, 160);
  if (req.body?.description !== undefined) set["description"] = req.body.description ? String(req.body.description).slice(0, 500) : null;
  if (!Object.keys(set).length) return res.status(400).json({ error: "لا تغيير" });
  const [l] = await db.update(emailListsTable).set(set).where(and(eq(emailListsTable.id, Number(req.params.id)), eq(emailListsTable.userId, req.session.userId!))).returning();
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  res.json(l);
});

/** Take contacts out of a list; they stay in the audience and in other lists. */
// سلمى's reading of a list, and the chain run again on demand.
router.get("/lists/:id/analysis", async (req, res) => {
  const [l] = await db.select({ analysis: emailListsTable.analysis, analyzedAt: emailListsTable.analyzedAt }).from(emailListsTable)
    .where(and(eq(emailListsTable.id, Number(req.params.id)), eq(emailListsTable.userId, req.session.userId!))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const missions = await db.select({ id: emailMissionsTable.id, name: emailMissionsTable.name, stage: emailMissionsTable.stage, status: emailMissionsTable.status, createdAt: emailMissionsTable.createdAt })
    .from(emailMissionsTable).where(and(eq(emailMissionsTable.userId, req.session.userId!), eq(emailMissionsTable.sourceListId, Number(req.params.id)))).orderBy(desc(emailMissionsTable.createdAt)).limit(10);
  res.json({ ...l, missions });
});
router.post("/lists/:id/pipeline", async (req, res) => {
  const userId = req.session.userId!, id = Number(req.params.id);
  setImmediate(() => { runPipeline(userId, id).catch((err) => logger.warn({ userId, listId: id, err: String(err?.message ?? err) }, "list pipeline failed")); });
  res.json({ started: true });
});

router.post("/lists/:id/remove", async (req, res) => {
  const userId = req.session.userId!;
  const listId = Number(req.params.id);
  const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "لم تختر أحداً" });
  let removed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await db.delete(emailListMembersTable).where(and(eq(emailListMembersTable.listId, listId), inArray(emailListMembersTable.contactId, ids.slice(i, i + 1000)))).returning({ id: emailListMembersTable.contactId });
    removed += r.length;
  }
  res.json({ removed });
});

/** The list as a CSV the owner can open in Excel. */
router.get("/lists/:id/export", async (req, res) => {
  const userId = req.session.userId!;
  const listId = Number(req.params.id);
  const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const rows = await db.select({ c: emailContactsTable }).from(emailListMembersTable)
    .innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
    .where(eq(emailListMembersTable.listId, listId)).orderBy(emailContactsTable.company);
  const cell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v instanceof Date ? v.toISOString().slice(0, 10) : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["email", "company", "name", "phone", "sector", "city", "status", "last_sent", "last_opened", "last_replied"];
  const body = rows.map(({ c }) => [c.email, c.company, c.name, c.phone, c.sector, c.city, c.status, c.lastSentAt, c.lastOpenedAt, c.lastRepliedAt].map(cell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(l.name)}.csv`);
  res.send("\uFEFF" + [head.join(","), ...body].join("\n"));
});
/** A list goes; with `?contacts=1` its addresses go too (those in no other list). */
router.delete("/lists/:id", async (req, res) => {
  const r = await deleteList(req.session.userId!, Number(req.params.id), req.query["contacts"] === "1");
  if (!r) return res.status(404).json({ error: "القائمة غير موجودة" });
  res.json(r);
});

/**
 * The import. A spreadsheet as it came (multipart `file`) or rows already
 * parsed by the browser (`rows`), and options: which list, whether to
 * split by industry or city into sub-lists, whether to check MX, and which
 * sequence to enrol everyone in. Reports exactly what was kept and why
 * the rest was not.
 */
router.post("/contacts/import", upload.single("file"), async (req, res) => {
  const userId = req.session.userId!;
  const body: any = req.body ?? {};
  let rawRows: Array<Record<string, unknown>> = [];
  let fileName = "";
  const country = String(body.country ?? "AE").toUpperCase().slice(0, 2);
  // Rows the shared reader found, for the WhatsApp half: every sheet, the
  // header row wherever it is, every number column, each row's country.
  let parsed: ReturnType<typeof parseTables> | null = null;
  if (req.file) {
    fileName = req.file.originalname;
    try { parsed = parseTables(readWorkbook(req.file.buffer), country); }
    catch { return res.status(400).json({ error: "تعذّر قراءة الملف — تأكد أنه Excel أو CSV" }); }
    // One row per address, not per line of the file. A company with "Email"
    // and "Email 2", or two addresses in one cell, used to contribute exactly
    // one — the reader kept only the first match. Each address carries its own
    // company, which is the pairing the owner actually wants; only the first
    // keeps the person's name, since a second address on the same line belongs
    // to the company rather than to that person.
    rawRows = parsed.rows.flatMap((r) => {
      const found = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
      const common = { name: "", company: r.company ?? "", phone: r.whatsapp?.e164 ?? "", industry: r.industry ?? "", city: r.city ?? "" };
      if (!found.length) return [{ email: "", ...common, name: r.person ?? "" }];
      return found.map((email, i) => ({ ...common, email, name: i === 0 ? (r.person ?? "") : "" }));
    });
  } else if (Array.isArray(body.rows)) {
    rawRows = body.rows;
  } else if (typeof body.rows === "string") {
    try { rawRows = JSON.parse(body.rows); } catch { rawRows = []; }
  } else if (typeof body.text === "string") {
    // Pasted emails, one per line or comma-separated.
    rawRows = String(body.text).split(/[\n,;\s]+/).filter(Boolean).map((email) => ({ email }));
  }
  if (!rawRows.length) return res.status(400).json({ error: "لم أجد صفوفاً في الملف" });
  const out = await importRows(userId, rawRows, parsed, fileName, body);
  res.status(out.status).json(out.json);
});

/** What the file looks like before committing to it. */
router.post("/contacts/preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع ملفاً" });
  const country = String(req.body?.country ?? "AE").toUpperCase().slice(0, 2);
  let parsed: ReturnType<typeof parseTables>;
  try { parsed = parseTables(readWorkbook(req.file.buffer), country); }
  catch { return res.status(400).json({ error: "تعذّر قراءة الملف — تأكد أنه Excel أو CSV" }); }
  const rows = parsed.rows.map((r) => ({ email: r.email ?? "", name: r.person ?? "", company: r.company ?? "", phone: r.whatsapp?.e164 ?? "", industry: r.industry ?? "", city: r.city ?? "" }));
  const columns = { email: "email", name: "name", company: "company", phone: "phone", industry: "industry", city: "city" } as ReturnType<typeof detectColumns>;
  const report = cleanRows(rows, columns);
  const wa = whatsappEntries(parsed.rows);
  // The columns as found in the file, for the owner to check.
  const found = parsed.sheets[0]?.columns ?? {};
  const shown = { email: found["email"] ?? null, company: found["company"] ?? null, name: found["person"] ?? null, phone: found["phones"] ?? null, industry: found["industry"] ?? null, city: found["city"] ?? null };
  const byIndustry = [...splitBy(report.rows, "industry")].map(([k, v]) => ({ key: k, n: v.length })).sort((a, b) => b.n - a.n).slice(0, 20);
  const byCity = [...splitBy(report.rows, "city")].map(([k, v]) => ({ key: k, n: v.length })).sort((a, b) => b.n - a.n).slice(0, 20);
  res.json({ file: req.file.originalname, sheets: parsed.sheets, columns: shown, total: report.total, kept: report.kept, invalid: report.invalid, duplicates: report.duplicates, roleAddresses: report.roleAddresses, sample: report.sample, byIndustry, byCity,
    whatsapp: { numbers: wa.entries.length, landlineOnly: parsed.landlineOnly, duplicates: wa.duplicates, withoutEmail: parsed.rows.filter((r) => r.whatsapp && !r.email).length, byCountry: parsed.byCountry } });
});

router.patch("/contacts/:id", async (req, res) => {
  const userId = req.session.userId!;
  const set: Record<string, unknown> = {};
  for (const k of ["name", "company", "phone", "industry", "city", "status"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  const [row] = await db.update(emailContactsTable).set(set).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, userId))).returning();
  if (row && set["status"] && set["status"] !== "active") await cancelSequencesFor(userId, row.id, "أوقفه صاحب العمل");
  res.json(row ?? null);
});
router.delete("/contacts/:id", async (req, res) => {
  await db.delete(emailContactsTable).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.get("/contacts/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "غير موجود" });
  const [messages, inbound, jobs] = await Promise.all([
    db.select().from(emailMessagesTable).where(eq(emailMessagesTable.contactId, c.id)).orderBy(desc(emailMessagesTable.createdAt)).limit(30),
    db.select().from(emailInboundTable).where(eq(emailInboundTable.contactId, c.id)).orderBy(desc(emailInboundTable.receivedAt)).limit(30),
    db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.contactId, c.id)).orderBy(emailSequenceJobsTable.dueAt),
  ]);
  res.json({ contact: c, messages, inbound, jobs });
});

// ── Templates ─────────────────────────────────────────────────────
router.get("/templates", async (req, res) => res.json(await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.userId, req.session.userId!)).orderBy(desc(emailTemplatesTable.updatedAt))));
router.post("/templates", async (req, res) => {
  const { name, subject, html, category } = req.body ?? {};
  if (!name || !subject || !html) return res.status(400).json({ error: "الاسم والعنوان والمحتوى مطلوبة" });
  const [t] = await db.insert(emailTemplatesTable).values({ userId: req.session.userId!, name: String(name).slice(0, 160), subject: String(subject).slice(0, 300), html: String(html), category: category ?? null }).returning();
  res.status(201).json(t);
});
router.patch("/templates/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "subject", "html", "category"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  const [t] = await db.update(emailTemplatesTable).set(set).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, req.session.userId!))).returning();
  res.json(t ?? null);
});
router.delete("/templates/:id", async (req, res) => {
  await db.delete(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
/**
 * Who a preview is personalised for: a real contact — from the campaign's list
 * when there is one, else the account's — so the owner sees what recipients
 * get ("Hello there," for a company without a person's name), not a made-up
 * Khalid every time. Falls back to a sample only on an empty account.
 */
async function previewVars(userId: number, s: Awaited<ReturnType<typeof getSettings>>, opts: { listId?: number | null; contactId?: number | null } = {}) {
  const active = and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.status, "active"));
  let [c] = opts.contactId ? await db.select().from(emailContactsTable).where(and(active, eq(emailContactsTable.id, opts.contactId))).limit(1) : [];
  if (!c && opts.listId) [c] = await db.select({ c: emailContactsTable }).from(emailListMembersTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
    .where(and(active, eq(emailListMembersTable.listId, opts.listId))).orderBy(sql`random()`).limit(1).then((r) => r.map((x) => x.c));
  if (!c) [c] = await db.select().from(emailContactsTable).where(and(active, sql`coalesce(${emailContactsTable.company}, '') <> ''`)).orderBy(sql`random()`).limit(1);
  if (c) return { vars: varsFor(c, s), to: { id: c.id, email: c.email, company: c.company, name: c.name } };
  return { vars: { company: "Al Noor Real Estate", city: "Dubai", sender: s?.fromName ?? "", sender_email: s?.fromEmail ?? "" }, to: null };
}

/** A template rendered as it will arrive, for a real contact — the gallery shows it in a frame. */
router.get("/templates/:id/render", async (req, res) => {
  const userId = req.session.userId!;
  const [t] = await db.select().from(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, userId))).limit(1);
  if (!t) return res.status(404).send("not found");
  const s = await getSettings(userId);
  const { vars } = await previewVars(userId, s);
  const r = renderEmail(t.html + (s?.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), vars,
    { base: "", token: "preview", secret: "x", pixel: false, links: false },
    { base: "", token: "preview", fromName: s?.fromName ?? "", fromEmail: s?.fromEmail ?? "" }, brandOf(s));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(r.html);
});
router.post("/templates/seed", async (req, res) => res.json(await seedEmailDefaults(req.session.userId!, true)));
router.post("/preview", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  const { vars, to } = await previewVars(req.session.userId!, s, { listId: Number(req.body?.listId) || null, contactId: Number(req.body?.contactId) || null });
  const r = renderEmail(String(req.body?.html ?? "") + (s?.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), vars,
    { base: "", token: "preview", secret: "x", pixel: false, links: false },
    { base: "", token: "preview", fromName: s?.fromName ?? "بروكاونت", fromEmail: s?.fromEmail ?? "hello@example.com" }, brandOf(s));
  res.json({ subject: personalize(String(req.body?.subject ?? ""), vars), html: r.html, text: r.text, to });
});

// ── List hygiene ─────────────────────────────────────────────────
router.get("/hygiene", async (req, res) => res.json(await hygieneReport(req.session.userId!, Number(req.query["listId"]) || null)));
router.post("/hygiene/verify", async (req, res) => {
  const listId = Number(req.body?.listId) || null;
  const ids = listId ? (await db.select({ id: emailListMembersTable.contactId }).from(emailListMembersTable).where(eq(emailListMembersTable.listId, listId))).map((r) => r.id) : undefined;
  try { res.json(await verifyDomains(req.session.userId!, ids)); } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.post("/hygiene/clean", async (req, res) => {
  const listId = Number(req.body?.listId);
  const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, req.session.userId!))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  res.json(await cleanList(req.session.userId!, listId, { risky: !!req.body?.risky }));
});
router.get("/warmup", async (req, res) => {
  const userId = req.session.userId!;
  const s = await getSettings(userId);
  const sig = await signals(userId);
  res.json({ on: s?.warmup ?? true, ageDays: sig.senderAgeDays, dailyCap: s?.dailyCap ?? 300, today: warmupCap(s?.dailyCap ?? 300, sig.senderAgeDays, s?.warmup ?? true), plan: warmupPlan(s?.dailyCap ?? 300, sig.senderAgeDays, s?.warmup ?? true) });
});

// ── Campaigns ─────────────────────────────────────────────────────
router.get("/campaigns", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select({ c: emailCampaignsTable, list: sql<string | null>`coalesce(${emailListsTable.name}, ${emailSegmentsTable.name})`, filter: emailSegmentsTable.filter,
    queued: sql<number>`(select count(*) from email_messages m where m.campaign_id = ${emailCampaignsTable.id} and m.status in ('queued','ab_hold'))`,
    members: sql<number>`(select count(*) from email_list_members m join email_contacts c on c.id = m.contact_id where m.list_id = ${emailCampaignsTable.listId} and c.status = 'active' and coalesce(c.mx_ok, true))` }).from(emailCampaignsTable)
    .leftJoin(emailListsTable, eq(emailListsTable.id, emailCampaignsTable.listId))
    .leftJoin(emailSegmentsTable, eq(emailSegmentsTable.id, emailCampaignsTable.segmentId))
    .where(eq(emailCampaignsTable.userId, userId)).orderBy(desc(emailCampaignsTable.createdAt));
  // Who it will reach: a list's writable members, or a saved audience counted now.
  res.json(await Promise.all(rows.map(async (r) => ({ ...r.c, listName: r.list, queued: Number(r.queued),
    audience: r.c.segmentId ? await countSegment(userId, (r.filter ?? {}) as any, true) : Number(r.members) }))));
});
router.post("/campaigns", async (req, res) => {
  const { name, listId, subject, html, scheduledAt, subjectB, abPct, abWaitHours } = req.body ?? {};
  if (!name || !subject || !html) return res.status(400).json({ error: "الاسم والعنوان والمحتوى مطلوبة" });
  // A saved segment, or a filter picked on the spot (saved as a segment).
  let segmentId = Number(req.body?.segmentId) || null;
  // A folder: every list in it, resolved when the campaign starts.
  const folderId = Number(req.body?.folderId) || null;
  if (!segmentId && folderId && !listId) {
    const [fo] = await db.select().from(listFoldersTable).where(and(eq(listFoldersTable.id, folderId), eq(listFoldersTable.userId, req.session.userId!), eq(listFoldersTable.kind, "email"))).limit(1);
    if (!fo) return res.status(404).json({ error: "المجلد غير موجود" });
    const [sg] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: `مجلد ${fo.name}`.slice(0, 160), filter: { folderIds: [fo.id] } }).returning();
    segmentId = sg!.id;
  }
  if (!segmentId && req.body?.filter && !listId) {
    const f = cleanFilter(req.body.filter);
    const [sg] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: `${String(name).slice(0, 100)} — ${describeSegment(f)}`.slice(0, 160), filter: f }).returning();
    segmentId = sg!.id;
  }
  const [c] = await db.insert(emailCampaignsTable).values({
    userId: req.session.userId!, name: String(name).slice(0, 160), listId: Number(listId) || null, segmentId, subject: String(subject).slice(0, 300), html: String(html),
    status: scheduledAt ? "scheduled" : "draft", scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    // English unless the owner picked another for this campaign.
    language: ["en", "ar", "both"].includes(req.body?.language) ? req.body.language : ((await getSettings(req.session.userId!))?.defaultLanguage ?? "en"),
    subjectB: subjectB ? String(subjectB).slice(0, 300) : null,
    abPct: subjectB ? Math.min(50, Math.max(0, Number(abPct) || 20)) : 0,
    abWaitHours: Math.min(48, Math.max(1, Number(abWaitHours) || 4)),
  }).returning();
  res.status(201).json(c);
});
router.patch("/campaigns/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  for (const k of ["name", "subject", "html", "subjectB"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  if (["en", "ar", "both"].includes(req.body?.language)) set["language"] = req.body.language;
  if (req.body?.abPct !== undefined) set["abPct"] = Math.min(50, Math.max(0, Number(req.body.abPct) || 0));
  if (req.body?.abWaitHours !== undefined) set["abWaitHours"] = Math.min(48, Math.max(1, Number(req.body.abWaitHours) || 4));
  if (req.body?.listId !== undefined) set["listId"] = Number(req.body.listId) || null;
  if (req.body?.scheduledAt !== undefined) { set["scheduledAt"] = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null; set["status"] = req.body.scheduledAt ? "scheduled" : "draft"; }
  const [c] = await db.update(emailCampaignsTable).set(set).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, req.session.userId!), inArray(emailCampaignsTable.status, ["draft", "scheduled", "paused"]))).returning();
  res.json(c ?? null);
});
router.post("/campaigns/:id/start", async (req, res) => {
  try {
    await assertCanSend(req.session.userId!);
    res.json(await startCampaign(req.session.userId!, Number(req.params.id)));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
/** The campaign as it will arrive, sent to the owner's own address (or `to`) — personalised for the first contact in its audience. */
router.post("/campaigns/:id/test", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  const s = await getSettings(userId);
  if (!isConfigured(s)) return res.status(400).json({ error: "إعدادات البريد غير مكتملة — اضبط المُرسِل أولاً" });
  const to = String(req.body?.to ?? s!.fromEmail).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: "بريد الاستلام غير صالح" });
  const { vars } = await previewVars(userId, s, { listId: c.listId });
  const token = newToken();
  const r = renderEmail(c.html + (s!.signature ? `<div style="margin-top:20px">${s!.signature}</div>` : ""), vars,
    { base: "", token, secret: "x", pixel: false, links: false },
    { base: "", token, fromName: s!.fromName ?? s!.fromEmail!, fromEmail: s!.fromEmail! }, brandOf(s));
  try {
    await sendEmail(s!, { to, subject: `[Test] ${personalize(c.subject, vars)}`, html: r.html, text: r.text, messageId: messageIdFor(token, s!.fromEmail!), unsubscribeUrl: null });
    res.json({ ok: true, to });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A copy of a campaign as a new draft — same audience, same content, nothing sent. */
router.post("/campaigns/:id/duplicate", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  const [d] = await db.insert(emailCampaignsTable).values({ userId, name: `${c.name} (نسخة)`.slice(0, 160), listId: c.listId, segmentId: c.segmentId, subject: c.subject, html: c.html, subjectB: c.subjectB, abPct: c.abPct, abWaitHours: c.abWaitHours, status: "draft" }).returning();
  res.status(201).json(d);
});

router.post("/campaigns/:id/pause", async (req, res) => { await pauseCampaign(req.session.userId!, Number(req.params.id), "إيقاف يدوي"); res.json({ ok: true }); });
router.delete("/campaigns/:id", async (req, res) => {
  const userId = req.session.userId!, id = Number(req.params.id);
  // What it had not sent yet goes with it, and its mission ends: left behind,
  // the messages were picked by the sender and failed one a round, and the
  // mission kept its list «busy» so no new wave could ever start there.
  await db.update(emailMessagesTable).set({ status: "cancelled", error: "ألغيت: حُذفت الحملة" })
    .where(and(eq(emailMessagesTable.userId, userId), eq(emailMessagesTable.campaignId, id), inArray(emailMessagesTable.status, ["queued", "ab_hold"])));
  await db.update(emailMissionsTable).set({ stage: "done" })
    .where(and(eq(emailMissionsTable.userId, userId), eq(emailMissionsTable.campaignId, id)));
  await db.delete(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, id), eq(emailCampaignsTable.userId, userId)));
  res.json({ ok: true });
});
router.get("/campaigns/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "غير موجود" });
  const [recipients, [funnel], byHour] = await Promise.all([
    db.select({ m: emailMessagesTable, name: emailContactsTable.name, company: emailContactsTable.company }).from(emailMessagesTable)
      .leftJoin(emailContactsTable, eq(emailContactsTable.id, emailMessagesTable.contactId))
      .where(eq(emailMessagesTable.campaignId, c.id)).orderBy(desc(emailMessagesTable.sentAt)).limit(2000),
    db.select({
      queued: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('queued','ab_hold'))`,
      held:   sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'ab_hold')`,
      sent: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('sent','bounced'))`,
      opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
      clicked: sql<number>`count(*) filter (where ${emailMessagesTable.clickedAt} is not null)`,
      replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
      bounced: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'bounced')`,
      failed: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'failed')`,
    }).from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, c.id)),
    db.select({ h: sql<string>`to_char(date_trunc('hour', ${emailEventsTable.createdAt}), 'YYYY-MM-DD HH24:00')`, type: emailEventsTable.type, n: sql<number>`count(*)` })
      .from(emailEventsTable).innerJoin(emailMessagesTable, eq(emailMessagesTable.id, emailEventsTable.messageId))
      .where(eq(emailMessagesTable.campaignId, c.id)).groupBy(sql`1`, emailEventsTable.type).orderBy(sql`1`),
  ]);
  const variants = c.abPct > 0 ? await db.select({
    v: emailMessagesTable.variant,
    sent: sql<number>`count(*) filter (where ${emailMessagesTable.sentAt} is not null)`,
    opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
    replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
  }).from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, c.id), sql`${emailMessagesTable.variant} is not null`, sql`${emailMessagesTable.createdAt} <= coalesce(${c.abDecidedAt ?? null}::timestamptz, now())`))
    .groupBy(emailMessagesTable.variant) : [];
  res.json({ campaign: c, funnel: Object.fromEntries(Object.entries(funnel ?? {}).map(([k, v]) => [k, Number(v)])),
    ab: c.abPct > 0 ? { winner: c.abWinner, decidedAt: c.abDecidedAt, variants: variants.map((x) => ({ variant: x.v, sent: Number(x.sent), opened: Number(x.opened), replied: Number(x.replied) })) } : null,
    recipients: recipients.map((r) => ({ ...r.m, name: r.name, company: r.company })), timeline: byHour.map((r) => ({ hour: r.h, type: r.type, n: Number(r.n) })) });
});

// ── Sequences ─────────────────────────────────────────────────────
router.get("/sequences", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select({
    s: emailSequencesTable,
    pending: sql<number>`(select count(*) from email_sequence_jobs j where j.sequence_id = ${emailSequencesTable.id} and j.status = 'pending')`,
    sent: sql<number>`(select count(*) from email_sequence_jobs j where j.sequence_id = ${emailSequencesTable.id} and j.status = 'sent')`,
  }).from(emailSequencesTable).where(eq(emailSequencesTable.userId, userId)).orderBy(desc(emailSequencesTable.createdAt));
  res.json(rows.map((r) => ({ ...r.s, pending: Number(r.pending), sent: Number(r.sent), isDefault: r.s.name === DEFAULT_SEQUENCE_NAME })));
});
router.post("/sequences", async (req, res) => {
  const { name, steps, stopOnReply, stopOnOpen } = req.body ?? {};
  if (!name || !Array.isArray(steps) || !steps.length) return res.status(400).json({ error: "الاسم وخطوة واحدة على الأقل" });
  const clean: EmailStep[] = steps.map((s: any) => ({ afterHours: Math.max(0, Number(s.afterHours) || 0), subject: String(s.subject ?? "").slice(0, 300), html: String(s.html ?? "") })).filter((s: EmailStep) => s.subject && s.html);
  const [row] = await db.insert(emailSequencesTable).values({ userId: req.session.userId!, name: String(name).slice(0, 160), steps: clean, stopOnReply: stopOnReply !== false, stopOnOpen: !!stopOnOpen }).returning();
  res.status(201).json(row);
});
router.patch("/sequences/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (req.body?.name !== undefined) set["name"] = String(req.body.name).slice(0, 160);
  if (Array.isArray(req.body?.steps)) set["steps"] = req.body.steps.map((s: any) => ({ afterHours: Math.max(0, Number(s.afterHours) || 0), subject: String(s.subject ?? "").slice(0, 300), html: String(s.html ?? "") }));
  for (const k of ["stopOnReply", "stopOnOpen", "isActive"] as const) if (req.body?.[k] !== undefined) set[k] = !!req.body[k];
  const [row] = await db.update(emailSequencesTable).set(set).where(and(eq(emailSequencesTable.id, Number(req.params.id)), eq(emailSequencesTable.userId, req.session.userId!))).returning();
  res.json(row ?? null);
});
router.delete("/sequences/:id", async (req, res) => {
  const userId = req.session.userId!, id = Number(req.params.id);
  // ما لم يُرسَل بعد يذهب معه. وإلا بقي في الطابور يتيماً: حذف التتابع
  // يُصفّر `sequence_job_id` بحكم المفتاح الأجنبي، فيلقى المُرسِل رسالةً
  // بلا جسم ويحرقها — وهكذا احترقت ١٧٦٢ رسالة في هذا الحساب يوم ٥ أكتوبر
  // من ثغرةٍ مثلها في حذف الحملات، أُصلحت هناك وبقيت هنا.
  const jobs = await db.select({ id: emailSequenceJobsTable.id }).from(emailSequenceJobsTable)
    .where(and(eq(emailSequenceJobsTable.userId, userId), eq(emailSequenceJobsTable.sequenceId, id)));
  if (jobs.length) {
    await db.update(emailMessagesTable).set({ status: "cancelled", error: "ألغيت: حُذف التتابع" })
      .where(and(eq(emailMessagesTable.userId, userId), inArray(emailMessagesTable.sequenceJobId, jobs.map((j) => j.id)), inArray(emailMessagesTable.status, ["queued", "ab_hold"])));
  }
  await db.delete(emailSequencesTable).where(and(eq(emailSequencesTable.id, id), eq(emailSequencesTable.userId, userId)));
  res.json({ ok: true, cancelled: jobs.length });
});
router.post("/sequences/:id/enrol", async (req, res) => {
  const userId = req.session.userId!;
  try {
    await assertCanSend(userId);
    let ids: number[] = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(Number).filter(Boolean) : [];
    if (req.body?.listId) {
      const members = await db.select({ id: emailListMembersTable.contactId }).from(emailListMembersTable).where(eq(emailListMembersTable.listId, Number(req.body.listId)));
      ids = members.map((m) => m.id);
    } else if (req.body?.filter) {
      ids = (await resolveSegment(userId, cleanFilter(req.body.filter), { sendable: true })).map((c) => c.id);
    }
    res.json(await enrolInSequence(userId, Number(req.params.id), ids));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.get("/sequences/:id/jobs", async (req, res) => {
  const rows = await db.select({ j: emailSequenceJobsTable, email: emailContactsTable.email, company: emailContactsTable.company })
    .from(emailSequenceJobsTable).leftJoin(emailContactsTable, eq(emailContactsTable.id, emailSequenceJobsTable.contactId))
    .where(and(eq(emailSequenceJobsTable.sequenceId, Number(req.params.id)), eq(emailSequenceJobsTable.userId, req.session.userId!)))
    .orderBy(emailSequenceJobsTable.dueAt).limit(500);
  res.json(rows.map((r) => ({ ...r.j, email: r.email, company: r.company })));
});

// ── Inbound ───────────────────────────────────────────────────────
// الوارد مقسوماً بنوعه: الردود الحقيقية وحدها افتراضاً، والضجيج
// محفوظٌ ومعدودٌ لمن أراد أن يراه. فصندوقٌ فيه أربعة عشر إعلاناً
// وردّان حقيقيان يُخفي الردّين.
router.get("/inbound", async (req, res) => {
  const userId = req.session.userId!;
  const view = String(req.query["view"] ?? "replies");   // replies | noise | all | <kind>
  const rows = await db.select({ i: emailInboundTable, company: emailContactsTable.company, ourSubject: emailMessagesTable.subject })
    .from(emailInboundTable).leftJoin(emailContactsTable, eq(emailContactsTable.id, emailInboundTable.contactId))
    .leftJoin(emailMessagesTable, eq(emailMessagesTable.id, emailInboundTable.messageId))
    .where(eq(emailInboundTable.userId, userId)).orderBy(desc(emailInboundTable.receivedAt)).limit(400);

  const all = rows.map((r) => ({
    ...r.i, company: r.company, ourSubject: r.ourSubject,
    kindLabel: r.i.kind ? KIND_AR[r.i.kind as keyof typeof KIND_AR] ?? r.i.kind : null,
    intentLabel: r.i.intent ? INTENT_AR[r.i.intent as keyof typeof INTENT_AR]?.label ?? r.i.intent : null,
    nextStep: r.i.intent ? INTENT_AR[r.i.intent as keyof typeof INTENT_AR]?.next ?? null : null,
  }));
  // صفٌّ قديم بلا نوع يُعدّ رداً: هكذا كان يُعرض قبل المصنّف.
  const isReply = (x: { kind: string | null }) => x.kind === "reply" || x.kind == null;
  const counts: Record<string, number> = {};
  for (const x of all) counts[x.kind ?? "reply"] = (counts[x.kind ?? "reply"] ?? 0) + 1;

  const list = view === "all" ? all
    : view === "replies" ? all.filter(isReply)
    : view === "noise" ? all.filter((x) => !isReply(x))
    : all.filter((x) => x.kind === view);

  res.json({ rows: list, counts, view, total: all.length, replies: all.filter(isReply).length });
});
router.post("/inbound/:id/draft", async (req, res) => {
  const d = await draftReply(req.session.userId!, Number(req.params.id));
  if (!d) return res.status(400).json({ error: "تعذّرت المسودة — النموذج لم يستجب" });
  res.json(d);
});
router.post("/inbound/:id/send", async (req, res) => {
  try {
    await assertCanSend(req.session.userId!);
    res.json(await sendReply(req.session.userId!, Number(req.params.id), req.body?.subject, req.body?.body));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
/** Stop an automatic send without ignoring the reply. */
router.post("/inbound/:id/hold", async (req, res) => {
  await db.update(emailInboundTable).set({ autoSendAt: null }).where(and(eq(emailInboundTable.id, Number(req.params.id)), eq(emailInboundTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.post("/inbound/:id/ignore", async (req, res) => {
  await db.update(emailInboundTable).set({ state: "ignored", autoSendAt: null }).where(and(eq(emailInboundTable.id, Number(req.params.id)), eq(emailInboundTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
/** Paste a reply that arrived elsewhere, so it is analysed like the rest. */
router.post("/inbound/manual", async (req, res) => {
  const { from, subject, text } = req.body ?? {};
  if (!from || !text) return res.status(400).json({ error: "المُرسِل والنص مطلوبان" });
  const { handleInbound } = await import("../lib/email/inbound");
  res.json(await handleInbound(req.session.userId!, { from: String(from), subject: subject ?? null, text: String(text) }));
});

// The counters, from events, for a message.
router.get("/messages/:id/events", async (req, res) => {
  const rows = await db.select().from(emailEventsTable).where(and(eq(emailEventsTable.messageId, Number(req.params.id)), eq(emailEventsTable.userId, req.session.userId!))).orderBy(emailEventsTable.createdAt);
  res.json(rows);
});
router.post("/messages/:id/event", async (req, res) => {
  // A bounce or complaint the owner saw in their mailbox and wants recorded.
  const type = String(req.body?.type ?? "");
  if (!["bounce", "complaint", "unsubscribe", "reply"].includes(type)) return res.status(400).json({ error: "نوع غير معروف" });
  await recordEvent(req.session.userId!, Number(req.params.id), type as any, { meta: { manual: true } });
  res.json({ ok: true });
});

// ── Knowledge: what the owner uploads about the company and its field ──
// Files arrive with their names in latin1 (multer); an Arabic name is put back.
const fileNameOf = (f: Express.Multer.File) => { const n = Buffer.from(f.originalname, "latin1").toString("utf8"); return n.includes("\uFFFD") ? f.originalname : n; };

router.get("/knowledge", async (req, res) => res.json(await knowledgeLibrary(req.session.userId!)));

/** Files (up to 20 at once) or pasted text, with a category and a sector for all of them. */
router.post("/knowledge", upload.array("files", 20), async (req, res) => {
  const userId = req.session.userId!;
  const b: any = req.body ?? {};
  const category = String(b.category ?? "company"), sector = b.sector ? String(b.sector) : null;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const added: any[] = [], failed: Array<{ file: string; error: string }> = [];
  for (const f of files) {
    const name = fileNameOf(f);
    try {
      const text = await extractText(f.buffer, name);
      added.push(await addDoc(userId, { title: name.replace(/\.[a-z0-9]+$/i, ""), content: text, category, sector, fileName: name }));
    } catch (err: any) { failed.push({ file: name, error: String(err?.message ?? err) }); }
  }
  if (typeof b.text === "string" && b.text.trim()) {
    try { added.push(await addDoc(userId, { title: String(b.title ?? "").trim() || b.text.trim().slice(0, 60), content: b.text, category, sector })); }
    catch (err: any) { failed.push({ file: "النص الملصق", error: String(err?.message ?? err) }); }
  }
  if (!added.length && !failed.length) return res.status(400).json({ error: "ارفع ملفاً أو الصق نصاً" });
  res.status(added.length ? 201 : 400).json({ added: added.map(({ content, ...d }) => d), failed, error: added.length ? undefined : failed.map((f) => `${f.file}: ${f.error}`).join(" · ") });
});

router.get("/knowledge/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [doc] = await db.select().from(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, userId))).limit(1);
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  const facts = await db.select().from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.docId, doc.id))).orderBy(agentMemoryTable.id);
  res.json({ doc: { ...doc, content: doc.content.slice(0, 60_000), truncated: doc.content.length > 60_000 }, facts });
});

router.patch("/knowledge/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.title === "string" && req.body.title.trim()) set["title"] = req.body.title.trim().slice(0, 200);
  if (typeof req.body?.category === "string") set["category"] = req.body.category.slice(0, 30);
  if (req.body?.sector !== undefined) set["sector"] = req.body.sector ? String(req.body.sector).slice(0, 80) : null;
  const [doc] = await db.update(emailKnowledgeDocsTable).set(set).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, req.session.userId!))).returning({ id: emailKnowledgeDocsTable.id, sector: emailKnowledgeDocsTable.sector });
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  // The facts follow the document's sector.
  if (req.body?.sector !== undefined) await db.update(agentMemoryTable).set({ topic: doc.sector }).where(and(eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.docId, doc.id)));
  res.json(doc);
});

/** The document and every fact drawn from it. */
router.delete("/knowledge/:id", async (req, res) => {
  await db.delete(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

/** Read it again — after the model was down, or the sector changed. */
router.post("/knowledge/:id/learn", async (req, res) => {
  const userId = req.session.userId!;
  const [doc] = await db.select({ id: emailKnowledgeDocsTable.id }).from(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, userId))).limit(1);
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  void learnDoc(userId, doc.id);
  res.json({ ok: true });
});

router.post("/knowledge/ask", async (req, res) => {
  const q = String(req.body?.question ?? "").trim();
  if (!q) return res.status(400).json({ error: "اكتب سؤالاً" });
  res.json(await askKnowledge(req.session.userId!, q.slice(0, 500), req.body?.sector ? String(req.body.sector) : null));
});

// ── The register: who was written to and where each one stands ──
router.get("/register", async (req, res) => {
  const st = String(req.query["status"] ?? "all");
  res.json(await emailRegister(req.session.userId!, {
    status: (["all", "in_path", "replied", "finished", "stopped"].includes(st) ? st : "all") as any,
    q: req.query["q"] ? String(req.query["q"]) : undefined, listId: Number(req.query["listId"]) || null, page: Number(req.query["page"]) || 0,
  }));
});

// ── The follow-up dashboard and the team on its own ───────────────
router.get("/dashboard", async (req, res) => res.json(await emailDashboard(req.session.userId!, Number(req.query["days"]) || 14)));
router.get("/autopilot", async (req, res) => {
  const userId = req.session.userId!;
  res.json({ autopilot: await getAutopilot(userId), team: await teamStatus(userId) });
});
router.put("/autopilot", async (req, res) => {
  const userId = req.session.userId!;
  const before = await getAutopilot(userId);
  const row = await saveAutopilot(userId, req.body ?? {});
  if (row.enabled !== before.enabled) await teamActivity(userId, "email_strategist", "autopilot", row.enabled ? `شغّل صاحب العمل الطيار الآلي (${row.mode === "auto" ? "إرسال تلقائي بعد مراجعة ماجد" : "كل حملة تنتظر موافقته"}).` : "أوقف صاحب العمل الطيار الآلي.");
  res.json(row);
});
// ── طارق builds a campaign on request ──
router.get("/creator/services", (_req, res) => res.json(Object.entries(CREATOR_SERVICES).map(([key, v]) => ({ key, label: v.label, category: v.category }))));
router.post("/creator", async (req, res) => {
  const b = req.body ?? {};
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => n > 0) : []);
  try {
    res.json(await createWithCreator(req.session.userId!, { service: String(b.service ?? ""), language: ["ar", "en", "both"].includes(b.language) ? b.language : undefined,
      listIds: ids(b.listIds), folderIds: ids(b.folderIds), sectors: Array.isArray(b.sectors) ? b.sectors.map(String).slice(0, 10) : [], take: Number(b.take) || undefined, notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : "" }));
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

// ── صفحة التشغيل: ارفع، أعطِ الهدف، واترك الباقي (auto-desk.ts) ──
router.get("/auto", async (req, res) => res.json(await autoState(req.session.userId!)));
router.post("/auto/map", (req, res) => {
  const names: unknown[] = Array.isArray(req.body?.names) ? req.body.names.slice(0, 50) : [];
  res.json(names.map((n) => mapFolder(String(n))));
});
/** «أريد ٥٠ lead هذا الشهر»: ردود نافعة حتى آخر الشهر — والمدير يقسمها على الأيام. */
router.post("/auto/goal", async (req, res) => {
  const target = Math.floor(Number(req.body?.target));
  try {
    const deadline = endOfMonthUae();
    const id = await giveGoal(req.session.userId!, { metric: "email_positive", target, deadline,
      title: `${target} lead (رد نافع) حتى ${deadline.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai" })}` });
    res.json({ id, deadline });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A round now, rather than at the next quarter hour. */
router.post("/autopilot/run", async (req, res) => {
  try { res.json(await runAutopilot(req.session.userId!, { force: true })); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

export default router;
