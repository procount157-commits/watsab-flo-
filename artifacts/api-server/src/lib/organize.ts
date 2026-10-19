// ── One folder per sector, one list per file, each contact once ──
// The owner: «ممنوع منعاً باتاً التكرار»، و«كل المقاولات ملفٌ واحد وداخله
// ملفاتٌ مقسّمة». Uploads made lists by file, the data desk made lists by
// sector («مفروز — قطاع»), the email autopilot copied a list under a second
// name — so one address sat in two lists (14,379 addresses, 28,626 places)
// and a sector's companies were spread over many folders.
//
// The order, for WhatsApp numbers and email addresses alike:
//   · the folder is the contact's sector (the owner's own folder for that
//     sector when there is one);
//   · inside it, one list per emirate («مقاولات — دبي»);
//   · a contact is in exactly one list — a number repeated is deleted, an
//     address in two lists stays only in its own.
// A contact whose sector is not known stays where it is (Floret's customers
// pulled from WhatsApp are people, not companies), and a list a campaign is
// sending to is never touched.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, contactGroupsTable, contactsTable, emailListsTable, emailListMembersTable } from "@workspace/db";
import { folderForSector, fileUnfiledLists, AUTOPILOT_MARK } from "./folders";
import { classifySector, UNCLASSIFIED } from "./email/sector";
import { logger } from "./logger";

/** Arabic read as Latin-1 on an old upload («Ø§ÙÙÙ») back to Arabic. Pure. */
export function fixMojibake(s: string): string {
  if (!/[ØÙÚÛ][\u0080-ÿ]/.test(s)) return s;
  const back = Buffer.from(s, "latin1").toString("utf8");
  return back.includes("�") ? s : back;
}

/** A source's display name: «ملف: 00-الكل.csv» → «00-الكل». Pure. */
export function sourceName(raw: string | null | undefined, fallback: string): string {
  let s = fixMojibake(String(raw ?? "").trim().replace(/^ملف:\s*/u, "")).replace(/\.(csv|xlsx?|txt)$/iu, "").trim();
  if (!s || s === "inbound") s = fallback;
  return s.slice(0, 200);
}

/**
 * The source of a list's contacts, from the list's own name: a list the data
 * desk made («مفروز — مقاولات») came from other lists; a sorted file list
 * («UAE-real-estate — عقارات ووساطة عقارية») is its file («UAE-real-estate»);
 * a WhatsApp list split in parts («دليل دبي - 3») is its file. Pure.
 */
export function listSource(name: string): string {
  const n = fixMojibake(name.trim());
  if (/^مفروز\s*[—-]/u.test(n)) return "من قوائم أخرى";
  return n.replace(/\s+—\s+.+$/u, "").replace(/\s*[-–]\s*\d+\s*$/u, "").trim() || n;
}

// ── Inside a sector folder: one list per emirate ──────────────────
// Lists named after their file ended up called «00-الكل», «…-ALL»,
// «…-موسّع» — names that say nothing. The owner: «لا أريد الكل، أريد
// تصنيفها». The file is not a classification; the emirate is, and 99% of
// the companies carry their city.
export const EMIRATES = ["دبي", "أبوظبي", "الشارقة", "عجمان", "رأس الخيمة", "الفجيرة", "أم القيوين"] as const;
export const NO_EMIRATE = "إمارة غير محددة";

