import { useState, useEffect, useRef } from "react";
import { useGetWhatsappStatus, useLogoutWhatsapp } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetWhatsappStatusQueryKey } from "@workspace/api-client-react";
import {
  Smartphone, Wifi, WifiOff, Loader2, LogOut, RefreshCw,
  Activity, Clock, RotateCcw, Zap, AlertTriangle, CheckCircle2, Radio,
  Phone, Plus, DatabaseZap, Trash2, Shield, ExternalLink, Copy,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ── Types ────────────────────────────────────────────────────────
interface SessionEvent {
  id: number;
  event: string;
  detail: string | null;
  createdAt: string;
}

interface WarmupInfo {
  daysConnected: number;
  dailyLimit: number;
  maxLimit: number;
  firstConnected: string | null;
  inSendingHours: boolean;
  sendWindowStart: number;
  sendWindowEnd: number;
}

interface HealthData {
  status: string;
  extendedStatus?: string;
  connected: boolean;
  phone: string | null;
  name: string | null;
  connectedAt: string | null;
  uptimeSeconds: number | null;
  reconnectCount: number;
  lastActivityAt: string;
  lastSuccessfulSendAt?: string | null;
  consecutiveSendFailures?: number;
  recentEvents: SessionEvent[];
  warmup?: WarmupInfo;
}

// ── Helpers ───────────────────────────────────────────────────────
function formatUptime(seconds: number): string {
  if (seconds < 60)   return `${seconds}ث`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}د ${seconds % 60}ث`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}س ${m}د`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("ar-SA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelative(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return `منذ ${diff}ث`;
  if (diff < 3600) return `منذ ${Math.floor(diff / 60)}د`;
  return `منذ ${Math.floor(diff / 3600)}س`;
}

const EVENT_META: Record<string, { label: string; color: string; icon: string }> = {
  connected:        { label: "متصل",              color: "text-green-400",        icon: "🟢" },
  disconnected:     { label: "انقطع الاتصال",     color: "text-red-400",          icon: "🔴" },
  reconnecting:     { label: "إعادة اتصال",       color: "text-yellow-400",       icon: "🟡" },
  qr_ready:         { label: "QR جاهز",           color: "text-blue-400",         icon: "📱" },
  logged_out:       { label: "تسجيل خروج",        color: "text-muted-foreground", icon: "⬜" },
  guardian_rebuild: { label: "إعادة بناء الجلسة", color: "text-orange-400",       icon: "🔧" },
  stale_detected:   { label: "جلسة متوقفة",       color: "text-orange-400",       icon: "⚠️" },
};

const EXTENDED_STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  connected:       { label: "متصل — ممتاز",      color: "text-green-400",  bg: "bg-green-500/10 border-green-500/20" },
  degraded:        { label: "متدهور — إشارة ضعيفة", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  stale:           { label: "جلسة راكدة",          color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  broken_session:  { label: "جلسة تالفة",          color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20" },
  reconnecting:    { label: "إعادة اتصال",          color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  disconnected:    { label: "منفصل",                color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20" },
};

// ── Uptime Monitor Card ───────────────────────────────────────────
function UptimeMonitorCard() {
  const [copied, setCopied] = useState(false);
  const pingUrl = `${window.location.origin}/api/ping`;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(pingUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="bg-card border border-card-border rounded-xl p-5">
      <div className="flex items-start gap-3 mb-4">
        <Shield className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
        <div>
          <p className="font-semibold text-foreground text-sm">الحماية من الإيقاف التلقائي — 24/7</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            لضمان بقاء الواتساب متصلاً على مدار الساعة، اجعل خدمة خارجية تراقب رابط الخادم كل 5 دقائق.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1.5 font-medium">رابط المراقبة (بدون تسجيل دخول):</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-muted/50 border border-border rounded-lg px-3 py-2 text-primary font-mono truncate" dir="ltr">
              {pingUrl}
            </code>
            <button
              onClick={copyUrl}
              className="flex items-center gap-1.5 px-3 py-2 border border-border rounded-lg text-xs text-muted-foreground hover:bg-muted transition-colors flex-shrink-0"
            >
              {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? "تم النسخ" : "نسخ"}
            </button>
          </div>
        </div>

        <div className="bg-muted/30 rounded-lg p-3 text-xs text-muted-foreground space-y-1.5">
          <p className="font-medium text-foreground">خطوات الإعداد:</p>
          <ol className="space-y-1 list-decimal list-inside">
            <li>سجّل في <strong className="text-foreground">UptimeRobot.com</strong> (مجاني)</li>
            <li>أضف مراقب من نوع <strong className="text-foreground">HTTP(s)</strong></li>
            <li>الصق الرابط أعلاه واضبط الفترة على <strong className="text-foreground">5 دقائق</strong></li>
            <li>شغّل المراقبة — الخادم سيبقى يقظاً 24/7</li>
          </ol>
        </div>

        <a
          href="https://uptimerobot.com/dashboard.php#mainDashboard"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 py-2 bg-primary/10 border border-primary/20 text-primary rounded-lg text-xs font-medium hover:bg-primary/20 transition-colors w-fit"
        >
          <ExternalLink className="w-3.5 h-3.5" />
          فتح UptimeRobot
        </a>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────
export default function Connect() {
  const queryClient = useQueryClient();
  const [health, setHealth]   = useState<HealthData | null>(null);
  const [uptime, setUptime]   = useState<number | null>(null);
  const [resetting, setResetting] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Pairing code state
  const [pairingPhone,   setPairingPhone]   = useState("");
  const [pairingCode,    setPairingCode]    = useState<string | null>(null);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError,   setPairingError]   = useState<string | null>(null);
  const [codeCopied,     setCodeCopied]     = useState(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: status, isLoading: statusLoading } = useGetWhatsappStatus({
    query: {
      refetchInterval: 3_000,
      refetchIntervalInBackground: true,   // poll every 3 s even when tab is hidden
      staleTime: 0,                        // always refetch on window focus
    } as any,
  });

  const logoutMutation = useLogoutWhatsapp({
    mutation: {
      onSuccess: () => {
        toast.success("تم تسجيل الخروج بنجاح");
        queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
        setHealth(null);
        setUptime(null);
      },
      onError: () => toast.error("حدث خطأ أثناء تسجيل الخروج"),
    },
  });

  // ── Auto-connect when disconnected ───────────────────────────────
  // If WA is disconnected (not qr_ready, not connecting), trigger init
  // automatically so the user doesn't have to click anything.
  const autoConnectFired = useRef(false);
  useEffect(() => {
    if (!status) return;
    const s = status.status as string;
    const idle = !status.connected && s !== "qr_ready" && s !== "connecting" && s !== "reconnecting";
    if (idle && !autoConnectFired.current) {
      autoConnectFired.current = true;
      fetch("/api/whatsapp/connect", { method: "POST", credentials: "include" }).catch(() => {});
    }
    // Reset flag if WA connects so it can auto-connect again after future disconnect
    if (status.connected) autoConnectFired.current = false;
  }, [status?.status, status?.connected]);

  // Fetch health data every 5s
  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/whatsapp/health", { credentials: "include" });
        if (res.ok && !cancelled) setHealth(await res.json());
      } catch {}
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // Live uptime counter
  useEffect(() => {
    if (!health?.connectedAt) { setUptime(null); return; }
    const base = Math.floor((Date.now() - new Date(health.connectedAt).getTime()) / 1000);
    setUptime(base);
    const t = setInterval(() => setUptime((p) => (p !== null ? p + 1 : null)), 1000);
    return () => clearInterval(t);
  }, [health?.connectedAt]);

  const isConnected  = status?.connected;
  const statusStr = status?.status as string | undefined;
  const isConnecting = statusStr === "connecting" || statusStr === "reconnecting";
  const isQrReady    = status?.status === "qr_ready";

  // QR comes directly from the status response (no separate endpoint)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const currentQr = (status as any)?.qr as string | null | undefined;

  const refreshQr = () => {
    queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
    // Also re-trigger connect in case WA instance stalled
    fetch("/api/whatsapp/connect", { method: "POST", credentials: "include" }).catch(() => {});
    toast.info("جاري تحديث QR كود...");
  };

  // ── PAIRING CODE ─────────────────────────────────────────────────
  const handleRequestPairingCode = async () => {
    if (!pairingPhone.trim()) { setPairingError("أدخل رقم الهاتف"); return; }
    setPairingLoading(true);
    setPairingCode(null);
    setPairingError(null);
    try {
      const res = await fetch("/api/whatsapp/pairing-code", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: pairingPhone.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setPairingError(data.error ?? "حدث خطأ"); return; }
      setPairingCode(data.code);
      toast.success("تم توليد رمز الربط — أدخله في واتساب الآن");
    } catch {
      setPairingError("تعذّر الاتصال بالخادم");
    } finally {
      setPairingLoading(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairingCode) return;
    try {
      await navigator.clipboard.writeText(pairingCode.replace("-", ""));
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    } catch {}
  };

  // ── FULL SYNC RESET ──────────────────────────────────────────────
  const handleResetSession = async () => {
    setResetting(true);
    setShowResetConfirm(false);
    try {
      const res = await fetch("/api/whatsapp/reset-session", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "فشل إعادة الضبط"); return; }
      toast.success("تم مسح الجلسة — امسح QR الجديد لاستيراد كل المحادثات 📲");
      queryClient.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() });
      autoConnectFired.current = false; // let auto-connect fire again after reset
      setHealth(null);
      setUptime(null);
    } catch {
      toast.error("حدث خطأ أثناء إعادة الضبط");
    } finally {
      setResetting(false);
    }
  };

  // ── Status pill ──────────────────────────────────────────────────
  const StatusPill = () => {
    if (statusLoading) return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" /> جاري التحقق...</span>;
    if (isConnected)   return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-green-400"><span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />متصل</span>;
    if (isConnecting)  return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-yellow-400"><span className="w-2 h-2 rounded-full bg-yellow-400 animate-ping" />إعادة اتصال...</span>;
    if (isQrReady)     return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400"><Radio className="w-3 h-3" />في انتظار المسح</span>;
    return <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400"><span className="w-2 h-2 rounded-full bg-red-400" />غير متصل</span>;
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">ربط الواتساب</h1>
        <p className="text-muted-foreground text-sm mt-1">اربط حساب الواتساب وتابع صحة الجلسة</p>
      </div>

      {/* ── Main Status Card ─────────────────────────────────────── */}
      <div className={cn(
        "rounded-xl border p-5 transition-colors",
        isConnected  ? "bg-green-500/10 border-green-500/20" :
        isConnecting ? "bg-yellow-500/10 border-yellow-500/20" :
        "bg-card border-card-border"
      )}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {statusLoading ? <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /> :
             isConnected   ? <Wifi      className="w-6 h-6 text-green-400" /> :
             isConnecting  ? <Loader2   className="w-6 h-6 animate-spin text-yellow-400" /> :
                             <WifiOff   className="w-6 h-6 text-muted-foreground" />}
            <div>
              <p className="font-semibold text-foreground">
                {isConnected  ? `${status?.name ? status.name + " ← " : ""}${status?.phone ?? "متصل"}` :
                 isConnecting ? "جاري إعادة الاتصال..." :
                 isQrReady    ? "في انتظار مسح QR كود" :
                 "الواتساب غير متصل"}
              </p>
              <StatusPill />
            </div>
          </div>
          {isConnected && (
            <button
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 border border-red-500/20 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {logoutMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <LogOut className="w-3 h-3" />}
              قطع الاتصال
            </button>
          )}
        </div>
      </div>

      {/* ── FULL SYNC BANNER ─────────────────────────────────────── */}
      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-5">
        <div className="flex items-start gap-3">
          <DatabaseZap className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground mb-1">مزامنة كاملة — استيراد كل المحادثات</p>
            <p className="text-xs text-muted-foreground mb-3">
              إذا كانت تظهر لك محادثات قليلة فقط، اضغط الزر أدناه. سيتم مسح الجلسة الحالية وعرض QR جديد.
              عند مسح QR، سيقوم واتساب بإرسال <strong className="text-foreground">كامل سجل محادثاتك</strong> (آلاف الأرقام) مرة واحدة.
            </p>
            {!showResetConfirm ? (
              <button
                onClick={() => setShowResetConfirm(true)}
                disabled={resetting}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {resetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseZap className="w-4 h-4" />}
                {resetting ? "جاري إعادة الضبط..." : "مزامنة كاملة (QR جديد)"}
              </button>
            ) : (
              <div className="flex items-center gap-3 p-3 bg-orange-500/10 border border-orange-500/20 rounded-lg">
                <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-medium text-orange-300 mb-2">
                    سيتم مسح جلسة الواتساب وكل الأرقام المحفوظة. ستحتاج لمسح QR من جديد. هل أنت متأكد؟
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleResetSession}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded text-xs font-medium transition-colors"
                    >
                      <Trash2 className="w-3 h-3" />
                      نعم، امسح وأعد الضبط
                    </button>
                    <button
                      onClick={() => setShowResetConfirm(false)}
                      className="px-3 py-1.5 text-muted-foreground border border-border rounded text-xs hover:bg-muted transition-colors"
                    >
                      إلغاء
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Health Stats (when connected) ────────────────────────── */}
      {isConnected && health && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-card border border-card-border rounded-xl p-4 text-center">
              <Clock className="w-5 h-5 text-primary mx-auto mb-1.5" />
              <p className="text-lg font-bold text-foreground tabular-nums">
                {uptime !== null ? formatUptime(uptime) : "—"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">مدة التشغيل</p>
            </div>
            <div className="bg-card border border-card-border rounded-xl p-4 text-center">
              <RotateCcw className="w-5 h-5 text-yellow-400 mx-auto mb-1.5" />
              <p className="text-lg font-bold text-foreground tabular-nums">{health.reconnectCount}</p>
              <p className="text-xs text-muted-foreground mt-0.5">إعادات الاتصال</p>
            </div>
            <div className="bg-card border border-card-border rounded-xl p-4 text-center">
              <Zap className="w-5 h-5 text-blue-400 mx-auto mb-1.5" />
              <p className="text-lg font-bold text-foreground tabular-nums text-sm">
                {health.lastSuccessfulSendAt
                  ? formatRelative(health.lastSuccessfulSendAt)
                  : "لا يوجد"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">آخر إرسال ناجح</p>
            </div>
            <div className={cn("border rounded-xl p-4 text-center",
              EXTENDED_STATUS_META[health.extendedStatus ?? health.status]?.bg ?? "bg-card border-card-border"
            )}>
              <Activity className={cn("w-5 h-5 mx-auto mb-1.5",
                EXTENDED_STATUS_META[health.extendedStatus ?? health.status]?.color ?? "text-green-400"
              )} />
              <p className={cn("text-sm font-bold",
                EXTENDED_STATUS_META[health.extendedStatus ?? health.status]?.color ?? "text-green-400"
              )}>
                {EXTENDED_STATUS_META[health.extendedStatus ?? health.status]?.label ?? "متصل"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">حالة الجلسة</p>
            </div>
          </div>

          {/* Session Guardian warnings */}
          {(health.consecutiveSendFailures ?? 0) > 0 && (
            <div className={cn(
              "flex items-start gap-3 p-4 rounded-xl border text-sm",
              (health.consecutiveSendFailures ?? 0) >= 3
                ? "bg-red-500/10 border-red-500/20 text-red-300"
                : "bg-yellow-500/10 border-yellow-500/20 text-yellow-300"
            )}>
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">
                  {(health.consecutiveSendFailures ?? 0) >= 3
                    ? "⚠ جلسة راكدة — جاري إعادة بناء الاتصال تلقائياً"
                    : `تحذير: ${health.consecutiveSendFailures} فشل إرسال متتالي`}
                </p>
                <p className="text-xs opacity-75 mt-0.5">
                  {(health.consecutiveSendFailures ?? 0) >= 3
                    ? "الـ Session Guardian اكتشف الجلسة الراكدة وسيُعيد بناءها خلال ثوانٍ — لا تدخل مطلوب"
                    : "المراقب يتابع الوضع — إذا وصل الفشل لـ 3 سيُعيد بناء الاتصال تلقائياً"}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Anti-Ban Protection Card ─────────────────────────────── */}
      {health?.warmup && (
        <div className="bg-card border border-card-border rounded-xl p-5 space-y-4">
          <div className="flex items-center gap-2 mb-1">
            <Shield className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground text-sm">درع الحماية من الحظر</h3>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {/* Warm-up progress */}
            <div className="col-span-2 sm:col-span-1 bg-muted/30 rounded-lg p-3">
              <p className="text-xs text-muted-foreground mb-1">الحد اليومي (warm-up)</p>
              <div className="flex items-end gap-1.5">
                <span className="text-xl font-bold text-foreground tabular-nums">
                  {health.warmup.dailyLimit.toLocaleString("ar-SA")}
                </span>
                <span className="text-xs text-muted-foreground mb-0.5">
                  / {health.warmup.maxLimit.toLocaleString("ar-SA")}
                </span>
              </div>
              <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${Math.min(100, (health.warmup.dailyLimit / health.warmup.maxLimit) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1.5">
                يوم {health.warmup.daysConnected} — يزيد 30%/يوم تلقائياً
              </p>
            </div>

            {/* Sending window */}
            <div className={cn(
              "rounded-lg p-3 border",
              health.warmup.inSendingHours
                ? "bg-green-500/10 border-green-500/20"
                : "bg-orange-500/10 border-orange-500/20"
            )}>
              <p className="text-xs text-muted-foreground mb-1">نافذة الإرسال</p>
              <p className={cn("text-sm font-bold",
                health.warmup.inSendingHours ? "text-green-400" : "text-orange-400"
              )}>
                {health.warmup.inSendingHours ? "✅ مفتوحة" : "⏸ مغلقة"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {health.warmup.sendWindowStart}ص – {health.warmup.sendWindowEnd}م فقط
              </p>
              {!health.warmup.inSendingHours && (
                <p className="text-xs text-orange-300 mt-1">الحملات تنتظر تلقائياً حتى الصباح</p>
              )}
            </div>

            {/* Reconnect guard */}
            <div className={cn(
              "rounded-lg p-3 border",
              (health.reconnectCount ?? 0) > 5
                ? "bg-yellow-500/10 border-yellow-500/20"
                : "bg-green-500/10 border-green-500/20"
            )}>
              <p className="text-xs text-muted-foreground mb-1">إعادات الاتصال</p>
              <p className={cn("text-xl font-bold tabular-nums",
                (health.reconnectCount ?? 0) > 5 ? "text-yellow-400" : "text-green-400"
              )}>
                {health.reconnectCount ?? 0}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {(health.reconnectCount ?? 0) > 5
                  ? "⚠ كثيرة — قد تسبب حظراً"
                  : "✅ طبيعية"}
              </p>
            </div>
          </div>

          {/* Feature pills */}
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              "⏱ تأخير بشري (Gaussian)",
              "✍️ مؤشر الكتابة",
              "🔀 تنويع النصوص تلقائياً",
              "☕ استراحات كل 12 و40 رسالة",
              "🌙 لا إرسال ليلاً",
              "📈 Warm-up تدريجي",
            ].map((f) => (
              <span key={f} className="text-xs bg-primary/10 text-primary border border-primary/20 rounded-full px-2.5 py-0.5">
                {f}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* ── 24/7 Uptime Monitoring Card ──────────────────────────── */}
      <UptimeMonitorCard />

      {/* ── QR Section ───────────────────────────────────────────── */}
      {!isConnected && (
        <div className="bg-card border border-card-border rounded-xl p-6">
          <div className="text-center mb-4">
            <Smartphone className="w-8 h-8 text-primary mx-auto mb-2" />
            <h2 className="font-semibold text-foreground">امسح QR كود</h2>
            <p className="text-sm text-muted-foreground mt-1">
              افتح الواتساب على هاتفك ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز
            </p>
          </div>

          <div className="flex flex-col items-center gap-4">
            {currentQr ? (
              <div className="relative">
                <div className="p-3 bg-white rounded-xl shadow-lg">
                  <img src={currentQr} alt="QR Code" className="w-56 h-56" />
                </div>
                {/* Pulse dot to show QR is live */}
                <div className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-blue-400 animate-pulse" title="QR جاهز — يتجدد تلقائياً" />
              </div>
            ) : (
              <div className="w-56 h-56 bg-muted rounded-xl flex items-center justify-center flex-col gap-3">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
                <p className="text-xs text-muted-foreground text-center px-4">
                  {isConnecting ? "جاري إعادة الاتصال..." : "جاري تحضير QR كود..."}
                </p>
              </div>
            )}

            <button onClick={refreshQr} className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <RefreshCw className="w-4 h-4" />
              تحديث QR كود
            </button>
          </div>

          <div className="mt-5 p-4 bg-muted/50 rounded-lg">
            <p className="text-xs font-semibold text-foreground mb-2">خطوات الربط:</p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>افتح تطبيق الواتساب على هاتفك</li>
              <li>اضغط على النقاط الثلاث (القائمة)</li>
              <li>اختر "الأجهزة المرتبطة"</li>
              <li>اضغط "ربط جهاز"</li>
              <li>وجّه الكاميرا نحو QR كود أعلاه</li>
            </ol>
          </div>

          {/* ── Pairing Code Alternative ─────────────────────────── */}
          <div className="mt-5 border-t border-border/50 pt-5">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex-1 h-px bg-border/50" />
              <span className="text-xs text-muted-foreground px-2">أو ربط برمز الهاتف (أسهل)</span>
              <div className="flex-1 h-px bg-border/50" />
            </div>

            <div className="bg-primary/5 border border-primary/20 rounded-xl p-4">
              <div className="flex items-start gap-3 mb-4">
                <Phone className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-foreground">ربط برمز الهاتف</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    بديل QR — لا تحتاج كاميرا. أدخل رقمك، خذ الرمز، وأدخله في واتساب.
                  </p>
                </div>
              </div>

              <div className="flex gap-2 mb-3">
                <input
                  type="tel"
                  placeholder="971501234567"
                  value={pairingPhone}
                  onChange={(e) => { setPairingPhone(e.target.value); setPairingError(null); }}
                  onKeyDown={(e) => e.key === "Enter" && handleRequestPairingCode()}
                  dir="ltr"
                  className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <button
                  onClick={handleRequestPairingCode}
                  disabled={pairingLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  {pairingLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  {pairingLoading ? "جاري..." : "احصل على الرمز"}
                </button>
              </div>

              {pairingError && (
                <p className="text-xs text-red-400 mb-3 flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> {pairingError}
                </p>
              )}

              {pairingCode && (
                <div className="space-y-3">
                  <div
                    onClick={copyPairingCode}
                    className="flex items-center justify-center gap-3 p-4 bg-background border-2 border-primary/40 rounded-xl cursor-pointer hover:border-primary transition-colors group"
                    title="انقر للنسخ"
                  >
                    <span className="text-3xl font-mono font-black text-primary tracking-[0.3em] select-all">
                      {pairingCode}
                    </span>
                    {codeCopied
                      ? <CheckCircle2 className="w-5 h-5 text-green-400" />
                      : <Copy className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />}
                  </div>

                  <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg text-xs text-green-300 space-y-1">
                    <p className="font-semibold">أدخل هذا الرمز في واتساب الآن:</p>
                    <ol className="space-y-0.5 text-green-400/80 list-decimal list-inside">
                      <li>واتساب → القائمة ← الأجهزة المرتبطة</li>
                      <li>اضغط "ربط جهاز"</li>
                      <li>اضغط <strong className="text-green-300">"ربط برمز الهاتف"</strong></li>
                      <li>أدخل الرمز: <span className="font-mono font-bold">{pairingCode}</span></li>
                    </ol>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Connected success + tips ──────────────────────────────── */}
      {isConnected && (
        <div className="bg-green-500/5 border border-green-500/20 rounded-xl p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground mb-1">الجلسة نشطة وتعمل في الخلفية</p>
              <p className="text-xs text-muted-foreground">
                لا تحتاج لإبقاء المتصفح مفتوحاً — الاتصال يستمر ويُعيد الاتصال تلقائياً عند الانقطاع. 
                يُنصح بعدم تسجيل الخروج من واتساب على هاتفك.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Event Log ────────────────────────────────────────────── */}
      {health && health.recentEvents.length > 0 && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-card-border">
            <Activity className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">سجل الأحداث</h3>
          </div>
          <div className="divide-y divide-border/40">
            {health.recentEvents.map((ev) => {
              const meta = EVENT_META[ev.event] ?? { label: ev.event, color: "text-muted-foreground", icon: "⬜" };
              return (
                <div key={ev.id} className="flex items-start gap-3 px-5 py-3 hover:bg-muted/30 transition-colors">
                  <span className="text-base leading-none mt-0.5">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("text-xs font-medium", meta.color)}>{meta.label}</span>
                      {ev.detail && (
                        <span className="text-[11px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[180px]">
                          {ev.detail}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5" dir="ltr">
                      {formatTime(ev.createdAt)} — {formatRelative(ev.createdAt)}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Warning if reconnecting ───────────────────────────────── */}
      {isConnecting && health && health.reconnectCount > 2 && (
        <div className="flex items-start gap-3 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
          <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-medium text-yellow-300">تحذير — انقطاع متكرر</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              تم إعادة الاتصال {health.reconnectCount} مرة. تأكد من أن واتساب على هاتفك يعمل وأنك لم تقم بتسجيل الخروج.
            </p>
          </div>
        </div>
      )}

      {/* ── Extract Contacts ─────────────────────────────────────── */}
      {isConnected && <ExtractContactsPanel />}
    </div>
  );
}

// ── Extract contacts panel (shown when WhatsApp is connected) ──────
function ExtractContactsPanel() {
  const [count,      setCount]      = useState<number | null>(null);
  const [phones,     setPhones]     = useState<string[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [listName,   setListName]   = useState("جهات واتساب");
  const [importing,  setImporting]  = useState(false);
  const [showImport, setShowImport] = useState(false);

  const extract = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/extract-contacts", { credentials: "include" });
      const data = await res.json();
      setPhones(data.phones ?? []);
      setCount(data.count ?? 0);
      setShowImport(true);
    } catch {
      toast.error("تعذّر الاستخراج");
    } finally {
      setLoading(false);
    }
  };

  const importList = async () => {
    if (!listName.trim()) { toast.error("ادخل اسم القائمة"); return; }
    setImporting(true);
    try {
      const res = await fetch("/api/whatsapp/import-contacts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listName }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error); return; }
      toast.success(`تم استيراد ${data.count} رقم إلى قائمة "${data.listName}" ✅`);
      setShowImport(false);
      setCount(null);
    } catch {
      toast.error("حدث خطأ أثناء الاستيراد");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="bg-card border border-card-border rounded-xl p-5">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Phone className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">استخراج جهات الاتصال</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            استخرج كل الأرقام من محادثاتك وجهات اتصالك في واتساب
          </p>
        </div>
      </div>

      {!showImport ? (
        <button
          onClick={extract}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {loading ? "جاري الاستخراج..." : "استخراج الأرقام الآن"}
        </button>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
            <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-foreground">
                تم اكتشاف <span className="text-primary font-bold">{count}</span> رقم
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                من المحادثات وجهات الاتصال المزامَنة
              </p>
            </div>
          </div>

          {count === 0 ? (
            <div className="text-xs text-muted-foreground p-3 bg-muted/30 rounded-lg">
              لم يُكتشف أي رقم بعد. استخدم زر "مزامنة كاملة" أعلاه لمسح QR جديد وتحميل كل المحادثات.
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">اسم قائمة الأرقام</label>
                <input
                  type="text"
                  value={listName}
                  onChange={(e) => setListName(e.target.value)}
                  placeholder="مثال: جهات واتساب مايو 2026"
                  className="w-full px-3 py-2 bg-input border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>

              {phones.length > 0 && (
                <div className="text-xs text-muted-foreground font-mono bg-muted/30 rounded-lg p-2 max-h-20 overflow-y-auto" dir="ltr">
                  {phones.slice(0, 8).join(" · ")}{phones.length > 8 ? ` · ... و${phones.length - 8} أخرى` : ""}
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={importList}
                  disabled={importing || count === 0}
                  className="flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors flex-1 justify-center"
                >
                  {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {importing ? "جاري الاستيراد..." : `إنشاء القائمة (${count} رقم)`}
                </button>
                <button
                  onClick={() => setShowImport(false)}
                  className="px-3 py-2.5 text-muted-foreground border border-border rounded-lg text-sm hover:bg-muted transition-colors"
                >
                  إلغاء
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
