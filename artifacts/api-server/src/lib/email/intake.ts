// ── One upload, both channels ──────────────────────────────────────
// The owner: «أرفع البيانات مرةً واحدة في مكانٍ واحد، والأرقام تترتب في
// واتساب والإيميلات في البريد». Before, the WhatsApp section saved only the
// numbers of a file and the email section saved both — so a file with both
// had to be uploaded twice to be sure. Both sections now upload through here.

import { and, eq, inArray } from "drizzle-orm";
import { db, emailContactsTable, emailListsTable, emailListMembersTable, contactGroupsTable } from "@workspace/db";
import { assertCanAddContacts } from "../plans";
import { enrolInSequence } from "./service";
import { cleanRows, detectColumns, checkMx, splitBy, type ImportRow } from "./importer";
import { parseTables, whatsappEntries } from "../phone-import";
import { saveToNewGroup, saveToGroup, validateInBackground } from "../contact-save";
import { folderForSector, listSector, ownFolder, fileUnfiledLists } from "../folders";
import { runDesk } from "../data-desk/desk";
import { mapFolder } from "./auto-desk";
import { classifySector } from "./sector";
import { logger } from "../logger";
import { runPipeline } from "./pipeline";

/**
 * One file in, both channels out: the addresses into an email list and the
 * WhatsApp numbers into a number list, each into its folder, each handed to
 * the data desk. The email section and the WhatsApp section both upload
 * through here, so the owner uploads a file once, from either place.
 */
