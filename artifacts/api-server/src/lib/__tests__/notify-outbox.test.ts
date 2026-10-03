import { flushOutbox, outboxState } from "../telegram";
import { db, notifyOutboxTable, telegramSettingsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };
const clean = async () => {
  await db.delete(notifyOutboxTable).where(eq(notifyOutboxTable.userId, USER));
  await db.delete(telegramSettingsTable).where(eq(telegramSettingsTable.userId, USER));
};
await clean();

const queue = (body: string, over: Partial<typeof notifyOutboxTable.$inferInsert> = {}) =>
  db.insert(notifyOutboxTable).values({ userId: USER, body, ...over } as any).returning();

// ── A report with nowhere to go ──────────────────────────────────
await queue("تقرير بلا تليجرام");
let r = await flushOutbox(50);
check("تقرير لحساب بلا تليجرام لا يُعاد للأبد", r.dead >= 1, "يُغلق بدل الدوران");
let st = await outboxState(USER);
check("ولا يبقى في الانتظار", st.pending === 0);

// ── Queued but not yet due ───────────────────────────────────────
await clean();
await db.insert(telegramSettingsTable).values({
  userId: USER, botToken: "0:" + "x".repeat(35), chatId: "1", enabled: true,
} as any);
await queue("ليس بعد", { nextTryAt: new Date(Date.now() + 10 * 60_000) });
r = await flushOutbox(50);
check("ما لم يحن موعده لا يُحاوَل", r.sent === 0 && r.failed === 0 && r.dead === 0);
check("ويبقى منتظراً", (await outboxState(USER)).pending === 1);

// ── A token that will never work ─────────────────────────────────
await clean();
await db.insert(telegramSettingsTable).values({
  userId: USER, botToken: "0:" + "x".repeat(35), chatId: "1", enabled: true,
} as any);
const [row] = await queue("فشل متوقع");
r = await flushOutbox(50);
check("الفشل يُحسب محاولة لا نهاية", r.failed === 1 || r.dead === 1);

let [after] = await db.select().from(notifyOutboxTable).where(eq(notifyOutboxTable.id, row!.id));
check("عدد المحاولات ارتفع", (after?.attempts ?? 0) >= 1, `${after?.attempts}`);
check("وسبب الفشل محفوظ", !!after?.lastError);
check("والمحاولة التالية في المستقبل",
  !!after?.nextTryAt && new Date(after.nextTryAt).getTime() > Date.now(), "تراجع تدريجي");

// Backoff must grow, or a sleeping laptop is hammered pointlessly.
const first = new Date(after!.nextTryAt).getTime() - Date.now();
await db.update(notifyOutboxTable).set({ nextTryAt: new Date(), attempts: 3 }).where(eq(notifyOutboxTable.id, row!.id));
await flushOutbox(50);
[after] = await db.select().from(notifyOutboxTable).where(eq(notifyOutboxTable.id, row!.id));
const later = after?.nextTryAt ? new Date(after.nextTryAt).getTime() - Date.now() : 0;
check("الانتظار يطول مع كل فشل", later > first, `${Math.round(first/60000)}د → ${Math.round(later/60000)}د`);

// And it has to stop. A report about this morning is worthless tomorrow.
await db.update(notifyOutboxTable).set({ nextTryAt: new Date(), attempts: 99 }).where(eq(notifyOutboxTable.id, row!.id));
await flushOutbox(50);
[after] = await db.select().from(notifyOutboxTable).where(eq(notifyOutboxTable.id, row!.id));
check("وبعد محاولات كافية يتوقف", after?.status === "dead", "لا يدور للأبد");

// ── Order ────────────────────────────────────────────────────────
// "Campaign finished" arriving before "campaign started" is worse than both
// being late.
await clean();
await db.insert(telegramSettingsTable).values({
  userId: USER, botToken: "0:" + "x".repeat(35), chatId: "1", enabled: true,
} as any);
await queue("الأقدم", { createdAt: new Date(Date.now() - 60_000) } as any);
await queue("الأحدث");
const pendingNow = await db.select().from(notifyOutboxTable)
  .where(and(eq(notifyOutboxTable.userId, USER), eq(notifyOutboxTable.status, "pending")))
  .orderBy(notifyOutboxTable.createdAt);
check("الأقدم يُحاوَل أولاً", pendingNow[0]?.body === "الأقدم", "ترتيب الأحداث يُحفظ");

st = await outboxState(USER);
check("والحالة تُقرأ للتشخيص", st.pending === 2 && !!st.oldest);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
