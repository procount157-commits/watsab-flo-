// ── كتلة الحساب ───────────────────────────────────────────────────
// الحقائق الخاصة بكل حساب هنا وحدها. renderPrompt يختار كتلةً واحدة بالاسم،
// وأي حسابٍ لا يُعرف باسمه يأخذ الكتلة المحايدة: لا يرث حقائق حسابٍ آخر.

import { SECTION_KEYS, SECTION_TITLES, type PromptEntry } from "./types";

export type PromptAccount = { name: string; vertical?: string | null };
export type AccountKind = "procount" | "floret" | "other";

/** أي حسابٍ هذا؟ بالاسم لا بالنشاط: محل ذهبٍ آخر ليس فلوريت. Pure. */
export function accountKind(a: PromptAccount): AccountKind {
  const n = (a.name ?? "").toLowerCase();
  if (/floret|فلوريت/.test(n)) return "floret";
  if (/pro\s*count|بروكاونت|برو\s*كاونت/.test(n)) return "procount";
  return "other";
}

export const PROCOUNT_BLOCK = [
  "Pro Count for Accounting L.L.C. — «بروكاونت للمحاسبة»، مقرها أبوظبي، شريك خارجي للمحاسبة والضرائب والتقارير المالية والامتثال لمكافحة غسل الأموال (AML/CFT/CPF) للشركات في الإمارات. لسنا برنامج محاسبة ولا شركة تأسيس أعمال ولا شركة رواتب.",
  "الجمهور شركات (B2B) لا أفراد؛ وصاحب القرار المالك أو المدير العام أو المدير المالي أو مسؤول الامتثال.",
  "ممنوع منعاً باتاً: اختراع قانون أو نسبة أو غرامة أو مهلة أو سعر؛ ضمان الامتثال أو تجنّب الغرامات أو اجتياز التفتيش؛ ادعاء اعتماد حكومي. «تتوقف الالتزامات على نشاط المنشأة وتصنيفها التنظيمي».",
].join("\n");

export const FLORET_BLOCK = [
  "فلوريت للذهب والمجوهرات (FLORET JEWELRY): بيت ذهب بحريني في مدينة العين، يبيع أطقم ومجوهرات الذهب أونلاين لكل الإمارات مع التوصيل، وله معرض في العين. الجمهور أفراد، والكلام بلهجة خليجية طبيعية محترمة.",
  "لا سعر ولا وزن ولا سعر ذهب اليوم ولا مصنعية ولا خصم في أي رسالة — من يسأل عنها يُرسل له رابط القطعة من المتجر.",
  "ممنوع منعاً باتاً أي تحبّب: حبيبتي، حبيبي، صاحبتي، قلبي، عمري، روحي، حياتي، يا قمر، يا عسل، غناتي. الاحترام هو الدفء.",
  "ممنوع منعاً باتاً: «هلا وغلا» و«حبيت أطمّنك» — صاحب العمل رفضهما.",
  "الرابط دائماً: https://floret-royal.io كما هو حرفياً، ولا تخترع رابط قطعة. لا تعد بتوفر قطعة غير مذكورة.",
].join("\n");

const otherBlock = (a: PromptAccount): string => [
  `${a.name || "هذا الحساب"}: مصدر الحقائق معرفة الحساب المرفقة وحدها، وما ليس فيها لا يُذكر.`,
  a.vertical === "jewelry" ? "محل: لا سعر ولا وزن ولا خصم في أي رسالة، ولا كلمة تحبّب؛ الجواب رابط المتجر المعطى لك." : "",
].filter(Boolean).join("\n");

/** كتلة الحساب كما تُعرض. Pure. */
export function accountBlock(a: PromptAccount): string {
  const kind = accountKind(a);
  return kind === "procount" ? PROCOUNT_BLOCK : kind === "floret" ? FLORET_BLOCK : otherBlock(a);
}

/** تعليمات الموظف كاملةً لحساب: أقسامه، ثم ما يخصّ الحساب. Pure. prompt-core يُضاف فوقها وقت التشغيل. */
export function renderPrompt(entry: PromptEntry, account: PromptAccount): string {
  const kind = accountKind(account);
  const name = account.name || "الحساب";
  const body = SECTION_KEYS.map((k) => `## ${SECTION_TITLES[k]}\n${entry.sections[k].replaceAll("{account}", name)}`);
  const note = kind === "other" ? "" : entry.accountNotes?.[kind] ?? "";
  return [...body, `## قواعد الحساب\n${accountBlock(account)}${note ? `\n${note}` : ""}`].join("\n");
}
