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

const clean = (u: string | null | undefined): string => (u ?? "").trim().replace(/\/+$/, "");

/** الإعداد أولاً، ثم متغيّر البيئة — فمن ضبطه من الواجهة قصد ذلك. */
export async function publicBase(userId: number): Promise<string> {
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
  return { can: true, base: v.url!, source, trackingOn, why: null, howTo: [] };
}
