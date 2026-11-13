# تدقيق الأولوية صفر — السلامة في Flow Hub

التاريخ: ٩ نوفمبر ٢٠٢٦. بالقراءة وgrep على الشيفرة بعد التعديل (أرقام الأسطر من الملفات الحالية). الجذر: `artifacts/api-server/src`.

**القاعدة بعد هذا العمل:** كل إرسالٍ خارجي يسأل `gateSend` (`lib/org/gateway.ts`)، وكل نداء نموذج يسأل `isHalted` (`lib/org/controls.ts`). ما كان موجوداً (الحاجز، نافذة البريد، السقوف، فاصل الشركة) باقٍ في مكانه ويعمل أيضاً.

## أ) مسارات الإرسال الخارجي

### واتساب

الحلقة الأخيرة هي `WAInstance.sendMessage` في `lib/whatsapp.ts:2690`: تسأل البوابة عند الدخول (2703، إلا إن مرّت من الغلاف) ومرة ثانية قبيل السلك (2773)، لأن الرسالة الباردة قد تنتظر دقائق في طابور الحاجز.

| المسار | الملف:السطر | ما كان يحرسه | ثغرة كانت | الآن |
|---|---|---|---|---|
| الغلاف `sendMessage` | `lib/whatsapp.ts:3315` | `firewall.admit` | لا مفتاح إيقاف | `waGate` قبل admit (3323) |
| الغلاف `sendVoiceNote` | `lib/whatsapp.ts:3341` | `admit` | كذلك | `waGate` (3343) |
| الحملات | `routes/campaigns.ts:173` | قائمة الإلغاء بالتطابق الحرفي (1478)، الفحص، الحاجز | لا مفتاح | عبر الغلاف، `FIREWALL:` توقف الحملة (1708) |
| متابعة التسلسل | `lib/follow-up-engine.ts:736` | إلغاء بالتطابق الحرفي (708)، الحد اليومي | صيغة أخرى للرقم تعبر | عبر الغلاف، `key9` |
| الرد الآلي | `lib/follow-up-engine.ts:510,511,514` | kind=reply | لا فحص لقائمة الإلغاء (انظر «متروك») | عبر الغلاف |
| المتابعة الذكية | `lib/smart-followup.ts:906,907,984,1120,1171,1208` | فحوص خاصة، kind=followup | **دافئ + admit يتجاوز القائمة السوداء**: من كتب «إيقاف» يُعدّ دافئاً ٧٢ ساعة | أُغلق: `gateSend` يرفض `followup` لمن طلب الإيقاف |
| يدوي من الصندوق | `routes/whatsapp.ts:592,606` | `admit` (manual) | — | عبر الغلاف. المفتاحان القديمان لا يوقفانه؛ org_controls يوقفه |
| رسالة اختبار | `routes/whatsapp.ts:129` | `admit` (manual) | — | عبر الغلاف |
| `directSend` (تشخيص) | `lib/whatsapp.ts:944`، `routes/diagnostics.ts:32` | لا شيء | **يتجاوز كل شيء** | `gateSend` kind=diagnostic، ويحترم الإيقاف |
| تأكيد الإيقاف والأزرار | `lib/whatsapp.ts:2390,2423,2436` | لا شيء (نداء مباشر) | **تجاوز admit** | البوابة داخل الطريقة نفسها؛ `optout_ack` معفى من القائمة، و`reply` كذلك |
| الأزرار/الكاروسيل | `lib/whatsapp.ts:237,274` | داخل الطريقة | — | محروس بما فوقه |
| الاستدعاء (حذف للجميع) | `lib/whatsapp.ts:3287`، `routes/whatsapp.ts:140`، `smart-followup.ts:1077,1117` | لا شيء | — | **معفى عمداً**: يسحب رسالة ولا يرسل جديداً. دورة التصحيح في smart-followup لا تبدأ والحساب موقوف |
| مؤشر الكتابة وعلامة القراءة والحضور | `lib/whatsapp.ts` `simulateHumanPresence`، `markRead`، `scheduleGoOffline`؛ `follow-up-engine.ts` (`markRead` بدور الموظف) | — | — | **محروس منذ ١٣ نوفمبر**: `signalAllowed` في `lib/org/gateway.ts` تسأل `isHalted` (المنصة، الحساب، قناة واتساب وقسمه، الموظف) من الذاكرة المخزّنة (١٠ ث للمفاتيح، ومثلها `offDuty`)، بلا تذكرة ولا سطر سجل لكل علامة. الفشل مغلق (لا تُقرأ المفاتيح ← لا علامة)، والمحاكاة لا علامة فيها. المفتاحان القديمان لا يوقفان مؤشر رسالة صاحب العمل اليدوية (`HUMAN_KINDS`) كما لا يوقفان رسالته. بلا إيقاف لا يتغيّر شيء. الاختبار: `org-e2e-channels.test.ts` |
| المجموعات | `routes/groups.ts`، `lib/groups/*` | قراءة فقط (`groupMetadata`، `fetchMessageHistory`)، والمقترحات تنتظر موافقة | — | لا إرسال |

