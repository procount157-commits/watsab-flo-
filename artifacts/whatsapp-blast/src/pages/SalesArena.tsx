// ── The training arena ────────────────────────────────────────────
// Two halves. On the left the owner plays a customer and an employee
// answers — nothing is sent to anyone — and beside each answer is how it
// was made: the intent read, the card built, the stage, the skills carried,
// what the pre-send check caught and whether it rewrote the draft. On the
// right, or under the second tab, the real replies of the last days with
// the same diagnosis. Every answer, simulated or real, can be graded, and a
// grade goes into the employee's memory.

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Target, Loader2, Send, RotateCcw, ThumbsUp, ThumbsDown, Sparkles, CheckCircle2, AlertTriangle, ListChecks, Mic, Square, Volume2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const LICENCE: Record<string, string> = { mainland: "مين لاند", freezone: "فري زون" };
const INTENT: Record<string, string> = { interested: "مهتم", question: "سؤال", not_interested: "غير مهتم", complaint: "شكوى", opt_out: "إيقاف", greeting: "تحية", unclear: "غير واضح" };

// Customers the owner can drop in with one click — the situations that
// decide whether a salesman is any good.
const SCENARIOS: Array<{ label: string; msgs: string[] }> = [
  { label: "يسأل السعر أولاً", msgs: ["السلام عليكم، كم أسعاركم للمحاسبة؟"] },
  { label: "«غالي»", msgs: ["عندنا شركة مقاولات فري زون وعندنا تقريبا ٤٠ فاتورة بالشهر", "والله غالي شوي"] },
  { label: "«عندي محاسب»", msgs: ["مرحبا", "عندي محاسب بس ما يمسك الضريبة"] },
  { label: "«أرسل التفاصيل»", msgs: ["أرسل لي التفاصيل"] },
  { label: "مصري", msgs: ["عايز أعرف بتاخدوا كام على مسك الدفاتر؟"] },
  { label: "غرامة", msgs: ["جاتنا غرامة من الضريبة وما ندري ليش، رخصتنا مين لاند"] },
  { label: "موافق", msgs: ["شركة تجارة فري زون ١٥ موظف", "تمام موافق نبدأ من الأحد"] },
  { label: "شكوى", msgs: ["صار لي أسبوعين أنتظر ردكم على الإقرار وما أحد رد!"] },
  { label: "إنجليزي", msgs: ["Hi, do you handle VAT registration for free zone companies?"] },
];

type Turn = { role: "user" | "assistant"; content: string; meta?: any ; spoke?: boolean; audio?: string; waAs?: string};

export default function SalesArena() {
  const [tab, setTab] = useState<"arena" | "review">("arena");
  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Target className="w-6 h-6 text-primary" /> ميدان التدريب</h1>
        <p className="text-sm text-muted-foreground mt-1">كن أنت العميل وشاهد كيف يفكّر الموظف ويردّ — ثم قيّمه. كل تقييم يدخل ذاكرته، وكل تصحيح منك يصير تعليمة يلتزم بها.</p>
      </div>
      <div className="flex gap-1 border-b border-card-border">
        {[["arena", "حاور موظفاً"], ["review", "راجع الردود الحقيقية"]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k as any)} className={cn("px-3 py-2.5 text-xs border-b-2 -mb-px", tab === k ? "border-primary" : "border-transparent text-muted-foreground")}>{l}</button>
        ))}
      </div>
      {tab === "arena" ? <Arena /> : <Review />}
    </div>
  );
}

