// ── مكتبات الاعتراضات والكتيبات لكل حساب ──────────────────────────
// لكل حسابٍ معروف بالاسم مكتبته، ولا مكتبة لغيره: حسابٌ ثالث لا يرث شيئاً. تُبذر في
// account_knowledge بمفاتيح objection.* وplaybook.* معلّقةً (pending)، فلا تدخل تعليمات أي
// موظف حتى يعتمدها صاحب العمل (render.ts يقرأ المعتمد وحده). Pure.

import { accountKind, type AccountKind, type PromptAccount } from "../../prompts/accounts";
import type { ObjectionType, PersuasionRole } from "../persuasion";
import { FLORET_LIBRARY } from "./floret";
import { PROCOUNT_LIBRARY } from "./procount";

export type ProofStatus = "approved_knowledge" | "needs_owner_approval";
export interface ObjectionItem {
  slug: string; type: ObjectionType;
  /** objection: قلق يمنع خطوة. info_request: سؤال يريد جواباً. refusal: لا — يتوقف كل شيء. */
  kind: "objection" | "info_request" | "refusal";
  signal: string; response: string;
  proof: { text: string; status: ProofStatus; source: string } | null;
  nextStep: string; roles: PersuasionRole[];
}
export interface Playbook { role: PersuasionRole; text: string; source: string }
export interface AccountLibrary { account: Exclude<AccountKind, "other">; language: "en" | "ar"; objections: ObjectionItem[]; playbooks: Playbook[] }

export const ACCOUNT_LIBRARIES: Record<Exclude<AccountKind, "other">, AccountLibrary> = { procount: PROCOUNT_LIBRARY, floret: FLORET_LIBRARY };

/** مكتبة الحساب باسمه، أو لا شيء. Pure. */
export function libraryFor(account: PromptAccount): AccountLibrary | null {
  const k = accountKind(account);
  return k === "other" ? null : ACCOUNT_LIBRARIES[k];
}

export interface KnowledgeRow { key: string; value: string; source: string }
/** صفوف account_knowledge لمكتبة. القيمة JSON يقرؤه render.ts. Pure. */
export function libraryRows(lib: AccountLibrary): KnowledgeRow[] {
  const src = (s: string) => `org-docs:objections/${lib.account}.ts · ${s}`.slice(0, 1000);
  return [
    ...lib.objections.map((o) => ({
      key: `objection.${o.slug}`,
      value: JSON.stringify({ type: o.type, kind: o.kind, signal: o.signal, response: o.response, proof: o.proof, nextStep: o.nextStep, roles: o.roles, language: lib.language }),
      source: src(o.proof?.source ?? "no proof point"),
    })),
    ...lib.playbooks.map((p) => ({
      key: `playbook.${p.role}`,
      value: JSON.stringify({ role: p.role, text: p.text, roles: [p.role], language: lib.language }),
      source: src(p.source),
    })),
  ];
}
