import { pgTable, serial, bigserial, integer, varchar, text, boolean, timestamp, real, index, unique } from "drizzle-orm/pg-core";
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
