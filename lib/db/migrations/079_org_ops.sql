-- ── التشغيل: توجيه المزوّد بالدليل، الأسعار، سجل العمّال ─────────────────────
-- النشر لا يشغّل ملفات SQL: ORG_OPS_SQL في artifacts/api-server/src/lib/org/schema.ts ينفّذ النص
-- نفسه عند الإقلاع، وorg-ops.test.ts يقارن الاثنين.
-- provider_prices تُبذر فارغة عمداً: لا سعر مخترع؛ الكلفة null («غير متاح») ما لم يضع المالك سعراً بمصدره.
-- worker_registry صفٌّ لكل حلقة في كل عملية، يُحدَّث مكانه. عملية API واحدة اليوم: لا قفل موزَّع.
ALTER TABLE provider_metrics ADD COLUMN IF NOT EXISTS task_class varchar(20) NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_metrics_class ON provider_metrics (user_id, provider, model, day, task_type, task_class);
DROP INDEX IF EXISTS uq_provider_metrics_task;
CREATE INDEX IF NOT EXISTS idx_provider_metrics_routing ON provider_metrics (task_class, day);
ALTER TABLE employee_executions ADD COLUMN IF NOT EXISTS provider varchar(40);
CREATE TABLE IF NOT EXISTS provider_prices (
    id serial PRIMARY KEY, provider varchar(40) NOT NULL, model varchar(120) NOT NULL DEFAULT '',
    input_per_million numeric(14,6) NOT NULL, output_per_million numeric(14,6) NOT NULL, currency varchar(3) NOT NULL DEFAULT 'USD',
    source text NOT NULL, updated_by integer, updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_provider_prices UNIQUE (provider, model),
    CONSTRAINT provider_prices_nonneg CHECK (input_per_million >= 0 AND output_per_million >= 0));
CREATE TABLE IF NOT EXISTS worker_registry (
    worker_id varchar(80) NOT NULL, name varchar(80) NOT NULL, interval_ms integer NOT NULL, scope varchar(40) NOT NULL DEFAULT 'all',
    started_at timestamptz NOT NULL DEFAULT now(), first_due_at timestamptz, last_tick_at timestamptz, last_ok_at timestamptz,
    last_error text, last_error_at timestamptz, last_duration_ms integer, ticks bigint NOT NULL DEFAULT 0, errors bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (worker_id, name));
