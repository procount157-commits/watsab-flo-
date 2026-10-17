// ── العنوان العام: الشرط الذي بدونه لا تتبُّع فتحٍ أبداً ───────────
// قياسٌ على القاعدة: ١٠٧٠٧ رسالة، ٥٦٠ خرجت فعلاً، و**صفر** فتحة وصفر
// نقرة منذ أول يوم. وليس لأن أحداً لم يفتح — بل لأن جدول الأحداث لا
// يحتوي نوع «open» ولا «click» ولا مرةً واحدة. السبب سطرٌ واحد:
//
//     export function pixelTag(o) { if (!o.pixel || !o.base) return ""; }
//
// و`base` تأتي من `process.env.SITE_URL` وهي غير مضبوطة. فكل رسالة خرجت
// بلا بكسل وبروابط غير ملفوفة — بصمت، ودون أن يُقال لصاحب العمل إن
// الرقم الذي يراه صفراً ليس نتيجةً بل غياب قياس.
//
// وهنا علّتان لا واحدة: أن المتغيّر فارغ، وأن لا سبيل لصاحب العمل
// لضبطه — فهو في ملفٍ على القرص لا تصله الواجهة. فصار يُضبط من
// الإعدادات، ويُفحص فحصاً حقيقياً: نطلب البكسل من العنوان نفسه كما
// يطلبه بريد المستلم، فإن لم يرجع صورةً فالعنوان لا يصلح.

import { eq } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";
import { logger } from "../logger";

const clean = (u: string | null | undefined): string => (u ?? "").trim().replace(/\/+$/, "");

// ── حين يموت العنوان العام ────────────────────────────────────────
// النفق المؤقّت (trycloudflare) بلا ضمان بقاء: يتوقّف فيتغيّر العنوان.
// وغياب القياس حينها أهون المشكلتين — الأسوأ أن الروابط تُلفّ عبر عنوانٍ
// ميت، فيضغط عميلك الرابط فلا يصل إلى شيء. رسالةٌ بلا قياس تعمل؛
// رسالةٌ بروابط مكسورة تُخسر العميل.
//
// فتُحفظ نتيجة آخر فحصٍ هنا، و`publicBase` تُرجع نصاً فارغاً لعنوانٍ
// ثبت موته: فلا بكسل، ولا لفّ روابط، ورابط إلغاء الاشتراك يعود بريداً —
// وكلها مسالك مُعدَّة أصلاً لغياب العنوان.
type Health = { ok: boolean; at: number; why: string | null; failures: number };
const health = new Map<number, Health>();

/** يُعدّ ميتاً بعد فشلين متتابعين: فشلةٌ واحدة قد تكون الشبكة. */
const DEAD_AFTER = 2;
const isDead = (userId: number): boolean => (health.get(userId)?.failures ?? 0) >= DEAD_AFTER;

/** An address that exists only while one machine keeps a tunnel open. Pure. */
export const isQuickTunnel = (u: string): boolean => {
  try { return /\.trycloudflare\.com$/i.test(new URL(u.startsWith("http") ? u : `https://${u}`).hostname); } catch { return false; }
};

export function trackingHealth(userId: number): Health | null { return health.get(userId) ?? null; }

/**
 * يُعلَّم العنوان ميتاً أو حياً مباشرةً. للاختبار وللفحص اليدوي من
 * الواجهة: السلوك عند الموت — ترك الروابط بلا لفّ — أهم من أن يُترك
 * بلا اختبار حتى يموت نفقٌ حقيقي.
 */
export function setTrackingHealth(userId: number, ok: boolean, why: string | null = null): void {
  health.set(userId, { ok, at: Date.now(), why, failures: ok ? 0 : DEAD_AFTER });
}

