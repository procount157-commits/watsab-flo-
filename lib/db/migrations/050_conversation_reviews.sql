-- ريم reads every conversation and files the customer: what they wanted,
-- how warm they are, which piece, what to do next — from the words, not a
-- guess. One row per number, rewritten on every review.
CREATE TABLE IF NOT EXISTS conversation_reviews (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone        VARCHAR(60) NOT NULL,
  label        VARCHAR(24) NOT NULL,      -- hot | price | photo | order | question | cold | refused | machine | not_customer | silent
  score        INTEGER NOT NULL DEFAULT 0, -- 0..100 how close to buying
  piece        VARCHAR(200),
  summary      TEXT,
  next_action  TEXT,
  dialect      VARCHAR(12),
  msg_count    INTEGER NOT NULL DEFAULT 0,
  last_at      TIMESTAMPTZ,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_conv_reviews_label ON conversation_reviews (user_id, label, score DESC);
