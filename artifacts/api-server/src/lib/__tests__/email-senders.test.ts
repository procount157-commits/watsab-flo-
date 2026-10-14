// صناديق إرسالٍ أكثر من واحد: من يُرسل التالية، والتسخين، والمصادقة.
export {};
process.env.DATABASE_URL ??= "postgres://unused@localhost/unused";
const { chooseSender, senderWarmupCap, asSettings, cleanSenderInput, PRESETS } = await import("../email/senders");
const { classifySendFailure } = await import("../email/provider");
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(58)} ${d}`); };
const now = 10_000_000;
const c = (id: number | null, d: number, cap: number, extra: any = {}) => ({ id, email: `${id ?? 0}@x`, sentHour: 0, sentDay: d, hourlyCap: 15, dailyCap: cap, lastSentAt: 0, gapMs: 60_000, ...extra });

check("الأقل استهلاكاً لسقفه يُرسل", chooseSender([c(null, 100, 300), c(1, 10, 20), c(2, 5, 80)], now)?.id === 2);
check("بالنسبة لا بالعدد", chooseSender([c(null, 150, 300), c(1, 15, 20)], now)?.id === null);
check("من بلغ سقف يومه لا يُرسل", chooseSender([c(null, 300, 300), c(1, 3, 20)], now)?.id === 1);
check("من بلغ سقف ساعته لا يُرسل", chooseSender([c(null, 0, 300, { sentHour: 15 }), c(1, 3, 20)], now)?.id === 1);
check("من لم يمضِ فاصله لا يُرسل", chooseSender([c(null, 0, 300, { lastSentAt: now - 1000 }), c(1, 3, 20)], now)?.id === 1);
check("الكل ممتلئ: لا أحد", chooseSender([c(null, 300, 300), c(1, 20, 20)], now) === null);
check("ثلاثة صناديق تتوزّع بالتساوي", (() => {
  const cs = [c(null, 0, 80), c(1, 0, 80), c(2, 0, 80)]; const n = new Map<any, number>();
  for (let t = 0; t < 90; t++) { const p = chooseSender(cs, now + t * 1e6)!; p.sentDay++; p.lastSentAt = now + t * 1e6; n.set(p.id, (n.get(p.id) ?? 0) + 1); }
  return [...n.values()].every((x) => x === 30);
})());

check("تسخين · عشرون في اليوم الأول", senderWarmupCap(80, 0) === 20);
check("تسخين · يكبر ولا يتجاوز السقف", senderWarmupCap(80, 7) === 53 && senderWarmupCap(80, 30) === 80, `${senderWarmupCap(80, 7)}`);
check("تسخين · مطفأ = السقف", senderWarmupCap(80, 0, false) === 80);

const base: any = { userId: 2, provider: "smtp", fromEmail: "info@pro-count.ae", fromName: "Pro Count", replyTo: "info@pro-count.ae", signature: "<b>sig</b>", tracking: true, smtpHost: "a", smtpPass: "p0" };
const snd: any = { id: 5, fromEmail: "marketing@pro-count.ae", fromName: null, smtpHost: "smtp.hostinger.com", smtpPort: 465, smtpSecure: true, smtpUser: "marketing@pro-count.ae", smtpPass: "p1", imapHost: "imap.hostinger.com", imapPort: 993 };
const es = asSettings(base, snd);
check("الصندوق الإضافي يرسل بعنوانه وخادمه", es.fromEmail === "marketing@pro-count.ae" && es.smtpPass === "p1" && es.smtpHost === "smtp.hostinger.com");
check("ويحمل توقيع الحساب واسمه", es.signature === "<b>sig</b>" && es.fromName === "Pro Count");
check("والرد يعود إليه هو", es.replyTo === null);

const v = cleanSenderInput({ preset: "hostinger", fromEmail: "Contact@Pro-Count.ae", smtpPass: "x" });
check("Hostinger: الخوادم من الإعداد الجاهز", v.smtpHost === PRESETS.hostinger.smtpHost && v.smtpPort === 465 && v.smtpSecure && v.imapHost === "imap.hostinger.com");
check("العنوان بحروف صغيرة، والمستخدم هو العنوان", v.fromEmail === "contact@pro-count.ae" && v.smtpUser === "contact@pro-count.ae");
check("سقف البريد البارد افتراضاً ٨٠/١٥", v.dailyCap === 80 && v.hourlyCap === 15);
let threw = ""; try { cleanSenderInput({ fromEmail: "a@b.co" }); } catch (e: any) { threw = e.message; }
check("بلا كلمة مرور يُرفض", /كلمة مرور/.test(threw));
check("التعديل بلا كلمة مرور يُبقي القديمة", cleanSenderInput({ dailyCap: 50 }, { ...snd, preset: "hostinger", dailyCap: 80 }).smtpPass === "p1");

check("فشل الدخول ← إعداد لا إزعاج", classifySendFailure("535", "Invalid login: 535 5.7.8 Error: authentication failed") === "config");
check("رفض الإزعاج يبقى سياسة", classifySendFailure("554", "554 5.7.1 Spam message rejected") === "policy");
check("5.7.26 عند المستلم يبقى سياسة", classifySendFailure("550", "550 5.7.26 Unauthenticated email from domain is not accepted due to domain's DMARC policy") === "policy");
console.log(`\n${pass}/${total} ${pass === total ? "✅" : "❌"}`);
process.exit(pass === total ? 0 : 1);
