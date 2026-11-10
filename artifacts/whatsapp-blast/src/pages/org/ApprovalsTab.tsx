// الموافقات: كل قرار ينتظر صاحب العمل، بسببه ودليله وقبله وبعده وأثره. لا يُطبَّق شيء بلا تأكيد يسمّي الأثر.

import { useState, type ReactNode } from "react";
import { Check, RotateCcw, Unlock, X } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { ShadowCompare } from "./simulation";
import { PersuasionLibrary } from "./docs/EmployeeDossier";
import { Confirm, Empty, Filters, PROPOSAL, Pill, Pre, Q, Section, Stat, ago, card, ghost, list, num, pill, primary, show, useOrg, useOrgAction, when } from "./shared";

const hasValue = (v: unknown) => v != null && v !== "" && !(typeof v === "object" && Object.keys(v as object).length === 0);
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0"><p className="text-[10px] text-muted-foreground mb-0.5">{label}</p>{children}</div>
);

export function ProposalCard({ p }: { p: any }) {
  const act = useOrgAction();
  const path = `/proposals/${p.change_id}`;
  const applies = String(p.target ?? "").startsWith("prompt:");
  const risky = p.classification?.risk !== "low";
  return (
    <div className={cn(card, "p-3.5 space-y-2.5")}>
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="text-muted-foreground" dir="ltr">#{p.change_id}</span>
        <b dir="ltr">{p.target ?? "—"}</b>
        <Pill map={PROPOSAL} value={p.status} />
        {p.classification && <span className={cn(pill, risky ? "border-yellow-500/30 text-yellow-400" : "border-border text-muted-foreground")}>{risky ? "تتطلب موافقة" : "منخفضة الخطر"} · <span dir="ltr">{p.classification.category}</span></span>}
        <span className="mr-auto text-[10px] text-muted-foreground" title={when(p.created_at)}>من <span dir="ltr">{p.requested_by}</span> · {ago(p.created_at)}</span>
      </div>
      <Field label="السبب"><p className="text-xs whitespace-pre-wrap" dir="auto">{p.reason ?? "—"}</p></Field>
      {p.classification?.why && <Field label="سبب التصنيف"><p className="text-[11px] text-muted-foreground" dir="auto">{p.classification.why}</p></Field>}
      <Field label="الأثر"><p className="text-xs whitespace-pre-wrap" dir="auto">{p.impact ?? "لم يُذكر"}</p></Field>
      <div className="grid md:grid-cols-2 gap-2">
        <Field label="القيمة الحالية"><Pre>{show(p.old_value)}</Pre></Field>
        <Field label="القيمة الجديدة"><Pre>{show(p.new_value)}</Pre></Field>
      </div>
      <Field label="الدليل">{hasValue(p.evidence) ? <Pre>{show(p.evidence)}</Pre> : <p className="text-[11px] text-muted-foreground">لا دليل مرفق.</p>}</Field>
      {applies && <ShadowCompare proposalId={p.change_id} />}
      {p.decision_note && <Field label="سبب القرار"><p className="text-xs whitespace-pre-wrap" dir="auto">{p.decision_note}</p></Field>}
      {p.status === "approved" && <p className="text-[11px] text-muted-foreground">وافقت عليه، وهذا الهدف لا يُطبَّق آلياً: تنفيذه بيدك.</p>}
      {p.applied_at && <p className="text-[11px] text-muted-foreground">طُبِّق {when(p.applied_at)}{p.rollback_version != null ? ` · يعود إلى النسخة ${num(p.rollback_version)}` : ""}</p>}
      <div className="flex gap-2 flex-wrap">
        {p.status === "proposed" && <>
          <Confirm tone="primary" label="موافقة" icon={<Check className="w-3 h-3" />} busy={act.isPending}
            effect={applies ? <>ستُطبَّق النسخة الجديدة فوراً على <b dir="ltr">{p.target}</b> ويعمل بها الموظف من جولته التالية. يمكن إرجاعها لاحقاً.</> : <>ستُسجَّل موافقتك على <b dir="ltr">{p.target}</b>. هذا الهدف لا يُطبَّق آلياً؛ يبقى تنفيذه يدوياً.</>}
            onConfirm={() => act.mutate({ path: `${path}/approve`, ok: (d) => (d?.applied ? "وافقت، وطُبِّق التغيير" : "وافقت، ولم يُطبَّق آلياً") })} />
          <Confirm tone="ghost" label="رفض" icon={<X className="w-3 h-3" />} busy={act.isPending} reason requireReason effect="سيُغلق المقترح بلا أي تغيير، ويُسجَّل سببك."
            onConfirm={(reason) => act.mutate({ path: `${path}/reject`, body: { reason }, ok: "رُفض المقترح" })} />
        </>}
        {p.status === "applied" && (
          <Confirm label="إرجاع" icon={<RotateCcw className="w-3 h-3" />} busy={act.isPending}
            effect={<>ستعود <b dir="ltr">{p.target}</b> إلى نسختها السابقة فوراً، ويُكتب ذلك في السجل.</>}
            onConfirm={() => act.mutate({ path: `${path}/rollback`, ok: "أُرجع التغيير" })} />
        )}
      </div>
    </div>
  );
}

