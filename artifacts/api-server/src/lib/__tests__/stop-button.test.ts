// The stop button: a tap keeps the number off for good (the owner, 2026-10-20:
// «من اختار لا خلاص ما هرسل له تاني»); a typed stop is read in any short
// phrasing; the sweep makes old timed rows permanent and lifts nothing.
// Runs on the test account with a number no one owns.

export {};
const { withStopButton, stripZeroLine, isStopTap, tappedButtonId, stopForGood, stopForMonths, sweepExpiredOptOuts, asksToStop, STOP_MONTHS } = await import("../opt-out");
const { nativeFlowButtons } = await import("../wa-buttons");
const { db, unsubscribedPhonesTable } = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

check("a stop has no months any more", STOP_MONTHS === 0);
const stop = nativeFlowButtons([{ text: "إيقاف الرسائل", type: "stop" }])[0]!;
check("the stop button goes as a quick reply with a stop id", stop.name === "quick_reply" && isStopTap(JSON.parse(stop.buttonParamsJson).id));
check("a tap's id is read from the response", tappedButtonId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"btn:stop:2"}' } } }) === "btn:stop:2");
check("other buttons are not stops", !isStopTap("btn:interested:0") && !isStopTap(null) && tappedButtonId({ conversation: "x" }) === null);

for (const t of ["إيقاف", "الغاء الاشتراك", "stop", "STOP!!", "0", "شيلوا رقمي لو سمحت", "لا ترسلوا لي", "ما ابي رسايل 🙏", "احذف رقمي", "Unsubscribe.", "مش عايز رسايل"]) check(`«${t}» asks to stop`, asksToStop(t));
for (const t of ["الغاء الطلب رقم ٥٤٣ لو سمحت وارسلوا البديل بكرة الصبح مع التوصيل", "كم سعر الطقم؟", "تمام شكرا", "ابي اوقف الطلب واغير المقاس", "10"]) check(`«${t}» does not`, !asksToStop(t));

const old = "هلا {الاسم}\n{تواصل معنا|كلمنا}\n\n━━━━━━━━━━\n🔕 لإيقاف الرسائل أرسل: 0\n\n━━━━━━━━━━\n🔕 لإيقاف الرسائل أرسل: 0";
check("every copy of the old «أرسل: 0» line is taken out, the message kept", stripZeroLine(old) === "هلا {الاسم}\n{تواصل معنا|كلمنا}", JSON.stringify(stripZeroLine(old)));

const t = withStopButton("هلا", "text", null);
check("a text message goes with the stop button", t.messageType === "button" && JSON.parse(t.buttons!)[0].type === "stop");
const im = withStopButton("x", "image", null), vb = withStopButton("x", "video", "[]");
check("an image or a video gets it under the media", im.messageType === "image_button" && vb.messageType === "video_button");
const two = withStopButton("x", "image_button", '[{"text":"مهتم","type":"interested"}]');
check("buttons already there keep their place, stop goes last", JSON.parse(two.buttons!).map((b: any) => b.type).join() === "interested,stop");
const once = withStopButton("x", "button", '[{"text":"أوقف","type":"stop"}]');
check("never twice", JSON.parse(once.buttons!).length === 1);
check("a carousel goes as it is", withStopButton("x", "carousel", null).buttons === null);
check("the «0» line does not go out", !withStopButton(old, "text", null).message.includes("أرسل: 0"));

const U = 1, P = "999000000777";
const row = async () => (await db.select().from(unsubscribedPhonesTable).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P))))[0];
const clear = () => db.delete(unsubscribedPhonesTable).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
try {
  await clear();
  await stopForGood(U, P);
  check("a tap blocks the number for good", !!(await row()) && (await row())?.expiresAt === null);

  const past = new Date(Date.now() - 60_000);
  await db.update(unsubscribedPhonesTable).set({ expiresAt: past }).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
  await stopForMonths(U, P);
  check("an old timed row renewed by a tap becomes permanent", (await row())?.expiresAt === null);

  await db.update(unsubscribedPhonesTable).set({ expiresAt: past }).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
  await sweepExpiredOptOuts();
  const r = await row();
  check("the sweep lifts nothing: an expired row is made permanent", !!r && r.expiresAt === null);
} finally {
  await clear();
}

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