const EMIRATE_WORDS: Array<[RegExp, (typeof EMIRATES)[number]]> = [
  [/dubai|دبي|deira|ديرة|bur ?dubai|jebel ?ali|جبل علي|business bay|الخليج التجاري|jumeirah|جميرا|al ?quoz|القوز|marina|مرسى|karama|الكرامة|al ?barsha|البرشاء|silicon|daz|healthcare city|international city|المدينة العالمية/i, "دبي"],
  [/abu ?dhabi|abudhabi|أبو ?ظبي|ابو ?ظبي|ابوظبي|أبوظبي|al ?ain|العين|mussafah|مصفح|الظفرة|dhafra|ruwais|الرويس|khalifa city|مدينة خليفة|بني ياس|baniyas/i, "أبوظبي"],
  [/sharjah|الشارقة|khor ?fakkan|خور ?فكان|kalba|كلباء|dhaid|الذيد|الحمرية|hamriyah|البطايح|batayih|مليحة|المدام|madam/i, "الشارقة"],
  [/ajman|عجمان/i, "عجمان"],
  [/ras ?al[- ]?khaimah|رأس ?الخيمة|راس ?الخيمة|\brak\b/i, "رأس الخيمة"],
  [/fujairah|الفجيرة|dibba|دبا|masafi|مسافي/i, "الفجيرة"],
  [/umm ?al[- ]?qu?a?i?w(a|ai)in|أم ?القيوين|ام ?القيوين/i, "أم القيوين"],
];

/** The emirate of a city or district, in Arabic or English. Pure. */
export function emirateOf(city: string | null | undefined): string {
  const c = String(city ?? "").trim();
  if (!c) return NO_EMIRATE;
  for (const [re, e] of EMIRATE_WORDS) if (re.test(c)) return e;
  return NO_EMIRATE;
}

/** A list whose name says nothing of what is in it («00-الكل», «…-ALL», «…-موسّع»). Pure. */
export const GENERIC_LIST = /الكل|\ball\b|موس[ّ]?ع|يحتاج|ليست|عام$|^\d+[-_ ]/iu;

/**
 * The sector of a contact the data desk left unclassified, when it sits in a
 * list with a name that says nothing: its own name once more, else
 * «غير مصنّف». Elsewhere (a shop's customers) it stays unsorted. Pure.
 */
export function fallbackSector(listName: string, name: string | null | undefined, industry?: string | null): string | null {
  if (!GENERIC_LIST.test(fixMojibake(listName))) return null;
  return classifySector({ company: name ?? "", industry: industry ?? "" }) ?? UNCLASSIFIED;
}

export interface Placement { contactId: number; from: number; sector: string | null; source: string }
/** Where each contact goes: (sector, source) → one list. Contacts with no sector are left. Pure. */
export function plan(rows: Placement[]): Map<string, { sector: string; source: string; ids: number[] }> {
  const out = new Map<string, { sector: string; source: string; ids: number[] }>();
  for (const r of rows) {
    if (!r.sector) continue;
    const k = `${r.sector}\u0000${r.source}`;
    const b = out.get(k) ?? { sector: r.sector, source: r.source, ids: [] };
    b.ids.push(r.contactId);
    out.set(k, b);
  }
  return out;
}

/** Lists a campaign is sending to (or waiting to): they keep their contacts. */
async function busyWaLists(userId: number): Promise<Set<number>> {
  const r = await db.execute<{ id: number }>(sql`SELECT DISTINCT contact_group_id AS id FROM campaigns
    WHERE user_id = ${userId} AND contact_group_id IS NOT NULL AND status IN ('running','sending','scheduled','pending','queued')`);
  // The autopilot's lists are never rearranged: they are a test or a wave, on purpose.
  const auto = await db.execute<{ id: number }>(sql`SELECT id FROM contact_groups WHERE user_id = ${userId} AND coalesce(description, '') LIKE ${AUTOPILOT_MARK + "%"}`);
  return new Set([...r.rows, ...auto.rows].map((x) => Number(x.id)));
}

export interface OrganizeReport { channel: "whatsapp" | "email"; duplicatesRemoved: number; moved: number; listsMade: number; listsRemoved: number }

