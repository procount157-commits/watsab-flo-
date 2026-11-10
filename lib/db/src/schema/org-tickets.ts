// ── التذاكر وسجل الأفعال ──────────────────────────────────────────
// التذكرة هي employee_tasks نفسها، موسَّعةً بحقول العمل (العنوان، الهدف، المكلَّف،
// الدليل، المخرج الفعلي...) — لا جدول مكرر، والقرّاء القدامى يعملون كما كانوا.
// ticket_action_events سطرٌ لكل فعلٍ له معنى: قرار البوابة، تغيير الحالة، الموافقة،
// التسليم، التعليق. ملخص نداءات النموذج في receipts وemployee_executions، ويُربط بها
// برقم التنفيذ ولا يُنسخ.
//
// النشر لا يشغّل ملفات SQL: ما هنا يُنشأ عند الإقلاع من
// artifacts/api-server/src/lib/org/ledger.ts (TICKET_SQL) بالنص نفسه الذي في 076_tickets.sql.

import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const TICKET_STATUSES = [
  "draft", "pending", "queued", "running", "waiting_for_dependency", "waiting_for_approval", "waiting_for_owner", "blocked",
  "completed", "failed", "cancelled", "expired",
] as const;
export const TICKET_PRIORITIES = ["critical", "high", "normal", "low"] as const;
export const ACTOR_KINDS = ["owner", "employee", "system"] as const;

/** الأولوية الرقمية القديمة (الأصغر أولاً) بأسمائها. يحسبها Postgres، فلا تختلف القراءتان أبداً. */
export const PRIORITY_LEVEL_SQL = sql`CASE WHEN priority <= 25 THEN 'critical' WHEN priority <= 75 THEN 'high' WHEN priority <= 150 THEN 'normal' ELSE 'low' END`;

const at = (name: string) => timestamp(name, { withTimezone: true });

/** حقول التذكرة على employee_tasks. تُفرد في جدولها في org.ts. */
export const ticketColumns = () => ({
  title:          text("title"),
  objective:      text("objective"),
  description:    text("description"),
  /** مفتاح موظف بعينه (email.copywriter)، لا اسم عرض. */
  assignedTo:     varchar("assigned_to", { length: 60 }),
  createdByKind:  varchar("created_by_kind", { length: 12 }),
  createdById:    varchar("created_by_id", { length: 80 }),
  relatedCustomerId: integer("related_customer_id"),
  relatedCampaignId: integer("related_campaign_id"),
  relatedConversationId: varchar("related_conversation_id", { length: 120 }),
  actionType:     varchar("action_type", { length: 60 }),
  evidenceReferences: jsonb("evidence_references").notNull().default([]),
  expectedOutput: text("expected_output"),
  actualOutput:   jsonb("actual_output"),
  durationMs:     integer("duration_ms"),
  attemptCount:   integer("attempt_count").notNull().default(0),
  failureCode:    varchar("failure_code", { length: 40 }),
  nextAction:     text("next_action"),
  handoffTarget:  varchar("handoff_target", { length: 60 }),
  auditEventIds:  jsonb("audit_event_ids").notNull().default([]),
  priorityLevel:  varchar("priority_level", { length: 10 }).generatedAlwaysAs(PRIORITY_LEVEL_SQL),
  retryable:      boolean("retryable"),
  responsibleParty: varchar("responsible_party", { length: 60 }),
  approvalPayloadHash: varchar("approval_payload_hash", { length: 64 }),
  approvedPayloadHash: varchar("approved_payload_hash", { length: 64 }),
  approvedBy:     integer("approved_by"),
  approvedAt:     at("approved_at"),
  // due_at موجود أصلاً في employee_tasks (org.ts)، فلا يُكرَّر هنا.
});

export const ticketActionEventsTable = pgTable("ticket_action_events", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  // المفتاح الأجنبي إلى employee_tasks في SQL (ON DELETE CASCADE)، لا هنا: org.ts يستورد هذا الملف.
  ticketId:    integer("ticket_id").notNull(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  employeeKey: varchar("employee_key", { length: 60 }),
  actorKind:   varchar("actor_kind", { length: 12 }),
  actorId:     varchar("actor_id", { length: 80 }),
  actionType:  varchar("action_type", { length: 60 }).notNull(),
  input:       jsonb("input"),
  output:      jsonb("output"),
  status:      varchar("status", { length: 20 }).notNull(),
  evidence:    jsonb("evidence"),
  attemptNo:   integer("attempt_no").notNull().default(1),
  idempotencyKey: varchar("idempotency_key", { length: 200 }),
  provider:    varchar("provider", { length: 40 }),
  model:       varchar("model", { length: 120 }),
  executionId: bigint("execution_id", { mode: "number" }),
  durationMs:  integer("duration_ms"),
  createdAt:   at("created_at").defaultNow().notNull(),
}, (t) => [
  index("idx_ticket_events_ticket").on(t.ticketId, t.id),
  index("idx_ticket_events_user").on(t.userId, t.createdAt),
  index("idx_ticket_events_created").on(t.createdAt),
  uniqueIndex("uq_ticket_events_attempt").on(t.userId, t.idempotencyKey, t.attemptNo).where(sql`idempotency_key IS NOT NULL`),
  check("ticket_events_status", sql`${t.status} IN ('ok','allowed','refused','failed','started','info')`),
]);

export type TicketActionEvent = typeof ticketActionEventsTable.$inferSelect;
