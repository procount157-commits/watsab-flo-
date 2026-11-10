// ── مقاييس المزوّدين لكل نوع مهمة ─────────────────────────────────
// complete() لا يكتب صفاً لكل نداء: يجمع في الذاكرة، ويُفرَّغ كل دقيقة في provider_metrics
// بجمعٍ على الصف نفسه (حساب، مزوّد، نموذج، يوم، نوع مهمة). نداءٌ بلا موظف لا حساب له فلا
// يُعدّ هنا؛ له عدّاده في graph/receipts. لا يغيّر هذا الملف ترتيب المزوّدين في شيء.
//
// التوكنات تقديرٌ من عدد الأحرف (tokensOf)، والكلفة غير معروفة ما لم يقلها المزوّد:
// لا جدول أسعار هنا، فالتقرير يقول null بدل صفرٍ كاذب.

import { inSimulation } from "./simulation";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { currentAgent, currentMeter } from "../agent-context";
import { logger } from "../logger";

export const PROVIDER_FLUSH_MS = 60_000;
export const GUARD_MIN_SAMPLE = 10;

interface Bucket {
  userId: number; provider: string; model: string; day: string; taskType: string;
  calls: number; failures: number; tokensIn: number; tokensOut: number; latencyMs: number; guardPassed: number; guardFailed: number;
}
const buckets = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;

const dubaiDay = (now = Date.now()) => new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
/** Tokens from characters, as in graph/receipts.tokensOf: imported from nowhere so llm.ts has no cycle through here. */
const tokensOf = (chars: number) => Math.max(0, Math.round(chars / 4));

function bucket(userId: number, provider: string, model: string, taskType: string): Bucket {
  const day = dubaiDay();
  const k = `${userId}|${provider}|${model}|${day}|${taskType}`;
  let b = buckets.get(k);
  if (!b) {
    b = { userId, provider: provider.slice(0, 40), model: model.slice(0, 120), day, taskType: taskType.slice(0, 60), calls: 0, failures: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, guardPassed: 0, guardFailed: 0 };
    buckets.set(k, b);
  }
  if (!timer) {
    timer = setInterval(() => void flushProviderMetrics().catch((err) => logger.warn({ err: String(err?.message ?? err).slice(0, 200) }, "مقاييس المزوّد لم تُكتب")), PROVIDER_FLUSH_MS);
    timer.unref();
  }
  return b;
}

/** نوع مهمة هذا النداء: ما سمّته الجولة، وإلا دور الموظف. */
const taskTypeNow = (role: string) => currentMeter()?.kind ?? `role:${role}`;

/** محاولةٌ واحدة عند مزوّد واحد. لا يرمي ولا يمسّ الشبكة ولا القاعدة. */
export function noteProviderCall(c: { provider: string; model: string; ok: boolean; ms: number; charsIn?: number; charsOut?: number }): void {
  const who = currentAgent();
  if (!who || inSimulation()) return;
  const b = bucket(who.userId, c.provider, c.model, taskTypeNow(who.role));
  b.calls++;
  if (!c.ok) b.failures++;
  b.latencyMs += Math.max(0, Math.round(c.ms));
  b.tokensIn += tokensOf(c.charsIn ?? 0);
  b.tokensOut += tokensOf(c.charsOut ?? 0);
}

/**
 * ما قاله الحارس في مخرجٍ كُتب في هذه الجولة، مسجَّلٌ على من كتبه. جولةٌ لم يجب فيها نموذج
 * (الحكم على مسودةٍ من جولةٍ سابقة) تُسجَّل على مزوّدٍ غير معروف، لا على من لم يكتب.
 */
export function noteGuardResult(userId: number, role: string, passed: boolean): void {
  if (inSimulation()) return;
  const m = currentMeter();
  const b = bucket(userId, m?.lastProvider ?? "unknown", m?.lastModel ?? "", m?.kind ?? `role:${role}`);
  if (passed) b.guardPassed++; else b.guardFailed++;
}

export async function flushProviderMetrics(): Promise<number> {
  if (!buckets.size) return 0;
  const rows = [...buckets.values()];
  buckets.clear();
  let n = 0;
  for (const b of rows) {
    await db.execute(sql`INSERT INTO provider_metrics (user_id, provider, model, day, task_type, calls, failures, tokens_in, tokens_out, latency_ms, guard_passed, guard_failed)
      VALUES (${b.userId}, ${b.provider}, ${b.model}, ${b.day}, ${b.taskType}, ${b.calls}, ${b.failures}, ${b.tokensIn}, ${b.tokensOut}, ${b.latencyMs}, ${b.guardPassed}, ${b.guardFailed})
      ON CONFLICT (user_id, provider, model, day, task_type) DO UPDATE SET calls = provider_metrics.calls + EXCLUDED.calls, failures = provider_metrics.failures + EXCLUDED.failures,
        tokens_in = provider_metrics.tokens_in + EXCLUDED.tokens_in, tokens_out = provider_metrics.tokens_out + EXCLUDED.tokens_out, latency_ms = provider_metrics.latency_ms + EXCLUDED.latency_ms,
        guard_passed = provider_metrics.guard_passed + EXCLUDED.guard_passed, guard_failed = provider_metrics.guard_failed + EXCLUDED.guard_failed`)
      .then(() => { n++; }, (err) => {
        // حسابٌ حُذف: صفّه يسقط، ولا يُعاد إلى الأبد.
        logger.warn({ userId: b.userId, err: String(err?.message ?? err).slice(0, 160) }, "صف مقاييس مزوّد لم يُكتب");
      });
  }
  return n;
}

