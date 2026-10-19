// ── جدار الحماية من الحظر ────────────────────────────────────────
// صاحب العمل (١٩ أكتوبر): «تم تقييد الحساب لأنه أرسل رسائل كثيرة جداً في
// وقت واحد. ابنِ جدار حماية قوياً جداً ضد الحظر — حلاً جذرياً».
//
// ما حدث على الخادم قبل التقييد، بالأرقام:
//   · ٣٢ رسالة باردة في ثلاث دقائق (حلقتان لحملةٍ واحدة)، ثم رسالة كل دقيقة؛
//   · ٥٣ رسالة في ساعة، من رقمٍ متوسطه ٢٣ رسالة في اليوم؛
//   · الحد اليومي المحسوب كان ١٥٠٠ لأن الرقم عمره ٨٢ يوماً؛
//   · ثم ١٥ انقطاعاً في ثلاث ساعات، و١٣٪ من الرسائل لم تُسلَّم.
//
// واتساب لا ينشر حدوده، وكل رقمٍ منشور عند بائعي الأدوات ادّعاء. فالجدار
// لا يثق برقمٍ واحد، بل يجمع ثلاث طبقات، وكلها على **الرسائل الباردة**:
// رسالةٌ لمن لم يكتب لنا خلال ثلاثة أيام. الرد على من كتب لنا ليس خطراً،
// وهو ما يريده واتساب أصلاً.
//
//   ١. ميزانية صارمة     حدٌّ في اليوم بعمر الرقم (١٠ → ٨٠)، وعشرٌ في الساعة،
//                       وثلاثٌ في عشر دقائق، وفاصلٌ عشوائي ٩٠–٢٤٠ ثانية،
//                       وأربعٌ فقط في أول ساعة من يوم الإرسال، وساعات دبي.
//   ٢. أسلاك تعثّر       سبعة إشارات، وأيٌّ منها يجمّد كل إرسالٍ بارد فوراً:
//                       دفقة، رسائل لا تُسلَّم، انقطاعات متكررة، رفض واتساب،
//                       خطأ إرسالٍ يشي بالمنع، إيقافات من المستلمين، صفر ردود.
//   ٣. نقاهة            بعد أي تجميد أسبوعان بثلث الميزانية ثم ثلثيها، وبلا
//                       أزرار ولا كاروسيل (رسائل تفاعلية من حسابٍ عادي إشارةٌ
//                       غير مؤكدة — فتُمنع في النقاهة احتياطاً).
//
// كل رسالة من أي طريق (حملة، متابعة، رد، يدوي) تمرّ من admit() في
// whatsapp.ts قبل أن تلمس الشبكة. لا استثناء ولا طريق جانبي.

import { and, eq, sql } from "drizzle-orm";
import { db, waFirewallTable, waFirewallSendsTable, waFirewallEventsTable, type WaFirewall } from "@workspace/db";
import { isWithinSendingHours, SENDING_HOUR_START, SENDING_TZ } from "./sending-hours";
import { logger } from "./logger";

export type SendKind = "campaign" | "followup" | "reply" | "manual";
export type Mode = "normal" | "convalescent" | "frozen";
export const FIREWALL_PREFIX = "FIREWALL:";

export const RULES = {
  /** Cold messages a day, by the number's age in days — the ladder's ceiling, never raised. */
  coldDayByAge: [[7, 10], [14, 20], [30, 35], [60, 50], [Infinity, 80]] as Array<[number, number]>,
  coldPerHour: 10, coldPer10Min: 3, coldGapMs: [90_000, 240_000] as [number, number],
  /** The first hour of the sending day is the most watched: a trickle only. */
  firstHourCap: 4,
  warmGapMs: 6_000, warmPerHour: 60,
  /** Tripwires. */
  burstAny5Min: 6,
  undelivered: { sample: 10, bad: 4, freezeH: 6, sample2: 20, bad2: 10, freezeH2: 24, matureMin: 15 },
  closes: { n: 4, windowMin: 30, freezeH: 2 },
  rejectionFreezeH: 72,
  optOuts: { n: 3, rate: 0.05, minSample: 20, freezeH: 24 },
  noEngagement: { sample: 60, minAgeH: 48, freezeH: 24 },
  sendErrorFreezeH: 24,
  convalescenceDays: 14,
};
const SEND_ERR = /forbidden|not-authorized|unauthorized|rate-overlimit|\b429\b|\b403\b|spam|blocked|bad-request|not allowed/i;
const REJECTION = new Set([401, 403, 405]);

