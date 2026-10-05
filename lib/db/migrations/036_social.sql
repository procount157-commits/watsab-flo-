-- One social desk for every platform the owner works: Instagram, TikTok,
-- LinkedIn. The same employees' jobs on each — watch comments and answer them,
-- answer the inbox, reach the people the owner chose, follow up once, post —
-- with the platform as a column rather than a copy of every table per site.
--
-- Outreach is new. The Instagram desk answered only people who came to it;
-- the owner now wants the team to write first to an audience they choose
-- (real-estate brokerages, say). It writes only to people on a list the owner
-- approved, sends one first message and at most one follow-up, stops at the
-- first reply or refusal, and every message waits for approval by default.

CREATE TABLE IF NOT EXISTS social_accounts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      VARCHAR(12) NOT NULL,           -- instagram | tiktok | linkedin
  profile       VARCHAR(40) NOT NULL,           -- the browser profile holding the cookies
  username      VARCHAR(120),
  display_name  VARCHAR(160),
  state         VARCHAR(20) NOT NULL DEFAULT 'unknown',  -- unknown | logged_out | logged_in | checkpoint | restricted
  state_note    TEXT,
  last_check_at TIMESTAMPTZ,
  dry_run       BOOLEAN NOT NULL DEFAULT TRUE,  -- nothing leaves while true
  mode          VARCHAR(10) NOT NULL DEFAULT 'approve',  -- approve | auto
  autopilot     BOOLEAN NOT NULL DEFAULT FALSE,
  caps          JSONB NOT NULL DEFAULT '{}'::jsonb,      -- daily caps per action kind, over the platform defaults
  list_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,      -- target lists the team reaches out to
  last_run_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform)
);

CREATE TABLE IF NOT EXISTS social_posts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform      VARCHAR(12) NOT NULL,
  external_id   VARCHAR(200) NOT NULL,
  url           TEXT NOT NULL,
  caption       TEXT,
  watching      BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at  TIMESTAMPTZ,
  comment_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS social_comments (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     VARCHAR(12) NOT NULL,
  post_id      INTEGER REFERENCES social_posts(id) ON DELETE CASCADE,
  external_id  VARCHAR(300) NOT NULL,
  author       VARCHAR(160) NOT NULL,
  author_url   TEXT,
  text         TEXT NOT NULL,
  intent       VARCHAR(20),
  is_lead      BOOLEAN NOT NULL DEFAULT FALSE,
  draft        TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'new',  -- new | drafted | approved | replied | skipped | failed
  skip_reason  TEXT,
  replied_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_social_comments ON social_comments (user_id, platform, status);

CREATE TABLE IF NOT EXISTS social_lists (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    VARCHAR(12) NOT NULL,
  name        VARCHAR(160) NOT NULL,
  sector      VARCHAR(40),
  query       TEXT,
  folder_id   INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_targets (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     VARCHAR(12) NOT NULL,
  list_id      INTEGER REFERENCES social_lists(id) ON DELETE SET NULL,
  handle       VARCHAR(200) NOT NULL,
  name         VARCHAR(200),
  headline     TEXT,
  company      VARCHAR(200),
  sector       VARCHAR(40),
  city         VARCHAR(80),
  profile_url  TEXT,
  source       VARCHAR(20) NOT NULL DEFAULT 'manual',  -- search | import | manual | comment
  -- new | drafted | approved | invited | sent | replied | declined | unreachable | skipped | failed
  status       VARCHAR(20) NOT NULL DEFAULT 'new',
  draft        TEXT,
  note         TEXT,
  invited_at   TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  replied_at   TIMESTAMPTZ,
  followups    INTEGER NOT NULL DEFAULT 0,
  next_at      TIMESTAMPTZ,
  thread_id    INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, handle)
);
CREATE INDEX IF NOT EXISTS idx_social_targets ON social_targets (user_id, platform, status);
CREATE INDEX IF NOT EXISTS idx_social_targets_list ON social_targets (list_id);

CREATE TABLE IF NOT EXISTS social_threads (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        VARCHAR(12) NOT NULL,
  handle          VARCHAR(200) NOT NULL,
  display_name    VARCHAR(200),
  thread_url      TEXT,
  origin          VARCHAR(20) NOT NULL DEFAULT 'inbound',  -- inbound | outreach | comment
  target_id       INTEGER,
  last_message_at TIMESTAMPTZ,
  last_from_them  BOOLEAN NOT NULL DEFAULT FALSE,
  unread          BOOLEAN NOT NULL DEFAULT FALSE,
  intent          VARCHAR(20),
  temperature     VARCHAR(10),
  status          VARCHAR(20) NOT NULL DEFAULT 'open',     -- open | qualified | closed | stopped
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, platform, handle)
);

CREATE TABLE IF NOT EXISTS social_messages (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    VARCHAR(12) NOT NULL,
  thread_id   INTEGER NOT NULL REFERENCES social_threads(id) ON DELETE CASCADE,
  from_me     BOOLEAN NOT NULL DEFAULT FALSE,
  text        TEXT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'received',  -- received | drafted | approved | sent | failed | skipped
  kind        VARCHAR(20),                               -- reply | outreach | followup
  role        VARCHAR(30),
  hash        VARCHAR(64),
  error       TEXT,
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_messages ON social_messages (thread_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_messages_hash ON social_messages (thread_id, hash) WHERE hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS social_content (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform     VARCHAR(12) NOT NULL,
  kind         VARCHAR(10) NOT NULL DEFAULT 'post',     -- post | engage
  topic        TEXT,
  target_url   TEXT,
  target_text  TEXT,
  text         TEXT NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'draft',    -- draft | approved | published | failed | skipped
  role         VARCHAR(30),
  error        TEXT,
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  url          TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS social_actions (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    VARCHAR(12) NOT NULL,
  role        VARCHAR(30) NOT NULL,
  action      VARCHAR(30) NOT NULL,
  target      VARCHAR(200),
  ok          BOOLEAN NOT NULL DEFAULT TRUE,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_actions ON social_actions (user_id, platform, created_at DESC);

CREATE TABLE IF NOT EXISTS social_activity (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    VARCHAR(12) NOT NULL,
  role        VARCHAR(30) NOT NULL,
  action      VARCHAR(30) NOT NULL,
  text        TEXT NOT NULL,
  ref         JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_activity ON social_activity (user_id, platform, created_at DESC);

-- Instagram moves in: one account that was never signed in, and the record of
-- its sign-in checks. The old instagram_* tables stay where they are, unused.
INSERT INTO social_accounts (user_id, platform, profile, username, display_name, state, state_note, last_check_at, dry_run, caps, created_at)
SELECT user_id, 'instagram', role, username, display_name, state, state_note, last_check_at, dry_run,
       jsonb_build_object('reply', daily_comment_cap, 'dm', daily_dm_cap), created_at
FROM instagram_accounts
ON CONFLICT (user_id, platform) DO NOTHING;
INSERT INTO social_actions (user_id, platform, role, action, target, ok, detail, created_at)
SELECT a.user_id, 'instagram', a.role, a.action, a.target, a.ok, a.detail, a.created_at FROM instagram_actions a
WHERE NOT EXISTS (SELECT 1 FROM social_actions s WHERE s.platform = 'instagram' AND s.user_id = a.user_id AND s.created_at = a.created_at);
