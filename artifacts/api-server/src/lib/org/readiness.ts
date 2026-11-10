// ── الجاهزية ──────────────────────────────────────────────────────
// قائمةٌ حية لكل حساب: هل يعمل هذا الخط من أوله إلى آخره؟ READY لا تُقال إلا لما اختُبر فعلاً:
// اتصال نجح الآن وعملٌ حقيقي خرج منه في آخر ٣٠ يوماً. ما اكتمل ضبطه ولم يُجرَّب: NEEDS_TEST.
//
// الفحص الحي يفتح اتصال SMTP وIMAP ويغلقه، ولا يرسل شيئاً. لا يفتح جلسة واتساب ولا يمسّ
// شيئاً: يقرأ الحالة. يكتب النتيجة في integration_health ليقرأها العرض العام بلا اتصال.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ImapFlow } from "imapflow";
import { logger } from "../logger";
import { isConfigured, verifySettings } from "../email/provider";
import { getSettings } from "../email/service";
import { asSettings, capacityToday } from "../email/senders";
import { isHalted } from "./controls";
import { queueReview } from "./queue";
import { ensureOrgTables } from "./schema";

/** OPTIONAL: أطفأه صاحب العمل عمداً (رد آلي متوقف). ليس عطلاً: لا يُحسب محظوراً ولا يمنع READY. */
export type ReadyStatus = "READY" | "BLOCKED" | "NEEDS_TEST" | "OPTIONAL";
export interface ReadyItem { id: string; channel: string; title: string; status: ReadyStatus; ok: boolean; detail: string; action: string | null; goto: string | null }
export interface ReadinessReport { status: ReadyStatus; checkedAt: string; verified: boolean; items: ReadyItem[] }

const item = (id: string, channel: string, title: string, status: ReadyStatus, detail: string, action: string | null = null, goto: string | null = null): ReadyItem =>
  ({ id, channel, title, status, ok: status === "READY" || status === "OPTIONAL", detail, action, goto });

/** الكل من أجزائه: محظورٌ واحد يكفي، ثم ما لم يُختبر، وREADY فقط إن كانت كلها READY. Pure. */
export function overallStatus(items: Array<{ status: ReadyStatus }>): ReadyStatus {
  const counted = items.filter((i) => i.status !== "OPTIONAL");
  if (!counted.length || counted.some((i) => i.status === "BLOCKED")) return "BLOCKED";
  return counted.some((i) => i.status === "NEEDS_TEST") ? "NEEDS_TEST" : "READY";
}

/** حالة ما له اتصال: لا ضبط محظور، ولا فحص لم يُختبر، ولا عمل حقيقي لم يُختبر أيضاً. Pure. */
export function connectionStatus(c: { configured: boolean; checked: boolean; ok?: boolean; provenWork: boolean }): ReadyStatus {
  if (!c.configured) return "BLOCKED";
  if (!c.checked) return "NEEDS_TEST";
  if (!c.ok) return "BLOCKED";
  return c.provenWork ? "READY" : "NEEDS_TEST";
}

export interface ReadinessDeps {
  verifySmtp?: (s: any) => Promise<{ ok: boolean; detail: string }>;
  imapLogin?: (c: { host: string; port: number; user: string; pass: string }) => Promise<{ ok: boolean; detail: string }>;
  waState?: (userId: number) => Promise<{ connected: boolean; status: string } | null>;
}

const IMAP_TIMEOUT_MS = 12_000;
const SENDER_VERIFY_CAP = 8;

/** دخولٌ وخروج، ولا قراءة ولا قفل صندوق. */
export async function imapLogin(c: { host: string; port: number; user: string; pass: string }): Promise<{ ok: boolean; detail: string }> {
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass }, logger: false, socketTimeout: IMAP_TIMEOUT_MS, greetingTimeout: IMAP_TIMEOUT_MS, connectionTimeout: IMAP_TIMEOUT_MS } as any);
  client.on("error", () => {});
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return { ok: true, detail: "دخول IMAP ناجح" };
  } catch (err: any) {
    client.close?.();
    return { ok: false, detail: String(err?.responseText ?? err?.message ?? err).slice(0, 200) };
  }
}

async function liveWaState(userId: number) {
  const { waManager } = await import("../whatsapp");
  return waManager.allStates().find((x) => x.userId === userId) ?? null;
}

const one = async (q: any) => (await db.execute<any>(q)).rows[0] ?? {};
const num = (v: unknown) => Number(v ?? 0);

