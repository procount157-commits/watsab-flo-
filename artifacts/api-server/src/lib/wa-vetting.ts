// ── سيف، فاحص الأرقام ─────────────────────────────────────────────
// صاحب العمل (٢٠ أكتوبر): «موظف جديد: الرقم قبل ما يضعه في القائمة بتاعة
// الإرسال لازم يتأكد من كل رقم يقيّمه — يشيك هل عليه واتساب ولا لا — يحلل
// الرقم بطريقة متقدمة قبل ما نرسله له».
//
// سيف يحكم على كل رقمٍ قبل أن تصله رسالة حملة، وحكمه ثلاثة:
//   ready      يُرسَل إليه.
//   hold       ليس الآن: لم يُتحقق منه، أو دولة أخرى، أو قال «غير مهتم»، أو
//              لا يستلم، أو راسلناه خلال يوم. يُعاد فحصه عند بدء الحملة.
//   rejected   لا يُرسَل: ليس رقم جوال، أو وهمي، أو مكرر، أو في القائمة
//              السوداء، أو ليس على واتساب.
// ما يقرؤه: صيغة الرقم ودولته (phone-import)، نمطه، تكراره في القائمة،
// قائمة الإيقاف، أزرار «غير مهتم»، سجل التسليم، آخر مراسلة، ما كتبه هو لنا،
// وكلمة واتساب نفسه (onWhatsApp) — بدفعاتٍ متباعدة وبسقفٍ في الساعة، لأن
// الفحص الكثيف إشارةٌ بذاته. لا استعلامات أخرى عن الرقم (صورة، ملف تجاري).
// كل ما يُقرّر هنا نقيٌّ ليُختبر (judge)؛ القراءة والكتابة حولها.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, contactsTable, contactGroupsTable, botEmployeesTable, contactVettingRunsTable } from "@workspace/db";
import { normalizePhone } from "./phone-import";
import { checkNumbers, getStatus } from "./whatsapp";
import { key9 } from "./wa-firewall-rules";
import { logger } from "./logger";

export const VETTER_ROLE = "vetter";
export const VETTER = {
  name: "سيف", role: VETTER_ROLE, kind: "internal", title: "فاحص الأرقام", avatar: "🛂",
  persona: "فاحص أرقام خليجي، دقيق ولا يستعجل. كيف يعمل: لا يدخل رقمٌ قائمة الإرسال قبل أن يمرّ عليه: صيغته ودولته، وهل هو جوال، وهل هو وهمي أو مكرر، وهل طلب صاحبه الإيقاف من قبل أو قال «غير مهتم»، وهل استلم رسائلنا السابقة، وهل كتب لنا، وهل هو على واتساب أصلاً. يسأل واتساب عن الأرقام على مهل، دفعةً بعد دفعة، لأن الفحص الكثيف إشارةٌ بذاته. حكمه ثلاثة: جاهز، أو ليس الآن مع السبب، أو مرفوض مع السبب. ما لا يفعله: لا يُمرّر رقماً لم يتحقق منه على أنه جاهز، ولا يعيد من قال لا، ولا يحذف رقماً — يعلّمه ويقول لماذا.",
  specialties: [] as string[], priority: 992, handoffTo: null as string | null,
};

export type Verdict = "ready" | "hold" | "rejected";

/** Everything the judgement reads about one number. Gathered by the reader below, or by a test. */
export interface Facts {
  phone: string;
  valid: boolean;
  /** true mobile, false landline, null unknown country. */
  mobile: boolean | null;
  iso: string | null;
  /** The list's own country, when four in five of its numbers agree. */
  listIso: string | null;
  foreignAllowed: boolean;
  fake: boolean;
  /** Another contact in the same list is the same person. */
  duplicate: boolean;
  blacklisted: boolean;
  /** Days since a «غير مهتم» tap, when within the window. */
  notInterestedDays: number | null;
  /** WhatsApp's word: exists, does not, or not asked / could not answer. */
  waExists: boolean | null;
  previouslyNotOnWa: boolean;
  sent60d: number;
  delivered60d: number;
  lastCampaignHoursAgo: number | null;
  /** Days since the person last wrote to us. */
  wroteDaysAgo: number | null;
  readEver: boolean;
}

