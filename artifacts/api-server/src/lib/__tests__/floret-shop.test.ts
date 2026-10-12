// The gold house: a piece priced by the owner's rule, a weight read from a
// customer's words, the catalogue entry an employee reads, the shop's
// situations and readings, the seven-rung ladder, and the keeper's rules.

export {};
const { quote, quoteText, parseWeightKarat, rateForKarat } = await import("../catalog/pricing");
const { pieceEntry } = await import("../catalog/floret");
const { situationOf, read, replyPrompt, dialectOf } = await import("../reply-brain");
const { checkReply, blocksSend } = await import("../reply-check");
const { JEWELRY_ANGLE } = await import("../smart-followup");
const { dueRung, angleFor, SHOP_LADDER, RUNG_ANGLE } = await import("../smart-followup");
const { photoAsText } = await import("../vision");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

// ── Pricing: the shop's own example, (12.87×433.05 + 12.87×45)×1.05 = 6460 ──
const r24 = 433.05 * 24 / 21;
const q = quote(12.87, 21, r24);
check("the clover set prices as the shop's system priced it", q.total === 6460, String(q.total));
check("21k is 21/24 of the 24k rate", Math.abs(rateForKarat(494.92, 21) - 433.055) < 0.01);
check("the quote text shows the arithmetic once and says all-in", quoteText(q).includes("شامل الضريبة") && quoteText(q).includes("مصنعية 45"));
check("«كم سعر ١٥ جرام عيار ٢١» is read", JSON.stringify(parseWeightKarat("كم سعر ١٥ جرام عيار ٢١", 21)) === '{"weightG":15,"karat":21}');
check("a weight without a karat takes the default", parseWeightKarat("price for 8.5g?", 21)?.karat === 21 && parseWeightKarat("price for 8.5g?", 21)?.weightG === 8.5);
check("no weight, no quote", parseWeightKarat("كم السعر؟", 21) === null);

// ── The entry an employee reads ───────────────────────────────────
const e = pieceEntry({ sku: "FLR-TQM-0019", name: "طقم الكلوفر بالخاتم", purity: 21, weightG: 12.87, priceAed: 6460, tagline: "سلسلة ناعمة", highlights: ["كلوفر"], occasion: ["wedding"], audience: ["women"], inStock: true, slug: "clover-set" }, "http://localhost:4321");
check("the entry says karat, weight, price all-in and stock", ["عيار 21", "12.87 جم", "6,460 درهم شامل الضريبة", "متوفر"].every((k) => e.content.includes(k)));
check("...and its SKU, so a resync replaces rather than duplicates", e.content.includes("رمز القطعة: FLR-TQM-0019"));
check("occasion and audience are in Arabic", e.content.includes("زفاف") && e.content.includes("نسائي"));

// ── The shop's situations ─────────────────────────────────────────
check("a weight typed is a price-by-weight question", situationOf("كم ١٥ جرام عيار ٢١", "jewelry") === "weight_price");
check("a photo is a photo", situationOf(photoAsText("طقم ذهب أصفر"), "jewelry") === "photo");
check("«أبغى أطلبه» is an order", situationOf("أبغى أطلبه", "jewelry") === "order");
check("an ad click with a greeting is an ad lead", read("السلام عليكم", { vertical: "jewelry", ad: { title: "طقم الكلوفر" } }).situation === "ad_lead");
check("a piece named outranks a generic question", read("طقم الكلوفر متوفر؟", { vertical: "jewelry", piece: "طقم الكلوفر بالخاتم" }).situation === "piece");
const dec = read("لا شكراً", { vertical: "jewelry" });
check("a decline closes, mentions the showroom, asks nothing", dec.closes && !dec.mayAsk && dec.goal.includes("العين"));
check("the licence question never appears for a shop", !read("شكراً", { vertical: "jewelry" }).forbid.some((f) => f.includes("مين لاند")) && read("شكراً", { vertical: "jewelry" }).forbid.some((f) => f.includes("الرخصة")));
const p = replyPrompt({ name: "نورة", firm: "فلوريت", reading: read("كم ١٥ جرام", { vertical: "jewelry" }), vertical: "jewelry", dialect: "gulf", facts: "- السعر المحسوب: ٧٬٥٢٩ درهم" });
check("the shop prompt carries the jeweller's examples and the Emirati register", p.includes("مصنعية ٤٥") && p.includes("إماراتية طبيعية") && !p.includes("Pro Count"));
check("...and the computed quote as a fact", p.includes("٧٬٥٢٩"));

