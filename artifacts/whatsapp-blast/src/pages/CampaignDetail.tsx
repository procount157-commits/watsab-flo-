import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "wouter";
import {
  useGetCampaign,
  useGetCampaignStats,
  useStartCampaign,
  usePauseCampaign,
  getGetCampaignQueryKey,
  getGetCampaignStatsQueryKey,
  getListCampaignsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight, Play, Pause, Send, XCircle, Users, TrendingUp, Loader2, RefreshCw,
  ShieldCheck, ShieldAlert, ShieldX, AlertOctagon, BarChart2, AlertTriangle,
  CheckCheck, Eye, RotateCcw, RotateCw, FlaskConical, X, Pencil, ThumbsUp, ThumbsDown, FileDown,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const STATUS_LABELS: Record<string, { label: string; class: string }> = {
  draft:       { label: "مسودة",          class: "bg-gray-500/15 text-gray-400 border-gray-500/20" },
  scheduled:   { label: "مجدولة",         class: "bg-purple-500/15 text-purple-400 border-purple-500/20" },
  running:     { label: "تعمل",           class: "bg-green-500/15 text-green-400 border-green-500/20" },
  paused:      { label: "متوقفة",         class: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20" },
  auto_paused: { label: "إيقاف تلقائي",  class: "bg-orange-500/15 text-orange-400 border-orange-500/20" },
  completed:   { label: "مكتملة",         class: "bg-blue-500/15 text-blue-400 border-blue-500/20" },
  failed:      { label: "فشلت",           class: "bg-red-500/15 text-red-400 border-red-500/20" },
};

const LOG_STATUS: Record<string, { label: string; class: string }> = {
  sent:    { label: "مُرسل",     class: "text-green-400" },
  failed:  { label: "فشل",       class: "text-red-400" },
  pending: { label: "بانتظار",   class: "text-yellow-400" },
};

function DeliveryBadge({ deliveredAt, readAt }: { deliveredAt?: string | null; readAt?: string | null }) {
  if (readAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-blue-400 font-medium">
        <CheckCheck className="w-3.5 h-3.5" />
        قُرئت
      </span>
    );
  }
  if (deliveredAt) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-gray-400 font-medium">
        <CheckCheck className="w-3.5 h-3.5" />
        وصلت
      </span>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

interface QualityData {
  campaignId: number;
  campaignStatus: string;
  autoPauseReason: string | null;
  sentCount: number;
  failedCount: number;
  totalCount: number;
  overallFailureRate: number;
  recentFailureRate: number;
  liveWindowSize: number;
  liveFailureRate: number | null;
  riskLevel: "low" | "medium" | "high" | "critical";
  riskScore: number;
  recommendation: string;
  recommendationEn: "continue" | "slow_down" | "pause" | "review";
  recommendationColor: "green" | "yellow" | "orange" | "red";
}

const RISK_META: Record<string, { label: string; color: string; bg: string; icon: typeof ShieldCheck }> = {
  low:      { label: "منخفضة",   color: "text-green-400",  bg: "bg-green-500/10 border-green-500/20",   icon: ShieldCheck },
  medium:   { label: "متوسطة",  color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", icon: ShieldAlert },
  high:     { label: "عالية",    color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20", icon: ShieldX },
  critical: { label: "حرجة",    color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20",       icon: AlertOctagon },
};

const REC_BAR_COLOR: Record<string, string> = {
  green:  "bg-green-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  red:    "bg-red-500",
};

// ── Quality Center Component ───────────────────────────────────────
function QualityCenter({ campaignId, isRunning }: { campaignId: number; isRunning: boolean }) {
  const [quality, setQuality] = useState<QualityData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchQuality = async () => {
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/quality`, { credentials: "include" });
      if (res.ok) setQuality(await res.json());
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => {
    fetchQuality();
    const interval = setInterval(fetchQuality, isRunning ? 10_000 : 30_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId, isRunning]);

  if (loading) {
    return (
      <div className="bg-card border border-card-border rounded-xl p-5 flex items-center gap-3 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        جاري تحليل جودة الحملة...
      </div>
    );
  }

  if (!quality || quality.sentCount + quality.failedCount === 0) {
    return (
      <div className="bg-card border border-card-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-3">
          <BarChart2 className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">مركز جودة الحملة</h2>
        </div>
        <p className="text-xs text-muted-foreground">لا توجد بيانات كافية — ستظهر المؤشرات بعد إرسال أول رسالة</p>
      </div>
    );
  }

  const riskMeta = RISK_META[quality.riskLevel] ?? RISK_META.low;
  const RiskIcon = riskMeta.icon;
  const effectiveRate = Math.max(quality.overallFailureRate, quality.recentFailureRate);
  const barColor = REC_BAR_COLOR[quality.recommendationColor] ?? "bg-green-500";

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-card-border">
        <BarChart2 className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">مركز جودة الحملة</h2>
        <span className={cn("mr-auto text-xs px-2.5 py-0.5 rounded-full border font-medium", riskMeta.bg, riskMeta.color)}>
          <RiskIcon className="w-3 h-3 inline ml-1" />
          مخاطرة {riskMeta.label}
        </span>
      </div>

      <div className="p-5 space-y-5">
        {/* Recommendation banner */}
        <div className={cn("flex items-center gap-3 p-3.5 rounded-xl border text-sm font-medium", riskMeta.bg)}>
          <RiskIcon className={cn("w-5 h-5 flex-shrink-0", riskMeta.color)} />
          <span className={riskMeta.color}>{quality.recommendation}</span>
        </div>

        {/* Auto-pause reason */}
        {quality.autoPauseReason && (
          <div className="flex items-start gap-2 p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg text-xs text-orange-300">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{quality.autoPauseReason}</span>
          </div>
        )}

        {/* Metrics grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "معدل الفشل الكلي", value: `${quality.overallFailureRate}%`, color: quality.overallFailureRate > 25 ? "text-red-400" : quality.overallFailureRate > 10 ? "text-yellow-400" : "text-green-400" },
            { label: "معدل الفشل الأخير", value: `${quality.recentFailureRate}%`, color: quality.recentFailureRate > 25 ? "text-red-400" : quality.recentFailureRate > 10 ? "text-yellow-400" : "text-green-400" },
            { label: "الفشل التراكمي", value: quality.failedCount.toLocaleString("ar-SA"), color: "text-red-400" },
            { label: "نجاح التسليم", value: quality.sentCount.toLocaleString("ar-SA"), color: "text-green-400" },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-muted/40 rounded-lg p-3 text-center">
              <p className={cn("text-lg font-bold tabular-nums", color)}>{value}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Failure rate bar */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-muted-foreground">مستوى المخاطرة</span>
            <span className={cn("font-mono font-bold", riskMeta.color)}>{effectiveRate}%</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className={cn("h-full rounded-full transition-all duration-700", barColor)}
              style={{ width: `${Math.min(effectiveRate * 2, 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground/50 mt-0.5">
            <span>0% — ممتاز</span>
            <span>25% — تحذير</span>
            <span>50%+ — خطر</span>
          </div>
        </div>

        {/* Live window (if running) */}
        {quality.liveFailureRate !== null && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
            مراقبة مباشرة — آخر {quality.liveWindowSize} رسالة: فشل {quality.liveFailureRate}%
          </div>
        )}
      </div>
    </div>
  );
}

async function restartCampaign(id: number): Promise<void> {
  const res = await fetch(`/api/campaigns/${id}/restart`, { method: "POST", credentials: "include" });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "فشلت إعادة التشغيل"); }
}

async function testSendMessage(phone: string, message: string): Promise<{ success: boolean; message?: string; error?: string }> {
  const res = await fetch("/api/whatsapp/test-send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ phone, message }),
  });
  return res.json();
}

async function sendRemainingCampaign(id: number): Promise<{ remainingCount: number }> {
  const res = await fetch(`/api/campaigns/${id}/send-remaining`, { method: "POST", credentials: "include" });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || "فشل الإرسال للمتبقين");
  return d;
}

async function retryFailedCampaign(id: number): Promise<{ retryCount: number; skippedNonRetryable: number; message: string }> {
  const res = await fetch(`/api/campaigns/${id}/retry-failed`, { method: "POST", credentials: "include" });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || "فشلت إعادة المحاولة");
  return d;
}

interface FailureCategory { key: string; label: string; count: number; retryable: boolean; }
interface FailureReport   { total: number; categories: FailureCategory[]; retryableCount: number; }

const CATEGORY_COLOR: Record<string, string> = {
  not_on_wa:      "text-gray-400",
  wa_disc_repeat: "text-orange-400",
  timeout:        "text-yellow-400",
  media_err:      "text-purple-400",
  conn_err:       "text-blue-400",
  other:          "text-red-400",
};

function FailureReportCard({ campaignId, failedCount, onRetry }: { campaignId: number; failedCount: number; onRetry: () => void }) {
  const [report, setReport] = useState<FailureReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!failedCount) { setLoading(false); return; }
    fetch(`/api/campaigns/${campaignId}/failure-report`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setReport(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [campaignId, failedCount]);

  if (!failedCount) return null;
  if (loading) return (
    <div className="bg-card border border-card-border rounded-xl p-5 flex items-center gap-3">
      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      <span className="text-sm text-muted-foreground">جاري تحليل الأخطاء…</span>
    </div>
  );
  if (!report || !report.total) return null;

  return (
    <div className="bg-card border border-red-500/20 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-card-border bg-red-500/5">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <h2 className="text-sm font-semibold text-foreground">تحليل الأخطاء</h2>
        <span className="text-xs text-muted-foreground mr-auto">{report.total} رسالة فاشلة</span>
      </div>
      <div className="p-5 space-y-3">
        {report.categories.map((cat) => (
          <div key={cat.key} className="flex items-center gap-3">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-foreground flex items-center gap-2">
                  <span className={cn("w-2 h-2 rounded-full inline-block", cat.retryable ? "bg-green-500" : "bg-red-500")} />
                  {cat.label}
                </span>
                <span className={cn("text-sm font-bold tabular-nums", CATEGORY_COLOR[cat.key] ?? "text-red-400")}>
                  {cat.count}
                </span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full", cat.retryable ? "bg-yellow-500" : "bg-red-500/60")}
                  style={{ width: `${Math.round((cat.count / report.total) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        ))}
        <div className="pt-2 border-t border-card-border flex items-center justify-between">
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p>
              <span className="inline-block w-2 h-2 rounded-full bg-green-500 ml-1" />
              قابل للإعادة: <span className="text-green-400 font-medium">{report.retryableCount}</span>
            </p>
            <p>
              <span className="inline-block w-2 h-2 rounded-full bg-red-500/60 ml-1" />
              غير قابل للإعادة: <span className="text-red-400 font-medium">{report.total - report.retryableCount}</span>
            </p>
          </div>
          {report.retryableCount > 0 && (
            <button
              onClick={onRetry}
              className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 rounded-lg text-xs font-medium hover:bg-yellow-500/25 transition-colors"
            >
              <RotateCw className="w-3.5 h-3.5" />
              إعادة إرسال {report.retryableCount} رقم
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface ButtonResponse { phone: string; contactName: string | null; action: string; buttonText: string | null; createdAt: string; }
interface ResponsesReport { total: number; interestedCount: number; notInterestedCount: number; stopCount?: number; responses: ButtonResponse[]; }

function ResponsesPanel({ campaignId }: { campaignId: number }) {
  const [report, setReport] = useState<ResponsesReport | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/campaigns/${campaignId}/responses`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setReport(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [campaignId]);

  if (loading) return null;
  if (!report || !report.total) return null;

  return (
    <div className="bg-card border border-card-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-3.5 border-b border-card-border">
        <ThumbsUp className="w-4 h-4 text-green-400" />
        <h2 className="text-sm font-semibold text-foreground">ضغطات الأزرار</h2>
        <span className="text-xs text-muted-foreground mr-auto">{report.total} رد</span>
      </div>
      <div className="p-5 space-y-4">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1.5 text-green-400 font-medium">
            <ThumbsUp className="w-4 h-4" /> مهتم: {report.interestedCount}
          </span>
          <span className="flex items-center gap-1.5 text-red-400 font-medium">
            <ThumbsDown className="w-4 h-4" /> غير مهتم: {report.notInterestedCount}
          </span>
          {!!report.stopCount && (
            <span className="flex items-center gap-1.5 text-orange-400 font-medium" title="لن تُراسَل هذه الأرقام ٥ أشهر">
              🛑 أوقفوا الرسائل: {report.stopCount}
            </span>
          )}
        </div>
        <div className="divide-y divide-card-border max-h-80 overflow-y-auto">
          {report.responses.map((r, i) => (
            <div key={i} className="flex items-center justify-between py-2 text-sm">
              <div>
                <p className="text-foreground font-medium">{r.contactName || r.phone}</p>
                <p className="text-xs text-muted-foreground" dir="ltr">{r.phone}</p>
              </div>
              <span className={cn(
                "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md border font-medium",
                r.action === "interested"
                  ? "bg-green-500/15 text-green-400 border-green-500/20"
                  : r.action === "stop"
                  ? "bg-orange-500/15 text-orange-400 border-orange-500/20"
                  : "bg-red-500/15 text-red-400 border-red-500/20"
              )}>
                {r.action === "interested" ? <ThumbsUp className="w-3 h-3" /> : r.action === "stop" ? "🛑" : <ThumbsDown className="w-3 h-3" />}
                {r.action === "interested" ? "مهتم" : r.action === "stop" ? "أوقف الرسائل" : "غير مهتم"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
// ── Test-Send Dialog ──────────────────────────────────────────────
function TestSendDialog({ onClose }: { onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("رسالة اختبار ✓ واتساب ماركتر");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; text: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSend = async () => {
    if (!phone.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const r = await testSendMessage(phone.trim(), message.trim() || "رسالة اختبار ✓");
      setResult({ success: r.success, text: r.message || r.error || (r.success ? "تم الإرسال" : "فشل") });
      if (r.success) toast.success("تم إرسال رسالة الاختبار ✓");
      else toast.error(r.error || "فشل الإرسال");
    } catch (e: any) {
      setResult({ success: false, text: e.message || "فشل الاتصال بالخادم" });
      toast.error(e.message || "فشل");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-card border border-card-border rounded-2xl w-full max-w-md mx-4 shadow-2xl" dir="rtl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-card-border">
          <FlaskConical className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">إرسال رسالة اختبارية</h2>
          <button onClick={onClose} className="mr-auto p-1 text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-muted-foreground">ترسل هذه الأداة رسالة واحدة مباشرةً عبر جلسة واتساب الحالية — للتحقق أن الإرسال يعمل قبل تشغيل الحملة.</p>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">رقم الهاتف (مع رمز البلد)</label>
            <input
              ref={inputRef}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="مثال: 971501234567"
              dir="ltr"
              className="w-full px-3 py-2 bg-muted border border-card-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">نص الرسالة</label>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 bg-muted border border-card-border rounded-lg text-sm text-foreground focus:outline-none focus:border-primary resize-none"
            />
          </div>
          {result && (
            <div className={cn("flex items-start gap-2 p-3 rounded-lg text-xs font-medium border", result.success ? "bg-green-500/10 border-green-500/20 text-green-400" : "bg-red-500/10 border-red-500/20 text-red-400")}>
              {result.success ? <CheckCheck className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /> : <XCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />}
              {result.text}
            </div>
          )}
          <button
            onClick={handleSend}
            disabled={loading || !phone.trim()}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {loading ? "جاري الإرسال…" : "إرسال الاختبار"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CampaignDetail() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id);
  const queryClient = useQueryClient();
  const [isRestarting, setIsRestarting] = useState(false);
  const [isSendingRemaining, setIsSendingRemaining] = useState(false);
  const [isRetryingFailed, setIsRetryingFailed] = useState(false);
  const [failedKeyVersion, setFailedKeyVersion] = useState(0);
  const [showTestSend, setShowTestSend] = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: campaign, isLoading } = useGetCampaign(id, { query: { enabled: !!id } as any });
  const { data: stats, isLoading: statsLoading } = useGetCampaignStats(id, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: { enabled: !!id, refetchInterval: campaign?.status === "running" ? 3000 : false } as any,
  });

  const startMutation = useStartCampaign({
    mutation: {
      onSuccess: () => {
        toast.success("بدأت الحملة");
        queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getGetCampaignStatsQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      },
      onError: (err: any) => toast.error(err?.data?.error || "خطأ في بدء الحملة"),
    },
  });

  const pauseMutation = usePauseCampaign({
    mutation: {
      onSuccess: () => {
        toast.success("تم إيقاف الحملة مؤقتاً");
        queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
      },
      onError: () => toast.error("حدث خطأ"),
    },
  });

  const handleRestart = async () => {
    if (!confirm("إعادة إرسال الحملة من البداية؟ سيتم مسح سجل الإرسال السابق.")) return;
    setIsRestarting(true);
    try {
      await restartCampaign(id);
      toast.success("تم إعادة تشغيل الحملة من البداية ✓");
      queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getGetCampaignStatsQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsRestarting(false);
    }
  };

  const handleSendRemaining = async () => {
    const remainingCount = (stats?.totalCount ?? 0) - (stats?.sentCount ?? 0) - (stats?.failedCount ?? 0);
    if (!confirm(`إرسال الرسائل للـ ${remainingCount} رقم الذين لم تصلهم؟`)) return;
    setIsSendingRemaining(true);
    try {
      const result = await sendRemainingCampaign(id);
      toast.success(`جاري الإرسال لـ ${result.remainingCount} رقم متبقٍّ ✓`);
      queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getGetCampaignStatsQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsSendingRemaining(false);
    }
  };

  const handleRetryFailed = async () => {
    const failedCount = stats?.failedCount ?? 0;
    if (!confirm(`إعادة إرسال ${failedCount} رسالة فاشلة؟ سيتم تخطي الأرقام غير المسجلة في واتساب.`)) return;
    setIsRetryingFailed(true);
    try {
      const result = await retryFailedCampaign(id);
      toast.success(result.message + " ✓");
      setFailedKeyVersion((v) => v + 1);
      queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getGetCampaignStatsQueryKey(id) });
      queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setIsRetryingFailed(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!campaign) {
    return <div className="p-6 text-center text-muted-foreground">الحملة غير موجودة</div>;
  }

  const st = STATUS_LABELS[campaign.status] ?? STATUS_LABELS.draft;
  const progress = stats?.totalCount ? Math.round((stats.sentCount / stats.totalCount) * 100) : 0;
  const status = campaign.status as string;
  const isRunning = status === "running";
  const isResumable = status === "paused" || status === "auto_paused" || status === "draft";
  // إعادة من البداية متاحة في أي حالة غير draft — حتى أثناء التشغيل (يوقف الـ loop تلقائياً)
  const isRestartable = status !== "draft";
  const remainingCount = (stats?.totalCount ?? 0) - (stats?.sentCount ?? 0) - (stats?.failedCount ?? 0);
  const hasSendRemaining = isRestartable && remainingCount > 0;
  const hasRetryFailed = !isRunning && (stats?.failedCount ?? 0) > 0;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start gap-3">
        <Link href="/campaigns" className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground mt-1">
          <ArrowRight className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-foreground">{campaign.name}</h1>
            <span className={cn("text-xs px-2.5 py-1 rounded-md border font-medium", st.class)}>
              {st.label}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {campaign.contactGroupName || "—"} &bull; {campaign.pacingMode === "manual"
              ? <>تأخير {campaign.delayMin >= 60 ? `${Math.floor(campaign.delayMin/60)}:${String(campaign.delayMin%60).padStart(2,"0")}د` : `${campaign.delayMin}ث`}–{campaign.delayMax >= 60 ? `${Math.floor(campaign.delayMax/60)}:${String(campaign.delayMax%60).padStart(2,"0")}د` : `${campaign.delayMax}ث`}</>
              : <>إيقاع تلقائي</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(stats?.sentCount ?? 0) > 0 && (
            <a
              href={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/campaigns/${id}/report/export`}
              className="flex items-center gap-2 px-4 py-2 bg-muted text-muted-foreground border border-card-border rounded-lg text-sm font-medium hover:bg-muted/80 transition-colors"
              title="تقرير Excel: ملخص الحملة + تفاصيل كل رقم (وصلت؟ قُرئت؟ متى؟ وسبب الفشل)"
            >
              <FileDown className="w-4 h-4" />
              تحميل التقرير
            </a>
          )}
          {isRunning ? (
            <button
              onClick={() => pauseMutation.mutate({ id })}
              disabled={pauseMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-yellow-500/15 text-yellow-400 border border-yellow-500/20 rounded-lg text-sm font-medium hover:bg-yellow-500/20 disabled:opacity-50 transition-colors"
            >
              {pauseMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pause className="w-4 h-4" />}
              إيقاف مؤقت
            </button>
          ) : isResumable ? (
            <button
              onClick={() => startMutation.mutate({ id })}
              disabled={startMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {campaign.status === "draft" ? "تشغيل" : "استئناف"}
            </button>
          ) : null}
          {hasSendRemaining && (
            <button
              onClick={handleSendRemaining}
              disabled={isSendingRemaining}
              className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
              title={`إرسال للأرقام التي لم تصلها الرسالة (${remainingCount} رقم)`}
            >
              {isSendingRemaining ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              إرسال للمتبقين ({remainingCount})
            </button>
          )}
          {hasRetryFailed && (
            <button
              onClick={handleRetryFailed}
              disabled={isRetryingFailed}
              className="flex items-center gap-2 px-4 py-2 bg-red-500/15 text-red-400 border border-red-500/20 rounded-lg text-sm font-medium hover:bg-red-500/25 disabled:opacity-50 transition-colors"
              title={`إعادة إرسال الرسائل الفاشلة (${stats?.failedCount ?? 0} رسالة)`}
            >
              {isRetryingFailed ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCw className="w-4 h-4" />}
              إعادة الفاشلين ({stats?.failedCount ?? 0})
            </button>
          )}
          {isRestartable && (
            <button
              onClick={handleRestart}
              disabled={isRestarting}
              className="flex items-center gap-2 px-4 py-2 bg-muted text-muted-foreground border border-card-border rounded-lg text-sm font-medium hover:bg-muted/80 disabled:opacity-50 transition-colors"
              title="إعادة الإرسال من البداية — يمسح سجل الإرسال السابق"
            >
              {isRestarting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
              من البداية
            </button>
          )}
          <Link href={`/campaigns/${id}/edit`}>
            <a
              className="flex items-center gap-1.5 px-3 py-2 bg-muted text-muted-foreground border border-card-border rounded-lg text-xs font-medium hover:bg-muted/80 transition-colors"
              title="تعديل الحملة"
            >
              <Pencil className="w-3.5 h-3.5" />
              تعديل
            </a>
          </Link>
          <button
            onClick={() => setShowTestSend(true)}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-lg text-xs font-medium hover:bg-blue-500/20 transition-colors"
            title="إرسال رسالة اختبارية للتحقق من جلسة واتساب"
          >
            <FlaskConical className="w-3.5 h-3.5" />
            اختبار
          </button>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: getGetCampaignStatsQueryKey(id) })}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showTestSend && <TestSendDialog onClose={() => setShowTestSend(false)} />}

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "مُرسل", value: stats?.sentCount ?? 0, icon: Send, color: "text-green-400" },
          { label: "فاشل", value: stats?.failedCount ?? 0, icon: XCircle, color: "text-red-400" },
          { label: "الإجمالي", value: stats?.totalCount ?? 0, icon: Users, color: "text-blue-400" },
          { label: "نسبة النجاح", value: `${stats?.successRate ?? 0}%`, icon: TrendingUp, color: "text-primary" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-card border border-card-border rounded-xl p-4">
            <div className="flex items-start justify-between mb-2">
              <p className="text-xs text-muted-foreground">{label}</p>
              <Icon className={cn("w-4 h-4", color)} />
            </div>
            <p className="text-2xl font-bold text-foreground">{value}</p>
          </div>
        ))}
      </div>

      {/* Delivery Stats */}
      {stats && (stats.deliveredCount > 0 || stats.readCount > 0 || stats.sentCount > 0) && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-card-border">
            <CheckCheck className="w-4 h-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">معدل وصول الرسائل</h2>
            <span className="text-xs text-muted-foreground mr-auto">يتحدث تلقائياً عبر أحداث Baileys</span>
          </div>
          <div className="p-5 space-y-4">
            {/* Delivery row */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <CheckCheck className="w-4 h-4 text-gray-400" />
                  وصلت للجهاز
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {stats.deliveredCount.toLocaleString("ar-SA")}
                  <span className="text-xs text-muted-foreground mr-1">
                    ({stats.deliveryRate}%)
                  </span>
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-gray-400 rounded-full transition-all duration-700"
                  style={{ width: `${stats.deliveryRate}%` }}
                />
              </div>
            </div>

            {/* Read row */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Eye className="w-4 h-4 text-blue-400" />
                  قُرئت
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {stats.readCount.toLocaleString("ar-SA")}
                  <span className="text-xs text-muted-foreground mr-1">
                    ({stats.readRate}%)
                  </span>
                </span>
              </div>
              <div className="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-700"
                  style={{ width: `${stats.readRate}%` }}
                />
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground/70 pt-1">
              نسبة الوصول من إجمالي الرسائل المُرسلة — تعتمد على أحداث "تسليم/قراءة" التي تُرسلها واتساب عبر Baileys. الرسائل التي لا يُسمح فيها بإيصالات القراءة ستظل في انتظار التأكيد.
            </p>
          </div>
        </div>
      )}

      {/* Progress Bar */}
      {stats && stats.totalCount > 0 && (
        <div className="bg-card border border-card-border rounded-xl p-5">
          <div className="flex justify-between text-sm mb-2">
            <span className="text-muted-foreground">تقدم الإرسال</span>
            <span className="font-medium text-foreground">{progress}%</span>
          </div>
          <div className="h-2.5 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {stats.sentCount.toLocaleString("ar-SA")} من {stats.totalCount.toLocaleString("ar-SA")} رسالة
          </p>
        </div>
      )}

      {/* ── Campaign Quality Center ───────────────────────────────── */}
      <QualityCenter campaignId={id} isRunning={isRunning} />

      {/* ── Failure Analysis ─────────────────────────────────────── */}
      <FailureReportCard
        key={failedKeyVersion}
        campaignId={id}
        failedCount={stats?.failedCount ?? 0}
        onRetry={handleRetryFailed}
      />

      {/* ── Interested Responses ─────────────────────────────────── */}
      <ResponsesPanel campaignId={id} />

      {/* Message Preview */}
      <div className="bg-card border border-card-border rounded-xl p-5">
        <h2 className="font-semibold text-sm text-foreground mb-3">محتوى الرسالة</h2>
        <div className="bg-muted/50 rounded-lg p-3">
          <p className="text-sm text-foreground whitespace-pre-wrap">{
            campaign.message
              .replace(/\{([^{}]*\|[^{}]*)\}/g, (_, inner: string) => {
                const opts = inner.split("|").map((o: string) => o.trim()).filter(Boolean);
                return opts[0] ?? inner;
              })
              .replace(/\{تحية\}/g, "مرحباً")
              .replace(/\{ختام\}/g, "نتشرف بخدمتك")
              .replace(/\{cta\}/g, "تواصل معنا")
              .replace(/\{فاصل\}/g, "━━━━━━━━━━")
              .replace(/\{الاسم\}|\{name\}|\{اسم\}/gi, "محمد")
              .replace(/\{الوقت\}|\{time\}|\{وقت\}/gi, new Date().toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", hour12: true }))
              .replace(/\{التاريخ\}|\{date\}|\{تاريخ\}/gi, new Date().toLocaleDateString("ar-SA", { weekday: "long", year: "numeric", month: "long", day: "numeric" }))
              .replace(/\{الشركة\}|\{الشركه\}|\{company\}/gi, (campaign as any).companyName || "شركتك")
              .replace(/\{الرقم\}|\{phone\}/gi, "9715XXXXXXXX")
          }</p>
        </div>
        <p className="text-xs text-muted-foreground mt-2">← معاينة تقريبية — المتغيرات ستُستبدل بالبيانات الحقيقية عند الإرسال</p>
        {campaign.mediaUrl && (
          <div className="mt-2">
            {/\.(jpg|jpeg|png|gif|webp)$/i.test(campaign.mediaUrl) || campaign.mediaUrl.includes("/api/media/file/") ? (
              <img src={campaign.mediaUrl} alt="media" className="max-h-32 rounded-lg object-cover border border-card-border" onError={(e) => { e.currentTarget.style.display='none'; }} />
            ) : (
              <p className="text-xs text-muted-foreground font-mono" dir="ltr">{campaign.mediaUrl}</p>
            )}
          </div>
        )}
      </div>

      {/* Logs Table */}
      <div className="bg-card border border-card-border rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-card-border flex items-center justify-between">
          <h2 className="font-semibold text-sm text-foreground">سجل الإرسال</h2>
          {statsLoading && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
        {!stats?.recentLogs?.length ? (
          <div className="py-8 text-center text-muted-foreground text-sm">لا توجد سجلات بعد</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-card-border">
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">الرقم</th>
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">الحالة</th>
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium">التسليم</th>
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium hidden md:table-cell">الخطأ</th>
                  <th className="text-right px-5 py-3 text-xs text-muted-foreground font-medium hidden lg:table-cell">وقت الإرسال</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-card-border">
                {stats.recentLogs.map((log) => {
                  const ls = LOG_STATUS[log.status] ?? LOG_STATUS.pending;
                  return (
                    <tr key={log.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-2.5 text-sm font-mono text-foreground" dir="ltr">{log.phone}</td>
                      <td className="px-5 py-2.5">
                        <span className={cn("text-xs font-medium", ls.class)}>{ls.label}</span>
                      </td>
                      <td className="px-5 py-2.5">
                        <DeliveryBadge deliveredAt={log.deliveredAt} readAt={log.readAt} />
                      </td>
                      <td className="px-5 py-2.5 text-xs text-red-400 hidden md:table-cell">{log.error || "—"}</td>
                      <td className="px-5 py-2.5 text-xs text-muted-foreground hidden lg:table-cell">
                        {log.sentAt ? new Date(log.sentAt).toLocaleString("ar-SA") : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
