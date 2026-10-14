// ── شمّة: مديرة مكتب الواتساب، وحلقتها ────────────────────────────
// مكتب البريد له مديرٌ بحلقةٍ ومحلّل (منصور وجاسم)، ومكتب الواتساب كان
// له مديرةٌ تستقبل التقارير ولا تفعل بها شيئاً: مئةٌ وخمسة وثلاثون
// تنبيهاً من فهد، وواحدٌ وثلاثون تقريراً من هال، وأربع توجيهاتٍ منها في
// شهر. طلب صاحب العمل: مديرٌ «يديهم المهام، ويراجع وراهم، ويقيّم شغلهم».
//
// والحلقة كود، كحلقة منصور: كل خطوةٍ حسابٌ أو قاعدة ونتيجتها رقم،
// والنموذج يُستدعى مرةً واحدة — ليكتب التقرير من الوقائع — ولا يملك أن
// يُرسل لعميل ولا أن يُطلق حملة.
//
// الدورة، كل ست ساعات:
//   ١ · الفريق     الناقص يُذكر، والموقوف يُذكر بأثره
//   ٢ · البيانات   سالم ينظّف القوائم وريم تصنّفها (مكتب البيانات)
//   ٣ · النتائج    كل حملةٍ وقطاعٍ ومسار: من وصلته، من ردّ، من طلب الإيقاف
//   ٤ · التقييم    درجةٌ لكل موظف من أرقامه، ومهمةٌ تصله رسالةً
//   ٥ · المراجعة   هل تحرّكت درجة من أُعطي مهمةً في الدورة السابقة
//   ٦ · التقرير    مرةً في اليوم لصاحب العمل
//
// وما لا تفعله: لا تُطلق حملة، ولا تشغّل المتابعة الحيّة، ولا ترفع حدّاً.
// هذه بيد صاحب العمل وفهد، والحظر على واتساب لا يُصلَح باعتذار.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db, botEmployeesTable, businessProfileTable, contactGroupsTable } from "@workspace/db";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { corePrompt } from "./prompt-core";
import { notify, esc } from "./telegram";
import { say } from "./agent-comms";
import { receipt } from "./graph/receipts";
import { logger } from "./logger";
import { runDeskAll, type DeskReport } from "./data-desk/desk";
import { bucketOf, BUCKET_AR, targetsBrief, type Bucket } from "./data-desk/classify";
import { evaluateDesk, evaluationFacts, type Evaluation } from "./team/evaluate";

export const WA_MANAGER_ROLE = "chief";
/** من تُديرهم — ومن يغيب منهم يُذكر بأثره لا باسمه. */
export const WA_TEAM: Record<string, string> = {
  sales: "لا أحد يردّ على من يكتب لنا",
  followup: "لا أحد يتابع من تكلّم ثم سكت — وأغلب الصفقات تأتي من المتابعة",
  support: "لا أحد يجيب أسئلة العملاء الحاليين",
  intake: "لا أحد ينظّف القوائم ويُخرج من طلب الإيقاف",
  collector: "لا أحد يصنّف الجهات ولا يقرأ المحادثات",
  ops: "لا أحد يراقب علامات الحظر وحدود الإرسال",
  monitor: "لا أحد يراقب صحة الاتصال",
};

// ── ٣ · النتائج ───────────────────────────────────────────────────
/** أقل من هذا لا يُحكم عليه. */
export const WA_MIN = 50;
export type WaVerdict = "scale" | "continue" | "rewrite" | "hold" | "watch";
export const WA_VERDICT_AR: Record<WaVerdict, string> = { scale: "وسِّع", continue: "استمر", rewrite: "أعد الكتابة", hold: "أوقِف", watch: "راقب" };

export interface WaFunnel { key: string; label: string; reached: number; read: number; replied: number; positive: number; stops: number; verdict: WaVerdict; why: string }

