// ── The skill library ─────────────────────────────────────────────
// Skills live in source rather than being typed into the database once,
// because they are the expertise this system sells and they should be
// reviewable in a diff. `seedSkills` installs them and is safe to re-run: it
// updates the text of a skill the owner has not edited, and never touches one
// they have.
//
// Every skill here is written as a procedure with literal wording. That is the
// design constraint the owner set — it has to work when the model answering is
// whatever free tier is up today. A weak model following an explicit table
// outperforms a strong model asked to be expert, and the difference widens as
// the model gets weaker.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, agentSkillsTable, agentSkillGrantsTable, botEmployeesTable } from "@workspace/db";
import { DIALECT_SKILL, INTENT_READING_SKILL } from "./dialect";
import { STAGE_SKILL, NEGOTIATION_SKILL, DISCOVERY_SKILL, COMPLAINT_SKILL } from "./selling";
import {
  FOLLOWUP_WRITING_SKILL, ANALYSIS_SKILL, COACHING_SKILL, SALES_MANAGEMENT_SKILL,
  NUMBER_PROTECTION_SKILL, EMAIL_WRITING_SKILL,
} from "./internal";
import { HUMAN_WRITING_SKILL, DIALECT_MATCH_SKILL } from "./writing";
import {
  DELIVERABILITY_SKILL, EMAIL_FUNNEL_SKILL, SUBJECT_SKILL,
  REPLY_TRIAGE_SKILL, EMAIL_FOLLOWUP_SKILL, EMAIL_GUARD_SKILL,
  COLD_EMAIL_ANATOMY_SKILL, COPY_FRAMEWORKS_SKILL, UAE_TIMING_SKILL,
  EMAIL_METRICS_SKILL, SEQUENCE_DESIGN_SKILL,
} from "./email";
import {
  SOCIAL_REPLY_SKILL, SOCIAL_TRIAGE_SKILL, SOCIAL_DM_SKILL,
  SOCIAL_SAFETY_SKILL, SYSTEM_HEALTH_SKILL, LIST_HYGIENE_SKILL,
} from "./social";
import { GROUP_REPLY_SKILL } from "./groups";
import { logger } from "../logger";

export type SkillDef = { name: string; intents: string[]; instruction: string };

export const LIBRARY: SkillDef[] = [
  HUMAN_WRITING_SKILL, DIALECT_MATCH_SKILL,
  DIALECT_SKILL, INTENT_READING_SKILL,
  STAGE_SKILL, NEGOTIATION_SKILL, DISCOVERY_SKILL, COMPLAINT_SKILL,
  FOLLOWUP_WRITING_SKILL, ANALYSIS_SKILL, COACHING_SKILL, SALES_MANAGEMENT_SKILL,
  NUMBER_PROTECTION_SKILL, EMAIL_WRITING_SKILL,
  // The email team's own craft. Five of its six members carried no skills at
  // all before this — a persona and two tasks, and nothing about the job.
  DELIVERABILITY_SKILL, EMAIL_FUNNEL_SKILL, SUBJECT_SKILL,
  REPLY_TRIAGE_SKILL, EMAIL_FOLLOWUP_SKILL, EMAIL_GUARD_SKILL,
  // The owner asked for experts. The six above keep the channel safe; these
  // are the craft of writing and judging email a finance director answers.
  COLD_EMAIL_ANATOMY_SKILL, COPY_FRAMEWORKS_SKILL, UAE_TIMING_SKILL,
  EMAIL_METRICS_SKILL, SEQUENCE_DESIGN_SKILL,
  // The Instagram ten were hired with a persona each and no skills at all,
  // which made them ten descriptions of people rather than ten people who know
  // something. مارك had neither.
  SOCIAL_REPLY_SKILL, SOCIAL_TRIAGE_SKILL, SOCIAL_DM_SKILL,
  SOCIAL_SAFETY_SKILL, SYSTEM_HEALTH_SKILL, LIST_HYGIENE_SKILL,
  GROUP_REPLY_SKILL,
];

