// المدير التنفيذي: آخر تقرير بكل حقوله، وتاريخ تقاريره. ما رفضه الحارس لا يظهر نصاً؛ تبقى الوقائع.

import { useState, type ReactNode } from "react";
import { Check, Play, X } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Confirm, Empty, HBars, Pre, Q, Section, card, dept, list, num, pct, pill, show, useOrg, useOrgAction, when } from "./shared";
import { SEVERITY } from "./CommandTab";

const NARRATIVE: Record<string, { label: string; cls: string }> = {
  validated: { label: "نص تحقّق منه الحارس", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  facts_only: { label: "وقائع فقط: رُفض النص", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  model_unavailable: { label: "وقائع فقط: النموذج غير متاح", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  halted: { label: "موقوف بمفتاح", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
};
const IMPROVEMENT: Record<string, string> = { improved: "تحسّن", worse: "ساء", flat: "لم يتغير", mixed: "مختلط", none: "لا تحسينات", "INSUFFICIENT DATA": "بيانات غير كافية" };
const ALERT: Record<string, string> = { missed_deadline: "فاته موعده", failing: "يفشل", no_execution: "بلا تنفيذ" };

const None = ({ children = "لا شيء في هذا التقرير." }: { children?: ReactNode }) => <Empty>{children}</Empty>;
const Rows = ({ rows, render }: { rows: any[]; render: (r: any, i: number) => ReactNode }) =>
  rows.length ? <div className="divide-y divide-card-border">{rows.map((r, i) => <div key={i} className="py-2 text-xs">{render(r, i)}</div>)}</div> : <None />;

function Actions({ report }: { report: any }) {
  const waiting = useOrg<{ tasks: any[] }>("/tasks?status=waiting_for_approval&limit=500");
  const act = useOrgAction();
  const open = new Set(list(waiting.data?.tasks).map((t) => Number(t.taskId)));
  return (
    <Rows rows={list(report.actions_requiring_approval)} render={(a) => {
      const isOpen = a.taskId != null && open.has(Number(a.taskId));
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <b dir="auto">{a.title}</b>
            {a.category && <span className={cn(pill, "border-border text-muted-foreground")} dir="ltr">{a.category}</span>}
            {a.taskId != null && <span className="text-[10px] text-muted-foreground" dir="ltr">#{a.taskId}</span>}
            {!isOpen && waiting.data && <span className="text-[10px] text-muted-foreground">لم تعد تنتظر</span>}
          </div>
          {isOpen && (
            <div className="flex gap-2 flex-wrap">
              <Confirm tone="primary" label="موافقة" icon={<Check className="w-3 h-3" />} busy={act.isPending}
                effect={<>ستدخل «{a.title}» الطابور وتُنفَّذ، وفئتها <span dir="ltr">{a.category}</span> تمس ما هو خارج النظام.</>}
                onConfirm={() => act.mutate({ path: `/tasks/${a.taskId}/approve`, ok: "وافقت" })} />
              <Confirm tone="ghost" label="رفض" icon={<X className="w-3 h-3" />} busy={act.isPending} reason effect="ستُلغى هذه المهمة وما يعتمد عليها."
                onConfirm={(reason) => act.mutate({ path: `/tasks/${a.taskId}/reject`, body: { reason }, ok: "رُفضت" })} />
            </div>
          )}
        </div>
      );
    }} />
  );
}

function Report({ r }: { r: any }) {
  const n = NARRATIVE[r.narrative_status];
  const a = r.answers ?? {};
  const perf = list(r.department_performance);
  return (
    <div className="space-y-4">
      <Section title={`تقرير ${r.period_key ?? ""}`} action={<span className="text-[10px] text-muted-foreground">{when(r.created_at)}</span>}>
        <div className="flex gap-2 flex-wrap items-center">
          <span className={cn(pill, n?.cls ?? "border-border text-muted-foreground")}>{n?.label ?? r.narrative_status ?? "—"}</span>
          {r.period && <span className="text-[10px] text-muted-foreground">الفترة: {r.period === "daily" ? "يومي" : r.period}</span>}
          {r.thin_data && <span className={cn(pill, "border-yellow-500/30 bg-yellow-500/10 text-yellow-400")}>الوقائع قليلة</span>}
        </div>
        {r.executive_summary ? <p className="text-sm leading-relaxed whitespace-pre-wrap" dir="auto">{r.executive_summary}</p> : <Empty>لا ملخص نصي لهذا التقرير؛ الوقائع أدناه.</Empty>}
      </Section>

      <div className="grid md:grid-cols-2 gap-4">
        <Section title="ماذا يُفعل أولاً">
          {a.doFirst && <p className="text-sm font-medium" dir="auto">{a.doFirst}</p>}
          <Rows rows={list(r.top_priorities)} render={(p) => (
            <div><p className="font-medium" dir="auto">{num(p.rank)}. {p.problem}</p>{p.why && <p className="text-muted-foreground mt-0.5" dir="auto">{p.why}</p>}</div>
          )} />
          {list(a.topProblems).length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">أكبر المشاكل</summary>
              <ul className="list-disc pr-4 mt-1 space-y-0.5">{list(a.topProblems).map((t, i) => <li key={i} dir="auto">{show(t)}</li>)}</ul>
            </details>
          )}
        </Section>
        <Section title="الفرص">
          <Rows rows={list(r.revenue_opportunities)} render={(o) => (
            <div><b dir="auto">{o.subject}</b> <span className="text-[10px] text-muted-foreground" dir="ltr">{o.kind}{o.ref != null ? ` #${o.ref}` : ""}</span><p className="text-muted-foreground mt-0.5" dir="auto">{o.detail}</p></div>
          )} />
        </Section>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Section title="المخاطر التشغيلية">
          <Rows rows={list(r.operational_risks)} render={(x) => (
            <div>
              <span className={cn(pill, SEVERITY[x.severity]?.cls ?? "border-border text-muted-foreground", "ml-1.5")}>{SEVERITY[x.severity]?.label ?? x.severity ?? "—"}</span>
              <b dir="ltr">{x.subject}</b> <span className="text-[10px] text-muted-foreground" dir="ltr">{x.kind}</span>
              <p className="text-muted-foreground mt-0.5" dir="auto">{x.detail}</p>
            </div>
          )} />
        </Section>
        <Section title="تنبيهات الموظفين">
          <Rows rows={list(r.employee_alerts)} render={(x) => (
            <div className="flex gap-2 flex-wrap items-baseline">
              <Link href={`/org/employees/${encodeURIComponent(x.employeeKey)}`} className="font-medium text-primary hover:underline" dir="ltr">{x.employeeKey}</Link>
              <span className={cn(pill, "border-border text-muted-foreground")}>{ALERT[x.kind] ?? x.kind}</span>
              <span className="text-muted-foreground" dir="auto">{x.detail}</span>
            </div>
          )} />
        </Section>
      </div>

      <Section title="مقارنة الأقسام">
        {perf.length ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[32rem]">
                <thead className="text-[11px] text-muted-foreground"><tr className="text-right">{["القسم", "تنفيذات", "فشل", "نسبة النجاح", "نداءات", "الرموز", "التكلفة", "النتيجة"].map((h) => <th key={h} className="py-1.5 pl-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{perf.map((x) => (
                  <tr key={x.department} className="border-t border-card-border">
                    <td className="py-1.5 pl-3 font-medium">{dept(x.department)}</td><td className="pl-3">{num(x.executions)}</td><td className="pl-3">{num(x.failed)}</td>
                    <td className="pl-3">{pct(x.successRate) ?? <span className="text-muted-foreground">بيانات غير كافية</span>}</td>
                    <td className="pl-3">{num(x.calls)}</td><td className="pl-3">{num(x.tokens)}</td>
                    <td className="pl-3">{x.costUsd == null ? <span className="text-muted-foreground">غير معروفة</span> : `$${num(x.costUsd)}`}</td>
                    <td className="pl-3" dir="auto">{x.outcome == null ? "—" : `${x.outcomeLabel ?? ""} ${num(x.outcome)}`.trim()}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <HBars title="التنفيذات" data={perf.map((x) => ({ label: dept(x.department), value: x.executions }))} />
              <HBars title="الرموز المستهلكة" data={perf.map((x) => ({ label: dept(x.department), value: x.tokens }))} />
            </div>
          </>
        ) : <None />}
        <div className="grid md:grid-cols-2 gap-2 text-xs">
          <p><span className="text-muted-foreground">الأنفع: </span>{a.bestDepartment ? `${dept(a.bestDepartment.department)} (${a.bestDepartment.basis}: ${num(a.bestDepartment.value)})` : "لا نتيجة تجارية بعد"}</p>
          <p><span className="text-muted-foreground">الأكثر هدراً: </span>{a.wastefulDepartment ? `${dept(a.wastefulDepartment.department)} (${num(a.wastefulDepartment.tokens)} رمز، نتيجة ${num(a.wastefulDepartment.outcome)})` : "لا يوجد"}</p>
        </div>
      </Section>

      <div className="grid md:grid-cols-2 gap-4">
        <Section title="القنوات">
          <Rows rows={list(a.channels)} render={(c) => (
            <div className="flex gap-2 flex-wrap"><b>{dept(c.channel)}</b><span className="text-muted-foreground" dir="auto">{c.state}</span><span className="mr-auto text-muted-foreground">أُرسل {num(c.sent)} · إيجابي {num(c.positive)}</span></div>
          )} />
        </Section>
        <Section title="حملات جلبت عملاء">
          <Rows rows={list(a.campaignsWithLeads)} render={(c) => <div className="flex gap-2"><span dir="auto">{c.name}</span><span className="mr-auto text-muted-foreground">إيجابي {num(c.positive)}</span></div>} />
        </Section>
        <Section title="سير عمل يفشل">
          <Rows rows={list(a.failingWorkflows)} render={(w) => <div className="flex gap-2"><span dir="ltr">{w.workflow}</span><span className="mr-auto text-muted-foreground">{num(w.failed)} من {num(w.total)}</span></div>} />
        </Section>
        <Section title="فاتتهم مواعيدهم">
          {list(a.missingDeadlines).length ? <div className="flex gap-1.5 flex-wrap">{list(a.missingDeadlines).map((k) => <Link key={k} href={`/org/employees/${encodeURIComponent(k)}`} className={cn(pill, "border-border hover:border-primary/50")} dir="ltr">{k}</Link>)}</div> : <None />}
        </Section>
        <Section title="مشاكل الموارد">
          <Rows rows={list(r.resource_issues)} render={(x) => (
            <div><b>{dept(x.department)}</b> <span className="text-muted-foreground">{num(x.tokens)} رمز · {num(x.calls)} نداء · التكلفة {x.costUsd == null ? "غير معروفة" : `$${num(x.costUsd)}`} · النتيجة {num(x.outcome)}</span><p className="text-muted-foreground mt-0.5" dir="auto">{x.detail}</p></div>
          )} />
        </Section>
        <Section title="الإجراءات الموصى بها">
          <Rows rows={list(r.recommended_actions)} render={(x) => (
            <div>
              <div className="flex gap-2 flex-wrap items-center"><b dir="auto">{x.title}</b>
                {x.category && <span className={cn(pill, "border-border text-muted-foreground")} dir="ltr">{x.category}</span>}
                <span className={cn(pill, x.approvalRequired ? "border-yellow-500/30 text-yellow-400" : "border-border text-muted-foreground")}>{x.approvalRequired ? "تحتاج موافقة" : "لا تحتاج موافقة"}</span>
                {x.taskId != null && <span className="text-[10px] text-muted-foreground" dir="ltr">#{x.taskId}</span>}
              </div>
              {x.evidence && Object.keys(x.evidence).length > 0 && <details className="mt-1"><summary className="text-[10px] text-muted-foreground cursor-pointer">الدليل</summary><Pre>{show(x.evidence)}</Pre></details>}
            </div>
          )} />
        </Section>
      </div>

      <Section title="بانتظار موافقتك"><Actions report={r} /></Section>

      <Section title="نتائج تحسينات سابقة" action={a.lastWeekImprovements ? <span className="text-[11px] text-muted-foreground">الأسبوع الماضي: {IMPROVEMENT[a.lastWeekImprovements] ?? a.lastWeekImprovements}</span> : undefined}>
        <Rows rows={list(r.previous_improvement_results)} render={(x) => <Improvement x={x} />} />
      </Section>
    </div>
  );
}

const Improvement = ({ x }: { x: any }) => (
  <div className="flex gap-2 flex-wrap items-baseline">
    <span dir="auto">{x.title}</span>
    {x.metric && <span className="text-muted-foreground" dir="ltr">{x.metric}</span>}
    <span className="text-muted-foreground">قبل {num(x.before)} ← بعد {num(x.after)}</span>
    <span className={cn(pill, "border-border mr-auto")}>{IMPROVEMENT[x.verdict] ?? x.verdict}</span>
  </div>
);

export default function CeoTab() {
  const q = useOrg<{ reports: any[]; employee?: { key: string; hired: boolean } }>("/ceo/reports?limit=30", 60_000);
  const act = useOrgAction();
  const [picked, setPicked] = useState<number | null>(null);
  const run = (
    <Confirm tone="primary" label="شغّل الآن" icon={<Play className="w-3 h-3" />} busy={act.isPending}
      effect="سيُكتب تقرير اليوم لهذا الحساب الآن: قراءة الوقائع ونداء نموذج. يمكن تشغيله مرة كل ٥ دقائق."
      onConfirm={() => act.mutate({ path: "/ceo/run", ok: (d) => (d?.ran === false ? `لم يعمل: ${d.reason ?? "موقوف"}` : "كُتب التقرير") })} />
  );
  return (
    <Q q={q} what="تقارير المدير التنفيذي">
      {(d) => {
        const reports = list(d.reports);
        const current = reports.find((r) => r.id === picked) ?? reports[0];
        const improvements = reports.flatMap((r) => list(r.previous_improvement_results).map((x) => ({ ...x, at: r.period_key })));
        return (
          <div className="space-y-4">
            <div className={cn(card, "p-4 flex items-center gap-3 flex-wrap")}>
              <div className="min-w-0">
                <p className="text-sm font-semibold">المدير التنفيذي</p>
                <p className="text-[11px] text-muted-foreground">{d.employee?.hired === false ? "لم يُعيَّن في هذا الحساب بعد." : d.employee?.key ? <Link href={`/org/employees/${encodeURIComponent(d.employee.key)}`} className="hover:underline" dir="ltr">{d.employee.key}</Link> : null}</p>
              </div>
              <div className="mr-auto w-full sm:w-auto">{run}</div>
            </div>
            {current ? <Report r={current} /> : <div className={cn(card, "p-4")}><Empty>لا تقرير بعد. شغّله الآن أو انتظر الجولة اليومية.</Empty></div>}
            {improvements.length > 0 && (
              <Section title="تاريخ التحسينات">
                <Rows rows={improvements} render={(x) => <div className="space-y-0.5"><span className="text-[10px] text-muted-foreground">{x.at}</span><Improvement x={x} /></div>} />
              </Section>
            )}
            {reports.length > 0 && (
              <Section title="سجل التقارير">
                <div className="flex gap-1.5 flex-wrap">
                  {reports.map((r) => (
                    <button key={r.id} onClick={() => setPicked(r.id)} className={cn("px-3 py-1 rounded-full border text-xs", current?.id === r.id ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground")}>{r.period_key ?? when(r.created_at)}</button>
                  ))}
                </div>
              </Section>
            )}
          </div>
        );
      }}
    </Q>
  );
}
