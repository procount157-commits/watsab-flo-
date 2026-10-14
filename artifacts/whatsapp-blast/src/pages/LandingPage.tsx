import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, useInView, useMotionValue, useSpring, AnimatePresence } from "framer-motion";
import { Link } from "wouter";
import { useAuth } from "@/context/AuthContext";
import {
  MessageCircle, Users, BarChart3, Bot, Zap, ChevronDown,
  CheckCircle2, ArrowLeft, ArrowRight, Shield, TrendingUp, Clock, Target,
  Smartphone, Globe, Award, Play, LayoutDashboard, Languages,
} from "lucide-react";

// ── Bilingual Content ──────────────────────────────────────────────
const CONTENT = {
  ar: {
    dir: "rtl" as const,
    fontClass: "font-cairo",
    nav: {
      contact: "تواصل معنا",
      login: "دخول",
      dashboard: "لوحة التحكم",
    },
    badge: "منصة الإرسال الذكي عبر واتساب",
    headline: "أرسل آلاف الرسائل عبر واتساب باحترافية",
    sub: "وقم بإدارة حملاتك وقوائمك وعملائك من منصة واحدة.",
    subEn: "Scale Your WhatsApp Marketing Effortlessly",
    ctaStart: "ابدأ تجربتك الآن",
    ctaDemo: "شاهد كيف يعمل",
    ctaContact: "تواصل مباشرة",
    trustQuote: {
      label: "الحقيقة التي يعرفها أصحاب الأعمال الناجحون",
      text: "أغلب المبيعات لا تأتي من الزيارة الأولى، بل من المتابعة الذكية بعد الزيارة.",
      highlight: "المتابعة الذكية",
      body: "كثير من المطاعم، محلات الذهب، صالونات الحلاقة، ومراكز التجميل تنفق آلاف الدراهم على الإعلانات لجذب العملاء، ثم تخسرهم لأنها لا تمتلك وسيلة فعالة للمتابعة.",
      cta: "هنا يأتي دور Flow Hub™.",
    },
    stats: [
      { label: "موظفين أذكياء في فريقك", to: 8,   suffix: "" },
      { label: "خطوات في سلّم المتابعة", to: 7,   suffix: "" },
      { label: "رسالة اختبار قبل كل حملة كبيرة", to: 30,  suffix: "" },
      { label: "نقطة في مؤشر حماية رقمك", to: 100, suffix: "" },
    ],
    industries: {
      label: "لمن هو؟",
      title: "المتابعة عبر واتساب تصنع الفرق",
      body: "العميل الذي يفتح واتساب عشرات المرات يومياً أسهل بكثير من العميل الذي لن يفتح بريدك أبداً.",
      items: [
        { icon: "🍽️", title: "المطاعم والكافيهات", body: "كم عميلاً زارك هذا الشهر ولم يعد؟ أرسل عروضك وكوبونات الخصم لمن زارك من قبل — وأعِد استهدافهم بذكاء." },
        { icon: "💍", title: "محلات الذهب والمجوهرات", body: "عميل الذهب يشتري عندما يتذكر متجرك. أشعره بوصول تشكيلات جديدة وكن أول من يصل إليه." },
        { icon: "✂️", title: "صوالين الحلاقة", body: "العملاء يحتاجون الخدمة بشكل دوري لكنهم ينسون. أرسل تذكيراً تلقائياً وعروضاً خاصة — وحوّل الزبون لعميل دائم." },
        { icon: "💅", title: "البيوتي سنتر", body: "الحجوزات المتكررة هي عصب البيزنس. أرسل باقاتك الجديدة وأعِدي تنشيط العميلات اللواتي انقطعن." },
      ],
    },
    whyWa: {
      title: "يرسل كإنسان، لا كآلة",
      sub: "واتساب يحظر الأرقام التي تتصرف كبرنامج. Flow Hub يتصرف كموظف.",
      items: [
        { stat: "9–9", label: "نافذة إرسال بإيقاع بشري", body: "لا إرسال قبل التاسعة صباحاً ولا بعد التاسعة مساءً، والفجوة بين الرسائل تتغير مع اليوم: أبطأ عند البداية والغداء والمساء." },
        { stat: "QR",  label: "رقمك العادي، بلا API", body: "اربط رقمك الحالي بمسح QR من هاتفك — لا رقم خاص ولا واتساب API ولا رسوم على كل رسالة." },
        { stat: "10′", label: "جاهز في عشر دقائق", body: "مديرة المبيعات تجري معك مقابلة من عشرة أسئلة، وتكتب منها ملف شركتك والمعرفة التي يرد منها الفريق." },
      ],
    },
    features: {
      label: "المميزات",
      title: "كل ما تحتاجه في مكان واحد",
      items: [
        { title: "حملات واتساب الجماعية", body: "أرسل لآلاف الأرقام بتأخيرات ذكية تحمي حسابك — مع دعم الصور والفيديو والأزرار." },
        { title: "إدارة جهات الاتصال",   body: "استورد أرقامك من Excel أو مباشرة من محادثات واتساب. صنّف قوائمك." },
        { title: "شات بوت ذكي",          body: "ردود تلقائية بكلمات مفتاحية. اربط العميل بشجرة محادثة بدون خبرة تقنية." },
        { title: "تقارير وإحصائيات",     body: "تابع عدد الرسائل، معدل النجاح، وآخر نشاط الحملات في لوحة واحدة." },
        { title: "إعادة استهداف",         body: "حدّد العملاء الذين لم يتجاوبوا وأعِد إرسالهم برسالة مختلفة في وقت أفضل." },
        { title: "حماية الحساب",          body: "تأخيرات عشوائية وبصمة نص مخفية في كل رسالة لضمان عدم الحظر." },
      ],
    },
    differentiators: {
      title: "ما الذي يجعل Flow Hub™ مختلفاً؟",
      items: [
        "إدارة احترافية لحملات واتساب من لوحة تحكم عربية",
        "تنظيم العملاء والجهات والبيانات في مكان واحد",
        "استيراد العملاء من Excel أو واتساب مباشرة",
        "متابعة العملاء وإعادة استهدافهم بذكاء",
        "تقارير واضحة لقياس النتائج",
        "دعم فني ومتابعة مستمرة طوال الاشتراك",
        "منصة مصممة خصيصاً للأعمال العربية",
        "حماية تلقائية من الحظر في كل إرسال",
      ],
    },
    pricing: {
      label: "الأسعار",
      title: "اختر الباقة المناسبة لك",
      sub: "لا رسوم خفية. لا تعقيدات. ابدأ اليوم وانمِّ أعمالك.",
      note: "أنت تركز على إدارة نشاطك التجاري، ونحن نهتم بالتواصل مع عملائك.",
      plans: [
        { label: "الباقة الشهرية", price: "299", period: "درهم / شهر", features: ["واتساب خاص بك", "حملات جماعية غير محدودة", "إدارة قوائم الأرقام", "تقارير وإحصائيات", "شات بوت ذكي", "دعم فني"], cta: "اشترك الآن", highlight: false },
        { label: "الباقة السنوية", price: "800", period: "درهم / سنة", badge: "الأكثر توفيراً", features: ["جميع مميزات الشهرية", "تحديثات مستمرة مجاناً", "أولوية في الدعم", "تكلفة أقل بـ 60%", "مزايا جديدة أولاً", "إعداد وتهيئة مجاناً"], cta: "ابدأ الاشتراك", highlight: true },
        { label: "الباقة المدارة", price: "1,000", period: "درهم / شهر", features: ["رسائل غير محدودة", "نُعدّ النظام بالكامل", "ندير الحملات نيابةً عنك", "متابعة يومية للأداء", "دعم مباشر 24/7", "تحسين مستمر للنتائج"], cta: "احجز مكالمة", highlight: false },
      ],
    },
    team: {
      label: "فريق المبيعات الذكي",
      title: "فريق كامل على رقم واحد",
      sub: "ثمانية موظفين، لكل واحد اسم ودور ومهارات مكتوبة كإجراءات لا كنصائح. تعدّل شخصياتهم بكلماتك، وتشاهدهم يعملون في لوحة الفريق.",
      members: [
        { name: "هال",  role: "المبيعات",        body: "يرد على كل مهتم بلهجته خلال دقائق، ويعرف في أي مرحلة من السبع هو." },
        { name: "سام",  role: "خدمة العملاء",    body: "يجيب عن الأسئلة المتكررة من معرفة شركتك، ويحوّل ما يحتاج إنساناً إليك." },
        { name: "شمّة", role: "مديرة المبيعات",  body: "تدرّب الفريق، وتدير الاجتماع، وتجري معك مقابلة التأهيل." },
        { name: "خالد", role: "المتابعة",        body: "سلّم من سبع خطوات بزوايا مختلفة، يتوقف فور أن يرد العميل." },
        { name: "ريم",  role: "إيصالات التسليم", body: "تقرأ ما وصل وما قُرئ وما فشل، وتختبر الحملة بثلاثين رسالة قبل أن تنطلق." },
        { name: "سالم", role: "قوائم المتابعة",  body: "يرتب من يُتابَع اليوم ومن ينتظر، ويوقف من لم يفتح ثلاث رسائل." },
        { name: "فهد",  role: "حماية الرقم",     body: "مؤشر خطر من صفر إلى مئة يبطئ الإرسال أو يوقفه قبل الحظر لا بعده." },
        { name: "مارك", role: "المراقبة",        body: "ينبّهك على تيليجرام حين يهتم عميل، وحين يوافق، وحين يحتاج رقمك قراراً." },
      ],
    },
    faq: {
      title: "أسئلة شائعة",
      items: [
        { q: "هل أحتاج خبرة تقنية؟",              a: "لا على الإطلاق. المنصة مصممة لأصحاب الأعمال العاديين. الإعداد يستغرق دقائق وكل شيء واضح بالعربية." },
        { q: "هل أحتاج واتساب بزنس؟",             a: "لا، يعمل مع واتساب العادي. تربط حسابك عبر QR كود وتبدأ الإرسال فوراً." },
        { q: "هل يمكنني استيراد جهات الاتصال من Excel؟", a: "نعم، يمكنك رفع ملف Excel مباشرة أو لصق الأرقام نصاً. النظام يتعامل مع مئات الآلاف من الأرقام." },
        { q: "هل سيتم حظر حسابي؟",                a: "المنصة تستخدم تأخيرات ذكية وبصمة مخفية لتقليل خطر الحظر. مئات العملاء يستخدمونها يومياً بأمان." },
        { q: "هل توجد رسوم خفية؟",                 a: "لا. السعر المعلن هو كل ما تدفعه. لا رسوم لكل رسالة، لا عمولات، لا مفاجآت." },
        { q: "ما الذي يشمله الدعم الفني؟",          a: "جميع الباقات تشمل دعم واتساب. الباقة المدارة تشمل متابعة يومية ودعماً مباشراً 24/7." },
      ],
    },
    cta: {
      title: "العميل الذي اشترى مرة واحدة هو أسهل عميل يشتري مرة ثانية.",
      body: "الفرق بين نشاط تجاري ينمو وآخر يتراجع هو القدرة على البقاء أمام العميل باستمرار. Flow Hub™ يساعدك على بناء هذه العلاقة وتحويلها إلى مبيعات متكررة.",
      btnStart: "ابدأ الآن",
      btnDemo: "احجز عرضاً مباشراً",
    },
    footer: {
      contact: "واتساب",
      email: "البريد الإلكتروني",
      pricing: "الأسعار",
      rights: `© ${new Date().getFullYear()} FLOW HUB™. جميع الحقوق محفوظة.`,
      privacy: "سياسة الخصوصية",
      terms: "الشروط والأحكام",
    },
    modal: {
      title: "العرض التوضيحي",
      body: "تواصل معنا على واتساب وسنرسل لك فيديو تجريبي يوضح كيفية عمل المنصة.",
      cta: "طلب العرض على واتساب",
      close: "إغلاق",
    },
  },

  en: {
    dir: "ltr" as const,
    fontClass: "font-inter",
    nav: {
      contact: "Contact Us",
      login: "Sign In",
      dashboard: "Dashboard",
    },
    badge: "Smart WhatsApp Messaging Platform",
    headline: "Scale Your WhatsApp Marketing Effortlessly",
    sub: "Manage campaigns, contacts and customer engagement from one platform.",
    subEn: "",
    ctaStart: "Start Your Trial Now",
    ctaDemo: "See How It Works",
    ctaContact: "Contact Us",
    trustQuote: {
      label: "What successful business owners know",
      text: "Most sales don't come from the first visit — they come from smart follow-up.",
      highlight: "smart follow-up",
      body: "Many restaurants, gold shops, barbershops, and beauty centers spend thousands on ads to attract customers, then lose them because they have no effective follow-up channel.",
      cta: "That's where Flow Hub™ comes in.",
    },
    stats: [
      { label: "AI employees on your team",        to: 8,   suffix: "" },
      { label: "steps in the follow-up ladder",    to: 7,   suffix: "" },
      { label: "test messages before a big campaign", to: 30, suffix: "" },
      { label: "points on your number-safety score", to: 100, suffix: "" },
    ],
    industries: {
      label: "Who is it for?",
      title: "WhatsApp Follow-Up Makes the Difference",
      body: "A customer who opens WhatsApp dozens of times a day is far easier to reach than one who will never open your email.",
      items: [
        { icon: "🍽️", title: "Restaurants & Cafes",    body: "How many customers visited this month and never came back? Send offers and discount coupons to past visitors — and win them back." },
        { icon: "💍", title: "Gold & Jewelry Shops",    body: "Gold customers buy when they remember your store. Tell them about new collections and be the first one they hear from." },
        { icon: "✂️", title: "Barbershops",             body: "Clients need your service regularly but forget. Send automatic reminders and special offers — turn visitors into loyal clients." },
        { icon: "💅", title: "Beauty Centers",           body: "Repeat bookings are the lifeblood of your business. Send new packages and reactivate clients who've been away." },
      ],
    },
    whyWa: {
      title: "It sends like a person, not a machine",
      sub: "WhatsApp bans numbers that behave like software. Flow Hub behaves like an employee.",
      items: [
        { stat: "9–9", label: "A human sending rhythm", body: "Nothing before 9 am or after 9 pm, and the gap between messages changes through the day — slower at the start, at lunch and in the evening." },
        { stat: "QR",  label: "Your own number, no API", body: "Link your existing number by scanning a QR code — no special number, no WhatsApp API, no fee per message." },
        { stat: "10′", label: "Ready in ten minutes", body: "The sales manager interviews you with ten questions and writes your company file and the knowledge the team answers from." },
      ],
    },
    features: {
      label: "Features",
      title: "Everything You Need in One Place",
      items: [
        { title: "Bulk WhatsApp Campaigns",  body: "Send to thousands with smart delays that protect your account — images, videos, and buttons supported." },
        { title: "Contact Management",       body: "Import contacts from Excel or directly from WhatsApp conversations. Organize your lists." },
        { title: "Smart Chatbot",            body: "Automatic keyword replies. Build a full conversation tree with no technical knowledge needed." },
        { title: "Reports & Analytics",      body: "Track messages sent, success rates, and campaign activity — all in one dashboard." },
        { title: "Retargeting",              body: "Identify non-responsive contacts and re-send a different message at a better time." },
        { title: "Account Protection",       body: "Random delays and a hidden text fingerprint in every message to help prevent bans." },
      ],
    },
    differentiators: {
      title: "What Makes Flow Hub™ Different?",
      items: [
        "Professional WhatsApp campaign management from an Arabic-language dashboard",
        "Organize customers, contacts, and data in one place",
        "Import contacts from Excel or directly from WhatsApp",
        "Follow up and retarget customers intelligently",
        "Clear reports to measure what works",
        "Ongoing technical support for as long as you subscribe",
        "Built specifically for businesses in the Arab world",
        "Automatic ban protection on every send",
      ],
    },
    pricing: {
      label: "Pricing",
      title: "Choose the Right Plan for You",
      sub: "No hidden fees. No complexity. Start today and grow your business.",
      note: "You focus on running your business — we handle customer communication.",
      plans: [
        { label: "Monthly Plan", price: "299", period: "AED / month", features: ["Your own WhatsApp", "Unlimited bulk campaigns", "Contact list management", "Reports & analytics", "Smart chatbot", "Technical support"], cta: "Subscribe Now", highlight: false },
        { label: "Annual Plan",  price: "800", period: "AED / year",  badge: "Best Value", features: ["All monthly features", "Free continuous updates", "Priority support", "60% lower cost", "Early new features", "Free setup"], cta: "Start Subscription", highlight: true },
        { label: "Managed Plan", price: "1,000", period: "AED / month", features: ["Unlimited messages", "We set up the system", "We manage campaigns for you", "Daily performance follow-up", "24/7 direct support", "Continuous optimization"], cta: "Book a Call", highlight: false },
      ],
    },
    team: {
      label: "The AI sales team",
      title: "A whole team on one number",
      sub: "Eight employees, each with a name, a role and skills written as procedures, not advice. Change their personalities in your own words and watch them work on the team board.",
      members: [
        { name: "Hal",    role: "Sales",             body: "Answers every interested customer in their own dialect within minutes, and knows which of the seven stages they are in." },
        { name: "Sam",    role: "Customer service",  body: "Answers the repeated questions from your company's knowledge, and hands you what needs a person." },
        { name: "Shamma", role: "Sales manager",     body: "Trains the team, runs the meeting, and interviews you to set the company up." },
        { name: "Khalid", role: "Follow-up",         body: "A seven-step ladder, each step from a new angle, stopping the moment the customer replies." },
        { name: "Reem",   role: "Delivery receipts", body: "Reads what arrived, what was read and what failed, and tests a campaign on thirty messages before releasing it." },
        { name: "Salem",  role: "Follow-up lists",   body: "Orders who is followed up today and who waits, and stops anyone who opened none of three messages." },
        { name: "Fahad",  role: "Number protection", body: "A 0–100 risk score that slows or pauses sending before a ban, not after." },
        { name: "Mark",   role: "Monitoring",        body: "Alerts you on Telegram when a customer is interested, when they agree, and when your number needs a decision." },
      ],
    },
    faq: {
      title: "Frequently Asked Questions",
      items: [
        { q: "Do I need technical experience?",          a: "Not at all. The platform is built for everyday business owners. Setup takes minutes and every step is explained." },
        { q: "Do I need WhatsApp Business?",             a: "No, it works with regular WhatsApp. Connect your account via QR code and start sending immediately." },
        { q: "Can I import contacts from Excel?",        a: "Yes, upload an Excel file directly or paste numbers as text. The system handles hundreds of thousands of contacts." },
        { q: "Will my account get banned?",              a: "The platform uses smart delays and hidden fingerprints to minimize ban risk. Hundreds of clients use it daily safely." },
        { q: "Are there hidden fees?",                   a: "No. The advertised price is all you pay. No per-message fees, no commissions, no surprises." },
        { q: "What does technical support include?",     a: "All plans include WhatsApp support. The Managed plan includes daily follow-up and 24/7 direct support." },
      ],
    },
    cta: {
      title: "A customer who has bought once is the easiest one to sell to again.",
      body: "The difference between a business that grows and one that declines is the ability to stay in front of the customer consistently. Flow Hub™ helps you build that relationship and turn it into repeat sales.",
      btnStart: "Get Started",
      btnDemo: "Book a Live Demo",
    },
    footer: {
      contact: "WhatsApp",
      email: "Email",
      pricing: "Pricing",
      rights: `© ${new Date().getFullYear()} FLOW HUB™. All rights reserved.`,
      privacy: "Privacy Policy",
      terms: "Terms & Conditions",
    },
    modal: {
      title: "Live Demo",
      body: "Contact us on WhatsApp and we'll send you a demo video showing how the platform works.",
      cta: "Request Demo on WhatsApp",
      close: "Close",
    },
  },
};

