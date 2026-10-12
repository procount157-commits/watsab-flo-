// ── What a shop's employee needs beside the message ──────────────
// For an account that sells pieces, the reply needs things the accounting
// firm's never did: which piece the customer named, today's price for the
// weight she typed, whether she came from an ad and which, and the photo to
// send after the words. Gathered here, once per message, from the catalogue
// and the shop's gold rate; handed to the reading and the prompt as facts.

import { and, eq, sql } from "drizzle-orm";
import { db, businessProfileTable, leadSourcesTable } from "@workspace/db";
import { findPieces, goldRate24, pricingOf, type CatalogItem } from "./floret";
import { parseWeightKarat, quote, quoteText } from "./pricing";
import { logger } from "../logger";

export type ShopContext = {
  vertical: "accounting" | "jewelry";
  dialect: string | null;
  ad: { title: string | null } | null;
  piece: CatalogItem | null;
  /** Facts for the prompt: the computed quote, the pieces named, today's rate. */
  facts: string[];
  /** The photo to send after the reply, if any. */
  photo: { path: string; caption: string } | null;
  /** Every published piece's name — the only pieces that may be named. */
  names: string[];
  pricing: import("./pricing").Pricing | null;
  rate24: number | null;
};

const NONE: ShopContext = { vertical: "accounting", dialect: null, ad: null, piece: null, facts: [], photo: null, names: [], pricing: null, rate24: null };

// Today's rate, asked of the shop at most once an hour.
let rateCache: { at: number; rate: number | null } = { at: 0, rate: null };
async function rate24(): Promise<number | null> {
  if (Date.now() - rateCache.at < 3_600_000) return rateCache.rate;
  const r = await goldRate24().catch((err) => { logger.warn({ err: String(err?.message ?? err).slice(0, 120) }, "سعر الذهب غير متاح"); return null; });
  rateCache = { at: Date.now(), rate: r?.aedPerG24 ?? null };
  return rateCache.rate;
}

export async function shopContext(userId: number, phone: string, text: string): Promise<ShopContext> {
  const [p] = await db.select({ vertical: businessProfileTable.vertical, dialect: businessProfileTable.dialect, catalog: businessProfileTable.catalogSource })
    .from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  if (p?.vertical !== "jewelry") return { ...NONE, dialect: p?.dialect ?? null };

  const [lead] = await db.select({ isAd: leadSourcesTable.source, title: leadSourcesTable.adTitle })
    .from(leadSourcesTable).where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.phone, phone))).limit(1);
  const ad = lead?.isAd === "ad" ? { title: lead.title ?? null } : null;

  const facts: string[] = [];
  const pricing = await pricingOf(userId);
  const r24 = await rate24();
  if (r24) facts.push(`سعر الذهب اليوم: عيار 24 = ${r24.toFixed(2)} درهم/جم · عيار ${pricing.defaultKarat} = ${((r24 * pricing.defaultKarat) / 24).toFixed(2)} درهم/جم · المصنعية ${pricing.makingPerGram} درهم/جم · الضريبة ${pricing.vatPct}٪.`);

  // A weight she typed: the number, computed, so the model copies rather than invents.
  const wk = parseWeightKarat(text, pricing.defaultKarat);
  if (wk && r24) facts.push(`السعر المحسوب لما سأل عنه — ${quoteText(quote(wk.weightG, wk.karat, r24, pricing), pricing)}`);

  // The pieces named — or, for an ad click, the piece the ad showed.
  const query = [text, ad?.title ?? ""].join(" ");
  const pieces = (await findPieces(userId, query, 3).catch(() => [])) as CatalogItem[];
  const piece = pieces[0] ?? null;
  for (const x of pieces) {
    facts.push(`قطعة: ${x.name} — رمز ${x.sku}${x.purity ? ` · عيار ${x.purity}` : ""}${x.weightG ? ` · ${x.weightG} جم` : ""}${x.priceAed ? ` · ${x.priceAed.toLocaleString("en-US")} درهم شامل الضريبة` : ""} · ${x.inStock ? "متوفرة" : "غير متوفرة حالياً"}${x.imagePath ? " · لها صورة تُرسل تلقائياً بعد ردك" : ""}`);
  }
  const photo = piece?.imagePath ? { path: piece.imagePath, caption: `${piece.name}${piece.purity ? ` · عيار ${piece.purity}` : ""}${piece.weightG ? ` · ${piece.weightG} جم` : ""}` } : null;
  const names = (await db.execute<{ name: string }>(sql`SELECT name FROM catalog_items WHERE user_id = ${userId} AND published ORDER BY in_stock DESC, name`).catch(() => ({ rows: [] as Array<{ name: string }> }))).rows.map((r) => r.name);
  facts.push(`القطع الموجودة عندنا الآن (لا تذكري قطعة غير هذه، وبنفس الاسم): ${names.join(" · ")}`);
  return { vertical: "jewelry", dialect: p.dialect ?? "gulf", ad, piece, facts, photo, names, pricing, rate24: r24 };
}