### البريد

الحلقة الأخيرة `sendEmail` في `lib/email/provider.ts:121`، والبوابة في أولها (125). `diagnose.ts` و`verifySettings` يفحصان الاتصال ولا يرسلان.

| المستدعي | الملف:السطر | kind | ما كان يحرسه | عند المفتاح |
|---|---|---|---|---|
| `drainOne` | `lib/email/service.ts:584` | campaign | النافذة، الحارس، السقوف، فاصل الشركة، حالة الجهة | تبقى `queued`، سبب في `stallReason` (444، 595) |
| `sendReply` | `lib/email/inbound.ts:624` | reply | `autoSendBlocker` للآلي، لا شيء لليدوي | المسودة كما هي، ويُحذف سطر المحاولة |
| `escalate` | `lib/email/inbound.ts:473` | owner_notice | — | يمرّ، وإلى صندوق صاحب العمل وحده |
| `deliver` (عروض ومتابعاتها) | `lib/deals/proposals.ts:111` | proposal | **لا قائمة إلغاء أبداً** | العرض كما هو، خطأ للمستخدم. أُغلقت الثغرة |
| اختبار الإعدادات والحملة | `routes/email.ts:445,1072` | test | لا قائمة | خطأ 400. لغير صاحب العمل تحترم القائمة |

### السوشيال

`lib/social/drivers/index.ts`: `driverFor(p, userId)` هي الطريق الوحيد إلى مشغّل، وتغلّف `sendDm/replyToComment/publish/commentOn/connect` بالبوابة. `mayAct` في `engine.ts` يسأل المفتاح قبل كل فعل فيبقى المعتمد `approved`. القراءة (الوارد، التعليقات، البحث) لا تُحرس لأنها لا ترسل. **لينكدإن:** بلا مشغّل، و`gateSend` يرفضها دائماً.

### داخلي (خارج البوابة عمداً)

| | الملف | لماذا |
|---|---|---|
| تليجرام `notify`/`flushOutbox` | `lib/telegram.ts` | تقرير لصاحب العمل، وعند الإيقاف هو أحوج ما يكون إليه |

### مسارات خارجية غير رسائل (لم تُحرس، للعلم)

| | الملف | ملاحظة |
|---|---|---|
| المتصفح الداخلي: القراءة | `routes/browser.ts` (`/read`، `/research`، `/open`، `/screen`، `/form`)، `lib/browser-agent.ts` `readPage/screenshot/readForm` | قراءة فقط: تنقّل GET واستخراج نص وصورة. لا ينشر ولا يرسل، فيبقى خارج المفاتيح عمداً. `/research` يمرّ نموذجه بـ`complete` تحت `asWorker` فيحترم إيقاف النماذج |
| المتصفح الداخلي: التعبئة والنقر | `routes/browser.ts` `/fill`، `/click` | قد يرسل نموذجاً إلى الخارج، فصار **يحترم المفاتيح** منذ ١٣ نوفمبر (`haltedHand`: المنصة، الحساب، قسم الموظف، الموظف؛ 423 عند الإيقاف؛ الفشل مغلق). المفتاحان القديمان لا يوقفان يد صاحب العمل، كما في `decideGate` لليدوي. لا يمر بالبوابة نفسها (ليس رسالة لعميل) |
| نافذة تسجيل الدخول للسوشيال عن بُعد | `routes/social.ts` `/:platform/remote/click`، `type`، `key` | النقرة على صفحة الحساب قد تنشر كما تسجّل الدخول، فصارت **تحترم المفاتيح** (المنصة، الحساب، قناة المنصة، قسمها). الصورة (`remote/screen`) وفتح نافذة الدخول قراءة فلا تُحرس |
| TTS | `lib/tts.ts:102` | `speak` لا يُصل إليه إلا بعد البوابة؛ `speakMp3` معاينة لصاحب العمل |
| فحص الصناديق، Tavily، قراءة المواقع | `email/mailbox-check.ts`، `accounts/pipeline.ts:33,53`، `site-study.ts:50` | طلبات شبكة بلا رسالة؛ عمّالها موصولون بالإيقاف |

