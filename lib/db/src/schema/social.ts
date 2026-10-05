import { pgTable, serial, bigserial, integer, varchar, text, boolean, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Social desks ──────────────────────────────────────────────────
// See migration 036. One set of tables for Instagram, TikTok and LinkedIn,
// the platform a column. The team answers who comes to the account, and
// writes first only to people on a list the owner approved.

export const SOCIAL_PLATFORMS = ["instagram", "tiktok", "linkedin"] as const;
export type SocialPlatform = typeof SOCIAL_PLATFORMS[number];

export const socialAccountsTable = pgTable("social_accounts", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:    varchar("platform", { length: 12 }).notNull().$type<SocialPlatform>(),
  /** The browser profile holding this account's cookies. */
  profile:     varchar("profile", { length: 40 }).notNull(),
  username:    varchar("username", { length: 120 }),
  displayName: varchar("display_name", { length: 160 }),
  /** unknown | logged_out | logged_in | checkpoint | restricted */
  state:       varchar("state", { length: 20 }).notNull().default("unknown"),
  stateNote:   text("state_note"),
  lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
  dryRun:      boolean("dry_run").notNull().default(true),
  /** approve | auto */
  mode:        varchar("mode", { length: 10 }).notNull().default("approve"),
  autopilot:   boolean("autopilot").notNull().default(false),
  caps:        jsonb("caps").$type<Partial<Record<string, number>>>().notNull().default({}),
  listIds:     jsonb("list_ids").$type<number[]>().notNull().default([]),
  lastRunAt:   timestamp("last_run_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.platform)]);
export type SocialAccount = typeof socialAccountsTable.$inferSelect;

export const socialPostsTable = pgTable("social_posts", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:     varchar("platform", { length: 12 }).notNull(),
  externalId:   varchar("external_id", { length: 200 }).notNull(),
  url:          text("url").notNull(),
  caption:      text("caption"),
  watching:     boolean("watching").notNull().default(true),
  lastSeenAt:   timestamp("last_seen_at", { withTimezone: true }),
  commentCount: integer("comment_count").notNull().default(0),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.platform, t.externalId)]);
export type SocialPost = typeof socialPostsTable.$inferSelect;

export const socialCommentsTable = pgTable("social_comments", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:   varchar("platform", { length: 12 }).notNull(),
  postId:     integer("post_id").references(() => socialPostsTable.id, { onDelete: "cascade" }),
  externalId: varchar("external_id", { length: 300 }).notNull(),
  author:     varchar("author", { length: 160 }).notNull(),
  authorUrl:  text("author_url"),
  text:       text("text").notNull(),
  intent:     varchar("intent", { length: 20 }),
  isLead:     boolean("is_lead").notNull().default(false),
  draft:      text("draft"),
  /** new | drafted | approved | replied | skipped | failed */
  status:     varchar("status", { length: 20 }).notNull().default("new"),
  skipReason: text("skip_reason"),
  repliedAt:  timestamp("replied_at", { withTimezone: true }),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.platform, t.externalId), index("idx_social_comments").on(t.userId, t.platform, t.status)]);
export type SocialComment = typeof socialCommentsTable.$inferSelect;

