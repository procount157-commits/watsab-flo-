// ── Why this campaign cannot be published ─────────────────────────
// Publishing threw one terse sentence after the click — "the campaign has no
// list", "email settings incomplete" — and said nothing about the thing that
// stopped it most often, which is that the list exists and nobody in it can be
// written to. The owner's words were: explain to me why I cannot publish.
//
// So the same checks run before the button, every one of them answered with a
// count rather than a verdict, and each blocker carrying the thing to do about
// it. A campaign that *can* go says what will happen if it does — how many
// will receive it, how many are skipped and for which reason — because the
// surprise after sending is as bad as the refusal before it.

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  db, emailCampaignsTable, emailSettingsTable, emailContactsTable,
  emailListMembersTable, emailListsTable, emailSegmentsTable, emailMessagesTable,
} from "@workspace/db";
import { resolve as resolveSegment, describe as describeSegment } from "./segments";
import { isEnglish } from "./language";
import type { SegmentFilter } from "@workspace/db";

export type ReadyCheck = {
  id: string;
  title: string;
  state: "ok" | "warn" | "blocked";
  detail: string;
  fix?: string;
  /** Where the owner goes to fix it. */
  goto?: string;
};

export type Readiness = {
  canPublish: boolean;
  /** One sentence: what happens if they press it, or what stops them. */
  verdict: string;
  willSend: number;
  willSkip: number;
  skipReasons: Array<{ reason: string; n: number }>;
  checks: ReadyCheck[];
};

const ok      = (id: string, title: string, detail: string): ReadyCheck => ({ id, title, state: "ok", detail });
const warn    = (id: string, title: string, detail: string, fix?: string, goto?: string): ReadyCheck => ({ id, title, state: "warn", detail, fix, goto });
const blocked = (id: string, title: string, detail: string, fix?: string, goto?: string): ReadyCheck => ({ id, title, state: "blocked", detail, fix, goto });

