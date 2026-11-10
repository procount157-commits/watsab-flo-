// ── من المكالمة إلى تذكرة ─────────────────────────────────────────
// كل ما يقترحه موظف في مكالمة أو اجتماع يصير تذكرة (lib/org/tickets.ts) حالتها
// waiting_for_owner، مكلَّفاً بها مفتاح الموظف بعينه، مربوطةً بالمكالمة أو الاجتماع، تحت
// مفتاح تكرار. موافقتها معلّقة (approval_required): لا يُنفَّذ منها شيء قبل أن يوافق صاحب
// الحساب على بصمة حمولتها من التذاكر أو الموافقات. لا معالج مسجَّل لنوع owner_action، فلا
// يخرج منها إرسال ولا اتصال.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { createTask } from "../tasks";
import { askOwner } from "../tickets";

export const ACTION_TICKET_TYPE = "owner_action";

export interface ActionTicketInput {
  userId: number;
  /** الدور (bot_employees.role) لا المفتاح: employee_tasks.owner_role. */
  ownerRole: string;
  employeeKey: string;
  title: string;
  expectedOutcome: string;
  dueAt: Date;
  metric?: string | null;
  source: { kind: "call" | "meeting"; id: number; ref?: string };
  createdByRole?: string | null;
  evidence?: string[];
  idempotencyKey: string;
}

export async function createActionTicket(t: ActionTicketInput): Promise<{ taskId: number; duplicate: boolean }> {
  const by = { kind: "employee" as const, id: t.employeeKey };
  const { task, duplicate } = await createTask({
    userId: t.userId, ownerRole: t.ownerRole, taskType: ACTION_TICKET_TYPE, actionType: ACTION_TICKET_TYPE, createdByRole: t.createdByRole ?? t.ownerRole,
    draft: true, approvalRequired: true, idempotencyKey: t.idempotencyKey, maxRetries: 0, priority: 80,
    title: t.title, objective: t.expectedOutcome, expectedOutput: t.expectedOutcome, dueAt: t.dueAt, assignedTo: t.employeeKey, createdBy: by,
    relatedConversationId: `${t.source.kind}:${t.source.id}`,
    input: {
      title: t.title, expectedOutcome: t.expectedOutcome, metric: t.metric ?? null, dueAt: t.dueAt.toISOString(),
      accountable: t.employeeKey, source: t.source, evidence: t.evidence ?? [],
      note: "اقتُرح في حديثٍ مع صاحب الحساب. لا يُنفَّذ قبل موافقته على هذه التذكرة.",
    },
  });
  // مسودة ← تنتظر صاحب الحساب، بسطرٍ في سجل التذكرة. المكرَّرة بقيت على حالها.
  if (!duplicate && task.status === "draft") {
    await askOwner(t.userId, task.taskId, `اقتُرح في ${t.source.kind === "call" ? "مكالمة" : "اجتماع"} #${t.source.id}: ${t.title}`.slice(0, 1000), by);
  }
  return { taskId: task.taskId, duplicate };
}

/** التذاكر المرتبطة، من حساب الجلسة وحده. */
export async function ticketsByIds(userId: number, ids: number[]) {
  const clean = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  if (!clean.length) return [];
  const r = await db.execute<any>(sql`SELECT task_id, owner_role, task_type, status, approval_status, due_at, input_refs, created_at FROM employee_tasks
    WHERE user_id = ${userId} AND task_id IN (${sql.join(clean.map((i) => sql`${i}`), sql`, `)}) ORDER BY task_id`);
  return r.rows;
}
