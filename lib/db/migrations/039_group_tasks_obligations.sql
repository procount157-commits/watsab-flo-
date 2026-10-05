-- What customers ask for in their groups, as tasks with a due time — so a
-- request does not sit as a line in a chat until the customer asks again.
-- سارة reads them out of the conversation as she learns; the owner can add,
-- close or move them; an overdue one is told to the owner before the
-- customer has to chase it.
CREATE TABLE IF NOT EXISTS wa_group_tasks (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_jid         VARCHAR(80) NOT NULL,
  text              TEXT NOT NULL,
  requested_by      VARCHAR(120),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at            TIMESTAMPTZ,
  -- open | done | cancelled
  status            VARCHAR(12) NOT NULL DEFAULT 'open',
  done_at           TIMESTAMPTZ,
  done_note         TEXT,
  -- learned (read from the chat) | owner
  origin            VARCHAR(10) NOT NULL DEFAULT 'learned',
  reminded_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wa_group_tasks ON wa_group_tasks (user_id, status, due_at);

-- Each client's deadlines, entered by the owner: VAT returns, corporate tax,
-- licence renewals, AML reviews. Nothing here is guessed — a wrong date is a
-- fine for the client — so the system only reminds about dates it was given.
CREATE TABLE IF NOT EXISTS client_obligations (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_jid         VARCHAR(80),
  client_name       VARCHAR(200) NOT NULL,
  -- vat | ct | license | aml | payroll | audit | other
  kind              VARCHAR(12) NOT NULL DEFAULT 'other',
  title             VARCHAR(200) NOT NULL,
  due_date          DATE NOT NULL,
  -- none | monthly | quarterly | yearly
  recurrence        VARCHAR(10) NOT NULL DEFAULT 'none',
  remind_days       INTEGER NOT NULL DEFAULT 7,
  -- what to ask the client for, in the reminder
  documents         TEXT,
  notes             TEXT,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  last_reminded_due DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_client_obligations ON client_obligations (user_id, active, due_date);