// Skills a library version used to install under another name. Seeding
// renames the row rather than leaving the old one behind and adding a second,
// so a grant the owner revoked or an edit they made stays with the skill.
export const RENAMED: Record<string, string> = {
  "التفاوض": NEGOTIATION_SKILL.name,
};

/**
 * Who holds what.
 *
 * The two dialect skills go to everyone who writes to a customer, because
 * sounding foreign costs the same whoever is speaking. The rest are matched to
 * the job: سام gets de-escalation and not negotiation, because a support agent
 * who negotiates during a complaint makes it worse.
 */
// Everyone who writes to a customer carries the same two writing skills. How
// long a message is and whose dialect it is in are not role-specific, and the
// owner's complaint — that the replies read as a bot — was about exactly these.
const WRITES_TO_CUSTOMERS = [
  HUMAN_WRITING_SKILL.name, DIALECT_MATCH_SKILL.name,
  DIALECT_SKILL.name, INTENT_READING_SKILL.name,
];

export const GRANTS: Record<string, string[]> = {
  sales:     [...WRITES_TO_CUSTOMERS, STAGE_SKILL.name, NEGOTIATION_SKILL.name, DISCOVERY_SKILL.name],
  support:   [...WRITES_TO_CUSTOMERS, COMPLAINT_SKILL.name],
  // The manager answers customers when nobody else fits, and coaches the rest
  // of the time — so she carries both sides. Her internal skills are tagged
  // so they load for a meeting or a review and not for a customer.
  chief:     [...WRITES_TO_CUSTOMERS, STAGE_SKILL.name, NEGOTIATION_SKILL.name, DISCOVERY_SKILL.name,
              COACHING_SKILL.name, ANALYSIS_SKILL.name, SALES_MANAGEMENT_SKILL.name],
  followup:  [...WRITES_TO_CUSTOMERS, FOLLOWUP_WRITING_SKILL.name],
  collector: [ANALYSIS_SKILL.name, EMAIL_FUNNEL_SKILL.name, LIST_HYGIENE_SKILL.name],
  intake:    [ANALYSIS_SKILL.name, LIST_HYGIENE_SKILL.name],
  ops:       [NUMBER_PROTECTION_SKILL.name, SYSTEM_HEALTH_SKILL.name, ANALYSIS_SKILL.name],
  // مارك watched the whole system and carried nothing at all — no persona, no
  // skill, no task. A watcher with no procedure reports what happened rather
  // than what is about to break.
  monitor:   [SYSTEM_HEALTH_SKILL.name, ANALYSIS_SKILL.name],

  // ── Instagram ──
  // The safety skill goes to all ten for the same reason deliverability goes
  // to all six on email: one restricted account ends the channel for everyone,
  // so it is nobody's job alone.
  ig_manager:  [SOCIAL_SAFETY_SKILL.name, ANALYSIS_SKILL.name, SALES_MANAGEMENT_SKILL.name, SOCIAL_TRIAGE_SKILL.name],
  ig_watcher:  [SOCIAL_SAFETY_SKILL.name, SOCIAL_TRIAGE_SKILL.name],
  ig_triage:   [SOCIAL_SAFETY_SKILL.name, SOCIAL_TRIAGE_SKILL.name, INTENT_READING_SKILL.name],
  ig_writer:   [SOCIAL_SAFETY_SKILL.name, SOCIAL_REPLY_SKILL.name, DIALECT_MATCH_SKILL.name,
                DIALECT_SKILL.name, HUMAN_WRITING_SKILL.name],
  ig_inviter:  [SOCIAL_SAFETY_SKILL.name, SOCIAL_TRIAGE_SKILL.name, SOCIAL_DM_SKILL.name, INTENT_READING_SKILL.name],
  ig_dm:       [SOCIAL_SAFETY_SKILL.name, SOCIAL_DM_SKILL.name, DIALECT_MATCH_SKILL.name,
                INTENT_READING_SKILL.name, DISCOVERY_SKILL.name, HUMAN_WRITING_SKILL.name],
  ig_qualify:  [SOCIAL_SAFETY_SKILL.name, DISCOVERY_SKILL.name, STAGE_SKILL.name, ANALYSIS_SKILL.name],
  ig_followup: [SOCIAL_SAFETY_SKILL.name, SOCIAL_DM_SKILL.name, FOLLOWUP_WRITING_SKILL.name, DIALECT_MATCH_SKILL.name],
  ig_guard:    [SOCIAL_SAFETY_SKILL.name, SYSTEM_HEALTH_SKILL.name],
  ig_analyst:  [SOCIAL_SAFETY_SKILL.name, ANALYSIS_SKILL.name, EMAIL_FUNNEL_SKILL.name],

  // ── WhatsApp customer groups ──
  // سارة writes WhatsApp, so the WhatsApp writing skills are hers too.
  groups: [GROUP_REPLY_SKILL.name, HUMAN_WRITING_SKILL.name, DIALECT_MATCH_SKILL.name, INTENT_READING_SKILL.name, COMPLAINT_SKILL.name],

  // ── The email team ──
  // Every one of them carries the deliverability skill: a burnt domain ends
  // the channel for all six, so it is not one person's job to know.
  email:            [DELIVERABILITY_SKILL.name, COLD_EMAIL_ANATOMY_SKILL.name, COPY_FRAMEWORKS_SKILL.name, SUBJECT_SKILL.name,
                     SEQUENCE_DESIGN_SKILL.name, EMAIL_FOLLOWUP_SKILL.name, EMAIL_WRITING_SKILL.name, DISCOVERY_SKILL.name,
                     NEGOTIATION_SKILL.name],
  email_strategist: [DELIVERABILITY_SKILL.name, UAE_TIMING_SKILL.name, EMAIL_METRICS_SKILL.name, EMAIL_FUNNEL_SKILL.name,
                     SEQUENCE_DESIGN_SKILL.name, ANALYSIS_SKILL.name, SUBJECT_SKILL.name, LIST_HYGIENE_SKILL.name],
  email_followup:   [DELIVERABILITY_SKILL.name, SEQUENCE_DESIGN_SKILL.name, EMAIL_FOLLOWUP_SKILL.name, COPY_FRAMEWORKS_SKILL.name,
                     COLD_EMAIL_ANATOMY_SKILL.name, SUBJECT_SKILL.name, EMAIL_FUNNEL_SKILL.name, UAE_TIMING_SKILL.name],
  email_replies:    [DELIVERABILITY_SKILL.name, REPLY_TRIAGE_SKILL.name, COLD_EMAIL_ANATOMY_SKILL.name, NEGOTIATION_SKILL.name,
                     DISCOVERY_SKILL.name],
  email_guard:      [EMAIL_GUARD_SKILL.name, DELIVERABILITY_SKILL.name, EMAIL_METRICS_SKILL.name, COLD_EMAIL_ANATOMY_SKILL.name],
  email_creator:    [DELIVERABILITY_SKILL.name, COLD_EMAIL_ANATOMY_SKILL.name, COPY_FRAMEWORKS_SKILL.name, SEQUENCE_DESIGN_SKILL.name,
                     SUBJECT_SKILL.name, UAE_TIMING_SKILL.name, EMAIL_FUNNEL_SKILL.name, EMAIL_WRITING_SKILL.name,
                     DISCOVERY_SKILL.name],
};

