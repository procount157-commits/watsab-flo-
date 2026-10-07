// ── The graph at a glance ─────────────────────────────────────────
// The goal and its pace, what it is costing (the counter-measures), who did
// what today by their receipts, whether the ledger is intact, and the one
// switch that stops the whole team. The owner should be able to tell from
// this alone what happened today and why.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Target, ShieldCheck, ShieldAlert, Power, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const STATE: Record<string, [string, string]> = {
  on_track: ["على المسار", "text-green-400"], behind: ["متأخر", "text-orange-400"], done: ["تحقق", "text-primary"], missed: ["فات موعده", "text-red-400"],
};
const STATUS: Record<string, string> = { ok: "تم", failed: "فشل", blocked: "حُجب", retried: "أُعيد", deferred: "أُجّل" };

export function GraphPanel({ names = {} }: { names?: Record<string, string> }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["graph"], queryFn: () => api("/api/graph"), refetchInterval: 60_000 });
  const [open, setOpen] = useState<string | null>(null);
  const { data: rows = [] } = useQuery<any[]>({ queryKey: ["graph-receipts", open], queryFn: () => api(`/api/graph/receipts?limit=40${open ? `&node=${encodeURIComponent(open)}` : ""}`), enabled: open !== null });
  const pause = useMutation({
    mutationFn: (paused: boolean) => api("/api/graph/team", { method: "PATCH", body: JSON.stringify({ paused }) }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["graph"] }); toast.success(d.paused ? "أُوقف الفريق كله" : "عاد الفريق للعمل"); },
  });
  if (!data) return null;
  const who = (node: string) => names[node] ?? ({ router: "الفرز الآلي", gate: "بوابة الإرسال", sender: "المُرسِل", campaign: "الحملات", owner: "أنت" } as Record<string, string>)[node] ?? node;

  return (
    <div className="space-y-3">
      {data.goals.map((g: any) => {
        const p = g.progress, pct = Math.min(100, Math.round((p.current / Math.max(1, p.target)) * 100));
        const [label, cls] = STATE[p.state] ?? ["", ""];
        return (
          <div key={g.id} className={cn(card, "p-4 space-y-3")}>
            <div className="flex items-center gap-2 flex-wrap">
              <Target className="w-4 h-4 text-primary" />
              <p className="font-semibold">{g.title}</p>
              <span className={cn("text-xs font-medium", cls)}>{label}</span>
              <span className="text-xs text-muted-foreground mr-auto">باقي {n(p.daysLeft)} يوماً · المطلوب {p.perWeek.toLocaleString("ar-SA")} أسبوعياً</span>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>{g.label}: <b>{n(p.current)}</b> من {n(p.target)}</span><span className="text-muted-foreground">المتوقع الآن {p.expected.toLocaleString("ar-SA")}</span></div>
              <div className="h-2 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
              <p className="text-[10px] text-muted-foreground mt-1">يُحسب من الصفقات التي تضعها أنت «مكتملة» — لا يكتبه أي موظف.</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
              {g.leading.map((m: any) => <div key={m.key} className="rounded-lg bg-muted/40 p-2"><p className="text-[10px] text-muted-foreground">{m.label}</p><p className="font-bold mt-0.5">{n(m.value)}</p></div>)}
              {g.counters.map((m: any) => <div key={m.key} className="rounded-lg bg-orange-500/10 border border-orange-500/20 p-2"><p className="text-[10px] text-orange-300">ثمنه: {m.label}</p><p className="font-bold mt-0.5">{m.value.toLocaleString("ar-SA")}{m.unit}</p></div>)}
            </div>
          </div>
        );
      })}

      <div className={cn(card, "p-4 space-y-3")}>
        <div className="flex items-center gap-2 flex-wrap">
          <Receipt className="w-4 h-4 text-primary" />
          <p className="font-semibold">الإيصالات — ماذا فعل كل موظف</p>
          <span className={cn("text-[11px] flex items-center gap-1", data.ledger.firstBroken == null ? "text-green-400" : "text-red-400")}>
            {data.ledger.firstBroken == null ? <><ShieldCheck className="w-3.5 h-3.5" /> السجل سليم ({n(data.ledger.receipts)} إيصال)</> : <><ShieldAlert className="w-3.5 h-3.5" /> السجل عُبث به عند الإيصال {data.ledger.firstBroken}</>}
          </span>
          <button onClick={() => pause.mutate(!data.teamPaused)} disabled={pause.isPending}
            className={cn("mr-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border", data.teamPaused ? "border-green-500/40 text-green-400" : "border-red-500/40 text-red-400")}>
            <Power className="w-3.5 h-3.5" /> {data.teamPaused ? "تشغيل الفريق" : "إيقاف الفريق كله"}
          </button>
        </div>
        {data.teamPaused && <p className="text-xs text-red-400">الفريق كله موقوف: لا يفكر أي موظف ولا يكتب شيئاً حتى تعيد تشغيله.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground text-right"><th className="py-1.5 font-normal">الموظف</th><th className="font-normal">اليوم</th><th className="font-normal">١٤ يوماً</th><th className="font-normal">نجح / حُجب / فشل</th><th className="font-normal">رموز</th><th className="font-normal">آخر حركة</th></tr></thead>
            <tbody>
              {data.fortnight.map((r: any) => {
                const t = data.today.find((x: any) => x.node === r.node);
                return (
                  <tr key={r.node} onClick={() => setOpen(open === r.node ? null : r.node)} className={cn("border-t border-card-border cursor-pointer hover:bg-muted/30", open === r.node && "bg-primary/5")}>
                    <td className="py-1.5">{who(r.node)}</td><td>{n(t?.acts)}</td><td>{n(r.acts)}</td>
                    <td><span className="text-green-400">{n(r.ok)}</span> / <span className="text-orange-400">{n(r.blocked)}</span> / <span className="text-red-400">{n(r.failed)}</span></td>
                    <td>{n(r.tokens)}</td><td className="text-muted-foreground">{new Date(r.last).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {open && (
          <div className="rounded-lg border border-card-border max-h-80 overflow-y-auto divide-y divide-card-border">
            {rows.map((r: any) => (
              <div key={r.id} className="p-2 text-xs space-y-0.5">
                <div className="flex gap-2 items-center flex-wrap">
                  <span className="font-mono text-[10px] text-muted-foreground">{r.action}</span>
                  <span className={cn(r.status === "ok" ? "text-green-400" : r.status === "failed" ? "text-red-400" : "text-orange-400")}>{STATUS[r.status] ?? r.status}</span>
                  {r.model && <span className="text-muted-foreground">{r.model}</span>}
                  {r.inferred && <span className="text-[10px] px-1 rounded bg-muted text-muted-foreground">مستنتج من السجل القديم</span>}
                  <span className="text-muted-foreground mr-auto">{new Date(r.at).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</span>
                </div>
                {r.why && <p className="text-muted-foreground line-clamp-2">{r.why}</p>}
              </div>
            ))}
            {!rows.length && <p className="p-3 text-xs text-muted-foreground">لا إيصالات.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
