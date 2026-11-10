// ── مكتب الحسابات المستهدفة: الإعدادات، التشغيل اليومي، المزامنة، العرض ──
// صاحب العمل: «كل يوم عشر شركات عقارية، من يقرّر الامتثال فيها، بريده
// ولينكدإن، ورسالة مكتوبة له هو». كل شيء تلقائي بلا موافقات؛ لينكدإن
// وحده يُكتب ويرسله صاحب العمل بيده.
//
// الجداول: النشر على الخادم لا يشغّل ملفات SQL (انظر email/service.ts
// DOMAIN_INDEX_SQL)، فتُنشأ هنا عند الإقلاع بما في 071_accounts_desk.sql.

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, accountsDeskSettingsTable, targetAccountsTable, targetPeopleTable, emailAgentActivityTable, type TargetAccount, type TargetPerson } from "@workspace/db";
import { logger } from "../logger";
import { COMPANY_GAP_DAYS, FREE_MAIL } from "../email/service";
import { ACCOUNTS_TEAM, ensureAccountsTeam, deskActivity, nameOf } from "./team";
import { ACCOUNTS_WORKFLOW, processAccount } from "./pipeline";
import { rankCandidates, shortCompany, dubaiNow, linkedinSearchUrl, type CandidateRow } from "./pure";
import { accountHalted } from "../org/controls";
import { runAs } from "../org/runtime";
import { finishWorkflow, openWorkflowFor, workflowStep } from "../org/handoffs";
import { everyMs } from "../org/workers";

