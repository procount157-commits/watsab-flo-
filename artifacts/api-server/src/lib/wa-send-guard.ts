// ── حارس إرسال واتساب ─────────────────────────────────────────────
// صاحب العمل (١٩ أكتوبر): «يرسل أكثر من رسالة لو الرقم مكرر — خطأ كبير
// جداً. ويرسل كمية كبيرة في وقت واحد وأنا أخاف الحظر». وما وُجد على الخادم:
// حملتا الطيار A وB أرسلتا ٣٢ رسالة في عشر دقائق، وستة أشخاص وصلتهم
// الرسالة نفسها مرتين وثلاثاً في الثانية نفسها — لأن الحملة الواحدة كانت
// تعمل بحلقتين أو ثلاث في وقت واحد، وكل حلقة لا تعلم بالأخرى.
//
// فكل رسالة حملة، من أي حملة وأي حلقة، تمرّ من هنا قبل أن تخرج:
//
//   واحدٌ بعد واحد   رسائل الحساب كله في طابورٍ واحد، لا حملةً حملة.
//   فاصلٌ بشري      ٤٠–٧٥ ثانية بين أي رسالتين من الرقم، وثمانٍ على الأكثر
//                   في عشر دقائق، وخمس وأربعون في الساعة — مهما كان عدد
//                   الحملات الجارية.
//   شخصٌ واحد       الرقم يُعرف بآخر تسع خانات (٠٥… و٩٧١٥… و+٩٧١ شخصٌ واحد).
//                   لا تصله رسالة حملة ثانية خلال ٢٤ ساعة، ولا يصله النص نفسه
//                   أبداً — يُحجز قبل الإرسال لا بعده، فحلقتان لا تسبقان الحجز.
//
// فهد (العمليات) هو الموظف المسؤول: ما يمنعه يُسجَّل باسمه ويظهر لصاحب العمل.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger";

export const GUARD_ROLE = "ops";
export const GUARD_RULES = {
  minGapMs: 40_000, maxGapMs: 75_000,
  per10Min: 8, perHour: 45,
  /** No second campaign message to the same person within this window. */
  personQuietMs: 24 * 3_600_000,
};

/** The person behind a number: its last nine digits. Pure. */
export function phoneKey(phone: string): string {
  return String(phone ?? "").split(":")[0]!.split("@")[0]!.replace(/\D/g, "").slice(-9);
}

/** Whether another message may leave now, and if not how long to wait. Pure. */
export function waitFor(sentAt: number[], now: number, gapMs: number, rules = GUARD_RULES): number {
  const last = sentAt.length ? sentAt[sentAt.length - 1]! : 0;
  let wait = Math.max(0, last + gapMs - now);
  const in10 = sentAt.filter((t) => t > now - 600_000);
  if (in10.length >= rules.per10Min) wait = Math.max(wait, in10[0]! + 600_000 - now);
  const inHour = sentAt.filter((t) => t > now - 3_600_000);
  if (inHour.length >= rules.perHour) wait = Math.max(wait, inHour[0]! + 3_600_000 - now);
  return wait;
}

const chains = new Map<number, Promise<unknown>>();
const sent = new Map<number, number[]>();
const reserved = new Map<number, Map<string, number>>();
const stats = new Map<number, { blockedDup: number; blockedSame: number; waitedMs: number; sent: number; since: number }>();
const statOf = (u: number) => { let s = stats.get(u); if (!s) { s = { blockedDup: 0, blockedSame: 0, waitedMs: 0, sent: 0, since: Date.now() }; stats.set(u, s); } return s; };

export function guardStats(userId: number) {
  const now = Date.now(), ts = sent.get(userId) ?? [];
  return { ...statOf(userId), last10Min: ts.filter((t) => t > now - 600_000).length, lastHour: ts.filter((t) => t > now - 3_600_000).length, rules: GUARD_RULES };
}

