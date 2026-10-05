// ── WhatsApp groups: keeping and filing ───────────────────────────
// The owner works with customers in groups, and until now every group
// message was dropped at the door (only one-to-one chats were kept). Here
// each one is kept: who wrote it, what it said, what kind of message it was.
// The files customers send — invoices, statements, licences, photos of
// documents — are saved on this machine in a folder per group, and each
// group's conversation is appended to a monthly text archive beside them, so
// the record exists outside the app too.
//
// Nothing here sends anything. The suggestions live in ./assistant.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, waGroupsTable, waGroupMessagesTable } from "@workspace/db";
import { logger } from "../logger";

/** Where the files and archives go. On the Mac, beside the app's other data. */
export const FILES_ROOT = process.env["GROUP_FILES_DIR"] || path.join(homedir(), "Library", "Application Support", "whatsapp-marketer", "groups");
const MAX_FILE = 25 * 1024 * 1024;

export interface ParsedGroupMessage {
  groupJid: string;
  messageId: string;
  senderJid: string | null;
  senderPhone: string | null;
  senderName: string | null;
  fromMe: boolean;
  text: string;
  msgType: "text" | "image" | "document" | "voice" | "video" | "sticker" | "other";
  fileName: string | null;
  mimetype: string | null;
  fileSize: number;
  quotedId: string | null;
  createdAt: Date;
}

const secs = (t: any): number => (typeof t === "number" ? t : t?.toNumber ? t.toNumber() : Number(t?.low ?? t ?? 0)) || 0;

/** A group message as a row — or null for what is not a message (reactions, key exchanges, edits' husks). */
export function parseGroupMessage(msg: any, lidToPhone?: Map<string, string>): ParsedGroupMessage | null {
  const jid: string | undefined = msg?.key?.remoteJid;
  if (!jid?.endsWith("@g.us") || !msg?.key?.id) return null;
  const outer = msg.message;
  if (!outer) return null;
  const m = outer.ephemeralMessage?.message ?? outer.viewOnceMessage?.message ?? outer.viewOnceMessageV2?.message ?? outer.documentWithCaptionMessage?.message ?? outer;
  if (m.protocolMessage || m.reactionMessage || m.pollUpdateMessage) return null;

  const text = String(
    m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || "",
  ).trim();
  const msgType: ParsedGroupMessage["msgType"] =
    m.imageMessage ? "image" : m.documentMessage ? "document" : m.audioMessage ? "voice" : m.videoMessage ? "video" : m.stickerMessage ? "sticker" : text ? "text" : "other";
  if (msgType === "other" && !text) return null;

  // Who wrote it: the phone form when the key carries one, else the LID mapped to a phone if known.
  const pj: string | null = msg.key.participantPn ?? msg.key.participantAlt ?? msg.key.participant ?? msg.participant ?? null;
  let senderPhone: string | null = null;
  if (pj?.endsWith("@s.whatsapp.net")) senderPhone = pj.split("@")[0]!.split(":")[0]!;
  else if (pj?.endsWith("@lid")) senderPhone = lidToPhone?.get(pj) ?? null;
  const media = m.documentMessage ?? m.imageMessage ?? m.videoMessage ?? m.audioMessage ?? null;

  return {
    groupJid: jid,
    messageId: String(msg.key.id),
    senderJid: msg.key.participant ?? pj ?? null,
    senderPhone,
    senderName: msg.pushName ? String(msg.pushName).slice(0, 120) : null,
    fromMe: !!msg.key.fromMe,
    text,
    msgType,
    fileName: m.documentMessage?.fileName ? String(m.documentMessage.fileName).slice(0, 255) : null,
    mimetype: media?.mimetype ?? null,
    fileSize: Number(media?.fileLength?.low ?? media?.fileLength ?? 0) || 0,
    quotedId: m.extendedTextMessage?.contextInfo?.stanzaId ?? null,
    createdAt: new Date((secs(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000),
  };
}

// ── The folder per group ─────────────────────────────────────────
const safe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
export function folderFor(group: { jid: string; subject: string | null }): string {
  const id = group.jid.split("@")[0]!.slice(-6);
  return path.join(FILES_ROOT, `${safe(group.subject || "قروب")} (${id})`);
}
const extFor = (mimetype: string | null, type: string) => {
  const m = (mimetype ?? "").split(";")[0]!;
  const known: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf", "video/mp4": ".mp4", "audio/ogg": ".ogg", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx", "application/vnd.ms-excel": ".xls", "text/csv": ".csv" };
  return known[m] ?? (type === "image" ? ".jpg" : "");
};

function archiveLine(p: ParsedGroupMessage): string {
  const t = p.createdAt.toISOString().replace("T", " ").slice(0, 16);
  const who = p.fromMe ? "أنا" : p.senderName || (p.senderPhone ? `+${p.senderPhone}` : "عضو");
  const what = p.text || (p.msgType === "document" ? `[ملف] ${p.fileName ?? ""}` : `[${p.msgType}]`);
  return `[${t}] ${who}: ${what.replace(/\n/g, "\n    ")}\n`;
}

async function appendArchive(group: { jid: string; subject: string | null }, rows: ParsedGroupMessage[]) {
  if (!rows.length) return;
  const dir = folderFor(group);
  await fs.promises.mkdir(dir, { recursive: true });
  const byMonth = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => +a.createdAt - +b.createdAt)) {
    const k = r.createdAt.toISOString().slice(0, 7);
    byMonth.set(k, (byMonth.get(k) ?? "") + archiveLine(r));
  }
  for (const [month, text] of byMonth) await fs.promises.appendFile(path.join(dir, `محادثة-${month}.txt`), text, "utf8");
}

