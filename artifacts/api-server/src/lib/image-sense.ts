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

// Gemini answers 503 «high demand» often enough that one model is not a plan:
// twelve pictures uploaded at once waited out three 3-minute rounds behind one.
const MODELS = () => [...new Set([MODEL(), "gemini-flash-lite-latest", "gemini-3.5-flash-lite"])];

async function askGemini(prompt: string, img: { data: string; mime: string }): Promise<any | null> {
  let last: unknown = null;
  for (const model of MODELS()) {
    try { return await askOne(model, prompt, img); }
    catch (err) { last = err; if (!/\b(429|500|503|504)\b|timeout|aborted/i.test(String((err as any)?.message ?? err))) throw err; }
  }
  throw last;
}

async function askOne(model: string, prompt: string, img: { data: string; mime: string }): Promise<any | null> {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) return null;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
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
  // A file that cannot be read is settled as unusable (no vision), so it never holds the autopilot waiting.
  if (!img) { await db.update(mediaAssetsTable).set({ visionAt: new Date(), vision: null, lang: "none" }).where(eq(mediaAssetsTable.id, a.id)); return false; }
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
 * Strict: a picture showing an unrelated sector never goes — not even one
 * that shows this sector beside it. The message is then written in the
 * design's own language (messageLang), not the other way round.
 */
/** Sectors whose pictures look alike: a construction site shows buildings. */
const NEIGHBOURS: Record<string, string[]> = { "عقارات": ["مقاولات"], "مقاولات": ["عقارات"] };

export function fitsCampaign(a: { fits: string[] | null; service: string | null; vision: string | null; lang?: string | null }, sector: string, service: string): boolean {
  if (!a.vision || !a.fits?.length || !a.lang) return false;   // not seen (or its language not read) yet: not used
  // This sector, or general, or a neighbour shown beside it (buildings on a
  // construction site). Anything else beside it — gold beside buildings, the
  // picture the owner saw under a real-estate message — keeps it out.
  const near = NEIGHBOURS[sector] ?? [];
  const sectorOk = (a.fits.includes(sector) || a.fits.every((f) => f === GENERAL)) && a.fits.every((f) => f === sector || f === GENERAL || near.includes(f));
  if (!sectorOk) return false;
  if (service === "aml") return a.service === "aml" || a.service === "general";
  if (service === "services") return a.service === "services" || a.service === "general";
  return true;                                                   // the shop's own list
}

/** The language a message to go with this design is written in: the design's own. Pure. */
export function messageLang(designLang: string | null | undefined): "ar" | "en" {
  return designLang === "en" ? "en" : "ar";
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

const unread = () => or(isNull(mediaAssetsTable.visionAt), and(isNull(mediaAssetsTable.lang), sql`${mediaAssetsTable.visionAt} < now() - interval '2 minutes'`));

/** Pictures not seen yet — the account's, or everyone's — a batch at a time. One failure does not stop the rest. */
export async function describePending(limit = 12, userId?: number): Promise<number> {
  const rows = await db.select({ id: mediaAssetsTable.id, url: mediaAssetsTable.url }).from(mediaAssetsTable)
    .where(userId ? and(eq(mediaAssetsTable.userId, userId), unread()) : unread())
    .limit(limit);
  let n = 0;
  for (const r of rows) {
    try { if (await describeAsset(r)) n++; }
    catch (err) { logger.warn({ id: r.id, err: String((err as any)?.message ?? err) }, "وصف الصورة تعذّر"); }
  }
  return n;
}

/** How many of the account's pictures are still unread. */
export async function unreadCount(userId: number): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(mediaAssetsTable).where(and(eq(mediaAssetsTable.userId, userId), unread()));
  return Number(r?.n ?? 0);
}

export function startImageSense(): void {
  if (!process.env["GEMINI_API_KEY"]) return;
  setTimeout(() => {
    const tick = () => void describePending().then((n) => { if (n) logger.info({ n }, "Gemini وصف صوراً في المعرض"); }).catch(() => {});
    tick();
    setInterval(tick, 60_000);
  }, 45_000);
}
