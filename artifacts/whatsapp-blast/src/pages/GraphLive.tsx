// ── الجراف الحي ───────────────────────────────────────────────────
// The team as a living map: the manager in the middle, each desk around its
// lead, a line wherever work passes, and a pulse running down the line for
// every receipt. Hover an employee to trace who they work with; click to read
// their receipts. Everything drawn comes from the ledger — an employee with
// no receipts is drawn dim, because that is the truth about them.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";
import { GraphPanel } from "@/components/GraphPanel";

type Node = { id: string; name: string; title: string; avatar: string | null; kind: "agent" | "system"; isActive: boolean; desk: string; state: string; acts1d: number; acts14d: number; tokens14d: number; last: string | null; label: string; lastWhy: string | null };
type Edge = { from: string; to: string; kind: "org" | "flow"; n: number };
type Desk = { key: string; label: string; lead: string; members: string[] };
type Event = { id: number; at: string; node: string; edge: string | null; action: string; status: string; why: string | null; inferred: boolean; label: string };
type Live = { stats: { employees: number; active: number; withReceipts: number; desks: number; runs: number; live: number }; desks: Desk[]; nodes: Node[]; edges: Edge[]; events: Event[] };

const COLOR: Record<string, string> = { active: "#ffcf73", quiet: "#8fbfff", idle: "#566676", attention: "#ff8559", off: "#323b45" };
const STATE_AR: Record<string, string> = { active: "يعمل اليوم", quiet: "هادئ هذا الأسبوع", idle: "بلا حركة", attention: "يحتاج انتباه", off: "موقوف" };
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 60) return `قبل ${Math.max(1, m)} د`; const h = Math.round(m / 60); return h < 24 ? `قبل ${h} س` : `قبل ${Math.round(h / 24)} يوم`;
};

type P = { x: number; y: number };

/** Where everyone sits: the manager at the centre, desks on a ring, members round their lead. Pure. */
function layout(desks: Desk[], nodes: Node[]): Map<string, P> {
  const pos = new Map<string, P>();
  pos.set("chief", { x: 0, y: 0 });
  const ring = desks.filter((d) => d.key !== "system");
  const R = 560 + ring.length * 28;
  ring.forEach((d, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / ring.length;
    const lead = { x: R * Math.cos(a), y: R * Math.sin(a) };
    pos.set(d.lead, lead);
    const others = d.members.filter((m) => m !== d.lead && m !== "chief");
    const r = spreadOf(others.length);
    const spread = Math.min(Math.PI * 1.7, Math.max(Math.PI / 2, others.length * (others.length > 6 ? 0.42 : 0.62)));
    others.forEach((m, j) => {
      const t = others.length === 1 ? 0 : -spread / 2 + (j * spread) / (others.length - 1);
      pos.set(m, { x: lead.x + r * Math.cos(a + t), y: lead.y + r * Math.sin(a + t) });
    });
  });
  // The code nodes: a small arc under the manager, where messages leave.
  const sys = desks.find((d) => d.key === "system");
  sys?.members.forEach((m, j) => {
    const k = sys.members.length;
    const t = Math.PI / 2 + (k === 1 ? 0 : -0.9 + (j * 1.8) / (k - 1));
    pos.set(m, { x: 175 * Math.cos(t), y: 175 * Math.sin(t) });
  });
  for (const nd of nodes) if (!pos.has(nd.id)) pos.set(nd.id, { x: (Math.random() - 0.5) * 200, y: 260 });
  return pos;
}

/** How far a desk's members sit from their lead — more people, a wider circle. Pure. */
const spreadOf = (k: number) => 150 + k * 10;

