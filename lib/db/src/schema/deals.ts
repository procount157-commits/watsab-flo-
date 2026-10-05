import { pgTable, serial, integer, varchar, text, boolean, timestamp, numeric, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// See migration 040.
export const DEAL_STAGES = ["lead", "meeting", "proposal", "negotiation", "won", "lost"] as const;
export type DealStage = typeof DEAL_STAGES[number];

export const dealsTable = pgTable("deals", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title:       varchar("title", { length: 200 }).notNull(),
  company:     varchar("company", { length: 200 }),
  contactName: varchar("contact_name", { length: 160 }),
  channel:     varchar("channel", { length: 12 }).notNull().default("manual"),
  ref:         varchar("ref", { length: 200 }),
  email:       varchar("email", { length: 254 }),
  phone:       varchar("phone", { length: 30 }),
  stage:       varchar("stage", { length: 12 }).notNull().default("lead").$type<DealStage>(),
  service:     varchar("service", { length: 160 }),
  valueAed:    numeric("value_aed", { precision: 12, scale: 2 }),
  notes:       text("notes"),
  nextStep:    varchar("next_step", { length: 300 }),
  nextAt:      timestamp("next_at", { withTimezone: true }),
  lostReason:  varchar("lost_reason", { length: 300 }),
  wonAt:       timestamp("won_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_deals_stage").on(t.userId, t.stage)]);
export type Deal = typeof dealsTable.$inferSelect;

export const proposalsTable = pgTable("proposals", {
  id:             serial("id").primaryKey(),
  userId:         integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  dealId:         integer("deal_id").notNull().references(() => dealsTable.id, { onDelete: "cascade" }),
  title:          varchar("title", { length: 200 }).notNull(),
  html:           text("html").notNull(),
  originalHtml:   text("original_html"),
  /** draft | approved | sent | accepted | declined */
  status:         varchar("status", { length: 12 }).notNull().default("draft"),
  sentTo:         varchar("sent_to", { length: 254 }),
  sentAt:         timestamp("sent_at", { withTimezone: true }),
  followups:      integer("followups").notNull().default(0),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  followupDraft:  text("followup_draft"),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_deal_proposals").on(t.userId, t.status)]);
export type Proposal = typeof proposalsTable.$inferSelect;

export type Slot = { dow: number; from: string; to: string };
export const meetingSettingsTable = pgTable("meeting_settings", {
  userId:         integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  slots:          jsonb("slots").$type<Slot[]>().notNull(),
  durationMin:    integer("duration_min").notNull().default(30),
  bufferMin:      integer("buffer_min").notNull().default(15),
  noticeHours:    integer("notice_hours").notNull().default(3),
  reminderMin:    integer("reminder_min").notNull().default(30),
  bookingToken:   varchar("booking_token", { length: 48 }).notNull(),
  offerInReplies: boolean("offer_in_replies").notNull().default(true),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type MeetingSettings = typeof meetingSettingsTable.$inferSelect;

export const clientMeetingsTable = pgTable("client_meetings", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  dealId:      integer("deal_id").references(() => dealsTable.id, { onDelete: "set null" }),
  name:        varchar("name", { length: 160 }).notNull(),
  company:     varchar("company", { length: 200 }),
  email:       varchar("email", { length: 254 }),
  phone:       varchar("phone", { length: 30 }),
  startsAt:    timestamp("starts_at", { withTimezone: true }).notNull(),
  durationMin: integer("duration_min").notNull().default(30),
  /** booked | done | cancelled | no_show */
  status:      varchar("status", { length: 12 }).notNull().default("booked"),
  /** link | manual */
  source:      varchar("source", { length: 10 }).notNull().default("manual"),
  topic:       text("topic"),
  notes:       text("notes"),
  remindedAt:  timestamp("reminded_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_client_meetings").on(t.userId, t.startsAt)]);
export type ClientMeeting = typeof clientMeetingsTable.$inferSelect;
