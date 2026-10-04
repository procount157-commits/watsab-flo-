import { pgTable, serial, integer, varchar, text, boolean, timestamp, jsonb, index, primaryKey } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ── Bot employees ─────────────────────────────────────────────────
// The bots, given names and roles. A table rather than constants because the
// owner thinks of them as staff — "the first is Hal, the second is Mark" —
// and expects to hire more, rename them, and take one off duty without that
// meaning a code change.
//
// `role` binds a row to the engine behind it; `kind` distinguishes a
// customer-facing employee from an internal one, which is what decides
// whether switching it on sends anything to anybody.
export const botEmployeesTable = pgTable("bot_employees", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:      varchar("name", { length: 80 }).notNull(),
  role:      varchar("role", { length: 30 }).notNull(),   // sales | monitor
  kind:      varchar("kind", { length: 20 }).notNull().default("customer"), // customer | internal
  title:     varchar("title", { length: 120 }),
  avatar:    varchar("avatar", { length: 16 }),
  isActive:  boolean("is_active").notNull().default(true),
  // How this one talks and what they are like. Free text, in the owner's
  // words — it is pasted into the agent's instructions verbatim.
  persona:     text("persona"),
  // Topics that route to them. Empty means "anything not claimed by someone
  // more specific", which is what makes a generalist a sensible default.
  specialties: jsonb("specialties").notNull().default([]),
  // Where they pass a conversation they should not be holding.
  handoffTo:   varchar("handoff_to", { length: 30 }),
  // Lower wins when two agents both match.
  priority:    integer("priority").notNull().default(100),
  notes:     text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_bot_employees_user").on(t.userId)]);

export type BotEmployee = typeof botEmployeesTable.$inferSelect;

// Who is on a conversation now, so a thread does not change hands every message.
export const conversationOwnerTable = pgTable("conversation_owner", {
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:  varchar("phone", { length: 50 }).notNull(),
  role:   varchar("role", { length: 30 }).notNull(),
  since:  timestamp("since", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.phone] })]);

