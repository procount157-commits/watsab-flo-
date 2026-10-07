// ── ماجد's round: the list and the sender, looked after ──────────
// The tools to keep email arriving were all here — a mail-server check for
// every domain, a list cleaner, a risk ranking, the sending domain's three
// DNS records, a diagnosis of why nothing goes — and every one of them waited
// for the owner to press its button. The owner did not know they existed, and
// the team that was meant to use them did not. What showed of ماجد was one
// line, repeated every quarter of an hour: "17% bounced — the list needs
// cleaning". He said it 22 times and cleaned nothing.
//
// Now he does the work, every six hours and after every import:
//
//   1. checks the mail server of every domain not yet checked;
//   2. takes out of every list whoever cannot or must not be written to
//      (bounced, unsubscribed, dead domain — the riskiest too, if the account
//      skips risky addresses), and holds their queued messages;
//   3. finds lists that are the same people twice, and says which;
//   4. reads the sending domain's SPF, DKIM and DMARC, and says exactly what
//      to add when one is missing;
//   5. asks the diagnosis whether anything stops sending, and says what;
//   6. writes one report: what he found, what he fixed, what needs the owner.
//
// Everything he does goes in the team's feed. What needs the owner's hands
// — a DNS record, a duplicate list — goes to them once, not every round.

import { and, desc, eq, sql } from "drizzle-orm";
import { db, emailAgentActivityTable, emailListsTable } from "@workspace/db";
import { verifyDomains, cleanList, holdRiskyQueued, hygieneReport } from "./hygiene";
import { checkDomain } from "./dns";
import { diagnose } from "./diagnose";
import { getSettings } from "./service";
import { isConfigured } from "./provider";
import { activity, onDuty } from "./team";
import { logger } from "../logger";

const n = (x: number) => x.toLocaleString("en");

/** Has ماجد said exactly this in the last `hours`? Then he does not say it again. */
async function saidRecently(userId: number, text: string, hours: number): Promise<boolean> {
  const [r] = await db.select({ id: emailAgentActivityTable.id }).from(emailAgentActivityTable)
    .where(and(eq(emailAgentActivityTable.userId, userId), eq(emailAgentActivityTable.role, "email_guard"), eq(emailAgentActivityTable.text, text.slice(0, 2000)),
      sql`${emailAgentActivityTable.createdAt} > now() - make_interval(hours => ${hours})`))
    .limit(1);
  return !!r;
}

async function sayOnce(userId: number, action: string, text: string, hours = 24, ref: Record<string, unknown> | null = null) {
  if (await saidRecently(userId, text, hours)) return false;
  await activity(userId, "email_guard", action, text, ref);
  return true;
}

/** Lists that hold exactly the same people. Pure over the rows. */
export function sameLists(rows: Array<{ id: number; name: string; n: number; sig: string }>): Array<[{ id: number; name: string; n: number }, { id: number; name: string; n: number }]> {
  const out: Array<[any, any]> = [];
  const seen = new Map<string, { id: number; name: string; n: number }>();
  for (const r of rows) {
    if (!r.n) continue;
    const k = `${r.n}:${r.sig}`;
    const first = seen.get(k);
    if (first) out.push([first, { id: r.id, name: r.name, n: r.n }]); else seen.set(k, { id: r.id, name: r.name, n: r.n });
  }
  return out;
}

