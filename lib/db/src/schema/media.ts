import { pgTable, serial, integer, varchar, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * The owner's image gallery: what he uploads for campaigns and posts, what
 * the website study brought in, and the shop's own piece photos. The
 * campaign writer picks from it by tags and caption.
 */
export const mediaAssetsTable = pgTable("media_assets", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  url:       text("url").notNull(),
  mimetype:  varchar("mimetype", { length: 80 }),
  size:      integer("size"),
  /** What the picture shows, in the owner's words or read from the page it came from. */
  caption:   text("caption"),
  tags:      jsonb("tags").$type<string[]>().notNull().default([]),
  /** upload | website | catalog */
  source:    varchar("source", { length: 20 }).notNull().default("upload"),
  /** The page an image came from, for the website study. */
  sourceUrl: text("source_url"),
  /** What Gemini sees in the picture, in Arabic (image-sense.ts) — not the file name. */
  vision:    text("vision"),
  /** The sectors the picture belongs to, as Gemini read it: عقارات، ذهب ومجوهرات، … or عام. */
  fits:      jsonb("fits").$type<string[]>(),
  /** aml | services | jewelry | general */
  service:   varchar("service", { length: 12 }),
  /** The language of the words on the design itself: ar | en | mixed | none. */
  lang:      varchar("lang", { length: 6 }),
  visionAt:  timestamp("vision_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_media_assets_user").on(t.userId, t.createdAt)]);
export type MediaAsset = typeof mediaAssetsTable.$inferSelect;
