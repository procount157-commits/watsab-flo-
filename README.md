# واتساب ماركتر

أداة إرسال جماعي احترافية عبر WhatsApp، بواجهة عربية RTL وثيم أخضر داكن — نظام SaaS متعدد المستخدمين.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, proxied at /api)
- `pnpm --filter @workspace/whatsapp-blast run dev` — run the frontend (proxied at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string, `SESSION_SECRET` — session signing secret

## Local setup (from a clean machine)

```bash
# 1. pnpm (via corepack, shipped with Node 20+)
corepack enable && corepack prepare pnpm@latest --activate

# 2. PostgreSQL
docker run -d --name wam-postgres \
  -e POSTGRES_USER=wam -e POSTGRES_PASSWORD=wam_dev_pw \
  -e POSTGRES_DB=whatsapp_marketer -p 5433:5432 postgres:16-alpine

# 3. Config
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"  # -> SESSION_SECRET

# 4. Install and create the schema
pnpm install
pnpm --filter @workspace/db run push

# 5. Run (two terminals)
pnpm --filter @workspace/api-server run dev    # :8080
PORT=5173 pnpm --filter @workspace/whatsapp-blast run dev   # :5173
```

Open http://localhost:5173, register, then link WhatsApp from the Connect page.

### Linking notes

`whatsapp.ts` fetches the live WhatsApp Web version at connect time and identifies
as ubuntu/Chrome. Do not change the browser identity to anything named `"Desktop"` —
WhatsApp closes that handshake with 428 before a QR is ever issued, and a stale
client version closes it with 405. Both were live in the original code at once.


## Sending safety

The goal these serve is 1500 messages a day without losing the number. What
actually gets a WhatsApp number banned is recipient behaviour — blocks, reports
and undelivered mail — not message content, so that is what these watch.

**Delivery guard** (`artifacts/api-server/src/lib/delivery-health.ts`)
The important failure mode is silent: when WhatsApp throttles a number, sends
keep succeeding and nothing arrives. The failure-rate guard cannot see this at
all — it only counts send-time errors, and there are none. So the campaign loop
re-reads `message_logs.deliveredAt` every 25 sends and acts on the delivery rate:

| Delivered | Action |
|---|---|
| ≥ 75% | continue |
| 55–75% | slow mode — every gap ×2.5 |
| 35–55% | auto-pause (`high_risk`) |
| < 35% | auto-pause (`critical`) |

Messages younger than 20 minutes are excluded (a receipt needs time to return)
and fewer than 25 mature messages is treated as no evidence, so ordinary
offline recipients cannot trip it.

**Adaptive pacing** (`artifacts/api-server/src/lib/pacing.ts`)
Campaigns default to `pacingMode: "auto"` and derive the gap before each
message from three things that all move while the campaign runs: contacts
still unsent, allowance still unspent today, and time still left in the
sending window. No fixed delayMin/delayMax pair can track a daily target —
a campaign that loses an hour to a disconnect needs a different gap than it
started with.

1500 messages across a 12-hour window works out to a ~19s gap, with the
loop's own breaks (~4h of them) already subtracted. Never faster than 12s
however the arithmetic comes out, never slower than 3 minutes, and multiplied
by the delivery guard's slow factor when it engages. Set `pacingMode` to
`"manual"` to pin a campaign to delayMin/delayMax instead.

**Canary batch** — a campaign over 100 contacts sends 30, holds until those
receipts mature, and only then releases the rest. Without it the delivery guard
is blind for its first ~20 minutes, which at a 19s pace is another ~60 messages
sent before anything can be judged. Small lists skip the hold entirely.

**Account-wide circuit breaker** — WhatsApp bans a number, not a campaign. Two
campaigns at 73% and 27% delivery each look survivable alone; together they are
50% and the number is in trouble. Every 60 sends the aggregate across all of the
account's campaigns in the last 6 hours is checked, and a collapse stops all of
them, not just the current one.

**Known contacts first** — recipients who already have a thread in
`wa_conversations` are ordered to the front of the queue. They are very unlikely
to block or report, the non-contact ratio is part of what enforcement keys on,
and if a guard stops the campaign early the budget was spent on the safest
recipients rather than at random.

**Sending hours** — default 09:00–21:00 `Asia/Dubai`. Previously a no-op, so
campaigns ran overnight; a 03:00 marketing message earns blocks and reports far
out of proportion to its reach. Override with `SENDING_HOUR_START`,
`SENDING_HOUR_END`, `SENDING_TIMEZONE`, or `SENDING_HOURS_ENABLED=false`.

**List validation** — `POST /api/contacts/:id/validate` asks WhatsApp which
numbers in a group are real and parks the rest as `status="invalid"`. Dead
numbers cost twice: each consumes one of the day's 1500 slots and adds to the
failure rate. Numbers the check cannot resolve are left alone. All four
contact-selection paths (start, resume, send-remaining, retry) now skip
non-active contacts — previously only resume did.

**Risk score** (`lib/risk.ts`) — the guards above each watch one thing and
each have a line. Real trouble rarely crosses one cleanly: it looks like
delivery a little low, a few opt-outs, a couple of known contacts who stopped
receiving, and a number linked four days ago — none of which trips a guard,
all of which together is a number about to be flagged. So the operations
officer scores them together, on curves rather than thresholds, and responds
in proportion: 1.5× slower from 20, half the allowance from 40, a third from
60, stopped at 80. The inputs are delivery, failures, opt-out rate, probable
blocks, reconnect churn, the share of sends going to strangers, and the
number's age; people writing back is the one thing that lowers it.

**Probable blocks** — WhatsApp never says who blocked the number, but a
contact who used to receive from it and now sits on one tick for six hours
has, nearly always. `assessBlockSignals` counts those among the last 48 hours'
sends. Blocks are what enforcement keys on, and five of them outweigh fifty
dead numbers.

**Engagement-aware warm-up** — the ramp used to grow on days since linking
alone, so a number that had sent two thousand messages and heard from nobody
earned the same allowance as one running real conversations. It is now scaled
by what recipients did: under 1% of them writing back earns 60% of the ramp,
under 3% earns 80%, and 2% asking to stop halves it whatever else is true.
Never above the ramp — a chatty number earns all of it, not more.

**Rhythm** — a person at a desk does not send at one rate from nine to nine.
Gaps are stretched 1.3× while settling in, 1.35× over lunch and the afternoon
lull, 1.25× winding down; the average across the window is 1.13, which the
daily target still fits.

**Read receipts** — a reply now reads the customer's message first (the ticks
turn blue), pauses, and only then starts typing. A number whose answers arrive
without its ever having opened anything is describing itself.

Already present and unchanged: warm-up ramp (50/day on day 0, +30%/day, 1500
ceiling), opt-out enforcement, cross-campaign 72h dedup, per-send number check,
spintax and synonym variation in campaign text.

## Campaign reports

`GET /api/campaigns/:id/report` returns the funnel — attempted, sent, failed,
delivered, read, and how many are still awaiting a receipt — with delivery and
read rates, timing (duration, average gap, messages/hour) and failures grouped
by cause. `GET /api/campaigns/:id/report/export` is the same as an Excel file
with a summary sheet and a per-recipient sheet, reachable from the campaign
page. Every figure comes from `message_logs` rather than the counter columns on
the campaign row, which drift when a receipt lands during a restart.

Note `readOfDelivered` alongside `readRate`: the first is engagement among
people who actually received the message, the second is diluted by undelivered
mail.

Run the checks:

```bash
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/storage.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/session-breaker.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/pacing.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/delivery-health.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/account-health.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/follow-up.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/intent.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/enrol-group.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/knowledge.test.ts
pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/src/lib/__tests__/sending-hours.test.ts
```


## Follow-up sequences

