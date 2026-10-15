// ── Which folder a list belongs in ───────────────────────────────
// A list goes into the folder for its sector, and the owner's own folder
// wins over a new one: a folder the owner called «عقارات الامارات» is the
// real estate folder, and making a second one called «عقارات» beside it is
// what scattered the lists before. A folder is created only when there is
// no folder for that sector at all.

import { and, eq } from "drizzle-orm";
import { db, listFoldersTable } from "@workspace/db";
import { classifySector } from "./email/sector";

/** The sector most of these company names are in — a majority of enough of them to mean it. */
export function majoritySector(names: Array<string | null | undefined>, min = 5): string | null {
  const tally = new Map<string, number>();
  let seen = 0;
  for (const n of names) {
    if (!n) continue;
    seen++;
    const s = classifySector({ company: n });
    if (s) tally.set(s, (tally.get(s) ?? 0) + 1);
  }
  const top = [...tally].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= min && top[1] >= seen * 0.4 ? top[0] : null;
}

/** A list's sector: its own name or file name first, then what its companies are. */
export function listSector(listName: string, fileName: string | null, companyNames: Array<string | null | undefined> = []): string | null {
  return classifySector({ company: listName, hint: fileName ?? "" }) ?? majoritySector(companyNames);
}

/**
 * The folder for a sector: an existing folder whose name is that sector (or
 * reads as it), else a new one named after it. Null when the sector is.
 */
export async function folderForSector(userId: number, kind: "wa" | "email", sector: string | null, create = true): Promise<{ id: number; name: string } | null> {
  if (!sector) return null;
  const folders = await db.select().from(listFoldersTable).where(and(eq(listFoldersTable.userId, userId), eq(listFoldersTable.kind, kind)));
  const hit = folders.find((f) => f.name === sector) ?? folders.find((f) => classifySector({ company: f.name }) === sector);
  if (hit) return { id: hit.id, name: hit.name };
  if (!create) return null;
  const [f] = await db.insert(listFoldersTable).values({ userId, kind, name: sector }).returning();
  return { id: f!.id, name: f!.name };
}

/**
 * مجلد البريد باسمه كما سمّاه صاحب العمل: الموجود إن وُجد، وإلا مجلد
 * قطاعه إن كان له مجلد، وإلا يُنشأ باسمه هو — لا باسم القطاع.
 */
export async function ownFolder(userId: number, name: string, sector: string | null): Promise<number> {
  const folders = await db.select().from(listFoldersTable).where(and(eq(listFoldersTable.userId, userId), eq(listFoldersTable.kind, "email")));
  const hit = folders.find((f) => f.name.trim() === name.trim());
  if (hit) return hit.id;
  const bySector = sector ? await folderForSector(userId, "email", sector, false) : null;
  if (bySector) return bySector.id;
  const [f] = await db.insert(listFoldersTable).values({ userId, kind: "email", name: name.trim() }).returning();
  return f!.id;
}

// ── Every WhatsApp list in a folder, without the owner filing it ──
// The owner: «أريد أن أرفع البيانات فقط، وهو يرتبها في مجلدات». Lists came
// from six places — a file upload, the data desk's sorting («مفروز — قطاع»),
// numbers pulled out of WhatsApp chats, an ad's leads, a pasted list, a
// campaign — and only the file upload looked for a folder, and only by a
// business sector. A jewellery shop's customer lists have no sector, so 35
// lists and 12,991 numbers sat in no folder at all.
//
// So the folder is decided from what the list IS, in this order:
//   1. its sector (the data desk's segment, or «مفروز — X», or its name or
//      its companies) → the sector's folder, the owner's own if one reads so;
//   2. where it came from: an ad's leads, numbers pulled from WhatsApp;
//   3. a batch: «اسم - 1» … «اسم - 13» share the folder «اسم»;
//   4. else «قوائم أخرى».
// A list the owner already put in a folder is never moved.

import { contactGroupsTable } from "@workspace/db";
import { isNull, sql } from "drizzle-orm";

export const FROM_ADS = "عملاء الإعلانات";
export const FROM_WHATSAPP = "مستخرج من واتساب";
export const OTHER = "قوائم أخرى";

