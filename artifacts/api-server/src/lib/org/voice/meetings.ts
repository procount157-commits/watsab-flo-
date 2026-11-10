// ── اجتماع بإدارة المدير التنفيذي ─────────────────────────────────
// خطوةٌ واحدة في كل طلب (نصف اتجاهي، بالتناوب): افتتاح ← سؤالٌ لكل حاضر وجوابه بدوره هو ←
// دعوة للمخالفة ← قرارات المدير (المؤكَّد بدليل منفصلٌ عن التقدير، وما يخص المالك وحده
// معلَّم) ← قراءة القرارات. كل بند عمل: موظف مسؤول واحد، موعد، نتيجة متوقعة، ويصير تذكرة.
// المدير لا يتكلم بلسان أحد: جواب كل حاضر نداءٌ بدوره هو (asAgent بدوره).
// الجدولة تُحفظ هنا فقط؛ لا تقويم خارجي (محجوب في الجاهزية).

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { audit } from "../controls";
import { CEO_KEY, ensureCeo } from "../ceo";
import { orgRegistry } from "../registry";
import { latestScorecards } from "../scorecards";
import { ensureVoiceTables } from "./schema";
import { availability, findEmployee, type EmployeeRef } from "./context";
import { answerAs, type Line } from "./respond";
import { voiceDeps } from "./deps";
import { createActionTicket, ticketsByIds } from "./tickets";
import { hearOwner, voiceSettings, VoiceError, type TurnInput } from "./calls";
import { MAX_ATTENDEES, MAX_MEETING_MODEL_CALLS, MAX_TICKETS_PER_SESSION, SPOKEN_APPROVAL_NOTE, cleanProposals, isSpokenApproval, rateHit, redact } from "./limits";
import { genderFor } from "./tts";
import { languageOf } from "../../tts";

// ── ترشيح الحضور من الوقائع ───────────────────────────────────────
export interface Recommendation { employeeKey: string; name: string; department: string; reasons: string[]; evidence: string[]; score: number }

/** يرشّح المدير من يحضر، ولماذا، من صفوفٍ حقيقية. لا سبب = لا ترشيح. */
export async function recommendAttendees(userId: number, objective: string, agenda: string[] = []): Promise<{ recommendations: Recommendation[]; note: string | null }> {
  await ensureVoiceTables();
  await ensureCeo(userId);
  const text = `${objective} ${agenda.join(" ")}`.toLowerCase();
  const [staff, cards, overdue] = await Promise.all([
    orgRegistry(userId),
    latestScorecards(userId, "weekly").catch((): Awaited<ReturnType<typeof latestScorecards>> => []),
    db.execute<any>(sql`SELECT owner_role, count(*)::int AS n, array_agg(task_id ORDER BY task_id DESC) AS ids FROM employee_tasks WHERE user_id = ${userId}
      AND status IN ('queued','running','pending','waiting_for_dependency','waiting_for_approval') AND due_at < now() GROUP BY owner_role`),
  ]);
  const late = new Map<string, any>(overdue.rows.map((r: any) => [r.owner_role, r]));
  const DEPT_WORDS: Record<string, string[]> = {
    email: ["email", "بريد", "إيميل", "ايميل", "حملة", "حملات"], whatsapp: ["whatsapp", "واتساب", "واتس"], instagram: ["instagram", "انستقرام", "إنستجرام", "انستجرام"],
    tiktok: ["tiktok", "تيك توك", "تيكتوك"], linkedin: ["linkedin", "لينكدإن", "لينكد"], target_accounts: ["حسابات مستهدفة", "شركات", "target"],
  };
  const out: Recommendation[] = [];
  for (const s of staff) {
    if (s.key === CEO_KEY) continue;
    const reasons: string[] = [], evidence: string[] = [];
    let score = 0;
    const words = [s.key.toLowerCase(), s.name.toLowerCase(), (s.title ?? "").toLowerCase(), ...(DEPT_WORDS[s.department] ?? [])].filter((w) => w.length >= 3);
    if (words.some((w) => text.includes(w))) { score += 3; reasons.push("قسمه أو اسمه مذكور في الهدف أو جدول الأعمال"); }
    if (s.heartbeat_status === "failed" || s.heartbeat_status === "late") { score += 2; reasons.push(`نبضه ${s.heartbeat_status === "failed" ? "فاشل" : "متأخر"}${s.consecutive_failures ? ` (${s.consecutive_failures} إخفاقات متتالية)` : ""}`); evidence.push(`heartbeat:${s.key}`); }
    const l = late.get(s.role);
    if (l) { score += 2; reasons.push(`${l.n} مهام تجاوزت موعدها`); evidence.push(...(l.ids as number[]).slice(0, 5).map((id) => `task:${id}`)); }
    const c = cards.find((x) => x.employeeKey === s.key);
    if (c?.status === "OK" && c.score != null && c.score < 60) { score += 1; reasons.push(`درجته الأسبوعية ${c.score}`); evidence.push(`scorecard:${c.periodKey}`); }
    if (s.permission_status !== "allowed") reasons.push(`تنبيه: ${s.permission_status} — لن يجيب`);
    if (score > 0) out.push({ employeeKey: s.key, name: s.name, department: s.department, reasons, evidence, score });
  }
  out.sort((a, b) => b.score - a.score || a.employeeKey.localeCompare(b.employeeKey));
  const top = out.slice(0, 5);
  return { recommendations: top, note: top.length ? null : "لا وقائع في الحساب تبرّر ترشيح أحد لهذا الهدف — اختر الحضور بنفسك." };
}

