// ── نورة for a shop ───────────────────────────────────────────────
// Her campaign was written for an accounting firm mailing companies: «Hello
// {{first_name}}», the recipient's company in the first line, «The Pro Count
// team» at the bottom. A gold shop mailing its customers got the same — an
// email to a company, signed by someone else. A shop's campaign is a short
// Arabic note to a person, the shop's own name under it, and the pieces
// themselves: their photos and their pages on the site. Never a price, a
// weight or an endearment (the owner's rules for every channel).

import { sql } from "drizzle-orm";
import { db, type SegmentFilter } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { logger } from "../logger";
import { STORE_URL, pieceUrl } from "../catalog/floret";
import { count, describe } from "./segments";
import { parseDraft, type EmailDraft } from "./agent";
import { teamVoice, type EmailRole } from "./team";

export type ShopPiece = { name: string; tagline: string | null; url: string; image: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const BANNED = /(حبيبتي|حبيبي|صاحبتي|قلبي|يا عمري|هلا وغلا|درهم|AED|د\.إ|جرام|غرام|سعر|خصم|عرض لفترة)/;

/** The pieces to show: those the goal names first, then the newest in stock, each with a photo. */
export async function piecesFor(userId: number, goal: string, limit = 3): Promise<ShopPiece[]> {
  const words = goal.split(/[\s،,.]+/).filter((w) => w.length > 2).slice(0, 8);
  const like = words.length ? sql.join(words.map((w) => sql`(name ILIKE ${"%" + w + "%"} OR coalesce(tagline,'') ILIKE ${"%" + w + "%"})::int`), sql` + `) : sql`0`;
  const r = await db.execute<{ name: string; tagline: string | null; slug: string | null; img: string | null }>(sql`
    SELECT name, tagline, slug, coalesce((SELECT x->>'src' FROM jsonb_array_elements(doc->'images') x WHERE x->>'role' = 'hero' LIMIT 1), doc->'images'->0->>'src') AS img
    FROM catalog_items WHERE user_id = ${userId} AND in_stock AND published AND slug IS NOT NULL AND doc->'images' IS NOT NULL
    ORDER BY (${like}) DESC, synced_at DESC, sku DESC LIMIT ${limit}`);
  return r.rows.filter((x) => x.img && x.slug).map((x) => ({
    name: x.name, tagline: x.tagline, url: pieceUrl(x.slug!),
    image: /^https?:/.test(x.img!) ? x.img! : `${STORE_URL}${x.img!.startsWith("/") ? "" : "/"}${x.img}`,
  }));
}

/** The pieces as email HTML: photo, name, one line, a link — in table cells so Outlook keeps them side by side. Pure. */
export function piecesHtml(pieces: ShopPiece[], cta = "شاهدي القطعة"): string {
  if (!pieces.length) return "";
  const w = Math.floor(100 / pieces.length);
  const cells = pieces.map((p) => `<td valign="top" width="${w}%" style="padding:6px;text-align:center">` +
    `<a href="${esc(p.url)}" style="text-decoration:none;color:inherit"><img src="${esc(p.image)}" alt="${esc(p.name)}" width="170" style="display:block;width:100%;max-width:170px;height:auto;margin:0 auto;border-radius:10px;border:0"></a>` +
    `<p style="margin:8px 0 2px;font-weight:700;font-size:14px">${esc(p.name)}</p>` +
    (p.tagline ? `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;opacity:.75">${esc(p.tagline)}</p>` : "") +
    `<a href="${esc(p.url)}" style="font-size:13px;font-weight:600">${esc(cta)}</a></td>`).join("");
  return `<table role="presentation" class="pieces" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0"><tr>${cells}</tr></table>`;
}

/** What a shop's draft must not say. Pure. */
export function shopIssues(text: string): string[] {
  const out: string[] = [];
  const m = BANNED.exec(text);
  if (m) out.push(`كلمة ممنوعة: «${m[1]}»`);
  if (/[A-Za-z]{4,}/.test(text.replace(/\{\{[^}]+\}\}|https?:\/\/\S+|FLORET/gi, ""))) out.push("إنجليزي داخل رسالة عربية");
  return out;
}

