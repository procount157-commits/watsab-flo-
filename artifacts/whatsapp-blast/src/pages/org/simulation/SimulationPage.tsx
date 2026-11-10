// المحاكاة: الظل (التعليمات الحالية مقابل المقترحة على مدخلات حقيقية) والسيناريو التجريبي
// جاسم ← منصور ← سلمى ← نورة ← ماجد ← البوابة ← جاسم، خطوةً خطوة. داخل المحاكاة ترفض البوابة
// كل إرسال، ولا يُفعَّل شيء، وبيانات السيناريو بيانات اختبار لا تختلط بأي رقم حقيقي.

import { useState } from "react";
import { Link } from "wouter";
import { ArrowDown, FlaskConical, Loader2, PlayCircle, ShieldCheck, TestTube2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pre, Q, Section, Stat, ago, card, ghost, list, num, pill, primary, show, useOrg, useOrgAction, when } from "../shared";
import { SHADOW, ShadowRow, ShadowWarnings } from "./ShadowCompare";

const STEP: Record<string, string> = {
  analysis: "تحليل", review: "مراجعة", plan: "تخطيط", revision: "إعادة كتابة", accepted: "قبول", returned: "إعادة بملاحظات",
  sandbox_execution: "تنفيذ تجريبي", outcome_event: "حدث النتيجة", learning_candidate: "درسٌ مرشّح",
};
const RUN: Record<string, string> = { running: "يجري", succeeded: "اكتمل", failed: "فشل" };

