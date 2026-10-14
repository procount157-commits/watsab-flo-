// ── صناديق الإرسال الإضافية ───────────────────────────────────────
// الإرسال يتوزّع على كل الصناديق: كل رسالةٍ تخرج من الأقل استهلاكاً
// لسقف يومه. لكلٍّ سقفه وتسخينه، ومن يرتدّ بريده يُمهَل وحده.
// كلمة المرور يكتبها صاحب العمل هنا، ولا تعود من الخادم أبداً.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Pause, Play, PlugZap, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";

const card = "bg-card border border-card-border rounded-xl";
const ghost = "flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs border border-card-border hover:border-primary/50 disabled:opacity-40";
const empty = { preset: "hostinger", fromEmail: "", fromName: "", smtpPass: "", dailyCap: 80, hourlyCap: 15, warmup: true };

export function EmailSenders({ primary, primaryCap }: { primary?: string | null; primaryCap?: number }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<any>({ queryKey: ["email-senders"], queryFn: () => api("/api/email/senders"), refetchInterval: 60_000 });
  const [f, setF] = useState<any>(null);
  const [newPass, setNewPass] = useState<Record<number, string>>({});
  const refresh = () => { qc.invalidateQueries({ queryKey: ["email-senders"] }); qc.invalidateQueries({ queryKey: ["email-overview"] }); };

  const add = useMutation({
    mutationFn: () => api("/api/email/senders", { method: "POST", body: JSON.stringify(f) }),
    onSuccess: (d: any) => { refresh(); setF(null); toast[d.check?.ok ? "success" : "error"](d.check?.ok ? "أُضيف الصندوق ونجح الدخول — دخل التدوير" : `أُضيف لكن الدخول فشل: ${d.check?.detail ?? ""}`); },
    onError: (e: Error) => toast.error(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: any }) => api(`/api/email/senders/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: (d: any) => { refresh(); d?.check ? toast[d.check.ok ? "success" : "error"](d.check.ok ? "نجح الدخول — دخل الصندوق التدوير" : `الدخول فشل: ${d.check.detail}`) : toast.success("حُفظ"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const test = useMutation({
    mutationFn: (id: number) => api(`/api/email/senders/${id}/test`, { method: "POST" }),
    onSuccess: (d: any) => { refresh(); toast[d.ok ? "success" : "error"](d.detail); }, onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: number) => api(`/api/email/senders/${id}`, { method: "DELETE" }),
    onSuccess: () => { refresh(); toast.success("حُذف الصندوق"); },
  });

  if (isLoading) return <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />;
  const senders: any[] = data?.senders ?? [];
  const presets: Record<string, any> = data?.presets ?? {};
  const live = senders.filter((s) => s.status === "active" && !s.held);
  const total = (primaryCap ?? 0) + live.reduce((a, s) => a + s.capToday, 0);

  return (
    <div className={cn(card, "p-4 space-y-3")}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <p className="text-sm font-semibold">صناديق الإرسال</p>
          <p className="text-xs text-muted-foreground">الإرسال يتوزّع على كل الصناديق بالتساوي. لكل صندوقٍ سقفه وتسخينه، ومن يرتدّ بريده يُمهَل وحده.</p>
        </div>
        <div className="text-xs bg-primary/10 text-primary rounded-lg px-3 py-1.5">سعة اليوم: <b>{total.toLocaleString("en")}</b> رسالة من {1 + live.length} صندوق</div>
      </div>

      <div className="divide-y divide-card-border border border-card-border rounded-lg">
        {primary && (
          <div className="flex items-center justify-between gap-2 p-3 text-sm">
            <span className="flex items-center gap-2"><Mail className="w-4 h-4 text-primary" /><span dir="ltr">{primary}</span><span className="text-[10px] px-1.5 py-0.5 rounded bg-muted">الأول — إعداداته أعلاه</span></span>
            {primaryCap != null && <span className="text-xs text-muted-foreground">سقف اليوم {primaryCap}</span>}
          </div>
        )}
        {senders.map((s) => (
          <div key={s.id} className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-2 flex-wrap text-sm">
              <span className="flex items-center gap-2">
                <span className={cn("w-2 h-2 rounded-full", !s.hasPassword ? "bg-muted-foreground" : s.status === "broken" ? "bg-red-500" : s.status === "paused" || s.held ? "bg-amber-500" : "bg-green-500")} />
                <span dir="ltr">{s.fromEmail}</span>
                <span className="text-[10px] text-muted-foreground">{presets[s.preset]?.label ?? s.smtpHost}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                اليوم {s.sentToday} / {s.capToday}{s.warmup && s.capToday < s.dailyCap ? ` · تسخين يوم ${s.ageDays + 1} حتى ${s.dailyCap}` : ""}
              </span>
            </div>
            {!s.hasPassword && <p className="text-xs text-amber-500">بانتظار كلمة المرور: اكتبها في الخانة أدناه واضغط «حفظ» — بعدها يدخل التدوير ويبدأ تسخينه.</p>}
            {s.status === "broken" && <p className="text-xs text-red-500">الدخول فشل: {s.heldReason} — اكتب كلمة المرور الصحيحة.</p>}
            {s.held && s.status === "active" && <p className="text-xs text-amber-500">مُمهَل: {s.heldReason}</p>}
            {s.imapLastError && <p className="text-[11px] text-muted-foreground">قراءة الوارد: {s.imapLastError}</p>}
            <div className="flex flex-wrap items-center gap-1.5">
              <input type="password" autoComplete="new-password" className={cn(input, "w-44 text-xs")} placeholder="كلمة مرور جديدة" value={newPass[s.id] ?? ""} onChange={(e) => setNewPass({ ...newPass, [s.id]: e.target.value })} dir="ltr" />
              <button className={ghost} disabled={!newPass[s.id]} onClick={() => { update.mutate({ id: s.id, body: { smtpPass: newPass[s.id] } }); setNewPass({ ...newPass, [s.id]: "" }); }}>حفظ</button>
              <button className={ghost} disabled={test.isPending} onClick={() => test.mutate(s.id)}><PlugZap className="w-3.5 h-3.5" />اختبار الدخول</button>
              {s.status === "paused"
                ? <button className={ghost} onClick={() => update.mutate({ id: s.id, body: { status: "active" } })}><Play className="w-3.5 h-3.5" />تشغيل</button>
                : <button className={ghost} onClick={() => update.mutate({ id: s.id, body: { status: "paused" } })}><Pause className="w-3.5 h-3.5" />إيقاف</button>}
              <label className="text-xs flex items-center gap-1">سقف اليوم
                <input type="number" min={1} max={2000} className={cn(input, "w-20 text-xs")} defaultValue={s.dailyCap} onBlur={(e) => Number(e.target.value) !== s.dailyCap && update.mutate({ id: s.id, body: { dailyCap: Number(e.target.value) } })} /></label>
              <button className={cn(ghost, "hover:border-red-500/50 hover:text-red-500")} onClick={() => confirm(`حذف ${s.fromEmail} من الإرسال؟ (الصندوق نفسه في Hostinger لا يُمس)`) && del.mutate(s.id)}><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        ))}
      </div>

      {f ? (
        <div className="border border-primary/30 bg-primary/5 rounded-lg p-3 space-y-3">
          <div className="grid md:grid-cols-3 gap-3">
            <div><label className="text-xs font-semibold block mb-1.5">المزوّد</label>
              <select className={input} value={f.preset} onChange={(e) => setF({ ...f, preset: e.target.value })}>
                {Object.entries(presets).map(([k, p]: any) => <option key={k} value={k}>{p.label}</option>)}
                <option value="custom">خادم آخر</option>
              </select></div>
            <div><label className="text-xs font-semibold block mb-1.5">الإيميل</label><input className={input} dir="ltr" placeholder="marketing@pro-count.ae" value={f.fromEmail} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></div>
            <div><label className="text-xs font-semibold block mb-1.5">كلمة مرور الصندوق</label><input type="password" autoComplete="new-password" className={input} dir="ltr" value={f.smtpPass} onChange={(e) => setF({ ...f, smtpPass: e.target.value })} /></div>
            <div><label className="text-xs font-semibold block mb-1.5">اسم المُرسِل (اختياري)</label><input className={input} placeholder="مثل الصندوق الأول" value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></div>
            <div><label className="text-xs font-semibold block mb-1.5">سقف اليوم</label><input type="number" className={input} value={f.dailyCap} onChange={(e) => setF({ ...f, dailyCap: Number(e.target.value) })} /></div>
            <div><label className="text-xs font-semibold block mb-1.5">سقف الساعة</label><input type="number" className={input} value={f.hourlyCap} onChange={(e) => setF({ ...f, hourlyCap: Number(e.target.value) })} /></div>
          </div>
          {f.preset === "custom" && (
            <div className="grid md:grid-cols-3 gap-3">
              <div><label className="text-xs font-semibold block mb-1.5">خادم SMTP</label><input className={input} dir="ltr" value={f.smtpHost ?? ""} onChange={(e) => setF({ ...f, smtpHost: e.target.value })} /></div>
              <div><label className="text-xs font-semibold block mb-1.5">المنفذ</label><input type="number" className={input} value={f.smtpPort ?? 587} onChange={(e) => setF({ ...f, smtpPort: Number(e.target.value) })} /></div>
              <div><label className="text-xs font-semibold block mb-1.5">خادم IMAP</label><input className={input} dir="ltr" value={f.imapHost ?? ""} onChange={(e) => setF({ ...f, imapHost: e.target.value })} /></div>
            </div>
          )}
          <label className="text-xs flex items-center gap-2"><input type="checkbox" checked={f.warmup} onChange={(e) => setF({ ...f, warmup: e.target.checked })} />تسخين: يبدأ بعشرين في اليوم ويزيد ١٥٪ يومياً حتى السقف</label>
          {f.preset === "google" && <p className="text-[11px] text-muted-foreground">Google: استعمل «كلمة مرور التطبيقات» من إعدادات حساب Google، لا كلمة الحساب نفسها.</p>}
          {f.preset === "microsoft" && <p className="text-[11px] text-muted-foreground">Microsoft 365: يجب أن يكون «SMTP AUTH» مفعّلاً للصندوق من لوحة المسؤول.</p>}
          <div className="flex gap-2">
            <button className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40" disabled={add.isPending || !f.fromEmail || !f.smtpPass} onClick={() => add.mutate()}>
              {add.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}أضف واختبر الدخول</button>
            <button className={ghost} onClick={() => setF(null)}>إلغاء</button>
          </div>
        </div>
      ) : (
        <button className={ghost} onClick={() => setF({ ...empty })}><Plus className="w-3.5 h-3.5" />أضف صندوق إرسال</button>
      )}
    </div>
  );
}
