// ── A browser an employee can use ─────────────────────────────────
// Grok Bot gives each agent its own computer; this is the useful half of that
// for a business that sells accounting services — an employee that can look
// something up before it answers, instead of asking the customer for facts
// that are on their own website.
//
// Three decisions shape everything here.
//
// **Reading is free, changing is not.** Navigating and extracting text happen
// on the agent's own initiative. Anything that submits, posts, buys or sends
// stops and waits for the owner, because an agent that can act on a page can
// act wrongly on it, and the owner is the one who lives with that.
//
// **One session per employee, not per request.** A session keeps its cookies,
// so signing in once holds; and the sessions are named after employees so the
// board can show which one is holding a page open.
//
// **It drives the Chrome already installed**, rather than downloading a second
// browser. Playwright's bundled Chromium is another 150MB to keep current, and
// a machine that already has Chrome does not need it.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger";

/**
 * Where each employee's cookies live.
 *
 * Under Application Support rather than in the project: signing in to a site
 * has to survive a restart, or the owner signs in again every morning and the
 * feature is worse than useless. It is also outside ~/Documents, which the
 * launchd agent cannot read at all.
 */
// On the server (2026-10-22) the profiles live on the data volume, so a redeploy does not sign everyone out.
const PROFILE_ROOT = process.env["BROWSER_PROFILE_DIR"] || join(homedir(), "Library", "Application Support", "whatsapp-marketer", "browser");
/** A server has no screen: a «visible» window is a headless one the owner sees as live pictures in the app. */
const HAS_SCREEN = process.platform === "darwin" || process.platform === "win32" || !!process.env["DISPLAY"];
/** Chromium in a container runs as root, and /dev/shm is small there. */
const SERVER_ARGS = process.platform === "linux" ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"] : [];
const profileDir = (userId: number, role: string) => {
  const dir = join(PROFILE_ROOT, String(userId), role.replace(/[^a-z0-9_-]/gi, ""));
  mkdirSync(dir, { recursive: true });
  return dir;
};

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

/** Whether this machine can show a window; on a server the sign-in is done through pictures. */
export const hasScreen = () => HAS_SCREEN;

/** The owner's own hand on a session with no window: a click at a point of the picture, keys, or a key. */
export async function remoteClick(userId: number, role: string, x: number, y: number): Promise<void> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) throw new Error("لا توجد جلسة مفتوحة");
  await s.page.mouse.click(Math.max(0, Math.min(1280, x)), Math.max(0, Math.min(820, y)));
  s.lastUsedAt = new Date();
}
export async function remoteType(userId: number, role: string, text: string): Promise<void> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) throw new Error("لا توجد جلسة مفتوحة");
  // Typed as keys and never stored or logged: what the owner types is theirs.
  await s.page.keyboard.type(String(text).slice(0, 500), { delay: 40 });
  s.lastUsedAt = new Date();
}
export async function remoteKey(userId: number, role: string, k: string): Promise<void> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) throw new Error("لا توجد جلسة مفتوحة");
  if (!["Enter", "Backspace", "Tab", "Escape", "ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(k)) throw new Error("مفتاح غير مسموح");
  await s.page.keyboard.press(k);
  s.lastUsedAt = new Date();
}

function chromePath(): string | null {
  return process.env["CHROME_PATH"] ?? CHROME_PATHS.find((p) => existsSync(p)) ?? null;
}

export type Session = {
  userId: number;
  role: string;
  context: BrowserContext;
  page: Page;
  openedAt: Date;
  lastUsedAt: Date;
  url: string;
};

let browser: Browser | null = null;
const sessions = new Map<string, Session>();
const key = (userId: number, role: string) => `${userId}:${role}`;

/**
 * Whether a session is showing its window.
 *
 * Signing in is the one thing the owner has to do with their own hands — the
 * alternative is typing a password into this application, which it should
 * never hold. So a session can be opened visibly: a real Chrome window appears,
 * the owner signs in, and the cookies persist into the profile directory for
 * every headless session afterwards.
 */
const visible = new Set<string>();

/** Closed after this long idle, so a forgotten tab is not a permanent process. */
const IDLE_MS = 20 * 60_000;

async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const exe = chromePath();
  if (!exe) throw new Error("لا يوجد متصفح على هذا الجهاز — ثبّت Google Chrome");
  browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", ...SERVER_ARGS],
  });
  logger.info({ exe }, "المتصفح الداخلي جاهز");
  return browser;
}

