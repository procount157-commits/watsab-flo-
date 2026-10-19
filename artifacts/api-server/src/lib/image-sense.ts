// ── الصورة كما تُرى ───────────────────────────────────────────────
// صاحب العمل (١٩ أكتوبر): «لا يفهم الصور — يكتب للعقارات ويستخدم صور
// الذهب. أريده أن يطابق النص مع الصورة مع القائمة المختارة بحذر شديد».
//
// كان كاتب الحملات يختار الصورة باسم ملفها («ChatGPT Image Oct 15…»،
// «AML Compliance for Gold, Jewelry & Real…»)، فأرفق صورة سوارٍ وخاتمٍ
// ذهبيين برسالة للوسطاء العقاريين. هنا ثلاث طبقات:
//
//   ١. Gemini ينظر إلى كل صورة مرة واحدة ويكتب: ماذا فيها، ولأي قطاعٍ
//      وخدمةٍ تصلح. «عام» فقط حين لا يظهر فيها ما يخصّ قطاعاً بعينه.
//   ٢. الكاتب لا يُعرض عليه إلا ما يصلح لقطاع القائمة وخدمتها.
//   ٣. قبل أن تُحفظ النسخة، يرى Gemini الصورة والنص معاً. إن لم يقل «تطابق»
//      بثقة، تُرسل الرسالة بلا صورة. الشكّ يُسقط الصورة، لا يُبقيها.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db, mediaAssetsTable, type MediaAsset } from "@workspace/db";
import { getObjectBuffer, objectNameFromUrl, contentTypeForName } from "./storage";
import { parseLoose } from "./loose-json";
import { logger } from "./logger";

export const SECTORS = ["عقارات", "ذهب ومجوهرات", "قانونية", "مقاولات", "مطاعم ومقاهي"] as const;
export const GENERAL = "عام";
const MODEL = () => process.env["GEMINI_VISION_MODEL"] || process.env["GEMINI_MODEL"] || "gemini-3.1-flash-lite";

async function imageBytes(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const obj = objectNameFromUrl(url);
    if (obj) return { data: (await getObjectBuffer(obj)).toString("base64"), mime: contentTypeForName(obj) };
    if (!/^https?:\/\//.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15_000_000) return null;
    return { data: buf.toString("base64"), mime: r.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
  } catch { return null; }
}

async function askGemini(prompt: string, img: { data: string; mime: string }): Promise<any | null> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return null;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL()}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: img.mime, data: img.data } }, { text: prompt }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 600, responseMimeType: "application/json" },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`gemini vision ${r.status}: ${(await r.text()).slice(0, 120)}`);
  const d = await r.json() as any;
  return parseLoose(d?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "");
}

const DESCRIBE = [
  "انظر إلى هذه الصورة التسويقية بدقة، وأجب بـJSON فقط:",
  `{"vision":"جملة أو جملتان بالعربية: ماذا يظهر فيها فعلاً (الأشياء، المشهد، النص المكتوب فيها ولغته)","fits":["القطاعات التي تخصّها"],"service":"aml|services|jewelry|general","lang":"ar|en|mixed|none"}`,
  "lang: لغة الكلام المكتوب على التصميم نفسه — ar إن كان كله أو جلّه عربياً، en إن كان كله أو جلّه إنجليزياً، mixed إن كان فيه الاثنان بقدرٍ متقارب، none إن لم يكن عليه كلام (الشعار وحده لا يُحسب).",
  `fits: اختر من هذه فقط: ${SECTORS.join("، ")}، ${GENERAL}.`,
  "· ضع القطاع فقط إن كان ظاهراً في الصورة نفسها: ذهب أو مجوهرات ظاهرة ⇐ «ذهب ومجوهرات»؛ مبانٍ أو عقارات ⇐ «عقارات»؛ موقع بناء أو معدات ⇐ «مقاولات»؛ طعام أو مطعم ⇐ «مطاعم ومقاهي»؛ ميزان عدالة أو محكمة ⇐ «قانونية».",
  "· صورة تجمع ذهباً وعقارات معاً تأخذ القطاعين، لا «عام».",
  `· «${GENERAL}» فقط إن لم يظهر فيها شيء يخصّ قطاعاً (مكتب، أوراق، رسوم بيانية، شعار).`,
  "service: aml إن كانت عن مكافحة غسل الأموال أو الامتثال أو goAML؛ services إن كانت عن المحاسبة أو الضرائب أو التكاليف أو التدقيق؛ jewelry إن كانت قطعة مجوهرات معروضة للبيع؛ general غير ذلك.",
].join("\n");

