// ── Driving Instagram ─────────────────────────────────────────────
// The owner signs in once with their own hands, in a real Chrome window, and
// the cookies persist into that employee's browser profile. This application
// never holds the password.
//
// Everything below is written against one fact that governs the design:
// Instagram does not return an error when it dislikes your behaviour. It
// restricts the account, silently, and tells you days later by hiding your
// comments from everyone but you. So the defences are not error handling —
// they are pacing, caps, and a record of every action taken.
//
// Selectors are the fragile part and always will be: Instagram ships
// obfuscated class names that change without notice. Each lookup tries several
// routes and the failure is reported as "the page changed" rather than as a
// crash, because when it breaks the owner needs to know that rather than see a
// stack trace.

import { openSession, closeSession, screenshot } from "../browser-agent";
import { db, instagramActionsTable } from "@workspace/db";
import { logger } from "../logger";

export const IG = "https://www.instagram.com";

/** A pause a person would take. Never the same twice. */
export const human = (minMs: number, maxMs: number) =>
  new Promise((r) => setTimeout(r, Math.round(minMs + Math.random() * (maxMs - minMs))));

export async function record(
  userId: number, role: string, action: string,
  opts: { target?: string; ok?: boolean; detail?: string } = {},
): Promise<void> {
  await db.insert(instagramActionsTable).values({
    userId, role, action,
    target: opts.target?.slice(0, 120) ?? null,
    ok: opts.ok !== false,
    detail: opts.detail?.slice(0, 500) ?? null,
  }).catch(() => {});
}

export type LoginState = "logged_in" | "logged_out" | "checkpoint" | "restricted" | "unknown";

/**
 * Who, if anyone, this browser profile is signed in as.
 *
 * Read from the page rather than from a stored flag: a session can be ended
 * from the phone at any time, and acting on a stale "logged in" is how a run
 * ends up typing a reply into a login form.
 */
