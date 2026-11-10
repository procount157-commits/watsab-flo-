// ── التذاكر: البحث، الطوابير، التفاصيل، صندوق صاحب العمل، والأفعال ──────
// كل شيء مقيَّد بحساب الجلسة: رقم تذكرة حسابٍ آخر 404 كأنها غير موجودة. يُركَّب على
// /org/tickets (routes/index.ts).

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../lib/auth";
import {
  approveTicket, assignTicket, cancelTicket, commentTicket, departmentQueues, dependencyGraph, employeeHistory, intakeTicket, listTickets,
  ownerActor, ownerInbox, pauseTicket, rejectTicket, reopenTicket, ticketDetail, TicketRefused, TRANSITIONS, type TicketFilter,
} from "../lib/org/tickets";
import { PRIORITY_VALUE } from "../lib/org/tasks";

const TICKET_STATUSES = Object.keys(TRANSITIONS);
const TICKET_PRIORITIES = Object.keys(PRIORITY_VALUE);

const router = Router();
router.use(requireAuth);

const uid = (req: Request) => req.session.userId!;
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idOf = (req: Request) => (/^\d{1,9}$/.test(String(req.params["id"] ?? "")) ? Number(req.params["id"]) : null);

/** الخطأ المكتوب بحالته، وما عداه يذهب إلى معالج الأخطاء العام. */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
  try { await fn(req, res); }
  catch (err) {
    if (err instanceof TicketRefused) return void res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
};

function filterOf(q: Request["query"]): TicketFilter | { error: string } {
  const status = str(q["status"], 400).split(",").map((s) => s.trim()).filter(Boolean);
  if (status.some((s) => !(TICKET_STATUSES as readonly string[]).includes(s))) return { error: "حالة غير معروفة" };
  const priority = str(q["priority"], 20) || null;
  if (priority && !(TICKET_PRIORITIES as readonly string[]).includes(priority)) return { error: "أولوية غير معروفة" };
  const yes = (k: string) => q[k] === "1" || q[k] === "true";
  return {
    status, priority, department: str(q["department"], 40) || null, employee: str(q["employee"], 60) || null, q: str(q["q"], 200) || null,
    overdue: yes("overdue"), approval: yes("approval"), includeOps: yes("ops"),
    parent: /^\d+$/.test(str(q["parent"])) ? Number(q["parent"]) : null,
    limit: Number(q["limit"]) || 100, offset: Number(q["offset"]) || 0,
  };
}

// ── القراءة ── (المسارات الثابتة قبل /:id)
router.get("/", wrap(async (req, res) => {
  const f = filterOf(req.query);
  if ("error" in f) return void res.status(400).json({ error: f.error });
  res.json(await listTickets(uid(req), f));
}));
router.get("/inbox", wrap(async (req, res) => { res.json(await ownerInbox(uid(req))); }));
router.get("/queues", wrap(async (req, res) => { res.json(await departmentQueues(uid(req))); }));
router.get("/graph", wrap(async (req, res) => {
  const root = /^\d+$/.test(str(req.query["root"])) ? Number(req.query["root"]) : null;
  res.json(await dependencyGraph(uid(req), { root }));
}));
router.get("/employees/:key", wrap(async (req, res) => { res.json(await employeeHistory(uid(req), str(req.params["key"], 60))); }));
router.get("/:id", wrap(async (req, res) => {
  const id = idOf(req);
  if (id == null) return void res.status(400).json({ error: "رقم تذكرة غير صالح" });
  res.json(await ticketDetail(uid(req), id));
}));

// ── الإنشاء ── تذكرةٌ يكتبها صاحب العمل: تبدأ مسودة، وتُكلَّف بعدها.
router.post("/", wrap(async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  const priority = str(b["priority"], 20) || null;
  if (priority && !(TICKET_PRIORITIES as readonly string[]).includes(priority)) return void res.status(400).json({ error: "أولوية غير معروفة" });
  const due = str(b["dueAt"], 40);
  const r = await intakeTicket({
    userId: uid(req), title: str(b["title"], 300), objective: str(b["objective"], 2000) || null, description: str(b["description"], 8000) || null,
    priority: priority as any, actionType: str(b["actionType"], 60) || null, expectedOutput: str(b["expectedOutput"], 2000) || null,
    dueAt: due && !Number.isNaN(Date.parse(due)) ? new Date(due) : null, createdBy: ownerActor(uid(req)),
    idempotencyKey: str(b["idempotencyKey"], 200) || null,
  });
  let ticket = r.ticket;
  const assignee = str(b["assignTo"], 60);
  if (assignee && !r.duplicate) ticket = await assignTicket(uid(req), ticket.taskId, assignee, ownerActor(uid(req)));
  res.status(r.duplicate ? 200 : 201).json({ ticket, duplicate: r.duplicate });
}));

// ── الأفعال ──
type Act = (userId: number, id: number, body: Record<string, unknown>) => Promise<unknown>;
const action = (fn: Act) => wrap(async (req, res) => {
  const id = idOf(req);
  if (id == null) return void res.status(400).json({ error: "رقم تذكرة غير صالح" });
  const ticket = await fn(uid(req), id, (req.body ?? {}) as Record<string, unknown>);
  res.json({ ok: true, ticket: ticket ?? null });
});

router.post("/:id/assign", action((u, id, b) => assignTicket(u, id, str(b["employeeKey"], 60), ownerActor(u), str(b["reason"]) || null)));
router.post("/:id/reassign", action((u, id, b) => assignTicket(u, id, str(b["employeeKey"], 60), ownerActor(u), str(b["reason"]) || null)));
router.post("/:id/comment", action(async (u, id, b) => { await commentTicket(u, id, str(b["text"], 4000), ownerActor(u)); return null; }));
router.post("/:id/approve", action((u, id, b) => approveTicket(u, id, u, str(b["payloadHash"], 64), str(b["note"]) || null)));
router.post("/:id/reject", action((u, id, b) => rejectTicket(u, id, u, str(b["reason"]) || null)));
router.post("/:id/pause", action((u, id, b) => pauseTicket(u, id, ownerActor(u), str(b["reason"]) || null)));
router.post("/:id/cancel", action((u, id, b) => cancelTicket(u, id, ownerActor(u), str(b["reason"]) || null)));
router.post("/:id/reopen", action((u, id, b) => reopenTicket(u, id, ownerActor(u), str(b["reason"]) || null)));

export default router;
