# WhatsApp ban shield with an earned ladder to 1,500, and a number vetter — design

**Date:** 2026-10-20 · **For:** Flow Hub, Menu For You, Doctor Hub · **Status:** approved by the owner ("ابدأ بدون أسئلة"); the calls below are the builder's.

## Intent, in the owner's words

> أبني جدار لكل حد … هم عملاء سابقين، وفي النهاية برسل لهم خيار: أي واحد اختار «لا»، اختار «ما ترسل لي»، خلاص ما هرسل له تاني. بس أبنيها عشان يوصل ١٥٠٠ في اليوم بالتدريج. … الدفاعية في الـ firewall، الحاجز التلقائي. … موظف جديد: قبل ما يضع الرقم في قائمة الإرسال لازم يتأكد من كل رقم ويقيّمه — هل عليه واتساب ولا لا — يحلل الرقم بطريقة متقدمة. لهم كلهم: فلو هاب ومينيو هاب ودكتور هاب.

WhatsApp restricted Pro Count's number on 2026-10-19 (32 cold messages in three
minutes, a computed allowance of 1,500). The firewall built that evening was
rolled back on the owner's clock rule; this is its successor, to the owner's
own spec.

## Goals

1. **One gate in front of every outbound message** (campaign, follow-up, reply,
   manual, transactional). Nothing reaches the wire without the firewall's leave.
2. **A ladder that climbs to 1,500 cold messages a day by merit**, never by the
   calendar alone, and that comes down the moment the numbers turn.
3. **"No" is final.** The stop button, a lone «0», a typed stop, or any short
   message that asks us to stop puts the person (any spelling of the number) on
   the account's blacklist for good. Every path refuses them afterwards.
4. **Defence that reads WhatsApp itself:** the account's *reachout time-lock*
   (a restriction, with its end time) and its *new-chat message cap* (quota,
   used, warnings) are fetched from WhatsApp and bind the budget.
5. **A vetter employee (سيف, «فاحص الأرقام»)** who judges every number before
   it may be sent to: format, country, mobile-ness, fake patterns, duplicates,
   the blacklist, "not interested", delivery history, recent contact, and
   whether the number is on WhatsApp. Campaigns only send to numbers he marked
   *ready*.
6. The same in all three products.

## Non-goals / anti-goals

- No bulk probing beyond `onWhatsApp` (no profile pictures, no business
  profiles): extra probes are themselves a signal.
- No bypass path. A send that skips the firewall is a bug.
- Replies to people who wrote to us are never frozen — that is what WhatsApp
  wants from a business number.
- The ladder never climbs past WhatsApp's own stated quota.

## The ladder (builder's call)

Rungs, cold messages a day: `20 35 50 80 120 170 240 330 450 600 800 1000 1250 1500`.

- A number starts by age: <7 days → 20, <14 → 35, <30 → 50, else 80.
- Judged once a Dubai day. **Up one rung** when, over the last two days at this
  rung: at least two days spent, ≥ 60 % of the budget actually used per day,
  ≥ 20 matured messages with ≥ 90 % delivered, opt-outs ≤ 1 % of recipients,
  replies ≥ 1.5 % of recipients, mode normal, no WhatsApp warning, and the next
  rung fits WhatsApp's quota when it is known.
- **Down one rung** on delivery < 80 % (n ≥ 20), opt-outs > 2 % (n ≥ 20), or
  60 recipients with no reply. WhatsApp `FIRST_WARNING` → down one;
  `SECOND_WARNING` → down three; `CAPPED` → frozen until the cycle ends.
- Any freeze resets the rung to the age rung. Convalescence (14 days after a
  freeze) runs at a third, then two thirds, of the rung.
- The owner can only lower the budget (`coldDailyCap`), never raise it.
- Budget = min(rung, owner cap, WhatsApp remaining quota if known).

Pace is derived from the budget over the sending window (09–21 Dubai, 12 h):
per hour = ⌈B/12 × 1.3⌉ (6…160), per ten minutes = ⌈perHour/6 × 1.4⌉ (2…30),
gap = 12 h / B with 0.6–1.1 jitter, floored at 20 s and capped at 240 s, and
the first hour of the day at half the hourly pace (4…60). At 1,500 a day that
is ~28 s apart, 160 an hour; at 20 a day, one every four minutes.