/**
 * Open a session, optionally as a window the owner can use.
 *
 * A persistent context rather than a fresh one: cookies are written to the
 * employee's own profile directory and are there next time, which is what
 * makes signing in once actually mean once. Persistent contexts launch their
 * own browser process, so these do not share the pooled one above.
 */
export async function openSession(
  userId: number, role: string, opts: { visible?: boolean } = {},
): Promise<Session> {
  const k = key(userId, role);
  const existing = sessions.get(k);
  // A visible session is what the owner asked for and must replace a headless
  // one; the reverse is not true, since a window already open is still usable.
  if (existing && !existing.page.isClosed() && (!opts.visible || visible.has(k))) {
    existing.lastUsedAt = new Date();
    return existing;
  }
  if (existing) await closeSession(userId, role);

  const exe = chromePath();
  if (!exe) throw new Error("لا يوجد متصفح على هذا الجهاز — ثبّت Google Chrome");

  const context = await chromium.launchPersistentContext(profileDir(userId, role), {
    executablePath: exe,
    headless: !(opts.visible && HAS_SCREEN),
    viewport: { width: 1280, height: 820 },
    locale: "ar-AE",
    timezoneId: "Asia/Dubai",
    args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check", ...SERVER_ARGS],
  });

  const page = context.pages()[0] ?? await context.newPage();
  const s: Session = { userId, role, context, page, openedAt: new Date(), lastUsedAt: new Date(), url: page.url() };
  sessions.set(k, s);
  if (opts.visible) visible.add(k); else visible.delete(k);
  logger.info({ userId, role, visible: !!opts.visible }, "فُتحت جلسة تصفّح");
  return s;
}

export const isVisible = (userId: number, role: string) => visible.has(key(userId, role));

export async function closeSession(userId: number, role: string): Promise<void> {
  const k = key(userId, role);
  const s = sessions.get(k);
  if (!s) return;
  await s.context.close().catch(() => {});
  sessions.delete(k);
  visible.delete(k);
}

/** What is open, for the board. */
export function listSessions(userId: number) {
  return [...sessions.values()]
    .filter((s) => s.userId === userId)
    .map((s) => ({
      role: s.role, url: s.url, visible: visible.has(key(s.userId, s.role)),
      openedAt: s.openedAt, lastUsedAt: s.lastUsedAt,
      idleMinutes: Math.round((Date.now() - s.lastUsedAt.getTime()) / 60_000),
    }));
}

// ── Reading ──────────────────────────────────────────────────────

// ── Scripts that run inside the page ─────────────────────────────
// Passed as source strings rather than functions. The server's tsconfig has no
// DOM lib, which is correct for a Node process — adding it so these type-check
// would also let `document` slip into server code, where it is always a bug.
// These are small enough that losing type checking inside them is the cheaper
// trade.

const EXTRACT_TEXT = `(() => {
  // Chrome, menus and cookie banners are not the page. Removing them is what
  // makes the extract short enough to put in a prompt.
  for (const sel of ["script","style","nav","header","footer","noscript","[role=banner]","[role=navigation]","[aria-hidden=true]"]) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }
  const main = document.querySelector("main, article, [role=main]") || document.body;
  return main.innerText.replace(/\\n{3,}/g, "\\n\\n").trim();
})()`;

const EXTRACT_LINKS = `(() =>
  Array.from(document.querySelectorAll("a[href]"))
    .map((a) => ({ text: a.innerText.trim().slice(0, 80), href: a.href }))
    .filter((l) => l.text && l.href.indexOf("http") === 0)
    .slice(0, 40)
)()`;

