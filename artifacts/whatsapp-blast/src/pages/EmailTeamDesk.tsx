// ── مكتب الأربعة ──────────────────────────────────────────────────
// أربعة متخصّصين، كلٌّ بمحرّكه. والواجهة تعرض أرقام المحرّك بلا استدعاء
// نموذج — فالأرقام متاحةٌ دائماً — ويُستدعى النموذج حين يُطلب حكمٌ
// عليها، فيكتب الموظف تقريره بصوته.
//
//   🗂️ بدور  كل الداتا مُصنَّفة: حالةٌ واحدة لكل جهة، وجودة كل صف
//   ↻  مريم  خطّة لكل حالة، بالعدد المؤهّل لا الكلي
//   📈 حصّة  العنوان والساعة والقطاع — مقارنةً لا مطلقاً
//   📒 راشد  هل يطابق المعروضُ ما حدث

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Loader2, Sparkles, RefreshCw, AlertTriangle, CheckCircle2, Wrench,
  Users, Repeat, TrendingUp, ClipboardList, ChevronRight, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";
import { EmailManagerPanel } from "./EmailManagerPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";

const WHO = [
  { role: "email_data",      name: "بدور", title: "تصنيف البيانات",   icon: Users,         tab: "data" },
  { role: "email_retarget",  name: "مريم", title: "إعادة الاستهداف",  icon: Repeat,        tab: "retarget" },
  { role: "email_opens",     name: "حصّة", title: "الفتح والتوقيت",   icon: TrendingUp,    tab: "opens" },
  { role: "email_registrar", name: "راشد", title: "سجل الإرسال",      icon: ClipboardList, tab: "ledger" },
] as const;