Tripwires (any one freezes all cold sending): a burst (> max(6, per10Min) in
five minutes), undelivered messages (4 of the last 10 → 6 h; 10 of 20 → 24 h),
four closes in half an hour while sending (2 h), a 401/403/405 from WhatsApp
(72 h), a send error that smells of a block (24 h), ≥ 3 opt-outs or ≥ 5 % in a
day (24 h), 60 cold messages with no reply (24 h), a WhatsApp time-lock (until
it ends).

## Kinds

`campaign` (always cold) · `followup` / `manual` (cold unless the person wrote
within 72 h) · `reply` (warm) · `transactional` (warm: queue turns, booking
reminders, order confirmations in Menu For You / Doctor Hub — the customer
started it). Warm messages are paced (6 s, 60/h) and never frozen or budgeted.

Cold messages are refused per person when the person is blacklisted or not on
WhatsApp (`FirewallRefused`, the campaign skips them); refused for the number
when frozen, outside hours, or over budget (`FirewallBlocked`, the campaign
pauses and resumes when the freeze lifts).

## The vetter

Employee: **سيف — فاحص الأرقام** (role `vetter`, internal), hired on first use
and in `DEFAULT_EMPLOYEES`.

Verdict per contact (`contacts.verdict`: `ready` / `hold` / `rejected`, with
`vet_reasons`, `vetted_at`, `wa_exists`, `risk` 0–100):

| Check | Verdict |
|---|---|
| not a valid number / landline / fake pattern (all one digit, a run) | rejected |
| another spelling of a number already in the list | rejected (the second) |
| on the account's blacklist (asked to stop) | rejected |
| WhatsApp says the number does not exist | rejected (and `status=invalid`) |
| could not be checked (line down, timeout) | hold — never sent cold unverified |
| a country other than the account's (unless the list allows it) | hold |
| tapped «غير مهتم» in the last 180 days | hold |
| ≥ 2 campaign messages in 60 days, none delivered | hold |
| a campaign message in the last 24 h | hold (clears itself) |
| wrote to us within a year / ever replied / read us | ready, lower risk |

`onWhatsApp` runs in chunks of 25, 1.2–2 s apart, at most 1,200 lookups an hour
per number, only when connected.

Where it runs: after every import (replacing the plain existence check), on
reconnect for pending lists, on «افحص الآن», and at campaign start for anything
unvetted or on hold (`ensureVetted`). Campaign selection everywhere:
`status = 'active' AND verdict = 'ready'`.

Seen by the owner: a card on each list (counts by verdict, reasons, last run,
the button), a badge per row, the employee on the team page, and a note in the
team room after each run.

## Files

Flow Hub: `lib/wa-firewall-rules.ts` (pure), `lib/wa-firewall.ts`,
`lib/wa-vetting.ts`, `routes/wa-firewall.ts`, `routes/contacts.ts` (vet
endpoints), `schema/wa_firewall.ts`, `schema/contacts.ts` (+columns),
migrations `064_wa_firewall.sql`, `065_contact_vetting.sql`, `opt-out.ts`
(stop for good + `asksToStop`), `whatsapp.ts` (gate, closes, WhatsApp
standing), `campaigns.ts`, `follow-up-engine.ts`, `smart-followup.ts`,
`wa-send-guard.ts`, `index.ts`, UI `FirewallCard.tsx`, `VettingCard.tsx`,
`Connect.tsx`, `ContactDetail.tsx`, `ContactsList.tsx`, `WaAutopilot.tsx`.

Menu For You / Doctor Hub: the same modules copied; migrations numbered in
their own series (`127_`, `145_`); `notify/outbox.ts` → `transactional`,
`sales/service.ts` → `campaign`; Menu For You's stop period becomes "for good"
(`stopDays` 0).

## Left to the builder

Exact Arabic copy, the vetter's persona, UI layout within the existing cards.
