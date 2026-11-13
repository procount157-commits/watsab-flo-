-- ── مزوّد النموذج لكل حساب: تجاوزٌ اختياري فوق llm_settings المشترك ─────────────
-- llm_settings يبقى كما هو ويُقرأ كما كان (أول صف، للجميع). حسابٌ له صف هنا يقرأ صفّه وحده،
-- وحسابٌ بلا صف يقرأ المشترك. لا نقل ولا نسخ بيانات. يُعاد تشغيله بأمان.
-- LLM_ACCOUNT_SQL في artifacts/api-server/src/lib/org/schema.ts ينفّذ النص نفسه عند الإقلاع،
-- وllm-account.test.ts يقارن الاثنين.
CREATE TABLE IF NOT EXISTS llm_account_settings (
    user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    provider varchar(30) NOT NULL, api_key varchar(400) NOT NULL, model varchar(120),
    updated_at timestamptz NOT NULL DEFAULT now());
