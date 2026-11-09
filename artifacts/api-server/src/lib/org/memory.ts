// ── الذاكرة: ثلاث طبقات، وحلقة تعلّم ─────────────────────────────
// موظف (agent_memory)، قسم (department_memory)، حساب (account_knowledge). لا جدول رابع.
// كل قراءة هنا: حساب الجلسة + معتمَد + لم تنتهِ مدته. ما كتبه نموذج يبدأ pending ولا يدخل
// prompt حتى يعتمده صاحب العمل. من حسابٍ لآخر لا يعبر شيء: user_id في كل استعلام.
//
// الحلقة: ملاحظة (learning_events) ← درس معلّق ← موافقة ← تطبيق بخط أساس ← قياس ← نتيجة محفوظة.
// النتيجة رقمان من استعلام صاحب الدرس، لا رأي: لا خط أساس = INSUFFICIENT DATA.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { audit } from "./controls";
import { employeeKeyOf, orgDepartmentOf } from "./departments";
import { ensureOrgTables } from "./schema";

export type MemoryLayer = "employee" | "department" | "account";
export interface MemoryItem {
  id: number; layer: MemoryLayer; kind: string; content: string; sourceReference: string | null;
  confidence: number | null; lastVerifiedAt: unknown; expiryAt: unknown; version: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const item = (layer: MemoryLayer, r: any): MemoryItem => ({
  id: Number(r.id), layer, kind: r.kind ?? "fact", content: r.content ?? r.value, sourceReference: r.source_reference ?? null,
  confidence: num(r.confidence), lastVerifiedAt: r.last_verified_at ?? null, expiryAt: r.expiry_at ?? null, version: Number(r.version ?? 1),
});
/** الشرط الواحد لكل قراءة. */
const LIVE = sql`approval_status = 'approved' AND (expiry_at IS NULL OR expiry_at > now())`;
const cap = (n?: number) => Math.min(Math.max(n ?? 50, 1), 200);

// ── القراءة ───────────────────────────────────────────────────────
export async function employeeMemory(userId: number, role: string, o: { kind?: string; limit?: number } = {}): Promise<MemoryItem[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT id, kind, content, source_reference, confidence, last_verified_at, expiry_at, version FROM agent_memory
    WHERE user_id = ${userId} AND role = ${role} AND ${LIVE} ${o.kind ? sql`AND kind = ${o.kind}` : sql``} ORDER BY id DESC LIMIT ${cap(o.limit)}`);
  return r.rows.map((x: any) => item("employee", x));
}

export async function departmentMemory(userId: number, department: string, o: { kind?: string; limit?: number } = {}): Promise<MemoryItem[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT id, kind, content, source_reference, confidence, last_verified_at, expiry_at, version FROM department_memory
    WHERE user_id = ${userId} AND department = ${department} AND ${LIVE} ${o.kind ? sql`AND kind = ${o.kind}` : sql``} ORDER BY id DESC LIMIT ${cap(o.limit)}`);
  return r.rows.map((x: any) => item("department", x));
}