// ── الجداول عند الإقلاع ────────────────────────────────────────────
export const DESK_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS accounts_desk_settings (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false, per_day integer NOT NULL DEFAULT 10,
    sectors jsonb NOT NULL DEFAULT '["عقارات"]'::jsonb, emirates jsonb NOT NULL DEFAULT '[]'::jsonb,
    search_key varchar(200), last_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS target_accounts (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    company varchar(200) NOT NULL, domain varchar(200) NOT NULL, website varchar(300), city varchar(120), sector varchar(60),
    signal text, signal_source varchar(500), status varchar(20) NOT NULL DEFAULT 'researching', run_date varchar(10) NOT NULL,
    notes text, email_to varchar(254), email_subject varchar(300), email_body text, email_followups jsonb NOT NULL DEFAULT '[]'::jsonb,
    linkedin_message text, linkedin_done boolean NOT NULL DEFAULT false, contact_id integer, sequence_id integer,
    sent_at timestamptz, opened_at timestamptz, replied_at timestamptz, meeting_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_target_accounts_domain UNIQUE (user_id, domain))`,
  `CREATE INDEX IF NOT EXISTS idx_target_accounts_user ON target_accounts (user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_target_accounts_day ON target_accounts (user_id, run_date)`,
  `CREATE TABLE IF NOT EXISTS target_people (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id integer NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
    name varchar(160) NOT NULL, title varchar(200), why text, email varchar(254), email_status varchar(12),
    email_fallback boolean NOT NULL DEFAULT false, linkedin_url varchar(400), source_url varchar(500),
    is_decision_maker boolean NOT NULL DEFAULT false, contact_id integer, sequence_id integer,
    created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_target_people_account ON target_people (account_id)`,
  `INSERT INTO accounts_desk_settings (user_id, enabled) SELECT 2, true WHERE EXISTS (SELECT 1 FROM users WHERE id = 2) ON CONFLICT (user_id) DO NOTHING`,
];

let tablesReady: Promise<void> | null = null;
export function ensureDeskTables(): Promise<void> {
  tablesReady ??= (async () => {
    for (const q of DESK_TABLES_SQL) await db.execute(sql.raw(q));
  })().catch((e) => { tablesReady = null; logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء جداول مكتب الحسابات"); });
  return tablesReady;
}

// ── الإعدادات ─────────────────────────────────────────────────────
export async function deskSettings(userId: number) {
  await ensureDeskTables();
  const [s] = await db.select().from(accountsDeskSettingsTable).where(eq(accountsDeskSettingsTable.userId, userId)).limit(1);
  if (s) return s;
  // First use: on for Pro Count (the owner asked for it), off for everyone else until they switch it on.
  const [row] = await db.insert(accountsDeskSettingsTable).values({ userId, enabled: userId === 2 }).onConflictDoNothing().returning();
  return row ?? (await db.select().from(accountsDeskSettingsTable).where(eq(accountsDeskSettingsTable.userId, userId)).limit(1))[0]!;
}

const strList = (v: unknown) => (Array.isArray(v) ? v : []).map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);

export function settingsView(s: Awaited<ReturnType<typeof deskSettings>>) {
  return { enabled: s.enabled, perDay: s.perDay, sectors: strList(s.sectors), emirates: strList(s.emirates), hasSearchKey: !!s.searchKey };
}

export async function updateSettings(userId: number, body: any) {
  await deskSettings(userId);
  const v: Partial<typeof accountsDeskSettingsTable.$inferInsert> = { updatedAt: new Date() };
  if (typeof body?.enabled === "boolean") v.enabled = body.enabled;
  if (body?.perDay !== undefined) {
    const n = Math.round(Number(body.perDay));
    if (!Number.isFinite(n) || n < 1 || n > 25) throw Object.assign(new Error("عدد الشركات في اليوم من ١ إلى ٢٥"), { status: 400 });
    v.perDay = n;
  }
  if (body?.sectors !== undefined) { const l = strList(body.sectors); if (!l.length) throw Object.assign(new Error("قطاع واحد على الأقل"), { status: 400 }); v.sectors = l; }
  if (body?.emirates !== undefined) v.emirates = strList(body.emirates);
  if (typeof body?.searchKey === "string") v.searchKey = body.searchKey.trim().slice(0, 200) || null;
  await db.update(accountsDeskSettingsTable).set(v).where(eq(accountsDeskSettingsTable.userId, userId));
  return settingsView(await deskSettings(userId));
}

// ── فهد يختار شركات اليوم ─────────────────────────────────────────
export async function candidates(userId: number, sectors: string[], emirates: string[], limit: number): Promise<CandidateRow[]> {
  const free = sql.join([...FREE_MAIL].map((d) => sql`${d}`), sql`, `);
  const secs = sql.join((sectors.length ? sectors : ["عقارات"]).map((s) => sql`${s}`), sql`, `);
  const rows = (await db.execute<any>(sql`
    WITH d AS (
      SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS addresses,
        mode() WITHIN GROUP (ORDER BY company) AS company, mode() WITHIN GROUP (ORDER BY city) AS city, max(sector) AS sector,
        bool_or(last_opened_at IS NOT NULL) AS opened, bool_or(last_replied_at IS NOT NULL) AS replied,
        bool_or(status IN ('unsubscribed', 'complained')) AS stopped, bool_or(status = 'active') AS any_active, max(last_sent_at) AS last_sent
      FROM email_contacts WHERE user_id = ${userId} AND sector IN (${secs})
      GROUP BY 1)
    SELECT d.* FROM d
    WHERE NOT d.replied AND NOT d.stopped AND d.any_active AND d.domain LIKE '%.%' AND d.domain NOT IN (${free})
      -- موجةٌ خرجت إليها قبل أيام تؤخّر الرسالة الشخصية بفاصل الشركة: تُختار حين ينقضي.
      AND (d.last_sent IS NULL OR d.last_sent < now() - make_interval(days => ${COMPANY_GAP_DAYS}))
      AND NOT EXISTS (SELECT 1 FROM target_accounts t WHERE t.user_id = ${userId} AND t.domain = d.domain)
      AND NOT EXISTS (SELECT 1 FROM email_inbound i WHERE i.user_id = ${userId} AND lower(split_part(i.from_email, '@', 2)) = d.domain)`)).rows;
  const clicked = new Set((await db.execute<{ domain: string }>(sql`
    SELECT DISTINCT lower(split_part(c.email, '@', 2)) AS domain FROM email_messages m JOIN email_contacts c ON c.id = m.contact_id
    WHERE m.user_id = ${userId} AND m.clicked_at IS NOT NULL`)).rows.map((r) => r.domain));
  const list: CandidateRow[] = rows.map((r: any) => ({
    domain: String(r.domain), company: r.company ?? null, city: r.city ?? null, sector: r.sector ?? null,
    addresses: Number(r.addresses) || 0, engaged: !!r.opened || clicked.has(String(r.domain)),
  }));
  return rankCandidates(list, emirates).slice(0, limit);
}

// ── التشغيل ───────────────────────────────────────────────────────
const running = new Set<number>();
export const isRunning = (userId: number) => running.has(userId);
const RUN_BUDGET_MS = 20 * 60_000;

/** Today's run, in the background. Never two at once for one account. */
export async function startRun(userId: number, opts: { manual: boolean }): Promise<{ started: boolean; why?: string }> {
  if (running.has(userId)) return { started: false, why: "المكتب يعمل الآن" };
  const s = await deskSettings(userId);
  if (!s.enabled) return { started: false, why: "المكتب موقوف — شغّله من الإعدادات" };
  const today = dubaiNow().date;
  const [{ n }] = (await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM target_accounts WHERE user_id = ${userId} AND run_date = ${today} AND status <> 'researching'`)).rows as any;
  const stale = await db.select().from(targetAccountsTable).where(and(eq(targetAccountsTable.userId, userId), eq(targetAccountsTable.status, "researching")));
  const remaining = Math.max(0, s.perDay - Number(n) - stale.filter((x) => x.runDate === today).length);
  if (!remaining && !stale.length) return { started: false, why: `اكتملت شركات اليوم (${s.perDay})` };
  running.add(userId);
  void runAs(userId, "accounts_researcher", { kind: "desk_run", respect: "none" }, () => runDesk(userId, s, remaining, stale, opts.manual)).catch((e) => logger.warn({ userId, err: String(e?.message ?? e) }, "مكتب الحسابات: التشغيل فشل"))
    .finally(() => running.delete(userId));
  return { started: true };
}

