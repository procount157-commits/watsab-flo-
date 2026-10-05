// ── Language model access ─────────────────────────────────────────
// Provider-agnostic, because the only genuinely keyless option is not
// dependable. Measured, not assumed: text.pollinations.ai answered three
// trivial prompts in a row, then failed every one of six realistic
// knowledge-base questions including retries with backoff, and at times
// returned HTML rather than JSON. It stays here as a last resort, never as
// the thing customer replies rely on.
//
// The providers below all have a free tier and need a free key:
//   gemini      https://aistudio.google.com/apikey       — best Arabic
//   groq        https://console.groq.com/keys            — fastest
//   openrouter  https://openrouter.ai/keys               — ":free" models
//
// Set LLM_API_KEY plus LLM_PROVIDER, or just the provider-specific key.
// With none set, callers fall back to answering from the knowledge base
// directly, which needs no network at all.

import { currentAgent } from "./agent-context";
import { and, eq } from "drizzle-orm";
import { db, llmSettingsTable } from "@workspace/db";
import { logger } from "./logger";
import { rank, recordOk, recordFail, type Candidate } from "./llm-health";

export type Provider =
  | "anthropic" | "gemini" | "groq" | "openrouter"
  | "zhipu" | "qwen" | "deepseek" | "moonshot" | "siliconflow"
  | "pollinations" | "none";

export interface LlmMessage { role: "system" | "user" | "assistant"; content: string }
export interface LlmResult  { text: string; provider: Provider }

const KEYS: Record<string, () => string> = {
  anthropic:   () => process.env["ANTHROPIC_API_KEY"]   ?? "",
  gemini:      () => process.env["GEMINI_API_KEY"]      ?? "",
  groq:        () => process.env["GROQ_API_KEY"]        ?? "",
  openrouter:  () => process.env["OPENROUTER_API_KEY"]  ?? "",
  zhipu:       () => process.env["ZHIPU_API_KEY"]       ?? "",
  qwen:        () => process.env["QWEN_API_KEY"]        ?? "",
  deepseek:    () => process.env["DEEPSEEK_API_KEY"]    ?? "",
  moonshot:    () => process.env["MOONSHOT_API_KEY"]    ?? "",
  siliconflow: () => process.env["SILICONFLOW_API_KEY"] ?? "",
};

// Everything except Gemini speaks the OpenAI chat-completions shape, so they
// differ only by base URL and model name.
// 400 was cutting real replies off mid-word: a sales reply that understands the
// customer's situation and asks two questions runs to roughly 500 tokens in
// Arabic, and gpt-oss-120b's answer in the benchmark ended on a bare "أ".
// This is a ceiling, not a target — the prompt asks for brevity, and a model
// that finishes early costs nothing.
const MAX_OUTPUT_TOKENS = 800;

const OPENAI_COMPATIBLE: Record<string, { url: string; model: string }> = {
  // llama-3.3-70b-versatile was the default here and Groq no longer serves it.
  groq:        { url: "https://api.groq.com/openai/v1/chat/completions",
                 model: process.env["GROQ_MODEL"] ?? "qwen/qwen3.8-27b" },
  // Not one of OpenRouter's headline free models: qwen3.8-27b:free,
  // gemma-4-31b-it:free and gemma-4-26b:free each failed 3/3 with a permanent
  // upstream 429, and dots-3-note-preview writes English words into the middle
  // of Arabic sentences. ling-3.0-flash-fin answered 3/3 in fluent Gulf Arabic.
  openrouter:  { url: "https://openrouter.ai/api/v1/chat/completions",
                 model: process.env["OPENROUTER_MODEL"] ?? "inclusionai/ling-3.0-flash-fin:free" },
  // Zhipu's GLM-4-Flash is free outright rather than trial credit.
  zhipu:       { url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
                 // glm-4-flash was retired; glm-4.5-flash is the free tier now, checked
                 // against a live key on 2026-09-29. glm-4.7-flash exists but is
                 // usually over capacity.
                 model: process.env["ZHIPU_MODEL"] ?? "glm-4.5-flash" },
  qwen:        { url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                 model: process.env["QWEN_MODEL"] ?? "qwen-turbo" },
  deepseek:    { url: "https://api.deepseek.com/v1/chat/completions",
                 model: process.env["DEEPSEEK_MODEL"] ?? "deepseek-chat" },
  moonshot:    { url: "https://api.moonshot.cn/v1/chat/completions",
                 model: process.env["MOONSHOT_MODEL"] ?? "moonshot-v1-8k" },
  siliconflow: { url: "https://api.siliconflow.cn/v1/chat/completions",
                 model: process.env["SILICONFLOW_MODEL"] ?? "Qwen/Qwen2.5-7B-Instruct" },
};

