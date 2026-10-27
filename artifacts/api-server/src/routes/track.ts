// ── Public: the pixel, the click, the unsubscribe, the inbound hook ──
// No session on any of these; the token is the credential and an unknown
// one is answered blandly. The pixel is a real 1×1 GIF so a client that
// blocks "tracking" scripts still loads it as an image.

import { Router } from "express";
import { createHmac } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db, emailSettingsTable, emailContactsTable, emailMessagesTable, emailEventsTable } from "@workspace/db";
import { messageByToken, recordEvent } from "../lib/email/service";
import { handleInbound, normalizeWebhook } from "../lib/email/inbound";
import { logger } from "../lib/logger";

const router = Router();
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SECRET = () => process.env["SESSION_SECRET"] ?? "wam";

const noStore = (res: any) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
};

// Apple's Mail Privacy Protection and Gmail's image proxy both fetch the
// pixel on the reader's behalf, so an "open" is a floor, not a fact. It is
// still the only open signal there is.
router.get("/t/e/:token.gif", async (req, res) => {
  noStore(res);
  res.setHeader("Content-Type", "image/gif");
  const m = await messageByToken(req.params.token).catch(() => null);
  if (m && m.status !== "queued") {
    const ua = String(req.headers["user-agent"] ?? "");
    const proxied = /GoogleImageProxy|Apple Mail|MailPrivacyProtection/i.test(ua);
    // Of 699 «opened» mails in a month, 317 were fetched within two minutes of
    // sending and 250 by Apple's bare «Mozilla/5.0» — machines. They are kept
    // as a machine open and move nobody onto the «opened» ladder.
    if (isMachineOpen(ua, m.sentAt ? Date.now() - new Date(m.sentAt).getTime() : null)) {
      void db.insert(emailEventsTable).values({ userId: m.userId, messageId: m.id, type: "machine_open", meta: { ua: ua.slice(0, 120) } }).catch(() => {});
    } else void recordEvent(m.userId, m.id, "open", { meta: { ua: ua.slice(0, 120), proxied } }).catch(() => {});
  }
  res.end(GIF);
});

/**
 * A pixel fetched by a machine: Apple's privacy proxy (a bare «Mozilla/5.0»
 * that loads every mail on arrival), a mail gateway in the first two minutes,
 * or no agent at all. Gmail's proxy is kept: it fetches when she opens. Pure.
 */
export function isMachineOpen(ua: string, msSinceSent: number | null): boolean {
  const u = ua.trim();
  if (!u || u === "Mozilla/5.0" || /MailPrivacyProtection/i.test(u)) return true;
  if (/python|curl|wget|go-http|headless|bot|crawler|spider|scan|proofpoint|mimecast|barracuda|symantec|trendmicro|sophos|zscaler/i.test(u)) return true;
  return msSinceSent !== null && msSinceSent >= 0 && msSinceSent < 120_000;
}

/** A link opened by a machine, not a person: a scanner's agent, or within ninety seconds of sending. Pure. */
export function isScannerClick(ua: string, msSinceSent: number | null): boolean {
  if (/python|curl|wget|go-http|java\/|okhttp|headless|bot|crawler|spider|scan|preview|proofpoint|mimecast|barracuda|safelinks|urldefense|fireeye|symantec|trendmicro|sophos|zscaler/i.test(ua)) return true;
  if (!ua.trim()) return true;
  return msSinceSent !== null && msSinceSent >= 0 && msSinceSent < 90_000;
}

router.get("/t/e/:token/c", async (req, res) => {
  noStore(res);
  const url = String(req.query["u"] ?? "");
  const sig = String(req.query["s"] ?? "");
  if (!/^https?:\/\//i.test(url)) return res.status(400).send("bad link");
  const expected = createHmac("sha256", SECRET()).update(`${req.params.token}|${url}`).digest("base64url").slice(0, 16);
  if (sig !== expected) return res.status(400).send("bad link");
  const m = await messageByToken(req.params.token).catch(() => null);
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 120);
  // A mail gateway opens every link the moment the email lands (Defender, Mimecast, Proofpoint…):
  // 220 of 338 «clicks» came in the minute of sending. Those are kept as a scan, not counted as a person.
  if (m && isScannerClick(ua, m.sentAt ? Date.now() - new Date(m.sentAt).getTime() : null)) {
    void db.insert(emailEventsTable).values({ userId: m.userId, messageId: m.id, type: "scan", url, meta: { ua } }).catch(() => {});
  } else if (m) void recordEvent(m.userId, m.id, "click", { url, meta: { ua } }).catch(() => {});
  res.redirect(302, url);
});

