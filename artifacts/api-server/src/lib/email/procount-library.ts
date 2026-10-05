// ── Pro Count's email library ─────────────────────────────────────
// Written for one firm — Pro Count for Accounting L.L.C. — from its own
// knowledge base (reference date 1 October 2026): fifty English templates
// across every service, the real estate AML campaign in English and Arabic,
// and the house voice the team writes in. Every number in here is one the
// knowledge base states; nothing promises compliance, avoided penalties or
// a passed inspection. Installed on the firm's account by name, so running
// it twice adds nothing twice.

export const CONTACT = {
  website: "https://www.pro-count.ae",
  websiteLabel: "www.pro-count.ae",
  phone: "+971 54 232 8336",
  phoneLocal: "054 232 8336",
  whatsapp: "https://wa.me/971542328336",
};

export const SIGNATURE = [
  `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.7">`,
  `<b>Pro Count for Accounting L.L.C.</b> · بروكاونت للمحاسبة<br>`,
  `Accounting · Tax · AML Compliance — Abu Dhabi, UAE<br>`,
  `📞 <a href="tel:+971542328336" style="color:#374151">${CONTACT.phone}</a> · `,
  `<a href="${CONTACT.whatsapp}" style="color:#16a34a">WhatsApp</a> · `,
  `<a href="${CONTACT.website}" style="color:#2563eb">${CONTACT.websiteLabel}</a>`,
  `</p>`,
].join("");

const p = (...xs: string[]) => xs.map((x) => `<p>${x}</p>`).join("\n");
/** A button that opens WhatsApp with the request already written. */
export const cta = (label: string, ask = label) => `<p class="cta"><a href="${CONTACT.whatsapp}?text=${encodeURIComponent(`Hello Pro Count, I would like to ${ask.charAt(0).toLowerCase()}${ask.slice(1)}.`)}">${label}</a></p>`;
const ctaAr = (label: string, ask: string) => `<p class="cta"><a href="${CONTACT.whatsapp}?text=${encodeURIComponent(`مرحباً بروكاونت، أرغب في ${ask}.`)}">${label}</a></p>`;
// The call to action for each service, from the firm's CTA library.
const CTA_BY_CATEGORY: Record<string, string> = {
  "About us": "Book a free consultation",
  "Outsourced Accounting": "Discuss your accounting workload",
  "Financial Reporting": "Book a free consultation",
  "Construction & Engineering": "Discuss your accounting workload",
  "Restaurants": "Book a free consultation",
  "Corporate Tax": "Review your Corporate Tax position",
  "VAT": "Book a VAT review",
  "E-Invoicing": "Assess your eInvoicing readiness",
  "AML Compliance": "Request an AML compliance assessment",
  "Real Estate AML": "Review your AML readiness",
  "Gold & Jewellery": "Assess your DPMS compliance",
};
const ul = (...xs: string[]) => `<ul>${xs.map((x) => `<li>${x}</li>`).join("")}</ul>`;
const HI = "Hello {{first_name|team}},";
const BYE = "Best regards,<br>The Pro Count team";
const CALL = `reply to this email or call/WhatsApp us on ${CONTACT.phone}`;

export interface LibraryTemplate { category: string; name: string; subject: string; html: string }

