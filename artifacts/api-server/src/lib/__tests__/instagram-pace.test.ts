import { mayAct, todayCounts, ensureAccount, PACE } from "../instagram/engine";
import { IG_TEAM_DEFS, IG_TEAM, IG_DOCTRINE } from "../instagram/team";
import { db, instagramAccountsTable, instagramActionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };

async function clean() {
  await db.delete(instagramActionsTable).where(eq(instagramActionsTable.userId, USER));
  await db.delete(instagramAccountsTable).where(eq(instagramAccountsTable.userId, USER));
}
const act = (action: string, over: Partial<typeof instagramActionsTable.$inferInsert> = {}) =>
  db.insert(instagramActionsTable).values({ userId: USER, role: "ig_dm", action, ...over } as any);

/** Inside the working window, so the hour check is not what a case is testing. */
const inHours = () => {
  const h = (new Date().getUTCHours() + 4) % 24;
  return h >= PACE.hours[0] && h < PACE.hours[1];
};

await clean();

// ── The team ─────────────────────────────────────────────────────
check("عشرة موظفين", IG_TEAM.length === 10 && IG_TEAM_DEFS.length === 10);
check("لكل واحد اسم ودور وشخصية",
  IG_TEAM_DEFS.every((d) => d.name && d.title && d.persona.length > 80));
check("ولكل واحد مهام", IG_TEAM_DEFS.every((d) => d.tasks.length >= 1));
check("الأدوار فريدة", new Set(IG_TEAM_DEFS.map((d) => d.role)).size === 10);
check("والأسماء كذلك", new Set(IG_TEAM_DEFS.map((d) => d.name)).size === 10);

// The line that separates a social inbox from spam, stated in the doctrine
// every one of them reads before its own job.
check("العقيدة تمنع مراسلة من لم يتواصل",
  /لا نفتح محادثة مع غريب لم يتواصل معنا/.test(IG_DOCTRINE));
check("وتمنع التعليق على منشورات الآخرين للترويج",
  /ولا نعلّق على منشورات الآخرين للترويج/.test(IG_DOCTRINE));
check("وتمنع اختراع الأرقام", /اختراع رقم أو نسبة/.test(IG_DOCTRINE));
check("وتمنع الرد على كل شيء آلياً", /الرد على كل تعليق ليس هدفاً/.test(IG_DOCTRINE));

// ── Nothing happens without an account ───────────────────────────
let g = await mayAct(USER, "reply");
check("بلا حساب لا فعل", !g.allowed);

const a = await ensureAccount(USER, "ig_dm");
check("الحساب يُنشأ في وضع التجربة", a.dryRun === true, "لا يخرج شيء افتراضياً");
check("وبحدود منخفضة", a.dailyCommentCap <= 50 && a.dailyDmCap <= 25,
  `${a.dailyCommentCap}/${a.dailyDmCap}`);

// ── The states that stop everything ──────────────────────────────
for (const [state, why] of [
  ["unknown", "حالة غير معروفة"],
  ["logged_out", "خارج الجلسة"],
  ["checkpoint", "إنستجرام يطلب تأكيد الهوية"],
  ["restricted", "الحساب مقيَّد"],
] as const) {
  await db.update(instagramAccountsTable).set({ state }).where(eq(instagramAccountsTable.userId, USER));
  g = await mayAct(USER, "reply");
  check(`${why} ← لا فعل`, !g.allowed, g.reason?.slice(0, 34));
}

await db.update(instagramAccountsTable).set({ state: "logged_in" }).where(eq(instagramAccountsTable.userId, USER));
g = await mayAct(USER, "reply");
check("مسجّل دخول وداخل الساعات ← مسموح", inHours() ? g.allowed : !g.allowed,
  inHours() ? "" : "خارج ساعات العمل الآن");

// ── The daily caps ───────────────────────────────────────────────
await db.update(instagramAccountsTable).set({ dailyCommentCap: 3, dailyDmCap: 2 })
  .where(eq(instagramAccountsTable.userId, USER));
// Old enough not to trip the minimum-gap rule, which is a different case.
const old = new Date(Date.now() - 10 * 60_000);
for (let i = 0; i < 3; i++) await act("reply_comment", { createdAt: old });

const t = await todayCounts(USER);
check("الأفعال تُحصى", t.replies === 3, `${t.replies}`);

g = await mayAct(USER, "reply");
check("بلوغ حد الردود يوقف الردود", !g.allowed && /حد اليوم/.test(g.reason ?? ""));
g = await mayAct(USER, "dm");
check("...ولا يوقف الرسائل", inHours() ? g.allowed : true, "حدّان منفصلان");

// ── Failures stop the run ────────────────────────────────────────
// Instagram does not say it is throttling you; repeated failures are the only
// signal, and continuing into them is how a throttle becomes a restriction.
await clean();
await ensureAccount(USER, "ig_dm");
await db.update(instagramAccountsTable).set({ state: "logged_in" }).where(eq(instagramAccountsTable.userId, USER));
for (let i = 0; i < 5; i++) await act("reply_comment", { ok: false, createdAt: old });
g = await mayAct(USER, "reply");
check("خمس محاولات فاشلة توقف كل شيء", !g.allowed && /فشلت/.test(g.reason ?? ""));

// ── The gap between actions ──────────────────────────────────────
await clean();
await ensureAccount(USER, "ig_dm");
await db.update(instagramAccountsTable).set({ state: "logged_in" }).where(eq(instagramAccountsTable.userId, USER));
await act("reply_comment");   // just now
g = await mayAct(USER, "reply");
check("فعلان متتاليان بلا فاصل ممنوعان", !g.allowed, "الإيقاع الآلي هو ما يُرصد");
check("...ويُقال كم ينتظر", (g.waitMs ?? 0) > 0 && (g.waitMs ?? 0) <= PACE.minGapMs,
  `${Math.round((g.waitMs ?? 0) / 1000)}ث`);
check("الفاصل الأدنى لا يقل عن نصف دقيقة", PACE.minGapMs >= 30_000, `${PACE.minGapMs / 1000}ث`);
check("وثمة استراحة طويلة كل بضعة أفعال",
  PACE.restEvery <= 12 && PACE.restMs[0] >= 2 * 60_000);
check("ولا نشاط ليلاً", PACE.hours[0] >= 7 && PACE.hours[1] <= 23,
  `${PACE.hours[0]}–${PACE.hours[1]}`);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
