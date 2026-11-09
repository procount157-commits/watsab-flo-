// ── What the owner uploads about the company and its field ───────
// The email section's own library. A document — a company profile, a service
// list with prices, a law and its deadlines, a sector's worries, the house
// style — is read from whatever it came as (PDF, Word, Excel, text), kept
// whole, and handed to نورة, who draws facts from it in the background.
//
// Two uses, because each misses what the other catches:
//   - the facts (agent_memory, doc_id → here) are short and tagged with a
//     sector, and go into every prompt for that sector;
//   - the passages are the document's own words, picked for what is being
//     written right now, so a detail the facts left out — a clause number, a
//     price for a package — is still within reach, quoted, not remembered.

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db, agentMemoryTable, emailKnowledgeDocsTable, type EmailKnowledgeDoc } from "@workspace/db";
import { terms, queryWords } from "../knowledge";
import { complete } from "../llm";
import { logger } from "../logger";
import { brief, ensureEmailAgent, teach, EMAIL_ROLE } from "./agent";
import { asWorker } from "../agent-context";

export const CATEGORIES: Record<string, string> = {
  company: "عن الشركة",
  services: "الخدمات والأسعار",
  sector: "عن القطاع والعملاء",
  compliance: "القوانين والامتثال",
  faq: "أسئلة شائعة واعتراضات",
  style: "أسلوب الكتابة",
  other: "أخرى",
};
const CHUNK = 10_000;       // what one extraction call reads
const MAX_CHUNKS = 12;      // ~120k characters of a document are taught; all of it is kept for passages
const MAX_KEEP = 400_000;   // characters kept per document

// ── Reading a file ───────────────────────────────────────────────
/** The text in a file, whatever it came as. Throws with a message the owner can act on. */
export async function extractText(buffer: Buffer, fileName: string): Promise<string> {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf")) {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: true });
    const out = fixPdfArabic(String(Array.isArray(text) ? text.join("\n\n") : text));
    if (out.replace(/\s/g, "").length < 20) throw new Error("الملف PDF مصوّر بلا نص قابل للقراءة — صدّره كنص أو الصق محتواه");
    return out;
  }
  if (name.endsWith(".docx")) {
    const mammoth = (await import("mammoth")).default;
    const r = await mammoth.extractRawText({ buffer });
    return r.value;
  }
  if (name.endsWith(".doc")) throw new Error("صيغة Word القديمة (.doc) غير مدعومة — احفظ الملف كـ .docx");
  if (/\.(xlsx|xls|csv)$/.test(name)) {
    const wb = XLSX.read(buffer, { type: "buffer" });
    return wb.SheetNames.map((n) => `${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n]!)}`).join("\n\n");
  }
  const raw = buffer.toString("utf8");
  if (/\.html?$/.test(name)) return raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  if (/\.(txt|md|json|rtf)$/.test(name) || !/\.[a-z0-9]+$/.test(name)) return raw;
  throw new Error(`صيغة غير مدعومة: ${fileName} — المدعوم: PDF وWord (.docx) وExcel وCSV والنص`);
}

