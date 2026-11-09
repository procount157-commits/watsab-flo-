// ── The internal browser ──────────────────────────────────────────
// Reading is on the agent's own initiative; anything that changes a page goes
// through the owner. That split is enforced here rather than in the browser
// module, so the rule is visible in one place and cannot be bypassed by a
// caller that forgot about it.

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db, botEmployeesTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  readPage, readForm, screenshot, listSessions, closeSession,
  fillField, click, openSession,
} from "../lib/browser-agent";
import { complete } from "../lib/llm";
import { say } from "../lib/agent-comms";
import { logger } from "../lib/logger";
import { asWorker } from "../lib/agent-context";

const router = Router();
router.use(requireAuth);

async function ownsRole(userId: number, role: string): Promise<boolean> {
  const [r] = await db.select({ id: botEmployeesTable.id }).from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  return !!r;
}

/**
 * Hosts an employee may open on its own.
 *
 * Empty means anywhere, which is the default: the owner's own staff looking up
 * a customer's website is the point, and a list of permitted domains would
 * have to be maintained by hand for no gain. BROWSER_BLOCKED exists for the
 * opposite case — a host the owner wants kept out of reach entirely.
 */
const BLOCKED = (process.env["BROWSER_BLOCKED"] ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

function allowed(url: string): boolean {
  try {
    const host = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase();
    // localhost and private ranges: an employee browsing the machine it runs
    // on has no legitimate use and every illegitimate one.
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[?::1)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return !BLOCKED.some((b) => host === b || host.endsWith(`.${b}`));
  } catch { return false; }
}

router.get("/sessions", async (req, res) => res.json(listSessions(req.session.userId!)));

/** Open a page and read it. */
router.post("/:role/read", async (req, res) => {
  const userId = req.session.userId!;
  const role = req.params.role!;
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });

  const url = String(req.body?.url ?? "").trim();
  if (!url) return res.status(400).json({ error: "الرابط مطلوب" });
  if (!allowed(url)) return res.status(403).json({ error: "هذا العنوان غير مسموح" });

  try {
    const page = await readPage(userId, role, url);
    res.json({ ...page, text: page.text.slice(0, 8_000) });
  } catch (err: any) {
    res.status(502).json({ error: String(err?.message ?? err).slice(0, 200) });
  }
});

/**
 * Read a company's site and pull out what actually qualifies them.
 *
 * The reason the browser earns its place: an employee that can look at the
 * customer's own website stops asking them to describe their business, which
 * is both faster and reads as having done some homework.
 */
router.post("/:role/research", async (req, res) => {
  const userId = req.session.userId!;
  const role = req.params.role!;
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });

  const url = String(req.body?.url ?? "").trim();
  if (!url || !allowed(url)) return res.status(400).json({ error: "رابط غير صالح" });

  try {
    const page = await readPage(userId, role, url);
    const out = await asWorker(userId, role, () => complete([
      { role: "system", content: [
        "تقرأ موقع شركة لتجهيز مندوب مبيعات خدمات محاسبية في الإمارات قبل محادثته مع صاحبها.",
        "استخرج فقط ما يُغيّر طريقة الحديث معه، بالعربية، في أسطر قصيرة:",
        "- النشاط بالضبط",
        "- حجم الشركة إن ظهر (فروع، موظفون، أسواق)",
        "- إشارات تخص المحاسبة أو الضريبة أو الرخصة",
        "- أفضل مدخل للحديث معه، سطر واحد",
        "لا تخترع ما ليس في الصفحة. إن لم تجد معلومة فقل «غير ظاهر».",
      ].join("\n") },
      { role: "user", content: `${page.title}\n${page.url}\n\n${page.text.slice(0, 6_000)}` },
    ]));

    const brief = out?.text?.trim() ?? null;
    if (brief) {
      await say({ userId, fromRole: role, toRole: null, kind: "report",
        body: `بحثت في ${page.url}:\n${brief}` }).catch(() => {});
    }
    res.json({ url: page.url, title: page.title, brief });
  } catch (err: any) {
    res.status(502).json({ error: String(err?.message ?? err).slice(0, 200) });
  }
});

/** A frame of what the employee is looking at. */
router.get("/:role/screen", async (req, res) => {
  const shot = await screenshot(req.session.userId!, req.params.role!);
  if (!shot) return res.status(404).json({ error: "لا توجد جلسة مفتوحة" });
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "no-store");
  res.send(shot);
});

router.get("/:role/form", async (req, res) =>
  res.json(await readForm(req.session.userId!, req.params.role!)));

/**
 * Fill a field, or press something.
 *
 * The owner asks for each of these by hand. An employee cannot reach them: a
 * page that can be typed into can be submitted, and what gets submitted is the
 * owner's problem, not the model's.
 */
router.post("/:role/fill", async (req, res) => {
  const { selector, value } = req.body ?? {};
  if (!selector || value === undefined) return res.status(400).json({ error: "selector و value مطلوبان" });
  try {
    await fillField(req.session.userId!, req.params.role!, String(selector), String(value));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message ?? err).slice(0, 200) });
  }
});

router.post("/:role/click", async (req, res) => {
  const selector = String(req.body?.selector ?? "");
  if (!selector) return res.status(400).json({ error: "selector مطلوب" });
  try {
    await click(req.session.userId!, req.params.role!, selector);
    logger.info({ userId: req.session.userId, role: req.params.role, selector }, "المالك ضغط عنصراً");
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message ?? err).slice(0, 200) });
  }
});

/**
 * Open a session, and optionally show its window.
 *
 * Visible is how the owner signs in. They do it with their own hands in a real
 * Chrome window; this application never sees the password, and the cookies
 * persist into the employee's profile so every headless session afterwards is
 * already signed in.
 */
router.post("/:role/open", async (req, res) => {
  const userId = req.session.userId!;
  const role = req.params.role!;
  if (!await ownsRole(userId, role)) return res.status(404).json({ error: "الموظف غير موجود" });

  const wantVisible = req.body?.visible === true;
  const s = await openSession(userId, role, { visible: wantVisible });

  const url = String(req.body?.url ?? "").trim();
  if (url) {
    if (!allowed(url)) return res.status(403).json({ error: "هذا العنوان غير مسموح" });
    await s.page.goto(/^https?:\/\//i.test(url) ? url : `https://${url}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    s.url = s.page.url();
  }
  res.json({ ok: true, visible: wantVisible, url: s.url });
});

router.delete("/:role", async (req, res) => {
  await closeSession(req.session.userId!, req.params.role!);
  res.json({ ok: true });
});

export default router;
