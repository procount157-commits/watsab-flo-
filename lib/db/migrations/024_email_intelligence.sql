-- ── 024 · البريد: ماذا وصل حقاً، وهل يمكن تتبّع الفتح أصلاً ────────
-- ١) الوارد كان يُصنَّف بمصنّف الواتساب، فصار الإعلان الذي يُرسَل إلينا
--    «عميلاً حاراً». نحتاج تمييز نوع الرسالة عن نيّتها: رد حقيقي، رد
--    تلقائي، ارتداد، عرضٌ بارد يبيع لنا، نشرة، إزعاج.
-- ٢) solicited: هل أرسلنا لهذا العنوان رسالة فعلاً من قبل. هذه هي
--    الإشارة الحاسمة — contact_id موجود لكل مُرسِل لأن المستورد ينشئه
--    عند الوصول، فلا يميّز شيئاً.
-- ٣) public_url: تتبّع الفتح مات منذ أول إرسال لأن SITE_URL في البيئة
--    فارغة، ولا سبيل لصاحب العمل أن يضبطها من الواجهة. الآن يضبطها هنا.

ALTER TABLE email_inbound
  ADD COLUMN IF NOT EXISTS kind       varchar(20),
  ADD COLUMN IF NOT EXISTS solicited  boolean,
  ADD COLUMN IF NOT EXISTS confidence real,
  ADD COLUMN IF NOT EXISTS reasons    jsonb,
  ADD COLUMN IF NOT EXISTS classifier varchar(20);

COMMENT ON COLUMN email_inbound.kind IS
  'reply | auto_reply | bounce | cold_pitch | newsletter | spam — نوع الرسالة، لا نيّتها';
COMMENT ON COLUMN email_inbound.solicited IS
  'هل أرسلنا لهذا العنوان رسالة قبل وصول رسالته. لا شيء غير هذا يميّز الرد من الإعلان.';

CREATE INDEX IF NOT EXISTS idx_email_inbound_kind ON email_inbound (user_id, kind, received_at DESC);

-- البحث الحاسم: هل أرسلنا لهذا العنوان؟ يُنفَّذ لكل رسالة واردة.
CREATE INDEX IF NOT EXISTS idx_email_messages_to ON email_messages (user_id, lower(to_email), sent_at DESC);

ALTER TABLE email_settings
  ADD COLUMN IF NOT EXISTS public_url varchar(300);

COMMENT ON COLUMN email_settings.public_url IS
  'العنوان العام الذي يصل إليه بريد المستلم: بدونه لا بكسل فتح ولا تتبّع نقر — إطلاقاً.';

-- ٤) هدنةٌ بعد ردٍّ يطلبها.
-- من كتب «سنراجع داخلياً ونعود إليكم» قرارُه يُتّخذ في غرفةٍ لسنا فيها،
-- ومن قال «بعد التدقيق» ذكر موعداً. وكلاهما كان يُستأنَف عليه سلّم
-- المتابعة بعد أيام — فتُلاحَق شركةٌ تدرس عرضنا، وهذا أسرع طريق لخسارة
-- صفقةٍ دافئة. فصار للجهة تاريخٌ لا يُراسَل قبله، وسببٌ مكتوب.
ALTER TABLE email_contacts
  ADD COLUMN IF NOT EXISTS quiet_until  timestamptz,
  ADD COLUMN IF NOT EXISTS quiet_reason varchar(200);

COMMENT ON COLUMN email_contacts.quiet_until IS
  'لا تُراسَل هذه الجهة قبل هذا التاريخ — هدنةٌ طلبها ردُّها نفسه.';

CREATE INDEX IF NOT EXISTS idx_email_contacts_quiet ON email_contacts (user_id, quiet_until)
  WHERE quiet_until IS NOT NULL;
