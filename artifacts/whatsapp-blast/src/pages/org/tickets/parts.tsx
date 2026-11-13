// قطع التذاكر المشتركة: الحالة، الأولوية، البطاقة، والأفعال بتأكيدٍ في مكانها.

import { useState } from "react";
import { Ban, Check, Clock, MessageSquare, Pause, RotateCcw, UserCog, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Confirm, TASK, ago, card, dept, field, ghost, pill, primary, when, useOrgAction } from "../shared";

const G = "border-green-500/30 bg-green-500/10 text-green-400";
const Y = "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
const R = "border-red-500/30 bg-red-500/10 text-red-400";
const N = "border-border text-muted-foreground";
const B = "border-blue-500/30 bg-blue-500/10 text-blue-400";

export const STATUS: Record<string, { label: string; cls: string }> = {
  ...TASK,
  draft: { label: "مسودة", cls: N },
  waiting_for_owner: { label: "تنتظر قرارك", cls: Y },
  blocked: { label: "محجوبة", cls: R },
};
export const PRIORITY: Record<string, { label: string; cls: string }> = {
  critical: { label: "حرجة", cls: R },
  high: { label: "عالية", cls: Y },
  normal: { label: "عادية", cls: B },
  low: { label: "منخفضة", cls: N },
};
export const OPEN = ["draft", "pending", "queued", "running", "waiting_for_dependency", "waiting_for_approval", "waiting_for_owner", "blocked"];
export const CLOSED = ["completed", "failed", "cancelled", "expired"];
/** أعمدة اللوحة: المفتوح بترتيب العمل، ثم المغلق. */
export const COLUMNS: Array<{ key: string; label: string; statuses: string[] }> = [
  { key: "intake", label: "وصلت", statuses: ["draft", "pending"] },
  { key: "approval", label: "تنتظر", statuses: ["waiting_for_approval", "waiting_for_owner", "waiting_for_dependency"] },
  { key: "queued", label: "في الطابور", statuses: ["queued"] },
  { key: "running", label: "تعمل", statuses: ["running"] },
  { key: "blocked", label: "محجوبة", statuses: ["blocked"] },
  { key: "done", label: "أُغلقت", statuses: CLOSED },
];

export const Badge = ({ map, value }: { map: Record<string, { label: string; cls: string }>; value: unknown }) => {
  const s = map[String(value ?? "")];
  return <span className={cn(pill, s?.cls ?? N)}>{s?.label ?? String(value ?? "—")}</span>;
};
export const titleOf = (t: any) => t.title || t.taskType;

