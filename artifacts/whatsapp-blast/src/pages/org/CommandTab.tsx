// القيادة: صورة الحساب الآن كما يعدّها الخادم من صفوفه الحقيقية.

import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { Empty, HBars, Q, Section, Stat, ago, card, dept, list, num, pct, pill, useOrg, when } from "./shared";

const INTEGRATION: Record<string, { label: string; cls: string }> = {
  ok: { label: "يعمل", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  degraded: { label: "متعثر", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  down: { label: "متوقف", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
  unknown: { label: "لم يُفحص", cls: "border-border text-muted-foreground" },
};
const SEVERITY: Record<string, { label: string; cls: string }> = {
  critical: { label: "حرج", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
  warn: { label: "تحذير", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
};
export { SEVERITY };

const STATES: Array<{ key: string; label: string; bar: string }> = [
  { key: "healthy", label: "سليم", bar: "bg-green-500" },
  { key: "running", label: "يعمل", bar: "bg-blue-500" },
  { key: "delayed", label: "متأخر", bar: "bg-yellow-500" },
  { key: "failed", label: "فشل", bar: "bg-red-500" },
  { key: "paused", label: "موقوف", bar: "bg-orange-500" },
  { key: "no_execution", label: "بلا تنفيذ", bar: "bg-muted-foreground/40" },
  { key: "no_account", label: "بلا حساب منصة", bar: "bg-muted-foreground/25" },
  { key: "planned", label: "مخطط", bar: "bg-muted-foreground/15" },
];

function Delta({ v }: { v: unknown }) {
  const d = Number(v);
  if (v == null || Number.isNaN(d)) return <span className="text-[10px] text-muted-foreground">—</span>;
  const Icon = d > 0 ? ArrowUp : d < 0 ? ArrowDown : Minus;
  return <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"><Icon className="w-3 h-3" />{num(Math.abs(d))}</span>;
}

export default function CommandTab() {
  const q = useOrg<any>("/overview");
  return (
    <Q q={q} what="صورة القيادة">
      {(d) => {
        const e = d.employees ?? {};
        const total = Number(e.total ?? 0);
        const departments = list(d.departments);
        return (
          <div className="space-y-4">
            <Section title="الموظفون" action={<span className="text-[10px] text-muted-foreground">حُسب {ago(d.generatedAt)}</span>}>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
                <Stat label="الإجمالي" value={e.total} />
                {STATES.map((s) => <Stat key={s.key} label={s.label} value={e[s.key]} />)}
              </div>
              {total > 0 && (
                <div className="space-y-1.5">
                  <div className="flex h-2 gap-0.5" role="img" aria-label="توزيع حالات الموظفين">
                    {STATES.filter((s) => Number(e[s.key]) > 0).map((s) => (
                      <div key={s.key} className={cn(s.bar, "rounded-[2px]")} style={{ flexGrow: Number(e[s.key]) }} title={`${s.label}: ${e[s.key]}`} />
                    ))}
                  </div>
                  <div className="flex gap-3 flex-wrap text-[10px] text-muted-foreground">
                    {STATES.filter((s) => Number(e[s.key]) > 0).map((s) => (
                      <span key={s.key} className="inline-flex items-center gap-1"><span className={cn("w-2 h-2 rounded-sm", s.bar)} />{s.label}</span>
                    ))}
                  </div>
                </div>
              )}
            </Section>

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="المهام">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="نشطة" value={d.tasks?.active} />
                  <Stat label="منها تنتظرك" value={d.tasks?.waitingForOwner} />
                  <Stat label="منها محجوبة" value={d.tasks?.blocked} />
                  <Stat label="متأخرة" value={d.tasks?.overdue} />
                </div>
              </Section>
              <Section title="بانتظار قرارك" action={<Link href="/org/approvals" className="text-[11px] text-primary hover:underline">الموافقات</Link>}>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="مهام" value={d.approvals?.tasks} />
                  <Stat label="مقترحات" value={d.approvals?.proposals} />
                  <Stat label="دروس" value={d.approvals?.lessons} />
                </div>
              </Section>
            </div>

            <Section title="أداء الأقسام: ٧ أيام">
              {departments.length ? (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs min-w-[44rem]">
                      <thead className="text-[11px] text-muted-foreground"><tr className="text-right">
                        {["القسم", "الموظفون", "سليم", "متأخر", "فشل", "موقوف", "بلا تنفيذ", "تنفيذات", "نسبة النجاح", "الدرجة", "النتيجة", "الرموز"].map((h) => <th key={h} className="py-1.5 pl-3 font-medium whitespace-nowrap">{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {departments.map((x) => (
                          <tr key={x.department} className="border-t border-card-border">
                            <td className="py-1.5 pl-3 font-medium whitespace-nowrap">{dept(x.department)}</td>
                            <td className="pl-3">{num(x.employees)}</td><td className="pl-3">{num(x.healthy)}</td><td className="pl-3">{num(x.delayed)}</td>
                            <td className="pl-3">{num(x.failed)}</td><td className="pl-3">{num(x.paused)}</td><td className="pl-3">{num(x.no_execution)}</td>
                            <td className="pl-3">{num(x.executions7d)}</td>
                            <td className="pl-3 whitespace-nowrap">{pct(x.successRate) ?? <span className="text-muted-foreground">بيانات غير كافية</span>}</td>
                            <td className="pl-3 whitespace-nowrap">{x.avgScore == null ? <span className="text-muted-foreground">بيانات غير كافية</span> : num(x.avgScore)}</td>
                            <td className="pl-3 whitespace-nowrap">{x.outcome ? `${x.outcome.label}: ${num(x.outcome.value)}` : "—"}</td>
                            <td className="pl-3">{num(x.tokens7d)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="grid md:grid-cols-2 gap-3">
                    <HBars title="التنفيذات في ٧ أيام" data={departments.map((x) => ({ label: dept(x.department), value: x.executions7d }))} />
                    <HBars title="متوسط الدرجة" data={departments.map((x) => ({ label: dept(x.department), value: x.avgScore }))} />
                  </div>
                </>
              ) : <Empty>لا أقسام بعد.</Empty>}
            </Section>

            <Section title="النتائج: ٧ أيام مقابل السبعة قبلها">
              {list(d.outcomes).length ? (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {list(d.outcomes).map((o) => (
                    <div key={o.key} className="rounded-lg border border-card-border p-2.5">
                      <p className="text-[11px] text-muted-foreground">{o.label}</p>
                      <p className="text-xl font-bold">{num(o.current)}</p>
                      <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">قبلها {num(o.previous)} <Delta v={o.delta} /></p>
                    </div>
                  ))}
                </div>
              ) : <Empty>لا نتائج مسجّلة بعد.</Empty>}
            </Section>

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="صحة الطوابير">
                <div className="grid grid-cols-2 gap-2">
                  <Stat label="بريد في الطابور" value={d.queue?.emailQueued} hint={d.queue?.emailOldest ? `أقدمها ${ago(d.queue.emailOldest)}` : undefined} />
                  <Stat label="بريد ممسوك (أقدم من أسبوع)" value={d.queue?.emailHeldStale} />
                  <Stat label="مهام في الطابور" value={d.queue?.tasksQueued} />
                  <Stat label="مهام ميتة" value={d.queue?.deadLetter} />
                </div>
              </Section>
              <Section title="التكاملات">
                {list(d.integrations).length ? (
                  <div className="space-y-2">
                    {list(d.integrations).map((i) => {
                      const s = INTEGRATION[i.status] ?? INTEGRATION["unknown"]!;
                      return (
                        <div key={i.integration} className="text-xs border-t border-card-border pt-2 first:border-t-0 first:pt-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <b dir="ltr">{i.integration}</b>
                            <span className={cn(pill, s.cls)}>{s.label}</span>
                            <span className="mr-auto text-[10px] text-muted-foreground" title={when(i.checkedAt)}>فُحص {ago(i.checkedAt)}</span>
                          </div>
                          {i.detail && <p className="text-[11px] text-muted-foreground mt-0.5" dir="auto">{i.detail}</p>}
                          {(i.lastOkAt || i.lastFailAt) && <p className="text-[10px] text-muted-foreground">آخر نجاح {ago(i.lastOkAt)} · آخر فشل {ago(i.lastFailAt)}</p>}
                        </div>
                      );
                    })}
                  </div>
                ) : <Empty>لم يُفحص تكامل بعد.</Empty>}
              </Section>
            </div>

            <Section title="المخاطر">
              {list(d.risks).length ? (
                <div className="space-y-2">
                  {list(d.risks).map((r, i) => (
                    <div key={`${r.kind}:${r.subject}:${i}`} className={cn(card, "p-2.5 text-xs space-y-0.5")}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={cn(pill, SEVERITY[r.severity]?.cls ?? "border-border text-muted-foreground")}>{SEVERITY[r.severity]?.label ?? r.severity}</span>
                        <b dir="ltr">{r.subject}</b><span className="text-[10px] text-muted-foreground" dir="ltr">{r.kind}</span>
                      </div>
                      <p className="text-muted-foreground" dir="auto">{r.detail}</p>
                    </div>
                  ))}
                </div>
              ) : <Empty>لا مخاطر مرصودة الآن.</Empty>}
            </Section>
          </div>
        );
      }}
    </Q>
  );
}
