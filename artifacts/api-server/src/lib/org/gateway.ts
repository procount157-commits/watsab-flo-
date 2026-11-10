// ── البوابة: كل ما يخرج إلى العالم يمرّ من هنا ─────────────────────
// الحلقة الأخيرة قبل السلك في كل قناة (whatsapp.ts، email/provider.ts،
// social/drivers). ما تحتها — حاجز واتساب، نافذة البريد، السقوف، فاصل الشركة —
// يبقى في مكانه ويعمل أيضاً: هذه لا تحلّ محله، بل تقول شيئين لا يقولهما أحد
// منها: «المفتاح مُطفأ» و«هذا الشخص قال لا».
//
// تليجرام خارجها عمداً: تقرير لصاحب العمل نفسه، لا رسالة لعميل.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { audit, departmentOf, departmentOfChannel, isHalted, isUnavailable, type Channel, type Halt } from "./controls";
import { key9 } from "../wa-firewall-rules";
import { currentTicket, recordAction, recordGate } from "./ledger";
import { currentSimulation, recordSandbox } from "./simulation";

export type GateCode = "ok" | "halted" | "opted_out" | "no_driver" | "not_owner" | "duplicate" | "simulation";
export interface GateInput {
  userId: number; channel: Channel; kind: string; recipient?: string | null; role?: string | null; department?: string | null;
  /** مفتاح تكرار: لا يخرج الشيء نفسه مرتين، حتى بعد إعادة التشغيل. يتضمّن المحاولة إن كانت الإعادة مقصودة. */
  idempotencyKey?: string | null;
  /** الرسالة إلى صندوق صاحب العمل نفسه — شرط owner_notice. */
  selfAddressed?: boolean;
  /** فحصٌ ثانٍ قبيل السلك: المفاتيح وحدها، بلا عدّ ولا قائمة إلغاء. */
  recheck?: boolean;
}
export interface GateResult { allowed: boolean; why: string | null; code: GateCode; scope: Halt["scope"] }

/**
 * ما لا تخصّه قائمة الإلغاء، لأن الشخص هو من بدأ أو لأن صاحب العمل يكتب بيده:
 * رد على من كتب لنا، وإشعار طلبه، وتأكيد الإيقاف نفسه، ورسالة يدوية (admit في
 * الحاجز يرفض اليدوية الباردة لمن قال لا، والدافئة تمرّ كما كانت). كل ما عداها —
 * حملة، متابعة، تواصل بارد، عرض سعر، ووسم جديد يضيفه أحد — ممنوع. الأصل المنع.
 */
const NOT_SUPPRESSED = new Set(["reply", "transactional", "manual", "optout_ack", "post", "engage", "reply_comment", "owner_notice"]);
/** ما يكتبه صاحب العمل أو ما يكمل طلب الإيقاف: المفتاحان القديمان لم يكونا يوقفانه، ولن يوقفاه. */
const HUMAN_KINDS = new Set(["manual", "test", "diagnostic", "optout_ack"]);

export const suppressionApplies = (kind: string, selfAddressed = false) =>
  !NOT_SUPPRESSED.has(kind) && !(kind === "test" && selfAddressed);

const refuse = (code: GateCode, why: string, scope: Halt["scope"] = null): GateResult => ({ allowed: false, why, code, scope });
const OK: GateResult = { allowed: true, why: null, code: "ok", scope: null };

/** القرار بلا قاعدة بيانات. Pure. يُستدعى بعد معرفة حالة المفتاح وقائمة الإلغاء. */
export function decideGate(i: { channel: string; kind: string; selfAddressed?: boolean; halt: Halt; optedOut?: boolean | null }): GateResult {
  // لا مشغّل للينكدإن: يكتب الفريق الرسالة ويرسلها صاحب العمل بيده (accounts/desk.ts).
  if (i.channel === "linkedin") return refuse("no_driver", "لينكدإن بلا مشغّل — يرسلها صاحب العمل بيده");
  if (i.kind === "owner_notice") {
    return i.selfAddressed ? OK : refuse("not_owner", "owner_notice لصندوق صاحب العمل وحده");
  }
  if (i.halt.halted && !(i.halt.legacy && HUMAN_KINDS.has(i.kind))) return refuse("halted", i.halt.reason ?? "موقوف", i.halt.scope);
  if (i.optedOut && suppressionApplies(i.kind, i.selfAddressed)) return refuse("opted_out", "طلب الإيقاف — لا يُراسَل");
  return OK;
}