export const REASON = {
  invalid: "ليس رقماً صالحاً", landline: "رقم أرضي لا جوال", fake: "رقم وهمي (نمط مكرر)", duplicate: "مكرر في القائمة",
  blacklisted: "طلب الإيقاف — لا يُراسَل", notOnWa: "ليس على واتساب", unverified: "لم يُتحقق منه على واتساب بعد",
  foreign: "دولة أخرى غير دولة القائمة", notInterested: "قال «غير مهتم» مؤخراً", undelivered: "رسائلنا السابقة لم تُسلَّم له",
  recent: "راسلناه خلال ٢٤ ساعة", unknownCountry: "دولة غير معروفة",
} as const;

/** Whether the digits look made up: one digit repeated, or a long run. Pure. */
export function looksFake(e164: string): boolean {
  const d = e164.replace(/\D/g, "");
  const local = d.slice(Math.max(3, d.length - 9));
  if (/(\d)\1{5,}/.test(local)) return true;
  const up = "01234567890123456789", down = "98765432109876543210";
  for (let i = 0; i + 7 <= local.length; i++) {
    const s = local.slice(i, i + 7);
    if (up.includes(s) || down.includes(s)) return true;
  }
  return false;
}

/** The verdict, its reasons in the owner's words, and a risk 0–100. Pure. */
export function judge(f: Facts): { verdict: Verdict; reasons: string[]; risk: number } {
  const no: string[] = [], later: string[] = [];
  let risk = 50;
  if (!f.valid) no.push(REASON.invalid);
  else if (f.mobile === false) no.push(REASON.landline);
  if (f.fake) no.push(REASON.fake);
  if (f.duplicate) no.push(REASON.duplicate);
  if (f.blacklisted) no.push(REASON.blacklisted);
  if (f.waExists === false || f.previouslyNotOnWa) no.push(REASON.notOnWa);
  if (no.length) return { verdict: "rejected", reasons: no, risk: 100 };

  if (f.waExists === null) { later.push(REASON.unverified); risk += 20; }
  if (f.mobile === null && f.iso === null) { later.push(REASON.unknownCountry); risk += 10; }
  if (!f.foreignAllowed && f.listIso && f.iso && f.iso !== f.listIso) { later.push(REASON.foreign); risk += 10; }
  if (f.notInterestedDays !== null && f.notInterestedDays <= 180) { later.push(REASON.notInterested); risk += 25; }
  if (f.sent60d >= 2 && f.delivered60d === 0) { later.push(REASON.undelivered); risk += 25; }
  if (f.lastCampaignHoursAgo !== null && f.lastCampaignHoursAgo < 24) { later.push(REASON.recent); risk += 5; }

  if (f.wroteDaysAgo !== null && f.wroteDaysAgo <= 365) risk -= 25;
  if (f.wroteDaysAgo !== null && f.wroteDaysAgo <= 3) risk -= 10;
  if (f.readEver) risk -= 10;
  if (f.delivered60d > 0) risk -= 10;
  risk = Math.max(0, Math.min(100, risk));
  return later.length ? { verdict: "hold", reasons: later, risk } : { verdict: "ready", reasons: [], risk };
}

/** The list's own country: the one four in five of its numbers share. Pure. */
export function listCountry(isos: Array<string | null>): string | null {
  const n = new Map<string, number>();
  let total = 0;
  for (const i of isos) if (i) { total++; n.set(i, (n.get(i) ?? 0) + 1); }
  if (!total) return null;
  const [top, c] = [...n.entries()].sort((a, b) => b[1] - a[1])[0]!;
  return c / total >= 0.8 ? top : null;
}

// ── The employee ──────────────────────────────────────────────────
export async function ensureVetter(userId: number) {
  const [have] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, VETTER_ROLE))).limit(1);
  if (have) return have;
  const [row] = await db.insert(botEmployeesTable).values({ userId, ...VETTER } as any).onConflictDoNothing().returning();
  if (row) logger.info({ userId }, "وُظّف سيف، فاحص الأرقام");
  return row ?? (await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, VETTER_ROLE))).limit(1))[0]!;
}

// ── What the account knows about a number ─────────────────────────
interface History { blacklisted: boolean; notInterestedDays: number | null; previouslyNotOnWa: boolean; sent60d: number; delivered60d: number; lastCampaignHoursAgo: number | null; wroteDaysAgo: number | null; readEver: boolean }

