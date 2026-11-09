// ── المنظّمة: مفاتيح الإيقاف، السجل، وما يبني عليه الفريق ─────────────
// بوابة السلامة أولاً (org_controls + org_audit_log)، ثم ما يقوم عليه تشغيل
// الموظفين: المهام، النبض، التنفيذ، الذاكرة المشتركة، والتعلّم.
//
// لا ازدواج مع ما هو موجود: bot_employees يبقى سجل الموظف، agent_memory ذاكرته،
// email_agent_activity + receipts نشاطه. النشر لا يشغّل ملفات SQL، فالجداول تُنشأ
// عند الإقلاع من artifacts/api-server/src/lib/org/schema.ts بما في 072_org.sql.

import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, index, integer, jsonb, numeric, pgTable, primaryKey, serial,
  text, timestamp, uniqueIndex, unique, varchar,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

const at = (name: string) => timestamp(name, { withTimezone: true });
const created = () => at("created_at").defaultNow().notNull();
const owner = () => integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" });

export const ORG_TASK_STATUSES = ["pending", "queued", "running", "waiting_for_dependency", "waiting_for_approval", "completed", "failed", "cancelled", "expired"] as const;
export const ORG_CONTROL_SCOPES = ["global", "account", "department", "employee", "channel"] as const;

/** مفتاح إيقاف. user_id فارغ = على مستوى المنصة كلها (للمدير وحده)؛ target فارغ للعام والحساب. */
export const orgControlsTable = pgTable("org_controls", {
  id:      serial("id").primaryKey(),
  scope:   varchar("scope", { length: 12 }).notNull(),
  userId:  integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  target:  varchar("target", { length: 60 }).notNull().default(""),
  engaged: boolean("engaged").notNull().default(false),
  reason:  text("reason"),
  setBy:   integer("set_by").references(() => usersTable.id, { onDelete: "set null" }),
  setAt:   at("set_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("uq_org_controls").on(t.scope, sql`COALESCE(user_id, 0)`, t.target),
  index("idx_org_controls_user").on(t.userId, t.engaged),
  check("org_controls_scope", sql`${t.scope} IN ('global','account','department','employee','channel')`),
  check("org_controls_global", sql`${t.scope} <> 'global' OR ${t.userId} IS NULL`),
  check("org_controls_account", sql`${t.scope} <> 'account' OR ${t.userId} IS NOT NULL`),
]);

/** كل رفضٍ وكل تغيير مفتاح. المسموح يُجمع كل بضع دقائق ولا يُكتب سطراً لكل رسالة (الإيصالات تشهد له). */
export const orgAuditLogTable = pgTable("org_audit_log", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  userId:    integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  action:    varchar("action", { length: 40 }).notNull(),
  scope:     varchar("scope", { length: 12 }),
  channel:   varchar("channel", { length: 20 }),
  kind:      varchar("kind", { length: 30 }),
  recipient: varchar("recipient", { length: 254 }),
  role:      varchar("role", { length: 60 }),
  actor:     integer("actor"),
  why:       text("why"),
  count:     integer("count").notNull().default(1),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  meta:      jsonb("meta"),
  createdAt: created(),
}, (t) => [
  index("idx_org_audit_user").on(t.userId, t.createdAt),
  index("idx_org_audit_action").on(t.action, t.createdAt),
  uniqueIndex("uq_org_audit_idem").on(sql`COALESCE(user_id, 0)`, t.idempotencyKey).where(sql`idempotency_key IS NOT NULL`),
]);

/** كل نسخةٍ من تعليمات موظف، ليُعرف ما كان يعمل به يوم فعل ما فعل، وليُرجَع إليها. */
export const employeePromptVersionsTable = pgTable("employee_prompt_versions", {
  id:          serial("id").primaryKey(),
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }).notNull(),
  version:     integer("version").notNull(),
  prompt:      text("prompt").notNull(),
  note:        text("note"),
  active:      boolean("active").notNull().default(false),
  createdBy:   varchar("created_by", { length: 60 }),
  createdAt:   created(),
}, (t) => [unique("uq_employee_prompt_version").on(t.userId, t.employeeKey, t.version)]);

