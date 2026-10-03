// ── Email marketing API ───────────────────────────────────────────
// Everything the section does, behind the session. The public half — the
// pixel, the click, the unsubscribe, the inbound hook — is routes/track.ts.

import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql, gte } from "drizzle-orm";
import {
  db, listFoldersTable, emailSettingsTable, emailContactsTable, emailListsTable, emailListMembersTable,
  emailTemplatesTable, emailCampaignsTable, emailSequencesTable, emailSequenceJobsTable,
  emailMessagesTable, emailEventsTable, emailInboundTable, emailSegmentsTable, emailMissionsTable,
  botEmployeesTable, agentMemoryTable, emailKnowledgeDocsTable, type EmailStep,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { assertCanSend, assertCanAddContacts, planErrorToResponse } from "../lib/plans";
import { getSettings, overview, startCampaign, pauseCampaign, enrolInSequence, cancelSequencesFor, recordEvent, verdictFor, signals } from "../lib/email/service";
import { verifySettings, sendEmail, isConfigured, messageIdFor } from "../lib/email/provider";
import { checkDomain } from "../lib/email/dns";
import { cleanRows, detectColumns, checkMx, splitBy, type ImportRow } from "../lib/email/importer";
import { draftReply, sendReply, pollMailbox } from "../lib/email/inbound";
import { readWorkbook, parseTables, whatsappEntries } from "../lib/phone-import";
import { saveToNewGroup, validateInBackground } from "../lib/contact-save";
import { folderForSector, listSector } from "../lib/folders";
import { deleteContacts, deleteList } from "../lib/email/delete";
import { diagnose } from "../lib/email/diagnose";
import { dashboard as emailDashboard } from "../lib/email/dashboard";
import { createWithCreator, SERVICES as CREATOR_SERVICES } from "../lib/email/creator";
import { getAutopilot, saveAutopilot, runAutopilot } from "../lib/email/autopilot";
import { teamStatus, activity as teamActivity } from "../lib/email/team";
import { addDoc, extractText, learn as learnDoc, ask as askKnowledge, library as knowledgeLibrary } from "../lib/email/knowledge-docs";
import { classifySector, SECTORS, UNCLASSIFIED } from "../lib/email/sector";
import { cleanFilter, facets, resolve as resolveSegment, count as countSegment, describe as describeSegment, conditions as segmentConditions } from "../lib/email/segments";
import { ensureEmailAgent, memory as agentMemory, teach, rememberKnowledge, writeCampaign, EMAIL_ROLE } from "../lib/email/agent";
import { createMission, setAudience as setMissionAudience, approve as approveMission, runMission, missionsFor, missionReport } from "../lib/email/missions";
import { seedEmailDefaults, DEFAULT_SEQUENCE_NAME } from "../lib/email/seed";
import { newToken, renderEmail, personalize } from "../lib/email/tracking";
import { brandOf, directionOf } from "../lib/email/layout";
import { logger } from "../lib/logger";

const router = Router();
router.use(requireAuth);

/**
 * Why the email is not going out.
 *
 * One call that asks every question the owner was asking by hand — is the mail
 * server reachable, is there anyone to send to, is a mission stuck, did the
 * reports reach Telegram — and answers each with what was actually found.
 * It probes SMTP live rather than trusting the stored settings, because a
 * wrong password and a sleeping laptop fail identically from the outside.
 */
router.get("/diagnose", async (req, res) => res.json(await diagnose(req.session.userId!)));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } });

// ── Overview ──────────────────────────────────────────────────────
router.get("/overview", async (req, res) => res.json(await overview(req.session.userId!)));

router.get("/events", async (req, res) => {
  const userId = req.session.userId!;
  const since = req.query["since"] ? new Date(String(req.query["since"])) : new Date(Date.now() - 24 * 3_600_000);
  const rows = await db.select({ e: emailEventsTable, to: emailMessagesTable.toEmail, subject: emailMessagesTable.subject, campaignId: emailMessagesTable.campaignId })
    .from(emailEventsTable).leftJoin(emailMessagesTable, eq(emailMessagesTable.id, emailEventsTable.messageId))
    .where(and(eq(emailEventsTable.userId, userId), gte(emailEventsTable.createdAt, since)))
    .orderBy(desc(emailEventsTable.createdAt)).limit(200);
  res.json(rows.map((r) => ({ id: r.e.id, type: r.e.type, at: r.e.createdAt, to: r.to, subject: r.subject, url: r.e.url, campaignId: r.campaignId, meta: r.e.meta })));
});

// ── Settings ──────────────────────────────────────────────────────
const mask = (s: any) => s ? { ...s, smtpPass: s.smtpPass ? "••••••" : null, apiKey: s.apiKey ? "••••••" : null, imapPass: s.imapPass ? "••••••" : null } : null;

router.get("/settings", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  res.json({ settings: mask(s), configured: isConfigured(s), trackingBase: (process.env["SITE_URL"] ?? "") || null, health: await verdictFor(req.session.userId!), signals: await signals(req.session.userId!) });
});

router.put("/settings", async (req, res) => {
  const userId = req.session.userId!;
  const b = req.body ?? {};
  const cur = await getSettings(userId);
  const keep = (v: unknown, old: string | null | undefined) => (v === "••••••" || v === undefined ? old ?? null : (v as string | null));
  const values = {
    userId,
    provider: ["smtp", "resend", "brevo"].includes(b.provider) ? b.provider : "smtp",
    smtpHost: b.smtpHost ?? null, smtpPort: Number(b.smtpPort) || 587, smtpSecure: !!b.smtpSecure,
    smtpUser: b.smtpUser ?? null, smtpPass: keep(b.smtpPass, cur?.smtpPass),
    apiKey: keep(b.apiKey, cur?.apiKey),
    fromName: b.fromName ?? null, fromEmail: b.fromEmail ?? null, replyTo: b.replyTo ?? null, signature: b.signature ?? null,
    layout: b.layout === "plain" ? "plain" : "branded",
    brandName: b.brandName ?? cur?.brandName ?? null, brandTagline: b.brandTagline ?? cur?.brandTagline ?? null,
    brandColor: b.brandColor ?? cur?.brandColor ?? null, brandAccent: b.brandAccent ?? cur?.brandAccent ?? null,
    logoUrl: b.logoUrl ?? cur?.logoUrl ?? null, website: b.website ?? cur?.website ?? null, phone: b.phone ?? cur?.phone ?? null, address: b.address ?? cur?.address ?? null,
    hourlyCap: Math.min(500, Math.max(5, Number(b.hourlyCap) || 40)),
    dailyCap: Math.min(5000, Math.max(10, Number(b.dailyCap) || 300)),
    tracking: b.tracking !== false,
    imapHost: b.imapHost ?? null, imapPort: Number(b.imapPort) || 993, imapUser: b.imapUser ?? null, imapPass: keep(b.imapPass, cur?.imapPass),
    autoReply: !!b.autoReply,
    autoReplyDelayMin: Math.min(240, Math.max(2, Number(b.autoReplyDelayMin) || 12)),
    warmup: b.warmup !== false,
    inboundToken: cur?.inboundToken ?? randomBytes(18).toString("base64url"),
    updatedAt: new Date(),
  };
  const [row] = await db.insert(emailSettingsTable).values(values as any)
    .onConflictDoUpdate({ target: emailSettingsTable.userId, set: values as any }).returning();
  // The first configured account gets the ready-made sequence and templates.
  if (!cur) await seedEmailDefaults(userId).catch(() => {});
  res.json({ settings: mask(row), configured: isConfigured(row) });
});

router.post("/settings/test", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s) return res.status(400).json({ ok: false, detail: "لا إعدادات" });
  res.json(await verifySettings(s));
});

router.post("/settings/test-send", async (req, res) => {
  const userId = req.session.userId!;
  const s = await getSettings(userId);
  if (!isConfigured(s)) return res.status(400).json({ error: "إعدادات البريد غير مكتملة" });
  const to = String(req.body?.to || s!.fromEmail).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: "بريد الاستلام غير صالح" });
  const token = newToken();
  const base = (process.env["SITE_URL"] ?? "").replace(/\/+$/, "");
  const r = renderEmail("<p>هذه رسالة اختبار من إعدادات البريد في FLOW HUB. إن وصلتك فالمُرسِل يعمل.</p><p><a href=\"https://example.com\">رابط للتجربة</a></p>", {},
    { base, token, secret: process.env["SESSION_SECRET"] ?? "wam", pixel: !!s!.tracking, links: !!s!.tracking },
    { base, token, fromName: s!.fromName ?? s!.fromEmail!, fromEmail: s!.fromEmail! }, brandOf(s));
  try {
    const out = await sendEmail(s!, { to, subject: "اختبار الإرسال — FLOW HUB", html: r.html, text: r.text, messageId: messageIdFor(token, s!.fromEmail!), unsubscribeUrl: null });
    logger.info({ userId, to, serverReply: out.serverReply, accepted: out.accepted, rejected: out.rejected, messageId: out.providerId }, "رسالة اختبار البريد");
    res.json({ ok: true, to, providerId: out.providerId, serverReply: out.serverReply ?? null, accepted: out.accepted ?? [], rejected: out.rejected ?? [] });
  } catch (err: any) {
    logger.warn({ userId, to, err: String(err?.message ?? err) }, "رسالة اختبار البريد فشلت");
    res.status(400).json({ ok: false, error: String(err?.message ?? err) });
  }
});