## ب) نداءات النموذج

`complete()` في `lib/llm.ts:441` يسأل `isHalted` قبل أي شبكة. داخل عامل: حساب + دور + قسم. خارجه: المنصة وحدها.

**مهم:** لفّ العمل بـ`asAgent` يغيّر مسار النموذج لحسابي Pro Count وFloret إلى المفاتيح المدفوعة (`gridAllowed`). فأضفتُ `asWorker` (`lib/agent-context.ts`): يعطي الاسم للمفاتيح والإيصالات، والمسار كما كان. أثرٌ جانبي مقبول: صفوف `receipts` و`llm_usage` جديدة لهذه الأعمال.

| النداء | الملف:السطر | قبل | الآن |
|---|---|---|---|
| المهام الدورية | `agent-routines.ts:130` | خارج asAgent | `asWorker` |
| الجامع | `collector-agent.ts:239` | خارج | `asWorker` |
| التشغيل | `ops-agent.ts:359` | خارج | `asWorker` |
| المدرّب | `coach-agent.ts:118` | خارج | `asWorker` |
| الاجتماع | `meeting.ts:259` | خارج | `asWorker` |
| مسؤول المتابعة | `followup-officer.ts:165` | خارج | `asWorker` |
| المساعد | `assistant.ts:180` | خارج | `asWorker` |
| ملاحظة التسليم | `agent-comms.ts:101` | خارج | `asWorker` |
| الرد والمراجعة | `knowledge.ts:492,513` | داخل غالباً، ليس دائماً | `asWorker` (لا يغيّر شيئاً داخل asAgent) |
| تعليم نورة، دروسها، سؤالها | `email/agent.ts:165,454`، `email/knowledge-docs.ts:206` | خارج | `asWorker` |
| تصنيف الوارد | `email/classify.ts:436` | خارج | `asWorker` حين يُعرف الحساب |
| مسارات المزوّد والبحث | `routes/knowledge.ts:52,79`، `routes/browser.ts:88` | خارج | `asWorker` |
| البقية (٢٩ نداء) | `email/{manager,pipeline,inbound,specialists,shop-writer}`، `smart-followup` (٦)، `wa-manager`، `wa-autopilot`، `chat-lead`، `graph/*`، `groups/*`، `social/agent`، `accounts/pipeline`، `deals/proposals`، `content/plans`، `data-desk`، `site-study`، `team-overview` | داخل asAgent | كما هي |

### نداءات مباشرة خارج `complete`

| النداء | الملف | كان يحترم offDuty؟ | الآن |
|---|---|---|---|
| Groq رؤية | `vision.ts` | لا | `modelHalted(userId)`، والحساب يُمرَّر من `whatsapp.ts:2302` |
| Groq تفريغ | `voice.ts` | لا | كذلك، `whatsapp.ts:2279` و`routes/agents.ts:39` |
| Pollinations | `intent.ts:189` | لا | `modelHalted`؛ الحكم يعود للقواعد. المستدعي بلا حساب: المنصة وحدها |
| Pollinations | `routes/ai.ts:24` | لا | 503 عند الإيقاف |
| Gemini معرض الصور | `image-sense.ts:54` | لا | `modelHalted` + العامل يتخطى الحساب. يرمي لئلا تُسجَّل الصورة «مقروءة» |

## ج) العمّال المجدولون

**موصول (يسأل عن الحساب في أول جولته):**

