// مقارنة الظل لمقترح تعليمات: ما كتبه الموظف بتعليماته الحالية وما كتبه بالمقترحة، على مدخلات
// الحساب الحقيقية، وحكم الكود. لا شيء هنا يفعّل أو يرسل: التشغيل يجري داخل المحاكاة.

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, FlaskConical, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pill, Pre, Q, ago, card, ghost, list, num, pill, useOrg, useOrgAction, when } from "../shared";

const G = "border-green-500/30 bg-green-500/10 text-green-400";
const Y = "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
const R = "border-red-500/30 bg-red-500/10 text-red-400";
const N = "border-border text-muted-foreground";
export const SHADOW: Record<string, { label: string; cls: string }> = {
  better: { label: "أفضل", cls: G },
  same: { label: "مثله", cls: N },
  failed_checks: { label: "خالف الفحوص", cls: R },
  mixed: { label: "مختلط", cls: Y },
  no_output: { label: "لم يكتب", cls: R },
  no_model_path: { label: "بالكود وحده", cls: N },
  not_covered: { label: "لم يُجرَّب", cls: Y },
  no_samples: { label: "لا عيّنات", cls: Y },
  budget: { label: "السقف نفد", cls: Y },
};

export function ShadowWarnings({ summary }: { summary: any }) {
  const w = list(summary?.warnings);
  if (!w.length) return null;
  return (
    <div className={cn(card, "p-3 text-xs space-y-1 border-yellow-500/30")}>
      {w.map((x: string, i: number) => <p key={i} className="flex items-center gap-1.5 text-yellow-400" dir="auto"><AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />{x}</p>)}
    </div>
  );
}

const Issues = ({ v }: { v: unknown }) => {
  const xs = list(v);
  return xs.length
    ? <ul className="text-[11px] text-red-400 space-y-0.5">{xs.map((x, i) => <li key={i} dir="auto">• {String(x)}</li>)}</ul>
    : <p className="text-[11px] text-green-400">سلم من الفحوص</p>;
};

export function ShadowRow({ r }: { r: any }) {
  const [open, setOpen] = useState(r.verdict === "failed_checks" || r.verdict === "mixed");
  const compared = r.current_output != null || r.proposed_output != null;
  return (
    <div className="py-2.5 text-xs space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Pill map={SHADOW} value={r.verdict} />
        <b dir="ltr">{r.employee_key}</b>
        {r.input_excerpt && <span className="text-muted-foreground truncate max-w-md" dir="auto">{r.input_excerpt}</span>}
        <span className="mr-auto text-[10px] text-muted-foreground" title={when(r.created_at)}>{num(r.model_calls)} نداء · {ago(r.created_at)}</span>
        {compared && <button className={ghost} onClick={() => setOpen(!open)}>{open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} المقارنة</button>}
      </div>
      <p className="text-[11px] text-muted-foreground" dir="auto">{r.detail}</p>
      {r.verdict === "mixed" && !open && (
        <div className="grid md:grid-cols-2 gap-2">
          <div><p className="text-[10px] text-muted-foreground">مخالفات الحالي</p><Issues v={r.current_issues} /></div>
          <div><p className="text-[10px] text-muted-foreground">مخالفات المقترح</p><Issues v={r.proposed_issues} /></div>
        </div>
      )}
      {open && compared && (
        <div className="grid md:grid-cols-2 gap-2">
          <div className="space-y-1"><p className="text-[10px] text-muted-foreground">بالتعليمات الحالية</p><Pre>{r.current_output ?? "— لم يكتب شيئاً —"}</Pre><Issues v={r.current_issues} /></div>
          <div className="space-y-1"><p className="text-[10px] text-muted-foreground">بالتعليمات المقترحة{r.library_version ? ` (المكتبة v${r.library_version})` : ""}</p><Pre>{r.proposed_output ?? "— لم يكتب شيئاً —"}</Pre><Issues v={r.proposed_issues} /></div>
        </div>
      )}
    </div>
  );
}

/** لتبويب الموافقات: الظل لمقترحٍ واحد، بإنذاراته، وزر تشغيله لموظفه. */
export function ShadowCompare({ proposalId }: { proposalId: number }) {
  const act = useOrgAction();
  const p = useOrg<any>(`/proposals/${proposalId}`, false);
  const q = useOrg<{ results: any[]; summary: any }>(`/sim/shadow/results?proposalId=${proposalId}&limit=30`, false);
  const target = String(p.data?.proposal?.target ?? "");
  const key = target.startsWith("prompt:") ? target.slice(7) : null;
  if (p.data && !key) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <FlaskConical className="w-3.5 h-3.5 text-primary" /><b>الظل</b>
        <span className={cn(pill, N)}>مقارنة بلا إرسال ولا تفعيل</span>
        {key && (
          <button className={cn(ghost, "mr-auto")} disabled={act.isPending}
            onClick={() => act.mutate({ path: "/sim/shadow/run", body: { employeeKey: key }, ok: (d) => `الظل: ${num(d?.ran)} عيّنة، ${num(d?.callsUsed)} نداء` })}>
            {act.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />} شغّل الظل الآن
          </button>
        )}
      </div>
      <Q q={q} what="نتائج الظل">
        {(d) => (
          <>
            <ShadowWarnings summary={d.summary ?? p.data?.shadow} />
            {list(d.results).length
              ? <div className={cn(card, "px-3 divide-y divide-card-border")}>{list(d.results).map((r) => <ShadowRow key={r.id} r={r} />)}</div>
              : <Empty>لم يُشغَّل الظل لهذا المقترح بعد.</Empty>}
          </>
        )}
      </Q>
    </div>
  );
}

export default ShadowCompare;
