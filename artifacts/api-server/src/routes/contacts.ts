import { Router } from "express";
import { db, contactGroupsTable, contactsTable } from "@workspace/db";
import { eq, count, and, inArray, ne } from "drizzle-orm";
import { requireAuth } from "../lib/auth";
import { assertCanAddContacts, planErrorToResponse } from "../lib/plans";
import * as XLSX from "xlsx";
import multer from "multer";
import { readWorkbook, readText, parseTables, whatsappEntries } from "../lib/phone-import";
import { saveToGroup, saveToNewGroup, validateGroup, validateInBackground, validatePending } from "../lib/contact-save";
import { registerOnConnectHook } from "../lib/whatsapp";

// An import made while the line was down is checked the moment it comes back.
registerOnConnectHook((userId) => { setTimeout(() => void validatePending(userId).catch(() => {}), 30_000); });
import { findDuplicates, removeDuplicates } from "../lib/dedupe";
import { folderForSector, listSector } from "../lib/folders";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

const INSERT_BATCH = 200;

const COUNTRY_CODES = [971, 966, 974, 965, 973, 968, 967, 962, 963, 964, 961, 249, 212, 213, 216, 20];

function isMobileNumber(raw: string): boolean {
  const phone = cleanPhone(raw);
  if (!isValidPhone(phone)) return false;
  for (const cc of COUNTRY_CODES) {
    const ccStr = String(cc);
    if (phone.startsWith(ccStr)) {
      const local = phone.slice(ccStr.length);
      if (/^[5671]/.test(local) && local.length >= 7) return true;
      return false;
    }
  }
  if (/^05\d{8}$/.test(phone) || /^5\d{8}$/.test(phone)) return true;
  if (phone.length >= 10) return true;
  return false;
}

router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  const groups = await db
    .select({
      id: contactGroupsTable.id,
      name: contactGroupsTable.name,
      description: contactGroupsTable.description,
      segment: contactGroupsTable.segment,
      folderId: contactGroupsTable.folderId,
      createdAt: contactGroupsTable.createdAt,
      count: count(contactsTable.id),
    })
    .from(contactGroupsTable)
    .leftJoin(contactsTable, eq(contactGroupsTable.id, contactsTable.groupId))
    .where(eq(contactGroupsTable.userId, userId))
    .groupBy(contactGroupsTable.id)
    .orderBy(contactGroupsTable.createdAt);

  res.json(groups.map((g) => ({ ...g, contacts: [] })));
});

router.post("/", async (req, res) => {
  const userId = req.session.userId!;
  const { name, description, segment } = req.body;
  if (!name) return res.status(400).json({ error: "Name is required" });

  const [group] = await db
    .insert(contactGroupsTable)
    .values({ userId, name, description, segment: segment || null })
    .returning();

  res.status(201).json({ ...group, count: 0, contacts: [] });
});

router.get("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);

  const [group] = await db
    .select()
    .from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, id), eq(contactGroupsTable.userId, userId)));

  if (!group) return res.status(404).json({ error: "Not found" });

  const contacts = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.groupId, id))
    .orderBy(contactsTable.createdAt);

  const [countResult] = await db
    .select({ count: count(contactsTable.id) })
    .from(contactsTable)
    .where(eq(contactsTable.groupId, id));

  res.json({ ...group, count: countResult?.count || 0, contacts });
});

// ── Export contact list as Excel ──────────────────────────────────
router.get("/:id/export", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);

  const [group] = await db
    .select()
    .from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, id), eq(contactGroupsTable.userId, userId)));

  if (!group) return res.status(404).json({ error: "Not found" });

  const contacts = await db
    .select({ name: contactsTable.name, phone: contactsTable.phone })
    .from(contactsTable)
    .where(eq(contactsTable.groupId, id))
    .orderBy(contactsTable.createdAt);

  const hasNames = contacts.some((c) => c.name);
  const rows = contacts.map((c, i) =>
    hasNames
      ? { "#": i + 1, الاسم: c.name ?? "", الهاتف: c.phone }
      : { "#": i + 1, الهاتف: c.phone }
  );

  const ws = XLSX.utils.json_to_sheet(rows);
  ws["!cols"] = hasNames
    ? [{ wch: 6 }, { wch: 28 }, { wch: 20 }]
    : [{ wch: 6 }, { wch: 20 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, group.name.slice(0, 31));

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const filename = encodeURIComponent(group.name) + ".xlsx";

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
  res.setHeader("Content-Length", buf.length);
  res.end(buf);
});

