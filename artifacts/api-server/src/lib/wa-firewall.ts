// ── الحاجز التلقائي من الحظر ─────────────────────────────────────
// صاحب العمل (٢٠ أكتوبر): «أبني جدار لكل حد… هم عملاء سابقين، وبرسل لهم
// خيار: من اختار "لا" خلاص ما هرسل له تاني. بس أبنيها عشان يوصل ١٥٠٠ في
// اليوم بالتدريج. الدفاعية في الـ firewall — الحاجز التلقائي».
//
// ما حدث قبل التقييد (١٩ أكتوبر): ٣٢ رسالة باردة في ثلاث دقائق، ثم رسالة
// كل دقيقة، وحدٌّ يومي محسوب ١٥٠٠ لرقمٍ عمره ٨٢ يوماً، ثم ١٥ انقطاعاً و١٣٪
// من الرسائل لم تُسلَّم. واتساب لا ينشر حدوده، فالحاجز يجمع أربع طبقات على
// **الرسائل الباردة** (لمن لم يكتب لنا خلال ثلاثة أيام؛ الرد على من كتب لنا
// ليس خطراً):
//
//   ١. سلّم بالاستحقاق   ٢٠ → ١٥٠٠ في اليوم (wa-firewall-rules LADDER)، درجةٌ
//                       كل يومين حين تكون الأرقام حسنة، ونزولٌ حين تسوء،
//                       والإيقاع مشتقٌّ من الدرجة: فاصلٌ وحدٌّ في الساعة وفي
//                       عشر دقائق وفي أول ساعة، وساعات دبي.
//   ٢. كلمة واتساب نفسه  قيد الحساب (reachout time-lock) يجمّد حتى موعده،
//                       وحصة المحادثات الجديدة (new-chat cap) سقفٌ لا يُتجاوز،
//                       وتحذيراته تنزل بالدرجة فوراً.
//   ٣. أسلاك تعثّر       دفقة، رسائل لا تُسلَّم، انقطاعات أثناء الإرسال، رفض
//                       واتساب، خطأ يشي بالمنع، إيقافات، صفر ردود: أيٌّ منها
//                       يجمّد كل إرسالٍ بارد فوراً.
//   ٤. «لا» نهائية        من طلب الإيقاف — بأي صيغة لرقمه — يُرفض هنا مهما كان
//                       الطريق، ولا يُرفع إلا بيد صاحب العمل.
//
// بعد أي تجميد أسبوعان من النقاهة بثلث الدرجة ثم ثلثيها، وبلا أزرار ولا
// كاروسيل، والسلّم يعود إلى أوله. كل رسالة من أي طريق (حملة، متابعة، رد،
// يدوي، إشعار) تمرّ من admit() في whatsapp.ts قبل أن تلمس الشبكة.

import { eq, sql } from "drizzle-orm";
import { db, waFirewallTable, waFirewallSendsTable, waFirewallEventsTable, type WaFirewall } from "@workspace/db";
import { isWithinSendingHours, SENDING_HOUR_START, SENDING_TZ } from "./sending-hours";
import { logger } from "./logger";
import {
  RULES, LADDER, TOP_RUNG, startRung, clampRung, budgetFor, paceFor, coldWait, nextRung, tripwire, readStanding, downgrade, key9,
  type SendKind, type Mode, type WaWarning, type Pace, type RungStats,
} from "./wa-firewall-rules";

export { RULES, LADDER, TOP_RUNG, downgrade };
export type { SendKind, Mode, Pace };

export const FIREWALL_PREFIX = "FIREWALL:";
export const REFUSED_PREFIX = "FIREWALL-REFUSED:";

/** The number's no: frozen, over budget, outside hours. A campaign pauses on it. */
export class FirewallBlocked extends Error {
  constructor(why: string) { super(`${FIREWALL_PREFIX} ${why}`); }
}
/** The person's no: blacklisted. A campaign skips them and goes on. */
export class FirewallRefused extends Error {
  constructor(why: string) { super(`${REFUSED_PREFIX} ${why}`); }
}
const msgOf = (err: unknown) => String((err as any)?.message ?? err);
export const isFirewallError = (err: unknown) => msgOf(err).startsWith(FIREWALL_PREFIX);
export const isFirewallRefusal = (err: unknown) => msgOf(err).startsWith(REFUSED_PREFIX);