/** A soft curve between two points, bowed to one side. Pure. */
function curve(a: P, b: P, bow = 0.16): string {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, dx = b.x - a.x, dy = b.y - a.y;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx - dy * bow).toFixed(1)},${(my + dx * bow).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

const sizeOf = (nd: Node) => (nd.kind === "system" ? 4 : 4 + Math.min(9, Math.log2(1 + nd.acts14d) * 1.4)) + (nd.id === "chief" ? 3 : 0);

export default function GraphLive() {
  const { data, isLoading, dataUpdatedAt } = useQuery<Live>({ queryKey: ["graph-live"], queryFn: () => api("/api/graph/live"), refetchInterval: 15_000 });
  const [tab, setTab] = useState<"map" | "goals" | "feed">("map");
  const [hover, setHover] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [focusDesk, setFocusDesk] = useState<string | null>(null);
  const [view, setView] = useState({ k: 0.62, x: 0, y: 0 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const pos = useMemo(() => (data ? layout(data.desks, data.nodes) : new Map<string, P>()), [data?.desks, data?.nodes]);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((x) => [x.id, x])), [data?.nodes]);
  const deskLead = useMemo(() => new Map((data?.desks ?? []).flatMap((d) => d.members.map((m) => [m, d.lead] as const))), [data?.desks]);

  // Fit the whole map into the room beside the panel, once there is a box to fit it in.
  const fit = () => {
    const el = box.current; if (!el || !pos.size) return;
    const xs = [...pos.values()].map((p) => p.x), ys = [...pos.values()].map((p) => p.y);
    const pad = 260; // labels and desk names reach past the points
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2, h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    const panel = el.clientWidth > 900 ? 430 : 0;
    const room = el.clientWidth - panel, k = Math.min(1.2, room / w, (el.clientHeight - 60) / h);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    setView({ k, x: room / 2 - cx * k, y: 30 + (el.clientHeight - 30) / 2 - cy * k });
  };
  const fitted = useRef(false);
  useEffect(() => { if (!fitted.current && pos.size && box.current) { fit(); fitted.current = true; } }, [pos]);

  // ── Pulses: a dot down the line for each receipt ─────────────────
  const [pulses, setPulses] = useState<Array<{ key: string; d: string; fresh: boolean }>>([]);
  const seen = useRef<number>(0);
  const queue = useRef<Event[]>([]);
  const cursor = useRef(0);
  const target = (e: Event) => (e.edge && pos.has(e.edge) && e.edge !== e.node ? e.edge : deskLead.get(e.node) && deskLead.get(e.node) !== e.node ? deskLead.get(e.node)! : "chief");
  const fire = (e: Event, fresh: boolean) => {
    const a = pos.get(e.node), b = pos.get(target(e));
    if (!a || !b || a === b) return;
    const key = `${e.id}-${Date.now()}`;
    setPulses((p) => [...p.slice(-40), { key, d: curve(a, b), fresh }]);
    setTimeout(() => setPulses((p) => p.filter((x) => x.key !== key)), 1900);
  };
  useEffect(() => {
    if (!data?.events.length) return;
    const newest = data.events[0]!.id;
    if (seen.current) for (const e of data.events.filter((x) => x.id > seen.current).reverse()) fire(e, true);
    seen.current = newest;
    queue.current = data.events.slice(0, 60).reverse();
  }, [dataUpdatedAt]);
  // Between real arrivals, the latest receipts replay softly so the lines show where work runs.
  useEffect(() => {
    const t = setInterval(() => {
      const q = queue.current; if (!q.length) return;
      fire(q[cursor.current % q.length]!, false); cursor.current++;
    }, 900);
    return () => clearInterval(t);
  }, [pos]);

  const { data: rows = [] } = useQuery<any[]>({ queryKey: ["graph-node", picked], queryFn: () => api(`/api/graph/receipts?limit=60&node=${encodeURIComponent(picked!)}`), enabled: !!picked });

  if (isLoading || !data) return <div className="h-screen grid place-items-center bg-[#0f1820]"><Loader2 className="w-6 h-6 animate-spin text-[#ffcf73]" /></div>;

  const linked = new Set<string>();
  const trace = hover ?? picked;
  if (trace) { linked.add(trace); for (const e of data.edges) { if (e.from === trace) linked.add(e.to); if (e.to === trace) linked.add(e.from); } }
  const deskSet = focusDesk ? new Set(data.desks.find((d) => d.key === focusDesk)?.members ?? []) : null;
  const dim = (id: string) => (trace ? !linked.has(id) : deskSet ? !deskSet.has(id) && id !== "chief" : false);
  const deskActs = (d: Desk) => d.members.reduce((a, m) => a + (byId.get(m)?.acts14d ?? 0), 0);
  const silent = data.stats.employees - data.stats.withReceipts;
  const pickedNode = picked ? byId.get(picked) : null;

  const onWheel = (e: React.WheelEvent) => {
    const r = box.current!.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    setView((v) => { const k = Math.min(2.5, Math.max(0.25, v.k * (e.deltaY < 0 ? 1.12 : 0.89))); return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }; });
  };

  return (
    <div dir="rtl" className="relative h-screen overflow-hidden text-[#dce6ee] select-none"
      style={{ background: "radial-gradient(ellipse at 35% 45%, #23384a 0%, #15222d 45%, #0b1218 100%)" }}>
      {/* Header */}
      <div className="absolute top-0 inset-x-0 z-20 flex items-center gap-6 px-6 py-4">
        <div>
          <p className="font-semibold tracking-[0.2em] text-sm">FLOW HUB</p>
          <p className="text-[11px] text-[#8aa0b3]">الجراف الحي</p>
        </div>
        <nav className="flex gap-5 text-xs text-[#9fb2c2]">
          {([["map", "الجراف"], ["goals", "أهداف الشركة"], ["feed", "النشاط"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cn("pb-1 border-b transition-colors", tab === k ? "text-white border-[#ffcf73]" : "border-transparent hover:text-white")}>{l}</button>
          ))}
        </nav>
        <span className="mr-auto flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-3 py-1 text-xs">
          <span className="w-1.5 h-1.5 rounded-full bg-[#7dffb0] animate-pulse" /> مباشر
        </span>
      </div>

      {/* The side panel */}
      <div className="absolute top-20 right-6 z-10 w-[min(360px,calc(100%-3rem))] space-y-5 pointer-events-none">
        <div>
          <h1 className="text-4xl font-light leading-tight text-white">كل حركة.<br />لها أثر.</h1>
          <p className="text-xs text-[#8aa0b3] mt-3 leading-relaxed">
            {n(data.stats.withReceipts)} من {n(data.stats.employees)} موظفاً تركوا إيصالات في آخر ١٤ يوماً.
            {silent > 0 && <> {n(silent)} بلا أي حركة — يستحقون نظرة.</>}
          </p>
        </div>
        <div className="flex gap-6 font-mono">
          {[[data.stats.employees, "موظف"], [data.stats.desks, "أقسام"], [data.stats.runs, "إيصال"]].map(([v, l]) => (
            <div key={l as string}><p className="text-2xl text-white">{n(v as number)}</p><p className="text-[10px] text-[#8aa0b3] font-sans">{l}</p></div>
          ))}
        </div>
        <div className="space-y-1.5 pointer-events-auto">
          {data.desks.filter((d) => d.key !== "system").map((d) => (
            <button key={d.key} onMouseEnter={() => setFocusDesk(d.key)} onMouseLeave={() => setFocusDesk(null)}
              className={cn("flex w-full items-center gap-2 text-xs text-right transition-colors", focusDesk === d.key ? "text-white" : "text-[#9fb2c2]")}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: deskActs(d) ? COLOR.active : COLOR.idle }} />
              {d.label}<span className="font-mono text-[10px] text-[#6f8597]">{n(d.members.length)}</span>
              <span className="mr-auto font-mono text-[10px] text-[#6f8597]">{n(deskActs(d))} إيصال</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#8aa0b3]">
          {Object.entries(STATE_AR).map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: COLOR[k] }} />{l}</span>)}
        </div>
        <button onClick={fit} className="pointer-events-auto text-[10px] text-[#9fb2c2] border border-white/15 rounded-full px-2.5 py-1 hover:text-white">إعادة الضبط</button>
        <p className="text-[10px] text-[#6f8597]">مرّر على موظف لتتبّع من يعمل معه · انقر لتقرأ إيصالاته · اسحب وكبّر بعجلة الفأرة</p>
      </div>

      {/* The map */}
      <div ref={box} className="absolute inset-0 cursor-grab active:cursor-grabbing" onWheel={onWheel}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }}
        onMouseMove={(e) => { const d = drag.current; if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y })); }}
        onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
        <svg width="100%" height="100%" style={{ direction: "ltr" }}>
          <defs>
            {Object.entries(COLOR).map(([k, c]) => (
              <radialGradient key={k} id={`glow-${k}`}><stop offset="0%" stopColor={c} stopOpacity="0.55" /><stop offset="45%" stopColor={c} stopOpacity="0.14" /><stop offset="100%" stopColor={c} stopOpacity="0" /></radialGradient>
            ))}
            <filter id="soft"><feGaussianBlur stdDeviation="1.4" /></filter>
          </defs>
          <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
            {/* Desk names, faint, above each desk */}
            {data.desks.filter((d) => d.key !== "system").map((d) => {
              const p = pos.get(d.lead); if (!p) return null;
              const out = Math.hypot(p.x, p.y) || 1;
              // On the inner side of the desk, toward the manager: the members fan outward.
              return <text key={d.key} x={p.x - (p.x / out) * 95} y={p.y - (p.y / out) * 95 + 4 / view.k} textAnchor="middle" fontSize={13 / view.k} letterSpacing={1} fill="#7f97aa" opacity={dim(d.lead) ? 0.2 : 0.75}>{d.label}</text>;
            })}
            {/* Lines */}
            {data.edges.map((e, i) => {
              const a = pos.get(e.from), b = pos.get(e.to); if (!a || !b) return null;
              const on = trace ? (e.from === trace || e.to === trace) : true;
              const flow = e.kind === "flow";
              return <path key={i} d={curve(a, b)} fill="none" stroke={flow ? "#ffcf73" : "#a9c0d4"}
                strokeWidth={flow ? 1 + Math.min(4, Math.log2(1 + e.n) * 0.6) : 0.9}
                opacity={trace ? (on ? (flow ? 0.75 : 0.5) : 0.05) : flow ? 0.32 : 0.16} />;
            })}
            {/* Pulses */}
            {pulses.map((p) => (
              <circle key={p.key} r={p.fresh ? 4.5 : 2.6} fill={p.fresh ? "#fff1cf" : "#ffd98f"} opacity={p.fresh ? 1 : 0.8} filter="url(#soft)">
                <animateMotion dur="1.7s" path={p.d} fill="freeze" />
              </circle>
            ))}
            {/* Employees */}
            {data.nodes.map((nd) => {
              const p = pos.get(nd.id); if (!p) return null;
              const s = sizeOf(nd), faded = dim(nd.id), c = COLOR[nd.state] ?? COLOR.idle;
              const right = p.x >= 0;
              return (
                <g key={nd.id} transform={`translate(${p.x},${p.y})`} opacity={faded ? 0.18 : 1} className="cursor-pointer"
                  onMouseEnter={() => setHover(nd.id)} onMouseLeave={() => setHover(null)}
                  onClick={(e) => { e.stopPropagation(); setPicked(nd.id); }} onMouseDown={(e) => e.stopPropagation()}>
                  <circle r={s * 5} fill={`url(#glow-${nd.state})`} />
                  <circle r={s} fill={c} />
                  {nd.state === "active" && <circle r={s + 3} fill="none" stroke={c} strokeOpacity={0.5}><animate attributeName="r" values={`${s + 2};${s + 9};${s + 2}`} dur="2.6s" repeatCount="indefinite" /><animate attributeName="stroke-opacity" values="0.5;0;0.5" dur="2.6s" repeatCount="indefinite" /></circle>}
                  {(nd.id === picked || nd.id === hover) && <circle r={s + 6} fill="none" stroke="#ffffff" strokeOpacity={0.7} />}
                  <text x={right ? s + 6 / view.k : -(s + 6 / view.k)} y={-1} textAnchor={right ? "start" : "end"} fontSize={(nd.id === "chief" ? 15 : 12.5) / view.k} fill="#eef4f8" fontWeight={nd.id === "chief" ? 600 : 400}>{nd.name}</text>
                  {(nd.state !== "idle" || hover === nd.id || picked === nd.id) && <text x={right ? s + 6 / view.k : -(s + 6 / view.k)} y={14 / view.k} textAnchor={right ? "start" : "end"} fontSize={10 / view.k} fill={nd.state === "attention" ? "#ffb08f" : "#8aa0b3"}>{nd.label}</text>}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      {/* Goals and activity, over the map */}
      {tab !== "map" && (
        <div className="absolute top-20 left-6 bottom-6 z-20 w-[min(560px,calc(100%-3rem))] overflow-y-auto rounded-2xl border border-white/10 bg-[#0d151c]/90 backdrop-blur p-4" dir="rtl">
          <div className="flex items-center mb-3"><p className="font-semibold">{tab === "goals" ? "أهداف الشركة" : "النشاط — آخر الإيصالات"}</p><button onClick={() => setTab("map")} className="mr-auto text-[#8aa0b3] hover:text-white"><X className="w-4 h-4" /></button></div>
          {tab === "goals" ? <GraphPanel names={Object.fromEntries(data.nodes.map((x) => [x.id, x.name]))} /> : (
            <div className="divide-y divide-white/5">
              {data.events.map((e) => (
                <button key={e.id} onClick={() => { setPicked(e.node); setTab("map"); }} className="w-full text-right py-2 text-xs space-y-0.5 hover:bg-white/5 px-1 rounded">
                  <div className="flex gap-2 items-center">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ background: e.status === "failed" ? COLOR.attention : e.status === "blocked" ? COLOR.quiet : COLOR.active }} />
                    <b className="font-medium">{byId.get(e.node)?.name ?? e.node}</b><span className="text-[#9fb2c2]">{e.label}</span>
                    {e.edge && byId.get(e.edge) && <span className="text-[#6f8597]">← {byId.get(e.edge)!.name}</span>}
                    {e.inferred && <span className="text-[9px] px-1 rounded bg-white/10 text-[#8aa0b3]">من السجل القديم</span>}
                    <span className="mr-auto text-[#6f8597]">{ago(e.at)}</span>
                  </div>
                  {e.why && <p className="text-[#8aa0b3] line-clamp-1 pr-3.5">{e.why}</p>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* One employee's receipts */}
      {pickedNode && (
        <div className="absolute bottom-6 left-6 z-30 w-[min(420px,calc(100%-3rem))] max-h-[60%] flex flex-col rounded-2xl border border-white/10 bg-[#0d151c]/95 backdrop-blur" dir="rtl">
          <div className="p-4 border-b border-white/10">
            <div className="flex items-start gap-2">
              <span className="w-2.5 h-2.5 rounded-full mt-1.5" style={{ background: COLOR[pickedNode.state] }} />
              <div className="flex-1">
                <p className="font-semibold">{pickedNode.name} <span className="text-xs font-normal text-[#8aa0b3]">· {pickedNode.title}</span></p>
                <p className="text-[11px] text-[#8aa0b3] mt-0.5">{STATE_AR[pickedNode.state]} · {data.desks.find((d) => d.key === pickedNode.desk)?.label ?? "الإدارة"}</p>
              </div>
              <button onClick={() => setPicked(null)} className="text-[#8aa0b3] hover:text-white"><X className="w-4 h-4" /></button>
            </div>
            <div className="grid grid-cols-4 gap-2 mt-3 font-mono text-center">
              {[[pickedNode.acts1d, "اليوم"], [pickedNode.acts14d, "١٤ يوماً"], [pickedNode.tokens14d, "رمز"], [null, ago(pickedNode.last)]].map(([v, l], i) => (
                <div key={i} className="rounded-lg bg-white/5 py-1.5"><p className="text-sm text-white">{v === null ? "" : n(v as number)}</p><p className="text-[9px] text-[#8aa0b3] font-sans">{l}</p></div>
              ))}
            </div>
          </div>
          <div className="overflow-y-auto divide-y divide-white/5">
            {rows.map((r: any) => (
              <div key={r.id} className="px-4 py-2 text-xs space-y-0.5">
                <div className="flex gap-2 items-center">
                  <span className={cn(r.status === "ok" ? "text-[#7dffb0]" : r.status === "failed" ? "text-[#ff8559]" : "text-[#8fbfff]")}>{r.status === "ok" ? "تم" : r.status === "failed" ? "فشل" : r.status === "blocked" ? "حُجب" : r.status}</span>
                  <span className="text-[#dce6ee]">{r.label ?? r.action}</span>
                  {r.subject && <span dir="ltr" className="text-[10px] text-[#6f8597]">{r.subject}</span>}
                  {r.model && <span className="text-[10px] text-[#6f8597]">{r.model}</span>}
                  <span className="mr-auto text-[#6f8597]">{ago(r.at)}</span>
                </div>
                {r.why && <p className="text-[#9fb2c2] line-clamp-2">{r.why}</p>}
              </div>
            ))}
            {!rows.length && <p className="p-4 text-xs text-[#8aa0b3]">لا إيصالات لهذا الموظف — لم يفعل شيئاً يُسجَّل.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
