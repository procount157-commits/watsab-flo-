// ── خط العمل لكل شركة: فهد ← نوف ← سالم ← هند ← الطابور ─────────────
// كل خطوة تكتب سطرها في سجل المكتب، وكل خطوة تفشل تترك الشركة بحالةٍ
// تقول السبب (no_site، no_person، no_email، needs_review) لا في منتصف الطريق.

import { and, eq, sql } from "drizzle-orm";
import {
  db, emailContactsTable, emailSequencesTable, emailSequenceJobsTable,
  targetAccountsTable, targetPeopleTable, type TargetAccount,
} from "@workspace/db";
import { readPage, rankLinks } from "../site-study";
import { complete } from "../llm";
import { parseLoose } from "../loose-json";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { checkMailboxes, type Mailbox } from "../email/mailbox-check";
import { brief, toHtml } from "../email/agent";
import { guardCheck, formatIssues } from "../email/team";
import { getSettings, enrolInSequence, ACCOUNTS_SEQUENCE_PREFIX } from "../email/service";
import { accountsVoice, deskActivity } from "./team";
import { runAs } from "../org/runtime";
import { finishWorkflow, qualityFeedback, recordQualityFeedback, startWorkflow, workflowStep } from "../org/handoffs";
import { noteGuardResult } from "../org/providers";
import {
  pickPages, visibleText, extractSignal, signalLine, groundPeople, extractEmails, domainPattern,
  emailCandidates, personalMatch, roleAddress, nameInSource, clampNote, stripNoteSignature, writingIssues, readWritten,
  type Signal, type FoundPerson, type Written,
} from "./pure";

const UA = "FlowHubResearch/1.0 (+https://flow.getmihwar.com)";
const MAX_BYTES = 400_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One page, politely: 12 s, HTML only, at most ~400 KB read. */
export async function fetchHtml(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(12_000), redirect: "follow" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("text/html") || !r.body) return null;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value); size += value.length;
    }
    reader.cancel().catch(() => {});
    return { url: r.url || url, html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, MAX_BYTES) };
  } catch { return null; }
}

// ── Tavily (only with the owner's key) ────────────────────────────
export interface SearchHit { title: string; url: string; content: string }
export async function tavily(key: string | null | undefined, query: string, max = 5): Promise<SearchHit[]> {
  if (!key) return [];
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: "basic" }),
    });
    if (!r.ok) return [];
    const j: any = await r.json();
    return (Array.isArray(j?.results) ? j.results : []).map((x: any) => ({ title: String(x?.title ?? ""), url: String(x?.url ?? ""), content: String(x?.content ?? "").slice(0, 800) })).filter((x: SearchHit) => x.url);
  } catch { return []; }
}

// ── ١. فهد: الموقع والإشارة ───────────────────────────────────────
export interface Research {
  site: string | null;
  pages: Array<{ url: string; text: string }>;
  emails: string[];
  signal: Signal | null;
  hits: SearchHit[];
}

export async function research(acc: TargetAccount, o: { key: string | null; engaged: boolean }): Promise<Research> {
  const home = (await fetchHtml(`https://${acc.domain}`)) ?? (await fetchHtml(`https://www.${acc.domain}`));
  const pages: Research["pages"] = [];
  const html: string[] = [];
  if (home) {
    const read = readPage(home.html, home.url);
    pages.push({ url: home.url, text: visibleText(home.html) });
    html.push(home.html);
    for (const u of pickPages(rankLinks(read.links), 6)) {
      await pause(1_000);
      const p = await fetchHtml(u);
      if (!p) continue;
      pages.push({ url: p.url, text: visibleText(p.html) });
      html.push(p.html);
    }
  }
  const emails = extractEmails(html.join("\n")).filter((e) => e.endsWith(`@${acc.domain}`) || e.endsWith(`.${acc.domain}`));
  let signal = extractSignal(pages);
  const hits: SearchHit[] = [];
  if (o.key) {
    const news = await tavily(o.key, `"${acc.company}" UAE real estate news 2026`, 5);
    hits.push(...news);
    if (!signal) {
      const s = extractSignal(news.map((h) => ({ url: h.url, text: `${h.title}. ${h.content}` })));
      signal = s ?? (news[0] ? { kind: "news", label: "خبر حديث", text: `${news[0].title}`.slice(0, 200), source: news[0].url } : null);
    }
  }
  if (!signal && o.engaged) signal = { kind: "engaged", label: "تفاعل معنا", text: "فتح أو نقر رسالةً سابقة منا", source: "email_contacts" };
  return { site: home?.url ?? null, pages, emails, signal, hits };
}

