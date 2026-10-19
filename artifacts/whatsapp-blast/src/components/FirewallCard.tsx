// ── جدار الحماية من الحظر ────────────────────────────────────────
// الحالة (عادي / نقاهة / مجمّد)، ميزانية اليوم الباردة وما استُهلك منها،
// ما تقرؤه أسلاك التعثّر الآن، والسجل. ومفتاح التجميد اليدوي.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, Snowflake, Loader2, Sun } from "lucide-react";
import { api } from "@/components/AgentPanel";
import { cn } from "@/lib/utils";

const MODE: Record<string, { label: string; cls: string }> = {
  normal: { label: "عادي", cls: "bg-emerald-500/15 text-emerald-400" },
  convalescent: { label: "نقاهة", cls: "bg-amber-500/15 text-amber-400" },
  frozen: { label: "مجمّد", cls: "bg-red-500/15 text-red-400" },
};
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" }) : "");

export default function FirewallCard({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["wa-firewall"], queryFn: () => api("/api/wa-firewall"), refetchInterval: 30_000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ["wa-firewall"] });
  const act = useMutation({ mutationFn: (path: string) => api(`/api/wa-firewall/${path}`, { method: "POST" }), onSuccess: () => { refresh(); toast.success("تم"); }, onError: (e: Error) => toast.error(e.message) });
  const save = useMutation({ mutationFn: (b: any) => api("/api/wa-firewall", { method: "PUT", body: JSON.stringify(b) }), onSuccess: () => { refresh(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message) });
  const [cap, setCap] = useState<string | null>(null);
  if (isLoading || !data) return <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  const mode = data.manualFreeze ? "frozen" : data.mode;
  const m = MODE[mode] ?? MODE.normal!;
  const pct = data.budget ? Math.min(100, Math.round((data.usedToday / data.budget) * 100)) : 0;
  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 font-semibold">
          {mode === "frozen" ? <ShieldAlert className="w-5 h-5 text-red-400" /> : <ShieldCheck className="w-5 h-5 text-primary" />}
          جدار الحماية من الحظر
          <span className={cn("text-xs px-2 py-0.5 rounded-full", m.cls)}>{m.label}</span>
        </div>
        <div className="flex gap-2">
          {data.manualFreeze
            ? <button onClick={() => act.mutate("lift")} className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs"><Sun className="w-3.5 h-3.5" /> ارفع التجميد اليدوي</button>
            : <button onClick={() => confirm("تجميد كل الرسائل الباردة الآن؟ الردود على من يكتب لك تبقى تعمل.") && act.mutate("freeze")} className="flex items-center gap-1.5 px-3 py-1.5 border border-border rounded-lg text-xs text-muted-foreground hover:text-red-400"><Snowflake className="w-3.5 h-3.5" /> جمّد الإرسال</button>}
        </div>
      </div>

      {mode === "frozen" && (
        <div className="text-xs rounded-lg bg-red-500/10 text-red-300 p-3 leading-relaxed">
          {data.manualFreeze ? "مجمّد يدوياً — لا تخرج رسالة باردة حتى ترفعه." : <>مجمّد حتى <b>{fmt(data.frozenUntil)}</b>. السبب: {data.reason}. الحملات التي أوقفها ({(data.pausedCampaigns ?? []).length}) تعود وحدها حين يُرفع.</>}
          <div className="mt-1 text-muted-foreground">الردود على من يكتب لك لا تتأثر.</div>
        </div>
      )}
      {mode === "convalescent" && (
        <div className="text-xs rounded-lg bg-amber-500/10 text-amber-200 p-3 leading-relaxed">
          نقاهة حتى <b>{fmt(data.convalescentUntil)}</b>: ثلث الميزانية في الأسبوع الأول، ثلثاها في الثاني، وبلا أزرار ولا كاروسيل.
        </div>
      )}

      <div>
        <div className="flex justify-between text-xs mb-1"><span>ميزانية اليوم الباردة</span><span className="tabular-nums">{data.usedToday} / {data.budget}</span></div>
        <div className="h-2 rounded-full bg-muted overflow-hidden"><div className={cn("h-full", pct >= 90 ? "bg-red-400" : pct >= 60 ? "bg-amber-400" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
        <div className="text-[11px] text-muted-foreground mt-1">رسالة باردة: لمن لم يكتب لك خلال ثلاثة أيام. الميزانية بعمر الرقم ({data.numberAgeDays} يوماً): {data.rules.coldPerHour} في الساعة، {data.rules.coldPer10Min} في عشر دقائق، فاصل {Math.round(data.rules.coldGapMs[0] / 1000)}–{Math.round(data.rules.coldGapMs[1] / 1000)} ثانية، {data.rules.firstHourCap} فقط في أول ساعة، وساعات {data.sendingHours.tz}{data.sendingHours.open ? "" : " (مغلقة الآن)"}.</div>
      </div>

      {!compact && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-center">
            {[
              ["آخر ساعة", `${data.coldLastHour} / ${data.rules.coldPerHour}`],
              ["لم تُسلَّم (آخر ٢٠)", `${data.delivery.undelivered} / ${data.delivery.n}`],
              ["طلبات إيقاف اليوم", data.optOutsToday],
              ["انقطاعات (٣٠ دقيقة)", data.closes30Min],
            ].map(([k, v]) => <div key={String(k)} className="rounded-lg bg-muted/40 p-2"><div className="text-lg font-bold tabular-nums">{v}</div><div className="text-[11px] text-muted-foreground">{k}</div></div>)}
          </div>
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            أسلاك التعثّر — أيٌّ منها يجمّد الإرسال فوراً: أكثر من {data.rules.burstAny5Min} رسائل في خمس دقائق · {data.rules.undelivered.bad} من آخر {data.rules.undelivered.sample} لم تُسلَّم · {data.rules.closes.n} انقطاعات في نصف ساعة أثناء الإرسال · رفض واتساب للاتصال ({data.rules.rejectionFreezeH} ساعة) · خطأ إرسال يشي بالمنع · {data.rules.optOuts.n} طلبات إيقاف في يوم · آخر {data.rules.noEngagement.sample} رسالة باردة بلا رد.
          </div>
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="space-y-1"><span className="block text-muted-foreground">سقف يومي أقل (اختياري)</span>
              <input type="number" value={cap ?? (data.coldDailyCap ?? "")} onChange={(e) => setCap(e.target.value)} placeholder={String(data.budget)} className="w-28 px-2 py-1.5 bg-input border border-border rounded-lg" /></label>
            <button onClick={() => save.mutate({ coldDailyCap: cap ? Number(cap) : null })} className="px-3 py-1.5 bg-primary text-primary-foreground rounded-lg">حفظ</button>
            <label className="flex items-center gap-2 cursor-pointer mr-auto"><input type="checkbox" checked={!!data.interactiveAllowed} onChange={(e) => save.mutate({ interactiveAllowed: e.target.checked })} className="w-4 h-4" /> اسمح بالأزرار والكاروسيل أثناء النقاهة</label>
          </div>
          {data.events?.length > 0 && (
            <div className="text-[11px] space-y-1 max-h-40 overflow-y-auto">
              {data.events.map((e: any) => <div key={e.id} className="flex gap-2"><span className="text-muted-foreground shrink-0 tabular-nums">{fmt(e.createdAt)}</span><span>{e.detail}</span></div>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
