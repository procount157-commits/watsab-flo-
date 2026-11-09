// ── قطع مركز القيادة المشتركة ─────────────────────────────────────
// قاعدة واحدة تحكم كل ما هنا: لا رقم إلا من الخادم، ولا «سليم» بلا نبض، ولا مخطط بلا
// بيانات. نقطة نهاية لم تُنشر بعد تظهر «يُجهَّز…» في موضعها، ولا تُسقط الصفحة.

import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Hourglass, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const card = "bg-card border border-card-border rounded-xl";
export const ghost = "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
export const primary = "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
export const danger = "inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40";
export const pill = "text-[10px] px-2 py-0.5 rounded-full border whitespace-nowrap";
export const field = "bg-input border border-card-border rounded-lg px-3 py-2 text-xs focus:outline-none focus:border-primary/50";

export const num = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? "—" : Number(v).toLocaleString("ar-SA"));
export const when = (d: unknown) => {
  if (!d) return "—";
  const t = new Date(d as string);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString("ar-AE", { dateStyle: "short", timeStyle: "short" });
};
export const day = (d: unknown) => {
  if (!d) return "—";
  const t = new Date(d as string);
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleDateString("ar-AE", { dateStyle: "short" });
};
export const ago = (d: unknown) => {
  if (!d) return "—";
  const t = new Date(d as string).getTime();
  if (Number.isNaN(t)) return String(d);
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 0) { const f = -m; return f < 60 ? `بعد ${f} د` : f < 1440 ? `بعد ${Math.round(f / 60)} س` : `بعد ${Math.round(f / 1440)} يوم`; }
  if (m < 1) return "الآن";
  if (m < 60) return `قبل ${m} د`;
  const h = Math.round(m / 60);
  return h < 24 ? `قبل ${h} س` : `قبل ${Math.round(h / 24)} يوم`;
};
/** نص أو كائن يأتي من jsonb: يُعرض كما هو، بلا افتراض لشكله. */
export const show = (v: unknown): string => {
  if (v == null || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};
export const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** نسبة 0..1 كما يعيدها الخادم؛ null يعني عيّنة ناقصة ولا يصير صفراً. */
export const pct = (v: unknown) => (v == null || Number.isNaN(Number(v)) ? null : `${Math.round(Number(v) * 100).toLocaleString("ar-SA")}٪`);

// ── الطلب ─────────────────────────────────────────────────────────
export class OrgError extends Error {
  /** missing: المسار لم يُنشر بعد (404 بلا ردّ من مسار، أو HTML مكان JSON، أو 501). 404 بسبب مكتوب ردٌّ حقيقي. */
  constructor(message: string, public status: number, public missing = false) { super(message); }
}

export async function orgApi<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const r = await fetch(`${BASE}/api/org${path}`, {
    credentials: "include",
    method: init?.method ?? "GET",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await r.text();
  let d: any = null;
  try { d = text ? JSON.parse(text) : {}; } catch { throw new OrgError("الخادم لم يردّ ببيانات", r.ok ? 404 : r.status, r.ok || r.status === 404); }
  if (!r.ok) throw new OrgError(d?.error ?? "فشل الطلب", r.status, r.status === 501 || (r.status === 404 && !d?.error));
  return d as T;
}

export const useOrg = <T = any,>(path: string, refetchInterval: number | false = 30_000, enabled = true) =>
  useQuery<T, OrgError>({
    queryKey: ["org", path],
    queryFn: () => orgApi<T>(path),
    refetchInterval,
    enabled,
    retry: (count, err) => !(err instanceof OrgError && err.status < 500) && count < 1,
  });

/** ينفّذ فعلاً على الخادم، يعلن نتيجته، ويعيد قراءة كل بيانات مركز القيادة. */
export function useOrgAction() {
  const qc = useQueryClient();
  return useMutation<any, Error, { path: string; method?: string; body?: unknown; ok?: string | ((d: any) => string) }>({
    mutationFn: ({ path, method, body }) => orgApi(path, { method: method ?? "POST", body: body ?? {} }),
    onSuccess: (d, v) => { toast.success((typeof v.ok === "function" ? v.ok(d) : v.ok) ?? "تم"); void qc.invalidateQueries({ queryKey: ["org"] }); },
    onError: (e) => toast.error(e.message),
  });
}

// ── حالات الانتظار ────────────────────────────────────────────────
export const Preparing = ({ what }: { what?: string }) => (
  <div className={cn(card, "p-5 text-sm text-muted-foreground flex items-center gap-2")}>
    <Hourglass className="w-4 h-4 flex-shrink-0" /> يُجهَّز…{what ? ` ${what}` : ""}
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground py-2">{children}</p>;

/** يلفّ استعلاماً واحداً: تحميل، لم يُنشر، خطأ مع إعادة محاولة، ثم المحتوى. */
export function Q<T>({ q, what, children }: { q: UseQueryResult<T, OrgError>; what?: string; children: (d: T) => ReactNode }) {
  if (q.isLoading) return <div className="py-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  if (q.error) {
    if (q.error instanceof OrgError && q.error.missing) return <Preparing what={what} />;
    return (
      <div className={cn(card, "p-4 text-xs flex items-center gap-2 flex-wrap")}>
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <span>تعذّر التحميل{what ? ` (${what})` : ""}: {q.error.message}</span>
        <button className={cn(ghost, "mr-auto")} onClick={() => void q.refetch()}><RefreshCw className="w-3 h-3" /> إعادة المحاولة</button>
      </div>
    );
  }
  if (q.data === undefined) return <Preparing what={what} />;
  return <>{children(q.data)}</>;
}

// ── الحالات ───────────────────────────────────────────────────────
const G = "border-green-500/30 bg-green-500/10 text-green-400";
const B = "border-blue-500/30 bg-blue-500/10 text-blue-400";
const Y = "border-yellow-500/30 bg-yellow-500/10 text-yellow-400";
const R = "border-red-500/30 bg-red-500/10 text-red-400";
const N = "border-border text-muted-foreground";

export const HEARTBEAT: Record<string, { label: string; cls: string }> = {
  healthy: { label: "سليم", cls: G },
  running: { label: "يعمل", cls: B },
  late: { label: "متأخر", cls: Y },
  delayed: { label: "متأخر", cls: Y },
  failed: { label: "فشل", cls: R },
  halted: { label: "موقوف", cls: R },
  paused: { label: "موقوف", cls: R },
  no_execution: { label: "بلا تنفيذ", cls: N },
};
export const TASK: Record<string, { label: string; cls: string }> = {
  pending: { label: "معلّقة", cls: N },
  queued: { label: "في الطابور", cls: B },
  running: { label: "تعمل", cls: B },
  waiting_for_dependency: { label: "تنتظر مهمة أخرى", cls: Y },
  waiting_for_approval: { label: "تنتظر موافقتك", cls: Y },
  completed: { label: "اكتملت", cls: G },
  failed: { label: "فشلت", cls: R },
  cancelled: { label: "أُلغيت", cls: N },
  expired: { label: "انتهت مهلتها", cls: N },
};
export const PROPOSAL: Record<string, { label: string; cls: string }> = {
  proposed: { label: "مقترح", cls: Y },
  approved: { label: "مُوافَق عليه", cls: B },
  applied: { label: "مُطبَّق", cls: G },
  rejected: { label: "مرفوض", cls: N },
  rolled_back: { label: "مُرجَع", cls: N },
};
export const READINESS: Record<string, { label: string; cls: string }> = {
  READY: { label: "جاهز", cls: G },
  BLOCKED: { label: "محجوب", cls: R },
  NEEDS_TEST: { label: "يحتاج اختباراً", cls: Y },
};
export const DEPARTMENT: Record<string, string> = {
  executive: "التنفيذي", email: "البريد", target_accounts: "الحسابات المستهدفة", whatsapp: "واتساب",
  instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن", shared: "المشترك", social: "التواصل الاجتماعي",
};
export const EXECUTION: Record<string, string> = { own: "له عامل", part_of: "جزء من جولة غيره", on_demand: "بالطلب فقط", none: "بلا محرّك" };
export const CHANNEL: Record<string, string> = { whatsapp: "واتساب", email: "البريد", instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن" };
export const dept = (d: unknown) => (d ? DEPARTMENT[String(d)] ?? String(d) : "—");

export const Pill = ({ map, value }: { map: Record<string, { label: string; cls: string }>; value: unknown }) => {
  const s = map[String(value ?? "")];
  return <span className={cn(pill, s?.cls ?? N)}>{s?.label ?? (value == null || value === "" ? "—" : String(value))}</span>;
};

/** الدرجة، و«بيانات غير كافية» حين يقولها الخادم أو لا تأتي درجة. */
export const isInsufficient = (v: unknown) => v == null || v === "" || String(v).toUpperCase().replace(/_/g, " ") === "INSUFFICIENT DATA";
export const Score = ({ value, className }: { value: unknown; className?: string }) =>
  isInsufficient(value)
    ? <span className={cn("text-muted-foreground", className)}>بيانات غير كافية</span>
    : <span className={cn("font-bold", className)}>{Number.isNaN(Number(value)) ? String(value) : num(value)}</span>;

// ── العرض ─────────────────────────────────────────────────────────
export const Stat = ({ label, value, hint }: { label: string; value: unknown; hint?: ReactNode }) => (
  <div className={cn(card, "p-3")}>
    <p className="text-[11px] text-muted-foreground">{label}</p>
    <p className="text-xl font-bold mt-0.5">{typeof value === "number" || typeof value === "string" ? num(value) === "—" ? String(value) : num(value) : "—"}</p>
    {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
  </div>
);
export const Section = ({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) => (
  <section className={cn(card, "p-4 space-y-3")}>
    <div className="flex items-center gap-2 flex-wrap">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action && <div className="mr-auto">{action}</div>}
    </div>
    {children}
  </section>
);
export const Pre = ({ children, className }: { children: ReactNode; className?: string }) => (
  <pre className={cn("font-sans text-[11px] leading-relaxed whitespace-pre-wrap break-words bg-muted/40 border border-card-border rounded-lg p-2.5 max-h-72 overflow-y-auto", className)} dir="auto">{children}</pre>
);
export const Filters = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: Array<{ key: string; label: string }> }) => (
  <div className="flex gap-1.5 flex-wrap">
    {options.map((o) => (
      <button key={o.key} onClick={() => onChange(o.key)} className={cn("px-3 py-1 rounded-full border text-xs", value === o.key ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground hover:text-foreground")}>{o.label}</button>
    ))}
  </div>
);

// ── المخطط ────────────────────────────────────────────────────────
/**
 * سلسلة واحدة عبر الزمن: أعمدة رفيعة من خط أساس، بلون واحد، بتلميح لكل عمود وجدول عند
 * الطلب. لا يُرسم شيء إن لم تأت بيانات، ولا إن كانت كلها صفراً فتبدو نتيجةً وليست كذلك.
 */
export function Bars({ title, data, unit }: { title: string; data: Array<{ x: string; y: number }>; unit?: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const rows = data.filter((d) => Number.isFinite(d.y));
  if (!rows.length || rows.every((d) => d.y === 0)) return null;
  const max = Math.max(...rows.map((d) => d.y), 1);
  const latest = rows[rows.length - 1]!;
  const active = hover == null ? null : rows[hover];
  return (
    <figure className="rounded-lg border border-card-border p-3 space-y-2 min-w-0">
      <figcaption className="flex items-baseline gap-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <span className="mr-auto text-sm font-bold">{num(active?.y ?? latest.y)}{unit ? ` ${unit}` : ""}</span>
      </figcaption>
      <p className="text-[10px] text-muted-foreground h-3">{active?.x ?? latest.x}</p>
      {table ? (
        <table className="w-full text-[11px]"><tbody>
          {rows.map((r) => <tr key={r.x} className="border-t border-card-border"><td className="py-0.5 text-muted-foreground">{r.x}</td><td className="py-0.5 text-left">{num(r.y)}</td></tr>)}
        </tbody></table>
      ) : (
        <div className="flex items-end h-16 border-b border-border" dir="ltr" role="img" aria-label={`${title}: ${rows.length} نقطة، الأحدث ${latest.y}`} onMouseLeave={() => setHover(null)}>
          {rows.map((r, i) => (
            <div key={r.x} className="flex-1 h-full flex items-end px-px cursor-default" onMouseEnter={() => setHover(i)} title={`${r.x}: ${r.y}`}>
              <div className={cn("w-full rounded-t-[4px] bg-primary", hover != null && hover !== i && "opacity-40")} style={{ height: `${(r.y / max) * 100}%`, minHeight: r.y > 0 ? 2 : 0 }} />
            </div>
          ))}
        </div>
      )}
      <button className="text-[10px] text-muted-foreground hover:text-foreground" onClick={() => setTable(!table)}>{table ? "عرض المخطط" : "عرض كجدول"}</button>
    </figure>
  );
}

/** مقارنة بين فئات بقيمة واحدة: لون واحد، والقيمة مكتوبة بجانب كل عمود. لا يُرسم بلا قيم. */
export function HBars({ title, data, format }: { title: string; data: Array<{ label: string; value: number | null | undefined }>; format?: (v: number) => string }) {
  const rows = data.filter((d): d is { label: string; value: number } => d.value != null && Number.isFinite(d.value)).sort((a, b) => b.value - a.value);
  if (!rows.length || rows.every((d) => d.value === 0)) return null;
  const max = Math.max(...rows.map((d) => d.value), 1);
  return (
    <figure className="rounded-lg border border-card-border p-3 space-y-1.5 min-w-0">
      <figcaption className="text-xs text-muted-foreground mb-2">{title}</figcaption>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-2 text-[11px]" title={`${r.label}: ${r.value}`}>
          <span className="w-28 truncate flex-shrink-0">{r.label}</span>
          <span className="flex-1 min-w-0"><span className="block h-2 rounded-l-[4px] bg-primary" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value > 0 ? 2 : 0 }} /></span>
          <span className="w-12 text-left flex-shrink-0">{format ? format(r.value) : num(r.value)}</span>
        </div>
      ))}
    </figure>
  );
}

