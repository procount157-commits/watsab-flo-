// ── مكتب البيانات: منظِّفٌ ثم مصنِّف، عند كل رفع ─────────────────
// الحلقة التي طلبها صاحب العمل: «أرفع فقط — واحد ينظّفها، واحد يصنّفها،
// والباقي يُنفَّذ».
//
//   الرفع ← المنظِّف (ما يصلح، ما أُصلح، ما رُدّ ولماذا)
//         ← المصنِّف (القطاع لكل جهة، وبماذا عُرف، وأين تذهب)
//         ← الفرز (الغريب عن قائمته يذهب إلى قائمة قطاعه)
//         ← المدير (تقريرٌ برقمه، والموجات تأخذ من المصنَّف)
//
// والموظفون هنا أربعة قائمون لا جدد — مهندس القراف لا يوظّف حيث يكفي
// موجود: سالم (منسّق القوائم) ينظّف أرقام الواتساب وريم (جامعة
// البيانات) تصنّفها؛ وماجد (حارس البريد) ينظّف العناوين وبدور (أمينة
// التصنيف) تصنّفها. وكلٌّ يسلّم التالي برسالةٍ تُرى في غرفة الفريق.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, contactsTable, contactGroupsTable, emailContactsTable, emailListsTable, emailListMembersTable, unsubscribedPhonesTable } from "@workspace/db";
import { complete } from "../llm";
import { asAgent } from "../agent-context";
import { say } from "../agent-comms";
import { receipt } from "../graph/receipts";
import { logger } from "../logger";
import { fileUnfiledLists, AUTOPILOT_MARK } from "../folders";
import { organizeAccount } from "../organize";
import { classifyRow, modelPrompt, parseModel, readList, bucketOf, BUCKET_AR, sendable, type SectorBy, type ListReading } from "./classify";
import { cleanEmail, cleanName, type Clearance } from "./clean";

export type Channel = "whatsapp" | "email";

/** من يفعل ماذا في كل قناة — ومن يُرفع إليه التقرير. */
export const DESK_ROLES: Record<Channel, { cleaner: string; classifier: string; manager: string; cleanerName: string; classifierName: string; managerName: string }> = {
  whatsapp: { cleaner: "intake", classifier: "collector", manager: "chief", cleanerName: "سالم", classifierName: "ريم", managerName: "شمّة" },
  email: { cleaner: "email_guard", classifier: "email_data", manager: "email_manager", cleanerName: "ماجد", classifierName: "بدور", managerName: "منصور" },
};

/** أسماءٌ في النداء الواحد، ونداءاتٌ في الجولة: الحساب المجاني ٨٠٠٠ رمزاً في الدقيقة. */
const BATCH = 40, MAX_BATCHES = 6, GAP_MS = 21_000;

/** المصنّف يقرأ الأسماء التي عجزت عنها القواعد. يُرجع قطاعاً أو null لكل اسم. */
async function askModel(userId: number, role: string, names: string[]): Promise<Array<string | null>> {
  const out: Array<string | null> = [];
  for (let i = 0; i < names.length && i < BATCH * MAX_BATCHES; i += BATCH) {
    const chunk = names.slice(i, i + BATCH);
    const p = modelPrompt(chunk);
    const r = await asAgent(userId, role, () => complete([{ role: "system", content: p.system }, { role: "user", content: p.user }], 45_000)).catch(() => null);
    out.push(...(r?.text ? parseModel(r.text, chunk.length) : chunk.map(() => null)));
    if (i + BATCH < names.length && i + BATCH < BATCH * MAX_BATCHES) await new Promise((x) => setTimeout(x, GAP_MS));
  }
  while (out.length < names.length) out.push(null);
  return out;
}

