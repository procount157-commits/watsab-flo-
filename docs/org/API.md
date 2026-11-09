# واجهة المنظّمة (P3–P5)

الجذر `/api/org` — كل المسارات `requireAuth`، ومقيَّدة بحساب الجلسة. بلا جلسة: `401`. التواريخ ISO. **كل رقم هنا استعلام على صفوف حقيقية**؛ عيّنة غير كافية = `status: "INSUFFICIENT DATA"` و`score: null` — لا تعرض رقماً مكانها أبداً.

## GET /org/overview

مخزَّن 20 ثانية لكل حساب. `integrations.integration`: `email_smtp, email_imap, whatsapp, instagram, tiktok, linkedin, llm`.

```jsonc
{
  "generatedAt": "ISO",
  "employees": { "total": 0, "healthy": 0, "running": 0, "delayed": 0, "failed": 0, "paused": 0, "no_execution": 0 },
  "tasks": { "active": 0, "overdue": 0 },           // overdue: due_at فات، أو عقد انتهى، أو انتظر فوق حد الحارس
  "departments": [{
    "department": "email", "employees": 0, "healthy": 0, "running": 0, "delayed": 0, "failed": 0, "paused": 0, "no_execution": 0,
    "executions7d": 0, "successRate": 0.97,          // null إن كانت العيّنة < 10
    "tokens7d": 0, "avgScore": 82.5,                 // null إن لا بطاقة OK
    "outcome": { "label": "ردود نافعة", "value": 3 } // null لقسم بلا مقياس نتيجة
  }],
  "queue": { "emailQueued": 0, "emailOldest": "ISO|null", "emailHeldStale": 0, "tasksQueued": 0, "deadLetter": 0 },
  "integrations": [{ "integration": "email", "status": "ok|degraded|down|unknown", "detail": "…", "lastOkAt": null, "lastFailAt": null, "checkedAt": "ISO" }],
  "risks": [{ "kind": "repeated_failures", "subject": "email.guard", "severity": "warn|critical", "detail": "…" }],
  "approvals": { "tasks": 0, "proposals": 0, "lessons": 0 },
  "outcomes": [{ "key": "positive_replies", "label": "…", "current": 0, "previous": 0, "delta": 0 }]  // 7 أيام مقابل السبعة قبلها
}
```

`outcomes` مفاتيحها: `emails_sent`, `positive_replies`, `companies_positive`, `bounced`, `human_opens`, `qualified_leads`, `meetings`, `wa_sends`. `human_opens` يطرح فتحات الآلة (`email_events.type='machine_open'` لا تمس `opened_at` أصلاً).

## GET /org/employees

`{ "employees": [InventoryRow & { "prompt_version": 3|null, "weekly": { "score": 80|null, "status": "OK|INSUFFICIENT DATA" } | null }] }`

`InventoryRow` كما في `/org/inventory`: `key, name, role, account, department, title, prompt_location, scheduler_location, execution_function, execution, integration_status, permission_status, heartbeat_status, carried_by, carried_by_status, interval_sec, last_heartbeat, last_success, last_failure, last_error, consecutive_failures, dependencies`.

## GET /org/employees/:key

`:key` مفتاح ثابت (`email.copywriter`). غير موجود في هذا الحساب: `404`.