// ── Animated Counter ──────────────────────────────────────────────
function AnimatedCounter({ from = 0, to, suffix = "", duration = 2 }: {
  from?: number; to: number; suffix?: string; duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-50px" });
  const motionVal = useMotionValue(from);
  const spring = useSpring(motionVal, { duration: duration * 1000, bounce: 0 });
  const [display, setDisplay] = useState(from);

  useEffect(() => {
    if (inView) motionVal.set(to);
  }, [inView, to, motionVal]);

  useEffect(() => spring.on("change", (v) => setDisplay(Math.round(v))), [spring]);

  return <span ref={ref}>{display.toLocaleString("en")}{suffix}</span>;
}

// ── Floating Particle ─────────────────────────────────────────────
const PARTICLES = Array.from({ length: 18 }, (_, i) => ({
  delay: i * 0.4,
  x: `${5 + (i * 5.3) % 90}%`,
  y: `${10 + (i * 7.1) % 80}%`,
  size: 4 + (i % 5) * 3,
}));

function Particle({ delay, x, y, size }: { delay: number; x: string; y: string; size: number }) {
  return (
    <motion.div
      className="absolute rounded-full bg-green-400/20 pointer-events-none"
      style={{ left: x, top: y, width: size, height: size }}
      animate={{ y: [0, -30, 0], opacity: [0.2, 0.6, 0.2], scale: [1, 1.3, 1] }}
      transition={{ duration: 4 + Math.random() * 3, delay, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}

// ── Section wrapper ───────────────────────────────────────────────
function Section({ children, className = "", id }: {
  children: React.ReactNode; className?: string; id?: string;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });
  return (
    <motion.section ref={ref} id={id}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.7, ease: "easeOut" }}
      className={className}
    >
      {children}
    </motion.section>
  );
}

// ── FAQ Item ──────────────────────────────────────────────────────
function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-white/10 last:border-0">
      <button onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-start gap-4 group">
        <span className="font-semibold text-white group-hover:text-green-400 transition-colors">{q}</span>
        <ChevronDown className={`w-5 h-5 text-green-400 flex-shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} className="overflow-hidden">
            <p className="pb-5 text-white/60 text-sm leading-relaxed">{a}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Dynamic Plan type (from API) ──────────────────────────────────
interface DynamicPlan {
  id: number;
  name: string;
  name_en: string | null;
  price: string;
  period: string;
  period_label: string | null;
  features: string[];
  features_en: string[] | null;
  badge: string | null;
  badge_en: string | null;
  is_featured: boolean;
}

// ── Subscribe Modal ────────────────────────────────────────────────
function SubscribeModal({ planName, salesWaNum, onClose, lang }: {
  planName: string; salesWaNum: string; onClose: () => void; lang: "ar" | "en";
}) {
  const [name,     setName]     = useState("");
  const [phone,    setPhone]    = useState("");
  const [biz,      setBiz]      = useState("");
  const [size,     setSize]     = useState("");
  const [loading,  setLoading]  = useState(false);
  const [sent,     setSent]     = useState(false);

  const isAr = lang === "ar";
  const bizOptions = isAr
    ? ["تجارة إلكترونية", "مطعم / كافيه", "عيادة / صحة", "عقارات", "تعليم", "خدمات", "أخرى"]
    : ["E-commerce", "Restaurant / Café", "Clinic / Health", "Real Estate", "Education", "Services", "Other"];
  const sizeOptions = isAr
    ? ["أقل من 500", "500 - 2,000", "2,000 - 10,000", "أكثر من 10,000"]
    : ["Less than 500", "500 - 2,000", "2,000 - 10,000", "More than 10,000"];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone) return;
    setLoading(true);
    try {
      await fetch("/api/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, phone, planName, businessType: biz, estimatedCustomers: size }),
      });
    } catch {}
    setSent(true);
    setLoading(false);
    const msg = isAr
      ? `مرحباً، أريد الاشتراك في *${planName}*\n\nالاسم: ${name}\nالجوال: ${phone}\nنوع النشاط: ${biz}`
      : `Hello, I want to subscribe to *${planName}*\n\nName: ${name}\nPhone: ${phone}\nBusiness: ${biz}`;
    setTimeout(() => {
      window.open(`https://wa.me/${salesWaNum}?text=${encodeURIComponent(msg)}`, "_blank");
      onClose();
    }, 1_200);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" dir={isAr ? "rtl" : "ltr"}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
        className="relative bg-[#0c1a10] border border-green-500/30 rounded-2xl p-6 w-full max-w-md shadow-2xl shadow-green-900/40 z-10">
        <button onClick={onClose} className="absolute top-4 end-4 text-white/40 hover:text-white text-xl leading-none">✕</button>
        {sent ? (
          <div className="text-center py-6">
            <div className="w-14 h-14 bg-green-500/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 className="w-7 h-7 text-green-400" />
            </div>
            <p className="text-white font-bold text-lg mb-1">{isAr ? "شكراً لك!" : "Thank you!"}</p>
            <p className="text-white/50 text-sm">{isAr ? "جاري فتح واتساب للتواصل..." : "Opening WhatsApp..."}</p>
          </div>
        ) : (
          <>
            <p className="text-green-400 text-xs font-semibold uppercase tracking-widest mb-1">{isAr ? "طلب اشتراك" : "Subscribe"}</p>
            <h3 className="text-white font-black text-xl mb-5">{planName}</h3>
            <form onSubmit={submit} className="space-y-3">
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder={isAr ? "الاسم" : "Your name"}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-green-500/50" />
              <input required value={phone} onChange={(e) => setPhone(e.target.value)}
                placeholder={isAr ? "رقم الجوال *" : "Phone number *"} dir="ltr"
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-green-500/50" />
              <select value={biz} onChange={(e) => setBiz(e.target.value)}
                className="w-full bg-[#0c1a10] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 focus:outline-none focus:border-green-500/50">
                <option value="">{isAr ? "نوع النشاط التجاري" : "Business type"}</option>
                {bizOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <select value={size} onChange={(e) => setSize(e.target.value)}
                className="w-full bg-[#0c1a10] border border-white/10 rounded-xl px-4 py-3 text-sm text-white/70 focus:outline-none focus:border-green-500/50">
                <option value="">{isAr ? "عدد العملاء المتوقع" : "Estimated customers"}</option>
                {sizeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <button type="submit" disabled={loading || !phone}
                className="w-full py-3.5 bg-green-500 hover:bg-green-400 disabled:opacity-50 text-black font-bold rounded-xl text-sm transition-all flex items-center justify-center gap-2">
                {loading ? <div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" /> : null}
                {isAr ? "أرسل الطلب عبر واتساب ←" : "Send Request via WhatsApp →"}
              </button>
            </form>
          </>
        )}
      </motion.div>
    </div>
  );
}

// ── Price Card ────────────────────────────────────────────────────
function PriceCard({ label, price, period, badge, features, cta, highlight, delay, onSubscribe }: {
  label: string; price: string; period: string; badge?: string;
  features: string[]; cta: string; highlight?: boolean; delay: number;
  onSubscribe: (planLabel: string) => void;
}) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  return (
    <motion.div ref={ref}
      initial={{ opacity: 0, y: 50 }} animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay, duration: 0.6 }}
      className={`relative rounded-2xl p-8 flex flex-col ${highlight
        ? "bg-gradient-to-b from-green-600/30 to-green-900/20 border-2 border-green-400/50 shadow-2xl shadow-green-500/20"
        : "bg-white/5 border border-white/10"}`}
    >
      {badge && (
        <div className="absolute -top-4 start-6 bg-green-500 text-black text-xs font-bold px-4 py-1.5 rounded-full">
          {badge}
        </div>
      )}
      <p className="text-sm text-white/60 mb-2">{label}</p>
      <div className="mb-1">
        <span className="text-4xl font-black text-white">{price}</span>
        <span className="text-white/40 text-sm ms-2">{period}</span>
      </div>
      <div className="h-px bg-white/10 my-6" />
      <ul className="space-y-3 flex-1 mb-8">
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5 text-sm text-white/70">
            <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
            {f}
          </li>
        ))}
      </ul>
      <button onClick={() => onSubscribe(label)}
        className={`w-full py-3.5 rounded-xl font-bold text-center text-sm transition-all cursor-pointer ${highlight
          ? "bg-green-500 hover:bg-green-400 text-black shadow-lg shadow-green-500/30"
          : "bg-white/10 hover:bg-white/20 text-white border border-white/20"}`}>
        {cta}
      </button>
    </motion.div>
  );
}