export interface DeskReport {
  channel: Channel; listId: number | null; listName: string;
  /** ما قاله المستورد عن الملف الخام، إن جاءت الجولة من رفع. */
  intake?: Record<string, number> | null;
  clearance: { checked: number; fixed: number; removed: number; notes: string[] };
  reading: ListReading;
  /** كم قرأ المصنّف من الأسماء بالنموذج، وكم حسم منها. */
  model: { asked: number; settled: number; left: number };
  filed: Array<{ sector: string; moved: number; to: string }>;
  headline: string;
}

// ── واتساب ────────────────────────────────────────────────────────
async function cleanWa(userId: number, groupId: number): Promise<DeskReport["clearance"]> {
  const notes: string[] = [];
  let fixed = 0, removed = 0;
  const rows = await db.select().from(contactsTable).where(eq(contactsTable.groupId, groupId));
  // أسماءٌ وهمية («N/A»، أرقام) تُفرَّغ: رسالةٌ تبدأ بـ«مرحباً N/A» أسوأ من رسالةٍ بلا اسم.
  const junk = rows.filter((r) => r.name && cleanName(r.name) === null).map((r) => r.id);
  if (junk.length) {
    await db.update(contactsTable).set({ name: null }).where(inArray(contactsTable.id, junk));
    fixed += junk.length; notes.push(`${junk.length} اسماً وهمياً (N/A، أرقام) أُفرغ — القالب يحمل بديله`);
  }
  // المكرّر داخل القائمة نفسها: الأقدم يبقى.
  const seen = new Map<string, number>(); const dup: number[] = [];
  for (const r of [...rows].sort((a, b) => a.id - b.id)) { if (seen.has(r.phone)) dup.push(r.id); else seen.set(r.phone, r.id); }
  if (dup.length) { await db.delete(contactsTable).where(inArray(contactsTable.id, dup)); removed += dup.length; notes.push(`${dup.length} رقماً مكرّراً داخل القائمة حُذف`); }
  // من طلب الإيقاف لا يبقى في قائمة.
  const phones = [...seen.keys()];
  if (phones.length) {
    const out = await db.select({ phone: unsubscribedPhonesTable.phone }).from(unsubscribedPhonesTable)
      .where(and(eq(unsubscribedPhonesTable.userId, userId), inArray(unsubscribedPhonesTable.phone, phones)));
    if (out.length) {
      await db.delete(contactsTable).where(and(eq(contactsTable.groupId, groupId), inArray(contactsTable.phone, out.map((o) => o.phone))));
      removed += out.length; notes.push(`${out.length} رقماً طلب الإيقاف أُخرج من القائمة`);
    }
  }
  // رقمٌ في أكثر من قائمة يستقبل الحملة مرتين — يُعدّ ولا يُحذف: أيّ القائمتين أحقّ به قرار صاحب العمل.
  const other = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT c.phone)::int AS n FROM contacts c JOIN contact_groups g ON g.id = c.group_id
    WHERE g.user_id = ${userId} AND c.group_id <> ${groupId}
      AND c.phone IN (SELECT phone FROM contacts WHERE group_id = ${groupId})`);
  const shared = Number(other.rows[0]?.n ?? 0);
  if (shared) notes.push(`${shared} رقماً موجودٌ في قائمةٍ أخرى أيضاً — حملتان لهما تصلانه مرتين`);
  const invalid = rows.filter((r) => r.status === "invalid").length;
  if (invalid) notes.push(`${invalid} رقماً قال واتساب إنه بلا حساب — لا يُرسَل إليه`);
  return { checked: rows.length, fixed, removed, notes };
}

async function classifyWa(userId: number, groupId: number, listName: string, useModel: boolean): Promise<{ reading: ListReading; model: DeskReport["model"] }> {
  const rows = await db.select().from(contactsTable).where(eq(contactsTable.groupId, groupId));
  const verdicts = rows.map((r) => ({ r, c: r.sectorBy === "model" && r.sector ? { sector: r.sector, by: "model" as SectorBy } : classifyRow({ company: r.name, hint: listName }) }));
  // ما لم يقل اسمه شيئاً — ورث من الملف أو لم يُعرف — يقرؤه المصنّف.
  const weak = verdicts.filter((v) => v.c.by !== "own" && v.c.by !== "model" && cleanName(v.r.name));
  let settled = 0, asked = 0;
  if (useModel && weak.length) {
    const names = weak.slice(0, BATCH * MAX_BATCHES).map((v) => v.r.name!);
    asked = names.length;
    const ans = await askModel(userId, DESK_ROLES.whatsapp.classifier, names);
    ans.forEach((sector, i) => { if (sector) { weak[i]!.c = { sector, by: "model" }; settled++; } });
  }
  const now = new Date();
  // تُكتب بالقطاع مجمَّعةً: آلاف التحديثات الفردية تُثقل القاعدة بلا داعٍ.
  const groups = new Map<string, number[]>();
  for (const v of verdicts) {
    if (v.r.sector === v.c.sector && v.r.sectorBy === v.c.by) continue;
    const k = `${v.c.sector ?? ""}|${v.c.by ?? ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(v.r.id);
  }
  for (const [k, ids] of groups) {
    const [sector, by] = k.split("|");
    for (let i = 0; i < ids.length; i += 1000) {
      await db.update(contactsTable).set({ sector: sector || null, sectorBy: by || null, classifiedAt: now }).where(inArray(contactsTable.id, ids.slice(i, i + 1000)));
    }
  }
  return { reading: readList(verdicts.map((v) => ({ sector: v.c.sector, by: v.c.by }))), model: { asked, settled, left: Math.max(0, weak.length - asked) } };
}

