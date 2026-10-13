// ── الوصول: أن تصل الرسالة الصندوق، لا مجلد الإعلانات ─────────────
// الإرسال والوصول شيئان. النظام كان يقيس الأول جيداً — خرجت، فشلت،
// ارتدّت — ولا يقيس الثاني أبداً. ورسالةٌ تصل مجلد الإعلانات «أُرسلت»
// في كل جدولٍ عندنا، ولا يراها أحد.
//
// وأربعة أشياء تحكم الوصول، وكلها قابلة للقياس من هنا:
//
//   ١ · المصادقة — هل يُصدّق المستلم أن الرسالة منّا. وهذا أثقلها:
//       جوجل وياهو يشترطان SPF وDKIM وDMARC معاً على المُرسِل الجماعي
//       منذ ٢٠٢٤، والناقص منها ليس نقصاً في الدرجة بل في الشرط.
//   ٢ · السمعة — الارتداد والشكاوى ونسبة من يتفاعل. ونطاقٌ واحد سيّئ
//       السمعة لا يُصلحه نصٌّ جميل.
//   ٣ · القائمة — عناوين لا تستقبل، وعناوين أقسامٍ لا أشخاص.
//   ٤ · النص — ما يقرؤه المرشِّح قبل أن يقرأه الإنسان: كثرة الروابط،
//       والصراخ، وكلمات الإعلانات، ونصٌّ كله صورة.
//
// ولا شيء هنا تخمين: كل بندٍ يُفحص فعلاً — سجلات DNS تُسأل الآن،
// والأرقام من القاعدة — ومعه السجل الذي يُلصق حرفياً أو العدد الذي
// يُصلَح.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { checkDomain, type DnsReport } from "./dns";
import { getSettings } from "./service";
import { trackingState, probePublicUrl } from "./public-url";

export interface ReachCheck {
  id: string;
  group: "auth" | "reputation" | "list" | "content" | "setup";
  title: string;
  state: "ok" | "warn" | "fail";
  /** ما وُجد — عدداً أو سجلاً، لا صفة. */
  detail: string;
  /** لماذا يهمّ: أثره على الوصول لا تعريفه. */
  why?: string;
  /** ما يُفعل بالضبط. وإن كان سجل DNS فنصُّه كاملاً ليُلصق. */
  fix?: string;
  /** سجلٌ يُنسخ كما هو. */
  record?: { name: string; type: string; value: string };
  /** وزنه في الدرجة. */
  weight: number;
}

export interface ReachReport {
  score: number;              // ٠..١٠٠
  verdict: string;
  domain: string;
  checks: ReachCheck[];
  /** أهم ثلاثة بالترتيب — ما يُفعل اليوم. */
  next: string[];
}

const rows = <T = any>(r: any): T[] => (r.rows ?? r) as T[];
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

// ── النص: ما يقرؤه المرشِّح ──────────────────────────────────────
// هذه ليست «كلمات ممنوعة» بالمعنى الساذج — لا مرشِّح يرفض لكلمة. لكن
// اجتماع عدةٍ منها مع روابط كثيرة وصراخٍ يرفع الدرجة حتى يُصنَّف.
const SPAMMY = /\b(free|100% free|risk[- ]free|guarantee[ds]?|act now|limited time|urgent|winner|congratulations|cash bonus|no obligation|click here|buy now|order now|cheap|discount|special promotion|earn \$|make money|double your|credit card|no catch|why pay more)\b|مجان(?:اً|ي)|اربح|عرض محدود|سارع|اضغط هنا|اشتر الآن|خصم هائل|بدون التزام|اكسب المال/gi;
const SHOUT = /\b[A-Z]{5,}\b/g;