// ── List hygiene ──────────────────────────────────────────────────
// Asks WhatsApp which of a group's numbers are real accounts, and parks the
// ones that are not. Dead numbers are expensive twice over: each one consumes
// a slot from the daily allowance and adds to the failure rate that gets a
// sender banned, so cleaning the list up front is the cheapest safety measure
// available.
//
// Numbers the check could not resolve are left untouched — a network blip must
// never quietly disable somebody's contacts.
router.post("/:id/validate", async (req, res) => {
  const userId  = req.session.userId!;
  const groupId = parseInt(req.params.id!);
  const [group] = await db.select().from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId)));
  if (!group) return res.status(404).json({ error: "القائمة غير موجودة" });
  try {
    res.json(await validateGroup(userId, groupId));
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    req.log?.warn({ err: msg, groupId }, "list validation failed");
    res.status(409).json({
      error: msg.startsWith("WA_DISCONNECTED")
        ? "واتساب غير متصل — اربط الجهاز أولاً ثم أعد الفحص"
        : "تعذّر فحص الأرقام، حاول مرة أخرى",
    });
  }
});

// ── Duplicates ────────────────────────────────────────────────────
// Compared by the international form, so 0501234567 and 971501234567 are
// one number. Within a list they are always removed; across lists only
// when asked, because a deliberate VIP list is legitimate.
router.get("/duplicates", async (req, res) => {
  const groupIds = req.query["groupId"] ? [Number(req.query["groupId"])] : undefined;
  res.json(await findDuplicates(req.session.userId!, groupIds));
});

router.post("/dedupe", async (req, res) => {
  const across = req.body?.across === true;
  const groupIds = req.body?.groupId ? [Number(req.body.groupId)] : undefined;
  res.json(await removeDuplicates(req.session.userId!, { across, groupIds: across ? undefined : groupIds }));
});

// ── Import: a file or pasted text, saved on arrival ───────────────
// The spreadsheet as it came. lib/phone-import.ts finds the header row on
// every sheet, every number column (the mobile first, never the fax), the
// company's name, and each row's country; this saves one WhatsApp number per
// company under the company's name, into the given list or a new one named
// after the file, and checks the numbers against WhatsApp in the background
// when the number is linked. No preview step: the report says what was kept
// and why the rest was not.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

router.post("/import", upload.single("file"), async (req, res) => {
  const userId = req.session.userId!;
  const b: any = req.body ?? {};
  const country = String(b.country ?? "AE").toUpperCase().slice(0, 2);
  const mobileOnly = b.mobileOnly !== "false" && b.mobileOnly !== false;
  const allMobiles = b.allMobiles === "true" || b.allMobiles === true;
  const verify = b.verify !== "false" && b.verify !== false;
  // A number already in another list is skipped unless the owner allows it.
  const allowOtherLists = b.allowOtherLists === "true" || b.allowOtherLists === true;
  const folderId = Number(b.folderId) || null;

  let tables;
  let fileName = "";
  try {
    if (req.file) {
      // Multer reads the name as latin1; an Arabic file name arrives as its UTF-8 bytes.
      const re = Buffer.from(req.file.originalname, "latin1").toString("utf8");
      fileName = /[\u0080-\u00ff]/.test(req.file.originalname) && !re.includes("\ufffd") ? re : req.file.originalname;
      tables = readWorkbook(req.file.buffer);
    }
    else if (typeof b.text === "string" && b.text.trim()) tables = readText(b.text);
    else return res.status(400).json({ error: "ارفع ملفاً أو الصق الأرقام" });
  } catch {
    return res.status(400).json({ error: "تعذّر قراءة الملف — تأكد أنه Excel أو CSV" });
  }

  const parsed = parseTables(tables, country);
  const foreign = b.foreign === "true" || b.foreign === true;
  const wa = whatsappEntries(parsed.rows, { mobileOnly, allMobiles, foreign });
  if (!wa.entries.length) {
    return res.status(400).json({
      error: parsed.total ? "لم أجد أرقام واتساب في الملف" : "الملف فارغ",
      total: parsed.total, landlineOnly: parsed.landlineOnly, noNumber: parsed.noNumber, sheets: parsed.sheets,
    });
  }

  try { await assertCanAddContacts(userId, wa.entries.length); }
  catch (err) { if (planErrorToResponse(err, res)) return; throw err; }

  let groupId = Number(b.groupId) || null;
  const listName = String(b.name ?? "").trim() || (fileName ? fileName.replace(/\.[a-z0-9]+$/i, "") : `أرقام ${new Date().toISOString().slice(0, 10)}`);
  const description = fileName ? `من ملف: ${fileName.slice(0, 80)}` : null;

  // The same file uploaded again tops up the list it made before, rather than
  // making a second list beside it. A list from the old split ("… - 1") is
  // that list; it gets its plain name back.
  let reused: string | null = null;
  if (!groupId && fileName) {
    const mine = await db.select().from(contactGroupsTable).where(eq(contactGroupsTable.userId, userId));
    const same = mine.find((g) => g.description === description) ?? mine.find((g) => g.name === listName || g.name === `${listName} - 1`);
    if (same) {
      groupId = same.id; reused = same.name;
      if (same.name === `${listName} - 1`) await db.update(contactGroupsTable).set({ name: listName }).where(eq(contactGroupsTable.id, same.id));
    }
  }

  // A new list goes into its sector's folder — the owner's own folder when
  // one reads as that sector — unless a folder was chosen.
  let folder: { id: number; name: string } | null = null;
  if (!groupId && !folderId) {
    folder = await folderForSector(userId, "wa", listSector(listName, fileName, parsed.rows.slice(0, 300).map((r) => r.company))).catch(() => null);
  }

  let saved;
  try {
    // Waiting for WhatsApp's word: nothing is shown as active, or sent to, until it comes.
    const status = verify ? "pending" as const : "active" as const;
    saved = groupId
      ? await saveToGroup(userId, groupId, wa.entries, { allowOtherLists, status })
      : await saveToNewGroup(userId, listName, description, wa.entries, { allowOtherLists, folderId: folderId ?? folder?.id ?? null, status });
  } catch (err: any) {
    return res.status(400).json({ error: String(err?.message ?? err) });
  }

  const verifying = verify && validateInBackground(userId, saved.groups.map((g) => g.id));
  logger.info({ userId, file: fileName, total: parsed.total, added: saved.added, groups: saved.groups.length, verifying }, "استيراد أرقام واتساب");

  res.json({
    file: fileName || null,
    total: parsed.total,
    added: saved.added,
    alreadyInList: saved.existing,
    inOtherLists: saved.inOtherLists,
    addedTo: reused,
    folder: folder?.name ?? null,
    otherListNames: saved.otherListNames,
    duplicates: wa.duplicates,
    skippedLandline: wa.skippedLandline,
    skippedForeign: wa.skippedForeign,
    noNumber: parsed.noNumber,
    named: wa.entries.filter((e) => e.name).length,
    byCountry: parsed.byCountry,
    sheets: parsed.sheets,
    autoSplit: saved.autoSplit,
    groups: saved.groups,
    verifying,
    sample: wa.entries.slice(0, 8),
  });
});

