// ── المدير يقيّم: درجةٌ من أرقام الموظف، ومهمةٌ، ثم مراجعة ─────────
// طلب صاحب العمل: «مدير هو اللي بيديهم المهام، هو اللي بيراجع وراهم، هو
// اللي بيقيّم شغلهم».
//
// والتقييم الذي يكتبه نموذجٌ من انطباعه لا قيمة له: يمدح الجميع بالصفات
// نفسها. فالدرجة هنا حسابٌ من أربعة أشياء تُقاس لكل موظف:
//
//   الاعتمادية   كم من عمله تمّ وكم تعثّر — من الإيصالات.
//   حكم المالك   كم مسودةً أرسلها صاحب العمل كما هي، وكم عدّل أو رفض.
//   الحضور      هل عمل أصلاً في الأسبوع.
//   التواصل     هل سلّم لزميلٍ أو بلّغ مديره — أم يعمل في صمت.
//
// «أوقف شيئاً» لا يُحسب على أحد: الحارس الذي يحجز رسالةً يؤدّي عمله،
// والفرز الذي يقرّر ألا يردّ على آلةٍ كذلك.
//
// ثم لكل موظفٍ **ملاحظةٌ واحدة** — أضعف ما في أرقامه — ومهمةٌ واحدة
// منها، تصله رسالةً من مديره وتدخل تعليماته في ردّه التالي. وفي الدورة
// القادمة تُقارن درجته بسابقتها: «يراجع وراهم» معناها أن يُرى هل تحرّك
// الرقم، لا أن تُكتب مهمةٌ جديدة كل مرة.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, botEmployeesTable } from "@workspace/db";
import { accuracyByRole } from "../feedback";
import { say } from "../agent-comms";
import { receipt } from "../graph/receipts";
import { logger } from "../logger";

export type Grade = "strong" | "ok" | "weak" | "idle" | "off";
export const GRADE_AR: Record<Grade, string> = { strong: "قوي", ok: "مقبول", weak: "ضعيف", idle: "بلا عمل", off: "موقوف" };

export interface Facts {
  /** أعمالٌ تمّت في النافذة. */
  done: number;
  failed: number;
  /** حجزٌ أو رفض — عملٌ لا عثرة. */
  held: number;
  llmCalls: number;
  llmFailed: number;
  /** مسوداتٌ حكم عليها صاحب العمل. */
  decided: number;
  approved: number;
  edited: number;
  rejected: number;
  /** رسائل إلى زملاء، ومنهم. */
  said: number;
  heard: number;
  lastAt: string | null;
  days: number;
}

