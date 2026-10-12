// The engineer above the team: his actions are parsed from his reply, the
// sensitive ones wait for the owner's yes, the owner's yes is recognised,
// and the dialect a customer writes is read for what it is.

export {};
const { parseActions, needsApproval, ownerApproves, engineerPrompt } = await import("../graph/engineer");
const { dialectOf, dialectLine, read } = await import("../reply-brain");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

const reply = "قستُ: ١٨٠ رداً، متوسط ٩٧.\nالعائق: المتابعة لا تُرسل.\n```actions\n[{\"type\":\"hire\",\"role\":\"wa_reviewer\",\"name\":\"سلطان\",\"kind\":\"internal\",\"persona\":\"يراجع\"},{\"type\":\"set_followup\",\"mode\":\"live\"},{\"type\":\"teach\",\"role\":\"sales\",\"content\":\"سؤال واحد\"}]\n```";
const p = parseActions(reply);
check("the actions block is parsed and removed from the reply", p.actions.length === 3 && !p.reply.includes("```") && p.reply.includes("العائق"));
check("a reply without actions is left as is", parseActions("لا أفعال اليوم.").actions.length === 0);
check("a broken block yields no actions, not a crash", parseActions("```actions\n[{oops\n```").actions.length === 0);
check("hiring an internal role needs no approval", !needsApproval({ type: "hire", role: "wa_reviewer", kind: "internal" }));
check("hiring someone who talks to customers does", needsApproval({ type: "hire", role: "closer", kind: "customer" }));
check("switching follow-up live does", needsApproval({ type: "set_followup", mode: "live" }) && !needsApproval({ type: "set_followup", mode: "dry" }));
check("auto-reply and the team switch do", needsApproval({ type: "set_auto_reply", on: true }) && needsApproval({ type: "set_team_paused", paused: false }));
check("«موافق، نفّذ» is a yes; a question is not", ownerApproves("موافق، نفّذ") && ownerApproves("go ahead") && !ownerApproves("وش رأيك نسوي؟"));
const sys = engineerPrompt("CTX", false);
check("the prompt says measure → diagnose → decide → act → verify", ["قِس", "شخّص", "قرر", "نفّذ", "تحقّق"].every((k) => sys.includes(k)));
check("...reuse before hire, and no sending without the owner", sys.includes("أعد استخدام موظف موجود قبل أن توظف") && sys.includes("لا تُرسل شيئاً لعميل"));
check("...and no sensitive act without a yes in this message", sys.includes("الأفعال الحساسة ممنوعة") && engineerPrompt("CTX", true).includes("يجوز لك تنفيذ"));

check("Egyptian is read", dialectOf("عايز اعرف السعر دلوقتي لو سمحت") === "egyptian");
check("Levantine is read", dialectOf("بدي اعرف السعر هلأ كتير ضروري") === "levant");
check("Gulf is read", dialectOf("ابغى اعرف السعر الحين وايد ضروري") === "gulf");
check("standard Arabic becomes Gulf only when the account fixes it", dialectOf("أريد معرفة السعر من فضلك") === "msa" && dialectOf("أريد معرفة السعر من فضلك", "gulf") === "gulf");
check("an Egyptian customer stays Egyptian even on the Gulf account", dialectOf("عايز اعرف السعر دلوقتي", "gulf") === "egyptian");
check("English is English", dialectOf("How much is it?") === "en");
check("the reading carries the dialect", read("عايز اعرف السعر دلوقتي", {}).dialect === "egyptian");
check("the Egyptian line forbids mixing", dialectLine("egyptian").includes("مصرية") && dialectLine("egyptian").includes("لا تخلطها"));

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
