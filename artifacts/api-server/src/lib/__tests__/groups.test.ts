// WhatsApp customer groups, against the real tables for user 1 and without a
// model or a WhatsApp connection: messages read from Baileys' shapes, kept
// once, archived to a folder on disk; the owner's past replies found for a
// similar message; his reply scored against a suggestion; his verdicts
// remembered; and the accuracy that says whether the agent is ready.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "groups-test-"));
process.env["GROUP_FILES_DIR"] = ROOT;

const { and, eq, like } = await import("drizzle-orm");
const { db, waGroupsTable, waGroupMessagesTable, waGroupSuggestionsTable, agentMemoryTable } = await import("@workspace/db");
const { parseGroupMessage, captureGroupMessage, captureGroupHistory, folderFor } = await import("../groups/store");
const { similarity, similarExamples, recordOwnerReply, feedback, accuracy } = await import("../groups/assistant");

const USER = 1;
const G = "120363999000111222@g.us";
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(60)} ${d}`); };
async function clean() {
  await db.delete(waGroupMessagesTable).where(and(eq(waGroupMessagesTable.userId, USER), eq(waGroupMessagesTable.groupJid, G)));
  await db.delete(waGroupSuggestionsTable).where(and(eq(waGroupSuggestionsTable.userId, USER), eq(waGroupSuggestionsTable.groupJid, G)));
  await db.delete(waGroupsTable).where(and(eq(waGroupsTable.userId, USER), eq(waGroupsTable.jid, G)));
  await db.delete(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), eq(agentMemoryTable.role, "groups"), like(agentMemoryTable.content, "%اختبار-قروب%")));
}
await clean();

let seq = 0;
const ts = (minAgo: number) => Math.floor(Date.now() / 1000) - minAgo * 60;
const msg = (o: any) => ({ key: { remoteJid: G, id: `grp-test-${++seq}`, fromMe: !!o.fromMe, participant: o.fromMe ? undefined : (o.participant ?? "971501112233@s.whatsapp.net") }, pushName: o.name ?? "أحمد", messageTimestamp: ts(o.ago ?? 0), message: o.message });

// ── Reading ──────────────────────────────────────────────────────
const t = parseGroupMessage(msg({ message: { conversation: "مرحبا، متى موعد إقرار VAT؟" } }))!;
check("a text message is read with its sender", t.text.includes("VAT") && t.senderPhone === "971501112233" && t.senderName === "أحمد" && t.msgType === "text");
const img = parseGroupMessage(msg({ message: { imageMessage: { caption: "الفاتورة", mimetype: "image/jpeg" } } }))!;
check("an image with its caption", img.msgType === "image" && img.text === "الفاتورة");
const doc = parseGroupMessage(msg({ message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "statement.pdf", mimetype: "application/pdf" } } } } }))!;
check("a document keeps its file name", doc.msgType === "document" && doc.fileName === "statement.pdf");
check("a voice note is a voice note", parseGroupMessage(msg({ message: { audioMessage: { seconds: 5 } } }))!.msgType === "voice");
check("a reaction is not a message", parseGroupMessage(msg({ message: { reactionMessage: { text: "👍" } } })) === null);
check("a protocol message is not a message", parseGroupMessage(msg({ message: { protocolMessage: {} } })) === null);
check("a one-to-one chat is not a group message", parseGroupMessage({ key: { remoteJid: "971500000000@s.whatsapp.net", id: "x" }, message: { conversation: "hi" } }) === null);
const lid = parseGroupMessage(msg({ participant: "12345@lid", message: { conversation: "hi" } }), new Map([["12345@lid", "971509998877"]]))!;
check("a LID sender is mapped to the phone", lid.senderPhone === "971509998877");

// ── Keeping and filing ───────────────────────────────────────────
const first = msg({ ago: 50, message: { conversation: "مرحبا، متى موعد إقرار VAT لهذا الربع؟" } });
const kept = await captureGroupMessage(USER, null, first);
check("a group message is kept", !!kept && kept.group.jid === G);
check("...once: the same message again is not kept twice", (await captureGroupMessage(USER, null, first)) === null);
await captureGroupHistory(USER, [
  msg({ ago: 49, fromMe: true, message: { conversation: "أهلاً، الإقرار خلال 28 يوماً من نهاية الفترة، سنرسل لكم المسودة يوم الأحد." } }),
  msg({ ago: 30, message: { conversation: "شكراً جزيلاً" } }),
  msg({ ago: 20, message: { conversation: "هل استلمتم كشف الحساب البنكي؟" } }),
]);
const [g] = await db.select().from(waGroupsTable).where(and(eq(waGroupsTable.userId, USER), eq(waGroupsTable.jid, G)));
check("the group is counted", g?.messages === 4, `${g?.messages}`);
const dir = folderFor({ jid: G, subject: g!.subject });
const archive = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("محادثة-")) : [];
check("the conversation is archived to a file on disk", archive.length === 1 && fs.readFileSync(path.join(dir, archive[0]!), "utf8").includes("أنا: أهلاً"), archive.join(","));

// ── Learning from the owner ──────────────────────────────────────
check("similar messages score high, unrelated low", similarity("متى موعد إقرار VAT؟", "موعد إقرار VAT متى؟") > 0.8 && similarity("متى موعد إقرار VAT؟", "شكراً جزيلاً") < 0.2);
const ex = await similarExamples(USER, "متى يجب تقديم إقرار VAT؟");
check("the owner's past answer to a similar question is found", ex.some((e) => e.a.includes("28 يوماً")), ex.map((e) => e.score).join(","));

const [s1] = await db.insert(waGroupSuggestionsTable).values({ userId: USER, groupJid: G, triggerMessageId: "grp-test-x", triggerText: "اختبار-قروب هل استلمتم الكشف؟", suggestion: "نعم استلمنا كشف الحساب البنكي، شكراً لكم.", status: "pending" }).returning();
await recordOwnerReply(USER, G, "نعم استلمنا الكشف البنكي وشكراً");
const [after] = await db.select().from(waGroupSuggestionsTable).where(eq(waGroupSuggestionsTable.id, s1!.id));
check("the owner's own reply is set beside hers and scored", after!.status === "answered" && (after!.matchScore ?? 0) >= 0.5, `${after!.status} ${after!.matchScore}`);

const [s2] = await db.insert(waGroupSuggestionsTable).values({ userId: USER, groupJid: G, triggerText: "اختبار-قروب كم السعر؟", suggestion: "السعر 500 درهم", status: "pending" }).returning();
await feedback(USER, s2!.id, { verdict: "edited", text: "نحدد السعر بعد معرفة حجم العمليات، هل يمكن أن ترسلوا عدد الفواتير الشهرية؟" });
const mem = await db.select().from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), eq(agentMemoryTable.role, "groups"), like(agentMemoryTable.content, "%اختبار-قروب كم السعر%")));
check("an edited suggestion is remembered as the right reply", mem.some((m) => m.kind === "win" && m.content.includes("حجم العمليات")));
const [s3] = await db.insert(waGroupSuggestionsTable).values({ userId: USER, groupJid: G, triggerText: "اختبار-قروب x", suggestion: "y", status: "pending" }).returning();
await feedback(USER, s3!.id, { verdict: "wrong", note: "اختبار-قروب لا نعطي أسعاراً في القروب" });
check("a wrong one with a note becomes an instruction", (await db.select().from(agentMemoryTable).where(and(eq(agentMemoryTable.userId, USER), eq(agentMemoryTable.role, "groups"), eq(agentMemoryTable.kind, "instruction"), like(agentMemoryTable.content, "%اختبار-قروب لا نعطي%")))).length === 1);

const acc = await accuracy(USER);
check("accuracy counts the decided ones", acc.decided >= 3 && acc.hits >= 1 && acc.wrong >= 1, JSON.stringify({ d: acc.decided, h: acc.hits, r: acc.rate }));
check("...and is not ready on a handful", acc.ready === false && acc.needed > 0);

await clean();
fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
