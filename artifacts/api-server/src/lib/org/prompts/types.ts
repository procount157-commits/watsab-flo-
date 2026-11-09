// ── شكل مدخل المكتبة ──────────────────────────────────────────────
// نصوص الأقسام محايدة عن الحساب: ما يخصّ حساباً بعينه يبقى في كتلة الحساب
// (accounts.ts) أو في accountNotes، فلا يقع في النص المعروض لحسابٍ آخر.

export const SECTION_KEYS = [
  "identity", "expertise", "mission", "responsibilities", "inputData", "approvedTools", "workflow",
  "decisionFramework", "outputSchema", "qualityStandards", "prohibitedActions", "escalationRules", "memoryRules", "performanceMetrics",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];
export type PromptSections = Record<SectionKey, string>;

export const SECTION_TITLES: Record<SectionKey, string> = {
  identity: "الهوية", expertise: "الخبرة", mission: "المهمة", responsibilities: "المسؤوليات", inputData: "المدخلات", approvedTools: "الأدوات",
  workflow: "طريقة العمل", decisionFramework: "إطار القرار", outputSchema: "شكل المخرج", qualityStandards: "معايير الجودة",
  prohibitedActions: "الممنوعات", escalationRules: "التصعيد", memoryRules: "الذاكرة", performanceMetrics: "القياس",
};

export interface PromptEntry {
  version: number;
  /** نصّه قد يصل عميلاً، أو قراره يحدّد من يُراسَل. */
  externalBehavior: boolean;
  sections: PromptSections;
  /** ما يخصّ هذا الدور في حسابٍ بعينه: يُعرض لذلك الحساب وحده. */
  accountNotes?: { procount?: string; floret?: string };
}

export type PromptLibrary = Record<string, PromptEntry>;
