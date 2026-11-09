// Pure decisions of the kill switches and the gateway, and a static check that
// nothing new reaches a wire past them.
//   DATABASE_URL=postgres://x:x@127.0.0.1:1/x npx tsx src/lib/__tests__/org-safety.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const { decideHalt, departmentOf, departmentOfChannel, controlScopeFor, CLEAR, UNAVAILABLE } = await import("../org/controls");
const { decideGate, suppressionApplies } = await import("../org/gateway");
const { ORG_TABLES_SQL } = await import("../org/schema");
const { routeByTask } = await import("../llm");
const { asAgent, asWorker, currentAgent, routedAgent } = await import("../agent-context");

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}`, detail ?? ""); }
};
const row = (scope: string, userId: number | null, target = "", reason: string | null = null, engaged = true) => ({ scope, userId, target, engaged, reason });

// ── decideHalt: each level, its order, its reach ──
check("nothing engaged: clear", !decideHalt([], { userId: 2, channel: "email", role: "email", department: "email" }).halted);
check("a row not engaged does nothing", !decideHalt([row("global", null, "", null, false)], { userId: 2 }).halted);
check("global stops everyone", decideHalt([row("global", null)], { userId: 2 }).scope === "global");
check("global stops a call with no account", decideHalt([row("global", null)], {}).scope === "global");
check("account stops its own", decideHalt([row("account", 2)], { userId: 2 }).scope === "account");
check("another account's switch stops nothing", !decideHalt([row("account", 4)], { userId: 2 }).halted);
check("no account named: the account switch cannot apply", !decideHalt([row("account", 4)], {}).halted);
check("channel: the account's", decideHalt([row("channel", 2, "email")], { userId: 2, channel: "email" }).scope === "channel");
check("channel: platform-wide", decideHalt([row("channel", null, "email")], { userId: 2, channel: "email" }).scope === "channel");
check("channel: a different channel passes", !decideHalt([row("channel", 2, "email")], { userId: 2, channel: "whatsapp" }).halted);
check("channel: another account's passes", !decideHalt([row("channel", 4, "email")], { userId: 2, channel: "email" }).halted);
check("department", decideHalt([row("department", 2, "email")], { userId: 2, department: "email" }).scope === "department");
check("department: either of several", decideHalt([row("department", 2, "email")], { userId: 2, department: ["accounts", "email"] }).scope === "department");
check("employee", decideHalt([row("employee", 2, "email_followup")], { userId: 2, role: "email_followup" }).scope === "employee");
check("employee: another employee works on", !decideHalt([row("employee", 2, "email_followup")], { userId: 2, role: "email" }).halted);
check("order: global before account", decideHalt([row("account", 2), row("global", null)], { userId: 2 }).scope === "global");
check("order: account before channel", decideHalt([row("channel", 2, "email"), row("account", 2)], { userId: 2, channel: "email" }).scope === "account");
check("order: channel before department", decideHalt([row("department", 2, "email"), row("channel", 2, "email")], { userId: 2, channel: "email", department: "email" }).scope === "channel");
check("order: department before employee", decideHalt([row("employee", 2, "email"), row("department", 2, "email")], { userId: 2, department: "email", role: "email" }).scope === "department");
check("the reason given is the reason returned", decideHalt([row("global", null, "", "حادث")], {}).reason === "حادث");
// The old switches, with their old words.
const paused = decideHalt([], { userId: 2 }, { teamPaused: true });
check("team_paused is an account stop, in its own words", paused.scope === "account" && paused.reason === "الفريق كله موقوف" && paused.legacy === true);
const off = decideHalt([], { userId: 2, role: "sales" }, { employeeOff: true });
check("is_active=false is an employee stop, in its own words", off.scope === "employee" && off.reason === "الموظف موقوف" && off.legacy === true);
check("an org switch outranks the old one and is not `legacy`", !decideHalt([row("account", 2)], { userId: 2 }, { teamPaused: true }).legacy);

check("departments of roles", departmentOf("email_followup") === "email" && departmentOf("email") === "email" && departmentOf("accounts_writer") === "accounts"
  && departmentOf("ig_manager") === "social" && departmentOf("sales") === "whatsapp" && departmentOf("ops") === "operations" && departmentOf(null) === null);
check("departments of channels", departmentOfChannel("email") === "email" && departmentOfChannel("whatsapp") === "whatsapp" && departmentOfChannel("tiktok") === "social");

// ── decideGate ──
const go = { channel: "whatsapp", kind: "campaign", halt: CLEAR, optedOut: false };
check("clear: allowed", decideGate(go).allowed);
check("halted: refused, with the scope", decideGate({ ...go, halt: { halted: true, scope: "channel", reason: "x" } }).scope === "channel");
check("controls unavailable: refused", decideGate({ ...go, halt: UNAVAILABLE }).code === "halted");
check("opted out: refused as the person's no", decideGate({ ...go, optedOut: true }).code === "opted_out");
check("a warm follow-up to someone who said stop is refused too", decideGate({ ...go, kind: "followup", optedOut: true }).code === "opted_out");
check("a reply to someone who wrote is left as it was", decideGate({ ...go, kind: "reply", optedOut: true }).allowed);
check("the stop acknowledgement still goes", decideGate({ ...go, kind: "optout_ack", optedOut: true }).allowed);
check("the owner's hand-typed message is left to admit", decideGate({ ...go, kind: "manual", optedOut: true }).allowed);
check("an unknown kind is suppressed: the default is no", suppressionApplies("something_new"));
check("a test to the owner's own address ignores the list", decideGate({ channel: "email", kind: "test", selfAddressed: true, halt: CLEAR, optedOut: true }).allowed);
check("a test to anyone else does not", decideGate({ channel: "email", kind: "test", selfAddressed: false, halt: CLEAR, optedOut: true }).code === "opted_out");
check("linkedin: always no, however clear", decideGate({ channel: "linkedin", kind: "post", halt: CLEAR }).code === "no_driver");
check("owner_notice to the owner: passes a stop", decideGate({ channel: "email", kind: "owner_notice", selfAddressed: true, halt: { halted: true, scope: "global", reason: "x" } }).allowed);
check("owner_notice to anyone else: refused", decideGate({ channel: "email", kind: "owner_notice", selfAddressed: false, halt: CLEAR }).code === "not_owner");
const legacy = { halted: true, scope: "account" as const, reason: "الفريق كله موقوف", legacy: true };
check("team_paused stops the machine's sends", decideGate({ ...go, halt: legacy }).code === "halted");
check("team_paused does not stop the owner's hand", decideGate({ ...go, kind: "manual", halt: legacy }).allowed);
check("team_paused does not stop the stop's acknowledgement", decideGate({ ...go, kind: "optout_ack", halt: legacy }).allowed);
check("an org switch does stop the owner's hand", decideGate({ ...go, kind: "manual", halt: { halted: true, scope: "account", reason: "x" } }).code === "halted");

// ── Who may set what ──
const me = { userId: 2, isAdmin: false }, admin = { userId: 1, isAdmin: true };
check("global: not for an account owner", (controlScopeFor({ scope: "global", engaged: true }, me) as any).status === 403);
check("global: for an admin", (controlScopeFor({ scope: "global", engaged: true }, admin) as any).scope === "global");
const a2 = controlScopeFor({ scope: "account", engaged: true }, me) as any;
check("account: always one's own", a2.ok && a2.userId === 2);
check("account: not another's", (controlScopeFor({ scope: "account", engaged: true }, { ...me, forUserId: 4 }) as any).status === 403);
check("account: an admin may name one", (controlScopeFor({ scope: "account", engaged: true }, { ...admin, forUserId: 4 }) as any).userId === 4);
check("channel: must exist", (controlScopeFor({ scope: "channel", target: "fax", engaged: true }, me) as any).status === 400);
check("employee: needs a target", (controlScopeFor({ scope: "employee", engaged: true }, me) as any).status === 400);
check("platform-wide channel: admin only", (controlScopeFor({ scope: "channel", target: "email", engaged: true }, { ...me, platformWide: true }) as any).status === 403);
check("platform-wide channel: for an admin", (controlScopeFor({ scope: "channel", target: "email", engaged: true }, { ...admin, platformWide: true }) as any).userId === null);
check("unknown scope", (controlScopeFor({ scope: "galaxy", engaged: true }, admin) as any).status === 400);

// ── asWorker: named for the switches, routed as before ──
await asWorker(2, "collector", async () => {
  check("asWorker names the account and role", currentAgent()?.userId === 2 && currentAgent()?.role === "collector");
  check("asWorker does not change the model route", routedAgent() === undefined);
});
await asAgent(2, "email", async () => {
  await asWorker(2, "collector", async () => {
    check("inside asAgent, asWorker changes nothing", currentAgent()?.role === "email" && routedAgent()?.role === "email");
  });
});
const ms = [{ provider: "x", model: "dots-3" }, { provider: "y", model: "m" }];
check("routeByTask itself untouched", routeByTask(ms, null).length === 1 && routeByTask(ms, "email")[0]!.model === "dots-3");

// ── The migration is what the server runs at boot ──
const here = fileURLToPath(new URL(".", import.meta.url));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const migration = norm(readFileSync(join(here, "../../../../../lib/db/migrations/072_org.sql"), "utf8"));
check("072_org.sql carries every statement of ensureOrgTables", ORG_TABLES_SQL.every((q) => migration.includes(norm(q))), ORG_TABLES_SQL.find((q) => !migration.includes(norm(q))));

// ── Static: no new way to the wire ──
const SRC = join(here, "../..");
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "__tests__") walk(p); } else if (f.endsWith(".ts")) files.push(p); } };
walk(SRC);
// Comments are stripped: a note that names a primitive is not a use of it.
const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
const hits = (re: RegExp) => files.filter((f) => re.test(code(f))).map((f) => relative(SRC, f)).sort();

const wa = /\b(sock|socket)\??\.(sendMessage|relayMessage)\(|\.state\.socket!?\.sendMessage\(|\.relayMessage\(/;
check("WhatsApp socket sends live in lib/whatsapp.ts alone", JSON.stringify(hits(wa)) === JSON.stringify(["lib/whatsapp.ts"]), hits(wa));
check("nodemailer .sendMail( lives in lib/email/provider.ts alone", JSON.stringify(hits(/\.sendMail\(/)) === JSON.stringify(["lib/email/provider.ts"]), hits(/\.sendMail\(/));
const mailApis = /api\.resend\.com\/emails|api\.brevo\.com\/v3\/smtp/;
check("the mail APIs are called from lib/email/provider.ts alone", JSON.stringify(hits(mailApis)) === JSON.stringify(["lib/email/provider.ts"]), hits(mailApis));

const waSrc = code(join(SRC, "lib/whatsapp.ts"));
check("the class's send asks the gate on the way in and again before the wire",
  /!opts\?\.gated\) await waGate\(this\.userId, phone, gateKind\)/.test(waSrc) && /await waGate\(this\.userId, phone, gateKind, true\)/.test(waSrc));
check("directSend asks the gate", /kind: "diagnostic"/.test(waSrc));
const outside = waSrc.split("\n").filter((l) => /(socket|sock)!?\.sendMessage\(/.test(l) && !/withTimeout\(/.test(l) && !/pass\(/.test(l));
check("the raw socket sends outside the guarded path are the known two (directSend, the recall)",
  outside.length === 2 && outside.some((l) => /delete:/.test(l)) && outside.some((l) => /text: message/.test(l)), outside);
const provider = readFileSync(join(SRC, "lib/email/provider.ts"), "utf8");
check("sendEmail asks the gate before anything goes", provider.indexOf("gateSend({") > provider.indexOf("export async function sendEmail") && provider.indexOf("gateSend({") < provider.indexOf(".sendMail("));
const drivers = readFileSync(join(SRC, "lib/social/drivers/index.ts"), "utf8");
check("no raw driver leaves the social index", /export const DRIVERS/.test(drivers) && hits(/\bDRIVERS\b/).join() === "lib/social/drivers/index.ts", hits(/\bDRIVERS\b/));
const llm = readFileSync(join(SRC, "lib/llm.ts"), "utf8");
check("complete() asks isHalted before any provider", llm.indexOf("await isHalted(") > 0 && llm.indexOf("await isHalted(") < llm.indexOf("const out = await completeInner("));
for (const [file, needle] of [["lib/vision.ts", "modelHalted("], ["lib/voice.ts", "modelHalted("], ["lib/intent.ts", "modelHalted("], ["lib/image-sense.ts", "modelHalted("], ["routes/ai.ts", "modelHalted("]] as const) {
  check(`${file} asks the switch before its direct model call`, readFileSync(join(SRC, file), "utf8").includes(needle));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
process.exit(0);
