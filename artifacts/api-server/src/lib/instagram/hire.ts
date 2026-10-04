// ── Hiring the Instagram team ─────────────────────────────────────
// They are ordinary employees — on the team board with a persona, tasks and a
// memory the owner writes into — so they appear beside the WhatsApp and email
// staff rather than in a world of their own.

import { and, eq } from "drizzle-orm";
import { db, botEmployeesTable, agentTasksTable } from "@workspace/db";
import { IG_TEAM_DEFS } from "./team";
import { logger } from "../logger";

export async function hireInstagramTeam(userId: number): Promise<{ hired: number; tasks: number }> {
  let hired = 0, tasks = 0;

  for (const d of IG_TEAM_DEFS) {
    const [existing] = await db.select().from(botEmployeesTable)
      .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, d.role))).limit(1);

    if (!existing) {
      await db.insert(botEmployeesTable).values({
        userId, name: d.name, role: d.role, kind: "internal",
        title: d.title, avatar: d.avatar, persona: d.persona,
        specialties: [], priority: d.priority, isActive: true,
      } as any).onConflictDoNothing();
      hired++;
    } else if (!existing.persona) {
      // Only fills a gap; a persona the owner has written is theirs.
      await db.update(botEmployeesTable).set({ persona: d.persona })
        .where(eq(botEmployeesTable.id, existing.id));
    }

    // Tasks are added once. Re-running must not stack duplicates on an
    // employee the owner has since edited.
    const have = await db.select({ task: agentTasksTable.task }).from(agentTasksTable)
      .where(and(eq(agentTasksTable.userId, userId), eq(agentTasksTable.role, d.role)));
    for (const [i, task] of d.tasks.entries()) {
      if (have.some((h) => h.task === task)) continue;
      await db.insert(agentTasksTable).values({
        userId, role: d.role, task, sortOrder: (i + 1) * 10,
      });
      tasks++;
    }
  }

  logger.info({ userId, hired, tasks }, "فريق إنستجرام مُعيَّن");
  return { hired, tasks };
}
