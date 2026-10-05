// ── /api/deals — the pipeline, proposals and meetings ─────────────
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, dealsTable, clientMeetingsTable, proposalsTable, DEAL_STAGES, type DealStage } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { CHANNEL_AR, STAGE_AR, openDeal, pipeline, setStage, timeline, dealBrief } from "../lib/deals/deals";
import { issuesOf, proposalsFor, sendFollowup, sendProposal, setOutcome, writeProposal } from "../lib/deals/proposals";
import { availableSlots, book, ics, settingsFor, slotLabel, upcoming } from "../lib/deals/meetings";
import { meetingSettingsTable } from "@workspace/db";
import { retrieve } from "../lib/knowledge";

const router = Router();
router.use(requireAuth);
const uid = (req: any) => req.session.userId as number;
const fail = (res: any, err: any) => res.status(400).json({ error: String(err?.message ?? err).slice(0, 300) });

router.get("/", async (req, res) => res.json({ ...(await pipeline(uid(req))), stages: STAGE_AR, channels: CHANNEL_AR }));
router.post("/", async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.title ?? b.company ?? "").trim()) return res.status(400).json({ error: "اكتب اسم الصفقة أو الشركة" });
  try { res.json(await openDeal(uid(req), { channel: b.channel ?? "manual", ref: b.ref ?? null, title: b.title, company: b.company, contactName: b.contactName, email: b.email, phone: b.phone, service: b.service, notes: b.notes, stage: DEAL_STAGES.includes(b.stage) ? b.stage : "lead" })); }
  catch (e) { fail(res, e); }
});
router.get("/:id", async (req, res) => {
  const [d] = await db.select().from(dealsTable).where(and(eq(dealsTable.id, Number(req.params["id"])), eq(dealsTable.userId, uid(req)))).limit(1);
  if (!d) return res.status(404).json({ error: "الصفقة غير موجودة" });
  const [tl, props, meets] = await Promise.all([timeline(uid(req), d, 80), proposalsFor(uid(req), d.id), db.select().from(clientMeetingsTable).where(eq(clientMeetingsTable.dealId, d.id))]);
  res.json({ deal: d, timeline: tl, proposals: props, meetings: meets });
});
router.patch("/:id", async (req, res) => {
  const b = req.body ?? {}, id = Number(req.params["id"]);
  if (b.stage && DEAL_STAGES.includes(b.stage)) await setStage(uid(req), id, b.stage as DealStage, { lostReason: b.lostReason });
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ["title", "company", "contactName", "email", "phone", "service", "notes", "nextStep"] as const) if (b[k] !== undefined) set[k] = b[k] === "" ? null : String(b[k]).slice(0, k === "notes" ? 4000 : 300);
  if (b.valueAed !== undefined) set["valueAed"] = b.valueAed === "" || b.valueAed === null ? null : String(Number(b.valueAed) || 0);
  if (b.nextAt !== undefined) set["nextAt"] = b.nextAt ? new Date(b.nextAt) : null;
  const [row] = await db.update(dealsTable).set(set).where(and(eq(dealsTable.id, id), eq(dealsTable.userId, uid(req)))).returning();
  res.json(row ?? null);
});
router.delete("/:id", async (req, res) => {
  await db.delete(dealsTable).where(and(eq(dealsTable.id, Number(req.params["id"])), eq(dealsTable.userId, uid(req))));
  res.json({ ok: true });
});

