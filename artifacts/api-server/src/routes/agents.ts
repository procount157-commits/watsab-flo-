// ── An employee's memory, duties, skills and routines ─────────────
// Everything that used to be a prompt in the source and now belongs to the
// owner: what the employee was told, what it learnt, what it can do, and what
// it does on a schedule.

import { Router } from "express";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  db, agentMemoryTable, agentTasksTable, agentSkillsTable, agentSkillGrantsTable,
  agentRoutinesTable, agentRoutineRunsTable, botEmployeesTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { remember, forget } from "../lib/agent-memory";
import { runRoutine, ROUTINE_TEMPLATES } from "../lib/agent-routines";
import { seedSkills, resetSkill, LIBRARY } from "../lib/skills";
import { simulate, rate, recentForReview } from "../lib/arena";
import multer from "multer";
import { transcribe } from "../lib/voice";
import { speakMp3, sayable } from "../lib/tts";

const router = Router();
router.use(requireAuth);

// ── The training arena ───────────────────────────────────────────
router.post("/arena/simulate", async (req, res) => {
  const role = clean(req.body?.role, 30) || "sales";
  const turns = Array.isArray(req.body?.turns) ? req.body.turns.map((t: any) => ({ role: t?.role === "assistant" ? "assistant" : "user", content: String(t?.content ?? "").slice(0, 2_000) })) : [];
  try { res.json(await simulate(req.session.userId!, role, turns)); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

// ── Voice in the arena: the owner speaks, the employee answers aloud ──
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/** A recording from the browser, as text — the same Whisper the WhatsApp voice notes go through. */
router.post("/arena/transcribe", audioUpload.single("audio"), async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(400).json({ error: "لم يصل تسجيل" });
  if (!process.env["GROQ_API_KEY"]) return res.status(400).json({ error: "مفتاح Groq غير مضبوط — لا يمكن تفريغ الصوت" });
  const t = await transcribe(req.file.buffer, req.file.mimetype || "audio/webm");
  if (!t?.text) return res.status(422).json({ error: "لم أفهم كلاماً في التسجيل — جرّب مرة أخرى بصوت أوضح" });
  res.json({ text: t.text, model: t.model, ms: t.ms });
});

/** The reply, spoken — and whether on WhatsApp it would have gone as voice or stayed text. */
router.post("/arena/speak", async (req, res) => {
  const text = String(req.body?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "لا نص" });
  const gender = req.body?.gender === "female" ? "female" : "male";
  const v = await speakMp3(text, { gender });
  if (!v) return res.status(502).json({ error: "تعذّر توليد الصوت — حاول بعد قليل" });
  const s = sayable(text);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("X-Voice", v.voice);
  res.setHeader("X-Whatsapp-As", s.ok ? "voice" : encodeURIComponent(`text:${s.why}`));
  res.setHeader("Cache-Control", "no-store");
  res.send(v.audio);
});

router.post("/arena/rate", async (req, res) => {
  const userId = req.session.userId!;
  const role = clean(req.body?.role, 30);
  if (!role || !(await ownsRole(userId, role))) return res.status(400).json({ error: "الموظف غير معروف" });
  const rating = Number(req.body?.rating) > 0 ? 1 : -1;
  res.json(await rate(userId, {
    role, rating, customer: clean(req.body?.customer, 1_000), reply: clean(req.body?.reply, 2_000),
    correction: req.body?.correction ? clean(req.body.correction, 1_000) : null,
    logId: Number(req.body?.logId) || null,
  }));
});

router.get("/replies", async (req, res) => {
  res.json(await recentForReview(req.session.userId!, Math.min(200, Number(req.query["limit"]) || 60)));
});

const ROUTABLE = ["interested", "question", "greeting", "unclear", "complaint", "not_interested"];
const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

/** The employee must be one of this account's own. */
async function ownsRole(userId: number, role: string): Promise<boolean> {
  const [r] = await db.select({ id: botEmployeesTable.id }).from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  return !!r;
}

// ── Memory ───────────────────────────────────────────────────────
router.get("/:role/memory", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select().from(agentMemoryTable)
    .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, req.params.role!)))
    .orderBy(desc(agentMemoryTable.times), desc(agentMemoryTable.updatedAt));
  res.json(rows);
});

/**
 * Write a standing order.
 *
 * Only instructions: a win or a loss is something the employee observed, and
 * letting the owner type one in would put a claim about what happened next to
 * the ones actually measured.
 */
router.post("/:role/memory", async (req, res) => {
  const userId = req.session.userId!;
  const role = req.params.role!;
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });
  const content = clean(req.body?.content, 500);
  if (!content) return res.status(400).json({ error: "النص مطلوب" });
  await remember(userId, role, "instruction", content);
  res.status(201).json({ ok: true });
});

