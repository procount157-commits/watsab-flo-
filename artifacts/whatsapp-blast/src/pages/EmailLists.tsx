// ── Email lists ───────────────────────────────────────────────────
// The same shape as the WhatsApp number lists: folders down the side, a card
// per list, a file dropped in becomes a list in one step (into the open
// folder, or its sector's folder), and each list opens on a page of its own.
// The difference is what a card says: an email list is judged by who can
// still be written to and who answered, so every card carries both.

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";
import {
  ChevronLeft, ChevronRight, Download, Eye, FileSpreadsheet, Loader2, Mail, Megaphone, MessageCircle, MinusCircle, Pencil,
  Plus, Reply, Search, Send, Sparkles, Trash2, ArrowRight, ListOrdered, ShieldOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { FolderSidebar, MoveToFolder, inFolder, type FolderSel } from "@/components/Folders";
import { ContactDrawer, type Filter } from "./EmailAgent";
import { ListHygiene } from "@/components/EmailHygiene";
import { ListPipeline } from "@/components/ListPipeline";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const rate = (part?: number, whole?: number) => (whole ? `${Math.round(((part ?? 0) / whole) * 100)}%` : "—");
const ago = (d?: string | null) => {
  if (!d) return "لم يُراسَل";
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000);
  return days < 1 ? "اليوم" : days === 1 ? "أمس" : `قبل ${days} يوم`;
};

export type EmailList = {
  id: number; name: string; description: string | null; folderId: number | null; createdAt: string;
  count: number; sendable: number; unsubscribed: number; bounced: number; withPhone: number;
  reached: number; opened: number; replied: number; sector: string | null; lastSentAt: string | null;
  /** A stage list يوسف keeps under another list: its parent and which stage. */
  parentListId?: number | null; stage?: string | null;
};
const STAGE_AR: Record<string, string> = { opened: "فتحوا ولم يردّوا", clicked: "نقروا", replied: "ردّوا", unopened: "لم يفتحوا" };

export function useEmailLists() {
  return useQuery<EmailList[]>({ queryKey: ["email-lists"], queryFn: () => api("/api/email/lists") });
}

/** Deleting a list asks what to do with the addresses in it. */
function useDeleteList(after?: () => void) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: ({ id, contacts }: { id: number; contacts: boolean }) => api(`/api/email/lists/${id}${contacts ? "?contacts=1" : ""}`, { method: "DELETE" }),
    onSuccess: (d: any) => {
      for (const k of ["email-lists", "email-audience", "email-facets", "folders", "email-overview"]) qc.invalidateQueries({ queryKey: [k] });
      toast.success(d.deleted ? `حُذفت القائمة و${n(d.deleted)} عنوان${d.keptUnsubscribed ? ` (بقي ${d.keptUnsubscribed} ممن ألغوا حتى لا يُراسَلوا)` : ""}` : "حُذفت القائمة — العناوين باقية في الجمهور");
      after?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (l: { id: number; name: string; count: number }) => {
    const a = prompt(`حذف قائمة «${l.name}» (${n(l.count)} عنوان):\n1 — القائمة فقط، والعناوين تبقى في الجمهور\n2 — القائمة وعناوينها (إلا الموجودة في قوائم أخرى)\nاكتب 1 أو 2`);
    const v = a?.trim();
    if (v === "1" || v === "١") m.mutate({ id: l.id, contacts: false });
    else if (v === "2" || v === "٢") m.mutate({ id: l.id, contacts: true });
  };
}

/** A bar of who in the list can be written to, who left and who bounced. */
function HealthBar({ l }: { l: EmailList }) {
  if (!l.count) return <div className="h-1.5 rounded-full bg-muted" />;
  const w = (v: number) => `${(v / l.count) * 100}%`;
  return (
    <div className="h-1.5 rounded-full bg-muted overflow-hidden flex" dir="ltr" title={`${n(l.sendable)} قابل للإرسال · ${n(l.unsubscribed)} ألغوا · ${n(l.bounced)} ارتدّ`}>
      <div className="bg-primary" style={{ width: w(l.sendable) }} />
      <div className="bg-yellow-500/70" style={{ width: w(l.unsubscribed) }} />
      <div className="bg-red-500/70" style={{ width: w(l.bounced) }} />
    </div>
  );
}

