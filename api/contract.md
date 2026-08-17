# عقد API — نظام «متم» (تقييم فريق الكتابة، كناية)

هذا العقد موحّد بين نسختين من الخادم:
- `api/mock_server.py` — خادم اختبار محلي (JSON على القرص) يُستخدم فقط أثناء التطوير.
- `api/Code.gs` — خادم الإنتاج الحقيقي (Google Apps Script + Google Sheets).

الواجهة (`web/`) لا تفرّق بينهما؛ كل ما تحتاجه هو رابط الخادم (`API_URL`) الذي يُدخله المدير مرة واحدة عند أول تشغيل ويُحفظ محليًا **كإعداد اتصال فقط** (وليس كبيانات عمل).

## شكل الطلب

كل طلب هو `POST` بجسم JSON:

```json
{
  "action": "login | listEmployees | upsertEmployee | deleteEmployee | listWork | upsertWork | deleteWork | listBehavioral | upsertBehavioral | deleteBehavioral | listEval | upsertEval | upsertSelfAssessment | approveEval | getSettings | setSettings | listAudit | adminLogin | changeAdminPassword",
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
delivered, onTime, firstDraftAccepted, contentRevisionRounds, scopeRevisionRounds, collaborators[{employeeId,sharePercent}],
isRevision, revisionOfWorkId, link, notes, createdBy, createdAt, updatedAt`

- `workCategory`: أحد 23 نوعًا ثابتًا (انظر `WORK_CATEGORIES` في main.js) أو `"أخرى"` مع `customCategory` نصًا حرًا.
- `isRevision`/`revisionOfWorkId`: إذا كان هذا العمل مراجعة/تحديثًا لعمل سابق، يُحتسب بقيمة `revisionValueMultiplier` بدل قيمة كاملة في: (أ) مؤشر "عدد الأعمال الموكلة" المرجعي، (ب) متوسط معايير ركيزة الجودة. لا يؤثر على أي مقياس آخر (عدد المشاريع، عدد أنواع النصوص، نسب الانضباط/رضا العميل).

### BehavioralLog
`id, employeeId, quarter, indicator(brainstorming|knowledge_sharing|initiative), description, date, loggedBy, createdAt`

### EvalScores
`id, employeeId, quarter, evaluatorId, status(draft|submitted|approved), pillarScores{pillarId:{criteriaScores:{critId:score}, comment}},
selfAssessment{critId:score}, managerAudit{critId:score, note}, totalScore, classification, approvedBy, approvedAt, comments, createdAt, updatedAt`

### Settings (صف واحد JSON)
`pillars[], classification[], revisionValueMultiplier` — قابل للتعديل بالكامل من شاشة الإعدادات (إدارة فقط).
كل ركيزة فيها `category(technical|behavioral)` يحدّد قسمها في لوحة الكاتب، و`weightWriter`/`weightSenior` — الركيزة ذات وزن 0 لمستوى معيّن تُستبعد كليًا (لا تُعرض، لا تُطلب من المقيّم، لا تدخل حساب الاكتمال) لذلك المستوى، كحال ركيزة `leadership` مع الكاتب العادي.

### AuditLog
`id, timestamp, actorRole, actorName, action, targetType, targetId, details`

## قواعد الخصوصية (تُطبَّق في الخادم لا في الواجهة فقط)
- **كاتب**: يرى وي‌عدّل فقط صفوفه الخاصة (`employeeId == self`) في WorkLog/BehavioralLog، ويقرأ EvalScores الخاصة به فقط إذا `status == approved`، ويكتب فقط `selfAssessment`.
- **مقيّم**: يرى ويعدّل صفوف موظفيه المباشرين فقط (`managerId == self`) + صفوفه هو كـ"كاتب" إن كان يملك صفة كاتب أيضًا.
- **إدارة عامة**: صلاحية كاملة على Employees/Settings/AuditLog، لكن **لا** تحصل على تفاصيل EvalScores (المعايير والتعليقات) إلا إذا أرفقت أيضًا كود المقيّم صاحب العلاقة ضمن `auth.code` — فقط الحالة/الإجمالي/التصنيف تظهر لها للمتابعة.