router.delete("/memory/:id", async (req, res) => {
  await forget(req.session.userId!, parseInt(req.params.id!));
  res.json({ ok: true });
});

// ── Duties ───────────────────────────────────────────────────────
router.get("/:role/tasks", async (req, res) => {
  const rows = await db.select().from(agentTasksTable)
    .where(and(eq(agentTasksTable.userId, req.session.userId!), eq(agentTasksTable.role, req.params.role!)))
    .orderBy(asc(agentTasksTable.sortOrder));
  res.json(rows);
});

router.post("/:role/tasks", async (req, res) => {
  const userId = req.session.userId!;
  const role = req.params.role!;
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });
  const task = clean(req.body?.task, 400);
  if (!task) return res.status(400).json({ error: "المهمة مطلوبة" });

  // Appended, since the order is the order the owner wrote them in.
  const existing = await db.select({ o: agentTasksTable.sortOrder }).from(agentTasksTable)
    .where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, role)));
  const next = existing.reduce((m, r) => Math.max(m, r.o), 0) + 10;

  const [row] = await db.insert(agentTasksTable)
    .values({ userId, role, task, sortOrder: next }).returning();
  res.status(201).json(row);
});

router.patch("/tasks/:id", async (req, res) => {
  const updates: Record<string, unknown> = {};
  if (req.body?.task     !== undefined) updates.task = clean(req.body.task, 400);
  if (req.body?.isActive !== undefined) updates.isActive = !!req.body.isActive;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "لا تغيير" });
  const [row] = await db.update(agentTasksTable).set(updates)
    .where(and(eq(agentTasksTable.id, parseInt(req.params.id!)), eq(agentTasksTable.userId, req.session.userId!)))
    .returning();
  if (!row) return res.status(404).json({ error: "المهمة غير موجودة" });
  res.json(row);
});

