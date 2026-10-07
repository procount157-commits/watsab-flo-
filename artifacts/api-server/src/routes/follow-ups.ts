// ── Follow-up sequences ───────────────────────────────────────────
// Replaces an earlier version of this file that queried follow_up_templates
// and message_logs.replied_at — neither of which was ever created, so every
// route in it returned an error.

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, leadSourcesTable, followUpSequencesTable, followUpJobsTable,
  DEFAULT_FOLLOW_UP_OFFSETS, DEFAULT_FOLLOW_UP_STEPS, type FollowUpStep,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { enrolLead, enrolGroup, cancelPendingFollowUps } from "../lib/follow-up-engine";
import { classify, classifyIntent, INTENT_LABELS_AR, type Intent } from "../lib/intent";
import { logger } from "../lib/logger";
import { modeOf, runSmartFollowUps, STEP_BASE } from "../lib/smart-followup";

const router = Router();
router.use(requireAuth);

const LABELS: Record<number, string> = {
  60: "بعد ساعة", 360: "بعد 6 ساعات", 720: "بعد 12 ساعة",
  1440: "بعد يوم", 4320: "بعد 3 أيام", 10080: "بعد أسبوع", 43200: "بعد شهر",
};
export const offsetLabel = (m: number) =>
  LABELS[m] ?? (m < 60 ? `بعد ${m} دقيقة` : m < 1440 ? `بعد ${Math.round(m / 60)} ساعة` : `بعد ${Math.round(m / 1440)} يوم`);

function parseSteps(input: unknown): FollowUpStep[] | null {
  if (!Array.isArray(input)) return null;
  const steps: FollowUpStep[] = [];
  for (const raw of input) {
    const offsetMinutes = Number((raw as any)?.offsetMinutes);
    const message = String((raw as any)?.message ?? "").trim();
    if (!Number.isFinite(offsetMinutes) || offsetMinutes < 1 || !message) return null;
    steps.push({ offsetMinutes: Math.round(offsetMinutes), message });
  }
  // Ordered, so step 0 is always the earliest.
  return steps.sort((a, b) => a.offsetMinutes - b.offsetMinutes);
}

// ── Sequences ─────────────────────────────────────────────────────

router.get("/sequences", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select().from(followUpSequencesTable)
    .where(eq(followUpSequencesTable.userId, userId))
    .orderBy(desc(followUpSequencesTable.createdAt));

  // Per-sequence job counts, so the UI can show what each one is doing.
  const counts = await db
    .select({
      sequenceId: followUpJobsTable.sequenceId,
      status:     followUpJobsTable.status,
      n:          sql<number>`count(*)`,
    })
    .from(followUpJobsTable)
    .where(eq(followUpJobsTable.userId, userId))
    .groupBy(followUpJobsTable.sequenceId, followUpJobsTable.status);

  res.json(rows.map((s) => {
    const mine = counts.filter((c) => c.sequenceId === s.id);
    const by = (st: string) => Number(mine.find((c) => c.status === st)?.n ?? 0);
    return {
      ...s,
      steps: (s.steps as FollowUpStep[]).map((st) => ({ ...st, label: offsetLabel(st.offsetMinutes) })),
      stats: { pending: by("pending"), sent: by("sent"), cancelled: by("cancelled"), failed: by("failed"), skipped: by("skipped") },
    };
  }));
});

/** Create a sequence. With no steps supplied, uses the 1h→6h→12h→1d→3d→1w→1mo cadence. */
router.post("/sequences", async (req, res) => {
  const userId = req.session.userId!;
  const { name, steps, sourceFilter = "all", stopOnReply = true, isActive = false,
          continueOnIntents, useAi = false } = req.body ?? {};

  if (!String(name ?? "").trim()) return res.status(400).json({ error: "اسم التسلسل مطلوب" });

  const parsed = steps === undefined ? [...DEFAULT_FOLLOW_UP_STEPS] : parseSteps(steps);

  if (!parsed || parsed.length === 0) {
    return res.status(400).json({ error: "الخطوات غير صالحة — كل خطوة تحتاج offsetMinutes ورسالة" });
  }

  const [row] = await db.insert(followUpSequencesTable).values({
    userId,
    name: String(name).trim(),
    steps: parsed as any,
    sourceFilter: sourceFilter === "all" ? "all" : "ad",
    stopOnReply: !!stopOnReply,
    isActive: !!isActive,
    continueOnIntents: (Array.isArray(continueOnIntents)
      ? continueOnIntents.filter((i: string) => i in INTENT_LABELS_AR)
      : ["greeting", "unclear"]) as any,
    useAi: !!useAi,
  }).returning();

  res.json(row);
});

