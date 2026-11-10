// ── التوجيه بالدليل لكل صنف عمل ───────────────────────────────────
// complete() يعرف دور الموظف (asAgent)، ومنه صنف العمل: كاتب، رد على عميل، مصنِّف، محلل،
// سرد، صوت. لكل مزوّد×نموذج×صنف دليلٌ في provider_metrics: النجاح والزمن والجودة — نصيب
// المخرجات التي اجتازت فحص الكود بعدها (قبول الحارس للكاتب، فحص الرد للرد، نجاح التحليل
// لما يعيد JSON). الترتيب هنا لا يضيف مزوّداً ولا يحذف واحداً: يعيد ترتيب ما سمحت به
// القائمة (THEGRID_USERS، قاعدة فريق البريد الإنجليزي، الدفع أولاً) داخل طبقاتها.
//
// ثلاث قواعد:
//  1. أقل من MIN_SAMPLE نداءً لمزوّد في صنفٍ: لا يتحرك من مكانه. الترتيب الحالي يبقى.
//  2. المختار المثبَّت للحساب، والموضوع في التهدئة، لا يُحرَّكان أبداً بالدليل.
//  3. عمل يصل العميل (writer, customer_reply): إن كان بين المرشحين من اجتاز فحص الجودة مرةً
//     على الأقل في هذا الصنف، فمن لم يجتزه قط يتأخر بعدهم جميعاً — لا يُسأل إلا إن تعذّر
//     كل من اجتاز في النداء نفسه. ثمن ذلك أن غير المجرَّب لا يكسب عيّنة في هذا الصنف بعدها:
//     الأمان قبل الاستكشاف، ويُرفع بالمالك لا بالكود.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../logger";

export type TaskClass = "writer" | "customer_reply" | "classifier" | "analyst" | "narrative" | "voice" | "other";
export const TASK_CLASSES: readonly TaskClass[] = ["writer", "customer_reply", "classifier", "analyst", "narrative", "voice", "other"];
/** ما يقرؤه العميل. الصوت مع المالك، لا مع العميل. */
export const CUSTOMER_FACING: ReadonlySet<TaskClass> = new Set<TaskClass>(["writer", "customer_reply"]);

const EXACT: Record<string, TaskClass> = {
  // يرد على عميل كتب
  sales: "customer_reply", support: "customer_reply", followup: "customer_reply", groups: "customer_reply", email_replies: "customer_reply",
  // يكتب ما يُرسل
  email: "writer", email_creator: "writer", email_followup: "writer", accounts_writer: "writer", wa_campaigns: "writer", proposals: "writer",
  // يحكم أو يصنّف
  vetter: "classifier", intake: "classifier", email_guard: "classifier", email_registrar: "classifier", accounts_email: "classifier",
  // يحلل
  email_analyst: "analyst", email_data: "analyst", email_retarget: "analyst", email_opens: "analyst", email_strategist: "analyst",
  accounts_researcher: "analyst", accounts_analyst: "analyst", chat_lead: "analyst", monitor: "analyst", ops: "analyst", collector: "analyst", engineer: "analyst",
  // يروي تقريراً
  ceo_agent: "narrative", chief: "narrative", email_manager: "narrative",
};
const SOCIAL_JOB: Record<string, TaskClass> = {
  dm: "customer_reply", writer: "customer_reply", followup: "customer_reply",
  creator: "writer", prospector: "writer",
  triage: "classifier", qualify: "classifier", guard: "classifier",
  watcher: "analyst", analyst: "analyst", manager: "narrative",
};

/** صنف العمل من الدور. ما لا يُعرف: other — لا يُحسب عملاً يصل العميل. Pure. */
export function taskClassOf(role: string | null | undefined): TaskClass {
  if (!role) return "other";
  const exact = EXACT[role];
  if (exact) return exact;
  const social = /^(ig|tt|li)_(.+)$/.exec(role);
  if (social) return SOCIAL_JOB[social[2]!] ?? "other";
  return "other";
}

// ── الدليل ────────────────────────────────────────────────────────
export interface Evidence { calls: number; failures: number; latencyMs: number; qPassed: number; qFailed: number }
/** أقل عدد نداءات لمزوّد×صنف قبل أن يحرّكه الدليل. ومثله لنسبة الجودة. */
export const MIN_SAMPLE = 20;
/** نصف النتيجة من الجودة حين تُعرف؛ وغير المعروفة تُحسب 0.7 كما في llm-health. */
const QUALITY_WEIGHT = 0.5;
const UNKNOWN_QUALITY = 0.7;
const MS_PER_POINT = 20_000;

export const evidenceKey = (provider: string, model: string, cls: TaskClass | string) => `${provider}|${model}|${cls}`;

