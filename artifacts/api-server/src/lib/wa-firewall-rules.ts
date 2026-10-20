// ── قواعد الحاجز التلقائي — نقية، بلا قاعدة بيانات ─────────────────
// صاحب العمل (٢٠ أكتوبر): «أبني جدار لكل حد… هم عملاء سابقين وبرسل لهم
// خيار: من اختار "لا" خلاص ما هرسل له تاني. بس أبنيها عشان يوصل ١٥٠٠ في
// اليوم بالتدريج».
//
// فالميزانية الباردة سلّمٌ يُصعَد بالاستحقاق لا بالتقويم: درجةٌ كل يومين حين
// تكون أرقام الرقم كلها حسنة (تسليم، ردود، لا إيقافات، لا تحذير من واتساب)،
// ونزولٌ فور أن تسوء، ورجوعٌ إلى أول السلّم مع أي تجميد. والإيقاع مشتقٌّ من
// الميزانية: ١٥٠٠ في اليوم تعني رسالةً كل ~٣٠ ثانية، و٢٠ في اليوم رسالةً كل
// أربع دقائق. كلّ ما هنا دوالٌّ نقية لتُختبر.

import { SENDING_HOUR_START, SENDING_HOUR_END } from "./sending-hours";

export type SendKind = "campaign" | "followup" | "reply" | "manual" | "transactional";
export type Mode = "normal" | "convalescent" | "frozen";
export type WaWarning = "NONE" | "FIRST_WARNING" | "SECOND_WARNING" | "CAPPED";

/** Cold messages a day, rung by rung. The owner's ceiling is the last rung. */
export const LADDER = [20, 35, 50, 80, 120, 170, 240, 330, 450, 600, 800, 1000, 1250, 1500] as const;
export const TOP_RUNG = LADDER.length - 1;

const windowHours = () => {
  const h = SENDING_HOUR_END > SENDING_HOUR_START ? SENDING_HOUR_END - SENDING_HOUR_START : 24 - SENDING_HOUR_START + SENDING_HOUR_END;
  return Math.max(1, h);
};

export const RULES = {
  daysPerRung: 2,
  /** What two days at a rung must show before the next one. */
  promote: { usedShare: 0.6, minMature: 20, delivered: 0.9, optOutMax: 0.01, replyMin: 0.015 },
  /** What sends a number down a rung. */
  demote: { minSample: 20, delivered: 0.8, optOutMax: 0.02, silentAfter: 60 },
  /** The pace, derived from the day's budget over the sending window. */
  perHour: { min: 6, max: 160, factor: 1.3 },
  per10Min: { min: 2, max: 30, factor: 1.4 },
  gapMs: { min: 20_000, max: 240_000, jitter: [0.6, 1.1] as [number, number] },
  firstHour: { min: 4, max: 60, share: 0.5 },
  warmGapMs: 6_000, warmPerHour: 60,
  /** Tripwires. */
  burstMin5: 6,
  undelivered: { sample: 10, bad: 4, freezeH: 6, sample2: 20, bad2: 10, freezeH2: 24, matureMin: 15 },
  closes: { n: 4, windowMin: 30, freezeH: 2 },
  rejectionFreezeH: 72,
  optOuts: { n: 3, rate: 0.05, minSample: 20, freezeH: 24 },
  noEngagement: { sample: 60, minAgeH: 48, freezeH: 24 },
  sendErrorFreezeH: 24,
  convalescenceDays: 14,
  /** How far WhatsApp's own warnings push the ladder down. */
  warningDrop: { FIRST_WARNING: 1, SECOND_WARNING: 3 } as Record<string, number>,
};

/** The rung a number of this age starts on, and returns to after a freeze. Pure. */
export function startRung(ageDays: number): number {
  if (ageDays < 7) return 0;
  if (ageDays < 14) return 1;
  if (ageDays < 30) return 2;
  return 3;
}

export const clampRung = (r: number) => Math.max(0, Math.min(TOP_RUNG, Math.floor(r)));

/**
 * Today's cold budget: the rung, lowered by convalescence, by the owner's cap
 * and by what WhatsApp says is left of its new-chat quota. Pure.
 */
export function budgetFor(i: { rung: number; mode: Mode; convalescentDay: number; ownerCap: number | null; waRemaining: number | null }): number {
  if (i.mode === "frozen") return 0;
  let b: number = LADDER[clampRung(i.rung)]!;
  if (i.mode === "convalescent") b = Math.max(3, Math.floor(b * (i.convalescentDay < 7 ? 0.33 : 0.66)));
  if (i.ownerCap && i.ownerCap > 0) b = Math.min(b, Math.floor(i.ownerCap));
  if (i.waRemaining !== null && i.waRemaining >= 0) b = Math.min(b, Math.floor(i.waRemaining));
  return b;
}

export interface Pace { perHour: number; per10Min: number; gapMs: [number, number]; firstHourCap: number }

