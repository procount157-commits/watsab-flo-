import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  Browsers,
  WAMediaUpload,
  downloadMediaMessage,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { logger as appLogger } from "./logger";
import { and, eq, sql, desc } from "drizzle-orm";
import { db, waAuthStateTable, waSessionEventsTable, usersTable, incomingMessagesTable, contactsTable, unsubscribedPhonesTable, waContactsTable, waConversationsTable, waThreadMessagesTable, waSyncStateTable, messageLogs, campaignsTable, campaignButtonResponsesTable } from "@workspace/db";
import { useDatabaseAuthState, migrateSessionFilesToDb } from "./wa-auth-state";
import { transcribe } from "./voice";
import { isStopTap, tappedButtonId, stopForMonths, STOP_ACK } from "./opt-out";
import { nativeFlowButtons, interactiveReplyText, type ButtonDef } from "./wa-buttons";
import { speak } from "./tts";
import { assessSession, isRejection, isHandshakeRejection, STABLE_AFTER_MS, FLAP_WINDOW_MS, COOLDOWN_MS } from "./session-breaker";
import path from "path";
import fs from "fs";
import qrcode from "qrcode";
import { getObjectBuffer, objectNameFromUrl } from "./storage";


import { captureGroupMessage, captureGroupHistory } from "./groups/store";
import { onGroupMessage } from "./groups/assistant";
export const BASE_SESSION_DIR = path.resolve(process.cwd(), "whatsapp-session");



// ── WhatsApp Web version ──────────────────────────────────────────
// A client version WhatsApp no longer accepts makes the handshake fail with
// 405 before a QR is ever issued. Baileys' own lookup reads a file on GitHub,
// and when that fetch fails it quietly returns the version baked into the
// package with `isLatest: false`. This code used to cache whatever came back
// for an hour — so one failed fetch on a laptop coming out of sleep meant an
// hour of 405s, and the breaker read five 405s as dead credentials and wiped
// the pairing. Fifty times, on this account, in three days.
//
// A version is trusted only when a live source confirmed it. Two sources are
// tried; the last confirmed version is kept on disk across restarts; the
// baked-in number is the last resort rather than the first fallback; and an
// unconfirmed value is retried after two minutes, not cached for an hour.
const WA_VERSION_TTL_MS   = 60 * 60 * 1000;
const WA_VERSION_RETRY_MS = 2 * 60 * 1000;
const WA_VERSION_FALLBACK: [number, number, number] = [2, 3000, 1043857760];
const WA_VERSION_FILE = path.join(BASE_SESSION_DIR, "wa-version.json");

type WaVersion = [number, number, number];
let waVersionCache: { version: WaVersion; fetchedAt: number; confirmed: boolean } | null = null;

function readKnownGoodVersion(): WaVersion | null {
  try {
    const v = JSON.parse(fs.readFileSync(WA_VERSION_FILE, "utf8"))?.version;
    return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n)) ? (v as WaVersion) : null;
  } catch { return null; }
}