/** «مستخرج من واتساب - 7» → «مستخرج من واتساب»; «Dubai list (2) 2026-10-11» → «Dubai list». Pure. */
export function batchName(name: string): string {
  return name
    .replace(/\s*\d{4}-\d{2}-\d{2}.*$/u, "")
    .replace(/\s*\d{1,2}\/\d{1,2}\/\d{2,4}.*$/u, "")
    .replace(/\s*[-–—_#]\s*\d+\s*$/u, "")
    .replace(/\s*\(\d+\)\s*$/u, "")
    .replace(/\s+\d+\s*$/u, "")
    .trim();
}

export type FolderPick = { kind: "sector" | "named"; name: string };

/**
 * Which folder a list belongs in. `siblings` is how many unfiled lists share
 * its batch name — a batch of one is not a folder of its own. Pure.
 */
export function folderFor(list: { name: string; segment?: string | null }, siblings = 1, memberSector: string | null = null): FolderPick {
  const name = list.name.trim();
  const sorted = /^مفروز\s*[—-]\s*(.+)$/u.exec(name)?.[1]?.trim();
  // What the data desk decided first; then where the list came from (an
  // ad's name says «إعلان» and is not the advertising sector); then a guess.
  const decided = list.segment?.trim() || sorted;
  if (decided) return { kind: "sector", name: decided };
  if (/^من إعلان\s*:/u.test(name) || /\bmeta\b|facebook|instagram|\bads?\b|ميتا/iu.test(name)) return { kind: "named", name: FROM_ADS };
  if (/^مستخرج من واتساب/u.test(name)) return { kind: "named", name: FROM_WHATSAPP };
  const sector = listSector(name, null) || memberSector;
  if (sector) return { kind: "sector", name: sector };
  const batch = batchName(name);
  if (batch && siblings >= 2) return { kind: "named", name: batch };
  return { kind: "named", name: OTHER };
}

/** A folder by its exact name (the owner's, if it exists), else a new one. */
async function namedFolder(userId: number, name: string): Promise<number> {
  const [hit] = await db.select().from(listFoldersTable)
    .where(and(eq(listFoldersTable.userId, userId), eq(listFoldersTable.kind, "wa"), eq(listFoldersTable.name, name))).limit(1);
  if (hit) return hit.id;
  const [f] = await db.insert(listFoldersTable).values({ userId, kind: "wa", name }).returning();
  return f!.id;
}

/** Files every unfiled WhatsApp list of one account (or all accounts). Returns what went where. */
export async function fileUnfiledLists(userId?: number): Promise<Array<{ list: string; folder: string }>> {
  const lists = await db.select({ id: contactGroupsTable.id, userId: contactGroupsTable.userId, name: contactGroupsTable.name, segment: contactGroupsTable.segment })
    .from(contactGroupsTable)
    .where(userId ? and(eq(contactGroupsTable.userId, userId), isNull(contactGroupsTable.folderId)) : isNull(contactGroupsTable.folderId));
  const batches = new Map<string, number>();
  for (const l of lists) { const k = `${l.userId}:${batchName(l.name)}`; batches.set(k, (batches.get(k) ?? 0) + 1); }
  const out: Array<{ list: string; folder: string }> = [];
  for (const l of lists) {
    if (!l.userId) continue;
    // The sector its numbers were classified into, when most of them share one.
    let memberSector: string | null = null;
    if (!l.segment && !/^مفروز/u.test(l.name)) {
      const r = await db.execute<{ s: string; n: number; t: number }>(sql`
        SELECT sector AS s, count(*)::int AS n, (SELECT count(*)::int FROM contacts WHERE group_id = ${l.id}) AS t
        FROM contacts WHERE group_id = ${l.id} AND sector IS NOT NULL GROUP BY sector ORDER BY 2 DESC LIMIT 1`).catch(() => ({ rows: [] as any[] }));
      const top = r.rows[0];
      if (top && Number(top.n) >= 5 && Number(top.n) >= Number(top.t) * 0.5) memberSector = top.s;
    }
    const pick = folderFor(l, batches.get(`${l.userId}:${batchName(l.name)}`) ?? 1, memberSector);
    const folderId = pick.kind === "sector"
      ? (await folderForSector(l.userId, "wa", pick.name))!.id
      : await namedFolder(l.userId, pick.name);
    await db.update(contactGroupsTable).set({ folderId }).where(and(eq(contactGroupsTable.id, l.id), isNull(contactGroupsTable.folderId)));
    out.push({ list: l.name, folder: pick.name });
  }
  return out;
}

let filing: NodeJS.Timeout | null = null;
/** Every ten minutes, and a first pass a minute after start: whatever list was made by any path is filed. */
export function startListFiling(): void {
  if (filing) return;
  const run = () => fileUnfiledLists().catch(() => []);
  setTimeout(() => void run(), 60_000).unref();
  filing = setInterval(() => void run(), 10 * 60_000);
  filing.unref();
}
