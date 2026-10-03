import { pgTable, serial, integer, varchar, text, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Reports that survive a sleeping laptop ────────────────────────
// Every Telegram report was being sent and none were arriving. The cause was
// not the code that sends them: this machine sleeps after a minute on battery,
// the application log holds 1,734 network failures, and notify() treated each
// one as final — caught, logged, returned false, gone.
//
// Writing the message down first turns a dropped report into a late one.
export const notifyOutboxTable = pgTable("notify_outbox", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  body:      text("body").notNull(),
  kind:      varchar("kind", { length: 40 }).notNull().default("general"),
  status:    varchar("status", { length: 20 }).notNull().default("pending"),
  attempts:  integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  /** Backs off — a laptop asleep now is likely asleep in ten seconds. */
  nextTryAt: timestamp("next_try_at", { withTimezone: true }).defaultNow().notNull(),
  sentAt:    timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_outbox_user").on(t.userId, t.createdAt)]);

export type NotifyOutbox = typeof notifyOutboxTable.$inferSelect;
