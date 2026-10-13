-- ── 054 · الهدف يُسلَّم لموظف ───────────────────────────────────
-- صاحب العمل: «أريد مديراً أعطيه الهدف وهو يقوم بكل شيء». الهدف كان
-- للحساب كله؛ الآن يُسلَّم لمن يُسأل عنه — مدير البريد أولاً.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS assignee varchar(40);
CREATE INDEX IF NOT EXISTS idx_goals_assignee ON goals (user_id, assignee, status);
