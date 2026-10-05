// ── The path every campaign follows ───────────────────────────────
// One picture of what happens after "send": the first email with its subject
// test and the open-rate checkpoint, then the follow-ups of the chosen
// intensity — the first one split by what the person did, the rest to everyone
// who has not replied — and what stops each person's path. With a mission's
// report, each step carries its own numbers.

import { cn } from "@/lib/utils";

const KIND: Record<string, { title: string; detail: string }> = {
  value: { title: "معلومة مفيدة", detail: "معلومة حقيقية من معرفة الشركة لقطاعه، ودعوة هادئة." },
  angle: { title: "زاوية جديدة", detail: "مشكلة أو خدمة لم تُذكر بعد، وسؤال واحد سهل." },
  bump: { title: "تذكير قصير", detail: "سطران بصوت إنسان، وسؤال نعم/لا." },
  breakup: { title: "الرسالة الأخيرة", detail: "تغلق الموضوع وتترك الباب مفتوحاً. لا رسائل بعدها." },
};
const AR_DIGITS = (n: number) => n.toLocaleString("ar-SA");
type Stage = { stage: string; sent: number; opened: number; replied: number; openRate: number };
type Step = { kind: string; day: number };

export function EmailFlow({ stages, tracking, compact, steps, firstAfterHours = 72 }: { stages?: Stage[]; tracking?: boolean; compact?: boolean; steps?: Step[]; firstAfterHours?: number }) {
  const path: Step[] = steps ?? [{ kind: "value", day: 7 }, { kind: "breakup", day: 14 }];
  const by = (k: string) => stages?.find((s) => s.stage === k);
  const nums = (keys: Array<[string, string]>) => {
    const rows = keys.map(([k, l]) => [by(k), l] as const).filter(([r]) => r) as Array<[Stage, string]>;
    if (!rows.length) return null;
    return rows.map(([r, l]) => <span key={r.stage} className="block text-[10px] text-muted-foreground">{keys.length > 1 ? `${l}: ` : ""}أُرسل {r.sent}{tracking ? ` · فتح ${r.openRate}%` : ""} · ردّ {r.replied}</span>);
  };
  const cards = [
    { n: 1, day: "اليوم ٠", title: "الرسالة الأولى", detail: "عنوانان يُختبران على ٢٠٪. بعد يوم يُقرأ الفتح: ١٥٪ فأكثر ← الفائز للباقي؛ أقل ← يتوقف الباقي ويُعاد كتابة العنوان على عينة جديدة.", keys: [["first", ""]] as Array<[string, string]> },
    { n: 2, day: `اليوم ${AR_DIGITS(Math.round(firstAfterHours / 24))}`, title: "المتابعة الأولى", detail: "فتح ولم يرد ← زاوية جديدة وسؤال · لم يفتح ← نفس العرض أقصر بعنوان مختلف.", keys: [["warm", "فتح"], ["cold", "لم يفتح"]] as Array<[string, string]> },
    ...path.map((st, i) => ({ n: i + 3, day: `اليوم ${AR_DIGITS(st.day)}`, title: KIND[st.kind]?.title ?? st.kind, detail: KIND[st.kind]?.detail ?? "", keys: [[`step${i + 1}`, ""]] as Array<[string, string]> })),
  ];
  return (
    <div className={cn("space-y-2", compact && "text-xs")}>
      <div className={cn("grid gap-2", cards.length > 4 ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-6" : "grid-cols-2 md:grid-cols-4")}>
        {cards.map((c) => (
          <div key={c.n} className="rounded-lg border border-card-border bg-background/40 p-3">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-primary/15 text-primary text-xs font-bold flex items-center justify-center shrink-0">{c.n}</span>
              <div><p className="text-[10px] text-muted-foreground">{c.day}</p><p className="text-xs font-semibold">{c.title}</p></div>
            </div>
            {!compact && <p className="text-[10.5px] text-muted-foreground mt-2 leading-relaxed">{c.detail}</p>}
            <div className="mt-1.5">{nums(c.keys)}</div>
          </div>
        ))}
      </div>
      <p className="text-[10.5px] text-muted-foreground">يتوقف المسار لأي شخص فور أن <b className="text-foreground">يرد</b> أو <b className="text-foreground">يلغي الاشتراك</b> أو <b className="text-foreground">يرتد بريده</b>.{tracking === false ? " ⚠️ الفتح لا يُقاس الآن، فالجميع يُعامل كمن «لم يفتح» ونقطة الفحص بعد اليوم الأول معطّلة حتى يُفعّل التتبع." : ""}</p>
    </div>
  );
}
