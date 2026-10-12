// ── تصنيف العملاء — ريم تقرأ المحادثات ──────────────────────────
// Every conversation read and filed: how warm, which piece, the dialect, a
// one-line summary and the next step. A label can be turned into a list.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Play, ListPlus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const COLOR: Record<string, string> = { hot: "text-green-400 bg-green-500/10 border-green-500/30", order: "text-primary bg-primary/10 border-primary/30", price: "text-yellow-300 bg-yellow-500/10 border-yellow-500/30", photo: "text-blue-300 bg-blue-500/10 border-blue-500/30", question: "text-muted-foreground bg-muted/40 border-border", cold: "text-muted-foreground bg-muted/40 border-border", refused: "text-red-400 bg-red-500/10 border-red-500/30", machine: "text-muted-foreground bg-muted/40 border-border", not_customer: "text-muted-foreground bg-muted/40 border-border", silent: "text-orange-300 bg-orange-500/10 border-orange-500/30" };
const DIALECT: Record<string, string> = { gulf: "خليجي", yemeni: "يمني", egyptian: "مصري", levant: "شامي", maghreb: "مغاربي", msa: "فصحى", en: "إنجليزي" };

export default function Review() {
  const qc = useQueryClient();
  const [label, setLabel] = useState<string>("all");
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery<any>({ queryKey: ["reviews"], queryFn: () => api("/api/graph/review") });
  const run = useMutation({
    mutationFn: (onlyStale: boolean) => api("/api/graph/review/run", { method: "POST", body: JSON.stringify({ onlyStale }) }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["reviews"] }); toast.success(`قرأت ريم ${d.reviewed} محادثة${d.failed ? ` (${d.failed} تعذّرت)` : ""}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const file = useMutation({
    mutationFn: (l: string) => api("/api/graph/review/file", { method: "POST", body: JSON.stringify({ label: l }) }),
    onSuccess: (d: any) => toast.success(`أُضيف ${d.added} رقماً إلى القائمة`),
    onError: (e: Error) => toast.error(e.message),
  });
  const labels: Record<string, string> = data?.labels ?? {};
  const rows: any[] = (data?.rows ?? []).filter((r: any) => (label === "all" || r.label === label) && (!q || `${r.phone} ${r.saved_name ?? ""} ${r.piece ?? ""} ${r.summary ?? ""}`.includes(q)));
  const counts = (data?.rows ?? []).reduce((m: Record<string, number>, r: any) => { m[r.label] = (m[r.label] ?? 0) + 1; return m; }, {});

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-start gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">تصنيف العملاء</h1>
          <p className="text-sm text-muted-foreground mt-1">ريم تقرأ كل محادثة كاملة — كلامنا وكلامهم — وتكتب من هو وماذا يريد وما الخطوة التالية. الدرجة: قربه من الشراء.</p>
        </div>
        <div className="mr-auto flex gap-2">
          <button onClick={() => run.mutate(true)} disabled={run.isPending} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-card-border hover:border-primary/50 disabled:opacity-50">{run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} اقرئي الجديد فقط</button>
          <button onClick={() => run.mutate(false)} disabled={run.isPending} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground disabled:opacity-50">{run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} اقرئي كل المحادثات</button>
        </div>
      </div>
      {run.isPending && <p className="text-xs text-muted-foreground">ريم تقرأ محادثة محادثة — قد تأخذ دقيقة لكل ٢٠ محادثة.</p>}
      <div className="flex gap-1.5 flex-wrap">
        <button onClick={() => setLabel("all")} className={cn("px-3 py-1.5 rounded-full border text-xs", label === "all" ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>الكل ({data?.rows?.length ?? 0})</button>
        {Object.entries(labels).map(([k, v]) => (
          <button key={k} onClick={() => setLabel(k)} className={cn("px-3 py-1.5 rounded-full border text-xs", label === k ? COLOR[k] : "border-card-border text-muted-foreground")}>{v} ({counts[k] ?? 0})</button>
        ))}
      </div>
      <div className="flex gap-2 items-center">
        <div className="relative flex-1 max-w-sm"><Search className="w-3.5 h-3.5 absolute right-2.5 top-2.5 text-muted-foreground" /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="بحث برقم أو اسم أو قطعة" className="w-full pr-8 pl-3 py-2 bg-input border border-border rounded-lg text-xs" /></div>
        {label !== "all" && <button onClick={() => file.mutate(label)} disabled={file.isPending} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-card-border hover:border-primary/50"><ListPlus className="w-3.5 h-3.5" /> اجعل «{labels[label]}» قائمة أرقام</button>}
      </div>
      {isLoading ? <div className="py-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div> : !rows.length ? (
        <div className={cn(card, "p-8 text-center text-sm text-muted-foreground")}>لا تصنيفات بعد — اضغط «اقرئي كل المحادثات».</div>
      ) : (
        <div className={cn(card, "divide-y divide-card-border")}>
          {rows.map((r: any) => (
            <div key={r.phone} className="p-3 text-sm space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn("text-[11px] px-2 py-0.5 rounded-full border", COLOR[r.label] ?? "")}>{labels[r.label] ?? r.label}</span>
                <b className="font-mono text-xs" dir="ltr">+{String(r.phone).split(":")[0]}</b>
                {r.saved_name && <span className="text-xs text-muted-foreground">{r.saved_name}</span>}
                <span className="text-xs font-bold">{r.score}/100</span>
                {r.piece && <span className="text-xs text-primary">{r.piece}</span>}
                {r.dialect && <span className="text-[10px] px-1.5 rounded bg-muted text-muted-foreground">{DIALECT[r.dialect] ?? r.dialect}</span>}
                <span className="mr-auto text-[10px] text-muted-foreground">{r.msg_count} رسالة · آخرها {r.last_at ? new Date(r.last_at).toLocaleDateString("ar-AE") : "—"}</span>
              </div>
              <p className="text-foreground/90">{r.summary}</p>
              {r.next_action && <p className="text-xs text-muted-foreground">← {r.next_action}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