const SEND_ERR = /forbidden|not-authorized|unauthorized|rate-overlimit|\b429\b|\b403\b|spam|blocked|bad-request|not allowed/i;
const REJECTION = new Set([401, 403, 405]);

const dubaiDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: SENDING_TZ }).format(d);

// ── State ─────────────────────────────────────────────────────────
const cache = new Map<number, { row: WaFirewall; at: number }>();

async function ageOf(userId: number): Promise<number> {
  const { numberAgeDays } = await import("./daily-limit");
  return numberAgeDays(userId).catch(() => 0);
}

export async function state(userId: number): Promise<WaFirewall> {
  const c = cache.get(userId);
  if (c && Date.now() - c.at < 20_000) return c.row;
  let [row] = await db.select().from(waFirewallTable).where(eq(waFirewallTable.userId, userId)).limit(1);
  if (!row) [row] = await db.insert(waFirewallTable).values({ userId }).onConflictDoNothing().returning();
  if (!row) [row] = await db.select().from(waFirewallTable).where(eq(waFirewallTable.userId, userId)).limit(1);
  // Not yet on the ladder: placed by the number's age.
  if (row!.rung < 0) {
    const r = startRung(await ageOf(userId));
    [row] = await db.update(waFirewallTable).set({ rung: r, rungAt: new Date(), updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId)).returning();
    await event(userId, "rung", `بداية السلّم: ${LADDER[r]} رسالة باردة في اليوم`);
  }
  // A freeze that ended becomes convalescence, and the ladder starts over.
  if (row!.mode === "frozen" && row!.frozenUntil && row!.frozenUntil.getTime() <= Date.now()) {
    const until = new Date(Date.now() + RULES.convalescenceDays * 86_400_000);
    const r = startRung(await ageOf(userId));
    [row] = await db.update(waFirewallTable).set({ mode: "convalescent", convalescentUntil: until, frozenUntil: null, rung: r, rungAt: new Date(), updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId)).returning();
    await event(userId, "lift", `انتهى التجميد — نقاهة حتى ${until.toISOString().slice(0, 10)}، والسلّم من ${LADDER[r]}`);
    void resumePaused(userId, row!);
  }
  if (row!.mode === "convalescent" && row!.convalescentUntil && row!.convalescentUntil.getTime() <= Date.now()) {
    [row] = await db.update(waFirewallTable).set({ mode: "normal", convalescentUntil: null, updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId)).returning();
    await event(userId, "normal", "انتهت النقاهة — الدرجة كاملة");
  }
  cache.set(userId, { row: row!, at: Date.now() });
  return row!;
}

async function event(userId: number, kind: string, detail: string) {
  await db.insert(waFirewallEventsTable).values({ userId, kind, detail }).catch(() => {});
}

function convDayOf(st: WaFirewall, now = Date.now()) {
  return st.convalescentUntil ? RULES.convalescenceDays - Math.ceil((st.convalescentUntil.getTime() - now) / 86_400_000) : 0;
}

/** Today's budget, rung, pace and what WhatsApp allows, for this number. */
export async function budgets(userId: number) {
  const st = await state(userId);
  const ageDays = await ageOf(userId);
  const standing = readStanding(st.waLock as any, st.waCap as any);
  const rung = clampRung(st.rung);
  const budget = st.manualFreeze ? 0 : budgetFor({ rung, mode: st.mode as Mode, convalescentDay: convDayOf(st), ownerCap: st.coldDailyCap, waRemaining: standing.remaining });
  return { budget, rung, rungSize: LADDER[rung]!, ageDays, pace: paceFor(Math.max(budget, LADDER[rung]!)), standing, st };
}

