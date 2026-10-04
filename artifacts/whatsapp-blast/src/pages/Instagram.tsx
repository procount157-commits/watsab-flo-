import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2, Instagram as IgIcon, LogIn, RefreshCw, Play, Plus, Trash2, Check, X,
  ShieldCheck, ShieldAlert, ShieldX, MessageCircle, Send, Eye, FlaskConical,
  Gauge, Users, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";

const STATE = {
  logged_in:  { icon: ShieldCheck, cls: "text-primary",    label: "مسجّل دخول" },
  logged_out: { icon: ShieldX,     cls: "text-red-400",    label: "خارج الجلسة" },
  checkpoint: { icon: ShieldAlert, cls: "text-yellow-400", label: "يطلب تأكيد هويتك" },
  restricted: { icon: ShieldX,     cls: "text-red-400",    label: "الحساب مقيَّد" },
  unknown:    { icon: ShieldAlert, cls: "text-muted-foreground", label: "غير معروف" },
} as const;

const INTENT: Record<string, { label: string; cls: string }> = {
  interested: { label: "مهتم", cls: "text-primary border-primary/30 bg-primary/5" },
  question:   { label: "سؤال", cls: "text-blue-300 border-blue-500/30 bg-blue-500/5" },
  praise:     { label: "مديح", cls: "text-muted-foreground border-card-border" },
  complaint:  { label: "شكوى", cls: "text-red-300 border-red-500/30 bg-red-500/5" },
  spam:       { label: "سبام", cls: "text-muted-foreground/60 border-card-border" },
  other:      { label: "أخرى", cls: "text-muted-foreground border-card-border" },
};

