// التذاكر: كل عملٍ تذكرة، وكل فعلٍ سطرٌ تحتها. قائمة ولوحة، المتأخرة، صندوقك، ومخطط الاعتماد.
// التفاصيل في المكان نفسه (?ticket=رقم في الرابط)، فالرابط يُرسل ويُفتح على التذكرة.

import { useEffect, useMemo, useState } from "react";
import { Clock, Columns3, GitBranch, Inbox, LayoutList, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { DEPARTMENT, Empty, Q, Section, card, field, list, num, useOrg } from "../shared";
import { COLUMNS, PRIORITY, STATUS, TicketCard, titleOf, Badge } from "./parts";
import TicketDetail from "./TicketDetail";

const VIEWS = [
  { key: "list", label: "القائمة", icon: LayoutList },
  { key: "board", label: "اللوحة", icon: Columns3 },
  { key: "overdue", label: "المتأخرة", icon: Clock },
  { key: "inbox", label: "صندوقك", icon: Inbox },
  { key: "graph", label: "الاعتماد", icon: GitBranch },
] as const;
type View = (typeof VIEWS)[number]["key"];

const readParam = (k: string) => { try { return new URLSearchParams(window.location.search).get(k); } catch { return null; } };
function writeParam(k: string, v: string | null) {
  try {
    const u = new URL(window.location.href);
    if (v == null) u.searchParams.delete(k); else u.searchParams.set(k, v);
    window.history.replaceState(window.history.state, "", u.toString());
  } catch { /* الرابط لا يُحدَّث، والصفحة تعمل */ }
}

export default function TicketsTab() {
  const [view, setView] = useState<View>(() => (VIEWS.some((v) => v.key === readParam("view")) ? readParam("view") as View : "list"));
  const [open, setOpen] = useState<number | null>(() => (/^\d+$/.test(readParam("ticket") ?? "") ? Number(readParam("ticket")) : null));
  useEffect(() => { writeParam("ticket", open == null ? null : String(open)); }, [open]);
  useEffect(() => { writeParam("view", view === "list" ? null : view); }, [view]);

  if (open != null) return <TicketDetail id={open} onBack={() => setOpen(null)} onOpen={setOpen} />;
  return (
    <div className="space-y-3">
      <div className="flex gap-1.5 flex-wrap">
        {VIEWS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setView(key)} className={cn("inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs",
            view === key ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground")}><Icon className="w-3.5 h-3.5" />{label}</button>
        ))}
      </div>
      {view === "inbox" ? <OwnerInbox onOpen={setOpen} /> : view === "graph" ? <Graph onOpen={setOpen} /> : <Browse view={view} onOpen={setOpen} />}
    </div>
  );
}