| العامل | الملف:السطر |
|---|---|
| حارس القوائم | `list-keeper.ts:92` |
| معرض الصور | `image-sense.ts:140,146` |
| الجامع | `collector-agent.ts:291` |
| مديرة واتساب | `wa-manager.ts:313` |
| المتابعة الذكية | `smart-followup.ts:1241` |
| الاجتماع | `meeting.ts:524` |
| مزامنة الكتالوج | `catalog/floret.ts:178` |
| المهندس | `graph/engineer.ts:450` |
| متابعة العروض | `deals/proposals.ts:133` |
| فاحص الأرقام | `wa-vetting.ts:332` |
| المهام الدورية | `agent-routines.ts:159` |
| السوشيال | `social/engine.ts:510` |
| متابعة التسلسل | `follow-up-engine.ts:689` |
| مكتب الحسابات | `accounts/desk.ts:211` |
| طيار واتساب | `wa-autopilot.ts:442` |
| الترتيب | `organize.ts:306,307` |
| مسؤول الشات | `chat-lead.ts:179` |
| مدير البريد | `email/manager.ts:421` |
| ماجد | `email/caretaker.ts:128` |
| الأخصائيون | `email/specialists.ts:224` |
| المهام | `email/missions.ts:441` |
| طيار البريد | `email/autopilot.ts:396` |
| طابور البريد | `email/service.ts:444` (عبر drainOne) |
| درجات التسلسل، المجدولة، A/B | `email/service.ts:316,326,689,791` |
| قراءة البريد، الردود الآلية | `email/inbound.ts:742,744,778` |
| حارس الحملات | `routes/campaigns.ts:308` |
| ملفات بلا حساب | `folders.ts:166` (المنصة وحدها) |

**معفى عمداً:**

| العامل | الملف | لماذا |
|---|---|---|
| الحاجز | `wa-firewall.ts:417` | يرى الخطر ويجمّد؛ لا يرسل |
| حارس الارتداد | `email/bounce-guard.ts` | يحمي، لا يرسل |
| تنظيف الإلغاءات | `opt-out.ts` | يجعل الإيقاف دائماً |
| المراقب، التشغيل | `monitor-agent.ts`، `ops-agent.ts` | عين صاحب العمل عند الإيقاف بالذات؛ النموذج فيهما مرفوض والنص الجاهز يكفي |
| تذكيرات صاحب العمل | `morning-brief.ts`، `groups/tasks.ts`، `groups/obligations.ts`، `deals/meetings.ts`، تقرير البريد المسائي، `escalateStaleHotDrafts` | إشعارات له نفسه |
| بنية تحتية | `telegram` outbox، الحارس والصيانة والنبض (`index.ts`)، مؤقتات `whatsapp.ts`، `email/public-url.ts`، `email/tunnel.ts`، `browser-agent` reaper، `app.ts` | لا عمل موظف فيها |
| بيانات محلية | `sweepQuietOutcomes` (`index.ts:220`)، `syncAccounts` (`accounts/desk.ts:216`) | تحديث إحصاءات بلا نموذج ولا إرسال |
| لمرة واحدة عند الإقلاع | `seedSkillsForEveryone`، `ensureEmailAgent`، `upgradeShopRules` | تجهيز |

ما كان يفحص حالة قبل هذا العمل: `list-keeper` و`wa-manager` و`smart-followup` و`graph/engineer` فحصوا `team_paused`؛ `social/engine` فحص `onDuty`. البقية لا شيء.

## د) الضوابط

| الضابط | المكان | ما يوقفه | ملاحظة |
|---|---|---|---|
| `org_controls` (جديد) | `lib/org/controls.ts` | عام ← حساب ← قناة ← قسم ← موظف | ذاكرة ١٠ ث؛ يُغلق إن تعذّرت القراءة |
| `team_paused` | `graph/switch.ts`، `business_profile` | كان: التفكير فقط. الآن: + إرسال الآلة + العمّال | لا يوقف رسالة صاحب العمل اليدوية ولا تأكيد الإيقاف |
| `bot_employees.is_active` | `graph/switch.ts` | تفكير الموظف، + إرساله إن كان الدور معروفاً | `offDuty` باقٍ، و`isHalted` يقرؤه منه |
| `firewall.admit` | `wa-firewall.ts:319` | طابور الرقم، السقف البارد، أسلاك التعثّر، الساعات | باقٍ. الدافئ لا يمرّ على القائمة السوداء (332) فسدّته البوابة للمتابعات |
| حجز الارتداد | `email/service.ts:450`، `bounce-guard.ts` | طابور البريد | باقٍ |
| الوضع التجريبي (dry) | `social` `a.dryRun`، `smart-followup` | | باقٍ |

**ملاحظة تشغيلية:** حملة أوقفها مفتاح تصير `paused` بسبب مكتوب ولا تعود وحدها عند رفعه (كالتجميد اليدوي اليوم). وكذلك إن أوقفها تعذّر قراءة الجدول (`controls unavailable`) بعد محاولتين.

