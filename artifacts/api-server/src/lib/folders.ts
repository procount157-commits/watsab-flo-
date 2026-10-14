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
