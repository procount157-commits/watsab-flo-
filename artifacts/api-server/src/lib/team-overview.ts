// ── The whole team on one page ────────────────────────────────────
// Forty-odd employees across WhatsApp, email, the customer groups and three
// social desks, and until now no single place that showed them together: who
// is on, what each did this week, how often the owner sent their draft as it
// was, and what each costs in model calls.

import { and, eq, sql } from "drizzle-orm";
import { db, botEmployeesTable } from "@workspace/db";
import { accuracyByRole, usageByRole } from "./feedback";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { teamVoice, EMAIL_TEAM, type EmailRole } from "./email/team";
import { voiceFor, jobOf } from "./social/team";
import { PLATFORM, type SocialPlatform } from "./social/platforms";
import { corePrompt } from "./prompt-core";

export const DEPARTMENTS: Array<{ key: string; label: string; match: (role: string) => boolean }> = [
  { key: "core", label: "واتساب والإدارة", match: (r) => ["chief", "sales", "support", "followup", "intake", "collector", "ops", "monitor"].includes(r) },
  { key: "email", label: "التسويق بالبريد", match: (r) => r === "email" || r.startsWith("email_") },
  { key: "groups", label: "قروبات العملاء", match: (r) => r === "groups" },
  { key: "instagram", label: "إنستجرام", match: (r) => r.startsWith("ig_") },
  { key: "tiktok", label: "تيك توك", match: (r) => r.startsWith("tt_") },
  { key: "linkedin", label: "لينكدإن", match: (r) => r.startsWith("li_") },
];
export const departmentOf = (role: string) => DEPARTMENTS.find((d) => d.match(role))?.key ?? "other";

export async function teamOverview(userId: number) {
  const [staff, acc, use, work] = await Promise.all([
    db.select().from(botEmployeesTable).where(eq(botEmployeesTable.userId, userId)),
    accuracyByRole(userId, 30),
    usageByRole(userId, 30),
    // Every desk keeps its own log of what its employees did; this reads them all.
    db.execute<{ role: string; n: number; last: string | null }>(sql`
      SELECT role, sum(n)::int AS n, max(last) AS last FROM (
        SELECT role, count(*) AS n, max(created_at) AS last FROM social_activity WHERE user_id = ${userId} AND created_at > now() - interval '7 days' GROUP BY role
        UNION ALL SELECT role, count(*), max(created_at) FROM email_agent_activity WHERE user_id = ${userId} AND created_at > now() - interval '7 days' GROUP BY role
        UNION ALL SELECT agent_role, count(*), max(created_at) FROM auto_reply_log WHERE user_id = ${userId} AND agent_role IS NOT NULL AND created_at > now() - interval '7 days' GROUP BY agent_role
        UNION ALL SELECT 'groups', count(*), max(created_at) FROM wa_group_suggestions WHERE user_id = ${userId} AND created_at > now() - interval '7 days'
      ) x GROUP BY role`).then((r) => r.rows),
  ]);
  const names = new Map<string, number>();
  for (const e of staff) names.set(e.name, (names.get(e.name) ?? 0) + 1);
  const people = staff.map((e) => {
    const w = work.find((x) => x.role === e.role);
    return {
      id: e.id, role: e.role, name: e.name, title: e.title, avatar: e.avatar, isActive: e.isActive, department: departmentOf(e.role),
      actions7d: Number(w?.n ?? 0), lastAt: w?.last ?? null,
      accuracy: acc.get(e.role) ?? null, usage: use.get(e.role) ?? null,
      // Two employees answering to one name confuse every log that names them.
      duplicateName: (names.get(e.name) ?? 0) > 1,
    };
  }).sort((a, b) => a.department.localeCompare(b.department) || b.actions7d - a.actions7d);
  const totals = {
    people: people.length, active: people.filter((p) => p.isActive).length,
    calls: [...use.values()].reduce((a, u) => a + u.calls, 0), tokens: [...use.values()].reduce((a, u) => a + u.tokens, 0),
    decided: [...acc.values()].reduce((a, r) => a + r.decided, 0), approved: [...acc.values()].reduce((a, r) => a + r.approved, 0),
  };
  return { departments: DEPARTMENTS.map(({ key, label }) => ({ key, label })), people, totals };
}

/**
 * Try an employee on a made-up message before trusting them with real ones:
 * they answer in their own voice, with their own skills and standing orders,
 * and nothing is sent anywhere.
 */
export async function tryEmployee(userId: number, role: string, message: string) {
  const [e] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  if (!e) throw new Error("الموظف غير موجود");
  const prefix = role.slice(0, 2);
  const platform = (Object.values(PLATFORM).find((p) => p.prefix === prefix)?.key) as SocialPlatform | undefined;
  const job = jobOf(role);
  const voice = platform && job ? await voiceFor(userId, platform, job)
    : (EMAIL_TEAM as readonly string[]).includes(role) ? await teamVoice(userId, role as EmailRole)
    : corePrompt({ channel: "whatsapp", identity: `اسمك ${e.name}، ${e.title ?? ""}.`, persona: e.persona });
  const out = await asAgent(userId, role, () => complete([
    { role: "system", content: `${voice}\n\nهذه تجربة من صاحب العمل ولن تُرسل لأحد. تصرّف بالضبط كما تتصرف في عملك الحقيقي: إن كانت رسالة عميل فاكتب ردك عليها، وإن كانت مهمة فأنجزها، وإن كانت سؤالاً عن طريقة عملك فاشرحها باختصار.` },
    { role: "user", content: message.slice(0, 3_000) },
  ], 40_000));
  if (!out?.text) throw new Error("لم يستجب النموذج — حاول بعد قليل");
  return { text: out.text.trim(), provider: out.provider, name: e.name };
}
