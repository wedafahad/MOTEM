# عقد API — نظام «متم» (تقييم فريق الكتابة، كناية)

هذا العقد موحّد بين نسختين من الخادم:
- `api/mock_server.py` — خادم اختبار محلي (JSON على القرص) يُستخدم فقط أثناء التطوير.
- `api/Code.gs` — خادم الإنتاج الحقيقي (Google Apps Script + Google Sheets).

الواجهة (`web/`) لا تفرّق بينهما؛ كل ما تحتاجه هو رابط الخادم (`API_URL`) الذي يُدخله المدير مرة واحدة عند أول تشغيل ويُحفظ محليًا **كإعداد اتصال فقط** (وليس كبيانات عمل).

## شكل الطلب

كل طلب هو `POST` بجسم JSON:

```json
{
  "action": "login | listEmployees | upsertEmployee | deleteEmployee | listWork | upsertWork | deleteWork | listBehavioral | upsertBehavioral | deleteBehavioral | listEval | upsertEval | upsertSelfAssessment | submitSelfAssessment | approveEval | getSettings | setSettings | listAudit | adminLogin | changeAdminPassword",
  "auth": { "code": "XXXXXX" } ,
  "payload": { }
}
```

- `auth.code`: الكود الشخصي (كاتب/مقيّم) المُرسَل مع كل طلب لتحديد الصلاحية من جهة الخادم (تفويض حقيقي على الخادم، وليس فقط إخفاء في الواجهة).
- لعمليات الإدارة العامة: `auth.admin = true` و `auth.password`.

## الرد

```json
{ "ok": true, "data": ... }
```
أو عند الفشل:
```json
{ "ok": false, "error": "رسالة واضحة" }
```

## الجداول (Sheets/JSON)

### Employees
`id, name, isWriter, isEvaluator, level(writer|senior), specialty(creative|formal|general), managerId, writerCode, evaluatorCode, active, createdAt, updatedAt`

### WorkLog
`id, employeeId, title, workType(creative|formal), quarter, date, project, workCategory, customCategory, actionType,
delivered, onTime, firstDraftAccepted (مهمَل — انظر ملاحظة أدناه), contentRevisionRounds, scopeRevisionRounds, collaborators[{employeeId,sharePercent}],
isRevision, revisionOfWorkId, link, notes, createdBy, createdAt, updatedAt, socialSubTypes[], isCollaborative`

- **`firstDraftAccepted` (مهمَل، بند 2.1)**: كان خانة يُقرّرها من يسجّل العمل (تقول "قُبل من أول مسودة")، وتُحسب منها نسبة تلقائية تُستخدم كدرجة معيار "نسبة القبول من أول مسودة". أُلغي هذا الخيار من نموذج تسجيل/تعديل العمل ومن جدول العرض والتصدير — لم يعد أحد يُدخله لأعمال جديدة. المعيار نفسه (`first_draft_acceptance` ضمن ركيزة `client_satisfaction`) صار معيارًا عاديًا بدرجة يقدّرها المقيّم مباشرة (anchors 5/3/1) بدل احتسابه تلقائيًا من `firstDraftAccepted`. العمود يبقى في WorkLog لأسباب تاريخية فقط (صفوف قديمة) ولا يُقرأ من أي حساب جديد.

