// ── منصور يأخذ الهدف: من رقمٍ في آخر السنة إلى عدد شركاتٍ اليوم ──
// صاحب العمل قال: «أريد مديراً أعطيه الهدف وهو يقوم بكل شيء». والهدف
// رقمٌ وموعد — «٢٠ عميلاً قبل نهاية السنة». والمدير لا يعمل بالأمنيات:
// يقسم الهدف على القمع (شركة ← ردٌّ نافع ← اجتماع ← عميل)، فيعرف كم
// شركةً يجب أن تُراسَل في اليوم، ويقارنها بما يتّسع له الإرسال وما في
// القوائم من جمهور. ثم يفعل ما يملك (حجم الموجة)، ويقول ما لا يملك
// (قوائم أكثر، سعة إرسال، إذن الموافقة) بالرقم.
//
// نسب القمع تُقاس متى بلغت عيّنتها، وإلا فهي افتراضٌ معلن — ويُقال إنها
// افتراض. والخطة دالةٌ صِرفة: الأرقام تدخل، والقرار يخرج، ويُختبر.

export type GoalMetric = "email_positive" | "meetings" | "clients_won" | "email_replies";

export const GOAL_METRICS: Record<GoalMetric, { label: string; unit: string; one: string }> = {
  email_positive: { label: "ردود نافعة على الإيميل", unit: "رداً نافعاً", one: "ردٍّ نافع" },
  email_replies:  { label: "ردود على الإيميل", unit: "رداً", one: "ردّ" },
  meetings:       { label: "اجتماعات", unit: "اجتماعاً", one: "اجتماع" },
  clients_won:    { label: "عملاء موقّعون", unit: "عميلاً", one: "عميل" },
};

/** افتراضاتٌ حتى تُقاس: ردٌّ نافع من كل مئة شركة، ثلث النافعين يصلون لاجتماع، وربع الاجتماعات تُغلق. */
export const DEFAULT_RATES = { positivePerCompany: 0.01, replyPerCompany: 0.02, meetingPerPositive: 0.3, clientPerMeeting: 0.25 };
/** لا تُعتمد نسبةٌ مقاسة قبل هذه العيّنات. */
export const RATE_SAMPLE = { companies: 300, positives: 10, meetings: 8 };
/** حجم الموجة بين هذين — أصغر من الأدنى لا يُقاس، وأكبر من الأعلى يُغضب المزوّد. */
export const WAVE_BOUNDS = { min: 100, max: 400 };

export interface Rate { value: number; measured: boolean; basis: string }

export interface PlanInput {
  metric: GoalMetric; target: number; current: number;
  startsAt: Date; deadline: Date; now?: Date;
  observed: { companies: number; replied: number; positive: number; meetings: number; clients: number };
  dailyCapacity: number;
  readyAudience: number;
  waveSize: number;
  approvalMode: boolean;
}