// Checked against a live key: gemini-2.0-flash and gemini-2.5-flash are both
// retired ("no longer available to new users"), and the heavier flash models
// spend their output budget on reasoning and truncate a two-line reply.
// flash-lite answers these grounded, short questions cleanly and fast.
const GEMINI_MODEL = process.env["GEMINI_MODEL"] ?? "gemini-flash-lite-latest";

// Claude is not OpenAI-compatible — its own request shape, below.
const ANTHROPIC_MODEL  = process.env["ANTHROPIC_MODEL"]  ?? "claude-opus-5";
// Short, knowledge-grounded replies do not need deep reasoning, and effort is
// the main cost lever within one model. Raise it if answers come out thin.
const ANTHROPIC_EFFORT = process.env["ANTHROPIC_EFFORT"] ?? "low";

// ── Stored credentials ────────────────────────────────────────────
// A key set from the UI lives in the database, so it survives a restart and
// does not need an SSH session and a redeploy to change. Cached briefly
// because it is read on every call; a save clears the cache immediately so a
// new key takes effect without waiting for it to expire.
let stored: { provider: Provider; apiKey: string; model: string | null } | null = null;
let storedAt = 0;
const STORED_TTL_MS = 30_000;

export function invalidateStoredProvider() { storedAt = 0; stored = null; }

async function loadStored() {
  if (storedAt && Date.now() - storedAt < STORED_TTL_MS) return stored;
  try {
    const [row] = await db.select().from(llmSettingsTable).limit(1);
    stored = row ? { provider: row.provider as Provider, apiKey: row.apiKey, model: row.model } : null;
    storedAt = Date.now();
  } catch {
    // Keep whatever was cached — a database blip must not disable the model.
  }
  return stored;
}

/** Which provider will be used, given what is configured. */
// Tried in order when LLM_PROVIDER is not set. Free-and-reliable first.
const PREFERENCE: Provider[] = [
  "anthropic", "gemini", "zhipu", "groq", "qwen", "siliconflow", "openrouter", "deepseek", "moonshot",
];

export function activeProvider(): Provider {
  const explicit = (process.env["LLM_PROVIDER"] ?? "").toLowerCase() as Provider;
  if (explicit && explicit !== "none") return explicit;
  for (const p of PREFERENCE) if (KEYS[p]?.()) return p;
  if (process.env["ALLOW_POLLINATIONS"] === "true") return "pollinations";
  return "none";
}

/** The provider actually in force, stored credentials included. */
export async function resolveProvider(): Promise<{ provider: Provider; apiKey: string; model: string | null } | null> {
  const row = await loadStored();
  if (row?.apiKey) return row;
  const p = activeProvider();
  if (p === "none") return null;
  return { provider: p, apiKey: KEYS[p]?.() ?? "", model: null };
}

export async function providerStatusAsync() {
  const row = await loadStored();
  const base = providerStatus();
  if (!row?.apiKey) return base;
  return {
    ...base,
    provider: row.provider,
    configured: true,
    source: "database" as const,
    model: row.model,
    // Enough to recognise which key is in place, not enough to use it.
    maskedKey: row.apiKey.length > 10
      ? `${row.apiKey.slice(0, 4)}…${row.apiKey.slice(-4)}`
      : "…",
  };
}