// ── The lists page ───────────────────────────────────────────────
export function ListsTab({ onCampaign }: { onCampaign: (listId: number) => void }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data: lists = [], isLoading } = useEmailLists();
  const [folder, setFolder] = useState<FolderSel>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"new" | "size" | "name" | "engaged">("new");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const inv = () => { for (const k of ["email-lists", "folders", "email-overview", "email-audience", "email-facets"]) qc.invalidateQueries({ queryKey: [k] }); };
  const askDelete = useDeleteList();

  // A file in one step: read, cleaned, saved as a list named after the file
  // — into the open folder, or its sector's folder — and opened.
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("country", "AE");
      fd.append("mx", "true");
      fd.append("saveWhatsapp", "true");
      fd.append("listName", file.name.replace(/\.[a-z0-9]+$/i, ""));
      if (typeof folder === "number") fd.append("folderId", String(folder));
      const r = await fetch(`${BASE}/api/email/contacts/import`, { method: "POST", body: fd, credentials: "include" });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "تعذّر الاستيراد");
      inv();
      toast.success(`${d.addedTo ? `أُضيف إلى «${d.addedTo}»` : `قائمة «${d.list?.name}»`}: ${n(d.kept)} بريد (${n(d.inserted)} جديد)${d.folder ? ` · في مجلد «${d.folder}»` : ""}${d.mxBad ? ` · ${n(d.mxBad)} نطاق لا يستقبل` : ""}${d.whatsapp?.added ? ` · ${n(d.whatsapp.added)} رقم واتساب` : ""}`);
      if (d.pipeline) toast.info("الفريق استلم القائمة: ماجد ينظّف، سلمى تحلل وتوصي، نورة تكتب، وطارق يعرضها عليك للموافقة.");
      if (d.list?.id) navigate(`/email/lists/${d.list.id}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setUploading(false); }
  };

  const create = useMutation({
    mutationFn: () => api("/api/email/lists", { method: "POST", body: JSON.stringify({ name: newName, folderId: typeof folder === "number" ? folder : null }) }),
    onSuccess: (l: any) => { inv(); setCreating(false); setNewName(""); navigate(`/email/lists/${l.id}`); },
    onError: (e: Error) => toast.error(e.message),
  });

  const shown = useMemo(() => {
    let r = inFolder(lists, folder);
    if (q.trim()) r = r.filter((l) => l.name.toLowerCase().includes(q.trim().toLowerCase()));
    const by: Record<typeof sort, (a: EmailList, b: EmailList) => number> = {
      new: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt),
      size: (a, b) => b.count - a.count,
      name: (a, b) => a.name.localeCompare(b.name, "ar"),
      engaged: (a, b) => (b.opened + b.replied * 3) - (a.opened + a.replied * 3),
    };
    return [...r].sort(by[sort]);
  }, [lists, folder, q, sort]);

  const totals = useMemo(() => shown.reduce((t, l) => ({ count: t.count + l.count, sendable: t.sendable + l.sendable, replied: t.replied + l.replied, withPhone: t.withPhone + l.withPhone }), { count: 0, sendable: 0, replied: 0, withPhone: 0 }), [shown]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[12rem]">
          <Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className={cn(input, "pr-8")} placeholder="ابحث عن قائمة" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className={cn(input, "w-36 text-xs")} value={sort} onChange={(e) => setSort(e.target.value as any)}>
          <option value="new">الأحدث</option><option value="size">الأكبر</option><option value="engaged">الأكثر تفاعلاً</option><option value="name">بالاسم</option>
        </select>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className={cn(ghost, "border-primary/40 text-primary")}>
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} {uploading ? "يقرأ الملف…" : "ارفع ملف Excel"}
        </button>
        <button onClick={() => setCreating(true)} className={primary}><Plus className="w-3.5 h-3.5" /> قائمة جديدة</button>
      </div>

      {creating && (
        <form onSubmit={(e) => { e.preventDefault(); if (newName.trim()) create.mutate(); }} className={cn(card, "p-3 flex gap-2 items-center")}>
          <input autoFocus className={input} placeholder="اسم القائمة — مثلاً: وسطاء دبي" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button className={primary} disabled={!newName.trim() || create.isPending}>إنشاء</button>
          <button type="button" onClick={() => setCreating(false)} className={ghost}>إلغاء</button>
        </form>
      )}

      <div className="grid md:grid-cols-[14rem_1fr] gap-4 items-start">
        <div className={cn(card, "p-2 md:sticky md:top-4")}>
          <FolderSidebar kind="email" value={folder} onChange={setFolder} total={lists.length} onChanged={inv} lists={lists} />
        </div>

        <div className="space-y-3">
          {shown.length > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {[["عناوين", totals.count, Mail], ["قابلة للإرسال", totals.sendable, Send], ["لها واتساب", totals.withPhone, MessageCircle], ["ردّوا", totals.replied, Reply]].map(([label, v, Icon]: any) => (
                <div key={label} className={cn(card, "px-3 py-2.5 flex items-center gap-2.5")}>
                  <Icon className="w-4 h-4 text-primary shrink-0" />
                  <div><p className="text-lg font-bold leading-none">{n(v)}</p><p className="text-[10px] text-muted-foreground mt-1">{label}</p></div>
                </div>
              ))}
            </div>
          )}

          {isLoading ? <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          : !lists.length ? (
            <div className={cn(card, "py-16 text-center")}>
              <Mail className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-medium">لا قوائم بريد بعد</p>
              <p className="text-sm text-muted-foreground mt-1">ارفع ملف Excel — يُقرأ وينظّف ويصبح قائمة في مجلد قطاعها.</p>
              <button onClick={() => fileRef.current?.click()} className={cn(primary, "mx-auto mt-4")}><FileSpreadsheet className="w-3.5 h-3.5" /> ارفع ملفاً</button>
            </div>
          ) : !shown.length ? (
            <div className={cn(card, "py-12 text-center")}>
              <p className="text-sm text-muted-foreground">{folder !== "all" ? "المجلد فارغ — اسحب إليه قائمة، أو ارفع ملفاً وهو مفتوح." : "لا قائمة بهذا الاسم."}</p>
              <button onClick={() => { setFolder("all"); setQ(""); }} className="text-xs text-primary mt-2 hover:underline">إظهار الكل</button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {shown.map((l) => (
                <div key={l.id} draggable onDragStart={(e) => e.dataTransfer.setData("text/list-id", String(l.id))}
                  className={cn(card, "p-4 hover:border-primary/40 transition-colors cursor-grab active:cursor-grabbing flex flex-col gap-3")}>
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <Link href={`/email/lists/${l.id}`} className="font-semibold truncate block hover:text-primary">{l.name}</Link>
                      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                        {l.stage && <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/30">🔁 قائمة مرحلة: {STAGE_AR[l.stage] ?? l.stage}</span>}
                        {l.sector && <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">{l.sector}</span>}
                        <span className="text-[10px] text-muted-foreground">{ago(l.lastSentAt)}</span>
                      </div>
                    </div>
                    <button onClick={() => askDelete(l)} title="حذف القائمة" className="p-1 text-muted-foreground hover:text-red-400"><Trash2 className="w-4 h-4" /></button>
                  </div>

                  <div className="flex items-end justify-between">
                    <div><p className="text-2xl font-bold leading-none">{n(l.count)}</p><p className="text-[10px] text-muted-foreground mt-1">عنوان · {n(l.sendable)} قابل للإرسال</p></div>
                    <div className="text-left text-[11px] space-y-0.5">
                      <p><span className="text-muted-foreground">فتح </span><b className="text-blue-400">{rate(l.opened, l.reached)}</b></p>
                      <p><span className="text-muted-foreground">ردّ </span><b className="text-green-400">{rate(l.replied, l.reached)}</b></p>
                    </div>
                  </div>
                  <HealthBar l={l} />
                  <div className="grid grid-cols-3 gap-1.5 text-center text-[10px]">
                    <div className="rounded-md bg-muted/40 py-1.5"><b className="block text-xs">{n(l.reached)}</b><span className="text-muted-foreground">راسلناهم</span></div>
                    <div className="rounded-md bg-muted/40 py-1.5"><b className="block text-xs">{n(l.withPhone)}</b><span className="text-muted-foreground">لهم واتساب</span></div>
                    <div className="rounded-md bg-muted/40 py-1.5"><b className={cn("block text-xs", (l.unsubscribed + l.bounced) > 0 && "text-yellow-400")}>{n(l.unsubscribed + l.bounced)}</b><span className="text-muted-foreground">ألغوا/ارتدّ</span></div>
                  </div>

                  <div className="flex items-center gap-1.5 pt-1 border-t border-card-border">
                    <MoveToFolder kind="email" listId={l.id} folderId={l.folderId} onMoved={inv} />
                    <button onClick={() => onCampaign(l.id)} disabled={!l.sendable} className="mr-auto flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary disabled:opacity-40"><Megaphone className="w-3 h-3" /> حملة</button>
                    <Link href={`/email/lists/${l.id}`} className="flex items-center gap-0.5 text-[11px] text-primary hover:underline">إدارة <ChevronLeft className="w-3 h-3" /></Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── One list ─────────────────────────────────────────────────────
const ENG_LABEL: Record<string, string> = { never_sent: "لم يُراسَل", sent_no_open: "لم يفتح", opened_no_reply: "فتح ولم يرد", replied: "ردّ" };
const STATUS: Record<string, { label: string; cls: string }> = {
  active: { label: "نشط", cls: "text-primary" }, unsubscribed: { label: "ألغى", cls: "text-yellow-400" },
  bounced: { label: "ارتدّ", cls: "text-red-400" }, complained: { label: "بلاغ", cls: "text-red-500" },
};

export function ListDetail({ id, onCampaign, onWrite }: { id: number; onCampaign: (listId: number) => void; onWrite: (f: Filter) => void }) {
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-list", id], queryFn: () => api(`/api/email/lists/${id}`) });
  const { data: seqs = [] } = useQuery<any[]>({ queryKey: ["email-seqs"], queryFn: () => api("/api/email/sequences") });
  const [q, setQ] = useState("");
  const [eng, setEng] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const filter: Filter = { listIds: [id], q: q || undefined, engagement: eng ? [eng] : undefined, statuses: status ? [status] : undefined };
  const { data: rowsData, isFetching } = useQuery<any>({
    queryKey: ["email-audience", "list", id, filter, page],
    queryFn: () => api("/api/email/contacts/search", { method: "POST", body: JSON.stringify({ filter, limit: 100, offset: page * 100 }) }),
  });
  const inv = () => { for (const k of ["email-list", "email-lists", "email-audience", "email-facets", "email-overview"]) qc.invalidateQueries({ queryKey: [k] }); };
  const askDelete = useDeleteList(() => navigate("/email/lists"));

  const rename = useMutation({ mutationFn: (name: string) => api(`/api/email/lists/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }), onSuccess: inv, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({
    mutationFn: (ids: number[]) => api(`/api/email/lists/${id}/remove`, { method: "POST", body: JSON.stringify({ ids }) }),
    onSuccess: (d: any) => { inv(); setSel(new Set()); toast.success(`أُخرج ${n(d.removed)} من القائمة — باقون في الجمهور`); },
  });
  const bulk = useMutation({
    mutationFn: (b: any) => api("/api/email/contacts/bulk", { method: "POST", body: JSON.stringify({ ids: [...sel], ...b }) }),
    onSuccess: (d: any) => { inv(); setSel(new Set()); toast.success(d.deleted !== undefined ? `حُذف ${n(d.deleted)}${d.keptUnsubscribed ? ` · بقي ${d.keptUnsubscribed} ممن ألغوا` : ""}` : `تم — ${n(d.done)}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const enrol = useMutation({
    mutationFn: (sequenceId: number) => api(`/api/email/sequences/${sequenceId}/enrol`, { method: "POST", body: JSON.stringify({ listId: id }) }),
    onSuccess: (d: any) => { inv(); toast.success(`سُجّل ${n(d.enrolled)} في المتابعة (${n(d.skipped)} تُخطّوا)`); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  if (!data?.list) return <div className={cn(card, "p-10 text-center text-sm text-muted-foreground")}>القائمة غير موجودة. <Link href="/email/lists" className="text-primary underline">كل القوائم</Link></div>;
  const l: EmailList = data.list;
  const fac = data.facets ?? {};
  const rows: any[] = rowsData?.rows ?? [];
  const total = rowsData?.total ?? 0;
  const pages = Math.ceil(total / 100);

  const tiles: Array<[string, string, string?]> = [
    ["العناوين", n(l.count)],
    ["قابلة للإرسال", n(l.sendable), "text-primary"],
    ["لهم واتساب", n(l.withPhone)],
    ["راسلناهم", n(l.reached)],
    ["فتحوا", `${n(l.opened)} · ${rate(l.opened, l.reached)}`, "text-blue-400"],
    ["ردّوا", `${n(l.replied)} · ${rate(l.replied, l.reached)}`, "text-green-400"],
    ["ألغوا", n(l.unsubscribed), l.unsubscribed ? "text-yellow-400" : undefined],
    ["ارتدّ / نطاق ميت", n(l.bounced), l.bounced ? "text-red-400" : undefined],
  ];

  return (
    <div className="space-y-4">
      {openId && <ContactDrawer id={openId} onClose={() => setOpenId(null)} />}
      <div className="flex items-start gap-3 flex-wrap">
        <Link href="/email/lists" className="mt-1 p-1.5 rounded-lg border border-card-border hover:border-primary/50"><ArrowRight className="w-4 h-4" /></Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold truncate">{l.name}</h2>
            <button title="إعادة تسمية" onClick={() => { const v = prompt("اسم القائمة", l.name); if (v?.trim() && v.trim() !== l.name) rename.mutate(v.trim()); }} className="text-muted-foreground hover:text-foreground"><Pencil className="w-3.5 h-3.5" /></button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{l.description || "قائمة بريد"}{l.sector ? ` · ${l.sector}` : ""} · أُنشئت {new Date(l.createdAt).toLocaleDateString("ar-AE")}</p>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => onCampaign(l.id)} disabled={!l.sendable} className={primary}><Megaphone className="w-3.5 h-3.5" /> حملة لهذه القائمة</button>
          <button onClick={() => onWrite({ listIds: [l.id] })} disabled={!l.sendable} className={ghost}><Sparkles className="w-3.5 h-3.5" /> نورة تكتب لهم</button>
          <select className={cn(input, "w-44 text-xs")} value="" onChange={(e) => e.target.value && enrol.mutate(Number(e.target.value))} disabled={!seqs.length}>
            <option value="">{seqs.length ? "سجّل في متابعة…" : "لا تسلسلات متابعة"}</option>{seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <a href={`${BASE}/api/email/lists/${l.id}/export`} className={ghost}><Download className="w-3.5 h-3.5" /> تصدير</a>
          <button onClick={() => askDelete(l)} className={cn(ghost, "text-red-400 border-red-500/30")}><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        {tiles.map(([label, v, tone]) => (
          <div key={label} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground">{label}</p><p className={cn("text-lg font-bold leading-none mt-1.5", tone)}>{v}</p></div>
        ))}
      </div>
      <HealthBar l={l} />
      <ListPipeline listId={l.id} />
      <ListHygiene listId={l.id} />

      <div className="grid lg:grid-cols-[1fr_17rem] gap-4 items-start">
        <div className={card}>
          <div className="p-3 border-b border-card-border flex gap-2 flex-wrap items-center">
            <div className="relative flex-1 min-w-[10rem]">
              <Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input className={cn(input, "pr-8")} placeholder="بحث بالبريد أو الشركة" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
            </div>
            <select className={cn(input, "w-36 text-xs")} value={eng} onChange={(e) => { setEng(e.target.value); setPage(0); }}>
              <option value="">كل التفاعل</option>{Object.entries(ENG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select className={cn(input, "w-28 text-xs")} value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}>
              <option value="">كل الحالات</option>{Object.entries(STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <span className="text-xs text-muted-foreground">{isFetching ? <Loader2 className="w-3 h-3 animate-spin inline" /> : n(total)}</span>
          </div>
          {sel.size > 0 && (
            <div className="p-2.5 border-b border-card-border bg-primary/5 flex flex-wrap gap-1.5 items-center text-xs">
              <span className="font-semibold">{n(sel.size)} محدد</span>
              <button onClick={() => remove.mutate([...sel])} className={ghost}><MinusCircle className="w-3 h-3" /> أخرجهم من القائمة</button>
              <button onClick={() => bulk.mutate({ action: "unsubscribe" })} className={ghost}><ShieldOff className="w-3 h-3" /> أوقف مراسلتهم</button>
              <button onClick={() => bulk.mutate({ action: "activate" })} className={ghost}>أعد تفعيلهم</button>
              <button onClick={() => confirm(`حذف ${sel.size} جهة اتصال نهائياً؟`) && bulk.mutate({ action: "delete" })} className={cn(ghost, "text-red-400")}><Trash2 className="w-3 h-3" /> حذف</button>
              <button onClick={() => setSel(new Set())} className="text-muted-foreground mr-auto">إلغاء التحديد</button>
            </div>
          )}
          <div className="overflow-x-auto max-h-[36rem] overflow-y-auto">
            {!rows.length ? <p className="p-10 text-center text-sm text-muted-foreground">{l.count ? "لا أحد يطابق البحث." : "القائمة فارغة — ارفع ملفاً، أو أضف إليها من «الجمهور»."}</p> : (
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-card z-10"><tr className="text-muted-foreground">
                  <th className="p-2 w-8"><input type="checkbox" checked={rows.every((r) => sel.has(r.id))} onChange={(e) => { const s = new Set(sel); rows.forEach((r) => e.target.checked ? s.add(r.id) : s.delete(r.id)); setSel(s); }} /></th>
                  <th className="text-right p-2">الشركة</th><th className="text-right p-2">البريد</th><th className="text-right p-2">القطاع</th><th className="text-right p-2">المدينة</th><th className="text-right p-2">واتساب</th><th className="text-right p-2">الحالة</th><th className="text-right p-2">آخر إرسال</th><th className="text-center p-2"><Eye className="w-3 h-3 inline" /></th><th className="text-center p-2"><Reply className="w-3 h-3 inline" /></th>
                </tr></thead>
                <tbody>{rows.map((c) => (
                  <tr key={c.id} className={cn("border-t border-card-border hover:bg-muted/30", sel.has(c.id) && "bg-primary/5")}>
                    <td className="p-2"><input type="checkbox" checked={sel.has(c.id)} onChange={() => { const s = new Set(sel); s.has(c.id) ? s.delete(c.id) : s.add(c.id); setSel(s); }} /></td>
                    <td className="p-2 cursor-pointer hover:text-primary font-medium" onClick={() => setOpenId(c.id)}>{c.company ?? c.name ?? "—"}</td>
                    <td className="p-2 font-mono" dir="ltr">{c.email}</td>
                    <td className="p-2">{c.sector ?? <span className="text-muted-foreground">—</span>}</td>
                    <td className="p-2 text-muted-foreground">{c.city ?? "—"}</td>
                    <td className="p-2 font-mono text-muted-foreground" dir="ltr">{c.phone ?? ""}</td>
                    <td className={cn("p-2", STATUS[c.status]?.cls)}>{STATUS[c.status]?.label ?? c.status}{c.mxOk === false ? " · نطاق ميت" : ""}</td>
                    <td className="p-2 text-muted-foreground">{c.lastSentAt ? new Date(c.lastSentAt).toLocaleDateString("ar-AE") : "—"}</td>
                    <td className="p-2 text-center">{c.lastOpenedAt ? <span className="text-blue-400">●</span> : ""}</td>
                    <td className="p-2 text-center">{c.lastRepliedAt ? <span className="text-green-400">●</span> : ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
          {pages > 1 && (
            <div className="p-2.5 border-t border-card-border flex items-center justify-center gap-3 text-xs">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className={ghost}><ChevronRight className="w-3 h-3" /></button>
              <span className="text-muted-foreground">صفحة {n(page + 1)} من {n(pages)}</span>
              <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} className={ghost}><ChevronLeft className="w-3 h-3" /></button>
            </div>
          )}
        </div>

        <div className="space-y-3">
          {[["القطاعات", fac.sectors], ["المدن", fac.cities]].map(([title, items]: any) => items?.length > 0 && (
            <div key={title} className={cn(card, "p-3")}>
              <p className="text-xs font-semibold mb-2">{title}</p>
              <div className="space-y-1.5">
                {items.slice(0, 8).map((x: any) => (
                  <div key={x.key} className="text-[11px]">
                    <div className="flex justify-between"><span className="truncate">{x.key}</span><span className="text-muted-foreground">{n(x.n)}</span></div>
                    <div className="h-1 rounded-full bg-muted mt-0.5 overflow-hidden" dir="ltr"><div className="h-full bg-primary/70" style={{ width: `${(x.n / Math.max(1, l.count)) * 100}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <div className={cn(card, "p-3")}>
            <p className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Megaphone className="w-3.5 h-3.5" /> حملات هذه القائمة</p>
            {!data.campaigns?.length ? <p className="text-[11px] text-muted-foreground">لم تُرسل لها حملة بعد.</p> : (
              <div className="space-y-1.5">{data.campaigns.map((c: any) => (
                <Link key={c.id} href="/email/campaigns" className="block text-[11px] hover:text-primary">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground"> · أُرسل {n(c.sentCount)} · فتح {rate(c.openCount, c.sentCount)} · ردّ {n(c.replyCount)}</span>
                </Link>
              ))}</div>
            )}
          </div>
          <div className={cn(card, "p-3 text-[11px] text-muted-foreground space-y-1")}>
            <p className="font-semibold text-foreground flex items-center gap-1.5"><ListOrdered className="w-3.5 h-3.5" /> نصيحة</p>
            <p>«أخرجهم من القائمة» يُبقي العنوان في الجمهور وقوائمه الأخرى. «أوقف مراسلتهم» يمنع أي رسالة لهم من أي حملة أو متابعة.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

