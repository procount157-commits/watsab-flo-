// ── غرفة الفريق ───────────────────────────────────────────────────
// كل الموظفين في مكانٍ واحد، وكلامهم لبعض، ومن يتكلّم ومن يصمت، وتقييم
// المدير لكلٍّ منهم، ومكتب البيانات الذي ينظّف ويصنّف ما يُرفع.
//
// الصفحة لا تستدعي نموذجاً: كل ما فيها مقروءٌ من الرسائل والإيصالات
// والتقييمات، وتتحدّث كل عشر ثوانٍ. اضغط موظفاً فتصير المحادثات محادثاته
// وتُفتح بطاقته؛ اضغط خطاً في «من يكلّم من» فترى ما دار بين الاثنين.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, MessagesSquare, Users, Database, Activity, Send, X, ArrowLeftRight, ArrowLeft, Play, VolumeX } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";

const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `قبل ${m} د`; const h = Math.round(m / 60); return h < 24 ? `قبل ${h} س` : `قبل ${Math.round(h / 24)} يوم`;
};
const STATE: Record<string, { dot: string; label: string }> = {
  active: { dot: "bg-green-400", label: "يعمل اليوم" }, quiet: { dot: "bg-blue-400", label: "هادئ هذا الأسبوع" },
  idle: { dot: "bg-muted-foreground/40", label: "بلا حركة" }, attention: { dot: "bg-red-400", label: "يحتاج نظرة" }, off: { dot: "bg-muted-foreground/20", label: "موقوف" },
};
const TALK: Record<string, { label: string; cls: string }> = {
  both: { label: "يتكلّم ويُكلَّم", cls: "bg-green-500/15 text-green-400" }, speaks: { label: "يبلّغ ولا يُجاب", cls: "bg-blue-500/15 text-blue-400" },
  listens: { label: "يُكلَّم ولا يردّ", cls: "bg-yellow-500/15 text-yellow-400" }, silent: { label: "صامت", cls: "bg-red-500/15 text-red-400" }, off: { label: "موقوف", cls: "bg-muted text-muted-foreground" },
};
const GRADE: Record<string, string> = { strong: "text-green-400", ok: "text-blue-400", weak: "text-red-400", idle: "text-muted-foreground", off: "text-muted-foreground" };
const KIND: Record<string, string> = { handoff: "bg-primary/15 text-primary", directive: "bg-yellow-500/15 text-yellow-400", alert: "bg-red-500/15 text-red-400", report: "bg-blue-500/15 text-blue-400", question: "bg-purple-500/15 text-purple-400", answer: "bg-green-500/15 text-green-400" };

type Tab = "talk" | "pairs" | "data" | "events";