async function runDesk(userId: number, s: Awaited<ReturnType<typeof deskSettings>>, remaining: number, stale: TargetAccount[], manual: boolean) {
  const t0 = Date.now();
  await ensureAccountsTeam(userId);
  const today = dubaiNow().date;
  const sectors = strList(s.sectors), emirates = strList(s.emirates);
  const picked = remaining ? await candidates(userId, sectors, emirates, remaining) : [];
  const engaged = new Map<number, boolean>();
  const queue: TargetAccount[] = [];
  // Interrupted yesterday (a restart mid-run) is finished first.
  for (const a of stale) { queue.push(a); engaged.set(a.id, false); }
  for (const c of picked) {
    const [row] = await db.insert(targetAccountsTable).values({
      userId, company: shortCompany(c.company, c.domain), domain: c.domain, city: c.city, sector: c.sector, status: "researching", runDate: today,
    }).onConflictDoNothing().returning();
    if (row) { queue.push(row); engaged.set(row.id, c.engaged); }
  }
  if (picked.length) await deskActivity(userId, "accounts_researcher", "pick",
    `فهد اختار ${picked.length} شركة لليوم${manual ? " (تشغيل يدوي)" : ""}: ${picked.slice(0, 10).map((c) => shortCompany(c.company, c.domain)).join("، ")}.`, { date: today });
  else if (!stale.length) await deskActivity(userId, "accounts_researcher", "empty", "فهد لم يجد شركات جديدة في القطاعات المختارة — كلها في المكتب أو ردّت أو طلبت الإيقاف.", null);
  const tally: Record<string, number> = {};
  for (const acc of queue) {
    if (Date.now() - t0 > RUN_BUDGET_MS) {
      await db.update(targetAccountsTable).set({ status: "skipped", notes: "انتهى وقت التشغيل قبل الوصول إليها", updatedAt: new Date() })
        .where(and(eq(targetAccountsTable.id, acc.id), eq(targetAccountsTable.status, "researching")));
      tally["skipped"] = (tally["skipped"] ?? 0) + 1;
      continue;
    }
    const st = await processAccount(userId, acc, { key: s.searchKey, engaged: engaged.get(acc.id) ?? false });
    tally[st] = (tally[st] ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 2_000));
  }
  await db.update(accountsDeskSettingsTable).set({ lastRunAt: new Date() }).where(eq(accountsDeskSettingsTable.userId, userId));
  if (queue.length) await deskActivity(userId, "accounts_researcher", "done",
    `انتهى يوم المكتب: ${queue.length} شركة — أُرسل ${tally["sent"] ?? 0}، تنتظر مراجعة ${tally["needs_review"] ?? 0}، بلا صاحب قرار ${tally["no_person"] ?? 0}، بلا بريد ${tally["no_email"] ?? 0}، بلا موقع ${tally["no_site"] ?? 0}.`, { tally });
}