router.get("/settings/dns", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s?.fromEmail) return res.status(400).json({ error: "اضبط عنوان المُرسِل أولاً" });
  res.json(await checkDomain(s.fromEmail));
});

router.post("/settings/poll", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  if (!s?.imapHost) return res.status(400).json({ error: "لا إعدادات IMAP" });
  res.json({ handled: await pollMailbox(s), lastError: (await getSettings(req.session.userId!))?.imapLastError ?? null });
});

// ── Contacts & lists ──────────────────────────────────────────────
// ── Contacts: filter, count, act ──────────────────────────────────
// The filter is a segment filter, posted as JSON (arrays do not survive a
// query string well), so the table, the counts and a saved segment all mean
// the same thing by it.
function filterFrom(req: any) {
  const raw = req.method === "GET" ? { ...req.query, sectors: req.query.sectors ? String(req.query.sectors).split("|") : undefined, cities: req.query.cities ? String(req.query.cities).split("|") : undefined, engagement: req.query.engagement ? String(req.query.engagement).split("|") : undefined, statuses: req.query.status ? [String(req.query.status)] : undefined, listIds: req.query.listId ? [Number(req.query.listId)] : undefined } : req.body?.filter ?? {};
  return cleanFilter(raw);
}

router.post("/contacts/search", async (req, res) => {
  const userId = req.session.userId!;
  const f = filterFrom(req);
  const limit = Math.min(500, Number(req.body?.limit) || 100);
  const offset = Number(req.body?.offset) || 0;
  const where = and(...segmentConditions(userId, f));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(emailContactsTable).where(where).orderBy(desc(emailContactsTable.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(emailContactsTable).where(where),
  ]);
  res.json({ rows, total: Number(n), description: describeSegment(f) });
});

router.get("/contacts", async (req, res) => {
  const userId = req.session.userId!;
  const f = filterFrom(req);
  const limit = Math.min(500, Number(req.query["limit"]) || 100);
  const offset = Number(req.query["offset"]) || 0;
  const where = and(...segmentConditions(userId, f));
  const [rows, [{ n }]] = await Promise.all([
    db.select().from(emailContactsTable).where(where).orderBy(desc(emailContactsTable.createdAt)).limit(limit).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(emailContactsTable).where(where),
  ]);
  res.json({ rows, total: Number(n) });
});

router.post("/facets", async (req, res) => res.json(await facets(req.session.userId!, filterFrom(req))));

/** Sector for every contact that has none — or for all, when the rules have improved. */
router.post("/contacts/classify", async (req, res) => {
  const userId = req.session.userId!;
  const all = req.body?.all === true;
  const rows = await db.select({ id: emailContactsTable.id, company: emailContactsTable.company, industry: emailContactsTable.industry, source: emailContactsTable.source, sector: emailContactsTable.sector })
    .from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), all ? sql`true` : sql`${emailContactsTable.sector} is null`));
  // The list a contact is in says something too: "real-estate-companies-ALL".
  const lists = await db.select({ contactId: emailListMembersTable.contactId, name: emailListsTable.name }).from(emailListMembersTable)
    .innerJoin(emailListsTable, eq(emailListsTable.id, emailListMembersTable.listId)).where(eq(emailListsTable.userId, userId));
  const listOf = new Map<number, string>(); for (const l of lists) if (!listOf.has(l.contactId)) listOf.set(l.contactId, l.name);
  const bySector = new Map<string, number[]>();
  for (const r of rows) {
    const sector = classifySector({ industry: r.industry, company: r.company, hint: [listOf.get(r.id), r.source].filter(Boolean).join(" ") });
    if (!sector || sector === r.sector) continue;
    bySector.set(sector, [...(bySector.get(sector) ?? []), r.id]);
  }
  let updated = 0;
  for (const [sector, ids] of bySector) {
    for (let i = 0; i < ids.length; i += 1000) {
      await db.update(emailContactsTable).set({ sector }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
    }
    updated += ids.length;
  }
  res.json({ checked: rows.length, updated, bySector: Object.fromEntries([...bySector].map(([k, v]) => [k, v.length])) });
});

router.get("/sectors", (_req, res) => res.json({ sectors: SECTORS, unclassified: UNCLASSIFIED }));

/**
 * One action on many contacts: the ticked ones (`ids`) or everyone the
 * filter selects (`filter`). Add to a list, a new list, set the sector,
 * enrol in a sequence, stop or restart them.
 */
router.post("/contacts/bulk", async (req, res) => {
  const userId = req.session.userId!;
  const b: any = req.body ?? {};
  let ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number).filter(Boolean) : [];
  if (!ids.length && b.filter) ids = (await resolveSegment(userId, cleanFilter(b.filter))).map((c) => c.id);
  if (!ids.length) return res.status(400).json({ error: "لم تختر أحداً" });
  // Only this account's contacts, whatever was posted.
  ids = (await db.select({ id: emailContactsTable.id }).from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), inArray(emailContactsTable.id, ids)))).map((r) => r.id);

  const addTo = async (listId: number) => {
    for (let i = 0; i < ids.length; i += 1000) await db.insert(emailListMembersTable).values(ids.slice(i, i + 1000).map((contactId) => ({ listId, contactId }))).onConflictDoNothing();
  };
  switch (b.action) {
    case "addToList": {
      const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, Number(b.listId)), eq(emailListsTable.userId, userId))).limit(1);
      if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
      await addTo(l.id); return res.json({ done: ids.length, list: l });
    }
    case "newList": {
      const [l] = await db.insert(emailListsTable).values({ userId, name: String(b.name ?? "قائمة").slice(0, 160), description: b.description ?? null, folderId: Number(b.folderId) || null }).returning();
      await addTo(l!.id); return res.json({ done: ids.length, list: l });
    }
    case "setSector": {
      const sector = String(b.sector ?? "").trim().slice(0, 60) || null;
      for (let i = 0; i < ids.length; i += 1000) await db.update(emailContactsTable).set({ sector }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
      return res.json({ done: ids.length });
    }
    case "enrol": {
      try { await assertCanSend(userId); } catch (err) { if (planErrorToResponse(err, res)) return; throw err; }
      return res.json(await enrolInSequence(userId, Number(b.sequenceId), ids));
    }
    case "unsubscribe": case "activate": {
      const status = b.action === "activate" ? "active" : "unsubscribed";
      for (let i = 0; i < ids.length; i += 1000) await db.update(emailContactsTable).set({ status }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
      if (status !== "active") for (const id of ids) await cancelSequencesFor(userId, id, "أوقفه صاحب العمل");
      return res.json({ done: ids.length });
    }
    case "delete": return res.json(await deleteContacts(userId, ids));
  }
  res.status(400).json({ error: "إجراء غير معروف" });
});

