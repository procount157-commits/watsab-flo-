// ── قروبات العملاء ────────────────────────────────────────────────
// The owner's customer groups: every message kept and every file filed on the
// machine, and سارة beside them — she reads, understands each group, and
// suggests the reply. She does not send. The owner marks each suggestion
// right, wrong or edits it, and his own replies from the phone are scored
// against hers; the accuracy meter says when she would be ready to answer.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Brain, Check, CheckCircle2, Copy, Eye, EyeOff, FileText, FolderOpen, History, Image as ImageIcon, Loader2, MessageSquareText,
  Mic, Pencil, RefreshCw, Search, Sparkles, Users, X, Paperclip, Gauge, GraduationCap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { TrainingCenter } from "./GroupsTraining";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `${m} د`; const h = Math.round(m / 60); return h < 24 ? `${h} س` : `${Math.round(h / 24)} يوم`;
};
const time = (d: string) => new Date(d).toLocaleString("ar-AE", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const TYPE_ICON: Record<string, any> = { image: ImageIcon, document: FileText, voice: Mic, video: Paperclip, sticker: Paperclip };

export default function Groups() {
  const qc = useQueryClient();
  const { data: stats } = useQuery<any>({ queryKey: ["groups-stats"], queryFn: () => api("/api/groups/stats"), refetchInterval: 20_000 });
  const { data: groups = [], isLoading } = useQuery<any[]>({ queryKey: ["groups"], queryFn: () => api("/api/groups"), refetchInterval: 20_000 });
  const [sel, setSel] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [only, setOnly] = useState<"all" | "watched" | "pending">("all");
  const [page, setPage] = useState<"groups" | "training">("groups");
  const inv = () => { for (const k of ["groups", "groups-stats", "group"]) qc.invalidateQueries({ queryKey: [k] }); };
  const sync = useMutation({ mutationFn: () => api("/api/groups/sync", { method: "POST" }), onSuccess: (d: any) => { inv(); toast.success(`تزامن ${n(d.groups)} قروب من واتساب`); }, onError: (e: Error) => toast.error(e.message) });
  const watchAll = useMutation({ mutationFn: (watch: boolean) => api("/api/groups/watch-all", { method: "POST", body: JSON.stringify({ watch }) }), onSuccess: (d: any) => { inv(); toast.success(`${n(d.updated)} قروب`); } });

  const shown = useMemo(() => groups.filter((g) =>
    (only === "all" || (only === "watched" ? g.watch : g.pending > 0)) &&
    (!q.trim() || `${g.subject ?? ""} ${g.customer_name ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()))), [groups, q, only]);
  useEffect(() => { if (!sel && shown.length) setSel(shown[0].id); }, [shown, sel]);
  const acc = stats?.accuracy;

  return (
    <div className="p-6 space-y-4 max-w-[96rem]">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="text-2xl font-bold flex items-center gap-2"><Users className="w-6 h-6 text-primary" /> قروبات العملاء</h1>
          <p className="text-sm text-muted-foreground mt-1">👥 سارة تقرأ قروباتك وتتعلم من كل رسالة، تفهم كل عميل، وتقترح الرد — <b className="text-foreground">ولا ترسل شيئاً</b>. علّمها من «تدريب سارة». كل رسالة تُحفظ، وكل ملف يرسله العميل يُحفظ على جهازك في مجلد القروب.</p>
        </div>
        <button onClick={() => sync.mutate()} disabled={sync.isPending || !stats?.connected} className={ghost} title={stats?.connected ? "" : "واتساب غير متصل"}>{sync.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} زامن القروبات</button>
        <button onClick={() => watchAll.mutate(true)} className={primary}><Eye className="w-3.5 h-3.5" /> راقب كل قروبات العملاء</button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {[["القروبات", n(stats?.groups)], ["تحت المراقبة", n(stats?.watched)], ["رسائل محفوظة", n(stats?.messages), `${n(stats?.today)} اليوم`], ["ملفات محفوظة", n(stats?.files)], ["اقتراحات تنتظرك", n(acc?.pending)]].map(([l, v, sub]) => (
          <div key={l} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground">{l}</p><p className="text-xl font-bold leading-none mt-1.5">{v}</p>{sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}</div>
        ))}
        <div className={cn(card, "p-3", acc?.ready && "border-primary/50")}>
          <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Gauge className="w-3 h-3" /> دقة سارة (٣٠ يوماً)</p>
          <p className={cn("text-xl font-bold leading-none mt-1.5", acc?.ready ? "text-primary" : "")}>{acc?.decided ? `${acc.rate}%` : "—"}</p>
          <p className="text-[10px] text-muted-foreground mt-1">{acc?.ready ? "جاهزة للرد التلقائي" : acc?.decided ? `${n(acc.decided)} حكماً · تحتاج ${n(acc.needed)} أخرى` : "لم تُقيَّم بعد"}</p>
        </div>
      </div>

      <div className="flex gap-1 border-b border-card-border">
        {([["groups", "القروبات", Users], ["training", "تدريب سارة", GraduationCap]] as const).map(([k, l, Icon]) => (
          <button key={k} onClick={() => setPage(k)} className={cn("flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 -mb-px", page === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}><Icon className="w-4 h-4" /> {l}</button>
        ))}
      </div>

      {page === "training" ? <TrainingCenter groups={groups} /> : <>
      {stats?.folder && <p className="text-[11px] text-muted-foreground flex items-center gap-1.5"><FolderOpen className="w-3.5 h-3.5" /> الملفات والأرشيف على هذا الجهاز في: <code dir="ltr" className="text-foreground/80">{stats.folder}</code></p>}
      {stats && !stats.connected && <div className={cn(card, "p-3 text-xs border-yellow-500/40 text-yellow-400")}>واتساب غير متصل — القروبات تُحفظ حين يكون الرقم متصلاً.</div>}

      <div className="grid lg:grid-cols-[22rem_1fr] gap-4 items-start">
        <div className={cn(card, "overflow-hidden lg:sticky lg:top-4")}>
          <div className="p-2.5 border-b border-card-border space-y-2">
            <div className="relative"><Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground" /><input className={cn(input, "pr-8 text-xs")} placeholder="ابحث عن قروب" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="flex gap-1">
              {([["all", `الكل (${groups.length})`], ["watched", `تحت المراقبة (${groups.filter((g) => g.watch).length})`], ["pending", `تنتظر (${groups.filter((g) => g.pending > 0).length})`]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setOnly(k)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", only === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
              ))}
            </div>
          </div>
          <div className="max-h-[70vh] overflow-y-auto divide-y divide-card-border">
            {isLoading ? <div className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
              : !shown.length ? <p className="p-6 text-center text-xs text-muted-foreground">{groups.length ? "لا قروب يطابق." : "لا قروبات بعد — اضغط «زامن القروبات»، أو انتظر أول رسالة في أي قروب."}</p>
              : shown.map((g) => (
                <button key={g.id} onClick={() => setSel(g.id)} className={cn("w-full text-right p-3 flex gap-2.5 hover:bg-muted/30", sel === g.id && "bg-primary/10")}>
                  <div className={cn("w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-sm", g.watch ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}><Users className="w-4 h-4" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium truncate flex-1">{g.subject ?? "قروب"}</p>
                      {g.pending > 0 && <span className="text-[10px] px-1.5 rounded-full bg-yellow-500/20 text-yellow-400">{g.pending}</span>}
                      <span className="text-[10px] text-muted-foreground">{ago(g.last_message_at)}</span>
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">{g.last ? `${g.last.fromMe ? "أنت" : g.last.name ?? "عضو"}: ${g.last.text ?? `[${g.last.type}]`}` : `${n(g.participants)} عضو`}</p>
                    <p className="text-[10px] text-muted-foreground/70 mt-0.5">{n(g.messages)} رسالة · {n(g.files)} ملف{g.watch ? " · 👁 تحت المراقبة" : ""}</p>
                  </div>
                </button>
              ))}
          </div>
        </div>

        {sel ? <GroupView id={sel} onChanged={inv} /> : <div className={cn(card, "p-10 text-center text-sm text-muted-foreground")}>اختر قروباً.</div>}
      </div>
      </>}
    </div>
  );
}

// ── One group ────────────────────────────────────────────────────
function GroupView({ id, onChanged }: { id: number; onChanged: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["group", id], queryFn: () => api(`/api/groups/${id}/messages?limit=200`), refetchInterval: 15_000 });
  const [tab, setTab] = useState<"chat" | "files" | "about">("chat");
  const bottom = useRef<HTMLDivElement>(null);
  const inv = () => { qc.invalidateQueries({ queryKey: ["group", id] }); onChanged(); };
  const patch = useMutation({ mutationFn: (b: any) => api(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv, onError: (e: Error) => toast.error(e.message) });
  const profile = useMutation({ mutationFn: () => api(`/api/groups/${id}/profile`, { method: "POST" }), onSuccess: () => { inv(); toast.success("فهمت سارة القروب — الملف في «عن القروب»"); setTab("about"); }, onError: (e: Error) => toast.error(e.message) });
  const suggest = useMutation({ mutationFn: () => api(`/api/groups/${id}/suggest`, { method: "POST" }), onSuccess: (d: any) => { inv(); d.none ? toast.info(d.why) : toast.success(d.status === "skip" ? "سارة: آخر رسالة لا تحتاج رداً" : "كتبت سارة اقتراحاً"); }, onError: (e: Error) => toast.error(e.message) });
  const learn = useMutation({ mutationFn: () => api(`/api/groups/${id}/learn`, { method: "POST" }), onSuccess: (d: any) => { inv(); d.none ? toast.info("لا جديد تتعلمه — قرأت كل الرسائل") : toast.success(`قرأت ${n(d.read)} رسالة${d.lessons?.length ? ` وتعلّمت ${n(d.lessons.length)} درس` : ""}${d.profile ? " وحدّثت ملف القروب" : ""}`); }, onError: (e: Error) => toast.error(e.message) });
  const history = useMutation({ mutationFn: () => api(`/api/groups/${id}/history`, { method: "POST" }), onSuccess: () => { toast.success("طُلب سجل أقدم من واتساب — يصل خلال ثوانٍ"); setTimeout(inv, 8000); }, onError: (e: Error) => toast.error(e.message) });
  useEffect(() => { if (tab === "chat") bottom.current?.scrollIntoView({ block: "end" }); }, [data?.messages?.length, tab]);

  if (isLoading || !data) return <div className={cn(card, "p-10 text-center")}><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const g = data.group;
  const msgs: any[] = data.messages ?? [];
  const sugByTrigger = new Map<string, any[]>();
  for (const s of data.suggestions ?? []) { const k = s.trigger_message_id ?? s.triggerMessageId; if (k) sugByTrigger.set(k, [...(sugByTrigger.get(k) ?? []), s]); }
  const files = msgs.filter((m) => m.filePath);

  return (
    <div className={cn(card, "overflow-hidden")}>
      <div className="p-4 border-b border-card-border space-y-3">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-0">
            <p className="font-bold text-lg truncate">{g.subject ?? "قروب"}</p>
            <p className="text-[11px] text-muted-foreground">{n(g.participants)} عضو · {n(g.messages)} رسالة محفوظة · آخر نشاط {ago(g.lastMessageAt)}{g.profileAt ? ` · فُهم قبل ${ago(g.profileAt)}` : ""}{g.learnedAt ? ` · تعلّمت منه قبل ${ago(g.learnedAt)}` : ""}</p>
          </div>
          <button onClick={() => patch.mutate({ watch: !g.watch })} className={g.watch ? cn(ghost, "border-primary/50 text-primary") : primary}>{g.watch ? <><Eye className="w-3.5 h-3.5" /> تحت المراقبة</> : <><EyeOff className="w-3.5 h-3.5" /> ابدأ المراقبة والاقتراح</>}</button>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => profile.mutate()} disabled={profile.isPending} className={ghost}>{profile.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />} افهمي القروب</button>
          <button onClick={() => suggest.mutate()} disabled={suggest.isPending} className={ghost}>{suggest.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} اقترحي رداً الآن</button>
          <button onClick={() => learn.mutate()} disabled={learn.isPending} className={ghost} title="تقرأ ما وصل منذ آخر قراءة الآن، بدل انتظار هدوء القروب">{learn.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <GraduationCap className="w-3.5 h-3.5" />} تعلّمي من الجديد</button>
          <button onClick={() => history.mutate()} disabled={history.isPending} className={ghost}><History className="w-3.5 h-3.5" /> حمّل سجلاً أقدم</button>
          <label className="text-xs flex items-center gap-1.5 mr-auto text-muted-foreground"><input type="checkbox" checked={g.isCustomer} onChange={(e) => patch.mutate({ isCustomer: e.target.checked })} /> قروب عميل (تُحفظ ملفاته)</label>
        </div>
        <div className="flex gap-1 border-b border-card-border -mb-3">
          {([["chat", `المحادثة (${n(msgs.length)})`], ["files", `الملفات (${n(files.length)})`], ["about", "عن القروب"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} className={cn("px-3 py-2 text-xs border-b-2 -mb-px", tab === k ? "border-primary text-foreground" : "border-transparent text-muted-foreground")}>{l}</button>
          ))}
        </div>
      </div>

      {tab === "chat" && (
        <div className="max-h-[68vh] overflow-y-auto p-4 space-y-2 bg-background/30">
          {!msgs.length && <p className="text-center text-xs text-muted-foreground py-10">لا رسائل محفوظة بعد. الرسائل الجديدة تُحفظ تلقائياً؛ وللسابقة اضغط «حمّل سجلاً أقدم» بعد أول رسالة.</p>}
          {msgs.map((m) => {
            const Icon = TYPE_ICON[m.msgType];
            return (
              <div key={m.id}>
                <div className={cn("flex", m.fromMe ? "justify-start" : "justify-end")}>
                  <div className={cn("max-w-[75%] rounded-xl px-3 py-2 text-sm", m.fromMe ? "bg-primary/15 border border-primary/20" : "bg-muted/60 border border-card-border")}>
                    <p className="text-[10px] text-muted-foreground mb-0.5">{m.fromMe ? "أنت" : m.senderName || (m.senderPhone ? `+${m.senderPhone}` : "عضو")} · {time(m.createdAt)}</p>
                    {m.msgType !== "text" && (
                      <p className="text-xs flex items-center gap-1.5 text-muted-foreground">{Icon && <Icon className="w-3.5 h-3.5" />}
                        {m.filePath ? <a href={`${BASE}/api/groups/files/${m.id}`} className="text-primary underline">{m.fileName ?? "ملف"}</a> : m.fileName ?? ({ image: "صورة", voice: "تسجيل صوتي", video: "فيديو", sticker: "ملصق", document: "ملف" } as any)[m.msgType] ?? m.msgType}</p>
                    )}
                    {m.text && <p className="whitespace-pre-wrap leading-relaxed" dir="auto">{m.text}</p>}
                  </div>
                </div>
                {(sugByTrigger.get(m.messageId) ?? []).map((s) => <SuggestionCard key={s.id} s={s} onDone={inv} />)}
              </div>
            );
          })}
          <div ref={bottom} />
        </div>
      )}

      {tab === "files" && (
        <div className="p-4">
          <p className="text-[11px] text-muted-foreground mb-3 flex items-center gap-1.5"><FolderOpen className="w-3.5 h-3.5" /> على الجهاز: <code dir="ltr" className="text-foreground/80">{g.folder}</code></p>
          {!files.length ? <p className="text-xs text-muted-foreground py-6 text-center">لا ملفات محفوظة بعد — كل صورة أو ملف يرسله العميل من الآن يُحفظ هنا تلقائياً.</p> : (
            <div className="divide-y divide-card-border">{[...files].reverse().map((m) => (
              <a key={m.id} href={`${BASE}/api/groups/files/${m.id}`} className="flex items-center gap-3 py-2.5 hover:bg-muted/20 px-1">
                {m.msgType === "image" ? <ImageIcon className="w-4 h-4 text-muted-foreground" /> : <FileText className="w-4 h-4 text-muted-foreground" />}
                <span className="text-sm flex-1 truncate" dir="auto">{m.fileName}</span>
                <span className="text-[11px] text-muted-foreground">{m.fromMe ? "أنت" : m.senderName ?? ""} · {time(m.createdAt)}</span>
              </a>
            ))}</div>
          )}
        </div>
      )}

      {tab === "about" && <About g={g} onSave={(b) => patch.mutate(b)} onProfile={() => profile.mutate()} busy={profile.isPending} />}
    </div>
  );
}

function About({ g, onSave, onProfile, busy }: { g: any; onSave: (b: any) => void; onProfile: () => void; busy: boolean }) {
  const [name, setName] = useState(g.customerName ?? "");
  const [notes, setNotes] = useState(g.notes ?? "");
  return (
    <div className="p-4 space-y-4">
      <div className="grid md:grid-cols-2 gap-3">
        <label className="text-[11px] text-muted-foreground">اسم العميل / الشركة<input className={cn(input, "mt-1")} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: النور العقارية" /></label>
        <label className="text-[11px] text-muted-foreground">ملاحظات لسارة عن هذا العميل<textarea className={cn(input, "mt-1 min-h-[2.6rem] text-xs")} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="مثلاً: يفضل الرد بالإنجليزية، المسؤول عنه أحمد، عقده يشمل VAT فقط" /></label>
      </div>
      <button onClick={() => onSave({ customerName: name, notes })} className={primary}><CheckCircle2 className="w-3.5 h-3.5" /> احفظ</button>
      <div className="rounded-lg border border-card-border p-3">
        <div className="flex items-center gap-2 mb-2"><Brain className="w-4 h-4 text-primary" /><p className="text-sm font-semibold">ما فهمته سارة عن القروب</p>
          <button onClick={onProfile} disabled={busy} className={cn(ghost, "mr-auto")}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} {g.profile ? "حدّثي الفهم" : "افهمي القروب"}</button></div>
        {g.profile ? <pre className="whitespace-pre-wrap text-xs leading-relaxed font-sans text-foreground/90" dir="auto">{g.profile}</pre>
          : <p className="text-xs text-muted-foreground">لم تقرأه بعد. تحتاج ٥ رسائل محفوظة على الأقل.</p>}
      </div>
    </div>
  );
}

// ── A suggestion, under the message it answers ───────────────────
function SuggestionCard({ s, onDone }: { s: any; onDone: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const fb = useMutation({
    mutationFn: (b: any) => api(`/api/groups/suggestions/${s.id}/feedback`, { method: "POST", body: JSON.stringify(b) }),
    onSuccess: () => { setEdit(null); onDone(); toast.success("تعلّمت سارة من حكمك"); }, onError: (e: Error) => toast.error(e.message),
  });
  const status = s.status;
  const skip = status === "skip";
  const decided = ["correct", "edited", "wrong", "answered"].includes(status);
  const label: Record<string, [string, string]> = {
    pending: ["تنتظر حكمك", "text-yellow-400"], skip: ["رأت أنها لا تحتاج رداً", "text-muted-foreground"], correct: ["صحيح ✓", "text-primary"],
    edited: ["عدّلته أنت", "text-blue-400"], wrong: ["خطأ ✗", "text-red-400"], answered: ["رددت أنت من الهاتف", "text-blue-400"], expired: ["تجاوزه الحديث", "text-muted-foreground"],
  };
  const [lt, lc] = label[status] ?? [status, ""];
  return (
    <div className="flex justify-start my-1.5">
      <div className={cn("max-w-[80%] w-full rounded-xl border p-3 text-sm", skip ? "border-dashed border-card-border bg-transparent" : "border-primary/30 bg-primary/5")}>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-xs">👥</span><p className="text-[11px] font-semibold">اقتراح سارة</p>
          <span className={cn("text-[10px]", lc)}>{lt}</span>
          {s.matchScore != null && status === "answered" && <span className="text-[10px] text-muted-foreground">تطابق مع ردك {Math.round(s.matchScore * 100)}%</span>}
          <span className="text-[10px] text-muted-foreground mr-auto">{ago(s.createdAt)}</span>
        </div>
        {edit === null ? <p className={cn("whitespace-pre-wrap leading-relaxed", skip && "text-muted-foreground text-xs")} dir="auto">{s.suggestion}</p>
          : <textarea className={cn(input, "min-h-[5rem] text-sm")} value={edit} onChange={(e) => setEdit(e.target.value)} dir="auto" autoFocus />}
        {s.reason && <p className="text-[10px] text-muted-foreground mt-1.5"><MessageSquareText className="w-3 h-3 inline ml-1" />{s.reason}</p>}
        {(status === "answered" || status === "edited") && s.ownerReply && <p className="text-[11px] mt-2 rounded-md bg-muted/50 p-2" dir="auto"><b>ردّك:</b> {s.ownerReply}</p>}
        {!decided && !skip && (
          <div className="flex gap-1.5 mt-2.5 flex-wrap">
            {edit === null ? <>
              <button onClick={() => fb.mutate({ verdict: "correct" })} disabled={fb.isPending} className={cn(ghost, "py-1.5 text-primary border-primary/40")}><Check className="w-3 h-3" /> صحيح</button>
              <button onClick={() => setEdit(s.suggestion)} className={cn(ghost, "py-1.5")}><Pencil className="w-3 h-3" /> عدّل وعلّمها</button>
              <button onClick={() => { const note = prompt("ما الخطأ؟ (اختياري — تحفظه سارة كتعليمات)") ?? undefined; fb.mutate({ verdict: "wrong", note: note || undefined }); }} disabled={fb.isPending} className={cn(ghost, "py-1.5 text-red-400")}><X className="w-3 h-3" /> خطأ</button>
              <button onClick={() => { navigator.clipboard.writeText(s.suggestion); toast.success("نُسخ — الصقه في واتساب"); }} className={cn(ghost, "py-1.5 mr-auto")}><Copy className="w-3 h-3" /> نسخ</button>
            </> : <>
              <button onClick={() => fb.mutate({ verdict: "edited", text: edit })} disabled={fb.isPending || !edit.trim()} className={cn(primary, "py-1.5")}><CheckCircle2 className="w-3 h-3" /> احفظ الرد الصحيح</button>
              <button onClick={() => setEdit(null)} className={cn(ghost, "py-1.5")}>إلغاء</button>
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
