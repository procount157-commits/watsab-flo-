// ── حملات واتساب التلقائية ───────────────────────────────────────
// صاحب العمل: «يعمل الحملات تلقائياً: يختار حملة، يجرّبها، يأخذ منها
// الدروس، ثم يوقف الأخرى — حسب القطاع، ومع حساب الحظر والحد اليومي».
//
// الدورة لكل حساب:
//   ١ · الهدف    بروكاونت: القطاع التالي بسياسة صاحب العمل (AML للعقارات
//                والذهب والمحامين، والمحاسبة والضرائب للمقاولات والمطاعم)
//                بنسبة ٨٠/٢٠. محل الذهب: قائمة زبائن لم تصلها حملة منذ شهر.
//   ٢ · الكتابة  نسختان بزاويتين مختلفتين فعلاً، من معرفة القطاع ودليل
//                مسؤول الشات وصورة من المعرض — وللمحل قطعةٌ ورابطها.
//   ٣ · الفحص    بفاحص الردود نفسه: لا تحبّب، ولا سعر ولا وزن في المحل،
//                ولا رقم مخترع، ولا خانة قالب.
//   ٤ · التجربة  كل نسخة على عيّنةٍ صغيرة (٢٠ افتراضاً). في وضع الموافقة
//                تنتظر صاحب العمل؛ في الآلي تخرج وحدها.
//   ٥ · الحكم    بعد ٤٨ ساعة: الردود المكتوبة، وضغطات «مهتم»، وضغطات
//                «إيقاف» تُخصم بثلاثة أضعاف. الدرس يُكتب للكاتب.
//   ٦ · الموجة   الفائزة لموجةٍ أكبر، والأخرى تتوقف.
//
// الإرسال نفسه حلقة الحملات العادية: الحد اليومي، وساعات الإرسال، وزر
// الإيقاف، والفواصل، وحماية الرقم من الحظر — كلها هناك. والطيار لا
// يجدول أكثر من حصته من حدّ اليوم، ولا يبدأ على رقمٍ عمره أقل من يومين.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  db, campaignsTable, contactGroupsTable, contactsTable, listFoldersTable, businessProfileTable,
  agentMemoryTable, mediaAssetsTable, waAutopilotTable, waAutopilotTestsTable,
  type WaVariant, type WaVariantResult, type WaAutopilotTest,
} from "@workspace/db";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { memoryPreamble } from "./agent-memory";
import { retrieve } from "./knowledge";
import { checkReply, blocksSend } from "./reply-check";
import { getDailyRemaining, numberAgeDays } from "./daily-limit";
import { AUTOPILOT_MARK, AUTOPILOT_FOLDER } from "./folders";
import { TARGETS, MIX } from "./email/policy";
import { pieceUrl, shopName } from "./catalog/floret";
import { logger } from "./logger";
import { parseLoose } from "./loose-json";

export const WRITER_ROLE = "wa_campaigns";
const JUDGE_AFTER_HOURS = 48;

