// ── Monitoring agent ──────────────────────────────────────────────
// Runs every 20 minutes and answers, per account: is WhatsApp actually
// working, is the number at risk, is the bot replying, and is the process
// healthy. Findings are written as sentences with an action, because a
// dashboard of numbers is something you have to remember to read.
//
// The connection check exists because "connected" is not the same as
// "receiving". A half-dead linked device keeps emitting connection updates
// and delivery receipts while WhatsApp has quietly stopped routing inbound
// messages to it — it sends fine, so nothing looks wrong until someone
// notices the replies stopped. Inbound silence is the only signal that
// separates the two, and it is the check that matters most here.

import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import {
  db, monitorReportsTable, usersTable, waAuthStateTable,
  messageLogs, campaignsTable, unsubscribedPhonesTable,
  businessProfileTable, autoReplyLogTable, knowledgeBaseTable,
  type MonitorFinding,
} from "@workspace/db";
import { waManager } from "./whatsapp";
import { assessAccountHealth } from "./delivery-health";
import { getDailySentCount, getEffectiveDailyLimit } from "./daily-limit";
import { logger } from "./logger";
import { runAs } from "./org/runtime";
import { everyMs } from "./org/workers";

export const MONITOR_INTERVAL_MS = 20 * 60_000;

// A quiet number is normal; a number that has not received anything in hours
// while connected is not. Set well above a plausible quiet spell so it does
// not cry wolf overnight.
const INBOUND_SILENCE_WARN_MIN  = 180;
const INBOUND_SILENCE_ALARM_MIN = 360;
// No socket events at all for this long means the socket itself is inert.
const EVENT_SILENCE_ALARM_MIN   = 45;

const RSS_WARN_MB = 1_100;

const worst = (a: MonitorFinding["level"], b: MonitorFinding["level"]) =>
  a === "critical" || b === "critical" ? "critical"
  : a === "warning" || b === "warning" ? "warning" : "ok";

const minsSince = (d: string | Date | null | undefined) =>
  d ? Math.round((Date.now() - new Date(d).getTime()) / 60_000) : null;

