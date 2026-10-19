import assert from "node:assert/strict";
import { parseLoose } from "../loose-json";
assert.deepEqual(parseLoose('```json\n{"a":[1,2]}\n```'), { a: [1, 2] });
assert.deepEqual(parseLoose('```json\n{"questions":["x","y"],"ideas":["z", "نص مقطو'), { questions: ["x", "y"], ideas: ["z"] });
assert.deepEqual(parseLoose('{"q":[{"t":"a"},{"t":"b'), { q: [{ t: "a" }] });
assert.equal(parseLoose("لا يوجد"), null);
console.log("loose-json: 4/4");
