-- ── أحكام الظل الجديدة: mixed (أصلح فحصاً وخالف آخر) وnot_covered (له نموذج ولم يُجرَّب) ─────
-- النشر لا يشغّل ملفات SQL: ORG_SIM_SQL في artifacts/api-server/src/lib/org/sim-schema.ts
-- ينفّذ النص نفسه عند الإقلاع، وorg-shadow.test.ts يقارن الاثنين. يُعاد تشغيله بأمان.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shadow_runs_verdict' AND pg_get_constraintdef(oid) LIKE '%not_covered%') THEN
      ALTER TABLE shadow_runs DROP CONSTRAINT IF EXISTS shadow_runs_verdict;
      ALTER TABLE shadow_runs ADD CONSTRAINT shadow_runs_verdict CHECK (verdict IN ('failed_checks','better','same','mixed','no_output','no_model_path','not_covered','no_samples','budget'));
    END IF;
  END $$;