export async function accountKnowledge(userId: number, o: { key?: string; limit?: number } = {}): Promise<MemoryItem[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT id, key, value, source_reference, confidence, last_verified_at, expiry_at, version FROM account_knowledge
    WHERE user_id = ${userId} AND ${LIVE} ${o.key ? sql`AND key = ${o.key}` : sql``} ORDER BY key LIMIT ${cap(o.limit)}`);
  return r.rows.map((x: any) => ({ ...item("account", x), kind: x.key }));
}

/** ما يعرفه موظفٌ بعينه، من الطبقات الثلاث. */
export async function memoryFor(userId: number, role: string, limit = 50) {
  const [employee, department, account] = await Promise.all([employeeMemory(userId, role, { limit }), departmentMemory(userId, orgDepartmentOf(role), { limit }), accountKnowledge(userId, { limit })]);
  return { employee, department, account };
}

// ── حلقة التعلّم ──────────────────────────────────────────────────
export interface Observation { employeeKey?: string | null; role?: string | null; department?: string | null; eventType: string; outcome?: string | null; evidence?: unknown }

/** ١. ملاحظة: ما حدث، بدليله. */
export async function observe(userId: number, o: Observation): Promise<number> {
  await ensureOrgTables();
  const key = o.employeeKey ?? (o.role ? employeeKeyOf(o.role) : null);
  const dept = o.department ?? (o.role ? orgDepartmentOf(o.role) : null);
  const r = await db.execute<{ id: number }>(sql`INSERT INTO learning_events (user_id, employee_key, department, event_type, outcome, evidence)
    VALUES (${userId}, ${key}, ${dept}, ${o.eventType.slice(0, 40)}, ${o.outcome?.slice(0, 20) ?? null}, ${JSON.stringify(o.evidence ?? null)}::jsonb) RETURNING id`);
  return Number(r.rows[0]!.id);
}

export interface LessonDraft {
  layer: MemoryLayer; content: string; kind?: string; role?: string; department?: string; key?: string;
  eventId?: number | null; confidence?: number | null; expiryAt?: Date | null;
}
const sourceOf = (d: LessonDraft) => (d.eventId ? `learning_event:${d.eventId}` : null);

/** ٢. درس من الملاحظة: يبدأ معلّقاً دائماً، ولا يقرؤه أحد حتى يُعتمد. */
export async function proposeLesson(userId: number, d: LessonDraft): Promise<{ layer: MemoryLayer; id: number }> {
  await ensureOrgTables();
  const conf = d.confidence == null ? null : Math.max(0, Math.min(1, d.confidence));
  let id: number;
  if (d.layer === "employee") {
    if (!d.role) throw new Error("درس موظف بلا دور");
    const r = await db.execute<{ id: number }>(sql`INSERT INTO agent_memory (user_id, role, kind, content, source_reference, confidence, approval_status, expiry_at)
      VALUES (${userId}, ${d.role}, ${d.kind ?? "playbook"}, ${d.content.slice(0, 4000)}, ${sourceOf(d)}, ${conf}, 'pending', ${d.expiryAt ?? null}) RETURNING id`);
    id = Number(r.rows[0]!.id);
  } else if (d.layer === "department") {
    if (!d.department) throw new Error("درس قسم بلا قسم");
    const r = await db.execute<{ id: number }>(sql`INSERT INTO department_memory (user_id, department, kind, content, source_reference, confidence, approval_status, expiry_at)
      VALUES (${userId}, ${d.department}, ${(d.kind ?? "lesson").slice(0, 20)}, ${d.content.slice(0, 4000)}, ${sourceOf(d)}, ${conf}, 'pending', ${d.expiryAt ?? null}) RETURNING id`);
    id = Number(r.rows[0]!.id);
  } else {
    if (!d.key) throw new Error("معرفة حساب بلا مفتاح");
    // تغيّرت قيمةٌ معتمدة: تعود معلّقة بنسخةٍ أعلى، فلا تُقرأ حتى تُعتمد من جديد.
    const r = await db.execute<{ id: number }>(sql`INSERT INTO account_knowledge (user_id, key, value, source_reference, confidence, approval_status, expiry_at)
      VALUES (${userId}, ${d.key.slice(0, 120)}, ${d.content.slice(0, 4000)}, ${sourceOf(d)}, ${conf}, 'pending', ${d.expiryAt ?? null})
      ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, source_reference = EXCLUDED.source_reference, confidence = EXCLUDED.confidence, approval_status = 'pending',
        version = account_knowledge.version + 1, expiry_at = EXCLUDED.expiry_at, updated_at = now() RETURNING id`);
    id = Number(r.rows[0]!.id);
  }
  return { layer: d.layer, id };
}

const TABLE: Record<MemoryLayer, ReturnType<typeof sql.raw>> = { employee: sql.raw("agent_memory"), department: sql.raw("department_memory"), account: sql.raw("account_knowledge") };

/** ٣. قرار صاحب الحساب. لا يعتمد إلا صفّ حسابه، ولا ما ليس معلّقاً. */
export async function decideLesson(userId: number, layer: MemoryLayer, id: number, status: "approved" | "rejected", actor: number): Promise<boolean> {
  const r = await db.execute(sql`UPDATE ${TABLE[layer]} SET approval_status = ${status}, last_verified_at = now() WHERE id = ${id} AND user_id = ${userId} AND approval_status = 'pending' RETURNING id`);
  if (!r.rows.length) return false;
  await audit({ userId, action: `lesson.${status}`, actor, kind: layer, meta: { id, layer } });
  return true;
}

/** ٤. طُبّق: يُكتب خط الأساس لحظة التطبيق، ليُقاس عليه لاحقاً. درسٌ غير معتمد لا يُطبَّق. */
export async function markLessonApplied(userId: number, layer: MemoryLayer, id: number, baseline: { metric: string; value: number | null; better?: "higher" | "lower" }): Promise<number | null> {
  const [row] = (await db.execute(sql`SELECT 1 FROM ${TABLE[layer]} WHERE id = ${id} AND user_id = ${userId} AND approval_status = 'approved'`)).rows;
  if (!row) return null;
  return observe(userId, { eventType: "lesson_applied", evidence: { layer, id, metric: baseline.metric, baseline: baseline.value, better: baseline.better ?? "higher" } });
}

export type LessonOutcome = "improved" | "worse" | "flat" | "INSUFFICIENT DATA";
/** النتيجة من رقمين. أحدهما غائب: لا حكم. Pure. */
export function lessonOutcome(baseline: number | null | undefined, after: number | null | undefined, better: "higher" | "lower" = "higher", eps = 0): LessonOutcome {
  if (baseline == null || after == null || !Number.isFinite(baseline) || !Number.isFinite(after)) return "INSUFFICIENT DATA";
  const d = after - baseline;
  if (Math.abs(d) <= eps) return "flat";
  return (better === "higher" ? d > 0 : d < 0) ? "improved" : "worse";
}

/** ٥–٦. قياسٌ بعد التطبيق، ويُحفظ. بلا سطر تطبيق: لا شيء يُقاس عليه. */
export async function measureLesson(userId: number, layer: MemoryLayer, id: number, after: number | null, n?: number | null): Promise<{ eventId: number; outcome: LessonOutcome } | null> {
  const [a] = (await db.execute<any>(sql`SELECT id, evidence FROM learning_events WHERE user_id = ${userId} AND event_type = 'lesson_applied' AND evidence->>'layer' = ${layer} AND (evidence->>'id')::int = ${id} ORDER BY id DESC LIMIT 1`)).rows;
  if (!a) return null;
  const outcome = lessonOutcome(a.evidence?.baseline, after, a.evidence?.better);
  const eventId = await observe(userId, { eventType: "lesson_measured", outcome: outcome === "INSUFFICIENT DATA" ? "insufficient" : outcome,
    evidence: { layer, id, appliedEvent: Number(a.id), metric: a.evidence?.metric, baseline: a.evidence?.baseline ?? null, after, sampleSize: n ?? null, status: outcome } });
  return { eventId, outcome };
}

export async function lessonHistory(userId: number, layer: MemoryLayer, id: number) {
  const r = await db.execute<any>(sql`SELECT id, event_type, outcome, evidence, created_at FROM learning_events WHERE user_id = ${userId} AND evidence->>'layer' = ${layer} AND (evidence->>'id')::int = ${id} ORDER BY id`);
  return r.rows;
}