/** طلب الإيقاف، بأي صيغة للرقم، وعلى مستوى الحساب كله لا القائمة. يرمي إن تعذّرت القراءة. */
export async function isOptedOut(userId: number, channel: Channel, recipient: string): Promise<boolean> {
  if (channel === "whatsapp") {
    const r = await db.execute(sql`SELECT 1 FROM unsubscribed_phones WHERE user_id = ${userId}
      AND right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key9(recipient)}
      AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`);
    return r.rows.length > 0;
  }
  if (channel === "email") {
    // bounced/invalid ليسا طلب إيقاف: حارس الارتداد يتولاهما. unsubscribed/complained قول الشخص نفسه.
    const r = await db.execute(sql`SELECT 1 FROM email_contacts WHERE user_id = ${userId} AND lower(email) = ${recipient.trim().toLowerCase()}
      AND status IN ('unsubscribed','complained') LIMIT 1`);
    return r.rows.length > 0;
  }
  const r = await db.execute(sql`SELECT 1 FROM social_threads WHERE user_id = ${userId} AND platform = ${channel} AND handle = ${recipient} AND status = 'stopped' LIMIT 1`);
  return r.rows.length > 0;
}

// ── عدّاد المسموح ─────────────────────────────────────────────────
// سطرٌ مجمَّع كل بضع دقائق: كل إرسالٍ ناجح له إيصاله في receipts أو
// wa_firewall_sends، فسطرٌ لكل رسالة هنا لا يضيف إلا وزناً.
const allowedCounts = new Map<string, { userId: number; channel: string; n: number }>();
function countAllowed(userId: number, channel: string) {
  const k = `${userId}:${channel}`;
  const c = allowedCounts.get(k);
  if (c) c.n++; else allowedCounts.set(k, { userId, channel, n: 1 });
}
export const pendingAllowed = () => [...allowedCounts.values()].map((c) => ({ ...c }));
export async function flushAllowed(): Promise<number> {
  const rows = [...allowedCounts.values()];
  allowedCounts.clear();
  for (const r of rows) await audit({ userId: r.userId, action: "gate.allowed", channel: r.channel, count: r.n }).catch(() => {});
  return rows.length;
}
let flusher: NodeJS.Timeout | null = null;
export function startGateFlusher(): void {
  if (flusher) return;
  flusher = setInterval(() => void flushAllowed().catch(() => {}), 5 * 60_000);
  flusher.unref();
}

async function logRefusal(i: GateInput, r: GateResult) {
  // فشل السجل لا يفتح البوابة ولا يغلقها أكثر مما هي، لكنه يُقال.
  await audit({ userId: i.userId, action: "gate.refused", scope: r.scope, channel: i.channel, kind: i.kind, recipient: i.recipient ?? null, role: i.role ?? null, why: `${r.code}: ${r.why ?? ""}` })
    .catch((err) => logger.error({ userId: i.userId, channel: i.channel, kind: i.kind, why: r.why, err: String(err?.message ?? err).slice(0, 160) }, "رفضٌ لم يُكتب في السجل"));
}

/**
 * الإذن. لا يرمي: الجواب دائماً allowed وwhy، وكل رفضٍ سطرٌ في org_audit_log. وكل قرارٍ —
 * سُمح أو رُفض — سطرٌ تحت التذكرة الحالية في ticket_action_events (ledger.ts)، إلا الفحص
 * الثاني المسموح قبيل السلك: محاولة الإرسال سطرٌ واحد لا اثنان.
 */
