// ── محلّل النتائج ─────────────────────────────────────────────────
// الأهم في الفريق بقول صاحب العمل، ولسببٍ وجيه: كل ما قبله يُنتج إرسالاً،
// وهذا وحده يقول هل نفع.
//
// وثلاثة دروسٍ من هذا الحساب نفسه مبنيّةٌ في عظمه:
//
// ١ · يُعدّ **بالشركة** لا بالرسالة. شركةٌ راسلناها ثلاثاً وردّت مرةً
//     شركةٌ ردّت، لا «٣٣٪ ردّ». والقسمة على الرسائل تُصغّر كل نسبةٍ
//     بعدد المتابعات، فيبدو الجيد رديئاً.
//
// ٢ · الارتداد ما ارتدّ من عنوان العميل بعد أن **خرجت** الرسالة. وما
//     رفضه مزوّد البريد قبل خروجه حكمٌ على نصّنا لا على عناوينهم، ويُعدّ
//     وحده. خلطُ الاثنين أخرج لي «٢٥٪ ارتداد» على قائمةٍ ارتدادها دون
//     الواحد بالمئة، وأخرج ثلاثين شركة سليمة من القوائم.
//
// ٣ · لا حكم على عيّنةٍ صغيرة. زاويةٌ أُرسلت لعشرين شركة بلا ردّ لم
//     «تفشل»، بل لم تُجرَّب. الحكم يبدأ من خمسين، والفشل من مئةٍ وخمسين.
//
// وكل ما هنا استعلامٌ وحساب: لا نموذج. النموذج يُعطى هذه الأرقام ليكتب
// حكمه بصوته، ولا يُسأل عن رقم.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { MIX, TARGETS, TRACK_AR, angleById, mixShare, type MixState, type Track } from "./policy";

/** أقل من هذا لا يُحكم عليه. */
export const MIN_SAMPLE = 50;
/** ومن هذا فما فوق، صفرُ ردٍّ إيجابي فشلٌ للزاوية لا حظٌّ عاثر. */
export const FAIL_SAMPLE = 150;
/** شركةٌ من كل مئة تردّ رداً نافعاً: عتبة «وسِّع». */
export const SCALE_RATE = 1.0;
/** فوق هذا الارتدادُ يضرّ السمعة. */
export const BOUNCE_HOLD = 5.0;
/** رفضُ المزوّد خمس رسائل من حملةٍ واحدة: النص هو المشكلة. */
export const POLICY_REWRITE = 5;

export type Verdict = "scale" | "continue" | "rewrite" | "hold" | "watch";
export const VERDICT_AR: Record<Verdict, { label: string; means: string }> = {
  scale:    { label: "وسِّع",       means: "تجلب ردوداً نافعة — أعطها حصةً أكبر من موجات مسارها" },
  continue: { label: "استمر",      means: "تعمل دون أن تتميّز — تُكمل دورها" },
  rewrite:  { label: "أعد الكتابة", means: "جُرّبت كفايةً ولم تجلب رداً، أو رفضها المزوّد — تُستبدل بزاويةٍ أخرى" },
  hold:     { label: "أوقِف",      means: "ارتدادها فوق الحد — تُنظَّف قائمتها قبل أي موجة" },
  watch:    { label: "راقب",       means: "العيّنة أصغر من أن يُحكم عليها" },
};