function E2eRun({ id }: { id: number }) {
  const q = useOrg<any>(`/sim/e2e/runs/${id}`, false);
  return (
    <Q q={q} what="خطوات السيناريو">
      {(d) => (
        <div className="space-y-2">
          <div className={cn(card, "p-3 text-xs flex items-center gap-2 flex-wrap border-yellow-500/30")}>
            <TestTube2 className="w-3.5 h-3.5 text-yellow-400" />
            <span className={cn(pill, "border-yellow-500/30 bg-yellow-500/10 text-yellow-400")}>بيانات اختبار</span>
            <span dir="auto">{d.run?.fixture_label ?? "—"}</span>
            <span className="text-muted-foreground">· {RUN[d.run?.status] ?? d.run?.status} · {num(d.run?.model_calls)} نداء نموذج · {when(d.run?.started_at)}</span>
            {d.run?.error && <span className="text-red-400" dir="auto">· {d.run.error}</span>}
          </div>
          <ol className="space-y-1">
            {list(d.steps).map((s: any, i: number) => (
              <li key={s.step}>
                <div className={cn(card, "p-3 text-xs space-y-1.5", s.kind === "returned" && "border-red-500/30", s.kind === "sandbox_execution" && "border-blue-500/30")}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[10px] font-bold">{num(s.step)}</span>
                    <b>{s.actor_name ?? "—"}</b>
                    <span className={cn(pill, "border-border text-muted-foreground")}>{STEP[s.kind] ?? s.kind}</span>
                    <span dir="auto">{s.title}</span>
                    <span className="mr-auto flex items-center gap-2 text-[10px] text-muted-foreground">
                      {s.parent_ticket_id && <span>من التذكرة <Link href="/org/tasks" className="text-primary hover:underline" dir="ltr">#{s.parent_ticket_id}</Link></span>}
                      {s.ticket_id && <span>التذكرة <Link href="/org/tasks" className="text-primary hover:underline" dir="ltr">#{s.ticket_id}</Link></span>}
                    </span>
                  </div>
                  {s.detail != null && (
                    <details><summary className="cursor-pointer text-[11px] text-muted-foreground">الدليل</summary><Pre>{show(s.detail)}</Pre></details>
                  )}
                </div>
                {i < list(d.steps).length - 1 && <div className="flex justify-center py-0.5"><ArrowDown className="w-3 h-3 text-muted-foreground" /></div>}
              </li>
            ))}
          </ol>
          {!list(d.steps).length && <Empty>لا خطوات مسجّلة.</Empty>}
        </div>
      )}
    </Q>
  );
}

function E2e() {
  const act = useOrgAction();
  const q = useOrg<{ runs: any[] }>("/sim/e2e/runs", false);
  const [pick, setPick] = useState<number | null>(null);
  const runs = list(q.data?.runs);
  const shown = pick ?? (runs[0] ? Number(runs[0].id) : null);
  return (
    <Section title="السيناريو التجريبي (جاسم ← … ← جاسم)" action={
      <button className={primary} disabled={act.isPending} onClick={() => act.mutate({ path: "/sim/e2e/run", ok: (d) => { setPick(Number(d?.runId) || null); return d?.status === "succeeded" ? `اكتمل: ${num(d?.steps)} خطوات، ${d?.accepted ? "قبل ماجد النسخة" : "أعادها ماجد"}` : `فشل: ${d?.error ?? ""}`; } })}>
        {act.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlayCircle className="w-3 h-3" />} شغّل السيناريو
      </button>
    }>
      <p className="text-[11px] text-muted-foreground">على حملة اختبار لهذا الحساب: كل خطوة تذكرة مربوطة بما قبلها، ونورة تكتب بمسارها الحقيقي (نداء نموذج محسوب من سقف اليوم)، والبوابة ترفض الإرسال وتسجّل تنفيذاً تجريبياً. التذاكر بنوع sim_ ولا تدخل البطاقات ولا اللوحة ولا تقرير المدير.</p>
      <Q q={q} what="السيناريوهات">
        {() => (
          <>
            {runs.length > 1 && (
              <div className="flex gap-1.5 flex-wrap">
                {runs.map((r) => (
                  <button key={r.id} onClick={() => setPick(Number(r.id))} className={cn("px-2.5 py-1 rounded-full border text-[11px]", shown === Number(r.id) ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>
                    #{num(r.id)} · {RUN[r.status] ?? r.status} · {ago(r.started_at)}
                  </button>
                ))}
              </div>
            )}
            {shown ? <E2eRun key={shown} id={shown} /> : <Empty>لم يُشغَّل السيناريو بعد.</Empty>}
          </>
        )}
      </Q>
    </Section>
  );
}

function Shadow() {
  const act = useOrgAction();
  const status = useOrg<any>("/sim/status", false);
  const q = useOrg<{ results: any[] }>("/sim/shadow/results?limit=200", false);
  const [only, setOnly] = useState<string>("all");
  const rows = list(q.data?.results);
  const lastBatch = rows[0]?.batch_id;
  const batch = rows.filter((r) => r.batch_id === lastBatch);
  const shown = (only === "all" ? batch : batch.filter((r) => r.verdict === only));
  const count = (v: string) => batch.filter((r) => r.verdict === v).length;
  const samples = batch.filter((r) => ["better", "same", "failed_checks", "mixed", "no_output"].includes(r.verdict)).length;
  const summary = { warnings: [
    ...(lastBatch && !samples ? ["لا عيّنات حقيقية في آخر تشغيل: لا مقارنة"] : []),
    ...(count("failed_checks") ? [`المقترح خالف فحوص الكود في ${count("failed_checks")} عيّنة`] : []),
    ...(count("mixed") ? [`مختلط في ${count("mixed")} عيّنة: أصلح فحصاً وخالف آخر — لا يُفعَّل آلياً`] : []),
    ...(count("not_covered") ? [`لم يُجرَّب ${count("not_covered")} موظفاً: لهم مسار نموذج لا يمرّ به الظل، فلا يُفعَّلون آلياً`] : []),
  ] };
  return (
    <Section title="الظل: التعليمات الحالية مقابل المقترحة" action={
      <button className={ghost} disabled={act.isPending} onClick={() => act.mutate({ path: "/sim/shadow/run", ok: (d) => `الظل: ${num(d?.ran)} عيّنة، ${num(d?.callsUsed)} نداء` })}>
        {act.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <FlaskConical className="w-3 h-3" />} شغّل الظل لكل الموظفين
      </button>
    }>
      <Q q={status} what="سقف اليوم">
        {(s) => (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Stat label="نداءات اليوم" value={s.usedToday} hint={`من ${num(s.dailyCalls)} للحساب`} />
            <Stat label="موظفون موصولون" value={list(s.wired).length} hint="لهم مسار كتابة في الظل" />
            <Stat label="عيّنات آخر تشغيل" value={samples} hint={lastBatch ? ago(batch[0]?.created_at) : "لم يُشغَّل"} />
            <Stat label="الموعد" value={s.schedule} />
          </div>
        )}
      </Q>
      <ShadowWarnings summary={summary} />
      <div className="flex gap-1.5 flex-wrap text-[11px]">
        {["all", ...Object.keys(SHADOW)].map((k) => (
          <button key={k} onClick={() => setOnly(k)} className={cn("px-2.5 py-1 rounded-full border", only === k ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>
            {k === "all" ? `الكل ${num(batch.length)}` : `${SHADOW[k]!.label} ${num(count(k))}`}
          </button>
        ))}
      </div>
      <Q q={q} what="نتائج الظل">
        {() => shown.length ? <div className="divide-y divide-card-border">{shown.map((r) => <ShadowRow key={r.id} r={r} />)}</div> : <Empty>لا نتائج.</Empty>}
      </Q>
    </Section>
  );
}

export default function SimulationPage() {
  return (
    <div className="space-y-4">
      <div className={cn(card, "p-3 text-xs flex items-center gap-2 border-blue-500/30")}>
        <ShieldCheck className="w-4 h-4 text-blue-400 flex-shrink-0" />
        <span>وضع المحاكاة: البوابة ترفض كل إرسال قبل أي قناة، ولا يُفعَّل شيء، ولا يُحسب العمل في البطاقات ولا الاستهلاك ولا تقرير المدير.</span>
      </div>
      <Shadow />
      <E2e />
    </div>
  );
}
