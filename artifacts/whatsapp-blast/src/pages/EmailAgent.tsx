// ── The email audience, نورة, and her missions ───────────────────
// Three tabs of the email section, kept apart from the rest of the page:
//
//   Audience  — every contact filterable by sector, city, what they have
//               done and whether they have a WhatsApp number, with the count
//               beside each choice; tick some or take the whole filter, and
//               make a list, set a sector, enrol, stop — or save the filter
//               as a segment, or hand it to نورة to write for.
//   نورة      — what she knows (taught in the owner's words, per sector),
//               what she has learned, and the writer: pick a target and a
//               goal, she writes two subjects, the body and a follow-up for
//               each audience the campaign leaves behind.
//   Missions  — her working a target: the draft waiting for approval, the
//               stage it is in, the live numbers by subject, city and sector,
//               and what she did and learned, as it happens.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2, Sparkles, Trash2, Play, Pause, Send, CheckCircle2, Filter, Tags, ListPlus, Save, BookOpen, Upload,
  Target, RotateCcw, ChevronDown, ChevronUp, Eye, Users, Brain, Rocket, AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { FolderSidebar, MoveToFolder, inFolder, type FolderSel } from "@/components/Folders";
import { EmailEditor } from "@/components/EmailEditor";
import { EmailFlow } from "@/components/EmailFlow";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const chip = (on: boolean) => cn("px-2.5 py-1 rounded-full border text-[11px] transition-colors", on ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground");
const ago = (d?: string | Date | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `${m}د`; const h = Math.round(m / 60); return h < 24 ? `${h}س` : `${Math.round(h / 24)}ي`;
};

export type Filter = { sectors?: string[]; cities?: string[]; engagement?: string[]; statuses?: string[]; listIds?: number[]; folderIds?: number[]; q?: string; hasPhone?: boolean };
const toggle = (arr: string[] | undefined, v: string) => { const s = new Set(arr ?? []); s.has(v) ? s.delete(v) : s.add(v); return [...s]; };
const describe = (f: Filter) => [f.sectors?.join(" و"), f.cities?.length ? `في ${f.cities.join("، ")}` : "", f.hasPhone ? "لهم واتساب" : ""].filter(Boolean).join(" · ") || "كل جهات الاتصال";

// ── The audience picker, shared by the three tabs ────────────────
export function AudiencePicker({ value, onChange, compact }: { value: Filter; onChange: (f: Filter) => void; compact?: boolean }) {
  const { data: fc, isFetching } = useQuery<any>({
    queryKey: ["email-facets", value],
    queryFn: () => api("/api/email/facets", { method: "POST", body: JSON.stringify({ filter: value }) }),
    placeholderData: (prev: any) => prev,
  });
  const [moreCities, setMoreCities] = useState(false);
  if (!fc) return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />;
  const cities = moreCities ? fc.cities : fc.cities.slice(0, 8);
  return (
    <div className={cn("space-y-3", compact && "space-y-2")}>
      <div>
        <p className="text-[11px] font-semibold mb-1.5 flex items-center gap-1.5"><Tags className="w-3 h-3" /> القطاع</p>
        <div className="flex flex-wrap gap-1.5">
          {fc.sectors.map((s: any) => <button key={s.key} onClick={() => onChange({ ...value, sectors: toggle(value.sectors, s.key) })} className={chip(!!value.sectors?.includes(s.key))}>{s.key} <span className="opacity-60">{s.n}</span></button>)}
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold mb-1.5">المدينة</p>
        <div className="flex flex-wrap gap-1.5">
          {cities.map((s: any) => <button key={s.key} onClick={() => onChange({ ...value, cities: toggle(value.cities, s.key) })} className={chip(!!value.cities?.includes(s.key))}>{s.key} <span className="opacity-60">{s.n}</span></button>)}
          {fc.cities.length > 8 && <button onClick={() => setMoreCities(!moreCities)} className="text-[11px] text-muted-foreground">{moreCities ? "أقل" : `+${fc.cities.length - 8}`}</button>}
        </div>
      </div>
      <div>
        <p className="text-[11px] font-semibold mb-1.5">ما فعلوه</p>
        <div className="flex flex-wrap gap-1.5">
          {fc.engagement.map((s: any) => <button key={s.key} onClick={() => onChange({ ...value, engagement: toggle(value.engagement, s.key) })} className={chip(!!value.engagement?.includes(s.key))}>{s.label} <span className="opacity-60">{s.n}</span></button>)}
          <button onClick={() => onChange({ ...value, hasPhone: !value.hasPhone })} className={chip(!!value.hasPhone)}>لهم رقم واتساب <span className="opacity-60">{fc.withPhone}</span></button>
        </div>
      </div>
      <p className="text-xs"><span className="font-bold text-primary text-base">{fc.total.toLocaleString("ar-SA")}</span> <span className="text-muted-foreground">شركة — {describe(value)}</span>{isFetching && <Loader2 className="w-3 h-3 animate-spin inline mr-2" />}</p>
    </div>
  );
}

// ── Audience ──────────────────────────────────────────────────────
export function AudienceTab({ onWrite }: { onWrite: (f: Filter) => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<Filter>({});
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [all, setAll] = useState(false);            // the whole filter, not only the ticked ones
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const [folder, setFolder] = useState<FolderSel>("all");
  const filter = { ...f, q: q || undefined };
  useEffect(() => { setSel(new Set()); setAll(false); setPage(0); }, [JSON.stringify(filter)]);
  const { data, isLoading } = useQuery<any>({
    queryKey: ["email-audience", filter, page],
    queryFn: () => api("/api/email/contacts/search", { method: "POST", body: JSON.stringify({ filter, limit: 100, offset: page * 100 }) }),
  });
  const { data: lists = [] } = useQuery<any[]>({ queryKey: ["email-lists"], queryFn: () => api("/api/email/lists") });
  const { data: seqs = [] } = useQuery<any[]>({ queryKey: ["email-seqs"], queryFn: () => api("/api/email/sequences") });
  const { data: segs = [] } = useQuery<any[]>({ queryKey: ["email-segments"], queryFn: () => api("/api/email/segments") });
  const { data: sectorList } = useQuery<any>({ queryKey: ["email-sectors"], queryFn: () => api("/api/email/sectors") });
  const inv = () => { for (const k of ["email-audience", "email-facets", "email-lists", "email-segments", "email-seqs", "folders"]) qc.invalidateQueries({ queryKey: [k] }); };

  const target = () => (all ? { filter } : { ids: [...sel] });
  const bulk = useMutation({
    mutationFn: (b: any) => api("/api/email/contacts/bulk", { method: "POST", body: JSON.stringify({ ...target(), ...b }) }),
    onSuccess: (d: any) => {
      inv(); setSel(new Set()); setAll(false);
      if (d.deleted !== undefined) toast.success(`حُذف ${d.deleted.toLocaleString("ar-SA")}${d.keptUnsubscribed ? ` — وبقي ${d.keptUnsubscribed} ممن ألغوا الاشتراك (خارج القوائم) حتى لا يُراسَلوا ثانية` : ""}`);
      else toast.success(d.enrolled !== undefined ? `سُجّل ${d.enrolled} في المتابعة` : `تم — ${d.done ?? ""}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  // Deleting many: the count typed back, so a slip of the mouse cannot empty the account.
  const wipe = (count: number, body: any, what: string) => {
    if (!count) return;
    const typed = prompt(`سيُحذف ${count.toLocaleString("ar-SA")} ${what} نهائياً مع متابعاتهم المجدولة.\nللتأكيد اكتب العدد: ${count}`);
    if (typed?.trim() === String(count) || typed?.trim() === count.toLocaleString("ar-SA")) bulk.mutate({ action: "delete", ...body });
    else if (typed !== null) toast.error("العدد غير مطابق — لم يُحذف شيء");
  };
  const delList = useMutation({
    mutationFn: ({ id, contacts }: { id: number; contacts: boolean }) => api(`/api/email/lists/${id}${contacts ? "?contacts=1" : ""}`, { method: "DELETE" }),
    onSuccess: (d: any) => { inv(); setF((x) => ({ ...x, listIds: undefined })); toast.success(d.deleted ? `حُذفت القائمة و${d.deleted.toLocaleString("ar-SA")} جهة اتصال` : "حُذفت القائمة"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const askDelList = (l: any) => {
    const a = prompt(`حذف قائمة «${l.name}» (${l.count}):\n1 — القائمة فقط (العناوين تبقى في الجمهور)\n2 — القائمة وعناوينها (غير الموجودة في قوائم أخرى)\nاكتب 1 أو 2`);
    if (a?.trim() === "1" || a?.trim() === "١") delList.mutate({ id: l.id, contacts: false });
    else if (a?.trim() === "2" || a?.trim() === "٢") delList.mutate({ id: l.id, contacts: true });
  };
  const filtered = !!(f.sectors?.length || f.cities?.length || f.engagement?.length || f.hasPhone || f.listIds?.length || q);
  const classify = useMutation({
    mutationFn: () => api("/api/email/contacts/classify", { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (d: any) => { inv(); toast.success(`صُنّف ${d.updated} من ${d.checked}: ${Object.entries(d.bySector).map(([k, v]) => `${k} ${v}`).join("، ") || "لا جديد"}`); },
  });
  const saveSeg = useMutation({
    mutationFn: (name: string) => api("/api/email/segments", { method: "POST", body: JSON.stringify({ name, filter }) }),
    onSuccess: () => { inv(); toast.success("حُفظ الجمهور"); },
  });
  const delSeg = useMutation({ mutationFn: (id: number) => api(`/api/email/segments/${id}`, { method: "DELETE" }), onSuccess: inv });

  const rows: any[] = data?.rows ?? [];
  const n = all ? data?.total ?? 0 : sel.size;
  const pages = Math.ceil((data?.total ?? 0) / 100);

  return (
    <div className="grid lg:grid-cols-[19rem_1fr] gap-4">
      {openId && <ContactDrawer id={openId} onClose={() => setOpenId(null)} />}
      <div className="space-y-3">
        <div className={cn(card, "p-3.5")}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold flex items-center gap-1.5"><Filter className="w-3.5 h-3.5" /> الجمهور</p>
            {(f.sectors?.length || f.cities?.length || f.engagement?.length || f.hasPhone) ? <button onClick={() => setF({})} className="text-[11px] text-muted-foreground">مسح</button> : null}
          </div>
          <AudiencePicker value={f} onChange={setF} />
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-card-border">
            <button onClick={() => onWrite(filter)} className={primary}><Sparkles className="w-3 h-3" /> نورة تكتب لهم</button>
            <button onClick={() => { const name = prompt("اسم الجمهور", describe(filter)); if (name) saveSeg.mutate(name); }} className={ghost}><Save className="w-3 h-3" /> احفظ الجمهور</button>
          </div>
        </div>
        {lists.length > 0 && (
          <div className={cn(card, "p-3 space-y-2")}>
            <p className="text-xs font-semibold">القوائم والمجلدات</p>
            <FolderSidebar kind="email" value={folder} onChange={setFolder} total={lists.length} onChanged={inv} compact lists={lists} />
            <div className="border-t border-card-border pt-2 space-y-0.5 max-h-72 overflow-y-auto">
              {inFolder(lists, folder).map((l) => {
                const on = !!f.listIds?.includes(l.id);
                return (
                  <div key={l.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/list-id", String(l.id))}
                    className={cn("group flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs cursor-grab", on ? "bg-primary/15 text-primary" : "hover:bg-muted/50")}>
                    <button onClick={() => setF({ ...f, listIds: on ? f.listIds!.filter((x) => x !== l.id) : [...(f.listIds ?? []), l.id] })} className="flex-1 text-right truncate">{l.name} <span className="text-muted-foreground">({l.count})</span></button>
                    <span className="hidden group-hover:flex items-center gap-1"><MoveToFolder kind="email" listId={l.id} folderId={l.folderId} onMoved={inv} />
                      <button title="حذف القائمة" onClick={() => askDelList(l)}><Trash2 className="w-3 h-3 text-red-400" /></button></span>
                  </div>
                );
              })}
              {inFolder(lists, folder).length === 0 && <p className="text-[11px] text-muted-foreground px-2 py-2">لا قوائم هنا — اسحب قائمة إلى المجلد.</p>}
            </div>
            <p className="text-[10px] text-muted-foreground/70">اضغط قائمة لتصفية الجمهور بها. البريد نفسه محفوظ مرة واحدة مهما تكرر في القوائم.</p>
          </div>
        )}
        {segs.length > 0 && (
          <div className={cn(card, "p-3.5 space-y-1")}>
            <p className="text-xs font-semibold mb-1.5">جماهير محفوظة</p>
            {segs.map((sg) => (
              <div key={sg.id} className="group flex items-center gap-1.5 text-xs">
                <button onClick={() => setF(sg.filter)} className="flex-1 text-right truncate hover:text-primary">{sg.name} <span className="text-muted-foreground">({sg.sendable})</span></button>
                <button onClick={() => delSeg.mutate(sg.id)} className="opacity-0 group-hover:opacity-100"><Trash2 className="w-3 h-3 text-red-400" /></button>
              </div>
            ))}
          </div>
        )}
        <button onClick={() => classify.mutate()} disabled={classify.isPending} className={cn(ghost, "w-full justify-center")}>
          {classify.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Tags className="w-3 h-3" />} صنّف القطاعات تلقائياً (من اسم الشركة)
        </button>
      </div>

      <div className={cn(card)}>
        <div className="p-3 border-b border-card-border flex gap-2 flex-wrap items-center">
          <input className={cn(input, "flex-1 min-w-[10rem]")} placeholder="بحث بالبريد أو الشركة" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="text-xs text-muted-foreground">{(data?.total ?? 0).toLocaleString("ar-SA")}</span>
          {(data?.total ?? 0) > 0 && (
            <button onClick={() => wipe(data.total, { filter }, filtered ? "جهة اتصال (كل من في هذا الفلتر)" : "جهة اتصال — كل بيانات البريد")}
              disabled={bulk.isPending} title={filtered ? "حذف كل من يطابق الفلتر الحالي" : "مسح كل جهات اتصال البريد"}
              className={cn(ghost, "text-red-400 border-red-500/30")}>
              {bulk.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} {filtered ? "حذف نتيجة الفلتر" : "مسح كل البيانات"}
            </button>
          )}
        </div>
        {(sel.size > 0 || all) && (
          <div className="p-2.5 border-b border-card-border bg-primary/5 flex flex-wrap gap-1.5 items-center text-xs">
            <span className="font-semibold">{n.toLocaleString("ar-SA")} محدد</span>
            {!all && data?.total > sel.size && <button onClick={() => setAll(true)} className="underline text-primary">حدد كل الـ{data.total.toLocaleString("ar-SA")} في هذا الفلتر</button>}
            <span className="mx-1 text-muted-foreground">|</span>
            <button onClick={() => { const name = prompt("اسم القائمة الجديدة", describe(filter)); if (name) bulk.mutate({ action: "newList", name }); }} className={ghost}><ListPlus className="w-3 h-3" /> قائمة جديدة</button>
            <select className={cn(input, "w-40 text-xs py-1.5")} value="" onChange={(e) => e.target.value && bulk.mutate({ action: "addToList", listId: Number(e.target.value) })}><option value="">أضف إلى قائمة…</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
            <select className={cn(input, "w-36 text-xs py-1.5")} value="" onChange={(e) => e.target.value && bulk.mutate({ action: "setSector", sector: e.target.value === "__none" ? "" : e.target.value })}><option value="">غيّر القطاع…</option>{(sectorList?.sectors ?? []).map((s: string) => <option key={s} value={s}>{s}</option>)}<option value="__none">غير مصنف</option></select>
            <select className={cn(input, "w-40 text-xs py-1.5")} value="" onChange={(e) => e.target.value && bulk.mutate({ action: "enrol", sequenceId: Number(e.target.value) })}><option value="">سجّل في متابعة…</option>{seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
            <button onClick={() => bulk.mutate({ action: "unsubscribe" })} className={ghost}>أوقف</button>
            <button onClick={() => n > 50 ? wipe(n, target(), "جهة اتصال") : confirm(`حذف ${n} جهة اتصال؟`) && bulk.mutate({ action: "delete" })} className={cn(ghost, "text-red-400")}><Trash2 className="w-3 h-3" /> حذف</button>
          </div>
        )}
        <div className="overflow-x-auto max-h-[38rem] overflow-y-auto">
          {isLoading ? <div className="p-6 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div> :
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card"><tr className="text-muted-foreground">
              <th className="p-2 w-8"><input type="checkbox" checked={rows.length > 0 && rows.every((r) => sel.has(r.id))} onChange={(e) => { const s = new Set(sel); rows.forEach((r) => e.target.checked ? s.add(r.id) : s.delete(r.id)); setSel(s); setAll(false); }} /></th>
              <th className="text-right p-2">الشركة</th><th className="text-right p-2">البريد</th><th className="text-right p-2">القطاع</th><th className="text-right p-2">المدينة</th><th className="text-right p-2">واتساب</th><th className="text-right p-2">آخر إرسال</th><th className="text-right p-2">فتح</th><th className="text-right p-2">ردّ</th>
            </tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className={cn("border-t border-card-border", sel.has(c.id) && "bg-primary/5", c.status !== "active" && "opacity-50")}>
                <td className="p-2"><input type="checkbox" checked={all || sel.has(c.id)} onChange={() => { const s = new Set(sel); s.has(c.id) ? s.delete(c.id) : s.add(c.id); setSel(s); setAll(false); }} /></td>
                <td className="p-2 cursor-pointer hover:text-primary" onClick={() => setOpenId(c.id)}>{c.company ?? c.name ?? "—"}</td>
                <td className="p-2 font-mono" dir="ltr">{c.email}</td>
                <td className="p-2">{c.sector ? <span className="px-1.5 py-0.5 rounded bg-muted">{c.sector}</span> : <span className="text-muted-foreground">—</span>}</td>
                <td className="p-2 text-muted-foreground">{c.city ?? ""}</td>
                <td className="p-2 font-mono text-muted-foreground" dir="ltr">{c.phone ? `+${c.phone}` : ""}</td>
                <td className="p-2 text-muted-foreground">{ago(c.lastSentAt)}</td><td className="p-2 text-muted-foreground">{ago(c.lastOpenedAt)}</td><td className="p-2 text-muted-foreground">{ago(c.lastRepliedAt)}</td>
              </tr>))}</tbody>
          </table>}
        </div>
        {pages > 1 && <div className="p-2 flex justify-center gap-2 text-xs border-t border-card-border">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className={ghost}>السابق</button><span className="self-center">{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className={ghost}>التالي</button>
        </div>}
      </div>
    </div>
  );
}

// ── The draft, editable ───────────────────────────────────────────
function DraftEditor({ draft, onChange }: { draft: any; onChange: (d: any) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const showPreview = async (subject: string, html: string) => {
    try { const p = await api("/api/email/preview", { method: "POST", body: JSON.stringify({ subject, html }) }); setPreview(p.html); } catch (e: any) { toast.error(e.message); }
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <p className="text-xs font-semibold">العناوين — {draft.subjects.length > 1 ? "يُختبر الاثنان على شريحة، والفائز يذهب للباقي" : "عنوان واحد"}</p>
        {draft.subjects.map((s: string, i: number) => (
          <div key={i} className="flex items-center gap-2"><span className="text-[11px] w-5 text-muted-foreground">{"AB"[i] ?? i + 1}</span>
            <input className={input} value={s} onChange={(e) => { const st = [...draft.subjects]; st[i] = e.target.value; onChange({ ...draft, subjects: st }); }} /></div>
        ))}
      </div>
      <div>
        <div className="flex items-center justify-between mb-1.5"><p className="text-xs font-semibold">الرسالة</p><button onClick={() => showPreview(draft.subjects[0], draft.html)} className="text-[11px] text-primary flex items-center gap-1"><Eye className="w-3 h-3" /> معاينة</button></div>
        <EmailEditor value={draft.html} subject={draft.subjects[0]} onChange={(html) => onChange({ ...draft, html })} minHeight={260} />
      </div>
      {draft.followups?.map((fu: any, i: number) => (
        <div key={i} className="rounded-lg border border-card-border p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-xs"><span className="font-semibold">{({ warm: "يوم ٣ — لمن فتح ولم يرد", cold: "يوم ٣ — لمن لم يفتح (نفس العرض بعنوان جديد)", value: "يوم ٧ — معلومة مفيدة لمن لم يرد", breakup: "يوم ١٤ — الرسالة الأخيرة" } as Record<string, string>)[fu.audience] ?? fu.audience}</span>
            <button onClick={() => showPreview(fu.subject, fu.html)} className="text-[11px] text-primary mr-auto flex items-center gap-1"><Eye className="w-3 h-3" /> معاينة</button></div>
          <input className={input} value={fu.subject} onChange={(e) => { const f = [...draft.followups]; f[i] = { ...fu, subject: e.target.value }; onChange({ ...draft, followups: f }); }} />
          <EmailEditor value={fu.html} subject={fu.subject} compact minHeight={180} onChange={(html) => { const f = [...draft.followups]; f[i] = { ...fu, html }; onChange({ ...draft, followups: f }); }} />
        </div>
      ))}
      {draft.why && <p className="text-[11px] text-muted-foreground"><Brain className="w-3 h-3 inline ml-1" />لماذا: {draft.why}</p>}
      {preview && <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setPreview(null)}>
        <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-hidden" onClick={(e) => e.stopPropagation()}><iframe title="p" srcDoc={preview} className="w-full h-[80vh]" /></div></div>}
    </div>
  );
}

const GOALS = [
  "تعريف بخدمة الامتثال لمكافحة غسل الأموال (AML): التسجيل، مسؤول الامتثال، تقييم المخاطر — وطلب مكالمة قصيرة",
  "عرض خدمة مسؤول الامتثال بالإنابة لمن لا يملك مسؤولاً",
  "تذكير بالتزامات ضريبة الشركات والإقرار — وطلب مراجعة الوضع",
  "مسك الدفاتر الشهري لمن لا يملك محاسباً",
];

// ── نورة ──────────────────────────────────────────────────────────
export function AgentTab({ initialFilter, onMissionCreated }: { initialFilter?: Filter | null; onMissionCreated: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["email-agent"], queryFn: () => api("/api/email/agent") });
  const inv = () => qc.invalidateQueries({ queryKey: ["email-agent"] });
  const [teachText, setTeachText] = useState("");
  const [teachTopic, setTeachTopic] = useState("");
  const [lastTaught, setLastTaught] = useState<any[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [editPersona, setEditPersona] = useState<string | null>(null);
  const [memTopic, setMemTopic] = useState<string>("");
  const [target, setTarget] = useState<Filter>(initialFilter ?? {});
  useEffect(() => { if (initialFilter) setTarget(initialFilter); }, [initialFilter]);
  const [goal, setGoal] = useState(GOALS[0]!);
  const [lang, setLang] = useState("en");
  const [tone, setTone] = useState("");
  const [notes, setNotes] = useState("");
  const [draft, setDraft] = useState<any>(null);
  const [aud, setAud] = useState<any>(null);

  const teachM = useMutation({
    mutationFn: async (file?: File) => {
      const fd = new FormData(); fd.append("text", teachText); if (teachTopic) fd.append("topic", teachTopic); if (file) fd.append("file", file);
      const r = await fetch("/api/email/agent/teach", { method: "POST", body: fd, credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
    },
    onSuccess: (d: any) => { setLastTaught(d.saved); setTeachText(""); inv(); toast.success(`حفظت ${d.saved.length} معلومة`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const delMem = useMutation({ mutationFn: (id: number) => api(`/api/email/agent/memory/${id}`, { method: "DELETE" }), onSuccess: inv });
  const savePersona = useMutation({ mutationFn: (persona: string) => api("/api/email/agent", { method: "PATCH", body: JSON.stringify({ persona }) }), onSuccess: () => { setEditPersona(null); inv(); } });
  const write = useMutation({
    mutationFn: () => api("/api/email/agent/write", { method: "POST", body: JSON.stringify({ filter: target, goal, language: lang, tone, notes }) }),
    onSuccess: (d: any) => { setDraft(d.draft); setAud(d.audience); },
    onError: (e: Error) => toast.error(e.message),
  });
  const launch = useMutation({
    mutationFn: () => api("/api/email/agent/launch", { method: "POST", body: JSON.stringify({ draft, filter: target, goal, language: lang, tone, name: `${describe(target)} — ${draft.subjects[0]}`.slice(0, 150) }) }),
    onSuccess: () => { toast.success("بدأت المهمة — تتابعها في «المهام»"); setDraft(null); onMissionCreated(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!data) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  const a = data.agent;
  const mem: any[] = data.memory ?? [];
  const KIND: Record<string, { l: string; c: string }> = { knowledge: { l: "معرفة", c: "bg-blue-500/15 text-blue-400" }, instruction: { l: "تعليمة", c: "bg-primary/15 text-primary" }, win: { l: "نجح", c: "bg-green-500/15 text-green-400" }, loss: { l: "لم ينجح", c: "bg-red-500/15 text-red-400" }, gap: { l: "لا تعرف", c: "bg-muted" } };
  const shown = mem.filter((m) => !memTopic || (memTopic === "__general" ? !m.topic : m.topic === memTopic));

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-4 flex gap-4 items-start")}>
        <span className="text-4xl leading-none">{a.avatar ?? "📧"}</span>
        <div className="flex-1 min-w-0">
          <p className="font-bold">{a.name} <span className="text-xs text-muted-foreground font-normal">— {a.title}</span></p>
          {editPersona === null
            ? <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{a.persona} <button onClick={() => setEditPersona(a.persona ?? "")} className="text-primary">تعديل</button></p>
            : <div className="mt-2 space-y-2"><textarea className={cn(input, "min-h-[5rem] text-xs")} value={editPersona} onChange={(e) => setEditPersona(e.target.value)} /><div className="flex gap-2"><button onClick={() => savePersona.mutate(editPersona)} className={primary}>احفظ</button><button onClick={() => setEditPersona(null)} className={ghost}>إلغاء</button></div></div>}
          <p className="text-[11px] text-muted-foreground mt-2">{mem.filter((m) => m.kind === "knowledge").length} معلومة · {mem.filter((m) => m.kind === "instruction").length} تعليمة · {mem.filter((m) => m.kind === "win").length} نجاح · {mem.filter((m) => m.kind === "loss").length} فشل — تردّ أيضاً على ردود البريد بما تعرفه عن قطاع الشركة.</p>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Teach */}
        <div className={cn(card, "p-4 space-y-3")}>
          <p className="text-sm font-semibold flex items-center gap-1.5"><BookOpen className="w-4 h-4" /> علّميها <a href="/email/knowledge" className="mr-auto text-[11px] font-normal text-primary hover:underline">مكتبة المعرفة: PDF وWord وأكثر ←</a></p>
          <p className="text-[11px] text-muted-foreground">اكتب بكلامك أو الصق نصاً أو ارفع ملفاً (نص، CSV، Excel): عن خدماتنا، عن قطاع، عن التزاماتهم، عن أسلوبنا. تقسّمه هي إلى معلومات وتحفظ كل واحدة مع قطاعها.</p>
          <textarea className={cn(input, "min-h-[8rem] text-xs leading-relaxed")} value={teachText} onChange={(e) => setTeachText(e.target.value)} placeholder="مثال: الوسطاء العقاريون في الإمارات من الجهات المعنية بمكافحة غسل الأموال. نحن في بروكاونت نسجّلهم في goAML، نكتب تقييم المخاطر، ونقدّم مسؤول الامتثال بالإنابة…" />
          <div className="flex gap-2 flex-wrap items-center">
            <select className={cn(input, "w-44 text-xs")} value={teachTopic} onChange={(e) => setTeachTopic(e.target.value)}><option value="">القطاع: تحدّده هي</option>{(data.sectors ?? []).map((s: string) => <option key={s} value={s}>{s}</option>)}</select>
            <button onClick={() => teachM.mutate(undefined)} disabled={teachM.isPending || !teachText.trim()} className={primary}>{teachM.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />} احفظي هذا</button>
            <input ref={fileRef} type="file" className="hidden" accept=".txt,.md,.csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) teachM.mutate(f); e.target.value = ""; }} />
            <button onClick={() => fileRef.current?.click()} disabled={teachM.isPending} className={ghost}><Upload className="w-3 h-3" /> من ملف</button>
          </div>
          {lastTaught && <div className="rounded-lg bg-muted/40 p-2.5 text-[11px] space-y-1"><p className="font-semibold">حفظت:</p>{lastTaught.map((t, i) => <p key={i}>• {t.topic ? <span className="text-primary">[{t.topic}] </span> : ""}{t.content}</p>)}</div>}
        </div>

        {/* Memory */}
        <div className={cn(card, "p-4 space-y-2")}>
          <div className="flex items-center gap-2"><p className="text-sm font-semibold">ذاكرتها</p>
            <select className={cn(input, "w-40 text-xs mr-auto py-1")} value={memTopic} onChange={(e) => setMemTopic(e.target.value)}><option value="">كل المواضيع</option><option value="__general">عام</option>{(data.topics ?? []).map((t: string) => <option key={t} value={t}>{t}</option>)}</select></div>
          <div className="max-h-[22rem] overflow-y-auto divide-y divide-card-border">
            {shown.length === 0 && <p className="text-xs text-muted-foreground py-6 text-center">لا شيء بعد — علّميها من اليسار.</p>}
            {shown.map((m) => (
              <div key={m.id} className="group py-2 flex gap-2 items-start text-[11px]">
                <span className={cn("px-1.5 rounded shrink-0", KIND[m.kind]?.c)}>{KIND[m.kind]?.l ?? m.kind}</span>
                {m.topic && <span className="px-1.5 rounded bg-muted shrink-0">{m.topic}</span>}
                <span className="flex-1 leading-relaxed">{m.content}{m.times > 1 ? <span className="text-muted-foreground"> ×{m.times}</span> : null}</span>
                <button onClick={() => delMem.mutate(m.id)} className="opacity-0 group-hover:opacity-100"><Trash2 className="w-3 h-3 text-red-400" /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Write */}
      <div className={cn(card, "p-4 space-y-4")}>
        <p className="text-sm font-semibold flex items-center gap-1.5"><Sparkles className="w-4 h-4 text-primary" /> نورة تكتب حملة</p>
        <div className="grid lg:grid-cols-[1fr_1fr] gap-4">
          <div className="rounded-lg border border-card-border p-3"><p className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> الهدف: لمن</p><AudiencePicker value={target} onChange={setTarget} compact /></div>
          <div className="space-y-2.5">
            <div><label className="text-xs font-semibold block mb-1.5">ماذا تريد من الحملة</label>
              <select className={cn(input, "text-xs mb-1.5")} value={GOALS.includes(goal) ? goal : ""} onChange={(e) => e.target.value && setGoal(e.target.value)}><option value="">— هدف مكتوب بيدك —</option>{GOALS.map((g) => <option key={g} value={g}>{g.slice(0, 80)}</option>)}</select>
              <textarea className={cn(input, "min-h-[4.5rem] text-xs")} value={goal} onChange={(e) => setGoal(e.target.value)} /></div>
            <div className="grid grid-cols-2 gap-2">
<select className={cn(input, "text-xs")} value={lang} onChange={(e) => setLang(e.target.value)} title="لغة الإيميل"><option value="en">🇬🇧 الإنجليزية (افتراضي)</option><option value="ar">العربية — بطلبك</option><option value="both">الاثنتان</option></select>
              <input className={cn(input, "text-xs")} value={tone} onChange={(e) => setTone(e.target.value)} placeholder="النبرة (اختياري): رسمية، ودّية…" />
            </div>
            <textarea className={cn(input, "min-h-[3rem] text-xs")} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="ملاحظات لها (اختياري): اذكري العرض الحالي، لا تذكري السعر…" />
            <button onClick={() => write.mutate()} disabled={write.isPending || !goal.trim()} className={primary}>{write.isPending ? <><Loader2 className="w-3 h-3 animate-spin" /> تكتب…</> : <><Sparkles className="w-3 h-3" /> اكتبي الحملة</>}</button>
          </div>
        </div>
        {draft && (
          <div className="border-t border-card-border pt-4 space-y-3">
            {aud && <p className="text-xs"><Users className="w-3.5 h-3.5 inline ml-1" />ستذهب إلى <b className="text-primary">{aud.count}</b> شركة — {aud.description}{aud.sample?.length ? <span className="text-muted-foreground"> (منهم: {aud.sample.slice(0, 4).join("؛ ")})</span> : null}</p>}
            <DraftEditor draft={draft} onChange={setDraft} />
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => launch.mutate()} disabled={launch.isPending || !aud?.count} className={primary}>{launch.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />} وافقت — ابدئي المهمة</button>
              <button onClick={() => write.mutate()} disabled={write.isPending} className={ghost}><RotateCcw className="w-3 h-3" /> اكتبي غيرها</button>
              <button onClick={() => setDraft(null)} className={ghost}>إلغاء</button>
            </div>
            <p className="text-[11px] text-muted-foreground">عند الموافقة: يُختبر العنوانان على شريحة ويذهب الفائز للباقي، وبعد ٤٨ ساعة يأخذ من فتح ولم يرد متابعته، ومن لم يفتح متابعة مختلفة. كل ذلك بحصص الإرسال وساعات العمل، وتتوقف المتابعة فور أي رد.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Missions ──────────────────────────────────────────────────────
const STAGES = [
  { k: "draft", l: "تكتب" }, { k: "awaiting_approval", l: "تنتظر موافقتك" }, { k: "sending", l: "ترسل وتختبر" },
  { k: "following_up", l: "تتابع" }, { k: "done", l: "انتهت" },
];

function Report({ r }: { r: any }) {
  if (!r?.total) return null;
  const T = ({ rows, k }: { rows: any[]; k: string }) => (
    <table className="w-full text-[11px]"><tbody>{rows.map((x, i) => (
      <tr key={i} className="border-t border-card-border"><td className="py-1">{x[k] ?? "—"}</td><td className="py-1 text-muted-foreground">{x.sent}</td><td className="py-1 text-blue-400">{x.openRate}%</td><td className="py-1 text-green-400">{x.replyRate}% ({x.replied})</td></tr>
    ))}</tbody></table>
  );
  return (
    <div className="grid md:grid-cols-2 gap-3 mt-3">
      <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] font-semibold mb-1">حسب المرحلة <span className="text-muted-foreground font-normal">(أُرسل · فتح · رد)</span></p><T rows={(r.byStage ?? []).map((x: any) => ({ ...x, stage: ({ first: "الأولى", warm: "يوم ٣ — فتح ولم يرد", cold: "يوم ٣ — لم يفتح", value: "يوم ٧ — معلومة", breakup: "يوم ١٤ — الأخيرة" } as Record<string, string>)[x.stage] ?? x.stage }))} k="stage" /></div>
      {r.subjects?.length > 0 && <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] font-semibold mb-1">اختبار العنوان {r.winner ? `— فاز ${r.winner}` : ""}</p><T rows={r.subjects.map((s: any) => ({ ...s, label: `${s.variant}: ${s.subject}` }))} k="label" /></div>}
      <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] font-semibold mb-1">حسب المدينة — أيّ جمهور استجاب</p><T rows={r.byCity ?? []} k="city" /></div>
      <div className="rounded-lg border border-card-border p-2.5"><p className="text-[11px] font-semibold mb-1">حسب القطاع</p><T rows={r.bySector ?? []} k="sector" /></div>
      {r.lessons?.length > 0 && <div className="md:col-span-2 rounded-lg bg-primary/5 border border-primary/20 p-2.5 text-[11px]"><p className="font-semibold mb-1">ما تعلمته (في ذاكرتها الآن)</p>{r.lessons.map((l: string, i: number) => <p key={i}>• {l}</p>)}</div>}
    </div>
  );
}

export function MissionsTab() {
  const qc = useQueryClient();
  const { data: missions = [] } = useQuery<any[]>({ queryKey: ["email-missions"], queryFn: () => api("/api/email/missions"), refetchInterval: 15_000 });
  const inv = () => qc.invalidateQueries({ queryKey: ["email-missions"] });
  const [creating, setCreating] = useState(false);
  const [nf, setNf] = useState<{ filter: Filter; goal: string; name: string; language: string; requireApproval: boolean; followAfterHours: number }>({ filter: {}, goal: GOALS[0]!, name: "", language: "en", requireApproval: true, followAfterHours: 72 });
  const [open, setOpen] = useState<number | null>(null);
  const [edits, setEdits] = useState<Record<number, any>>({});
  const create = useMutation({ mutationFn: () => api("/api/email/missions", { method: "POST", body: JSON.stringify(nf) }), onSuccess: (m: any) => { setCreating(false); setOpen(m.id); inv(); toast.success("بدأت نورة الكتابة — المسودة تظهر هنا خلال دقيقة"); }, onError: (e: Error) => toast.error(e.message) });
  const act = useMutation({ mutationFn: ({ id, a, body }: { id: number; a: string; body?: any }) => api(`/api/email/missions/${id}/${a}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }), onSuccess: inv, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/email/missions/${id}`, { method: "DELETE" }), onSuccess: inv });
  const { data: ovTrack } = useQuery<any>({ queryKey: ["email-overview"], queryFn: () => api("/api/email/overview") });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-sm text-muted-foreground">مهمة = نورة تعمل على جمهور لهدف: تكتب، تنتظر موافقتك، ترسل وتختبر العناوين، تتابع من فتح ومن لم يفتح بزاويتين، ثم تكتب ما تعلمته.</p>
        <button onClick={() => setCreating(!creating)} className={primary}><Rocket className="w-3.5 h-3.5" /> مهمة جديدة</button>
      </div>
      {creating && (
        <div className={cn(card, "p-4 grid lg:grid-cols-2 gap-4")}>
          <div className="rounded-lg border border-card-border p-3"><p className="text-xs font-semibold mb-2">الجمهور</p><AudiencePicker value={nf.filter} onChange={(filter) => setNf({ ...nf, filter })} compact /></div>
          <div className="space-y-2.5">
            <input className={input} value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} placeholder="اسم المهمة (اختياري)" />
            <select className={cn(input, "text-xs")} value={GOALS.includes(nf.goal) ? nf.goal : ""} onChange={(e) => e.target.value && setNf({ ...nf, goal: e.target.value })}><option value="">— هدف مكتوب بيدك —</option>{GOALS.map((g) => <option key={g} value={g}>{g.slice(0, 80)}</option>)}</select>
            <textarea className={cn(input, "min-h-[5rem] text-xs")} value={nf.goal} onChange={(e) => setNf({ ...nf, goal: e.target.value })} />
            <div className="grid grid-cols-2 gap-2">
<select className={cn(input, "text-xs")} value={nf.language} onChange={(e) => setNf({ ...nf, language: e.target.value })} title="لغة الإيميل"><option value="en">🇬🇧 الإنجليزية (افتراضي)</option><option value="ar">العربية — بطلبك</option><option value="both">الاثنتان</option></select>
              <label className="text-xs flex items-center gap-2">المتابعة بعد <input type="number" className={cn(input, "w-16 text-xs")} value={nf.followAfterHours} onChange={(e) => setNf({ ...nf, followAfterHours: Number(e.target.value) })} /> ساعة</label>
            </div>
            <label className="text-xs flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={nf.requireApproval} onChange={(e) => setNf({ ...nf, requireApproval: e.target.checked })} /><span>انتظري موافقتي قبل الإرسال <span className="text-muted-foreground">(موصى به — بدونها ترسل ما تكتبه مباشرة)</span></span></label>
            <button onClick={() => create.mutate()} disabled={create.isPending || !nf.goal.trim()} className={primary}>{create.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rocket className="w-3 h-3" />} ابدئي</button>
          </div>
        </div>
      )}

      {missions.length === 0 && !creating && <div className={cn(card, "p-8 text-center text-sm text-muted-foreground")}>لا مهام بعد.</div>}
      {missions.map((m) => {
        const si = STAGES.findIndex((s) => s.k === m.stage);
        const d = edits[m.id] ?? m.pending;
        const live = m.report ?? m.live;
        return (
          <div key={m.id} className={cn(card, "p-4", m.stage === "awaiting_approval" && "border-yellow-500/40")}>
            <div className="flex items-start gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <button onClick={() => setOpen(open === m.id ? null : m.id)} className="font-semibold text-sm hover:text-primary flex items-center gap-1">{m.name}{open === m.id ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</button>
                <p className="text-[11px] text-muted-foreground mt-0.5">{m.audience} — {m.audienceCount} يمكن مراسلتهم · {m.goal.slice(0, 110)}</p>
              </div>
              <div className="flex gap-1.5">
                {m.status === "active" ? <button onClick={() => act.mutate({ id: m.id, a: "pause" })} className={ghost}><Pause className="w-3 h-3" /></button> : <button onClick={() => act.mutate({ id: m.id, a: "resume" })} className={ghost}><Play className="w-3 h-3" /></button>}
                <button onClick={() => act.mutate({ id: m.id, a: "run" })} className={ghost} title="نفّذي الخطوة التالية الآن"><RotateCcw className="w-3 h-3" /></button>
                <button onClick={() => confirm("حذف المهمة؟ (الحملات والرسائل تبقى)") && del.mutate(m.id)} className={ghost}><Trash2 className="w-3 h-3" /></button>
              </div>
            </div>
            <div className="flex gap-1 mt-3">
              {STAGES.map((s, i) => <div key={s.k} className="flex-1"><div className={cn("h-1.5 rounded-full", i < si ? "bg-primary" : i === si ? (m.status === "active" ? "bg-primary animate-pulse" : "bg-yellow-400") : "bg-muted")} /><p className={cn("text-[10px] mt-1", i === si ? "text-foreground" : "text-muted-foreground")}>{s.l}</p></div>)}
            </div>
            {m.status !== "active" && <p className="text-[11px] text-yellow-400 mt-2"><AlertTriangle className="w-3 h-3 inline ml-1" />موقوفة{m.log?.[0]?.kind === "error" ? ` — ${m.log[0].text}` : ""}</p>}
            {live?.byStage?.length > 0 && <div className="mt-3"><EmailFlow compact stages={live.byStage} tracking={!!ovTrack?.trackingBase} steps={m.path?.steps} firstAfterHours={m.followAfterHours} /></div>}
            {live?.total && <p className="text-xs mt-2">أُرسل {live.total.sent} · فتح <b className="text-blue-400">{live.total.openRate}%</b> · نقر {live.total.clicked} · رد <b className="text-green-400">{live.total.replyRate}%</b> ({live.total.replied}) · ارتدّ {live.total.bounced}</p>}

            {m.stage === "awaiting_approval" && d && (
              <div className="mt-3 border-t border-card-border pt-3 space-y-3">
                <p className="text-xs font-semibold text-yellow-400">{m.agentRole === "email_creator" ? "طارق" : m.agentRole === "email_followup" ? "يوسف" : "نورة"} كتب{m.agentRole && m.agentRole !== "email" ? "" : "ت"} وتنتظر موافقتك — عدّل ما تشاء:</p>
                <MissionAudience m={m} onSaved={() => qc.invalidateQueries({ queryKey: ["email-missions"] })} />
                <DraftEditor draft={d} onChange={(nd) => setEdits({ ...edits, [m.id]: nd })} />
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => act.mutate({ id: m.id, a: "approve", body: { draft: d } })} disabled={act.isPending} className={primary}><CheckCircle2 className="w-3 h-3" /> وافقت — أرسلي</button>
                  <button onClick={() => { const g = prompt("ما الذي تريد تغييره في الهدف؟ (اتركه كما هو لإعادة الكتابة فقط)", m.goal); if (g !== null) act.mutate({ id: m.id, a: "redraft", body: { goal: g } }); }} className={ghost}><RotateCcw className="w-3 h-3" /> أعيدي الكتابة</button>
                </div>
              </div>
            )}
            {m.stage === "draft" && m.status === "active" && <p className="text-[11px] text-muted-foreground mt-2"><Loader2 className="w-3 h-3 animate-spin inline ml-1" />تكتب الآن…</p>}

            {open === m.id && (
              <div className="mt-3 border-t border-card-border pt-3">
                <Report r={live} />
                <p className="text-[11px] font-semibold mt-3 mb-1.5">ما فعلته</p>
                <div className="space-y-1 max-h-60 overflow-y-auto">{(m.log ?? []).map((l: any) => (
                  <p key={l.id} className={cn("text-[11px]", l.kind === "error" ? "text-red-400" : "text-muted-foreground")}><span className="text-muted-foreground/60">{ago(l.createdAt)}</span> — {l.text}</p>
                ))}</div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── One company, everything that happened with it ────────────────
export function ContactDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useQuery<any>({ queryKey: ["email-contact", id], queryFn: () => api(`/api/email/contacts/${id}`), refetchInterval: 15_000 });
  const c = data?.contact;
  type Item = { at: string; kind: string; text: string; cls?: string };
  const items: Item[] = [];
  for (const m of data?.messages ?? []) {
    if (m.sentAt) items.push({ at: m.sentAt, kind: "أُرسلت", text: m.subject });
    if (m.openedAt) items.push({ at: m.openedAt, kind: "فتح", text: `${m.subject}${m.openCount > 1 ? ` (${m.openCount} مرات)` : ""}`, cls: "text-blue-400" });
    if (m.clickedAt) items.push({ at: m.clickedAt, kind: "نقر", text: m.subject, cls: "text-primary" });
    if (m.bouncedAt) items.push({ at: m.bouncedAt, kind: "ارتدّت", text: m.error ?? m.subject, cls: "text-red-400" });
    if (m.status === "failed") items.push({ at: m.createdAt, kind: "فشلت", text: m.error ?? "", cls: "text-red-400" });
  }
  for (const i of data?.inbound ?? []) items.push({ at: i.receivedAt, kind: "ردّ", text: i.summary ?? i.text?.slice(0, 160) ?? "", cls: "text-green-400" });
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const pending = (data?.jobs ?? []).filter((j: any) => j.status === "pending");
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex justify-start" onClick={onClose}>
      <div className="w-full max-w-md h-full bg-background border-l border-card-border overflow-y-auto p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
        {!c ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /> : <>
          <div>
            <p className="font-bold">{c.company ?? c.name ?? c.email}</p>
            <p className="text-xs font-mono text-muted-foreground" dir="ltr">{c.email}{c.phone ? ` · +${c.phone}` : ""}</p>
            <p className="text-[11px] text-muted-foreground mt-1">{[c.name, c.industry, c.city, c.source].filter(Boolean).join(" · ")}</p>
          </div>
          {pending.length > 0 && <div className="rounded-lg border border-card-border p-3 text-xs"><p className="font-semibold mb-1">المتابعات المجدولة</p>{pending.map((j: any) => <p key={j.id} className="text-muted-foreground">الخطوة {j.stepIndex + 1} — {new Date(j.dueAt).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</p>)}</div>}
          <div className="space-y-2">
            {items.length === 0 ? <p className="text-xs text-muted-foreground">لم يحدث شيء بعد.</p> : items.map((it, i) => (
              <div key={i} className="text-xs border-r-2 border-card-border pr-2"><span className={cn("font-semibold", it.cls)}>{it.kind}</span> <span className="text-muted-foreground">{ago(it.at)}</span><p className="text-muted-foreground">{it.text}</p></div>
            ))}
          </div>
        </>}
      </div>
    </div>
  );
}

/** Who a waiting mission goes to — a list, a folder or the filter it was written for — and how many that is. */
function MissionAudience({ m, onSaved }: { m: any; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Filter>(m.filter ?? {});
  const { data: lists = [] } = useQuery<any[]>({ queryKey: ["email-lists"], queryFn: () => api("/api/email/lists"), enabled: open });
  const { data: fd } = useQuery<any>({ queryKey: ["folders", "email"], queryFn: () => api("/api/folders?kind=email"), enabled: open });
  const folders: any[] = fd?.folders ?? [];
  const save = useMutation({
    mutationFn: () => api(`/api/email/missions/${m.id}/audience`, { method: "POST", body: JSON.stringify({ filter: { ...f, maxTouches: m.filter?.maxTouches, take: m.filter?.take } }) }),
    onSuccess: () => { setOpen(false); onSaved(); toast.success("تغيّر الجمهور"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const empty = !m.audienceCount;
  return (
    <div className={cn("rounded-lg border p-3 text-xs", empty ? "border-red-500/40 bg-red-500/5" : "border-card-border")}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold">الجمهور:</span>
        <span className="text-muted-foreground">{m.audience}</span>
        <b className={empty ? "text-red-400" : "text-primary"}>{(m.audienceCount ?? 0).toLocaleString("ar-SA")} يمكن مراسلتهم</b>
        <button onClick={() => setOpen(!open)} className="mr-auto text-primary hover:underline">{open ? "إغلاق" : "غيّر الجمهور"}</button>
      </div>
      {empty && !open && <p className="text-red-400 mt-1.5">لا أحد في هذا الجمهور الآن — ارفع القائمة من «القوائم» أو اختر قائمة أخرى، ثم وافق.</p>}
      {open && (
        <div className="mt-3 space-y-3">
          {(lists.length > 0 || folders.length > 0) && (
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground">قوائم ومجلدات (اختياري):</p>
              <div className="flex flex-wrap gap-1.5">
                {folders.map((fo: any) => { const on = !!f.folderIds?.includes(fo.id); return <button key={`f${fo.id}`} onClick={() => setF({ ...f, folderIds: on ? f.folderIds!.filter((x) => x !== fo.id) : [...(f.folderIds ?? []), fo.id] })} className={chip(on)}>📁 {fo.name}</button>; })}
                {lists.filter((l: any) => !l.stage).map((l: any) => { const on = !!f.listIds?.includes(l.id); return <button key={`l${l.id}`} onClick={() => setF({ ...f, listIds: on ? f.listIds!.filter((x) => x !== l.id) : [...(f.listIds ?? []), l.id] })} className={chip(on)}>{l.name} ({l.sendable})</button>; })}
              </div>
            </div>
          )}
          <AudiencePicker value={f} onChange={setF} compact />
          <button onClick={() => save.mutate()} disabled={save.isPending} className={primary}>{save.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />} احفظ الجمهور</button>
        </div>
      )}
    </div>
  );
}
