// ── غانم — the engineer above the team ───────────────────────────
// The owner gives him a goal and talks to him; he measures, hires, briefs,
// teaches and reports. What he did appears under each answer.

import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Compass, Send, Plus, Loader2, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const STARTERS = [
  "هدفي ٢٠ عميلاً جديداً خلال ٩٠ يوماً. قِس وضعنا وقل لي أكبر عائق وماذا ستفعل.",
  "راجع ردود المبيعات في آخر أسبوع: ما الذي يُضعف الردود وكيف تدرّب الموظف؟",
  "المتابعة لا تُرسل. شخّص السبب واقترح الحل.",
  "وظّف من ينقص الفريق لهذا الهدف، بمواصفة كاملة لكل واحد.",
  "هل الرقم في خطر حظر؟ ماذا نغيّر اليوم؟",
];

export default function Engineer() {
  const qc = useQueryClient();
  const [threadId, setThreadId] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const { data: threads = [] } = useQuery<any[]>({ queryKey: ["eng-threads"], queryFn: () => api("/api/engineer/threads") });
  const { data: messages = [] } = useQuery<any[]>({ queryKey: ["eng-thread", threadId], queryFn: () => threadId ? api(`/api/engineer/threads/${threadId}`) : Promise.resolve([]) });
  const send = useMutation({
    mutationFn: (message: string) => api("/api/engineer/chat", { method: "POST", body: JSON.stringify({ threadId, message }) }),
    onSuccess: (d: any) => { setThreadId(d.threadId); qc.invalidateQueries({ queryKey: ["eng-threads"] }); qc.invalidateQueries({ queryKey: ["eng-thread", d.threadId] }); qc.invalidateQueries({ queryKey: ["team-overview"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, send.isPending]);
  const submit = (t?: string) => { const m = (t ?? input).trim(); if (!m || send.isPending) return; setInput(""); send.mutate(m); };

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      <aside className="w-60 border-l border-card-border p-3 space-y-2 overflow-y-auto shrink-0 hidden md:block">
        <button onClick={() => setThreadId(null)} className="w-full flex items-center gap-2 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm"><Plus className="w-4 h-4" /> هدف جديد</button>
        {threads.map((t) => (
          <button key={t.id} onClick={() => setThreadId(t.id)} className={cn("w-full text-right px-3 py-2 text-xs truncate rounded-lg text-muted-foreground hover:text-foreground", threadId === t.id && "bg-muted text-foreground")}>{t.title}</button>
        ))}
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-card-border p-3 flex items-center gap-2">
          <Compass className="w-5 h-5 text-primary" />
          <div><p className="text-sm font-semibold">غانم — مهندس الجراف، مدير الفريق</p><p className="text-[11px] text-muted-foreground">أعطه هدفاً. يقيس من الإيصالات، يوظّف ويدرّب ويوزّع المهام، ويطلب موافقتك قبل أي إرسال.</p></div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {!threadId && !messages.length && (
            <div className="max-w-2xl mx-auto space-y-2 pt-6">
              <p className="text-sm text-muted-foreground">ابدأ بهدف برقم وموعد، أو اختر:</p>
              {STARTERS.map((s) => <button key={s} onClick={() => submit(s)} className="block w-full text-right text-xs px-3 py-2 rounded-lg border border-card-border hover:border-primary/50">{s}</button>)}
            </div>
          )}
          {messages.map((m: any) => (
            <div key={m.id} className={cn("flex gap-2 max-w-3xl", m.role === "user" ? "mr-auto flex-row-reverse" : "")}>
              <div className={cn("w-7 h-7 rounded-full grid place-items-center shrink-0", m.role === "user" ? "bg-muted" : "bg-primary/15 text-primary")}>{m.role === "user" ? <User className="w-4 h-4" /> : <Compass className="w-4 h-4" />}</div>
              <div className={cn("rounded-xl px-3.5 py-2.5 text-sm whitespace-pre-wrap leading-relaxed", m.role === "user" ? "bg-primary/10" : "bg-card border border-card-border")}>{m.content}</div>
            </div>
          ))}
          {send.isPending && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> غانم يقرأ الإيصالات ويقرر…</div>}
          <div ref={bottom} />
        </div>
        <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="border-t border-card-border p-3 flex gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="اكتب هدفك أو سؤالك لغانم…" className="flex-1 px-3 py-2 bg-input border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <button type="submit" disabled={send.isPending || !input.trim()} className="px-3 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50"><Send className="w-4 h-4" /></button>
        </form>
      </div>
    </div>
  );
}
