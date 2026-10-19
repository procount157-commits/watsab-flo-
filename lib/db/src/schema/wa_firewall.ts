import { pgTable, serial, integer, varchar, text, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * The ban firewall's standing state for one number (lib/wa-firewall.ts).
 * normal → convalescent (the fortnight after any freeze, at a third then
 * two thirds of the budget) → frozen (no cold message leaves).
 */
export const waFirewallTable = pgTable("wa_firewall", {
  userId:            integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  mode:              varchar("mode", { length: 14 }).notNull().default("normal"),
  frozenUntil:       timestamp("frozen_until", { withTimezone: true }),
  reason:            text("reason"),
  convalescentUntil: timestamp("convalescent_until", { withTimezone: true }),
  manualFreeze:      boolean("manual_freeze").notNull().default(false),
  /** The owner may lower the cold daily budget below the ladder; never raise it. */
  coldDailyCap:      integer("cold_daily_cap"),
  /** Buttons and carousels while convalescent: off unless the owner says so. */
  interactiveAllowed: boolean("interactive_allowed").notNull().default(false),
  /** Campaigns a freeze paused, to resume when it lifts. */
  pausedCampaigns:   jsonb("paused_campaigns").$type<number[]>().notNull().default([]),
  freezes:           integer("freezes").notNull().default(0),
  updatedAt:         timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type WaFirewall = typeof waFirewallTable.$inferSelect;

/** Every message the firewall let out: the ledger its budgets and tripwires read. */
export const waFirewallSendsTable = pgTable("wa_firewall_sends", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:     varchar("phone", { length: 50 }).notNull(),
  /** campaign | followup | reply | manual */
  kind:      varchar("kind", { length: 10 }).notNull(),
  /** cold: to someone who has not written to us in three days. */
  cold:      boolean("cold").notNull(),
  messageId: varchar("message_id", { length: 120 }),
  at:        timestamp("at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_wa_firewall_sends_user").on(t.userId, t.at)]);

/** What the firewall did and why: freezes, lifts, blocks, downgrades. */
export const waFirewallEventsTable = pgTable("wa_firewall_events", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  kind:      varchar("kind", { length: 16 }).notNull(),
  detail:    text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_wa_firewall_events_user").on(t.userId, t.createdAt)]);