/** null: العيّنة أقل من MIN_SAMPLE، فلا رأي. الأعلى أفضل. Pure. */
export function evidenceScore(e: Evidence | undefined): number | null {
  if (!e || e.calls < MIN_SAMPLE) return null;
  const success = Math.max(0, e.calls - e.failures) / e.calls;
  const judged = e.qPassed + e.qFailed;
  const quality = judged >= MIN_SAMPLE ? e.qPassed / judged : UNKNOWN_QUALITY;
  const latency = Math.min(0.3, e.latencyMs / e.calls / MS_PER_POINT);
  return (1 - QUALITY_WEIGHT) * success + QUALITY_WEIGHT * quality - latency;
}

export interface OrderOpts<T> {
  /** لا يتحرك بالدليل: المثبَّت للحساب، ومن في التهدئة. */
  fixed?: (c: T) => boolean;
  /** طبقات القائمة (الدفع أولاً لحسابات THEGRID_USERS): الدليل يرتّب داخل الطبقة ولا يعبرها. */
  tierOf?: (c: T) => number;
}

/**
 * ترتيب المرشحين بالدليل، فوق الترتيب الذي جاء. لا يضيف ولا يحذف. Pure.
 * المؤهَّل (عيّنة كافية، غير ثابت) يُعاد ترتيبه بين خانات المؤهَّلين في طبقته وحدها، فغير المؤهَّل
 * يبقى في خانته. ثم قاعدة العمل الذي يصل العميل: من لم يجتز الجودة قط يتأخر، إن وُجد من اجتاز.
 */
export function orderByEvidence<T extends { provider: string; model: string }>(
  ordered: T[], cls: TaskClass, evidence: ReadonlyMap<string, Evidence>, opts: OrderOpts<T> = {},
): T[] {
  const ev = (c: T) => evidence.get(evidenceKey(c.provider, c.model, cls));
  const out = [...ordered];
  const tiers = new Map<number, number[]>();
  out.forEach((c, i) => {
    if (opts.fixed?.(c) || evidenceScore(ev(c)) == null) return;
    const t = opts.tierOf?.(c) ?? 0;
    tiers.set(t, [...(tiers.get(t) ?? []), i]);
  });
  for (const slots of tiers.values()) {
    if (slots.length < 2) continue;
    // ترتيب ثابت: التعادل يبقي الترتيب الأصلي.
    const items = slots.map((i) => ({ c: out[i]!, s: evidenceScore(ev(out[i]!))!, i })).sort((a, b) => b.s - a.s || a.i - b.i);
    slots.forEach((slot, k) => { out[slot] = items[k]!.c; });
  }
  if (!CUSTOMER_FACING.has(cls)) return out;
  const proven = (c: T) => (ev(c)?.qPassed ?? 0) > 0;
  if (!out.some(proven)) return out;
  return [...out.filter(proven), ...out.filter((c) => !proven(c))];
}

// ── القراءة من provider_metrics ──────────────────────────────────
/** نافذة الدليل، ومدة الذاكرة: الترتيب لا يسأل القاعدة في كل نداء. */
export const EVIDENCE_DAYS = 30;
export const EVIDENCE_TTL_MS = 5 * 60_000;
let cache: { at: number; map: Map<string, Evidence> } | null = null;
let loading: Promise<Map<string, Evidence>> | null = null;

/** دليلٌ عام لكل الحسابات: جودة نموذجٍ في صنف عمل لا تخص حساباً، كما llm_health. */
export async function routingEvidence(now = Date.now()): Promise<ReadonlyMap<string, Evidence>> {
  if (cache && now - cache.at < EVIDENCE_TTL_MS) return cache.map;
  loading ??= (async () => {
    const from = new Date(now + 4 * 3_600_000 - (EVIDENCE_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const r = await db.execute<any>(sql`SELECT provider, model, task_class, sum(calls)::bigint AS calls, sum(failures)::bigint AS failures,
        sum(latency_ms)::bigint AS latency_ms, sum(guard_passed)::bigint AS q_passed, sum(guard_failed)::bigint AS q_failed
      FROM provider_metrics WHERE day >= ${from} AND task_class <> '' GROUP BY 1, 2, 3`);
    const map = new Map<string, Evidence>();
    for (const x of r.rows) map.set(evidenceKey(x.provider, x.model, x.task_class), {
      calls: Number(x.calls), failures: Number(x.failures), latencyMs: Number(x.latency_ms), qPassed: Number(x.q_passed), qFailed: Number(x.q_failed),
    });
    cache = { at: Date.now(), map };
    return map;
  })().catch((err) => {
    // بلا دليل: الترتيب كما كان، ولا يُمنع نداء.
    logger.warn({ err: String(err?.message ?? err).slice(0, 160) }, "دليل التوجيه لم يُقرأ — الترتيب الحالي");
    cache = { at: Date.now(), map: new Map() };
    return cache.map;
  }).finally(() => { loading = null; });
  return loading;
}

/** للاختبار، وبعد تفريغ المقاييس. */
export const forgetRoutingEvidence = () => { cache = null; };