// ── WhatsApp ──────────────────────────────────────────────────────
export async function organizeWhatsapp(userId: number): Promise<OrganizeReport> {
  const busy = await busyWaLists(userId);

  // 1. A number once: of its copies, the one with a name and a sector, the oldest, stays.
  const dup = await db.execute<{ id: number }>(sql`
    SELECT id FROM (
      SELECT c.id, row_number() OVER (PARTITION BY c.phone ORDER BY (c.name IS NOT NULL) DESC, (c.sector IS NOT NULL) DESC, c.id) AS rn
      FROM contacts c JOIN contact_groups g ON g.id = c.group_id
      WHERE g.user_id = ${userId} AND coalesce(g.description, '') NOT LIKE ${AUTOPILOT_MARK + "%"}
    ) x WHERE rn > 1`);
  const dupIds = dup.rows.map((x) => Number(x.id));
  for (let i = 0; i < dupIds.length; i += 1000) await db.delete(contactsTable).where(inArray(contactsTable.id, dupIds.slice(i, i + 1000)));

  // 2. Each contact with a sector to the list of its sector and its file.
  const groups = await db.select().from(contactGroupsTable).where(eq(contactGroupsTable.userId, userId));
  const byId = new Map(groups.map((g) => [g.id, g]));
  const rows = (await db.execute<{ id: number; group_id: number; sector: string | null; phone: string | null; name: string | null }>(sql`
    SELECT c.id, c.group_id, c.sector, c.phone, c.name FROM contacts c JOIN contact_groups g ON g.id = c.group_id WHERE g.user_id = ${userId}`)).rows;
  // A number's emirate: the city of the same company in the email section
  // (both came from the same files; the number list keeps no city of its own).
  const cityByPhone = new Map((await db.execute<{ d: string; city: string }>(sql`
    SELECT regexp_replace(phone, '\D', '', 'g') AS d, city FROM email_contacts
    WHERE user_id = ${userId} AND nullif(phone, '') IS NOT NULL AND nullif(city, '') IS NOT NULL`)).rows.map((x) => [x.d, x.city] as const));
  // Numbers the data desk has not classified yet (it works in the background
  // and a restart cuts it short): read by their own name, here and now, and
  // the sector kept on the number. A list where most numbers are companies
  // sends the rest to «غير مصنف»; a list of people (a shop's customers) is
  // left as it is.
  const quick = new Map<number, string>();
  const byGroup = new Map<number, Array<{ id: number; s: string | null }>>();
  for (const r of rows) {
    if (r.sector || busy.has(Number(r.group_id))) continue;
    const g = byId.get(Number(r.group_id))!;
    if (g.segment) continue;
    const arr = byGroup.get(g.id) ?? [];
    arr.push({ id: Number(r.id), s: classifySector({ company: r.name ?? "" }) });
    byGroup.set(g.id, arr);
  }
  for (const [gid, arr] of byGroup) {
    const listName = fixMojibake(byId.get(gid)!.name);
    // A file named for its sector («الإمارات-متاجر-وتجزئة») gives that sector
    // to the numbers whose own names say nothing.
    const fileSector = classifySector({ company: listName });
    const known = arr.filter((x) => x.s).length;
    // A file's name counts only when some of its names are companies too: a
    // shop's customer list («عملاء المحل») is people, whatever it is called.
    const companies = (!!fileSector && known >= Math.max(3, arr.length * 0.05)) || known >= Math.max(5, arr.length * 0.3) || GENERIC_LIST.test(listName);
    if (!companies) continue;
    for (const x of arr) quick.set(x.id, x.s ?? fileSector ?? UNCLASSIFIED);
  }
  const bySector = new Map<string, number[]>();
  for (const [id, sec] of quick) if (sec !== UNCLASSIFIED) bySector.set(sec, [...(bySector.get(sec) ?? []), id]);
  for (const [sec, ids] of bySector) for (let i = 0; i < ids.length; i += 1000) {
    await db.update(contactsTable).set({ sector: sec, sectorBy: "own" } as any).where(inArray(contactsTable.id, ids.slice(i, i + 1000)));
  }

  const placements: Placement[] = rows.filter((r) => !busy.has(Number(r.group_id))).map((r) => {
    const g = byId.get(Number(r.group_id))!;
    return { contactId: Number(r.id), from: g.id, sector: r.sector ?? g.segment ?? quick.get(Number(r.id)) ?? fallbackSector(g.name, r.name), source: emirateOf(cityByPhone.get(String(r.phone ?? "").replace(/\D/g, ""))) };
  });

  let moved = 0, made = 0;
  const fromOf = new Map(placements.map((p) => [p.contactId, p.from]));
  for (const b of plan(placements).values()) {
    const folder = await folderForSector(userId, "wa", b.sector);
    // The list for this sector and file: one already arranged, else a new one.
    let target = groups.find((g) => g.folderId === folder?.id && g.description === `مرتّبة: ${b.source}`);
    if (!target) {
      [target] = await db.insert(contactGroupsTable).values({ userId, name: `${b.sector} — ${b.source}`, description: `مرتّبة: ${b.source}`, segment: b.sector, folderId: folder?.id ?? null } as any).returning();
      groups.push(target!); made++;
    }
    const ids = b.ids.filter((id) => fromOf.get(id) !== target!.id);
    for (let i = 0; i < ids.length; i += 1000) {
      const r = await db.update(contactsTable).set({ groupId: target!.id }).where(inArray(contactsTable.id, ids.slice(i, i + 1000))).returning({ id: contactsTable.id });
      moved += r.length;
    }
  }

  // 3. Lists left empty go, unless a campaign is sending to them. A finished
  //    or paused campaign only loses the link (the key is ON DELETE SET NULL).
  const named = busy;
  const empty = (await db.execute<{ id: number }>(sql`
    SELECT g.id FROM contact_groups g WHERE g.user_id = ${userId} AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.group_id = g.id)`)).rows.map((x) => Number(x.id)).filter((id) => !named.has(id));
  if (empty.length) await db.delete(contactGroupsTable).where(inArray(contactGroupsTable.id, empty));
  await dropEmptyFolders(userId, "wa");

  return { channel: "whatsapp", duplicatesRemoved: dupIds.length, moved, listsMade: made, listsRemoved: empty.length };
}

