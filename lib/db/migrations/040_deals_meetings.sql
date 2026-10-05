-- From a hot conversation to a paying client. Until now every channel ended
-- at "hot": a Telegram message and a tag. A deal carries it on — meeting,
-- proposal, negotiation, won or lost — whichever channel it came from, and
-- one company is one deal however many channels it used.
CREATE TABLE IF NOT EXISTS deals (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         VARCHAR(200) NOT NULL,
  company       VARCHAR(200),
  contact_name  VARCHAR(160),
  -- whatsapp | email | instagram | tiktok | linkedin | groups | manual
  channel       VARCHAR(12) NOT NULL DEFAULT 'manual',
  -- the phone, the address or the handle on that channel
  ref           VARCHAR(200),
  email         VARCHAR(254),
  phone         VARCHAR(30),
  -- lead | meeting | proposal | negotiation | won | lost
  stage         VARCHAR(12) NOT NULL DEFAULT 'lead',
  service       VARCHAR(160),
  value_aed     NUMERIC(12,2),
  notes         TEXT,
  next_step     VARCHAR(300),
  next_at       TIMESTAMPTZ,
  lost_reason   VARCHAR(300),
  won_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_deals_ref ON deals (user_id, channel, ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (user_id, stage);

-- Proposals the proposal writer drafts and the owner approves before sending.
-- A price that is not in the firm's knowledge is left as a blank the owner
-- must fill — a proposal with a blank cannot be sent.
CREATE TABLE IF NOT EXISTS proposals (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id           INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  title             VARCHAR(200) NOT NULL,
  html              TEXT NOT NULL,
  original_html     TEXT,
  -- draft | approved | sent | accepted | declined
  status            VARCHAR(12) NOT NULL DEFAULT 'draft',
  sent_to           VARCHAR(254),
  sent_at           TIMESTAMPTZ,
  followups         INTEGER NOT NULL DEFAULT 0,
  next_followup_at  TIMESTAMPTZ,
  followup_draft    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_deal_proposals ON proposals (user_id, status);

-- When the owner takes calls, and the link customers book them through.
CREATE TABLE IF NOT EXISTS meeting_settings (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- [{ "dow": 1-7 (Mon=1), "from": "10:00", "to": "13:00" }] in Gulf time
  slots          JSONB NOT NULL DEFAULT '[{"dow":1,"from":"10:00","to":"13:00"},{"dow":2,"from":"10:00","to":"13:00"},{"dow":3,"from":"10:00","to":"13:00"},{"dow":4,"from":"10:00","to":"13:00"}]'::jsonb,
  duration_min   INTEGER NOT NULL DEFAULT 30,
  buffer_min     INTEGER NOT NULL DEFAULT 15,
  notice_hours   INTEGER NOT NULL DEFAULT 3,
  reminder_min   INTEGER NOT NULL DEFAULT 30,
  booking_token  VARCHAR(48) NOT NULL,
  -- the agents offer these times when someone asks for a call
  offer_in_replies BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS client_meetings (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deal_id       INTEGER REFERENCES deals(id) ON DELETE SET NULL,
  name          VARCHAR(160) NOT NULL,
  company       VARCHAR(200),
  email         VARCHAR(254),
  phone         VARCHAR(30),
  starts_at     TIMESTAMPTZ NOT NULL,
  duration_min  INTEGER NOT NULL DEFAULT 30,
  -- booked | done | cancelled | no_show
  status        VARCHAR(12) NOT NULL DEFAULT 'booked',
  -- link | manual
  source        VARCHAR(10) NOT NULL DEFAULT 'manual',
  topic         TEXT,
  notes         TEXT,
  reminded_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_meetings ON client_meetings (user_id, starts_at);