// ── Connection ────────────────────────────────────────────────────
function checkConnection(userId: number): { findings: MonitorFinding[]; metrics: Record<string, unknown> } {
  const findings: MonitorFinding[] = [];
  const health = waManager.allStates().find((s) => s.userId === userId)
    ? (waManager.get(userId).getHealth() as any)
    : null;

  if (!health) {
    return {
      findings: [{ area: "connection", level: "critical", message: "لا توجد جلسة واتساب محمّلة لهذا الحساب.", action: "افتح صفحة ربط الواتساب وامسح رمز QR." }],
      metrics: { connected: false },
    };
  }

  const inboundAge = minsSince(health.lastInboundAt);
  const eventAge   = minsSince(health.lastEventAt);
  const metrics = {
    connected: !!health.connected,
    status: health.status,
    uptimeMinutes: health.uptimeSeconds ? Math.round(health.uptimeSeconds / 60) : null,
    reconnectCount: health.reconnectCount ?? 0,
    lastInboundMinutesAgo: inboundAge,
    lastEventMinutesAgo: eventAge,
    consecutiveSendFailures: health.consecutiveSendFailures ?? 0,
  };

  if (health.awaitingRescanSince) {
    const mins = minsSince(health.awaitingRescanSince) ?? 0;
    findings.push({
      area: "connection", level: "critical",
      message: `واتساب رفض الاعتمادات ومُسحت تلقائياً قبل ${mins} دقيقة. الجلسة تنتظر مسح رمز جديد.`,
      action: "افتح صفحة ربط الواتساب وامسح رمز QR — لن يعود للعمل قبل ذلك.",
    });
    return { findings, metrics: { ...metrics, awaitingRescan: true } };
  }

  if (!health.connected) {
    findings.push({ area: "connection", level: "critical", message: `واتساب غير متصل (الحالة: ${health.status}).`, action: "افتح صفحة ربط الواتساب — إن استمر، أعد تعيين الجلسة وامسح QR جديداً." });
    return { findings, metrics };
  }

  // Connected. Now: is it actually receiving?
  if (eventAge !== null && eventAge >= EVENT_SILENCE_ALARM_MIN) {
    findings.push({
      area: "connection", level: "critical",
      message: `الجلسة تقول «متصل» لكنها لم تستقبل أي حدث منذ ${eventAge} دقيقة — سوكت معطّل.`,
      action: "أعد تعيين الجلسة وامسح QR جديداً.",
    });
  } else if (inboundAge === null) {
    findings.push({
      area: "connection", level: "warning",
      message: "لم تصل أي رسالة واردة منذ تشغيل الخادم — لم نتحقق بعد أن الاستقبال يعمل.",
      action: "أرسل رسالة اختبار من رقم آخر للتأكد.",
    });
  } else if (inboundAge >= INBOUND_SILENCE_ALARM_MIN) {
    findings.push({
      area: "connection", level: "critical",
      message: `الجهاز متصل ويُرسل، لكن لم تصله رسالة واردة منذ ${Math.round(inboundAge / 60)} ساعة. هذا نمط جهاز مرتبط فقد تسجيله.`,
      action: "أعد تعيين الجلسة وامسح QR جديداً — الإرسال وحده لا يعني أن الاستقبال يعمل.",
    });
  } else if (inboundAge >= INBOUND_SILENCE_WARN_MIN) {
    findings.push({
      area: "connection", level: "warning",
      message: `لم تصل رسالة واردة منذ ${Math.round(inboundAge / 60)} ساعة. قد يكون هدوءاً طبيعياً.`,
      action: "إن توقّع وصول رسائل، أرسل اختباراً من رقم آخر.",
    });
  }

  if ((health.consecutiveSendFailures ?? 0) >= 3) {
    findings.push({ area: "connection", level: "critical", message: `فشل آخر ${health.consecutiveSendFailures} محاولات إرسال متتالية.`, action: "أعد تعيين الجلسة." });
  }
  if ((health.reconnectCount ?? 0) >= 10) {
    findings.push({ area: "connection", level: "warning", message: `الجلسة أعادت الاتصال ${health.reconnectCount} مرة — تذبذب غير طبيعي.`, action: "راقبها؛ التذبذب المتكرر يسبق فقدان التسجيل عادةً." });
  }

  if (findings.length === 0) {
    findings.push({ area: "connection", level: "ok", message: `متصل منذ ${metrics.uptimeMinutes} دقيقة، وآخر رسالة واردة قبل ${inboundAge} دقيقة.` });
  }
  return { findings, metrics };
}

