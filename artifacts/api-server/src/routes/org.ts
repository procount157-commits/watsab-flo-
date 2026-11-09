// ── مفاتيح الإيقاف وسجلّها ────────────────────────────────────────
// صاحب الحساب يرى مفاتيحه ويضعها على حسابه. المنصة كلها والمفاتيح العامة للمدير
// وحده (session.isAdmin، كما في routes/admin.ts).

import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { controlScopeFor, setControl } from "../lib/org/controls";
import { ensureOrgTables } from "../lib/org/schema";

const router = Router();
router.use(requireAuth);

router.get("/controls", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const r = await db.execute(sql`SELECT id, scope, user_id, target, engaged, reason, set_by, set_at FROM org_controls
    WHERE user_id = ${userId} OR user_id IS NULL ${req.session.isAdmin && req.query["all"] ? sql`OR true` : sql``} ORDER BY set_at DESC`);
  res.json({ controls: r.rows, isAdmin: !!req.session.isAdmin });
});

router.put("/controls", async (req, res) => {
  const userId = req.session.userId!;
  const b = (req.body ?? {}) as { scope?: string; target?: string; engaged?: unknown; reason?: string; userId?: unknown; platformWide?: unknown };
  if (typeof b.engaged !== "boolean") return res.status(400).json({ error: "engaged: true أو false" });
  const v = controlScopeFor({ scope: String(b.scope ?? ""), target: b.target, engaged: b.engaged, reason: b.reason }, {
    userId, isAdmin: !!req.session.isAdmin, platformWide: b.platformWide === true,
    forUserId: b.userId === undefined ? null : Number(b.userId),
  });
  if (!v.ok) return res.status(v.status).json({ error: v.error });
  await setControl({ scope: v.scope, userId: v.userId, target: v.target, engaged: b.engaged, reason: b.reason?.slice(0, 500) ?? null, actor: userId });
  res.json({ ok: true, scope: v.scope, target: v.target, userId: v.userId, engaged: b.engaged });
});

router.get("/audit", async (req, res) => {
  const userId = req.session.userId!;
  await ensureOrgTables();
  const limit = Math.min(Math.max(Number(req.query["limit"]) || 100, 1), 500);
  // المدير يرى كل شيء بطلبه؛ غيره سجلّ حسابه فقط — لا صفوف المنصة ولا حساب غيره.
  const r = await db.execute(sql`SELECT id, user_id, action, scope, channel, kind, recipient, role, actor, why, count, meta, created_at FROM org_audit_log
    WHERE ${req.session.isAdmin && req.query["all"] ? sql`true` : sql`user_id = ${userId}`} ORDER BY id DESC LIMIT ${limit}`);
  res.json({ audit: r.rows });
});

export default router;
