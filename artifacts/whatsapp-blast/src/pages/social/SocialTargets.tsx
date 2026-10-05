// ── Who the team writes to first: lists, and the first messages waiting ──
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { ArrowRight, Check, CheckCheck, Loader2, Pencil, Plus, Search, Sparkles, Trash2, Upload, X, ExternalLink, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { card, ghost, primary, n, ago, PLATFORM_UI, useDesk, type Platform } from "./SocialDesk";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
export const T_STATUS: Record<string, [string, string]> = {
  new: ["جديد", "bg-muted text-muted-foreground"], drafted: ["مسودة تنتظرك", "bg-yellow-500/15 text-yellow-400"], approved: ["معتمدة", "bg-primary/15 text-primary"],
  invited: ["دُعي — ينتظر القبول", "bg-sky-500/15 text-sky-400"], sent: ["أُرسلت — ينتظر رداً", "bg-sky-500/15 text-sky-400"], replied: ["ردّ ✓", "bg-green-500/15 text-green-400"],
  declined: ["رفض — لن نراسله", "bg-red-500/10 text-red-400"], unreachable: ["لا يستقبل رسائل", "bg-muted text-muted-foreground"], skipped: ["تخطّيناه", "bg-muted text-muted-foreground"], failed: ["فشل", "bg-red-500/10 text-red-400"],
};
const SEARCH_HINT: Record<Platform, string> = {
  instagram: "مثلاً: dubai real estate · عقارات دبي",
  tiktok: "مثلاً: dubai properties · عقارات الإمارات",
  linkedin: "مثلاً: real estate broker Dubai · CEO real estate Abu Dhabi",
};

// ── Lists ────────────────────────────────────────────────────────
export function ListsTab({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const { data: desk } = useDesk(p);
  const { data: lists = [] } = useQuery<any[]>({ queryKey: ["social-lists", p], queryFn: () => api(`/api/social/${p}/lists`) });
  const [name, setName] = useState("");
  const [q, setQ] = useState("");
  const [max, setMax] = useState(30);
  const inv = () => { qc.invalidateQueries({ queryKey: ["social-lists", p] }); qc.invalidateQueries({ queryKey: ["social", p] }); };
  const create = useMutation({ mutationFn: () => api(`/api/social/${p}/lists`, { method: "POST", body: JSON.stringify({ name }) }), onSuccess: (l: any) => { setName(""); inv(); go(`/${p}/lists/${l.id}`); }, onError: (e: Error) => toast.error(e.message) });
  const search = useMutation({ mutationFn: () => api(`/api/social/${p}/search`, { method: "POST", body: JSON.stringify({ query: q, max }) }), onSuccess: (d: any) => { inv(); toast.success(`وجد الفريق ${n(d.found)} — أُضيف ${n(d.added)}`); go(`/${p}/lists/${d.listId}`); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/social/${p}/lists/${id}`, { method: "DELETE" }), onSuccess: inv });
  const signedIn = desk?.account?.state === "logged_in";
  const listIds: number[] = desk?.account?.listIds ?? [];

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-3">
        <div className={cn(card, "p-4 space-y-2.5")}>
          <p className="text-sm font-semibold flex items-center gap-2"><Search className="w-4 h-4 text-primary" /> ابحث في {PLATFORM_UI[p].label} وابنِ قائمة</p>
          <p className="text-[11px] text-muted-foreground">يبحث الموظف من حسابك كما تبحث أنت، ويضع النتائج في قائمة جديدة تراجعها قبل أي رسالة.</p>
          <div className="flex gap-2"><input className={cn(input, "text-sm")} placeholder={SEARCH_HINT[p]} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && q.trim() && search.mutate()} />
            <select className={cn(input, "w-24 text-xs")} value={max} onChange={(e) => setMax(Number(e.target.value))}>{[20, 30, 50].map((v) => <option key={v} value={v}>{n(v)}</option>)}</select></div>
          <button onClick={() => search.mutate()} disabled={!q.trim() || search.isPending || !signedIn} className={primary}>{search.isPending ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> يبحث… (دقيقة تقريباً)</> : <><Search className="w-3.5 h-3.5" /> ابحث</>}</button>
          {!signedIn && <p className="text-[11px] text-yellow-400">سجّل دخول الحساب أولاً من «الحساب والإعدادات».</p>}
        </div>
        <div className={cn(card, "p-4 space-y-2.5")}>
          <p className="text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4 text-primary" /> قائمة جديدة من ملف أو أسماء</p>
          <p className="text-[11px] text-muted-foreground">أنشئ القائمة ثم ارفع ملف Excel فيه روابط الحسابات، أو الصق الأسماء سطراً سطراً.</p>
          <div className="flex gap-2"><input className={cn(input, "text-sm")} placeholder="اسم القائمة — مثلاً: وسطاء عقاريون دبي" value={name} onChange={(e) => setName(e.target.value)} />
            <button onClick={() => create.mutate()} disabled={!name.trim()} className={primary}>أنشئ</button></div>
        </div>
      </div>

      {!lists.length ? <div className={cn(card, "p-10 text-center text-sm text-muted-foreground")}>لا قوائم بعد.</div> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {lists.map((l) => (
            <div key={l.id} className={cn(card, "p-4 space-y-3 hover:border-primary/40 cursor-pointer")} onClick={() => go(`/${p}/lists/${l.id}`)}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0"><p className="font-semibold truncate">{l.name}</p><p className="text-[10px] text-muted-foreground">{l.sector ?? "قطاعات متعددة"}{l.query ? ` · بحث «${l.query}»` : ""} · {ago(l.created_at)}</p></div>
                {listIds.includes(l.id) && <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/15 text-primary">يعمل عليها الفريق</span>}
                <button onClick={(e) => { e.stopPropagation(); if (confirm("حذف القائمة؟ من تواصلنا معهم يبقون في السجل.")) del.mutate(l.id); }} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
              <div className="grid grid-cols-4 gap-1 text-center">
                {[["الكل", l.total], ["تنتظرك", l.queued], ["تواصلنا", l.reached], ["ردّوا", l.replied]].map(([lb, v]: any, i) => (
                  <div key={lb} className={cn("rounded-md py-1.5", i === 3 ? "bg-primary/10" : "bg-muted/40")}><p className="text-base font-bold">{n(v)}</p><p className="text-[9px] text-muted-foreground">{lb}</p></div>
                ))}
              </div>
              {l.reached > 0 && <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary" style={{ width: `${Math.round((l.replied / l.reached) * 100)}%` }} /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── One list ─────────────────────────────────────────────────────
export function ListDetail({ p, id }: { p: Platform; id: number }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const { data: desk } = useDesk(p);
  const { data: lists = [] } = useQuery<any[]>({ queryKey: ["social-lists", p], queryFn: () => api(`/api/social/${p}/lists`) });
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [paste, setPaste] = useState("");
  const [picked, setPicked] = useState<number[]>([]);
  const { data } = useQuery<any>({ queryKey: ["social-targets", p, id, status, q, page], queryFn: () => api(`/api/social/${p}/targets?listId=${id}&status=${status}&page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`) });
  const list = lists.find((l) => l.id === id);
  const inv = () => { for (const k of ["social-targets", "social-lists", "social"]) qc.invalidateQueries({ queryKey: [k, p] }); };
  const set = useMutation({ mutationFn: (b: any) => api(`/api/social/${p}/settings`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv });
  const add = useMutation({ mutationFn: () => api(`/api/social/${p}/lists/${id}/targets`, { method: "POST", body: JSON.stringify({ text: paste }) }), onSuccess: (d: any) => { setPaste(""); inv(); toast.success(`أُضيف ${n(d.added)}${d.duplicate ? ` · ${n(d.duplicate)} موجود من قبل` : ""}${d.invalid ? ` · ${n(d.invalid)} غير صالح` : ""}`); } });
  const prepare = useMutation({ mutationFn: () => api(`/api/social/${p}/lists/${id}/prepare`, { method: "POST", body: JSON.stringify({ max: 10 }) }), onSuccess: (d: any) => { inv(); toast.success(d.drafted ? `كتب الفريق ${n(d.drafted)} رسالة أولى — راجعها في «التواصل الأول»` : "لا أحد جديد لم يُكتب له"); }, onError: (e: Error) => toast.error(e.message) });
  const bulk = useMutation({ mutationFn: (action: string) => api(`/api/social/${p}/targets/bulk`, { method: "POST", body: JSON.stringify({ ids: picked, action }) }), onSuccess: (d: any) => { setPicked([]); inv(); toast.success(`${n(d.n)} تم`); } });
  const upload = async (f: File) => {
    const fd = new FormData(); fd.append("file", f);
    const r = await fetch(`${BASE}/api/social/${p}/lists/${id}/import`, { method: "POST", body: fd, credentials: "include" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { toast.error(d.error ?? "تعذّر الرفع"); return; }
    inv(); toast.success(`من ${n(d.rows)} صفاً: أُضيف ${n(d.added)}${d.duplicate ? ` · ${n(d.duplicate)} موجود` : ""}`);
  };
  const working = (desk?.account?.listIds ?? []).includes(id);
  const counts = data?.counts ?? {};
  const rows: any[] = data?.rows ?? [];
  const total = Object.values(counts).reduce((a: number, b: any) => a + Number(b), 0) as number;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => go(`/${p}/lists`)} className={ghost}><ArrowRight className="w-3.5 h-3.5" /> القوائم</button>
        <h2 className="text-lg font-bold flex-1">{list?.name ?? "…"}</h2>
        <button onClick={() => set.mutate({ listIds: working ? (desk.account.listIds as number[]).filter((x) => x !== id) : [...(desk?.account?.listIds ?? []), id] })} className={working ? cn(ghost, "border-primary/50 text-primary") : primary}>{working ? "✓ الفريق يكتب لهذه القائمة" : "اجعل الفريق يكتب لهذه القائمة"}</button>
        <button onClick={() => prepare.mutate()} disabled={prepare.isPending} className={ghost}>{prepare.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} اكتب ١٠ رسائل أولى الآن</button>
      </div>

      <div className="grid md:grid-cols-[1fr_20rem] gap-3">
        <div className={cn(card, "p-3 flex gap-2 items-start")}>
          <textarea className={cn(input, "min-h-[3.2rem] text-xs")} dir="ltr" placeholder={`الصق روابط أو أسماء حسابات ${PLATFORM_UI[p].label}، واحد في كل سطر`} value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button onClick={() => add.mutate()} disabled={!paste.trim() || add.isPending} className={primary}><Plus className="w-3.5 h-3.5" /> أضف</button>
        </div>
        <label className={cn(card, "p-3 flex items-center justify-center gap-2 text-xs text-muted-foreground cursor-pointer hover:border-primary/50")}>
          <Upload className="w-4 h-4" /> ارفع Excel / CSV فيه عمود روابط أو أسماء حسابات
          <input type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        </label>
      </div>

      <div className={card}>
        <div className="p-3 border-b border-card-border flex gap-1.5 flex-wrap items-center">
          {(["all", "new", "drafted", "approved", "sent", "replied", "declined", "unreachable"] as const).map((k) => (
            <button key={k} onClick={() => { setStatus(k); setPage(0); }} className={cn("px-2.5 py-1 rounded-full border text-[11px]", status === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{k === "all" ? `الكل (${n(total)})` : `${T_STATUS[k]?.[0]} (${n(counts[k])})`}</button>
          ))}
          <input className={cn(input, "w-48 text-xs mr-auto")} placeholder="بحث بالاسم أو الحساب" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        </div>
        {!!picked.length && (
          <div className="px-3 py-2 border-b border-card-border flex gap-1.5 items-center text-xs bg-primary/5">
            <span>{n(picked.length)} محدد</span>
            <button onClick={() => bulk.mutate("approve")} className={cn(primary, "py-1")}><CheckCheck className="w-3 h-3" /> اعتمد المسودات</button>
            <button onClick={() => bulk.mutate("skip")} className={cn(ghost, "py-1")}><X className="w-3 h-3" /> تخطَّ</button>
            <button onClick={() => bulk.mutate("reset")} className={cn(ghost, "py-1")}><RotateCcw className="w-3 h-3" /> أعد الكتابة</button>
            <button onClick={() => bulk.mutate("delete")} className={cn(ghost, "py-1 text-red-400")}><Trash2 className="w-3 h-3" /> احذف</button>
          </div>
        )}
        <div className="overflow-x-auto max-h-[65vh] overflow-y-auto">
          {!rows.length ? <p className="p-10 text-center text-xs text-muted-foreground">لا أحد هنا.</p> : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card z-10"><tr className="text-muted-foreground"><th className="p-2 w-8"><input type="checkbox" checked={picked.length === rows.length} onChange={(e) => setPicked(e.target.checked ? rows.map((r) => r.id) : [])} /></th><th className="text-right p-2">الحساب</th><th className="text-right p-2">الحالة</th><th className="text-right p-2">الرسالة الأولى</th><th className="text-right p-2">آخر حركة</th></tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.id} className="border-t border-card-border align-top">
                  <td className="p-2"><input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, r.id] : picked.filter((x) => x !== r.id))} /></td>
                  <td className="p-2 max-w-[16rem]"><a href={r.profileUrl ?? "#"} target="_blank" rel="noreferrer" className="font-medium flex items-center gap-1" dir="auto">{r.name || `@${r.handle}`} <ExternalLink className="w-3 h-3 text-muted-foreground" /></a><p className="text-[10px] text-muted-foreground" dir="ltr">@{r.handle}</p>{r.headline && <p className="text-[10px] text-muted-foreground line-clamp-2" dir="auto">{r.headline}</p>}</td>
                  <td className="p-2"><span className={cn("px-2 py-0.5 rounded-full text-[10px] whitespace-nowrap", T_STATUS[r.status]?.[1])}>{T_STATUS[r.status]?.[0] ?? r.status}</span>{r.followups > 0 && <p className="text-[10px] text-muted-foreground mt-1">تابعناه مرة</p>}</td>
                  <td className="p-2 max-w-[24rem]"><p className="line-clamp-3 whitespace-pre-wrap" dir="auto">{r.draft ?? <span className="text-muted-foreground">—</span>}</p>{r.note && r.status !== "new" && <p className="text-[10px] text-muted-foreground mt-1">{r.note}</p>}</td>
                  <td className="p-2 text-muted-foreground whitespace-nowrap">{ago(r.repliedAt ?? r.sentAt ?? r.updatedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        {total > (data?.limit ?? 100) && <div className="p-2 border-t border-card-border flex justify-center gap-2 text-xs"><button disabled={!page} onClick={() => setPage(page - 1)} className={ghost}>السابق</button><span className="py-2">{n(page + 1)}</span><button disabled={rows.length < (data?.limit ?? 100)} onClick={() => setPage(page + 1)} className={ghost}>التالي</button></div>}
      </div>
    </div>
  );
}

// ── First messages waiting for the owner ─────────────────────────
export function OutreachTab({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const { data } = useQuery<any>({ queryKey: ["social-targets", p, "queue"], queryFn: () => api(`/api/social/${p}/targets?status=drafted`), refetchInterval: 30_000 });
  const { data: followups = [] } = useQuery<any[]>({ queryKey: ["social-followups", p], queryFn: () => api(`/api/social/${p}/messages?status=drafted`) });
  const inv = () => { for (const k of ["social-targets", "social-followups", "social", "social-lists"]) qc.invalidateQueries({ queryKey: [k, p] }); };
  const bulk = useMutation({ mutationFn: (b: { ids: number[]; action: string }) => api(`/api/social/${p}/targets/bulk`, { method: "POST", body: JSON.stringify(b) }), onSuccess: (d: any) => { inv(); toast.success(`${n(d.n)} تم`); } });
  const rows: any[] = data?.rows ?? [];
  const fu = followups.filter((m) => m.kind === "followup");

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-3.5 text-xs text-muted-foreground leading-relaxed")}>
        الفريق يكتب أولاً <b className="text-foreground">فقط</b> لمن في قوائم اخترتها، رسالة واحدة ثم متابعة واحدة إن لم يرد، ويتوقف فوراً عند أي رد أو رفض. {p === "linkedin" ? "في لينكدإن: أول تواصل دعوة اتصال بملاحظة قصيرة، والرسالة بعد القبول." : ""} ما تعتمده هنا يُرسل في الجولة القادمة داخل الحد اليومي.
      </div>
      <div className={card}>
        <div className="p-3 border-b border-card-border flex items-center gap-2">
          <p className="text-sm font-semibold flex-1">رسائل أولى تنتظرك ({n(rows.length)})</p>
          {!!rows.length && <button onClick={() => bulk.mutate({ ids: rows.map((r) => r.id), action: "approve" })} className={primary}><CheckCheck className="w-3.5 h-3.5" /> اعتمد الكل</button>}
        </div>
        {!rows.length ? <p className="p-10 text-center text-xs text-muted-foreground">لا شيء ينتظرك. اختر قائمة يكتب لها الفريق من <button onClick={() => go(`/${p}/lists`)} className="text-primary underline">قوائم الاستهداف</button>، ثم «اكتب ١٠ رسائل أولى الآن».</p>
          : <div className="divide-y divide-card-border">{rows.map((r) => <OutreachRow key={r.id} p={p} r={r} onDone={inv} onSkip={() => bulk.mutate({ ids: [r.id], action: "skip" })} />)}</div>}
      </div>
      {!!fu.length && (
        <div className={card}>
          <div className="p-3 border-b border-card-border"><p className="text-sm font-semibold">متابعات تنتظرك ({n(fu.length)}) — الأخيرة لكل واحد</p></div>
          <div className="divide-y divide-card-border">{fu.map((m) => (
            <div key={m.id} className="p-3 text-sm flex gap-3 items-start">
              <div className="flex-1 min-w-0"><p className="text-xs font-semibold mb-1" dir="auto">{m.name || `@${m.handle}`}</p><p className="whitespace-pre-wrap" dir="auto">{m.text}</p></div>
              <button onClick={() => go(`/${p}/inbox/${m.threadId}`)} className={cn(ghost, "py-1.5")}>افتح المحادثة</button>
            </div>
          ))}</div>
        </div>
      )}
    </div>
  );
}

function OutreachRow({ p, r, onDone, onSkip }: { p: Platform; r: any; onDone: () => void; onSkip: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const approve = useMutation({ mutationFn: () => api(`/api/social/${p}/targets/${r.id}/approve`, { method: "POST", body: JSON.stringify({ draft: edit ?? undefined }) }), onSuccess: () => { setEdit(null); onDone(); } });
  return (
    <div className="p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <a href={r.profileUrl ?? "#"} target="_blank" rel="noreferrer" className="font-semibold flex items-center gap-1" dir="auto">{r.name || `@${r.handle}`} <ExternalLink className="w-3 h-3 text-muted-foreground" /></a>
        {r.headline && <span className="text-muted-foreground truncate" dir="auto">{r.headline}</span>}
      </div>
      {edit === null ? <p className="text-sm whitespace-pre-wrap rounded-lg bg-muted/30 p-2.5" dir="auto">{r.draft}</p>
        : <textarea className={cn(input, "min-h-[5rem]")} dir="auto" value={edit} onChange={(e) => setEdit(e.target.value)} autoFocus />}
      <div className="flex gap-1.5">
        <button onClick={() => approve.mutate()} className={cn(primary, "py-1.5")}><Check className="w-3 h-3" /> {edit === null ? "اعتمد" : "احفظ واعتمد"}</button>
        {edit === null && <button onClick={() => setEdit(r.draft ?? "")} className={cn(ghost, "py-1.5")}><Pencil className="w-3 h-3" /> عدّل</button>}
        <button onClick={onSkip} className={cn(ghost, "py-1.5")}><X className="w-3 h-3" /> تخطَّ</button>
      </div>
    </div>
  );
}
