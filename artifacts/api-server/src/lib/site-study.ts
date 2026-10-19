// ── دراسة موقع الشركة ────────────────────────────────────────────
// صاحب العمل: «أعطيه رابط موقعنا وهو يدرسه: الخدمات، ثم يكتب الحملات».
// كان القارئ يقرأ صفحةً واحدة من موقع *عميلٍ محتمل* ويكتب عنه تقريراً
// لا يُحفظ. هنا يقرأ موقع الشركة نفسها: حتى خمساً وعشرين صفحة من النطاق
// نفسه، فيكتب للفريق مدخلات معرفة (الخدمات، العروض، من نحن، الأسئلة،
// التواصل)، ويضع صور الصفحات في المعرض بوصفها، لكاتب الحملات.
//
// ولمحل الذهب قاعدته: ما فيه سعر أو وزن يُحذف من المدخلات قبل أن يقرأه أحد.

import { and, eq, sql } from "drizzle-orm";
import { db, knowledgeBaseTable, mediaAssetsTable, businessProfileTable } from "@workspace/db";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { logger } from "./logger";
import { priceOrWeight } from "./reply-check";

export const SITE_CATEGORY = "website";
const MAX_PAGES = 25, MAX_IMAGES = 60;
const SKIP = /\.(pdf|zip|jpg|jpeg|png|gif|webp|svg|mp4|css|js|ico|xml)(\?|$)|\/(cart|checkout|login|account|wp-admin|wp-login|admin|feed|tag|author)\b|#|mailto:|tel:|whatsapp:|javascript:/i;

/** A page's readable text, title, description, links and images. Pure over the HTML. */
export function readPage(html: string, url: string) {
  const base = new URL(url);
  const pick = (re: RegExp) => re.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);
  const ogImage = pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i);
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  const abs = (h: string) => { try { return new URL(h, base).toString(); } catch { return null; } };
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map((m) => abs(m[1]!)).filter((u): u is string => !!u && new URL(u).hostname === base.hostname && !SKIP.test(u)).map((u) => u.split("#")[0]!);
  const images = [
    ...(ogImage ? [{ src: abs(ogImage), alt: title }] : []),
    ...[...html.matchAll(/<img[^>]+>/gi)].map((m) => {
      const tag = m[0];
      const src = /(?:data-src|src)=["']([^"']+)["']/i.exec(tag)?.[1];
      const alt = /alt=["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
      return { src: src ? abs(src) : null, alt };
    }).filter((i) => i.src && !/logo|icon|sprite|placeholder|pixel|\.svg/i.test(i.src) && i.alt.trim().length > 2),
  ].filter((i): i is { src: string; alt: string } => !!i.src).slice(0, 4);
  return { title, description, text: text.slice(0, 3500), links: [...new Set(links)], images };
}

async function fetchPage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; FlowHubSiteStudy/1.0)", Accept: "text/html" }, signal: AbortSignal.timeout(15_000), redirect: "follow" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("text/html")) return null;
    return (await r.text()).slice(0, 600_000);
  } catch { return null; }
}

/** Pages worth reading first: short paths, and the ones that name services, products, about, contact. Pure. */
export function rankLinks(urls: string[]): string[] {
  const score = (u: string) => {
    const p = new URL(u).pathname;
    let s = -p.split("/").filter(Boolean).length;
    if (/servic|خدم|about|من-نحن|عن|product|collection|shop|منتج|offer|عرض|faq|contact|تواصل|pricing|package|باق/i.test(decodeURIComponent(p))) s += 3;
    return s;
  };
  return [...urls].sort((a, b) => score(b) - score(a));
}

export interface StudyResult { site: string; pages: number; entries: number; images: number; at: string; error?: string }
const lastResult = new Map<number, StudyResult>();
const running = new Set<number>();
export const studyState = (userId: number) => ({ running: running.has(userId), last: lastResult.get(userId) ?? null });

