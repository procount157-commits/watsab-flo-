// موظف واحد مفتوحاً: تعليماته بنسختها، أدواته، نبضه، مهامه، أخطاؤه، ذاكرته، وبطاقة تقييمه
// بحسابها وأدلتها. لا درجة بلا عيّنة كافية.

import { useState } from "react";
import { Link } from "wouter";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Bars, EXECUTION, Empty, Filters, HEARTBEAT, Pill, Pre, Q, Score, Section, TASK, ago, card, day, dept, list, num, pct, pill, show, useOrg, when,
} from "./shared";
import { ProposalCard } from "./ApprovalsTab";
import { CallEmployeeButton } from "./control-room/CallEmployeeButton";
import { EmployeeDossier } from "./docs/EmployeeDossier";

const CONFIDENCE: Record<string, string> = { high: "عالية", medium: "متوسطة", low: "منخفضة", none: "لا ثقة" };
const insufficient = (c: any) => c?.status === "INSUFFICIENT DATA" || c?.score == null;

/** أين يُفتح الدليل. ما لا صفحة له يبقى رقماً مقروءاً، ولا يُختلق له رابط. */
const evidenceHref = (table: string, id: unknown): string | null => {
  const i = encodeURIComponent(String(id));
  switch (table) {
    case "employee_executions": return `#exec-${i}`;
    case "employee_feedback": return `#feedback-${i}`;
    case "employee_tasks": return "/org/tasks";
    case "email_messages": return "/email/sent";
    case "email_missions": return "/email/missions";
    case "org_audit_log": return "/org/safety";
    case "email_campaigns": return "/email/campaigns";
    case "email_contacts": return "/email/contacts";
    case "target_accounts": case "target_people": return "/email/accounts";
    case "contacts": return `/contacts/${i}`;
    case "campaigns": return `/campaigns/${i}`;
    default: return null;
  }
};
function Evidence({ evidence }: { evidence: unknown }) {
  if (!evidence || typeof evidence !== "object") return <p className="text-[11px] text-muted-foreground">لا دليل مرفق.</p>;
  const groups = Object.entries(evidence as Record<string, unknown>);
  if (!groups.length) return <p className="text-[11px] text-muted-foreground">لا دليل مرفق.</p>;
  return (
    <div className="space-y-1">
      {groups.map(([table, ids]) => (
        <div key={table} className="flex gap-1 flex-wrap items-center text-[10px]" dir="ltr">
          <span className="text-muted-foreground font-mono">{table}</span>
          {Array.isArray(ids) ? ids.map((id) => {
            const href = evidenceHref(table, id);
            const chip = "px-1.5 rounded border border-card-border font-mono";
            if (!href) return <span key={String(id)} className={chip}>{String(id)}</span>;
            return href.startsWith("#")
              ? <a key={String(id)} href={href} className={cn(chip, "text-primary hover:border-primary/50")}>{String(id)}</a>
              : <Link key={String(id)} href={href} className={cn(chip, "text-primary hover:border-primary/50")}>{String(id)}</Link>;
          }) : <span className="font-mono">{show(ids)}</span>}
        </div>
      ))}
    </div>
  );
}

const Trend = ({ t }: { t: any }) => {
  if (!t || t.direction === "unknown") return <span className="text-muted-foreground">لا اتجاه بعد</span>;
  const Icon = t.direction === "up" ? ArrowUp : t.direction === "down" ? ArrowDown : Minus;
  return <span className="inline-flex items-center gap-1"><Icon className="w-3 h-3" />{t.delta == null ? "" : num(Math.abs(t.delta))}{t.previousScore != null && <span className="text-muted-foreground"> (كان {num(t.previousScore)})</span>}</span>;
};
const metricValue = (m: any) => {
  if (m.value == null || m.status === "INSUFFICIENT DATA") return <span className="text-muted-foreground">بيانات غير كافية</span>;
  if (m.unit === "ratio") return pct(m.value);
  if (m.unit === "ms") return `${num(m.value)} م.ث`;
  return num(m.value);
};

