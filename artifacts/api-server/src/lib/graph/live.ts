// ── The living graph: who is where, who talks to whom, what just happened ──
// The data behind the owner's map of the team. Employees are grouped into
// desks around the manager, each desk round its lead; the code that sorts,
// guards and sends (router, gate, sender, campaigns) sits in a desk of its
// own, so a message can be seen travelling from the employee who wrote it to
// the one that let it out. Every line is earned: an organisational line from
// member to lead and lead to manager, and a working line wherever receipts
// show work passing — weighted by how often.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type Desk = { key: string; label: string; lead: string; members: string[] };

/** The desks, by role. A role matching none goes to «أخرى». Pure. */
export const DESKS: Array<{ key: string; label: string; lead: string; match: (r: string) => boolean }> = [
  { key: "sales", label: "مبيعات واتساب", lead: "sales", match: (r) => ["sales", "support", "followup", "proposals"].includes(r) },
  { key: "email", label: "التسويق بالبريد", lead: "email_strategist", match: (r) => r === "email" || r.startsWith("email_") },
  { key: "ops", label: "التشغيل والبيانات", lead: "ops", match: (r) => ["ops", "monitor", "intake", "collector"].includes(r) },
  { key: "groups", label: "قروبات العملاء", lead: "groups", match: (r) => r === "groups" },
  { key: "instagram", label: "إنستجرام", lead: "ig_manager", match: (r) => r.startsWith("ig_") },
  { key: "tiktok", label: "تيك توك", lead: "tt_manager", match: (r) => r.startsWith("tt_") },
  { key: "linkedin", label: "لينكدإن", lead: "li_manager", match: (r) => r.startsWith("li_") },
  { key: "system", label: "النظام", lead: "router", match: (r) => ["router", "gate", "sender", "campaign", "reviewer", "unattributed"].includes(r) },
];
export const deskOf = (role: string) => (role === "chief" ? "center" : DESKS.find((d) => d.match(role))?.key ?? "other");

const SYSTEM: Record<string, { name: string; title: string }> = {
  router: { name: "الفرز", title: "يقرر من يرد ومن لا" },
  gate: { name: "البوابة", title: "حدود الإرسال والإيقاف" },
  sender: { name: "المُرسِل", title: "واتساب والإيميل" },
  campaign: { name: "الحملات", title: "رسائل الحملات" },
};

/** What the last receipt says the employee is doing, in a few words. Pure. */
export function doing(action: string, status: string): string {
  if (status === "failed") return "تعثّر";
  if (status === "blocked") return action === "llm.call" ? "موقوف" : action === "decide" ? "قرر ألا يرد" : "أوقف شيئاً";
  const m: Record<string, string> = {
    "reply": "ردّ على عميل", "llm.call": "يفكّر", "llm.daily": "عمل اليوم", "send.whatsapp": "أرسل واتساب", "send.whatsapp.daily": "أرسل حملة",
    "send.email": "أرسل إيميلاً", "send.email.daily": "أرسل إيميلات", "followup.draft": "كتب متابعة", "followup.sent": "أرسل متابعة",
    "followup.decline": "قرر ألا يتابع", "optout.stop": "أوقف رقماً ٥ أشهر", "email.write": "كتب حملة", "email.wave": "خطط موجة",
    "email.clean": "نظّف القوائم", "email.pass": "أجاز حملة", "email.hold": "أوقف حملة", "email.reply": "رد على إيميل", "email.stages": "رتّب المراحل",
    "email.needs_owner": "يحتاج قرارك", "email.check": "راجع المُرسِل", "email.send": "أطلق حملة", "email.create": "أنشأ حملة",
    "email.autopilot": "شغّل الطيار الآلي", "email.resume": "استأنف الإرسال", "email.nurture": "بدأ متابعة", "email.blocked": "أوقف الإرسال",
    "edge.report": "رفع تقريراً", "edge.handoff": "سلّم محادثة", "edge.request": "طلب من زميل", "edge.alert": "نبّه",
  };
  if (m[action]) return m[action]!;
  if (action.startsWith("edge.")) return "راسل زميلاً";
  if (action.startsWith("social.")) return "نشاط سوشيال";
  return action;
}