/** الإعداد أولاً، ثم متغيّر البيئة — فمن ضبطه من الواجهة قصد ذلك. */
export async function publicBase(userId: number): Promise<string> {
  const [s] = await db.select({ publicUrl: emailSettingsTable.publicUrl })
    .from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  // A quick tunnel (trycloudflare) lives as long as the machine that opened
  // it. The settings kept one from the Mac after the move to the server, and
  // every email from 5 October carried a pixel pointing at a dead address:
  // 1,300 sends, zero opens, no retargeting, no subject test with a winner.
  // Where the server has a real domain, the domain wins over any tunnel.
  const saved = clean(s?.publicUrl), site = clean(process.env["SITE_URL"]);
  const base = site && (!saved || isQuickTunnel(saved)) ? site : saved || site;
  // عنوانٌ ثبت موته لا يُستعمل: أن تخرج الرسالة بلا قياس أهون من أن
  // تخرج بروابط لا تفتح.
  return base && isDead(userId) ? "" : base;
}

// ── عنوانٌ مؤقّت يصلح للبكسل وحده ──────────────────────────────────
// النفق السريع (trycloudflare) يتغيّر عنوانه مع كل تشغيل. بكسلٌ عبره
// إن مات يخسر فتحةً واحدة لا أكثر. أما رابطٌ ملفوفٌ عبره أو رابط إلغاء
// اشتراك فيبقى في بريد العميل شهوراً بعد موت النفق — فيضغطه فلا يصل.
// فالعنوان المؤقّت يحمل البكسل، والروابط تخرج كما هي، والإلغاء بريداً.
const EPHEMERAL = /\.(trycloudflare\.com|ngrok-free\.app|ngrok\.io|ngrok\.app|loca\.lt)$/i;
export function isEphemeral(base: string): boolean {
  try { return EPHEMERAL.test(new URL(base).hostname); } catch { return false; }
}
/** العنوان الذي يجوز أن يُكتب في رابطٍ يبقى: فارغٌ إن كان مؤقّتاً. */
export function durable(base: string): string { return base && !isEphemeral(base) ? base : ""; }

/** العنوان المضبوط كما هو، حياً كان أو ميتاً — للعرض والفحص. */
export async function configuredBase(userId: number): Promise<string> {
  const [s] = await db.select({ publicUrl: emailSettingsTable.publicUrl })
    .from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  return clean(s?.publicUrl) || clean(process.env["SITE_URL"]);
}

export function envBase(): string { return clean(process.env["SITE_URL"]); }

/** عناوين لا يصلها بريد المستلم أبداً، وقبولها يُعيد الصفر نفسه. */
const UNREACHABLE = /^(localhost|127\.|0\.0\.0\.0|\[?::1\]?|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|\.local$|\.localhost$/i;

export function validatePublicUrl(raw: string): { ok: boolean; url?: string; why?: string; warn?: string } {
  const v = clean(raw);
  if (!v) return { ok: false, why: "العنوان فارغ." };
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); }
  catch { return { ok: false, why: "ليس عنواناً صالحاً. مثال: https://app.pro-count.ae" }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, why: "العنوان يجب أن يبدأ بـ http أو https." };
  if (UNREACHABLE.test(u.hostname)) {
    return { ok: false, why: `«${u.hostname}» عنوانٌ داخلي لا يصله بريد المستلم. التتبّع يتطلّب عنواناً يفتحه أي جهاز في العالم — نطاقاً عاماً أو نفقاً (Cloudflare Tunnel، ngrok).` };
  }
  if (u.pathname !== "/" && u.pathname !== "") return { ok: false, why: "اكتب أصل العنوان فقط، بلا مسار: https://app.pro-count.ae" };
  const url = `${u.protocol}//${u.host}`;
  return { ok: true, url, warn: u.protocol === "http:" ? "عنوانٌ بلا تشفير (http): بعض برامج البريد تحجب صوره وتُحذّر من روابطه. https أفضل." : undefined };
}