/**
 * الحكم على واتساب غيره على البريد: الردّ هنا أسرع وأكثر، وطلب الإيقاف
 * أخطر — ثلاثةٌ من كل مئة يطلبون الإيقاف علامةُ رقمٍ في طريقه للحظر.
 * فما يضرّ يُقرأ قبل ما ينفع. صِرفة.
 */
export function judgeWa(f: { reached: number; replied: number; positive: number; stops: number }): { verdict: WaVerdict; why: string } {
  if (f.reached < WA_MIN) return { verdict: "watch", why: `${f.reached} وصلتهم فقط — الحكم يبدأ من ${WA_MIN}` };
  const stop = (f.stops / f.reached) * 100, pos = (f.positive / f.reached) * 100, rep = (f.replied / f.reached) * 100;
  if (stop >= 3) return { verdict: "hold", why: `${f.stops} طلبوا الإيقاف أو رفضوا من ${f.reached} (${stop.toFixed(1)}٪) — فوق ٣٪ خطرٌ على الرقم` };
  if (pos >= 3) return { verdict: "scale", why: `${f.positive} ردّاً نافعاً من ${f.reached} (${pos.toFixed(1)}٪)` };
  if (f.reached >= 150 && f.replied === 0) return { verdict: "rewrite", why: `${f.reached} وصلتهم ولا ردّ واحد` };
  if (f.reached >= 150 && pos < 0.5 && rep < 2) return { verdict: "rewrite", why: `${f.reached} وصلتهم، ${f.replied} ردّوا و${f.positive} نافع — الرسالة لا تفتح حديثاً` };
  return { verdict: "continue", why: `${f.replied} ردّوا من ${f.reached} (${rep.toFixed(1)}٪)، ${f.positive} نافع` };
}

export interface WaResults {
  days: number;
  overall: WaFunnel;
  campaigns: WaFunnel[];
  sectors: WaFunnel[];
  buckets: Array<{ bucket: Bucket; label: string; reached: number; replied: number; positive: number }>;
  followup: { drafted: number; sent: number; dropped: number; mode: string; topDrop: string | null };
  /** الجاهز في القوائم بكل وجهة — وصفرٌ في وجهةٍ مستهدفة خبرٌ لصاحب العمل. */
  audience: Array<{ bucket: Bucket; label: string; n: number }>;
  needsOwner: string[];
}

