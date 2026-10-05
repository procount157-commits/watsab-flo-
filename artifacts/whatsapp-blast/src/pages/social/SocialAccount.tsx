// ── The account: signing in, the limits, and what the browser did ──
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { LogIn, RefreshCw, Loader2, X, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { card, ghost, primary, n, ago, STATE_AR, PLATFORM_UI, useDesk, type Platform } from "./SocialDesk";

const KINDS: Array<[string, string]> = [["reply", "ردود علنية على التعليقات"], ["dm", "ردود في الخاص"], ["outreach", "رسائل أولى / دعوات"], ["followup", "متابعات"], ["post", "منشورات"], ["engage", "تعليقات تفاعلية"]];

export function AccountTab({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const { data: d } = useDesk(p);
  const { data: actions = [] } = useQuery<any[]>({ queryKey: ["social-actions", p], queryFn: () => api(`/api/social/${p}/actions`), refetchInterval: 30_000 });
  const [caps, setCaps] = useState<Record<string, number>>({});
  useEffect(() => { if (d?.caps) setCaps(d.caps); }, [d?.caps]);
  const inv = () => { qc.invalidateQueries({ queryKey: ["social", p] }); qc.invalidateQueries({ queryKey: ["social-actions", p] }); };
  const login = useMutation({ mutationFn: () => api(`/api/social/${p}/login-window`, { method: "POST" }), onSuccess: (r: any) => toast.success(r.note), onError: (e: Error) => toast.error(e.message) });
  const check = useMutation({ mutationFn: () => api(`/api/social/${p}/check`, { method: "POST" }), onSuccess: (r: any) => { inv(); toast[r.state === "logged_in" ? "success" : "info"](STATE_AR[r.state]?.[0] ?? r.state); }, onError: (e: Error) => toast.error(e.message) });
  const close = useMutation({ mutationFn: () => api(`/api/social/${p}/window`, { method: "DELETE" }), onSuccess: () => toast.success("أُغلقت النافذة") });
  const set = useMutation({ mutationFn: (b: any) => api(`/api/social/${p}/settings`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: () => { inv(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message) });
  if (!d) return <div className={cn(card, "p-10 text-center")}><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const a = d.account;
  const [st, stCls] = STATE_AR[a.state] ?? [a.state, ""];

  return (
    <div className="grid lg:grid-cols-[1fr_26rem] gap-4 items-start">
      <div className="space-y-4">
        <div className={cn(card, "p-4 space-y-3")}>
          <p className="text-sm font-semibold">الحساب</p>
          <div className="flex items-center gap-3 flex-wrap">
            <p className={cn("text-lg font-bold", stCls)}>{st}</p>
            {a.username && <span className="text-sm" dir="ltr">@{a.username}</span>}
            {a.lastCheckAt && <span className="text-[11px] text-muted-foreground">فُحص قبل {ago(a.lastCheckAt)}</span>}
          </div>
          {a.stateNote && <p className="text-xs text-yellow-400">{a.stateNote}</p>}
          <ol className="text-xs text-muted-foreground list-decimal pr-4 space-y-1">
            <li>اضغط «افتح نافذة تسجيل الدخول» — تظهر نافذة Chrome على هذا الجهاز.</li>
            <li>سجّل دخولك إلى {PLATFORM_UI[p].label} <b className="text-foreground">بيدك</b>. النظام لا يرى كلمة المرور ولا يحفظها؛ يبقى الدخول في ملف المتصفح فقط.</li>
            <li>اضغط «افحص الحالة». حين تظهر «مسجّل دخول» يعمل الفريق.</li>
          </ol>
          <div className="flex gap-2 flex-wrap">
            <button onClick={() => login.mutate()} disabled={login.isPending || !d.driven} className={primary}>{login.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />} افتح نافذة تسجيل الدخول</button>
            <button onClick={() => check.mutate()} disabled={check.isPending || !d.driven} className={ghost}>{check.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} افحص الحالة</button>
            <button onClick={() => close.mutate()} className={ghost}><X className="w-3.5 h-3.5" /> أغلق النافذة</button>
          </div>
        </div>

        <div className={cn(card, "p-4 space-y-3")}>
          <p className="text-sm font-semibold">طريقة العمل</p>
          <div className="grid md:grid-cols-2 gap-2">
            {([[true, "وضع التجربة", "يقرأ ويكتب المسودات ولا يرسل شيئاً. ابدأ به أسبوعاً."], [false, "الإرسال الفعلي", "يرسل ما يُعتمد، داخل الحدود اليومية."]] as const).map(([v, l, sub]) => (
              <button key={l} onClick={() => set.mutate({ dryRun: v })} className={cn("text-right p-3 rounded-lg border", a.dryRun === v ? "border-primary bg-primary/10" : "border-card-border")}><p className="text-sm font-semibold">{l}</p><p className="text-[11px] text-muted-foreground">{sub}</p></button>
            ))}
            {([["approve", "بموافقتك", "كل رد ورسالة أولى تنتظر اعتمادك."], ["auto", "تلقائي", "يرسل ما يجيزه الحارس: لا أرقام خارج المعرفة، لا مبالغة، لا تكرار."]] as const).map(([v, l, sub]) => (
              <button key={v} onClick={() => set.mutate({ mode: v })} className={cn("text-right p-3 rounded-lg border", a.mode === v ? "border-primary bg-primary/10" : "border-card-border")}><p className="text-sm font-semibold">{l}</p><p className="text-[11px] text-muted-foreground">{sub}</p></button>
            ))}
          </div>
        </div>

        <div className={cn(card, "p-4 space-y-3")}>
          <p className="text-sm font-semibold">الحدود اليومية</p>
          <p className="text-[11px] text-muted-foreground">{PLATFORM_UI[p].label} لا يعلن حدوده، ويعاقب بتقييد الحساب لا برفض الفعل. الأرقام الافتراضية محافظة؛ ارفعها تدريجياً بعد أسبوعين بلا مشاكل. فاصل لا يقل عن {n(Math.round((d.pace?.minGapMs ?? 45_000) / 1000))} ثانية بين كل فعلين، ونشاط بين {n(d.pace?.hours?.[0])} و{n(d.pace?.hours?.[1])} بتوقيت الخليج فقط.</p>
          <div className="grid md:grid-cols-3 gap-2">
            {KINDS.map(([k, l]) => (
              <label key={k} className="text-[11px] text-muted-foreground">{l}<input type="number" min={0} className={cn(input, "mt-1 text-sm")} value={caps[k] ?? 0} onChange={(e) => setCaps({ ...caps, [k]: Number(e.target.value) })} /></label>
            ))}
          </div>
          <button onClick={() => set.mutate({ caps })} className={primary}>احفظ الحدود</button>
        </div>
      </div>

      <div className={card}>
        <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> سجل المتصفح</p><p className="text-[10px] text-muted-foreground">كل فعل على {PLATFORM_UI[p].label} يُسجَّل قبل حدوثه</p></div>
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-card-border">
          {!actions.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا شيء بعد.</p> : actions.map((x) => (
            <div key={x.id} className="p-2.5 text-[11px] flex gap-2"><span className={x.ok ? "text-primary" : "text-red-400"}>{x.ok ? "✓" : "✗"}</span><div className="min-w-0 flex-1"><p><b>{x.action}</b>{x.target ? <span className="text-muted-foreground" dir="ltr"> · {x.target}</span> : null}</p>{x.detail && <p className="text-muted-foreground truncate" dir="auto">{x.detail}</p>}</div><span className="text-muted-foreground whitespace-nowrap">{ago(x.createdAt)}</span></div>
          ))}
        </div>
      </div>
    </div>
  );
}
