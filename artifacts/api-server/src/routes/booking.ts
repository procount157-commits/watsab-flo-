// ── /api/book/:token — the public booking page's data ─────────────
// No sign-in: a customer opens the owner's link and picks a time. The token
// is the owner's alone and can be changed; only free times are shown, and a
// time is checked again at the moment it is taken.
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, meetingSettingsTable, businessProfileTable } from "@workspace/db";
import { availableSlots, book, slotLabel } from "../lib/deals/meetings";

const router = Router();
const recent = new Map<string, number[]>();
/** A handful of bookings an hour from one address, which is more than any customer needs. */
function limited(ip: string) {
  const now = Date.now(), list = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  recent.set(ip, [...list, now]);
  return list.length >= 6;
}

async function owner(token: string) {
  if (!/^[a-f0-9]{24,64}$/.test(token)) return null;
  const [s] = await db.select().from(meetingSettingsTable).where(eq(meetingSettingsTable.bookingToken, token)).limit(1);
  return s ?? null;
}

router.get("/:token", async (req, res) => {
  const s = await owner(String(req.params["token"]));
  if (!s) return res.status(404).json({ error: "رابط الحجز غير صحيح" });
  const [p] = await db.select({ name: businessProfileTable.name }).from(businessProfileTable).where(eq(businessProfileTable.userId, s.userId)).limit(1);
  const free = await availableSlots(s.userId, 14, 60);
  res.json({ business: p?.name ?? "", durationMin: s.durationMin, slots: free.map((d) => ({ at: d.toISOString(), ar: slotLabel(d, "ar"), en: slotLabel(d, "en") })) });
});

router.post("/:token", async (req, res) => {
  const s = await owner(String(req.params["token"]));
  if (!s) return res.status(404).json({ error: "رابط الحجز غير صحيح" });
  if (limited(req.ip ?? "?")) return res.status(429).json({ error: "محاولات كثيرة — حاول بعد قليل" });
  const b = req.body ?? {};
  const name = String(b.name ?? "").trim().slice(0, 160), email = String(b.email ?? "").trim().slice(0, 254), phone = String(b.phone ?? "").replace(/[^\d+]/g, "").slice(0, 30);
  if (!name || (!email && !phone)) return res.status(400).json({ error: "اكتب اسمك وبريدك أو هاتفك" });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "البريد غير صالح" });
  try {
    const m = await book(s.userId, { name, company: b.company ? String(b.company).slice(0, 200) : null, email: email || null, phone: phone || null, startsAt: new Date(String(b.at)), topic: b.topic ? String(b.topic).slice(0, 500) : null, source: "link" });
    res.json({ ok: true, at: m.startsAt, ar: slotLabel(m.startsAt, "ar"), en: slotLabel(m.startsAt, "en") });
  } catch (err: any) { res.status(409).json({ error: String(err?.message ?? err) }); }
});

export default router;
