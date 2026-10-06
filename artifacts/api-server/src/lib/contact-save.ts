// ── Saving WhatsApp numbers, and checking them ────────────────────
// Shared by the number lists and the email import, so a number saved from
// either door lands the same way: de-duplicated against the list and the
// account's other lists, under the company's name, in one list however large
// the file, and checked against WhatsApp in the background when the number
// is linked.

import { and, eq, inArray, ne } from "drizzle-orm";
import { db, contactGroupsTable, contactsTable } from "@workspace/db";
import { checkNumbers, getStatus } from "./whatsapp";
import { canonical, inOtherLists } from "./dedupe";
import { logger } from "./logger";

const INSERT_BATCH = 500;

export interface SaveResult {
  added: number;
  /** Already in the list. */
  existing: number;
  /** Already in another of the account's lists, and so not added (unless allowed). */
  inOtherLists: number;
  otherListNames: string[];
  autoSplit: boolean;
  groups: Array<{ id: number; name: string; count: number }>;
}

async function insertAll(groupId: number, entries: Array<{ phone: string; name: string | null }>, status = "active") {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    // The unique index is the last word: two imports racing into one list
    // cannot both add the same number.
    await db.insert(contactsTable).values(entries.slice(i, i + INSERT_BATCH)
      .map(({ phone, name }) => ({ groupId, phone, name: name || null, status }))).onConflictDoNothing();
  }
}

/**
 * Save into a list. Numbers already in it are skipped; a name is filled in
 * where the list had the number without one. Past LIST_SIZE the rest goes
 * into numbered sister lists.
 */
export async function saveToGroup(
  userId: number, groupId: number, entries: Array<{ phone: string; name: string | null }>,
  /** status: "pending" for numbers WhatsApp has yet to confirm — no campaign sends to them until it does. */
  opts: { allowOtherLists?: boolean; status?: "active" | "pending" } = {},
): Promise<SaveResult> {
  const [group] = await db.select().from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId))).limit(1);
  if (!group) throw new Error("القائمة غير موجودة");

  // Compared by the international form, so 0501234567 in the list and
  // 971501234567 in the file are one number.
  const existing = await db.select({ id: contactsTable.id, phone: contactsTable.phone, name: contactsTable.name })
    .from(contactsTable).where(eq(contactsTable.groupId, groupId));
  const have = new Map(existing.map((e) => [canonical(e.phone), e]));
  let fresh = entries.filter((e) => !have.has(canonical(e.phone)));

  // A number already in another list is not added again unless the owner
  // says so — the same company in two lists gets every campaign twice.
  let skippedOther = 0;
  const otherNames = new Set<string>();
  if (!opts.allowOtherLists && fresh.length) {
    const elsewhere = await inOtherLists(userId, fresh.map((e) => canonical(e.phone)), groupId);
    if (elsewhere.size) {
      fresh = fresh.filter((e) => { const where = elsewhere.get(canonical(e.phone)); if (where === undefined) return true; skippedOther++; otherNames.add(where); return false; });
    }
  }
  const extra = { inOtherLists: skippedOther, otherListNames: [...otherNames].slice(0, 10) };
  const named = entries.filter((e) => e.name && have.get(canonical(e.phone)) && !have.get(canonical(e.phone))!.name);
  for (const e of named) await db.update(contactsTable).set({ name: e.name }).where(eq(contactsTable.id, have.get(canonical(e.phone))!.id));

  // One list, whatever its size: the owner keeps a file as one list, and a
  // list split into "- 1", "- 2" … scattered it across the page and out of
  // its folder.
  await insertAll(groupId, fresh, opts.status ?? "active");
  return { added: fresh.length, existing: entries.length - fresh.length - skippedOther, ...extra, autoSplit: false, groups: [{ id: groupId, name: group.name, count: existing.length + fresh.length }] };
}

