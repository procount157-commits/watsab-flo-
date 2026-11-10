// تفاصيل التذكرة: ما طُلب وما خرج، الدليل، الخط الزمني، الأب والأبناء والاعتماد، والتنفيذات.

import type { ReactNode } from "react";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pre, Q, Section, ago, card, dept, list, num, pill, show, useOrg, when } from "../shared";
import { Badge, PRIORITY, STATUS, TicketActions, TicketCard, titleOf } from "./parts";

const ACTION_AR: Record<string, string> = {
  "ticket.created": "أُنشئت", "ticket.status": "تغيّرت الحالة", "ticket.assigned": "كُلِّفت", "ticket.reassigned": "أُعيد تكليفها", "ticket.classified": "صُنِّفت",
  "ticket.approved": "وُوفق عليها", "ticket.rejected": "رُفضت", "ticket.paused": "أُوقفت مؤقتاً", "ticket.reopened": "أُعيد فتحها", "ticket.comment": "تعليق",
  "ticket.handoff": "سلّمت عملاً", "ticket.lesson_proposed": "درسٌ مرشَّح", "ticket.approve_refused": "موافقة مرفوضة: الحمولة تغيّرت",
  "approval.payload_mismatch": "رُفض التنفيذ: الحمولة غير المعتمدة", "execute.refused": "رُفض التنفيذ",
};
const EVENT: Record<string, { label: string; cls: string }> = {
  ok: { label: "تم", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  allowed: { label: "سُمح", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  refused: { label: "رُفض", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
  failed: { label: "فشل", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
  started: { label: "بدأ", cls: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  info: { label: "ملاحظة", cls: "border-border text-muted-foreground" },
};
const actionLabel = (a: string) => ACTION_AR[a] ?? (a.startsWith("gate.") ? `قرار البوابة (${a.slice(5)})` : a);

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="text-xs"><p className="text-[11px] text-muted-foreground mb-0.5">{label}</p><div dir="auto">{children ?? "—"}</div></div>;
}

export default function TicketDetail({ id, onBack, onOpen }: { id: number; onBack: () => void; onOpen: (id: number) => void }) {
  const q = useOrg<any>(`/tickets/${id}`, 20_000);
  return (
    <div className="space-y-3">
      <button className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1" onClick={onBack}><ArrowRight className="w-3 h-3" /> كل التذاكر</button>
      <Q q={q} what="التذكرة">
        {(d) => {
          const t = d.ticket;
          return (
            <div className="space-y-3">
              <div className={cn(card, "p-4 space-y-3")}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-muted-foreground text-xs" dir="ltr">#{t.taskId}</span>
                  <h2 className="text-base font-bold" dir="auto">{titleOf(t)}</h2>
                  <Badge map={STATUS} value={t.status} />
                  <Badge map={PRIORITY} value={t.priorityLevel} />
                  {t.overdue && <span className={cn(pill, "border-red-500/30 bg-red-500/10 text-red-400")}>متأخرة</span>}
                  {d.control?.halted && <span className={cn(pill, "border-red-500/30 bg-red-500/10 text-red-400 inline-flex items-center gap-1")}><ShieldAlert className="w-3 h-3" /> مفتاحها مُطفأ: {d.control.reason}</span>}
                </div>
                <div className="grid md:grid-cols-3 gap-3">
                  <Field label="المكلَّف"><span dir="ltr">{t.assignedTo ?? "غير مكلَّفة"}</span></Field>
                  <Field label="القسم">{dept(t.department)}</Field>
                  <Field label="أنشأها"><span dir="ltr">{t.createdBy?.kind ? `${t.createdBy.kind}:${t.createdBy.id}` : t.createdByRole ?? "—"}</span></Field>
                  <Field label="نوع الفعل"><span dir="ltr">{t.actionType ?? t.taskType}</span></Field>
                  <Field label="الموعد">{when(t.dueAt)}</Field>
                  <Field label="المحاولات">{num(t.attemptCount)} · المدة {t.durationMs == null ? "—" : `${num(Math.round(t.durationMs / 1000))} ث`}</Field>
                  {t.handoffTarget && <Field label="سلّمت إلى"><span dir="ltr">{t.handoffTarget}</span></Field>}
                  {(t.related?.customerId || t.related?.campaignId || t.related?.conversationId) && (
                    <Field label="مرتبطة بـ"><span dir="ltr">{[t.related.customerId && `customer:${t.related.customerId}`, t.related.campaignId && `campaign:${t.related.campaignId}`, t.related.conversationId && `conv:${t.related.conversationId}`].filter(Boolean).join(" · ")}</span></Field>
                  )}
                </div>
                {t.objective && <Field label="الهدف">{t.objective}</Field>}
                {t.description && <Field label="الوصف"><p className="whitespace-pre-wrap">{t.description}</p></Field>}
                {t.failureReason && (
                  <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-2.5 text-xs space-y-1">
                    <p className="text-red-400 whitespace-pre-wrap" dir="auto">{t.failureReason}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t.failureCode && <span dir="ltr">{t.failureCode} · </span>}
                      {t.retryable != null && <span>{t.retryable ? "تُعاد" : "لا تُعاد"} · </span>}
                      {t.responsibleParty && <span>المسؤول <span dir="ltr">{t.responsibleParty}</span></span>}
                    </p>
                  </div>
                )}
                {t.nextAction && <Field label="الخطوة التالية">{t.nextAction}</Field>}
                {t.status === "waiting_for_approval" && (
                  <p className="text-[11px] text-muted-foreground">بصمة الحمولة المعروضة عليك: <span dir="ltr" className="font-mono break-all">{t.payloadHash}</span></p>
                )}
                <TicketActions t={t} />
              </div>

              <div className="grid md:grid-cols-2 gap-3">
                <Section title="المدخل (الحمولة)"><Pre>{show(t.inputRefs)}</Pre></Section>
                <Section title="المخرج المنتظر والفعلي">
                  <Field label="المنتظر">{t.expectedOutput ?? "—"}</Field>
                  <Pre>{show(t.actualOutput ?? t.outputRefs)}</Pre>
                </Section>
              </div>

              <Section title={`الدليل (${list(d.evidence).length})`}>
                {list(d.evidence).length ? (
                  <ul className="text-xs space-y-1">{list(d.evidence).map((e: any, i: number) => (
                    <li key={i} className="flex gap-2"><span className={cn(pill, "border-border")} dir="ltr">{e.type}</span><span dir="ltr">{e.id ?? e.ref ?? ""}</span>{e.note && <span className="text-muted-foreground">{e.note}</span>}</li>
                  ))}</ul>
                ) : <Empty>لا دليل بعد. الإغلاق مكتملةً يتطلبه.</Empty>}
              </Section>

              {(d.parent || list(d.children).length > 0 || list(d.dependsOn).length > 0 || list(d.dependents).length > 0) && (
                <Section title="الأب والأبناء والاعتماد">
                  <div className="grid md:grid-cols-2 gap-3">
                    {d.parent && <div className="space-y-1.5"><p className="text-[11px] text-muted-foreground">تتبع</p><TicketCard t={d.parent} onOpen={onOpen} /></div>}
                    {list(d.children).length > 0 && <div className="space-y-1.5"><p className="text-[11px] text-muted-foreground">سلّمت إلى ({d.children.length})</p>{d.children.map((c: any) => <TicketCard key={c.taskId} t={c} onOpen={onOpen} />)}</div>}
                    {list(d.dependsOn).length > 0 && <div className="space-y-1.5"><p className="text-[11px] text-muted-foreground">تنتظر</p>{d.dependsOn.map((c: any) => <TicketCard key={c.taskId} t={c} onOpen={onOpen} />)}</div>}
                    {list(d.dependents).length > 0 && <div className="space-y-1.5"><p className="text-[11px] text-muted-foreground">تنتظرها</p>{d.dependents.map((c: any) => <TicketCard key={c.taskId} t={c} onOpen={onOpen} />)}</div>}
                  </div>
                </Section>
              )}

              <Section title={`الخط الزمني (${list(d.timeline).length})`}>
                {list(d.timeline).length ? (
                  <ol className="space-y-1.5 max-h-[32rem] overflow-y-auto">
                    {list(d.timeline).map((e: any) => (
                      <li key={`${e.source}:${e.id}`} className="border-r-2 border-card-border pr-3 text-xs space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{actionLabel(e.action)}</span>
                          <Badge map={EVENT} value={e.status} />
                          {e.detail?.attemptNo > 1 && <span className="text-[10px] text-muted-foreground">محاولة {num(e.detail.attemptNo)}</span>}
                          {e.actor?.kind && <span className="text-[10px] text-muted-foreground" dir="ltr">{e.actor.kind}:{e.actor.id}</span>}
                          <span className="mr-auto text-[10px] text-muted-foreground" title={when(e.at)}>{ago(e.at)}</span>
                        </div>
                        {e.source === "event" && (e.detail?.input || e.detail?.output) && (
                          <details><summary className="cursor-pointer text-[11px] text-muted-foreground">المدخل والمخرج{e.detail.executionId ? ` · تنفيذ #${e.detail.executionId}` : ""}</summary>
                            <div className="grid md:grid-cols-2 gap-2 mt-1"><Pre>{show(e.detail.input)}</Pre><Pre>{show(e.detail.output)}</Pre></div>
                          </details>
                        )}
                        {e.source === "audit" && e.detail?.why && <p className="text-[11px] text-muted-foreground" dir="auto">{e.detail.why}</p>}
                      </li>
                    ))}
                  </ol>
                ) : <Empty>لا شيء بعد.</Empty>}
              </Section>

              {list(d.executions).length > 0 && (
                <Section title="التنفيذات (ونداءات النموذج في الإيصالات)">
                  <table className="w-full text-[11px]"><thead className="text-muted-foreground"><tr><th className="text-right py-1">#</th><th className="text-right">النوع</th><th className="text-right">الحالة</th><th className="text-right">النداءات</th><th className="text-right">النموذج</th><th className="text-right">المدة</th><th className="text-right">متى</th></tr></thead>
                    <tbody>{d.executions.map((x: any) => (
                      <tr key={x.id} className="border-t border-card-border"><td className="py-1" dir="ltr">{x.id}</td><td dir="ltr">{x.kind}</td><td>{x.status}</td><td>{num(x.model_calls)}</td><td dir="ltr">{x.model ?? "—"}</td><td>{x.duration_ms == null ? "—" : `${num(x.duration_ms)} م.ث`}</td><td>{ago(x.started_at)}</td></tr>
                    ))}</tbody>
                  </table>
                </Section>
              )}
            </div>
          );
        }}
      </Q>
    </div>
  );
}
