// ── الحاجز التلقائي من الحظر ─────────────────────────────────────
// الحالة (عادي / نقاهة / مجمّد)، درجة السلّم وميزانية اليوم وما استُهلك
// منها، إيقاع الدرجة، كلمة واتساب عن الحساب، ما تقرؤه أسلاك التعثّر الآن،
// والسجل. ومفتاح التجميد اليدوي.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ShieldAlert, ShieldCheck, Snowflake, Loader2, Sun, TrendingUp, RefreshCw } from "lucide-react";
import { api } from "@/components/AgentPanel";
import { cn } from "@/lib/utils";

const MODE: Record<string, { label: string; cls: string }> = {
  normal: { label: "عادي", cls: "bg-emerald-500/15 text-emerald-400" },
  convalescent: { label: "نقاهة", cls: "bg-amber-500/15 text-amber-400" },
  frozen: { label: "مجمّد", cls: "bg-red-500/15 text-red-400" },
};
const fmt = (d: string | null | undefined) => (d ? new Date(d).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" }) : "");
const num = (v: number | null | undefined) => (v ?? 0).toLocaleString("ar-EG");

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
  const L = data.ladder ?? {}, P = data.pace ?? {}, W = data.whatsapp ?? {};
  const steps: number[] = L.steps ?? [];
  const warning = W.warning && W.warning !== "NONE" ? W.warning : null;
  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 font-semibold">
          {mode === "frozen" ? <ShieldAlert className="w-5 h-5 text-red-400" /> : <ShieldCheck className="w-5 h-5 text-primary" />}
          الحاجز التلقائي من الحظر
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
          {data.manualFreeze ? "مجمّد يدوياً — لا تخرج رسالة باردة حتى ترفعه." : <>مجمّد حتى <b>{fmt(data.frozenUntil)}</b>. السبب: {data.reason}. الحملات التي أوقفها ({(data.pausedCampaigns ?? []).length}) تعود وحدها حين يُرفع، والسلّم يبدأ من أوله.</>}
          <div className="mt-1 text-muted-foreground">الردود على من يكتب لك لا تتأثر.</div>
        </div>
      )}
      {mode === "convalescent" && (
        <div className="text-xs rounded-lg bg-amber-500/10 text-amber-200 p-3 leading-relaxed">
          نقاهة حتى <b>{fmt(data.convalescentUntil)}</b>: ثلث الدرجة في الأسبوع الأول، ثلثاها في الثاني، وبلا أزرار ولا كاروسيل.
        </div>
      )}
      {warning && (
        <div className="text-xs rounded-lg bg-red-500/10 text-red-300 p-3 leading-relaxed">
          واتساب نفسه يحذّر هذا الحساب ({warning}) — السلّم نزل درجة{warning === "SECOND_WARNING" ? " ثلاث درجات" : ""}، ولا صعود حتى يزول التحذير.
        </div>
      )}

      {/* The ladder */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span className="flex items-center gap-1"><TrendingUp className="w-3.5 h-3.5 text-primary" /> سلّم الإرسال البارد — الدرجة {num(L.size)} في اليوم</span>
          <span className="tabular-nums">{num(data.usedToday)} / {num(data.budget)} اليوم</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden"><div className={cn("h-full", pct >= 90 ? "bg-red-400" : pct >= 60 ? "bg-amber-400" : "bg-primary")} style={{ width: `${pct}%` }} /></div>
        <div className="flex gap-0.5 mt-2" dir="ltr">
          {steps.map((s, i) => (
            <div key={s} title={`${s} في اليوم`} className={cn("flex-1 h-1.5 rounded-sm", i < (L.rung ?? 0) ? "bg-primary/60" : i === (L.rung ?? 0) ? "bg-primary" : "bg-muted")} />
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
          رسالة باردة: لمن لم يكتب لك خلال ثلاثة أيام. الدرجة تُكسب يومين يومين: تسليم ٩٠٪ فأكثر، إيقاف ١٪ فأقل، ردود ١٫٥٪ فأكثر، والدرجة مستهلكة — وتنزل حين تسوء الأرقام أو يحذّر واتساب، وتعود لأولها مع أي تجميد. آخر درجة {num(L.top)}.
          {L.daysAtRung !== undefined ? ` على هذه الدرجة منذ ${num(L.daysAtRung)} يوم.` : ""}
          {" "}إيقاع الدرجة: {num(P.perHour)} في الساعة، {num(P.per10Min)} في عشر دقائق، فاصل {Math.round((P.gapMs?.[0] ?? 0) / 1000)}–{Math.round((P.gapMs?.[1] ?? 0) / 1000)} ثانية، {num(P.firstHourCap)} فقط في أول ساعة، وساعات {data.sendingHours.tz}{data.sendingHours.open ? "" : " (مغلقة الآن)"}.
        </div>
      </div>

      {/* WhatsApp's own word */}
      <div className="text-[11px] rounded-lg bg-muted/30 p-2.5 leading-relaxed flex items-start justify-between gap-2">
        <div>
          <b>كلمة واتساب عن الحساب:</b>{" "}
          {W.checkedAt
            ? <>{W.lockedUntil ? <span className="text-red-300">مقيّد حتى {fmt(W.lockedUntil)}.</span> : "لا قيد."}{" "}
                {W.quota !== null && W.quota !== undefined ? `حصة المحادثات الجديدة ${num(W.quota)}، بقي ${num(W.remaining)}${W.cycleEnd ? ` حتى ${fmt(W.cycleEnd)}` : ""}.` : "لم يُعلن حصة للمحادثات الجديدة."}{" "}
                <span className="text-muted-foreground">قُرئت {fmt(W.checkedAt)}.</span></>
            : <span className="text-muted-foreground">لم تُقرأ بعد — تُقرأ بعد الربط بدقيقة.</span>}
        </div>
        <button onClick={() => act.mutate("standing")} className="shrink-0 flex items-center gap-1 px-2 py-1 border border-border rounded-lg text-[11px] text-muted-foreground"><RefreshCw className="w-3 h-3" /> اقرأ الآن</button>
      </div>

      {!compact && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
            {[
              ["آخر ساعة", `${num(data.coldLastHour)} / ${num(P.perHour)}`],
              ["لم تُسلَّم (آخر ٢٠)", `${num(data.delivery?.undelivered)} / ${num(data.delivery?.n)}`],
              ["طلبات إيقاف اليوم", num(data.optOutsToday)],
              ["انقطاعات (٣٠ دقيقة)", num(data.closes30Min)],
              ["القائمة السوداء", num(data.blacklist)],
            ].map(([k, v]) => <div key={String(k)} className="rounded-lg bg-muted/40 p-2"><div className="text-lg font-bold tabular-nums">{v}</div><div className="text-[11px] text-muted-foreground">{k}</div></div>)}
          </div>
          {L.last2d && (
            <div className="text-[11px] text-muted-foreground leading-relaxed">
              آخر يومين: {num(L.last2d.sent2d)} رسالة باردة إلى {num(L.last2d.recipients)} شخصاً، وصل {num(L.last2d.mature?.delivered)} من {num(L.last2d.mature?.n)} ناضجة، {num(L.last2d.repliers)} ردّوا، {num(L.last2d.optOuts)} طلبوا الإيقاف.
              <button onClick={() => act.mutate("judge")} className="mr-2 underline">احكم على الدرجة الآن</button>
            </div>
          )}
          <div className="text-[11px] text-muted-foreground leading-relaxed">
            أسلاك التعثّر — أيٌّ منها يجمّد الإرسال فوراً: دفقة فوق إيقاع الدرجة في خمس دقائق · {data.rules.undelivered.bad} من آخر {data.rules.undelivered.sample} لم تُسلَّم · {data.rules.closes.n} انقطاعات في نصف ساعة أثناء الإرسال · رفض واتساب للاتصال ({data.rules.rejectionFreezeH} ساعة) · خطأ إرسال يشي بالمنع · {data.rules.optOuts.n} طلبات إيقاف في يوم · آخر {data.rules.noEngagement.sample} رسالة باردة بلا رد · قيدٌ يعلنه واتساب. ومن طلب الإيقاف — بأي صيغة لرقمه — لا يُراسَل بعدها أبداً.
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
