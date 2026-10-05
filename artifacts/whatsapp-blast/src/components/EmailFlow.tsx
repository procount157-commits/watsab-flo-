// ── The path every campaign follows ───────────────────────────────
// One picture of what happens after "send", so the owner never has to guess:
// the first email with its subject test and the open-rate checkpoint, then
// the three follow-ups on days 3, 7 and 14 — and what stops each person's
// path. With a mission's report, each step carries its own numbers.

import { cn } from "@/lib/utils";

const STEPS = [
  { key: "first", day: "اليوم ٠", title: "الرسالة الأولى", detail: "عنوانان يُختبران على ٢٠٪ من الجمهور. بعد يوم يُقرأ الفتح:", branches: ["فتح ١٥٪ فأكثر ← العنوان الفائز للباقي", "أقل من ١٥٪ ← يتوقف الباقي، وتكتب نورة عنوانين جديدين لعينة جديدة (مرتان)، ثم ينبّهك ماجد أنها مشكلة تسليم"] },
  { key: "day3", day: "اليوم ٣", title: "المتابعة الأولى", detail: "بحسب ما فعله:", branches: ["فتح ولم يرد ← زاوية ألم جديدة + سؤال واحد", "لم يفتح ← نفس العرض أقصر، بعنوان مختلف تماماً"] },
  { key: "value", day: "اليوم ٧", title: "معلومة مفيدة", detail: "لكل من لم يرد: معلومة حقيقية من معرفة الشركة لقطاعه، ودعوة هادئة." },
  { key: "breakup", day: "اليوم ١٤", title: "الرسالة الأخيرة", detail: "سطران يغلقان الموضوع ويتركان الباب مفتوحاً. لا رسائل بعدها." },
];
const LBL: Record<string, string> = { first: "الأولى", warm: "فتح ولم يرد", cold: "لم يفتح", value: "معلومة", breakup: "الأخيرة" };

type Stage = { stage: string; sent: number; opened: number; replied: number; openRate: number };

export function EmailFlow({ stages, tracking, compact }: { stages?: Stage[]; tracking?: boolean; compact?: boolean }) {
  const by = (k: string) => stages?.find((s) => s.stage === k);
  const numbers = (keys: string[]) => {
    const rows = keys.map(by).filter(Boolean) as Stage[];
    if (!rows.length) return null;
    return rows.map((r) => (
      <span key={r.stage} className="block text-[10px] text-muted-foreground">{keys.length > 1 ? `${LBL[r.stage]}: ` : ""}أُرسل {r.sent}{tracking ? ` · فتح ${r.openRate}%` : ""} · ردّ {r.replied}</span>
    ));
  };
  return (
    <div className={cn("space-y-2", compact && "text-xs")}>
      <div className={cn("grid gap-2", compact ? "grid-cols-2 lg:grid-cols-4" : "md:grid-cols-4")}>
        {STEPS.map((s, i) => (
          <div key={s.key} className="relative rounded-lg border border-card-border bg-background/40 p-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center">{i + 1}</span>
              <div><p className="text-[10px] text-muted-foreground">{s.day}</p><p className="text-xs font-semibold">{s.title}</p></div>
            </div>
            {!compact && <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">{s.detail}</p>}
            {!compact && s.branches && <ul className="mt-1.5 space-y-1">{s.branches.map((b) => <li key={b} className="text-[10.5px] text-muted-foreground leading-relaxed">• {b}</li>)}</ul>}
            <div className="mt-2">{numbers(s.key === "day3" ? ["warm", "cold"] : [s.key])}</div>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-muted-foreground">يتوقف المسار لأي شخص فور أن <b className="text-foreground">يرد</b> أو <b className="text-foreground">يلغي الاشتراك</b> أو <b className="text-foreground">يرتد بريده</b> — ولا يتجاوز ٤ رسائل. كل الإيميلات بالإنجليزية.{tracking === false ? " ⚠️ الفتح لا يُقاس الآن، فالجميع يُعامل كمن «لم يفتح» ونقطة الفحص بعد اليوم الأول معطّلة حتى يُفعّل التتبع." : ""}</p>
    </div>
  );
}