// ── Ban risk ──────────────────────────────────────────────────────
async function checkBanRisk(userId: number) {
  const findings: MonitorFinding[] = [];
  const since24 = new Date(Date.now() - 24 * 60 * 60_000);

  const [account, [sendStats], [optOuts], used, limit] = await Promise.all([
    assessAccountHealth(userId),
    db.select({
      sent:   sql<number>`count(*) filter (where ${messageLogs.status} = 'sent')`,
      failed: sql<number>`count(*) filter (where ${messageLogs.status} = 'failed')`,
    }).from(messageLogs)
      .innerJoin(campaignsTable, eq(messageLogs.campaignId, campaignsTable.id))
      .where(and(eq(campaignsTable.userId, userId), gte(messageLogs.createdAt, since24))),
    db.select({ n: count() }).from(unsubscribedPhonesTable)
      .where(and(eq(unsubscribedPhonesTable.userId, userId), gte(unsubscribedPhonesTable.createdAt, since24))),
    getDailySentCount(userId),
    getEffectiveDailyLimit(userId),
  ]);

  const sent = Number(sendStats?.sent ?? 0);
  const failed = Number(sendStats?.failed ?? 0);
  const attempted = sent + failed;
  const failRate = attempted > 0 ? failed / attempted : 0;
  const newOptOuts = Number(optOuts?.n ?? 0);
  const optOutRate = sent > 0 ? newOptOuts / sent : 0;

  const metrics = {
    deliveryRate: account.level === "insufficient_data" ? null : Math.round(account.deliveryRate * 100),
    deliverySample: account.sample,
    sent24h: sent, failed24h: failed,
    failureRate: Math.round(failRate * 100),
    newOptOuts24h: newOptOuts,
    optOutRate: Math.round(optOutRate * 100),
    dailyUsed: used, dailyLimit: limit,
  };

  if (account.shouldHalt) {
    findings.push({ area: "ban_risk", level: "critical", message: account.reason ?? "انهيار في التسليم على مستوى الرقم.", action: "أوقف كل الحملات وراجع مصدر الأرقام قبل الاستئناف." });
  } else if (account.level === "degraded") {
    findings.push({ area: "ban_risk", level: "warning", message: account.reason ?? "تسليم الرقم منخفض.", action: "خفّف الإرسال وراجع جودة القائمة." });
  }

  if (attempted >= 20 && failRate >= 0.25) {
    findings.push({ area: "ban_risk", level: failRate >= 0.4 ? "critical" : "warning", message: `نسبة فشل الإرسال ${Math.round(failRate * 100)}% خلال 24 ساعة (${failed} من ${attempted}).`, action: "نظّف القائمة عبر «فحص الأرقام» — الأرقام الميتة ترفع هذه النسبة وتُغذّي مؤشر الحظر." });
  }

  // The strongest single predictor, and the one people watch least.
  if (sent >= 30 && optOutRate >= 0.03) {
    findings.push({ area: "ban_risk", level: optOutRate >= 0.06 ? "critical" : "warning", message: `${newOptOuts} شخصاً ألغوا الاشتراك خلال 24 ساعة (${Math.round(optOutRate * 100)}% ممن وصلتهم).`, action: "هذا أقوى مؤشر على أن القائمة غير راغبة. أوقف الحملة وراجع مصدر الأرقام — الإيقاع لن ينقذك هنا." });
  }

  if (limit > 0 && used / limit >= 0.9) {
    findings.push({ area: "ban_risk", level: "warning", message: `استهلكت ${used} من حصة ${limit} اليومية (${Math.round((used / limit) * 100)}%).`, action: "الحصة تُقيّد الحملات والمتابعات معاً — ما تبقّى لن يكفي لكليهما." });
  }

  if (findings.length === 0) {
    findings.push({ area: "ban_risk", level: "ok", message: metrics.deliveryRate !== null ? `التسليم ${metrics.deliveryRate}% والفشل ${metrics.failureRate}% — ضمن الطبيعي.` : "لا يوجد إرسال كافٍ للحكم بعد." });
  }
  return { findings, metrics };
}

