import { pgTable, serial, integer, boolean, date, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// See migration 042.
export const briefSettingsTable = pgTable("brief_settings", {
  userId:     integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  enabled:    boolean("enabled").notNull().default(true),
  hour:       integer("hour").notNull().default(8),
  lastSentOn: date("last_sent_on"),
});

export const hostSleepsTable = pgTable("host_sleeps", {
  id:      serial("id").primaryKey(),
  wokeAt:  timestamp("woke_at", { withTimezone: true }).defaultNow().notNull(),
  seconds: integer("seconds").notNull(),
}, (t) => [index("idx_host_sleeps").on(t.wokeAt)]);
