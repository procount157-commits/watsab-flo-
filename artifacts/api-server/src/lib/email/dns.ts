// ── The three records a sending domain needs ─────────────────────
// Nothing here sends better email; it tells the owner why their email is
// not arriving. SPF names who may send for the domain, DKIM signs what is
// sent, DMARC says what to do when neither matches. Mailbox providers now
// refuse bulk mail without all three.

import { promises as dns } from "node:dns";

export interface DnsReport {
  domain: string;
  spf:   { found: boolean; record: string | null; ok: boolean; note: string };
  dmarc: { found: boolean; record: string | null; ok: boolean; note: string };
  dkim:  { found: boolean; selector: string | null; note: string };
  mx:    { found: boolean; hosts: string[] };
}

// محدّدات DKIM المعروفة لكل مزوّد. وليست قائمةً للزينة: نطاق الشركة
// (pro-count.ae) يُرسل عبر Hostinger، ومحدّداتها الحقيقية
// hostingermail1/2/3 — ولم تكن في القائمة، فكان الفحص يقول «لم أجد
// DKIM» وهو جوابٌ صحيح هنا بالصدفة لا بالفحص.
const SELECTORS = [
  // Hostinger
  "hostingermail1", "hostingermail2", "hostingermail3",
  // Google Workspace / Microsoft
  "google", "selector1", "selector2",
  // Zoho / Brevo / Resend / Mailgun / SendGrid / Mailchimp / Postmark
  "zoho", "zmail", "brevo", "mail", "resend", "smtp", "k1", "k2", "k3",
  "s1", "s2", "s3", "sig1", "pm", "pm-bounces", "mandrill", "dkim", "default",
  // أخرى شائعة
  "mailo", "hostinger", "cm", "sm", "ml",
];

/** المحدّدات التي يستعملها مزوّدٌ بعينه — تُفحص أولاً فتُسرّع وتُصيب. */
const BY_HOST: Array<[RegExp, string[]]> = [
  [/hostinger/i, ["hostingermail1", "hostingermail2", "hostingermail3"]],
  [/google|gmail/i, ["google"]],
  [/outlook|microsoft|office365/i, ["selector1", "selector2"]],
  [/zoho/i, ["zoho", "zmail"]],
  [/brevo|sendinblue/i, ["brevo", "mail"]],
  [/resend/i, ["resend"]],
  [/mailgun/i, ["k1", "mailo", "smtp"]],
  [/sendgrid/i, ["s1", "s2"]],
  [/postmark/i, ["pm"]],
];

async function txt(name: string): Promise<string[]> {
  try { return (await dns.resolveTxt(name)).map((r) => r.join("")); } catch { return []; }
}

export async function checkDomain(email: string, smtpHost?: string | null): Promise<DnsReport> {
  const domain = (email.split("@")[1] ?? "").toLowerCase();
  const [root, dmarcTxt, mx] = await Promise.all([
    txt(domain), txt(`_dmarc.${domain}`),
    dns.resolveMx(domain).catch(() => [] as Array<{ exchange: string; priority: number }>),
  ]);

  const spf = root.find((r) => /^v=spf1/i.test(r)) ?? null;
  const dmarc = dmarcTxt.find((r) => /^v=DMARC1/i.test(r)) ?? null;

  // محدّدات مزوّد الإرسال أولاً حين يُعرَف — ثم البقية.
  const hinted = BY_HOST.find(([re]) => re.test(smtpHost ?? ""))?.[1] ?? [];
  const order = [...hinted, ...SELECTORS.filter((x) => !hinted.includes(x))];
  let selector: string | null = null;
  for (const sel of order) {
    // بعض المزوّدين يضعون DKIM كـ CNAME يشير إلى مفاتيحهم لا كـ TXT.
    const [t, c] = await Promise.all([
      txt(`${sel}._domainkey.${domain}`),
      dns.resolveCname(`${sel}._domainkey.${domain}`).catch(() => [] as string[]),
    ]);
    if (t.some((x) => /v=DKIM1|k=rsa|p=/i.test(x)) || c.length > 0) { selector = sel; break; }
  }

  return {
    domain,
    spf: {
      found: !!spf, record: spf,
      ok: !!spf && !/\+all/.test(spf),
      note: !spf ? "لا يوجد سجل SPF — أضف TXT على الجذر مثل: v=spf1 include:<مزوّدك> ~all"
        : /\+all/.test(spf) ? "SPF يسمح للجميع (+all) — يجب أن ينتهي بـ ~all أو -all"
        : "SPF موجود",
    },
    dmarc: {
      found: !!dmarc, record: dmarc,
      ok: !!dmarc && /p=(none|quarantine|reject)/i.test(dmarc),
      // `rua` ليست تفصيلاً: بدونها لا تصل تقارير المصادقة، فلا يُعرف من
      // يرفض بريدنا ولا لماذا — ويبقى p=none إلى الأبد بلا دليل يرفعه.
      note: !dmarc ? `لا يوجد DMARC — أضف TXT على _dmarc: v=DMARC1; p=none; rua=mailto:dmarc@${domain}`
        : !/rua=/i.test(dmarc) ? "DMARC موجود بلا rua — لا تصلك تقارير المصادقة، فلا تعرف من يرفض بريدك. أضف rua=mailto:dmarc@" + domain
        : /p=none/i.test(dmarc) ? "DMARC بوضع المراقبة (p=none) — مقبول للبداية، ويُرفع إلى quarantine بعد أسبوعين من تقارير نظيفة"
        : "DMARC موجود ومُفعَّل",
    },
    dkim: {
      found: !!selector, selector,
      note: selector ? `DKIM موجود (selector: ${selector})` : "لم أجد DKIM على المحددات الشائعة — فعّله من مزوّد بريدك وأضف السجل الذي يعطيك",
    },
    mx: { found: mx.length > 0, hosts: mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange) },
  };
}