/** The pace this budget needs to fit the sending window, bounded on both ends. Pure. */
export function paceFor(budget: number): Pace {
  const W = windowHours();
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const perHour = clamp(Math.ceil((budget / W) * RULES.perHour.factor), RULES.perHour.min, RULES.perHour.max);
  const per10Min = clamp(Math.ceil((perHour / 6) * RULES.per10Min.factor), RULES.per10Min.min, RULES.per10Min.max);
  const mean = budget > 0 ? (W * 3_600_000) / budget : RULES.gapMs.max;
  const lo = clamp(mean * RULES.gapMs.jitter[0], RULES.gapMs.min, RULES.gapMs.max);
  const hi = clamp(mean * RULES.gapMs.jitter[1], lo, RULES.gapMs.max);
  const firstHourCap = clamp(Math.round(perHour * RULES.firstHour.share), RULES.firstHour.min, RULES.firstHour.max);
  return { perHour, per10Min, gapMs: [Math.round(lo), Math.round(hi)], firstHourCap };
}

/** How long a cold message must wait given what left before it. Pure. */
export function coldWait(sentAt: number[], now: number, gapMs: number, dayStartedAt: number, pace: Pace): number {
  const last = sentAt.length ? sentAt[sentAt.length - 1]! : 0;
  let wait = Math.max(0, last + gapMs - now);
  const in10 = sentAt.filter((t) => t > now - 600_000);
  if (in10.length >= pace.per10Min) wait = Math.max(wait, in10[0]! + 600_000 - now);
  const inHour = sentAt.filter((t) => t > now - 3_600_000);
  if (inHour.length >= pace.perHour) wait = Math.max(wait, inHour[0]! + 3_600_000 - now);
  // The first hour of the day is the most watched: half the pace.
  if (now - dayStartedAt < 3_600_000) {
    const sinceOpen = sentAt.filter((t) => t >= dayStartedAt);
    if (sinceOpen.length >= pace.firstHourCap) wait = Math.max(wait, dayStartedAt + 3_600_000 - now);
  }
  return wait;
}

export interface RungStats {
  /** Whole days spent at this rung. */
  daysAtRung: number;
  /** Cold messages in the last two days, and distinct people they went to. */
  sent2d: number;
  recipients: number;
  /** Of those old enough for a receipt: how many, and how many arrived. */
  mature: { n: number; delivered: number };
  optOuts: number;
  repliers: number;
  /** Today's budget at this rung. */
  budget: number;
  mode: Mode;
  waWarning: WaWarning | null;
  /** WhatsApp's stated quota for new chats in the cycle, when known. */
  waQuota: number | null;
}

/** The rung for tomorrow from what the last two days did. Pure. */
export function nextRung(rung: number, s: RungStats): { rung: number; why: string } {
  const r = clampRung(rung);
  const d = RULES.demote, p = RULES.promote;
  const delivered = s.mature.n ? s.mature.delivered / s.mature.n : 1;
  const optRate = s.recipients ? s.optOuts / s.recipients : 0;
  const replyRate = s.recipients ? s.repliers / s.recipients : 0;
  const pct = (x: number) => `${Math.round(x * 100)}٪`;
  const down = (n: number, why: string) => ({ rung: clampRung(r - n), why: `نزول ${n > 1 ? `${n} درجات` : "درجة"}: ${why}` });
  if (s.waWarning === "CAPPED") return down(TOP_RUNG, "واتساب أوقف الرسائل الجديدة لهذه الدورة");
  if (s.waWarning === "SECOND_WARNING") return down(RULES.warningDrop.SECOND_WARNING!, "تحذير ثانٍ من واتساب");
  if (s.waWarning === "FIRST_WARNING") return down(RULES.warningDrop.FIRST_WARNING!, "تحذير أول من واتساب");
  if (s.mature.n >= d.minSample && delivered < d.delivered) return down(1, `التسليم ${pct(delivered)}`);
  if (s.recipients >= d.minSample && optRate > d.optOutMax) return down(1, `${s.optOuts} طلبات إيقاف من ${s.recipients}`);
  if (s.recipients >= d.silentAfter && s.repliers === 0) return down(1, `${s.recipients} شخصاً بلا أي رد`);
  const hold = (why: string) => ({ rung: r, why: `ثبات على ${LADDER[r]}: ${why}` });
  if (r >= TOP_RUNG) return hold("أعلى درجة — ١٥٠٠ في اليوم");
  if (s.mode !== "normal") return hold("الرقم في نقاهة");
  if (s.daysAtRung < RULES.daysPerRung) return hold(`يومان على الدرجة قبل الصعود (مضى ${s.daysAtRung})`);
  if (s.waQuota !== null && LADDER[r + 1]! > s.waQuota) return hold(`حصة واتساب للمحادثات الجديدة ${s.waQuota} لا تتسع للدرجة التالية`);
  if (s.sent2d < s.budget * RULES.daysPerRung * p.usedShare) return hold(`لم تُستهلك الدرجة بعد (${s.sent2d} من ${s.budget * RULES.daysPerRung} في يومين)`);
  if (s.mature.n < p.minMature) return hold(`عيّنة تسليم صغيرة (${s.mature.n})`);
  if (delivered < p.delivered) return hold(`التسليم ${pct(delivered)} أقل من ٩٠٪`);
  if (optRate > p.optOutMax) return hold(`الإيقاف ${(optRate * 100).toFixed(1)}٪ فوق ١٪`);
  if (replyRate < p.replyMin) return hold(`الردود ${(replyRate * 100).toFixed(1)}٪ أقل من ١٫٥٪`);
  return { rung: r + 1, why: `صعود إلى ${LADDER[r + 1]} في اليوم: تسليم ${pct(delivered)}، ردود ${pct(replyRate)}، إيقاف ${(optRate * 100).toFixed(1)}٪` };
}

