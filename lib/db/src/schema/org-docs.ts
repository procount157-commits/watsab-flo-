// ── ملف الموظف (Employee Dossier) ─────────────────────────────────
// قاعدة البيانات مصدر الحقيقة لتعليمات كل موظف في كل حساب: نسخةٌ بعد نسخة، بأقسامها
// التسعة عشر وكاتبها وسببها وموافقتها. التعليمات التي يعمل بها الموظف تُجمَّع من النسخة
// النشطة وحدها (artifacts/api-server/src/lib/org/docs/render.ts). النشر لا يشغّل SQL،
// فالجدول يُنشأ عند الإقلاع من lib/org/docs/schema.ts بالنص نفسه الذي في 077_dossiers.sql.

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const DOSSIER_STATUSES = ["draft", "proposed", "approved", "active", "superseded"] as const;
export type DossierStatus = (typeof DOSSIER_STATUSES)[number];

export const employeeDocumentationTable = pgTable("employee_documentation", {
  id:              serial("id").primaryKey(),
  userId:          integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  employeeKey:     varchar("employee_key", { length: 60 }).notNull(),
  version:         integer("version").notNull(),
  status:          varchar("status", { length: 12 }).notNull().default("draft"),
  sections:        jsonb("sections").$type<Record<string, string>>().notNull(),
  libraryVersion:  integer("library_version"),
  author:          varchar("author", { length: 60 }).notNull(),
  changeReason:    text("change_reason"),
  /** مقترح التحسين الذي يحمل هذه النسخة إلى صاحب العمل. */
  proposalId:      integer("proposal_id"),
  /** النسخة التي كانت نشطة حين فُعّلت هذه: إليها يعود الإرجاع. */
  replacedVersion: integer("replaced_version"),
  createdAt:       timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  approvedBy:      integer("approved_by").references(() => usersTable.id, { onDelete: "set null" }),
  approvedAt:      timestamp("approved_at", { withTimezone: true }),
  activatedAt:     timestamp("activated_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("uq_employee_documentation_version").on(t.userId, t.employeeKey, t.version),
  uniqueIndex("uq_employee_documentation_active").on(t.userId, t.employeeKey).where(sql`status = 'active'`),
  index("idx_employee_documentation_user").on(t.userId, t.employeeKey, t.status),
  check("employee_documentation_status", sql`${t.status} IN ('draft','proposed','approved','active','superseded')`),
]);
