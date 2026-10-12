// ── What a piece of gold costs today ──────────────────────────────
// The shop's rule, as the owner stated it: the day's gold price per gram
// for the karat, plus the making charge per gram, plus VAT on the whole.
//
//   price = (weight × rate(karat) + weight × making) × (1 + vat)
//
// The rate is quoted for 24k and scaled by purity (21k = 21/24 of it),
// which is also how the shop's own system prices its catalogue. Rounded to
// the dirham: a customer is told «٦٬٤٦٠ درهم», never «6459.73».

export type Pricing = {
  makingPerGram: number; vatPct: number; defaultKarat: number;
  /** The lowest the making charge may go, per gram — the only discount there is. */
  minMakingPerGram?: number;
  /** The one follow-up rung (1-based) on which it may be offered. */
  discountRung?: number;
};
export const DEFAULT_PRICING: Pricing = { makingPerGram: 45, vatPct: 5, defaultKarat: 21, minMakingPerGram: 25, discountRung: 4 };

/** The same piece with the making charge at its floor. Pure. */
export function discounted(weightG: number, karat: number, rate24: number, p: Pricing = DEFAULT_PRICING): Quote {
  return quote(weightG, karat, rate24, { ...p, makingPerGram: p.minMakingPerGram ?? p.makingPerGram });
}
/** How the discount is said: a cut on the making charge, never on the gold. Pure. */
export function discountText(full: Quote, cut: Quote, p: Pricing = DEFAULT_PRICING): string {
  const pct = Math.round((1 - (p.minMakingPerGram ?? p.makingPerGram) / p.makingPerGram) * 100);
  return `خصم ${pct}٪ على المصنعية فقط (من ${p.makingPerGram} إلى ${p.minMakingPerGram} درهم للجرام): السعر يصير ${Math.round(cut.total).toLocaleString("en-US")} درهم بدل ${Math.round(full.total).toLocaleString("en-US")} شامل الضريبة. سعر الذهب نفسه لا يُخصم.`;
}

/** The rate per gram for a karat, from the 24k rate. Pure. */
export const rateForKarat = (rate24: number, karat: number) => (rate24 * karat) / 24;

export type Quote = { weightG: number; karat: number; ratePerGram: number; gold: number; making: number; beforeVat: number; vat: number; total: number };

/** The price of a piece. Pure. */
export function quote(weightG: number, karat: number, rate24: number, p: Pricing = DEFAULT_PRICING): Quote {
  const ratePerGram = rateForKarat(rate24, karat);
  const gold = weightG * ratePerGram, making = weightG * p.makingPerGram;
  const beforeVat = gold + making, vat = beforeVat * (p.vatPct / 100);
  return { weightG, karat, ratePerGram, gold, making, beforeVat, vat, total: Math.round(beforeVat + vat) };
}

const dirham = (n: number) => `${Math.round(n).toLocaleString("en-US")} درهم`;

/** The quote as it is said to a customer, with the arithmetic shown once. Pure. */
export function quoteText(q: Quote, p: Pricing = DEFAULT_PRICING): string {
  return `${q.weightG} جم عيار ${q.karat}: سعر الذهب اليوم ${q.ratePerGram.toFixed(2)} درهم للجرام + مصنعية ${p.makingPerGram} درهم للجرام = ${dirham(q.beforeVat)}، وبالضريبة ${p.vatPct}٪ يصير ${dirham(q.total)} شامل الضريبة.`;
}

/**
 * A weight and karat the customer typed — «كم سعر ١٥ جرام عيار ٢١» — or
 * null when the message names no weight. Pure.
 */
export function parseWeightKarat(text: string, defaultKarat: number): { weightG: number; karat: number } | null {
  const t = text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[،,]/g, ".");
  const w = /(\d+(?:\.\d+)?)\s*(?:جم|جرام|غرام|غم|g\b|gm|gram|grams)/i.exec(t) ?? /(?:وزن|وزنه|weight)\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (!w) return null;
  const k = /(?:عيار|karat|carat|k)\s*(18|21|22|24)\b/i.exec(t) ?? /\b(18|21|22|24)\s*(?:عيار|k\b|karat|carat)/i.exec(t);
  return { weightG: Number(w[1]), karat: k ? Number(k[1]) : defaultKarat };
}
