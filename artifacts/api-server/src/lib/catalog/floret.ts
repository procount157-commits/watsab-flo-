// ── The shop's catalogue, learnt from its own database ───────────
// Floret's pieces live in the shop's system (its own Postgres, its own
// photos on disk, a gold rate its own bot records twice a day). The
// employees here learn them the only honest way: by copying what that
// system holds, and copying it again every few hours so a price that moved
// with the gold rate moves here too. Nothing is invented between syncs —
// a piece the shop unpublished disappears from the employees' knowledge.
//
// Two copies are kept: catalog_items, for sending a photo and quoting a
// weight; and the knowledge base, one entry per piece, so the retrieval
// every reply already uses finds «طقم الكلوفر» when a customer asks for it.
//
// Connection: FLORET_DATABASE_URL and FLORET_MEDIA_DIR in the environment,
// never in the database. Read-only.

import { Client } from "pg";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db, knowledgeBaseTable, businessProfileTable } from "@workspace/db";
import { logger } from "../logger";
import { DEFAULT_PRICING, type Pricing } from "./pricing";

export const CATALOG_KIND = "floret";
const KB_CATEGORY = "catalog";

type Doc = {
  name?: string; tagline?: string; purity?: number; weightG?: number; form?: string; productType?: string; kinds?: string[];
  highlights?: string[]; occasion?: string[]; audience?: string[]; color?: string; stock?: number; availability?: string;
  images?: Array<{ src: string; role?: string; alt?: string }>;
};

const AUDIENCE: Record<string, string> = { women: "نسائي", men: "رجالي", kids: "أطفال", girls: "بنات", unisex: "للجميع" };
const OCCASION: Record<string, string> = { wedding: "زفاف", engagement: "خطوبة", gift: "هدية", daily: "يومي", eid: "عيد", birth: "مولود", graduation: "تخرج" };
const ar = (m: Record<string, string>, xs?: string[]) => (xs ?? []).map((x) => m[x] ?? x).filter(Boolean);

/** The knowledge-base text for one piece — what an employee reads to answer about it. Pure. */
export function pieceEntry(i: { sku: string; name: string; purity: number | null; weightG: number | null; priceAed: number | null; tagline: string | null; highlights: string[]; occasion: string[]; audience: string[]; inStock: boolean; slug: string | null }, siteUrl?: string | null) {
  const facts = [
    i.purity ? `عيار ${i.purity}` : "", i.weightG ? `الوزن ${i.weightG} جم` : "",
    i.priceAed ? `السعر ${i.priceAed.toLocaleString("en-US")} درهم شامل الضريبة` : "السعر يُحدد عند السؤال",
    i.inStock ? "متوفر" : "غير متوفر حالياً",
  ].filter(Boolean).join(" · ");
  const content = [
    `${i.name} — ${facts}.`,
    i.tagline ?? "",
    i.highlights.length ? `مميزاته: ${i.highlights.join("، ")}.` : "",
    ar(OCCASION, i.occasion).length ? `يناسب: ${ar(OCCASION, i.occasion).join("، ")}.` : "",
    ar(AUDIENCE, i.audience).length ? `لـ: ${ar(AUDIENCE, i.audience).join("، ")}.` : "",
    `رمز القطعة: ${i.sku}${siteUrl && i.slug ? ` · الصفحة: ${siteUrl.replace(/\/$/, "")}/product/${i.slug}` : ""}`,
  ].filter(Boolean).join("\n");
  const keywords = [i.name, i.sku, ...i.highlights, ...ar(OCCASION, i.occasion), ...ar(AUDIENCE, i.audience), i.purity ? `عيار ${i.purity}` : ""].filter(Boolean).join(" ");
  return { title: i.name, content, keywords };
}

async function floret<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const url = process.env["FLORET_DATABASE_URL"];
  if (!url) throw new Error("FLORET_DATABASE_URL غير مضبوط");
  const c = new Client({ connectionString: url, statement_timeout: 15_000 });
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

/** Today's 24k rate per gram (AED), as the shop's own system last applied it. */
export async function goldRate24(): Promise<{ aedPerG24: number; at: Date } | null> {
  return floret(async (c) => {
    const r = await c.query(`SELECT aed_per_g24_x100 / 100.0 AS rate, created_at FROM cms.gold_rate WHERE status IN ('applied','verified') ORDER BY created_at DESC LIMIT 1`);
    const row = r.rows[0];
    return row ? { aedPerG24: Number(row.rate), at: new Date(row.created_at) } : null;
  });
}