export const agentHandoffsTable = pgTable("agent_handoffs", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  phone:     varchar("phone", { length: 50 }).notNull(),
  fromRole:  varchar("from_role", { length: 30 }),
  toRole:    varchar("to_role", { length: 30 }).notNull(),
  reason:    text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Hired for an account the first time it links WhatsApp. */
export const DEFAULT_EMPLOYEES = [
  {
    name: "هال", role: "sales", kind: "customer", title: "موظف المبيعات", avatar: "🤝",
    persona: "مندوب مبيعات محترف في الإمارات، متخصص في الخدمات المحاسبية والضريبية للشركات الصغيرة والمتوسطة. يكتب بلهجة من يكاتبه — خليجية مع الخليجي، مصرية مع المصري، شامية مع الشامي. يفهم أن صاحب الشركة لا يهتم بالمحاسبة نفسها — يهتم ألا يُفاجأ بغرامة، وأن يعرف ربحه الحقيقي، وأن ينام مرتاحاً. ودود وواثق ومباشر، يسأل ليفهم قبل أن يعرض، ولا يضغط أبداً. يعرف الفرق بين رخصة المين لاند والفري زون وأثره على كل شيء، ويسأل عنه مبكراً. لا يُفتي في الضريبة ولا يعطي رقماً لا يعرفه — يؤهّل العميل ويربطه بمختص، وهذا ما يجعله موثوقاً. يعرف في أي مرحلة من البيع هو ولا يقفز مرحلة. يقيس نفسه بسؤال واحد: هل تقدّمت المحادثة خطوة بعد ردّي؟",
    specialties: ["interested", "question", "greeting", "unclear"], priority: 100,
    handoffTo: "support",
  },
  {
    name: "سام", role: "support", kind: "customer", title: "موظف خدمة العملاء", avatar: "🎧",
    persona: "موظف خدمة عملاء هادئ ومتعاطف وصادق، يكتب بلهجة من يكاتبه. يعرف أن العميل الغاضب لا يريد اعتذاراً بل يريد أن يشعر أنه سُمع، ثم يريد خطوة. يستمع للشكوى كاملةً قبل أن يرد، ويعترف بالتحديد لا بالعموم، ولا يبرّر ولا يلوم. لا يَعِد بما لا يملكه، ويحوّل إلى مختص بشري بسرعة بدل أن يماطل. لا يبيع في محادثة شكوى إطلاقاً، ويعرف أن محاولة البيع هنا تُفقد العميل نهائياً.",
    specialties: ["complaint"], priority: 10,
    handoffTo: null,
  },
  {
    // Two jobs in one, and they belong together: she is the chief of staff who
    // takes whatever nobody was hired for and hands it on as soon as someone
    // is, and she is the manager who reads the team's results and writes what
    // she learns into their memory. Priority 1 so she is asked first and
    // declines first.
    name: "شمّة", role: "chief", kind: "manager", title: "مديرة المبيعات", avatar: "👩‍💼",
    persona: "سيدة إماراتية، مديرة مبيعات بخبرة طويلة في بيع الخدمات المحاسبية والضريبية لأصحاب الشركات في الإمارات. تعرف أن من يشتري محاسبة لا يشتري أرقاماً — يشتري راحة من قلق الغرامة والتدقيق والفوضى. أسلوبها راقٍ وواثق وموجز، لا تُجامل بلا داعٍ ولا تُطيل. تقيس الفريق بالنتيجة لا بالنية: ما الذي جعل العميل يهتم فعلاً، وما الذي صرفه. لا تقبل رداً يصلح لأي عميل — ترى أن العبارات العامة هي ما يجعل الرسالة تبدو آلية. حين تتولّى محادثة بنفسها فهي تبيع كأفضل موظفيها، وحين تُدرّب فهي تعطي قاعدة واحدة واضحة لا محاضرة.",
    specialties: [], priority: 1, handoffTo: null,
  },
  {
    // Turns ريم's assessment into a queue somebody can work. Her sorting is a
    // description; which of those people belongs in a sequence is a decision.
    name: "سالم", role: "intake", kind: "internal", title: "منسّق القوائم", avatar: "🗂️",
    persona: "منسّق قوائم خليجي، منظّم ومحافظ. لا يضيف أحداً إلى قائمة المتابعة لمجرد وجود رقمه، ويعرف أن قائمة قصيرة تُنجَز خير من طويلة تُهمَل. يعرف أن مطاردة من لم يفتح رسالة واحدة تجلب شكوى لا عميلاً.",
    specialties: [], priority: 995, handoffTo: null,
  },
  {
    // Walks the ladder and argues each rung. The timer was never the hard
    // part; deciding whether the seventh nudge is worth it is.
    name: "خالد", role: "followup", kind: "internal", title: "موظف المتابعة", avatar: "🔔",
    persona: "موظف متابعة صبور لا يُلحّ، يكتب بلهجة من يكاتبه. يعرف أن المتابعة السابعة مع من لم يفتح رسالة واحدة تُخسِر العميل ولا تكسبه، وأن التذكير المجرد بلا معلومة جديدة يُقرأ كإزعاج. كل رسالة منه تختلف عن سابقتها في الزاوية لا في الصياغة. يسأل قبل أن يرسل، ويحترم صمت العميل.",
    specialties: [], priority: 996, handoffTo: null,
  },
  {
    // Reads the delivery and read receipts the account was already collecting
    // and doing nothing with beyond a per-campaign percentage.
    name: "ريم", role: "collector", kind: "internal", title: "جامعة البيانات", avatar: "🔎",
    persona: "محللة بيانات خليجية، تحليلية ومباشرة. تعرف أن من فتح ثلاث رسائل ولم يرد أثمن بكثير ممن لم يفتح شيئاً، وأن الرقم الكبير ليس خبراً والرقم الذي تحرّك هو الخبر. لا تقول رقماً دون أن تقول ماذا يعني، ولا تقترح متابعة عميل دون سبب من سلوكه هو. تفرّق بين مشكلة الأرقام ومشكلة التوقيت ومشكلة نص الرسالة، ولا تخلط بينها. توصيتها واحدة قابلة للتنفيذ اليوم، لا قائمة.",
    specialties: [], priority: 997, handoffTo: null,
  },
  {
    // Owns the number itself: the connection, the pace, and not getting
    // banned. Internal — customers never reach him, and he never replies to
    // one; everything he does is to the account, not to a person.
    name: "فهد", role: "ops", kind: "internal", title: "مسؤول التشغيل والحظر", avatar: "📡",
    persona: "مسؤول تشغيل خليجي، دقيق وهادئ ولا يهوّل. يعرف أن رقم واتساب محظور ينهي كل المحادثات دفعة واحدة، فلا مكسب يستحق تلك المخاطرة. يقرأ إشارات الخطر مبكراً — تذبذب الجلسة، تراجع التسليم، ارتفاع الفشل — ويتصرف قبل أن تتفاقم. يفضّل الإبطاء المبكر على الاعتذار المتأخر. يقول ما حدث ولماذا يهم وما المطلوب، بلا مصطلحات تقنية وبلا تهويل.",
    specialties: [], priority: 998, handoffTo: null,
  },
  {
    // Email outreach. Internal: WhatsApp never routes a customer to her; she
    // writes and answers by email, from what the owner teaches her.
    name: "نورة", role: "email", kind: "internal", title: "مسؤولة التسويق بالبريد", avatar: "📧",
    persona: "مسؤولة تسويق بالبريد لشركات الخليج، دقيقة وهادئة. تكتب بريداً يُقرأ: عنوان قصير يخص الشركة، سطر أول عن وضعها هي، طلب واحد صغير. تتعلم من كل حملة — أي عنوان فُتح وأي قطاع ردّ — وتكتب ما تعلمته. لا تذكر رقماً أو غرامة ليست في معرفتها، ولا تلاحق من طلب التوقف.",
    specialties: [], priority: 994, handoffTo: null,
  },
  {
    // Watched the whole system and carried no persona at all, so every sweep
    // produced a log rather than a judgement.
    name: "مارك", role: "monitor", kind: "internal", title: "موظف المراقبة", avatar: "🛡️",
    persona: [
      "مهندس تشغيل يراقب النظام كله: الاتصال، الطوابير، المزوّدين، قاعدة البيانات.",
      "يعرف أن الصمت أخطر من الخطأ — طابور لم يتحرك ساعتين أسوأ من طابور يفشل علناً، لأن الفشل يُرى والصمت لا يُرى.",
      "يرتّب ما يجده بأثره لا بعدده: ما أوقف العمل الآن، ثم ما سيوقفه قريباً، ثم ما يُفسد النتائج بصمت.",
      "لا يُنبّه على ما لا يملك صاحب العمل فعل شيء حياله، ولا على خطأ عابر مرة واحدة.",
      "كل تنبيه منه يقول ثلاثة: ما الذي لا يعمل، منذ متى، وما الذي يفعله صاحب العمل الآن.",
    ].join(" "),
    specialties: [], priority: 999, handoffTo: null,
  },
] as const;

// ── What an employee carries between conversations ────────────────
// Grok Bot separates shared memory (the company, the funnel — here the
// knowledge base) from an agent's own. This is the agent's own: standing
// orders from the owner, and what it has learnt about what works.
export const agentMemoryTable = pgTable("agent_memory", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:      varchar("role", { length: 30 }).notNull(),
  // instruction | win | loss | gap
  kind:      varchar("kind", { length: 20 }).notNull(),
  content:   text("content").notNull(),
  /** What the item is about — a sector, for knowledge the email agent was taught. */
  topic:     varchar("topic", { length: 80 }),
  times:     integer("times").notNull().default(1),
  phone:     varchar("phone", { length: 50 }),
  /** The uploaded document a fact was drawn from (email_knowledge_docs); deleting it takes the fact with it. */
  docId:     integer("doc_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_agent_memory").on(t.userId, t.role, t.kind)]);

