import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Search, Send, CheckSquare, Square, Users, Download,
  Import, RefreshCw, MessageSquare, Wifi, WifiOff,
  CheckCheck, ChevronLeft, X, Hash, Layers, FileSpreadsheet,
  MessagesSquare, Clock, Database, RotateCcw, CheckCircle2, Loader2, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import * as XLSX from "xlsx";

// ── Types ──────────────────────────────────────────────────────────
interface Conversation {
  phone: string;
  name: string | null;
  lastText: string;
  lastAt: number;
  msgCount: number;
}
interface Message {
  id: number;
  text: string;
  fromMe: boolean;
  createdAt: number;
}

// ── Helpers ────────────────────────────────────────────────────────
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const apiFetch = (path: string) =>
  fetch(`${BASE}${path}`, { credentials: "include" }).then(r => {
    if (!r.ok) throw new Error();
    return r.json();
  });

function fmtTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const now = new Date();
  const today = new Date(now); today.setHours(0,0,0,0);
  const yest  = new Date(today); yest.setDate(yest.getDate()-1);
  if (d >= today) return d.toLocaleTimeString("ar-SA", {hour:"2-digit",minute:"2-digit"});
  if (d >= yest)  return "أمس";
  return d.toLocaleDateString("ar-SA", {month:"short",day:"numeric"});
}
function fmtFull(ts: number) {
  return new Date(ts * 1000).toLocaleString("ar-SA", {
    year:"numeric",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"
  });
}
function groupByDay(messages: Message[]) {
  const groups: { label: string; msgs: Message[] }[] = [];
  let cur = "";
  for (const m of messages) {
    const d = new Date(m.createdAt * 1000);
    const key = d.toLocaleDateString("ar-SA", {year:"numeric",month:"long",day:"numeric"});
    if (key !== cur) { cur = key; groups.push({ label: key, msgs: [] }); }
    groups[groups.length-1].msgs.push(m);
  }
  return groups;
}

