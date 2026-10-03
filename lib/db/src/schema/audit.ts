import { pgTable, serial, integer, varchar, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── What was destroyed, by whom, and how to put it back ───────────
// This account lost 8,235 e-mail contacts and 20,328 list memberships in a
// single day and nothing recorded it. The loss was only visible afterwards, in
// 1,939 queued messages cancelled with "the contact was deleted before
// sending" and a mission that approved and then failed for want of an
// audience. A destructive action with no record is a destructive action nobody
// can learn from.
export const auditLogTable = pgTable("audit_log", {
  id:       serial("id").primaryKey(),
  userId:   integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  action:   varchar("action", { length: 40 }).notNull(),
  /** How many rows it touched — the number nobody had. */
  affected: integer("affected").notNull().default(0),
  /** owner | agent:<role> | system */
  actor:    varchar("actor", { length: 40 }).notNull().default("owner"),
  detail:   text("detail"),
  /** The removed rows, when they can be put back. */
  snapshot: jsonb("snapshot"),
  /** Set once restored, so one snapshot cannot be applied twice. */
  restoredAt: timestamp("restored_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_audit_user").on(t.userId, t.createdAt)]);

export type AuditEntry = typeof auditLogTable.$inferSelect;