/**
 * Grants a library version gave and that turned out wrong for the role.
 * «الكتابة البشرية» is WhatsApp's — two lines, no lists — and it loads last in
 * the prompt, where it overruled the email team's own structure. Seeding
 * removes these, the one case where a grant is taken back rather than added.
 */
export const WITHDRAWN: Record<string, string[]> = {
  email:         [HUMAN_WRITING_SKILL.name],
  email_replies: [HUMAN_WRITING_SKILL.name],
  email_creator: [HUMAN_WRITING_SKILL.name],
};

export type SeedResult = { created: number; updated: number; untouched: number; granted: number };

export async function seedSkills(userId: number): Promise<SeedResult> {
  const r: SeedResult = { created: 0, updated: 0, untouched: 0, granted: 0 };

  // Renames first, so the row keeps its id, its grants and any owner edit.
  for (const [from, to] of Object.entries(RENAMED)) {
    await db.update(agentSkillsTable).set({ name: to })
      .where(and(eq(agentSkillsTable.userId, userId), eq(agentSkillsTable.name, from)));
  }

  const existing = await db.select().from(agentSkillsTable).where(eq(agentSkillsTable.userId, userId));
  const byName = new Map(existing.map((s) => [s.name, s]));
  const known = new Map(LIBRARY.map((s) => [s.name, s]));

  for (const def of LIBRARY) {
    const ex = byName.get(def.name);
    if (!ex) {
      const [row] = await db.insert(agentSkillsTable)
        .values({ userId, name: def.name, instruction: def.instruction, intents: def.intents })
        .returning();
      byName.set(def.name, row!);
      r.created++;
      continue;
    }
    // An instruction the owner has rewritten is theirs. Only a copy that still
    // matches some version of the library gets refreshed — otherwise every
    // deploy would silently undo their edits.
    const libraryText = known.get(ex.name)?.instruction;
    if (ex.instruction === libraryText) { r.untouched++; continue; }

    const ownerEdited = !existing.some((e) => e.id === ex.id && e.instruction === libraryText);
    if (ownerEdited && ex.updatedAt && ex.createdAt &&
        new Date(ex.updatedAt).getTime() - new Date(ex.createdAt).getTime() > 1_000) {
      r.untouched++;
      continue;
    }
    await db.update(agentSkillsTable)
      .set({ instruction: def.instruction, intents: def.intents, updatedAt: new Date() })
      .where(eq(agentSkillsTable.id, ex.id));
    r.updated++;
  }

  // Grants are not owner data in the same way — they follow from the roster —
  // but an explicitly revoked grant should stay revoked, so only missing ones
  // are added.
  const roster = await db.select({ role: botEmployeesTable.role }).from(botEmployeesTable)
    .where(eq(botEmployeesTable.userId, userId));
  const held = await db.select().from(agentSkillGrantsTable).where(eq(agentSkillGrantsTable.userId, userId));

  for (const { role } of roster) {
    for (const skillName of GRANTS[role] ?? []) {
      const skill = byName.get(skillName);
      if (!skill) continue;
      if (held.some((g) => g.role === role && g.skillId === skill.id)) continue;
      await db.insert(agentSkillGrantsTable)
        .values({ userId, role, skillId: skill.id }).onConflictDoNothing();
      r.granted++;
    }
  }

  for (const [role, names] of Object.entries(WITHDRAWN)) {
    for (const name of names) {
      const skill = byName.get(name);
      if (skill) await db.delete(agentSkillGrantsTable).where(and(eq(agentSkillGrantsTable.userId, userId), eq(agentSkillGrantsTable.role, role), eq(agentSkillGrantsTable.skillId, skill.id)));
    }
  }

  logger.info({ userId, ...r }, "مكتبة المهارات مُثبّتة");
  return r;
}

