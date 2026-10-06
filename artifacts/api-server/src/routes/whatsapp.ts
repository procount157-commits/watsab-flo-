import { Router } from "express";
import { eq, desc, sql, and, asc } from "drizzle-orm";
import { db, waSessionEventsTable, contactGroupsTable, contactsTable, incomingMessagesTable, waContactsTable, waConversationsTable, waThreadMessagesTable, waSyncStateTable } from "@workspace/db";
import { getStatus, getQr, getHealth, getSyncStats, logout, initWhatsApp, forceResync, extractPhones, extractContacts, sendMessage, sendVoiceNote, resetSession, autoHeal, requestPairingCode } from "../lib/whatsapp";
import { requireAuth } from "../lib/auth";
import { takeover } from "../lib/lead-card";

const router = Router();
router.use(requireAuth);

router.get("/status", (req, res) => {
  res.json(getStatus(req.session.userId!));
});

router.get("/qr", (req, res) => {
  res.json(getQr(req.session.userId!));
});

router.get("/health", async (req, res) => {
  const userId = req.session.userId!;
  const health = getHealth(userId);

  const [recentEvents, firstConnRow] = await Promise.all([
    db
      .select({
        id:        waSessionEventsTable.id,
        event:     waSessionEventsTable.event,
        detail:    waSessionEventsTable.detail,
        createdAt: waSessionEventsTable.createdAt,
      })
      .from(waSessionEventsTable)
      .where(eq(waSessionEventsTable.userId, userId))
      .orderBy(desc(waSessionEventsTable.createdAt))
      .limit(20),
    db
      .select({ createdAt: waSessionEventsTable.createdAt })
      .from(waSessionEventsTable)
      .where(and(
        eq(waSessionEventsTable.userId, userId),
        eq(waSessionEventsTable.event, "connected"),
      ))
      .orderBy(asc(waSessionEventsTable.createdAt))
      .limit(1),
  ]);

  const WARMUP_DAY0  = 50;
  const WARMUP_GROW  = 1.30;
  const WARMUP_MAX   = 1_500;
  const SEND_START_H = 8;
  const SEND_END_H   = 22;

  let warmupDays     = 0;
  let warmupLimit    = WARMUP_DAY0;
  let firstConnected: string | null = null;

  if (firstConnRow[0]) {
    firstConnected = new Date(firstConnRow[0].createdAt).toISOString();
    warmupDays     = Math.floor((Date.now() - new Date(firstConnRow[0].createdAt).getTime()) / (24 * 60 * 60 * 1_000));
    warmupLimit    = Math.min(WARMUP_MAX, Math.round(WARMUP_DAY0 * Math.pow(WARMUP_GROW, warmupDays)));
  }

  const nowHour       = new Date().getHours();
  const inSendingHours = nowHour >= SEND_START_H && nowHour < SEND_END_H;

  res.json({
    ...health,
    recentEvents,
    warmup: {
      daysConnected:   warmupDays,
      dailyLimit:      warmupLimit,
      maxLimit:        WARMUP_MAX,
      firstConnected,
      inSendingHours,
      sendWindowStart: SEND_START_H,
      sendWindowEnd:   SEND_END_H,
    },
  });
});

router.post("/connect", async (req, res) => {
  await initWhatsApp(req.session.userId!);
  res.json({ success: true, message: "Connecting..." });
});

// ── Pairing code (alternative to QR scan) ───────────────────────────
// Returns an 8-char code the user enters in WhatsApp:
//   Settings → Linked Devices → Link Device → "Link with phone number"
router.post("/pairing-code", async (req, res) => {
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) { res.status(400).json({ error: "phoneNumber مطلوب" }); return; }
  try {
    const code = await requestPairingCode(req.session.userId!, phoneNumber);
    res.json({ code });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "فشل توليد رمز الربط" });
  }
});

// ── Auto-heal: diagnoses + fixes the connection automatically ─────────
// - connected          → no-op, returns current status
// - connecting/reconn  → no-op (already in progress)
// - qr_ready           → tells client to show QR (can't auto-fix, needs scan)
// - disconnected       → triggers initWhatsApp immediately
router.post("/auto-heal", async (req, res) => {
  const userId = req.session.userId!;
  const result = await autoHeal(userId);
  res.json({ ...result, status: getStatus(userId) });
});