/** للاختبار وحده. */
export const pendingProviderBuckets = () => buckets.size;

// ── التقرير ───────────────────────────────────────────────────────
export interface ProviderRow {
  task_type: string; provider: string; model: string; calls: number; failures: number; successRate: number | null; avgLatencyMs: number | null;
  tokensIn: number; tokensOut: number; costUsd: number | null; guardPassed: number; guardFailed: number; guardPassRate: number | null;
}

/** من صفوف مجمَّعة إلى سطر التقرير. الكلفة صفرٌ في الجدول تعني «غير معروفة». Pure. */
export function providerRow(r: { task_type: string; provider: string; model: string; calls: unknown; failures: unknown; tokens_in: unknown; tokens_out: unknown; latency_ms: unknown; cost_usd: unknown; guard_passed: unknown; guard_failed: unknown }): ProviderRow {
  const calls = Number(r.calls), failures = Number(r.failures), gp = Number(r.guard_passed), gf = Number(r.guard_failed), cost = Number(r.cost_usd);
  return {
    task_type: r.task_type, provider: r.provider, model: r.model, calls, failures,
    successRate: calls ? (calls - failures) / calls : null, avgLatencyMs: calls ? Math.round(Number(r.latency_ms) / calls) : null,
    tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), costUsd: cost > 0 ? cost : null,
    guardPassed: gp, guardFailed: gf, guardPassRate: gp + gf >= GUARD_MIN_SAMPLE ? gp / (gp + gf) : null,
  };
}

export const LLM_SETTINGS_NOTE = "llm_settings بلا فلتر حساب: lib/llm.ts يقرأ أول صف لأي حساب ويستعمله مفتاحاً للجميع عبر ذاكرة عامة، وترتيب الصفوف غير مضمون. مُبلَّغ عنه ولم يُغيَّر (AUDIT-P0): الفصل يغيّر مزوّد الحسابين الحيّين.";

export async function providerReport(userId: number, days = 7) {
  const d = Math.min(Math.max(Math.round(days) || 7, 1), 90);
  await flushProviderMetrics().catch(() => 0);
  const from = dubaiDay(Date.now() - (d - 1) * 86_400_000);
  const r = await db.execute<any>(sql`SELECT task_type, provider, model, sum(calls)::bigint AS calls, sum(failures)::bigint AS failures, sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out,
      sum(latency_ms)::bigint AS latency_ms, sum(cost_usd) AS cost_usd, sum(guard_passed)::bigint AS guard_passed, sum(guard_failed)::bigint AS guard_failed
    FROM provider_metrics WHERE user_id = ${userId} AND day >= ${from} GROUP BY 1, 2, 3 ORDER BY sum(calls) DESC, 1, 2, 3 LIMIT 500`);
  const { healthReport } = await import("../llm-health");
  // صحة النماذج عامة بطبيعتها (llm-health)، ولا فيها شيء يخص حساباً.
  const health = (await healthReport().catch(() => [] as any[])).map((h: any) => ({
    provider: h.provider, model: h.model, state: h.resting ? "cooldown" : "ok", ok: Number(h.ok ?? 0), fail: Number(h.fail ?? 0), avgMs: h.avgMs == null ? null : Number(h.avgMs), score: h.score,
  }));
  return { days: d, byTask: r.rows.map(providerRow), health, notes: [LLM_SETTINGS_NOTE, "التوكنات تقدير من عدد الأحرف، والكلفة null تعني غير معروفة.", "فشل المحاولة يُعدّ عند مزوّدها، ونداءٌ بلا موظف لا يدخل هذا التقرير."] };
}

// ── مخرجٌ منظَّم من نموذج ──────────────────────────────────────────
export type Structured<T> = { ok: true; value: T } | { ok: false; error: string };

/** أول كائن JSON في نصٍّ قد يلفّه النموذج بأسوار أو كلام. Pure. */
export function extractJson(text: string): unknown {
  const t = String(text ?? "").replace(/^```(?:json)?\s*/im, "").replace(/```\s*$/m, "");
  const i = t.indexOf("{");
  if (i < 0) throw new Error("لا JSON في الرد");
  let depth = 0, inStr = false, esc = false;
  for (let p = i; p < t.length; p++) {
    const c = t[p]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === "\"") inStr = false; continue; }
    if (c === "\"") inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(i, p + 1));
  }
  throw new Error("JSON غير مكتمل");
}

export type FieldSpec = "string" | "number" | "boolean" | "string[]" | "number[]" | { optional: FieldSpec };
const fits = (v: unknown, s: FieldSpec): boolean => {
  if (typeof s === "object") return v === undefined || v === null || fits(v, s.optional);
  if (s === "string[]") return Array.isArray(v) && v.every((x) => typeof x === "string");
  if (s === "number[]") return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x));
  if (s === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === s;
};

/** ردّ النموذج، مفحوصاً حقلاً حقلاً. ما لا يطابق يعود خطأً، ولا يُقبل نصف كائن. Pure. */
export function parseStructured<T = Record<string, unknown>>(text: string, shape: Record<string, FieldSpec>): Structured<T> {
  let v: any;
  try { v = extractJson(text); } catch (err: any) { return { ok: false, error: String(err?.message ?? err).slice(0, 200) }; }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "ليس كائناً" };
  for (const [k, s] of Object.entries(shape)) if (!fits(v[k], s)) return { ok: false, error: `الحقل ${k} لا يطابق ${JSON.stringify(s)}` };
  return { ok: true, value: v as T };
}