- `workCategory`: أحد الأنواع الثابتة (انظر `WORK_CATEGORIES` في main.js) أو `"أخرى"` مع `customCategory` نصًا حرًا.
- `"منشورات وسائل التواصل الاجتماعي"` نوع أب مُجمَّع (إنفوجرافيك / تغريدة / كاروسيل / بطاقة رقمية / Gif). عمل واحد مسجَّل = دفعة كاملة من منشورات مشروع معيّن، يُقيَّمها المقيّم مرة واحدة بمعايير الجودة، وتُطلب لها `socialSubTypes: string[]` (أكثر من نوع فرعي في نفس العمل، مثال: `["إنفوجرافيك","Gif","كاروسيل"]`) و`project` **إجباري** (يُستخدم لتجميع دفعات المشروع الواحد). "عدد أنواع النصوص" يعدّ كل نوع فرعي مستخدَم كنوع مستقل (لا العمل كوحدة واحدة) — عمل واحد بأربعة أنواع فرعية = 4 في هذا المؤشر. في تقرير "عدد الأعمال حسب النوع" يظهر هذا التصنيف كسطر واحد بعدّاد إجمالي (عدد الأعمال/الدفعات)، وعند التوسّع (`<details>`) يظهر عدد الأعمال التي شملت كل نوع فرعي (لا عدد قطع المحتوى الفعلي — الكمية داخل كل نوع لا تُحتسب رقميًا، فقط تُذكر إن لزم في حقل الملاحظات).
- الحقل القديم `socialSubType` (نص مفرد) باقٍ في الشيت لأسباب تاريخية وغير مستخدَم من الواجهة الحالية — المصدر الفعلي هو `socialSubTypes`.
- `isCollaborative` (Boolean): هل هذا العمل مشترك بين أكثر من كاتب. حقل مستقل عن `collaborators[]` (الذي يحمل نِسَب التوزيع الفعلية إن استُخدم لاحقًا) — هذا فقط علم نعم/لا يظهر في نموذج تسجيل العمل وسجل الأعمال.
- `isRevision`/`revisionOfWorkId`: إذا كان هذا العمل مراجعة/تحديثًا لعمل سابق، يُحتسب بقيمة `revisionValueMultiplier` بدل قيمة كاملة في: (أ) مؤشر "عدد الأعمال الموكلة" المرجعي، (ب) متوسط معايير ركيزة الجودة. لا يؤثر على أي مقياس آخر (عدد المشاريع، عدد أنواع النصوص، نسب الانضباط/رضا العميل).

### BehavioralLog
`id, employeeId, quarter, indicator(brainstorming|knowledge_sharing|initiative), description, date, loggedBy, createdAt`

### EvalScores
`id, employeeId, quarter, evaluatorId, status(draft|submitted|approved), pillarScores{pillarId:{criteriaScores:{critId:score}, comment}},
selfAssessment{critId:score}, managerAudit{critId:score, note}, totalScore, classification, approvedBy, approvedAt, comments, createdAt, updatedAt,
selfAssessmentStatus(draft|submitted), selfAssessmentSubmittedAt`

- **آلية التقييم الذاتي**: الكاتب يحفظ تقييمه الذاتي حفظًا قابلًا للتعديل عبر `upsertSelfAssessment` ما دام `selfAssessmentStatus != "submitted"`. الحدث الذي يُقفله نهائيًا هو فعل الكاتب نفسه: استدعاء `submitSelfAssessment` (زر "اعتماد تقييمي الذاتي" في الواجهة) — بعده يرفض الخادم أي `upsertSelfAssessment` لاحق لنفس الربع. قبل الاعتماد، لا يرى المقيّم قيم `selfAssessment` إطلاقًا (يعود فارغًا `{}` من `listEval`)؛ بعد الاعتماد يظهر كاملًا. هذا منفصل تمامًا عن `status`/`approveEval` (اعتماد المقيّم لتقييمه هو ككل).
- في شاشة/تقرير التقييم النهائي (بعد `status === "approved"`)، لكل معيار سلوكي له `selfAssessment[critId]` تُعرَض قيمتا الكاتب الذاتية وقيمة المقيّم (`pillarScores[pillarId].criteriaScores[critId]`) جنبًا لجنب، لا رقمًا مدمجًا واحدًا.

### Settings (صف واحد JSON)
`pillars[], classification[], revisionValueMultiplier` — قابل للتعديل بالكامل من شاشة الإعدادات (إدارة فقط).
كل ركيزة فيها `category(technical|behavioral)` يحدّد قسمها في لوحة الكاتب، و`weightWriter`/`weightSenior` — الركيزة ذات وزن 0 لمستوى معيّن تُستبعد كليًا (لا تُعرض، لا تُطلب من المقيّم، لا تدخل حساب الاكتمال) لذلك المستوى، كحال ركيزة `leadership` مع الكاتب العادي.
- ركيزتا `teamwork` (العمل الجماعي — سلوكي) و`info_accuracy` (دقة المعلومات ومصادر موثوقة — فني) مُضافتان بوزن `0/0` افتراضيًا (مرحلة 1) حتى لا تتغيّر درجة أي كاتب تلقائيًا؛ على الإدارة تحديد وزنهما الفعلي من شاشة «المعايير والأوزان» (وعادةً خصم ذلك الوزن من ركيزة أخرى لإبقاء المجموع 100).

### AuditLog
`id, timestamp, actorRole, actorName, action, targetType, targetId, details`

