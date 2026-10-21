import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb, numeric, primaryKey, uniqueIndex, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Where a lead came from ────────────────────────────────────────
// A click-to-WhatsApp ad stamps the first incoming message with referral data
// (contextInfo.externalAdReply + entryPointConversionSource), so an ad lead
// identifies itself and needs no manual tagging. Everything else defaults to
// "organic". Recorded once, on first contact.
export const leadSourcesTable = pgTable("lead_sources", {
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:       varchar("phone", { length: 50 }).notNull(),
  source:      varchar("source", { length: 20 }).notNull().default("organic"), // ad | organic
  adSourceId:  text("ad_source_id"),    // the ad's id, when WhatsApp gives one
  adSourceUrl: text("ad_source_url"),
  adTitle:     text("ad_title"),
  ctwaClid:    text("ctwa_clid"),       // click-to-WhatsApp click id
  entryPoint:  text("entry_point"),     // entryPointConversionSource, e.g. ctwa_ad
  // The raw referral payload, kept so a lead that was not recognised as an ad
  // can still be inspected afterwards — useful before the first ad runs.
  rawReferral: jsonb("raw_referral"),
  // What the lead's most recent reply meant, from lib/intent.ts.
  lastIntent:       varchar("last_intent", { length: 20 }),
  lastIntentAt:     timestamp("last_intent_at", { withTimezone: true }),
  intentConfidence: numeric("intent_confidence", { precision: 3, scale: 2 }),
  lastMessage:      text("last_message"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  /** Which employee put them in the queue, and why. */
  queuedBy:  varchar("queued_by", { length: 30 }),
  queueNote: text("queue_note"),
}, (t) => [
  primaryKey({ columns: [t.userId, t.phone] }),
  index("idx_lead_sources_source").on(t.userId, t.source),
]);

// ── A follow-up plan ──────────────────────────────────────────────
// steps: [{ offsetMinutes, message }], offsets measured from first contact.
export const followUpSequencesTable = pgTable("follow_up_sequences", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:         varchar("name", { length: 255 }).notNull(),
  isActive:     boolean("is_active").notNull().default(false),
  // Which leads it enrols: "ad" for ad traffic only, "all" to include organic.
  sourceFilter: varchar("source_filter", { length: 20 }).notNull().default("all"),
  steps:        jsonb("steps").notNull(),
  // Someone who answers should stop receiving the rest of the sequence. This
  // is what separates a follow-up from a drip of unwanted messages.
  stopOnReply:  boolean("stop_on_reply").notNull().default(true),
  // Intents that do NOT stop the sequence. A greeting is not engagement, so
  // the bot keeps following up; anything else hands the lead to a human.
  continueOnIntents: jsonb("continue_on_intents").notNull().default(["greeting", "unclear"]),
  // Ask the free endpoint for a second opinion on low-confidence replies.
  // Off by default: it is rate-limited to one request per IP and sends the
  // customer's message to a third party.
  useAi: boolean("use_ai").notNull().default(false),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  /** The ladder runs and the team argues, but nothing reaches a customer. */
  dryRun:    boolean("dry_run").notNull().default(true),
});

// ── One scheduled message ─────────────────────────────────────────
export const followUpJobsTable = pgTable("follow_up_jobs", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sequenceId: integer("sequence_id").notNull().references(() => followUpSequencesTable.id, { onDelete: "cascade" }),
  phone:      varchar("phone", { length: 50 }).notNull(),
  stepIndex:  integer("step_index").notNull(),
  dueAt:      timestamp("due_at", { withTimezone: true }).notNull(),
  // pending | sent | cancelled | failed | skipped
  status:     varchar("status", { length: 20 }).notNull().default("pending"),
  sentAt:     timestamp("sent_at", { withTimezone: true }),
  error:      text("error"),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  // Enrolment runs on every inbound message, so it must be idempotent.
  uniqueIndex("idx_follow_up_jobs_unique").on(t.sequenceId, t.phone, t.stepIndex),
  index("idx_follow_up_jobs_due").on(t.status, t.dueAt),
]);