function writeKnownGoodVersion(version: WaVersion) {
  try {
    fs.mkdirSync(BASE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(WA_VERSION_FILE, JSON.stringify({ version, confirmedAt: new Date().toISOString() }));
  } catch (err) {
    appLogger.warn({ err: String((err as any)?.message ?? err) }, "could not persist the WA version");
  }
}

function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label}: timed out after ${ms} ms`)), ms)),
  ]);
}

async function resolveWaVersion(): Promise<WaVersion> {
  const now = Date.now();
  if (waVersionCache) {
    const ttl = waVersionCache.confirmed ? WA_VERSION_TTL_MS : WA_VERSION_RETRY_MS;
    if (now - waVersionCache.fetchedAt < ttl) return waVersionCache.version;
  }

  // Both return `isLatest: false` with the baked-in number when they could
  // not actually look anything up. That is a failure with a value attached,
  // not a result, and is treated as the former.
  const sources: Array<[string, () => Promise<{ version: number[]; isLatest: boolean }>]> = [
    ["github",       () => fetchLatestBaileysVersion()],
    ["whatsapp.com", () => fetchLatestWaWebVersion({})],
  ];
  for (const [source, lookup] of sources) {
    try {
      const { version, isLatest } = await withDeadline(lookup(), 8_000, source);
      if (!isLatest) continue;
      const v = version as WaVersion;
      waVersionCache = { version: v, fetchedAt: now, confirmed: true };
      writeKnownGoodVersion(v);
      appLogger.info({ version: v, source }, "WhatsApp Web version confirmed");
      return v;
    } catch (err) {
      appLogger.warn({ source, err: String((err as any)?.message ?? err) }, "WA version source failed");
    }
  }

  const known = readKnownGoodVersion();
  const version = known ?? waVersionCache?.version ?? WA_VERSION_FALLBACK;
  waVersionCache = { version, fetchedAt: now, confirmed: false };
  appLogger.warn({ version, source: known ? "last-confirmed" : "built-in" },
    "no live source for the WA version — using the last one known to work; retrying in 2 min");
  return version;
}

/** Forget the cached version so the next connect looks it up again. */
export function invalidateWaVersion(why: string) {
  if (!waVersionCache) return;
  appLogger.info({ why, was: waVersionCache.version, confirmed: waVersionCache.confirmed }, "WA version cache dropped");
  waVersionCache = null;
}

// ── Protobuf Long → unix seconds ──────────────────────────────────
// Baileys timestamps (conversationTimestamp, messageTimestamp) arrive as
// either a plain number OR a protobuf Long object {low, high, toNumber}.
// Casting directly to number gives NaN for Long objects, breaking date filters.
function toSecs(val: unknown): number {
  if (!val && val !== 0) return Math.floor(Date.now() / 1000);
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    if (typeof obj["toNumber"] === "function")
      return (obj["toNumber"] as () => number)();
    if (typeof obj["low"] === "number") {
      const lo = obj["low"] as number;
      const hi = (obj["high"] as number) | 0;
      return hi * 0x1_0000_0000 + (lo >>> 0);
    }
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : Math.floor(Date.now() / 1000);
}

// ── Professional ad-style button formatter ────────────────────────
// Formats buttons as visual divider blocks that resemble WhatsApp
// Business API / Meta ad messages.
//
// Example output:
//   [message body]
//
//   ╭──────────────────────╮
//   │  🛒  اطلب الآن       │
//   ╰──────────────────────╯
//      👉  https://shop.example.com
//
//   ╭──────────────────────╮
//   │  📞  اتصل بنا        │
//   ╰──────────────────────╯
//      ☎️  +971 50 000 0000

const BTN_WIDTH = 24; // pill inner width (─ chars)

function pillButton(icon: string, label: string): string {
  const top = "╭" + "─".repeat(BTN_WIDTH) + "╮";
  const mid = `│  ${icon}  ${label}`;
  const bot = "╰" + "─".repeat(BTN_WIDTH) + "╯";
  return `${top}\n${mid}\n${bot}`;
}

function formatButtonsAdStyle(body: string, btns: ButtonDef[]): string {
  const valid = btns.filter((b) => b.text?.trim());
  if (valid.length === 0) return body;

  let out = body;
  valid.forEach((b) => {
    if (b.type === "call") {
      out += `\n\n${pillButton("📞", `*${b.text}*`)}`;
      if (b.phone) out += `\n   ☎️  ${b.phone}`;
    } else if (b.type === "reply") {
      out += `\n\n${pillButton("💬", `*${b.text}*`)}`;
    } else if (b.type === "interested") {
      out += `\n\n${pillButton("👍", `*${b.text}*`)}`;
    } else if (b.type === "not_interested") {
      out += `\n\n${pillButton("👎", `*${b.text}*`)}`;
    } else if (b.type === "stop") {
      out += `\n\n${pillButton("🛑", `*${b.text}*`)}`;
    } else {
      out += `\n\n${pillButton("🔗", `*${b.text}*`)}`;
      if (b.url) out += `\n   👉  ${b.url}`;
    }
  });
  return out;
}

// ── Real buttons ─────────────────────────────────────────────────
// The buttons a customer taps, not a drawing of them. WhatsApp's "native
// flow" interactive message is what the business platforms send: quick
// replies that come back as a reply, a link button that opens the page, a
// call button that dials. It needs the <biz><interactive> node on the stanza
// or the phone shows "this message cannot be displayed". If WhatsApp refuses
// it, the same words go with the buttons drawn as text, so nothing is lost.

const INTERACTIVE_NODES = [{
  tag: "biz", attrs: {},
  content: [{ tag: "interactive", attrs: { type: "native_flow", v: "1" }, content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }] }],
}];

/** Sends body + buttons (and an optional header image) as one interactive message. */
async function sendNativeButtons(
  sock: NonNullable<WAState["socket"]>,
  jid: string,
  body: string,
  btns: ButtonDef[],
  image?: WAMediaUpload,
): Promise<{ key: { id: string; remoteJid: string; fromMe: boolean } }> {
  const buttons = nativeFlowButtons(btns);
  if (buttons.length === 0) throw new Error("no buttons");
  const header = image
    ? { hasMediaAttachment: true, ...(await prepareWAMessageMedia({ image }, { upload: sock.waUploadToServer })) }
    : { hasMediaAttachment: false, title: "" };
  const msg = generateWAMessageFromContent(jid, {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: {
          body: { text: body },
          header,
          nativeFlowMessage: { buttons, messageParamsJson: "" },
        },
      },
    },
  } as any, { userJid: sock.user!.id });
  await sock.relayMessage(jid, msg.message!, { messageId: msg.key.id!, additionalNodes: INTERACTIVE_NODES as any });
  return { key: { id: msg.key.id!, remoteJid: jid, fromMe: true } };
}

/**
 * Matches an incoming reply against the interested/not_interested buttons of
 * the most recent campaign sent to that phone (via message_logs), and records
 * the response in campaign_button_responses (dedup'd by campaign+phone+action).
 * Returns the matched action + campaign name if a match was recorded/found,
 * so the caller can send a confirmation reply.
 */
async function matchCampaignButtonResponse(
  userId: number,
  phone: string,
  text: string
): Promise<{ action: "interested" | "not_interested" | "stop"; campaignName: string } | null> {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  // Recent campaigns (last 30 days) that actually sent a message to this phone,
  // most recent first — mirrors how the button was rendered to the recipient.
  const rows = await db
    .select({
      campaignId: campaignsTable.id,
      campaignName: campaignsTable.name,
      buttons: campaignsTable.buttons,
    })
    .from(messageLogs)
    .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
    .where(
      and(
        eq(messageLogs.phone, phone),
        eq(campaignsTable.userId, userId),
        eq(messageLogs.status, "sent"),
      )
    )
    .orderBy(desc(messageLogs.sentAt))
    .limit(20);

  for (const row of rows) {
    if (!row.buttons) continue;
    let btns: ButtonDef[];
    try {
      btns = JSON.parse(row.buttons);
    } catch {
      continue;
    }
    const match = btns.find(
      (b) =>
        (b.type === "interested" || b.type === "not_interested" || b.type === "stop") &&
        b.text?.trim().toLowerCase() === normalized
    );
    if (!match) continue;

    const action = match.type as "interested" | "not_interested" | "stop";
    await db
      .insert(campaignButtonResponsesTable)
      .values({ campaignId: row.campaignId, userId, phone, buttonText: match.text, action })
      .onConflictDoNothing()
      .catch(() => {});

    return { action, campaignName: row.campaignName };
  }

  return null;
}

type WAStatus = "disconnected" | "connecting" | "connected" | "qr_ready" | "reconnecting";
// Extended health states (derived — not stored as WAStatus)
type WAHealthState = WAStatus | "degraded" | "stale" | "broken_session";

interface WAState {
  status: WAStatus;
  connected: boolean;
  phone: string | null;
  name: string | null;
  qr: string | null;
  socket: ReturnType<typeof makeWASocket> | null;
}

type CarouselCard = { title: string; description: string; imageUrl?: string; buttonText?: string; buttonUrl?: string };

// ── Per-user WhatsApp instance ────────────────────────────────────

class WhatsAppInstance {
  private userId: number;
  private sessionDir: string;
  private state: WAState = { status: "disconnected", connected: false, phone: null, name: null, qr: null, socket: null };
  getSocket() { return this.state.connected ? this.state.socket : null; }
  private loggedOutRetries = 0;
  /**
   * Counts how many QR cycles have expired without a scan in the current session.
   * Used to auto-clear rejected credentials and to apply longer backoffs between
   * QR regenerations.  Reset to 0 on every successful "open" event.
   */
  private qrCycleCount = 0;
  /**
   * Counts consecutive failed reconnect attempts (any reason).
   * Drives exponential backoff — reset to 0 on every successful "open" event.
   * Prevents rapid reconnect cycling that spams the paired phone with notifications.
   */
  private consecutiveReconnectFails = 0;
  /** Timestamp of the last time we entered "reconnecting" state */
  private reconnectingStartedAt: number | null = null;
  private manualLogout = false;
  private reconnectTimer:  ReturnType<typeof setTimeout>  | null = null;

  // Pairing-code handshake — set before init(), read from init() after makeWASocket
  private pendingPairingPhone: string | null = null;
  private lastPairingCode:     string | null = null;
  private pairingCodeError:    string | null = null;
  private keepAliveTimer:  ReturnType<typeof setInterval> | null = null;
  private onlineTimer:     ReturnType<typeof setInterval> | null = null;
  private watchdogTimer:   ReturnType<typeof setInterval> | null = null;
  private healthTimer:     ReturnType<typeof setInterval> | null = null;
  private log: typeof appLogger;

  /**
   * Monotonically increasing socket generation counter.
   * Each new socket gets a unique generation; its event handlers capture it
   * in a closure and bail out if the stored value no longer matches.
   * This prevents stale-socket events (old sockets firing after reconnect)
   * from corrupting state or inflating loggedOutRetries.
   */
  private socketGeneration = 0;

  connectedAt:    Date | null = null;
  reconnectCount: number = 0;
  lastActivityAt: Date = new Date();
  /**
   * Updated whenever any Baileys event fires (connection.update, messages.upsert, etc.).
   * Used by the health monitor to detect zombie sockets after long absences:
   * if connected but no events for >4h → force rebuild.
   */
  lastEventReceivedAt: Date = new Date();
  /**
   * When a message last arrived FROM someone else.
   *
   * Separate from lastEventReceivedAt because the failure that matters is
   * narrower than "no events": a half-dead linked device still emits
   * connection.update, creds.update and delivery receipts while WhatsApp has
   * quietly stopped routing inbound messages to it. Only this timestamp
   * distinguishes "quiet" from "no longer receiving".
   */
  lastInboundMessageAt: Date | null = null;

  // ── Re-pair circuit breaker ───────────────────────────────────
  // Credentials can stop being acceptable to WhatsApp without the session ever
  // being "logged out": the socket closes with 405 and Baileys, seeing stored
  // credentials, never offers a QR. Retrying identical rejected credentials
  // cannot recover, so the loop runs for ever — which is exactly the
  // "disconnects and never shows a new QR" symptom.
  //
  // Counted only while no connection has *held*. A connect that dies within
  // seconds must not reset this, or a connect-die-connect loop resets the
  // counter on every pass and the breaker never trips.
  private failuresSinceStable = 0;
  private lastStableAt: Date | null = null;
  /** Start times of recent connections, for detecting flapping. */
  private recentConnects: number[] = [];
  /** Set when the breaker cleared credentials; means a fresh scan is required. */
  awaitingRescanSince: Date | null = null;
  /** 405s since the last open. Drives a flat, short retry — never the credential count. */
  private handshakeRejects = 0;
  /**
   * Ids of messages this process sent. A fromMe message that is not in here
   * came from the owner's phone — a person has joined the thread, and the
   * bot must get out of their way.
   */
  private sentIds = new Set<string>();
  private rememberSent(id?: string | null) {
    if (!id) return;
    this.sentIds.add(id);
    if (this.sentIds.size > 4_000) {
      for (const old of this.sentIds) { this.sentIds.delete(old); if (this.sentIds.size <= 3_000) break; }
    }
  }

  // ── Session Guardian tracking ─────────────────────────────────────
  /** Timestamp of the last message that was successfully sent to WA servers */
  lastSuccessfulSendAt: Date | null = null;
  /** How many consecutive send failures since last success (resets on success) */
  consecutiveSendFailures: number = 0;

  /** Listeners for live diagnostic SSE stream */
  private diagListeners: Array<(event: { type: string; data: unknown; ts: string }) => void> = [];

  /**
   * In-flight sendMessage() calls register an abort callback here, keyed by the
   * socketGeneration they were issued on. When the socket for that generation
   * closes/reconnects mid-send, we reject those callbacks immediately instead
   * of letting them hang until the 35 s SEND_TIMEOUT — the underlying WS is
   * gone, so waiting out the full timeout only wastes time and looks like a
   * generic failure instead of a clear "connection dropped mid-send".
   */
  private pendingSendAborts: Map<number, Set<(err: Error) => void>> = new Map();

  private abortPendingSends(gen: number, reason: string) {
    const set = this.pendingSendAborts.get(gen);
    if (!set || set.size === 0) return;
    const err = new Error(`SOCKET_CLOSED_MID_SEND: انقطع الاتصال أثناء الإرسال (${reason})`);
    for (const cb of set) cb(err);
    this.pendingSendAborts.delete(gen);
  }

  /** Derived health state — richer than WAStatus */
  get extendedStatus(): WAHealthState {
    if (this.consecutiveSendFailures >= 3) return "stale";
    if (this.consecutiveSendFailures >= 1 && this.state.status === "connected") return "degraded";
    if (this.loggedOutRetries >= 3) return "broken_session";
    return this.state.status;
  }

  private discoveredPhones = new Set<string>();

  // ── Sync diagnostics (reset on each new socket) ──────────────────
  syncStats = {
    sessionId:         0,       // socketGeneration at the time
    connectedAt:       null as Date | null,
    syncType:          "unknown",
    // chats.set (deprecated, may fire in some versions)
    chatsSetCount:     0,
    // chats.upsert — fires on every connect with available chats
    chatsUpsertBatches: 0,
    chatsUpsertTotal:   0,
    chatsUpsertIndividual: 0,   // @s.whatsapp.net only
    // messaging-history.set — fires during FULL sync (new QR) only
    historySetBatches:  0,
    historyChatsTotal:  0,
    historyChatsIndividual: 0,
    historyContactsTotal: 0,
    historyMessagesTotal: 0,
    historyIncomingInserted: 0,
    // contacts.upsert — fires with phonebook sync
    contactsUpsertBatches: 0,
    contactsUpsertTotal: 0,
    // flushed to DB
    contactsFlushedToDb: 0,
    convsFlushedToDb: 0,
    // first/last JIDs seen in chats
    firstJids:  [] as string[],
    lastJids:   [] as string[],
  };

  private recordJid(jid: string) {
    if (this.syncStats.firstJids.length < 20) this.syncStats.firstJids.push(jid);
    // keep a rolling last-20 list
    this.syncStats.lastJids.push(jid);
    if (this.syncStats.lastJids.length > 20) this.syncStats.lastJids.shift();
  }

  // Extended contact store: phone → {name, lastMessageAt (unix s), source}
  // مخزَّن في الذاكرة + PostgreSQL (يبقى بعد إعادة التشغيل)
  private contactStore = new Map<string, { name?: string; lastMessageAt: number; source: "phonebook" | "chat" }>();
  private dbFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpserts = new Map<string, { name?: string; lastMessageAt: number; source: "phonebook" | "chat" }>();
  // @lid → phone lookup (populated from contacts.upsert and messaging-history.set contacts)
  private lidToPhone = new Map<string, string>();

  constructor(userId: number) {
    this.userId     = userId;
    this.sessionDir = path.join(BASE_SESSION_DIR, String(userId));
    this.log        = appLogger.child({ userId });
    // تحميل جهات الاتصال من PostgreSQL فوراً
    this.loadContactsFromDb().catch(() => {});
    // Start watchdog immediately — re-connects if session exists but we're offline
    this.startWatchdog();
    // Start health monitor — detects stuck reconnecting states
    this.startHealthMonitor();
  }

  // ── Contact store: PostgreSQL-backed (يبقى بعد إعادة التشغيل) ───

  private async loadContactsFromDb() {
    try {
      const rows = await db
        .select()
        .from(waContactsTable)
        .where(eq(waContactsTable.userId, this.userId));
      for (const row of rows) {
        const entry = {
          name:          row.name ?? undefined,
          lastMessageAt: row.lastMessageAt ?? 0,
          source:        (row.source ?? "chat") as "phonebook" | "chat",
        };
        this.contactStore.set(row.phone, entry);
        this.discoveredPhones.add(row.phone);
      }
      if (rows.length > 0) {
        this.log.info({ count: rows.length }, "contact store loaded from DB");
      }
    } catch (err) {
      this.log.error({ err }, "failed to load contacts from DB");
    }
  }

  // أضِف/حدِّث جهات الاتصال في الذاكرة وجدوِل كتابتها إلى DB (مُدمَجة بعد 2 ثانية)
  private upsertContact(phone: string, data: { name?: string; lastMessageAt: number; source: "phonebook" | "chat" }) {
    // حماية نهائية — أي رقم يحتوي @ (مثل @lid أو @s.whatsapp.net) يُرفض هنا
    if (!phone || phone.includes("@")) return;
    const existing = this.contactStore.get(phone);
    const merged = {
      name:          data.name || existing?.name,
      lastMessageAt: Math.max(data.lastMessageAt, existing?.lastMessageAt ?? 0),
      source:        (existing?.source === "phonebook" ? "phonebook" : data.source) as "phonebook" | "chat",
    };
    this.contactStore.set(phone, merged);
    this.discoveredPhones.add(phone);
    this.pendingUpserts.set(phone, merged);
    this.scheduleDbFlush();
  }

  private scheduleDbFlush() {
    if (this.dbFlushTimer) return;
    this.dbFlushTimer = setTimeout(() => {
      this.dbFlushTimer = null;
      const toWrite = new Map(this.pendingUpserts);
      this.pendingUpserts.clear();
      this.writeContactsToDb(toWrite).catch((err) => this.log.error({ err }, "scheduleDbFlush write error"));
    }, 500);
  }

  // flush all pending contacts to DB immediately (bypasses debounce)
  private flushPendingContactsNow() {
    if (this.dbFlushTimer) { clearTimeout(this.dbFlushTimer); this.dbFlushTimer = null; }
    const toWrite = new Map(this.pendingUpserts);
    this.pendingUpserts.clear();
    if (toWrite.size > 0) {
      this.writeContactsToDb(toWrite).catch((err) => this.log.error({ err }, "flushPendingContactsNow error"));
    }
  }

  // flush all pending conversations to DB immediately (bypasses debounce)
  private flushPendingConvsNow() {
    if (this.convFlushTimer) { clearTimeout(this.convFlushTimer); this.convFlushTimer = null; }
    const toWrite = new Map(this.pendingConvUpserts);
    this.pendingConvUpserts.clear();
    if (toWrite.size > 0) {
      this.writeConversationsToDb(toWrite).catch((err) => this.log.error({ err }, "flushPendingConvsNow error"));
    }
  }

  // ── Conversations store (ALL chats — صادرة + واردة) ─────────────
  private pendingConvUpserts = new Map<string, { name?: string; lastMsgAt: number; lastText?: string }>();
  private convFlushTimer: ReturnType<typeof setTimeout> | null = null;

  upsertConversation(phone: string, data: { name?: string; lastMsgAt: number; lastText?: string }) {
    const existing = this.pendingConvUpserts.get(phone);
    const merged = {
      name:       data.name || existing?.name,
      lastMsgAt:  Math.max(data.lastMsgAt, existing?.lastMsgAt ?? 0),
      lastText:   data.lastMsgAt >= (existing?.lastMsgAt ?? 0) ? (data.lastText ?? existing?.lastText) : existing?.lastText,
    };
    this.pendingConvUpserts.set(phone, merged);
    if (!this.convFlushTimer) {
      this.convFlushTimer = setTimeout(() => {
        this.convFlushTimer = null;
        const toWrite = new Map(this.pendingConvUpserts);
        this.pendingConvUpserts.clear();
        this.writeConversationsToDb(toWrite).catch(() => {});
      }, 2_000);
    }
  }

  private async writeConversationsToDb(entries: Map<string, { name?: string; lastMsgAt: number; lastText?: string }>) {
    if (entries.size === 0) return;
    // Counted after the write, not before: these counters previously reported
    // thousands of synced chats while every insert was being rejected.
    const rows = Array.from(entries.entries())
      .filter(([phone]) => !phone.includes("@"))  // تجاهل @lid / @s.whatsapp.net
      .map(([phone, d]) => ({
      userId:    this.userId,
      phone,
      name:      d.name ?? null,
      lastMsgAt: new Date(d.lastMsgAt * 1000),
      lastText:  d.lastText ?? null,
      msgCount:  1,
      updatedAt: new Date(),
    }));
    const CHUNK = 500;
    let written = 0, failed = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db
        .insert(waConversationsTable)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [waConversationsTable.userId, waConversationsTable.phone],
          set: {
            name:      sql`CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE wa_conversations.name END`,
            lastMsgAt: sql`GREATEST(excluded.last_msg_at, wa_conversations.last_msg_at)`,
            lastText:  sql`CASE WHEN excluded.last_msg_at >= wa_conversations.last_msg_at THEN excluded.last_text ELSE wa_conversations.last_text END`,
            msgCount:  sql`wa_conversations.msg_count + 1`,
            updatedAt: sql`NOW()`,
          },
        })
        .then(() => { written += rows.slice(i, i + CHUNK).length; })
        .catch((err) => {
          failed += rows.slice(i, i + CHUNK).length;
          this.log.error(
            { err, batchSize: rows.slice(i, i + CHUNK).length },
            "CRITICAL: conversations DB write failed — is the (user_id, phone) primary key present? see lib/db/migrations/002_sync_constraints.sql",
          );
        });
    }
    this.syncStats.convsFlushedToDb += written;
    if (failed > 0) this.log.error({ written, failed }, "conversations flush INCOMPLETE");
    else            this.log.info({ count: written }, "conversations flushed to DB ✓");
  }

  private async writeContactsToDb(entries: Map<string, { name?: string; lastMessageAt: number; source: "phonebook" | "chat" }>) {
    if (entries.size === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const rows = Array.from(entries.entries())
      .filter(([phone]) => !phone.includes("@"))
      .map(([phone, d]) => ({
        userId:        this.userId,
        phone,
        name:          d.name ?? null,
        lastMessageAt: d.lastMessageAt || now,
        source:        d.source,
      }));
    if (rows.length === 0) return;
    let written = 0, failed = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      await db
        .insert(waContactsTable)
        .values(batch)
        .onConflictDoUpdate({
          target: [waContactsTable.userId, waContactsTable.phone],
          set: {
            name:          sql`CASE WHEN excluded.name IS NOT NULL THEN excluded.name ELSE wa_contacts.name END`,
            lastMessageAt: sql`GREATEST(excluded.last_message_at, wa_contacts.last_message_at)`,
            source:        sql`CASE WHEN excluded.source = 'phonebook' THEN 'phonebook' ELSE wa_contacts.source END`,
            updatedAt:     sql`NOW()`,
          },
        })
        .then(() => { written += batch.length; })
        .catch((err) => {
          failed += batch.length;
          this.log.error(
            { err, batchSize: batch.length },
            "CRITICAL: contacts DB write failed — is the (user_id, phone) primary key present? see lib/db/migrations/002_sync_constraints.sql",
          );
        });
    }
    this.syncStats.contactsFlushedToDb += written;
    if (failed > 0) this.log.error({ written, failed }, "contacts flush INCOMPLETE");
    else            this.log.info({ count: written }, "contacts flushed to DB ✓");
  }

  // المزامنة الفورية — تُكتب كل جهات الاتصال الحالية إلى DB الآن
  private async flushAllContactsToDb() {
    await this.writeContactsToDb(new Map(this.contactStore.entries()));
  }

  // ── Status accessors ────────────────────────────────────────────

  getStatus() {
    // Include live QR so the frontend doesn't need a second round-trip
    return {
      status:          this.state.status,
      connected:       this.state.connected,
      phone:           this.state.phone,
      name:            this.state.name,
      qr:              this.state.qr ?? null,
      loggedOutRetries: this.loggedOutRetries,
    };
  }

  getQr() { return { qr: this.state.qr, status: this.state.status }; }

  getDiscoveredPhones(): string[] {
    return Array.from(this.discoveredPhones);
  }

  getContactStore(): { phone: string; name?: string; lastMessageAt: number; source: "phonebook" | "chat" }[] {
    // نُرجع فقط الأرقام الحقيقية — نتجاهل أي @lid أو @s.whatsapp.net تسرّب للذاكرة
    const result: { phone: string; name?: string; lastMessageAt: number; source: "phonebook" | "chat" }[] = [];
    for (const [phone, data] of this.contactStore.entries()) {
      if (phone.includes("@")) continue; // @lid / @s.whatsapp.net / etc
      result.push({ phone, ...data });
    }
    return result;
  }

  getHealth() {
    const uptimeSeconds = this.connectedAt
      ? Math.floor((Date.now() - this.connectedAt.getTime()) / 1000)
      : null;
    return {
      status:                this.state.status,
      extendedStatus:        this.extendedStatus,
      connected:             this.state.connected,
      phone:                 this.state.phone,
      name:                  this.state.name,
      connectedAt:           this.connectedAt?.toISOString() ?? null,
      uptimeSeconds,
      reconnectCount:        this.reconnectCount,
      lastActivityAt:        this.lastActivityAt.toISOString(),
      lastEventAt:           this.lastEventReceivedAt.toISOString(),
      lastInboundAt:         this.lastInboundMessageAt?.toISOString() ?? null,
      awaitingRescanSince:   this.awaitingRescanSince?.toISOString() ?? null,
      lastStableAt:          this.lastStableAt?.toISOString() ?? null,
      lastSuccessfulSendAt:  this.lastSuccessfulSendAt?.toISOString() ?? null,
      consecutiveSendFailures: this.consecutiveSendFailures,
    };
  }

  // ── Diagnostic helpers ───────────────────────────────────────────

  /** Register a listener for the live diagnostic SSE stream. Returns unsubscribe fn. */
  registerDiagListener(fn: (event: { type: string; data: unknown; ts: string }) => void): () => void {
    this.diagListeners.push(fn);
    return () => {
      const idx = this.diagListeners.indexOf(fn);
      if (idx !== -1) this.diagListeners.splice(idx, 1);
    };
  }

  private emitDiag(type: string, data: unknown) {
    if (this.diagListeners.length === 0) return;
    const event = { type, data, ts: new Date().toISOString() };
    for (const fn of this.diagListeners) {
      try { fn(event); } catch { /* never let a broken listener crash the WA service */ }
    }
  }

  /** Full WA state dump for System Diagnostics page */
  getDiagnosticState() {
    const sock = this.state.socket as any;
    const ws   = sock?.ws;
    const creds = sock?.authState?.creds ?? {};
    const wsLabels = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    return {
      socketExists:     !!sock,
      socketGeneration: this.socketGeneration,
      wsReadyState:     typeof ws?.readyState === "number" ? ws.readyState : null,
      wsReadyStateLabel: wsLabels[ws?.readyState as number] ?? "UNKNOWN",
      connectionState:  this.state.status,
      connected:        this.state.connected,
      phone:            this.state.phone,
      name:             this.state.name,
      reconnectCount:   this.reconnectCount,
      connectedAt:      this.connectedAt?.toISOString() ?? null,
      lastActivityAt:   this.lastActivityAt.toISOString(),
      lastEventAt:      this.lastEventReceivedAt.toISOString(),
      lastInboundAt:    this.lastInboundMessageAt?.toISOString() ?? null,
      lastSuccessfulSendAt: this.lastSuccessfulSendAt?.toISOString() ?? null,
      consecutiveSendFailures: this.consecutiveSendFailures,
      loggedOutRetries: this.loggedOutRetries,
      extendedStatus:   this.extendedStatus,
      socketUser:       sock?.user ?? null,
      authState: {
        registered:        creds.registered ?? null,
        me:                creds.me?.id ?? null,
        platform:          creds.platform ?? null,
        registrationId:    creds.registrationId ?? null,
        noiseKey:          creds.noiseKey          ? "✓ present" : "✗ missing",
        signedIdentityKey: creds.signedIdentityKey ? "✓ present" : "✗ missing",
        signedPreKey:      creds.signedPreKey       ? "✓ present" : "✗ missing",
        account:           creds.account            ? "✓ present" : "✗ missing",
        deviceId:          creds.deviceId ?? null,
        serverHasPreKeys:  creds.serverHasPreKeys ?? null,
      },
      diagListenerCount: this.diagListeners.length,
    };
  }

  /**
   * Direct send — bypasses ALL campaign/queue/simulation/anti-ban logic.
   * Calls sock.sendMessage() directly and waits for messages.upsert confirmation.
   * Returns a step-by-step trace so we can see EXACTLY where it fails.
   */
  /**
   * Bulk-check which numbers actually exist on WhatsApp.
   *
   * The per-send check already rejects dead numbers, but only after the
   * campaign has spent a slot on them: a list that is 20% junk burns 20% of
   * the daily allowance on nothing and pushes up the failure rate that gets
   * numbers banned. Running this first turns that into a one-off cleanup.
   *
   * Returns one entry per input number. `exists: null` means the check could
   * not be completed (network/timeout) — callers must treat that as "unknown"
   * and leave the contact alone rather than marking it invalid.
   */
  async checkNumbers(
    phones: string[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<Array<{ phone: string; exists: boolean | null }>> {
    if (!this.state.socket || !this.state.connected) {
      throw new Error("WA_DISCONNECTED: واتساب غير متصل — لا يمكن فحص الأرقام");
    }

    const CHUNK = 25;
    const out: Array<{ phone: string; exists: boolean | null }> = [];

    for (let i = 0; i < phones.length; i += CHUNK) {
      const batch = phones.slice(i, i + CHUNK);

      try {
        const res = await Promise.race([
          this.state.socket.onWhatsApp(...batch),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("ONWHATSAPP_TIMEOUT")), 20_000)
          ),
        ]);

        // WA answers only for numbers it recognises, and the jid it echoes back
        // can be normalised, so match on the leading digits rather than equality.
        const found = new Map<string, boolean>();
        for (const r of (res ?? []) as Array<{ jid?: string; exists?: boolean }>) {
          const digits = String(r.jid ?? "").split("@")[0]?.replace(/\D/g, "") ?? "";
          if (digits) found.set(digits, !!r.exists);
        }

        for (const phone of batch) {
          const digits = phone.replace(/\D/g, "");
          out.push({ phone, exists: found.has(digits) ? found.get(digits)! : false });
        }
      } catch (err) {
        // Unknown, not absent — do not let a timeout delete someone's contacts.
        this.log.warn({ err, batchStart: i }, "checkNumbers batch failed — marking unknown");
        for (const phone of batch) out.push({ phone, exists: null });
      }

      onProgress?.(Math.min(i + CHUNK, phones.length), phones.length);

      // Pace the queries — this is a bulk lookup, not a burst.
      if (i + CHUNK < phones.length) {
        await new Promise((r) => setTimeout(r, 1_200 + Math.random() * 800));
      }
    }

    return out;
  }

  async directSend(phone: string, message: string): Promise<{
    steps: Array<{ step: number; label: string; ok: boolean; detail?: string }>;
    msgId: string | null;
    ghostSend: boolean;
    upsertReceived: boolean;
    updateReceived: boolean;
  }> {
    const steps: Array<{ step: number; label: string; ok: boolean; detail?: string }> = [];
    let n = 0;
    const pass = (label: string, detail?: string) => steps.push({ step: ++n, label, ok: true, detail });
    const fail = (label: string, detail: string): never => {
      steps.push({ step: ++n, label, ok: false, detail });
      const err = Object.assign(new Error(detail), { steps });
      throw err;
    };

    pass("[1] API Received");

    if (!this.state.socket) fail("[2] Socket Found", "لا يوجد socket — الجلسة غير مُهيَّأة بعد");
    pass("[2] Socket Found", `socketGeneration=${this.socketGeneration}`);

    if (!this.state.connected) fail("[3] Connection State", `status=${this.state.status} — غير متصل`);
    pass("[3] Connection State", `status=${this.state.status}`);

    const ws = (this.state.socket as any)?.ws;
    const wsRS = typeof ws?.readyState === "number" ? ws.readyState : null;
    if (wsRS !== null && wsRS !== 1) fail("[4] WS ReadyState = OPEN", `readyState=${wsRS} (expected 1=OPEN)`);
    pass("[4] WS ReadyState = OPEN", wsRS !== null ? `readyState=${wsRS}` : "readyState=unknown (Baileys internal)");

    let cleaned = phone.replace(/[\s\-\+\(\)]/g, "");
    if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
    const jid = cleaned + "@s.whatsapp.net";
    pass("[5] JID Formatted", jid);

    pass("[6] sock.sendMessage() Called", `jid=${jid}`);

    let result: any;
    try {
      result = await Promise.race([
        this.state.socket!.sendMessage(jid, { text: message }),
        new Promise<never>((_, rej) => setTimeout(
          () => rej(new Error("SEND_TIMEOUT — لم يستجب Baileys خلال 30 ثانية")),
          30_000
        )),
      ]);
    } catch (e: any) {
      if ((e as any)?.steps) throw e;
      fail("[7] Promise Resolved", `FAILED: ${e?.message ?? String(e)}`);
    }

    pass("[7] Promise Resolved", "sendMessage() عاد بدون استثناء");

    if (!result) fail("[8] Returned Message", "sendMessage() أعاد undefined/null");
    pass("[8] Returned Message", `key=${JSON.stringify(result?.key ?? null)}`);

    const msgId: string | null = result?.key?.id ?? null;
    this.rememberSent(msgId);
    if (!msgId) {
      steps.push({ step: ++n, label: "[9] Returned Message ID", ok: false, detail: "NO MESSAGE ID — ghost-send محتمل" });
    } else {
      pass("[9] Returned Message ID", msgId);
    }

    const fromMe: boolean | null = result?.key?.fromMe ?? null;
    if (fromMe === false) {
      steps.push({ step: ++n, label: "[10] fromMe = true", ok: false, detail: "fromMe=false — الرسالة منسوبة لشخص آخر!" });
    } else {
      pass("[10] fromMe = true", `fromMe=${fromMe}`);
    }

    // Wait up to 15 s for messages.upsert / messages.update confirmation
    let upsertReceived = false;
    let updateReceived = false;

    if (msgId) {
      steps.push({ step: ++n, label: "[11] messages.upsert", ok: false, detail: "انتظار تأكيد Baileys (15 ثانية)..." });
      const upsertIdx = steps.length - 1;
      steps.push({ step: ++n, label: "[12] messages.update", ok: false, detail: "انتظار إشعار التسليم (15 ثانية)..." });
      const updateIdx = steps.length - 1;

      await new Promise<void>((resolve) => {
        let unsub: (() => void) | undefined;
        const timer = setTimeout(() => { unsub?.(); resolve(); }, 15_000);
        unsub = this.registerDiagListener((event) => {
          if (event.type === "messages.upsert") {
            const msgs: any[] = (event.data as any)?.messages ?? [];
            if (msgs.some((m: any) => m?.key?.id === msgId)) {
              upsertReceived = true;
              steps[upsertIdx] = { step: steps[upsertIdx]!.step, label: "[11] messages.upsert ✓", ok: true, detail: `received msgId=${msgId}` };
            }
          }
          if (event.type === "messages.update") {
            const updates: any[] = Array.isArray(event.data) ? event.data : [];
            if (updates.some((u: any) => u?.key?.id === msgId)) {
              updateReceived = true;
              steps[updateIdx] = { step: steps[updateIdx]!.step, label: "[12] messages.update ✓", ok: true, detail: `received msgId=${msgId}` };
            }
          }
          if (upsertReceived && updateReceived) { clearTimeout(timer); unsub?.(); resolve(); }
        });
      });

      if (!upsertReceived) {
        steps[upsertIdx] = { step: steps[upsertIdx]!.step, label: "[11] messages.upsert", ok: false, detail: "NO UPSERT RECEIVED — انتهت المهلة 15 ثانية" };
      }
      if (!updateReceived) {
        steps[updateIdx] = { step: steps[updateIdx]!.step, label: "[12] messages.update", ok: false, detail: "NO UPDATE RECEIVED — انتهت المهلة 15 ثانية" };
      }
    }

    const ghostSend = !msgId || !upsertReceived;
    return { steps, msgId, ghostSend, upsertReceived, updateReceived };
  }

  /** Validate session components — returns check-by-check results */
  validateSession() {
    const sock = this.state.socket as any;
    const creds = sock?.authState?.creds ?? {};
    const checks: Array<{ name: string; ok: boolean; value: string }> = [
      { name: "authState loaded",    ok: !!sock?.authState,             value: sock?.authState ? "✓ Loaded" : "✗ Missing" },
      { name: "creds.registered",    ok: creds.registered === true,     value: String(creds.registered ?? "missing") },
      { name: "creds.me (phone id)", ok: !!creds.me?.id,               value: creds.me?.id ?? "✗ missing" },
      { name: "noiseKey",            ok: !!creds.noiseKey,              value: creds.noiseKey ? "✓ Present" : "✗ Missing" },
      { name: "signedIdentityKey",   ok: !!creds.signedIdentityKey,     value: creds.signedIdentityKey ? "✓ Present" : "✗ Missing" },
      { name: "signedPreKey",        ok: !!creds.signedPreKey,          value: creds.signedPreKey ? "✓ Present" : "✗ Missing" },
      { name: "account (companion)", ok: !!creds.account,               value: creds.account ? "✓ Present" : "✗ Missing" },
      { name: "deviceId",            ok: !!creds.deviceId,              value: String(creds.deviceId ?? "✗ missing") },
      { name: "platform",            ok: !!creds.platform,              value: String(creds.platform ?? "✗ missing") },
      { name: "serverHasPreKeys",    ok: creds.serverHasPreKeys === true, value: String(creds.serverHasPreKeys ?? "unknown") },
      { name: "WS socket OPEN",      ok: sock?.ws?.readyState === 1,    value: `readyState=${sock?.ws?.readyState ?? "N/A"}` },
    ];
    return { checks, allOk: checks.every((c) => c.ok) };
  }

  // ── Event logging ───────────────────────────────────────────────

  private async logEvent(event: string, detail?: string) {
    try {
      await db.insert(waSessionEventsTable).values({ userId: this.userId, event, detail: detail ?? null });
    } catch (err) {
      this.log.warn({ err }, "Failed to log WA session event");
    }
  }

  // ── Reconnect & keep-alive ──────────────────────────────────────

  private scheduleReconnect(delayMs = 3_000) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    // Add ±30% random jitter so WA's traffic analyser never sees a fixed
    // reconnect interval — a predictable cadence is a strong bot signal.
    const lo = Math.floor(delayMs * 0.70);
    const hi = Math.floor(delayMs * 1.30);
    const actual = lo + Math.floor(Math.random() * (hi - lo + 1));

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.init().catch((err) => this.log.error({ err }, "Reconnect failed"));
    }, actual);
  }

  /**
   * Keepalive — silent, notification-free approach:
   *
   *  Layer 1 (primary):  Baileys WS-level ping every 20 s (keepAliveIntervalMs).
   *    - This is a protocol-level WebSocket/TCP ping.
   *    - Sufficient to keep the socket alive indefinitely without any app noise.
   *    - Does NOT change presence, does NOT notify contacts, does NOT notify the phone.
   *
   *  Layer 2 (heartbeat): We update lastActivityAt every 30 s so health metrics stay fresh.
   *    - No sendPresenceUpdate — presence updates show the user as "online" to all contacts
   *      AND can trigger "WhatsApp Web connected" notifications on the paired phone.
   *      By removing them we eliminate both the "online indicator" spam and the phone notifs.
   *
   * NOTE: sendPresenceUpdate("available") is still sent per-JID inside simulateHumanPresence()
   *       before each real message — that is intentional for anti-ban typng simulation.
   *       We ONLY removed the global (no JID) periodic presence broadcasts.
   */
  private startKeepAlive() {
    this.stopKeepAlive();

    // Layer 2: heartbeat every 30 s.
    //   a) Update lastActivityAt for health metrics.
    //   b) Check the underlying WebSocket readyState.
    //
    // Only force a rebuild when readyState === 3 (CLOSED — socket is fully dead).
    // Do NOT trigger on readyState === 0 (CONNECTING) or 2 (CLOSING): those are
    // transient states during Baileys' own reconnect cycle.  Interfering at that
    // point causes a "double reconnect" storm (our rebuild races Baileys' own).
    //
    // WS readyState values: 0=CONNECTING  1=OPEN  2=CLOSING  3=CLOSED
    this.keepAliveTimer = setInterval(() => {
      if (!this.state.connected || !this.state.socket) return;
      this.lastActivityAt = new Date();

      const ws = (this.state.socket as any)?.ws;
      if (ws && ws.readyState === 3 /* CLOSED */) {
        this.log.warn(
          { readyState: ws.readyState },
          "Keepalive: WS CLOSED while connected — silent socket death detected, forcing rebuild"
        );
        this.forceFullRebuild("ws_closed");
      }
    }, 30_000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    if (this.onlineTimer)    { clearInterval(this.onlineTimer);    this.onlineTimer    = null; }
  }

  /**
   * Watchdog — runs every 30 seconds (was 60 s).
   * If a saved session exists but we are not connected (and not already trying),
   * trigger an immediate reconnect. Halving the interval means disconnections
   * are detected and healed within 30 s instead of a full minute.
   */
  private startWatchdog() {
    if (this.watchdogTimer) return; // already running
    this.watchdogTimer = setInterval(async () => {
      if (this.manualLogout) return;
      if (this.state.connected) return;
      // Already in a transition state — let Baileys finish before interfering
      if (this.state.status === "connecting" || this.state.status === "qr_ready") return;
      // "reconnecting" with a pending timer — don't double-schedule
      if (this.reconnectTimer) return;

      // If status is "reconnecting" but no timer is pending AND not connected,
      // it means a reconnect attempt silently failed — reset and try again.
      // (e.g. Baileys threw before scheduling the next connect)
      if (this.state.status === "reconnecting") {
        this.log.warn("Watchdog: stuck in reconnecting with no timer — forcing new reconnect");
        this.state.status = "disconnected";
      }

      try {
        const rows = await db
          .select({ key: waAuthStateTable.key })
          .from(waAuthStateTable)
          .where(and(
            eq(waAuthStateTable.userId, this.userId),
            eq(waAuthStateTable.key, "creds.json"),
          ))
          .limit(1);
        if (!rows.length) return; // no saved session in DB — nothing to restore
      } catch {
        return; // DB temporarily unreachable — skip this cycle, retry in 30s
      }

      this.log.warn("Watchdog: DB session exists but not connected — triggering reconnect");
      this.scheduleReconnect(2_000);
    }, 30_000);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  }

  // ── Connection Health Monitor ─────────────────────────────────────
  /**
   * Runs every 60 seconds.
   * Purpose: detect scenarios where the socket claims "connected" but is
   * actually dead (silent failure — WS keepalive passes but WA server dropped us).
   * Also detects being stuck in "reconnecting" for > 10 minutes, which usually
   * means the session is no longer valid and we need to force a fresh init.
   */
  private startHealthMonitor() {
    this.stopHealthMonitor();
    this.healthTimer = setInterval(async () => {
      // ── Case 1: Stuck in "reconnecting" for more than 10 minutes ─────
      if (
        this.state.status === "reconnecting" &&
        this.reconnectingStartedAt &&
        Date.now() - this.reconnectingStartedAt > 10 * 60_000 &&
        !this.reconnectTimer
      ) {
        this.log.warn(
          { stuckMinutes: Math.round((Date.now() - this.reconnectingStartedAt) / 60_000) },
          "Health monitor: stuck in reconnecting >10 min — forcing fresh init"
        );
        this.consecutiveReconnectFails = 0;
        this.loggedOutRetries = 0;
        this.reconnectingStartedAt = null;
        this.state.status = "disconnected";
        this.scheduleReconnect(2_000);
        return;
      }

      // ── Case 2: Stale session — socket appears connected but keeps failing ──
      // If we have ≥3 consecutive send failures while showing "connected",
      // the socket may be silently dead. Do a SOFT reconnect (close + reconnect
      // with existing credentials) rather than forceFullRebuild (which creates
      // a new device session and requires a QR rescan).
      if (this.state.connected && this.consecutiveSendFailures >= 5) {
        this.log.warn(
          { consecutiveSendFailures: this.consecutiveSendFailures },
          "Health monitor: silent failure detected — soft reconnect (preserving credentials)"
        );
        this.consecutiveSendFailures = 0;
        if (this.state.socket) {
          try { (this.state.socket as any).ws?.close(); } catch {}
          this.state.socket = null;
        }
        this.state.status = "disconnected";
        this.state.connected = false;
        this.scheduleReconnect(3_000);
        return;
      }

      // ── Case 3: Long idle with no successful sends ─────────────────────────
      // Skip this check entirely — it was causing premature rebuilds during
      // campaign execution. The campaign loop and WA_DISCONNECTED handler
      // manage reconnection themselves.

      // ── Case 4: Connected — update lastActivityAt ─────────────────────
      if (this.state.connected) {
        this.lastActivityAt = new Date();
      }

      // ── Case 5: Deep idle — connected but no Baileys events for >90 min ──
      // After a long absence the socket may appear connected but WA server
      // may have dropped us silently.  Without an active campaign, send
      // failures never fire to trigger a rebuild.
      //
      // KEY STABILITY FIX: Before doing a full rebuild (which creates a NEW device
      // connection and triggers "Connected from another device" on the phone),
      // first check if the underlying WebSocket is still OPEN.  If the WS is OPEN,
      // the TCP connection is alive — WA just hasn't sent any events (normal during
      // quiet periods).  In that case we reset the idle timer without disrupting the
      // session.  Only rebuild if the WS is actually not OPEN (socket died silently).
      const DEEP_IDLE_MS = 90 * 60_000; // 90 minutes
      if (
        this.state.connected &&
        Date.now() - this.lastEventReceivedAt.getTime() > DEEP_IDLE_MS
      ) {
        const ws = (this.state.socket as any)?.ws;
        const wsState = ws?.readyState ?? -1;
        if (wsState === 1 /* OPEN */) {
          // WS is alive — this is a quiet period, not a dead socket.
          // Reset the idle timer so we don't fire again immediately.
          this.lastEventReceivedAt = new Date();
          this.lastActivityAt = new Date();
          this.log.info(
            { idleMinutes: Math.round((Date.now() - this.lastEventReceivedAt.getTime()) / 60_000) },
            "Health monitor: deep idle but WS is OPEN — session alive, resetting idle timer"
          );
        } else {
          this.log.warn(
            { idleMinutes: Math.round((Date.now() - this.lastEventReceivedAt.getTime()) / 60_000), wsState },
            "Health monitor: no Baileys events for >90 min AND WS not OPEN — forcing rebuild"
          );
          this.forceFullRebuild("deep_idle");
          return;
        }
      }

      // ── Case 6: Protocol-level liveness probe ──────────────────────────
      // WS-level keepalive (8 s ping) proves TCP is alive but NOT that the
      // WA application layer is still accepting the session.  WA can silently
      // drop a session at the protocol level while the TCP connection remains
      // open.  We detect this by sending a lightweight WA query every 30 min
      // when the socket has been idle.
      //
      // STABILITY FIX: Only probe if WS readyState is OPEN (avoids false
      // alarms during reconnect windows). On failure, only forceFullRebuild
      // for definitive auth errors — transient errors (timeout, network blip)
      // are ignored because they can occur on healthy sessions under load.
      const PROBE_IDLE_MS = 30 * 60_000; // probe if idle > 30 min (was 15 min)
      if (
        this.state.connected &&
        this.state.socket &&
        Date.now() - this.lastActivityAt.getTime() > PROBE_IDLE_MS
      ) {
        const ws = (this.state.socket as any)?.ws;
        if (ws?.readyState !== 1) {
          // WS not OPEN — skip probe, keepalive will handle this
          return;
        }
        try {
          await (this.state.socket as any).fetchBlocklist?.();
          // Probe succeeded — reset both idle timers
          this.lastActivityAt      = new Date();
          this.lastEventReceivedAt = new Date();
          this.log.debug("Protocol probe: WA session is alive ✓");
        } catch (err: any) {
          const msg = (err?.message ?? "").toLowerCase();
          // Only rebuild on definitive auth failures — NOT on generic timeouts
          const isAuthError =
            msg.includes("loggedout") ||
            (msg.includes("logged") && msg.includes("out")) ||
            msg.includes("401") ||
            msg.includes("unauthorized");
          if (isAuthError) {
            this.log.warn({ err: err?.message }, "Protocol probe: definitive auth error — forcing rebuild");
            this.forceFullRebuild("probe_auth_failure");
          } else {
            // Transient error (timeout, stream reset, network blip) — ignore
            // The deep_idle + consecutiveSendFailures checks catch real failures.
            this.log.info({ err: err?.message }, "Protocol probe: transient error ignored — session likely still alive");
          }
        }
      }
    }, 60_000);
  }

  private stopHealthMonitor() {
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
  }

  // ── Session Guardian: Force Full Socket Rebuild ───────────────────
  /**
   * More aggressive than scheduleReconnect() — closes the socket entirely,
   * resets all state, and forces a fresh init().
   *
   * Use when: connected socket cannot actually send (silent failure / stale).
   * Unlike scheduleReconnect, this bypasses the init() idempotency check by
   * forcibly setting status = "disconnected" before scheduling.
   */
  private forceFullRebuild(reason = "guardian") {
    this.log.warn({ reason, consecutiveFails: this.consecutiveSendFailures }, "Session Guardian: forcing full socket rebuild");
    this.consecutiveSendFailures = 0;
    this.consecutiveReconnectFails = 0;
    this.reconnectingStartedAt = null;
    // Cancel any pending reconnect timer
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    // Force-close existing socket
    if (this.state.socket) {
      try { (this.state.socket as any).ws?.close(); } catch {}
      this.state.socket = null;
    }
    // Force state to disconnected so init() doesn't early-return
    this.state.status = "disconnected";
    this.state.connected = false;
    // Schedule a fresh init with a short delay
    this.scheduleReconnect(3_000);
    this.logEvent("guardian_rebuild", `reason=${reason}`).catch(() => {});
  }

  // ── Core init ───────────────────────────────────────────────────

  async init() {
    // Idempotent: don't restart an already-running session
    if (
      this.state.status === "connecting" ||
      this.state.status === "connected"  ||
      this.state.status === "qr_ready"
    ) return;

    // ── Close stale socket before creating a new one ─────────────
    // Without this, the old socket keeps firing events (especially "close")
    // that corrupt state and inflate loggedOutRetries — the root cause of
    // premature session clearing.
    if (this.state.socket) {
      try { (this.state.socket as any).ws?.close(); } catch {}
      this.state.socket = null;
    }

    if (!fs.existsSync(this.sessionDir)) fs.mkdirSync(this.sessionDir, { recursive: true });

    // Claim a generation slot BEFORE the async auth load so the idempotency
    // check above stays valid even if two concurrent init() calls race.
    const myGen = ++this.socketGeneration;

    // Reset sync diagnostics for each new socket session
    this.syncStats = {
      sessionId:              myGen,
      connectedAt:            null,
      syncType:               "unknown",
      chatsSetCount:          0,
      chatsUpsertBatches:     0,
      chatsUpsertTotal:       0,
      chatsUpsertIndividual:  0,
      historySetBatches:      0,
      historyChatsTotal:      0,
      historyChatsIndividual: 0,
      historyContactsTotal:   0,
      historyMessagesTotal:   0,
      historyIncomingInserted: 0,
      contactsUpsertBatches:  0,
      contactsUpsertTotal:    0,
      contactsFlushedToDb:    0,
      convsFlushedToDb:       0,
      firstJids:              [],
      lastJids:               [],
    };

    this.manualLogout = false;
    this.state.status = "connecting";
    this.state.qr     = null;

    // One-time migration: import any existing disk session files into DB
    await migrateSessionFilesToDb(this.userId, this.sessionDir).catch(() => {});

    // Load auth state from PostgreSQL — survives deployments and restarts
    const { state: authState, saveCreds } = await useDatabaseAuthState(this.userId);

    // If another init() overtook us while we awaited, bail out.
    if (myGen !== this.socketGeneration) return;

    // Track whether we started with registered credentials so the qr handler
    // can detect a WA server-side rejection (creds loaded but QR requested).
    const hadRegisteredCreds = (authState.creds as any).registered === true;

    const waVersion = await resolveWaVersion();

    // If another init() overtook us while fetching the version, bail out.
    if (myGen !== this.socketGeneration) return;

    const sock = makeWASocket({
      version: waVersion,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, this.log as any),
      },
      // Do NOT reintroduce a "Desktop" browser name here. The handshake fails
      // two different ways and both were live in this file:
      //   - stale/default client version  -> WA closes with 405
      //   - browser name "Desktop"        -> WA closes with 428, before any QR
      // The previous ["WhatsApp","Desktop","2.2329.9"] tripped both. Verified
      // against WA servers: ubuntu/Chrome, macOS/Safari and windows/Chrome all
      // pair; anything named "Desktop" does not. Trade-off accepted: a normal
      // browser identity means the owner's phone does show the linked-device
      // notice, which the old Desktop string suppressed.
      browser:                    Browsers.ubuntu("Chrome"),
      countryCode:                "AE",
      printQRInTerminal:          false,
      logger:                     this.log as any,
      // The whole chat history per linked number — 963 threads and 1,897
      // messages for one account here. It feeds the contact extractor and
      // it is what the memory of ten tenants would go on. Off with
      // WA_FULL_HISTORY=false when the number of tenants makes it matter.
      syncFullHistory:            process.env["WA_FULL_HISTORY"] !== "false",
      markOnlineOnConnect:        false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs:           60_000,           // 60s — enough patience, avoids hanging too long
      keepAliveIntervalMs:        20_000,           // WS-level ping every 20s — matches real WA Web timing
      defaultQueryTimeoutMs:      20_000,           // 20s — prevents hung WA queries from blocking forever
      retryRequestDelayMs:        500,
      maxMsgRetryCount:           5,
      getMessage: async () => ({ conversation: "" }),
    } as any);

    this.state.socket = sock;

    // Keep the idle clock honest. Without this, lastEventReceivedAt stays at
    // construction time and the deep-idle check never fires however long the
    // socket has been silent — which is how a zombie survived unnoticed.
    {
      const gen = myGen;
      sock.ev.process(async (events) => {
        if (gen !== this.socketGeneration) return;
        this.lastEventReceivedAt = new Date();
        const up = (events as any)["messages.upsert"];
        if (up?.type === "notify") {
          for (const m of up.messages ?? []) {
            if (!m?.key?.fromMe) { this.lastInboundMessageAt = new Date(); break; }
          }
        }
      });
    }

    // ── Raw event tap ─────────────────────────────────────────────
    // WA_DEBUG_EVENTS=true logs every event Baileys emits, before any of our
    // handling. It answers the one question our own logs cannot: when nothing
    // arrives, is the socket receiving and we are dropping it, or is nothing
    // reaching the socket at all? Off by default — it is extremely noisy.
    if (process.env["WA_DEBUG_EVENTS"] === "true") {
      const gen = myGen;
      sock.ev.process(async (events) => {
        if (gen !== this.socketGeneration) return;
        for (const [name, payload] of Object.entries(events)) {
          let detail = "";
          if (name === "messages.upsert") {
            const p = payload as any;
            detail = `type=${p?.type} count=${p?.messages?.length ?? 0} from=${p?.messages?.[0]?.key?.remoteJid ?? "?"} fromMe=${p?.messages?.[0]?.key?.fromMe}`;
          } else if (name === "connection.update") {
            const p = payload as any;
            detail = `connection=${p?.connection ?? "-"} qr=${p?.qr ? "yes" : "no"}`;
          } else if (Array.isArray(payload)) {
            detail = `n=${payload.length}`;
          }
          this.log.info({ rawEvent: name, detail }, "🔌 raw WA event");
        }
      });
    }

    // ── Pairing code: must be called immediately after socket creation ────
    // Baileys requires this BEFORE any QR event fires. We use setImmediate
    // so the event-listener wiring below runs first (otherwise the 'open'
    // handler won't be attached yet), but the call still precedes the first
    // network round-trip that would trigger the QR.
    if (this.pendingPairingPhone) {
      const phone = this.pendingPairingPhone;
      const gen   = myGen;
      setImmediate(async () => {
        if (gen !== this.socketGeneration) return; // stale, ignore
        try {
          const code: string = await (sock as any).requestPairingCode(phone);
          this.lastPairingCode = code;
          this.log.info({ code, phone }, "Pairing code generated successfully");
        } catch (err: any) {
          this.pairingCodeError = err?.message ?? "فشل طلب رمز الربط";
          this.log.error({ err, phone }, "requestPairingCode failed");
        }
      });
    }

    // ── connection.update ─────────────────────────────────────────
    sock.ev.on("connection.update", async (update) => {
      // Guard: ignore events from a stale socket (superseded by a newer init())
      if (myGen !== this.socketGeneration) return;

      const { connection, lastDisconnect, qr } = update;

      // Track last Baileys event for deep idle detection
      this.lastEventReceivedAt = new Date();
      this.emitDiag("connection.update", { connection, lastDisconnect: lastDisconnect?.error?.message ?? null, qr: qr ? "QR_DATA" : null });

      if (qr) {
        try {
          // QR arriving means WA rejected the current session auth.
          // Mark as disconnected immediately so any running campaign
          // does NOT treat the socket as valid and log phantom "sent" records.
          if (this.state.connected) {
            this.log.warn("QR fired while state=connected — session rejected by WA; marking disconnected");
            this.state.connected = false;
            this.state.phone     = null;
            this.state.name      = null;
            this.stopKeepAlive();
          }

          // ── Auto-clear rejected credentials ────────────────────────────────
          // If we HAD registered credentials but WA is asking for QR, it means
          // the server-side session was invalidated (device removed from phone,
          // account restriction, session expired, etc.).
          // Keeping those credentials causes an infinite loop:
          //   load bad creds → connect → QR → expire → reload same bad creds → QR…
          // Fix: delete from DB immediately so the next reconnect starts CLEAN.
          // The current QR is already valid (WA offered a fresh pairing token)
          // and the user can scan it right now without needing to reconnect.
          if (hadRegisteredCreds && this.qrCycleCount === 0) {
            this.log.warn(
              { userId: this.userId },
              "QR fired with registered creds → WA rejected session. Auto-clearing DB auth state to break reconnect loop.",
            );
            db.delete(waAuthStateTable)
              .where(eq(waAuthStateTable.userId, this.userId))
              .catch((err) => this.log.error({ err }, "Failed to auto-clear rejected auth state"));
            try { fs.rmSync(this.sessionDir, { recursive: true }); } catch {}
          }

          this.state.qr     = await qrcode.toDataURL(qr);
          this.state.status = "qr_ready";
          this.log.info("QR ready — waiting for scan");
          await this.logEvent("qr_ready");
          await db.update(usersTable)
            .set({ currentQr: this.state.qr, qrExpiresAt: new Date(Date.now() + 90_000) })
            .where(eq(usersTable.id, this.userId));
        } catch (err) { this.log.error({ err }, "QR generation failed"); }
      }

      if (connection === "open") {
        // Deliberately does NOT clear failuresSinceStable. A connection that
        // dies seconds later is not evidence the credentials are good, and
        // clearing here is what let a connect-die loop run indefinitely — 48
        // "connected" events in a day with nothing ever working.
        const openedAt = Date.now();
        this.recentConnects.push(openedAt);
        this.recentConnects = this.recentConnects.filter((t) => openedAt - t < FLAP_WINDOW_MS);

        setTimeout(() => {
          // Still the same socket, still up: the pairing is genuinely fine.
          if (this.socketGeneration === myGen && this.state.connected) {
            this.failuresSinceStable = 0;
            this.recentConnects = [];
            this.lastStableAt = new Date();
          }
        }, STABLE_AFTER_MS);

        this.awaitingRescanSince     = null;
        this.handshakeRejects        = 0;
        this.loggedOutRetries        = 0;
        this.qrCycleCount            = 0;     // ← reset QR cycle counter on successful auth
        this.consecutiveReconnectFails = 0;   // ← reset backoff counter on success
        this.reconnectingStartedAt   = null;
        this.connectedAt      = new Date();
        this.syncStats.connectedAt = new Date();
        this.lastActivityAt   = new Date();
        this.state.connected  = true;
        this.state.status     = "connected";
        this.state.qr         = null;
        const user = sock.user;
        if (user) {
          this.state.phone = user.id.split(":")[0].split("@")[0];
          this.state.name  = user.name || null;
        }
        this.log.info({ phone: this.state.phone }, "WhatsApp connected");
        await this.logEvent("connected", this.state.phone ?? undefined);
        // Notify campaign loop to auto-resume any paused campaigns for this user
        notifyUserConnected(this.userId);
        db.update(usersTable)
          .set({ currentQr: null, qrExpiresAt: null })
          .where(eq(usersTable.id, this.userId))
          .catch(() => {});
        // ── Delayed keepalive start ─────────────────────────────────
        // Wait 30 s before sending any presence updates.
        // Immediate presence pings on reconnect can trigger WA to push a
        // "Connected from Web" notification to the user's mobile phone.
        // The WS-level keepAliveIntervalMs (20 s) keeps the socket alive
        // during this quiet window without any application-layer presence.
        // 30 s is a safe balance: quiet enough to avoid notifications,
        // short enough that WA doesn't mark the session as dormant.
        setTimeout(() => {
          if (myGen !== this.socketGeneration) return;
          this.startKeepAlive();
          this.log.info("WA keepalive started (30 s delay after connect)");
        }, 30_000);
      }

      if (connection === "close") {
        const boom   = lastDisconnect?.error as Boom | undefined;
        const reason = boom?.output?.statusCode;

        // Fail-fast: reject any sendMessage() calls still in flight on this
        // generation instead of leaving them to hang until the 35 s SEND_TIMEOUT.
        this.abortPendingSends(myGen, `reason=${reason}`);

        this.state.connected = false;
        this.state.phone     = null;
        this.state.name      = null;
        this.state.socket    = null;
        this.connectedAt     = null;
        this.stopKeepAlive();

        this.log.info({ reason, gen: myGen }, "Connection closed");

        // ── Dead-credential breaker ───────────────────────────────
        // Two ways a session becomes unrecoverable without ever saying so:
        // WhatsApp refuses the pairing (401/403/405, and no QR is offered
        // because credentials exist), or it accepts and drops repeatedly so
        // nothing ever holds. Both loop for ever on retries alone.
        if (isRejection(reason)) this.failuresSinceStable++;

        const verdict = assessSession({
          reason,
          failuresSinceStable: this.failuresSinceStable,
          recentConnects: this.recentConnects,
          manualLogout: this.manualLogout,
        });

        if (verdict.repair) {
          const why = verdict.reason ?? "الجلسة غير قابلة للاستخدام";

          this.log.error({ reason, failuresSinceStable: this.failuresSinceStable, connects: this.recentConnects.length },
            "credentials unusable — clearing them so a QR can be issued");
          await this.logEvent("auto_repair", why);

          this.failuresSinceStable = 0;
          this.recentConnects = [];
          this.qrCycleCount = 0;
          this.loggedOutRetries = 0;
          this.consecutiveReconnectFails = 0;

          // Clearing is the whole point: Baileys only offers a QR when there
          // is nothing to restore. Without this the loop never reaches pairing.
          try {
            await db.delete(waAuthStateTable).where(eq(waAuthStateTable.userId, this.userId));
            try { fs.rmSync(this.sessionDir, { recursive: true, force: true }); } catch {}
          } catch (err) {
            this.log.error({ err }, "could not clear auth state");
          }

          this.awaitingRescanSince = new Date();
          this.state.status = "disconnected";
          this.state.qr = null;
          this.scheduleReconnect(3_000);   // comes back up needing a scan
          return;
        }

        if (verdict.cooldown) {
          // Connects that never hold. The old breaker wiped the pairing here
          // and was wrong every time it did: the cause was the host sleeping
          // or a refused client version, and the credentials were fine. So
          // stand back — ten minutes with no attempts, credentials intact —
          // rather than turn an unstable hour into a scan.
          this.recentConnects = [];
          this.consecutiveReconnectFails = 0;
          this.reconnectingStartedAt = null;
          this.state.status = "reconnecting";
          this.state.qr = null;
          this.log.warn({ reason, why: verdict.reason }, "connection will not hold — cooling down before trying again");
          await this.logEvent("cooldown", verdict.reason);
          this.scheduleReconnect(COOLDOWN_MS);
          return;
        }

        if (this.manualLogout) {
          this.state.status = "disconnected";
          this.state.qr     = null;
          await this.logEvent("logged_out");
          return;
        }

        // ── NEVER delete session files automatically ──────────────
        // Deleting the session on loggedOut was the root cause of frequent
        // QR re-prompts.  The session files represent the phone pairing;
        // they stay valid until the user removes the device from their phone
        // Settings → Linked Devices.  We just keep retrying with backoff,
        // exactly like WhatsApp Web does for hours before giving up.
        if (reason === DisconnectReason.loggedOut) {
          this.loggedOutRetries++;

          // ── NEVER auto-delete credentials on loggedOut ──────────────────────
          // Root cause of all "lost connection" issues: auto-deletion of creds
          // after N retries forces a QR re-scan even for TRANSIENT WA kicks.
          // Real WhatsApp Web NEVER auto-deletes creds — it retries indefinitely.
          //
          // Strategy: escalating backoff tiers, no ceiling, no deletion:
          //   attempts  1-3  →  8 s  (fast recovery for brief network blip)
          //   attempts  4-6  → 30 s  (server-side kick, give WA a moment)
          //   attempts  7-36 → 90 s  (persistent but maybe transient server issue)
          //   attempts 37-99 →  5 min (long WA outage / rate limit window)
          //   attempts 100+  → 10 min (very long stall — session may be dead)
          //
          // The ONLY ways to clear creds are:
          //   1. User explicitly clicks "تسجيل الخروج" (logout)
          //   2. User clicks "إعادة ضبط الجلسة" (resetSession) in the UI
          //   3. autoHeal() detects 30+ retries and calls resetSession() for user

          this.state.status = "reconnecting";
          this.reconnectCount++;

          let backoffMs: number;
          if      (this.loggedOutRetries <= 3)  backoffMs = 60_000;        //  1 min
          else if (this.loggedOutRetries <= 6)  backoffMs = 3 * 60_000;   //  3 min
          else if (this.loggedOutRetries <= 20) backoffMs = 10 * 60_000;  // 10 min
          else if (this.loggedOutRetries <= 50) backoffMs = 30 * 60_000;  // 30 min
          else                                  backoffMs = 60 * 60_000;  //  1 hr

          this.log.warn(
            { loggedOutRetries: this.loggedOutRetries, backoffMs },
            "loggedOut — retrying with backoff (creds preserved)"
          );
          await this.logEvent("reconnecting", `loggedOut attempt ${this.loggedOutRetries}, retry in ${Math.round(backoffMs / 1000)}s`);
          this.scheduleReconnect(backoffMs);
          return;
        }

        // ── 405: WhatsApp refused the handshake ───────────────────
        // The client version, not the credentials: WhatsApp answers 405 to a
        // version it has retired, before any authentication happens. Every
        // credential wipe in this account's history was five of these in a
        // row. The fix is a fresh version lookup and a short, flat retry —
        // the exponential counter is for network trouble, and a 405 is not
        // that.
        if (isHandshakeRejection(reason)) {
          invalidateWaVersion(`405 for user ${this.userId}`);
          this.handshakeRejects++;
          this.state.status = "reconnecting";
          this.state.qr     = null;
          this.reconnectCount++;
          const delay = Math.min(20_000 * this.handshakeRejects, 3 * 60_000);
          this.log.warn({ version: waVersion, attempt: this.handshakeRejects, delayMs: delay },
            "handshake refused (405) — client version rejected; refreshing it and retrying, credentials untouched");
          await this.logEvent("reconnecting",
            `handshake_rejected(405) version=${waVersion.join(".")} attempt=${this.handshakeRejects} delay=${Math.round(delay / 1000)}s`);
          this.scheduleReconnect(delay);
          return;
        }

        // ── Special case: QR timeout (reason=408 while QR is showing) ────────
        // "QR refs attempts ended" — Baileys exhausted QR pairing attempts because
        // nobody scanned the code in time (~100 s).  This is NOT a connectivity
        // failure — the network is fine, the user just needs to scan a fresh QR.
        // Reconnect immediately so a new QR appears as fast as possible instead of
        // waiting through exponential backoff (which could be minutes by now).
        // Do NOT increment consecutiveReconnectFails — it distorts the backoff for
        // real network failures.
        if (reason === 408 && this.state.status === "qr_ready") {
          this.state.status = "reconnecting";
          this.state.qr     = null;
          this.reconnectCount++;
          this.qrCycleCount++;

          // Use a long backoff so the user has enough time to navigate to the
          // QR page and scan before the next code is generated.
          // After the first rejection (qrCycleCount=1) the bad credentials are
          // already cleared, so subsequent reconnects start fresh — 5 min is
          // plenty of time for the user to open the QR page.
          const qrBackoffMs = this.qrCycleCount <= 2 ? 5 * 60_000 : 10 * 60_000;
          await this.logEvent("reconnecting", `qr_timeout(cycle=${this.qrCycleCount}) — next QR in ${qrBackoffMs / 60_000} min`);
          this.log.info({ qrCycleCount: this.qrCycleCount, qrBackoffMs }, "QR timed out — waiting before next attempt");
          this.scheduleReconnect(qrBackoffMs);
          return;
        }

        this.state.status = "reconnecting";
        this.reconnectCount++;

        let delay: number;
        if (reason === DisconnectReason.restartRequired) {
          // restartRequired = WA server initiated a clean session restart (natural ~80s cycle).
          // This is NOT a failure — do NOT increment consecutiveReconnectFails.
          // Reconnect fast so the "reconnecting" window is invisible to the user.
          // Real WhatsApp Web reconnects in <1 s; we use 2 s for safety.
          delay = 2_000;
        } else if (reason === DisconnectReason.connectionClosed) {
          // connectionClosed (428) = WA server closed the session cleanly (e.g. normal rotation).
          // This is NOT a failure — do NOT increment consecutiveReconnectFails.
          // Reconnect fast just like restartRequired.
          delay = 2_000;
        } else {
          // Genuine connectivity failure — use escalating backoff.
          this.consecutiveReconnectFails++;
          if (!this.reconnectingStartedAt) this.reconnectingStartedAt = Date.now();
          // Conservative exponential backoff: 8s → 16s → 32s → 64s → 120s (cap 2 min)
          // Capped at 2 min (was 5 min) so recovery is faster after genuine failures.
          delay = Math.min(8_000 * Math.pow(2, this.consecutiveReconnectFails - 1), 2 * 60_000);
        }
        await this.logEvent("reconnecting", `reason=${reason} attempt=${this.consecutiveReconnectFails} delay=${Math.round(delay / 1000)}s`);
        this.scheduleReconnect(delay);
      }
    });

    // Guard creds.update — stale sockets must not overwrite creds.
    // Retry up to 6× with exponential back-off so a transient DB blip
    // never permanently loses the session.
    sock.ev.on("creds.update", () => {
      if (myGen !== this.socketGeneration) return;
      this.lastEventReceivedAt = new Date(); // session is active — reset idle timer
      this.emitDiag("creds.update", null);
      const trySave = (attempt: number) => {
        saveCreds().then(() => {
          this.log.info("creds saved to DB ✓");
        }).catch((err) => {
          if (attempt < 6) {
            const delay = Math.min(3_000 * Math.pow(2, attempt - 1), 60_000);
            this.log.warn({ attempt, delay }, "creds save failed — retrying");
            setTimeout(() => trySave(attempt + 1), delay);
          } else {
            this.log.error({ err }, "CRITICAL: failed to save creds after 6 attempts — session may be lost");
          }
        });
      };
      trySave(1);
    });

    // ── Contact & chat tracking ─────────────────────────────────

    // contacts.set — موجود في بعض إصدارات Baileys
    (sock.ev as any).on("contacts.set", ({ contacts: allContacts }: any) => {
      if (myGen !== this.socketGeneration) return;
      const now = Math.floor(Date.now() / 1000);
      let added = 0;
      let skipped = 0;
      for (const c of (allContacts ?? [])) {
        const id: string | undefined = c.id ?? c.legacyId;
        if (!id) continue;
        let phone: string;
        if (id.endsWith("@s.whatsapp.net")) {
          phone = id.replace("@s.whatsapp.net", "");
        } else if (id.endsWith("@lid")) {
          // معرّف خصوصية — نحاول phone number أو نتجاهل
          const pn = (c as any).phoneNumber as string | undefined;
          if (!pn) { skipped++; continue; }
          phone = pn.replace(/^\+/, "").replace(/\D/g, "");
          if (!phone) { skipped++; continue; }
        } else {
          skipped++; continue; // @g.us / @broadcast / @newsletter / etc
        }
        this.upsertContact(phone, { name: c.name || (c as any).notify || undefined, lastMessageAt: now, source: "phonebook" });
        added++;
      }
      this.log.info({ added, skipped, total: this.contactStore.size }, "contacts.set — phonebook full sync");
    });

    // chats.set — موجود في بعض إصدارات Baileys (نكتب مباشرة في wa_conversations)
    (sock.ev as any).on("chats.set", ({ chats: allChats }: any) => {
      if (myGen !== this.socketGeneration) return;
      const now = Math.floor(Date.now() / 1000);
      let added = 0;
      this.syncStats.chatsSetCount += (allChats ?? []).length;
      for (const chat of (allChats ?? [])) {
        const id = chat.id;
        this.recordJid(id ?? "");
        if (!id?.endsWith("@s.whatsapp.net")) continue;
        const phone = id.replace("@s.whatsapp.net", "");
        const ts = toSecs(chat.conversationTimestamp) || now;
        const name = chat.name ?? undefined;
        this.upsertContact(phone, { name, lastMessageAt: ts, source: "chat" });
        this.upsertConversation(phone, { name, lastMsgAt: ts });
        added++;
      }
      this.log.info({ total: (allChats ?? []).length, individual: added }, "chats.set — chat list full sync");
      // flush فوري — لا debounce
      this.flushPendingConvsNow();
    });

    // contacts.upsert = الحدث الرئيسي — يُطلَق عند كل تزامن وعند resyncAppState
    sock.ev.on("contacts.upsert", (contacts) => {
      if (myGen !== this.socketGeneration) return;
      const now = Math.floor(Date.now() / 1000);
      this.syncStats.contactsUpsertBatches++;
      this.syncStats.contactsUpsertTotal += contacts.length;
      for (const c of contacts) {
        if (!c.id) continue;
        let phone: string;
        if (c.id.endsWith("@s.whatsapp.net")) {
          phone = c.id.replace("@s.whatsapp.net", "");
        } else if (c.id.endsWith("@lid")) {
          const pn = (c as any).phoneNumber as string | undefined;
          if (!pn) continue;
          phone = pn.replace(/^\+/, "").replace(/\D/g, "");
          if (!phone) continue;
          // بناء خريطة @lid → phone لاستخدامها في chats.upsert
          this.lidToPhone.set(c.id, phone);
        } else {
          continue;
        }
        this.upsertContact(phone, { name: c.name || (c as any).notify, lastMessageAt: now, source: "phonebook" });
      }
      this.log.info({ batch: this.syncStats.contactsUpsertBatches, count: contacts.length, total: this.contactStore.size }, "contacts.upsert processed");
    });

    // messaging-history.set = full chat history on (re)connect
    sock.ev.on("messaging-history.set", ({ chats: histChats, contacts: histContacts, messages: histMessages, syncType, isLatest, progress }: any) => {
      if (myGen !== this.socketGeneration) return;
      const now = Math.floor(Date.now() / 1000);

      this.syncStats.historySetBatches++;
      this.syncStats.syncType = String(syncType ?? "unknown");
      this.syncStats.historyChatsTotal    += (histChats    ?? []).length;
      this.syncStats.historyContactsTotal += (histContacts ?? []).length;
      this.syncStats.historyMessagesTotal += (histMessages ?? []).length;

      this.log.info({
        batch: this.syncStats.historySetBatches,
        syncType,
        isLatest,
        progress,
        chats:    (histChats    ?? []).length,
        contacts: (histContacts ?? []).length,
        messages: (histMessages ?? []).length,
      }, "messaging-history.set received");

      // 1. جهات الاتصال — بناء خريطة @lid→phone أثناء المعالجة
      const batchLidToPhone = new Map<string, string>();
      for (const c of (histContacts ?? [])) {
        if (!c.id) continue;
        let phone: string;
        if (c.id.endsWith("@s.whatsapp.net")) {
          phone = c.id.replace("@s.whatsapp.net", "");
        } else if (c.id.endsWith("@lid")) {
          const pn = (c as any).phoneNumber as string | undefined;
          if (!pn) continue;
          phone = pn.replace(/^\+/, "").replace(/\D/g, "");
          if (!phone) continue;
          batchLidToPhone.set(c.id, phone);
          this.lidToPhone.set(c.id, phone);  // حفظ في الذاكرة للـ chats.upsert
        } else {
          continue;
        }
        this.upsertContact(phone, { name: (c as any).name || (c as any).notify, lastMessageAt: now, source: "phonebook" });
      }

      // 2. المحادثات — يقبل @s.whatsapp.net و @lid
      let chatCount = 0;
      for (const chat of (histChats ?? [])) {
        let phone: string | undefined;
        if (chat.id?.endsWith("@s.whatsapp.net")) {
          phone = chat.id.replace("@s.whatsapp.net", "");
        } else if (chat.id?.endsWith("@lid")) {
          phone = batchLidToPhone.get(chat.id) ?? this.lidToPhone.get(chat.id);
        }
        if (!phone) continue;
        const ts = toSecs(chat.conversationTimestamp) || now;
        const name = (chat as any).name ?? undefined;
        const lastMsgNode = (chat as any).messages?.[0]?.message;
        const lastText = lastMsgNode ? extractText({ message: lastMsgNode } as any) : undefined;
        this.upsertContact(phone, { name, lastMessageAt: ts, source: "chat" });
        this.upsertConversation(phone, { name, lastMsgAt: ts, lastText });
        this.recordJid(chat.id);
        chatCount++;
      }
      this.syncStats.historyChatsIndividual += chatCount;

      // 3. الرسائل التاريخية — حفظ كاملة (صادرة + واردة) في wa_thread_messages مع dedup
      const incomingRows: { userId: number; phone: string; messageId: string | null; text: string | null; receivedAt: Date }[] = [];
      const threadRows:   { userId: number; phone: string; messageId: string | null; text: string | null; msgType: string; fromMe: boolean; createdAt: Date }[] = [];
      let totalHistMsgs = 0;
      const groupHistory: any[] = [];
      for (const msg of (histMessages ?? [])) {
        try {
          if (msg.key?.remoteJid?.endsWith("@g.us")) { groupHistory.push(msg); continue; }
          const jid = msg.key?.remoteJid ?? msg.key?.participant;
          if (!jid || !jid.endsWith("@s.whatsapp.net")) continue;
          const phone  = jid.replace("@s.whatsapp.net", "");
          const ts     = toSecs(msg.messageTimestamp) || now;
          const text   = extractText(msg) ?? undefined;
          const msgId  = msg.key?.id ?? null;
          const fromMe = !!msg.key?.fromMe;
          totalHistMsgs++;
          this.upsertContact(phone, { name: undefined, lastMessageAt: ts, source: "chat" });
          this.upsertConversation(phone, { lastMsgAt: ts, lastText: text });

          // حفظ في wa_thread_messages (صادر + وارد) مع dedup عبر message_id
          if (msgId || text) {
            threadRows.push({
              userId: this.userId,
              phone,
              messageId: msgId,
              text: text ?? null,
              msgType: "text",
              fromMe,
              createdAt: new Date(ts * 1000),
            });
          }

          // incoming_messages فقط للواردة
          if (!fromMe) {
            incomingRows.push({
              userId: this.userId,
              phone,
              messageId: msgId,
              text: text ?? null,
              receivedAt: new Date(ts * 1000),
            });
          }
        } catch { /* تجاهل أخطاء رسائل منفردة */ }
      }

      if (groupHistory.length) {
        void captureGroupHistory(this.userId, groupHistory, this.lidToPhone).catch((err) => this.log.warn({ err: String(err?.message ?? err) }, "group history insert error"));
      }

      // حفظ wa_thread_messages بـ onConflictDoNothing (dedup عبر unique index)
      if (threadRows.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < threadRows.length; i += CHUNK) {
          db.insert(waThreadMessagesTable)
            .values(threadRows.slice(i, i + CHUNK))
            .onConflictDoNothing()
            .catch((err) => this.log.error({ err }, "history thread_msgs insert error"));
        }
      }

      if (incomingRows.length > 0) {
        const CHUNK = 500;
        for (let i = 0; i < incomingRows.length; i += CHUNK) {
          db.insert(incomingMessagesTable)
            .values(incomingRows.slice(i, i + CHUNK))
            .onConflictDoNothing()
            .catch((err) => this.log.error({ err }, "bulk history insert error"));
        }
      }

      // تحديث sync state في DB (تراكمي — يُحدَّث بعد كل batch)
      const batchChats    = this.syncStats.historyChatsIndividual;
      const batchMessages = this.syncStats.historyMessagesTotal;
      const batchContacts = this.syncStats.historyContactsTotal;
      const batchThreads  = threadRows.length;
      db.execute(sql`
        INSERT INTO wa_sync_state
          (user_id, sync_status, chats_synced, messages_synced, thread_msgs_synced, contacts_synced, updated_at)
        VALUES
          (${this.userId}, 'syncing', ${batchChats}, ${batchMessages}, ${batchThreads}, ${batchContacts}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          sync_status        = 'syncing',
          chats_synced       = EXCLUDED.chats_synced,
          messages_synced    = EXCLUDED.messages_synced,
          contacts_synced    = EXCLUDED.contacts_synced,
          thread_msgs_synced = wa_sync_state.thread_msgs_synced + ${batchThreads},
          updated_at         = NOW()
      `).catch(() => {});

      // flush immediately to DB — لا ننتظر debounce timer
      this.flushPendingContactsNow();
      this.flushPendingConvsNow();

      this.log.info({
        chatCount,
        contacts: this.contactStore.size,
        histMsgs: totalHistMsgs,
        threadSaved: threadRows.length,
        incoming: incomingRows.length,
        syncType,
        isLatest,
      }, "messaging-history.set processed → flushed to DB");
    });

    // messaging-history.status = مزامنة اكتملت أو توقفت
    (sock.ev as any).on("messaging-history.status", ({ syncType, status }: any) => {
      if (myGen !== this.socketGeneration) return;
      this.log.info({ syncType, status }, "messaging-history.status");
      if (status === "complete") {
        // flush نهائي لضمان كتابة كل شيء
        this.flushAllContactsToDb().catch((err) => this.log.error({ err }, "final contacts flush error"));
        if (this.convFlushTimer) { clearTimeout(this.convFlushTimer); this.convFlushTimer = null; }
        const toWriteConvs = new Map(this.pendingConvUpserts);
        this.pendingConvUpserts.clear();
        if (toWriteConvs.size > 0) {
          this.writeConversationsToDb(toWriteConvs).catch((err) => this.log.error({ err }, "final convs flush error"));
        }
        // تحديث sync state: اكتملت المزامنة
        db.execute(sql`
          INSERT INTO wa_sync_state
            (user_id, sync_status, last_full_sync_at, updated_at)
          VALUES (${this.userId}, 'complete', NOW(), NOW())
          ON CONFLICT (user_id) DO UPDATE SET
            sync_status       = 'complete',
            last_full_sync_at = NOW(),
            updated_at        = NOW()
        `).catch(() => {});
        this.log.info({ contacts: this.contactStore.size }, "messaging-history sync COMPLETE — all data flushed to DB");
      }
    });

    sock.ev.on("chats.upsert", (chats) => {
      if (myGen !== this.socketGeneration) return;
      this.lastEventReceivedAt = new Date(); // WA is active — reset idle timer
      const now = Math.floor(Date.now() / 1000);
      let chatCount = 0;
      this.syncStats.chatsUpsertBatches++;
      this.syncStats.chatsUpsertTotal += chats.length;
      for (const chat of chats) {
        this.recordJid(chat.id ?? "");
        let phone: string | undefined;
        if (chat.id?.endsWith("@s.whatsapp.net")) {
          phone = chat.id.replace("@s.whatsapp.net", "");
        } else if (chat.id?.endsWith("@lid")) {
          phone = this.lidToPhone.get(chat.id);
        }
        if (!phone) continue;
        const ts = toSecs(chat.conversationTimestamp) || now;
        const name = chat.name ?? undefined;
        this.upsertContact(phone, { name, lastMessageAt: ts, source: "chat" });
        this.upsertConversation(phone, { name, lastMsgAt: ts });
        chatCount++;
      }
      this.syncStats.chatsUpsertIndividual += chatCount;
      this.log.info({
        batch: this.syncStats.chatsUpsertBatches,
        received: chats.length, individual: chatCount,
        totalSoFar: this.syncStats.chatsUpsertTotal,
        individualSoFar: this.syncStats.chatsUpsertIndividual,
      }, "chats.upsert processed");
      // دفعة كبيرة = تحميل أولي — flush فوري بدون debounce
      if (chats.length > 5) {
        this.flushPendingContactsNow();
        this.flushPendingConvsNow();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (myGen !== this.socketGeneration) return;
      this.lastEventReceivedAt = new Date();
      this.emitDiag("messages.upsert", { type, messages: messages.map((m) => ({ key: m.key, status: m.status, pushName: m.pushName })) });
      // "notify" = real-time incoming/outgoing messages
      // "append" = historical messages loaded on connect — still useful for
      //            building the contact store but NOT for chatbot/opt-out
      const isLive = type === "notify";
      if (type !== "notify" && type !== "append") return;

      for (const msg of messages) {
        // Groups: kept, filed and shown to the groups agent — never answered from here.
        if (msg.key?.remoteJid?.endsWith("@g.us")) {
          try {
            const kept = await captureGroupMessage(this.userId, sock, msg, {
              lidToPhone: this.lidToPhone,
              download: isLive ? () => downloadMediaMessage(msg, "buffer", {}) as Promise<Buffer> : undefined,
            });
            if (kept && isLive) void onGroupMessage(this.userId, kept.group, kept.parsed).catch(() => {});
          } catch (err) {
            this.log.warn({ err: String((err as any)?.message ?? err).slice(0, 160) }, "تعذّر حفظ رسالة القروب");
          }
          continue;
        }
        // Resolve the sender, including LID-addressed contacts. Dropping
        // everything that was not @s.whatsapp.net here is what silently broke
        // inbound once WhatsApp started migrating contacts to LIDs.
        const sender = await resolveSenderPhone(sock, msg, this.lidToPhone);
        if (!sender) continue;   // group, broadcast, newsletter or status
        const { phone } = sender;
        if (sender.via !== "pn") {
          this.log.info(
            { jid: msg.key?.remoteJid, phone, via: sender.via, fromMe: !!msg.key?.fromMe },
            "LID-addressed message resolved",
          );
        }
        const ts = toSecs(msg.messageTimestamp) || Math.floor(Date.now() / 1000);
        this.upsertContact(phone, { name: undefined, lastMessageAt: ts, source: "chat" });

        // الرسائل بدون محتوى لا تحتاج معالجة
        if (!msg.message) continue;

        let text = extractText(msg);
        let wasVoice = false;

        // ── الرسائل الصوتية ───────────────────────────────────────────
        // A voice note produced no text here, so the most engaged kind of
        // inbound message was the one kind silently dropped: the customer
        // recorded thirty seconds, nothing matched, and the thread showed an
        // empty row. Transcribing turns it into an ordinary message that every
        // downstream part already knows how to handle.
        const audio = msg.message?.audioMessage;
        if (!text && audio && !msg.key.fromMe) {
          try {
            const buf = await downloadMediaMessage(msg, "buffer", {}) as Buffer;
            const t = await transcribe(buf, audio.mimetype ?? "audio/ogg");
            if (t) {
              text = t.text;
              wasVoice = true;
              this.log.info({ phone, seconds: audio.seconds, chars: t.text.length, model: t.model, ms: t.ms },
                "فُرِّغ تسجيل صوتي");
            } else {
              this.log.info({ phone, seconds: audio.seconds }, "تسجيل صوتي بلا كلام مفهوم");
            }
          } catch (err) {
            this.log.warn({ phone, err: String((err as any)?.message ?? err).slice(0, 160) },
              "تعذّر تحميل التسجيل الصوتي");
          }
        }

        // ── تسجيل المحادثة (صادرة + واردة) ────────────────────────────
        this.upsertConversation(phone, { lastMsgAt: ts, lastText: text ?? undefined });

        // ── حفظ في سجل الدردشة (صادر + وارد) — dedup عبر message_id ──
        db.insert(waThreadMessagesTable)
          .values({
            userId:    this.userId,
            phone,
            messageId: msg.key?.id ?? null,
            text:      text ?? null,
            // Marked, so a transcription error reads as one when the owner
            // looks at the thread rather than as a customer writing nonsense.
            msgType:   wasVoice ? "voice" : "text",
            fromMe:    !!msg.key.fromMe,
            createdAt: new Date(ts * 1000),
          })
          .onConflictDoNothing()
          .catch(() => {});

        // Our own sends are already logged where they belong. A fromMe
        // message this process did not send is the owner answering from
        // their phone: from here the person holds the thread.
        if (msg.key.fromMe) {
          if (isLive && msg.key.id && !this.sentIds.has(msg.key.id)) {
            emitHumanReply({ userId: this.userId, phone, text: text ?? "" });
          }
          continue;
        }

        const msgId = msg.key.id ?? null;

        // ── حفظ الرسائل الواردة فقط ───────────────────────────────────
        db.insert(incomingMessagesTable)
          .values({
            userId: this.userId,
            phone,
            messageId: msgId,
            text: text ?? null,
            receivedAt: new Date(ts * 1000),
          })
          .onConflictDoNothing()
          .catch(() => {});

        // Only process opt-out / chatbot for live messages
        if (!isLive) continue;

        // ── The stop button ───────────────────────────────────────
        // Before anything reads the tap: the bots are not to answer it, and
        // the follow-up engine would read «إيقاف» as a stop for good. Known
        // by the button's id, or — on a phone that sends only the words — by
        // matching a stop button of a campaign this number received.
        let buttonMatch: Awaited<ReturnType<typeof matchCampaignButtonResponse>> = null;
        if (text) {
          buttonMatch = await matchCampaignButtonResponse(this.userId, phone, text).catch((err) => {
            this.log.error({ err, phone }, "Campaign button response matching error");
            return null;
          });
        }
        if (isStopTap(tappedButtonId(msg.message)) || buttonMatch?.action === "stop") {
          try {
            const until = await stopForMonths(this.userId, phone);
            this.log.info({ phone, until, campaign: buttonMatch?.campaignName }, "stop button — no messages to this number for five months");
            this.sendMessage(phone, STOP_ACK).catch(() => {});
          } catch (err) {
            this.log.error({ err, phone }, "stop button could not be recorded");
          }
          continue;
        }

        // Let the follow-up engine see every live inbound message: a new lead
        // to enrol, or a reply that should stop a sequence. Fired before the
        // opt-out and chatbot branches below, both of which `continue`.
        emitInbound({ userId: this.userId, phone, text: text ?? "", message: msg });
        if (!text) continue;

        // ── Opt-out detection ──────────────────────────────────────
        // If the contact sends an opt-out keyword, remove them from all
        // contact groups and add to the unsubscribed list permanently.
        const OPTOUT_RE = /^(0|stop|unsubscribe|توقف|وقف|أوقف|ايقاف|إيقاف|الغاء|إلغاء|لا\s*ارسال|لا\s*تراسلني|ارفع\s*رقمي|إلغاء\s*الاشتراك|الغاء\s*الاشتراك|remove\s*me)$/i;
        if (OPTOUT_RE.test(text.trim())) {
          this.log.info({ phone }, "Opt-out received — removing from contacts");
          // Insert unsubscribed (ignore duplicate)
          db.insert(unsubscribedPhonesTable)
            .values({ userId: this.userId, phone, reason: text.trim() })
            .onConflictDoNothing()
            .catch(() => {});
          // Delete from this account's lists only — the number may be another
          // subscriber's customer, and their lists are theirs.
          db.delete(contactsTable)
            .where(and(
              eq(contactsTable.phone, phone),
              sql`${contactsTable.groupId} IN (SELECT id FROM contact_groups WHERE user_id = ${this.userId})`,
            ))
            .catch(() => {});
          // Confirm opt-out to the user
          this.sendMessage(phone, "تم إلغاء اشتراكك ✅ لن تصلك رسائل منا مرة أخرى.").catch(() => {});
          continue;
        }

        // ── Campaign button response detection ─────────────────────
        // If the reply matches an "interested"/"not_interested" button from a
        // recently-sent campaign, record it and acknowledge — before chatbot.
        try {
          const matched = buttonMatch;
          if (matched) {
            const ack = matched.action === "interested"
              ? "شكراً لاهتمامك! 🙏 سنتواصل معك قريباً."
              : "تم تسجيل ردك، شكراً لوقتك 🙏";
            this.sendMessage(phone, ack).catch(() => {});
            continue;
          }
        } catch (err) {
          this.log.error({ err, phone }, "Campaign button response matching error");
        }

        // The hand-built keyword chatbot used to run here, before the agents
        // existed. It never had a single row in this deployment, and every
        // message it would have matched now reaches the employee whose
        // specialty it is, through follow-up-engine's inbound hook.
      }
    });

    // ── Delivery / Read receipts ──────────────────────────────────────
    // Baileys fires messages.update when the remote device acknowledges a message.
    // status codes (proto.WebMessageInfo.Status):
    //   0 = ERROR  1 = PENDING  2 = SERVER_ACK  3 = DELIVERY_ACK  4 = READ  5 = PLAYED
    //
    // IDEMPOTENCY: All counter increments are driven by the RETURNING clause of the
    // message_logs UPDATE, which only matches rows that haven't been transitioned yet
    // (WHERE delivered_at IS NULL / read_at IS NULL).  Duplicate Baileys events
    // therefore produce zero-row UPDATEs and never double-count.
    sock.ev.on("messages.update", async (updates) => {
      if (myGen !== this.socketGeneration) return;
      this.lastEventReceivedAt = new Date();
      this.emitDiag("messages.update", updates.map((u) => ({ key: u.key, update: u.update })));

      for (const { key, update } of updates) {
        if (!key.fromMe) continue;
        const msgId = key.id;
        if (!msgId) continue;
        const status = (update as any).status as number | undefined;
        if (status === undefined || status === null) continue;

        try {
          if (status === 3) {
            // DELIVERY_ACK — double grey tick
            // Atomic: UPDATE returns a row only when we actually transition delivered_at
            // from NULL → NOW(). Duplicate events hit the WHERE and return nothing.
            await db.execute(sql`
              WITH transitioned AS (
                UPDATE message_logs
                SET delivered_at = NOW()
                WHERE message_id = ${msgId}
                  AND delivered_at IS NULL
                RETURNING campaign_id
              )
              UPDATE campaigns
              SET delivered_count = delivered_count + 1
              WHERE id IN (SELECT campaign_id FROM transitioned)
            `);

          } else if (status === 4) {
            // READ — blue double tick (implies delivered too)
            // Snapshot captures pre-update state; UPDATE only fires when read_at IS NULL.
            // PostgreSQL CTEs share the same DB snapshot, so snapshot.need_delivered
            // accurately reflects whether delivered_at was NULL before this statement.
            await db.execute(sql`
              WITH snapshot AS (
                SELECT campaign_id,
                       (delivered_at IS NULL) AS need_delivered
                FROM message_logs
                WHERE message_id = ${msgId}
                  AND read_at IS NULL
              ),
              transitioned AS (
                UPDATE message_logs
                SET delivered_at = COALESCE(delivered_at, NOW()),
                    read_at      = NOW()
                WHERE message_id = ${msgId}
                  AND read_at IS NULL
                RETURNING campaign_id
              )
              UPDATE campaigns
              SET read_count       = read_count + 1,
                  delivered_count  = delivered_count + (
                    SELECT CASE WHEN s.need_delivered THEN 1 ELSE 0 END
                    FROM snapshot s
                    INNER JOIN transitioned t ON s.campaign_id = t.campaign_id
                    LIMIT 1
                  )
              WHERE id IN (SELECT campaign_id FROM transitioned)
            `);
          }
        } catch (err) {
          this.log.warn({ err, msgId, status }, "delivery receipt DB update failed");
        }
      }
    });

    return sock;
  }

  // ── Force full resync ────────────────────────────────────────────
  // استدعاء resyncAppState مباشرة إذا كان الاتصال مفتوحاً،
  // وإلا أغلق وأعد الاتصال
  async forceResync() {
    this.log.info("force resync requested");
    const sock = this.state.socket;
    if (sock && this.state.connected) {
      try {
        await (sock as any).resyncAppState?.(
          ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"],
          true
        );
        this.log.info("resyncAppState called — contacts.upsert flood expected");
        return;
      } catch (err) {
        this.log.warn({ err }, "resyncAppState failed — falling back to reconnect");
      }
    }
    // fallback: أغلق الـ socket وأعد فتحه
    if (sock) {
      try { (sock as any).ws?.close(); } catch {}
      this.state.socket = null;
    }
    this.socketGeneration++;
    await this.init();
  }

  // ── Pairing code (alternative to QR scan) ───────────────────────
  // Lets the user pair via an 8-digit code shown in WhatsApp on their phone.
  // Steps for user: WhatsApp → Linked Devices → Link Device → "Link with phone number"
  async requestPairingCode(phoneNumber: string): Promise<string> {
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, "");
    if (!cleanPhone || cleanPhone.length < 7) throw new Error("رقم الهاتف غير صحيح");

    // Arm the pending fields — init() will read these immediately after makeWASocket
    this.pendingPairingPhone = cleanPhone;
    this.lastPairingCode     = null;
    this.pairingCodeError    = null;

    // Tear down any existing socket/timer and force a clean init()
    // so makeWASocket is called fresh (Baileys requires requestPairingCode
    // to be invoked right after socket creation, before any QR event fires).
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.state.socket) {
      try { (this.state.socket as any).ws?.close(); } catch {}
      this.state.socket = null;
    }
    this.state.status  = "disconnected";
    this.state.qr      = null;
    this.socketGeneration++;   // invalidate any in-flight init()
    void this.init();

    // Wait up to 30 s for lastPairingCode or pairingCodeError to be set by init()
    const deadline = Date.now() + 30_000;
    while (!this.lastPairingCode && !this.pairingCodeError) {
      if (Date.now() > deadline) {
        this.pendingPairingPhone = null;
        throw new Error("انتهت المهلة — تأكد أن الرقم صحيح وجرب مرة أخرى");
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Always clear the pending flag
    this.pendingPairingPhone = null;

    if (this.pairingCodeError) {
      const msg = this.pairingCodeError;
      this.pairingCodeError = null;
      throw new Error(msg);
    }

    const code = this.lastPairingCode!;
    this.lastPairingCode = null;
    return code; // e.g. "ABCD-1234"
  }

  // ── Reset session (clears auth + data → forces FULL history on next QR scan) ──
  async resetSession() {
    this.log.info("resetSession: clearing auth state to force FULL history resync");
    this.manualLogout     = true;
    this.loggedOutRetries = 0;
    this.consecutiveReconnectFails = 0;
    this.reconnectingStartedAt = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopKeepAlive();
    this.stopWatchdog();
    this.stopHealthMonitor();

    // إغلاق الـ socket بدون logout() — نريد الاتصال من جديد كجهاز جديد
    if (this.state.socket) {
      try { (this.state.socket as any).ws?.close(); } catch {}
      this.state.socket = null;
    }

    this.state = { status: "disconnected", connected: false, phone: null, name: null, qr: null, socket: null };
    this.connectedAt    = null;
    this.reconnectCount = 0;

    // مسح جلسة الواتساب من DB → عند الاتصال التالي سيُعامَل كجهاز جديد → FULL sync
    await db.delete(waAuthStateTable).where(eq(waAuthStateTable.userId, this.userId)).catch(() => {});
    // مسح جلسة الديسك
    try { fs.rmSync(this.sessionDir, { recursive: true }); } catch {}

    // مسح قاعدة البيانات (المحادثات + جهات الاتصال) ليبدأ التخزين نظيفاً
    await db.delete(waConversationsTable).where(eq(waConversationsTable.userId, this.userId)).catch(() => {});
    await db.delete(waContactsTable).where(eq(waContactsTable.userId, this.userId)).catch(() => {});

    // مسح الذاكرة المؤقتة
    this.contactStore.clear();
    this.discoveredPhones.clear();
    this.pendingConvUpserts.clear();

    // إعادة الاتصال — QR جديد → جهاز جديد → FULL history sync
    this.manualLogout = false;
    this.socketGeneration++;
    await this.init();

    this.log.info("resetSession: done — waiting for QR scan to trigger FULL sync");
  }

  // ── Logout ──────────────────────────────────────────────────────

  async logout() {
    this.manualLogout     = true;
    this.loggedOutRetries = 0;
    this.consecutiveReconnectFails = 0;
    this.reconnectingStartedAt = null;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopKeepAlive();
    this.stopWatchdog();
    this.stopHealthMonitor();

    if (this.state.socket) {
      try { await this.state.socket.logout(); } catch {}
      this.state.socket = null;
    }

    this.state = { status: "disconnected", connected: false, phone: null, name: null, qr: null, socket: null };
    this.connectedAt    = null;
    this.reconnectCount = 0;

    // Clear session from DB (manual logout = intentional unpair)
    await db.delete(waAuthStateTable).where(eq(waAuthStateTable.userId, this.userId)).catch(() => {});
    // Also clear legacy disk files if present
    try { fs.rmSync(this.sessionDir, { recursive: true }); } catch {}
  }

  // ── Send message ─────────────────────────────────────────────────

  async sendMessage(
    phone: string,
    message: string,
    messageType = "text",
    mediaUrl?: string | null,
    buttons?: string | null,
    carousel?: string | null,
  ): Promise<string | undefined> {
    if (!this.state.socket || !this.state.connected) throw new Error("WhatsApp غير متصل");

    // ── WS readyState guard (pre-send check #1) ───────────────────────────────
    // state.connected can remain `true` for up to 10 s after the underlying
    // TCP/TLS socket dies silently (the keepalive catches it on its next tick).
    const _wsCheck = (this.state.socket as any)?.ws;
    const _wsState0 = typeof _wsCheck?.readyState === "number" ? _wsCheck.readyState : "unknown";
    if (_wsCheck && typeof _wsCheck.readyState === "number" && _wsCheck.readyState !== 1 /* OPEN */) {
      throw new Error(`WhatsApp غير متصل — WS readyState=${_wsCheck.readyState}`);
    }

    this.lastActivityAt = new Date();
    const jid = formatPhone(phone);
    const sendStartMs = Date.now();

    this.log.info(
      {
        phone, jid, messageType,
        socketGen:   this.socketGeneration,
        wsReadyState: _wsState0,
        connected:   this.state.connected,
      },
      "📤 send:start",
    );

    // Verify the number is registered on WhatsApp before wasting a send attempt.
    // onWhatsApp returns undefined on network error — in that case we skip the check
    // and let the send proceed (better to attempt than to silently drop).
    try {
      // Hard 10-second timeout — onWhatsApp can hang indefinitely on broken sockets
      const checkResult = await Promise.race([
        this.state.socket.onWhatsApp(phone),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ONWHATSAPP_TIMEOUT: فحص الرقم استغرق أكثر من 10 ث")), 10_000)
        ),
      ]);
      const [check] = checkResult ?? [];
      if (check && !check.exists) {
        throw new Error(`NOT_ON_WHATSAPP: الرقم ${phone} غير مسجل على واتساب`);
      }
    } catch (checkErr: any) {
      // If the error is our own NOT_ON_WHATSAPP, re-throw so campaign marks as failed
      if (String(checkErr?.message).startsWith("NOT_ON_WHATSAPP")) throw checkErr;
      // Any other error (network, timeout) — log and proceed optimistically
      appLogger.warn({ phone, err: String(checkErr?.message) }, "onWhatsApp check failed — proceeding anyway");
    }

    // Anti-ban: go online + simulate typing before every send
    await this.simulateHumanPresence(jid, message);

    // ── WS readyState guard (pre-send check #2) ───────────────────────────────
    // simulateHumanPresence takes 2.5–15 s during which the socket can die silently.
    // Re-validate socket liveness before the actual Baileys sendMessage call.
    if (!this.state.socket || !this.state.connected) {
      throw new Error("WhatsApp انقطع أثناء محاكاة الكتابة — WS died during typing sim");
    }
    const _wsPost = (this.state.socket as any)?.ws;
    const _wsStatePost = typeof _wsPost?.readyState === "number" ? _wsPost.readyState : "unknown";
    if (_wsPost && typeof _wsPost.readyState === "number" && _wsPost.readyState !== 1 /* OPEN */) {
      throw new Error(`WhatsApp انقطع أثناء محاكاة الكتابة — WS readyState=${_wsPost.readyState}`);
    }
    this.log.info(
      { phone, jid, wsReadyState: _wsStatePost, elapsedMs: Date.now() - sendStartMs },
      "📤 send:pre-baileys (post-sim check passed)",
    );

    // Wrap every socket.sendMessage call with a 35-second hard timeout, AND
    // register an abort hook so a mid-send reconnect fails fast instead of
    // waiting out the full 35 s (see pendingSendAborts / abortPendingSends).
    const sendGen = this.socketGeneration;
    const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(`SEND_TIMEOUT: انتهت مهلة الإرسال (35 ث) — ${label}`));
        }, 35_000);

        const abort = (err: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(err);
        };
        const cleanup = () => {
          const set = this.pendingSendAborts.get(sendGen);
          if (set) {
            set.delete(abort);
            if (set.size === 0) this.pendingSendAborts.delete(sendGen);
          }
        };
        if (!this.pendingSendAborts.has(sendGen)) this.pendingSendAborts.set(sendGen, new Set());
        this.pendingSendAborts.get(sendGen)!.add(abort);

        p.then((v) => {
          if (settled) return;
          settled = true;
          cleanup();
          clearTimeout(timer);
          resolve(v);
        }).catch((e) => {
          if (settled) return;
          settled = true;
          cleanup();
          clearTimeout(timer);
          reject(e);
        });
      });

    // Use message as-is — invisible Unicode fingerprinting causes WA to silently
    // drop messages server-side (detected as bot spam since WA 2024 filters).
    const uniqueText = message;

    // ── Session Guardian: wrap all sends to track success/failure ───────
    let sentMsgId: string | undefined;
    try {
      let result: Awaited<ReturnType<typeof this.state.socket.sendMessage>> | undefined;

      if (messageType === "voice") {
        // The text is what is said. If the voice cannot be made, the words go as text.
        const note = await speak(message);
        result = note
          ? await withTimeout(this.state.socket.sendMessage(jid, { audio: note.audio, ptt: note.ptt, mimetype: note.mimetype, seconds: note.seconds }), "voice")
          : await withTimeout(this.state.socket.sendMessage(jid, { text: uniqueText }), "voice-fallback-text");
      } else if (messageType === "text") {
        result = await withTimeout(this.state.socket.sendMessage(jid, { text: uniqueText }), "text");

      } else if (messageType === "image" && mediaUrl) {
        result = await withTimeout(this.state.socket.sendMessage(jid, { image: await resolveMedia(mediaUrl), caption: uniqueText }), "image");

      } else if (messageType === "video" && mediaUrl) {
        result = await withTimeout(this.state.socket.sendMessage(jid, { video: await resolveMedia(mediaUrl), caption: uniqueText }), "video");

      } else if (messageType === "button" && buttons) {
        const btns: ButtonDef[] = JSON.parse(buttons);
        try {
          result = await withTimeout(sendNativeButtons(this.state.socket, jid, uniqueText, btns), "button") as any;
        } catch (err: any) {
          this.log.warn({ phone, err: String(err?.message ?? err).slice(0, 160) }, "real buttons refused — sending them drawn as text");
          result = await withTimeout(this.state.socket.sendMessage(jid, { text: formatButtonsAdStyle(uniqueText, btns) }), "button-text");
        }

      } else if (messageType === "image_button" && mediaUrl && buttons) {
        const btns: ButtonDef[] = JSON.parse(buttons);
        const image = await resolveMedia(mediaUrl);
        try {
          result = await withTimeout(sendNativeButtons(this.state.socket, jid, uniqueText, btns, image), "image_button") as any;
        } catch (err: any) {
          this.log.warn({ phone, err: String(err?.message ?? err).slice(0, 160) }, "real image buttons refused — sending a caption instead");
          result = await withTimeout(this.state.socket.sendMessage(jid, { image: await resolveMedia(mediaUrl), caption: formatButtonsAdStyle(uniqueText, btns) }), "image_button-text");
        }

      } else if (messageType === "carousel" && carousel) {
        const cards: CarouselCard[] = JSON.parse(carousel);
        for (const card of cards) {
          let cardText = `*${card.title}*`;
          if (card.description) cardText += `\n${card.description}`;
          if (card.buttonText && card.buttonUrl) {
            cardText += `\n\n━━━━━━━━━━━━━━━━━━━━\n🔗 *${card.buttonText}*\n👉 ${card.buttonUrl}\n━━━━━━━━━━━━━━━━━━━━`;
          }
          const cardMsg = cardText;
          if (card.imageUrl) {
            await this.simulateHumanPresence(jid, cardMsg);
            result = await withTimeout(this.state.socket.sendMessage(jid, { image: await resolveMedia(card.imageUrl), caption: cardMsg }), "carousel-image");
          } else {
            await this.simulateHumanPresence(jid, cardMsg);
            result = await withTimeout(this.state.socket.sendMessage(jid, { text: cardMsg }), "carousel-text");
          }
          await sleep(500 + Math.random() * 600);
        }
      } else {
        result = await withTimeout(this.state.socket.sendMessage(jid, { text: uniqueText }), "fallback");
      }

      // Capture the Baileys message ID for delivery tracking
      sentMsgId = result?.key?.id ?? undefined;
      this.rememberSent(sentMsgId);

      // ── Diagnostic log: what did Baileys return? ─────────────────────────
      this.log.info(
        {
          phone, jid, messageType,
          msgId:       sentMsgId ?? null,
          hasMsgId:    !!sentMsgId,
          fromMe:      result?.key?.fromMe ?? null,
          elapsedMs:   Date.now() - sendStartMs,
          socketGen:   this.socketGeneration,
          wsReadyState: _wsStatePost,
        },
        sentMsgId
          ? "✅ send:success — Baileys confirmed msgId"
          : "⚠️ send:success but NO msgId — possible ghost-send (Baileys returned undefined key.id)",
      );

      // ✅ Success — update guardian tracking
      this.lastSuccessfulSendAt  = new Date();
      // Treat every successful send as a WA protocol event so the 90-min
      // deep-idle watchdog (Case 5) never fires during an active campaign.
      // Without this, a send-only campaign (no inbound messages) triggers
      // forceFullRebuild every 90 min → "new device" reconnect → ban signal.
      this.lastEventReceivedAt   = new Date();
      this.consecutiveSendFailures = 0;

    } catch (sendErr: any) {
      // NOT_ON_WHATSAPP is a contact issue, not a connection failure — don't count it
      const isContactError = String(sendErr?.message).startsWith("NOT_ON_WHATSAPP");
      if (!isContactError) {
        this.consecutiveSendFailures++;
        this.log.warn(
          { consecutiveSendFailures: this.consecutiveSendFailures, err: String(sendErr?.message) },
          "Session Guardian: send failure recorded"
        );
        // NOTE: We intentionally do NOT call forceFullRebuild here.
        // forceFullRebuild creates a new device session (needs QR rescan) every time.
        // The health monitor's soft-reconnect (Case 2) handles persistent failures
        // without destroying credentials.
      }
      throw sendErr;
    }

    // NOTE: we intentionally do NOT call scheduleGoOffline() here.
    // Sending "unavailable" after each message can cause WA to push
    // connection-state notifications to the user's mobile phone.
    return sentMsgId;
  }

  /**
   * Full human-presence simulation before sending:
   *
   *  1. Go ONLINE  — simulates the user opening the app/conversation
   *  2. Short read-pause — as if reading the previous chat
   *  3. Start COMPOSING — typing indicator visible to recipient
   *  4. Mid-pause on long messages — simulates re-reading / thinking
   *  5. End with PAUSED — indicator disappears right before the message arrives
   *
   * Typing duration scales with message length (~50 WPM ±25%, max 8 s).
   */
  private async simulateHumanPresence(jid: string, message: string) {
    if (!this.state.socket) return;
    // Skip presence simulation when the WebSocket is not OPEN — avoids a 20-second
    // hang waiting for Baileys' internal `defaultQueryTimeoutMs` to expire.
    // The send itself will detect the dead socket and throw the right error.
    const _ws = (this.state.socket as any)?.ws;
    if (_ws && _ws.readyState !== 1 /* OPEN */) return;

    const len = message.length;

    // Typing time scales with what is being typed, because a person's does.
    // This was a flat 7–8 seconds for every message, on the reasoning that the
    // randomness prevented a regular cadence — but a two-word "تمام" and a
    // four-line answer both taking 7.4 seconds is itself the regularity: the
    // one thing no real typist produces is a duration uncorrelated with length.
    //
    // The rate is not a real typing speed, and that is deliberate. At a true
    // 40 words per minute a 265-character reply takes 57 seconds, so every
    // reply of any substance would hit the ceiling and arrive after an
    // identical pause — reintroducing exactly the constant cadence this
    // replaced. The rate is set so that a reply written to the house style
    // (two or three lines, up to roughly 150 characters) spans the whole 4–15
    // second range and genuinely varies. Only replies longer than the style
    // permits clip at the top.
    //
    // A base of 1.5s covers reaction time, which a real person spends before
    // the first keystroke whatever they are about to write.
    const CHARS_PER_SECOND = 11;
    const ideal  = 1_500 + (len / CHARS_PER_SECOND) * 1_000;
    const jitter = 0.75 + Math.random() * 0.5;
    const total  = Math.round(Math.min(15_000, Math.max(2_500, ideal * jitter)));

    try {
      // ── Phase 1: Go ONLINE (open conversation) ─────────────────
      await this.state.socket.sendPresenceUpdate("available", jid);
      // Simulate reading previous messages (0.5–2 s depending on message length)
      const readPause = 500 + Math.min(1_500, len * 8) * Math.random();
      await sleep(readPause);

      // ── Phase 2: Start typing ──────────────────────────────────
      await this.state.socket.sendPresenceUpdate("composing", jid);

      if (total > 3_500) {
        // Long message: type first half → think/re-read → resume
        const firstHalf  = Math.floor(total * (0.50 + Math.random() * 0.15));
        const thinkMs    = 400 + Math.floor(Math.random() * 600);  // 0.4–1 s pause
        const secondHalf = Math.max(500, total - firstHalf - thinkMs);

        await sleep(firstHalf);
        await this.state.socket.sendPresenceUpdate("paused", jid);
        await sleep(thinkMs);
        await this.state.socket.sendPresenceUpdate("composing", jid);
        await sleep(secondHalf);
      } else {
        await sleep(total);
      }

      // ── Phase 3: Pause (message about to be sent) ──────────────
      await this.state.socket.sendPresenceUpdate("paused", jid);
    } catch {}
  }

  /**
   * The host just came back from sleep.
   *
   * Every socket that was open is dead — WhatsApp drops a connection that
   * misses its keepalive, and a laptop asleep misses all of them — but
   * Baileys only notices on its next ping, up to 25 seconds later, and the
   * reconnect backoff is still carrying the count of attempts made during
   * the sleep's brief dark wakes, when there was no network to attempt on.
   * So the counter is cleared and the reconnect happens now.
   */
  onSystemWake() {
    this.consecutiveReconnectFails = 0;
    this.reconnectingStartedAt = null;
    if (this.manualLogout) return;

    if (this.state.connected && this.state.socket) {
      this.log.info("host woke from sleep — dropping the socket so it reconnects now rather than on the next failed ping");
      try { (this.state.socket as any).ws?.close(); } catch {}
      return; // the close handler reconnects from here
    }
    if (this.state.status === "reconnecting" && this.reconnectTimer) {
      this.log.info("host woke from sleep — reconnecting now instead of waiting out the backoff");
      this.scheduleReconnect(3_000);
    }
  }

  /**
   * Send the read receipt for an inbound message.
   *
   * A person reads a message before answering it, and the sender sees that
   * happen: the ticks turn blue, and only then does "typing…" appear. A
   * number whose replies arrive without its ever having read anything is
   * describing itself, so the receipt goes out before the typing indicator.
   */
  async markRead(key: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null }) {
    if (!this.state.socket || !this.state.connected) return;
    if (!key?.id || !key?.remoteJid) return;
    try {
      await this.state.socket.readMessages([key as any]);
    } catch (err) {
      this.log.debug({ err: String((err as any)?.message ?? err) }, "read receipt not sent");
    }
  }

  /**
   * After a message is sent, stay "available" for a random window then go
   * "unavailable" — mirrors how a real person exits the conversation.
   */
  private scheduleGoOffline(jid: string) {
    const delay = 2_000 + Math.random() * 4_000; // 2–6 s
    setTimeout(async () => {
      try {
        if (this.state.socket && this.state.connected) {
          await this.state.socket.sendPresenceUpdate("unavailable", jid);
        }
      } catch {}
    }, delay);
  }
}

// ── WhatsApp Manager (per-user instances) ─────────────────────────

class WhatsAppManager {
  private instances = new Map<number, WhatsAppInstance>();

  get(userId: number): WhatsAppInstance {
    if (!this.instances.has(userId)) {
      const inst = new WhatsAppInstance(userId);
      inst.init().catch((err) => appLogger.error({ err, userId }, "WA init failed"));
      this.instances.set(userId, inst);
    }
    return this.instances.get(userId)!;
  }

  /**
   * Connection state of every restored session.
   *
   * Reads what is already in memory rather than creating instances — the
   * health check must not bring a session up as a side effect of looking.
   */
  allStates(): Array<{ userId: number; connected: boolean; status: string }> {
    return [...this.instances.entries()].map(([userId, inst]) => {
      const st = inst.getStatus() as { connected?: boolean; status?: string };
      return { userId, connected: !!st?.connected, status: st?.status ?? "unknown" };
    });
  }

  remove(userId: number) {
    const inst = this.instances.get(userId);
    if (inst) { inst.logout().catch(() => {}); this.instances.delete(userId); }
  }

  has(userId: number) { return this.instances.has(userId); }

  getAllUserIds(): number[] { return [...this.instances.keys()]; }

  onSystemWake() {
    for (const inst of this.instances.values()) inst.onSystemWake();
  }
}

export const waManager = new WhatsAppManager();

// ── Auto-restore sessions on server startup ────────────────────────
// Queries the DB for users that have a saved WA session (creds.json in wa_auth_state)
// and restores them.  This works after ANY restart or new deployment because
// the session lives in PostgreSQL, not on the ephemeral filesystem.

export async function restoreAllSessions() {
  try {
    // Find all users that have creds saved in DB
    const rows = await db
      .selectDistinct({ userId: waAuthStateTable.userId })
      .from(waAuthStateTable)
      .where(eq(waAuthStateTable.key, "creds.json"));

    for (const { userId } of rows) {
      waManager.get(userId);   // triggers init() → reconnects from DB creds
      appLogger.info({ userId }, "Auto-restoring WA session from DB");
    }
  } catch (err) {
    appLogger.error({ err }, "restoreAllSessions failed");
  }

  // Also scan disk for legacy sessions not yet migrated
  if (!fs.existsSync(BASE_SESSION_DIR)) return;
  const entries = fs.readdirSync(BASE_SESSION_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const userId = parseInt(entry.name, 10);
    if (isNaN(userId)) continue;
    const credsPath = path.join(BASE_SESSION_DIR, entry.name, "creds.json");
    if (!fs.existsSync(credsPath)) continue;
    if (!waManager.has(userId)) {
      waManager.get(userId);
      appLogger.info({ userId }, "Auto-restoring WA session from disk (legacy)");
    }
  }
}

// ── Public helpers ────────────────────────────────────────────────

export function getStatus(userId: number)   { return waManager.get(userId).getStatus(); }
/** The live socket, or null when not connected — for reading groups and asking for older history. */
export function getSocket(userId: number): any { return waManager.get(userId).getSocket(); }
export function getQr(userId: number)       { return waManager.get(userId).getQr(); }
export function getHealth(userId: number)   { return waManager.get(userId).getHealth(); }
export function getSyncStats(userId: number){ return waManager.get(userId).syncStats; }

// ── Diagnostic exports ────────────────────────────────────────────
export function getDiagnosticState(userId: number) { return waManager.get(userId).getDiagnosticState(); }
export async function directSend(userId: number, phone: string, message: string) { return waManager.get(userId).directSend(phone, message); }
export function registerDiagListener(userId: number, fn: (event: { type: string; data: unknown; ts: string }) => void) { return waManager.get(userId).registerDiagListener(fn); }
export function validateSession(userId: number) { return waManager.get(userId).validateSession(); }
export async function checkNumbers(
  userId: number,
  phones: string[],
  onProgress?: (done: number, total: number) => void,
) { return waManager.get(userId).checkNumbers(phones, onProgress); }

export async function initWhatsApp(userId: number) { return waManager.get(userId).init(); }

export async function logout(userId: number) {
  waManager.get(userId).logout();
  waManager.remove(userId);
}

export async function forceResync(userId: number) {
  return waManager.get(userId).forceResync();
}

/** جمع الأرقام من DB (دائم) + الذاكرة (حديث لم يُكتب بعد) */
export async function extractPhones(userId: number): Promise<string[]> {
  const dbRows = await db
    .select({ phone: waContactsTable.phone })
    .from(waContactsTable)
    .where(eq(waContactsTable.userId, userId));
  const inMem = waManager.get(userId).getDiscoveredPhones();
  const all   = new Set([...dbRows.map(r => r.phone), ...inMem]);
  return Array.from(all);
}

/** جمع جهات الاتصال من DB + الذاكرة */
export async function extractContacts(userId: number) {
  const dbRows = await db
    .select()
    .from(waContactsTable)
    .where(eq(waContactsTable.userId, userId))
    .orderBy(desc(waContactsTable.lastMessageAt));

  const dbMap = new Map(dbRows.map(r => [r.phone, {
    phone:         r.phone,
    name:          r.name ?? undefined,
    lastMessageAt: r.lastMessageAt ? Math.floor(new Date(r.lastMessageAt).getTime() / 1000) : 0,
    source:        (r.source ?? "chat") as "phonebook" | "chat",
  }]));

  // دمج الذاكرة: لو الرقم موجود في الذاكرة لكن ليس في DB بعد
  for (const c of waManager.get(userId).getContactStore()) {
    if (!dbMap.has(c.phone)) dbMap.set(c.phone, { ...c, name: c.name ?? undefined });
  }

  return Array.from(dbMap.values()).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
}

export async function resetSession(userId: number) {
  return waManager.get(userId).resetSession();
}

export async function requestPairingCode(userId: number, phoneNumber: string): Promise<string> {
  return waManager.get(userId).requestPairingCode(phoneNumber);
}

export async function markRead(
  userId: number,
  key: { remoteJid?: string | null; id?: string | null; fromMe?: boolean | null; participant?: string | null },
) {
  return waManager.get(userId).markRead(key);
}

// ── Sleep detection ───────────────────────────────────────────────
// A timer cannot fire while the machine is asleep, so a tick that arrives
// much later than scheduled is the one reliable sign the host was down. On
// this laptop that happened 206 times in two days. Dark wakes of a few seconds
// pass under the threshold; a real sleep — long enough for WhatsApp to have
// dropped every socket — does not.
export function startWakeDetector() {
  const TICK_MS = 15_000;
  const JUMP_MS = 60_000;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    const gap = now - last;
    last = now;
    if (gap < TICK_MS + JUMP_MS) return;
    appLogger.warn({ asleepSeconds: Math.round(gap / 1000) }, "clock jumped — the host was asleep; reconnecting every session");
    // Kept, so the morning brief can tell the owner how often the machine slept.
    void import("@workspace/db").then(({ db, hostSleepsTable }) => db.insert(hostSleepsTable).values({ seconds: Math.round(gap / 1000) })).catch(() => {});
    invalidateWaVersion("host woke from sleep");
    waManager.onSystemWake();
  }, TICK_MS);
  appLogger.info("sleep detector started");
}

export async function sendMessage(
  userId: number, phone: string, message: string,
  messageType?: string, mediaUrl?: string | null,
  buttons?: string | null, carousel?: string | null,
): Promise<string | undefined> {
  return waManager.get(userId).sendMessage(phone, message, messageType, mediaUrl, buttons, carousel);
}

/** The words as a voice note — spoken by the account's voice, with the text as the fallback. */
export async function sendVoiceNote(userId: number, phone: string, text: string): Promise<string | undefined> {
  return waManager.get(userId).sendMessage(phone, text, "voice");
}

// ── User-connected hook ───────────────────────────────────────────
// Registered listeners are called whenever a user's WhatsApp session
// transitions to "connected" (initial connect OR reconnect).
// Used by campaign logic to auto-resume paused campaigns on reconnect.
type ConnectHook = (userId: number) => void;
const onConnectHooks: ConnectHook[] = [];
export function registerOnConnectHook(fn: ConnectHook) { onConnectHooks.push(fn); }

// ── Inbound hooks ─────────────────────────────────────────────────
// Called for every incoming message. Lets the follow-up engine react to new
// leads and replies while depending on this module one-way, rather than this
// module importing it back.
export type InboundHook = (ev: {
  userId: number;
  phone: string;
  text: string;
  message: unknown;      // the raw Baileys message, for referral extraction
}) => void | Promise<void>;

const inboundHooks: InboundHook[] = [];
export function registerInboundHook(fn: InboundHook) { inboundHooks.push(fn); }

/** A person replied from the phone. The bot and the follow-ups must yield. */
export type HumanReplyHook = (ev: { userId: number; phone: string; text: string }) => void | Promise<void>;
const humanReplyHooks: HumanReplyHook[] = [];
export function registerHumanReplyHook(fn: HumanReplyHook) { humanReplyHooks.push(fn); }
function emitHumanReply(ev: Parameters<HumanReplyHook>[0]) {
  for (const fn of humanReplyHooks) {
    Promise.resolve().then(() => fn(ev)).catch((err) =>
      appLogger.warn({ err: String((err as any)?.message ?? err), userId: ev.userId }, "human-reply hook failed"));
  }
}

export function emitInbound(ev: Parameters<InboundHook>[0]) {
  for (const fn of inboundHooks) {
    // A hook must never be able to break message handling.
    try {
      const r = fn(ev);
      if (r && typeof (r as Promise<void>).catch === "function") {
        (r as Promise<void>).catch((err) => appLogger.warn({ err }, "inbound hook failed"));
      }
    } catch (err) {
      appLogger.warn({ err }, "inbound hook threw");
    }
  }
}
export function notifyUserConnected(userId: number) {
  for (const fn of onConnectHooks) {
    try { fn(userId); } catch { /* ignore hook errors */ }
  }
}

/**
 * Poll until the WhatsApp instance for this user is connected, or timeout.
 * Returns true if connected within the window, false if timed out.
 */
/** Returns user IDs of ALL active WA manager instances (for the guardian). */
export function getActiveUserIds(): number[] {
  return waManager.getAllUserIds();
}

/**
 * Smart auto-heal for a single user.
 * - connected          → no-op
 * - connecting/reconn  → no-op (already in progress)
 * - qr_ready           → no-op (user must scan; QR regenerates automatically)
 * - disconnected       → triggers initWhatsApp
 */
export async function autoHeal(userId: number): Promise<{ action: string; diagnosis: string }> {
  const s = getStatus(userId);

  if (s.connected) {
    return { action: "already_connected", diagnosis: "الواتساب متصل بشكل صحيح ✅" };
  }

  // ── Stuck in loggedOut loop? ───────────────────────────────────────────────
  // If we've been getting loggedOut for 30+ retries (~45 min at 90s each),
  // the session is likely truly dead (phone removed the device).
  // autoHeal escalates: clear stale creds and force a fresh QR scan.
  // The user only sees this path when they press "إصلاح الاتصال" — it is NOT
  // called automatically, so they are consciously requesting a fresh QR.
  if (
    (s.status === "reconnecting" || s.status === "connecting") &&
    s.loggedOutRetries >= 30
  ) {
    await resetSession(userId);
    return {
      action: "qr_required",
      diagnosis: `جلسة منتهية (${s.loggedOutRetries} محاولة) — تم مسح البيانات القديمة، امسح QR جديد 📱`,
    };
  }

  if (s.status === "connecting" || s.status === "reconnecting") {
    return { action: "in_progress", diagnosis: "جاري إعادة الاتصال — انتظر قليلاً ⏳" };
  }
  if (s.status === "qr_ready") {
    return { action: "qr_required", diagnosis: "يحتاج مسح QR — افتح «ربط الواتساب» 📱" };
  }

  // status === "disconnected" (or unknown) — force init
  await initWhatsApp(userId);
  return { action: "reconnect_triggered", diagnosis: "تم تشغيل إعادة الاتصال تلقائياً 🔄" };
}

export function waitForConnection(userId: number, timeoutMs = 3 * 60_000): Promise<boolean> {
  return new Promise((resolve) => {
    const instance = waManager.get(userId);
    // Already connected — resolve immediately
    if (instance.getStatus().connected) { resolve(true); return; }

    let settled = false;
    let poller: ReturnType<typeof setInterval> | null = null;

    const cleanup = () => {
      const idx = onConnectHooks.indexOf(hook);
      if (idx !== -1) onConnectHooks.splice(idx, 1);
      if (poller) { clearInterval(poller); poller = null; }
    };

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // Event-driven: resolves the moment the user's WA session opens.
    // notifyUserConnected() is called inside connection.update "open" handler.
    const hook = (connectedUserId: number) => {
      if (connectedUserId === userId) settle(true);
    };
    onConnectHooks.push(hook);

    // Hard deadline
    setTimeout(() => settle(false), timeoutMs);

    // Fallback poll every 3 s — handles the rare race where connection
    // opened between the status check above and the hook registration.
    poller = setInterval(() => {
      if (instance.getStatus().connected) settle(true);
    }, 3_000);
  });
}

// ── Utilities ────────────────────────────────────────────────────

function extractText(msg: any): string {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.buttonsResponseMessage?.selectedDisplayText ||
    msg.message?.listResponseMessage?.title ||
    msg.message?.templateButtonReplyMessage?.selectedDisplayText ||
    interactiveReplyText(msg.message?.interactiveResponseMessage) ||
    ""
  ).trim();
}

/**
 * Resolve a media URL to a WAMediaUpload object for Baileys.
 *
 * GCS files are downloaded directly via the GCS SDK so that Baileys never
 * needs to call `fetch("http://localhost:80/...")` which fails in the Replit
 * production container where the reverse-proxy port is not reachable internally.
 */
async function resolveMedia(mediaUrl: string): Promise<WAMediaUpload> {
  // GCS-backed file — download as Buffer with explicit timeout.
  // createReadStream() was replaced because GCS streams can hang silently on
  // network errors without emitting an 'error' event, which caused Baileys to
  // wait forever and then fire our 35-second SEND_TIMEOUT rather than a proper
  // MEDIA_NOT_FOUND. file.download() either resolves (Buffer) or rejects with
  // a real Error, giving the campaign loop a chance to mark the contact failed
  // and move on instead of retrying indefinitely.
  const objectName = objectNameFromUrl(mediaUrl);
  if (objectName) {
    // WAMediaUpload = Buffer | WAMediaPayloadStream | WAMediaPayloadURL.
    // Buffered rather than streamed: see the note in storage.getObjectBuffer.
    return await getObjectBuffer(objectName);
  }
  // Legacy local file path
  if (mediaUrl.startsWith("/") || mediaUrl.startsWith("./")) {
    if (!fs.existsSync(mediaUrl)) {
      throw new Error(`MEDIA_NOT_FOUND: ملف الوسائط غير موجود (${mediaUrl})`);
    }
    return { stream: fs.createReadStream(mediaUrl) };
  }
  // External URL — pass through as-is
  return { url: mediaUrl };
}

/**
 * Work out who a message is from, handling LID addressing.
 *
 * WhatsApp is migrating from phone-number JIDs (`9715...@s.whatsapp.net`) to
 * LIDs (`123...@lid`), and the rollout is per-contact and gradual. Messages
 * from a migrated contact arrive addressed by LID, and the previous code
 * dropped anything that was not `@s.whatsapp.net` with a bare `continue` —
 * silently, in the first two lines of the loop. The socket received the
 * message, the event fired, and nothing was stored, classified or answered.
 * That is why inbound stopped working from one day to the next with no error
 * anywhere.
 *
 * Returns null only for addresses that genuinely are not one-to-one chats.
 */
async function resolveSenderPhone(
  sock: any,
  msg: any,
  lidMap?: Map<string, string>,
): Promise<{ phone: string; via: "pn" | "lid-mapped" | "lid-raw" } | null> {
  const jid: string | undefined = msg?.key?.remoteJid;
  if (!jid) return null;

  // Groups, broadcasts, newsletters and status are correctly out of scope.
  if (jid.endsWith("@g.us") || jid.endsWith("@broadcast") || jid.endsWith("@newsletter")) return null;

  if (jid.endsWith("@s.whatsapp.net")) {
    return { phone: jid.replace("@s.whatsapp.net", ""), via: "pn" };
  }

  if (jid.endsWith("@lid")) {
    // The key sometimes carries the phone-number form alongside the LID.
    const fromKey: string | undefined =
      msg.key.senderPn ?? msg.key.participantPn ?? msg.key.previousRemoteJid;
    if (typeof fromKey === "string" && fromKey.includes("@s.whatsapp.net")) {
      return { phone: fromKey.replace("@s.whatsapp.net", ""), via: "lid-mapped" };
    }
    try {
      const pn: string | null = await sock?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) return { phone: String(pn).replace("@s.whatsapp.net", ""), via: "lid-mapped" };
    } catch { /* fall through */ }

    // The instance already builds a lid -> phone map from the contact sync;
    // it often knows a mapping Baileys' store does not.
    const known = lidMap?.get(jid);
    if (known) return { phone: known, via: "lid-mapped" };

    // Unmapped. Keep the full LID as the key rather than dropping the message:
    // formatPhone passes through anything containing "@", so replies still
    // reach them, and a conversation we can answer beats a clean contact row.
    return { phone: jid, via: "lid-raw" };
  }

  return null;
}

function formatPhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-\+\(\)]/g, "");
  if (cleaned.startsWith("00")) cleaned = cleaned.slice(2);
  if (!cleaned.includes("@")) cleaned += "@s.whatsapp.net";
  return cleaned;
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
