// ── Upload a list; the team does the rest ─────────────────────────
// The owner's words: "I only add the list. One of them cleans and analyses
// it and recommends, hands it to the writer, the writer writes and hands it
// to the campaign manager, who shows it to me; I approve and it goes." So an
// upload starts the chain at once — not at the next quarter-hour round, and
// not only if the autopilot was switched on:
//
//   ماجد   checks the mail servers of the new addresses and takes out of the
//          list whoever cannot or must not be written to;
//   سلمى   reads the list — its sectors, its quality, what overlaps with
//          lists already worked — writes her recommendations, and turns the
//          top ones (at most three) into missions, each with a brief;
//   نورة   writes each mission from its brief (the mission engine, at once);
//   ماجد   checks what she wrote;
//   طارق   prepares the campaign for the owner — who, how many, how long it
//          takes at today's sending allowance, the follow-ups — and asks;
//   the owner approves, and the campaign goes.
//
// Every step is a receipt. سلمى's reading is kept on the list, so the owner
// can see why each campaign was made.

import { and, eq, sql } from "drizzle-orm";
import { db, emailListsTable, emailMissionsTable } from "@workspace/db";
import { verifyDomains, cleanList, hygieneReport } from "./hygiene";
import { activity } from "./team";
import { getAutopilot, busy, unsentBySector, campaignForSector, MIN_SECTOR } from "./autopilot";
import { createMission, runMission } from "./missions";
import { getSettings } from "./service";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { logger } from "../logger";

const n = (x: number) => x.toLocaleString("en");
export const MAX_RECOMMENDED = 3;

export type Recommendation = { sector: string; n: number; goal: string; angle: string; priority: number; why: string; insight?: string };
export type Analysis = {
  total: number; sendable: number; alreadyWritten: number;
  bounced: number; unsubscribed: number; deadDomain: number; unverified: number;
  role: number; personal: number; risk: { low: number; medium: number; high: number };
  sectors: Array<{ sector: string; n: number }>;
  cities: Array<{ city: string; n: number }>;
  overlap: Array<{ listId: number; name: string; shared: number }>;
  problems: string[];
  recommendations: Recommendation[];
};

/**
 * سلمى's recommendations from the numbers. Pure: biggest sector first, but a
 * sector the firm has a written campaign for ranks above one it does not;
 * too small a sector gets none.
 */