// ── القائمة واللوحة والمتأخرة ──────────────────────────────────────
function Browse({ view, onOpen }: { view: View; onOpen: (id: number) => void }) {
  const [status, setStatus] = useState("");
  const [department, setDepartment] = useState("");
  const [priority, setPriority] = useState("");
  const [employee, setEmployee] = useState("");
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const [ops, setOps] = useState(false);
  useEffect(() => { const h = setTimeout(() => setSearch(text.trim()), 350); return () => clearTimeout(h); }, [text]);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ limit: "300" });
    if (status && view === "list") p.set("status", status);
    if (department) p.set("department", department);
    if (priority) p.set("priority", priority);
    if (employee.trim()) p.set("employee", employee.trim());
    if (search) p.set("q", search);
    if (view === "overdue") p.set("overdue", "1");
    if (ops) p.set("ops", "1");
    return p.toString();
  }, [status, department, priority, employee, search, view, ops]);
  const q = useOrg<{ tickets: any[]; total: number }>(`/tickets?${qs}`, 20_000);
  const queues = useOrg<{ departments: any[] }>("/tickets/queues", 60_000);

  return (
    <div className="space-y-3">
      <div className={cn(card, "p-3 flex gap-2 flex-wrap items-center")}>
        <div className="relative w-full sm:w-auto">
          <Search className="w-3.5 h-3.5 absolute right-2.5 top-2.5 text-muted-foreground" />
          <input className={cn(field, "pr-8 w-full sm:w-56")} placeholder="بحث بالعنوان أو الرقم أو النوع" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {view === "list" && (
          <select className={field} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="الحالة">
            <option value="">كل الحالات</option>
            {Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        )}
        <select className={field} value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="القسم">
          <option value="">كل الأقسام</option>
          {Object.entries(DEPARTMENT).filter(([k]) => k !== "social").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className={field} value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="الأولوية">
          <option value="">كل الأولويات</option>
          {Object.entries(PRIORITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input className={cn(field, "w-full sm:w-48")} dir="ltr" placeholder="employee key" value={employee} onChange={(e) => setEmployee(e.target.value)} aria-label="الموظف" />
        <label className="text-xs text-muted-foreground inline-flex items-center gap-1.5 mr-auto">
          <input type="checkbox" checked={ops} onChange={(e) => setOps(e.target.checked)} /> سجلات العمليات اليومية
        </label>
      </div>

      {view !== "overdue" && (
        <Q q={queues} what="طوابير الأقسام">
          {(d) => list(d.departments).length ? (
            <div className="flex gap-2 flex-wrap">
              {d.departments.map((x: any) => (
                <button key={x.department} onClick={() => setDepartment(department === x.department ? "" : x.department)}
                  className={cn(card, "px-3 py-2 text-right text-xs", department === x.department && "border-primary/60")}>
                  <span className="font-medium">{DEPARTMENT[x.department] ?? x.department}</span>
                  <span className="text-muted-foreground"> · مفتوحة {num(x.open)}</span>
                  {x.overdue > 0 && <span className="text-red-400"> · متأخرة {num(x.overdue)}</span>}
                </button>
              ))}
            </div>
          ) : null}
        </Q>
      )}

      <Q q={q} what="التذاكر">
        {(d) => {
          const rows = list(d.tickets);
          if (!rows.length) return <div className={cn(card, "p-4")}><Empty>{view === "overdue" ? "لا تذاكر متأخرة." : "لا تذاكر بهذا الفلتر."}</Empty></div>;
          if (view === "board") return <Board rows={rows} onOpen={onOpen} />;
          return (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground">{num(rows.length)} من {num(d.total)}</p>
              {rows.map((t) => <TicketCard key={t.taskId} t={t} onOpen={onOpen} />)}
            </div>
          );
        }}
      </Q>
    </div>
  );
}

function Board({ rows, onOpen }: { rows: any[]; onOpen: (id: number) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2 items-start">
      {COLUMNS.map((c) => {
        const items = rows.filter((t) => c.statuses.includes(t.status));
        return (
          <div key={c.key} className="rounded-xl border border-card-border bg-muted/20 p-2 space-y-2 min-w-0">
            <p className="text-xs font-semibold px-1">{c.label} <span className="text-muted-foreground font-normal">{num(items.length)}</span></p>
            {items.length ? items.map((t) => (
              <div key={t.taskId} className="space-y-1">
                <TicketCard t={t} onOpen={onOpen} compact />
                {c.statuses.length > 1 && <div className="px-1"><Badge map={STATUS} value={t.status} /></div>}
              </div>
            )) : <p className="text-[11px] text-muted-foreground px-1">—</p>}
          </div>
        );
      })}
    </div>
  );
}

// ── صندوق صاحب العمل ──────────────────────────────────────────────
function OwnerInbox({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useOrg<any>("/tickets/inbox", 20_000);
  return (
    <Q q={q} what="صندوقك">
      {(d) => (
        <div className="space-y-3">
          <Section title={`تنتظر موافقتك (${num(d.counts?.approvals)})`}>
            {list(d.approvals).length ? d.approvals.map((t: any) => <TicketCard key={t.taskId} t={t} onOpen={onOpen} />) : <Empty>لا شيء ينتظر موافقتك.</Empty>}
          </Section>
          <Section title={`تنتظر قرارك (${num(d.counts?.waitingForOwner)})`}>
            {list(d.waitingForOwner).length ? d.waitingForOwner.map((t: any) => (
              <div key={t.taskId} className="space-y-1">
                <TicketCard t={t} onOpen={onOpen} />
                {t.nextAction && <p className="text-[11px] text-muted-foreground px-1" dir="auto">السؤال: {t.nextAction}</p>}
              </div>
            )) : <Empty>لا أسئلة لك.</Empty>}
          </Section>
          <Section title={`تستحق نظرك (${num(d.counts?.escalations)})`}>
            <p className="text-[11px] text-muted-foreground">المحجوبة، والميتة في آخر أسبوعين، والمتأخرة من الحرجة والعالية.</p>
            {list(d.escalations).length ? d.escalations.map((t: any) => <TicketCard key={t.taskId} t={t} onOpen={onOpen} />) : <Empty>لا شيء.</Empty>}
          </Section>
        </div>
      )}
    </Q>
  );
}

// ── مخطط الاعتماد ─────────────────────────────────────────────────
/** طبقاتٌ بالعمق: ما لا يعتمد على شيء أولاً. بلا مكتبة رسم. */
function layers(nodes: any[], edges: any[]): any[][] {
  const incoming = new Map<number, number[]>();
  for (const e of edges) incoming.set(e.to, [...(incoming.get(e.to) ?? []), e.from]);
  const depth = new Map<number, number>();
  const ids = new Set(nodes.map((n) => n.id));
  const level = (id: number, seen = new Set<number>()): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const from = (incoming.get(id) ?? []).filter((x) => ids.has(x));
    const d = from.length ? Math.max(...from.map((x) => level(x, seen))) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  const out: any[][] = [];
  for (const n of nodes) { const d = Math.min(level(n.id), 8); (out[d] ??= []).push(n); }
  return out.filter(Boolean);
}

function Graph({ onOpen }: { onOpen: (id: number) => void }) {
  const [root, setRoot] = useState("");
  const q = useOrg<{ nodes: any[]; edges: any[] }>(`/tickets/graph${/^\d+$/.test(root.trim()) ? `?root=${root.trim()}` : ""}`, 30_000);
  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center flex-wrap">
        <input className={cn(field, "w-full sm:w-40")} dir="ltr" placeholder="ticket #" value={root} onChange={(e) => setRoot(e.target.value)} aria-label="جذر المخطط" />
        <p className="text-[11px] text-muted-foreground">بلا رقم: المفتوحة وما تنتظره. برقم: التذكرة وأبناؤها واعتمادها في الاتجاهين.</p>
      </div>
      <Q q={q} what="المخطط">
        {(d) => {
          const nodes = list(d.nodes), edges = list(d.edges);
          if (!nodes.length) return <div className={cn(card, "p-4")}><Empty>لا تذاكر مفتوحة ولا اعتماد.</Empty></div>;
          const byTo = new Map<number, any[]>();
          for (const e of edges) byTo.set(e.to, [...(byTo.get(e.to) ?? []), e]);
          return (
            <div className="flex gap-3 overflow-x-auto pb-2" dir="rtl">
              {layers(nodes, edges).map((col, i) => (
                <div key={i} className="min-w-[15rem] space-y-2">
                  <p className="text-[11px] text-muted-foreground">{i === 0 ? "لا تنتظر شيئاً" : `المستوى ${num(i)}`}</p>
                  {col.map((n: any) => (
                    <button key={n.id} onClick={() => onOpen(n.id)} className={cn(card, "w-full text-right p-2.5 space-y-1 hover:border-primary/50", n.overdue && "border-red-500/40")}>
                      <div className="flex items-center gap-1.5 flex-wrap text-xs">
                        <span className="text-muted-foreground" dir="ltr">#{n.id}</span>
                        <b className="truncate min-w-0 max-w-[10rem]" dir="auto">{titleOf({ title: n.title, taskType: n.title })}</b>
                        <Badge map={STATUS} value={n.status} />
                      </div>
                      <p className="text-[10px] text-muted-foreground" dir="ltr">{n.assignedTo ?? "—"}</p>
                      {(byTo.get(n.id) ?? []).map((e) => (
                        <p key={`${e.from}-${e.kind}`} className="text-[10px] text-muted-foreground">{e.kind === "dependency" ? "تنتظر" : "سلّمتها"} <span dir="ltr">#{e.from}</span></p>
                      ))}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          );
        }}
      </Q>
    </div>
  );
}