/** Text with the tags stripped, for the checks that are about words. */
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export async function campaignReadiness(userId: number, campaignId: number): Promise<Readiness | null> {
  const [c] = await db.select().from(emailCampaignsTable)
    .where(and(eq(emailCampaignsTable.id, campaignId), eq(emailCampaignsTable.userId, userId))).limit(1);
  if (!c) return null;

  const checks: ReadyCheck[] = [];

  // ── Can this account send anything at all ──
  const [s] = await db.select().from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  const configured = !!s && !!s.fromEmail && (s.provider === "smtp" ? !!(s.smtpHost && s.smtpUser && s.smtpPass) : !!s.apiKey);
  checks.push(configured
    ? ok("settings", "إعدادات الإرسال", `${s!.fromName ? `${s!.fromName} ` : ""}<${s!.fromEmail}>`)
    : blocked("settings", "إعدادات الإرسال", "ناقصة — لا يمكن إرسال أي رسالة",
        "أضف خادم الإرسال وعنوان المُرسِل.", "/email/settings"));

  // ── Content ──
  const body = plain(c.html ?? "");
  checks.push(c.subject?.trim()
    ? ok("subject", "العنوان", c.subjectB ? `اختبار عنوانين — «${c.subject}» / «${c.subjectB}»` : `«${c.subject}»`)
    : blocked("subject", "العنوان", "فارغ", "اكتب عنواناً للرسالة."));

  checks.push(
    body.length === 0 ? blocked("body", "نص الرسالة", "فارغ — هذه هي العلة التي جعلت ٢٧٦ رسالة تفشل سابقاً بسبب «بلا محتوى»", "اكتب نص الرسالة.")
    : body.length < 120 ? warn("body", "نص الرسالة", `${body.length} حرفاً فقط — قصيرة لرسالة بيع`, "أضف سبباً يخصّ قطاع المستلم.")
    : ok("body", "نص الرسالة", `${body.length} حرفاً`),
  );

  // The owner's rule: email goes out in English.
  const english = [c.html ?? "", c.subject ?? "", c.subjectB ?? ""].every(isEnglish);
  checks.push(english
    ? ok("language", "اللغة", "إنجليزية")
    : blocked("language", "اللغة", "الرسالة بالعربية — الإيميلات بالإنجليزية فقط", "اكتبها بالإنجليزية، أو دع نورة تعيد كتابتها."));

  // Personalisation is in the doctrine: a message that fits everyone is a
  // message nobody answers.
  const hasVars = /\{\{\s*(company|first_name|name|city|industry)/i.test(c.html ?? "") || /\{\{\s*(company|first_name|name)/i.test(c.subject ?? "");
  checks.push(hasVars
    ? ok("personal", "الشخصنة", "الرسالة تذكر اسم الشركة أو المستلم")
    : warn("personal", "الشخصنة", "لا متغيّرات — الرسالة نفسها تصل للجميع",
        "أضف {{company|شركتكم}} في العنوان أو السطر الأول."));

  // ── Who receives it ──
  let audience: Array<{ id: number; status: string; mxOk: boolean | null }> = [];
  let audienceLabel = "";

  if (c.segmentId) {
    const [seg] = await db.select().from(emailSegmentsTable).where(eq(emailSegmentsTable.id, c.segmentId)).limit(1);
    const f = (seg?.filter ?? {}) as SegmentFilter;
    audienceLabel = describeSegment(f);
    audience = (await resolveSegment(userId, f)).map((x: any) => ({ id: x.id, status: x.status, mxOk: x.mxOk }));
  } else if (c.listId) {
    const [l] = await db.select().from(emailListsTable).where(eq(emailListsTable.id, c.listId)).limit(1);
    audienceLabel = l?.name ?? `قائمة ${c.listId}`;
    audience = await db.select({ id: emailContactsTable.id, status: emailContactsTable.status, mxOk: emailContactsTable.mxOk })
      .from(emailListMembersTable)
      .innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
      .where(eq(emailListMembersTable.listId, c.listId));
  } else {
    checks.push(blocked("audience", "الجمهور", "لم تُختر قائمة ولا شريحة",
      "اختر قائمة أو شريحة للحملة.", "/email/lists"));
  }

  // Already messaged in this campaign: a resume must not write twice.
  const already = new Set((await db.select({ contactId: emailMessagesTable.contactId })
    .from(emailMessagesTable).where(eq(emailMessagesTable.campaignId, c.id)))
    .map((r) => r.contactId).filter((x): x is number => x !== null));

  const skipReasons: Array<{ reason: string; n: number }> = [];
  let willSend = 0;
  if (audience.length) {
    const counts = { unsub: 0, mx: 0, done: 0 };
    for (const a of audience) {
      if (already.has(a.id)) { counts.done++; continue; }
      if (a.status !== "active") { counts.unsub++; continue; }
      if (a.mxOk === false) { counts.mx++; continue; }
      willSend++;
    }
    if (counts.unsub) skipReasons.push({ reason: "ألغوا الاشتراك أو غير نشطين", n: counts.unsub });
    if (counts.mx)    skipReasons.push({ reason: "نطاقهم لا يستقبل بريداً", n: counts.mx });
    if (counts.done)  skipReasons.push({ reason: "أُرسلت لهم هذه الحملة سابقاً", n: counts.done });

    checks.push(
      willSend === 0 ? blocked("audience", "الجمهور", `${audienceLabel} — ${audience.length} جهة، ولا واحدة تصلح للإرسال` +
          (skipReasons.length ? ` (${skipReasons.map((r) => `${r.n} ${r.reason}`).join("، ")})` : ""),
          counts.done === audience.length ? "هذه الحملة وصلت الجميع بالفعل — أنشئ حملة جديدة لجمهور آخر."
            : "ارفع قائمة جديدة أو غيّر جمهور الحملة.", "/email/lists")
      : skipReasons.length ? warn("audience", "الجمهور",
          `${audienceLabel} — ${willSend} ستصلهم من ${audience.length}`,
          `يُتخطّى ${audience.length - willSend}: ${skipReasons.map((r) => `${r.n} ${r.reason}`).join("، ")}`)
      : ok("audience", "الجمهور", `${audienceLabel} — ${willSend} جهة`),
    );
  }

  // ── The daily ceiling ──
  if (s?.dailyCap && willSend > s.dailyCap) {
    checks.push(warn("cap", "الحصة اليومية", `${willSend} رسالة والحد ${s.dailyCap} يومياً`,
      `ستُرسل على ${Math.ceil(willSend / s.dailyCap)} أيام — هذا طبيعي ومقصود لحماية النطاق.`));
  }

  // ── The status it is in ──
  if (c.status === "sending") {
    checks.push(warn("status", "الحالة", "هذه الحملة تُرسل الآن", "لا حاجة لنشرها مرة أخرى."));
  } else if (c.status === "completed") {
    checks.push(warn("status", "الحالة", "اكتملت", "أنشئ حملة جديدة بدل إعادة نشر هذه."));
  } else if (c.status === "paused" && c.pauseReason) {
    checks.push(warn("status", "الحالة", `موقوفة: ${c.pauseReason}`));
  }

  const blockers = checks.filter((x) => x.state === "blocked");
  const canPublish = blockers.length === 0 && willSend > 0;
  const verdict = blockers.length
    ? `لا يمكن النشر — ${blockers.map((b) => b.title).join("، ")}.`
    : willSend === 0
      ? "لا يمكن النشر — لا أحد يصلح للإرسال في هذا الجمهور."
      : `جاهزة — ستصل ${willSend} شركة` +
        (skipReasons.length ? `، ويُتخطّى ${audience.length - willSend}.` : ".");

  return { canPublish, verdict, willSend, willSkip: audience.length - willSend, skipReasons, checks };
}