export async function waResults(userId: number, days = 30): Promise<WaResults> {
  // لكل (حملة، رقم): هل وصلت، هل قُرئت، هل كتب بعدها، وبأي نيّة. والقطاع من القائمة.
  //
  // الرقم في سجل المحادثات يحمل لاحقة الجهاز («971547999228:0») وفي سجل
  // الحملات لا يحملها. أول تشغيلٍ طابق النصّين كما هما فخرج «٧٦٧ وصلتهم
  // ولا ردّ واحد — أعد الكتابة»، والصحيح أن ١٨١ منهم ردّوا. فالمطابقة
  // على الرقم مجرّداً من لاحقته في كل موضع.
  const base = sql`
    WITH m AS (
      SELECT l.campaign_id, c.name AS campaign, split_part(l.phone, ':', 1) AS phone, l.sent_at, l.read_at,
             (l.status IN ('sent','delivered','read')) AS reached
      FROM message_logs l JOIN campaigns c ON c.id = l.campaign_id
      WHERE c.user_id = ${userId} AND l.created_at > now() - (${days} || ' days')::interval
    ),
    x AS (
      SELECT m.*,
        (SELECT ct.sector FROM contacts ct JOIN contact_groups g ON g.id = ct.group_id
          WHERE g.user_id = ${userId} AND ct.phone = m.phone AND ct.sector IS NOT NULL LIMIT 1) AS sector,
        EXISTS (SELECT 1 FROM wa_thread_messages t WHERE t.user_id = ${userId} AND split_part(t.phone, ':', 1) = m.phone AND NOT t.from_me AND t.created_at >= m.sent_at) AS replied,
        (SELECT ls.last_intent FROM lead_sources ls WHERE ls.user_id = ${userId} AND split_part(ls.phone, ':', 1) = m.phone AND ls.last_intent_at >= m.sent_at LIMIT 1) AS intent
      FROM m WHERE m.reached
    )`;
  const AGG = sql`
    count(DISTINCT phone)::int AS reached,
    count(DISTINCT phone) FILTER (WHERE read_at IS NOT NULL)::int AS read,
    count(DISTINCT phone) FILTER (WHERE replied)::int AS replied,
    count(DISTINCT phone) FILTER (WHERE replied AND intent IN ('interested','question'))::int AS positive,
    count(DISTINCT phone) FILTER (WHERE intent IN ('opt_out','not_interested','complaint'))::int AS stops`;
  const [all, byC, byS, fu, prof, aud] = await Promise.all([
    db.execute<any>(sql`${base} SELECT ${AGG} FROM x`),
    db.execute<any>(sql`${base} SELECT campaign_id AS k, min(campaign) AS label, ${AGG} FROM x GROUP BY campaign_id ORDER BY campaign_id DESC LIMIT 12`),
    db.execute<any>(sql`${base} SELECT coalesce(sector, 'لم تُصنَّف') AS k, ${AGG} FROM x GROUP BY 1 ORDER BY count(DISTINCT phone) DESC LIMIT 10`),
    db.execute<any>(sql`
      SELECT count(*) FILTER (WHERE verdict = 'send')::int AS drafted, count(*) FILTER (WHERE executed)::int AS sent,
             count(*) FILTER (WHERE verdict <> 'send')::int AS dropped,
             (SELECT left(reason, 60) FROM followup_deliberations WHERE user_id = ${userId} AND verdict <> 'send' AND created_at > now() - interval '7 days' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS top
      FROM followup_deliberations WHERE user_id = ${userId} AND created_at > now() - interval '7 days'`),
    db.select({ m: businessProfileTable.smartFollowup }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1),
    db.execute<{ sector: string | null; n: number }>(sql`
      SELECT c.sector, count(*)::int AS n FROM contacts c JOIN contact_groups g ON g.id = c.group_id
      WHERE g.user_id = ${userId} AND c.status IN ('active','pending') GROUP BY 1`),
  ]);
  const fn = (r: any, key: string, label: string): WaFunnel => {
    const f = { reached: Number(r?.reached ?? 0), read: Number(r?.read ?? 0), replied: Number(r?.replied ?? 0), positive: Number(r?.positive ?? 0), stops: Number(r?.stops ?? 0) };
    return { key, label, ...f, ...judgeWa(f) };
  };
  const sectors = byS.rows.map((r: any) => fn(r, r.k, r.k));
  const bk = new Map<Bucket, { reached: number; replied: number; positive: number }>();
  for (const s of sectors) {
    const b = bucketOf(s.key === "لم تُصنَّف" ? null : s.key), e = bk.get(b) ?? { reached: 0, replied: 0, positive: 0 };
    e.reached += s.reached; e.replied += s.replied; e.positive += s.positive; bk.set(b, e);
  }
  const audMap = new Map<Bucket, number>();
  for (const r of aud.rows) { const b = bucketOf(r.sector); audMap.set(b, (audMap.get(b) ?? 0) + Number(r.n)); }
  const audience = (["aml", "both", "services", "secondary", "competitor", "unknown"] as Bucket[]).map((b) => ({ bucket: b, label: BUCKET_AR[b].label, n: audMap.get(b) ?? 0 }));
  const mode = (prof[0]?.m ?? "dry") as string;
  const f = fu.rows[0] ?? {};
  const needsOwner: string[] = [];
  if (mode !== "live" && Number(f.drafted ?? 0) > 0) needsOwner.push(`المتابعة في وضع التجربة: ${f.drafted} متابعة كُتبت هذا الأسبوع ولم تُرسَل. تشغيلها الحيّ بيدك.`);
  if ((audMap.get("unknown") ?? 0) > 0) needsOwner.push(`${audMap.get("unknown")} رقماً لا يُعرف نشاط صاحبه — ملفّاتها بلا عمود نشاط وأسماؤها لا تدلّ.`);
  if ((audMap.get("services") ?? 0) === 0) needsOwner.push("لا رقم واحد لمطاعم أو مقاولات في القوائم — ارفع قوائمها ليعمل مسار المحاسبة.");
  for (const c of [...byC.rows.map((r: any) => fn(r, String(r.k), String(r.label ?? "").slice(0, 60)))]) if (c.verdict === "hold") needsOwner.push(`حملة «${c.label}»: ${c.why}.`);
  return {
    days, overall: fn(all.rows[0], "all", "الكل"),
    campaigns: byC.rows.map((r: any) => fn(r, String(r.k), String(r.label ?? "").slice(0, 60))), sectors,
    buckets: [...bk.entries()].map(([bucket, e]) => ({ bucket, label: BUCKET_AR[bucket].label, ...e })).sort((a, b) => b.reached - a.reached),
    followup: { drafted: Number(f.drafted ?? 0), sent: Number(f.sent ?? 0), dropped: Number(f.dropped ?? 0), mode, topDrop: f.top ?? null },
    audience, needsOwner,
  };
}

