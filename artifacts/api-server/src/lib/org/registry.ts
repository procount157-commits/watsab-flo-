// ── سجل الموظفين الفني ────────────────────────────────────────────
// الاسم يتغيّر بيد صاحب العمل، والدور يربط الصف بمحرّكه؛ المفتاح (email.copywriter)
// هو الهوية الثابتة التي يُكتب بها النبض والتنفيذ. الجدول أدناه كُتب بقراءة الشيفرة:
// «own» يعني أن له عاملاً يمرّ على runAs باسمه، و«part_of» أن عمله خطوةٌ داخل جولة
// غيره، و«on_demand» أنه لا يعمل إلا بطلب، و«none» شخصيةٌ بتعليماتٍ بلا محرّك —
// ويُقال ذلك كما هو، فموظفٌ بلا عامل لا يظهر سليماً.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { isHalted } from "./controls";
import { ensureOrgTables } from "./schema";

export * from "./departments";
import { ROLE_MAP, employeeKeyOf, intervalOf, orgDepartmentOf, type ExecutionKind, type StaticEntry } from "./departments";

/**
 * يملأ المفتاح والقسم والفترة لكل صف ينقصه. يُعاد بأمان، ولا يمسّ اسماً ولا تاريخاً.
 * الدور فريدٌ في الحساب (idx_bot_employees_role)، فالمفتاح لا يتكرر.
 */
export async function backfillRegistry(userId?: number, o: { seed?: boolean } = {}): Promise<number> {
  await ensureOrgTables();
  const rows = (await db.execute<{ id: number; role: string; user_id: number }>(sql`SELECT id, role, user_id FROM bot_employees WHERE employee_key IS NULL ${userId == null ? sql`` : sql`AND user_id = ${userId}`}`)).rows;
  let n = 0;
  const hired = new Set<number>();
  for (const r of rows) {
    const done = await db.execute(sql`UPDATE bot_employees SET employee_key = ${employeeKeyOf(r.role)}, department = ${orgDepartmentOf(r.role)},
        heartbeat_interval_sec = ${intervalOf(r.role)} WHERE id = ${r.id} AND employee_key IS NULL`).catch((err) => {
      logger.warn({ id: r.id, role: r.role, err: String(err?.message ?? err).slice(0, 160) }, "تعذّر مفتاح موظف");
      return null;
    });
    if (done?.rowCount) hired.add(Number(r.user_id));
    n += done?.rowCount ?? 0;
  }
  // موظفٌ وُظّف الآن يأخذ مسودة ملفه بلا إعادة تشغيل (البذر يُعاد بأمان، والدوري كل ساعة يلتقط ما فات).
  if (hired.size && o.seed !== false) {
    const { seedDossiers } = await import("./docs/dossier");
    for (const u of hired) await seedDossiers(u).catch((err) => logger.warn({ userId: u, err: String(err?.message ?? err).slice(0, 160) }, "بذر ملف الموظف الجديد تعذّر"));
  }
  return n;
}

// ── النبض ─────────────────────────────────────────────────────────
export type HeartbeatState = "no_execution" | "running" | "healthy" | "late" | "failed" | "halted" | "planned" | "no_account";
/** موظفٌ على الورق بلا تكامل مصرّح (لينكدإن): «مخطط»، لا «بلا تنفيذ» ولا «فشل». Pure. */
export const isPlanned = (department: string | null | undefined) => department === "linkedin";
/** من ينتظر حساب منصة ليعمل: الناقل والمحلل في إنستغرام وتيك توك. */
export const NEEDS_SOCIAL_ACCOUNT = new Set(["ig_inviter", "ig_analyst", "tt_inviter", "tt_analyst"]);
export interface HeartbeatRow { status: string; lastBeatAt: Date | string | null; lastStartedAt?: Date | string | null }
export const MISSED_FACTOR = 2;

/** ما يُقال عن موظف من صف نبضه. لا صف = no_execution، ولا يُقال سليم أبداً. Pure. */
export function heartbeatState(row: HeartbeatRow | null | undefined, intervalSec: number | null, now = Date.now()): HeartbeatState {
  if (!row) return "no_execution";
  if (row.status === "halted") return "halted";
  const last = row.lastBeatAt ? new Date(row.lastBeatAt).getTime() : 0;
  if (intervalSec && now - last > MISSED_FACTOR * intervalSec * 1000) return "late";
  if (row.status === "failed") return "failed";
  if (row.status === "running") return "running";
  return "healthy";
}

// ── الجرد ─────────────────────────────────────────────────────────
export interface InventoryRow {
  key: string; name: string; role: string; account: number; department: string; title: string | null;
  prompt_location: string | null; scheduler_location: string | null; execution_function: string | null;
  execution: ExecutionKind; integration_status: string; permission_status: string;
  heartbeat_status: HeartbeatState; carried_by: string | null; carried_by_status: HeartbeatState | null;
  interval_sec: number | null; last_heartbeat: unknown; last_success: unknown; last_failure: unknown; last_error: string | null;
  consecutive_failures: number; dependencies: string[];
}