Follows up with a lead on a cadence after first contact — by default 1h, 6h,
12h, 1 day, 3 days, 1 week, 1 month — and stops the moment they reply. A
sequence that keeps firing at someone who already answered is not a follow-up,
so `stopOnReply` defaults on and cancellation is re-checked at send time.

Sequences cover everyone who messages on WhatsApp by default
(`sourceFilter: "all"`). Set it to `"ad"` to follow up only with ad traffic.

**Ad leads identify themselves.** A click-to-WhatsApp ad stamps the first
incoming message with referral data (`contextInfo.externalAdReply` plus
`entryPointConversionSource`), so `sourceFilter: "ad"` needs no manual tagging.
Detection accepts any of a `ctwaClid`, a `sourceId`, or an entry point naming
an ad surface, and looks for the referral on whichever message variant carries
it rather than assuming `extendedTextMessage`.

The raw referral payload is stored on every lead, ad or not. Before the first
ad runs there is nothing real to verify against, so `GET /follow-ups/leads`
reports `adDetected` — watch it leave zero when ads start, rather than assuming
the referral data is coming through.

| Route | |
|---|---|
| `GET/POST /api/follow-ups/sequences` | list / create (no `steps` → the default cadence) |
| `PATCH/DELETE /api/follow-ups/sequences/:id` | edit, activate, remove |
| `POST /api/follow-ups/sequences/:id/enrol` | enrol a number by hand — how to try a sequence before any ad exists |
| `POST /api/follow-ups/sequences/:id/enrol-group` | enrol a whole contact list (an ad lead-form export) |
| `POST /api/follow-ups/cancel` | drop a lead's remaining steps |
| `GET /api/follow-ups/leads` | detected leads and their source |
| `GET /api/follow-ups/jobs` | what is scheduled, sent, cancelled |

The `/follow-ups` page manages all of this: sequences and their steps, which
intents let a sequence continue, enrolling a contact list, and a probe that
shows how a given reply would be classified and which cues matched.

**Lead-form leads arrive as a spreadsheet.** Someone who fills in a Meta lead
form never messages on WhatsApp, so they never reach the inbound path and were
the one kind of ad lead getting no follow-up at all. `enrol-group` takes a
contact list and schedules the sequence for everyone in it, skipping opted-out
numbers and anyone already enrolled, with due times spread over up to an hour
so a large import does not land as one instant.

A spreadsheet cannot say whether its numbers asked to be contacted, so
`source` is declared by the caller and the worker's guards do the rest.

**Follow-ups share the daily allowance with campaigns.** One number, one
budget: `lib/daily-limit.ts` counts campaign sends and follow-up sends
together against the same warm-up ramp and 1500 ceiling. This mattered the
moment lists could be enrolled — the worker would otherwise have pushed 300 an
hour straight past a ramp campaigns were carefully respecting, and campaigns
would not have seen those sends either. Enrolment reports how many days a list
will take at the current allowance rather than implying it goes out at once.

The worker ticks every minute and is deliberately cautious: it sends nothing
outside sending hours (a 3am follow-up becomes a 9am one rather than being
dropped), at most 5 per user per tick so a hundred leads hitting their one-hour
mark together do not go out as a burst, never to an opted-out number, and
never at all if WhatsApp is disconnected — those stay pending. Anything more
than a week overdue is skipped rather than sent late.

```bash
psql "$DATABASE_URL" -f lib/db/migrations/003_follow_ups.sql
```


## Reply intent

Every inbound message is classified — the opening one included. First contact
used to enrol and return without reading what was said, which skipped the most
informative message a lead ever sends: "ابغى اطلب" straight off an ad click, or
"كم السعر". An opening refusal, complaint or stop request is recorded but is
not enrolled in a seven-step sequence. Intents: `opt_out`, `complaint`, `not_interested`, `interested`,
`question`, `greeting`, `unclear`.

By default a greeting or an unreadable message keeps the follow-ups running —
"مرحبا" is not engagement — while anything with real content stops them and
hands the lead over. Per sequence, via `continueOnIntents`. A stop request
always cancels and adds the number to the opt-out list, whatever the settings
say.

**This is rules-based, not a model call, and that is a measured decision.** The
free endpoint already wired into `routes/ai.ts` (Pollinations, no key) allows
one request per IP at a time: of six consecutive Arabic classifications, three
came back `Queue full`, two were empty, and the one that answered took ~5s and
read "ابغى اطلب اثنين كيف الدفع" — a clear buying signal — as a question. Fine
for an on-demand "improve this message" button, not for every inbound message.
Rules run in microseconds, work offline, and keep customers' messages on your
own server.

`useAi` on a sequence asks that endpoint for a second opinion, but only on
replies the rules scored below 0.55, and never on the critical path: if it is
slow, rate-limited or nonsense, the rules verdict stands. `POST
/api/follow-ups/classify` shows both side by side rather than merging them, so
a disagreement is visible.

Matching respects word boundaries, which is not optional in Arabic: "كم" hides
inside عليكم، لكم، كمية and الحكم, and substring matching alone classified
"السلام عليكم" as a question. Single-word cues must match a whole word, with
only و and ف allowed as prefixes on two-letter cues — "وكم" is a question,
"لكم" in "شكرا لكم" is not. Text is normalised first (hamza forms, ta marbuta,
alef maqsura, diacritics, tatweel, Arabic-Indic digits). Every one of these
traps is pinned in `intent.test.ts`.


## Session recovery

Two things this used to get wrong, both learnt from the session-event log:

**405 is not a rejected pairing.** WhatsApp answers 405 to a *client version*
it has retired, before any credentials are checked. Baileys looks the current
version up from a file on GitHub, and when that fetch fails it returns the
version baked into the package with `isLatest: false` — which this code then
cached for an hour. On a laptop that sleeps, one failed fetch meant an hour of
405s, and the breaker read five 405s as dead credentials and wiped the
pairing. Fifty times in three days on this account, every one of them
"آخرها 405", every one of them a working pairing thrown away.

Now a version counts only when a live source confirmed it (GitHub, then
`web.whatsapp.com`); the last confirmed version is kept in
`whatsapp-session/wa-version.json` across restarts; an unconfirmed value is
retried after two minutes rather than cached for an hour; and a 405 drops the
cached version and retries on a short flat delay. It never touches the
credentials.

**The host sleeps.** This Mac is configured to sleep after one minute idle,
on battery and on power alike — 206 sleeps in two days — and every sleep kills
every socket. Two answers: `start.sh` now runs the server under
`caffeinate -i -s`, which holds the machine awake while the process lives
(idle sleep everywhere; system sleep on AC power — a lid closed on battery
still sleeps, and only `sudo pmset` changes that); and a sleep detector
notices the clock jump on wake and reconnects every session immediately,
with the reconnect backoff reset, instead of waiting for the next failed
keepalive and then honouring a two-minute delay earned during dark wakes.

What is left of the breaker (`lib/session-breaker.ts`):

| | |
|---|---|
| 401 / 403, five in a row with no connection having held 45 s | credentials cleared, QR offered — this is the only path that clears them |
| 405 | version refreshed, flat retry (20 s × attempts, cap 3 min) |
| eight connects in 15 min, none held | **cooldown**: ten minutes with no attempts, credentials intact |
| 408 / 428 / 515 | ordinary drops, exponential backoff, never counted |

The `cooldown` replaced a second credential-wipe path. Every time it would
have fired here the pairing was fine and the environment was not, so wiping
was the wrong call every time.

`awaitingRescanSince` is still set when credentials are genuinely cleared,
and the monitor reports it as critical with the action spelled out.

Baileys is at 7.0.0-rc14. rc12 patched a critical advisory
(GHSA-qvv5-jq5g-4cgg): a crafted payload could raise a fake `messages.upsert`
with a spoofed key, which for a bot that answers strangers meant answering
messages nobody sent.