// ── Segments ──────────────────────────────────────────────────────
router.get("/segments", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select().from(emailSegmentsTable).where(eq(emailSegmentsTable.userId, userId)).orderBy(desc(emailSegmentsTable.createdAt));
  res.json(await Promise.all(rows.map(async (sg) => ({ ...sg, description: describeSegment(sg.filter as any), count: await countSegment(userId, sg.filter as any), sendable: await countSegment(userId, sg.filter as any, true) }))));
});
router.post("/segments", async (req, res) => {
  const f = cleanFilter(req.body?.filter);
  const [row] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: String(req.body?.name ?? describeSegment(f)).slice(0, 160), filter: f }).returning();
  res.status(201).json(row);
});
router.delete("/segments/:id", async (req, res) => {
  await db.delete(emailSegmentsTable).where(and(eq(emailSegmentsTable.id, Number(req.params.id)), eq(emailSegmentsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── نورة ──────────────────────────────────────────────────────────
router.get("/agent", async (req, res) => {
  const userId = req.session.userId!;
  const agent = await ensureEmailAgent(userId);
  const mem = await agentMemory(userId);
  res.json({ agent, memory: mem, topics: [...new Set(mem.map((m) => m.topic).filter(Boolean))], sectors: SECTORS });
});
router.patch("/agent", async (req, res) => {
  const userId = req.session.userId!;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "title", "persona"] as const) if (typeof req.body?.[k] === "string") set[k] = req.body[k].slice(0, k === "persona" ? 3000 : 120);
  const [row] = await db.update(botEmployeesTable).set(set).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, EMAIL_ROLE))).returning();
  res.json(row ?? null);
});
/** Teach her: text in the owner's words, or a pasted document; she splits it into facts. */
router.post("/agent/teach", upload.single("file"), async (req, res) => {
  const userId = req.session.userId!;
  let text = String(req.body?.text ?? "");
  if (req.file) {
    const name = req.file.originalname.toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(name)) {
      const wb = XLSX.read(req.file.buffer, { type: "buffer" });
      text += "\n\n" + wb.SheetNames.map((n) => XLSX.utils.sheet_to_csv(wb.Sheets[n]!)).join("\n\n");
    } else {
      text += "\n\n" + req.file.buffer.toString("utf8");
    }
  }
  if (!text.trim()) return res.status(400).json({ error: "اكتب ما تريد أن تتعلمه أو ارفع ملفاً نصياً" });
  const topic = typeof req.body?.topic === "string" && req.body.topic.trim() ? req.body.topic.trim().slice(0, 80) : null;
  res.json({ saved: await teach(userId, text, topic) });
});
router.post("/agent/memory", async (req, res) => {
  const userId = req.session.userId!;
  await ensureEmailAgent(userId);
  const content = String(req.body?.content ?? "").trim();
  if (!content) return res.status(400).json({ error: "فارغ" });
  await rememberKnowledge(userId, content, req.body?.topic ? String(req.body.topic).slice(0, 80) : null);
  res.json({ ok: true });
});
router.patch("/agent/memory/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.content === "string") set["content"] = req.body.content.slice(0, 1500);
  if (req.body?.topic !== undefined) set["topic"] = req.body.topic ? String(req.body.topic).slice(0, 80) : null;
  const [row] = await db.update(agentMemoryTable).set(set).where(and(eq(agentMemoryTable.id, Number(req.params.id)), eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.role, EMAIL_ROLE))).returning();
  res.json(row ?? null);
});
router.delete("/agent/memory/:id", async (req, res) => {
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.id, Number(req.params.id)), eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.role, EMAIL_ROLE)));
  res.json({ ok: true });
});
/** She writes a campaign for the target the owner picked. Nothing is sent. */
router.post("/agent/write", async (req, res) => {
  const userId = req.session.userId!;
  const goal = String(req.body?.goal ?? "").trim();
  if (!goal) return res.status(400).json({ error: "اكتب الهدف" });
  const out = await writeCampaign(userId, { filter: cleanFilter(req.body?.filter), goal, language: req.body?.language, tone: req.body?.tone, notes: req.body?.notes });
  if (!out) return res.status(502).json({ error: "تعذّرت الكتابة — النموذج لم يستجب أو خرج عن الشكل. جرّب مرة أخرى." });
  res.json(out);
});
/** Turn an approved draft into a campaign (with the subject test) and its two follow-up sequences. */
router.post("/agent/launch", async (req, res) => {
  const userId = req.session.userId!;
  const d = req.body?.draft;
  if (!d?.subjects?.length || !d?.html) return res.status(400).json({ error: "المسودة ناقصة" });
  const m = await createMission(userId, { name: String(req.body?.name ?? d.subjects[0]).slice(0, 160), goal: String(req.body?.goal ?? ""), filter: cleanFilter(req.body?.filter), language: req.body?.language, tone: req.body?.tone, requireApproval: true, followAfterHours: req.body?.followAfterHours });
  await db.update(emailMissionsTable).set({ stage: "awaiting_approval", pending: d }).where(eq(emailMissionsTable.id, m.id));
  try { await assertCanSend(userId); await approveMission(userId, m.id, d); }
  catch (err: any) { if (planErrorToResponse(err, res)) return; return res.status(400).json({ error: String(err?.message ?? err), missionId: m.id }); }
  res.json({ missionId: m.id });
});