export async function importRows(userId: number, rawRows: Array<Record<string, unknown>>, parsed: ReturnType<typeof parseTables> | null, fileName: string, body: any): Promise<{ status: number; json: any }> {
  const reply = (status: number, json: any) => ({ status, json });

  const columns = parsed
    ? { email: "email", name: "name", company: "company", phone: "phone", industry: "industry", city: "city" } as ReturnType<typeof detectColumns>
    : detectColumns(rawRows);
  const hasEmails = parsed ? parsed.rows.some((r) => r.email) : !!columns.email;
  const waOnly = parsed ? whatsappEntries(parsed.rows).entries.length : 0;
  if (!hasEmails && !waOnly) return reply(400, { error: "لم أجد بريداً إلكترونياً ولا أرقام واتساب في الملف", columns });
  const report = cleanRows(rawRows, columns);

  // MX per domain, so a dead domain never costs a bounce.
  const doMx = body.mx !== "false" && body.mx !== false;
  let mxBad = 0;
  if (doMx && report.rows.length) {
    const mx = await checkMx(report.rows.map((r) => r.email.split("@")[1]!));
    for (const r of report.rows) (r as any).mxOk = mx.get(r.email.split("@")[1]!) ?? null;
    mxBad = report.rows.filter((r) => (r as any).mxOk === false).length;
  }

  // Rows with a phone and no address. They used to be counted invalid and
  // dropped; a directory export is full of them and they are still companies
  // this business can reach — just through the other door.
  const phoneOnly = report.phoneOnly ?? [];

  // مجلدٌ مسمّى رُفع كاملاً: اسمه هو قطاع ملفاته — إن عُرف. اسمٌ لا يُعرف
  // («ملفات قديمة») لا يُفرض قطاعاً، فتُصنَّف كل شركةٍ باسمها ونشاطها.
  const folderName = typeof body.folderName === "string" && body.folderName.trim() ? body.folderName.trim().slice(0, 80) : null;
  const sectorOverride = typeof body.sector === "string" && body.sector.trim() ? body.sector.trim().slice(0, 60)
    : folderName ? mapFolder(folderName).sector : null;
  const listNameHint = String(body.listName ?? "");

  // Upsert the contacts; existing ones keep their status.
  const source = (body.source ?? (fileName ? `ملف: ${fileName.slice(0, 50)}` : "استيراد")).slice(0, 60);
  let inserted = 0;
  const ids = new Map<string, number>();
  for (let i = 0; i < report.rows.length; i += 200) {
    const chunk = report.rows.slice(i, i + 200);
    const rows = await db.insert(emailContactsTable).values(chunk.map((r) => ({
      userId, email: r.email, name: r.name ?? null, company: r.company ?? null, phone: r.phone ?? null,
      industry: r.industry ?? null, city: r.city ?? null, source, mxOk: (r as any).mxOk ?? null,
      // The owner's word for the whole file wins; otherwise the row's own
      // activity or name, and the file's name as a last hint.
      sector: sectorOverride || classifySector({ industry: r.industry, company: r.company, hint: fileName || listNameHint }),
    }))).onConflictDoNothing().returning({ id: emailContactsTable.id, email: emailContactsTable.email });
    inserted += rows.length;
    for (const r of rows) ids.set(r.email, r.id);
  }
  const existing = await db.select({ id: emailContactsTable.id, email: emailContactsTable.email, status: emailContactsTable.status }).from(emailContactsTable)
    .where(and(eq(emailContactsTable.userId, userId), inArray(emailContactsTable.email, report.rows.map((r) => r.email))));
  for (const r of existing) ids.set(r.email, r.id);
  const activeIds = existing.filter((r) => r.status === "active").map((r) => r.id);

  // The list, and the split.
  const listName = String(body.listName ?? (fileName ? fileName.replace(/\.[a-z]+$/i, "") : `استيراد ${new Date().toISOString().slice(0, 10)}`)).slice(0, 160);
  let listId = Number(body.listId) || null;
  let reused: string | null = null;
  let folder: { id: number; name: string } | null = null;
  if (listId) {
    const [own] = await db.select({ id: emailListsTable.id }).from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
    if (!own) return reply(404, { error: "القائمة غير موجودة" });
  } else {
    // The same file again tops up the list it made before, rather than a
    // second list with the same name beside it.
    const [same] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.userId, userId), eq(emailListsTable.name, listName))).limit(1);
    if (same) { listId = same.id; reused = same.name; }
    else {
      // A new list goes into the folder chosen, or its sector's folder — the
      // owner's own folder when one reads as that sector.
      const folderId = Number(body.folderId) || (folderName ? await ownFolder(userId, folderName, sectorOverride) : null);
      folder = folderId ? { id: folderId, name: folderName ?? "" } : await folderForSector(userId, "email", sectorOverride ?? listSector(listName, fileName, report.rows.slice(0, 300).map((r) => r.company))).catch(() => null);
      const [l] = await db.insert(emailListsTable).values({ userId, name: listName, description: source, folderId: folder?.id ?? null }).returning();
      listId = l!.id;
    }
  }
  const addAll = async (lid: number, rows: ImportRow[]) => {
    const members = rows.map((r) => ids.get(r.email)).filter((x): x is number => !!x);
    for (let i = 0; i < members.length; i += 500) {
      await db.insert(emailListMembersTable).values(members.slice(i, i + 500).map((contactId) => ({ listId: lid, contactId }))).onConflictDoNothing();
    }
  };
  await addAll(listId, report.rows);

  const splitField = body.splitBy === "industry" || body.splitBy === "city" ? body.splitBy : null;
  const subLists: Array<{ id: number; name: string; count: number }> = [];
  if (splitField) {
    // The sub-lists sit in the same folder as the list they came from.
    const [parent] = await db.select({ folderId: emailListsTable.folderId }).from(emailListsTable).where(eq(emailListsTable.id, listId)).limit(1);
    for (const [k, rows] of splitBy(report.rows, splitField)) {
      const [l] = await db.insert(emailListsTable).values({ userId, name: `${listName} — ${k}`.slice(0, 160), description: `فرع من «${listName}» حسب ${splitField === "industry" ? "النشاط" : "المدينة"}`, folderId: parent?.folderId ?? null }).returning();
      await addAll(l!.id, rows);
      subLists.push({ id: l!.id, name: l!.name, count: rows.length });
    }
  }

  // Straight into the ladder, if asked.
  let enrolled = null as null | { enrolled: number; skipped: number };
  const sequenceId = Number(body.sequenceId) || null;
  if (sequenceId) enrolled = await enrolInSequence(userId, sequenceId, activeIds).catch((err) => { logger.warn({ err: String(err?.message ?? err) }, "enrol after import failed"); return null; });

  // The WhatsApp half. Every row with a WhatsApp number — including rows
  // with no email at all — goes into a number list named after this one,
  // under the company's name, so the same file feeds both channels.
  let whatsapp: null | { added: number; addedTo?: string | null; alreadyInList: number; duplicates: number; skippedLandline: number; groups: Array<{ id: number; name: string; count: number }>; verifying: boolean; error?: string } = null;
  if (parsed && body.saveWhatsapp !== "false" && body.saveWhatsapp !== false) {
    const wa = whatsappEntries(parsed.rows);
    if (wa.entries.length) {
      try {
        await assertCanAddContacts(userId, wa.entries.length);
        // The same name and the same folders as a WhatsApp upload: the list is
        // the file's name (a second upload of it tops that list up), and it is
        // filed by its sector, or by where it came from, like every other list.
        const waName = String(body.waListName ?? listName).slice(0, 240);
        const [same] = await db.select({ id: contactGroupsTable.id }).from(contactGroupsTable)
          .where(and(eq(contactGroupsTable.userId, userId), eq(contactGroupsTable.name, waName))).limit(1);
        const waFolder = await folderForSector(userId, "wa", sectorOverride ?? listSector(listName, fileName, parsed.rows.slice(0, 300).map((r) => r.company))).catch(() => null);
        const status = body.verify === "false" || body.verify === false ? "active" as const : "pending" as const;
        const saved = same
          ? await saveToGroup(userId, same.id, wa.entries, { status })
          : await saveToNewGroup(userId, waName, fileName ? `من ملف: ${fileName.slice(0, 80)}` : "رفع واحد للبريد وواتساب", wa.entries, { folderId: waFolder?.id ?? null, status });
        const verifying = status === "pending" && validateInBackground(userId, saved.groups.map((g) => g.id));
        await fileUnfiledLists(userId).catch(() => []);
        whatsapp = { added: saved.added, alreadyInList: saved.existing + saved.inOtherLists, addedTo: same ? waName : null, duplicates: wa.duplicates, skippedLandline: wa.skippedLandline, groups: saved.groups, verifying };
      } catch (err: any) {
        whatsapp = { added: 0, alreadyInList: 0, duplicates: wa.duplicates, skippedLandline: wa.skippedLandline, groups: [], verifying: false, error: String(err?.message ?? err) };
      }
    }
  }

  logger.info({ userId, file: fileName, total: report.total, kept: report.kept, inserted, mxBad, listId, sub: subLists.length, enrolled, whatsapp: whatsapp?.added ?? 0 }, "استيراد بريد");

  // مكتب البيانات يستلم ما رُفع، في الخلفية: ماجد ينظّف، بدور تصنّف وتقول
  // بماذا عُرف كل قطاع، ومنصور يُخبَر. صاحب العمل يرفع ولا يفعل غير ذلك.
  if (listId) {
    void runDesk(userId, { channel: "email", listId, trigger: "upload",
      intake: { total: report.total, kept: report.kept, invalid: report.invalid, duplicates: report.duplicates, deadDomain: mxBad, roleAddresses: report.roleAddresses, phoneOnly: phoneOnly.length } })
      .catch((err) => logger.warn({ userId, listId, err: String(err?.message ?? err) }, "مكتب البيانات تعذّر بعد رفع البريد"));
    for (const g of whatsapp?.groups ?? []) {
      void runDesk(userId, { channel: "whatsapp", listId: g.id, trigger: "upload" }).catch(() => {});
    }
  }
  // The team takes it from here: cleaned, read, recommended, written, prepared
  // for approval — without the owner choosing anything. In the background:
  // the upload answers now, the chain reports in the team's feed.
  const pipeline = body.auto !== "false" && body.auto !== false && report.rows.length > 0;
  if (pipeline) {
    const lid = listId;
    setImmediate(() => { runPipeline(userId, lid).catch((err) => logger.warn({ userId, listId: lid, err: String(err?.message ?? err) }, "list pipeline failed")); });
  }
  return reply(200, {
    file: fileName || null, columns, total: report.total, kept: report.kept, inserted, alreadyKnown: report.kept - inserted,
    invalid: report.invalid, duplicates: report.duplicates, roleAddresses: report.roleAddresses, mxBad,
    // What the owner could not see before: addresses beyond the first on a
    // line, and the companies that have a phone but no address at all.
    extraAddresses: report.extraAddresses ?? 0,
    phoneOnly: phoneOnly.length,
    phoneOnlySample: phoneOnly.slice(0, 5),
    list: { id: listId, name: listName }, addedTo: reused, pipeline, folder: folder?.name || null, subLists, enrolled, sample: report.sample,
    whatsapp, sheets: parsed?.sheets ?? null, byCountry: parsed?.byCountry ?? null,
  });
}