/** Freeze every cold message of this number. Campaigns pause; the ladder starts over; the owner is told. */
export async function freeze(userId: number, hours: number, why: string, opts: { restricted?: boolean } = {}): Promise<void> {
  const cur = await state(userId);
  const until = new Date(Date.now() + hours * 3_600_000);
  if (cur.mode === "frozen" && cur.frozenUntil && cur.frozenUntil.getTime() >= until.getTime()) return;
  const { stopCampaign, runningCampaignIds } = await import("../routes/campaigns");
  const ids = await runningCampaignIds(userId).catch(() => [] as number[]);
  for (const id of ids) await stopCampaign(userId, id).catch(() => {});
  const r = startRung(await ageOf(userId));
  await db.update(waFirewallTable).set({
    mode: "frozen", frozenUntil: until, reason: why, freezes: sql`${waFirewallTable.freezes} + 1`,
    rung: Math.min(r, clampRung(cur.rung)), rungAt: new Date(),
    pausedCampaigns: [...new Set([...(cur.pausedCampaigns ?? []), ...ids])], updatedAt: new Date(),
  }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  await event(userId, opts.restricted ? "restricted" : "freeze", `${why} — حتى ${until.toISOString()}${ids.length ? ` — أوقف ${ids.length} حملة` : ""}`);
  logger.warn({ userId, hours, why, paused: ids }, "الحاجز جمّد الإرسال");
  void import("./telegram").then((t) => t.notify(userId, `🛑 الحاجز التلقائي أوقف إرسال واتساب ${hours} ساعة.\nالسبب: ${why}${ids.length ? `\nأوقف ${ids.length} حملة، وتعود وحدها حين يُرفع التجميد.` : ""}`, "firewall")).catch(() => {});
}

async function resumePaused(userId: number, row: WaFirewall) {
  const ids = row.pausedCampaigns ?? [];
  if (!ids.length) return;
  try {
    await db.execute(sql`UPDATE campaigns SET status = 'running' WHERE user_id = ${userId} AND status = 'paused' AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    await db.update(waFirewallTable).set({ pausedCampaigns: [] }).where(eq(waFirewallTable.userId, userId));
    const { resumeRunningCampaigns } = await import("../routes/campaigns");
    await resumeRunningCampaigns(userId);
    await event(userId, "resume", `استؤنفت ${ids.length} حملة بعد رفع التجميد`);
  } catch (err) { logger.warn({ userId, err: msgOf(err) }, "استئناف حملات ما بعد التجميد تعذّر"); }
}

export async function setManual(userId: number, frozen: boolean) {
  await db.update(waFirewallTable).set({ manualFreeze: frozen, updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  await event(userId, frozen ? "manual_freeze" : "manual_lift", frozen ? "صاحب العمل جمّد الإرسال" : "صاحب العمل رفع التجميد اليدوي");
  if (frozen) {
    const { stopCampaign, runningCampaignIds } = await import("../routes/campaigns");
    for (const id of await runningCampaignIds(userId).catch(() => [] as number[])) await stopCampaign(userId, id).catch(() => {});
  }
}

export async function setSettings(userId: number, s: { coldDailyCap?: number | null; interactiveAllowed?: boolean }) {
  await state(userId);
  await db.update(waFirewallTable).set({
    ...(s.coldDailyCap !== undefined ? { coldDailyCap: s.coldDailyCap && s.coldDailyCap > 0 ? Math.floor(s.coldDailyCap) : null } : {}),
    ...(s.interactiveAllowed !== undefined ? { interactiveAllowed: !!s.interactiveAllowed } : {}),
    updatedAt: new Date(),
  }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
}

async function setRung(userId: number, rung: number, why: string, kind: "ladder_up" | "ladder_down" | "rung") {
  await db.update(waFirewallTable).set({ rung: clampRung(rung), rungAt: new Date(), updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  await event(userId, kind, why);
}

// ── WhatsApp's own word ───────────────────────────────────────────
/**
 * What WhatsApp says about the account — the reachout time-lock and the
 * new-chat message cap — as fetched by whatsapp.ts on connect, on its own
 * events, and every few hours. A lock freezes until it ends; a cap bounds
 * the budget; a warning takes the ladder down at once, once per warning.
 */
export async function noteStanding(userId: number, lock?: Record<string, unknown> | null, cap?: Record<string, unknown> | null) {
  const st = await state(userId);
  const nextLock = lock === undefined ? st.waLock : lock;
  const nextCap = cap === undefined ? st.waCap : cap;
  await db.update(waFirewallTable).set({ waLock: nextLock ?? null, waCap: nextCap ?? null, waCheckedAt: new Date(), updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  const s = readStanding(nextLock as any, nextCap as any);
  if (s.lockedUntil && s.lockWhy && (st.mode !== "frozen" || !st.frozenUntil || st.frozenUntil.getTime() < s.lockedUntil.getTime() - 60_000)) {
    const hours = Math.max(1, Math.ceil((s.lockedUntil.getTime() - Date.now()) / 3_600_000));
    await freeze(userId, hours, s.lockWhy, { restricted: true });
  }
  const warning = s.warning && s.warning !== "NONE" && s.warning !== "CAPPED" ? s.warning : null;
  if (warning && st.waWarnedStatus !== warning) {
    const drop = RULES.warningDrop[warning] ?? 1;
    await setRung(userId, clampRung(st.rung) - drop, `نزول ${drop > 1 ? `${drop} درجات` : "درجة"}: تحذير من واتساب (${warning})`, "ladder_down");
    await db.update(waFirewallTable).set({ waWarnedStatus: warning }).where(eq(waFirewallTable.userId, userId));
    cache.delete(userId);
  } else if (!warning && st.waWarnedStatus) {
    await db.update(waFirewallTable).set({ waWarnedStatus: null }).where(eq(waFirewallTable.userId, userId));
    cache.delete(userId);
  }
}

// ── Who is warm, who said no ──────────────────────────────────────
/** Someone who wrote to us within three days is warm; everyone else is cold. */
export async function isWarm(userId: number, phone: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM wa_thread_messages WHERE user_id = ${userId} AND NOT from_me
    AND right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key9(phone)} AND created_at > now() - interval '72 hours' LIMIT 1`);
  return r.rows.length > 0;
}

/** The person — any spelling of the number — asked us to stop. For good, unless a row from before the rule still carries a future date. */
export async function isBlacklisted(userId: number, phone: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM unsubscribed_phones WHERE user_id = ${userId}
    AND right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key9(phone)}
    AND (expires_at IS NULL OR expires_at > now()) LIMIT 1`);
  return r.rows.length > 0;
}

// ── The numbers the tripwires read ────────────────────────────────
const closes = new Map<number, number[]>();
export function noteClose(userId: number, reason: number | undefined) {
  const ts = (closes.get(userId) ?? []).filter((t) => t > Date.now() - 3_600_000);
  ts.push(Date.now());
  closes.set(userId, ts);
  if (reason != null && REJECTION.has(reason)) {
    void freeze(userId, RULES.rejectionFreezeH, `واتساب رفض الاتصال (${reason}) — الحساب مقيّد على الأرجح`, { restricted: true });
  }
}

export async function signals(userId: number) {
  const m = RULES.undelivered.matureMin;
  const [a] = (await db.execute<any>(sql`
    WITH cold AS (SELECT phone, at FROM wa_firewall_sends WHERE user_id = ${userId} AND cold ORDER BY at DESC LIMIT 60),
    mature AS (
      SELECT ml.delivered_at IS NOT NULL AS delivered, ml.sent_at FROM message_logs ml JOIN campaigns c ON c.id = ml.campaign_id
      WHERE c.user_id = ${userId} AND ml.status = 'sent' AND ml.sent_at < now() - make_interval(mins => ${m}) ORDER BY ml.sent_at DESC LIMIT 20)
    SELECT
      (SELECT count(*)::int FROM wa_firewall_sends WHERE user_id = ${userId} AND cold AND at > now() - interval '5 minutes') AS any5,
      (SELECT count(*)::int FROM (SELECT * FROM mature LIMIT 10) x) AS m10n,
      (SELECT count(*)::int FROM (SELECT * FROM mature LIMIT 10) x WHERE NOT delivered) AS m10u,
      (SELECT count(*)::int FROM mature) AS m20n,
      (SELECT count(*)::int FROM mature WHERE NOT delivered) AS m20u,
      (SELECT count(*)::int FROM wa_firewall_sends WHERE user_id = ${userId} AND cold AND at > now() - interval '30 minutes') AS cold30,
      (SELECT count(*)::int FROM wa_firewall_sends WHERE user_id = ${userId} AND cold AND at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ}) AS cold_today,
      (SELECT count(*)::int FROM unsubscribed_phones WHERE user_id = ${userId} AND created_at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ})
        + (SELECT count(DISTINCT r.phone)::int FROM campaign_button_responses r JOIN campaigns c ON c.id = r.campaign_id WHERE c.user_id = ${userId} AND r.action = 'stop' AND r.created_at > now() - interval '24 hours') AS optouts,
      (SELECT count(*)::int FROM cold) AS c60n,
      coalesce((SELECT extract(epoch FROM now() - min(at)) / 3600 FROM cold), 0)::float AS c60age,
      (SELECT count(DISTINCT right(regexp_replace(split_part(t.phone, ':', 1), '[^0-9]', '', 'g'), 9))::int FROM wa_thread_messages t
        WHERE t.user_id = ${userId} AND NOT t.from_me AND right(regexp_replace(split_part(t.phone, ':', 1), '[^0-9]', '', 'g'), 9)
          IN (SELECT right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) FROM cold) AND t.created_at > (SELECT min(at) FROM cold)) AS c60replied`)).rows;
  return {
    any5Min: Number(a?.any5 ?? 0),
    mature10: { n: Number(a?.m10n ?? 0), undelivered: Number(a?.m10u ?? 0) },
    mature20: { n: Number(a?.m20n ?? 0), undelivered: Number(a?.m20u ?? 0) },
    closes30Min: (closes.get(userId) ?? []).filter((t) => t > Date.now() - RULES.closes.windowMin * 60_000).length,
    coldLast30Min: Number(a?.cold30 ?? 0),
    optOutsToday: Number(a?.optouts ?? 0), coldToday: Number(a?.cold_today ?? 0),
    cold60: { n: Number(a?.c60n ?? 0), oldestAgeH: Number(a?.c60age ?? 0), replied: Number(a?.c60replied ?? 0) },
  };
}

// ── The ladder's daily judgement ──────────────────────────────────
/** What the last two days of cold sending did, for the ladder. */
export async function rungStats(userId: number): Promise<Omit<RungStats, "daysAtRung" | "budget" | "mode" | "waWarning" | "waQuota">> {
  const m = RULES.undelivered.matureMin;
  const [a] = (await db.execute<any>(sql`
    WITH k AS (SELECT phone, message_id, at, right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) AS k9
      FROM wa_firewall_sends WHERE user_id = ${userId} AND cold AND at > now() - interval '48 hours'),
    mature AS (SELECT ml.delivered_at IS NOT NULL AS delivered FROM k JOIN message_logs ml ON ml.message_id = k.message_id
      WHERE k.message_id IS NOT NULL AND k.at < now() - make_interval(mins => ${m}))
    SELECT (SELECT count(*)::int FROM k) AS sent, (SELECT count(DISTINCT k9)::int FROM k) AS recipients,
      (SELECT count(*)::int FROM mature) AS mn, (SELECT count(*)::int FROM mature WHERE delivered) AS md,
      (SELECT count(DISTINCT right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 9))::int FROM unsubscribed_phones u
        WHERE u.user_id = ${userId} AND u.created_at > coalesce((SELECT min(at) FROM k), now()) AND right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 9) IN (SELECT k9 FROM k)) AS opt,
      (SELECT count(DISTINCT right(regexp_replace(split_part(t.phone, ':', 1), '[^0-9]', '', 'g'), 9))::int FROM wa_thread_messages t
        WHERE t.user_id = ${userId} AND NOT t.from_me AND t.created_at > coalesce((SELECT min(at) FROM k), now())
          AND right(regexp_replace(split_part(t.phone, ':', 1), '[^0-9]', '', 'g'), 9) IN (SELECT k9 FROM k)) AS rep`)).rows;
  return { sent2d: Number(a?.sent ?? 0), recipients: Number(a?.recipients ?? 0), mature: { n: Number(a?.mn ?? 0), delivered: Number(a?.md ?? 0) }, optOuts: Number(a?.opt ?? 0), repliers: Number(a?.rep ?? 0) };
}

/** Once a Dubai day: up a rung, down a rung, or hold — and say why. */
export async function judgeLadder(userId: number, force = false): Promise<{ rung: number; why: string } | null> {
  const st = await state(userId);
  const today = dubaiDate();
  if (!force && st.rungCheckedOn === today) return null;
  if (st.mode === "frozen") return null;
  const b = await budgets(userId);
  const s = await rungStats(userId);
  const daysAtRung = Math.floor((Date.now() - st.rungAt.getTime()) / 86_400_000);
  const v = nextRung(st.rung, { ...s, daysAtRung, budget: LADDER[b.rung]!, mode: st.mode as Mode, waWarning: (b.standing.warning as WaWarning | null), waQuota: b.standing.quota });
  await db.update(waFirewallTable).set({ rungCheckedOn: today }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  if (v.rung !== clampRung(st.rung)) await setRung(userId, v.rung, v.why, v.rung > st.rung ? "ladder_up" : "ladder_down");
  else await event(userId, "ladder_hold", v.why);
  return v;
}

// ── Admission ─────────────────────────────────────────────────────
const chains = new Map<number, Promise<unknown>>();
const coldTimes = new Map<number, number[]>();
const warmTimes = new Map<number, number[]>();
const txTimes = new Map<number, number[]>();

function dayStart(now = new Date()): number {
  // When the sending window opened today, in the sending timezone.
  const local = new Date(now.toLocaleString("en-US", { timeZone: SENDING_TZ }));
  const open = new Date(local); open.setHours(SENDING_HOUR_START, 0, 0, 0);
  return now.getTime() - (local.getTime() - open.getTime());
}

export interface Admission { cold: boolean; mode: Mode; interactive: boolean }

/**
 * The gate. Waits for the number's turn (campaign and follow-up), or refuses
 * (manual), and says whether buttons may go. Throws FirewallBlocked for the
 * number's no and FirewallRefused for a person's.
 */
export async function admit(userId: number, phone: string, kind: SendKind, info?: { running?: boolean }): Promise<Admission> {
  const prev = chains.get(userId) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  chains.set(userId, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    const st = await state(userId);
    const mode = st.mode as Mode;
    const interactive = mode === "normal" || st.interactiveAllowed;
    const warm = kind === "reply" || kind === "transactional" || (kind !== "campaign" && await isWarm(userId, phone));
    const now = Date.now();

    if (warm) {
      // Replies, notifications and warm follow-ups: never frozen, only paced like a person.
      // Notifications the customer started keep their own, faster line.
      const tx = kind === "transactional";
      const times = tx ? txTimes : warmTimes;
      const perHour = tx ? RULES.txPerHour : RULES.warmPerHour, gapMs = tx ? RULES.txGapMs : RULES.warmGapMs;
      const ts = (times.get(userId) ?? []).filter((t) => t > now - 3_600_000);
      if (ts.length >= perHour) throw new FirewallBlocked(`أكثر من ${perHour} ${tx ? "إشعاراً" : "رداً"} في الساعة`);
      const wait = Math.max(0, (ts[ts.length - 1] ?? 0) + gapMs - now);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      ts.push(Date.now()); times.set(userId, ts);
      return { cold: false, mode, interactive };
    }

    // «من اختار لا، خلاص»: the person's no comes before anything about the number.
    if (await isBlacklisted(userId, phone)) throw new FirewallRefused("طلب الإيقاف — لا يُراسَل");

    if (st.manualFreeze) throw new FirewallBlocked("الإرسال مجمّد يدوياً من صاحب العمل");
    if (mode === "frozen") throw new FirewallBlocked(`مجمّد حتى ${st.frozenUntil?.toISOString().slice(0, 16).replace("T", " ")} — ${st.reason ?? ""}`);
    if (!isWithinSendingHours()) throw new FirewallBlocked("خارج ساعات الإرسال");

    const b = await budgets(userId);
    const trip = tripwire(await signals(userId), b.pace);
    if (trip) { await freeze(userId, trip.freezeH, trip.why); throw new FirewallBlocked(trip.why); }

    const [{ n: usedToday } = { n: 0 }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND cold
      AND at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ}`)).rows;
    if (Number(usedToday) >= b.budget) throw new FirewallBlocked(`اكتملت ميزانية اليوم الباردة (${b.budget} — الدرجة ${b.rungSize})`);

    const ts = (coldTimes.get(userId) ?? []).filter((t) => t > now - 3_600_000);
    const [g0, g1] = b.pace.gapMs;
    const gap = g0 + Math.random() * (g1 - g0);
    let wait = coldWait(ts, now, gap, dayStart(), b.pace);
    if (kind === "manual" && wait > 0) throw new FirewallBlocked(`دور الرقم بعد ${Math.ceil(wait / 1000)} ثانية — الرسائل الباردة تخرج واحدة بعد واحدة`);
    while (wait > 0 && (info?.running ?? true)) {
      const step = Math.min(wait, 5_000);
      await new Promise((r) => setTimeout(r, step));
      wait -= step;
    }
    if (info && info.running === false) throw new FirewallBlocked("أُوقفت الحملة");
    ts.push(Date.now()); coldTimes.set(userId, ts);
    return { cold: true, mode, interactive };
  } finally { done(); }
}