export const employeeHeartbeatsTable = pgTable("employee_heartbeats", {
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }).notNull(),
  status:      varchar("status", { length: 20 }).notNull().default("idle"),
  lastBeatAt:  at("last_beat_at").defaultNow().notNull(),
  nextBeatAt:  at("next_beat_at"),
  lastError:   text("last_error"),
  detail:      jsonb("detail"),
}, (t) => [
  primaryKey({ columns: [t.userId, t.employeeKey] }),
  check("employee_heartbeats_status", sql`${t.status} IN ('idle','running','stalled','halted','failed')`),
]);

export const employeeExecutionsTable = pgTable("employee_executions", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }).notNull(),
  taskId:      integer("task_id"),
  promptVersion: integer("prompt_version"),
  status:      varchar("status", { length: 20 }).notNull().default("running"),
  model:       varchar("model", { length: 120 }),
  tokensIn:    integer("tokens_in"),
  tokensOut:   integer("tokens_out"),
  costUsd:     numeric("cost_usd", { precision: 10, scale: 5 }),
  error:       text("error"),
  outputRef:   jsonb("output_ref"),
  startedAt:   at("started_at").defaultNow().notNull(),
  finishedAt:  at("finished_at"),
}, (t) => [
  index("idx_employee_executions_user").on(t.userId, t.employeeKey, t.startedAt),
  check("employee_executions_status", sql`${t.status} IN ('running','succeeded','failed','halted','cancelled')`),
]);

export const employeeTasksTable = pgTable("employee_tasks", {
  taskId:         serial("task_id").primaryKey(),
  userId:         owner(),
  department:     varchar("department", { length: 40 }),
  ownerRole:      varchar("owner_role", { length: 60 }).notNull(),
  createdByRole:  varchar("created_by_role", { length: 60 }),
  parentTaskId:   integer("parent_task_id"),
  taskType:       varchar("task_type", { length: 60 }).notNull(),
  priority:       integer("priority").notNull().default(100),
  status:         varchar("status", { length: 30 }).notNull().default("pending"),
  inputRefs:      jsonb("input_refs").notNull().default([]),
  outputRefs:     jsonb("output_refs").notNull().default([]),
  dueAt:          at("due_at"),
  startedAt:      at("started_at"),
  completedAt:    at("completed_at"),
  approvalRequired: boolean("approval_required").notNull().default(false),
  approvalStatus: varchar("approval_status", { length: 20 }),
  failureReason:  text("failure_reason"),
  retryCount:     integer("retry_count").notNull().default(0),
  maxRetries:     integer("max_retries").notNull().default(3),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  leaseOwner:     varchar("lease_owner", { length: 80 }),
  leaseExpiresAt: at("lease_expires_at"),
  nextAttemptAt:  at("next_attempt_at"),
  deadLetter:     boolean("dead_letter").notNull().default(false),
  createdAt:      created(),
  updatedAt:      at("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("uq_employee_tasks_idem").on(t.userId, t.idempotencyKey),
  index("idx_employee_tasks_queue").on(t.userId, t.status, t.nextAttemptAt, t.priority),
  index("idx_employee_tasks_owner").on(t.userId, t.ownerRole, t.status),
  index("idx_employee_tasks_parent").on(t.parentTaskId),
  check("employee_tasks_status", sql`${t.status} IN ('pending','queued','running','waiting_for_dependency','waiting_for_approval','completed','failed','cancelled','expired')`),
  check("employee_tasks_approval", sql`${t.approvalStatus} IS NULL OR ${t.approvalStatus} IN ('pending','approved','rejected')`),
]);

export const employeeTaskDependenciesTable = pgTable("employee_task_dependencies", {
  taskId:    integer("task_id").notNull().references(() => employeeTasksTable.taskId, { onDelete: "cascade" }),
  dependsOn: integer("depends_on").notNull().references(() => employeeTasksTable.taskId, { onDelete: "cascade" }),
  userId:    owner(),
}, (t) => [
  primaryKey({ columns: [t.taskId, t.dependsOn] }),
  index("idx_employee_task_deps_on").on(t.dependsOn),
  check("employee_task_deps_self", sql`${t.taskId} <> ${t.dependsOn}`),
]);

export const employeeFeedbackTable = pgTable("employee_feedback", {
  id:          serial("id").primaryKey(),
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }).notNull(),
  taskId:      integer("task_id"),
  fromRole:    varchar("from_role", { length: 60 }),
  verdict:     varchar("verdict", { length: 20 }).notNull(),
  note:        text("note"),
  evidence:    jsonb("evidence"),
  createdAt:   created(),
}, (t) => [
  index("idx_employee_feedback_user").on(t.userId, t.employeeKey, t.createdAt),
  check("employee_feedback_verdict", sql`${t.verdict} IN ('good','bad','edit','note')`),
]);

