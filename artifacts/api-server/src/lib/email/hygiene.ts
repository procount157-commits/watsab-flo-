// ── List hygiene: what is likely to bounce, before it does ────────
// Two kinds of bounce, and they need different defences:
//
//   a dead domain    no mail server at all — every address there bounces.
//                    Caught by a DNS lookup, now done for every address
//                    before its first send, not only at import.
//   a dead mailbox   the domain is fine, the person left. The account's first
//                    five bounces were all this kind, at large brokerages.
//                    Nothing short of sending proves it, so the risk is
//                    estimated: a personal mailbox at a domain where another
//                    personal mailbox already bounced is the riskiest address
//                    on the list; one at a company with many people on the
//                    list is next (staff turn over); a role address (info@)
//                    rarely bounces at all.
//
// The riskiest are held back by default and the rest go lowest-risk first,
// so a new sending address spends its first weeks on the addresses most
// likely to arrive.

import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db, emailContactsTable, emailListMembersTable, type EmailContact } from "@workspace/db";
import { checkMx, isRoleAddress } from "./importer";
import { warmupCap } from "./health";

export type Risk = "low" | "medium" | "high";
const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";

/** Domains where a personal mailbox has bounced, and how many contacts each domain has. */
export async function domainSignals(userId: number) {
  const rows = await db.execute<{ domain: string; n: number; bounced: number }>(sql`
    SELECT lower(split_part(email, '@', 2)) AS domain, count(*)::int AS n,
      count(*) FILTER (WHERE status = 'bounced')::int AS bounced
    FROM email_contacts WHERE user_id = ${userId} GROUP BY 1`);
  return new Map(rows.rows.map((r) => [r.domain, { n: Number(r.n), bounced: Number(r.bounced) }]));
}

export function riskOf(c: Pick<EmailContact, "email" | "mxOk" | "status">, signals: Map<string, { n: number; bounced: number }>): Risk {
  if (c.mxOk === false || c.status === "bounced") return "high";
  if (isRoleAddress(c.email)) return "low";
  const d = signals.get(domainOf(c.email));
  if (d?.bounced) return "high";
  return (d?.n ?? 0) >= 15 ? "medium" : "low";
}

/** Look up every domain not checked in the last month — for these contacts, or all of the account's. */
export async function verifyDomains(userId: number, contactIds?: number[], opts: { maxDomains?: number } = {}) {
  const stale = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db.select({ id: emailContactsTable.id, email: emailContactsTable.email }).from(emailContactsTable).where(and(
    eq(emailContactsTable.userId, userId),
    contactIds ? inArray(emailContactsTable.id, contactIds.length ? contactIds : [-1]) : sql`true`,
    or(isNull(emailContactsTable.mxCheckedAt), lt(emailContactsTable.mxCheckedAt, stale), isNull(emailContactsTable.mxOk)),
  ));
  const domains = [...new Set(rows.map((r) => domainOf(r.email)).filter(Boolean))].slice(0, opts.maxDomains ?? 3_000);
  if (!domains.length) return { checked: 0, dead: 0, unknown: 0 };
  const result = await checkMx(domains, 16);
  let dead = 0, unknown = 0;
  for (const [domain, ok] of result) {
    if (ok === false) dead++; if (ok === null) unknown++;
    // An unknown answer (a timeout) is not a verdict: it is left to be asked again.
    if (ok === null) continue;
    await db.update(emailContactsTable).set({ mxOk: ok, mxCheckedAt: new Date() })
      .where(and(eq(emailContactsTable.userId, userId), sql`lower(split_part(${emailContactsTable.email}, '@', 2)) = ${domain}`));
  }
  return { checked: result.size, dead, unknown };
}