/**
 * الغريب عن قائمته يذهب إلى قائمة قطاعه. فندقٌ في قائمة العقارات يستقبل
 * رسالة AML للوسطاء العقاريين — رسالةٌ خاطئة لشركةٍ خاطئة، وأقرب طريقٍ
 * إلى بلاغ. ولا يُنقل إلا من قال اسمه هو (أو قرأه المصنّف) إنه غريب: من
 * ورث قطاعه من الملف لا دليل عليه، فيبقى.
 */
async function fileStrangers(userId: number, groupId: number, listName: string, dominant: string | null): Promise<DeskReport["filed"]> {
  if (!dominant) return [];
  const strangers = await db.select().from(contactsTable)
    .where(and(eq(contactsTable.groupId, groupId), sql`${contactsTable.sector} IS NOT NULL AND ${contactsTable.sector} <> ${dominant} AND ${contactsTable.sectorBy} IN ('own','model')`));
  if (!strangers.length) return [];
  const [parent] = await db.select().from(contactGroupsTable).where(eq(contactGroupsTable.id, groupId)).limit(1);
  const bySector = new Map<string, typeof strangers>();
  for (const s of strangers) (bySector.get(s.sector!) ?? bySector.set(s.sector!, []).get(s.sector!)!).push(s);
  const out: DeskReport["filed"] = [];
  for (const [sector, list] of bySector) {
    const name = `مفروز — ${sector}`;
    let [g] = await db.select().from(contactGroupsTable).where(and(eq(contactGroupsTable.userId, userId), eq(contactGroupsTable.name, name))).limit(1);
    if (!g) [g] = await db.insert(contactGroupsTable).values({ userId, name, description: `فرزها مكتب البيانات: جهاتٌ من قطاع «${sector}» وُجدت في قوائم قطاعٍ آخر — ${BUCKET_AR[bucketOf(sector)].label}`, segment: sector, folderId: null } as any).returning();
    const has = new Set((await db.select({ phone: contactsTable.phone }).from(contactsTable).where(eq(contactsTable.groupId, g!.id))).map((x) => x.phone));
    const move = list.filter((s) => !has.has(s.phone)).map((s) => s.id);
    const drop = list.filter((s) => has.has(s.phone)).map((s) => s.id);
    if (move.length) await db.update(contactsTable).set({ groupId: g!.id }).where(inArray(contactsTable.id, move));
    if (drop.length) await db.delete(contactsTable).where(inArray(contactsTable.id, drop));
    out.push({ sector, moved: list.length, to: name });
  }
  void parent; void listName;
  return out.sort((a, b) => b.moved - a.moved);
}