export function providerStatus() {
  const p = activeProvider();
  return {
    provider: p,
    configured: p !== "none",
    // Named so the UI can tell the owner exactly what to go and get.
    options: [
      { id: "anthropic",   label: "Claude (Anthropic)",  url: "https://console.anthropic.com/settings/keys", env: "ANTHROPIC_API_KEY",  note: "مدفوع بالتوكن — اشتراك claude.ai لا يصلح، الـAPI منفصل", region: "عالمي" },
      { id: "gemini",      label: "Google Gemini",       url: "https://aistudio.google.com/apikey",         env: "GEMINI_API_KEY",      note: "الأفضل للعربية، طبقة مجانية سخية", region: "عالمي" },
      { id: "zhipu",       label: "Zhipu GLM-4-Flash",   url: "https://open.bigmodel.cn/usercenter/apikeys", env: "ZHIPU_API_KEY",      note: "مجاني بالكامل، صيني", region: "صيني" },
      { id: "qwen",        label: "Qwen (علي بابا)",      url: "https://dashscope.console.aliyun.com/apiKey", env: "QWEN_API_KEY",       note: "حصة مجانية، عربية جيدة", region: "صيني" },
      { id: "siliconflow", label: "SiliconFlow",         url: "https://cloud.siliconflow.cn/account/ak",    env: "SILICONFLOW_API_KEY", note: "نماذج مجانية متعددة", region: "صيني" },
      { id: "deepseek",    label: "DeepSeek",            url: "https://platform.deepseek.com/api_keys",     env: "DEEPSEEK_API_KEY",    note: "رصيد تجريبي ثم رخيص جداً", region: "صيني" },
      { id: "moonshot",    label: "Moonshot Kimi",       url: "https://platform.moonshot.cn/console/api-keys", env: "MOONSHOT_API_KEY", note: "رصيد تجريبي", region: "صيني" },
      { id: "groq",        label: "Groq",                url: "https://console.groq.com/keys",              env: "GROQ_API_KEY",        note: "الأسرع، طبقة مجانية", region: "عالمي" },
      { id: "openrouter",  label: "OpenRouter",          url: "https://openrouter.ai/keys",                 env: "OPENROUTER_API_KEY",  note: "نماذج مجانية متعددة", region: "عالمي" },
    ],
  };
}

// Pollinations serves one request per IP at a time, so calls are queued rather
// than fired concurrently — concurrency is what produced "Queue full" here.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function callGemini(messages: LlmMessage[], timeoutMs: number, apiKey: string): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest   = messages.filter((m) => m.role !== "system");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { temperature: 0.4, maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const d = await res.json() as any;
  return d?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("").trim() ?? "";
}

/**
 * Claude, via the Messages API.
 *
 * Not OpenAI-compatible: the system prompt is a top-level field rather than a
 * message, `max_tokens` is required, and the reply arrives as a list of
 * content blocks that has to be filtered by type.
 */