export async function recordSent(userId: number, phone: string, kind: SendKind, cold: boolean, messageId: string | null | undefined) {
  await db.insert(waFirewallSendsTable).values({ userId, phone, kind, cold, messageId: messageId ?? null }).catch(() => {});
}

/** A send that WhatsApp refused in a way that smells of a block. */
export async function recordError(userId: number, err: unknown) {
  const m = msgOf(err);
  if (isFirewallError(err) || isFirewallRefusal(err)) return;
  if (SEND_ERR.test(m)) await freeze(userId, RULES.sendErrorFreezeH, `واتساب رفض الإرسال: ${m.slice(0, 100)}`);
}

// ── What the owner sees ───────────────────────────────────────────
export async function status(userId: number) {
  const b = await budgets(userId);
  const st = b.st;
  const now = Date.now();
  const [{ n: usedToday } = { n: 0 }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND cold
    AND at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ}`)).rows;
  const [{ n: black } = { n: 0 }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM unsubscribed_phones WHERE user_id = ${userId} AND (expires_at IS NULL OR expires_at > now())`)).rows;
  const sig = await signals(userId);
  const rs = await rungStats(userId);
  const events = await db.select().from(waFirewallEventsTable).where(eq(waFirewallEventsTable.userId, userId)).orderBy(sql`${waFirewallEventsTable.createdAt} desc`).limit(14);
  const coldHour = (coldTimes.get(userId) ?? []).filter((t) => t > now - 3_600_000).length;
  return {
    mode: st.mode, reason: st.reason, frozenUntil: st.frozenUntil, convalescentUntil: st.convalescentUntil, manualFreeze: st.manualFreeze,
    interactiveAllowed: st.interactiveAllowed, coldDailyCap: st.coldDailyCap, freezes: st.freezes, pausedCampaigns: st.pausedCampaigns,
    numberAgeDays: b.ageDays, budget: b.budget, usedToday: Number(usedToday), coldLastHour: coldHour, blacklist: Number(black),
    ladder: { rung: b.rung, size: b.rungSize, top: LADDER[TOP_RUNG], steps: LADDER, since: st.rungAt, daysAtRung: Math.floor((now - st.rungAt.getTime()) / 86_400_000), checkedOn: st.rungCheckedOn, last2d: rs },
    pace: b.pace,
    whatsapp: { lock: st.waLock, cap: st.waCap, checkedAt: st.waCheckedAt, warning: b.standing.warning, quota: b.standing.quota, remaining: b.standing.remaining, lockedUntil: b.standing.lockedUntil, cycleEnd: b.standing.cycleEnd },
    delivery: sig.mature20, optOutsToday: sig.optOutsToday, closes30Min: sig.closes30Min, cold60: sig.cold60,
    rules: RULES, sendingHours: { tz: SENDING_TZ, open: isWithinSendingHours() }, events,
  };
}

