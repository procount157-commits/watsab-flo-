import { displayCompany, fillRecipient, languageOfText, variesPerRecipient } from "../lib/recipient-name";
import { Router } from "express";
import { db, campaignsTable, contactGroupsTable, contactsTable, messageLogs, unsubscribedPhonesTable, waSessionEventsTable, campaignButtonResponsesTable } from "@workspace/db";
import { assessDeliveryHealth, assessAccountHealth, MATURITY_MINUTES, MIN_SAMPLE as DELIVERY_MIN_SAMPLE } from "../lib/delivery-health";
import { computeGap, diurnalFactor } from "../lib/pacing";
import { assertCanSend, assertCanCreateCampaign, assertCanAddContacts, planErrorToResponse } from "../lib/plans";
import { strangerShare24h } from "../lib/delivery-health";
import { isWithinSendingHours, hourInSendingTz, msLeftInSendingWindow, SENDING_TZ, SENDING_HOUR_START, SENDING_HOUR_END } from "../lib/sending-hours";
import { getEffectiveDailyLimit, getDailySentCount, DAILY_LIMIT_MAX, numberAgeDays } from "../lib/daily-limit";
import { getControls } from "../lib/ops-agent";
import { objectExists, objectNameFromUrl } from "../lib/storage";
import * as XLSX from "xlsx";
import { eq, desc, count, sql, and, gte, inArray, lt, max, asc } from "drizzle-orm";
import { sendMessage, getStatus, waitForConnection, registerOnConnectHook, initWhatsApp } from "../lib/whatsapp";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";
import { classifyFailure, NON_RETRYABLE_PATTERN } from "../lib/failure-classifier";
import fs from "fs";
import path from "path";

// Connection-lost errors that trigger reconnect logic
// NOTE: "fetch failed" is intentionally excluded — it indicates a media-download
// failure (localhost proxy unreachable) not a WA socket disconnect.
// SOCKET_CLOSED_MID_SEND: our own fail-fast abort fired because the WA socket
// reconnected while a send was in flight. This is transient (the reconnect
// itself, not the contact) so it must retry, not skip.
const CONNECTION_ERR = /غير متصل|not connected|connection closed|disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network error|ERR_NETWORK|SOCKET_CLOSED_MID_SEND/i;
// Timeout errors — treat as connection errors (socket hung, reconnect & retry)
const TIMEOUT_ERR    = /ONWHATSAPP_TIMEOUT/i;
// Media errors — file missing or GCS config problem; skip the contact immediately
// SEND_TIMEOUT is non-retryable — if the socket hung for 35 s (usually a media
// upload failure), further retries will hit the same hang. Mark the contact as
// failed and move on rather than looping forever.
const MEDIA_ERR      = /MEDIA_NOT_FOUND|MEDIA_CONFIG_ERR|ENOENT|NOT_ON_WHATSAPP|SEND_TIMEOUT/i;
// DB transient errors — pg pool blips, TLS drops, auth timeouts (e.g. 2 AM maintenance)
const DB_TRANSIENT_ERR = /socket disconnected|connection terminated|authentication timed out|network socket disconnected|ECONNRESET|ETIMEDOUT|Client.*closed|pool.*closed/i;

/**
 * Retry a DB operation up to `maxAttempts` times on transient pg-pool errors.
 * Uses exponential backoff: 3s → 9s → 27s …
 * On non-transient errors it throws immediately.
 */
async function withDbRetry<T>(fn: () => Promise<T>, maxAttempts = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err?.cause?.message ?? "");
      if (!DB_TRANSIENT_ERR.test(msg) || attempt === maxAttempts) throw err;
      const delayMs = Math.min(3_000 * Math.pow(3, attempt - 1), 60_000);
      logger.warn({ attempt, maxAttempts, delayMs, err: msg }, "DB transient error — retrying");
      await sleep(delayMs);
    }
  }
  throw new Error("withDbRetry: unreachable");
}

/**
 * Block until the sending window opens. Sleeps in short slices so pausing a
 * campaign overnight takes effect immediately instead of waiting until morning.
 */
async function waitForSendingHours(campaignId: number, info: { running: boolean; lastProgressAt: number }): Promise<void> {
  if (isWithinSendingHours()) return;

  logger.info(
    { campaignId, tz: SENDING_TZ, hour: hourInSendingTz(), window: `${SENDING_HOUR_START}:00-${SENDING_HOUR_END}:00` },
    "خارج ساعات الإرسال — انتظار فتح النافذة",
  );

  while (info.running && !isWithinSendingHours()) {
    await interruptibleSleep(60_000, info);
    info.lastProgressAt = Date.now(); // waiting on purpose — not a stall
  }

  if (info.running) {
    logger.info({ campaignId, hour: hourInSendingTz() }, "ساعات الإرسال فُتحت — استئناف");
  }
}

// ── Arabic synonym variation ─────────────────────────────────────
// Replaces common Arabic marketing/greeting words with synonyms so
// every message has a slightly different surface form — making WA's
// semantic similarity classifier treat them as distinct messages.
// Replacements use phone-hash seed → same number always gets the
// same synonym (deterministic + bitwise-unique across recipients).
const AR_SYNONYMS: Array<[string, string[]]> = [
  ["أهلاً وسهلاً",  ["مرحباً بك", "حياك الله"]],
  ["أهلاً",          ["مرحباً", "حياك الله"]],
  ["مرحباً",         ["أهلاً وسهلاً", "حياك الله"]],
  ["يسعدنا",        ["يشرفنا", "يسرنا"]],
  ["يشرفنا",        ["يسعدنا", "يسرنا"]],
  ["للتواصل",       ["للاستفسار", "لمزيد من التفاصيل"]],
  ["للاستفسار",     ["للتواصل", "لمعرفة المزيد"]],
  ["عروض رائعة",    ["أسعار مميزة", "فرص ذهبية"]],
  ["عروض",          ["أسعار خاصة", "تخفيضات مميزة"]],
  ["تواصل معنا",    ["تفضل بالتواصل", "راسلنا الآن"]],
  ["كلمنا",          ["راسلنا", "تواصل معنا"]],
  ["احترافية",      ["عالية الجودة", "متميزة"]],
  ["مباشرة",         ["فوراً", "حالاً"]],
  ["الآن",           ["اليوم", "فوراً"]],
  ["فوراً",          ["حالاً", "الآن"]],
];

function arabicSynonymVariation(text: string, seed: number): string {
  if (text.length < 15) return text;
  let result = text;
  let replaced = 0;
  const MAX_REPLACEMENTS = 2; // at most 2 word swaps per message

  for (const [word, synonyms] of AR_SYNONYMS) {
    if (replaced >= MAX_REPLACEMENTS) break;
    if (!result.includes(word)) continue;
    const synonym = synonyms[(seed + replaced) % synonyms.length]!;
    result = result.replace(word, synonym); // first occurrence only
    replaced++;
  }
  return result;
}

// ── Break cadence ─────────────────────────────────────────────────
// Two tiers of pauses mimic real human behaviour:
//   Micro-break  every ~12 messages  → 30–90 s  (checking phone, brief distraction)
//   Long break   every ~40 messages  → 2–5 min  (away from desk, making tea)
// The exact trigger varies slightly per campaign via offset to avoid
// every campaign pausing at exactly the same message count.
const MICRO_BREAK_EVERY = 12;


// Typed error thrown when WA is disconnected after all retry attempts —
// campaign loop catches this, keeps status="running", and auto-restarts.
const WA_DISCONNECTED = "WA_DISCONNECTED";

// ── Random jitter helper ─────────────────────────────────────────
// Returns a random integer ms between min and max (inclusive).
// Used everywhere a delay appears so WA's traffic analysis never
// sees a fixed send/reconnect cadence.
function jitter(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs + 1));
}

/**
 * Try to send up to 3 times with escalating random delays between attempts.
 *
 *   Attempt 1 → connection error → wait  8–20 s → attempt 2
 *   Attempt 2 → connection error → wait 25–55 s → attempt 3
 *   Attempt 3 → connection error → throw WA_DISCONNECTED
 *
 * Random intervals mean WA's traffic analyser never sees a fixed retry
 * cadence, which reduces the "automated tool" signal score.
 *
 * Media/config errors are thrown immediately (skip the contact).
 */
async function sendWithReconnect(
  userId: number,
  phone: string,
  message: string,
  messageType?: string,
  mediaUrl?: string | null,
  buttons?: string | null,
  carousel?: string | null,
): Promise<string | undefined> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const msgId = await sendMessage(userId, phone, message, messageType, mediaUrl, buttons, carousel);
      return msgId; // ✓ sent — return Baileys message ID for delivery tracking
    } catch (err: any) {
      const msg = String(err?.message ?? err ?? "");

      // Media / config error — no retry, skip this contact immediately
      if (MEDIA_ERR.test(msg)) throw err;

      if (CONNECTION_ERR.test(msg) || TIMEOUT_ERR.test(msg)) {
        if (attempt < MAX_ATTEMPTS) {
          // Random escalating back-off between retries
          const waitMs = attempt === 1
            ? jitter(8_000, 20_000)   // 8–20 s
            : jitter(25_000, 55_000); // 25–55 s
          logger.warn(
            { phone, userId, attempt, waitSec: Math.round(waitMs / 1000), err: msg },
            `إرسال فشل (اتصال) — محاولة ${attempt}/${MAX_ATTEMPTS - 1} — انتظار ${Math.round(waitMs / 1000)}ث`,
          );
          await sleep(waitMs);
          continue;
        }
        // All attempts exhausted — signal campaign loop to pause & auto-restart
        throw new Error(WA_DISCONNECTED);
      }

      throw err; // unknown error — rethrow
    }
  }
  return undefined;
}

const router = Router();
router.use(requireAuth);

// ── Campaign runtime state ────────────────────────────────────────────
// One entry per active campaign loop, keyed by "userId:campaignId".
// lastProgressAt: timestamp (ms) of the last successful send — used by
//   the stuck-loop watchdog to detect frozen loops.
// consecutiveWaFailures: how many times WA_DISCONNECTED fired back-to-back
//   for this user.  Resets on every successful send.  When it reaches 3 we
//   force a full WA init() before retrying (escalated recovery).
// ── Quality thresholds for auto-pause ─────────────────────────────
// If failure rate in the last QUALITY_WINDOW messages exceeds FAILURE_THRESHOLD,
// the campaign is auto-paused to protect the WhatsApp account from bans.
const QUALITY_WINDOW    = 20;  // look at last N messages
const FAILURE_THRESHOLD = 0.40; // 40% failure rate triggers auto-pause

// ── Delivery guard ────────────────────────────────────────────────
// The failure-rate guard above only sees errors thrown at send time. A
// throttled number keeps reporting successful sends while nothing arrives,
// so delivery receipts are checked separately, every N sends.
const DELIVERY_CHECK_EVERY = 25;

// ── Canary ────────────────────────────────────────────────────────
// The delivery guard cannot see anything until receipts mature, which at a 19s
// pace is another ~60 messages sent blind. On a large list that is most of a
// bad outcome already spent. So a big campaign sends a small batch, waits for
// those receipts, and only then releases the rest.
//
// Small lists skip this entirely — a 30-message campaign is its own canary,
// and a 20-minute hold on it would be pure annoyance.
const CANARY_MIN_LIST = 100;
const CANARY_SIZE     = 30;

// How often the account-wide check runs. Less frequent than the per-campaign
// one because it is a heavier query and a slower-moving signal.
const ACCOUNT_CHECK_EVERY = 60;
// When delivery sags but has not collapsed, stretch the gaps instead of
// stopping — backing off is usually enough to recover.
const DELIVERY_SLOW_FACTOR = 2.5;

