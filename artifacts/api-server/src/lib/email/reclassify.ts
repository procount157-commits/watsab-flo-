// ── تصحيح ما مضى ──────────────────────────────────────────────────
// الصندوق يحمل أحكام المصنّف القديم: إعلاناتٌ «مهتمة»، وردودٌ آلية
// «تحيات»، وردٌّ حقيقيٌّ واحد «غير واضح». إصلاح المصنّف لا يُصلح ما
// سُجّل قبله، فهذه تمرّ على الصفوف القديمة وتُعيد الحكم عليها.
//
// لا تُرسل شيئاً ولا تُنشئ صفقةً ولا تُشعِر أحداً: تصحيحُ سجلٍّ فقط.
// وما تغيّر حكمه إلى «ليس رداً» يُنقل إلى «ignored» ليخرج من الصندوق،
// وجهةُ اتصالٍ أُنشئت من إعلانٍ تُعطَّل كي لا تستقبل حملاتنا.

import { and, eq, sql } from "drizzle-orm";
import { db, emailInboundTable, emailContactsTable, emailSettingsTable } from "@workspace/db";
import { classifyMail, mayBecomeLead, KIND_AR } from "./classify";
import { logger } from "../logger";

export interface ReclassifyResult {
  scanned: number;
  changed: number;
  byKind: Record<string, number>;
  demotedContacts: number;
  samples: Array<{ id: number; from: string; subject: string; was: string; now: string; why: string }>;
}

export async function reclassifyInbox(userId: number, opts: { dryRun?: boolean; limit?: number } = {}): Promise<ReclassifyResult> {
  const [s] = await db.select({ fromEmail: emailSettingsTable.fromEmail }).from(emailSettingsTable).where(eq(emailSettingsTable.userId, userId)).limit(1);
  const rows = await db.select().from(emailInboundTable)
    .where(eq(emailInboundTable.userId, userId))
    .orderBy(sql`${emailInboundTable.id} desc`).limit(opts.limit ?? 2_000);

  const out: ReclassifyResult = { scanned: 0, changed: 0, byKind: {}, demotedContacts: 0, samples: [] };
  const pitchContacts = new Set<number>();

  for (const r of rows) {
    out.scanned++;
    const v = await classifyMail(userId, {
      from: r.fromEmail, subject: r.subject, text: r.text, raw: r.text,
      headers: null, inReplyTo: r.inReplyTo, ourEmail: s?.fromEmail ?? null,
    });
    out.byKind[v.kind] = (out.byKind[v.kind] ?? 0) + 1;
    const was = `${r.kind ?? "—"}/${r.intent ?? "—"}`, now = `${v.kind}/${v.intent ?? "—"}`;
    if (was === now) continue;
    out.changed++;
    if (out.samples.length < 30) out.samples.push({ id: r.id, from: r.fromEmail, subject: (r.subject ?? "").slice(0, 70), was, now: `${KIND_AR[v.kind]}${v.intent ? ` / ${v.intent}` : ""}`, why: v.reasons[0] ?? "" });

    if (!opts.dryRun) {
      await db.update(emailInboundTable).set({
        kind: v.kind, solicited: v.solicited, confidence: v.confidence,
        reasons: v.reasons, classifier: v.classifier, intent: v.intent,
        // ما ليس رداً يخرج من الصندوق — إلا ما ردّ عليه شخصٌ فعلاً.
        state: mayBecomeLead(v.kind) ? r.state : (r.state === "sent" ? "sent" : "ignored"),
      }).where(eq(emailInboundTable.id, r.id));
    }
    // جهةُ اتصالٍ لا مصدرَ لها إلا رسالةٌ ليست رداً: أُنشئت خطأً.
    if (!mayBecomeLead(v.kind) && r.contactId) pitchContacts.add(r.contactId);
  }

  // تُعطَّل فقط إن كان كل ما يُعرَف عنها أنها كتبت إلينا — لا إن كانت
  // من ملفٍ رفعه صاحب العمل، فتلك جهةٌ مقصودة.
  for (const id of pitchContacts) {
    const [c] = await db.select({ source: emailContactsTable.source, status: emailContactsTable.status })
      .from(emailContactsTable).where(and(eq(emailContactsTable.id, id), eq(emailContactsTable.userId, userId))).limit(1);
    if (!c || c.source !== "inbound" || c.status !== "active") continue;
    const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(emailInboundTable)
      .where(and(eq(emailInboundTable.contactId, id), eq(emailInboundTable.kind, "reply")));
    if (Number(n) > 0) continue;   // ردّ مرةً على الأقل — تبقى
    if (!opts.dryRun) {
      await db.update(emailContactsTable).set({ status: "suppressed" }).where(eq(emailContactsTable.id, id));
    }
    out.demotedContacts++;
  }

  logger.info({ userId, ...out, samples: undefined }, opts.dryRun ? "تجربة إعادة تصنيف الوارد" : "أُعيد تصنيف الوارد");
  return out;
}