export const socialListsTable = pgTable("social_lists", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:  varchar("platform", { length: 12 }).notNull(),
  name:      varchar("name", { length: 160 }).notNull(),
  sector:    varchar("sector", { length: 40 }),
  query:     text("query"),
  folderId:  integer("folder_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type SocialList = typeof socialListsTable.$inferSelect;

export const socialTargetsTable = pgTable("social_targets", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:   varchar("platform", { length: 12 }).notNull(),
  listId:     integer("list_id").references(() => socialListsTable.id, { onDelete: "set null" }),
  handle:     varchar("handle", { length: 200 }).notNull(),
  name:       varchar("name", { length: 200 }),
  headline:   text("headline"),
  company:    varchar("company", { length: 200 }),
  sector:     varchar("sector", { length: 40 }),
  city:       varchar("city", { length: 80 }),
  profileUrl: text("profile_url"),
  /** search | import | manual | comment */
  source:     varchar("source", { length: 20 }).notNull().default("manual"),
  /** new | drafted | approved | invited | sent | replied | declined | unreachable | skipped | failed */
  status:     varchar("status", { length: 20 }).notNull().default("new"),
  draft:      text("draft"),
  note:       text("note"),
  invitedAt:  timestamp("invited_at", { withTimezone: true }),
  sentAt:     timestamp("sent_at", { withTimezone: true }),
  repliedAt:  timestamp("replied_at", { withTimezone: true }),
  followups:  integer("followups").notNull().default(0),
  nextAt:     timestamp("next_at", { withTimezone: true }),
  threadId:   integer("thread_id"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:  timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.platform, t.handle), index("idx_social_targets").on(t.userId, t.platform, t.status), index("idx_social_targets_list").on(t.listId)]);
export type SocialTarget = typeof socialTargetsTable.$inferSelect;

export const socialThreadsTable = pgTable("social_threads", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:      varchar("platform", { length: 12 }).notNull(),
  handle:        varchar("handle", { length: 200 }).notNull(),
  displayName:   varchar("display_name", { length: 200 }),
  threadUrl:     text("thread_url"),
  /** inbound | outreach | comment */
  origin:        varchar("origin", { length: 20 }).notNull().default("inbound"),
  targetId:      integer("target_id"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastFromThem:  boolean("last_from_them").notNull().default(false),
  unread:        boolean("unread").notNull().default(false),
  intent:        varchar("intent", { length: 20 }),
  temperature:   varchar("temperature", { length: 10 }),
  /** open | qualified | closed | stopped */
  status:        varchar("status", { length: 20 }).notNull().default("open"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique().on(t.userId, t.platform, t.handle)]);
export type SocialThread = typeof socialThreadsTable.$inferSelect;

export const socialMessagesTable = pgTable("social_messages", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:  varchar("platform", { length: 12 }).notNull(),
  threadId:  integer("thread_id").notNull().references(() => socialThreadsTable.id, { onDelete: "cascade" }),
  fromMe:    boolean("from_me").notNull().default(false),
  text:      text("text").notNull(),
  /** received | drafted | approved | sent | failed | skipped */
  status:    varchar("status", { length: 20 }).notNull().default("received"),
  /** reply | outreach | followup */
  kind:      varchar("kind", { length: 20 }),
  role:      varchar("role", { length: 30 }),
  hash:      varchar("hash", { length: 64 }),
  error:     text("error"),
  sentAt:    timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_social_messages").on(t.threadId, t.createdAt)]);
export type SocialMessage = typeof socialMessagesTable.$inferSelect;

export const socialContentTable = pgTable("social_content", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:    varchar("platform", { length: 12 }).notNull(),
  /** post | engage */
  kind:        varchar("kind", { length: 10 }).notNull().default("post"),
  topic:       text("topic"),
  targetUrl:   text("target_url"),
  targetText:  text("target_text"),
  text:        text("text").notNull(),
  /** draft | approved | published | failed | skipped */
  status:      varchar("status", { length: 20 }).notNull().default("draft"),
  role:        varchar("role", { length: 30 }),
  error:       text("error"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  url:         text("url"),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type SocialContent = typeof socialContentTable.$inferSelect;

export const socialActionsTable = pgTable("social_actions", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:  varchar("platform", { length: 12 }).notNull(),
  role:      varchar("role", { length: 30 }).notNull(),
  action:    varchar("action", { length: 30 }).notNull(),
  target:    varchar("target", { length: 200 }),
  ok:        boolean("ok").notNull().default(true),
  detail:    text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_social_actions").on(t.userId, t.platform, t.createdAt)]);

export const socialActivityTable = pgTable("social_activity", {
  id:        bigserial("id", { mode: "number" }).primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  platform:  varchar("platform", { length: 12 }).notNull(),
  role:      varchar("role", { length: 30 }).notNull(),
  action:    varchar("action", { length: 30 }).notNull(),
  text:      text("text").notNull(),
  ref:       jsonb("ref").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_social_activity").on(t.userId, t.platform, t.createdAt)]);