// ── Missions ──────────────────────────────────────────────────────
router.get("/missions", async (req, res) => res.json(await missionsFor(req.session.userId!)));
router.post("/missions", async (req, res) => {
  const userId = req.session.userId!;
  const b = req.body ?? {};
  if (!String(b.goal ?? "").trim()) return res.status(400).json({ error: "اكتب هدف المهمة" });
  const f = cleanFilter(b.filter);
  await ensureEmailAgent(userId);
  const m = await createMission(userId, { name: String(b.name || describeSegment(f)), goal: String(b.goal), filter: f, language: b.language, tone: b.tone, requireApproval: b.requireApproval !== false, followAfterHours: b.followAfterHours });
  // Write straight away rather than at the next sweep — the owner is watching.
  void runMission(m).catch(() => {});
  res.status(201).json(m);
});
router.post("/missions/:id/approve", async (req, res) => {
  try { await assertCanSend(req.session.userId!); await approveMission(req.session.userId!, Number(req.params.id), req.body?.draft); res.json({ ok: true }); }
  catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.post("/missions/:id/audience", async (req, res) => {
  try { await setMissionAudience(req.session.userId!, Number(req.params.id), cleanFilter(req.body?.filter)); res.json({ ok: true }); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.post("/missions/:id/redraft", async (req, res) => {
  const [m] = await db.update(emailMissionsTable).set({ stage: "draft", pending: null, goal: req.body?.goal ? String(req.body.goal).slice(0, 2000) : sql`${emailMissionsTable.goal}` as any })
    .where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!), inArray(emailMissionsTable.stage, ["draft", "awaiting_approval"]))).returning();
  if (!m) return res.status(400).json({ error: "المهمة بدأت الإرسال — لا يمكن إعادة كتابتها" });
  void runMission(m).catch(() => {});
  res.json({ ok: true });
});
for (const action of ["pause", "resume"] as const) {
  router.post(`/missions/:id/${action}`, async (req, res) => {
    await db.update(emailMissionsTable).set({ status: action === "pause" ? "paused" : "active" })
      .where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!)));
    res.json({ ok: true });
  });
}
router.post("/missions/:id/run", async (req, res) => {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!))).limit(1);
  if (!m) return res.status(404).json({ error: "غير موجودة" });
  await runMission(m); res.json({ ok: true });
});
router.get("/missions/:id/report", async (req, res) => {
  const [m] = await db.select().from(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!))).limit(1);
  if (!m) return res.status(404).json({ error: "غير موجودة" });
  res.json(m.report ?? await missionReport(m));
});
router.delete("/missions/:id", async (req, res) => {
  await db.delete(emailMissionsTable).where(and(eq(emailMissionsTable.id, Number(req.params.id)), eq(emailMissionsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Lists ─────────────────────────────────────────────────────────
// Each list with what is in it, in one query: how many, how many can be
// written to, how many unsubscribed or bounced, with a WhatsApp number,
// reached, opened, replied, its main sector and when it was last written to.
async function listStats(userId: number, listId?: number) {
  const r = await db.execute(sql`
    SELECT l.id, l.name, l.description, l.folder_id AS "folderId", l.created_at AS "createdAt", l.parent_list_id AS "parentListId", l.stage,
      count(c.id)::int AS count,
      (count(c.id) FILTER (WHERE c.status = 'active' AND coalesce(c.mx_ok, true)))::int AS sendable,
      (count(c.id) FILTER (WHERE c.status IN ('unsubscribed','complained')))::int AS unsubscribed,
      (count(c.id) FILTER (WHERE c.status = 'bounced' OR c.mx_ok = false))::int AS bounced,
      (count(c.id) FILTER (WHERE c.phone IS NOT NULL))::int AS "withPhone",
      (count(c.id) FILTER (WHERE c.last_sent_at IS NOT NULL))::int AS reached,
      (count(c.id) FILTER (WHERE c.last_opened_at IS NOT NULL))::int AS opened,
      (count(c.id) FILTER (WHERE c.last_replied_at IS NOT NULL))::int AS replied,
      mode() WITHIN GROUP (ORDER BY c.sector) AS sector,
      max(c.last_sent_at) AS "lastSentAt"
    FROM email_lists l
    LEFT JOIN email_list_members m ON m.list_id = l.id
    LEFT JOIN email_contacts c ON c.id = m.contact_id
    WHERE l.user_id = ${userId} ${listId ? sql`AND l.id = ${listId}` : sql``}
    GROUP BY l.id
    ORDER BY l.created_at DESC`);
  return r.rows as any[];
}

router.get("/lists", async (req, res) => res.json(await listStats(req.session.userId!)));

router.get("/lists/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [l] = await listStats(userId, Number(req.params.id));
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const f = { listIds: [l.id] };
  const [fac, campaigns] = await Promise.all([
    facets(userId, f),
    db.select({ id: emailCampaignsTable.id, name: emailCampaignsTable.name, status: emailCampaignsTable.status, sentCount: emailCampaignsTable.sentCount, openCount: emailCampaignsTable.openCount, replyCount: emailCampaignsTable.replyCount, createdAt: emailCampaignsTable.createdAt })
      .from(emailCampaignsTable).where(and(eq(emailCampaignsTable.userId, userId), eq(emailCampaignsTable.listId, l.id))).orderBy(desc(emailCampaignsTable.createdAt)).limit(10),
  ]);
  res.json({ list: l, facets: fac, campaigns });
});

router.post("/lists", async (req, res) => {
  const name = String(req.body?.name ?? "").trim().slice(0, 160);
  if (!name) return res.status(400).json({ error: "اكتب اسم القائمة" });
  const [l] = await db.insert(emailListsTable).values({ userId: req.session.userId!, name, description: req.body?.description ?? null, folderId: Number(req.body?.folderId) || null }).returning();
  res.status(201).json(l);
});

router.patch("/lists/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (typeof req.body?.name === "string" && req.body.name.trim()) set["name"] = req.body.name.trim().slice(0, 160);
  if (req.body?.description !== undefined) set["description"] = req.body.description ? String(req.body.description).slice(0, 500) : null;
  if (!Object.keys(set).length) return res.status(400).json({ error: "لا تغيير" });
  const [l] = await db.update(emailListsTable).set(set).where(and(eq(emailListsTable.id, Number(req.params.id)), eq(emailListsTable.userId, req.session.userId!))).returning();
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  res.json(l);
});

/** Take contacts out of a list; they stay in the audience and in other lists. */
router.post("/lists/:id/remove", async (req, res) => {
  const userId = req.session.userId!;
  const listId = Number(req.params.id);
  const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean);
  if (!ids.length) return res.status(400).json({ error: "لم تختر أحداً" });
  let removed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const r = await db.delete(emailListMembersTable).where(and(eq(emailListMembersTable.listId, listId), inArray(emailListMembersTable.contactId, ids.slice(i, i + 1000)))).returning({ id: emailListMembersTable.contactId });
    removed += r.length;
  }
  res.json({ removed });
});

/** The list as a CSV the owner can open in Excel. */
router.get("/lists/:id/export", async (req, res) => {
  const userId = req.session.userId!;
  const listId = Number(req.params.id);
  const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
  if (!l) return res.status(404).json({ error: "القائمة غير موجودة" });
  const rows = await db.select({ c: emailContactsTable }).from(emailListMembersTable)
    .innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
    .where(eq(emailListMembersTable.listId, listId)).orderBy(emailContactsTable.company);
  const cell = (v: unknown) => { const t = v === null || v === undefined ? "" : String(v instanceof Date ? v.toISOString().slice(0, 10) : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ["email", "company", "name", "phone", "sector", "city", "status", "last_sent", "last_opened", "last_replied"];
  const body = rows.map(({ c }) => [c.email, c.company, c.name, c.phone, c.sector, c.city, c.status, c.lastSentAt, c.lastOpenedAt, c.lastRepliedAt].map(cell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(l.name)}.csv`);
  res.send("\uFEFF" + [head.join(","), ...body].join("\n"));
});
/** A list goes; with `?contacts=1` its addresses go too (those in no other list). */
router.delete("/lists/:id", async (req, res) => {
  const r = await deleteList(req.session.userId!, Number(req.params.id), req.query["contacts"] === "1");
  if (!r) return res.status(404).json({ error: "القائمة غير موجودة" });
  res.json(r);
});

/**
 * The import. A spreadsheet as it came (multipart `file`) or rows already
 * parsed by the browser (`rows`), and options: which list, whether to
 * split by industry or city into sub-lists, whether to check MX, and which
 * sequence to enrol everyone in. Reports exactly what was kept and why
 * the rest was not.
 */
router.post("/contacts/import", upload.single("file"), async (req, res) => {
  const userId = req.session.userId!;
  const body: any = req.body ?? {};
  let rawRows: Array<Record<string, unknown>> = [];
  let fileName = "";
  const country = String(body.country ?? "AE").toUpperCase().slice(0, 2);
  // Rows the shared reader found, for the WhatsApp half: every sheet, the
  // header row wherever it is, every number column, each row's country.
  let parsed: ReturnType<typeof parseTables> | null = null;
  if (req.file) {
    fileName = req.file.originalname;
    try { parsed = parseTables(readWorkbook(req.file.buffer), country); }
    catch { return res.status(400).json({ error: "تعذّر قراءة الملف — تأكد أنه Excel أو CSV" }); }
    // One row per address, not per line of the file. A company with "Email"
    // and "Email 2", or two addresses in one cell, used to contribute exactly
    // one — the reader kept only the first match. Each address carries its own
    // company, which is the pairing the owner actually wants; only the first
    // keeps the person's name, since a second address on the same line belongs
    // to the company rather than to that person.
    rawRows = parsed.rows.flatMap((r) => {
      const found = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
      const common = { name: "", company: r.company ?? "", phone: r.whatsapp?.e164 ?? "", industry: r.industry ?? "", city: r.city ?? "" };
      if (!found.length) return [{ email: "", ...common, name: r.person ?? "" }];
      return found.map((email, i) => ({ ...common, email, name: i === 0 ? (r.person ?? "") : "" }));
    });
  } else if (Array.isArray(body.rows)) {
    rawRows = body.rows;
  } else if (typeof body.rows === "string") {
    try { rawRows = JSON.parse(body.rows); } catch { rawRows = []; }
  } else if (typeof body.text === "string") {
    // Pasted emails, one per line or comma-separated.
    rawRows = String(body.text).split(/[\n,;\s]+/).filter(Boolean).map((email) => ({ email }));
  }
  if (!rawRows.length) return res.status(400).json({ error: "لم أجد صفوفاً في الملف" });

  const columns = parsed
    ? { email: "email", name: "name", company: "company", phone: "phone", industry: "industry", city: "city" } as ReturnType<typeof detectColumns>
    : detectColumns(rawRows);
  const hasEmails = parsed ? parsed.rows.some((r) => r.email) : !!columns.email;
  const waOnly = parsed ? whatsappEntries(parsed.rows).entries.length : 0;
  if (!hasEmails && !waOnly) return res.status(400).json({ error: "لم أجد بريداً إلكترونياً ولا أرقام واتساب في الملف", columns });
  const report = cleanRows(rawRows, columns);

  // MX per domain, so a dead domain never costs a bounce.
  const doMx = body.mx !== "false" && body.mx !== false;
  let mxBad = 0;
  if (doMx && report.rows.length) {
    const mx = await checkMx(report.rows.map((r) => r.email.split("@")[1]!));
    for (const r of report.rows) (r as any).mxOk = mx.get(r.email.split("@")[1]!) ?? null;
    mxBad = report.rows.filter((r) => (r as any).mxOk === false).length;
  }

  // Rows with a phone and no address. They used to be counted invalid and
  // dropped; a directory export is full of them and they are still companies
  // this business can reach — just through the other door.
  const phoneOnly = report.phoneOnly ?? [];

  const sectorOverride = typeof body.sector === "string" && body.sector.trim() ? body.sector.trim().slice(0, 60) : null;
  const listNameHint = String(body.listName ?? "");

  // Upsert the contacts; existing ones keep their status.
  const source = (body.source ?? (fileName ? `ملف: ${fileName.slice(0, 50)}` : "استيراد")).slice(0, 60);
  let inserted = 0;
  const ids = new Map<string, number>();
  for (let i = 0; i < report.rows.length; i += 200) {
    const chunk = report.rows.slice(i, i + 200);
    const rows = await db.insert(emailContactsTable).values(chunk.map((r) => ({
      userId, email: r.email, name: r.name ?? null, company: r.company ?? null, phone: r.phone ?? null,
      industry: r.industry ?? null, city: r.city ?? null, source, mxOk: (r as any).mxOk ?? null,
      // The owner's word for the whole file wins; otherwise the row's own
      // activity or name, and the file's name as a last hint.
      sector: sectorOverride || classifySector({ industry: r.industry, company: r.company, hint: fileName || listNameHint }),
    }))).onConflictDoNothing().returning({ id: emailContactsTable.id, email: emailContactsTable.email });
    inserted += rows.length;
    for (const r of rows) ids.set(r.email, r.id);
  }
  const existing = await db.select({ id: emailContactsTable.id, email: emailContactsTable.email, status: emailContactsTable.status }).from(emailContactsTable)
    .where(and(eq(emailContactsTable.userId, userId), inArray(emailContactsTable.email, report.rows.map((r) => r.email))));
  for (const r of existing) ids.set(r.email, r.id);
  const activeIds = existing.filter((r) => r.status === "active").map((r) => r.id);

  // The list, and the split.
  const listName = String(body.listName ?? (fileName ? fileName.replace(/\.[a-z]+$/i, "") : `استيراد ${new Date().toISOString().slice(0, 10)}`)).slice(0, 160);
  let listId = Number(body.listId) || null;
  let reused: string | null = null;
  let folder: { id: number; name: string } | null = null;
  if (listId) {
    const [own] = await db.select({ id: emailListsTable.id }).from(emailListsTable).where(and(eq(emailListsTable.id, listId), eq(emailListsTable.userId, userId))).limit(1);
    if (!own) return res.status(404).json({ error: "القائمة غير موجودة" });
  } else {
    // The same file again tops up the list it made before, rather than a
    // second list with the same name beside it.
    const [same] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.userId, userId), eq(emailListsTable.name, listName))).limit(1);
    if (same) { listId = same.id; reused = same.name; }
    else {
      // A new list goes into the folder chosen, or its sector's folder — the
      // owner's own folder when one reads as that sector.
      const folderId = Number(body.folderId) || null;
      folder = folderId ? { id: folderId, name: "" } : await folderForSector(userId, "email", sectorOverride ?? listSector(listName, fileName, report.rows.slice(0, 300).map((r) => r.company))).catch(() => null);
      const [l] = await db.insert(emailListsTable).values({ userId, name: listName, description: source, folderId: folder?.id ?? null }).returning();
      listId = l!.id;
    }
  }
  const addAll = async (lid: number, rows: ImportRow[]) => {
    const members = rows.map((r) => ids.get(r.email)).filter((x): x is number => !!x);
    for (let i = 0; i < members.length; i += 500) {
      await db.insert(emailListMembersTable).values(members.slice(i, i + 500).map((contactId) => ({ listId: lid, contactId }))).onConflictDoNothing();
    }
  };
  await addAll(listId, report.rows);

  const splitField = body.splitBy === "industry" || body.splitBy === "city" ? body.splitBy : null;
  const subLists: Array<{ id: number; name: string; count: number }> = [];
  if (splitField) {
    // The sub-lists sit in the same folder as the list they came from.
    const [parent] = await db.select({ folderId: emailListsTable.folderId }).from(emailListsTable).where(eq(emailListsTable.id, listId)).limit(1);
    for (const [k, rows] of splitBy(report.rows, splitField)) {
      const [l] = await db.insert(emailListsTable).values({ userId, name: `${listName} — ${k}`.slice(0, 160), description: `فرع من «${listName}» حسب ${splitField === "industry" ? "النشاط" : "المدينة"}`, folderId: parent?.folderId ?? null }).returning();
      await addAll(l!.id, rows);
      subLists.push({ id: l!.id, name: l!.name, count: rows.length });
    }
  }

  // Straight into the ladder, if asked.
  let enrolled = null as null | { enrolled: number; skipped: number };
  const sequenceId = Number(body.sequenceId) || null;
  if (sequenceId) enrolled = await enrolInSequence(userId, sequenceId, activeIds).catch((err) => { logger.warn({ err: String(err?.message ?? err) }, "enrol after import failed"); return null; });

  // The WhatsApp half. Every row with a WhatsApp number — including rows
  // with no email at all — goes into a number list named after this one,
  // under the company's name, so the same file feeds both channels.
  let whatsapp: null | { added: number; alreadyInList: number; duplicates: number; skippedLandline: number; groups: Array<{ id: number; name: string; count: number }>; verifying: boolean; error?: string } = null;
  if (parsed && body.saveWhatsapp !== "false" && body.saveWhatsapp !== false) {
    const wa = whatsappEntries(parsed.rows);
    if (wa.entries.length) {
      try {
        await assertCanAddContacts(userId, wa.entries.length);
        const waFolder = await folderForSector(userId, "wa", sectorOverride ?? listSector(listName, fileName, parsed.rows.slice(0, 300).map((r) => r.company))).catch(() => null);
        const saved = await saveToNewGroup(userId, `${listName} — واتساب`, `أرقام واتساب من ملف البريد${fileName ? `: ${fileName.slice(0, 80)}` : ""}`, wa.entries, { folderId: waFolder?.id ?? null });
        const verifying = validateInBackground(userId, saved.groups.map((g) => g.id));
        whatsapp = { added: saved.added, alreadyInList: saved.existing + saved.inOtherLists, duplicates: wa.duplicates, skippedLandline: wa.skippedLandline, groups: saved.groups, verifying };
      } catch (err: any) {
        whatsapp = { added: 0, alreadyInList: 0, duplicates: wa.duplicates, skippedLandline: wa.skippedLandline, groups: [], verifying: false, error: String(err?.message ?? err) };
      }
    }
  }

  logger.info({ userId, file: fileName, total: report.total, kept: report.kept, inserted, mxBad, listId, sub: subLists.length, enrolled, whatsapp: whatsapp?.added ?? 0 }, "استيراد بريد");
  res.json({
    file: fileName || null, columns, total: report.total, kept: report.kept, inserted, alreadyKnown: report.kept - inserted,
    invalid: report.invalid, duplicates: report.duplicates, roleAddresses: report.roleAddresses, mxBad,
    // What the owner could not see before: addresses beyond the first on a
    // line, and the companies that have a phone but no address at all.
    extraAddresses: report.extraAddresses ?? 0,
    phoneOnly: phoneOnly.length,
    phoneOnlySample: phoneOnly.slice(0, 5),
    list: { id: listId, name: listName }, addedTo: reused, folder: folder?.name || null, subLists, enrolled, sample: report.sample,
    whatsapp, sheets: parsed?.sheets ?? null, byCountry: parsed?.byCountry ?? null,
  });
});

/** What the file looks like before committing to it. */
router.post("/contacts/preview", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "ارفع ملفاً" });
  const country = String(req.body?.country ?? "AE").toUpperCase().slice(0, 2);
  let parsed: ReturnType<typeof parseTables>;
  try { parsed = parseTables(readWorkbook(req.file.buffer), country); }
  catch { return res.status(400).json({ error: "تعذّر قراءة الملف — تأكد أنه Excel أو CSV" }); }
  const rows = parsed.rows.map((r) => ({ email: r.email ?? "", name: r.person ?? "", company: r.company ?? "", phone: r.whatsapp?.e164 ?? "", industry: r.industry ?? "", city: r.city ?? "" }));
  const columns = { email: "email", name: "name", company: "company", phone: "phone", industry: "industry", city: "city" } as ReturnType<typeof detectColumns>;
  const report = cleanRows(rows, columns);
  const wa = whatsappEntries(parsed.rows);
  // The columns as found in the file, for the owner to check.
  const found = parsed.sheets[0]?.columns ?? {};
  const shown = { email: found["email"] ?? null, company: found["company"] ?? null, name: found["person"] ?? null, phone: found["phones"] ?? null, industry: found["industry"] ?? null, city: found["city"] ?? null };
  const byIndustry = [...splitBy(report.rows, "industry")].map(([k, v]) => ({ key: k, n: v.length })).sort((a, b) => b.n - a.n).slice(0, 20);
  const byCity = [...splitBy(report.rows, "city")].map(([k, v]) => ({ key: k, n: v.length })).sort((a, b) => b.n - a.n).slice(0, 20);
  res.json({ file: req.file.originalname, sheets: parsed.sheets, columns: shown, total: report.total, kept: report.kept, invalid: report.invalid, duplicates: report.duplicates, roleAddresses: report.roleAddresses, sample: report.sample, byIndustry, byCity,
    whatsapp: { numbers: wa.entries.length, landlineOnly: parsed.landlineOnly, duplicates: wa.duplicates, withoutEmail: parsed.rows.filter((r) => r.whatsapp && !r.email).length, byCountry: parsed.byCountry } });
});

router.patch("/contacts/:id", async (req, res) => {
  const userId = req.session.userId!;
  const set: Record<string, unknown> = {};
  for (const k of ["name", "company", "phone", "industry", "city", "status"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  const [row] = await db.update(emailContactsTable).set(set).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, userId))).returning();
  if (row && set["status"] && set["status"] !== "active") await cancelSequencesFor(userId, row.id, "أوقفه صاحب العمل");
  res.json(row ?? null);
});
router.delete("/contacts/:id", async (req, res) => {
  await db.delete(emailContactsTable).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.get("/contacts/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailContactsTable).where(and(eq(emailContactsTable.id, Number(req.params.id)), eq(emailContactsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "غير موجود" });
  const [messages, inbound, jobs] = await Promise.all([
    db.select().from(emailMessagesTable).where(eq(emailMessagesTable.contactId, c.id)).orderBy(desc(emailMessagesTable.createdAt)).limit(30),
    db.select().from(emailInboundTable).where(eq(emailInboundTable.contactId, c.id)).orderBy(desc(emailInboundTable.receivedAt)).limit(30),
    db.select().from(emailSequenceJobsTable).where(eq(emailSequenceJobsTable.contactId, c.id)).orderBy(emailSequenceJobsTable.dueAt),
  ]);
  res.json({ contact: c, messages, inbound, jobs });
});

// ── Templates ─────────────────────────────────────────────────────
router.get("/templates", async (req, res) => res.json(await db.select().from(emailTemplatesTable).where(eq(emailTemplatesTable.userId, req.session.userId!)).orderBy(desc(emailTemplatesTable.updatedAt))));
router.post("/templates", async (req, res) => {
  const { name, subject, html, category } = req.body ?? {};
  if (!name || !subject || !html) return res.status(400).json({ error: "الاسم والعنوان والمحتوى مطلوبة" });
  const [t] = await db.insert(emailTemplatesTable).values({ userId: req.session.userId!, name: String(name).slice(0, 160), subject: String(subject).slice(0, 300), html: String(html), category: category ?? null }).returning();
  res.status(201).json(t);
});
router.patch("/templates/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["name", "subject", "html", "category"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  const [t] = await db.update(emailTemplatesTable).set(set).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, req.session.userId!))).returning();
  res.json(t ?? null);
});
router.delete("/templates/:id", async (req, res) => {
  await db.delete(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
/** A template rendered as it will arrive, with sample names — the gallery shows it in a frame. */
router.get("/templates/:id/render", async (req, res) => {
  const userId = req.session.userId!;
  const [t] = await db.select().from(emailTemplatesTable).where(and(eq(emailTemplatesTable.id, Number(req.params.id)), eq(emailTemplatesTable.userId, userId))).limit(1);
  if (!t) return res.status(404).send("not found");
  const s = await getSettings(userId);
  const en = directionOf(t.html) === "ltr";
  const vars = en ? { name: "Khalid Al Ali", first_name: "Khalid", company: "Al Noor Real Estate", city: "Dubai" } : { name: "خالد العلي", first_name: "خالد", company: "شركة النور العقارية", city: "دبي" };
  const r = renderEmail(t.html + (s?.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), { ...vars, sender: s?.fromName ?? "" },
    { base: "", token: "preview", secret: "x", pixel: false, links: false },
    { base: "", token: "preview", fromName: s?.fromName ?? "", fromEmail: s?.fromEmail ?? "" }, brandOf(s));
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(r.html);
});
router.post("/templates/seed", async (req, res) => res.json(await seedEmailDefaults(req.session.userId!, true)));
router.post("/preview", async (req, res) => {
  const s = await getSettings(req.session.userId!);
  // Sample names in the message's own language, so an English email previews with an English company.
  const en = directionOf(String(req.body?.html ?? "")) === "ltr";
  const vars = en
    ? { name: "Khalid Al Ali", first_name: "Khalid", company: "Al Noor Real Estate", city: "Dubai", industry: "Real Estate", sender: s?.fromName ?? "Pro Count", sender_email: s?.fromEmail ?? "" }
    : { name: "خالد العلي", first_name: "خالد", company: "شركة النور للمقاولات", city: "دبي", industry: "مقاولات", sender: s?.fromName ?? "بروكاونت", sender_email: s?.fromEmail ?? "" };
  const r = renderEmail(String(req.body?.html ?? "") + (s?.signature ? `<div style="margin-top:20px">${s.signature}</div>` : ""), vars,
    { base: "", token: "preview", secret: "x", pixel: false, links: false },
    { base: "", token: "preview", fromName: s?.fromName ?? "بروكاونت", fromEmail: s?.fromEmail ?? "hello@example.com" }, brandOf(s));
  res.json({ subject: personalize(String(req.body?.subject ?? ""), vars), html: r.html, text: r.text });
});

// ── Campaigns ─────────────────────────────────────────────────────
router.get("/campaigns", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select({ c: emailCampaignsTable, list: sql<string | null>`coalesce(${emailListsTable.name}, ${emailSegmentsTable.name})`, filter: emailSegmentsTable.filter,
    queued: sql<number>`(select count(*) from email_messages m where m.campaign_id = ${emailCampaignsTable.id} and m.status in ('queued','ab_hold'))`,
    members: sql<number>`(select count(*) from email_list_members m join email_contacts c on c.id = m.contact_id where m.list_id = ${emailCampaignsTable.listId} and c.status = 'active' and coalesce(c.mx_ok, true))` }).from(emailCampaignsTable)
    .leftJoin(emailListsTable, eq(emailListsTable.id, emailCampaignsTable.listId))
    .leftJoin(emailSegmentsTable, eq(emailSegmentsTable.id, emailCampaignsTable.segmentId))
    .where(eq(emailCampaignsTable.userId, userId)).orderBy(desc(emailCampaignsTable.createdAt));
  // Who it will reach: a list's writable members, or a saved audience counted now.
  res.json(await Promise.all(rows.map(async (r) => ({ ...r.c, listName: r.list, queued: Number(r.queued),
    audience: r.c.segmentId ? await countSegment(userId, (r.filter ?? {}) as any, true) : Number(r.members) }))));
});
router.post("/campaigns", async (req, res) => {
  const { name, listId, subject, html, scheduledAt, subjectB, abPct, abWaitHours } = req.body ?? {};
  if (!name || !subject || !html) return res.status(400).json({ error: "الاسم والعنوان والمحتوى مطلوبة" });
  // A saved segment, or a filter picked on the spot (saved as a segment).
  let segmentId = Number(req.body?.segmentId) || null;
  // A folder: every list in it, resolved when the campaign starts.
  const folderId = Number(req.body?.folderId) || null;
  if (!segmentId && folderId && !listId) {
    const [fo] = await db.select().from(listFoldersTable).where(and(eq(listFoldersTable.id, folderId), eq(listFoldersTable.userId, req.session.userId!), eq(listFoldersTable.kind, "email"))).limit(1);
    if (!fo) return res.status(404).json({ error: "المجلد غير موجود" });
    const [sg] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: `مجلد ${fo.name}`.slice(0, 160), filter: { folderIds: [fo.id] } }).returning();
    segmentId = sg!.id;
  }
  if (!segmentId && req.body?.filter && !listId) {
    const f = cleanFilter(req.body.filter);
    const [sg] = await db.insert(emailSegmentsTable).values({ userId: req.session.userId!, name: `${String(name).slice(0, 100)} — ${describeSegment(f)}`.slice(0, 160), filter: f }).returning();
    segmentId = sg!.id;
  }
  const [c] = await db.insert(emailCampaignsTable).values({
    userId: req.session.userId!, name: String(name).slice(0, 160), listId: Number(listId) || null, segmentId, subject: String(subject).slice(0, 300), html: String(html),
    status: scheduledAt ? "scheduled" : "draft", scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    subjectB: subjectB ? String(subjectB).slice(0, 300) : null,
    abPct: subjectB ? Math.min(50, Math.max(0, Number(abPct) || 20)) : 0,
    abWaitHours: Math.min(48, Math.max(1, Number(abWaitHours) || 4)),
  }).returning();
  res.status(201).json(c);
});
router.patch("/campaigns/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  for (const k of ["name", "subject", "html", "subjectB"] as const) if (req.body?.[k] !== undefined) set[k] = req.body[k];
  if (req.body?.abPct !== undefined) set["abPct"] = Math.min(50, Math.max(0, Number(req.body.abPct) || 0));
  if (req.body?.abWaitHours !== undefined) set["abWaitHours"] = Math.min(48, Math.max(1, Number(req.body.abWaitHours) || 4));
  if (req.body?.listId !== undefined) set["listId"] = Number(req.body.listId) || null;
  if (req.body?.scheduledAt !== undefined) { set["scheduledAt"] = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null; set["status"] = req.body.scheduledAt ? "scheduled" : "draft"; }
  const [c] = await db.update(emailCampaignsTable).set(set).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, req.session.userId!), inArray(emailCampaignsTable.status, ["draft", "scheduled", "paused"]))).returning();
  res.json(c ?? null);
});
router.post("/campaigns/:id/start", async (req, res) => {
  try {
    await assertCanSend(req.session.userId!);
    res.json(await startCampaign(req.session.userId!, Number(req.params.id)));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
/** The campaign as it will arrive, sent to the owner's own address (or `to`) — personalised for the first contact in its audience. */
router.post("/campaigns/:id/test", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  const s = await getSettings(userId);
  if (!isConfigured(s)) return res.status(400).json({ error: "إعدادات البريد غير مكتملة — اضبط المُرسِل أولاً" });
  const to = String(req.body?.to ?? s!.fromEmail).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: "بريد الاستلام غير صالح" });
  const vars = { name: "خالد العلي", first_name: "خالد", company: "شركة النور للمقاولات", city: "دبي", industry: "", sender: s!.fromName ?? s!.fromEmail!, sender_email: s!.fromEmail! };
  const token = newToken();
  const r = renderEmail(c.html + (s!.signature ? `<div style="margin-top:20px">${s!.signature}</div>` : ""), vars,
    { base: "", token, secret: "x", pixel: false, links: false },
    { base: "", token, fromName: s!.fromName ?? s!.fromEmail!, fromEmail: s!.fromEmail! }, brandOf(s));
  try {
    await sendEmail(s!, { to, subject: `[تجربة] ${personalize(c.subject, vars)}`, html: r.html, text: r.text, messageId: messageIdFor(token, s!.fromEmail!), unsubscribeUrl: null });
    res.json({ ok: true, to });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A copy of a campaign as a new draft — same audience, same content, nothing sent. */
router.post("/campaigns/:id/duplicate", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "الحملة غير موجودة" });
  const [d] = await db.insert(emailCampaignsTable).values({ userId, name: `${c.name} (نسخة)`.slice(0, 160), listId: c.listId, segmentId: c.segmentId, subject: c.subject, html: c.html, subjectB: c.subjectB, abPct: c.abPct, abWaitHours: c.abWaitHours, status: "draft" }).returning();
  res.status(201).json(d);
});

router.post("/campaigns/:id/pause", async (req, res) => { await pauseCampaign(req.session.userId!, Number(req.params.id), "إيقاف يدوي"); res.json({ ok: true }); });
router.delete("/campaigns/:id", async (req, res) => {
  await db.delete(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.get("/campaigns/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [c] = await db.select().from(emailCampaignsTable).where(and(eq(emailCampaignsTable.id, Number(req.params.id)), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return res.status(404).json({ error: "غير موجود" });
  const [recipients, [funnel], byHour] = await Promise.all([
    db.select({ m: emailMessagesTable, name: emailContactsTable.name, company: emailContactsTable.company }).from(emailMessagesTable)
      .leftJoin(emailContactsTable, eq(emailContactsTable.id, emailMessagesTable.contactId))
      .where(eq(emailMessagesTable.campaignId, c.id)).orderBy(desc(emailMessagesTable.sentAt)).limit(2000),
    db.select({
      queued: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('queued','ab_hold'))`,
      held:   sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'ab_hold')`,
      sent: sql<number>`count(*) filter (where ${emailMessagesTable.status} in ('sent','bounced'))`,
      opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
      clicked: sql<number>`count(*) filter (where ${emailMessagesTable.clickedAt} is not null)`,
      replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
      bounced: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'bounced')`,
      failed: sql<number>`count(*) filter (where ${emailMessagesTable.status} = 'failed')`,
    }).from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, c.id)),
    db.select({ h: sql<string>`to_char(date_trunc('hour', ${emailEventsTable.createdAt}), 'YYYY-MM-DD HH24:00')`, type: emailEventsTable.type, n: sql<number>`count(*)` })
      .from(emailEventsTable).innerJoin(emailMessagesTable, eq(emailMessagesTable.id, emailEventsTable.messageId))
      .where(eq(emailMessagesTable.campaignId, c.id)).groupBy(sql`1`, emailEventsTable.type).orderBy(sql`1`),
  ]);
  const variants = c.abPct > 0 ? await db.select({
    v: emailMessagesTable.variant,
    sent: sql<number>`count(*) filter (where ${emailMessagesTable.sentAt} is not null)`,
    opened: sql<number>`count(*) filter (where ${emailMessagesTable.openedAt} is not null)`,
    replied: sql<number>`count(*) filter (where ${emailMessagesTable.repliedAt} is not null)`,
  }).from(emailMessagesTable).where(and(eq(emailMessagesTable.campaignId, c.id), sql`${emailMessagesTable.variant} is not null`, sql`${emailMessagesTable.createdAt} <= coalesce(${c.abDecidedAt ?? null}::timestamptz, now())`))
    .groupBy(emailMessagesTable.variant) : [];
  res.json({ campaign: c, funnel: Object.fromEntries(Object.entries(funnel ?? {}).map(([k, v]) => [k, Number(v)])),
    ab: c.abPct > 0 ? { winner: c.abWinner, decidedAt: c.abDecidedAt, variants: variants.map((x) => ({ variant: x.v, sent: Number(x.sent), opened: Number(x.opened), replied: Number(x.replied) })) } : null,
    recipients: recipients.map((r) => ({ ...r.m, name: r.name, company: r.company })), timeline: byHour.map((r) => ({ hour: r.h, type: r.type, n: Number(r.n) })) });
});