export async function loginState(userId: number, role: string): Promise<{ state: LoginState; username?: string; note?: string }> {
  const s = await openSession(userId, role);
  try {
    await s.page.goto(`${IG}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await human(1_500, 3_000);
    const url = s.page.url();

    if (/\/accounts\/login/.test(url)) return { state: "logged_out" };
    // Instagram's word for "prove it is you" — a code, a puzzle, a phone
    // confirmation. Automation must stop dead here; pushing through is what
    // turns a checkpoint into a ban.
    if (/\/challenge|\/accounts\/suspended/.test(url)) {
      return { state: "checkpoint", note: "إنستجرام يطلب تأكيد الهوية — افتح النافذة وأكمله بنفسك" };
    }

    const probe = await s.page.evaluate(`(() => {
      const body = document.body.innerText || "";
      const restricted = /We restrict certain activity|Action Blocked|تم حظر الإجراء|نحن نقيّد/i.test(body);
      // The profile link in the nav carries the username on a signed-in page.
      const a = Array.from(document.querySelectorAll('a[href^="/"]'))
        .map((x) => x.getAttribute("href") || "")
        .filter((h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h) && !/\\/(explore|reels|direct|accounts)\\//.test(h));
      const nav = document.querySelector('nav, [role="navigation"]');
      return { restricted, hasNav: !!nav, candidates: a.slice(0, 6) };
    })()`) as any;

    if (probe?.restricted) {
      return { state: "restricted", note: "إنستجرام قيّد النشاط على هذا الحساب — أوقف كل شيء وانتظر" };
    }
    if (!probe?.hasNav) return { state: "unknown", note: "لم أتعرّف على الصفحة — ربما تغيّر شكل إنستجرام" };

    return { state: "logged_in", username: (probe.candidates?.[0] ?? "").replace(/\//g, "") || undefined };
  } catch (err: any) {
    return { state: "unknown", note: String(err?.message ?? err).slice(0, 140) };
  } finally {
    await record(userId, role, "login_check");
  }
}

export type ScrapedComment = { externalId: string; author: string; text: string };

/**
 * The comments on one post.
 *
 * Read from the rendered page because Instagram's internal API changes shape
 * without notice and needs headers this never sees. The identifier is the
 * author plus the text when nothing better is exposed — not elegant, but
 * stable enough that the same comment is never answered twice.
 */
export async function readComments(
  userId: number, role: string, postUrl: string, max = 50,
): Promise<{ comments: ScrapedComment[]; caption: string | null; error?: string }> {
  const s = await openSession(userId, role);
  try {
    await s.page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await human(2_000, 4_000);

    // Open the rest of the thread a few times — Instagram shows a handful and
    // hides the others behind a button, and a person would click it.
    for (let i = 0; i < 3; i++) {
      const more = await s.page.$('button svg[aria-label*="Load more"], button[aria-label*="Load more"]').catch(() => null);
      if (!more) break;
      await more.click().catch(() => {});
      await human(1_200, 2_600);
    }

    const out = await s.page.evaluate(`(() => {
      const seen = new Set();
      const rows = [];
      // Comments live in list items that contain a profile link and text. The
      // class names are generated, so the shape is what we match on.
      for (const li of Array.from(document.querySelectorAll('ul li, div[role="button"] + div'))) {
        const a = li.querySelector('a[href^="/"]');
        if (!a) continue;
        const author = (a.getAttribute('href') || '').replace(/\\//g, '');
        if (!author || /^(explore|reels|direct|accounts|p)$/.test(author)) continue;
        const spans = Array.from(li.querySelectorAll('span'))
          .map((s) => (s.textContent || '').trim())
          .filter((t) => t && t !== author && t.length > 1);
        const text = spans.sort((x, y) => y.length - x.length)[0] || '';
        if (!text || text.length < 2) continue;
        const key = author + '|' + text.slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ externalId: key, author, text: text.slice(0, 800) });
      }
      const cap = document.querySelector('h1, article h1');
      return { rows: rows.slice(0, ${max}), caption: cap ? (cap.textContent || '').slice(0, 500) : null };
    })()`) as any;

    await record(userId, role, "read_comments", { target: postUrl, detail: `${out?.rows?.length ?? 0} تعليق` });
    if (!out?.rows?.length) {
      return { comments: [], caption: out?.caption ?? null, error: "لم أجد تعليقات — إما لا توجد أو تغيّر شكل الصفحة" };
    }
    return { comments: out.rows, caption: out.caption ?? null };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 160);
    await record(userId, role, "read_comments", { target: postUrl, ok: false, detail: msg });
    return { comments: [], caption: null, error: msg };
  }
}

/**
 * Reply to a comment, by mentioning its author.
 *
 * Instagram's own reply button attaches the reply to a thread; mentioning the
 * author in a new comment reaches them the same way and survives far more
 * layout changes. It is also what a person does from a phone half the time.
 */
export async function replyToComment(
  userId: number, role: string, postUrl: string, author: string, text: string,
): Promise<{ ok: boolean; error?: string }> {
  const s = await openSession(userId, role);
  try {
    if (!s.page.url().startsWith(postUrl)) {
      await s.page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 35_000 });
      await human(2_000, 4_000);
    }

    const box = await s.page.$('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i], form textarea')
      .catch(() => null);
    if (!box) {
      await record(userId, role, "reply_comment", { target: author, ok: false, detail: "لم أجد حقل التعليق" });
      return { ok: false, error: "لم أجد حقل التعليق — ربما تغيّر شكل إنستجرام أو التعليقات مغلقة" };
    }

    const body = `@${author} ${text}`.slice(0, 2_200);
    await box.click();
    await human(400, 900);
    // Typed rather than pasted: a field filled instantly is the single
    // clearest signal that nobody is at the keyboard.
    for (const ch of body) {
      await s.page.keyboard.type(ch, { delay: 18 + Math.random() * 55 });
    }
    await human(700, 1_600);

    const post = await s.page.$('form button[type="submit"], div[role="button"]:has-text("Post")').catch(() => null);
    if (post) await post.click().catch(() => {});
    else await s.page.keyboard.press("Enter");

    await human(2_000, 3_500);
    await record(userId, role, "reply_comment", { target: author, detail: text.slice(0, 120) });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 160);
    await record(userId, role, "reply_comment", { target: author, ok: false, detail: msg });
    return { ok: false, error: msg };
  }
}

export type ScrapedThread = { username: string; preview: string; unread: boolean };

/** The direct inbox, as a list of who is waiting. */
export async function readInbox(userId: number, role: string, max = 30): Promise<{ threads: ScrapedThread[]; error?: string }> {
  const s = await openSession(userId, role);
  try {
    await s.page.goto(`${IG}/direct/inbox/`, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await human(2_500, 4_500);

    const rows = await s.page.evaluate(`(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('div[role="listitem"], a[href^="/direct/t/"]'))) {
        const texts = Array.from(el.querySelectorAll('span'))
          .map((s) => (s.textContent || '').trim()).filter(Boolean);
        if (texts.length < 1) continue;
        const username = texts[0];
        const preview = texts.slice(1).find((t) => t.length > 2) || '';
        if (!username || username.length > 60) continue;
        out.push({ username, preview: preview.slice(0, 200), unread: /·/.test(el.textContent || '') });
      }
      return out.slice(0, ${max});
    })()`) as any;

    await record(userId, role, "read_dms", { detail: `${rows?.length ?? 0} محادثة` });
    if (!rows?.length) return { threads: [], error: "لم أجد محادثات — إما الوارد فارغ أو تغيّر شكل الصفحة" };
    return { threads: rows };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 160);
    await record(userId, role, "read_dms", { ok: false, detail: msg });
    return { threads: [], error: msg };
  }
}

/**
 * Send a direct message to someone already in the inbox.
 *
 * Deliberately only to an existing conversation: opening one with a stranger
 * is the behaviour Instagram restricts accounts for, and it is not what this
 * system is for.
 */
export async function sendDm(
  userId: number, role: string, username: string, text: string,
): Promise<{ ok: boolean; error?: string }> {
  const s = await openSession(userId, role);
  try {
    await s.page.goto(`${IG}/direct/inbox/`, { waitUntil: "domcontentloaded", timeout: 35_000 });
    await human(2_000, 3_500);

    const opened = await s.page.evaluate(`(() => {
      for (const el of Array.from(document.querySelectorAll('div[role="listitem"], a[href^="/direct/t/"]'))) {
        if ((el.textContent || '').includes(${JSON.stringify(username)})) {
          (el.querySelector('a') || el).click();
          return true;
        }
      }
      return false;
    })()`) as boolean;

    if (!opened) {
      await record(userId, role, "send_dm", { target: username, ok: false, detail: "المحادثة غير موجودة في الوارد" });
      return { ok: false, error: `لا توجد محادثة مع @${username} في الوارد — هذا النظام لا يفتح محادثة مع من لم يراسلك` };
    }
    await human(2_000, 3_500);

    const box = await s.page.$('div[contenteditable="true"][role="textbox"], textarea[placeholder*="Message" i]').catch(() => null);
    if (!box) {
      await record(userId, role, "send_dm", { target: username, ok: false, detail: "لم أجد حقل الرسالة" });
      return { ok: false, error: "لم أجد حقل الرسالة — ربما تغيّر شكل إنستجرام" };
    }

    await box.click();
    await human(400, 900);
    for (const ch of text.slice(0, 900)) {
      await s.page.keyboard.type(ch, { delay: 20 + Math.random() * 60 });
    }
    await human(800, 1_800);
    await s.page.keyboard.press("Enter");
    await human(1_500, 3_000);

    await record(userId, role, "send_dm", { target: username, detail: text.slice(0, 120) });
    return { ok: true };
  } catch (err: any) {
    const msg = String(err?.message ?? err).slice(0, 160);
    await record(userId, role, "send_dm", { target: username, ok: false, detail: msg });
    return { ok: false, error: msg };
  }
}

export { openSession as openInstagram, closeSession as closeInstagram, screenshot as instagramScreen };
