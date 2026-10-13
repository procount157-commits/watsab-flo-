// ── منصور: الهدف، والخطة، والفريق كما يقرأ كلٌّ برمبته ──────────
// صاحب العمل يعطي المدير هدفاً — رقماً وموعداً — والمدير يحوّله إلى
// شركاتٍ في اليوم، ويضبط حجم الموجة، ويقول ما يمنع الهدف. وتحت ذلك
// الفريق: كل موظفٍ وبرمبته الكامل كما يُرسل للنموذج، وموقعه في القراف.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Target, Play, ChevronDown, ChevronUp, AlertTriangle, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const input = "bg-background border border-card-border rounded-lg px-3 py-2 text-sm";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 disabled:opacity-40";
const n = (x: number) => Math.round(x).toLocaleString("en");

export function EmailManagerPanel() {
  const qc = useQueryClient();
  const { data: m, isLoading } = useQuery<any>({ queryKey: ["email-manager"], queryFn: () => api("/api/email/manager"), refetchInterval: 60_000 });
  const { data: prompts } = useQuery<any>({ queryKey: ["email-team-prompts"], queryFn: () => api("/api/email/team/prompts") });
  const nextQuarter = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const [f, setF] = useState({ metric: "clients_won", target: "20", deadline: nextQuarter });
  const [open, setOpen] = useState<string | null>(null);

  const give = useMutation({
    mutationFn: () => api("/api/email/manager/goal", { method: "POST", body: JSON.stringify({ ...f, target: Number(f.target) }) }),
    onSuccess: (d: any) => { toast.success(d.note); setTimeout(() => qc.invalidateQueries({ queryKey: ["email-manager"] }), 4000); },
    onError: (e: Error) => toast.error(e.message),
  });
  const run = useMutation({
    mutationFn: () => api("/api/email/manager/run", { method: "POST", body: JSON.stringify({ notify: true }) }),
    onSuccess: (d: any) => toast.success(d.note),
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <div className={cn(card, "p-6 flex justify-center")}><Loader2 className="w-5 h-5 animate-spin" /></div>;
  const g = m?.goal, p = g?.plan;
  const pctDone = g ? Math.min(100, Math.round((100 * g.current) / Math.max(1, g.target))) : 0;
  const pctExpected = g ? Math.min(100, Math.round((100 * p.expected) / Math.max(1, g.target))) : 0;

  return (
    <div className="space-y-4">
      {/* الهدف */}
      <div className={cn(card, "p-4 space-y-3")}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2"><span className="text-xl">🧭</span>
            <div><div className="font-semibold">منصور — مدير التسويق بالبريد</div>
              <div className="text-xs text-muted-foreground">أعطه الهدف، وهو يدير الفريق كل ست ساعات ويرسل لك تقريراً يومياً.</div></div>
          </div>
          <button className={ghost} disabled={run.isPending} onClick={() => run.mutate()}><Play className="w-3.5 h-3.5" />دورة الآن</button>
        </div>

        {g ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm"><Target className="w-4 h-4 text-primary" />
              <span className="font-semibold">{g.title}</span>
              <span className={cn("text-xs px-2 py-0.5 rounded-full", p.state === "on_track" || p.state === "done" ? "bg-green-500/15 text-green-500" : "bg-amber-500/15 text-amber-500")}>{g.state}</span>
              {g.inherited && <span className="text-xs text-muted-foreground">(هدف الحساب العام — أعطه هدفاً خاصاً به أدناه)</span>}
            </div>
            <div className="relative h-2 rounded-full bg-muted overflow-hidden">
              <div className="absolute inset-y-0 right-0 bg-primary" style={{ width: `${pctDone}%` }} />
              <div className="absolute inset-y-0 w-0.5 bg-foreground/60" style={{ right: `${pctExpected}%` }} title="أين يجب أن نكون الآن" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Stat k="تحقّق" v={`${g.current} / ${g.target}`} />
              <Stat k="أيام باقية" v={String(p.daysLeft)} />
              <Stat k="شركات لكل وحدة" v={n(p.companiesPerUnit)} />
              <Stat k="شركات يومياً" v={n(p.perDay)} />
            </div>
            <p className="text-xs text-muted-foreground">{p.summary}</p>
            {p.blockers.map((b: string) => <div key={b} className="flex gap-2 text-xs text-amber-500"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />{b}</div>)}
            {p.assumptions.length > 0 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">نسب القمع المستعملة</summary>{p.assumptions.map((a: string) => <div key={a}>• {a}</div>)}</details>}
          </div>
        ) : <p className="text-sm text-muted-foreground">لا هدف بعد — منصور يعمل بالسياسة وحدها.</p>}

        <div className="flex flex-wrap items-end gap-2 pt-2 border-t border-card-border">
          <label className="text-xs">المقياس<br />
            <select className={input} value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>
              {(m?.metrics ?? []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select></label>
          <label className="text-xs">الرقم<br /><input className={cn(input, "w-24")} type="number" min={1} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>
          <label className="text-xs">الموعد<br /><input className={input} type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} /></label>
          <button className={primary} disabled={give.isPending || !Number(f.target)} onClick={() => give.mutate()}><Target className="w-3.5 h-3.5" />أعطِ منصور الهدف</button>
        </div>
      </div>

      {/* آخر تقرير */}
      {m?.brief && (
        <div className={cn(card, "p-4")}>
          <div className="text-xs text-muted-foreground mb-1">آخر تقرير — {new Date(m.brief.at).toLocaleString("ar-AE")}</div>
          <pre className="whitespace-pre-wrap text-sm font-sans leading-relaxed">{m.brief.text}</pre>
        </div>
      )}

      {/* القراف والفريق */}
      {prompts && (
        <div className={cn(card, "p-4 space-y-3")}>
          <div className="flex items-center gap-2 font-semibold text-sm"><GitBranch className="w-4 h-4" />قراف البريد</div>
          <p className="text-xs leading-relaxed">{prompts.graph.oneBreath}</p>
          <p className="text-xs text-muted-foreground">{prompts.graph.loop}</p>
          {prompts.graph.problems.length > 0 && <div className="text-xs text-red-500">{prompts.graph.problems.join(" · ")}</div>}
          <div className="divide-y divide-card-border">
            {prompts.team.map((t: any) => (
              <div key={t.role} className="py-2">
                <button className="w-full flex items-center justify-between text-sm" onClick={() => setOpen(open === t.role ? null : t.role)}>
                  <span><span className="mr-1">{t.avatar}</span> <b>{t.name}</b> <span className="text-muted-foreground text-xs">{t.title}</span></span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">{n(t.prompt.length)} حرف {open === t.role ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</span>
                </button>
                {open === t.role && <pre className="mt-2 whitespace-pre-wrap text-xs font-sans leading-relaxed bg-muted/40 rounded-lg p-3 max-h-[60vh] overflow-auto">{t.prompt}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <div className="bg-muted/40 rounded-lg p-2"><div className="text-muted-foreground">{k}</div><div className="font-semibold text-sm">{v}</div></div>;
}