/** الفحص كله. verify=false: بلا أي اتصال خارجي، وما يحتاجه NEEDS_TEST. */
export async function readiness(userId: number, o: { verify?: boolean; deps?: ReadinessDeps } = {}): Promise<ReadinessReport> {
  await ensureOrgTables();
  const verify = !!o.verify;
  const items: ReadyItem[] = [];
  const s = await getSettings(userId);
  const configured = isConfigured(s);

  // ── البريد ──
  const proof = await one(sql`SELECT count(*) FILTER (WHERE sent_at > now() - interval '30 days')::int AS sent, count(*) FILTER (WHERE status = 'queued')::int AS queued FROM email_messages WHERE user_id = ${userId}`);
  const provenMail = num(proof.sent) > 0;
  let smtp: { ok: boolean; detail: string } | null = null;
  if (configured && verify) smtp = await (o.deps?.verifySmtp ?? verifySettings)(s!).catch((e: any) => ({ ok: false, detail: String(e?.message ?? e).slice(0, 200) }));
  const smtpStatus = connectionStatus({ configured, checked: !!smtp, ok: smtp?.ok, provenWork: provenMail });
  items.push(item("email.smtp", "email", "إرسال البريد", smtpStatus,
    !configured ? "إعدادات الإرسال ناقصة" : !smtp ? "لم يُفحص الاتصال في هذا الطلب" : !smtp.ok ? `فشل الاتصال: ${smtp.detail}` : provenMail ? `${smtp.detail}، و${num(proof.sent)} رسالة خرجت في ٣٠ يوماً` : `${smtp.detail}، ولم تخرج رسالة حقيقية منذ ٣٠ يوماً`,
    smtpStatus === "READY" ? null : !configured ? "اضبط SMTP أو مفتاح المزوّد والعنوان المرسل" : "افحص الاتصال أو أرسل رسالة اختبار إلى صندوقك", "/email/settings"));

  const imapUser = s?.imapUser?.trim() || s?.smtpUser, imapPass = s?.imapPass || s?.smtpPass;
  const imapReady = !!(s?.imapHost && imapUser && imapPass);
  let imap: { ok: boolean; detail: string } | null = null;
  if (imapReady && verify) imap = await (o.deps?.imapLogin ?? imapLogin)({ host: s!.imapHost!, port: s!.imapPort ?? 993, user: imapUser!, pass: imapPass! }).catch((e: any) => ({ ok: false, detail: String(e?.message ?? e).slice(0, 200) }));
  const inbound = await one(sql`SELECT count(*) FILTER (WHERE received_at > now() - interval '30 days')::int AS n FROM email_inbound WHERE user_id = ${userId}`);
  const imapStatus = connectionStatus({ configured: imapReady, checked: !!imap, ok: imap?.ok, provenWork: num(inbound.n) > 0 });
  items.push(item("email.imap", "email", "قراءة الردود", imapStatus,
    !imapReady ? "IMAP غير مضبوط: الردود لا تُقرأ" : !imap ? "لم يُفحص الدخول في هذا الطلب" : !imap.ok ? `فشل الدخول: ${imap.detail}` : `${imap.detail}، و${num(inbound.n)} رسالة وردت في ٣٠ يوماً`,
    imapStatus === "READY" ? null : !imapReady ? "اضبط IMAP في إعدادات البريد" : "افحص الدخول ثم تأكد أن رداً يصل", "/email/settings"));

  const boxes = await one(sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active' AND (held_until IS NULL OR held_until <= now()))::int AS live, count(*) FILTER (WHERE status = 'broken')::int AS broken, count(*) FILTER (WHERE held_until > now())::int AS held FROM email_senders WHERE user_id = ${userId}`);
  // الصناديق الإضافية: اتصال كلٍّ منها حين يُطلب الفحص، بسقف، ولا إرسال.
  const senders = verify && s ? (await db.execute<any>(sql`SELECT * FROM email_senders WHERE user_id = ${userId} AND status = 'active' ORDER BY id LIMIT ${SENDER_VERIFY_CAP}`)).rows : [];
  const dead: string[] = [];
  for (const b of senders) {
    const r = await (o.deps?.verifySmtp ?? verifySettings)(asSettings(s!, { smtpHost: b.smtp_host, smtpPort: b.smtp_port, smtpSecure: b.smtp_secure, smtpUser: b.smtp_user, smtpPass: b.smtp_pass, fromEmail: b.from_email, fromName: b.from_name } as any)).catch((e: any) => ({ ok: false, detail: String(e?.message ?? e) }));
    if (!r.ok) dead.push(`${b.from_email}: ${r.detail.slice(0, 80)}`);
  }
  const boxesBad = num(boxes.broken) > 0 || dead.length > 0;
  items.push(item("email.mailboxes", "email", "الصناديق", !configured && !num(boxes.live) ? "BLOCKED" : boxesBad ? "BLOCKED" : provenMail && (!num(boxes.live) || senders.length) ? "READY" : "NEEDS_TEST",
    `إضافية ${num(boxes.total)}: تعمل ${num(boxes.live)}، معطّلة ${num(boxes.broken)}، ممهَلة ${num(boxes.held)}.${verify ? ` فُحص اتصال ${senders.length}${dead.length ? `، وفشل: ${dead.join(" · ")}` : ""}.` : ""}`, boxesBad ? "أصلح الصناديق المعطّلة أو احذفها" : null, "/email/senders"));

  const cap = s ? await capacityToday(userId, s.dailyCap).catch(() => null) : null;
  const [desk] = (await db.execute<any>(sql`SELECT per_day FROM accounts_desk_settings WHERE user_id = ${userId} AND enabled`).catch(() => ({ rows: [] as any[] }))).rows;
  const today = await one(sql`SELECT count(*)::int AS n FROM email_messages WHERE user_id = ${userId} AND sent_at >= (date_trunc('day', now() at time zone 'Asia/Dubai') at time zone 'Asia/Dubai')`);
  const intent = num(proof.queued) + num(desk?.per_day);
  const left = cap ? Math.max(0, cap.total - num(today.n)) : 0;
  items.push(item("email.quota", "email", "السقف مقابل المطلوب", !cap || cap.total <= 0 ? "BLOCKED" : provenMail ? "READY" : "NEEDS_TEST",
    cap ? `سقف اليوم ${cap.total} عبر ${cap.senders} صندوق، خرج ${num(today.n)}، بقي ${left}. في الطابور ${num(proof.queued)}، والمكتب ${num(desk?.per_day)} في اليوم.${intent > left ? " المطلوب أكبر من المتبقي: يمتد إلى الأيام التالية." : ""}` : "لا إعدادات بريد",
    !cap ? "اضبط البريد أولاً" : null, "/email/settings"));

  const q = await queueReview(userId);
  const oldest = q.age.oldest ? new Date(q.age.oldest as string) : null;
  items.push(item("email.queue", "email", "عمر الطابور", q.heldStale > 0 ? "BLOCKED" : provenMail || !q.total ? "READY" : "NEEDS_TEST",
    `في الطابور ${q.total}، أقدمها ${oldest ? oldest.toISOString().slice(0, 10) : "لا شيء"}، ممسوك ${q.heldStale} أقدم من أسبوع.`, q.heldStale > 0 ? "راجع الطابور وقرّر الإفراج" : null, "/org"));

  const lists = await one(sql`SELECT (SELECT count(*)::int FROM email_lists WHERE user_id = ${userId}) AS lists, count(*)::int AS contacts, count(*) FILTER (WHERE status = 'active')::int AS active,
    count(*) FILTER (WHERE status IN ('bounced','invalid'))::int AS dead, count(*) FILTER (WHERE status IN ('unsubscribed','complained'))::int AS stopped FROM email_contacts WHERE user_id = ${userId}`);
  items.push(item("email.lists", "email", "قوائم البريد", num(lists.active) ? "READY" : "BLOCKED",
    `${num(lists.lists)} قائمة، ${num(lists.contacts)} جهة: صالح ${num(lists.active)}، مرتد ${num(lists.dead)}، موقف ${num(lists.stopped)}.`, num(lists.active) ? null : "ارفع قائمة جهات صالحة", "/email/lists"));
  items.push(item("email.auto_reply", "email", "الرد الآلي على البريد", s?.autoReply ? (provenMail ? "READY" : "NEEDS_TEST") : "OPTIONAL",
    s?.autoReply ? `مفعّل، بعد ${s.autoReplyDelayMin} دقيقة` : "متوقف عمداً: الردود تنتظر شخصاً", s?.autoReply ? null : "شغّله من إعدادات البريد إن أردته", "/email/settings"));

  // ── واتساب والفريق ──
  const profile = await one(sql`SELECT auto_reply, smart_followup, team_paused FROM business_profile WHERE user_id = ${userId}`);
  const wa = await (o.deps?.waState ?? liveWaState)(userId).catch(() => null);
  const waProof = await one(sql`SELECT count(*)::int AS n FROM wa_firewall_sends WHERE user_id = ${userId} AND at > now() - interval '30 days'`);
  items.push(item("whatsapp.connection", "whatsapp", "اتصال واتساب", !wa?.connected ? "BLOCKED" : num(waProof.n) ? "READY" : "NEEDS_TEST",
    !wa ? "لا جلسة لهذا الحساب" : wa.connected ? `متصل، و${num(waProof.n)} رسالة خرجت في ٣٠ يوماً` : `غير متصل: ${wa.status}`, !wa?.connected ? "اربط الرقم من صفحة واتساب" : num(waProof.n) ? null : "أرسل رسالة اختبار", "/connect"));
  // خرج واتساب ومُسحت الجلسة (auto_repair في whatsapp.ts) ولم يتصل بعدها: يحتاج مسحاً جديداً.
  const loggedOut = await waLoggedOut(userId).catch(() => null);
  if (loggedOut) items.push(item("whatsapp.logged_out", "whatsapp", "خروج واتساب", "BLOCKED", `خرج واتساب ${loggedOut.toISOString().slice(0, 16).replace("T", " ")} ومُسحت الجلسة: لا يخرج شيء ولا يصل.`, "امسح رمز QR من صفحة الربط", "/connect"));
  items.push(item("whatsapp.auto_reply", "whatsapp", "الرد الآلي على واتساب", profile.auto_reply ? (num(waProof.n) ? "READY" : "NEEDS_TEST") : "OPTIONAL", profile.auto_reply ? "مفعّل" : "متوقف عمداً: الردود تنتظر شخصاً", profile.auto_reply ? null : "شغّله من ملف العمل إن أردته", "/knowledge"));
  const fu = String(profile.smart_followup ?? "dry");
  items.push(item("whatsapp.followup_mode", "whatsapp", "وضع المتابعة", fu === "off" ? "BLOCKED" : fu === "live" ? (num(waProof.n) ? "READY" : "NEEDS_TEST") : "NEEDS_TEST",
    `الوضع الحالي ${fu}${fu === "dry" ? ": يكتب ولا يرسل" : fu === "approve" ? ": ينتظر موافقتك" : ""}.`, fu === "live" ? null : "قرارك أنت: غيّر الوضع من صفحة المتابعة بعد مراجعة ما كتبه", "/follow-ups"));
  items.push(item("org.team_paused", "org", "إيقاف الفريق", profile.team_paused ? "BLOCKED" : "READY", profile.team_paused ? "الفريق كله موقوف" : "الفريق غير موقوف", profile.team_paused ? "ارفع الإيقاف من صفحة الفريق" : null, "/team"));
  const halt = await isHalted({ userId });
  items.push(item("org.controls", "org", "مفاتيح الإيقاف", halt.halted ? "BLOCKED" : "READY", halt.halted ? `موقوف (${halt.scope}): ${halt.reason ?? ""}` : "لا مفتاح مضغوط على الحساب", halt.halted ? "راجع المفاتيح" : null, "/org"));
  const staff = (await db.execute<any>(sql`SELECT role, is_active FROM bot_employees WHERE user_id = ${userId} AND role IN ('sales','support')`)).rows;
  const activeStaff = staff.filter((x: any) => x.is_active).map((x: any) => x.role);
  items.push(item("org.sales_support", "org", "موظفو المبيعات والدعم", activeStaff.length === 2 ? "READY" : "BLOCKED", `نشطون: ${activeStaff.join("، ") || "لا أحد"}.`, activeStaff.length === 2 ? null : "شغّل المبيعات والدعم من صفحة الفريق", "/team"));
  const health = await one(sql`SELECT count(*)::int AS n, max(last_ok_at) AS last_ok FROM llm_health`).catch(() => ({ n: 0 }));
  const llmOk = health.last_ok && Date.now() - new Date(health.last_ok).getTime() < 86_400_000;
  items.push(item("org.llm", "org", "النموذج", llmOk ? "READY" : "NEEDS_TEST", llmOk ? `آخر إجابة ناجحة ${new Date(health.last_ok).toISOString()}` : "لا إجابة ناجحة مسجلة في آخر ٢٤ ساعة", llmOk ? null : "تحقق من مفاتيح المزوّد", "/settings"));

  // ── السوشيال ──
  const { hasDriver } = await import("../social/drivers");
  const social = (await db.execute<any>(sql`SELECT platform, state, state_note, dry_run, autopilot, mode, (SELECT count(*)::int FROM social_actions x WHERE x.user_id = a.user_id AND x.platform = a.platform AND x.ok AND x.created_at > now() - interval '30 days') AS acts FROM social_accounts a WHERE user_id = ${userId}`)).rows;
  for (const p of ["instagram", "tiktok"] as const) {
    const a = social.find((x: any) => x.platform === p);
    const ar = p === "instagram" ? "إنستغرام" : "تيك توك";
    if (!hasDriver(p)) { items.push(item(`${p}.account`, p, ar, "BLOCKED", "لا مشغّل", "لا يوجد ما يُفعل من هنا", null)); continue; }
    if (!a) { items.push(item(`${p}.account`, p, ar, "BLOCKED", "لا حساب مربوط", "اربط الحساب من صفحته", `/${p}`)); continue; }
    if (a.state !== "logged_in") { items.push(item(`${p}.account`, p, ar, "BLOCKED", `الحالة ${a.state}${a.state_note ? `: ${String(a.state_note).slice(0, 160)}` : ""}`, "سجّل الدخول من صفحته", `/${p}`)); continue; }
    items.push(item(`${p}.account`, p, ar, !a.dry_run && num(a.acts) ? "READY" : "NEEDS_TEST",
      `مسجّل الدخول، dry_run=${a.dry_run}، الطيار ${a.autopilot ? "يعمل" : "متوقف"}، ${num(a.acts)} فعلاً ناجحاً في ٣٠ يوماً.`, a.dry_run ? "قرارك أنت: جرّب بلا dry_run بعد مراجعة المسودات" : null, `/${p}`));
  }
  items.push(item("linkedin.readiness", "linkedin", "لينكدإن", "BLOCKED", "لا مشغّل، ولا أتمتة أبداً: الفريق يكتب الملاحظة وصاحب العمل يرسلها بيده.", "أرسل الملاحظات يدوياً من مكتب الحسابات", "/email/accounts"));

  const report: ReadinessReport = { status: overallStatus(items), checkedAt: new Date().toISOString(), verified: verify, items };
  await writeHealth(userId, items).catch((err) => logger.warn({ userId, err: String(err?.message ?? err).slice(0, 160) }, "صحة التكامل لم تُكتب"));
  return report;
}

/** متى خرج واتساب ولم يعد: آخر حدثٍ من الثلاثة auto_repair. null = متصل أو لم يخرج. */
export async function waLoggedOut(userId: number): Promise<Date | null> {
  const [e] = (await db.execute<any>(sql`SELECT event, created_at FROM wa_session_events WHERE user_id = ${userId} AND event IN ('auto_repair','connected','logged_out') ORDER BY id DESC LIMIT 1`)).rows;
  return e?.event === "auto_repair" ? new Date(e.created_at) : null;
}

/** آخر ما عُرف عن كل تكامل. فحصٌ بلا اتصال لا يمحو نتيجة فحصٍ حقيقي سابقة. */
async function writeHealth(userId: number, items: ReadyItem[]): Promise<void> {
  const map: Record<string, string> = { "email.smtp": "email_smtp", "email.imap": "email_imap", "whatsapp.connection": "whatsapp", "instagram.account": "instagram", "tiktok.account": "tiktok", "linkedin.readiness": "linkedin", "org.llm": "llm" };
  for (const i of items) {
    const name = map[i.id];
    if (!name) continue;
    const status = i.status === "READY" ? "ok" : i.status === "BLOCKED" ? "down" : "unknown";
    await db.execute(sql`INSERT INTO integration_health (user_id, integration, status, detail, last_ok_at, last_fail_at, checked_at)
      VALUES (${userId}, ${name}, ${status}, ${i.detail.slice(0, 500)}, ${status === "ok" ? sql`now()` : sql`NULL::timestamptz`}, ${status === "down" ? sql`now()` : sql`NULL::timestamptz`}, now())
      ON CONFLICT (user_id, integration) DO UPDATE SET
        status = CASE WHEN EXCLUDED.status = 'unknown' AND integration_health.status = 'ok' THEN integration_health.status ELSE EXCLUDED.status END,
        detail = CASE WHEN EXCLUDED.status = 'unknown' AND integration_health.status = 'ok' THEN integration_health.detail ELSE EXCLUDED.detail END,
        last_ok_at = COALESCE(EXCLUDED.last_ok_at, integration_health.last_ok_at), last_fail_at = COALESCE(EXCLUDED.last_fail_at, integration_health.last_fail_at), checked_at = now()`);
  }
}