// ── المزامنة: أُرسل، فُتح، ردّ ────────────────────────────────────
export async function syncAccounts(userId?: number) {
  await ensureDeskTables();
  const accs = await db.select().from(targetAccountsTable).where(and(
    inArray(targetAccountsTable.status, ["sent", "replied", "meeting"]), sql`${targetAccountsTable.sequenceId} IS NOT NULL`,
    userId ? eq(targetAccountsTable.userId, userId) : sql`true`, gte(targetAccountsTable.createdAt, new Date(Date.now() - 60 * 86_400_000))));
  for (const a of accs) {
    const [m] = (await db.execute<any>(sql`
      SELECT min(m.sent_at) AS sent, min(m.opened_at) AS opened, min(m.replied_at) AS replied
      FROM email_messages m JOIN email_sequence_jobs j ON j.id = m.sequence_job_id WHERE j.sequence_id = ${a.sequenceId}`)).rows;
    const [r] = a.contactId ? (await db.execute<any>(sql`
      SELECT GREATEST(
        (SELECT last_replied_at FROM email_contacts WHERE id = ${a.contactId} AND last_replied_at > ${a.createdAt}),
        (SELECT min(received_at) FROM email_inbound WHERE contact_id = ${a.contactId} AND received_at > ${a.createdAt})) AS at`)).rows : [null];
    const replied = m?.replied ?? r?.at ?? null;
    const v: Partial<typeof targetAccountsTable.$inferInsert> = {};
    if (m?.sent && !a.sentAt) v.sentAt = new Date(m.sent);
    if (m?.opened && !a.openedAt) v.openedAt = new Date(m.opened);
    if (replied && !a.repliedAt) v.repliedAt = new Date(replied);
    if (replied && a.status === "sent") v.status = "replied";
    if (!Object.keys(v).length) continue;
    await db.update(targetAccountsTable).set({ ...v, updatedAt: new Date() }).where(eq(targetAccountsTable.id, a.id));
    // خرجت فعلاً: هنا فقط يكتمل سير الشركة. دخول الطابور ليس إرسالاً.
    if (v.sentAt) {
      const wf = await openWorkflowFor(a.userId, ACCOUNTS_WORKFLOW, a.id).catch(() => null);
      if (wf) { await workflowStep(a.userId, wf, "email_queue", "delivered", { sentAt: v.sentAt }); await finishWorkflow(wf, "succeeded", { status: "sent", sentAt: v.sentAt }); }
    }
    if (v.status === "replied") await deskActivity(a.userId, "accounts_writer", "replied", `ردّ صاحب القرار في ${a.company} على رسالة هند.`, { accountId: a.id });
  }
}

