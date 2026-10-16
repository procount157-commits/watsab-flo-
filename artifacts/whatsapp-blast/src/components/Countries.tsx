// ── Lists by country ──────────────────────────────────────────────
// Shared by the WhatsApp number lists and the email lists: a row of the
// owner's markets — the Gulf, Iraq, Egypt, Sudan — each with how many lists
// it has. Pick one and only its lists show. The server says how many of each
// list's people are in each country (lib/list-country.ts); a list shows under
// a country when that country is its main one or a real share of it.
//
// The choice is remembered and shared by both sections, so Saudi Arabia picked
// on the numbers page is Saudi Arabia on the email page.

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export const MARKETS = [
  { iso: "AE", cc: "971", flag: "🇦🇪", ar: "الإمارات" },
  { iso: "SA", cc: "966", flag: "🇸🇦", ar: "السعودية" },
  { iso: "QA", cc: "974", flag: "🇶🇦", ar: "قطر" },
  { iso: "KW", cc: "965", flag: "🇰🇼", ar: "الكويت" },
  { iso: "BH", cc: "973", flag: "🇧🇭", ar: "البحرين" },
  { iso: "OM", cc: "968", flag: "🇴🇲", ar: "عُمان" },
  { iso: "IQ", cc: "964", flag: "🇮🇶", ar: "العراق" },
  { iso: "EG", cc: "20",  flag: "🇪🇬", ar: "مصر" },
  { iso: "SD", cc: "249", flag: "🇸🇩", ar: "السودان" },
] as const;

/**
 * The country shown: the one picked, if it has lists; else the country with
 * the most lists. There is no «all countries» — the owner: «أريد الكل مخفيّة
 * منعاً للتشتت». Pure.
 */
export function resolveCountry<T extends WithCountries>(sel: CountrySel, lists: T[]): CountrySel {
  if (sel !== "all" && inCountry(lists, sel).length) return sel;
  let best: CountrySel = "none", most = 0;
  for (const m of MARKETS) { const n = inCountry(lists, m.iso).length; if (n > most) { best = m.iso; most = n; } }
  return most ? best : (inCountry(lists, "none").length ? "none" : "AE");
}

/** "all", "none" (no known country), or a country's ISO code. */
export type CountrySel = string;

type WithCountries = { count?: number; country?: string | null; countries?: Record<string, number> };
export type { WithCountries };

/** Whether a list belongs under a country: its main one, or at least a fifth of it. */
export function inCountry<T extends WithCountries>(lists: T[], sel: CountrySel): T[] {
  if (sel === "all") return lists;
  if (sel === "none") return lists.filter((l) => !l.country);
  return lists.filter((l) => {
    const n = l.countries?.[sel] ?? 0;
    return l.country === sel || (n > 0 && n >= (l.count ?? 0) * 0.2);
  });
}

const KEY = "lists-country";
export function useCountrySel(): [CountrySel, (s: CountrySel) => void] {
  const [sel, setSel] = useState<CountrySel>(() => { try { return localStorage.getItem(KEY) || "all"; } catch { return "all"; } });
  useEffect(() => { try { localStorage.setItem(KEY, sel); } catch { /* private window */ } }, [sel]);
  return [sel, setSel];
}

export const flagOf = (iso?: string | null) => MARKETS.find((m) => m.iso === iso)?.flag ?? "";
export const nameOf = (iso?: string | null) => MARKETS.find((m) => m.iso === iso)?.ar ?? "";

export function CountryBar<T extends WithCountries>({ lists, value, onChange }: { lists: T[]; value: CountrySel; onChange: (s: CountrySel) => void }) {
  const chip = (on: boolean, empty = false) => cn("flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border transition-colors whitespace-nowrap",
    on ? "bg-primary/15 text-primary border-primary/40 font-medium" : "text-muted-foreground border-border hover:border-primary/30 hover:text-foreground",
    empty && !on && "opacity-50");
  const unknown = inCountry(lists, "none").length;
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <span className="text-xs text-muted-foreground ml-1">الدولة:</span>
      {MARKETS.map((m) => {
        const n = inCountry(lists, m.iso).length;
        // Only the countries that have lists: an empty one is noise.
        if (!n && value !== m.iso) return null;
        return (
          <button key={m.iso} onClick={() => onChange(m.iso)} className={chip(value === m.iso, !n)} title={`+${m.cc}`}>
            <span>{m.flag}</span>{m.ar} <span className="opacity-70">({n})</span>
          </button>
        );
      })}
      {unknown > 0 && <button onClick={() => onChange("none")} className={chip(value === "none")}>❔ غير محددة <span className="opacity-70">({unknown})</span></button>}
    </div>
  );
}

/** The country for numbers written without a code — named, not just a code. */
export function CountryCodeSelect({ value, onChange, className }: { value: string; onChange: (iso: string) => void; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} title="الدولة للأرقام المكتوبة بلا رمز دولة"
      className={cn("px-2 py-2 bg-input border border-border rounded-lg text-xs", className)}>
      {MARKETS.map((m) => <option key={m.iso} value={m.iso}>{m.flag} {m.ar} +{m.cc}</option>)}
    </select>
  );
}

/** One line on a card: which country its people are in, and how many are from the picked one. */
export function CountryTag({ list, sel }: { list: WithCountries; sel: CountrySel }) {
  if (!list.country) return null;
  const n = sel !== "all" && sel !== "none" && sel !== list.country ? list.countries?.[sel] ?? 0 : 0;
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-muted-foreground">
      {flagOf(list.country)} {nameOf(list.country)}{n ? ` · ${n.toLocaleString("ar-SA")} من ${nameOf(sel)}` : ""}
    </span>
  );
}
