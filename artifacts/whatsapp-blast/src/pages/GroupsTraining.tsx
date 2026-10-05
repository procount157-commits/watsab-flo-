// ── تدريب سارة ────────────────────────────────────────────────────
// What the owner teaches the groups agent — standing instructions, a customer
// question with the answer he wants, pasted text, files — and, beside it,
// what she learned herself from reading the groups. Both can be switched off
// or deleted; instructions are always in front of her, the rest when they
// bear on what the customer wrote.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Brain, FileText, GraduationCap, ListChecks, Loader2, MessageSquareText, Plus, Trash2, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const KIND: Record<string, [string, any]> = {
  instruction: ["تعليمة", ListChecks], qa: ["سؤال وجواب", MessageSquareText], text: ["نص", BookOpen], document: ["ملف", FileText], lesson: ["درس تعلّمته", Brain],
};

export function TrainingCenter({ groups }: { groups: any[] }) {
  const qc = useQueryClient();
  const [view, setView] = useState<"owner" | "learned">("owner");
  const { data, isLoading } = useQuery<any>({ queryKey: ["groups-training", view], queryFn: () => api(`/api/groups/training?source=${view}`) });
  const inv = () => qc.invalidateQueries({ queryKey: ["groups-training"] });
  const patch = useMutation({ mutationFn: ({ id, ...b }: any) => api(`/api/groups/training/${id}`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/groups/training/${id}`, { method: "DELETE" }), onSuccess: () => { inv(); toast.success("حُذف"); } });
  const counts: any[] = data?.counts ?? [];
  const count = (pred: (c: any) => boolean) => counts.filter(pred).reduce((a, c) => a + Number(c.active), 0);
  const subject = (jid: string | null) => (jid ? groups.find((g) => g.jid === jid)?.subject ?? "قروب" : "كل القروبات");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[["تعليمات", count((c) => c.kind === "instruction")], ["أسئلة وأجوبة", count((c) => c.kind === "qa")], ["نصوص", count((c) => c.kind === "text")], ["ملفات", count((c) => c.kind === "document")], ["دروس تعلّمتها وحدها", count((c) => c.kind === "lesson")]].map(([l, v]) => (
          <div key={l as string} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground">{l}</p><p className="text-xl font-bold leading-none mt-1.5">{n(v as number)}</p></div>
        ))}
      </div>

      <Teach groups={groups} onDone={inv} />

      <div className={card}>
        <div className="p-3 border-b border-card-border flex items-center gap-1.5">
          {([["owner", "ما علّمتها إياه"], ["learned", "ما تعلّمته وحدها"]] as const).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} className={cn("px-3 py-1.5 rounded-full border text-xs", view === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
          ))}
          <p className="text-[11px] text-muted-foreground mr-auto">{view === "learned" ? "تقرأ كل قروب بعد أن يهدأ ١٠ دقائق وتكتب ما تعلّمته. أطفئ أي درس خاطئ أو احذفه." : "التعليمات أمامها في كل اقتراح؛ الباقي حين يشبه ما كتبه العميل."}</p>
        </div>
        {isLoading ? <div className="p-8 text-center"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
          : !(data?.items ?? []).length ? <p className="p-8 text-center text-xs text-muted-foreground">{view === "owner" ? "لم تعلّمها شيئاً بعد — ابدأ بتعليمة أو مثال سؤال وجواب من أعلى." : "لم تتعلم شيئاً بعد — تبدأ حين تصل رسائل في قروبات العملاء أو المراقبة."}</p>
          : <div className="divide-y divide-card-border">{data.items.map((it: any) => {
              const [label, Icon] = KIND[it.kind] ?? [it.kind, BookOpen];
              return (
                <div key={it.id} className={cn("p-3 flex gap-3 items-start", !it.active && "opacity-50")}>
                  <Icon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <p className="text-[10px] text-muted-foreground">{label} · {subject(it.groupJid)}{it.title ? ` · ${it.title}` : ""}{it.kind === "document" ? ` · ${n(it.chars)} حرف` : ""} · استُخدم {n(it.used)} مرة</p>
                    {it.kind === "qa" ? <><p className="text-xs" dir="auto"><b>العميل:</b> {it.question}</p><p className="text-xs" dir="auto"><b>الرد:</b> {it.answer}</p></>
                      : <p className="text-xs whitespace-pre-wrap line-clamp-4" dir="auto">{it.content}</p>}
                  </div>
                  <label className="text-[10px] flex items-center gap-1 text-muted-foreground shrink-0"><input type="checkbox" checked={it.active} onChange={(e) => patch.mutate({ id: it.id, active: e.target.checked })} /> مفعّل</label>
                  <button onClick={() => { if (confirm("حذف نهائي؟")) del.mutate(it.id); }} className="text-muted-foreground hover:text-red-400 shrink-0"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              );
            })}</div>}
      </div>
    </div>
  );
}

function Teach({ groups, onDone }: { groups: any[]; onDone: () => void }) {
  const [kind, setKind] = useState<"instruction" | "qa" | "text" | "document">("instruction");
  const [scope, setScope] = useState("");
  const [f, setF] = useState({ title: "", content: "", question: "", answer: "" });
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const reset = () => { setF({ title: "", content: "", question: "", answer: "" }); setFiles([]); };

  const send = async () => {
    setBusy(true);
    try {
      if (kind === "document") {
        if (!files.length) throw new Error("اختر ملفاً");
        const fd = new FormData();
        for (const x of files) fd.append("files", x);
        if (scope) fd.append("groupJid", scope);
        const r = await fetch(`${BASE}/api/groups/training/upload`, { method: "POST", body: fd, credentials: "include" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "تعذّر الرفع");
        const ok = (d.files ?? []).filter((x: any) => !x.error);
        if (ok.length) toast.success(`قرأت سارة ${n(ok.length)} ملف`);
        for (const x of d.files ?? []) if (x.error) toast.error(`${x.file}: ${x.error}`);
      } else {
        await api("/api/groups/training", { method: "POST", body: JSON.stringify({ kind, ...f, groupJid: scope || null }) });
        toast.success("تعلّمته سارة");
      }
      reset(); onDone();
    } catch (e: any) { toast.error(e.message); }
    setBusy(false);
  };

  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-center gap-2 flex-wrap">
        <GraduationCap className="w-4 h-4 text-primary" /><p className="text-sm font-semibold">علّم سارة</p>
        <div className="flex gap-1 mr-3">
          {(["instruction", "qa", "text", "document"] as const).map((k) => {
            const [l, Icon] = KIND[k]!;
            return <button key={k} onClick={() => setKind(k)} className={cn("flex items-center gap-1 px-2.5 py-1 rounded-full border text-[11px]", kind === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}><Icon className="w-3 h-3" /> {l}</button>;
          })}
        </div>
        <select className={cn(input, "w-56 text-xs mr-auto")} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="">لكل القروبات</option>
          {groups.map((g) => <option key={g.jid} value={g.jid}>لهذا القروب فقط: {g.subject ?? "قروب"}</option>)}
        </select>
      </div>
      {kind === "instruction" && <textarea className={cn(input, "min-h-[4rem] text-sm")} dir="auto" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder="مثلاً: لا تعطي أي موعد لتسليم الإقرار — قولي «نراجع ونؤكد لكم اليوم». / ردي على العملاء الإنجليز بالإنجليزية. / من يطلب كشف حساب: اطلبي الشهر والبنك." />}
      {kind === "qa" && (
        <div className="grid md:grid-cols-2 gap-2">
          <textarea className={cn(input, "min-h-[5rem] text-sm")} dir="auto" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} placeholder="ما يكتبه العميل — مثلاً: متى يجهز إقرار الضريبة؟" />
          <textarea className={cn(input, "min-h-[5rem] text-sm")} dir="auto" value={f.answer} onChange={(e) => setF({ ...f, answer: e.target.value })} placeholder="الرد الذي تريده منها بالضبط" />
        </div>
      )}
      {kind === "text" && <>
        <input className={cn(input, "text-sm")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="العنوان — مثلاً: إجراءات استلام مستندات العميل" />
        <textarea className={cn(input, "min-h-[7rem] text-sm")} dir="auto" value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder="الصق هنا أي محتوى: طريقة العمل، الأسعار، الخدمات، الأسئلة الشائعة…" />
      </>}
      {kind === "document" && (
        <label className="flex flex-col items-center justify-center gap-1.5 border border-dashed border-card-border rounded-lg p-6 cursor-pointer hover:border-primary/50 text-xs text-muted-foreground">
          <Upload className="w-5 h-5" />{files.length ? files.map((x) => x.name).join("، ") : "اختر ملفات — PDF، Word، Excel، نص (حتى ١٠)"}
          <input type="file" multiple className="hidden" accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md" onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 10))} />
        </label>
      )}
      <button onClick={send} disabled={busy} className={primary}>{busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} علّمها</button>
    </div>
  );
}