const EXTRACT_FORM = `(() =>
  Array.from(document.querySelectorAll("input, textarea, select"))
    .filter((e) => e.type !== "hidden")
    .map((e) => {
      const label = (e.labels && e.labels[0] && e.labels[0].innerText.trim())
        || e.getAttribute("aria-label") || e.placeholder || e.name || "";
      return {
        label: String(label).slice(0, 80),
        name: e.name || e.id || "",
        type: e.type || e.tagName.toLowerCase(),
        // Read so the owner can see what is there — except a password field,
        // whose contents never leave the page.
        value: e.type === "password" ? "" : String(e.value == null ? "" : e.value).slice(0, 200),
        required: !!e.required,
      };
    })
    .slice(0, 40)
)()`;

export type FormField = {
  label: string; name: string; type: string; value: string; required: boolean;
};

export type PageRead = {
  url: string; title: string; text: string;
  links: Array<{ text: string; href: string }>;
};

/**
 * Open a page and read it.
 *
 * `networkidle` rather than `load`, because the pages worth reading here —
 * company sites, licence registries — render their content after the shell
 * arrives, and `load` would return an empty frame.
 */
export async function readPage(
  userId: number, role: string, url: string, timeoutMs = 30_000,
): Promise<PageRead> {
  const target = normalizeUrl(url);
  const s = await openSession(userId, role);
  s.lastUsedAt = new Date();

  await s.page.goto(target, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await s.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  s.url = s.page.url();

  const [title, text, links] = await Promise.all([
    s.page.title().catch(() => ""),
    s.page.evaluate<string>(EXTRACT_TEXT).catch(() => ""),
    s.page.evaluate<Array<{ text: string; href: string }>>(EXTRACT_LINKS).catch(() => []),
  ]);

  logger.info({ userId, role, url: s.url, chars: text.length }, "قرأ صفحة");
  return { url: s.url, title, text: text.slice(0, 20_000), links };
}

/** A picture of what the employee is looking at, for the live view. */
export async function screenshot(userId: number, role: string): Promise<Buffer | null> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) return null;
  s.lastUsedAt = new Date();
  return s.page.screenshot({ type: "jpeg", quality: 60, fullPage: false }).catch(() => null);
}

/** Form fields on the page, so the owner can see what would be filled. */
export async function readForm(userId: number, role: string) {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) return [];
  return s.page.evaluate<FormField[]>(EXTRACT_FORM).catch(() => []);
}

// ── Changing ─────────────────────────────────────────────────────
// Everything below alters the page, so none of it is reachable without the
// owner asking for it by name. The route layer is where that is enforced; the
// functions themselves stay small and honest about what they do.

export async function fillField(
  userId: number, role: string, selector: string, value: string,
): Promise<void> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) throw new Error("لا توجد جلسة مفتوحة");
  await s.page.fill(selector, value, { timeout: 10_000 });
  s.lastUsedAt = new Date();
  logger.info({ userId, role, selector }, "ملأ حقلاً");
}

export async function click(userId: number, role: string, selector: string): Promise<void> {
  const s = sessions.get(key(userId, role));
  if (!s || s.page.isClosed()) throw new Error("لا توجد جلسة مفتوحة");
  await s.page.click(selector, { timeout: 10_000 });
  await s.page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
  s.url = s.page.url();
  s.lastUsedAt = new Date();
  logger.info({ userId, role, selector, url: s.url }, "ضغط عنصراً");
}

function normalizeUrl(url: string): string {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  return `https://${u.replace(/^\/+/, "")}`;
}

/** Close idle sessions. Chrome contexts are not free to leave sitting. */
export function startBrowserReaper(): void {
  setInterval(() => {
    for (const [k, s] of sessions) {
      // A window the owner opened stays open. They may be halfway through a
      // sign-in, and closing it would lose it.
      if (visible.has(k)) continue;
      if (Date.now() - s.lastUsedAt.getTime() < IDLE_MS) continue;
      void s.context.close().catch(() => {});
      sessions.delete(k);
      logger.info({ role: s.role }, "أُغلقت جلسة تصفّح خاملة");
    }
    if (sessions.size === 0 && browser?.isConnected()) {
      void browser.close().catch(() => {});
      browser = null;
    }
  }, 5 * 60_000);
}
