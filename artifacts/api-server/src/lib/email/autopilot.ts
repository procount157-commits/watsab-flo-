// ── The email team on its own ─────────────────────────────────────
// The owner picks the lists (or whole folders) the team works and how much
// say they keep — every campaign waits for approval, or goes out unless the
// guard stops it — and the team runs the rest, every quarter of an hour:
//
//   ماجد   is the sending healthy? If not, nothing new starts this round.
//   يوسف   keeps under each list the lists of what people did — opened and
//          did not reply, clicked, replied, did not open — so the owner sees
//          where everyone is, and each stage can be worked on its own.
//   سلمى   for each list, the next wave of people not yet written to, with
//          the campaign that fits the list's sector, handed to نورة as a
//          mission. One wave at a time per list.
//   يوسف   those who clicked, and those who opened and did not reply, get a
//          wave of their own with a new angle — after the rest days between
//          messages, and under the ceiling of messages a month.
//
// نورة writes each mission, ماجد checks it, the mission engine sends it and
// follows up, and ليلى reads what comes back. Everything each of them did
// goes into the activity feed the dashboard shows.

import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  db, emailAutopilotTable, emailListsTable, emailListMembersTable, emailMissionsTable,
  type EmailAutopilot, type SegmentFilter,
} from "@workspace/db";
import { logger } from "../logger";
import { getSettings, verdictFor } from "./service";
import { isConfigured } from "./provider";
import { count } from "./segments";
import { createMission } from "./missions";
import { activity, ensureEmailTeam, onDuty } from "./team";

export const STAGES = {
  opened:   "فتحوا ولم يردّوا",
  clicked:  "نقروا",
  replied:  "ردّوا",
  unopened: "لم يفتحوا",
} as const;
export type Stage = keyof typeof STAGES;

const DEFAULTS = { enabled: false, mode: "approve", listIds: [] as number[], folderIds: [] as number[], waveSize: 150, followAfterHours: 72, maxTouches: 4, quietDays: 3, language: "en", lastRunAt: null };

export async function getAutopilot(userId: number): Promise<EmailAutopilot> {
  const [row] = await db.select().from(emailAutopilotTable).where(eq(emailAutopilotTable.userId, userId)).limit(1);
  return row ?? ({ userId, ...DEFAULTS, updatedAt: new Date() } as EmailAutopilot);
}

export async function saveAutopilot(userId: number, b: any): Promise<EmailAutopilot> {
  const cur = await getAutopilot(userId);
  const ids = (v: unknown, old: number[]) => (Array.isArray(v) ? v.map(Number).filter((n) => n > 0).slice(0, 200) : old);
  const clamp = (v: unknown, lo: number, hi: number, old: number) => (v === undefined ? old : Math.min(hi, Math.max(lo, Math.floor(Number(v)) || old)));
  const values = {
    userId,
    enabled: b.enabled === undefined ? cur.enabled : !!b.enabled,
    mode: b.mode === "auto" || b.mode === "approve" ? b.mode : cur.mode,
    listIds: ids(b.listIds, cur.listIds as number[]),
    folderIds: ids(b.folderIds, cur.folderIds as number[]),
    waveSize: clamp(b.waveSize, 10, 2000, cur.waveSize),
    followAfterHours: clamp(b.followAfterHours, 24, 24 * 14, cur.followAfterHours),
    maxTouches: clamp(b.maxTouches, 1, 6, cur.maxTouches),
    quietDays: clamp(b.quietDays, 2, 30, cur.quietDays),
    // Every email in English — the owner's rule; the column stays for the record.
    language: "en",
    updatedAt: new Date(),
  };
  const [row] = await db.insert(emailAutopilotTable).values(values).onConflictDoUpdate({ target: emailAutopilotTable.userId, set: values }).returning();
  return row!;
}

/**
 * The lists the team works: those picked, and every list in the picked
 * folders — or, when nothing is picked, every list the account has. Never a
 * stage list.
 */
export async function targetLists(userId: number, cfg: EmailAutopilot) {
  const listIds = cfg.listIds as number[], folderIds = cfg.folderIds as number[];
  if (!listIds.length && !folderIds.length) {
    return db.select().from(emailListsTable).where(and(eq(emailListsTable.userId, userId), sql`${emailListsTable.parentListId} is null`));
  }
  return db.select().from(emailListsTable).where(and(
    eq(emailListsTable.userId, userId), sql`${emailListsTable.parentListId} is null`,
    sql`(${listIds.length ? inArray(emailListsTable.id, listIds) : sql`false`} or ${folderIds.length ? inArray(emailListsTable.folderId, folderIds) : sql`false`})`,
  ));
}

