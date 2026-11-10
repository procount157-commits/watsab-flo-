// ── المحاكاة والظل والسيناريو التجريبي ─────────────────────────────
// shadow_runs: مقارنة التعليمات الحالية بالمقترحة على مدخلات الحساب الحقيقية، والحكم بالكود.
// sim_fixtures: بيانات اختبار لكل حساب، معلَّمة is_test دائماً، ولا تختلط بأي رقم حقيقي.
// sim_e2e_runs/steps: السيناريو جاسم ← … ← جاسم، خطوةً خطوة.
//
// النشر لا يشغّل ملفات SQL: تُنشأ عند الإقلاع من artifacts/api-server/src/lib/org/sim-schema.ts
// (ORG_SIM_SQL) بالنص نفسه الذي في 075_shadow.sql و080_shadow_verdicts.sql.

import { sql } from "drizzle-orm";
import { bigserial, boolean, check, index, integer, jsonb, pgTable, serial, text, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

const at = (name: string) => timestamp(name, { withTimezone: true });
const owner = () => integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" });

export const SHADOW_VERDICTS = ["failed_checks", "better", "same", "mixed", "no_output", "no_model_path", "not_covered", "no_samples", "budget"] as const;

export const shadowRunsTable = pgTable("shadow_runs", {
  id:             bigserial("id", { mode: "number" }).primaryKey(),
  userId:         owner(),
  batchId:        varchar("batch_id", { length: 60 }).notNull(),
  employeeKey:    varchar("employee_key", { length: 60 }).notNull(),
  proposalId:     integer("proposal_id"),
  libraryVersion: varchar("library_version", { length: 20 }),
  sampleRef:      jsonb("sample_ref"),
  inputExcerpt:   text("input_excerpt"),
  currentOutput:  text("current_output"),
  proposedOutput: text("proposed_output"),
  currentIssues:  jsonb("current_issues").notNull().default(sql`'[]'::jsonb`),
  proposedIssues: jsonb("proposed_issues").notNull().default(sql`'[]'::jsonb`),
  verdict:        varchar("verdict", { length: 20 }).notNull(),
  detail:         text("detail"),
  modelCalls:     integer("model_calls").notNull().default(0),
  trigger:        varchar("trigger", { length: 20 }).notNull().default("manual"),
  createdAt:      at("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_shadow_runs_user").on(t.userId, t.employeeKey, t.createdAt),
  index("idx_shadow_runs_proposal").on(t.userId, t.proposalId),
  check("shadow_runs_verdict", sql`${t.verdict} IN ('failed_checks','better','same','mixed','no_output','no_model_path','not_covered','no_samples','budget')`),
]);

export const simFixturesTable = pgTable("sim_fixtures", {
  id:        serial("id").primaryKey(),
  userId:    owner(),
  kind:      varchar("kind", { length: 40 }).notNull(),
  label:     varchar("label", { length: 120 }).notNull(),
  data:      jsonb("data").notNull(),
  isTest:    boolean("is_test").notNull().default(true),
  createdAt: at("created_at").defaultNow().notNull(),
}, (t) => [unique("uq_sim_fixtures").on(t.userId, t.kind, t.label), check("sim_fixtures_test", sql`${t.isTest}`)]);

export const simE2eRunsTable = pgTable("sim_e2e_runs", {
  id:         serial("id").primaryKey(),
  userId:     owner(),
  status:     varchar("status", { length: 20 }).notNull().default("running"),
  fixtureId:  integer("fixture_id").references(() => simFixturesTable.id, { onDelete: "set null" }),
  modelCalls: integer("model_calls").notNull().default(0),
  summary:    jsonb("summary"),
  error:      text("error"),
  startedAt:  at("started_at").defaultNow().notNull(),
  finishedAt: at("finished_at"),
}, (t) => [index("idx_sim_e2e_runs_user").on(t.userId, t.startedAt), check("sim_e2e_runs_status", sql`${t.status} IN ('running','succeeded','failed')`)]);

export const simE2eStepsTable = pgTable("sim_e2e_steps", {
  id:             bigserial("id", { mode: "number" }).primaryKey(),
  runId:          integer("run_id").notNull().references(() => simE2eRunsTable.id, { onDelete: "cascade" }),
  userId:         owner(),
  step:           integer("step").notNull(),
  actorRole:      varchar("actor_role", { length: 60 }),
  actorName:      varchar("actor_name", { length: 60 }),
  kind:           varchar("kind", { length: 40 }).notNull(),
  title:          text("title").notNull(),
  detail:         jsonb("detail"),
  ticketId:       integer("ticket_id"),
  parentTicketId: integer("parent_ticket_id"),
  createdAt:      at("created_at").defaultNow().notNull(),
}, (t) => [unique("uq_sim_e2e_step").on(t.runId, t.step), index("idx_sim_e2e_steps_run").on(t.runId, t.step)]);

export type ShadowRun = typeof shadowRunsTable.$inferSelect;
export type SimFixture = typeof simFixturesTable.$inferSelect;
export type SimE2eStep = typeof simE2eStepsTable.$inferSelect;