router.patch("/sequences/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  const [own] = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.id, id), eq(followUpSequencesTable.userId, userId)));
  if (!own) return res.status(404).json({ error: "التسلسل غير موجود" });

  const updates: Record<string, unknown> = {};
  if (req.body.name        !== undefined) updates.name = String(req.body.name).trim();
  if (req.body.isActive    !== undefined) updates.isActive = !!req.body.isActive;
  if (req.body.stopOnReply !== undefined) updates.stopOnReply = !!req.body.stopOnReply;
  if (req.body.sourceFilter!== undefined) updates.sourceFilter = req.body.sourceFilter === "all" ? "all" : "ad";
  if (req.body.useAi       !== undefined) updates.useAi = !!req.body.useAi;
  if (req.body.continueOnIntents !== undefined) {
    if (!Array.isArray(req.body.continueOnIntents)) return res.status(400).json({ error: "continueOnIntents يجب أن تكون قائمة" });
    updates.continueOnIntents = req.body.continueOnIntents.filter((i: string) => i in INTENT_LABELS_AR);
  }
  if (req.body.steps       !== undefined) {
    const parsed = parseSteps(req.body.steps);
    if (!parsed || parsed.length === 0) return res.status(400).json({ error: "الخطوات غير صالحة" });
    updates.steps = parsed;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "لا يوجد تغيير" });

  const [row] = await db.update(followUpSequencesTable).set(updates)
    .where(eq(followUpSequencesTable.id, id)).returning();
  res.json(row);
});

router.delete("/sequences/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  await db.delete(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.id, id), eq(followUpSequencesTable.userId, userId)));
  res.json({ success: true });
});

/**
 * Enrol a number by hand.
 *
 * Exists because a sequence cannot otherwise be tried before the first ad ever
 * runs: normally enrolment happens when an ad lead messages in.
 */
router.post("/sequences/:id/enrol", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (phone.length < 7) return res.status(400).json({ error: "رقم غير صالح" });

  const [seq] = await db.select().from(followUpSequencesTable)
    .where(and(eq(followUpSequencesTable.id, id), eq(followUpSequencesTable.userId, userId)));
  if (!seq) return res.status(404).json({ error: "التسلسل غير موجود" });
  if (!seq.isActive) return res.status(400).json({ error: "فعّل التسلسل أولاً" });

  const scheduled = await enrolLead(userId, phone, seq.sourceFilter === "all" ? "organic" : "ad");
  logger.info({ userId, phone, sequenceId: id, scheduled }, "manual follow-up enrolment");
  res.json({ success: true, scheduled });
});

/**
 * Enrol a whole contact list — an ad lead-form export, or any imported sheet.
 *
 * Leads from a Meta lead form arrive as a spreadsheet rather than a WhatsApp
 * message, so they never pass through the inbound path and were the one kind
 * of ad lead that got no follow-up at all.
 *
 * `source` is declared by the caller because a spreadsheet cannot say whether
 * its numbers asked to be contacted. The worker's guards apply regardless.
 */