/** What a WhatsApp message to each sector is about — general, true, with no number to invent. */
export const SECTOR_BRIEF: Record<string, { service: "aml" | "services"; brief: string }> = {
  "عقارات": { service: "aml", brief: "الوسطاء والوكالات العقارية مشمولون بمتطلبات مكافحة غسل الأموال: التسجيل في goAML، العناية الواجبة بالعملاء ومعرفة المستفيد الحقيقي، تقييم المخاطر، الإبلاغ عن المعاملات المشبوهة، وحفظ السجلات — والتفتيش يطلب ملفاً جاهزاً." },
  "ذهب ومجوهرات": { service: "aml", brief: "تجار الذهب والمعادن الثمينة مشمولون بمتطلبات مكافحة غسل الأموال، خصوصاً في التعاملات النقدية: العناية الواجبة بالعملاء، التسجيل في goAML، الإبلاغ، وحفظ السجلات." },
  "قانونية": { service: "aml", brief: "مكاتب المحاماة تدخل في متطلبات مكافحة غسل الأموال حين تنفّذ معاملات بعينها لعملائها (العقارات، إدارة الأموال، تأسيس الشركات): ملف العميل، العناية الواجبة، والإبلاغ." },
  "مقاولات": { service: "services", brief: "شركات المقاولات تحتاج تكلفة كل مشروع وربحيته بوضوح، ومتابعة المستخلصات والدفعات، وضريبة القيمة المضافة على العقود، وإقرار ضريبة الشركات — وحسابات منظمة تكشف أي مشروع يربح وأيّها يخسر." },
  "مطاعم ومقاهي": { service: "services", brief: "المطاعم تحتاج معرفة تكلفة الطعام الحقيقية، والمخزون والهدر، وربحية كل فرع، وضريبة القيمة المضافة وإقرار ضريبة الشركات — حسابات تقول أين يضيع الربح." },
};

export async function getConfig(userId: number) {
  const [r] = await db.select().from(waAutopilotTable).where(eq(waAutopilotTable.userId, userId)).limit(1);
  return r ?? { userId, enabled: false, mode: "approve", testSize: 20, waveSize: 150, dailyShare: 60, updatedAt: new Date() };
}

export async function saveConfig(userId: number, b: any) {
  const cur = await getConfig(userId);
  const int = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const v = {
    userId,
    enabled: typeof b.enabled === "boolean" ? b.enabled : cur.enabled,
    mode: b.mode === "auto" || b.mode === "approve" ? b.mode : cur.mode,
    testSize: int(b.testSize ?? cur.testSize, 10, 100, cur.testSize),
    waveSize: int(b.waveSize ?? cur.waveSize, 30, 1000, cur.waveSize),
    dailyShare: int(b.dailyShare ?? cur.dailyShare, 10, 90, cur.dailyShare),
    updatedAt: new Date(),
  };
  await db.insert(waAutopilotTable).values(v).onConflictDoUpdate({ target: waAutopilotTable.userId, set: v });
  return v;
}

// ── The audience: never sent a campaign, not stopped, active ───────
const notAutopilot = sql`coalesce(g.description, '') NOT LIKE ${AUTOPILOT_MARK + "%"}`;
const freshPhone = (userId: number, sinceDays: number | null) => sql`
  NOT EXISTS (SELECT 1 FROM message_logs ml JOIN campaigns c2 ON c2.id = ml.campaign_id
              WHERE c2.user_id = ${userId} AND ml.phone = c.phone AND ml.status = 'sent'
              ${sinceDays == null ? sql`` : sql`AND ml.sent_at > now() - make_interval(days => ${sinceDays})`})
  AND NOT EXISTS (SELECT 1 FROM unsubscribed_phones u WHERE u.user_id = ${userId} AND u.phone = c.phone AND (u.expires_at IS NULL OR u.expires_at > now()))`;

/** Fresh contacts of a sector (a company's) or of a folder of lists (a shop's customers). */
export async function audience(userId: number, kind: "sector" | "list", target: string, n: number, exclude: string[] = []) {
  const where = kind === "sector"
    ? sql`c.sector = ${target}`
    : sql`g.folder_id IN (SELECT id FROM list_folders WHERE user_id = ${userId} AND kind = 'wa' AND name = ${target})`;
  const ex = exclude.length ? sql`AND c.phone NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(exclude)}::jsonb))` : sql``;
  const r = await db.execute<{ phone: string; name: string | null; sector: string | null }>(sql`
    SELECT DISTINCT ON (c.phone) c.phone, c.name, c.sector FROM contacts c JOIN contact_groups g ON g.id = c.group_id
    WHERE g.user_id = ${userId} AND c.status = 'active' AND ${notAutopilot} AND ${where}
      AND ${freshPhone(userId, kind === "list" ? 30 : null)} ${ex}
    ORDER BY c.phone, c.id LIMIT ${n * 3}`);
  // Shuffled, so a test is not always the first companies in the file.
  return r.rows.sort(() => Math.random() - 0.5).slice(0, n);
}