// ── القراءة ───────────────────────────────────────────────────────
const MIN_COLS = sql`id, meeting_id, seq, speaker, employee_key, kind, text, lang, source, verified, evidence, flags, stt_model, llm_ms, tts_ms, tts_voice, (audio IS NOT NULL) AS has_audio, created_at`;

async function ownedMeeting(userId: number, id: number): Promise<any> {
  if (!Number.isInteger(id) || id <= 0) throw new VoiceError("الاجتماع غير موجود", 404, "not_found");
  await ensureVoiceTables();
  const [m] = (await db.execute<any>(sql`SELECT * FROM owner_meetings WHERE id = ${id} AND user_id = ${userId}`)).rows;
  if (!m) throw new VoiceError("الاجتماع غير موجود", 404, "not_found");
  return m;
}
async function attendeesOf(userId: number, id: number) {
  return (await db.execute<any>(sql`SELECT a.*, e.name, e.title, e.department FROM meeting_attendees a LEFT JOIN bot_employees e ON e.user_id = a.user_id AND e.employee_key = a.employee_key
    WHERE a.meeting_id = ${id} AND a.user_id = ${userId} ORDER BY a.turn_order`)).rows;
}

export async function getMeeting(userId: number, id: number) {
  const meeting = await ownedMeeting(userId, id);
  const [attendees, minutes, items] = await Promise.all([
    attendeesOf(userId, id),
    db.execute<any>(sql`SELECT ${MIN_COLS} FROM meeting_minutes WHERE meeting_id = ${id} AND user_id = ${userId} ORDER BY seq`),
    db.execute<any>(sql`SELECT * FROM meeting_action_items WHERE meeting_id = ${id} AND user_id = ${userId} ORDER BY id`),
  ]);
  const deadline = meeting.started_at ? new Date(new Date(meeting.started_at).getTime() + Number(meeting.time_limit_min) * 60_000).toISOString() : null;
  return {
    meeting: { ...meeting, deadline, budget: { used: Number(meeting.model_calls), max: MAX_MEETING_MODEL_CALLS }, duplex: "half" },
    attendees, minutes: minutes.rows, actionItems: items.rows, tickets: await ticketsByIds(userId, items.rows.map((x: any) => Number(x.task_id))),
  };
}

export async function listMeetings(userId: number, limit = 30) {
  await ensureVoiceTables();
  const r = await db.execute<any>(sql`SELECT m.id, m.objective, m.state, m.phase, m.scheduled_at, m.started_at, m.ended_at, m.time_limit_min,
      (SELECT count(*)::int FROM meeting_attendees a WHERE a.meeting_id = m.id) AS attendees,
      (SELECT count(*)::int FROM meeting_action_items i WHERE i.meeting_id = m.id) AS action_items
    FROM owner_meetings m WHERE m.user_id = ${userId} ORDER BY m.id DESC LIMIT ${Math.min(Math.max(limit, 1), 100)}`);
  return r.rows;
}