async function history(userId: number, keys: string[]): Promise<Map<string, History>> {
  const out = new Map<string, History>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = [...new Set(keys.slice(i, i + 500))];
    const rows = (await db.execute<any>(sql`
      WITH k AS (SELECT DISTINCT unnest(ARRAY[${sql.join(chunk.map((c) => sql`${c}`), sql`, `)}]::text[]) AS key),
      ml AS (SELECT right(regexp_replace(split_part(m.phone, ':', 1), '[^0-9]', '', 'g'), 9) AS key, m.status, m.error, m.sent_at, m.delivered_at, m.read_at
             FROM message_logs m JOIN campaigns c ON c.id = m.campaign_id WHERE c.user_id = ${userId}
             AND right(regexp_replace(split_part(m.phone, ':', 1), '[^0-9]', '', 'g'), 9) IN (SELECT key FROM k))
      SELECT k.key,
        EXISTS (SELECT 1 FROM unsubscribed_phones u WHERE u.user_id = ${userId} AND right(regexp_replace(u.phone, '[^0-9]', '', 'g'), 9) = k.key AND (u.expires_at IS NULL OR u.expires_at > now())) AS black,
        (SELECT extract(epoch FROM now() - max(r.created_at)) / 86400 FROM campaign_button_responses r JOIN campaigns c ON c.id = r.campaign_id
           WHERE c.user_id = ${userId} AND r.action = 'not_interested' AND right(regexp_replace(split_part(r.phone, ':', 1), '[^0-9]', '', 'g'), 9) = k.key AND r.created_at > now() - interval '180 days') AS ni_days,
        EXISTS (SELECT 1 FROM ml WHERE ml.key = k.key AND ml.error LIKE 'NOT_ON_WHATSAPP%') AS not_on_wa,
        (SELECT count(*)::int FROM ml WHERE ml.key = k.key AND ml.status = 'sent' AND ml.sent_at > now() - interval '60 days') AS sent60,
        (SELECT count(*)::int FROM ml WHERE ml.key = k.key AND ml.status = 'sent' AND ml.sent_at > now() - interval '60 days' AND ml.delivered_at IS NOT NULL) AS delivered60,
        (SELECT extract(epoch FROM now() - max(ml.sent_at)) / 3600 FROM ml WHERE ml.key = k.key AND ml.status = 'sent') AS last_campaign_h,
        (SELECT extract(epoch FROM now() - greatest(
            (SELECT max(t.created_at) FROM wa_thread_messages t WHERE t.user_id = ${userId} AND NOT t.from_me AND right(regexp_replace(split_part(t.phone, ':', 1), '[^0-9]', '', 'g'), 9) = k.key),
            (SELECT max(i.received_at) FROM incoming_messages i WHERE i.user_id = ${userId} AND right(regexp_replace(split_part(i.phone, ':', 1), '[^0-9]', '', 'g'), 9) = k.key))) / 86400) AS wrote_days,
        EXISTS (SELECT 1 FROM ml WHERE ml.key = k.key AND ml.read_at IS NOT NULL) AS read_ever
      FROM k`)).rows;
    for (const r of rows) {
      out.set(String(r.key), {
        blacklisted: !!r.black, notInterestedDays: r.ni_days === null ? null : Number(r.ni_days), previouslyNotOnWa: !!r.not_on_wa,
        sent60d: Number(r.sent60 ?? 0), delivered60d: Number(r.delivered60 ?? 0), lastCampaignHoursAgo: r.last_campaign_h === null ? null : Number(r.last_campaign_h),
        wroteDaysAgo: r.wrote_days === null ? null : Number(r.wrote_days), readEver: !!r.read_ever,
      });
    }
  }
  return out;
}

// ── Asking WhatsApp, on a leash ───────────────────────────────────
export const WA_LOOKUPS_PER_HOUR = 1_200;
const lookups = new Map<number, number[]>();
function lookupRoom(userId: number): number {
  const ts = (lookups.get(userId) ?? []).filter((t) => t > Date.now() - 3_600_000);
  lookups.set(userId, ts);
  return Math.max(0, WA_LOOKUPS_PER_HOUR - ts.length);
}
function noteLookups(userId: number, n: number) {
  const ts = lookups.get(userId) ?? [];
  for (let i = 0; i < n; i++) ts.push(Date.now());
  lookups.set(userId, ts);
}

