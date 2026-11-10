// ── Pro Count: objections and playbooks (B2B, English) ─────────────
// Built only from the firm's existing knowledge: the voice guide and templates in
// lib/email/procount-library.ts and the account block in lib/org/prompts/accounts.ts.
// No fee, fine, rate or deadline appears here. Anything that is not already in that
// knowledge (client names, counts, case results, guarantees) is marked
// needs_owner_approval. Seeded as account_knowledge rows with approval_status
// 'pending': nothing here reaches a prompt until the owner approves it.

import type { AccountLibrary } from "./index";

const VOICE = "lib/email/procount-library.ts VOICE_GUIDE";
const TPL = (n: string) => `lib/email/procount-library.ts TEMPLATES «${n}»`;
const BLOCK = "lib/org/prompts/accounts.ts PROCOUNT_BLOCK";

export const PROCOUNT_LIBRARY: AccountLibrary = {
  account: "procount",
  language: "en",
  objections: [
    {
      slug: "price.fees_first", type: "price", kind: "info_request",
      signal: "How much do you charge?",
      response: "Fees depend on scope, so we do not quote a figure that may not fit. Ask one scoping question at a time: industry and branches, monthly transaction volume, VAT and Corporate Tax status, reports needed, state of the records, whether AML obligations apply.",
      proof: { text: "Pricing questions: never quote a figure first; assess the workload, then quote.", status: "approved_knowledge", source: VOICE },
      nextStep: "Offer to assess the workload and send a suitable quotation.",
      roles: ["sales_specialist", "reply_dm", "lead_qualification", "copywriter"],
    },
    {
      slug: "price.too_expensive", type: "price", kind: "objection",
      signal: "That is more than we pay today.",
      response: "Do not defend or discount. Ask what the current fee covers (recording, reconciliation, reporting, tax support, review) and compare scope, not price.",
      proof: null,
      nextStep: "A short scope comparison call.",
      roles: ["sales_specialist", "reply_dm", "sales_director"],
    },
    {
      slug: "timing.not_now", type: "timing", kind: "objection",
      signal: "Not now — maybe next quarter.",
      response: "Respect it. Ask what would make the timing right (books falling behind, a filing coming up, an AML question). No invented deadline; a date is mentioned only if the knowledge states it.",
      proof: { text: "Close the loop: «If things change — books falling behind, a tax filing coming up, or an AML question — we are one email away.»", status: "approved_knowledge", source: TPL("05 · Last note — closing the loop") },
      nextStep: "Ask permission to check back at a time they choose.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "trust.who_are_you", type: "trust", kind: "info_request",
      signal: "Who are you? I have not heard of you.",
      response: "One line on what the firm is and is not: an accounting, tax and AML compliance partner for UAE businesses — not accounting software, a business setup company or a payroll provider.",
      proof: { text: "What we are and what we are not.", status: "approved_knowledge", source: TPL("03 · Who we are — what we are and what we are not") },
      nextStep: "Ask one question about how they handle accounting today.",
      roles: ["sales_specialist", "reply_dm", "lead_qualification"],
    },
    {
      slug: "trust.references", type: "trust", kind: "objection",
      signal: "Do you work with companies like ours? Any references?",
      response: "Describe the work concretely for their sector from the templates. Never name a client, a client count or a result.",
      proof: { text: "Client names, client counts, testimonials or case results.", status: "needs_owner_approval", source: "not in approved knowledge" },
      nextStep: "Offer a free consultation.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "risk.guarantee", type: "risk", kind: "objection",
      signal: "Can you guarantee we pass the inspection or avoid penalties?",
      response: "Never guarantee; say the work is designed to support compliance with applicable UAE requirements. Obligations depend on the activity and regulatory classification.",
      proof: { text: "Safe wording: «designed to support compliance with applicable UAE requirements»; «obligations depend on your activity and regulatory classification».", status: "approved_knowledge", source: VOICE },
      nextStep: "Request an AML compliance assessment.",
      roles: ["sales_specialist", "reply_dm", "copywriter", "customer_success"],
    },
    {
      slug: "risk.switching", type: "risk", kind: "objection",
      signal: "Changing accountants is risky for us.",
      response: "It does not have to be a replacement: some companies use the firm alongside an internal accountant, for review, reporting or tax support.",
      proof: { text: "Some companies use us alongside an internal accountant — for review, reporting or tax support — rather than as a replacement.", status: "approved_knowledge", source: TPL("12 · Already have an accountant") },
      nextStep: "Discuss where the gaps, if any, are.",
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "competitor.have_accountant", type: "competitor", kind: "objection",
      signal: "We already have an accountant.",
      response: "That can work well. The question is whether the current setup gives management the records, reports, tax support and financial visibility the business needs. Never criticise the current provider.",
      proof: { text: "«We already have an accountant»: the approved reply.", status: "approved_knowledge", source: VOICE },
      nextStep: "Offer a short, objective review of the gaps.",
      roles: ["sales_specialist", "reply_dm", "copywriter", "lead_qualification"],
    },
    {
      slug: "competitor.software", type: "competitor", kind: "objection",
      signal: "We use accounting software, we do not need you.",
      response: "Software records and organises; an outsourced service provides the people and process to manage, review, reconcile and interpret it.",
      proof: { text: "«Why not software?»: the approved reply.", status: "approved_knowledge", source: VOICE },
      nextStep: "Ask whether the team has the time to run the software properly.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "competitor.hire_internally", type: "competitor", kind: "objection",
      signal: "We would rather hire an accountant in-house.",
      response: "The right model depends on workload, transaction volume, required expertise and internal resources; talk it through objectively.",
      proof: { text: "«Why not hire internally?»: the approved reply.", status: "approved_knowledge", source: VOICE },
      nextStep: "Offer to compare both models for their volume.",
      roles: ["sales_specialist", "reply_dm"],
    },
    {
      slug: "authority.not_decider", type: "authority", kind: "objection",
      signal: "I need to check with the owner / CFO.",
      response: "Ask who else takes part in the decision (owner, general manager, finance manager or compliance officer) and offer a short summary they can forward. Do not go around them.",
      proof: { text: "The decision maker is the owner, general manager, finance manager or compliance officer.", status: "approved_knowledge", source: BLOCK },
      nextStep: "Send a three-line summary they can forward.",
      roles: ["sales_specialist", "reply_dm", "lead_qualification"],
    },
    {
      slug: "no_need.goaml", type: "no_need", kind: "objection",
      signal: "We registered on goAML, so we are compliant.",
      response: "goAML registration is one step, not full AML compliance; the review asks for what sits behind it. Explain without alarm and without any penalty figure.",
      proof: { text: "Never present goAML as full AML compliance.", status: "approved_knowledge", source: TPL("39 · goAML is not AML compliance") },
      nextStep: "Review their AML readiness.",
      roles: ["sales_specialist", "reply_dm", "copywriter"],
    },
    {
      slug: "no_need.not_applicable", type: "no_need", kind: "objection",
      signal: "AML does not apply to our business.",
      response: "Obligations depend on the activity and regulatory classification. Ask one question about the activity; if it truly does not apply, thank them and stop.",
      proof: { text: "«Obligations depend on your activity and regulatory classification.»", status: "approved_knowledge", source: VOICE },
      nextStep: "One question about the activity, or a polite close.",
      roles: ["sales_specialist", "reply_dm", "lead_qualification"],
    },
  ],
  playbooks: [
    { role: "sales_specialist", text: "Educate first, qualify second, sell third. English unless they write Arabic. One question per message; the call to action by stage: cold — book a free consultation; warm — discuss your requirements.", source: VOICE },
    { role: "reply_dm", text: "Read the reply for the business problem behind it. Objection: answer once from this library. Information request: answer from the knowledge or say you will confirm. Refusal or opt-out: thank them and stop. Hot: hand to the owner.", source: VOICE },
    { role: "copywriter", text: "Subject → a specific business problem → why it matters → a correct UAE requirement or business insight → practical guidance → the service → one call to action. No superlatives (best, leading, cheapest), no guarantees, no fake urgency.", source: VOICE },
    { role: "lead_qualification", text: "Qualify from their words: industry, branches, transaction volume, VAT and Corporate Tax status, state of records, whether AML applies, and who decides. A refusal closes the card; an objection keeps it open.", source: VOICE },
    { role: "sales_director", text: "Measure useful company replies and meetings, not messages. Each week read the recorded objections and propose to the owner what deserves a library entry.", source: BLOCK },
    { role: "customer_success", text: "A complaint is not a sales objection: acknowledge, apologise once, give the next step and who follows up. Anything about fees or a mistake in delivered work goes to the owner.", source: BLOCK },
    { role: "campaign_strategist", text: "Pick the audience by visible need, and give each wave its expected objection and the approved angle from this library. Never retarget anyone who refused or opted out.", source: VOICE },
    { role: "manager", text: "Review adherence by sample and number: objections handled, replies without a next step, any unapproved claim. Proof points and negotiation limits are the owner's to approve.", source: BLOCK },
  ],
};