export function recommend(sectors: Array<{ sector: string; n: number }>, opts: { min?: number; max?: number } = {}): Recommendation[] {
  const min = opts.min ?? MIN_SECTOR, max = opts.max ?? MAX_RECOMMENDED;
  return sectors
    .filter((s) => s.n >= min)
    .map((s) => {
      const goal = campaignForSector(s.sector);
      const own = !goal.startsWith("حملة ضريبة الشركات والمحاسبة الخارجية");
      return {
        sector: s.sector, n: s.n, goal, angle: goal.split(":")[0]!,
        priority: s.n * (own ? 2 : 1),
        why: own ? `${n(s.n)} لم يُراسَلوا من «${s.sector}»، ولهذا القطاع حملة مكتوبة في مكتبة الشركة` : `${n(s.n)} لم يُراسَلوا من «${s.sector}» — لا حملة خاصة به، فالحملة العامة (ضريبة الشركات والمحاسبة)`,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, max);
}

/** What is wrong with the list, in words the owner can act on. Pure. */
export function problemsOf(a: Pick<Analysis, "total" | "sendable" | "deadDomain" | "risk" | "overlap" | "alreadyWritten" | "role">): string[] {
  const out: string[] = [];
  if (a.deadDomain) out.push(`${n(a.deadDomain)} عنوان في نطاقات بلا خادم بريد — أُخرجت`);
  if (a.risk.high) out.push(`${n(a.risk.high)} عنوان عالي الخطورة (شخصي في شركة ارتد فيها بريد) — يُمسك حتى يتحسن المُرسِل`);
  for (const o of a.overlap.slice(0, 2)) if (o.shared >= a.total * 0.8) out.push(`القائمة تكاد تطابق «${o.name}» (${n(o.shared)} مشترك) — لن يُراسَل أحد مرتين`);
  if (a.alreadyWritten && a.alreadyWritten >= a.total * 0.5) out.push(`${n(a.alreadyWritten)} منهم راسلناهم من قبل — الموجات للباقين فقط`);
  if (a.total && a.role / a.total > 0.7) out.push(`أغلبها عناوين عامة (info@ وأمثالها) — تصل غالباً لموظف لا لصاحب القرار، فالعنوان يجب أن يذكر الشركة`);
  if (!a.sendable) out.push("لا يوجد في القائمة من يمكن مراسلته الآن");
  return out;
}

export async function analyzeList(userId: number, listId: number): Promise<Analysis> {
  const [health, sectors, cities, overlap, counts] = await Promise.all([
    hygieneReport(userId, listId),
    unsentBySector(listId),
    db.execute<{ city: string; n: number }>(sql`SELECT coalesce(nullif(c.city, ''), '—') AS city, count(*)::int AS n FROM email_list_members m JOIN email_contacts c ON c.id = m.contact_id
      WHERE m.list_id = ${listId} GROUP BY 1 ORDER BY 2 DESC LIMIT 6`),
    db.execute<{ list_id: number; name: string; shared: number }>(sql`SELECT o.list_id, l.name, count(*)::int AS shared FROM email_list_members m
      JOIN email_list_members o ON o.contact_id = m.contact_id AND o.list_id <> m.list_id
      JOIN email_lists l ON l.id = o.list_id AND l.parent_list_id IS NULL
      WHERE m.list_id = ${listId} GROUP BY o.list_id, l.name ORDER BY 3 DESC LIMIT 3`),
    db.execute<{ sendable: number; written: number }>(sql`SELECT count(*) FILTER (WHERE c.status = 'active' AND coalesce(c.mx_ok, true))::int AS sendable,
      count(*) FILTER (WHERE c.last_sent_at IS NOT NULL)::int AS written FROM email_list_members m JOIN email_contacts c ON c.id = m.contact_id WHERE m.list_id = ${listId}`),
  ]);
  const c = counts.rows[0] as any;
  const base = {
    total: health.total, sendable: Number(c?.sendable ?? 0), alreadyWritten: Number(c?.written ?? 0),
    bounced: health.bounced, unsubscribed: health.unsubscribed, deadDomain: health.deadDomain, unverified: health.unverified,
    role: health.role, personal: health.personal, risk: health.risk,
    sectors, cities: cities.rows.map((r) => ({ city: r.city, n: Number(r.n) })),
    overlap: overlap.rows.map((r) => ({ listId: Number(r.list_id), name: r.name, shared: Number(r.shared) })),
  };
  return { ...base, problems: problemsOf(base), recommendations: recommend(sectors) };
}

/**
 * سلمى's insight per recommended segment: one model call, a line each on who
 * these people are and the angle that would make them reply. Without a
 * model, the library's angle stands.
 */
async function insights(userId: number, list: string, recs: Recommendation[]): Promise<Recommendation[]> {
  if (!recs.length) return recs;
  const out = await asAgent(userId, "email_strategist", () => complete([
    { role: "system", content: "أنت سلمى، مخططة الحملات والجمهور لدى بروكاونت للمحاسبة. لكل شريحة اكتب سطراً واحداً: من هم هؤلاء عملياً، وأي زاوية من الحملة المذكورة ستجعل صاحب القرار يرد. لا أرقام ولا قوانين من عندك. أجب بنفس ترتيب الشرائح، سطر لكل شريحة يبدأ برقمها، بلا مقدمات." },
    { role: "user", content: `القائمة: «${list}»\n${recs.map((r, i) => `${i + 1}. ${r.sector} — ${r.n} شركة — الحملة: ${r.goal}`).join("\n")}` },
  ], 30_000)).catch(() => null);
  const lines = (out?.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return recs.map((r, i) => {
    const line = lines.find((l) => new RegExp(`^${i + 1}[.)\\-:]`).test(l) || l.startsWith(`${i + 1} `));
    return line ? { ...r, insight: line.replace(/^\d+[.)\-:\s]+/, "").slice(0, 300) } : r;
  });
}

/** The whole chain for one uploaded list. Safe to run again: busy sectors are skipped. */
export async function runPipeline(userId: number, listId: number): Promise<{ analysis: Analysis; missions: number[] }> {
  const [list] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
  if (!list) throw new Error("القائمة غير موجودة");
  const s = await getSettings(userId);

  // ماجد: mail servers, then out with whoever cannot be written to.
  const ids = (await db.execute<{ id: number }>(sql`SELECT c.id FROM email_list_members m JOIN email_contacts c ON c.id = m.contact_id WHERE m.list_id = ${listId} AND c.mx_ok IS NULL`)).rows.map((r) => Number(r.id));
  if (ids.length) await verifyDomains(userId, ids, { maxDomains: 800 }).catch(() => null);
  const cleaned = await cleanList(userId, listId, { risky: !!s?.skipRisky }).catch(() => null);
  await activity(userId, "email_guard", "clean", `استلمت «${list.name}»: فحصت خوادم البريد${cleaned?.removed ? ` وأخرجت ${n(cleaned.removed)} لا يصلحون للمراسلة` : " — القائمة نظيفة"}. سلّمتها لسلمى.`, { listId });

  // سلمى: the reading, the recommendations, the briefs.
  const a = await analyzeList(userId, listId);
  a.recommendations = await insights(userId, list.name, a.recommendations);
  await db.update(emailListsTable).set({ analysis: a as any, analyzedAt: new Date() }).where(eq(emailListsTable.id, listId));
  await activity(userId, "email_strategist", "analyze",
    [`حللت «${list.name}»: ${n(a.total)} عنوان، ${n(a.sendable)} يمكن مراسلتهم، ${a.sectors.length} قطاع.`,
     ...a.problems.map((p) => `• ${p}`),
     a.recommendations.length ? `أوصي بـ ${a.recommendations.length} حملة: ${a.recommendations.map((r) => `${r.sector} (${n(r.n)})`).join("، ")}.` : "لا شريحة كبيرة بما يكفي لحملة خاصة."].join("\n"),
    { listId, recommendations: a.recommendations.map((r) => r.sector) });

  const cfg = await getAutopilot(userId);
  const missions: number[] = [];
  for (const r of a.recommendations) {
    if (await busy(listId, r.sector)) continue;
    const brief = [r.goal, "", `موجز سلمى: ${r.why}.`, r.insight ? `من هم وما الزاوية: ${r.insight}` : ""].filter(Boolean).join("\n");
    const m = await createMission(userId, {
      name: `${r.sector} — ${list.name}`.slice(0, 160), goal: brief,
      filter: { listIds: [listId], sectors: [r.sector], engagement: ["never_sent"], maxTouches: cfg.maxTouches, take: cfg.waveSize },
      language: cfg.language, requireApproval: cfg.mode !== "auto", followAfterHours: cfg.followAfterHours,
      agentRole: "email", sourceListId: listId,
    });
    missions.push(m.id);
    await activity(userId, "email_strategist", "wave", `سلّمت نورة موجز «${r.sector}» (${n(Math.min(r.n, cfg.waveSize))} شركة في الموجة الأولى من ${n(r.n)}) لتكتبه.`, { listId, missionId: m.id });
  }

  // نورة writes now, not at the next sweep; ماجد and طارق follow inside the mission.
  for (const id of missions) {
    const [m] = await db.select().from(emailMissionsTable).where(eq(emailMissionsTable.id, id)).limit(1);
    if (m) await runMission(m).catch((err) => logger.warn({ userId, missionId: id, err: String(err?.message ?? err) }, "mission first step failed — the sweep will retry"));
  }
  logger.info({ userId, listId, recommended: a.recommendations.length, missions: missions.length }, "سلسلة القائمة اكتملت حتى الموافقة");
  return { analysis: a, missions };
}