// ── الدورة ────────────────────────────────────────────────────────
export interface WaCycle {
  at: Date;
  staffing: { total: number; missing: string[]; offDuty: Array<{ name: string; gap: string }> };
  desk: DeskReport[];
  results: WaResults;
  evaluations: Evaluation[];
  brief: { verdict: string; did: string[]; decided: string[]; needs: string[] } | null;
}

export function waFacts(c: Omit<WaCycle, "brief" | "at">): string {
  const r = c.results, line = (f: WaFunnel) => `• ${f.label}: وصلت ${f.reached} · ردّ ${f.replied} · نافع ${f.positive} · إيقاف ${f.stops} ← ${WA_VERDICT_AR[f.verdict]} (${f.why})`;
  const classified = c.desk.reduce((n, d) => n + d.reading.total, 0), hint = c.desk.reduce((n, d) => n + d.reading.byHintOnly, 0), unknown = c.desk.reduce((n, d) => n + d.reading.unknown, 0);
  return [
    `الفريق: ${c.staffing.total} موظفاً.${c.staffing.missing.length ? ` ينقصه: ${c.staffing.missing.join("؛ ")}.` : ""}${c.staffing.offDuty.length ? ` متوقفون: ${c.staffing.offDuty.map((o) => `${o.name} — ${o.gap}`).join("؛ ")}.` : " كلهم على رأس العمل."}`,
    `البيانات: ${c.desk.length} قائمة، ${classified} رقماً صُنّف. ${hint} قطاعها موروثٌ من اسم الملف، ${unknown} لم تُعرف.`,
    ...c.desk.filter((d) => d.clearance.fixed + d.clearance.removed + d.filed.length + d.model.settled > 0).slice(0, 5).map((d) => `• «${d.listName}»: أُصلح ${d.clearance.fixed}، أُخرج ${d.clearance.removed}، حسم المصنّف ${d.model.settled} اسماً${d.filed.length ? `، ونُقل ${d.filed.reduce((n, x) => n + x.moved, 0)} غريباً` : ""}`),
    `الجاهز في القوائم: ${r.audience.filter((a) => a.n).map((a) => `${a.label} ${a.n}`).join(" · ")}.`,
    `النتائج (آخر ${r.days} يوماً، بالرقم الواحد لا بالرسالة):`, line(r.overall),
    ...r.campaigns.slice(0, 5).map(line),
    r.sectors.length ? "بالقطاع:" : "", ...r.sectors.slice(0, 5).map(line),
    `المتابعة (٧ أيام): كُتبت ${r.followup.drafted} · أُرسلت ${r.followup.sent} · سقطت ${r.followup.dropped}${r.followup.topDrop ? ` (أكثر الأسباب: ${r.followup.topDrop})` : ""} — الوضع: ${r.followup.mode === "live" ? "حيّ" : r.followup.mode === "off" ? "متوقف" : "تجربة، لا يُرسَل"}.`,
    "تقييم الموظفين:", evaluationFacts(c.evaluations),
    r.needsOwner.length ? "يحتاج صاحب العمل:" : "", ...r.needsOwner.map((x) => `• ${x}`),
  ].filter(Boolean).join("\n");
}

