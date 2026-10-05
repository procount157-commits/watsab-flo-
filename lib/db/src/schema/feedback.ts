import { pgTable, bigserial, integer, varchar, text, real, timestamp, date, bigint, index, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// See migration 037.
export const agentFeedbackTable = pgTable("agent_feedback", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:      varchar("role", { length: 30 }).notNull(),
  /** email | social | groups | whatsapp */
  channel:   varchar("channel", { length: 12 }).notNull(),
  kind:      varchar("kind", { length: 20 }).notNull(),
  refId:     varchar("ref_id", { length: 60 }),
  context:   text("context"),
  original:  text("original").notNull(),
  final:     text("final"),
  /** approved | edited | rejected */
  verdict:   varchar("verdict", { length: 10 }).notNull(),
  score:     real("score"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_agent_feedback").on(t.userId, t.role, t.createdAt)]);
export type AgentFeedback = typeof agentFeedbackTable.$inferSelect;

export const llmUsageTable = pgTable("llm_usage", {
  userId:   integer("user_id").notNull(),
  role:     varchar("role", { length: 30 }).notNull(),
  day:      date("day").notNull(),
  calls:    integer("calls").notNull().default(0),
  failed:   integer("failed").notNull().default(0),
  charsIn:  bigint("chars_in", { mode: "number" }).notNull().default(0),
  charsOut: bigint("chars_out", { mode: "number" }).notNull().default(0),
  ms:       bigint("ms", { mode: "number" }).notNull().default(0),
}, (t) => [primaryKey({ columns: [t.userId, t.role, t.day] })]);
