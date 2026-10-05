import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, knowledgeBaseTable, businessProfileTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { retrieve, answerFromKnowledge, getProfile, recentAutoReplies } from "../lib/knowledge";
import { providerStatus, providerStatusAsync, complete, activeProvider, resolveProvider, invalidateStoredProvider } from "../lib/llm";
import { healthReport } from "../lib/llm-health";
import { db as _db } from "@workspace/db";
import { llmSettingsTable } from "@workspace/db";

const router = Router();
router.use(requireAuth);

// ── Which model, if any ───────────────────────────────────────────
router.get("/provider", async (_req, res) => res.json(await providerStatusAsync()));

/**
 * What each model has actually been doing, best first.
 *
 * Worth surfacing rather than keeping in the logs: when a reply is slow or
 * missing, this is the answer, and it is the only place the owner can see that
 * the provider they picked is the one in cooldown.
 */
router.get("/provider/health", async (_req, res) => res.json(await healthReport()));

/**
 * Store a provider key.
 *
 * Kept in the database rather than .env so it survives a restart and can be
 * changed without an SSH session and a redeploy. The key is never read back —
 * GET returns a masked form only.
 */
router.put("/provider", async (req, res) => {
  const userId = req.session.userId!;
  const provider = String(req.body?.provider ?? "").trim().toLowerCase();
  const apiKey   = String(req.body?.apiKey ?? "").trim();
  const model    = String(req.body?.model ?? "").trim() || null;

  const allowed = ["anthropic", "gemini", "groq", "openrouter", "zhipu", "qwen", "deepseek", "moonshot", "siliconflow"];
  if (!allowed.includes(provider)) return res.status(400).json({ error: "مزوّد غير مدعوم" });
  if (apiKey.length < 8) return res.status(400).json({ error: "المفتاح قصير أو فارغ" });

  const values = { userId, provider, apiKey, model, updatedAt: new Date() };
  await _db.insert(llmSettingsTable).values(values)
    .onConflictDoUpdate({ target: llmSettingsTable.userId, set: values });
  invalidateStoredProvider();   // take effect now, not in 30 seconds

  // Prove it works before reporting success — a key that stores but cannot
  // answer is worse than none, because nothing looks wrong.
  const out = await complete([
    { role: "system", content: "أجب بكلمة واحدة بالعربية." },
    { role: "user",   content: "قل: جاهز" },
  ], 20_000);

  res.json({
    saved: true,
    provider,
    working: !!out?.text,
    sample: out?.text?.slice(0, 60) ?? null,
    error: out ? null : "حُفظ المفتاح لكن المزوّد لم يستجب — تحقق من المفتاح أو اسم النموذج.",
  });
});

router.delete("/provider", async (req, res) => {
  await _db.delete(llmSettingsTable).where(eq(llmSettingsTable.userId, req.session.userId!));
  invalidateStoredProvider();
  res.json({ success: true });
});

/** Round-trip the configured provider so a key can be verified before relying on it. */
router.post("/provider/test", async (_req, res) => {
  const resolved = await resolveProvider();
  const p = resolved?.provider ?? "none";
  if (!resolved) {
    return res.json({ ok: false, provider: p, error: "لا يوجد مزوّد مضبوط — أضف مفتاحاً من هذه الصفحة" });
  }
  const out = await complete([
    { role: "system", content: "أجب بكلمة واحدة فقط بالعربية." },
    { role: "user",   content: "قل: جاهز" },
  ], 15_000);
  res.json(out
    ? { ok: true, provider: out.provider, sample: out.text.slice(0, 80) }
    : { ok: false, provider: p, error: "المزوّد لم يستجب — تحقق من المفتاح أو الحصة" });
});

// ── Business profile ──────────────────────────────────────────────
router.get("/profile", async (req, res) => {
  res.json((await getProfile(req.session.userId!)) ?? null);
});

router.put("/profile", async (req, res) => {
  const userId = req.session.userId!;
  const { name, industry, description, tone, guardrails, autoReply, voiceReplies } = req.body ?? {};
  const values = {
    userId,
    name: name ?? null, industry: industry ?? null, description: description ?? null,
    tone: ["friendly", "professional", "casual"].includes(tone) ? tone : "friendly",
    guardrails: guardrails ?? null,
    autoReply: !!autoReply,
    voiceReplies: voiceReplies === "off" ? "off" : "mirror",
    updatedAt: new Date(),
  };
  const [row] = await db.insert(businessProfileTable).values(values)
    .onConflictDoUpdate({ target: businessProfileTable.userId, set: values })
    .returning();
  res.json(row);
});

// ── Entries ───────────────────────────────────────────────────────
router.get("/entries", async (req, res) => {
  const rows = await db.select().from(knowledgeBaseTable)
    .where(eq(knowledgeBaseTable.userId, req.session.userId!))
    .orderBy(desc(knowledgeBaseTable.updatedAt));
  res.json(rows);
});

router.post("/entries", async (req, res) => {
  const userId = req.session.userId!;
  const { title, content, keywords, category } = req.body ?? {};
  if (!String(title ?? "").trim() || !String(content ?? "").trim()) {
    return res.status(400).json({ error: "العنوان والمحتوى مطلوبان" });
  }
  const [row] = await db.insert(knowledgeBaseTable).values({
    userId, title: String(title).trim(), content: String(content).trim(),
    keywords: keywords ? String(keywords).trim() : null,
    category: category ? String(category).trim() : null,
  }).returning();
  res.json(row);
});