// ── يوسف: the stage lists ─────────────────────────────────────────
/** Who in the list is at each stage, by what they did with what we sent. */
async function stageMembers(listId: number): Promise<Record<Stage, number[]>> {
  const r = await db.execute<{ id: number; stage: Stage }>(sql`
    SELECT c.id,
      CASE
        WHEN c.last_replied_at IS NOT NULL THEN 'replied'
        WHEN EXISTS (SELECT 1 FROM email_messages m WHERE m.contact_id = c.id AND m.clicked_at IS NOT NULL) THEN 'clicked'
        WHEN c.last_opened_at IS NOT NULL THEN 'opened'
        ELSE 'unopened'
      END AS stage
    FROM email_list_members lm
    JOIN email_contacts c ON c.id = lm.contact_id
    WHERE lm.list_id = ${listId} AND c.last_sent_at IS NOT NULL`);
  const out: Record<Stage, number[]> = { opened: [], clicked: [], replied: [], unopened: [] };
  for (const row of r.rows) out[row.stage]?.push(Number(row.id));
  return out;
}

/**
 * Keep the four stage lists under a list: made the first time anyone in it
 * has been written to, in the same folder, and their members replaced with
 * who is at that stage now. Returns how many moved into each.
 */
export async function refreshStageLists(userId: number, parent: { id: number; name: string; folderId: number | null }): Promise<Record<Stage, { total: number; added: number }> | null> {
  const members = await stageMembers(parent.id);
  const reached = Object.values(members).reduce((t, a) => t + a.length, 0);
  if (!reached) return null;
  const existing = await db.select().from(emailListsTable).where(and(eq(emailListsTable.userId, userId), eq(emailListsTable.parentListId, parent.id)));
  const out = {} as Record<Stage, { total: number; added: number }>;
  for (const stage of Object.keys(STAGES) as Stage[]) {
    let list = existing.find((l) => l.stage === stage);
    if (!list) {
      [list] = await db.insert(emailListsTable).values({ userId, name: `${parent.name} ← ${STAGES[stage]}`.slice(0, 160), description: `قائمة مرحلة يحدّثها يوسف تلقائياً من «${parent.name}»`, folderId: parent.folderId, parentListId: parent.id, stage }).returning();
    }
    const want = members[stage];
    // Out: whoever moved on to another stage.
    if (want.length) await db.delete(emailListMembersTable).where(and(eq(emailListMembersTable.listId, list!.id), notInArray(emailListMembersTable.contactId, want)));
    else await db.delete(emailListMembersTable).where(eq(emailListMembersTable.listId, list!.id));
    let added = 0;
    for (let i = 0; i < want.length; i += 1000) {
      const r = await db.insert(emailListMembersTable).values(want.slice(i, i + 1000).map((contactId) => ({ listId: list!.id, contactId }))).onConflictDoNothing().returning({ id: emailListMembersTable.contactId });
      added += r.length;
    }
    out[stage] = { total: want.length, added };
  }
  return out;
}

// ── سلمى: which campaign for which list ───────────────────────────
// The firm's campaign library (A–I in its knowledge base), by sector.
const CAMPAIGNS: Array<{ sectors: string[]; goal: string }> = [
  { sectors: ["عقارات"], goal: "حملة AML للعقارات: وسطاء ووكالات العقارات من فئات DNFBP — الحديث عن العناية الواجبة بالعملاء والمستفيد الحقيقي وتقييم المخاطر والجاهزية للتفتيش، لا التسجيل في goAML وحده. الدعوة: نراجع جاهزيتكم لـ AML." },
  { sectors: ["ذهب ومجوهرات"], goal: "حملة الذهب والمجوهرات: التزامات DPMS ومعرفة العميل والمعاملات النقدية، مع محاسبة المخزون وتكلفة الجرام والهامش. الدعوة: نقيّم التزامات DPMS لديكم." },
  { sectors: ["مقاولات", "مواد بناء"], goal: "حملة تكاليف المقاولات: هل كل مشروع رابح فعلاً؟ تكلفة المشروع والعمالة والمواد والمقاولين من الباطن والميزانية مقابل الفعلي. الدعوة: نناقش حجم عملكم المحاسبي." },
  { sectors: ["مطاعم ومقاهي", "أغذية"], goal: "حملة محاسبة المطاعم: المبيعات ليست ربحاً — تكلفة الطعام والهدر والمخزون وربحية كل فرع. الدعوة: استشارة قصيرة عن ربحية فروعكم." },
  { sectors: ["استشارات", "قانونية", "تقنية", "تسويق وإعلان"], goal: "حملة الشركات القائمة على المشاريع: ربحية كل مشروع وكل عميل وتوزيع تكلفة الموظفين، مع ضريبة الشركات وVAT. الدعوة: نناقش احتياجاتكم." },
  { sectors: ["محاسبة وتدقيق", "خدمات الشركات"], goal: "حملة مسؤول امتثال خارجي (MLRO): المحاسبون المستقلون من فئات DNFBP بحسب إرشادات 2026 — إطار AML والسياسات والتدريب والجاهزية للتفتيش. الدعوة: تقييم امتثال AML." },
];
const DEFAULT_GOAL = "حملة ضريبة الشركات والمحاسبة الخارجية للشركات الصغيرة والمتوسطة: الإقرار خلال تسعة أشهر من نهاية الفترة الضريبية، والسجلات، ومتى تكون الاستعانة بمحاسبة خارجية منطقية. الدعوة: نراجع وضعكم الضريبي.";