// ── Bot replies ───────────────────────────────────────────────────
async function checkReplies(userId: number) {
  const findings: MonitorFinding[] = [];
  const since = new Date(Date.now() - 24 * 60 * 60_000);

  const [[profile], [kb], [replyStats], skipReasons] = await Promise.all([
    db.select().from(businessProfileTable).where(eq(businessProfileTable.userId, userId)),
    db.select({ n: count() }).from(knowledgeBaseTable).where(and(eq(knowledgeBaseTable.userId, userId), eq(knowledgeBaseTable.isActive, true))),
    db.select({
      replied: sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is not null)`,
      skipped: sql<number>`count(*) filter (where ${autoReplyLogTable.reply} is null)`,
    }).from(autoReplyLogTable).where(and(eq(autoReplyLogTable.userId, userId), gte(autoReplyLogTable.createdAt, since))),
    db.select({ reason: autoReplyLogTable.skipped, n: sql<number>`count(*)` })
      .from(autoReplyLogTable)
      .where(and(eq(autoReplyLogTable.userId, userId), gte(autoReplyLogTable.createdAt, since), isNotNull(autoReplyLogTable.skipped)))
      .groupBy(autoReplyLogTable.skipped).orderBy(desc(sql`count(*)`)).limit(3),
  ]);

  const replied = Number(replyStats?.replied ?? 0);
  const skipped = Number(replyStats?.skipped ?? 0);
  const kbCount = Number(kb?.n ?? 0);
  const metrics = { autoReplyEnabled: !!profile?.autoReply, knowledgeEntries: kbCount, replied24h: replied, skipped24h: skipped };

  if (!profile?.autoReply) {
    findings.push({ area: "replies", level: "ok", message: "الرد التلقائي مُطفأ — لا يُفترض أن يرد." });
    return { findings, metrics };
  }
  if (kbCount === 0) {
    findings.push({ area: "replies", level: "critical", message: "الرد التلقائي مُفعّل لكن قاعدة المعرفة فارغة — سيصمت أمام كل سؤال.", action: "أضف معلوماتك من صفحة «معرفة البوت»." });
    return { findings, metrics };
  }

  // Skips that mean a knowledge gap, not a guard doing its job.
  const gaps = skipReasons.filter((r) => /لا توجد معلومة|تطابق ضعيف/.test(r.reason ?? ""));
  const gapCount = gaps.reduce((n, r) => n + Number(r.n), 0);
  if (gapCount > 0 && gapCount >= replied) {
    findings.push({ area: "replies", level: "warning", message: `صمت أمام ${gapCount} سؤالاً لعدم وجود معلومة مطابقة، مقابل ${replied} رداً.`, action: "افتح سجل الردود وأضف عناصر تغطي ما يُسأل عنه فعلاً." });
  }
  if (replied + skipped === 0) {
    findings.push({ area: "replies", level: "ok", message: "لم تصل أسئلة خلال 24 ساعة." });
  } else if (findings.length === 0) {
    findings.push({ area: "replies", level: "ok", message: `ردّ على ${replied} وصمت عن ${skipped} خلال 24 ساعة.` });
  }
  return { findings, metrics };
}

// ── Resources ─────────────────────────────────────────────────────
function checkResources() {
  const findings: MonitorFinding[] = [];
  const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const uptimeMin = Math.round(process.uptime() / 60);

  if (rssMb >= RSS_WARN_MB) {
    findings.push({ area: "resources", level: "warning", message: `استهلاك الذاكرة ${rssMb}MB — مرتفع.`, action: "أعد تشغيل الخدمة في وقت هادئ؛ جلسات واتساب تتراكم في الذاكرة مع طول التشغيل." });
  } else {
    findings.push({ area: "resources", level: "ok", message: `الذاكرة ${rssMb}MB والخدمة تعمل منذ ${uptimeMin} دقيقة.` });
  }
  return { findings, metrics: { rssMb, uptimeMinutes: uptimeMin } };
}

// ── One run ───────────────────────────────────────────────────────
export async function runMonitorFor(userId: number) {
  const conn = checkConnection(userId);
  const [ban, replies] = await Promise.all([checkBanRisk(userId), checkReplies(userId)]);
  const res = checkResources();

  const findings = [...conn.findings, ...ban.findings, ...replies.findings, ...res.findings];
  const level = findings.reduce<MonitorFinding["level"]>((acc, f) => worst(acc, f.level), "ok");

  const problems = findings.filter((f) => f.level !== "ok");
  const summary = problems.length === 0
    ? "كل شيء سليم: الاتصال يستقبل، ومؤشرات الحظر ضمن الطبيعي."
    : problems.map((f) => f.message).join(" · ");

  const [row] = await db.insert(monitorReportsTable).values({
    userId, level, summary,
    findings: findings as any,
    metrics: { ...conn.metrics, ...ban.metrics, ...replies.metrics, ...res.metrics } as any,
  }).returning();

  if (level !== "ok") {
    logger.warn({ userId, level, problems: problems.map((p) => p.message) }, "monitor: issues found");
  } else {
    logger.info({ userId }, "monitor: all clear");
  }
  return row;
}

/** Every account that has ever linked WhatsApp — the ones worth watching. */
async function watchedUsers(): Promise<number[]> {
  const rows = await db.selectDistinct({ id: waAuthStateTable.userId }).from(waAuthStateTable);
  if (rows.length > 0) return rows.map((r) => r.id);
  const all = await db.select({ id: usersTable.id }).from(usersTable).limit(50);
  return all.map((r) => r.id);
}

export async function runMonitorSweep() {
  for (const userId of await watchedUsers()) {
    await runAs(userId, "monitor", { kind: "monitor_sweep", respect: "none" }, () => runMonitorFor(userId)).catch((err) => logger.warn({ err, userId }, "monitor run failed"));
  }
}

let timer: NodeJS.Timeout | null = null;

export function startMonitorAgent() {
  if (timer) return;
  // First pass shortly after boot, so a restart is visible in the record
  // rather than leaving a twenty-minute hole.
  timer = everyMs("ops.monitor", MONITOR_INTERVAL_MS, runMonitorSweep, { firstMs: 90_000 });
  logger.info({ intervalMinutes: MONITOR_INTERVAL_MS / 60_000 }, "monitor agent started");
}

export async function latestReports(userId: number, limit = 20) {
  return db.select().from(monitorReportsTable)
    .where(eq(monitorReportsTable.userId, userId))
    .orderBy(desc(monitorReportsTable.createdAt)).limit(limit);
}
