// ── حملات واتساب التلقائية ───────────────────────────────────────
// المفتاح، والوضع (موافقة أو آلي)، والأحجام — ثم التجارب: النسختان،
// النتائج، الفائزة، والدرس. في وضع الموافقة تظهر هنا كل تجربة كُتبت
// وتنتظر «وافق».
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Rocket, Loader2, Trophy, Check, X, Play } from "lucide-react";
import { api } from "@/components/AgentPanel";
import { cn } from "@/lib/utils";

const STATUS: Record<string, string> = {
  awaiting_approval: "تنتظر موافقتك", testing: "تُجرَّب", scaling: "الفائزة تُرسل لموجة", done: "انتهت", no_winner: "لا فائز", cancelled: "أُلغيت",
};

export default function WaAutopilot() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["wa-autopilot"], queryFn: () => api("/api/wa-autopilot"), refetchInterval: 30_000 });
  const [cfg, setCfg] = useState<any>(null);
  useEffect(() => { if (data?.config && !cfg) setCfg(data.config); }, [data]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["wa-autopilot"] });
  const save = useMutation({ mutationFn: (b: any) => api("/api/wa-autopilot", { method: "PUT", body: JSON.stringify(b) }), onSuccess: (d) => { setCfg(d); refresh(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message) });
  const approve = useMutation({ mutationFn: (id: number) => api(`/api/wa-autopilot/tests/${id}/approve`, { method: "POST" }), onSuccess: (d: any) => { refresh(); toast.success(d.note); }, onError: (e: Error) => toast.error(e.message) });
  const cancel = useMutation({ mutationFn: (id: number) => api(`/api/wa-autopilot/tests/${id}/cancel`, { method: "POST" }), onSuccess: refresh });
  const run = useMutation({ mutationFn: () => api("/api/wa-autopilot/run", { method: "POST" }), onSuccess: (d: any) => { refresh(); toast(d.created ? "كُتبت تجربة جديدة" : d.why ?? "انتهت الدورة"); }, onError: (e: Error) => toast.error(e.message) });

  if (isLoading || !cfg) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  const num = (k: string, label: string, hint: string) => (
    <label className="text-xs space-y-1"><span className="font-semibold block">{label}</span>
      <input type="number" value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm" />
      <span className="text-muted-foreground">{hint}</span></label>
  );
  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Rocket className="w-6 h-6 text-primary" /> حملات واتساب التلقائية</h1>
        <p className="text-sm text-muted-foreground mt-1">يختار القطاع أو القائمة، يكتب نسختين بزاويتين، يجرّبهما على عيّنتين صغيرتين، يحكم بالردود وضغطات «مهتم» و«إيقاف»، ثم يرسل الفائزة لموجة — ضمن حدّ اليوم وساعات الإرسال وحماية الرقم.</p>
      </div>

      <div className="bg-card border border-card-border rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <label className="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} className="w-5 h-5" />
            <span className="font-semibold">{cfg.enabled ? "الطيار يعمل" : "الطيار مطفأ"}</span>
          </label>
          <div className="flex gap-2">
            {(["approve", "auto"] as const).map((m) => (
              <button key={m} onClick={() => setCfg({ ...cfg, mode: m })} className={cn("px-3 py-2 rounded-lg text-sm border", cfg.mode === m ? "bg-primary/15 text-primary border-primary/40" : "border-border text-muted-foreground")}>
                {m === "approve" ? "أوافق على كل تجربة" : "آلي بالكامل"}
              </button>
            ))}
          </div>
        </div>
        <div className="grid md:grid-cols-3 gap-3">
          {num("testSize", "حجم كل نسخة في التجربة", "عدد من تصلهم كل نسخة")}
          {num("waveSize", "حجم موجة الفائزة", "من تصلهم الفائزة بعد الحكم")}
          {num("dailyShare", "حصة الطيار من حدّ اليوم ٪", "الباقي للحملات اليدوية والمتابعة")}
        </div>
        <div className="flex gap-2">
          <button onClick={() => save.mutate(cfg)} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm">حفظ</button>
          <button onClick={() => run.mutate()} disabled={run.isPending || !data?.config?.enabled} className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm disabled:opacity-40">
            {run.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} دورة الآن
          </button>
        </div>
      </div>

      {(data?.tests ?? []).length === 0 ? (
        <div className="bg-card border border-card-border rounded-xl py-12 text-center text-sm text-muted-foreground">لا تجارب بعد — شغّل الطيار واحفظ، فتُكتب أول تجربة خلال نصف ساعة.</div>
      ) : (data.tests as any[]).map((t) => (
        <div key={t.id} className="bg-card border border-card-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="font-semibold">{t.target} <span className="text-xs text-muted-foreground font-normal">· {t.service === "aml" ? "مكافحة غسل الأموال" : t.service === "services" ? "محاسبة وضرائب" : "المحل"} · {new Date(t.createdAt).toLocaleString("ar-AE")}</span></div>
            <span className={cn("text-xs px-2 py-1 rounded-full", t.status === "awaiting_approval" ? "bg-amber-500/15 text-amber-500" : "bg-muted text-muted-foreground")}>{STATUS[t.status] ?? t.status}</span>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {(t.variants as any[]).map((v) => {
              const r = (t.results as any[] | null)?.find((x) => x.key === v.key);
              return (
                <div key={v.key} className={cn("rounded-lg border p-3 space-y-2", t.winner === v.key ? "border-primary/60 bg-primary/5" : "border-border")}>
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold">نسخة {v.key} — {v.angle}</span>
                    {t.winner === v.key && <span className="flex items-center gap-1 text-primary"><Trophy className="w-3.5 h-3.5" /> الفائزة</span>}
                  </div>
                  {v.mediaUrl && <img src={v.mediaUrl} alt="" className="w-full max-h-40 object-cover rounded" />}
                  <p className="text-sm whitespace-pre-wrap leading-relaxed">{v.message}</p>
                  {r && <p className="text-xs text-muted-foreground">أُرسلت لـ{r.sent} · ردّ {r.replied} · مهتم {r.interested} · إيقاف {r.stopped}</p>}
                </div>
              );
            })}
          </div>
          {t.insight && <p className="text-xs text-muted-foreground">{t.insight}</p>}
          {t.status === "awaiting_approval" && (
            <div className="flex gap-2">
              <button onClick={() => approve.mutate(t.id)} className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm"><Check className="w-4 h-4" /> وافق وأرسل التجربة</button>
              <button onClick={() => cancel.mutate(t.id)} className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-sm"><X className="w-4 h-4" /> ألغِ</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
