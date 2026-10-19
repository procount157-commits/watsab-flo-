-- ── 058 · محل الذهب: الروابط إلى المتجر الحقيقي، والأسماء بلا أوزان ──
-- مدخلات القطع كُتبت على الماك وروابطها إلى http://localhost:4321، وبعض
-- أسماء القطع تحمل وزنها «… (4.07 جم)» أو «وزن الحبة 5.53 جم». الموظفة
-- تنسخ الاسم، والوزن ممنوع (057)، فتُوقَف رسالتها. يُصلَح هنا، ومرّةً
-- بعد مرّة بلا أثر (كل نشرٍ يعيد الملفات كلها).

WITH shops AS (SELECT user_id FROM business_profile WHERE vertical = 'jewelry')
UPDATE knowledge_base k SET
  content = regexp_replace(regexp_replace(regexp_replace(regexp_replace(k.content,
      'https?://localhost:[0-9]+', 'https://floret-royal.io', 'g'),
      '\s*\(\s*[0-9.٫,]+\s*(جم|جرام|غرام)\s*\)', '', 'g'),
      '\s*[·،,—-]?\s*(السعر للحبة الواحدة|السعر للقطعة الواحدة)\s*[،,]?', '', 'g'),
      '\s*[·،,]?\s*(الوزن|وزن الحبة|وزن القطعة|وزن)\s*[0-9.٫]+\s*(جم|جرام|غرام)', '', 'g'),
  title = regexp_replace(k.title, '\s*\(\s*[0-9.٫,]+\s*(جم|جرام|غرام)\s*\)', '', 'g'),
  updated_at = now()
WHERE k.category = 'catalog' AND k.user_id IN (SELECT user_id FROM shops)
  AND (k.content ~ 'localhost:[0-9]+|[0-9] *(جم|جرام|غرام)|السعر للحبة' OR k.title ~ '[0-9] *(جم|جرام|غرام)');

-- السطر الذي يقول أين السعر والوزن، لمن فاته (كان له رابط قديم فتخطّاه 057).
UPDATE knowledge_base SET content = content || E'\nالسعر والوزن في صفحة القطعة — لا يُذكران في المحادثة؛ من يسأل عنهما يُرسل له الرابط.', updated_at = now()
WHERE category = 'catalog' AND content LIKE '%/product/%' AND content NOT LIKE '%لا يُذكران في المحادثة%'
  AND user_id IN (SELECT user_id FROM business_profile WHERE vertical = 'jewelry');