const RULES = [
  "أنتِ تكتبين تقرير الدورة لصاحب العمل. الدورة انتهت: التقييمات حُسبت والمهام وصلت أصحابها — أنتِ تُخبرين.",
  "",
  "قواعد لا تُخالف:",
  "١. لا رقم ولا حالة ولا حادثة ليست في «وقائع الدورة». ما لم يُذكر فيها لم يحدث.",
  "٢. الردّ النافع غير الردّ: «مرحبا» و«من معي؟» ردٌّ وليس نافعاً. لا تسمّي حملةً ناجحة بعدد من ردّوا.",
  "٣. طلب الإيقاف يُقرأ قبل الردود: حملةٌ ردّ عليها كثيرون وطلب الإيقاف منها ثلاثةٌ من كل مئة حملةٌ تُوقَف.",
  "٤. الموظف يُذكر باسمه ودرجته وما أُعطي — لا بصفاتٍ عامة. «هال يحتاج تطويراً» ليست جملة.",
  "٥. لا تكتبي مهاماً ولا أرقاماً من عندك: المهام وما يحتاج صاحب العمل تُضاف من الكود بعد تقريرك. اكتبي الحكم وما فُعل فقط.",
  "٦. لا تُطلقين حملةً ولا تَعِدين بها. الإرسال قرار صاحب العمل، وسلامة الرقم عمل فهد.",
  "",
  "اكتبي بهذا الشكل بالضبط ولا تزيدي:",
  "الحكم: <سطر واحد — حال الواتساب اليوم برقمين على الأكثر>",
  "فعلتُ:",
  "- <ما نُفّذ في هذه الدورة — نقطتان إلى أربع، كلٌّ برقمه>",
  "قرّرتُ:",
  "- <المهام التي أعطيتِها ولمن ولماذا — نقطة إلى ثلاث. إن لم تكن فاكتبي: لا مهمة جديدة>",
  "يحتاجك:",
  "- <ما يحتاج يد صاحب العمل — أو: لا شيء>",
].join("\n");

async function writeBrief(userId: number, facts: string): Promise<WaCycle["brief"]> {
  const [[me], [profile]] = await Promise.all([
    db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, WA_MANAGER_ROLE))).limit(1),
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1),
  ]);
  const system = corePrompt({
    channel: "internal", role: WA_MANAGER_ROLE, noExamples: true,
    identity: `اسمكِ ${me?.name ?? "شمّة"}، ${me?.title ?? "مديرة المبيعات"}${profile?.name ? ` لدى ${profile.name}` : ""} — تُديرين مكتب الواتساب.`,
    persona: me?.persona ?? null, firm: profile?.description ?? null,
    rules: [profile?.vertical === "accounting" || !profile?.vertical ? targetsBrief() : "", RULES],
  });
  const out = await asAgent(userId, WA_MANAGER_ROLE, () => complete([{ role: "system", content: system }, { role: "user", content: `وقائع الدورة:\n${facts}` }], 60_000)).catch(() => null);
  if (!out?.text) return null;
  const sec = (name: string, next: string) =>
    (new RegExp(`${name}\\s*[:：]\\s*\\n?([\\s\\S]*?)(?=\\n\\s*(?:${next})\\s*[:：]|$)`).exec(out.text)?.[1] ?? "")
      .split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter((l) => l.length > 2).slice(0, 5);
  return { verdict: /الحكم\s*[:：]\s*(.+)/.exec(out.text)?.[1]?.trim() ?? "", did: sec("فعلتُ", "قرّرتُ|يحتاجك"), decided: sec("قرّرتُ", "يحتاجك"), needs: sec("يحتاجك", "$^") };
}

