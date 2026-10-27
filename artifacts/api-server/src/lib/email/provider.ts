// ── Sending one email ─────────────────────────────────────────────
// Three ways out, chosen per account: SMTP (any mailbox — Google Workspace,
// Microsoft 365, Hostinger, Zoho), Resend, or Brevo. The two APIs are plain
// fetch calls; SMTP goes through nodemailer. All three return the provider's
// id for the message so a bounce or a reply can be tied back.

import nodemailer, { type Transporter } from "nodemailer";
import type { EmailSettings } from "@workspace/db";

export interface OutgoingEmail {
  to: string;
  toName?: string | null;
  subject: string;
  html: string;
  text: string;
  /** Our own RFC Message-ID, so replies carry it in In-Reply-To. */
  messageId: string;
  unsubscribeUrl: string | null;
  inReplyTo?: string | null;
  /** The thread so far, oldest first — a follow-up lands under the first mail, not as a new one. */
  references?: string[] | null;
}

export interface SendResult { providerId: string | null; serverReply?: string; accepted?: string[]; rejected?: string[] }

/**
 * لماذا رُفضت الرسالة — وهذا ليس تفصيلاً: الجواب يحدّد من يُعاقَب.
 *
 *   address   العنوان نفسه لا وجود له. الجهة تُعلَّم مرتدّة، وهذا صحيح.
 *   policy    المزوّد رفض **رسالتنا**: عدّها إزعاجاً، أو حجب سمعتنا، أو
 *             منعنا بسياسة. العنوان سليم، والخلل عندنا.
 *   transient لحظةٌ عابرة: حدّ معدّل، شبكة، خادمٌ مشغول.
 *   config    إعدادنا ناقص.
 *
 * كان الحكم واحداً: كل رمز 5xx «دائم»، وكل دائمٍ ارتدادٌ من العنوان. فلمّا
 * رفض Hostinger ثلاثين رسالة في يومٍ واحد بـ«554 5.7.1 Spam message
 * rejected» — رفضاً لنصّنا المتكرّر لا لعناوينهم — عُلّمت ثلاثون شركة
 * سليمة «مرتدّة» وخرجت من كل قائمة، وارتفعت نسبة الارتداد المعروضة،
 * وبُني على ذلك حكمٌ بأن القائمة فاسدة. والقائمة كانت بريئة.
 */
export type SendFailure = "address" | "policy" | "transient" | "config";

const POLICY_RE  = /(5\.7\.\d|spam|policy|blocked|blacklist|block list|reputation|denied|not allowed|content rejected|message rejected|suspicious|abuse|dmarc|spf|dkim|authentication)/i;
const ADDRESS_RE = /(5\.1\.\d|5\.2\.[12]|user unknown|unknown user|no such (user|recipient|mailbox|address)|mailbox (unavailable|not found|does not exist|disabled)|recipient (address )?rejected|address rejected|does not exist|invalid (recipient|mailbox|address)|account (disabled|inactive)|undeliverable)/i;
const AUTH_RE    = /(invalid login|authentication failed|auth(entication)? unsuccessful|username and password not accepted|535[ -]5\.7\.[038]|534[ -]5\.7\.9|application-specific password|smtp auth.*disabled)/i;
const RATE_RE    = /(rate|too many|limit|quota|throttl|try again|temporar)/i;

/** نوع الفشل من رمز الخادم ونصّه. السياسة تُسأل قبل العنوان: «5.7.1» ليست عن المستلم. */
export function classifySendFailure(code: string, message: string): SendFailure {
  // The server refused our login: the mailbox's password or permissions, not the message.
  if (AUTH_RE.test(message) || code === "535" || code === "534") return "config";
  if (RATE_RE.test(message) && !/5\.1\.\d/.test(message)) return "transient";
  if (!code.startsWith("5")) return "transient";
  if (POLICY_RE.test(message)) return "policy";
  if (ADDRESS_RE.test(message)) return "address";
  // 5xx بلا دلالة: لا يُعاقَب به عنوانٌ. الشكّ يُفسَّر لمصلحة الجهة، فجهةٌ
  // تُعلَّم مرتدّة ظلماً تخرج من كل موجةٍ قادمة بلا أن يراها أحد.
  return "policy";
}

export class SendError extends Error {
  public kind: SendFailure;
  constructor(message: string, public permanent = false, kind?: SendFailure) {
    super(message);
    this.kind = kind ?? (permanent ? "config" : "transient");
  }
}

export function isConfigured(s: EmailSettings | null | undefined): boolean {
  if (!s?.fromEmail) return false;
  if (s.provider === "smtp") return !!(s.smtpHost && s.smtpUser && s.smtpPass);
  return !!s.apiKey;
}

function fromHeader(s: EmailSettings): string {
  return s.fromName ? `"${s.fromName.replace(/"/g, "'")}" <${s.fromEmail}>` : s.fromEmail!;
}

