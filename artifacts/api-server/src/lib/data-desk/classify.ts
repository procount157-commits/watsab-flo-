// ── المصنِّف: كل جهةٍ في قطاعها، ومعه بماذا عُرف ─────────────────
// صاحب العمل يرفع ملفاً ولا يريد أن يفعل غير ذلك: «واحد يصنّفها، وواحد
// ينظّفها، والباقي يُنفَّذ».
//
// والتصنيف كان موجوداً وكان يخطئ بصمتٍ في موضعٍ واحد: حين لا يقول اسم
// الجهة شيئاً، ترث قطاعها من **اسم الملف**. ففندقٌ في ملف العقارات صار
// عقارات، ومحل وردٍ في ملف المقاولات صار مقاولات، وعُرض ذلك كله كأنه
// يقين. فالمصنّف هنا يقول مع كل قطاعٍ من أين جاء:
//
//   own    من كلام الجهة نفسها — نشاطها المكتوب أو اسمها. يُعتمد.
//   model  اسمها لا يطابق قاعدة، فقرأه المصنّف وحكم من قائمةٍ مغلقة.
//   hint   لا اسمها ولا المصنّف قالا شيئاً، فورثته من الملف. أضعفها،
//          ويُعرض كذلك.
//
// ثم يقول أين تذهب: مسار AML، أم المحاسبة والضرائب، أم ثانوية تُحفظ ولا
// تُراسَل آلياً، أم مجهولة. وهذا كله دوالّ صِرفة: لا قاعدة ولا نموذج.

import { classifySector, SECTORS } from "../email/sector";
import { TARGETS, tracksFor, type Track } from "../email/policy";

export type SectorBy = "own" | "model" | "hint";
/** أين تذهب الجهة بعد تصنيفها. */
export type Bucket = "aml" | "services" | "both" | "secondary" | "competitor" | "unknown";

export const BUCKET_AR: Record<Bucket, { label: string; means: string }> = {
  aml:        { label: "مكافحة غسل الأموال", means: "عقارات ووساطة عقارية، محامون، ذهب ومجوهرات — المسار الأول، ٨٠٪ من الإرسال" },
  both:       { label: "AML + محاسبة", means: "العقارات: تدخل المسارين، والنسبة تحسم أيّهما في كل موجة" },
  services:   { label: "المحاسبة والضرائب", means: "مقاولات ومطاعم — الهدف الأساسي للمحاسبة المتقدمة وضريبة القيمة المضافة والضرائب" },
  secondary:  { label: "ثانوية — محفوظة", means: "قطاعٌ معروف خارج الأهداف الأساسية. تُحفظ مصنّفةً ولا تُراسَل آلياً حتى يرفعها صاحب العمل إلى الأهداف" },
  competitor: { label: "محاسبون ومدققون", means: "مكاتب محاسبة وتدقيق — منافسون لا عملاء. لا تُراسَل" },
  unknown:    { label: "لم تُعرف", means: "لا اسمها ولا ملفها قال ما نشاطها — تنتظر مراجعة" },
};

/** منافسون: يُصنَّفون ولا يُراسَلون أبداً. */
const COMPETITORS = ["محاسبة وتدقيق"];

export function bucketOf(sector: string | null | undefined): Bucket {
  if (!sector) return "unknown";
  if (COMPETITORS.includes(sector)) return "competitor";
  const t = tracksFor(sector);
  if (t.length === 2) return "both";
  if (t[0] === "aml") return "aml";
  if (t[0] === "services") return "services";
  return "secondary";
}

/** هل تدخل هذه الجهة موجةً آلية — في أي مسار. */
export const sendable = (b: Bucket) => b === "aml" || b === "services" || b === "both";

export interface Classified {
  sector: string | null;
  by: SectorBy | null;
  bucket: Bucket;
  /** ما يسند الحكم — يُعرض لصاحب العمل. */
  why: string;
}

/**
 * التصنيف بالقواعد وحدها. الترتيب هو الحكم: كلام الجهة عن نفسها يسبق
 * كل شيء، واسم الملف آخر ما يُسأل ويُعلَّم بضعفه.
 */
export function classifyRow(input: { company?: string | null; name?: string | null; industry?: string | null; hint?: string | null }): Classified {
  const fromIndustry = input.industry ? classifySector({ industry: input.industry }) : null;
  if (fromIndustry) return { sector: fromIndustry, by: "own", bucket: bucketOf(fromIndustry), why: `نشاطها المكتوب: «${String(input.industry).slice(0, 50)}»` };
  const text = [input.company, input.name].filter(Boolean).join(" ").trim();
  const fromName = text ? classifySector({ company: text }) : null;
  if (fromName) return { sector: fromName, by: "own", bucket: bucketOf(fromName), why: `اسمها: «${text.slice(0, 50)}»` };
  // اسم الملف آخر ما يُسأل — ولا يُسأل أصلاً إن كان ينفي: قائمةٌ اسمها
  // «الإمارات-ليست-مقاولات» ورّثت تسعاً وستين جهة قطاع «مقاولات» لأن
  // الكلمة في اسمها. النفي في الاسم يُبطل الوراثة كلها.
  const negated = !!input.hint && /(ليست|ليس|غير|بدون|ما عدا|\bnot\b|\bnon\b|\bno\b|\bother\b|\bmisc)/i.test(input.hint);
  const fromHint = input.hint && !negated ? classifySector({ hint: input.hint }) : null;
  if (fromHint) return { sector: fromHint, by: "hint", bucket: bucketOf(fromHint), why: `اسمها لا يقول شيئاً — ورثته من الملف «${String(input.hint).slice(0, 40)}»` };
  return { sector: null, by: null, bucket: "unknown", why: text ? `«${text.slice(0, 50)}» لا يطابق قطاعاً معروفاً` : "بلا اسم" };
}

