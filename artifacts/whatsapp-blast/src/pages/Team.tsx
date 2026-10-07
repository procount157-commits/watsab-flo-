// ── الهيكل والأداء ────────────────────────────────────────────────
// Every employee on one page, by department: who is on, what each did this
// week, how often the owner sent their draft as written (the rest were
// edited — and those edits are what they learn from), what each costs in
// model calls, and a box to try any of them on a made-up message.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, Loader2, Play, X, AlertTriangle, Gauge, Cpu, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { MorningBrief } from "@/components/MorningBrief";
import { GraphPanel } from "@/components/GraphPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 60) return `${Math.max(1, m)} د`; const h = Math.round(m / 60); return h < 24 ? `${h} س` : `${Math.round(h / 24)} يوم`;
};
const kTok = (t: number) => (t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : t >= 1_000 ? `${Math.round(t / 1_000)}K` : String(t));

export default function Team() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["team-overview"], queryFn: () => api("/api/team"), refetchInterval: 60_000 });
  const [dept, setDept] = useState("all");
  const [trying, setTrying] = useState<any>(null);
  const toggle = useMutation({ mutationFn: (e: any) => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !e.isActive }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["team-overview"] }), onError: (e: Error) => toast.error(e.message) });
  if (isLoading || !data) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const t = data.totals;
  const people: any[] = data.people.filter((p: any) => dept === "all" || p.department === dept);
  const dupes = data.people.filter((p: any) => p.duplicateName);

  return (
    <div className="p-6 space-y-5 max-w-[96rem]">
      {trying && <TryModal e={trying} onClose={() => setTrying(null)} />}
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Building2 className="w-6 h-6 text-primary" /> الهيكل والأداء</h1>
        <p className="text-sm text-muted-foreground mt-1">كل الموظفين في مكان واحد: من يعمل، ماذا أنجز هذا الأسبوع، كم مرة أرسلت مسودته كما هي، وكم يستهلك. كل تعديل تجريه على مسودة موظف يصبح درساً يراه في المرة القادمة.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[[Users, "الموظفون", `${n(t.active)} يعمل من ${n(t.people)}`], [Gauge, "أُرسل كما كُتب (٣٠ يوماً)", t.decided ? `${Math.round((t.approved / t.decided) * 100)}٪ من ${n(t.decided)} مسودة` : "لا أحكام بعد"], [Cpu, "استدعاءات النموذج (٣٠ يوماً)", n(t.calls)], [Cpu, "رموز تقريبية", kTok(t.tokens)]].map(([Icon, l, v]: any) => (
          <div key={l} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground flex items-center gap-1"><Icon className="w-3 h-3" /> {l}</p><p className="text-lg font-bold mt-1">{v}</p></div>
        ))}
      </div>
      <GraphPanel names={Object.fromEntries(data.people.map((p: any) => [p.role, p.name]))} />
      <MorningBrief />
      {!!dupes.length && <div className={cn(card, "p-3 text-xs text-yellow-400 border-yellow-500/40 flex gap-2")}><AlertTriangle className="w-4 h-4 shrink-0" /> اسم مكرر بين موظفين: {dupes.map((d: any) => `${d.name} (${d.title})`).join("، ")} — غيّر أحدهما من «فريق البوتات» حتى لا تختلط السجلات.</div>}

      <div className="flex gap-1.5 flex-wrap">
        {[{ key: "all", label: "الكل" }, ...data.departments].map((d: any) => {
          const c = d.key === "all" ? data.people.length : data.people.filter((p: any) => p.department === d.key).length;
          return c ? <button key={d.key} onClick={() => setDept(d.key)} className={cn("px-3 py-1.5 rounded-full border text-xs", dept === d.key ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{d.label} ({n(c)})</button> : null;
        })}
      </div>

      {data.departments.filter((d: any) => dept === "all" || d.key === dept).map((d: any) => {
        const ps = people.filter((p) => p.department === d.key);
        if (!ps.length) return null;
        return (
          <div key={d.key} className={card}>
            <div className="p-3.5 border-b border-card-border flex items-center gap-2"><p className="font-semibold text-sm">{d.label}</p><span className="text-[11px] text-muted-foreground">{n(ps.filter((p) => p.isActive).length)} يعمل · {n(ps.reduce((a, p) => a + p.actions7d, 0))} عملاً هذا الأسبوع</span></div>
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-px bg-card-border">
              {ps.map((e) => {
                const a = e.accuracy, u = e.usage;
                return (
                  <div key={e.id} className={cn("bg-card p-3.5 space-y-2", !e.isActive && "opacity-60")}>
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{e.avatar ?? "🤖"}</span>
                      <div className="min-w-0 flex-1"><p className="text-sm font-semibold flex items-center gap-1.5">{e.name}{e.duplicateName && <AlertTriangle className="w-3 h-3 text-yellow-400" />}</p><p className="text-[10px] text-muted-foreground truncate">{e.title}</p></div>
                      <button onClick={() => toggle.mutate(e)} className={cn("text-[10px] px-2 py-0.5 rounded-full border", e.isActive ? "border-primary/40 text-primary" : "border-card-border text-muted-foreground")}>{e.isActive ? "يعمل" : "متوقف"}</button>
                    </div>
                    <p className="text-[10px] text-muted-foreground">{n(e.actions7d)} عملاً هذا الأسبوع{e.lastAt ? ` · آخرها قبل ${ago(e.lastAt)}` : ""}</p>
                    <div>
                      <div className="flex justify-between text-[10px] text-muted-foreground"><span>أُرسل كما كتبه</span><span>{a?.decided ? `${n(a.rate)}٪ · ${n(a.approved)}/${n(a.decided)}${a.edited ? ` · عُدّل ${n(a.edited)}` : ""}${a.rejected ? ` · رُفض ${n(a.rejected)}` : ""}` : "لا أحكام بعد"}</span></div>
                      <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden"><div className={cn("h-full rounded-full", (a?.rate ?? 0) >= 80 ? "bg-primary" : (a?.rate ?? 0) >= 50 ? "bg-yellow-400" : "bg-red-400")} style={{ width: `${a?.rate ?? 0}%` }} /></div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground flex-1">{u ? `${n(u.calls)} استدعاء · ${kTok(u.tokens)} رمز${u.failed ? ` · ${n(u.failed)} فشل` : ""}` : "لا استهلاك مسجّل"}</span>
                      <button onClick={() => setTrying(e)} className={ghost}><Play className="w-3 h-3" /> جرّبه</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TryModal({ e, onClose }: { e: any; onClose: () => void }) {
  const [msg, setMsg] = useState("");
  const run = useMutation({ mutationFn: () => api(`/api/team/${e.role}/try`, { method: "POST", body: JSON.stringify({ message: msg }) }), onError: (err: Error) => toast.error(err.message) });
  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className={cn(card, "w-full max-w-xl p-4 space-y-3")} onClick={(ev) => ev.stopPropagation()}>
        <div className="flex items-center gap-2"><span className="text-xl">{e.avatar}</span><p className="font-semibold flex-1">جرّب {e.name} — {e.title}</p><button onClick={onClose}><X className="w-4 h-4" /></button></div>
        <p className="text-[11px] text-muted-foreground">اكتب رسالة عميل أو مهمة كما تصله في عمله. يرد بصوته ومهاراته وتعليماتك — ولا يُرسل شيء لأحد.</p>
        <textarea className={cn(input, "min-h-[6rem]")} dir="auto" value={msg} onChange={(ev) => setMsg(ev.target.value)} placeholder="مثلاً: كم سعر مسك الدفاتر لشركة عقارات صغيرة؟" autoFocus />
        <button onClick={() => run.mutate()} disabled={!msg.trim() || run.isPending} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40">{run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} جرّب</button>
        {run.data && <div className="rounded-lg bg-muted/40 p-3 text-sm whitespace-pre-wrap leading-relaxed" dir="auto"><p className="text-[10px] text-muted-foreground mb-1">{(run.data as any).name} · {(run.data as any).provider}</p>{(run.data as any).text}</div>}
      </div>
    </div>
  );
}
