// الموظفون: الحالة الحقيقية لكل واحد. لا صف نبض = «بلا تنفيذ»، ولا عيّنة = «بيانات غير كافية».
// الأسماء قد تتكرر، فالمفتاح والقسم ظاهران دائماً.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { CHANNEL, DEPARTMENT, EXECUTION, Empty, HEARTBEAT, Pill, Q, Score, ago, card, dept, field, isInsufficient, list, num, pill, useOrg, when } from "./shared";

const lastResult = (e: any) => {
  const ok = e.last_success ? new Date(e.last_success).getTime() : 0;
  const bad = e.last_failure ? new Date(e.last_failure).getTime() : 0;
  if (!ok && !bad) return { text: "لا نتيجة بعد", cls: "text-muted-foreground" };
  return bad > ok ? { text: `فشل ${ago(e.last_failure)}`, cls: "text-red-400" } : { text: `نجح ${ago(e.last_success)}`, cls: "text-green-400" };
};

/** عدّ النجاح والفشل ليس في قائمة الموظفين: يُقرأ من تفصيل الموظف حين تظهر بطاقته فقط. */
function Counts({ employeeKey }: { employeeKey: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const q = useOrg<any>(`/employees/${encodeURIComponent(employeeKey)}`, false, seen);
  const h = list(q.data?.heartbeatHistory);
  const content = !q.data ? "—" : !h.length ? "لا تنفيذات مسجّلة" : `${num(h.filter((x) => x.status === "succeeded").length)} نجح · ${num(h.filter((x) => x.status === "failed").length)} فشل · من آخر ${num(h.length)}`;
  return <span ref={ref}>{content}</span>;
}

function EmployeeCard({ e, beat, task, monthly }: { e: any; beat: any; task: any; monthly: any }) {
  const r = lastResult(e);
  const halted = String(e.permission_status ?? "").startsWith("halted");
  return (
    <Link href={`/org/employees/${encodeURIComponent(e.key)}`} className={cn(card, "p-3.5 space-y-2.5 block hover:border-primary/40 transition-colors")}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{e.name}</p>
          <p className="text-[10px] text-muted-foreground truncate font-mono" dir="ltr">{e.key}</p>
        </div>
        <Pill map={HEARTBEAT} value={e.heartbeat_status} />
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <span className={cn(pill, "border-border")}>{dept(e.department)}</span>
        <span className={cn(pill, "border-border text-muted-foreground")}>{e.title ?? e.role}</span>
        <span className={cn(pill, "border-border text-muted-foreground")}>{EXECUTION[e.execution] ?? e.execution}</span>
        {halted && <span className={cn(pill, "border-red-500/30 text-red-400")}>موقوف بمفتاح</span>}
      </div>
      {e.carried_by && <p className="text-[11px] text-muted-foreground">يحمل عمله <span dir="ltr">{e.carried_by}</span>{e.carried_by_status ? ` (${HEARTBEAT[e.carried_by_status]?.label ?? e.carried_by_status})` : ""}</p>}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <div><dt className="text-muted-foreground">الحساب</dt><dd dir="ltr" className="text-right">{e.account ?? "—"}</dd></div>
        <div><dt className="text-muted-foreground">آخر نبضة</dt><dd title={when(e.last_heartbeat)}>{ago(e.last_heartbeat)}</dd></div>
        <div><dt className="text-muted-foreground">التنفيذ التالي</dt><dd title={when(beat?.next_run_at)}>{beat?.next_run_at ? ago(beat.next_run_at) : "—"}</dd></div>
        <div><dt className="text-muted-foreground">آخر نتيجة</dt><dd className={r.cls}>{r.text}</dd></div>
        <div className="col-span-2"><dt className="text-muted-foreground">المهمة الحالية</dt><dd className="truncate" dir={task ? "ltr" : undefined}>{task ? `#${task.taskId} ${task.taskType}` : "لا مهمة تعمل الآن"}</dd></div>
        <div className="col-span-2"><dt className="text-muted-foreground">النجاح والفشل</dt><dd><Counts employeeKey={e.key} /></dd></div>
      </dl>
      {Number(e.consecutive_failures) > 0 && <p className="text-[11px] text-red-400">{num(e.consecutive_failures)} فشل متتالٍ</p>}
      {e.last_error && <p className="text-[11px] text-red-400/90 line-clamp-2" dir="auto">{e.last_error}</p>}
      <div className="grid grid-cols-2 gap-2 border-t border-card-border pt-2 text-[11px]">
        <div><p className="text-muted-foreground">الجودة والأداء: أسبوعي</p><Score value={e.weekly?.status === "INSUFFICIENT DATA" ? null : e.weekly?.score} className="text-sm" /></div>
        <div><p className="text-muted-foreground">شهري</p><Score value={monthly?.status === "INSUFFICIENT DATA" || isInsufficient(monthly?.score) ? null : monthly?.score} className="text-sm" /></div>
      </div>
    </Link>
  );
}

export default function EmployeesTab() {
  const q = useOrg<{ employees: any[] }>("/employees");
  const beats = useOrg<{ heartbeats: any[] }>("/heartbeats");
  const running = useOrg<{ tasks: any[] }>("/tasks?status=running&limit=200");
  const monthly = useOrg<{ scorecards: any[] }>("/scorecards?period=monthly", 300_000);
  const [department, setDepartment] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");

  const beatBy = useMemo(() => new Map(list(beats.data?.heartbeats).map((b) => [b.employee_key, b])), [beats.data]);
  const monthlyBy = useMemo(() => new Map(list(monthly.data?.scorecards).map((c) => [c.employeeKey, c])), [monthly.data]);

  return (
    <div className="space-y-3">
      <Q q={q} what="الموظفون">
        {(d) => {
          const all = list(d.employees);
          const departments = [...new Set(all.map((e) => String(e.department)))];
          const statuses = [...new Set(all.map((e) => String(e.heartbeat_status)))];
          const t = search.trim().toLowerCase();
          const rows = all.filter((e) => (department === "all" || e.department === department) && (status === "all" || e.heartbeat_status === status)
            && (!t || `${e.name} ${e.key} ${e.role} ${e.title ?? ""}`.toLowerCase().includes(t)));
          return (
            <>
              <div className="flex gap-2 flex-wrap items-center">
                <select className={field} value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="القسم">
                  <option value="all">كل الأقسام</option>
                  {departments.map((x) => <option key={x} value={x}>{DEPARTMENT[x] ?? CHANNEL[x] ?? x}</option>)}
                </select>
                <select className={field} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
                  <option value="all">كل الحالات</option>
                  {statuses.map((x) => <option key={x} value={x}>{HEARTBEAT[x]?.label ?? x}</option>)}
                </select>
                <input className={cn(field, "flex-1 min-w-40")} placeholder="بحث بالاسم أو المفتاح" value={search} onChange={(e) => setSearch(e.target.value)} />
                <span className="text-[11px] text-muted-foreground">{num(rows.length)} من {num(all.length)}</span>
              </div>
              {rows.length ? (
                <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {rows.map((e) => (
                    <EmployeeCard key={e.key} e={e} beat={beatBy.get(e.key)} monthly={monthlyBy.get(e.key)}
                      task={list(running.data?.tasks).find((x) => x.ownerRole === e.role)} />
                  ))}
                </div>
              ) : <div className={cn(card, "p-4")}><Empty>لا موظف بهذا الفلتر.</Empty></div>}
            </>
          );
        }}
      </Q>
    </div>
  );
}