/** سطر التذكرة في القائمة واللوحة. */
export function TicketCard({ t, onOpen, compact }: { t: any; onOpen: (id: number) => void; compact?: boolean }) {
  return (
    <button onClick={() => onOpen(t.taskId)} className={cn(card, "w-full text-right p-3 space-y-1.5 hover:border-primary/50 transition-colors", t.overdue && "border-red-500/40")}>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted-foreground" dir="ltr">#{t.taskId}</span>
        <b className="truncate min-w-0 max-w-full sm:max-w-[22rem]" dir="auto">{titleOf(t)}</b>
        {!compact && <Badge map={STATUS} value={t.status} />}
        <Badge map={PRIORITY} value={t.priorityLevel} />
        {t.overdue && <span className={cn(pill, R, "inline-flex items-center gap-1")}><Clock className="w-3 h-3" /> متأخرة</span>}
      </div>
      <div className="text-[11px] text-muted-foreground flex gap-3 flex-wrap">
        <span dir="ltr">{t.assignedTo ?? "غير مكلَّفة"}</span>
        <span>{dept(t.department)}</span>
        {t.dueAt && <span>الموعد {when(t.dueAt)}</span>}
        {t.parentTaskId && <span>تتبع <span dir="ltr">#{t.parentTaskId}</span></span>}
        <span className="mr-auto" title={when(t.updatedAt)}>{ago(t.updatedAt)}</span>
      </div>
    </button>
  );
}

/** أفعال صاحب العمل على تذكرة، كلٌّ بتأكيدٍ يسمّي أثره. */
export function TicketActions({ t }: { t: any }) {
  const act = useOrgAction();
  const busy = act.isPending;
  const path = `/tickets/${t.taskId}`;
  const [assigning, setAssigning] = useState(false);
  const [key, setKey] = useState("");
  const [comment, setComment] = useState("");
  const isOpen = OPEN.includes(t.status);
  const isDaily = t.taskType === "ops_daily";

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        {(t.status === "waiting_for_approval" || (t.status === "waiting_for_owner" && t.approvalRequired && t.approvalStatus === "pending")) && <>
          <Confirm tone="primary" label="موافقة" icon={<Check className="w-3 h-3" />} busy={busy}
            effect={<>توافق على هذه الحمولة بعينها (البصمة <span dir="ltr" className="font-mono">{String(t.payloadHash).slice(0, 12)}…</span>). إن تغيّرت قبل التنفيذ فلن تُنفَّذ وتعود إليك. قد يكون لها أثر خارجي.</>}
            onConfirm={() => act.mutate({ path: `${path}/approve`, body: { payloadHash: t.payloadHash }, ok: "وافقت على التذكرة" })} />
          <Confirm tone="ghost" label="رفض" icon={<X className="w-3 h-3" />} busy={busy} reason
            effect="ستُلغى التذكرة وكل ما يعتمد عليها."
            onConfirm={(reason) => act.mutate({ path: `${path}/reject`, body: { reason }, ok: "رُفضت التذكرة" })} />
        </>}
        {isOpen && !isDaily && t.status !== "running" && (
          <button className={ghost} disabled={busy} onClick={() => setAssigning(!assigning)}><UserCog className="w-3 h-3" />{t.assignedTo ? "إعادة تكليف" : "تكليف"}</button>
        )}
        {isOpen && !isDaily && t.status !== "blocked" && (
          <Confirm tone="ghost" label="إيقاف مؤقت" icon={<Pause className="w-3 h-3" />} busy={busy} reason
            effect="يوضع مفتاح إيقاف على هذه التذكرة: كل إرسال أو جولة لها يُرفض فوراً، حتى في منتصف عملها، إلى أن تعيد فتحها."
            onConfirm={(reason) => act.mutate({ path: `${path}/pause`, body: { reason }, ok: "أُوقفت التذكرة مؤقتاً" })} />
        )}
        {isOpen && !isDaily && (
          <Confirm label="إلغاء" icon={<Ban className="w-3 h-3" />} busy={busy} reason
            effect="تُلغى التذكرة وكل ما يعتمد عليها، ويُرفض كل إرسال لها من الآن. لا تعود وحدها."
            onConfirm={(reason) => act.mutate({ path: `${path}/cancel`, body: { reason }, ok: "أُلغيت التذكرة" })} />
        )}
        {(CLOSED.includes(t.status) || t.status === "blocked") && !isDaily && (
          <Confirm tone="ghost" label="إعادة فتح" icon={<RotateCcw className="w-3 h-3" />} busy={busy} reason
            effect="تعود التذكرة إلى الطابور بعدّاد محاولات جديد ويُرفع مفتاحها. تأكد أن ما فعلته قبلُ لن يتكرر بأثرٍ خارجي."
            onConfirm={(reason) => act.mutate({ path: `${path}/reopen`, body: { reason }, ok: "أُعيد فتح التذكرة" })} />
        )}
      </div>
      {assigning && (
        <div className="flex gap-2 flex-wrap items-center">
          <input className={cn(field, "w-full sm:w-64")} dir="ltr" placeholder="مفتاح الموظف، مثل email.copywriter" value={key} onChange={(e) => setKey(e.target.value)} />
          <Confirm tone="primary" label={t.assignedTo ? "إعادة التكليف" : "التكليف"} busy={busy || !key.trim()}
            effect={<>تُسند التذكرة إلى <b dir="ltr">{key.trim() || "…"}</b> ويعمل بها في جولته. المفتاح لا الاسم.</>}
            onConfirm={() => { act.mutate({ path: `${path}/${t.assignedTo ? "reassign" : "assign"}`, body: { employeeKey: key.trim() }, ok: "تم التكليف" }); setAssigning(false); setKey(""); }} />
        </div>
      )}
      <div className="flex gap-2 items-center">
        <input className={cn(field, "flex-1")} placeholder="تعليق على التذكرة…" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className={primary} disabled={busy || !comment.trim()} onClick={() => { act.mutate({ path: `${path}/comment`, body: { text: comment.trim() }, ok: "أُضيف التعليق" }); setComment(""); }}>
          <MessageSquare className="w-3 h-3" /> تعليق
        </button>
      </div>
    </div>
  );
}