// ── Keeping ───────────────────────────────────────────────────────
/** Make sure the group has a row; returns it. */
async function ensureGroup(userId: number, jid: string, subject?: string | null) {
  await db.insert(waGroupsTable).values({ userId, jid, subject: subject ?? null }).onConflictDoNothing();
  if (subject) await db.update(waGroupsTable).set({ subject, updatedAt: new Date() }).where(and(eq(waGroupsTable.userId, userId), eq(waGroupsTable.jid, jid), sql`${waGroupsTable.subject} is distinct from ${subject}`));
  const [g] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, userId), eq(waGroupsTable.jid, jid))).limit(1);
  return g!;
}

const metaAsked = new Set<string>();

/**
 * One live (or appended) group message: kept, its file filed, archived.
 * Returns what was kept, or null for a repeat or a non-message.
 */
export async function captureGroupMessage(userId: number, sock: any, msg: any, opts: { lidToPhone?: Map<string, string>; download?: () => Promise<Buffer> } = {}): Promise<{ parsed: ParsedGroupMessage; group: Awaited<ReturnType<typeof ensureGroup>> } | null> {
  const p = parseGroupMessage(msg, opts.lidToPhone);
  if (!p) return null;
  const inserted = await db.insert(waGroupMessagesTable).values({
    userId, groupJid: p.groupJid, messageId: p.messageId, senderJid: p.senderJid, senderPhone: p.senderPhone, senderName: p.senderName,
    fromMe: p.fromMe, text: p.text || null, msgType: p.msgType, fileName: p.fileName, quotedId: p.quotedId, createdAt: p.createdAt,
  }).onConflictDoNothing().returning({ id: waGroupMessagesTable.id });
  if (!inserted.length) return null;

  let group = await ensureGroup(userId, p.groupJid);
  // The first message we hold for a group is where its past can be asked for: fetch it, in the background.
  if (group.messages === 0 && group.isCustomer && sock?.fetchMessageHistory) void backfill(userId, sock, p.groupJid).catch(() => {});
  // A group seen for the first time gets its name from WhatsApp, once.
  const key = `${userId}:${p.groupJid}`;
  if (!group.subject && sock?.groupMetadata && !metaAsked.has(key)) {
    metaAsked.add(key);
    try { const meta = await sock.groupMetadata(p.groupJid); group = await ensureGroup(userId, p.groupJid, meta?.subject ?? null); if (meta?.participants) await db.update(waGroupsTable).set({ participants: meta.participants.length, description: meta.desc ?? null }).where(eq(waGroupsTable.id, group.id)); } catch { /* the name can wait for the next sync */ }
  }
  await db.update(waGroupsTable).set({ messages: sql`${waGroupsTable.messages} + 1`, lastMessageAt: sql`greatest(${waGroupsTable.lastMessageAt}, ${p.createdAt})`, updatedAt: new Date() }).where(eq(waGroupsTable.id, group.id));

  // The file, into the group's folder: documents and images a customer group sends.
  if (group.isCustomer && (p.msgType === "document" || p.msgType === "image") && opts.download && (!p.fileSize || p.fileSize <= MAX_FILE)) {
    try {
      const buf = await opts.download();
      const dir = path.join(folderFor(group), "ملفات", p.createdAt.toISOString().slice(0, 7));
      await fs.promises.mkdir(dir, { recursive: true });
      const who = safe(p.senderName || p.senderPhone || (p.fromMe ? "أنا" : "عضو")).slice(0, 30);
      const base = p.fileName ? safe(p.fileName) : `${p.msgType === "image" ? "صورة" : "ملف"}${extFor(p.mimetype, p.msgType)}`;
      const file = path.join(dir, `${p.createdAt.toISOString().slice(0, 10)} ${who} — ${base}`.slice(0, 200));
      await fs.promises.writeFile(file, buf);
      await db.update(waGroupMessagesTable).set({ filePath: file, fileName: p.fileName ?? path.basename(file) }).where(eq(waGroupMessagesTable.id, inserted[0]!.id));
    } catch (err) {
      logger.warn({ userId, group: p.groupJid, err: String((err as any)?.message ?? err).slice(0, 160) }, "تعذّر حفظ ملف القروب");
    }
  }
  await appendArchive(group, [p]).catch(() => {});
  return { parsed: p, group };
}

