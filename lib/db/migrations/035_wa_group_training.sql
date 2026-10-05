-- What the groups agent knows beyond the transcript: what the owner taught her
-- (instructions, question → answer examples, pasted text, uploaded files) and
-- what she learned herself from reading the groups, message after message.
-- One table so the owner sees, switches off and deletes both in one place.
CREATE TABLE IF NOT EXISTS wa_group_knowledge (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- null: every group; a jid: that group only
  group_jid   VARCHAR(80),
  -- instruction | qa | text | document  (taught)   ·   lesson (learned)
  kind        VARCHAR(20) NOT NULL,
  -- owner | learned
  source      VARCHAR(10) NOT NULL DEFAULT 'owner',
  title       VARCHAR(200),
  content     TEXT,
  question    TEXT,
  answer      TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  -- how many suggestions it was put in front of her for
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_group_knowledge ON wa_group_knowledge (user_id, active, kind);

-- Where her reading of each group has reached: messages after this are new to her.
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS learned_upto TIMESTAMPTZ;
ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS learned_at   TIMESTAMPTZ;