router.delete("/tasks/:id", async (req, res) => {
  await db.delete(agentTasksTable)
    .where(and(eq(agentTasksTable.id, parseInt(req.params.id!)), eq(agentTasksTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Skills ───────────────────────────────────────────────────────
// Listed with who holds each one, since that is the only thing that makes a
// skill take effect.
router.get("/skills", async (req, res) => {
  const userId = req.session.userId!;
  const [skills, grants] = await Promise.all([
    db.select().from(agentSkillsTable).where(eq(agentSkillsTable.userId, userId))
      .orderBy(asc(agentSkillsTable.name)),
    db.select().from(agentSkillGrantsTable).where(eq(agentSkillGrantsTable.userId, userId)),
  ]);
  res.json(skills.map((s) => ({
    ...s,
    heldBy: grants.filter((g) => g.skillId === s.id).map((g) => g.role),
  })));
});

/** Install the built-in library, leaving anything the owner has edited alone. */
router.post("/skills/seed", async (req, res) =>
  res.json({ ...(await seedSkills(req.session.userId!)), library: LIBRARY.map((s) => s.name) }));

/** Discard an edit and go back to the library text. */
router.post("/skills/:name/reset", async (req, res) => {
  const ok = await resetSkill(req.session.userId!, decodeURIComponent(req.params.name!));
  if (!ok) return res.status(404).json({ error: "هذه المهارة ليست من المكتبة" });
  res.json({ ok: true });
});

router.post("/skills", async (req, res) => {
  const userId = req.session.userId!;
  const name = clean(req.body?.name, 60);
  const instruction = clean(req.body?.instruction, 4_000);
  if (!name || !instruction) return res.status(400).json({ error: "الاسم والتعليمات مطلوبان" });

  const want: string[] = Array.isArray(req.body?.intents) ? req.body.intents.map(String) : [];
  try {
    const [row] = await db.insert(agentSkillsTable)
      .values({ userId, name, instruction, intents: want.filter((v) => ROUTABLE.includes(v)) })
      .returning();
    res.status(201).json(row);
  } catch {
    // The unique index on lower(name) is the only thing that can fail here.
    res.status(409).json({ error: "توجد مهارة بهذا الاسم" });
  }
});

router.patch("/skills/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (req.body?.name        !== undefined) updates.name = clean(req.body.name, 60);
  if (req.body?.instruction !== undefined) updates.instruction = clean(req.body.instruction, 4_000);
  if (req.body?.isActive    !== undefined) updates.isActive = !!req.body.isActive;
  if (req.body?.intents     !== undefined) {
    const want: string[] = Array.isArray(req.body.intents) ? req.body.intents.map(String) : [];
    updates.intents = want.filter((v) => ROUTABLE.includes(v));
  }

  const [row] = await db.update(agentSkillsTable).set(updates)
    .where(and(eq(agentSkillsTable.id, id), eq(agentSkillsTable.userId, userId))).returning();
  if (!row) return res.status(404).json({ error: "المهارة غير موجودة" });

  // Who holds it, replaced wholesale — the UI sends the full list.
  if (Array.isArray(req.body?.heldBy)) {
    const roles: string[] = req.body.heldBy.map(String);
    const mine = await db.select({ role: botEmployeesTable.role }).from(botEmployeesTable)
      .where(eq(botEmployeesTable.userId, userId));
    const valid = roles.filter((r) => mine.some((m) => m.role === r));

    await db.delete(agentSkillGrantsTable)
      .where(and(eq(agentSkillGrantsTable.userId, userId), eq(agentSkillGrantsTable.skillId, id)));
    if (valid.length) {
      await db.insert(agentSkillGrantsTable)
        .values(valid.map((role) => ({ userId, role, skillId: id })));
    }
  }
  res.json(row);
});

router.delete("/skills/:id", async (req, res) => {
  await db.delete(agentSkillsTable)
    .where(and(eq(agentSkillsTable.id, parseInt(req.params.id!)), eq(agentSkillsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Routines ─────────────────────────────────────────────────────
router.get("/routines", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select().from(agentRoutinesTable)
    .where(eq(agentRoutinesTable.userId, userId)).orderBy(asc(agentRoutinesTable.name));

  const runs = rows.length
    ? await db.select().from(agentRoutineRunsTable)
        .where(inArray(agentRoutineRunsTable.routineId, rows.map((r) => r.id)))
        .orderBy(desc(agentRoutineRunsTable.createdAt)).limit(40)
    : [];

  res.json({
    routines: rows.map((r) => ({ ...r, lastRun: runs.find((x) => x.routineId === r.id) ?? null })),
    templates: ROUTINE_TEMPLATES,
  });
});

router.post("/routines", async (req, res) => {
  const userId = req.session.userId!;
  const role = clean(req.body?.role, 30);
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });

  const name = clean(req.body?.name, 80);
  const instruction = clean(req.body?.instruction, 2_000);
  if (!name || !instruction) return res.status(400).json({ error: "الاسم والتعليمات مطلوبان" });

  const daily = req.body?.triggerKind === "daily";
  // Floors, not validation errors: a routine set to "every minute" would run
  // the model 1440 times a day on a free tier and achieve nothing.
  const everyMinutes = daily ? null : Math.max(5, Math.round(Number(req.body?.everyMinutes) || 60));
  const atHour = daily ? Math.min(23, Math.max(0, Math.round(Number(req.body?.atHour) || 9))) : null;

  const [row] = await db.insert(agentRoutinesTable).values({
    userId, role, name, instruction,
    triggerKind: daily ? "daily" : "interval", everyMinutes, atHour,
  }).returning();
  res.status(201).json(row);
});

router.patch("/routines/:id", async (req, res) => {
  const updates: Record<string, unknown> = {};
  if (req.body?.name        !== undefined) updates.name = clean(req.body.name, 80);
  if (req.body?.instruction !== undefined) updates.instruction = clean(req.body.instruction, 2_000);
  if (req.body?.isActive    !== undefined) updates.isActive = !!req.body.isActive;
  if (req.body?.everyMinutes !== undefined) updates.everyMinutes = Math.max(5, Math.round(Number(req.body.everyMinutes) || 60));
  if (req.body?.atHour       !== undefined) updates.atHour = Math.min(23, Math.max(0, Math.round(Number(req.body.atHour) || 9)));
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: "لا تغيير" });

  const [row] = await db.update(agentRoutinesTable).set(updates)
    .where(and(eq(agentRoutinesTable.id, parseInt(req.params.id!)), eq(agentRoutinesTable.userId, req.session.userId!)))
    .returning();
  if (!row) return res.status(404).json({ error: "المهمة غير موجودة" });
  res.json(row);
});

router.delete("/routines/:id", async (req, res) => {
  await db.delete(agentRoutinesTable)
    .where(and(eq(agentRoutinesTable.id, parseInt(req.params.id!)), eq(agentRoutinesTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

/** Run one now, without waiting for its trigger. */
router.post("/routines/:id/run", async (req, res) => {
  const userId = req.session.userId!;
  const [r] = await db.select().from(agentRoutinesTable)
    .where(and(eq(agentRoutinesTable.id, parseInt(req.params.id!)), eq(agentRoutinesTable.userId, userId))).limit(1);
  if (!r) return res.status(404).json({ error: "المهمة غير موجودة" });

  const result = await runRoutine(r);
  await db.insert(agentRoutineRunsTable).values({
    routineId: r.id, userId, output: result.output ?? null, error: result.error ?? null,
  });
  await db.update(agentRoutinesTable).set({ lastRunAt: new Date() })
    .where(eq(agentRoutinesTable.id, r.id));
  res.json(result);
});

export default router;