export async function writeShopCampaign(userId: number, input: { filter: SegmentFilter; goal: string; notes?: string | null; role?: EmailRole }, shop: { name: string | null; site: string }): Promise<{ draft: EmailDraft; audience: { description: string; count: number; sample: string[] }; provider: string } | null> {
  const head = await teamVoice(userId, input.role ?? "email");
  const [n, pieces] = await Promise.all([count(userId, input.filter, true), piecesFor(userId, input.goal)]);
  const audience = { description: describe(input.filter), count: n, sample: [] as string[] };
  const name = shop.name ?? "المحل";
  const prompt = [
    head, "",
    `تكتبين إيميلاً تسويقياً من ${name} إلى زبائن أفراد (أغلبهم نساء في الإمارات)، لا إلى شركات.`,
    "بالعربية الخليجية البسيطة، دافئة ومهذّبة، كأن موظفة المعرض تكتب لزبونة تعرفها. لا إنجليزي إطلاقاً.",
    "ممنوع منعاً باتاً: أي سعر أو وزن أو جرام أو خصم أو عرض؛ وعبارات التحبّب (حبيبتي، قلبي، صاحبتي)؛ و«هلا وغلا».",
    "لا تخترعي قطعاً أو مواصفات. القطع التي ستظهر بصورها تحت الرسالة هي:",
    ...pieces.map((p) => `- ${p.name}${p.tagline ? `: ${p.tagline}` : ""}`),
    "", "اكتبي بهذا الشكل بالضبط ولا شيء خارجه:",
    "[عنوان] <عنوان قصير يثير الفضول، 3–7 كلمات، بلا علامات تعجب متكررة>",
    "[عنوان] <عنوان ثانٍ بزاوية مختلفة تماماً>",
    "[الرسالة]",
    "[معاينة] <6–10 كلمات تكمل العنوان>",
    "[عنوان كبير] <4–8 كلمات عن القطع أو المناسبة>",
    "مساء الخير،",
    "",
    "[ملخص] <سطران: ما الجديد ولماذا يستحق نظرة الآن — مناسبة، هدية، إطلالة>",
    "",
    "[زر] تصفّحي التشكيلة",
    "",
    "<سطر واحد يدعوها إن أعجبتها قطعة أن ترد على الإيميل أو تراسلنا على واتساب>",
    "",
    `مع التحية،`,
    name,
    "[/الرسالة]",
    "[متابعة بعد=72 جمهور=دافئ]",
    "عنوان: <لمن فتحت ولم ترد: زاوية جديدة — مناسبة أو طريقة لبس القطعة>",
    "<سطران ثم [زر] تصفّحي التشكيلة — 50 كلمة على الأكثر، وتوقيع باسم المحل>",
    "[/متابعة]",
    "[متابعة بعد=96 جمهور=بارد]",
    "عنوان: <لمن لم تفتح: عنوان مختلف تماماً وأقصر>",
    "<نفس الدعوة أقصر، ثم [زر] تصفّحي التشكيلة، وتوقيع باسم المحل>",
    "[/متابعة]",
    "[السبب] <سطر: لماذا هذه الزاوية>",
  ].join("\n");
  const ask = (extra = "") => asAgent(userId, input.role ?? "email", () => complete([
    { role: "system", content: prompt + extra },
    { role: "user", content: [`الهدف: ${input.goal}`, `الجمهور: ${audience.description} — ${n} شخصاً.`, input.notes ? `ملاحظات صاحب المحل: ${input.notes}` : ""].filter(Boolean).join("\n") },
  ], 90_000));

  let out = await ask();
  let issues = out?.text ? shopIssues(out.text) : [];
  // One rewrite with what was wrong said plainly; a second miss is not sent anywhere.
  if (out?.text && issues.length) { out = await ask(`\n\nمسودتك السابقة رُفضت: ${issues.join("؛ ")}. أعيدي الكتابة بلا ذلك.`); issues = out?.text ? shopIssues(out.text) : issues; }
  if (!out?.text || issues.length) { logger.warn({ userId, issues }, "مسودة المتجر لم تُقبل"); return null; }
  const draft = parseDraft(out.text);
  if (!draft) { logger.warn({ userId, sample: out.text.slice(0, 300) }, "مسودة المتجر لم تُقرأ"); return null; }

  // The button opens the shop; the pieces sit right under it, each to its own page.
  const site = /^https?:/.test(shop.site) ? shop.site : `https://${shop.site}`;
  const fill = (html: string) => html.replace(/<a href="#cta">([^<]+)<\/a>/g, (_m, label: string) => `<a href="${esc(site)}">${label}</a>`);
  draft.html = fill(draft.html).replace(/(<p class="cta">[\s\S]*?<\/p>)/, `$1${piecesHtml(pieces)}`);
  if (!/class="pieces"/.test(draft.html)) draft.html += piecesHtml(pieces);
  for (const f of draft.followups) f.html = fill(f.html);
  return { draft, audience, provider: out.provider };
}
