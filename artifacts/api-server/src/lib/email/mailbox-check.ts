// ── هل الصندوق موجود؟ يُسأل خادم المستلم قبل الإرسال ──────────────
// أكبر سببٍ للارتداد في هذا الحساب «الحساب غير موجود»: عنوانٌ قديم في
// الملف، والنطاق نفسه سليم فلا يكشفه فحص MX. خادم المستلم يقولها إن
// سُئل: نفتح معه محادثة SMTP، نقول «إلى فلان» (RCPT TO)، ونسمع جوابه،
// ثم نخرج قبل أن نرسل شيئاً. ثم نسأله عن عنوانٍ عشوائي لا يوجد قطعاً:
// إن قبله فهو يقبل كل شيء (catch-all)، و«نعم» منه لا تعني شيئاً.
//
// حدوده: بعض الخوادم تقبل الكل، وبعضها يؤجّل (greylisting) أو يرفضنا نحن
// لا العنوان. كل ذلك «unknown» — يُرسَل إليه كما كان، والعيّنة تحمي.
// وخطره: سؤالٌ كثيرٌ سريع يجعل عنوان السيرفر مزعجاً، وعليه متجر فلوريت.
// فالأسئلة واحدٌ بعد واحد، بفاصلٍ بينها، وبسقفٍ في الساعة، ومن أوّل
// عشر محاولات فاشلة متتالية يتوقف الفحص ست ساعات.

import net from "node:net";
import { promises as dns } from "node:dns";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, emailContactsTable } from "@workspace/db";
import { logger } from "../logger";

export type Mailbox = "ok" | "invalid" | "catchall" | "unknown";

/**
 * ما يعنيه جواب RCPT TO. Pure.
 * ٥xx عن **العنوان** (5.1.1 وأخواتها، «user unknown»…) يعني لا صندوق. أما ٥xx
 * عن **نا** (سياسة، سمعة، حظر، 5.7.x) فليس حكماً على العنوان.
 */
export function classifyRcpt(code: number, text: string): "ok" | "invalid" | "unknown" {
  if (code === 250 || code === 251) return "ok";
  if (code >= 400 && code < 500) return "unknown";
  const t = text.toLowerCase();
  if (/5\.7\.\d|spam|block|blacklist|listed|reputation|policy|denied|not allowed|relay|authenticat|helo|reverse|ptr|rate|too many|spf|dmarc/.test(t)) return "unknown";
  if (/5\.1\.(1|0|10|6)|5\.2\.1|5\.5\.1|user unknown|unknown user|no such (user|mailbox|recipient)|does not exist|doesn'?t exist|not exist|invalid (recipient|mailbox|address)|recipient (address )?rejected|mailbox (unavailable|not found)|address rejected|undeliverable|not found|disabled|inactive|no mailbox/.test(t)) return "invalid";
  if (code === 550 || code === 553) return "invalid";
  return "unknown";
}

// ── المحادثة ──────────────────────────────────────────────────────
type Reply = { code: number; text: string };

function talk(host: string, timeoutMs: number) {
  const sock = net.connect({ host, port: 25 });
  sock.setEncoding("utf8");
  let buf = "";
  const waiting: Array<(r: Reply) => void> = [];
  const ready: Reply[] = [];
  let failed: Error | null = null;
  const fail = (e: Error) => { failed = e; while (waiting.length) waiting.shift()!({ code: 0, text: e.message }); };
  sock.setTimeout(timeoutMs, () => { fail(new Error("timeout")); sock.destroy(); });
  sock.on("error", (e) => fail(e));
  sock.on("close", () => fail(failed ?? new Error("closed")));
  sock.on("data", (d: string) => {
    buf += d;
    let lines: string[] = [];
    while (buf.includes("\n")) {
      const i = buf.indexOf("\n");
      const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
      lines.push(line);
      // «250-…» سطرٌ يتبعه غيره؛ «250 …» آخر الجواب.
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const r = { code: Number(line.slice(0, 3)), text: lines.join(" ") };
        lines = [];
        const w = waiting.shift();
        if (w) w(r); else ready.push(r);
      }
    }
  });
  const read = () => new Promise<Reply>((ok) => { if (ready.length) ok(ready.shift()!); else if (failed) ok({ code: 0, text: failed.message }); else waiting.push(ok); });
  const say = (line: string) => { if (!failed) sock.write(line + "\r\n"); return read(); };
  return { read, say, close: () => { try { sock.write("QUIT\r\n"); } catch { /* gone */ } sock.end(); setTimeout(() => sock.destroy(), 1000); } };
}

const HELO = () => process.env["MAIL_HELO"] || (() => { try { return new URL(process.env["SITE_URL"] ?? "").hostname; } catch { return ""; } })() || "flow.getmihwar.com";