function Diagnosis({ m }: { m: any }) {
  if (!m) return null;
  const q = m.quality;
  const facts = [m.card?.licence && LICENCE[m.card.licence], m.card?.activity, m.card?.size, m.card?.staff, m.card?.accountant, m.card?.pain && `وجعه: ${m.card.pain}`].filter(Boolean);
  return (
    <div className="mt-2 rounded-lg border border-card-border bg-muted/20 p-2.5 space-y-1.5 text-[11px]">
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="px-1.5 py-0.5 rounded bg-muted">النية: {INTENT[m.intent] ?? m.intent}</span>
        <span className={cn("px-1.5 py-0.5 rounded", m.stage?.n >= 5 ? "bg-primary/15 text-primary" : "bg-muted")}>المرحلة {m.stage?.n} — {m.stage?.name}</span>
        {q && <span className={cn("px-1.5 py-0.5 rounded", q.score >= 85 ? "bg-primary/15 text-primary" : q.score >= 60 ? "bg-yellow-500/15 text-yellow-400" : "bg-red-500/15 text-red-400")}>الجودة {q.score}/100{q.rewritten ? " · أُعيدت كتابته" : ""}</span>}
        <span className="text-muted-foreground">{m.provider} · {Math.round((m.ms ?? 0) / 100) / 10}ث{m.debug ? ` · ${m.debug.promptChars} حرفاً في التعليمات` : ""}</span>
      </div>
      <p className="text-muted-foreground"><span className="text-foreground">هدف الرسالة:</span> {m.stage?.goal}</p>
      <p className="text-muted-foreground"><span className="text-foreground">البطاقة:</span> {facts.length ? facts.join(" · ") : "لا شيء معروف بعد"}{m.card?.objection ? ` · اعتراض: «${m.card.objection}»` : ""}</p>
      {m.skills?.length > 0 && <p className="text-muted-foreground"><span className="text-foreground">المهارات:</span> {m.skills.join("، ")}</p>}
      {m.debug?.kbTitles?.length > 0 && <p className="text-muted-foreground"><span className="text-foreground">من المعرفة:</span> {m.debug.kbTitles.join("، ")}</p>}
      {q?.issues?.length > 0 && <p className="text-yellow-400"><AlertTriangle className="w-3 h-3 inline ml-1" />{q.rewritten ? "صُحّح قبل الإرسال: " : "بقي: "}{q.issues.join(" · ")}</p>}
      {q?.firstDraft && <details><summary className="cursor-pointer text-muted-foreground">المسودة الأولى قبل التصحيح</summary><p className="mt-1 whitespace-pre-wrap text-muted-foreground">{q.firstDraft}</p></details>}
    </div>
  );
}