// ── ٢. نوف: صاحب القرار ───────────────────────────────────────────
export function sourceText(r: Research): string {
  return [
    ...r.pages.map((p) => `[${p.url}]\n${p.text}`),
    ...r.hits.map((h) => `[${h.url}]\n${h.title}\n${h.content}`),
  ].join("\n\n");
}

export async function findPeople(userId: number, acc: TargetAccount, r: Research): Promise<{ people: FoundPerson[]; answered: boolean }> {
  const all = sourceText(r);
  if (!all.trim()) return { people: [], answered: true };
  // The model reads a budget; the grounding check reads everything.
  const budget = [
    ...r.pages.map((p) => `[المصدر: ${p.url}]\n${p.text.slice(0, 2500)}`),
    ...r.hits.map((h) => `[المصدر: ${h.url}]\n${h.title}\n${h.content}`),
  ].join("\n\n").slice(0, 14_000);
  const system = await accountsVoice(userId, "accounts_analyst");
  const user = [
    `الشركة: ${acc.company} (${acc.domain})${acc.city ? ` — ${acc.city}` : ""}. القطاع: عقارات في الإمارات.`,
    "من هذه النصوص وحدها: من يقرّر امتثال هذه الشركة لمكافحة غسل الأموال؟ (المالك/المؤسس، المدير العام/التنفيذي، MLRO/مسؤول الامتثال، المدير المالي).",
    "حتى ثلاثة أشخاص. الاسم كما كُتب حرفياً في النص. لينكدإن فقط إن ظهر رابطه في النص. علّم واحداً فقط isDecisionMaker.",
    "أجب بـ JSON وحده بهذا الشكل:",
    `{"people":[{"name":"","title":"","why":"سطر واحد بالعربية: لماذا يقرّر الامتثال هنا","linkedinUrl":"","source":"رابط المصدر","isDecisionMaker":true}]}`,
    "إن لم تجد أحداً: {\"people\":[]}",
    "",
    "النصوص:",
    budget,
  ].join("\n");
  const out = await asAgent(userId, "accounts_analyst", () => complete([{ role: "system", content: system }, { role: "user", content: user }], 45_000, { maxTokens: 900 }));
  if (!out) return { people: [], answered: false };
  const parsed = parseLoose<{ people?: unknown }>(out.text);
  const people = groundPeople(parsed?.people, all);
  // A LinkedIn profile Tavily returned whose title carries the name is a link we did see.
  for (const p of people) {
    if (p.linkedinUrl) continue;
    const hit = r.hits.find((h) => /linkedin\.com\/in\//i.test(h.url) && nameInSource(p.name, h.title));
    if (hit) p.linkedinUrl = hit.url.split("?")[0]!;
  }
  return { people, answered: true };
}

// ── ٣. سالم: البريد ───────────────────────────────────────────────
export type EmailStatus = "published" | "verified" | "catchall" | "guessed" | "invalid";
export interface Found { email: string | null; status: EmailStatus | null }

/** The domain's addresses we already hold, with their names and state. */
async function knownOnDomain(userId: number, domain: string) {
  return db.select({ id: emailContactsTable.id, email: emailContactsTable.email, name: emailContactsTable.name, status: emailContactsTable.status, mailbox: emailContactsTable.mailbox })
    .from(emailContactsTable)
    .where(and(eq(emailContactsTable.userId, userId), sql`lower(split_part(${emailContactsTable.email}, '@', 2)) = ${domain.toLowerCase()}`))
    .limit(200);
}

export async function findEmail(userId: number, domain: string, person: FoundPerson, ctx: { siteEmails: string[]; known: Awaited<ReturnType<typeof knownOnDomain>>; from: string | null; probe: boolean }): Promise<Found> {
  const published = personalMatch(ctx.siteEmails, person.name, domain);
  if (published) return { email: published, status: "published" };
  const ours = ctx.known.filter((k) => k.status === "active");
  const mine = ours.find((k) => (k.name && nameInSource(person.name, k.name)) || personalMatch([k.email], person.name, domain));
  if (mine?.mailbox === "ok") return { email: mine.email.toLowerCase(), status: "verified" };
  const evidence = [...ctx.siteEmails, ...ctx.known.map((k) => k.email)];
  const names = [person.name, ...ctx.known.map((k) => k.name ?? "").filter(Boolean)];
  const pattern = domainPattern(evidence, names);
  const cands = [...new Set([...(mine ? [mine.email.toLowerCase()] : []), ...emailCandidates(person.name, domain, { published: ctx.siteEmails, pattern })])];
  if (!cands.length) return { email: null, status: null };
  if (!ctx.probe || !ctx.from) return { email: cands[0]!, status: "guessed" };
  // Negative ids: these are not contacts yet, so the probe's own bookkeeping touches no row.
  const res = await checkMailboxes(cands.map((email, i) => ({ id: -(i + 1), email })), ctx.from).catch(() => new Map<number, Mailbox>());
  const verdicts = cands.map((email, i) => ({ email, v: res.get(-(i + 1)) ?? "unknown" }));
  const ok = verdicts.find((x) => x.v === "ok");
  if (ok) return { email: ok.email, status: "verified" };
  if (verdicts.some((x) => x.v === "catchall")) return { email: cands[0]!, status: "catchall" };
  if (verdicts.length && verdicts.every((x) => x.v === "invalid")) return { email: null, status: "invalid" };
  return { email: cands[0]!, status: "guessed" };
}

// ── ٤. هند: الكتابة ───────────────────────────────────────────────
export async function writeFor(userId: number, acc: TargetAccount, person: FoundPerson, o: { fallback: boolean; signal: Signal | null; senderFirst: string; siteFacts: string }): Promise<{ written: Written | null; issues: string[] }> {
  const knowledge = await brief(userId, [acc.sector ?? "عقارات"], 2500, { lessons: false, query: "real estate AML compliance brokers developers goAML" }).catch(() => "");
  const system = await accountsVoice(userId, "accounts_writer");
  const first = person.name.split(/\s+/)[0]!;
  const notes = await qualityFeedback(userId, "accounts_writer").catch(() => [] as string[]);
  const signalFor = o.signal && o.signal.kind !== "engaged" ? `${o.signal.text} (source: ${o.signal.source})` : null;
  const base = [
    `Write to ONE person. Recipient: ${person.name}${person.title ? `, ${person.title}` : ""} at ${acc.company} (${acc.domain}), a UAE real-estate company${acc.city ? ` in ${acc.city}` : ""}.`,
    person.why ? `Why he decides AML compliance there: ${person.why}` : "",
    signalFor ? `Signal (why now) — quote or paraphrase it faithfully in the first sentence: ${signalFor}` : `No signal found: open with one plain fact about ${acc.company} from its own website text below.`,
    o.fallback ? `This goes to the company's general mailbox. The body's FIRST line must be exactly: "Attn: ${person.name}${person.title ? `, ${person.title}` : ""}" — then speak to him.` : "",
    `Greeting: "Hi ${first}," then the text. Sign off with: "${o.senderFirst}, Pro Count".`,
    "Email 1: subject 2–5 words; body 50–90 words; one verifiable AML fact for real estate ONLY from the knowledge below (no other numbers); ONE question as the call to action; no meeting or call request, no links.",
    "Follow-up 2 (day 3): a new angle, ≤60 words. Follow-up 3 (day 7): a polite close, ≤40 words. LinkedIn connection note: ≤280 characters, no pitch, mentions the signal, NO signature and no name at the end (the owner sends it from his own profile).",
    "Plain paragraphs separated by blank lines. English only.",
    notes.length ? `The quality guard stopped your earlier drafts for these — do not repeat them:\n- ${notes.join("\n- ")}` : "",
    "Return ONLY JSON:",
    `{"subject":"","body":"","followup2":{"subject":"","body":""},"followup3":{"subject":"","body":""},"linkedin":""}`,
    "",
    `Company website text (facts you may use about them):\n${o.siteFacts.slice(0, 2500)}`,
    "",
    `The firm's knowledge (the ONLY source of sector facts and numbers):\n${knowledge || "(none — use no numbers at all)"}`,
  ].filter(Boolean).join("\n");

  let issues: string[] = [];
  let last: Written | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = attempt === 0 ? base : `${base}\n\nYour previous draft was refused for these reasons — fix every one and return the whole JSON again:\n- ${issues.join("\n- ")}\n\nPrevious draft:\n${JSON.stringify(last)}`;
    const out = await asAgent(userId, "accounts_writer", () => complete([{ role: "system", content: system }, { role: "user", content: user }], 60_000, { maxTokens: 1400 }));
    if (!out) { issues = ["لم يرد أي نموذج"]; continue; }
    const w = readWritten(parseLoose(out.text));
    if (!w) { issues = ["الرد ليس JSON بالشكل المطلوب"]; continue; }
    w.linkedin = clampNote(stripNoteSignature(w.linkedin));
    if (o.fallback && !/^attn:/i.test(w.body)) w.body = `Attn: ${person.name}${person.title ? `, ${person.title}` : ""}\n\n${w.body}`;
    last = w;
    const allowed = `${knowledge}\n${o.signal?.text ?? ""}\n${o.siteFacts}`;
    issues = [
      ...writingIssues(w, acc.company),
      ...guardCheck([w.subject, w.body, ...w.followups.map((f) => `${f.subject} ${f.body}`), w.linkedin], allowed),
      // ماجد's length rule; the lead/button rules are a campaign's, not a personal note's.
      ...formatIssues(toHtml(w.body), "first").filter((x) => !/ملخص|زر/.test(x)),
    ];
    if (!issues.length) return { written: w, issues: [] };
  }
  return { written: last, issues };
}

