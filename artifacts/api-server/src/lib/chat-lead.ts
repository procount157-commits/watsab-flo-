// ── مسؤول الشات: يقرأ كل المحادثات، ويعلّم الفريق ─────────────────
// صاحب العمل: «أريد موظفاً مسؤولاً عن الشات: يقرأ كل الرسائل ويتعلّم
// منها ويفهم الردود، ويكون فريقاً مع الذي يكتب الحملات». كان المدرّب
// (coach) يتعلّم من نجاح كل موظف وفشله حين يُطلب منه، ولا أحد يقرأ
// المحادثات نفسها ليقول: هذا ما يسأله الناس، وهذا ما يقنعهم، وهذا ما
// يُغلق الباب.
//
// كل يوم، لكل حساب له محادثات: يقرأ محادثات الأسبوع وسجلّ الردود (أيّ ردٍّ
// جعل العميل يكمل وأيّها أسكته)، ويكتب «دليل الشات»: الأسئلة المتكررة
// وكيف تُجاب، الاعتراضات، ما ينجح، ما يُتجنَّب، وأفكار حملات من كلام الناس
// أنفسهم. يصل الدليل إلى موظفة الردود والمتابعة وكاتب الحملات في ذاكرتهم،
// ويُستبدل كل يوم فلا يتراكم.
//
// وقواعد الحساب فوق ما يتعلّمه: سطرٌ فيه كلمة تحبّب، أو — في محل الذهب —
// سعرٌ أو وزن، يُحذف قبل أن يصل لأحد.

import { and, eq, sql, inArray } from "drizzle-orm";
import { db, agentMemoryTable, botEmployeesTable, businessProfileTable } from "@workspace/db";
import { complete } from "./llm";
import { asAgent } from "./agent-context";
import { logger } from "./logger";
import { parseLoose } from "./loose-json";
import { ENDEARMENT } from "./voice-doctrine";
import { priceOrWeight } from "./reply-check";
import { normalizeArabic } from "./intent";

export const CHAT_LEAD_ROLE = "chat_lead";
/** Who reads the handbook: the reply desk, the follow-up desk, the WhatsApp campaign writer. */
export const PLAYBOOK_READERS = ["sales", "followup", "wa_campaigns"] as const;

const NAMES: Record<string, { name: string; title: string }> = {
  jewelry: { name: "لطيفة", title: "مسؤولة الشات" },
  accounting: { name: "عمر", title: "مسؤول الشات" },
};

export interface Playbook {
  questions: Array<{ q: string; how: string }>;
  objections: Array<{ o: string; how: string }>;
  works: string[];
  avoid: string[];
  campaignIdeas: Array<{ audience: string; angle: string; hook: string }>;
}

/** The brief: what the chat lead is, and the rules nothing he learns can bend. */
export function chatLeadPrompt(vertical: string, firm: string, description: string): string {
  const shop = vertical === "jewelry";
  return [
    `أنت مسؤول الشات في ${firm}${description ? ` — ${description}` : ""}.`,
    "عملك: تقرأ كل محادثات واتساب هذا الأسبوع بين الفريق والعملاء، وتستخرج ما يجعل الفريق أفضل غداً — لا تلخّص المحادثات، بل تستخلص القواعد.",
    "",
    "اقرأ كمدير مبيعات خبير:",
    "- ما الأسئلة التي يسألها العملاء أكثر من مرة؟ ولكلٍّ: كيف يجب أن تُجاب بأسلوب يُقنع، بجملة واحدة قابلة للتطبيق.",
    "- ما الاعتراضات (غالٍ، عندي محاسب، أفكر، لاحقاً…) وكيف تُعالج باحترام دون إلحاح.",
    "- أيّ ردود جعلت العميل يكمل الحديث أو يطلب، وأيّها أسكته — بناءً على ما قاله العميل بعدها فعلاً.",
    "- ما الذي يجب ألا يتكرر: أسلوب، عبارة، سؤال، طول.",
    "- أفكار حملات واتساب من كلام العملاء أنفسهم: لمن، بأيّ زاوية، وبأيّ جملة افتتاح.",
    "",
    "قواعد لا يكسرها شيء تتعلّمه:",
    "- الكلام مع العملاء محترم دائماً. ممنوع منعاً باتاً أي كلمة تحبّب أو تدليل: حبيبتي، حبيبي، صاحبتي، صديقتي، قلبي، عيوني، حياتي، يا قمر.",
    shop
      ? "- محل ذهب: ممنوع أي سعر أو وزن أو سعر ذهب أو مصنعية أو خصم في أي رسالة. السؤال عن السعر أو الوزن يُجاب برابط القطعة من المتجر. لا تقترح قاعدة تخالف هذا ولو رأيته ينجح."
      : "- لا رقم ولا سعر ولا غرامة ولا مدة لا توجد في معلومات الشركة؛ السعر يُحدد بعد معرفة نطاق العمل.",
    "- لا تخترع شيئاً لم يحدث في المحادثات. إن لم تجد نمطاً واضحاً فاترك القائمة فارغة.",
    "",
    "أعد JSON فقط، بالعربية، بهذا الشكل بالضبط:",
    `{"questions":[{"q":"السؤال كما يُطرح","how":"كيف يُجاب"}],"objections":[{"o":"الاعتراض","how":"كيف يُعالج"}],"works":["ما نجح"],"avoid":["ما يُتجنّب"],"campaignIdeas":[{"audience":"لمن","angle":"الزاوية","hook":"جملة الافتتاح"}]}`,
    "ثلاثة عناصر على الأكثر في كل قائمة، وكل عنصر جملة واحدة قصيرة (أقل من عشرين كلمة).",
  ].join("\n");
}

