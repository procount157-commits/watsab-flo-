import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2, CheckCircle2, AlertTriangle, XCircle, RefreshCw, Stethoscope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";

const STATE = {
  ok:   { icon: CheckCircle2,  cls: "text-primary",     ring: "border-card-border" },
  warn: { icon: AlertTriangle, cls: "text-yellow-400",  ring: "border-yellow-500/30 bg-yellow-500/5" },
  fail: { icon: XCircle,       cls: "text-red-400",     ring: "border-red-500/30 bg-red-500/5" },
} as const;

/**
 * One answer to "why is nothing sending".
 *
 * Every line says what was found rather than what is configured — the SMTP
 * check opens a connection when this renders, because a wrong password and a
 * sleeping laptop look identical from the settings page.
 */
export function EmailDiagnose() {
  const qc = useQueryClient();
  const { data, isLoading, isFetching } = useQuery<any>({
    queryKey: ["email-diagnose"],
    queryFn: () => api("/api/email/diagnose"),
    refetchInterval: 120_000,
  });

  if (isLoading) {
    return <div className={cn(card, "p-8 flex justify-center")}><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const checks: any[] = data?.checks ?? [];
  const bad = checks.filter((c) => c.state === "fail").length;

  return (
    <div className={cn(card, bad > 0 && "border-red-500/30")}>
      <div className="p-4 border-b border-card-border flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-sm flex items-center gap-1.5">
            <Stethoscope className="w-4 h-4 text-primary" /> لماذا لا يُرسل البريد
          </p>
          <p className={cn("text-xs mt-1.5 leading-relaxed", bad > 0 ? "text-red-300" : "text-muted-foreground")}>
            {data?.verdict}
          </p>
        </div>
        <button onClick={() => qc.invalidateQueries({ queryKey: ["email-diagnose"] })}
                disabled={isFetching} className={cn(ghost, "shrink-0")}>
          {isFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          افحص الآن
        </button>
      </div>

      <div className="p-4 space-y-2">
        {checks.map((c) => {
          const m = STATE[c.state as keyof typeof STATE] ?? STATE.warn;
          return (
            <div key={c.id} className={cn("rounded-lg border p-3 flex items-start gap-2.5", m.ring)}>
              <m.icon className={cn("w-4 h-4 shrink-0 mt-0.5", m.cls)} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium">{c.title}</p>
                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">{c.detail}</p>
                {c.fix && (
                  <p className="text-[11px] text-primary mt-1.5 leading-relaxed">← {c.fix}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="px-4 pb-4 text-[10px] text-muted-foreground/70 leading-relaxed">
        يُفتح اتصال حقيقي بخادم البريد عند كل فحص — لأن كلمة مرور خاطئة وجهازاً نائماً يبدوان متطابقين من صفحة الإعدادات.
      </p>
    </div>
  );
}