## Bot team

The bots are modelled as named staff, because that is how they are used: "the
first is Hal, the second is Mark". `/employees` is their dashboard.

**هال — sales.** The customer-facing replier. Shows replies sent, how often it
went quiet, and — the useful part — the actual questions it had no answer for,
which is the list of what to write next. On duty means three things at once:
the employee is active, auto-reply is on, and the knowledge base is not empty;
a sales bot with nothing to say is not working, however many switches are on.

**The rest of the team.** Eight employees are hired the first time an account
links WhatsApp, each with a persona the owner can rewrite and a set of skills:
شمّة (chief — takes what nobody else was hired for, coaches the others, chairs
the meeting), سام (support), خالد (follow-up — argues each rung of a sequence
before sending it), ريم (data — reads receipts and sorts the list), سالم
(intake — decides who belongs in a sequence), فهد (operations — the number's
pace and its ban risk, and the only one who can slow the account), and the two
below. Skills live in `lib/skills/` as procedures with literal wording, so
they survive a downgrade to whatever free model is up; they are installed on
every account at startup and an owner's edit to one is never overwritten. The
salespeople carry a conversation map — seven stages, one goal per message —
an objection table, and a diagnosis skill that knows what a UAE company owner
actually worries about; the manager's pipeline theory loads for a meeting or
a review and never for "كم السعر؟". `/meetings` runs the team meeting; a
meeting with fewer than six measured outcomes may discuss but not decide, and
a decision that changes how the business runs is a proposal the owner
approves, never a rule that applies itself.

**مارك — monitor.** Runs every 20 minutes over four areas and writes one report
per run, kept so a problem can be traced back to when the verdict changed.

The connection check is the reason this exists. `connected` is not the same as
`receiving`: a half-dead linked device keeps emitting connection updates and
delivery receipts while WhatsApp has quietly stopped routing inbound messages
to it. It sends fine, so nothing looks wrong until someone notices the replies
stopped — which is exactly what happened here before the monitor existed. Only
inbound silence separates the two:

| | |
|---|---|
| no socket events at all for 45 min | critical — inert socket |
| connected, sending, no inbound for 6h | critical — lost its registration |
| no inbound for 3h | warning — may just be quiet |
| 3 consecutive send failures | critical |
| 10 reconnects | warning — flapping precedes deregistration |

Ban risk covers account-wide delivery, failure rate, daily quota, and opt-out
rate — the last being the strongest signal and the least watched. Over 3% of
recipients opting out warns; over 6% is critical, and says plainly that pacing
will not save a list that does not want the messages.

Findings are written as a sentence plus an action rather than as metrics. A
dashboard of numbers is something you have to remember to read.


## The lead card, and who holds the thread

Every customer has a card, written by rules from their own messages
(`lib/lead-card.ts`): licence type, activity, size, staff, tax status, who
keeps their books, what worries them, the objection they just raised, and
whether they agreed. From it the stage of the sale is computed — open,
discovery, diagnosis, value, offer, objection, close — and both are put in
front of the employee on every reply with the one goal of that message.
Before this the model inferred all of it from the transcript, and asked for
a licence type it had been given twice, which is the most reliable way to
sound like a machine.

Every reply gets an outcome from what the customer did next — `win`,
`qualified` (their reply taught the card a fact), `engaged`, `loss`, and
`quiet` after a day of silence, set by an hourly sweep. 103 replies had no
outcome at all before; the coach and the meeting need them.

A person replying from the phone or from the inbox silences the bot and the
follow-up ladder for that thread for 24 hours (`lead_cards.human_until`).
The inbox has the switch; `POST /api/lead-cards/:phone/takeover` and
`/release` are behind it. The owner is told on Telegram once when a lead
reaches the offer stage and once when it agrees.

## The onboarding interview

Nobody fills a knowledge base by hand. On the knowledge page or in the
assistant, «مقابلة التأهيل» has شمّة ask the owner ten questions, one per
message — who you are, who buys, what you sell, why you, what you say about
price, the five questions everyone asks, what must never be said, hours,
the next step, day-one knowledge — and at the end she writes the business
profile and the first entries herself, in labelled lines the code parses
(`lib/onboarding.ts`). The thread is `assistant_threads.kind = interview`.

## Plans, invitations, and a new number

`PLAN_LIMITS` applies (`lib/plans.ts`): contacts and campaigns per plan, an
expired paid plan falls back to the free limits and stops sending, admins
are never limited. Accounts that existed before this were moved to `pro`
(migration 023) so nothing the owner relies on stopped.

Registration is by invitation: a coupon code from the admin page, which
also carries the plan and the days sold. `OPEN_REGISTRATION=true` opens it.

A number linked for under 48 hours (`WARMUP_MIN_HOURS`) cannot start a
campaign — two days of ordinary conversation first. For its first two
weeks, once more than 60% of the day's sends (`STRANGER_SHARE_CAP`) have
gone to people with no prior thread, a campaign pauses until tomorrow.

A customer reply the model could not write is retried three times on a
widening delay before the customer is given up on; a quarter of calls to
the free tier were failing, and each was a customer who got nothing.

`WA_FULL_HISTORY=false` stops the full chat history sync per linked number,
for when the tenant count makes memory matter.

## Importing numbers

One reader for every door (`lib/phone-import.ts`), because the same kind of
file arrives at all of them: a directory export, a scraped list, a client's
CRM dump. It reads every sheet, finds the header row wherever it is (reports
open with a title), recognises headers in Arabic and English by what they
contain rather than by exact match, and takes numbers from every number
column — WhatsApp first, then mobile, then phone, never the fax — plus any
unlabelled column whose values are mostly numbers. A cell holding two
numbers gives two. Each row's country comes from its city or country column
when the file has one (a Riyadh row is +966 whatever the default), otherwise
from the country chosen at import. The mobile is told from the landline by
each country's numbering plan. The company's name is found by header, or by
being the column of distinct names when there is no header, and the number
is saved under it.

`POST /api/contacts/import` takes the file (or pasted text) and saves on
arrival — into a given list, or a new one named after the file — and keeps a
file in one list however large it is (`lib/contact-save.ts`). The same file
uploaded again tops up the list it made before instead of making a second
one beside it. When WhatsApp is
linked, checks every number against WhatsApp in the background and parks the
unregistered ones as `invalid`. The lists page has a one-step upload; the
list page uploads into itself. The email import reads the file the same way
and also saves each row's WhatsApp number — including rows with no email — to
a list named after the email list, so one file feeds both channels.

50,000 rows parse in about half a second; uploads go to 60 MB.

**Duplicates.** A number is compared by its international form, so
0501234567, +971 50 123 4567 and 971501234567 are one number
(`lib/dedupe.ts`). A unique index on (list, number) makes a duplicate inside a
list impossible, and every insert path ignores one instead of failing. An
import skips a number already in any other list of the account unless the
owner allows it, and says which lists had it; a new list whose every number
was elsewhere is not left behind empty. The lists page counts duplicates —
within a list, across lists, and numbers stored without their country code —
and removes them on the owner's word: within lists always keeping the copy
with a company name, across lists (a separate, confirmed step) keeping the
copy in the oldest list and carrying a name onto it. Email contacts are
stored once per address already.

**Folders** (`routes/folders.ts`, `list_folders`, migration 028) hold number
lists and email lists alike: made in place, renamed, removed (the lists stay),
a list dragged onto a folder or moved from its card, and "رتّب حسب القطاع"
putting every unfoldered list into the folder for its sector — from the
list's name, or from what most of the companies in it are (`lib/folders.ts`).
The owner's own folder wins: one they called «عقارات الامارات» is the real
estate folder, and a folder is made only when no folder reads as that sector.
A file uploaded while a folder is open lands in it; otherwise a new list goes
straight into its sector's folder. The folder counts are taken from the lists
the page shows, so they always agree with it.