// ── الكتابة ───────────────────────────────────────────────────────
type Kind = "opening" | "question" | "answer" | "dissent" | "owner" | "reply" | "decision" | "readback" | "system";
async function addMinute(userId: number, id: number, m: {
  speaker: "owner" | "ceo" | "employee" | "system"; employeeKey?: string | null; kind: Kind; text: string; lang?: string | null;
  source: "voice" | "text" | "system" | "model" | "template"; verified?: unknown; evidence?: unknown; flags?: unknown; sttModel?: string | null; llmMs?: number | null;
  audio?: Buffer | null; audioMime?: string | null;
}) {
  const ins = () => db.execute<any>(sql`INSERT INTO meeting_minutes (meeting_id, user_id, seq, speaker, employee_key, kind, text, lang, source, verified, evidence, flags, stt_model, llm_ms, audio, audio_mime)
    VALUES (${id}, ${userId}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM meeting_minutes WHERE meeting_id = ${id}), ${m.speaker}, ${m.employeeKey ?? null}, ${m.kind},
      ${redact(m.text).slice(0, 6_000)}, ${m.lang ?? null}, ${m.source}, ${m.verified === undefined ? null : JSON.stringify(m.verified)}::jsonb,
      ${m.evidence === undefined ? null : JSON.stringify(m.evidence)}::jsonb, ${m.flags === undefined ? null : JSON.stringify(m.flags)}::jsonb, ${m.sttModel ?? null}, ${m.llmMs ?? null},
      ${m.audio ?? null}, ${m.audioMime ?? null})
    RETURNING ${MIN_COLS}`);
  return (await ins().catch(() => ins())).rows[0];
}
async function reserve(userId: number, id: number, keepForDecisions = true): Promise<boolean> {
  const cap = keepForDecisions ? MAX_MEETING_MODEL_CALLS - 1 : MAX_MEETING_MODEL_CALLS;
  const r = await db.execute(sql`UPDATE owner_meetings SET model_calls = model_calls + 1 WHERE id = ${id} AND user_id = ${userId} AND model_calls < ${cap}`);
  return (r.rowCount ?? 0) > 0;
}
const setPhase = (userId: number, id: number, phase: string, cursor = 0) =>
  db.execute(sql`UPDATE owner_meetings SET phase = ${phase}, cursor = ${cursor} WHERE id = ${id} AND user_id = ${userId}`);

export interface NewMeeting {
  objective: string; agenda?: string[]; scope?: string | null; timeLimitMin?: number; lang?: "ar" | "en";
  attendees: Array<{ employeeKey: string; reason?: string | null; recommendedBy?: "owner" | "ceo" }>; scheduledAt?: string | null;
}

export async function createMeeting(userId: number, actor: number, i: NewMeeting) {
  await ensureVoiceTables();
  const objective = redact(String(i.objective ?? "").trim()).slice(0, 500);
  if (objective.length < 3) throw new VoiceError("اكتب هدف الاجتماع", 400, "objective_required");
  const agenda = (Array.isArray(i.agenda) ? i.agenda : []).map((x) => redact(String(x ?? "").trim()).slice(0, 200)).filter(Boolean).slice(0, 8);
  const keys = [...new Set((Array.isArray(i.attendees) ? i.attendees : []).map((a) => String(a?.employeeKey ?? "").trim()).filter(Boolean))];
  if (!keys.length) throw new VoiceError("اختر حاضراً واحداً على الأقل", 400, "attendees_required");
  if (keys.length > MAX_ATTENDEES) throw new VoiceError(`الحد ${MAX_ATTENDEES} حضور`, 400, "too_many_attendees");
  if (keys.includes(CEO_KEY)) throw new VoiceError("المدير التنفيذي يدير الاجتماع، لا يُضاف حاضراً", 400, "ceo_is_moderator");
  const rate = rateHit("meetingStart", userId);
  if (!rate.ok) throw new VoiceError("طلبات كثيرة — انتظر قليلاً", 429, "rate_limited", { retryAfterSec: rate.retryAfterSec });
  await ensureCeo(userId);
  const emps: EmployeeRef[] = [];
  for (const k of keys) {
    const e = await findEmployee(userId, k);
    if (!e) throw new VoiceError(`الموظف ${k.slice(0, 60)} غير موجود في هذا الحساب`, 404, "employee_not_found");
    emps.push(e);
  }
  let scheduledAt: Date | null = null;
  if (i.scheduledAt) {
    const d = new Date(i.scheduledAt);
    if (Number.isNaN(d.getTime())) throw new VoiceError("موعد غير صالح", 400, "bad_schedule");
    if (d.getTime() > Date.now() + 60_000) scheduledAt = d;
  }
  const limit = Math.min(60, Math.max(5, Math.round(Number(i.timeLimitMin ?? 20)) || 20));
  const [row] = (await db.execute<any>(sql`INSERT INTO owner_meetings (user_id, started_by, objective, agenda, scope, time_limit_min, state, lang, scheduled_at)
    VALUES (${userId}, ${actor}, ${objective}, ${JSON.stringify(agenda)}::jsonb, ${i.scope ? redact(String(i.scope)).slice(0, 300) : null}, ${limit}, 'scheduled',
      ${i.lang === "en" ? "en" : "ar"}, ${scheduledAt}) RETURNING id`)).rows;
  const id = Number(row.id);
  for (const [n, e] of emps.entries()) {
    const src = i.attendees.find((a) => a.employeeKey === e.key);
    await db.execute(sql`INSERT INTO meeting_attendees (meeting_id, user_id, employee_key, employee_role, turn_order, reason, recommended_by)
      VALUES (${id}, ${userId}, ${e.key}, ${e.role}, ${n + 1}, ${src?.reason ? redact(String(src.reason)).slice(0, 300) : null}, ${src?.recommendedBy === "ceo" ? "ceo" : "owner"})`);
  }
  await audit({ userId, action: "voice.meeting_new", actor, kind: scheduledAt ? "scheduled" : "instant", meta: { meetingId: id } }).catch(() => {});
  return scheduledAt ? getMeeting(userId, id) : startMeeting(userId, actor, id);
}

