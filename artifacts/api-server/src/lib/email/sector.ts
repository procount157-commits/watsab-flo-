// ── Which sector a company is in ─────────────────────────────────
// Lists arrive without an activity column more often than with one — the
// 3,852 brokerages on this account had none — but the company's name almost
// always says it: "… REAL ESTATE L.L.C", "… GENERAL CONTRACTING", «مؤسسة …
// للمقاولات». So the sector is read from the activity when there is one,
// the name when there is not, and the file or list name as a last hint.
//
// Rules, in order, first match wins: the more specific trade comes before
// the general one ("building materials trading" is building materials, not
// general trading; "foodstuff trading" is food). The labels are the ones
// the owner filters by.

import { normalizeArabic } from "../intent";

export const UNCLASSIFIED = "غير مصنف";

const RULES: Array<[string, RegExp]> = [
  ["عقارات",            /(real ?estate|realty|propert(y|ies)|\bestates?\b|brokerage|\bbrokers?\b|holiday homes|vacation homes|homes rental|\bleasing\b|عقار|عقارات|الوساطه العقاريه|وساطه عقاريه|اسكان)/],
  ["مواد بناء",          /(building materials?|construction materials?|cement|\bsteel\b|\btiles?\b|sanitary ware|hardware|مواد بناء|مواد البناء|حديد|اسمنت|سيراميك)/],
  ["مقاولات",           /(contracting|contractors?|construction|\bbuilding\b|civil works|fit ?out|joinery|interiors? (contracting|works)|\bmep\b|electromechanical|مقاولات|مقاول|انشاءات|تشييد|بناء)/],
  ["محاسبة وتدقيق",      /(accounting|accountants?|auditing|auditors?|audit\b|bookkeeping|chartered|\btax (consult|advis)|محاسبه|محاسبين|تدقيق|مدققي حسابات)/],
  ["قانونية",           /(legal|advocates?|law firm|lawyers?|attorneys?|محامون|محاماه|استشارات قانونيه)/],
  ["خدمات الشركات",      /(business (setup|set up|services)|corporate services|company formation|\bpro services\b|typing|documents clearing|تاسيس الشركات|خدمات رجال الاعمال|طباعه وتخليص)/],
  ["مالية وتأمين",       /(insurance|\bfinance\b|financial|investments?|capital|exchange|تامين|تمويل|استثمار|صرافه)/],
  ["ذهب ومجوهرات",       /(gold|jewel(le)?ry|jewell?ers?|diamonds?|precious|ذهب|مجوهرات|الماس)/],
  ["مطاعم ومقاهي",       /(restaurant|cafe|cafeteria|coffee|kitchen|catering|bakery|sweets|grill|shawarma|مطعم|مطاعم|مقهى|كافيه|كافتيريا|مخبز|حلويات)/],
  ["أغذية",             /(food ?stuff|foods?\b|grocery|supermarket|hypermarket|fruits|vegetables|dairy|اغذيه|مواد غذائيه|بقاله|سوبرماركت|خضار)/],
  ["سيارات",            /(auto(mobiles?|motive)?\b|\bcars?\b|motors?|garage|tyres?|spare parts|rent a car|car rental|سيارات|ورشه|قطع غيار|تاجير سيارات)/],
  ["نقل وشحن",          /(shipping|logistics|freight|cargo|transport|courier|delivery|movers|packers|removals|شحن|نقل|لوجستي|توصيل)/],
  ["سياحة وسفر",        /(travel|tourism|tours?\b|hotel|resort|hospitality|سفر|سياحه|فندق)/],
  ["تقنية",             /(technolog|software|\bit\b|information technology|computers?|digital|systems|solutions (fz|llc)|telecom|برمجيات|تقنيه|تكنولوجيا|حاسب)/],
  ["تسويق وإعلان",       /(marketing|advertising|media|events?|printing|publishing|branding|تسويق|اعلان|دعايه|طباعه|فعاليات)/],
  ["طبي وصحي",           /(medical|clinic|hospital|pharmacy|pharma|dental|dentist|doctors?\b|\bdr\b|physio|dermatolog|orthodont|optic|optical|health ?care|polyclinic|diagnostic|طبي|طبيب|دكتور|عياده|مستشفى|صيدليه|اسنان|علاج طبيعي)/],
  ["تجميل وصالونات",     /(salon|beauty|\bspa\b|barber|cosmetic|perfumes?|skin ?care|aesthetic|fat loss|slimming|\bslim\b|\blaser (hair|clinic|center|centre)|nails?\b|lashes|makeup|make up|\bhair\b|صالون|تجميل|حلاقه|عطور|بشره|ليزر|اظافر|مكياج|تنحيف)/],
  ["تعليم وتدريب",       /(training|education|institute|academy|school|nursery|university|college|تدريب|تعليم|معهد|اكاديميه|مدرسه|حضانه)/],
  ["تنظيف",             /(cleaning|pest control|laundry|تنظيف|مكافحه|مغسله)/],
  ["صيانة وخدمات فنية",   /(technical services|maintenance|air ?condition|\bhvac\b|plumbing|electrical|facility management|صيانه|تكييف|خدمات فنيه|كهرباء|سباكه)/],
  ["أمن وحراسة",         /(security (services|guards|systems)|guarding|امن|حراسه)/],
  ["صناعة",             /(manufactur|industr|factory|plastic|packaging|صناع|مصنع)/],
  ["ملابس وأزياء",       /(fashion|garments?|textiles?|tailor|abaya|clothing|shoes|ملابس|ازياء|اقمشه|خياطه|عبايات)/],
  ["إلكترونيات",         /(electronics?|mobile phones?|mobiles\b|الكترونيات|هواتف|جوالات)/],
  ["استشارات",           /(consultan|consulting|management|advisory|استشارات|استشاري)/],
  ["تجارة عامة",         /(general trading|trading|import|export|traders?|تجاره عامه|تجاره|استيراد|تصدير)/],
];

const norm = (s: string) => normalizeArabic(s ?? "").replace(/[_\-./]+/g, " ").replace(/\s+/g, " ").trim();

function match(text: string): string | null {
  const n = norm(text);
  if (!n) return null;
  for (const [label, re] of RULES) if (re.test(n)) return label;
  return null;
}

/**
 * The sector for one contact. `hint` is the file or list it came from —
 * "real-estate-companies-ALL" — used only when the contact's own words say
 * nothing.
 */
export function classifySector(input: { industry?: string | null; company?: string | null; name?: string | null; hint?: string | null }): string | null {
  return match(input.industry ?? "") ?? match(input.company ?? "") ?? match(input.hint ?? "") ?? null;
}

export const SECTORS = RULES.map(([label]) => label);
