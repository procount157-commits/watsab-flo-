-- ── 053 · البريد: المسار والزاوية على كل مهمة ─────────────────────
-- قرار صاحب العمل: ٨٠٪ من الإرسال لمكافحة غسل الأموال و٢٠٪ لبقية
-- الخدمات. ونسبةٌ لا تُقاس لا تُحترم: المهمة كانت تحمل هدفها نصاً حرّاً
-- لا يُعدّ، فلا يُعرف كم خرج لكل مسار إلا بقراءة الأهداف واحداً واحداً.
--
-- track  — aml | services: المسار الذي تُحسب عليه كل رسالة في المهمة.
-- angle  — الزاوية التي كُتبت بها. محلّل النتائج يقارن زاويةً بزاوية،
--          والمقارنة تحتاج اسماً ثابتاً لا جملةً تتغيّر مع كل صياغة.

ALTER TABLE email_missions
  ADD COLUMN IF NOT EXISTS track varchar(12),
  ADD COLUMN IF NOT EXISTS angle varchar(40);

COMMENT ON COLUMN email_missions.track IS 'aml | services — المسار الذي تُحسب عليه نسبة ٨٠/٢٠';
COMMENT ON COLUMN email_missions.angle IS 'معرّف الزاوية من policy.ts — وحدة المقارنة عند محلّل النتائج';

-- ما سبق يُنسب بما كُتب في هدفه: كل ما ذكر AML أو DPMS أو MLRO مسارُه aml.
UPDATE email_missions
   SET track = CASE WHEN goal ~* '(AML|DPMS|MLRO|غسل الأموال|غسل الاموال)' THEN 'aml' ELSE 'services' END
 WHERE track IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_missions_track ON email_missions (user_id, track, created_at DESC);

-- موجات العقارات السابقة كُتبت كلها بزاوية «الجاهزية للتفتيش» قبل أن
-- تُسمّى الزوايا. تُنسب إليها، وإلا رآها الطيار زاويةً لم تُجرَّب فأعاد
-- النص نفسه الذي رفضه مزوّد البريد كإزعاج — ولم يجد المحلّل ما يحكم عليه.
UPDATE email_missions
   SET angle = 're_aml_readiness'
 WHERE angle IS NULL AND track = 'aml'
   AND (goal LIKE 'حملة AML للعقارات:%' OR goal LIKE 'حملة جاهزية AML للوكالات%');
