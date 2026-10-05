// ── A social desk: Instagram, TikTok — the email section's shape ──
// One page per platform with the same tabs as email: the dashboard (autopilot,
// numbers, the team with each one's week and a box for instructions, the
// lists the team works, hot conversations, what the team did), then the work
// itself — comments, messages, first contacts, target lists, content — and the
// account. Every tab reads /api/social/:platform.

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRoute } from "wouter";
import { toast } from "sonner";
import {
  LayoutDashboard, MessageSquareText, Inbox, Send, ListChecks, Clapperboard, Settings2, Play, Power, Loader2, Flame,
  Users, ShieldCheck, MessageCircle, Target, AlertTriangle, Instagram, Music2, Linkedin,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/components/AgentPanel";
import { AgentCard } from "../EmailDashboard";
import { CommentsTab, InboxTab } from "./SocialConversations";
import { ListsTab, ListDetail, OutreachTab } from "./SocialTargets";
import { ContentTab } from "./SocialContent";
import { AccountTab } from "./SocialAccount";

export const card = "bg-card border border-card-border rounded-xl";
export const ghost = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs border border-card-border hover:border-primary/50 transition-colors disabled:opacity-40";
export const primary = "flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs bg-primary text-primary-foreground disabled:opacity-40";
export const n = (v?: number | null) => (v ?? 0).toLocaleString("ar-SA");
export const ago = (d?: string | null) => {
  if (!d) return "—";
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (m < 1) return "الآن"; if (m < 60) return `${m} د`; const h = Math.round(m / 60); return h < 24 ? `${h} س` : `${Math.round(h / 24)} يوم`;
};
export type Platform = "instagram" | "tiktok" | "linkedin";
export const PLATFORM_UI: Record<Platform, { label: string; icon: any; color: string; contact: string }> = {
  instagram: { label: "إنستجرام", icon: Instagram, color: "text-pink-400", contact: "رسالة خاصة" },
  tiktok:    { label: "تيك توك", icon: Music2, color: "text-cyan-400", contact: "رسالة خاصة" },
  linkedin:  { label: "لينكدإن", icon: Linkedin, color: "text-sky-400", contact: "دعوة اتصال ثم رسالة" },
};
export const STATE_AR: Record<string, [string, string]> = {
  logged_in: ["مسجّل دخول", "text-primary"], logged_out: ["خارج الجلسة", "text-yellow-400"], checkpoint: ["يطلب تأكيد الهوية", "text-red-400"],
  restricted: ["مقيَّد", "text-red-400"], unknown: ["لم يُفحص بعد", "text-muted-foreground"],
};

const TABS = [
  { key: "dashboard", label: "لوحة المتابعة", icon: LayoutDashboard },
  { key: "comments",  label: "التعليقات",      icon: MessageSquareText },
  { key: "inbox",     label: "الرسائل",        icon: Inbox },
  { key: "outreach",  label: "التواصل الأول",  icon: Send },
  { key: "lists",     label: "قوائم الاستهداف", icon: ListChecks },
  { key: "content",   label: "المحتوى",        icon: Clapperboard },
  { key: "account",   label: "الحساب والإعدادات", icon: Settings2 },
] as const;
type Tab = typeof TABS[number]["key"];

export function useDesk(p: Platform) {
  return useQuery<any>({ queryKey: ["social", p], queryFn: () => api(`/api/social/${p}`), refetchInterval: 20_000 });
}

export default function SocialDesk({ platform }: { platform: Platform }) {
  const [, params] = useRoute<{ tab?: string; id?: string }>(`/${platform}/:tab?/:id?`);
  const [, go] = useLocation();
  const tab = (TABS.find((t) => t.key === params?.tab)?.key ?? "dashboard") as Tab;
  const { data } = useDesk(platform);
  const ui = PLATFORM_UI[platform];
  const a = data?.account;
  const ap = data?.approvals ?? {};
  const badge: Partial<Record<Tab, number>> = { comments: ap.comments, inbox: ap.messages, outreach: ap.outreach, content: ap.content };

  return (
    <div className="p-6 space-y-5 max-w-[96rem]">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <h1 className="text-2xl font-bold flex items-center gap-2"><ui.icon className={cn("w-6 h-6", ui.color)} /> {ui.label}</h1>
          <p className="text-sm text-muted-foreground mt-1">فريق من ١٢ موظفاً يرد على التعليقات والرسائل، ويكتب أولاً لمن تختارهم في قوائمك، ويتابع مرة واحدة، وينشر — وكل ذلك داخل حدود يومية تحمي الحساب.</p>
        </div>
        {a && <div className="text-xs flex items-center gap-2 flex-wrap">
          <span className={cn("px-2.5 py-1 rounded-full border border-card-border", STATE_AR[a.state]?.[1])}>{STATE_AR[a.state]?.[0] ?? a.state}{a.username ? ` · @${a.username}` : ""}</span>
          {a.dryRun && <span className="px-2.5 py-1 rounded-full bg-yellow-500/15 text-yellow-400">وضع التجربة — لا يُرسل شيء</span>}
          {a.autopilot && <span className="px-2.5 py-1 rounded-full bg-primary/15 text-primary">الطيار الآلي يعمل</span>}
        </div>}
      </div>
      {data && !data.driven && <div className={cn(card, "p-3 text-xs border-yellow-500/40 text-yellow-400 flex gap-2")}><AlertTriangle className="w-4 h-4 shrink-0" /> الفريق والقوائم والمسودات جاهزة، لكن الإرسال على {ui.label} لم يُفعَّل في النظام بعد.</div>}

      <div className="flex gap-1 border-b border-card-border overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => go(`/${platform}/${t.key}`)} className={cn("flex items-center gap-1.5 px-3.5 py-2.5 text-sm border-b-2 -mb-px whitespace-nowrap", tab === t.key ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
            <t.icon className="w-4 h-4" /> {t.label}
            {!!badge[t.key] && <span className="text-[10px] px-1.5 rounded-full bg-yellow-500/20 text-yellow-400">{n(badge[t.key])}</span>}
          </button>
        ))}
      </div>

      {tab === "dashboard" && <Dashboard p={platform} />}
      {tab === "comments" && <CommentsTab p={platform} />}
      {tab === "inbox" && <InboxTab p={platform} />}
      {tab === "outreach" && <OutreachTab p={platform} />}
      {tab === "lists" && (params?.id ? <ListDetail p={platform} id={Number(params.id)} /> : <ListsTab p={platform} />)}
      {tab === "content" && <ContentTab p={platform} />}
      {tab === "account" && <AccountTab p={platform} />}
    </div>
  );
}