function listUnsubscribe(url: string | null, from: string): Record<string, string> {
  // One-click unsubscribe is what Gmail and Yahoo require of anyone sending
  // in volume. Both headers, so a client that only reads one still shows it.
  const parts = [`<mailto:${from}?subject=unsubscribe>`];
  if (url) parts.unshift(`<${url}>`);
  return { "List-Unsubscribe": parts.join(", "), "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

const transports = new Map<string, Transporter>();
function smtpTransport(s: EmailSettings): Transporter {
  // The password is in the key, so a corrected password is not answered by the old pool.
  const key = `${s.smtpHost}|${s.smtpPort}|${s.smtpUser}|${s.smtpSecure}|${s.smtpPass}`;
  let t = transports.get(key);
  if (!t) {
    t = nodemailer.createTransport({
      // 465 is TLS from the first byte; the settings page has no switch for it, so the port decides.
      host: s.smtpHost!, port: s.smtpPort ?? 587, secure: !!s.smtpSecure || s.smtpPort === 465,
      auth: { user: s.smtpUser!, pass: s.smtpPass! },
      pool: true, maxConnections: 2, maxMessages: 50,
      connectionTimeout: 20_000, socketTimeout: 30_000,
    });
    transports.set(key, t);
  }
  return t;
}

export async function sendEmail(s: EmailSettings, m: OutgoingEmail): Promise<SendResult> {
  if (!isConfigured(s)) throw new SendError("إعدادات البريد غير مكتملة", true);
  const headers = listUnsubscribe(m.unsubscribeUrl, s.fromEmail!);

  if (s.provider === "smtp") {
    try {
      const info = await smtpTransport(s).sendMail({
        from: fromHeader(s), to: m.toName ? `"${m.toName.replace(/"/g, "'")}" <${m.to}>` : m.to,
        replyTo: s.replyTo ?? undefined,
        subject: m.subject, html: m.html, text: m.text,
        messageId: m.messageId, inReplyTo: m.inReplyTo ?? undefined, references: m.references?.length ? m.references : undefined,
        headers,
      });
      // What the server said and which addresses it took: "accepted" only
      // means the server queued it, and the owner checking why nothing
      // arrived needs to see that, not just "sent".
      return { providerId: info.messageId ?? null, serverReply: String(info.response ?? "").slice(0, 300), accepted: (info.accepted ?? []).map(String), rejected: (info.rejected ?? []).map(String) };
    } catch (err: any) {
      const code = String(err?.responseCode ?? (err?.code === "EAUTH" ? "535" : ""));
      const msg = String(err?.message ?? err).slice(0, 300);
      // 5xx from the server is the address or the message; 4xx and network
      // errors are the moment.
      const kind = classifySendFailure(code, msg);
      throw new SendError(msg, kind === "address" || kind === "policy", kind);
    }
  }

  if (s.provider === "resend") {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromHeader(s), to: [m.to], reply_to: s.replyTo ?? undefined,
        subject: m.subject, html: m.html, text: m.text,
        headers: { ...headers, "Message-ID": m.messageId, ...(m.inReplyTo ? { "In-Reply-To": m.inReplyTo } : {}), ...(m.references?.length ? { References: m.references.join(" ") } : {}) },
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new SendError(`resend ${r.status}: ${String(d?.message ?? "").slice(0, 200)}`, r.status === 422 || r.status === 403);
    return { providerId: d?.id ?? null };
  }

  if (s.provider === "brevo") {
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": s.apiKey!, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { name: s.fromName ?? undefined, email: s.fromEmail },
        to: [{ email: m.to, name: m.toName ?? undefined }],
        replyTo: s.replyTo ? { email: s.replyTo } : undefined,
        subject: m.subject, htmlContent: m.html, textContent: m.text,
        headers: { ...headers, "Message-ID": m.messageId, ...(m.inReplyTo ? { "In-Reply-To": m.inReplyTo } : {}), ...(m.references?.length ? { References: m.references.join(" ") } : {}) },
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new SendError(`brevo ${r.status}: ${String(d?.message ?? "").slice(0, 200)}`, r.status === 400 || r.status === 401);
    return { providerId: d?.messageId ?? null };
  }

  throw new SendError(`مزوّد غير معروف: ${s.provider}`, true);
}

/** Try the connection without sending anything (SMTP) or with a key check (APIs). */
export async function verifySettings(s: EmailSettings): Promise<{ ok: boolean; detail: string }> {
  try {
    if (s.provider === "smtp") { await smtpTransport(s).verify(); return { ok: true, detail: "اتصال SMTP ناجح" }; }
    if (s.provider === "resend") {
      const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${s.apiKey}` } });
      return { ok: r.ok, detail: r.ok ? "مفتاح Resend صالح" : `Resend ${r.status}` };
    }
    if (s.provider === "brevo") {
      const r = await fetch("https://api.brevo.com/v3/account", { headers: { "api-key": s.apiKey! } });
      return { ok: r.ok, detail: r.ok ? "مفتاح Brevo صالح" : `Brevo ${r.status}` };
    }
    return { ok: false, detail: "مزوّد غير معروف" };
  } catch (err: any) {
    return { ok: false, detail: String(err?.message ?? err).slice(0, 200) };
  }
}

/** The RFC Message-ID for a message token, stable and ours. */
export function messageIdFor(token: string, fromEmail: string): string {
  const domain = fromEmail.split("@")[1] ?? "localhost";
  return `<${token}@${domain}>`;
}
