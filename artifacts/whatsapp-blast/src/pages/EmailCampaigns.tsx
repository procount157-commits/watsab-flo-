// ── Email campaigns ───────────────────────────────────────────────
// A campaign is built in three steps on one screen: who it goes to (a list,
// a whole folder, or a saved audience — each with how many it will reach),
// the message (written by نورة, taken from a template, or by hand, with the
// email as it will arrive beside the editor), and how it goes out (a subject
// test, now, or at a set time). A test copy can go to the owner first.
// Below the builder, every campaign as a card with its progress and rates.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Copy, Eye, Folder, Inbox, List, Loader2, Megaphone, MousePointerClick, Pause, Pencil, Play, Plus, Reply,
  Send, Sparkles, Trash2, Users, X, Clock, FlaskConical, CheckCircle2, ChevronDown, ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { useFolders } from "@/components/Folders";
import { useEmailLists } from "./EmailLists";
import { EmailEditor } from "@/components/EmailEditor";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const pct = (part?: number, whole?: number) => (whole ? Math.round(((part ?? 0) / whole) * 100) : 0);
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `${m}د`; const h = Math.round(m / 60); return h < 24 ? `${h}س` : `${Math.round(h / 24)}ي`;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "border-card-border text-muted-foreground" },
  scheduled: { label: "مجدولة", cls: "border-blue-500/40 text-blue-400" },
  sending: { label: "تُرسل الآن", cls: "border-primary/50 text-primary bg-primary/10" },
  paused: { label: "متوقفة", cls: "border-yellow-500/40 text-yellow-400" },
  completed: { label: "اكتملت", cls: "border-green-500/40 text-green-400" },
};

type Target = { kind: "list" | "folder" | "segment"; id: number } | null;
type Form = {
  id?: number; name: string; target: Target; subject: string; subjectB: string; abPct: number; abWaitHours: number;
  html: string; when: "draft" | "now" | "later"; at: string;
};
const blank = (target: Target = null): Form => ({ name: "", target, subject: "", subjectB: "", abPct: 20, abWaitHours: 4, html: "", when: "now", at: "" });

