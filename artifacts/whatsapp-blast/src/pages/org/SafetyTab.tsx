// الأمان: مفاتيح الإيقاف بحالتها الحالية، وسجلّ ما جرى. كل تغيير بسبب وتأكيد يسمّي أثره.
// المنصة كلها للمدير وحده (PUT /controls يرفضها لغيره أيضاً).

import { useState } from "react";
import { Power, PowerOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { CHANNEL, Confirm, DEPARTMENT, Empty, Filters, Q, Section, ago, dept, field, list, num, pill, show, useOrg, useOrgAction, when } from "./shared";

type Control = { id: number; scope: string; user_id: number | null; target: string; engaged: boolean; reason: string | null; set_by: number | null; set_at: string };
const SCOPE_AR: Record<string, string> = { global: "المنصة كلها", account: "الحساب", department: "قسم", employee: "موظف", channel: "قناة" };

function Row({ scope, target, label, effect, controls, isAdmin }: { scope: string; target: string; label: string; effect: string; controls: Control[]; isAdmin?: boolean }) {
  const act = useOrgAction();
  const here = controls.filter((c) => c.scope === scope && c.target === target);
  const platform = here.find((c) => c.user_id == null && c.engaged);
  const mine = scope === "global" ? here.find((c) => c.engaged) : here.find((c) => c.user_id != null && c.engaged);
  const on = mine ?? platform;
  // مفتاح عام (بلا حساب) لا يفكّه إلا المدير، وبطلب صريح على مستوى المنصة.
  const releasesPlatform = !mine && !!platform && !!isAdmin;
  const put = (engaged: boolean, reason: string) => act.mutate({
    path: "/controls", method: "PUT", body: { scope, target, engaged, reason: reason || undefined, ...(releasesPlatform ? { platformWide: true } : {}) },
    ok: engaged ? `أُوقف: ${label}` : `أُعيد تشغيل: ${label}`,
  });
  return (
    <div className="flex items-center gap-2 flex-wrap border-t border-card-border pt-2 first:border-t-0 first:pt-0">
      <span className="text-xs font-medium">{label}</span>
      <span className={cn(pill, on ? "border-red-500/40 bg-red-500/10 text-red-400" : "border-green-500/30 bg-green-500/10 text-green-400")}>{on ? "موقوف" : "يعمل"}</span>
      {on?.reason && <span className="text-[11px] text-muted-foreground" dir="auto">{on.reason}</span>}
      {on && <span className="text-[10px] text-muted-foreground" title={when(on.set_at)}>{ago(on.set_at)}</span>}
      {platform && !mine && scope !== "global" && <span className="text-[10px] text-muted-foreground">مفتاح عام من المدير</span>}
      <div className={cn("mr-auto", act.isPending && "opacity-60")}>
        {mine || releasesPlatform
          ? <Confirm tone="primary" label="إعادة التشغيل" icon={<Power className="w-3 h-3" />} reason busy={act.isPending}
              effect={`سيعود العمل فوراً في: ${label}. ما كان ممسوكاً بهذا المفتاح يخرج بدوره.`} onConfirm={(r) => put(false, r)} />
          : !platform && <Confirm label="إيقاف" icon={<PowerOff className="w-3 h-3" />} reason requireReason busy={act.isPending}
              effect={effect} onConfirm={(r) => put(true, r)} />}
      </div>
    </div>
  );
}

function AuditLog({ isAdmin }: { isAdmin: boolean }) {
  const [all, setAll] = useState("mine");
  const [text, setText] = useState("");
  const q = useOrg<{ audit: any[] }>(`/audit?limit=200${all === "all" ? "&all=1" : ""}`);
  return (
    <Section title="سجلّ التدقيق" action={isAdmin ? <Filters value={all} onChange={setAll} options={[{ key: "mine", label: "حسابي" }, { key: "all", label: "كل الحسابات" }]} /> : undefined}>
      <input className={cn(field, "w-full")} placeholder="بحث في الفعل أو السبب أو الدور" value={text} onChange={(e) => setText(e.target.value)} />
      <Q q={q} what="السجل">
        {(d) => {
          const t = text.trim().toLowerCase();
          const rows = list(d.audit).filter((r) => !t || `${r.action} ${r.why ?? ""} ${r.role ?? ""} ${r.kind ?? ""} ${r.recipient ?? ""}`.toLowerCase().includes(t));
          if (!rows.length) return <Empty>لا سطور.</Empty>;
          return (
            <div className="divide-y divide-card-border max-h-[32rem] overflow-y-auto">
              {rows.map((r) => (
                <div key={r.id} className="py-2 text-xs space-y-0.5">
                  <div className="flex gap-2 flex-wrap text-[10px] text-muted-foreground items-center">
                    <span className="px-1.5 rounded bg-muted font-mono" dir="ltr">{r.action}</span>
                    {r.scope && <span>{SCOPE_AR[r.scope] ?? r.scope}</span>}
                    {r.channel && <span>{CHANNEL[r.channel] ?? r.channel}</span>}
                    {r.kind && <span dir="ltr">{r.kind}</span>}
                    {r.role && <span dir="ltr">{r.role}</span>}
                    {r.recipient && <span dir="ltr">{r.recipient}</span>}
                    {Number(r.count) > 1 && <span>×{num(r.count)}</span>}
                    {all === "all" && <span>حساب {r.user_id ?? "المنصة"}</span>}
                    <span className="mr-auto">{when(r.created_at)}</span>
                  </div>
                  {r.why && <p className="text-foreground/90 whitespace-pre-wrap" dir="auto">{r.why}</p>}
                  {r.meta && <details><summary className="text-[10px] text-muted-foreground cursor-pointer">التفاصيل</summary><pre className="text-[10px] whitespace-pre-wrap break-all text-muted-foreground" dir="ltr">{show(r.meta)}</pre></details>}
                </div>
              ))}
            </div>
          );
        }}
      </Q>
    </Section>
  );
}

function EmployeeSwitches({ controls, isAdmin }: { controls: Control[]; isAdmin: boolean }) {
  const inv = useOrg<{ employees: any[] }>("/inventory", 60_000);
  const [key, setKey] = useState("");
  return (
    <Section title="إيقاف موظف">
      <Q q={inv} what="الموظفون">
        {(d) => {
          const staff = list(d.employees);
          const picked = staff.find((e) => e.key === key);
          const engaged = controls.filter((c) => c.scope === "employee" && c.engaged);
          const nameOf = (t: string) => { const e = staff.find((x) => x.key === t || x.role === t); return e ? `${e.name} (${dept(e.department)})` : t; };
          return (
            <div className="space-y-2">
              <select className={cn(field, "w-full max-w-md")} value={key} onChange={(e) => setKey(e.target.value)}>
                <option value="">اختر موظفاً…</option>
                {staff.map((e) => <option key={e.key} value={e.key}>{e.name} · {dept(e.department)} · {e.key}</option>)}
              </select>
              {picked && <Row scope="employee" target={picked.key} label={`${picked.name} · ${dept(picked.department)}`} controls={controls} isAdmin={isAdmin}
                effect={`لن ينفّذ ${picked.name} (${picked.key}) أي جولة أو نداء نموذج أو إرسال حتى تعيد تشغيله.`} />}
              {engaged.filter((c) => c.target !== key).map((c) => (
                <Row key={c.id} scope="employee" target={c.target} label={nameOf(c.target)} controls={controls} isAdmin={isAdmin} effect="" />
              ))}
              {!engaged.length && !picked && <Empty>لا موظف موقوف بمفتاح.</Empty>}
            </div>
          );
        }}
      </Q>
    </Section>
  );
}

const WORKER: Record<string, { label: string; cls: string }> = {
  ok: { label: "سليم", cls: "text-emerald-400 border-emerald-500/30" },
  failing: { label: "آخر دقّة فشلت", cls: "text-amber-400 border-amber-500/30" },
  stuck: { label: "عالق", cls: "text-red-400 border-red-500/30" },
  waiting: { label: "لم يحن موعده", cls: "text-muted-foreground border-card-border" },
};

/** الحلقات المتكررة في عملية الخادم (worker_registry): عالقة إن مرّ ثلاثة أضعاف فاصلها بلا دقّة. */
function WorkersHealth({ w }: { w: any }) {
  if (!w) return null;
  const rows = list(w.workers).sort((a, b) => ["stuck", "failing", "waiting", "ok"].indexOf(a.health) - ["stuck", "failing", "waiting", "ok"].indexOf(b.health));
  return (
    <Section title={`العمّال المتكررون — ${num(w.ok)} سليم · ${num(w.failing)} فاشل · ${num(w.stuck)} عالق`}>
      {!rows.length ? <Empty>لم يسجّل عاملٌ بعد في هذه العملية.</Empty> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground"><tr><th className="text-right py-1">العامل</th><th className="text-right">الحال</th><th className="text-right">الفاصل</th><th className="text-right">آخر دقّة</th><th className="text-right">الدقّات</th><th className="text-right">آخر خطأ</th></tr></thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.name} className="border-t border-card-border">
                  <td className="py-1" dir="ltr">{x.name}</td>
                  <td><span className={cn(pill, WORKER[x.health]?.cls)}>{WORKER[x.health]?.label ?? x.health}</span></td>
                  <td>{num(x.intervalSec)} ث</td>
                  <td>{x.lastTickAt ? ago(x.lastTickAt) : "—"}</td>
                  <td>{num(x.ticks)}{x.errors ? ` (${num(x.errors)} خطأ)` : ""}</td>
                  <td className="max-w-[16rem] truncate" dir="auto" title={x.lastError ?? ""}>{x.lastError ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

export default function SafetyTab() {
  const q = useOrg<{ controls: Control[]; isAdmin: boolean }>("/controls", 20_000);
  const inv = useOrg<{ employees: any[]; workers?: any }>("/inventory", 60_000);
  return (
    <div className="space-y-4">
      <Q q={q} what="المفاتيح">
        {(d) => {
          const controls = list(d.controls) as Control[];
          const isAdmin = !!d.isAdmin;
          const fromInv = list(inv.data?.employees).map((e) => String(e.department));
          const fromRows = controls.filter((c) => c.scope === "department").map((c) => c.target);
          const departments = [...new Set([...Object.keys(DEPARTMENT).filter((k) => k !== "social"), ...fromInv, ...fromRows])];
          return (
            <>
              <Section title="الحساب والمنصة">
                {!isAdmin && controls.some((c) => c.scope === "global" && c.engaged) && (
                  <p className="text-xs text-red-400">المنصة كلها موقوفة من المدير: {controls.find((c) => c.scope === "global" && c.engaged)?.reason ?? "بلا سبب مذكور"}</p>
                )}
                {isAdmin && <Row scope="global" target="" label="المنصة كلها (كل الحسابات)" controls={controls}
                  effect="سيتوقف كل إرسال وكل نداء نموذج وكل جولة عامل لكل الحسابات على المنصة، فوراً." />}
                <Row scope="account" target="" label="حسابي كله" controls={controls}
                  effect="سيتوقف كل موظفي هذا الحساب وكل قنواته عن الإرسال ونداء النماذج، فوراً." />
              </Section>
              <Section title="القنوات">
                {Object.entries(CHANNEL).map(([k, label]) => (
                  <Row key={k} scope="channel" target={k} label={label} controls={controls} isAdmin={isAdmin} effect={`لن يخرج أي شيء عبر ${label} من هذا الحساب، أيّاً كان مرسله، حتى تعيد تشغيلها.`} />
                ))}
              </Section>
              <Section title="الأقسام">
                {departments.map((k) => (
                  <Row key={k} scope="department" target={k} label={dept(k)} controls={controls} isAdmin={isAdmin} effect={`سيتوقف كل موظفي قسم ${dept(k)} عن الجولات والنماذج والإرسال حتى تعيد تشغيله.`} />
                ))}
              </Section>
              <EmployeeSwitches controls={controls} isAdmin={isAdmin} />
              <WorkersHealth w={inv.data?.workers} />
              <AuditLog isAdmin={isAdmin} />
            </>
          );
        }}
      </Q>
    </div>
  );
}
