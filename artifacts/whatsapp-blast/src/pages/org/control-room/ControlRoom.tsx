// ── غرفة تحكّم المالك ─────────────────────────────────────────────
// مكالمة مع المدير التنفيذي أو أي موظف، واجتماع يديره المدير، وسجلّ ما مضى بنصّه وملخصه
// وتذاكره. الجاهزية في الأعلى كما يقولها الخادم: ما هو محجوب يقال محجوباً وبما ينقصه.

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { History, PhoneCall, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pill, Q, READINESS, Section, card, dept, list, useOrg, when } from "../shared";
import CallScreen, { ActionItems, CallState, Transcript } from "./CallScreen";
import MeetingRoom, { Room } from "./MeetingRoom";
import { voice } from "./voice";

function Readiness() {
  const q = useOrg<any>("/voice/readiness", 60_000);
  return (
    <Q q={q} what="جاهزية الصوت">
      {(d) => (
        <div className={cn(card, "p-3 flex gap-2 flex-wrap text-[11px]")}>
          {list(d.items).map((i: any) => (
            <span key={i.id} className="inline-flex items-center gap-1.5" title={`${i.detail}${list(i.missing).length ? `\nينقص: ${list(i.missing).join("، ")}` : ""}`}>
              <Pill map={READINESS} value={i.status} /> {i.title}
            </span>
          ))}
        </div>
      )}
    </Q>
  );
}

function CallHistory({ employees }: { employees: any[] }) {
  const q = useOrg<any>("/voice/calls?limit=30", 30_000);
  const [open, setOpen] = useState<any>(null);
  const names = new Map(employees.map((e) => [e.key, e.name]));
  return (
    <Section title="سجل المكالمات">
      <Q q={q} what="المكالمات">
        {(d) => list(d.calls).length === 0 ? <Empty>لا مكالمات بعد.</Empty> : (
          <div className="space-y-1">
            {list(d.calls).map((c: any) => (
              <button key={c.id} className="w-full text-right flex items-center gap-2 flex-wrap text-xs border border-card-border rounded-lg px-3 py-2 hover:border-primary/40"
                onClick={async () => setOpen(await voice(`/calls/${c.id}`))}>
                <span>#{c.id}</span><span className="font-medium">{c.employee_name ?? c.employee_key}</span><span className="text-muted-foreground">{dept(c.department)}</span>
                <CallState value={c.state} />{c.state_reason && <span className="text-muted-foreground">{c.state_reason}</span>}
                <span className="mr-auto text-muted-foreground">{when(c.started_at)} · {c.turns} أدوار · {c.action_items} بنود</span>
              </button>
            ))}
          </div>
        )}
      </Q>
      {open && (
        <div className="mt-3 border-t border-card-border pt-3 space-y-2">
          <div className="text-xs font-medium">المكالمة #{open.call.id} مع {names.get(open.call.employee_key) ?? open.call.employee_key}</div>
          <Transcript lines={list(open.transcript).map((l: any) => ({ ...l, name: names.get(l.employee_key) }))} audioPath={() => null} playing={null} onPlay={() => {}} />
          {open.call.summary && <p className="text-xs whitespace-pre-wrap"><span className="text-muted-foreground">الملخص: </span>{open.call.summary}</p>}
          <ActionItems items={list(open.actionItems)} tickets={list(open.tickets)} />
        </div>
      )}
    </Section>
  );
}

function MeetingHistory({ employees, onOpen }: { employees: any[]; onOpen: (d: any) => void }) {
  const q = useOrg<any>("/voice/meetings?limit=30", 30_000);
  return (
    <Section title="سجل الاجتماعات">
      <Q q={q} what="الاجتماعات">
        {(d) => list(d.meetings).length === 0 ? <Empty>لا اجتماعات بعد.</Empty> : (
          <div className="space-y-1">
            {list(d.meetings).map((m: any) => (
              <button key={m.id} className="w-full text-right flex items-center gap-2 flex-wrap text-xs border border-card-border rounded-lg px-3 py-2 hover:border-primary/40"
                onClick={async () => onOpen(await voice(`/meetings/${m.id}`))}>
                <span>#{m.id}</span><span className="font-medium">{m.objective}</span>
                <span className="text-muted-foreground">{m.state === "scheduled" ? `مجدول ${when(m.scheduled_at)}` : m.state === "in_progress" ? "جارٍ" : m.state === "cancelled" ? "أُلغي" : "انتهى"}</span>
                <span className="mr-auto text-muted-foreground">{when(m.started_at ?? m.scheduled_at)} · {m.attendees} حضور · {m.action_items} بنود</span>
              </button>
            ))}
          </div>
        )}
      </Q>
    </Section>
  );
}

const VIEWS = [
  { key: "call", label: "مكالمة", icon: PhoneCall },
  { key: "meeting", label: "اجتماع", icon: Users },
  { key: "history", label: "السجل", icon: History },
] as const;

export default function ControlRoom() {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const initialKey = params.get("call");
  const [view, setView] = useState<(typeof VIEWS)[number]["key"]>("call");
  const [meeting, setMeeting] = useState<any>(null);
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ["org"] });
  const emps = useOrg<any>("/voice/employees", 60_000);
  return (
    <div className="space-y-4" dir="rtl">
      <Readiness />
      <nav className="flex gap-1.5 overflow-x-auto">
        {VIEWS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setView(key)} className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border whitespace-nowrap flex-shrink-0",
            view === key ? "bg-primary/15 text-primary border-primary/20" : "border-card-border text-muted-foreground hover:text-foreground")}><Icon className="w-3.5 h-3.5" />{label}</button>
        ))}
      </nav>
      <Q q={emps} what="الموظفون">
        {(d) => {
          const employees = list(d.employees);
          if (view === "call") return <CallScreen employees={employees} initialKey={initialKey} onChanged={refresh} />;
          if (view === "meeting") return meeting
            ? <div className="space-y-3"><button className="text-xs text-primary" onClick={() => setMeeting(null)}>← اجتماع جديد</button><Room data={meeting} setData={setMeeting} employees={employees} onChanged={refresh} /></div>
            : <MeetingRoom employees={employees} onChanged={refresh} />;
          return (
            <div className="space-y-4">
              <CallHistory employees={employees} />
              <MeetingHistory employees={employees} onOpen={(m) => { setMeeting(m); setView("meeting"); }} />
            </div>
          );
        }}
      </Q>
    </div>
  );
}
