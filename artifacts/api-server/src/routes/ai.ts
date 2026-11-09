import { Router } from "express";
import { requireAuth } from "../lib/auth";
import { modelHalted } from "../lib/org/controls";
import { getStatus, getHealth } from "../lib/whatsapp";
import { db, campaignsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const router = Router();

const POLLINATIONS_URL = "https://text.pollinations.ai/";
const MODEL = "openai";

interface PollinationsResponse {
  choices?: { message?: { content?: string } }[];
}

async function callAI(
  messages: { role: string; content: string }[],
  timeoutMs = 30_000
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(POLLINATIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages, seed: -1, private: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`AI API error: ${res.status}`);
    const data = (await res.json()) as PollinationsResponse;
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("استجابة فارغة من الذكاء الاصطناعي");
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ── POST /api/ai/optimize-message ───────────────────────────────────────────

router.post("/optimize-message", requireAuth, async (req, res) => {
  // Pollinations directly, not complete(): the kill switch is asked here.
  if (await modelHalted(req.session.userId)) { res.status(503).json({ error: "الذكاء الاصطناعي موقوف بمفتاح الإيقاف" }); return; }
  const body = req.body as { message?: unknown; tone?: unknown };
  const message = typeof body.message === "string" ? body.message.slice(0, 4000) : "";
  if (!message) { res.status(400).json({ error: "الرسالة مطلوبة" }); return; }

  const tone = (["friendly","professional","urgent","promotional"] as const)
    .includes(body.tone as "friendly")
    ? (body.tone as string)
    : "friendly";

  const toneMap: Record<string, string> = {
    friendly:     "ودود وطبيعي",
    professional: "مهني ورسمي",
    urgent:       "عاجل ومقنع",
    promotional:  "ترويجي وجذاب",
  };

  const result = await callAI([
    {
      role: "system",
      content: `أنت خبير تسويق عبر واتساب.
مهمتك: تحسين رسالة واتساب لتكون أكثر تأثيراً وتفاعلاً.
الأسلوب المطلوب: ${toneMap[tone]}.
القواعد:
- احتفظ بأي متغيرات مثل {الاسم} أو {الشركة} أو {تحية} أو {ختام} كما هي بالضبط
- لا تغير الروابط أو الأرقام
- اجعل الرسالة طبيعية وغير إعلانية بشكل صارخ
- أقصى طول: 500 حرف
- أرسل الرسالة المحسّنة فقط بدون تعليقات أو شرح`,
    },
    { role: "user", content: `الرسالة الأصلية:\n${message}` },
  ]);

  res.json({ result });
});

export default router;
