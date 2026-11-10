// غرفة التحكّم بلا قاعدة ولا شبكة:
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-voice.test.ts
export {};
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.fetch = (async (url: any) => { throw new Error(`no network in this test: ${url}`); }) as any;

const L = await import("../org/voice/limits");
const { VOICE_SQL } = await import("../org/voice/schema");
const R = await import("../org/voice/respond");
const T = await import("../org/voice/tts");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};

const here = dirname(fileURLToPath(import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const mig = norm(readFileSync(join(here, "../../../../../lib/db/migrations/078_owner_calls.sql"), "utf8"));
check("078 يحمل كل عبارة في VOICE_SQL", VOICE_SQL.every((q) => mig.includes(norm(q))), VOICE_SQL.find((q) => !mig.includes(norm(q))));
const schemaTs = readFileSync(join(here, "../../../../../lib/db/src/schema/org-voice.ts"), "utf8");
for (const t of ["owner_voice_settings", "owner_calls", "call_participants", "call_transcripts", "owner_meetings", "meeting_attendees", "meeting_minutes", "meeting_action_items"])
  check(`الجدول ${t} في المخطط وفي 078`, schemaTs.includes(`pgTable("${t}"`) && mig.includes(`CREATE TABLE IF NOT EXISTS ${t} (`));
check("التسجيل مطفأ افتراضياً في القاعدة", mig.includes("call_recording boolean NOT NULL DEFAULT false") && mig.includes("recording boolean NOT NULL DEFAULT false"));
check("لا حالة ringing دائمة بلا قيد: الحالات الخمس فقط", mig.includes("state IN ('ringing','connected','busy','unavailable','ended')"));
const idx = readFileSync(join(here, "../../../../../lib/db/src/schema/index.ts"), "utf8");
check("المخطط مصدَّر من الفهرس", idx.includes(`export * from "./org-voice"`));

// ── الصوت ──
check("mime: webm بمرمّزه مقبول", L.audioMime("audio/webm;codecs=opus") === "audio/webm");
check("mime: mp4 صوتي مقبول", L.audioMime("audio/mp4") === "audio/mp4");
check("mime: فيديو مرفوض", L.audioMime("video/mp4") === null && L.audioMime("application/octet-stream") === null && L.audioMime(null) === null);
check("حد الدور ٦٠ ثانية", L.MAX_TURN_AUDIO_MS === 60_000);

// ── الأسرار ──
const r1 = L.redact("المفتاح gsk_abcdefghijklmnopqrstuvwxyz123456 وكلمة السر: hunter22 و token=abc123xyz");
check("مفتاح Groq يُحذف", !r1.includes("gsk_abc"), r1);
check("كلمة السر تُحذف", !r1.includes("hunter22"), r1);
check("token= يُحذف", !r1.includes("abc123xyz"), r1);
check("بطاقة تُقنَّع بآخر أربعة", L.redact("4111 1111 1111 1234").includes("••1234") && !L.redact("4111 1111 1111 1234").includes("4111 1111"));
check("هاتف يُقنَّع", !L.redact("رقمه 0501234567").includes("0501234567"));
check("بريد يُقنَّع اسمه", L.redact("a.person@example.com") === "a•••@example.com");
check("أرقام قصيرة تبقى", L.redact("خرج 120 رسالة و4 ردود") === "خرج 120 رسالة و4 ردود");
check("Bearer يُحذف", !L.redact("Authorization: Bearer abcdefghijklmnop.qrstu").includes("abcdefghijklmnop"));

// ── «موافق» بالكلام ──
for (const s of ["موافق", "تمام موافق نفّذ", "اعتمد الخطة", "approved", "OK go ahead"]) check(`موافقة شفهية تُكشف: ${s}`, L.isSpokenApproval(s));
for (const s of ["هل توافق الأرقام؟", "ما رأيك في الحملة", "لا أوافق على هذا؟"].slice(0, 2)) check(`ليست موافقة: ${s}`, !L.isSpokenApproval(s));
check("ملاحظة الموافقة تقول إنها ليست موافقة", L.SPOKEN_APPROVAL_NOTE.includes("ليست موافقة"));

// ── ما يُقرأ من النموذج ──
check("JSON ملفوف", L.extractObject('هذا ردي:\n```json\n{"reply":"أهلاً {بك}","evidence":[]}\n```')?.["reply"] === "أهلاً {بك}");
check("لا JSON", L.extractObject("نص فقط") === null);
check("JSON معطوب", L.extractObject('{"reply": "x"') === null);
check("معرّفات الدليل من النص", L.citedIds("فشل [task:12] و[heartbeat:email.guard] و[x]").join() === "task:12,heartbeat:email.guard");
const ev = R.checkEvidence("فشلت المهمة [task:12] و[task:999]", ["task:12", "execution:5"], new Set(["task:12"]));
check("الدليل المعروف يبقى", ev.evidence.join() === "task:12", ev);
check("الدليل المخترع يُحذف من النص ويُسجَّل", !ev.reply.includes("task:999") && ev.dropped.includes("task:999") && ev.dropped.includes("execution:5"), ev);
const props = L.cleanProposals([{ title: "راجع قائمة البريد", expected_outcome: "خفض الارتداد", due_in_days: 400 }, { title: "x" }, "bad", { title: "مكتمل", expected_outcome: "نتيجة", due_in_days: -3, employee_key: "email.guard" }]);
check("مقترح بلا نتيجة يسقط", props.length === 2, props);
check("الموعد يُقصّ إلى ١..٩٠", props[0]!.dueInDays === 90 && props[1]!.dueInDays === 1);
check("المسؤول يُقرأ", props[1]!.employeeKey === "email.guard");
check("حد المقترحات", L.cleanProposals(Array(10).fill({ title: "عنوان", expected_outcome: "نتيجة" }), 3).length === 3);

// ── التعليمات ──
const emp = { key: "email.guard", role: "email_guard", name: "حارس", title: null, department: "email", isActive: true, persona: "شخصية token=SECRETVALUE1", promptVersion: 1 };
const sys = R.systemPrompt({ userId: 1, emp, history: [], utterance: "x", lang: "ar", mode: "call" }, null);
check("التعليمات تقول إن النص غير موثوق", sys.includes(R.UNTRUSTED_NOTE) && sys.includes("غير موثوق"));
check("التعليمات تقول إن «موافق» ليست موافقة", sys.includes("ليست موافقة"));
check("التعليمات تمنع التنفيذ وتحوّله تذكرة", sys.includes("لا تستطيع تنفيذ") && sys.includes("تذكرة"));
check("التعليمات تطلب قول «لا أعرف»", sys.includes("لا تعرف"));
check("سرّ في الشخصية لا يدخل التعليمات", !sys.includes("SECRETVALUE1"));
const ceoSys = R.systemPrompt({ userId: 1, emp: { ...emp, key: "executive.ceo", role: "ceo_agent", name: "المدير" }, history: [], utterance: "x", lang: "ar", mode: "meeting" }, null);
check("المدير في الاجتماع لا يتكلم بلسان أحد", ceoSys.includes("لا تتكلم بلسان أي موظف"));

// ── الحدود ──
L.forgetRates();
let okN = 0; for (let i = 0; i < 25; i++) if (L.rateHit("turn", 7, 1_000).ok) okN++;
check("حد الأدوار في الدقيقة", okN === L.RATE.turn.max);
check("وبعد النافذة يعود", L.rateHit("turn", 7, 1_000 + L.RATE.turn.windowMs + 1).ok);
check("الحد لكل مستخدم", L.rateHit("turn", 8, 1_000).ok);
check("ميزانية النموذج ثابتة", L.MAX_CALL_MODEL_CALLS > 0 && L.MAX_MEETING_MODEL_CALLS > 1);
check("صوت المدير ثابت", T.genderFor("executive.ceo") === "male" && T.genderFor("email.guard") === T.genderFor("email.guard"));
check("لغة الطلب", L.langOf("en") === "en" && L.langOf("ar") === "ar" && L.langOf("x") === "auto");

console.log(`\n${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
