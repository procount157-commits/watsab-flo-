// ── Gmail in one step ─────────────────────────────────────────────
// The owner of a shop (2026-11-02): «ما أقدر أتحكم في الإيميل ماركتينج… لما
// أجي أعمل حملة جديدة بيظهر لي مشاكل». The settings page asks for an SMTP
// host, a port, an IMAP host and twenty brand fields — the Pro Count page.
// Here the owner gives a Gmail address and its app password; everything
// else comes from what the account already knows: the business profile,
// the shop's site and phone, Arabic for a shop that speaks Arabic, and the
// caps Gmail itself allows. The credentials are tried before anything is
// saved, and a refusal is explained in words the owner can act on.

import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";
import { getSettings } from "./service";
import { verifySettings } from "./provider";
import { STORE_URL } from "../catalog/floret";

export const GMAIL = { smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecure: true, imapHost: "imap.gmail.com", imapPort: 993 } as const;
/** Gmail allows about 500 a day from a personal account; we stay well under, and warm-up starts lower still. */
export const GMAIL_CAPS = { hourlyCap: 40, dailyCap: 400 } as const;

type Profile = { name: string | null; vertical: string | null; dialect: string | null; catalog_source: string | null; description: string | null };

/** What a shop's mail looks like, from what the account already knows. Pure. */
export function shopDefaults(p: Profile | null, phone: string | null) {
  const shop = p?.catalog_source === "floret" || p?.vertical === "jewelry";
  const arabic = !!p?.dialect && p.dialect !== "en";
  const name = (p?.name ?? "").split("(")[0]!.trim() || null;
  const digits = (phone ?? "").replace(/\D/g, "");
  const intl = digits.startsWith("05") && digits.length === 10 ? `971${digits.slice(1)}` : digits;
  return {
    fromName: name,
    brandName: name,
    brandTagline: shop ? "ذهب عيار ٢١ — توصيل لكل الإمارات" : null,
    website: p?.catalog_source === "floret" ? STORE_URL.replace(/^https?:\/\//, "") : null,
    logoUrl: p?.catalog_source === "floret" ? `${STORE_URL}/apple-icon.png` : null,
    phone: intl.length >= 11 ? `+${intl}` : null,
    brandColor: shop ? "#1c1712" : null,
    brandAccent: shop ? "#b8902f" : null,
    defaultLanguage: arabic || shop ? "ar" : "en",
    followIntensity: shop ? "normal" : "intense",
  };
}

/** Gmail's refusal, said so the owner knows what to do next. Pure. */
export function explainGmailError(detail: string): string {
  if (/535|5\.7\.8|Username and Password not accepted|BadCredentials|Invalid login/i.test(detail))
    return "Gmail رفض الدخول: استخدم «كلمة مرور التطبيق» (16 حرفاً) لا كلمة مرور الحساب، وتأكد أن التحقق بخطوتين مفعّل على الحساب.";
  if (/534|WebLoginRequired|application-specific/i.test(detail))
    return "Gmail يطلب كلمة مرور تطبيق: فعّل التحقق بخطوتين ثم أنشئ كلمة مرور تطبيق من myaccount.google.com/apppasswords.";
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|timeout/i.test(detail)) return "تعذّر الوصول إلى خادم Gmail الآن — أعد المحاولة بعد دقيقة.";
  return `Gmail رفض: ${detail}`;
}

export async function quickGmail(userId: number, b: { email: string; appPassword: string; fromName?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = String(b.email ?? "").trim().toLowerCase();
  const pass = String(b.appPassword ?? "").replace(/\s+/g, "");
  if (!/^[^@\s]+@(gmail|googlemail)\.com$/.test(email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: "اكتب بريد Gmail صحيحاً" };
  if (pass.length < 8) return { ok: false, error: "كلمة مرور التطبيق قصيرة — هي 16 حرفاً من صفحة كلمات مرور التطبيقات في Google" };

  const [p] = (await db.execute<Profile>(sql`SELECT name, vertical, dialect, catalog_source, description FROM business_profile WHERE user_id = ${userId}`)).rows;
  const [u] = (await db.execute<{ phone: string | null }>(sql`SELECT phone FROM users WHERE id = ${userId}`)).rows;
  const d = shopDefaults(p ?? null, u?.phone ?? null);
  const cur = await getSettings(userId);

  const values = {
    userId, provider: "smtp", ...GMAIL, smtpUser: email, smtpPass: pass, imapUser: email, imapPass: pass,
    fromEmail: email, fromName: (b.fromName ?? "").trim() || cur?.fromName || d.fromName, replyTo: cur?.replyTo ?? null,
    layout: cur?.layout ?? "branded",
    brandName: cur?.brandName ?? d.brandName, brandTagline: cur?.brandTagline ?? d.brandTagline,
    brandColor: cur?.brandColor ?? d.brandColor, brandAccent: cur?.brandAccent ?? d.brandAccent,
    logoUrl: cur?.logoUrl ?? d.logoUrl, website: cur?.website ?? d.website, phone: cur?.phone ?? d.phone,
    defaultLanguage: cur ? cur.defaultLanguage : d.defaultLanguage,
    followIntensity: cur ? cur.followIntensity : d.followIntensity,
    hourlyCap: Math.min(cur?.hourlyCap ?? GMAIL_CAPS.hourlyCap, GMAIL_CAPS.hourlyCap),
    dailyCap: Math.min(cur?.dailyCap ?? GMAIL_CAPS.dailyCap, GMAIL_CAPS.dailyCap),
    tracking: cur?.tracking ?? true, warmup: cur?.warmup ?? true,
    inboundToken: cur?.inboundToken ?? randomBytes(18).toString("base64url"),
    updatedAt: new Date(),
  };
  // Tried before it is kept: a wrong app password saved is a sender that fails at the first campaign.
  const v = await verifySettings({ ...(cur ?? {}), ...values } as any);
  if (!v.ok) return { ok: false, error: explainGmailError(v.detail) };
  await db.insert(emailSettingsTable).values(values as any).onConflictDoUpdate({ target: emailSettingsTable.userId, set: values as any });
  return { ok: true };
}