// ── إرسال اختباري — يرسل رسالة واحدة فوراً للتحقق من صحة الجلسة ──────
// POST /api/whatsapp/test-send  { phone: "9715XXXXXXXX", message?: "...", buttons?: ButtonDef[], mediaUrl?: "..." }
// With buttons, the test goes exactly as a campaign's would — real buttons, image header if given.
router.post("/test-send", async (req, res) => {
  const userId = req.session.userId!;
  const { phone, message: testMsg = "رسالة اختبار ✓ واتساب ماركتر", buttons, mediaUrl } =
    req.body as { phone?: string; message?: string; buttons?: unknown[]; mediaUrl?: string };
  if (!phone) return res.status(400).json({ error: "phone مطلوب" });

  const waState = getStatus(userId);
  if (!waState.connected) {
    return res.status(503).json({ error: "واتساب غير متصل — افتح صفحة الربط أولاً" });
  }

  const cleanPhone = String(phone).replace(/[^0-9]/g, "");
  if (cleanPhone.length < 9) return res.status(400).json({ error: "رقم الهاتف غير صالح" });

  try {
    const withButtons = Array.isArray(buttons) && buttons.length > 0;
    await sendMessage(userId, cleanPhone, testMsg, withButtons ? (mediaUrl ? "image_button" : "button") : "text", mediaUrl ?? null, withButtons ? JSON.stringify(buttons) : null);
    res.json({ success: true, message: `تم إرسال رسالة اختبار إلى ${cleanPhone} ✓` });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || "فشل إرسال الرسالة الاختبارية" });
  }
});

router.post("/logout", async (req, res) => {
  await logout(req.session.userId!);
  res.json({ success: true, message: "Logged out" });
});

// ── إعادة ضبط الجلسة — يمسح كل شيء ويُرجع QR جديد → FULL history sync ──
router.post("/reset-session", async (req, res) => {
  await resetSession(req.session.userId!);
  res.json({ success: true, message: "تم مسح الجلسة. امسح QR الجديد لاستيراد كل المحادثات." });
});

// ── extract-contacts: يقرأ من DB + ذاكرة (دائم عبر إعادات التشغيل) ────
router.get("/extract-contacts", async (req, res) => {
  const phones = await extractPhones(req.session.userId!);
  res.json({ phones, count: phones.length });
});

// ── import-phones: import a caller-supplied set of numbers ───────────────
// The Conversations page has always posted here, but the route did not exist,
// so both "import selected" and "import all" returned 404 and the numbers the
// extractor had found could not be turned into a campaign list at all.
//
// Distinct from /import-contacts below, which ignores the request body and
// imports everything the extractor knows about.
router.post("/import-phones", async (req, res) => {
  const userId = req.session.userId!;
  const { listName, phones } = req.body as { listName?: string; phones?: unknown };

  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: "لم تصل أي أرقام" });
  }
  const name = String(listName ?? "").trim();
  if (!name) return res.status(400).json({ error: "أدخل اسم القائمة" });

  // Normalise and de-duplicate before touching the DB — the same number can
  // arrive from a conversation and from an incoming message.
  const unique = [...new Set(
    phones
      .map((p) => String(p).replace(/\D/g, ""))
      .filter((p) => p.length >= 7 && p.length <= 15),
  )];
  if (unique.length === 0) {
    return res.status(400).json({ error: "لا يوجد رقم صالح بين الأرقام المرسلة" });
  }

  // Names, where WhatsApp gave us one.
  const nameRows = await db
    .select({ phone: waContactsTable.phone, name: waContactsTable.name })
    .from(waContactsTable)
    .where(eq(waContactsTable.userId, userId));
  const nameMap = new Map(nameRows.map((r) => [r.phone, r.name]));

  const [group] = await db
    .insert(contactGroupsTable)
    .values({ userId, name, description: "مستوردة من محادثات واتساب" })
    .returning();

  const BATCH = 200;
  for (let i = 0; i < unique.length; i += BATCH) {
    await db.insert(contactsTable).values(
      unique.slice(i, i + BATCH).map((phone) => ({
        groupId: group!.id,
        phone,
        name: nameMap.get(phone) ?? null,
        status: "active",
      })),
    ).onConflictDoNothing();
  }

  req.log?.info({ userId, groupId: group!.id, requested: phones.length, imported: unique.length }, "phones imported from conversations");

  res.json({
    success:   true,
    groupId:   group!.id,
    count:     unique.length,
    duplicates: phones.length - unique.length,
    listName:  name,
  });
});