type CampaignInfo = {
  running:               boolean;
  index:                 number;
  lastProgressAt:        number;   // Date.now() ms
  consecutiveWaFailures: number;
  startedAt:             number;   // Date.now() ms
  recentOutcomes:        ("sent" | "failed")[];  // rolling window for quality monitoring
  deliverySlowMode?:     boolean;  // set by the delivery guard — widens every gap
  canaryCleared?:        boolean;  // canary batch assessed and released
  skipDailyDedup?:       boolean;  // bypass cross-campaign daily dedup (used by send-remaining)
};
const activeCampaigns = new Map<string, CampaignInfo>();
const campaignKey = (userId: number, campaignId: number) => `${userId}:${campaignId}`;

// ── Auto-resume on WA reconnect ────────────────────────────────────
// Whenever a user's WhatsApp reconnects, resume their running campaigns.
// If the DB is also recovering (e.g. 2 AM maintenance), retry up to 5×
// with exponential backoff so the campaign is never silently abandoned.
registerOnConnectHook((userId) => {
  const tryResume = (attempt: number) => {
    setTimeout(async () => {
      try {
        await resumeRunningCampaigns(userId);
      } catch (err: any) {
        const msg = String(err?.message ?? err?.cause?.message ?? "");
        if (DB_TRANSIENT_ERR.test(msg) && attempt < 5) {
          const delayMs = Math.min(5_000 * Math.pow(2, attempt), 120_000);
          logger.warn({ userId, attempt, delayMs }, "DB still recovering after WA reconnect — will retry resume");
          tryResume(attempt + 1);
        } else {
          logger.error({ err, userId }, "Auto-resume on reconnect failed");
        }
      }
    }, attempt === 0 ? 8_000 : 0);
  };
  tryResume(0);
});

// ── Campaign watchdog ────────────────────────────────────────────────
// Runs every 2 minutes.  Catches two distinct failure modes:
//
//  A) Orphaned campaign — status="running" in DB but no active loop.
//     Cause: server restart, unhandled exception, 2 AM DB+WA dual-drop.
//     Fix:   call resumeRunningCampaigns().
//
//  B) Frozen loop — loop IS registered in activeCampaigns but lastProgressAt
//     hasn't moved for > STUCK_THRESHOLD_MS (15 min).
//     Cause: loop stuck in a long sleep, or wedged on a WA call.
//     Fix:   forcibly stop the old loop and restart it.
//
const STUCK_THRESHOLD_MS = 15 * 60_000; // 15 minutes of no progress = stuck

async function runWatchdog() {
  try {
    const running = await withDbRetry(() =>
      db.select({ id: campaignsTable.id, userId: campaignsTable.userId })
        .from(campaignsTable)
        .where(eq(campaignsTable.status, "running"))
    );

    const now = Date.now();
    for (const c of running) {
      if (!c.userId) continue;
      const key = campaignKey(c.userId, c.id);
      const info = activeCampaigns.get(key);

      if (!info) {
        // Case A: orphaned campaign — status="running" in DB but no active loop
        logger.warn({ campaignId: c.id, userId: c.userId }, "Watchdog: orphaned running campaign — resuming");
        resumeRunningCampaigns(c.userId).catch(() => {});
        continue;
      }

      // Case B: frozen loop — registered in activeCampaigns but no progress for > 15 min
      const idleMs = now - info.lastProgressAt;
      if (info.running && idleMs > STUCK_THRESHOLD_MS) {
        logger.warn({ campaignId: c.id, userId: c.userId, idleMinutes: Math.round(idleMs / 60_000) },
          "Watchdog: campaign loop appears frozen — forcing restart");
        info.running = false;
        activeCampaigns.delete(key);
        setTimeout(() => resumeRunningCampaigns(c.userId!).catch(() => {}), 5_000);
      }
    }
  } catch { /* ignore — will retry next cycle */ }
}

// Run immediately at startup (no waiting for first interval tick)
// so orphaned campaigns are caught within seconds of a server restart.
setTimeout(() => runWatchdog().catch(() => {}), 10_000);

// Then run every 45 seconds (was 90s) for tighter detection
setInterval(() => runWatchdog().catch(() => {}), 45_000);

// ── Startup recovery ──────────────────────────────────────────────
// Called once at server start — resumes any campaign that was left in
// "running" state (e.g. after a server crash or Replit restart).
export async function resumeRunningCampaigns(forUserId?: number): Promise<void> {
  // Wrap the outer query in withDbRetry so a transient DB blip doesn't
  // silently abandon a campaign (root cause of the 2 AM stoppage).
  const running = await withDbRetry(() =>
    db.select()
      .from(campaignsTable)
      .where(
        forUserId != null
          ? and(eq(campaignsTable.status, "running"), eq(campaignsTable.userId, forUserId))
          : eq(campaignsTable.status, "running")
      )
  );

  if (!running.length) return;
  logger.info({ count: running.length, forUserId }, "Resuming running campaigns");

  for (const campaign of running) {
    if (!campaign.userId || !campaign.contactGroupId) continue;

    const key = campaignKey(campaign.userId, campaign.id);
    if (activeCampaigns.has(key)) continue; // already in flight

    try {
      const contacts = await withDbRetry(() =>
        db.select()
          .from(contactsTable)
          .where(and(eq(contactsTable.groupId, campaign.contactGroupId!), eq(contactsTable.status, "active")))
      );

      if (!contacts.length) {
        await withDbRetry(() =>
          db.update(campaignsTable).set({ status: "completed" }).where(eq(campaignsTable.id, campaign.id))
        );
        continue;
      }

      const existingLogs = await withDbRetry(() =>
        db.select({ phone: messageLogs.phone, status: messageLogs.status })
          .from(messageLogs)
          .where(eq(messageLogs.campaignId, campaign.id))
      );
      const sentPhones = new Set(existingLogs.filter((l) => l.status === "sent").map((l) => l.phone));

      const unsubRows = await withDbRetry(() =>
        db.select({ phone: unsubscribedPhonesTable.phone })
          .from(unsubscribedPhonesTable)
          .where(eq(unsubscribedPhonesTable.userId, campaign.userId!))
      );
      const unsubSet = new Set(unsubRows.map((r) => r.phone));

      const remaining = contacts.filter((c) => !sentPhones.has(c.phone) && !unsubSet.has(c.phone));

      if (!remaining.length) {
        await withDbRetry(() =>
          db.update(campaignsTable).set({ status: "completed" }).where(eq(campaignsTable.id, campaign.id))
        );
        continue;
      }

      // ── BUGFIX: don't start the campaign loop if WA is not connected ──
      // Previously, resumeRunningCampaigns would call runCampaign immediately
      // regardless of WA state.  The loop would then fail within 8+8s, schedule
      // a 30s auto-restart, fail again, etc. — a busy-loop of DB + WA calls.
      // Now we skip unless connected; the registerOnConnectHook fires when WA
      // comes back and will call resumeRunningCampaigns again automatically.
      const waState = getStatus(campaign.userId);
      if (!waState.connected) {
        logger.info({ campaignId: campaign.id, userId: campaign.userId, waStatus: waState.status }, "WA not connected — skipping resume, will auto-start on reconnect");
        continue; // don't add to activeCampaigns — connect hook will resume
      }

      const info: CampaignInfo = { running: true, index: 0, lastProgressAt: Date.now(), consecutiveWaFailures: 0, startedAt: Date.now(), recentOutcomes: [] };
      activeCampaigns.set(key, info);

      logger.info({ campaignId: campaign.id, userId: campaign.userId, remaining: remaining.length }, "Campaign resumed");

      runCampaign(campaign.userId, campaign, remaining, info, key).catch((err) =>
        logger.error({ err, campaignId: campaign.id }, "Resumed campaign error")
      );
    } catch (err) {
      logger.error({ err, campaignId: campaign.id }, "Failed to resume campaign");
    }
  }
}

// ── Daily per-phone dedup ─────────────────────────────────────────
// Returns true if this phone received a successful message today
// from ANY of this user's campaigns (midnight-to-now window).
async function wasSentTodayToPhone(userId: number, phone: string): Promise<boolean> {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const [row] = await db
    .select({ phone: messageLogs.phone })
    .from(messageLogs)
    .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
    .where(
      and(
        eq(campaignsTable.userId, userId),
        eq(messageLogs.phone, phone),
        eq(messageLogs.status, "sent"),
        gte(messageLogs.sentAt, midnight),
      )
    )
    .limit(1);
  return !!row;
}

// ── Personalization ───────────────────────────────────────────────
// ── Random phrase pools for anti-ban dynamic variables ────────────
const PHRASE_POOLS: Record<string, string[]> = {
  تحية: [
    "مرحباً",
    "هلا",
    "أهلاً وسهلاً",
    "يسعد وقتك",
    "السلام عليكم",
    "هلا والله",
    "صباح الخير",
    "مساء الخير",
  ],
  ختام: [
    "نتشرف بخدمتك",
    "يسعدنا تواصلك",
    "نحن في خدمتك دائماً",
    "يسعدنا مساعدتك",
    "تواصل معنا في أي وقت",
    "نحن هنا لأجلك",
    "شكراً لثقتك بنا",
    "نتطلع لخدمتك",
  ],
  cta: [
    "تواصل معنا",
    "راسلنا الآن",
    "أرسل لنا",
    "كلمنا",
    "نحن هنا لك",
    "تواصل بنا اليوم",
    "ابدأ الآن",
    "احجز الآن",
  ],
  فاصل: [
    "━━━━━━━━━━",
    "▪ ▪ ▪ ▪ ▪ ▪",
    "— — — — —",
    "· · · · · ·",
    "⋯⋯⋯⋯⋯⋯",
    "• • • • • •",
    "─ ─ ─ ─ ─",
    "◆◆◆◆◆◆◆",
  ],
};

// ── Spintax processor ─────────────────────────────────────────────
// Handles {option1|option2|option3} syntax — picks one option per contact
// using the phone hash for deterministic but unique selection.
// Must run BEFORE personalizeMessage so named vars inside spintax also expand.
function processSpintax(text: string, seed: number): string {
  return text.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, inner: string) => {
    const options = inner.split("|").map((o) => o.trim()).filter(Boolean);
    if (!options.length) return inner;
    return options[seed % options.length] ?? options[0]!;
  });
}

function personalizeMessage(
  template: string,
  contact: { name?: string | null; phone: string },
  companyName?: string | null
): string {
  const now = new Date();
  const time = now.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", hour12: true });
  const date = now.toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const seed = hashPhone(contact.phone);

  // 0. The recipient's company, with its fallback — before spintax, which
  //    would read the bar in {اسم_الشركة|شركتكم} as a choice of two.
  const lang = languageOfText(template);
  const recipient = displayCompany(contact.name, lang);
  let text = fillRecipient(template, contact.name);

  // 1. Process spintax: {opt1|opt2|opt3} → pick one
  text = processSpintax(text, seed);

  // 2. Arabic synonym variation — varies surface form so WA's semantic
  //    similarity classifier scores each message as distinct content.
  text = arabicSynonymVariation(text, seed);

  // 3. Resolve named random pools: {تحية}, {ختام}, {cta}, {فاصل}
  text = text.replace(/\{(تحية|ختام|cta|فاصل)\}/g, (_, key: string) => {
    const pool = PHRASE_POOLS[key];
    if (!pool || !pool.length) return "";
    return pool[seed % pool.length] ?? pool[0]!;
  });

  // 3. Standard personalization variables
  return text
    .replace(/\{الاسم\}|\{name\}|\{اسم\}/gi, recipient)
    .replace(/\{الوقت\}|\{time\}|\{وقت\}/gi, time)
    .replace(/\{التاريخ\}|\{date\}|\{تاريخ\}/gi, date)
    .replace(/\{الشركة\}|\{الشركه\}|\{company\}|\{شركة\}|\{شركه\}/gi, companyName || "")
    .replace(/\{الرقم\}|\{phone\}/gi, contact.phone);
}