// ── البريد ────────────────────────────────────────────────────────
async function scopeEmail(userId: number, listId: number | null) {
  return listId
    ? sql`c.user_id = ${userId} AND EXISTS (SELECT 1 FROM email_list_members lm WHERE lm.contact_id = c.id AND lm.list_id = ${listId})`
    : sql`c.user_id = ${userId}`;
}

async function cleanEmailList(userId: number, listId: number | null): Promise<DeskReport["clearance"]> {
  const notes: string[] = [];
  let fixed = 0, removed = 0;
  const where = await scopeEmail(userId, listId);
  const rows = (await db.execute<{ id: number; email: string; name: string | null; status: string; mx_ok: boolean | null }>(sql`SELECT c.id, c.email, c.name, c.status, c.mx_ok FROM email_contacts c WHERE ${where}`)).rows;
  let typos = 0, dead = 0;
  for (const r of rows) {
    if (r.status !== "active") continue;
    const c = cleanEmail(r.email);
    if (c.verdict === "rejected") {
      // لا يُحذف: يُستبعَد، ويبقى في السجل بسببه.
      await db.update(emailContactsTable).set({ status: "suppressed" }).where(eq(emailContactsTable.id, r.id));
      dead++; continue;
    }
    if (c.email && c.email !== r.email) {
      // العنوان المصحَّح قد يكون موجوداً أصلاً — حينها الخطأ نسخةٌ منه، فتُستبعَد.
      const [same] = await db.select({ id: emailContactsTable.id }).from(emailContactsTable).where(and(eq(emailContactsTable.userId, userId), eq(emailContactsTable.email, c.email))).limit(1);
      if (same) await db.update(emailContactsTable).set({ status: "suppressed" }).where(eq(emailContactsTable.id, r.id));
      else await db.update(emailContactsTable).set({ email: c.email, mxOk: null }).where(eq(emailContactsTable.id, r.id));
      typos++;
    }
  }
  if (typos) { fixed += typos; notes.push(`${typos} عنواناً فيه خطأ كتابي في النطاق (gmial.com، .con) صُحّح — كان سيرتدّ`); }
  if (dead) { removed += dead; notes.push(`${dead} عنواناً وهمياً أو مؤقتاً (test@، noreply@) استُبعد`); }
  const junk = rows.filter((r) => r.name && cleanName(r.name) === null).map((r) => r.id);
  if (junk.length) { await db.update(emailContactsTable).set({ name: null }).where(inArray(emailContactsTable.id, junk)); fixed += junk.length; notes.push(`${junk.length} اسماً وهمياً أُفرغ`); }
  const bad = rows.filter((r) => r.mx_ok === false).length, un = rows.filter((r) => r.mx_ok === null && r.status === "active").length;
  if (bad) notes.push(`${bad} عنواناً نطاقه لا يستقبل بريداً — مُستبعَد من كل موجة`);
  if (un) notes.push(`${un} عنواناً لم يُفحص نطاقه بعد — يُفحص قبل أول إرسال`);
  return { checked: rows.length, fixed, removed, notes };
}

