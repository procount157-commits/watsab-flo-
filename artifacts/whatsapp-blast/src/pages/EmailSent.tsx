// ── المُرسَل: ماذا خرج من هنا، ومتى، وكيف كان شكله ────────────────
// «سجل الإرسال» المجاور صفٌّ لكل شركة — كم رسالة تلقّت وأين وصلت في
// سلّم المتابعة. وهذا صفٌّ لكل رسالة: من استلمها، ومن أي حملة، وما حدث
// لها بعد الخروج، والأهم — معاينتها كما وصلت بريده، لا كما تبدو في
// المحرّر.
//
// والمعاينة تقول ما لا يُقال عادة: إن خرجت الرسالة بلا بكسل فتحٍ فذلك
// مكتوبٌ فوقها، فلا يُقرأ «٠ فتحات» نتيجةً وهو غياب قياس.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Loader2, Eye, MousePointerClick, Reply, AlertTriangle, Search, X,
  Mail, CheckCircle2, EyeOff, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");
const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";

const FILTERS = [
  { key: "all",      label: "الكل" },
  { key: "opened",   label: "فُتحت" },
  { key: "clicked",  label: "نُقر فيها" },
  { key: "replied",  label: "رُدّ عليها" },
  { key: "unopened", label: "لم تُفتح" },
  { key: "bounced",  label: "ارتدّت" },
  { key: "failed",   label: "فشلت" },
] as const;