export async function runWaManagerCycle(userId: number, opts: { brief?: boolean; notifyOwner?: boolean; desk?: boolean } = {}): Promise<WaCycle | null> {
  const [me] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, WA_MANAGER_ROLE))).limit(1);
  if (!me?.isActive) return null;

  // ١ · الفريق
  const team = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), inArray(botEmployeesTable.role, Object.keys(WA_TEAM))));
  const have = new Set(team.map((t) => t.role));
  const staffing = {
    total: team.length,
    missing: Object.entries(WA_TEAM).filter(([r]) => !have.has(r)).map(([, gap]) => gap),
    offDuty: team.filter((t) => !t.isActive).map((t) => ({ name: t.name, gap: WA_TEAM[t.role] ?? `${t.title ?? t.role} متوقف` })),
  };

  // ٢ · البيانات — سالم ثم ريم، قائمةً قائمة
  const hasLists = (await db.select({ id: contactGroupsTable.id }).from(contactGroupsTable).where(eq(contactGroupsTable.userId, userId)).limit(1)).length > 0;
  const desk = opts.desk !== false && hasLists ? await runDeskAll(userId, "whatsapp", "manager").catch(() => [] as DeskReport[]) : [];

  // ٣ · النتائج
  const results = await waResults(userId);

  // ٤ و٥ · التقييم والمراجعة — وكل مهمةٍ تصل صاحبها رسالةً منها
  const evaluations = await evaluateDesk(userId, { desk: "whatsapp", manager: WA_MANAGER_ROLE, managerName: me.name, roles: Object.keys(WA_TEAM) });

  // حكمها على الحملات يصل من يكتب: هال وخالد يقرآنه قبل ردّهما التالي.
  for (const c of results.campaigns.filter((x) => x.verdict === "rewrite" || x.verdict === "hold").slice(0, 2)) {
    await sayOnce(userId, WA_MANAGER_ROLE, "sales", `حملة «${c.label}»: ${WA_VERDICT_AR[c.verdict]} — ${c.why}. من ردّ منها يُجاب عن سؤاله هو، لا بإعادة نص الحملة.`);
  }
  if (results.followup.dropped > results.followup.drafted && results.followup.topDrop) {
    await sayOnce(userId, WA_MANAGER_ROLE, "followup", `سقط من متابعاتك هذا الأسبوع ${results.followup.dropped} وكُتب ${results.followup.drafted}. أكثر الأسباب: «${results.followup.topDrop}». عالِج هذا السبب بعينه في المتابعة القادمة.`);
  }

  const base = { staffing, desk, results, evaluations };
  let brief: WaCycle["brief"] = null;
  if (opts.brief !== false) {
    brief = await writeBrief(userId, waFacts(base));
    // «قرّرتُ» و«يحتاجك» من الكود لا من النموذج: أول تقريرٍ على منصةٍ
    // أخرى كتب مهاماً لم تُعطَ («١٥ استفساراً يومياً لمدة أسبوع»). النموذج
    // يكتب الحكم وما فُعل؛ والقرارات هي ما قرّره الكود فعلاً، حرفياً.
    if (brief) {
      brief.decided = evaluations.filter((e) => e.task).slice(0, 5).map((e) => `${e.name}: ${e.task}`);
      if (!brief.decided.length) brief.decided = ["لا مهمة جديدة — من يحتاج مهمةً أُعطيها في دورةٍ سابقة ولم تتغيّر."];
      brief.needs = results.needsOwner.length ? results.needsOwner.slice(0, 4) : ["لا شيء."];
    }
    if (brief) {
      const text = [brief.verdict, "فعلتُ:", ...brief.did.map((x) => `• ${x}`), "قرّرتُ:", ...brief.decided.map((x) => `• ${x}`), "يحتاجك:", ...brief.needs.map((x) => `• ${x}`)].join("\n");
      receipt({ userId, node: WA_MANAGER_ROLE, graph: "whatsapp", action: "manager.brief", evidence: { reached: results.overall.reached, positive: results.overall.positive, weak: evaluations.filter((e) => e.grade === "weak").length }, why: text.slice(0, 900) });
      await db.execute(sql`INSERT INTO manager_reviews (user_id, summary, directives) VALUES (${userId}, ${text}, ${JSON.stringify(evaluations.filter((e) => e.task).map((e) => ({ role: e.role, task: e.task })))}::jsonb)`).catch(() => {});
      if (opts.notifyOwner) {
        await notify(userId, [
          `<b>🧭 ${esc(me.name)} — تقرير الواتساب</b>`, esc(brief.verdict),
          brief.did.length ? "<b>فعلتُ</b>" : "", ...brief.did.map((x) => `• ${esc(x)}`),
          brief.decided.length ? "<b>قرّرتُ</b>" : "", ...brief.decided.map((x) => `• ${esc(x)}`),
          brief.needs.length ? "<b>يحتاجك</b>" : "", ...brief.needs.map((x) => `• ${esc(x)}`),
        ].filter(Boolean).join("\n")).catch(() => {});
      }
    }
  }
  logger.info({ userId, lists: desk.length, reached: results.overall.reached, evaluated: evaluations.length, brief: !!brief }, "دورة مديرة الواتساب");
  return { at: new Date(), ...base, brief };
}