// ── The target ────────────────────────────────────────────────────
/** The next sector by the owner's 80/20 — the track behind its share first, then the least-tested sector. Pure over counts. */
export function nextSector(counts: { aml: number; services: number }, lastTested: Record<string, number>, available: Record<string, number>, need: number): { sector: string; service: "aml" | "services" } | null {
  const total = counts.aml + counts.services;
  const amlShare = total ? counts.aml / total : 0;
  const order: Array<"aml" | "services"> = amlShare < MIX.aml ? ["aml", "services"] : ["services", "aml"];
  for (const track of order) {
    const sectors = TARGETS[track].filter((s) => SECTOR_BRIEF[s] && (available[s] ?? 0) >= need)
      .sort((a, b) => (lastTested[a] ?? 0) - (lastTested[b] ?? 0));
    if (sectors.length) return { sector: sectors[0]!, service: track };
  }
  return null;
}

async function pickTarget(userId: number, vertical: string, need: number): Promise<{ kind: "sector" | "list"; target: string; service: string } | null> {
  const open = new Set((await db.select({ t: waAutopilotTestsTable.target }).from(waAutopilotTestsTable)
    .where(and(eq(waAutopilotTestsTable.userId, userId), inArray(waAutopilotTestsTable.status, ["awaiting_approval", "testing", "scaling"])))).map((r) => r.t));
  if (vertical === "jewelry") {
    for (const folder of ["عملاء الإعلانات", "مستخرج من واتساب"]) {
      if (open.has(folder)) continue;
      if ((await audience(userId, "list", folder, need)).length >= need) return { kind: "list", target: folder, service: "shop" };
    }
    return null;
  }
  const tests = await db.execute<{ target: string; service: string; at: string }>(sql`
    SELECT target, service, max(created_at) AS at FROM wa_autopilot_tests WHERE user_id = ${userId} AND created_at > now() - interval '30 days' GROUP BY 1, 2`);
  const counts = { aml: 0, services: 0 };
  const last: Record<string, number> = {};
  for (const t of tests.rows) { if (t.service === "aml" || t.service === "services") counts[t.service]++; last[t.target] = new Date(t.at).getTime(); }
  const avail: Record<string, number> = {};
  for (const s of Object.keys(SECTOR_BRIEF)) if (!open.has(s)) avail[s] = (await audience(userId, "sector", s, need)).length;
  const pick = nextSector(counts, last, avail, need);
  return pick ? { kind: "sector", target: pick.sector, service: pick.service } : null;
}