router.delete("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  await db.delete(contactGroupsTable).where(and(eq(contactGroupsTable.id, id), eq(contactGroupsTable.userId, userId)));
  res.json({ success: true, message: "Deleted" });
});

router.post("/:id/numbers", async (req, res) => {
  const userId = req.session.userId!;
  const groupId = parseInt(req.params.id);
  const { numbers, contacts: contactsInput, format = "text", mobileOnly = false } = req.body;

  if (!numbers && !contactsInput) return res.status(400).json({ error: "Numbers are required" });

  const [group] = await db
    .select()
    .from(contactGroupsTable)
    .where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId)));
  if (!group) return res.status(404).json({ error: "Group not found" });

  // The plan's contact ceiling, checked on what is about to be added rather
  // than after it is in.
  const adding = Array.isArray(contactsInput) ? contactsInput.length
    : String(numbers ?? "").split(/[\n,\r;]+/).filter((x) => x.trim()).length;
  try { await assertCanAddContacts(userId, adding); } catch (err) { if (planErrorToResponse(err, res)) return; throw err; }

  type Entry = { name: string; phone: string };
  let rawEntries: Entry[] = [];

  if (contactsInput && Array.isArray(contactsInput)) {
    rawEntries = contactsInput.map((c: any) => ({
      name: String(c.name || "").trim(),
      phone: String(c.phone || "").trim(),
    }));
  } else {
    let rawList: string[] = [];
    if (format === "json") {
      rawList = JSON.parse(numbers);
    } else {
      rawList = numbers.split(/[\n,\r]+/).map((n: string) => n.trim()).filter((n: string) => n.length > 0);
    }
    rawEntries = rawList.map((p) => ({ name: "", phone: p }));
  }

  let invalid = 0;
  let skippedLandline = 0;
  const seen = new Set<string>();
  const validEntries: Entry[] = [];

  for (const entry of rawEntries) {
    const phone = cleanPhone(entry.phone);
    if (!isValidPhone(phone)) { invalid++; continue; }
    if (mobileOnly && !isMobileNumber(phone)) { skippedLandline++; continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    validEntries.push({ name: entry.name, phone });
  }

  const globalDuplicates = rawEntries.length - invalid - skippedLandline - validEntries.length;

  // One list, however many: the numbers stay together.
  const saved = await saveToGroup(userId, groupId, validEntries.map((e) => ({ phone: e.phone, name: e.name || null })), { allowOtherLists: true });
  return res.json({
    added: saved.added,
    duplicates: globalDuplicates + saved.existing,
    invalid, skippedLandline,
    total: rawEntries.length,
    autoSplit: false,
    groups: saved.groups,
  });
});

async function batchInsert(groupId: number, entries: { name: string; phone: string }[]) {
  for (let i = 0; i < entries.length; i += INSERT_BATCH) {
    const batch = entries.slice(i, i + INSERT_BATCH);
    await db.insert(contactsTable).values(batch.map(({ phone, name }) => ({ groupId, phone, name: name || null, status: "active" }))).onConflictDoNothing();
  }
}

function cleanPhone(raw: string): string {
  let phone = raw.replace(/[\s\-\+\(\)\.]/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  return phone;
}

function isValidPhone(phone: string): boolean {
  return /^\d{7,15}$/.test(phone);
}

export default router;