/** The sector most of the list is in, and the campaign for it. */
export async function campaignFor(listId: number): Promise<{ sector: string | null; goal: string }> {
  const [r] = (await db.execute<{ sector: string | null }>(sql`
    SELECT c.sector FROM email_list_members lm JOIN email_contacts c ON c.id = lm.contact_id
    WHERE lm.list_id = ${listId} AND c.sector IS NOT NULL GROUP BY c.sector ORDER BY count(*) DESC LIMIT 1`)).rows;
  const sector = r?.sector ?? null;
  const hit = sector ? CAMPAIGNS.find((c) => c.sectors.includes(sector)) : null;
  return { sector, goal: hit?.goal ?? DEFAULT_GOAL };
}

/** Is a mission for this list (or stage list) still in its first send? Then the next wave waits. */
async function busy(listId: number): Promise<boolean> {
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(emailMissionsTable)
    .where(and(eq(emailMissionsTable.sourceListId, listId), eq(emailMissionsTable.status, "active"), inArray(emailMissionsTable.stage, ["draft", "awaiting_approval", "sending"])));
  return Number(r?.n ?? 0) > 0;
}

// ── One round ────────────────────────────────────────────────────
export async function runAutopilot(userId: number, opts: { force?: boolean } = {}): Promise<{ ran: boolean; why?: string; waves: number; nurtures: number; stages: number }> {
  const cfg = await getAutopilot(userId);
  const done = { ran: false, waves: 0, nurtures: 0, stages: 0 };
  if (!cfg.enabled && !opts.force) return { ...done, why: "الطيار الآلي متوقف" };
  await ensureEmailTeam(userId);
  await db.update(emailAutopilotTable).set({ lastRunAt: new Date() }).where(eq(emailAutopilotTable.userId, userId));

  const s = await getSettings(userId);
  if (!isConfigured(s)) {
    await activity(userId, "email_guard", "blocked", "لا مُرسِل مضبوط — لا إرسال حتى تُضبط إعدادات البريد.");
    return { ...done, why: "إعدادات البريد غير مكتملة" };
  }
  // ماجد: a sender in trouble starts nothing new.
  const health = await verdictFor(userId).catch(() => null);
  const healthy = health?.level !== "critical";
  if (!healthy && (await onDuty(userId, "email_guard"))) {
    await activity(userId, "email_guard", "hold", `أوقف الموجات الجديدة: ${(health?.reasons ?? []).slice(0, 2).join(" · ") || "صحة الإرسال حرجة"}`);
  }

  const lists = await targetLists(userId, cfg);
  if (!lists.length) return { ...done, ran: true, why: "لا توجد قوائم بريد بعد — ارفع ملف Excel من «القوائم»" };
  const [{ n: sendable }] = (await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT c.id)::int AS n FROM email_list_members lm JOIN email_contacts c ON c.id = lm.contact_id
    WHERE lm.list_id IN (${sql.join(lists.map((l) => sql`${l.id}`), sql`, `)}) AND c.status = 'active' AND coalesce(c.mx_ok, true)`)).rows as any;
  if (!Number(sendable)) return { ...done, ran: true, why: "القوائم فارغة — لا عناوين يمكن مراسلتها. ارفع ملف Excel من «القوائم»" };
  const followup = await onDuty(userId, "email_followup");
  const strategist = await onDuty(userId, "email_strategist");
  const requireApproval = cfg.mode !== "auto";

  for (const list of lists) {
    // يوسف: where everyone is.
    if (followup) {
      const st = await refreshStageLists(userId, list).catch((err) => { logger.warn({ err: String(err) }, "stage lists failed"); return null; });
      if (st) {
        done.stages++;
        const moved = (Object.keys(STAGES) as Stage[]).filter((k) => st[k].added > 0).map((k) => `${st[k].added} إلى «${STAGES[k]}»`);
        if (moved.length) await activity(userId, "email_followup", "stages", `«${list.name}»: نقل ${moved.join("، ")}.`, { listId: list.id, stages: st });
      }
    }
    if (!healthy) continue;

    // سلمى: the next wave of people not yet written to.
    if (strategist && !(await busy(list.id))) {
      const filter: SegmentFilter = { listIds: [list.id], engagement: ["never_sent"], maxTouches: cfg.maxTouches, take: cfg.waveSize };
      const n = await count(userId, filter, true);
      if (n > 0) {
        const plan = await campaignFor(list.id);
        const m = await createMission(userId, {
          name: `${list.name} — موجة ${new Date().toLocaleDateString("en-GB")}`.slice(0, 160),
          goal: plan.goal, filter, language: cfg.language, requireApproval,
          followAfterHours: cfg.followAfterHours, agentRole: "email", sourceListId: list.id,
        });
        done.waves++;
        await activity(userId, "email_strategist", "wave", `خطّطت موجة لـ ${n} شركة من «${list.name}»${plan.sector ? ` (قطاع ${plan.sector})` : ""} — ${plan.goal.split(":")[0]}. سلّمتها لنورة لتكتبها.`, { listId: list.id, missionId: m.id });
      }
    }

    // يوسف: those who clicked, then those who opened, each its own wave.
    if (followup) {
      const stageLists = await db.select().from(emailListsTable).where(and(eq(emailListsTable.parentListId, list.id), inArray(emailListsTable.stage, ["clicked", "opened"])));
      const rank = (x: { stage: string | null }) => (x.stage === "clicked" ? 0 : 1);
      for (const sl of stageLists.sort((a, b) => rank(a) - rank(b))) {
        if (await busy(sl.id)) continue;
        const filter: SegmentFilter = { listIds: [sl.id], quietDays: cfg.quietDays, maxTouches: cfg.maxTouches };
        const n = await count(userId, filter, true);
        if (!n) continue;
        const plan = await campaignFor(list.id);
        const goal = sl.stage === "clicked"
          ? `متابعة لمن نقر رابطاً في رسالتنا — اهتمام واضح. رسالة قصيرة باسم شركته تبني على ما نقر عليه وتدعوه مباشرة لمكالمة قصيرة أو تقييم مجاني. السياق: ${plan.goal}`
          : `متابعة لمن فتح رسالتنا ولم يرد. زاوية ألم جديدة من قطاعه لم تُذكر من قبل، وسؤال تأهيل واحد يسهل الرد عليه. السياق: ${plan.goal}`;
        const m = await createMission(userId, {
          name: `${list.name} — متابعة ${STAGES[sl.stage as Stage]}`.slice(0, 160),
          goal, filter, language: cfg.language, requireApproval, followAfterHours: cfg.followAfterHours,
          agentRole: "email_followup", sourceListId: sl.id,
        });
        done.nurtures++;
        await activity(userId, "email_followup", "nurture", `بدأ متابعة ${n} ممن ${sl.stage === "clicked" ? "نقروا" : "فتحوا ولم يردّوا"} في «${list.name}» بزاوية جديدة.`, { listId: sl.id, missionId: m.id });
      }
    }
  }
  return { ...done, ran: true };
}

export async function runAllAutopilots(): Promise<void> {
  const rows = await db.select({ userId: emailAutopilotTable.userId }).from(emailAutopilotTable).where(eq(emailAutopilotTable.enabled, true));
  for (const r of rows) {
    try { await runAutopilot(r.userId); }
    catch (err) { logger.warn({ userId: r.userId, err: String((err as any)?.message ?? err) }, "autopilot round failed"); }
  }
}

export function startAutopilotWorker(): void {
  setTimeout(() => {
    void runAllAutopilots();
    setInterval(() => void runAllAutopilots(), 15 * 60_000);
  }, 120_000);
  logger.info("الطيار الآلي للبريد بدأ");
}
