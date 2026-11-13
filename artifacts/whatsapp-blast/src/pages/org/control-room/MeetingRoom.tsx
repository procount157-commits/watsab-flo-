// ── غرفة الاجتماع ─────────────────────────────────────────────────
// المدير التنفيذي يدير: افتتاح، سؤالٌ لكل حاضر وجوابه بدوره، دعوة للمخالفة، قرارات، قراءتها.
// كل خطوة بطلب («الخطوة التالية»)؛ الصوت بالتناوب لا في آن واحد، ويقال ذلك صراحةً.

import { useState } from "react";
import { toast } from "sonner";
import { CalendarClock, ChevronLeft, Crown, Loader2, Mic, Plus, Send, Sparkles, Square, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Section, card, danger, field, ghost, list, primary, when } from "../shared";
import { ActionItems, EmployeePicker, Transcript } from "./CallScreen";
import { playLine, stopPlayback, useRecorder, voice, voiceUpload } from "./voice";

const PHASE: Record<string, string> = { opening: "الافتتاح", round: "جولة الحضور", dissent: "المخالفة", decisions: "القرارات", closed: "مغلق" };
const STATE: Record<string, string> = { scheduled: "مجدول", in_progress: "جارٍ", ended: "انتهى", cancelled: "أُلغي" };

type Att = { employeeKey: string; reason?: string | null; recommendedBy: "owner" | "ceo" };