/** The cold budget for a number of this age, in this mode, on this day of convalescence. Pure. */
export function coldDailyBudget(ageDays: number, mode: Mode, convalescentDayIndex: number, ownerCap: number | null): number {
  const ladder = RULES.coldDayByAge.find(([max]) => ageDays < max)?.[1] ?? 80;
  let b = ladder;
  if (mode === "frozen") return 0;
  if (mode === "convalescent") b = Math.max(3, Math.floor(ladder * (convalescentDayIndex < 7 ? 0.33 : 0.66)));
  if (ownerCap && ownerCap > 0) b = Math.min(b, ownerCap);
  return b;
}

/** How long a cold message must wait given what left before it. Pure. */
export function coldWait(sentAt: number[], now: number, gapMs: number, dayStartedAt: number): number {
  const last = sentAt.length ? sentAt[sentAt.length - 1]! : 0;
  let wait = Math.max(0, last + gapMs - now);
  const in10 = sentAt.filter((t) => t > now - 600_000);
  if (in10.length >= RULES.coldPer10Min) wait = Math.max(wait, in10[0]! + 600_000 - now);
  const inHour = sentAt.filter((t) => t > now - 3_600_000);
  if (inHour.length >= RULES.coldPerHour) wait = Math.max(wait, inHour[0]! + 3_600_000 - now);
  // The first hour of the day: a trickle, then the ordinary pace.
  if (now - dayStartedAt < 3_600_000) {
    const sinceOpen = sentAt.filter((t) => t >= dayStartedAt);
    if (sinceOpen.length >= RULES.firstHourCap) wait = Math.max(wait, dayStartedAt + 3_600_000 - now);
  }
  return wait;
}

/** The tripwire verdict over the numbers. Pure, so it is tested. */
export function tripwire(s: {
  any5Min: number;
  mature10: { undelivered: number; n: number }; mature20: { undelivered: number; n: number };
  closes30Min: number; coldLast30Min: number;
  optOutsToday: number; coldToday: number;
  cold60: { n: number; oldestAgeH: number; replied: number };
}): { freezeH: number; why: string } | null {
  if (s.any5Min > RULES.burstAny5Min) return { freezeH: 1, why: `دفقة: ${s.any5Min} رسائل في خمس دقائق` };
  if (s.mature20.n >= RULES.undelivered.sample2 && s.mature20.undelivered >= RULES.undelivered.bad2) return { freezeH: RULES.undelivered.freezeH2, why: `${s.mature20.undelivered} من آخر ${s.mature20.n} رسالة لم تُسلَّم` };
  if (s.mature10.n >= RULES.undelivered.sample && s.mature10.undelivered >= RULES.undelivered.bad) return { freezeH: RULES.undelivered.freezeH, why: `${s.mature10.undelivered} من آخر ${s.mature10.n} رسائل لم تُسلَّم` };
  if (s.closes30Min >= RULES.closes.n && s.coldLast30Min > 0) return { freezeH: RULES.closes.freezeH, why: `${s.closes30Min} انقطاعات في نصف ساعة أثناء الإرسال` };
  if (s.optOutsToday >= RULES.optOuts.n || (s.coldToday >= RULES.optOuts.minSample && s.optOutsToday / s.coldToday >= RULES.optOuts.rate)) return { freezeH: RULES.optOuts.freezeH, why: `${s.optOutsToday} طلبات إيقاف اليوم` };
  if (s.cold60.n >= RULES.noEngagement.sample && s.cold60.oldestAgeH >= RULES.noEngagement.minAgeH && s.cold60.replied === 0) return { freezeH: RULES.noEngagement.freezeH, why: `آخر ${s.cold60.n} رسالة باردة بلا أي رد` };
  return null;
}