router.patch("/entries/:id", async (req, res) => {
  const userId = req.session.userId!;
  const id = parseInt(req.params.id!);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const f of ["title", "content", "keywords", "category"]) {
    if (req.body?.[f] !== undefined) updates[f] = String(req.body[f]).trim() || null;
  }
  if (req.body?.isActive !== undefined) updates.isActive = !!req.body.isActive;

  const [row] = await db.update(knowledgeBaseTable).set(updates)
    .where(and(eq(knowledgeBaseTable.id, id), eq(knowledgeBaseTable.userId, userId)))
    .returning();
  if (!row) return res.status(404).json({ error: "العنصر غير موجود" });
  res.json(row);
});

router.delete("/entries/:id", async (req, res) => {
  await db.delete(knowledgeBaseTable).where(and(
    eq(knowledgeBaseTable.id, parseInt(req.params.id!)),
    eq(knowledgeBaseTable.userId, req.session.userId!),
  ));
  res.json({ success: true });
});

/**
 * Bulk add, for pasting an FAQ in one go.
 *
 * Accepts either a list of {title, content} or plain text split on blank
 * lines, where the first line of each block becomes the title.
 */
/**
 * Bulk add, for pasting an FAQ or a whole document.
 *
 * Splitting on blank lines alone turns a Markdown document into one entry per
 * line: "Company Name:**" becomes a knowledge entry, and the name itself
 * becomes another. A 500-line document produced 525 fragments that way, of
 * which 328 were under forty characters and answered nothing. Retrieval then
 * works perfectly over rubble.
 *
 * So headings are treated as headings: a `#` line starts an entry and
 * everything under it — until the next heading of the same or higher level —
 * is its content. Documents with no headings fall back to blank-line
 * paragraphs, which is the right reading for a pasted FAQ.
 */
function parseDocument(text: string): Array<{ title: string; content: string }> {
  const lines = text.replace(/\r/g, "").split("\n");
  const hasHeadings = lines.some((l) => /^#{1,6}\s+\S/.test(l));

  const clean = (t: string) =>
    t.replace(/\*\*/g, "").replace(/^[-*•\s]+/, "").replace(/\s+$/, "").trim();

  const out: Array<{ title: string; content: string }> = [];

  if (hasHeadings) {
    let title = "";
    let buf: string[] = [];
    const flush = () => {
      const content = clean(buf.join("\n"));
      // A heading with nothing under it is a section divider, not knowledge.
      if (title && content) out.push({ title: title.slice(0, 255), content });
      buf = [];
    };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      if (h) { flush(); title = clean(h[2] ?? ""); continue; }
      buf.push(line);
    }
    flush();
  } else {
    for (const block of text.split(/\n\s*\n/)) {
      const bl = block.trim().split("\n");
      const title = clean(bl.shift() ?? "");
      const content = clean(bl.join("\n")) || title;
      if (title) out.push({ title: title.slice(0, 255), content });
    }
  }

  // Anything this short cannot answer a question; keeping it only dilutes
  // retrieval, because every entry competes for the same matches.
  return out.filter((e) => e.content.replace(/\s/g, "").length >= 25);
}

router.post("/entries/bulk", async (req, res) => {
  const userId = req.session.userId!;
  const { entries, text, replace } = req.body ?? {};

  let rows: Array<{ title: string; content: string }> = [];
  if (Array.isArray(entries)) {
    rows = entries
      .map((e: any) => ({ title: String(e?.title ?? "").trim(), content: String(e?.content ?? "").trim() }))
      .filter((e) => e.title && e.content);
  } else if (typeof text === "string" && text.trim()) {
    rows = parseDocument(text);
  }
  if (rows.length === 0) return res.status(400).json({ error: "لا يوجد محتوى صالح" });

  if (replace) await db.delete(knowledgeBaseTable).where(eq(knowledgeBaseTable.userId, userId));

  const inserted = await db.insert(knowledgeBaseTable)
    .values(rows.map((r) => ({ userId, ...r })))
    .returning({ id: knowledgeBaseTable.id });
  res.json({ added: inserted.length, replaced: !!replace });
});

// ── Try it ────────────────────────────────────────────────────────

/**
 * Ask a question the way a customer would and see exactly what comes back,
 * including which entries were used — so a wrong answer points at the entry
 * that caused it.
 */
router.post("/ask", async (req, res) => {
  const userId = req.session.userId!;
  const question = String(req.body?.text ?? "").trim();
  if (!question) return res.status(400).json({ error: "أرسل سؤالاً" });

  const [found, answer] = await Promise.all([
    retrieve(userId, question),
    answerFromKnowledge(userId, question),
  ]);

  res.json({
    question,
    reply: answer.reply,
    provider: answer.provider,
    reason: answer.reason ?? null,
    matched: found.map((f) => ({
      id: f.entry.id, title: f.entry.title,
      score: Number(f.score.toFixed(3)), hits: f.hits,
    })),
  });
});

router.get("/log", async (req, res) => res.json(await recentAutoReplies(req.session.userId!)));


/** Every source of company knowledge at once: what each holds, and what the employees would find for a question. */
router.get("/unified", async (req, res) => {
  const userId = req.session.userId!;
  const q = String(req.query["q"] ?? "").trim();
  const { companyKnowledge, knowledgeCounts, SOURCE_AR } = await import("../lib/company-knowledge");
  res.json({ counts: await knowledgeCounts(userId), sources: SOURCE_AR, results: q ? await companyKnowledge(userId, q, { limit: 8 }) : [] });
});

export default router;