// ── Language ──────────────────────────────────────────────────────
// English is the default for every visitor. The old key ("flowhub-lang") was
// written on every render, so everyone who ever visited has "ar" stored and it
// says nothing about what they chose; this key is written only when the
// visitor presses the language button, and index.html reads it too so the
// document's lang/dir are right before React starts.
type Lang = "ar" | "en";
const LANG_KEY = "flowhub-landing-lang";

function readLang(): Lang {
  try { return localStorage.getItem(LANG_KEY) === "ar" ? "ar" : "en"; } catch { return "en"; }
}

const DOC_META: Record<Lang, { title: string; description: string }> = {
  en: {
    title: "FLOW HUB™ — WhatsApp Marketing Platform",
    description: "FLOW HUB™ — a professional platform for bulk WhatsApp messaging and campaign and contact management, with an AI sales team that replies and follows up. Made for restaurants, gold and jewelry shops, barbershops and beauty centers.",
  },
  ar: {
    title: "FLOW HUB™ — منصة الإرسال عبر واتساب",
    description: "FLOW HUB™ — منصة احترافية لإرسال رسائل واتساب الجماعية وإدارة الحملات والعملاء. الأفضل للمطاعم، محلات الذهب، صوالين الحلاقة، والبيوتي سنتر.",
  },
};