```jsonc
{
  "profile": InventoryRow,
  "prompt": {
    "version": 3,                 // bot_employees.prompt_version
    "persona": "…",               // ما يعمل به الآن
    "versions": [{ "version": 1, "note": "…", "active": false, "created_by": "…", "created_at": "ISO", "prompt": "…" }],
    "library": { "version": 2, "externalBehavior": true } // null إن لم تكن للموظف نسخة في المكتبة
  },
  "tools": ["…"],                 // سطور approvedTools من المكتبة، [] إن غاب مدخله
  "permissions": { "status": "allowed|halted: …", "is_active": true, "approvalRequiredFor": ["external strategy", "…"] },
  "heartbeat": { /* صف employee_heartbeats أو null */ },
  "heartbeatHistory": [{ "id": 1, "kind": "…", "status": "succeeded", "started_at": "ISO", "duration_ms": 10, "model_calls": 0, "tokens_in": 0, "tokens_out": 0, "error": null }], // آخر 50 تنفيذاً
  "tasks": [{ "task_id": 1, "status": "queued", "task_type": "…" /* صف employee_tasks خام بأسماء snake_case */ }], // آخر 30
  "errors": [{ "id": 1, "kind": "…", "error": "…", "started_at": "ISO" }], // آخر 20 فاشلاً
  "memory": { "employee": [MemoryItem], "department": [MemoryItem], "account": [MemoryItem] }, // معتمد وسارٍ فقط
  "trends": [Scorecard],          // آخر 12 بطاقة محفوظة
  "feedback": [{ "id": 1, "verdict": "bad", "note": "…", "from_role": "…", "created_at": "ISO" }],
  "proposals": [Proposal]
}
```

`MemoryItem`: `{ id, layer: "employee|department|account", kind, content, sourceReference, confidence, lastVerifiedAt, expiryAt, version }`.

## GET /org/scorecards?period=weekly|monthly&employee=<key>

`period` غير صالح: `400`. الافتراضي `weekly`. يقرأ آخر بطاقة محفوظة لكل موظف في الفترة (يكتبها العامل اليومي)، وإن لم توجد يحسبها حيّة (`live: true`).

```jsonc
{
  "period": "weekly",
  "scorecards": [{
    "employeeKey": "email.copywriter", "role": "email", "model": "copywriter",
    "period": "weekly", "periodKey": "weekly:2026-W46", "periodStart": "ISO", "periodEnd": "ISO",
    "status": "OK",               // أو "INSUFFICIENT DATA"
    "score": 74.5,                // null عند INSUFFICIENT DATA
    "calculation": "نص يشرح الحساب كاملاً",
    "sampleSize": 120, "confidence": "low|medium|high|none",
    "trend": { "direction": "up|down|flat|unknown", "previousScore": 70.1, "delta": 4.4 },
    "evidence": { "email_messages": [1,2], "employee_executions": [3] }, // عيّنة أرقام (حتى 20 لكل جدول)
    "metrics": [{
      "key": "guard_acceptance", "label": "…", "status": "OK|INSUFFICIENT DATA",
      "value": 0.82,              // null عند INSUFFICIENT DATA؛ نسبة 0..1 أو القيمة الخام حسب unit
      "unit": "ratio|ms|count",
      "score": 82,                // 0..100 أو null
      "weight": 20, "sampleSize": 40, "minSample": 10, "calculation": "…", "evidence": { "…": [1] }
    }],
    "note": "موظف جديد: …",        // اختياري
    "live": false
  }]
}
```

## GET /org/ceo/reports?limit=30

`{ "reports": [Report], "employee": { "key": "executive.ceo", "hired": true } }` — حساب الجلسة وحده، الأحدث أولاً. صف واحد لكل يوم بتوقيت دبي (`period: "daily"`)؛ إعادة التشغيل تحدّثه.

