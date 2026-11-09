// ── مركز قيادة المنظّمة ───────────────────────────────────────────
// صفحة واحدة بسبعة تبويبات، والتبويب في الرابط. خطأ تبويبٍ يبقى داخله ولا يُسقط غيره.

import { Component, type ReactNode } from "react";
import { Link, useRoute } from "wouter";
import { BadgeCheck, Crown, Gauge, ListTodo, Network, ShieldAlert, Stethoscope, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Preparing } from "./shared";
import CommandTab from "./CommandTab";
import CeoTab from "./CeoTab";
import EmployeesTab from "./EmployeesTab";
import TasksTab from "./TasksTab";
import ApprovalsTab from "./ApprovalsTab";
import SafetyTab from "./SafetyTab";
import ReadinessTab from "./ReadinessTab";
import EmployeeDetail from "./EmployeeDetail";

const TABS = [
  { key: "command", label: "القيادة", icon: Gauge, view: CommandTab },
  { key: "ceo", label: "المدير التنفيذي", icon: Crown, view: CeoTab },
  { key: "employees", label: "الموظفون", icon: Users, view: EmployeesTab },
  { key: "tasks", label: "المهام", icon: ListTodo, view: TasksTab },
  { key: "approvals", label: "الموافقات", icon: BadgeCheck, view: ApprovalsTab },
  { key: "safety", label: "الأمان", icon: ShieldAlert, view: SafetyTab },
  { key: "readiness", label: "الجاهزية", icon: Stethoscope, view: ReadinessTab },
];

/** بيانات بشكل غير متوقع لا تُسقط التطبيق: تُحصر في التبويب. */
class Boundary extends Component<{ children: ReactNode; what?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Preparing what={this.props.what} /> : this.props.children; }
}

export default function OrgPage() {
  const [, params] = useRoute("/org/:tab");
  const [, detail] = useRoute("/org/employees/:key");
  const active = detail ? "employees" : params?.tab ?? "command";
  const tab = TABS.find((t) => t.key === active) ?? TABS[0]!;
  const View = tab.view;

  return (
    <div className="p-6 space-y-4 max-w-7xl mx-auto" dir="rtl">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0"><Network className="w-5 h-5 text-primary" /></div>
        <div>
          <h1 className="text-xl font-bold">مركز قيادة المنظّمة</h1>
          <p className="text-xs text-muted-foreground">حالة كل موظف وما ينتظر قرارك، من السجلات الحقيقية.</p>
        </div>
      </div>
      <nav className="flex gap-1.5 flex-wrap border-b border-card-border pb-3">
        {TABS.map(({ key, label, icon: Icon }) => (
          <Link key={key} href={key === "command" ? "/org" : `/org/${key}`} className={cn(
            "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors",
            tab.key === key ? "bg-primary/15 text-primary border-primary/20" : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50",
          )}><Icon className="w-3.5 h-3.5" />{label}</Link>
        ))}
      </nav>
      <Boundary key={detail ? `e:${detail.key}` : tab.key} what={tab.label}>
        {detail ? <EmployeeDetail employeeKey={decodeURIComponent(detail.key)} /> : <View />}
      </Boundary>
    </div>
  );
}