// ── import-contacts: يقرأ من DB ──────────────────────────────────────────
router.post("/import-contacts", async (req, res) => {
  const userId = req.session.userId!;
  const { listName = "جهات واتساب" } = req.body;

  const phones = await extractPhones(userId);
  if (phones.length === 0) {
    return res.status(400).json({
      error: "لا توجد أرقام محفوظة بعد. اضغط «مزامنة كاملة» وامسح QR الجديد لاستيراد كل المحادثات.",
    });
  }

  const [group] = await db
    .insert(contactGroupsTable)
    .values({ userId, name: listName, description: "مستخرجة تلقائياً من واتساب" })
    .returning();

  // استرجاع الأسماء من DB
  const nameRows = await db
    .select({ phone: waContactsTable.phone, name: waContactsTable.name })
    .from(waContactsTable)
    .where(eq(waContactsTable.userId, userId));
  const nameMap = new Map(nameRows.map(r => [r.phone, r.name]));

  for (let i = 0; i < phones.length; i += 200) {
    const batch = phones.slice(i, i + 200).map((phone) => ({
      groupId: group.id,
      phone,
      name: nameMap.get(phone) ?? null,
    }));
    await db.insert(contactsTable).values(batch).onConflictDoNothing();
  }

  res.json({ success: true, groupId: group.id, count: phones.length, listName });
});

// ── Extractor: full contact list from DB + memory ─────────────────────────
router.get("/extractor", async (req, res) => {
  const userId = req.session.userId!;
  const status   = getStatus(userId);
  const contacts = await extractContacts(userId);
  contacts.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  res.json({ connected: status.connected, total: contacts.length, contacts });
});

// ── Sync State — حالة المزامنة الدائمة من DB + إحصائيات حية ─────────────
router.get("/sync-state", async (req, res) => {
  const userId = req.session.userId!;
  const [dbState] = await db
    .select()
    .from(waSyncStateTable)
    .where(eq(waSyncStateTable.userId, userId));

  const thrRes  = await db.execute(sql`SELECT COUNT(*)::int AS n FROM wa_thread_messages WHERE user_id = ${userId}`);
  const cvRes   = await db.execute(sql`SELECT COUNT(*)::int AS n FROM wa_conversations      WHERE user_id = ${userId}`);
  const ctRes   = await db.execute(sql`SELECT COUNT(*)::int AS n FROM wa_contacts           WHERE user_id = ${userId}`);
  const liveSyncStats = getSyncStats(userId);
  const status = getStatus(userId);

  res.json({
    connected:      status.connected,
    syncStatus:     dbState?.syncStatus ?? "idle",
    lastFullSyncAt: dbState?.lastFullSyncAt ?? null,
    db: {
      threads:       Number((thrRes.rows[0] as any)?.n ?? 0),
      conversations: Number((cvRes.rows[0]  as any)?.n ?? 0),
      contacts:      Number((ctRes.rows[0]  as any)?.n ?? 0),
    },
    session: {
      chats:     liveSyncStats.chatsUpsertIndividual,
      messages:  liveSyncStats.historyMessagesTotal,
      contacts:  liveSyncStats.contactsUpsertTotal,
      syncType:  liveSyncStats.syncType,
    },
  });
});

// ── Force full resync ─────────────────────────────────────────────────────
router.post("/extractor/resync", async (req, res) => {
  const userId = req.session.userId!;
  try {
    await forceResync(userId);
    res.json({ ok: true, message: "جاري إعادة الاتصال — ستظهر جهات الاتصال خلال 10-30 ثانية" });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "فشل إعادة المزامنة" });
  }
});

// ── Extractor: ALL conversations from DB ──────────────────────────────────
router.get("/extractor/conversations", async (req, res) => {
  const userId = req.session.userId!;
  const rows = await db
    .select()
    .from(waConversationsTable)
    .where(eq(waConversationsTable.userId, userId))
    .orderBy(desc(waConversationsTable.lastMsgAt));
  res.json({
    total: rows.length,
    conversations: rows.map(r => ({
      phone:    r.phone,
      name:     r.name ?? null,
      lastText: r.lastText ?? "",
      lastAt:   Math.floor(new Date(r.lastMsgAt).getTime() / 1000),
      msgCount: r.msgCount,
    })),
  });
});