export async function caretakerRound(userId: number) {
  const s = await getSettings(userId);
  if (!isConfigured(s)) return { ran: false };
  if (!(await onDuty(userId, "email_guard"))) return { ran: false };
  const fixed: string[] = [], owner: string[] = [];

  // 1. Mail servers nobody has asked about yet.
  const v = await verifyDomains(userId, undefined, { maxDomains: 600 }).catch(() => null);
  if (v?.checked) fixed.push(`فحصت خادم البريد لـ ${n(v.checked)} نطاق${v.dead ? ` — ${n(v.dead)} بلا خادم بريد، لن يُراسَل من فيها` : ""}`);

  // 2. Every list, cleaned.
  const lists = await db.select({ id: emailListsTable.id, name: emailListsTable.name }).from(emailListsTable)
    .where(and(eq(emailListsTable.userId, userId), sql`${emailListsTable.parentListId} is null`));
  let removed = 0;
  for (const l of lists) {
    const r = await cleanList(userId, l.id, { risky: !!s!.skipRisky }).catch(() => null);
    if (r?.removed) { removed += r.removed; fixed.push(`نظّفت «${l.name}»: أخرجت ${n(r.removed)} لا يصلحون للمراسلة (مرتدّ، ألغى، أو نطاق ميت)${s!.skipRisky ? " أو عالي الخطورة" : ""}`); }
  }
  const held = await holdRiskyQueued(userId).catch(() => null);
  if (held?.held) fixed.push(`أمسكت ${n(held.held)} رسالة في الطابور لعناوين عالية الخطورة`);

  // 3. The same people twice.
  const sig = await db.execute<{ id: number; name: string; n: number; sig: string }>(sql`
    SELECT l.id, l.name, count(m.contact_id)::int AS n, md5(coalesce(string_agg(m.contact_id::text, ',' ORDER BY m.contact_id), '')) AS sig
    FROM email_lists l LEFT JOIN email_list_members m ON m.list_id = l.id
    WHERE l.user_id = ${userId} AND l.parent_list_id IS NULL GROUP BY l.id, l.name ORDER BY l.id`);
  for (const [a, b] of sameLists(sig.rows.map((r) => ({ ...r, n: Number(r.n) })))) {
    owner.push(`القائمتان «${a.name}» و«${b.name}» فيهما نفس الـ ${n(a.n)} عنوان بالضبط — احذف إحداهما (الفريق لا يراسل أحداً مرتين، لكن التكرار يربك التقارير).`);
  }

  // 4. The sending domain's records.
  if (s!.fromEmail) {
    const d = await checkDomain(s!.fromEmail).catch(() => null);
    if (d) {
      if (!d.spf.ok) owner.push(`سجل SPF لنطاق ${d.domain}: ${d.spf.note}`);
      if (!d.dkim.found) owner.push(`توقيع DKIM لنطاق ${d.domain}: ${d.dkim.note}`);
      if (!d.dmarc.ok) owner.push(`سجل DMARC لنطاق ${d.domain}: ${d.dmarc.note}`);
    }
  }

  // 5. Anything that stops sending.
  const dx = await diagnose(userId).catch(() => null);
  for (const c of dx?.checks ?? []) if (c.state === "fail") owner.push(`${c.title}: ${c.detail}${c.fix ? ` — ${c.fix}` : ""}`);

  // 6. The report.
  const health = await hygieneReport(userId).catch(() => null);
  const summary = health
    ? `حالة العناوين: ${n(health.active)} صالح، ${n(health.bounced)} مرتد، ${n(health.unsubscribed)} ألغى، ${n(health.deadDomain)} نطاق ميت، ${n(health.unverified)} لم يُفحص — الخطورة: ${n(health.risk.low)} منخفضة · ${n(health.risk.medium)} متوسطة · ${n(health.risk.high)} عالية.`
    : "";
  if (fixed.length) await activity(userId, "email_guard", "clean", [...fixed, summary].filter(Boolean).join("\n"), { removed, held: held?.held ?? 0 });
  else if (summary) await sayOnce(userId, "check", `راجعت القوائم والمُرسِل: لا شيء يحتاج تنظيفاً. ${summary}`, 24);
  for (const o of owner) await sayOnce(userId, "needs_owner", `يحتاج تدخلك: ${o}`, 72);

  logger.info({ userId, fixed: fixed.length, owner: owner.length, removed }, "جولة ماجد انتهت");
  return { ran: true, fixed, owner, removed };
}

let timer: NodeJS.Timeout | null = null;
export function startCaretaker() {
  if (timer) return;
  const run = async () => {
    const users = await db.execute<{ user_id: number }>(sql`SELECT user_id FROM email_settings`).catch(() => ({ rows: [] as Array<{ user_id: number }> }));
    for (const u of users.rows) await caretakerRound(Number(u.user_id)).catch((err) => logger.warn({ userId: u.user_id, err: String(err?.message ?? err) }, "جولة ماجد فشلت"));
  };
  setTimeout(() => void run(), 5 * 60_000).unref();
  timer = setInterval(() => void run(), 6 * 3_600_000);
  timer.unref();
}

/** The last of what ماجد reported, newest first — for the dashboard. */
export async function caretakerFeed(userId: number, limit = 10) {
  return db.select().from(emailAgentActivityTable)
    .where(and(eq(emailAgentActivityTable.userId, userId), eq(emailAgentActivityTable.role, "email_guard")))
    .orderBy(desc(emailAgentActivityTable.createdAt)).limit(limit);
}
