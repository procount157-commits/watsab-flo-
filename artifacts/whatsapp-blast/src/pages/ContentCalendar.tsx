// ── جدول المحتوى ──────────────────────────────────────────────────
// One topic written for every channel on a chosen day — a newsletter, a
// LinkedIn post, an Instagram caption, a TikTok script — laid out by week.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import { CalendarRange, ChevronLeft, ChevronRight, Copy, Loader2, Mail, Pencil, Sparkles, Trash2, Check, Instagram, Music2, Linkedin } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border border-card-border hover:border-primary/50 transition-colors";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const CH: Record<string, { label: string; icon: any; tone: string; manual: string }> = {
  email: { label: "نشرة بريدية", icon: Mail, tone: "text-primary", manual: "" },
  linkedin: { label: "لينكدإن", icon: Linkedin, tone: "text-sky-400", manual: "انسخه وانشره من حسابك" },
  instagram: { label: "إنستجرام", icon: Instagram, tone: "text-pink-400", manual: "انشره من هاتفك مع الصورة" },
  tiktok: { label: "تيك توك", icon: Music2, tone: "text-cyan-400", manual: "صوّره بهاتفك وانشره بهذا الوصف" },
};
const startOfWeek = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const dow = (x.getUTCDay() + 6) % 7; x.setUTCDate(x.getUTCDate() - dow); return x; };