// Plans come from the admin panel, where the period label is typed in Arabic
// only ("درهم / شهر"). In English it is rebuilt from the period itself.
const YEAR_RE  = /year|annual|سن|عام/;
const MONTH_RE = /month|شهر/;
function periodEn(plan: DynamicPlan): string {
  const label = plan.period_label || "";
  if (label && !/[\u0600-\u06FF]/.test(label)) return label;
  const text = `${plan.period} ${label}`.toLowerCase();
  const currency = /ريال|sar/.test(text) ? "SAR" : "AED";
  if (YEAR_RE.test(text))  return `${currency} / year`;
  if (MONTH_RE.test(text)) return `${currency} / month`;
  if (/week|أسبوع|اسبوع/.test(text)) return `${currency} / week`;
  return currency;
}
function planNameEn(plan: DynamicPlan): string {
  if (plan.name_en?.trim()) return plan.name_en;
  const text = `${plan.period} ${plan.period_label || ""}`.toLowerCase();
  if (YEAR_RE.test(text))  return "Annual Plan";
  if (MONTH_RE.test(text)) return "Monthly Plan";
  return "Plan";
}

// ── MAIN PAGE ─────────────────────────────────────────────────────
export default function LandingPage() {
  const { user } = useAuth();
  const [lang, setLang] = useState<Lang>(readLang);
  const [videoOpen,   setVideoOpen]   = useState(false);
  const [waNum,       setWaNum]       = useState("971588951186");
  const [salesWaNum,  setSalesWaNum]  = useState("971588951186");
  const [plans,       setPlans]       = useState<DynamicPlan[]>([]);
  const [subscribeModal, setSubscribeModal] = useState<{ open: boolean; planName: string }>({ open: false, planName: "" });

  const c = CONTENT[lang];

  // The document follows the page's language while the landing is shown. The
  // rest of the app is Arabic; App.tsx puts lang/dir/title back on any other
  // route.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.lang = lang;
    html.dir = c.dir;
    document.title = DOC_META[lang].title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", DOC_META[lang].description);
  }, [lang, c.dir]);

  // Load settings + dynamic plans
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (d.whatsappNumber) setWaNum(d.whatsappNumber);
        if (d.salesWhatsapp)  setSalesWaNum(d.salesWhatsapp);
        else if (d.whatsappNumber) setSalesWaNum(d.whatsappNumber);
      })
      .catch(() => {});
    fetch("/api/plans")
      .then((r) => r.json())
      .then((data: DynamicPlan[]) => { if (Array.isArray(data) && data.length) setPlans(data); })
      .catch(() => {});
  }, []);

  const openSubscribe = (planName: string) => setSubscribeModal({ open: true, planName });
  const closeSubscribe = () => setSubscribeModal({ open: false, planName: "" });

  // Only an explicit choice is remembered.
  const toggleLang = () => {
    const next: Lang = lang === "ar" ? "en" : "ar";
    setLang(next);
    try { localStorage.setItem(LANG_KEY, next); } catch {}
  };

  const waLink = (text: string) => `https://wa.me/${waNum}?text=${encodeURIComponent(text)}`;
  const ArrowFwd = lang === "ar" ? ArrowLeft : ArrowRight;

  return (
    <div
      className={`min-h-screen bg-[#050f0a] text-white overflow-x-hidden ${c.fontClass}`}
      dir={c.dir}
      style={{ fontFamily: lang === "ar" ? "'Cairo', sans-serif" : "'Inter', sans-serif" }}
    >
      {/* ── NAV ──────────────────────────────────────────────────── */}
      <nav className="fixed top-0 inset-x-0 z-50 backdrop-blur-xl bg-black/40 border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center">
              <MessageCircle className="w-4 h-4 text-black fill-black" />
            </div>
            <span className="font-black text-lg tracking-tight">FLOW HUB™</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Language Toggle */}
            <button onClick={toggleLang} aria-label={lang === "ar" ? "التبديل إلى الإنجليزية" : "Switch to Arabic"}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white/60 hover:text-white border border-white/15 hover:border-white/30 rounded-lg transition-all">
              <Languages className="w-3.5 h-3.5" />
              {lang === "ar"
                ? <span lang="en">English</span>
                : <span lang="ar" style={{ fontFamily: "'Cairo', sans-serif" }}>العربية</span>}
            </button>
            <a href={`https://wa.me/${waNum}`} target="_blank" rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-2 text-sm text-white/70 hover:text-white transition-colors">
              <MessageCircle className="w-4 h-4 text-green-400" />
              {c.nav.contact}
            </a>
            {user ? (
              <Link href="/dashboard"
                className="flex items-center gap-1.5 px-4 py-2 bg-green-500 hover:bg-green-400 text-black font-bold text-sm rounded-lg transition-colors">
                <LayoutDashboard className="w-3.5 h-3.5" />
                {c.nav.dashboard}
              </Link>
            ) : (
              <Link href="/login"
                className="px-4 py-2 bg-green-500 hover:bg-green-400 text-black font-bold text-sm rounded-lg transition-colors">
                {c.nav.login}
              </Link>
            )}
          </div>
        </div>
      </nav>

      {/* ── HERO ─────────────────────────────────────────────────── */}
      <div className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
        <motion.div className="absolute inset-0 pointer-events-none"
          animate={{ background: [
            "radial-gradient(ellipse 80% 60% at 50% 40%, rgba(34,197,94,0.15) 0%, transparent 70%)",
            "radial-gradient(ellipse 80% 60% at 55% 35%, rgba(16,185,129,0.18) 0%, transparent 70%)",
            "radial-gradient(ellipse 80% 60% at 45% 45%, rgba(34,197,94,0.12) 0%, transparent 70%)",
          ]}}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
        />
        <div className="absolute inset-0 pointer-events-none">
          {PARTICLES.map((p, i) => <Particle key={i} {...p} />)}
        </div>
        <div className="absolute inset-0 pointer-events-none opacity-[0.04]"
          style={{ backgroundImage: "linear-gradient(#22c55e 1px, transparent 1px), linear-gradient(90deg, #22c55e 1px, transparent 1px)", backgroundSize: "60px 60px" }}
        />
        <div className="relative z-10 max-w-4xl mx-auto px-4 sm:px-6 text-center">
          <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}
            className="inline-flex items-center gap-2 bg-green-500/10 border border-green-500/25 rounded-full px-5 py-2 text-sm text-green-400 font-medium mb-8">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            {c.badge}
          </motion.div>

          <motion.h1 initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1 }}
            className="text-4xl sm:text-5xl md:text-6xl font-black leading-tight mb-4">
            <span className="text-transparent bg-clip-text bg-gradient-to-l from-green-400 to-emerald-300">
              {c.headline}
            </span>
          </motion.h1>

          <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="text-xl text-white/50 mb-3 font-medium">{c.sub}</motion.p>

          {c.subEn ? (
            <motion.p initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.25 }}
              className="text-base text-white/30 mb-10" dir="ltr" lang="en">
              {c.subEn}
            </motion.p>
          ) : <div className="mb-7" />}

          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.35 }}
            className="flex flex-wrap items-center justify-center gap-4">
            <a href={waLink(lang === "ar" ? "أريد الاشتراك في Flow Hub" : "Hi, I'd like to subscribe to Flow Hub")}
              target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-2.5 px-6 sm:px-7 py-4 bg-green-500 hover:bg-green-400 text-black font-black rounded-xl text-base transition-all shadow-2xl shadow-green-500/30 hover:shadow-green-400/40 hover:scale-105">
              <MessageCircle className="w-5 h-5 fill-black" />
              {c.ctaStart}
            </a>
            <button onClick={() => setVideoOpen(true)}
              className="flex items-center gap-2.5 px-6 sm:px-7 py-4 bg-white/8 hover:bg-white/14 border border-white/15 text-white font-bold rounded-xl text-base transition-all">
              <Play className="w-5 h-5 text-green-400 fill-green-400" />
              {c.ctaDemo}
            </button>
          </motion.div>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5 }}
            className="absolute bottom-10 left-1/2 -translate-x-1/2">
            <motion.div animate={{ y: [0, 8, 0] }} transition={{ duration: 1.8, repeat: Infinity }}>
              <ChevronDown className="w-6 h-6 text-white/25" />
            </motion.div>
          </motion.div>
        </div>
      </div>

      {/* ── TRUST QUOTE ──────────────────────────────────────────── */}
      <Section className="py-20 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 text-sm text-green-400 font-medium mb-6">
            <TrendingUp className="w-4 h-4" />
            {c.trustQuote.label}
          </div>
          <blockquote className="text-2xl sm:text-3xl font-bold text-white leading-relaxed mb-6">
            "{c.trustQuote.text.split(c.trustQuote.highlight).map((part, i, arr) => (
              i < arr.length - 1
                ? <span key={i}>{part}<span className="text-green-400">{c.trustQuote.highlight}</span></span>
                : <span key={i}>{part}</span>
            ))}"
          </blockquote>
          <p className="text-white/50 text-base leading-relaxed max-w-2xl mx-auto">
            {c.trustQuote.body}
            <br /><br />
            <strong className="text-white">{c.trustQuote.cta}</strong>
          </p>
        </div>
      </Section>

      {/* ── STATS ────────────────────────────────────────────────── */}
      <Section className="py-16 px-4 sm:px-6 border-y border-white/5">
        <div className="max-w-5xl mx-auto grid grid-cols-2 sm:grid-cols-4 gap-8 text-center">
          {c.stats.map((s, i) => (
            <div key={i}>
              <div className="text-3xl sm:text-4xl font-black text-green-400 tabular-nums">
                <AnimatedCounter to={s.to} suffix={s.suffix} />
              </div>
              <p className="text-white/50 text-sm mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── INDUSTRIES ───────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-green-400 text-sm font-semibold uppercase tracking-widest mb-3">{c.industries.label}</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white">{c.industries.title}</h2>
            <p className="text-white/50 mt-4 max-w-xl mx-auto">{c.industries.body}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {c.industries.items.map((item, i) => (
              <motion.div key={i}
                initial={{ opacity: 0, y: 40 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.1, duration: 0.5 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-green-500/40 hover:bg-white/8 transition-all duration-300">
                <div className="text-3xl mb-4">{item.icon}</div>
                <h3 className="font-bold text-white text-lg mb-3">{item.title}</h3>
                <p className="text-white/60 text-sm leading-relaxed">{item.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── WHY WHATSAPP ─────────────────────────────────────────── */}
      <Section className="py-20 px-4 sm:px-6 bg-gradient-to-b from-green-900/10 to-transparent">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">{c.whyWa.title}</h2>
            <p className="text-white/50 max-w-lg mx-auto">{c.whyWa.sub}</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-6">
            {c.whyWa.items.map((item, i) => (
              <motion.div key={i}
                initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.1, duration: 0.5 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-7 text-center hover:border-green-500/30 transition-all">
                <div className="text-4xl font-black text-green-400 mb-1">{item.stat}</div>
                <div className="font-bold text-white mb-2">{item.label}</div>
                <p className="text-white/50 text-sm">{item.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── FEATURES ─────────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-green-400 text-sm font-semibold uppercase tracking-widest mb-3">{c.features.label}</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white">{c.features.title}</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {c.features.items.map((item, i) => (
              <motion.div key={i}
                initial={{ opacity: 0, scale: 0.95 }} whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true, margin: "-60px" }} transition={{ delay: i * 0.05, duration: 0.5 }}
                className="bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-green-500/30 transition-all">
                <div className="w-12 h-12 rounded-xl bg-green-500/15 flex items-center justify-center mb-4">
                  <Zap className="w-6 h-6 text-green-400" />
                </div>
                <h3 className="font-bold text-white mb-2">{item.title}</h3>
                <p className="text-white/55 text-sm leading-relaxed">{item.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── DIFFERENTIATORS ──────────────────────────────────────── */}
      <Section className="py-20 px-4 sm:px-6">
        <div className="max-w-4xl mx-auto">
          <div className="bg-gradient-to-br from-green-900/30 to-emerald-900/20 border border-green-500/20 rounded-3xl p-8 sm:p-12">
            <div className="flex items-center gap-3 mb-8">
              <Award className="w-7 h-7 text-green-400" />
              <h2 className="text-2xl font-black text-white">{c.differentiators.title}</h2>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              {c.differentiators.items.map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
                  <span className="text-white/80 text-sm">{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ── AI SALES TEAM ─────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6 bg-gradient-to-b from-transparent via-green-900/10 to-transparent" id="team">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-14 max-w-2xl mx-auto">
            <p className="text-green-400 text-sm font-semibold uppercase tracking-widest mb-3">{c.team.label}</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white">{c.team.title}</h2>
            <p className="text-white/55 mt-4 leading-relaxed">{c.team.sub}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {c.team.members.map((m, i) => (
              <motion.div key={i}
                initial={{ opacity: 0, y: 30 }} whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }} transition={{ delay: (i % 4) * 0.08, duration: 0.5 }}
                whileHover={{ y: -4 }}
                className="relative bg-white/5 border border-white/10 rounded-2xl p-6 hover:border-green-500/40 transition-colors">
                <div className="flex items-center gap-3 mb-4">
                  <div className="relative w-12 h-12 rounded-2xl bg-green-500/15 text-green-400 flex items-center justify-center text-xl font-black">
                    {m.name.slice(0, 1)}
                    <span className="absolute -bottom-0.5 -end-0.5 w-3 h-3 rounded-full bg-green-400 ring-2 ring-[#0c1a10] animate-pulse" aria-hidden />
                  </div>
                  <div>
                    <p className="font-black text-white text-lg leading-tight">{m.name}</p>
                    <p className="text-green-400 text-xs font-semibold">{m.role}</p>
                  </div>
                </div>
                <p className="text-white/60 text-sm leading-relaxed">{m.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── PRICING ──────────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6" id="pricing">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <p className="text-green-400 text-sm font-semibold uppercase tracking-widest mb-3">{c.pricing.label}</p>
            <h2 className="text-3xl sm:text-4xl font-black text-white mb-4">{c.pricing.title}</h2>
            <p className="text-white/50 max-w-md mx-auto text-sm">{c.pricing.sub}</p>
          </div>
          <div className="grid sm:grid-cols-3 gap-6">
            {plans.length > 0
              ? plans.map((plan, i) => (
                  <PriceCard key={plan.id}
                    label={lang === "ar" ? plan.name : planNameEn(plan)}
                    price={Number(plan.price).toLocaleString(lang === "ar" ? "ar-SA" : "en-US")}
                    period={lang === "ar" ? (plan.period_label || plan.period) : periodEn(plan)}
                    badge={lang === "ar" ? (plan.badge || undefined) : (plan.badge_en || undefined)}
                    features={lang === "ar" ? plan.features
                      : (plan.features_en ?? []).filter((f) => f.trim() && !/[\u0600-\u06FF]/.test(f))}
                    cta={lang === "ar" ? "اشترك الآن" : "Subscribe Now"}
                    highlight={plan.is_featured}
                    delay={i * 0.1}
                    onSubscribe={openSubscribe}
                  />
                ))
              : c.pricing.plans.map((plan, i) => (
                  <PriceCard key={i} {...plan} delay={i * 0.1} onSubscribe={openSubscribe} />
                ))
            }
          </div>
          <p className="text-center text-white/30 text-sm mt-10">{c.pricing.note}</p>
        </div>
      </Section>

      {/* ── FAQ ──────────────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-14">
            <h2 className="text-3xl font-black text-white">{c.faq.title}</h2>
          </div>
          <div className="bg-white/3 border border-white/8 rounded-2xl p-6 sm:p-8">
            {c.faq.items.map((item, i) => <FaqItem key={i} q={item.q} a={item.a} />)}
          </div>
        </div>
      </Section>

      {/* ── CTA BOTTOM ───────────────────────────────────────────── */}
      <Section className="py-24 px-4 sm:px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="relative bg-gradient-to-br from-green-600/25 to-emerald-900/20 border border-green-500/25 rounded-3xl p-8 sm:p-14 overflow-hidden">
            <motion.div className="absolute inset-0 pointer-events-none"
              animate={{ opacity: [0.3, 0.6, 0.3] }} transition={{ duration: 4, repeat: Infinity }}
              style={{ background: "radial-gradient(ellipse 60% 50% at 50% 100%, rgba(34,197,94,0.2), transparent)" }}
            />
            <div className="relative z-10">
              <h2 className="text-2xl sm:text-3xl font-black text-white mb-4">{c.cta.title}</h2>
              <p className="text-white/55 mb-8 leading-relaxed">{c.cta.body}</p>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <a href={waLink(lang === "ar" ? "أريد الاشتراك في Flow Hub" : "Hi, I'd like to subscribe to Flow Hub")}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-7 py-4 bg-green-500 hover:bg-green-400 text-black font-black rounded-xl text-base transition-all shadow-2xl shadow-green-500/30 hover:scale-105">
                  <MessageCircle className="w-5 h-5 fill-black" />
                  {c.cta.btnStart}
                </a>
                <a href={waLink(lang === "ar" ? "أريد حجز عرض مباشر" : "Hi, I'd like to book a live demo of Flow Hub")}
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-2.5 px-7 py-4 bg-white/10 hover:bg-white/18 border border-white/20 text-white font-bold rounded-xl text-base transition-all">
                  <ArrowFwd className="w-5 h-5" />
                  {c.cta.btnDemo}
                </a>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── FOOTER ───────────────────────────────────────────────── */}
      <footer className="border-t border-white/8 py-12 px-4 sm:px-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 mb-8">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center">
                <MessageCircle className="w-4 h-4 text-black fill-black" />
              </div>
              <span className="font-black text-lg">FLOW HUB™</span>
            </div>
            <div className="flex items-center gap-5">
              <a href={`https://wa.me/${waNum}`} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-sm text-white/50 hover:text-green-400 transition-colors">
                <MessageCircle className="w-4 h-4" />
                {c.footer.contact}
              </a>
              <a href="mailto:info@flowhub.app" className="text-sm text-white/50 hover:text-white transition-colors">
                {c.footer.email}
              </a>
              <a href="#pricing" className="text-sm text-white/50 hover:text-white transition-colors">
                {c.footer.pricing}
              </a>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-white/25">
            <p>{c.footer.rights}</p>
            <div className="flex gap-4">
              <a href="#" className="hover:text-white/50 transition-colors">{c.footer.privacy}</a>
              <a href="#" className="hover:text-white/50 transition-colors">{c.footer.terms}</a>
            </div>
          </div>
        </div>
      </footer>

      {/* ── VIDEO MODAL ──────────────────────────────────────────── */}
      <AnimatePresence>
        {videoOpen && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setVideoOpen(false)}
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-6">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }} onClick={(e) => e.stopPropagation()}
              className="bg-white/5 border border-white/15 rounded-2xl p-8 text-center max-w-md w-full">
              <Smartphone className="w-12 h-12 text-green-400 mx-auto mb-4" />
              <h3 className="text-xl font-bold text-white mb-2">{c.modal.title}</h3>
              <p className="text-white/50 text-sm mb-6">{c.modal.body}</p>
              <a href={waLink(lang === "ar" ? "أريد مشاهدة العرض التوضيحي" : "Hi, I'd like to see the Flow Hub demo")}
                target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 px-6 py-3 bg-green-500 hover:bg-green-400 text-black font-bold rounded-xl text-sm transition-colors">
                <MessageCircle className="w-4 h-4 fill-black" />
                {c.modal.cta}
              </a>
              <button onClick={() => setVideoOpen(false)} className="mt-3 text-sm text-white/40 hover:text-white/70 transition-colors">
                {c.modal.close}
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SUBSCRIBE MODAL ──────────────────────────────────────── */}
      <AnimatePresence>
        {subscribeModal.open && (
          <SubscribeModal
            planName={subscribeModal.planName}
            salesWaNum={salesWaNum}
            onClose={closeSubscribe}
            lang={lang}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
