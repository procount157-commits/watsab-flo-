// The social desks, against the real tables for user 1 and without a browser
// or a model: links read per platform; a team of twelve per platform with its
// skills; the gate that refuses outside hours, past a cap, after failures and
// too soon after the last action; target lists that take each person once;
// a sheet read for whichever column holds the links; and nothing sent in dry run.

export {};
const { and, eq, inArray, like } = await import("drizzle-orm");
const { db, socialAccountsTable, socialActionsTable, socialListsTable, socialTargetsTable, botEmployeesTable, agentSkillGrantsTable, agentSkillsTable, agentTasksTable } = await import("@workspace/db");
const { PLATFORM, postIdOf, personOf, capsFor, gulfHour } = await import("../social/platforms");
const { teamDefs, teamRoles, ensureSocialTeam, JOBS } = await import("../social/team");
const { ensureAccount, mayAct, todayCounts, sendApproved, prepareOutreach } = await import("../social/engine");
const { addTargets, createList, rowsFromSheet, listsWithFunnel } = await import("../social/desk");
const { DRIVEN } = await import("../social/drivers");

const USER = 1;
let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };
async function clean() {
  for (const t of [socialTargetsTable, socialListsTable, socialActionsTable, socialAccountsTable] as const) await db.delete(t).where(eq((t as any).userId, USER));
  const roles = [...teamRoles("tiktok"), ...teamRoles("instagram")];
  await db.delete(agentSkillGrantsTable).where(and(eq(agentSkillGrantsTable.userId, USER), inArray(agentSkillGrantsTable.role, roles)));
  await db.delete(agentTasksTable).where(and(eq(agentTasksTable.userId, USER), inArray(agentTasksTable.role, roles)));
  await db.delete(botEmployeesTable).where(and(eq(botEmployeesTable.userId, USER), inArray(botEmployeesTable.role, roles)));
}
await clean();

// ── Links ────────────────────────────────────────────────────────
check("an Instagram post or reel link is read", postIdOf("instagram", "https://www.instagram.com/p/C9xYz_1AbC/?img_index=1") === "C9xYz_1AbC" && postIdOf("instagram", "https://instagram.com/reel/DAbc123/") === "DAbc123");
check("a TikTok video link is read", postIdOf("tiktok", "https://www.tiktok.com/@procount/video/7412345678901234567?lang=en") === "7412345678901234567");
check("a LinkedIn post link is read", postIdOf("linkedin", "https://www.linkedin.com/feed/update/urn:li:activity:7245678901234567890/") === "7245678901234567890");
check("...and a page that is not a post is refused", postIdOf("instagram", "https://www.instagram.com/procount/") === null);
const ig = personOf("instagram", "https://www.instagram.com/Dubai.Homes/?hl=en");
check("an Instagram profile becomes a handle", ig?.handle === "dubai.homes" && ig.profileUrl === "https://www.instagram.com/Dubai.Homes/");
check("...and Instagram's own pages are not people", personOf("instagram", "https://www.instagram.com/explore/") === null);
check("a TikTok @name becomes a handle", personOf("tiktok", "@dubai_realty")?.profileUrl === "https://www.tiktok.com/@dubai_realty");
const li = personOf("linkedin", "https://ae.linkedin.com/in/Ahmed-Ali-12345/?originalSubdomain=ae");
check("a LinkedIn profile becomes a handle", li?.handle === "ahmed-ali-12345" && li.profileUrl === "https://www.linkedin.com/in/Ahmed-Ali-12345/");

// ── Caps ─────────────────────────────────────────────────────────
check("caps default to the platform's", capsFor("tiktok", {}).outreach === PLATFORM.tiktok.caps.outreach);
check("an owner's cap is honoured but never past three times the default", capsFor("instagram", { outreach: 5 }).outreach === 5 && capsFor("instagram", { outreach: 999 }).outreach === PLATFORM.instagram.caps.outreach * 3);
check("LinkedIn's first contact is an invitation under 300 characters", PLATFORM.linkedin.firstContact === "connect" && PLATFORM.linkedin.firstContactMax === 300);
check("the platforms that can act are Instagram and TikTok", DRIVEN.includes("instagram") && DRIVEN.includes("tiktok") && !DRIVEN.includes("linkedin"));

// ── Teams ────────────────────────────────────────────────────────
for (const p of ["instagram", "tiktok", "linkedin"] as const) {
  const t = teamDefs(p);
  check(`${p}: twelve jobs, each its own role and name`, t.length === JOBS.length && new Set(t.map((x) => x.role)).size === 12 && new Set(t.map((x) => x.name)).size === 12);
}
const allNames = (["instagram", "tiktok", "linkedin"] as const).flatMap((p) => teamDefs(p).map((d) => d.name));
check("no name is shared between platforms", new Set(allNames).size === allNames.length);
const hired = await ensureSocialTeam(USER, "tiktok");
check("TikTok's team is hired on first use", hired.length === 12);
const again = await ensureSocialTeam(USER, "tiktok");
check("...once", again.length === 12);
const grants = await db.select({ role: agentSkillGrantsTable.role, name: agentSkillsTable.name }).from(agentSkillGrantsTable).innerJoin(agentSkillsTable, eq(agentSkillsTable.id, agentSkillGrantsTable.skillId))
  .where(and(eq(agentSkillGrantsTable.userId, USER), like(agentSkillGrantsTable.role, "tt_%")));
