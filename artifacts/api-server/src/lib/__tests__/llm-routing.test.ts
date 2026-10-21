// Which free models may write Arabic to customers, and the spare-key pool. Pure.
import assert from "node:assert/strict";
process.env["OPENROUTER_API_KEYS"] = " k1, k2 ,,k1 ";
const { routeByTask, openrouterPool } = await import("../llm");
let n = 0; const ok = (c: boolean, m: string) => { assert.ok(c, m); n++; };
const c = (model: string) => ({ provider: "openrouter", model });
const all = [c("nvidia/nemotron-3-ultra-550b-a55b:free"), c("nvidia/nemotron-3.5-super-vl:free"), c("nvidia/nemotron-3-super-120b-a12b:free"), c("nvidia/nemotron-3.5-lightning:free"), c("minimax/minimax-m3.1-flash:free")];
const wa = routeByTask(all, "sales").map((x) => x.model);
ok(wa.includes("nvidia/nemotron-3-ultra-550b-a55b:free") && wa.includes("nvidia/nemotron-3.5-super-vl:free"), "the two nemotrons that wrote clean Arabic may answer customers");
ok(!wa.includes("nvidia/nemotron-3-super-120b-a12b:free") && !wa.includes("nvidia/nemotron-3.5-lightning:free"), "the ones that broke Arabic may not");
ok(wa[0] === "nvidia/nemotron-3-ultra-550b-a55b:free", "the strongest stays first");
ok(routeByTask(all, "email").length === all.length && routeByTask(all, "email")[0]!.model === "nvidia/nemotron-3-super-120b-a12b:free", "the email team keeps every model, the English-only ones first");
ok(openrouterPool().join() === "k1,k2,k1", "the pool reads the list, blanks dropped (duplicates are dropped at call time)");
console.log(`llm-routing: ${n}/${n} ✅`);