// ── Email ─────────────────────────────────────────────────────────
export async function organizeEmail(userId: number): Promise<OrganizeReport> {
  // Every address in a top-level list, with its sector and the file it came from.
  const rows = (await db.execute<{ contact_id: number; list_id: number; list_name: string; sector: string | null; city: string | null; company: string | null; industry: string | null }>(sql`
    SELECT m.contact_id, m.list_id, l.name AS list_name, c.sector, c.city, c.company, c.industry
    FROM email_list_members m JOIN email_lists l ON l.id = m.list_id JOIN email_contacts c ON c.id = m.contact_id
    WHERE l.user_id = ${userId} AND l.parent_list_id IS NULL
    ORDER BY m.contact_id, l.id`)).rows;
  const lists = await db.select().from(emailListsTable).where(and(eq(emailListsTable.userId, userId), isNull(emailListsTable.parentListId)));

  // One place per address: its sector and its file; with no sector, the first list it is in.
  const seen = new Set<number>();
  const keepUnsorted: Array<{ contactId: number; listId: number }> = [];
  const placements: Placement[] = [];
  for (const r of rows) {
    const id = Number(r.contact_id);
    if (seen.has(id)) continue;
    seen.add(id);
    const sector = r.sector ?? fallbackSector(r.list_name, r.company, r.industry);
    if (sector) placements.push({ contactId: id, from: Number(r.list_id), sector, source: emirateOf(r.city) });
    else keepUnsorted.push({ contactId: id, listId: Number(r.list_id) });
  }

  let made = 0;
  const home = new Map<number, number>();   // contact → its one list
  for (const b of plan(placements).values()) {
    const folder = await folderForSector(userId, "email", b.sector);
    let target = lists.find((l) => l.folderId === folder?.id && l.description === `مرتّبة: ${b.source}`);
    if (!target) {
      [target] = await db.insert(emailListsTable).values({ userId, name: `${b.sector} — ${b.source}`, description: `مرتّبة: ${b.source}`, folderId: folder?.id ?? null }).returning();
      lists.push(target!); made++;
    }
    for (const id of b.ids) home.set(id, target!.id);
  }
  for (const k of keepUnsorted) home.set(k.contactId, k.listId);

  // Membership becomes exactly the home: added where missing, removed everywhere else.
  const pairs = [...home].map(([contactId, listId]) => ({ contactId, listId }));
  for (let i = 0; i < pairs.length; i += 1000) await db.insert(emailListMembersTable).values(pairs.slice(i, i + 1000)).onConflictDoNothing();
  const before = rows.length;
  await db.execute(sql`
    DELETE FROM email_list_members m USING email_lists l
    WHERE m.list_id = l.id AND l.user_id = ${userId} AND l.parent_list_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(${JSON.stringify(pairs.map((p) => ({ c: p.contactId, l: p.listId })))}::jsonb) AS h(c int, l int) WHERE h.c = m.contact_id AND h.l = m.list_id)`);
  const after = Number(((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM email_list_members m JOIN email_lists l ON l.id = m.list_id WHERE l.user_id = ${userId} AND l.parent_list_id IS NULL`)).rows[0] as any)?.n ?? 0);

  // Lists left empty go (their stage lists with them; missions keep their record).
  const empty = (await db.execute<{ id: number }>(sql`
    SELECT l.id FROM email_lists l WHERE l.user_id = ${userId} AND l.parent_list_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM email_list_members m WHERE m.list_id = l.id)`)).rows.map((x) => Number(x.id));
  if (empty.length) await db.delete(emailListsTable).where(inArray(emailListsTable.id, empty));
  await dropEmptyFolders(userId, "email");

  const moved = placements.filter((p) => home.get(p.contactId) !== p.from).length;
  void after;
  return { channel: "email", duplicatesRemoved: Math.max(0, before - home.size), moved, listsMade: made, listsRemoved: empty.length };
}

/** A folder with no list in it is not kept. */
async function dropEmptyFolders(userId: number, kind: "wa" | "email") {
  const usedBy = kind === "wa"
    ? sql`SELECT 1 FROM contact_groups g WHERE g.folder_id = f.id`
    : sql`SELECT 1 FROM email_lists l WHERE l.folder_id = f.id`;
  await db.execute(sql`DELETE FROM list_folders f WHERE f.user_id = ${userId} AND f.kind = ${kind} AND NOT EXISTS (${usedBy})`);
}

const running = new Set<number>();
const again = new Set<number>();

/**
 * Both channels for one account — after an upload, after the data desk, and
 * on the sweep. One run per account at a time: a call that comes while one
 * runs asks for one more pass after it, so nothing uploaded is missed.
 */
export async function organizeAccount(userId: number): Promise<OrganizeReport[]> {
  if (running.has(userId)) { again.add(userId); return []; }
  running.add(userId);
  try {
    let out = await organizeOnce(userId);
    while (again.delete(userId)) out = await organizeOnce(userId);
    return out;
  } finally { running.delete(userId); }
}

async function organizeOnce(userId: number): Promise<OrganizeReport[]> {
  const out: OrganizeReport[] = [];
  for (const f of [organizeWhatsapp, organizeEmail]) {
    try { out.push(await f(userId)); }
    catch (err: any) { logger.warn({ userId, err: String(err?.message ?? err) }, "ترتيب القوائم تعذّر"); }
  }
  logger.info({ userId, out }, "رُتّبت القوائم");
  return out;
}


let sweep: NodeJS.Timeout | null = null;
/** Every ten minutes, and a minute after start: every account arranged, then any list still in no folder filed. */
export function startOrganizing(): void {
  if (sweep) return;
  const run = async () => {
    const users = await db.execute<{ id: number }>(sql`SELECT DISTINCT user_id AS id FROM contact_groups WHERE user_id IS NOT NULL UNION SELECT DISTINCT user_id FROM email_lists`).catch(() => ({ rows: [] as Array<{ id: number }> }));
    for (const u of users.rows) await organizeAccount(Number(u.id));
    await fileUnfiledLists().catch(() => []);
  };
  setTimeout(() => void run(), 60_000).unref();
  sweep = setInterval(() => void run(), 10 * 60_000);
  sweep.unref();
}