// ── Extractor: incoming messages grouped by phone ─────────────────────────
router.get("/extractor/messages", async (req, res) => {
  const userId = req.session.userId!;
  const grouped = await db.execute(sql`
    SELECT
      im.phone,
      COUNT(*)::int                                     AS count,
      MAX(im.received_at)                               AS last_at,
      (ARRAY_AGG(im.text ORDER BY im.received_at DESC NULLS LAST))[1] AS last_text,
      wc.name
    FROM incoming_messages im
    LEFT JOIN wa_contacts wc
      ON wc.user_id = im.user_id AND wc.phone = im.phone
    WHERE im.user_id = ${userId}
    GROUP BY im.phone, wc.name
    ORDER BY last_at DESC
  `);

  const result = (grouped.rows as any[]).map(r => ({
    phone:    r.phone,
    count:    Number(r.count),
    lastText: r.last_text ?? "",
    lastAt:   Math.floor(new Date(r.last_at).getTime() / 1000),
    name:     r.name ?? null,
  }));

  res.json({ total: result.length, messages: result });
});

// ── Extractor: stats — عدد السجلات في DB + الذاكرة (للتشخيص) ───────────────
router.get("/extractor/stats", async (req, res) => {
  const userId = req.session.userId!;
  const [cRow] = await db.select({ n: sql<number>`count(*)::int` }).from(waContactsTable).where(eq(waContactsTable.userId, userId));
  const [cvRow] = await db.select({ n: sql<number>`count(*)::int` }).from(waConversationsTable).where(eq(waConversationsTable.userId, userId));
  const [imRow] = await db.select({ n: sql<number>`count(*)::int` }).from(incomingMessagesTable).where(eq(incomingMessagesTable.userId, userId));
  const status = getStatus(userId);
  res.json({
    db: {
      contacts:      cRow?.n  ?? 0,
      conversations: cvRow?.n ?? 0,
      incoming:      imRow?.n ?? 0,
    },
    connected: status.connected,
    status:    status.status,
  });
});

// ── Extractor: debug — تشخيص شامل بالأرقام (من أين البيانات ولماذا قليلة) ─────
router.get("/extractor/debug", async (req, res) => {
  const userId = req.session.userId!;

  // أرقام من DB
  const [cRow] = await db.select({ n: sql<number>`count(*)::int` }).from(waContactsTable).where(eq(waContactsTable.userId, userId));
  const [cvRow] = await db.select({ n: sql<number>`count(*)::int` }).from(waConversationsTable).where(eq(waConversationsTable.userId, userId));
  const [imRow] = await db.select({ n: sql<number>`count(*)::int` }).from(incomingMessagesTable).where(eq(incomingMessagesTable.userId, userId));

  // عينة من wa_conversations لمعرفة أقدم وأحدث محادثة
  const convSample = await db
    .select({ phone: waConversationsTable.phone, lastMsgAt: waConversationsTable.lastMsgAt, name: waConversationsTable.name })
    .from(waConversationsTable)
    .where(eq(waConversationsTable.userId, userId))
    .orderBy(desc(waConversationsTable.lastMsgAt))
    .limit(10);

  // آخر 10 أحداث session
  const recentEvents = await db
    .select({ event: waSessionEventsTable.event, detail: waSessionEventsTable.detail, createdAt: waSessionEventsTable.createdAt })
    .from(waSessionEventsTable)
    .where(eq(waSessionEventsTable.userId, userId))
    .orderBy(desc(waSessionEventsTable.createdAt))
    .limit(10);

  // stats من الذاكرة (هذا الـ socket session الحالي فقط)
  const syncStats = getSyncStats(userId);
  const status = getStatus(userId);

  res.json({
    note: [
      "syncStats تتجدد لكل socket session جديد (reconnect/restart)",
      "syncType=0 = INITIAL_BOOTSTRAP (reconnect عادي) — syncType=2 = FULL (QR جديد فقط)",
      "chatsUpsert = المحادثات المتاحة في session — historySet = تاريخ كامل (QR جديد فقط)",
    ],
    db: {
      wa_contacts:       cRow?.n  ?? 0,
      wa_conversations:  cvRow?.n ?? 0,
      incoming_messages: imRow?.n ?? 0,
    },
    currentSession: {
      status: status.status,
      connected: status.connected,
      syncStats,
    },
    recentConversations: convSample,
    recentSessionEvents: recentEvents,
  });
});

