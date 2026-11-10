// ── غرفة تحكّم المالك: المكالمات والاجتماعات داخل التطبيق ─────────────
// صوتٌ نصف اتجاهي: المالك يتكلم، يُفرَّغ نصّه، يجيب الموظف بدوره، ويُقرأ الرد بصوت.
// لا هاتف ولا تقويم ولا صوت كامل الاتجاهين — تلك محجوبة في الجاهزية.
//
// النشر لا يشغّل ملفات SQL: VOICE_SQL في artifacts/api-server/src/lib/org/voice/schema.ts
// ينفّذ نص 078_owner_calls.sql نفسه عند الإقلاع، وorg-voice.test.ts يقارن الاثنين.
// الصوت نفسه لا يُحفظ إلا إن فعّل صاحب الحساب call_recording صراحةً (الافتراضي مطفأ).

import { sql } from "drizzle-orm";
import { boolean, check, customType, index, integer, jsonb, pgTable, serial, text, timestamp, unique, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

const at = (name: string) => timestamp(name, { withTimezone: true });
const created = () => at("created_at").defaultNow().notNull();
const owner = () => integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" });
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const CALL_STATES = ["ringing", "connected", "busy", "unavailable", "ended"] as const;
export const MEETING_STATES = ["scheduled", "in_progress", "ended", "cancelled"] as const;
export const MEETING_PHASES = ["opening", "round", "dissent", "decisions", "closed"] as const;

/** إعدادات الصوت لكل حساب. لا صف = التسجيل مطفأ. */
export const ownerVoiceSettingsTable = pgTable("owner_voice_settings", {
  userId:        integer("user_id").primaryKey().references(() => usersTable.id, { onDelete: "cascade" }),
  callRecording: boolean("call_recording").notNull().default(false),
  updatedBy:     integer("updated_by"),
  updatedAt:     at("updated_at").defaultNow().notNull(),
});

export const ownerCallsTable = pgTable("owner_calls", {
  id:            serial("id").primaryKey(),
  userId:        owner(),
  startedBy:     integer("started_by").notNull(),
  employeeKey:   varchar("employee_key", { length: 60 }).notNull(),
  employeeRole:  varchar("employee_role", { length: 60 }).notNull(),
  state:         varchar("state", { length: 20 }).notNull().default("ringing"),
  stateReason:   text("state_reason"),
  lang:          varchar("lang", { length: 8 }).notNull().default("auto"),
  recording:     boolean("recording").notNull().default(false),
  modelCalls:    integer("model_calls").notNull().default(0),
  sttMsTotal:    integer("stt_ms_total").notNull().default(0),
  turns:         integer("turns").notNull().default(0),
  summary:       text("summary"),
  summaryStatus: varchar("summary_status", { length: 20 }),
  actionItems:   jsonb("action_items").notNull().default([]),
  startedAt:     at("started_at").defaultNow().notNull(),
  connectedAt:   at("connected_at"),
  endedAt:       at("ended_at"),
  endReason:     text("end_reason"),
}, (t) => [
  index("idx_owner_calls_user").on(t.userId, t.startedAt),
  index("idx_owner_calls_employee").on(t.userId, t.employeeKey, t.state),
  check("owner_calls_state", sql`${t.state} IN ('ringing','connected','busy','unavailable','ended')`),
]);

export const callParticipantsTable = pgTable("call_participants", {
  id:          serial("id").primaryKey(),
  callId:      integer("call_id").notNull().references(() => ownerCallsTable.id, { onDelete: "cascade" }),
  userId:      owner(),
  kind:        varchar("kind", { length: 12 }).notNull(),
  employeeKey: varchar("employee_key", { length: 60 }),
  joinedAt:    at("joined_at").defaultNow().notNull(),
  leftAt:      at("left_at"),
}, (t) => [
  index("idx_call_participants_call").on(t.callId),
  check("call_participants_kind", sql`${t.kind} IN ('owner','employee')`),
]);

export const callTranscriptsTable = pgTable("call_transcripts", {
  id:          serial("id").primaryKey(),
  callId:      integer("call_id").notNull().references(() => ownerCallsTable.id, { onDelete: "cascade" }),
  userId:      owner(),
  seq:         integer("seq").notNull(),
  speaker:     varchar("speaker", { length: 12 }).notNull(),
  employeeKey: varchar("employee_key", { length: 60 }),
  text:        text("text").notNull(),
  lang:        varchar("lang", { length: 8 }),
  source:      varchar("source", { length: 12 }).notNull(),
  sttModel:    varchar("stt_model", { length: 60 }),
  audioMs:     integer("audio_ms"),
  sttMs:       integer("stt_ms"),
  llmMs:       integer("llm_ms"),
  ttsMs:       integer("tts_ms"),
  ttsVoice:    varchar("tts_voice", { length: 60 }),
  evidence:    jsonb("evidence"),
  flags:       jsonb("flags"),
  audio:       bytea("audio"),
  audioMime:   varchar("audio_mime", { length: 60 }),
  createdAt:   created(),
}, (t) => [
  unique("uq_call_transcripts_seq").on(t.callId, t.seq),
  index("idx_call_transcripts_user").on(t.userId, t.callId),
  check("call_transcripts_speaker", sql`${t.speaker} IN ('owner','employee','system')`),
  check("call_transcripts_source", sql`${t.source} IN ('voice','text','system','model')`),
]);

export const ownerMeetingsTable = pgTable("owner_meetings", {
  id:           serial("id").primaryKey(),
  userId:       owner(),
  startedBy:    integer("started_by").notNull(),
  objective:    text("objective").notNull(),
  agenda:       jsonb("agenda").notNull().default([]),
  scope:        text("scope"),
  timeLimitMin: integer("time_limit_min").notNull().default(20),
  state:        varchar("state", { length: 20 }).notNull().default("scheduled"),
  phase:        varchar("phase", { length: 20 }).notNull().default("opening"),
  cursor:       integer("cursor").notNull().default(0),
  lang:         varchar("lang", { length: 8 }).notNull().default("ar"),
  scheduledAt:  at("scheduled_at"),
  startedAt:    at("started_at"),
  endedAt:      at("ended_at"),
  endReason:    text("end_reason"),
  modelCalls:   integer("model_calls").notNull().default(0),
  summary:      text("summary"),
  createdAt:    created(),
}, (t) => [
  index("idx_owner_meetings_user").on(t.userId, t.createdAt),
  check("owner_meetings_state", sql`${t.state} IN ('scheduled','in_progress','ended','cancelled')`),
  check("owner_meetings_phase", sql`${t.phase} IN ('opening','round','dissent','decisions','closed')`),
]);

export const meetingAttendeesTable = pgTable("meeting_attendees", {
  id:            serial("id").primaryKey(),
  meetingId:     integer("meeting_id").notNull().references(() => ownerMeetingsTable.id, { onDelete: "cascade" }),
  userId:        owner(),
  employeeKey:   varchar("employee_key", { length: 60 }).notNull(),
  employeeRole:  varchar("employee_role", { length: 60 }).notNull(),
  turnOrder:     integer("turn_order").notNull(),
  reason:        text("reason"),
  recommendedBy: varchar("recommended_by", { length: 10 }).notNull().default("owner"),
  status:        varchar("status", { length: 12 }).notNull().default("present"),
  statusReason:  text("status_reason"),
}, (t) => [
  unique("uq_meeting_attendees").on(t.meetingId, t.employeeKey),
  check("meeting_attendees_status", sql`${t.status} IN ('present','unavailable')`),
  check("meeting_attendees_by", sql`${t.recommendedBy} IN ('owner','ceo')`),
]);

export const meetingMinutesTable = pgTable("meeting_minutes", {
  id:          serial("id").primaryKey(),
  meetingId:   integer("meeting_id").notNull().references(() => ownerMeetingsTable.id, { onDelete: "cascade" }),
  userId:      owner(),
  seq:         integer("seq").notNull(),
  speaker:     varchar("speaker", { length: 12 }).notNull(),
  employeeKey: varchar("employee_key", { length: 60 }),
  kind:        varchar("kind", { length: 16 }).notNull(),
  text:        text("text").notNull(),
  lang:        varchar("lang", { length: 8 }),
  source:      varchar("source", { length: 12 }).notNull(),
  verified:    jsonb("verified"),
  evidence:    jsonb("evidence"),
  flags:       jsonb("flags"),
  sttModel:    varchar("stt_model", { length: 60 }),
  llmMs:       integer("llm_ms"),
  ttsMs:       integer("tts_ms"),
  ttsVoice:    varchar("tts_voice", { length: 60 }),
  audio:       bytea("audio"),
  audioMime:   varchar("audio_mime", { length: 60 }),
  createdAt:   created(),
}, (t) => [
  unique("uq_meeting_minutes_seq").on(t.meetingId, t.seq),
  check("meeting_minutes_speaker", sql`${t.speaker} IN ('owner','ceo','employee','system')`),
  check("meeting_minutes_kind", sql`${t.kind} IN ('opening','question','answer','dissent','owner','reply','decision','readback','system')`),
  check("meeting_minutes_source", sql`${t.source} IN ('voice','text','system','model','template')`),
]);

export const meetingActionItemsTable = pgTable("meeting_action_items", {
  id:              serial("id").primaryKey(),
  meetingId:       integer("meeting_id").notNull().references(() => ownerMeetingsTable.id, { onDelete: "cascade" }),
  userId:          owner(),
  title:           text("title").notNull(),
  employeeKey:     varchar("employee_key", { length: 60 }).notNull(),
  dueAt:           at("due_at").notNull(),
  expectedOutcome: text("expected_outcome").notNull(),
  metric:          text("metric"),
  ownerDecision:   boolean("owner_decision").notNull().default(false),
  taskId:          integer("task_id"),
  createdAt:       created(),
}, (t) => [
  index("idx_meeting_action_items_meeting").on(t.meetingId),
]);
