// Runs every suite in this directory in its own process.
//
// Separate processes on purpose: each suite deletes and re-seeds the rows it
// owns for user 1, and several share tables. Run in one process they would
// interleave and fail for reasons that have nothing to do with the code.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2];
const suites = readdirSync(here)
  .filter((f) => f.endsWith(".test.ts"))
  .filter((f) => !only || f.includes(only))
  .sort();

if (suites.length === 0) {
  console.error(only ? `لا توجد مجموعة تطابق "${only}"` : "لا توجد مجموعات");
  process.exit(1);
}

// The suites write as user 1. That account is not a real one, and an owner
// tidying the admin panel deletes it — which failed 30 suites at once on a
// foreign key. So it is made here for the run, unable to log in, and removed
// again afterwards with everything the suites left under it.
const { db } = await import("@workspace/db");
const { sql } = await import("drizzle-orm");
const made = await db.execute(sql`INSERT INTO users (id, phone, password_hash, display_name)
  VALUES (1, '971500000001', '!test-fixture-no-login', 'حساب الاختبارات المؤقت')
  ON CONFLICT (id) DO NOTHING RETURNING id`);
const madeHere = made.rows.length > 0;
if (madeHere) console.log("أُنشئ حساب الاختبارات المؤقت (١) — يُحذف بعد الانتهاء");

const failed: string[] = [];
for (const suite of suites) {
  console.log(`\n\x1b[1m── ${suite} ${"─".repeat(Math.max(0, 58 - suite.length))}\x1b[0m`);
  const r = spawnSync(process.execPath, ["--import", "tsx", join(here, suite)], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) failed.push(suite);
}

if (madeHere) {
  await db.execute(sql`DELETE FROM users WHERE id = 1 AND phone = '971500000001'`)
    .then(() => console.log("حُذف حساب الاختبارات المؤقت"))
    .catch((e: any) => console.log(`تعذّر حذف حساب الاختبارات المؤقت: ${String(e?.message ?? e).slice(0, 120)}`));
}

console.log(`\n${"═".repeat(62)}`);
if (failed.length === 0) {
  console.log(`\x1b[32m✅ كل المجموعات مرّت (${suites.length})\x1b[0m`);
} else {
  console.log(`\x1b[31m❌ فشلت ${failed.length} من ${suites.length}:\x1b[0m\n  ${failed.join("\n  ")}`);
}
process.exit(failed.length === 0 ? 0 : 1);
