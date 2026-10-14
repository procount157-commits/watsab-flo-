// ── غرفة الفريق: كل الموظفين، وكلامهم لبعض، ومن يتكلّم ومن يصمت ──────
// طلب صاحب العمل: «داشبورد تفاعلية فيها كل الموظفين، وفيها كلامهم لبعض،
// وفيها إذا هم بيتكلموا مع بعض ولا لأ، وفيها تفاصيل أكثر».
//
// والجواب عن «هل يتكلّمون؟» كان قبل هذه الغرفة: لا. في شهرٍ كامل: مئةٌ
// وخمسة وثلاثون تنبيهاً باتجاهٍ واحد، وفريق البريد كله صفر رسائل. فالغرفة
// لا تزيّن ذلك: تعرض لكل موظفٍ ما قاله وما قيل له، ومصفوفة من يكلّم من،
// وتسمّي الصامت صامتاً.
//
// ولا شيء هنا يستدعي نموذجاً: كل ما فيها مقروءٌ من الرسائل والإيصالات
// والتقييمات. فتُفتح فوراً وتُحدَّث كل بضع ثوانٍ.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { liveGraph } from "../graph/live";
import { GRAPHS, NODE_AR, nodeBrief } from "../graph/contracts";
import { charterOf } from "../roles/charters";
import { latestEvaluations, GRADE_AR } from "./evaluate";
import { say } from "../agent-comms";

const KIND_AR: Record<string, string> = { handoff: "تسليم", directive: "توجيه", alert: "تنبيه", report: "تقرير", question: "سؤال", answer: "جواب" };

/** من يُدير من — المدير المباشر لكل دور. */
export function managerOf(role: string): string | null {
  if (role === "engineer") return "owner";
  if (role === "chief" || role === "email_manager" || /^(ig|tt|li)_manager$/.test(role)) return "engineer";
  if (role === "email" || role.startsWith("email_")) return "email_manager";
  if (role.startsWith("ig_")) return "ig_manager";
  if (role.startsWith("tt_")) return "tt_manager";
  if (role.startsWith("li_")) return "li_manager";
  return "chief";
}

