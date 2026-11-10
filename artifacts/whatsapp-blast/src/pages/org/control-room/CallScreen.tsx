// ── شاشة المكالمة ─────────────────────────────────────────────────
// الحالة كما يقولها الخادم: «يرنّ» ما دام الطلب جارياً فقط، ثم متصل أو مشغول أو غير متاح
// بسببه. نصف اتجاهي: تتكلم ثم يجيب، ويُقرأ رده بصوت، وتستطيع مقاطعته.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { FileText, Loader2, Mic, PhoneCall, PhoneOff, Send, Square, Volume2, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pill, Section, TASK, card, danger, dept, field, ghost, list, primary, when } from "../shared";
import { playLine, stopPlayback, useRecorder, voice, voiceUpload } from "./voice";

const STATE: Record<string, { label: string; cls: string }> = {
  idle: { label: "لا مكالمة", cls: "border-border text-muted-foreground" },
  ringing: { label: "يرنّ…", cls: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  connected: { label: "متصل", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  busy: { label: "مشغول", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  unavailable: { label: "غير متاح", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
  ended: { label: "انتهت", cls: "border-border text-muted-foreground" },
};
export const CallState = ({ value }: { value: string }) => <Pill map={STATE} value={value} />;

export function EmployeePicker({ value, onChange, employees, exclude = [] }: { value: string; onChange: (k: string) => void; employees: any[]; exclude?: string[] }) {
  const groups = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const e of employees) if (!exclude.includes(e.key)) m.set(e.department, [...(m.get(e.department) ?? []), e]);
    return [...m.entries()];
  }, [employees, exclude]);
  return (
    <select className={cn(field, "min-w-64")} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">اختر موظفاً…</option>
      {groups.map(([d, es]) => (
        <optgroup key={d} label={dept(d)}>
          {es.map((e) => <option key={e.key} value={e.key}>{e.name} — {e.key}{e.available ? "" : " (موقوف)"}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export function Transcript({ lines, audioPath, playing, onPlay }: { lines: any[]; audioPath: (l: any) => string | null; playing: number | null; onPlay: (l: any) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [lines.length]);
  if (!lines.length) return <Empty>لا كلام بعد.</Empty>;
  return (
    <div className="space-y-2 max-h-[52vh] overflow-y-auto pl-1">
      {lines.map((l) => {
        const owner = l.speaker === "owner", sys = l.speaker === "system";
        const path = audioPath(l);
        return (
          <div key={l.id} className={cn("flex", owner ? "justify-start" : "justify-end", sys && "justify-center")}>
            <div className={cn("rounded-xl px-3 py-2 text-xs max-w-[85%] space-y-1",
              sys ? "bg-muted/40 text-muted-foreground text-[11px]" : owner ? "bg-primary/15 border border-primary/20" : "bg-card border border-card-border")}>
              {!sys && <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                <span>{owner ? "أنت" : l.name ?? l.employee_key}</span>
                {l.source === "voice" && <span>🎙️ {l.stt_model ?? ""}</span>}
                {l.kind && l.kind !== "owner" && <span>· {KIND[l.kind] ?? l.kind}</span>}
              </div>}
              <p className="whitespace-pre-wrap leading-relaxed">{l.text}</p>
              {list(l.evidence).length > 0 && <div className="flex flex-wrap gap-1">{list(l.evidence).map((e: string) => <span key={e} className="text-[10px] font-mono px-1.5 rounded bg-muted/50">{e}</span>)}</div>}
              {list(l.flags?.droppedEvidence).length > 0 && <div className="text-[10px] text-yellow-400">حُذف دليل غير موجود: {list(l.flags.droppedEvidence).join("، ")}</div>}
              {path && <button className="text-[10px] inline-flex items-center gap-1 text-primary hover:underline" onClick={() => onPlay(l)}>
                {playing === l.id ? <><VolumeX className="w-3 h-3" /> إيقاف</> : <><Volume2 className="w-3 h-3" /> استمع</>}
              </button>}
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}
export const KIND: Record<string, string> = { opening: "افتتاح", question: "سؤال", answer: "جواب", dissent: "مخالفة", reply: "رد", decision: "قرارات", readback: "قراءة القرارات" };

export function ActionItems({ items, tickets }: { items: any[]; tickets: any[] }) {
  if (!items.length) return <Empty>لا بنود عمل.</Empty>;
  const byId = new Map(tickets.map((t: any) => [Number(t.task_id), t]));
  return (
    <div className="space-y-1.5">
      {items.map((it: any, n: number) => {
        const tid = Number(it.taskId ?? it.task_id);
        const t = byId.get(tid);
        return (
          <div key={n} className="flex items-center gap-2 flex-wrap text-xs border border-card-border rounded-lg px-3 py-2">
            <span className="font-medium">{it.title}</span>
            <span className="text-muted-foreground">· {it.employeeKey ?? it.employee_key} · موعد {when(it.dueAt ?? it.due_at)}</span>
            <span className="text-muted-foreground">· {it.expectedOutcome ?? it.expected_outcome}</span>
            {t ? <Pill map={TASK} value={t.status} /> : null}
            {tid > 0 && <Link href="/org/tickets" className="text-[11px] text-primary hover:underline mr-auto">تذكرة #{tid} ← تنتظرك في التذاكر</Link>}
          </div>
        );
      })}
    </div>
  );
}

export default function CallScreen({ employees, initialKey, onChanged }: { employees: any[]; initialKey?: string | null; onChanged?: () => void }) {
  const [key, setKey] = useState(initialKey ?? "");
  const [lang, setLang] = useState<"auto" | "ar" | "en">("auto");
  const [data, setData] = useState<any>(null);
  const [phase, setPhase] = useState<"idle" | "ringing">("idle");
  const [busy, setBusy] = useState<null | "hearing" | "thinking" | "summary">(null);
  const [text, setText] = useState("");
  const [speakOn, setSpeakOn] = useState(true);
  const [paused, setPaused] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => { if (initialKey) setKey(initialKey); }, [initialKey]);

  const call = data?.call;
  const state = phase === "ringing" ? "ringing" : call?.state ?? "idle";
  const connected = state === "connected";
  const emp = employees.find((e) => e.key === (call?.employee_key ?? key));
  const lines = list(data?.transcript).map((l: any) => ({ ...l, name: emp?.name }));
  const audioPath = (l: any) => (call && (l.speaker === "employee" || (l.speaker === "owner" && l.has_audio)) ? `/calls/${call.id}/lines/${l.id}/audio` : null);
  const play = (l: any) => {
    if (playing === l.id) { stopPlayback(); setPlaying(null); return; }
    const p = audioPath(l); if (!p) return;
    void playLine(p, (on) => setPlaying(on ? l.id : null)).catch((e) => toast.error(e.message));
  };

  const after = (d: any) => {
    setData(d);
    const reply = list(d.added).filter((l: any) => l.speaker === "employee").at(-1);
    if (reply && speakOn) void playLine(`/calls/${d.call.id}/lines/${reply.id}/audio`, (on) => setPlaying(on ? reply.id : null)).catch((e) => toast.error(`الصوت: ${e.message} — النص ظاهر`));
  };

  const start = async () => {
    if (!key) return;
    setPhase("ringing"); setData(null);
    try { const d = await voice("/calls", { method: "POST", body: { employeeKey: key, lang } }); setData(d); onChanged?.(); }
    catch (e: any) { toast.error(e.message); }
    finally { setPhase("idle"); }
  };
  const sendText = async () => {
    const t = text.trim(); if (!t || !call) return;
    setText(""); setBusy("thinking");
    try { after(await voice(`/calls/${call.id}/turns`, { method: "POST", body: { text: t, lang } })); }
    catch (e: any) { toast.error(e.message); setText(t); }
    finally { setBusy(null); }
  };
  const rec = useRecorder(async (blob, ms) => {
    if (!call) return;
    setBusy("hearing");
    try { after(await voiceUpload(`/calls/${call.id}/turns`, blob, { durationMs: String(ms), lang })); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  });
  const summary = async () => {
    if (!call) return; setBusy("summary");
    try { setData(await voice(`/calls/${call.id}/summary`, { method: "POST", body: {} })); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const end = async () => {
    if (!call) return; stopPlayback(); setBusy("summary");
    try { setData(await voice(`/calls/${call.id}/end`, { method: "POST", body: {} })); onChanged?.(); } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const canTalk = connected && !busy && !paused;

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-4 flex items-center gap-2 flex-wrap")}>
        <EmployeePicker value={key} onChange={setKey} employees={employees} />
        <select className={field} value={lang} onChange={(e) => setLang(e.target.value as any)}>
          <option value="auto">اللغة: تلقائي</option><option value="ar">العربية</option><option value="en">English</option>
        </select>
        {!connected
          ? <button className={primary} disabled={!key || phase === "ringing"} onClick={() => void start()}>{phase === "ringing" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PhoneCall className="w-3.5 h-3.5" />} اتصل</button>
          : <button className={danger} disabled={!!busy} onClick={() => void end()}><PhoneOff className="w-3.5 h-3.5" /> إنهاء</button>}
        <span className="mr-auto flex items-center gap-2">
          <CallState value={state} />
          {call?.state_reason && <span className="text-[11px] text-muted-foreground">{call.state_reason}</span>}
        </span>
      </div>

      {call && (
        <Section title={`${emp?.name ?? call.employee_key} · ${call.employee_key}`} action={<span className="text-[11px] text-muted-foreground">نصف اتجاهي · نداءات النموذج {call.model_calls} · {call.recording ? "التسجيل مفعّل" : "التسجيل مطفأ (نص فقط)"}</span>}>
          <Transcript lines={lines} audioPath={audioPath} playing={playing} onPlay={play} />
          {connected && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                {rec.state === "recording"
                  ? <button className={cn(danger, "py-3 px-5")} onClick={rec.stop}><Square className="w-4 h-4" /> أرسل ({Math.round(rec.level * 100)}٪)</button>
                  : <button className={cn(primary, "py-3 px-5 select-none")} disabled={!canTalk || rec.state === "unsupported"}
                      onPointerDown={() => void rec.start()} onPointerUp={rec.stop} onPointerLeave={() => rec.state === "recording" && rec.stop()}
                      title="اضغط مطوّلاً وتكلم، ثم اترك">
                      <Mic className="w-4 h-4" /> اضغط وتكلم
                    </button>}
                <button className={ghost} disabled={!canTalk || rec.state === "recording"} onClick={() => void rec.start({ vad: true })}>تكلم ويتوقف وحده عند الصمت</button>
                <button className={ghost} disabled={playing == null} onClick={() => { stopPlayback(); setPlaying(null); }}><VolumeX className="w-3.5 h-3.5" /> قاطع</button>
                <button className={ghost} onClick={() => setSpeakOn((v) => !v)}>{speakOn ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />} {speakOn ? "الرد بصوت" : "الرد نصاً"}</button>
                <button className={ghost} onClick={() => { setPaused((v) => !v); stopPlayback(); }}>{paused ? "استئناف" : "إيقاف مؤقت"}</button>
                <button className={ghost} disabled={!!busy} onClick={() => void summary()}><FileText className="w-3.5 h-3.5" /> ملخص الآن</button>
                {busy && <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />{busy === "hearing" ? "يُفرَّغ صوتك ثم يجيب…" : busy === "thinking" ? "يفكر…" : "يلخّص…"}</span>}
              </div>
              {(rec.state === "denied" || rec.state === "unsupported") && <p className="text-[11px] text-yellow-400">الميكروفون غير مسموح أو غير مدعوم — اكتب بدلاً منه، يمرّ بالمسار نفسه.</p>}
              <div className="flex gap-2">
                <input className={cn(field, "flex-1")} value={text} disabled={!canTalk} placeholder="أو اكتب: صحّح، وجّه، اطلب ملخصاً…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void sendText()} />
                <button className={ghost} disabled={!canTalk || !text.trim()} onClick={() => void sendText()}><Send className="w-3.5 h-3.5" /> أرسل</button>
              </div>
              <p className="text-[10px] text-muted-foreground">لا ينفّذ الموظف شيئاً من المكالمة. ما يقترحه يصير تذكرة تنتظرك، و«موافق» بالكلام ليست موافقة — الموافقة من صفحة الموافقات.</p>
            </div>
          )}
          {(call.summary || call.summary_status) && (
            <div className="mt-3 text-xs border-t border-card-border pt-3">
              <div className="text-[11px] text-muted-foreground mb-1">الملخص ({call.summary_status === "validated" ? "كتبه الموظف" : call.summary_status === "insufficient" ? "لا كلام كافٍ" : call.summary_status === "model_unavailable" ? "النموذج لم يرد" : call.summary_status})</div>
              {call.summary && <p className="whitespace-pre-wrap">{call.summary}</p>}
            </div>
          )}
          <div className="mt-3"><div className="text-[11px] text-muted-foreground mb-1">بنود العمل والتذاكر</div><ActionItems items={list(data.actionItems)} tickets={list(data.tickets)} /></div>
        </Section>
      )}
    </div>
  );
}
