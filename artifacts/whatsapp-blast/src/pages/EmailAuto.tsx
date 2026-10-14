// ── تشغيل البريد: ارفع، أعطِ الهدف، واترك الباقي ───────────────────
// صاحب العمل: «كل اللي هعمله أرفع مجلدات مسمّاة — مقاولات، عقارات — وأعطيه
// هدف: ٥٠ أو ١٠٠ lead في الشهر. هو يعمل كل حاجة». وكانت الآلة كلها موجودة
// متفرّقةً في سبع صفحات، فثقلت. هذه الصفحة ثلاث خطوات وحالة:
//
//   ١ · اسحب المجلدات كما هي. اسم كل مجلد هو قطاع ملفاته، ويُعرض قبل الرفع
//       هل هو مستهدف — فلا يُرفع شيءٌ يظنّه صاحبه سيُراسَل ولن يُراسَل.
//   ٢ · عدد الـ leads هذا الشهر. المدير يقسمه على الأيام ويضبط الموجة.
//   ٣ · مفتاحٌ واحد: يعرض عليك كل حملة، أو يرسل وحده بعد فحص الجودة.
//
// وما بعدها — التنظيف، التصنيف، القوائم، الحملات، القوالب، المتابعات —
// يحدث وحده، والحالة تقول ما حدث وما يحتاجه منك.

import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, FolderUp, Target, Power, CheckCircle2, AlertTriangle, Eye, MousePointerClick, Reply, Send, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl p-5";
const primary = "flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-primary text-primary-foreground disabled:opacity-40";
const n = (x: number) => Number(x ?? 0).toLocaleString("en-US");
const SHEET = /\.(xlsx|xls|csv)$/i;

type Pending = { folder: string; file: File };
type Mapped = { name: string; sector: string | null; tracks: string[]; targeted: boolean; note: string };

/** Every spreadsheet under what was dropped, each with the name of the folder it sits in. */
async function filesFromDrop(items: DataTransferItemList): Promise<Pending[]> {
  const out: Pending[] = [];
  const walk = async (entry: any, parent: string): Promise<void> => {
    if (entry.isFile) {
      const file: File = await new Promise((ok, no) => entry.file(ok, no));
      if (SHEET.test(file.name)) out.push({ folder: parent, file });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns at most 100 at a time; read until it returns none.
      for (;;) {
        const batch: any[] = await new Promise((ok, no) => reader.readEntries(ok, no));
        if (!batch.length) break;
        for (const e of batch) await walk(e, entry.name);
      }
    }
  };
  const entries = Array.from(items).map((i) => (i as any).webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, "");
  return out;
}

