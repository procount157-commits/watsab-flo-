import { pgTable, text, serial, integer, timestamp, varchar, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const contactGroupsTable = pgTable("contact_groups", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  segment: varchar("segment", { length: 50 }),
  /** The folder the owner keeps it in; null is "no folder". */
  folderId: integer("folder_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Folders for lists — WhatsApp number lists (kind "wa") and email lists
// (kind "email") — so real estate lists sit together, cleaning together.
export const listFoldersTable = pgTable("list_folders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 10 }).notNull().default("wa"),
  name: varchar("name", { length: 120 }).notNull(),
  color: varchar("color", { length: 20 }),
  sort: integer("sort").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
export type ListFolder = typeof listFoldersTable.$inferSelect;

export const contactsTable = pgTable("contacts", {
  id: serial("id").primaryKey(),
  groupId: integer("group_id").notNull().references(() => contactGroupsTable.id, { onDelete: "cascade" }),
  phone: varchar("phone", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }),
  status: varchar("status", { length: 20 }).default("active").notNull(),
  /** القطاع، وبماذا عُرف: own (اسم الجهة نفسه) | model (قرأه المصنّف) | hint (ورثته من اسم الملف). */
  sector: varchar("sector", { length: 40 }),
  sectorBy: varchar("sector_by", { length: 8 }),
  classifiedAt: timestamp("classified_at", { withTimezone: true }),
  /** حكم فاحص الأرقام (lib/wa-vetting.ts): ready | hold | rejected، وأسبابه، ومتى. لا حملة إلا إلى ready. */
  verdict: varchar("verdict", { length: 10 }),
  vetReasons: jsonb("vet_reasons").$type<string[]>(),
  vettedAt: timestamp("vetted_at", { withTimezone: true }),
  /** ما قاله واتساب عن الرقم: موجود، غير موجود، أو لم يُسأل بعد. */
  waExists: boolean("wa_exists"),
  /** خطر الإرسال إليه ٠–١٠٠ كما قدّره الفاحص. */
  risk: integer("risk"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertContactGroupSchema = createInsertSchema(contactGroupsTable).omit({ id: true, createdAt: true });
export const insertContactSchema = createInsertSchema(contactsTable).omit({ id: true, createdAt: true });

export type ContactGroup = typeof contactGroupsTable.$inferSelect;
export type InsertContactGroup = z.infer<typeof insertContactGroupSchema>;
export type Contact = typeof contactsTable.$inferSelect;
export type InsertContact = z.infer<typeof insertContactSchema>;