// ── The writing ───────────────────────────────────────────────────
export function writerPrompt(i: { vertical: string; firm: string; description: string; target: string; service: string; brief: string; memory: string; facts: string; images: string; piece: string | null }): string {
  const shop = i.vertical === "jewelry";
  return [
    `أنت كاتب حملات واتساب لدى ${i.firm}${i.description ? ` — ${i.description}` : ""}.`,
    `تكتب رسالة حملة لـ${shop ? `زبائن قائمة «${i.target}»` : `شركات قطاع «${i.target}»`} — ${shop ? "قطعة من المحل" : i.service === "aml" ? "خدمة الامتثال لمكافحة غسل الأموال (AML)" : "خدمات المحاسبة والضرائب"}.`,
    i.brief ? `ما يهمّ هذا القطاع: ${i.brief}` : "",
    "",
    "اكتب نسختين مختلفتين فعلاً في الزاوية — لا في الصياغة — لنجرّبهما على عيّنتين ونعرف أيّهما يُقنع:",
    shop ? "مثلاً: زاوية المناسبة (عرس، عيد، هدية) مقابل زاوية القطعة نفسها وتصميمها." : "مثلاً: زاوية الخطر الذي يواجهه (تفتيش، غرامة، ضياع الربح) مقابل زاوية السهولة والراحة (نتولّى عنك).",
    "",
    "قواعد الرسالة:",
    "- واتساب لا بريد: من ٣ إلى ٥ أسطر قصيرة، تبدأ بشيء يخصّه هو لا بنا، وتنتهي بدعوة واحدة سهلة (رد بكلمة، أو اضغط «مهتم»).",
    "- بالعربية، محترمة دائماً. ممنوع منعاً باتاً أي كلمة تحبّب أو تدليل: حبيبتي، حبيبي، صاحبتي، صديقتي، قلبي، عيوني، يا قمر.",
    "- لا عبارات القوالب: عزيزي العميل، يسعدنا، لا تتردد، نحن هنا لخدمتك.",
    shop
      ? `- محل ذهب: ممنوع أي سعر أو وزن أو سعر ذهب أو مصنعية أو خصم. ضع رابط القطعة كما هو: ${i.piece ?? "رابط المتجر https://floret-royal.io"}.`
      : "- لا رقم ولا غرامة ولا نسبة ولا مدة لا توجد في المعلومات أدناه. اذكر اسم الشركة «برو كاونت للمحاسبة» مرة واحدة.",
    "- لا تكتب أي خانة قالب مثل [الاسم] أو {company}.",
    "",
    i.memory ? `ما تعلّمه الفريق:\n${i.memory}` : "",
    i.facts ? `المعلومات (اكتب منها فقط):\n${i.facts}` : "",
    i.images ? `صور المعرض المتاحة (اختر لكل نسخة صورة تناسبها برقمها، أو null):\n${i.images}` : "",
    "",
    "أعد JSON فقط:",
    `{"variants":[{"angle":"اسم الزاوية","message":"نص الرسالة","imageId":null},{"angle":"...","message":"...","imageId":null}]}`,
  ].filter(Boolean).join("\n");
}

/** A variant the checker would stop. Pure over the check. */
export function variantIssues(message: string, shop: boolean, facts: string): string[] {
  const r = checkReply(message, { customer: "", facts, strictNumbers: true, warm: shop, noPrices: shop, discountAllowed: false });
  const issues = blocksSend(r) ? r.issues.filter((i) => ["placeholder", "endearment", "price-weight", "discount", "invented-strict", "reveal"].includes(i.code)).map((i) => i.note) : [];
  if (message.length > 900) issues.push("طويلة على واتساب");
  return issues;
}