/** يسأل خادم النطاق عن هذه العناوين في محادثةٍ واحدة. */
async function probeDomain(domain: string, emails: string[], from: string): Promise<Map<string, Mailbox>> {
  const out = new Map<string, Mailbox>(emails.map((e) => [e, "unknown" as Mailbox]));
  let mx: Array<{ exchange: string; priority: number }> = [];
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority); } catch { return out; }
  const host = mx[0]?.exchange;
  if (!host) return out;
  await throttleHost(host);
  const s = talk(host, 12_000);
  try {
    if ((await s.read()).code !== 220) return out;
    let r = await s.say(`EHLO ${HELO()}`);
    if (r.code !== 250) r = await s.say(`HELO ${HELO()}`);
    if (r.code !== 250) return out;
    if ((await s.say(`MAIL FROM:<${from}>`)).code !== 250) return out;
    let anyOk = false;
    for (const e of emails) {
      r = await s.say(`RCPT TO:<${e}>`);
      if (r.code === 0) return out;
      const v = classifyRcpt(r.code, r.text);
      out.set(e, v);
      if (v === "ok") anyOk = true;
    }
    if (anyOk) {
      // صندوقٌ لا يوجد قطعاً: إن قبله الخادم فهو يقبل الكل.
      const fake = `zz-${randomBytes(6).toString("hex")}-noexist@${domain}`;
      r = await s.say(`RCPT TO:<${fake}>`);
      if (classifyRcpt(r.code, r.text) === "ok") for (const [e, v] of out) if (v === "ok") out.set(e, "catchall");
    }
    connectFailures = 0;
    return out;
  } finally { s.close(); }
}

// ── الحذر: واحدٌ بعد واحد، فاصلٌ، وسقف ───────────────────────────
const GAP_MS = 2_000, HOST_GAP_MS = 10_000, PER_HOUR = 300;
let chain: Promise<unknown> = Promise.resolve();
const hostLast = new Map<string, number>();
let hourStart = Date.now(), hourCount = 0;
let connectFailures = 0, pausedUntil = 0;

async function throttleHost(host: string) {
  const wait = (hostLast.get(host) ?? 0) + HOST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  hostLast.set(host, Date.now());
}

export const probeState = () => ({ pausedUntil: pausedUntil > Date.now() ? new Date(pausedUntil).toISOString() : null, thisHour: hourCount, perHour: PER_HOUR });

/**
 * يفحص العناوين ويحفظ الحكم على جهاتها. ما لا يُفحص (السقف، التوقف،
 * عطل الاتصال) يبقى بلا حكم فيُسأل لاحقاً.
 */
export async function checkMailboxes(contacts: Array<{ id: number; email: string }>, from: string): Promise<Map<number, Mailbox>> {
  const job = chain.then(async () => {
    const res = new Map<number, Mailbox>();
    if (Date.now() < pausedUntil) return res;
    const byDomain = new Map<string, Array<{ id: number; email: string }>>();
    for (const c of contacts) {
      const d = c.email.split("@")[1]?.toLowerCase();
      if (d) byDomain.set(d, [...(byDomain.get(d) ?? []), c]);
    }
    for (const [domain, cs] of byDomain) {
      if (Date.now() - hourStart > 3_600_000) { hourStart = Date.now(); hourCount = 0; }
      if (hourCount >= PER_HOUR) break;
      hourCount += cs.length;
      let got: Map<string, Mailbox>;
      try { got = await probeDomain(domain, cs.slice(0, 20).map((c) => c.email.toLowerCase()), from); }
      catch { got = new Map(); }
      const answered = [...got.values()].some((v) => v !== "unknown");
      if (!answered && ++connectFailures >= 10) {
        pausedUntil = Date.now() + 6 * 3_600_000; connectFailures = 0;
        logger.warn("فحص الصناديق توقف ست ساعات: عشر محاولات بلا جواب متتالية");
      }
      for (const c of cs.slice(0, 20)) {
        const v = got.get(c.email.toLowerCase()) ?? "unknown";
        res.set(c.id, v);
        await db.update(emailContactsTable).set({ mailbox: v, mailboxCheckedAt: new Date() }).where(eq(emailContactsTable.id, c.id));
      }
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
    return res;
  });
  chain = job.catch(() => null);
  return job;
}

/** حكمٌ يُعاد سؤاله: «unknown» بعد يوم، والباقي بعد ستين يوماً. Pure. */
export function needsCheck(c: { mailbox: string | null; mailboxCheckedAt: Date | null }, now = Date.now()): boolean {
  if (!c.mailbox || !c.mailboxCheckedAt) return true;
  const age = now - new Date(c.mailboxCheckedAt).getTime();
  return c.mailbox === "unknown" ? age > 86_400_000 : age > 60 * 86_400_000;
}