/** مرةً في اليوم للنص نفسه — الدورة كل ست ساعات، والتوجيه لا يُكرَّر أربع مرات. */
async function sayOnce(userId: number, fromRole: string, toRole: string, body: string) {
  const [again] = (await db.execute(sql`SELECT 1 FROM agent_messages WHERE user_id = ${userId} AND from_role = ${fromRole} AND to_role = ${toRole} AND body = ${body.slice(0, 2000)} AND created_at > now() - interval '24 hours' LIMIT 1`)).rows;
  if (!again) await say({ userId, fromRole, toRole, kind: "directive", body });
}

/** للواجهة — بلا نموذج ولا جولة بيانات. */
export async function waManagerState(userId: number) {
  const [results, last] = await Promise.all([
    waResults(userId),
    db.execute<any>(sql`SELECT summary AS text, created_at AS at FROM manager_reviews WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1`),
  ]);
  return { results, brief: last.rows[0] ?? null, targets: targetsBrief() };
}

export function startWaManagerLoop(): void {
  const SIX_H = 6 * 3_600_000;
  const lastBrief = new Map<number, number>();
  const round = async () => {
    // حيث للحساب قوائم ومديرة على رأس العمل. والنسخة التي أُوقف فريقها لا تُدير حلقة.
    const rows = await db.execute<{ user_id: number }>(sql`
      SELECT DISTINCT e.user_id FROM bot_employees e
      WHERE e.role = ${WA_MANAGER_ROLE} AND e.is_active
        AND EXISTS (SELECT 1 FROM contact_groups g WHERE g.user_id = e.user_id)
        AND NOT EXISTS (SELECT 1 FROM business_profile b WHERE b.user_id = e.user_id AND b.team_paused)`).catch(() => ({ rows: [] as Array<{ user_id: number }> }));
    for (const u of rows.rows) {
      const userId = Number(u.user_id);
      const due = Date.now() - (lastBrief.get(userId) ?? 0) > 20 * 3_600_000;
      const r = await runWaManagerCycle(userId, { brief: due, notifyOwner: due }).catch((err) => { logger.warn({ userId, err: String(err?.message ?? err) }, "دورة مديرة الواتساب تعذّرت"); return null; });
      if (r?.brief) lastBrief.set(userId, Date.now());
    }
  };
  setTimeout(() => { void round(); setInterval(() => void round(), SIX_H); }, 8 * 60_000);
  logger.info("حلقة مديرة الواتساب بدأت — دورة كل ست ساعات");
}
