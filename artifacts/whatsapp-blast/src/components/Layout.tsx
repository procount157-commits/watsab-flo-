import { ReactNode, useState } from "react";
import { Link, useLocation } from "wouter";
import { useGetWhatsappStatus } from "@workspace/api-client-react";
import { useAuth } from "@/context/AuthContext";
import { useKeepAlive } from "@/hooks/use-keep-alive";
import QrModal from "./QrModal";
import {
  LayoutDashboard, QrCode, Users, Megaphone, Bot,
  Wifi, WifiOff, Loader2, LogOut, Shield, User, TrendingUp, Download, BarChart3,
  MessageCircle, MessagesSquare, MessageSquare, BookOpen, RefreshCw, Sparkles, Settings2, Activity, Clock, Brain, Users2, Radar, LayoutGrid, Globe, Mail, Target, Instagram, Music2, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const NAV = [
  { href: "/dashboard",     label: "لوحة التحكم",       icon: LayoutDashboard },
  { href: "/connect",       label: "ربط الواتساب",      icon: QrCode },
  { href: "/conversations", label: "المحادثات",          icon: MessageSquare },
  { href: "/groups",        label: "قروبات العملاء",     icon: Users2, badge: "جديد" },
  { href: "/contacts",      label: "قوائم الأرقام",     icon: Users },
  { href: "/inbox",         label: "صندوق الوارد",       icon: MessagesSquare },
  { href: "/extractor",     label: "مستخرج الأرقام",    icon: Download },
  { href: "/campaigns",     label: "الحملات",            icon: Megaphone },
  { href: "/team",          label: "الهيكل والأداء",     icon: Building2, badge: "جديد" },
  { href: "/board",         label: "لوحة الفريق",        icon: LayoutGrid, badge: "جديد" },
  { href: "/arena",         label: "ميدان التدريب",      icon: Target, badge: "جديد" },
  { href: "/ops",           label: "غرفة العمليات",      icon: Radar },
  { href: "/meetings",      label: "اجتماعات الفريق",    icon: Users2, badge: "جديد" },
  { href: "/browser",       label: "مكتب التصفّح",       icon: Globe },
  { href: "/employees",     label: "فريق البوتات",       icon: Users2 },
  { href: "/follow-ups",    label: "بوت المتابعة",       icon: Clock },
  { href: "/email",         label: "التسويق بالبريد",    icon: Mail },
  { href: "/instagram",     label: "إنستجرام",           icon: Instagram },
  { href: "/tiktok",        label: "تيك توك",            icon: Music2, badge: "جديد" },
  { href: "/knowledge",     label: "معرفة البوت",        icon: Brain },
  { href: "/wa-link",       label: "رابط واتساب",        icon: MessageCircle },
  { href: "/assistant",     label: "المساعد الداخلي",    icon: Bot, badge: "جديد" },
  { href: "/settings",     label: "الإعدادات",           icon: Settings2 },
  { href: "/diagnostics",  label: "System Diagnostics",  icon: Activity, badge: "DEV" },
];

export default function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user, logout } = useAuth();
  const [fixing, setFixing] = useState(false);

  // Keep the browser tab alive: Wake Lock + session ping + 20-min reload
  useKeepAlive(true);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: status, refetch: refetchStatus } = useGetWhatsappStatus({ query: { refetchInterval: 5000 } as any });

  const connected   = status?.connected;
  const waStatus    = status?.status as string | undefined;
  const isActive    = connected || waStatus === "connecting" || waStatus === "reconnecting" || waStatus === "qr_ready";
  const disconnected = !isActive;

  const handleLogout = async () => {
    try { await logout(); } catch { toast.error("فشل تسجيل الخروج"); }
  };

  const handleFix = async () => {
    setFixing(true);
    try {
      const res = await fetch("/api/whatsapp/connect", { method: "POST", credentials: "include" });
      if (res.ok) {
        toast.success("جاري إعادة الاتصال بواتساب...");
        setTimeout(() => refetchStatus(), 2000);
      } else {
        toast.error("فشل إعادة الاتصال، حاول مجدداً");
      }
    } catch {
      toast.error("تعذّر الوصول للخادم");
    } finally {
      setTimeout(() => setFixing(false), 4000);
    }
  };

  return (
    <div className="flex h-screen bg-background overflow-hidden" dir="rtl">
      {/* Global QR / reconnect modal — appears on any page when WA needs attention */}
      <QrModal />

      <aside className="w-64 flex-shrink-0 bg-sidebar border-l border-sidebar-border flex flex-col">
        {/* Logo */}
        <div className="p-5 border-b border-sidebar-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white">
                <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
              </svg>
            </div>
            <div>
              <p className="font-bold text-sm text-sidebar-foreground leading-none">واتساب ماركتر</p>
              <p className="text-xs text-muted-foreground mt-0.5">أداة الحملات الاحترافية</p>
            </div>
          </div>
        </div>

        {/* WhatsApp Status */}
        <div className="px-4 py-3 border-b border-sidebar-border space-y-2">
          {/* Status pill */}
          <div className={cn(
            "flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium",
            connected                              ? "bg-green-500/10 text-green-400" :
            waStatus === "reconnecting"            ? "bg-orange-500/10 text-orange-400" :
            waStatus === "connecting" || waStatus === "qr_ready" ? "bg-yellow-500/10 text-yellow-400" :
            "bg-red-500/10 text-red-400"
          )}>
            {waStatus === "connecting" || waStatus === "reconnecting"
              ? <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
              : connected
                ? <Wifi className="w-3 h-3 flex-shrink-0" />
                : <WifiOff className="w-3 h-3 flex-shrink-0" />}
            <span className="truncate">
              {connected
                ? `متصل ${status?.phone ? `(${status.phone})` : ""}`
                : waStatus === "reconnecting"
                  ? "يُعيد الاتصال..."
                  : waStatus === "qr_ready"
                    ? "في انتظار QR"
                    : waStatus === "connecting"
                      ? "جاري الاتصال..."
                      : "غير متصل"}
            </span>
          </div>

          {/* One-click fix button — shown only when fully disconnected */}
          {disconnected && (
            <button
              onClick={handleFix}
              disabled={fixing}
              className={cn(
                "w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold transition-all",
                fixing
                  ? "bg-primary/20 text-primary cursor-not-allowed"
                  : "bg-primary text-white hover:bg-primary/90 active:scale-95 shadow-sm"
              )}
            >
              {fixing
                ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />جاري الإصلاح...</>
                : <><RefreshCw className="w-3.5 h-3.5" />إصلاح الاتصال</>}
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV.map(({ href, label, icon: Icon, badge }) => {
            const active = href === "/" ? location === "/" : location.startsWith(href);
            return (
              <Link key={href} href={href} className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                active
                  ? "bg-primary/15 text-primary border border-primary/20"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              )}>
                <Icon className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                {badge && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-primary/20 text-primary leading-none">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
          {user?.isAdmin && (
            <Link href="/admin" className={cn(
              "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer",
              location.startsWith("/admin")
                ? "bg-primary/15 text-primary border border-primary/20"
                : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            )}>
              <Shield className="w-4 h-4 flex-shrink-0" />
              إدارة المشتركين
            </Link>
          )}
        </nav>

        {/* User + Logout */}
        <div className="p-3 border-t border-sidebar-border space-y-2">
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-muted/50">
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
              <User className="w-3.5 h-3.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{user?.displayName || "مشترك"}</p>
              <p className="text-[10px] text-muted-foreground truncate" dir="ltr">{user?.phone}</p>
            </div>
            {user?.isAdmin && (
              <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded flex-shrink-0">مدير</span>
            )}
          </div>
          <button onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
            <LogOut className="w-3.5 h-3.5" />
            تسجيل الخروج
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto bg-background">
        {children}
      </main>
    </div>
  );
}