/** يبدأ الاجتماع: المدير متاح، وحاضرٌ واحد متاح على الأقل؛ وإلا يبقى كما هو بسببٍ معلن. */
export async function startMeeting(userId: number, actor: number, id: number) {
  const m = await ownedMeeting(userId, id);
  if (m.state !== "scheduled") throw new VoiceError(`الاجتماع ${m.state === "in_progress" ? "جارٍ" : "منتهٍ"}`, 409, "bad_state");
  const ceo = await findEmployee(userId, CEO_KEY);
  const ca = ceo ? await availability(userId, ceo, { checkBusy: false }) : { ok: false as const, state: "unavailable" as const, reason: "لا مدير تنفيذي" };
  if (!ca.ok) throw new VoiceError(`المدير التنفيذي غير متاح: ${ca.reason}`, 409, "ceo_unavailable");
  const att = await attendeesOf(userId, id);
  let present = 0;
  for (const a of att) {
    const e = await findEmployee(userId, a.employee_key);
    const av = e ? await availability(userId, e, { checkBusy: false }) : { ok: false as const, reason: "لم يعد موجوداً" };
    await db.execute(sql`UPDATE meeting_attendees SET status = ${av.ok ? "present" : "unavailable"}, status_reason = ${av.ok ? null : (av as any).reason} WHERE id = ${a.id}`);
    if (av.ok) present++;
  }
  if (!present) throw new VoiceError("لا أحد من الحضور متاح الآن — كلهم موقوفون", 409, "no_attendees_available");
  await db.execute(sql`UPDATE owner_meetings SET state = 'in_progress', started_at = now(), phase = 'opening', cursor = 0 WHERE id = ${id} AND user_id = ${userId}`);
  const fresh = await attendeesOf(userId, id);
  const agenda: string[] = Array.isArray(m.agenda) ? m.agenda : [];
  const roster = fresh.map((a: any) => `${a.name ?? a.employee_key} (${a.employee_key})${a.status === "present" ? "" : ` — غير متاح: ${a.status_reason}`}`).join("، ");
  await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "opening", source: "template", lang: m.lang, text: [
    `نفتتح الاجتماع. الهدف: ${m.objective}.`,
    agenda.length ? `جدول الأعمال: ${agenda.map((x, n) => `${n + 1}) ${x}`).join(" ")}.` : "لا جدول أعمال مكتوب؛ نلتزم بالهدف.",
    `النطاق: ${m.scope ?? "هذا الحساب وحده"}. المدة ${m.time_limit_min} دقيقة.`,
    `الحضور: ${roster}.`,
    "سأسأل كل واحد بدوره عن الوقائع والتقدّم والدليل والعوائق، ثم أفتح باب المخالفة، ثم أقرأ القرارات: لكل بند مسؤول وموعد ومقياس.",
    "الكلام بالتناوب لا في آن واحد. ما يحتاج قرار المالك وحده سأعلّمه، ولا يُعتمد شيء بالكلام: الموافقة من صفحة الموافقات.",
  ].join(" ") });
  await setPhase(userId, id, "round", 0);
  await audit({ userId, action: "voice.meeting_start", actor, meta: { meetingId: id, present } }).catch(() => {});
  return getMeeting(userId, id);
}