function hashPhone(phone: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < phone.length; i++) {
    h ^= phone.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The message as the first numbers of a list will receive it, and whether it differs per person. */
router.post("/preview", async (req, res) => {
  const userId = req.session.userId!;
  const message = String(req.body?.message ?? "");
  const groupId = Number(req.body?.groupId) || null;
  let sample: Array<{ name: string | null; phone: string }> = [];
  if (groupId) {
    const [g] = await db.select({ id: contactGroupsTable.id }).from(contactGroupsTable).where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId))).limit(1);
    if (g) sample = await db.select({ name: contactsTable.name, phone: contactsTable.phone }).from(contactsTable).where(and(eq(contactsTable.groupId, groupId), eq(contactsTable.status, "active"))).limit(3);
  }
  if (!sample.length) sample = [{ name: "WEST LEGEND REAL ESTATE BROKERS L.L.C", phone: "971500000001" }, { name: "الاطلالة للمقاولات العامة Al Etlala General Contracting", phone: "971500000002" }, { name: null, phone: "971500000003" }];
  const companyName = String(req.body?.companyName ?? "") || null;
  res.json({
    samples: sample.map((c) => ({ name: c.name, phone: c.phone, text: personalizeMessage(message, c, companyName) })),
    varies: variesPerRecipient(message),
  });
});

// List campaigns
router.get("/", async (req, res) => {
  const userId = req.session.userId!;
  const campaigns = await db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      status: campaignsTable.status,
      contactGroupId: campaignsTable.contactGroupId,
      contactGroupName: contactGroupsTable.name,
      message: campaignsTable.message,
      messageType: campaignsTable.messageType,
      mediaUrl: campaignsTable.mediaUrl,
      buttons: campaignsTable.buttons,
      carousel: campaignsTable.carousel,
      companyName: campaignsTable.companyName,
      pacingMode: campaignsTable.pacingMode,
      delayMin: campaignsTable.delayMin,
      delayMax: campaignsTable.delayMax,
      scheduledAt: campaignsTable.scheduledAt,
      sentCount: campaignsTable.sentCount,
      failedCount: campaignsTable.failedCount,
      totalCount: campaignsTable.totalCount,
      createdAt: campaignsTable.createdAt,
    })
    .from(campaignsTable)
    .leftJoin(contactGroupsTable, eq(campaignsTable.contactGroupId, contactGroupsTable.id))
    .where(eq(campaignsTable.userId, userId))
    .orderBy(desc(campaignsTable.createdAt));

  res.json(campaigns.map((c) => ({ ...c, contactGroupName: c.contactGroupName || null })));
});

// Create campaign
router.post("/", async (req, res) => {
  const userId = req.session.userId!;
  const {
    name, message, messageType = "text",
    mediaUrl, buttons, carousel, companyName,
    pacingMode = "auto", delayMin = 5, delayMax = 15, scheduledAt,
    inlineNumbers,
  } = req.body;
  let { contactGroupId } = req.body;

  if (!name || !message) return res.status(400).json({ error: "اسم الحملة ونص الرسالة مطلوبان" });

  try {
    await assertCanCreateCampaign(userId);
    if (inlineNumbers && !contactGroupId) {
      await assertCanAddContacts(userId, String(inlineNumbers).split(/[\n,\r]+/).filter((p: string) => p.trim()).length);
    }
  } catch (err) { if (planErrorToResponse(err, res)) return; throw err; }

  if (inlineNumbers && !contactGroupId) {
    const rawPhones: string[] = String(inlineNumbers)
      .split(/[\n,\r]+/)
      .map((p: string) => p.trim().replace(/[\s\-\+\(\)\.]/g, "").replace(/^00/, ""))
      .filter((p: string) => /^\d{7,15}$/.test(p));

    if (!rawPhones.length) return res.status(400).json({ error: "لم يُعثر على أرقام صالحة" });

    const unique = [...new Set(rawPhones)];
    const [grp] = await db.insert(contactGroupsTable).values({ userId, name: `${name} — أرقام مباشرة`, description: "أرقام تمت إضافتها مباشرة" }).returning();

    const BATCH = 200;
    for (let i = 0; i < unique.length; i += BATCH) {
      await db.insert(contactsTable).values(unique.slice(i, i + BATCH).map((phone) => ({ groupId: grp.id, phone, status: "active" }))).onConflictDoNothing();
    }
    contactGroupId = grp.id;
  }

  if (!contactGroupId) return res.status(400).json({ error: "يرجى اختيار قائمة أرقام أو لصق الأرقام مباشرة" });

  const [campaign] = await db.insert(campaignsTable).values({
    userId,
    name, contactGroupId: parseInt(contactGroupId), message, messageType,
    mediaUrl, buttons, carousel, companyName: companyName || null,
    pacingMode: pacingMode === "manual" ? "manual" : "auto",
    delayMin: parseInt(delayMin), delayMax: parseInt(delayMax),
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
  }).returning();

  const [group] = await db.select({ name: contactGroupsTable.name }).from(contactGroupsTable).where(eq(contactGroupsTable.id, parseInt(contactGroupId)));

  res.status(201).json({ ...campaign, contactGroupName: group?.name || null });
});

// Get campaign
router.get("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const [campaign] = await db
    .select({
      id: campaignsTable.id,
      name: campaignsTable.name,
      status: campaignsTable.status,
      contactGroupId: campaignsTable.contactGroupId,
      contactGroupName: contactGroupsTable.name,
      message: campaignsTable.message,
      messageType: campaignsTable.messageType,
      mediaUrl: campaignsTable.mediaUrl,
      buttons: campaignsTable.buttons,
      carousel: campaignsTable.carousel,
      companyName: campaignsTable.companyName,
      pacingMode: campaignsTable.pacingMode,
      delayMin: campaignsTable.delayMin,
      delayMax: campaignsTable.delayMax,
      scheduledAt: campaignsTable.scheduledAt,
      sentCount: campaignsTable.sentCount,
      failedCount: campaignsTable.failedCount,
      totalCount: campaignsTable.totalCount,
      createdAt: campaignsTable.createdAt,
    })
    .from(campaignsTable)
    .leftJoin(contactGroupsTable, eq(campaignsTable.contactGroupId, contactGroupsTable.id))
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));

  if (!campaign) return res.status(404).json({ error: "Not found" });
  res.json({ ...campaign, contactGroupName: campaign.contactGroupName || null });
});

// Update campaign
router.patch("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const updates: Record<string, any> = {};

  const allowed = ["name", "message", "messageType", "mediaUrl", "buttons", "carousel", "companyName", "pacingMode", "delayMin", "delayMax", "scheduledAt"];
  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      if (field === "scheduledAt") updates[field] = req.body[field] ? new Date(req.body[field]) : null;
      else if (field === "pacingMode") updates[field] = req.body[field] === "manual" ? "manual" : "auto";
      else if (field === "delayMin" || field === "delayMax") updates[field] = parseInt(req.body[field]);
      else updates[field] = req.body[field];
    }
  }

  const [updated] = await db.update(campaignsTable).set(updates).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId))).returning();
  if (!updated) return res.status(404).json({ error: "Not found" });

  const [group] = await db.select({ name: contactGroupsTable.name }).from(contactGroupsTable).where(eq(contactGroupsTable.id, updated.contactGroupId!));
  res.json({ ...updated, contactGroupName: group?.name || null });
});

// Delete campaign
router.delete("/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const key = campaignKey(userId, id);
  const info = activeCampaigns.get(key);
  if (info) info.running = false;
  activeCampaigns.delete(key);
  await db.delete(campaignsTable).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  res.json({ success: true, message: "Deleted" });
});

// Start campaign
router.post("/:id/start", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);

  const waStatus = getStatus(userId);
  if (!waStatus.connected) return res.status(400).json({ error: "يجب ربط واتساب أولاً — اذهب إلى صفحة ربط الواتساب" });

  try { await assertCanSend(userId); } catch (err) { if (planErrorToResponse(err, res)) return; throw err; }

  // ── A number that has not talked to anyone yet does not campaign ──
  // The first thing WhatsApp sees of a new number is what it does in its
  // first two days. Two days of ordinary conversation — replies, contacts
  // — before the first bulk send is the cheapest warm-up there is, and the
  // one most people skip.
  const ageDays = await numberAgeDays(userId);
  const minHours = Number(process.env["WARMUP_MIN_HOURS"] ?? 48);
  if (ageDays * 24 < minHours) {
    return res.status(400).json({
      error: `الرقم مرتبط منذ أقل من ${minHours} ساعة. استخدمه في محادثات عادية أولاً — الرد على من يراسلك، مراسلة من تعرفهم — ثم ابدأ الحملة. هذا أرخص إحماء ممكن.`,
      numberAgeDays: ageDays,
    });
  }

  // ── Daily warm-up limit check (before starting) ──────────────────
  const [dailyCount, effectiveLimitNow] = await Promise.all([
    getDailySentCount(userId),
    getEffectiveDailyLimit(userId),
  ]);
  if (dailyCount >= effectiveLimitNow) {
    return res.status(429).json({
      error: `وصلت للحد اليومي (${effectiveLimitNow} رسالة خلال 24 ساعة). الحد يزيد تدريجياً كلما أصبح رقمك أقدم لحماية حسابك.`,
      dailySent: dailyCount,
      dailyLimit: effectiveLimitNow,
    });
  }

  const [campaign] = await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return res.status(404).json({ error: "Not found" });
  if (!campaign.contactGroupId) return res.status(400).json({ error: "No contact group assigned" });

  // status != "active" means the number failed WhatsApp validation — sending to
  // it burns a slot from the daily allowance and feeds the failure rate. The
  // resume path already filtered these; start, send-remaining and retry did not.
  // Recipients who already have a thread with this number go first.
  //
  // Two reasons, both about the ban signal rather than about them: someone who
  // has messaged you before is very unlikely to block or report, and the ratio
  // of messages to non-contacts is one of the things enforcement actually keys
  // on. Opening a campaign on known contacts builds positive engagement before
  // it reaches cold numbers — and if a guard stops the campaign early, the
  // budget was spent on the safest recipients rather than at random.
  const contacts = await db.select().from(contactsTable)
    .where(and(eq(contactsTable.groupId, campaign.contactGroupId), eq(contactsTable.status, "active")))
    .orderBy(
      sql`(exists (
        select 1 from wa_conversations wc
        where wc.user_id = ${userId} and wc.phone = ${contactsTable.phone}
      )) desc`,
      contactsTable.id,
    );
  if (!contacts.length) return res.status(400).json({ error: "لا توجد أرقام صالحة في القائمة" });

  // ── Media file validation ─────────────────────────────────────────
  // Validate BEFORE starting the loop — prevents all contacts from
  // showing as "failed" when the real problem is a deleted upload.
  if (campaign.mediaUrl) {
    const storedObject = objectNameFromUrl(campaign.mediaUrl);
    // A stored-object path used to be assumed valid without checking, so a
    // campaign whose upload never landed passed this gate and then failed once
    // per recipient. Check it like any other.
    if (storedObject && !(await objectExists(storedObject))) {
      return res.status(400).json({
        error: `ملف الوسائط غير موجود في التخزين. عدّل الحملة وارفع الملف مجدداً.\n(${storedObject})`,
      });
    }
    const isLocalPath = !storedObject && (campaign.mediaUrl.startsWith("/") || campaign.mediaUrl.startsWith("./"));
    if (isLocalPath && !fs.existsSync(campaign.mediaUrl)) {
      // Try to find the file by filename in the uploads dir as a fallback
      const uploads = path.resolve(process.cwd(), "uploads");
      const basename = path.basename(campaign.mediaUrl);
      const fallback = path.join(uploads, basename);
      if (fs.existsSync(fallback)) {
        await db.update(campaignsTable).set({ mediaUrl: fallback }).where(eq(campaignsTable.id, id));
        campaign.mediaUrl = fallback;
      } else {
        return res.status(400).json({
          error: `ملف الوسائط المرفق غير موجود على الخادم. يرجى تعديل الحملة ورفع الصورة مجدداً.\n(${path.basename(campaign.mediaUrl)})`,
        });
      }
    }
    // External http(s) URLs are passed through to WhatsApp as-is.
  }

  // Skip numbers already sent in this campaign
  const existingLogs = await db.select({ phone: messageLogs.phone, status: messageLogs.status }).from(messageLogs).where(eq(messageLogs.campaignId, id));
  const sentPhones = new Set(existingLogs.filter((l) => l.status === "sent").map((l) => l.phone));
  const pendingContacts = contacts.filter((c) => !sentPhones.has(c.phone));

  // ── Unsubscribed filter ────────────────────────────────────────────
  // Remove any contact who opted out (sent "0" or stop keyword)
  const unsubRows = await db
    .select({ phone: unsubscribedPhonesTable.phone })
    .from(unsubscribedPhonesTable)
    .where(eq(unsubscribedPhonesTable.userId, userId));
  const unsubSet = new Set(unsubRows.map((r) => r.phone));
  const filteredPending = pendingContacts.filter((c) => !unsubSet.has(c.phone));
  const skippedUnsub = pendingContacts.length - filteredPending.length;

  // ── 72-hour cross-campaign dedup ──────────────────────────────────
  // Skip any phone that received a successful message from ANY of this user's
  // campaigns in the last 72 hours — prevents double-sending after reconnect.
  let skipped72h = 0;
  let finalContacts = filteredPending;
  if (filteredPending.length > 0) {
    const cutoff72h = new Date(Date.now() - 72 * 60 * 60 * 1_000);
    const pendingPhones = filteredPending.map((c) => c.phone);
    const recentRows = await db
      .select({ phone: messageLogs.phone })
      .from(messageLogs)
      .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
      .where(
        and(
          eq(campaignsTable.userId, userId),
          eq(messageLogs.status, "sent"),
          gte(messageLogs.sentAt, cutoff72h),
          inArray(messageLogs.phone, pendingPhones),
        )
      );
    const recent72Set = new Set(recentRows.map((r) => r.phone));
    finalContacts = filteredPending.filter((c) => !recent72Set.has(c.phone));
    skipped72h = filteredPending.length - finalContacts.length;
  }

  await db.update(campaignsTable).set({ status: "running", totalCount: contacts.length }).where(eq(campaignsTable.id, id));

  const key = campaignKey(userId, id);
  const info: CampaignInfo = { running: true, index: 0, lastProgressAt: Date.now(), consecutiveWaFailures: 0, startedAt: Date.now(), recentOutcomes: [] };
  activeCampaigns.set(key, info);

  runCampaign(userId, campaign, finalContacts, info, key).catch((err) => logger.error({ err, campaignId: id }, "Campaign error"));

  res.json({
    success: true,
    message: "Campaign started",
    remaining: finalContacts.length,
    skipped72h,
    skippedUnsub,
  });
});

