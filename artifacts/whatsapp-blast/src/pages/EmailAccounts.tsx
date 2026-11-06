// ── Target Accounts Desk ──────────────────────────────────────────
// The owner (2026-11-06): every working day the desk researches ten real-
// estate companies, finds the AML decision maker, his email and LinkedIn,
// and writes to him personally. Four employees: فهد picks the companies,
// نوف finds the person, سالم finds and verifies the email, هند writes.
// LinkedIn notes go out by the owner's own hand — this page hands them over
// one by one: copy, open the profile, mark it sent.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2, Play, Loader2, Settings2, KeyRound, Copy, ExternalLink, Check, CalendarCheck, X, ChevronDown,
  Globe, MapPin, Radio, UserCheck, Users, MailCheck, Send, Eye, Reply, Linkedin, Trash2, Hammer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const pill = "text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap";
const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
const when = (d?: string | null) => (d ? new Date(d).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `قبل ${m} د`; const h = Math.round(m / 60); return h < 24 ? `قبل ${h} س` : `قبل ${Math.round(h / 24)} يوم`;
};

type Person = {
  id: number | string; name: string; title: string | null; why: string | null; email: string | null; emailStatus: string | null;
  emailFallback: boolean; linkedinUrl: string | null; linkedinSearchUrl: string; isDecisionMaker: boolean;
};
type Account = {
  id: number | string; company: string; domain: string; website: string | null; city: string | null; sector: string | null;
  signal: string | null; signalSource: string | null; status: string; createdAt: string; people: Person[];
  email: { to: string; subject: string; body: string; followups: Array<{ afterDays: number; subject: string; body: string }>; sentAt: string | null; openedAt: string | null; repliedAt: string | null } | null;
  linkedin: { message: string; done: boolean } | null; notes: string | null;
};
type Today = {
  date: string; perDay: number; enabled: boolean; hasSearchKey: boolean; running: boolean; lastRunAt: string | null; accounts: Account[];
  stats: { week: { companies: number; people: number; verified: number; sent: number; opened: number; replied: number; meetings: number } };
  feed: Array<{ at: string; role: string; name: string; text: string }>;
};

