import { pgTable, serial, integer, varchar, text, timestamp, unique, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const unsubscribedPhonesTable = pgTable(
  "unsubscribed_phones",
  {
    id:        serial("id").primaryKey(),
    userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
    phone:     varchar("phone", { length: 50 }).notNull(),
    reason:    text("reason"),
    /** NULL = for good (a typed stop); a date = until then (the stop button). */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique().on(t.userId, t.phone),
    index("idx_unsubscribed_user").on(t.userId),
  ]
);

export type UnsubscribedPhone = typeof unsubscribedPhonesTable.$inferSelect;
