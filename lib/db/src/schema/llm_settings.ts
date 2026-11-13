import { pgTable, integer, varchar, timestamp, text, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Model provider credentials ────────────────────────────────────
// Stored rather than read only from .env so a key can be added from the UI and
// survive a restart without editing a file on the server — which on a VPS means
// an SSH session and a redeploy for what is a one-line change.
//
// The key is never returned by the API; responses carry a masked form only.
export const llmSettingsTable = pgTable("llm_settings", {
  userId:    integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  provider:  varchar("provider", { length: 30 }).notNull(),
  apiKey:    varchar("api_key", { length: 400 }).notNull(),
  model:     varchar("model", { length: 120 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type LlmSettings = typeof llmSettingsTable.$inferSelect;

// ── Per-account override ──────────────────────────────────────────
// llm_settings above is read as one shared setting: lib/llm.ts takes its first
// row, whoever saved it, for every account. Kept exactly so — the live accounts
// run on it. An account that wants its own provider and key sets a row here,
// and only its own calls read it; an account with no row here reads the shared
// setting as before. Nothing is copied or moved between the two tables.
export const llmAccountSettingsTable = pgTable("llm_account_settings", {
  userId:    integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  provider:  varchar("provider", { length: 30 }).notNull(),
  apiKey:    varchar("api_key", { length: 400 }).notNull(),
  model:     varchar("model", { length: 120 }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type LlmAccountSettings = typeof llmAccountSettingsTable.$inferSelect;

// ── Measured behaviour, per model ─────────────────────────────────
// Which model to try first is a question about what has actually been
// answering, not about the order someone wrote them in. Not per account: the
// upstream being rate-limited or down is the same fact for every tenant, and
// learning it once is the point.
export const llmHealthTable = pgTable("llm_health", {
  provider:      varchar("provider", { length: 30 }).notNull(),
  model:         varchar("model", { length: 120 }).notNull().default(""),
  ok:            integer("ok").notNull().default(0),
  fail:          integer("fail").notNull().default(0),
  /** Drives the cooldown. Reset by any success. */
  streakFails:   integer("streak_fails").notNull().default(0),
  /** Rolling mean, so a model that got slower looks slower. */
  avgMs:         integer("avg_ms").notNull().default(0),
  lastOkAt:      timestamp("last_ok_at", { withTimezone: true }),
  lastFailAt:    timestamp("last_fail_at", { withTimezone: true }),
  lastError:     text("last_error"),
  /** Skipped entirely until this passes. */
  cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.provider, t.model] })]);

export type LlmHealth = typeof llmHealthTable.$inferSelect;