async function write(userId: number, vertical: string, target: string, service: string): Promise<{ variants: WaVariant[]; why?: string }> {
  const [p] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const shop = vertical === "jewelry";
  const memory = await memoryPreamble(userId, WRITER_ROLE).catch(() => "");
  const found = await retrieve(userId, shop ? "أطقم ذهب مناسبات" : `${target} ${service === "aml" ? "غسل الأموال AML" : "محاسبة ضرائب"}`, 5).catch(() => []);
  const facts = found.map((f) => `${f.entry.title}: ${f.entry.content.slice(0, 500)}`).join("\n");
  // A shop's campaign is a piece: the least recently campaigned one in stock, with its page.
  let piece: string | null = null, pieceName: string | null = null;
  if (shop) {
    const [x] = (await db.execute<{ name: string; slug: string }>(sql`
      SELECT name, slug FROM catalog_items ci WHERE user_id = ${userId} AND published AND in_stock AND slug IS NOT NULL
      ORDER BY (SELECT max(created_at) FROM wa_autopilot_tests t WHERE t.user_id = ${userId} AND t.variants::text LIKE '%' || ci.slug || '%') NULLS FIRST, random() LIMIT 1`)).rows;
    if (x) { piece = pieceUrl(x.slug); pieceName = shopName(x.name); }
  }
  const imgs = await db.select({ id: mediaAssetsTable.id, url: mediaAssetsTable.url, caption: mediaAssetsTable.caption, tags: mediaAssetsTable.tags })
    .from(mediaAssetsTable).where(eq(mediaAssetsTable.userId, userId)).orderBy(desc(mediaAssetsTable.createdAt)).limit(40);
  const images = imgs.map((m) => `${m.id}: ${m.caption ?? ""}${m.tags.length ? ` [${m.tags.join("، ")}]` : ""}`).join("\n");
  const prompt = writerPrompt({ vertical, firm: p?.name ?? "الشركة", description: p?.description ?? "", target: pieceName ? `${target} — ${pieceName}` : target, service, brief: SECTOR_BRIEF[target]?.brief ?? "", memory, facts, images, piece });

  let lastWhy = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await asAgent(userId, WRITER_ROLE, () => complete([
      { role: "system", content: prompt },
      { role: "user", content: attempt ? `النسختان السابقتان رُفضتا: ${lastWhy}. اكتبهما من جديد.` : "اكتب النسختين." },
    ], 90_000)).catch(() => null);
    if (!out?.text) { lastWhy = "النموذج لم يستجب"; continue; }
    const raw: any = parseLoose(out.text);
    if (!raw) { lastWhy = "ليس JSON"; continue; }
    const vs: WaVariant[] = (raw?.variants ?? []).slice(0, 2).map((v: any, i: number) => {
      const img = imgs.find((m) => m.id === Number(v?.imageId));
      let message = String(v?.message ?? "").trim();
      if (shop && piece && !message.includes(piece)) message = `${message}\n${piece}`;
      return { key: i ? "B" : "A", angle: String(v?.angle ?? "").slice(0, 80), message, mediaUrl: img?.url ?? null, link: piece };
    });
    if (vs.length < 2 || vs.some((v) => v.message.length < 20)) { lastWhy = "نسختان ناقصتان"; continue; }
    const problems = vs.flatMap((v) => variantIssues(v.message, shop, facts).map((x) => `${v.key}: ${x}`));
    if (problems.length) { lastWhy = problems.join(" · "); continue; }
    return { variants: vs };
  }
  return { variants: [], why: lastWhy };
}

// ── Lists and campaigns ───────────────────────────────────────────
async function autopilotFolder(userId: number): Promise<number> {
  const [f] = await db.select().from(listFoldersTable).where(and(eq(listFoldersTable.userId, userId), eq(listFoldersTable.kind, "wa"), eq(listFoldersTable.name, AUTOPILOT_FOLDER))).limit(1);
  if (f) return f.id;
  const [n] = await db.insert(listFoldersTable).values({ userId, kind: "wa", name: AUTOPILOT_FOLDER }).returning();
  return n!.id;
}

async function makeList(userId: number, name: string, why: string, people: Array<{ phone: string; name: string | null; sector: string | null }>): Promise<number> {
  const folderId = await autopilotFolder(userId);
  const [g] = await db.insert(contactGroupsTable).values({ userId, name: name.slice(0, 240), description: `${AUTOPILOT_MARK} ${why}`.slice(0, 500), folderId } as any).returning();
  for (let i = 0; i < people.length; i += 500) {
    await db.insert(contactsTable).values(people.slice(i, i + 500).map((p) => ({ groupId: g!.id, phone: p.phone, name: p.name, sector: p.sector, status: "active" })) as any);
  }
  return g!.id;
}

async function startCampaign(userId: number, name: string, v: WaVariant, listId: number, size: number, shop: boolean): Promise<number> {
  const [c] = await db.insert(campaignsTable).values({
    userId, name: name.slice(0, 250), status: "running", contactGroupId: listId, message: v.message,
    messageType: v.mediaUrl ? "image" : "text", mediaUrl: v.mediaUrl ?? null,
    // «مهتم» is what the judge counts besides a written reply; the stop button is added by the send loop.
    buttons: JSON.stringify([{ text: shop ? "مهتمة" : "مهتم", type: "interested" }]),
    pacingMode: "auto", totalCount: size,
  } as any).returning();
  return c!.id;
}