async function record(userId: number, kind: string, phone: string, campaignId: number, detail: string) {
  await db.execute(sql`INSERT INTO wa_guard_events (user_id, kind, phone, campaign_id, detail) VALUES (${userId}, ${kind}, ${phone}, ${campaignId}, ${detail})`).catch(() => {});
}

export type Slot = { ok: true } | { ok: false; why: string };

/**
 * Wait for this account's turn, then say whether this message may go. Call
 * it immediately before sending; the number is reserved when it says yes.
 */
export async function acquire(userId: number, phone: string, campaignId: number, message: string, info: { running: boolean; lastProgressAt?: number }): Promise<Slot> {
  const prev = chains.get(userId) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => { done = r; });
  chains.set(userId, prev.then(() => mine));
  await prev.catch(() => {});
  try {
    const key = phoneKey(phone), now = Date.now();
    const res = reserved.get(userId) ?? new Map<string, number>();
    reserved.set(userId, res);
    for (const [k, t] of res) if (t < now - GUARD_RULES.personQuietMs) res.delete(k);

    // The person, by any spelling of the number, within 24 hours — in memory first, then the record.
    if (res.has(key)) { statOf(userId).blockedDup++; void record(userId, "dup", phone, campaignId, "رسالة حملة أخرى خلال ٢٤ ساعة (محجوز)"); return { ok: false, why: "dup" }; }
    const r = (await db.execute<{ same: boolean }>(sql`
      SELECT (regexp_replace(trim(c.message), '[[:space:]]+', ' ', 'g') = regexp_replace(trim(${message}), '[[:space:]]+', ' ', 'g')) AS same
      FROM message_logs ml JOIN campaigns c ON c.id = ml.campaign_id
      WHERE c.user_id = ${userId} AND ml.status = 'sent'
        AND right(regexp_replace(split_part(ml.phone, ':', 1), '[^0-9]', '', 'g'), 9) = ${key}
        AND (ml.sent_at > now() - interval '24 hours'
          OR regexp_replace(trim(c.message), '[[:space:]]+', ' ', 'g') = regexp_replace(trim(${message}), '[[:space:]]+', ' ', 'g'))
      LIMIT 1`)).rows[0];
    if (r) {
      const same = !!r.same;
      statOf(userId)[same ? "blockedSame" : "blockedDup"]++;
      void record(userId, same ? "same" : "dup", phone, campaignId, same ? "النص نفسه وصله من قبل" : "رسالة حملة أخرى خلال ٢٤ ساعة");
      return { ok: false, why: same ? "same" : "dup" };
    }
    res.set(key, now);

    // The account's pace, across every campaign at once.
    const ts = sent.get(userId) ?? [];
    const gap = GUARD_RULES.minGapMs + Math.random() * (GUARD_RULES.maxGapMs - GUARD_RULES.minGapMs);
    let wait = waitFor(ts, Date.now(), gap);
    if (wait > 0) statOf(userId).waitedMs += wait;
    while (wait > 0 && info.running) {
      const step = Math.min(wait, 5_000);
      await new Promise((ok) => setTimeout(ok, step));
      wait -= step;
      if (info.lastProgressAt != null) info.lastProgressAt = Date.now();
    }
    if (!info.running) { res.delete(key); return { ok: false, why: "stopped" }; }
    ts.push(Date.now());
    sent.set(userId, ts.filter((t) => t > Date.now() - 3_600_000));
    statOf(userId).sent++;
    return { ok: true };
  } finally { done(); }
}

/** A send that failed does not hold the person's place. */
export function release(userId: number, phone: string) {
  reserved.get(userId)?.delete(phoneKey(phone));
}

/** The campaign's list without a second copy of anyone. Pure. */
export function uniquePeople<T extends { phone: string }>(contacts: T[]): T[] {
  const seen = new Set<string>();
  return contacts.filter((c) => { const k = phoneKey(c.phone); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

void logger;