async function integrations(userId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const [mail] = (await db.execute<{ ok: boolean }>(sql`SELECT (from_email IS NOT NULL AND (smtp_host IS NOT NULL OR api_key IS NOT NULL)) AS ok FROM email_settings WHERE user_id = ${userId}`).catch(() => ({ rows: [] as any[] }))).rows;
  out["email"] = mail?.ok ? "email_configured" : "email_not_configured";
  out["target_accounts"] = out["email"]!;
  const social = (await db.execute<{ platform: string; state: string; autopilot: boolean }>(sql`SELECT platform, state, autopilot FROM social_accounts WHERE user_id = ${userId}`).catch(() => ({ rows: [] as any[] }))).rows;
  for (const p of ["instagram", "tiktok"]) {
    const a = social.find((x) => x.platform === p);
    out[p] = a ? `${a.state}${a.autopilot ? "" : ", autopilot_off"}` : "no_account";
  }
  out["linkedin"] = "no_driver";
  let wa = "unknown";
  // allStates لا getStatus: تلك تنشئ جلسةً وتفتح اتصالاً لحسابٍ ليس له واحدة، والجرد لا يفتح شيئاً.
  try {
    const { waManager } = await import("../whatsapp");
    const st = waManager.allStates().find((x) => x.userId === userId);
    wa = !st ? "whatsapp_no_session" : st.connected ? "whatsapp_connected" : `whatsapp_${st.status}`;
  } catch {}
  out["whatsapp"] = wa; out["executive"] = wa; out["shared"] = wa;
  return out;
}

/** الجرد الفني لحسابٍ واحد: موظفوه كما هم في bot_employees، بنبضهم الحقيقي. */
export async function orgRegistry(userId: number): Promise<InventoryRow[]> {
  await backfillRegistry(userId);
  const [staff, beats, integ] = await Promise.all([
    db.execute<any>(sql`SELECT role, name, title, is_active, employee_key, department, heartbeat_interval_sec FROM bot_employees WHERE user_id = ${userId} AND employee_key IS NOT NULL ORDER BY department, role`),
    db.execute<any>(sql`SELECT employee_key, status, last_beat_at, last_started_at, last_success_at, last_failure_at, last_error, consecutive_failures FROM employee_heartbeats WHERE user_id = ${userId}`),
    integrations(userId),
  ]);
  const byKey = new Map<string, any>(beats.rows.map((b: any) => [b.employee_key, b]));
  const stateOf = (key: string, interval: number | null) => {
    const b = byKey.get(key);
    return heartbeatState(b ? { status: b.status, lastBeatAt: b.last_beat_at } : null, interval);
  };
  const out: InventoryRow[] = [];
  for (const s of staff.rows as any[]) {
    const st = ROLE_MAP[s.role];
    const key = s.employee_key as string;
    const interval = s.heartbeat_interval_sec == null ? st?.intervalSec ?? null : Number(s.heartbeat_interval_sec);
    const b = byKey.get(key);
    const halt = await isHalted({ userId, role: s.role });
    out.push({
      key, name: s.name, role: s.role, account: userId, department: s.department ?? orgDepartmentOf(s.role), title: s.title ?? null,
      prompt_location: st?.prompt ?? null, scheduler_location: st?.scheduler ?? null, execution_function: st?.fn ?? null,
      execution: st?.execution ?? "none", integration_status: integ[s.department ?? ""] ?? "unknown",
      permission_status: halt.halted ? `halted: ${halt.reason ?? ""}`.trim() : "allowed",
      heartbeat_status: isPlanned(s.department) ? "planned"
        : NEEDS_SOCIAL_ACCOUNT.has(s.role) && integ[s.department ?? ""] === "no_account" && !b ? "no_account" : stateOf(key, interval),
      carried_by: st?.carriedBy ?? null,
      carried_by_status: st?.carriedBy ? stateOf(st.carriedBy, interval) : null, interval_sec: interval,
      last_heartbeat: b?.last_beat_at ?? null, last_success: b?.last_success_at ?? null, last_failure: b?.last_failure_at ?? null, last_error: b?.last_error ?? null,
      consecutive_failures: Number(b?.consecutive_failures ?? 0), dependencies: st?.dependsOn ?? [],
    });
  }
  return out;
}

/** كم موظفاً له تنفيذ حقيقي، وكم جزء من غيره، وكم بلا شيء. Pure. */
export function executionCounts(entries: Array<Pick<StaticEntry, "execution">> = Object.values(ROLE_MAP)) {
  const out: Record<ExecutionKind, number> = { own: 0, part_of: 0, on_demand: 0, none: 0 };
  for (const x of entries) out[x.execution]++;
  return out;
}
