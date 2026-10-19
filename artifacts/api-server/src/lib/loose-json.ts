// ── JSON من نموذجٍ قد يقطع ردّه ───────────────────────────────────
// النماذج المجانية تُرجع JSON داخل ```json أحياناً، وتقطعه قبل نهايته
// أحياناً أخرى (حدّ طول الرد). كان الرد كله يُرمى. هنا يُقرأ ما اكتمل منه:
// يُقصّ عند آخر قيمةٍ اكتملت، وتُغلق الأقواس المفتوحة.

/** The longest complete JSON object at the start of a model's reply, or null. Pure. */
export function parseLoose<T = any>(text: string): T | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const body = text.slice(start);
  try { return JSON.parse(body.slice(0, body.lastIndexOf("}") + 1)); } catch { /* repair below */ }
  // Walk it, remembering the last place a value closed outside a string.
  const stack: string[] = [];
  let inStr = false, esc = false, lastGood = -1, stackAtGood: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") { inStr = false; if (stack.at(-1) === "]") { lastGood = i; stackAtGood = [...stack]; } } continue; }
    if (ch === "\"") { inStr = true; continue; }
    if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      stack.pop();
      lastGood = i; stackAtGood = [...stack];
      if (!stack.length) break;
    }
  }
  if (lastGood < 0) return null;
  const repaired = body.slice(0, lastGood + 1).replace(/,\s*$/, "") + stackAtGood.reverse().join("");
  try { return JSON.parse(repaired); } catch { return null; }
}