// Pause campaign
router.post("/:id/pause", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const key = campaignKey(userId, id);
  const info = activeCampaigns.get(key);
  if (info) info.running = false;
  await db.update(campaignsTable).set({ status: "paused" }).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  res.json({ success: true, message: "Campaign paused" });
});

// ── Restart a completed/failed/paused campaign ────────────────────
// Clears all previous message logs, resets counters, and re-runs from scratch.
// This allows re-sending a campaign to the same list after it finishes.
router.post("/:id/restart", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return res.status(404).json({ error: "الحملة غير موجودة" });

  // Stop any active loop first
  const key = campaignKey(userId, id);
  const info = activeCampaigns.get(key);
  if (info) { info.running = false; activeCampaigns.delete(key); }

  // Clear previous send history and reset counters
  await db.delete(messageLogs).where(eq(messageLogs.campaignId, id));
  await db.update(campaignsTable)
    .set({ status: "running", sentCount: 0, failedCount: 0, deliveredCount: 0, readCount: 0 })
    .where(eq(campaignsTable.id, id));

  // Trigger campaign engine
  resumeRunningCampaigns(userId).catch(() => {});

  res.json({ success: true, message: "تم إعادة تشغيل الحملة من البداية" });
});

// ── Send to remaining (unsent) contacts ───────────────────────────
// Re-runs the campaign but ONLY for contacts that don't have a "sent"
// record in message_logs for this campaign.  Bypasses the 72-hour
// cross-campaign dedup so contacts skipped by other campaigns are reached.
router.post("/:id/send-remaining", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);

  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return res.status(404).json({ error: "الحملة غير موجودة" });

  // Only available for completed/paused/failed campaigns
  if (campaign.status === "running") {
    return res.status(409).json({ error: "الحملة تعمل بالفعل" });
  }

  // Stop any stale active loop
  const key = campaignKey(userId, id);
  const existing = activeCampaigns.get(key);
  if (existing) { existing.running = false; activeCampaigns.delete(key); }

  // Load all contacts from the group
  if (!campaign.contactGroupId) return res.status(400).json({ error: "لا توجد قائمة أرقام مرتبطة" });
  const allContacts = await db
    .select({ phone: contactsTable.phone, name: contactsTable.name })
    .from(contactsTable)
    .where(and(eq(contactsTable.groupId, campaign.contactGroupId), eq(contactsTable.status, "active")));

  if (!allContacts.length) return res.status(400).json({ error: "قائمة الأرقام فارغة" });

  // Find phones already successfully sent to in THIS campaign
  const sentRows = await db
    .select({ phone: messageLogs.phone })
    .from(messageLogs)
    .where(and(eq(messageLogs.campaignId, id), eq(messageLogs.status, "sent")));
  const alreadySentSet = new Set(sentRows.map((r) => r.phone));

  // Remove unsubscribed contacts
  const unsubRows = await db
    .select({ phone: unsubscribedPhonesTable.phone })
    .from(unsubscribedPhonesTable)
    .where(eq(unsubscribedPhonesTable.userId, userId));
  const unsubSet = new Set(unsubRows.map((r) => r.phone));

  // Remaining = not sent + not unsubscribed
  const remaining = allContacts.filter((c) => !alreadySentSet.has(c.phone) && !unsubSet.has(c.phone));

  if (!remaining.length) {
    return res.status(400).json({ error: "لا توجد أرقام متبقية — جميع جهات الاتصال تلقّت الرسالة بالفعل" });
  }

  // Check WA connection
  const waState = getStatus(userId);
  if (!waState.connected) {
    return res.status(503).json({ error: "واتساب غير متصل — أعد تشغيل الاتصال أولاً" });
  }

  // Mark campaign running, keep existing sentCount/failedCount (don't reset)
  await db.update(campaignsTable)
    .set({ status: "running", totalCount: allContacts.length })
    .where(eq(campaignsTable.id, id));

  const info: CampaignInfo = {
    running: true,
    index: 0,
    lastProgressAt: Date.now(),
    consecutiveWaFailures: 0,
    startedAt: Date.now(),
    recentOutcomes: [],
    skipDailyDedup: true,
  };
  activeCampaigns.set(key, info);

  logger.info({ campaignId: id, userId, remainingCount: remaining.length }, "send-remaining: starting for unsent contacts");
  runCampaign(userId, campaign, remaining, info, key).catch((err) =>
    logger.error({ err, campaignId: id }, "send-remaining campaign error"),
  );

  res.json({ success: true, remainingCount: remaining.length, message: `جاري الإرسال لـ ${remaining.length} رقم متبقٍّ` });
});

// Campaign stats — always computes real counts from message_logs to prevent counter drift
router.get("/:id/stats", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const [campaign] = await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return res.status(404).json({ error: "Not found" });

  // Compute REAL counts from message_logs (source of truth).
  // The sentCount/failedCount columns on the campaign row can drift if the server
  // restarts mid-campaign or DB writes fail transiently.  Using the actual log
  // records eliminates all counter-drift issues permanently.
  const [realCounts] = await db
    .select({
      realSentCount:      sql<number>`count(*) filter (where ${messageLogs.status} = 'sent')`,
      realFailedCount:    sql<number>`count(*) filter (where ${messageLogs.status} = 'failed')`,
      realDeliveredCount: sql<number>`count(${messageLogs.deliveredAt})`,
      realReadCount:      sql<number>`count(${messageLogs.readAt})`,
    })
    .from(messageLogs)
    .where(eq(messageLogs.campaignId, id));

  const actualSent   = Number(realCounts?.realSentCount   ?? campaign.sentCount);
  const actualFailed = Number(realCounts?.realFailedCount ?? campaign.failedCount);

  // Auto-heal: silently fix any drift so the DB stays consistent
  if (actualSent !== campaign.sentCount || actualFailed !== campaign.failedCount) {
    try {
      await db.update(campaignsTable)
        .set({ sentCount: actualSent, failedCount: actualFailed })
        .where(eq(campaignsTable.id, id));
      logger.info(
        { campaignId: id, sentFix: actualSent - campaign.sentCount, failedFix: actualFailed - campaign.failedCount },
        "Counter drift auto-fixed in stats endpoint",
      );
    } catch { /* non-critical — proceed with real counts */ }
  }

  // Counted from the logs for the same reason sent/failed are: the columns on
  // the campaign row drift whenever a receipt lands during a restart.
  const actualDelivered = Number(realCounts?.realDeliveredCount ?? campaign.deliveredCount);
  const actualRead      = Number(realCounts?.realReadCount      ?? campaign.readCount);

  const recentLogs = await db.select().from(messageLogs).where(eq(messageLogs.campaignId, id)).orderBy(desc(messageLogs.createdAt)).limit(50);
  const successRate  = campaign.totalCount > 0 ? Math.round((actualSent      / campaign.totalCount) * 100) : 0;
  const deliveryRate = actualSent > 0          ? Math.round((actualDelivered / actualSent)  * 100) : 0;
  const readRate     = actualSent > 0          ? Math.round((actualRead      / actualSent)  * 100) : 0;

  res.json({
    id: campaign.id, name: campaign.name, status: campaign.status,
    sentCount: actualSent, failedCount: actualFailed, totalCount: campaign.totalCount,
    deliveredCount: actualDelivered, readCount: actualRead,
    successRate, deliveryRate, readRate,
    recentLogs: recentLogs.map((l) => ({
      id: l.id, phone: l.phone, status: l.status, error: l.error, sentAt: l.sentAt,
      deliveredAt: l.deliveredAt, readAt: l.readAt,
    })),
  });
});

// ── Campaign report ───────────────────────────────────────────────
// The funnel a campaign is actually judged on: how many were attempted, how
// many WhatsApp accepted, how many reached a device, how many were opened.
// Every figure is derived from message_logs rather than the counter columns,
// which drift when a receipt lands during a restart.