export const departmentMemoryTable = pgTable("department_memory", {
  id:             serial("id").primaryKey(),
  userId:         owner(),
  department:     varchar("department", { length: 40 }).notNull(),
  kind:           varchar("kind", { length: 20 }).notNull(),
  content:        text("content").notNull(),
  sourceReference: text("source_reference"),
  confidence:     numeric("confidence", { precision: 4, scale: 3 }),
  approvalStatus: varchar("approval_status", { length: 20 }).notNull().default("pending"),
  lastVerifiedAt: at("last_verified_at"),
  version:        integer("version").notNull().default(1),
  expiryAt:       at("expiry_at"),
  createdAt:      created(),
}, (t) => [
  index("idx_department_memory_user").on(t.userId, t.department, t.approvalStatus),
  check("department_memory_approval", sql`${t.approvalStatus} IN ('pending','approved','rejected')`),
]);

/** ما يعرفه الحساب كله: حقيقةٌ بمصدر، لا رأي موظف. */
export const accountKnowledgeTable = pgTable("account_knowledge", {
  id:             serial("id").primaryKey(),
  userId:         owner(),
  key:            varchar("key", { length: 120 }).notNull(),
  value:          text("value").notNull(),
  sourceReference: text("source_reference"),
  confidence:     numeric("confidence", { precision: 4, scale: 3 }),
  approvalStatus: varchar("approval_status", { length: 20 }).notNull().default("pending"),
  lastVerifiedAt: at("last_verified_at"),
  version:        integer("version").notNull().default(1),
  expiryAt:       at("expiry_at"),
  createdAt:      created(),
  updatedAt:      at("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("uq_account_knowledge").on(t.userId, t.key),
  check("account_knowledge_approval", sql`${t.approvalStatus} IN ('pending','approved','rejected')`),
]);

export const learningEventsTable = pgTable("learning_events", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }),
  department:  varchar("department", { length: 40 }),
  eventType:   varchar("event_type", { length: 40 }).notNull(),
  outcome:     varchar("outcome", { length: 20 }),
  evidence:    jsonb("evidence"),
  createdAt:   created(),
}, (t) => [index("idx_learning_events_user").on(t.userId, t.eventType, t.createdAt)]);

export const improvementProposalsTable = pgTable("improvement_proposals", {
  changeId:     serial("change_id").primaryKey(),
  userId:       owner(),
  requestedBy:  varchar("requested_by", { length: 60 }).notNull(),
  approvedBy:   integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  target:       varchar("target", { length: 120 }),
  reason:       text("reason").notNull(),
  evidence:     jsonb("evidence"),
  oldValue:     jsonb("old_value"),
  newValue:     jsonb("new_value"),
  impact:       text("impact"),
  status:       varchar("status", { length: 20 }).notNull().default("proposed"),
  appliedAt:    at("applied_at"),
  rollbackVersion: integer("rollback_version"),
  createdAt:    created(),
}, (t) => [
  index("idx_improvement_proposals_user").on(t.userId, t.status),
  check("improvement_proposals_status", sql`${t.status} IN ('proposed','approved','rejected','applied','rolled_back')`),
]);