**Email lists** (`pages/EmailLists.tsx`, the «القوائم» tab) work like the
number lists: folders down the side, a card per list, and a page per list at
`/email/lists/:id`. A card shows how many addresses there are, how many can
still be written to, how many have a WhatsApp number, how many were reached,
opened and replied, and a bar of sendable against unsubscribed and bounced.
All of that comes from one query (`listStats` in `routes/email.ts`). A file
dropped on the tab becomes one list in one step, filed in the open folder or
its sector's folder; the same file again tops up that list. The list page
filters its members by engagement and status. From there the owner can take
contacts out of the list (they stay in the audience), stop or restart them,
export to CSV, enrol the list in a follow-up, or start a campaign or a
نورة draft for it.

**Campaigns** (`pages/EmailCampaigns.tsx`) are built in three steps on one
screen:
1. Who it goes to: a list, a whole folder (an audience with `folderIds`,
   resolved when the campaign starts, so a list added to the folder later is
   included), or a saved audience. Each choice shows how many it will reach.
2. The message: نورة writes it with two subjects to test, or it comes from a
   template or by hand. Merge fields go in at the cursor, and the email shows
   beside the editor as it will arrive.
3. Sending: a subject test, now, at a set time, or saved as a draft.

A test copy goes to the owner's own address first (`/campaigns/:id/test`),
and a campaign can be copied as a new draft. Each campaign card shows its
progress against its audience and its open, click, reply and bounce rates.

**Knowledge** (`lib/email/knowledge-docs.ts`, the «المعرفة» tab, migration
029) is where the owner puts everything نورة should know before she writes.
The tab holds four things:
- the company card (the business profile, shared with the whole team);
- documents: PDF, Word (.docx), Excel, CSV, HTML or text, up to twenty at
  once, each with a category (company, services and prices, sector,
  compliance, FAQ, style) and an optional sector;
- quick facts typed in by hand;
- a box to ask نورة a question and see her answer with its sources.

Each document is kept whole, and نورة reads it in the background, up to
~120k characters in 10k pieces, into facts. Each fact is stored in
`agent_memory` with `doc_id` pointing back to its document, so deleting a
document takes its facts with it, and re-reading it replaces them. Writing a
campaign or a reply uses both:
- the facts, through `brief`, by sector;
- the document passages that bear on the subject, through `passages`, with
  rare words weighted the way the WhatsApp knowledge base ranks its entries.

Many PDFs store Arabic in its joined display shapes with each line's words
reversed. `fixPdfArabic` turns the shapes back into plain letters and the
words back into reading order, keeping English runs and numbers whole. An
image-only PDF is refused with a note to export it as text. A read cut off
by a restart shows as failed after half an hour, ready to retry.

**The email team** (`lib/email/team.ts`) is five employees who work only on
email, each with one job:

| Agent | Role | Job |
|---|---|---|
| نورة | `email` | writes campaigns |
| سلمى | `email_strategist` | plans waves per list and sector |
| يوسف | `email_followup` | keeps the stage lists and works them |
| ليلى | `email_replies` | rates replies hot, warm or cold, and answers |
| ماجد | `email_guard` | checks messages before an automatic send, and watches sending health |

They are ordinary employees on the team page, with a persona, tasks, a
memory of the owner's instructions, and skills. Every prompt starts from
`EMAIL_DOCTRINE`, the firm's own B2B email rules from its knowledge base:
educate, then qualify, then sell; the message formula; claim safety; the
never-do list; and the call-to-action library.

`guardCheck` is deterministic. It stops hype, guarantees, fake urgency and
anything posing as an official notice. It also stops any number (a fine, a
rate, a deadline, a price, in either digit set) that does not appear in what
the firm taught. `temperature` rates a reply by the knowledge base's
hot/warm/cold definitions, and a hot reply is reported to the owner at once.

**The autopilot** (`lib/email/autopilot.ts`, migration 030) runs every 15
minutes on the lists and folders the owner picks. Each round:
1. ماجد holds new waves if sending health is critical.
2. يوسف keeps four stage lists under each list (opened and did not reply,
   clicked, replied, did not open), in the same folder.
3. سلمى starts the next wave of people not yet written to, with the campaign
   from the firm's library that fits the list's dominant sector.
4. يوسف starts waves for those who clicked and those who opened, each with a
   new angle.

Waves respect rest days between messages (`quietDays`) and a monthly
ceiling (`maxTouches`). They run as missions: نورة or يوسف writes, then
either the owner approves (the default) or, in auto mode, ماجد passes it,
and then the mission engine sends and follows up.

**The dashboard** (`lib/email/dashboard.ts`, the «لوحة المتابعة» tab)
shows:
- the period's sends, opens, clicks, replies, bounces and unsubscribes;
- sends by day, and opens, clicks and replies by day;
- each worked list as a funnel into its stage lists;
- the hottest contacts;
- what each agent did;
- campaigns waiting for approval;
- the autopilot's controls, with a line of instruction to any agent.

Opens and clicks need `SITE_URL`, a public address for the pixel and the
links; replies are measured without it.

**How an email looks** (`lib/email/layout.ts`, migration 031). Every message
goes out in the firm's branded layout unless the owner chooses plain:
- a header in its colour with its logo and tagline;
- the message in a white card;
- a footer with the firm's name, address, website, phone and unsubscribe.

It is built from tables and inline styles, so it holds in Gmail, Outlook and
on phones. Direction is read from the words (right to left for Arabic), and
the hidden inbox-preview line skips the greeting. The message stays simple
HTML with two marks: `<p class="cta"><a>` becomes a button, `<div
class="note">` a highlighted box. Writers can add a `[button]` / `[زر]` line,
which becomes a WhatsApp button with the request already written.

`components/EmailEditor.tsx` replaces raw HTML everywhere a message is
written (missions waiting for approval, the campaign builder, templates,
sequences). It is a visual editor (bold, headings, lists, links, button, box,
merge fields) with the email beside it as it will arrive, on desktop or
phone; HTML stays on its own tab. Templates show as a gallery of real
thumbnails (`/templates/:id/render`), and the brand is set under «هوية
الرسائل» in the email settings.

**English only, and the path after send.** Every email is English: writing,
follow-ups, the subject rescue and replies to inbound mail (`lib/email/
language.ts`). The language is enforced at approval, in auto mode, in the
readiness check and at `startCampaign`, whatever language the request came
in. The path is four touches over fourteen days, and it stops at a reply,
an unsubscribe or a bounce:
- day 0: the first email;
- day 3: a new angle and one question for those who opened and did not
  reply, and the same offer, shorter, under a new subject for those who did
  not open;
- day 7: one useful fact;
- day 14: the last note.

A mission's two sequences carry these steps, and its report is split by step.

**The open-rate checkpoint** (`decideAbTests`). With opens measured
(`SITE_URL` and tracking on), the subject test runs on 20% of the audience
and is read after a day. Below 15% opens in a sample of at least 50, the rest
is held, and the writer gives two new subjects for a fresh fifth of the held
(`retestHeld`). After two such rounds the guard calls it a delivery problem
and waits for the owner. Resuming a held campaign releases the rest. Without
tracking the checkpoint cannot judge, so it releases as before, and the page
says so.

**Clearing email data** (`lib/email/delete.ts`). The audience can be cleared
in one step: the ticked rows, everyone the current filter selects, a list on
its own or with its addresses (those in no other list), or all of it. A bulk
delete asks for the count to be typed back. Queued follow-ups go with a
contact. Anyone who unsubscribed, bounced or complained is kept and taken out
of every list, so a later upload with that address never writes to it again.


