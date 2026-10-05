// ── Comments and messages: what came in, and what the team wrote back ──
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import { Check, CheckCheck, ExternalLink, Loader2, Pencil, Plus, Sparkles, Trash2, X, Eye, EyeOff, Search, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { card, ghost, primary, n, ago, PLATFORM_UI, type Platform } from "./SocialDesk";

const INTENT_AR: Record<string, string> = { question: "سؤال", interested: "مهتم", praise: "مديح", complaint: "شكوى", spam: "سبام", stop: "طلب التوقف", other: "أخرى" };

// ── Comments ─────────────────────────────────────────────────────
export function CommentsTab({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState("drafted");
  const [url, setUrl] = useState("");
  const { data: posts = [] } = useQuery<any[]>({ queryKey: ["social-posts", p], queryFn: () => api(`/api/social/${p}/posts`) });
  const { data } = useQuery<any>({ queryKey: ["social-comments", p, status], queryFn: () => api(`/api/social/${p}/comments?status=${status}`), refetchInterval: 30_000 });
  const inv = () => { for (const k of ["social-comments", "social-posts", "social"]) qc.invalidateQueries({ queryKey: [k, p] }); };
  const add = useMutation({ mutationFn: () => api(`/api/social/${p}/posts`, { method: "POST", body: JSON.stringify({ url }) }), onSuccess: () => { setUrl(""); inv(); toast.success("يراقبه الفريق من الجولة القادمة"); }, onError: (e: Error) => toast.error(e.message) });
  const watch = useMutation({ mutationFn: (x: any) => api(`/api/social/${p}/posts/${x.id}`, { method: "PATCH", body: JSON.stringify({ watching: !x.watching }) }), onSuccess: inv });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/social/${p}/posts/${id}`, { method: "DELETE" }), onSuccess: inv });
  const discover = useMutation({ mutationFn: () => api(`/api/social/${p}/discover`, { method: "POST" }), onSuccess: (d: any) => { inv(); toast.success(`أُضيف ${n(d.added)} منشوراً`); }, onError: (e: Error) => toast.error(e.message) });
  const approveAll = useMutation({ mutationFn: () => api(`/api/social/${p}/comments/approve-all`, { method: "POST" }), onSuccess: (d: any) => { inv(); toast.success(`اعتُمد ${n(d.approved)} رداً`); } });
  const counts = data?.counts ?? {};

  return (
    <div className="grid lg:grid-cols-[20rem_1fr] gap-4 items-start">
      <div className={cn(card, "overflow-hidden")}>
        <div className="p-3 border-b border-card-border space-y-2">
          <p className="text-sm font-semibold">المنشورات المراقَبة</p>
          <div className="flex gap-1.5"><input className={cn(input, "text-xs")} dir="ltr" placeholder="رابط منشور" value={url} onChange={(e) => setUrl(e.target.value)} /><button onClick={() => add.mutate()} disabled={!url.trim() || add.isPending} className={primary}><Plus className="w-3.5 h-3.5" /></button></div>
          <button onClick={() => discover.mutate()} disabled={discover.isPending} className={cn(ghost, "w-full justify-center")}>{discover.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />} أضف آخر منشوراتنا تلقائياً</button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-card-border">
          {!posts.length ? <p className="p-5 text-center text-xs text-muted-foreground">لا منشورات بعد. الفريق يضيف منشوراتك الجديدة بنفسه بعد تسجيل الدخول، أو الصق رابطاً.</p>
            : posts.map((x) => (
              <div key={x.id} className={cn("p-2.5 flex items-center gap-2 text-xs", !x.watching && "opacity-50")}>
                <a href={x.url} target="_blank" rel="noreferrer" className="flex-1 min-w-0 truncate text-primary" dir="ltr">{x.caption?.slice(0, 50) || x.externalId}</a>
                <span className="text-[10px] text-muted-foreground">{n(x.commentCount)} 💬</span>
                <button onClick={() => watch.mutate(x)} title={x.watching ? "أوقف المراقبة" : "راقب"}>{x.watching ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}</button>
                <button onClick={() => del.mutate(x.id)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
        </div>
      </div>

      <div className={card}>
        <div className="p-3 border-b border-card-border flex gap-1.5 flex-wrap items-center">
          {([["drafted", "تنتظر موافقتك"], ["approved", "معتمدة"], ["replied", "أُرسلت"], ["skipped", "بلا رد"], ["all", "الكل"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setStatus(k)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", status === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}{k !== "all" ? ` (${n(counts[k])})` : ""}</button>
          ))}
          {status === "drafted" && !!counts.drafted && <button onClick={() => approveAll.mutate()} className={cn(primary, "mr-auto")}><CheckCheck className="w-3.5 h-3.5" /> اعتمد الكل</button>}
        </div>
        <div className="divide-y divide-card-border max-h-[70vh] overflow-y-auto">
          {!(data?.rows ?? []).length ? <p className="p-10 text-center text-xs text-muted-foreground">لا شيء هنا.</p>
            : data.rows.map((c: any) => <CommentRow key={c.id} p={p} c={c} onDone={inv} />)}
        </div>
      </div>
    </div>
  );
}

function CommentRow({ p, c, onDone }: { p: Platform; c: any; onDone: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const approve = useMutation({ mutationFn: () => api(`/api/social/${p}/comments/${c.id}/approve`, { method: "POST", body: JSON.stringify({ draft: edit ?? undefined }) }), onSuccess: () => { setEdit(null); onDone(); } });
  const skip = useMutation({ mutationFn: () => api(`/api/social/${p}/comments/${c.id}/skip`, { method: "POST" }), onSuccess: onDone });
  return (
    <div className="p-3.5 space-y-2 text-sm">
      <div className="flex items-center gap-2 text-xs">
        <a href={c.authorUrl ?? "#"} target="_blank" rel="noreferrer" className="font-semibold" dir="ltr">@{c.author}</a>
        {c.intent && <span className="px-1.5 rounded bg-muted text-[10px]">{INTENT_AR[c.intent] ?? c.intent}</span>}
        {c.isLead && <span className="px-1.5 rounded bg-primary/15 text-primary text-[10px]">فرصة</span>}
        <span className="text-muted-foreground mr-auto">{ago(c.createdAt)}</span>
        {c.postUrl && <a href={c.postUrl} target="_blank" rel="noreferrer" className="text-muted-foreground"><ExternalLink className="w-3 h-3" /></a>}
      </div>
      <p className="whitespace-pre-wrap" dir="auto">{c.text}</p>
      {c.draft && (edit === null
        ? <p className="rounded-lg bg-primary/5 border border-primary/20 p-2.5 text-sm whitespace-pre-wrap" dir="auto"><span className="text-[10px] text-primary block mb-0.5">رد الفريق</span>{c.draft}</p>
        : <textarea className={cn(input, "min-h-[4rem]")} dir="auto" value={edit} onChange={(e) => setEdit(e.target.value)} autoFocus />)}
      {c.skipReason && c.status !== "drafted" && <p className="text-[11px] text-muted-foreground">{c.skipReason}</p>}
      {c.status === "drafted" && (
        <div className="flex gap-1.5">
          <button onClick={() => approve.mutate()} className={cn(primary, "py-1.5")}><Check className="w-3 h-3" /> {edit === null ? "اعتمد" : "احفظ واعتمد"}</button>
          {edit === null && <button onClick={() => setEdit(c.draft ?? "")} className={cn(ghost, "py-1.5")}><Pencil className="w-3 h-3" /> عدّل</button>}
          <button onClick={() => skip.mutate()} className={cn(ghost, "py-1.5")}><X className="w-3 h-3" /> بلا رد</button>
        </div>
      )}
    </div>
  );
}

// ── Messages ─────────────────────────────────────────────────────
export function InboxTab({ p }: { p: Platform }) {
  const [, params] = useRoute<{ id?: string }>(`/${p}/inbox/:id?`);
  const [, go] = useLocation();
  const [filter, setFilter] = useState("all");
  const { data: threads = [] } = useQuery<any[]>({ queryKey: ["social-threads", p, filter], queryFn: () => api(`/api/social/${p}/threads?filter=${filter}`), refetchInterval: 30_000 });
  const sel = Number(params?.id) || null;
  useEffect(() => { if (!sel && threads.length) go(`/${p}/inbox/${threads[0].id}`, { replace: true }); }, [threads, sel]);

  return (
    <div className="grid lg:grid-cols-[22rem_1fr] gap-4 items-start">
      <div className={cn(card, "overflow-hidden")}>
        <div className="p-2.5 border-b border-card-border flex gap-1 flex-wrap">
          {([["all", "الكل"], ["waiting", "تنتظر رداً"], ["outreach", "من تواصلنا"], ["hot", "حارّة"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setFilter(k)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", filter === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
          ))}
        </div>
        <div className="max-h-[70vh] overflow-y-auto divide-y divide-card-border">
          {!threads.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا محادثات بعد — يقرأ الفريق الوارد في كل جولة.</p>
            : threads.map((t) => (
              <button key={t.id} onClick={() => go(`/${p}/inbox/${t.id}`)} className={cn("w-full text-right p-3 hover:bg-muted/30 space-y-0.5", sel === t.id && "bg-primary/10")}>
                <div className="flex items-center gap-1.5 text-xs">
                  {t.temperature === "hot" && <span>🔥</span>}
                  <b className="truncate" dir="auto">{t.display_name || `@${t.handle}`}</b>
                  {t.origin === "outreach" && <span className="text-[9px] px-1.5 rounded bg-sky-500/15 text-sky-400">تواصلنا</span>}
                  {t.status === "stopped" && <span className="text-[9px] px-1.5 rounded bg-red-500/15 text-red-400">موقوفة</span>}
                  {t.drafts > 0 && <span className="text-[9px] px-1.5 rounded bg-yellow-500/20 text-yellow-400">رد ينتظرك</span>}
                  <span className="mr-auto text-[10px] text-muted-foreground">{ago(t.last_message_at)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground truncate" dir="auto">{t.last_text ?? ""}</p>
              </button>
            ))}
        </div>
      </div>
      {sel ? <Thread p={p} id={sel} /> : <div className={cn(card, "p-10 text-center text-sm text-muted-foreground")}>اختر محادثة.</div>}
    </div>
  );
}

function Thread({ p, id }: { p: Platform; id: number }) {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["social-thread", p, id], queryFn: () => api(`/api/social/${p}/threads/${id}`), refetchInterval: 20_000 });
  const [edit, setEdit] = useState<Record<number, string>>({});
  const inv = () => { for (const k of ["social-thread", "social-threads", "social"]) qc.invalidateQueries({ queryKey: [k, p] }); };
  const approve = useMutation({ mutationFn: (m: any) => api(`/api/social/${p}/messages/${m.id}/approve`, { method: "POST", body: JSON.stringify({ text: edit[m.id] }) }), onSuccess: () => { setEdit({}); inv(); toast.success("اعتُمد — يُرسل في الجولة القادمة"); } });
  const skip = useMutation({ mutationFn: (m: any) => api(`/api/social/${p}/messages/${m.id}/skip`, { method: "POST" }), onSuccess: inv });
  const redraft = useMutation({ mutationFn: () => api(`/api/social/${p}/threads/${id}/draft`, { method: "POST" }), onSuccess: () => { inv(); toast.success("كتب الفريق رداً جديداً"); }, onError: (e: Error) => toast.error(e.message) });
  const stop = useMutation({ mutationFn: () => api(`/api/social/${p}/threads/${id}/stop`, { method: "POST" }), onSuccess: () => { inv(); toast.success("لن يراسله الفريق مرة أخرى"); } });
  if (!data) return <div className={cn(card, "p-10 text-center")}><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const t = data.thread, tg = data.target;
  const KIND: Record<string, string> = { outreach: "رسالة أولى", followup: "متابعة", reply: "رد" };
  return (
    <div className={cn(card, "overflow-hidden")}>
      <div className="p-3.5 border-b border-card-border flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="font-semibold" dir="auto">{t.displayName || `@${t.handle}`} {t.temperature === "hot" ? "🔥" : t.temperature === "warm" ? "🌤" : ""}</p>
          <p className="text-[11px] text-muted-foreground">{t.origin === "outreach" ? "نحن بدأنا المحادثة" : t.origin === "comment" ? "انتقل من تعليق" : "هو راسلنا"}{t.intent ? ` · ${INTENT_AR[t.intent] ?? t.intent}` : ""}{tg?.headline ? ` · ${tg.headline}` : ""}</p>
        </div>
        <button onClick={() => redraft.mutate()} disabled={redraft.isPending || t.status === "stopped"} className={ghost}>{redraft.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} اكتب رداً جديداً</button>
        {t.status !== "stopped" && <button onClick={() => { if (confirm("لن يراسله الفريق مرة أخرى. متأكد؟")) stop.mutate(); }} className={cn(ghost, "text-red-400")}><Ban className="w-3.5 h-3.5" /> أوقف المراسلة</button>}
      </div>
      <div className="p-4 space-y-2 max-h-[64vh] overflow-y-auto bg-background/30">
        {!data.messages.length && <p className="text-center text-xs text-muted-foreground py-8">لا رسائل محفوظة بعد.</p>}
        {data.messages.map((m: any) => {
          const draft = m.fromMe && (m.status === "drafted" || m.status === "approved");
          return (
            <div key={m.id} className={cn("flex", m.fromMe ? "justify-start" : "justify-end")}>
              <div className={cn("max-w-[78%] rounded-xl px-3 py-2 text-sm space-y-1.5", !m.fromMe ? "bg-muted/60 border border-card-border" : draft ? "border-2 border-dashed border-yellow-500/50 bg-yellow-500/5" : "bg-primary/15 border border-primary/20", m.status === "skipped" && "opacity-40")}>
                <p className="text-[10px] text-muted-foreground">{m.fromMe ? "نحن" : t.displayName || `@${t.handle}`}{m.kind ? ` · ${KIND[m.kind] ?? m.kind}` : ""} · {m.status === "drafted" ? "مسودة تنتظرك" : m.status === "approved" ? "معتمدة — تُرسل في الجولة القادمة" : m.status === "failed" ? "فشلت" : m.status === "skipped" ? "أُلغيت" : ago(m.sentAt ?? m.createdAt)}</p>
                {m.status === "drafted" && edit[m.id] !== undefined
                  ? <textarea className={cn(input, "min-h-[5rem]")} dir="auto" value={edit[m.id]} onChange={(e) => setEdit({ ...edit, [m.id]: e.target.value })} autoFocus />
                  : <p className="whitespace-pre-wrap leading-relaxed" dir="auto">{m.text}</p>}
                {m.error && <p className="text-[10px] text-red-400">{m.error}</p>}
                {m.status === "drafted" && (
                  <div className="flex gap-1.5 pt-1">
                    <button onClick={() => approve.mutate(m)} className={cn(primary, "py-1")}><Check className="w-3 h-3" /> اعتمد</button>
                    {edit[m.id] === undefined && <button onClick={() => setEdit({ ...edit, [m.id]: m.text })} className={cn(ghost, "py-1")}><Pencil className="w-3 h-3" /> عدّل</button>}
                    <button onClick={() => skip.mutate(m)} className={cn(ghost, "py-1")}><X className="w-3 h-3" /> ألغِ</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="px-4 py-2 text-[10px] text-muted-foreground border-t border-card-border">الرسائل المعتمدة تُرسل في جولة الفريق القادمة، داخل حدود {PLATFORM_UI[p].label} اليومية.</p>
    </div>
  );
}
