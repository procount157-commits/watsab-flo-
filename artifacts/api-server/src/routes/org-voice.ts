// ── /api/org/voice — غرفة تحكّم المالك ────────────────────────────
// كل مسار requireAuth، والحساب من الجلسة وحدها: كل معرّف (مكالمة، اجتماع، سطر، موظف) يُفحص
// على user_id الجلسة، وما ليس له 404. لا مسار هنا يعتمد تذكرة: الموافقة من /org/tasks/:id/approve.

import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { requireAuth } from "../lib/auth";
import { orgRegistry } from "../lib/org/registry";
import { CEO_KEY, ensureCeo } from "../lib/org/ceo";
import { VoiceError, endCall, getCall, lineAudio, listCalls, setVoiceSettings, startCall, summarizeCall, takeTurn, voiceSettings, type TurnInput } from "../lib/org/voice/calls";
import { createMeeting, endMeeting, getMeeting, listMeetings, minuteAudio, nextStep, ownerSays, recommendAttendees, startMeeting } from "../lib/org/voice/meetings";
import { voiceReadiness } from "../lib/org/voice/readiness";
import { MAX_AUDIO_BYTES, langOf } from "../lib/org/voice/limits";
import { ensureVoiceTables } from "../lib/org/voice/schema";

// عند الإقلاع: routes/index.ts يستورد هذا الملف، فتُنشأ الجداول قبل أول طلب (والفشل يُعاد عند الطلب).
void ensureVoiceTables();

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 8, fieldSize: 4_096 } });
/** صوتٌ اختياري في الحقل audio؛ بلا multipart يمرّ JSON كما هو. خطأ الحجم 413 لا 500. */
const audioField = (req: Request, res: Response, next: NextFunction) =>
  upload.single("audio")(req, res, (err: any) => {
    if (!err) return next();
    const big = err?.code === "LIMIT_FILE_SIZE";
    res.status(big ? 413 : 400).json({ error: big ? "التسجيل أكبر من المسموح" : "طلب صوت غير صالح", code: big ? "audio_too_large" : "bad_upload" });
  });

const uid = (req: Request) => req.session.userId!;
const idOf = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : -1; };
const turnOf = (req: Request): TurnInput & { to?: string | null } => ({
  text: typeof req.body?.text === "string" ? req.body.text : null,
  audio: req.file?.buffer ?? null, mime: req.file?.mimetype ?? null,
  durationMs: req.body?.durationMs == null ? null : Number(req.body.durationMs),
  lang: req.body?.lang ? langOf(req.body.lang) : null,
  to: typeof req.body?.to === "string" ? req.body.to.slice(0, 60) : null,
});

/** VoiceError برسالته وحالته؛ غيره 500 بلا تفاصيل داخلية. */
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { const out = await fn(req, res); if (!res.headersSent) res.json(out); }
  catch (err: any) {
    if (err instanceof VoiceError) {
      if (err.extra["retryAfterSec"]) res.setHeader("Retry-After", String(err.extra["retryAfterSec"]));
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    }
    req.log?.warn?.({ err: String(err?.message ?? err).slice(0, 200) }, "org voice failed");
    res.status(500).json({ error: "تعذّر الطلب" });
  }
};
const sendAudio = (res: Response, a: { audio: Buffer; mime: string; voice: string | null }) => {
  res.setHeader("Content-Type", a.mime);
  res.setHeader("Cache-Control", "no-store");
  if (a.voice) res.setHeader("X-Voice", a.voice);
  res.send(a.audio);
};

router.get("/readiness", wrap((req) => voiceReadiness(uid(req))));
router.get("/settings", wrap((req) => voiceSettings(uid(req))));
router.put("/settings", wrap(async (req) => {
  if (typeof req.body?.callRecording !== "boolean") throw new VoiceError("callRecording: true أو false", 400, "bad_input");
  return setVoiceSettings(uid(req), uid(req), { callRecording: req.body.callRecording });
}));

