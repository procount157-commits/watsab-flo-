// ── Instagram, through the account's own browser ──────────────────
// Carried over from the first Instagram desk, which read comments and the
// inbox and answered them. What is new: opening a conversation from a
// person's profile (for the targets the owner chose), searching for people,
// finding the account's own posts, and reading a whole conversation.

import type { Page } from "playwright-core";
import { type Driver, clickByText, first, go, human, typeHuman, wall } from "./common";

const IG = "https://www.instagram.com";

export const instagram: Driver = {
  async loginState(page) {
    await go(page, `${IG}/`, [1_500, 3_000]);
    const url = page.url();
    if (/\/accounts\/login/.test(url)) return { state: "logged_out" };
    if (/\/challenge|\/accounts\/suspended/.test(url)) return { state: "checkpoint", note: "إنستجرام يطلب تأكيد الهوية — افتح النافذة وأكمله بنفسك" };
    const w = await wall(page);
    if (w) return { state: /قيّدت/.test(w) ? "restricted" : "checkpoint", note: w };
    const probe = await page.evaluate(`(() => {
      const links = Array.from(document.querySelectorAll('a[href^="/"]')).map((x) => x.getAttribute("href") || "")
        .filter((h) => /^\\/[A-Za-z0-9._]+\\/$/.test(h) && !/\\/(explore|reels|direct|accounts)\\//.test(h));
      return { hasNav: !!document.querySelector('nav, [role="navigation"]'), candidates: links.slice(0, 6) };
    })()`) as any;
    if (!probe?.hasNav) return { state: "unknown", note: "لم أتعرّف على الصفحة — ربما تغيّر شكل إنستجرام" };
    return { state: "logged_in", username: (probe.candidates?.[0] ?? "").replace(/\//g, "") || undefined };
  },

  async myPosts(page, username, max) {
    await go(page, `${IG}/${username}/`);
    const rows = await page.evaluate(`(() => Array.from(new Set(Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'))
      .map((a) => a.getAttribute('href') || ''))).slice(0, ${max}))()`) as string[];
    return rows.map((h) => ({ externalId: /\/(?:p|reel)\/([^/]+)/.exec(h)?.[1] ?? h, url: `${IG}${h.startsWith("/") ? h : `/${h}`}` })).filter((r) => r.externalId);
  },

  async readComments(page, url, max) {
    await go(page, url);
    for (let i = 0; i < 3; i++) {
      const more = await page.$('button svg[aria-label*="Load more"], button[aria-label*="Load more"]').catch(() => null);
      if (!more) break;
      await more.click().catch(() => {});
      await human(1_200, 2_600);
    }
    const out = await page.evaluate(`(() => {
      const seen = new Set(), rows = [];
      for (const li of Array.from(document.querySelectorAll('ul li, div[role="button"] + div'))) {
        const a = li.querySelector('a[href^="/"]');
        if (!a) continue;
        const author = (a.getAttribute('href') || '').replace(/\\//g, '');
        if (!author || /^(explore|reels|direct|accounts|p)$/.test(author)) continue;
        const spans = Array.from(li.querySelectorAll('span')).map((s) => (s.textContent || '').trim()).filter((t) => t && t !== author && t.length > 1);
        const text = spans.sort((x, y) => y.length - x.length)[0] || '';
        if (!text || text.length < 2) continue;
        const key = author + '|' + text.slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ externalId: key, author, authorUrl: 'https://www.instagram.com/' + author + '/', text: text.slice(0, 800) });
      }
      const cap = document.querySelector('h1, article h1');
      return { rows: rows.slice(0, ${max}), caption: cap ? (cap.textContent || '').slice(0, 500) : null };
    })()`) as any;
    if (!out?.rows?.length) return { comments: [], caption: out?.caption ?? null, error: "لم أجد تعليقات — إما لا توجد أو تغيّر شكل الصفحة" };
    return { comments: out.rows, caption: out.caption ?? null };
  },

  async replyToComment(page, url, comment, reply) {
    if (!page.url().startsWith(url)) await go(page, url);
    const box = await first(page, ['textarea[aria-label*="comment" i]', 'textarea[placeholder*="comment" i]', 'textarea[aria-label*="تعليق"]', "form textarea"]);
    if (!box) return { ok: false, error: "لم أجد حقل التعليق — ربما تغيّر شكل إنستجرام أو التعليقات مغلقة" };
    await box.click();
    await human(400, 900);
    // Mentioning the author reaches them the way the thread reply does, and survives far more layout changes.
    await typeHuman(page, `@${comment.author} ${reply}`.slice(0, 2_200));
    await human(700, 1_600);
    if (!(await clickByText(page, /^(post|نشر)$/i))) await page.keyboard.press("Enter");
    await human(2_000, 3_500);
    const w = await wall(page);
    return w ? { ok: false, error: w } : { ok: true };
  },

  async readInbox(page, max) {
    await go(page, `${IG}/direct/inbox/`, [2_500, 4_500]);
    const rows = await page.evaluate(`(() => {
      const out = [];
      for (const el of Array.from(document.querySelectorAll('a[href^="/direct/t/"], div[role="listitem"]'))) {
        const texts = Array.from(el.querySelectorAll('span')).map((s) => (s.textContent || '').trim()).filter(Boolean);
        if (!texts.length) continue;
        const name = texts[0];
        if (!name || name.length > 60) continue;
        const a = el.matches('a') ? el : el.querySelector('a[href^="/direct/t/"]');
        out.push({ handle: name, name, preview: (texts.slice(1).find((t) => t.length > 2) || '').slice(0, 200),
          unread: !!el.querySelector('[aria-label*="Unread" i], [aria-label*="غير مقروء"]') || /·/.test(el.textContent || ''),
          threadUrl: a ? 'https://www.instagram.com' + a.getAttribute('href') : undefined });
      }
      return out.slice(0, ${max});
    })()`) as any;
    if (!rows?.length) return { threads: [], error: "لم أجد محادثات — إما الوارد فارغ أو تغيّر شكل الصفحة" };
    return { threads: rows };
  },

  async readThread(page, thread, max) {
    if (thread.threadUrl) await go(page, thread.threadUrl);
    else return { messages: [], error: "لا رابط للمحادثة" };
    return { messages: await bubbles(page, 'div[role="row"]', max), threadUrl: page.url() };
  },

  async sendDm(page, to, text, opts) {
    if (to.threadUrl) await go(page, to.threadUrl);
    else if (opts.fresh) {
      await go(page, to.profileUrl ?? `${IG}/${to.handle}/`);
      if (!(await clickByText(page, /^(message|مراسلة|إرسال رسالة|رسالة)$/i))) return { ok: false, unreachable: true, error: "لا زر مراسلة في الملف — الحساب لا يستقبل رسائل من غير متابعيه" };
      await human(2_500, 4_000);
    } else return { ok: false, error: "لا محادثة قائمة مع هذا الشخص" };
    const box = await first(page, ['div[contenteditable="true"][role="textbox"]', 'textarea[placeholder*="Message" i]', 'div[aria-label*="Message" i][contenteditable="true"]']);
    if (!box) return { ok: false, error: "لم أجد حقل الرسالة — ربما تغيّر شكل إنستجرام" };
    await box.click();
    await human(400, 900);
    await typeHuman(page, text.slice(0, 1_000));
    await human(800, 1_800);
    await page.keyboard.press("Enter");
    await human(1_500, 3_000);
    const w = await wall(page);
    return w ? { ok: false, error: w } : { ok: true, threadUrl: page.url().includes("/direct/t/") ? page.url() : undefined };
  },

  async search(page, query, max) {
    if (!page.url().startsWith(IG)) await go(page, `${IG}/`);
    // The search box's own data, read as the signed-in account reads it.
    const users = await page.evaluate(`(async () => {
      try {
        const r = await fetch('/web/search/topsearch/?context=blended&query=' + encodeURIComponent(${JSON.stringify(query)}), { credentials: 'include', headers: { 'x-ig-app-id': '936619743392459' } });
        const d = await r.json();
        return (d.users || []).map((u) => u.user).filter(Boolean).map((u) => ({ handle: u.username, name: u.full_name, headline: u.is_verified ? 'موثّق' : '' }));
      } catch (e) { return null; }
    })()`) as any[] | null;
    if (!users) return { people: [], error: "البحث لم يعمل — ربما تغيّر شكل إنستجرام" };
    return { people: users.slice(0, max).map((u) => ({ ...u, handle: String(u.handle).toLowerCase(), profileUrl: `${IG}/${u.handle}/` })) };
  },

  async publish() {
    return { ok: false, error: "إنستجرام لا يقبل منشوراً بلا صورة أو فيديو — المنشور جاهز كنص، انشره من هاتفك مع الصورة" };
  },

  async commentOn(page, postUrl, text) {
    await go(page, postUrl);
    const box = await first(page, ['textarea[aria-label*="comment" i]', 'textarea[placeholder*="comment" i]', 'textarea[aria-label*="تعليق"]', "form textarea"]);
    if (!box) return { ok: false, error: "لم أجد حقل التعليق" };
    await box.click();
    await human(400, 900);
    await typeHuman(page, text.slice(0, 2_000));
    await human(700, 1_500);
    if (!(await clickByText(page, /^(post|نشر)$/i))) await page.keyboard.press("Enter");
    await human(2_000, 3_500);
    return { ok: true };
  },
};

/**
 * The messages in an open conversation. Ours sit on the trailing side of the
 * column and theirs on the leading side — the one thing all three sites agree
 * on, and the only signal that survives a redesign.
 */
export async function bubbles(page: Page, rowSelector: string, max: number) {
  return (await page.evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll(${JSON.stringify(rowSelector)}));
    if (!rows.length) return [];
    const box = rows[0].parentElement.getBoundingClientRect();
    const mid = box.left + box.width / 2;
    // In a right-to-left interface the sides swap: ours are on the left.
    const rtl = getComputedStyle(document.documentElement).direction === 'rtl' || document.documentElement.dir === 'rtl';
    const out = [];
    for (const r of rows) {
      const text = (r.innerText || '').trim();
      if (!text || text.length > 2000) continue;
      const kids = Array.from(r.querySelectorAll('div, span')).filter((x) => (x.innerText || '').trim() === text);
      const el = kids[kids.length - 1] || r;
      const b = el.getBoundingClientRect();
      out.push({ fromMe: (b.left + b.width / 2 > mid) !== rtl, text });
    }
    return out.slice(-${max});
  })()`)) as Array<{ fromMe: boolean; text: string }>;
}
