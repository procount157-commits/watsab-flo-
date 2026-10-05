import app from "./app";
import { logger } from "./lib/logger";
import { restoreAllSessions, getActiveUserIds, getStatus, initWhatsApp, startWakeDetector } from "./lib/whatsapp";
import { resumeRunningCampaigns } from "./routes/campaigns";
import { startFollowUpEngine } from "./lib/follow-up-engine";
import { startMonitorAgent } from "./lib/monitor-agent";
import { startRoutineScheduler } from "./lib/agent-routines";
import { startOpsAgent } from "./lib/ops-agent";
import { startCollector } from "./lib/collector-agent";
import { startBrowserReaper } from "./lib/browser-agent";
import { startMeetings } from "./lib/meeting";
import { startOutboxWorker } from "./lib/telegram";
import { startSocial } from "./lib/social/engine";
import { startTaskReminders } from "./lib/groups/tasks";
import { startObligationReminders } from "./lib/groups/obligations";
import { startMeetingReminders } from "./lib/deals/meetings";
import { startProposalFollowups } from "./lib/deals/proposals";
import { startMorningBrief } from "./lib/morning-brief";
import { seedSkillsForEveryone } from "./lib/skills";
import { sweepQuietOutcomes } from "./lib/agent-memory";
import { startEmailWorkers } from "./lib/email/service";
import { startInboundPolling } from "./lib/email/inbound";
import { startMissionWorker } from "./lib/email/missions";
import { startAutopilotWorker } from "./lib/email/autopilot";
import { ensureEmailAgent } from "./lib/email/agent";
import { db as dbx, botEmployeesTable as botEmp } from "@workspace/db";
import { runAutoMaintenance } from "./lib/diagnosis-engine";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import https from "https";
import http from "http";
import { execSync } from "child_process";

// ── Process-level crash guard ─────────────────────────────────────
// An unhandled exception would kill the server and stop ALL campaigns.
// Log it and keep running — individual async paths have their own try/catch.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "UNCAUGHT EXCEPTION — server kept alive");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "UNHANDLED REJECTION — server kept alive");
});

async function seedAdminIfConfigured() {
  const adminPhone = process.env["ADMIN_PHONE"];
  const adminPassword = process.env["ADMIN_PASSWORD"];
  if (!adminPhone || !adminPassword) return;

  try {
    const rawPhone = adminPhone.replace(/[\s\-\+\(\)]/g, "");
    const cleanPhone = rawPhone.replace(/^00/, "");

    let [user] = await db.select().from(usersTable).where(eq(usersTable.phone, cleanPhone));
    if (!user && cleanPhone !== rawPhone) {
      [user] = await db.select().from(usersTable).where(eq(usersTable.phone, rawPhone));
    }
    if (!user) {
      logger.info({ adminPhone }, "seed-admin: user not found, skipping");
      return;
    }

    const hash = await bcrypt.hash(adminPassword, 10);
    const token = crypto.randomBytes(32).toString("hex");

    await db.update(usersTable)
      .set({ passwordHash: hash, isAdmin: true, directLoginToken: token })
      .where(eq(usersTable.id, user.id));

    logger.info({ userId: user.id, phone: user.phone, directLoginToken: token }, "seed-admin: admin upgraded ✓");
  } catch (err) {
    logger.error({ err }, "seed-admin: failed");
  }
}

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Port conflict prevention ───────────────────────────────────────
// When a Replit workflow restarts, the old Node process may still hold
// the port for a few seconds, causing EADDRINUSE → server fails to start
// → WA sessions drop → campaigns stop.
// Kill the old process first, wait 500 ms, then bind.
// (The package.json start script also does this; this is a belt-and-suspenders guard.)
try {
  execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" });
  // Brief pause to let the OS reclaim the port
  execSync("sleep 0.4", { stdio: "ignore" });
} catch { /* fuser not available or port already free — ignore */ }

let eaddrRetries = 0;
const EADDR_MAX = 8;

function startListening() {
  app.listen(port, (err) => {
    if (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        eaddrRetries++;
        if (eaddrRetries > EADDR_MAX) {
          logger.error({ port, retries: eaddrRetries }, "EADDRINUSE: max retries exceeded — exiting so workflow can restart");
          process.exit(1);
        }
        logger.warn({ port, attempt: eaddrRetries, max: EADDR_MAX }, "EADDRINUSE — killing occupying process and retrying in 1.5 s");
        try { execSync(`fuser -k ${port}/tcp 2>/dev/null`, { stdio: "ignore" }); } catch {}
        setTimeout(startListening, 1500);
        return;
      }
      logger.error({ err }, "Fatal: cannot listen on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");

    // Restore all saved WhatsApp sessions from DB — no QR needed after restart or deployment
    void restoreAllSessions();
    startWakeDetector();

    // Resume any campaigns that were running before the server restarted
    void resumeRunningCampaigns();
    startFollowUpEngine();
    startMonitorAgent();
    startRoutineScheduler();
    startOpsAgent();
    startCollector();
    startBrowserReaper();
    startMeetings();
    startOutboxWorker();
    startSocial();
    startTaskReminders();
    startObligationReminders();
    startMeetingReminders();
    startProposalFollowups();
    startMorningBrief();
    startEmailWorkers();
    startInboundPolling();
    startMissionWorker();
    startAutopilotWorker();
    // نورة joins every team that exists, so she appears beside the others.
    setTimeout(async () => {
      const teams = await dbx.selectDistinct({ userId: botEmp.userId }).from(botEmp).catch(() => []);
      for (const { userId } of teams) await ensureEmailAgent(userId).catch(() => {});
    }, 25_000);

    // Auto-seed admin on startup if env vars are set
    void seedAdminIfConfigured();

    // The skill library ships in source; this is what installs a change to it
    // on every account that has a team, instead of waiting for someone to
    // press the install button.
    setTimeout(() => void seedSkillsForEveryone(), 20_000);

    // Silence is an outcome. Hourly, a reply nobody answered for a day is
    // marked quiet, which is what lets the coach and the meeting see the
    // replies that lost the customer as well as the ones that won them.
    setTimeout(() => {
      void sweepQuietOutcomes().catch(() => {});
      setInterval(() => void sweepQuietOutcomes().catch(() => {}), 60 * 60_000);
    }, 45_000);

    // ── Connection Guardian ───────────────────────────────────────────
    // Runs every 90 seconds. For every user whose WA instance is loaded
    // but shows "disconnected" (not reconnecting, not qr_ready), fires
    // initWhatsApp() immediately — same as the watchdog inside the instance
    // but from outside, as a second safety net.
    startConnectionGuardian();

    // ── Auto-Maintenance Scheduler ─────────────────────────────────────
    // Runs every 10 minutes for every loaded WA instance: performs a
    // safe, read-only-or-reconnect-only self-healing pass (never wipes
    // credentials). Complements the Connection Guardian (which only
    // handles fully-dead sockets) by also validating degraded/stale
    // sessions and flagging broken sessions for the user.
    startAutoMaintenanceScheduler();

    // ── Self-ping keep-alive ──────────────────────────────────────────
    // Pings /api/ping every 1 minute to keep the server process alive.
    // For 24/7 uptime also set up UptimeRobot to ping from the outside.
    startKeepAlive(port);
  });
}

