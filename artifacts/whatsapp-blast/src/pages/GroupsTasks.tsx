// ── الطلبات ومواعيد العملاء ────────────────────────────────────────
// What customers asked for in their groups, as tasks with a due time, and each
// client's deadlines as the owner entered them.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Clock, Loader2, Plus, RotateCcw, Trash2, X, CalendarClock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("ar-AE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const dueLabel = (d?: string | null) => {
  if (!d) return ["بلا موعد", "text-muted-foreground"] as const;
  const h = (new Date(d).getTime() - Date.now()) / 3_600_000;
  if (h < 0) return [`متأخر ${h > -24 ? `${Math.round(-h)} س` : `${Math.round(-h / 24)} يوم`}`, "text-red-400"] as const;
  if (h < 24) return [`خلال ${Math.max(1, Math.round(h))} س`, "text-yellow-400"] as const;
  return [`خلال ${Math.round(h / 24)} يوم`, "text-muted-foreground"] as const;
};

// ── Tasks ────────────────────────────────────────────────────────
export function TasksBoard({ groups }: { groups: any[] }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("open");
  const [nf, setNf] = useState({ groupJid: "", text: "", dueAt: "" });
  const { data } = useQuery<any>({ queryKey: ["group-tasks", status], queryFn: () => api(`/api/groups/tasks?status=${status}`), refetchInterval: 60_000 });
  const inv = () => qc.invalidateQueries({ queryKey: ["group-tasks"] });
  const patch = useMutation({ mutationFn: ({ id, ...b }: any) => api(`/api/groups/tasks/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv });
  const add = useMutation({ mutationFn: () => api("/api/groups/tasks", { method: "POST", body: JSON.stringify({ ...nf, dueAt: nf.dueAt || undefined }) }), onSuccess: () => { setNf({ ...nf, text: "", dueAt: "" }); inv(); toast.success("أُضيف الطلب"); }, onError: (e: Error) => toast.error(e.message) });
  const c = data?.counts ?? {};
  const rows: any[] = data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[["مفتوحة", c.open, ""], ["متأخرة", c.overdue, "text-red-400"], ["تحين اليوم", c.today, "text-yellow-400"], ["أُنجزت هذا الأسبوع", c.done7, "text-primary"]].map(([l, v, cls]: any) => (
          <div key={l} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground">{l}</p><p className={cn("text-xl font-bold mt-1", cls)}>{n(v)}</p></div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">تستخرج سارة كل طلب يطلبه العميل في القروب حين تقرأ الجديد، وتغلقه حين ترى أننا أنجزناه. الطلب بلا موعد صريح يُعطى ٢٤ ساعة، والمتأخر يصلك عنه تنبيه على تيليجرام.</p>

      <div className={cn(card, "p-3 flex gap-2 flex-wrap items-center")}>
        <select className={cn(input, "w-56 text-xs")} value={nf.groupJid} onChange={(e) => setNf({ ...nf, groupJid: e.target.value })}><option value="">اختر القروب…</option>{groups.map((g) => <option key={g.jid} value={g.jid}>{g.subject ?? "قروب"}</option>)}</select>
        <input className={cn(input, "flex-1 min-w-[14rem] text-xs")} placeholder="الطلب — مثلاً: إرسال كشف حساب مارس" value={nf.text} onChange={(e) => setNf({ ...nf, text: e.target.value })} />
        <input type="datetime-local" className={cn(input, "w-52 text-xs")} value={nf.dueAt} onChange={(e) => setNf({ ...nf, dueAt: e.target.value })} />
        <button onClick={() => add.mutate()} disabled={!nf.groupJid || !nf.text.trim()} className={primary}><Plus className="w-3.5 h-3.5" /> أضف طلباً</button>
      </div>

      <div className={card}>
        <div className="p-3 border-b border-card-border flex gap-1.5">
          {([["open", "مفتوحة"], ["done", "أُنجزت"], ["cancelled", "أُلغيت"], ["all", "الكل"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setStatus(k)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", status === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
          ))}
        </div>
        {!rows.length ? <p className="p-10 text-center text-xs text-muted-foreground">لا طلبات هنا.</p> : (
          <div className="divide-y divide-card-border">{rows.map((t) => {
            const [dl, dc] = dueLabel(t.due_at);
            return (
              <div key={t.id} className={cn("p-3 flex gap-3 items-start", t.status !== "open" && "opacity-60")}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm" dir="auto">{t.text}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{t.subject ?? "قروب"}{t.requested_by ? ` · طلبه ${t.requested_by}` : ""} · {when(t.requested_at)} · {t.origin === "owner" ? "أضفته أنت" : "استخرجته سارة"}{t.done_note ? ` · ${t.done_note}` : ""}</p>
                </div>
                {t.status === "open" && <span className={cn("text-[11px] whitespace-nowrap flex items-center gap-1", dc)}><Clock className="w-3 h-3" />{dl}</span>}
                {t.status === "open" ? <>
                  <button onClick={() => patch.mutate({ id: t.id, status: "done" })} className={cn(ghost, "text-primary border-primary/40")}><Check className="w-3 h-3" /> أُنجز</button>
                  <button onClick={() => patch.mutate({ id: t.id, dueAt: new Date(Date.now() + 86_400_000).toISOString() })} className={ghost} title="أجّل يوماً">+١ يوم</button>
                  <button onClick={() => patch.mutate({ id: t.id, status: "cancelled" })} className={ghost}><X className="w-3 h-3" /></button>
                </> : <button onClick={() => patch.mutate({ id: t.id, status: "open" })} className={ghost}><RotateCcw className="w-3 h-3" /> أعد فتحه</button>}
              </div>
            );
          })}</div>
        )}
      </div>
    </div>
  );
}

// ── Client deadlines ─────────────────────────────────────────────
const EMPTY = { clientName: "", groupJid: "", kind: "vat", title: "", dueDate: "", recurrence: "quarterly", remindDays: 7, documents: "" };
export function ObligationsCalendar({ groups }: { groups: any[] }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["obligations"], queryFn: () => api("/api/groups/obligations") });
  const [f, setF] = useState<any>(EMPTY);
  const inv = () => qc.invalidateQueries({ queryKey: ["obligations"] });
  const add = useMutation({ mutationFn: () => api("/api/groups/obligations", { method: "POST", body: JSON.stringify(f) }), onSuccess: () => { setF({ ...EMPTY, clientName: f.clientName, groupJid: f.groupJid }); inv(); toast.success("أُضيف الموعد"); }, onError: (e: Error) => toast.error(e.message) });
  const patch = useMutation({ mutationFn: ({ id, ...b }: any) => api(`/api/groups/obligations/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/groups/obligations/${id}`, { method: "DELETE" }), onSuccess: inv });
  const kinds: Record<string, string> = data?.kinds ?? {};
  const rows: any[] = data?.rows ?? [];
  const days = (d: string) => Math.round((new Date(`${d}T00:00:00`).getTime() - Date.now()) / 86_400_000);

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-3 text-[11px] text-muted-foreground flex gap-2 border-yellow-500/30")}><AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0" /> المواعيد تُدخلها أنت فقط — النظام لا يحسب أي تاريخ من عنده، لأن تاريخاً خاطئاً هنا غرامة على عميلك. قبل الموعد بالأيام التي تحددها تكتب سارة رسالة تذكير في قروب العميل (تنتظرك هناك كاقتراح)، ويصلك تنبيه على تيليجرام. المتكرر ينتقل لموعده التالي تلقائياً.</div>
      <div className={cn(card, "p-4 space-y-2.5")}>
        <p className="text-sm font-semibold flex items-center gap-2"><CalendarClock className="w-4 h-4 text-primary" /> موعد جديد</p>
        <div className="grid md:grid-cols-4 gap-2">
          <input className={cn(input, "text-xs")} placeholder="العميل" value={f.clientName} onChange={(e) => setF({ ...f, clientName: e.target.value })} />
          <select className={cn(input, "text-xs")} value={f.groupJid} onChange={(e) => { const g = groups.find((x) => x.jid === e.target.value); setF({ ...f, groupJid: e.target.value, clientName: f.clientName || g?.customer_name || g?.subject || "" }); }}><option value="">قروبه (اختياري)</option>{groups.map((g) => <option key={g.jid} value={g.jid}>{g.subject ?? "قروب"}</option>)}</select>
          <select className={cn(input, "text-xs")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, title: f.title || kinds[e.target.value] || "" })}>{Object.entries(kinds).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <input className={cn(input, "text-xs")} placeholder="العنوان — مثلاً: إقرار VAT الربع الثالث" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <label className="text-[10px] text-muted-foreground">الموعد<input type="date" className={cn(input, "text-xs mt-0.5")} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></label>
          <label className="text-[10px] text-muted-foreground">يتكرر<select className={cn(input, "text-xs mt-0.5")} value={f.recurrence} onChange={(e) => setF({ ...f, recurrence: e.target.value })}><option value="none">لا</option><option value="monthly">شهرياً</option><option value="quarterly">كل ربع</option><option value="yearly">سنوياً</option></select></label>
          <label className="text-[10px] text-muted-foreground">ذكّر قبل (أيام)<input type="number" min={0} max={60} className={cn(input, "text-xs mt-0.5")} value={f.remindDays} onChange={(e) => setF({ ...f, remindDays: Number(e.target.value) })} /></label>
          <label className="text-[10px] text-muted-foreground">المستندات المطلوبة من العميل<input className={cn(input, "text-xs mt-0.5")} placeholder="فواتير المبيعات والمشتريات للربع" value={f.documents} onChange={(e) => setF({ ...f, documents: e.target.value })} /></label>
        </div>
        <button onClick={() => add.mutate()} disabled={!f.clientName.trim() || !f.title.trim() || !f.dueDate} className={primary}>{add.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} أضف الموعد</button>
      </div>
      <div className={card}>
        {!rows.length ? <p className="p-10 text-center text-xs text-muted-foreground">لا مواعيد بعد.</p> : (
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground"><th className="text-right p-2.5">العميل</th><th className="text-right p-2.5">الالتزام</th><th className="text-right p-2.5">الموعد</th><th className="text-right p-2.5">يتكرر</th><th className="text-right p-2.5">التذكير</th><th className="p-2.5"></th></tr></thead>
            <tbody>{rows.map((o) => {
              const d = days(o.dueDate);
              return (
                <tr key={o.id} className={cn("border-t border-card-border", !o.active && "opacity-50")}>
                  <td className="p-2.5 font-medium">{o.clientName}{!o.groupJid && <span className="block text-[10px] text-muted-foreground">بلا قروب — تنبيه لك فقط</span>}</td>
                  <td className="p-2.5">{o.title}<span className="block text-[10px] text-muted-foreground">{kinds[o.kind]}{o.documents ? ` · يُطلب: ${o.documents}` : ""}</span></td>
                  <td className={cn("p-2.5 whitespace-nowrap", d < 0 ? "text-red-400" : d <= o.remindDays ? "text-yellow-400" : "")}>{o.dueDate}<span className="block text-[10px]">{d < 0 ? "مضى" : d === 0 ? "اليوم" : `بعد ${n(d)} يوم`}</span></td>
                  <td className="p-2.5">{({ none: "لا", monthly: "شهرياً", quarterly: "كل ربع", yearly: "سنوياً" } as any)[o.recurrence]}</td>
                  <td className="p-2.5 text-[10px] text-muted-foreground">قبل {n(o.remindDays)} أيام{o.lastRemindedDue === o.dueDate ? " · ذُكّر ✓" : ""}</td>
                  <td className="p-2.5 whitespace-nowrap"><button onClick={() => patch.mutate({ id: o.id, active: !o.active })} className="text-[10px] text-muted-foreground underline ml-2">{o.active ? "أوقف" : "فعّل"}</button><button onClick={() => { if (confirm("حذف الموعد؟")) del.mutate(o.id); }} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5 inline" /></button></td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
