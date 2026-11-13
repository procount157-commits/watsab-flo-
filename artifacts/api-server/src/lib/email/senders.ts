// ── صناديق إرسالٍ أكثر من واحد ─────────────────────────────────────
// صاحب العمل: «أريد أن أزيد عدد الرسائل بشكلٍ كبير». والزيادة لا تكون
// بإرهاق صندوقٍ واحد — Hostinger يقبل ألفاً في اليوم، والمستلمون يحكمون
// على المُرسِل بأسابيعه الأولى — بل بتوزيع الإرسال على صناديق كثيرة، لكلٍّ
// سقفه وتسخينه وصحّته:
//
//   · الصندوق الأول في email_settings (sender_id فارغ = هو)، والباقي هنا.
//   · كل رسالةٍ تخرج من الصندوق الأقل استهلاكاً لسقفه اليوم، وفي حدود
//     ساعته وفاصله — فتتوزّع الرسائل بالتساوي ولا يُرهَق أحدها.
//   · صندوقٌ يرتدّ بريده فوق الحد يُمهَل وحده يوماً، وصندوقٌ تفشل مصادقته
//     يُعلَّم معطّلاً — والباقون يكملون.
//   · ردود كل صندوقٍ وارتداداته تُقرأ من صندوقه (inbound.ts)، وإلا عمي
//     المحلّل عن نصف ما يحدث.
//
// كلمات المرور يكتبها صاحب العمل في الواجهة، ولا تعود منها أبداً.

import { and, desc, eq, sql } from "drizzle-orm";
import { db, emailSendersTable, type EmailSender, type EmailSettings } from "@workspace/db";
import { warmupCap, sendGapMs } from "./health";

export type Preset = "hostinger" | "google" | "microsoft" | "zoho" | "custom";

/** خوادم كل مزوّد. Hostinger أولاً لأنه ما يملكه صاحب العمل. */
export const PRESETS: Record<Exclude<Preset, "custom">, { label: string; smtpHost: string; smtpPort: number; smtpSecure: boolean; imapHost: string; imapPort: number }> = {
  hostinger: { label: "Hostinger", smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpSecure: true, imapHost: "imap.hostinger.com", imapPort: 993 },
  google:    { label: "Google Workspace / Gmail", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true, imapHost: "imap.gmail.com", imapPort: 993 },
  microsoft: { label: "Microsoft 365 / Outlook", smtpHost: "smtp.office365.com", smtpPort: 587, smtpSecure: false, imapHost: "outlook.office365.com", imapPort: 993 },
  zoho:      { label: "Zoho Mail", smtpHost: "smtp.zoho.com", smtpPort: 465, smtpSecure: true, imapHost: "imap.zoho.com", imapPort: 993 },
};

/**
 * تسخين صندوقٍ جديد للبريد البارد: عشرون في اليوم الأول، و+١٥٪ كل يوم،
 * ولا يتجاوز ما ضبطه صاحب العمل. أبطأ من تسخين الصندوق الأول عمداً:
 * صندوقٌ لم يُرسل قط يُحكم عليه بأول مئة رسالة. Pure.
 */
export function senderWarmupCap(dailyCap: number, ageDays: number, on = true): number {
  if (!on) return dailyCap;
  return Math.min(dailyCap, Math.round(20 * Math.pow(1.15, Math.max(0, ageDays))));
}

/** حدّ الارتداد الذي يُمهَل بعده صندوقٌ وحده، وأقل عيّنةٍ يُحكم عليها. ٤٪ — إرشاد Gmail ٢٪، والصندوق الأول أشدّ منه.
 *  ١١ نوفمبر ٢٠٢٦: عيّنة ٢٠ وارتدادٌ واحد (٥٪) كانت تُمهل صندوقاً جديداً يوماً كاملاً — ضجيجٌ لا سمعة.
 *  فصارت العيّنة ٥٠ ولا يُحكم بأقل من ٣ ارتدادات. */
export const SENDER_BOUNCE_HOLD = { pct: 4, minSent: 50, minBounced: 3, hours: 24 };

export interface Candidate {
  id: number | null;            // null = الصندوق الأول
  email: string;
  sentHour: number; sentDay: number;
  hourlyCap: number; dailyCap: number;
  lastSentAt: number; gapMs: number;
}

