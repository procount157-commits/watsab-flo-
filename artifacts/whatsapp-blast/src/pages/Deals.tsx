// ── الصفقات والمواعيد ─────────────────────────────────────────────
// The pipeline from a hot conversation to a client: a board by stage, each
// deal with everything the customer said on every channel, the proposals
// عمّار writes (approved before they go), and the meetings — the owner's
// hours, the free times, and the link customers book through.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Briefcase, CalendarDays, Copy, Download, FileText, Loader2, Plus, Send, Sparkles, X, Check, AlertTriangle, Trash2, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const aed = (v?: number | string | null) => (v == null || v === "" ? "—" : `${Number(v).toLocaleString("ar-SA")} درهم`);
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("ar-AE", { timeZone: "Asia/Dubai", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—");
const STAGES = ["lead", "meeting", "proposal", "negotiation", "won", "lost"] as const;
const STAGE_TONE: Record<string, string> = { lead: "border-t-muted-foreground", meeting: "border-t-sky-400", proposal: "border-t-yellow-400", negotiation: "border-t-orange-400", won: "border-t-primary", lost: "border-t-red-400" };

export default function Deals() {
  const [tab, setTab] = useState<"deals" | "meetings">("deals");
  return (
    <div className="p-6 space-y-5 max-w-[110rem]">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Briefcase className="w-6 h-6 text-primary" /> الصفقات والمواعيد</h1>
        <p className="text-sm text-muted-foreground mt-1">كل عميل يسخن في واتساب أو البريد أو إنستجرام أو تيك توك يصبح صفقة تلقائياً. من هنا: اجتماع، عرض سعر يكتبه عمّار وتعتمده أنت، ثم تعاقد.</p>
      </div>
      <div className="flex gap-1 border-b border-card-border">
        {([["deals", "الصفقات", Briefcase], ["meetings", "المواعيد", CalendarDays]] as const).map(([k, l, Icon]) => (
          <button key={k} onClick={() => setTab(k)} className={cn("flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}><Icon className="w-4 h-4" /> {l}</button>
        ))}
      </div>
      {tab === "deals" ? <Board /> : <Meetings />}
    </div>
  );
}

// ── The board ────────────────────────────────────────────────────
function Board() {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["deals"], queryFn: () => api("/api/deals"), refetchInterval: 30_000 });
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [nf, setNf] = useState({ title: "", company: "", contactName: "", email: "", phone: "", service: "" });
  const create = useMutation({ mutationFn: () => api("/api/deals", { method: "POST", body: JSON.stringify(nf) }), onSuccess: (r: any) => { setAdding(false); setNf({ title: "", company: "", contactName: "", email: "", phone: "", service: "" }); qc.invalidateQueries({ queryKey: ["deals"] }); setOpen(r.deal.id); }, onError: (e: Error) => toast.error(e.message) });
  const move = useMutation({ mutationFn: ({ id, stage }: any) => api(`/api/deals/${id}`, { method: "PATCH", body: JSON.stringify({ stage }) }), onSuccess: () => qc.invalidateQueries({ queryKey: ["deals"] }) });
  if (!data) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const deals: any[] = data.deals ?? [];
  const totals = data.totals ?? {};

  return (
    <div className="space-y-4">
      {open && <DealDrawer id={open} onClose={() => setOpen(null)} />}
      <div className="flex items-center gap-3 flex-wrap">
        <div className={cn(card, "px-3 py-2 text-xs")}>مفتوحة: <b>{n(deals.filter((d) => !["won", "lost"].includes(d.stage)).length)}</b></div>
        <div className={cn(card, "px-3 py-2 text-xs")}>قيمة المفتوحة: <b>{aed(["lead", "meeting", "proposal", "negotiation"].reduce((a, s) => a + (totals[s]?.value ?? 0), 0))}</b></div>
        <div className={cn(card, "px-3 py-2 text-xs text-primary")}>تعاقدنا (٣٠ يوماً): <b>{n(data.won30?.n)}</b> · {aed(data.won30?.value)}</div>
        <button onClick={() => setAdding(!adding)} className={cn(primary, "mr-auto")}><Plus className="w-3.5 h-3.5" /> صفقة يدوية</button>
      </div>
      {adding && (
        <div className={cn(card, "p-3 grid md:grid-cols-6 gap-2")}>
          {([["company", "الشركة"], ["contactName", "الشخص"], ["email", "البريد"], ["phone", "الهاتف"], ["service", "الخدمة"]] as const).map(([k, l]) => (
            <input key={k} className={cn(input, "text-xs")} placeholder={l} value={(nf as any)[k]} onChange={(e) => setNf({ ...nf, [k]: e.target.value })} dir={k === "email" || k === "phone" ? "ltr" : undefined} />
          ))}
          <button onClick={() => create.mutate()} disabled={!nf.company.trim()} className={primary}>أنشئ</button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3 items-start">
        {STAGES.map((s) => {
          const col = deals.filter((d) => d.stage === s);
          return (
            <div key={s} className={cn(card, "border-t-4 overflow-hidden", STAGE_TONE[s])}
              onDragOver={(e) => e.preventDefault()} onDrop={(e) => { const id = Number(e.dataTransfer.getData("deal")); if (id) move.mutate({ id, stage: s }); }}>
              <div className="p-2.5 border-b border-card-border flex items-center gap-2"><p className="text-sm font-semibold flex-1">{data.stages[s]}</p><span className="text-[10px] text-muted-foreground">{n(col.length)}{totals[s]?.value ? ` · ${aed(totals[s].value)}` : ""}</span></div>
              <div className="p-2 space-y-2 min-h-[6rem] max-h-[70vh] overflow-y-auto">
                {col.map((d) => (
                  <button key={d.id} draggable onDragStart={(e) => e.dataTransfer.setData("deal", String(d.id))} onClick={() => setOpen(d.id)} className="w-full text-right rounded-lg border border-card-border bg-background/40 p-2.5 hover:border-primary/40 space-y-1">
                    <p className="text-xs font-semibold truncate" dir="auto">{d.title}</p>
                    <p className="text-[10px] text-muted-foreground truncate">{data.channels[d.channel] ?? d.channel}{d.service ? ` · ${d.service}` : ""}{d.valueAed ? ` · ${aed(d.valueAed)}` : ""}</p>
                    {d.nextStep && <p className={cn("text-[10px] truncate", d.nextAt && new Date(d.nextAt) < new Date() ? "text-red-400" : "text-muted-foreground")}>← {d.nextStep}</p>}
                  </button>
                ))}
                {!col.length && <p className="text-[10px] text-muted-foreground text-center py-4">اسحب صفقة إلى هنا</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── One deal ─────────────────────────────────────────────────────
function DealDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["deal", id], queryFn: () => api(`/api/deals/${id}`) });
  const { data: meta } = useQuery<any>({ queryKey: ["deals"], queryFn: () => api("/api/deals") });
  const [edit, setEdit] = useState<any>(null);
  const [svc, setSvc] = useState("");
  const inv = () => { qc.invalidateQueries({ queryKey: ["deal", id] }); qc.invalidateQueries({ queryKey: ["deals"] }); };
  const save = useMutation({ mutationFn: (b: any) => api(`/api/deals/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: () => { setEdit(null); inv(); } });
  const write = useMutation({ mutationFn: () => api(`/api/deals/${id}/proposals`, { method: "POST", body: JSON.stringify({ service: svc || undefined }) }), onSuccess: (r: any) => { inv(); r.issues?.length ? toast.warning(`كتب عمّار العرض — ${r.issues[0]}`) : toast.success("كتب عمّار العرض — راجعه وأرسله"); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: () => api(`/api/deals/${id}`, { method: "DELETE" }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["deals"] }); onClose(); } });
  if (!data) return null;
  const d = data.deal;
  const e = edit ?? d;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex justify-start" onClick={onClose}>
      <div className="w-full max-w-3xl h-full bg-background border-l border-card-border overflow-y-auto" onClick={(ev) => ev.stopPropagation()}>
        <div className="sticky top-0 bg-background/95 backdrop-blur border-b border-card-border p-4 flex items-center gap-2 z-10">
          <p className="font-bold text-lg flex-1 truncate" dir="auto">{d.title}</p>
          <select className={cn(input, "w-40 text-xs")} value={d.stage} onChange={(ev) => { const st = ev.target.value; const reason = st === "lost" ? prompt("لماذا خسرناه؟ (اختياري)") : undefined; save.mutate({ stage: st, lostReason: reason ?? undefined }); }}>
            {STAGES.map((s) => <option key={s} value={s}>{meta?.stages?.[s] ?? s}</option>)}
          </select>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className={cn(card, "p-3 grid md:grid-cols-2 gap-2")}>
            {([["company", "الشركة"], ["contactName", "الشخص"], ["email", "البريد"], ["phone", "الهاتف"], ["service", "الخدمة"], ["valueAed", "القيمة (درهم)"], ["nextStep", "الخطوة التالية"]] as const).map(([k, l]) => (
              <label key={k} className="text-[10px] text-muted-foreground">{l}<input className={cn(input, "text-xs mt-0.5")} dir={k === "email" || k === "phone" ? "ltr" : "auto"} value={e[k] ?? ""} onChange={(ev) => setEdit({ ...e, [k]: ev.target.value })} /></label>
            ))}
            <label className="text-[10px] text-muted-foreground">موعد الخطوة<input type="datetime-local" className={cn(input, "text-xs mt-0.5")} value={e.nextAt ? new Date(new Date(e.nextAt).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ""} onChange={(ev) => setEdit({ ...e, nextAt: ev.target.value })} /></label>
            <label className="text-[10px] text-muted-foreground md:col-span-2">ملاحظات<textarea className={cn(input, "text-xs mt-0.5 min-h-[3rem]")} value={e.notes ?? ""} onChange={(ev) => setEdit({ ...e, notes: ev.target.value })} /></label>
            {edit && <button onClick={() => save.mutate({ company: e.company, contactName: e.contactName, email: e.email, phone: e.phone, service: e.service, valueAed: e.valueAed, nextStep: e.nextStep, nextAt: e.nextAt || null, notes: e.notes })} className={primary}><Check className="w-3.5 h-3.5" /> احفظ</button>}
          </div>

          <div className={card}>
            <div className="p-3 border-b border-card-border flex items-center gap-2 flex-wrap"><FileText className="w-4 h-4 text-primary" /><p className="text-sm font-semibold flex-1">عروض الأسعار</p>
              <input className={cn(input, "w-48 text-xs")} placeholder={d.service || "الخدمة (اختياري)"} value={svc} onChange={(ev) => setSvc(ev.target.value)} />
              <button onClick={() => write.mutate()} disabled={write.isPending} className={primary}>{write.isPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> عمّار يكتب…</> : <><Sparkles className="w-3.5 h-3.5" /> اكتب عرض سعر</>}</button>
            </div>
            {!data.proposals.length ? <p className="p-5 text-center text-xs text-muted-foreground">لا عروض بعد. يكتب عمّار العرض مما قاله العميل في كل القنوات ومن معرفة الشركة، ويترك السعر خانة تملؤها أنت إن لم يجده في المعرفة.</p>
              : <div className="divide-y divide-card-border">{data.proposals.map((p: any) => <ProposalRow key={p.id} p={p} deal={d} onDone={inv} />)}</div>}
          </div>

          {!!data.meetings.length && (
            <div className={card}>
              <div className="p-3 border-b border-card-border"><p className="text-sm font-semibold">الاجتماعات</p></div>
              {data.meetings.map((m: any) => <div key={m.id} className="p-3 text-xs flex gap-2 border-t border-card-border first:border-0"><CalendarDays className="w-3.5 h-3.5 text-primary" /> {when(m.startsAt)} · {m.status === "booked" ? "محجوز" : m.status === "done" ? "تم" : m.status === "cancelled" ? "أُلغي" : "لم يحضر"}{m.topic ? ` · ${m.topic}` : ""}</div>)}
            </div>
          )}

          <div className={card}>
            <div className="p-3 border-b border-card-border"><p className="text-sm font-semibold">كل ما قيل مع العميل — في كل القنوات</p></div>
            {!data.timeline.length ? <p className="p-5 text-center text-xs text-muted-foreground">لا رسائل مسجّلة لهذا العميل بعد.</p> : (
              <div className="p-3 space-y-1.5 max-h-[50vh] overflow-y-auto">{data.timeline.map((t: any, i: number) => (
                <div key={i} className={cn("flex", t.fromUs ? "justify-start" : "justify-end")}>
                  <div className={cn("max-w-[80%] rounded-lg px-2.5 py-1.5 text-xs", t.fromUs ? "bg-primary/10" : "bg-muted/50")}>
                    <p className="text-[9px] text-muted-foreground">{t.fromUs ? "نحن" : "العميل"} · {meta?.channels?.[t.channel] ?? t.channel} · {when(t.at)}</p>
                    <p className="whitespace-pre-wrap" dir="auto">{t.text.slice(0, 600)}</p>
                  </div>
                </div>
              ))}</div>
            )}
          </div>
          <button onClick={() => { if (confirm("حذف الصفقة نهائياً؟")) del.mutate(); }} className={cn(ghost, "text-red-400")}><Trash2 className="w-3 h-3" /> احذف الصفقة</button>
        </div>
      </div>
    </div>
  );
}

function ProposalRow({ p, deal, onDone }: { p: any; deal: any; onDone: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [to, setTo] = useState(deal.email ?? "");
  const [fu, setFu] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const blanks = useMemo(() => [...new Set(((html ?? p.html) as string).match(/\[\[[^\]]+\]\]/g) ?? [])], [html, p.html]);
  const saveHtml = useMutation({ mutationFn: () => api(`/api/deals/proposals/${p.id}`, { method: "PATCH", body: JSON.stringify({ html }) }), onSuccess: (r: any) => { setIssues(r.issues ?? []); setHtml(null); onDone(); toast.success("حُفظ"); } });
  const send = useMutation({ mutationFn: () => api(`/api/deals/proposals/${p.id}/send`, { method: "POST", body: JSON.stringify({ html: html ?? undefined, to }) }), onSuccess: () => { setHtml(null); onDone(); toast.success("أُرسل العرض"); }, onError: (e: Error) => toast.error(e.message) });
  const outcome = useMutation({ mutationFn: (o: string) => api(`/api/deals/proposals/${p.id}/outcome`, { method: "POST", body: JSON.stringify({ outcome: o }) }), onSuccess: onDone });
  const sendFu = useMutation({ mutationFn: () => api(`/api/deals/proposals/${p.id}/followup`, { method: "POST", body: JSON.stringify({ text: fu ?? undefined }) }), onSuccess: () => { setFu(null); onDone(); toast.success("أُرسلت المتابعة"); }, onError: (e: Error) => toast.error(e.message) });
  const ST: Record<string, string> = { draft: "مسودة", approved: "معتمد", sent: "أُرسل", accepted: "قُبل ✓", declined: "رُفض" };
  return (
    <div className="p-3 space-y-2">
      <div className="flex items-center gap-2 text-xs"><b className="flex-1 truncate" dir="auto">{p.title}</b><span className="text-muted-foreground">{ST[p.status]}{p.sentAt ? ` · ${when(p.sentAt)}` : ""}{p.followups ? ` · تابعنا ${n(p.followups)}` : ""}</span></div>
      {html === null ? <div className="rounded-lg border border-card-border bg-white text-black p-3 text-sm max-h-80 overflow-y-auto [&_h3]:font-bold [&_h3]:mt-2 [&_ul]:list-disc [&_ul]:pr-5 [&_table]:w-full [&_td]:border [&_td]:p-1" dir="auto" dangerouslySetInnerHTML={{ __html: p.html.replace(/\[\[([^\]]+)\]\]/g, '<mark style="background:#fde68a">[[$1]]</mark>') }} />
        : <textarea className={cn(input, "min-h-[16rem] font-mono text-[11px]")} dir="auto" value={html} onChange={(ev) => setHtml(ev.target.value)} />}
      {!!blanks.length && <p className="text-[11px] text-yellow-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> املأ قبل الإرسال: {blanks.join("، ")}</p>}
      {issues.filter((x) => !x.startsWith("خانات")).map((x) => <p key={x} className="text-[11px] text-orange-400">{x}</p>)}
      {p.status === "draft" && (
        <div className="flex gap-1.5 flex-wrap items-center">
          {html === null ? <button onClick={() => setHtml(p.html)} className={ghost}>عدّل</button> : <button onClick={() => saveHtml.mutate()} className={ghost}><Check className="w-3 h-3" /> احفظ التعديل</button>}
          <input className={cn(input, "w-56 text-xs")} dir="ltr" placeholder="بريد العميل" value={to} onChange={(ev) => setTo(ev.target.value)} />
          <button onClick={() => send.mutate()} disabled={send.isPending || !!blanks.length || !to} className={primary}>{send.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} اعتمد وأرسل</button>
        </div>
      )}
      {p.status === "sent" && (
        <div className="space-y-2">
          {p.followupDraft && <div className="rounded-lg border border-dashed border-yellow-500/50 p-2.5 text-xs space-y-1.5"><p className="text-[10px] text-yellow-400">متابعة كتبها عمّار — تنتظرك</p>
            {fu === null ? <p className="whitespace-pre-wrap" dir="auto">{p.followupDraft}</p> : <textarea className={cn(input, "min-h-[4rem] text-xs")} dir="auto" value={fu} onChange={(ev) => setFu(ev.target.value)} />}
            <div className="flex gap-1.5">{fu === null && <button onClick={() => setFu(p.followupDraft)} className={ghost}>عدّل</button>}<button onClick={() => sendFu.mutate()} className={cn(primary, "py-1.5")}><Send className="w-3 h-3" /> أرسل المتابعة</button></div></div>}
          <div className="flex gap-1.5"><button onClick={() => outcome.mutate("accepted")} className={cn(ghost, "text-primary border-primary/40")}><Check className="w-3 h-3" /> قَبِل — تم التعاقد</button><button onClick={() => outcome.mutate("declined")} className={cn(ghost, "text-red-400")}><X className="w-3 h-3" /> رفض</button></div>
        </div>
      )}
    </div>
  );
}

// ── Meetings ─────────────────────────────────────────────────────
const DOW = ["", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"];
function Meetings() {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["client-meetings"], queryFn: () => api("/api/deals/meetings/all"), refetchInterval: 60_000 });
  const [slots, setSlots] = useState<any[] | null>(null);
  const [nb, setNb] = useState({ name: "", company: "", phone: "", email: "", startsAt: "", topic: "" });
  const inv = () => qc.invalidateQueries({ queryKey: ["client-meetings"] });
  const saveSettings = useMutation({ mutationFn: (b: any) => api("/api/deals/meetings/settings", { method: "PUT", body: JSON.stringify(b) }), onSuccess: () => { setSlots(null); inv(); toast.success("حُفظت أوقاتك"); } });
  const bookIt = useMutation({ mutationFn: () => api("/api/deals/meetings", { method: "POST", body: JSON.stringify(nb) }), onSuccess: () => { setNb({ name: "", company: "", phone: "", email: "", startsAt: "", topic: "" }); inv(); toast.success("حُجز الموعد وأُضيف للصفقات"); }, onError: (e: Error) => toast.error(e.message) });
  const patch = useMutation({ mutationFn: ({ id, ...b }: any) => api(`/api/deals/meetings/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv });
  if (!data) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const s = data.settings, sl = slots ?? s.slots;

  return (
    <div className="grid lg:grid-cols-[1fr_26rem] gap-4 items-start">
      <div className="space-y-4">
        <div className={card}>
          <div className="p-3 border-b border-card-border"><p className="text-sm font-semibold">المواعيد القادمة</p></div>
          {!data.meetings.length ? <p className="p-8 text-center text-xs text-muted-foreground">لا مواعيد بعد.</p> : <div className="divide-y divide-card-border">{data.meetings.map((m: any) => (
            <div key={m.id} className={cn("p-3 flex items-center gap-3 text-xs", m.status !== "booked" && "opacity-60")}>
              <div className="flex-1 min-w-0"><p className="font-semibold">{when(m.startsAt)} · {m.name}{m.company ? ` — ${m.company}` : ""}</p><p className="text-[10px] text-muted-foreground">{[m.phone, m.email, m.topic, m.source === "link" ? "حجزه العميل من الرابط" : ""].filter(Boolean).join(" · ")}</p></div>
              <a href={`${BASE}/api/deals/meetings/${m.id}/ics`} className={ghost} title="أضفه لتقويمك"><Download className="w-3 h-3" /> .ics</a>
              {m.status === "booked" && <><button onClick={() => patch.mutate({ id: m.id, status: "done" })} className={ghost}>تم</button><button onClick={() => patch.mutate({ id: m.id, status: "no_show" })} className={ghost}>لم يحضر</button><button onClick={() => patch.mutate({ id: m.id, status: "cancelled" })} className={ghost}><X className="w-3 h-3" /></button></>}
            </div>
          ))}</div>}
        </div>
        <div className={cn(card, "p-4 space-y-2")}>
          <p className="text-sm font-semibold">احجز موعداً لعميل</p>
          <div className="grid md:grid-cols-3 gap-2">
            <input className={cn(input, "text-xs")} placeholder="الاسم" value={nb.name} onChange={(e) => setNb({ ...nb, name: e.target.value })} />
            <input className={cn(input, "text-xs")} placeholder="الشركة" value={nb.company} onChange={(e) => setNb({ ...nb, company: e.target.value })} />
            <input className={cn(input, "text-xs")} dir="ltr" placeholder="الهاتف أو البريد" value={nb.phone || nb.email} onChange={(e) => setNb({ ...nb, ...(e.target.value.includes("@") ? { email: e.target.value, phone: "" } : { phone: e.target.value, email: "" }) })} />
            <select className={cn(input, "text-xs md:col-span-2")} value={nb.startsAt} onChange={(e) => setNb({ ...nb, startsAt: e.target.value })}><option value="">اختر وقتاً متاحاً…</option>{data.free.map((f: any) => <option key={f.at} value={f.at}>{f.label}</option>)}</select>
            <input className={cn(input, "text-xs")} placeholder="الموضوع" value={nb.topic} onChange={(e) => setNb({ ...nb, topic: e.target.value })} />
          </div>
          <button onClick={() => bookIt.mutate()} disabled={!nb.name.trim() || !nb.startsAt} className={primary}><Plus className="w-3.5 h-3.5" /> احجز</button>
        </div>
      </div>

      <div className="space-y-4">
        <div className={cn(card, "p-4 space-y-2")}>
          <p className="text-sm font-semibold flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" /> رابط الحجز للعملاء</p>
          <div className="flex gap-1.5"><input className={cn(input, "text-[11px]")} dir="ltr" readOnly value={data.bookingUrl} /><button onClick={() => { navigator.clipboard.writeText(data.bookingUrl); toast.success("نُسخ"); }} className={ghost}><Copy className="w-3 h-3" /></button></div>
          {!data.public && <p className="text-[10px] text-yellow-400">الرابط يعمل على هذا الجهاز فقط حتى يُضبط عنوان الموقع العام (SITE_URL) — نفس المطلوب لتتبّع فتح الإيميل.</p>}
          <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={s.offerInReplies} onChange={(e) => saveSettings.mutate({ offerInReplies: e.target.checked })} /><span>يقترح الموظفون هذه الأوقات بالضبط حين يطلب عميل مكالمة<span className="block text-[10px] text-muted-foreground">في ردود البريد وإنستجرام وتيك توك — ولا يؤكدون موعداً بأنفسهم.</span></span></label>
        </div>
        <div className={cn(card, "p-4 space-y-3")}>
          <p className="text-sm font-semibold">أوقاتك للمكالمات (بتوقيت الخليج)</p>
          {sl.map((x: any, i: number) => (
            <div key={i} className="flex gap-1.5 items-center">
              <select className={cn(input, "text-xs w-28")} value={x.dow} onChange={(e) => { const c = [...sl]; c[i] = { ...x, dow: Number(e.target.value) }; setSlots(c); }}>{DOW.slice(1).map((d, j) => <option key={j} value={j + 1}>{d}</option>)}</select>
              <input type="time" className={cn(input, "text-xs")} value={x.from} onChange={(e) => { const c = [...sl]; c[i] = { ...x, from: e.target.value }; setSlots(c); }} />
              <input type="time" className={cn(input, "text-xs")} value={x.to} onChange={(e) => { const c = [...sl]; c[i] = { ...x, to: e.target.value }; setSlots(c); }} />
              <button onClick={() => setSlots(sl.filter((_: any, j: number) => j !== i))} className="text-muted-foreground hover:text-red-400"><X className="w-3.5 h-3.5" /></button>
            </div>
          ))}
          <button onClick={() => setSlots([...sl, { dow: 1, from: "10:00", to: "13:00" }])} className={ghost}><Plus className="w-3 h-3" /> فترة</button>
          <div className="grid grid-cols-2 gap-2">
            {([["durationMin", "مدة المكالمة (د)"], ["bufferMin", "فاصل بينها (د)"], ["noticeHours", "أقل مهلة للحجز (س)"], ["reminderMin", "ذكّرني قبل (د)"]] as const).map(([k, l]) => (
              <label key={k} className="text-[10px] text-muted-foreground">{l}<input type="number" className={cn(input, "text-xs mt-0.5")} defaultValue={s[k]} onBlur={(e) => saveSettings.mutate({ [k]: Number(e.target.value) })} /></label>
            ))}
          </div>
          {slots && <button onClick={() => saveSettings.mutate({ slots })} className={primary}><Check className="w-3.5 h-3.5" /> احفظ الأوقات</button>}
          <p className="text-[10px] text-muted-foreground">قبل كل اجتماع يصلك على تيليجرام كل ما قاله العميل في كل القنوات.</p>
        </div>
      </div>
    </div>
  );
}
