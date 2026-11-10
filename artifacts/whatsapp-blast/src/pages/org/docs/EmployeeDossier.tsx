// ── ملف الموظف ومحرّره ─────────────────────────────────────────────
// يُعرض في صفحة الموظف: <EmployeeDossier employeeKey="…" />. القاعدة مصدر الحقيقة؛ التحرير
// ينشئ نسخة مسودة، والتقديم ينشئ مقترحاً، ولا شيء يعمل قبل موافقة صاحب الحساب. لا رقم ولا
// حالة إلا من الخادم.

import { useEffect, useState } from "react";
import { FileText, GitCompare, History, Pencil, RotateCcw, Send, Check, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import { Confirm, Empty, Pre, Q, Section, card, field, ghost, num, pill, primary, useOrg, useOrgAction, when } from "../shared";

const BASE = "/docs";
const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "مسودة", cls: "border-border text-muted-foreground" },
  proposed: { label: "بانتظار الموافقة", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  approved: { label: "معتمدة", cls: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
  active: { label: "نشطة", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  superseded: { label: "سابقة", cls: "border-border text-muted-foreground" },
};
const Status = ({ s }: { s: string }) => <span className={cn(pill, STATUS[s]?.cls ?? STATUS["draft"]!.cls)}>{STATUS[s]?.label ?? s}</span>;

type Meta = { sections: Array<{ key: string; title: string }>; docOnlyMark: string; runtimeLimit: number };
type Row = { version: number; status: string; author: string; change_reason: string | null; created_at: string; approved_at: string | null; activated_at: string | null; proposal_id: number | null; sections?: Record<string, string> };
type Dossier = { employeeKey: string; externalBehavior: boolean; active: Row | null; latest: Row | null; history: Row[]; runtime: { text: string; length: number; limit: number } | null; diff: Array<{ op: string; text: string }> | null };

function Diff({ lines }: { lines: Array<{ op: string; text: string }> | null }) {
  if (!lines) return <Empty>لا فرق: المعروضة هي النشطة.</Empty>;
  const changed = lines.filter((l) => l.op !== "same").length;
  if (!changed) return <Empty>لا فرق في النص.</Empty>;
  return (
    <div className="text-[11px] font-mono leading-relaxed max-h-[28rem] overflow-auto rounded-lg border border-card-border" dir="auto">
      {lines.map((l, i) => l.op === "same" ? null : (
        <div key={i} className={cn("px-2 whitespace-pre-wrap", l.op === "add" ? "bg-green-500/10 text-green-300" : "bg-red-500/10 text-red-300 line-through")}>
          {l.op === "add" ? "+ " : "− "}{l.text || " "}
        </div>
      ))}
    </div>
  );
}

function Sections({ meta, sections, mark }: { meta: Meta; sections: Record<string, string>; mark: string }) {
  return (
    <div className="space-y-2">
      {meta.sections.map((s, i) => (
        <details key={s.key} className={cn(card, "p-3")} open={i < 2}>
          <summary className="text-xs font-semibold cursor-pointer">{num(i + 1)}. {s.title}</summary>
          <div className="mt-2 text-xs leading-relaxed whitespace-pre-wrap" dir="auto">
            {(sections[s.key] ?? "").split("\n").map((l, j) => (
              <p key={j} className={l.trimStart().startsWith(mark) ? "text-muted-foreground" : ""}>{l || " "}</p>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

function Editor({ meta, base, onDone, employeeKey }: { meta: Meta; base: Row; employeeKey: string; onDone: () => void }) {
  const [draft, setDraft] = useState<Record<string, string>>(() => ({ ...(base.sections ?? {}) }));
  const [reason, setReason] = useState("");
  const act = useOrgAction();
  const isDraft = base.status === "draft";
  useEffect(() => { setDraft({ ...(base.sections ?? {}) }); }, [base.version]);
  const save = (asNew: boolean) => {
    const sections = Object.fromEntries(meta.sections.filter((s) => s.key !== "version").map((s) => [s.key, draft[s.key] ?? ""]));
    act.mutate(asNew
      ? { path: `${BASE}/employees/${encodeURIComponent(employeeKey)}/drafts`, body: { sections, reason, baseVersion: base.version }, ok: (d) => `حُفظت مسودة v${d?.dossier?.version ?? ""}` }
      : { path: `${BASE}/employees/${encodeURIComponent(employeeKey)}/versions/${base.version}`, method: "PUT", body: { sections, reason }, ok: "حُفظت المسودة" },
      { onSuccess: onDone });
  };
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        السطر الذي يبدأ بـ «{meta.docOnlyMark}» توثيقٌ لا يدخل التعليمات المضغوطة. قسم النسخة يكتبه الخادم. الحفظ لا يفعّل شيئاً: النسخة تبقى مسودة حتى تُقدَّم ويوافق صاحب الحساب.
      </p>
      {meta.sections.filter((s) => s.key !== "version").map((s, i) => (
        <label key={s.key} className="block space-y-1">
          <span className="text-xs font-semibold">{num(i + 1)}. {s.title}</span>
          <textarea className={cn(field, "w-full min-h-[6rem] font-mono leading-relaxed")} dir="auto" value={draft[s.key] ?? ""} onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })} />
        </label>
      ))}
      <input className={cn(field, "w-full")} placeholder="سبب التغيير (مطلوب)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="flex gap-2 flex-wrap">
        {isDraft && <button className={primary} disabled={act.isPending} onClick={() => save(false)}><Save className="w-3 h-3" /> حفظ المسودة v{num(base.version)}</button>}
        <button className={isDraft ? ghost : primary} disabled={act.isPending || !reason.trim()} onClick={() => save(true)}><Save className="w-3 h-3" /> حفظ كنسخة جديدة</button>
        <button className={ghost} onClick={onDone}>إلغاء</button>
      </div>
    </div>
  );
}

export function EmployeeDossier({ employeeKey }: { employeeKey: string }) {
  const metaQ = useOrg<Meta>(`${BASE}/meta`, false);
  const q = useOrg<Dossier>(`${BASE}/employees/${encodeURIComponent(employeeKey)}`, 60_000);
  const [view, setView] = useState<"sections" | "diff" | "runtime" | "history" | "edit">("sections");
  const [picked, setPicked] = useState<number | null>(null);
  const versionQ = useOrg<{ dossier: Row; runtime: Dossier["runtime"] }>(`${BASE}/employees/${encodeURIComponent(employeeKey)}/versions/${picked ?? 0}`, false, picked != null);
  const diffQ = useOrg<{ diff: Array<{ op: string; text: string }> }>(`${BASE}/employees/${encodeURIComponent(employeeKey)}/diff?to=${picked ?? 0}`, false, picked != null && view === "diff");
  const act = useOrgAction();
  const path = (v: number, a: string) => `${BASE}/employees/${encodeURIComponent(employeeKey)}/versions/${v}/${a}`;

  return (
    <Section title="ملف الموظف وتعليماته" action={<FileText className="w-4 h-4 text-muted-foreground" />}>
      <Q q={metaQ} what="أقسام الملف">{(meta) => (
        <Q q={q} what="ملف الموظف">{(d) => {
          const shown: Row | null = picked != null ? versionQ.data?.dossier ?? null : d.latest;
          const runtime = picked != null ? versionQ.data?.runtime ?? null : d.runtime;
          if (!d.latest) return <Empty>لم يُبذر ملف هذا الموظف بعد.</Empty>;
          return (
            <div className="space-y-3">
              <div className="flex gap-2 items-center flex-wrap text-xs">
                <span>النشطة: {d.active ? <>v{num(d.active.version)} <Status s="active" /></> : <span className="text-muted-foreground">لا شيء بعد — يعمل الموظف بتعليماته الحالية</span>}</span>
                <span className="text-muted-foreground">·</span>
                <span>المعروضة: v{num(shown?.version)} {shown && <Status s={shown.status} />}</span>
                {d.externalBehavior && <span className={cn(pill, "border-yellow-500/30 text-yellow-400")}>يؤثر فيما يخرج للناس: موافقة إلزامية</span>}
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {([["sections", "الأقسام", FileText], ["diff", "الفرق عن النشطة", GitCompare], ["runtime", "التعليمات المجمَّعة", FileText], ["history", "السجل", History], ["edit", "تحرير", Pencil]] as const).map(([k, label, Icon]) => (
                  <button key={k} className={cn(ghost, view === k && "border-primary/60 text-primary")} onClick={() => setView(k)}><Icon className="w-3 h-3" /> {label}</button>
                ))}
              </div>

              {shown && (
                <div className="flex gap-2 flex-wrap">
                  {shown.status === "draft" && (
                    <Confirm tone="primary" label={`تقديم v${shown.version} للموافقة`} icon={<Send className="w-3 h-3" />} reason busy={act.isPending}
                      effect="ينشئ مقترح تحسين في الموافقات. لا يتغيّر شيء في عمل الموظف قبل موافقتك."
                      onConfirm={(why) => act.mutate({ path: path(shown.version, "submit"), body: { reason: why || undefined }, ok: "قُدّمت للموافقة" })} />
                  )}
                  {shown.status === "proposed" && (<>
                    <Confirm tone="primary" label={`اعتماد وتفعيل v${shown.version}`} icon={<Check className="w-3 h-3" />} busy={act.isPending}
                      effect={<>يفعّل هذه النسخة: تُكتب تعليماتها المجمَّعة في الموظف وتصير النسخة النشطة، والسابقة تُحفظ للإرجاع.{d.externalBehavior ? " هذا الموظف يكتب لعملاء أو يحدّد من يُراسَل." : ""}</>}
                      onConfirm={() => act.mutate({ path: path(shown.version, "approve"), ok: "اعتُمدت وفُعّلت" })} />
                    <Confirm label="رفض" icon={<X className="w-3 h-3" />} reason busy={act.isPending} effect="يُرفض المقترح وتعود النسخة مسودة."
                      onConfirm={(why) => act.mutate({ path: path(shown.version, "reject"), body: { reason: why || undefined }, ok: "رُفضت" })} />
                  </>)}
                  {d.active && d.active.proposal_id != null && (
                    <Confirm label={`إرجاع v${d.active.version}`} icon={<RotateCcw className="w-3 h-3" />} busy={act.isPending}
                      effect="يعيد تعليمات الموظف كما كانت قبل تفعيل النسخة النشطة، وتعود النسخة السابقة نشطة."
                      onConfirm={() => act.mutate({ path: `${BASE}/employees/${encodeURIComponent(employeeKey)}/rollback`, ok: "أُرجعت" })} />
                  )}
                  {picked != null && <button className={ghost} onClick={() => setPicked(null)}>عرض الأحدث</button>}
                </div>
              )}

              {view === "sections" && shown?.sections && <Sections meta={meta} sections={shown.sections} mark={meta.docOnlyMark} />}
              {view === "sections" && picked != null && versionQ.isLoading && <Empty>يُحمَّل…</Empty>}
              {view === "diff" && (picked == null ? <Diff lines={d.diff} /> : <Diff lines={diffQ.data?.diff ?? null} />)}
              {view === "runtime" && (runtime ? (
                <div className="space-y-1">
                  <p className={cn("text-[11px]", runtime.length > runtime.limit ? "text-red-400" : "text-muted-foreground")}>
                    {num(runtime.length)} حرفاً من {num(runtime.limit)} — هذا ما سيعمل به الموظف لو فُعّلت هذه النسخة، مع معرفة الحساب المعتمدة وحدها.
                  </p>
                  <Pre className="max-h-[28rem] overflow-auto">{runtime.text}</Pre>
                </div>
              ) : <Empty>لا تعليمات مجمَّعة بعد.</Empty>)}
              {view === "history" && (
                <ul className="divide-y divide-card-border text-xs">
                  {d.history.map((h) => (
                    <li key={h.version} className="py-2 flex gap-2 items-start flex-wrap">
                      <button className="font-mono text-primary hover:underline" onClick={() => { setPicked(h.version === d.latest?.version ? null : h.version); setView("sections"); }}>v{num(h.version)}</button>
                      <Status s={h.status} />
                      <span className="text-muted-foreground" dir="ltr">{h.author}</span>
                      <span className="text-muted-foreground">{when(h.created_at)}</span>
                      {h.activated_at && <span className="text-muted-foreground">فُعّلت {when(h.activated_at)}</span>}
                      {h.proposal_id != null && <span className="text-muted-foreground">مقترح #{num(h.proposal_id)}</span>}
                      <span className="basis-full text-muted-foreground">{h.change_reason ?? "—"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {view === "edit" && shown?.sections && <Editor meta={meta} base={shown} employeeKey={employeeKey} onDone={() => { setView("sections"); setPicked(null); }} />}
            </div>
          );
        }}</Q>
      )}</Q>
    </Section>
  );
}

// ── المعيار والاعتراضات ───────────────────────────────────────────
type Knowledge = { id: number; key: string; value: any; sourceReference: string | null; approvalStatus: string };
const APPROVAL: Record<string, { label: string; cls: string }> = {
  pending: { label: "معلّق", cls: "border-yellow-500/30 bg-yellow-500/10 text-yellow-400" },
  approved: { label: "معتمد", cls: "border-green-500/30 bg-green-500/10 text-green-400" },
  rejected: { label: "مرفوض", cls: "border-red-500/30 bg-red-500/10 text-red-400" },
};

/** معيار الإقناع ومكتبة اعتراضات هذا الحساب: لا يدخل شيء منها التعليمات قبل اعتماده. */
export function PersuasionLibrary() {
  const q = useOrg<{ standard: any; objectionTypes: Record<string, string>; roles: Record<string, { title: string; text: string }>; knowledge: Knowledge[] }>(`${BASE}/persuasion`, 120_000);
  const act = useOrgAction();
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  return (
    <Section title="معيار الإقناع والاعتراضات">
      <Q q={q} what="المعيار">{(d) => {
        const rows = d.knowledge.filter((k) => filter === "all" || k.approvalStatus === "pending");
        return (
          <div className="space-y-3 text-xs">
            <details className={cn(card, "p-3")}>
              <summary className="font-semibold cursor-pointer">{d.standard.title}</summary>
              <ul className="mt-2 space-y-1 list-disc pr-4">{(d.standard.principles as string[]).map((p) => <li key={p}>{p}</li>)}</ul>
              <ul className="mt-2 space-y-1 list-disc pr-4 text-muted-foreground">{(d.standard.prohibited as string[]).map((p) => <li key={p}>ممنوع: {p}</li>)}</ul>
            </details>
            <div className="flex gap-2">
              <button className={cn(ghost, filter === "pending" && "text-primary border-primary/60")} onClick={() => setFilter("pending")}>المعلّق</button>
              <button className={cn(ghost, filter === "all" && "text-primary border-primary/60")} onClick={() => setFilter("all")}>الكل</button>
            </div>
            {!rows.length && <Empty>{d.knowledge.length ? "لا شيء معلّق." : "لا مكتبة اعتراضات لهذا الحساب."}</Empty>}
            {rows.map((k) => {
              const v = k.value ?? {};
              const isPlaybook = k.key.startsWith("playbook.");
              return (
                <div key={k.id} className={cn(card, "p-3 space-y-1.5")}>
                  <div className="flex gap-2 items-center flex-wrap">
                    <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">{k.key}</span>
                    <span className={cn(pill, APPROVAL[k.approvalStatus]?.cls)}>{APPROVAL[k.approvalStatus]?.label ?? k.approvalStatus}</span>
                    {!isPlaybook && v.type && <span className={pill}>{d.objectionTypes[v.type] ?? v.type}</span>}
                  </div>
                  {isPlaybook ? <p dir="auto">{v.text}</p> : (<>
                    <p dir="auto"><b>العميل:</b> «{v.signal}»</p>
                    <p dir="auto"><b>المعالجة:</b> {v.response}</p>
                    {v.nextStep && <p dir="auto"><b>الخطوة:</b> {v.nextStep}</p>}
                    {v.proof && <p dir="auto" className={v.proof.status === "needs_owner_approval" ? "text-yellow-400" : "text-muted-foreground"}>
                      <b>الدليل:</b> {v.proof.text} — {v.proof.status === "needs_owner_approval" ? "يحتاج موافقة صاحب العمل" : "من المعرفة المعتمدة"}
                    </p>}
                  </>)}
                  <p className="text-[10px] text-muted-foreground" dir="ltr">{k.sourceReference}</p>
                  {k.approvalStatus === "pending" && (
                    <div className="flex gap-2">
                      <button className={primary} disabled={act.isPending} onClick={() => act.mutate({ path: `${BASE}/persuasion/${k.id}/approve`, ok: "اعتُمد" })}><Check className="w-3 h-3" /> اعتماد</button>
                      <button className={ghost} disabled={act.isPending} onClick={() => act.mutate({ path: `${BASE}/persuasion/${k.id}/reject`, ok: "رُفض" })}><X className="w-3 h-3" /> رفض</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      }}</Q>
    </Section>
  );
}

export default EmployeeDossier;