async function unsubscribe(token: string) {
  const m = await messageByToken(token).catch(() => null);
  if (!m) return null;
  await recordEvent(m.userId, m.id, "unsubscribe", { meta: { via: "link" } });
  return m;
}

// GET shows a confirmation page (a security scanner following links must
// not unsubscribe anyone); POST is the one-click standard.
router.get("/t/e/:token/u", async (req, res) => {
  noStore(res);
  const m = await messageByToken(req.params.token).catch(() => null);
  const to = m?.toEmail ?? "";
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>إلغاء الاشتراك</title>
<style>body{font-family:Arial,sans-serif;background:#f6f7f9;margin:0;padding:40px 16px;color:#111}.box{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 1px 4px rgba(0,0,0,.08)}button{background:#111;color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}p{line-height:1.7}</style></head>
<body><div class="box"><h2>إلغاء الاشتراك</h2>${m ? `<p>سنتوقف عن إرسال الرسائل إلى <b dir="ltr">${to}</b>.</p><form method="post"><button type="submit">نعم، أوقفوا الرسائل</button></form>` : "<p>الرابط غير صالح.</p>"}</div></body></html>`);
});
router.post("/t/e/:token/u", async (req, res) => {
  noStore(res);
  const m = await unsubscribe(req.params.token);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تم</title><style>body{font-family:Arial,sans-serif;background:#f6f7f9;padding:40px 16px;color:#111}.box{max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px}</style></head><body><div class="box"><h2>${m ? "تم إلغاء الاشتراك" : "الرابط غير صالح"}</h2>${m ? `<p>لن تصلك رسائل أخرى على <b dir="ltr">${m.toEmail}</b>.</p>` : ""}</div></body></html>`);
});

// Providers that push inbound mail post here. The token in the path is the
// account's; it is generated in the settings page and never guessable.
router.post("/api/email/inbound/:token", async (req, res) => {
  const [s] = await db.select({ userId: emailSettingsTable.userId }).from(emailSettingsTable)
    .where(eq(emailSettingsTable.inboundToken, req.params.token)).limit(1);
  if (!s) return res.status(404).json({ error: "unknown" });
  const mails = normalizeWebhook(req.body);
  let n = 0;
  for (const m of mails) { try { if (await handleInbound(s.userId, m)) n++; } catch (err) { logger.warn({ err: String((err as any)?.message ?? err) }, "inbound webhook item failed"); } }
  res.json({ received: mails.length, handled: n });
});

// A provider's bounce/complaint webhook, when the provider is the one that
// knows: Resend and Brevo both post event JSON; SMTP bounces arrive as mail.
router.post("/api/email/events/:token", async (req, res) => {
  const [s] = await db.select({ userId: emailSettingsTable.userId }).from(emailSettingsTable)
    .where(eq(emailSettingsTable.inboundToken, req.params.token)).limit(1);
  if (!s) return res.status(404).json({ error: "unknown" });
  const b: any = req.body ?? {};
  const type = String(b.type ?? b.event ?? "").toLowerCase();
  const email = String(b.data?.to?.[0] ?? b.email ?? b.data?.email ?? "").toLowerCase();
  const kind = /bounce|hard_bounce|soft_bounce/.test(type) ? "bounce" : /complain|spam/.test(type) ? "complaint" : /unsub/.test(type) ? "unsubscribe" : null;
  if (kind && email) {
    const [c] = await db.select({ id: emailContactsTable.id }).from(emailContactsTable)
      .where(eq(emailContactsTable.email, email)).limit(1);
    if (c) {
      const [m] = await db.select({ id: emailMessagesTable.id }).from(emailMessagesTable)
        .where(and(eq(emailMessagesTable.userId, s.userId), eq(emailMessagesTable.toEmail, email))).orderBy(desc(emailMessagesTable.createdAt)).limit(1);
      await recordEvent(s.userId, m?.id ?? null, kind, { meta: { provider: true, type } });
      if (!m) await db.update(emailContactsTable).set({ status: kind === "unsubscribe" ? "unsubscribed" : kind === "bounce" ? "bounced" : "complained" }).where(eq(emailContactsTable.id, c.id));
    }
  }
  res.json({ ok: true });
});

export default router;