const STATUS: Record<string, { label: string; cls: string }> = {
  researching:  { label: "يُبحث",                    cls: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  ready:        { label: "جاهز",                     cls: "border-primary/40 bg-primary/10 text-primary" },
  no_person:    { label: "لم يُعرف صاحب القرار",     cls: "border-border text-muted-foreground" },
  no_email:     { label: "لا بريد مؤكد",             cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  needs_review: { label: "يحتاج مراجعة",            cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  sent:         { label: "أُرسل",                    cls: "border-blue-500/30 bg-blue-500/10 text-blue-300" },
  replied:      { label: "ردّ",                      cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  meeting:      { label: "اجتماع",                   cls: "border-green-500/40 bg-green-500/15 text-green-300" },
  skipped:      { label: "تُرك",                     cls: "border-border text-muted-foreground/70" },
  no_site:      { label: "الموقع لا يفتح",           cls: "border-red-500/30 bg-red-500/10 text-red-400" },
};
const EMAIL_ST: Record<string, { label: string; cls: string }> = {
  published: { label: "منشور",     cls: "border-primary/40 text-primary" },
  verified:  { label: "مؤكد",      cls: "border-green-500/30 text-green-400" },
  catchall:  { label: "يقبل الكل", cls: "border-yellow-500/30 text-yellow-400" },
  guessed:   { label: "تخمين",     cls: "border-orange-500/30 text-orange-400" },
  invalid:   { label: "غير صالح",  cls: "border-red-500/30 text-red-400" },
};
const TEAM: Record<string, { name: string; avatar: string; job: string }> = {
  accounts_researcher: { name: "فهد", avatar: "🔎", job: "يختار الشركات" },
  accounts_analyst:    { name: "نوف", avatar: "🧭", job: "يجد صاحب القرار" },
  accounts_email:      { name: "سالم", avatar: "✉️", job: "يجد البريد ويتحقّق منه" },
  accounts_writer:     { name: "هند", avatar: "✍️", job: "تكتب الرسائل" },
};

const StatusPill = ({ s }: { s: string }) => { const k = STATUS[s] ?? { label: s, cls: "border-border text-muted-foreground" }; return <span className={cn(pill, k.cls)}>{k.label}</span>; };
const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success("نُسخت"); } catch { toast.error("تعذّر النسخ"); } };
const host = (u?: string | null) => { if (!u) return null; try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

function useAccountActions() {
  const qc = useQueryClient();
  const inv = () => { qc.invalidateQueries({ queryKey: ["accounts-today"] }); qc.invalidateQueries({ queryKey: ["accounts-history"] }); };
  const act = useMutation({
    mutationFn: ({ id, what }: { id: Account["id"]; what: "linkedin-done" | "skip" | "meeting" }) => api(`/api/accounts/${id}/${what}`, { method: "POST" }),
    onSuccess: (_r, v) => { inv(); toast.success(v.what === "meeting" ? "سُجّل الاجتماع" : v.what === "skip" ? "تُركت" : "سُجّلت كمُرسلة"); },
    onError: (e: Error) => toast.error(e.message),
  });
  return act;
}

export function AccountsTab() {
  const qc = useQueryClient();
  const { data: d, isLoading, error } = useQuery<Today>({
    queryKey: ["accounts-today"], queryFn: () => api("/api/accounts/today"), retry: 1,
    refetchInterval: (q) => (q.state.data?.running ? 10_000 : 60_000),
  });
  const run = useMutation({
    mutationFn: () => api("/api/accounts/run", { method: "POST" }),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["accounts-today"] }); r.started ? toast.success("بدأ المكتب العمل — الصفحة تتحدّث كل ١٠ ثوانٍ") : toast.info(r.why ?? "لم يبدأ التشغيل"); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  if (error || !d) return (
    <div className={cn(card, "p-10 text-center space-y-2")}>
      <Hammer className="w-8 h-8 mx-auto text-muted-foreground" />
      <p className="font-semibold">القسم يُجهَّز…</p>
      <p className="text-xs text-muted-foreground">مكتب الحسابات المستهدفة لم يُفعَّل على الخادم بعد. عُد بعد قليل.</p>
    </div>
  );

  const accounts = d.accounts ?? [];
  const done = accounts.filter((a) => a.status !== "researching").length;
  const counts = accounts.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {});
  const li = accounts.filter((a) => a.linkedin && !a.linkedin.done);
  const w = d.stats?.week ?? ({} as Today["stats"]["week"]);

  return (
    <div className="space-y-4">
      {/* 1 — header */}
      <div className={cn(card, "p-4 space-y-3")}>
        <div className="flex items-start gap-3 flex-wrap">
          <Building2 className="w-6 h-6 text-primary mt-0.5" />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold flex items-center gap-2 flex-wrap">مكتب الحسابات المستهدفة
              <span className={cn(pill, d.enabled ? "border-primary/40 text-primary" : "border-border text-muted-foreground")}>{d.enabled ? "يعمل يومياً" : "متوقف"}</span>
              {d.running && <span className={cn(pill, "border-blue-500/30 text-blue-400 flex items-center gap-1")}><Loader2 className="w-3 h-3 animate-spin" /> يعمل الآن</span>}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">كل يوم عمل يبحث المكتب {n(d.perDay)} شركات عقارية، يجد صاحب قرار مكافحة غسل الأموال وبريده وحسابه على LinkedIn، ويكتب له شخصياً.</p>
          </div>
          <div className="flex items-center gap-2">
            <Settings d={d} />
            <button className={primary} disabled={d.running || run.isPending} onClick={() => run.mutate()}>
              {d.running || run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} شغّل الآن
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <div className="flex-1 min-w-[12rem]">
            <div className="flex justify-between text-[11px] text-muted-foreground mb-1"><span>اليوم: <b className="text-foreground">{n(done)}</b> من {n(d.perDay)} بُحثت</span><span>آخر تشغيل: {d.lastRunAt ? ago(d.lastRunAt) : "لم يعمل بعد"}</span></div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden"><div className="h-full bg-primary transition-all" style={{ width: `${Math.min(100, (done / Math.max(1, d.perDay)) * 100)}%` }} /></div>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            {Object.entries(counts).map(([s, c]) => <span key={s} className="flex items-center gap-1"><StatusPill s={s} /><span className="text-[11px] text-muted-foreground">{n(c)}</span></span>)}
          </div>
        </div>
        <SearchKey has={d.hasSearchKey} />
      </div>

      {/* 2 — week stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
        {([
          ["شركات", w.companies, Building2, ""], ["أشخاص وُجدوا", w.people, Users, ""], ["بريد مؤكد", w.verified, MailCheck, "text-primary"],
          ["أُرسلت", w.sent, Send, ""], ["فُتحت", w.opened, Eye, "text-blue-400"], ["ردّوا", w.replied, Reply, "text-green-400"], ["اجتماعات", w.meetings, CalendarCheck, "text-green-300"],
        ] as const).map(([l, v, I, tone]) => (
          <div key={l} className={cn(card, "p-3.5")}>
            <p className="text-[11px] text-muted-foreground flex items-center gap-1"><I className="w-3 h-3" /> {l}</p>
            <p className={cn("text-2xl font-bold leading-none mt-1.5", tone)}>{n(v)}</p>
            <p className="text-[10px] text-muted-foreground mt-1.5">هذا الأسبوع</p>
          </div>
        ))}
      </div>

      {/* 3 — LinkedIn today */}
      <LinkedinToday list={li} />

      <div className="grid lg:grid-cols-[1fr_20rem] gap-4 items-start">
        {/* 4 — today's accounts */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">شركات اليوم</h3>
          {accounts.length ? accounts.map((a) => <AccountCard key={a.id} a={a} />) : (
            <div className={cn(card, "p-10 text-center space-y-2")}>
              <Building2 className="w-8 h-8 mx-auto text-muted-foreground" />
              <p className="font-semibold text-sm">{d.running ? "فهد يختار شركات اليوم…" : "لا شركات اليوم بعد"}</p>
              <p className="text-xs text-muted-foreground">أول تشغيل الساعة ٨:٣٠ صباح أيام العمل، أو اضغط «شغّل الآن».</p>
            </div>
          )}
        </div>
        {/* 6 — team feed */}
        <Feed feed={d.feed ?? []} />
      </div>

      {/* 5 — history */}
      <History />
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────
function Settings({ d }: { d: Today }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [perDay, setPerDay] = useState<number>(d.perDay);
  const save = useMutation({
    mutationFn: (b: any) => api("/api/accounts/settings", { method: "PUT", body: JSON.stringify(b) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["accounts-today"] }); toast.success("حُفظ"); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="relative">
      <button className={ghost} onClick={() => { setPerDay(d.perDay); setOpen((o) => !o); }}><Settings2 className="w-3.5 h-3.5" /> الضبط</button>
      {open && (
        <div className={cn(card, "absolute left-0 top-full mt-2 z-20 w-64 p-3 space-y-3 shadow-xl")}>
          <label className="flex items-center justify-between text-xs">
            <span>يعمل كل يوم عمل</span>
            <button onClick={() => save.mutate({ enabled: !d.enabled })} disabled={save.isPending}
              className={cn("w-9 h-5 rounded-full relative transition-colors", d.enabled ? "bg-primary" : "bg-muted")}>
              <span className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all", d.enabled ? "left-0.5" : "left-[1.125rem]")} />
            </button>
          </label>
          <div className="space-y-1">
            <p className="text-xs">عدد الشركات يومياً</p>
            <div className="flex gap-2">
              <input type="number" min={1} max={50} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} className={cn(input, "py-1.5")} dir="ltr" />
              <button className={primary} disabled={save.isPending || !perDay || perDay === d.perDay} onClick={() => save.mutate({ perDay })}>احفظ</button>
            </div>
          </div>
          <button className="text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>إغلاق</button>
        </div>
      )}
    </div>
  );
}

function SearchKey({ has }: { has: boolean }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: (searchKey: string) => api("/api/accounts/settings", { method: "PUT", body: JSON.stringify({ searchKey }) }),
    onSuccess: (_r, k) => { setKey(""); qc.invalidateQueries({ queryKey: ["accounts-today"] }); toast.success(k ? "حُفظ المفتاح" : "حُذف المفتاح"); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (has) return (
    <div className="flex items-center gap-2 text-xs border-t border-card-border pt-3">
      <KeyRound className="w-3.5 h-3.5 text-primary" /><span>مفتاح البحث: <b className="text-primary">المفتاح محفوظ</b></span>
      <button className={cn(ghost, "py-1 mr-auto hover:border-red-500/50 hover:text-red-400")} disabled={save.isPending} onClick={() => save.mutate("")}><Trash2 className="w-3 h-3" /> احذف</button>
    </div>
  );
  return (
    <div className="border-t border-card-border pt-3 space-y-2">
      <p className="text-[11px] text-muted-foreground"><KeyRound className="w-3.5 h-3.5 inline ml-1 text-yellow-400" />بدون مفتاح بحث يعمل المكتب من مواقع الشركات وحدها. مفتاح Tavily (مجاني حتى ١٠٠٠ بحث شهرياً) يضيف الأخبار وروابط LinkedIn.</p>
      <form className="flex gap-2 max-w-md" onSubmit={(e) => { e.preventDefault(); if (key.trim()) save.mutate(key.trim()); }}>
        <input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tvly-…" className={cn(input, "py-1.5 font-mono text-xs")} dir="ltr" />
        <button className={primary} disabled={!key.trim() || save.isPending}>{save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null} احفظ</button>
      </form>
    </div>
  );
}

// ── LinkedIn today ────────────────────────────────────────────────
function LinkedinToday({ list }: { list: Account[] }) {
  const act = useAccountActions();
  return (
    <div className={card}>
      <div className="p-3.5 border-b border-card-border flex items-center gap-2">
        <Linkedin className="w-4 h-4 text-blue-400" />
        <p className="font-semibold text-sm">LinkedIn اليوم</p>
        <span className="text-[10px] text-muted-foreground">ترسلها أنت بيدك: انسخ الرسالة، افتح الملف، ألصقها، ثم «أرسلتها ✓»</span>
        <span className="mr-auto text-[11px] text-muted-foreground">{n(list.length)} بانتظارك</span>
      </div>
      {list.length ? (
        <div className="divide-y divide-card-border">
          {list.map((a) => {
            const p = a.people.find((x) => x.isDecisionMaker) ?? a.people[0];
            const url = p ? p.linkedinUrl ?? p.linkedinSearchUrl : null;
            return (
              <div key={a.id} className="p-3.5 space-y-2">
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <b>{p?.name ?? "—"}</b>
                  {p?.title && <span className="text-muted-foreground">{p.title}</span>}
                  <span className="text-muted-foreground">· {a.company}</span>
                  {p && !p.linkedinUrl && <span className={cn(pill, "border-yellow-500/30 text-yellow-400")}>رابط بحث</span>}
                </div>
                <p dir="ltr" className="text-left text-xs bg-muted/40 rounded-lg p-2.5 whitespace-pre-wrap leading-relaxed">{a.linkedin!.message}</p>
                <div className="flex gap-2 flex-wrap">
                  <button className={ghost} onClick={() => copy(a.linkedin!.message)}><Copy className="w-3.5 h-3.5" /> انسخ</button>
                  {url && <a className={ghost} href={url} target="_blank" rel="noreferrer"><ExternalLink className="w-3.5 h-3.5" /> افتح الملف</a>}
                  <button className={primary} disabled={act.isPending} onClick={() => act.mutate({ id: a.id, what: "linkedin-done" })}><Check className="w-3.5 h-3.5" /> أرسلتها ✓</button>
                </div>
              </div>
            );
          })}
        </div>
      ) : <p className="p-6 text-xs text-muted-foreground text-center">لا رسائل LinkedIn تنتظرك الآن.</p>}
    </div>
  );
}

// ── One account ───────────────────────────────────────────────────
function AccountCard({ a, compact }: { a: Account; compact?: boolean }) {
  const act = useAccountActions();
  const [open, setOpen] = useState(!compact);
  const closed = ["meeting", "skipped"].includes(a.status);
  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-start gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-sm flex items-center gap-2 flex-wrap">{a.company} <StatusPill s={a.status} /></p>
          <div className="flex gap-3 flex-wrap text-[11px] text-muted-foreground mt-0.5">
            <a href={a.website ?? `https://${a.domain}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 hover:text-primary" dir="ltr"><Globe className="w-3 h-3" /> {a.domain}</a>
            {a.city && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {a.city}</span>}
            {a.sector && <span>{a.sector}</span>}
            {compact && <span>{when(a.createdAt)}</span>}
          </div>
        </div>
        <div className="flex gap-1.5">
          {compact && <button className={ghost} onClick={() => setOpen((o) => !o)}><ChevronDown className={cn("w-3.5 h-3.5 transition-transform", open && "rotate-180")} /> التفاصيل</button>}
          {!closed && <button className={ghost} disabled={act.isPending} onClick={() => act.mutate({ id: a.id, what: "meeting" })}><CalendarCheck className="w-3.5 h-3.5" /> اجتماع</button>}
          {!closed && <button className={cn(ghost, "hover:border-red-500/50 hover:text-red-400")} disabled={act.isPending} onClick={() => act.mutate({ id: a.id, what: "skip" })}><X className="w-3.5 h-3.5" /> اتركها</button>}
        </div>
      </div>

      {open && (<>
        {a.signal && (
          <div className="text-xs flex gap-2 items-start rounded-lg border border-card-border p-2.5">
            <Radio className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
            <div className="min-w-0"><p className="leading-relaxed">{a.signal}</p>
              {a.signalSource && <a href={a.signalSource} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground hover:text-primary inline-flex items-center gap-1" dir="ltr"><ExternalLink className="w-3 h-3" /> {host(a.signalSource)}</a>}
            </div>
          </div>
        )}

        {a.people.length ? (
          <div className="divide-y divide-card-border border border-card-border rounded-lg">
            {a.people.map((p) => {
              const es = p.emailStatus ? EMAIL_ST[p.emailStatus] ?? { label: p.emailStatus, cls: "border-border text-muted-foreground" } : null;
              return (
                <div key={p.id} className="px-3 py-2 text-xs space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <b>{p.name}</b>
                    {p.isDecisionMaker && <span className={cn(pill, "border-primary/40 bg-primary/10 text-primary flex items-center gap-1")}><UserCheck className="w-3 h-3" /> صاحب القرار</span>}
                    {p.title && <span className="text-muted-foreground">{p.title}</span>}
                    <a href={p.linkedinUrl ?? p.linkedinSearchUrl} target="_blank" rel="noreferrer" className="mr-auto text-muted-foreground hover:text-blue-400" title={p.linkedinUrl ? "ملف LinkedIn" : "بحث LinkedIn"}><Linkedin className="w-3.5 h-3.5" /></a>
                  </div>
                  {p.why && <p className="text-muted-foreground leading-relaxed">{p.why}</p>}
                  {p.email ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button className="font-mono hover:text-primary" dir="ltr" onClick={() => copy(p.email!)}>{p.email}</button>
                      {es && <span className={cn(pill, es.cls)}>{es.label}</span>}
                    </div>
                  ) : <p className="text-[11px] text-muted-foreground">لا بريد شخصي.</p>}
                  {p.emailFallback && <p className="text-[11px] text-yellow-400/90">لم يُتحقَّق من بريده الشخصي — الرسالة ذهبت إلى البريد العام للشركة.</p>}
                </div>
              );
            })}
          </div>
        ) : a.status !== "researching" && <p className="text-xs text-muted-foreground">لم يُعثر على أشخاص.</p>}

        {a.email && <EmailBlock e={a.email} />}
        {a.notes && <p className="text-[11px] text-muted-foreground whitespace-pre-wrap">{a.notes}</p>}
      </>)}
    </div>
  );
}

function EmailBlock({ e }: { e: NonNullable<Account["email"]> }) {
  const [body, setBody] = useState(false);
  const [fu, setFu] = useState(false);
  return (
    <div className="rounded-lg border border-card-border p-2.5 space-y-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <Send className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="font-mono text-[11px]" dir="ltr">{e.to}</span>
        <span className="mr-auto flex gap-2 text-[10px] text-muted-foreground">
          <span>{e.sentAt ? `أُرسل ${when(e.sentAt)}` : "لم يُرسل بعد"}</span>
          {e.openedAt && <span className="text-blue-400">فُتح {when(e.openedAt)}</span>}
          {e.repliedAt && <b className="text-green-400">ردّ {when(e.repliedAt)}</b>}
        </span>
      </div>
      <button className="w-full flex items-center gap-2 text-right" onClick={() => setBody((b) => !b)}>
        <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 transition-transform", body && "rotate-180")} />
        <span dir="ltr" className="flex-1 text-left font-medium truncate">{e.subject}</span>
      </button>
      {body && <p dir="ltr" className="text-left whitespace-pre-wrap leading-relaxed bg-muted/40 rounded-lg p-2.5">{e.body}</p>}
      {!!e.followups?.length && (<>
        <button className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setFu((f) => !f)}>
          <ChevronDown className={cn("w-3 h-3 transition-transform", fu && "rotate-180")} /> المتابعات ({n(e.followups.length)})
        </button>
        {fu && e.followups.map((f, i) => (
          <div key={i} className="border-r-2 border-card-border pr-2.5 space-y-1">
            <p className="text-[10px] text-muted-foreground">بعد {n(f.afterDays)} أيام</p>
            <p dir="ltr" className="text-left font-medium">{f.subject}</p>
            <p dir="ltr" className="text-left whitespace-pre-wrap leading-relaxed text-foreground/85">{f.body}</p>
          </div>
        ))}
      </>)}
    </div>
  );
}

// ── Team feed ─────────────────────────────────────────────────────
function Feed({ feed }: { feed: Today["feed"] }) {
  return (
    <div className={cn(card, "lg:sticky lg:top-4")}>
      <div className="p-3.5 border-b border-card-border">
        <p className="font-semibold text-sm">الفريق يعمل</p>
        <div className="flex gap-2 mt-2 flex-wrap">
          {Object.entries(TEAM).map(([k, t]) => <span key={k} title={t.job} className="text-[11px] text-muted-foreground">{t.avatar} {t.name}</span>)}
        </div>
      </div>
      <div className="max-h-[32rem] overflow-y-auto divide-y divide-card-border">
        {feed.length ? feed.map((f, i) => {
          const t = TEAM[f.role];
          return (
            <div key={i} className="px-3.5 py-2.5 text-xs flex gap-2">
              <span className="text-lg leading-none">{t?.avatar ?? "🤖"}</span>
              <div className="min-w-0 flex-1">
                <div className="flex gap-2 items-center"><b>{f.name || t?.name}</b><span className="text-[10px] text-muted-foreground/70 mr-auto">{ago(f.at)}</span></div>
                <p className="text-foreground/85 leading-relaxed whitespace-pre-wrap">{f.text}</p>
              </div>
            </div>
          );
        }) : <p className="p-6 text-xs text-muted-foreground text-center">الفريق لم يبدأ بعد — ما يفعله فهد ونوف وسالم وهند يظهر هنا لحظة بلحظة.</p>}
      </div>
    </div>
  );
}

// ── History ───────────────────────────────────────────────────────
const PAGE = 50;
function History() {
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, isLoading, error } = useQuery<{ total: number; accounts: Account[] }>({
    queryKey: ["accounts-history", status, offset], queryFn: () => api(`/api/accounts?status=${status}&limit=${PAGE}&offset=${offset}`), retry: 1,
  });
  const total = data?.total ?? 0;
  const pick = (s: string) => { setStatus(s); setOffset(0); };
  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-center gap-2 flex-wrap">
        <h3 className="text-sm font-semibold">السجل</h3>
        <span className="text-[11px] text-muted-foreground">{n(total)} شركة</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        {[["", "الكل"], ...Object.entries(STATUS).map(([k, v]) => [k, v.label])].map(([k, l]) => (
          <button key={k} onClick={() => pick(k)} className={cn("px-3 py-1 rounded-full border text-xs", status === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
        ))}
      </div>
      {isLoading ? <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        : error ? <p className="text-xs text-muted-foreground text-center py-6">السجل يُجهَّز…</p>
        : data?.accounts.length ? <div className="space-y-2">{data.accounts.map((a) => <AccountCard key={a.id} a={a} compact />)}</div>
        : <p className="text-xs text-muted-foreground text-center py-6">{status ? "لا شركات بهذه الحالة." : "السجل فارغ — يمتلئ بعد أول يوم عمل."}</p>}
      {total > PAGE && (
        <div className="flex items-center justify-center gap-3 text-xs">
          <button className={ghost} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>السابق</button>
          <span className="text-muted-foreground">{n(offset + 1)}–{n(Math.min(total, offset + PAGE))} من {n(total)}</span>
          <button className={ghost} disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>التالي</button>
        </div>
      )}
    </div>
  );
}