const SPLIT = 1000;
async function importPhones(listName: string, phones: string[]) {
  const r = await fetch(`${BASE}/api/whatsapp/extractor/import`, {
    method: "POST", credentials: "include",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ listName, phones }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function splitImport(baseName: string, phones: string[]) {
  if (phones.length <= SPLIT) {
    const res = await importPhones(baseName, phones);
    return { groups: 1, count: res.count, listName: res.listName };
  }
  const chunks = Math.ceil(phones.length / SPLIT);
  for (let i = 0; i < phones.length; i += SPLIT) {
    const g = Math.floor(i/SPLIT)+1;
    await importPhones(`${baseName} - ${g}`, phones.slice(i, i+SPLIT));
  }
  return { groups: chunks, count: phones.length };
}

// ══════════════════════════════════════════════════════════════════
export default function WaInbox() {
  const qc = useQueryClient();
  const [search, setSearch]           = useState("");
  const [selected, setSelected]       = useState<string | null>(null);   // open thread
  const [draftText, setDraftText]     = useState("");
  const [sending, setSending]         = useState(false);
  const [sel, setSel]                 = useState(new Set<string>());     // bulk selected
  const [importName, setImportName]   = useState("بريد الوارد");
  const [showImport, setShowImport]   = useState(false);
  const [importing, setImporting]     = useState(false);
  const [bulkText, setBulkText]       = useState("");
  const [bulkSending, setBulkSending] = useState(false);
  const [showBulkReply, setShowBulkReply] = useState(false);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const textareaRef  = useRef<HTMLTextAreaElement>(null);

  // conversations list
  const { data: convs = [], isLoading, refetch } = useQuery<Conversation[]>({
    queryKey: ["wa-inbox"],
    queryFn:  () => apiFetch("/api/whatsapp/inbox"),
    refetchInterval: 6_000,
  });

  // thread messages
  const { data: thread = [], refetch: refetchThread } = useQuery<Message[]>({
    queryKey: ["wa-inbox-thread", selected],
    queryFn:  () => selected ? apiFetch(`/api/whatsapp/inbox/${selected}`) : Promise.resolve([]),
    enabled:  !!selected,
    refetchInterval: 4_000,
  });

  // WA connection status
  // The lead card for the open thread: where the sale is, and whether a
  // person holds it. The switch is what lets the owner step in without the
  // bot answering over them, and step back out.
  const { data: leadCard } = useQuery<any>({
    queryKey: ["lead-card", selected],
    queryFn:  () => selected ? apiFetch(`/api/lead-cards/${selected}`) : Promise.resolve(null),
    enabled:  !!selected,
    refetchInterval: 30_000,
  });
  const holdMut = useMutation({
    mutationFn: async (take: boolean) => {
      const r = await fetch(`${BASE}/api/lead-cards/${selected}/${take ? "takeover" : "release"}`, { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "تعذّر");
      return r.json();
    },
    onSuccess: (_d, take) => {
      toast.success(take ? "أنت على المحادثة — البوت والمتابعات صامتان 24 ساعة" : "أُعيدت المحادثة للفريق");
      qc.invalidateQueries({ queryKey: ["lead-card", selected] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const { data: status } = useQuery<{connected:boolean;phone?:string}>({
    queryKey: ["wa-status"],
    queryFn:  () => apiFetch("/api/whatsapp/status"),
    refetchInterval: 5_000,
  });
  const connected = !!status?.connected;

  // Sync state
  const { data: syncState, refetch: refetchSync } = useQuery<{
    syncStatus: string;
    lastFullSyncAt: string | null;
    db: { threads: number; conversations: number; contacts: number };
  }>({
    queryKey: ["wa-sync-state"],
    queryFn:  () => apiFetch("/api/whatsapp/sync-state"),
    refetchInterval: 10_000,
  });
  const [resyncing, setResyncing] = useState(false);
  const handleResync = async () => {
    setResyncing(true);
    try {
      await fetch(`${BASE}/api/whatsapp/extractor/resync`, { method: "POST", credentials: "include" });
      toast.success("جاري إعادة المزامنة — يستغرق 10-30 ثانية");
      setTimeout(() => { refetchSync(); refetch(); }, 5000);
    } catch { toast.error("فشلت إعادة المزامنة"); }
    finally { setTimeout(() => setResyncing(false), 8000); }
  };

  // scroll to bottom when thread changes
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread]);

  // filtered conversation list
  const filtered = useMemo(() => {
    if (!search) return convs;
    const q = search.toLowerCase();
    return convs.filter(c =>
      c.phone.includes(q) ||
      (c.name ?? "").toLowerCase().includes(q) ||
      c.lastText.toLowerCase().includes(q)
    );
  }, [convs, search]);

  // selected conv info
  const openConv = convs.find(c => c.phone === selected) ?? null;

  // bulk helpers
  const allSel     = filtered.length > 0 && filtered.every(c => sel.has(c.phone));
  const toggleAll  = () => allSel
    ? setSel(s => { const n=new Set(s); filtered.forEach(c=>n.delete(c.phone)); return n; })
    : setSel(s => { const n=new Set(s); filtered.forEach(c=>n.add(c.phone)); return n; });
  const toggleOne  = (p:string) => setSel(s => { const n=new Set(s); n.has(p)?n.delete(p):n.add(p); return n; });

  // send message in open thread
  const handleSend = async () => {
    if (!selected || !draftText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${BASE}/api/whatsapp/inbox/${selected}/send`, {
        method:"POST", credentials:"include",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ text: draftText.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      setDraftText("");
      qc.invalidateQueries({ queryKey: ["wa-inbox-thread", selected] });
      qc.invalidateQueries({ queryKey: ["wa-inbox"] });
    } catch(e:any) {
      toast.error(e.message ?? "فشل الإرسال");
    } finally { setSending(false); }
  };

  // The same words, spoken: the account's voice reads them as a voice note.
  const handleSendVoice = async () => {
    if (!selected || !draftText.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch(`${BASE}/api/whatsapp/inbox/${selected}/voice`, {
        method:"POST", credentials:"include", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ text: draftText.trim() }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "فشل الإرسال");
      setDraftText("");
      qc.invalidateQueries({ queryKey: ["wa-inbox-thread", selected] });
      qc.invalidateQueries({ queryKey: ["wa-inbox"] });
      toast.success("أُرسلت كرسالة صوتية");
    } catch(e:any) { toast.error(e.message ?? "فشل الإرسال"); } finally { setSending(false); }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // bulk send
  const handleBulkSend = async () => {
    if (!bulkText.trim() || sel.size === 0 || bulkSending) return;
    setBulkSending(true);
    let ok = 0, fail = 0;
    for (const phone of sel) {
      try {
        const res = await fetch(`${BASE}/api/whatsapp/inbox/${phone}/send`, {
          method:"POST", credentials:"include",
          headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ text: bulkText.trim() }),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
    }
    setBulkSending(false);
    setBulkText("");
    setShowBulkReply(false);
    setSel(new Set());
    toast.success(`✅ تم الإرسال لـ ${ok} رقم${fail>0?` • فشل ${fail}`:""}`);
    qc.invalidateQueries({ queryKey: ["wa-inbox"] });
  };

  // export selected
  const handleExport = () => {
    const rows = sel.size>0
      ? filtered.filter(c=>sel.has(c.phone))
      : filtered;
    const data = rows.map(c=>({
      "رقم الهاتف": `+${c.phone}`,
      "الاسم":      c.name ?? "",
      "آخر رسالة":  c.lastText,
      "التاريخ":    fmtFull(c.lastAt),
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws["!cols"] = [{wch:18},{wch:24},{wch:40},{wch:22}];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "المحادثات");
    XLSX.writeFile(wb, "inbox.xlsx");
    toast.success(`تم تصدير ${rows.length} رقم`);
  };

  // import
  const handleImport = async () => {
    const phones = sel.size>0 ? [...sel] : filtered.map(c=>c.phone);
    if (phones.length===0) { toast.error("لا توجد أرقام"); return; }
    setImporting(true);
    try {
      const result = await splitImport(importName, phones);
      toast.success(result.groups===1
        ? `✅ تم استيراد ${result.count} رقم`
        : `✅ تم تقسيم ${result.count} رقم إلى ${result.groups} قوائم`);
      setShowImport(false);
      setSel(new Set());
      qc.invalidateQueries({ queryKey: ["contactGroups"] });
    } catch(e:any) { toast.error(e.message ?? "فشل"); }
    finally { setImporting(false); }
  };

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="flex h-screen overflow-hidden" dir="rtl">

      {/* ─── LEFT: Conversation list ─────────────────────────────── */}
      <div className={cn(
        "flex flex-col border-l border-border bg-sidebar",
        selected ? "w-80 flex-shrink-0 hidden sm:flex" : "flex-1 sm:w-80 sm:flex-shrink-0 sm:flex sm:flex-col"
      )}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <MessagesSquare className="w-4 h-4 text-primary"/>
              <span className="font-bold text-sm text-foreground">صندوق الوارد</span>
              <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full font-mono">
                {convs.length.toLocaleString("ar")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className={cn("flex items-center gap-1 text-[10px] px-2 py-1 rounded-full font-medium",
                connected ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400")}>
                {connected ? <Wifi className="w-2.5 h-2.5"/> : <WifiOff className="w-2.5 h-2.5"/>}
                {connected ? "متصل" : "غير متصل"}
              </div>
              <button onClick={()=>{refetch();}} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground">
                <RefreshCw className="w-3.5 h-3.5"/>
              </button>
            </div>
          </div>

          {/* Sync state bar */}
          {syncState && (
            <div className="flex items-center justify-between gap-1.5 px-0.5 py-1 rounded-lg bg-muted/40 border border-border/50 text-[10px]">
              <div className="flex items-center gap-2 px-1.5">
                {syncState.syncStatus === "complete" ? (
                  <CheckCircle2 className="w-2.5 h-2.5 text-green-400 shrink-0"/>
                ) : syncState.syncStatus === "syncing" ? (
                  <Loader2 className="w-2.5 h-2.5 text-yellow-400 animate-spin shrink-0"/>
                ) : (
                  <Database className="w-2.5 h-2.5 text-muted-foreground shrink-0"/>
                )}
                <span className="text-muted-foreground">
                  <span className="text-foreground font-mono">{syncState.db.conversations.toLocaleString("ar")}</span> محادثة ·{" "}
                  <span className="text-foreground font-mono">{syncState.db.threads.toLocaleString("ar")}</span> رسالة
                </span>
              </div>
              <button
                onClick={handleResync}
                disabled={resyncing}
                title="إعادة مزامنة"
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40">
                <RotateCcw className={cn("w-2.5 h-2.5", resyncing && "animate-spin")}/>
              </button>
            </div>
          )}

          {/* search */}
          <div className="relative">
            <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"/>
            <input
              value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="بحث..." dir="rtl"
              className="w-full bg-input border border-border rounded-lg pr-8 pl-3 py-2 text-xs outline-none focus:ring-1 focus:ring-primary"/>
          </div>

          {/* bulk actions row */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <button onClick={toggleAll}
              className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-xs hover:bg-accent transition-colors">
              {allSel ? <CheckSquare className="w-3 h-3 text-primary"/> : <Square className="w-3 h-3"/>}
              {allSel ? "إلغاء" : "تحديد الكل"}
            </button>
            {sel.size>0 && (
              <>
                <button onClick={()=>setShowBulkReply(v=>!v)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary text-xs border border-primary/20 hover:bg-primary/20 transition-colors">
                  <Send className="w-3 h-3"/>
                  رسالة ({sel.size})
                </button>
                <button onClick={handleExport}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-green-500/30 text-green-400 text-xs hover:bg-green-500/10 transition-colors">
                  <FileSpreadsheet className="w-3 h-3"/>
                  تصدير
                </button>
                <button onClick={()=>setShowImport(v=>!v)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-xs hover:bg-accent transition-colors">
                  <Import className="w-3 h-3"/>
                  استيراد
                </button>
                <button onClick={()=>setSel(new Set())}
                  className="p-1 rounded-md text-muted-foreground hover:text-foreground text-xs">
                  <X className="w-3 h-3"/>
                </button>
              </>
            )}
            {sel.size===0 && (
              <>
                <button onClick={handleExport}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-green-500/30 text-green-400 text-xs hover:bg-green-500/10 transition-colors">
                  <FileSpreadsheet className="w-3 h-3"/>
                  Excel
                </button>
                <button onClick={()=>setShowImport(v=>!v)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md border border-border text-xs hover:bg-accent transition-colors">
                  <Import className="w-3 h-3"/>
                  قائمة
                </button>
              </>
            )}
          </div>

          {/* bulk reply box */}
          {showBulkReply && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">إرسال لـ <span className="text-primary font-medium">{sel.size}</span> رقم محدد</p>
              <textarea
                value={bulkText} onChange={e=>setBulkText(e.target.value)}
                placeholder="اكتب الرسالة هنا..." dir="rtl" rows={3}
                className="w-full bg-input border border-border rounded-lg px-3 py-2 text-xs outline-none focus:ring-1 focus:ring-primary resize-none"/>
              <div className="flex gap-2">
                <button onClick={handleBulkSend} disabled={bulkSending||!bulkText.trim()}
                  className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
                  {bulkSending ? <RefreshCw className="w-3 h-3 animate-spin"/> : <Send className="w-3 h-3"/>}
                  {bulkSending ? "جاري الإرسال..." : "إرسال"}
                </button>
                <button onClick={()=>{setShowBulkReply(false);setBulkText("");}}
                  className="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-accent">
                  إلغاء
                </button>
              </div>
            </div>
          )}

          {/* import box */}
          {showImport && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                استيراد {sel.size>0 ? sel.size : filtered.length} رقم إلى قائمة
              </p>
              <div className="flex gap-2">
                <input value={importName} onChange={e=>setImportName(e.target.value)}
                  placeholder="اسم القائمة..."
                  className="flex-1 bg-input border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"/>
                <button onClick={handleImport} disabled={importing}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 disabled:opacity-50">
                  {importing ? "..." : "حفظ"}
                </button>
                <button onClick={()=>setShowImport(false)}
                  className="px-2 py-1.5 rounded-md border border-border text-xs hover:bg-accent">
                  <X className="w-3 h-3"/>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Conversations */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground">
              <RefreshCw className="w-4 h-4 animate-spin"/>
              <span className="text-xs">جاري التحميل...</span>
            </div>
          ) : filtered.length===0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <MessagesSquare className="w-10 h-10 opacity-20"/>
              <p className="text-xs text-center px-4">
                {!connected ? "قم بربط الواتساب لعرض المحادثات" : "لا توجد محادثات بعد"}
              </p>
            </div>
          ) : (
            filtered.map(c => {
              const isOpen = selected===c.phone;
              const isSel  = sel.has(c.phone);
              const initial = (c.name?.[0] ?? c.phone[0])?.toUpperCase();
              return (
                <div key={c.phone}
                  className={cn(
                    "flex items-start gap-2.5 px-3 py-3 cursor-pointer border-b border-border/50 transition-colors",
                    isOpen ? "bg-primary/10 border-r-2 border-r-primary" :
                    isSel  ? "bg-primary/5" : "hover:bg-muted/40"
                  )}>
                  {/* checkbox */}
                  <button onClick={e=>{e.stopPropagation();toggleOne(c.phone);}}
                    className="mt-1 flex-shrink-0">
                    <div className={cn("w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors",
                      isSel ? "bg-primary border-primary" : "border-border hover:border-primary")}>
                      {isSel && <CheckCheck className="w-2 h-2 text-white"/>}
                    </div>
                  </button>
                  {/* avatar */}
                  <div onClick={()=>setSelected(isOpen?null:c.phone)} className="flex items-start gap-2.5 flex-1 min-w-0">
                    <div className="w-9 h-9 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold flex-shrink-0">
                      {initial}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <span className="text-xs font-semibold text-foreground truncate">
                          {c.name ?? `+${c.phone}`}
                        </span>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">{fmtTime(c.lastAt)}</span>
                      </div>
                      {c.name && (
                        <p className="text-[10px] text-muted-foreground font-mono mb-0.5" dir="ltr">+{c.phone}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground truncate">{c.lastText || "—"}</p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ─── RIGHT: Chat Thread ───────────────────────────────────── */}
      {selected && openConv ? (
        <div className="flex-1 flex flex-col min-w-0 bg-background">
          {/* Thread header */}
          <div className="flex items-center gap-3 px-5 py-3.5 border-b border-border bg-card">
            <button onClick={()=>setSelected(null)}
              className="sm:hidden p-1.5 rounded-md hover:bg-accent text-muted-foreground">
              <ChevronLeft className="w-4 h-4"/>
            </button>
            <div className="w-10 h-10 rounded-full bg-primary/15 text-primary flex items-center justify-center text-sm font-bold flex-shrink-0">
              {(openConv.name?.[0] ?? openConv.phone[0])?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-foreground truncate">
                {openConv.name ?? `+${openConv.phone}`}
              </p>
              <p className="text-[11px] text-muted-foreground font-mono" dir="ltr">+{openConv.phone}</p>
            </div>
            <div className="flex items-center gap-2">
              {leadCard?.card && (
                <span className={cn("text-[10px] px-2 py-0.5 rounded-full border",
                  leadCard.card.stage >= 7 ? "border-primary/40 text-primary" : leadCard.card.stage >= 5 ? "border-orange-500/40 text-orange-400" : "border-border text-muted-foreground")}
                  title={[leadCard.card.licence, leadCard.card.activity, leadCard.card.size, leadCard.card.pain].filter(Boolean).join(" · ")}>
                  {leadCard.card.stage} · {(leadCard.stages ?? []).find((s: any) => s.n === leadCard.card.stage)?.name ?? ""}
                </span>
              )}
              <button onClick={() => holdMut.mutate(!leadCard?.humanHeld)} disabled={holdMut.isPending}
                className={cn("text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                  leadCard?.humanHeld ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}
                title={leadCard?.humanHeld ? "البوت صامت في هذه المحادثة — اضغط لإعادتها للفريق" : "تولَّ المحادثة بنفسك: يصمت البوت والمتابعات 24 ساعة"}>
                {leadCard?.humanHeld ? "أنت تتولاها — أعِدها للفريق" : "أتولاها بنفسي"}
              </button>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground flex items-center gap-1">
                <Hash className="w-2.5 h-2.5"/>{openConv.msgCount} رسالة
              </span>
              <button onClick={()=>{refetchThread();}}
                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground">
                <RefreshCw className="w-3.5 h-3.5"/>
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-1">
            {thread.length===0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 opacity-50">
                <MessageSquare className="w-12 h-12"/>
                <p className="text-sm">لا توجد رسائل مسجّلة</p>
                <p className="text-xs text-center max-w-xs">الرسائل تُسجَّل بعد الاتصال بواتساب. الرسائل القديمة قبل الاتصال لا تظهر هنا.</p>
              </div>
            ) : (
              groupByDay(thread).map(group => (
                <div key={group.label}>
                  {/* day divider */}
                  <div className="flex items-center gap-3 my-4">
                    <div className="flex-1 h-px bg-border"/>
                    <span className="text-[10px] text-muted-foreground px-2 py-0.5 rounded-full border border-border bg-muted flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5"/>{group.label}
                    </span>
                    <div className="flex-1 h-px bg-border"/>
                  </div>
                  {/* messages */}
                  <div className="space-y-1.5">
                    {group.msgs.map(m => (
                      <div key={m.id} className={cn("flex", m.fromMe ? "justify-start" : "justify-end")}>
                        <div className={cn(
                          "max-w-[72%] px-3.5 py-2 rounded-2xl text-sm leading-relaxed shadow-sm",
                          m.fromMe
                            ? "bg-primary text-primary-foreground rounded-tr-sm"
                            : "bg-card border border-border text-foreground rounded-tl-sm"
                        )}>
                          <p style={{wordBreak:"break-word"}}>{m.text}</p>
                          <p className={cn("text-[10px] mt-1 text-end",
                            m.fromMe ? "text-primary-foreground/60" : "text-muted-foreground")}>
                            {fmtFull(m.createdAt)}
                            {m.fromMe && <CheckCheck className="inline w-3 h-3 mr-1 opacity-70"/>}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            <div ref={threadEndRef}/>
          </div>

          {/* Reply box */}
          <div className="p-3 border-t border-border bg-card">
            {!connected && (
              <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-red-500/10 text-red-400 text-xs">
                <WifiOff className="w-3.5 h-3.5 flex-shrink-0"/>
                واتساب غير متصل — قم بربط الواتساب لإرسال الرسائل
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={draftText}
                onChange={e=>{setDraftText(e.target.value);e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,140)+"px";}}
                onKeyDown={handleKeyDown}
                placeholder="اكتب رسالة... (Enter للإرسال، Shift+Enter لسطر جديد)"
                disabled={!connected || sending}
                dir="rtl"
                rows={1}
                className="flex-1 bg-input border border-border rounded-xl px-4 py-2.5 text-sm outline-none focus:ring-1 focus:ring-primary resize-none disabled:opacity-50 min-h-[42px] max-h-[140px]"
                style={{height:"42px"}}
              />
              <button onClick={handleSendVoice} disabled={!connected||!draftText.trim()||sending} title="أرسل النص كرسالة صوتية بصوت الحساب"
                className="w-10 h-10 flex-shrink-0 rounded-full border border-border text-muted-foreground flex items-center justify-center hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-40">
                <Mic className="w-4 h-4"/>
              </button>
              <button onClick={handleSend} disabled={!connected||!draftText.trim()||sending}
                className="w-10 h-10 flex-shrink-0 rounded-full bg-primary text-primary-foreground flex items-center justify-center hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                {sending ? <RefreshCw className="w-4 h-4 animate-spin"/> : <Send className="w-4 h-4"/>}
              </button>
            </div>
          </div>
        </div>
      ) : (
        // Empty state
        <div className="flex-1 hidden sm:flex flex-col items-center justify-center text-muted-foreground gap-4 bg-muted/10">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
            <MessagesSquare className="w-9 h-9 text-primary/40"/>
          </div>
          <div className="text-center">
            <p className="font-medium text-foreground mb-1">اختر محادثة</p>
            <p className="text-sm text-muted-foreground">انقر على أي محادثة لفتحها والرد عليها</p>
          </div>
          {!connected && (
            <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 text-red-400 text-sm border border-red-500/20">
              <WifiOff className="w-4 h-4"/>
              قم بربط الواتساب أولاً
            </div>
          )}
        </div>
      )}
    </div>
  );
}
