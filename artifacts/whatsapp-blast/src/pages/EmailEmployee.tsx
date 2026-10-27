// ── One email employee, opened ────────────────────────────────────
// The owner (2026-10-27): «أدخل على الموظف وأشاهد التفاصيل». Who they are,
// what they did each day, every action in their own words, and for يوسف
// what the follow-ups brought back and what is still due.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowRight, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" }) : "—");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export default function EmailEmployee({ role }: { role: string }) {
  const [action, setAction] = useState<string>("all");
  const { data, isLoading, error } = useQuery<any>({ queryKey: ["email-employee", role], queryFn: () => api(`/api/email/team/${role}`), refetchInterval: 60_000 });
  if (isLoading) return <div className="py-16 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  if (error || !data) return <div className={cn(card, "p-6 text-sm text-muted-foreground")}>تعذّر فتح الموظف.</div>;
  const e = data.employee;
  const max = Math.max(1, ...data.days.map((d: any) => d.n));
  const rows = data.activity.filter((r: any) => action === "all" || r.action === action);
  const f = data.followups;

  return (
    <div className="space-y-4">
      <Link href="/email/dashboard" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowRight className="w-3.5 h-3.5" /> الفريق</Link>
      <div className={cn(card, "p-4 flex items-center gap-3 flex-wrap")}>
        <span className="text-3xl">{e.avatar}</span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold flex items-center gap-2">{e.name}<span className={cn("text-[10px] px-2 py-0.5 rounded-full border", e.isActive ? "border-primary/40 text-primary" : "border-border text-muted-foreground")}>{e.isActive ? "في الخدمة" : "متوقف"}</span></h2>
          <p className="text-xs text-muted-foreground">{e.title}</p>
        </div>
        <div className="mr-auto text-left text-xs text-muted-foreground">
          <p><b className="text-foreground text-base">{n(e.actions7d)}</b> عملاً في ٧ أيام</p>
          <p>آخر عمل: {when(e.lastAt)}</p>
        </div>
      </div>

      {f && (
        <div className={cn(card, "p-4 space-y-3")}>
          <h3 className="text-sm font-semibold">نتيجة المتابعات — آخر ٣٠ يوماً</h3>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {[["أُرسلت", f.sent, ""], ["فُتحت", f.opened, pct(f.opened, f.sent)], ["ضغط رابطاً", f.clicked, pct(f.clicked, f.sent)], ["ردّوا", f.replied, pct(f.replied, f.sent)], ["ارتدّت", f.bounced, pct(f.bounced, f.sent)]].map(([l, v, p]) => (
              <div key={l as string} className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] text-muted-foreground">{l}</p><p className="text-xl font-bold">{n(v as number)}</p>{p && <p className="text-[10px] text-muted-foreground">{p}</p>}</div>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">الفتح هنا فتح إنسان: فتحات Apple الآلية وبوابات البريد في أول دقيقتين لا تُحسب.</p>
          {!!f.upcoming?.length && (
            <div className="text-xs space-y-1">
              <p className="font-semibold">المتابعات القادمة</p>
              {f.upcoming.map((u: any) => <p key={u.step_index} className="text-muted-foreground">الخطوة {n(u.step_index + 1)}: {n(u.n)} رسالة · أولها {when(u.next)}</p>)}
            </div>
          )}
          {!!f.recent?.length && (
            <div className="divide-y divide-card-border border border-card-border rounded-lg">
              {f.recent.map((m: any) => (
                <div key={m.id} className="px-3 py-2 text-xs flex items-center gap-2 flex-wrap">
                  <span className="font-mono" dir="ltr">{m.to_email}</span>
                  <span className="text-muted-foreground truncate max-w-[22rem]">{m.subject}</span>
                  <span className="text-[10px] px-1.5 rounded bg-muted text-muted-foreground">خطوة {n(m.step_index + 1)}</span>
                  <span className="mr-auto flex gap-1.5 text-[10px]">
                    {m.replied_at ? <b className="text-green-400">ردّ</b> : m.clicked_at ? <b className="text-primary">ضغط</b> : m.opened_at ? <span className="text-yellow-300">فتح</span> : <span className="text-muted-foreground">لم يفتح</span>}
                    <span className="text-muted-foreground">{when(m.sent_at)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={cn(card, "p-4 space-y-2")}>
        <h3 className="text-sm font-semibold">عمله يوماً بيوم — ١٤ يوماً</h3>
        {data.days.length ? (
          <div className="flex items-end gap-1 h-24">
            {data.days.map((d: any) => (
              <div key={d.d} className="flex-1 flex flex-col items-center gap-1" title={`${d.d}: ${d.n}`}>
                <div className="w-full bg-primary/70 rounded-t" style={{ height: `${(d.n / max) * 100}%`, minHeight: 2 }} />
                <span className="text-[9px] text-muted-foreground">{new Date(d.d + "T00:00:00").toLocaleDateString("ar-AE", { day: "numeric", month: "numeric" })}</span>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-muted-foreground">لا عمل في آخر ١٤ يوماً.</p>}
      </div>

      <div className={cn(card, "p-4 space-y-3")}>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setAction("all")} className={cn("px-3 py-1 rounded-full border text-xs", action === "all" ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>الكل ({n(data.activity.length)})</button>
          {data.actions.map((a: any) => (
            <button key={a.action} onClick={() => setAction(a.action)} className={cn("px-3 py-1 rounded-full border text-xs", action === a.action ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{a.action} ({n(a.n)})</button>
          ))}
        </div>
        {rows.length ? (
          <div className="divide-y divide-card-border">
            {rows.map((r: any) => (
              <div key={r.id} className="py-2 text-xs space-y-0.5">
                <div className="flex gap-2 text-[10px] text-muted-foreground"><span className="px-1.5 rounded bg-muted">{r.action}</span><span>{when(r.created_at)}</span></div>
                <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{r.text}</p>
              </div>
            ))}
          </div>
        ) : <p className="text-xs text-muted-foreground">لا شيء مسجّل بعد.</p>}
      </div>
    </div>
  );
}