const meetingLines = async (userId: number, id: number): Promise<Line[]> =>
  (await db.execute<any>(sql`SELECT m.speaker, m.text, e.name FROM meeting_minutes m LEFT JOIN bot_employees e ON e.user_id = m.user_id AND e.employee_key = m.employee_key
    WHERE m.meeting_id = ${id} AND m.user_id = ${userId} ORDER BY m.seq DESC LIMIT 24`)).rows.reverse()
    .map((r: any) => ({ speaker: r.speaker, name: r.speaker === "ceo" ? "المدير التنفيذي" : r.name, text: r.text }));

const brief = (m: any) => ({ objective: m.objective, agenda: Array.isArray(m.agenda) ? m.agenda : [], scope: m.scope ?? null });

/** حاضرٌ يجيب بدوره هو. أوقف أثناء الاجتماع؟ يُعلَّم غير متاح ويُقال ذلك. */
async function attendeeSpeaks(userId: number, m: any, a: any, kind: "answer" | "dissent" | "reply", instruction: string, utterance: string) {
  const e = await findEmployee(userId, a.employee_key);
  const av = e ? await availability(userId, e, { checkBusy: false }) : { ok: false as const, reason: "لم يعد موجوداً" };
  if (!e || !av.ok) {
    const reason = (av as any).reason ?? "غير متاح";
    await db.execute(sql`UPDATE meeting_attendees SET status = 'unavailable', status_reason = ${reason} WHERE id = ${a.id}`);
    return addMinute(userId, m.id, { speaker: "system", kind: "system", source: "system", text: `${a.name ?? a.employee_key} غير متاح الآن: ${reason}` });
  }
  if (!(await reserve(userId, m.id))) return null;
  const ans = await answerAs({ userId, emp: e, history: await meetingLines(userId, m.id), utterance, lang: m.lang === "en" ? "en" : "ar", mode: "meeting", instruction, meeting: brief(m) });
  if (!ans.ok) return addMinute(userId, m.id, { speaker: "system", kind: "system", source: "system", text: `لم يصل جواب ${e.name}: ${ans.reason}`, llmMs: ans.ms });
  return addMinute(userId, m.id, { speaker: "employee", employeeKey: e.key, kind, source: "model", lang: m.lang, text: ans.reply, evidence: ans.evidence, llmMs: ans.ms,
    flags: { provider: ans.provider, droppedEvidence: ans.dropped, proposals: ans.proposals } });
}

/** خطوة واحدة من إدارة المدير. */
export async function nextStep(userId: number, id: number) {
  const m = await ownedMeeting(userId, id);
  if (m.state !== "in_progress") throw new VoiceError("الاجتماع ليس جارياً", 409, "bad_state");
  const deadline = new Date(m.started_at).getTime() + Number(m.time_limit_min) * 60_000;
  if ((m.phase === "round" || m.phase === "dissent") && Date.now() > deadline) {
    await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "system", source: "template", text: "انتهى الوقت المحدد. ننتقل إلى القرارات." });
    await setPhase(userId, id, "decisions"); return getMeeting(userId, id);
  }
  if ((m.phase === "round" || m.phase === "dissent") && Number(m.model_calls) >= MAX_MEETING_MODEL_CALLS - 1) {
    await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: "بلغ الاجتماع حدّ نداءات النموذج؛ يبقى نداءٌ واحد للقرارات." });
    await setPhase(userId, id, "decisions"); return getMeeting(userId, id);
  }
  const present = (await attendeesOf(userId, id)).filter((a: any) => a.status === "present");
  const cursor = Number(m.cursor);
  if (m.phase === "round") {
    const a = present.filter((x: any) => x.turn_order > cursor)[0];
    if (!a) { await setPhase(userId, id, "dissent", 0); return nextStep(userId, id); }
    const q = `${a.name ?? a.employee_key}: ما الوقائع والتقدّم والدليل والعوائق عندك بخصوص «${m.objective}»؟ اذكر معرّفات الدليل، وافصل المؤكد عن تقديرك.`;
    await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "question", source: "template", lang: m.lang, text: q });
    await attendeeSpeaks(userId, m, a, "answer", "أجب سؤال المدير التنفيذي بدورك: وقائع بدليل، التقدّم، العوائق. لا تتكلم عن عمل غيرك.", q);
    await setPhase(userId, id, "round", a.turn_order);
    return getMeeting(userId, id);
  }
  if (m.phase === "dissent") {
    const a = present.filter((x: any) => x.turn_order > cursor)[0];
    if (!a) { await setPhase(userId, id, "decisions"); return nextStep(userId, id); }
    if (cursor === 0) await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "question", source: "template", lang: m.lang,
      text: "قبل القرارات: هل لدى أحدكم اعتراض أو دليل يخالف ما قيل؟ قولوه الآن بدليله." });
    await attendeeSpeaks(userId, m, a, "dissent", "إن كان لديك اعتراض على ما قيل أو دليل يخالفه فقله باختصار بدليله؛ وإلا فقل «لا اعتراض» فقط.", "هل لديك اعتراض؟");
    await setPhase(userId, id, "dissent", a.turn_order);
    return getMeeting(userId, id);
  }
  if (m.phase === "decisions") return decide(userId, m, present);
  throw new VoiceError("الاجتماع مغلق", 409, "closed");
}