/** Drops whatever breaks the account's rules. Pure. */
export function sanitize(p: Playbook, vertical: string): Playbook {
  const sweet = ENDEARMENT.map((w) => normalizeArabic(w));
  const ok = (t: string) => {
    const n = ` ${normalizeArabic(t)} `;
    if (sweet.some((w) => n.includes(` ${w} `))) return false;
    if (vertical === "jewelry" && (priceOrWeight(t) || /(خصم|مصنعيه|المصنعيه|سعر الذهب|سعر الجرام)/.test(normalizeArabic(t)))) return false;
    return t.trim().length > 3;
  };
  const cap = <T,>(xs: T[] | undefined) => (Array.isArray(xs) ? xs.slice(0, 5) : []);
  return {
    questions: cap(p.questions).filter((x) => x?.q && x?.how && ok(x.q + " " + x.how)),
    objections: cap(p.objections).filter((x) => x?.o && x?.how && ok(x.o + " " + x.how)),
    works: cap(p.works).filter((x) => typeof x === "string" && ok(x)),
    avoid: cap(p.avoid).filter((x) => typeof x === "string" && ok(x) || typeof x === "string" && /حبيب|صاحبت|سعر|وزن/.test(x)),
    campaignIdeas: cap(p.campaignIdeas).filter((x) => x?.audience && x?.angle && ok(`${x.angle} ${x.hook ?? ""}`)),
  };
}

/** The handbook as each reader sees it. Pure. */
export function playbookText(p: Playbook, reader: string, by: string, date: string): string {
  const head = `دليل الشات من ${by} (${date}) — ما تعلّمه من محادثات هذا الأسبوع. طبّقه، وقواعد الحساب فوقه:`;
  const lines: string[] = [head];
  if (reader !== "wa_campaigns") {
    if (p.questions.length) lines.push("أسئلة تتكرر وكيف تُجاب:", ...p.questions.map((x) => `- «${x.q}» ← ${x.how}`));
    if (p.objections.length) lines.push("اعتراضات وكيف تُعالج:", ...p.objections.map((x) => `- «${x.o}» ← ${x.how}`));
  }
  if (p.works.length) lines.push("ما نجح:", ...p.works.map((x) => `- ${x}`));
  if (p.avoid.length) lines.push("ما يُتجنّب:", ...p.avoid.map((x) => `- ${x}`));
  if (reader === "wa_campaigns") {
    if (p.questions.length) lines.push("ما يسأل عنه الناس (مادة للحملات):", ...p.questions.map((x) => `- ${x.q}`));
    if (p.campaignIdeas.length) lines.push("أفكار حملات من كلام العملاء:", ...p.campaignIdeas.map((x) => `- لـ${x.audience}: ${x.angle}${x.hook ? ` — «${x.hook}»` : ""}`));
  }
  return lines.length > 1 ? lines.join("\n").slice(0, 2400) : "";
}

/** The chat lead is an employee: hired once, by the account's kind. */
export async function ensureChatLead(userId: number, vertical: string) {
  const [have] = await db.select().from(botEmployeesTable).where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, CHAT_LEAD_ROLE))).limit(1);
  if (have) return have;
  const n = NAMES[vertical] ?? NAMES.accounting!;
  const persona = vertical === "jewelry"
    ? "مسؤولة الشات في محل الذهب: تقرأ كل محادثات الأسبوع وتعلّم الفريق ما يسأله الزبائن وما يقنعهم، وتحرس قاعدة المحل: لا سعر ولا وزن ولا تحبّب، والرابط هو الجواب."
    : "مسؤول الشات في شركة المحاسبة: يقرأ كل محادثات الأسبوع ويعلّم الفريق ما يسأله العملاء وما يقنعهم، ويعطي كاتب الحملات زوايا من كلام العملاء أنفسهم.";
  const [row] = await db.insert(botEmployeesTable).values({ userId, name: n.name, role: CHAT_LEAD_ROLE, kind: "internal", title: n.title, avatar: "💬", persona, specialties: [], priority: 60, handoffTo: null } as any).returning();
  logger.info({ userId, role: CHAT_LEAD_ROLE }, "وُظّف مسؤول الشات");
  return row!;
}