// ── Fifty templates ───────────────────────────────────────────────
export const TEMPLATES: LibraryTemplate[] = [
  // About us & how we talk
  { category: "About us", name: "01 · Who we are — introduction", subject: "{{company|Your business}} — accounting, tax and compliance in one place",
    html: [p(HI), p("Pro Count is an Abu Dhabi accounting firm that supports UAE businesses with outsourced accounting and bookkeeping, financial reporting, Corporate Tax and VAT, and AML/CFT/CPF compliance."), p("Most owners we speak with are not short of effort — they are short of a clear view: are the books current, is tax handled correctly, and is the business ready if a regulator asks questions?"), p("If it would help, we can have a short call to understand how {{company|your business}} handles accounting and compliance today, and where support would make a difference."), p(BYE)].join("\n") },
  { category: "About us", name: "02 · Who we are — one connected finance function", subject: "Records, reports, tax and compliance — connected",
    html: [p(HI), p("Accurate records lead to reliable reports. Reliable reports make tax compliance straightforward. And clean financial control is what makes a business ready for regulatory questions."), p("At Pro Count we look after that chain for UAE businesses — bookkeeping, financial and management reporting, Corporate Tax and VAT, and AML compliance support — tailored to each company's activity, size and transaction volume."), p(`Would a short conversation about how this works for {{company|your company}} be useful? Simply ${CALL}.`), p(BYE)].join("\n") },
  { category: "About us", name: "03 · What we are — and what we are not", subject: "A quick note on what Pro Count does",
    html: [p(HI), p("A short clarification, because the market mixes these up: Pro Count is not accounting software, a business setup company or a payroll provider."), p("We are a professional accounting and compliance partner. Our team records, reconciles, reviews and reports — and supports your Corporate Tax, VAT and AML obligations — so management can make decisions from numbers it trusts."), p("If {{company|your business}} would benefit from that kind of support, we would be glad to discuss your requirements."), p(BYE)].join("\n") },
  { category: "About us", name: "04 · After a conversation — thank you", subject: "Thank you — next steps for {{company|your company}}",
    html: [p(HI), p("Thank you for your time today. As discussed, the next step is a short assessment of your current accounting, tax and compliance position so we can recommend the right scope."), p("To prepare, it helps to have: your trade licence, your VAT and Corporate Tax registration status, the accounting software you use (if any), and an idea of your monthly transaction volume."), p(`Send these whenever convenient, or ${CALL} if anything is unclear.`), p(BYE)].join("\n") },
  { category: "About us", name: "05 · Last note — closing the loop", subject: "Should I close your file, {{first_name|}}?",
    html: [p(HI), p("I have written a couple of times about accounting and compliance support for {{company|your business}} and have not heard back — which usually means the timing is not right."), p("I will not keep following up. If things change — books falling behind, a tax filing coming up, or an AML question — we are one email away."), p(BYE)].join("\n") },

  // Outsourced accounting & bookkeeping
  { category: "Outsourced Accounting", name: "06 · Books behind", subject: "Are {{company|your}} books up to date?",
    html: [p(HI), p("When bookkeeping falls behind, the cost is not only an untidy ledger — it is decisions made without current numbers, tax filings prepared in a rush, and questions that are hard to answer when they matter."), p("Pro Count can take over daily transaction recording, bank reconciliation, receivables and payables, and month-end closing — and bring overdue periods up to date."), p("Would you like us to review where your books stand today? A short call is enough to scope it."), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "07 · Owner-managed without a finance team", subject: "Running {{company|the business}} without a finance team?",
    html: [p(HI), p("Many owner-managed businesses in the UAE run without a dedicated finance function. It works — until the owner needs a clear answer on profit, cash or tax, and the information is not ready."), p("Outsourced accounting gives you a team that records, reconciles and reports every month, so you know what is happening financially without managing accounting yourself every day."), p("Shall we discuss what a monthly scope could look like for {{company|your business}}?"), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "08 · Internal accountant or outsourced?", subject: "In-house accountant or outsourced — which fits {{company|you}}?",
    html: [p(HI), p("There is no single right answer. An internal accountant brings salary, visa, recruitment, leave cover and supervision; an outsourced team brings people, review and reporting under one engagement."), p("The right model depends on your workload, transaction volume, required expertise and internal resources. Outsourcing tends to make sense when you want a broader finance function without building every role internally."), p("If you are weighing this up, we are happy to talk it through objectively."), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "09 · Month-end closing", subject: "How long does month-end take at {{company|your company}}?",
    html: [p(HI), p("A reliable month-end close is the foundation for everything else: bank reconciliations agreed, receivables and payables reviewed, expenses recorded, and a trial balance management can rely on."), p("Pro Count runs this cycle for UAE businesses every month and delivers the reports that come out of it — P&amp;L, balance sheet and the management view you need."), p("Would it help to compare your current close process with what we deliver?"), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "10 · Growing or multi-branch", subject: "Growing fast — is accounting keeping up at {{company|your company}}?",
    html: [p(HI), p("Growth adds branches, transactions and people — and accounting that worked at one location often struggles at three."), p("We support growing and multi-branch businesses with consistent bookkeeping, branch-level reporting and the tax compliance that comes with scale."), p("If accounting is starting to lag behind the business, let's talk about a structure that keeps up."), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "11 · Why not just software?", subject: "Accounting software is not an accountant",
    html: [p(HI), p("Accounting software records and organises financial information. An outsourced accounting service provides the professional people and process that manage, review, reconcile and interpret it."), p("Software is part of the process — we work with it — but it does not by itself replace professional accounting work."), p("If {{company|your team}} has the software but not the time or expertise to run it properly, we can help."), p(BYE)].join("\n") },
  { category: "Outsourced Accounting", name: "12 · Already have an accountant", subject: "A question for {{company|your team}} about your accounting setup",
    html: [p(HI), p("If you already have an accountant, that can work well. The useful question is whether your current setup gives management the records, reports, tax support and financial visibility the business needs."), p("Some companies use us alongside an internal accountant — for review, reporting or tax support — rather than as a replacement."), p("Happy to discuss where the gaps, if any, are."), p(BYE)].join("\n") },

  // Financial & management reporting
  { category: "Financial Reporting", name: "13 · Do you know your real profit?", subject: "{{company|Your}} sales are up — is profit?",
    html: [p(HI), p("Sales and profit are not the same thing. Many businesses grow revenue while costs quietly absorb the margin."), p("Our financial and management reporting shows where profit is created and where costs consume it: P&amp;L, balance sheet, cash flow and customised reports for the questions you actually ask."), p("Would a sample of what monthly management reporting could look like for {{company|your business}} be useful?"), p(BYE)].join("\n") },
  { category: "Financial Reporting", name: "14 · Reports every owner should see", subject: "The monthly reports every owner should see",
    html: [p(HI), p("Beyond the P&amp;L, the reports that change decisions are usually these:"), ul("Profit by branch, project or product line", "Cash flow — where cash is going and when", "Receivables aging — who is late and by how much", "Expense trends — what is rising, and why", "Budget versus actual"), p("Pro Count prepares monthly, quarterly and customised reports for UAE businesses. If you would like these for {{company|your company}}, let's discuss."), p(BYE)].join("\n") },
  { category: "Financial Reporting", name: "15 · Cash flow visibility", subject: "Do you see {{company|your}} cash flow coming?",
    html: [p(HI), p("Profitable businesses still run short of cash when receivables slip and payments bunch up. The fix starts with visibility: knowing in advance what is coming in and going out."), p("Our reporting includes cash flow statements and receivables/payables aging, so cash pressure shows up early, not on payment day."), p("Shall we look at how cash flow reporting could work for you?"), p(BYE)].join("\n") },
  { category: "Financial Reporting", name: "16 · From records to management information", subject: "Your accounts are recorded — can you decide from them?",
    html: [p(HI), p("Recorded transactions are one thing. Information that answers \"what is our margin?\", \"which branch performs?\", \"are our prices covering cost?\" is another."), p("That step — from accounting records to management information — is where we spend most of our effort with clients."), p("If your reports tell you what happened but not what to do next, let's talk."), p(BYE)].join("\n") },

  // Cost accounting by sector
  { category: "Construction & Engineering", name: "17 · Construction — is each project profitable?", subject: "{{company|Your}} projects — which ones actually make money?",
    html: [p(HI), p("In contracting, a project can show strong revenue while its real margin stays unclear — labour, materials and subcontractor costs are spread across jobs, and the picture only arrives at the end."), p("Pro Count sets up project costing for contractors: direct costs, labour, materials and subcontractors per project, with profitability you can see while the job is still running."), p("Do you know your real margin per project today? If not, a short call could help."), p(BYE)].join("\n") },
  { category: "Construction & Engineering", name: "18 · Construction — budget vs actual", subject: "Budget vs actual on {{company|your}} current projects",
    html: [p(HI), p("Cost overruns rarely arrive as a surprise — they build up in variances nobody had time to review."), p("We help contractors track budget versus actual and cost variance per project, so overruns are visible early enough to act on."), p("Revenue is growing — but is project profitability? Let's discuss your current job costing."), p(BYE)].join("\n") },
  { category: "Construction & Engineering", name: "19 · Engineering & consulting — profit per project", subject: "Profit per project and per client at {{company|your firm}}",
    html: [p(HI), p("For engineering and consulting firms, the cost is people's time. Without allocating employee cost to projects, it is hard to know which projects — and which clients — are profitable."), p("We support project-based firms with cost allocation, utilisation and profitability per project and client, alongside financial reporting and tax."), p("Would it be useful to see how this could work for {{company|your firm}}?"), p(BYE)].join("\n") },
  { category: "Restaurants", name: "20 · Restaurants — sales are not profit", subject: "{{company|Your restaurant}}: busy tables, but where is the margin?",
    html: [p(HI), p("A restaurant can be full every night and still struggle with profit: food cost, waste, supplier price increases and portion control eat into the margin quietly."), p("Our restaurant accounting shows management where profit is being created and where costs are consuming it — food and beverage cost, inventory and supplier analysis."), p("Shall we discuss how {{company|your restaurant}} tracks food cost today?"), p(BYE)].join("\n") },
  { category: "Restaurants", name: "21 · Restaurants — branch profitability", subject: "Which of {{company|your}} branches is really profitable?",
    html: [p(HI), p("Multi-branch F&amp;B groups often see total sales clearly but branch profitability less clearly — differences in waste, inventory leakage and labour cost hide inside the totals."), p("We set up branch-level accounting and reporting so each location's margin is visible and comparable."), p(`If you would like a clearer view by branch, ${CALL}.`), p(BYE)].join("\n") },

  // Corporate Tax
  { category: "Corporate Tax", name: "22 · Corporate Tax registration check", subject: "{{company|Your company}} and Corporate Tax registration",
    html: [p(HI), p("Under Federal Decree-Law No. 47 of 2022, taxable persons are required to register for Corporate Tax and obtain a registration number within the applicable deadlines."), p("Whether and how it applies depends on your legal form, residency, activity and tax period — which is why we check those facts first rather than assume."), p("If you are unsure where {{company|your company}} stands on registration, we can review it with you."), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "23 · First Corporate Tax return", subject: "Preparing {{company|your}} first Corporate Tax return",
    html: [p(HI), p("Corporate Tax applies from the first financial year starting on or after 1 June 2023, at 0% on taxable income up to AED 375,000 and 9% above that, within the general framework."), p("A first return goes much more smoothly when the books, financial statements and adjustments are ready well before the deadline."), p("We can help prepare and review your return. Shall we check your readiness?"), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "24 · Corporate Tax return deadline", subject: "When is {{company|your}} Corporate Tax return due?",
    html: [p(HI), p("Under the UAE Corporate Tax framework, the return and payment are generally due within 9 months from the end of the relevant tax period."), p("If your financial year ends on a date other than 31 December, your deadline falls at a different point in the year — and it is easy to lose track of it."), p("Would you like us to review your Corporate Tax position and timeline?"), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "25 · Small Business Relief", subject: "Could {{company|your business}} be eligible for Small Business Relief?",
    html: [p(HI), p("Small Business Relief is available to eligible resident persons whose revenue is AED 3,000,000 or less in the current and relevant previous periods — subject to the legal conditions and exclusions."), p("Eligibility is not automatic, and choosing the relief is a decision with its own requirements. It is worth confirming against your company's facts."), p("We can review whether the relief may apply to {{company|your business}}."), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "26 · Corporate Tax records", subject: "Are {{company|your}} Corporate Tax records being kept correctly?",
    html: [p(HI), p("The FTA requires Corporate Tax records and documents to be kept for at least 7 years after the end of the relevant tax period."), p("Good records are not only about retention — they are what makes a return defensible if questions arise later."), p("If you would like a review of how your records are organised, we are happy to help."), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "27 · Common Corporate Tax mistakes", subject: "Corporate Tax mistakes SMEs make — and how to avoid them",
    html: [p(HI), p("The issues we see most often are not complex tax questions — they are basics:"), ul("Books not closed or reconciled before filing", "Assuming Small Business Relief applies without checking the conditions", "Missing the deadline for a non-December year end", "Records not organised for later review"), p("Pro Count supports registration, filing and advisory. Would a quick review for {{company|your company}} be useful?"), p(BYE)].join("\n") },
  { category: "Corporate Tax", name: "28 · Post-filing review", subject: "Already filed — but is {{company|your}} tax position reviewed?",
    html: [p(HI), p("Filing the return is one step. Reviewing whether the figures, adjustments and supporting records hold up is another."), p("We offer a Corporate Tax compliance review for companies that have filed and want confidence in their position for the next period."), p("The applicable treatment depends on your company's facts and current FTA guidance — we can go through it with you."), p(BYE)].join("\n") },

  // VAT
  { category: "VAT", name: "29 · VAT registration threshold", subject: "Is {{company|your business}} approaching the VAT threshold?",
    html: [p(HI), p("VAT registration becomes mandatory when taxable supplies and imports exceed AED 375,000 over the last 12 months, or are expected to within the next 30 days. Voluntary registration is possible from AED 187,500, subject to conditions."), p("Growing businesses sometimes cross the threshold without noticing until later."), p("If you would like us to check where {{company|your business}} stands, just reply."), p(BYE)].join("\n") },
  { category: "VAT", name: "30 · VAT returns without the stress", subject: "VAT returns at {{company|your company}} — on time and reconciled?",
    html: [p(HI), p("After registration, each VAT return and payment is due within 28 days from the end of the tax period. When the books are behind, those 28 days go fast."), p("We prepare and file VAT returns from reconciled books, so the return matches your records rather than being assembled under pressure."), p("Shall we take VAT off your list?"), p(BYE)].join("\n") },
  { category: "VAT", name: "31 · VAT reconciliation & input VAT", subject: "Is {{company|your}} input VAT fully supported?",
    html: [p(HI), p("Input VAT is only as strong as the documents behind it. Missing or incorrect tax invoices and unreconciled VAT accounts are among the most common issues in a review."), p("Our VAT review checks reconciliation and input VAT documentation, and fixes what needs fixing before it becomes a question."), p("Would a VAT health check be useful for {{company|your company}}?"), p(BYE)].join("\n") },
  { category: "VAT", name: "32 · Tax invoices", subject: "A quick check on {{company|your}} tax invoices",
    html: [p(HI), p("The UAE VAT framework generally requires tax invoices to be issued within the applicable prescribed period — generally 14 days from the date of supply — with specific rules and exceptions by type of invoice and supply."), p("Getting invoicing right is also the first step towards the eInvoicing programme now being introduced."), p("If you would like your invoicing process reviewed, we can help."), p(BYE)].join("\n") },
  { category: "VAT", name: "33 · VAT record keeping", subject: "How long should {{company|your}} VAT records be kept?",
    html: [p(HI), p("Taxable persons must keep VAT invoices for at least 5 years, per the FTA — and accounting records more broadly must also be kept under the Commercial Companies Law."), p("Organised records save time in any review and protect your input VAT position."), p(`If you would like help organising VAT records, ${CALL}.`), p(BYE)].join("\n") },

  // E-invoicing
  { category: "E-Invoicing", name: "34 · eInvoice is not a PDF", subject: "A PDF invoice is not an eInvoice — what that means for {{company|you}}",
    html: [p(HI), p("Under the UAE eInvoicing programme, an eInvoice is structured invoice data issued and exchanged electronically and reported to the FTA. A PDF, a Word file, a scan or an email on its own is not an eInvoice."), p("That changes the invoicing process itself — and the accounting system behind it."), p("Would you like to assess how ready {{company|your business}} is?"), p(BYE)].join("\n") },
  { category: "E-Invoicing", name: "35 · eInvoicing — AED 50 million and above", subject: "eInvoicing: the 30 October 2026 date for larger businesses",
    html: [p(HI), p("For businesses with annual revenue of AED 50 million or more, the deadline to appoint an Accredited Service Provider has been extended to 30 October 2026, with implementation from 1 January 2027, as the FTA confirmed."), p("That leaves little time to review invoice workflows and system readiness."), p("If {{company|your company}} falls in this group, we can help assess your readiness now."), p(BYE)].join("\n") },
  { category: "E-Invoicing", name: "36 · eInvoicing — below AED 50 million", subject: "eInvoicing for {{company|your business}}: prepare before 2027",
    html: [p(HI), p("For businesses with revenue below AED 50 million, the published plan sets the Accredited Service Provider appointment by 31 March 2027 and implementation from 1 July 2027, under the amended decision."), p("Starting early means time to fix invoice data and processes rather than rushing a system change."), p("Shall we look at your invoicing and accounting setup together?"), p(BYE)].join("\n") },
  { category: "E-Invoicing", name: "37 · eInvoicing readiness assessment", subject: "Assess {{company|your}} eInvoicing readiness",
    html: [p(HI), p("eInvoicing readiness is less about the software purchase and more about the finance process: invoice data quality, accounting system readiness, and the workflow from sale to invoice to report."), p("Pro Count offers an eInvoicing readiness assessment covering your invoice workflow, accounting system and tax communication."), p(`To book one, ${CALL}.`), p(BYE)].join("\n") },

  // AML general
  { category: "AML Compliance", name: "38 · The current AML framework", subject: "UAE AML rules changed — is {{company|your}} framework current?",
    html: [p(HI), p("The UAE's main AML legislation is now Federal Decree-Law No. 10 of 2025, covering money laundering, terrorist financing and proliferation financing. Its implementing regulation, Cabinet Resolution No. 134 of 2025, has been in effect since 14 December 2025."), p("Frameworks written under the previous law may need updating — particularly on beneficial ownership and governance."), p("AML obligations depend on your activity, supervisory authority and risk profile. Would a review of your framework be useful?"), p(BYE)].join("\n") },
  { category: "AML Compliance", name: "39 · goAML is not AML compliance", subject: "Registered on goAML — does that make {{company|you}} compliant?",
    html: [p(HI), p("A common misunderstanding: goAML is the platform used to submit reports such as STRs and SARs. Registering on it is necessary for applicable entities — but it is not, by itself, an AML compliance framework."), p("A framework includes risk assessment, customer due diligence, beneficial owner identification, ongoing monitoring, reporting, training and record keeping."), p("If goAML registration is where your compliance stopped, let's talk about the rest."), p(BYE)].join("\n") },
  { category: "AML Compliance", name: "40 · External AML compliance officer", subject: "An AML compliance function for {{company|your company}}",
    html: [p(HI), p("Not every business needs — or can justify — a full-time in-house compliance officer. Some choose external AML compliance officer / MLRO support, depending on applicability and engagement structure."), p("Pro Count supports DNFBPs with policies and procedures, KYC/CDD, risk assessment, transaction monitoring, screening, training and goAML reporting support."), p("Applicable obligations depend on your activity and regulatory classification. Shall we discuss yours?"), p(BYE)].join("\n") },
  { category: "AML Compliance", name: "41 · KYC is more than a passport copy", subject: "KYC at {{company|your company}}: more than a passport copy",
    html: [p(HI), p("Customer due diligence is not just collecting identity documents. Depending on risk, it can require understanding ownership structure, the beneficial owner, the business activity, the purpose of the relationship and, where appropriate, source of funds or wealth."), p("We help businesses build risk-based CDD files that hold up to review."), p("If your KYC files feel incomplete, we can review them with you."), p(BYE)].join("\n") },
  { category: "AML Compliance", name: "42 · AML training & inspection readiness", subject: "Is {{company|your}} team ready for an AML inspection?",
    html: [p(HI), p("Inspection readiness comes down to whether your policies, risk assessment, customer files, monitoring and training records show a framework that actually operates — not just one written down."), p("Pro Count supports inspection readiness for DNFBPs: documentation review, staff AML training and a gap assessment of what is missing."), p("Our service is designed to help reduce compliance gaps and improve readiness. Shall we start with an assessment?"), p(BYE)].join("\n") },

  // Real estate
  { category: "Real Estate AML", name: "43 · Real estate brokers — AML readiness", subject: "{{company|Your agency}} and AML: beyond goAML registration",
    html: [p(HI), p("Real estate agents and brokers are among the DNFBP categories supervised by the Ministry of Economy and Tourism. For agencies, AML is not only registering on goAML — it is customer due diligence, beneficial ownership, customer risk, transaction monitoring, suspicious activity reporting and record keeping."), p("Pro Count helps real estate agencies build and run that framework, and prepare for inspection."), p("Would you like us to review {{company|your agency}}'s AML readiness?"), p(BYE)].join("\n") },
  { category: "Real Estate AML", name: "44 · Real estate — who is the real buyer?", subject: "{{company|Your agency}}: do you know who is really behind each deal?",
    html: [p(HI), p("The beneficial owner is not always the person signing. Under Federal Decree-Law No. 10 of 2025, it is the natural person who owns or effectively controls — or on whose behalf a transaction is made."), p("For property transactions, that means identifying ownership structures, understanding the purpose of the deal and, where appropriate, the source of funds."), p("We help agencies put this into their CDD process. Shall we discuss yours?"), p(BYE)].join("\n") },
  { category: "Real Estate AML", name: "45 · Real estate — inspection readiness", subject: "If MoET inspected {{company|your agency}} next month",
    html: [p(HI), p("A useful self-check for agencies:"), ul("Is there a current business-wide AML risk assessment?", "Do customer files show CDD and beneficial owner identification?", "Is there a process for monitoring and reporting suspicious activity?", "Have staff received AML training — and is it recorded?"), p("If any answer is unclear, Pro Count can help close the gap. Shall we review your readiness together?"), p(BYE)].join("\n") },

  // Gold & jewellery
  { category: "Gold & Jewellery", name: "46 · DPMS obligations", subject: "{{company|Your store}} and DPMS obligations",
    html: [p(HI), p("Dealers in precious metals and precious stones are a DNFBP category. Under the current implementing regulation, specific requirements apply when a dealer carries out a single cash transaction — or several that appear linked — of AED 55,000 or more."), p("That makes KYC, record keeping and reporting a daily operational matter, not a once-a-year exercise."), p("Would you like us to assess {{company|your store}}'s DPMS compliance?"), p(BYE)].join("\n") },
  { category: "Gold & Jewellery", name: "47 · Gold inventory & cost per gram", subject: "Do you know {{company|your}} real margin per gram?",
    html: [p(HI), p("In gold and jewellery, the books need to follow inventory by weight and purity, cost per gram, making charges and margin — across branches and currencies."), p("Pro Count supports jewellery businesses with inventory accounting, costing, margin analysis, VAT and Corporate Tax."), p("Shall we look at how your inventory and margins are tracked today?"), p(BYE)].join("\n") },
  { category: "Gold & Jewellery", name: "48 · Accounting system for jewellers", subject: "An accounting setup built for jewellers like {{company|you}}",
    html: [p(HI), p("Through our partnership with Platinum Systems, Pro Count offers industry-specific accounting infrastructure and support for gold and jewellery businesses: gold and diamond inventory tracking, cost calculation, profit margins, VAT functionality, customised reporting, multi-branch and multi-currency."), p("It is accounting support designed around how jewellers actually work."), p(`If you would like a walkthrough, ${CALL}.`), p(BYE)].join("\n") },

  // Accountants as DNFBP
  { category: "AML Compliance", name: "49 · Accounting firms under the DNFBP framework", subject: "AML obligations for independent accountants like {{company|your firm}}",
    html: [p(HI), p("Under the 2026 guidance for independent accountants and auditors, accounting firms fall within the DNFBP framework — the nature of accounting and advisory services can expose them to misuse for laundering or concealing ownership."), p("That makes an AML framework part of running an accounting practice, not an optional extra."), p("We support firms with AML policies, risk assessment, training and inspection readiness. Shall we discuss {{company|your firm}}'s position?"), p(BYE)].join("\n") },

  // Sales reply
  { category: "Replies", name: "50 · Reply to a pricing question", subject: "Re: pricing for {{company|your company}}",
    html: [p(HI), p("Thank you for asking. Our fees depend on the scope, so rather than quote a figure that may not fit, we would like to understand a few things first:"), ul("Your industry and number of branches", "Approximate monthly transaction volume", "VAT and Corporate Tax status", "The reports you need, and the state of your current records", "Whether AML obligations apply to your activity"), p(`With that, we can assess the workload and provide a suitable quotation. You can reply here, or call/WhatsApp ${CONTACT.phone} for a quick conversation.`), p(BYE)].join("\n") },
];

const NO_BUTTON = /^(04|05|50) ·/;
for (const t of TEMPLATES) {
  const label = CTA_BY_CATEGORY[t.category];
  if (!label || NO_BUTTON.test(t.name)) continue;
  t.html = t.html.replace(`<p>${BYE}</p>`, `${cta(label)}\n<p>${BYE}</p>`);
}

// ── The real estate campaign ──────────────────────────────────────
export interface CampaignPack { name: string; language: "en" | "ar"; subjects: [string, string]; html: string; followups: Array<{ audience: "warm" | "cold" | "value" | "breakup"; afterHours: number; subject: string; html: string }> }

export const REAL_ESTATE_CAMPAIGN_EN: CampaignPack = {
  name: "Real Estate AML Readiness — English",
  language: "en",
  subjects: ["{{company|Your agency}}: is your AML framework inspection-ready?", "Beyond goAML: what MoET expects from real estate agencies"],
  html: [
    p(HI),
    p("Real estate agents and brokers are among the DNFBP categories supervised by the Ministry of Economy and Tourism — and the rules changed. The UAE's main AML law is now Federal Decree-Law No. 10 of 2025, with its implementing regulation, Cabinet Resolution No. 134 of 2025, in effect since 14 December 2025."),
    p("Many agencies registered on goAML and stopped there. But goAML is the reporting platform; it is not the framework. For an agency, AML means:"),
    ul("A business-wide risk assessment", "Customer due diligence — including who the beneficial owner really is", "Source of funds, where the risk calls for it", "Monitoring and reporting suspicious activity", "Staff training and records that show the framework actually runs"),
    p("Pro Count supports real estate agencies across the UAE with AML policies, KYC/CDD, risk assessment, training, goAML reporting support and inspection readiness — designed to help reduce compliance gaps, tailored to how your agency works."),
    p(`Would {{company|your agency}} like a short AML readiness review? ${CALL[0]!.toUpperCase() + CALL.slice(1)} and we will set a time that suits you.`),
    cta("Book an AML readiness review", "book an AML readiness review for our agency"),
    p(BYE),
  ].join("\n"),
  followups: [
    { audience: "warm", afterHours: 72, subject: "{{company|Your agency}}: who is really behind each deal?",
      html: [p(HI), p("Following up on my note about AML readiness — one point that catches many agencies out: the beneficial owner is not always the person signing."), p("Under the current law, it is the natural person who owns or effectively controls — or on whose behalf a transaction is made. For property deals involving companies or third parties, the CDD file needs to show that."), p("If you would like, we can review a sample of your customer files and tell you honestly where the gaps are. A 20-minute call is enough to start."), cta("Review our customer files", "have our customer due diligence files reviewed"), p(BYE)].join("\n") },
    { audience: "cold", afterHours: 72, subject: "Quick question about {{company|your agency}}'s AML file",
      html: [p(HI), p("Resending in case my earlier note was buried: since 14 December 2025, real estate agencies work under the new AML implementing regulation — and goAML registration alone is not the framework the Ministry of Economy and Tourism expects."), p("Would a short AML readiness review for {{company|your agency}} be useful? It takes about 20 minutes."), cta("Book an AML readiness review", "book an AML readiness review for our agency"), p(BYE)].join("\n") },
    { audience: "value", afterHours: 168, subject: "A 4-question AML check for {{company|your agency}}",
      html: [p(HI), p("A quick self-check for real estate agencies:"), ul("Do you have a current business-wide AML risk assessment?", "Do your customer files identify the beneficial owner?", "Is there a process to report suspicious activity through goAML?", "Is staff AML training recorded?"), p(`If any answer is "not sure", Pro Count can help. ${CALL[0]!.toUpperCase() + CALL.slice(1)}.`), cta("Review your AML readiness"), p(BYE)].join("\n") },
    { audience: "breakup", afterHours: 336, subject: "Closing the loop on AML support for {{company|your agency}}",
      html: [p(HI), p("I have written a couple of times about AML readiness for {{company|your agency}} and will not keep filling your inbox."), p("If an inspection, a new compliance officer, or a question about KYC comes up, we are one email or call away."), p(BYE)].join("\n") },
  ],
};

const HI_AR = "مرحباً فريق {{company|شركتكم}}،";
const BYE_AR = "مع التحية،<br>فريق بروكاونت للمحاسبة";
const CALL_AR = `ردّوا على هذه الرسالة أو تواصلوا معنا هاتفياً أو عبر واتساب على ${CONTACT.phoneLocal}`;

export const REAL_ESTATE_CAMPAIGN_AR: CampaignPack = {
  name: "جاهزية AML للعقارات — عربي",
  language: "ar",
  subjects: ["{{company|شركتكم}}: هل إطار AML لديكم جاهز للتفتيش؟", "التسجيل في goAML وحده لا يكفي — ما المطلوب من الوسطاء العقاريين؟"],
  html: [
    p(HI_AR),
    p("وسطاء ووكالات العقارات من فئات DNFBP الخاضعة لإشراف وزارة الاقتصاد والسياحة، والقواعد تغيّرت: التشريع الرئيسي الآن هو المرسوم بقانون اتحادي رقم 10 لسنة 2025، ولائحته التنفيذية — قرار مجلس الوزراء رقم 134 لسنة 2025 — سارية منذ 14 ديسمبر 2025."),
    p("كثير من الوكالات سجّلت في goAML وتوقفت عند ذلك. لكن goAML منصة لتقديم التقارير، وليست إطار الامتثال نفسه. الامتثال للوكالة العقارية يعني:"),
    ul("تقييم مخاطر شامل للنشاط", "العناية الواجبة بالعملاء، ومعرفة المستفيد الحقيقي من كل صفقة", "التحقق من مصدر الأموال حين تستدعي المخاطر ذلك", "مراقبة النشاط المشبوه والإبلاغ عنه", "تدريب الفريق وسجلات تثبت أن الإطار يعمل فعلاً"),
    p("بروكاونت للمحاسبة تدعم الوكالات العقارية في الإمارات بسياسات AML، والعناية الواجبة ومعرفة العميل، وتقييم المخاطر، والتدريب، ودعم التقارير عبر goAML، والجاهزية للتفتيش — خدمة مصممة للمساعدة على سد فجوات الامتثال، بحسب طريقة عمل وكالتكم."),
    p(`هل ترغبون بمراجعة قصيرة لجاهزية {{company|وكالتكم}} لـ AML؟ ${CALL_AR} ونحدد الوقت المناسب لكم.`),
    ctaAr("احجزوا مراجعة جاهزية AML", "حجز مراجعة جاهزية AML لوكالتنا"),
    p(BYE_AR),
  ].join("\n"),
  followups: [
    { audience: "warm", afterHours: 72, subject: "{{company|شركتكم}}: من يقف فعلاً خلف كل صفقة؟",
      html: [p(HI_AR), p("متابعة لرسالتي عن جاهزية AML — نقطة يقع فيها كثيرون: المستفيد الحقيقي ليس دائماً من يوقّع العقد."), p("بحسب القانون الحالي، هو الشخص الطبيعي الذي يملك أو يسيطر فعلياً، أو تتم المعاملة نيابة عنه. وفي الصفقات التي تشارك فيها شركات أو أطراف ثالثة، يجب أن يُظهر ملف العميل ذلك."), p("يمكننا مراجعة عيّنة من ملفات عملائكم وإخباركم بصراحة أين الفجوات. مكالمة قصيرة تكفي للبداية."), ctaAr("راجعوا ملفات عملائنا", "مراجعة ملفات العناية الواجبة لعملائنا"), p(BYE_AR)].join("\n") },
    { audience: "value", afterHours: 168, subject: "فحص سريع من ٤ أسئلة لامتثال {{company|وكالتكم}}",
      html: [p(HI_AR), p("فحص ذاتي سريع للوكالات العقارية:"), ul("هل لديكم تقييم مخاطر AML حديث لنشاطكم؟", "هل تُظهر ملفات العملاء المستفيد الحقيقي؟", "هل توجد آلية للإبلاغ عن النشاط المشبوه عبر goAML؟", "هل تدريب الفريق على AML موثّق؟"), p(`إن كانت أي إجابة «لست متأكداً»، يمكننا المساعدة — ${CALL_AR}.`), ctaAr("راجعوا جاهزيتنا لـ AML", "مراجعة جاهزية وكالتنا لـ AML"), p(BYE_AR)].join("\n") },
    { audience: "breakup", afterHours: 336, subject: "رسالة أخيرة بخصوص دعم AML لـ {{company|وكالتكم}}",
      html: [p(HI_AR), p("راسلتكم مرتين بخصوص جاهزية AML، ولن أملأ بريدكم أكثر من ذلك."), p("إن جاء تفتيش، أو احتجتم مسؤول امتثال، أو ظهر سؤال عن معرفة العميل — نحن على بُعد رسالة أو مكالمة."), p(BYE_AR)].join("\n") },
  ],
};

// ── How the firm writes ──────────────────────────────────────────
export const VOICE_GUIDE = `Pro Count — email voice guide (how we write)

Who we are, in one line: Outsourced Accounting, Tax & AML Compliance Support for UAE Businesses.
Short version: Pro Count helps UAE businesses manage accounting, tax, financial reporting and AML compliance through professional outsourced services tailored to their operational and regulatory needs.
Contact: ${CONTACT.websiteLabel} · ${CONTACT.phone} (call or WhatsApp) · Abu Dhabi, UAE.

How every email is built: Subject → a specific business problem → why it matters → a correct UAE requirement or business insight → practical guidance → the Pro Count service → one specific call to action.
Educate first, qualify second, sell third.

Tone in English: professional, clear, business-oriented, confident, consultative — no advertising language.
Tone in Arabic: simple, natural, Gulf-readable, professional and direct — not legalistic.

Always: the recipient company's name in the subject or first line; their sector's problem, not ours; one call to action; signed as Pro Count.
Calls to action by stage: cold — book a free consultation; warm — discuss your requirements; Corporate Tax — review your Corporate Tax position; AML — request an AML compliance assessment; real estate — review your AML readiness; gold — assess your DPMS compliance; accounting — discuss your accounting workload; eInvoicing — assess your eInvoicing readiness.

Never: best, No.1, cheapest, leading, world-class, guaranteed, 100%; invented laws, rates, penalties or deadlines; promises of avoided penalties or passed inspections; goAML presented as full AML compliance; AED 55,000 presented as a threshold outside precious metals and stones; Small Business Relief promised without checking conditions; fake urgency; anything that reads like an official notice.
Safe wording: "designed to support compliance with applicable UAE requirements"; "obligations depend on your activity and regulatory classification"; "the treatment should be confirmed based on your company's facts and current FTA guidance".

Pricing questions: never quote a figure first — ask industry, branches, transaction volume, VAT/CT status, reports needed, state of records, AML applicability; then offer to assess the workload and quote.
"We already have an accountant": "That can work well. The question is whether your current setup gives management the records, reports, tax support and financial visibility the business needs."
"Why not software?": software records and organises; an outsourced service provides the people and process to manage, review, reconcile and interpret.
"Why not hire internally?": the right model depends on workload, volume, expertise and resources.`;