// Many PDFs store Arabic as it is drawn, not as it is read: each letter in
// its joined shape (the "presentation forms"), and each line's words right to
// left in storage order, so a reader gets "ﺑﺮوﻛﺎوﻧﺖ ﻟﻠﻤﺤﺎﺳﺒﺔ" backwards and in
// shapes no search matches. A line carrying those shapes is put back: the
// shapes to plain letters, and the words reversed — with a run of English
// words or numbers kept in its own order, and a mark or full stop that was
// drawn first moved back to where it belongs.
const SHAPES = /[\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN = /^[A-Za-z0-9@#%&()\[\]+\-_/.:,'"$€£]+$/;
export function fixPdfArabic(text: string): string {
  return text.split("\n").map((line) => {
    if (!SHAPES.test(line)) return line;
    const plain = line.normalize("NFKC").replace(/\u06CC/g, "ي").replace(/\u06BE/g, "ه").replace(/\u06A9/g, "ك");
    const tokens = plain.split(/\s+/).filter(Boolean);
    // English and numbers stay in their order as one run.
    const runs: string[][] = [];
    for (const t of tokens) {
      const last = runs[runs.length - 1];
      if (LATIN.test(t) && last && LATIN.test(last[last.length - 1]!)) last.push(t); else runs.push([t]);
    }
    const words = runs.reverse().map((r) => r.join(" "));
    // A full stop drawn before a word ends it; a lone vowel mark belongs to the word before.
    const out: string[] = [];
    for (const w of words) {
      const lone = /^([.,:;!?،؛؟\u064B-\u0652]+)$/.exec(w);
      if (lone && out.length) {
        const marks = w.replace(/[^\u064B-\u0652]/g, ""), punct = w.replace(/[\u064B-\u0652]/g, "");
        out[out.length - 1] += marks + punct;
        continue;
      }
      const lead = /^([.,:;!?،؛؟]+)(.+)$/.exec(w);
      out.push(lead ? lead[2] + lead[1] : w);
    }
    return out.join(" ");
  }).join("\n");
}

/** Tidy extracted text: one space between words, paragraphs kept. */
export function tidy(text: string): string {
  return text.replace(/\r/g, "").replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Pieces of about `size` characters, cut at paragraph or sentence ends. */
export function chunks(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("۔"), window.lastIndexOf("، "));
    const at = cut > size * 0.5 ? cut + 1 : size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

// ── Adding and learning ──────────────────────────────────────────
export async function addDoc(userId: number, input: { title: string; content: string; category?: string; sector?: string | null; fileName?: string | null }, opts: { learn?: boolean } = {}): Promise<EmailKnowledgeDoc> {
  const content = tidy(input.content).slice(0, MAX_KEEP);
  if (content.length < 20) throw new Error(`«${input.title}»: لا نص كافٍ فيه`);
  const [doc] = await db.insert(emailKnowledgeDocsTable).values({
    userId, title: input.title.trim().slice(0, 200) || "مستند", content, chars: content.length,
    category: input.category && input.category in CATEGORIES ? input.category : "company",
    sector: input.sector?.trim() ? input.sector.trim().slice(0, 80) : null,
    fileName: input.fileName?.slice(0, 255) ?? null, status: opts.learn === false ? "ready" : "processing",
  }).returning();
  if (opts.learn !== false) void learn(userId, doc!.id);
  return doc!;
}

/** نورة reads the document and keeps its facts. In the background; the document's status says how it went. */
export async function learn(userId: number, docId: number): Promise<void> {
  const [doc] = await db.select().from(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, docId), eq(emailKnowledgeDocsTable.userId, userId))).limit(1);
  if (!doc) return;
  try {
    await ensureEmailAgent(userId);
    await db.update(emailKnowledgeDocsTable).set({ status: "processing", error: null, updatedAt: new Date() }).where(eq(emailKnowledgeDocsTable.id, docId));
    // A fresh read replaces what the last one drew from this document.
    await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.docId, docId)));
    const head = `المستند: «${doc.title}» — ${CATEGORIES[doc.category] ?? doc.category}.`;
    for (const piece of chunks(doc.content).slice(0, MAX_CHUNKS)) await teach(userId, `${head}\n\n${piece}`, doc.sector, docId);
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(agentMemoryTable).where(eq(agentMemoryTable.docId, docId)) as any;
    await db.update(emailKnowledgeDocsTable).set({ status: "ready", facts: Number(n), updatedAt: new Date() }).where(eq(emailKnowledgeDocsTable.id, docId));
    logger.info({ userId, docId, facts: Number(n) }, "نورة قرأت مستنداً");
  } catch (err: any) {
    logger.warn({ userId, docId, err: String(err?.message ?? err) }, "قراءة المستند فشلت");
    await db.update(emailKnowledgeDocsTable).set({ status: "failed", error: String(err?.message ?? err).slice(0, 500), updatedAt: new Date() }).where(eq(emailKnowledgeDocsTable.id, docId));
  }
}

