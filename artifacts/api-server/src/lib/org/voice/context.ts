// ── من يُكلَّم، وهل يستطيع أن يجيب، وماذا يعرف ─────────────────────
// كل استعلام هنا مقيَّد بـ user_id الجلسة: موظف حسابٍ آخر «غير موجود»، لا «ممنوع».
// السياق للقراءة فقط: نبض الموظف، مهامه، تنفيذه الأخير، بطاقته، ذاكرته المعتمدة، وقائع
// الحساب، وآخر تقرير تنفيذي للمدير. لكل عنصرٍ معرّف دليل يستشهد به الموظف، وما يستشهد به
// خارج هذه المجموعة يُحذف من جوابه.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { isHalted } from "../controls";
import { departmentOf } from "../departments";
import { backfillRegistry } from "../registry";
import { CEO_KEY, CEO_ROLE, ensureCeo, listReports } from "../ceo";
import { memoryFor } from "../memory";
import { latestScorecards } from "../scorecards";
import { redact } from "./limits";
import { activeRuntime } from "../docs/dossier";

export interface EmployeeRef {
  key: string; role: string; name: string; title: string | null; department: string | null;
  isActive: boolean; persona: string | null; promptVersion: number | null;
}

/** موظف هذا الحساب بمفتاحه، أو null. يوظّف المدير التنفيذي إن طُلب ولم يكن. */
export async function findEmployee(userId: number, key: string): Promise<EmployeeRef | null> {
  const k = String(key ?? "").trim().slice(0, 60);
  if (!/^[a-z0-9_]+\.[a-z0-9_.-]+$/i.test(k)) return null;
  if (k === CEO_KEY) await ensureCeo(userId);
  await backfillRegistry(userId);
  const [r] = (await db.execute<any>(sql`SELECT employee_key, role, name, title, department, is_active, persona, prompt_version
    FROM bot_employees WHERE user_id = ${userId} AND employee_key = ${k} LIMIT 1`)).rows;
  return r ? {
    key: r.employee_key, role: r.role, name: r.name, title: r.title ?? null, department: r.department ?? null,
    isActive: !!r.is_active, persona: r.persona ?? null, promptVersion: r.prompt_version == null ? null : Number(r.prompt_version),
  } : null;
}

export const isCeo = (e: Pick<EmployeeRef, "key" | "role">) => e.key === CEO_KEY || e.role === CEO_ROLE;

export type Availability = { ok: true } | { ok: false; state: "unavailable" | "busy"; reason: string };

/**
 * هل يستطيع أن يجيب الآن؟ موقوفٌ بيد صاحبه، أو بمفتاح (منصة/حساب/قسم/موظف) = غير متاح بسببه.
 * في مكالمةٍ أخرى متصلة = مشغول. لا شيء يُفترض: كل جوابٍ هنا من صفٍّ في القاعدة.
 */
export async function availability(userId: number, e: EmployeeRef, o: { exceptCallId?: number; checkBusy?: boolean } = {}): Promise<Availability> {
  if (!e.isActive) return { ok: false, state: "unavailable", reason: "الموظف موقوف من صاحب الحساب" };
  const h = await isHalted({ userId, role: e.role, department: departmentOf(e.role) });
  if (h.halted) return { ok: false, state: "unavailable", reason: `موقوف بمفتاح (${h.scope ?? "?"})${h.reason ? `: ${h.reason}` : ""}` };
  if (o.checkBusy !== false) {
    const [busy] = (await db.execute<any>(sql`SELECT id FROM owner_calls WHERE user_id = ${userId} AND employee_key = ${e.key} AND state = 'connected'
      ${o.exceptCallId ? sql`AND id <> ${o.exceptCallId}` : sql``} LIMIT 1`)).rows;
    if (busy) return { ok: false, state: "busy", reason: `في مكالمة أخرى لم تُنهَ (#${busy.id})` };
  }
  return { ok: true };
}

// ── الملف النشط (المسار B) ────────────────────────────────────────
// النسخة النشطة من ملف الموظف، بتعليماتها المجمَّعة كما تعمل الآن (docs/dossier.activeRuntime).
// لا نسخة نشطة بعد: الشخصية الحالية في bot_employees.persona وحدها.
async function activeDossier(userId: number, key: string): Promise<string | null> {
  try {
    const text = await activeRuntime(userId, key);
    return text ? redact(text).slice(0, 6_000) : null;
  } catch { return null; }
}

export interface ContextPack { facts: Record<string, unknown>; ids: Set<string>; dossier: string | null }

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const clip = (v: unknown, n = 200) => (v == null ? null : redact(String(v)).slice(0, n));

