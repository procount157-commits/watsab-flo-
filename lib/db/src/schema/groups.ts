import { pgTable, serial, bigserial, integer, varchar, text, boolean, timestamp, real, date, index, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── WhatsApp customer groups ──────────────────────────────────────
// See migration 032. Kept, filed, understood — and answered only by the
// owner: the groups agent suggests, it does not send.
export const waGroupsTable = pgTable("wa_groups", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  jid:           varchar("jid", { length: 80 }).notNull(),
  subject:       varchar("subject", { length: 200 }),
  description:   text("description"),
  participants:  integer("participants").notNull().default(0),
  watch:         boolean("watch").notNull().default(false),
  isCustomer:    boolean("is_customer").notNull().default(true),
  customerName:  varchar("customer_name", { length: 200 }),
  notes:         text("notes"),
  profile:       text("profile"),
  profileAt:     timestamp("profile_at", { withTimezone: true }),
  messages:      integer("messages").notNull().default(0),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  /** her reading of the group has reached here; later messages are new to her */
  learnedUpto:   timestamp("learned_upto", { withTimezone: true }),
  learnedAt:     timestamp("learned_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.jid)]);
export type WaGroup = typeof waGroupsTable.$inferSelect;

export const waGroupMessagesTable = pgTable("wa_group_messages", {
  id:          bigserial("id", { mode: "number" }).primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  groupJid:    varchar("group_jid", { length: 80 }).notNull(),
  messageId:   varchar("message_id", { length: 100 }).notNull(),
  senderJid:   varchar("sender_jid", { length: 80 }),
  senderPhone: varchar("sender_phone", { length: 30 }),
  senderName:  varchar("sender_name", { length: 120 }),
  fromMe:      boolean("from_me").notNull().default(false),
  text:        text("text"),
  msgType:     varchar("msg_type", { length: 20 }).notNull().default("text"),
  fileName:    varchar("file_name", { length: 255 }),
  filePath:    text("file_path"),
  quotedId:    varchar("quoted_id", { length: 100 }),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull(),
}, (t) => [unique().on(t.userId, t.messageId), index("idx_wa_group_messages_group").on(t.userId, t.groupJid, t.createdAt)]);
export type WaGroupMessage = typeof waGroupMessagesTable.$inferSelect;

export const waGroupSuggestionsTable = pgTable("wa_group_suggestions", {
  id:               serial("id").primaryKey(),
  userId:           integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  groupJid:         varchar("group_jid", { length: 80 }).notNull(),
  triggerMessageId: varchar("trigger_message_id", { length: 100 }),
  triggerText:      text("trigger_text"),
  suggestion:       text("suggestion").notNull(),
  reason:           text("reason"),
  /** pending | correct | edited | wrong | answered | expired */
  status:           varchar("status", { length: 20 }).notNull().default("pending"),
  ownerReply:       text("owner_reply"),
  matchScore:       real("match_score"),
  feedback:         text("feedback"),
  provider:         varchar("provider", { length: 60 }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  decidedAt:        timestamp("decided_at", { withTimezone: true }),
}, (t) => [index("idx_wa_group_suggestions").on(t.userId, t.groupJid, t.createdAt)]);
export type WaGroupSuggestion = typeof waGroupSuggestionsTable.$inferSelect;

// See migration 035: what the owner taught the groups agent, and what she learned herself.
export const waGroupKnowledgeTable = pgTable("wa_group_knowledge", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** null: every group */
  groupJid:  varchar("group_jid", { length: 80 }),
  /** instruction | qa | text | document | lesson */
  kind:      varchar("kind", { length: 20 }).notNull(),
  /** owner | learned */
  source:    varchar("source", { length: 10 }).notNull().default("owner"),
  title:     varchar("title", { length: 200 }),
  content:   text("content"),
  question:  text("question"),
  answer:    text("answer"),
  active:    boolean("active").notNull().default(true),
  used:      integer("used").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_wa_group_knowledge").on(t.userId, t.active, t.kind)]);
export type WaGroupKnowledge = typeof waGroupKnowledgeTable.$inferSelect;

// See migration 039: requests read from the groups, as tasks with a due time.
export const waGroupTasksTable = pgTable("wa_group_tasks", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  groupJid:    varchar("group_jid", { length: 80 }).notNull(),
  text:        text("text").notNull(),
  requestedBy: varchar("requested_by", { length: 120 }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  dueAt:       timestamp("due_at", { withTimezone: true }),
  /** open | done | cancelled */
  status:      varchar("status", { length: 12 }).notNull().default("open"),
  doneAt:      timestamp("done_at", { withTimezone: true }),
  doneNote:    text("done_note"),
  /** learned | owner */
  origin:      varchar("origin", { length: 10 }).notNull().default("learned"),
  remindedAt:  timestamp("reminded_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_wa_group_tasks").on(t.userId, t.status, t.dueAt)]);
export type WaGroupTask = typeof waGroupTasksTable.$inferSelect;

// And each client's deadlines, entered by the owner.
export const clientObligationsTable = pgTable("client_obligations", {
  id:              serial("id").primaryKey(),
  userId:          integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  groupJid:        varchar("group_jid", { length: 80 }),
  clientName:      varchar("client_name", { length: 200 }).notNull(),
  /** vat | ct | license | aml | payroll | audit | other */
  kind:            varchar("kind", { length: 12 }).notNull().default("other"),
  title:           varchar("title", { length: 200 }).notNull(),
  dueDate:         date("due_date").notNull(),
  /** none | monthly | quarterly | yearly */
  recurrence:      varchar("recurrence", { length: 10 }).notNull().default("none"),
  remindDays:      integer("remind_days").notNull().default(7),
  documents:       text("documents"),
  notes:           text("notes"),
  active:          boolean("active").notNull().default(true),
  lastRemindedDue: date("last_reminded_due"),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_client_obligations").on(t.userId, t.active, t.dueDate)]);
export type ClientObligation = typeof clientObligationsTable.$inferSelect;