// ── العامل ─────────────────────────────────────────────────────────
const autoRanOn = new Map<number, string>();
export function startAccountsDesk(): void {
  void ensureDeskTables();
  setTimeout(() => {
    // 08:30 Dubai, Monday to Friday, once a day per account that switched the desk on.
    everyMs("target_accounts.desk", 5 * 60_000, async () => {
      const now = dubaiNow();
      if (!now.weekday || now.hour < 8 || (now.hour === 8 && now.minute < 30) || now.hour >= 17) return;
      await ensureDeskTables();
      const on = await db.select({ userId: accountsDeskSettingsTable.userId }).from(accountsDeskSettingsTable).where(eq(accountsDeskSettingsTable.enabled, true)).catch(() => []);
      for (const { userId } of on) {
        if (autoRanOn.get(userId) === now.date) continue;
        // Before the stamp: an account released at ten still gets today's run.
        if (await accountHalted(userId, "accounts_desk")) continue;
        autoRanOn.set(userId, now.date);
        await startRun(userId, { manual: false }).catch(() => {});
      }
    });
    everyMs("target_accounts.sync", 10 * 60_000, syncAccounts);
  }, 60_000);
  logger.info("مكتب الحسابات المستهدفة بدأ");
}

// ── العرض ──────────────────────────────────────────────────────────
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export function accountView(a: TargetAccount, people: TargetPerson[]) {
  const followups = (Array.isArray(a.emailFollowups) ? a.emailFollowups : []) as Array<{ afterDays: number; subject: string; body: string }>;
  return {
    id: a.id, company: a.company, domain: a.domain, website: a.website ?? null, city: a.city ?? null, sector: a.sector ?? null,
    signal: a.signal ?? null, signalSource: a.signalSource ?? null, status: a.status, createdAt: iso(a.createdAt)!,
    people: people.filter((p) => p.accountId === a.id).sort((x, y) => Number(y.isDecisionMaker) - Number(x.isDecisionMaker) || x.id - y.id).map((p) => ({
      id: p.id, name: p.name, title: p.title ?? null, why: p.why ?? null, email: p.email ?? null, emailStatus: p.emailStatus ?? null,
      emailFallback: p.emailFallback, linkedinUrl: p.linkedinUrl ?? null, linkedinSearchUrl: linkedinSearchUrl(p.name, a.company), isDecisionMaker: p.isDecisionMaker,
    })),
    email: a.emailSubject && a.emailBody ? {
      to: a.emailTo ?? "", subject: a.emailSubject, body: a.emailBody,
      followups: followups.map((f) => ({ afterDays: Number(f.afterDays) || 0, subject: String(f.subject ?? ""), body: String(f.body ?? "") })),
      sentAt: iso(a.sentAt), openedAt: iso(a.openedAt), repliedAt: iso(a.repliedAt),
    } : null,
    linkedin: a.linkedinMessage ? { message: a.linkedinMessage, done: a.linkedinDone } : null,
    notes: a.notes ?? null,
  };
}

async function withPeople(rows: TargetAccount[]) {
  const people = rows.length ? await db.select().from(targetPeopleTable).where(inArray(targetPeopleTable.accountId, rows.map((r) => r.id))) : [];
  return rows.map((a) => accountView(a, people));
}

export async function listAccounts(userId: number, o: { status?: string; limit: number; offset: number }) {
  await ensureDeskTables();
  const where = and(eq(targetAccountsTable.userId, userId), o.status ? eq(targetAccountsTable.status, o.status) : sql`true`);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(targetAccountsTable).where(where);
  const rows = await db.select().from(targetAccountsTable).where(where).orderBy(desc(targetAccountsTable.createdAt), desc(targetAccountsTable.id)).limit(o.limit).offset(o.offset);
  return { total: Number(n), accounts: await withPeople(rows) };
}

