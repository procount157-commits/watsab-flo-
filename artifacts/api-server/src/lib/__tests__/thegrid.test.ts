import assert from "node:assert/strict";
import { gridAllowed } from "../llm";
assert.equal(gridAllowed(2, "2,4"), true);
assert.equal(gridAllowed(4, "2, 4"), true);
assert.equal(gridAllowed(5, "2,4"), false, "the third account never reaches the paid key");
assert.equal(gridAllowed(undefined, "2,4"), false, "a call outside an employee never reaches it");
assert.equal(gridAllowed(2, ""), false);
console.log("thegrid: 5/5 ✅");