/** من يُكلَّم: موظفو الحساب بمفتاحهم وقسمهم وهل يستطيعون الإجابة الآن. */
router.get("/employees", wrap(async (req) => {
  await ensureCeo(uid(req));
  const staff = await orgRegistry(uid(req));
  return { employees: staff.map((s) => ({ key: s.key, name: s.name, title: s.title, department: s.department, heartbeat: s.heartbeat_status,
    permission: s.permission_status, available: s.permission_status === "allowed", ceo: s.key === CEO_KEY })) };
}));

// ── المكالمات ──
router.get("/calls", wrap(async (req) => ({ calls: await listCalls(uid(req), Number(req.query["limit"]) || 30) })));
router.post("/calls", wrap(async (req, res) => {
  const key = String(req.body?.employeeKey ?? "").slice(0, 60);
  if (!key) throw new VoiceError("اختر موظفاً", 400, "bad_input");
  const out = await startCall(uid(req), uid(req), { employeeKey: key, lang: langOf(req.body?.lang) });
  res.status(201).json(out);
}));
router.get("/calls/:id", wrap((req) => getCall(uid(req), idOf(req.params["id"]))));
router.post("/calls/:id/turns", audioField, wrap((req) => takeTurn(uid(req), idOf(req.params["id"]), turnOf(req))));
router.get("/calls/:id/lines/:line/audio", wrap(async (req, res) => sendAudio(res, await lineAudio(uid(req), idOf(req.params["id"]), idOf(req.params["line"])))));
router.post("/calls/:id/summary", wrap((req) => summarizeCall(uid(req), idOf(req.params["id"]))));
router.post("/calls/:id/end", wrap((req) => endCall(uid(req), uid(req), idOf(req.params["id"]), { summarize: req.body?.summarize !== false })));

// ── الاجتماعات ──
router.post("/meetings/recommend", wrap((req) => recommendAttendees(uid(req), String(req.body?.objective ?? "").slice(0, 500),
  Array.isArray(req.body?.agenda) ? req.body.agenda.map((x: unknown) => String(x ?? "").slice(0, 200)).slice(0, 8) : [])));
router.get("/meetings", wrap(async (req) => ({ meetings: await listMeetings(uid(req), Number(req.query["limit"]) || 30) })));
router.post("/meetings", wrap(async (req, res) => {
  const b = req.body ?? {};
  const out = await createMeeting(uid(req), uid(req), {
    objective: String(b.objective ?? ""), agenda: Array.isArray(b.agenda) ? b.agenda : [], scope: b.scope ?? null,
    timeLimitMin: Number(b.timeLimitMin) || 20, lang: b.lang === "en" ? "en" : "ar", scheduledAt: b.scheduledAt ?? null,
    attendees: Array.isArray(b.attendees) ? b.attendees.slice(0, 20).map((a: any) => ({ employeeKey: String(a?.employeeKey ?? "").slice(0, 60), reason: a?.reason ?? null, recommendedBy: a?.recommendedBy === "ceo" ? "ceo" : "owner" })) : [],
  });
  res.status(201).json(out);
}));
router.get("/meetings/:id", wrap((req) => getMeeting(uid(req), idOf(req.params["id"]))));
router.post("/meetings/:id/start", wrap((req) => startMeeting(uid(req), uid(req), idOf(req.params["id"]))));
router.post("/meetings/:id/next", wrap((req) => nextStep(uid(req), idOf(req.params["id"]))));
router.post("/meetings/:id/say", audioField, wrap((req) => ownerSays(uid(req), idOf(req.params["id"]), turnOf(req))));
router.get("/meetings/:id/minutes/:minute/audio", wrap(async (req, res) => sendAudio(res, await minuteAudio(uid(req), idOf(req.params["id"]), idOf(req.params["minute"])))));
router.post("/meetings/:id/end", wrap((req) => endMeeting(uid(req), uid(req), idOf(req.params["id"]))));

export default router;