// ── The ladder ────────────────────────────────────────────────────
const H = 3_600_000, now = Date.UTC(2026, 9, 12, 9);
const at = (h: number) => new Date(now - h * H);
check("seven rungs: 1h 6h 1d 3d 1w 2w 1mo", SHOP_LADDER.join() === "1,6,24,72,168,336,720");
const spoke = [{ fromMe: true, text: "x", at: at(10) }, { fromMe: false, text: "مهتمة", at: at(3) }, { fromMe: true, text: "y", at: at(2) }];
check("rung 1 is due an hour after our reply", dueRung(spoke, [], false, now, { ladder: SHOP_LADDER })?.rung === 0);
check("rung 2 waits six hours", dueRung(spoke, [at(1.5)], false, now, { ladder: SHOP_LADDER }) === null);
check("seven at most", dueRung(spoke, [1, 1, 1, 1, 1, 1, 1].map((_, i) => at(2 - i * 0.1)), false, now, { ladder: SHOP_LADDER }) === null);
const reached = [{ fromMe: true, text: "campaign", at: at(30) }];
check("someone reached who never wrote is followed when the scope is all", dueRung(reached, [], false, now, { ladder: SHOP_LADDER, scope: "all" })?.rung === 0);
check("...and not when the scope is spoke", dueRung(reached, [], false, now, { ladder: SHOP_LADDER, scope: "spoke" }) === null);
check("the last rung is always the farewell, whatever the ladder", angleFor(6, 7) === RUNG_ANGLE[RUNG_ANGLE.length - 1] && angleFor(3, 4) === RUNG_ANGLE[RUNG_ANGLE.length - 1] && angleFor(3, 7) !== RUNG_ANGLE[RUNG_ANGLE.length - 1]);

// ── The hard ban: no number the facts do not hold ─────────────────
const strict = checkReply("الطقم عيار ٢١ ووزنه ١٤ جم وسعره ٧,٢٠٠ درهم", { customer: "كم وزن الطقم؟", facts: "طقم الكلوفر — عيار 21 · 12.87 جم · 6,460 درهم", strictNumbers: true });
check("a weight or price not in the facts stops the send", blocksSend(strict) && strict.issues.some((i) => i.code === "invented-strict"));
const honest = checkReply("الطقم عيار ٢١ ووزنه ١٢.٨٧ جم وسعره اليوم ٦,٤٦٠ درهم شامل الضريبة. لأي مناسبة؟", { customer: "كم وزن الطقم؟", facts: "طقم الكلوفر — عيار 21 · 12.87 جم · 6,460 درهم", strictNumbers: true });
check("the catalogue's own numbers pass", !blocksSend(honest) && !honest.issues.some((i) => i.code.startsWith("invented")), honest.issues.map((i) => i.note).join(" | "));
check("«أتأكد لك» with no number passes", !blocksSend(checkReply("أتأكد لك من وزن القطعة وأرد عليك خلال دقائق — تبين صورة أوضح؟", { customer: "كم وزنه", strictNumbers: true })));
check("Yemeni is read", dialectOf("اشتي اعرف بش سعر الطقم حقك عاد") === "yemeni");
check("seven benefit angles for the shop, the last a farewell", JEWELRY_ANGLE.length === 7 && JEWELRY_ANGLE[0]!.includes("صورة") && JEWELRY_ANGLE[6]!.includes("ختام"));
check("the shop prompt bans uncertain numbers in words", replyPrompt({ name: "نورة", firm: "فلوريت", reading: read("كم وزنه", { vertical: "jewelry" }), vertical: "jewelry" }).includes("ممنوع منعاً باتاً"));

// ── The voice: hospitality passes, corporate fails ────────────────
const warm = checkReply("هلا والله فيچ 🌸 شفت إنچ سألتي عن طقم الكلوفر، وحبيت أقولچ إنه عيار ٢١ ووزنه ١٢.٨٧ جرام وسعره اليوم ٦,٤٦٠ درهم شامل الضريبة. لو تبين أصوّره لچ من زاوية ثانية قولي لي وأرسله على طول. نورة", { customer: "طقم الكلوفر", facts: "طقم الكلوفر — عيار 21 · 12.87 جم · 6,460 درهم", strictNumbers: true, warm: true });
check("a warm hand-written five-line message passes the shop's check", warm.score >= 85 && !warm.issues.some((i) => ["robotic", "long", "invented-strict"].includes(i.code)), warm.issues.map((i) => i.note).join(" | "));
const corp = checkReply("عزيزي العميل، يسعدنا إبلاغكم بتوفر منتجاتنا. هل وصلتك رسالتي السابقة؟", { customer: "x", warm: true });
check("corporate language still fails", corp.issues.some((i) => i.code === "robotic"));
check("the shop reply prompt carries the human voice and its hand-written examples", replyPrompt({ name: "نورة", firm: "فلوريت", reading: read("مهتمة", { vertical: "jewelry" }), vertical: "jewelry" }).includes("كيف يكتب إنسان على واتساب"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