async function classifyEmail(userId: number, listId: number | null, listName: string, useModel: boolean): Promise<{ reading: ListReading; model: DeskReport["model"] }> {
  const where = await scopeEmail(userId, listId);
  const rows = (await db.execute<{ id: number; company: string | null; name: string | null; industry: string | null; source: string | null; sector: string | null; sector_by: string | null }>(sql`
    SELECT c.id, c.company, c.name, c.industry, c.source, c.sector, c.sector_by FROM email_contacts c WHERE ${where}`)).rows;
  const verdicts = rows.map((r) => {
    if (r.sector_by === "model" && r.sector) return { r, c: { sector: r.sector, by: "model" as SectorBy | null } };
    const c = classifyRow({ company: r.company, industry: r.industry, hint: [listName, r.source].filter(Boolean).join(" ") });
    // قطاعٌ وضعه صاحب العمل بيده للملف كله يبقى، ويُعلَّم وراثةً ما لم يسنده اسم الجهة.
    if (!c.sector && r.sector) return { r, c: { sector: r.sector, by: "hint" as SectorBy | null } };
    return { r, c: { sector: c.sector, by: c.by } };
  });
  const weak = verdicts.filter((v) => v.c.by !== "own" && v.c.by !== "model" && cleanName(v.r.company));
  let settled = 0, asked = 0;
  if (useModel && weak.length) {
    const names = weak.slice(0, BATCH * MAX_BATCHES).map((v) => v.r.company!);
    asked = names.length;
    const ans = await askModel(userId, DESK_ROLES.email.classifier, names);
    ans.forEach((sector, i) => { if (sector) { weak[i]!.c = { sector, by: "model" }; settled++; } });
  }
  const groups = new Map<string, number[]>();
  for (const v of verdicts) {
    if (v.r.sector === v.c.sector && v.r.sector_by === v.c.by) continue;
    const k = `${v.c.sector ?? ""}|${v.c.by ?? ""}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(v.r.id);
  }
  for (const [k, ids] of groups) {
    const [sector, by] = k.split("|");
    for (let i = 0; i < ids.length; i += 1000) {
      await db.update(emailContactsTable).set({ sector: sector || null, sectorBy: by || null }).where(inArray(emailContactsTable.id, ids.slice(i, i + 1000)));
    }
  }
  return { reading: readList(verdicts.map((v) => ({ sector: v.c.sector, by: v.c.by }))), model: { asked, settled, left: Math.max(0, weak.length - asked) } };
}

// ── الجولة ────────────────────────────────────────────────────────
function headlineOf(r: Omit<DeskReport, "headline">): string {
  const b = r.reading.byBucket, t = r.reading.total || 1;
  const go = b.aml + b.both + b.services;
  const parts = [
    `${r.reading.total} جهة: ${go} تدخل الموجات (${b.aml + b.both} AML${b.services ? `، ${b.services} محاسبة` : ""})`,
    b.secondary ? `${b.secondary} ثانوية محفوظة` : "", b.competitor ? `${b.competitor} منافسون` : "",
    r.reading.unknown ? `${r.reading.unknown} لم تُعرف` : "",
  ].filter(Boolean).join(" · ");
  const weak = r.reading.byHintOnly ? ` — و${r.reading.byHintOnly} (${Math.round((r.reading.byHintOnly / t) * 100)}٪) قطاعها موروثٌ من اسم الملف لا من اسمها.` : ".";
  return parts + weak;
}

export async function runDesk(userId: number, opts: { channel: Channel; listId: number | null; trigger?: "upload" | "manager" | "owner"; intake?: Record<string, number> | null; model?: boolean; file?: boolean }): Promise<DeskReport> {
  const roles = DESK_ROLES[opts.channel];
  const useModel = opts.model !== false;
  let listName = "كل الجهات";
  if (opts.listId) {
    if (opts.channel === "whatsapp") {
      const [g] = await db.select().from(contactGroupsTable).where(and(eq(contactGroupsTable.id, opts.listId), eq(contactGroupsTable.userId, userId))).limit(1);
      if (!g) throw new Error("القائمة غير موجودة");
      listName = g.name;
    } else {
      const [l] = await db.select().from(emailListsTable).where(and(eq(emailListsTable.id, opts.listId), eq(emailListsTable.userId, userId))).limit(1);
      if (!l) throw new Error("القائمة غير موجودة");
      listName = l.name;
    }
  }

  // ١ · المنظِّف
  const clearance = opts.channel === "whatsapp" ? await cleanWa(userId, opts.listId!) : await cleanEmailList(userId, opts.listId);
  receipt({ userId, node: roles.cleaner, graph: opts.channel, action: "data.clean", subject: listName, evidence: { ...clearance, notes: undefined }, why: clearance.notes.join(" · ").slice(0, 600) || `فحص ${clearance.checked} — لا شيء يُصلَح` });
  await say({ userId, fromRole: roles.cleaner, toRole: roles.classifier, kind: "handoff",
    body: `نظّفتُ «${listName}»: فحصتُ ${clearance.checked}، أصلحتُ ${clearance.fixed}، أخرجتُ ${clearance.removed}.${clearance.notes.length ? ` ${clearance.notes.slice(0, 3).join("؛ ")}.` : " لا شيء يحتاج إصلاحاً."} هي لكِ للتصنيف.` });

  // ٢ · المصنِّف
  const { reading, model } = opts.channel === "whatsapp"
    ? await classifyWa(userId, opts.listId!, listName, useModel)
    : await classifyEmail(userId, opts.listId, listName, useModel);

  // ٣ · الفرز — للواتساب، حيث القائمة هي ما تُرسَل إليه الحملة. البريد يُفرَز بالقطاع عند كل موجة.
  //
  // ولا يُنقل آلياً إلا من ملفٍ **مخلوط**: قائمةٌ لا يبلغ قطاعها الغالب
  // ستين بالمئة ليست قائمة قطاع، ففرزها هو المطلوب. أما قائمةٌ لها هوية
  // — سجلّ وسطاء عقاريين مثلاً — فمصدرها أقوى من اسمٍ فيه كلمة
  // «Management»، ونقل «غربائها» آلياً يُخرج وسطاء حقيقيين من قائمتهم.
  // فهؤلاء يُعرضون بعددهم، ويُنقلون بضغطة صاحب العمل.
  const known = reading.total - reading.unknown;
  const mixed = known >= 30 && !!reading.dominant && (reading.bySector[0]!.n / known) < 0.6;
  const doFile = opts.channel === "whatsapp" && (opts.file === true || (opts.file !== false && mixed));
  const filed = doFile ? await fileStrangers(userId, opts.listId!, listName, reading.dominant) : [];

  const base = { channel: opts.channel, listId: opts.listId, listName, intake: opts.intake ?? null, clearance, reading, model, filed };
  const report: DeskReport = { ...base, headline: headlineOf(base) };

  receipt({ userId, node: roles.classifier, graph: opts.channel, action: "data.classify", subject: listName,
    evidence: { total: reading.total, byBucket: reading.byBucket, byHintOnly: reading.byHintOnly, model, filed: filed.length }, why: report.headline.slice(0, 600) });
  await say({ userId, fromRole: roles.classifier, toRole: roles.manager, kind: "report",
    body: [
      `صنّفتُ «${listName}» — ${report.headline}`,
      reading.bySector.slice(0, 4).map((s) => `${s.sector} ${s.n}`).join("، "),
      model.asked ? `قرأتُ ${model.asked} اسماً لم تحسمه القواعد وحسمتُ ${model.settled}${model.left ? `، وبقي ${model.left} للجولة القادمة` : ""}.` : "",
      filed.length ? `نقلتُ الغرباء إلى قوائم قطاعاتهم: ${filed.map((f) => `${f.moved} إلى «${f.to}»`).join("، ")}.` : "",
      !filed.length && opts.channel === "whatsapp" && reading.strangers ? `فيها ${reading.strangers} جهة اسمها يقول إنها من قطاعٍ آخر — لم أنقلها: للقائمة هوية واضحة، والنقل بيد صاحب العمل.` : "",
      reading.unknown > reading.total * 0.2 ? `تنبيه: ${reading.unknown} جهة لا يُعرف نشاطها — الملف بلا عمود نشاط وأسماؤه لا تدلّ.` : "",
    ].filter(Boolean).join(" ") });

  await db.execute(sql`INSERT INTO data_desk_runs (user_id, channel, list_id, list_name, trigger, report) VALUES (${userId}, ${opts.channel}, ${opts.listId}, ${listName.slice(0, 200)}, ${opts.trigger ?? "owner"}, ${JSON.stringify(report)}::jsonb)`);
  logger.info({ userId, channel: opts.channel, listId: opts.listId, total: reading.total, unknown: reading.unknown, filed: filed.length }, "جولة مكتب البيانات");
  // ما فرزه المكتب يدخل مجلد قطاعه فوراً، لا بعد عشر دقائق.
  await organizeAccount(userId).catch(() => []);
  if (opts.channel === "whatsapp") await fileUnfiledLists(userId).catch(() => []);
  return report;
}

/** كل قوائم القناة — جولة المدير. النموذج يُستدعى لما لم يُصنَّف بعد فقط. */
export async function runDeskAll(userId: number, channel: Channel, trigger: "manager" | "owner" = "manager"): Promise<DeskReport[]> {
  const out: DeskReport[] = [];
  if (channel === "whatsapp") {
    const groups = await db.select({ id: contactGroupsTable.id, name: contactGroupsTable.name }).from(contactGroupsTable).where(eq(contactGroupsTable.userId, userId));
    for (const g of groups) {
      if (g.name.startsWith("مفروز — ")) continue;   // ما فرزه المكتب لا يُعاد فرزه
      if ((g as any).description?.startsWith?.(AUTOPILOT_MARK)) continue;   // قائمة الطيار تجربةٌ مقصودة
      out.push(await runDesk(userId, { channel, listId: g.id, trigger }).catch((err) => { logger.warn({ err: String(err?.message ?? err), list: g.name }, "desk failed"); return null as any; }));
    }
  } else {
    out.push(await runDesk(userId, { channel, listId: null, trigger }));
  }
  return out.filter(Boolean);
}

/** صورة المكتب للواجهة: أين الداتا الآن في القناتين، وآخر الجولات — بلا نموذج. */
export async function deskOverview(userId: number) {
  const [wa, em, runs] = await Promise.all([
    db.execute<{ sector: string | null; by: string | null; n: number }>(sql`
      SELECT c.sector, c.sector_by AS by, count(*)::int AS n FROM contacts c JOIN contact_groups g ON g.id = c.group_id
      WHERE g.user_id = ${userId} GROUP BY 1, 2`),
    db.execute<{ sector: string | null; by: string | null; n: number }>(sql`
      SELECT sector, sector_by AS by, count(*)::int AS n FROM email_contacts WHERE user_id = ${userId} GROUP BY 1, 2`),
    db.execute<any>(sql`SELECT id, channel, list_id AS "listId", list_name AS "listName", trigger, report, created_at AS at FROM data_desk_runs WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 20`),
  ]);
  const shape = (rows: Array<{ sector: string | null; by: string | null; n: number }>) => {
    const flat: Array<{ sector: string | null; by: SectorBy | null }> = [];
    for (const r of rows) for (let i = 0; i < Number(r.n); i++) flat.push({ sector: r.sector, by: (r.by as SectorBy | null) ?? (r.sector ? "hint" : null) });
    const reading = readList(flat);
    const unclassified = rows.filter((r) => r.sector && !r.by).reduce((n, r) => n + Number(r.n), 0);
    return { reading, neverRun: unclassified, sendable: Object.entries(reading.byBucket).filter(([b]) => sendable(b as any)).reduce((n, [, v]) => n + v, 0) };
  };
  return { whatsapp: shape(wa.rows), email: shape(em.rows), runs: runs.rows, roles: DESK_ROLES, buckets: BUCKET_AR };
}

void isNull; void emailListMembersTable;