// ── Dashboard ────────────────────────────────────────────────────
function Dashboard({ p }: { p: Platform }) {
  const qc = useQueryClient();
  const [, go] = useLocation();
  const { data: d, isLoading } = useDesk(p);
  const inv = () => qc.invalidateQueries({ queryKey: ["social", p] });
  const set = useMutation({ mutationFn: (b: any) => api(`/api/social/${p}/settings`, { method: "PATCH", body: JSON.stringify(b) }), onSuccess: inv, onError: (e: Error) => toast.error(e.message) });
  const run = useMutation({ mutationFn: () => api(`/api/social/${p}/run`, { method: "POST" }), onSuccess: () => { toast.success("بدأت جولة — يمشي الفريق بإيقاع إنسان، فتظهر النتائج خلال دقائق"); setTimeout(inv, 20_000); }, onError: (e: Error) => toast.error(e.message) });
  if (isLoading || !d) return <div className={cn(card, "p-10 text-center")}><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const a = d.account, k = d.kpi ?? {}, caps = d.caps ?? {}, today = d.today ?? {};
  const listIds: number[] = a.listIds ?? [];

  return (
    <div className="space-y-4">
      <div className={cn(card, "p-4 space-y-3", a.autopilot && "border-primary/40")}>
        <div className="flex items-center gap-3 flex-wrap">
          <div className={cn("w-10 h-10 rounded-full flex items-center justify-center", a.autopilot ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}><Power className="w-5 h-5" /></div>
          <div className="flex-1 min-w-[14rem]">
            <p className="font-semibold">{a.autopilot ? "الطيار الآلي يعمل — جولة كل ٢٠ دقيقة" : "الطيار الآلي متوقف"}</p>
            <p className="text-xs text-muted-foreground">{a.mode === "auto" ? "يرسل ما يجيزه الحارس دون انتظارك" : "كل رد ورسالة تنتظر موافقتك"} · {a.dryRun ? "وضع التجربة: يكتب ولا يرسل" : "الإرسال الفعلي مفعّل"}{a.lastRunAt ? ` · آخر جولة ${ago(a.lastRunAt)}` : ""}</p>
          </div>
          <button onClick={() => run.mutate()} disabled={run.isPending || !d.driven} className={ghost}>{run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />} جولة الآن</button>
          <button onClick={() => set.mutate({ autopilot: !a.autopilot })} disabled={!d.driven} className={a.autopilot ? ghost : primary}>{a.autopilot ? "أوقف" : "شغّل الطيار الآلي"}</button>
        </div>
        <div className="flex gap-2 flex-wrap text-xs items-center">
          <span className="text-muted-foreground">القوائم التي يكتب لها الفريق:</span>
          {!d.lists?.length ? <button onClick={() => go(`/${p}/lists`)} className="text-primary underline">أنشئ قائمة استهداف أولاً</button>
            : d.lists.map((l: any) => {
              const on = listIds.includes(l.id);
              return <button key={l.id} onClick={() => set.mutate({ listIds: on ? listIds.filter((x) => x !== l.id) : [...listIds, l.id] })} className={cn("px-2.5 py-1 rounded-full border", on ? "border-primary bg-primary/15 text-primary" : "border-card-border text-muted-foreground")}>{on ? "✓ " : ""}{l.name} ({n(l.total)})</button>;
            })}
        </div>
      </div>

      {(d.approvals?.comments || d.approvals?.messages || d.approvals?.outreach || d.approvals?.content) ? (
        <div className={cn(card, "p-3.5 flex items-center gap-3 flex-wrap border-yellow-500/40")}>
          <p className="text-sm font-semibold">تنتظر موافقتك:</p>
          {([["comments", "رد على تعليق"], ["messages", "رد في الخاص", "inbox"], ["outreach", "رسالة أولى"], ["content", "منشور"]] as const).map(([k2, l, tab]) => d.approvals?.[k2] ? (
            <button key={k2} onClick={() => go(`/${p}/${tab ?? k2}`)} className="px-3 py-1.5 rounded-lg bg-yellow-500/10 text-yellow-400 text-xs">{n(d.approvals[k2])} {l}</button>
          ) : null)}
        </div>
      ) : null}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2">
        {[
          [MessageSquareText, "تعليقات", k.comments, `${n(k.replied)} رُدّ عليها`],
          [Target, "فرص من التعليقات", k.leads],
          [MessageCircle, "رسائل وصلتنا", k.received],
          [Send, "تواصلنا معهم", k.reached],
          [Users, "ردّوا علينا", k.answered, k.reached ? `${Math.round((k.answered / k.reached) * 100)}٪ من التواصل` : undefined],
          [Flame, "عملاء حارّون", k.hot],
          [ShieldCheck, "محاولات فشلت اليوم", d.fails, d.fails >= 5 ? "موقوف حتى المراجعة" : "الحد ٥"],
        ].map(([Icon, l, v, sub]: any) => (
          <div key={l} className={cn(card, "p-3")}><p className="text-[10px] text-muted-foreground flex items-center gap-1"><Icon className="w-3 h-3" /> {l}</p><p className="text-xl font-bold leading-none mt-1.5">{n(v)}</p>{sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}</div>
        ))}
      </div>

      <div className={cn(card, "p-3.5")}>
        <p className="text-xs font-semibold mb-2">ميزانية اليوم (آخر ٢٤ ساعة)</p>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {([["reply", "ردود علنية"], ["dm", "ردود خاصة"], ["outreach", d.firstContact === "connect" ? "دعوات اتصال" : "رسائل أولى"], ["followup", "متابعات"], ["post", "منشورات"], ["engage", "تعليقات تفاعلية"]] as const).map(([key, l]) => {
            const used = today[key] ?? 0, cap = caps[key] ?? 0, pct = cap ? Math.min(100, (used / cap) * 100) : 0;
            return <div key={key}><div className="flex justify-between text-[10px] text-muted-foreground"><span>{l}</span><span>{n(used)}/{n(cap)}</span></div><div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden"><div className={cn("h-full rounded-full", pct >= 100 ? "bg-red-400" : "bg-primary")} style={{ width: `${pct}%` }} /></div></div>;
          })}
        </div>
      </div>

      <div className={card}>
        <div className="p-3.5 border-b border-card-border flex items-center gap-2"><Users className="w-4 h-4 text-primary" /><p className="font-semibold text-sm">فريق {PLATFORM_UI[p].label}</p><span className="text-[11px] text-muted-foreground">اكتب لأي موظف تعليمات يلتزم بها من الآن</span></div>
        <div className="grid md:grid-cols-3 xl:grid-cols-4 divide-y md:divide-y-0 divide-card-border">{(d.team ?? []).map((t: any) => <div key={t.role} className="border-card-border md:border-b md:border-l"><AgentCard t={t} /></div>)}</div>
      </div>

      <div className="grid lg:grid-cols-[1fr_24rem] gap-4 items-start">
        <div className="space-y-4">
          <div className={card}>
            <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><ListChecks className="w-4 h-4 text-primary" /> قوائم الاستهداف</p></div>
            {!d.lists?.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا قوائم بعد — ابحث في {PLATFORM_UI[p].label} أو ارفع ملفاً من تبويب «قوائم الاستهداف».</p>
              : <div className="divide-y divide-card-border">{d.lists.map((l: any) => (
                <button key={l.id} onClick={() => go(`/${p}/lists/${l.id}`)} className="w-full text-right p-3.5 hover:bg-muted/20 space-y-2">
                  <div className="flex items-center gap-2"><p className="text-sm font-medium flex-1">{l.name}</p>{listIds.includes(l.id) && <span className="text-[10px] px-2 rounded-full bg-primary/15 text-primary">يعمل عليها الفريق</span>}</div>
                  <div className="grid grid-cols-5 gap-1 text-center">
                    {[["في القائمة", l.total], ["تنتظر موافقة", l.queued], ["تواصلنا", l.reached], ["ردّوا", l.replied], ["خارج المسار", l.dropped]].map(([lb, v]: any, i) => (
                      <div key={lb} className={cn("rounded-md py-1.5", i === 3 ? "bg-primary/10" : "bg-muted/40")}><p className="text-sm font-bold">{n(v)}</p><p className="text-[9px] text-muted-foreground">{lb}</p></div>
                    ))}
                  </div>
                </button>
              ))}</div>}
          </div>
          <div className={card}>
            <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><Flame className="w-4 h-4 text-orange-400" /> محادثات حارّة ودافئة</p></div>
            {!d.hot?.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا شيء بعد — تظهر هنا المحادثات التي صنّفها الفريق حارة أو دافئة.</p>
              : <div className="divide-y divide-card-border">{d.hot.map((t: any) => (
                <button key={t.id} onClick={() => go(`/${p}/inbox/${t.id}`)} className="w-full text-right p-3 flex items-center gap-2 text-xs hover:bg-muted/20">
                  <span>{t.temperature === "hot" ? "🔥" : "🌤"}</span><b>@{t.handle}</b><span className="text-muted-foreground">{t.origin === "outreach" ? "ردّ على تواصلنا" : "راسلنا"}</span><span className="mr-auto text-muted-foreground">{ago(t.lastMessageAt)}</span>
                </button>
              ))}</div>}
          </div>
        </div>
        <div className={cn(card, "lg:sticky lg:top-4")}>
          <div className="p-3.5 border-b border-card-border"><p className="font-semibold text-sm flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-primary" /> ما فعله الفريق</p></div>
          <div className="max-h-[42rem] overflow-y-auto divide-y divide-card-border">
            {!d.activity?.length ? <p className="p-6 text-center text-xs text-muted-foreground">لا شيء بعد — سجّل الدخول من «الحساب» ثم شغّل جولة.</p>
              : d.activity.map((x: any) => {
                const who = (d.team ?? []).find((t: any) => t.role === x.role);
                return <div key={x.id} className="p-3 flex gap-2.5 text-xs"><span className="text-base leading-none">{who?.avatar ?? "🤖"}</span><div className="min-w-0"><p className="leading-relaxed"><b>{who?.name ?? x.role}</b> <span className="text-muted-foreground">{x.text}</span></p><p className="text-[10px] text-muted-foreground/70 mt-0.5">{ago(x.createdAt)}</p></div></div>;
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