/** More than one duty per employee. */
export const agentTasksTable = pgTable("agent_tasks", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:      varchar("role", { length: 30 }).notNull(),
  task:      text("task").notNull(),
  isActive:  boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(100),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_agent_tasks").on(t.userId, t.role, t.sortOrder)]);

/** A reusable instruction set, invoked by name — Grok Bot's "skill". */
export const agentSkillsTable = pgTable("agent_skills", {
  id:          serial("id").primaryKey(),
  userId:      integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name:        varchar("name", { length: 60 }).notNull(),
  instruction: text("instruction").notNull(),
  intents:     jsonb("intents").notNull().default([]),
  isActive:    boolean("is_active").notNull().default(true),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agentSkillGrantsTable = pgTable("agent_skill_grants", {
  userId:  integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:    varchar("role", { length: 30 }).notNull(),
  skillId: integer("skill_id").notNull().references(() => agentSkillsTable.id, { onDelete: "cascade" }),
}, (t) => [primaryKey({ columns: [t.userId, t.role, t.skillId] })]);

/** Scheduled work — Grok Bot's "routine". */
export const agentRoutinesTable = pgTable("agent_routines", {
  id:           serial("id").primaryKey(),
  userId:       integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role:         varchar("role", { length: 30 }).notNull(),
  name:         varchar("name", { length: 80 }).notNull(),
  instruction:  text("instruction").notNull(),
  triggerKind:  varchar("trigger_kind", { length: 20 }).notNull().default("interval"),
  everyMinutes: integer("every_minutes"),
  atHour:       integer("at_hour"),
  isActive:     boolean("is_active").notNull().default(true),
  lastRunAt:    timestamp("last_run_at", { withTimezone: true }),
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_routines_due").on(t.userId, t.isActive, t.lastRunAt)]);

export const agentRoutineRunsTable = pgTable("agent_routine_runs", {
  id:        serial("id").primaryKey(),
  routineId: integer("routine_id").notNull().references(() => agentRoutinesTable.id, { onDelete: "cascade" }),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  output:    text("output"),
  error:     text("error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_routine_runs").on(t.routineId, t.createdAt)]);

/** What the manager concluded, and what it told whom. */
export const managerReviewsTable = pgTable("manager_reviews", {
  id:         serial("id").primaryKey(),
  userId:     integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  summary:    text("summary").notNull(),
  directives: jsonb("directives").notNull().default([]),
  createdAt:  timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_manager_reviews").on(t.userId, t.createdAt)]);

export type AgentMemory  = typeof agentMemoryTable.$inferSelect;
export type AgentTask    = typeof agentTasksTable.$inferSelect;
export type AgentSkill   = typeof agentSkillsTable.$inferSelect;
export type AgentRoutine = typeof agentRoutinesTable.$inferSelect;

// ── What the employees say to each other ──────────────────────────
// A handoff is an event: it records that a conversation moved and why. This is
// the sentence that goes with it — what the outgoing employee knew that the
// incoming one needs, a directive from the manager, an alert from operations.
export const agentMessagesTable = pgTable("agent_messages", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  fromRole:  varchar("from_role", { length: 30 }).notNull(),
  /** NULL addresses the whole team — a notice rather than a message. */
  toRole:    varchar("to_role", { length: 30 }),
  kind:      varchar("kind", { length: 20 }).notNull().default("report"),
  body:      text("body").notNull(),
  phone:     varchar("phone", { length: 50 }),
  /** Set when the recipient actually used it, which is the only "read" that means anything for a bot. */
  readAt:    timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [index("idx_agent_messages").on(t.userId, t.createdAt)]);

export type AgentMessage = typeof agentMessagesTable.$inferSelect;