```jsonc
// Report
{
  "id": 1, "account_id": 2, "period": "daily", "period_key": "2026-11-09", "created_at": "ISO",
  "narrative_status": "validated|facts_only|model_unavailable",
  "executive_summary": "…|null",  // null إن رُفض النص مرتين أو غاب النموذج: عندها الوقائع وحدها
  "thin_data": true,              // الوقائع قليلة، ويقول التقرير ذلك
  "department_performance": [{ "department": "email", "executions": 0, "failed": 0, "successRate": null, "tokens": 0, "calls": 0, "costUsd": null, "outcome": null, "outcomeLabel": null }],
  "employee_alerts": [{ "employeeKey": "…", "kind": "missed_deadline|failing|no_execution", "detail": "…", "value": 0 }],
  "operational_risks": [{ "kind": "…", "subject": "…", "severity": "…", "detail": "…" }],
  "revenue_opportunities": [{ "kind": "…", "subject": "…", "detail": "…", "ref": 1 }],
  "resource_issues": [{ "department": "…", "tokens": 0, "calls": 0, "costUsd": null, "outcome": 0, "detail": "…" }],
  "top_priorities": [{ "rank": 1, "problem": "…", "why": "…", "id": "failing:email.guard" }],
  "recommended_actions": [{ "title": "…", "why": "…", "taskId": 1, "approvalRequired": false, "category": "internal_analytics", "evidence": { "key": "…", "value": 5, "better": "lower" } }], // evidence قد يكون null
  "actions_requiring_approval": [{ "title": "…", "taskId": 2, "category": "external_strategy" }],
  "previous_improvement_results": [{ "taskId": 1, "title": "…", "metric": "…", "before": 0, "after": 0, "verdict": "improved|worse|flat|INSUFFICIENT DATA" }], // أو changeId بدل taskId لتعليمات فُعّلت
  "answers": {
    "bestDepartment": { "department": "email", "value": 3, "basis": "ردود نافعة" },   // null إن لا نتيجة تجارية
    "wastefulDepartment": { "department": "whatsapp", "tokens": 1000, "calls": 10, "costUsd": null, "outcome": 0 }, // null إن لا أحد (الحد 1000 توكن)
    "missingDeadlines": ["email.guard"],
    "failingWorkflows": [{ "workflow": "…", "failed": 1, "total": 2 }],
    "campaignsWithLeads": [{ "campaignId": 1, "name": "…", "positive": 2 }],
    "channels": [{ "channel": "email|whatsapp|instagram|tiktok|linkedin", "state": "…", "sent": 0, "positive": 0 }], // positive: null لما لا مقياس له (السوشيال)
    "topProblems": ["…"], "doFirst": "…|null",
    "lastWeekImprovements": "improved|worse|mixed|none|INSUFFICIENT DATA"
  }
}
```

## POST /org/ceo/run

يشغّل تقرير اليوم لحساب الجلسة الآن. موقوف بمفتاح: `200 { "ran": false, "reason": "…" }`. **حد:** مرة كل 5 دقائق لكل حساب، وإلا `429 { "error": "…", "retryAfterSec": 120 }`.
نجاح: `200 { "ran": true, "report": Report }`.

## GET /org/readiness?verify=1

الفحص الحي (`verify=1`) يفتح اتصال SMTP وIMAP بلا إرسال؛ **حد:** مرة كل دقيقة لكل حساب، وعند تجاوزه يعود الفحص بلا اتصال (عناصره `NEEDS_TEST`) دون خطأ. بلا `verify`: لا اتصال خارجي، وما يحتاج اتصالاً `NEEDS_TEST`.

```jsonc
{
  "status": "READY|BLOCKED|NEEDS_TEST",   // BLOCKED إن عنصرٌ محظور؛ وإلا NEEDS_TEST إن عنصرٌ لم يُختبر؛ READY فقط إن كلها READY
  "checkedAt": "ISO", "verified": true,
  "items": [{ "id": "email.smtp", "channel": "email|whatsapp|instagram|tiktok|linkedin|org", "title": "…",
              "status": "READY|BLOCKED|NEEDS_TEST", "ok": true, "detail": "…", "action": "ما يفعله المدير|null", "goto": "/email/settings|null" }]
}
```

معرّفات العناصر: `email.smtp`, `email.imap`, `email.mailboxes`, `email.quota`, `email.queue`, `email.lists`, `email.auto_reply`, `whatsapp.connection`, `whatsapp.auto_reply`, `whatsapp.followup_mode`, `org.team_paused`, `org.controls`, `org.sales_support`, `org.llm`, `instagram.account`, `tiktok.account`, `linkedin.readiness`. `linkedin.readiness` لا يصل `READY` أبداً: لا مشغّل.

## GET /org/proposals?status=&target=

`{ "proposals": [Proposal] }`

