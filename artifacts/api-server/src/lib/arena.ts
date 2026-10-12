// ── The training arena ────────────────────────────────────────────
// The owner plays the customer and watches an employee answer — with
// everything that went into the answer laid out beside it: the intent it
// read, the card it built, the stage it thinks the sale is at, the skills
// it carried, what the pre-send check caught, and the first draft if it was
// rewritten. Nothing is sent to anyone.
//
// Then the owner grades it. A thumbs-up is a win in the employee's memory;
// a thumbs-down with "this is what it should have said" becomes a standing
// instruction in the owner's own words. That is the fastest way an
// employee learns what this particular business wants, and it does not wait
// for real customers to generate outcomes.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, botEmployeesTable, autoReplyLogTable, type LeadCard } from "@workspace/db";
import { classify, type Intent } from "./intent";
import { extractFacts, nextStage, cardText, STAGES } from "./lead-card";
import { skillsFor, skillsPreamble, finalCheckPreamble } from "./agent-skills";
import { memoryPreamble, remember } from "./agent-memory";
import { personaPreamble, agentJob, type Routing } from "./agent-router";
import { answerFromKnowledge } from "./knowledge";
import { shopContext } from "./catalog/shop-context";

export type Turn = { role: "user" | "assistant"; content: string };

/** The card the customer's messages would have built, without touching the database. */
export function cardFrom(turns: Turn[], intents: Intent[]): LeadCard {
  const card: any = { userId: 0, phone: "arena", stage: 1, licence: null, activity: null, size: null, staff: null, taxStatus: null,
    accountant: null, pain: null, objection: null, agreedAt: null, humanUntil: null, humanBy: null, lastIntent: null, turns: 0, notifiedStage: 0, updatedAt: new Date() };
  const users = turns.filter((t) => t.role === "user");
  users.forEach((t, i) => {
    const f = extractFacts(t.content);
    card.licence ??= f.licence ?? null; card.activity ??= f.activity ?? null; card.pain ??= f.pain ?? null;
    card.size = f.size ?? card.size; card.staff = f.staff ?? card.staff; card.taxStatus = f.taxStatus ?? card.taxStatus;
    card.accountant = f.accountant ?? card.accountant;
    card.objection = f.objection ?? null;
    if (f.agreed && !card.agreedAt) card.agreedAt = new Date();
    card.turns = i + 1;
    card.stage = nextStage(card.stage, card, intents[i] ?? "unclear", i + 1, f);
    card.lastIntent = intents[i] ?? null;
  });
  return card as LeadCard;
}

export async function simulate(userId: number, role: string, turns: Turn[]) {
  const clean = turns.filter((t) => t.content?.trim()).slice(-20);
  const last = [...clean].reverse().find((t) => t.role === "user");
  if (!last) throw new Error("اكتب رسالة العميل");

  const [agent] = await db.select().from(botEmployeesTable)
    .where(and(eq(botEmployeesTable.userId, userId), eq(botEmployeesTable.role, role))).limit(1);
  if (!agent) throw new Error("الموظف غير موجود");

  const intents: Intent[] = [];
  for (const t of clean.filter((x) => x.role === "user")) intents.push((await classify(t.content, false)).intent);
  const intent = intents.at(-1) ?? "unclear";
  const card = cardFrom(clean, intents);

  const routing: Routing = { agent: { ...agent, specialties: Array.isArray(agent.specialties) ? agent.specialties as string[] : [] } };
  const [memory, skills] = await Promise.all([memoryPreamble(userId, role), skillsFor(userId, role, intent)]);
  const voice = [personaPreamble(routing), skillsPreamble(skills), memory].filter(Boolean).join("\n\n");

  const t0 = Date.now();
  // The same path a real reply takes: the message read first, the shop's
  // facts (piece, quote, ad) attached, the employee's own name and dialect.
  const shop = await shopContext(userId, "arena", last.content).catch(() => null);
  const answer = await answerFromKnowledge(userId, last.content, undefined, voice, agentJob(routing), finalCheckPreamble(skills), cardText(card), {
    card, history: clean,
    speaker: { name: agent.name, title: agent.title },
    shop: shop ? { vertical: shop.vertical, dialect: shop.dialect, ad: shop.ad, piece: shop.piece?.name ?? null, facts: shop.facts } : null,
  });
  return {
    reply: answer.reply, provider: answer.provider, ms: Date.now() - t0, reason: answer.reason ?? null,
    intent, stage: STAGES[Math.min(7, Math.max(1, card.stage)) - 1],
    card: { licence: card.licence, activity: card.activity, size: card.size, staff: card.staff, taxStatus: card.taxStatus, accountant: card.accountant, pain: card.pain, objection: card.objection, agreed: !!card.agreedAt },
    skills: skills.map((s) => s.name),
    quality: answer.quality ?? null,
    reading: answer.reading ?? null,
    photo: shop?.photo?.caption ?? null,
    debug: answer.debug ?? null,
    employee: { name: agent.name, title: agent.title, avatar: agent.avatar },
  };
}

