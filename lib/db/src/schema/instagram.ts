import { pgTable, serial, integer, varchar, text, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Instagram ─────────────────────────────────────────────────────
// The owner's own business account: answering people who comment on its posts
// and who write to it. Nothing here writes to a stranger who has not
// approached the account first — that line is what separates a social inbox
// from spam, and it is enforced in the schema by `origin` rather than left to
// whoever writes the next feature.
export const instagramAccountsTable = pgTable("instagram_accounts", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** The browser profile holding this account's cookies, named for its employee. */
  role:        varchar("role", { length: 30 }).notNull(),
  username:    varchar("username", { length: 80 }),
  displayName: varchar("display_name", { length: 120 }),
  /** unknown | logged_out | logged_in | checkpoint | restricted */
  state:       varchar("state", { length: 20 }).notNull().default("unknown"),
  stateNote:   text("state_note"),
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  /** Nothing is sent while this is true. It is how the team ships. */
  dryRun:      boolean("dry_run").notNull().default(true),
  /**
   * Conservative by default. Instagram's limits are undocumented and enforced
   * by restricting the account rather than by returning an error, so the only
   * safe assumption is a low one.
   */
  dailyCommentCap: integer("daily_comment_cap").notNull().default(40),
  dailyDmCap:      integer("daily_dm_cap").notNull().default(20),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.role)]);

export const instagramPostsTable = pgTable("instagram_posts", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  shortcode:    varchar("shortcode", { length: 40 }).notNull(),
  url:          text("url").notNull(),
  caption:      text("caption"),
  watching:     boolean("watching").notNull().default(true),
  lastSeenAt:   timestamp("last_seen_at", { withTimezone: true }),
  commentCount: integer("comment_count").notNull().default(0),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.shortcode)]);

export const instagramCommentsTable = pgTable("instagram_comments", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  postId:     integer("post_id").references(() => instagramPostsTable.id, { onDelete: "cascade" }),
  /** Instagram's id where readable, else a hash of author+text — enough never to answer twice. */
  externalId: varchar("external_id", { length: 120 }).notNull(),
  author:     varchar("author", { length: 80 }).notNull(),
  text:       text("text").notNull(),
  postedAt:   timestamp("posted_at", { withTimezone: true }),
  intent:     varchar("intent", { length: 20 }),
  isLead:     boolean("is_lead").notNull().default(false),
  /** The drafted reply, before anyone decides to send it. */
  draft:      text("draft"),
  status:     varchar("status", { length: 20 }).notNull().default("new"),
  skipReason: text("skip_reason"),
  repliedAt:  timestamp("replied_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.externalId), index("idx_ig_comments").on(t.userId, t.status)]);

export const instagramThreadsTable = pgTable("instagram_threads", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  username:      varchar("username", { length: 80 }).notNull(),
  displayName:   varchar("display_name", { length: 120 }),
  /** Why this conversation exists. Never "we found them". */
  origin:        varchar("origin", { length: 20 }).notNull().default("inbound"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastFromThem:  boolean("last_from_them").notNull().default(true),
  intent:        varchar("intent", { length: 20 }),
  status:        varchar("status", { length: 20 }).notNull().default("open"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.username)]);

export const instagramMessagesTable = pgTable("instagram_messages", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  threadId:  integer("thread_id").notNull().references(() => instagramThreadsTable.id, { onDelete: "cascade" }),
  fromMe:    boolean("from_me").notNull(),
  text:      text("text").notNull(),
  status:    varchar("status", { length: 20 }).notNull().default("sent"),
  error:     text("error"),
  sentAt:    timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_ig_messages").on(t.threadId, t.createdAt)]);

/**
 * Every action, recorded as it happens.
 *
 * This is the rate limiter's memory and the only account of what the account
 * actually did. Instagram restricts behaviour that looks mechanical and tells
 * you nothing about why, so the record has to come from this side.
 */
export const instagramActionsTable = pgTable("instagram_actions", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:      varchar("role", { length: 30 }).notNull(),
  action:    varchar("action", { length: 30 }).notNull(),
  target:    varchar("target", { length: 120 }),
  ok:        boolean("ok").notNull().default(true),
  detail:    text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_ig_actions").on(t.userId, t.action, t.createdAt)]);

export type InstagramAccount = typeof instagramAccountsTable.$inferSelect;
export type InstagramComment = typeof instagramCommentsTable.$inferSelect;
export type InstagramThread  = typeof instagramThreadsTable.$inferSelect;
