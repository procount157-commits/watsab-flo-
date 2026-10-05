// ── Email marketing ───────────────────────────────────────────────
// One section, eight tabs. The owner's path is: settings once, then drop a
// spreadsheet on the import tab and let the ladder do the rest; everything
// after that is watching — the overview polls every ten seconds so what is
// on screen is what is happening.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRoute, useLocation } from "wouter";
import { toast } from "sonner";
import {
  Mail, Upload, Users, Megaphone, ListOrdered, FileText, Inbox, Settings2, Loader2, Play, Pause,
  CheckCircle2, AlertTriangle, Eye, MousePointerClick, Reply, ShieldAlert, RefreshCw, Trash2, Plus, Send, Sparkles, Rocket, FolderOpen, BookOpen, LayoutDashboard, ListChecks, Stethoscope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { EmailDiagnose } from "@/components/EmailDiagnose";
import { AudienceTab, AgentTab, MissionsTab, type Filter } from "./EmailAgent";
import { ListsTab, ListDetail } from "./EmailLists";
import { Campaigns } from "./EmailCampaigns";
import { EmailEditor, EmailPreviewModal } from "@/components/EmailEditor";
import { KnowledgeTab } from "./EmailKnowledge";
import { DashboardTab } from "./EmailDashboard";
import { RegisterTab } from "./EmailRegister";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
const ta = cn(input, "min-h-[10rem] font-mono text-xs leading-relaxed");
const ago = (d?: string | Date | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `${m}د`; const h = Math.round(m / 60); return h < 24 ? `${h}س` : `${Math.round(h / 24)}ي`;
};
const pct = (n?: number | null) => (n === null || n === undefined ? "—" : `${n}%`);

const TABS = [
  { key: "dashboard", label: "لوحة المتابعة", icon: LayoutDashboard },
  { key: "diagnose",  label: "التشخيص",       icon: Stethoscope },
  { key: "overview",  label: "ما يحدث الآن",  icon: Mail },
  { key: "lists",     label: "القوائم",        icon: FolderOpen },
  { key: "contacts",  label: "الجمهور",        icon: Users },
  { key: "campaigns", label: "الحملات",         icon: Megaphone },
  { key: "register",  label: "سجل الإرسال",    icon: ListChecks },
  { key: "import",    label: "رفع Excel",      icon: Upload },
  { key: "agent",     label: "نورة",           icon: Sparkles },
  { key: "knowledge", label: "المعرفة",        icon: BookOpen },
  { key: "missions",  label: "المهام",         icon: Rocket },
  { key: "sequences", label: "المتابعة",        icon: ListOrdered },
  { key: "templates", label: "القوالب",         icon: FileText },
  { key: "inbox",     label: "الوارد",          icon: Inbox },
  { key: "settings",  label: "الإعدادات",       icon: Settings2 },
] as const;
type Tab = typeof TABS[number]["key"];

const EVENT_AR: Record<string, { label: string; cls: string }> = {
  sent: { label: "أُرسلت", cls: "text-muted-foreground" }, open: { label: "فُتحت", cls: "text-blue-400" }, click: { label: "نقر رابطاً", cls: "text-primary" },
  reply: { label: "ردّ", cls: "text-green-400" }, bounce: { label: "ارتدّت", cls: "text-red-400" }, complaint: { label: "بلاغ إزعاج", cls: "text-red-500" },
  unsubscribe: { label: "ألغى الاشتراك", cls: "text-yellow-400" }, failed: { label: "فشلت", cls: "text-red-400" },
};

export default function EmailMarketing() {
  const [, params] = useRoute("/email/:tab?");
  const [, deep] = useRoute("/email/:tab/:id");
  const [, navigate] = useLocation();
  const tab = (TABS.find((t) => t.key === (deep?.tab ?? params?.tab))?.key ?? "dashboard") as Tab;
  const listId = tab === "lists" && deep?.id ? Number(deep.id) : null;
  // A list's "campaign" button opens the builder on that list.
  const [campaignFor, setCampaignFor] = useState<number | null>(null);
  const toCampaign = (id: number) => { setCampaignFor(id); navigate("/email/campaigns"); };
  const toWrite = (f: Filter) => { setWriteFor(f); navigate("/email/agent"); };
  const { data: ov } = useQuery<any>({ queryKey: ["email-overview"], queryFn: () => api("/api/email/overview"), refetchInterval: 10_000 });
  // The audience the owner handed to نورة from the audience tab.
  const [writeFor, setWriteFor] = useState<Filter | null>(null);

  return (
    <div className="p-6 space-y-5 max-w-[96rem]">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Mail className="w-6 h-6 text-primary" /> التسويق بالبريد</h1>
          <p className="text-sm text-muted-foreground mt-1">ارفع ملف Excel، والقسم ينظّفه ويقسّمه ويرسل ويتابع ويقرأ الردود — وأنت تراقب لحظة بلحظة.</p>
        </div>
        {ov && !ov.configured && (
          <Link href="/email/settings" className={cn(ghost, "border-yellow-500/40 text-yellow-400")}><AlertTriangle className="w-3.5 h-3.5" /> اضبط المُرسِل أولاً</Link>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-card-border -mx-6 px-6">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => navigate(`/email/${t.key}`)}
            className={cn("flex items-center gap-1.5 px-3 py-2.5 text-xs whitespace-nowrap border-b-2 -mb-px transition-colors",
              tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
            {t.key === "inbox" && ov?.events?.some((e: any) => e.type === "reply") && <span className="w-1.5 h-1.5 rounded-full bg-green-400" />}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <DashboardTab goMissions={() => navigate("/email/missions")} />}
      {tab === "diagnose"  && <EmailDiagnose />}
      {tab === "overview"  && <Overview ov={ov} />}
      {tab === "import"    && <Import />}
      {tab === "lists"     && (listId ? <ListDetail id={listId} onCampaign={toCampaign} onWrite={toWrite} /> : <ListsTab onCampaign={toCampaign} />)}
      {tab === "contacts"  && <AudienceTab onWrite={toWrite} />}
      {tab === "agent"     && <AgentTab initialFilter={writeFor} onMissionCreated={() => navigate("/email/missions")} />}
      {tab === "knowledge" && <KnowledgeTab />}
      {tab === "missions"  && <MissionsTab />}
      {tab === "register"  && <RegisterTab />}
      {tab === "campaigns" && <Campaigns initialListId={campaignFor} onUsedInitial={() => setCampaignFor(null)} />}
      {tab === "sequences" && <Sequences />}
      {tab === "templates" && <Templates />}
      {tab === "inbox"     && <InboxTab />}
      {tab === "settings"  && <SettingsTab />}
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────────
function Stat({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: string }) {
  return (
    <div className={cn(card, "p-3.5")}>
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-bold leading-none mt-1.5", tone)}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-1.5">{sub}</p>}
    </div>
  );
}

function Overview({ ov }: { ov: any }) {
  if (!ov) return <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  const h = ov.health ?? {};
  const w = ov.week ?? {}, t = ov.today ?? {}, c = ov.contacts ?? {}, q = ov.queue ?? {};
  return (
    <div className="space-y-4">
      {!ov.trackingBase && (
        <div className={cn(card, "p-3 border-yellow-500/30 text-xs text-muted-foreground")}>
          <AlertTriangle className="w-3.5 h-3.5 inline text-yellow-400 ml-1" />
          لم يُضبط <code>SITE_URL</code> في الإعدادات — بدونه لا يمكن قياس الفتح والنقر ولا يعمل رابط إلغاء الاشتراك (تُرسل الرسائل بإلغاء اشتراك عبر البريد فقط).
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <Stat label="أُرسل اليوم" value={t.sent ?? 0} sub={`${w.sent ?? 0} هذا الأسبوع`} />
        <Stat label="نسبة الفتح (أسبوع)" value={pct(w.openRate)} sub={`${w.opened ?? 0} فتحوا`} tone="text-blue-400" />
        <Stat label="نقر الروابط" value={pct(w.clickRate)} sub={`${w.clicked ?? 0} نقروا`} />
        <Stat label="الردود" value={pct(w.replyRate)} sub={`${w.replied ?? 0} ردّوا`} tone="text-green-400" />
        <Stat label="الارتداد" value={pct(w.bounceRate)} sub={`${w.bounced ?? 0} ارتدّت`} tone={(w.bounceRate ?? 0) >= 3 ? "text-red-400" : undefined} />
        <Stat label="في الطابور" value={q.queued ?? 0} sub={`${q.pendingRungs ?? 0} متابعة · حصة اليوم ${ov.sender?.dailyCapToday ?? "—"}${ov.sender?.warmup && ov.sender?.dailyCapToday < ov.sender?.dailyCap ? " (إحماء)" : ""}`} />
      </div>

      <div className={cn(card, "p-4", h.level === "critical" && "border-red-500/40", h.level === "warning" && "border-yellow-500/30")}>
        <div className="flex items-center gap-2 flex-wrap">
          <ShieldAlert className={cn("w-4 h-4", h.level === "ok" ? "text-primary" : h.level === "warning" ? "text-yellow-400" : "text-red-400")} />
          <p className="font-semibold text-sm">سلامة الإرسال</p>
          <span className="text-[11px] text-muted-foreground">
            {h.level === "ok" ? "طبيعي" : h.level === "warning" ? "تحذير" : "حرج"} · {h.throttle > 1 ? `إبطاء ${h.throttle}×` : "السرعة المحسوبة"}
            {q.heldUntil ? ` · موقوف حتى ${new Date(q.heldUntil).toLocaleTimeString("ar-AE", { hour: "2-digit", minute: "2-digit" })}` : ""}
          </span>
          <span className="text-[11px] text-muted-foreground mr-auto">{c.active ?? 0} نشط · {c.unsubscribed ?? 0} ألغوا · {c.bounced ?? 0} ارتدّوا · {c.lists ?? 0} قوائم</span>
        </div>
        {h.reasons?.length ? <ul className="mt-2 space-y-1">{h.reasons.map((r: string, i: number) => <li key={i} className="text-[11px] text-muted-foreground">• {r}</li>)}</ul>
          : <p className="mt-2 text-[11px] text-muted-foreground">لا إشارة تستدعي القلق. الارتداد تحت ٣٪ والبلاغات تحت ٠.١٪ هما الخطّان اللذان نراقبهما.</p>}
      </div>

      <div className={cn(card)}>
        <div className="p-3.5 border-b border-card-border flex items-center gap-2">
          <p className="font-semibold text-sm">ما يحدث الآن</p>
          <span className="text-[10px] text-muted-foreground">يتحدّث كل ١٠ ثوانٍ</span>
        </div>
        <div className="max-h-[28rem] overflow-y-auto divide-y divide-card-border">
          {(ov.events ?? []).length === 0 ? <p className="p-6 text-sm text-muted-foreground text-center">لم يحدث شيء بعد — ارفع ملفاً وابدأ.</p>
            : ov.events.map((e: any) => {
              const k = EVENT_AR[e.type] ?? { label: e.type, cls: "" };
              return (
                <div key={e.id} className="px-3.5 py-2 flex items-center gap-3 text-xs">
                  <span className={cn("w-20 shrink-0 font-medium", k.cls)}>{k.label}</span>
                  <span className="font-mono text-[11px]" dir="ltr">{e.to ?? "—"}</span>
                  <span className="text-muted-foreground truncate flex-1">{e.subject ?? ""}{e.url ? ` → ${e.url}` : ""}{e.meta?.proxied ? " (عبر وكيل البريد)" : ""}</span>
                  <span className="text-[10px] text-muted-foreground/60">{ago(e.at)}</span>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

// ── Import ────────────────────────────────────────────────────────
function Import() {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [opts, setOpts] = useState({ listName: "", splitBy: "", mx: true, sequenceId: "", country: "AE", saveWhatsapp: true, sector: "" });
  const { data: sectorList } = useQuery<any>({ queryKey: ["email-sectors"], queryFn: () => api("/api/email/sectors") });
  const [result, setResult] = useState<any>(null);
  const { data: seqs = [] } = useQuery<any[]>({ queryKey: ["email-seqs"], queryFn: () => api("/api/email/sequences") });


  const post = async (path: string, extra: Record<string, string> = {}) => {
    const fd = new FormData();
    if (file) fd.append("file", file);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    const r = await fetch(`${BASE}${path}`, { method: "POST", body: fd, credentials: "include" });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "فشل");
    return d;
  };
  const doPreview = async (f: File) => {
    setFile(f); setResult(null); setBusy("preview");
    try { setPreview(await (async () => { const fd = new FormData(); fd.append("file", f); fd.append("country", opts.country); const r = await fetch(`${BASE}/api/email/contacts/preview`, { method: "POST", body: fd, credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; })()); setOpts((o) => ({ ...o, listName: f.name.replace(/\.[a-z]+$/i, "") })); }
    catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };
  const doImport = async () => {
    setBusy("import");
    try {
      const d = await post("/api/email/contacts/import", { listName: opts.listName, splitBy: opts.splitBy, mx: String(opts.mx), sequenceId: opts.sequenceId, country: opts.country, saveWhatsapp: String(opts.saveWhatsapp), sector: opts.sector });
      setResult(d); setPreview(null); setFile(null);
      qc.invalidateQueries({ queryKey: ["email-overview"] }); qc.invalidateQueries({ queryKey: ["email-lists"] });
      toast.success(`استُورد ${d.inserted} بريداً جديداً${d.whatsapp?.added ? ` و${d.whatsapp.added} رقم واتساب` : ""}${d.enrolled ? ` وسُجّل ${d.enrolled.enrolled} في المتابعة` : ""}`);
    } catch (e: any) { toast.error(e.message); }
    finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-5 border-dashed border-2 text-center cursor-pointer hover:border-primary/50")}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void doPreview(f); }}>
        <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void doPreview(f); }} />
        {busy === "preview" ? <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" /> : <Upload className="w-6 h-6 mx-auto text-muted-foreground" />}
        <p className="text-sm font-semibold mt-2">{file ? file.name : "اسحب ملف Excel هنا أو اضغط للاختيار"}</p>
        <p className="text-[11px] text-muted-foreground mt-1">كما هو — الأعمدة تُكتشف تلقائياً: البريد، الشركة، الاسم، الجوال، النشاط، الإمارة. تُستبعد الأسطر بلا بريد صالح والمكرّرة، ويُفحص نطاق كل بريد (MX).</p>
      </div>

      {preview && (
        <div className={cn(card, "p-4 space-y-4")}>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat label="أسطر في الملف" value={preview.total} />
            <Stat label="صالحة وفريدة" value={preview.kept} tone="text-primary" />
            <Stat label="بلا بريد صالح" value={preview.invalid} tone={preview.invalid ? "text-yellow-400" : undefined} />
            <Stat label="مكرّرة" value={preview.duplicates} />
            <Stat label="عناوين عامة (info@…)" value={preview.roleAddresses} sub="تُبقى وتُعلَّم" />
          </div>
          {preview.whatsapp && (
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-xs flex flex-wrap items-center gap-x-4 gap-y-1">
              <span className="font-semibold text-primary">واتساب: {preview.whatsapp.numbers} رقم جوال</span>
              {preview.whatsapp.withoutEmail > 0 && <span className="text-muted-foreground">منها {preview.whatsapp.withoutEmail} لشركات بلا بريد — تُحفظ أيضاً</span>}
              {preview.whatsapp.landlineOnly > 0 && <span className="text-muted-foreground">{preview.whatsapp.landlineOnly} شركة برقم أرضي فقط</span>}
              {preview.whatsapp.byCountry && Object.keys(preview.whatsapp.byCountry).length > 1 && <span className="text-muted-foreground">{Object.entries(preview.whatsapp.byCountry).map(([k, v]: any) => `${k} ${v}`).join("، ")}</span>}
              <label className="flex items-center gap-1.5 mr-auto"><input type="checkbox" checked={opts.saveWhatsapp} onChange={(e) => setOpts({ ...opts, saveWhatsapp: e.target.checked })} /> احفظها في قائمة واتساب</label>
            </div>
          )}
          <div className="text-xs">
            <p className="font-semibold mb-1.5">الأعمدة كما فهمتها:</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(preview.columns as Record<string, string | null>).map(([k, v]) => (
                <span key={k} className={cn("px-2 py-0.5 rounded border text-[11px]", v ? "border-primary/40 text-primary" : "border-card-border text-muted-foreground")}>
                  {({ email: "البريد", name: "الاسم", company: "الشركة", phone: "الأرقام", industry: "النشاط", city: "المدينة" } as any)[k]}: {v ?? "—"}
                </span>
              ))}
            </div>
          </div>
          {preview.sample?.length > 0 && (
            <div className="overflow-x-auto"><table className="w-full text-[11px]"><thead><tr className="text-muted-foreground"><th className="text-right p-1">البريد</th><th className="text-right p-1">الشركة</th><th className="text-right p-1">الاسم</th><th className="text-right p-1">النشاط</th><th className="text-right p-1">المدينة</th></tr></thead>
              <tbody>{preview.sample.map((r: any) => <tr key={r.email} className="border-t border-card-border"><td className="p-1 font-mono" dir="ltr">{r.email}</td><td className="p-1">{r.company ?? ""}</td><td className="p-1">{r.name ?? ""}</td><td className="p-1">{r.industry ?? ""}</td><td className="p-1">{r.city ?? ""}</td></tr>)}</tbody></table></div>
          )}
          <div className="grid md:grid-cols-4 gap-3 items-end">
            <div><label className="text-xs font-semibold block mb-1.5">اسم القائمة</label><input className={input} value={opts.listName} onChange={(e) => setOpts({ ...opts, listName: e.target.value })} /></div>
            <div><label className="text-xs font-semibold block mb-1.5">تقسيم إلى قوائم فرعية</label>
              <select className={input} value={opts.splitBy} onChange={(e) => setOpts({ ...opts, splitBy: e.target.value })}>
                <option value="">بلا تقسيم</option>
                {preview.columns.industry && <option value="industry">حسب النشاط ({preview.byIndustry?.length ?? 0})</option>}
                {preview.columns.city && <option value="city">حسب المدينة ({preview.byCity?.length ?? 0})</option>}
              </select></div>
            <div><label className="text-xs font-semibold block mb-1.5">تسجيل الجميع في المتابعة</label>
              <select className={input} value={opts.sequenceId} onChange={(e) => setOpts({ ...opts, sequenceId: e.target.value })}>
                <option value="">لا — الاستيراد فقط (ثم اختر القطاع ودع نورة تكتب)</option>
                {seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
            <label className="flex items-center gap-2 text-xs pb-2"><input type="checkbox" checked={opts.mx} onChange={(e) => setOpts({ ...opts, mx: e.target.checked })} /> فحص MX لكل نطاق</label>
            <div><label className="text-xs font-semibold block mb-1.5">القطاع</label>
              <select className={input} value={opts.sector} onChange={(e) => setOpts({ ...opts, sector: e.target.value })}>
                <option value="">تلقائي — من اسم الشركة</option>{(sectorList?.sectors ?? []).map((x: string) => <option key={x} value={x}>كل الملف: {x}</option>)}
              </select></div>
            <div><label className="text-xs font-semibold block mb-1.5">الدولة للأرقام المحلية</label>
              <select className={input} value={opts.country} onChange={(e) => setOpts({ ...opts, country: e.target.value })}>
                <option value="AE">الإمارات +971</option><option value="SA">السعودية +966</option><option value="QA">قطر +974</option>
                <option value="KW">الكويت +965</option><option value="BH">البحرين +973</option><option value="OM">عُمان +968</option><option value="EG">مصر +20</option>
              </select></div>
          </div>
          {(preview.byIndustry?.length > 1 || preview.byCity?.length > 1) && (
            <div className="text-[11px] text-muted-foreground flex flex-wrap gap-1.5">
              {(opts.splitBy === "city" ? preview.byCity : preview.byIndustry)?.slice(0, 12).map((g: any) => <span key={g.key} className="px-2 py-0.5 rounded bg-muted">{g.key}: {g.n}</span>)}
            </div>
          )}
          <button onClick={doImport} disabled={busy === "import" || !preview.kept} className={primary}>
            {busy === "import" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            استورد {preview.kept} جهة اتصال{opts.sequenceId ? " وابدأ المتابعة" : ""}
          </button>
        </div>
      )}

      {result && (
        <div className={cn(card, "p-4 border-primary/30")}>
          <p className="font-semibold text-sm flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-primary" /> تم</p>
          <ul className="text-xs text-muted-foreground mt-2 space-y-1">
            <li>{result.inserted} جهة اتصال جديدة، {result.alreadyKnown} كانت موجودة، {result.invalid} بلا بريد صالح، {result.duplicates} مكرّرة{result.mxBad ? `، ${result.mxBad} نطاقها لا يستقبل بريداً (لن تُراسَل)` : ""}.</li>
            <li>القائمة: <b className="text-foreground">{result.list?.name}</b>{result.subLists?.length ? ` + ${result.subLists.length} قائمة فرعية` : ""}.</li>
            {result.enrolled && <li>سُجّل {result.enrolled.enrolled} في تسلسل المتابعة ({result.enrolled.skipped} تُخطّوا). الرسالة الأولى تبدأ خلال ساعة وتتوزع بحسب حصة الإرسال.</li>}
            {result.whatsapp && (result.whatsapp.error
              ? <li className="text-yellow-400">أرقام واتساب لم تُحفظ: {result.whatsapp.error}</li>
              : <li>واتساب: حُفظ <b className="text-foreground">{result.whatsapp.added}</b> رقم جوال باسم الشركة في {result.whatsapp.groups.map((g: any) => <Link key={g.id} href={`/contacts/${g.id}`} className="text-primary underline mx-0.5">{g.name}</Link>)}{result.whatsapp.skippedLandline ? ` · ${result.whatsapp.skippedLandline} أرضي تُرك` : ""}{result.whatsapp.verifying ? " · يجري التحقق على واتساب" : ""}.</li>)}
          </ul>
          <div className="flex gap-2 mt-3"><Link href="/email/overview" className={ghost}>راقب الإرسال</Link>{result.list?.id && <Link href={`/email/lists/${result.list.id}`} className={ghost}>افتح القائمة</Link>}<Link href="/email/contacts" className={ghost}>جهات الاتصال</Link></div>
        </div>
      )}
    </div>
  );
}

function PreviewButton({ subject, html }: { subject: string; html: string }) {
  const [p, setP] = useState<any>(null);
  return (
    <>
      <button onClick={async () => { try { setP(await api("/api/email/preview", { method: "POST", body: JSON.stringify({ subject, html }) })); } catch (e: any) { toast.error(e.message); } }} className={ghost}><Eye className="w-3 h-3" /> معاينة</button>
      {p && <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setP(null)}>
        <div className="bg-white text-black rounded-xl max-w-2xl w-full max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
          <div className="p-3 border-b text-sm font-semibold" dir="rtl">{p.subject}</div>
          <iframe title="preview" srcDoc={p.html} className="w-full h-[70vh]" />
        </div></div>}
    </>
  );
}

// ── Sequences ─────────────────────────────────────────────────────
function Sequences() {
  const qc = useQueryClient();
  const { data: seqs = [] } = useQuery<any[]>({ queryKey: ["email-seqs"], queryFn: () => api("/api/email/sequences"), refetchInterval: 15_000 });
  const { data: lists = [] } = useQuery<any[]>({ queryKey: ["email-lists"], queryFn: () => api("/api/email/lists") });
  const [edit, setEdit] = useState<any | null>(null);
  const [enrolList, setEnrolList] = useState<Record<number, string>>({});
  const inv = () => qc.invalidateQueries({ queryKey: ["email-seqs"] });
  const save = useMutation({ mutationFn: (s: any) => s.id ? api(`/api/email/sequences/${s.id}`, { method: "PATCH", body: JSON.stringify(s) }) : api("/api/email/sequences", { method: "POST", body: JSON.stringify(s) }), onSuccess: () => { setEdit(null); inv(); toast.success("حُفظ"); }, onError: (e: Error) => toast.error(e.message) });
  const toggle = useMutation({ mutationFn: (s: any) => api(`/api/email/sequences/${s.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !s.isActive }) }), onSuccess: inv });
  const enrol = useMutation({ mutationFn: ({ id, listId }: { id: number; listId: number }) => api(`/api/email/sequences/${id}/enrol`, { method: "POST", body: JSON.stringify({ listId }) }), onSuccess: (d: any) => { inv(); toast.success(`سُجّل ${d.enrolled} (${d.skipped} تُخطّوا)`); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/email/sequences/${id}`, { method: "DELETE" }), onSuccess: inv });
  const seed = useMutation({ mutationFn: () => api("/api/email/templates/seed", { method: "POST" }), onSuccess: () => { inv(); qc.invalidateQueries({ queryKey: ["email-templates"] }); toast.success("ثُبّتت القوالب الجاهزة"); } });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <p className="text-sm text-muted-foreground">سلّم رسائل بمواعيد: تتوقف فور أن يردّ، ولا تُرسل لمن ارتدّ بريده أو ألغى.</p>
        <div className="flex gap-2"><button onClick={() => seed.mutate()} className={ghost}><Sparkles className="w-3.5 h-3.5" /> القوالب الجاهزة (AML)</button>
          <button onClick={() => setEdit({ name: "", steps: [{ afterHours: 0, subject: "", html: "" }], stopOnReply: true, stopOnOpen: false })} className={primary}><Plus className="w-3.5 h-3.5" /> تسلسل جديد</button></div>
      </div>
      {edit && (
        <div className={cn(card, "p-4 space-y-3")}>
          <input className={input} placeholder="اسم التسلسل" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          {edit.steps.map((s: any, i: number) => (
            <div key={i} className="rounded-lg border border-card-border p-3 space-y-2">
              <div className="flex items-center gap-2"><span className="text-xs font-semibold">الخطوة {i + 1}</span><span className="text-[11px] text-muted-foreground">بعد</span><input type="number" className={cn(input, "w-24")} value={s.afterHours} onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, afterHours: Number(e.target.value) }; setEdit({ ...edit, steps: st }); }} /><span className="text-[11px] text-muted-foreground">ساعة من التسجيل</span>
                <button onClick={() => setEdit({ ...edit, steps: edit.steps.filter((_: any, j: number) => j !== i) })} className="mr-auto text-red-400"><Trash2 className="w-3.5 h-3.5" /></button></div>
              <input className={input} placeholder="العنوان" value={s.subject} onChange={(e) => { const st = [...edit.steps]; st[i] = { ...s, subject: e.target.value }; setEdit({ ...edit, steps: st }); }} />
              <EmailEditor value={s.html} subject={s.subject} compact minHeight={200} onChange={(html) => { const st = [...edit.steps]; st[i] = { ...s, html }; setEdit({ ...edit, steps: st }); }} />
              <PreviewButton subject={s.subject} html={s.html} />
            </div>
          ))}
          <div className="flex gap-2 flex-wrap items-center">
            <button onClick={() => setEdit({ ...edit, steps: [...edit.steps, { afterHours: (edit.steps.at(-1)?.afterHours ?? 0) + 72, subject: "", html: "" }] })} className={ghost}><Plus className="w-3 h-3" /> خطوة</button>
            <label className="text-xs flex items-center gap-1.5"><input type="checkbox" checked={edit.stopOnReply} onChange={(e) => setEdit({ ...edit, stopOnReply: e.target.checked })} /> توقف عند الرد</label>
            <label className="text-xs flex items-center gap-1.5"><input type="checkbox" checked={edit.stopOnOpen} onChange={(e) => setEdit({ ...edit, stopOnOpen: e.target.checked })} /> توقف عند الفتح</label>
            <button onClick={() => save.mutate(edit)} disabled={save.isPending} className={cn(primary, "mr-auto")}>احفظ</button><button onClick={() => setEdit(null)} className={ghost}>إلغاء</button>
          </div>
        </div>
      )}
      <div className={cn(card, "divide-y divide-card-border")}>
        {seqs.length === 0 && <p className="p-6 text-sm text-muted-foreground text-center">لا تسلسلات بعد — اضغط «القوالب الجاهزة» لتثبيت تسلسل AML.</p>}
        {seqs.map((s) => (
          <div key={s.id} className="p-3.5 flex items-center gap-3 flex-wrap">
            <button onClick={() => setEdit({ ...s })} className="font-semibold text-sm hover:text-primary">{s.name}</button>
            <span className={cn("text-[10px] px-2 py-0.5 rounded border", s.isActive ? "border-primary/40 text-primary" : "border-card-border text-muted-foreground")}>{s.isActive ? "يعمل" : "موقوف"}</span>
            <span className="text-[11px] text-muted-foreground">{(s.steps ?? []).length} خطوات · {s.pending} مجدولة · {s.sent} أُرسلت</span>
            <div className="mr-auto flex gap-1.5 items-center">
              <select className={cn(input, "w-44 text-xs")} value={enrolList[s.id] ?? ""} onChange={(e) => setEnrolList({ ...enrolList, [s.id]: e.target.value })}><option value="">اختر قائمة…</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({l.count})</option>)}</select>
              <button disabled={!enrolList[s.id]} onClick={() => enrol.mutate({ id: s.id, listId: Number(enrolList[s.id]) })} className={ghost}><Play className="w-3 h-3" /> سجّل القائمة</button>
              <button onClick={() => toggle.mutate(s)} className={ghost}>{s.isActive ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}</button>
              <button onClick={() => confirm("حذف التسلسل؟") && del.mutate(s.id)} className={ghost}><Trash2 className="w-3 h-3" /></button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Templates ─────────────────────────────────────────────────────
function Templates() {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery<any[]>({ queryKey: ["email-templates"], queryFn: () => api("/api/email/templates") });
  const [edit, setEdit] = useState<any | null>(null);
  const inv = () => qc.invalidateQueries({ queryKey: ["email-templates"] });
  const save = useMutation({ mutationFn: (t: any) => t.id ? api(`/api/email/templates/${t.id}`, { method: "PATCH", body: JSON.stringify(t) }) : api("/api/email/templates", { method: "POST", body: JSON.stringify(t) }), onSuccess: () => { setEdit(null); inv(); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: (id: number) => api(`/api/email/templates/${id}`, { method: "DELETE" }), onSuccess: inv });
  const [cat, setCat] = useState("");
  const [view, setView] = useState<any | null>(null);
  const cats = [...new Set(rows.map((t) => t.category).filter(Boolean))] as string[];
  const shown = (cat ? rows.filter((t) => t.category === cat) : rows).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-center">
        <div className="flex gap-1 flex-wrap flex-1">
          {["", ...cats].map((c) => <button key={c} onClick={() => setCat(c)} className={cn("px-2.5 py-1 rounded-full border text-[11px]", cat === c ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{c || "الكل"} ({c ? rows.filter((t) => t.category === c).length : rows.length})</button>)}
        </div>
        <button onClick={() => setEdit({ name: "", subject: "", html: "", category: "" })} className={primary}><Plus className="w-3.5 h-3.5" /> قالب</button>
      </div>
      {edit && <div className={cn(card, "p-4 space-y-2")}>
        <div className="grid md:grid-cols-2 gap-2"><input className={input} placeholder="الاسم" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /><input className={input} placeholder="التصنيف" value={edit.category ?? ""} onChange={(e) => setEdit({ ...edit, category: e.target.value })} /></div>
        <input className={input} placeholder="العنوان" value={edit.subject} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
        <EmailEditor value={edit.html} subject={edit.subject} onChange={(html) => setEdit({ ...edit, html })} minHeight={320} />
        <div className="flex gap-2"><button onClick={() => save.mutate(edit)} className={primary}>احفظ</button><button onClick={() => setEdit(null)} className={ghost}>إلغاء</button><PreviewButton subject={edit.subject} html={edit.html} /></div>
      </div>}
      {rows.length === 0 && <div className={cn(card, "p-6 text-sm text-muted-foreground text-center")}>لا قوالب — «القوالب الجاهزة» في تبويب المتابعة تثبّت قوالب AML.</div>}
      {/* The gallery: each template as it arrives, small; click for the full view. */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {shown.map((t) => (
          <div key={t.id} className={cn(card, "overflow-hidden flex flex-col group")}>
            <button onClick={() => setView(t)} className="relative h-56 overflow-hidden bg-[#eef2f6] border-b border-card-border" title="معاينة">
              <iframe title={t.name} src={`${BASE}/api/email/templates/${t.id}/render?v=${new Date(t.updatedAt ?? 0).getTime()}`} loading="lazy" tabIndex={-1}
                className="pointer-events-none origin-top-left absolute top-0 left-0 border-0" style={{ width: 640, height: 900, transform: "scale(0.42)" }} />
              <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/30 transition-opacity"><span className="flex items-center gap-1 text-xs text-white bg-black/60 px-3 py-1.5 rounded-full"><Eye className="w-3.5 h-3.5" /> معاينة</span></span>
            </button>
            <div className="p-3 flex-1 flex flex-col gap-1">
              {t.category && <span className="self-start text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{t.category}</span>}
              <p className="text-xs font-semibold leading-snug" dir="auto">{t.name}</p>
              <p className="text-[11px] text-muted-foreground line-clamp-2" dir="auto">{t.subject}</p>
              <div className="flex gap-1.5 mt-auto pt-2">
                <button onClick={() => setEdit({ ...t })} className={cn(ghost, "flex-1 justify-center")}>تعديل</button>
                <button onClick={() => confirm(`حذف «${t.name}»؟`) && del.mutate(t.id)} className={ghost}><Trash2 className="w-3 h-3" /></button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {view && <TemplateView t={view} onClose={() => setView(null)} />}
    </div>
  );
}

/** A template full size, as the server renders it — the firm's layout, signature and sample names. */
function TemplateView({ t, onClose }: { t: any; onClose: () => void }) {
  const { data: html } = useQuery<string>({ queryKey: ["email-template-render", t.id, t.updatedAt], queryFn: async () => (await fetch(`${BASE}/api/email/templates/${t.id}/render`, { credentials: "include" })).text() });
  if (!html) return null;
  return <EmailPreviewModal html={html} subject={t.subject.replace(/\{\{\s*company\s*(\|[^}]*)?\}\}/g, "Al Noor Real Estate").replace(/\{\{[^}]*\}\}/g, "")} onClose={onClose} />;
}

// ── Inbox ─────────────────────────────────────────────────────────
function InboxTab() {
  const qc = useQueryClient();
  const { data: rows = [] } = useQuery<any[]>({ queryKey: ["email-inbound"], queryFn: () => api("/api/email/inbound"), refetchInterval: 15_000 });
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ subject: string; body: string }>({ subject: "", body: "" });
  const inv = () => qc.invalidateQueries({ queryKey: ["email-inbound"] });
  const redraft = useMutation({ mutationFn: (id: number) => api(`/api/email/inbound/${id}/draft`, { method: "POST" }), onSuccess: (d: any) => { setDraft({ subject: d.subject, body: d.body }); inv(); }, onError: (e: Error) => toast.error(e.message) });
  const send = useMutation({ mutationFn: (id: number) => api(`/api/email/inbound/${id}/send`, { method: "POST", body: JSON.stringify(draft) }), onSuccess: () => { inv(); toast.success("أُرسل الرد"); setOpen(null); }, onError: (e: Error) => toast.error(e.message) });
  const ignore = useMutation({ mutationFn: (id: number) => api(`/api/email/inbound/${id}/ignore`, { method: "POST" }), onSuccess: inv });
  const hold = useMutation({ mutationFn: (id: number) => api(`/api/email/inbound/${id}/hold`, { method: "POST" }), onSuccess: () => { inv(); toast.success("لن يُرسل تلقائياً — ينتظرك"); } });
  const poll = useMutation({ mutationFn: () => api("/api/email/settings/poll", { method: "POST" }), onSuccess: (d: any) => { inv(); toast.success(d.lastError ? `خطأ: ${d.lastError}` : `قُرئت ${d.handled} رسالة`); }, onError: (e: Error) => toast.error(e.message) });
  const INTENT: Record<string, string> = { interested: "مهتم", question: "سؤال", not_interested: "غير مهتم", complaint: "شكوى", opt_out: "إيقاف", greeting: "تحية", unclear: "غير واضح" };
  const cur = rows.find((r) => r.id === open);
  useEffect(() => { if (cur) setDraft({ subject: cur.draftSubject ?? `Re: ${cur.subject ?? ""}`, body: cur.draftReply ?? "" }); }, [open]);

  return (
    <div className="grid lg:grid-cols-[22rem_1fr] gap-4">
      <div className={cn(card, "max-h-[40rem] overflow-y-auto")}>
        <div className="p-3 border-b border-card-border flex items-center justify-between"><p className="text-sm font-semibold">الردود الواردة</p><button onClick={() => poll.mutate()} disabled={poll.isPending} className={ghost}>{poll.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} اقرأ الآن</button></div>
        {rows.length === 0 && <p className="p-6 text-xs text-muted-foreground text-center">لا ردود بعد. تُقرأ من صندوق IMAP كل دقيقتين، أو تصل عبر webhook المزوّد.</p>}
        {rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r.id)} className={cn("w-full text-right p-3 border-b border-card-border hover:bg-muted/40", open === r.id && "bg-muted/60", r.state === "ignored" && "opacity-50")}>
            <div className="flex items-center gap-2"><span className="text-xs font-semibold truncate">{r.company ?? r.fromName ?? r.fromEmail}</span><span className={cn("text-[10px] px-1.5 rounded", r.intent === "interested" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>{INTENT[r.intent] ?? r.intent ?? ""}</span><span className="text-[10px] text-muted-foreground mr-auto">{ago(r.receivedAt)}</span></div>
            <p className="text-[11px] text-muted-foreground truncate mt-0.5">{r.summary ?? r.subject ?? ""}</p>
            <p className="text-[10px] mt-0.5">{r.state === "sent" ? <span className="text-green-400">رُدّ عليه</span> : r.state === "drafted" ? <span className="text-blue-400">مسودة جاهزة</span> : r.state === "ignored" ? "متجاهَل" : <span className="text-yellow-400">جديد</span>}</p>
          </button>
        ))}
      </div>
      <div className={cn(card, "p-4 space-y-3")}>
        {!cur ? <p className="text-sm text-muted-foreground text-center py-10">اختر رداً.</p> : <>
          <div><p className="text-sm font-semibold">{cur.fromName ?? ""} <span className="font-mono text-xs text-muted-foreground" dir="ltr">&lt;{cur.fromEmail}&gt;</span>{cur.company ? ` — ${cur.company}` : ""}</p>
            <p className="text-[11px] text-muted-foreground">{cur.subject}{cur.ourSubject ? ` · ردّاً على «${cur.ourSubject}»` : ""}</p></div>
          {cur.summary && <p className="text-xs rounded-lg bg-muted/50 p-2.5"><span className="text-muted-foreground">ماذا يريد: </span>{cur.summary}</p>}
          <pre className="text-xs whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto rounded-lg border border-card-border p-3" dir="auto">{cur.text}</pre>
          <div className="flex items-center gap-2"><p className="text-xs font-semibold">ردّ هال</p><button onClick={() => redraft.mutate(cur.id)} disabled={redraft.isPending} className={ghost}>{redraft.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />} {cur.draftReply ? "أعد الصياغة" : "اكتب مسودة"}</button></div>
          <input className={input} value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <textarea className={cn(input, "min-h-[12rem] leading-relaxed")} dir="auto" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} placeholder="المسودة تظهر هنا — عدّلها ثم أرسل" />
          {cur.autoSendAt && cur.state === "drafted" && (
            <p className="text-[11px] text-blue-400">سيُرسل تلقائياً {new Date(cur.autoSendAt).toLocaleTimeString("ar-AE", { hour: "2-digit", minute: "2-digit" })} — عدّله وأرسله بنفسك، أو <button onClick={() => hold.mutate(cur.id)} className="underline">أوقف الإرسال التلقائي</button>.</p>
          )}
          <div className="flex gap-2"><button onClick={() => send.mutate(cur.id)} disabled={send.isPending || !draft.body.trim() || cur.state === "sent"} className={primary}><Send className="w-3.5 h-3.5" /> أرسل الرد</button><button onClick={() => ignore.mutate(cur.id)} className={ghost}>تجاهل</button></div>
        </>}
      </div>
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────
function SettingsTab() {
  const qc = useQueryClient();
  const { data } = useQuery<any>({ queryKey: ["email-settings"], queryFn: () => api("/api/email/settings") });
  const [f, setF] = useState<any>(null);
  useEffect(() => { if (data && !f) setF({ provider: "smtp", smtpPort: 587, imapPort: 993, hourlyCap: 40, dailyCap: 300, tracking: true, ...(data.settings ?? {}) }); }, [data]);
  const save = useMutation({ mutationFn: (b: any) => api("/api/email/settings", { method: "PUT", body: JSON.stringify(b) }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["email-settings"] }); qc.invalidateQueries({ queryKey: ["email-overview"] }); toast.success("حُفظت"); }, onError: (e: Error) => toast.error(e.message) });
  const test = useMutation({ mutationFn: () => api("/api/email/settings/test", { method: "POST" }), onSuccess: (d: any) => toast[d.ok ? "success" : "error"](d.detail) });
  // A test to any address — another provider (Gmail) shows whether mail leaves the domain — and what the server answered.
  const [testTo, setTestTo] = useState("");
  const testSend = useMutation({
    mutationFn: () => api("/api/email/settings/test-send", { method: "POST", body: JSON.stringify({ to: testTo.trim() || undefined }) }),
    onError: (e: Error) => toast.error(e.message),
  });
  const [dns, setDns] = useState<any>(null);
  const checkDns = useMutation({ mutationFn: () => api("/api/email/settings/dns"), onSuccess: setDns, onError: (e: Error) => toast.error(e.message) });
  if (!f) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  const L = ({ l, k, type = "text", ph = "" }: { l: string; k: string; type?: string; ph?: string }) => (
    <div><label className="text-xs font-semibold block mb-1.5">{l}</label><input type={type} className={input} value={f[k] ?? ""} placeholder={ph} onChange={(e) => setF({ ...f, [k]: type === "number" ? Number(e.target.value) : e.target.value })} dir={/pass|host|user|email|key/i.test(k) ? "ltr" : undefined} /></div>
  );
  return (
    <div className="space-y-4">
      <div className={cn(card, "p-4 space-y-3")}>
        <p className="text-sm font-semibold">المُرسِل</p>
        <div className="grid md:grid-cols-3 gap-3">
          <div><label className="text-xs font-semibold block mb-1.5">الطريقة</label><select className={input} value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}><option value="smtp">SMTP (Google Workspace / Microsoft 365 / Hostinger / Zoho)</option><option value="resend">Resend API</option><option value="brevo">Brevo API</option></select></div>
          <L l="اسم المُرسِل" k="fromName" ph="بروكاونت للمحاسبة" /><L l="بريد المُرسِل" k="fromEmail" ph="hello@procount.ae" />
        </div>
        {f.provider === "smtp" ? <div className="grid md:grid-cols-4 gap-3"><L l="SMTP host" k="smtpHost" ph="smtp.gmail.com" /><L l="المنفذ" k="smtpPort" type="number" /><L l="المستخدم" k="smtpUser" /><L l="كلمة المرور / App password" k="smtpPass" type="password" /></div>
          : <L l="API key" k="apiKey" type="password" />}
        <div className="grid md:grid-cols-4 gap-3"><L l="Reply-To (اختياري)" k="replyTo" /><L l="حصة الساعة" k="hourlyCap" type="number" /><L l="حصة اليوم" k="dailyCap" type="number" />
          <label className="text-xs flex items-center gap-2 pt-6"><input type="checkbox" checked={!!f.tracking} onChange={(e) => setF({ ...f, tracking: e.target.checked })} /> تتبّع الفتح والنقر</label></div>
        <div><label className="text-xs font-semibold block mb-1.5">التوقيع (HTML)</label><textarea className={cn(input, "min-h-[5rem] text-xs")} value={f.signature ?? ""} onChange={(e) => setF({ ...f, signature: e.target.value })} placeholder="{{sender}}<br>بروكاونت للمحاسبة<br>+971 …" /></div>
        <p className="text-[11px] text-muted-foreground">ابدأ بحصة صغيرة (٤٠ في الساعة، ٣٠٠ في اليوم) لعنوان جديد وارفعها بعد أسبوعين من ارتداد منخفض. الإرسال داخل ساعات العمل فقط.</p>
      </div>
      <div className={cn(card, "p-4 space-y-3")}>
        <p className="text-sm font-semibold">اللغة والمتابعة</p>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-xs">لغة الإيميلات الافتراضية
            <select className={cn(input, "mt-1")} value={f.defaultLanguage ?? "en"} onChange={(e) => setF({ ...f, defaultLanguage: e.target.value })}>
              <option value="en">🇬🇧 الإنجليزية (الأساس)</option><option value="ar">العربية</option><option value="both">العربية والإنجليزية</option>
            </select>
            <span className="block text-[10px] text-muted-foreground mt-1">كل حملة ومتابعة ورد تُكتب بها، ولا تتغير إلا إذا اخترت لغة أخرى لحملة بعينها.</span></label>
          <label className="text-xs">شدة المتابعة
            <select className={cn(input, "mt-1")} value={f.followIntensity ?? "intense"} onChange={(e) => setF({ ...f, followIntensity: e.target.value })}>
              <option value="intense">مكثّفة — ٦ رسائل: يوم ٠، ٢، ٥، ٩، ١٤، ٢١</option>
              <option value="normal">عادية — ٤ رسائل: يوم ٠، ٣، ٧، ١٤</option>
              <option value="light">خفيفة — ٣ رسائل: يوم ٠، ٣، ١٠</option>
            </select>
            <span className="block text-[10px] text-muted-foreground mt-1">تتوقف لأي شخص فور أن يرد أو يلغي أو يرتد بريده. المكثّفة تحتاج قائمة نظيفة: ارتداد عالٍ يوقف الإرسال تلقائياً.</span></label>
        </div>
      </div>
      <div className={cn(card, "p-4 space-y-3")}>
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold">هوية الرسائل</p>
          <div className="mr-auto flex gap-1">
            {([["branded", "تصميم الشركة"], ["plain", "رسالة بسيطة"]] as const).map(([k, l]) => (
              <button key={k} onClick={() => setF({ ...f, layout: k })} className={cn("px-3 py-1.5 rounded-lg text-xs border", (f.layout ?? "branded") === k ? "border-primary bg-primary/10 text-primary" : "border-card-border text-muted-foreground")}>{l}</button>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">رأس بلون الشركة وشعارها، الرسالة في بطاقة بيضاء، وتذييل فيه العنوان والموقع والهاتف ورابط إلغاء الاشتراك — يُطبَّق على كل رسالة تلقائياً. الشعار رابط صورة PNG على موقعكم (https).</p>
        {(f.layout ?? "branded") === "branded" && (<>
          <div className="grid md:grid-cols-3 gap-3"><L l="اسم العلامة" k="brandName" ph="PRO COUNT" /><L l="السطر تحت الاسم" k="brandTagline" ph="Accounting · Tax · AML Compliance" /><L l="رابط الشعار (PNG)" k="logoUrl" ph="https://www.pro-count.ae/apple-touch-icon.png" /></div>
          <div className="grid md:grid-cols-3 gap-3"><L l="الموقع" k="website" ph="www.pro-count.ae" /><L l="الهاتف" k="phone" ph="+971 54 232 8336" /><L l="العنوان" k="address" ph="Abu Dhabi, United Arab Emirates" /></div>
          <div className="flex gap-4 flex-wrap items-center">
            {([["brandColor", "لون الرأس", "#111c33"], ["brandAccent", "لون الأزرار والروابط", "#0284c7"]] as const).map(([k, l, d]) => (
              <label key={k} className="text-xs flex items-center gap-2">{l}<input type="color" value={f[k] || d} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="w-9 h-7 rounded border border-card-border bg-transparent" /><code className="text-[10px] text-muted-foreground" dir="ltr">{f[k] || d}</code></label>
            ))}
            <PreviewButton subject="Preview — Pro Count" html={`<p>Hello {{first_name|there}},</p><p>This is how every email from {{sender}} looks: your header, the message in a card, and your details in the footer.</p><div class="note">A highlighted box for the one point that matters.</div><p class="cta"><a href="https://${(f.website || "www.pro-count.ae").replace(/^https?:\/\//, "")}">Book a free consultation</a></p><p>Best regards,<br>The team</p>`} />
            <span className="text-[10px] text-muted-foreground">احفظ أولاً ثم عاين.</span>
          </div>
        </>)}
      </div>
      <div className={cn(card, "p-4 space-y-3")}>
        <p className="text-sm font-semibold">العمل الذاتي</p>
        <label className="text-xs flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={f.warmup !== false} onChange={(e) => setF({ ...f, warmup: e.target.checked })} />
          <span><b>إحماء المُرسِل</b> — عنوان جديد يبدأ بـ٥٠ رسالة يومياً ويزيد ٣٠٪ يومياً حتى حصة اليوم التي كتبتها. مزوّدو البريد يحكمون على المُرسِل من أسابيعه الأولى.</span></label>
        <label className="text-xs flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={!!f.autoReply} onChange={(e) => setF({ ...f, autoReply: e.target.checked })} />
          <span><b>الرد التلقائي</b> — يُرسل هال مسودته وحده بعد تأخير، على الأسئلة والاهتمام والتحية فقط. الشكوى والرفض ينتظرانك دائماً، وتستطيع إيقاف أي رد قبل إرساله.</span></label>
        {f.autoReply && <div className="w-48"><label className="text-xs font-semibold block mb-1.5">التأخير (دقائق، ± عشوائي)</label><input type="number" className={input} value={f.autoReplyDelayMin ?? 12} onChange={(e) => setF({ ...f, autoReplyDelayMin: Number(e.target.value) })} /></div>}
      </div>
      <div className={cn(card, "p-4 space-y-3")}>
        <p className="text-sm font-semibold">قراءة الردود (IMAP)</p>
        <div className="grid md:grid-cols-4 gap-3"><L l="IMAP host" k="imapHost" ph="imap.gmail.com" /><L l="المنفذ" k="imapPort" type="number" /><L l="المستخدم" k="imapUser" ph="فارغ = نفس مستخدم الإرسال" /><L l="كلمة المرور" k="imapPass" type="password" ph="فارغ = نفس كلمة مرور الإرسال" /></div>
        <p className="text-[11px] text-muted-foreground">يُقرأ صندوق الوارد كل دقيقتين؛ كل رد يُصنَّف ويُلخَّص ويكتب هال مسودة الرد. {data?.settings?.imapLastError && <span className="text-red-400">آخر خطأ: {data.settings.imapLastError}</span>}
          {data?.settings?.inboundToken && <> · أو وجّه webhook المزوّد إلى <code dir="ltr">{data.trackingBase ?? ""}/api/email/inbound/{data.settings.inboundToken}</code> (والارتدادات إلى <code dir="ltr">/api/email/events/{data.settings.inboundToken}</code>).</>}</p>
      </div>
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => save.mutate(f)} disabled={save.isPending} className={primary}>{save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} احفظ</button>
        <button onClick={() => test.mutate()} disabled={test.isPending} className={ghost}>اختبر الاتصال</button>
        <input className={cn(input, "w-56 text-xs")} dir="ltr" placeholder={f.fromEmail || "you@gmail.com"} value={testTo} onChange={(e) => setTestTo(e.target.value)} title="اختبر أيضاً إلى Gmail — يبيّن أن البريد يخرج من النطاق" />
        <button onClick={() => testSend.mutate()} disabled={testSend.isPending} className={ghost}>{testSend.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />} أرسل رسالة اختبار</button>
        <button onClick={() => checkDns.mutate()} disabled={checkDns.isPending} className={ghost}>افحص SPF / DKIM / DMARC</button>
      </div>
      {testSend.data && (() => {
        const r: any = testSend.data;
        const took = r.rejected?.length ? false : true;
        return (
          <div className={cn(card, "p-3 text-xs space-y-1", took ? "border-primary/30" : "border-red-500/40")}>
            <p className="font-semibold">{took ? `قبِل السيرفر الرسالة إلى ${r.to}` : `رفض السيرفر ${r.rejected.join("، ")}`}</p>
            {r.serverReply && <p className="text-muted-foreground">ردّ السيرفر: <code dir="ltr">{r.serverReply}</code></p>}
            <p className="text-muted-foreground">إن لم تصل خلال دقيقتين: افحص البريد غير المرغوب، ثم افتح <b>Email Logs</b> في لوحة مزوّد البريد وابحث عن هذه الرسالة — يقول السجل هل سُلّمت أو حُجزت ولماذا. وجرّب الإرسال إلى Gmail أيضاً.</p>
          </div>
        );
      })()}
      {dns && (
        <div className={cn(card, "p-4 space-y-2 text-xs")}>
          <p className="font-semibold">{dns.domain}</p>
          {[["SPF", dns.spf.ok, dns.spf.note], ["DKIM", dns.dkim.found, dns.dkim.note], ["DMARC", dns.dmarc.ok, dns.dmarc.note], ["MX", dns.mx.found, dns.mx.found ? dns.mx.hosts.join(", ") : "لا سجلات MX — النطاق لا يستقبل بريداً"]].map(([n, ok, note]) => (
            <p key={String(n)} className="flex gap-2"><span className={ok ? "text-primary" : "text-red-400"}>{ok ? "✓" : "✗"}</span><b className="w-14">{n}</b><span className="text-muted-foreground" dir="auto">{note}</span></p>
          ))}
          <p className="text-[11px] text-muted-foreground">بدون الثلاثة تصل رسائلك إلى «غير المرغوب» أو لا تصل. تُضاف من لوحة DNS لنطاقك.</p>
        </div>
      )}
    </div>
  );
}