/**
 * The owner's grade. +1 remembers the opening as something that works;
 * -1 remembers it as something that does not, and a correction becomes an
 * instruction in the owner's words, tied to what the customer said.
 */
export async function rate(userId: number, input: {
  role: string; customer: string; reply: string; rating: 1 | -1; correction?: string | null; logId?: number | null;
}): Promise<{ remembered: string[] }> {
  const remembered: string[] = [];
  const opening = input.reply.trim().split(/\n/)[0]!.slice(0, 180);
  if (input.rating > 0) {
    await remember(userId, input.role, "win", opening);
    remembered.push("أسلوب نجح");
  } else {
    await remember(userId, input.role, "loss", opening);
    remembered.push("أسلوب لا يُعاد");
    const fix = (input.correction ?? "").trim();
    if (fix) {
      await remember(userId, input.role, "instruction",
        `حين يكتب العميل مثل «${input.customer.trim().slice(0, 90)}» فالرد الصحيح مثل: «${fix.slice(0, 220)}»`);
      remembered.push("تعليمة منك");
    }
  }
  if (input.logId) {
    await db.update(autoReplyLogTable).set({ ownerRating: input.rating, ownerNote: input.correction?.slice(0, 500) ?? null })
      .where(and(eq(autoReplyLogTable.id, input.logId), eq(autoReplyLogTable.userId, userId)));
  }
  return { remembered };
}

/** Real replies, newest first, for the owner to grade. */
export async function recentForReview(userId: number, limit = 60) {
  const [rows, perRole] = await Promise.all([
    db.select().from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), isNotNull(autoReplyLogTable.reply)))
      .orderBy(desc(autoReplyLogTable.createdAt)).limit(limit),
    db.select({
      role: autoReplyLogTable.agentRole,
      n: sql<number>`count(*)`,
      avgQuality: sql<number>`round(avg(${autoReplyLogTable.qualityScore}))`,
      rewritten: sql<number>`count(*) filter (where ${autoReplyLogTable.rewritten})`,
      up: sql<number>`count(*) filter (where ${autoReplyLogTable.ownerRating} > 0)`,
      down: sql<number>`count(*) filter (where ${autoReplyLogTable.ownerRating} < 0)`,
      wins: sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} in ('win','qualified'))`,
      losses: sql<number>`count(*) filter (where ${autoReplyLogTable.outcome} in ('loss','quiet'))`,
    }).from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), isNotNull(autoReplyLogTable.reply), sql`${autoReplyLogTable.createdAt} > now() - interval '30 days'`))
      .groupBy(autoReplyLogTable.agentRole),
  ]);
  return {
    rows,
    perRole: perRole.map((r) => ({ role: r.role, n: Number(r.n), avgQuality: r.avgQuality === null ? null : Number(r.avgQuality), rewritten: Number(r.rewritten),
      up: Number(r.up), down: Number(r.down), wins: Number(r.wins), losses: Number(r.losses) })),
  };
}