## قواعد الخصوصية (تُطبَّق في الخادم لا في الواجهة فقط)
- **كاتب**: يرى وي‌عدّل فقط صفوفه الخاصة (`employeeId == self`) في WorkLog/BehavioralLog، ويقرأ EvalScores الخاصة به فقط إذا `status == approved`، ويكتب فقط `selfAssessment`.
- **مقيّم**: يرى ويعدّل صفوف موظفيه المباشرين فقط (`managerId == self`) + صفوفه هو كـ"كاتب" إن كان يملك صفة كاتب أيضًا.
- **إدارة عامة**: صلاحية كاملة على Employees/Settings/AuditLog، لكن **لا** تحصل على تفاصيل EvalScores (المعايير والتعليقات) إلا إذا أرفقت أيضًا كود المقيّم صاحب العلاقة ضمن `auth.code` — فقط الحالة/الإجمالي/التصنيف تظهر لها للمتابعة.
- **المدير (بند 2.2)**: الموظف الذي لا مدير فوقه (`managerId: null`) — وهو "أعلى مقيّم" في التسلسل الهرمي — يكتسب تلقائيًا صلاحيات الإدارة العامة التشغيلية (Employees CRUD، Settings، قراءة AuditLog)، إضافةً لما يملكه أصلًا كمقيّم (رؤية تفاصيل تقييمات كامل تسلسله الهرمي دون حجب). هذا مُنفَّذ عبر علم منفصل `actor.isOrgAdmin` (وليس `actor.isAdmin` الذي يبقى محصورًا حصرًا بتسجيل الدخول بكلمة مرور الإدارة العامة) — بهذا يبقى قيد الخصوصية أعلاه على "الإدارة العامة" سليمًا تمامًا: منح المدير صلاحيات تشغيلية إضافية لا يعني أبدًا أن الإدارة العامة صارت ترى تفاصيل التقييمات. الاستثناء الوحيد: تغيير كلمة مرور الإدارة العامة (`changeAdminPassword`) يبقى محصورًا بـ`isAdmin` فقط — لم يُمنح للمدير لأنه تدوير بيانات اعتماد حسّاس، ويمكن تغيير هذا لاحقًا بطلب صريح.


## الأرشفة الفصلية (بند 2.3)
بعد مرور 21 يومًا (3 أسابيع) من بداية كل ربع ميلادي جديد (1 يناير/أبريل/يوليو/أكتوبر)، يُنقَل سجل الربع الذي قبله من WorkLog/BehavioralLog/EvalScores إلى أوراق أرشيف منفصلة بنفس الاسم + `_Archive` — **نقل لا حذف**، الهدف تخفيف حمل الأوراق الحيّة عن الخادم لا فقدان البيانات. التطبيق (listWork/listEval/...) لا يقرأ إلا من الأوراق الحيّة، فبيانات الربع المؤرشَف تختفي من الواجهة كما هو مطلوب، لكنها تبقى موجودة وقابلة للفتح يدويًا من الشيت مباشرة.

الآلية (في `Code.gs`): `archiveOldQuartersIfDue()` تُفحص يوميًا عبر Trigger زمني، ولا تُنفّذ شيئًا فعليًا إلا حين يتحقق الشرطان معًا: مرّت 21 يومًا من بداية الربع الحالي، ولم يُؤرشَف الربع السابق بعد (تُسجَّل الأرباع المؤرشَفة في `Settings.archivedQuarters`). عند التنفيذ: نسخ كامل الصفوف إلى ورقة الأرشيف أولًا، تحقّق من نجاح النسخ، ثم حذف من الورقة الحيّة فقط بعد التحقق — أي خطأ يوقف العملية قبل أي حذف.

**لا يُفعَّل أي شيء تلقائيًا بمجرد وجود هذا الكود.** التفعيل خطوة يدوية صريحة: تشغيل `installQuarterlyArchiveTrigger()` مرة واحدة من محرر Apps Script (تمامًا كخطوة `setupInitialData`)، وهذا يُثبّت Trigger يوميّ يستدعي `archiveOldQuartersIfDue` كل يوم (لا في تاريخ محدد بالضبط، تفاديًا لهشاشة توقيت Apps Script). لا تُشغّلي `installQuarterlyArchiveTrigger` قبل مراجعة هذه الآلية والموافقة عليها صراحة.