/**
 * من يُرسل الرسالة التالية: من لم يبلغ سقف يومه ولا ساعته، ومضى فاصله،
 * وأقلّهم استهلاكاً لسقف اليوم — فيتساوى الحِمل بالنسبة لا بالعدد، ولا
 * يُرهَق صندوقٌ سقفه صغير لأن سقف غيره كبير. Pure.
 */
export function chooseSender(cands: Candidate[], now: number): Candidate | null {
  const open = cands.filter((c) => c.dailyCap > 0 && c.sentDay < c.dailyCap && c.sentHour < c.hourlyCap && now - c.lastSentAt >= c.gapMs);
  if (!open.length) return null;
  return open.sort((a, b) => a.sentDay / a.dailyCap - b.sentDay / b.dailyCap || a.lastSentAt - b.lastSentAt)[0]!;
}

/** إعدادات الإرسال لصندوقٍ إضافي: إعدادات الحساب (التوقيع، التتبع، الهوية) بخادمه وعنوانه هو. Pure. */
export function asSettings(base: EmailSettings, s: EmailSender): EmailSettings {
  return {
    ...base,
    provider: "smtp",
    smtpHost: s.smtpHost, smtpPort: s.smtpPort, smtpSecure: s.smtpSecure, smtpUser: s.smtpUser, smtpPass: s.smtpPass,
    fromEmail: s.fromEmail, fromName: s.fromName || base.fromName,
    // الرد يعود إلى الصندوق الذي أرسل، ويُقرأ منه — لا إلى «رد إلى» الحساب.
    replyTo: null,
    imapHost: s.imapHost, imapPort: s.imapPort, imapUser: s.smtpUser, imapPass: s.smtpPass,
  } as EmailSettings;
}

export const ageDays = (d: Date | string, now = Date.now()) => Math.floor((now - new Date(d).getTime()) / 86_400_000);

const lastSent = new Map<string, number>();
export const markSent = (userId: number, id: number | null, at = Date.now()) => lastSent.set(`${userId}:${id ?? 0}`, at);

/** الصناديق الإضافية القابلة للإرسال الآن: نشطة، وغير مُمهَلة. */
export async function liveSenders(userId: number, now = new Date()): Promise<EmailSender[]> {
  const rows = await db.select().from(emailSendersTable).where(and(eq(emailSendersTable.userId, userId), eq(emailSendersTable.status, "active")));
  return rows.filter((r) => !r.heldUntil || r.heldUntil <= now);
}

/** بداية اليوم التقويمي في دبي، كتعبير SQL. «اليوم» كان ٢٤ ساعةً دوّارة، فحمل صباحُ كل يومٍ عبءَ مساء أمسه ولم يبدأ الصندوق يومه بسقفٍ كامل قط. */
export const DUBAI_DAY_START = sql`(date_trunc('day', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai')`;

/** كم أرسل كل صندوقٍ في الساعة (دوّارة) وفي يوم دبي التقويمي (sender_id فارغ = الأول). */
async function sentBySender(userId: number): Promise<Map<number, { h: number; d: number }>> {
  const r = await db.execute<{ sid: number; h: number; d: number }>(sql`
    SELECT coalesce(sender_id, 0) AS sid,
           count(*) FILTER (WHERE sent_at > now() - interval '1 hour')::int AS h,
           count(*) FILTER (WHERE sent_at >= ${DUBAI_DAY_START})::int AS d
    FROM email_messages WHERE user_id = ${userId} AND status = 'sent' AND (sent_at >= ${DUBAI_DAY_START} OR sent_at > now() - interval '1 hour')
    GROUP BY 1`);
  return new Map(r.rows.map((x) => [Number(x.sid), { h: Number(x.h), d: Number(x.d) }]));
}

/**
 * يختار من يُرسل الآن. `primary` هو الصندوق الأول بسقفه المحسوب (التسخين
 * والحكم على الصحة يجريان عليه في service.ts كما كانا).
 */
