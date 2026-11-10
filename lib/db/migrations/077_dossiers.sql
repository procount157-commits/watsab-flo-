-- ملف الموظف (Employee Dossier): ١٩ قسماً لكل نسخة، مصدر الحقيقة لتعليمات الموظف.
-- يُنشأ أيضاً عند الإقلاع من artifacts/api-server/src/lib/org/docs/schema.ts بالنص نفسه.

CREATE TABLE IF NOT EXISTS employee_documentation (
    id serial PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, employee_key varchar(60) NOT NULL,
    version integer NOT NULL, status varchar(12) NOT NULL DEFAULT 'draft', sections jsonb NOT NULL, library_version integer,
    author varchar(60) NOT NULL, change_reason text, proposal_id integer, replaced_version integer,
    created_at timestamptz NOT NULL DEFAULT now(), approved_by integer REFERENCES users(id) ON DELETE SET NULL, approved_at timestamptz, activated_at timestamptz,
    CONSTRAINT employee_documentation_status CHECK (status IN ('draft','proposed','approved','active','superseded')));
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documentation_version ON employee_documentation (user_id, employee_key, version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_documentation_active ON employee_documentation (user_id, employee_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_employee_documentation_user ON employee_documentation (user_id, employee_key, status);