async function resume(userId: number) {
  const { resumeRunningCampaigns } = await import("../routes/campaigns");
  await resumeRunningCampaigns(userId).catch((err) => logger.warn({ userId, err: String(err?.message ?? err) }, "استئناف حملات الطيار تعذّر"));
}

/** Starts a test that was written (and, in approval mode, approved). */
export async function launchTest(t: WaAutopilotTest): Promise<void> {
  const shop = t.service === "shop";
  const variants: WaVariant[] = [];
  for (const v of t.variants) {
    const size = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contacts WHERE group_id = ${v.listId}`);
    const id = await startCampaign(t.userId, `تلقائي — ${t.target} — ${v.key} — ${v.angle ?? ""}`, v, v.listId!, Number((size.rows[0] as any)?.n ?? 0), shop);
    variants.push({ ...v, campaignId: id });
  }
  await db.update(waAutopilotTestsTable).set({ status: "testing", variants, startedAt: new Date() }).where(eq(waAutopilotTestsTable.id, t.id));
  await resume(t.userId);
}

// ── Judging ───────────────────────────────────────────────────────
/** The winner: replies and «interested» count, a stop costs three. None when neither moved anyone. Pure. */
export function judge(results: WaVariantResult[]): { winner: string | null; why: string } {
  const scored = results.map((r) => ({ ...r, score: r.replied + 2 * r.interested - 3 * r.stopped }));
  const best = [...scored].sort((a, b) => b.score - a.score || b.replied - a.replied);
  const [a, b] = best;
  if (!a || a.score <= 0) return { winner: null, why: "لم تحرّك أيٌّ من النسختين أحداً — زاويتان جديدتان في التجربة القادمة" };
  if (b && a.score === b.score && a.replied === b.replied) return { winner: a.key, why: `تعادل (${a.score} لكلٍّ منهما) — تُرسل «${a.key}» وتُعاد التجربة لاحقاً` };
  return { winner: a.key, why: `«${a.key}» فازت: ${a.replied} رداً و${a.interested} مهتماً و${a.stopped} إيقافاً من ${a.sent}، مقابل ${b ? `${b.replied} و${b.interested} و${b.stopped} من ${b.sent}` : "—"}` };
}

async function results(t: WaAutopilotTest): Promise<WaVariantResult[]> {
  const out: WaVariantResult[] = [];
  for (const v of t.variants) {
    if (!v.campaignId) continue;
    const r = (await db.execute<{ sent: number; replied: number; interested: number; stopped: number }>(sql`
      SELECT count(DISTINCT ml.phone)::int AS sent,
        count(DISTINCT ml.phone) FILTER (WHERE EXISTS (SELECT 1 FROM incoming_messages im WHERE im.user_id = ${t.userId} AND split_part(im.phone, ':', 1) = ml.phone AND im.received_at > ml.sent_at))::int AS replied,
        (SELECT count(DISTINCT phone) FROM campaign_button_responses r WHERE r.campaign_id = ${v.campaignId} AND r.action = 'interested')::int AS interested,
        (SELECT count(DISTINCT phone) FROM campaign_button_responses r WHERE r.campaign_id = ${v.campaignId} AND r.action = 'stop')::int AS stopped
      FROM message_logs ml WHERE ml.campaign_id = ${v.campaignId} AND ml.status = 'sent'`)).rows[0] as any;
    out.push({ key: v.key, sent: Number(r?.sent ?? 0), replied: Number(r?.replied ?? 0), interested: Number(r?.interested ?? 0), stopped: Number(r?.stopped ?? 0), score: 0 });
  }
  return out;
}

async function judgeTest(t: WaAutopilotTest, cfg: Awaited<ReturnType<typeof getConfig>>): Promise<void> {
  const ids = t.variants.map((v) => v.campaignId!).filter(Boolean);
  const camps = await db.select({ id: campaignsTable.id, status: campaignsTable.status }).from(campaignsTable).where(inArray(campaignsTable.id, ids));
  // A half stopped by the day's limit is set going again the next day; the judge waits for both.
  for (const c of camps) if (c.status === "paused") await db.update(campaignsTable).set({ status: "running" }).where(eq(campaignsTable.id, c.id));
  if (camps.some((c) => c.status !== "completed")) { if (camps.some((c) => c.status === "paused")) await resume(t.userId); return; }
  const lastSend = (await db.execute<{ at: string | null }>(sql`SELECT max(sent_at) AS at FROM message_logs WHERE campaign_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::int)`)).rows[0]?.at;
  if (lastSend && Date.now() - new Date(lastSend).getTime() < JUDGE_AFTER_HOURS * 3_600_000) return;

  const res = await results(t);
  const verdict = judge(res);
  const win = t.variants.find((v) => v.key === verdict.winner);
  const lose = t.variants.filter((v) => v.key !== verdict.winner);
  // The lesson, for the writer's next campaign.
  if (win) await db.insert(agentMemoryTable).values({ userId: t.userId, role: WRITER_ROLE, kind: "win", topic: t.target, content: `${t.target}: زاوية «${win.angle}» فازت في تجربة واتساب — ${verdict.why}. نصها: «${win.message.slice(0, 220)}»` });
  for (const l of lose) await db.insert(agentMemoryTable).values({ userId: t.userId, role: WRITER_ROLE, kind: "loss", topic: t.target, content: `${t.target}: زاوية «${l.angle}» خسرت في تجربة واتساب — ${verdict.why}.` });

  if (!win) {
    await db.update(waAutopilotTestsTable).set({ status: "no_winner", results: res, insight: verdict.why, judgedAt: new Date() }).where(eq(waAutopilotTestsTable.id, t.id));
    return;
  }
  // The winner's wave: fresh people of the same target, within the autopilot's share of today.
  const remaining = Math.floor((await getDailyRemaining(t.userId)) * cfg.dailyShare / 100);
  const size = Math.min(cfg.waveSize, Math.max(0, remaining));
  const tested = (await db.execute<{ phone: string }>(sql`SELECT phone FROM contacts WHERE group_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(t.variants.map((v) => v.listId))}::jsonb)::int)`)).rows.map((r) => r.phone);
  const people = size >= 10 ? await audience(t.userId, t.targetKind as "sector" | "list", t.target, size, tested) : [];
  let waveCampaignId: number | null = null;
  if (people.length >= 10) {
    const listId = await makeList(t.userId, `تلقائي — ${t.target} — موجة الفائزة ${win.key}`, `موجة الفائزة «${win.angle}» لـ${t.target}`, people);
    waveCampaignId = await startCampaign(t.userId, `تلقائي — ${t.target} — موجة ${win.key} — ${win.angle ?? ""}`, win, listId, people.length, t.service === "shop");
    await resume(t.userId);
  }
  await db.update(waAutopilotTestsTable).set({
    status: waveCampaignId ? "scaling" : "done", results: res, winner: win.key, judgedAt: new Date(), waveCampaignId,
    insight: `${verdict.why}${waveCampaignId ? ` — الفائزة تُرسل الآن لـ${people.length}` : " — لا حصة اليوم للموجة؛ تُرسل في التجربة القادمة"}`,
  }).where(eq(waAutopilotTestsTable.id, t.id));
}

// ── The cycle ─────────────────────────────────────────────────────
export async function runCycle(userId: number): Promise<{ created?: number; judged: number; why?: string }> {
  const cfg = await getConfig(userId);
  if (!cfg.enabled) return { judged: 0, why: "الطيار مطفأ" };
  let judged = 0;
  for (const t of await db.select().from(waAutopilotTestsTable).where(and(eq(waAutopilotTestsTable.userId, userId), eq(waAutopilotTestsTable.status, "testing")))) {
    await judgeTest(t, cfg).catch((err) => logger.warn({ testId: t.id, err: String(err?.message ?? err) }, "حكم تجربة الطيار تعذّر")); judged++;
  }
  for (const t of await db.select().from(waAutopilotTestsTable).where(and(eq(waAutopilotTestsTable.userId, userId), eq(waAutopilotTestsTable.status, "scaling")))) {
    const [c] = await db.select({ status: campaignsTable.status }).from(campaignsTable).where(eq(campaignsTable.id, t.waveCampaignId!)).limit(1);
    if (!c || c.status === "completed") await db.update(waAutopilotTestsTable).set({ status: "done" }).where(eq(waAutopilotTestsTable.id, t.id));
    else if (c.status === "paused") { await db.update(campaignsTable).set({ status: "running" }).where(eq(campaignsTable.id, t.waveCampaignId!)); await resume(userId); }
  }

  // One new test at a time, and only with room in today's allowance on a number old enough.
  const [open] = await db.select({ id: waAutopilotTestsTable.id }).from(waAutopilotTestsTable)
    .where(and(eq(waAutopilotTestsTable.userId, userId), inArray(waAutopilotTestsTable.status, ["awaiting_approval", "testing"]))).limit(1);
  if (open) return { judged, why: "تجربة جارية" };
  if ((await numberAgeDays(userId).catch(() => 0)) < 2) return { judged, why: "الرقم أحدث من يومين" };
  const room = Math.floor((await getDailyRemaining(userId)) * cfg.dailyShare / 100);
  if (room < cfg.testSize * 2) return { judged, why: `لا حصة كافية اليوم (${room})` };

  const [p] = await db.select({ vertical: businessProfileTable.vertical }).from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const vertical = p?.vertical === "jewelry" ? "jewelry" : "accounting";
  const target = await pickTarget(userId, vertical, cfg.testSize * 2);
  if (!target) return { judged, why: "لا جمهور جديد كافٍ في القطاعات المستهدفة" };
  const w = await write(userId, vertical, target.target, target.service);
  if (!w.variants.length) return { judged, why: `تعذّرت الكتابة: ${w.why}` };

  const people = await audience(userId, target.kind, target.target, cfg.testSize * 2);
  const half = Math.floor(people.length / 2);
  const variants: WaVariant[] = [];
  for (const [i, v] of w.variants.entries()) {
    const slice = people.slice(i * half, (i + 1) * half);
    variants.push({ ...v, listId: await makeList(userId, `تلقائي — ${target.target} — تجربة ${v.key}`, `تجربة ${v.key} «${v.angle}» لـ${target.target}`, slice) });
  }
  const [t] = await db.insert(waAutopilotTestsTable).values({ userId, status: "awaiting_approval", targetKind: target.kind, target: target.target, service: target.service, variants }).returning();
  if (cfg.mode === "auto") await launchTest(t!);
  logger.info({ userId, target: target.target, mode: cfg.mode }, "الطيار كتب تجربة واتساب");
  return { created: t!.id, judged };
}

let timer: NodeJS.Timeout | null = null;
/** Every half hour for every account that turned it on. */
export function startWaAutopilot(): void {
  if (timer) return;
  const run = async () => {
    const rows = await db.select({ userId: waAutopilotTable.userId }).from(waAutopilotTable).where(eq(waAutopilotTable.enabled, true)).catch(() => []);
    for (const r of rows) await runCycle(r.userId).catch((err) => logger.warn({ userId: r.userId, err: String(err?.message ?? err) }, "دورة طيار واتساب تعذّرت"));
  };
  setTimeout(() => void run(), 3 * 60_000).unref();
  timer = setInterval(() => void run(), 30 * 60_000);
  timer.unref();
}