// ── A run ─────────────────────────────────────────────────────────
export type Trigger = "upload" | "connect" | "campaign" | "owner" | "daily";
export interface RunReport { runId: number; total: number; ready: number; hold: number; rejected: number; checked: number; unknown: number; reasons: Record<string, number>; note: string }

/** How long a verdict stands before the number is looked at again. */
const RECHECK_DAYS = 30;

/**
 * Judge a list, or some of its numbers. Every number gets a verdict; the
 * ones that need WhatsApp's word get it as far as the hour's leash allows,
 * the rest stay on hold until the next run.
 */
export async function vetList(userId: number, groupId: number, trigger: Trigger, opts: { ids?: number[]; onlyPending?: boolean; info?: { running?: boolean }; foreignAllowed?: boolean } = {}): Promise<RunReport> {
  await ensureVetter(userId).catch(() => {});
  const [group] = await db.select().from(contactGroupsTable).where(and(eq(contactGroupsTable.id, groupId), eq(contactGroupsTable.userId, userId))).limit(1);
  if (!group) throw new Error("القائمة غير موجودة");
  const all = await db.select().from(contactsTable).where(eq(contactsTable.groupId, groupId)).orderBy(contactsTable.id);
  const stale = (c: typeof all[number]) => !c.vettedAt || Date.now() - c.vettedAt.getTime() > RECHECK_DAYS * 86_400_000 || c.verdict === "hold" || !c.verdict;
  let targets = opts.ids ? all.filter((c) => opts.ids!.includes(c.id)) : opts.onlyPending ? all.filter(stale) : all;
  const [run] = await db.insert(contactVettingRunsTable).values({ userId, groupId, trigger, total: targets.length }).returning();

  // The person once, by any spelling: the first row keeps the number.
  const seen = new Set<string>();
  const dupIds = new Set<number>();
  for (const c of all) { const k = key9(c.phone); if (!k) continue; if (seen.has(k)) dupIds.add(c.id); else seen.add(k); }

  const norm = new Map<number, ReturnType<typeof normalizePhone>>();
  for (const c of targets) norm.set(c.id, normalizePhone(c.phone, "AE"));
  const listIso = listCountry(all.map((c) => normalizePhone(c.phone, "AE")?.iso ?? null));
  const hist = await history(userId, targets.map((c) => key9(c.phone)).filter(Boolean));

  // Who still needs WhatsApp's word: a valid mobile with no hard no, never answered or answered long ago.
  // What the earlier list check already learned from WhatsApp: «active» was confirmed, «invalid» was not on it.
  const known = (c: typeof all[number]): boolean | null => c.waExists ?? (c.status === "active" ? true : c.status === "invalid" ? false : null);
  const ask = targets.filter((c) => {
    const p = norm.get(c.id); const h = hist.get(key9(c.phone));
    if (!p || p.mobile === false || looksFake(p.e164) || dupIds.has(c.id) || h?.blacklisted || h?.previouslyNotOnWa) return false;
    return known(c) === null || (c.vettedAt && Date.now() - c.vettedAt.getTime() > RECHECK_DAYS * 86_400_000 && c.waExists !== null && c.waExists !== undefined);
  });
  const answers = new Map<string, boolean | null>();
  let checked = 0, unknown = 0;
  if (ask.length && !getStatus(userId)?.connected) logger.info({ userId, groupId, waiting: ask.length }, "سيف: واتساب غير متصل الآن — الأرقام غير المفحوصة تنتظر");
  if (ask.length && getStatus(userId)?.connected) {
    const room = Math.min(ask.length, lookupRoom(userId));
    const phones = [...new Set(ask.slice(0, room).map((c) => c.phone))];
    if (phones.length) {
      noteLookups(userId, phones.length);
      const res = await checkNumbers(userId, phones).catch((err) => { logger.warn({ userId, groupId, err: String(err?.message ?? err) }, "سيف: فحص واتساب تعذّر"); return [] as Array<{ phone: string; exists: boolean | null }>; });
      for (const r of res) { answers.set(r.phone, r.exists); checked++; if (r.exists === null) unknown++; }
    }
  }

  const counts = { ready: 0, hold: 0, rejected: 0 };
  const reasons: Record<string, number> = {};
  for (const c of targets) {
    if (opts.info && opts.info.running === false) break;
    const p = norm.get(c.id); const h = hist.get(key9(c.phone));
    const waExists = answers.has(c.phone) ? answers.get(c.phone)! : known(c);
    const f: Facts = {
      phone: c.phone, valid: !!p, mobile: p?.mobile ?? null, iso: p?.iso ?? null, listIso, foreignAllowed: !!opts.foreignAllowed,
      fake: p ? looksFake(p.e164) : false, duplicate: dupIds.has(c.id), blacklisted: !!h?.blacklisted,
      notInterestedDays: h?.notInterestedDays ?? null, waExists, previouslyNotOnWa: !!h?.previouslyNotOnWa,
      sent60d: h?.sent60d ?? 0, delivered60d: h?.delivered60d ?? 0, lastCampaignHoursAgo: h?.lastCampaignHoursAgo ?? null,
      wroteDaysAgo: h?.wroteDaysAgo ?? null, readEver: !!h?.readEver,
    };
    const v = judge(f);
    counts[v.verdict]++;
    for (const r of v.reasons) reasons[r] = (reasons[r] ?? 0) + 1;
    // «ليس على واتساب» keeps the old mark too, for every screen that reads it; a number WhatsApp now knows is back.
    const status = waExists === false ? "invalid" : c.status === "invalid" && waExists === true ? "active" : c.status === "pending" && waExists !== null ? "active" : c.status;
    await db.update(contactsTable).set({ verdict: v.verdict, vetReasons: v.reasons, vettedAt: new Date(), waExists, risk: v.risk, status }).where(eq(contactsTable.id, c.id));
  }

  const note = targets.length
    ? `قائمة «${group.name}»: ${counts.ready} جاهز، ${counts.hold} ليس الآن، ${counts.rejected} مرفوض من ${targets.length}.${checked ? ` سألت واتساب عن ${checked}${unknown ? ` (${unknown} بلا جواب)` : ""}.` : getStatus(userId)?.connected ? "" : " واتساب غير متصل — ما لم يُتحقق منه ينتظر الربط."}${Object.keys(reasons).length ? ` الأسباب: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${k} (${n})`).join("، ")}.` : ""}`
    : `قائمة «${group.name}»: لا جديد يُفحص.`;
  await db.update(contactVettingRunsTable).set({ ...counts, checked, unknown, reasons, note, finishedAt: new Date() }).where(eq(contactVettingRunsTable.id, run!.id));
  if (targets.length) {
    void import("./agent-comms").then((m) => m.say({ userId, fromRole: VETTER_ROLE, toRole: "chief", kind: "report", body: `سيف: ${note}` })).catch(() => {});
  }
  logger.info({ userId, groupId, trigger, ...counts, checked, unknown }, "سيف فحص القائمة");
  return { runId: run!.id, total: targets.length, ...counts, checked, unknown, reasons, note };
}

/** Every list of the account with numbers waiting for a verdict — on connect, and daily. */
export async function vetPending(userId: number, trigger: Trigger = "connect"): Promise<number> {
  const groups = await db.selectDistinct({ id: contactsTable.groupId }).from(contactsTable)
    .innerJoin(contactGroupsTable, eq(contactGroupsTable.id, contactsTable.groupId))
    .where(and(eq(contactGroupsTable.userId, userId), sql`(${contactsTable.verdict} IS NULL OR ${contactsTable.verdict} = 'hold' OR ${contactsTable.status} = 'pending')`));
  for (const g of groups) await vetList(userId, g.id, trigger, { onlyPending: true }).catch((err) => logger.warn({ userId, groupId: g.id, err: String(err?.message ?? err) }, "سيف: فحص قائمة معلّقة تعذّر"));
  return groups.length;
}

/** After an import: the new numbers judged in the background. Returns whether it started. */
export function vetInBackground(userId: number, groupIds: number[], trigger: Trigger = "upload"): boolean {
  if (!groupIds.length) return false;
  void (async () => {
    for (const id of groupIds) await vetList(userId, id, trigger, { onlyPending: true }).catch((err) => logger.warn({ userId, groupId: id, err: String(err?.message ?? err) }, "سيف: الفحص بعد الرفع تعذّر"));
  })();
  return true;
}

/**
 * At campaign start: whoever is unvetted or on hold is looked at again, and
 * only the ready ones go. The list is the campaign's; the verdicts are the
 * contact's, so a second campaign on the same list starts at once.
 */
export async function ensureVetted<T extends { id: number; phone: string; groupId: number; verdict?: string | null; vettedAt?: Date | null }>(userId: number, contacts: T[], info?: { running?: boolean }): Promise<T[]> {
  if (!contacts.length) return contacts;
  const again = contacts.filter((c) => !c.verdict || c.verdict === "hold" || !c.vettedAt || Date.now() - c.vettedAt.getTime() > RECHECK_DAYS * 86_400_000);
  const byGroup = new Map<number, number[]>();
  for (const c of again) byGroup.set(c.groupId, [...(byGroup.get(c.groupId) ?? []), c.id]);
  for (const [groupId, ids] of byGroup) {
    if (info && info.running === false) break;
    await vetList(userId, groupId, "campaign", { ids, info }).catch((err) => logger.warn({ userId, groupId, err: String(err?.message ?? err) }, "سيف: فحص ما قبل الحملة تعذّر"));
  }
  if (!again.length) return contacts.filter((c) => c.verdict === "ready");
  const ids = contacts.map((c) => c.id);
  const ready = new Set<number>();
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await db.select({ id: contactsTable.id }).from(contactsTable).where(and(inArray(contactsTable.id, ids.slice(i, i + 1000)), eq(contactsTable.verdict, "ready")));
    for (const r of rows) ready.add(r.id);
  }
  return contacts.filter((c) => ready.has(c.id));
}

/** What the list page shows: counts by verdict, the reasons, the last run. */
export async function summary(userId: number, groupId: number) {
  const [c] = (await db.execute<any>(sql`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE verdict = 'ready')::int AS ready,
      count(*) FILTER (WHERE verdict = 'hold')::int AS hold,
      count(*) FILTER (WHERE verdict = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE verdict IS NULL)::int AS unvetted,
      count(*) FILTER (WHERE wa_exists IS NULL)::int AS unverified,
      max(vetted_at) AS last_vetted
    FROM contacts WHERE group_id = ${groupId}`)).rows;
  const reasons = (await db.execute<{ reason: string; n: number }>(sql`SELECT r AS reason, count(*)::int AS n FROM contacts, jsonb_array_elements_text(coalesce(vet_reasons, '[]'::jsonb)) AS r
    WHERE group_id = ${groupId} GROUP BY r ORDER BY n DESC LIMIT 10`)).rows;
  const [last] = await db.select().from(contactVettingRunsTable).where(and(eq(contactVettingRunsTable.userId, userId), eq(contactVettingRunsTable.groupId, groupId)))
    .orderBy(sql`${contactVettingRunsTable.startedAt} desc`).limit(1);
  return {
    total: Number(c?.total ?? 0), ready: Number(c?.ready ?? 0), hold: Number(c?.hold ?? 0), rejected: Number(c?.rejected ?? 0),
    unvetted: Number(c?.unvetted ?? 0), unverified: Number(c?.unverified ?? 0), lastVettedAt: c?.last_vetted ?? null,
    reasons: reasons.map((r) => ({ reason: r.reason, n: Number(r.n) })), lastRun: last ?? null, connected: !!getStatus(userId)?.connected,
    lookupsLeftThisHour: lookupRoom(userId), employee: VETTER,
  };
}

/** Once a day, in the quiet before the window: holds looked at again, so a 24-hour hold clears itself. */
export function startVetting(): void {
  setTimeout(() => {
    const tick = async () => {
      const users = await db.selectDistinct({ userId: contactGroupsTable.userId }).from(contactGroupsTable);
      for (const u of users) if (u.userId && getStatus(u.userId)?.connected) await vetPending(u.userId, "daily").catch(() => {});
    };
    setInterval(() => void tick(), 24 * 3_600_000);
  }, 10 * 60_000);
  logger.info("سيف، فاحص الأرقام، على رأس عمله");
}