export async function teamRoom(userId: number, opts: { days?: number } = {}) {
  const days = opts.days ?? 7;
  const [live, evals, msgs, pairs, tasks] = await Promise.all([
    liveGraph(userId),
    latestEvaluations(userId),
    db.execute<any>(sql`
      SELECT id, from_role AS "from", to_role AS "to", kind, body, phone, read_at AS "readAt", created_at AS at
      FROM agent_messages WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 300`),
    db.execute<any>(sql`
      SELECT from_role AS "from", coalesce(to_role, 'all') AS "to", count(*)::int AS n, max(created_at) AS last,
             count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS d1
      FROM agent_messages WHERE user_id = ${userId} AND created_at > now() - (${days} || ' days')::interval
      GROUP BY 1, 2 ORDER BY 3 DESC`),
    db.execute<any>(sql`SELECT role, task FROM agent_tasks WHERE user_id = ${userId} AND is_active ORDER BY role, sort_order`),
  ]);

  const names: Record<string, string> = { owner: "صاحب العمل", all: "الجميع" };
  for (const n of live.nodes) names[n.id] = n.name;
  const said = new Map<string, number>(), heard = new Map<string, number>(), partners = new Map<string, Set<string>>();
  for (const p of pairs.rows) {
    said.set(p.from, (said.get(p.from) ?? 0) + Number(p.n));
    if (p.to !== "all") heard.set(p.to, (heard.get(p.to) ?? 0) + Number(p.n));
    (partners.get(p.from) ?? partners.set(p.from, new Set()).get(p.from)!).add(p.to);
    if (p.to !== "all") (partners.get(p.to) ?? partners.set(p.to, new Set()).get(p.to)!).add(p.from);
  }
  const graphOf = (role: string) => GRAPHS.find((g) => g.nodes.some((n) => n.id === role));

  const people = live.nodes.filter((n) => n.kind === "agent").map((n) => {
    const ev = evals.find((e) => e.role === n.id);
    const s = said.get(n.id) ?? 0, h = heard.get(n.id) ?? 0;
    const charter = charterOf(n.id);
    const g = graphOf(n.id);
    return {
      role: n.id, name: n.name, title: n.title, avatar: n.avatar, desk: n.desk, isActive: n.isActive,
      state: n.state, doing: n.label, lastWhy: n.lastWhy, last: n.last, acts1d: n.acts1d, acts14d: n.acts14d,
      manager: managerOf(n.id), managerName: names[managerOf(n.id) ?? ""] ?? null,
      said: s, heard: h, partners: [...(partners.get(n.id) ?? [])].map((r) => names[r] ?? r),
      // الصمت يُسمّى: يعمل ولا يكلّم أحداً، أو لا يعمل ولا يكلّم.
      talk: !n.isActive ? "off" : s > 0 && h > 0 ? "both" : s > 0 ? "speaks" : h > 0 ? "listens" : "silent",
      evaluation: ev ? { score: ev.score, prevScore: ev.prevScore, grade: ev.grade, gradeLabel: GRADE_AR[ev.grade], finding: ev.finding, task: ev.task, at: ev.at, facts: ev.facts } : null,
      charter: charter ?? null,
      graph: g ? { id: g.id, node: NODE_AR[n.id] ?? n.name } : null,
      tasks: tasks.rows.filter((t: any) => t.role === n.id).map((t: any) => t.task),
    };
  });

  const messages = msgs.rows.map((m: any) => ({ ...m, to: m.to ?? "all", fromName: names[m.from] ?? m.from, toName: names[m.to ?? "all"] ?? m.to, kindLabel: KIND_AR[m.kind] ?? m.kind }));
  const active = people.filter((p) => p.isActive);
  const silent = active.filter((p) => p.talk === "silent");
  const oneWay = pairs.rows.filter((p: any) => p.to !== "all" && !pairs.rows.some((q: any) => q.from === p.to && q.to === p.from));

  return {
    days,
    stats: {
      people: people.length, active: active.length,
      talking: active.filter((p) => p.talk !== "silent").length, silent: silent.length,
      messages: pairs.rows.reduce((n: number, p: any) => n + Number(p.n), 0),
      messages1d: pairs.rows.reduce((n: number, p: any) => n + Number(p.d1), 0),
      pairs: pairs.rows.length, twoWay: pairs.rows.length - oneWay.length,
      evaluated: people.filter((p) => p.evaluation).length,
      weak: people.filter((p) => p.evaluation?.grade === "weak").length,
    },
    // الجواب المباشر عن سؤال صاحب العمل، برقمه.
    verdict: !pairs.rows.length ? `لا رسالة واحدة بين الموظفين في ${days} أيام — يعملون كلٌّ وحده.`
      : `${active.length - silent.length} من ${active.length} موظفاً تبادلوا رسائل في ${days} أيام (${pairs.rows.reduce((n: number, p: any) => n + Number(p.n), 0)} رسالة بين ${pairs.rows.length} زوجاً)${silent.length ? `، و${silent.length} صامتون: ${silent.slice(0, 6).map((p) => p.name).join("، ")}${silent.length > 6 ? "…" : ""}` : ""}.${oneWay.length ? ` ${oneWay.length} خطاً باتجاهٍ واحد — يُبلَّغ ولا يُجاب.` : ""}`,
    desks: live.desks.filter((d) => d.key !== "system").map((d) => ({ key: d.key, label: d.label, lead: d.lead, leadName: names[d.lead] ?? d.lead, members: d.members })),
    people,
    pairs: pairs.rows.map((p: any) => ({ ...p, fromName: names[p.from] ?? p.from, toName: names[p.to] ?? p.to, twoWay: pairs.rows.some((q: any) => q.from === p.to && q.to === p.from) })),
    messages,
    events: live.events.slice(0, 40).map((e) => ({ ...e, nodeName: names[e.node] ?? e.node, edgeName: e.edge ? names[e.edge] ?? e.edge : null })),
    names,
  };
}

/** موظفٌ واحد بكل ما عنه: موقعه في القراف، ومحادثاته، وآخر ما فعل. */
export async function employeeDetail(userId: number, role: string) {
  const [msgs, recs, hist] = await Promise.all([
    db.execute<any>(sql`
      SELECT id, from_role AS "from", coalesce(to_role, 'all') AS "to", kind, body, created_at AS at
      FROM agent_messages WHERE user_id = ${userId} AND (from_role = ${role} OR to_role = ${role}) ORDER BY created_at DESC LIMIT 60`),
    db.execute<any>(sql`
      SELECT at, graph, action, status, subject, edge, left(why, 220) AS why FROM receipts
      WHERE user_id = ${userId} AND node = ${role} ORDER BY id DESC LIMIT 40`),
    db.execute<any>(sql`
      SELECT score, grade, finding, task, created_at AS at FROM employee_evaluations
      WHERE user_id = ${userId} AND role = ${role} ORDER BY created_at DESC LIMIT 12`),
  ]);
  const g = GRAPHS.find((x) => x.nodes.some((n) => n.id === role));
  return {
    role, messages: msgs.rows, receipts: recs.rows, history: hist.rows,
    node: g ? nodeBrief(g, role) : null,
    kinds: KIND_AR,
  };
}

/** صاحب العمل يكتب لموظف — توجيهٌ يدخل تعليماته في عمله التالي. */
export async function ownerSays(userId: number, toRole: string, body: string) {
  await say({ userId, fromRole: "owner", toRole, kind: "directive", body });
}