check("the prospector carries the first-contact skill", grants.some((g) => g.role === "tt_prospector" && g.name === "التواصل الأول"));
check("the creator carries the content skill", grants.some((g) => g.role === "tt_creator" && g.name === "صناعة المحتوى"));
check("all twelve carry account safety", new Set(grants.filter((g) => g.name === "سلامة حساب التواصل").map((g) => g.role)).size === 12);

// ── The gate ─────────────────────────────────────────────────────
const g0 = await mayAct(USER, "tiktok", "dm");
check("no account, no action", !g0.allowed && /لم يُضبط/.test(g0.reason ?? ""), g0.reason);
const acc = await ensureAccount(USER, "tiktok");
check("an account starts in dry run, waiting for approval, autopilot off", acc.dryRun && acc.mode === "approve" && !acc.autopilot && acc.profile === "tt_desk");
const g1 = await mayAct(USER, "tiktok", "dm");
check("signed out, no action", !g1.allowed && /غير مسجّل/.test(g1.reason ?? ""), g1.reason);
await db.update(socialAccountsTable).set({ state: "restricted" }).where(eq(socialAccountsTable.id, acc.id));
check("restricted, no action", /قيّد/.test((await mayAct(USER, "tiktok", "dm")).reason ?? ""));
await db.update(socialAccountsTable).set({ state: "logged_in" }).where(eq(socialAccountsTable.id, acc.id));
const h = gulfHour(), [from, to] = PLATFORM.tiktok.pace.hours;
if (h < from || h >= to) {
  check("outside Gulf working hours, no action", /ساعات/.test((await mayAct(USER, "tiktok", "dm")).reason ?? ""));
} else {
  check("inside hours, signed in, nothing done today: allowed", (await mayAct(USER, "tiktok", "outreach")).allowed);
  const old = new Date(Date.now() - 3 * 3_600_000);
  await db.insert(socialActionsTable).values(Array.from({ length: PLATFORM.tiktok.caps.outreach }, () => ({ userId: USER, platform: "tiktok", role: "tt_prospector", action: "outreach_dm", createdAt: old })));
  const capped = await mayAct(USER, "tiktok", "outreach");
  check("at the day's cap of first messages, no more", !capped.allowed && /حد اليوم/.test(capped.reason ?? ""), capped.reason);
  check("...while replies to people who wrote are a separate budget", (await mayAct(USER, "tiktok", "dm")).allowed);
  await db.insert(socialActionsTable).values({ userId: USER, platform: "tiktok", role: "tt_dm", action: "send_dm" });
  const gap = await mayAct(USER, "tiktok", "dm");
  check("too soon after the last action: wait", !gap.allowed && (gap.waitMs ?? 0) > 0, `${Math.round((gap.waitMs ?? 0) / 1000)}s`);
  await db.insert(socialActionsTable).values(Array.from({ length: 5 }, () => ({ userId: USER, platform: "tiktok", role: "tt_dm", action: "send_dm", ok: false, createdAt: old })));
  check("five failures in a day stop everything", /فشلت/.test((await mayAct(USER, "tiktok", "dm")).reason ?? ""));
  const t = await todayCounts(USER, "tiktok");
  check("the day's counts are by kind", t.used.outreach === PLATFORM.tiktok.caps.outreach && t.used.dm === 1 && t.fails === 5);
}

// ── Lists ────────────────────────────────────────────────────────
const list = await createList(USER, "tiktok", "وسطاء عقاريون دبي");
const r1 = await addTargets(USER, "tiktok", list.id, [{ url: "https://www.tiktok.com/@dubai_realty" }, { handle: "@Dubai_Realty" }, { handle: "not a handle!!" }, { handle: "palm.homes", name: "Palm Homes", headline: "Real estate brokerage in Dubai" }], "manual");
check("each person once per platform, nonsense refused", r1.added === 2 && r1.duplicate === 1 && r1.invalid === 1, JSON.stringify(r1));
const [palm] = await db.select().from(socialTargetsTable).where(and(eq(socialTargetsTable.userId, USER), eq(socialTargetsTable.handle, "palm.homes")));
check("a target's sector is read from what we know of it", !!palm?.sector, palm?.sector ?? "");
const funnel = await listsWithFunnel(USER, "tiktok");
check("the list counts its people", funnel[0]?.total === 2 && funnel[0]?.reached === 0);
const sheet = rowsFromSheet("instagram", [{ "Company": "Al Noor", "Instagram": "https://instagram.com/alnoor.re", "City": "Dubai" }, { "Company": "No link here" }, { "username": "palmjumeirah" }]);
check("a sheet is read for the column with links or handles", sheet.length === 2 && sheet[0]!.url?.includes("alnoor.re") === true && sheet[0]!.company === "Al Noor" && sheet[1]!.handle === "palmjumeirah");

// ── Nothing leaves in dry run, and nothing is written for lists not chosen ─
const sent = await sendApproved(USER, "tiktok");
check("dry run sends nothing and says why", sent.sent === 0 && /التجربة/.test(sent.held ?? ""), sent.held ?? "");
check("with no list chosen, no first message is written", (await prepareOutreach(USER, "tiktok")) === 0);

await clean();
console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
