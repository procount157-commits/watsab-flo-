// ── ملفات الموظفين: القراءة والتحرير والقرار ───────────────────────
// يُركَّب على /api/org/docs. كل شيء بحساب الجلسة. لا شيء يُفعَّل إلا بموافقة صاحب الحساب:
// التقديم ينشئ مقترحاً، والموافقة تمرّ على activatePrompt، والإرجاع على rollbackProposal.

import { Router } from "express";
import { requireAuth } from "../lib/auth";
import {
  approveVersion, createDraft, decidePersuasion, diffVersions, DossierError, getDossier, listDossiers, listPersuasionKnowledge,
  rejectVersion, rollbackActive, runtimeFor, submitVersion, updateDraft, versionOf,
} from "../lib/org/docs/dossier";
import { DOSSIER_KEYS, DOSSIER_TITLES, DOC_ONLY, RUNTIME_LIMIT } from "../lib/org/docs/model";
import { OBJECTION_TITLES, PERSUASION_STANDARD, ROLE_APPLICATION } from "../lib/org/docs/persuasion";
import { ProposalRefused } from "../lib/org/proposals";

const router = Router();
router.use(requireAuth);

const fail = (res: any, err: unknown) => {
  if (err instanceof DossierError || err instanceof ProposalRefused) return res.status(err.status).json({ error: err.message });
  throw err;
};
const keyOf = (req: any) => String(req.params["key"] ?? "").slice(0, 60);
const versionParam = (req: any, res: any): number | null => {
  const v = Number(req.params["version"]);
  if (Number.isInteger(v) && v > 0) return v;
  res.status(400).json({ error: "رقم نسخة غير صالح" });
  return null;
};

router.get("/meta", (_req, res) => {
  res.json({ sections: DOSSIER_KEYS.map((k) => ({ key: k, title: DOSSIER_TITLES[k] })), docOnlyMark: DOC_ONLY, runtimeLimit: RUNTIME_LIMIT });
});

router.get("/persuasion", async (req, res) => {
  res.json({ standard: PERSUASION_STANDARD, objectionTypes: OBJECTION_TITLES, roles: ROLE_APPLICATION, knowledge: await listPersuasionKnowledge(req.session.userId!) });
});
router.post("/persuasion/:id/:decision", async (req, res) => {
  const id = Number(req.params["id"]);
  const d = req.params["decision"];
  if (!Number.isInteger(id) || id <= 0 || (d !== "approve" && d !== "reject")) return res.status(400).json({ error: "طلب غير صالح" });
  const ok = await decidePersuasion(req.session.userId!, id, d === "approve" ? "approved" : "rejected", req.session.userId!);
  if (!ok) return res.status(409).json({ error: "ليس لهذا الحساب أو ليس معلّقاً" });
  res.json({ ok: true });
});

router.get("/employees", async (req, res) => { res.json({ employees: await listDossiers(req.session.userId!) }); });

router.get("/employees/:key", async (req, res) => {
  try { res.json(await getDossier(req.session.userId!, keyOf(req))); } catch (err) { fail(res, err); }
});
router.get("/employees/:key/versions/:version", async (req, res) => {
  const v = versionParam(req, res);
  if (v == null) return;
  const userId = req.session.userId!;
  try {
    await getDossier(userId, keyOf(req));
    const row = await versionOf(userId, keyOf(req), v);
    if (!row) return res.status(404).json({ error: "النسخة ليست في هذا الحساب" });
    res.json({ dossier: row, runtime: await runtimeFor(userId, row) });
  } catch (err) { fail(res, err); }
});
router.get("/employees/:key/diff", async (req, res) => {
  const to = Number(req.query["to"]);
  const from = req.query["from"] == null || req.query["from"] === "" ? null : Number(req.query["from"]);
  if (!Number.isInteger(to) || to <= 0 || (from != null && (!Number.isInteger(from) || from <= 0))) return res.status(400).json({ error: "from وto أرقام نسخ" });
  try { res.json(await diffVersions(req.session.userId!, keyOf(req), from, to)); } catch (err) { fail(res, err); }
});

router.post("/employees/:key/drafts", async (req, res) => {
  const b = (req.body ?? {}) as { sections?: unknown; reason?: unknown; baseVersion?: unknown };
  if (typeof b.reason !== "string" || !b.reason.trim()) return res.status(400).json({ error: "reason مطلوب" });
  try {
    const dossier = await createDraft(req.session.userId!, keyOf(req), { sections: b.sections, reason: b.reason, actor: req.session.userId!, baseVersion: b.baseVersion == null ? null : Number(b.baseVersion) });
    res.status(201).json({ dossier });
  } catch (err) { fail(res, err); }
});
router.put("/employees/:key/versions/:version", async (req, res) => {
  const v = versionParam(req, res);
  if (v == null) return;
  const b = (req.body ?? {}) as { sections?: unknown; reason?: unknown };
  try { res.json({ dossier: await updateDraft(req.session.userId!, keyOf(req), v, { sections: b.sections, reason: typeof b.reason === "string" ? b.reason : null, actor: req.session.userId! }) }); } catch (err) { fail(res, err); }
});
router.post("/employees/:key/versions/:version/submit", async (req, res) => {
  const v = versionParam(req, res);
  if (v == null) return;
  try { res.json(await submitVersion(req.session.userId!, keyOf(req), v, req.session.userId!, typeof req.body?.reason === "string" ? req.body.reason : null)); } catch (err) { fail(res, err); }
});
router.post("/employees/:key/versions/:version/approve", async (req, res) => {
  const v = versionParam(req, res);
  if (v == null) return;
  try { res.json(await approveVersion(req.session.userId!, keyOf(req), v, req.session.userId!)); } catch (err) { fail(res, err); }
});
router.post("/employees/:key/versions/:version/reject", async (req, res) => {
  const v = versionParam(req, res);
  if (v == null) return;
  try { res.json(await rejectVersion(req.session.userId!, keyOf(req), v, req.session.userId!, typeof req.body?.reason === "string" ? req.body.reason : null)); } catch (err) { fail(res, err); }
});
router.post("/employees/:key/rollback", async (req, res) => {
  try { res.json(await rollbackActive(req.session.userId!, keyOf(req), req.session.userId!)); } catch (err) { fail(res, err); }
});

export default router;
