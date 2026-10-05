// ── One body of company knowledge, read by everyone ───────────────
// The firm's knowledge lived in four places that did not see each other:
//
//   kb      the bot's knowledge base (knowledge_base) — the WhatsApp side
//   docs    documents uploaded on the email side (email_knowledge_docs)
//   facts   the facts نورة drew out of those documents (agent_memory, kind knowledge)
//   groups  what the owner taught سارة (wa_group_knowledge: text and files)
//
// So a price list uploaded for email was invisible to the WhatsApp salesman,
// and a procedure taught to the groups agent was invisible to the proposal
// writer. Nothing is moved: each source stays where the owner put it, and
// this reads all of them for whoever is writing — the best few from each,
// with near-duplicates dropped.

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, knowledgeBaseTable, emailKnowledgeDocsTable, agentMemoryTable, waGroupKnowledgeTable } from "@workspace/db";
import { retrieve, terms } from "./knowledge";
import { passages } from "./email/knowledge-docs";
import { passagesOf } from "./groups/training";

export type Source = "kb" | "docs" | "facts" | "groups";
export const SOURCE_AR: Record<Source, string> = { kb: "معرفة البوت", docs: "مستندات البريد", facts: "حقائق من المستندات", groups: "تدريب القروبات" };
export type KnowledgeItem = { source: Source; title: string; text: string; score: number };

function overlap(q: Set<string>, text: string) {
  const T = new Set(terms(text));
  if (!q.size || !T.size) return 0;
  let both = 0;
  for (const t of q) if (T.has(t)) both++;
  return both / q.size;
}

/** The best of every source for this question. `exclude` leaves out a source the caller already reads its own way. */
export async function companyKnowledge(userId: number, query: string, opts: { limit?: number; exclude?: Source[]; sectors?: string[]; groupJid?: string | null } = {}): Promise<KnowledgeItem[]> {
  const ex = new Set(opts.exclude ?? []), q = new Set(terms(query));
  if (!q.size) return [];
  const [kb, docs, facts, groups] = await Promise.all([
    ex.has("kb") ? [] : retrieve(userId, query, 4).catch(() => []),
    ex.has("docs") ? [] : passages(userId, query, { sectors: opts.sectors, limit: 3 }).catch(() => []),
    ex.has("facts") ? [] : db.select({ content: agentMemoryTable.content, topic: agentMemoryTable.topic }).from(agentMemoryTable)
      .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.kind, "knowledge"))).limit(800).catch(() => []),
    ex.has("groups") ? [] : db.select().from(waGroupKnowledgeTable).where(and(eq(waGroupKnowledgeTable.userId, userId), eq(waGroupKnowledgeTable.active, true),
      inArray(waGroupKnowledgeTable.kind, ["text", "document", "qa"]), opts.groupJid ? or(isNull(waGroupKnowledgeTable.groupJid), eq(waGroupKnowledgeTable.groupJid, opts.groupJid)) : isNull(waGroupKnowledgeTable.groupJid))).limit(300).catch(() => []),
  ]);
  const items: KnowledgeItem[] = [
    ...kb.map((f, i) => ({ source: "kb" as const, title: f.entry.title, text: f.entry.content, score: 1 - i * 0.1 })),
    ...docs.map((d, i) => ({ source: "docs" as const, title: d.title, text: d.text, score: 0.95 - i * 0.1 })),
    ...facts.map((f) => ({ source: "facts" as const, title: f.topic ?? "حقيقة", text: f.content, score: overlap(q, f.content) })).filter((x) => x.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 3),
    ...groups.flatMap((g) => g.kind === "qa" ? [{ source: "groups" as const, title: "سؤال وجواب", text: `س: ${g.question}\nج: ${g.answer}`, score: overlap(q, g.question ?? "") }]
      : passagesOf(g.content ?? "").map((t) => ({ source: "groups" as const, title: g.title ?? "تدريب", text: t, score: overlap(q, t) })))
      .filter((x) => x.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 2),
  ];
  // The same fact taught twice, in two places, is said once.
  const kept: KnowledgeItem[] = [];
  for (const it of items.sort((a, b) => b.score - a.score)) {
    const words = new Set(terms(it.text));
    if (kept.some((k) => { const K = new Set(terms(k.text)); let both = 0; for (const w of words) if (K.has(w)) both++; return words.size && both / Math.min(words.size, K.size || 1) > 0.8; })) continue;
    kept.push(it);
    if (kept.length >= (opts.limit ?? 6)) break;
  }
  return kept;
}

/** As prompt lines, under one heading, each with where it came from. */
export function knowledgeLines(items: KnowledgeItem[], heading = "من معرفة الشركة (المصدر الوحيد لأي رقم أو سعر أو مهلة):") {
  return items.length ? `${heading}\n${items.map((k) => `- [${SOURCE_AR[k.source]}] ${k.title}: ${k.text.replace(/\s+/g, " ").slice(0, 450)}`).join("\n")}` : "";
}

/** How much each source holds, for the knowledge page. */
export async function knowledgeCounts(userId: number) {
  const [[kb], [docs], [facts], [groups]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.isActive, true))),
    db.select({ n: sql<number>`count(*)::int` }).from(emailKnowledgeDocsTable).where(eq(emailKnowledgeDocsTable.userId, userId)),
    db.select({ n: sql<number>`count(*)::int` }).from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.kind, "knowledge"))),
    db.select({ n: sql<number>`count(*)::int` }).from(waGroupKnowledgeTable).where(and(eq(waGroupKnowledgeTable.userId, userId), eq(waGroupKnowledgeTable.active, true), inArray(waGroupKnowledgeTable.kind, ["text", "document", "qa"]))),
  ]);
  return { kb: kb?.n ?? 0, docs: docs?.n ?? 0, facts: facts?.n ?? 0, groups: groups?.n ?? 0 };
}
