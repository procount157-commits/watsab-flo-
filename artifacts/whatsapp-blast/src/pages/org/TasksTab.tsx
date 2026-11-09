// المهام: الطابور كما هو، والميتة (dead letter) ظاهرة لا مدفونة في «فشلت».

import { useState } from "react";
import { Ban, Check, RotateCcw, Skull, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Confirm, Empty, Filters, Pill, Pre, Q, TASK, ago, card, dept, list, num, pill, show, useOrg, useOrgAction, when } from "./shared";

const OPEN = ["pending", "queued", "waiting_for_dependency", "waiting_for_approval"];
const FILTERS = [
  { key: "all", label: "الكل" },
  { key: "dead", label: "الميتة" },
  ...Object.entries(TASK).map(([key, v]) => ({ key, label: v.label })),
];

export default function TasksTab() {
  const [status, setStatus] = useState("all");
  const server = status === "all" || status === "dead" ? "" : `&status=${status}`;
  const q = useOrg<{ tasks: any[] }>(`/tasks?limit=300${server}`);
  const act = useOrgAction();

  return (
    <div className="space-y-3">
      <Filters value={status} onChange={setStatus} options={FILTERS} />
      <Q q={q} what="المهام">
        {(d) => {
          const rows = list(d.tasks).filter((t) => status !== "dead" || t.deadLetter);
          if (!rows.length) return <div className={cn(card, "p-4")}><Empty>لا مهام بهذا الفلتر.</Empty></div>;
          return (
            <div className="space-y-2">
              {rows.map((t) => {
                const path = `/tasks/${t.taskId}`;
                const busy = act.isPending;
                return (
                  <div key={t.taskId} className={cn(card, "p-3 space-y-2", t.deadLetter && "border-red-500/40")}>
                    <div className="flex items-center gap-2 flex-wrap text-xs">
                      <span className="text-muted-foreground" dir="ltr">#{t.taskId}</span>
                      <b dir="ltr">{t.taskType}</b>
                      <Pill map={TASK} value={t.status} />
                      {t.deadLetter && <span className={cn(pill, "border-red-500/40 bg-red-500/10 text-red-400 inline-flex items-center gap-1")}><Skull className="w-3 h-3" /> ميتة: نفدت محاولاتها</span>}
                      <span className="text-muted-foreground">{dept(t.department)} · <span dir="ltr">{t.ownerRole}</span></span>
                      <span className="mr-auto text-[10px] text-muted-foreground" title={when(t.createdAt)}>أُنشئت {ago(t.createdAt)}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground flex gap-3 flex-wrap">
                      <span>الأولوية {num(t.priority)}</span>
                      <span>المحاولات {num(t.retryCount)} من {num(t.maxRetries)}</span>
                      {t.createdByRole && <span>من <span dir="ltr">{t.createdByRole}</span></span>}
                      {t.parentTaskId && <span>تتبع <span dir="ltr">#{t.parentTaskId}</span></span>}
                      {t.nextAttemptAt && <span>المحاولة التالية {when(t.nextAttemptAt)}</span>}
                      {t.leaseOwner && <span>عند <span dir="ltr">{t.leaseOwner}</span> حتى {when(t.leaseExpiresAt)}</span>}
                      {t.expiresAt && <span>تنتهي {when(t.expiresAt)}</span>}
                    </div>
                    {t.failureReason && <p className="text-xs text-red-400 whitespace-pre-wrap" dir="auto">{t.failureReason}</p>}
                    {(list(t.inputRefs).length > 0 || list(t.outputRefs).length > 0) && (
                      <details className="text-[11px]">
                        <summary className="cursor-pointer text-muted-foreground">المدخلات والمخرجات</summary>
                        <div className="grid md:grid-cols-2 gap-2 mt-1.5"><Pre>{show(t.inputRefs)}</Pre><Pre>{show(t.outputRefs)}</Pre></div>
                      </details>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      {t.status === "waiting_for_approval" && <>
                        <Confirm tone="primary" label="موافقة" icon={<Check className="w-3 h-3" />} busy={busy}
                          effect={<>ستدخل المهمة <b dir="ltr">{t.taskType}</b> الطابور وينفّذها <span dir="ltr">{t.ownerRole}</span>، وقد يكون لها أثر خارجي.</>}
                          onConfirm={() => act.mutate({ path: `${path}/approve`, ok: "وافقت على المهمة" })} />
                        <Confirm tone="ghost" label="رفض" icon={<X className="w-3 h-3" />} busy={busy} reason
                          effect="ستُلغى المهمة وكل ما يعتمد عليها."
                          onConfirm={(reason) => act.mutate({ path: `${path}/reject`, body: { reason }, ok: "رُفضت المهمة" })} />
                      </>}
                      {OPEN.includes(t.status) && t.status !== "waiting_for_approval" && (
                        <Confirm label="إلغاء" icon={<Ban className="w-3 h-3" />} busy={busy} reason
                          effect="ستُلغى المهمة وكل ما يعتمد عليها، ولا تعود وحدها."
                          onConfirm={(reason) => act.mutate({ path: `${path}/cancel`, body: { reason }, ok: "أُلغيت المهمة" })} />
                      )}
                      {(t.status === "failed" || t.status === "expired") && (
                        <Confirm tone="ghost" label="إعادة" icon={<RotateCcw className="w-3 h-3" />} busy={busy}
                          effect="ستعود المهمة إلى الطابور بعدّاد محاولات جديد وتُنفَّذ من جديد. تأكد أن فشلها لم يترك أثراً يتكرر."
                          onConfirm={() => act.mutate({ path: `${path}/retry`, ok: "أُعيدت المهمة إلى الطابور" })} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        }}
      </Q>
    </div>
  );
}