// ── Extractor: save-all — يحفظ كل أرقام DB دفعة واحدة في قائمة جديدة ────────
router.post("/extractor/save-all", async (req, res) => {
  const userId = req.session.userId!;
  const { listName = `كل المحادثات ${new Date().toLocaleDateString("ar-SA")}` } = req.body as { listName?: string };

  // جمع كل الأرقام من wa_contacts + wa_conversations دون تكرار
  const [contactRows, convRows] = await Promise.all([
    db.select({ phone: waContactsTable.phone, name: waContactsTable.name })
      .from(waContactsTable)
      .where(eq(waContactsTable.userId, userId)),
    db.select({ phone: waConversationsTable.phone, name: waConversationsTable.name })
      .from(waConversationsTable)
      .where(eq(waConversationsTable.userId, userId)),
  ]);

  // دمج وإزالة التكرار
  const nameMap = new Map<string, string | null>();
  for (const r of contactRows) nameMap.set(r.phone, r.name ?? null);
  for (const r of convRows)    if (!nameMap.has(r.phone)) nameMap.set(r.phone, r.name ?? null);

  if (nameMap.size === 0) {
    return res.status(400).json({ error: "لا توجد أرقام في قاعدة البيانات بعد. اضغط «مزامنة كاملة (QR جديد)» في ربط الواتساب أولاً." });
  }

  // إنشاء القائمة
  const [group] = await db
    .insert(contactGroupsTable)
    .values({ userId, name: listName, description: `محفوظة تلقائياً — ${nameMap.size} رقم` })
    .returning();

  const phones = Array.from(nameMap.entries());
  for (let i = 0; i < phones.length; i += 200) {
    const batch = phones.slice(i, i + 200).map(([phone, name]) => ({
      groupId: group.id, phone, name,
    }));
    await db.insert(contactsTable).values(batch).onConflictDoNothing();
  }

  res.json({ success: true, groupId: group.id, count: nameMap.size, listName });
});

// ── Extractor: import phones into a contact group ─────────────────────────
router.post("/extractor/import", async (req, res) => {
  const userId = req.session.userId!;
  const { listName = "مستخرج من واتساب", phones } = req.body as {
    listName?: string;
    phones: string[];
  };

  if (!Array.isArray(phones) || phones.length === 0) {
    return res.status(400).json({ error: "يجب إرسال قائمة أرقام" });
  }

  const [group] = await db
    .insert(contactGroupsTable)
    .values({ userId, name: listName, description: "مستخرجة من مستخرج الأرقام" })
    .returning();

  // استرجاع الأسماء من DB
  const nameRows = await db
    .select({ phone: waContactsTable.phone, name: waContactsTable.name })
    .from(waContactsTable)
    .where(eq(waContactsTable.userId, userId));
  const nameMap = new Map(nameRows.map(r => [r.phone, r.name]));

  const unique = [...new Set(phones)];
  for (let i = 0; i < unique.length; i += 200) {
    const batch = unique.slice(i, i + 200).map((phone) => ({
      groupId: group.id,
      phone,
      name: nameMap.get(phone) ?? null,
    }));
    await db.insert(contactsTable).values(batch).onConflictDoNothing();
  }

  res.json({ success: true, groupId: group.id, count: unique.length, listName });
});

// ══════════════════════════════════════════════════════════════════
// INBOX — صندوق الوارد
// ══════════════════════════════════════════════════════════════════