// ── Proposals ────────────────────────────────────────────────────
router.post("/:id/proposals", async (req, res) => {
  try { res.json(await writeProposal(uid(req), Number(req.params["id"]), { service: req.body?.service, notes: req.body?.notes })); } catch (e) { fail(res, e); }
});
router.patch("/proposals/:pid", async (req, res) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof req.body?.html === "string") set["html"] = req.body.html;
  if (typeof req.body?.title === "string") set["title"] = req.body.title.slice(0, 200);
  if (typeof req.body?.followupDraft === "string") set["followupDraft"] = req.body.followupDraft;
  const [p] = await db.update(proposalsTable).set(set).where(and(eq(proposalsTable.id, Number(req.params["pid"])), eq(proposalsTable.userId, uid(req)))).returning();
  if (!p) return res.status(404).json({ error: "العرض غير موجود" });
  const kb = (await retrieve(uid(req), p.title, 6).catch(() => [])).map((f) => f.entry.content).join("\n");
  res.json({ proposal: p, issues: issuesOf(p.html, kb) });
});
router.post("/proposals/:pid/send", async (req, res) => {
  try { await sendProposal(uid(req), Number(req.params["pid"]), { html: req.body?.html, to: req.body?.to, subject: req.body?.subject }); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
router.post("/proposals/:pid/followup", async (req, res) => {
  try { await sendFollowup(uid(req), Number(req.params["pid"]), req.body?.text); res.json({ ok: true }); } catch (e) { fail(res, e); }
});
router.post("/proposals/:pid/outcome", async (req, res) => {
  const o = req.body?.outcome === "accepted" ? "accepted" : req.body?.outcome === "declined" ? "declined" : null;
  if (!o) return res.status(400).json({ error: "النتيجة غير معروفة" });
  res.json(await setOutcome(uid(req), Number(req.params["pid"]), o, req.body?.reason));
});
router.get("/:id/brief", async (req, res) => {
  const [d] = await db.select().from(dealsTable).where(and(eq(dealsTable.id, Number(req.params["id"])), eq(dealsTable.userId, uid(req)))).limit(1);
  if (!d) return res.status(404).json({ error: "الصفقة غير موجودة" });
  res.json({ brief: await dealBrief(uid(req), d, 30) });
});

// ── Meetings ─────────────────────────────────────────────────────
router.get("/meetings/all", async (req, res) => {
  const [s, list, free] = await Promise.all([settingsFor(uid(req)), upcoming(uid(req)), availableSlots(uid(req), 14, 60)]);
  const base = process.env["SITE_URL"]?.replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;
  res.json({ settings: s, meetings: list, free: free.map((d) => ({ at: d, label: slotLabel(d) })), bookingUrl: `${base}/book/${s.bookingToken}`, public: !!process.env["SITE_URL"] });
});
router.put("/meetings/settings", async (req, res) => {
  const b = req.body ?? {}, set: Record<string, unknown> = { updatedAt: new Date() };
  if (Array.isArray(b.slots)) set["slots"] = b.slots.filter((x: any) => x && x.dow >= 1 && x.dow <= 7 && /^\d{2}:\d{2}$/.test(x.from) && /^\d{2}:\d{2}$/.test(x.to) && x.from < x.to).slice(0, 40);
  for (const [k, lo, hi] of [["durationMin", 10, 180], ["bufferMin", 0, 120], ["noticeHours", 0, 168], ["reminderMin", 5, 1440]] as const) if (b[k] !== undefined) set[k] = Math.max(lo, Math.min(hi, Number(b[k]) || lo));
  if (typeof b.offerInReplies === "boolean") set["offerInReplies"] = b.offerInReplies;
  await settingsFor(uid(req));
  const [row] = await db.update(meetingSettingsTable).set(set).where(eq(meetingSettingsTable.userId, uid(req))).returning();
  res.json(row);
});
router.post("/meetings", async (req, res) => {
  const b = req.body ?? {};
  if (!String(b.name ?? "").trim() || !b.startsAt) return res.status(400).json({ error: "اكتب الاسم والوقت" });
  try { res.json(await book(uid(req), { name: b.name, company: b.company, email: b.email, phone: b.phone, startsAt: new Date(b.startsAt), topic: b.topic, dealId: Number(b.dealId) || null, source: "manual" })); } catch (e) { fail(res, e); }
});
router.patch("/meetings/:mid", async (req, res) => {
  const b = req.body ?? {}, set: Record<string, unknown> = {};
  if (["booked", "done", "cancelled", "no_show"].includes(b.status)) set["status"] = b.status;
  if (typeof b.notes === "string") set["notes"] = b.notes.slice(0, 4000);
  if (b.startsAt) { set["startsAt"] = new Date(b.startsAt); set["remindedAt"] = null; }
  const [row] = await db.update(clientMeetingsTable).set(set).where(and(eq(clientMeetingsTable.id, Number(req.params["mid"])), eq(clientMeetingsTable.userId, uid(req)))).returning();
  res.json(row ?? null);
});
router.get("/meetings/:mid/ics", async (req, res) => {
  const [m] = await db.select().from(clientMeetingsTable).where(and(eq(clientMeetingsTable.id, Number(req.params["mid"])), eq(clientMeetingsTable.userId, uid(req)))).limit(1);
  if (!m) return res.status(404).send("not found");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="meeting-${m.id}.ics"`);
  res.send(ics(m, "Flow Hub"));
});

export default router;