startListening();

// ── Global Connection Guardian ────────────────────────────────────────
// Second safety net on top of the per-instance watchdog.
// Every 90 s it scans ALL loaded WA instances; any that are "disconnected"
// (session saved but socket dead, not currently reconnecting/qr_ready) get
// an immediate initWhatsApp() call.  This catches edge cases where the
// per-instance watchdog timer was lost (e.g. GC, setInterval swallowed).
function startConnectionGuardian() {
  const INTERVAL_MS = 90_000; // 90 seconds

  async function runGuardian() {
    const ids = getActiveUserIds();
    for (const userId of ids) {
      try {
        const s = getStatus(userId);
        // Only act when truly dead — not when actively reconnecting / showing QR
        if (!s.connected &&
            s.status !== "connecting" &&
            s.status !== "reconnecting" &&
            s.status !== "qr_ready") {
          logger.info({ userId, status: s.status }, "Guardian: dead session detected — triggering reconnect");
          await initWhatsApp(userId);
        }
      } catch (err) {
        logger.error({ err, userId }, "Guardian: reconnect attempt failed");
      }
    }
  }

  // First run after 30 s to let restoreAllSessions finish initialising
  setTimeout(() => {
    void runGuardian();
    setInterval(() => void runGuardian(), INTERVAL_MS);
  }, 30_000);

  logger.info({ intervalSec: INTERVAL_MS / 1000 }, "Connection guardian started");
}

// ── Auto-Maintenance Scheduler ─────────────────────────────────────────
// Every 10 minutes, runs the safe self-healing routine (runAutoMaintenance)
// for every loaded WA instance. Unlike the Connection Guardian above, this
// also acts on "degraded"/"stale"/"broken_session" extendedStatus values —
// not just fully "disconnected" sockets — giving earlier, more precise
// intervention. All actions are logged to wa_session_events as
// "auto_maintenance" so they show up in the diagnostics root-cause view.
function startAutoMaintenanceScheduler() {
  const INTERVAL_MS = 10 * 60_000; // 10 minutes

  async function runMaintenance() {
    const ids = getActiveUserIds();
    for (const userId of ids) {
      try {
        const result = await runAutoMaintenance(userId);
        if (result.action !== "noop") {
          logger.info({ userId, action: result.action, diagnosis: result.diagnosis }, "Auto-maintenance: action taken");
        }
      } catch (err) {
        logger.error({ err, userId }, "Auto-maintenance: run failed");
      }
    }
  }

  // First run after 60 s (after guardian's 30 s head start) so it never
  // races an in-progress restoreAllSessions() init.
  setTimeout(() => {
    void runMaintenance();
    setInterval(() => void runMaintenance(), INTERVAL_MS);
  }, 60_000);

  logger.info({ intervalMin: INTERVAL_MS / 60_000 }, "Auto-maintenance scheduler started");
}

// ── Heartbeat ─────────────────────────────────────────────────────
// A minute-by-minute self-ping. It was written to stop a Replit workspace
// sleeping, and read REPLIT_DOMAINS to find its own public URL — neither of
// which exists any more. What remains useful is the local half: it proves the
// event loop is still turning, and a gap in the log is the clearest evidence
// that the process was wedged rather than merely quiet.
//
// HEARTBEAT_URL replaces the guessed public domain. Set it to an uptime
// monitor's ping URL when the VPS should be watched from outside; leave it
// unset and only the local check runs.
function startKeepAlive(localPort: number): void {
  const INTERVAL_MS = 60_000;

  const localUrl  = `http://localhost:${localPort}/api/ping`;
  const publicUrl = process.env["HEARTBEAT_URL"] || null;

  function ping(url: string) {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: 10_000 }, (res) => {
      logger.debug({ statusCode: res.statusCode, url }, "heartbeat ✓");
      res.resume();
    });
    req.on("error", (e) => logger.warn({ err: e.message, url }, "heartbeat failed"));
    req.end();
  }

  setInterval(() => {
    ping(localUrl);
    if (publicUrl) ping(publicUrl);
  }, INTERVAL_MS);

  logger.info({ localUrl, publicUrl, intervalMin: INTERVAL_MS / 60_000 }, "Heartbeat started");
}