router.post("/sequences/:id/enrol-group", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  const groupId = parseInt(String(req.body?.groupId ?? ""));
  const source = req.body?.source === "organic" ? "organic" : "ad";

  if (!Number.isFinite(groupId)) return res.status(400).json({ error: "groupId مطلوب" });

  try {
    const r = await enrolGroup(userId, id, groupId, source);
    res.json({
      success: true,
      ...r,
      note: r.estimatedDays > 1
        ? `سيستغرق ${r.estimatedDays} يوماً تقريباً — المتابعات تشارك الحصة اليومية مع الحملات وتحترم التدرّج`
        : null,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const code = /NOT_FOUND/.test(msg) ? 404 : /INACTIVE/.test(msg) ? 400 : 500;
    res.status(code).json({ error: msg.replace(/^[A-Z_]+:\s*/, "") });
  }
});

router.post("/cancel", async (req, res) => {
  const userId = req.session.userId!;
  const phone = String(req.body?.phone ?? "").replace(/\D/g, "");
  if (!phone) return res.status(400).json({ error: "رقم غير صالح" });
  const cancelled = await cancelPendingFollowUps(userId, phone, "إلغاء يدوي");
  res.json({ success: true, cancelled });
});

// ── Leads ─────────────────────────────────────────────────────────

/**
 * Detected leads and where they came from.
 *
 * `adDetected` is the number to watch once ads start running: it stays at zero
 * until a click-to-WhatsApp lead actually arrives, which is how you confirm the
 * referral data is coming through rather than assuming it.
 */
router.get("/leads", async (req, res) => {
  const userId = req.session.userId!;
  const source = String(req.query.source ?? "");

  const where = source === "ad" || source === "organic"
    ? and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.source, source))
    : eq(leadSourcesTable.userId, userId);

  const rows = await db.select().from(leadSourcesTable).where(where)
    .orderBy(desc(leadSourcesTable.firstSeenAt)).limit(500);

  const [totals] = await db
    .select({
      total: sql<number>`count(*)`,
      ad:    sql<number>`count(*) filter (where ${leadSourcesTable.source} = 'ad')`,
    })
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.userId, userId));

  // Grouped by what each lead last said, so the hot ones are findable.
  const byIntent = await db
    .select({ intent: leadSourcesTable.lastIntent, n: sql<number>`count(*)` })
    .from(leadSourcesTable)
    .where(eq(leadSourcesTable.userId, userId))
    .groupBy(leadSourcesTable.lastIntent);

  res.json({
    leads: rows.map((l) => ({
      ...l,
      intentLabel: l.lastIntent ? INTENT_LABELS_AR[l.lastIntent as Intent] ?? l.lastIntent : null,
    })),
    total:      Number(totals?.total ?? 0),
    adDetected: Number(totals?.ad ?? 0),
    byIntent: Object.fromEntries(
      byIntent.filter((r) => r.intent).map((r) => [r.intent, Number(r.n)]),
    ),
  });
});

/**
 * Try the classifier on arbitrary text.
 *
 * Returns the rules verdict always, and the model's opinion alongside it when
 * `useAi` is set — shown side by side rather than merged, so a disagreement is
 * visible instead of silently resolved.
 */
router.post("/classify", async (req, res) => {
  const text = String(req.body?.text ?? "");
  if (!text.trim()) return res.status(400).json({ error: "أرسل نصاً" });

  const rules = classifyIntent(text);
  const withAi = req.body?.useAi ? await classify(text, true) : null;

  res.json({
    rules: { ...rules, label: INTENT_LABELS_AR[rules.intent] },
    ai: withAi && withAi.source === "ai"
      ? { ...withAi, label: INTENT_LABELS_AR[withAi.intent] }
      : null,
    aiNote: req.body?.useAi && (!withAi || withAi.source !== "ai")
      ? "الخدمة المجانية لم تستجب (حد طلب واحد لكل IP) — اعتُمد التصنيف المحلي"
      : null,
  });
});

// ── Scheduled jobs ────────────────────────────────────────────────

router.get("/jobs", async (req, res) => {
  const userId = req.session.userId!;
  const status = String(req.query.status ?? "");
  const where = status
    ? and(eq(followUpJobsTable.userId, userId), eq(followUpJobsTable.status, status))
    : eq(followUpJobsTable.userId, userId);

  const rows = await db.select().from(followUpJobsTable).where(where)
    .orderBy(desc(followUpJobsTable.dueAt)).limit(500);

  res.json(rows);
});

export default router;


// ── The follow-up خالد writes ─────────────────────────────────────
// GET  /smart          → { mode, recent: drafts and decisions }
// PATCH /smart {mode}  → off | dry | live
// POST /smart/run      → one round now
router.get("/smart", async (req, res) => {
  const userId = req.session.userId!;
  const recent = await db.execute(sql`SELECT id, phone, step - ${STEP_BASE} + 1 AS rung, verdict, reason, draft, executed, created_at
    FROM followup_deliberations WHERE user_id = ${userId} AND step >= ${STEP_BASE} ORDER BY created_at DESC LIMIT 40`);
  res.json({ mode: await modeOf(userId), recent: recent.rows });
});

router.patch("/smart", async (req, res) => {
  const userId = req.session.userId!;
  const mode = String((req.body as any)?.mode ?? "");
  if (!["off", "dry", "live"].includes(mode)) return res.status(400).json({ error: "الوضع: off أو dry أو live" });
  await db.execute(sql`UPDATE business_profile SET smart_followup = ${mode} WHERE user_id = ${userId}`);
  logger.info({ userId, mode }, "smart follow-up mode changed");
  res.json({ mode });
});

router.post("/smart/run", async (req, res) => res.json(await runSmartFollowUps(req.session.userId!)));
