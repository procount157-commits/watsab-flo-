// The stop button: a tap keeps the number off for five months and no more;
// a stop typed for good is never shortened by a tap; the sweep lifts only
// what has expired. Runs on the test account with a number no one owns.

export {};
const { withStopButton, stripZeroLine, stopUntil, isStopTap, tappedButtonId, stopForMonths, sweepExpiredOptOuts, STOP_MONTHS } = await import("../opt-out");
const { nativeFlowButtons } = await import("../wa-buttons");
const { db, unsubscribedPhonesTable } = await import("@workspace/db");
const { and, eq } = await import("drizzle-orm");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

const until = stopUntil(new Date("2026-10-06T10:00:00Z"));
check("five months on, the same day", STOP_MONTHS === 5 && until.toISOString().startsWith("2027-03-06"), until.toISOString());
const stop = nativeFlowButtons([{ text: "إيقاف الرسائل", type: "stop" }])[0]!;
check("the stop button goes as a quick reply with a stop id", stop.name === "quick_reply" && isStopTap(JSON.parse(stop.buttonParamsJson).id));
check("a tap's id is read from the response", tappedButtonId({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: '{"id":"btn:stop:2"}' } } }) === "btn:stop:2");
check("other buttons are not stops", !isStopTap("btn:interested:0") && !isStopTap(null) && tappedButtonId({ conversation: "x" }) === null);

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
  await stopForMonths(U, P);
  const r1 = await row();
  const days = r1?.expiresAt ? (r1.expiresAt.getTime() - Date.now()) / 86_400_000 : 0;
  check("a tap blocks the number for about five months", days > 148 && days < 156, `${days.toFixed(1)} days`);

  await db.update(unsubscribedPhonesTable).set({ expiresAt: null }).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
  await stopForMonths(U, P);
  check("a stop for good is not shortened by a later tap", (await row())?.expiresAt === null);

  const past = new Date(Date.now() - 60_000);
  await db.update(unsubscribedPhonesTable).set({ expiresAt: past }).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
  await stopForMonths(U, P);
  check("an expired block renewed by a new tap runs five months again", ((await row())?.expiresAt?.getTime() ?? 0) > Date.now() + 140 * 86_400_000);

  await db.update(unsubscribedPhonesTable).set({ expiresAt: past }).where(and(eq(unsubscribedPhonesTable.userId, U), eq(unsubscribedPhonesTable.phone, P)));
  await sweepExpiredOptOuts();
  check("the sweep lifts an expired block", !(await row()));

  await stopForMonths(U, P);
  await sweepExpiredOptOuts();
  check("...and leaves a live one", !!(await row()));
} finally {
  await clear();
}

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
