// ── The email team's dashboard ────────────────────────────────────
// Where the owner watches the team work without having to ask: the numbers
// (sent, opened, clicked, replied) over the period and by day, each list
// moving through its stages, who is hot, what every agent did, what waits
// for the owner's yes — and the controls: which lists the team works, how
// much say the owner keeps, and a line of instruction to any of the five.

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import {
  AlertTriangle, Bot, CheckCircle2, Eye, Flame, Folder, Inbox, List, Loader2, MessageCircle, MousePointerClick,
  Pause, Play, Reply, Rocket, Send, Settings2, ShieldCheck, Users, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { useFolders } from "@/components/Folders";
import { useEmailLists } from "./EmailLists";
import { EmailFlow } from "@/components/EmailFlow";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `قبل ${m} د`; const h = Math.round(m / 60); return h < 24 ? `قبل ${h} س` : `قبل ${Math.round(h / 24)} يوم`;
};
// Engagement series: the reference palette's first three slots, dark-surface steps (validated as a set).
const SERIES = [
  { key: "opened", label: "فتحوا", color: "#3987e5" },
  { key: "clicked", label: "نقروا", color: "#d95926" },
  { key: "replied", label: "ردّوا", color: "#199e70" },
] as const;
const ROLE_AR: Record<string, string> = { email: "نورة", email_strategist: "سلمى", email_followup: "يوسف", email_replies: "ليلى", email_guard: "ماجد", email_creator: "طارق" };
const TEMP: Record<string, { label: string; cls: string }> = {
  hot: { label: "حار", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  warm: { label: "دافئ", cls: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  cold: { label: "بارد", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
};

export function DashboardTab({ goMissions }: { goMissions: () => void }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(14);
  const { data: d, isLoading } = useQuery<any>({ queryKey: ["email-dashboard", days], queryFn: () => api(`/api/email/dashboard?days=${days}`), refetchInterval: 30_000 });
  const inv = () => { qc.invalidateQueries({ queryKey: ["email-dashboard"] }); qc.invalidateQueries({ queryKey: ["email-lists"] }); qc.invalidateQueries({ queryKey: ["email-missions"] }); };
  const save = useMutation({ mutationFn: (b: any) => api("/api/email/autopilot", { method: "PUT", body: JSON.stringify(b) }), onSuccess: () => { inv(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message) });
  const run = useMutation({
    mutationFn: () => api("/api/email/autopilot/run", { method: "POST" }),
    onSuccess: (r: any) => { inv(); toast[r.ran ? "success" : "info"](r.ran ? `جولة: ${n(r.waves)} موجة جديدة · ${n(r.nurtures)} متابعة · ${n(r.stages)} قائمة حُدّثت مراحلها${r.why ? ` — ${r.why}` : ""}` : r.why ?? "لم يحدث شيء"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const [showSettings, setShowSettings] = useState(false);

  if (isLoading || !d) return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  const k = d.kpi, ap = d.autopilot;
  const targets = (ap.listIds?.length ?? 0) + (ap.folderIds?.length ?? 0);

  return (
    <div className="space-y-4">
      {/* The switch */}
      <div className={cn(card, "p-4 flex items-center gap-3 flex-wrap", ap.enabled ? "border-primary/40" : "")}>
        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", ap.enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}><Bot className="w-5 h-5" /></div>
        <div className="flex-1 min-w-[14rem]">
          <p className="font-semibold text-sm flex items-center gap-2">
            الطيار الآلي للبريد {ap.enabled ? <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/15 text-primary flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" /> يعمل</span> : <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">متوقف</span>}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {targets ? `يعمل الفريق على ${n(ap.listIds?.length)} قائمة و${n(ap.folderIds?.length)} مجلد` : `يعمل الفريق على كل قوائم البريد (${n(d.lists.length)})`} · {ap.mode === "auto" ? "يُرسل تلقائياً بعد مراجعة ماجد" : "كل حملة تنتظر موافقتك"} · موجة {n(ap.waveSize)} · جولة كل ربع ساعة{ap.lastRunAt ? ` · آخر جولة ${ago(ap.lastRunAt)}` : ""}
          </p>
        </div>
        <select className={cn(input, "w-28 text-xs")} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>٧ أيام</option><option value={14}>١٤ يوماً</option><option value={30}>٣٠ يوماً</option><option value={90}>٩٠ يوماً</option>
        </select>
        <button onClick={() => setShowSettings(!showSettings)} className={ghost}><Settings2 className="w-3.5 h-3.5" /> الإعدادات</button>
        <button onClick={() => run.mutate()} disabled={run.isPending} className={ghost}>{run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />} جولة الآن</button>
        <button onClick={() => save.mutate({ enabled: !ap.enabled })} disabled={save.isPending} className={ap.enabled ? ghost : primary}>
          {ap.enabled ? <><Pause className="w-3.5 h-3.5" /> أوقف</> : <><Play className="w-3.5 h-3.5" /> شغّل</>}
        </button>
      </div>

      {showSettings && <AutopilotSettings ap={ap} sectors={d.sectors ?? []} onSave={(b) => save.mutate(b)} saving={save.isPending} onClose={() => setShowSettings(false)} />}

      <details className={cn(card, "p-4 group")} open={!d.campaigns?.length}>
        <summary className="cursor-pointer text-sm font-semibold flex items-center gap-2 list-none"><Rocket className="w-4 h-4 text-primary" /> مسار كل حملة — ماذا يحدث بعد الإرسال <span className="text-[11px] font-normal text-muted-foreground mr-auto">{({ light: "٣ رسائل", normal: "٤ رسائل", intense: "٦ رسائل خلال ٢١ يوماً" } as Record<string, string>)[d.path?.intensity] ?? ""} · {d.language === "ar" ? "بالعربية" : d.language === "both" ? "بالعربية والإنجليزية" : "بالإنجليزية"} — تُغيَّران من الإعدادات</span></summary>
        <div className="mt-3"><EmailFlow tracking={d.tracking} steps={d.path?.steps} firstAfterHours={d.path?.firstAfterHours} /></div>
      </details>

      {!d.configured && <Banner tone="red">لا مُرسِل مضبوط — لن يُرسل الفريق شيئاً حتى تُضبط إعدادات البريد.</Banner>}
      {d.lists.reduce((t: number, l: any) => t + l.sendable, 0) === 0 && (
        <div className={cn(card, "p-4 flex items-center gap-3 border-primary/40")}>
          <Users className="w-5 h-5 text-primary shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold">{d.lists.length ? "قوائم البريد فارغة" : "لا قوائم بريد بعد"}</p>
            <p className="text-[11px] text-muted-foreground">الفريق يعمل على عناوين حقيقية: ارفع ملف Excel وسيُصنَّف ويوضع في مجلد قطاعه، ثم يبدأ الطيار الآلي وحده.</p>
          </div>
          <Link href="/email/lists" className={primary}><List className="w-3.5 h-3.5" /> ارفع قائمة</Link>
        </div>
      )}
      {!d.tracking && (
        <Banner tone="yellow">
          الفتح والنقر لا يُقاسان بعد: يحتاجان رابطاً عاماً للتطبيق على الإنترنت (<code dir="ltr">SITE_URL</code>) تمر عبره صورة التتبع وروابط الرسائل. الردود تُقاس الآن، وقوائم «فتحوا» و«نقروا» تمتلئ حين يُفعَّل التتبع.
        </Banner>
      )}

      {d.approvals?.length > 0 && (
        <div className={cn(card, "p-3.5 border-yellow-500/40")}>
          <p className="text-sm font-semibold flex items-center gap-2"><Inbox className="w-4 h-4 text-yellow-400" /> {n(d.approvals.length)} حملة تنتظر موافقتك</p>
          <div className="mt-2 space-y-1">
            {d.approvals.map((a: any) => (
              <div key={a.id} className="text-xs flex items-center gap-2">
                <span className="text-muted-foreground">{ROLE_AR[a.agentRole ?? "email"] ?? "نورة"}:</span>
                <span className="font-medium truncate">{a.name}</span>
                {a.subject && <span className="text-muted-foreground truncate">— «{a.subject}»</span>}
              </div>
            ))}
          </div>
          <button onClick={goMissions} className={cn(primary, "mt-2.5")}><CheckCircle2 className="w-3.5 h-3.5" /> راجعها ووافق</button>
        </div>
      )}

      {/* The numbers */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        <Kpi icon={Send} label="أُرسل" value={n(k.sent)} sub={k.queued ? `${n(k.queued)} في الطابور` : `آخر ${n(days)} يوماً`} />
        <Kpi icon={Eye} label="فتحوا" value={n(k.opened)} sub={`${k.openRate}% · ${n(k.opens)} فتحة`} tone="text-[#3987e5]" muted={!d.tracking} />
        <Kpi icon={MousePointerClick} label="نقروا" value={n(k.clicked)} sub={`${k.clickRate}% · ${n(k.clicks)} نقرة`} tone="text-[#d95926]" muted={!d.tracking} />
        <Kpi icon={Reply} label="ردّوا" value={n(k.replied)} sub={`${k.replyRate}% من المرسل`} tone="text-[#199e70]" />
        <Kpi icon={AlertTriangle} label="ارتدّ" value={n(k.bounced)} sub={`${k.bounceRate}%`} tone={k.bounceRate >= 3 ? "text-red-400" : undefined} />
        <Kpi icon={Users} label="ألغوا الاشتراك" value={n(k.unsubscribed)} sub="لا يُراسَلون أبداً" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <div className={cn(card, "p-4")}>
          <p className="text-sm font-semibold">المُرسل يومياً</p>
          <p className="text-[11px] text-muted-foreground mb-3">عدد الرسائل التي خرجت كل يوم</p>
          <SentBars daily={d.daily} />
        </div>
        <div className={cn(card, "p-4")}>
          <p className="text-sm font-semibold">التفاعل يومياً</p>
          <p className="text-[11px] text-muted-foreground mb-3">رسائل فُتحت ونُقر فيها ورُدّ عليها في كل يوم</p>
          <EngagementLines daily={d.daily} />
        </div>
      </div>

      {/* The team */}
      <div className={card}>
        <div className="p-3.5 border-b border-card-border flex items-center gap-2">
          <Bot className="w-4 h-4 text-primary" /><p className="font-semibold text-sm">فريق البريد</p>
          <Link href="/employees" className="mr-auto text-[11px] text-primary hover:underline">الشخصية والمهام والمهارات ← فريق البوتات</Link>
        </div>
        <div className="grid md:grid-cols-3 xl:grid-cols-6 divide-y md:divide-y-0 md:divide-x md:divide-x-reverse divide-card-border">
          {d.team.map((t: any) => <AgentCard key={t.role} t={t} />)}
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_24rem] gap-4 items-start">
        <div className="space-y-4">
          <ListsFunnel lists={d.lists} />
          <HotLeads rows={d.hot} />
          <CampaignsTable rows={d.campaigns} />
        </div>
        <ActivityFeed rows={d.activity} />
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: "yellow" | "red"; children: React.ReactNode }) {
  return <div className={cn(card, "p-3 text-xs flex items-start gap-2", tone === "red" ? "border-red-500/40" : "border-yellow-500/30")}><AlertTriangle className={cn("w-4 h-4 shrink-0", tone === "red" ? "text-red-400" : "text-yellow-400")} /><p className="text-muted-foreground leading-relaxed">{children}</p></div>;
}

function Kpi({ icon: Icon, label, value, sub, tone, muted }: { icon: any; label: string; value: string; sub?: string; tone?: string; muted?: boolean }) {
  return (
    <div className={cn(card, "p-3.5", muted && "opacity-60")}>
      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5"><Icon className="w-3.5 h-3.5" /> {label}</p>
      <p className={cn("text-2xl font-bold leading-none mt-2", tone)}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-1.5">{sub}</p>}
    </div>
  );
}

// ── Charts ───────────────────────────────────────────────────────
const dayLabel = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("ar-AE", { day: "numeric", month: "short" });

function SentBars({ daily }: { daily: any[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.map((x) => x.sent));
  const W = 600, H = 160, pad = 24, bw = (W - pad) / daily.length;
  if (!daily.some((x) => x.sent)) return <Empty text="لم تُرسل رسائل في هذه الفترة." />;
  return (
    <div className="relative" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-44">
        {[0.5, 1].map((f) => <line key={f} x1={pad} x2={W} y1={H - H * f * 0.9} y2={H - H * f * 0.9} stroke="currentColor" className="text-card-border" strokeWidth={1} />)}
        <text x={0} y={H - H * 0.9 + 4} className="fill-muted-foreground" fontSize={10}>{max}</text>
        {daily.map((x, i) => {
          const h = (x.sent / max) * H * 0.9;
          return (
            <g key={x.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {h > 0 && <path d={`M${pad + i * bw + 2},${H} v${-(h - 4)} q0,-4 4,-4 h${Math.max(0, bw - 12)} q4,0 4,4 v${h - 4} z`} className="fill-primary" opacity={hover === null || hover === i ? 1 : 0.5} />}
              {(i % Math.ceil(daily.length / 7) === 0 || i === daily.length - 1) && <text x={pad + i * bw + bw / 2} y={H + 14} textAnchor="middle" fontSize={10} className="fill-muted-foreground">{dayLabel(x.day)}</text>}
            </g>
          );
        })}
      </svg>
      {hover !== null && <Tip x={(pad + hover * bw + bw / 2) / W} title={dayLabel(daily[hover].day)} rows={[["أُرسل", daily[hover].sent, "hsl(var(--primary))"]]} />}
    </div>
  );
}

function EngagementLines({ daily }: { daily: any[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...daily.flatMap((x) => SERIES.map((s) => x[s.key])));
  const W = 600, H = 160, pad = 24, step = (W - pad - 40) / Math.max(1, daily.length - 1);
  const X = (i: number) => pad + i * step, Y = (v: number) => H - (v / max) * H * 0.9;
  if (!daily.some((x) => x.opened || x.clicked || x.replied)) return <Empty text="لا تفاعل مسجّل في هذه الفترة بعد." />;
  return (
    <div className="relative">
      <div className="flex gap-3 mb-2 text-[11px]">
        {SERIES.map((s) => <span key={s.key} className="flex items-center gap-1.5 text-muted-foreground"><span className="w-3 h-0.5 rounded" style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <div className="relative" dir="ltr">
        <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full h-44" onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const x = ((e.clientX - r.left) / r.width) * W; setHover(Math.max(0, Math.min(daily.length - 1, Math.round((x - pad) / step)))); }}>
          {[0.5, 1].map((f) => <line key={f} x1={pad} x2={W - 40} y1={H - H * f * 0.9} y2={H - H * f * 0.9} stroke="currentColor" className="text-card-border" strokeWidth={1} />)}
          <text x={0} y={H - H * 0.9 + 4} className="fill-muted-foreground" fontSize={10}>{max}</text>
          {hover !== null && <line x1={X(hover)} x2={X(hover)} y1={0} y2={H} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} strokeDasharray="3 3" />}
          {SERIES.map((s) => {
            const pts = daily.map((x, i) => `${X(i)},${Y(x[s.key])}`).join(" ");
            const last = daily[daily.length - 1][s.key];
            return (
              <g key={s.key}>
                <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {hover !== null && <circle cx={X(hover)} cy={Y(daily[hover][s.key])} r={4} fill={s.color} stroke="hsl(var(--card))" strokeWidth={2} />}
                <text x={X(daily.length - 1) + 6} y={Y(last) + 4} fontSize={10} className="fill-muted-foreground">{last}</text>
              </g>
            );
          })}
          {daily.map((x, i) => (i % Math.ceil(daily.length / 7) === 0 || i === daily.length - 1) && <text key={x.day} x={X(i)} y={H + 14} textAnchor="middle" fontSize={10} className="fill-muted-foreground">{dayLabel(x.day)}</text>)}
        </svg>
        {hover !== null && <Tip x={X(hover) / W} title={dayLabel(daily[hover].day)} rows={SERIES.map((s) => [s.label, daily[hover][s.key], s.color])} />}
      </div>
    </div>
  );
}

function Tip({ x, title, rows }: { x: number; title: string; rows: Array<[string, number, string]> }) {
  return (
    <div className="absolute top-0 pointer-events-none bg-popover border border-card-border rounded-lg px-2.5 py-1.5 text-[11px] shadow-lg" style={{ left: `${Math.min(80, Math.max(0, x * 100 - 8))}%` }} dir="rtl">
      <p className="font-semibold mb-0.5">{title}</p>
      {rows.map(([l, v, c]) => <p key={l} className="flex items-center gap-1.5 text-muted-foreground"><span className="w-2 h-2 rounded-full" style={{ background: c }} />{l}: <b className="text-foreground">{v}</b></p>)}
    </div>
  );
}
const Empty = ({ text }: { text: string }) => <div className="h-44 flex items-center justify-center text-xs text-muted-foreground border border-dashed border-card-border rounded-lg">{text}</div>;

// ── The team ─────────────────────────────────────────────────────
export function AgentCard({ t }: { t: any }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const teach = useMutation({
    mutationFn: () => api(`/api/agents/${t.role}/memory`, { method: "POST", body: JSON.stringify({ content: text }) }),
    onSuccess: () => { setText(""); qc.invalidateQueries({ queryKey: ["agent-memory", t.role] }); toast.success(`${t.name} سيلتزم بهذا`); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="p-3.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xl">{t.avatar}</span>
        <div className="min-w-0">
          <p className="text-sm font-semibold flex items-center gap-1.5">{t.name}<span className={cn("w-1.5 h-1.5 rounded-full", t.isActive ? "bg-primary" : "bg-muted-foreground")} title={t.isActive ? "في الخدمة" : "متوقف"} /></p>
          <p className="text-[10px] text-muted-foreground truncate">{t.title}</p>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">{n(t.actions7d)} عملاً هذا الأسبوع{t.lastAt ? ` · آخرها ${ago(t.lastAt)}` : ""}</p>
      <div className="flex gap-1">
        <input className={cn(input, "text-[11px] py-1.5")} placeholder={`تعليمات لـ${t.name}…`} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) teach.mutate(); }} />
        <button onClick={() => teach.mutate()} disabled={!text.trim() || teach.isPending} className="px-2 rounded-lg bg-primary/15 text-primary disabled:opacity-40"><Send className="w-3 h-3" /></button>
      </div>
    </div>
  );
}

// ── The lists the team works, by stage ───────────────────────────
function ListsFunnel({ lists }: { lists: any[] }) {
  return (
    <div className={card}>
      <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><List className="w-4 h-4 text-primary" /> القوائم التي يعمل عليها الفريق</p></div>
      {!lists.length ? <p className="p-6 text-center text-xs text-muted-foreground">لم تُختر قوائم بعد — من «الإعدادات» أعلاه.</p> : (
        <div className="divide-y divide-card-border">
          {lists.map((l) => {
            const steps: Array<[string, number, string | null, number | null]> = [
              ["في القائمة", l.total, null, null], ["راسلناهم", l.reached, null, null],
              ["فتحوا", l.opened, "#3987e5", l.stages?.opened?.id ?? null], ["نقروا", l.clicked, "#d95926", l.stages?.clicked?.id ?? null], ["ردّوا", l.replied, "#199e70", l.stages?.replied?.id ?? null],
            ];
            return (
              <div key={l.id} className="p-3.5">
                <div className="flex items-center gap-2 mb-2">
                  <Link href={`/email/lists/${l.id}`} className="font-medium text-sm hover:text-primary">{l.name}</Link>
                  {l.sector && <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{l.sector}</span>}
                  <span className="text-[10px] text-muted-foreground mr-auto">{n(l.sendable)} قابل للإرسال · {n(l.total - l.reached)} لم يُراسَلوا بعد</span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {steps.map(([label, v, color, stageId]) => {
                    const pct = l.total ? Math.round((v / l.total) * 100) : 0;
                    const body = (
                      <div className="rounded-lg bg-muted/30 p-2 hover:bg-muted/50 transition-colors">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className="text-sm font-bold">{n(v)}</p>
                        <div className="h-1 rounded-full bg-muted mt-1 overflow-hidden" dir="ltr"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: color ?? "hsl(var(--primary))" }} /></div>
                      </div>
                    );
                    return stageId ? <Link key={label} href={`/email/lists/${stageId}`} title="افتح قائمة المرحلة">{body}</Link> : <div key={label}>{body}</div>;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HotLeads({ rows }: { rows: any[] }) {
  return (
    <div className={card}>
      <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><Flame className="w-4 h-4 text-red-400" /> العملاء الأكثر اهتماماً</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">من ردّ وصنّفته ليلى حاراً أو دافئاً، ومن نقر، ومن فتح أكثر من مرة.</p></div>
      {!rows.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا أحد بعد — يظهرون هنا مع أول ردّ أو نقرة.</p> : (
        <div className="overflow-x-auto max-h-96 overflow-y-auto">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-card"><tr className="text-muted-foreground"><th className="text-right p-2">الشركة</th><th className="text-right p-2">الحرارة</th><th className="text-right p-2">القطاع</th><th className="text-center p-2"><Eye className="w-3 h-3 inline" /></th><th className="text-center p-2"><MousePointerClick className="w-3 h-3 inline" /></th><th className="text-right p-2">آخر نشاط</th><th className="text-right p-2">تواصل</th></tr></thead>
            <tbody>{rows.map((r) => {
              const temp = (r.tags ?? []).find((t: string) => TEMP[t]);
              return (
                <tr key={r.id} className="border-t border-card-border">
                  <td className="p-2"><p className="font-medium">{r.company ?? r.name ?? "—"}</p><p className="font-mono text-muted-foreground" dir="ltr">{r.email}</p></td>
                  <td className="p-2">{temp ? <span className={cn("px-2 py-0.5 rounded-full border text-[10px]", TEMP[temp].cls)}>{TEMP[temp].label}</span> : r.lastRepliedAt ? "ردّ" : <span className="text-muted-foreground">تفاعل</span>}</td>
                  <td className="p-2 text-muted-foreground">{r.sector ?? "—"}</td>
                  <td className="p-2 text-center">{r.opens || ""}</td>
                  <td className="p-2 text-center">{r.clicks || ""}</td>
                  <td className="p-2 text-muted-foreground">{ago(r.lastAt)}</td>
                  <td className="p-2">{r.phone ? <a href={`https://wa.me/${String(r.phone).replace(/\D/g, "")}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary"><MessageCircle className="w-3 h-3" /> واتساب</a> : <a href={`mailto:${r.email}`} className="text-primary">بريد</a>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CampaignsTable({ rows }: { rows: any[] }) {
  if (!rows.length) return null;
  return (
    <div className={card}>
      <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><Rocket className="w-4 h-4 text-primary" /> آخر الحملات</p></div>
      <div className="overflow-x-auto"><table className="w-full text-[11px]">
        <thead><tr className="text-muted-foreground"><th className="text-right p-2">الحملة</th><th className="text-right p-2">من كتبها</th><th className="text-center p-2">أُرسل</th><th className="text-center p-2">فتح</th><th className="text-center p-2">نقر</th><th className="text-center p-2">ردّ</th></tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id} className="border-t border-card-border">
            <td className="p-2 font-medium">{c.name}</td>
            <td className="p-2 text-muted-foreground">{c.createdBy === "agent" ? "الفريق" : "أنت"}</td>
            <td className="p-2 text-center">{n(c.sent)}</td>
            <td className="p-2 text-center">{c.openRate}%</td>
            <td className="p-2 text-center">{c.clickRate}%</td>
            <td className="p-2 text-center">{n(c.replied)}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function ActivityFeed({ rows }: { rows: any[] }) {
  const AV: Record<string, string> = { email: "📧", email_strategist: "🎯", email_followup: "🔁", email_replies: "💬", email_guard: "🛡️", email_creator: "🧩" };
  return (
    <div className={cn(card, "lg:sticky lg:top-4")}>
      <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> ما فعله الفريق</p></div>
      <div className="max-h-[42rem] overflow-y-auto divide-y divide-card-border">
        {!rows.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا شيء بعد — شغّل الطيار الآلي واختر القوائم.</p>
          : rows.map((a) => (
            <div key={a.id} className="p-3 flex gap-2.5 text-xs">
              <span className="text-base leading-none">{AV[a.role] ?? "🤖"}</span>
              <div className="min-w-0">
                <p className="leading-relaxed"><b>{ROLE_AR[a.role] ?? a.role}</b> <span className="text-muted-foreground">{a.text}</span></p>
                <p className="text-[10px] text-muted-foreground/70 mt-0.5">{ago(a.createdAt)}</p>
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────
function AutopilotSettings({ ap, sectors = [], onSave, saving, onClose }: { ap: any; sectors?: Array<{ sector: string; n: number; unsent: number }>; onSave: (b: any) => void; saving: boolean; onClose: () => void }) {
  const { data: lists = [] } = useEmailLists();
  const { data: fd } = useFolders("email");
  const folders: any[] = fd?.folders ?? [];
  const [f, setF] = useState({ ...ap, listIds: [...(ap.listIds ?? [])], folderIds: [...(ap.folderIds ?? [])], sectors: [...(ap.sectors ?? [])] as string[] });
  const toggleSector = (s: string) => setF({ ...f, sectors: f.sectors.includes(s) ? f.sectors.filter((x: string) => x !== s) : [...f.sectors, s] });
  const own = useMemo(() => lists.filter((l: any) => !l.parentListId && !(l as any).stage), [lists]);
  const toggle = (k: "listIds" | "folderIds", id: number) => setF({ ...f, [k]: f[k].includes(id) ? f[k].filter((x: number) => x !== id) : [...f[k], id] });
  const num = (k: string, lo: number, hi: number) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: Math.min(hi, Math.max(lo, Number(e.target.value) || lo)) });
  return (
    <div className={cn(card, "p-4 space-y-4 border-primary/30")}>
      <div>
        <p className="text-sm font-semibold mb-1">على أي قوائم يعمل الفريق؟</p>
        <p className="text-[11px] text-muted-foreground mb-2">بلا اختيار = كل القوائم. مجلد كامل يشمل كل قائمة فيه، حتى ما تضيفه لاحقاً.</p>
        <div className="grid md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-card-border p-2 max-h-56 overflow-y-auto space-y-1">
            <p className="text-[10px] text-muted-foreground px-1">المجلدات</p>
            {!folders.length && <p className="text-[11px] text-muted-foreground px-1">لا مجلدات بريد.</p>}
            {folders.map((fo) => <label key={fo.id} className="flex items-center gap-2 text-xs px-1 py-1 rounded hover:bg-muted/40 cursor-pointer"><input type="checkbox" checked={f.folderIds.includes(fo.id)} onChange={() => toggle("folderIds", fo.id)} /><Folder className="w-3.5 h-3.5 text-muted-foreground" />{fo.name}</label>)}
          </div>
          <div className="rounded-lg border border-card-border p-2 max-h-56 overflow-y-auto space-y-1">
            <p className="text-[10px] text-muted-foreground px-1">القوائم</p>
            {!own.length && <p className="text-[11px] text-muted-foreground px-1">لا قوائم — ارفع ملفاً من «القوائم».</p>}
            {own.map((l: any) => <label key={l.id} className="flex items-center gap-2 text-xs px-1 py-1 rounded hover:bg-muted/40 cursor-pointer"><input type="checkbox" checked={f.listIds.includes(l.id)} onChange={() => toggle("listIds", l.id)} /><span className="truncate">{l.name}</span><span className="text-muted-foreground mr-auto">{n(l.sendable)}</span></label>)}
          </div>
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold mb-1">أي قطاعات؟</p>
        <p className="text-[11px] text-muted-foreground mb-2">سلمى تقسّم كل قائمة حسب القطاع، ولكل قطاع حملته الخاصة — حتى ٣ موجات معاً لكل قائمة. بلا اختيار = كل القطاعات.</p>
        <div className="flex flex-wrap gap-1.5">
          {sectors.length === 0 && <p className="text-[11px] text-muted-foreground">لا قطاعات بعد — تُصنّف العناوين عند رفع القائمة.</p>}
          {sectors.map((s) => (
            <button key={s.sector} type="button" onClick={() => toggleSector(s.sector)}
              className={cn("text-xs px-2.5 py-1 rounded-full border transition-colors", f.sectors.includes(s.sector) ? "bg-primary/15 border-primary/40 text-primary font-medium" : "border-card-border text-muted-foreground hover:border-primary/30")}>
              {s.sector} <span className="opacity-70">· {n(s.unsent)} لم يُراسَلوا</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-sm font-semibold mb-2">كم تتحكم أنت؟</p>
        <div className="grid md:grid-cols-2 gap-2">
          {[["approve", "كل حملة تنتظر موافقتي", "نورة تكتب، وأنت تراجع وتوافق قبل أي إرسال. موصى به في البداية."], ["auto", "تلقائي بالكامل", "يُرسل ما يكتبه الفريق بعد أن يراجعه ماجد. ما يجد فيه ماجد رقماً أو مبالغة يُحوَّل إليك."]].map(([k, t, s]) => (
            <button key={k} onClick={() => setF({ ...f, mode: k })} className={cn("text-right rounded-lg border p-3", f.mode === k ? "border-primary bg-primary/10" : "border-card-border")}>
              <p className="text-xs font-semibold">{t}</p><p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{s}</p>
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <label className="text-[11px] text-muted-foreground">حجم الموجة<input type="number" className={cn(input, "mt-1")} value={f.waveSize} onChange={num("waveSize", 10, 2000)} /></label>
        <label className="text-[11px] text-muted-foreground">أيام الراحة بين رسالتين<input type="number" className={cn(input, "mt-1")} value={f.quietDays} onChange={num("quietDays", 2, 30)} /></label>
        <label className="text-[11px] text-muted-foreground">أقصى رسائل للشخص شهرياً<input type="number" className={cn(input, "mt-1")} value={f.maxTouches} onChange={num("maxTouches", 1, 6)} /></label>
        <label className="text-[11px] text-muted-foreground">المتابعة بعد (ساعة)<input type="number" className={cn(input, "mt-1")} value={f.followAfterHours} onChange={num("followAfterHours", 24, 336)} /></label>
<label className="text-[11px] text-muted-foreground">لغة الإيميلات<select className={cn(input, "mt-1")} value={f.language ?? "en"} onChange={(e) => setF({ ...f, language: e.target.value })}><option value="en">🇬🇧 الإنجليزية (افتراضي)</option><option value="ar">العربية</option><option value="both">الاثنتان</option></select></label>
      </div>
      <div className="flex gap-2">
        <button onClick={() => { onSave({ listIds: f.listIds, folderIds: f.folderIds, sectors: f.sectors, mode: f.mode, waveSize: f.waveSize, quietDays: f.quietDays, maxTouches: f.maxTouches, followAfterHours: f.followAfterHours, language: f.language ?? "en" }); onClose(); }} disabled={saving} className={primary}><CheckCircle2 className="w-3.5 h-3.5" /> احفظ</button>
        <button onClick={onClose} className={ghost}>إغلاق</button>
      </div>
    </div>
  );
}
