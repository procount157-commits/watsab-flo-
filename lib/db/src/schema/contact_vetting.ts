import { pgTable, serial, integer, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * One run of the number vetter (سيف — فاحص الأرقام, lib/wa-vetting.ts) over
 * a list: what he looked at, what he decided, and his note to the owner.
 * The verdict itself lives on each contact (contacts.verdict); this is the
 * report the list page and the team room read.
 */
export const contactVettingRunsTable = pgTable("contact_vetting_runs", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  groupId:    integer("group_id"),
  /** upload | connect | campaign | owner | daily */
  trigger:    varchar("trigger", { length: 12 }).notNull(),
  total:      integer("total").notNull().default(0),
  ready:      integer("ready").notNull().default(0),
  hold:       integer("hold").notNull().default(0),
  rejected:   integer("rejected").notNull().default(0),
  /** Asked WhatsApp about this many; how many it could not answer. */
  checked:    integer("checked").notNull().default(0),
  unknown:    integer("unknown").notNull().default(0),
  /** reason → count, for the owner's eye. */
  reasons:    jsonb("reasons").$type<Record<string, number>>().notNull().default({}),
  note:       text("note"),
  startedAt:  timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("idx_contact_vetting_runs_user").on(t.userId, t.groupId, t.startedAt)]);
export type ContactVettingRun = typeof contactVettingRunsTable.$inferSelect;