export interface Evaluation {
  role: string; name: string; title: string | null; avatar: string | null;
  grade: Grade; score: number | null; prevScore: number | null;
  facts: Facts;
  /** أضعف ما في أرقامه — جملةٌ واحدة برقمها. */
  finding: string;
  /** ما يفعله — أو null إن لم يكن ما يُصلَح. */
  task: string | null;
  /** ما تغيّر منذ التقييم السابق. */
  moved: string | null;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * الدرجة من الأرقام. صِرفة: الأرقام نفسها تعطي الدرجة نفسها دائماً.
 * وما لا يُقاس عند موظفٍ لا يُحسب عليه: من لا مسودات له لا يُعاقَب على
 * غياب حكم المالك — توزَّع نقاطه على ما يُقاس.
 */
export function scoreOf(f: Facts): { score: number | null; grade: Exclude<Grade, "off">; parts: Record<string, number | null> } {
  const work = f.done + f.failed + f.held;
  if (work === 0) return { score: null, grade: "idle", parts: { reliability: null, owner: null, comms: null } };
  const attempted = f.done + f.failed;
  const reliability = attempted ? f.done / attempted : 1;
  const owner = f.decided >= 5 ? (f.approved + f.edited * 0.5) / f.decided : null;
  const llm = f.llmCalls >= 5 ? 1 - f.llmFailed / f.llmCalls : null;
  const comms = f.said > 0 ? 1 : f.heard > 0 ? 0.5 : 0;
  // الأوزان: ما يراه العميل أو صاحب العمل أثقل مما يدور في الداخل.
  const items: Array<[number, number | null]> = [[45, reliability], [30, owner], [10, llm], [15, comms]];
  const live = items.filter(([, v]) => v !== null) as Array<[number, number]>;
  const weight = live.reduce((a, [w]) => a + w, 0);
  const score = Math.round(live.reduce((a, [w, v]) => a + w * v, 0) / weight * 100);
  return { score, grade: score >= 80 ? "strong" : score >= 60 ? "ok" : "weak", parts: { reliability: Math.round(reliability * 100), owner: owner === null ? null : Math.round(owner * 100), comms: Math.round(comms * 100) } };
}

/** الملاحظة والمهمة: أضعف ما في الأرقام، بترتيب ما يؤذي أكثر. صِرفة. */
export function findingOf(f: Facts, grade: Grade, managerName: string): { finding: string; task: string | null } {
  if (grade === "off") return { finding: "موقوف بقرار صاحب العمل — لا يُقيَّم.", task: null };
  if (grade === "idle") return {
    finding: `لا عمل مسجّلاً في ${f.days} أيام${f.lastAt ? ` (آخر عملٍ ${new Date(f.lastAt).toISOString().slice(0, 10)})` : ""}.`,
    task: `لم يصلك عملٌ هذا الأسبوع. إن كان عندك ما تنتظره من زميلٍ فقل لـ${managerName} ممّن وماذا — الصمت لا يُحسب انتظاراً.`,
  };
  const attempted = f.done + f.failed;
  if (attempted >= 5 && pct(f.failed, attempted) >= 20) return {
    finding: `${f.failed} من ${attempted} عملاً تعثّر (${pct(f.failed, attempted)}٪).`,
    task: `خُمس عملك يتعثّر. عند كل تعثّرٍ اكتب لـ${managerName} سببه في سطر — نموذجٌ لم يُجب، معلومةٌ ناقصة، قاعدةٌ أوقفتك — ولا تُعِد المحاولة نفسها.`,
  };
  if (f.decided >= 5 && f.rejected / f.decided >= 0.3) return {
    finding: `صاحب العمل رفض ${f.rejected} من ${f.decided} مسودة (${pct(f.rejected, f.decided)}٪).`,
    task: "ثلث مسوداتك يُرفض. قبل أن تكتب، اقرأ ما رُفض في ذاكرتك واسأل: ما الذي جعلها تُرفض؟ ثم اكتب ما لا يحمله.",
  };
  if (f.decided >= 5 && (f.edited + f.rejected) / f.decided >= 0.5) return {
    finding: `صاحب العمل عدّل أو رفض ${f.edited + f.rejected} من ${f.decided} مسودة — أرسل ${f.approved} فقط كما هي.`,
    task: "نصف مسوداتك يُعدَّل قبل الإرسال. طابق مسودتك القادمة بآخر ما عدّله صاحب العمل: ما حذفه احذفه، وما أضافه أضفه من أول مرة.",
  };
  if (f.llmCalls >= 5 && pct(f.llmFailed, f.llmCalls) >= 25) return {
    finding: `${f.llmFailed} من ${f.llmCalls} نداءً للنموذج لم يُجب (${pct(f.llmFailed, f.llmCalls)}٪).`,
    task: null,   // ليس ذنب الموظف: المزوّد. يُرفع لصاحب العمل لا إليه.
  };
  if (f.said === 0 && f.done >= 5) return {
    finding: `${f.done} عملاً في ${f.days} أيام، ولا رسالة واحدة لزميلٍ أو للمدير.`,
    task: `تعمل في صمت. بعد كل دفعة عملٍ اكتب لـ${managerName} سطراً: ماذا أنجزت، وماذا وجدت، وماذا تحتاج — وسلّم من يليك بما يلزمه لا بالعمل وحده.`,
  };
  return { finding: `${f.done} عملاً تمّ${f.failed ? `، ${f.failed} تعثّر` : " بلا تعثّر"}${f.decided >= 5 ? `، وصاحب العمل أرسل ${f.approved} من ${f.decided} مسودة كما هي` : ""}.`, task: null };
}

/** أرقام كل موظفٍ في النافذة — استعلامٌ واحد للإيصالات وواحد للرسائل. */
export async function factsFor(userId: number, roles: string[], days = 7): Promise<Map<string, Facts>> {
  const [rec, msg, acc] = await Promise.all([
    db.execute<any>(sql`
      SELECT node,
        count(*) FILTER (WHERE status = 'ok' AND action NOT LIKE 'llm.%' AND action NOT LIKE 'edge.%')::int AS done,
        count(*) FILTER (WHERE status = 'failed' AND action NOT LIKE 'llm.%')::int                         AS failed,
        count(*) FILTER (WHERE status = 'blocked' AND action NOT LIKE 'llm.%')::int                        AS held,
        count(*) FILTER (WHERE action = 'llm.call')::int                                                   AS llm_calls,
        count(*) FILTER (WHERE action = 'llm.call' AND status <> 'ok')::int                                AS llm_failed,
        max(at) AS last_at
      FROM receipts WHERE user_id = ${userId} AND at > now() - (${days} || ' days')::interval AND node IN (${sql.join(roles.length ? roles.map((r) => sql`${r}`) : [sql`''`], sql`, `)})
      GROUP BY node`),
    db.execute<any>(sql`
      SELECT role, sum(said)::int AS said, sum(heard)::int AS heard FROM (
        SELECT from_role AS role, count(*) AS said, 0 AS heard FROM agent_messages WHERE user_id = ${userId} AND created_at > now() - (${days} || ' days')::interval GROUP BY 1
        UNION ALL
        -- «قيل له» من زميل، لا من مديره ولا من صاحب العمل: أول تشغيلٍ رفع درجة
        -- ثلاثة موظفين من ٧٥ إلى ٨٨ «بعد المهمة» — والذي رفعها رسالة المهمة نفسها.
        SELECT to_role, 0, count(*) FROM agent_messages WHERE user_id = ${userId} AND to_role IS NOT NULL
          AND from_role NOT IN ('chief', 'email_manager', 'engineer', 'owner', 'ig_manager', 'tt_manager', 'li_manager')
          AND created_at > now() - (${days} || ' days')::interval GROUP BY 1
      ) x GROUP BY role`),
    accuracyByRole(userId, Math.max(days, 14)),
  ]);
  // من لا يترك إيصالاً يترك أثراً في سجلّه هو: فهد في تنبيهات التشغيل
  // ومارك في تقارير المراقبة. أول تقييمٍ عدّهما «بلا عمل» وأعطاهما مهمة،
  // وعندهما مئتا تنبيهٍ وأربعمئة تقرير في الأسبوع نفسه.
  const other = await db.execute<any>(sql`
    SELECT 'ops' AS role, count(*)::int AS n, max(created_at) AS last FROM ops_alerts WHERE user_id = ${userId} AND created_at > now() - (${days} || ' days')::interval
    UNION ALL SELECT 'monitor', count(*)::int, max(created_at) FROM monitor_reports WHERE user_id = ${userId} AND created_at > now() - (${days} || ' days')::interval
    UNION ALL SELECT agent_role, count(*)::int, max(created_at) FROM auto_reply_log WHERE user_id = ${userId} AND agent_role IS NOT NULL AND skipped IS NULL AND created_at > now() - (${days} || ' days')::interval GROUP BY agent_role`).catch(() => ({ rows: [] as any[] }));
  const out = new Map<string, Facts>();
  for (const role of roles) {
    const r = rec.rows.find((x: any) => x.node === role), m = msg.rows.find((x: any) => x.role === role), a = acc.get(role) as any;
    const o = other.rows.find((x: any) => x.role === role);
    out.set(role, {
      done: Math.max(Number(r?.done ?? 0), Number(o?.n ?? 0)), failed: Number(r?.failed ?? 0), held: Number(r?.held ?? 0),
      llmCalls: Number(r?.llm_calls ?? 0), llmFailed: Number(r?.llm_failed ?? 0),
      decided: Number(a?.decided ?? 0), approved: Number(a?.approved ?? 0), edited: Number(a?.edited ?? 0), rejected: Number(a?.rejected ?? 0),
      said: Number(m?.said ?? 0), heard: Number(m?.heard ?? 0),
      lastAt: r?.last_at ? new Date(r.last_at).toISOString() : o?.last ? new Date(o.last).toISOString() : null, days,
    });
  }
  return out;
}

/**
 * تقييم مكتبٍ كامل: يُحسب، يُحفظ، وتصل كلَّ موظفٍ مهمتُه من مديره.
 * `announce: false` يحسب ويحفظ بلا رسائل — للعرض بين الدورات.
 */
export async function evaluateDesk(userId: number, opts: { desk: string; manager: string; managerName: string; roles: string[]; days?: number; announce?: boolean }): Promise<Evaluation[]> {
  const staff = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), inArray(botEmployeesTable.role, opts.roles)));
  if (!staff.length) return [];
  const facts = await factsFor(userId, staff.map((s) => s.role), opts.days ?? 7);
  const prev = await db.execute<any>(sql`
    SELECT DISTINCT ON (role) role, score, task, grade FROM employee_evaluations
    WHERE user_id = ${userId} AND desk = ${opts.desk} ORDER BY role, created_at DESC`);
  const out: Evaluation[] = [];
  for (const e of staff) {
    const f = facts.get(e.role)!;
    const s = e.isActive ? scoreOf(f) : { score: null, grade: "off" as Grade };
    const { finding, task } = findingOf(f, s.grade, opts.managerName);
    const p = prev.rows.find((x: any) => x.role === e.role);
    const prevScore = p?.score == null ? null : Number(p.score);
    // المراجعة: هل تحرّك الرقم بعد المهمة السابقة؟
    const moved = prevScore !== null && s.score !== null
      ? (s.score - prevScore >= 5 ? `ارتفع من ${prevScore} إلى ${s.score}${p?.task ? " بعد المهمة السابقة" : ""}`
        : prevScore - s.score >= 5 ? `هبط من ${prevScore} إلى ${s.score}`
        : p?.task ? `بقي عند ${s.score} — المهمة السابقة لم تحرّكه` : null)
      : null;
    out.push({ role: e.role, name: e.name, title: e.title, avatar: e.avatar, grade: s.grade, score: s.score, prevScore, facts: f, finding, task, moved });
    await db.execute(sql`
      INSERT INTO employee_evaluations (user_id, role, desk, manager, score, prev_score, grade, facts, finding, task)
      VALUES (${userId}, ${e.role}, ${opts.desk}, ${opts.manager}, ${s.score}, ${prevScore}, ${s.grade}, ${JSON.stringify(f)}::jsonb, ${finding}, ${task})`);
    receipt({ userId, node: opts.manager, action: "team.evaluate", subject: e.role, evidence: { score: s.score, grade: s.grade, prevScore }, why: finding.slice(0, 300) });
    // المهمة نفسها لا تُعاد كل ست ساعات: تصل مرةً، ثم لا يُكتب له إلا إن
    // تغيّرت المهمة أو تحرّكت درجته. أول تشغيلٍ كان سيرسل للخامل الرسالة
    // ذاتها أربع مرات في اليوم.
    const repeat = !!task && p?.task === task && !moved;
    if (opts.announce !== false && e.isActive && (task || moved) && !repeat) {
      await say({ userId, fromRole: opts.manager, toRole: e.role, kind: "directive",
        body: [`تقييمك هذا الأسبوع: ${s.score ?? "—"}/100 (${GRADE_AR[s.grade]}).`, moved ? `${moved}.` : "", finding, task ?? "استمر."].filter(Boolean).join(" ") });
    }
  }
  logger.info({ userId, desk: opts.desk, n: out.length, weak: out.filter((x) => x.grade === "weak").length, idle: out.filter((x) => x.grade === "idle").length }, "تقييم المكتب");
  return out.sort((a, b) => (a.score ?? -1) - (b.score ?? -1));
}

/** آخر تقييمٍ لكل موظف — للواجهة، بلا حسابٍ جديد ولا رسائل. */
export async function latestEvaluations(userId: number) {
  const r = await db.execute<any>(sql`
    SELECT DISTINCT ON (role) role, desk, manager, score, prev_score AS "prevScore", grade, facts, finding, task, created_at AS at
    FROM employee_evaluations WHERE user_id = ${userId} ORDER BY role, created_at DESC`);
  return r.rows as Array<{ role: string; desk: string; manager: string; score: number | null; prevScore: number | null; grade: Grade; facts: Facts; finding: string; task: string | null; at: string }>;
}

/** الأرقام كما يقرؤها المدير في تقريره. */
export function evaluationFacts(list: Evaluation[]): string {
  if (!list.length) return "لا موظفين للتقييم.";
  return list.map((e) => `• ${e.name} (${e.title ?? e.role}): ${e.score ?? "—"}/100 ${GRADE_AR[e.grade]}${e.moved ? ` — ${e.moved}` : ""}. ${e.finding}${e.task ? " ← أُعطي مهمة." : ""}`).join("\n");
}
