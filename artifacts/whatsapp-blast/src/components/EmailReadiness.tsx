// ── Before the first campaign ─────────────────────────────────────
// The owner (2026-11-02): «لما أجي أختار أعمل حملة جديدة بيظهر لي مشاكل».
// The builder opened on an account with no sender and no list, and said
// «احفظ وأطلق لـ ٠». What is missing is said here first, in order, each
// with the way to fix it on the spot — Gmail in one step, a list from Excel.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { toast } from "sonner";
import { CheckCircle2, Circle, ExternalLink, Loader2, Mail, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { api, input } from "@/components/AgentPanel";
import { useEmailLists } from "@/pages/EmailLists";

const card = "bg-card border border-card-border rounded-xl";
const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";

/** What stands between this account and a campaign; null when nothing does. */
export function useEmailReadiness() {
  const { data: ov } = useQuery<any>({ queryKey: ["email-overview"], queryFn: () => api("/api/email/overview") });
  const { data: lists = [] } = useEmailLists();
  const sendable = lists.reduce((t, l) => t + (l.sendable ?? 0), 0);
  const sender = !!ov?.configured;
  return { loaded: !!ov, sender, sendable, ready: sender && sendable > 0 };
}

/** Gmail in one step: the address and its app password; the server fills in the rest and tries it before saving. */
export function QuickGmail({ compact }: { compact?: boolean }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [name, setName] = useState("");
  const save = useMutation({
    mutationFn: () => api("/api/email/settings/quick-gmail", { method: "POST", body: JSON.stringify({ email, appPassword: pass, fromName: name || undefined }) }),
    onSuccess: () => {
      setPass("");
      ["email-overview", "email-settings"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      toast.success("تم ربط Gmail — جرّبنا الاتصال ونجح");
    },
    onError: (e: Error) => toast.error(e.message, { duration: 9000 }),
  });
  return (
    <div className={cn(!compact && card, !compact && "p-4", "space-y-3")}>
      {!compact && <p className="text-sm font-semibold flex items-center gap-2"><Mail className="w-4 h-4 text-primary" /> اربط Gmail بخطوة واحدة</p>}
      <ol className="text-[11px] text-muted-foreground space-y-0.5 list-decimal pr-4">
        <li>فعّل «التحقق بخطوتين» على حساب Google إن لم يكن مفعّلاً.</li>
        <li>افتح <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer" className="text-primary underline inline-flex items-center gap-0.5">كلمات مرور التطبيقات <ExternalLink className="w-3 h-3" /></a> وأنشئ واحدة باسم «Flow Hub».</li>
        <li>انسخ الحروف الـ16 هنا. لا تضع كلمة مرور حسابك نفسها.</li>
      </ol>
      <div className="grid md:grid-cols-3 gap-2">
        <input className={input} dir="ltr" placeholder="you@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className={input} dir="ltr" type="password" autoComplete="new-password" placeholder="xxxx xxxx xxxx xxxx" value={pass} onChange={(e) => setPass(e.target.value)} />
        <input className={input} placeholder="اسم المرسِل (اختياري — اسم نشاطك)" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => save.mutate()} disabled={!email.includes("@") || pass.replace(/\s/g, "").length < 8 || save.isPending} className={primary}>
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />} اربط وجرّب الاتصال
        </button>
        <p className="text-[10px] text-muted-foreground">يُضبط الباقي وحده: خادم Gmail، الحصة (٤٠ في الساعة، ٤٠٠ في اليوم — تحت حد Google)، اللغة، وهوية الرسائل من ملف نشاطك.</p>
      </div>
    </div>
  );
}

/** The steps to the first campaign, shown on the campaigns tab until both are done. */
export function EmailReadiness() {
  const r = useEmailReadiness();
  if (!r.loaded || r.ready) return null;
  const Step = ({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) => (
    <div className="flex gap-3">
      {done ? <CheckCircle2 className="w-5 h-5 text-primary shrink-0" /> : <Circle className="w-5 h-5 text-muted-foreground shrink-0" />}
      <div className="flex-1 space-y-2"><p className={cn("text-sm font-semibold", done && "text-muted-foreground line-through")}>{title}</p>{!done && children}</div>
    </div>
  );
  return (
    <div className={cn(card, "p-4 space-y-4 border-yellow-500/30")}>
      <p className="text-sm font-bold">قبل أول حملة — خطوتان</p>
      <Step done={r.sender} title="١. من أين تُرسل الإيميلات">
        <QuickGmail compact />
        <p className="text-[11px] text-muted-foreground">بريد على دومين نشاطك (Hostinger أو Microsoft أو Brevo)؟ <Link href="/email/settings" className="text-primary underline">من الإعدادات</Link>.</p>
      </Step>
      <Step done={r.sendable > 0} title="٢. لمن تُرسل — قائمة إيميلات">
        <p className="text-[11px] text-muted-foreground">ارفع ملف Excel أو CSV فيه عمود للإيميل (والاسم إن وُجد). يُنظَّف ويُفحص كل عنوان قبل أي إرسال.</p>
        <Link href="/email/import" className={cn(primary, "w-fit")}><Upload className="w-3.5 h-3.5" /> ارفع ملف الإيميلات</Link>
      </Step>
    </div>
  );
}