// ── المصنّف يقرأ ما عجزت عنه القواعد ──────────────────────────────
/** ما يُعطى للنموذج: قائمةٌ مغلقة، ولا يخرج عنها. */
export function modelPrompt(names: string[]): { system: string; user: string } {
  return {
    system: [
      "أنت مصنّف بيانات شركات في الإمارات والخليج. تُعطى أسماء شركات، وتضع كل اسمٍ في قطاعٍ واحد من القائمة المغلقة — أو «؟» إن لم يدلّ الاسم على نشاط.",
      "",
      `القطاعات المسموحة (حرفياً، لا غيرها): ${SECTORS.join(" | ")}`,
      "",
      "قواعد:",
      "١. احكم من الاسم وحده. اسمٌ لا يدلّ على نشاط («Al Noor LLC»، «Sara»، «Golden Star») جوابه «؟» — التخمين ممنوع، و«؟» جوابٌ صحيح.",
      "٢. اسم شخصٍ لا شركة جوابه «؟».",
      "٣. «Properties / Real Estate / Brokers / Realty / عقارات / وساطة عقارية» ← عقارات. «Holiday Homes / Hotel / Tourism» ← سياحة وسفر، لا عقارات.",
      "٤. «Advocates / Legal / Law Firm / محاماة» ← قانونية. «Gold / Jewellery / Diamonds / ذهب / مجوهرات» ← ذهب ومجوهرات.",
      "٥. «Contracting / Construction / Building / Fit Out / مقاولات» ← مقاولات. «Building Materials» ← مواد بناء.",
      "٦. «Restaurant / Cafe / Kitchen / Catering / مطعم» ← مطاعم ومقاهي.",
      "",
      "أجب بسطرٍ لكل اسم بهذا الشكل بالضبط، وبالترتيب نفسه، ولا شيء غيره:",
      "<الرقم>|<القطاع أو ؟>",
    ].join("\n"),
    user: names.map((n, i) => `${i + 1}|${n.slice(0, 90)}`).join("\n"),
  };
}

/** قراءة الجواب بصرامة: قطاعٌ خارج القائمة يُسقَط، ولا يُقبل ما لا رقم له. */
export function parseModel(text: string, n: number): Array<string | null> {
  const out: Array<string | null> = Array.from({ length: n }, () => null);
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s*[|｜:：\-–]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= n) continue;
    const label = m[2]!.replace(/[«»"'.]/g, "").trim();
    out[i] = SECTORS.includes(label) ? label : null;
  }
  return out;
}

// ── القائمة كلها ──────────────────────────────────────────────────
export interface ListReading {
  total: number;
  bySector: Array<{ sector: string; n: number; bucket: Bucket; own: number; model: number; hint: number }>;
  byBucket: Record<Bucket, number>;
  /** القطاع الغالب — وما سواه «غرباء» في هذه القائمة. */
  dominant: string | null;
  /** جهاتٌ قطاعها غير قطاع قائمتها، بدليلٍ من اسمها هي. */
  strangers: number;
  /** ما عُرف بالوراثة من اسم الملف وحده. */
  byHintOnly: number;
  unknown: number;
}

export function readList(rows: Array<{ sector: string | null; by: SectorBy | null }>): ListReading {
  const map = new Map<string, { n: number; own: number; model: number; hint: number }>();
  const byBucket: Record<Bucket, number> = { aml: 0, both: 0, services: 0, secondary: 0, competitor: 0, unknown: 0 };
  let unknown = 0, byHintOnly = 0;
  for (const r of rows) {
    byBucket[bucketOf(r.sector)]++;
    if (!r.sector) { unknown++; continue; }
    const e = map.get(r.sector) ?? { n: 0, own: 0, model: 0, hint: 0 };
    e.n++; if (r.by === "own") e.own++; else if (r.by === "model") e.model++; else { e.hint++; byHintOnly++; }
    map.set(r.sector, e);
  }
  const bySector = [...map.entries()].map(([sector, e]) => ({ sector, bucket: bucketOf(sector), ...e })).sort((a, b) => b.n - a.n);
  const dominant = bySector[0]?.sector ?? null;
  // الغريب من قال اسمه هو (أو قرأه المصنّف) إنه في قطاعٍ آخر — لا من ورث.
  const strangers = bySector.filter((s) => s.sector !== dominant).reduce((n, s) => n + s.own + s.model, 0);
  return { total: rows.length, bySector, byBucket, dominant, strangers, byHintOnly, unknown };
}

/** الأهداف كما تُقال للموظف وللواجهة. */
export function targetsBrief(): string {
  return [
    "أهداف التصنيف (قرار صاحب العمل):",
    `• مكافحة غسل الأموال (AML) ← ${TARGETS.aml.join("، ")} — ومعها الوساطة العقارية ومحلات وتجزئة الذهب والمجوهرات.`,
    `• المحاسبة المتقدمة وضريبة القيمة المضافة والضرائب ← ${TARGETS.services.join("، ")} — الهدف الأساسي.`,
    "• ما سوى ذلك من قطاعاتٍ معروفة: ثانوي، يُحفظ مصنّفاً ولا يُراسَل آلياً.",
    "• مكاتب المحاسبة والتدقيق: منافسون، لا يُراسَلون.",
  ].join("\n");
}

export type { Track };