## هـ) عزل الحسابات

### أُصلح

| المشكلة | الملف | الإصلاح |
|---|---|---|
| ويبهوك أحداث البريد يبحث عن الجهة **بلا user_id**: ارتدادٌ عند حساب يعلّم جهة حساب آخر | `routes/track.ts:128` | أُضيف الشرط |
| `POST /campaigns` يقبل `contactGroupId` لحساب آخر: حملة على قائمة غيرك | `routes/campaigns.ts` | 404. القوائم بلا مالك تبقى كما كانت |

### لم يُصلح (للقرار)

| المشكلة | الملف | الخطر | لماذا تُرك |
|---|---|---|---|
| `llm_settings` بلا فلتر: أول صف لأي حساب يُستعمل مفتاحاً للجميع، والذاكرة عامة | `lib/llm.ts:149,140` | مفتاح حساب يدفع عن غيره؛ وترتيب الصفوف غير مضمون | الفصل يغيّر مزوّد الحسابين الحيّين. يحتاج قراءة الصفوف على الإنتاج |
| ترتيب الإيصالات: `receipt()` متزامن النار، فصفّان متلاحقان قد يأخذان `id` بعكس ترتيب السلسلة فيظهر السجل «مكسوراً» | `graph/receipts.ts:64`، `receipts_first_broken` | إنذار كاذب (رُصد على قاعدة الاختبار: `id` ٣٢ و٣٣ في email-flow) | موجود قبل هذا العمل؛ `asWorker` يزيد الإيصالات قليلاً فيزيد احتماله |

### فُحص وسليم

الخرائط على مستوى الوحدة (`heldUntil`، `lastSent`، `busy`، `discovered`، `activeCampaigns`، `chains`، `coldTimes`) مفتاحها فيه الحساب. `transports` مفتاحه بيانات الدخول. `llm-health` و`gridInFlight` عامة عمداً. المسح الآلي ٣٦٦ موضعاً بلا `user_id` قرب الاستعلام؛ راجعتُ المشبوه منها، والغالب مقيَّد بـ`id` جرى التحقق من ملكيته قبله. **ليس برهاناً شاملاً:** لم تُقرأ الـ٣٦٦ كلها سطراً سطراً، ومسح SQL الخام اعتمد على نمط نصي.

### الإلغاء

| القناة | المصدر | أين كان يُفرض | الآن |
|---|---|---|---|
| واتساب | `unsubscribed_phones` | `admit` للبارد؛ تطابق حرفي في الحملات والتسلسل؛ `key9` في الفاحص وsmart-followup | `gateSend` بـ`key9` لكل ما عدا: reply، transactional، manual، optout_ack |
| بريد | `email_contacts.status` (unsubscribed، complained) | `drainOne` عبر حالة الجهة؛ لا شيء في العروض والاختبار | `gateSend` لكل ما عدا reply وowner_notice واختبار لصندوق صاحب العمل |
| سوشيال | `social_threads.status='stopped'` | `sendApproved` للردود فقط | `gateSend` لـdm وoutreach وfollowup أيضاً |

**متروك كما هو (يحتاج قرار صاحب العمل):**
1. من طلب الإيقاف ثم كتب لنا: الرد الآلي يخرج له (`kind=reply`)، واتساب وبريد يدوي. تغييره يخالف «لا تغيير في السلوك».
2. الإلغاء في قناة لا يمتد إلى الأخرى، مع أن `email_contacts.phone` موجود.
3. `bounced` و`invalid` ليسا «طلب إيقاف»؛ حارس الارتداد وحالة الجهة يتوليانهما، والعروض (`proposal`) لا تراهما.

## ما لم يُختبر

- لا إرسال حقيقي على واتساب أو SMTP أو مشغّل سوشيال حقيقي: بوابة واتساب فُحصت عبر `sendMessage` الحقيقية على مقبس وهمي لا جلسة Baileys، والسوشيال على مشغّل مُستبدَل.
- `index.ts` (انتظار الجداول قبل الاستماع) لم يُشغَّل كخادم كامل.
- الجدولة نفسها لم تُشغَّل في موعدها: اختُبر `accountHalted` و`drainQueues` مباشرة، ولكل عامل سطر موصول لا اختبار خاص به.