/**
 * Install the library for every account that has a team.
 *
 * Run at startup. Until now a new skill reached an account only when someone
 * pressed the install button on the agents page, so a library change shipped
 * to nobody. Idempotent, and it never touches a skill the owner rewrote.
 */
export async function seedSkillsForEveryone(): Promise<void> {
  const rows = await db.selectDistinct({ userId: botEmployeesTable.userId }).from(botEmployeesTable);
  for (const { userId } of rows) {
    try {
      const r = await seedSkills(userId);
      if (r.created || r.updated || r.granted) logger.info({ userId, ...r }, "مكتبة المهارات حُدِّثت عند الإقلاع");
    } catch (err) {
      logger.warn({ userId, err: String((err as any)?.message ?? err) }, "تعذّر تحديث مكتبة المهارات");
    }
  }
}

/** Restore one skill to the library text, discarding an edit. */
export async function resetSkill(userId: number, name: string): Promise<boolean> {
  const def = LIBRARY.find((s) => s.name === name);
  if (!def) return false;
  const res = await db.update(agentSkillsTable)
    .set({ instruction: def.instruction, intents: def.intents, updatedAt: new Date() })
    .where(and(eq(agentSkillsTable.userId, userId), eq(agentSkillsTable.name, name)))
    .returning();
  return res.length > 0;
}
