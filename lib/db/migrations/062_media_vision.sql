-- ── 062 · الصورة كما تُرى، لا كما سُمّي ملفها ────────────────────
-- صاحب العمل: «يكتب للعقارات ويستخدم صور الذهب — أريده أن يطابق النص مع
-- الصورة مع القائمة المختارة بحذر شديد». كان الكاتب يختار بالاسم
-- («ChatGPT Image Oct 15…»). الآن يقرأ Gemini كل صورة ويكتب ما فيها ولأي
-- قطاع وخدمة تصلح.
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS vision text;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS fits jsonb;
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS service varchar(12);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS vision_at timestamptz;
