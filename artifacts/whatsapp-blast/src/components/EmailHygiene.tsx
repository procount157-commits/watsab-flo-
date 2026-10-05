// ── صحة القائمة: what will arrive, what will not, what might not ──
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldCheck, Loader2, RefreshCw, Eraser, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");

export function ListHygiene({ listId }: { listId: number }) {
  const qc = useQueryClient();
  const { data: h } = useQuery<any>({ queryKey: ["email-hygiene", listId], queryFn: () => api(`/api/email/hygiene?listId=${listId}`) });
  const inv = () => { qc.invalidateQueries({ queryKey: ["email-hygiene", listId] }); qc.invalidateQueries({ queryKey: ["email-list"] }); qc.invalidateQueries({ queryKey: ["email-lists"] }); };
  const verify = useMutation({ mutationFn: () => api("/api/email/hygiene/verify", { method: "POST", body: JSON.stringify({ listId }) }), onSuccess: (d: any) => { inv(); toast.success(d.checked ? `فُحص ${n(d.checked)} نطاق — ${n(d.dead)} بلا خادم بريد` : "كل النطاقات فُحصت خلال الشهر"); }, onError: (e: Error) => toast.error(e.message) });
  const clean = useMutation({ mutationFn: (risky: boolean) => api("/api/email/hygiene/clean", { method: "POST", body: JSON.stringify({ listId, risky }) }), onSuccess: (d: any) => { inv(); toast.success(`أُخرج ${n(d.removed)} من القائمة — بقي ${n(d.kept)}`); } });
  if (!h) return null;
  const sendable = h.active - h.deadDomain;
  const pct = (v: number) => (h.active ? Math.round((v / h.active) * 100) : 0);
  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-center gap-2 flex-wrap">
        <ShieldCheck className="w-4 h-4 text-primary" /><p className="text-sm font-semibold flex-1">صحة القائمة قبل الإرسال</p>
        <button onClick={() => verify.mutate()} disabled={verify.isPending} className={ghost}>{verify.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} افحص النطاقات الآن</button>
        <button onClick={() => clean.mutate(false)} disabled={clean.isPending} className={ghost}><Eraser className="w-3.5 h-3.5" /> أخرج الميت والمرتد</button>
        {!!h.risk.high && <button onClick={() => { if (confirm(`إخراج ${h.risk.high} عنواناً عالي الخطر من القائمة؟ يبقون في سجلك.`)) clean.mutate(true); }} className={cn(ghost, "text-orange-400")}><Flame className="w-3.5 h-3.5" /> وأخرج عالي الخطر</button>}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-center">
        {[["سيصل غالباً", h.risk.low, "text-primary"], ["خطر متوسط", h.risk.medium, "text-yellow-400"], ["خطر عالٍ — يُحجز", h.risk.high, "text-orange-400"], ["نطاق بلا بريد", h.deadDomain, "text-red-400"], ["لم يُفحص بعد", h.unverified, "text-muted-foreground"], ["ارتدّ / اشتكى", h.bounced, "text-red-400"]].map(([l, v, cls]: any) => (
          <div key={l} className="rounded-lg bg-muted/30 py-2"><p className={cn("text-lg font-bold", cls)}>{n(v)}</p><p className="text-[10px] text-muted-foreground">{l}</p></div>
        ))}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden flex">
        <div className="bg-primary" style={{ width: `${pct(h.risk.low)}%` }} /><div className="bg-yellow-400" style={{ width: `${pct(h.risk.medium)}%` }} /><div className="bg-orange-400" style={{ width: `${pct(h.risk.high)}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        {n(sendable)} عنوان قابل للإرسال: {n(h.role)} عنوان عام (info@ وأمثاله، نادراً ما يرتد) و{n(h.personal)} عنوان شخصي. الارتداد الأخطر هو شخص ترك شركته — لذلك العنوان الشخصي في نطاق ارتدّ منه غيره «عالي الخطر» ويُحجز تلقائياً، والباقي يُرسل له الأقل خطراً أولاً. كل نطاق يُفحص قبل أول رسالة له.
      </p>
      {!!h.bouncedDomains?.length && <p className="text-[11px] text-muted-foreground">نطاقات ارتدّ منها عنوان: {h.bouncedDomains.map((d: any) => `${d.domain} (${n(d.bounced)}/${n(d.contacts)})`).join("، ")}</p>}
    </div>
  );
}

export function WarmupCard({ skipRisky, onSkipRisky }: { skipRisky: boolean; onSkipRisky: (v: boolean) => void }) {
  const { data: w } = useQuery<any>({ queryKey: ["email-warmup"], queryFn: () => api("/api/email/warmup") });
  if (!w) return null;
  const max = Math.max(...w.plan.map((p: any) => p.cap), 1);
  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <p className="text-sm font-semibold">الإحماء وحماية النطاق</p>
      <p className="text-[11px] text-muted-foreground">{w.on ? `عنوان الإرسال عمره ${n(w.ageDays)} يوماً. حد اليوم ${n(w.today)} من ${n(w.dailyCap)}، ويزيد ٣٠٪ يومياً حتى يبلغ حدك — مزوّدو البريد يحكمون على المُرسل الجديد بأسابيعه الأولى.` : "الإحماء متوقف — يُرسل حتى الحد اليومي كاملاً من اليوم الأول."}</p>
      {w.on && <div className="flex items-end gap-1 h-20">{w.plan.map((p: any) => (
        <div key={p.day} className="flex-1 flex flex-col items-center gap-0.5" title={`يوم ${p.day}: ${p.cap}`}>
          <span className="text-[8px] text-muted-foreground">{n(p.cap)}</span>
          <div className={cn("w-full rounded-t", p.day === w.ageDays ? "bg-primary" : "bg-primary/30")} style={{ height: `${Math.max(4, (p.cap / max) * 56)}px` }} />
        </div>
      ))}</div>}
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={skipRisky} onChange={(e) => onSkipRisky(e.target.checked)} />
        <span>احجز العناوين عالية الخطر تلقائياً<span className="block text-[10px] text-muted-foreground">عنوان شخصي في شركة ارتدّ منها عنوان شخصي آخر — غالباً موظف ترك العمل. يبقى في القائمة ولا يُرسل له.</span></span></label>
    </div>
  );
}