export async function todayView(userId: number) {
  const s = await deskSettings(userId);
  const date = dubaiNow().date;
  const rows = await db.select().from(targetAccountsTable).where(and(eq(targetAccountsTable.userId, userId), eq(targetAccountsTable.runDate, date))).orderBy(targetAccountsTable.id);
  const week = new Date(Date.now() - 7 * 86_400_000);
  const [w] = (await db.execute<any>(sql`
    SELECT
      (SELECT count(*)::int FROM target_accounts WHERE user_id = ${userId} AND created_at >= ${week}) AS companies,
      (SELECT count(*)::int FROM target_people WHERE user_id = ${userId} AND created_at >= ${week}) AS people,
      (SELECT count(*)::int FROM target_people WHERE user_id = ${userId} AND created_at >= ${week} AND email_status IN ('published', 'verified')) AS verified,
      (SELECT count(*)::int FROM target_accounts WHERE user_id = ${userId} AND sent_at >= ${week}) AS sent,
      (SELECT count(*)::int FROM target_accounts WHERE user_id = ${userId} AND opened_at >= ${week}) AS opened,
      (SELECT count(*)::int FROM target_accounts WHERE user_id = ${userId} AND replied_at >= ${week}) AS replied,
      (SELECT count(*)::int FROM target_accounts WHERE user_id = ${userId} AND meeting_at >= ${week}) AS meetings`)).rows;
  const team = await ensureAccountsTeam(userId).catch(() => []);
  const names = new Map(team.map((e) => [e.role, e.name]));
  const feed = await db.select().from(emailAgentActivityTable)
    .where(and(eq(emailAgentActivityTable.userId, userId), inArray(emailAgentActivityTable.role, [...ACCOUNTS_TEAM])))
    .orderBy(desc(emailAgentActivityTable.createdAt)).limit(40);
  return {
    date, perDay: s.perDay, enabled: s.enabled, hasSearchKey: !!s.searchKey, running: running.has(userId), lastRunAt: iso(s.lastRunAt),
    accounts: await withPeople(rows),
    stats: { week: {
      companies: Number(w?.companies ?? 0), people: Number(w?.people ?? 0), verified: Number(w?.verified ?? 0), sent: Number(w?.sent ?? 0),
      opened: Number(w?.opened ?? 0), replied: Number(w?.replied ?? 0), meetings: Number(w?.meetings ?? 0),
    } },
    feed: feed.map((f) => ({ at: iso(f.createdAt)!, role: f.role, name: names.get(f.role as any) ?? nameOf(f.role), text: f.text })),
  };
}

/** Owner actions on one account. False when it is not theirs. */
export async function markAccount(userId: number, id: number, what: "linkedin" | "skip" | "meeting"): Promise<boolean> {
  await ensureDeskTables();
  const [a] = await db.select().from(targetAccountsTable).where(and(eq(targetAccountsTable.id, id), eq(targetAccountsTable.userId, userId))).limit(1);
  if (!a) return false;
  const now = new Date();
  if (what === "linkedin") await db.update(targetAccountsTable).set({ linkedinDone: true, updatedAt: now }).where(eq(targetAccountsTable.id, id));
  if (what === "meeting") await db.update(targetAccountsTable).set({ status: "meeting", meetingAt: a.meetingAt ?? now, updatedAt: now }).where(eq(targetAccountsTable.id, id));
  if (what === "skip") await db.update(targetAccountsTable).set({ status: "skipped", updatedAt: now }).where(eq(targetAccountsTable.id, id));
  if (what !== "linkedin") {
    // Skipped, or a meeting booked: no more cold follow-ups from this desk.
    if (a.sequenceId) await db.execute(sql`UPDATE email_sequence_jobs SET status = 'cancelled', error = 'تخطّاها صاحب العمل في مكتب الحسابات' WHERE sequence_id = ${a.sequenceId} AND status = 'pending'`);
  }
  if (what === "meeting") await deskActivity(userId, "accounts_writer", "meeting", `اجتماع محجوز مع ${a.company} 🎉`, { accountId: id });
  return true;
}