export async function pickSender(userId: number, base: EmailSettings, primary: { dailyCap: number; hourlyCap: number; gapMs: number }, throttle = 1, now = Date.now()):
  Promise<{ sender: EmailSender | null; settings: EmailSettings; email: string } | null> {
  const [extra, sent] = await Promise.all([liveSenders(userId, new Date(now)), sentBySender(userId)]);
  const cands: Candidate[] = [
    { id: null, email: base.fromEmail!, sentHour: sent.get(0)?.h ?? 0, sentDay: sent.get(0)?.d ?? 0, hourlyCap: primary.hourlyCap, dailyCap: primary.dailyCap,
      lastSentAt: lastSent.get(`${userId}:0`) ?? 0, gapMs: primary.gapMs },
    ...extra.map((s) => ({
      id: s.id, email: s.fromEmail, sentHour: sent.get(s.id)?.h ?? 0, sentDay: sent.get(s.id)?.d ?? 0,
      hourlyCap: s.hourlyCap, dailyCap: senderWarmupCap(s.dailyCap, ageDays(s.createdAt, now), s.warmup),
      lastSentAt: lastSent.get(`${userId}:${s.id}`) ?? 0, gapMs: sendGapMs(s.hourlyCap, throttle),
    })),
  ];
  const c = chooseSender(cands, now);
  if (!c) return null;
  const sender = c.id == null ? null : extra.find((s) => s.id === c.id)!;
  return { sender, settings: sender ? asSettings(base, sender) : base, email: c.email };
}

/** سعة اليوم كلها: الأول بتسخينه، والإضافيون بتسخينهم. للمدير ولوحة البريد. */
export async function capacityToday(userId: number, primaryCap: number): Promise<{ total: number; senders: number }> {
  const extra = await liveSenders(userId);
  return { total: primaryCap + extra.reduce((a, s) => a + senderWarmupCap(s.dailyCap, ageDays(s.createdAt), s.warmup), 0), senders: 1 + extra.length };
}

/** صندوقٌ يرتدّ بريده فوق الحد يُمهَل وحده. يعيد ما أُمهِل. */
export async function holdBouncingSenders(userId: number): Promise<Array<{ email: string; pct: number }>> {
  const r = await db.execute<{ id: number; email: string; sent: number; bounced: number }>(sql`
    SELECT s.id, s.from_email AS email,
           count(m.id) FILTER (WHERE m.status IN ('sent','bounced'))::int AS sent,
           count(m.id) FILTER (WHERE m.status = 'bounced' OR m.bounced_at IS NOT NULL)::int AS bounced
    FROM email_senders s LEFT JOIN email_messages m ON m.sender_id = s.id AND m.sent_at > now() - interval '48 hours'
    WHERE s.user_id = ${userId} AND s.status = 'active' AND (s.held_until IS NULL OR s.held_until < now())
    GROUP BY s.id, s.from_email`);
  const out: Array<{ email: string; pct: number }> = [];
  for (const x of r.rows) {
    const sent = Number(x.sent), pct = sent ? Math.round((1000 * Number(x.bounced)) / sent) / 10 : 0;
    if (sent >= SENDER_BOUNCE_HOLD.minSent && Number(x.bounced) >= SENDER_BOUNCE_HOLD.minBounced && pct >= SENDER_BOUNCE_HOLD.pct) {
      await db.update(emailSendersTable).set({ heldUntil: new Date(Date.now() + SENDER_BOUNCE_HOLD.hours * 3_600_000), heldReason: `ارتداد ${pct}٪ من ${sent} رسالة في يومين — أُمهِل يوماً وحده، والباقون يكملون` }).where(eq(emailSendersTable.id, Number(x.id)));
      out.push({ email: x.email, pct });
    }
  }
  return out;
}

/**
 * صاحب العمل يفكّ إمهال صندوقه قبل انقضاء يومه. محصورٌ بصناديقه هو:
 * صندوق غيره كأنه غير موجود (null). يعيد العنوان وما كان عليه الإمهال.
 */
