-- ── ذكاء المنظّمة: البطاقات، المقترحات، التقرير التنفيذي، مقاييس المزوّدين ─────
-- النشر لا يشغّل ملفات SQL: ORG_INTELLIGENCE_SQL في artifacts/api-server/src/lib/org/schema.ts
-- ينفّذ النص نفسه عند الإقلاع، وorg-intelligence.test.ts يقارن الاثنين.
ALTER TABLE improvement_proposals ADD COLUMN IF NOT EXISTS category varchar(30);
ALTER TABLE improvement_proposals ADD COLUMN IF NOT EXISTS risk varchar(20);
ALTER TABLE improvement_proposals ADD COLUMN IF NOT EXISTS decision_note text;
ALTER TABLE improvement_proposals ADD COLUMN IF NOT EXISTS rolled_back_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS uq_improvement_seed ON improvement_proposals (user_id, target, (new_value->>'libraryVersion')) WHERE requested_by = 'system.seed';
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS executive_summary text;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS narrative_status varchar(20);
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS thin_data boolean NOT NULL DEFAULT false;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS department_performance jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS employee_alerts jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS operational_risks jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS revenue_opportunities jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS resource_issues jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS top_priorities jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS recommended_actions jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS actions_requiring_approval jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS previous_improvement_results jsonb;
ALTER TABLE executive_reports ADD COLUMN IF NOT EXISTS answers jsonb;
ALTER TABLE provider_metrics ADD COLUMN IF NOT EXISTS task_type varchar(60) NOT NULL DEFAULT '';
ALTER TABLE provider_metrics ADD COLUMN IF NOT EXISTS latency_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE provider_metrics ADD COLUMN IF NOT EXISTS guard_passed integer NOT NULL DEFAULT 0;
ALTER TABLE provider_metrics ADD COLUMN IF NOT EXISTS guard_failed integer NOT NULL DEFAULT 0;
ALTER TABLE provider_metrics DROP CONSTRAINT IF EXISTS uq_provider_metrics;
-- 079 replaced this index with uq_provider_metrics_class (adds task_class), after which rows that
-- share (…, task_type) are legitimate; the deploy re-runs every file, so build the old one only
-- on a database that hasn't reached 079 yet (10 Nov 2026: the re-run failed the deploy).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_provider_metrics_class') THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_metrics_task ON provider_metrics (user_id, provider, model, day, task_type);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_provider_metrics_day ON provider_metrics (user_id, day);