// ── Finding the passages that bear on something ──────────────────
/** Paragraph windows of about 900 characters, each knowing which document it is from. */
function passagesOf(doc: Pick<EmailKnowledgeDoc, "id" | "title" | "content">) {
  const out: Array<{ docId: number; title: string; text: string }> = [];
  let buf = "";
  for (const para of doc.content.split(/\n+/)) {
    if (buf && buf.length + para.length > 900) { out.push({ docId: doc.id, title: doc.title, text: buf.trim() }); buf = ""; }
    buf += (buf ? "\n" : "") + para;
    while (buf.length > 1400) { out.push({ docId: doc.id, title: doc.title, text: buf.slice(0, 1200).trim() }); buf = buf.slice(1200); }
  }
  if (buf.trim()) out.push({ docId: doc.id, title: doc.title, text: buf.trim() });
  return out;
}

/**
 * The passages most about `query`, from this account's documents — those for
 * the given sectors and the general ones. Rare words count for more, the way
 * the WhatsApp knowledge base ranks its entries.
 */
export async function passages(userId: number, query: string, opts: { sectors?: string[]; limit?: number } = {}) {
  const sectors = opts.sectors ?? [];
  const docs = await db.select({ id: emailKnowledgeDocsTable.id, title: emailKnowledgeDocsTable.title, content: emailKnowledgeDocsTable.content })
    .from(emailKnowledgeDocsTable)
    .where(and(eq(emailKnowledgeDocsTable.userId, userId),
      sectors.length ? or(isNull(emailKnowledgeDocsTable.sector), inArray(emailKnowledgeDocsTable.sector, sectors))! : sql`true`));
  if (!docs.length) return [];
  const qWords = queryWords(query);
  if (!qWords.length) return [];
  const all = docs.flatMap(passagesOf).map((p) => ({ ...p, terms: new Set(terms(`${p.title} ${p.text}`)) }));
  const df = new Map<string, number>();
  for (const p of all) for (const t of p.terms) df.set(t, (df.get(t) ?? 0) + 1);
  const scored = all.map((p) => {
    let score = 0, hits = 0;
    for (const { forms } of qWords) {
      if (!forms.some((f) => p.terms.has(f))) continue;
      hits++;
      score += Math.max(...forms.map((f) => Math.log(1 + all.length / (df.get(f) ?? 1))));
    }
    return { docId: p.docId, title: p.title, text: p.text, score, hits };
  }).filter((p) => p.hits >= Math.min(2, qWords.length));
  return scored.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 4);
}

// ── Asking ───────────────────────────────────────────────────────
/** The owner checks what نورة knows: an answer from the facts and passages only, with where it came from. */
export async function ask(userId: number, question: string, sector: string | null = null) {
  const [known, found] = await Promise.all([
    brief(userId, sector ? [sector] : [], 3000),
    passages(userId, question, { sectors: sector ? [sector] : [], limit: 4 }),
  ]);
  if (!known && !found.length) return { answer: "لا أعرف شيئاً بعد — ارفع مستندات عن الشركة والقطاع أولاً.", sources: [], provider: null };
  const out = await asWorker(userId, "email", () => complete([
    { role: "system", content: [
      "أنتِ نورة، مسؤولة التسويق بالبريد. صاحب العمل يختبر ما تعرفينه.",
      "أجيبي من المعلومات أدناه فقط. إن لم يكن الجواب فيها فقولي ذلك صراحة واذكري ما ينقصك — لا تخمّني ولا تكملي من عندك.",
      "جواب قصير ومباشر بالعربية، واذكري رقم المصدر بين قوسين [١] عند كل معلومة من مقتطف.",
      "",
      known,
      found.length ? `مقتطفات من المستندات:\n${found.map((p, i) => `[${i + 1}] من «${p.title}»:\n${p.text}`).join("\n\n")}` : "",
    ].filter(Boolean).join("\n") },
    { role: "user", content: question },
  ], 60_000));
  return {
    answer: out?.text?.trim() || (found.length ? `لم يستجب النموذج — هذا أقرب ما وجدته:\n\n${found[0]!.text.slice(0, 600)}` : "لم يستجب النموذج، ولا مقتطف يطابق السؤال."),
    sources: found.map((p, i) => ({ n: i + 1, docId: p.docId, title: p.title, text: p.text.slice(0, 400) })),
    provider: out?.provider ?? null,
  };
}