export default function EmailAuto() {
  const qc = useQueryClient();
  const st = useQuery({ queryKey: ["email-auto"], queryFn: () => api("/api/email/auto"), refetchInterval: 20_000 });
  const s = st.data;

  // ── ١ · الرفع ──
  const [pending, setPending] = useState<Pending[]>([]);
  const [mapped, setMapped] = useState<Mapped[]>([]);
  const [loose, setLoose] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number; log: string[] } | null>(null);
  const [drag, setDrag] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);

  const stage = async (list: Pending[]) => {
    if (!list.length) { toast.error("لم أجد ملفات Excel أو CSV في ما اخترت"); return; }
    setPending(list);
    const names = [...new Set(list.map((p) => p.folder).filter(Boolean))];
    setMapped(names.length ? await api("/api/email/auto/map", { method: "POST", body: JSON.stringify({ names }) }) : []);
  };
  const folderOf = (p: Pending) => p.folder || loose.trim();

  const uploadAll = async () => {
    const missing = pending.filter((p) => !folderOf(p));
    if (missing.length) { toast.error(`${missing.length} ملف خارج أي مجلد — اكتب اسم مجلدها (مثل: عقارات)`); return; }
    setProgress({ done: 0, total: pending.length, log: [] });
    for (const [i, p] of pending.entries()) {
      const fd = new FormData();
      fd.append("file", p.file);
      fd.append("folderName", folderOf(p));
      fd.append("listName", `${folderOf(p)} — ${p.file.name.replace(/\.[a-z0-9]+$/i, "")}`);
      fd.append("country", "AE"); fd.append("mx", "true"); fd.append("saveWhatsapp", "true");
      let line: string;
      try {
        const r = await fetch(`${BASE}/api/email/contacts/import`, { method: "POST", body: fd, credentials: "include" });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "تعذّر");
        line = `✓ ${folderOf(p)} / ${p.file.name}: ${n(d.kept)} بريد (${n(d.inserted)} جديد)${d.mxBad ? ` · ${n(d.mxBad)} نطاق ميت` : ""}`;
      } catch (e: any) { line = `✗ ${p.file.name}: ${e.message}`; }
      setProgress((g) => g && { ...g, done: i + 1, log: [...g.log, line] });
    }
    setPending([]); setMapped([]);
    qc.invalidateQueries({ queryKey: ["email-auto"] });
    toast.success("رُفع كل شيء. الفريق ينظّف ويصنّف الآن، ثم يبني الحملات وحده.");
  };

  // ── ٢ · الهدف ──
  const [target, setTarget] = useState("");
  const goal = useMutation({
    mutationFn: () => api("/api/email/auto/goal", { method: "POST", body: JSON.stringify({ target: Number(target) }) }),
    onSuccess: () => { toast.success("المدير استلم الهدف — يقسمه على الأيام في دورته القادمة"); setTarget(""); qc.invalidateQueries({ queryKey: ["email-auto"] }); },
    onError: (e: any) => toast.error(e.message),
  });

  // ── ٣ · المفتاح ──
  const pilot = useMutation({
    mutationFn: (b: { enabled?: boolean; mode?: string }) => api("/api/email/autopilot", { method: "PUT", body: JSON.stringify(b) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-auto"] }),
    onError: (e: any) => toast.error(e.message),
  });

  if (st.isLoading || !s) return <div className="p-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div>;
  const g = s.goal;
  const pct = g ? Math.min(100, Math.round((g.current / Math.max(1, g.target)) * 100)) : 0;
  const w = s.week;
  const rate = (a: number) => (w.sent ? `${Math.round((a / w.sent) * 1000) / 10}%` : "—");

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-5" dir="rtl">
      <div>
        <h1 className="text-xl font-bold">تشغيل البريد</h1>
        <p className="text-sm text-muted-foreground mt-1">ارفع المجلدات، أعطِ الهدف، واترك الباقي: التنظيف والتصنيف والقوائم والحملات والقوالب والمتابعات تحدث وحدها.</p>
      </div>

      {s.needs.length > 0 && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-1.5">
          <div className="text-sm font-semibold flex items-center gap-1.5 text-yellow-400"><AlertTriangle className="w-4 h-4" /> ما يحتاجه منك</div>
          {s.needs.map((x: string, i: number) => <div key={i} className="text-sm">• {x}</div>)}
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        {/* ── ١ ── */}
        <div className={cn(card, "md:col-span-3")}>
          <div className="font-semibold flex items-center gap-2 mb-3"><FolderUp className="w-4 h-4 text-primary" /> ١ · اسحب المجلدات هنا</div>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={async (e) => { e.preventDefault(); setDrag(false); await stage(await filesFromDrop(e.dataTransfer.items)); }}
            onClick={() => dirRef.current?.click()}
            className={cn("border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors", drag ? "border-primary bg-primary/5" : "border-card-border hover:border-primary/50")}>
            <FolderOpen className="w-8 h-8 mx-auto text-muted-foreground" />
            <div className="mt-2 text-sm">مجلد «عقارات»، مجلد «ذهب ومجوهرات»، مجلد «محاماة»، «مقاولات»، «مطاعم» — بملفاتها كما هي</div>
            <div className="text-xs text-muted-foreground mt-1">اسم المجلد = قطاع ملفاته. Excel أو CSV. أو اضغط لاختيار مجلد.</div>
            <input ref={dirRef} type="file" multiple className="hidden" {...({ webkitdirectory: "", directory: "" } as any)}
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []).filter((f) => SHEET.test(f.name));
                await stage(files.map((file) => { const parts = (file as any).webkitRelativePath?.split("/") ?? []; return { file, folder: parts.length > 1 ? parts[parts.length - 2] : "" }; }));
                e.target.value = "";
              }} />
          </div>

          {pending.length > 0 && (
            <div className="mt-4 space-y-3">
              <div className="text-sm font-medium">{n(pending.length)} ملف — هكذا سأفهمها:</div>
              <div className="space-y-1.5">
                {mapped.map((m) => (
                  <div key={m.name} className="flex flex-wrap items-center gap-2 text-sm rounded-lg border border-card-border px-3 py-2">
                    <span className="font-medium">{m.name}</span>
                    <span className="text-muted-foreground">({pending.filter((p) => p.folder === m.name).length} ملف)</span>
                    <span>←</span>
                    <span>{m.sector ?? "يُصنَّف شركةً شركة"}</span>
                    <span className={cn("text-xs px-2 py-0.5 rounded-full", m.targeted ? "bg-green-500/15 text-green-400" : m.sector ? "bg-muted text-muted-foreground" : "bg-yellow-500/15 text-yellow-400")}>
                      {m.targeted ? m.tracks.join(" + ") : m.sector ? "غير مستهدف" : "غير معروف"}</span>
                    <span className="text-xs text-muted-foreground w-full">{m.note}</span>
                  </div>
                ))}
                {pending.some((p) => !p.folder) && (
                  <div className="flex items-center gap-2 text-sm">
                    <span>{pending.filter((p) => !p.folder).length} ملف خارج أي مجلد — قطاعها:</span>
                    <input value={loose} onChange={(e) => setLoose(e.target.value)} placeholder="مثل: عقارات" className="bg-background border border-card-border rounded-lg px-2 py-1 text-sm w-40" />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button className={primary} onClick={uploadAll} disabled={!!progress && progress.done < progress.total}>ارفع وابدأ</button>
                <button className="px-4 py-2 rounded-lg text-sm border border-card-border" onClick={() => { setPending([]); setMapped([]); }}>إلغاء</button>
              </div>
            </div>
          )}
          {progress && (
            <div className="mt-4 text-xs space-y-1">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
              {progress.log.map((l, i) => <div key={i} className={l.startsWith("✗") ? "text-red-400" : "text-muted-foreground"}>{l}</div>)}
            </div>
          )}
        </div>

        {/* ── ٢ ── */}
        <div className={card}>
          <div className="font-semibold flex items-center gap-2 mb-3"><Target className="w-4 h-4 text-primary" /> ٢ · الهدف هذا الشهر</div>
          {g && (
            <div className="mb-4">
              <div className="flex justify-between text-sm"><span>{g.metric}</span><span className="font-bold">{n(g.current)} / {n(g.target)}</span></div>
              <div className="h-2 bg-muted rounded-full overflow-hidden mt-1.5"><div className="h-full bg-primary" style={{ width: `${pct}%` }} /></div>
              <div className="text-xs text-muted-foreground mt-1.5">بقي {g.daysLeft} يوماً · يلزم {g.perDay} يومياً</div>
            </div>
          )}
          <div className="flex gap-2">
            <input type="number" min={1} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="50"
              className="bg-background border border-card-border rounded-lg px-3 py-2 text-sm w-24" />
            <button className={cn(primary, "flex-1")} disabled={!(Number(target) > 0) || goal.isPending} onClick={() => goal.mutate()}>
              {goal.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null} lead حتى آخر الشهر</button>
          </div>
          <div className="text-xs text-muted-foreground mt-2">Lead = شركة ردّت رداً نافعاً (مهتم، سأل، يدرس، طلب لاحقاً، أحال). يحلّ محلّ الهدف السابق.</div>
        </div>

        {/* ── ٣ ── */}
        <div className={card}>
          <div className="font-semibold flex items-center gap-2 mb-3"><Power className="w-4 h-4 text-primary" /> ٣ · التشغيل</div>
          <button onClick={() => pilot.mutate({ enabled: !s.autopilot.enabled })}
            className={cn("w-full py-2.5 rounded-lg text-sm font-medium mb-3", s.autopilot.enabled ? "bg-green-500/15 text-green-400 border border-green-500/30" : "bg-muted text-muted-foreground border border-card-border")}>
            {s.autopilot.enabled ? "● يعمل" : "○ متوقف — اضغط للتشغيل"}</button>
          <div className="grid grid-cols-2 gap-2">
            {[["approve", "يعرض عليّ", "كل حملة تنتظر موافقتك"], ["auto", "آلي كامل", "يرسل بعد فحص الجودة"]].map(([k, l, d]) => (
              <button key={k} onClick={() => pilot.mutate({ mode: k })}
                className={cn("rounded-lg border p-2 text-right", s.autopilot.mode === k ? "border-primary bg-primary/10" : "border-card-border")}>
                <div className="text-sm font-medium">{l}</div><div className="text-[11px] text-muted-foreground">{d}</div></button>
            ))}
          </div>
          <div className="text-xs text-muted-foreground mt-2">موجة {n(s.autopilot.waveSize)} · {n(s.missions.active)} مهمة تعمل{s.missions.drafts ? ` · ${s.missions.drafts} تنتظرك` : ""}</div>
        </div>

        {/* ── الأسبوع ── */}
        <div className={card}>
          <div className="font-semibold mb-3">آخر ٧ أيام</div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><Send className="w-3.5 h-3.5 inline ml-1" />أُرسل <b>{n(w.sent)}</b></div>
            <div><Eye className="w-3.5 h-3.5 inline ml-1" />فُتح <b>{n(w.opened)}</b> <span className="text-xs text-muted-foreground">{rate(w.opened)}</span></div>
            <div><MousePointerClick className="w-3.5 h-3.5 inline ml-1" />نُقر <b>{n(w.clicked)}</b></div>
            <div><Reply className="w-3.5 h-3.5 inline ml-1" />ردّ <b>{n(w.replied)}</b> <span className="text-xs text-muted-foreground">{rate(w.replied)}</span></div>
          </div>
          <div className={cn("text-xs mt-3 flex items-start gap-1.5", s.tracking.can ? "text-green-400" : "text-yellow-400")}>
            {s.tracking.can ? <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />}
            <span>{s.tracking.can
              ? `الفتح يُقاس${s.tracking.since ? ` منذ ${new Date(s.tracking.since).toLocaleDateString("en-GB")}` : " من الآن — ما أُرسل قبله خرج بلا بكسل"}. Apple Mail يفتح آلياً فالنسبة سقفٌ لا حقيقة؛ الرد هو المقياس.`
              : s.tracking.why}</span>
          </div>
        </div>
      </div>

      {/* ── ما عندي ── */}
      <div className={card}>
        <div className="font-semibold mb-1">ما عندك — بالمجلد والقطاع</div>
        <div className="text-xs text-muted-foreground mb-3">{n(s.readyTargeted)} شركة مستهدفة لم تُراسَل بعد. «مستهدف» يُراسَل وحده؛ غيره محفوظ ومصنّف ولا يُراسَل آلياً.</div>
        {s.folders.length === 0 && <div className="text-sm text-muted-foreground">لا شيء بعد — اسحب أول مجلد.</div>}
        <div className="space-y-4">
          {s.folders.map((f: any) => (
            <div key={f.name}>
              <div className="flex items-center justify-between text-sm font-medium mb-1.5">
                <span>📁 {f.name}</span>
                <span className="text-xs text-muted-foreground">{n(f.total)} شركة · {n(f.reached)} رُوسلت · {n(f.replied)} ردّت</span>
              </div>
              <div className="space-y-1">
                {f.sectors.map((x: any) => (
                  <div key={x.sector} className="flex items-center gap-2 text-xs">
                    <span className="w-36 truncate">{x.sector}</span>
                    <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden flex">
                      <div className={x.targeted ? "bg-primary" : "bg-muted-foreground/40"} style={{ width: `${(x.reached / Math.max(1, x.total)) * 100}%` }} />
                    </div>
                    <span className="w-28 text-left text-muted-foreground">{n(x.fresh)} لم تُراسَل</span>
                    <span className={cn("w-32 text-center px-1.5 py-0.5 rounded-full", x.targeted ? "bg-green-500/15 text-green-400" : "bg-muted text-muted-foreground")}>{x.targeted ? x.tracks.join(" + ") : "غير مستهدف"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