/** قرارات المدير: يُقبل المؤكَّد بدليلٍ ظهر في المحضر فقط، وبند العمل بمسؤول حاضر وموعد ونتيجة. */
async function decide(userId: number, m: any, present: any[]) {
  const id = Number(m.id);
  const ceo = await findEmployee(userId, CEO_KEY);
  if (!ceo || !(await reserve(userId, id, false))) throw new VoiceError("نفدت ميزانية نداءات النموذج للاجتماع — أنهِه", 429, "budget_exhausted");
  const minutes = (await db.execute<any>(sql`SELECT evidence FROM meeting_minutes WHERE meeting_id = ${id} AND user_id = ${userId} AND evidence IS NOT NULL`)).rows;
  const said = new Set<string>(minutes.flatMap((r: any) => (Array.isArray(r.evidence) ? r.evidence.map(String) : [])));
  const allowed = new Set<string>([CEO_KEY, ...present.map((a: any) => a.employee_key)]);
  const ans = await answerAs({
    userId, emp: ceo, history: await meetingLines(userId, id), utterance: "اختم الاجتماع بالقرارات.", lang: m.lang === "en" ? "en" : "ar", mode: "meeting", meeting: brief(m), maxWords: 160,
    instruction: [
      "اختم: افصل الوقائع المؤكدة (كلٌّ بمعرّف دليلٍ ورد في المحضر) عن التقديرات، وعلّم ما يحتاج قرار المالك وحده،",
      `واكتب بنود العمل: لكل بند موظف مسؤول واحد من ${[...allowed].join(", ")}، وموعد بالأيام، ومقياس، ونتيجة متوقعة. لا تنسب لأحد كلاماً لم يقله.`,
    ].join(" "),
    schemaHint: '"verified_facts":[{"text":"…","evidence":["task:1"]}],"estimates":["…"],"owner_decisions":["…"],"action_items":[{"title":"…","employee_key":"…","due_in_days":7,"metric":"…","expected_outcome":"…"}]',
  });
  if (!ans.ok) {
    await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: `لم يصل جواب المدير: ${ans.reason}. لا قرارات مخترعة — أعد المحاولة أو أنهِ الاجتماع.` });
    return getMeeting(userId, id);
  }
  const raw = ans.raw ?? {};
  const verified: Array<{ text: string; evidence: string[] }> = [];
  const estimates: string[] = (Array.isArray(raw["estimates"]) ? raw["estimates"] : []).map((x: unknown) => redact(String(x)).slice(0, 300)).slice(0, 10);
  for (const f of Array.isArray(raw["verified_facts"]) ? raw["verified_facts"] : []) {
    const text = redact(String(f?.text ?? "")).slice(0, 300);
    const ev = (Array.isArray(f?.evidence) ? f.evidence.map(String) : []).filter((x: string) => said.has(x));
    if (!text) continue;
    if (ev.length) verified.push({ text, evidence: ev }); else estimates.push(`${text} (بلا دليل في المحضر — تقدير)`);
  }
  const ownerDecisions = (Array.isArray(raw["owner_decisions"]) ? raw["owner_decisions"] : []).map((x: unknown) => redact(String(x)).slice(0, 300)).slice(0, 10);
  const items = cleanProposals(raw["action_items"], MAX_TICKETS_PER_SESSION);
  const accepted: any[] = [], rejected: string[] = [];
  for (const [n, p] of items.entries()) {
    if (!p.employeeKey || !allowed.has(p.employeeKey)) { rejected.push(`«${p.title}»: المسؤول ${p.employeeKey ?? "غير محدد"} ليس من الحضور`); continue; }
    const e = p.employeeKey === CEO_KEY ? ceo : await findEmployee(userId, p.employeeKey);
    if (!e) { rejected.push(`«${p.title}»: المسؤول غير موجود`); continue; }
    const dueAt = new Date(Date.now() + p.dueInDays * 86_400_000);
    const t = await createActionTicket({ userId, ownerRole: e.role, employeeKey: e.key, title: p.title, expectedOutcome: p.expectedOutcome, metric: p.metric, dueAt,
      source: { kind: "meeting", id, ref: `item${n}` }, createdByRole: ceo.role, idempotencyKey: `meeting:${id}:item:${n}` });
    const [row] = (await db.execute<any>(sql`INSERT INTO meeting_action_items (meeting_id, user_id, title, employee_key, due_at, expected_outcome, metric, owner_decision, task_id)
      VALUES (${id}, ${userId}, ${p.title}, ${e.key}, ${dueAt}, ${p.expectedOutcome}, ${p.metric}, false, ${t.taskId}) RETURNING *`)).rows;
    accepted.push(row);
  }
  await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "decision", source: "model", lang: m.lang, text: ans.reply, evidence: ans.evidence, llmMs: ans.ms,
    verified: { verified, estimates, ownerDecisions, rejected } });
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const readback = [
    accepted.length ? `أقرأ القرارات: ${accepted.map((r, n) => `${n + 1}) ${r.title} — المسؤول ${r.employee_key} — الموعد ${fmt(new Date(r.due_at))}${r.metric ? ` — المقياس: ${r.metric}` : ""} — النتيجة المتوقعة: ${r.expected_outcome} (تذكرة #${r.task_id} تنتظر موافقتك)`).join(". ")}.` : "لا بنود عمل مكتملة الشروط.",
    ownerDecisions.length ? `قرارات لك وحدك: ${ownerDecisions.join("؛ ")}.` : "",
    rejected.length ? `بنود لم تُقبل: ${rejected.join("؛ ")}.` : "",
    `وقائع مؤكدة بدليل: ${verified.length}؛ تقديرات: ${estimates.length}.`,
  ].filter(Boolean).join(" ");
  await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "readback", source: "template", lang: m.lang, text: readback });
  await db.execute(sql`UPDATE owner_meetings SET phase = 'closed', state = 'ended', ended_at = now(), end_reason = 'اختُتم بالقرارات', summary = ${redact(ans.reply).slice(0, 3_000)} WHERE id = ${id} AND user_id = ${userId}`);
  return getMeeting(userId, id);
}