/** The library for the page: documents without their full text, and the facts with no document. */
export async function library(userId: number) {
  // A read cut off by a restart would say "processing" for ever; after half an hour it is a failure to retry.
  await db.update(emailKnowledgeDocsTable).set({ status: "failed", error: "انقطعت القراءة — اضغط «أعد القراءة»" })
    .where(and(eq(emailKnowledgeDocsTable.userId, userId), eq(emailKnowledgeDocsTable.status, "processing"), sql`${emailKnowledgeDocsTable.updatedAt} < now() - interval '30 minutes'`));
  const [docs, loose, bySector] = await Promise.all([
    db.select({
      id: emailKnowledgeDocsTable.id, title: emailKnowledgeDocsTable.title, category: emailKnowledgeDocsTable.category, sector: emailKnowledgeDocsTable.sector,
      fileName: emailKnowledgeDocsTable.fileName, chars: emailKnowledgeDocsTable.chars, status: emailKnowledgeDocsTable.status, facts: emailKnowledgeDocsTable.facts,
      error: emailKnowledgeDocsTable.error, createdAt: emailKnowledgeDocsTable.createdAt, preview: sql<string>`left(${emailKnowledgeDocsTable.content}, 220)`,
    }).from(emailKnowledgeDocsTable).where(eq(emailKnowledgeDocsTable.userId, userId)).orderBy(desc(emailKnowledgeDocsTable.createdAt)),
    db.select().from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE), eq(agentMemoryTable.kind, "knowledge"), isNull(agentMemoryTable.docId)))
      .orderBy(desc(agentMemoryTable.updatedAt)),
    db.select({ k: sql<string>`coalesce(${agentMemoryTable.topic}, 'عام')`, n: sql<number>`count(*)` }).from(agentMemoryTable)
      .where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE), eq(agentMemoryTable.kind, "knowledge"))).groupBy(sql`1`).orderBy(sql`2 desc`),
  ]);
  return {
    docs, loose, categories: CATEGORIES,
    stats: { docs: docs.length, facts: bySector.reduce((t, r) => t + Number(r.n), 0), chars: docs.reduce((t, d) => t + d.chars, 0), processing: docs.filter((d) => d.status === "processing").length },
    bySector: bySector.map((r) => ({ key: r.k, n: Number(r.n) })),
  };
}

/** Everything the firm taught, as one text — what ماجد checks a message's numbers against. */
export async function knowledgeText(userId: number): Promise<string> {
  const [docs, facts, kb] = await Promise.all([
    db.select({ c: emailKnowledgeDocsTable.content }).from(emailKnowledgeDocsTable).where(eq(emailKnowledgeDocsTable.userId, userId)),
    db.select({ c: agentMemoryTable.content }).from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.role, EMAIL_ROLE))),
    db.execute(sql`select title || ' ' || content as c from knowledge_base where user_id = ${userId} and is_active`),
  ]);
  return [...docs.map((d) => d.c), ...facts.map((f) => f.c), ...(kb.rows as any[]).map((r) => String(r.c))].join("\n");
}