function Scorecard({ employeeKey }: { employeeKey: string }) {
  const [period, setPeriod] = useState("weekly");
  const q = useOrg<{ scorecards: any[] }>(`/scorecards?period=${period}&employee=${encodeURIComponent(employeeKey)}`, 300_000);
  return (
    <Section title="بطاقة التقييم" action={<Filters value={period} onChange={setPeriod} options={[{ key: "weekly", label: "أسبوعي" }, { key: "monthly", label: "شهري" }]} />}>
      <Q q={q} what="البطاقة">
        {(d) => {
          const c = list(d.scorecards).find((x) => x.employeeKey === employeeKey) ?? list(d.scorecards)[0];
          if (!c) return <Empty>لا بطاقة لهذه الفترة بعد.</Empty>;
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
                <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">الدرجة</p><Score value={insufficient(c) ? null : c.score} className="text-lg" /></div>
                <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">الفترة</p><p className="font-medium">{day(c.periodStart)} إلى {day(c.periodEnd)}</p><p className="text-[10px] text-muted-foreground" dir="ltr">{c.periodKey}{c.live ? " · live" : ""}</p></div>
                <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">العيّنة</p><p className="font-medium">{num(c.sampleSize)}</p></div>
                <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">الثقة</p><p className="font-medium">{CONFIDENCE[c.confidence] ?? c.confidence ?? "—"}</p></div>
                <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">الاتجاه</p><p className="font-medium"><Trend t={c.trend} /></p></div>
              </div>
              {c.note && <p className="text-xs text-yellow-400" dir="auto">{c.note}</p>}
              <div><p className="text-[11px] text-muted-foreground mb-0.5">طريقة الحساب</p><Pre>{c.calculation ?? "—"}</Pre></div>
              <div><p className="text-[11px] text-muted-foreground mb-1">الأدلة</p><Evidence evidence={c.evidence} /></div>
              {list(c.metrics).length > 0 && (
                <div className="divide-y divide-card-border">
                  {list(c.metrics).map((m) => (
                    <details key={m.key} className="py-2 text-xs">
                      <summary className="cursor-pointer flex items-center gap-2 flex-wrap">
                        <span className="font-medium" dir="auto">{m.label}</span>
                        <span>{metricValue(m)}</span>
                        <span className="text-[10px] text-muted-foreground mr-auto">الوزن {num(m.weight)} · العيّنة {num(m.sampleSize)} من {num(m.minSample)} لازمة · الدرجة {m.score == null ? "—" : num(m.score)}</span>
                      </summary>
                      <div className="mt-1.5 space-y-1.5"><Pre>{m.calculation ?? "—"}</Pre><Evidence evidence={m.evidence} /></div>
                    </details>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </Q>
    </Section>
  );
}

const MEMORY_LAYER: Record<string, string> = { employee: "ذاكرة الموظف", department: "ذاكرة القسم", account: "ذاكرة الحساب" };

export default function EmployeeDetail({ employeeKey }: { employeeKey: string }) {
  const q = useOrg<any>(`/employees/${encodeURIComponent(employeeKey)}`);
  return (
    <div className="space-y-4">
      <Link href="/org/employees" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowRight className="w-3.5 h-3.5" /> الموظفون</Link>
      <Q q={q} what="ملف الموظف">
        {(d) => {
          const p = d.profile ?? {};
          const hb = d.heartbeat;
          // السجل يخلط الأسبوعي بالشهري: لكل فترة مخططها.
          const trendOf = (period: string) => list(d.trends).filter((c) => c.period === period && !insufficient(c))
            .map((c) => ({ x: String(c.periodKey ?? "").replace(/^[a-z]+:/, ""), y: Number(c.score) })).sort((a, b) => a.x.localeCompare(b.x));
          const weeklyTrend = trendOf("weekly"), monthlyTrend = trendOf("monthly");
          const history = list(d.heartbeatHistory);
          const memory = Object.entries(d.memory ?? {}) as Array<[string, any[]]>;
          const memoryCount = memory.reduce((a, [, v]) => a + list(v).length, 0);
          return (
            <>
              <div className={cn(card, "p-4 space-y-2")}>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold">{p.name ?? employeeKey}</h2>
                  <Pill map={HEARTBEAT} value={p.heartbeat_status} />
                  <span className={cn(pill, "border-border")}>{dept(p.department)}</span>
                  <span className={cn(pill, "border-border text-muted-foreground")}>{EXECUTION[p.execution] ?? p.execution}</span>
                  <CallEmployeeButton employeeKey={p.key ?? employeeKey} />
                </div>
                <p className="text-[11px] text-muted-foreground font-mono" dir="ltr">{p.key ?? employeeKey} · {p.role} · account {p.account}</p>
                <p className="text-sm">{p.title ?? "—"}</p>
                <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                  <div className="flex gap-1.5"><dt className="text-muted-foreground">التكامل:</dt><dd dir="ltr">{p.integration_status ?? "—"}</dd></div>
                  <div className="flex gap-1.5"><dt className="text-muted-foreground">الجدولة:</dt><dd dir="auto">{p.scheduler_location ?? "لا جدولة"}</dd></div>
                  <div className="flex gap-1.5"><dt className="text-muted-foreground">التنفيذ:</dt><dd dir="ltr">{p.execution_function ?? "—"}</dd></div>
                  <div className="flex gap-1.5"><dt className="text-muted-foreground">موضع التعليمات:</dt><dd dir="auto">{p.prompt_location ?? "—"}</dd></div>
                  {p.carried_by && <div className="flex gap-1.5"><dt className="text-muted-foreground">يحمل عمله:</dt><dd><Link href={`/org/employees/${encodeURIComponent(p.carried_by)}`} className="text-primary hover:underline" dir="ltr">{p.carried_by}</Link></dd></div>}
                  {list(p.dependencies).length > 0 && <div className="flex gap-1.5 flex-wrap"><dt className="text-muted-foreground">يعتمد على:</dt>{list(p.dependencies).map((k) => <dd key={k}><Link href={`/org/employees/${encodeURIComponent(k)}`} className="text-primary hover:underline" dir="ltr">{k}</Link></dd>)}</div>}
                </dl>
              </div>

              <Scorecard employeeKey={employeeKey} />

              {weeklyTrend.length + monthlyTrend.length > 0 && (
                <Section title="اتجاه الدرجة">
                  <div className="grid md:grid-cols-2 gap-3">
                    <Bars title="أسبوعي" data={weeklyTrend} />
                    <Bars title="شهري" data={monthlyTrend} />
                  </div>
                </Section>
              )}

              <Section title="التعليمات" action={<span className="text-[11px] text-muted-foreground">النسخة العاملة {d.prompt?.version == null ? "—" : num(d.prompt.version)}{d.prompt?.library ? ` · نسخة المكتبة ${num(d.prompt.library.version)}` : ""}</span>}>
                {d.prompt?.library?.externalBehavior && <span className={cn(pill, "border-yellow-500/30 text-yellow-400")}>تغييرها يمس سلوكاً خارجياً</span>}
                {d.prompt?.persona ? <Pre className="max-h-96">{d.prompt.persona}</Pre> : <Empty>لا تعليمات مسجّلة.</Empty>}
                {list(d.prompt?.versions).length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">النسخ ({num(list(d.prompt.versions).length)})</summary>
                    <div className="space-y-2 mt-2">
                      {list(d.prompt.versions).map((v) => (
                        <details key={v.version} className="rounded-lg border border-card-border p-2">
                          <summary className="cursor-pointer flex gap-2 flex-wrap items-center">
                            <b>النسخة {num(v.version)}</b>
                            {v.active && <span className={cn(pill, "border-primary/40 text-primary")}>تعمل</span>}
                            <span className="text-muted-foreground" dir="auto">{v.note}</span>
                            <span className="mr-auto text-[10px] text-muted-foreground">{v.created_by ? <span dir="ltr">{v.created_by}</span> : null} {when(v.created_at)}</span>
                          </summary>
                          <Pre className="mt-1.5">{v.prompt}</Pre>
                        </details>
                      ))}
                    </div>
                  </details>
                )}
              </Section>

              <EmployeeDossier employeeKey={p.key ?? employeeKey} />

              <div className="grid md:grid-cols-2 gap-4">
                <Section title="الأدوات">
                  {list(d.tools).length ? <div className="flex gap-1.5 flex-wrap">{list(d.tools).map((t) => <span key={String(t)} className={cn(pill, "border-border font-mono")} dir="ltr">{String(t)}</span>)}</div> : <Empty>لا أدوات معتمدة مسجّلة.</Empty>}
                </Section>
                <Section title="الصلاحيات">
                  <p className="text-xs" dir="auto">{String(d.permissions?.status ?? "").startsWith("halted") ? <span className="text-red-400">موقوف: {String(d.permissions.status).replace(/^halted:?\s*/, "") || "بمفتاح"}</span> : d.permissions?.status === "allowed" ? "مسموح له بالعمل" : show(d.permissions?.status)}</p>
                  <p className="text-xs text-muted-foreground">{d.permissions?.is_active === false ? "معطّل في الفريق" : d.permissions?.is_active === true ? "مفعّل في الفريق" : ""}</p>
                  {list(d.permissions?.approvalRequiredFor).length > 0 && (
                    <div className="space-y-1"><p className="text-[11px] text-muted-foreground">يحتاج موافقة على:</p><div className="flex gap-1.5 flex-wrap">{list(d.permissions.approvalRequiredFor).map((a) => <span key={String(a)} className={cn(pill, "border-border")} dir="auto">{String(a)}</span>)}</div></div>
                  )}
                </Section>
              </div>

              <Section title="النبض">
                {hb ? (
                  <dl className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                    {[
                      ["الحالة المسجّلة", <span key="s" dir="ltr">{hb.status}</span>],
                      ["آخر نبضة", ago(hb.last_beat_at ?? hb.last_heartbeat_at)],
                      ["التالية", ago(hb.next_beat_at ?? hb.next_run_at)],
                      ["الفترة", hb.interval_sec == null ? "—" : `${num(hb.interval_sec)} ث`],
                      ["آخر بدء", ago(hb.last_started_at)],
                      ["آخر نجاح", ago(hb.last_success_at)],
                      ["آخر فشل", ago(hb.last_failure_at)],
                      ["فشل متتالٍ", num(hb.consecutive_failures)],
                    ].map(([l, v], i) => <div key={i} className="rounded-lg border border-card-border p-2"><dt className="text-muted-foreground">{l}</dt><dd className="font-medium mt-0.5">{v}</dd></div>)}
                  </dl>
                ) : <Empty>بلا تنفيذ: لا صف نبض لهذا الموظف.</Empty>}
                {hb?.last_error && <p className="text-xs text-red-400" dir="auto">{hb.last_error}</p>}
                {history.length > 0 && (
                  <details className="text-xs" open>
                    <summary className="cursor-pointer text-muted-foreground">آخر التنفيذات ({num(history.length)})</summary>
                    <div className="divide-y divide-card-border mt-1 max-h-72 overflow-y-auto">
                      {history.map((h) => (
                        <div key={h.id} id={`exec-${h.id}`} className="py-1.5 flex gap-2 flex-wrap items-center text-[11px] target:bg-primary/10">
                          <span className="text-muted-foreground font-mono" dir="ltr">#{h.id}</span>
                          <span dir="ltr">{h.kind ?? "—"}</span>
                          <span className={cn(pill, h.status === "succeeded" ? "border-green-500/30 text-green-400" : h.status === "failed" ? "border-red-500/30 text-red-400" : "border-border text-muted-foreground")} dir="ltr">{h.status}</span>
                          <span className="text-muted-foreground mr-auto">{h.duration_ms == null ? "" : `${num(h.duration_ms)} م.ث · `}{num(h.model_calls)} نداء · {when(h.started_at)}</span>
                          {h.error && <p className="w-full text-red-400" dir="auto">{h.error}</p>}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </Section>

              <div className="grid md:grid-cols-2 gap-4">
                <Section title="المهام" action={<Link href="/org/tasks" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">كل المهام <ArrowLeft className="w-3 h-3" /></Link>}>
                  {list(d.tasks).length ? (
                    <div className="divide-y divide-card-border">
                      {list(d.tasks).map((t) => (
                        <div key={t.task_id ?? t.taskId} className="py-1.5 text-xs flex gap-2 flex-wrap items-center">
                          <span className="text-muted-foreground" dir="ltr">#{t.task_id ?? t.taskId}</span><span dir="ltr">{t.task_type ?? t.taskType}</span><Pill map={TASK} value={t.status} />
                          {(t.dead_letter ?? t.deadLetter) && <span className={cn(pill, "border-red-500/40 text-red-400")}>ميتة</span>}
                          <span className="mr-auto text-[10px] text-muted-foreground">{ago(t.created_at ?? t.createdAt)}</span>
                          {(t.failure_reason ?? t.failureReason) && <p className="w-full text-[11px] text-red-400" dir="auto">{t.failure_reason ?? t.failureReason}</p>}
                        </div>
                      ))}
                    </div>
                  ) : <Empty>لا مهام.</Empty>}
                </Section>
                <Section title="الأخطاء">
                  {list(d.errors).length ? (
                    <div className="divide-y divide-card-border max-h-80 overflow-y-auto">
                      {list(d.errors).map((x) => (
                        <div key={x.id} className="py-1.5 text-xs space-y-0.5">
                          <div className="flex gap-2 text-[10px] text-muted-foreground"><span dir="ltr">#{x.id} {x.kind}</span><span className="mr-auto">{when(x.started_at)}</span></div>
                          <p className="text-red-400 whitespace-pre-wrap" dir="auto">{x.error}</p>
                        </div>
                      ))}
                    </div>
                  ) : <Empty>لا أخطاء مسجّلة.</Empty>}
                </Section>
              </div>

              <Section title="الذاكرة المعتمدة">
                {memoryCount ? memory.filter(([, v]) => list(v).length).map(([layer, items]) => (
                  <div key={layer} className="space-y-1">
                    <p className="text-[11px] text-muted-foreground">{MEMORY_LAYER[layer] ?? layer} ({num(list(items).length)})</p>
                    <div className="divide-y divide-card-border">
                      {list(items).map((m) => (
                        <div key={`${layer}:${m.id}`} className="py-1.5 text-xs space-y-0.5">
                          <p className="whitespace-pre-wrap" dir="auto">{m.content}</p>
                          <p className="text-[10px] text-muted-foreground flex gap-2 flex-wrap">
                            <span dir="ltr">{m.kind}</span>
                            {m.confidence != null && <span>الثقة {pct(m.confidence) ?? "—"}</span>}
                            {m.sourceReference && <span dir="auto">المصدر: {m.sourceReference}</span>}
                            {m.lastVerifiedAt && <span>تُحقّق {ago(m.lastVerifiedAt)}</span>}
                            {m.expiryAt && <span>تنتهي {when(m.expiryAt)}</span>}
                            {m.version != null && <span>النسخة {num(m.version)}</span>}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )) : <Empty>لا ذاكرة معتمدة.</Empty>}
              </Section>

              <Section title="ملاحظات المدير">
                {list(d.feedback).length ? (
                  <div className="divide-y divide-card-border">
                    {list(d.feedback).map((f) => (
                      <div key={f.id} id={`feedback-${f.id}`} className="py-1.5 text-xs space-y-0.5 target:bg-primary/10">
                        <div className="flex gap-2 text-[10px] text-muted-foreground items-center">
                          <span className={cn(pill, "border-border")} dir="ltr">{f.verdict}</span>
                          {f.from_role && <span dir="ltr">{f.from_role}</span>}
                          <span className="mr-auto">{when(f.created_at)}</span>
                        </div>
                        {f.note && <p className="whitespace-pre-wrap" dir="auto">{f.note}</p>}
                      </div>
                    ))}
                  </div>
                ) : <Empty>لا ملاحظات بعد.</Empty>}
              </Section>

              <Section title="المقترحات">
                {list(d.proposals).length ? <div className="space-y-2">{list(d.proposals).map((x) => <ProposalCard key={x.change_id} p={x} />)}</div> : <Empty>لا مقترحات لهذا الموظف.</Empty>}
              </Section>
            </>
          );
        }}
      </Q>
    </div>
  );
}