/** ما يقرؤه الموظف قبل أن يجيب. لا بيانات حسابٍ آخر: كل استعلام بـ user_id. */
export async function contextFor(userId: number, e: EmployeeRef): Promise<ContextPack> {
  const ids = new Set<string>();
  const add = (id: string) => { ids.add(id); return id; };
  const [beat, tasks, runs, cards, memory, dossier] = await Promise.all([
    db.execute<any>(sql`SELECT * FROM employee_heartbeats WHERE user_id = ${userId} AND employee_key = ${e.key}`),
    db.execute<any>(sql`SELECT task_id, task_type, status, approval_status, due_at, failure_reason, input_refs, created_at FROM employee_tasks
      WHERE user_id = ${userId} AND owner_role = ${e.role} ORDER BY task_id DESC LIMIT 12`),
    db.execute<any>(sql`SELECT id, kind, status, started_at, duration_ms, error FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${e.key} ORDER BY id DESC LIMIT 10`)
      .catch(() => db.execute<any>(sql`SELECT id, status, started_at, error FROM employee_executions WHERE user_id = ${userId} AND employee_key = ${e.key} ORDER BY id DESC LIMIT 10`)),
    latestScorecards(userId, "weekly", e.key).catch(() => []),
    memoryFor(userId, e.role, 12).catch(() => ({ employee: [], department: [], account: [] })),
    activeDossier(userId, e.key),
  ]);
  const b = beat.rows[0];
  const facts: Record<string, unknown> = {
    account: userId,
    employee: { key: e.key, name: e.name, title: e.title, department: e.department, promptVersion: e.promptVersion },
    heartbeat: b ? { id: add(`heartbeat:${e.key}`), status: b.status, lastBeatAt: iso(b.last_beat_at), lastSuccessAt: iso(b.last_success_at), lastFailureAt: iso(b.last_failure_at),
      lastError: clip(b.last_error), consecutiveFailures: Number(b.consecutive_failures ?? 0) } : "لا نبض مسجّل",
    tasks: tasks.rows.map((t: any) => ({ id: add(`task:${t.task_id}`), type: t.task_type, status: t.status, approval: t.approval_status, dueAt: iso(t.due_at),
      failure: clip(t.failure_reason), title: clip((t.input_refs as any)?.title ?? null, 160), createdAt: iso(t.created_at) })),
    recentRuns: runs.rows.map((r: any) => ({ id: add(`execution:${r.id}`), kind: r.kind ?? null, status: r.status, startedAt: iso(r.started_at), ms: r.duration_ms ?? null, error: clip(r.error, 160) })),
    scorecard: cards[0] ? { id: add(`scorecard:${cards[0].periodKey}`), status: cards[0].status, score: cards[0].score, confidence: cards[0].confidence, sampleSize: cards[0].sampleSize,
      metrics: cards[0].metrics.map((m) => ({ key: m.key, status: m.status, value: m.value, score: m.score, n: m.sampleSize })) } : "لا بطاقة أداء",
    memory: [...memory.employee, ...memory.department].map((m) => ({ id: add(`memory:${m.layer}:${m.id}`), kind: m.kind, content: clip(m.content, 300) })),
    accountFacts: memory.account.map((m) => ({ id: add(`fact:${m.id}`), key: m.kind, value: clip(m.content, 300) })),
  };
  if (isCeo(e)) {
    const [report] = await listReports(userId, 1).catch(() => []);
    facts["latestCeoReport"] = report ? {
      id: add(`ceo_report:${report.id}`), day: report.period_key, status: report.narrative_status, summary: clip(report.executive_summary, 1_200), thinData: report.thin_data,
      priorities: report.top_priorities, alerts: report.employee_alerts, answers: report.answers,
    } : "لا تقرير تنفيذي بعد";
    const team = await db.execute<any>(sql`SELECT e.employee_key, e.name, e.department, e.is_active, h.status, h.consecutive_failures, h.last_beat_at
      FROM bot_employees e LEFT JOIN employee_heartbeats h ON h.user_id = e.user_id AND h.employee_key = e.employee_key
      WHERE e.user_id = ${userId} AND e.employee_key IS NOT NULL ORDER BY e.department, e.employee_key LIMIT 60`);
    facts["team"] = team.rows.map((t: any) => ({ id: add(`employee:${t.employee_key}`), name: t.name, department: t.department, active: !!t.is_active,
      heartbeat: t.status ?? "no_execution", failures: Number(t.consecutive_failures ?? 0), lastBeatAt: iso(t.last_beat_at) }));
  }
  return { facts, ids, dossier };
}