// GET /api/whatsapp/inbox — كل المحادثات من DB (wa_conversations ∪ wa_contacts)
router.get("/inbox", async (req, res) => {
  const userId = req.session.userId!;

  // دمج ثلاثة مصادر:
  // 1) wa_conversations  — محادثات متتبعة كاملاً (مع النص + العدد)
  // 2) wa_contacts[source=chat] — جهات من سجل المحادثات
  // 3) wa_contacts[source=phonebook] — جهات دفتر الهاتف
  const rows = await db.execute(sql`
    SELECT phone, name, last_text, last_at, msg_count FROM (

      -- المصدر 1: محادثات متتبعة
      SELECT
        wc.phone,
        COALESCE(wco.name, wc.name) AS name,
        wc.last_text,
        EXTRACT(EPOCH FROM wc.last_msg_at)::bigint AS last_at,
        wc.msg_count
      FROM wa_conversations wc
      LEFT JOIN wa_contacts wco
        ON wco.user_id = wc.user_id AND wco.phone = wc.phone
      WHERE wc.user_id = ${userId}

      UNION

      -- المصدر 2+3: كل جهات الاتصال المحفوظة (chat + phonebook)
      SELECT
        wco.phone,
        wco.name,
        NULL AS last_text,
        wco.last_message_at::bigint AS last_at,
        0 AS msg_count
      FROM wa_contacts wco
      WHERE wco.user_id = ${userId}
        AND NOT EXISTS (
          SELECT 1 FROM wa_conversations wc2
          WHERE wc2.user_id = ${userId} AND wc2.phone = wco.phone
        )

    ) t
    ORDER BY last_at DESC NULLS LAST
  `);

  res.json((rows.rows as any[]).map(r => ({
    phone:    r.phone,
    name:     r.name ?? null,
    lastText: r.last_text ?? "",
    lastAt:   Number(r.last_at ?? 0),
    msgCount: Number(r.msg_count ?? 0),
  })));
});

// GET /api/whatsapp/inbox/:phone — رسائل محادثة واحدة
router.get("/inbox/:phone", async (req, res) => {
  const userId = req.session.userId!;
  const { phone } = req.params;
  const { and } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(waThreadMessagesTable)
    .where(and(
      eq(waThreadMessagesTable.userId, userId),
      eq(waThreadMessagesTable.phone, phone),
    ))
    .orderBy(desc(waThreadMessagesTable.createdAt))
    .limit(200);
  res.json(rows.reverse().map(r => ({
    id:        r.id,
    text:      r.text ?? "",
    fromMe:    r.fromMe,
    createdAt: Math.floor(new Date(r.createdAt).getTime() / 1000),
  })));
});

// POST /api/whatsapp/inbox/:phone/voice — the words, spoken, as a voice note
router.post("/inbox/:phone/voice", async (req, res) => {
  const userId = req.session.userId!;
  const { phone } = req.params;
  const text = String((req.body as any)?.text ?? "").trim();
  if (!text) return res.status(400).json({ error: "اكتب ما يُقال" });
  try {
    await sendVoiceNote(userId, phone, text);
    await takeover(userId, phone, "app").catch(() => {});
    const [saved] = await db.insert(waThreadMessagesTable).values({ userId, phone, text, fromMe: true, msgType: "voice" }).returning();
    res.json({ id: saved.id, text, fromMe: true, voice: true, createdAt: Math.floor(Date.now() / 1000) });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err).slice(0, 200) }); }
});

// POST /api/whatsapp/inbox/:phone/send
router.post("/inbox/:phone/send", async (req, res) => {
  const userId = req.session.userId!;
  const { phone } = req.params;
  const { text } = req.body as { text: string };
  if (!text?.trim()) return res.status(400).json({ error: "الرسالة فارغة" });

  await sendMessage(userId, phone, text.trim());
  // The owner is on this thread now; the bot and the ladder step back.
  await takeover(userId, phone, "app").catch(() => {});

  const [saved] = await db.insert(waThreadMessagesTable)
    .values({ userId, phone, text: text.trim(), fromMe: true })
    .returning();

  await db.execute(sql`
    INSERT INTO wa_conversations (user_id, phone, last_msg_at, last_text, msg_count, updated_at)
    VALUES (${userId}, ${phone}, NOW(), ${text.trim()}, 1, NOW())
    ON CONFLICT (user_id, phone) DO UPDATE SET
      last_msg_at = NOW(),
      last_text   = EXCLUDED.last_text,
      msg_count   = wa_conversations.msg_count + 1,
      updated_at  = NOW()
  `);

  res.json({ id: saved.id, text: saved.text, fromMe: true, createdAt: Math.floor(Date.now() / 1000) });
});

export default router;
