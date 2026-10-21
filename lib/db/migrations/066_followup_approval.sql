-- ── 066 · المتابعة بموافقة صاحب العمل، وأسلوب «الخدمة فقط» ───────
-- صاحب العمل (٢١ أكتوبر)، لحساب Floret: «ما ينفع يقول يا حبيبتي ويا صاحبتي
-- ويا قلبي، ولا يتكلم عن السعر أبداً، ولا يضيف كلام من عنده — بس يسألهم لو
-- يحتاجوا أي شيء وإحنا تحت أمركم. وعايز أراجع وراه أول حاجة. سبع متابعات،
-- أقصى مدة بينهم تلات أيام، وما يرسل أكتر من ٢٠ مرة واحدة، وريم تراجع كل
-- المحادثات». يُعاد تشغيله بأمان.
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS followup_style varchar(10) NOT NULL DEFAULT 'rich';
ALTER TABLE business_profile ADD COLUMN IF NOT EXISTS followup_batch integer NOT NULL DEFAULT 8;

-- Floret (الحساب ٤، الرقم 971509966221): كل ما سبق، والمسودات تنتظر موافقته.
UPDATE business_profile
SET followup_style = 'service', followup_batch = 20, smart_followup = 'approve',
    followup_ladder = '[4, 24, 48, 72, 72, 72, 72]'::jsonb, followup_scope = 'spoke'
WHERE user_id = 4 AND vertical = 'jewelry' AND followup_style = 'rich';

-- مسودات وضع التجربة لم تصل لأحد، فلا تُحسب متابعاتٍ أُخذت: تُعزل باسمها
-- حتى تبدأ كل زبونة من متابعتها الأولى. لا تُحذف — تبقى في السجل.
UPDATE followup_deliberations SET verdict = 'dry'
WHERE user_id = 4 AND step >= 100 AND NOT executed AND verdict IN ('send', 'drop', 'hold');
