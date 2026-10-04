-- Instagram: the account, what it watches, and everything it does.
--
-- The owner's own business account, answering the people who comment on its
-- posts and who write to it — which is what Sprout Social and ManyChat do, and
-- is customer service rather than outreach. Nothing here writes to a stranger
-- who has not approached this account first.
--
-- Two things shape the schema. Every action is recorded before it is taken,
-- because Instagram restricts accounts that behave mechanically and the only
-- defence is knowing exactly what was done and how fast. And a reply is
-- drafted, held, and sent as a separate step, so the owner can watch the team
-- work for a week before letting it speak.
--
-- Apply with:  psql "$DATABASE_URL" -f lib/db/migrations/023_instagram.sql
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS instagram_accounts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The browser profile that holds this account's cookies, named for the
  -- employee that drives it.
  role          VARCHAR(30) NOT NULL,
  username      VARCHAR(80),
  display_name  VARCHAR(120),
  -- unknown | logged_out | logged_in | checkpoint | restricted
  state         VARCHAR(20) NOT NULL DEFAULT 'unknown',
  state_note    TEXT,
  last_check_at TIMESTAMPTZ,
  -- Nothing is sent while this is true; it is how the team ships.
  dry_run       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Conservative by default. Instagram's own limits are undocumented and
  -- enforced by restriction rather than by an error message.
  daily_comment_cap INTEGER NOT NULL DEFAULT 40,
  daily_dm_cap      INTEGER NOT NULL DEFAULT 20,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, role)
);

-- A post whose comments are watched.
CREATE TABLE IF NOT EXISTS instagram_posts (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shortcode   VARCHAR(40) NOT NULL,
  url         TEXT NOT NULL,
  caption     TEXT,
  watching    BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, shortcode)
);

CREATE TABLE IF NOT EXISTS instagram_comments (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id     INTEGER REFERENCES instagram_posts(id) ON DELETE CASCADE,
  -- Instagram's own id when it can be read; otherwise a hash of author+text,
  -- which is enough to not answer the same comment twice.
  external_id VARCHAR(120) NOT NULL,
  author      VARCHAR(80) NOT NULL,
  text        TEXT NOT NULL,
  posted_at   TIMESTAMPTZ,
  -- question | interested | praise | complaint | spam | other
  intent      VARCHAR(20),
  -- Set when it is worth moving to DM.
  is_lead     BOOLEAN NOT NULL DEFAULT FALSE,
  -- The drafted reply, before anyone decides to send it.
  draft       TEXT,
  -- new | drafted | approved | replied | skipped
  status      VARCHAR(20) NOT NULL DEFAULT 'new',
  skip_reason TEXT,
  replied_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_ig_comments ON instagram_comments (user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS instagram_threads (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username      VARCHAR(80) NOT NULL,
  display_name  VARCHAR(120),
  -- Why this conversation exists: they wrote first, or they commented and were
  -- invited. Never "we found them".
  origin        VARCHAR(20) NOT NULL DEFAULT 'inbound',
  last_message_at TIMESTAMPTZ,
  last_from_them  BOOLEAN NOT NULL DEFAULT TRUE,
  intent        VARCHAR(20),
  -- open | qualified | closed | stopped
  status        VARCHAR(20) NOT NULL DEFAULT 'open',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, username)
);

CREATE TABLE IF NOT EXISTS instagram_messages (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id   INTEGER NOT NULL REFERENCES instagram_threads(id) ON DELETE CASCADE,
  from_me     BOOLEAN NOT NULL,
  text        TEXT NOT NULL,
  -- drafted | approved | sent | failed | skipped
  status      VARCHAR(20) NOT NULL DEFAULT 'sent',
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ig_messages ON instagram_messages (thread_id, created_at);

-- Every action, before it happens. This is the rate limiter's memory and the
-- only record of what the account actually did.
CREATE TABLE IF NOT EXISTS instagram_actions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(30) NOT NULL,
  -- read_comments | reply_comment | read_dms | send_dm | open | login_check
  action      VARCHAR(30) NOT NULL,
  target      VARCHAR(120),
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ig_actions ON instagram_actions (user_id, action, created_at DESC);
