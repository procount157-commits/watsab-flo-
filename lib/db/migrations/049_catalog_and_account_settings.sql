-- A second business on the same system: a gold house whose employees sell
-- pieces, not services. What it needs that the accounting firm did not:
--   catalog_items    the pieces, synced from the shop's own database, with
--                    the photo on disk so a reply can send it;
--   pricing          today's rate per gram + making charge + VAT, per account;
--   dialect          the register the employees write in;
--   followup_ladder  the hours between follow-ups, per account (the old
--                    1h · 6h · 1d · 3d · 1w · 2w · 1mo for this one);
--   followup_scope   who is followed: those who spoke, or everyone reached.
CREATE TABLE IF NOT EXISTS catalog_items (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sku         VARCHAR(60) NOT NULL,
  slug        VARCHAR(160),
  name        VARCHAR(200) NOT NULL,
  kind        VARCHAR(40),
  purity      INTEGER,
  weight_g    NUMERIC(8,2),
  price_aed   INTEGER,
  tagline     TEXT,
  highlights  JSONB NOT NULL DEFAULT '[]'::jsonb,
  occasion    JSONB NOT NULL DEFAULT '[]'::jsonb,
  audience    JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_path  TEXT,
  images      JSONB NOT NULL DEFAULT '[]'::jsonb,
  in_stock    BOOLEAN NOT NULL DEFAULT true,
  published   BOOLEAN NOT NULL DEFAULT true,
  doc         JSONB,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_catalog_user ON catalog_items (user_id, published);

ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS dialect         VARCHAR(12);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS vertical        VARCHAR(20);
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS pricing         JSONB;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS followup_ladder JSONB;
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS followup_scope  VARCHAR(8) NOT NULL DEFAULT 'spoke';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS catalog_source  VARCHAR(20);