async function callAnthropic(messages: LlmMessage[], timeoutMs: number, apiKey: string): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest   = messages.filter((m) => m.role !== "system");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1_024,
      ...(system ? { system } : {}),
      output_config: { effort: ANTHROPIC_EFFORT },
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 160)}`);

  const d = await res.json() as {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string;
  };
  // A policy decline comes back as a 200 with stop_reason "refusal", so the
  // reason has to be checked before the content is read.
  if (d.stop_reason === "refusal") throw new Error("anthropic: الطلب رُفض");
  return (d.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

async function callOpenAiCompatible(
  url: string, key: string, model: string, messages: LlmMessage[], timeoutMs: number,
): Promise<string> {
  const body: Record<string, unknown> = {
    model, messages, temperature: 0.4, max_tokens: MAX_OUTPUT_TOKENS,
  };

  // Several of OpenRouter's free models are reasoning models, and they spend
  // the whole budget thinking. ling-3.0-flash-fin produced 910 reasoning tokens
  // and an empty `content` with finish_reason "length" — a silent failure that
  // looked like an outage. Switching reasoning off returns a full answer inside
  // 400 tokens. `reasoning.exclude` is not the same thing: it hides the
  // thinking from the response while still paying for it.
  if (url.includes("openrouter.ai")) body["reasoning"] = { enabled: false };
  // Zhipu's GLM-4.5 does the same by default — 251 tokens of thinking for a
  // one-word answer, measured — and takes its own switch.
  if (url.includes("bigmodel.cn")) body["thinking"] = { type: "disabled" };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${model} ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const d = await res.json() as any;
  const choice = d?.choices?.[0];
  const text = choice?.message?.content?.trim() ?? "";

  // Empty content with a "length" finish is the reasoning trap above. Say so,
  // rather than letting it be filed as an unexplained empty reply.
  if (!text && choice?.finish_reason === "length") {
    throw new Error(`${model}: استهلك الحد كله في التفكير ولم يُنتج رداً`);
  }
  return text;
}

async function callPollinations(messages: LlmMessage[], timeoutMs: number): Promise<string> {
  return serialize(async () => {
    const res = await fetch("https://text.pollinations.ai/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openai", messages, seed: -1, private: true }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.text();
    // It sometimes answers with an HTML error page, so parsing is guarded.
    let d: any; try { d = JSON.parse(body); } catch { throw new Error("pollinations: غير JSON"); }
    if (d?.error) throw new Error(`pollinations: ${String(d.error).slice(0, 60)}`);
    const t = d?.choices?.[0]?.message?.content?.trim();
    if (!t) throw new Error("pollinations: رد فارغ");
    return t;
  });
}

/**
 * Ask the configured model.
 *
 * Returns null rather than throwing: every caller has a non-AI path, and a
 * provider being down must never break message handling.
 */
/** One attempt at one provider. Throws; the chain above decides what to do. */
async function callOne(
  provider: string, model: string, apiKey: string,
  messages: LlmMessage[], timeoutMs: number,
): Promise<string> {
  if (provider === "anthropic")    return callAnthropic(messages, timeoutMs, apiKey);
  if (provider === "gemini")       return callGemini(messages, timeoutMs, apiKey);
  if (provider === "pollinations") return callPollinations(messages, timeoutMs);
  const cfg = OPENAI_COMPATIBLE[provider];
  if (!cfg) throw new Error(`مزوّد غير معروف: ${provider}`);
  return callOpenAiCompatible(cfg.url, apiKey, model || cfg.model, messages, timeoutMs);
}

/**
 * Overload, rate limit, timeout — the provider is fine, it is just busy. Worth
 * another provider; a bad key or a retired model is not.
 */
function isTransient(err: unknown): boolean {
  const m = String((err as any)?.message ?? err);
  return /\b(429|500|502|503|504)\b/.test(m)
    || /timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(m);
}

/**
 * Models worth trying beyond the one the account picked, best first.
 *
 * Measured on this account's own sales task, 2026-09-25. Latency is the median
 * of the benchmark run; the notes are why each one is where it is.
 */
const EXTRA_MODELS: Record<string, string[]> = {
  zhipu: ["glm-4.7-flash"],
  // 1.3s, and the only model that stated the pricing rule back — "التسعير
  // يعتمد على تفاصيل نشاطك" — instead of inventing a number.
  groq: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  openrouter: ["inclusionai/ling-3.0-flash-fin:free"],
};

// Excluded deliberately, so nobody adds them back by guessing:
//   groq/allam-2-7b — fastest of all at 0.7s, and asked a contracting company
//     about stock levels, point-of-sale and food costs. It had picked up the
//     restaurant entries in the knowledge base and applied them to the wrong
//     customer, which is worse than being slow.
//   openrouter/dots-studio/dots-3-note-preview:free — 7.7s and writes
//     "الم registrered" and "ضريبةporate tax".

/**
 * Ask a model, and keep asking until one answers.
 *
 * One provider used to mean one attempt: Gemini returned 503 "experiencing
 * high demand", complete() returned null, and every waiting customer got
 * either silence or a raw knowledge-base entry. A free tier is busy often
 * enough that this has to be the normal path, not an incident.
 *
 * The order is no longer hand-written. Candidates are ranked by what they have
 * actually been doing — see llm-health.ts — with the account's own choice
 * first unless it is in cooldown. pollinations stays last and keyless, so the
 * chain never runs out.
 */
export async function complete(messages: LlmMessage[], timeoutMs = 20_000): Promise<LlmResult | null> {
  // Counted against the employee whose work this is, when it runs inside asAgent().
  const who = currentAgent(), t0 = Date.now();
  const out = await completeInner(messages, timeoutMs);
  // Imported late: feedback reads the knowledge module, which calls back into this one.
  if (who) void import("./feedback").then((f) => f.recordUsage(who.userId, who.role, { ok: !!out, charsIn: messages.reduce((a, m) => a + m.content.length, 0), charsOut: out?.text.length ?? 0, ms: Date.now() - t0 })).catch(() => {});
  return out;
}

async function completeInner(messages: LlmMessage[], timeoutMs: number): Promise<LlmResult | null> {
  const resolved = await resolveProvider();
  if (!resolved || !resolved.apiKey) return null;
  // A stored key has to win over the environment for the whole call, so the
  // per-provider lookups below read through this rather than process.env.
  const keyFor = (id: string) => (id === resolved.provider ? resolved.apiKey : (KEYS[id]?.() ?? ""));

  const pinnedModel = resolved.model || OPENAI_COMPATIBLE[resolved.provider]?.model || "";
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const add = (provider: string, model: string, apiKey: string) => {
    const k = `${provider}|${model}`;
    if (!apiKey && provider !== "pollinations") return;
    if (seen.has(k)) return;
    seen.add(k);
    candidates.push({ provider, model, apiKey });
  };

  add(resolved.provider, pinnedModel, resolved.apiKey);
  for (const id of Object.keys(KEYS)) {
    const key = keyFor(id);
    if (!key) continue;
    add(id, OPENAI_COMPATIBLE[id]?.model ?? "", key);
    for (const m of EXTRA_MODELS[id] ?? []) add(id, m, key);
  }
  // Keyless, so always reachable — and last, because it is slower and less
  // capable than anything above it.
  add("pollinations", "", "");

  const ordered = await rank(candidates, { provider: resolved.provider, model: pinnedModel });

  let lastErr = "";
  for (const step of ordered) {
    // Two tries at the account's own choice, one at everything else: a 503 on
    // a free tier often clears within a second, but spending two timeouts on
    // each of eight candidates would take minutes.
    const attempts = step.provider === resolved.provider && step.model === pinnedModel ? 2 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const t0 = Date.now();
      try {
        const text = await callOne(step.provider, step.model, step.apiKey, messages, timeoutMs);
        if (!text) throw new Error("رد فارغ");
        await recordOk(step.provider, step.model, Date.now() - t0);
        if (step.provider !== resolved.provider || step.model !== pinnedModel) {
          logger.info({ pinned: `${resolved.provider}/${pinnedModel}`, answered: `${step.provider}/${step.model}` },
            "الخيار المفضّل تعذّر — أجاب بديل");
        }
        return { text, provider: step.provider as Provider };
      } catch (err: any) {
        lastErr = String(err?.message ?? err).slice(0, 160);
        await recordFail(step.provider, step.model, lastErr);
        const transient = isTransient(err);
        logger.warn({ provider: step.provider, model: step.model, attempt, transient, err: lastErr }, "LLM call failed");
        // A key or model problem will not fix itself on a retry.
        if (!transient) break;
      }
    }
  }
  logger.error({ tried: ordered.map((c) => `${c.provider}/${c.model}`), lastErr }, "كل المزوّدين تعذّروا");
  return null;
}
