// ── وضع المحاكاة ──────────────────────────────────────────────────
// عملٌ يجري داخل withSimulation: الموظف يفكّر بمسار الكتابة الحقيقي، والبوابة ترفض كل
// إرسالٍ قبل أن تمسّ أي قناة (gateway.ts)، ومسارات الكتابة لا تكتب صفوف العمل (dryRun)،
// ونداءات النموذج لها سقفٌ في السياق نفسه (llm.ts)، ولا تُحسب في الإيصالات ولا الاستهلاك
// ولا مقاييس المزوّد. الشخصية يمكن أن تُستبدل لدورٍ بعينه: هكذا يُقارن الظل التعليمات
// الحالية بالمقترحة على المدخل نفسه.
//
// بلا قاعدة بيانات وبلا استيرادٍ ثقيل: يقرؤه prompt-core وllm والبوابة.
//
// ما يتخطّاه dryRun في مسارات الكتابة (صفوف العمل وحدها):
//   lib/email/agent.ts writeCampaign      → markUsed (استهلاك توجيه منصور وعناوين حصّة)
//   lib/email/inbound.ts draftReply       → UPDATE email_inbound (الخلاصة، المسودة، state=drafted)
//   lib/smart-followup.ts compose*        → لا كتابة فيه (تكتب runRound وrecord، ولا تُستدعى هنا)
//   lib/knowledge.ts answerFromKnowledge  → لا كتابة فيه مع history (الكتابة في logReply خارجه)
//   lib/accounts/pipeline.ts writeFor     → لا كتابة فيه (enqueue خارجه)
//   lib/graph/review.ts reviewOne         → لا كتابة فيه (reviewAndSave خارجه)
//   lib/social/agent.ts draftCommentReply → لا كتابة فيه (الحفظ في engine.processComments)

import { AsyncLocalStorage } from "node:async_hooks";
import { currentAgent } from "../agent-context";
import { employeeKeyOf } from "./departments";

export interface SandboxExecution { at: string; channel: string; kind: string; recipient: string | null; role: string | null; why: string }
export interface SimContext {
  runId: string;
  kind: "shadow" | "e2e" | "manual";
  userId: number;
  /** شخصيةٌ بديلة لدور أو لمفتاح موظف. ما لا يُذكر يعمل بشخصيته المحفوظة. */
  personas: Record<string, string>;
  /** نداءات النموذج المسموحة في هذا السياق. تنفد = لا نداء (null)، ولا خطأ. */
  budget: { left: number; used: number };
  /** ما حاول أن يخرج ورفضته البوابة: يُعرض ولا يُرسل. */
  sandbox: SandboxExecution[];
}

const store = new AsyncLocalStorage<SimContext>();

export function newSimContext(o: { userId: number; kind: SimContext["kind"]; runId?: string; personas?: Record<string, string>; budget?: number }): SimContext {
  return {
    runId: o.runId ?? `${o.kind}:${o.userId}:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: o.kind, userId: o.userId, personas: { ...(o.personas ?? {}) },
    budget: { left: Math.max(0, o.budget ?? 0), used: 0 }, sandbox: [],
  };
}

export function withSimulation<T>(ctx: SimContext, fn: () => Promise<T>): Promise<T> { return store.run(ctx, fn); }
/** شخصية مختلفة لدورٍ واحد داخل محاكاة قائمة، والميزانية والسجل كما هما. */
export function withPersona<T>(role: string, persona: string | null, fn: () => Promise<T>): Promise<T> {
  const cur = store.getStore();
  if (!cur) throw new Error("withPersona خارج المحاكاة");
  const personas = { ...cur.personas };
  delete personas[role]; delete personas[employeeKeyOf(role)];
  if (persona != null) personas[role] = persona;
  return store.run({ ...cur, personas }, fn);
}

export const currentSimulation = (): SimContext | undefined => store.getStore();
export const inSimulation = (): boolean => !!store.getStore();
/** مسار كتابةٍ يسأل قبل أن يكتب صف عمل: في المحاكاة لا يُكتب. */
export const dryRun = (): boolean => !!store.getStore();

/** الشخصية البديلة لهذا الدور إن كانت، وإلا undefined. الدور الافتراضي: من يعمل الآن. */
export function simPersona(role?: string | null): string | undefined {
  const s = store.getStore();
  if (!s) return undefined;
  const r = role ?? currentAgent()?.role;
  if (!r) return undefined;
  return s.personas[r] ?? s.personas[employeeKeyOf(r)];
}
/** ما يُكتب مكان الشخصية: البديلة في المحاكاة إن وُجدت، وإلا المحفوظة كما هي. */
export function personaFor<T extends string | null | undefined>(role: string | null | undefined, stored: T): string | T {
  return simPersona(role) ?? stored;
}

/** نداء نموذج في المحاكاة: يُعدّ من الميزانية. false = نفدت. خارج المحاكاة دائماً true. */
export function takeSimCall(): boolean {
  const s = store.getStore();
  if (!s) return true;
  if (s.budget.left <= 0) return false;
  s.budget.left--; s.budget.used++;
  return true;
}

export function recordSandbox(e: Omit<SandboxExecution, "at">): SandboxExecution {
  const row = { at: new Date().toISOString(), ...e };
  store.getStore()?.sandbox.push(row);
  return row;
}

/** بادئة أنواع التذاكر في السيناريو التجريبي: لا تُعدّ في البطاقات ولا اللوحة ولا وقائع المدير. */
export const SIM_TASK_PREFIX = "sim_";
