-- ── 057 · محل الذهب: لا سعر ولا وزن في ما يقرؤه الموظف ─────────────
-- قرار صاحب العمل (2026-10-19): في محلات الذهب لا يُذكر سعرٌ ولا وزنٌ ولا
-- سعر الذهب اليوم في المحادثة؛ من يسأل عنها يُرسل له رابط القطعة من المتجر.
-- كانت مدخلات المعرفة لكل قطعة تحمل وزنها وسعرها، والموظف يقرؤها كحقائق.
-- تُنظَّف هنا، ويُضاف رابط القطعة، ويُطفأ مدخل «سعر الذهب اليوم».

WITH shops AS (SELECT user_id FROM business_profile WHERE vertical = 'jewelry')
UPDATE knowledge_base k
   SET content = trim(both from regexp_replace(regexp_replace(regexp_replace(regexp_replace(k.content,
         '\s*·?\s*السعر [0-9,٬.]+ درهم شامل الضريبة', '', 'g'),
         '\s*·?\s*السعر يُحدد عند السؤال', '', 'g'),
         '\s*[·،,]?\s*(الوزن|وزن)\s*[0-9.٫]+\s*(جم|جرام|غرام)', '', 'g'),
         '(رمز القطعة: [A-Z0-9-]+)(\s|$)', '\1\2', 'g')),
       updated_at = now()
 WHERE k.category = 'catalog' AND k.user_id IN (SELECT user_id FROM shops);

-- رابط القطعة على سطر رمزها، لمن لم يكن له رابط.
UPDATE knowledge_base k
   SET content = replace(k.content, 'رمز القطعة: ' || c.sku,
         'رمز القطعة: ' || c.sku || ' · الصفحة: https://floret-royal.io/product/' || c.slug)
       || E'\nالسعر والوزن في صفحة القطعة — لا يُذكران في المحادثة؛ من يسأل عنهما يُرسل له الرابط.'
  FROM catalog_items c
 WHERE k.category = 'catalog' AND c.user_id = k.user_id AND c.slug IS NOT NULL
   AND k.content LIKE '%رمز القطعة: ' || c.sku || '%'
   AND k.content NOT LIKE '%/product/%'
   AND k.user_id IN (SELECT user_id FROM business_profile WHERE vertical = 'jewelry');

UPDATE knowledge_base SET is_active = false, updated_at = now()
 WHERE title = 'سعر الذهب اليوم' AND user_id IN (SELECT user_id FROM business_profile WHERE vertical = 'jewelry');
