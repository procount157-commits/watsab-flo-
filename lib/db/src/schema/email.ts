import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb, real, index, primaryKey, unique } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Email marketing ───────────────────────────────────────────────
// The same shape as the WhatsApp side, on purpose: contacts and lists,
// campaigns that enqueue messages, a follow-up ladder, and events read back
// from the world so a campaign is judged by what happened, not by what was
// sent. See migration 024 for the reasoning per table.

export const emailSettingsTable = pgTable("email_settings", {
  userId:       integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  provider:     varchar("provider", { length: 20 }).notNull().default("smtp"),
  smtpHost:     varchar("smtp_host", { length: 200 }),
  smtpPort:     integer("smtp_port").default(587),
  smtpSecure:   boolean("smtp_secure").notNull().default(false),
  smtpUser:     varchar("smtp_user", { length: 200 }),
  smtpPass:     varchar("smtp_pass", { length: 400 }),
  apiKey:       varchar("api_key", { length: 400 }),
  fromName:     varchar("from_name", { length: 120 }),
  fromEmail:    varchar("from_email", { length: 200 }),
  replyTo:      varchar("reply_to", { length: 200 }),
  signature:    text("signature"),
  /** The language email goes out in unless the owner picks another for a campaign: en | ar | both */
  defaultLanguage: varchar("default_language", { length: 5 }).notNull().default("en"),
  /** How hard the follow-up path works: light (3 emails) | normal (4) | intense (6) */
  followIntensity: varchar("follow_intensity", { length: 10 }).notNull().default("intense"),
  /** hold back personal mailboxes at a domain where another one bounced */
  skipRisky:     boolean("skip_risky").notNull().default(true),
  /** the guard's current hold: when it began and when it lifts */
  guardHeldAt:   timestamp("guard_held_at", { withTimezone: true }),
  guardHoldUntil: timestamp("guard_hold_until", { withTimezone: true }),
  /** العنوان العام الذي يصل إليه بريد المستلم — بدونه لا تتبّع فتح ولا نقر. */
  publicUrl:    varchar("public_url", { length: 300 }),
  /** branded (header, card, footer) | plain */
  layout:       varchar("layout", { length: 10 }).notNull().default("branded"),
  brandName:    varchar("brand_name", { length: 80 }),
  brandTagline: varchar("brand_tagline", { length: 120 }),
  brandColor:   varchar("brand_color", { length: 9 }),
  brandAccent:  varchar("brand_accent", { length: 9 }),
  logoUrl:      text("logo_url"),
  website:      varchar("website", { length: 200 }),
  phone:        varchar("phone", { length: 40 }),
  address:      varchar("address", { length: 200 }),
  hourlyCap:    integer("hourly_cap").notNull().default(40),
  dailyCap:     integer("daily_cap").notNull().default(300),
  tracking:     boolean("tracking").notNull().default(true),
  imapHost:     varchar("imap_host", { length: 200 }),
  imapPort:     integer("imap_port").default(993),
  imapUser:     varchar("imap_user", { length: 200 }),
  imapPass:     varchar("imap_pass", { length: 400 }),
  imapLastUid:  integer("imap_last_uid").notNull().default(0),
  imapLastError: text("imap_last_error"),
  inboundToken: varchar("inbound_token", { length: 48 }),
  /** Send the salesman's drafts on their own, for low-risk intents only. */
  autoReply:    boolean("auto_reply").notNull().default(false),
  autoReplyDelayMin: integer("auto_reply_delay_min").notNull().default(12),
  /** Ramp a new sender from 50 a day whatever the daily cap says. */
  warmup:       boolean("warmup").notNull().default(true),
  updatedAt:    timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailContactsTable = pgTable("email_contacts", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  email:         varchar("email", { length: 254 }).notNull(),
  name:          varchar("name", { length: 160 }),
  company:       varchar("company", { length: 200 }),
  phone:         varchar("phone", { length: 50 }),
  industry:      varchar("industry", { length: 120 }),
  city:          varchar("city", { length: 120 }),
  source:        varchar("source", { length: 60 }),
  /** Canonical sector, worked out from the name and activity (lib/email/sector.ts). */
  sector:        varchar("sector", { length: 60 }),
  /** active | unsubscribed | bounced | complained */
  status:        varchar("status", { length: 20 }).notNull().default("active"),
  tags:          jsonb("tags").notNull().default([]),
  mxOk:          boolean("mx_ok"),
  mxCheckedAt:   timestamp("mx_checked_at", { withTimezone: true }),
  lastSentAt:    timestamp("last_sent_at", { withTimezone: true }),
  lastOpenedAt:  timestamp("last_opened_at", { withTimezone: true }),
  /** هدنة: لا تُراسَل هذه الجهة قبل هذا التاريخ — طلبها ردُّها نفسه. */
  quietUntil:   timestamp("quiet_until", { withTimezone: true }),
  quietReason:  varchar("quiet_reason", { length: 200 }),
  lastRepliedAt: timestamp("last_replied_at", { withTimezone: true }),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_email_contacts_user").on(t.userId, t.status), unique().on(t.userId, t.email)]);

export const emailListsTable = pgTable("email_lists", {
  /** سلمى's reading of the list: segments, problems, recommended campaigns. */
  analysis:     jsonb("analysis"),
  analyzedAt:   timestamp("analyzed_at", { withTimezone: true }),
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:        varchar("name", { length: 160 }).notNull(),
  description: text("description"),
  folderId:    integer("folder_id"),
  /** A stage list the follow-up agent keeps under a list it works: its parent, and which stage. */
  parentListId: integer("parent_list_id"),
  /** opened | clicked | replied | unopened */
  stage:       varchar("stage", { length: 20 }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailListMembersTable = pgTable("email_list_members", {
  listId:    integer("list_id").notNull().references(() => emailListsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull().references(() => emailContactsTable.id, { onDelete: "cascade" }),
  addedAt:   timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.listId, t.contactId] })]);

export const emailTemplatesTable = pgTable("email_templates", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:      varchar("name", { length: 160 }).notNull(),
  subject:   varchar("subject", { length: 300 }).notNull(),
  html:      text("html").notNull(),
  category:  varchar("category", { length: 60 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailSegmentsTable = pgTable("email_segments", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:      varchar("name", { length: 160 }).notNull(),
  filter:    jsonb("filter").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailCampaignsTable = pgTable("email_campaigns", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:        varchar("name", { length: 160 }).notNull(),
  listId:      integer("list_id").references(() => emailListsTable.id, { onDelete: "set null" }),
  /** A saved audience instead of a list; resolved when the campaign starts. */
  segmentId:   integer("segment_id"),
  missionId:   integer("mission_id"),
  /** owner | agent */
  createdBy:   varchar("created_by", { length: 20 }).notNull().default("owner"),
  subject:     varchar("subject", { length: 300 }).notNull(),
  html:        text("html").notNull(),
  /** draft | scheduled | sending | paused | completed */
  status:      varchar("status", { length: 20 }).notNull().default("draft"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt:   timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  sentCount:   integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  openCount:   integer("open_count").notNull().default(0),
  clickCount:  integer("click_count").notNull().default(0),
  replyCount:  integer("reply_count").notNull().default(0),
  bounceCount: integer("bounce_count").notNull().default(0),
  unsubCount:  integer("unsub_count").notNull().default(0),
  pauseReason: text("pause_reason"),
  /** guard | owner — only the guard's pauses lift by themselves */
  pausedBy:    varchar("paused_by", { length: 10 }),
  /** A second subject to test against the first. */
  subjectB:    varchar("subject_b", { length: 300 }),
  /** Share of the list that receives the test; 0 means no test. */
  abPct:       integer("ab_pct").notNull().default(0),
  abWaitHours: integer("ab_wait_hours").notNull().default(4),
  abWinner:    varchar("ab_winner", { length: 1 }),
  abDecidedAt: timestamp("ab_decided_at", { withTimezone: true }),
  /** en | ar | both — the message is checked against it. */
  language:     varchar("language", { length: 5 }).notNull().default("en"),
  /** How many times the subject was rewritten after almost nobody opened (the open-rate checkpoint). */
  abRound:      integer("ab_round").notNull().default(0),
  lowOpenAt:    timestamp("low_open_at", { withTimezone: true }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailSequencesTable = pgTable("email_sequences", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:        varchar("name", { length: 160 }).notNull(),
  /** [{ afterHours, subject, html }] */
  steps:       jsonb("steps").notNull().default([]),
  stopOnReply: boolean("stop_on_reply").notNull().default(true),
  stopOnOpen:  boolean("stop_on_open").notNull().default(false),
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailSequenceJobsTable = pgTable("email_sequence_jobs", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sequenceId: integer("sequence_id").notNull().references(() => emailSequencesTable.id, { onDelete: "cascade" }),
  contactId:  integer("contact_id").notNull().references(() => emailContactsTable.id, { onDelete: "cascade" }),
  stepIndex:  integer("step_index").notNull(),
  dueAt:      timestamp("due_at", { withTimezone: true }).notNull(),
  /** pending | sent | cancelled | skipped | failed */
  status:     varchar("status", { length: 20 }).notNull().default("pending"),
  messageId:  integer("message_id"),
  error:      text("error"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_email_seq_jobs_due").on(t.status, t.dueAt), index("idx_email_seq_jobs_contact").on(t.userId, t.contactId, t.status)]);

export const emailMessagesTable = pgTable("email_messages", {
  id:            serial("id").primaryKey(),
  userId:        integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  campaignId:    integer("campaign_id").references(() => emailCampaignsTable.id, { onDelete: "set null" }),
  sequenceJobId: integer("sequence_job_id").references(() => emailSequenceJobsTable.id, { onDelete: "set null" }),
  contactId:     integer("contact_id").references(() => emailContactsTable.id, { onDelete: "set null" }),
  toEmail:       varchar("to_email", { length: 254 }).notNull(),
  subject:       varchar("subject", { length: 300 }).notNull(),
  /** queued | ab_hold | sent | failed | bounced */
  status:        varchar("status", { length: 20 }).notNull().default("queued"),
  variant:       varchar("variant", { length: 1 }),
  providerId:    varchar("provider_id", { length: 200 }),
  token:         varchar("token", { length: 48 }).notNull().unique(),
  messageIdHdr:  varchar("message_id_hdr", { length: 300 }),
  sentAt:        timestamp("sent_at", { withTimezone: true }),
  openedAt:      timestamp("opened_at", { withTimezone: true }),
  openCount:     integer("open_count").notNull().default(0),
  clickedAt:     timestamp("clicked_at", { withTimezone: true }),
  clickCount:    integer("click_count").notNull().default(0),
  repliedAt:     timestamp("replied_at", { withTimezone: true }),
  bouncedAt:     timestamp("bounced_at", { withTimezone: true }),
  error:         text("error"),
  createdAt:     timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("idx_email_messages_queue").on(t.userId, t.status, t.createdAt),
  index("idx_email_messages_campaign").on(t.campaignId),
  index("idx_email_messages_contact").on(t.contactId, t.createdAt),
]);

export const emailEventsTable = pgTable("email_events", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  messageId: integer("message_id").references(() => emailMessagesTable.id, { onDelete: "cascade" }),
  /** open | click | reply | bounce | unsubscribe | complaint | sent | failed */
  type:      varchar("type", { length: 20 }).notNull(),
  url:       text("url"),
  meta:      jsonb("meta").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_email_events_user").on(t.userId, t.createdAt)]);

export const emailInboundTable = pgTable("email_inbound", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  contactId:    integer("contact_id").references(() => emailContactsTable.id, { onDelete: "set null" }),
  messageId:    integer("message_id").references(() => emailMessagesTable.id, { onDelete: "set null" }),
  fromEmail:    varchar("from_email", { length: 254 }).notNull(),
  fromName:     varchar("from_name", { length: 160 }),
  subject:      varchar("subject", { length: 300 }),
  text:         text("text"),
  messageIdHdr: varchar("message_id_hdr", { length: 300 }),
  inReplyTo:    varchar("in_reply_to", { length: 300 }),
  intent:       varchar("intent", { length: 20 }),
  /** نوع الرسالة لا نيّتها: reply | auto_reply | bounce | cold_pitch | newsletter | spam */
  kind:         varchar("kind", { length: 20 }),
  /** هل أرسلنا لهذا العنوان رسالة قبل أن يكتب. الإشارة الوحيدة التي تميّز الرد من الإعلان. */
  solicited:    boolean("solicited"),
  confidence:   real("confidence"),
  reasons:      jsonb("reasons"),
  classifier:   varchar("classifier", { length: 20 }),
  summary:      text("summary"),
  draftReply:   text("draft_reply"),
  draftSubject: varchar("draft_subject", { length: 300 }),
  /** new | drafted | sent | ignored */
  state:        varchar("state", { length: 20 }).notNull().default("new"),
  /** When the draft goes out on its own; null waits for a person. */
  autoSendAt:   timestamp("auto_send_at", { withTimezone: true }),
  receivedAt:   timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("idx_email_inbound_user").on(t.userId, t.receivedAt),
  index("idx_email_inbound_kind").on(t.userId, t.kind),
]);

export type EmailSettings   = typeof emailSettingsTable.$inferSelect;
export type EmailContact    = typeof emailContactsTable.$inferSelect;
export type EmailCampaign   = typeof emailCampaignsTable.$inferSelect;
export type EmailSequence   = typeof emailSequencesTable.$inferSelect;
export type EmailMessage    = typeof emailMessagesTable.$inferSelect;
export type EmailInbound    = typeof emailInboundTable.$inferSelect;
export interface EmailStep { afterHours: number; subject: string; html: string }

export const emailMissionsTable = pgTable("email_missions", {
  id:               serial("id").primaryKey(),
  userId:           integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:             varchar("name", { length: 160 }).notNull(),
  goal:             text("goal").notNull(),
  filter:           jsonb("filter").notNull().default({}),
  language:         varchar("language", { length: 10 }).notNull().default("ar"),
  tone:             varchar("tone", { length: 40 }),
  /** draft | awaiting_approval | sending | following_up | done */
  stage:            varchar("stage", { length: 30 }).notNull().default("draft"),
  /** active | paused */
  status:           varchar("status", { length: 20 }).notNull().default("active"),
  requireApproval:  boolean("require_approval").notNull().default(true),
  pending:          jsonb("pending"),
  campaignId:       integer("campaign_id"),
  warmSequenceId:   integer("warm_sequence_id"),
  coldSequenceId:   integer("cold_sequence_id"),
  followAfterHours: integer("follow_after_hours").notNull().default(48),
  /** light | normal | intense; null means the account's setting. */
  intensity:        varchar("intensity", { length: 10 }),
  /** Which email agent writes it (bot_employees.role); null is نورة. */
  agentRole:        varchar("agent_role", { length: 30 }),
  /** The list the autopilot started it for. */
  sourceListId:     integer("source_list_id"),
  report:           jsonb("report"),
  lastRunAt:        timestamp("last_run_at", { withTimezone: true }),
  createdAt:        timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const emailMissionLogTable = pgTable("email_mission_log", {
  id:        serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => emailMissionsTable.id, { onDelete: "cascade" }),
  kind:      varchar("kind", { length: 20 }).notNull().default("note"),
  text:      text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type EmailSegment = typeof emailSegmentsTable.$inferSelect;
export type EmailMission = typeof emailMissionsTable.$inferSelect;
export interface SegmentFilter {
  sectors?: string[];
  cities?: string[];
  listIds?: number[];
  /** Every list in these folders, resolved when used — a list added to the folder later is included. */
  folderIds?: number[];
  statuses?: string[];
  /** never_sent | sent_no_open | opened_no_reply | clicked | replied */
  engagement?: string[];
  q?: string;
  /** Only contacts with a WhatsApp number on file. */
  hasPhone?: boolean;
  /** Not written to in the last this-many days. */
  quietDays?: number;
  /** Fewer than this many messages in the last 30 days. */
  maxTouches?: number;
  /** At most this many, oldest first — a wave, not the whole list at once. */
  take?: number;
}

// ── What the owner taught the email section ──────────────────────
// A document about the company or its field, kept whole: passages of it are
// quoted to نورة when she writes, and the facts she drew from it live in
// agent_memory with doc_id pointing here.
export const emailKnowledgeDocsTable = pgTable("email_knowledge_docs", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title:     varchar("title", { length: 200 }).notNull(),
  /** company | services | sector | compliance | faq | style | other */
  category:  varchar("category", { length: 30 }).notNull().default("company"),
  /** A sector this document is about, or null for all of them. */
  sector:    varchar("sector", { length: 80 }),
  fileName:  varchar("file_name", { length: 255 }),
  content:   text("content").notNull(),
  chars:     integer("chars").notNull().default(0),
  /** processing | ready | failed */
  status:    varchar("status", { length: 20 }).notNull().default("processing"),
  facts:     integer("facts").notNull().default(0),
  error:     text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type EmailKnowledgeDoc = typeof emailKnowledgeDocsTable.$inferSelect;

// ── The email team on its own ────────────────────────────────────
export const emailAutopilotTable = pgTable("email_autopilot", {
  userId:           integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  enabled:          boolean("enabled").notNull().default(false),
  /** approve | auto */
  mode:             varchar("mode", { length: 10 }).notNull().default("approve"),
  listIds:          jsonb("list_ids").$type<number[]>().notNull().default([]),
  folderIds:        jsonb("folder_ids").$type<number[]>().notNull().default([]),
  /** The sectors worked — empty for every sector. */
  sectors:          jsonb("sectors").$type<string[]>().notNull().default([]),
  waveSize:         integer("wave_size").notNull().default(150),
  followAfterHours: integer("follow_after_hours").notNull().default(48),
  maxTouches:       integer("max_touches").notNull().default(3),
  quietDays:        integer("quiet_days").notNull().default(4),
  language:         varchar("language", { length: 5 }).notNull().default("ar"),
  lastRunAt:        timestamp("last_run_at", { withTimezone: true }),
  updatedAt:        timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
export type EmailAutopilot = typeof emailAutopilotTable.$inferSelect;

export const emailAgentActivityTable = pgTable("email_agent_activity", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:      varchar("role", { length: 30 }).notNull(),
  action:    varchar("action", { length: 30 }).notNull(),
  text:      text("text").notNull(),
  ref:       jsonb("ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_email_agent_activity").on(t.userId, t.createdAt)]);