export async function gateSend(i: GateInput): Promise<GateResult> {
  // المحاكاة أولاً، قبل أي قراءة أو قناة: لا يخرج منها شيءٌ أبداً، ولا إشعار صاحب العمل نفسه.
  const sim = currentSimulation();
  if (sim) {
    const why = `محاكاة (${sim.kind}): لا يخرج شيء`;
    recordSandbox({ channel: i.channel, kind: i.kind, recipient: i.recipient ?? null, role: i.role ?? null, why });
    await audit({ userId: i.userId, action: "gate.simulation", channel: i.channel, kind: i.kind, recipient: i.recipient ?? null, role: i.role ?? null, why, meta: { runId: sim.runId } }).catch(() => {});
    const r = refuse("simulation", why);
    // تحت تذكرةٍ معروفة في السياق: الرفض سطرٌ في سجلها. بلا تذكرة: لا يُفتح سجل عمليات يومي
    // (صفٌّ حقيقي) من أجل محاكاة؛ يكفي سجل المحاكاة.
    const tctx = currentTicket();
    if (tctx && tctx.userId === i.userId && tctx.ticketId != null) {
      await recordAction({ userId: i.userId, ticketId: tctx.ticketId, role: i.role ?? tctx.role, actionType: `gate.${i.channel}`.slice(0, 60), status: "refused",
        input: { channel: i.channel, kind: i.kind, recipient: i.recipient ?? null, simulation: true, runId: sim.runId }, output: { code: r.code, why: r.why, scope: r.scope } });
    }
    return r;
  }
  const finish = async (r: GateResult) => {
    if (!r.allowed) await logRefusal(i, r);
    if (!(i.recheck && r.allowed)) await recordGate(i, r);
    return r;
  };

  // ما لا يحتاج مفتاحاً: لينكدإن وإشعار صاحب العمل.
  if (i.channel === "linkedin" || i.kind === "owner_notice") return finish(decideGate({ channel: i.channel, kind: i.kind, selfAddressed: i.selfAddressed, halt: { halted: false, scope: null, reason: null } }));

  const department = [...new Set([i.department ?? departmentOf(i.role), departmentOfChannel(i.channel)].filter((d): d is string => !!d))];
  // تذكرة السياق إن كانت لهذا الحساب: مفتاحها (إيقافٌ مؤقت أو إلغاء) يوقف إرسالها.
  const ctx = currentTicket();
  const taskId = ctx && ctx.userId === i.userId ? ctx.ticketId : null;
  const halt = await isHalted({ userId: i.userId, channel: i.channel, department, role: i.role ?? null, taskId });
  if (i.recheck) return finish(decideGate({ channel: i.channel, kind: i.kind, selfAddressed: i.selfAddressed, halt }));

  let optedOut: boolean | null = false;
  if (!halt.halted && i.recipient && suppressionApplies(i.kind, i.selfAddressed)) {
    try { optedOut = await isOptedOut(i.userId, i.channel, i.recipient); }
    // الشك هنا يُغلق كمفتاح لا كرفض شخص: الرسالة تنتظر ولا تسقط.
    catch { return finish(refuse("halted", "قائمة الإلغاء لا تُقرأ", "controls")); }
  }
  const r = decideGate({ channel: i.channel, kind: i.kind, selfAddressed: i.selfAddressed, halt, optedOut });
  if (!r.allowed) return finish(r);

  if (i.idempotencyKey) {
    const claimed = await db.execute(sql`INSERT INTO org_audit_log (user_id, action, channel, kind, recipient, role, idempotency_key)
      VALUES (${i.userId}, 'gate.claimed', ${i.channel}, ${i.kind.slice(0, 30)}, ${i.recipient?.slice(0, 254) ?? null}, ${i.role?.slice(0, 60) ?? null}, ${i.idempotencyKey.slice(0, 200)})
      ON CONFLICT (COALESCE(user_id, 0), idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`).catch(() => null);
    if (!claimed) return finish(refuse("halted", "مفتاح التكرار لا يُحجز", "controls"));
    if (!claimed.rows.length) return finish(refuse("duplicate", "خرج من قبل بالمفتاح نفسه"));
  }
  countAllowed(i.userId, i.channel);
  return finish(OK);
}

export { isUnavailable };
