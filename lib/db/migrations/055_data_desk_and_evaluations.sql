-- ── 055 · مكتب البيانات، وتقييم الموظفين ──────────────────────────
-- شكوى صاحب العمل الأولى: «أكثر مشكلة تواجهني تصنيف الداتا في البريد
-- والواتساب — أنا أرفع فقط، وأريد واحداً يصنّف وواحداً ينظّف».
--
-- وأرقام الواتساب لم يكن لها قطاعٌ أصلاً: الجهة اسمٌ ورقم داخل قائمة،
-- والقائمة هي التصنيف كله. ففندقٌ دخل ملف العقارات صار «عقارات»، ومحل
-- وردٍ في ملف المقاولات صار «مقاولات»، ولا شيء يقول غير ذلك.
--
-- sector_by يقول **بماذا** عُرف القطاع — وهو ما كان غائباً في البريد
-- أيضاً: «own» من كلام الجهة نفسها (اسمها أو نشاطها)، «model» قرأه
-- المصنّف من اسمها، «hint» ورثته من اسم الملف لأن اسمها لا يقول شيئاً.
-- والأخير أضعفها، وكان يُعرض كأنه يقين.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS sector        varchar(40),
  ADD COLUMN IF NOT EXISTS sector_by     varchar(8),
  ADD COLUMN IF NOT EXISTS classified_at timestamptz;

ALTER TABLE email_contacts
  ADD COLUMN IF NOT EXISTS sector_by     varchar(8);

CREATE INDEX IF NOT EXISTS idx_contacts_sector ON contacts (group_id, sector);

-- كل جولةٍ للمكتب على قائمة: ما صُنّف وبماذا، وما نُظّف ولماذا.
CREATE TABLE IF NOT EXISTS data_desk_runs (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     varchar(10) NOT NULL,          -- whatsapp | email
  list_id     integer,
  list_name   varchar(200),
  trigger     varchar(12) NOT NULL DEFAULT 'upload',   -- upload | manager | owner
  report      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_desk_runs ON data_desk_runs (user_id, created_at DESC);

-- تقييم المدير لكل موظف: درجةٌ من أرقامه، وما يُصلحه، والمهمة التي أُعطيها.
-- prev_score يحفظ درجة الدورة السابقة: «يراجع وراهم» معناها أن يُرى هل
-- تحرّك الرقم بعد المهمة، لا أن تُكتب مهمةٌ جديدة كل مرة.
CREATE TABLE IF NOT EXISTS employee_evaluations (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        varchar(40) NOT NULL,
  desk        varchar(20) NOT NULL,
  manager     varchar(40) NOT NULL,
  score       integer,                       -- NULL: لا عمل يُقاس في الفترة
  prev_score  integer,
  grade       varchar(12) NOT NULL,          -- strong | ok | weak | idle | off
  facts       jsonb NOT NULL,
  finding     text,
  task        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_employee_evaluations ON employee_evaluations (user_id, role, created_at DESC);