export async function studySite(userId: number, rawUrl: string): Promise<StudyResult> {
  const start = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`).toString();
  if (running.has(userId)) throw new Error("دراسة الموقع جارية بالفعل");
  running.add(userId);
  try {
    const [profile] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
    const shop = profile?.vertical === "jewelry";
    const seen = new Set<string>(), queue = [start];
    const pages: Array<ReturnType<typeof readPage> & { url: string }> = [];
    while (queue.length && pages.length < MAX_PAGES) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const html = await fetchPage(url);
      if (!html) continue;
      const p = readPage(html, url);
      pages.push({ ...p, url });
      for (const l of rankLinks(p.links)) if (!seen.has(l) && !queue.includes(l)) queue.push(l);
      queue.splice(0, queue.length, ...rankLinks(queue));
    }
    if (!pages.length) throw new Error("تعذّرت قراءة الموقع — تأكد من الرابط");

    // The images, into the gallery with what their page says they are.
    let images = 0;
    for (const p of pages) for (const im of p.images) {
      if (images >= MAX_IMAGES) break;
      const caption = (im.alt || p.title).slice(0, 300);
      const r = await db.insert(mediaAssetsTable).values({ userId, url: im.src, caption, tags: ["من الموقع"], source: "website", sourceUrl: p.url })
        .onConflictDoNothing().returning({ id: mediaAssetsTable.id }).catch(() => []);
      images += r.length;
    }

    // The knowledge: one model call over every page read.
    const corpus = pages.map((p, i) => `### صفحة ${i + 1}: ${p.title}\n${p.url}\n${p.description}\n${p.text}`).join("\n\n").slice(0, 40_000);
    const out = await asAgent(userId, "sales", () => complete([
      { role: "system", content: [
        `أنت تدرس موقع ${profile?.name ?? "الشركة"} لتكتب لفريق المبيعات ما يحتاجه ليتكلّم عنها بدقة.`,
        "اكتب من الصفحات وحدها — لا تخترع خدمة أو رقماً أو وعداً غير مكتوب فيها.",
        "قسّم ما تعرفه إلى مدخلات: من نحن، كل خدمة أو فئة منتجات في مدخل، العروض، الأسئلة الشائعة، طرق التواصل والعنوان، السياسات (التوصيل، الإرجاع) إن وُجدت.",
        shop ? "هذا محل ذهب: لا تكتب أي سعر أو وزن أو سعر ذهب أو مصنعية أو خصم في أي مدخل — اكتب بدلها أن التفاصيل في صفحة القطعة." : "",
        "أعد JSON فقط: {\"entries\":[{\"title\":\"عنوان قصير\",\"content\":\"نص المدخل، فقرة أو نقاط قصيرة، مع رابط الصفحة إن كان مفيداً\"}]} — اثنا عشر مدخلاً على الأكثر، بالعربية.",
      ].filter(Boolean).join("\n") },
      { role: "user", content: corpus },
    ], 120_000)).catch(() => null);
    let entries: Array<{ title: string; content: string }> = [];
    try { entries = JSON.parse(out!.text.slice(out!.text.indexOf("{"), out!.text.lastIndexOf("}") + 1)).entries ?? []; } catch { /* below */ }
    entries = entries.filter((e) => e?.title && e?.content).slice(0, 12)
      .map((e) => ({ title: String(e.title).slice(0, 200), content: shop ? String(e.content).split("\n").filter((l) => !priceOrWeight(l)).join("\n") : String(e.content) }))
      .filter((e) => e.content.trim().length > 10);
    if (entries.length) {
      // A new study replaces the last one: the site is what it is now.
      await db.delete(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.category, SITE_CATEGORY)));
      await db.insert(knowledgeBaseTable).values(entries.map((e) => ({ userId, title: e.title, content: `${e.content}\n(من موقع الشركة: ${start})`, keywords: e.title, category: SITE_CATEGORY, isActive: true })));
    }
    const result: StudyResult = { site: start, pages: pages.length, entries: entries.length, images, at: new Date().toISOString(), ...(entries.length ? {} : { error: "قُرئت الصفحات لكن النموذج لم يكتب مدخلات — أعد المحاولة بعد قليل" }) };
    lastResult.set(userId, result);
    logger.info({ userId, ...result }, "دُرس موقع الشركة");
    return result;
  } catch (err: any) {
    const result: StudyResult = { site: start, pages: 0, entries: 0, images: 0, at: new Date().toISOString(), error: String(err?.message ?? err) };
    lastResult.set(userId, result);
    return result;
  } finally { running.delete(userId); }
}

void sql;
