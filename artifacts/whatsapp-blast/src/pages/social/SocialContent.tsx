// ── What the team publishes: posts, and comments on others' posts ──
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Copy, Loader2, Pencil, Sparkles, Trash2, X, MessageSquarePlus, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { card, ghost, primary, ago, PLATFORM_UI, type Platform } from "./SocialDesk";

const C_STATUS: Record<string, [string, string]> = {
  draft: ["مسودة", "bg-yellow-500/15 text-yellow-400"], approved: ["معتمد — يُنشر في الجولة القادمة", "bg-primary/15 text-primary"],
  published: ["نُشر ✓", "bg-green-500/15 text-green-400"], failed: ["لم يُنشر", "bg-red-500/10 text-red-400"], skipped: ["أُلغي", "bg-muted text-muted-foreground"],
};

export function ContentTab({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const [topic, setTopic] = useState("");
  const [eu, setEu] = useState({ url: "", text: "" });
  const { data: rows = [] } = useQuery<any[]>({ queryKey: ["social-content", p], queryFn: () => api(`/api/social/${p}/content`) });
  const inv = () => { qc.invalidateQueries({ queryKey: ["social-content", p] }); qc.invalidateQueries({ queryKey: ["social", p] }); };
  const write = useMutation({ mutationFn: (b: any) => api(`/api/social/${p}/content`, { method: "POST", body: JSON.stringify(b) }), onSuccess: () => { setTopic(""); setEu({ url: "", text: "" }); inv(); toast.success("كتب الفريق مسودة — راجعها أدناه"); }, onError: (e: Error) => toast.error(e.message) });
  const textOnly = p === "linkedin";

  return (
    <div className="space-y-4">
      <div className="grid md:grid-cols-2 gap-3">
        <div className={cn(card, "p-4 space-y-2.5")}>
          <p className="text-sm font-semibold flex items-center gap-2"><FileText className="w-4 h-4 text-primary" /> منشور جديد</p>
          <p className="text-[11px] text-muted-foreground">{textOnly ? "يكتبه الفريق، تعتمده، فيُنشر من حسابك في الجولة القادمة." : `${PLATFORM_UI[p].label} لا يقبل منشوراً بلا ${p === "tiktok" ? "فيديو" : "صورة"} من المتصفح — يكتب الفريق الوصف والوسوم، وتنشره أنت من هاتفك.`}</p>
          <textarea className={cn(input, "min-h-[4rem] text-sm")} placeholder="الموضوع — مثلاً: ما الذي يطلبه مفتش AML من الوسيط العقاري" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <button onClick={() => write.mutate({ kind: "post", topic })} disabled={!topic.trim() || write.isPending} className={primary}>{write.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} اكتب المنشور</button>
        </div>
        <div className={cn(card, "p-4 space-y-2.5")}>
          <p className="text-sm font-semibold flex items-center gap-2"><MessageSquarePlus className="w-4 h-4 text-primary" /> تعليق تفاعلي على منشور غيرك</p>
          <p className="text-[11px] text-muted-foreground">منشور لشركة في قطاعك: الصق رابطه ونصه، فيكتب الفريق تعليقاً يضيف شيئاً — لا ترويج.</p>
          <input className={cn(input, "text-xs")} dir="ltr" placeholder="رابط المنشور" value={eu.url} onChange={(e) => setEu({ ...eu, url: e.target.value })} />
          <textarea className={cn(input, "min-h-[3rem] text-xs")} placeholder="نص المنشور" value={eu.text} onChange={(e) => setEu({ ...eu, text: e.target.value })} />
          <button onClick={() => write.mutate({ kind: "engage", targetUrl: eu.url, targetText: eu.text })} disabled={!eu.url.trim() || !eu.text.trim() || write.isPending} className={primary}><Sparkles className="w-3.5 h-3.5" /> اكتب التعليق</button>
        </div>
      </div>
      <div className={card}>
        <div className="p-3 border-b border-card-border"><p className="text-sm font-semibold">المسودات والمنشور</p></div>
        {!rows.length ? <p className="p-10 text-center text-xs text-muted-foreground">لا شيء بعد.</p> : <div className="divide-y divide-card-border">{rows.map((c) => <ContentRow key={c.id} p={p} c={c} onDone={inv} />)}</div>}
      </div>
    </div>
  );
}

function ContentRow({ p, c, onDone }: { p: Platform; c: any; onDone: () => void }) {
  const [edit, setEdit] = useState<string | null>(null);
  const patch = useMutation({ mutationFn: (b: any) => api(`/api/social/${p}/content/${c.id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: () => { setEdit(null); onDone(); } });
  const del = useMutation({ mutationFn: () => api(`/api/social/${p}/content/${c.id}`, { method: "DELETE" }), onSuccess: onDone });
  const [label, cls] = C_STATUS[c.status] ?? [c.status, ""];
  const manual = c.kind === "post" && p !== "linkedin";
  return (
    <div className="p-3.5 space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-semibold">{c.kind === "post" ? "منشور" : "تعليق تفاعلي"}</span>
        {c.topic && <span className="text-muted-foreground truncate">«{c.topic}»</span>}
        {c.targetUrl && <a href={c.targetUrl} target="_blank" rel="noreferrer" className="text-primary truncate max-w-[14rem]" dir="ltr">{c.targetUrl}</a>}
        <span className={cn("px-2 py-0.5 rounded-full text-[10px] mr-auto", cls)}>{label}</span>
        <span className="text-muted-foreground">{ago(c.publishedAt ?? c.createdAt)}</span>
      </div>
      {edit === null ? <p className="text-sm whitespace-pre-wrap" dir="auto">{c.text}</p> : <textarea className={cn(input, "min-h-[8rem]")} dir="auto" value={edit} onChange={(e) => setEdit(e.target.value)} autoFocus />}
      {c.error && <p className="text-[11px] text-red-400">{c.error}</p>}
      <div className="flex gap-1.5">
        {edit !== null ? <><button onClick={() => patch.mutate({ text: edit })} className={cn(primary, "py-1.5")}><Check className="w-3 h-3" /> احفظ</button><button onClick={() => setEdit(null)} className={cn(ghost, "py-1.5")}>إلغاء</button></> : <>
          {c.status === "draft" && !manual && <button onClick={() => patch.mutate({ status: "approved" })} className={cn(primary, "py-1.5")}><Check className="w-3 h-3" /> اعتمد للنشر</button>}
          {c.status !== "published" && <button onClick={() => setEdit(c.text)} className={cn(ghost, "py-1.5")}><Pencil className="w-3 h-3" /> عدّل</button>}
          <button onClick={() => { navigator.clipboard.writeText(c.text); toast.success("نُسخ"); }} className={cn(ghost, "py-1.5")}><Copy className="w-3 h-3" /> نسخ</button>
          {c.status === "approved" && <button onClick={() => patch.mutate({ status: "draft" })} className={cn(ghost, "py-1.5")}><X className="w-3 h-3" /> ألغِ الاعتماد</button>}
          <button onClick={() => del.mutate()} className={cn(ghost, "py-1.5 text-red-400 mr-auto")}><Trash2 className="w-3 h-3" /></button>
        </>}
      </div>
    </div>
  );
}