/** Collapse an error string to the code it starts with, for grouping. */
function failureReason(err: string | null): string {
  if (!err) return "غير محدد";
  const code = /^([A-Z_]{4,})/.exec(err.trim())?.[1];
  const LABELS: Record<string, string> = {
    NOT_ON_WHATSAPP:  "الرقم غير مسجل على واتساب",
    MEDIA_NOT_FOUND:  "ملف الوسائط مفقود",
    MEDIA_CONFIG_ERR: "إعدادات التخزين غير صحيحة",
    SEND_TIMEOUT:     "انتهت مهلة الإرسال",
    WA_DISCONNECTED:  "انقطع اتصال واتساب",
  };
  if (code && LABELS[code]) return LABELS[code];
  if (code) return code;
  return err.slice(0, 60);
}

async function buildReport(userId: number, id: number) {
  const [campaign] = await db
    .select()
    .from(campaignsTable)
    .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return null;

  const logs = await db
    .select()
    .from(messageLogs)
    .where(eq(messageLogs.campaignId, id))
    .orderBy(messageLogs.createdAt);

  const sent      = logs.filter((l) => l.status === "sent");
  const failed    = logs.filter((l) => l.status === "failed");
  const delivered = sent.filter((l) => l.deliveredAt);
  const read      = sent.filter((l) => l.readAt);

  const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

  // Timing, from the first to the last accepted send.
  const stamps = sent.map((l) => new Date(l.sentAt ?? l.createdAt).getTime()).sort((a, b) => a - b);
  const firstAt = stamps[0] ?? null;
  const lastAt  = stamps[stamps.length - 1] ?? null;
  const spanMs  = firstAt && lastAt ? lastAt - firstAt : 0;

  const byReason = new Map<string, number>();
  for (const f of failed) {
    const r = failureReason(f.error);
    byReason.set(r, (byReason.get(r) ?? 0) + 1);
  }

  return {
    campaign,
    logs,
    report: {
      campaign: {
        id: campaign.id, name: campaign.name, status: campaign.status,
        messageType: campaign.messageType, createdAt: campaign.createdAt,
        pacingMode: campaign.pacingMode,
      },
      funnel: {
        total:     campaign.totalCount,
        attempted: logs.length,
        sent:      sent.length,
        failed:    failed.length,
        delivered: delivered.length,
        read:      read.length,
        // Accepted by WhatsApp but no delivery receipt yet: either still in
        // flight, or the recipient's device has not come online.
        awaitingDelivery: sent.length - delivered.length,
      },
      rates: {
        successRate:      pct(sent.length, logs.length),
        failureRate:      pct(failed.length, logs.length),
        deliveryRate:     pct(delivered.length, sent.length),
        readRate:         pct(read.length, sent.length),
        // Of the messages that actually arrived, how many were opened. This is
        // the engagement number; readRate above is diluted by undelivered mail.
        readOfDelivered:  pct(read.length, delivered.length),
      },
      timing: {
        firstSentAt: firstAt ? new Date(firstAt).toISOString() : null,
        lastSentAt:  lastAt  ? new Date(lastAt).toISOString()  : null,
        durationMinutes: spanMs ? Math.round(spanMs / 60_000) : 0,
        avgGapSeconds:   sent.length > 1 ? Math.round(spanMs / (sent.length - 1) / 1000) : 0,
        messagesPerHour: spanMs > 0 ? Math.round((sent.length / spanMs) * 3_600_000) : 0,
      },
      failures: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    },
  };
}

router.get("/:id/report", async (req, res) => {
  const built = await buildReport(req.session.userId!, parseInt(req.params.id!));
  if (!built) return res.status(404).json({ error: "الحملة غير موجودة" });
  res.json(built.report);
});