```jsonc
// Proposal
{
  "change_id": 1, "user_id": 2, "requested_by": "system|employee key", "approved_by": null,
  "target": "prompt:email.copywriter", "reason": "…", "evidence": {}, "old_value": {}, "new_value": {}, "impact": "…",
  "status": "proposed|approved|rejected|applied|rolled_back", "applied_at": null, "rollback_version": null, "created_at": "ISO",
  "category": "prompt_external", "risk": "low|approval_required", "decision_note": null, "rolled_back_at": null,
  "classification": { "risk": "low|approval_required", "category": "prompt_external|prompt_internal|…", "why": "…" }
}
```

## GET /org/proposals/:id

`{ "proposal": Proposal }` — غير موجود في حسابك: `404`.

## POST /org/proposals

Body: `{ "target": "prompt:email.copywriter|memory:…|config:…", "category": "<من القائمة>", "reason": "…", "newValue": {}, "evidence": {}, "impact": "…" }` → `201 { "proposal": Proposal }`. الفئة تُحسب بالكود من القائمة ولا يُقبل خفض تصنيفها: `400` إن كانت ناقصة. `category` إلزامية لغير `prompt:*`، وهدف `prompt:*` يأخذ فئته من المكتبة مهما أُرسل. **لا يطبَّق شيء بالإنشاء**؛ منخفض الخطر غير التعليمات يصير `approved` آلياً بلا أثر. هدف `prompt:` بلا مدخل مكتبة: `400`.

فئات تتطلب موافقة: `external_strategy, pricing, promises, limits, channel_activation, prompt_external, permissions, account_config, financial, deletion, security`. منخفضة الخطر: `prompt_internal, memory, internal_analytics`. ما لا يُعرف يُعامل كمتطلب موافقة.

## POST /org/proposals/:id/approve

`{ "proposal": Proposal, "applied": true|false }` — موافقة صاحب الحساب؛ `prompt:*` يُفعَّل معها فيصير `applied: true` وstatus `applied`؛ وأي هدف آخر يبقى `approved` و`applied: false` ولا يُغيَّر شيء آلياً. `409`: ليس لهذا الحساب أو حالته لا تسمح. `404`: الموظف ليس في الحساب.

## POST /org/proposals/:id/reject

Body: `{ "reason": "…" }` → `{ "proposal": Proposal }`.

## POST /org/proposals/:id/rollback

`{ "proposal": Proposal }` — يعيد النسخة السابقة، ويُكتب في السجل. `409` إن لم يكن `applied`.

## GET /org/providers?days=7

```jsonc
{
  "days": 7,
  "byTask": [{ "task_type": "write_email|role:sales…", "provider": "groq", "model": "…", "calls": 0, "failures": 0, "successRate": 0.9,
               "avgLatencyMs": 0, "tokensIn": 0, "tokensOut": 0, "costUsd": null, "guardPassed": 0, "guardFailed": 0, "guardPassRate": null }],
  "health": [{ "provider": "…", "model": "…", "state": "ok|cooldown", "ok": 0, "fail": 0, "avgMs": 0, "score": 0.7 }], // صحة النماذج عامة بطبيعتها، بلا بيانات حساب
  "notes": ["llm_settings: …"]
}
```

التوكنات تقدير من الأحرف. `successRate` على المحاولات عند هذا المزوّد. `costUsd: null` = غير معروف (لا تسعير لهذا المزوّد)، ليس صفراً. `guardPassRate: null` إن كانت العيّنة < 10.

## المسارات القائمة (لم تتغير)

`/org/controls`, `/org/audit`, `/org/inventory`, `/org/heartbeats`, `/org/tasks` (+ approve/reject/cancel/retry), `/org/watchdog`, `/org/queue-review` (+ apply/release), `/org/workflows`, `/org/lessons/pending` (+ approve/reject).

## مسار المدير

`GET /org/admin/overview` — `isAdmin` وحده، وإلا `403`: أعداد مجمّعة فقط (`accounts, employees, activeTasks, failedTasks, reports7d, proposalsPending`) بلا أسماء ولا محتوى حساب.
