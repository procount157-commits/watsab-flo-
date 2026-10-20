// ── سيف، فاحص الأرقام — بطاقة القائمة ─────────────────────────────
// حكمه على أرقام القائمة: كم جاهز، كم «ليس الآن» ولماذا، كم مرفوض ولماذا،
// آخر جولة، وزرٌّ يطلب جولة الآن. لا حملة تُرسَل إلا إلى الجاهزين.
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ShieldCheck, RefreshCw } from "lucide-react";
import { api } from "@/components/AgentPanel";
import { cn } from "@/lib/utils";

const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" }) : "—");
const num = (v: number | null | undefined) => (v ?? 0).toLocaleString("ar-EG");

export const VERDICT: Record<string, { label: string; cls: string }> = {
  ready: { label: "جاهز", cls: "bg-green-500/10 text-green-400" },
  hold: { label: "ليس الآن", cls: "bg-yellow-500/10 text-yellow-400" },
  rejected: { label: "مرفوض", cls: "bg-red-500/10 text-red-400" },
};

export default function VettingCard({ groupId, onChanged }: { groupId: number; onChanged?: () => void }) {
  const qc = useQueryClient();
  const key = ["contacts", groupId, "vetting"];
  const { data, isLoading } = useQuery<any>({ queryKey: key, queryFn: () => api(`/api/contacts/${groupId}/vetting`), refetchInterval: (q: any) => (q.state.data?.unvetted ?? 0) > 0 ? 5_000 : 60_000 });
  const run = useMutation({
    mutationFn: (all: boolean) => api(`/api/contacts/${groupId}/vet`, { method: "POST", body: JSON.stringify({ all }) }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: key }); onChanged?.(); toast.success(r?.run?.note ?? "تم الفحص"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (isLoading || !data) return <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  const E = data.employee ?? { name: "سيف", title: "فاحص الأرقام", avatar: "🛂" };
  const pct = (n: number) => data.total ? Math.round((n / data.total) * 100) : 0;
  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 font-semibold">
          <span className="text-xl">{E.avatar}</span> {E.name} — {E.title}
          <ShieldCheck className="w-4 h-4 text-primary" />
        </div>
        <div className="flex gap-2">
          <button disabled={run.isPending} onClick={() => run.mutate(false)} className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-xs disabled:opacity-60">
            {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} افحص ما لم يُفحص
          </button>
          <button disabled={run.isPending} onClick={() => confirm("إعادة فحص القائمة كلها، بما فيها الجاهز؟") && run.mutate(true)} className="px-3 py-1.5 border border-border rounded-lg text-xs text-muted-foreground disabled:opacity-60">أعد فحص الكل</button>
        </div>
      </div>

      <div className="h-2 rounded-full bg-muted overflow-hidden flex" dir="ltr">
        <div className="h-full bg-green-400" style={{ width: `${pct(data.ready)}%` }} />
        <div className="h-full bg-yellow-400" style={{ width: `${pct(data.hold)}%` }} />
        <div className="h-full bg-red-400" style={{ width: `${pct(data.rejected)}%` }} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
        {[
          ["جاهز للإرسال", num(data.ready), "text-green-400"],
          ["ليس الآن", num(data.hold), "text-yellow-400"],
          ["مرفوض", num(data.rejected), "text-red-400"],
          ["لم يُفحص بعد", num(data.unvetted), "text-muted-foreground"],
        ].map(([k, v, c]) => <div key={String(k)} className="rounded-lg bg-muted/40 p-2"><div className={cn("text-lg font-bold tabular-nums", c)}>{v}</div><div className="text-[11px] text-muted-foreground">{k}</div></div>)}
      </div>

      {data.reasons?.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.reasons.map((r: any) => <span key={r.reason} className="text-[11px] px-2 py-0.5 rounded-full bg-muted/60 text-muted-foreground">{r.reason} · {num(r.n)}</span>)}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        يقرأ صيغة الرقم ودولته، وهل هو جوال، وهل هو وهمي أو مكرر، وقائمة الإيقاف، و«غير مهتم»، وسجل التسليم، وآخر مراسلة، وهل كتب لك، ويسأل واتساب عن الرقم على مهل ({num(data.lookupsLeftThisHour)} سؤالاً متبقياً هذه الساعة). الحملة لا تُرسَل إلا إلى «جاهز»؛ و«ليس الآن» يُعاد النظر فيه عند بدء كل حملة ومرة في اليوم.
        {!data.connected && " واتساب غير متصل الآن: ما لم يُتحقق منه ينتظر الربط."}
        {data.lastRun ? ` آخر جولة ${fmt(data.lastRun.finishedAt ?? data.lastRun.startedAt)}: ${data.lastRun.note ?? ""}` : ""}
      </p>
    </div>
  );
}