export interface Plan {
  remaining: number; daysLeft: number;
  state: "done" | "missed" | "on_track" | "behind";
  expected: number;
  rates: { positive: Rate; reply: Rate; meeting: Rate; client: Rate };
  companiesPerUnit: number;
  companiesNeeded: number;
  perDay: number;
  feasible: boolean;
  waveSize: number;
  blockers: string[];
  assumptions: string[];
  summary: string;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}٪`;
const n = (x: number) => Math.round(x).toLocaleString("en");

function rate(num: number, den: number, min: number, fallback: number, what: string): Rate {
  if (den >= min && num > 0) return { value: num / den, measured: true, basis: `مقاسة: ${num} من ${den}` };
  return { value: fallback, measured: false, basis: `افتراض ${pct(fallback)} — ${what} لم تبلغ عيّنتها (${den} من ${min})` };
}

export function planForGoal(i: PlanInput): Plan {
  const now = i.now ?? new Date();
  const total = Math.max(1, i.deadline.getTime() - i.startsAt.getTime());
  const elapsed = Math.min(total, Math.max(0, now.getTime() - i.startsAt.getTime()));
  const daysLeft = Math.max(0, Math.ceil((i.deadline.getTime() - now.getTime()) / 86_400_000));
  const expected = Math.round(((i.target * elapsed) / total) * 10) / 10;
  const remaining = Math.max(0, i.target - i.current);
  const state: Plan["state"] = i.current >= i.target ? "done" : now > i.deadline ? "missed" : i.current >= expected ? "on_track" : "behind";

  const o = i.observed;
  const rates = {
    positive: rate(o.positive, o.companies, RATE_SAMPLE.companies, DEFAULT_RATES.positivePerCompany, "نسبة الرد النافع"),
    reply:    rate(o.replied, o.companies, RATE_SAMPLE.companies, DEFAULT_RATES.replyPerCompany, "نسبة الرد"),
    meeting:  rate(o.meetings, o.positive, RATE_SAMPLE.positives, DEFAULT_RATES.meetingPerPositive, "نسبة الوصول لاجتماع"),
    client:   rate(o.clients, o.meetings, RATE_SAMPLE.meetings, DEFAULT_RATES.clientPerMeeting, "نسبة الإغلاق"),
  };
  // كم شركةً تُراسَل لكل وحدةٍ من الهدف.
  const perCompany =
    i.metric === "email_replies" ? rates.reply.value
    : i.metric === "email_positive" ? rates.positive.value
    : i.metric === "meetings" ? rates.positive.value * rates.meeting.value
    : rates.positive.value * rates.meeting.value * rates.client.value;
  const companiesPerUnit = Math.ceil(1 / Math.max(perCompany, 1e-6));
  const companiesNeeded = remaining * companiesPerUnit;
  const perDay = daysLeft ? Math.ceil(companiesNeeded / daysLeft) : companiesNeeded;

  const blockers: string[] = [];
  if (state === "done") {
    return { remaining, daysLeft, state, expected, rates, companiesPerUnit, companiesNeeded: 0, perDay: 0, feasible: true,
      waveSize: i.waveSize, blockers, assumptions: [], summary: `الهدف تحقّق: ${i.current} من ${i.target}.` };
  }
  if (perDay > i.dailyCapacity) blockers.push(`الهدف يحتاج ${n(perDay)} شركة يومياً، وسعة الإرسال ${n(i.dailyCapacity)} — ارفع الحصة اليومية أو أضِف نطاق إرسالٍ ثانياً.`);
  if (companiesNeeded > i.readyAudience) blockers.push(`الهدف يحتاج ${n(companiesNeeded)} شركة لم تُراسَل، وفي القوائم المستهدفة ${n(i.readyAudience)} فقط — ارفع قوائم جديدة للقطاعات المستهدفة بنحو ${n(companiesNeeded - i.readyAudience)} شركة.`);
  if (i.approvalMode) blockers.push("كل موجةٍ تنتظر موافقتك قبل أن تخرج — كل يومٍ بلا موافقة يومٌ بلا إرسال. إن أردتني أعمل وحدي فحوّل الطيار إلى «آلي».");

  // ما يملكه المدير: حجم الموجة. يقترب من الحاجة اليومية بين الحدّين وتحت السعة.
  const ceiling = Math.max(WAVE_BOUNDS.min, Math.min(WAVE_BOUNDS.max, i.dailyCapacity));
  const waveSize = Math.max(WAVE_BOUNDS.min, Math.min(ceiling, perDay));

  const assumptions = Object.values(rates).filter((r) => !r.measured).map((r) => r.basis);
  const label = GOAL_METRICS[i.metric];
  const summary = `${i.current} من ${i.target} ${label.unit} (المتوقّع الآن ${expected}). بقي ${remaining} في ${daysLeft} يوماً: كل ${label.one} يحتاج نحو ${n(companiesPerUnit)} شركة، أي ${n(companiesNeeded)} شركة — ${n(perDay)} في اليوم.`;
  return { remaining, daysLeft, state, expected, rates, companiesPerUnit, companiesNeeded, perDay,
    feasible: blockers.filter((b) => !b.startsWith("كل موجةٍ")).length === 0, waveSize, blockers, assumptions, summary };
}

export const STATE_AR: Record<Plan["state"], string> = { done: "تحقّق", missed: "فات موعده", on_track: "على المسار", behind: "متأخر" };
