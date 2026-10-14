// ── النفق: عنوانٌ عام يعيش ما عاش الخادم ──────────────────────────
// ١١٠٨ رسالة خرجت وصفر فتحة. لم يكن أحدٌ لم يفتح — كان العنوان العام
// نفقاً سريعاً شُغِّل يدوياً مرةً ثم مات، فخرجت الرسائل كلها بلا بكسل
// (publicBase يُسقط العنوان الميت). والنفق السريع لا يموت مرةً: يموت مع
// كل نومٍ للجهاز وكل انقطاع شبكة وكل إعادة تشغيل.
//
// فلا يُترك لإنسانٍ أن يتذكّره. الخادم يشغّل cloudflared بنفسه، ويقرأ
// العنوان الجديد من سجلّه، ويتأكّد أن البكسل يصل عبره من الخارج، ثم
// يكتبه في الإعدادات. وإن مات النفق أعاد تشغيله وكتب العنوان الجديد.
//
// يعمل حيث `EMAIL_TUNNEL=quick` فقط — على الجهاز الذي يُرسِل. الخادم
// الحيّ له نطاقه، ونفقٌ ثانٍ هناك يكتب عنواناً لا يصل إلى قاعدة المُرسِل.
//
// ولا يُكتب فوق عنوانٍ دائم: من ضبط نطاقاً حقيقياً (app.pro-count.ae)
// فقد قصده، والنفق لا يعمل حينها أصلاً.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db, emailSettingsTable } from "@workspace/db";
import { logger } from "../logger";
import { isEphemeral, probePublicUrl, setTrackingHealth } from "./public-url";

const FOUND = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BIN = ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];

let child: ChildProcess | null = null;
let current = "";
let stopping = false;

export function tunnelUrl(): string { return current; }

/** يُكتب العنوان لكل حسابٍ عنوانُه فارغ أو مؤقّت — لا فوق نطاقٍ دائم. */
export async function adoptUrl(url: string): Promise<number[]> {
  const rows = await db.select({ userId: emailSettingsTable.userId, publicUrl: emailSettingsTable.publicUrl }).from(emailSettingsTable);
  const took: number[] = [];
  for (const r of rows) {
    const cur = (r.publicUrl ?? "").trim();
    if (cur && !isEphemeral(cur)) continue;
    if (cur !== url) await db.update(emailSettingsTable).set({ publicUrl: url }).where(eq(emailSettingsTable.userId, r.userId));
    setTrackingHealth(r.userId, true);
    took.push(r.userId);
  }
  return took;
}

export function startTunnel(port: number): void {
  if (process.env["EMAIL_TUNNEL"] !== "quick") return;
  const bin = BIN.find((b) => existsSync(b));
  if (!bin) { logger.warn("EMAIL_TUNNEL=quick لكن cloudflared غير مثبّت — قياس الفتح معطّل"); return; }

  let backoff = 5_000;
  const run = () => {
    if (stopping) return;
    const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
    child = p;
    let seen = false;
    const read = (buf: Buffer) => {
      const m = FOUND.exec(buf.toString());
      if (!m || seen) return;
      seen = true;
      const url = m[0];
      // العنوان يُعلَن قبل أن يصير قابلاً للوصول بثوانٍ: يُفحص من الخارج
      // كما يطلبه بريد المستلم، ولا يُكتب حتى يُرجع صورة.
      void (async () => {
        for (let i = 0; i < 12 && !stopping && child === p; i++) {
          await new Promise((r) => setTimeout(r, 5_000));
          const probe = await probePublicUrl(url, 8_000);
          if (!probe.ok) continue;
          current = url;
          backoff = 5_000;
          const users = await adoptUrl(url).catch((err) => { logger.error({ err }, "تعذّر حفظ عنوان النفق"); return []; });
          logger.info({ url, users, ms: probe.ms }, "النفق يعمل — البكسل يصل من الخارج");
          return;
        }
        logger.warn({ url }, "النفق أعلن عنواناً لا يصل — يُعاد تشغيله");
        p.kill();
      })();
    };
    p.stdout?.on("data", read);
    p.stderr?.on("data", read);
    p.on("exit", (code) => {
      if (child === p) { child = null; current = ""; }
      if (stopping) return;
      logger.warn({ code, retryIn: backoff }, "النفق توقّف — يُعاد تشغيله");
      setTimeout(run, backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    });
  };
  run();
  const stop = () => { stopping = true; child?.kill(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("exit", stop);
}
