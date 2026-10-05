// ── All the company's knowledge, and what the team finds in it ────
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Library, Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const WHERE: Record<string, [string, string]> = { kb: ["هذه الصفحة", "/knowledge"], docs: ["البريد ← المعرفة", "/email/knowledge"], facts: ["البريد ← المعرفة", "/email/knowledge"], groups: ["القروبات ← تدريب سارة", "/groups"] };

export function UnifiedKnowledge() {
  const [q, setQ] = useState("");
  const [ask, setAsk] = useState("");
  const { data, isFetching } = useQuery<any>({ queryKey: ["knowledge-unified", ask], queryFn: () => api(`/api/knowledge/unified${ask ? `?q=${encodeURIComponent(ask)}` : ""}`) });
  const c = data?.counts ?? {}, src: Record<string, string> = data?.sources ?? {};
  return (
    <div className="bg-card border border-card-border rounded-xl p-4 space-y-3">
      <p className="text-sm font-semibold flex items-center gap-2"><Library className="w-4 h-4 text-primary" /> معرفة الشركة الموحّدة</p>
      <p className="text-[11px] text-muted-foreground">كل الموظفين — بوت الواتساب، فريق البريد، فرق التواصل الاجتماعي، سارة، ومُعِدّ العروض — يقرؤون من المصادر الأربعة معاً. ما ترفعه في مكان يعرفه الجميع.</p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {(["kb", "docs", "facts", "groups"] as const).map((k) => (
          <Link key={k} href={WHERE[k]![1]} className={cn(card, "p-2.5 hover:border-primary/40 block")}><p className="text-[10px] text-muted-foreground">{src[k] ?? k}</p><p className="text-lg font-bold">{n(c[k])}</p><p className="text-[9px] text-muted-foreground">تُضاف من: {WHERE[k]![0]}</p></Link>
        ))}
      </div>
      <div className="flex gap-2">
        <input className={cn(input, "text-sm")} placeholder="اسأل المعرفة كما يسأل العميل — مثلاً: كم سعر مسك الدفاتر؟" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && setAsk(q.trim())} />
        <button onClick={() => setAsk(q.trim())} disabled={!q.trim()} className="flex items-center gap-1.5 px-3 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40">{isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} ماذا سيجد الفريق؟</button>
      </div>
      {ask && !isFetching && (!data?.results?.length
        ? <p className="text-xs text-yellow-400">لا شيء في أي مصدر يجيب عن هذا — سيسأل الموظف العميل بدل أن يجيب، ولن يخترع رقماً. أضف المعلومة في أحد المصادر.</p>
        : <div className="space-y-1.5">{data.results.map((r: any, i: number) => (
          <div key={i} className="rounded-lg bg-muted/30 p-2.5 text-xs"><p className="text-[10px] text-primary mb-0.5">{src[r.source]} · {r.title}</p><p className="whitespace-pre-wrap line-clamp-4" dir="auto">{r.text}</p></div>
        ))}</div>)}
    </div>
  );
}