/** Gemini reads one picture and the gallery keeps what it saw. */
export async function describeAsset(a: Pick<MediaAsset, "id" | "url">): Promise<boolean> {
  const img = await imageBytes(a.url);
  if (!img) { await db.update(mediaAssetsTable).set({ visionAt: new Date(), vision: null }).where(eq(mediaAssetsTable.id, a.id)); return false; }
  const out = await askGemini(DESCRIBE, img);
  if (!out?.vision) return false;
  const fits = (Array.isArray(out.fits) ? out.fits : []).map(String).filter((x: string) => (SECTORS as readonly string[]).includes(x) || x === GENERAL);
  const service = ["aml", "services", "jewelry", "general"].includes(out.service) ? out.service : "general";
  const lang = ["ar", "en", "mixed", "none"].includes(out.lang) ? out.lang : null;
  await db.update(mediaAssetsTable).set({ vision: String(out.vision).slice(0, 600), fits: fits.length ? fits : [GENERAL], service, lang, visionAt: new Date() })
    .where(eq(mediaAssetsTable.id, a.id));
  return true;
}

/**
 * Whether a picture may go with a campaign to this sector and service. Pure.
 * Strict: a picture showing any other sector never goes — not even one that
 * shows this sector beside it.
 */
export function fitsCampaign(a: { fits: string[] | null; service: string | null; vision: string | null; lang?: string | null }, sector: string, service: string, msgLang: "ar" | "en" = "ar"): boolean {
  if (!a.vision || !a.fits?.length) return false;              // not seen yet: not used
  // The owner: «some designs are in English and it sends them with Arabic».
  // A design's words are in the message's language, or it has none.
  if (!a.lang || !(a.lang === msgLang || a.lang === "none")) return false;
  // Only this sector, or general. A picture that also shows another sector
  // (gold beside buildings) is not sent to either: the owner saw exactly that
  // picture under a real-estate message and asked for it to stop.
  const sectorOk = a.fits.every((f) => f === sector || f === GENERAL);
  if (!sectorOk) return false;
  if (service === "aml") return a.service === "aml" || a.service === "general";
  if (service === "services") return a.service === "services" || a.service === "general";
  return true;                                                   // the shop's own list
}

/** The last check: the picture and the words together. Doubt drops the picture. */
export async function pictureMatches(url: string, message: string, audience: string): Promise<{ ok: boolean; why: string }> {
  const img = await imageBytes(url);
  if (!img) return { ok: false, why: "تعذّرت قراءة الصورة" };
  const out = await askGemini([
    `هذه صورة ستُرسل مع رسالة واتساب إلى: ${audience}.`, `الرسالة:\n«${message}»`, "",
    "هل الصورة تطابق الرسالة والجمهور؟ لا تطابق إن أظهرت قطاعاً آخر (مثلاً ذهب ومجوهرات في رسالة للعقارات أو للمحاسبة)، أو موضوعاً غير موضوع الرسالة، أو نصاً يناقضها، أو كان الكلام المكتوب على التصميم بلغةٍ غير لغة الرسالة (تصميم إنجليزي مع رسالة عربية لا يطابق).",
    `أجب بـJSON فقط: {"match":true|false,"confidence":0-100,"why":"سبب قصير بالعربية"}`,
  ].join("\n"), img).catch(() => null);
  const ok = out?.match === true && Number(out?.confidence ?? 0) >= 80;
  return { ok, why: String(out?.why ?? (out ? "" : "لم يُجب الفاحص")).slice(0, 200) };
}

/** Pictures not seen yet, a few at a time. */
export async function describePending(limit = 8): Promise<number> {
  const rows = await db.select({ id: mediaAssetsTable.id, url: mediaAssetsTable.url }).from(mediaAssetsTable)
    .where(or(isNull(mediaAssetsTable.visionAt), and(isNull(mediaAssetsTable.vision), sql`${mediaAssetsTable.visionAt} < now() - interval '1 day'`)))
    .limit(limit);
  let n = 0;
  for (const r of rows) {
    try { if (await describeAsset(r)) n++; }
    catch (err) { logger.warn({ id: r.id, err: String((err as any)?.message ?? err) }, "وصف الصورة تعذّر"); break; }
  }
  return n;
}

export function startImageSense(): void {
  if (!process.env["GEMINI_API_KEY"]) return;
  setTimeout(() => {
    const tick = () => void describePending().then((n) => { if (n) logger.info({ n }, "Gemini وصف صوراً في المعرض"); }).catch(() => {});
    tick();
    setInterval(tick, 3 * 60_000);
  }, 45_000);
}