export default function Instagram() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [tab, setTab] = useState<"drafted" | "approved" | "replied" | "skipped">("drafted");
  const [edits, setEdits] = useState<Record<number, string>>({});

  const inv = () => {
    qc.invalidateQueries({ queryKey: ["ig"] });
    qc.invalidateQueries({ queryKey: ["ig-comments"] });
  };

  const { data, isLoading } = useQuery<any>({
    queryKey: ["ig"], queryFn: () => api("/api/instagram"), refetchInterval: 60_000,
  });
  const { data: comments = [] } = useQuery<any[]>({
    queryKey: ["ig-comments", tab], queryFn: () => api(`/api/instagram/comments?status=${tab}`),
    refetchInterval: 60_000,
  });

  const act = <T,>(path: string, body?: any) =>
    api(`/api/instagram${path}`, { method: "POST", ...(body ? { body: JSON.stringify(body) } : {}) }) as Promise<T>;

  const login = useMutation({
    mutationFn: () => act("/login-window"),
    onSuccess: () => toast.info("فُتحت نافذة كروم — سجّل دخولك بنفسك ثم اضغط «افحص الحالة»"),
    onError: (e: Error) => toast.error(e.message),
  });
  const check = useMutation({
    mutationFn: () => act<any>("/check"),
    onSuccess: (d) => { toast[d.state === "logged_in" ? "success" : "warning"](STATE[d.state as keyof typeof STATE]?.label ?? d.state); inv(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const run = useMutation({
    mutationFn: () => act<any>("/run"),
    onSuccess: (d) => {
      if (d.guard?.state !== "logged_in") { toast.warning(d.guard?.note ?? "الحساب غير جاهز"); return; }
      toast.success(`${d.collected?.fresh ?? 0} تعليق جديد · ${d.processed?.drafted ?? 0} رد مقترح`);
      inv();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addPost = useMutation({
    mutationFn: () => act("/posts", { url }),
    onSuccess: () => { setUrl(""); toast.success("أُضيف للمراقبة"); inv(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const delPost = useMutation({
    mutationFn: (id: number) => api(`/api/instagram/posts/${id}`, { method: "DELETE" }),
    onSuccess: inv,
  });
  const decide = useMutation({
    mutationFn: ({ id, verdict, draft }: { id: number; verdict: "approve" | "skip"; draft?: string }) =>
      act(`/comments/${id}/${verdict}`, verdict === "approve" && draft ? { draft } : undefined),
    onSuccess: (_d, v) => { toast[v.verdict === "approve" ? "success" : "info"](v.verdict === "approve" ? "اعتُمد" : "تُخطّي"); inv(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const send = useMutation({
    mutationFn: () => act<any>("/send"),
    onSuccess: (d) => {
      if (d.reason) toast.warning(d.reason);
      else toast.success(`أُرسل ${d.sent} رد`);
      inv();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const settings = useMutation({
    mutationFn: (body: any) => api("/api/instagram/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { toast.success("حُفظ"); inv(); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) {
    return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  const a = data?.account ?? {};
  const c = data?.counts ?? {};
  const st = STATE[(a.state ?? "unknown") as keyof typeof STATE] ?? STATE.unknown;
  const ready = a.state === "logged_in";

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <IgIcon className="w-6 h-6 text-primary" /> إنستجرام
        </h1>
        <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
          فريق من عشرة يراقبون منشوراتك، يصنّفون التعليقات، ويكتبون الردود — وأنت تعتمد كل رد قبل أن يخرج.
        </p>
      </div>

      {/* The account */}
      <div className={cn(card, "p-4")}>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <st.icon className={cn("w-4 h-4", st.cls)} />
              <p className="font-semibold text-sm">{st.label}</p>
              {a.username && <span className="text-xs text-muted-foreground" dir="ltr">@{a.username}</span>}
              {a.dryRun && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border border-yellow-500/30 text-yellow-400">
                  <FlaskConical className="w-3 h-3" /> وضع التجربة — لا يخرج شيء
                </span>
              )}
            </div>
            {a.stateNote && <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{a.stateNote}</p>}
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <button onClick={() => login.mutate()} disabled={login.isPending} className={cn(ghost, "border-yellow-500/40 text-yellow-400")}>
              {login.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogIn className="w-3.5 h-3.5" />} سجّل الدخول
            </button>
            <button onClick={() => check.mutate()} disabled={check.isPending} className={ghost}>
              {check.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} افحص الحالة
            </button>
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
          تُفتح نافذة كروم حقيقية وتسجّل دخولك فيها بيدك. كلمة مرورك لا تمرّ بهذا النظام إطلاقاً، والجلسة تبقى بعد إعادة التشغيل.
        </p>

        {/* Today's budget */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t border-card-border">
          {[
            { icon: MessageCircle, label: "ردود اليوم", v: `${c.replies ?? 0}/${c.replyCap ?? 0}` },
            { icon: Send,  label: "رسائل اليوم", v: `${c.dms ?? 0}/${c.dmCap ?? 0}` },
            { icon: Users, label: "فرص من التعليقات", v: c.comments?.leads ?? 0 },
            { icon: Gauge, label: "محاولات فاشلة", v: c.fails ?? 0 },
          ].map((x, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <x.icon className={cn("w-4 h-4 shrink-0", i === 3 && (c.fails ?? 0) > 0 ? "text-red-400" : "text-muted-foreground")} />
              <div className="min-w-0">
                <p className="text-base font-bold leading-none">{x.v}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{x.label}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-end gap-3 mt-4 pt-4 border-t border-card-border flex-wrap">
          <div className="w-28">
            <label className="text-[11px] font-semibold block mb-1">حد الردود</label>
            <input type="number" min={5} max={120} defaultValue={a.dailyCommentCap}
                   onBlur={(e) => settings.mutate({ dailyCommentCap: Number(e.target.value) })} className={input} />
          </div>
          <div className="w-28">
            <label className="text-[11px] font-semibold block mb-1">حد الرسائل</label>
            <input type="number" min={3} max={60} defaultValue={a.dailyDmCap}
                   onBlur={(e) => settings.mutate({ dailyDmCap: Number(e.target.value) })} className={input} />
          </div>
          <button onClick={() => settings.mutate({ dryRun: !a.dryRun })}
                  className={cn(ghost, a.dryRun ? "border-primary/40 text-primary" : "border-yellow-500/40 text-yellow-400")}>
            {a.dryRun ? "فعّل الإرسال الحقيقي" : "أعِده لوضع التجربة"}
          </button>
          <p className="text-[10px] text-muted-foreground basis-full leading-relaxed">
            الحدود منخفضة عمداً. إنستجرام لا يرفض فعلاً يكرهه — يقبله ثم يخفي تعليقاتك عن الجميع بصمت لأيام، ولا يخبرك.
            فاصل {data?.pace?.minGapSeconds ?? 45} ثانية بين كل فعل، ولا نشاط خارج {data?.pace?.hours?.[0]}–{data?.pace?.hours?.[1]} بتوقيت الخليج.
          </p>
        </div>
      </div>

      {/* Watched posts */}
      <div className={card}>
        <div className="p-4 border-b border-card-border">
          <p className="font-semibold text-sm">المنشورات المتابَعة</p>
          <div className="flex gap-2 mt-3 flex-wrap">
            <input value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr"
                   onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) addPost.mutate(); }}
                   placeholder="https://www.instagram.com/p/..." className={cn(input, "flex-1 min-w-[200px] font-mono text-xs")} />
            <button onClick={() => addPost.mutate()} disabled={!url.trim() || addPost.isPending} className={ghost}>
              {addPost.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} راقب
            </button>
            <button onClick={() => run.mutate()} disabled={run.isPending || !ready} className={cn(ghost, "border-primary/40 text-primary")}>
              {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} شغّل جولة
            </button>
          </div>
        </div>
        {(data?.posts ?? []).length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground text-center">لا منشورات — الصق رابط منشور لتبدأ مراقبته.</p>
        ) : (
          <div className="divide-y divide-card-border">
            {(data.posts as any[]).map((p) => (
              <div key={p.id} className="p-3 flex items-center gap-2 flex-wrap">
                <a href={p.url} target="_blank" rel="noreferrer" className="text-xs font-mono text-primary hover:underline flex items-center gap-1" dir="ltr">
                  <ExternalLink className="w-3 h-3" /> {p.shortcode}
                </a>
                <span className="text-[11px] text-muted-foreground">{p.commentCount} تعليق</span>
                {p.lastSeenAt && <span className="text-[10px] text-muted-foreground/60">آخر فحص {new Date(p.lastSeenAt).toLocaleString("ar-AE", { timeZone: "Asia/Dubai", dateStyle: "short", timeStyle: "short" })}</span>}
                <button onClick={() => delPost.mutate(p.id)} className="mr-auto text-muted-foreground hover:text-red-400">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Comments and their drafted replies */}
      <div className={card}>
        <div className="p-4 border-b border-card-border flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-1.5 flex-wrap">
            {([["drafted", "بانتظارك", c.comments?.drafted], ["approved", "معتمدة", c.comments?.approved],
               ["replied", "أُرسلت", c.comments?.replied], ["skipped", "متخطّاة", c.comments?.skipped]] as const).map(([k, label, n]) => (
              <button key={k} onClick={() => setTab(k as any)}
                className={cn("px-3 py-1.5 rounded-lg text-xs border transition-colors",
                  tab === k ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}>
                {label}{typeof n === "number" ? ` (${n})` : ""}
              </button>
            ))}
          </div>
          {tab === "approved" && (
            <button onClick={() => send.mutate()} disabled={send.isPending || a.dryRun} className={cn(ghost, "border-primary/40 text-primary")}>
              {send.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              {a.dryRun ? "وضع التجربة" : "أرسل المعتمدة"}
            </button>
          )}
        </div>

        {comments.length === 0 ? (
          <p className="p-8 text-sm text-muted-foreground text-center">
            {tab === "drafted" ? "لا ردود تنتظرك. اضغط «شغّل جولة» بعد إضافة منشور." : "لا شيء هنا."}
          </p>
        ) : (
          <div className="divide-y divide-card-border">
            {comments.map((x) => {
              const it = INTENT[x.intent ?? "other"] ?? INTENT.other;
              return (
                <div key={x.id} className="p-4">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="text-xs font-medium" dir="ltr">@{x.author}</span>
                    <span className={cn("text-[10px] px-2 py-0.5 rounded border", it.cls)}>{it.label}</span>
                    {x.isLead && <span className="text-[10px] px-2 py-0.5 rounded border border-primary/30 text-primary">فرصة</span>}
                    {x.postUrl && (
                      <a href={x.postUrl} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-1">
                        <Eye className="w-3 h-3" /> المنشور
                      </a>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{x.text}</p>

                  {x.draft && (
                    <div className="mt-3">
                      <p className="text-[10px] text-muted-foreground mb-1.5">
                        {x.status === "replied" ? "✍️ تركي كتب، وأُرسل:" : "✍️ تركي يقترح:"}
                      </p>
                      {tab === "drafted" ? (
                        <textarea
                          defaultValue={x.draft} rows={2}
                          onChange={(e) => setEdits({ ...edits, [x.id]: e.target.value })}
                          className={cn(input, "text-xs resize-y leading-relaxed")}
                        />
                      ) : (
                        <p className="text-xs leading-relaxed rounded-lg border border-card-border bg-muted/30 p-2.5">{x.draft}</p>
                      )}
                    </div>
                  )}
                  {x.skipReason && <p className="text-[10px] text-muted-foreground/70 mt-2">{x.skipReason}</p>}

                  {tab === "drafted" && (
                    <div className="flex gap-2 mt-2.5">
                      <button onClick={() => decide.mutate({ id: x.id, verdict: "approve", draft: edits[x.id] ?? x.draft })}
                              disabled={decide.isPending} className={cn(ghost, "border-primary/40 text-primary")}>
                        <Check className="w-3.5 h-3.5" /> اعتمد
                      </button>
                      <button onClick={() => decide.mutate({ id: x.id, verdict: "skip" })}
                              disabled={decide.isPending} className={cn(ghost, "border-red-500/30 text-red-400")}>
                        <X className="w-3.5 h-3.5" /> تخطَّ
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* The team */}
      <div className={cn(card, "p-4")}>
        <p className="font-semibold text-sm mb-3">الفريق</p>
        <div className="flex flex-wrap gap-2">
          {(data?.team ?? []).map((t: any) => (
            <div key={t.role} className={cn("flex items-center gap-2 px-3 py-2 rounded-lg border text-xs",
              t.isActive ? "border-card-border" : "border-card-border opacity-50")}>
              <span>{t.avatar}</span>
              <div className="min-w-0">
                <p className="font-medium">{t.name}</p>
                <p className="text-[10px] text-muted-foreground">{t.title}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">
          يعملون على حسابك أنت، ويردّون على من جاءك — من علّق على منشورك أو راسلك. لا يُراسلون غريباً لم يتواصل معك.
        </p>
      </div>
    </div>
  );
}