export interface Funnel {
  key: string;
  label: string;
  /** شركاتٌ خرجت إليها رسالة واحدة على الأقل. */
  sent: number;
  bounced: number;
  opened: number;
  clicked: number;
  /** ردٌّ حقيقي من إنسان — بأي نيّة. */
  replied: number;
  /** مهتم، يسأل، تحت المراجعة، ليس الآن، حوّلنا لغيره. */
  positive: number;
  /** غير مهتم، شكوى، طلب إيقاف. */
  negative: number;
  /** رسائل رفضها مزوّد البريد قبل خروجها. */
  rejected: number;
  bounceRate: number;
  replyRate: number;
  positiveRate: number;
  verdict: Verdict;
  why: string;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const rows = <T = any>(r: any): T[] => (r.rows ?? r) as T[];

/** الحكم — بترتيبٍ هو نفسه منطق العمل: ما يضرّ يُقرأ قبل ما ينفع. */
export function judge(f: Pick<Funnel, "sent" | "bounced" | "positive" | "rejected">, scope: "unit" | "aggregate" = "unit"): { verdict: Verdict; why: string } {
  // رفضُ المزوّد حكمٌ على نصٍّ بعينه: يُسقط الحملة أو الزاوية التي كُتب
  // بها، لا المسار كله ولا القطاع. أول تشغيلٍ حكم على «AML» كله بإعادة
  // الكتابة لأن حملةً واحدة منه رُفضت.
  if (scope === "unit" && f.rejected >= POLICY_REWRITE) return { verdict: "rewrite", why: `مزوّد البريد رفض ${f.rejected} رسالة منها كإزعاج — النص هو المشكلة` };
  if (f.sent < MIN_SAMPLE) return { verdict: "watch", why: `${f.sent} شركة فقط — الحكم يبدأ من ${MIN_SAMPLE}` };
  const b = pct(f.bounced, f.sent), p = pct(f.positive, f.sent);
  if (b >= BOUNCE_HOLD) return { verdict: "hold", why: `ارتداد ${b}٪ (${f.bounced} من ${f.sent}) — فوق ${BOUNCE_HOLD}٪` };
  if (p >= SCALE_RATE) return { verdict: "scale", why: `${f.positive} رداً نافعاً من ${f.sent} شركة (${p}٪)` };
  if (f.sent >= FAIL_SAMPLE && f.positive === 0) return { verdict: "rewrite", why: `${f.sent} شركة ولا ردّ نافع واحد` };
  return { verdict: "continue", why: f.positive ? `${f.positive} رداً نافعاً من ${f.sent} (${p}٪) — دون عتبة التوسيع` : `${f.sent} شركة، لا ردّ نافع بعد — لم تبلغ ${FAIL_SAMPLE} ليُحكم بالفشل` };
}

/**
 * القمع مجمَّعاً على بُعد. الأساس واحد: لكل (مهمة، شركة) صفٌّ يقول ماذا
 * حدث — فلا تُعدّ شركةٌ مرتين داخل مهمتها مهما كثرت متابعاتها.
 */
const BASE = (userId: number, days: number) => sql`
  WITH mm AS (
    SELECT ms.id AS mission_id, ms.track, ms.angle, ms.name AS mission_name, ms.created_at AS mission_at,
           m.contact_id, m.to_email, m.sent_at, m.bounced_at, m.opened_at, m.clicked_at, m.replied_at, m.error
    FROM email_missions ms
    -- Two plain joins, not one OR: «campaign OR sequence» made Postgres compare
    -- every message with every mission — ten minutes a query, eight at once,
    -- and the whole app waiting for a connection (2026-10-26).
    JOIN LATERAL (
      SELECT m1.id, m1.contact_id, m1.to_email, m1.sent_at, m1.bounced_at, m1.opened_at, m1.clicked_at, m1.replied_at, m1.error
      FROM email_messages m1 WHERE m1.user_id = ms.user_id AND m1.campaign_id = ms.campaign_id
      UNION
      SELECT m2.id, m2.contact_id, m2.to_email, m2.sent_at, m2.bounced_at, m2.opened_at, m2.clicked_at, m2.replied_at, m2.error
      FROM email_sequence_jobs j JOIN email_messages m2 ON m2.sequence_job_id = j.id
      WHERE m2.user_id = ms.user_id AND j.sequence_id IN (ms.warm_sequence_id, ms.cold_sequence_id)
    ) m ON true
    WHERE ms.user_id = ${userId} AND ms.track IS NOT NULL
      AND ms.created_at > now() - (${days} || ' days')::interval
  ),
  per AS (
    SELECT mm.mission_id, mm.track, mm.angle, mm.mission_name, mm.contact_id,
           min(mm.to_email)                                                            AS email,
           bool_or(mm.sent_at IS NOT NULL)                                             AS sent,
           min(mm.sent_at)                                                             AS first_sent,
           bool_or(mm.sent_at IS NOT NULL AND mm.bounced_at IS NOT NULL)               AS bounced,
           bool_or(mm.opened_at IS NOT NULL)                                           AS opened,
           bool_or(mm.clicked_at IS NOT NULL)                                          AS clicked,
           count(*) FILTER (WHERE mm.sent_at IS NULL AND mm.error ~* '(5\\.7\\.[0-9]|spam|policy|blocked|reputation|message rejected)')::int AS rejected
    FROM mm WHERE mm.contact_id IS NOT NULL
    GROUP BY mm.mission_id, mm.track, mm.angle, mm.mission_name, mm.contact_id
  ),
  -- الردّ الحقيقي من إنسان، بعد أول رسالةٍ من هذه المهمة إليه.
  x AS (
    SELECT p.*, c.sector,
      EXISTS (SELECT 1 FROM email_inbound i WHERE i.contact_id = p.contact_id AND coalesce(i.kind,'reply') = 'reply'
                AND i.received_at >= p.first_sent)                                                        AS replied,
      EXISTS (SELECT 1 FROM email_inbound i WHERE i.contact_id = p.contact_id AND coalesce(i.kind,'reply') = 'reply'
                AND i.received_at >= p.first_sent
                AND i.intent IN ('interested','question','considering','later','referral'))               AS positive,
      EXISTS (SELECT 1 FROM email_inbound i WHERE i.contact_id = p.contact_id AND coalesce(i.kind,'reply') = 'reply'
                AND i.received_at >= p.first_sent
                AND i.intent IN ('not_interested','opt_out','complaint'))                                 AS negative
    FROM per p LEFT JOIN email_contacts c ON c.id = p.contact_id
  )`;

const AGG = sql`
  count(*) FILTER (WHERE sent)::int               AS sent,
  count(*) FILTER (WHERE sent AND bounced)::int   AS bounced,
  count(*) FILTER (WHERE sent AND opened)::int    AS opened,
  count(*) FILTER (WHERE sent AND clicked)::int   AS clicked,
  count(*) FILTER (WHERE sent AND replied)::int   AS replied,
  count(*) FILTER (WHERE sent AND positive)::int  AS positive,
  count(*) FILTER (WHERE sent AND negative)::int  AS negative,
  coalesce(sum(rejected), 0)::int                 AS rejected`;

function funnel(r: any, key: string, label: string, scope: "unit" | "aggregate" = "unit"): Funnel {
  const f = {
    key, label,
    sent: Number(r.sent ?? 0), bounced: Number(r.bounced ?? 0), opened: Number(r.opened ?? 0), clicked: Number(r.clicked ?? 0),
    replied: Number(r.replied ?? 0), positive: Number(r.positive ?? 0), negative: Number(r.negative ?? 0), rejected: Number(r.rejected ?? 0),
  };
  return { ...f, bounceRate: pct(f.bounced, f.sent), replyRate: pct(f.replied, f.sent), positiveRate: pct(f.positive, f.sent), ...judge(f, scope) };
}

/**
 * حجم كل مسار في نافذة النسبة: ما خرج وما في الطابور، وما خُطّط له ولم
 * يُطلَق بعد (بحجم موجته) — وإلا خطّط الطيار موجة خدماتٍ كل ربع ساعة
 * ما دامت الأولى تنتظر.
 */
export async function mixState(userId: number, days = 30): Promise<MixState> {
  const r = rows(await db.execute<any>(sql`
    SELECT ms.track,
      coalesce(sum(CASE
        WHEN ms.campaign_id IS NOT NULL THEN
          (SELECT count(*) FROM email_messages m WHERE m.campaign_id = ms.campaign_id AND m.status NOT IN ('cancelled'))
        ELSE coalesce(nullif(ms.filter->>'take', '')::int, 0)
      END), 0)::int AS n
    FROM email_missions ms
    WHERE ms.user_id = ${userId} AND ms.track IS NOT NULL
      AND ms.stage <> 'cancelled'
      AND ms.created_at > now() - (${days} || ' days')::interval
    GROUP BY ms.track`));
  const n = (t: Track) => Number(r.find((x: any) => x.track === t)?.n ?? 0);
  return { aml: n("aml"), services: n("services") };
}

/** الجمهور الجاهز في القطاعات المستهدفة — وصفرٌ هنا خبرٌ لصاحب العمل. */
export async function targetAudience(userId: number): Promise<Array<{ sector: string; tracks: Track[]; ready: number; total: number }>> {
  const sectors = [...new Set([...TARGETS.aml, ...TARGETS.services])];
  const r = rows(await db.execute<any>(sql`
    SELECT sector,
      count(*) FILTER (WHERE status = 'active' AND coalesce(mx_ok, true) AND last_sent_at IS NULL
                         AND (quiet_until IS NULL OR quiet_until < now()))::int AS ready,
      count(*)::int AS total
    FROM email_contacts WHERE user_id = ${userId} AND sector IS NOT NULL GROUP BY sector`));
  return sectors.map((sector) => {
    const hit = r.find((x: any) => x.sector === sector);
    return { sector, tracks: (Object.keys(TARGETS) as Track[]).filter((t) => TARGETS[t].includes(sector)), ready: Number(hit?.ready ?? 0), total: Number(hit?.total ?? 0) };
  });
}

export interface ResultsReport {
  days: number;
  mix: { state: MixState; share: Record<Track, number>; target: Record<Track, number>; drift: number };
  overall: Funnel;
  tracks: Funnel[];
  sectors: Funnel[];
  angles: Funnel[];
  missions: Funnel[];
  /** عنوان قسمٍ مقابل عنوان شخص: أين الارتداد وأين الرد. */
  addressTypes: Array<{ key: string; label: string; sent: number; bounced: number; replied: number; bounceRate: number; replyRate: number }>;
  audience: Awaited<ReturnType<typeof targetAudience>>;
  /** زوايا حُكم عليها بإعادة الكتابة — الطيار يتخطّاها. */
  avoidAngles: string[];
  /** قراراتٌ تُنفَّذ بلا إذن، وكلٌّ بسببه ورقمه. */
  decisions: Array<{ kind: string; text: string }>;
  /** ما يحتاج يد صاحب العمل. */
  needsOwner: string[];
}

export async function resultsReport(userId: number, days = 30): Promise<ResultsReport> {
  const base = BASE(userId, days);
  const [all, byTrack, bySector, byAngle, byMission, byAddr, state, audience] = await Promise.all([
    db.execute<any>(sql`${base} SELECT ${AGG} FROM x`),
    db.execute<any>(sql`${base} SELECT track AS k, ${AGG} FROM x GROUP BY track`),
    db.execute<any>(sql`${base} SELECT track, coalesce(sector, 'بلا قطاع') AS k, ${AGG} FROM x GROUP BY track, 2 ORDER BY count(*) FILTER (WHERE sent) DESC LIMIT 12`),
    db.execute<any>(sql`${base} SELECT angle AS k, ${AGG} FROM x WHERE angle IS NOT NULL GROUP BY angle`),
    db.execute<any>(sql`${base} SELECT mission_id, min(mission_name) AS name, min(track) AS track, min(angle) AS angle, ${AGG} FROM x GROUP BY mission_id ORDER BY mission_id DESC LIMIT 15`),
    db.execute<any>(sql`${base}
      SELECT CASE
          WHEN email ~* '^(info|sales|admin|contact|support|hello|enquiry|enquiries|inquiry|office|mail|email|general|reception|hr|careers|accounts|accounting|finance|marketing|team|service|customercare|help)@' THEN 'role'
          WHEN email ~* '@(gmail|hotmail|outlook|yahoo|live|aol|icloud|protonmail)\\.' THEN 'free'
          ELSE 'person' END AS k,
        count(DISTINCT contact_id) FILTER (WHERE sent)::int             AS sent,
        count(DISTINCT contact_id) FILTER (WHERE sent AND bounced)::int AS bounced,
        count(DISTINCT contact_id) FILTER (WHERE sent AND replied)::int AS replied
      FROM x GROUP BY 1`),
    mixState(userId, days),
    targetAudience(userId),
  ]);

  const overall = funnel(rows(all)[0] ?? {}, "all", "الكل", "aggregate");
  const tracks = rows(byTrack).map((r: any) => funnel(r, r.k, TRACK_AR[r.k as Track] ?? r.k, "aggregate"));
  const sectors = rows(bySector).map((r: any) => funnel(r, `${r.track}:${r.k}`, `${r.k} — ${TRACK_AR[r.track as Track] ?? r.track}`, "aggregate")).filter((f) => f.sent >= 5);
  const angles = rows(byAngle).map((r: any) => funnel(r, r.k, angleById(r.k)?.label ?? r.k));
  const missions = rows(byMission).map((r: any) => funnel(r, String(r.mission_id), String(r.name ?? "").slice(0, 70)));
  const ADDR: Record<string, string> = { role: "عناوين أقسام (info@، sales@)", person: "عناوين أشخاص (name@company)", free: "عناوين مجانية (gmail…)" };
  const addressTypes = rows(byAddr).map((r: any) => ({
    key: r.k, label: ADDR[r.k] ?? r.k, sent: Number(r.sent), bounced: Number(r.bounced), replied: Number(r.replied),
    bounceRate: pct(Number(r.bounced), Number(r.sent)), replyRate: pct(Number(r.replied), Number(r.sent)),
  })).sort((a, b) => b.sent - a.sent);

  const share = mixShare(state);
  const drift = Math.round((share.aml - MIX.aml) * 1000) / 10;

  // ── القرارات: ما يُفعل بلا إذن ──
  const decisions: ResultsReport["decisions"] = [];
  const avoidAngles = angles.filter((a) => a.verdict === "rewrite").map((a) => a.key);
  for (const a of angles) {
    if (a.verdict === "rewrite") decisions.push({ kind: "angle_off", text: `زاوية «${a.label}» تُوقَف: ${a.why}. الموجة القادمة لقطاعها بزاويةٍ أخرى.` });
    if (a.verdict === "scale")   decisions.push({ kind: "angle_up",  text: `زاوية «${a.label}» تُقدَّم: ${a.why}.` });
  }
  for (const m of missions) {
    if (m.rejected >= POLICY_REWRITE && !decisions.some((d) => d.kind === "policy")) {
      decisions.push({ kind: "policy", text: `مزوّد البريد رفض ${m.rejected} رسالة من «${m.label}» كإزعاج: النص المتكرّر. تُدوَّر الزوايا وتصغر الموجات.` });
    }
  }
  const role = addressTypes.find((a) => a.key === "role"), person = addressTypes.find((a) => a.key === "person");
  if (role && person && role.sent >= MIN_SAMPLE && person.sent >= MIN_SAMPLE && person.bounceRate >= role.bounceRate * 2 && person.bounceRate >= 2) {
    decisions.push({ kind: "role_first", text: `عناوين الأقسام ترتدّ ${role.bounceRate}٪ وعناوين الأشخاص ${person.bounceRate}٪ — الموجات تبدأ بعناوين الأقسام.` });
  }
  if (state.aml + state.services >= 100 && Math.abs(drift) >= 5) {
    decisions.push({ kind: "mix", text: drift < 0
      ? `AML عند ${Math.round(share.aml * 100)}٪ والمستهدف ${MIX.aml * 100}٪ — موجات الخدمات تتوقف حتى تعود النسبة.`
      : `الخدمات عند ${Math.round(share.services * 100)}٪ والمستهدف ${MIX.services * 100}٪ — الموجة القادمة للقطاع المشترك خدمات.` });
  }

  // ── ما لا يُحلّ بلا صاحب العمل ──
  const needsOwner: string[] = [];
  for (const a of audience) {
    if (a.total === 0) needsOwner.push(`لا عنوان بريدٍ واحد في قطاع «${a.sector}» (${a.tracks.map((t) => TRACK_AR[t]).join(" + ")}) — ارفع قائمته من «رفع Excel».`);
    else if (a.ready < MIN_SAMPLE) needsOwner.push(`قطاع «${a.sector}»: ${a.ready} عنواناً جاهزاً فقط — أقل من موجةٍ يُحكم عليها.`);
  }
  for (const s of sectors) if (s.verdict === "hold") needsOwner.push(`«${s.label}»: ${s.why} — راجع مصدر القائمة.`);

  return { days, mix: { state, share, target: MIX, drift }, overall, tracks, sectors, angles, missions, addressTypes, audience, avoidAngles, decisions, needsOwner };
}

/** الوقائع نصاً للمحلّل — مضغوطةً، فالحساب المجاني ٨٠٠٠ رمزاً في الدقيقة. */
export function resultsFacts(r: ResultsReport): string {
  const line = (f: Funnel) => `• ${f.label}: ${f.sent} شركة · ردّ نافع ${f.positive} (${f.positiveRate}٪) · كل الردود ${f.replied} · ارتداد ${f.bounced} (${f.bounceRate}٪)${f.rejected ? ` · رفضها المزوّد ${f.rejected}` : ""} ← ${VERDICT_AR[f.verdict].label}: ${f.why}`;
  return [
    `النافذة: آخر ${r.days} يوماً. العدّ بالشركة لا بالرسالة.`,
    `النسبة: AML ${Math.round(r.mix.share.aml * 100)}٪ (${r.mix.state.aml}) · الخدمات ${Math.round(r.mix.share.services * 100)}٪ (${r.mix.state.services}) — المستهدف ${r.mix.target.aml * 100}/${r.mix.target.services * 100}.`,
    line(r.overall),
    r.tracks.length ? "بالمسار:" : "", ...r.tracks.map(line),
    r.sectors.length ? "بالقطاع:" : "", ...r.sectors.slice(0, 6).map(line),
    r.angles.length ? "بالزاوية:" : "لا زاوية مسمّاة جُرّبت بعد — الموجات السابقة كُتبت قبل تسمية الزوايا.", ...r.angles.map(line),
    "بنوع العنوان:", ...r.addressTypes.map((a) => `• ${a.label}: ${a.sent} شركة · ارتداد ${a.bounceRate}٪ · ردّ ${a.replied} (${a.replyRate}٪)`),
    "الجمهور الجاهز في القطاعات المستهدفة:", ...r.audience.map((a) => `• ${a.sector}: ${a.ready} جاهزاً من ${a.total}`),
    r.decisions.length ? "قراراتٌ نُفّذت:" : "", ...r.decisions.map((d) => `• ${d.text}`),
    r.needsOwner.length ? "يحتاج صاحب العمل:" : "", ...r.needsOwner.map((x) => `• ${x}`),
  ].filter(Boolean).join("\n");
}