/** Interactive messages downgraded to plain ones. Pure. */
export function downgrade(messageType: string | undefined, message: string, mediaUrl: string | null | undefined, carousel: string | null | undefined): { messageType: string; message: string; mediaUrl: string | null; buttons: null; carousel: null } {
  const type = messageType ?? "text";
  if (type === "carousel" && carousel) {
    try {
      const cards = JSON.parse(carousel) as Array<{ title?: string; description?: string; imageUrl?: string }>;
      const c = cards.find((x) => x?.imageUrl) ?? cards[0];
      const text = [message, c?.title ? `*${c.title}*` : "", c?.description ?? ""].filter((x) => x?.trim()).join("\n");
      return { messageType: c?.imageUrl ? "image" : "text", message: text, mediaUrl: c?.imageUrl ?? null, buttons: null, carousel: null };
    } catch { return { messageType: "text", message, mediaUrl: null, buttons: null, carousel: null }; }
  }
  if (type === "image_button" || type === "image") return { messageType: "image", message, mediaUrl: mediaUrl ?? null, buttons: null, carousel: null };
  if (type === "video_button" || type === "video") return { messageType: "video", message, mediaUrl: mediaUrl ?? null, buttons: null, carousel: null };
  if (type === "button" || type === "text") return { messageType: "text", message, mediaUrl: null, buttons: null, carousel: null };
  return { messageType: type, message, mediaUrl: mediaUrl ?? null, buttons: null, carousel: null };
}

export class FirewallBlocked extends Error {
  constructor(why: string) { super(`${FIREWALL_PREFIX} ${why}`); }
}
export const isFirewallError = (err: unknown) => String((err as any)?.message ?? err).startsWith(FIREWALL_PREFIX);

// ── State ─────────────────────────────────────────────────────────
const cache = new Map<number, { row: WaFirewall; at: number }>();
export async function state(userId: number): Promise<WaFirewall> {
  const c = cache.get(userId);
  if (c && Date.now() - c.at < 20_000) return c.row;
  let [row] = await db.select().from(waFirewallTable).where(eq(waFirewallTable.userId, userId)).limit(1);
  if (!row) [row] = await db.insert(waFirewallTable).values({ userId }).onConflictDoNothing().returning();
  if (!row) [row] = await db.select().from(waFirewallTable).where(eq(waFirewallTable.userId, userId)).limit(1);
  // A freeze that ended becomes convalescence.
  if (row!.mode === "frozen" && row!.frozenUntil && row!.frozenUntil.getTime() <= Date.now()) {
    const until = new Date(Date.now() + RULES.convalescenceDays * 86_400_000);
    [row] = await db.update(waFirewallTable).set({ mode: "convalescent", convalescentUntil: until, frozenUntil: null, updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId)).returning();
    await event(userId, "lift", `انتهى التجميد — نقاهة حتى ${until.toISOString().slice(0, 10)}`);
    void resumePaused(userId, row!);
  }
  if (row!.mode === "convalescent" && row!.convalescentUntil && row!.convalescentUntil.getTime() <= Date.now()) {
    [row] = await db.update(waFirewallTable).set({ mode: "normal", convalescentUntil: null, updatedAt: new Date() }).where(eq(waFirewallTable.userId, userId)).returning();
    await event(userId, "normal", "انتهت النقاهة — الميزانية الكاملة");
  }
  cache.set(userId, { row: row!, at: Date.now() });
  return row!;
}

async function event(userId: number, kind: string, detail: string) {
  await db.insert(waFirewallEventsTable).values({ userId, kind, detail }).catch(() => {});
}

/** Freeze every cold message of this number. Campaigns pause; the owner is told. */
export async function freeze(userId: number, hours: number, why: string, opts: { restricted?: boolean } = {}): Promise<void> {
  const cur = await state(userId);
  const until = new Date(Date.now() + hours * 3_600_000);
  if (cur.mode === "frozen" && cur.frozenUntil && cur.frozenUntil.getTime() >= until.getTime()) return;
  const { stopCampaign, runningCampaignIds } = await import("../routes/campaigns");
  const ids = await runningCampaignIds(userId).catch(() => [] as number[]);
  for (const id of ids) await stopCampaign(userId, id).catch(() => {});
  await db.update(waFirewallTable).set({
    mode: "frozen", frozenUntil: until, reason: why, freezes: sql`${waFirewallTable.freezes} + 1`,
    pausedCampaigns: [...new Set([...(cur.pausedCampaigns ?? []), ...ids])], updatedAt: new Date(),
  }).where(eq(waFirewallTable.userId, userId));
  cache.delete(userId);
  await event(userId, opts.restricted ? "restricted" : "freeze", `${why} — حتى ${until.toISOString()}${ids.length ? ` — أوقف ${ids.length} حملة` : ""}`);
  logger.warn({ userId, hours, why, paused: ids }, "جدار الحماية جمّد الإرسال");
  void import("./telegram").then((t) => t.notify(userId, `🛑 جدار الحماية أوقف إرسال واتساب ${hours} ساعة.\nالسبب: ${why}${ids.length ? `\nأوقف ${ids.length} حملة، وتعود وحدها حين يُرفع التجميد.` : ""}`, "firewall")).catch(() => {});
}