/** المالك يتكلم أو يكتب: يسأل حاضراً بعينه (to) أو المدير. */
export async function ownerSays(userId: number, id: number, i: TurnInput & { to?: string | null }) {
  const m = await ownedMeeting(userId, id);
  if (m.state !== "in_progress") throw new VoiceError("الاجتماع ليس جارياً", 409, "bad_state");
  const r = rateHit("turn", userId);
  if (!r.ok) throw new VoiceError("طلبات كثيرة — انتظر قليلاً", 429, "rate_limited", { retryAfterSec: r.retryAfterSec });
  const heard = await hearOwner(userId, i, m.lang);
  const { callRecording } = await voiceSettings(userId);
  const spoken = isSpokenApproval(heard.text);
  await addMinute(userId, id, { speaker: "owner", kind: "owner", source: heard.source, lang: heard.lang, text: heard.text, sttModel: heard.sttModel,
    flags: spoken ? { spokenApproval: true, authorizes: false } : undefined,
    audio: callRecording && heard.source === "voice" ? i.audio ?? null : null, audioMime: callRecording && heard.source === "voice" ? heard.mime : null });
  if (spoken) await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: SPOKEN_APPROVAL_NOTE, flags: { spokenApproval: true, authorizes: false } });
  const to = i.to ? String(i.to) : null;
  if (to && to !== CEO_KEY) {
    const a = (await attendeesOf(userId, id)).find((x: any) => x.employee_key === to);
    if (!a) throw new VoiceError("هذا الموظف ليس من حضور الاجتماع", 404, "not_attendee");
    if (a.status !== "present") { await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: `${a.name ?? to} غير متاح: ${a.status_reason}` }); return getMeeting(userId, id); }
    const out = await attendeeSpeaks(userId, m, a, "reply", "أجب سؤال المالك مباشرةً بدورك، بدليل.", heard.text);
    if (!out) throw new VoiceError("نفدت ميزانية النموذج للاجتماع — يبقى نداء للقرارات", 429, "budget_exhausted");
    return getMeeting(userId, id);
  }
  const ceo = await findEmployee(userId, CEO_KEY);
  if (!ceo || !(await reserve(userId, id))) throw new VoiceError("نفدت ميزانية النموذج للاجتماع — يبقى نداء للقرارات", 429, "budget_exhausted");
  const ans = await answerAs({ userId, emp: ceo, history: await meetingLines(userId, id), utterance: heard.text, lang: heard.lang, mode: "meeting", meeting: brief(m),
    instruction: "أجب المالك بصفتك مدير الاجتماع. إن طلب دليلاً فاذكر المعرّف من المحضر أو السياق، أو قل إنه غير موجود. لا تتكلم بلسان أي حاضر." });
  if (!ans.ok) await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: `لم يصل جواب المدير: ${ans.reason}` });
  else await addMinute(userId, id, { speaker: "ceo", employeeKey: CEO_KEY, kind: "reply", source: "model", lang: heard.lang, text: ans.reply, evidence: ans.evidence, llmMs: ans.ms, flags: { provider: ans.provider } });
  return getMeeting(userId, id);
}