// ── Campaign report as Excel ──────────────────────────────────────
router.get("/:id/report/export", async (req, res) => {
  const built = await buildReport(req.session.userId!, parseInt(req.params.id!));
  if (!built) return res.status(404).json({ error: "الحملة غير موجودة" });

  const { campaign, logs, report } = built;
  const fmt = (d: Date | string | null) =>
    d ? new Date(d).toLocaleString("ar-AE", { timeZone: "Asia/Dubai" }) : "";

  const summary = [
    { البند: "اسم الحملة",             القيمة: campaign.name },
    { البند: "الحالة",                  القيمة: campaign.status },
    { البند: "إجمالي الأرقام",          القيمة: report.funnel.total },
    { البند: "جرت محاولة إرسالها",      القيمة: report.funnel.attempted },
    { البند: "أُرسلت بنجاح",            القيمة: report.funnel.sent },
    { البند: "فشلت",                    القيمة: report.funnel.failed },
    { البند: "وصلت للجهاز",             القيمة: report.funnel.delivered },
    { البند: "قُرئت",                   القيمة: report.funnel.read },
    { البند: "بانتظار التسليم",          القيمة: report.funnel.awaitingDelivery },
    { البند: "نسبة التسليم %",          القيمة: report.rates.deliveryRate },
    { البند: "نسبة القراءة %",          القيمة: report.rates.readRate },
    { البند: "نسبة القراءة ممن وصلتهم %", القيمة: report.rates.readOfDelivered },
    { البند: "نسبة الفشل %",            القيمة: report.rates.failureRate },
    { البند: "أول إرسال",               القيمة: fmt(report.timing.firstSentAt) },
    { البند: "آخر إرسال",               القيمة: fmt(report.timing.lastSentAt) },
    { البند: "المدة (دقيقة)",           القيمة: report.timing.durationMinutes },
    { البند: "متوسط الفاصل (ثانية)",    القيمة: report.timing.avgGapSeconds },
    { البند: "رسالة/ساعة",              القيمة: report.timing.messagesPerHour },
    ...report.failures.map((f) => ({ البند: `سبب فشل: ${f.reason}`, القيمة: f.count })),
  ];

  const detail = logs.map((l, i) => ({
    "#": i + 1,
    الهاتف: l.phone,
    الحالة: l.status === "sent" ? "أُرسلت" : l.status === "failed" ? "فشلت" : l.status,
    "وصلت؟": l.deliveredAt ? "نعم" : "لا",
    "قُرئت؟": l.readAt ? "نعم" : "لا",
    "وقت الإرسال": fmt(l.sentAt),
    "وقت الوصول": fmt(l.deliveredAt),
    "وقت القراءة": fmt(l.readAt),
    السبب: l.error ? failureReason(l.error) : "",
  }));

  const wb = XLSX.utils.book_new();
  const wsS = XLSX.utils.json_to_sheet(summary);
  wsS["!cols"] = [{ wch: 30 }, { wch: 26 }];
  XLSX.utils.book_append_sheet(wb, wsS, "الملخص");

  const wsD = XLSX.utils.json_to_sheet(detail.length ? detail : [{ ملاحظة: "لا توجد رسائل بعد" }]);
  wsD["!cols"] = [{ wch: 6 }, { wch: 18 }, { wch: 10 }, { wch: 9 }, { wch: 9 }, { wch: 20 }, { wch: 20 }, { wch: 20 }, { wch: 28 }];
  XLSX.utils.book_append_sheet(wb, wsD, "التفاصيل");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const filename = encodeURIComponent(`تقرير - ${campaign.name}`) + ".xlsx";
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${filename}`);
  res.setHeader("Content-Length", buf.length);
  res.end(buf);
});

// ── Campaign Quality Center ───────────────────────────────────────
// Computes quality metrics from message_logs and returns risk level + recommendation.
// Called directly from frontend via fetch — no codegen needed.
router.get("/:id/quality", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id);
  const [campaign] = await db.select().from(campaignsTable).where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)));
  if (!campaign) return res.status(404).json({ error: "Not found" });

  // Last 50 message logs for recent trend
  const recentLogs = await db
    .select({ status: messageLogs.status })
    .from(messageLogs)
    .where(eq(messageLogs.campaignId, id))
    .orderBy(desc(messageLogs.createdAt))
    .limit(50);

  const totalAttempted = campaign.sentCount + campaign.failedCount;
  const overallFailureRate = totalAttempted > 0 ? campaign.failedCount / totalAttempted : 0;

  // Recent failure rate (last 20 actual outcomes)
  const recent20 = recentLogs.slice(0, 20);
  const recentFailed = recent20.filter((l) => l.status === "failed").length;
  const recentFailureRate = recent20.length > 0 ? recentFailed / recent20.length : 0;

  // Use the worse of the two rates for risk assessment
  const effectiveFailureRate = Math.max(overallFailureRate, recentFailureRate);

  // Delivery health — sends that succeeded but never arrived. Invisible to the
  // failure rates above, and the earlier signal of the two.
  const delivery = await assessDeliveryHealth(id).catch(() => null);

  // Risk level
  let riskLevel: "low" | "medium" | "high" | "critical";
  let riskScore: number;
  let recommendation: string;
  let recommendationEn: "continue" | "slow_down" | "pause" | "review";
  let recommendationColor: "green" | "yellow" | "orange" | "red";

  if (effectiveFailureRate < 0.10) {
    riskLevel = "low";        riskScore = Math.round(effectiveFailureRate * 100);
    recommendation = "استمر — الحملة تعمل بشكل ممتاز";
    recommendationEn = "continue"; recommendationColor = "green";
  } else if (effectiveFailureRate < 0.25) {
    riskLevel = "medium";     riskScore = Math.round(effectiveFailureRate * 100);
    recommendation = "خفف الإرسال — معدل الفشل في ارتفاع";
    recommendationEn = "slow_down"; recommendationColor = "yellow";
  } else if (effectiveFailureRate < 0.40) {
    riskLevel = "high";       riskScore = Math.round(effectiveFailureRate * 100);
    recommendation = "أوقف مؤقتاً — راجع القائمة وتحقق من الاتصال";
    recommendationEn = "pause"; recommendationColor = "orange";
  } else {
    riskLevel = "critical";   riskScore = Math.round(effectiveFailureRate * 100);
    recommendation = "أوقف الحملة — معدل الفشل عالٍ جداً، راجع الأرقام والجلسة";
    recommendationEn = "review"; recommendationColor = "red";
  }

  // A collapsing delivery rate outranks a clean failure rate: the campaign can
  // look perfect by send-time errors while nothing is reaching anyone.
  if (delivery && delivery.level !== "insufficient_data" && delivery.reason) {
    if (delivery.level === "critical" && riskLevel !== "critical") {
      riskLevel = "critical"; recommendationEn = "review"; recommendationColor = "red";
      recommendation = delivery.reason;
    } else if (delivery.level === "high_risk" && (riskLevel === "low" || riskLevel === "medium")) {
      riskLevel = "high"; recommendationEn = "pause"; recommendationColor = "orange";
      recommendation = delivery.reason;
    } else if (delivery.level === "degraded" && riskLevel === "low") {
      riskLevel = "medium"; recommendationEn = "slow_down"; recommendationColor = "yellow";
      recommendation = delivery.reason;
    }
  }

  // In-memory real-time recentOutcomes (if campaign is actively running)
  const key = campaignKey(userId, id);
  const activeInfo = activeCampaigns.get(key);
  const liveWindow = activeInfo?.recentOutcomes ?? [];
  const liveFailRate = liveWindow.length > 0
    ? liveWindow.filter((o) => o === "failed").length / liveWindow.length
    : null;

  res.json({
    campaignId: id,
    campaignStatus: campaign.status,
    autoPauseReason: (campaign as any).autoPauseReason ?? null,
    // Overall stats
    sentCount: campaign.sentCount,
    failedCount: campaign.failedCount,
    totalCount: campaign.totalCount,
    overallFailureRate: Math.round(overallFailureRate * 100),
    recentFailureRate: Math.round(recentFailureRate * 100),
    // Live window (if running)
    liveWindowSize: liveWindow.length,
    liveFailureRate: liveFailRate !== null ? Math.round(liveFailRate * 100) : null,
    // Delivery health — null until enough messages are old enough to judge
    delivery: delivery && delivery.level !== "insufficient_data" ? {
      level:        delivery.level,
      sample:       delivery.sample,
      delivered:    delivery.delivered,
      deliveryRate: Math.round(delivery.deliveryRate * 100),
    } : null,
    deliveryPending: delivery ? delivery.level === "insufficient_data" : true,
    deliveryMinSample: DELIVERY_MIN_SAMPLE,
    // Assessment
    riskLevel,
    riskScore,
    recommendation,
    recommendationEn,
    recommendationColor,
  });
});

// ── Campaign execution ────────────────────────────────────────────

const LONG_BREAK_EVERY = 40;

async function runCampaign(userId: number, campaign: any, contacts: any[], info: CampaignInfo, key: string) {
  let sentThisRun = 0; // counts messages sent in THIS run (respects messageLimit)
  // A young number writing mostly to strangers is what a spammer looks like
  // from the outside. For its first two weeks, once more than 60% of the
  // day's sends have gone to people with no prior thread, the campaign
  // waits for tomorrow. Known contacts are already ordered first, so this
  // stops the tail, not the head.
  const youngNumber = (await numberAgeDays(userId).catch(() => 30)) < 14;
  const STRANGER_CAP = Number(process.env["STRANGER_SHARE_CAP"] ?? 0.6);
  // Per-contact WA failure counter — prevents infinite loop when a single contact
  // keeps triggering WA_DISCONNECTED. After 3 consecutive WA failures on the same
  // phone, we mark it failed and move on rather than retrying forever.
  const contactWaFailures = new Map<string, number>();

  for (let i = info.index; i < contacts.length; i++) {
    if (!info.running) break;
    info.index = i;

    const contact = contacts[i];

    // ── Per-run message limit ─────────────────────────────────────
    // Optional cap set by the user on the campaign form.
    // When reached: pause (not complete) so the user can resume later.
    if (campaign.messageLimit && sentThisRun >= campaign.messageLimit) {
      logger.info({ campaignId: campaign.id, sentThisRun, limit: campaign.messageLimit }, "Message limit reached — pausing campaign");
      info.running = false;
      activeCampaigns.delete(key);
      await db.update(campaignsTable).set({ status: "paused" }).where(eq(campaignsTable.id, campaign.id));
      break;
    }

    // ── Stranger cap for a young number ───────────────────────────
    if (youngNumber && sentThisRun > 0 && sentThisRun % 10 === 0) {
      const s = await strangerShare24h(userId).catch(() => null);
      if (s && s.sent >= 30 && s.share !== null && s.share > STRANGER_CAP) {
        const reason = `الرقم عمره أقل من أسبوعين و${Math.round(s.share * 100)}% من رسائل اليوم ذهبت إلى أرقام لا محادثة سابقة معها — أوقفنا الحملة حتى الغد لحماية الرقم.`;
        logger.warn({ campaignId: campaign.id, share: s.share }, "young number: stranger share cap reached — pausing");
        info.running = false;
        activeCampaigns.delete(key);
        await withDbRetry(() => db.update(campaignsTable).set({ status: "paused", autoPauseReason: reason })
          .where(eq(campaignsTable.id, campaign.id))).catch(() => {});
        break;
      }
    }

    // ── Mid-campaign daily rate limit check ───────────────────────
    // BUGFIX: previously had no try/catch — a transient DB error would crash
    // the entire campaign loop silently.  Now wrapped in withDbRetry.
    let dailySent: number;
    let effectiveLimit: number;
    // The operations officer's standing decisions. Read every iteration rather
    // than once at the start: a hold placed mid-campaign has to take effect on
    // the next message, not after the current run finishes.
    let ops: Awaited<ReturnType<typeof getControls>> | null = null;
    try {
      [dailySent, effectiveLimit, ops] = await Promise.all([
        withDbRetry(() => getDailySentCount(userId)),
        getEffectiveDailyLimit(userId),
        getControls(userId).catch(() => null),
      ]);
      // Its ceiling can only lower the warm-up limit, never raise it.
      if (ops?.dailyCeiling) effectiveLimit = Math.min(effectiveLimit, ops.dailyCeiling);
    } catch (dbErr) {
      logger.warn({ campaignId: campaign.id, err: dbErr }, "DB error checking daily limit — skipping this contact, will retry next");
      continue;
    }

    // A hold is the strongest thing the officer can do, so it pauses rather
    // than sleeps: a campaign that sits in memory for two hours loses to any
    // restart, and the owner cannot tell a held campaign from a stuck one.
    if (ops?.holdUntil && new Date(ops.holdUntil).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(ops.holdUntil).getTime() - Date.now()) / 60_000);
      logger.warn({ campaignId: campaign.id, minutes: mins, reason: ops.reason }, "مسؤول التشغيل أوقف الإرسال");
      info.running = false;
      activeCampaigns.delete(key);
      await withDbRetry(() => db.update(campaignsTable).set({ status: "paused" })
        .where(eq(campaignsTable.id, campaign.id))).catch(() => {});
      break;
    }
    if (dailySent >= effectiveLimit) {
      logger.info({ campaignId: campaign.id, dailySent, limit: effectiveLimit }, "Daily warm-up limit reached — pausing campaign");
      info.running = false;
      activeCampaigns.delete(key);
      try {
        await withDbRetry(() =>
          db.update(campaignsTable).set({ status: "paused" }).where(eq(campaignsTable.id, campaign.id))
        );
      } catch { /* ignore — watchdog will pick it up */ }
      break;
    }

    // Mid-campaign unsubscribe check — BUGFIX: no retry before
    let isUnsub = false;
    try {
      const [unsubRow] = await withDbRetry(() =>
        db.select({ phone: unsubscribedPhonesTable.phone })
          .from(unsubscribedPhonesTable)
          .where(and(eq(unsubscribedPhonesTable.userId, userId), eq(unsubscribedPhonesTable.phone, contact.phone)))
          .limit(1)
      );
      isUnsub = !!unsubRow;
    } catch {
      // DB error — assume NOT unsubscribed and continue (safer than silently skipping)
    }
    if (isUnsub) {
      logger.info({ phone: contact.phone, campaignId: campaign.id }, "Skipping unsubscribed contact");
      continue;
    }

    // ── Daily dedup: skip if already sent to this phone today ────────
    // Bypassed when skipDailyDedup=true (send-remaining explicitly targets unsent contacts).
    if (!info.skipDailyDedup) {
      let alreadySentToday = false;
      try {
        alreadySentToday = await withDbRetry(() => wasSentTodayToPhone(userId, contact.phone));
      } catch {
        // DB error — assume NOT sent (safer: skip re-send risk, continue)
      }
      if (alreadySentToday) {
        logger.info({ phone: contact.phone, campaignId: campaign.id }, "Skipping — already sent today");
        continue;
      }
    }

    const personalized = personalizeMessage(campaign.message, { name: contact.name, phone: contact.phone }, campaign.companyName);
    const personalizedMessage = personalized;

    // ── Sending-hours gate ───────────────────────────────────────
    await waitForSendingHours(campaign.id, info);
    if (!info.running) break;

    logger.info(
      {
        campaignId: campaign.id,
        userId,
        phone: contact.phone,
        index: i,
        total: contacts.length,
        messageType: campaign.messageType,
        hasMedia: !!campaign.mediaUrl,
      },
      "📨 campaign:attempt",
    );

    try {
      const waMessageId = await sendWithReconnect(userId, contact.phone, personalizedMessage, campaign.messageType, campaign.mediaUrl, campaign.buttons ?? null, campaign.carousel ?? null);
      // Wrap DB writes in retry — a transient DB blip must not lose the "sent" record
      await withDbRetry(() =>
        db.insert(messageLogs).values({ campaignId: campaign.id, phone: contact.phone, status: "sent", sentAt: new Date(), messageId: waMessageId ?? null })
      );
      await withDbRetry(() =>
        db.update(campaignsTable).set({ sentCount: sql`${campaignsTable.sentCount} + 1` }).where(eq(campaignsTable.id, campaign.id))
      );
      sentThisRun++;
      // Reset consecutive-failure counter on every successful send
      info.consecutiveWaFailures = 0;
      info.lastProgressAt        = Date.now();
      // ── Quality tracking: record success ──────────────────────────
      info.recentOutcomes.push("sent");
      if (info.recentOutcomes.length > QUALITY_WINDOW) info.recentOutcomes.shift();

      // ── Delivery guard ────────────────────────────────────────────
      // Reads back the receipts recorded in message_logs.deliveredAt. Early in
      // a campaign nothing is mature enough to judge, so this reports
      // insufficient_data and changes nothing until there is real evidence.
      if (sentThisRun > 0 && sentThisRun % DELIVERY_CHECK_EVERY === 0) {
        try {
          const health = await assessDeliveryHealth(campaign.id);

          if (health.level !== "insufficient_data") {
            logger.info(
              { campaignId: campaign.id, level: health.level, deliveredPct: Math.round(health.deliveryRate * 100), sample: health.sample },
              "Delivery guard check",
            );
          }

          if (health.shouldPause) {
            logger.warn({ campaignId: campaign.id, reason: health.reason }, "Delivery guard: auto-pausing campaign");
            info.running = false;
            activeCampaigns.delete(key);
            try {
              await withDbRetry(() =>
                db.update(campaignsTable)
                  .set({ status: "auto_paused", autoPauseReason: health.reason })
                  .where(eq(campaignsTable.id, campaign.id))
              );
            } catch { /* watchdog will pick it up */ }
            return; // exit runCampaign
          }

          // Degraded but recoverable — widen the gaps rather than stop.
          if (health.shouldSlow && !info.deliverySlowMode) {
            info.deliverySlowMode = true;
            logger.warn(
              { campaignId: campaign.id, deliveredPct: Math.round(health.deliveryRate * 100) },
              "Delivery guard: entering slow mode",
            );
          } else if (!health.shouldSlow && info.deliverySlowMode) {
            info.deliverySlowMode = false;
            logger.info({ campaignId: campaign.id }, "Delivery guard: delivery recovered — normal pace");
          }
        } catch (err) {
          // Never let a monitoring query kill a running campaign.
          logger.warn({ campaignId: campaign.id, err }, "Delivery guard check failed — continuing");
        }
      }

      // ── Canary hold ───────────────────────────────────────────────
      // Bounded: the wait happens once, and only on a list big enough for the
      // blind window to matter.
      if (
        !info.canaryCleared &&
        contacts.length >= CANARY_MIN_LIST &&
        sentThisRun >= CANARY_SIZE
      ) {
        logger.info(
          { campaignId: campaign.id, canarySize: sentThisRun, waitMinutes: MATURITY_MINUTES },
          "canary batch sent — holding for delivery receipts before releasing the rest",
        );

        // Interruptible, so pausing during the hold takes effect immediately.
        const until = Date.now() + (MATURITY_MINUTES + 1) * 60_000;
        while (info.running && Date.now() < until) {
          await interruptibleSleep(30_000, info);
          info.lastProgressAt = Date.now(); // waiting deliberately, not stalled
        }
        if (!info.running) break;

        const canary = await assessDeliveryHealth(campaign.id).catch(() => null);
        if (canary && canary.shouldPause) {
          const reason = `فحص الدفعة التجريبية: ${canary.reason ?? "تسليم ضعيف"}`;
          logger.warn({ campaignId: campaign.id, reason }, "canary failed — campaign stopped before the bulk was sent");
          info.running = false;
          activeCampaigns.delete(key);
          try {
            await withDbRetry(() =>
              db.update(campaignsTable)
                .set({ status: "auto_paused", autoPauseReason: reason })
                .where(eq(campaignsTable.id, campaign.id))
            );
          } catch { /* watchdog will pick it up */ }
          return;
        }
        if (canary?.shouldSlow) info.deliverySlowMode = true;
        info.canaryCleared = true;
        logger.info(
          { campaignId: campaign.id, level: canary?.level ?? "insufficient_data", slowMode: !!info.deliverySlowMode },
          "canary cleared — releasing the rest of the list",
        );
      }

      // ── Account-wide guard ────────────────────────────────────────
      // A campaign can look survivable while the number behind it is not.
      if (sentThisRun > 0 && sentThisRun % ACCOUNT_CHECK_EVERY === 0) {
        try {
          const acct = await assessAccountHealth(userId);
          if (acct.shouldHalt) {
            logger.error({ userId, campaignId: campaign.id, reason: acct.reason }, "account health critical — halting every running campaign for this number");
            // Stop everything this number is sending, not just this campaign.
            // CampaignInfo carries no userId; the map key is `${userId}:${id}`.
            const prefix = `${userId}:`;
            for (const [k, other] of activeCampaigns) {
              if (k.startsWith(prefix)) {
                other.running = false;
                activeCampaigns.delete(k);
              }
            }
            const ids = [...new Set([campaign.id])];
            try {
              await withDbRetry(() =>
                db.update(campaignsTable)
                  .set({ status: "auto_paused", autoPauseReason: acct.reason })
                  .where(and(eq(campaignsTable.userId, userId), eq(campaignsTable.status, "running")))
              );
              await withDbRetry(() =>
                db.update(campaignsTable)
                  .set({ status: "auto_paused", autoPauseReason: acct.reason })
                  .where(inArray(campaignsTable.id, ids))
              );
            } catch { /* watchdog will pick it up */ }
            return;
          }
          if (acct.level === "degraded" && !info.deliverySlowMode) {
            info.deliverySlowMode = true;
            logger.warn({ userId, deliveredPct: Math.round(acct.deliveryRate * 100) }, "account delivery degraded — slowing every campaign");
          }
        } catch (err) {
          logger.warn({ userId, err }, "account health check failed — continuing");
        }
      }
      logger.info(
        {
          campaignId: campaign.id,
          userId,
          phone: contact.phone,
          waMessageId: waMessageId ?? null,
          hasMsgId: !!waMessageId,
          sentThisRun,
          index: i,
        },
        waMessageId
          ? "✅ campaign:sent — WA msgId confirmed"
          : "⚠️ campaign:sent — WA msgId missing (possible ghost-send)",
      );
    } catch (err: any) {
      const errMsg = String(err?.message ?? err ?? "");

      // ── WA disconnected after all retry attempts ──────────────────
      // INLINE recovery: wait for WA to reconnect here, then retry.
      // This avoids the infinite-loop bug where "exit + resume externally"
      // always picks the same un-logged contact forever.
      if (errMsg === WA_DISCONNECTED) {
        info.consecutiveWaFailures++;
        const failures = info.consecutiveWaFailures;

        // Per-contact failure guard — after 3 WA_DISCONNECTED on the SAME
        // contact, give up on it (mark failed) and move to the next one.
        const prev = contactWaFailures.get(contact.phone) ?? 0;
        contactWaFailures.set(contact.phone, prev + 1);
        if (prev + 1 >= 3) {
          logger.warn({ phone: contact.phone, campaignId: campaign.id }, "رقم يسبب انقطاع متكرر — تخطي وتسجيل فشل");
          contactWaFailures.delete(contact.phone);
          info.consecutiveWaFailures = 0;
          try {
            await withDbRetry(() =>
              db.insert(messageLogs).values({ campaignId: campaign.id, phone: contact.phone, status: "failed", error: "WA_DISCONNECTED_REPEATED" })
            );
            await withDbRetry(() =>
              db.update(campaignsTable).set({ failedCount: sql`${campaignsTable.failedCount} + 1` }).where(eq(campaignsTable.id, campaign.id))
            );
          } catch { /* ignore DB error — move on */ }
          continue; // next contact
        }

        if (failures >= 3) {
          // NOTE: do NOT call initWhatsApp here — it calls forceFullRebuild which
          // destroys the WA session and requires QR rescan. The soft-reconnect in
          // the health monitor handles persistent failures safely.
          logger.warn({ campaignId: campaign.id, userId, failures }, "WA disconnected 3+ times — waiting for soft reconnect");
        }

        const maxWaitMs = Math.min(90_000 * Math.max(1, failures - 1), 5 * 60_000);
        logger.warn(
          { phone: contact.phone, campaignId: campaign.id, failures, maxWaitSec: Math.round(maxWaitMs / 1000) },
          "WA انقطع — انتظار إعادة الاتصال (inline)",
        );

        const connected = await waitForConnection(userId, maxWaitMs);
        if (!connected || !info.running) {
          // WA didn't come back or campaign was paused — stop loop cleanly.
          // Campaign status stays "running" in DB; watchdog/connect-hook will resume.
          logger.warn({ campaignId: campaign.id }, "WA لم يعد في الوقت المحدد — إيقاف الحلقة مؤقتاً");
          break;
        }

        // WA is back — retry the same contact
        i--;
        continue;
      }

      // Any other error (media missing, etc.) → skip this contact
      logger.error({ phone: contact.phone, campaignId: campaign.id, err: errMsg }, "Message failed — skipping contact");

      // ── Quality tracking: record failure ──────────────────────────
      // NOT_ON_WHATSAPP is a data quality issue, not a delivery failure — exclude from quality score
      if (!MEDIA_ERR.test(errMsg)) {
        info.recentOutcomes.push("failed");
        if (info.recentOutcomes.length > QUALITY_WINDOW) info.recentOutcomes.shift();

        // ── Auto-pause on high failure rate ──────────────────────────
        // Only trigger after filling the window (at least QUALITY_WINDOW sends)
        // to avoid false positives from a bad first few contacts.
        if (
          info.recentOutcomes.length >= QUALITY_WINDOW &&
          info.recentOutcomes.filter((o) => o === "failed").length / info.recentOutcomes.length >= FAILURE_THRESHOLD
        ) {
          const reason = `معدل الفشل ارتفع فوق ${Math.round(FAILURE_THRESHOLD * 100)}% في آخر ${QUALITY_WINDOW} رسالة — إيقاف تلقائي لحماية الحساب`;
          logger.warn({ campaignId: campaign.id, reason }, "Quality Guardian: auto-pausing campaign due to high failure rate");
          info.running = false;
          activeCampaigns.delete(key);
          try {
            await withDbRetry(() =>
              db.update(campaignsTable)
                .set({ status: "auto_paused", autoPauseReason: reason })
                .where(eq(campaignsTable.id, campaign.id))
            );
          } catch { /* watchdog will pick it up */ }
          return; // exit runCampaign
        }
      }

      // BUGFIX: failed log writes were not wrapped — a DB error here would crash the loop
      try {
        await withDbRetry(() =>
          db.insert(messageLogs).values({ campaignId: campaign.id, phone: contact.phone, status: "failed", error: errMsg.slice(0, 500) })
        );
        await withDbRetry(() =>
          db.update(campaignsTable).set({ failedCount: sql`${campaignsTable.failedCount} + 1` }).where(eq(campaignsTable.id, campaign.id))
        );
      } catch (dbErr) {
        logger.error({ campaignId: campaign.id, phone: contact.phone, err: dbErr }, "CRITICAL: failed to write failure log to DB");
        // Continue the loop — losing a failure log is better than killing the whole campaign
      }
    }

    // When the delivery guard has flagged degradation, every gap below is
    // stretched. Sending slower into a number that is already being throttled
    // is what gives it room to recover.
    // Two independent brakes, and the stronger wins rather than the two
    // multiplying: the delivery guard reacting to the same trouble the officer
    // already throttled for should not produce a nine-fold slowdown.
    const opsThrottle = Math.max(1, Number(ops?.throttle ?? 1) || 1);
    // ...and then the hour of the day on top, because that one is not a brake
    // but the ordinary rhythm of a person at a desk.
    const paceFactor = Math.max(info.deliverySlowMode ? DELIVERY_SLOW_FACTOR : 1, opsThrottle)
                     * diurnalFactor(hourInSendingTz());

    if (i > 0 && (i + 1) % LONG_BREAK_EVERY === 0 && info.running && i < contacts.length - 1) {
      // ── Long break every 40 msgs (2–5 min) ───────────────────────
      const breakMs = Math.round(randomDelay(120_000, 300_000) * paceFactor);
      logger.info({ campaignId: campaign.id, msgIndex: i + 1, breakSeconds: Math.round(breakMs / 1000), slowMode: !!info.deliverySlowMode }, "استراحة طويلة (حماية من الحظر)");
      await interruptibleSleep(breakMs, info);
    } else if (i > 0 && (i + 1) % MICRO_BREAK_EVERY === 0 && info.running && i < contacts.length - 1) {
      // ── Micro-break every 12 msgs (30–90 s) ──────────────────────
      const microMs = Math.round(randomDelay(30_000, 90_000) * paceFactor);
      logger.info({ campaignId: campaign.id, msgIndex: i + 1, microBreakSeconds: Math.round(microMs / 1000), slowMode: !!info.deliverySlowMode }, "استراحة قصيرة (محاكاة بشرية)");
      await interruptibleSleep(microMs, info);
    } else if (i < contacts.length - 1 && info.running) {
      // ── Gap before the next message ───────────────────────────────
      // In auto mode the gap is derived per message from what is still owed
      // and how much of the window is left, so a campaign that lost time to a
      // disconnect redistributes the remainder instead of finishing early and
      // idling, or overrunning the window. Manual mode keeps the fixed pair.
      let meanGapMs: number;

      if (campaign.pacingMode === "manual") {
        meanGapMs = humanDelay(campaign.delayMin * 1_000, campaign.delayMax * 1_000) * paceFactor;
      } else {
        const plan = computeGap({
          remainingContacts: contacts.length - i - 1,
          // dailySent was read at the top of this iteration, before this send.
          dailyRemaining:    Math.max(0, effectiveLimit - (dailySent + 1)),
          dailyLimit:        effectiveLimit,
          windowMsLeft:      msLeftInSendingWindow(),
          slowFactor:        paceFactor,
        });

        // Jitter around the computed mean so the cadence is not metronomic.
        meanGapMs = humanDelay(plan.gapMs * 0.65, plan.gapMs * 1.35);

        if ((i + 1) % 25 === 0) {
          logger.info(
            {
              campaignId: campaign.id,
              gapSec: Math.round(plan.gapMs / 1000),
              target: plan.target,
              windowMinLeft: Math.round(msLeftInSendingWindow() / 60_000),
              windowTooShort: plan.windowTooShort,
              slowMode: !!info.deliverySlowMode,
            },
            "auto-pacing",
          );
        }
      }

      await interruptibleSleep(Math.round(meanGapMs), info);
    }
  }

  if (info.running) {
    await db.update(campaignsTable).set({ status: "completed" }).where(eq(campaignsTable.id, campaign.id));
    activeCampaigns.delete(key);
    logger.info({ campaignId: campaign.id }, "Campaign completed");
  }
}

function randomDelay(min: number, max: number) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── Gaussian delay (Box-Muller transform) ────────────────────────
// Generates delays that match real human typing/reading patterns:
//   - Most delays cluster around the middle of [min, max]
//   - Occasional very short or very long pauses (natural outliers)
//   - ~5% chance of a "distracted" pause (2–4× normal) — simulates
//     the user stopping to read a reply, check another app, etc.
//   - ~1% chance of a "micro-burst" (0.4× normal) — user on a roll
//
// The Box-Muller formula converts two uniform randoms into a
// Gaussian (normal) distribution: mean=0, stddev=1, then scaled.
function gaussianRand(): number {
  // Box-Muller transform — mathematically exact Gaussian
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function humanDelay(minMs: number, maxMs: number): number {
  const mean   = (minMs + maxMs) / 2;
  const stddev = (maxMs - minMs) / 6;   // 99.7% of values within [min, max]

  // Gaussian sample, clamped to [min*0.4, max*4] to prevent extremes
  let delay = mean + gaussianRand() * stddev;
  delay = Math.max(minMs * 0.4, Math.min(maxMs * 4, delay));

  const roll = Math.random();
  if (roll < 0.01) {
    // Micro-burst: user sending quickly (rare)
    return delay * (0.3 + Math.random() * 0.2);
  }
  if (roll < 0.06) {
    // Distracted pause: user got interrupted (occasional)
    return delay * (2 + Math.random() * 2);
  }
  return delay;
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

/**
 * Sleep that checks info.running every 5 s — so a pause/stop request
 * takes effect within 5 seconds instead of waiting for a 5-minute anti-ban break.
 */
async function interruptibleSleep(ms: number, info: { running: boolean; lastProgressAt: number }) {
  const SLICE = 5_000;
  let remaining = ms;
  while (remaining > 0 && info.running) {
    await sleep(Math.min(remaining, SLICE));
    remaining -= SLICE;
    // Keep the watchdog from restarting loops that are legitimately sleeping
    // (e.g. waiting for sending hours or break cadence).
    info.lastProgressAt = Date.now();
  }
}

// ── Failure Report ────────────────────────────────────────────────────
// Categorises every failed message log for this campaign by error type.
// The frontend uses this to show the user WHY sends failed and which
// contacts can realistically be retried.
router.get("/:id/failure-report", async (req, res) => {
  const userId = req.session.userId!;
  const id     = parseInt(req.params.id);

  const [campaign] = await withDbRetry(() =>
    db.select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)))
  );
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const failures = await withDbRetry(() =>
    db.select({ phone: messageLogs.phone, error: messageLogs.error, id: messageLogs.id })
      .from(messageLogs)
      .where(and(eq(messageLogs.campaignId, id), eq(messageLogs.status, "failed")))
  );

  if (!failures.length) return res.json({ total: 0, categories: [], retryableCount: 0 });

  const counts: Record<string, { label: string; retryable: boolean; count: number }> = {};
  let retryableCount = 0;

  for (const f of failures) {
    const { key, label, retryable } = classifyFailure(f.error);
    if (!counts[key]) counts[key] = { label, retryable, count: 0 };
    counts[key].count++;
    if (retryable) retryableCount++;
  }

  const categories = Object.entries(counts).map(([key, c]) => ({
    key, label: c.label, count: c.count, retryable: c.retryable,
  }));

  res.json({ total: failures.length, categories, retryableCount });
});

// ── Button Responses (interested / not interested) ─────────────────────
router.get("/:id/responses", async (req, res) => {
  const userId = req.session.userId!;
  const id     = parseInt(req.params.id);

  const [campaign] = await withDbRetry(() =>
    db.select({ id: campaignsTable.id })
      .from(campaignsTable)
      .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)))
  );
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const rows = await withDbRetry(() =>
    db.select({
        id:          campaignButtonResponsesTable.id,
        phone:       campaignButtonResponsesTable.phone,
        buttonText:  campaignButtonResponsesTable.buttonText,
        action:      campaignButtonResponsesTable.action,
        createdAt:   campaignButtonResponsesTable.createdAt,
      })
      .from(campaignButtonResponsesTable)
      .where(eq(campaignButtonResponsesTable.campaignId, id))
      .orderBy(desc(campaignButtonResponsesTable.createdAt))
  );

  const interestedCount    = rows.filter((r) => r.action === "interested").length;
  const notInterestedCount = rows.filter((r) => r.action === "not_interested").length;

  res.json({ total: rows.length, interestedCount, notInterestedCount, responses: rows });
});

// ── Retry Failed Contacts ──────────────────────────────────────────────
// Finds all contacts with status="failed" in message_logs, removes their
// failed records, and re-runs the campaign loop only for those contacts.
// Skips contacts whose error is inherently non-retryable (NOT_ON_WHATSAPP,
// missing media files).
router.post("/:id/retry-failed", async (req, res) => {
  const userId = req.session.userId!;
  const id     = parseInt(req.params.id);

  const [campaign] = await withDbRetry(() =>
    db.select()
      .from(campaignsTable)
      .where(and(eq(campaignsTable.id, id), eq(campaignsTable.userId, userId)))
  );
  if (!campaign)                    return res.status(404).json({ error: "الحملة غير موجودة" });
  if (campaign.status === "running") return res.status(409).json({ error: "الحملة تعمل بالفعل" });

  const failedLogs = await withDbRetry(() =>
    db.select({ id: messageLogs.id, phone: messageLogs.phone, error: messageLogs.error })
      .from(messageLogs)
      .where(and(eq(messageLogs.campaignId, id), eq(messageLogs.status, "failed")))
  );
  if (!failedLogs.length) return res.status(400).json({ error: "لا توجد رسائل فاشلة لإعادة المحاولة" });

  const retryable    = failedLogs.filter((l) => !NON_RETRYABLE_PATTERN.test(l.error ?? ""));
  const nonRetryable = failedLogs.length - retryable.length;

  if (!retryable.length) {
    return res.status(400).json({
      error: `جميع الإخفاقات (${nonRetryable}) غير قابلة للإعادة — أرقام غير مسجلة في واتساب أو ملفات مفقودة`,
    });
  }

  const waState = getStatus(userId);
  if (!waState.connected) return res.status(503).json({ error: "واتساب غير متصل — أعد ربط الاتصال أولاً" });

  if (!campaign.contactGroupId) return res.status(400).json({ error: "لا توجد قائمة أرقام مرتبطة" });

  const retryablePhones  = new Set(retryable.map((l) => l.phone));
  const retryableLogIds  = retryable.map((l) => l.id);

  const allContacts = await withDbRetry(() =>
    db.select()
      .from(contactsTable)
      .where(and(eq(contactsTable.groupId, campaign.contactGroupId!), eq(contactsTable.status, "active")))
  );
  const contactsToRetry = allContacts.filter((c) => retryablePhones.has(c.phone));

  if (!contactsToRetry.length) return res.status(400).json({ error: "لم يُعثر على جهات الاتصال في القائمة" });

  const key = campaignKey(userId, id);
  const existing = activeCampaigns.get(key);
  if (existing) { existing.running = false; activeCampaigns.delete(key); }

  // Remove the failed records so the loop can re-insert them as "sent"
  await withDbRetry(() => db.delete(messageLogs).where(inArray(messageLogs.id, retryableLogIds)));

  // Adjust failedCount and mark running
  await withDbRetry(() =>
    db.update(campaignsTable)
      .set({
        status:      "running",
        failedCount: sql`GREATEST(0, ${campaignsTable.failedCount} - ${retryable.length})`,
      })
      .where(eq(campaignsTable.id, id))
  );

  const info: CampaignInfo = {
    running: true, index: 0, lastProgressAt: Date.now(),
    consecutiveWaFailures: 0, startedAt: Date.now(), recentOutcomes: [],
    skipDailyDedup: true,
  };
  activeCampaigns.set(key, info);

  logger.info({ campaignId: id, userId, retryCount: contactsToRetry.length, skippedNonRetryable: nonRetryable }, "retry-failed: started");

  runCampaign(userId, campaign, contactsToRetry, info, key).catch((err) =>
    logger.error({ err, campaignId: id }, "retry-failed campaign error"),
  );

  res.json({
    success:             true,
    retryCount:          contactsToRetry.length,
    skippedNonRetryable: nonRetryable,
    message: `جاري إعادة الإرسال لـ ${contactsToRetry.length} رقم` +
             (nonRetryable ? ` — تم تخطي ${nonRetryable} رقم غير قابل للإعادة` : ""),
  });
});

// ── Campaign Health endpoint ──────────────────────────────────────
// Returns real-time status of all active loops AND DB-running campaigns.
// Used for ops monitoring — tells you exactly what the engine is doing.
router.get("/health", async (req, res) => {
  const userId = req.session.userId!;

  // In-memory active loops for this user
  const activeLoops: object[] = [];
  for (const [key, info] of activeCampaigns.entries()) {
    const [uid, cid] = key.split(":").map(Number);
    if (uid !== userId) continue;
    const idleSecs = Math.round((Date.now() - info.lastProgressAt) / 1_000);
    const runningSecs = Math.round((Date.now() - info.startedAt) / 1_000);
    activeLoops.push({
      campaignId:            cid,
      running:               info.running,
      contactIndex:          info.index,
      consecutiveWaFailures: info.consecutiveWaFailures,
      lastProgressAt:        new Date(info.lastProgressAt).toISOString(),
      idleSecs,
      runningSecs,
      stuckWarning:          idleSecs > STUCK_THRESHOLD_MS / 1_000,
    });
  }

  // DB campaigns for this user
  let dbRunning: { id: number; name: string; sentCount: number; totalCount: number; status: string }[] = [];
  try {
    dbRunning = await db.select({
      id: campaignsTable.id, name: campaignsTable.name,
      sentCount: campaignsTable.sentCount, totalCount: campaignsTable.totalCount,
      status: campaignsTable.status,
    })
    .from(campaignsTable)
    .where(and(eq(campaignsTable.userId, userId), eq(campaignsTable.status, "running")));
  } catch { /* DB temporarily unavailable */ }

  res.json({
    timestamp:    new Date().toISOString(),
    activeLoops,
    dbRunningCount: dbRunning.length,
    dbRunning,
    stuckThresholdMinutes: STUCK_THRESHOLD_MS / 60_000,
  });
});

// ── Sync all campaign counters from message_logs ───────────────────────────
// Fixes any counter drift across ALL campaigns for this user.
// Called from the Settings page "إصلاح العدادات" button.
router.post("/sync-counts", async (req, res) => {
  const userId = req.session.userId!;

  const userCampaigns = await db
    .select({ id: campaignsTable.id, sentCount: campaignsTable.sentCount, failedCount: campaignsTable.failedCount })
    .from(campaignsTable)
    .where(eq(campaignsTable.userId, userId));

  let fixed = 0;
  const details: Array<{ id: number; oldSent: number; newSent: number; oldFailed: number; newFailed: number }> = [];

  for (const camp of userCampaigns) {
    const [real] = await db
      .select({
        realSentCount:   sql<number>`count(*) filter (where ${messageLogs.status} = 'sent')`,
        realFailedCount: sql<number>`count(*) filter (where ${messageLogs.status} = 'failed')`,
      })
      .from(messageLogs)
      .where(eq(messageLogs.campaignId, camp.id));

    const actualSent   = Number(real?.realSentCount   ?? 0);
    const actualFailed = Number(real?.realFailedCount ?? 0);

    if (actualSent !== camp.sentCount || actualFailed !== camp.failedCount) {
      await db.update(campaignsTable)
        .set({ sentCount: actualSent, failedCount: actualFailed })
        .where(eq(campaignsTable.id, camp.id));
      details.push({ id: camp.id, oldSent: camp.sentCount, newSent: actualSent, oldFailed: camp.failedCount, newFailed: actualFailed });
      fixed++;
    }
  }

  logger.info({ userId, fixed, total: userCampaigns.length }, "Campaign counter bulk sync completed");
  res.json({ fixed, total: userCampaigns.length, details });
});

export default router;
