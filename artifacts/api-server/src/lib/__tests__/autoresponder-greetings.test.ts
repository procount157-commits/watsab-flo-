// The business greetings that got a sales pitch in reply — each one seen on
// this number — are machines; the people who wrote back are not.

export {};
const { detectAutoresponder } = await import("../autoresponder");

let pass = 0, total = 0;
const check = (n: string, c: boolean, d = "") => { total++; if (c) pass++; console.log(`${c ? "✅" : "❌"} ${n.padEnd(64)} ${d}`); };

const machines = [
  "‏شكرا لك على تواصلك مع  Gardenya Landscape من فضلك أخبرنا كيف يمكننا خدمتك",
  "Thank you for reaching Drill and Hummer General Maintenance LLC! Please let us know how we can help you.",
  "🌿 مرحبًا بكم في *ألماس*.  يسرّنا خدمتكم، ونلتزم بتقديم حلول متكاملة في النظافة",
  "‏شكرا لك على تواصلك مع منجرة النقش . من فضلك أخبرنا كيف يمكننا خدمتك.",
  "Thank you! for contacting us, We do core cutting, Wall/Slab coring services and",
  "📢 Please subscribe to our channel to be notified once we have any offer",
  "Thank you for your message how can we help you 😊",
];
for (const m of machines) {
  const v = detectAutoresponder(m, { isFirstFromThem: true });
  check(`machine: ${m.slice(0, 44)}`, v.isAuto, String(v.confidence));
}
const people = [
  "مهتم",
  "كم السعر؟",
  "Are you looking for any flooring materials or wall panels?",
  "هلا، وش الخدمات اللي تقدمونها بالضبط؟",
  "Hi, yes we need help with corporate tax registration. What do you need from us?",
  "شكرا، بس احنا عندنا محاسب",
];
for (const m of people) {
  const v = detectAutoresponder(m, { isFirstFromThem: true });
  check(`person: ${m.slice(0, 44)}`, !v.isAuto, String(v.confidence));
}

console.log(`\n${pass}/${total} مرّ`);
process.exit(pass === total ? 0 : 1);
