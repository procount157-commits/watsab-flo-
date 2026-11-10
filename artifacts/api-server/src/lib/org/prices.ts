// ── أسعار المزوّدين ───────────────────────────────────────────────
// provider_prices تُبذر فارغة: لا سعر مخترع ولا منقول من الذاكرة. يضعه المالك
// (PUT /org/providers/prices، للمدير وحده لأن السعر عام لكل الحسابات) ومعه مصدره.
// الكلفة تُحسب حيث يوجد صفٌّ لهذا المزوّد وهذا النموذج بعينه، وإلا null («غير متاح»)، لا صفر.
// التوكنات تقدير من الأحرف (tokensOf)، فالكلفة تقدير مثلها. الحقول costUsd بالدولار وحده:
// سعرٌ بعملة أخرى يُحفظ ويُعرض، ولا يدخل جمعاً بالدولار.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";
import { ensureOrgTables } from "./schema";

export interface Price { provider: string; model: string; inputPerMillion: number; outputPerMillion: number; currency: string; source: string; updatedAt?: string; updatedBy?: number | null }

export const PRICES_TTL_MS = 60_000;
let cache: { at: number; map: Map<string, Price> } | null = null;
const key = (provider: string, model: string) => `${provider}|${model ?? ""}`;

/** كلفة نداءٍ بسعره. Pure. */
export function costOf(p: Pick<Price, "inputPerMillion" | "outputPerMillion">, tokensIn: number, tokensOut: number): number {
  return (Math.max(0, tokensIn) * p.inputPerMillion + Math.max(0, tokensOut) * p.outputPerMillion) / 1_000_000;
}

/** بالدولار، أو null إن لم يكن له سعر بالدولار. Pure على الخريطة. */
export function usdCost(map: ReadonlyMap<string, Price>, provider: string, model: string, tokensIn: number, tokensOut: number): number | null {
  const p = map.get(key(provider, model));
  if (!p || p.currency !== "USD") return null;
  return costOf(p, tokensIn, tokensOut);
}

export async function priceMap(now = Date.now()): Promise<ReadonlyMap<string, Price>> {
  if (cache && now - cache.at < PRICES_TTL_MS) return cache.map;
  try {
    await ensureOrgTables();
    const r = await db.execute<any>(sql`SELECT provider, model, input_per_million, output_per_million, currency, source, updated_at, updated_by FROM provider_prices`);
    const map = new Map<string, Price>(r.rows.map((x) => [key(x.provider, x.model), rowToPrice(x)]));
    cache = { at: now, map };
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err).slice(0, 160) }, "أسعار المزوّدين لم تُقرأ — الكلفة غير متاحة");
    cache = { at: now, map: new Map() };
  }
  return cache.map;
}

/** ما في الذاكرة الآن، بلا قاعدة: للنداء نفسه. فارغة قبل أول قراءة، فالكلفة null لا تخمين. */
export const cachedPrices = (): ReadonlyMap<string, Price> => cache?.map ?? new Map();

const rowToPrice = (x: any): Price => ({
  provider: x.provider, model: x.model, inputPerMillion: Number(x.input_per_million), outputPerMillion: Number(x.output_per_million),
  currency: x.currency, source: x.source, updatedAt: x.updated_at ? new Date(x.updated_at).toISOString() : undefined, updatedBy: x.updated_by == null ? null : Number(x.updated_by),
});

export async function listPrices(): Promise<Price[]> {
  await ensureOrgTables();
  const r = await db.execute<any>(sql`SELECT provider, model, input_per_million, output_per_million, currency, source, updated_at, updated_by FROM provider_prices ORDER BY provider, model`);
  return r.rows.map(rowToPrice);
}

export class PriceRefused extends Error {}

export interface PriceInput { provider?: unknown; model?: unknown; inputPerMillion?: unknown; outputPerMillion?: unknown; currency?: unknown; source?: unknown; remove?: unknown }

/** يفحص سطراً من الطلب. يرمي PriceRefused بالسبب. Pure. */
export function validatePrice(x: PriceInput): { remove: true; provider: string; model: string } | (Price & { remove: false }) {
  const provider = typeof x.provider === "string" ? x.provider.trim() : "";
  const model = typeof x.model === "string" ? x.model.trim() : "";
  if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw new PriceRefused("provider مطلوب (حروف صغيرة وأرقام، حتى 40)");
  if (model.length > 120) throw new PriceRefused("model أطول من 120");
  if (x.remove === true) return { remove: true, provider, model };
  const num = (v: unknown, name: string) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new PriceRefused(`${name} رقم بين 0 و100000 لكل مليون توكن`);
    return n;
  };
  const currency = typeof x.currency === "string" && x.currency.trim() ? x.currency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new PriceRefused("currency رمز من ثلاثة أحرف (USD)");
  const source = typeof x.source === "string" ? x.source.trim() : "";
  // لا سعر بلا مصدر: صفحة الأسعار أو الفاتورة. هذا ما يمنع الرقم المخترع.
  if (source.length < 3 || source.length > 500) throw new PriceRefused("source مطلوب: من أين جاء السعر (رابط صفحة الأسعار أو الفاتورة)");
  return { remove: false, provider, model, inputPerMillion: num(x.inputPerMillion, "inputPerMillion"), outputPerMillion: num(x.outputPerMillion, "outputPerMillion"), currency, source };
}

/** يضع الأسعار أو يحذفها، دفعةً واحدة: سطرٌ مرفوض يرفض الطلب كله قبل أي كتابة. */
export async function setPrices(actor: number, rows: PriceInput[]): Promise<Price[]> {
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw new PriceRefused("prices: قائمة من 1 إلى 200 سطر");
  const clean = rows.map(validatePrice);
  await ensureOrgTables();
  await db.transaction(async (tx) => {
    for (const p of clean) {
      if (p.remove) await tx.execute(sql`DELETE FROM provider_prices WHERE provider = ${p.provider} AND model = ${p.model}`);
      else await tx.execute(sql`INSERT INTO provider_prices (provider, model, input_per_million, output_per_million, currency, source, updated_by, updated_at)
        VALUES (${p.provider}, ${p.model}, ${p.inputPerMillion}, ${p.outputPerMillion}, ${p.currency}, ${p.source}, ${actor}, now())
        ON CONFLICT (provider, model) DO UPDATE SET input_per_million = EXCLUDED.input_per_million, output_per_million = EXCLUDED.output_per_million,
          currency = EXCLUDED.currency, source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()`);
    }
  });
  const { audit } = await import("./controls");
  await audit({ userId: actor, action: "providers.prices", actor, kind: "set", meta: { rows: clean } as any }).catch(() => {});
  cache = null;
  return listPrices();
}

/** للاختبار. */
export const forgetPrices = () => { cache = null; };
