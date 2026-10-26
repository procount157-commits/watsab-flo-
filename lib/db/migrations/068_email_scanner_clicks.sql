-- ── 068 · ضغطات الفحص الآلي ليست أشخاصاً ──────────────────────────
-- صاحب العمل (٢٦ أكتوبر): «فيه clicks كتيرة بس ما قاعد توصلني». ٢٢٠ من ٣٣٨
-- ضغطة جاءت في دقيقة الإرسال نفسها: خوادم البريد (Defender, Mimecast…) تفتح كل
-- رابط لحظة وصول الرسالة. تُعلَّم «scan» وتُعاد العدّادات من الضغطات الحقيقية
-- وحدها. يُعاد تشغيله بأمان: الحساب من الأحداث نفسها في كل مرة.
UPDATE email_events e SET type = 'scan'
FROM email_messages m
WHERE e.message_id = m.id AND e.type = 'click'
  AND ( (m.sent_at IS NOT NULL AND e.created_at - m.sent_at < interval '90 seconds')
     OR coalesce(e.meta->>'ua', '') = ''
     OR (e.meta->>'ua') ~* '(python|curl|wget|go-http|java/|okhttp|headless|bot|crawler|spider|scan|preview|proofpoint|mimecast|barracuda|safelinks|urldefense|fireeye|symantec|trendmicro|sophos|zscaler)' );

UPDATE email_messages m SET click_count = coalesce(x.n, 0), clicked_at = x.first
FROM (SELECT mm.id, count(e.id) FILTER (WHERE e.type = 'click') AS n, min(e.created_at) FILTER (WHERE e.type = 'click') AS first
      FROM email_messages mm LEFT JOIN email_events e ON e.message_id = mm.id
      WHERE mm.click_count > 0 OR mm.clicked_at IS NOT NULL GROUP BY mm.id) x
WHERE x.id = m.id;

UPDATE email_campaigns c SET click_count = coalesce(x.n, 0)
FROM (SELECT cc.id, count(DISTINCT m.id) FILTER (WHERE m.click_count > 0) AS n FROM email_campaigns cc LEFT JOIN email_messages m ON m.campaign_id = cc.id GROUP BY cc.id) x
WHERE x.id = c.id AND c.click_count IS DISTINCT FROM coalesce(x.n, 0);