/** A batch from the history sync: kept and archived; files from the past are not fetched (their links have usually expired). */
export async function captureGroupHistory(userId: number, msgs: any[], lidToPhone?: Map<string, string>): Promise<number> {
  const parsed = msgs.map((m) => parseGroupMessage(m, lidToPhone)).filter((x): x is ParsedGroupMessage => !!x);
  if (!parsed.length) return 0;
  let kept = 0;
  const fresh: ParsedGroupMessage[] = [];
  for (let i = 0; i < parsed.length; i += 500) {
    const part = parsed.slice(i, i + 500);
    const rows = await db.insert(waGroupMessagesTable).values(part.map((p) => ({
      userId, groupJid: p.groupJid, messageId: p.messageId, senderJid: p.senderJid, senderPhone: p.senderPhone, senderName: p.senderName,
      fromMe: p.fromMe, text: p.text || null, msgType: p.msgType, fileName: p.fileName, quotedId: p.quotedId, createdAt: p.createdAt,
    }))).onConflictDoNothing().returning({ messageId: waGroupMessagesTable.messageId });
    kept += rows.length;
    const ids = new Set(rows.map((r) => r.messageId));
    fresh.push(...part.filter((p) => ids.has(p.messageId)));
  }
  const jids = [...new Set(fresh.map((p) => p.groupJid))];
  for (const jid of jids) {
    const g = await ensureGroup(userId, jid);
    await recount(userId, jid);
    await appendArchive(g, fresh.filter((p) => p.groupJid === jid)).catch(() => {});
  }
  if (kept) logger.info({ userId, kept, groups: jids.length }, "سجل القروبات حُفظ");
  return kept;
}

/** The group's message count and last time, from the rows themselves. */
export async function recount(userId: number, jid: string) {
  await db.execute(sql`
    UPDATE wa_groups g SET
      messages = (SELECT count(*) FROM wa_group_messages m WHERE m.user_id = g.user_id AND m.group_jid = g.jid),
      last_message_at = (SELECT max(created_at) FROM wa_group_messages m WHERE m.user_id = g.user_id AND m.group_jid = g.jid),
      updated_at = NOW()
    WHERE g.user_id = ${userId} AND g.jid = ${jid}`);
}

/** Every group the number is in, with its name and size, from WhatsApp. */
export async function syncGroups(userId: number, sock: any): Promise<number> {
  if (!sock?.groupFetchAllParticipating) return 0;
  const all = await sock.groupFetchAllParticipating();
  let n = 0;
  for (const meta of Object.values(all ?? {}) as any[]) {
    if (!meta?.id) continue;
    await db.insert(waGroupsTable).values({ userId, jid: meta.id, subject: meta.subject ?? null, description: meta.desc ?? null, participants: meta.participants?.length ?? 0 })
      .onConflictDoUpdate({ target: [waGroupsTable.userId, waGroupsTable.jid], set: { subject: meta.subject ?? null, description: meta.desc ?? null, participants: meta.participants?.length ?? 0, updatedAt: new Date() } });
    n++;
  }
  logger.info({ userId, groups: n }, "قروبات واتساب تزامنت");
  return n;
}

/** The oldest message we hold for a group — where "load more history" starts from. */
export async function oldestMessage(userId: number, jid: string) {
  const [m] = await db.select().from(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, userId), eq(waGroupMessagesTable.groupJid, jid))).orderBy(waGroupMessagesTable.createdAt).limit(1);
  return m ?? null;
}

export async function groupsByJid(userId: number, jids: string[]) {
  if (!jids.length) return [];
  return db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, userId), inArray(waGroupsTable.jid, jids)));
}

// ── The past, asked for ──────────────────────────────────────────
const filling = new Set<string>();
/**
 * Ask WhatsApp for a group's older messages, fifty at a time, until it stops
 * sending older ones or `pages` is reached. They arrive through the history
 * sync and are kept there; this only asks, and waits between asks.
 */
export async function backfill(userId: number, sock: any, jid: string, pages = 8): Promise<number> {
  const key = `${userId}:${jid}`;
  if (filling.has(key) || !sock?.fetchMessageHistory) return 0;
  filling.add(key);
  let asked = 0;
  try {
    let prev = "";
    for (let i = 0; i < pages; i++) {
      const oldest = await oldestMessage(userId, jid);
      if (!oldest || oldest.messageId === prev) break;   // nothing older arrived after the last ask
      prev = oldest.messageId;
      await sock.fetchMessageHistory(50, { remoteJid: jid, id: oldest.messageId, fromMe: oldest.fromMe, participant: oldest.senderJid ?? undefined }, Math.floor(oldest.createdAt.getTime() / 1000));
      asked++;
      await new Promise((r) => setTimeout(r, 20_000));
    }
    await recount(userId, jid);
  } finally { filling.delete(key); }
  if (asked) logger.info({ userId, jid, asked }, "طُلب سجل القروب الأقدم");
  return asked;
}