export function contentSignals(subject: string, html: string): ReachCheck[] {
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const links = (html.match(/<a\s[^>]*href=/gi) ?? []).length;
  const imgs = (html.match(/<img\s/gi) ?? []).length;
  const spam = [...new Set((`${subject} ${text}`.match(SPAMMY) ?? []).map((x) => x.toLowerCase()))];
  const shouts = [...new Set((`${subject} ${text}`.match(SHOUT) ?? []))].filter((w) => !/^(AML|CFT|CPF|VAT|UAE|KYC|CDD|MLRO|DNFBP|DPMS|FTA|PDF|SME|CEO|CFO|ACCA|CAMS)$/.test(w));
  const bangs = (subject.match(/[!！]/g) ?? []).length;
  const out: ReachCheck[] = [];

  out.push(words >= 40
    ? { id: "c_words", group: "content", title: "طول النص", state: "ok", detail: `${words} كلمة`, weight: 3 }
    : { id: "c_words", group: "content", title: "نصٌّ قصير جداً", state: "warn", detail: `${words} كلمة فقط`, weight: 3,
        why: "رسالةٌ كلها صورةٌ أو سطران يقرؤها المرشِّح كإعلان: لا نصَّ يحكم عليه.",
        fix: "اجعل الرسالة نصاً حقيقياً لا صورة — أربعين كلمة على الأقل." });

  out.push(links <= 3
    ? { id: "c_links", group: "content", title: "عدد الروابط", state: "ok", detail: `${links} رابط`, weight: 3 }
    : { id: "c_links", group: "content", title: "روابط كثيرة", state: "warn", detail: `${links} رابطاً في رسالة واحدة`, weight: 3,
        why: "كثرة الروابط من أقوى إشارات الإعلان، وتُضعف أيضاً أثر الدعوة الواحدة.",
        fix: "ثلاثة روابط على الأكثر: الدعوة، والموقع، وإلغاء الاشتراك." });

  out.push(imgs === 0 || words / Math.max(1, imgs) >= 40
    ? { id: "c_img", group: "content", title: "نسبة النص إلى الصور", state: "ok", detail: imgs ? `${imgs} صورة مقابل ${words} كلمة` : "بلا صور", weight: 2 }
    : { id: "c_img", group: "content", title: "صورٌ أكثر من النص", state: "warn", detail: `${imgs} صورة مقابل ${words} كلمة`, weight: 2,
        why: "رسالةٌ معظمها صورٌ تُحجب صورها افتراضياً فتصل فارغة — ويقرؤها المرشِّح كإعلان.",
        fix: "اجعل الرسالة نصاً، والصورة للتوقيع أو الشعار فقط." });

  out.push(spam.length === 0
    ? { id: "c_spam", group: "content", title: "كلمات الإعلانات", state: "ok", detail: "لا شيء", weight: 4 }
    : { id: "c_spam", group: "content", title: "كلمات ترفع درجة الإزعاج", state: spam.length > 2 ? "fail" : "warn",
        detail: `${spam.length}: ${spam.slice(0, 6).join("، ")}`, weight: 4,
        why: "لا مرشِّح يرفض لكلمة واحدة، لكن اجتماعها مع الروابط والصراخ هو ما يُصنِّف.",
        fix: "استبدلها بما يقوله محاسبٌ لمدير مالي: ما تفعله بالضبط، لمن فعلته." });

  out.push(shouts.length === 0 && bangs === 0
    ? { id: "c_shout", group: "content", title: "الصراخ وعلامات التعجّب", state: "ok", detail: "لا شيء", weight: 2 }
    : { id: "c_shout", group: "content", title: "صراخٌ أو تعجّب", state: "warn",
        detail: [shouts.length ? `${shouts.length} كلمة بأحرف كبيرة (${shouts.slice(0, 3).join("، ")})` : "", bangs ? `${bangs} علامة تعجّب في العنوان` : ""].filter(Boolean).join(" · "),
        weight: 2, why: "علامة التعجّب في عنوان بريد عملٍ من أقدم علامات الإعلان.",
        fix: "احذفها، واكتب الاختصارات المعروفة فقط بأحرف كبيرة (AML، VAT)." });

  return out;
}