export function Campaigns({ initialListId, onUsedInitial }: { initialListId?: number | null; onUsedInitial?: () => void }) {
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery<any[]>({ queryKey: ["email-campaigns"], queryFn: () => api("/api/email/campaigns"), refetchInterval: 10_000 });
  const [form, setForm] = useState<Form | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<string>("");
  const inv = () => { qc.invalidateQueries({ queryKey: ["email-campaigns"] }); qc.invalidateQueries({ queryKey: ["email-overview"] }); };

  // Arrived from a list's "campaign" button: the builder opens on that list.
  useEffect(() => {
    if (initialListId) { setForm(blank({ kind: "list", id: initialListId })); onUsedInitial?.(); }
  }, [initialListId]);

  const start = useMutation({ mutationFn: (id: number) => api(`/api/email/campaigns/${id}/start`, { method: "POST" }), onSuccess: (d: any) => { inv(); toast.success(`بدأت — ${n(d.queued)} رسالة في الطابور${d.skipped ? ` · ${n(d.skipped)} تُخطّوا (ألغوا أو ارتدّوا)` : ""}`); }, onError: (e: Error) => toast.error(e.message) });
  const pause = useMutation({ mutationFn: (id: number) => api(`/api/email/campaigns/${id}/pause`, { method: "POST" }), onSuccess: () => { inv(); toast.success("أُوقفت — ما في الطابور ينتظر"); } });
  const dup = useMutation({ mutationFn: (id: number) => api(`/api/email/campaigns/${id}/duplicate`, { method: "POST" }), onSuccess: () => { inv(); toast.success("نُسخت كمسودة"); } });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/email/campaigns/${id}`, { method: "DELETE" }), onSuccess: inv });
  const test = useMutation({ mutationFn: (id: number) => api(`/api/email/campaigns/${id}/test`, { method: "POST", body: JSON.stringify({}) }), onSuccess: (d: any) => toast.success(`أُرسلت نسخة تجربة إلى ${d.to}`), onError: (e: Error) => toast.error(e.message) });

  const sum = useMemo(() => {
    const sent = rows.reduce((t, c) => t + (c.sentCount ?? 0), 0);
    return { count: rows.length, live: rows.filter((c) => c.status === "sending").length, sent,
      open: pct(rows.reduce((t, c) => t + (c.openCount ?? 0), 0), sent), reply: rows.reduce((t, c) => t + (c.replyCount ?? 0), 0) };
  }, [rows]);
  const shown = filter ? rows.filter((c) => c.status === filter) : rows;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[["الحملات", n(sum.count)], ["تُرسل الآن", n(sum.live), sum.live ? "text-primary" : ""], ["رسائل أُرسلت", n(sum.sent)], ["متوسط الفتح", `${sum.open}%`, "text-blue-400"], ["ردود", n(sum.reply), "text-green-400"]].map(([l, v, tone]) => (
          <div key={l} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground">{l}</p><p className={cn("text-xl font-bold leading-none mt-1.5", tone)}>{v}</p></div>
        ))}
      </div>

      {!form && <CreatorPanel />}

      {form ? <Builder form={form} setForm={setForm} onDone={() => { setForm(null); inv(); }} /> : (
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex gap-1 flex-wrap">
            {[["", "الكل"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
              <button key={k} onClick={() => setFilter(k)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", filter === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground")}>
                {label}{k ? ` (${rows.filter((c) => c.status === k).length})` : ""}
              </button>
            ))}
          </div>
          <button onClick={() => setForm(blank())} className={cn(primary, "mr-auto")}><Plus className="w-3.5 h-3.5" /> حملة جديدة</button>
        </div>
      )}

      {isLoading ? <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      : !rows.length && !form ? (
        <div className={cn(card, "py-16 text-center")}>
          <Megaphone className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="font-medium">لا حملات بعد</p>
          <p className="text-sm text-muted-foreground mt-1">اختر قائمة أو مجلداً، ودع نورة تكتب الرسالة — وأرسل لنفسك نسخة تجربة قبل الإطلاق.</p>
          <button onClick={() => setForm(blank())} className={cn(primary, "mx-auto mt-4")}><Plus className="w-3.5 h-3.5" /> أنشئ أول حملة</button>
        </div>
      ) : (
        <div className="space-y-2.5">
          {shown.map((c) => {
            const st = STATUS[c.status] ?? { label: c.status, cls: "border-card-border" };
            const done = c.sentCount ?? 0, total = Math.max(c.audience ?? 0, done + (c.queued ?? 0));
            const editable = ["draft", "scheduled", "paused"].includes(c.status);
            return (
              <div key={c.id} className={cn(card, "p-4", c.status === "sending" && "border-primary/40")}>
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-[14rem]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold">{c.name}</p>
                      <span className={cn("text-[10px] px-2 py-0.5 rounded-full border", st.cls)}>{c.status === "sending" && <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse ml-1" />}{st.label}</span>
                      {c.subjectB && <span className="text-[10px] px-2 py-0.5 rounded-full border border-purple-500/40 text-purple-400 flex items-center gap-1"><FlaskConical className="w-3 h-3" /> اختبار عنوان{c.abWinner ? ` · فاز ${c.abWinner}` : ""}</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 truncate">«{c.subject}» · إلى {c.listName ?? "—"} · {c.status === "scheduled" && c.scheduledAt ? `تبدأ ${new Date(c.scheduledAt).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}` : `أُنشئت ${ago(c.createdAt)}`}</p>
                  </div>
                  <div className="flex gap-1.5 flex-wrap">
                    {editable && <button onClick={() => start.mutate(c.id)} disabled={start.isPending} className={primary}><Play className="w-3 h-3" /> {c.status === "paused" ? "استأنف" : "ابدأ"}</button>}
                    {c.status === "sending" && <button onClick={() => pause.mutate(c.id)} className={ghost}><Pause className="w-3 h-3" /> أوقف</button>}
                    {editable && <button onClick={() => setForm({ ...blank(), id: c.id, name: c.name, subject: c.subject, subjectB: c.subjectB ?? "", abPct: c.abPct || 20, abWaitHours: c.abWaitHours ?? 4, html: c.html, target: c.listId ? { kind: "list", id: c.listId } : c.segmentId ? { kind: "segment", id: c.segmentId } : null, when: "draft" })} className={ghost} title="تعديل"><Pencil className="w-3 h-3" /></button>}
                    <button onClick={() => test.mutate(c.id)} disabled={test.isPending} className={ghost} title="أرسل نسخة تجربة لبريدي"><Send className="w-3 h-3" /></button>
                    <button onClick={() => dup.mutate(c.id)} className={ghost} title="نسخ كمسودة"><Copy className="w-3 h-3" /></button>
                    <button onClick={() => confirm(`حذف حملة «${c.name}»؟`) && del.mutate(c.id)} className={cn(ghost, "hover:text-red-400")} title="حذف"><Trash2 className="w-3 h-3" /></button>
                  </div>
                </div>

                <div className="mt-3 grid md:grid-cols-[1fr_auto] gap-3 items-center">
                  <div>
                    <div className="flex justify-between text-[10px] text-muted-foreground mb-1"><span>أُرسل {n(done)} من {n(total)}</span>{c.queued > 0 && <span>{n(c.queued)} في الطابور</span>}</div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden" dir="ltr"><div className={cn("h-full transition-all", c.status === "completed" ? "bg-green-500" : "bg-primary")} style={{ width: `${pct(done, total)}%` }} /></div>
                  </div>
                  <div className="flex gap-4 text-center">
                    {[["فتح", pct(c.openCount, done), "text-blue-400", Eye], ["نقر", pct(c.clickCount, done), "", MousePointerClick], ["ردّ", pct(c.replyCount, done), "text-green-400", Reply], ["ارتداد", pct(c.bounceCount, done), (c.bounceCount && pct(c.bounceCount, done) >= 3) ? "text-red-400" : "text-muted-foreground", X]].map(([l, v, tone, Icon]: any) => (
                      <div key={l}><p className={cn("text-sm font-bold flex items-center gap-1 justify-center", tone)}><Icon className="w-3 h-3" />{v}%</p><p className="text-[10px] text-muted-foreground">{l}</p></div>
                    ))}
                  </div>
                </div>
                {c.pauseReason && <p className="text-[11px] text-yellow-400 mt-2">{c.pauseReason}</p>}
                <button onClick={() => setOpen(open === c.id ? null : c.id)} className="mt-2 text-[11px] text-muted-foreground hover:text-primary flex items-center gap-1">
                  {open === c.id ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} {open === c.id ? "إخفاء التفاصيل" : "التفاصيل والمستلمون"}
                </button>
                {open === c.id && <CampaignDetail id={c.id} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── The builder ──────────────────────────────────────────────────
function Builder({ form, setForm, onDone }: { form: Form; setForm: (f: Form | null) => void; onDone: () => void }) {
  const { data: lists = [] } = useEmailLists();
  const { data: folderData } = useFolders("email");
  const { data: segs = [] } = useQuery<any[]>({ queryKey: ["email-segments"], queryFn: () => api("/api/email/segments") });
  const { data: templates = [] } = useQuery<any[]>({ queryKey: ["email-templates"], queryFn: () => api("/api/email/templates") });
  const [tab, setTab] = useState<"list" | "folder" | "segment">(form.target?.kind ?? "list");
  const [busy, setBusy] = useState<"save" | "test" | "write" | null>(null);
  const [goal, setGoal] = useState("");
  const [writing, setWriting] = useState(false);
  const set = (p: Partial<Form>) => setForm({ ...form, ...p });
  const editing = !!form.id;

  const folders: any[] = folderData?.folders ?? [];
  const folderSendable = (fid: number) => lists.filter((l) => l.folderId === fid).reduce((t, l) => t + l.sendable, 0);
  const choices = tab === "list" ? lists.map((l) => ({ id: l.id, name: l.name, count: l.sendable, sub: l.sector ?? `${n(l.count)} عنوان` }))
    : tab === "folder" ? folders.map((f) => ({ id: f.id, name: f.name, count: folderSendable(f.id), sub: `${lists.filter((l) => l.folderId === f.id).length} قوائم` }))
    : segs.map((s) => ({ id: s.id, name: s.name, count: s.sendable, sub: s.description }));
  const chosen = form.target ? (form.target.kind === "list" ? lists.find((l) => l.id === form.target!.id)?.name : form.target.kind === "folder" ? folders.find((f) => f.id === form.target!.id)?.name : segs.find((s) => s.id === form.target!.id)?.name) : null;
  const reach = form.target ? (form.target.kind === "list" ? lists.find((l) => l.id === form.target!.id)?.sendable : form.target.kind === "folder" ? folderSendable(form.target.id) : segs.find((s) => s.id === form.target!.id)?.sendable) ?? 0 : 0;
  const audienceFilter = () => !form.target ? {} : form.target.kind === "list" ? { listIds: [form.target.id] } : form.target.kind === "folder" ? { folderIds: [form.target.id] } : (segs.find((s) => s.id === form.target!.id)?.filter ?? {});

  const write = async () => {
    if (!form.target) { toast.error("اختر الجمهور أولاً — نورة تكتب لمن ستصله الرسالة"); return; }
    if (!goal.trim()) { toast.error("اكتب هدف الرسالة"); return; }
    setBusy("write");
    try {
      const d = await api("/api/email/agent/write", { method: "POST", body: JSON.stringify({ filter: audienceFilter(), goal }) });
      set({ subject: d.draft.subjects?.[0] ?? form.subject, subjectB: d.draft.subjects?.[1] ?? "", html: d.draft.html, name: form.name });
      setWriting(false);
      toast.success(`كتبت نورة الرسالة وعنوانين لاختبارهما${d.draft.why ? ` — ${d.draft.why.slice(0, 120)}` : ""}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };

  // Saves (creates or updates) and returns the campaign's id.
  const save = async (): Promise<number> => {
    if (!form.target) throw new Error("اختر لمن تُرسل الحملة");
    if (!form.subject.trim() || !form.html.trim()) throw new Error("العنوان والرسالة مطلوبان");
    // A name from the subject, without its merge fields: "{{company}} — …" reads as "— …" otherwise.
    const name = form.name.trim() || form.subject.replace(/\{\{[^}]*\}\}/g, "").replace(/^[\s—–\-:،,]+/, "").trim().slice(0, 80) || "حملة";
    const common = { name, subject: form.subject, html: form.html, subjectB: form.subjectB.trim() || null, abPct: form.subjectB.trim() ? form.abPct : 0, abWaitHours: form.abWaitHours };
    if (form.id) {
      await api(`/api/email/campaigns/${form.id}`, { method: "PATCH", body: JSON.stringify({ ...common, ...(form.target.kind === "list" ? { listId: form.target.id } : {}) }) });
      return form.id;
    }
    const target = form.target.kind === "list" ? { listId: form.target.id } : form.target.kind === "folder" ? { folderId: form.target.id } : { segmentId: form.target.id };
    const c = await api("/api/email/campaigns", { method: "POST", body: JSON.stringify({ ...common, ...target }) });
    setForm({ ...form, id: c.id, name });
    return c.id;
  };

  const finish = async () => {
    setBusy("save");
    try {
      const id = await save();
      if (form.when === "later") {
        if (!form.at) throw new Error("اختر موعد الإرسال");
        await api(`/api/email/campaigns/${id}`, { method: "PATCH", body: JSON.stringify({ scheduledAt: new Date(form.at).toISOString() }) });
        toast.success(`جُدولت — تبدأ ${new Date(form.at).toLocaleString("ar-AE", { dateStyle: "medium", timeStyle: "short" })}`);
      } else if (form.when === "now") {
        // Checked before launching, not after. Starting used to throw one
        // terse sentence and never named the commonest cause — a list that
        // exists and holds nobody who can be written to. The campaign is
        // saved either way, so a refusal costs the owner nothing but a click.
        const r = await api(`/api/email/campaigns/${id}/readiness`);
        if (!r.canPublish) {
          setBlocked(r);
          toast.error(r.verdict);
          return;
        }
        setBlocked(null);
        const d = await api(`/api/email/campaigns/${id}/start`, { method: "POST" });
        toast.success(`انطلقت — ${n(d.queued)} رسالة في الطابور، تُرسل بحصة الساعة وساعات العمل`);
      } else toast.success("حُفظت كمسودة");
      onDone();
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };
  // What stopped the last publish attempt, kept on screen until it is fixed.
  const [blocked, setBlocked] = useState<any>(null);

  const sendTest = async () => {
    setBusy("test");
    try { const id = await save(); const d = await api(`/api/email/campaigns/${id}/test`, { method: "POST", body: JSON.stringify({}) }); toast.success(`أُرسلت نسخة تجربة إلى ${d.to} — الحملة محفوظة كمسودة`); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };

  const step = (num: string, title: string, done: boolean) => (
    <div className="flex items-center gap-2 mb-3">
      <span className={cn("w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold", done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{done ? <CheckCircle2 className="w-3.5 h-3.5" /> : num}</span>
      <p className="font-semibold text-sm">{title}</p>
    </div>
  );

  return (
    <div className={cn(card, "border-primary/30")}>
      <div className="p-4 border-b border-card-border flex items-center gap-2">
        <Megaphone className="w-4 h-4 text-primary" />
        <p className="font-semibold">{editing ? "تعديل الحملة" : "حملة جديدة"}</p>
        <input className={cn(input, "max-w-xs mr-3")} placeholder="اسم الحملة (اختياري)" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        <button onClick={() => setForm(null)} className="mr-auto text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>

      {/* 1 — who */}
      <div className="p-4 border-b border-card-border">
        {step("١", "لمن؟", !!form.target)}
        {editing && form.target?.kind !== "list" ? (
          <p className="text-xs text-muted-foreground">الجمهور: <b className="text-foreground">{chosen ?? "—"}</b> (لا يتغير بعد الحفظ — انسخ الحملة لجمهور آخر)</p>
        ) : (<>
          <div className="flex gap-1 mb-3">
            {([["list", "قائمة", List], ["folder", "مجلد كامل", Folder], ["segment", "جمهور محفوظ", Users]] as const).map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)} disabled={editing && k !== "list"} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border disabled:opacity-30", tab === k ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}><Icon className="w-3.5 h-3.5" /> {label}</button>
            ))}
          </div>
          {!choices.length ? <p className="text-xs text-muted-foreground py-3">{tab === "list" ? "لا قوائم — ارفع ملفاً من تبويب «القوائم»." : tab === "folder" ? "لا مجلدات بريد بعد — أنشئها من تبويب «القوائم»." : "لا جماهير محفوظة — احفظ فلتراً من تبويب «الجمهور»."}</p> : (
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-56 overflow-y-auto">
              {choices.map((ch) => {
                const on = form.target?.kind === tab && form.target.id === ch.id;
                return (
                  <button key={ch.id} onClick={() => set({ target: { kind: tab, id: ch.id } })} disabled={!ch.count}
                    className={cn("text-right p-2.5 rounded-lg border transition-colors disabled:opacity-40", on ? "border-primary bg-primary/10" : "border-card-border hover:border-primary/40")}>
                    <p className="text-xs font-semibold truncate flex items-center gap-1.5">{tab === "folder" ? <Folder className="w-3 h-3" /> : tab === "list" ? <List className="w-3 h-3" /> : <Users className="w-3 h-3" />}{ch.name}</p>
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{n(ch.count)} قابل للإرسال · {ch.sub}</p>
                  </button>
                );
              })}
            </div>
          )}
        </>)}
        {form.target && <p className="text-xs mt-3">ستصل إلى <b className="text-primary text-sm">{n(reach)}</b> عنوان من «{chosen}» — من ألغى أو ارتدّ بريده يُستثنى تلقائياً.</p>}
      </div>

      {/* 2 — what */}
      <div className="p-4 border-b border-card-border">
        {step("٢", "الرسالة", !!(form.subject.trim() && form.html.trim()))}
        <div className="flex gap-2 flex-wrap mb-3">
          <button onClick={() => setWriting(!writing)} className={cn(ghost, writing && "border-primary text-primary")}><Sparkles className="w-3.5 h-3.5" /> نورة تكتبها</button>
          <select className={cn(input, "w-52 text-xs")} value="" onChange={(e) => { const t = templates.find((x) => String(x.id) === e.target.value); if (t) set({ subject: t.subject, html: t.html, name: form.name || t.name }); }}>
            <option value="">{templates.length ? "من قالب…" : "لا قوالب"}</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {writing && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 mb-3 space-y-2">
            <p className="text-xs text-muted-foreground">صف ما تريده من الرسالة — تكتبها نورة بصوت شركتك وبما تعرفه عن قطاع الجمهور، مع عنوانين لاختبارهما. لا يُرسل شيء.</p>
            <div className="flex gap-2">
              <input className={input} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="مثلاً: عرض فحص امتثال AML مجاني لشركات الوساطة العقارية قبل التفتيش" onKeyDown={(e) => { if (e.key === "Enter") void write(); }} />
              <button onClick={write} disabled={busy === "write"} className={primary}>{busy === "write" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} اكتبي</button>
            </div>
          </div>
        )}
        <div className="space-y-2">
          <div><label className="text-[11px] font-semibold block mb-1">العنوان / Subject</label><input className={input} value={form.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="{{company|Your company}} — is your AML framework inspection-ready?" /></div>
          <EmailEditor value={form.html} subject={form.subject} onChange={(html) => set({ html })} minHeight={340} />
          <p className="text-[10px] text-muted-foreground">التوقيع ورابط إلغاء الاشتراك وتصميم الشركة تُضاف تلقائياً. الزر يفتح واتساب برسالة جاهزة.</p>
        </div>
      </div>

      {/* 3 — how */}
      <div className="p-4 border-b border-card-border space-y-3">
        {step("٣", "الإرسال", true)}
        <div className="rounded-lg border border-card-border p-3 space-y-2">
          <p className="text-xs font-semibold flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5 text-purple-400" /> اختبار العنوان (اختياري)</p>
          <div className="grid md:grid-cols-[1fr_8rem_8rem] gap-2">
            <input className={input} value={form.subjectB} onChange={(e) => set({ subjectB: e.target.value })} placeholder="عنوان بديل — يأخذه نصف شريحة الاختبار" />
            <label className="text-[10px] text-muted-foreground">الشريحة %<input type="number" min={5} max={50} className={input} value={form.abPct} onChange={(e) => set({ abPct: Number(e.target.value) })} /></label>
            <label className="text-[10px] text-muted-foreground">انتظار (ساعات)<input type="number" min={1} max={48} className={input} value={form.abWaitHours} onChange={(e) => set({ abWaitHours: Number(e.target.value) })} /></label>
          </div>
          {form.subjectB.trim() && <p className="text-[10px] text-muted-foreground">{form.abPct}% من الجمهور يُقسمون بين العنوانين، وبعد {form.abWaitHours} ساعات يُرسل الباقي بالعنوان الذي فُتح أكثر. لا اختبار لجمهور أقل من ٤٠.</p>}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          {([["now", "ابدأ الآن", Play], ["later", "جدولة", Clock], ["draft", "مسودة فقط", Pencil]] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => set({ when: k })} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border", form.when === k ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}><Icon className="w-3.5 h-3.5" /> {label}</button>
          ))}
          {form.when === "later" && <input type="datetime-local" className={cn(input, "w-56 text-xs")} value={form.at} onChange={(e) => set({ at: e.target.value })} />}
        </div>
        <p className="text-[10px] text-muted-foreground">الإرسال يتوزع بحصة الساعة واليوم وساعات العمل من الإعدادات، ويتوقف تلقائياً إن ارتفع الارتداد.</p>
      </div>

      {blocked && (
        <div className="px-4 pb-2">
          <div className="rounded-xl border border-red-500/40 bg-red-500/5 p-4">
            <p className="text-sm font-semibold text-red-300">{blocked.verdict}</p>
            <div className="mt-2.5 space-y-1.5">
              {blocked.checks.filter((c: any) => c.state !== "ok").map((c: any) => (
                <p key={c.id} className="text-[11px] leading-relaxed">
                  <span className={c.state === "blocked" ? "text-red-300 font-medium" : "text-yellow-400 font-medium"}>
                    {c.state === "blocked" ? "⛔" : "⚠️"} {c.title}:
                  </span>{" "}
                  <span className="text-muted-foreground">{c.detail}</span>
                  {c.fix && <span className="text-primary"> ← {c.fix}</span>}
                </p>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground mt-3">
              الحملة محفوظة كمسودة — أصلح ما سبق ثم اضغط «ابدأ الآن» مرة أخرى.
            </p>
          </div>
        </div>
      )}

      <div className="p-4 flex gap-2 flex-wrap items-center">
        <button onClick={finish} disabled={!!busy} className={primary}>
          {busy === "save" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : form.when === "now" ? <Play className="w-3.5 h-3.5" /> : form.when === "later" ? <Clock className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
          {form.when === "now" ? `احفظ وأطلق لـ ${n(reach)}` : form.when === "later" ? "احفظ وجدول" : "احفظ كمسودة"}
        </button>
        <button onClick={sendTest} disabled={!!busy} className={ghost}>{busy === "test" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} أرسل تجربة لبريدي</button>
        <button onClick={() => setForm(null)} className={cn(ghost, "mr-auto")}>إلغاء</button>
      </div>
    </div>
  );
}

// ── One campaign's numbers and recipients ────────────────────────
function CampaignDetail({ id }: { id: number }) {
  const { data } = useQuery<any>({ queryKey: ["email-campaign", id], queryFn: () => api(`/api/email/campaigns/${id}`), refetchInterval: 10_000 });
  const [q, setQ] = useState("");
  if (!data) return <Loader2 className="w-4 h-4 animate-spin mt-2 text-muted-foreground" />;
  const f = data.funnel ?? {};
  const recipients: any[] = (data.recipients ?? []).filter((r: any) => !q || `${r.toEmail} ${r.company ?? ""} ${r.name ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const SAR: Record<string, string> = { queued: "في الطابور", ab_hold: "ينتظر حسم الاختبار", sent: "أُرسلت", bounced: "ارتدّت", failed: "فشلت" };
  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-4 md:grid-cols-8 gap-2">
        {[["في الطابور", f.queued], ["أُرسل", f.sent], ["فُتح", f.opened], ["نقر", f.clicked], ["ردّ", f.replied], ["ارتدّ", f.bounced], ["فشل", f.failed], ["فتح %", `${pct(f.opened, f.sent)}%`]].map(([l, v]) => (
          <div key={String(l)} className="rounded-lg border border-card-border p-2"><p className="text-[10px] text-muted-foreground">{l}</p><p className="text-base font-bold leading-none mt-1">{typeof v === "number" ? n(v) : v ?? 0}</p></div>
        ))}
      </div>
      {data.ab && (
        <div className="rounded-lg border border-purple-500/30 p-3 text-xs space-y-1.5">
          <p className="font-semibold flex items-center gap-1.5"><FlaskConical className="w-3.5 h-3.5 text-purple-400" /> اختبار العنوان {data.ab.winner ? `— الفائز ${data.ab.winner}` : f.held ? `— ${n(f.held)} ينتظرون الحسم` : ""}</p>
          {(data.ab.variants ?? []).map((v: any) => (
            <div key={v.variant} className={cn("flex items-center gap-2", data.ab.winner === v.variant && "text-primary")}>
              <span className="w-4 font-bold">{v.variant}</span>
              <span className="flex-1 truncate">«{v.variant === "B" ? data.campaign.subjectB : data.campaign.subject}»</span>
              <span className="text-muted-foreground">أُرسل {n(v.sent)} · فتح {pct(v.opened, v.sent)}% · ردّ {n(v.replied)}</span>
            </div>
          ))}
        </div>
      )}
      <input className={cn(input, "text-xs")} placeholder="ابحث في المستلمين" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="max-h-72 overflow-y-auto rounded-lg border border-card-border"><table className="w-full text-[11px]"><thead className="sticky top-0 bg-card text-muted-foreground"><tr><th className="text-right p-1.5">إلى</th><th className="text-right p-1.5">الشركة</th><th className="text-right p-1.5">الحالة</th><th className="text-right p-1.5">أُرسل</th><th className="text-center p-1.5"><Eye className="w-3 h-3 inline" /></th><th className="text-center p-1.5"><MousePointerClick className="w-3 h-3 inline" /></th><th className="text-center p-1.5"><Reply className="w-3 h-3 inline" /></th></tr></thead>
        <tbody>{recipients.map((r) => <tr key={r.id} className="border-t border-card-border"><td className="p-1.5 font-mono" dir="ltr">{r.toEmail}</td><td className="p-1.5">{r.company ?? r.name ?? ""}</td><td className={cn("p-1.5", r.status === "bounced" || r.status === "failed" ? "text-red-400" : "")}>{SAR[r.status] ?? r.status}{r.error ? ` — ${String(r.error).slice(0, 60)}` : ""}</td><td className="p-1.5 text-muted-foreground">{ago(r.sentAt)}</td><td className="p-1.5 text-center text-blue-400">{r.openCount || ""}</td><td className="p-1.5 text-center">{r.clickCount || ""}</td><td className="p-1.5 text-center text-green-400">{r.repliedAt ? "✓" : ""}</td></tr>)}</tbody></table>
        {!recipients.length && <p className="p-4 text-center text-xs text-muted-foreground">لا مستلمين بعد — تظهر الرسائل هنا عند بدء الحملة.</p>}
      </div>
    </div>
  );
}

// ── طارق builds a campaign on request ────────────────────────────
function CreatorPanel() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: services = [] } = useQuery<any[]>({ queryKey: ["email-creator-services"], queryFn: () => api("/api/email/creator/services"), enabled: open });
  const { data: lists = [] } = useEmailLists();
  const { data: folderData } = useFolders("email");
  const { data: sectorList } = useQuery<any>({ queryKey: ["email-sectors"], queryFn: () => api("/api/email/sectors"), enabled: open });
  const folders: any[] = folderData?.folders ?? [];
  const [f, setF] = useState<{ service: string; language: string; kind: "sector" | "list" | "folder"; ids: Array<number | string>; take: number; notes: string }>({ service: "", language: "en", kind: "sector", ids: [], take: 150, notes: "" });
  const toggle = (id: number | string) => setF({ ...f, ids: f.ids.includes(id) ? f.ids.filter((x) => x !== id) : [...f.ids, id] });
  const create = useMutation({
    mutationFn: () => api("/api/email/creator", { method: "POST", body: JSON.stringify({ service: f.service, language: f.language, take: f.take, notes: f.notes,
      ...(f.kind === "list" ? { listIds: f.ids } : f.kind === "folder" ? { folderIds: f.ids } : { sectors: f.ids }) }) }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["email-missions"] }); qc.invalidateQueries({ queryKey: ["email-dashboard"] }); setOpen(false);
      toast.success(`طارق يكتب الحملة الآن لـ ${n(d.audience)} شركة — ستجدها في «المهام» تنتظر موافقتك خلال دقيقة.`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const choices: Array<{ id: number | string; name: string }> = f.kind === "list" ? lists.filter((l: any) => !l.stage).map((l) => ({ id: l.id, name: `${l.name} (${n(l.sendable)})` }))
    : f.kind === "folder" ? folders.map((x) => ({ id: x.id, name: x.name })) : (sectorList?.sectors ?? []).map((x: string) => ({ id: x, name: x }));
  if (!open) return (
    <button onClick={() => setOpen(true)} className={cn(card, "w-full p-3.5 flex items-center gap-3 text-right hover:border-primary/50 transition-colors")}>
      <span className="text-2xl">🧩</span>
      <div className="flex-1"><p className="text-sm font-semibold">طارق — منشئ الحملات</p><p className="text-[11px] text-muted-foreground">اختر الخدمة والجمهور واللغة، ويبني حملة كاملة: عنوانين للاختبار، رسالة أولى، ومتابعتين — بأسلوب قوالب بروكاونت، وتنتظر موافقتك.</p></div>
      <span className={primary}><Sparkles className="w-3.5 h-3.5" /> أنشئ حملة</span>
    </button>
  );
  return (
    <div className={cn(card, "p-4 space-y-3 border-primary/40")}>
      <div className="flex items-center gap-2"><span className="text-xl">🧩</span><p className="font-semibold text-sm">طارق ينشئ حملة</p><button onClick={() => setOpen(false)} className="mr-auto text-muted-foreground"><X className="w-4 h-4" /></button></div>
      <div className="grid md:grid-cols-3 gap-3">
        <label className="text-[11px] text-muted-foreground">الخدمة<select className={cn(input, "mt-1")} value={f.service} onChange={(e) => setF({ ...f, service: e.target.value })}><option value="">اختر…</option>{services.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
        <label className="text-[11px] text-muted-foreground">اللغة<select className={cn(input, "mt-1")} value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">English</option><option value="ar">العربية</option><option value="both">الاثنتان</option></select></label>
        <label className="text-[11px] text-muted-foreground">حجم الموجة<input type="number" className={cn(input, "mt-1")} value={f.take} onChange={(e) => setF({ ...f, take: Math.max(10, Number(e.target.value) || 10) })} /></label>
      </div>
      <div>
        <div className="flex gap-1 mb-2">
          {([["sector", "قطاع", Users], ["list", "قائمة", List], ["folder", "مجلد", Folder]] as const).map(([k, l, Icon]) => (
            <button key={k} onClick={() => setF({ ...f, kind: k, ids: [] })} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border", f.kind === k ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}><Icon className="w-3.5 h-3.5" /> {l}</button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto">
          {!choices.length && <p className="text-[11px] text-muted-foreground">{f.kind === "sector" ? "…" : "لا شيء هنا بعد."}</p>}
          {choices.map((c) => <button key={String(c.id)} onClick={() => toggle(c.id)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", f.ids.includes(c.id) ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground")}>{c.name}</button>)}
        </div>
      </div>
      <textarea className={cn(input, "min-h-[4rem] text-xs")} placeholder="تعليمات إضافية لطارق (اختياري) — مثلاً: ركّز على الوكالات في دبي، واذكر استشارة مجانية لمدة ٢٠ دقيقة" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      <div className="flex gap-2 items-center">
        <button onClick={() => create.mutate()} disabled={!f.service || !f.ids.length || create.isPending} className={primary}>{create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} ابنِ الحملة</button>
        <p className="text-[10px] text-muted-foreground">لا يُرسل شيء — تجدها في «المهام» لتراجعها وتوافق.</p>
      </div>
    </div>
  );
}