const when = (d?: string | null) => d
  ? new Date(d).toLocaleString("ar-AE", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
  : "—";

const EVENT_AR: Record<string, string> = {
  sent: "خرجت", open: "فُتحت", click: "نقر رابطاً", reply: "ردّ",
  bounce: "ارتدّت", unsubscribe: "ألغى الاشتراك", failed: "فشلت", complaint: "بلاغ إزعاج",
};

export function SentTab() {
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const { data, isLoading } = useQuery<any>({
    queryKey: ["email-sent", filter, q],
    queryFn: () => api(`/api/email/sent?filter=${filter}&q=${encodeURIComponent(q)}&limit=100`),
    refetchInterval: 30_000,
  });
  const rows = data?.rows ?? [];
  const sum = data?.summary ?? {};
  const tracking = data?.tracking;

  return (
    <div className="space-y-4">
      {/* العائق الذي صمت عنه النظام ٥٦٠ مرة */}
      {tracking && !tracking.can && sum.sent > 0 && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-2">
          <p className="text-sm font-semibold text-yellow-400 flex items-center gap-2">
            <EyeOff className="w-4 h-4" /> {sum.sent} رسالة خرجت بلا قياس فتح
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">{tracking.why}</p>
          <ul className="text-xs text-muted-foreground space-y-1 pr-4">
            {(tracking.howTo ?? []).map((h: string, i: number) => <li key={i} className="list-disc">{h}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="خرجت" value={sum.sent ?? 0} sub={`${sum.last24 ?? 0} في ٢٤ ساعة`} icon={Mail} />
        <Stat label="فُتحت" value={sum.opened ?? 0} sub={tracking?.can ? `${sum.openRate ?? 0}%` : "لا قياس"} icon={Eye} tone={tracking?.can ? undefined : "text-muted-foreground"} />
        <Stat label="نُقر فيها" value={sum.clicked ?? 0} sub={tracking?.can ? `${sum.clickRate ?? 0}%` : "لا قياس"} icon={MousePointerClick} tone={tracking?.can ? undefined : "text-muted-foreground"} />
        <Stat label="رُدّ عليها" value={sum.replied ?? 0} sub={`${sum.replyRate ?? 0}%`} icon={Reply} tone="text-green-400" />
        <Stat label="ارتدّت" value={sum.bounced ?? 0} icon={AlertTriangle} tone={(sum.bounced ?? 0) > 0 ? "text-red-400" : undefined} />
        <Stat label="فشلت" value={sum.failed ?? 0} icon={X} tone={(sum.failed ?? 0) > 0 ? "text-red-400" : undefined} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)}
            className={cn("px-3 py-1.5 rounded-lg text-xs border transition-colors",
              filter === f.key ? "bg-primary/15 text-primary border-primary/30" : "border-card-border hover:border-primary/40")}>
            {f.label}
          </button>
        ))}
        <div className="relative mr-auto">
          <Search className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input className={cn(input, "pr-8 w-56 text-xs")} placeholder="بحث بالعنوان أو الشركة…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className={cn(card, "overflow-hidden")}>
        {isLoading ? <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>
        : rows.length === 0 ? <p className="p-10 text-xs text-muted-foreground text-center">لا رسائل تطابق هذا الاختيار.</p>
        : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-right p-2.5 font-semibold">المستلم</th>
                  <th className="text-right p-2.5 font-semibold">العنوان</th>
                  <th className="text-right p-2.5 font-semibold">من</th>
                  <th className="text-right p-2.5 font-semibold">خرجت</th>
                  <th className="text-right p-2.5 font-semibold">ما حدث بعدها</th>
                  <th className="p-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => (
                  <tr key={r.id} className="border-t border-card-border hover:bg-muted/30">
                    <td className="p-2.5 max-w-[14rem]">
                      <p className="font-semibold truncate">{r.company ?? r.contactName ?? "—"}</p>
                      <p className="text-[10px] text-muted-foreground truncate font-mono" dir="ltr">{r.toEmail}</p>
                    </td>
                    <td className="p-2.5 max-w-[18rem]"><p className="truncate" dir="auto">{r.subject}</p></td>
                    <td className="p-2.5 max-w-[11rem]">
                      <p className="truncate text-muted-foreground">{r.campaignName ?? (r.sequenceName ? `${r.sequenceName} · خطوة ${(r.stepIndex ?? 0) + 1}` : "رد مباشر")}</p>
                      {r.variant && <span className="text-[10px] text-muted-foreground">نسخة {r.variant}</span>}
                    </td>
                    <td className="p-2.5 whitespace-nowrap text-muted-foreground">{when(r.sentAt)}</td>
                    <td className="p-2.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {r.status === "failed" && <Tag tone="red">فشلت{r.error ? `: ${String(r.error).slice(0, 40)}` : ""}</Tag>}
                        {r.bouncedAt && <Tag tone="red">ارتدّت</Tag>}
                        {r.repliedAt && <Tag tone="green">ردّ</Tag>}
                        {r.openedAt && <Tag tone="blue">فُتحت{r.opens > 1 ? ` ${r.opens}×` : ""}</Tag>}
                        {r.clickedAt && <Tag tone="primary">نقر{r.clicks > 1 ? ` ${r.clicks}×` : ""}</Tag>}
                        {r.status === "sent" && !r.openedAt && !r.repliedAt && !r.bouncedAt && (
                          <span className="text-[10px] text-muted-foreground">{tracking?.can ? "صامتة" : "لا قياس"}</span>
                        )}
                      </div>
                    </td>
                    <td className="p-2.5">
                      <button onClick={() => setOpen(r.id)} className={cn(ghost, "py-1 px-2")}>
                        <Eye className="w-3 h-3" /> شكلها
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data?.total > rows.length && (
          <p className="p-2.5 text-[11px] text-muted-foreground text-center border-t border-card-border">
            تُعرض {rows.length} من {data.total}
          </p>
        )}
      </div>

      {open != null && <SentPreview id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Stat({ label, value, sub, icon: Icon, tone }: { label: string; value: number | string; sub?: string; icon: any; tone?: string }) {
  return (
    <div className={cn(card, "p-3")}>
      <div className="flex items-center gap-1.5 text-muted-foreground mb-1"><Icon className="w-3.5 h-3.5" /><span className="text-[11px]">{label}</span></div>
      <p className={cn("text-xl font-bold", tone)}>{typeof value === "number" ? value.toLocaleString("ar-AE") : value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone: "red" | "green" | "blue" | "primary" }) {
  const cls = { red: "bg-red-500/15 text-red-400", green: "bg-green-500/15 text-green-400", blue: "bg-blue-500/15 text-blue-400", primary: "bg-primary/15 text-primary" }[tone];
  return <span className={cn("text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap", cls)}>{children}</span>;
}

/**
 * المعاينة. الجسم يُحمَّل في إطارٍ معزول من الخادم — لا يُحقن في الصفحة:
 * هذا نصُّ رسالةٍ كتبها نموذج أو مستخدم، وعرضه داخل DOM الصفحة يُشغّل
 * ما فيه. فيُعرض في iframe له sandbox ورأس CSP من الخادم.
 */
function SentPreview({ id, onClose }: { id: number; onClose: () => void }) {
  const { data } = useQuery<any>({ queryKey: ["email-sent-one", id], queryFn: () => api(`/api/email/sent/${id}`) });
  const [tab, setTab] = useState<"html" | "text">("html");
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className={cn(card, "w-full max-w-3xl max-h-[90vh] flex flex-col")} onClick={(e) => e.stopPropagation()}>
        <div className="p-3 border-b border-card-border flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate" dir="auto">{data?.subject ?? "…"}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              إلى <span className="font-mono" dir="ltr">{data?.toEmail ?? ""}</span>
              {data?.source ? ` · ${data.source}` : ""}{data?.sentAt ? ` · ${when(data.sentAt)}` : ""}
            </p>
          </div>
          <button onClick={() => setTab(tab === "html" ? "text" : "html")} className={ghost}>
            {tab === "html" ? "النص المجرّد" : "الشكل الكامل"}
          </button>
          <button onClick={onClose} className={ghost}><X className="w-3.5 h-3.5" /></button>
        </div>

        {data?.trackingNote && (
          <p className="px-3 py-2 text-[11px] text-yellow-400 bg-yellow-500/5 border-b border-yellow-500/20 flex items-start gap-1.5">
            <EyeOff className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {data.trackingNote}
          </p>
        )}
        {data?.hadPixel && (
          <p className="px-3 py-2 text-[11px] text-muted-foreground bg-muted/30 border-b border-card-border flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" /> خرجت ببكسل فتحٍ وروابط متتبَّعة.
          </p>
        )}

        <div className="flex-1 overflow-auto bg-white">
          {!data ? <div className="p-10 text-center"><Loader2 className="w-5 h-5 animate-spin inline text-muted-foreground" /></div>
            : tab === "html"
              ? <iframe title="معاينة الرسالة" src={`${BASE}/api/email/sent/${id}/body`} sandbox="" className="w-full h-[55vh] border-0 bg-white" />
              : <pre className="p-4 text-xs whitespace-pre-wrap text-black leading-relaxed" dir="auto">{data.text || "—"}</pre>}
        </div>

        {(data?.events?.length ?? 0) > 0 && (
          <div className="p-3 border-t border-card-border">
            <p className="text-[11px] font-semibold mb-1.5">ما حدث لها</p>
            <div className="flex flex-wrap gap-1.5">
              {data.events.map((e: any, i: number) => (
                <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                  {EVENT_AR[e.type] ?? e.type} · {when(e.at)}
                  {e.url && <a href={e.url} target="_blank" rel="noreferrer" className="inline-flex"><ExternalLink className="w-2.5 h-2.5 mr-1" /></a>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
