-- ── The graph's ledger, its goals, and its off switch ──────────────
-- Every model call, send and decision an employee makes leaves a receipt.
-- Receipts are appended, never changed: each carries the hash of the one
-- before it (per account), so a rewritten or removed row breaks the chain
-- and the check finds it. Deleting is refused unless a session says it is a
-- deliberate clean-up (the test runner's fixture account).

CREATE TABLE IF NOT EXISTS receipts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  graph        VARCHAR(24),            -- whatsapp | email | social | groups | ops | manager
  node         VARCHAR(40) NOT NULL,   -- the employee's role, or a code node: router, gate, sender
  node_version VARCHAR(24),
  goal_id      INTEGER,
  run_id       VARCHAR(64),            -- one customer message, one mission, one round
  action       VARCHAR(40) NOT NULL,   -- llm.call | send.whatsapp | send.email | decide | veto | clean | handoff …
  status       VARCHAR(12) NOT NULL,   -- ok | failed | blocked | retried | deferred
  subject      VARCHAR(160),           -- the phone, address or campaign it concerned — never exported
  input_ref    VARCHAR(160),
  output_ref   VARCHAR(160),
  evidence     JSONB,
  metric       JSONB,                  -- what it moved: {"goal": "clients", "delta": 1}
  model        VARCHAR(80),
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  duration_ms  INTEGER,
  edge         VARCHAR(60),            -- where the work went next
  why          TEXT,
  inferred     BOOLEAN NOT NULL DEFAULT false,  -- rebuilt from the old logs, not written at the time
  prev_hash    CHAR(64),
  hash         CHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_receipts_user_at ON receipts (user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_node ON receipts (user_id, node, at DESC);
CREATE INDEX IF NOT EXISTS idx_receipts_goal ON receipts (user_id, goal_id) WHERE goal_id IS NOT NULL;

CREATE OR REPLACE FUNCTION receipts_chain() RETURNS trigger AS $$
DECLARE prev CHAR(64);
BEGIN
  PERFORM pg_advisory_xact_lock(911000 + NEW.user_id);
  SELECT hash INTO prev FROM receipts WHERE user_id = NEW.user_id ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := prev;
  NEW.hash := encode(sha256(convert_to(concat_ws('|',
    coalesce(prev, ''), NEW.user_id, extract(epoch FROM NEW.at)::numeric(20,6), NEW.graph, NEW.node, NEW.action, NEW.status,
    NEW.subject, NEW.input_ref, NEW.output_ref, NEW.evidence::text, NEW.metric::text,
    NEW.model, NEW.tokens_in, NEW.tokens_out, NEW.edge, NEW.why), 'UTF8')), 'hex');
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS receipts_chain ON receipts;
CREATE TRIGGER receipts_chain BEFORE INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_chain();

CREATE OR REPLACE FUNCTION receipts_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('receipts.allow_delete', true) = 'on' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'receipts are append-only';
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS receipts_append_only ON receipts;
CREATE TRIGGER receipts_append_only BEFORE UPDATE OR DELETE ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_append_only();

-- Walk an account's chain and return the first row whose hash does not
-- match what it should be — NULL when the ledger is intact.
CREATE OR REPLACE FUNCTION receipts_first_broken(uid INTEGER) RETURNS BIGINT AS $$
DECLARE r RECORD; prev CHAR(64) := NULL; want CHAR(64);
BEGIN
  FOR r IN SELECT * FROM receipts WHERE user_id = uid ORDER BY id LOOP
    want := encode(sha256(convert_to(concat_ws('|',
      coalesce(prev, ''), r.user_id, extract(epoch FROM r.at)::numeric(20,6), r.graph, r.node, r.action, r.status,
      r.subject, r.input_ref, r.output_ref, r.evidence::text, r.metric::text,
      r.model, r.tokens_in, r.tokens_out, r.edge, r.why), 'UTF8')), 'hex');
    IF r.prev_hash IS DISTINCT FROM prev OR r.hash IS DISTINCT FROM want THEN RETURN r.id; END IF;
    prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

-- The goals. The owner's alone: no employee writes here.
CREATE TABLE IF NOT EXISTS goals (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       VARCHAR(200) NOT NULL,
  metric      VARCHAR(40) NOT NULL,     -- a named measurement in lib/graph/goals.ts, not free SQL
  target      INTEGER NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline    TIMESTAMPTZ NOT NULL,
  counter_metrics JSONB NOT NULL DEFAULT '[]'::jsonb,
  anchor      VARCHAR(40),
  parent_id   INTEGER REFERENCES goals(id) ON DELETE SET NULL,
  status      VARCHAR(12) NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goals_user ON goals (user_id, status);

-- The team's off switch: every employee stops, at once. Per employee, bot_employees.is_active.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS team_paused BOOLEAN NOT NULL DEFAULT false;
