// ── سجل الإرسال ───────────────────────────────────────────────────
// Every company email has reached, one row each: how many emails, the last
// one and when, whether they opened, clicked or replied, and the next step on
// their path with its date — or why the path ended. The owner's answer to
// "who did we write to, and what happens next with each of them".

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Eye, Loader2, MessageCircle, MousePointerClick, Reply, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { ContactDrawer } from "./EmailAgent";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("ar-AE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const STATES: Array<[string, string, string]> = [
  ["all", "الكل", ""], ["in_path", "في المسار", "text-primary"], ["replied", "ردّوا", "text-green-400"],
  ["finished", "انتهى المسار", "text-muted-foreground"], ["stopped", "أُوقفوا", "text-yellow-400"],
];
const STATE_AR: Record<string, [string, string]> = {
  in_path: ["في المسار", "bg-primary/15 text-primary"], replied: ["ردّ", "bg-green-500/15 text-green-400"],
  finished: ["انتهى المسار", "bg-muted text-muted-foreground"], stopped: ["أُوقف", "bg-yellow-500/15 text-yellow-400"],
};

export function RegisterTab() {
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const { data, isFetching } = useQuery<any>({
    queryKey: ["email-register", status, q, page],
    queryFn: () => api(`/api/email/register?status=${status}&page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`),
    refetchInterval: 30_000,
  });
  const c = data?.counts ?? {};
  const rows: any[] = data?.rows ?? [];
  const pages = Math.ceil((c[status] ?? 0) / (data?.limit ?? 100));

  return (
    <div className="space-y-3">
      {open && <ContactDrawer id={open} onClose={() => setOpen(null)} />}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {STATES.map(([k, l, tone]) => (
          <button key={k} onClick={() => { setStatus(k); setPage(0); }} className={cn(card, "p-3 text-right transition-colors", status === k ? "border-primary/60 bg-primary/5" : "hover:border-primary/30")}>
            <p className="text-[10px] text-muted-foreground">{l}</p><p className={cn("text-xl font-bold leading-none mt-1.5", tone)}>{n(c[k])}</p>
          </button>
        ))}
      </div>
      <div className={card}>
        <div className="p-3 border-b border-card-border flex gap-2 items-center">
          <div className="relative flex-1"><Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input className={cn(input, "pr-8")} placeholder="ابحث بالشركة أو البريد" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></div>
          {isFetching && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          {!rows.length ? <p className="p-10 text-center text-sm text-muted-foreground">{isFetching ? "…" : "لا أحد هنا بعد — تظهر الشركات حين تُرسل إليها أول رسالة."}</p> : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-card z-10"><tr className="text-muted-foreground">
                <th className="text-right p-2">الشركة</th><th className="text-right p-2">الحالة</th><th className="text-center p-2">رسائل</th>
                <th className="text-right p-2">آخر رسالة</th><th className="text-center p-2"><Eye className="w-3 h-3 inline" /></th><th className="text-center p-2"><MousePointerClick className="w-3 h-3 inline" /></th><th className="text-center p-2"><Reply className="w-3 h-3 inline" /></th>
                <th className="text-right p-2">الخطوة التالية</th>
              </tr></thead>
              <tbody>{rows.map((r) => {
                const [label, cls] = STATE_AR[r.state] ?? [r.state, ""];
                return (
                  <tr key={r.id} className="border-t border-card-border hover:bg-muted/20 cursor-pointer" onClick={() => setOpen(r.id)}>
                    <td className="p-2"><p className="font-medium">{r.company ?? r.name ?? "—"}</p><p className="font-mono text-muted-foreground" dir="ltr">{r.email}</p>{r.sector && <p className="text-[10px] text-muted-foreground">{r.sector}{r.city ? ` · ${r.city}` : ""}</p>}</td>
                    <td className="p-2"><span className={cn("px-2 py-0.5 rounded-full text-[10px]", cls)}>{label}</span>{r.bounced && <span className="block text-[10px] text-red-400 mt-1">ارتدّ</span>}</td>
                    <td className="p-2 text-center"><b>{n(r.sent)}</b>{r.queued > 0 && <span className="block text-[10px] text-muted-foreground">+{n(r.queued)} بالطابور</span>}</td>
                    <td className="p-2"><p className="truncate max-w-[16rem]" dir="auto">{r.lastSubject ?? "—"}</p><p className="text-[10px] text-muted-foreground">{when(r.lastSentAt)}</p></td>
                    <td className="p-2 text-center text-blue-400">{r.opens || ""}</td>
                    <td className="p-2 text-center">{r.clicks || ""}</td>
                    <td className="p-2 text-center text-green-400">{r.repliedAt ? "✓" : ""}</td>
                    <td className="p-2">{r.nextAt ? <><p>{r.nextStep}</p><p className="text-[10px] text-muted-foreground">{when(r.nextAt)} · بقي {n(r.stepsLeft)}</p></> : <span className="text-muted-foreground">{r.state === "replied" ? "تحوّل للردود" : r.state === "stopped" ? "لا رسائل بعد الآن" : r.queued ? "الرسالة الأولى بالطابور" : "—"}</span>}
                      {r.phone && r.state === "replied" && <a onClick={(e) => e.stopPropagation()} href={`https://wa.me/${String(r.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary text-[10px] mt-1"><MessageCircle className="w-3 h-3" /> واتساب</a>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </div>
        {pages > 1 && (
          <div className="p-2.5 border-t border-card-border flex items-center justify-center gap-3 text-xs">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className={ghost}><ChevronRight className="w-3 h-3" /></button>
            <span className="text-muted-foreground">صفحة {n(page + 1)} من {n(pages)}</span>
            <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className={ghost}><ChevronLeft className="w-3 h-3" /></button>
          </div>
        )}
      </div>
    </div>
  );
}
