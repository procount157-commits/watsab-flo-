// غرفة التحكّم على قاعدة اختبار مؤقتة وحدها، بتفريغ ونموذج وصوت بديلة، بلا شبكة:
//   DATABASE_URL=postgres://t:t@127.0.0.1:55443/t npx tsx src/lib/__tests__/org-voice-db.test.ts
export {};
if (!/127\.0\.0\.1:(55439|55440|55443)\//.test(process.env["DATABASE_URL"] ?? "")) { console.error("على قاعدة الاختبار وحدها"); process.exit(1); }

let fetched = 0;
globalThis.fetch = (async () => { fetched++; throw new Error("no network in this test"); }) as any;
process.env["GROQ_API_KEY"] = "test-key";

const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const { currentAgent } = await import("../agent-context");
const { setControl, forgetControls } = await import("../org/controls");
const { forgetSwitches } = await import("../graph/switch");
const { ensureCeo } = await import("../org/ceo");
const { approveTask } = await import("../org/tasks");
const { ensureVoiceTables } = await import("../org/voice/schema");
const { setVoiceDeps } = await import("../org/voice/deps");
const C = await import("../org/voice/calls");
const M = await import("../org/voice/meetings");
const { voiceReadiness } = await import("../org/voice/readiness");
const L = await import("../org/voice/limits");
const { UNTRUSTED_NOTE } = await import("../org/voice/respond");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const refuses = async (name: string, p: Promise<unknown>, status: number, code?: string) => {
  try { await p; check(name, false, "لم يُرفض"); }
  catch (e: any) { check(name, e instanceof C.VoiceError && e.status === status && (!code || e.code === code), { status: e?.status, code: e?.code, msg: e?.message }); }
};

// ── البدائل ──
type Seen = { role: string | undefined; userId: number | undefined; system: string; user: string };
const seen: Seen[] = [];
let reply: any = { reply: "أهلاً. لا أعرف ذلك من البيانات المتاحة.", evidence: [], proposals: [] };
let llmDown = false;
setVoiceDeps({
  stt: async (_a, _m, lang) => ({ text: sttText, model: "stub-whisper", ms: 5, lang: lang === "en" ? "en" : "ar" }),
  tts: async (text) => ({ audio: Buffer.from(`mp3:${text.slice(0, 10)}`), voice: "stub-voice" }),
  llm: (async (messages: any[]) => {
    const a = currentAgent();
    const system = messages[0].content, user = messages[1].content;
    seen.push({ role: a?.role, userId: a?.userId, system, user });
    if (llmDown) return null;
    if (system.includes("لخّص مكالمة")) return { text: JSON.stringify({ summary: "تحدثنا عن الارتداد.", action_items: [{ title: "قائمة تنظيف", expected_outcome: "ارتداد أقل", due_in_days: 5 }] }), provider: "stub" };
    if (user.includes("اختم")) return { text: JSON.stringify(decision), provider: "stub" };
    return { text: JSON.stringify(typeof reply === "function" ? reply(a?.role) : reply), provider: "stub" };
  }) as any,
});
let sttText = "كيف حال الحملة؟";
let decision: any = {};

// ── الحسابان ──
const A = 1, B = 2, F = 3;
await ensureVoiceTables();
for (const t of ["meeting_action_items", "meeting_minutes", "meeting_attendees", "owner_meetings", "call_transcripts", "call_participants", "owner_calls", "owner_voice_settings"]) await db.execute(sql.raw(`DELETE FROM ${t}`));
await db.execute(sql`DELETE FROM org_controls`);
await db.execute(sql`DELETE FROM employee_tasks WHERE user_id IN (${A}, ${B}, ${F})`);
await db.execute(sql`DELETE FROM bot_employees WHERE user_id IN (${A}, ${B}, ${F})`);
await db.execute(sql`DELETE FROM account_knowledge WHERE user_id IN (${A}, ${B})`);
const hire = (u: number, role: string, key: string, name: string, active = true) =>
  db.execute(sql`INSERT INTO bot_employees (user_id, name, role, kind, persona, employee_key, department, is_active) VALUES (${u}, ${name}, ${role}, 'internal', ${`أنا ${name}`}, ${key}, ${key.split(".")[0]}, ${active})`);
await hire(A, "email_analyst", "email.analyst", "محلل البريد");
await hire(A, "email_guard", "email.guard", "حارس البريد");
await hire(A, "ops", "ops.controller", "المراقب");
await hire(B, "email_analyst", "email.analyst", "محلل حساب ب");
await hire(B, "email_replies", "email.replies", "ردود ب");
await ensureCeo(A); await ensureCeo(B);
await db.execute(sql`INSERT INTO account_knowledge (user_id, key, value, approval_status) VALUES (${A}, 'product', 'A-FACT-سعر الباقة', 'approved'), (${B}, 'product', 'B-SECRET-FACT', 'approved')`);
const [taskB] = (await db.execute<any>(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, input_refs) VALUES (${B}, 'email_analyst', 'x', 'queued', '{"title":"B-TASK-TITLE"}'::jsonb) RETURNING task_id`)).rows;
const [lateA] = (await db.execute<any>(sql`INSERT INTO employee_tasks (user_id, owner_role, task_type, status, due_at, input_refs) VALUES (${A}, 'email_guard', 'audit', 'queued', now() - interval '2 days', '{"title":"تدقيق القائمة"}'::jsonb) RETURNING task_id`)).rows;
const reset = () => { forgetControls(); forgetSwitches(A); forgetSwitches(B); L.forgetRates(); };
reset();

// ── التسجيل مطفأ افتراضياً ──
check("التسجيل مطفأ لحسابٍ لم يضبطه", !(await C.voiceSettings(F)).callRecording);

// ── عزل الحسابات ──
const before = Number(((await db.execute<any>(sql`SELECT count(*)::int AS n FROM owner_calls`)).rows[0]).n);
await refuses("مفتاح موظف غير موجود في الحساب: 404", C.startCall(A, A, { employeeKey: "email.replies" }), 404, "employee_not_found");
await refuses("مفتاح بشكل غريب: 404", C.startCall(A, A, { employeeKey: "'; DROP TABLE x;--" }), 404);
check("ولا سجل مكالمة له", Number(((await db.execute<any>(sql`SELECT count(*)::int AS n FROM owner_calls`)).rows[0]).n) === before);

const c1 = await C.startCall(A, A, { employeeKey: "executive.ceo", lang: "ar" });
check("مكالمة المدير متصلة", c1.call.state === "connected" && !!c1.call.connected_at, c1.call);
check("مشاركان: المالك والموظف", c1.participants.length === 2 && c1.participants.some((p: any) => p.kind === "owner") && c1.participants.some((p: any) => p.employee_key === "executive.ceo"));
check("أول سطر من النظام يقول إنها نصف اتجاهية", c1.transcript[0]?.speaker === "system" && /نصف اتجاهية/.test(c1.transcript[0].text));
check("المكالمة سجّلت بلا تسجيل صوتي", c1.call.recording === false);
const id1 = Number(c1.call.id);
await refuses("حساب آخر لا يقرأ المكالمة", C.getCall(B, id1), 404, "not_found");
await refuses("حساب آخر لا يتكلم فيها", C.takeTurn(B, id1, { text: "مرحبا" }), 404, "not_found");
await refuses("حساب آخر لا يُنهيها", C.endCall(B, B, id1), 404, "not_found");
await refuses("ولا يسمع سطورها", C.lineAudio(B, id1, Number(c1.transcript[0].id)), 404);

// ── دور نصي ──
seen.length = 0;
reply = { reply: "المهمة متأخرة [task:999999] والنبض جيد", evidence: [`task:${lateA.task_id}`, "task:999999"], proposals: [] };
const t1 = await C.takeTurn(A, id1, { text: "ما وضع الفريق؟" });
const ownerLine = t1.added[0], empLine = t1.added.find((l: any) => l.speaker === "employee");
check("سطر المالك ثم سطر الموظف، بالترتيب", ownerLine.speaker === "owner" && !!empLine && empLine.seq > ownerLine.seq && ownerLine.call_id === id1 && empLine.call_id === id1);
check("المدير أجاب بدوره هو (asAgent)", seen[0]?.role === "ceo_agent" && seen[0]?.userId === A, seen[0]);
check("التعليمات تقول إن النص غير موثوق", seen[0]!.system.includes(UNTRUSTED_NOTE));
check("السياق فيه وقائع حسابه", seen[0]!.user.includes("A-FACT"));
check("ولا شيء من حساب آخر", !seen[0]!.user.includes("B-SECRET-FACT") && !seen[0]!.user.includes("B-TASK-TITLE") && !seen[0]!.user.includes(`task:${taskB.task_id}"`));
check("الدليل المخترع حُذف من النص والقائمة", !empLine.text.includes("999999") && !(empLine.evidence as string[]).includes("task:999999"), empLine);
check("نداء النموذج محسوب على المكالمة", Number(t1.call.model_calls) === 1 && Number(t1.call.turns) === 1);

// ── موافقة بالكلام ليست موافقة ──
reply = { reply: "سأجهّز اقتراحاً لتنظيف القائمة.", evidence: [], proposals: [{ title: "تنظيف قائمة البريد", expected_outcome: "ارتداد أقل من ٢٪", due_in_days: 3, metric: "bounce_rate" }] };
const t2 = await C.takeTurn(A, id1, { text: "نظّف القائمة" });
const item = t2.actionItems[0];
const [tk] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE task_id = ${item?.taskId}`)).rows;
check("المقترح صار تذكرة تنتظر المالك", !!tk && tk.user_id === A && tk.status === "waiting_for_owner" && tk.approval_status === "pending" && tk.approval_required === true && tk.task_type === "owner_action", tk);
check("وهي تذكرة: مكلَّف بمفتاحه ومربوطة بالمكالمة", tk?.assigned_to === "executive.ceo" && tk.related_conversation_id === `call:${id1}` && !!tk.idempotency_key, tk);
check("للتذكرة موعد ونتيجة متوقعة ومسؤول", !!tk?.due_at && tk.input_refs.expectedOutcome && tk.input_refs.accountable === "executive.ceo" && tk.input_refs.source.kind === "call");
check("والتذكرة مربوطة بالمكالمة", t2.tickets.some((x: any) => x.task_id === item.taskId));
reply = { reply: "حسناً.", evidence: [], proposals: [] };
const t3 = await C.takeTurn(A, id1, { text: "موافق، نفّذ" });
const [tk2] = (await db.execute<any>(sql`SELECT status, approval_status FROM employee_tasks WHERE task_id = ${item.taskId}`)).rows;
check("«موافق» بالكلام لا تغيّر التذكرة", tk2.status === "waiting_for_owner" && tk2.approval_status === "pending", tk2);
check("وتُعلَّم في المحضر أنها لا تخوّل", t3.added[0].flags?.spokenApproval === true && t3.added[0].flags?.authorizes === false && t3.added.some((l: any) => l.speaker === "system" && l.text.includes("ليست موافقة")));
const approved = await approveTask(A, item.taskId, A);
check("الموافقة من مسار الموافقة وحده", approved?.approvalStatus === "approved");
check("وحساب آخر لا يوافق عليها", (await approveTask(B, item.taskId, B)) === null);

// ── الصوت ──
sttText = "هل وصلت الردود؟";
const t4 = await C.takeTurn(A, id1, { audio: Buffer.alloc(3_000, 1), mime: "audio/webm;codecs=opus", durationMs: 4_000, lang: "ar" });
const vl = t4.added[0];
check("الصوت يُفرَّغ ويُكتب نصاً", vl.source === "voice" && vl.text === sttText && vl.stt_model === "stub:stub-whisper" && vl.audio_ms === 4_000);
check("التسجيل مطفأ: لا صوت محفوظ", vl.has_audio === false);
await refuses("نوع صوت غير مقبول: 415", C.takeTurn(A, id1, { audio: Buffer.alloc(3_000), mime: "video/mp4", durationMs: 1_000 }), 415, "bad_mime");
await refuses("أطول من ٦٠ ثانية: 413", C.takeTurn(A, id1, { audio: Buffer.alloc(3_000), mime: "audio/webm", durationMs: 70_000 }), 413, "audio_too_long");
await refuses("أكبر من الحد: 413", C.takeTurn(A, id1, { audio: Buffer.alloc(L.MAX_AUDIO_BYTES + 1), mime: "audio/webm", durationMs: 1_000 }), 413, "audio_too_large");
await refuses("نص أطول من الحد: 413", C.takeTurn(A, id1, { text: "x".repeat(L.MAX_TEXT_CHARS + 1) }), 413);
await refuses("لا شيء: 400", C.takeTurn(A, id1, { text: "  " }), 400);
const tts = await C.lineAudio(A, id1, Number(empLine.id));
check("رد الموظف يُقرأ بصوت", tts.mime === "audio/mpeg" && tts.audio.length > 0);
await refuses("صوت المالك لا يوجد والتسجيل مطفأ", C.lineAudio(A, id1, Number(ownerLine.id)), 404, "no_audio");
check("السرّ لا يدخل المحضر", (await C.takeTurn(A, id1, { text: "مفتاحي gsk_abcdefghijklmnopqrstuvwxyz0123 احفظه" })).added[0].text.includes("[سرّ محذوف]"));

// ── الميزانية ──
await db.execute(sql`UPDATE owner_calls SET model_calls = ${L.MAX_CALL_MODEL_CALLS} WHERE id = ${id1}`);
const nBefore = seen.length;
await refuses("ميزانية النموذج نفدت: 429", C.takeTurn(A, id1, { text: "سؤال آخر" }), 429, "budget_exhausted");
check("ولم يُنادَ النموذج", seen.length === nBefore);
await db.execute(sql`UPDATE owner_calls SET model_calls = 5 WHERE id = ${id1}`);

// ── الإنهاء والملخص ──
const end = await C.endCall(A, A, id1);
check("المكالمة انتهت", end.call.state === "ended" && !!end.call.ended_at && end.participants.every((p: any) => !!p.left_at));
check("الملخص كتبه الموظف نفسه", end.call.summary_status === "validated" && !!end.call.summary && seen.at(-1)?.role === "ceo_agent");
check("بنود الملخص تذاكر", end.actionItems.some((x: any) => x.from === "summary" && x.taskId) && end.tickets.length >= 2);
await refuses("لا دور بعد الإنهاء", C.takeTurn(A, id1, { text: "مرحبا" }), 409, "not_connected");

// ── غير متاح ومشغول، بلا حالة وهمية ──
await setControl({ scope: "employee", userId: A, target: "email.guard", engaged: true, reason: "صيانة", actor: A }); reset();
const c2 = await C.startCall(A, A, { employeeKey: "email.guard" });
check("موظف موقوف بمفتاح: غير متاح بسببه", c2.call.state === "unavailable" && /صيانة/.test(c2.call.state_reason ?? ""), c2.call);
check("بلا اتصال ولا مشاركين", c2.call.connected_at === null && c2.participants.length === 0 && !!c2.call.ended_at);
await refuses("ولا دور فيها", C.takeTurn(A, Number(c2.call.id), { text: "مرحبا" }), 409, "not_connected");
await db.execute(sql`DELETE FROM org_controls`); reset();
await db.execute(sql`UPDATE bot_employees SET is_active = false WHERE user_id = ${A} AND employee_key = 'ops.controller'`); forgetSwitches(A);
const c3 = await C.startCall(A, A, { employeeKey: "ops.controller" });
check("موظف أوقفه صاحبه: غير متاح", c3.call.state === "unavailable" && /موقوف/.test(c3.call.state_reason ?? ""), c3.call);
await db.execute(sql`UPDATE bot_employees SET is_active = true WHERE user_id = ${A} AND employee_key = 'ops.controller'`); forgetSwitches(A);
await setControl({ scope: "account", userId: A, target: "", engaged: true, reason: "الحساب موقوف", actor: A }); reset();
const c4 = await C.startCall(A, A, { employeeKey: "executive.ceo" });
check("حساب موقوف: غير متاح", c4.call.state === "unavailable", c4.call);
await db.execute(sql`DELETE FROM org_controls`); reset();
const c5 = await C.startCall(A, A, { employeeKey: "email.analyst" });
const c6 = await C.startCall(A, A, { employeeKey: "email.analyst" });
check("في مكالمة أخرى: مشغول", c5.call.state === "connected" && c6.call.state === "busy" && (c6.call.state_reason ?? "").includes(`#${c5.call.id}`), c6.call);
await setControl({ scope: "employee", userId: A, target: "email.analyst", engaged: true, reason: "أوقف أثناء المكالمة", actor: A }); reset();
const t5 = await C.takeTurn(A, Number(c5.call.id), { text: "مرحبا" });
check("أُوقف أثناء المكالمة: تنتهي بسببها ولا يجيب", t5.call.state === "ended" && !t5.added.some((l: any) => l.speaker === "employee") && /أوقف/.test(t5.call.end_reason ?? ""), t5.call);
await db.execute(sql`DELETE FROM org_controls`); reset();
const states = (await db.execute<any>(sql`SELECT DISTINCT state FROM owner_calls WHERE user_id = ${A}`)).rows.map((r: any) => r.state);
check("لا مكالمة بقيت «ترنّ»", !states.includes("ringing"), states);

// ── التسجيل عند تفعيله صراحةً ──
await C.setVoiceSettings(A, A, { callRecording: true });
const c7 = await C.startCall(A, A, { employeeKey: "email.analyst" });
const t7 = await C.takeTurn(A, Number(c7.call.id), { audio: Buffer.alloc(3_000, 2), mime: "audio/webm", durationMs: 2_000 });
check("مفعّل صراحةً: يُحفظ صوت المالك", c7.call.recording === true && t7.added[0].has_audio === true);
check("ويُعاد لصاحبه وحده", (await C.lineAudio(A, Number(c7.call.id), Number(t7.added[0].id))).audio.length === 3_000);
await C.setVoiceSettings(A, A, { callRecording: false });
await C.endCall(A, A, Number(c7.call.id), { summarize: false });

// ── النموذج لا يرد: لا جواب مخترع ──
const c8 = await C.startCall(A, A, { employeeKey: "email.analyst" });
llmDown = true;
const t8 = await C.takeTurn(A, Number(c8.call.id), { text: "مرحبا" });
llmDown = false;
check("لا رد = سطر نظام يقول ذلك، لا سطر موظف", !t8.added.some((l: any) => l.speaker === "employee") && t8.added.some((l: any) => l.speaker === "system" && l.text.includes("لا جواب مخترع")));
await C.endCall(A, A, Number(c8.call.id), { summarize: false });

// ── الجاهزية ──
const rd = await voiceReadiness(A);
const item_ = (id: string) => rd.items.find((x) => x.id === id)!;
check("الصوت داخل التطبيق لم يُختبر حقيقةً بعد (بدائل الاختبار لا تُحسب)", item_("voice.in_app").status === "NEEDS_TEST", item_("voice.in_app"));
check("الهاتف محجوب بما ينقصه", item_("voice.pstn").status === "BLOCKED" && item_("voice.pstn").missing.some((x) => x.includes("TWILIO")));
check("الصوت اللحظي محجوب", item_("voice.realtime").status === "BLOCKED");
check("التقويم محجوب", item_("meetings.calendar").status === "BLOCKED");

// ── الاجتماع ──
const rec = await M.recommendAttendees(A, "تحسين البريد", ["الارتداد"]);
const guard = rec.recommendations.find((r) => r.employeeKey === "email.guard");
check("ترشيح المدير بأسباب من الوقائع", !!guard && guard.reasons.some((x) => x.includes("تجاوزت موعدها")) && guard.evidence.includes(`task:${lateA.task_id}`), rec);
check("ولا يرشّح من حسابٍ آخر", !rec.recommendations.some((r) => r.employeeKey === "email.replies"));
await refuses("حاضر من حساب آخر: 404", M.createMeeting(A, A, { objective: "اختبار", attendees: [{ employeeKey: "email.replies" }] }), 404, "employee_not_found");
await refuses("المدير لا يُضاف حاضراً", M.createMeeting(A, A, { objective: "اختبار", attendees: [{ employeeKey: "executive.ceo" }] }), 400, "ceo_is_moderator");

await setControl({ scope: "employee", userId: A, target: "ops.controller", engaged: true, reason: "موقوف للاجتماع", actor: A }); reset();
seen.length = 0;
reply = (role: string) => ({ reply: `جواب ${role} [task:${lateA.task_id}]`, evidence: [`task:${lateA.task_id}`], proposals: [] });
const mt = await M.createMeeting(A, A, { objective: "تحسين البريد", agenda: ["الارتداد", "الردود"], timeLimitMin: 15,
  attendees: [{ employeeKey: "email.guard", recommendedBy: "ceo", reason: guard?.reasons.join("، ") }, { employeeKey: "email.analyst" }, { employeeKey: "ops.controller" }] });
const mid = Number(mt.meeting.id);
check("الاجتماع بدأ بافتتاح المدير", mt.meeting.state === "in_progress" && mt.minutes[0]?.kind === "opening" && mt.minutes[0]?.speaker === "ceo" && mt.minutes[0].text.includes("تحسين البريد"));
check("الموقوف معلَّم غير متاح بسببه", mt.attendees.find((a: any) => a.employee_key === "ops.controller")?.status === "unavailable");
check("الاجتماع نصف اتجاهي معلن", mt.meeting.duplex === "half" && /بالتناوب/.test(mt.minutes[0].text));
await refuses("حساب آخر لا يرى الاجتماع", M.getMeeting(B, mid), 404);
await refuses("ولا يحرّكه", M.nextStep(B, mid), 404);
let g = mt;
for (let i = 0; i < 4; i++) g = await M.nextStep(A, mid);
const kinds = g.minutes.map((m: any) => `${m.kind}:${m.employee_key ?? m.speaker}`);
check("ترتيب الإدارة: افتتاح ← سؤال ← جواب، لكل حاضر بدوره ← دعوة للمخالفة ← مخالفة", JSON.stringify(kinds) === JSON.stringify([
  "opening:executive.ceo", "question:executive.ceo", "answer:email.guard", "question:executive.ceo", "answer:email.analyst",
  "question:executive.ceo", "dissent:email.guard", "dissent:email.analyst",
]), kinds);
const answers = seen.filter((s) => s.user.includes("أجب سؤال المدير"));
check("كل حاضر أجاب بدوره هو، لا بلسان المدير", answers.map((s) => s.role).join() === "email_guard,email_analyst" && answers[0]!.system.includes("حارس البريد") && !answers[0]!.system.includes("الرئيس التنفيذي الآلي"), answers.map((s) => s.role));
check("الموقوف لم يُسأل ولم يُنادَ له نموذج", !seen.some((s) => s.role === "ops"));
await refuses("المالك يسأل من ليس حاضراً: 404", M.ownerSays(A, mid, { text: "سؤال", to: "email.replies" }), 404, "not_attendee");
const os = await M.ownerSays(A, mid, { text: "أعطني الدليل على الارتداد", to: "email.guard" });
check("المالك يسأل حاضراً فيجيب هو", os.minutes.at(-2)?.kind === "owner" && os.minutes.at(-1)?.kind === "reply" && os.minutes.at(-1)?.employee_key === "email.guard" && seen.at(-1)?.role === "email_guard");
const os2 = await M.ownerSays(A, mid, { text: "موافق على كل شيء" });
check("«موافق» في الاجتماع ليست موافقة", os2.minutes.some((m: any) => m.kind === "system" && m.text.includes("ليست موافقة")) && seen.at(-1)?.role === "ceo_agent");
decision = {
  reply: "خلاصة: الارتداد مرتفع.", evidence: [],
  verified_facts: [{ text: "مهمة التدقيق متأخرة", evidence: [`task:${lateA.task_id}`] }, { text: "الردود ممتازة", evidence: ["task:424242"] }],
  estimates: ["قد يتحسن الأسبوع القادم"], owner_decisions: ["رفع الحد اليومي"],
  action_items: [
    { title: "تنظيف القائمة", employee_key: "email.guard", due_in_days: 4, metric: "bounce_rate", expected_outcome: "ارتداد أقل من ٢٪" },
    { title: "بند لموظف حساب آخر", employee_key: "email.replies", due_in_days: 4, expected_outcome: "x y z" },
    { title: "بند للموقوف الغائب", employee_key: "ops.controller", due_in_days: 4, expected_outcome: "x y z" },
  ],
};
g = await M.nextStep(A, mid);
const dec = g.minutes.find((m: any) => m.kind === "decision"), rb = g.minutes.at(-1);
check("القرارات ثم قراءتها، والاجتماع انتهى", !!dec && rb?.kind === "readback" && g.meeting.state === "ended" && g.meeting.phase === "closed");
check("المؤكد بدليلٍ من المحضر فقط؛ غيره تقدير", dec.verified.verified.length === 1 && dec.verified.estimates.some((x: string) => x.includes("الردود ممتازة")), dec.verified);
check("قرار المالك وحده معلَّم", dec.verified.ownerDecisions.includes("رفع الحد اليومي") && rb.text.includes("قرارات لك وحدك"));
check("بند واحد مقبول: مسؤول حاضر، موعد، نتيجة", g.actionItems.length === 1 && g.actionItems[0].employee_key === "email.guard" && !!g.actionItems[0].due_at && g.actionItems[0].expected_outcome.includes("٢٪"), g.actionItems);
check("وبنود من ليس حاضراً مرفوضة ومذكورة", dec.verified.rejected.length === 2);
const [mtk] = (await db.execute<any>(sql`SELECT * FROM employee_tasks WHERE task_id = ${g.actionItems[0].task_id}`)).rows;
check("البند تذكرة تنتظر المالك باسم المسؤول", mtk?.user_id === A && mtk.owner_role === "email_guard" && mtk.assigned_to === "email.guard" && mtk.status === "waiting_for_owner" && mtk.input_refs.source.kind === "meeting" && mtk.input_refs.source.id === mid);
check("قراءة القرارات تذكر التذكرة والموعد والمقياس", rb.text.includes(`#${mtk.task_id}`) && rb.text.includes("bounce_rate"));
await refuses("لا خطوة بعد الإغلاق", M.nextStep(A, mid), 409);
check("نداءات الاجتماع محسوبة", Number(g.meeting.model_calls) === 7, g.meeting.model_calls);

// ميزانية الاجتماع: آخر نداء محجوز للقرارات.
await db.execute(sql`DELETE FROM org_controls`); reset();
const m2 = await M.createMeeting(A, A, { objective: "ميزانية", attendees: [{ employeeKey: "email.guard" }] });
await db.execute(sql`UPDATE owner_meetings SET model_calls = ${L.MAX_MEETING_MODEL_CALLS - 1} WHERE id = ${m2.meeting.id}`);
const m2b = await M.nextStep(A, Number(m2.meeting.id));
check("ميزانية الجولة نفدت: انتقال للقرارات مع بقاء نداء لها", m2b.meeting.phase === "decisions" && m2b.minutes.at(-1).text.includes("حدّ نداءات"));
await refuses("المالك لا يستهلك نداء القرارات", M.ownerSays(A, Number(m2.meeting.id), { text: "سؤال" }), 429, "budget_exhausted");
decision = { reply: "لا بنود.", evidence: [], verified_facts: [], estimates: [], owner_decisions: [], action_items: [] };
const m2c = await M.nextStep(A, Number(m2.meeting.id));
check("القرارات تأخذ النداء الأخير", m2c.meeting.state === "ended" && Number(m2c.meeting.model_calls) === L.MAX_MEETING_MODEL_CALLS);

// الجدولة داخل Flow Hub فقط.
const m3 = await M.createMeeting(A, A, { objective: "موعد", attendees: [{ employeeKey: "email.guard" }], scheduledAt: new Date(Date.now() + 86_400_000).toISOString() });
check("اجتماع مجدول يُحفظ ولا يبدأ", m3.meeting.state === "scheduled" && m3.minutes.length === 0 && !!m3.meeting.scheduled_at);
const m3s = await M.startMeeting(A, A, Number(m3.meeting.id));
check("ويبدأ بطلب المالك", m3s.meeting.state === "in_progress");
await M.endMeeting(A, A, Number(m3.meeting.id));
await setControl({ scope: "employee", userId: A, target: "executive.ceo", engaged: true, reason: "المدير موقوف", actor: A }); reset();
await refuses("المدير موقوف: لا اجتماع", M.createMeeting(A, A, { objective: "اختبار", attendees: [{ employeeKey: "email.guard" }] }), 409, "ceo_unavailable");
await db.execute(sql`DELETE FROM org_controls`); reset();

check("لا شبكة طوال الاختبار", fetched === 0, fetched);
console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