// ── تأكيد داخل الصفحة ─────────────────────────────────────────────
/**
 * زر يطلب تأكيداً في مكانه، ويسمّي الأثر قبل التنفيذ. لا نافذة متصفح. `reason` يطلب سبباً
 * مكتوباً؛ `requireReason` يمنع التنفيذ بدونه.
 */
export function Confirm({ label, effect, onConfirm, tone = "danger", reason, requireReason, busy, icon }: {
  label: string; effect: ReactNode; onConfirm: (reason: string) => void; tone?: "danger" | "primary" | "ghost";
  reason?: boolean; requireReason?: boolean; busy?: boolean; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  useEffect(() => { if (!open) setWhy(""); }, [open]);
  const cls = tone === "danger" ? danger : tone === "primary" ? primary : ghost;
  if (!open) return <button className={cls} disabled={busy} onClick={() => setOpen(true)}>{icon}{label}</button>;
  return (
    <div className="w-full rounded-lg border border-yellow-500/40 bg-yellow-500/5 p-3 space-y-2 text-xs" role="alertdialog">
      <p className="flex items-start gap-1.5 leading-relaxed"><TriangleAlert className="w-3.5 h-3.5 mt-0.5 text-yellow-400 flex-shrink-0" /><span>{effect}</span></p>
      {reason && <input className={cn(field, "w-full")} placeholder={requireReason ? "السبب (مطلوب)" : "السبب (اختياري)"} value={why} onChange={(e) => setWhy(e.target.value)} />}
      <div className="flex gap-2">
        <button className={cls} disabled={busy || (requireReason && !why.trim())} onClick={() => { onConfirm(why.trim()); setOpen(false); }}>{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}نعم، {label}</button>
        <button className={ghost} onClick={() => setOpen(false)}>تراجع</button>
      </div>
    </div>
  );
}
