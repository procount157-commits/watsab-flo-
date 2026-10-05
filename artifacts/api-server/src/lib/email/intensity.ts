// ── How hard the follow-up path works ─────────────────────────────
// The owner asked for intensive follow-up. Three levels, each a fixed path
// after the first email — the touch on the day the first follow-up is due
// splits by what the person did (opened → a new angle and a question; did not
// open → the same offer, shorter, under a new subject), and every later step
// goes to everyone who has not replied. Every path stops at a reply, an
// unsubscribe or a bounce.

export type Intensity = "light" | "normal" | "intense";
export type FollowKind = "value" | "angle" | "bump" | "breakup";

export const INTENSITY: Record<Intensity, { label: string; firstAfterHours: number; steps: Array<{ kind: FollowKind; afterHours: number; day: number }> }> = {
  light:   { label: "خفيف — ٣ رسائل", firstAfterHours: 72, steps: [{ kind: "breakup", afterHours: 168, day: 10 }] },
  normal:  { label: "عادي — ٤ رسائل", firstAfterHours: 72, steps: [{ kind: "value", afterHours: 96, day: 7 }, { kind: "breakup", afterHours: 264, day: 14 }] },
  intense: { label: "مكثّف — ٦ رسائل", firstAfterHours: 48, steps: [
    { kind: "value", afterHours: 72, day: 5 },
    { kind: "angle", afterHours: 168, day: 9 },
    { kind: "bump", afterHours: 288, day: 14 },
    { kind: "breakup", afterHours: 456, day: 21 },
  ] },
};

export function asIntensity(v: unknown, fallback: Intensity = "intense"): Intensity {
  return v === "light" || v === "normal" || v === "intense" ? v : fallback;
}

export const KIND_AR: Record<string, string> = {
  first: "الأولى", warm: "فتح ولم يرد", cold: "لم يفتح — عنوان جديد",
  value: "معلومة مفيدة", angle: "زاوية جديدة", bump: "تذكير قصير", breakup: "الرسالة الأخيرة",
};

/** What the writer is asked for, per kind, in the draft's own block format. */
export const FOLLOW_PROMPT: Record<FollowKind, string[]> = {
  value: ["[متابعة جمهور=قيمة]", "عنوان: <one genuinely useful fact or tip from the knowledge base for their sector — a reason to open that is not a sales pitch>", "<body: the insight, why it matters to them, a soft call to action>", "[/متابعة]"],
  angle: ["[متابعة جمهور=زاوية]", "عنوان: <a completely different pain point or service angle that has NOT been used yet>", "<body: short, one new reason, one easy question>", "[/متابعة]"],
  bump: ["[متابعة جمهور=تذكير]", "عنوان: <very short and human — reads like a note from a person, not a campaign>", "<body: two lines at most, one yes/no question>", "[/متابعة]"],
  breakup: ["[متابعة جمهور=وداع]", "عنوان: <the last note — polite, closes the loop, leaves the door open>", "<body: two or three lines; no more emails after this one>", "[/متابعة]"],
};