export async function liveGraph(userId: number) {
  const [staff, work, flows, events, totals] = await Promise.all([
    db.execute<{ role: string; name: string; title: string | null; avatar: string | null; is_active: boolean }>(sql`
      SELECT role, name, title, avatar, is_active FROM bot_employees WHERE user_id = ${userId} ORDER BY priority, id`),
    db.execute<{ node: string; d1: number; d14: number; tokens: number; bad1: number; last: Date; last_action: string; last_status: string; last_why: string | null }>(sql`
      SELECT node,
        count(*) FILTER (WHERE at > now() - interval '1 day')::int AS d1,
        count(*)::int AS d14,
        coalesce(sum(coalesce(tokens_in,0) + coalesce(tokens_out,0)), 0)::int AS tokens,
        count(*) FILTER (WHERE at > now() - interval '1 day' AND status IN ('failed'))::int AS bad1,
        max(at) AS last,
        (array_agg(action ORDER BY at DESC))[1] AS last_action,
        (array_agg(status ORDER BY at DESC))[1] AS last_status,
        (array_agg(why ORDER BY at DESC))[1] AS last_why
      FROM receipts WHERE user_id = ${userId} AND at > now() - interval '14 days' GROUP BY node`),
    // Work passing between two nodes: a message from one employee to another,
    // or a decision whose next step was named.
    db.execute<{ a: string; b: string; n: number }>(sql`
      SELECT node AS a, edge AS b, count(*)::int AS n FROM receipts
      WHERE user_id = ${userId} AND at > now() - interval '14 days' AND edge IS NOT NULL AND edge <> 'all' AND edge <> node
      GROUP BY node, edge`),
    db.execute<{ id: number; at: Date; node: string; edge: string | null; action: string; status: string; why: string | null; inferred: boolean }>(sql`
      SELECT id, at, node, edge, action, status, left(why, 160) AS why, inferred FROM receipts
      WHERE user_id = ${userId} ORDER BY id DESC LIMIT 80`),
    db.execute<{ runs: number; live: number }>(sql`SELECT count(*)::int AS runs, count(*) FILTER (WHERE NOT inferred)::int AS live FROM receipts WHERE user_id = ${userId}`),
  ]);

  const w = new Map(work.rows.map((r) => [r.node, r]));
  const people = staff.rows.map((e) => ({ id: e.role, name: e.name, title: e.title ?? "", avatar: e.avatar, kind: "agent" as const, isActive: e.is_active }));
  // The code nodes that appear in the receipts.
  const system = Object.keys(SYSTEM).filter((k) => w.has(k)).map((k) => ({ id: k, name: SYSTEM[k]!.name, title: SYSTEM[k]!.title, avatar: null, kind: "system" as const, isActive: true }));
  const nodes = [...people, ...system].map((p) => {
    const r = w.get(p.id);
    const days = r ? (Date.now() - new Date(r.last).getTime()) / 86_400_000 : 99;
    const state = !p.isActive ? "off" : !r ? "idle" : r.bad1 > 0 || r.last_status === "failed" ? "attention" : days < 1 ? "active" : days < 7 ? "quiet" : "idle";
    return {
      ...p, desk: deskOf(p.id), state,
      acts1d: r?.d1 ?? 0, acts14d: r?.d14 ?? 0, tokens14d: r?.tokens ?? 0, last: r?.last ?? null,
      label: !p.isActive ? "موقوف" : r ? doing(r.last_action, r.last_status) : "بلا إيصالات",
      lastWhy: r?.last_why ?? null,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));

  // The desks that have anyone in them, with a lead who exists.
  const desks: Desk[] = DESKS.map((d) => {
    const members = nodes.filter((n) => n.desk === d.key).map((n) => n.id);
    const lead = members.includes(d.lead) ? d.lead : members[0] ?? d.lead;
    return { key: d.key, label: d.label, lead, members };
  }).filter((d) => d.members.length);

  // Lines: member to lead, lead to the manager — and the work that actually passed.
  const edges: Array<{ from: string; to: string; kind: "org" | "flow"; n: number }> = [];
  const centre = ids.has("chief") ? "chief" : null;
  for (const d of desks) {
    for (const m of d.members) if (m !== d.lead) edges.push({ from: m, to: d.lead, kind: "org", n: 0 });
    if (centre && d.key !== "system") edges.push({ from: d.lead, to: centre, kind: "org", n: 0 });
  }
  if (ids.has("router") && ids.has("sales")) edges.push({ from: "router", to: "sales", kind: "flow", n: w.get("router")?.d14 ?? 0 });
  if (ids.has("sales") && ids.has("sender")) edges.push({ from: "sales", to: "sender", kind: "flow", n: w.get("sales")?.d14 ?? 0 });
  if (ids.has("followup") && ids.has("sender")) edges.push({ from: "followup", to: "sender", kind: "flow", n: w.get("followup")?.d14 ?? 0 });
  if (ids.has("email") && ids.has("email_guard")) edges.push({ from: "email", to: "email_guard", kind: "flow", n: w.get("email")?.d14 ?? 0 });
  if (ids.has("email_guard") && ids.has("sender")) edges.push({ from: "email_guard", to: "sender", kind: "flow", n: w.get("email_guard")?.d14 ?? 0 });
  for (const f of flows.rows) if (ids.has(f.a) && ids.has(f.b)) edges.push({ from: f.a, to: f.b, kind: "flow", n: f.n });

  const t = totals.rows[0] as any;
  return {
    stats: {
      employees: people.length, active: people.filter((p) => p.isActive).length,
      withReceipts: people.filter((p) => w.has(p.id)).length, desks: desks.filter((d) => d.key !== "system").length,
      runs: Number(t?.runs ?? 0), live: Number(t?.live ?? 0),
    },
    desks, nodes, edges,
    events: events.rows.map((e) => ({ ...e, label: doing(e.action, e.status) })),
  };
}