function Proposals() {
  const [status, setStatus] = useState("proposed");
  const q = useOrg<{ proposals: any[] }>(`/proposals${status === "all" ? "" : `?status=${status}`}`);
  return (
    <Section title="مقترحات التحسين" action={<Filters value={status} onChange={setStatus} options={[{ key: "proposed", label: "تنتظر" }, { key: "applied", label: "مُطبَّقة" }, { key: "all", label: "الكل" }]} />}>
      <Q q={q} what="المقترحات">
        {(d) => list(d.proposals).length ? <div className="space-y-2">{list(d.proposals).map((p) => <ProposalCard key={p.change_id} p={p} />)}</div> : <Empty>لا مقترحات بهذا الفلتر.</Empty>}
      </Q>
    </Section>
  );
}

function Lessons() {
  const q = useOrg<{ lessons: any[] }>("/lessons/pending");
  const act = useOrgAction();
  return (
    <Section title="دروس تنتظر الاعتماد">
      <Q q={q} what="الدروس">
        {(d) => list(d.lessons).length ? (
          <div className="space-y-2">
            {list(d.lessons).map((l) => (
              <div key={l.id} className={cn(card, "p-3.5 space-y-2")}>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <b dir="ltr">{l.role}</b>
                  {l.kind && <span className={cn(pill, "border-border text-muted-foreground")} dir="ltr">{l.kind}</span>}
                  {l.topic && <span className="text-muted-foreground" dir="auto">{l.topic}</span>}
                  <span className="mr-auto text-[10px] text-muted-foreground">{ago(l.created_at)}</span>
                </div>
                <Field label="السبب"><p className="text-[11px] text-muted-foreground">كتبه نموذج من عمل الموظف، ولا يدخل تعليماته قبل اعتمادك.</p></Field>
                <Field label="الدليل"><p className="text-[11px] text-muted-foreground">تكرّر {num(l.times)} مرة.</p></Field>
                <div className="grid md:grid-cols-2 gap-2">
                  <Field label="القيمة الحالية"><Pre>ليس في تعليمات الموظف</Pre></Field>
                  <Field label="القيمة الجديدة"><Pre>{l.content}</Pre></Field>
                </div>
                <Field label="الأثر"><p className="text-xs">عند الاعتماد يدخل تعليمات <span dir="ltr">{l.role}</span> في نداءاته التالية.</p></Field>
                <div className="flex gap-2 flex-wrap">
                  <Confirm tone="primary" label="اعتماد" icon={<Check className="w-3 h-3" />} busy={act.isPending}
                    effect={<>سيدخل هذا الدرس تعليمات <span dir="ltr">{l.role}</span> ويؤثر في كل ما يكتبه بعده.</>}
                    onConfirm={() => act.mutate({ path: `/lessons/${l.id}/approve`, ok: "اعتُمد الدرس" })} />
                  <Confirm tone="ghost" label="رفض" icon={<X className="w-3 h-3" />} busy={act.isPending} effect="لن يدخل هذا الدرس أي تعليمات."
                    onConfirm={() => act.mutate({ path: `/lessons/${l.id}/reject`, ok: "رُفض الدرس" })} />
                </div>
              </div>
            ))}
          </div>
        ) : <Empty>لا دروس معلّقة.</Empty>}
      </Q>
    </Section>
  );
}

const releaseMsg = (d: any) => {
  const cancelled = Object.values(d?.cancelled ?? {}).reduce((a: number, b) => a + Number(b), 0);
  const still = Number(d?.stillHeld?.deadMission ?? 0) + Number(d?.stillHeld?.campaignInactive ?? 0);
  return `أُفرج عن ${num(d?.released)} · أُلغي ${num(cancelled)} · بقي ممسوكاً ${num(still)}`;
};

