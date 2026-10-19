// ── What a shop's employee needs beside the message ──────────────
// For an account that sells pieces, the reply needs things the accounting
// firm's never did: which piece the customer named, today's price for the
// weight she typed, whether she came from an ad and which, and the photo to
// send after the words. Gathered here, once per message, from the catalogue
// and the shop's gold rate; handed to the reading and the prompt as facts.

import { and, eq, sql } from "drizzle-orm";
import { db, businessProfileTable, leadSourcesTable } from "@workspace/db";
import { findPieces, pricingOf, pieceUrl, shopName, STORE_URL, type CatalogItem } from "./floret";

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
  /** The piece's page on the shop's site, or the shop's home: the answer to «how much» and «how heavy». */
  link?: string | null;
};

const NONE: ShopContext = { vertical: "accounting", dialect: null, ad: null, piece: null, facts: [], photo: null, names: [], pricing: null, rate24: null };

export async function shopContext(userId: number, phone: string, text: string): Promise<ShopContext> {
  const [p] = await db.select({ vertical: businessProfileTable.vertical, dialect: businessProfileTable.dialect, catalog: businessProfileTable.catalogSource })
    .from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  if (p?.vertical !== "jewelry") return { ...NONE, dialect: p?.dialect ?? null };

  const [lead] = await db.select({ isAd: leadSourcesTable.source, title: leadSourcesTable.adTitle })
    .from(leadSourcesTable).where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.phone, phone))).limit(1);
  const ad = lead?.isAd === "ad" ? { title: lead.title ?? null } : null;

  // No price, no weight, no gold rate (the owner, 2026-10-19): a question
  // about them is answered with the piece's page, which carries them. So the
  // facts hold the pieces and their links — never a number to quote.
  const facts: string[] = [
    "قاعدة المحل: لا سعر ولا وزن ولا سعر ذهب اليوم ولا خصم في أي رسالة. من سألت عن السعر أو الوزن أو التفاصيل: أرسلي رابط القطعة من الموقع في جملة قصيرة محترمة، ففيه كل شيء. وإن لم تُعرف القطعة: رابط المتجر " + STORE_URL + " وسؤال واحد عن القطعة التي أعجبتها.",
  ];
  const pricing = await pricingOf(userId);
  const r24: number | null = null;

  // The pieces named — or, for an ad click, the piece the ad showed.
  const query = [text, ad?.title ?? ""].join(" ");
  const pieces = (await findPieces(userId, query, 3).catch(() => [])) as CatalogItem[];
  const piece = pieces[0] ?? null;
  for (const x of pieces) {
    facts.push(`قطعة: ${shopName(x.name)}${x.purity ? ` · عيار ${x.purity}` : ""} · ${x.inStock ? "متوفرة" : "غير متوفرة حالياً"}${x.slug ? ` · رابطها: ${pieceUrl(x.slug)}` : ""}`);
  }
  const link = piece?.slug ? pieceUrl(piece.slug) : STORE_URL;
  const photo = piece?.imagePath ? { path: piece.imagePath, caption: `${shopName(piece.name)}${piece.slug ? `\n${pieceUrl(piece.slug)}` : ""}` } : null;
  const names = (await db.execute<{ name: string }>(sql`SELECT name FROM catalog_items WHERE user_id = ${userId} AND published ORDER BY in_stock DESC, name`).catch(() => ({ rows: [] as Array<{ name: string }> }))).rows.map((r) => shopName(r.name));
  facts.push(`القطع الموجودة عندنا الآن (لا تذكري قطعة غير هذه، وبنفس الاسم): ${names.join(" · ")}`);
  return { vertical: "jewelry", dialect: p.dialect ?? "gulf", ad, piece, facts, photo, names, pricing, rate24: r24, link };
}