// ── ٥. الطابور ─────────────────────────────────────────────────────
export async function enqueue(userId: number, acc: TargetAccount, personId: number, person: FoundPerson, to: string, fallback: boolean, w: Written): Promise<{ ok: boolean; why?: string; contactId?: number; sequenceId?: number }> {
  const es = await getSettings(userId);
  if (!es?.fromEmail || !(es.smtpHost || es.apiKey)) return { ok: false, why: "لا مرسل بريد مضبوط في الإعدادات" };
  const email = to.toLowerCase();
  let [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), sql`lower(${emailContactsTable.email}) = ${email}`)).limit(1);
  if (contact && contact.status !== "active") return { ok: false, why: `العنوان ${email} حالته ${contact.status}` };
  if (!contact) {
    [contact] = await db.insert(emailContactsTable).values({
      userId, email, name: fallback ? null : person.name, company: acc.company, city: acc.city, sector: acc.sector, industry: "Real estate",
      source: "accounts_desk", tags: ["accounts_desk"],
    }).onConflictDoNothing().returning();
    if (!contact) [contact] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), sql`lower(${emailContactsTable.email}) = ${email}`)).limit(1);
  } else if (!fallback && !contact.name) {
    await db.update(emailContactsTable).set({ name: person.name }).where(eq(emailContactsTable.id, contact.id));
  }
  if (!contact) return { ok: false, why: "تعذّر حفظ الجهة" };
  const steps = [
    { afterHours: 0, subject: w.subject, html: toHtml(w.body) },
    ...w.followups.map((f) => ({ afterHours: f.afterDays * 24, subject: f.subject, html: toHtml(f.body) })),
  ];
  const [seq] = await db.insert(emailSequencesTable).values({
    userId, name: `${ACCOUNTS_SEQUENCE_PREFIX}${acc.company} — ${person.name}`.slice(0, 160), steps, stopOnReply: true, stopOnOpen: false, isActive: true,
  }).returning();
  const r = await enrolInSequence(userId, seq!.id, [contact.id]);
  if (!r.enrolled) return { ok: false, why: "لم تُسجَّل الجهة في التسلسل (هدنة، أو بريدها بلا MX)", contactId: contact.id, sequenceId: seq!.id };
  // The first rung goes now, not somewhere in the next hour.
  await db.update(emailSequenceJobsTable).set({ dueAt: new Date() })
    .where(and(eq(emailSequenceJobsTable.sequenceId, seq!.id), eq(emailSequenceJobsTable.contactId, contact.id), eq(emailSequenceJobsTable.stepIndex, 0), eq(emailSequenceJobsTable.status, "pending")));
  await db.update(targetPeopleTable).set({ contactId: contact.id, sequenceId: seq!.id }).where(eq(targetPeopleTable.id, personId));
  return { ok: true, contactId: contact.id, sequenceId: seq!.id };
}

