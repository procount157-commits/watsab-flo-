import { Router } from "express";
import { requireAuth, requireAdmin } from "../lib/auth";
import { logger } from "../lib/logger";
import { pool } from "@workspace/db";

const router = Router();

// subscription_plans ليس في مخطط drizzle ولا في أي ترحيل، وغائبٌ في الإنتاج: كان GET يرمي
// ٥٠٠. لا يُخترع له مخطط هنا؛ الجدول الغائب يعني «لا خطط» للقراءة، و٥٠٣ واضحة للكتابة.
type Query = (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
export const missingTable = (err: any) => err?.code === "42P01";
const ACTIVE_PLANS = `
    SELECT id, name, name_en, price, period, period_label,
           description, description_en, features, features_en,
           badge, badge_en, is_featured, sort_order
    FROM subscription_plans
    WHERE is_active = true
    ORDER BY sort_order ASC, id ASC
  `;
/** الخطط الفعّالة، أو قائمة فارغة إن لم يكن الجدول. أي خطأ آخر يُرمى كما هو. */
export async function listPlans(q: Query = (t, p) => pool.query(t, p as any[]), admin = false): Promise<any[]> {
  try { return (await q(admin ? `SELECT * FROM subscription_plans ORDER BY sort_order ASC, id ASC` : ACTIVE_PLANS)).rows; }
  catch (err) { if (missingTable(err)) return []; throw err; }
}

// ── Public ────────────────────────────────────────────────────────
// GET /api/plans — active plans sorted for landing page
router.get("/", async (_req, res) => {
  res.json(await listPlans());
});

// ── Admin CRUD ────────────────────────────────────────────────────
router.use("/admin", requireAuth, requireAdmin as any);

// GET /api/plans/admin — all plans
router.get("/admin", async (_req, res) => {
  res.json(await listPlans(undefined, true));
});

// POST /api/plans/admin — create plan
router.post("/admin", async (req, res) => {
  const { name, name_en, price, period, period_label, description, description_en,
          features, features_en, badge, badge_en, is_active, is_featured, sort_order } = req.body;
  if (!name || !price || !period) {
    return res.status(400).json({ error: "name, price, period required" });
  }
  const { rows } = await pool.query(
    `INSERT INTO subscription_plans
       (name, name_en, price, period, period_label, description, description_en,
        features, features_en, badge, badge_en, is_active, is_featured, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [name, name_en, price, period, period_label,
     description, description_en,
     JSON.stringify(features ?? []), JSON.stringify(features_en ?? []),
     badge || null, badge_en || null,
     is_active !== false, !!is_featured, sort_order ?? 0]
  );
  logger.info({ planId: rows[0].id, name }, "Admin created subscription plan");
  res.status(201).json(rows[0]);
});

// PUT /api/plans/admin/:id — update plan
router.put("/admin/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const { name, name_en, price, period, period_label, description, description_en,
          features, features_en, badge, badge_en, is_active, is_featured, sort_order } = req.body;

  const { rows } = await pool.query(
    `UPDATE subscription_plans
     SET name=$1, name_en=$2, price=$3, period=$4, period_label=$5,
         description=$6, description_en=$7,
         features=$8, features_en=$9,
         badge=$10, badge_en=$11,
         is_active=$12, is_featured=$13, sort_order=$14
     WHERE id=$15
     RETURNING *`,
    [name, name_en, price, period, period_label,
     description, description_en,
     JSON.stringify(features ?? []), JSON.stringify(features_en ?? []),
     badge || null, badge_en || null,
     is_active !== false, !!is_featured, sort_order ?? 0, id]
  );
  if (!rows.length) return res.status(404).json({ error: "Plan not found" });
  logger.info({ planId: id }, "Admin updated subscription plan");
  res.json(rows[0]);
});

// PATCH /api/plans/admin/:id/toggle — toggle is_active
router.patch("/admin/:id/toggle", async (req, res) => {
  const id = parseInt(req.params.id);
  const { rows } = await pool.query(
    `UPDATE subscription_plans SET is_active = NOT is_active WHERE id=$1 RETURNING *`,
    [id]
  );
  if (!rows.length) return res.status(404).json({ error: "Plan not found" });
  res.json(rows[0]);
});

// DELETE /api/plans/admin/:id — delete plan
router.delete("/admin/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await pool.query(`DELETE FROM subscription_plans WHERE id=$1`, [id]);
  logger.info({ planId: id }, "Admin deleted subscription plan");
  res.json({ success: true });
});

// كتابةٌ على جدولٍ غائب: سببٌ مفهوم لا ٥٠٠ صامت.
router.use((err: any, _req: any, res: any, next: any) => {
  if (missingTable(err)) return res.status(503).json({ error: "جدول الخطط غير موجود على هذا الخادم" });
  next(err);
});

export default router;
