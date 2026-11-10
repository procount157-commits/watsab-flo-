// ── جداول غرفة التحكّم ────────────────────────────────────────────
// النص نفسه في lib/db/migrations/078_owner_calls.sql؛ النشر لا يشغّل ملفات SQL، فيُنفَّذ هنا
// عند الإقلاع. org-voice.test.ts يتحقق أن كل عبارة هنا موجودة في الملف حرفاً بحرف.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../logger";
import { ensureOrgTables } from "../schema";

export const VOICE_SQL = [
  `CREATE TABLE IF NOT EXISTS owner_voice_settings (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, call_recording boolean NOT NULL DEFAULT false,
    updated_by integer, updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS owner_calls (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, started_by integer NOT NULL,
    employee_key varchar(60) NOT NULL, employee_role varchar(60) NOT NULL, state varchar(20) NOT NULL DEFAULT 'ringing', state_reason text,
    lang varchar(8) NOT NULL DEFAULT 'auto', recording boolean NOT NULL DEFAULT false, model_calls integer NOT NULL DEFAULT 0,
    stt_ms_total integer NOT NULL DEFAULT 0, turns integer NOT NULL DEFAULT 0, summary text, summary_status varchar(20),
    action_items jsonb NOT NULL DEFAULT '[]'::jsonb, started_at timestamptz NOT NULL DEFAULT now(), connected_at timestamptz,
    ended_at timestamptz, end_reason text,
    CONSTRAINT owner_calls_state CHECK (state IN ('ringing','connected','busy','unavailable','ended')))`,
  `CREATE INDEX IF NOT EXISTS idx_owner_calls_user ON owner_calls (user_id, started_at)`,
  `CREATE INDEX IF NOT EXISTS idx_owner_calls_employee ON owner_calls (user_id, employee_key, state)`,
  `CREATE TABLE IF NOT EXISTS call_participants (
    id serial PRIMARY KEY, call_id integer NOT NULL REFERENCES owner_calls(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind varchar(12) NOT NULL, employee_key varchar(60),
    joined_at timestamptz NOT NULL DEFAULT now(), left_at timestamptz,
    CONSTRAINT call_participants_kind CHECK (kind IN ('owner','employee')))`,
  `CREATE INDEX IF NOT EXISTS idx_call_participants_call ON call_participants (call_id)`,
  `CREATE TABLE IF NOT EXISTS call_transcripts (
    id serial PRIMARY KEY, call_id integer NOT NULL REFERENCES owner_calls(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, seq integer NOT NULL, speaker varchar(12) NOT NULL,
    employee_key varchar(60), text text NOT NULL, lang varchar(8), source varchar(12) NOT NULL, stt_model varchar(60),
    audio_ms integer, stt_ms integer, llm_ms integer, tts_ms integer, tts_voice varchar(60), evidence jsonb, flags jsonb,
    audio bytea, audio_mime varchar(60), created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_call_transcripts_seq UNIQUE (call_id, seq),
    CONSTRAINT call_transcripts_speaker CHECK (speaker IN ('owner','employee','system')),
    CONSTRAINT call_transcripts_source CHECK (source IN ('voice','text','system','model')))`,
  `CREATE INDEX IF NOT EXISTS idx_call_transcripts_user ON call_transcripts (user_id, call_id)`,
  `CREATE TABLE IF NOT EXISTS owner_meetings (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, started_by integer NOT NULL,
    objective text NOT NULL, agenda jsonb NOT NULL DEFAULT '[]'::jsonb, scope text, time_limit_min integer NOT NULL DEFAULT 20,
    state varchar(20) NOT NULL DEFAULT 'scheduled', phase varchar(20) NOT NULL DEFAULT 'opening', cursor integer NOT NULL DEFAULT 0,
    lang varchar(8) NOT NULL DEFAULT 'ar', scheduled_at timestamptz, started_at timestamptz, ended_at timestamptz, end_reason text,
    model_calls integer NOT NULL DEFAULT 0, summary text, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT owner_meetings_state CHECK (state IN ('scheduled','in_progress','ended','cancelled')),
    CONSTRAINT owner_meetings_phase CHECK (phase IN ('opening','round','dissent','decisions','closed')))`,
  `CREATE INDEX IF NOT EXISTS idx_owner_meetings_user ON owner_meetings (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS meeting_attendees (
    id serial PRIMARY KEY, meeting_id integer NOT NULL REFERENCES owner_meetings(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL, employee_role varchar(60) NOT NULL,
    turn_order integer NOT NULL, reason text, recommended_by varchar(10) NOT NULL DEFAULT 'owner', status varchar(12) NOT NULL DEFAULT 'present',
    status_reason text,
    CONSTRAINT uq_meeting_attendees UNIQUE (meeting_id, employee_key),
    CONSTRAINT meeting_attendees_status CHECK (status IN ('present','unavailable')),
    CONSTRAINT meeting_attendees_by CHECK (recommended_by IN ('owner','ceo')))`,
  `CREATE TABLE IF NOT EXISTS meeting_minutes (
    id serial PRIMARY KEY, meeting_id integer NOT NULL REFERENCES owner_meetings(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, seq integer NOT NULL, speaker varchar(12) NOT NULL,
    employee_key varchar(60), kind varchar(16) NOT NULL, text text NOT NULL, lang varchar(8), source varchar(12) NOT NULL,
    verified jsonb, evidence jsonb, flags jsonb, stt_model varchar(60), llm_ms integer, tts_ms integer, tts_voice varchar(60),
    audio bytea, audio_mime varchar(60), created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_meeting_minutes_seq UNIQUE (meeting_id, seq),
    CONSTRAINT meeting_minutes_speaker CHECK (speaker IN ('owner','ceo','employee','system')),
    CONSTRAINT meeting_minutes_kind CHECK (kind IN ('opening','question','answer','dissent','owner','reply','decision','readback','system')),
    CONSTRAINT meeting_minutes_source CHECK (source IN ('voice','text','system','model','template')))`,
  `CREATE TABLE IF NOT EXISTS meeting_action_items (
    id serial PRIMARY KEY, meeting_id integer NOT NULL REFERENCES owner_meetings(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL, employee_key varchar(60) NOT NULL,
    due_at timestamptz NOT NULL, expected_outcome text NOT NULL, metric text, owner_decision boolean NOT NULL DEFAULT false,
    task_id integer, created_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS idx_meeting_action_items_meeting ON meeting_action_items (meeting_id)`,
];

let ready: Promise<boolean> | null = null;

/** مرة في العملية، بعد جداول المنظّمة (التذاكر في employee_tasks). الفشل لا يُحفظ. */
export function ensureVoiceTables(): Promise<boolean> {
  ready ??= (async () => {
    if (!(await ensureOrgTables())) throw new Error("org tables not ready");
    for (const q of VOICE_SQL) await db.execute(sql.raw(q));
    return true;
  })().catch((e) => {
    ready = null;
    logger.warn({ err: String(e?.message ?? e) }, "تعذّر إنشاء جداول غرفة التحكّم");
    return false;
  });
  return ready;
}