export type LeadSource       = typeof leadSourcesTable.$inferSelect;
export type FollowUpSequence = typeof followUpSequencesTable.$inferSelect;
export type FollowUpJob      = typeof followUpJobsTable.$inferSelect;

export interface FollowUpStep { offsetMinutes: number; message: string }

/** The cadence asked for: 1h, 6h, 12h, 1d, 3d, 1w, 1mo — offsets in minutes. */
export const DEFAULT_FOLLOW_UP_OFFSETS = [60, 360, 720, 1_440, 4_320, 10_080, 43_200] as const;

/**
 * Starting copy for each step.
 *
 * Written out rather than generated from the interval, because the earlier
 * version built every message from one template and leaked the step label into
 * the text — seven identical messages ending in "(متابعة بعد 6 ساعات)". These
 * escalate instead: a warm check straight after contact, softer and further
 * apart as time passes, and an explicit way out once the gap is long enough
 * that a reminder could be unwelcome. Owners are expected to edit them; the
 * point is that the starting point reads like a person wrote it.
 */
export const DEFAULT_FOLLOW_UP_STEPS: ReadonlyArray<{ offsetMinutes: number; message: string }> = [
  { offsetMinutes: 60,
    message: "شكراً لتواصلك معنا 🌿\nهل وصلتك المعلومات التي تحتاجها، أم تحب أشرح لك أكثر؟" },
  { offsetMinutes: 360,
    message: "مرحباً مجدداً 👋\nلو عندك أي سؤال عن الخدمة أو الأسعار، أنا جاهز أرد عليك الآن." },
  { offsetMinutes: 720,
    message: "حابين نطمئن عليك 🙏\nتحتاج مساعدة في اختيار الأنسب لك؟ اكتب لي وأرتبها لك." },
  { offsetMinutes: 1_440,
    message: "مرحباً 🌿\nما زال عرضنا متاحاً لك. تحب أحجز لك موعداً أو أرسل لك التفاصيل كاملة؟" },
  { offsetMinutes: 4_320,
    message: "مرّت أيام على تواصلك معنا 🌱\nإن كان الوقت غير مناسب الآن، قل لي متى أعاود التواصل وسأحترم ذلك." },
  { offsetMinutes: 10_080,
    message: "تحية طيبة 🌟\nما زلنا في خدمتك متى احتجتنا. للإيقاف عن الرسائل أرسل «إيقاف»." },
  { offsetMinutes: 43_200,
    message: "مرحباً 👋\nمرّ شهر على تواصلك، وأحببنا نذكّرك أننا موجودون لو احتجت شيئاً. للإيقاف أرسل «إيقاف»." },
];

// ── The argument behind each follow-up ────────────────────────────
// A timer knows the hour and nothing else: not whether this person ever opened
// a message, not whether the number is currently at risk, not whether a
// seventh nudge to someone who has ignored six is worth the complaint it
// invites. Each step is argued for now, and the argument is kept — both so a
// verdict can be audited, and so the owner can read the judgement before
// trusting it with a real send.
export const followupDeliberationsTable = pgTable("followup_deliberations", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  jobId:       integer("job_id"),
  phone:       varchar("phone", { length: 50 }).notNull(),
  step:        integer("step").notNull(),
  segment:     varchar("segment", { length: 30 }),
  opens:       integer("opens").notNull().default(0),
  /** send | hold | drop */
  verdict:     varchar("verdict", { length: 20 }).notNull(),
  reason:      text("reason"),
  /** Kept apart: the manager judges worth, operations judges risk. */
  managerView: text("manager_view"),
  opsView:     text("ops_view"),
  /** What would have gone out — kept even when nothing is sent. */
  draft:       text("draft"),
  executed:    boolean("executed").notNull().default(false),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_delib").on(t.userId, t.createdAt)]);

export type FollowupDeliberation = typeof followupDeliberationsTable.$inferSelect;
