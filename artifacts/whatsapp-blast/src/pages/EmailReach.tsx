// ── الوصول ────────────────────────────────────────────────────────
// الإرسال والوصول شيئان: رسالةٌ تهبط في مجلد الإعلانات «أُرسلت» في كل
// جدولٍ عندنا، ولا يراها أحد. هذه الصفحة تقيس الثاني.
//
// وكل عائقٍ فيها يحمل ما يُفعل بالضبط — والسجل الذي يُلصق في DNS
// حرفياً، بزرِّ نسخ. فالفرق بين «فعّل DKIM» و«انسخ هذا السطر إلى هنا»
// هو الفرق بين نصيحةٍ تُقرأ وعملٍ يُنجَز.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ShieldCheck, AlertTriangle, CheckCircle2, Copy, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";

const GROUPS: Record<string, { label: string; hint: string }> = {
  auth:       { label: "المصادقة", hint: "هل يُصدّق المستلم أن الرسالة منك. أثقل ما يحكم الوصول." },
  reputation: { label: "السمعة",   hint: "الارتداد والتفاعل. نطاقٌ سيّئ السمعة لا يُصلحه نصٌّ جميل." },
  list:       { label: "القائمة",  hint: "عناوين لا تستقبل، وعناوين أقسامٍ لا أشخاص." },
  content:    { label: "النص",     hint: "ما يقرؤه المرشِّح قبل أن يقرأه الإنسان." },
  setup:      { label: "الإعداد",  hint: "ما يشترطه المزوّدون على المُرسِل الجماعي." },
};

export function ReachTab() {
  const { data, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ["email-reach"], queryFn: () => api("/api/email/reach"), staleTime: 60_000,
  });
  if (isLoading) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>;

  const score = data?.score ?? 0;
  const tone = score >= 85 ? "text-green-400" : score >= 60 ? "text-yellow-400" : "text-red-400";
  const byGroup = (g: string) => (data?.checks ?? []).filter((c: any) => c.group === g);

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-4")}>
        <div className="flex items-start gap-4">
          <div className="text-center shrink-0">
            <p className={cn("text-4xl font-bold tabular-nums", tone)}>{score}</p>
            <p className="text-[10px] text-muted-foreground">من ١٠٠</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-relaxed">{data?.verdict}</p>
            {data?.domain && <p className="text-[11px] text-muted-foreground mt-1">النطاق المُرسِل: <span className="font-mono" dir="ltr">{data.domain}</span></p>}
          </div>
          <button onClick={() => refetch()} disabled={isFetching} className={cn(ghost, "shrink-0")}>
            {isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} افحص الآن
          </button>
        </div>
        {(data?.next ?? []).length > 0 && (
          <div className="mt-3 pt-3 border-t border-card-border">
            <p className="text-xs font-semibold mb-1.5">ما يُفعل اليوم</p>
            <ol className="space-y-1.5">
              {data.next.map((n: string, i: number) => (
                <li key={i} className="text-xs leading-relaxed flex gap-2">
                  <span className="text-primary font-bold shrink-0">{i + 1}.</span>{n}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>

      {Object.entries(GROUPS).map(([g, meta]) => {
        const items = byGroup(g);
        if (!items.length) return null;
        return (
          <div key={g} className={cn(card, "overflow-hidden")}>
            <div className="p-3 border-b border-card-border">
              <p className="text-xs font-semibold">{meta.label}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{meta.hint}</p>
            </div>
            {items.map((c: any) => <Check key={c.id} c={c} />)}
          </div>
        );
      })}
    </div>
  );
}

function Check({ c }: { c: any }) {
  const [copied, setCopied] = useState(false);
  const copy = async (t: string) => {
    try { await navigator.clipboard.writeText(t); setCopied(true); toast.success("نُسخ"); setTimeout(() => setCopied(false), 2000); }
    catch { toast.error("تعذّر النسخ — حدّده وانسخه يدوياً"); }
  };
  return (
    <div className="p-3 border-b border-card-border last:border-0 flex items-start gap-3">
      {c.state === "fail" ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
        : c.state === "warn" ? <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
        : <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-semibold">{c.title}</p>
        <p className="text-[11px] text-muted-foreground font-mono break-all" dir="auto">{c.detail}</p>
        {c.why  && c.state !== "ok" && <p className="text-[11px] leading-relaxed">{c.why}</p>}
        {c.fix  && <p className="text-[11px] text-primary leading-relaxed">{c.fix}</p>}
        {c.record && (
          <div className="rounded-lg border border-card-border bg-muted/40 p-2 mt-1.5">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] text-muted-foreground">أضف هذا السجل في DNS نطاقك</span>
              <button onClick={() => copy(c.record.value)} className={cn(ghost, "mr-auto py-0.5 px-2 text-[10px]")}>
                <Copy className="w-3 h-3" /> {copied ? "نُسخ" : "انسخ القيمة"}
              </button>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] font-mono" dir="ltr">
              <span className="text-muted-foreground">Type</span><span>{c.record.type}</span>
              <span className="text-muted-foreground">Name</span><span className="break-all">{c.record.name}</span>
              <span className="text-muted-foreground">Value</span><span className="break-all">{c.record.value}</span>
            </div>
          </div>
        )}
      </div>
      <ShieldCheck className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", c.weight >= 12 ? "text-primary" : "text-muted-foreground/40")} />
    </div>
  );
}