export default function ContentCalendar() {
  const qc = useQueryClient();
  const [week, setWeek] = useState(() => startOfWeek(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => new Date(week.getTime() + i * 86_400_000));
  const from = iso(days[0]!), to = iso(days[6]!);
  const { data, isLoading } = useQuery<any>({ queryKey: ["content-plans", from], queryFn: () => api(`/api/content?from=${from}&to=${to}`) });
  const [f, setF] = useState({ topic: "", publishOn: iso(new Date()), channels: ["email", "linkedin", "instagram", "tiktok"] as string[] });
  const [open, setOpen] = useState<number | null>(null);
  const make = useMutation({ mutationFn: () => api("/api/content", { method: "POST", body: JSON.stringify(f) }), onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["content-plans"] }); setOpen(r.plan.id); setF({ ...f, topic: "" }); r.failed?.length ? toast.warning(`كُتب المحتوى — تعذّر: ${r.failed.map((c: string) => CH[c]?.label).join("، ")}`) : toast.success("كتب الفريق المحتوى لكل القنوات"); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/content/${id}`, { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["content-plans"] }) });
  const plans: any[] = data?.plans ?? [];
  const sel = plans.find((p) => p.id === open);

  return (
    <div className="p-6 space-y-5 max-w-[96rem]">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><CalendarRange className="w-6 h-6 text-primary" /> جدول المحتوى</h1>
        <p className="text-sm text-muted-foreground mt-1">اكتب موضوعاً واحداً واختر يوماً: يكتبه كل فريق بشكل قناته — نشرة بريدية، منشور لينكدإن، وصف إنستجرام، نص فيديو تيك توك — من نفس الفكرة ومعرفة الشركة.</p>
      </div>
      <div className={cn(card, "p-4 space-y-2.5")}>
        <div className="flex gap-2 flex-wrap">
          <input className={cn(input, "flex-1 min-w-[18rem] text-sm")} placeholder="الموضوع — مثلاً: ما الذي يطلبه مفتش AML من الوسيط العقاري" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} />
          <input type="date" className={cn(input, "w-44 text-sm")} value={f.publishOn} onChange={(e) => setF({ ...f, publishOn: e.target.value })} />
        </div>
        <div className="flex gap-1.5 flex-wrap items-center">
          {Object.entries(CH).map(([k, c]) => { const on = f.channels.includes(k); return <button key={k} onClick={() => setF({ ...f, channels: on ? f.channels.filter((x) => x !== k) : [...f.channels, k] })} className={cn("flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px]", on ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}><c.icon className="w-3 h-3" /> {c.label}</button>; })}
          <button onClick={() => make.mutate()} disabled={make.isPending || f.topic.trim().length < 4 || !f.channels.length} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40 mr-auto">{make.isPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> يكتب الفريق… (دقيقة تقريباً)</> : <><Sparkles className="w-3.5 h-3.5" /> اكتبه لكل القنوات</>}</button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={() => setWeek(new Date(week.getTime() - 7 * 86_400_000))} className={ghost}><ChevronRight className="w-3.5 h-3.5" /></button>
        <p className="text-sm font-semibold">{days[0]!.toLocaleDateString("ar-AE", { day: "numeric", month: "long", timeZone: "UTC" })} — {days[6]!.toLocaleDateString("ar-AE", { day: "numeric", month: "long", timeZone: "UTC" })}</p>
        <button onClick={() => setWeek(new Date(week.getTime() + 7 * 86_400_000))} className={ghost}><ChevronLeft className="w-3.5 h-3.5" /></button>
        <button onClick={() => setWeek(startOfWeek(new Date()))} className={ghost}>هذا الأسبوع</button>
        {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((d) => {
          const k = iso(d), list = plans.filter((p) => p.publishOn === k), today = k === iso(new Date());
          return (
            <div key={k} className={cn(card, "p-2 min-h-[8rem] space-y-1.5", today && "border-primary/50")}>
              <p className="text-[11px] font-semibold">{d.toLocaleDateString("ar-AE", { weekday: "short", day: "numeric", timeZone: "UTC" })}</p>
              {list.map((p) => (
                <button key={p.id} onClick={() => setOpen(p.id)} className={cn("w-full text-right rounded-md border p-1.5 text-[11px] space-y-1", open === p.id ? "border-primary bg-primary/10" : "border-card-border hover:border-primary/40")}>
                  <p className="line-clamp-2" dir="auto">{p.topic}</p>
                  <div className="flex gap-1">{(p.channels as string[]).map((c) => { const C = CH[c]; return C ? <C.icon key={c} className={cn("w-3 h-3", C.tone)} /> : null; })}</div>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {sel && (
        <div className={card}>
          <div className="p-3 border-b border-card-border flex items-center gap-2"><p className="text-sm font-semibold flex-1" dir="auto">{sel.topic} · {sel.publishOn}</p><button onClick={() => { if (confirm("حذف الخطة ومسوداتها؟")) { del.mutate(sel.id); setOpen(null); } }} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4" /></button></div>
          <div className="grid md:grid-cols-2 gap-px bg-card-border">
            {sel.email && <div className="bg-card p-3 space-y-2"><p className="text-xs font-semibold flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-primary" /> نشرة بريدية</p><p className="text-xs" dir="auto"><b>العنوان:</b> {sel.email.subject}</p>
              <div className="rounded-md border border-card-border bg-white text-black p-2.5 text-xs max-h-64 overflow-y-auto [&_h3]:font-bold [&_ul]:list-disc [&_ul]:pr-4" dir="auto" dangerouslySetInnerHTML={{ __html: sel.email.html }} />
              <Link href="/email/templates" className={cn(ghost, "w-fit")}>في القوالب — استخدمه في حملة</Link></div>}
            {sel.items.map((it: any) => <PlanItem key={it.id} it={it} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function PlanItem({ it }: { it: any }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState<string | null>(null);
  const C = CH[it.platform] ?? CH.linkedin!;
  const patch = useMutation({ mutationFn: (b: any) => api(`/api/social/${it.platform}/content/${it.id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: () => { setEdit(null); qc.invalidateQueries({ queryKey: ["content-plans"] }); toast.success("حُفظ"); } });
  return (
    <div className="bg-card p-3 space-y-2">
      <p className="text-xs font-semibold flex items-center gap-1.5"><C.icon className={cn("w-3.5 h-3.5", C.tone)} /> {C.label}<span className="text-[10px] text-muted-foreground mr-auto">{C.manual}</span></p>
      {edit === null ? <p className="text-xs whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto" dir="auto">{it.text}</p> : <textarea className={cn(input, "min-h-[10rem] text-xs")} dir="auto" value={edit} onChange={(e) => setEdit(e.target.value)} />}
      <div className="flex gap-1">
        {edit === null ? <button onClick={() => setEdit(it.text)} className={ghost}><Pencil className="w-3 h-3" /> عدّل</button> : <button onClick={() => patch.mutate({ text: edit })} className={ghost}><Check className="w-3 h-3" /> احفظ</button>}
        <button onClick={() => { navigator.clipboard.writeText(it.text); toast.success("نُسخ"); }} className={ghost}><Copy className="w-3 h-3" /> انسخ</button>
      </div>
    </div>
  );
}