function Held() {
  const q = useOrg<any>("/queue-review");
  const act = useOrgAction();
  const INELIGIBLE: Record<string, string> = { replied: "ردّ صاحبها", opted_out: "طلب الإيقاف", bounced: "ارتدّ عنوانه", company_replied: "ردّت شركته" };
  return (
    <Section title="رسائل ممسوكة في طابور البريد">
      <Q q={q} what="مراجعة الطابور">
        {(d) => {
          const held = Number(d.heldStale ?? 0);
          const ineligible = Object.entries(d.ineligible ?? {}) as Array<[string, number]>;
          const bad = ineligible.reduce((a, [, v]) => a + Number(v), 0);
          const missions = list(d.byMission).filter((m) => Number(m.stale) > 0);
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <Stat label="في الطابور" value={d.total} hint={d.age?.oldest ? `أقدمها ${ago(d.age.oldest)}` : undefined} />
                <Stat label="ممسوكة ومؤهلة" value={d.heldStale} />
                <Stat label="مهمتها متروكة" value={d.heldDeadMission} hint="الإفراج لا يخرجها" />
                <Stat label="أُفرج عنها" value={d.released} />
              </div>
              <Field label="السبب"><p className="text-xs">انتظرت أكثر من أسبوع. لا تخرج وحدها حتى يُعاد تقييمها ويُفرج عنها.</p></Field>
              <Field label="الدليل: أعمار الطابور">
                <div className="flex gap-3 flex-wrap text-[11px] text-muted-foreground">
                  <span>دون ٧ أيام {num(d.age?.under7)}</span><span>٧ إلى ١٤ {num(d.age?.d7to14)}</span><span>١٤ إلى ٣٠ {num(d.age?.d14to30)}</span><span>فوق ٣٠ {num(d.age?.over30)}</span>
                </div>
                {bad > 0 && <p className="flex gap-3 flex-wrap text-[11px] text-muted-foreground mt-1">غير مؤهلة: {ineligible.map(([k, v]) => <span key={k}>{INELIGIBLE[k] ?? k} {num(v)}</span>)}</p>}
                {Number(d.duplicates?.companies) > 0 && <p className="text-[11px] text-muted-foreground mt-1">{num(d.duplicates.companies)} شركة لها أكثر من رسالة، بزيادة {num(d.duplicates.extraMessages)} رسالة.</p>}
              </Field>
              <div className="grid md:grid-cols-2 gap-2">
                <Field label="القيمة الحالية"><Pre>ممسوكة: لا تخرج</Pre></Field>
                <Field label="القيمة الجديدة"><Pre>تخرج بدورها من فلاتر المصرف كلها</Pre></Field>
              </div>
              <Field label="الأثر"><p className="text-xs">رسائل حقيقية تذهب إلى عملاء بعد انقطاع طويل. غير المؤهل منها يُلغى بسببه، وما مهمته متروكة أو حملته غير نشطة يبقى ممسوكاً.</p></Field>
              {missions.length > 0 && (
                <div className="divide-y divide-card-border">
                  {missions.map((m) => (
                    <div key={m.missionId ?? m.name} className="py-2 text-xs flex items-center gap-2 flex-wrap">
                      <b dir="auto">{m.name}</b>
                      <span className="text-muted-foreground">في الطابور {num(m.queued)} · قديمة {num(m.stale)} · غير مؤهلة {num(m.ineligible)}</span>
                      {m.status && m.status !== "active" && <span className={cn(pill, "border-border text-muted-foreground")}>مهمة متروكة</span>}
                      {m.missionId != null && m.status === "active" && (
                        <div className="mr-auto"><Confirm tone="primary" label="إفراج" icon={<Unlock className="w-3 h-3" />} busy={act.isPending}
                          effect={<>سيُعاد تقييم رسائل «{m.name}» القديمة ({num(m.stale)}) ويُرسل المؤهل منها إلى العملاء بدوره.</>}
                          onConfirm={() => act.mutate({ path: "/queue-review/release", body: { missionId: m.missionId }, ok: releaseMsg })} /></div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex gap-2 flex-wrap">
                <Confirm tone="primary" label="إفراج عن الكل" icon={<Unlock className="w-3 h-3" />} busy={act.isPending || !held}
                  effect={<>سيُعاد تقييم {num(held)} رسالة ممسوكة في الحساب كله، ويُرسل المؤهل منها إلى العملاء بدوره. لا يمكن استعادة ما خرج.</>}
                  onConfirm={() => act.mutate({ path: "/queue-review/release", body: {}, ok: releaseMsg })} />
                <Confirm label="إلغاء غير المؤهل" icon={<X className="w-3 h-3" />} busy={act.isPending || !bad}
                  effect={<>ستُلغى الرسائل الأقدم من أسبوع التي ردّ أصحابها أو طلبوا الإيقاف أو ارتدّت عناوينها أو ردّت شركاتهم، بسبب مكتوب لكل رسالة. ما دون الأسبوع لا يُمسّ.</>}
                  onConfirm={() => act.mutate({ path: "/queue-review/apply", ok: (r) => `أُلغي ${num(Object.values(r?.cancelled ?? {}).reduce((a: number, b) => a + Number(b), 0))}` })} />
              </div>
            </div>
          );
        }}
      </Q>
    </Section>
  );
}


const BULK_KIND: Record<string, string> = { proposal: "مقترح تعليمات", objection: "اعتراض", playbook: "كتيّب", task: "مهمة" };
const BULK_RESULT: Record<string, string> = { approved: "text-emerald-400", skipped: "text-muted-foreground", failed: "text-red-400" };
const BulkRows = ({ items }: { items: any[] }) => (
  <ul className="space-y-1 max-h-72 overflow-y-auto">
    {items.map((i) => (
      <li key={`${i.kind}:${i.id}`} className="flex gap-2 text-[11px] items-start">
        <span className={cn("w-14 flex-shrink-0", BULK_RESULT[i.result])}>{i.result === "approved" ? "يُعتمد" : i.result === "failed" ? "فشل" : "يُترك"}</span>
        <span className="w-24 flex-shrink-0 text-muted-foreground">{BULK_KIND[i.kind] ?? i.kind}</span>
        <b className="min-w-0 truncate" dir="ltr">{i.label}</b>
        <span className="mr-auto text-muted-foreground text-left" dir="auto">{i.why}</span>
      </li>
    ))}
  </ul>
);

/** «اعتماد كل المؤهل»: معاينة بلا تغيير، ثم تأكيدٌ يسرد ما سيحدث بالضبط، ثم النتيجة بنداً بنداً. */
function BulkApprove() {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<any>(null);
  const preview = useOrg<{ items: any[]; approved: number; skipped: number }>("/approvals/bulk", false, open);
  const act = useOrgAction();
  const items = list(preview.data?.items);
  const will = items.filter((i) => i.result === "approved");
  return (
    <Section title="اعتماد كل المؤهل" action={!open ? <button className={primary} onClick={() => { setResult(null); setOpen(true); }}><Check className="w-3 h-3" />اعتماد كل المؤهل</button> : undefined}>
      <p className="text-[11px] text-muted-foreground">يعتمد ما يجتاز بوابته فقط: تعليماتٌ لها عيّنة ظل سليمة في ٧ أيام بلا مخالفة، واعتراضاتٌ دليلها من المعرفة المعتمدة، ومهامٌ تنتظر موافقتك. لا يغيّر أوضاع الإرسال ولا المتابعة ولا التواصل ولا الحدود ولا الدروس.</p>
      {open && !result && (
        <Q q={preview} what="المعاينة">
          {() => (
            <div className="space-y-2">
              <BulkRows items={items} />
              {will.length === 0 ? <Empty>لا شيء مؤهل الآن.</Empty> : (
                <Confirm tone="primary" label={`اعتماد ${num(will.length)} بنداً`} icon={<Check className="w-3 h-3" />} busy={act.isPending}
                  effect={<>سيُعتمد بالضبط: {will.map((i) => `${BULK_KIND[i.kind] ?? i.kind} ${i.label}`).join("، ")}. مقترحات التعليمات تُفعَّل فوراً ويمكن إرجاعها، والمهام تدخل الطابور. ويُترك {num(items.length - will.length)} بنداً كما هو.</>}
                  onConfirm={() => act.mutate({ path: "/approvals/bulk", body: { confirm: true }, ok: (d) => `اعتُمد ${d?.approved ?? 0}، وتُرك ${d?.skipped ?? 0}` }, { onSuccess: (d) => setResult(d) })} />
              )}
              <button className={ghost} onClick={() => setOpen(false)}>إغلاق</button>
            </div>
          )}
        </Q>
      )}
      {result && (
        <div className="space-y-2">
          <p className="text-xs">النتيجة: اعتُمد {num(result.approved)}، تُرك {num(result.skipped)}{result.failed ? `، فشل ${num(result.failed)}` : ""}.</p>
          <BulkRows items={list(result.items)} />
          <button className={ghost} onClick={() => { setResult(null); setOpen(false); }}>إغلاق</button>
        </div>
      )}
    </Section>
  );
}

export default function ApprovalsTab() {
  const tasks = useOrg<{ tasks: any[] }>("/tasks?status=waiting_for_approval&limit=500");
  const count = list(tasks.data?.tasks).length;
  return (
    <div className="space-y-4">
      {count > 0 && (
        <div className={cn(card, "p-3 text-xs flex items-center gap-2")}>
          <span>{num(count)} مهمة تنتظر موافقتك.</span>
          <Link href="/org/tasks" className="mr-auto text-primary hover:underline">افتح المهام</Link>
        </div>
      )}
      <BulkApprove />
      <Proposals />
      <Lessons />
      <PersuasionLibrary />
      <Held />
    </div>
  );
}
