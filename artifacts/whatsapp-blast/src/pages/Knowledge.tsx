import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Brain, Plus, Trash2, Loader2, FlaskConical, KeyRound, CheckCircle2, AlertCircle, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { UnifiedKnowledge } from "@/components/UnifiedKnowledge";

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

export default function Knowledge() {
  const qc = useQueryClient();
  const [bulk, setBulk] = useState("");
  const [probe, setProbe] = useState("");
  const [result, setResult] = useState<any>(null);

  const { data: provider } = useQuery<any>({ queryKey: ["kb-provider"], queryFn: () => api("/api/knowledge/provider") });
  const { data: profile } = useQuery<any>({ queryKey: ["kb-profile"], queryFn: () => api("/api/knowledge/profile") });
  const { data: entries = [] } = useQuery<any[]>({ queryKey: ["kb-entries"], queryFn: () => api("/api/knowledge/entries") });

  const [form, setForm] = useState({ name: "", industry: "", description: "", tone: "friendly", guardrails: "", autoReply: false });
  const loaded = profile && form.name === "" && profile.name;
  if (loaded) setForm({
    name: profile.name ?? "", industry: profile.industry ?? "", description: profile.description ?? "",
    tone: profile.tone ?? "friendly", guardrails: profile.guardrails ?? "", autoReply: !!profile.autoReply,
  });

  const saveProfile = useMutation({
    mutationFn: () => api("/api/knowledge/profile", { method: "PUT", body: JSON.stringify(form) }),
    onSuccess: () => { toast.success("حُفظ الملف"); qc.invalidateQueries({ queryKey: ["kb-profile"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const addBulk = useMutation({
    mutationFn: () => api("/api/knowledge/entries/bulk", { method: "POST", body: JSON.stringify({ text: bulk }) }),
    onSuccess: (d: any) => { toast.success(`أُضيف ${d.added} عنصراً`); setBulk(""); qc.invalidateQueries({ queryKey: ["kb-entries"] }); },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: number) => api(`/api/knowledge/entries/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["kb-entries"] }),
  });

  const startInterview = useMutation({
    mutationFn: () => api("/api/assistant/interview", { method: "POST" }),
    onSuccess: (d: any) => { window.location.href = `/assistant?thread=${d.threadId}`; },
    onError: (e: Error) => toast.error(e.message),
  });

  const testProvider = useMutation({
    mutationFn: () => api("/api/knowledge/provider/test", { method: "POST" }),
    onSuccess: (d: any) => d.ok ? toast.success(`${d.provider} يعمل — ${d.sample}`) : toast.error(d.error),
    onError: (e: Error) => toast.error(e.message),
  });

  const ask = async () => {
    if (!probe.trim()) return;
    try { setResult(await api("/api/knowledge/ask", { method: "POST", body: JSON.stringify({ text: probe }) })); }
    catch (e: any) { toast.error(e.message); }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2"><Brain className="w-6 h-6 text-primary" /> معرفة البوت</h1>
        <p className="text-sm text-muted-foreground mt-1">
          علّم البوت عن مجالك — يجيب من هذه المعلومات فقط، ولا يخترع سعراً ولا موعداً
        </p>
      </div>

      <UnifiedKnowledge />

      {/* Provider */}
      <div className={cn(card, "flex items-start gap-3")}>
        {provider?.configured
          ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
          : <AlertCircle className="w-5 h-5 text-yellow-400 shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">
            {provider?.configured ? `نموذج الذكاء: ${provider.provider}` : "يعمل بلا نموذج ذكاء — إجابات مباشرة من معرفتك"}
          </p>
          {!provider?.configured && (
            <>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                البوت يجيب الآن بنص العنصر المطابق حرفياً. لجعله يصيغ الرد بلغته،
                أضف مفتاحاً مجانياً في <code className="text-primary">.env</code> ثم أعد التشغيل:
              </p>
              <div className="mt-2 space-y-1">
                {provider?.options?.map((o: any) => (
                  <div key={o.id} className="text-xs flex items-start gap-2">
                    <KeyRound className="w-3 h-3 text-muted-foreground mt-0.5 shrink-0" />
                    <span>
                      <span className="text-foreground">{o.label}</span>
                      <span className="text-muted-foreground"> — {o.note} · </span>
                      <code className="text-primary">{o.env}</code>
                      <a href={o.url} target="_blank" rel="noreferrer" className="text-primary hover:underline mr-1">احصل عليه</a>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <button onClick={() => testProvider.mutate()} disabled={testProvider.isPending}
          className="px-3 py-1.5 rounded-lg border border-card-border text-xs hover:border-primary/50 shrink-0">
          {testProvider.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "اختبر"}
        </button>
      </div>

      {/* The interview: the fast way to fill all of this */}
      <div className={cn(card, "flex items-start justify-between gap-3 flex-wrap border-primary/30")}>
        <div className="min-w-0">
          <p className="text-sm font-semibold">🎤 مقابلة التأهيل</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            بدل أن تكتب الملف وقاعدة المعرفة بيدك: مديرة المبيعات تسألك عشرة أسئلة، واحداً في كل مرة، وتكتب هي الملف والمدخلات من إجاباتك. عشر دقائق بدل يوم.
          </p>
        </div>
        <button onClick={() => startInterview.mutate()} disabled={startInterview.isPending}
          className="px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs shrink-0">
          {startInterview.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "ابدأ المقابلة"}
        </button>
      </div>

      {/* Profile */}
      <div className={cn(card, "space-y-3")}>
        <p className="text-sm font-semibold">ملف النشاط</p>
        <div className="grid md:grid-cols-2 gap-3">
          <div><label className={labelCls}>اسم النشاط</label>
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="مثال: النظافة الذهبية" /></div>
          <div><label className={labelCls}>المجال</label>
            <input className={inputCls} value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} placeholder="مثال: خدمات تنظيف" /></div>
        </div>
        <div><label className={labelCls}>وصف مختصر</label>
          <textarea className={cn(inputCls, "min-h-[64px]")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="ماذا تقدّمون ولمن؟" /></div>
        <div className="grid md:grid-cols-2 gap-3">
          <div><label className={labelCls}>الأسلوب</label>
            <select className={inputCls} value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              <option value="friendly">ودّي</option><option value="professional">مهني</option><option value="casual">بسيط</option>
            </select></div>
          <div><label className={labelCls}>ممنوعات (بكلماتك)</label>
            <input className={inputCls} value={form.guardrails} onChange={(e) => setForm({ ...form, guardrails: e.target.value })} placeholder="مثال: لا تعد بخصومات" /></div>
        </div>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input type="checkbox" className="accent-primary mt-0.5" checked={form.autoReply}
            onChange={(e) => setForm({ ...form, autoReply: e.target.checked })} />
          <span className="text-sm">
            <span className="flex items-center gap-1.5"><Bot className="w-4 h-4 text-primary" /> فعّل الرد التلقائي</span>
            <span className="block text-xs text-muted-foreground mt-0.5 leading-relaxed">
              لا يرد أبداً على شكوى أو طلب إيقاف أو رفض — تلك تُترك لك. وإن لم يجد
              معلومة مطابقة يصمت بدل التخمين.
            </span>
          </span>
        </label>
        <button onClick={() => saveProfile.mutate()} disabled={saveProfile.isPending}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50">
          {saveProfile.isPending ? "…" : "حفظ"}
        </button>
      </div>

      {/* Bulk add */}
      <div className={cn(card, "space-y-3")}>
        <p className="text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4 text-primary" /> أضف معلومات</p>
        <p className="text-xs text-muted-foreground leading-relaxed">
          الصق أسئلتك الشائعة. افصل كل موضوع بسطر فارغ — أول سطر عنوان وما بعده التفاصيل.
        </p>
        <textarea className={cn(inputCls, "min-h-[150px] font-mono text-xs")} dir="rtl" value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          placeholder={"الأسعار\nتنظيف شقة غرفتين 250 درهم. فيلا 600 درهم.\n\nمواعيد العمل\nمن السبت إلى الخميس 8ص-8م. الجمعة إجازة."} />
        <button onClick={() => addBulk.mutate()} disabled={addBulk.isPending || !bulk.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50">
          {addBulk.isPending ? "…" : "أضف"}
        </button>
      </div>

      {/* Entries */}
      <div className={card}>
        <p className="text-sm font-semibold mb-3">المعلومات ({entries.length})</p>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">لا توجد معلومات بعد</p>
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-3 p-3 rounded-lg border border-card-border">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{e.title}</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed whitespace-pre-wrap">{e.content}</p>
                  {e.keywords && <p className="text-[11px] text-primary/70 mt-1">مرادفات: {e.keywords}</p>}
                </div>
                <button onClick={() => del.mutate(e.id)} className="p-1.5 rounded hover:bg-red-500/10 shrink-0">
                  <Trash2 className="w-4 h-4 text-red-400" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Probe */}
      <div className={card}>
        <p className="text-sm font-semibold mb-1 flex items-center gap-2"><FlaskConical className="w-4 h-4 text-primary" /> اسأل كما يسأل العميل</p>
        <p className="text-xs text-muted-foreground mb-3">
          إن لم يجد إجابة فسيصمت — وهذا مقصود. الصمت أفضل من رد مخترَع.
        </p>
        <div className="flex gap-2">
          <input className={inputCls} dir="rtl" value={probe} onChange={(e) => setProbe(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()} placeholder="مثال: كم سعر تنظيف شقة غرفتين؟" />
          <button onClick={ask} className="px-4 py-2 rounded-lg border border-card-border text-sm hover:border-primary/50 whitespace-nowrap">اسأل</button>
        </div>
        {result && (
          <div className="mt-3 space-y-2">
            {result.reply ? (
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                <p className="text-sm whitespace-pre-wrap">{result.reply}</p>
                <p className="text-[11px] text-muted-foreground mt-2">
                  المصدر: {result.provider === "kb" ? "نص المعلومة مباشرة" : result.provider}
                  {result.matched?.length > 0 && ` · اعتمد على: ${result.matched.map((m: any) => m.title).join("، ")}`}
                </p>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <p className="text-sm text-yellow-300">لن يرد — {result.reason}</p>
                <p className="text-[11px] text-muted-foreground mt-1">أضف معلومة تغطي هذا السؤال ليتمكن من الرد.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