export async function releaseSenderHold(userId: number, id: number, now = new Date()): Promise<{ email: string; wasHeldUntil: Date | null; reason: string } | null> {
  const [cur] = await db.select().from(emailSendersTable).where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId))).limit(1);
  if (!cur) return null;
  const day = now.toLocaleString("ar-AE", { timeZone: "Asia/Dubai", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const reason = `أفرج عنه المالك يدوياً ${day}`;
  await db.update(emailSendersTable).set({ heldUntil: null, heldReason: reason })
    .where(and(eq(emailSendersTable.id, id), eq(emailSendersTable.userId, userId)));
  return { email: cur.fromEmail, wasHeldUntil: cur.heldUntil, reason };
}

/** مصادقةٌ رُفضت: الصندوق معطّل حتى يصحّح صاحب العمل كلمة مروره. */
export async function markBroken(id: number, why: string) {
  await db.update(emailSendersTable).set({ status: "broken", heldReason: why.slice(0, 300) }).where(eq(emailSendersTable.id, id));
}

/** الصندوق الذي أرسل آخر رسالةٍ لهذا العنوان — ليخرج الرد منه. */
export async function senderFor(userId: number, toEmail: string): Promise<EmailSender | null> {
  const [m] = (await db.execute<{ sender_id: number | null }>(sql`
    SELECT sender_id FROM email_messages WHERE user_id = ${userId} AND lower(to_email) = lower(${toEmail}) AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`)).rows;
  if (!m?.sender_id) return null;
  const [s] = await db.select().from(emailSendersTable).where(and(eq(emailSendersTable.id, Number(m.sender_id)), eq(emailSendersTable.status, "active"))).limit(1);
  return s ?? null;
}

/** للواجهة: كل صندوقٍ بلا كلمة مروره، وما أرسل اليوم، وسقفه اليوم. */
export async function sendersView(userId: number) {
  const [rows, sent] = await Promise.all([
    db.select().from(emailSendersTable).where(eq(emailSendersTable.userId, userId)).orderBy(desc(emailSendersTable.createdAt)),
    sentBySender(userId),
  ]);
  return rows.map(({ smtpPass: _p, ...s }) => ({
    ...s, hasPassword: !!_p, sentToday: sent.get(s.id)?.d ?? 0,
    capToday: senderWarmupCap(s.dailyCap, ageDays(s.createdAt), s.warmup), ageDays: ageDays(s.createdAt),
    held: !!s.heldUntil && s.heldUntil > new Date(),
  }));
}

/** إدخال صاحب العمل، منظّفاً. يرمي برسالةٍ تُعرض له. Pure. */
export function cleanSenderInput(b: any, existing?: Partial<EmailSender>) {
  const preset: Preset = ["hostinger", "google", "microsoft", "zoho", "custom"].includes(b.preset) ? b.preset : (existing?.preset as Preset) ?? "hostinger";
  const p = preset === "custom" ? null : PRESETS[preset];
  const fromEmail = String(b.fromEmail ?? existing?.fromEmail ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new Error("عنوان الإيميل غير صحيح");
  const smtpHost = String(b.smtpHost ?? p?.smtpHost ?? existing?.smtpHost ?? "").trim();
  if (!smtpHost) throw new Error("خادم SMTP مطلوب");
  const pass = typeof b.smtpPass === "string" && b.smtpPass ? b.smtpPass : existing?.smtpPass;
  if (!pass) throw new Error("كلمة مرور الصندوق مطلوبة");
  const int = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    preset, fromEmail, smtpHost, smtpPass: pass,
    label: b.label != null ? String(b.label).trim().slice(0, 80) || null : existing?.label ?? null,
    fromName: b.fromName != null ? String(b.fromName).trim().slice(0, 120) || null : existing?.fromName ?? null,
    smtpUser: String(b.smtpUser ?? existing?.smtpUser ?? fromEmail).trim() || fromEmail,
    smtpPort: int(b.smtpPort ?? p?.smtpPort ?? existing?.smtpPort, 1, 65535, 587),
    smtpSecure: typeof b.smtpSecure === "boolean" ? b.smtpSecure : p?.smtpSecure ?? existing?.smtpSecure ?? false,
    imapHost: (b.imapHost ?? p?.imapHost ?? existing?.imapHost ?? null) || null,
    imapPort: int(b.imapPort ?? p?.imapPort ?? existing?.imapPort, 1, 65535, 993),
    // للبريد البارد: ٨٠ في اليوم و١٥ في الساعة افتراضاً — وسقف Hostinger ألف.
    dailyCap: int(b.dailyCap ?? existing?.dailyCap, 1, 2000, 80),
    hourlyCap: int(b.hourlyCap ?? existing?.hourlyCap, 1, 200, 15),
    warmup: typeof b.warmup === "boolean" ? b.warmup : existing?.warmup ?? true,
  };
}

export { warmupCap };