## Email marketing

The same shape as the WhatsApp side, for the same reasons: contacts and
lists, campaigns that enqueue messages, a follow-up ladder, and events read
back from the world — opens, clicks, replies, bounces, unsubscribes — so a
campaign is judged by what happened rather than by what was sent. Code under
`lib/email/`; the section is `/email` in the app; migration 024.

**The import is the front door.** The owner uploads the spreadsheet as it
came. `importer.ts` works out which column is the email, the company, the
phone, the activity and the city — by header name first, by the look of the
values second, because half the files have no usable headers — normalises
and de-duplicates the addresses, counts role addresses (`info@`), checks
every domain for MX so a dead domain never costs a bounce, and reports
exactly what it kept and why the rest was not. The import can split the
file into sub-lists by activity or city and enrol everyone straight into a
sequence, so a file becomes a running follow-up in one step.

**Sending.** One queue per account (`service.ts`), drained every twenty
seconds: hourly and daily caps, sending hours, a jittered gap
(`sendGapMs`), and a deliverability verdict on top (`health.ts`): 3%
bounces slows, 6% stops, one complaint in a thousand warns and three stop,
a sender under a week old is throttled. Three ways out (`provider.ts`):
SMTP through nodemailer — any mailbox — or Resend or Brevo by API. Every
message carries our own Message-ID, `List-Unsubscribe` with one-click
POST, a plain-text part, and the footer the bulk-sender rules require.

**Tracking** (`tracking.ts`, `routes/track.ts`): a real 1×1 GIF, links
rewritten through a signed redirect, and an unsubscribe page that confirms
on GET and acts on POST, so a link scanner cannot unsubscribe anyone. All
of it needs `SITE_URL`; without it the pages still send, with the mailto
unsubscribe only. Opens are a floor, not a fact — Apple's Mail Privacy
Protection and Gmail's image proxy fetch the pixel on the reader's behalf,
and the event records when that is the case.

**Replies** (`inbound.ts`): the sending mailbox is polled over IMAP every
two minutes, or a provider posts to `/api/email/inbound/<token>`. A reply is
matched to the message it answers by `In-Reply-To`, failing that by the
address; bounces and auto-replies are recognised and filed as such; the
rest is classified with the same intent rules as WhatsApp, summarised, and
handed to هال, who drafts the answer from the persona, the skills and the
knowledge base. The draft waits in the inbox tab for a person; sending it
threads it properly. An `opt_out` reply unsubscribes. The owner is told on
Telegram.

**The AML outreach for بروكاونت** (`seed.ts`) is installed with the first
saved settings: a three-step sequence — the obligation and one question,
what compliance actually involves, a graceful last message — and templates
in Arabic and English. Fees, addresses and names are bracketed
placeholders; nothing in it states a penalty amount or a deadline.

Settings can check the sending domain's SPF, DKIM and DMARC (`dns.ts`) and
say which are missing; without all three the mail lands in spam or not at
all.

**Running itself** (migration 025). Auto-reply, off by default: the
salesman's draft goes out on its own after a jittered delay, only for a
question, interest or a greeting — a complaint or a refusal always waits for
a person, and any scheduled send can be stopped from the inbox. Warm-up, on
by default: a new sending address gets 50 a day, +30% a day, up to the cap
the owner typed. Subject tests: a campaign with a second subject sends each
to half of a slice (20% by default, at least 20 people, never under 40 on
the list), holds the rest, and after the wait releases them under whichever
was opened more — replies break a tie. A reply from a contact with a phone
updates the same lead card the WhatsApp side keeps, so one company is one
lead across both channels; the assistant and the evening meeting both see
the email numbers; a report goes to Telegram at 20:30. Each company has a
timeline — every send, open, click, reply and bounce, and what is still
scheduled.


## Email: sectors, audiences, نورة and her missions

**Sectors.** Every email contact gets a sector (`lib/email/sector.ts`), read
from its activity column when there is one, from the company's name when there
is not ("… REAL ESTATE L.L.C", «مؤسسة … للمقاولات»), and from the file or list
name as a last hint — in Arabic and English, specific trades before general
ones. On import, the owner can also name the sector for the whole file.
`POST /api/email/contacts/classify` fills in the ones without.

**Audiences** (`lib/email/segments.ts`): a filter over sector, city, list,
status, what the contact has done (never sent, sent and not opened, opened and
not replied, clicked, replied) and whether it has a WhatsApp number. The
audience tab shows the count beside every choice, lets the owner tick contacts
or take the whole filter, and make a list, set a sector, enrol, stop or delete
— or save the filter as a segment. Campaigns and sequences target a list or a
segment; a segment is resolved when it is used, not when it was saved.

**نورة** (`lib/email/agent.ts`) is the email agent — an employee with her own
memory. The owner teaches her in their own words, a pasted document or a file;
she splits it into facts, each tagged with its sector, and brings the right
ones to whatever she writes. She writes a campaign for the target the owner
picks: two subjects to test, the body, a follow-up for those who open and do
not reply and one for those who never open — in labelled blocks the code
parses (`parseDraft`). She answers email replies too, with what she knows
about the contact's sector. After a subject test she writes down which subject
won for that sector.

**Missions** (`lib/email/missions.ts`) are her working an audience toward a
goal: draft → awaiting approval (on by default) → sending, with the two
subjects tested on a slice and the winner sent to the rest → following up,
openers who did not reply getting the warm follow-up and non-openers the cold
one → done, with a report by subject, stage, city and sector, and the lessons
written into her memory and sent to Telegram.

Follow-ups no longer pile up while no sender is configured, never land within
48 hours of another email to the same company, and wait while their sequence
is switched off. Imports no longer enrol everyone in a sequence by default.

**English by default, and an intensive path.**
- Every campaign, follow-up and reply is written and sent in English unless the
  owner changes it: `email_settings.default_language` (settings «اللغة
  والمتابعة») for the account, `email_campaigns.language` for one campaign
  (migration 034). `startCampaign` refuses content that is not in the
  campaign's language. The plain layout follows the body's direction: an
  English email gets `dir="ltr" lang="en"` and an English-only footer.
- The follow-up path has three intensities (`lib/email/intensity.ts`). The
  default is intense: day 0, a warm/cold split on day 2, then value on day 5,
  a new angle on day 9, a short bump on day 14 and a breakup on day 21. The
  path stops for anyone who replies, unsubscribes or bounces.
- «سجل الإرسال» (`GET /api/email/register`, `lib/email/register.ts`) has one
  row per company emailed. Each row shows how many emails were sent and the
  last one, opens, clicks and replies, and the next step with its date (or
  why the path ended).

**The team as experts.** `EMAIL_DOCTRINE` now states the English rule and
judges campaigns by replies rather than opens, because Apple Mail Privacy
Protection inflates opens. Its old three-message cap is gone and the follow-up
path governs instead. `ensureEmailTeam` rewrites sentences of a hired agent's
brief that the path superseded, but only where they are still word for word.
Five skills are added in `lib/skills/email.ts` and granted by role:
- the anatomy of an English B2B email;
- copy frameworks matched to path steps (PAS, BAB, give-first, bump, breakup);
- UAE timing and segmentation;
- measurement and A/B testing with sunset rules;
- path design.

The WhatsApp «الكتابة البشرية» skill (two lines, no lists) is withdrawn from
the email writers through `WITHDRAWN`. It loaded last in the prompt, so it
overruled their structure.

## WhatsApp customer groups

The owner works with customers in WhatsApp groups. Until this section, every
group message was dropped at the door: `resolveSenderPhone` returned null for
`@g.us`. Groups now take their own path in `messages.upsert` and in the
history sync (`lib/groups/store.ts`, migration 032). The one-to-one path is
untouched.

