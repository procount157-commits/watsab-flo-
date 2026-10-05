// ── One topic, every channel ──────────────────────────────────────
// The owner names a topic and a date; each channel's creator writes it in that
// channel's form — a newsletter for email (in the email section's language),
// a post for LinkedIn, a caption for Instagram, a video script for TikTok —
// from the same idea and the same company knowledge. They land as drafts on
// the weekly content calendar, to be approved (LinkedIn) or posted from the
// phone (Instagram and TikTok take no post without media from a browser).

import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import { db, contentPlansTable, socialContentTable, emailTemplatesTable, type ContentPlan } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { teamVoice } from "../email/team";
import { getSettings } from "../email/service";
import { languageRule, asLanguage } from "../email/language";
import { companyKnowledge, knowledgeLines } from "../company-knowledge";
import { draftPost } from "../social/agent";
import { activity as socialActivity } from "../social/team";
import { activity as emailActivity } from "../email/team";
import type { SocialPlatform } from "../social/platforms";

export const CHANNELS = ["email", "linkedin", "instagram", "tiktok"] as const;
export type Channel = typeof CHANNELS[number];

/** The newsletter: subject and body, in the email section's language. */
export async function draftNewsletter(userId: number, topic: string) {
  const s = await getSettings(userId);
  const lang = asLanguage(s?.defaultLanguage);
  const [voice, kb] = await Promise.all([teamVoice(userId, "email_creator"), companyKnowledge(userId, topic, { limit: 6 }).catch(() => [])]);
  const out = await asAgent(userId, "email_creator", () => complete([
    { role: "system", content: [voice, "", knowledgeLines(kb),
      "اكتب نشرة بريدية واحدة لعملاء الشركة ومتابعيها عن الموضوع المطلوب: تعلّم فكرة واحدة عملية، ٣–٥ فقرات قصيرة، ثم دعوة واحدة.",
      languageRule(lang),
      "اكتب بهذا الشكل بالضبط:", "[عنوان] <سطر الموضوع>", "[الرسالة]", "<HTML بسيط: p و h3 و ul/li، يبدأ بـ Hello {{first_name|there}}, أو مرحباً>", "[/الرسالة]",
    ].filter(Boolean).join("\n") },
    { role: "user", content: `الموضوع: ${topic}` },
  ], 60_000));
  const t = out?.text ?? "";
  const subject = /\[عنوان\]\s*(.+)/.exec(t)?.[1]?.trim();
  const html = /\[الرسالة\]\s*([\s\S]*?)(\[\/الرسالة\]|$)/.exec(t)?.[1]?.replace(/^```(?:html)?|```$/g, "").trim();
  return subject && html && html.length > 60 ? { subject: subject.slice(0, 300), html } : null;
}

/** Write the topic for each chosen channel, as drafts dated for the calendar. What failed to write is said, not hidden. */
export async function makePlan(userId: number, input: { topic: string; publishOn: string; channels: Channel[]; notes?: string | null }) {
  const channels = CHANNELS.filter((c) => input.channels.includes(c));
  if (!channels.length) throw new Error("اختر قناة واحدة على الأقل");
  const [plan] = await db.insert(contentPlansTable).values({ userId, topic: input.topic.slice(0, 1_000), publishOn: input.publishOn, channels, notes: input.notes ?? null }).returning();
  const at = new Date(`${input.publishOn}T10:00:00+04:00`);
  const failed: string[] = [];
  // One after another: four long writes at once is how a free model tier says no to all four.
  for (const c of channels) {
    try {
      if (c === "email") {
        const n = await draftNewsletter(userId, input.topic);
        if (!n) { failed.push(c); continue; }
        const [tpl] = await db.insert(emailTemplatesTable).values({ userId, name: `نشرة: ${input.topic}`.slice(0, 160), subject: n.subject, html: n.html, category: "newsletter" } as any).returning();
        await db.update(contentPlansTable).set({ emailTemplateId: tpl!.id }).where(eq(contentPlansTable.id, plan!.id));
        await emailActivity(userId, "email_creator", "newsletter", `كتب نشرة «${n.subject}» لخطة ${input.publishOn}`);
      } else {
        const text = await draftPost(userId, c as SocialPlatform, input.topic);
        if (!text) { failed.push(c); continue; }
        await db.insert(socialContentTable).values({ userId, platform: c, kind: "post", topic: input.topic, text, role: `${({ linkedin: "li", instagram: "ig", tiktok: "tt" } as const)[c]}_creator`, scheduledAt: at, planId: plan!.id });
        await socialActivity(userId, c as SocialPlatform, "creator", "plan", `كتب ${c === "tiktok" ? "نص فيديو" : "منشوراً"} عن «${input.topic.slice(0, 60)}» ليوم ${input.publishOn}`);
      }
    } catch { failed.push(c); }
  }
  return { plan: plan!, failed };
}

/** The calendar between two dates, each plan with what each channel wrote. */
export async function calendar(userId: number, from: string, to: string) {
  const plans = await db.select().from(contentPlansTable).where(and(eq(contentPlansTable.userId, userId), gte(contentPlansTable.publishOn, from), lte(contentPlansTable.publishOn, to))).orderBy(asc(contentPlansTable.publishOn));
  if (!plans.length) return [];
  const ids = plans.map((p) => p.id);
  const tplIds = plans.map((p) => p.emailTemplateId).filter((x): x is number => !!x);
  const [items, tpls] = await Promise.all([
    db.select().from(socialContentTable).where(and(eq(socialContentTable.userId, userId), inArray(socialContentTable.planId, ids))),
    tplIds.length ? db.select().from(emailTemplatesTable).where(inArray(emailTemplatesTable.id, tplIds)) : Promise.resolve([] as Array<typeof emailTemplatesTable.$inferSelect>),
  ]);
  return plans.map((p: ContentPlan) => ({ ...p, items: items.filter((i) => i.planId === p.id), email: tpls.find((t) => t.id === p.emailTemplateId) ?? null }));
}

export async function deletePlan(userId: number, id: number) {
  await db.delete(socialContentTable).where(and(eq(socialContentTable.userId, userId), eq(socialContentTable.planId, id), inArray(socialContentTable.status, ["draft", "skipped", "failed"])));
  await db.delete(contentPlansTable).where(and(eq(contentPlansTable.id, id), eq(contentPlansTable.userId, userId)));
}
