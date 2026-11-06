import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb, index, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── مكتب الحسابات المستهدفة (migration 071) ─────────────────────────
// عشر شركات في اليوم: من يقرّر الامتثال فيها، وبريده، ورسالةٌ له وحده.
// النشر لا يشغّل ملفات SQL، فـ lib/accounts/desk.ts ينشئ الجداول نفسها
// عند الإقلاع (CREATE TABLE IF NOT EXISTS) — والملف 071 للنسخ المحلية.

export const accountsDeskSettingsTable = pgTable("accounts_desk_settings", {
  userId:    integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  enabled:   boolean("enabled").notNull().default(false),
  perDay:    integer("per_day").notNull().default(10),
  sectors:   jsonb("sectors").notNull().default(["عقارات"]),
  emirates:  jsonb("emirates").notNull().default([]),
  /** مفتاح Tavily إن حفظه صاحب العمل — لا يُعاد في أي رد. */
  searchKey: varchar("search_key", { length: 200 }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const TARGET_STATUSES = ["researching", "ready", "no_person", "no_email", "needs_review", "sent", "replied", "meeting", "skipped", "no_site"] as const;
export type TargetStatus = typeof TARGET_STATUSES[number];

export interface TargetFollowup { afterDays: number; subject: string; body: string }

export const targetAccountsTable = pgTable("target_accounts", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  company:       varchar("company", { length: 200 }).notNull(),
  domain:        varchar("domain", { length: 200 }).notNull(),
  website:       varchar("website", { length: 300 }),
  city:          varchar("city", { length: 120 }),
  sector:        varchar("sector", { length: 60 }),
  signal:        text("signal"),
  signalSource:  varchar("signal_source", { length: 500 }),
  status:        varchar("status", { length: 20 }).notNull().default("researching"),
  /** يوم الاختيار بتوقيت دبي، YYYY-MM-DD. */
  runDate:       varchar("run_date", { length: 10 }).notNull(),
  notes:         text("notes"),
  emailTo:       varchar("email_to", { length: 254 }),
  emailSubject:  varchar("email_subject", { length: 300 }),
  emailBody:     text("email_body"),
  emailFollowups: jsonb("email_followups").notNull().default([]),
  linkedinMessage: text("linkedin_message"),
  linkedinDone:  boolean("linkedin_done").notNull().default(false),
  contactId:     integer("contact_id"),
  sequenceId:    integer("sequence_id"),
  sentAt:        timestamp("sent_at", { withTimezone: true }),
  openedAt:      timestamp("opened_at", { withTimezone: true }),
  repliedAt:     timestamp("replied_at", { withTimezone: true }),
  meetingAt:     timestamp("meeting_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  unique("uq_target_accounts_domain").on(t.userId, t.domain),
  index("idx_target_accounts_user").on(t.userId, t.status),
  index("idx_target_accounts_day").on(t.userId, t.runDate),
]);

export const targetPeopleTable = pgTable("target_people", {
  id:             serial("id").primaryKey(),
  userId:         integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  accountId:      integer("account_id").notNull().references(() => targetAccountsTable.id, { onDelete: "cascade" }),
  name:           varchar("name", { length: 160 }).notNull(),
  title:          varchar("title", { length: 200 }),
  why:            text("why"),
  email:          varchar("email", { length: 254 }),
  /** published | verified | catchall | guessed | invalid */
  emailStatus:    varchar("email_status", { length: 12 }),
  emailFallback:  boolean("email_fallback").notNull().default(false),
  linkedinUrl:    varchar("linkedin_url", { length: 400 }),
  sourceUrl:      varchar("source_url", { length: 500 }),
  isDecisionMaker: boolean("is_decision_maker").notNull().default(false),
  contactId:      integer("contact_id"),
  sequenceId:     integer("sequence_id"),
  createdAt:      timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_target_people_account").on(t.accountId)]);

export type TargetAccount = typeof targetAccountsTable.$inferSelect;
export type TargetPerson = typeof targetPeopleTable.$inferSelect;
export type AccountsDeskSettings = typeof accountsDeskSettingsTable.$inferSelect;
