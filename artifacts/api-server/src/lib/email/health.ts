// ── Deliverability, read as signals ───────────────────────────────
// Email has the same failure the WhatsApp side has: sends keep succeeding
// while a mailbox provider quietly stops delivering. What can be read back
// is bounces, complaints, opens and replies, and the rules here turn them
// into "slow down" or "stop". Pure, like the ban-risk score.

export interface EmailSignals {
  sent24h: number;
  bounced24h: number;
  complaints24h: number;
  unsubscribed24h: number;
  opened24h: number;
  replied24h: number;
  /** Days since the sending address first sent through this system. */
  senderAgeDays: number;
}

export interface EmailVerdict {
  level: "ok" | "warning" | "critical";
  /** 0 keeps sending; >0 pauses for this many minutes. */
  holdMinutes: number;
  /** Multiplier on the gap between sends. */
  throttle: number;
  reasons: string[];
}

// Mailbox providers publish their expectations plainly: keep complaints
// under 0.1%, bounces under 2%, and warm a new address up. These lines are
// set at half of where trouble starts.
export const BOUNCE_WARN = 0.03, BOUNCE_STOP = 0.06;
export const COMPLAINT_WARN = 0.001, COMPLAINT_STOP = 0.003;
export const MIN_SAMPLE = 30;
/** A full stop needs this many sent, and this many bounces, before a rate means anything. */
export const STOP_SAMPLE = 50, STOP_BOUNCES = 5;

/**
 * The verdict on a sender's last day.
 *
 * What it used to do: five bounces out of thirty — one bad hour — read as
 * 17%, held everything for four hours, and then held again, because the same
 * five bounces were still inside the day. The account's two new campaigns sat
 * paused on the strength of an older one's list. Now a stop needs a real
 * sample (50 sent, 5 bounces); a bad rate on a small sample slows the sender
 * to a third instead; and the caller counts only what happened after the
 * last hold, so a hold is lifted by time, not re-armed by the past.
 */
export function assessEmail(s: EmailSignals): EmailVerdict {
  const reasons: string[] = [];
  let level: EmailVerdict["level"] = "ok";
  let hold = 0, throttle = 1;
  const worse = (l: EmailVerdict["level"]) => { const r = { ok: 0, warning: 1, critical: 2 }; if (r[l] > r[level]) level = l; };

  if (s.sent24h >= MIN_SAMPLE) {
    const b = s.bounced24h / s.sent24h;
    if (b >= BOUNCE_STOP && s.sent24h >= STOP_SAMPLE && s.bounced24h >= STOP_BOUNCES) {
      worse("critical"); hold = Math.max(hold, 60);
      reasons.push(`${Math.round(b * 100)}% من رسائل اليوم ارتدّت (${s.bounced24h} من ${s.sent24h}) — حُجزت العناوين عالية الخطر وأُوقف الإرسال ساعة.`);
    } else if (b >= BOUNCE_STOP) {
      worse("warning"); throttle = Math.max(throttle, 3);
      reasons.push(`${s.bounced24h} ارتدادات من ${s.sent24h} رسالة — العيّنة صغيرة، فأبطأنا الإرسال إلى الثلث وحجزنا العناوين عالية الخطر.`);
    } else if (b >= BOUNCE_WARN) { worse("warning"); throttle = Math.max(throttle, 2); reasons.push(`${Math.round(b * 100)}% ارتداد — أبطأنا الإرسال.`); }

    const c = s.complaints24h / s.sent24h;
    if (c >= COMPLAINT_STOP) { worse("critical"); hold = Math.max(hold, 720); reasons.push(`بلاغات إزعاج ${(c * 100).toFixed(2)}% — أوقفنا الإرسال ١٢ ساعة.`); }
    else if (c >= COMPLAINT_WARN) { worse("warning"); throttle = Math.max(throttle, 2); reasons.push(`بلاغات إزعاج ${(c * 100).toFixed(2)}%.`); }

    const u = s.unsubscribed24h / s.sent24h;
    if (u >= 0.02) { worse("warning"); throttle = Math.max(throttle, 1.5); reasons.push(`${Math.round(u * 100)}% ألغوا الاشتراك خلال يوم — راجع المحتوى والقائمة.`); }
  }

  if (s.senderAgeDays < 7) { throttle = Math.max(throttle, 1.5); reasons.push(`عنوان الإرسال جديد (${s.senderAgeDays} أيام) — إحماء.`); }

  if (s.sent24h >= 100 && s.opened24h / s.sent24h < 0.05 && s.replied24h === 0) {
    worse("warning");
    reasons.push(`أقل من ٥٪ فتحوا وصفر ردود على ${s.sent24h} رسالة — إما تصل إلى الرسائل غير المرغوبة أو القائمة لا تريدك.`);
  }

  return { level, holdMinutes: hold, throttle, reasons };
}

/** The gap between two sends for one account, from the hourly cap, jittered. */
export function sendGapMs(hourlyCap: number, throttle = 1, rand = Math.random): number {
  const base = Math.max(20_000, Math.round(3_600_000 / Math.max(1, hourlyCap)));
  const jitter = 0.7 + rand() * 0.6;
  return Math.round(base * jitter * throttle);
}

/**
 * A new sending address's allowance for today. Mailbox providers judge a
 * sender by its first weeks, and an address that sends 300 on day one to
 * people who never asked looks exactly like what it is. 50 on day zero,
 * +30% a day, never above what the owner set.
 */
export function warmupCap(dailyCap: number, senderAgeDays: number, on = true): number {
  if (!on) return dailyCap;
  return Math.min(dailyCap, Math.round(50 * Math.pow(1.3, Math.max(0, senderAgeDays))));
}

/**
 * How many of a list go to the subject test, and how they split. Below 40
 * recipients a test measures noise, so there is none; the slice is at least
 * 20 so each variant has ten opens' worth of chance.
 */
export function splitAb(n: number, pct: number): { a: number; b: number; held: number } {
  if (pct <= 0 || n < 40) return { a: n, b: 0, held: 0 };
  const test = Math.min(n, Math.max(20, Math.ceil(n * Math.min(50, pct) / 100)));
  const a = Math.ceil(test / 2), b = test - a;
  return { a, b, held: n - test };
}

/** The winning letter: opens first, then replies, then A. */
export function pickWinner(a: { sent: number; opened: number; replied: number }, b: { sent: number; opened: number; replied: number }): "A" | "B" {
  const r = (x: typeof a, k: "opened" | "replied") => (x.sent > 0 ? x[k] / x.sent : 0);
  if (r(b, "opened") > r(a, "opened")) return "B";
  if (r(b, "opened") < r(a, "opened")) return "A";
  return r(b, "replied") > r(a, "replied") ? "B" : "A";
}
