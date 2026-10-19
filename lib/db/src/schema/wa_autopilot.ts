import { pgTable, serial, integer, varchar, text, jsonb, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** The WhatsApp autopilot's switch and sizes, one row per account. Off until the owner turns it on. */
export const waAutopilotTable = pgTable("wa_autopilot", {
  userId:    integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  enabled:   boolean("enabled").notNull().default(false),
  /** approve: each test waits for the owner's yes · auto: it sends by itself */
  mode:      varchar("mode", { length: 10 }).notNull().default("approve"),
  /** Recipients per variant in a test. */
  testSize:  integer("test_size").notNull().default(20),
  /** Recipients for the winner, per wave. */
  waveSize:  integer("wave_size").notNull().default(150),
  /** The share of the day's allowance the autopilot may use, in percent. */
  dailyShare: integer("daily_share").notNull().default(60),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WaVariant = { key: string; message: string; mediaUrl?: string | null; link?: string | null; listId?: number | null; campaignId?: number | null; angle?: string };
export type WaVariantResult = { key: string; sent: number; replied: number; interested: number; stopped: number; score: number };

/** One test: two variants on small lists, judged, and the winner sent to a wave. */
export const waAutopilotTestsTable = pgTable("wa_autopilot_tests", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** awaiting_approval | testing | scaling | done | cancelled | no_winner */
  status:    varchar("status", { length: 20 }).notNull().default("awaiting_approval"),
  /** sector (a company sector) | list (a list of people, a shop's customers) */
  targetKind: varchar("target_kind", { length: 10 }).notNull(),
  target:    varchar("target", { length: 120 }).notNull(),
  /** aml | services | shop */
  service:   varchar("service", { length: 12 }),
  variants:  jsonb("variants").$type<WaVariant[]>().notNull().default([]),
  results:   jsonb("results").$type<WaVariantResult[]>(),
  winner:    varchar("winner", { length: 4 }),
  insight:   text("insight"),
  waveCampaignId: integer("wave_campaign_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  judgedAt:  timestamp("judged_at", { withTimezone: true }),
}, (t) => [index("idx_wa_ap_tests_user").on(t.userId, t.status)]);
export type WaAutopilotTest = typeof waAutopilotTestsTable.$inferSelect;
