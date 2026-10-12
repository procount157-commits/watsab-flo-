// ── سالم keeps the WhatsApp lists ─────────────────────────────────
// Two jobs the owner asked for by name. One: a list must never carry
// someone who asked not to be written to — a stop-button tap, a typed
// «إيقاف», a refusal the employee closed on. Those are taken out of every
// list the moment the keeper runs, so no campaign reaches them by accident
// and no hand has to remember. Two: a lead who arrived from a Meta ad is
// sorted into a list named after the ad, with the company or person the
// account saved them under, so the owner sees at a glance who the «Clover
// set» ad brought and can retarget that list on its own.
//
// Every act is a receipt under the intake role, and the round reports to
// the manager only when it did something.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, contactsTable, contactGroupsTable, leadSourcesTable, unsubscribedPhonesTable } from "@workspace/db";
import { saveToGroup } from "./contact-save";
import { say } from "./agent-comms";
import { receipt } from "./graph/receipts";
import { logger } from "./logger";

export const KEEPER_ROLE = "intake";

/** Who must not be on any list: opted out, or closed as not interested / complained. */
async function doNotWrite(userId: number): Promise<Set<string>> {
  const [out, cold] = await Promise.all([
    db.select({ phone: unsubscribedPhonesTable.phone }).from(unsubscribedPhonesTable).where(eq(unsubscribedPhonesTable.userId, userId)),
    db.select({ phone: leadSourcesTable.phone }).from(leadSourcesTable).where(and(eq(leadSourcesTable.userId, userId), inArray(leadSourcesTable.lastIntent, ["opt_out", "not_interested", "complaint"]))),
  ]);
  return new Set([...out, ...cold].map((r) => r.phone));
}

/** Take the do-not-write numbers out of every list of the account. They stay in the records. */
export async function cleanLists(userId: number): Promise<{ removed: number; lists: number }> {
  const phones = [...(await doNotWrite(userId))];
  if (!phones.length) return { removed: 0, lists: 0 };
  const groups = await db.select({ id: contactGroupsTable.id }).from(contactGroupsTable).where(eq(contactGroupsTable.userId, userId));
  if (!groups.length) return { removed: 0, lists: 0 };
  const gone = await db.delete(contactsTable)
    .where(and(inArray(contactsTable.groupId, groups.map((g) => g.id)), inArray(contactsTable.phone, phones)))
    .returning({ phone: contactsTable.phone, groupId: contactsTable.groupId });
  const lists = new Set(gone.map((g) => g.groupId)).size;
  if (gone.length) receipt({ userId, node: KEEPER_ROLE, action: "list.clean", evidence: { removed: gone.length, lists }, why: `أخرج ${gone.length} رقماً طلبوا الإيقاف أو رفضوا من ${lists} قائمة` });
  return { removed: gone.length, lists };
}

/** Each ad's leads into a list named after it — «من إعلان: <title>» — under the name they are saved with. */
export async function fileAdLeads(userId: number): Promise<{ filed: number; ads: number }> {
  const leads = await db.select({ phone: leadSourcesTable.phone, title: leadSourcesTable.adTitle, sourceId: leadSourcesTable.adSourceId })
    .from(leadSourcesTable).where(and(eq(leadSourcesTable.userId, userId), eq(leadSourcesTable.source, "ad")));
  if (!leads.length) return { filed: 0, ads: 0 };
  const skip = await doNotWrite(userId);
  const byAd = new Map<string, string[]>();
  for (const l of leads) {
    if (skip.has(l.phone)) continue;
    const key = (l.title ?? l.sourceId ?? "إعلان").trim().slice(0, 80);
    byAd.set(key, [...(byAd.get(key) ?? []), l.phone]);
  }
  let filed = 0;
  for (const [title, phones] of byAd) {
    const name = `من إعلان: ${title}`;
    let [g] = await db.select({ id: contactGroupsTable.id }).from(contactGroupsTable).where(and(eq(contactGroupsTable.userId, userId), eq(contactGroupsTable.name, name))).limit(1);
    if (!g) [g] = await db.insert(contactGroupsTable).values({ userId, name, description: "عملاء وصلوا من إعلان ميتا — يرتبها سالم تلقائياً" }).returning({ id: contactGroupsTable.id });
    const have = new Set((await db.select({ phone: contactsTable.phone }).from(contactsTable).where(eq(contactsTable.groupId, g!.id))).map((r) => r.phone));
    const fresh = phones.filter((p) => !have.has(p));
    if (!fresh.length) continue;
    // The name they were saved under elsewhere, if any.
    const named = await db.execute<{ phone: string; name: string | null }>(sql`SELECT DISTINCT ON (phone) phone, name FROM contacts WHERE phone = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(fresh)}::jsonb))) AND name IS NOT NULL AND name <> '' ORDER BY phone, id DESC`);
    const names = new Map(named.rows.map((r) => [r.phone, r.name]));
    const r = await saveToGroup(userId, g!.id, fresh.map((p) => ({ phone: p, name: names.get(p) ?? null })), { allowOtherLists: true }).catch(() => null);
    const n = r?.added ?? 0;
    filed += n;
    if (n) receipt({ userId, node: KEEPER_ROLE, action: "list.file_ad", evidence: { ad: title, added: n }, why: `أضاف ${n} من إعلان «${title}» إلى قائمته` });
  }
  return { filed, ads: byAd.size };
}

export async function keeperRound(userId: number) {
  const [c, f] = [await cleanLists(userId), await fileAdLeads(userId)];
  if (c.removed || f.filed) {
    await say({ userId, fromRole: KEEPER_ROLE, toRole: "chief", kind: "report",
      body: [c.removed ? `أخرجت ${c.removed} رقماً طلبوا الإيقاف أو رفضوا من ${c.lists} قائمة.` : "", f.filed ? `رتّبت ${f.filed} عميلاً من ${f.ads} إعلان في قوائمهم.` : ""].filter(Boolean).join(" ") }).catch(() => {});
  }
  return { ...c, ...f };
}

let timer: NodeJS.Timeout | null = null;
export function startListKeeper() {
  if (timer) return;
  const run = async () => {
    const users = await db.execute<{ user_id: number }>(sql`SELECT user_id FROM business_profile WHERE NOT team_paused`).catch(() => ({ rows: [] as Array<{ user_id: number }> }));
    for (const u of users.rows) await keeperRound(Number(u.user_id)).catch((err) => logger.warn({ userId: u.user_id, err: String(err?.message ?? err) }, "جولة سالم فشلت"));
  };
  setTimeout(() => void run(), 4 * 60_000).unref();
  timer = setInterval(() => void run(), 2 * 3_600_000);
  timer.unref();
}