export function EmailTeamDesk() {
  const [tab, setTab] = useState<"data" | "retarget" | "opens" | "ledger">("data");
  const qc = useQueryClient();
  const { data: reports } = useQuery<any>({ queryKey: ["email-specialists"], queryFn: () => api("/api/email/specialists"), refetchInterval: 60_000 });
  const round = useMutation({
    mutationFn: () => api("/api/email/specialists/round", { method: "POST" }),
    onSuccess: (d: any) => toast.success(d.note ?? "بدأت الجولة"),
    onError: (e: Error) => toast.error(e.message),
  });
  const run = useMutation({
    mutationFn: (role: string) => api(`/api/email/specialists/${role}/run`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["email-specialists"] }); toast.success("كُتب التقرير"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const byRole = (r: string) => (reports?.specialists ?? []).find((x: any) => x.role === r);

  return (
    <div className="space-y-4">
      <EmailManagerPanel />
      <div className="flex flex-wrap items-center gap-2">
        {WHO.map((w) => {
          const rep = byRole(w.role);
          return (
            <button key={w.role} onClick={() => setTab(w.tab)}
              className={cn("flex items-center gap-2 px-3 py-2 rounded-lg text-xs border transition-colors",
                tab === w.tab ? "bg-primary/15 text-primary border-primary/30" : "border-card-border hover:border-primary/40")}>
              <w.icon className="w-3.5 h-3.5" />
              <span className="font-semibold">{w.name}</span>
              <span className="text-muted-foreground">{w.title}</span>
              {rep?.at && <span className="w-1.5 h-1.5 rounded-full bg-green-400" title={`آخر تقرير ${new Date(rep.at).toLocaleString("ar-AE")}`} />}
            </button>
          );
        })}
        <button onClick={() => round.mutate()} disabled={round.isPending} className={cn(ghost, "mr-auto")}>
          {round.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} جولة الأربعة
        </button>
      </div>

      <Report who={WHO.find((w) => w.tab === tab)!} report={byRole(WHO.find((w) => w.tab === tab)!.role)} onRun={() => run.mutate(WHO.find((w) => w.tab === tab)!.role)} running={run.isPending} />

      {tab === "data"     && <DataTab />}
      {tab === "retarget" && <RetargetTab />}
      {tab === "opens"    && <OpensTab />}
      {tab === "ledger"   && <LedgerTab />}
    </div>
  );
}

/** تقرير الموظف بصوته — أو زرٌّ يطلبه. */
function Report({ who, report, onRun, running }: { who: typeof WHO[number]; report: any; onRun: () => void; running: boolean }) {
  return (
    <div className={cn(card, "p-3.5 space-y-2")}>
      <div className="flex items-center gap-2">
        <who.icon className="w-4 h-4 text-primary" />
        <p className="text-sm font-semibold">{who.name}</p>
        <span className="text-[11px] text-muted-foreground">{report?.title ?? who.title}</span>
        {report?.at && <span className="text-[10px] text-muted-foreground">· {new Date(report.at).toLocaleString("ar-AE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>}
        <button onClick={onRun} disabled={running} className={cn(ghost, "mr-auto py-1 px-2")}>
          {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} حكمٌ جديد
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">{report?.question}</p>
      {report?.text
        ? <pre className="text-xs whitespace-pre-wrap leading-relaxed rounded-lg bg-muted/40 p-3" dir="auto">{report.text}</pre>
        : <p className="text-xs text-muted-foreground rounded-lg bg-muted/30 p-3">لم يكتب تقريراً بعد. الأرقام تحته متاحة الآن — واضغط «حكمٌ جديد» ليقرأها ويحكم.</p>}
    </div>
  );
}

// ── بدور ──────────────────────────────────────────────────────────
function DataTab() {
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-data"], queryFn: () => api("/api/email/data") });
  const [open, setOpen] = useState<string | null>(null);
  if (isLoading) return <Spin />;
  const counts = (data?.counts ?? []).filter((c: any) => c.n > 0);
  const s = data?.summary ?? {};
  return (
    <div className="space-y-4">
      <div className={cn(card, "p-3.5")}>
        <p className="text-sm leading-relaxed">{data?.headline}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
          <Mini label="المجموع" v={data?.total} />
          <Mini label="قابلة للمراسلة" v={s.reachable} tone="text-primary" />
          <Mini label="دافئة" v={s.warm} tone={s.warm > 0 ? "text-green-400" : undefined} />
          <Mini label="لُمست" v={s.touched} />
          <Mini label="لم تُلمَس" v={s.untouched} />
          <Mini label="مُغلقة" v={s.closed} tone="text-muted-foreground" />
        </div>
      </div>

      <div className={cn(card, "overflow-hidden")}>
        <p className="p-3 text-xs font-semibold border-b border-card-border">الحالات — كل جهة في حالةٍ واحدة، ومجموعها {counts.reduce((a: number, c: any) => a + c.n, 0)} = {data?.total}</p>
        {counts.map((c: any) => (
          <div key={c.cohort}>
            <button onClick={() => setOpen(open === c.cohort ? null : c.cohort)}
              className="w-full text-right p-3 border-b border-card-border hover:bg-muted/40 flex items-start gap-3">
              <span className="text-sm font-bold tabular-nums w-14 shrink-0">{c.n.toLocaleString("ar-AE")}</span>
              <span className="flex-1 min-w-0">
                <span className="text-xs font-semibold block">{c.info.label}{c.info.retarget && <span className="text-[10px] text-primary mr-1.5">↻ قابلة لإعادة الاستهداف</span>}</span>
                <span className="text-[11px] text-muted-foreground block mt-0.5">{c.info.next}</span>
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">{c.info.owner}</span>
              <ChevronRight className={cn("w-3.5 h-3.5 shrink-0 transition-transform", open === c.cohort && "rotate-90")} />
            </button>
            {open === c.cohort && <CohortRows cohort={c.cohort} />}
          </div>
        ))}
      </div>

      {(data?.quality?.flags ?? []).length > 0 && (
        <div className={cn(card, "overflow-hidden")}>
          <p className="p-3 text-xs font-semibold border-b border-card-border">جودة الصفوف — عيوبٌ تتجمّع، مرتَّبةً بالأثر</p>
          {data.quality.flags.map((f: any) => (
            <div key={f.id} className="p-3 border-b border-card-border last:border-0 flex items-start gap-3">
              <span className="text-sm font-bold tabular-nums w-14 shrink-0">{f.n.toLocaleString("ar-AE")}</span>
              <div className="min-w-0">
                <p className="text-xs font-semibold">{f.label}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{f.why}</p>
                <p className="text-[11px] text-primary mt-1">{f.fix}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CohortRows({ cohort }: { cohort: string }) {
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-cohort", cohort], queryFn: () => api(`/api/email/data/${cohort}?limit=25`) });
  if (isLoading) return <div className="p-4"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground mx-auto" /></div>;
  const rows = data?.rows ?? [];
  if (!rows.length) return <p className="p-4 text-[11px] text-muted-foreground text-center">لا صفوف.</p>;
  return (
    <div className="bg-muted/20 border-b border-card-border overflow-x-auto">
      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.id} className="border-b border-card-border/50 last:border-0">
              <td className="p-2 max-w-[16rem]"><p className="truncate font-semibold">{r.company ?? r.name ?? "—"}</p><p className="truncate text-muted-foreground font-mono" dir="ltr">{r.email}</p></td>
              <td className="p-2 text-muted-foreground whitespace-nowrap">{r.sector ?? "—"}</td>
              <td className="p-2 text-muted-foreground whitespace-nowrap">أُرسل {r.sent ?? 0}{r.opens ? ` · فتح ${r.opens}` : ""}{r.clicks ? ` · نقر ${r.clicks}` : ""}</td>
              <td className="p-2 text-muted-foreground whitespace-nowrap">{r.lastSentAt ? new Date(r.lastSentAt).toLocaleDateString("ar-AE", { month: "short", day: "numeric" }) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= 25 && <p className="p-2 text-[10px] text-muted-foreground text-center">تُعرض ٢٥ صفاً — الباقي في «الجمهور».</p>}
    </div>
  );
}

// ── مريم ──────────────────────────────────────────────────────────
function RetargetTab() {
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-retarget"], queryFn: () => api("/api/email/retarget") });
  if (isLoading) return <Spin />;
  return (
    <div className="space-y-4">
      <p className={cn(card, "p-3.5 text-sm leading-relaxed")}>{data?.headline}</p>
      {(data?.plans ?? []).map((p: any) => (
        <div key={p.cohort} className={cn(card, "p-3.5 space-y-2", p.blocked && "opacity-60")}>
          <div className="flex items-baseline gap-2 flex-wrap">
            <p className="text-sm font-semibold">{p.label}</p>
            <span className="text-xs text-primary font-bold">{p.eligible.toLocaleString("ar-AE")} مؤهّلة</span>
            <span className="text-[11px] text-muted-foreground">من {p.inCohort.toLocaleString("ar-AE")}</span>
            {p.blocked && <span className="text-[11px] text-yellow-400 mr-auto">⛔ {p.blocked}</span>}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{p.angle.brief}</p>
          <div className="grid sm:grid-cols-2 gap-2 text-[11px]">
            <p className="rounded-lg bg-muted/40 p-2"><span className="text-muted-foreground">العنوان: </span>{p.angle.subjectHint}</p>
            <p className="rounded-lg bg-primary/10 text-primary p-2"><span className="opacity-70">الدعوة: </span>{p.angle.cta}</p>
          </div>
          {p.excluded.length > 0 && (
            <p className="text-[11px] text-muted-foreground">يُستبعَد: {p.excluded.map((x: any) => `${x.reason} (${x.n})`).join(" · ")}</p>
          )}
          <details className="text-[11px]">
            <summary className="cursor-pointer text-muted-foreground">الشروط المطبَّقة على الموجة</summary>
            <ul className="mt-1 space-y-0.5 pr-4">{p.guards.map((g: string, i: number) => <li key={i} className="list-disc text-muted-foreground">{g}</li>)}</ul>
          </details>
        </div>
      ))}
      {(data?.excludedCohorts ?? []).length > 0 && (
        <div className={cn(card, "overflow-hidden")}>
          <p className="p-3 text-xs font-semibold border-b border-card-border">لا تُمسّ — ولا يُطلب فيها استثناء</p>
          {data.excludedCohorts.map((x: any, i: number) => (
            <div key={i} className="p-3 border-b border-card-border last:border-0 flex items-start gap-3">
              <span className="text-sm font-bold tabular-nums w-14 shrink-0 text-muted-foreground">{x.n.toLocaleString("ar-AE")}</span>
              <div><p className="text-xs font-semibold">{x.label}</p><p className="text-[11px] text-muted-foreground mt-0.5">{x.why}</p></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── حصّة ──────────────────────────────────────────────────────────
function OpensTab() {
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-opens"], queryFn: () => api("/api/email/opens") });
  if (isLoading) return <Spin />;
  const t = data?.totals ?? {};
  return (
    <div className="space-y-4">
      {!data?.measurable && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-3.5">
          <p className="text-sm font-semibold text-yellow-400 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> الفتح لا يُقاس</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{data?.blocker}</p>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Mini label="خرجت" v={t.sent} />
        <Mini label="فُتحت" v={t.opened} sub={data?.measurable ? `${t.openRate}%` : "لا قياس"} tone={data?.measurable ? undefined : "text-muted-foreground"} />
        <Mini label="نُقر" v={t.clicked} sub={data?.measurable ? `${t.clickRate}%` : "لا قياس"} tone={data?.measurable ? undefined : "text-muted-foreground"} />
        <Mini label="ردّوا" v={t.replied} sub={`${t.replyRate}%`} tone="text-green-400" />
      </div>

      <div className={cn(card, "p-3.5 space-y-2")}>
        <p className="text-xs font-semibold">ما يُفعل في الموجة القادمة</p>
        <ul className="space-y-1.5">{(data?.actions ?? []).map((a: string, i: number) => (
          <li key={i} className="text-xs leading-relaxed flex gap-2"><span className="text-primary shrink-0">•</span>{a}</li>
        ))}</ul>
      </div>

      {(data?.subjects ?? []).length > 0 && (
        <Table title="قوالب العناوين — ٣٠ رسالة على الأقل لكل واحد" head={["العنوان", "أُرسل", "فتح", "ردّ"]}
          rows={data.subjects.map((s: any) => [s.subject, s.sent, data.measurable ? `${s.rate}%` : "—", s.replied])} />
      )}
      {(data?.hours ?? []).length > 0 && (
        <Table title="الساعات — بتوقيت الإمارات" head={["الساعة", "أُرسل", "فتح", "ردّ"]}
          rows={data.hours.filter((h: any) => h.sent > 0).map((h: any) => [`${h.hour}:00`, h.sent, h.opened, h.replied])} />
      )}
      {(data?.sectors ?? []).length > 0 && (
        <Table title="القطاعات" head={["القطاع", "أُرسل", "فتح", "ردّ"]}
          rows={data.sectors.map((s: any) => [s.sector, s.sent, s.opened, s.replied])} />
      )}
    </div>
  );
}

// ── راشد ──────────────────────────────────────────────────────────
function LedgerTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-ledger"], queryFn: () => api("/api/email/ledger") });
  const fix = useMutation({
    mutationFn: (what: string) => api("/api/email/ledger/repair", { method: "POST", body: JSON.stringify({ what }) }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["email-ledger"] }); toast.success(`${d.what} — ${d.done} صفاً`); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (isLoading) return <Spin />;
  return (
    <div className="space-y-4">
      <p className={cn(card, "p-3.5 text-sm leading-relaxed")}>{data?.verdict}</p>
      <div className={cn(card, "overflow-hidden")}>
        {(data?.findings ?? []).map((f: any) => (
          <div key={f.id} className="p-3 border-b border-card-border last:border-0 flex items-start gap-3">
            {f.state === "fail" ? <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              : f.state === "warn" ? <AlertTriangle className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
              : <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{f.title}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{f.detail}</p>
              {f.means && <p className="text-[11px] mt-1 leading-relaxed">{f.means}</p>}
              {f.fix && <p className="text-[11px] text-primary mt-1">{f.fix}</p>}
            </div>
            {f.repair && (
              <button onClick={() => fix.mutate(f.repair)} disabled={fix.isPending} className={cn(ghost, "shrink-0 py-1 px-2")}>
                {fix.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Wrench className="w-3 h-3" />} أصلحها
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── أدوات ─────────────────────────────────────────────────────────
const Spin = () => <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>;

function Mini({ label, v, sub, tone }: { label: string; v?: number; sub?: string; tone?: string }) {
  return (
    <div className={cn(card, "p-2.5")}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-bold", tone)}>{(v ?? 0).toLocaleString("ar-AE")}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <div className={cn(card, "overflow-hidden")}>
      <p className="p-3 text-xs font-semibold border-b border-card-border">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="bg-muted/40 text-muted-foreground">
            <tr>{head.map((h, i) => <th key={i} className={cn("p-2 font-semibold", i === 0 ? "text-right" : "text-center")}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-card-border">
                {r.map((c, j) => <td key={j} className={cn("p-2", j === 0 ? "max-w-[22rem] truncate" : "text-center tabular-nums")} dir={j === 0 ? "auto" : undefined}>{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
