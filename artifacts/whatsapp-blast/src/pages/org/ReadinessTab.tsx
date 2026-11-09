// الجاهزية: كل عنصر بحالته وما يلزم فعله. الفتح لا يتصل بأحد؛ الفحص الحي بزر (SMTP وIMAP بلا إرسال).

import { useState } from "react";
import { Link } from "wouter";
import { ExternalLink, Loader2, Stethoscope } from "lucide-react";
import { cn } from "@/lib/utils";
import { Empty, Pill, Q, READINESS, Section, ago, card, ghost, list, num, pill, useOrg, dept, when } from "./shared";

/** الخادم يسمّي الوجهة باسمها المنطقي؛ هذه صفحاتها في الواجهة. وجهة غير معروفة لا تُفتح على صفحة خطأ. */
const PAGE: Record<string, string> = {
  "/org/controls": "/org/safety", "/org/queue": "/org/approvals", "/whatsapp": "/connect", "/profile": "/settings",
  "/accounts": "/email/accounts", "/email/senders": "/email/settings",
};
const pageOf = (i: { goto?: string | null; channel?: string }) => (i.goto === "/social" ? `/${i.channel}` : PAGE[i.goto ?? ""] ?? i.goto);

const GROUP: Record<string, string> = { org: "المنظّمة", email: "البريد", whatsapp: "واتساب", instagram: "إنستجرام", tiktok: "تيك توك", linkedin: "لينكدإن" };

export default function ReadinessTab() {
  const [verify, setVerify] = useState(false);
  const q = useOrg<any>(`/readiness${verify ? "?verify=1" : ""}`, false);
  const check = () => { if (verify) void q.refetch(); else setVerify(true); };
  return (
    <div className="space-y-4">
      <Q q={q} what="فحص الجاهزية">
        {(d) => {
          const items = list(d.items);
          const channels = [...new Set(items.map((i) => String(i.channel)))];
          const count = (s: string) => items.filter((i) => i.status === s).length;
          const li = items.find((i) => i.id === "linkedin.readiness");
          return (
            <>
              <div className={cn(card, "p-4 flex items-center gap-3 flex-wrap")}>
                <Pill map={READINESS} value={d.status} />
                <span className="text-xs text-muted-foreground">جاهز {num(count("READY"))} · محجوب {num(count("BLOCKED"))} · يحتاج اختباراً {num(count("NEEDS_TEST"))}</span>
                <span className="text-[10px] text-muted-foreground" title={when(d.checkedAt)}>{d.verified ? "فحص حي" : "بلا اتصال"} · {ago(d.checkedAt)}</span>
                <button className={cn(ghost, "mr-auto")} disabled={q.isFetching} onClick={check}>
                  {q.isFetching ? <Loader2 className="w-3 h-3 animate-spin" /> : <Stethoscope className="w-3 h-3" />} فحص حي (بلا إرسال)
                </button>
              </div>
              {li && (
                <div className={cn(card, "p-4 text-xs space-y-1 border-yellow-500/30")}>
                  <div className="flex items-center gap-2"><b>لينكدإن</b><span className={cn(pill, "border-yellow-500/30 bg-yellow-500/10 text-yellow-400")}>وضع الجاهزية</span></div>
                  <p className="text-muted-foreground" dir="auto">{li.detail}</p>
                  {li.action && <p dir="auto"><span className="text-muted-foreground">المطلوب: </span>{li.action}</p>}
                </div>
              )}
              {channels.map((c) => (
                <Section key={c} title={GROUP[c] ?? dept(c)}>
                  <div className="divide-y divide-card-border">
                    {items.filter((i) => i.channel === c).map((i) => (
                      <div key={i.id} className="py-2.5 text-xs space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <b dir="auto">{i.title}</b>
                          <Pill map={READINESS} value={i.status} />
                          <span className="text-[10px] text-muted-foreground font-mono" dir="ltr">{i.id}</span>
                        </div>
                        {i.detail && <p className="text-muted-foreground" dir="auto">{i.detail}</p>}
                        {(i.action || i.goto) && (
                          <div className="flex items-center gap-2 flex-wrap">
                            {i.action && <p dir="auto"><span className="text-muted-foreground">المطلوب: </span>{i.action}</p>}
                            {i.goto && <Link href={pageOf(i) ?? "/org/readiness"} className="inline-flex items-center gap-1 text-primary hover:underline"><ExternalLink className="w-3 h-3" /> افتح</Link>}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Section>
              ))}
              {!items.length && <div className={cn(card, "p-4")}><Empty>لا عناصر.</Empty></div>}
            </>
          );
        }}
      </Q>
    </div>
  );
}