**Kept and filed.**
- Every group message is stored in `wa_group_messages` (sender, text, type,
  file name), once per message id.
- On connect (and from the page), `groupFetchAllParticipating` fills names,
  descriptions and member counts.
- Documents and images a customer group sends are saved on the machine under
  `~/Library/Application Support/whatsapp-marketer/groups/<group>/ملفات/<YYYY-MM>/`.
  `GROUP_FILES_DIR` overrides the location.
- Each group's conversation is appended to a monthly `محادثة-YYYY-MM.txt`
  beside the files.
- «حمّل سجلاً أقدم» asks WhatsApp for 50 older messages
  (`fetchMessageHistory`), which arrive through the history sync.

**سارة, the groups agent (`lib/groups/assistant.ts`, role `groups`), suggests
and never sends.**
- In a watched group she waits a minute after the customer's last line, then
  decides whether the turn needs our reply.
- When it does, she writes one as the owner would. She works from:
  - the last 30 messages;
  - her written understanding of the group, built by «افهمي القروب» from 400
    messages (customer, people, services, recurring topics, open requests,
    tone);
  - the owner's notes;
  - the knowledge base;
  - and, above all, the owner's own past replies to similar messages in any
    group (customer line followed by our reply within six hours), as style
    examples.
- Suggestions wait on the «قروبات العملاء» page under the message they
  answer.

**Learning and the readiness meter.**
- When the owner answers from his phone, his reply is matched to her pending
  suggestion and scored (term overlap).
- His verdicts teach her: right, edited (the edit becomes a remembered right
  reply) or wrong (a note becomes a standing instruction).
- Her "no reply needed" counts as right when nobody replies for six hours.
- Accuracy over 30 days is shown with a readiness rule: at least 50 decided
  and 80% right. Answering by herself is deliberately not built until the
  numbers support it.

**Learning from every message, and the training center**
(`lib/groups/training.ts`, migration 035, the «تدريب سارة» tab).
- Every live message in a watched or customer group arms a timer. After ten
  quiet minutes she reads what is new since her last reading
  (`wa_groups.learned_upto`), if there are at least 5 new messages or her
  last reading is 6 hours old. She then:
  - updates her file on the group;
  - writes down general lessons as `wa_group_knowledge` rows with
    `source = 'learned'`. A lesson she already knows in other words (term
    overlap ≥ 0.7) is skipped.
- Readings run one at a time, at most 150 per account per day. A lesson
  retires once it falls outside the 300 most used.
- «تعلّمي من الجديد» triggers a reading at once.
- The owner teaches her in four kinds, for all groups or one:
  - instructions;
  - question → answer examples;
  - pasted text;
  - files (PDF, Word, Excel, text).
- When she suggests a reply, `briefFor` gives her:
  - every instruction, marked binding;
  - the closest examples (overlap ≥ 0.2);
  - the closest passages of the texts and files;
  - the group's own lessons, then the nearest general ones.
- An edited suggestion is also saved as an example.
- She carries the «الرد في قروبات العملاء» skill, plus the WhatsApp writing
  skills.

## Social desks: Instagram and TikTok (LinkedIn pending)

One shared layer serves every platform. The code is in `lib/social/` and
`routes/social.ts` (mounted at `/api/social/:platform`), with migration 036.
The interface is `pages/social/*`, at `/instagram/:tab` and `/tiktok/:tab`.
It has the email section's shape:
- dashboard
- comments
- messages
- first contact
- target lists
- content
- account and settings

**Browser and login.**
- The team drives the account's own Chrome profile through Playwright.
- The owner signs in by hand in a visible window. No password is stored.
- Drivers live in `lib/social/drivers/{instagram,tiktok}.ts` behind one
  `Driver` interface. They find things by `data-e2e` attributes and button
  words, try several routes, and report "the page changed" instead of
  crashing.
- A verification wall (puzzle, code, "confirm it's you") or a restriction
  stops the desk and alerts the owner on Telegram. It is never pushed
  through.

**The team.** Each platform has twelve employees, `ig_*` / `tt_*` / `li_*`
(`lib/social/team.ts`). Their jobs are manager, watcher, triage, writer,
inviter, dm, prospector, qualify, followup, creator, guard and analyst. Each
platform has its own names. Skills are granted by `socialGrants()`; the new
skills are «التواصل الأول» and «صناعة المحتوى».

**A round** (`lib/social/engine.ts`) runs every 20 minutes when autopilot is
on, or on demand:
1. Check the login.
2. Find our new posts.
3. Read and judge comments, and draft public replies.
4. Read the inbox, keep the messages, and draft replies. Tag each thread hot,
   warm or cold; hot ones go to Telegram. Someone who asks us to stop is
   stopped for good.
5. Draft first messages for people on the lists the owner chose.
6. Draft one follow-up after N days.
7. Send what is approved.

**Outreach rules.**
- The team writes first only to people on an owner-approved list, filled by
  a platform search, an Excel/CSV upload, or pasted handles.
- Each person gets one first message and at most one follow-up.
- Any reply takes them out of the path. A refusal marks them declined.
- An account starts in dry run and approve mode. In auto mode a draft must
  pass the guard first: the email guard's checks plus no word-for-word
  repeats.

**The gate (`mayAct`).** It is checked before every action and refuses:
- outside Gulf hours;
- after 5 failures in a day;
- past the daily cap for the action kind (reply, dm, outreach, followup,
  post, engage), using platform defaults the owner can raise up to 3×;
- too soon after the previous action (45 s on Instagram, 60 s on TikTok).

**Posting.** Instagram and TikTok cannot post without media from a browser.
The team drafts the caption and the owner posts it from the phone.

**LinkedIn.** The platform definition, the team and the data model are ready.
There is no driver yet, so it has no browser actions and no page. Writing the
driver (invitations with a note, messaging once accepted, people search,
posting) was held back for the owner's explicit go-ahead.

The old `instagram_*` tables are no longer used. Their one account and its
action log were copied into `social_*`. The tables were left in place; drop
them by hand once the new desk has been in use.

## Hardening

CORS is an allow-list (`CORS_ORIGINS`, plus localhost dev ports) — it used
to reflect any origin with credentials. The session cookie is `secure`
when the request came over TLS (nginx forwards the proto) and plain over
`http://localhost`. Login, registration and bootstrap get twenty attempts
per quarter-hour per address. JSON bodies are capped at 25 MB.


## Deploying to a VPS

The whole stack runs from one compose file: Postgres, the API, and nginx
serving the built frontend and proxying `/api`. On a fresh Ubuntu box:

```bash
git clone <repo> /opt/whatsapp-marketer && cd /opt/whatsapp-marketer
bash deploy/setup-vps.sh          # docker, node, firewall, .env with generated secrets, cron
./deploy/deploy.sh                # build, migrate, start
bash deploy/setup-ssl.sh your-domain.com
```

`deploy.sh` takes a backup before running migrations and only swaps the
container in once `/api/healthz` answers — a failed migration against the only
copy of the data is how a deploy becomes an outage. Postgres uses a **named**
volume, unlike the anonymous one this ran on locally, which
`docker system prune --volumes` removes without asking and which holds the
WhatsApp auth state as well as the data. Port 5432 is never published; only
the api container reaches the database.

### Heartbeat

`deploy/heartbeat.sh` runs every minute from cron and reads
`GET /api/health/deep`, which reports the database (with round-trip time),
how many WhatsApp sessions are linked and how many are online, whether a model
is configured, and RSS. It is unauthenticated so a monitor can reach it, and
for that reason reports counts and states only — nothing in it identifies a
contact.

| status | meaning | heartbeat |
|---|---|---|
| `ok` | everything works | nothing |
| `degraded` | serving, wants attention (no model, no WhatsApp linked) | alerts hourly, never restarts |
| `error` | database unreachable | restarts after 3 consecutive failures |