async function resumePaused(userId: number, row: WaFirewall) {
  const ids = row.pausedCampaigns ?? [];
  if (!ids.length) return;
  try {
    const { db: _db } = await import("@workspace/db");
    await _db.execute(sql`UPDATE campaigns SET status = 'running' WHERE user_id = ${userId} AND status = 'paused' AND id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    await db.update(waFirewallTable).set({ pausedCampaigns: [] }).where(eq(waFirewallTable.userId, userId));
    const { resumeRunningCampaigns } = await import("../routes/campaigns");
    await resumeRunningCampaigns(userId);
    await event(userId, "resume", `استؤنفت ${ids.length} حملة بعد رفع التجميد`);
  } catch (err) { logger.warn({ userId, err: String((err as any)?.message ?? err) }, "استئناف حملات ما بعد التجميد تعذّر"); }
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

// ── Who is warm ───────────────────────────────────────────────────
const key9 = (phone: string) => String(phone ?? "").split(":")[0]!.split("@")[0]!.replace(/\D/g, "").slice(-9);

/** Someone who wrote to us within three days is warm; everyone else is cold. */
export async function isWarm(userId: number, phone: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM wa_thread_messages WHERE user_id = ${userId} AND NOT from_me
    AND right(regexp_replace(split_part(phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key9(phone)} AND created_at > now() - interval '72 hours' LIMIT 1`);
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
      (SELECT count(*)::int FROM wa_firewall_sends WHERE user_id = ${userId} AND at > now() - interval '5 minutes') AS any5,
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

// ── Admission ─────────────────────────────────────────────────────
const chains = new Map<number, Promise<unknown>>();
const coldTimes = new Map<number, number[]>();
const warmTimes = new Map<number, number[]>();

function dayStart(now = new Date()): number {
  // When the sending window opened today, in the sending timezone.
  const local = new Date(now.toLocaleString("en-US", { timeZone: SENDING_TZ }));
  const open = new Date(local); open.setHours(SENDING_HOUR_START, 0, 0, 0);
  return now.getTime() - (local.getTime() - open.getTime());
}

export interface Admission { cold: boolean; mode: Mode; interactive: boolean }

/**
 * The gate. Waits for the number's turn (campaign and follow-up), or refuses
 * (manual), and says whether buttons may go. Throws FirewallBlocked.
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
    const cold = kind === "reply" ? false : kind === "campaign" ? true : !(await isWarm(userId, phone));
    const now = Date.now();

    if (!cold) {
      // Replies and warm follow-ups: never frozen, only paced like a person.
      const ts = (warmTimes.get(userId) ?? []).filter((t) => t > now - 3_600_000);
      if (ts.length >= RULES.warmPerHour) throw new FirewallBlocked(`أكثر من ${RULES.warmPerHour} رداً في الساعة`);
      const wait = Math.max(0, (ts[ts.length - 1] ?? 0) + RULES.warmGapMs - now);
      if (wait) await new Promise((r) => setTimeout(r, wait));
      ts.push(Date.now()); warmTimes.set(userId, ts);
      return { cold, mode, interactive };
    }

    if (st.manualFreeze) throw new FirewallBlocked("الإرسال مجمّد يدوياً من صاحب العمل");
    if (mode === "frozen") throw new FirewallBlocked(`مجمّد حتى ${st.frozenUntil?.toISOString().slice(0, 16).replace("T", " ")} — ${st.reason ?? ""}`);
    if (!isWithinSendingHours()) throw new FirewallBlocked("خارج ساعات الإرسال");

    const trip = tripwire(await signals(userId));
    if (trip) { await freeze(userId, trip.freezeH, trip.why); throw new FirewallBlocked(trip.why); }

    const { numberAgeDays } = await import("./daily-limit");
    const age = await numberAgeDays(userId).catch(() => 0);
    const convDay = st.convalescentUntil ? RULES.convalescenceDays - Math.ceil((st.convalescentUntil.getTime() - now) / 86_400_000) : 0;
    const budget = coldDailyBudget(age, mode, convDay, st.coldDailyCap);
    const [{ n: usedToday } = { n: 0 }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND cold
      AND at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ}`)).rows;
    if (Number(usedToday) >= budget) throw new FirewallBlocked(`اكتملت ميزانية اليوم الباردة (${budget})`);

    const ts = (coldTimes.get(userId) ?? []).filter((t) => t > now - 3_600_000);
    const gap = RULES.coldGapMs[0] + Math.random() * (RULES.coldGapMs[1] - RULES.coldGapMs[0]);
    let wait = coldWait(ts, now, gap, dayStart());
    if (kind === "manual" && wait > 0) throw new FirewallBlocked(`دور الرقم بعد ${Math.ceil(wait / 1000)} ثانية — الرسائل الباردة تخرج واحدة بعد واحدة`);
    while (wait > 0 && (info?.running ?? true)) {
      const step = Math.min(wait, 5_000);
      await new Promise((r) => setTimeout(r, step));
      wait -= step;
    }
    if (info && info.running === false) throw new FirewallBlocked("أُوقفت الحملة");
    ts.push(Date.now()); coldTimes.set(userId, ts);
    return { cold, mode, interactive };
  } finally { done(); }
}

export async function recordSent(userId: number, phone: string, kind: SendKind, cold: boolean, messageId: string | null | undefined) {
  await db.insert(waFirewallSendsTable).values({ userId, phone, kind, cold, messageId: messageId ?? null }).catch(() => {});
}

/** A send that WhatsApp refused in a way that smells of a block. */
export async function recordError(userId: number, err: unknown) {
  const m = String((err as any)?.message ?? err);
  if (isFirewallError(err)) return;
  if (SEND_ERR.test(m)) await freeze(userId, RULES.sendErrorFreezeH, `واتساب رفض الإرسال: ${m.slice(0, 100)}`);
}

// ── What the owner sees ───────────────────────────────────────────
export async function status(userId: number) {
  const st = await state(userId);
  const { numberAgeDays } = await import("./daily-limit");
  const age = await numberAgeDays(userId).catch(() => 0);
  const now = Date.now();
  const convDay = st.convalescentUntil ? RULES.convalescenceDays - Math.ceil((st.convalescentUntil.getTime() - now) / 86_400_000) : 0;
  const budget = coldDailyBudget(age, st.mode as Mode, convDay, st.coldDailyCap);
  const [{ n: usedToday } = { n: 0 }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND cold
    AND at > date_trunc('day', now() AT TIME ZONE ${SENDING_TZ}) AT TIME ZONE ${SENDING_TZ}`)).rows;
  const sig = await signals(userId);
  const events = await db.select().from(waFirewallEventsTable).where(eq(waFirewallEventsTable.userId, userId)).orderBy(sql`${waFirewallEventsTable.createdAt} desc`).limit(12);
  const coldHour = (coldTimes.get(userId) ?? []).filter((t) => t > now - 3_600_000).length;
  return {
    mode: st.mode, reason: st.reason, frozenUntil: st.frozenUntil, convalescentUntil: st.convalescentUntil, manualFreeze: st.manualFreeze,
    interactiveAllowed: st.interactiveAllowed, coldDailyCap: st.coldDailyCap, freezes: st.freezes, pausedCampaigns: st.pausedCampaigns,
    numberAgeDays: age, budget, usedToday: Number(usedToday), coldLastHour: coldHour,
    delivery: sig.mature20, optOutsToday: sig.optOutsToday, closes30Min: sig.closes30Min, cold60: sig.cold60,
    rules: RULES, sendingHours: { tz: SENDING_TZ, open: isWithinSendingHours() }, events,
  };
}

/** Every minute: the tripwires are read even when nothing is being sent, so a block shows up as it happens. */
export function startWaFirewall(): void {
  setTimeout(() => {
    const tick = async () => {
      const rows = await db.select({ userId: waFirewallTable.userId, mode: waFirewallTable.mode }).from(waFirewallTable);
      for (const r of rows) {
        try {
          const st = await state(r.userId);
          if (st.mode === "frozen") continue;
          const trip = tripwire(await signals(r.userId));
          if (trip) await freeze(r.userId, trip.freezeH, trip.why);
        } catch (err) { logger.warn({ userId: r.userId, err: String((err as any)?.message ?? err) }, "فحص جدار الحماية تعذّر"); }
      }
    };
    void tick();
    setInterval(() => void tick(), 60_000);
  }, 30_000);
  logger.info("جدار الحماية من الحظر يعمل");
}

void and;
