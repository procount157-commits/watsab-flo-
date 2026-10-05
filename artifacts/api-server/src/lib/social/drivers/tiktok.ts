// ── TikTok, through the account's own browser ─────────────────────
// TikTok's web client marks its parts with data-e2e attributes for its own
// tests, and those are far steadier than its class names — so they come first
// here, with words on buttons as the fallback.
//
// It is also the most suspicious of the three: a puzzle appears at the first
// sign of a script, and the desk stops dead when it does. Posting needs a
// video, which this cannot make; the team writes the caption and the owner
// posts from the phone.

import { type Driver, clickByText, first, go, human, typeHuman, wall } from "./common";
import { bubbles } from "./instagram";

const TT = "https://www.tiktok.com";

export const tiktok: Driver = {
  async loginState(page) {
    await go(page, `${TT}/foryou`, [2_500, 4_500]);
    const w = await wall(page);
    if (w) return { state: /قيّدت/.test(w) ? "restricted" : "checkpoint", note: w };
    const probe = await page.evaluate(`(() => {
      const prof = document.querySelector('[data-e2e="nav-profile"], a[data-e2e="profile-icon"]');
      const href = prof ? (prof.getAttribute('href') || prof.closest('a')?.getAttribute('href') || '') : '';
      const login = document.querySelector('[data-e2e="top-login-button"], #header-login-button, button[data-e2e="nav-login-button"]');
      const avatar = document.querySelector('[data-e2e="profile-icon"], [data-e2e="nav-avatar"]');
      return { href, login: !!login, avatar: !!avatar };
    })()`) as any;
    if (probe?.login && !probe?.avatar) return { state: "logged_out" };
    const username = /\/@([^/?]+)/.exec(probe?.href ?? "")?.[1];
    if (probe?.avatar || username) return { state: "logged_in", username };
    return { state: "unknown", note: "لم أتعرّف على الصفحة — ربما تغيّر شكل تيك توك" };
  },

  async myPosts(page, username, max) {
    await go(page, `${TT}/@${username}`, [3_000, 5_000]);
    const rows = await page.evaluate(`(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]'))
      .map((a) => a.href))).slice(0, ${max}))()`) as string[];
    return rows.map((url) => ({ externalId: /\/(?:video|photo)\/(\d+)/.exec(url)?.[1] ?? "", url })).filter((r) => r.externalId);
  },

  async readComments(page, url, max) {
    await go(page, url, [3_000, 5_000]);
    const w = await wall(page);
    if (w) return { comments: [], error: w };
    // The comment panel opens beside the video; on some layouts it waits behind the comment icon.
    if (!(await page.$('[data-e2e="comment-level-1"]').catch(() => null))) {
      await (await first(page, ['[data-e2e="comment-icon"]', '[data-e2e="browse-comment-icon"]']))?.click().catch(() => {});
      await human(2_000, 3_500);
    }
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 900); await human(900, 1_800); }
    const out = await page.evaluate(`(() => {
      const rows = [], seen = new Set();
      for (const t of Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]'))) {
        const item = t.closest('div[class*="CommentItem"], div[class*="CommentObject"], div[class*="DivCommentContentContainer"]') || t.parentElement.parentElement;
        const a = item ? item.querySelector('a[href^="/@"]') : null;
        const author = a ? (a.getAttribute('href') || '').replace(/^\\/@/, '').split(/[/?]/)[0] : '';
        const text = (t.innerText || '').trim();
        if (!author || !text) continue;
        const key = author + '|' + text.slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ externalId: key, author, authorUrl: 'https://www.tiktok.com/@' + author, text: text.slice(0, 800) });
      }
      const cap = document.querySelector('[data-e2e="browse-video-desc"], [data-e2e="video-desc"]');
      return { rows: rows.slice(0, ${max}), caption: cap ? (cap.innerText || '').slice(0, 500) : null };
    })()`) as any;
    if (!out?.rows?.length) return { comments: [], caption: out?.caption ?? null, error: "لم أجد تعليقات — إما لا توجد أو تغيّر شكل الصفحة" };
    return { comments: out.rows, caption: out.caption };
  },

  async replyToComment(page, url, comment, reply) {
    if (!page.url().startsWith(url)) await go(page, url, [3_000, 5_000]);
    // The comment's own reply button, so the answer sits under it; failing that, a mention.
    const replied = await page.evaluate(`(() => {
      for (const t of Array.from(document.querySelectorAll('[data-e2e="comment-level-1"]'))) {
        if (!(t.innerText || '').includes(${JSON.stringify(comment.text.slice(0, 40))})) continue;
        const item = t.closest('div[class*="CommentItem"], div[class*="DivCommentContentContainer"]') || t.parentElement.parentElement;
        const btn = item && item.querySelector('[data-e2e="comment-reply-1"], span[role="button"]');
        if (btn) { btn.click(); return true; }
      }
      return false;
    })()`) as boolean;
    await human(800, 1_600);
    const box = await first(page, ['[data-e2e="comment-input"] [contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]']);
    if (!box) return { ok: false, error: "لم أجد حقل التعليق — ربما التعليقات مغلقة أو تغيّر شكل تيك توك" };
    await box.click();
    await human(400, 900);
    await typeHuman(page, (replied ? reply : `@${comment.author} ${reply}`).slice(0, 150 * 4));
    await human(700, 1_500);
    const post = await first(page, ['[data-e2e="comment-post"]', 'div[class*="PostButton"]']);
    if (post) await post.click().catch(() => {}); else await page.keyboard.press("Enter");
    await human(2_000, 3_500);
    const w = await wall(page);
    return w ? { ok: false, error: w } : { ok: true };
  },

  async readInbox(page, max) {
    await go(page, `${TT}/messages`, [3_000, 5_000]);
    const w = await wall(page);
    if (w) return { threads: [], error: w };
    const rows = await page.evaluate(`(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('[data-e2e="chat-list-item"], div[class*="ConversationListItem"], div[class*="DivItemWrapper"]'))) {
        const nick = el.querySelector('[data-e2e="chat-list-item-nickname"], p[class*="PInfoNickname"], p');
        const name = nick ? (nick.innerText || '').trim() : '';
        if (!name) continue;
        const ps = Array.from(el.querySelectorAll('p, span')).map((x) => (x.innerText || '').trim()).filter((x) => x && x !== name);
        out.push({ handle: name, name, preview: (ps[0] || '').slice(0, 200), unread: !!el.querySelector('[class*="Unread"], [class*="Badge"], [data-e2e*="unread"]') });
      }
      return out.slice(0, ${max});
    })()`) as any;
    if (!rows?.length) return { threads: [], error: "لم أجد محادثات — إما الوارد فارغ أو تغيّر شكل الصفحة" };
    return { threads: rows };
  },

  async readThread(page, thread, max) {
    if (!page.url().startsWith(`${TT}/messages`)) await go(page, `${TT}/messages`, [3_000, 5_000]);
    const opened = await clickByText(page, new RegExp(`^${escapeRe(thread.name ?? thread.handle)}`), '[data-e2e="chat-list-item"], div[class*="ConversationListItem"], div[class*="DivItemWrapper"]');
    if (!opened) return { messages: [], error: "لم أجد المحادثة في الوارد" };
    await human(2_000, 3_500);
    return { messages: await bubbles(page, '[data-e2e="chat-item"], div[class*="DivChatItemWrapper"]', max) };
  },

  async sendDm(page, to, text, opts) {
    let ready = false;
    if (!opts.fresh) {
      if (!page.url().startsWith(`${TT}/messages`)) await go(page, `${TT}/messages`, [3_000, 5_000]);
      ready = await clickByText(page, new RegExp(`^${escapeRe(to.name ?? to.handle)}`), '[data-e2e="chat-list-item"], div[class*="ConversationListItem"], div[class*="DivItemWrapper"]');
    }
    if (!ready) {
      if (!opts.fresh) return { ok: false, error: "لا محادثة قائمة مع هذا الشخص" };
      await go(page, to.profileUrl ?? `${TT}/@${to.handle}`, [3_000, 5_000]);
      const w = await wall(page);
      if (w) return { ok: false, error: w };
      const btn = await first(page, ['[data-e2e="message-button"]', 'button[data-e2e="message-icon"]']);
      if (btn) await btn.click().catch(() => {});
      else if (!(await clickByText(page, /^(message|مراسلة|رسالة)$/i))) return { ok: false, unreachable: true, error: "لا زر رسالة في الملف — الحساب لا يستقبل رسائل إلا من أصدقائه" };
      await human(3_000, 5_000);
    }
    const box = await first(page, ['[data-e2e="message-input-area"] [contenteditable="true"]', 'div[class*="DivEditorContainer"] [contenteditable="true"]', 'div[contenteditable="true"]']);
    if (!box) return { ok: false, unreachable: opts.fresh, error: "لم أجد حقل الرسالة — قد لا يسمح الحساب بالرسائل" };
    await box.click();
    await human(400, 900);
    await typeHuman(page, text.slice(0, 1_000));
    await human(800, 1_800);
    const send = await first(page, ['[data-e2e="message-send"]', 'svg[data-e2e="message-send"]']);
    if (send) await send.click().catch(() => {}); else await page.keyboard.press("Enter");
    await human(1_500, 3_000);
    const w = await wall(page);
    return w ? { ok: false, error: w } : { ok: true };
  },

  async search(page, query, max) {
    await go(page, `${TT}/search/user?q=${encodeURIComponent(query)}`, [3_500, 6_000]);
    const w = await wall(page);
    if (w) return { people: [], error: w };
    for (let i = 0; i < Math.ceil(max / 10); i++) { await page.mouse.wheel(0, 1_400); await human(1_200, 2_200); }
    const people = await page.evaluate(`(() => {
      const out = [], seen = new Set();
      for (const a of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
        const handle = (a.getAttribute('href') || '').replace(/^\\/@/, '').split(/[/?]/)[0].toLowerCase();
        if (!handle || seen.has(handle)) continue;
        const card = a.closest('div[data-e2e="search-user-container"], div[class*="UserItemContainer"]') || a;
        const nick = card.querySelector('[data-e2e="search-user-nickname"]');
        const desc = card.querySelector('[data-e2e="search-user-desc"], p[class*="UserDesc"]');
        seen.add(handle);
        out.push({ handle, name: nick ? nick.innerText.trim() : '', headline: desc ? desc.innerText.trim().slice(0, 200) : '', profileUrl: 'https://www.tiktok.com/@' + handle });
      }
      return out;
    })()`) as any[];
    if (!people?.length) return { people: [], error: "لم أجد حسابات — جرّب كلمات أخرى أو تغيّر شكل الصفحة" };
    return { people: people.slice(0, max) };
  },

  async publish() {
    return { ok: false, error: "تيك توك لا يقبل منشوراً بلا فيديو — الوصف جاهز، انشره من هاتفك مع الفيديو" };
  },

  async commentOn(page, postUrl, text) {
    await go(page, postUrl, [3_000, 5_000]);
    const w = await wall(page);
    if (w) return { ok: false, error: w };
    const box = await first(page, ['[data-e2e="comment-input"] [contenteditable="true"]', 'div[contenteditable="true"]']);
    if (!box) return { ok: false, error: "لم أجد حقل التعليق" };
    await box.click();
    await human(400, 900);
    await typeHuman(page, text.slice(0, 600));
    await human(700, 1_500);
    const post = await first(page, ['[data-e2e="comment-post"]']);
    if (post) await post.click().catch(() => {}); else await page.keyboard.press("Enter");
    await human(2_000, 3_500);
    return { ok: true };
  },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