export default function TeamRoom() {
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [tab, setTab] = useState<Tab>("talk");
  const [who, setWho] = useState<string | null>(null);
  const [pair, setPair] = useState<[string, string] | null>(null);
  const [kind, setKind] = useState<string>("");
  const { data, isLoading } = useQuery<any>({ queryKey: ["team-room", days], queryFn: () => api(`/api/team/room?days=${days}`), refetchInterval: 10_000 });
  const run = useMutation({
    mutationFn: (path: string) => api(path, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: (d: any) => { toast.success(d.note ?? "بدأت"); setTimeout(() => qc.invalidateQueries({ queryKey: ["team-room"] }), 4000); },
    onError: (e: Error) => toast.error(e.message),
  });

  const people: any[] = data?.people ?? [];
  const byRole = useMemo(() => new Map(people.map((p) => [p.role, p])), [people]);
  const messages: any[] = useMemo(() => (data?.messages ?? []).filter((m: any) =>
    (!who || m.from === who || m.to === who) &&
    (!pair || ((m.from === pair[0] && m.to === pair[1]) || (m.from === pair[1] && m.to === pair[0]))) &&
    (!kind || m.kind === kind)), [data, who, pair, kind]);

  if (isLoading) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>;
  const s = data?.stats ?? {};
  const pick = (role: string | null) => { setWho(role); setPair(null); if (role) setTab("talk"); };

  return (
    <div className="p-5 space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">غرفة الفريق</h1>
          <p className="text-xs text-muted-foreground mt-0.5">كل الموظفين، وكلامهم لبعض، وتقييم مديرهم — يتحدّث كل عشر ثوانٍ</p>
        </div>
        <div className="flex items-center gap-1.5 mr-auto">
          {[1, 7, 30].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cn("px-2.5 py-1.5 rounded-lg text-[11px] border", days === d ? "bg-primary/15 text-primary border-primary/30" : "border-card-border")}>{d === 1 ? "اليوم" : `${d} يوماً`}</button>
          ))}
          <button onClick={() => run.mutate("/api/team/wa-manager/run")} disabled={run.isPending} className={ghost}><Play className="w-3 h-3" /> دورة شمّة (واتساب)</button>
          <button onClick={() => run.mutate("/api/email/manager/run")} disabled={run.isPending} className={ghost}><Play className="w-3 h-3" /> دورة منصور (بريد)</button>
        </div>
      </div>

      {/* الجواب عن «هل يتكلّمون؟» برقمه */}
      <div className={cn(card, "p-4")}>
        <p className="text-sm leading-relaxed">{data?.verdict}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
          <Mini label="على رأس العمل" v={`${s.active ?? 0} / ${s.people ?? 0}`} />
          <Mini label="تبادلوا رسائل" v={s.talking ?? 0} tone="text-green-400" />
          <Mini label="صامتون" v={s.silent ?? 0} tone={(s.silent ?? 0) > 0 ? "text-red-400" : undefined} />
          <Mini label={`رسائل في ${days === 1 ? "اليوم" : `${days} يوماً`}`} v={s.messages ?? 0} sub={`${s.messages1d ?? 0} اليوم`} />
          <Mini label="خطوط باتجاهين" v={`${s.twoWay ?? 0} / ${s.pairs ?? 0}`} />
          <Mini label="ضعيفو التقييم" v={s.weak ?? 0} sub={`${s.evaluated ?? 0} قُيّموا`} tone={(s.weak ?? 0) > 0 ? "text-red-400" : undefined} />
        </div>
      </div>

      <div className="grid xl:grid-cols-[19rem_1fr_22rem] lg:grid-cols-[18rem_1fr] gap-4 items-start">
        {/* ── الموظفون بمكاتبهم ── */}
        <div className={cn(card, "max-h-[46rem] overflow-y-auto")}>
          <button onClick={() => pick(null)} className={cn("w-full text-right p-3 border-b border-card-border text-xs font-semibold flex items-center gap-2", !who && "bg-primary/10 text-primary")}>
            <Users className="w-3.5 h-3.5" /> كل الموظفين ({people.length})
          </button>
          {(data?.desks ?? []).map((d: any) => (
            <div key={d.key}>
              <p className="px-3 pt-3 pb-1 text-[10px] font-semibold text-muted-foreground">{d.label} · يقوده {d.leadName}</p>
              {[d.lead, ...d.members.filter((m: string) => m !== d.lead)].map((role: string) => {
                const p = byRole.get(role); if (!p) return null;
                const st = STATE[p.state] ?? STATE.idle!, tk = TALK[p.talk] ?? TALK.silent!;
                return (
                  <button key={role} onClick={() => pick(role)} className={cn("w-full text-right px-3 py-2 hover:bg-muted/40 flex items-center gap-2.5", who === role && "bg-muted/60")}>
                    <span className="relative w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm shrink-0">{p.avatar ?? p.name.slice(0, 1)}
                      <span className={cn("absolute -bottom-0.5 -left-0.5 w-2.5 h-2.5 rounded-full border-2 border-card", st.dot)} title={st.label} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="text-xs font-semibold block truncate">{p.name}{role === d.lead && <span className="text-[9px] text-primary mr-1">· مدير</span>}</span>
                      <span className="text-[10px] text-muted-foreground block truncate">{p.title} · {p.doing}</span>
                    </span>
                    <span className="flex flex-col items-end gap-0.5 shrink-0">
                      {p.evaluation?.score != null && <span className={cn("text-xs font-bold tabular-nums", GRADE[p.evaluation.grade])}>{p.evaluation.score}</span>}
                      <span className={cn("text-[9px] px-1.5 py-0.5 rounded", tk.cls)}>{tk.label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── الوسط ── */}
        <div className="space-y-3 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {([["talk", "المحادثات", MessagesSquare], ["pairs", "من يكلّم من", ArrowLeftRight], ["data", "مكتب البيانات", Database], ["events", "الحركة", Activity]] as const).map(([k, l, I]) => (
              <button key={k} onClick={() => setTab(k)} className={cn("flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border", tab === k ? "bg-primary/15 text-primary border-primary/30" : "border-card-border hover:border-primary/40")}><I className="w-3.5 h-3.5" />{l}</button>
            ))}
            {(who || pair) && (
              <button onClick={() => { setWho(null); setPair(null); }} className={cn(ghost, "mr-auto py-1.5")}>
                <X className="w-3 h-3" /> {pair ? `${data.names[pair[0]]} ⇄ ${data.names[pair[1]]}` : byRole.get(who!)?.name}
              </button>
            )}
          </div>

          {tab === "talk" && (
            <div className={cn(card, "overflow-hidden")}>
              <div className="p-2.5 border-b border-card-border flex flex-wrap items-center gap-1.5">
                {["", "handoff", "directive", "report", "alert"].map((k) => (
                  <button key={k} onClick={() => setKind(k)} className={cn("px-2 py-1 rounded text-[10px] border", kind === k ? "border-primary/40 text-primary" : "border-card-border text-muted-foreground")}>
                    {k === "" ? "الكل" : { handoff: "تسليم", directive: "توجيه", report: "تقرير", alert: "تنبيه" }[k]}
                  </button>
                ))}
                <span className="text-[10px] text-muted-foreground mr-auto">{messages.length} رسالة</span>
              </div>
              <div className="max-h-[40rem] overflow-y-auto">
                {messages.length === 0 && <p className="p-8 text-xs text-muted-foreground text-center">{who ? "لم يكتب لأحد ولم يكتب له أحد — صامتٌ في هذه الفترة." : "لا رسائل بعد. شغّل دورة المدير من الأعلى: كل تسليمٍ فيها رسالة."}</p>}
                {messages.map((m: any) => (
                  <div key={m.id} className="p-3 border-b border-card-border last:border-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <button onClick={() => pick(m.from)} className="text-xs font-semibold hover:text-primary">{m.fromName}</button>
                      <ArrowLeft className="w-3 h-3 text-muted-foreground" />
                      <button onClick={() => m.to !== "all" && pick(m.to)} className="text-xs font-semibold hover:text-primary">{m.toName}</button>
                      <span className={cn("text-[9px] px-1.5 py-0.5 rounded", KIND[m.kind] ?? "bg-muted")}>{m.kindLabel}</span>
                      {!m.readAt && m.to !== "all" && <span className="text-[9px] text-yellow-400">لم تُقرأ بعد</span>}
                      <span className="text-[10px] text-muted-foreground mr-auto">{ago(m.at)}</span>
                    </div>
                    <p className="text-xs leading-relaxed mt-1.5 whitespace-pre-wrap" dir="auto">{m.body}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "pairs" && (
            <div className={cn(card, "overflow-hidden")}>
              <p className="p-3 text-[11px] text-muted-foreground border-b border-card-border">كل خطٍّ بين موظفَين في الفترة. الخط باتجاهٍ واحد يعني أن واحداً يبلّغ والآخر لا يجيب — وهذا ما كان عليه الفريق كله.</p>
              {(data?.pairs ?? []).length === 0 && <p className="p-8 text-xs text-muted-foreground text-center">لا خطوط في هذه الفترة.</p>}
              {(data?.pairs ?? []).map((p: any, i: number) => (
                <button key={i} onClick={() => { setPair([p.from, p.to]); setWho(null); setTab("talk"); }} className="w-full text-right p-3 border-b border-card-border last:border-0 hover:bg-muted/40 flex items-center gap-2">
                  <span className="text-xs font-semibold w-24 truncate">{p.fromName}</span>
                  {p.twoWay ? <ArrowLeftRight className="w-3.5 h-3.5 text-green-400 shrink-0" /> : <ArrowLeft className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className="text-xs font-semibold w-24 truncate">{p.toName}</span>
                  <span className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden"><span className="block h-full bg-primary/60" style={{ width: `${Math.min(100, (p.n / Math.max(1, data.pairs[0].n)) * 100)}%` }} /></span>
                  <span className="text-xs font-bold tabular-nums w-10 text-left">{p.n}</span>
                  <span className="text-[10px] text-muted-foreground w-20 text-left">{ago(p.last)}</span>
                </button>
              ))}
            </div>
          )}

          {tab === "data" && <DataDesk />}

          {tab === "events" && (
            <div className={cn(card, "max-h-[42rem] overflow-y-auto")}>
              {(data?.events ?? []).filter((e: any) => !who || e.node === who || e.edge === who).map((e: any) => (
                <div key={e.id} className="p-2.5 border-b border-card-border last:border-0 flex items-start gap-2">
                  <span className={cn("w-1.5 h-1.5 rounded-full mt-1.5 shrink-0", e.status === "failed" ? "bg-red-400" : e.status === "blocked" ? "bg-yellow-400" : "bg-green-400")} />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs"><b>{e.nodeName}</b>{e.edgeName ? <> ← <b>{e.edgeName}</b></> : null} <span className="text-muted-foreground">· {e.label}</span></p>
                    {e.why && <p className="text-[11px] text-muted-foreground mt-0.5 truncate" dir="auto">{e.why}</p>}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{ago(e.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── بطاقة الموظف ── */}
        <div className="lg:col-span-2 xl:col-span-1">{who && byRole.get(who) ? <Person p={byRole.get(who)} onClose={() => setWho(null)} /> : (
          <div className={cn(card, "p-5 text-xs text-muted-foreground leading-relaxed")}>
            <VolumeX className="w-5 h-5 mb-2 opacity-50" />
            اضغط موظفاً لترى تقييم مديره له بأرقامه، ومهمته، وموقعه في القراف، ومحادثاته — واكتب له توجيهاً يدخل تعليماته في عمله التالي.
          </div>
        )}</div>
      </div>
    </div>
  );
}

function Mini({ label, v, sub, tone }: { label: string; v: number | string; sub?: string; tone?: string }) {
  return (<div className="rounded-lg border border-card-border p-2.5"><p className="text-[10px] text-muted-foreground">{label}</p><p className={cn("text-lg font-bold tabular-nums", tone)}>{v}</p>{sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}</div>);
}

function Person({ p, onClose }: { p: any; onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [open, setOpen] = useState<"" | "node" | "work">("");
  const { data } = useQuery<any>({ queryKey: ["team-room-one", p.role], queryFn: () => api(`/api/team/room/${p.role}`), refetchInterval: 15_000 });
  const send = useMutation({
    mutationFn: () => api(`/api/team/room/${p.role}/say`, { method: "POST", body: JSON.stringify({ body: text }) }),
    onSuccess: () => { setText(""); toast.success(`وصل ${p.name} — يقرؤه قبل عمله التالي`); qc.invalidateQueries({ queryKey: ["team-room"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const ev = p.evaluation, f = ev?.facts;
  return (
    <div className={cn(card, "p-4 space-y-3 max-h-[46rem] overflow-y-auto")}>
      <div className="flex items-start gap-3">
        <span className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-lg shrink-0">{p.avatar ?? p.name.slice(0, 1)}</span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{p.name}</p>
          <p className="text-[11px] text-muted-foreground">{p.title}{p.managerName ? ` · مديره ${p.managerName}` : ""}</p>
          <p className="text-[11px] mt-0.5">{STATE[p.state]?.label} · {p.doing} · {ago(p.last)}</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>

      {/* تقييم المدير */}
      <div className="rounded-lg border border-card-border p-3 space-y-1.5">
        <div className="flex items-baseline gap-2">
          <p className="text-xs font-semibold">تقييم {p.managerName ?? "المدير"}</p>
          {ev ? <><span className={cn("text-xl font-bold tabular-nums mr-auto", GRADE[ev.grade])}>{ev.score ?? "—"}</span><span className={cn("text-[11px]", GRADE[ev.grade])}>{ev.gradeLabel}</span></>
            : <span className="text-[11px] text-muted-foreground mr-auto">لم يُقيَّم بعد — يُقيَّم في دورة مديره</span>}
        </div>
        {ev && <>
          {ev.prevScore != null && ev.score != null && <p className="text-[11px] text-muted-foreground">الدورة السابقة {ev.prevScore} ← الآن {ev.score}{ev.score - ev.prevScore >= 5 ? " ▲" : ev.prevScore - ev.score >= 5 ? " ▼" : " — لم يتحرّك"}</p>}
          <p className="text-xs leading-relaxed">{ev.finding}</p>
          {ev.task && <p className="text-xs leading-relaxed rounded bg-yellow-500/10 text-yellow-400 p-2"><b>مهمته: </b>{ev.task}</p>}
          {f && <p className="text-[10px] text-muted-foreground leading-relaxed">في {f.days} أيام: {f.done} تمّ · {f.failed} تعثّر · {f.held} حجز{f.decided ? ` · صاحب العمل أرسل ${f.approved} من ${f.decided} مسودة كما هي` : ""} · قال {f.said} · قيل له {f.heard}</p>}
        </>}
      </div>

      {/* من يكلّم */}
      <div>
        <p className="text-xs font-semibold mb-1">يكلّم</p>
        {p.partners.length ? <div className="flex flex-wrap gap-1">{p.partners.map((n: string) => <span key={n} className="text-[10px] px-1.5 py-0.5 rounded bg-muted">{n}</span>)}</div>
          : <p className="text-[11px] text-red-400">لا أحد في هذه الفترة.</p>}
      </div>

      {p.charter && (
        <div className="text-[11px] leading-relaxed space-y-0.5">
          <p className="text-xs font-semibold mb-1">ميثاقه</p>
          <p><span className="text-muted-foreground">مهمته: </span>{p.charter.mission}</p>
          <p><span className="text-muted-foreground">يستلم: </span>{p.charter.receives}</p>
          <p><span className="text-muted-foreground">يسلّم: </span>{p.charter.delivers}</p>
          <p><span className="text-muted-foreground">يُقاس بـ: </span>{p.charter.measured}</p>
          {p.charter.notMine && <p><span className="text-muted-foreground">ليس عمله: </span>{p.charter.notMine}</p>}
        </div>
      )}

      <div className="flex gap-1.5">
        {data?.node && <button onClick={() => setOpen(open === "node" ? "" : "node")} className={cn(ghost, "py-1.5", open === "node" && "border-primary/50 text-primary")}>موقعه في القراف</button>}
        <button onClick={() => setOpen(open === "work" ? "" : "work")} className={cn(ghost, "py-1.5", open === "work" && "border-primary/50 text-primary")}>آخر ما فعل</button>
      </div>
      {open === "node" && <pre className="text-[11px] whitespace-pre-wrap leading-relaxed rounded-lg bg-muted/40 p-3" dir="auto">{data?.node}</pre>}
      {open === "work" && (
        <div className="rounded-lg border border-card-border max-h-64 overflow-y-auto">
          {(data?.receipts ?? []).length === 0 && <p className="p-3 text-[11px] text-muted-foreground">لا إيصالات.</p>}
          {(data?.receipts ?? []).map((r: any, i: number) => (
            <div key={i} className="p-2 border-b border-card-border last:border-0">
              <p className="text-[11px]"><span className={cn(r.status === "failed" ? "text-red-400" : r.status === "blocked" ? "text-yellow-400" : "text-green-400")}>●</span> {r.action}{r.edge && r.edge !== "all" ? ` ← ${r.edge}` : ""} <span className="text-muted-foreground">· {ago(r.at)}</span></p>
              {r.why && <p className="text-[10px] text-muted-foreground mt-0.5" dir="auto">{r.why}</p>}
            </div>
          ))}
        </div>
      )}

      {/* توجيهٌ من صاحب العمل */}
      <div className="pt-1">
        <p className="text-xs font-semibold mb-1.5">اكتب له</p>
        <textarea className={cn(input, "min-h-[4.5rem] text-xs")} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={`توجيهٌ لـ${p.name} — يدخل تعليماته في عمله التالي`} />
        <button onClick={() => send.mutate()} disabled={send.isPending || text.trim().length < 3} className={cn(primary, "mt-1.5")}>
          {send.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} أرسل التوجيه
        </button>
      </div>
    </div>
  );
}

const BUCKET_TONE: Record<string, string> = { aml: "bg-primary", both: "bg-primary/60", services: "bg-blue-400", secondary: "bg-muted-foreground/40", competitor: "bg-yellow-500/60", unknown: "bg-red-400/70" };

function DataDesk() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["data-desk"], queryFn: () => api("/api/data-desk"), refetchInterval: 15_000 });
  const run = useMutation({
    mutationFn: (channel: string) => api("/api/data-desk/run", { method: "POST", body: JSON.stringify({ channel }) }),
    onSuccess: (d: any) => { toast.success(d.note); setTimeout(() => qc.invalidateQueries({ queryKey: ["data-desk"] }), 5000); },
    onError: (e: Error) => toast.error(e.message),
  });
  const file = useMutation({
    mutationFn: (listId: number) => api("/api/data-desk/run", { method: "POST", body: JSON.stringify({ channel: "whatsapp", listId, file: true }) }),
    onSuccess: () => toast.success("بدأ الفرز: الغرباء يذهبون إلى قوائم قطاعاتهم"), onError: (e: Error) => toast.error(e.message),
  });
  if (isLoading) return <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>;
  const B = data?.buckets ?? {};
  const Channel = ({ k, label, cleaner, classifier }: { k: "whatsapp" | "email"; label: string; cleaner: string; classifier: string }) => {
    const r = data?.[k]?.reading; if (!r) return null;
    const order = ["aml", "both", "services", "secondary", "competitor", "unknown"];
    return (
      <div className={cn(card, "p-3.5 space-y-2.5")}>
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">{label}</p>
          <span className="text-[11px] text-muted-foreground">{r.total.toLocaleString("ar-AE")} جهة · {cleaner} ينظّف ← {classifier} تصنّف</span>
          <button onClick={() => run.mutate(k)} disabled={run.isPending} className={cn(ghost, "mr-auto py-1.5")}><Play className="w-3 h-3" /> جولة الآن</button>
        </div>
        <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
          {order.map((b) => r.byBucket[b] > 0 && <span key={b} className={BUCKET_TONE[b]} style={{ width: `${(r.byBucket[b] / Math.max(1, r.total)) * 100}%` }} title={`${B[b]?.label}: ${r.byBucket[b]}`} />)}
        </div>
        <div className="grid sm:grid-cols-2 gap-x-4 gap-y-1">
          {order.filter((b) => r.byBucket[b] > 0).map((b) => (
            <p key={b} className="text-[11px] flex items-center gap-1.5"><span className={cn("w-2 h-2 rounded-sm shrink-0", BUCKET_TONE[b])} /><b className="tabular-nums">{r.byBucket[b].toLocaleString("ar-AE")}</b> {B[b]?.label}</p>
          ))}
        </div>
        {r.byHintOnly > 0 && <p className="text-[11px] text-yellow-400 leading-relaxed">{r.byHintOnly.toLocaleString("ar-AE")} جهة قطاعها موروثٌ من اسم الملف لا من اسمها — المصنّف يقرؤها على دفعات في كل جولة.</p>}
        <div className="flex flex-wrap gap-1">
          {r.bySector.slice(0, 10).map((x: any) => <span key={x.sector} className="text-[10px] px-1.5 py-0.5 rounded bg-muted" title={`من اسمها ${x.own} · قرأها المصنّف ${x.model} · من اسم الملف ${x.hint}`}>{x.sector} {x.n}</span>)}
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-3">
      <pre className={cn(card, "p-3.5 text-[11px] whitespace-pre-wrap leading-relaxed")} dir="auto">{data?.targets}</pre>
      <Channel k="whatsapp" label="أرقام الواتساب" cleaner={data?.roles?.whatsapp?.cleanerName} classifier={data?.roles?.whatsapp?.classifierName} />
      <Channel k="email" label="عناوين البريد" cleaner={data?.roles?.email?.cleanerName} classifier={data?.roles?.email?.classifierName} />
      <div className={cn(card, "overflow-hidden")}>
        <p className="p-3 text-xs font-semibold border-b border-card-border">آخر الجولات — عند كل رفع، وفي كل دورة للمدير</p>
        {(data?.runs ?? []).length === 0 && <p className="p-6 text-xs text-muted-foreground text-center">لا جولات بعد. ارفع ملفاً، أو اضغط «جولة الآن».</p>}
        {(data?.runs ?? []).map((r: any) => (
          <div key={r.id} className="p-3 border-b border-card-border last:border-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-semibold">{r.listName}</span>
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted">{r.channel === "email" ? "بريد" : "واتساب"} · {{ upload: "عند الرفع", manager: "دورة المدير", owner: "بطلبك" }[r.trigger as string] ?? r.trigger}</span>
              <span className="text-[10px] text-muted-foreground mr-auto">{ago(r.at)}</span>
            </div>
            <p className="text-[11px] leading-relaxed">{r.report.headline}</p>
            {r.report.clearance?.notes?.length > 0 && <p className="text-[10px] text-muted-foreground">التنظيف: {r.report.clearance.notes.join(" · ")}</p>}
            {r.report.model?.asked > 0 && <p className="text-[10px] text-muted-foreground">المصنّف قرأ {r.report.model.asked} اسماً وحسم {r.report.model.settled}{r.report.model.left ? ` · بقي ${r.report.model.left}` : ""}</p>}
            {r.report.filed?.length > 0 && <p className="text-[10px] text-primary">نُقل: {r.report.filed.map((x: any) => `${x.moved} إلى «${x.to}»`).join(" · ")}</p>}
            {r.channel === "whatsapp" && r.listId && r.report.reading?.strangers > 0 && !r.report.filed?.length && (
              <button onClick={() => file.mutate(r.listId)} disabled={file.isPending} className={cn(ghost, "py-1 text-[10px]")}>انقل {r.report.reading.strangers} غريباً إلى قوائم قطاعاتهم</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