/** Copy the shop's pieces into this account. Returns what changed. */
export async function syncCatalog(userId: number): Promise<{ pieces: number; published: number; kb: number; rate: number | null }> {
  const mediaDir = process.env["FLORET_MEDIA_DIR"] ?? "";
  const siteUrl = process.env["FLORET_SITE_URL"] ?? null;
  const rows = await floret((c) => c.query(`SELECT sku, slug, doc, price_aed, published FROM cms.product ORDER BY sort_order`).then((r) => r.rows));
  const rate = await goldRate24().catch(() => null);

  let published = 0, kb = 0;
  const seen: string[] = [];
  for (const r of rows) {
    const d = (r.doc ?? {}) as Doc;
    const hero = (d.images ?? []).find((x) => x.role === "hero") ?? (d.images ?? [])[0];
    const file = hero?.src ? join(mediaDir, hero.src.replace(/^\/media\//, "")) : null;
    const item = {
      sku: String(r.sku), slug: r.slug ?? null, name: d.name ?? r.sku, kind: d.productType ?? d.form ?? null,
      purity: d.purity ?? null, weightG: d.weightG ?? null, priceAed: r.price_aed ?? null, tagline: d.tagline ?? null,
      highlights: d.highlights ?? [], occasion: d.occasion ?? [], audience: d.audience ?? [],
      inStock: (d.stock ?? 1) > 0 && d.availability !== "sold_out", published: !!r.published,
      imagePath: file && existsSync(file) ? file : null,
      images: (d.images ?? []).map((x) => ({ role: x.role ?? null, path: mediaDir && x.src ? join(mediaDir, x.src.replace(/^\/media\//, "")) : null })).filter((x) => x.path && existsSync(x.path!)),
    };
    seen.push(item.sku);
    if (item.published) published++;
    await db.execute(sql`
      INSERT INTO catalog_items (user_id, sku, slug, name, kind, purity, weight_g, price_aed, tagline, highlights, occasion, audience, image_path, images, in_stock, published, doc, synced_at)
      VALUES (${userId}, ${item.sku}, ${item.slug}, ${item.name}, ${item.kind}, ${item.purity}, ${item.weightG}, ${item.priceAed}, ${item.tagline},
              ${JSON.stringify(item.highlights)}::jsonb, ${JSON.stringify(item.occasion)}::jsonb, ${JSON.stringify(item.audience)}::jsonb,
              ${item.imagePath}, ${JSON.stringify(item.images)}::jsonb, ${item.inStock}, ${item.published}, ${JSON.stringify(d)}::jsonb, now())
      ON CONFLICT (user_id, sku) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name, kind = EXCLUDED.kind, purity = EXCLUDED.purity, weight_g = EXCLUDED.weight_g,
        price_aed = EXCLUDED.price_aed, tagline = EXCLUDED.tagline, highlights = EXCLUDED.highlights, occasion = EXCLUDED.occasion, audience = EXCLUDED.audience,
        image_path = EXCLUDED.image_path, images = EXCLUDED.images, in_stock = EXCLUDED.in_stock, published = EXCLUDED.published, doc = EXCLUDED.doc, synced_at = now()`);

    // The knowledge entry, keyed by the SKU in its content so it is replaced, not duplicated.
    const e = pieceEntry(item, siteUrl);
    const [existing] = await db.select({ id: knowledgeBaseTable.id }).from(knowledgeBaseTable)
      .where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.category, KB_CATEGORY), sql`${knowledgeBaseTable.content} LIKE ${"%رمز القطعة: " + item.sku + "%"}`)).limit(1);
    if (existing) await db.update(knowledgeBaseTable).set({ title: e.title, content: e.content, keywords: e.keywords, isActive: item.published, updatedAt: new Date() }).where(eq(knowledgeBaseTable.id, existing.id));
    else await db.insert(knowledgeBaseTable).values({ userId, title: e.title, content: e.content, keywords: e.keywords, category: KB_CATEGORY, isActive: item.published });
    kb++;
  }
  // Pieces the shop deleted outright.
  if (seen.length) await db.execute(sql`UPDATE catalog_items SET published = false WHERE user_id = ${userId} AND NOT (sku = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(seen)}::jsonb))))`);

  // The day's rate, as a knowledge entry the employee can quote from.
  const pricing = await pricingOf(userId);
  if (rate) {
    const r21 = (rate.aedPerG24 * pricing.defaultKarat) / 24;
    const content = `سعر الذهب اليوم (${rate.at.toISOString().slice(0, 10)}): عيار 24 = ${rate.aedPerG24.toFixed(2)} درهم للجرام · عيار ${pricing.defaultKarat} = ${r21.toFixed(2)} درهم للجرام. المصنعية ${pricing.makingPerGram} درهم للجرام، والضريبة ${pricing.vatPct}٪ على المجموع. القاعدة: (الوزن × سعر الجرام + الوزن × المصنعية) × ${(1 + pricing.vatPct / 100).toFixed(2)}.`;
    const [ex] = await db.select({ id: knowledgeBaseTable.id }).from(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.title, "سعر الذهب اليوم"))).limit(1);
    if (ex) await db.update(knowledgeBaseTable).set({ content, updatedAt: new Date() }).where(eq(knowledgeBaseTable.id, ex.id));
    else await db.insert(knowledgeBaseTable).values({ userId, title: "سعر الذهب اليوم", content, keywords: "سعر الذهب الجرام عيار 21 24 مصنعية ضريبة كم سعر الجرام اليوم", category: KB_CATEGORY, isActive: true });
  }
  logger.info({ userId, pieces: rows.length, published, rate: rate?.aedPerG24 ?? null }, "الكتالوج مُزامَن من فلوريت");
  return { pieces: rows.length, published, kb, rate: rate?.aedPerG24 ?? null };
}

export async function pricingOf(userId: number): Promise<Pricing> {
  const [p] = await db.select({ pricing: businessProfileTable.pricing }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  return { ...DEFAULT_PRICING, ...(p?.pricing ?? {}) };
}

export type CatalogItem = { sku: string; slug: string | null; name: string; purity: number | null; weightG: number | null; priceAed: number | null; imagePath: string | null; inStock: boolean };

/** The pieces whose names the message mentions, best first. */
export async function findPieces(userId: number, text: string, limit = 3): Promise<CatalogItem[]> {
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !["طقم", "خاتم", "عيار", "سعر", "كم"].includes(w)).slice(0, 8);
  const r = await db.execute<any>(sql`
    SELECT sku, slug, name, purity, weight_g, price_aed, image_path, in_stock,
      (SELECT count(*) FROM jsonb_array_elements_text(${JSON.stringify(words.length ? words : ["__none__"])}::jsonb) w WHERE name ILIKE '%' || w || '%' OR sku ILIKE '%' || w || '%')::int AS hits
    FROM catalog_items WHERE user_id = ${userId} AND published
    ORDER BY hits DESC, in_stock DESC LIMIT ${limit}`);
  return r.rows.filter((x: any) => Number(x.hits) > 0).map((x: any) => ({ sku: x.sku, slug: x.slug, name: x.name, purity: x.purity, weightG: x.weight_g ? Number(x.weight_g) : null, priceAed: x.price_aed, imagePath: x.image_path, inStock: !!x.in_stock }));
}

export async function pieceBySku(userId: number, sku: string): Promise<CatalogItem | null> {
  const r = await db.execute<any>(sql`SELECT sku, slug, name, purity, weight_g, price_aed, image_path, in_stock FROM catalog_items WHERE user_id = ${userId} AND sku = ${sku} LIMIT 1`);
  const x = r.rows[0]; if (!x) return null;
  return { sku: x.sku, slug: x.slug, name: x.name, purity: x.purity, weightG: x.weight_g ? Number(x.weight_g) : null, priceAed: x.price_aed, imagePath: x.image_path, inStock: !!x.in_stock };
}

let timer: NodeJS.Timeout | null = null;
/** Every account whose catalogue is Floret's, synced every six hours. */
export function startCatalogSync() {
  if (timer || !process.env["FLORET_DATABASE_URL"]) return;
  const run = async () => {
    const users = await db.select({ userId: businessProfileTable.userId }).from(businessProfileTable).where(eq(businessProfileTable.catalogSource, CATALOG_KIND));
    for (const u of users) await syncCatalog(u.userId).catch((err) => logger.warn({ userId: u.userId, err: String(err?.message ?? err).slice(0, 200) }, "مزامنة الكتالوج فشلت"));
  };
  setTimeout(() => void run(), 90_000).unref();
  timer = setInterval(() => void run(), 6 * 3_600_000);
  timer.unref();
}