function RateBox({ role, customer, reply, logId, onDone }: { role: string; customer: string; reply: string; logId?: number; onDone?: () => void }) {
  const [down, setDown] = useState(false);
  const [fix, setFix] = useState("");
  const rate = useMutation({
    mutationFn: (rating: number) => api("/api/agents/arena/rate", { method: "POST", body: JSON.stringify({ role, customer, reply, rating, correction: rating < 0 ? fix : null, logId }) }),
    onSuccess: (d: any) => { toast.success(`حُفظ في ذاكرته: ${d.remembered.join("، ")}`); setDown(false); setFix(""); onDone?.(); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-2">
      <div className="flex gap-1.5">
        <button onClick={() => rate.mutate(1)} disabled={rate.isPending} className={ghost}><ThumbsUp className="w-3 h-3" /> رد جيد</button>
        <button onClick={() => setDown(!down)} className={cn(ghost, down && "border-red-500/40 text-red-400")}><ThumbsDown className="w-3 h-3" /> يحتاج تصحيح</button>
      </div>
      {down && (
        <div className="mt-2 space-y-1.5">
          <textarea className={cn(input, "min-h-[4.5rem] text-xs")} value={fix} onChange={(e) => setFix(e.target.value)} placeholder="كيف كان يجب أن يرد؟ اكتب الرد كما تريده بالضبط — يصير تعليمة يلتزم بها في مواقف مشابهة." />
          <button onClick={() => rate.mutate(-1)} disabled={rate.isPending} className={cn(ghost, "border-red-500/40")}>احفظ التصحيح</button>
        </div>
      )}
    </div>
  );
}

function Arena() {
  const { data: team = [] } = useQuery<any[]>({ queryKey: ["employees-list"], queryFn: async () => (await api("/api/ops")).team ?? [] });
  const staff = team.filter((t) => t.kind !== "internal");
  const [role, setRole] = useState("sales");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  // Voice: replies read aloud — always, or (as on WhatsApp) only when the customer spoke.
  const [voiceMode, setVoiceMode] = useState<"mirror" | "always" | "off">("mirror");
  const [gender, setGender] = useState<"male" | "female">("male");
  const [recording, setRecording] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [speaking, setSpeaking] = useState<number | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [turns.length, busy]);

  /** The reply, spoken: fetched once, kept on the turn, played. */
  const speak = async (i: number, text: string, list: Turn[]) => {
    setSpeaking(i);
    try {
      const r = await fetch(`${BASE}/api/agents/arena/speak`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, gender }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "تعذّر الصوت");
      const url = URL.createObjectURL(await r.blob());
      const wa = decodeURIComponent(r.headers.get("X-Whatsapp-As") ?? "voice");
      const next = list.map((t, j) => (j === i ? { ...t, audio: url, waAs: wa } : t));
      setTurns(next);
      play(url, i);
      return next;
    } catch (e: any) { toast.error(e.message); setSpeaking(null); return list; }
  };
  const play = (url: string, i: number) => {
    player.current?.pause();
    const a = new Audio(url);
    player.current = a;
    setSpeaking(i);
    a.onended = () => setSpeaking(null);
    a.onerror = () => setSpeaking(null);
    void a.play().catch(() => { setSpeaking(null); toast.info("اضغط زر السماعة لتسمع الرد"); });
  };

  const ask = async (history: Turn[], spoke = false) => {
    setBusy(true);
    try {
      const d = await api("/api/agents/arena/simulate", { method: "POST", body: JSON.stringify({ role, turns: history.map(({ role, content }) => ({ role, content })) }) });
      const next: Turn[] = [...history, { role: "assistant", content: d.reply ?? `— لم يرد: ${d.reason ?? "تعذّر النموذج"}`, meta: d }];
      setTurns(next);
      if (d.reply && (voiceMode === "always" || (voiceMode === "mirror" && spoke))) await speak(next.length - 1, d.reply, next);
    } catch (e: any) { toast.error(e.message); setTurns(history); }
    finally { setBusy(false); }
  };
  const sendText = (t: string, spoke = false) => { if (!t || busy) return; const h = [...turns, { role: "user" as const, content: t, spoke }]; setTurns(h); void ask(h, spoke); };
  const send = () => { const t = msg.trim(); setMsg(""); sendText(t); };

  /** Press to record, press again to send — as a customer's voice note. */
  const toggleRecord = async () => {
    if (recording) { recRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        if (blob.size < 2_000) { toast.info("التسجيل قصير جداً"); return; }
        setHearing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, rec.mimeType.includes("mp4") ? "voice.m4a" : "voice.webm");
          const r = await fetch(`${BASE}/api/agents/arena/transcribe`, { method: "POST", body: fd, credentials: "include" });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error ?? "تعذّر التفريغ");
          sendText(d.text, true);
        } catch (e: any) { toast.error(e.message); } finally { setHearing(false); }
      };
      recRef.current = rec;
      rec.start();
      setRecording(true);
    } catch { toast.error("لم يُسمح بالميكروفون — اسمح للمتصفح باستخدامه ثم حاول"); }
  };
  const scenario = async (msgs: string[]) => {
    // Plays the scenario's messages in order, letting the employee answer each.
    let h: Turn[] = [];
    setTurns([]);
    for (const m of msgs) {
      h = [...h, { role: "user", content: m }];
      setTurns(h);
      setBusy(true);
      try {
        const d = await api("/api/agents/arena/simulate", { method: "POST", body: JSON.stringify({ role, turns: h.map(({ role, content }) => ({ role, content })) }) });
        h = [...h, { role: "assistant", content: d.reply ?? "—", meta: d }];
        setTurns(h);
      } catch (e: any) { toast.error(e.message); break; }
      finally { setBusy(false); }
    }
  };
  const lastUser = (i: number) => [...turns.slice(0, i)].reverse().find((t) => t.role === "user")?.content ?? "";

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        <select className={cn(input, "w-56")} value={role} onChange={(e) => { setRole(e.target.value); setTurns([]); }}>
          {staff.length ? staff.map((e) => <option key={e.role} value={e.role}>{e.avatar} {e.name} — {e.title}</option>) : <option value="sales">هال — المبيعات</option>}
        </select>
        <button onClick={() => setTurns([])} className={ghost}><RotateCcw className="w-3 h-3" /> محادثة جديدة</button>
        <span className="text-[11px] text-muted-foreground">سيناريوهات جاهزة:</span>
        {SCENARIOS.map((s) => <button key={s.label} onClick={() => void scenario(s.msgs)} disabled={busy} className={cn(ghost, "py-1")}>{s.label}</button>)}
      </div>

      <div className={cn(card, "p-4 min-h-[24rem] max-h-[40rem] overflow-y-auto space-y-3")}>
        {turns.length === 0 && <p className="text-sm text-muted-foreground text-center py-16">اكتب كما يكتب عميل حقيقي — أو اختر سيناريو.</p>}
        {turns.map((t, i) => (
          <div key={i} className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%]", t.role === "user" ? "" : "w-full md:w-[85%]")}>
              <div className={cn("px-3.5 py-2 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap", t.role === "user" ? "bg-card border border-card-border" : "bg-primary text-primary-foreground")} dir="auto">
                {t.role === "assistant" && t.meta?.employee && <p className="text-[10px] opacity-80 mb-0.5">{t.meta.employee.avatar} {t.meta.employee.name}</p>}
                {t.role === "user" && t.spoke && <p className="text-[10px] text-muted-foreground mb-0.5 flex items-center gap-1"><Mic className="w-3 h-3" /> رسالة صوتية — فُرّغت هكذا:</p>}
                {t.content}
              </div>
              {t.role === "assistant" && t.meta?.reply && (
                <div className="flex items-center gap-2 mt-1">
                  <button onClick={() => (t.audio ? play(t.audio, i) : void speak(i, t.content, turns))} disabled={speaking === i && !t.audio} className={cn(ghost, "py-1", speaking === i && "border-primary text-primary")}>
                    {speaking === i && !t.audio ? <Loader2 className="w-3 h-3 animate-spin" /> : <Volume2 className="w-3 h-3" />} {speaking === i ? "يتكلم…" : "اسمع الرد"}
                  </button>
                  {t.waAs && <span className="text-[10px] text-muted-foreground">{t.waAs === "voice" ? "على واتساب: يُرسل صوتاً" : `على واتساب: يبقى نصاً (${t.waAs.replace("text:", "")})`}</span>}
                </div>
              )}
              {t.role === "assistant" && t.meta && <><Diagnosis m={t.meta} />{t.meta.reply && <RateBox role={role} customer={lastUser(i)} reply={t.content} />}</>}
            </div>
          </div>
        ))}
        {hearing && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> يسمع تسجيلك…</div>}
        {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3.5 h-3.5 animate-spin" /> يكتب…</div>}
        <div ref={endRef} />
      </div>

      <div className="flex gap-2">
        <button onClick={() => void toggleRecord()} disabled={busy || hearing} title={recording ? "اضغط لإرسال التسجيل" : "سجّل رسالة صوتية كعميل"}
          className={cn("px-4 rounded-lg border flex items-center gap-1.5 text-xs disabled:opacity-40", recording ? "bg-red-500 text-white border-red-500 animate-pulse" : "border-card-border hover:border-primary/50")}>
          {recording ? <><Square className="w-3.5 h-3.5" /> أرسل</> : <Mic className="w-4 h-4" />}
        </button>
        <input className={cn(input, "flex-1")} value={msg} onChange={(e) => setMsg(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={recording ? "يسجّل… اضغط «أرسل» حين تنتهي" : "رسالة العميل… أو اضغط الميكروفون وتكلّم"} dir="auto" />
        <button onClick={send} disabled={busy || !msg.trim()} className="px-4 rounded-lg bg-primary text-primary-foreground disabled:opacity-40"><Send className="w-4 h-4" /></button>
      </div>
      <div className="flex gap-2 items-center flex-wrap text-[11px]">
        <Volume2 className="w-3.5 h-3.5 text-muted-foreground" /><span className="text-muted-foreground">الرد بالصوت:</span>
        {([["mirror", "حين أتكلم أنا (كما في واتساب)"], ["always", "دائماً"], ["off", "لا"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setVoiceMode(k)} className={cn("px-2.5 py-1 rounded-full border", voiceMode === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
        ))}
        <span className="text-muted-foreground mr-2">الصوت:</span>
        {([["male", "رجل (حمدان)"], ["female", "امرأة (فاطمة)"]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setGender(k)} className={cn("px-2.5 py-1 rounded-full border", gender === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">لا يُرسل شيء لأي أحد هنا. الموظف يعمل بنفس شخصيته ومهاراته وذاكرته ومعرفة الشركة، ومراجع الجودة يفحص ردّه قبل أن تراه — كما يحدث مع العملاء الحقيقيين.</p>
    </div>
  );
}

function Review() {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["arena-replies"], queryFn: () => api("/api/agents/replies?limit=80"), refetchInterval: 30_000 });
  const [filter, setFilter] = useState<"all" | "low" | "unrated">("all");
  if (!data) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  const NAMES: Record<string, string> = { sales: "هال", support: "سام", chief: "شمّة", followup: "خالد" };
  const rows = (data.rows as any[]).filter((r) => filter === "all" || (filter === "low" ? (r.qualityScore ?? 100) < 70 : r.ownerRating == null));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(data.perRole as any[]).filter((p) => p.role).map((p) => (
          <div key={p.role} className={cn(card, "p-3.5")}>
            <p className="text-sm font-semibold">{NAMES[p.role] ?? p.role} <span className="text-[11px] text-muted-foreground font-normal">· {p.n} رداً في ٣٠ يوماً</span></p>
            <div className="grid grid-cols-4 gap-2 mt-2 text-center">
              <div><p className="text-lg font-bold leading-none">{p.avgQuality ?? "—"}</p><p className="text-[10px] text-muted-foreground mt-1">الجودة</p></div>
              <div><p className="text-lg font-bold leading-none">{p.rewritten}</p><p className="text-[10px] text-muted-foreground mt-1">صُحّحت</p></div>
              <div><p className="text-lg font-bold leading-none text-primary">{p.wins}</p><p className="text-[10px] text-muted-foreground mt-1">تقدّم</p></div>
              <div><p className="text-lg font-bold leading-none text-red-400">{p.losses}</p><p className="text-[10px] text-muted-foreground mt-1">انصرف</p></div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">تقييماتك: 👍 {p.up} · 👎 {p.down}</p>
          </div>
        ))}
      </div>
      <div className="flex gap-1.5">
        {[["all", "الكل"], ["low", "جودة منخفضة"], ["unrated", "لم تقيّمها"]].map(([k, l]) => <button key={k} onClick={() => setFilter(k as any)} className={cn(ghost, filter === k && "border-primary/50 text-primary")}>{l}</button>)}
      </div>
      <div className={cn(card, "divide-y divide-card-border")}>
        {rows.length === 0 && <p className="p-6 text-sm text-muted-foreground text-center">لا ردود هنا بعد.</p>}
        {rows.map((r) => (
          <div key={r.id} className="p-3.5 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <span className="font-semibold text-xs">{NAMES[r.agentRole] ?? r.agentRole ?? "—"}</span>
              <span className="font-mono text-muted-foreground" dir="ltr">{r.phone}</span>
              {r.qualityScore != null && <span className={cn("px-1.5 rounded", r.qualityScore >= 85 ? "bg-primary/15 text-primary" : r.qualityScore >= 60 ? "bg-yellow-500/15 text-yellow-400" : "bg-red-500/15 text-red-400")}>الجودة {r.qualityScore}{r.rewritten ? " · صُحّح" : ""}</span>}
              {r.outcome && <span className={cn("px-1.5 rounded bg-muted", ["win", "qualified"].includes(r.outcome) && "text-primary", ["loss", "quiet"].includes(r.outcome) && "text-red-400")}>{({ win: "اهتم", qualified: "أعطى معلومة", engaged: "ردّ", quiet: "صمت", loss: "انصرف" } as any)[r.outcome] ?? r.outcome}</span>}
              {r.ownerRating != null && <span>{r.ownerRating > 0 ? "👍" : "👎"}</span>}
              <span className="text-muted-foreground/60 mr-auto">{new Date(r.createdAt).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
            <p className="text-xs"><span className="text-muted-foreground">العميل: </span>{r.incoming}</p>
            <p className="text-xs rounded-lg bg-primary/10 p-2 whitespace-pre-wrap" dir="auto">{r.reply}</p>
            {r.qualityNotes && <p className="text-[11px] text-yellow-400"><ListChecks className="w-3 h-3 inline ml-1" />{r.qualityNotes}</p>}
            {r.ownerRating == null && r.agentRole && <RateBox role={r.agentRole} customer={r.incoming ?? ""} reply={r.reply} logId={r.id} onDone={() => qc.invalidateQueries({ queryKey: ["arena-replies"] })} />}
            {r.ownerNote && <p className="text-[11px] text-muted-foreground"><CheckCircle2 className="w-3 h-3 inline ml-1" />تصحيحك: {r.ownerNote}</p>}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground"><Sparkles className="w-3 h-3 inline ml-1" />«تقدّم» = اهتم أو أعطى معلومة عن شركته بعد الرد. «انصرف» = رفض أو صمت يوماً كاملاً. هذا ما تتعلم منه المديرة كل أسبوع؛ تقييمك يسبقها.</p>
    </div>
  );
}
