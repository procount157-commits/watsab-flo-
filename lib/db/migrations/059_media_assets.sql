-- ── 059 · معرض الصور ─────────────────────────────────────────────
-- صاحب العمل: «أريد مكاناً أرفع فيه الصور، مثل معرض، والكاتب يكتب الحملات
-- منها». كان كل رفعٍ يُحفظ في التخزين ولا يُسجَّل في أي مكان، فلا يُعاد
-- استعماله. كل صورةٍ هنا بوصفها ووسومها ومصدرها.
CREATE TABLE IF NOT EXISTS media_assets (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url         text NOT NULL,
  mimetype    varchar(80),
  size        integer,
  caption     text,
  tags        jsonb NOT NULL DEFAULT '[]'::jsonb,
  source      varchar(20) NOT NULL DEFAULT 'upload',
  source_url  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_media_assets_user ON media_assets (user_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_user_url ON media_assets (user_id, url);