/** تقرير الوصول كاملاً للحساب. */
export async function reachReport(userId: number): Promise<ReachReport> {
  const s = await getSettings(userId);
  const domain = (s?.fromEmail?.split("@")[1] ?? "").toLowerCase();
  const checks: ReachCheck[] = [];

  if (!s?.fromEmail) {
    return { score: 0, verdict: "لا عنوان مُرسِل بعد — لا شيء يُقاس.", domain: "", checks: [], next: ["اضبط بريد المُرسِل في: البريد → الإعدادات."] };
  }

  // ── ١ · المصادقة ──
  const dns: DnsReport = await checkDomain(s.fromEmail, s.smtpHost).catch(() => ({
    domain, spf: { found: false, record: null, ok: false, note: "تعذّر الفحص" },
    dmarc: { found: false, record: null, ok: false, note: "تعذّر الفحص" },
    dkim: { found: false, selector: null, note: "تعذّر الفحص" }, mx: { found: false, hosts: [] },
  } as DnsReport));

  checks.push(dns.spf.ok
    ? { id: "spf", group: "auth", title: "SPF", state: "ok", detail: dns.spf.record ?? "", weight: 12 }
    : { id: "spf", group: "auth", title: "SPF", state: "fail", detail: dns.spf.note, weight: 12,
        why: "يقول للمستلم أي خوادم يحقّ لها الإرسال باسم نطاقك. بدونه يُعامَل بريدك كمنتحِل.",
        record: { name: domain, type: "TXT", value: "v=spf1 include:_spf.mail.hostinger.com ~all" } });

  // DKIM: التوقيع. وغيابه هو أثقل ما يمكن أن ينقص اليوم.
  checks.push(dns.dkim.found
    ? { id: "dkim", group: "auth", title: "DKIM", state: "ok", detail: `موجود (المحدّد: ${dns.dkim.selector})`, weight: 18 }
    : { id: "dkim", group: "auth", title: "DKIM غير مفعّل", state: "fail",
        detail: `لا توقيع على نطاق ${domain} — فُحصت كل المحدّدات المعروفة لمزوّدك`, weight: 18,
        why: "التوقيع الرقمي الذي يُثبت أن الرسالة لم تُبدَّل وأنها منك. جوجل وياهو يشترطانه على كل مُرسِلٍ جماعي منذ ٢٠٢٤، وبدونه تذهب نسبةٌ من بريدك إلى مجلد الإعلانات مهما كان نصُّه.",
        fix: /hostinger/i.test(s.smtpHost ?? "")
          ? "من لوحة Hostinger: Emails → نطاقك → DNS/Records، فعّل DKIM — تُعطيك ثلاثة سجلات hostingermail1/2/3._domainkey. أضفها في DNS ثم اضغط «افحص» هنا."
          : "فعّل DKIM من لوحة مزوّد بريدك، وأضف السجل الذي يعطيك في DNS نطاقك." });

  const dmarcRec = dns.dmarc.record ?? "";
  checks.push(!dns.dmarc.found
    ? { id: "dmarc", group: "auth", title: "DMARC", state: "fail", detail: "لا سجل", weight: 10,
        why: "يقول للمستلم ماذا يفعل حين تفشل المصادقة، وبدونه لا سياسة لنطاقك.",
        record: { name: `_dmarc.${domain}`, type: "TXT", value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}` } }
    : !/rua=/i.test(dmarcRec)
      ? { id: "dmarc", group: "auth", title: "DMARC بلا تقارير", state: "warn", detail: dmarcRec, weight: 10,
          why: "بلا rua لا تصلك تقارير المصادقة، فلا تعرف من يرفض بريدك ولا لماذا — ويبقى p=none إلى الأبد بلا دليلٍ يرفعه.",
          record: { name: `_dmarc.${domain}`, type: "TXT", value: `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1` } }
      : { id: "dmarc", group: "auth", title: "DMARC", state: "ok", detail: dmarcRec, weight: 10 });

  // ── ٢ · السمعة ──
  const r = rows(await db.execute<any>(sql`
    SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int                         AS sent,
           count(*) FILTER (WHERE bounced_at IS NOT NULL)::int                      AS bounced,
           count(*) FILTER (WHERE replied_at IS NOT NULL)::int                      AS replied,
           count(*) FILTER (WHERE sent_at > now() - interval '30 days')::int         AS sent30,
           count(*) FILTER (WHERE bounced_at > now() - interval '30 days')::int      AS bounced30
    FROM email_messages WHERE user_id = ${userId}`))[0] ?? {};
  const sent = Number(r.sent ?? 0), bounced30 = Number(r.bounced30 ?? 0), sent30 = Number(r.sent30 ?? 0);
  const bRate = pct(bounced30, sent30);

  checks.push(sent30 < 50
    ? { id: "bounce", group: "reputation", title: "نسبة الارتداد", state: "ok", detail: `${sent30} رسالة في ٣٠ يوماً — عيّنة أصغر من أن يُحكم عليها`, weight: 8 }
    : bRate < 2
      ? { id: "bounce", group: "reputation", title: "نسبة الارتداد", state: "ok", detail: `${bRate}٪ (${bounced30} من ${sent30})`, weight: 8 }
      : { id: "bounce", group: "reputation", title: "نسبة الارتداد مرتفعة", state: bRate >= 5 ? "fail" : "warn",
          detail: `${bRate}٪ (${bounced30} من ${sent30})`, weight: 8,
          why: "فوق ٢٪ إشارةُ قائمةٍ غير منظّفة، وفوق ٥٪ يبدأ المزوّدون بحجز بريدك. والارتداد يضرّ سمعة نطاقك لا نطاقهم.",
          fix: "نظّف القائمة من «الجمهور»: النطاقات التي لا تستقبل تُستبعَد تلقائياً، وتبقى العناوين الخاطئة كتابياً." });

  const replyRate = pct(Number(r.replied ?? 0), sent);
  checks.push(sent < 100
    ? { id: "engage", group: "reputation", title: "التفاعل", state: "ok", detail: `${sent} رسالة — مبكّر على الحكم`, weight: 6 }
    : replyRate >= 0.5
      ? { id: "engage", group: "reputation", title: "نسبة الردّ", state: "ok", detail: `${replyRate}٪ (${r.replied} من ${sent})`, weight: 6 }
      : { id: "engage", group: "reputation", title: "تفاعلٌ منخفض", state: "warn", detail: `${replyRate}٪ ردّ من ${sent} رسالة`, weight: 6,
          why: "المزوّدون يقيسون ما يفعله المستلم: ردٌّ أو نقلٌ من الإعلانات إلى الوارد يرفع سمعتك، والتجاهل التام يخفضها.",
          fix: "أرسل لمن يُرجَّح أن يردّ أولاً — القطاع الذي ردّ، والعناوين الشخصية قبل عناوين الأقسام." });

  // ── ٣ · القائمة ──
  const q = rows(await db.execute<any>(sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'active')::int AS active,
           count(*) FILTER (WHERE mx_ok = false)::int     AS bad,
           count(*) FILTER (WHERE mx_ok IS NULL)::int     AS unchecked,
           count(*) FILTER (WHERE email ~* '^(info|sales|admin|contact|support|hello|enquiry|enquiries|office|mail|general|reception)@')::int AS role_addr
    FROM email_contacts WHERE user_id = ${userId}`))[0] ?? {};
  const bad = Number(q.bad ?? 0), total = Number(q.total ?? 0), role = Number(q.role_addr ?? 0);

  checks.push(bad === 0
    ? { id: "l_bad", group: "list", title: "نطاقات لا تستقبل", state: "ok", detail: "لا شيء", weight: 8 }
    : { id: "l_bad", group: "list", title: "نطاقات لا تستقبل بريداً", state: pct(bad, total) >= 10 ? "fail" : "warn",
        detail: `${bad} من ${total} (${pct(bad, total)}٪)`, weight: 8,
        why: "كل واحدٍ منها ارتدادٌ مؤكّد. وهذه وحدها قادرة على رفع نسبة الارتداد فوق الحد وإيقاف الإرسال كله.",
        fix: "مُستبعَدة تلقائياً من كل موجة. راجع عيّنةً منها في «الجمهور»: كثيرٌ منها خطأٌ كتابي في الملف الأصلي يُصلَح ويعود." });

  checks.push(Number(q.unchecked ?? 0) === 0
    ? { id: "l_unchecked", group: "list", title: "فحص النطاقات", state: "ok", detail: "كل العناوين مفحوصة", weight: 4 }
    : { id: "l_unchecked", group: "list", title: "نطاقات غير مفحوصة", state: "warn", detail: `${q.unchecked} عنواناً`, weight: 4,
        why: "الإرسال الأعمى يرتدّ، والارتداد يُحرق سمعة نطاقنا.", fix: "تُفحص تلقائياً قبل أول إرسال — أو افحصها الآن من «الجمهور»." });

  checks.push(pct(role, total) < 40
    ? { id: "l_role", group: "list", title: "عناوين الأقسام", state: "ok", detail: `${role} من ${total} (${pct(role, total)}٪)`, weight: 4 }
    : { id: "l_role", group: "list", title: "أكثر القائمة عناوين أقسام", state: "warn", detail: `${role} من ${total} (${pct(role, total)}٪)`, weight: 4,
        why: "info@ وsales@ يقرؤها موظف استقبال، فتُفتح أقل وتُحوَّل أقل — وبعض المرشِّحات تعاملها بحذر أكبر.",
        fix: "ابحث عن عنوان المالك أو المدير المالي لأكبر الشركات، واجعل رسالة الباقي تطلب التحويل صريحاً." });

  // ── ٤ · الإعداد ──
  // الحارس يفحص كل ربع ساعة، لكن عمليةً بدأت للتوّ لم تفحص بعد — فلا
  // تقل «يعمل» لما لم يُجرَّب. أول تشغيلٍ لهذا التقرير ادّعى أن القياس
  // يعمل عبر نفقٍ كان ميتاً منذ يومين.
  const tr = await trackingState(userId);
  const probe = tr.can && tr.base ? await probePublicUrl(tr.base, 6_000) : null;
  checks.push(tr.can && probe?.ok
    ? { id: "track", group: "setup", title: "قياس الفتح والنقر", state: "ok", detail: `يعمل عبر ${tr.base} (${probe.ms}ms)`, weight: 5 }
    : tr.can && probe && !probe.ok
    ? { id: "track", group: "setup", title: "العنوان العام لا يستجيب", state: "warn",
        detail: `${tr.base} — ${probe.why}`, weight: 5,
        why: "لا يمنع الوصول، لكنه يمنعك من معرفة إن كنت تصل. والروابط تُترك بلا لفّ كي لا تُكسر في بريد العميل.",
        fix: "إن كان نفقاً مؤقّتاً فقد تغيّر عنوانه — شغّله وضع العنوان الجديد في الإعدادات." }
    : { id: "track", group: "setup", title: "لا قياس للفتح", state: "warn", detail: tr.why ?? "", weight: 5,
        why: "لا يؤثّر في الوصول نفسه، لكنه يمنعك من معرفة إن كنت تصل أصلاً.", fix: tr.howTo[0] ?? "" });

  checks.push(s.warmup
    ? { id: "warm", group: "setup", title: "التدرّج", state: "ok", detail: `مفعّل · الحصة اليومية ${s.dailyCap}`, weight: 5 }
    : { id: "warm", group: "setup", title: "التدرّج مُطفأ", state: "warn", detail: `الحصة اليومية ${s.dailyCap} دفعةً واحدة`, weight: 5,
        why: "نطاقٌ جديد يرسل مئاتٍ في يومه الأول يُقرأ كمُرسِلٍ جماعي مفاجئ — وهذا أسرع طريق إلى الحجب.",
        fix: "شغّل التدرّج في الإعدادات: يرفع الحصة تدريجياً مع عمر المُرسِل." });

  checks.push({ id: "unsub", group: "setup", title: "إلغاء الاشتراك بنقرة", state: "ok",
    detail: "ترويسات List-Unsubscribe وOne-Click مُرسَلة مع كل رسالة", weight: 5,
    why: "جوجل وياهو يشترطانها على المُرسِل الجماعي، وغيابها وحده يكفي للحجب." });

  // ── الدرجة ──
  const max = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.state === "ok" ? c.weight : c.state === "warn" ? c.weight * 0.5 : 0), 0);
  const score = Math.round((got / Math.max(1, max)) * 100);

  const fails = checks.filter((c) => c.state === "fail").sort((a, b) => b.weight - a.weight);
  const warns = checks.filter((c) => c.state === "warn").sort((a, b) => b.weight - a.weight);
  const next = [...fails, ...warns].slice(0, 3).map((c) => `${c.title}: ${c.fix ?? c.detail}`);

  return {
    score, domain, checks,
    verdict: fails.length
      ? `${score}/100 — ${fails.length === 1 ? "عائقٌ واحد يمنع" : `${fails.length} عوائق تمنع`} وصول نسبةٍ من بريدك: ${fails.map((f) => f.title).join("، ")}.`
      : warns.length
        ? `${score}/100 — لا عائق يمنع الوصول، و${warns.length} ملاحظة ترفع النسبة.`
        : `${score}/100 — كل ما يحكم الوصول مضبوط.`,
    next: next.length ? next : ["لا شيء عاجل. راقب الارتداد بعد كل موجة."],
  };
}