/**
 * فحصٌ حقيقي: نطلب بكسل التتبّع من الخارج كما يطلبه بريد المستلم.
 * الرمز المستعمل لا يطابق أي رسالة، والمسار يرجع صورةً لأي رمز — فنجاح
 * الطلب يعني أن الطريق مفتوح، ولا يُسجَّل حدثٌ لأحد.
 */
export async function probePublicUrl(base: string, timeoutMs = 6_000): Promise<{ ok: boolean; status?: number; ms: number; why?: string }> {
  const b = clean(base);
  if (!b) return { ok: false, ms: 0, why: "لا عنوان لفحصه." };
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${b}/t/e/__probe_not_a_real_token__.gif`, { signal: ctl.signal, redirect: "follow" });
    const ms = Date.now() - t0;
    const type = r.headers.get("content-type") ?? "";
    if (!r.ok) return { ok: false, status: r.status, ms, why: `العنوان ردّ بالرمز ${r.status} — الخادم غير مُعرَّض على هذا العنوان.` };
    if (!/image\/gif/i.test(type)) return { ok: false, status: r.status, ms, why: `العنوان ردّ بـ «${type || "بلا نوع"}» لا بصورة — يشير إلى خادمٍ آخر، لا إلى هذا التطبيق.` };
    return { ok: true, status: r.status, ms };
  } catch (err: any) {
    const ms = Date.now() - t0;
    return { ok: false, ms, why: err?.name === "AbortError" ? `لم يردّ العنوان خلال ${timeoutMs / 1000} ثانية.` : `تعذّر الوصول: ${String(err?.message ?? err).slice(0, 120)}` };
  }
}

export interface TrackingState {
  /** هل يمكن تتبّع الفتح الآن — لا هل أُعِدّ، بل هل يعمل. */
  can: boolean;
  base: string | null;
  source: "settings" | "env" | null;
  trackingOn: boolean;
  /** سبب العجز بالعربية، وخطواتُ إصلاحه. */
  why: string | null;
  howTo: string[];
}

/**
 * الحارس: يطلب البكسل من الخارج كل ربع ساعة.
 *
 * ولماذا حارسٌ لهذا بالذات: الفشل هنا صامتٌ تماماً. خمس مئة وستون
 * رسالة خرجت بلا قياس ولم يُقَل لأحد، وقُرئ «٠ فتحات» نتيجةً لسنة.
 * ونفقٌ مؤقّت يجعل هذا الصمت احتمالاً يوميّاً لا حادثةً واحدة.
 *
 * ويُنبّه مرةً عند الموت ومرةً عند العودة — لا كل ربع ساعة: ذاك درسُ
 * حارس الجودة الذي قال «١٧٪ ارتداد» اثنتين وعشرين مرة ولم يُصلح شيئاً.
 */
export function startTrackingWatch(): void {
  const EVERY = 15 * 60_000;
  const round = async () => {
    const rows = await db.select({ userId: emailSettingsTable.userId, publicUrl: emailSettingsTable.publicUrl, tracking: emailSettingsTable.tracking })
      .from(emailSettingsTable);
    for (const s of rows) {
      const base = clean(s.publicUrl) || clean(process.env["SITE_URL"]);
      if (!base || !s.tracking) { health.delete(s.userId); continue; }
      const probe = await probePublicUrl(base, 8_000);
      const prev = health.get(s.userId);
      const failures = probe.ok ? 0 : (prev?.failures ?? 0) + 1;
      health.set(s.userId, { ok: probe.ok, at: Date.now(), why: probe.why ?? null, failures });

      const wasDead = (prev?.failures ?? 0) >= DEAD_AFTER;
      const nowDead = failures >= DEAD_AFTER;
      if (nowDead && !wasDead) {
        const { notify, esc } = await import("../telegram");
        await notify(s.userId, [
          "<b>⚠️ العنوان العام توقّف — قياس الفتح معطَّل</b>",
          esc(`${base} لم يستجب: ${probe.why ?? "تعذّر الوصول"}`),
          "",
          "الرسائل تُرسل وتصل كما هي، لكن:",
          "• لا بكسل فتحٍ فيها — الفتحات ستبقى صفراً.",
          "• الروابط لم تُلفّ، فلن تُكسر في بريد العميل.",
          "",
          "إن كان نفقاً مؤقّتاً فقد تغيّر عنوانه: شغّله وضع العنوان الجديد في البريد → الإعدادات.",
        ].join("\n")).catch(() => {});
        logger.warn({ userId: s.userId, base, why: probe.why }, "العنوان العام مات — تُركت الروابط بلا لفّ");
      }
      if (probe.ok && wasDead) {
        const { notify, esc } = await import("../telegram");
        await notify(s.userId, `<b>✅ العنوان العام عاد</b>\n${esc(base)} يستجيب في ${probe.ms}ms — قياس الفتح يعمل من الآن.`).catch(() => {});
        logger.info({ userId: s.userId, base, ms: probe.ms }, "العنوان العام عاد");
      }
    }
  };
  // أول فحصٍ بعد دقيقة من الإقلاع، ثم كل ربع ساعة.
  setTimeout(() => { void round(); setInterval(() => void round(), EVERY); }, 60_000);
  logger.info("حارس العنوان العام بدأ");
}

export async function trackingState(userId: number): Promise<TrackingState> {
  const [s] = await db.select({ publicUrl: emailSettingsTable.publicUrl, tracking: emailSettingsTable.tracking })
    .from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  const fromSettings = clean(s?.publicUrl), fromEnv = envBase();
  const base = fromSettings || fromEnv || null;
  const source = fromSettings ? "settings" as const : fromEnv ? "env" as const : null;
  const trackingOn = !!s?.tracking;

  const howTo = [
    "التتبّع يحتاج عنواناً يفتحه بريد المستلم من أي مكان — لا يكفي أن يعمل التطبيق على جهازك.",
    "أسهل طريق: نطاقٌ فرعي من نطاق الشركة (مثل app.pro-count.ae) يوجَّه إلى هذا الخادم.",
    "طريقٌ أسرع للتجربة: نفق مجاني — Cloudflare Tunnel أو ngrok — يعطيك عنواناً عاماً خلال دقيقة.",
    "ثم ضع العنوان في: البريد → الإعدادات → العنوان العام، واضغط «افحص».",
  ];

  if (!base) {
    return { can: false, base: null, source: null, trackingOn, howTo,
      why: "لا عنوان عام مضبوط. كل رسالة خرجت حتى الآن خرجت بلا بكسل فتحٍ وبلا روابط متتبَّعة — ولهذا الفتحات صفر: لم يُقَس شيء، لا أن أحداً لم يفتح." };
  }
  const v = validatePublicUrl(base);
  if (!v.ok) return { can: false, base, source, trackingOn, howTo, why: v.why ?? "العنوان غير صالح." };
  if (!trackingOn) {
    return { can: false, base: v.url!, source, trackingOn, howTo: ["شغّل «التتبّع» في: البريد → الإعدادات."],
      why: "العنوان العام مضبوط، لكن التتبّع مُطفأ في الإعدادات." };
  }
  const h = health.get(userId);
  if (h && h.failures >= DEAD_AFTER) {
    return { can: false, base: v.url!, source, trackingOn,
      why: `العنوان العام ${v.url} لا يستجيب (${h.why ?? "تعذّر الوصول"}). الرسائل تُرسل وتصل، والروابط تُترك بلا لفّ كي لا تُكسر في بريد العميل — لكن الفتح لا يُقاس.`,
      howTo: ["إن كان نفقاً مؤقّتاً فقد تغيّر عنوانه: شغّله من جديد وضع العنوان الجديد هنا.", ...howTo.slice(1)] };
  }
  return { can: true, base: v.url!, source, trackingOn, why: null, howTo: [] };
}