The distinction is the point. Restarting because a model key is missing would
drop every live WhatsApp session to fix something that is not broken, and
restarting on a single failed probe turns a slow query into a dropped session —
hence three in a row. Set `HEARTBEAT_WEBHOOK` in `.env` for alerts.

### On first connect

Linking WhatsApp provisions a business profile and a ready-made follow-up
sequence, left **inactive**. The bot's scaffolding is there so the remaining
step is a switch rather than a blank page. Auto-reply stays off: with an empty
knowledge base it would answer nothing anyway, and turning it on for someone
who has not written a word of it is their decision.


## Marketing site and SEO

The application is a single-page React app, which is right for the app and
wrong for the pages that are supposed to be found: a crawler that gets an
empty `<div>` indexes an empty page, and an article added as a route inside
the SPA has no HTML of its own. So the public pages are generated as plain
HTML at build time by `scripts/seo/build-site.mjs`, from Markdown under
`artifacts/whatsapp-blast/site/` — the home page, `/uae/`, `/saudi/`, four
feature pages, the blog index and the articles — into `dist/public/` next
to the app. No framework and no dependencies: a page is a template string
and the Markdown parser is sixty lines.

Every page carries a title, description, canonical, Open Graph, JSON-LD
(Organization and SoftwareApplication on the home, Article and
BreadcrumbList on posts, FAQPage where there is one) and `hreflang` for
`ar`, `ar-AE` and `ar-SA` on the market pages. The generator writes
`sitemap.xml` and `robots.txt`.

`/` is the generated home for a visitor with no session — a crawler, a
prospect — and the app for someone signed in. The server does this itself
(`app.ts`), and `deploy/nginx.conf` does the same at the edge with a cookie
map, so the VPS behaves like the laptop.

Set `SITE_URL` (`.env`) to the public address: canonicals, `og:url` and the
sitemap need it. Without it the pages still build with relative links, no
canonical tags and no sitemap, and the build says so — a sitemap with a
made-up domain would be worse than none.

To add an article: a Markdown file in `site/blog/` with front matter
(`slug`, `title`, `description`, `date`, `section`, `keywords`), then
`pnpm run build`. Rendered pages live only in `dist/`, which is not
committed; the source is.


## Backups

The Replit deployment is gone, so this database is the only copy of everything
— accounts, contacts, campaign history, and the WhatsApp auth state, losing
which means re-pairing and losing chat history a second time. It lives in an
anonymous Docker volume, which `docker system prune --volumes` or a Docker
Desktop reset would remove without warning.

`scripts/ops/backup-db.sh` dumps, compresses, and then *verifies* — a dump that
does not decompress or does not end the way pg_dump ends a complete dump is
deleted rather than kept, because an unverified backup is not a backup. It
prunes anything older than 30 days.

A LaunchAgent runs it daily at 04:30:

```bash
launchctl list | grep whatsapp-marketer          # is it loaded
cat ~/Library/Application\ Support/whatsapp-marketer/backup.log
sh scripts/ops/backup-db.sh                       # run one now
```

The script and the backups live under `~/Library/Application Support/whatsapp-marketer/`
rather than `~/Documents`, because macOS refuses LaunchAgents access to
`~/Documents` without Full Disk Access — granting that to `/bin/sh` is a much
broader permission than this needs.

To restore:

```bash
gzip -dc <backup>.sql.gz | docker exec -i wam-postgres psql -U wam -d whatsapp_marketer
```

Restoring into a scratch database and comparing row counts is worth doing
occasionally; it is how the current backup was confirmed to carry all 33,141
WhatsApp auth keys and the table constraints.


## Bot knowledge

The bot answers from entries the owner writes, and from nothing else. That is
what stops it inventing a price, and it is also why it works before anyone
signs up for an API key: retrieval is local.

`/knowledge` holds a business profile (name, trade, tone, things the bot must
never say) and the entries themselves, which can be pasted in bulk — blank
line between topics, first line the title. A probe asks a question the way a
customer would and shows the answer plus the entries it came from, so a wrong
answer points at the entry that caused it.

A key can be set from `/knowledge` and is stored in the database, so it
survives a restart and does not need an SSH session and a redeploy to change.
It is never read back — the API returns a masked form. Saving it round-trips
the provider before reporting success, because a key that stores but cannot
answer is worse than none: nothing looks wrong.

**With no model configured** the best matching entry is sent verbatim. Correct,
just not conversational. **With a free key** the same entries are turned into a
sentence:

| | | |
|---|---|---|
| Claude | `ANTHROPIC_API_KEY` | paid per token — see the note below |
| Gemini | `GEMINI_API_KEY` | best Arabic, generous free tier. Default model `gemini-flash-lite-latest` — `gemini-2.0-flash` and `gemini-2.5-flash` are both retired, and the heavier flash models spend their output budget on reasoning and truncate a two-line reply |
| Zhipu GLM | `ZHIPU_API_KEY` | `glm-4-flash` is free outright, not trial credit |
| Groq | `GROQ_API_KEY` | fastest |
| Qwen (Alibaba) | `QWEN_API_KEY` | free quota, good Arabic |
| SiliconFlow | `SILICONFLOW_API_KEY` | several free models |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` models |
| DeepSeek | `DEEPSEEK_API_KEY` | trial credit, then very cheap |
| Moonshot | `MOONSHOT_API_KEY` | trial credit |

All except Claude and Gemini speak the OpenAI chat-completions shape, so those
differ only by base URL and model name; Claude and Gemini each have their own
request shape.

**A claude.ai Pro or Max subscription is not API access.** It covers claude.ai
and Claude Code for interactive use and grants no API credits — the API is
billed separately per token through the Anthropic Console. Even where a
subscription session could technically be routed through, its limits are built
for a person at a keyboard, not a server answering customers.

Cost is small for this workload. Assuming ~1,000 input tokens (knowledge-base
context plus the question) and ~120 output tokens per reply:

| model | per 1,000 replies | with prompt caching |
|---|---|---|
| `claude-haiku-4-5` | $1.60 | $0.70 |
| `claude-sonnet-5` | $3.20 | $1.40 |
| `claude-opus-5` (default) | $8.00 | $3.50 |

Caching applies well here because the knowledge-base prefix is identical
between requests, which is the case prompt caching exists for. `ANTHROPIC_MODEL`
overrides the default; for a reply bot, Haiku is usually enough, since answers
are short and grounded rather than reasoned from scratch. With `LLM_PROVIDER` unset they are tried in
preference order, which makes a second key a fallback rather than a conflict.

A truly keyless option was tried and rejected. `text.pollinations.ai` answered
three trivial prompts in a row, then failed all six realistic knowledge-base
questions including retries with backoff, and sometimes returned HTML instead
of JSON. It is still reachable behind `ALLOW_POLLINATIONS=true`, but not as
anything customer replies depend on.

### Matching

Arabic retrieval needed more care than term overlap. Three things were wrong
and each was found by a question whose answer sat in the knowledge base
verbatim:

- `normalizeArabic` keeps `؟` for the intent classifier, so `الجمعه؟` never
  matched `الجمعه`. Retrieval strips it.
- `ادفع` and `الدفع` are one root wearing different affixes. Light stemming
  connects them; both forms stay indexed so exact hits survive.
- Acceptance is by **coverage**, not hit count. With a handful of entries,
  inverse document frequency calls everything rare. "هل عندكم خدمة نقل أثاث؟"
  overlaps the swimming-pool entry on "خدمة" alone — one word of four — and
  was answered confidently and wrongly with the pool price. A match must now
  account for 40% of the question's topical words, where question words and
  ways of asking ("كم", "ابغى", "ممكن") are not topical.

Silence when nothing matches is the intended behaviour, not a gap.

### Auto-reply

Off by default. It never answers a complaint, a refusal or a stop request —
those go to a person — and it stays quiet when nothing matches rather than
guessing. Capped at 8 replies per contact per hour, because the other end may
be a bot too, and two auto-repliers will happily talk to each other. Every
reply is logged with the entries it used.


## Internal assistant

`/assistant` is the operator's own bot — for the owner and their staff, not for
customers. Threads live on the server, so a conversation survives a reload and
follows the user between devices; memory that only exists in a browser tab is
not memory.

Every request carries a snapshot of the account: WhatsApp connection, today's
allowance and what is left of it, campaign counts by status, lists and
contacts, the last seven days of sent/failed/delivered/read, leads by source
and how many are marked interested, scheduled and sent follow-ups, knowledge
entries, opt-outs. The "ما يعرفه" button shows that snapshot verbatim, because
an assistant that quotes a delivery rate should be checkable against the number
it was given.

It is told those figures are real and not to invent others — unlike the
customer-facing replier it may reason freely, since it is talking to the
business owner rather than their customers, but the facts are supplied rather
than recalled.


## Sync constraints (important)

Four constraints the code depends on were never declared in the Drizzle
schemas, so the tables were created without them:

| Table | Constraint | Effect when missing |
|---|---|---|
| `wa_conversations` | PK `(user_id, phone)` | every chat silently discarded |
| `wa_contacts` | PK `(user_id, phone)` | every contact silently discarded |
| `wa_thread_messages` | unique `(user_id, message_id)` | history duplicated per reconnect |
| `incoming_messages` | unique `(user_id, message_id)` | duplicates |

The first two are upserted with `ON CONFLICT (user_id, phone)`, which Postgres
rejects outright without a matching constraint. The sync counters in
`wa_sync_state` were incremented before the write and the error was swallowed,
so the app reported thousands of synced chats and contacts while both tables
stayed empty. Counters now reflect what was actually written.

```bash
psql "$DATABASE_URL" -f lib/db/migrations/002_sync_constraints.sql
```

Run this on any database created before the fix — including production. It
collapses duplicates first, then adds the constraints, and is safe to re-run.
Existing data that was already dropped does not come back: WhatsApp only
replays full history on a fresh pairing, so recovering it means re-scanning
the QR.


## Deploy (standalone — no Replit)

Ports and production commands, previously held in the Replit artifact manifests:

| Service | Port | Path | Production |
|---|---|---|---|
| API Server | 8080 | `/api` | `node --enable-source-maps artifacts/api-server/dist/index.mjs` |
| Frontend (whatsapp-blast) | 24101 | `/` | static build served from `artifacts/whatsapp-blast/dist/public` (SPA rewrite `/* -> /index.html`) |
| Canvas (mockup-sandbox) | 8081 | `/__mockup` | dev only |

Build: `pnpm run build` (runs typecheck first). The frontend needs `PORT` and `BASE_PATH`
at dev/preview time; the API server needs `PORT`, `DATABASE_URL` and `SESSION_SECRET`.
Put a reverse proxy in front so `/api` reaches 8080 and `/` reaches the static build.

Media storage goes through `artifacts/api-server/src/lib/storage.ts`, which
writes to local disk by default (`MEDIA_DIR`, default
`artifacts/api-server/uploads`) and switches to Google Cloud Storage when
`DEFAULT_OBJECT_STORAGE_BUCKET_ID` is set — so a Replit deployment keeps
working and localhost works without one.

Object names come from URL parameters and are resolved inside the media root,
so a name like `../../etc/passwd` is refused rather than served.


## First Admin User

The first user to register gets `isAdmin=false`. To upgrade to admin:

```bash
psql "$DATABASE_URL" -c "UPDATE users SET is_admin = true WHERE phone = '<phone>';"
```

Or use the seed script after adding your credentials:

```bash
ADMIN_PHONE=xxx ADMIN_PASSWORD=xxx pnpm --filter @workspace/scripts run seed-admin
```

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS (Arabic RTL, dark green theme)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- WhatsApp: @whiskeysockets/baileys (real WhatsApp Web protocol)
- Auth: express-session + bcryptjs + connect-pg-simple (PostgreSQL session store)
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI contract (source of truth)
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/db/src/schema/` — DB schema (users.ts, contacts.ts, campaigns.ts, chatbots.ts)
- `artifacts/api-server/src/routes/` — Express route handlers
- `artifacts/api-server/src/lib/whatsapp.ts` — Baileys WhatsApp service (multi-instance)
- `artifacts/api-server/src/lib/auth.ts` — requireAuth, requireAdmin middleware
- `artifacts/api-server/src/routes/auth.ts` — register, login, logout, me
- `artifacts/api-server/src/routes/admin.ts` — admin CRUD for users
- `artifacts/whatsapp-blast/src/pages/` — Frontend pages
- `artifacts/whatsapp-blast/src/context/AuthContext.tsx` — useAuth() hook + AuthProvider
- `whatsapp-session/{userId}/` — per-user Baileys session storage

## Where session events live

- `lib/db/src/schema/wa_sessions.ts` — `wa_session_events` table (userId, event, detail, createdAt)
- Events logged automatically: `connected`, `reconnecting`, `qr_ready`, `logged_out`
- Health endpoint: `GET /api/whatsapp/health` — returns status + uptime + reconnect count + last 20 events
- Live uptime counter runs client-side; health data polls every 5s

## Architecture decisions

- **Multi-tenant SaaS**: each user has isolated WhatsApp instance, contact lists, campaigns, chatbots
- Contract-first: OpenAPI spec drives both backend validation and frontend hooks via codegen
- WhatsApp sessions stored per-user in `whatsapp-session/{userId}/` via Baileys multi-file auth
- Sessions stored in PostgreSQL `user_sessions` table via connect-pg-simple
- All routes protected with `requireAuth` middleware; admin routes with `requireAdmin`
- Campaign sending runs as async background loop with configurable per-message delay (min/max seconds)
- Chatbot nodes stored as JSON in the DB; keyword matching done server-side on incoming messages
- Dashboard stats served from `/api/dashboard/stats` (separate router from campaigns)
- `{الاسم}` variable in campaign messages auto-personalized from contact.name field

## Product

- **تسجيل / دخول**: صفحة login/register مع session cookie آمنة
- **لوحة التحكم**: إحصائيات شاملة + آخر الحملات (مفلترة للمستخدم)
- **ربط الواتساب**: QR كود حقيقي عبر Baileys، جلسة مستمرة منفصلة لكل مستخدم — لوحة صحة الجلسة مع مدة التشغيل وعدد إعادات الاتصال وسجل الأحداث
- **قوائم الأرقام**: إنشاء قوائم، استيراد من Excel أو لصق نصي
- **الحملات**: إنشاء حملات (نص/صورة/فيديو/أزرار/كاروسيل)، تشغيل/إيقاف، جدولة، سجل إرسال
- **الشات بوت**: بناء شجرة محادثة بكلمات مفتاحية، تفعيل/تعطيل
- **إدارة المشتركين**: (للمدير فقط) قائمة المستخدمين، تعليق/حذف، إحصائيات

## Gotchas

- protobufjs must be installed as explicit dep in api-server (Baileys peer dep not auto-resolved)
- Dashboard stats is at `/api/dashboard/stats`, NOT `/api/campaigns/dashboard/stats`
- `pnpm approve-builds` may be needed if Baileys postinstall scripts are blocked
- Session auto-reconnects on disconnect; QR regenerates every 20s until scanned
- `user_sessions` table must exist in DB — created by connect-pg-simple with `createTableIfMissing: true` (uses conString, not pool)
- userId columns in contacts/campaigns/chatbots are nullable for migration safety; all queries filter by `eq(table.userId, userId)`
