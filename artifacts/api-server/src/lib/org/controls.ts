// ── مفاتيح الإيقاف ────────────────────────────────────────────────
// سؤالٌ واحد قبل كل إرسالٍ وكل نداء نموذج وكل جولة عامل: هل هذا موقوف؟
// الترتيب من الأوسع: المنصة → الحساب → القناة → القسم → الموظف. يبقى المفتاحان
// القديمان (team_paused على الحساب وis_active على الموظف) كما هما ويُقرآن من
// graph/switch.ts، فلا قاعدة مكررة ولا إضعاف.
//
// الفشل يُغلق: إن تعذّرت قراءة الجدول فالجواب «موقوف» — رسالةٌ لم تخرج تُعاد،
// ورسالةٌ خرجت من حسابٍ أوقفه صاحبه لا تُستعاد.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { currentAgent } from "../agent-context";
import { offDuty } from "../graph/switch";
import { ensureOrgTables } from "./schema";
import { departmentOf, employeeNames, haltNames } from "./departments";

export { departmentOf };

export const SCOPES = ["global", "account", "channel", "department", "employee"] as const;
export type Scope = (typeof SCOPES)[number];
export const CHANNELS = ["whatsapp", "email", "instagram", "tiktok", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface ControlRow { scope: string; userId: number | null; target: string; engaged: boolean; reason: string | null }
export interface HaltQuery {
  userId?: number | null;
  /** قسمٌ أو أكثر: إرسال بريد من موظف «الحسابات» يُسأل عنه قسماه كلاهما. */
  department?: string | string[] | null;
  role?: string | null;
  channel?: string | null;
}
export interface Halt {
  halted: boolean;
  scope: Scope | "controls" | null;
  reason: string | null;
  /** أوقفه المفتاحان القديمان لا org_controls: رسالة صاحب العمل اليدوية تمرّ كما كانت. */
  legacy?: boolean;
}

export const CLEAR: Halt = { halted: false, scope: null, reason: null };
export const UNAVAILABLE: Halt = { halted: true, scope: "controls", reason: "controls unavailable" };
export const isUnavailable = (h: Halt) => h.scope === "controls";

/** القسم الذي تنتمي إليه القناة نفسها، فمفتاح قسم البريد يوقف البريد أيّاً كان مرسله. Pure. */
export const departmentOfChannel = (channel: string): string => (channel === "email" || channel === "whatsapp" ? channel : "social");

const why = (r: ControlRow, fallback: string) => r.reason?.trim() || fallback;

/**
 * القرار نفسه، بلا قاعدة بيانات. Pure.
 *
 * صفّ حسابٍ آخر لا يُرى هنا مهما كان: مفتاح حسابٍ لا يُسقط غيره. ومفتاح القناة أو
 * القسم أو الموظف إما عام (user_id فارغ، للمدير) أو لهذا الحساب وحده.
 */
export function decideHalt(rows: ControlRow[], q: HaltQuery, legacy: { teamPaused?: boolean; employeeOff?: boolean } = {}): Halt {
  const on = rows.filter((r) => r.engaged);
  const mine = (r: ControlRow) => r.userId == null || (q.userId != null && r.userId === q.userId);

  const g = on.find((r) => r.scope === "global");
  if (g) return { halted: true, scope: "global", reason: why(g, "موقوف على مستوى المنصة") };

  if (q.userId != null) {
    const a = on.find((r) => r.scope === "account" && r.userId === q.userId);
    if (a) return { halted: true, scope: "account", reason: why(a, "الحساب موقوف") };
    if (legacy.teamPaused) return { halted: true, scope: "account", reason: "الفريق كله موقوف", legacy: true };
  }
  if (q.channel) {
    const c = on.find((r) => r.scope === "channel" && r.target === q.channel && mine(r));
    if (c) return { halted: true, scope: "channel", reason: why(c, `قناة ${q.channel} موقوفة`) };
  }
  // كل الأسماء من خريطةٍ واحدة (departments.ts)، فأي نقطة تسأل هنا — complete وgateSend وrunAs — تتوقف بالاسم نفسه.
  const depts = [...new Set([...(Array.isArray(q.department) ? q.department : [q.department]), q.channel, ...haltNames(q.role)].filter((d): d is string => !!d))];
  if (depts.length) {
    const d = on.find((r) => r.scope === "department" && depts.includes(r.target) && mine(r));
    if (d) return { halted: true, scope: "department", reason: why(d, `قسم ${d.target} موقوف`) };
  }
  if (q.role) {
    const names = employeeNames(q.role);
    const e = on.find((r) => r.scope === "employee" && names.includes(r.target) && mine(r));
    if (e) return { halted: true, scope: "employee", reason: why(e, "الموظف موقوف") };
    if (legacy.employeeOff) return { halted: true, scope: "employee", reason: "الموظف موقوف", legacy: true };
  }
  return CLEAR;
}

// ── القراءة ───────────────────────────────────────────────────────
export const CONTROLS_TTL_MS = 10_000;
const cache = new Map<number, { at: number; rows: ControlRow[] }>();

/** أُلغيت الذاكرة: تغيّر مفتاح، أو اختبار. */
export function forgetControls(userId?: number | null) {
  if (userId == null) cache.clear(); else cache.delete(userId);
}

async function readControls(userId: number | null | undefined): Promise<ControlRow[]> {
  const key = userId ?? 0;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CONTROLS_TTL_MS) return hit.rows;
  await ensureOrgTables();
  const q = () => db.execute<{ scope: string; user_id: number | null; target: string; engaged: boolean; reason: string | null }>(sql`
    SELECT scope, user_id, target, engaged, reason FROM org_controls
    WHERE engaged AND (user_id IS NULL OR user_id = ${userId ?? null})`);
  // مرة ثانية قبل الإغلاق: انقطاعٌ لحظي لا يستحق إيقاف حملة، وفقد الجدول لن يصلحه شيء.
  const r = await q().catch(async () => { await new Promise((ok) => setTimeout(ok, 150)); return q(); });
  const rows = r.rows.map((x) => ({ scope: x.scope, userId: x.user_id, target: x.target, engaged: x.engaged, reason: x.reason }));
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** هل هذا موقوف الآن؟ لا يرمي أبداً: تعذّر القراءة جوابه «موقوف». */
export async function isHalted(q: HaltQuery = {}): Promise<Halt> {
  let rows: ControlRow[];
  try { rows = await readControls(q.userId); }
  catch (err) {
    logger.warn({ err: String((err as any)?.message ?? err).slice(0, 160) }, "مفاتيح الإيقاف لا تُقرأ — أُغلق الإرسال والنماذج");
    return UNAVAILABLE;
  }
  // المفتاحان القديمان عبر مصدرهما، بعباراتهما نفسها.
  let legacy = {};
  if (q.userId != null) {
    const off = await offDuty(q.userId, q.role ?? "");
    legacy = { teamPaused: off === "الفريق كله موقوف", employeeOff: off === "الموظف موقوف" };
  }
  return decideHalt(rows, q, legacy);
}

/** أيُوقف النموذج المباشر (الرؤية، التفريغ، التصنيف)؟ الحساب إن عُرف، وإلا المنصة وحدها. */
export async function modelHalted(userId?: number | null): Promise<boolean> {
  const who = currentAgent();
  const uid = userId ?? who?.userId ?? null;
  const role = who && who.userId === uid ? who.role : null;
  return (await isHalted({ userId: uid, role, department: departmentOf(role) })).halted;
}

// ── العمّال ───────────────────────────────────────────────────────
const SKIP_NOTE_MS = 10 * 60_000;
const skipNoted = new Map<string, number>();

/**
 * أيتخطّى عاملٌ مجدول هذا الحساب في هذه الجولة؟ يُسجَّل في السجل مرةً كل عشر دقائق
 * للعامل والحساب، فالمفتاح يظهر أثره ولا يملأ الجدول سطراً كل عشرين ثانية.
 */
export async function accountHalted(userId: number, worker: string): Promise<boolean> {
  const h = await isHalted({ userId });
  if (!h.halted) return false;
  const k = `${userId}:${worker}`;
  if (Date.now() - (skipNoted.get(k) ?? 0) > SKIP_NOTE_MS) {
    skipNoted.set(k, Date.now());
    await audit({ userId, action: "worker.skipped", scope: h.scope, kind: worker, why: h.reason }).catch(() => {});
  }
  return true;
}

/** عاملٌ بلا حساب بعينه (يمرّ على الجميع): المنصة وحدها توقفه. */
export const platformHalted = async (): Promise<boolean> => (await isHalted({})).halted;

/** الحسابات التي لم يُوقفها مفتاح، بترتيبها. */
export async function activeAccounts(userIds: number[], worker: string): Promise<number[]> {
  const out: number[] = [];
  for (const id of userIds) if (!(await accountHalted(id, worker))) out.push(id);
  return out;
}

// ── السجل ─────────────────────────────────────────────────────────
export interface AuditEntry {
  userId?: number | null; action: string; scope?: string | null; channel?: string | null; kind?: string | null;
  recipient?: string | null; role?: string | null; actor?: number | null; why?: string | null; count?: number; meta?: unknown;
}

/** سطرٌ في السجل. يرمي إن فشل: من يهمّه ذلك يقرر، والبوابة تكتمه وتسجّله في اللوق. */
export async function audit(e: AuditEntry): Promise<void> {
  await db.execute(sql`INSERT INTO org_audit_log (user_id, action, scope, channel, kind, recipient, role, actor, why, count, meta)
    VALUES (${e.userId ?? null}, ${e.action.slice(0, 40)}, ${e.scope ?? null}, ${e.channel ?? null}, ${e.kind?.slice(0, 30) ?? null},
      ${e.recipient?.slice(0, 254) ?? null}, ${e.role?.slice(0, 60) ?? null}, ${e.actor ?? null}, ${e.why ?? null}, ${e.count ?? 1},
      ${e.meta === undefined ? null : JSON.stringify(e.meta)}::jsonb)`);
}

// ── تغيير المفتاح ─────────────────────────────────────────────────
export type ControlInput = { scope: string; target?: string | null; engaged: boolean; reason?: string | null };

/**
 * من يملك أن يضع هذا المفتاح، وعلى من. Pure.
 *
 * المنصة والمفاتيح العامة للمدير وحده. صاحب الحساب يضع مفاتيح حسابه فقط: حسابه
 * كله، أو قناةً أو قسماً أو موظفاً فيه.
 */
export function controlScopeFor(input: ControlInput, actor: { userId: number; isAdmin: boolean; forUserId?: number | null; platformWide?: boolean }):
  { ok: true; scope: Scope; userId: number | null; target: string } | { ok: false; status: number; error: string } {
  const scope = String(input.scope ?? "") as Scope;
  if (!SCOPES.includes(scope)) return { ok: false, status: 400, error: "نطاق غير معروف" };
  const target = String(input.target ?? "").trim().slice(0, 60);
  if (scope === "global") {
    if (!actor.isAdmin) return { ok: false, status: 403, error: "الإيقاف على مستوى المنصة للمدير وحده" };
    return { ok: true, scope, userId: null, target: "" };
  }
  if (scope !== "account" && !target) return { ok: false, status: 400, error: "حدّد القناة أو القسم أو الموظف" };
  if (scope === "channel" && !(CHANNELS as readonly string[]).includes(target)) return { ok: false, status: 400, error: "قناة غير معروفة" };
  if (actor.platformWide) {
    if (!actor.isAdmin) return { ok: false, status: 403, error: "المفاتيح العامة للمدير وحده" };
    if (scope === "account") return { ok: false, status: 400, error: "إيقاف الحساب يخصّ حساباً بعينه" };
    return { ok: true, scope, userId: null, target };
  }
  // المدير وحده يضع مفتاحاً على حسابٍ غير حسابه.
  const userId = actor.forUserId != null && actor.forUserId !== actor.userId
    ? (actor.isAdmin ? actor.forUserId : null) : actor.userId;
  if (userId == null) return { ok: false, status: 403, error: "لا تملك هذا الحساب" };
  return { ok: true, scope, userId, target: scope === "account" ? "" : target };
}

/** يضع المفتاح ويكتب ذلك في السجل، ويصل أثره فوراً في هذه العملية. */
export async function setControl(c: { scope: Scope; userId: number | null; target: string; engaged: boolean; reason?: string | null; actor?: number | null }): Promise<void> {
  await ensureOrgTables();
  await db.execute(sql`INSERT INTO org_controls (scope, user_id, target, engaged, reason, set_by, set_at)
    VALUES (${c.scope}, ${c.userId}, ${c.target}, ${c.engaged}, ${c.reason ?? null}, ${c.actor ?? null}, now())
    ON CONFLICT (scope, COALESCE(user_id, 0), target) DO UPDATE SET engaged = EXCLUDED.engaged, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now()`);
  forgetControls(c.userId == null ? undefined : c.userId);
  await audit({ userId: c.userId, action: c.engaged ? "control.engaged" : "control.released", scope: c.scope, actor: c.actor ?? null, why: c.reason ?? null, kind: c.target || null });
}