export async function endMeeting(userId: number, actor: number, id: number) {
  const m = await ownedMeeting(userId, id);
  if (m.state === "in_progress" || m.state === "scheduled") {
    await db.execute(sql`UPDATE owner_meetings SET state = ${m.state === "scheduled" ? "cancelled" : "ended"}, phase = 'closed', ended_at = now(), end_reason = 'أنهاه المالك' WHERE id = ${id} AND user_id = ${userId}`);
    if (m.state === "in_progress") await addMinute(userId, id, { speaker: "system", kind: "system", source: "system", text: "أنهى المالك الاجتماع قبل القرارات." });
    await audit({ userId, action: "voice.meeting_end", actor, meta: { meetingId: id } }).catch(() => {});
  }
  return getMeeting(userId, id);
}

export async function minuteAudio(userId: number, id: number, minuteId: number): Promise<{ audio: Buffer; mime: string; voice: string | null }> {
  await ownedMeeting(userId, id);
  const [l] = (await db.execute<any>(sql`SELECT id, speaker, employee_key, text, lang, audio, audio_mime FROM meeting_minutes WHERE id = ${minuteId} AND meeting_id = ${id} AND user_id = ${userId}`)).rows;
  if (!l) throw new VoiceError("السطر غير موجود", 404, "not_found");
  if (l.speaker === "owner" || l.speaker === "system") {
    if (!l.audio) throw new VoiceError("لا صوت محفوظ لهذا السطر", 404, "no_audio");
    return { audio: Buffer.from(l.audio), mime: l.audio_mime ?? "audio/webm", voice: null };
  }
  const r = rateHit("tts", userId);
  if (!r.ok) throw new VoiceError("طلبات كثيرة — انتظر قليلاً", 429, "rate_limited", { retryAfterSec: r.retryAfterSec });
  const lang = l.lang === "en" ? "en" : l.lang === "ar" ? "ar" : languageOf(l.text);
  const t0 = Date.now();
  const v = await voiceDeps().tts(l.text, lang, genderFor(l.employee_key));
  if (!v) throw new VoiceError("تعذّر توليد الصوت — النص ظاهر", 502, "tts_failed");
  await db.execute(sql`UPDATE meeting_minutes SET tts_ms = COALESCE(tts_ms, ${Date.now() - t0}), tts_voice = COALESCE(tts_voice, ${v.voice}) WHERE id = ${minuteId}`);
  return { audio: v.audio, mime: "audio/mpeg", voice: v.voice };
}
