// ── What the team did with this list ──────────────────────────────
// The chain an upload starts, as the owner follows it: ماجد cleaned it,
// سلمى read it and recommended, نورة wrote, ماجد checked, طارق prepared it
// for approval. Each recommendation shows why, and where its campaign is.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "wouter";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const STEPS = ["ماجد نظّف", "سلمى حللت", "نورة تكتب", "ماجد يراجع", "طارق يجهّز", "بانتظار موافقتك", "تُرسل"];
const stepOf = (stage: string) => ({ draft: 2, awaiting_approval: 5, sending: 6, done: 6 } as Record<string, number>)[stage] ?? 2;
const STAGE_AR: Record<string, string> = { draft: "نورة تكتب", awaiting_approval: "بانتظار موافقتك", sending: "تُرسل الآن", done: "انتهت" };

export function ListPipeline({ listId }: { listId: number }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["email-list-analysis", listId], queryFn: () => api(`/api/email/lists/${listId}/analysis`), refetchInterval: (q) => (q.state.data?.missions?.some((m: any) => m.stage === "draft") ? 8_000 : 60_000) });
  const rerun = useMutation({
    mutationFn: () => api(`/api/email/lists/${listId}/pipeline`, { method: "POST" }),
    onSuccess: () => { toast.success("بدأ الفريق العمل على القائمة"); setTimeout(() => qc.invalidateQueries({ queryKey: ["email-list-analysis", listId] }), 4000); },
  });
  const a = data?.analysis;
  const missions: any[] = data?.missions ?? [];
  const furthest = missions.length ? Math.max(...missions.map((m) => stepOf(m.stage))) : a ? 1 : -1;

  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-primary" />
        <p className="text-sm font-semibold">ماذا فعل الفريق بهذه القائمة</p>
        {data?.analyzedAt && <span className="text-[10px] text-muted-foreground">حللتها سلمى {new Date(data.analyzedAt).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</span>}
        <button onClick={() => rerun.mutate()} disabled={rerun.isPending} className="mr-auto flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border border-card-border hover:border-primary/50">
          {rerun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {a ? "أعد التحليل والتوصيات" : "ابدأ السلسلة"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        {STEPS.map((s, i) => (
          <span key={s} className={cn("px-2 py-0.5 rounded-full border", i <= furthest ? "border-primary/40 bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}>{s}</span>
        ))}
      </div>
      {!a && <p className="text-xs text-muted-foreground">لم تُحلل بعد. كل قائمة تُرفع من الآن تبدأ سلسلتها تلقائياً.</p>}
      {a && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
            {[["العناوين", a.total], ["يمكن مراسلتهم", a.sendable], ["راسلناهم من قبل", a.alreadyWritten], ["نطاق ميت", a.deadDomain], ["عالي الخطورة", a.risk?.high]].map(([l, v]: any) => (
              <div key={l} className="rounded-lg bg-muted/40 p-2"><p className="text-[10px] text-muted-foreground">{l}</p><p className="font-bold mt-0.5">{n(v)}</p></div>
            ))}
          </div>
          {!!a.problems?.length && <ul className="text-xs text-yellow-300/90 space-y-1">{a.problems.map((p: string) => <li key={p}>• {p}</li>)}</ul>}
          <div className="space-y-2">
            <p className="text-xs font-semibold">توصيات سلمى</p>
            {!a.recommendations?.length && <p className="text-xs text-muted-foreground">لا شريحة كبيرة بما يكفي لحملة خاصة (١٥ شركة على الأقل).</p>}
            {a.recommendations?.map((r: any) => {
              const m = missions.find((x) => x.name?.startsWith(`${r.sector} —`));
              return (
                <div key={r.sector} className="rounded-lg border border-card-border p-3 text-xs space-y-1">
                  <div className="flex items-center gap-2"><b>{r.sector}</b><span className="text-muted-foreground">{n(r.n)} لم يُراسَلوا</span>
                    {m && <span className="mr-auto px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px]">{STAGE_AR[m.stage] ?? m.stage}</span>}</div>
                  <p className="text-foreground/90">{r.angle}</p>
                  {r.insight && <p className="text-muted-foreground">{r.insight}</p>}
                  <p className="text-[10px] text-muted-foreground">{r.why}</p>
                </div>
              );
            })}
          </div>
          {missions.some((m) => m.stage === "awaiting_approval") && (
            <Link href="/email" className="block text-center text-xs py-2 rounded-lg bg-primary text-primary-foreground font-medium">راجع ووافق على الحملات الجاهزة ←</Link>
          )}
        </>
      )}
    </div>
  );
}