/** The week's conversations, as text: who said what, and what came next. */
async function weekOfChats(userId: number, maxConversations = 40): Promise<string> {
  const phones = (await db.execute<{ phone: string }>(sql`
    SELECT phone FROM wa_thread_messages WHERE user_id = ${userId} AND created_at > now() - interval '7 days'
    GROUP BY phone HAVING count(*) FILTER (WHERE NOT from_me AND length(coalesce(text,'')) > 1) > 0
    ORDER BY max(created_at) DESC LIMIT ${maxConversations}`)).rows.map((r) => r.phone);
  if (!phones.length) return "";
  const rows = (await db.execute<{ phone: string; from_me: boolean; text: string }>(sql`
    SELECT phone, from_me, left(regexp_replace(coalesce(text,''), '\\s+', ' ', 'g'), 300) AS text FROM (
      SELECT phone, from_me, text, created_at, row_number() OVER (PARTITION BY phone ORDER BY created_at DESC) AS rn
      FROM wa_thread_messages WHERE user_id = ${userId} AND phone IN (SELECT jsonb_array_elements_text(${JSON.stringify(phones)}::jsonb))
    ) x WHERE rn <= 12 AND length(text) > 1 ORDER BY phone, created_at`)).rows;
  const byPhone = new Map<string, string[]>();
  for (const r of rows) byPhone.set(r.phone, [...(byPhone.get(r.phone) ?? []), `${r.from_me ? "نحن" : "العميل"}: ${r.text}`]);
  // Fourteen thousand characters: enough for the week's patterns, and within
  // what the free models accept (a 24k corpus came back empty or cut).
  return [...byPhone.values()].map((t, i) => `— محادثة ${i + 1}\n${t.join("\n")}`).join("\n\n").slice(0, 14_000);
}

/** One pass for one account: read, learn, teach. */
export async function runChatLead(userId: number): Promise<{ ok: boolean; why?: string; playbook?: Playbook }> {
  const [p] = await db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)).limit(1);
  const vertical = p?.vertical === "jewelry" ? "jewelry" : "accounting";
  const lead = await ensureChatLead(userId, vertical);
  if (!lead.isActive) return { ok: false, why: "مسؤول الشات موقوف" };
  const chats = await weekOfChats(userId);
  if (!chats) return { ok: false, why: "لا محادثات هذا الأسبوع" };

  let raw: Playbook | null = null, why = "";
  for (let attempt = 0; attempt < 2 && !raw; attempt++) {
    const out = await asAgent(userId, CHAT_LEAD_ROLE, () => complete([
      { role: "system", content: chatLeadPrompt(vertical, p?.name ?? "الشركة", p?.description ?? "") },
      { role: "user", content: `محادثات هذا الأسبوع:\n\n${chats}${attempt ? "\n\nأعد JSON فقط، يبدأ بـ{ وينتهي بـ}، بلا أي نص قبله أو بعده." : ""}` },
    ], 150_000)).catch((err) => { why = String(err?.message ?? err).slice(0, 120); return null; });
    if (!out?.text) { why = why || "النموذج لم يستجب"; continue; }
    raw = parseLoose<Playbook>(out.text);
    if (!raw) why = `ردّ النموذج ليس JSON (${out.provider ?? "?"}): ${out.text.slice(0, 80)}`;
  }
  if (!raw) { logger.warn({ userId, why }, "مسؤول الشات لم يكتب الدليل"); return { ok: false, why }; }
  const book = sanitize(raw, vertical);

  const date = new Date().toISOString().slice(0, 10);
  // The new handbook replaces the old one: one per reader, never a pile.
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, userId), eq(agentMemoryTable.kind, "playbook"), inArray(agentMemoryTable.role, [...PLAYBOOK_READERS])));
  for (const reader of PLAYBOOK_READERS) {
    const content = playbookText(book, reader, lead.name, date);
    if (content) await db.insert(agentMemoryTable).values({ userId, role: reader, kind: "playbook", content, topic: "chat-lead" });
  }
  logger.info({ userId, questions: book.questions.length, ideas: book.campaignIdeas.length }, "مسؤول الشات كتب دليل الأسبوع");
  return { ok: true, playbook: book };
}

let timer: NodeJS.Timeout | null = null;
/** Once a day for every account with conversations; first pass fifteen minutes after start. */
export function startChatLead(): void {
  if (timer) return;
  const run = async () => {
    const users = await db.execute<{ user_id: number }>(sql`SELECT DISTINCT user_id FROM wa_thread_messages WHERE created_at > now() - interval '7 days'`).catch(() => ({ rows: [] as Array<{ user_id: number }> }));
    for (const u of users.rows) await runChatLead(Number(u.user_id)).catch((err) => logger.warn({ userId: u.user_id, err: String(err?.message ?? err) }, "مسؤول الشات تعذّر"));
  };
  setTimeout(() => void run(), 15 * 60_000).unref();
  timer = setInterval(() => void run(), 24 * 3_600_000);
  timer.unref();
}