// ── Sequences ─────────────────────────────────────────────────────
router.get("/sequences", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db.select({
    s: emailSequencesTable,
    pending: sql<number>`(select count(*) from email_sequence_jobs j where j.sequence_id = ${emailSequencesTable.id} and j.status = 'pending')`,
    sent: sql<number>`(select count(*) from email_sequence_jobs j where j.sequence_id = ${emailSequencesTable.id} and j.status = 'sent')`,
  }).from(emailSequencesTable).where(eq(emailSequencesTable.userId, userId)).orderBy(desc(emailSequencesTable.createdAt));
  res.json(rows.map((r) => ({ ...r.s, pending: Number(r.pending), sent: Number(r.sent), isDefault: r.s.name === DEFAULT_SEQUENCE_NAME })));
});
router.post("/sequences", async (req, res) => {
  const { name, steps, stopOnReply, stopOnOpen } = req.body ?? {};
  if (!name || !Array.isArray(steps) || !steps.length) return res.status(400).json({ error: "الاسم وخطوة واحدة على الأقل" });
  const clean: EmailStep[] = steps.map((s: any) => ({ afterHours: Math.max(0, Number(s.afterHours) || 0), subject: String(s.subject ?? "").slice(0, 300), html: String(s.html ?? "") })).filter((s: EmailStep) => s.subject && s.html);
  const [row] = await db.insert(emailSequencesTable).values({ userId: req.session.userId!, name: String(name).slice(0, 160), steps: clean, stopOnReply: stopOnReply !== false, stopOnOpen: !!stopOnOpen }).returning();
  res.status(201).json(row);
});
router.patch("/sequences/:id", async (req, res) => {
  const set: Record<string, unknown> = {};
  if (req.body?.name !== undefined) set["name"] = String(req.body.name).slice(0, 160);
  if (Array.isArray(req.body?.steps)) set["steps"] = req.body.steps.map((s: any) => ({ afterHours: Math.max(0, Number(s.afterHours) || 0), subject: String(s.subject ?? "").slice(0, 300), html: String(s.html ?? "") }));
  for (const k of ["stopOnReply", "stopOnOpen", "isActive"] as const) if (req.body?.[k] !== undefined) set[k] = !!req.body[k];
  const [row] = await db.update(emailSequencesTable).set(set).where(and(eq(emailSequencesTable.id, Number(req.params.id)), eq(emailSequencesTable.userId, req.session.userId!))).returning();
  res.json(row ?? null);
});
router.delete("/sequences/:id", async (req, res) => {
  await db.delete(emailSequencesTable).where(and(eq(emailSequencesTable.id, Number(req.params.id)), eq(emailSequencesTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.post("/sequences/:id/enrol", async (req, res) => {
  const userId = req.session.userId!;
  try {
    await assertCanSend(userId);
    let ids: number[] = Array.isArray(req.body?.contactIds) ? req.body.contactIds.map(Number).filter(Boolean) : [];
    if (req.body?.listId) {
      const members = await db.select({ id: emailListMembersTable.contactId }).from(emailListMembersTable).where(eq(emailListMembersTable.listId, Number(req.body.listId)));
      ids = members.map((m) => m.id);
    } else if (req.body?.filter) {
      ids = (await resolveSegment(userId, cleanFilter(req.body.filter), { sendable: true })).map((c) => c.id);
    }
    res.json(await enrolInSequence(userId, Number(req.params.id), ids));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
router.get("/sequences/:id/jobs", async (req, res) => {
  const rows = await db.select({ j: emailSequenceJobsTable, email: emailContactsTable.email, company: emailContactsTable.company })
    .from(emailSequenceJobsTable).leftJoin(emailContactsTable, eq(emailContactsTable.id, emailSequenceJobsTable.contactId))
    .where(and(eq(emailSequenceJobsTable.sequenceId, Number(req.params.id)), eq(emailSequenceJobsTable.userId, req.session.userId!)))
    .orderBy(emailSequenceJobsTable.dueAt).limit(500);
  res.json(rows.map((r) => ({ ...r.j, email: r.email, company: r.company })));
});

// ── Inbound ───────────────────────────────────────────────────────
router.get("/inbound", async (req, res) => {
  const rows = await db.select({ i: emailInboundTable, company: emailContactsTable.company, ourSubject: emailMessagesTable.subject })
    .from(emailInboundTable).leftJoin(emailContactsTable, eq(emailContactsTable.id, emailInboundTable.contactId))
    .leftJoin(emailMessagesTable, eq(emailMessagesTable.id, emailInboundTable.messageId))
    .where(eq(emailInboundTable.userId, req.session.userId!)).orderBy(desc(emailInboundTable.receivedAt)).limit(200);
  res.json(rows.map((r) => ({ ...r.i, company: r.company, ourSubject: r.ourSubject })));
});
router.post("/inbound/:id/draft", async (req, res) => {
  const d = await draftReply(req.session.userId!, Number(req.params.id));
  if (!d) return res.status(400).json({ error: "تعذّرت المسودة — النموذج لم يستجب" });
  res.json(d);
});
router.post("/inbound/:id/send", async (req, res) => {
  try {
    await assertCanSend(req.session.userId!);
    res.json(await sendReply(req.session.userId!, Number(req.params.id), req.body?.subject, req.body?.body));
  } catch (err: any) { if (planErrorToResponse(err, res)) return; res.status(400).json({ error: String(err?.message ?? err) }); }
});
/** Stop an automatic send without ignoring the reply. */
router.post("/inbound/:id/hold", async (req, res) => {
  await db.update(emailInboundTable).set({ autoSendAt: null }).where(and(eq(emailInboundTable.id, Number(req.params.id)), eq(emailInboundTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
router.post("/inbound/:id/ignore", async (req, res) => {
  await db.update(emailInboundTable).set({ state: "ignored", autoSendAt: null }).where(and(eq(emailInboundTable.id, Number(req.params.id)), eq(emailInboundTable.userId, req.session.userId!)));
  res.json({ ok: true });
});
/** Paste a reply that arrived elsewhere, so it is analysed like the rest. */
router.post("/inbound/manual", async (req, res) => {
  const { from, subject, text } = req.body ?? {};
  if (!from || !text) return res.status(400).json({ error: "المُرسِل والنص مطلوبان" });
  const { handleInbound } = await import("../lib/email/inbound");
  res.json(await handleInbound(req.session.userId!, { from: String(from), subject: subject ?? null, text: String(text) }));
});

// The counters, from events, for a message.
router.get("/messages/:id/events", async (req, res) => {
  const rows = await db.select().from(emailEventsTable).where(and(eq(emailEventsTable.messageId, Number(req.params.id)), eq(emailEventsTable.userId, req.session.userId!))).orderBy(emailEventsTable.createdAt);
  res.json(rows);
});
router.post("/messages/:id/event", async (req, res) => {
  // A bounce or complaint the owner saw in their mailbox and wants recorded.
  const type = String(req.body?.type ?? "");
  if (!["bounce", "complaint", "unsubscribe", "reply"].includes(type)) return res.status(400).json({ error: "نوع غير معروف" });
  await recordEvent(req.session.userId!, Number(req.params.id), type as any, { meta: { manual: true } });
  res.json({ ok: true });
});

// ── Knowledge: what the owner uploads about the company and its field ──
// Files arrive with their names in latin1 (multer); an Arabic name is put back.
const fileNameOf = (f: Express.Multer.File) => { const n = Buffer.from(f.originalname, "latin1").toString("utf8"); return n.includes("\uFFFD") ? f.originalname : n; };

router.get("/knowledge", async (req, res) => res.json(await knowledgeLibrary(req.session.userId!)));

/** Files (up to 20 at once) or pasted text, with a category and a sector for all of them. */
router.post("/knowledge", upload.array("files", 20), async (req, res) => {
  const userId = req.session.userId!;
  const b: any = req.body ?? {};
  const category = String(b.category ?? "company"), sector = b.sector ? String(b.sector) : null;
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  const added: any[] = [], failed: Array<{ file: string; error: string }> = [];
  for (const f of files) {
    const name = fileNameOf(f);
    try {
      const text = await extractText(f.buffer, name);
      added.push(await addDoc(userId, { title: name.replace(/\.[a-z0-9]+$/i, ""), content: text, category, sector, fileName: name }));
    } catch (err: any) { failed.push({ file: name, error: String(err?.message ?? err) }); }
  }
  if (typeof b.text === "string" && b.text.trim()) {
    try { added.push(await addDoc(userId, { title: String(b.title ?? "").trim() || b.text.trim().slice(0, 60), content: b.text, category, sector })); }
    catch (err: any) { failed.push({ file: "النص الملصق", error: String(err?.message ?? err) }); }
  }
  if (!added.length && !failed.length) return res.status(400).json({ error: "ارفع ملفاً أو الصق نصاً" });
  res.status(added.length ? 201 : 400).json({ added: added.map(({ content, ...d }) => d), failed, error: added.length ? undefined : failed.map((f) => `${f.file}: ${f.error}`).join(" · ") });
});

router.get("/knowledge/:id", async (req, res) => {
  const userId = req.session.userId!;
  const [doc] = await db.select().from(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, userId))).limit(1);
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  const facts = await db.select().from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.docId, doc.id))).orderBy(agentMemoryTable.id);
  res.json({ doc: { ...doc, content: doc.content.slice(0, 60_000), truncated: doc.content.length > 60_000 }, facts });
});

router.patch("/knowledge/:id", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.title === "string" && req.body.title.trim()) set["title"] = req.body.title.trim().slice(0, 200);
  if (typeof req.body?.category === "string") set["category"] = req.body.category.slice(0, 30);
  if (req.body?.sector !== undefined) set["sector"] = req.body.sector ? String(req.body.sector).slice(0, 80) : null;
  const [doc] = await db.update(emailKnowledgeDocsTable).set(set).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, req.session.userId!))).returning({ id: emailKnowledgeDocsTable.id, sector: emailKnowledgeDocsTable.sector });
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  // The facts follow the document's sector.
  if (req.body?.sector !== undefined) await db.update(agentMemoryTable).set({ topic: doc.sector }).where(and(eq(agentMemoryTable.userId, req.session.userId!), eq(agentMemoryTable.docId, doc.id)));
  res.json(doc);
});

/** The document and every fact drawn from it. */
router.delete("/knowledge/:id", async (req, res) => {
  await db.delete(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

/** Read it again — after the model was down, or the sector changed. */
router.post("/knowledge/:id/learn", async (req, res) => {
  const userId = req.session.userId!;
  const [doc] = await db.select({ id: emailKnowledgeDocsTable.id }).from(emailKnowledgeDocsTable).where(and(eq(emailKnowledgeDocsTable.id, Number(req.params.id)), eq(emailKnowledgeDocsTable.userId, userId))).limit(1);
  if (!doc) return res.status(404).json({ error: "المستند غير موجود" });
  void learnDoc(userId, doc.id);
  res.json({ ok: true });
});

router.post("/knowledge/ask", async (req, res) => {
  const q = String(req.body?.question ?? "").trim();
  if (!q) return res.status(400).json({ error: "اكتب سؤالاً" });
  res.json(await askKnowledge(req.session.userId!, q.slice(0, 500), req.body?.sector ? String(req.body.sector) : null));
});

// ── The follow-up dashboard and the team on its own ───────────────
router.get("/dashboard", async (req, res) => res.json(await emailDashboard(req.session.userId!, Number(req.query["days"]) || 14)));
router.get("/autopilot", async (req, res) => {
  const userId = req.session.userId!;
  res.json({ autopilot: await getAutopilot(userId), team: await teamStatus(userId) });
});
router.put("/autopilot", async (req, res) => {
  const userId = req.session.userId!;
  const before = await getAutopilot(userId);
  const row = await saveAutopilot(userId, req.body ?? {});
  if (row.enabled !== before.enabled) await teamActivity(userId, "email_strategist", "autopilot", row.enabled ? `شغّل صاحب العمل الطيار الآلي (${row.mode === "auto" ? "إرسال تلقائي بعد مراجعة ماجد" : "كل حملة تنتظر موافقته"}).` : "أوقف صاحب العمل الطيار الآلي.");
  res.json(row);
});
// ── طارق builds a campaign on request ──
router.get("/creator/services", (_req, res) => res.json(Object.entries(CREATOR_SERVICES).map(([key, v]) => ({ key, label: v.label, category: v.category }))));
router.post("/creator", async (req, res) => {
  const b = req.body ?? {};
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => n > 0) : []);
  try {
    res.json(await createWithCreator(req.session.userId!, { service: String(b.service ?? ""), language: ["ar", "en", "both"].includes(b.language) ? b.language : "ar",
      listIds: ids(b.listIds), folderIds: ids(b.folderIds), sectors: Array.isArray(b.sectors) ? b.sectors.map(String).slice(0, 10) : [], take: Number(b.take) || undefined, notes: typeof b.notes === "string" ? b.notes.slice(0, 2000) : "" }));
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

/** A round now, rather than at the next quarter hour. */
router.post("/autopilot/run", async (req, res) => {
  try { res.json(await runAutopilot(req.session.userId!, { force: true })); }
  catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
});

export default router;