/** The tripwire verdict over the numbers. Pure. */
export function tripwire(s: {
  any5Min: number;
  mature10: { undelivered: number; n: number }; mature20: { undelivered: number; n: number };
  closes30Min: number; coldLast30Min: number;
  optOutsToday: number; coldToday: number;
  cold60: { n: number; oldestAgeH: number; replied: number };
}, pace?: Pace): { freezeH: number; why: string } | null {
  const burst = Math.max(RULES.burstMin5, pace?.per10Min ?? 0);
  if (s.any5Min > burst) return { freezeH: 1, why: `دفقة: ${s.any5Min} رسائل في خمس دقائق` };
  if (s.mature20.n >= RULES.undelivered.sample2 && s.mature20.undelivered >= RULES.undelivered.bad2) return { freezeH: RULES.undelivered.freezeH2, why: `${s.mature20.undelivered} من آخر ${s.mature20.n} رسالة لم تُسلَّم` };
  if (s.mature10.n >= RULES.undelivered.sample && s.mature10.undelivered >= RULES.undelivered.bad) return { freezeH: RULES.undelivered.freezeH, why: `${s.mature10.undelivered} من آخر ${s.mature10.n} رسائل لم تُسلَّم` };
  if (s.closes30Min >= RULES.closes.n && s.coldLast30Min > 0) return { freezeH: RULES.closes.freezeH, why: `${s.closes30Min} انقطاعات في نصف ساعة أثناء الإرسال` };
  if (s.optOutsToday >= RULES.optOuts.n || (s.coldToday >= RULES.optOuts.minSample && s.optOutsToday / s.coldToday >= RULES.optOuts.rate)) return { freezeH: RULES.optOuts.freezeH, why: `${s.optOutsToday} طلبات إيقاف اليوم` };
  if (s.cold60.n >= RULES.noEngagement.sample && s.cold60.oldestAgeH >= RULES.noEngagement.minAgeH && s.cold60.replied === 0) return { freezeH: RULES.noEngagement.freezeH, why: `آخر ${s.cold60.n} رسالة باردة بلا أي رد` };
  return null;
}

/** What WhatsApp's own standing says. Pure. */
export function readStanding(lock: { isActive?: boolean; timeEnforcementEnds?: Date | string | null; enforcementType?: string } | null | undefined,
  cap: { total_quota?: number; used_quota?: number; cycle_end_timestamp?: string; capping_status?: string } | null | undefined,
  now = Date.now()): { lockedUntil: Date | null; lockWhy: string | null; warning: WaWarning | null; quota: number | null; remaining: number | null; cycleEnd: Date | null } {
  let lockedUntil: Date | null = null, lockWhy: string | null = null;
  if (lock?.isActive) {
    const ends = lock.timeEnforcementEnds ? new Date(lock.timeEnforcementEnds) : null;
    lockedUntil = ends && ends.getTime() > now ? ends : new Date(now + 24 * 3_600_000);
    lockWhy = `واتساب قيّد الحساب (${lock.enforcementType ?? "DEFAULT"})`;
  }
  const warning = (cap?.capping_status as WaWarning | undefined) ?? null;
  const quota = typeof cap?.total_quota === "number" && cap.total_quota > 0 ? cap.total_quota : null;
  const used = typeof cap?.used_quota === "number" ? cap.used_quota : 0;
  const cycleEnd = cap?.cycle_end_timestamp ? new Date(Number(cap.cycle_end_timestamp) * (String(cap.cycle_end_timestamp).length > 11 ? 1 : 1000)) : null;
  const remaining = quota !== null ? Math.max(0, quota - used) : null;
  if (warning === "CAPPED") { lockedUntil = cycleEnd && cycleEnd.getTime() > now ? cycleEnd : new Date(now + 24 * 3_600_000); lockWhy = lockWhy ?? "واتساب أوقف الرسائل إلى محادثات جديدة حتى نهاية الدورة"; }
  return { lockedUntil, lockWhy, warning, quota, remaining, cycleEnd };
}

/** Interactive messages downgraded to plain ones (while convalescent). Pure. */
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

/** The person behind a number: its last nine digits. Pure. */
export const key9 = (phone: string) => String(phone ?? "").split(":")[0]!.split("@")[0]!.replace(/\D/g, "").slice(-9);
