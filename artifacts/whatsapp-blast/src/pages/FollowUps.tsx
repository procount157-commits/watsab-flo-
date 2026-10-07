import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Clock, Play, Pause, Trash2, Plus, Users, Megaphone, Loader2,
  FlaskConical, ListChecks, UserPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const api = async (path: string, init?: RequestInit) => {
  const r = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "فشل الطلب");
  return d;
};

const inputCls = "w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring";
const labelCls = "block text-sm text-muted-foreground mb-1.5";
const card = "bg-card border border-card-border rounded-xl p-4";

interface Step { offsetMinutes: number; message: string; label?: string }
interface Sequence {
  id: number; name: string; isActive: boolean; sourceFilter: string;
  stopOnReply: boolean; continueOnIntents: string[]; useAi: boolean;
  steps: Step[];
  stats: { pending: number; sent: number; cancelled: number; failed: number; skipped: number };
}

const INTENTS: Record<string, string> = {
  interested: "مهتم", question: "سؤال", complaint: "شكوى",
  not_interested: "غير مهتم", opt_out: "طلب إيقاف", greeting: "تحية", unclear: "غير واضح",
};

// ── The follow-up خالد writes ─────────────────────────────────────
type SmartRow = { id: number; phone: string; rung: number; verdict: string; reason: string | null; draft: string | null; executed: boolean; created_at: string };
const MODES: { val: "off" | "dry" | "live"; label: string; desc: string; cls: string }[] = [
  { val: "off",  label: "متوقفة", desc: "لا يكتب ولا يرسل",                         cls: "bg-muted text-muted-foreground border-border" },
  { val: "dry",  label: "تجربة",  desc: "يكتب كل متابعة ويسجّلها لك — لا يرسل شيئاً", cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  { val: "live", label: "تعمل",   desc: "يرسل المتابعات فعلاً للعملاء",               cls: "bg-green-500/15 text-green-400 border-green-500/30" },
];

function SmartFollowUps() {
  const qc = useQueryClient();
  const { data } = useQuery<{ mode: "off" | "dry" | "live"; recent: SmartRow[] }>({
    queryKey: ["fu-smart"], queryFn: () => api("/api/follow-ups/smart"), refetchInterval: 60_000,
  });
  const setMode = useMutation({
    mutationFn: (mode: string) => api("/api/follow-ups/smart", { method: "PATCH", body: JSON.stringify({ mode }) }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["fu-smart"] }); toast.success(d.mode === "live" ? "المتابعة تعمل الآن وترسل" : d.mode === "dry" ? "وضع التجربة: يكتب ولا يرسل" : "أُوقفت المتابعة"); },
    onError: (e: any) => toast.error(e.message),
  });
  const run = useMutation({
    mutationFn: () => api("/api/follow-ups/smart/run", { method: "POST" }),
    onSuccess: (d: any) => { qc.invalidateQueries({ queryKey: ["fu-smart"] }); toast.success(d.drafted ? `كتب ${d.drafted} متابعة${d.sent ? ` وأرسل ${d.sent}` : ""}` : "لا أحد مستحق للمتابعة الآن"); },
    onError: (e: any) => toast.error(e.message),
  });
  const mode = data?.mode ?? "dry";
  return (
    <div className={cn(card, "space-y-4")}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold">🧠 المتابعة الذكية — يكتبها خالد لكل عميل</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-2xl">
            يتابع فقط من تكلّم معنا ثم سكت — لا يلاحق من وصلته حملة ولم يرد. كل رسالة مكتوبة له هو من محادثته وما أرسلناه له،
            بزاوية جديدة في كل مرة: بعد يوم، ٣ أيام، أسبوع، أسبوعين (وأسرع للعميل المهتم)، ثم يتوقف. أي رد منه يعيد العدّ.
          </p>
        </div>
        <button onClick={() => run.mutate()} disabled={run.isPending || mode === "off"}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 disabled:opacity-50">
          {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} جولة الآن
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button key={m.val} onClick={() => setMode.mutate(m.val)} disabled={setMode.isPending}
            className={cn("rounded-lg border px-3 py-2 text-right transition-colors", mode === m.val ? m.cls + " font-semibold" : "border-border text-muted-foreground hover:border-primary/30")}>
            <span className="block text-sm">{m.label}</span>
            <span className="block text-[11px] opacity-80 mt-0.5">{m.desc}</span>
          </button>
        ))}
      </div>
      {(data?.recent?.length ?? 0) > 0 ? (
        <div className="divide-y divide-card-border max-h-96 overflow-y-auto">
          {data!.recent.map((r) => (
            <div key={r.id} className="py-2.5 text-sm space-y-1">
              <div className="flex items-center gap-2 text-xs">
                <span dir="ltr" className="text-muted-foreground">+{r.phone}</span>
                <span className="text-muted-foreground">· المتابعة {r.rung}</span>
                <span className={cn("px-1.5 py-0.5 rounded border",
                  r.executed ? "bg-green-500/15 text-green-400 border-green-500/20"
                  : r.verdict === "send" ? "bg-blue-500/15 text-blue-400 border-blue-500/20"
                  : "bg-muted text-muted-foreground border-border")}>
                  {r.executed ? "أُرسلت" : r.verdict === "send" ? "مسودة" : "لم تُرسل"}
                </span>
                <span className="text-muted-foreground mr-auto">{new Date(r.created_at).toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
              {r.draft && <p className="whitespace-pre-wrap text-foreground/90 bg-muted/30 rounded-md px-2.5 py-1.5">{r.draft}</p>}
              {r.reason && <p className="text-xs text-muted-foreground">{r.reason}</p>}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">لا مسودات بعد — يمر خالد على المحادثات كل ٢٠ دقيقة في ساعات الإرسال.</p>
      )}
    </div>
  );
}

export default function FollowUps() {
  const qc = useQueryClient();
  const [name, setName] = useState("متابعة عملاء الإعلان");
  const [openId, setOpenId] = useState<number | null>(null);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<any>(null);
  const [enrolGroupId, setEnrolGroupId] = useState("");

  const { data: sequences = [], isLoading } = useQuery<Sequence[]>({
    queryKey: ["fu-sequences"], queryFn: () => api("/api/follow-ups/sequences"),
  });
  const { data: leads } = useQuery<any>({
    queryKey: ["fu-leads"], queryFn: () => api("/api/follow-ups/leads"),
  });
  const { data: groups = [] } = useQuery<any[]>({
    queryKey: ["contact-groups"], queryFn: () => api("/api/contacts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["fu-sequences"] });
    qc.invalidateQueries({ queryKey: ["fu-leads"] });
  };

  const create = useMutation({
    mutationFn: () => api("/api/follow-ups/sequences", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => { toast.success("أُنشئ التسلسل بالإيقاع الافتراضي"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });

  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) =>
      api(`/api/follow-ups/sequences/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => refresh(),
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/follow-ups/sequences/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("حُذف التسلسل"); refresh(); },
  });

  const enrolGroup = useMutation({
    mutationFn: ({ id, groupId }: { id: number; groupId: number }) =>
      api(`/api/follow-ups/sequences/${id}/enrol-group`, {
        method: "POST", body: JSON.stringify({ groupId, source: "ad" }),
      }),
    onSuccess: (d: any) => {
      toast.success(`سُجّل ${d.enrolled} عميل${d.skippedOptedOut ? ` — تُخطّي ${d.skippedOptedOut} ملغي الاشتراك` : ""}`);
      if (d.note) toast.info(d.note, { duration: 8000 });
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runProbe = async () => {
    if (!probe.trim()) return;
    try { setProbeResult(await api("/api/follow-ups/classify", { method: "POST", body: JSON.stringify({ text: probe }) })); }
    catch (e: any) { toast.error(e.message); }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold">بوت المتابعة</h1>
        <p className="text-sm text-muted-foreground mt-1">
          يتابع مع كل عميل تلقائياً بعد أول تواصل — ويتوقف فور ردّه
        </p>
      </div>

      <SmartFollowUps />

      {/* Leads */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className={card}>
          <Users className="w-5 h-5 text-primary mb-2" />
          <p className="text-xl font-bold">{leads?.total ?? 0}</p>
          <p className="text-xs text-muted-foreground">إجمالي العملاء</p>
        </div>
        <div className={card}>
          <Megaphone className="w-5 h-5 text-blue-400 mb-2" />
          <p className="text-xl font-bold">{leads?.adDetected ?? 0}</p>
          <p className="text-xs text-muted-foreground">من الإعلانات</p>
        </div>
        {["interested", "question"].map((k) => (
          <div key={k} className={card}>
            <ListChecks className="w-5 h-5 text-green-400 mb-2" />
            <p className="text-xl font-bold">{leads?.byIntent?.[k] ?? 0}</p>
            <p className="text-xs text-muted-foreground">{INTENTS[k]}</p>
          </div>
        ))}
      </div>

      {(leads?.adDetected ?? 0) === 0 && (
        <div className="rounded-lg bg-blue-500/10 border border-blue-500/20 p-3">
          <p className="text-xs text-blue-300 leading-relaxed">
            لم يصل عميل من إعلان بعد. هذا الرقم يبقى صفراً حتى ينقر أحدهم إعلان
            «انقر للمراسلة» ويراسلك — وهو ما يؤكد أن بيانات الإحالة تصل فعلاً.
            عملاء استمارة الإعلان يأتون كملف، فسجّل قائمتهم من الأسفل.
          </p>
        </div>
      )}

      {/* New sequence */}
      <div className={card}>
        <p className="text-sm font-semibold mb-3">تسلسل جديد</p>
        <div className="flex gap-2">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم التسلسل" />
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim()}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap"
          >
            {create.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            إنشاء
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          الإيقاع الافتراضي: ساعة ← 6 ← 12 ← يوم ← 3 أيام ← أسبوع ← شهر
        </p>
      </div>

      {/* Sequences */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : sequences.length === 0 ? (
        <div className={cn(card, "text-center text-sm text-muted-foreground py-8")}>لا يوجد تسلسل بعد</div>
      ) : sequences.map((s) => (
        <div key={s.id} className={card}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-semibold">{s.name}</p>
                <span className={cn("px-2 py-0.5 rounded text-[11px] border",
                  s.isActive ? "bg-primary/15 text-primary border-primary/30" : "border-card-border text-muted-foreground")}>
                  {s.isActive ? "نشط" : "متوقف"}
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] border border-card-border text-muted-foreground">
                  {s.sourceFilter === "ad" ? "عملاء الإعلانات فقط" : "كل عملاء واتساب"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {s.steps.length} خطوات · بانتظار {s.stats.pending} · أُرسلت {s.stats.sent} · أُلغيت {s.stats.cancelled}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => patch.mutate({ id: s.id, body: { isActive: !s.isActive } })}
                className="p-2 rounded-lg border border-card-border hover:border-primary/50"
                title={s.isActive ? "إيقاف" : "تفعيل"}
              >
                {s.isActive ? <Pause className="w-4 h-4 text-yellow-400" /> : <Play className="w-4 h-4 text-primary" />}
              </button>
              <button
                onClick={() => { if (confirm(`حذف «${s.name}»؟ سيُلغى كل ما هو مجدول فيه.`)) remove.mutate(s.id); }}
                className="p-2 rounded-lg border border-card-border hover:border-red-500/50"
                title="حذف"
              >
                <Trash2 className="w-4 h-4 text-red-400" />
              </button>
            </div>
          </div>

          <button
            onClick={() => setOpenId(openId === s.id ? null : s.id)}
            className="text-xs text-primary mt-3 hover:underline"
          >
            {openId === s.id ? "إخفاء التفاصيل" : "عرض الخطوات والإعدادات"}
          </button>

          {openId === s.id && (
            <div className="mt-4 space-y-4 border-t border-card-border pt-4">
              <div className="space-y-1.5">
                {s.steps.map((st, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 rounded px-2 py-1 shrink-0 min-w-[92px]">
                      <Clock className="w-3 h-3" />{st.label ?? `${st.offsetMinutes} د`}
                    </span>
                    <span className="text-muted-foreground leading-relaxed">{st.message}</span>
                  </div>
                ))}
              </div>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>يواصل المتابعة عند</label>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(INTENTS).map(([k, lbl]) => {
                      const on = s.continueOnIntents?.includes(k);
                      const locked = k === "opt_out";
                      return (
                        <button
                          key={k}
                          disabled={locked}
                          onClick={() => patch.mutate({ id: s.id, body: {
                            continueOnIntents: on
                              ? s.continueOnIntents.filter((x) => x !== k)
                              : [...(s.continueOnIntents ?? []), k],
                          }})}
                          className={cn("px-2 py-1 rounded text-[11px] border transition-colors",
                            locked ? "border-card-border text-muted-foreground/40 cursor-not-allowed"
                            : on ? "bg-primary/15 text-primary border-primary/30"
                                 : "border-card-border text-muted-foreground hover:border-primary/40")}
                          title={locked ? "طلب الإيقاف يوقف التسلسل دائماً" : undefined}
                        >
                          {lbl}
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                    المحدَّد لا يوقف التسلسل. التحية ليست تفاعلاً، أما السؤال أو نية
                    الشراء فيعنيان أن يتولّى إنسان.
                  </p>
                </div>

                <div>
                  <label className={labelCls}>تسجيل قائمة أرقام (عملاء استمارة الإعلان)</label>
                  <div className="flex gap-2">
                    <select className={inputCls} value={enrolGroupId} onChange={(e) => setEnrolGroupId(e.target.value)}>
                      <option value="">اختر قائمة…</option>
                      {groups.map((g: any) => (
                        <option key={g.id} value={g.id}>{g.name} ({g.contactCount ?? g.count ?? "—"})</option>
                      ))}
                    </select>
                    <button
                      onClick={() => enrolGroup.mutate({ id: s.id, groupId: Number(enrolGroupId) })}
                      disabled={!enrolGroupId || enrolGroup.isPending || !s.isActive}
                      className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50 whitespace-nowrap"
                      title={!s.isActive ? "فعّل التسلسل أولاً" : undefined}
                    >
                      {enrolGroup.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
                      سجّل
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                    المتابعات تتقاسم الحصة اليومية مع الحملات، فقائمة كبيرة تُرسَل
                    على أيام لا دفعة واحدة.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Classifier probe */}
      <div className={card}>
        <p className="text-sm font-semibold mb-1 flex items-center gap-2">
          <FlaskConical className="w-4 h-4 text-primary" /> جرّب تحليل الردود
        </p>
        <p className="text-xs text-muted-foreground mb-3">
          اكتب رداً كما يكتبه عميل، وانظر كيف يصنّفه البوت قبل أن يقرر إيقاف المتابعة أو مواصلتها.
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls} value={probe} dir="rtl"
            onChange={(e) => setProbe(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runProbe()}
            placeholder="مثال: ابغى اطلب اثنين كيف الدفع"
          />
          <button onClick={runProbe} className="px-4 py-2 rounded-lg border border-card-border text-sm hover:border-primary/50 whitespace-nowrap">
            حلّل
          </button>
        </div>
        {probeResult && (
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span className="px-2.5 py-1 rounded bg-primary/15 text-primary text-xs">
              {probeResult.rules.label}
            </span>
            <span className="text-xs text-muted-foreground">ثقة {probeResult.rules.confidence}</span>
            {probeResult.rules.matched?.length > 0 && (
              <span className="text-xs text-muted-foreground">
                طابق: {probeResult.rules.matched.join("، ")}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
