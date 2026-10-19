/**
 * Media upload route — JSON / base64 payload.
 *
 * The Replit deployment proxy does not reliably forward multipart/form-data
 * POST requests to the API service.  Switching to a plain JSON upload
 * (base64-encoded file content) uses the same pathway as every other API
 * call and works in both development and production.
 *
 * Request body (application/json):
 *   { filename: string; mimetype: string; data: string }   ← base64, no prefix
 *
 * Response (200):
 *   { filename, path, url, size, mimetype, storage }
 */
import { Router, type RequestHandler } from "express";
import path from "path";
import { randomUUID } from "crypto";
import {
  putObject, statObject, createObjectReadStream,
  storageDriver, MEDIA_URL_PREFIX, MEDIA_ROOT,
} from "../lib/storage";
import { logger } from "../lib/logger";
import { requireAuth } from "../lib/auth";
import { and, desc, eq } from "drizzle-orm";
import { db, mediaAssetsTable } from "@workspace/db";

const router = Router();

const OBJECT_PREFIX = "media-uploads";

const ALLOWED_EXT  = /\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mkv|webm)$/i;
const ALLOWED_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|quicktime|x-msvideo|x-matroska|webm))$/;

// ── Upload (JSON / base64) ────────────────────────────────────────
const uploadHandler: RequestHandler = async (req, res): Promise<void> => {
  const { filename, mimetype, data } = req.body ?? {};

  if (!filename || !mimetype || !data) {
    res.status(400).json({ error: "filename، mimetype و data مطلوبة" });
    return;
  }

  if (!ALLOWED_EXT.test(filename) && !ALLOWED_MIME.test(mimetype)) {
    res.status(400).json({
      error: "نوع الملف غير مدعوم. الصور: jpg/png/gif/webp — الفيديو: mp4/mov/avi",
    });
    return;
  }

  // Decode base64 → Buffer
  let buffer: Buffer;
  try {
    // Strip data-URL prefix if the client included it  (data:image/png;base64,…)
    const raw = typeof data === "string" && data.includes(",") ? data.split(",")[1] : data;
    buffer = Buffer.from(raw, "base64");
  } catch {
    res.status(400).json({ error: "فشل فكّ ترميز الملف — تأكد من إرساله بصيغة base64" });
    return;
  }

  if (buffer.length > 64 * 1024 * 1024) {
    res.status(400).json({ error: "حجم الملف يتجاوز الحد المسموح (64 MB)" });
    return;
  }

  const ext = path.extname(filename).toLowerCase() || `.${mimetype.split("/")[1]}`;
  const objectName = `${OBJECT_PREFIX}/${randomUUID()}${ext}`;
  const serveUrl = `${MEDIA_URL_PREFIX}${encodeURIComponent(objectName)}`;

  // There is deliberately no "storage not configured" success path here. This
  // route used to answer 200 with a URL nothing was stored behind whenever the
  // bucket was unset, so the upload looked fine and the campaign only failed
  // later, once per recipient. A failure to store is now a failure to upload.
  try {
    await putObject(objectName, buffer, mimetype);
    logger.info({ objectName, size: buffer.length, driver: storageDriver() }, "media upload stored");
    // Every image uploaded anywhere — a campaign, a carousel card, the gallery
    // itself — lands in the gallery, so it can be picked again.
    const caption = typeof req.body?.caption === "string" ? req.body.caption.trim().slice(0, 500) : null;
    const tags = Array.isArray(req.body?.tags) ? req.body.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 12) : [];
    let assetId: number | null = null;
    if (req.session?.userId && /^image\//.test(mimetype)) {
      const [a] = await db.insert(mediaAssetsTable).values({ userId: req.session.userId, url: serveUrl, mimetype, size: buffer.length, caption: caption || filename.replace(/\.[a-z0-9]+$/i, ""), tags, source: "upload" })
        .onConflictDoNothing().returning({ id: mediaAssetsTable.id }).catch(() => [] as Array<{ id: number }>);
      assetId = a?.id ?? null;
    }
    res.json({
      assetId,
      filename, path: serveUrl, url: serveUrl,
      size: buffer.length, mimetype, storage: storageDriver(),
    });
  } catch (err: any) {
    logger.error({ err: err?.message, stack: err?.stack, objectName, driver: storageDriver(), root: MEDIA_ROOT }, "media upload failed");
    res.status(500).json({ error: `فشل حفظ الملف: ${err?.message ?? "خطأ غير معروف"}` });
  }
};

router.post("/upload", requireAuth, uploadHandler);

// ── The gallery ──────────────────────────────────────────────────
// What the owner uploads for campaigns and posts, what the website study
// brought in: listed newest first, captioned and tagged, picked by the
// campaign writer.
router.get("/library", requireAuth, async (req, res) => {
  const rows = await db.select().from(mediaAssetsTable).where(eq(mediaAssetsTable.userId, req.session.userId!)).orderBy(desc(mediaAssetsTable.createdAt)).limit(500);
  res.json({ assets: rows });
});

router.patch("/library/:id", requireAuth, async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.caption === "string") patch.caption = req.body.caption.trim().slice(0, 500);
  if (Array.isArray(req.body?.tags)) patch.tags = req.body.tags.map((t: unknown) => String(t).trim()).filter(Boolean).slice(0, 12);
  if (!Object.keys(patch).length) { res.status(400).json({ error: "لا شيء يُعدَّل" }); return; }
  await db.update(mediaAssetsTable).set(patch).where(and(eq(mediaAssetsTable.id, Number(req.params.id)), eq(mediaAssetsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

router.delete("/library/:id", requireAuth, async (req, res) => {
  // The gallery entry goes; the file stays, since a sent campaign may still point at it.
  await db.delete(mediaAssetsTable).where(and(eq(mediaAssetsTable.id, Number(req.params.id)), eq(mediaAssetsTable.userId, req.session.userId!)));
  res.json({ ok: true });
});

// ── Serve GCS object (proxy — keeps GCS URLs internal) ───────────
router.get("/file/:objectName", async (req, res): Promise<void> => {
  const objectName = decodeURIComponent(req.params.objectName);

  try {
    const meta = await statObject(objectName);
    if (!meta) {
      res.status(404).json({ error: "الملف غير موجود" });
      return;
    }

    res.setHeader("Content-Type", meta.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (meta.size) res.setHeader("Content-Length", String(meta.size));

    const stream = createObjectReadStream(objectName);
    stream.on("error", (err) => {
      logger.error({ err, objectName }, "media stream error");
      if (!res.headersSent) res.status(500).json({ error: "خطأ في قراءة الملف" });
      else res.destroy();
    });
    stream.pipe(res);
  } catch (err: any) {
    logger.error({ err: err?.message, objectName }, "media serve error");
    if (!res.headersSent) res.status(500).json({ error: "خطأ في قراءة الملف" });
  }
});

export default router;