export const workflowExecutionsTable = pgTable("workflow_executions", {
  id:          serial("id").primaryKey(),
  userId:      owner(),
  workflow:    varchar("workflow", { length: 80 }).notNull(),
  status:      varchar("status", { length: 20 }).notNull().default("running"),
  input:       jsonb("input"),
  output:      jsonb("output"),
  error:       text("error"),
  startedAt:   at("started_at").defaultNow().notNull(),
  finishedAt:  at("finished_at"),
}, (t) => [
  index("idx_workflow_executions_user").on(t.userId, t.workflow, t.startedAt),
  check("workflow_executions_status", sql`${t.status} IN ('running','succeeded','failed','halted','cancelled')`),
]);

export const executionEventsTable = pgTable("execution_events", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  userId:      owner(),
  workflowId:  integer("workflow_id").references(() => workflowExecutionsTable.id, { onDelete: "cascade" }),
  taskId:      integer("task_id"),
  employeeKey: varchar("employee_key", { length: 60 }),
  event:       varchar("event", { length: 60 }).notNull(),
  detail:      jsonb("detail"),
  createdAt:   created(),
}, (t) => [
  index("idx_execution_events_user").on(t.userId, t.createdAt),
  index("idx_execution_events_workflow").on(t.workflowId),
]);

export const integrationHealthTable = pgTable("integration_health", {
  id:          serial("id").primaryKey(),
  userId:      owner(),
  integration: varchar("integration", { length: 40 }).notNull(),
  status:      varchar("status", { length: 20 }).notNull().default("unknown"),
  detail:      text("detail"),
  lastOkAt:    at("last_ok_at"),
  lastFailAt:  at("last_fail_at"),
  checkedAt:   at("checked_at").defaultNow().notNull(),
}, (t) => [
  unique("uq_integration_health").on(t.userId, t.integration),
  check("integration_health_status", sql`${t.status} IN ('ok','degraded','down','unknown')`),
]);

export const providerMetricsTable = pgTable("provider_metrics", {
  id:        serial("id").primaryKey(),
  userId:    owner(),
  provider:  varchar("provider", { length: 40 }).notNull(),
  model:     varchar("model", { length: 120 }).notNull().default(""),
  day:       varchar("day", { length: 10 }).notNull(),
  calls:     integer("calls").notNull().default(0),
  failures:  integer("failures").notNull().default(0),
  tokensIn:  integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  costUsd:   numeric("cost_usd", { precision: 10, scale: 5 }).notNull().default("0"),
}, (t) => [unique("uq_provider_metrics").on(t.userId, t.provider, t.model, t.day)]);

export const executiveReportsTable = pgTable("executive_reports", {
  id:        serial("id").primaryKey(),
  userId:    owner(),
  period:    varchar("period", { length: 20 }).notNull(),
  periodKey: varchar("period_key", { length: 20 }).notNull(),
  body:      text("body").notNull(),
  metrics:   jsonb("metrics"),
  createdBy: varchar("created_by", { length: 60 }),
  createdAt: created(),
}, (t) => [unique("uq_executive_reports").on(t.userId, t.period, t.periodKey)]);

export const employeeScorecardsTable = pgTable("employee_scorecards", {
  id:          serial("id").primaryKey(),
  userId:      owner(),
  employeeKey: varchar("employee_key", { length: 60 }).notNull(),
  periodKey:   varchar("period_key", { length: 20 }).notNull(),
  score:       numeric("score", { precision: 5, scale: 2 }),
  metrics:     jsonb("metrics"),
  note:        text("note"),
  createdAt:   created(),
}, (t) => [unique("uq_employee_scorecards").on(t.userId, t.employeeKey, t.periodKey)]);

export type OrgControl = typeof orgControlsTable.$inferSelect;
export type OrgAuditEntry = typeof orgAuditLogTable.$inferSelect;
export type EmployeeTask = typeof employeeTasksTable.$inferSelect;
export type ImprovementProposal = typeof improvementProposalsTable.$inferSelect;