/**
 * Every minute: the tripwires are read even when nothing is being sent, so a
 * block shows up as it happens; the ladder is judged once a day; and every
 * few hours WhatsApp is asked for the account's own standing.
 */
export function startWaFirewall(): void {
  setTimeout(() => {
    let ticks = 0;
    const tick = async () => {
      ticks++;
      const rows = await db.select({ userId: waFirewallTable.userId, mode: waFirewallTable.mode }).from(waFirewallTable);
      for (const r of rows) {
        try {
          const st = await state(r.userId);
          if (st.mode === "frozen") continue;
          await judgeLadder(r.userId).catch((err) => logger.warn({ userId: r.userId, err: msgOf(err) }, "حكم السلّم تعذّر"));
          const b = await budgets(r.userId);
          const trip = tripwire(await signals(r.userId), b.pace);
          if (trip) await freeze(r.userId, trip.freezeH, trip.why);
          if (ticks % 240 === 1) {
            const wa = await import("./whatsapp");
            if (wa.getStatus(r.userId)?.connected) await wa.fetchStanding(r.userId).catch(() => {});
          }
        } catch (err) { logger.warn({ userId: r.userId, err: msgOf(err) }, "فحص الحاجز تعذّر"); }
      }
    };
    void tick();
    setInterval(() => void tick(), 60_000);
  }, 30_000);
  logger.info("الحاجز التلقائي من الحظر يعمل");
}
