// ── موجز شمّة الصباحي ──────────────────────────────────────────────
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Sun, Send, Eye, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";

export function MorningBrief() {
  const qc = useQueryClient();
  const [show, setShow] = useState(false);
  const { data, isFetching, refetch } = useQuery<any>({ queryKey: ["brief"], queryFn: () => api("/api/brief") });
  const set = useMutation({ mutationFn: (b: any) => api("/api/brief/settings", { method: "PUT", body: JSON.stringify(b) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["brief"] }) });
  const send = useMutation({ mutationFn: () => api("/api/brief/send", { method: "POST" }), onSuccess: (r: any) => (r.ok ? toast.success(r.note) : toast.warning(r.note)) });
  const s = data?.settings;
  return (
    <div className={cn(card, "p-4 space-y-2.5")}>
      <div className="flex items-center gap-2 flex-wrap">
        <Sun className="w-4 h-4 text-yellow-400" /><p className="text-sm font-semibold flex-1">موجز شمّة الصباحي على تيليجرام</p>
        {s && <label className="text-xs flex items-center gap-1.5"><input type="checkbox" checked={s.enabled} onChange={(e) => set.mutate({ enabled: e.target.checked })} /> مفعّل</label>}
        {s && <select className={cn(input, "w-28 text-xs")} value={s.hour} onChange={(e) => set.mutate({ hour: Number(e.target.value) })}>{[6, 7, 8, 9, 10, 11].map((h) => <option key={h} value={h}>الساعة {h}:00</option>)}</select>}
        <button onClick={() => { setShow(!show); void refetch(); }} className={ghost}>{isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Eye className="w-3 h-3" />} معاينة</button>
        <button onClick={() => send.mutate()} disabled={send.isPending} className={ghost}><Send className="w-3 h-3" /> أرسله الآن</button>
      </div>
      <p className="text-[11px] text-muted-foreground">رسالة واحدة كل صباح بدل التجوّل في الصفحات: ما ينتظر موافقتك وأين، الصفقات الجديدة، مواعيد اليوم، المتأخر، وما تعطّل — الواتساب، حساب خرج من الجلسة، حملة موقوفة، أو الجهاز نام — وأرقام الأمس.</p>
      {show && data?.preview && <div className="rounded-lg bg-muted/30 p-3 text-xs whitespace-pre-wrap leading-relaxed [&_b]:font-bold" dir="rtl" dangerouslySetInnerHTML={{ __html: data.preview }} />}
    </div>
  );
}
