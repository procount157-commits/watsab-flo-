// ── Which country a list is ───────────────────────────────────────
// Both sections — WhatsApp number lists and email lists — are filtered by
// country, and a list has no country of its own: it is whatever its people
// are. A WhatsApp number says it by its code; an email address by its phone
// when it has one, then by its domain (.ae, .sa…), then by its city.
//
// The answer per list is a count per country, so a UAE list with a few Saudi
// numbers is still a UAE list, and a mixed list shows under each country it
// really holds.

import { sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";

/** The markets the owner works: the Gulf, then Iraq, Egypt and Sudan. */
export const MARKETS = [
  { iso: "AE", cc: "971", tld: "ae", places: "uae|emirates|dubai|abu ?dhabi|sharjah|ajman|fujairah|ras al ?khaimah|umm al ?quwain|al ain|الامارات|الإمارات|دبي|ابوظبي|أبوظبي|ابو ظبي|أبو ظبي|الشارقة|الشارقه|عجمان|الفجيرة|الفجيره|رأس الخيمة|راس الخيمه|ام القيوين|أم القيوين|العين" },
  { iso: "SA", cc: "966", tld: "sa", places: "saudi|ksa|riyadh|jeddah|jiddah|dammam|khobar|makkah|mecca|madinah|medina|taif|tabuk|abha|qassim|buraidah|hail|jazan|najran|yanbu|jubail|ahsa|السعودية|السعوديه|الرياض|جدة|جده|الدمام|الخبر|مكة|مكه|المدينة المنورة|الطائف|تبوك|أبها|ابها|القصيم|بريدة|حائل|جازان|نجران|ينبع|الجبيل|الأحساء|الاحساء" },
  { iso: "QA", cc: "974", tld: "qa", places: "qatar|doha|al wakrah|al rayyan|lusail|قطر|الدوحة|الدوحه|الوكرة|الريان|لوسيل" },
  { iso: "KW", cc: "965", tld: "kw", places: "kuwait|hawalli|salmiya|farwaniya|jahra|ahmadi|الكويت|حولي|السالمية|الفروانية|الجهراء|الأحمدي" },
  { iso: "BH", cc: "973", tld: "bh", places: "bahrain|manama|muharraq|riffa|البحرين|المنامة|المنامه|المحرق|الرفاع" },
  { iso: "OM", cc: "968", tld: "om", places: "oman|muscat|salalah|sohar|nizwa|seeb|عُمان|سلطنة عمان|مسقط|صلالة|صحار|نزوى|السيب" },
  { iso: "IQ", cc: "964", tld: "iq", places: "iraq|baghdad|basra|erbil|mosul|najaf|karbala|sulaymaniyah|kirkuk|العراق|بغداد|البصرة|أربيل|اربيل|الموصل|النجف|كربلاء|السليمانية|كركوك" },
  { iso: "EG", cc: "20",  tld: "eg", places: "egypt|cairo|giza|alexandria|mansoura|tanta|مصر|القاهرة|القاهره|الجيزة|الإسكندرية|الاسكندرية|المنصورة|طنطا" },
  { iso: "SD", cc: "249", tld: "sd", places: "sudan|khartoum|omdurman|port sudan|السودان|الخرطوم|أم درمان|ام درمان|بورتسودان|بحري" },
] as const;

/** The country of a phone, by its international code. */
function phoneCountry(phone: SQL): SQL {
  const d = sql`regexp_replace(regexp_replace(coalesce(${phone}, ''), '\\D', '', 'g'), '^00', '')`;
  return sql`CASE ${sql.join(MARKETS.map((m) => sql`WHEN ${d} LIKE ${m.cc + "%"} THEN ${m.iso}`), sql` `)} END`;
}

/** The country of an email contact: its phone, then its domain, then its city. */
function emailCountry(): SQL {
  const byTld = MARKETS.map((m) => sql`WHEN c.email ~* ${`\\.${m.tld}$`} THEN ${m.iso}`);
  const byCity = MARKETS.map((m) => sql`WHEN c.city ~* ${m.places} THEN ${m.iso}`);
  return sql`coalesce(${phoneCountry(sql`c.phone`)}, CASE ${sql.join([...byTld, ...byCity], sql` `)} END)`;
}

export type CountryCounts = Record<string, number>;

/** Per list: how many of its people are in each country ("other" for the rest). */
export async function listCountries(kind: "wa" | "email", userId: number): Promise<Map<number, CountryCounts>> {
  const r = kind === "wa"
    ? await db.execute(sql`
        SELECT c.group_id AS "listId", ${phoneCountry(sql`c.phone`)} AS iso, count(*)::int AS n
        FROM contacts c JOIN contact_groups g ON g.id = c.group_id
        WHERE g.user_id = ${userId}
        GROUP BY 1, 2`)
    : await db.execute(sql`
        SELECT m.list_id AS "listId", ${emailCountry()} AS iso, count(*)::int AS n
        FROM email_list_members m
        JOIN email_lists l ON l.id = m.list_id
        JOIN email_contacts c ON c.id = m.contact_id
        WHERE l.user_id = ${userId}
        GROUP BY 1, 2`);
  const out = new Map<number, CountryCounts>();
  for (const row of r.rows as Array<{ listId: number; iso: string | null; n: number }>) {
    const m = out.get(row.listId) ?? {};
    m[row.iso ?? "other"] = (m[row.iso ?? "other"] ?? 0) + Number(row.n);
    out.set(row.listId, m);
  }
  return out;
}

/** The country most of a list's people are in, or null when none is known. */
export function mainCountry(counts: CountryCounts | undefined): string | null {
  let best: string | null = null;
  for (const [iso, n] of Object.entries(counts ?? {})) {
    if (iso !== "other" && n > 0 && (!best || n > counts![best]!)) best = iso;
  }
  return best;
}
