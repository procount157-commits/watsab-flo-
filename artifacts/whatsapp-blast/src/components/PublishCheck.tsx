import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Loader2, CheckCircle2, AlertTriangle, Ban, Send, Users, CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";

const STATE = {
  ok:      { icon: CheckCircle2,  cls: "text-primary",    ring: "border-card-border" },
  warn:    { icon: AlertTriangle, cls: "text-yellow-400", ring: "border-yellow-500/30 bg-yellow-500/5" },
  blocked: { icon: Ban,           cls: "text-red-400",    ring: "border-red-500/30 bg-red-500/5" },
} as const;

/**
 * What happens if this is published — or what stops it.
 *
 * Shown before the button rather than thrown after it. Publishing used to
 * refuse with one sentence and never mentioned the commonest cause: a list
 * that exists and holds nobody who can be written to.
 */
export function PublishCheck({ campaignId, onReady }: { campaignId: number; onReady?: (ok: boolean) => void }) {
  const { data, isLoading } = useQuery<any>({
    queryKey: ["readiness", campaignId],
    queryFn: async () => {
      const r = await api(`/api/email/campaigns/${campaignId}/readiness`);
      onReady?.(!!r.canPublish);
      return r;
    },
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <div className="rounded-xl border border-card-border p-5 flex justify-center">
      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
    </div>;
  }

  const blocked = !data?.canPublish;

  return (
    <div className={cn("rounded-xl border", blocked ? "border-red-500/40" : "border-primary/30")}>
      <div className={cn("p-4 border-b", blocked ? "border-red-500/20 bg-red-500/5" : "border-card-border bg-primary/5")}>
        <p className={cn("text-sm font-semibold", blocked ? "text-red-300" : "text-primary")}>
          {data?.verdict}
        </p>
        {!blocked && (
          <div className="flex flex-wrap gap-4 mt-2.5">
            <span className="flex items-center gap-1.5 text-xs">
              <Send className="w-3.5 h-3.5 text-primary" />
              <b>{data.willSend}</b> ستصلهم
            </span>
            {data.willSkip > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users className="w-3.5 h-3.5" />
                <b>{data.willSkip}</b> يُتخطّون
              </span>
            )}
          </div>
        )}
        {data?.skipReasons?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {data.skipReasons.map((r: any, i: number) => (
              <span key={i} className="text-[10px] px-2 py-0.5 rounded bg-muted text-muted-foreground">
                {r.n} {r.reason}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="p-3 space-y-1.5">
        {(data?.checks ?? []).map((c: any) => {
          const m = STATE[c.state as keyof typeof STATE] ?? STATE.warn;
          return (
            <div key={c.id} className={cn("rounded-lg border p-2.5 flex items-start gap-2", m.ring)}>
              <m.icon className={cn("w-3.5 h-3.5 shrink-0 mt-0.5", m.cls)} />
              <div className="min-w-0 flex-1">
                <p className="text-[11px]">
                  <span className="font-medium">{c.title}:</span>{" "}
                  <span className="text-muted-foreground">{c.detail}</span>
                </p>
                {c.fix && (
                  c.goto
                    ? <Link href={c.goto} className="text-[11px] text-primary hover:underline mt-1 inline-block">← {c.fix}</Link>
                    : <p className="text-[11px] text-primary mt-1">← {c.fix}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {data?.checks?.some((c: any) => c.id === "cap") && (
        <p className="px-4 pb-3 text-[10px] text-muted-foreground flex items-center gap-1.5">
          <CalendarClock className="w-3 h-3" />
          التقسيم على أيام مقصود — الإرسال الدفعي يحرق سمعة النطاق.
        </p>
      )}
    </div>
  );
}
