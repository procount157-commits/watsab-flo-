import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import Layout from "@/components/Layout";
import LoginPage from "@/pages/LoginPage";
import Dashboard from "@/pages/Dashboard";
import Connect from "@/pages/Connect";
import ContactsList from "@/pages/ContactsList";
import ContactDetail from "@/pages/ContactDetail";
import CampaignsList from "@/pages/CampaignsList";
import CampaignNew from "@/pages/CampaignNew";
import CampaignDetail from "@/pages/CampaignDetail";
import FollowUps from "@/pages/FollowUps";
import Knowledge from "@/pages/Knowledge";
import Assistant from "@/pages/Assistant";
import Employees from "@/pages/Employees";
import AgentOps from "@/pages/AgentOps";
import Board from "@/pages/Board";
import BrowserDesk from "@/pages/BrowserDesk";
import Meetings from "@/pages/Meetings";
import Instagram from "@/pages/Instagram";
import AdminPage from "@/pages/AdminPage";
import WaExtractor from "@/pages/WaExtractor";
import WaInbox from "@/pages/WaInbox";
import Conversations from "@/pages/Conversations";
import Groups from "@/pages/Groups";
import WaLinkGenerator from "@/pages/WaLinkGenerator";
import DirectLoginPage from "@/pages/DirectLoginPage";
import WaPublicSetup from "@/pages/WaPublicSetup";
import LandingPage from "@/pages/LandingPage";
import Settings from "@/pages/Settings";
import EmailMarketing from "./pages/EmailMarketing";
import SalesArena from "./pages/SalesArena";
import Diagnostics from "@/pages/Diagnostics";
import NotFound from "@/pages/not-found";

// Helper: is this error a genuine "not authenticated" response?
function isAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; statusCode?: number };
  return e.status === 401 || e.statusCode === 401;
}

// ── QueryClient ────────────────────────────────────────────────────
// staleTime: 0 → all data is immediately stale after fetch.
// Combined with refetchOnWindowFocus: true (default), every time the
// user switches back to the tab all active queries refetch instantly.
// This eliminates the "stale disconnected" flash after tab sleep.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        if (isAuthError(error)) return false;
        return count < 1;
      },
      retryDelay: 2_000,
      staleTime: 0,                    // immediately stale → always refetch on focus
      refetchOnWindowFocus: true,      // refetch all active queries when tab regains focus
      refetchOnReconnect: true,        // refetch when browser goes back online
      throwOnError: false,
    },
    mutations: {
      throwOnError: false,
    },
  },
});

// ── Background Keep-Alive Worker ───────────────────────────────────
// Singleton Web Worker — persists for the entire browser session.
// Runs on a separate thread → NOT throttled by browser when tab is
// hidden, minimized, or the screen is locked.
// It keeps the server alive AND streams WA status to the main thread.
let _worker: Worker | null = null;

function getOrCreateWorker(): Worker | null {
  if (_worker) return _worker;
  if (typeof Worker === "undefined") return null;
  try {
    _worker = new Worker(
      new URL("./workers/keepalive.worker.ts", import.meta.url),
      { type: "module" }
    );
    return _worker;
  } catch {
    return null;
  }
}

// ── WorkerBridge — mounts once at App root ─────────────────────────
// Bridges Worker messages into React Query cache updates.
function WorkerBridge() {
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    const worker = getOrCreateWorker();
    if (!worker) return;
    workerRef.current = worker;

    const onMessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; data: unknown };

      if (msg.type === "WA_STATUS" && msg.data) {
        // Update WA status cache directly — avoids a redundant fetch from main thread
        queryClient.setQueryData(["/api/whatsapp/status"], msg.data);
      }
      // AUTH_RENEWED is handled by AuthContext's own worker; ignore here
    };

    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, []);

  // ── Visibility recovery ────────────────────────────────────────
  // When user switches back to the tab after any amount of time,
  // immediately force-refetch ALL currently-rendered (active) queries.
  // With staleTime: 0, every query is considered stale so they all refetch.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // Refetch all active (currently subscribed) queries immediately
        void queryClient.refetchQueries({ type: "active" });
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    // Also recover when browser regains network connectivity
    const onOnline = () => {
      void queryClient.refetchQueries({ type: "active" });
    };
    window.addEventListener("online", onOnline);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  return null;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center" dir="rtl">
        <div className="flex items-center gap-3 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">جاري التحقق من الجلسة...</span>
        </div>
      </div>
    );
  }

  if (!user) return <LoginPage />;

  return <>{children}</>;
}

function AuthenticatedRoutes() {
  return (
    <AuthGate>
      <Layout>
        <Switch>
          <Route path="/dashboard"      component={Dashboard} />
          <Route path="/connect"        component={Connect} />
          <Route path="/contacts"       component={ContactsList} />
          <Route path="/contacts/:id"   component={ContactDetail} />
          <Route path="/campaigns"      component={CampaignsList} />
          <Route path="/campaigns/new"  component={CampaignNew} />
          <Route path="/campaigns/:id/edit" component={CampaignNew} />
          <Route path="/campaigns/:id"  component={CampaignDetail} />
          <Route path="/follow-ups"     component={FollowUps} />
          <Route path="/knowledge"      component={Knowledge} />
          <Route path="/assistant"      component={Assistant} />
          <Route path="/board"          component={Board} />
          <Route path="/browser"        component={BrowserDesk} />
          <Route path="/meetings"       component={Meetings} />
          <Route path="/instagram"      component={Instagram} />
          <Route path="/ops"            component={AgentOps} />
          <Route path="/employees"      component={Employees} />
          <Route path="/conversations"  component={Conversations} />
          <Route path="/groups"         component={Groups} />
          <Route path="/inbox"          component={WaInbox} />
          <Route path="/extractor"      component={WaExtractor} />
          <Route path="/wa-link"        component={WaLinkGenerator} />
          <Route path="/email/:tab/:id" component={EmailMarketing} />
          <Route path="/email/:tab?"    component={EmailMarketing} />
          <Route path="/arena"          component={SalesArena} />
          <Route path="/settings"       component={Settings} />
          <Route path="/diagnostics"    component={Diagnostics} />
          <Route path="/admin"          component={AdminPage} />
          <Route                        component={NotFound} />
        </Switch>
      </Layout>
    </AuthGate>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/"             component={LandingPage} />
      <Route path="/login"        component={LoginPage} />
      <Route path="/wa/:token"    component={WaPublicSetup} />
      <Route path="/login/:token" component={DirectLoginPage} />
      <Route component={AuthenticatedRoutes} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          {/* WorkerBridge mounts once and lives for the entire session */}
          <WorkerBridge />
          <Router />
          <Toaster position="top-center" richColors />
        </WouterRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