/** A list's health, or the account's: what will arrive, what will not, what might not. */
export async function hygieneReport(userId: number, listId?: number | null) {
  const contacts = listId
    ? (await db.select({ c: emailContactsTable }).from(emailListMembersTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId)).where(eq(emailListMembersTable.listId, listId))).map((r) => r.c)
    : await db.select().from(emailContactsTable).where(eq(emailContactsTable.userId, userId));
  const signals = await domainSignals(userId);
  const r = { total: contacts.length, active: 0, deadDomain: 0, unverified: 0, bounced: 0, unsubscribed: 0, role: 0, personal: 0, risk: { low: 0, medium: 0, high: 0 } as Record<Risk, number> };
  for (const c of contacts) {
    if (c.status === "bounced" || c.status === "complained") { r.bounced++; continue; }
    if (c.status === "unsubscribed") { r.unsubscribed++; continue; }
    r.active++;
    if (c.mxOk === false) r.deadDomain++;
    if (c.mxOk == null) r.unverified++;
    if (isRoleAddress(c.email)) r.role++; else r.personal++;
    r.risk[riskOf(c, signals)]++;
  }
  const bouncedDomains = [...signals.entries()].filter(([, s]) => s.bounced > 0).map(([domain, s]) => ({ domain, contacts: s.n, bounced: s.bounced }))
    .sort((a, b) => b.bounced - a.bounced).slice(0, 15);
  return { ...r, bouncedDomains };
}

/** Take out of a list everyone who cannot or must not be written to. They stay in the account's records. */
export async function cleanList(userId: number, listId: number, opts: { risky?: boolean } = {}) {
  const members = (await db.select({ c: emailContactsTable }).from(emailListMembersTable).innerJoin(emailContactsTable, eq(emailContactsTable.id, emailListMembersTable.contactId))
    .where(and(eq(emailListMembersTable.listId, listId), eq(emailContactsTable.userId, userId)))).map((r) => r.c);
  const signals = opts.risky ? await domainSignals(userId) : null;
  const out = members.filter((c) => c.status !== "active" || c.mxOk === false || (signals && riskOf(c, signals) === "high")).map((c) => c.id);
  for (let i = 0; i < out.length; i += 500) {
    await db.delete(emailListMembersTable).where(and(eq(emailListMembersTable.listId, listId), inArray(emailListMembersTable.contactId, out.slice(i, i + 500))));
  }
  return { removed: out.length, kept: members.length - out.length };
}

/** Order a send lowest-risk first, and drop the riskiest when the account says so. */
export function byRisk<T extends Pick<EmailContact, "email" | "mxOk" | "status">>(contacts: T[], signals: Map<string, { n: number; bounced: number }>, skipRisky: boolean) {
  const rank: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
  const scored = contacts.map((c) => ({ c, r: riskOf(c, signals) }));
  const held = skipRisky ? scored.filter((x) => x.r === "high").length : 0;
  const kept = scored.filter((x) => !(skipRisky && x.r === "high")).sort((a, b) => rank[a.r] - rank[b.r]).map((x) => x.c);
  return { kept, held };
}

/** The warm-up schedule from today: how much the address may send each day for the next two weeks. */
export function warmupPlan(dailyCap: number, ageDays: number, on: boolean, days = 14) {
  return Array.from({ length: days }, (_, i) => ({ day: ageDays + i, cap: warmupCap(dailyCap, ageDays + i, on) }));
}

/**
 * Pull the riskiest addresses out of what is already queued — the guard's
 * answer to a bounce, instead of freezing everything. Queued messages to a
 * dead domain, a bounced contact or a high-risk mailbox are cancelled; the
 * campaigns keep going with the rest.
 */
export async function holdRiskyQueued(userId: number) {
  const rows = await db.execute<{ id: number; email: string; mx_ok: boolean | null; status: string }>(sql`
    SELECT m.id, c.email, c.mx_ok, c.status FROM email_messages m JOIN email_contacts c ON c.id = m.contact_id
    WHERE m.user_id = ${userId} AND m.status IN ('queued', 'ab_hold')`);
  if (!rows.rows.length) return { held: 0, of: 0 };
  const signals = await domainSignals(userId);
  const out = rows.rows.filter((r) => riskOf({ email: r.email, mxOk: r.mx_ok, status: r.status }, signals) === "high").map((r) => r.id);
  for (let i = 0; i < out.length; i += 500) {
    await db.execute(sql`UPDATE email_messages SET status = 'cancelled', error = 'حُجز: عنوان عالي الخطر' WHERE id IN (${sql.join(out.slice(i, i + 500).map((id) => sql`${id}`), sql`, `)})`);
  }
  return { held: out.length, of: rows.rows.length };
}