/** A new list, named after the file, and the numbers in it. */
export async function saveToNewGroup(userId: number, name: string, description: string | null, entries: Array<{ phone: string; name: string | null }>, opts: { allowOtherLists?: boolean; folderId?: number | null; status?: "active" | "pending" } = {}): Promise<SaveResult> {
  const [g] = await db.insert(contactGroupsTable).values({ userId, name: name.slice(0, 240) || "قائمة جديدة", description, folderId: opts.folderId ?? null }).returning();
  const r = await saveToGroup(userId, g!.id, entries, opts);
  // Everything in the file was already elsewhere: an empty list helps nobody.
  if (r.added === 0) { await db.delete(contactGroupsTable).where(eq(contactGroupsTable.id, g!.id)); r.groups = []; }
  return r;
}

export interface ValidateResult { total: number; valid: number; invalid: number; unknown: number; invalidPhones: string[] }

/**
 * Ask WhatsApp which numbers in a list are real. Dead ones are parked as
 * `invalid` (never deleted); one that resolves again is revived.
 */
export async function validateGroup(userId: number, groupId: number, opts: { prune?: boolean } = {}): Promise<ValidateResult> {
  const rows = await db.select({ id: contactsTable.id, phone: contactsTable.phone })
    .from(contactsTable).where(eq(contactsTable.groupId, groupId));
  if (rows.length === 0) return { total: 0, valid: 0, invalid: 0, unknown: 0, invalidPhones: [] };

  const byPhone = new Map<string, number[]>();
  for (const r of rows) byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), r.id]);
  const results = await checkNumbers(userId, [...byPhone.keys()]);

  const invalidIds: number[] = [], validIds: number[] = [], invalidPhones: string[] = [];
  let unknown = 0;
  for (const r of results) {
    const ids = byPhone.get(r.phone) ?? [];
    if (r.exists === null) { unknown += ids.length; continue; }
    if (r.exists) validIds.push(...ids);
    else { invalidIds.push(...ids); invalidPhones.push(r.phone); }
  }
  for (let i = 0; i < invalidIds.length; i += 1000) {
    // A list is for WhatsApp: after an import, a number WhatsApp says it does
    // not know is removed rather than kept as a row nobody can message.
    if (opts.prune) await db.delete(contactsTable).where(inArray(contactsTable.id, invalidIds.slice(i, i + 1000)));
    else await db.update(contactsTable).set({ status: "invalid" }).where(inArray(contactsTable.id, invalidIds.slice(i, i + 1000)));
  }
  for (let i = 0; i < validIds.length; i += 1000) {
    await db.update(contactsTable).set({ status: "active" })
      .where(and(inArray(contactsTable.id, validIds.slice(i, i + 1000)), ne(contactsTable.status, "active")));
  }
  logger.info({ groupId, userId, total: rows.length, valid: validIds.length, invalid: invalidIds.length, unknown }, "list validated");
  return { total: rows.length, valid: validIds.length, invalid: invalidIds.length, unknown, invalidPhones: invalidPhones.slice(0, 100) };
}

/**
 * Check freshly imported lists against WhatsApp without holding the upload
 * open. Returns whether it started: only when the number is linked.
 */
export function validateInBackground(userId: number, groupIds: number[]): boolean {
  if (!groupIds.length || !getStatus(userId)?.connected) return false;
  void (async () => {
    for (const id of groupIds) {
      await validateGroup(userId, id, { prune: true }).catch((err) =>
        logger.warn({ userId, groupId: id, err: String(err?.message ?? err) }, "background validation failed"));
    }
  })();
  return true;
}


/**
 * Every list of this account with numbers still waiting for WhatsApp's word —
 * an import made while the line was down — checked now, and what WhatsApp
 * does not know removed. Run on every (re)connect.
 */
export async function validatePending(userId: number) {
  const groups = await db.selectDistinct({ id: contactsTable.groupId }).from(contactsTable)
    .innerJoin(contactGroupsTable, eq(contactGroupsTable.id, contactsTable.groupId))
    .where(and(eq(contactGroupsTable.userId, userId), eq(contactsTable.status, "pending")));
  for (const g of groups) await validateGroup(userId, g.id, { prune: true }).catch((err) => logger.warn({ userId, groupId: g.id, err: String(err?.message ?? err) }, "pending validation failed"));
  return groups.length;
}
