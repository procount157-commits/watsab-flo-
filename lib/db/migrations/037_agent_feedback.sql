-- Every draft an employee wrote and what the owner did with it — sent as it
-- was, edited, or thrown away — on every desk. The edited ones are shown to the
-- same employee next time a similar case comes up, and the counts are each
-- employee's accuracy on the team page. Before this only the groups agent
-- kept her original beside the owner's version; everywhere else the edit
-- overwrote the draft and the lesson was lost.
CREATE TABLE IF NOT EXISTS agent_feedback (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        VARCHAR(30) NOT NULL,
  -- email | social | groups | whatsapp
  channel     VARCHAR(12) NOT NULL,
  -- reply | comment | outreach | followup | post | campaign | email_reply …
  kind        VARCHAR(20) NOT NULL,
  ref_id      VARCHAR(60),
  -- what the draft answered: the customer's message, the target, the topic
  context     TEXT,
  original    TEXT NOT NULL,
  final       TEXT,
  -- approved (as written) | edited | rejected
  verdict     VARCHAR(10) NOT NULL,
  score       REAL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_agent_feedback ON agent_feedback (user_id, role, created_at DESC);

-- What each employee costs in model calls, a row per account, employee and day.
CREATE TABLE IF NOT EXISTS llm_usage (
  user_id    INTEGER NOT NULL,
  role       VARCHAR(30) NOT NULL,
  day        DATE NOT NULL,
  calls      INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  chars_in   BIGINT NOT NULL DEFAULT 0,
  chars_out  BIGINT NOT NULL DEFAULT 0,
  ms         BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, role, day)
);
