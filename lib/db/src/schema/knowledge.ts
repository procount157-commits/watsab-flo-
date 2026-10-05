import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Business knowledge ────────────────────────────────────────────
// What the bot is allowed to say. Answers are grounded in these entries and
// nothing else, which is the difference between a bot that helps and one that
// invents a price.
export const knowledgeBaseTable = pgTable("knowledge_base", {
  id:       serial("id").primaryKey(),
  userId:   integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title:    varchar("title", { length: 255 }).notNull(),
  content:  text("content").notNull(),
  // Extra words that should match this entry but do not appear in its text —
  // dialect spellings, product nicknames, common misspellings.
  keywords: text("keywords"),
  category: varchar("category", { length: 50 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_kb_user").on(t.userId, t.isActive)]);

// ── Business profile ──────────────────────────────────────────────
// One row per account: the standing context every answer is written against.
export const businessProfileTable = pgTable("business_profile", {
  userId:      integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  name:        varchar("name", { length: 255 }),
  industry:    varchar("industry", { length: 120 }),
  description: text("description"),
  tone:        varchar("tone", { length: 30 }).default("friendly"),
  // Things the bot must never do, in the owner's own words.
  guardrails:  text("guardrails"),
  /** off | mirror — answer a voice note with a voice note */
  voiceReplies: varchar("voice_replies", { length: 10 }).notNull().default("mirror"),
  autoReply:   boolean("auto_reply").notNull().default(false),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── What the bot actually said ────────────────────────────────────
// Every generated reply is logged with the entries it drew on, so a wrong
// answer can be traced to the entry that caused it rather than guessed at.
export const autoReplyLogTable = pgTable("auto_reply_log", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:      varchar("phone", { length: 50 }).notNull(),
  incoming:   text("incoming"),
  reply:      text("reply"),
  provider:   varchar("provider", { length: 30 }),   // gemini | groq | openrouter | kb | none
  kbIds:      text("kb_ids"),                        // comma-separated entry ids used
  intent:     varchar("intent", { length: 20 }),
  skipped:    varchar("skipped", { length: 60 }),    // why nothing was sent
  agentRole:  varchar("agent_role", { length: 30 }),  // which employee answered
  outcome:    varchar("outcome", { length: 20 }),     // what the customer did next
  qualityScore: integer("quality_score"),              // the pre-send check, 100 = clean
  qualityNotes: text("quality_notes"),
  rewritten:  boolean("rewritten").notNull().default(false),
  ownerRating: integer("owner_rating"),                // +1 / -1 from the review page
  ownerNote:  text("owner_note"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_auto_reply_user").on(t.userId, t.createdAt)]);

export type KnowledgeEntry  = typeof knowledgeBaseTable.$inferSelect;
export type BusinessProfile = typeof businessProfileTable.$inferSelect;

// ── What the bot remembers about a person ─────────────────────────
// Recent turns come from wa_thread_messages, which is already written on every
// message — no second copy to drift. This table is the durable part: the few
// things worth carrying across conversations weeks apart, like which villa
// they asked about or that they only answer in the evening.
export const contactMemoryTable = pgTable("contact_memory", {
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:     varchar("phone", { length: 50 }).notNull(),
  // [{ fact, source, at }] — kept as a list rather than prose so single facts
  // can be corrected or dropped without rewriting the lot.
  facts:     jsonb("facts").notNull().default([]),
  summary:   text("summary"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.phone] })]);

export interface MemoryFact { fact: string; source?: string; at?: string }
export type ContactMemory = typeof contactMemoryTable.$inferSelect;