// ── الشركة كلها ───────────────────────────────────────────────────
const setAcc = (id: number, v: Partial<typeof targetAccountsTable.$inferInsert>) =>
  db.update(targetAccountsTable).set({ ...v, updatedAt: new Date() }).where(eq(targetAccountsTable.id, id));

export function senderFirstName(fromName: string | null | undefined): string {
  const n = String(fromName ?? "").replace(/\b(from|at|\||-|–)\b.*$/i, "").replace(/pro\s?count.*/i, "").trim();
  const first = n.split(/\s+/)[0] ?? "";
  return /^[A-Za-z][A-Za-z'\-]{1,20}$/.test(first) ? first : "The team";
}

export const ACCOUNTS_WORKFLOW = "accounts_desk";

/** شركةٌ واحدة: سير عملٍ بحدثٍ لكل خطوة. «sent» يبقى مفتوحاً حتى تخرج الرسالة فعلاً (desk.syncAccounts). */
export async function processAccount(userId: number, acc: TargetAccount, o: { key: string | null; engaged: boolean }): Promise<string> {
  const wf = await startWorkflow(userId, ACCOUNTS_WORKFLOW, { accountId: acc.id, company: acc.company, domain: acc.domain });
  const st = await processSteps(userId, acc, o, wf);
  if (st !== "sent") await finishWorkflow(wf, st === "needs_review" ? "failed" : "cancelled", { status: st });
  return st;
}

async function processSteps(userId: number, acc: TargetAccount, o: { key: string | null; engaged: boolean }, wf: number | null): Promise<string> {
  try {
    // ١ — فهد
    const r = await research(acc, o);
    await setAcc(acc.id, { website: r.site, signal: r.signal ? signalLine(r.signal) : null, signalSource: r.signal?.source ?? null });
    await deskActivity(userId, "accounts_researcher", "research", r.site
      ? `فهد قرأ ${r.pages.length} صفحة من موقع ${acc.company}${r.signal ? ` — الإشارة: ${r.signal.label}` : " — لا إشارة"}.`
      : `فهد: موقع ${acc.company} (${acc.domain}) لا يفتح.`, { accountId: acc.id });
    await workflowStep(userId, wf, "accounts_researcher", "research", { site: r.site, pages: r.pages.length, signal: r.signal?.kind ?? null });
    if (!r.site && !r.hits.length) { await setAcc(acc.id, { status: "no_site", notes: "الموقع لا يفتح ولا بحث على الويب" }); return "no_site"; }

    // ٢ — نوف
    const { people, answered } = (await runAs(userId, "accounts_analyst", { kind: "find_people", respect: "none" }, () => findPeople(userId, acc, r)))!;
    await workflowStep(userId, wf, "accounts_analyst", "decision_maker", { answered, people: people.length, decisionMaker: people.find((p) => p.isDecisionMaker)?.name ?? null });
    if (!answered) { await setAcc(acc.id, { status: "needs_review", notes: "لم يرد أي نموذج لقراءة الأسماء — يُعاد غداً" }); return "needs_review"; }
    if (!people.length) {
      await setAcc(acc.id, { status: r.site ? "no_person" : "no_site", notes: "لا اسم مكتوب لصاحب قرار في المصادر" });
      await deskActivity(userId, "accounts_analyst", "no_person", `نوف لم تجد اسماً مكتوباً لصاحب قرار في ${acc.company}.`, { accountId: acc.id });
      return "no_person";
    }
    const dm = people.find((p) => p.isDecisionMaker)!;
    await deskActivity(userId, "accounts_analyst", "person", `نوف وجدت ${dm.name}${dm.title ? ` (${dm.title})` : ""} صاحب القرار في ${acc.company}${people.length > 1 ? ` و${people.length - 1} غيره` : ""}.`, { accountId: acc.id });

    // ٣ — سالم
    const es = await getSettings(userId);
    const known = await knownOnDomain(userId, acc.domain);
    const ids = new Map<FoundPerson, number>();
    const found = new Map<FoundPerson, Found>();
    await runAs(userId, "accounts_email", { kind: "find_email", respect: "none" }, async () => {
      for (const p of people) {
        const f = await findEmail(userId, acc.domain, p, { siteEmails: r.emails, known, from: es?.fromEmail ?? null, probe: p === dm });
        found.set(p, f);
      }
    });
    const dmFound = found.get(dm)!;
    const personal = dmFound.email && (dmFound.status === "published" || dmFound.status === "verified") ? dmFound.email : null;
    const role = personal ? null : roleAddress([...r.emails, ...known.filter((k) => k.status === "active").map((k) => k.email)], acc.domain);
    const to = personal ?? role;
    for (const p of people) {
      const f = found.get(p)!;
      const [row] = await db.insert(targetPeopleTable).values({
        userId, accountId: acc.id, name: p.name, title: p.title, why: p.why, email: f.email, emailStatus: f.status,
        emailFallback: p === dm && !personal && !!role, linkedinUrl: p.linkedinUrl, sourceUrl: p.source, isDecisionMaker: p === dm,
      }).returning({ id: targetPeopleTable.id });
      ids.set(p, row!.id);
    }
    const statusAr: Record<string, string> = { published: "منشور", verified: "متحقَّق", catchall: "الخادم يقبل الكل", guessed: "تخمين", invalid: "مرفوض" };
    await deskActivity(userId, "accounts_email", "email", to
      ? `سالم: ${personal ? `بريد ${dm.name} ${statusAr[dmFound.status!]} (${personal})` : `بريد ${dm.name} ${dmFound.status ? statusAr[dmFound.status] : "غير معروف"} — يذهب إلى ${role} بعبارة Attn`}.`
      : `سالم لم يجد عنواناً يُرسل إليه في ${acc.company}.`, { accountId: acc.id });
    await workflowStep(userId, wf, "accounts_email", "email", { to, status: dmFound.status, fallback: !personal });
    if (!to) { await setAcc(acc.id, { status: "no_email", notes: "لا بريد متحقَّق له ولا عنوان عام للشركة" }); return "no_email"; }

    // ٤ — هند
    const siteFacts = r.pages.map((p) => p.text.slice(0, 900)).join("\n").slice(0, 2500);
    const { written, issues } = (await runAs(userId, "accounts_writer", { kind: "write_email", respect: "none" }, async () => {
      const out = await writeFor(userId, acc, dm, { fallback: !personal, signal: r.signal, senderFirst: senderFirstName(es?.fromName), siteFacts });
      noteGuardResult(userId, "accounts_writer", !!out.written && !out.issues.length);
      return out;
    }))!;
    await workflowStep(userId, wf, "accounts_writer", "write", { written: !!written, subject: written?.subject ?? null });
    // حكم ماجد داخل writeFor (guardCheck وformatIssues): خطوته في السجل، وما رفضه يصل هند في كتابتها التالية.
    await workflowStep(userId, wf, "email_guard", "quality", { pass: !!written && !issues.length, issues: issues.slice(0, 6) });
    if (issues.length) await recordQualityFeedback(userId, "accounts_writer", issues, { accountId: acc.id }).catch(() => {});
    const draft = written ? { emailTo: to, emailSubject: written.subject.slice(0, 300), emailBody: written.body, emailFollowups: written.followups, linkedinMessage: written.linkedin || null } : { emailTo: to };
    if (!written || issues.length) {
      await setAcc(acc.id, { ...draft, status: "needs_review", notes: `ماجد أوقف المسودة: ${issues.join("؛ ")}`.slice(0, 1500) });
      await deskActivity(userId, "accounts_writer", "hold", `هند: مسودة ${dm.name} لم تمرّ بعد محاولتين — تنتظر مراجعة صاحب العمل.`, { accountId: acc.id, issues });
      return "needs_review";
    }
    await setAcc(acc.id, { ...draft, status: "ready" });
    await deskActivity(userId, "accounts_writer", "write", `هند كتبت لـ ${dm.name}: «${written.subject}» ومتابعتين وملاحظة لينكدإن.`, { accountId: acc.id });

    // ٥ — الطابور
    const q = await enqueue(userId, acc, ids.get(dm)!, dm, to, !personal, written);
    await workflowStep(userId, wf, "email_queue", "queued", { ok: q.ok, why: q.why ?? null, sequenceId: q.sequenceId ?? null });
    if (!q.ok) {
      await setAcc(acc.id, { status: q.why?.includes("مرسل") ? "ready" : "needs_review", notes: q.why ?? null, contactId: q.contactId ?? null, sequenceId: q.sequenceId ?? null });
      return "ready";
    }
    await setAcc(acc.id, { status: "sent", contactId: q.contactId!, sequenceId: q.sequenceId! });
    await deskActivity(userId, "accounts_writer", "send", `رسالة ${dm.name} في ${acc.company} دخلت الطابور إلى ${to}${personal ? "" : " (العنوان العام)"}.`, { accountId: acc.id, sequenceId: q.sequenceId });
    return "sent";
  } catch (e: any) {
    logger.warn({ userId, accountId: acc.id, err: String(e?.message ?? e) }, "مكتب الحسابات: تعذّرت الشركة");
    await setAcc(acc.id, { status: "needs_review", notes: `خطأ: ${String(e?.message ?? e).slice(0, 300)}` }).catch(() => {});
    return "needs_review";
  }
}

