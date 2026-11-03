// What a delivery report says about the address — from reports this account really received.
import { bounceSeverity } from "../email/classify";
import { settledBounce } from "../email/results";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✅" : "❌"} ${name.padEnd(60)} ${got}`); };
const is = (name: string, text: string, want: string) => { const s = bounceSeverity(text); check(name, s === want, s); };

is("a dead address is hard", "Undelivered Mail Returned to Sender\n5.1.1 <sales@hayatttrading.ae>: Recipient address rejected: undeliverable address: host de-fra-smtpin10.hostinger.io", "hard");
is("user unknown is hard", "Returned mail\n5.1.1 User Unknown The message will be deleted from the queue.", "hard");
is("no mailbox by that name, via an antispam host, is hard", "Returned mail\nNo mailbox by that name is currently available Remote-MTA: dns; mx10.antispam.mailspamprotection.com. Diagnostic-Code", "hard");
is("a full mailbox is soft", "Undelivered Mail Returned to Sender\n5.2.2 <info@allindubai.me> Quota exceeded (mailbox for user is full)", "soft");
is("a full mailbox without a code is soft", "Returned mail\nMailbox is full / Blocks limit exceeded / Inode limit exceeded The message will be deleted", "soft");
is("a 4.x.x is soft", "Undelivered Mail Returned to Sender\n4.0.0 Remote-MTA: dns; muatikitchen.com Diagnostic-Code: smtp; 421", "soft");
is("a delay warning is not a bounce", "Warning: message 1xNBL9 delayed 24 hours\nhas not yet been delivered to one or more of its recipients after more than 24 hours", "delay");
is("spam rejection is the provider's verdict", "Returned mail\n5.0.0 spam message rejected. Please visit https://help.mail.ru/notspam-support", "policy");
is("5.7.1 local policy is policy", "Undelivered Mail Returned to Sender\n5.7.1 [CS101] Message rejected due to local policy", "policy");
is("our server on Spamhaus is policy", "Returned mail\n5.3.0 189.12.195.8 Rejected - see http://www.spamhaus.org The message will be deleted", "policy");
is("a DMARC aggregate report is a report", "Report Domain: pro-count.ae Submitter: yahoo.com\nThis is an aggregate DMARC report from Yahoo for your domain", "report");
is("our own words in the copied message do not decide", "Undelivered Mail\n5.1.1 user unknown\n--- Below this line is a copy of the message.\nReturn-Path: <a@b>\nWe help with spam filtering policy", "hard");

const f = (sent: number, bounced: number, verdict: any = "hold") => ({ key: "k", label: "l", sent, bounced, opened: 0, clicked: 0, replied: 0, positive: 0, negative: 0, rejected: 0, bounceRate: Math.round((1000 * bounced) / sent) / 10, replyRate: 0, positiveRate: 0, verdict, why: "" }) as any;
check("old lists cleaned: 30 days hold becomes watch", settledBounce(f(2023, 110), f(1498, 16)).verdict === "watch");
check("recent bounce still high: hold stays", settledBounce(f(2023, 110), f(1498, 90)).verdict === "hold");
check("too few recent to judge: hold stays", settledBounce(f(2023, 110), f(100, 1)).verdict === "hold");

console.log(`\n${pass}/${pass + fail} ${fail ? "❌" : "✅"}`);
process.exit(fail ? 1 : 0);