function NewMeeting({ employees, onOpen }: { employees: any[]; onOpen: (d: any) => void }) {
  const [objective, setObjective] = useState("");
  const [agenda, setAgenda] = useState<string[]>([""]);
  const [scope, setScope] = useState("");
  const [limit, setLimit] = useState(20);
  const [schedule, setSchedule] = useState("");
  const [pick, setPick] = useState("");
  const [atts, setAtts] = useState<Att[]>([]);
  const [recs, setRecs] = useState<any>(null);
  const [busy, setBusy] = useState<null | "rec" | "go">(null);
  const others = employees.filter((e) => !e.ceo);
  const add = (a: Att) => setAtts((xs) => (xs.some((x) => x.employeeKey === a.employeeKey) || xs.length >= 6 ? xs : [...xs, a]));
  const recommend = async () => {
    setBusy("rec");
    try { setRecs(await voice("/meetings/recommend", { method: "POST", body: { objective, agenda: agenda.filter(Boolean) } })); }
    catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const go = async () => {
    setBusy("go");
    try {
      const d = await voice("/meetings", { method: "POST", body: { objective, agenda: agenda.filter(Boolean), scope: scope || null, timeLimitMin: limit, attendees: atts, scheduledAt: schedule ? new Date(schedule).toISOString() : null } });
      onOpen(d);
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  return (
    <Section title="اجتماع جديد مع المدير التنفيذي">
      <div className="space-y-3 text-xs">
        <input className={cn(field, "w-full")} placeholder="الهدف: ما الذي يجب أن نخرج به؟" value={objective} onChange={(e) => setObjective(e.target.value)} />
        <div className="space-y-1.5">
          <div className="text-[11px] text-muted-foreground">جدول الأعمال</div>
          {agenda.map((a, n) => (
            <div key={n} className="flex gap-2">
              <input className={cn(field, "flex-1")} value={a} placeholder={`بند ${n + 1}`} onChange={(e) => setAgenda((xs) => xs.map((x, i) => (i === n ? e.target.value : x)))} />
              {agenda.length > 1 && <button className={ghost} onClick={() => setAgenda((xs) => xs.filter((_, i) => i !== n))}><X className="w-3 h-3" /></button>}
            </div>
          ))}
          {agenda.length < 8 && <button className={ghost} onClick={() => setAgenda((xs) => [...xs, ""])}><Plus className="w-3 h-3" /> بند</button>}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <input className={cn(field, "flex-1 min-w-0 sm:min-w-48 basis-full sm:basis-auto")} placeholder="النطاق (اختياري): قسم، حملة…" value={scope} onChange={(e) => setScope(e.target.value)} />
          <label className="flex items-center gap-1">المدة <input type="number" min={5} max={60} className={cn(field, "w-16")} value={limit} onChange={(e) => setLimit(Number(e.target.value) || 20)} /> دقيقة</label>
          <label className="flex items-center gap-1 flex-wrap"><CalendarClock className="w-3.5 h-3.5" /> موعد لاحق <input type="datetime-local" className={field} value={schedule} onChange={(e) => setSchedule(e.target.value)} /></label>
        </div>
        {schedule && <p className="text-[11px] text-yellow-400">الموعد يُحفظ داخل Flow Hub فقط — لا تقويم خارجي ولا دعوات (محجوب: لا تكامل تقويم). يبدأ حين تفتحه.</p>}
        <div className="flex gap-2 items-center flex-wrap">
          <EmployeePicker value={pick} onChange={setPick} employees={others} exclude={atts.map((a) => a.employeeKey)} />
          <button className={ghost} disabled={!pick} onClick={() => { add({ employeeKey: pick, recommendedBy: "owner" }); setPick(""); }}><Plus className="w-3 h-3" /> أضف</button>
          <button className={ghost} disabled={objective.trim().length < 3 || !!busy} onClick={() => void recommend()}>{busy === "rec" ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} اطلب ترشيح المدير</button>
        </div>
        {recs && (
          <div className="border border-card-border rounded-lg p-2 space-y-1.5">
            {recs.note && <Empty>{recs.note}</Empty>}
            {list(recs.recommendations).map((r: any) => (
              <div key={r.employeeKey} className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{r.name}</span><span className="font-mono text-[10px] text-muted-foreground">{r.employeeKey}</span>
                <span className="text-muted-foreground">{list(r.reasons).join("؛ ")}</span>
                {list(r.evidence).map((e: string) => <span key={e} className="text-[10px] font-mono px-1 rounded bg-muted/50">{e}</span>)}
                <button className={cn(ghost, "mr-auto")} onClick={() => add({ employeeKey: r.employeeKey, reason: list(r.reasons).join("، "), recommendedBy: "ceo" })}><Plus className="w-3 h-3" /> أضف</button>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-1.5 flex-wrap">
          {atts.map((a) => {
            const e = employees.find((x) => x.key === a.employeeKey);
            return <span key={a.employeeKey} className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-card-border">
              {e?.name ?? a.employeeKey}{a.recommendedBy === "ceo" ? " ★" : ""}
              <button onClick={() => setAtts((xs) => xs.filter((x) => x.employeeKey !== a.employeeKey))}><X className="w-3 h-3" /></button>
            </span>;
          })}
        </div>
        <button className={primary} disabled={objective.trim().length < 3 || !atts.length || !!busy} onClick={() => void go()}>
          {busy === "go" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Users className="w-3.5 h-3.5" />} {schedule ? "احفظ الموعد" : "ابدأ الآن"}
        </button>
      </div>
    </Section>
  );
}

export function Room({ data, setData, employees, onChanged }: { data: any; setData: (d: any) => void; employees: any[]; onChanged?: () => void }) {
  const m = data.meeting;
  const [busy, setBusy] = useState<null | string>(null);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [playing, setPlaying] = useState<number | null>(null);
  const names = new Map(employees.map((e) => [e.key, e.name]));
  const lines = list(data.minutes).map((l: any) => ({ ...l, name: l.speaker === "ceo" ? "المدير التنفيذي" : names.get(l.employee_key) ?? l.employee_key }));
  const audioPath = (l: any) => (l.speaker === "ceo" || l.speaker === "employee" || l.has_audio ? `/meetings/${m.id}/minutes/${l.id}/audio` : null);
  const play = (l: any) => {
    if (playing === l.id) { stopPlayback(); setPlaying(null); return; }
    void playLine(audioPath(l)!, (on) => setPlaying(on ? l.id : null)).catch((e) => toast.error(e.message));
  };
  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    try { const d = await fn(); const prev = list(data.minutes).length; setData(d); onChanged?.();
      const fresh = list(d.minutes).slice(prev).filter((l: any) => l.speaker !== "system" && l.speaker !== "owner").at(-1);
      if (fresh) void playLine(`/meetings/${m.id}/minutes/${fresh.id}/audio`, (on) => setPlaying(on ? fresh.id : null)).catch(() => {});
    } catch (e: any) { toast.error(e.message); } finally { setBusy(null); }
  };
  const rec = useRecorder((blob, ms) => void act("say", () => voiceUpload(`/meetings/${m.id}/say`, blob, { durationMs: String(ms), lang: m.lang, ...(to ? { to } : {}) })));
  const live = m.state === "in_progress";
  const present = list(data.attendees).filter((a: any) => a.status === "present");
  return (
    <div className="space-y-3">
      <div className={cn(card, "p-4 space-y-2 text-xs")}>
        <div className="flex items-center gap-2 flex-wrap">
          <Crown className="w-4 h-4 text-primary" /><span className="font-semibold">{m.objective}</span>
          <span className="text-muted-foreground">· {STATE[m.state] ?? m.state} · {PHASE[m.phase] ?? m.phase}</span>
          <span className="mr-auto text-[11px] text-muted-foreground">نداءات النموذج {m.budget?.used}/{m.budget?.max} · {m.deadline ? `ينتهي الوقت ${when(m.deadline)}` : `${m.time_limit_min} دقيقة`}</span>
        </div>
        {list(m.agenda).length > 0 && <div className="text-muted-foreground">جدول الأعمال: {list(m.agenda).map((a: string, n: number) => `${n + 1}) ${a}`).join("  ")}</div>}
        <div className="flex gap-1.5 flex-wrap">
          {list(data.attendees).map((a: any) => <span key={a.id} className={cn("px-2 py-0.5 rounded-full border text-[11px]", a.status === "present" ? "border-green-500/30 text-green-400" : "border-red-500/30 text-red-400")} title={a.reason ?? a.status_reason ?? ""}>
            {a.turn_order}. {a.name ?? a.employee_key}{a.status === "present" ? "" : ` — ${a.status_reason}`}{a.recommended_by === "ceo" ? " ★" : ""}
          </span>)}
        </div>
        <p className="text-[10px] text-yellow-400">صوت بالتناوب (نصف اتجاهي): يتكلم طرفٌ واحد في كل مرة. ليس اجتماعاً صوتياً متزامناً.</p>
      </div>
      <Section title="المحضر">
        <Transcript lines={lines} audioPath={audioPath} playing={playing} onPlay={play} />
        {m.state === "scheduled" && <button className={cn(primary, "mt-3")} disabled={!!busy} onClick={() => void act("start", () => voice(`/meetings/${m.id}/start`, { method: "POST", body: {} }))}>ابدأ الاجتماع الآن</button>}
        {live && (
          <div className="mt-3 space-y-2">
            <div className="flex gap-2 flex-wrap items-center">
              <button className={primary} disabled={!!busy || rec.state === "recording"} onClick={() => void act("next", () => voice(`/meetings/${m.id}/next`, { method: "POST", body: {} }))}>
                {busy === "next" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronLeft className="w-3.5 h-3.5" />} الخطوة التالية ({PHASE[m.phase]})
              </button>
              <select className={field} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">أوجّه كلامي إلى: المدير التنفيذي</option>
                {present.map((a: any) => <option key={a.employee_key} value={a.employee_key}>{a.name ?? a.employee_key}</option>)}
              </select>
              {rec.state === "recording"
                ? <button className={danger} onClick={rec.stop}><Square className="w-3.5 h-3.5" /> أرسل</button>
                : <button className={ghost} disabled={!!busy || rec.state === "unsupported"} onPointerDown={() => void rec.start()} onPointerUp={rec.stop}><Mic className="w-3.5 h-3.5" /> اضغط وتكلم</button>}
              <button className={ghost} disabled={playing == null} onClick={() => { stopPlayback(); setPlaying(null); }}>قاطع</button>
              <button className={danger} disabled={!!busy} onClick={() => void act("end", () => voice(`/meetings/${m.id}/end`, { method: "POST", body: {} }))}>إنهاء بلا قرارات</button>
              {busy && busy !== "next" && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            </div>
            {rec.state === "denied" && <p className="text-[11px] text-yellow-400">الميكروفون غير مسموح — اكتب بدلاً منه.</p>}
            <div className="flex gap-2">
              <input className={cn(field, "flex-1")} value={text} placeholder="اسأل، اعترض، اطلب الدليل…" onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { const t = text.trim(); setText(""); void act("say", () => voice(`/meetings/${m.id}/say`, { method: "POST", body: { text: t, to: to || null } })); } }} />
              <button className={ghost} disabled={!text.trim() || !!busy} onClick={() => { const t = text.trim(); setText(""); void act("say", () => voice(`/meetings/${m.id}/say`, { method: "POST", body: { text: t, to: to || null } })); }}><Send className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        )}
      </Section>
      {list(data.minutes).filter((x: any) => x.kind === "decision").map((d: any) => (
        <Section key={d.id} title="القرارات">
          <div className="grid md:grid-cols-3 gap-3 text-xs">
            <div><div className="text-[11px] text-muted-foreground mb-1">مؤكَّد بدليل</div>{list(d.verified?.verified).map((f: any, n: number) => <p key={n}>• {f.text} <span className="font-mono text-[10px]">{list(f.evidence).join(" ")}</span></p>)}{!list(d.verified?.verified).length && <Empty>لا شيء مؤكد بدليل.</Empty>}</div>
            <div><div className="text-[11px] text-muted-foreground mb-1">تقديرات</div>{list(d.verified?.estimates).map((x: string, n: number) => <p key={n}>• {x}</p>)}</div>
            <div><div className="text-[11px] text-muted-foreground mb-1">قرارات لك وحدك</div>{list(d.verified?.ownerDecisions).map((x: string, n: number) => <p key={n}>• {x}</p>)}</div>
          </div>
        </Section>
      ))}
      <Section title="بنود العمل → تذاكر"><ActionItems items={list(data.actionItems)} tickets={list(data.tickets)} /></Section>
    </div>
  );
}

export default function MeetingRoom({ employees, onChanged }: { employees: any[]; onChanged?: () => void }) {
  const [data, setData] = useState<any>(null);
  return data
    ? <div className="space-y-3"><button className={ghost} onClick={() => setData(null)}>← اجتماع جديد</button><Room data={data} setData={setData} employees={employees} onChanged={onChanged} /></div>
    : <NewMeeting employees={employees} onOpen={(d) => { setData(d); onChanged?.(); }} />;
}
