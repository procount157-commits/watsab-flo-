-- WhatsApp groups: the customer groups the owner works in. Every message is
-- kept (the groups were dropped at the door before), the files customers send
-- are filed on the machine, and the groups agent suggests replies — it never
-- sends — so the owner can see, before trusting it, whether it answers right.
CREATE TABLE IF NOT EXISTS wa_groups (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  jid             VARCHAR(80) NOT NULL,
  subject         VARCHAR(200),
  description     TEXT,
  participants    INTEGER NOT NULL DEFAULT 0,
  -- learn from it and suggest replies
  watch           BOOLEAN NOT NULL DEFAULT FALSE,
  is_customer     BOOLEAN NOT NULL DEFAULT TRUE,
  customer_name   VARCHAR(200),
  notes           TEXT,
  -- what the agent understood of the group: who, what services, recurring topics, open requests
  profile         TEXT,
  profile_at      TIMESTAMPTZ,
  messages        INTEGER NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, jid)
);

CREATE TABLE IF NOT EXISTS wa_group_messages (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_jid     VARCHAR(80) NOT NULL,
  message_id    VARCHAR(100) NOT NULL,
  sender_jid    VARCHAR(80),
  sender_phone  VARCHAR(30),
  sender_name   VARCHAR(120),
  from_me       BOOLEAN NOT NULL DEFAULT FALSE,
  text          TEXT,
  -- text | image | document | voice | video | sticker | other
  msg_type      VARCHAR(20) NOT NULL DEFAULT 'text',
  file_name     VARCHAR(255),
  file_path     TEXT,
  quoted_id     VARCHAR(100),
  created_at    TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_wa_group_messages_group ON wa_group_messages (user_id, group_jid, created_at DESC);

CREATE TABLE IF NOT EXISTS wa_group_suggestions (
  id                 SERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_jid          VARCHAR(80) NOT NULL,
  trigger_message_id VARCHAR(100),
  trigger_text       TEXT,
  suggestion         TEXT NOT NULL,
  reason             TEXT,
  -- pending | correct | edited | wrong | answered (the owner replied himself) | expired
  status             VARCHAR(20) NOT NULL DEFAULT 'pending',
  owner_reply        TEXT,
  match_score        REAL,
  feedback           TEXT,
  provider           VARCHAR(60),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wa_group_suggestions ON wa_group_suggestions (user_id, group_jid, created_at DESC);
