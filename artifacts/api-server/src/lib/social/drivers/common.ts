// ── What every platform driver shares ─────────────────────────────
// The three sites ship generated class names that change without notice, so
// a driver finds things the way a person does — by the words on a button, by
// the shape of a link — and tries several routes before giving up. When it
// does give up it says "the page changed", in words the owner can act on,
// rather than throwing a stack trace into a run that has nine other jobs.

import type { Page } from "playwright-core";

export type LoginState = "logged_in" | "logged_out" | "checkpoint" | "restricted" | "unknown";
export type Result = { ok: boolean; error?: string };
export type Person = { handle: string; name?: string; headline?: string; profileUrl: string; city?: string };
export type ScrapedComment = { externalId: string; author: string; authorUrl?: string; text: string };
export type ScrapedThread = { handle: string; name?: string; preview: string; unread: boolean; threadUrl?: string };
export type ScrapedMessage = { fromMe: boolean; text: string };

export interface Driver {
  loginState(page: Page): Promise<{ state: LoginState; username?: string; note?: string }>;
  /** The account's own latest posts, to watch for comments. */
  myPosts(page: Page, username: string, max: number): Promise<Array<{ externalId: string; url: string }>>;
  readComments(page: Page, url: string, max: number): Promise<{ comments: ScrapedComment[]; caption?: string | null; error?: string }>;
  replyToComment(page: Page, url: string, comment: { author: string; text: string }, reply: string): Promise<Result>;
  readInbox(page: Page, max: number): Promise<{ threads: ScrapedThread[]; error?: string }>;
  readThread(page: Page, thread: { handle: string; name?: string | null; threadUrl?: string | null }, max: number): Promise<{ messages: ScrapedMessage[]; threadUrl?: string; error?: string }>;
  /** A message; `fresh` opens a conversation from the person's profile when none exists. */
  sendDm(page: Page, to: { handle: string; profileUrl?: string | null; threadUrl?: string | null; name?: string | null }, text: string, opts: { fresh: boolean }): Promise<Result & { unreachable?: boolean; threadUrl?: string }>;
  search(page: Page, query: string, max: number): Promise<{ people: Person[]; error?: string }>;
  /** LinkedIn only: an invitation, with a note when one fits. */
  connect?(page: Page, profileUrl: string, note: string | null): Promise<Result & { pending?: boolean; connected?: boolean; noteDropped?: boolean }>;
  connectionState?(page: Page, profileUrl: string): Promise<"connected" | "pending" | "none" | "unknown">;
  /** A text post. Instagram and TikTok cannot post without a picture or a video, and say so. */
  publish(page: Page, text: string): Promise<Result & { url?: string }>;
  /** A comment on someone else's post — engagement. */
  commentOn(page: Page, postUrl: string, text: string): Promise<Result>;
}

/** A pause a person would take. Never the same twice. */
export const human = (minMs: number, maxMs: number) =>
  new Promise((r) => setTimeout(r, Math.round(minMs + Math.random() * (maxMs - minMs))));

/**
 * Typed, not pasted: a field filled in a millisecond is the clearest sign
 * nobody is at the keyboard. Newlines go in as Shift+Enter, because a plain
 * Enter sends the message half-written on all three sites.
 */
export async function typeHuman(page: Page, text: string) {
  for (const ch of text) {
    if (ch === "\n") { await page.keyboard.press("Shift+Enter"); continue; }
    await page.keyboard.type(ch, { delay: 18 + Math.random() * 55 });
  }
}

/** Open a page, and give it the moment a person would before acting. */
export async function go(page: Page, url: string, settle: [number, number] = [2_000, 4_000]) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });
  await human(settle[0], settle[1]);
}

/**
 * Click the first visible button or link whose words match — in English or
 * Arabic, since the owner's account may be set to either.
 */
export async function clickByText(page: Page, words: RegExp, scope = "button, [role='button'], a, div[role='menuitem'], li[role='menuitem']"): Promise<boolean> {
  const clicked = await page.evaluate(`(() => {
    const re = new RegExp(${JSON.stringify(words.source)}, ${JSON.stringify(words.flags)});
    for (const el of Array.from(document.querySelectorAll(${JSON.stringify(scope)}))) {
      const label = ((el.getAttribute("aria-label") || "") + " " + (el.innerText || "")).trim();
      if (!label || !re.test(label)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      el.click();
      return true;
    }
    return false;
  })()`).catch(() => false);
  return !!clicked;
}

/** The first of several selectors that is on the page. */
export async function first(page: Page, selectors: string[]) {
  for (const s of selectors) {
    const el = await page.$(s).catch(() => null);
    if (el && await el.isVisible().catch(() => false)) return el;
  }
  return null;
}

/** A wall the automation must stop at: a puzzle, a code, a "confirm it's you". Pushing through turns a check into a ban. */
export async function wall(page: Page): Promise<string | null> {
  const t = String(await page.evaluate(`(document.body && document.body.innerText || "").slice(0, 4000)`).catch(() => ""));
  if (/captcha|verify to continue|drag the slider|security verification|let's do a quick security check|confirm (it'?s|that it'?s) you|تحقق من أنك|أكّد هويتك|أكمل التحقق/i.test(t)) return "المنصة تطلب تحققاً (لغز أو رمز) — افتح النافذة وأكمله بنفسك";
  if (/action blocked|we restrict certain activity|temporarily restricted|your account has been restricted|you've reached the weekly invitation limit|تم حظر الإجراء|نحن نقيّد|تم تقييد/i.test(t)) return "المنصة قيّدت النشاط على الحساب — أوقفت كل شيء";
  return null;
}

/** Same-words test for "did my message actually appear". */
export const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
