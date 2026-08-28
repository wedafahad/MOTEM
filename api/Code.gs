/**
 * نظام «متم» — خادم الإنتاج الحقيقي (Google Apps Script + Google Sheets)
 * يطابق تمامًا عقد api/contract.md ومنطق api/mock_server.py الذي اختُبر محليًا بالكامل.
 *
 * خطوات النشر: راجعي README.md في جذر المشروع.
 */

// ============================= الإعداد العام =============================

const SHEET_NAMES = {
  EMPLOYEES: "Employees",
  WORKLOG: "WorkLog",
  BEHAVIORAL: "BehavioralLog",
  EVAL: "EvalScores",
  SETTINGS: "Settings",
  AUDIT: "AuditLog",
  DOCUMENTS: "Documents",
};

const HEADERS = {
  Employees: ["id", "name", "isWriter", "isEvaluator", "level", "specialty", "managerId",
    "writerCode", "evaluatorCode", "active", "createdAt", "updatedAt", "canFinalApprove"],
  WorkLog: ["id", "employeeId", "title", "workType", "quarter", "date", "project", "workCategory", "customCategory", "actionType",
    "isRevision", "revisionOfWorkId",
    "delivered", "onTime", "firstDraftAccepted", "contentRevisionRounds", "scopeRevisionRounds", "collaboratorsJSON",
    "link", "notes", "createdBy", "createdAt", "updatedAt",
    "socialSubType", "isCollaborative", "socialSubTypesJSON"],
  BehavioralLog: ["id", "employeeId", "quarter", "indicator", "description", "date", "loggedBy", "createdAt"],
  EvalScores: ["id", "employeeId", "quarter", "evaluatorId", "status", "pillarScoresJSON",
    "selfAssessmentJSON", "managerAuditJSON", "totalScore", "classification", "approvedBy",
    "approvedAt", "comments", "createdAt", "updatedAt",
    "selfAssessmentStatus", "selfAssessmentSubmittedAt"],
  Settings: ["key", "value"],
  AuditLog: ["id", "timestamp", "actorRole", "actorName", "action", "targetType", "targetId", "details"],
  Documents: ["id", "employeeId", "docType", "fileName", "mimeType", "driveFileId", "driveUrl",
    "status", "reviewedBy", "reviewNote", "uploadedAt", "updatedAt"],
};

// مرحلة ٤ — توثيق الكاتب: أنواع المستندات الداعمة المرتبطة بمعايير تقييم فعلية (لا تدخل الحساب تلقائيًا).
const DOCUMENT_TYPES = ["course", "initiative", "interaction"];

const JSON_COLUMNS = {
  WorkLog: { collaboratorsJSON: "collaborators", socialSubTypesJSON: "socialSubTypes" },
  EvalScores: { pillarScoresJSON: "pillarScores", selfAssessmentJSON: "selfAssessment", managerAuditJSON: "managerAudit" },
};

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return Utilities.getUuid();
}

// ============================= طبقة الوصول للجداول =============================

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADERS[name]);
    sheet.setFrozenRows(1);
    return sheet;
  }
  ensureHeaders_(sheet, HEADERS[name] || []);
  return sheet;
}

/** ترقية آمنة للأوراق الموجودة مسبقًا: أي عمود أُضيف لاحقًا إلى HEADERS (كـ canFinalApprove) ولم يكن
 * موجودًا فعليًا في صف العناوين بالشيت يُضاف تلقائيًا في نهاية الصف — بلا مساس بالأعمدة/البيانات الحالية.
 * بدون هذا، upsertRow_ يكتب بعدد أعمدة HEADERS بينما readAll_ يقرأ عناوين الأعمدة من الشيت الفعلي،
 * فيضيع أي عمود جديد بصمت (يُقرأ باسم "" بدل اسمه الصحيح). */
function ensureHeaders_(sheet, expectedHeaders) {
  if (!expectedHeaders.length) return;
  const lastCol = sheet.getLastColumn();
  const currentHeaders = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = expectedHeaders.filter((h) => currentHeaders.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
  }
}

function rowToObject_(sheetName, headers, rowValues) {
  const obj = {};
  const jsonCols = JSON_COLUMNS[sheetName] || {};
  headers.forEach((h, i) => {
    let v = rowValues[i];
    if (jsonCols[h]) {
      const outKey = jsonCols[h];
      try { obj[outKey] = v ? JSON.parse(v) : ((outKey === "collaborators" || outKey === "socialSubTypes") ? [] : {}); }
      catch (e) { obj[outKey] = (outKey === "collaborators" || outKey === "socialSubTypes") ? [] : {}; }
      return;
    }
    if (v === "") v = null;
    if (v === "TRUE" || v === true) v = true;
    else if (v === "FALSE" || v === false) v = false;
    obj[h] = v;
  });
  return obj;
}

function objectToRow_(sheetName, headers, obj) {
  const jsonCols = JSON_COLUMNS[sheetName] || {};
  return headers.map((h) => {
    if (jsonCols[h]) {
      const inKey = jsonCols[h];
      return JSON.stringify(obj[inKey] !== undefined ? obj[inKey] : ((inKey === "collaborators" || inKey === "socialSubTypes") ? [] : {}));
    }
    const v = obj[h];
    if (v === undefined || v === null) return "";
    return v;
  });
}

// كل استدعاء API يقرأ الشيت كاملًا من الصفر (لا توجد ذاكرة بين تنفيذين منفصلين لـ Apps Script) —
// هذا هو السبب الحقيقي لبطء ظهور الصفحات المتبقي بعد إصلاحات الواجهة: كل صفحة تقريبًا تستدعي
// listEmployees/getSettings، وكلاهما نادر التغيّر نسبيًا. نخزّنهما في CacheService (يبقى بين
// التنفيذات، بعكس المتغيرات العادية) لمدة قصيرة، ونُبطِله فورًا عند أي كتابة على نفس الشيت.
const CACHE_TTL_SECONDS = 60;
const CACHEABLE_SHEETS = { Employees: true, Settings: true };

function cacheKeyForSheet_(sheetName) { return "sheet_v1_" + sheetName; }

function invalidateSheetCache_(sheetName) {
  if (!CACHEABLE_SHEETS[sheetName]) return;
  try { CacheService.getScriptCache().remove(cacheKeyForSheet_(sheetName)); } catch (e) { /* تجاهل فشل الكاش — لا يجب أن يوقف الكتابة الفعلية */ }
}

function readAll_(sheetName) {
  const cacheable = !!CACHEABLE_SHEETS[sheetName];
  if (cacheable) {
    try {
      const cached = CacheService.getScriptCache().get(cacheKeyForSheet_(sheetName));
      if (cached) return JSON.parse(cached);
    } catch (e) { /* تجاهل أي عطل بالكاش وأكملي بالقراءة الفعلية من الشيت */ }
  }
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  let rows = [];
  if (values.length >= 2) {
    const headers = values[0];
    rows = values.slice(1)
      .filter((row) => row.some((c) => c !== ""))
      .map((row) => rowToObject_(sheetName, headers, row));
  }
  if (cacheable) {
    try { CacheService.getScriptCache().put(cacheKeyForSheet_(sheetName), JSON.stringify(rows), CACHE_TTL_SECONDS); }
    catch (e) { /* قد تتجاوز البيانات حد حجم الكاش (100K) لو كبر الفريق كثيرًا جدًا — نتجاهل الكاش حينها بصمت */ }
  }
  return rows;
}

function upsertRow_(sheetName, obj, idField) {
  idField = idField || "id";
  const sheet = getSheet_(sheetName);
  const headers = HEADERS[sheetName];
  const values = sheet.getDataRange().getValues();
  const idCol = headers.indexOf(idField);
  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] === obj[idField]) {
      const rowArr = objectToRow_(sheetName, headers, obj);
      sheet.getRange(r + 1, 1, 1, headers.length).setValues([rowArr]);
      invalidateSheetCache_(sheetName);
      return obj;
    }
  }
  const rowArr = objectToRow_(sheetName, headers, obj);
  sheet.appendRow(rowArr);
  invalidateSheetCache_(sheetName);
  return obj;
}

function deleteRow_(sheetName, id, idField) {
  idField = idField || "id";
  const sheet = getSheet_(sheetName);
  const headers = HEADERS[sheetName];
  const values = sheet.getDataRange().getValues();
  const idCol = headers.indexOf(idField);
  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] === id) {
      sheet.deleteRow(r + 1);
      invalidateSheetCache_(sheetName);
      return true;
    }
  }
  return false;
}

function findOne_(sheetName, predicate) {
  return readAll_(sheetName).find(predicate) || null;
}

// ============================= الإعدادات (Settings) =============================

function getSettings_() {
  const rows = readAll_(SHEET_NAMES.SETTINGS);
  const row = rows.find((r) => r.key === "config");
  if (!row || !row.value) {
    const seeded = DEFAULT_SETTINGS_();
    upsertRow_(SHEET_NAMES.SETTINGS, { key: "config", value: JSON.stringify(seeded) }, "key");
    return seeded;
  }
  let settings;
  try {
    settings = JSON.parse(row.value);
  } catch (e) {
    settings = DEFAULT_SETTINGS_();
    upsertRow_(SHEET_NAMES.SETTINGS, { key: "config", value: JSON.stringify(settings) }, "key");
    return settings;
  }
  // ترميم ذاتي: حالة تكون فيها pillars/classification مفقودة أو فاسدة أو فارغة (خلية فاضية، حذف
  // غير مقصود، JSON تالف جزئيًا) تُرجع للقيم الافتراضية وتُحفَظ، دون المساس بأي حقل آخر سليم.
  let healed = false;
  if (!Array.isArray(settings.pillars) || settings.pillars.length === 0) {
    settings.pillars = DEFAULT_SETTINGS_().pillars;
    healed = true;
  }
  if (!Array.isArray(settings.classification) || settings.classification.length === 0) {
    settings.classification = DEFAULT_SETTINGS_().classification;
    healed = true;
  }
  if (healed) {
    upsertRow_(SHEET_NAMES.SETTINGS, { key: "config", value: JSON.stringify(settings) }, "key");
  }
  return settings;
}

function setSettings_(settings) {
  upsertRow_(SHEET_NAMES.SETTINGS, { key: "config", value: JSON.stringify(settings) }, "key");
  return settings;
}

// ============================= تدقيق (Audit) =============================

function audit_(actorRole, actorName, action, targetType, targetId, details) {
  upsertRow_(SHEET_NAMES.AUDIT, {
    id: newId(), timestamp: nowIso(), actorRole: actorRole, actorName: actorName,
    action: action, targetType: targetType, targetId: targetId, details: details || "",
  });
}

// ============================= المصادقة والصلاحيات =============================

class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code || 400; }
}

function findEmployeeByCode_(code) {
  if (!code) return null;
  return findOne_(SHEET_NAMES.EMPLOYEES, (e) => e.writerCode === code || e.evaluatorCode === code);
}

function directReports_(evaluatorId) {
  return readAll_(SHEET_NAMES.EMPLOYEES).filter((e) => e.managerId === evaluatorId);
}

function downlineIds_(rootId) {
  const ids = {};
  let frontier = [rootId];
  while (frontier.length) {
    const current = frontier.pop();
    directReports_(current).forEach((r) => {
      if (!ids[r.id]) { ids[r.id] = true; frontier.push(r.id); }
    });
  }
  return Object.keys(ids);
}

function resolveActor_(auth) {
  auth = auth || {};
  if (auth.admin) {
    const settings = getSettings_();
    if (auth.password !== settings.adminPassword) throw new ApiError("كلمة مرور الإدارة غير صحيحة", 401);
    return { isAdmin: true, isOrgAdmin: true, employee: null, asWriter: false, asEvaluator: false };
  }
  const emp = findEmployeeByCode_(auth.code);
  if (!emp || emp.active === false) throw new ApiError("الكود غير صحيح أو الحساب غير مُفعّل", 401);
  // دمج 2.2: "المدير" (أعلى مقيّم في التسلسل الهرمي — بلا مدير فوقه) يكتسب صلاحيات
  // الإدارة العامة التشغيلية (الموظفون/المعايير والأوزان/سجل التعديلات) إضافةً لما يملكه أصلًا
  // كمقيّم. هذا لا يُغيّر actor.isAdmin (الذي يبقى محصورًا بكلمة مرور الإدارة العامة وحدها)
  // حتى لا تنكسر خصوصية تفاصيل التقييمات (canSeeEvalDetail_ / handleListEval_ تعتمدان على
  // asEvaluator + downlineIds_، لا على isOrgAdmin، فتبقى رؤية المدير لتفاصيل تقييمات فريقه كما هي).
  const isTopManager = !!(emp.isEvaluator && !emp.managerId);
  // إصلاح: الصلاحيات تُبنى على صفات الموظف الفعلية (isWriter/isEvaluator)، لا على أي كود بعينه استُخدم
  // للدخول — موظف يحمل الصفتين معًا (كاتب + مقيّم) يحصل على كل صلاحياته بأي من كوديه.
  return {
    isAdmin: false,
    isOrgAdmin: isTopManager,
    employee: emp,
    asWriter: !!emp.isWriter,
    asEvaluator: !!emp.isEvaluator,
  };
}

// ============================= المعالِجات (Handlers) =============================

function handleLogin_(payload) {
  const emp = findEmployeeByCode_(payload.code);
  if (!emp || emp.active === false) throw new ApiError("الكود غير صحيح", 401);
  const clean = {};
  Object.keys(emp).forEach((k) => { if (k !== "writerCode" && k !== "evaluatorCode") clean[k] = emp[k]; });
  return {
    employee: clean,
    asWriter: !!emp.isWriter,
    asEvaluator: !!emp.isEvaluator,
  };
}

function handleAdminLogin_(payload) {
  const settings = getSettings_();
  if (payload.password !== settings.adminPassword) throw new ApiError("كلمة المرور غير صحيحة", 401);
  return { ok: true };
}

function handleListEmployees_(actor) {
  let rows;
  if (actor.isAdmin) {
    rows = readAll_(SHEET_NAMES.EMPLOYEES);
  } else if (actor.asEvaluator) {
    const downline = downlineIds_(actor.employee.id);
    rows = readAll_(SHEET_NAMES.EMPLOYEES).filter((e) => e.id === actor.employee.id || downline.indexOf(e.id) !== -1);
  } else {
    rows = [actor.employee];
  }
  return rows.map((e) => {
    const clean = {};
    Object.keys(e).forEach((k) => { if (k !== "writerCode" && k !== "evaluatorCode") clean[k] = e[k]; });
    if (actor.isAdmin || actor.isOrgAdmin || (actor.employee && actor.employee.id === e.id)) {
      clean.writerCode = e.writerCode; clean.evaluatorCode = e.evaluatorCode;
    }
    return clean;
  });
}

function handleUpsertEmployee_(actor, payload) {
  if (!actor.isOrgAdmin) throw new ApiError("فقط الإدارة العامة أو المدير تديران الموظفين", 403);
  const actorRole = actor.isAdmin ? "admin" : "manager";
  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  const row = payload.row;
  const existing = row.id ? findOne_(SHEET_NAMES.EMPLOYEES, (e) => e.id === row.id) : null;
  if (existing) {
    const merged = Object.assign({}, existing, row, { updatedAt: nowIso() });
    upsertRow_(SHEET_NAMES.EMPLOYEES, merged);
    audit_(actorRole, actorName, "تعديل موظف", "Employee", merged.id, merged.name);
    return merged;
  }
  row.id = row.id || newId();
  if (row.active === undefined) row.active = true;
  row.createdAt = nowIso(); row.updatedAt = nowIso();
  upsertRow_(SHEET_NAMES.EMPLOYEES, row);
  audit_(actorRole, actorName, "إضافة موظف", "Employee", row.id, row.name);
  return row;
}

function handleDeleteEmployee_(actor, payload) {
  if (!actor.isOrgAdmin) throw new ApiError("فقط الإدارة العامة أو المدير يحذفان الموظفين", 403);
  const emp = findOne_(SHEET_NAMES.EMPLOYEES, (e) => e.id === payload.id);
  deleteRow_(SHEET_NAMES.EMPLOYEES, payload.id);
  audit_(actor.isAdmin ? "admin" : "manager", actor.isAdmin ? "الإدارة" : actor.employee.name, "حذف موظف", "Employee", payload.id, emp ? emp.name : "");
  return { deleted: payload.id };
}

/** نطاق الكتابة (upsert/delete) — التقارير المباشرة فقط. */
function ownedWorkIds_(actor) {
  if (actor.isAdmin) return null;
  const ids = {};
  if (actor.asWriter) ids[actor.employee.id] = true;
  if (actor.asEvaluator) directReports_(actor.employee.id).forEach((r) => { ids[r.id] = true; });
  return ids;
}

/** نطاق القراءة (list) — أوسع: يشمل كل التسلسل الهرمي تحت المقيّم (downline)، لتمكين المراجعة/الاعتماد على المستوى الثاني. */
function readableWorkIds_(actor) {
  if (actor.isAdmin) return null;
  const ids = {};
  if (actor.asWriter) ids[actor.employee.id] = true;
  if (actor.asEvaluator) downlineIds_(actor.employee.id).forEach((id) => { ids[id] = true; });
  return ids;
}

function handleListWork_(actor, payload) {
  const allowed = readableWorkIds_(actor);
  let rows = readAll_(SHEET_NAMES.WORKLOG);
  if (allowed) rows = rows.filter((r) => allowed[r.employeeId]);
  if (payload.quarter) rows = rows.filter((r) => r.quarter === payload.quarter);
  if (payload.employeeId) rows = rows.filter((r) => r.employeeId === payload.employeeId);
  return rows;
}

function handleUpsertWork_(actor, payload) {
  const row = payload.row;
  const allowed = ownedWorkIds_(actor);
  if (allowed && !allowed[row.employeeId]) throw new ApiError("لا تملك صلاحية تعديل أعمال هذا الموظف", 403);
  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  const existing = row.id ? findOne_(SHEET_NAMES.WORKLOG, (r) => r.id === row.id) : null;
  if (existing) {
    const merged = Object.assign({}, existing, row, { updatedAt: nowIso() });
    upsertRow_(SHEET_NAMES.WORKLOG, merged);
    audit_("-", actorName, "تعديل عمل", "WorkLog", merged.id, merged.title);
    return merged;
  }
  row.id = row.id || newId();
  row.createdBy = actorName; row.createdAt = nowIso(); row.updatedAt = nowIso();
  upsertRow_(SHEET_NAMES.WORKLOG, row);
  audit_("-", actorName, "إضافة عمل", "WorkLog", row.id, row.title);
  return row;
}

function handleDeleteWork_(actor, payload) {
  const allowed = ownedWorkIds_(actor);
  const row = findOne_(SHEET_NAMES.WORKLOG, (r) => r.id === payload.id);
  if (!row) throw new ApiError("العمل غير موجود", 404);
  if (allowed && !allowed[row.employeeId]) throw new ApiError("لا تملك صلاحية حذف هذا العمل", 403);
  deleteRow_(SHEET_NAMES.WORKLOG, payload.id);
  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  audit_("-", actorName, "حذف عمل", "WorkLog", payload.id, row.title);
  return { deleted: payload.id };
}

function handleListBehavioral_(actor, payload) {
  const allowed = readableWorkIds_(actor);
  let rows = readAll_(SHEET_NAMES.BEHAVIORAL);
  if (allowed) rows = rows.filter((r) => allowed[r.employeeId]);
  if (payload.quarter) rows = rows.filter((r) => r.quarter === payload.quarter);
  if (payload.employeeId) rows = rows.filter((r) => r.employeeId === payload.employeeId);
  return rows;
}

function handleUpsertBehavioral_(actor, payload) {
  const row = payload.row;
  const allowed = ownedWorkIds_(actor);
  if (allowed && !allowed[row.employeeId]) throw new ApiError("لا تملك صلاحية هذا الإجراء", 403);
  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  const existing = row.id ? findOne_(SHEET_NAMES.BEHAVIORAL, (r) => r.id === row.id) : null;
  if (existing) {
    const merged = Object.assign({}, existing, row);
    upsertRow_(SHEET_NAMES.BEHAVIORAL, merged);
    audit_("-", actorName, "تعديل واقعة سلوكية", "BehavioralLog", merged.id, "");
    return merged;
  }
  row.id = row.id || newId(); row.loggedBy = actorName; row.createdAt = nowIso();
  upsertRow_(SHEET_NAMES.BEHAVIORAL, row);
  audit_("-", actorName, "إضافة واقعة سلوكية", "BehavioralLog", row.id, row.description || "");
  return row;
}

function handleDeleteBehavioral_(actor, payload) {
  const allowed = ownedWorkIds_(actor);
  const row = findOne_(SHEET_NAMES.BEHAVIORAL, (r) => r.id === payload.id);
  if (!row) throw new ApiError("غير موجود", 404);
  if (allowed && !allowed[row.employeeId]) throw new ApiError("لا تملك صلاحية الحذف", 403);
  deleteRow_(SHEET_NAMES.BEHAVIORAL, payload.id);
  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  audit_("-", actorName, "حذف واقعة سلوكية", "BehavioralLog", payload.id, "");
  return { deleted: payload.id };
}

function redactEval_(row) {
  return { id: row.id, employeeId: row.employeeId, quarter: row.quarter, evaluatorId: row.evaluatorId,
    status: row.status, totalScore: row.totalScore, classification: row.classification };
}

function canSeeEvalDetail_(actor, row) {
  if (actor.isAdmin) return false;
  const me = actor.employee;
  if (actor.asWriter && row.employeeId === me.id) return row.status === "approved";
  if (actor.asEvaluator && row.evaluatorId === me.id) return true;
  // أي مقيّم أعلى هرميًا من المقيّم صاحب التقييم (مو فقط مديره المباشر) يرى التفاصيل — يشمل التقييم
  // الذاتي مقارنة بتقييم المقيّم لأي مستوى إداري أعلى (مدير المدير وهكذا)، لا مستوى واحد فقط.
  if (actor.asEvaluator && downlineIds_(me.id).indexOf(row.evaluatorId) !== -1) return true;
  return false;
}

/** الكاتب يرى تقييمه الذاتي دائمًا؛ المقيّم لا يرى تفاصيله إلا بعد أن يعتمده الكاتب (selfAssessmentStatus === "submitted"). */
function withSelfAssessmentVisibility_(actor, row) {
  const isOwnerWriter = actor.asWriter && actor.employee && row.employeeId === actor.employee.id;
  if (isOwnerWriter) return row;
  if (row.selfAssessmentStatus === "submitted") return row;
  return { ...row, selfAssessment: {} };
}

function handleListEval_(actor, payload) {
  let rows = readAll_(SHEET_NAMES.EVAL);
  if (payload.quarter) rows = rows.filter((r) => r.quarter === payload.quarter);
  if (payload.employeeId) rows = rows.filter((r) => r.employeeId === payload.employeeId);

  if (actor.isAdmin) return rows.map(redactEval_);

  const me = actor.employee;
  const myDownline = actor.asEvaluator ? downlineIds_(me.id) : [];
  const visible = [];
  rows.forEach((r) => {
    const isOwnerWriter = actor.asWriter && r.employeeId === me.id;
    const isOwnerEval = actor.asEvaluator && (r.evaluatorId === me.id || myDownline.indexOf(r.employeeId) !== -1);
    if (!isOwnerWriter && !isOwnerEval) return;
    if (canSeeEvalDetail_(actor, r)) visible.push(withSelfAssessmentVisibility_(actor, r));
    else if (isOwnerWriter) { /* غير معتمد بعد -> لا يظهر إطلاقًا للكاتب */ }
    else visible.push(redactEval_(r));
  });
  return visible;
}

function handleUpsertEval_(actor, payload) {
  if (!actor.asEvaluator) throw new ApiError("فقط المقيّم يسجّل التقييم", 403);
  const row = payload.row;
  const me = actor.employee;
  const reportIds = directReports_(me.id).map((d) => d.id);
  if (reportIds.indexOf(row.employeeId) === -1) throw new ApiError("لا تقيّم إلا فريقك المباشر", 403);
  row.evaluatorId = me.id;
  const existing = findOne_(SHEET_NAMES.EVAL, (r) => r.employeeId === row.employeeId && r.quarter === row.quarter);
  if (existing) {
    const merged = Object.assign({}, existing, row, { id: existing.id, updatedAt: nowIso() });
    upsertRow_(SHEET_NAMES.EVAL, merged);
    audit_("evaluator", me.name, "تحديث تقييم", "EvalScores", merged.id, row.status || "");
    return merged;
  }
  row.id = row.id || newId(); row.createdAt = nowIso(); row.updatedAt = nowIso();
  upsertRow_(SHEET_NAMES.EVAL, row);
  audit_("evaluator", me.name, "إنشاء تقييم", "EvalScores", row.id, row.status || "");
  return row;
}

function handleUpsertSelfAssessment_(actor, payload) {
  if (!actor.asWriter) throw new ApiError("فقط الكاتب يسجّل تقييمه الذاتي", 403);
  const me = actor.employee;
  const quarter = payload.quarter;
  let existing = findOne_(SHEET_NAMES.EVAL, (r) => r.employeeId === me.id && r.quarter === quarter);
  if (existing && existing.selfAssessmentStatus === "submitted") {
    throw new ApiError("تقييمك الذاتي مُعتمَد بالفعل ولا يمكن تعديله لهذا الربع", 403);
  }
  if (!existing) {
    existing = { id: newId(), employeeId: me.id, quarter: quarter, evaluatorId: me.managerId,
      status: "draft", pillarScores: {}, selfAssessment: {}, managerAudit: {},
      selfAssessmentStatus: "draft", selfAssessmentSubmittedAt: null,
      totalScore: null, classification: null, createdAt: nowIso() };
  }
  existing.selfAssessment = payload.selfAssessment;
  existing.updatedAt = nowIso();
  upsertRow_(SHEET_NAMES.EVAL, existing);
  audit_("writer", me.name, "تحديث التقييم الذاتي", "EvalScores", existing.id, "");
  return existing;
}

/** يقفل التقييم الذاتي نهائيًا لهذا الربع — بعدها لا يقبل upsertSelfAssessment أي تعديل، ويصبح مرئيًا كاملًا للمقيّم. */
function handleSubmitSelfAssessment_(actor, payload) {
  if (!actor.asWriter) throw new ApiError("فقط الكاتب يعتمد تقييمه الذاتي", 403);
  const me = actor.employee;
  const quarter = payload.quarter;
  const existing = findOne_(SHEET_NAMES.EVAL, (r) => r.employeeId === me.id && r.quarter === quarter);
  if (!existing || !existing.selfAssessment || !Object.keys(existing.selfAssessment).length) {
    throw new ApiError("سجّل تقييمك الذاتي أولًا قبل الاعتماد", 400);
  }
  if (existing.selfAssessmentStatus === "submitted") {
    throw new ApiError("تقييمك الذاتي مُعتمَد بالفعل", 400);
  }
  existing.selfAssessmentStatus = "submitted";
  existing.selfAssessmentSubmittedAt = nowIso();
  existing.updatedAt = nowIso();
  upsertRow_(SHEET_NAMES.EVAL, existing);
  audit_("writer", me.name, "اعتماد التقييم الذاتي", "EvalScores", existing.id, "");
  return existing;
}

function handleApproveEval_(actor, payload) {
  const row = findOne_(SHEET_NAMES.EVAL, (r) => r.id === payload.id);
  if (!row) throw new ApiError("التقييم غير موجود", 404);
  let allowed = false, actorName = "";
  if (actor.isAdmin) {
    allowed = true; actorName = "الإدارة";
  } else if (actor.isOrgAdmin) {
    // المدير (أعلى الهرم) يعتمد أي تقييم مباشرة — بما فيها تقييمات موظفيه المباشرين، حيث لا يوجد
    // أصلًا "مدير للمقيّم" فوقه ليعتمد بالطريقة القديمة (كان هذا يمنع اعتماد تقييم وداد مثلًا).
    allowed = true; actorName = actor.employee.name;
  } else if (actor.asEvaluator) {
    const evaluator = findOne_(SHEET_NAMES.EMPLOYEES, (e) => e.id === row.evaluatorId);
    if (evaluator && evaluator.managerId === actor.employee.id) {
      allowed = true; actorName = actor.employee.name;
    } else if (row.evaluatorId === actor.employee.id && actor.employee.canFinalApprove) {
      // تفويض صريح من المدير (Employee.canFinalApprove) — مقيّم يعتمد تقييمات فريقه بنفسه دون العودة لمديره
      allowed = true; actorName = actor.employee.name;
    }
  }
  if (!allowed) throw new ApiError("لا تملك صلاحية اعتماد هذا التقييم", 403);
  row.status = "approved"; row.approvedBy = actorName; row.approvedAt = nowIso();
  upsertRow_(SHEET_NAMES.EVAL, row);
  audit_("-", actorName, "اعتماد تقييم", "EvalScores", payload.id, row.employeeId);
  return row;
}

function handleGetSettings_() { return getSettings_(); }

function handleSetSettings_(actor, payload) {
  if (!actor.isOrgAdmin) throw new ApiError("فقط الإدارة العامة أو المدير يعدّلان الإعدادات", 403);
  const current = getSettings_();
  const next = payload.settings;
  if (!next || !Array.isArray(next.pillars) || next.pillars.length === 0) {
    throw new ApiError("رفض الحفظ: الإعدادات المُرسَلة لا تحتوي ركائز تقييم صالحة (pillars فارغة أو مفقودة)", 400);
  }
  next.adminPassword = current.adminPassword;
  setSettings_(next);
  audit_(actor.isAdmin ? "admin" : "manager", actor.isAdmin ? "الإدارة" : actor.employee.name, "تحديث إعدادات المعايير", "Settings", "-", "");
  return next;
}

function handleChangeAdminPassword_(actor, payload) {
  if (!actor.isAdmin) throw new ApiError("غير مصرّح", 403);
  const settings = getSettings_();
  settings.adminPassword = payload.newPassword;
  setSettings_(settings);
  audit_("admin", "الإدارة", "تغيير كلمة مرور الإدارة", "Settings", "-", "");
  return { ok: true };
}

function handleListAudit_(actor) {
  if (!actor.isOrgAdmin) throw new ApiError("فقط الإدارة العامة أو المدير يريان سجل التعديلات", 403);
  return readAll_(SHEET_NAMES.AUDIT).reverse();
}

// ============================= مرحلة ٤ — مستندات الكاتب (توثيق داعم) =============================
// نفس نمط الخصوصية المطبَّق على WorkLog: الكاتب يرى مستنداته فقط، والمقيّم يرى مستندات تقاريره المباشرين
// ويعتمدها، ونطاق القراءة الأوسع (downline) متاح فقط عبر readableWorkIds_ إن احتجناه لاحقًا للمراجعة الموسّعة.

const DOCUMENTS_FOLDER_PROP = "DOCUMENTS_FOLDER_ID";
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 8MB بعد فك ترميز base64

function getOrCreateDocumentsFolder_() {
  const props = PropertiesService.getScriptProperties();
  const existingId = props.getProperty(DOCUMENTS_FOLDER_PROP);
  if (existingId) {
    try { return DriveApp.getFolderById(existingId); } catch (e) { /* المجلد حُذف يدويًا — أنشئي واحدًا جديدًا */ }
  }
  const folder = DriveApp.createFolder("متم — مستندات الكتّاب");
  props.setProperty(DOCUMENTS_FOLDER_PROP, folder.getId());
  return folder;
}

function saveDocumentFile_(fileName, mimeType, dataBase64) {
  const bytes = Utilities.base64Decode(dataBase64);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new ApiError("حجم الملف يتجاوز الحد الأقصى (8MB)", 400);
  const blob = Utilities.newBlob(bytes, mimeType || "application/octet-stream", fileName || "مستند");
  const folder = getOrCreateDocumentsFolder_();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { driveFileId: file.getId(), driveUrl: file.getUrl() };
}

/** الكاتب يرى مستنداته فقط. المقيّم يرى مستندات تقاريره المباشرين + مستنداته هو إن كان كاتبًا أيضًا. */
function handleListDocuments_(actor, payload) {
  const targetEmployeeId = payload && payload.employeeId;
  let rows = readAll_(SHEET_NAMES.DOCUMENTS);
  if (actor.isAdmin) {
    return targetEmployeeId ? rows.filter((r) => r.employeeId === targetEmployeeId) : rows;
  }
  const allowedIds = {};
  if (actor.asWriter) allowedIds[actor.employee.id] = true;
  if (actor.asEvaluator) directReports_(actor.employee.id).forEach((r) => { allowedIds[r.id] = true; });
  if (targetEmployeeId && !allowedIds[targetEmployeeId]) throw new ApiError("لا تملكين صلاحية الاطّلاع على مستندات هذا الموظف", 403);
  rows = rows.filter((r) => allowedIds[r.employeeId]);
  return targetEmployeeId ? rows.filter((r) => r.employeeId === targetEmployeeId) : rows;
}

/** الكاتب يرفع لنفسه فقط، والمقيّم يرفع لأي عضو من تقاريره المباشرة. */
function handleUploadDocument_(actor, payload) {
  const employeeId = payload.employeeId;
  if (!employeeId) throw new ApiError("الموظف مطلوب", 400);
  const isSelf = actor.asWriter && actor.employee.id === employeeId;
  const isDirectReport = actor.asEvaluator && directReports_(actor.employee.id).some((r) => r.id === employeeId);
  if (!actor.isAdmin && !isSelf && !isDirectReport) throw new ApiError("لا تملكين صلاحية الرفع لهذا الموظف", 403);
  if (DOCUMENT_TYPES.indexOf(payload.docType) === -1) throw new ApiError("نوع مستند غير صالح", 400);
  if (!payload.dataBase64) throw new ApiError("الملف مطلوب", 400);
  const saved = saveDocumentFile_(payload.fileName, payload.mimeType, payload.dataBase64);
  const now = nowIso();
  const row = {
    id: newId(), employeeId: employeeId, docType: payload.docType,
    fileName: payload.fileName || "مستند", mimeType: payload.mimeType || "",
    driveFileId: saved.driveFileId, driveUrl: saved.driveUrl,
    status: "pending", reviewedBy: "", reviewNote: "",
    uploadedAt: now, updatedAt: now,
  };
  upsertRow_(SHEET_NAMES.DOCUMENTS, row);
  audit_(actor.isAdmin ? "admin" : actor.isOrgAdmin ? "manager" : actor.asEvaluator ? "evaluator" : "writer",
    actor.isAdmin ? "الإدارة" : actor.employee.name, "رفع مستند", "Documents", row.id, row.fileName);
  return row;
}

function handleDeleteDocument_(actor, payload) {
  const doc = findOne_(SHEET_NAMES.DOCUMENTS, (d) => d.id === payload.id);
  if (!doc) throw new ApiError("المستند غير موجود", 404);
  const isOwner = actor.asWriter && actor.employee.id === doc.employeeId;
  const isDirectManager = actor.asEvaluator && directReports_(actor.employee.id).some((r) => r.id === doc.employeeId);
  if (!actor.isAdmin && !isOwner && !isDirectManager) throw new ApiError("لا تملكين صلاحية حذف هذا المستند", 403);
  try { if (doc.driveFileId) DriveApp.getFileById(doc.driveFileId).setTrashed(true); } catch (e) { /* الملف محذوف مسبقًا من Drive */ }
  deleteRow_(SHEET_NAMES.DOCUMENTS, payload.id);
  return { deleted: payload.id };
}

/** الاعتماد/الرفض حصري للمقيّم المباشر لصاحب المستند أو الإدارة/المدير. */
function handleReviewDocument_(actor, payload) {
  const doc = findOne_(SHEET_NAMES.DOCUMENTS, (d) => d.id === payload.id);
  if (!doc) throw new ApiError("المستند غير موجود", 404);
  const emp = findOne_(SHEET_NAMES.EMPLOYEES, (e) => e.id === doc.employeeId);
  const isDirectManager = actor.asEvaluator && emp && emp.managerId === actor.employee.id;
  if (!actor.isOrgAdmin && !isDirectManager) throw new ApiError("فقط المقيّم المباشر أو الإدارة/المدير يعتمدون المستندات", 403);
  if (["approved", "rejected"].indexOf(payload.status) === -1) throw new ApiError("حالة غير صالحة", 400);
  const merged = Object.assign({}, doc, {
    status: payload.status,
    reviewedBy: actor.isAdmin ? "الإدارة" : actor.employee.name,
    reviewNote: payload.note || "",
    updatedAt: nowIso(),
  });
  upsertRow_(SHEET_NAMES.DOCUMENTS, merged);
  audit_(actor.isAdmin ? "admin" : "manager", actor.isAdmin ? "الإدارة" : actor.employee.name,
    payload.status === "approved" ? "اعتماد مستند" : "رفض مستند", "Documents", doc.id, emp ? emp.name : doc.employeeId);
  return merged;
}

// ============================= موظف الربع — نشر بالاسم فقط (بديل بند 3.3 للموظفين) =============================
// نفس منطق categorySubtotal في docs/js/calc.js تمامًا لكن هنا سيرفريًا: يعمل على بيانات EvalScores الكاملة
// غير المُصفّاة (redactEval_) بصرف النظر عن هوية المُستدعي، لأن النشر لا يكشف أي رقم — الاسم فقط يخرج للخارج.
function computeCategorySubtotal_(row, employee, settings, category) {
  if (!row || !row.pillarScores) return null;
  const level = employee.level === "senior" ? "senior" : "writer";
  const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
  let weightedSum = 0, weightTotal = 0;
  settings.pillars.forEach((p) => {
    const w = p[weightKey] || 0;
    if (w === 0) return;
    const isBehavioral = p.category === "behavioral";
    if ((category === "behavioral") !== isBehavioral) return;
    const pr = row.pillarScores[p.id];
    const score = pr && pr.pillarScore;
    if (score === null || score === undefined) return;
    weightedSum += score * w;
    weightTotal += w;
  });
  return weightTotal > 0 ? weightedSum / weightTotal : null;
}

/** الإدارة العامة أو المدير (isOrgAdmin) ينشران على مستوى الشركة كاملة، وأي مقيّم آخر ينشر على
 * نطاق فريقه (تسلسله الهرمي/downline) فقط — نفس نطاق readableWorkIds_ المطبَّق على WorkLog/Documents. */
function topPerformerWritersScope_(actor) {
  const all = readAll_(SHEET_NAMES.EMPLOYEES).filter((e) => e.isWriter);
  if (actor.isAdmin || actor.isOrgAdmin) return all;
  const downline = downlineIds_(actor.employee.id);
  return all.filter((e) => downline.indexOf(e.id) !== -1 || e.id === actor.employee.id);
}

/** الإدارة العامة، المدير، وأي مقيّم يقررون النشر — كل ضمن نطاق فريقه (انظر topPerformerWritersScope_). */
function handlePublishTopPerformer_(actor, payload) {
  if (!actor.isOrgAdmin && !actor.asEvaluator) throw new ApiError("فقط الإدارة العامة أو المقيّم/المدير ينشرون هذا القسم", 403);
  const quarter = payload.quarter;
  if (!quarter) throw new ApiError("الربع مطلوب", 400);
  const settings = getSettings_();
  const writersById = {};
  topPerformerWritersScope_(actor).forEach((e) => { writersById[e.id] = e; });
  const evalRows = readAll_(SHEET_NAMES.EVAL).filter((r) => r.quarter === quarter && r.status === "approved" && writersById[r.employeeId]);

  const pickBest = (fn) => {
    let best = null;
    evalRows.forEach((r) => {
      const emp = writersById[r.employeeId];
      const value = fn(r, emp);
      if (value === null || value === undefined) return;
      if (!best || value > best.value) best = { employeeId: emp.id, name: emp.name, value: value };
    });
    return best ? { employeeId: best.employeeId, name: best.name } : null; // بالاسم فقط — لا رقم يخرج للنشر العام
  };

  const actorName = actor.isAdmin ? "الإدارة" : actor.employee.name;
  const actorRole = actor.isAdmin ? "admin" : actor.isOrgAdmin ? "manager" : "evaluator";
  const result = {
    quarter: quarter,
    technical: pickBest((r, e) => computeCategorySubtotal_(r, e, settings, "technical")),
    behavioral: pickBest((r, e) => computeCategorySubtotal_(r, e, settings, "behavioral")),
    overall: pickBest((r) => (r.totalScore === null || r.totalScore === undefined ? null : r.totalScore)),
    publishedBy: actorName,
    publishedAt: nowIso(),
  };
  settings.topPerformerPublished = result;
  setSettings_(settings);
  audit_(actorRole, actorName, "نشر موظف الربع", "System", quarter,
    [result.technical?.name, result.behavioral?.name, result.overall?.name].filter(Boolean).join(" / "));
  return result;
}

function handleUnpublishTopPerformer_(actor) {
  if (!actor.isOrgAdmin && !actor.asEvaluator) throw new ApiError("فقط الإدارة العامة أو المقيّم/المدير يلغون النشر", 403);
  const settings = getSettings_();
  settings.topPerformerPublished = null;
  setSettings_(settings);
  const actorRole = actor.isAdmin ? "admin" : actor.isOrgAdmin ? "manager" : "evaluator";
  audit_(actorRole, actor.isAdmin ? "الإدارة" : actor.employee.name, "إلغاء نشر موظف الربع", "System", "-", "");
  return { ok: true };
}

// ============================= التوزيع (Dispatch) =============================

// إجراءات القراءة فقط لا تحتاج قفلاً عامًا — قفلها كان يجبر كل الطلبات (حتى المتزامنة من نفس الصفحة)
// على الانتظار بالتتابع، وهو أحد أسباب بطء التحميل. القفل الآن يُستخدم فقط عند الكتابة الفعلية.
const READ_ONLY_ACTIONS_ = {
  listEmployees: true, listWork: true, listBehavioral: true, listEval: true,
  getSettings: true, listAudit: true, listDocuments: true,
};

function dispatch_(action, auth, payload) {
  payload = payload || {};
  const needsLock = action !== "login" && action !== "adminLogin" && !READ_ONLY_ACTIONS_[action];
  let lock = null;
  if (needsLock) {
    lock = LockService.getScriptLock();
    lock.waitLock(20000);
  }
  try {
    if (action === "login") return { ok: true, data: handleLogin_(payload) };
    if (action === "adminLogin") return { ok: true, data: handleAdminLogin_(payload) };

    const actor = resolveActor_(auth);
    let data;
    switch (action) {
      case "listEmployees": data = handleListEmployees_(actor); break;
      case "upsertEmployee": data = handleUpsertEmployee_(actor, payload); break;
      case "deleteEmployee": data = handleDeleteEmployee_(actor, payload); break;
      case "listWork": data = handleListWork_(actor, payload); break;
      case "upsertWork": data = handleUpsertWork_(actor, payload); break;
      case "deleteWork": data = handleDeleteWork_(actor, payload); break;
      case "listBehavioral": data = handleListBehavioral_(actor, payload); break;
      case "upsertBehavioral": data = handleUpsertBehavioral_(actor, payload); break;
      case "deleteBehavioral": data = handleDeleteBehavioral_(actor, payload); break;
      case "listEval": data = handleListEval_(actor, payload); break;
      case "upsertEval": data = handleUpsertEval_(actor, payload); break;
      case "upsertSelfAssessment": data = handleUpsertSelfAssessment_(actor, payload); break;
      case "submitSelfAssessment": data = handleSubmitSelfAssessment_(actor, payload); break;
      case "approveEval": data = handleApproveEval_(actor, payload); break;
      case "getSettings": data = handleGetSettings_(); break;
      case "setSettings": data = handleSetSettings_(actor, payload); break;
      case "changeAdminPassword": data = handleChangeAdminPassword_(actor, payload); break;
      case "listAudit": data = handleListAudit_(actor); break;
      case "publishTopPerformer": data = handlePublishTopPerformer_(actor, payload); break;
      case "unpublishTopPerformer": data = handleUnpublishTopPerformer_(actor); break;
      case "listDocuments": data = handleListDocuments_(actor, payload); break;
      case "uploadDocument": data = handleUploadDocument_(actor, payload); break;
      case "deleteDocument": data = handleDeleteDocument_(actor, payload); break;
      case "reviewDocument": data = handleReviewDocument_(actor, payload); break;
      default: throw new ApiError("إجراء غير معروف: " + action, 400);
    }
    return { ok: true, data: data };
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message };
    return { ok: false, error: "خطأ غير متوقع بالخادم: " + err.message };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { /* ignore */ }
  const result = dispatch_(body.action, body.auth, body.payload);
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: "motem Apps Script server up" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================= البذر الأولي (Seed) =============================

/** شغّلي هذه الدالة مرة واحدة يدويًا من محرر Apps Script بعد ربط الشيت الجديد، لتهيئة الأوراق وبذر الفريق. */
function setupInitialData() {
  Object.keys(SHEET_NAMES).forEach((k) => getSheet_(SHEET_NAMES[k]));

  const existing = readAll_(SHEET_NAMES.EMPLOYEES);
  if (existing.length > 0) {
    Logger.log("يوجد موظفون بالفعل — لن تُكرَّر عملية البذر. احذفي بيانات ورقة Employees يدويًا إن رغبتِ بالبدء من جديد.");
    return;
  }

  function genCode(prefix) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 4; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return prefix + "-" + out;
  }

  const now = nowIso();
  const team = [
    { id: "manager", name: "المدير", isWriter: false, isEvaluator: true, level: null, specialty: null,
      managerId: null, writerCode: null, evaluatorCode: genCode("MGR"), active: true, createdAt: now, updatedAt: now },
    { id: "waad", name: "وداد الدريني", isWriter: true, isEvaluator: true, level: "senior", specialty: "general",
      managerId: "manager", writerCode: genCode("WAAD"), evaluatorCode: genCode("EVWAAD"), active: true, createdAt: now, updatedAt: now },
    { id: "maimouna", name: "ميمونة المرشد", isWriter: true, isEvaluator: false, level: "writer", specialty: "general",
      managerId: "waad", writerCode: genCode("MAI"), evaluatorCode: null, active: true, createdAt: now, updatedAt: now },
    { id: "hamzah", name: "حمزة السويلم", isWriter: true, isEvaluator: false, level: "writer", specialty: "general",
      managerId: "waad", writerCode: genCode("HAM"), evaluatorCode: null, active: true, createdAt: now, updatedAt: now },
    { id: "afnan", name: "أفنان الأسمري", isWriter: true, isEvaluator: false, level: "writer", specialty: "general",
      managerId: "waad", writerCode: genCode("AFN"), evaluatorCode: null, active: true, createdAt: now, updatedAt: now },
    { id: "sarah", name: "سارة القحطاني", isWriter: true, isEvaluator: false, level: "writer", specialty: "general",
      managerId: "waad", writerCode: genCode("SAR"), evaluatorCode: null, active: true, createdAt: now, updatedAt: now },
    { id: "ahmed", name: "أحمد بكري", isWriter: true, isEvaluator: false, level: "writer", specialty: "general",
      managerId: "waad", writerCode: genCode("AHM"), evaluatorCode: null, active: true, createdAt: now, updatedAt: now },
  ];
  team.forEach((emp) => upsertRow_(SHEET_NAMES.EMPLOYEES, emp));

  const adminPassword = "kenayah-" + Math.floor(1000 + Math.random() * 9000);
  const settings = DEFAULT_SETTINGS_();
  settings.adminPassword = adminPassword;
  setSettings_(settings);

  Logger.log("=== تمّت التهيئة بنجاح ===");
  Logger.log("كلمة مرور الإدارة: " + adminPassword);
  team.forEach((e) => Logger.log(e.name + " -> كاتب: " + (e.writerCode || "-") + " / مقيّم: " + (e.evaluatorCode || "-")));
  Logger.log("انسخي هذه الأكواد الآن — لن تظهر لك مجددًا هنا إلا عبر Logger أو شاشة «الموظفون» في التطبيق بصلاحية الإدارة.");
}

/**
 * شغّليها مرة واحدة يدويًا من محرر Apps Script بعد لصق هذا الإصدار من الكود على شيت "متم" الحيّ القائم فعلًا
 * (فيه بيانات سابقة) — تُحدِّث بنية الشيت والإعدادات لتطابق «مرحلة 1 — بنية البيانات» دون المساس بأي بيانات موجودة:
 *  1) تُضيف أعمدة الرأس الجديدة الناقصة في WorkLog و EvalScores في نهاية الصف الأول (لا تُدرَج في المنتصف أبدًا).
 *  2) تُضيف الركيزتين الجديدتين (العمل الجماعي / دقة المعلومات ومصادر موثوقة) لإعدادات الشيت الحالية بوزن 0،
 *     دون لمس أي ركيزة أو معيار أو وزن موجود مسبقًا.
 * آمنة للتشغيل أكثر من مرة (idempotent) — لا تُكرّر إضافة عمود أو ركيزة موجودة بالفعل.
 */
function migrateSchemaV2_stage1() {
  ["WorkLog", "EvalScores"].forEach((sheetName) => {
    const sheet = getSheet_(sheetName);
    const width = sheet.getLastColumn();
    const currentHeaders = width > 0 ? sheet.getRange(1, 1, 1, width).getValues()[0] : [];
    const targetHeaders = HEADERS[sheetName];
    const missing = targetHeaders.slice(currentHeaders.length);
    if (missing.length) {
      sheet.getRange(1, currentHeaders.length + 1, 1, missing.length).setValues([missing]);
      Logger.log(sheetName + ": أُضيفت أعمدة جديدة -> " + missing.join(", "));
    } else {
      Logger.log(sheetName + ": لا أعمدة ناقصة، لا شيء للتحديث.");
    }
  });

  const settings = getSettings_();
  const defaults = DEFAULT_SETTINGS_();
  const existingIds = settings.pillars.map((p) => p.id);
  let added = [];
  defaults.pillars.forEach((p) => {
    if (existingIds.indexOf(p.id) === -1) { settings.pillars.push(p); added.push(p.id); }
  });
  if (added.length) {
    setSettings_(settings);
    Logger.log("أُضيفت ركائز جديدة إلى الإعدادات -> " + added.join(", ") + " (بوزن 0 — عدّليه من شاشة «المعايير والأوزان»)");
  } else {
    Logger.log("لا ركائز ناقصة في الإعدادات، لا شيء للتحديث.");
  }
  Logger.log("=== تمّت ترقية بنية الشيت والإعدادات إلى مرحلة 1 بنجاح ===");
}

/**
 * شغّليها مرة واحدة بعد migrateSchemaV2_stage1 (وبعد نشر نسخة الواجهة الجديدة) لتحديث أعمال WorkLog القديمة
 * المسجَّلة قبل الدمج تحت "منشورات وسائل التواصل الاجتماعي" الجديد، بدل بقائها بأسماء الأنواع القديمة المتفرّقة.
 * ملاحظة: "البطاقات الرقمية + Gif" كانت نوعًا واحدًا مدمجًا سابقًا، فلا يمكن تلقائيًا معرفة أيّ الأعمال القديمة
 * كانت "بطاقة رقمية" وأيها "Gif" فعليًا — تُنقَل جميعها مبدئيًا إلى "بطاقة رقمية" مع ملاحظة، وعلى الكاتب/الإدارة
 * تصحيح ما كان منها "Gif" فعليًا يدويًا من شاشة سجل الأعمال عند الحاجة.
 */
function migrateSocialCategoriesV2_stage1() {
  const SOCIAL_PARENT = "منشورات وسائل التواصل الاجتماعي";
  const MAP = {
    "الإنفوجرافيك": "إنفوجرافيك",
    "كتابة التغريدات": "تغريدة",
    "منشورات كاروسيل": "كاروسيل",
    "البطاقات الرقمية + Gif": "بطاقة رقمية",
  };
  const rows = readAll_(SHEET_NAMES.WORKLOG);
  let updated = 0, ambiguous = 0;
  rows.forEach((r) => {
    const subType = MAP[r.workCategory];
    if (!subType) return;
    const wasAmbiguous = r.workCategory === "البطاقات الرقمية + Gif";
    r.workCategory = SOCIAL_PARENT;
    r.socialSubType = subType;
    if (wasAmbiguous) {
      r.notes = (r.notes ? r.notes + " — " : "") + "تُرحيل تلقائي: كان مصنَّفًا سابقًا ضمن «البطاقات الرقمية + Gif» — تحققي إن كان فعليًا Gif وصححي النوع الفرعي عند الحاجة.";
      ambiguous++;
    }
    upsertRow_(SHEET_NAMES.WORKLOG, r);
    updated++;
  });
  Logger.log("تمّ ترحيل " + updated + " عملًا إلى «" + SOCIAL_PARENT + "» (منها " + ambiguous + " يحتاج مراجعة يدوية لتمييز Gif عن البطاقة الرقمية).");
}

/**
 * شغّليها مرة واحدة بعد migrateSchemaV2_stage1 (تحديثة الأعمدة الأخيرة) وبعد نشر نسخة الواجهة الجديدة (تعدد الأنواع الفرعية).
 * تحوّل عمود socialSubType القديم (نوع فرعي واحد كنص) إلى socialSubTypes الجديد (مصفوفة أنواع)، لأي عمل لم تُحدَّث
 * مصفوفته بعد — سواء كان عملًا رُحِّل بـ migrateSocialCategoriesV2_stage1 أو أُدخل يدويًا بالنسخة السابقة من الواجهة
 * (النوع الفرعي الواحد). آمنة للتشغيل أكثر من مرة.
 */
function migrateSocialSubTypesV2_stage2() {
  const SOCIAL_PARENT = "منشورات وسائل التواصل الاجتماعي";
  const rows = readAll_(SHEET_NAMES.WORKLOG);
  let updated = 0;
  rows.forEach((r) => {
    if (r.workCategory !== SOCIAL_PARENT) return;
    if (r.socialSubTypes && r.socialSubTypes.length) return; // مُحدَّث مسبقًا
    if (!r.socialSubType) return; // ما فيه شي لترحيله
    r.socialSubTypes = [r.socialSubType];
    upsertRow_(SHEET_NAMES.WORKLOG, r);
    updated++;
  });
  Logger.log("تمّ تحويل " + updated + " عملًا من socialSubType (نص واحد) إلى socialSubTypes (مصفوفة).");
}

function DEFAULT_SETTINGS_() {
  return {
    revisionValueMultiplier: 0.5,
    adminPassword: "change-me",
    pillars: [
      { id: "quality", name: "جودة الكتابة والعمل", type: "rubric_group", category: "technical", weightWriter: 60, weightSenior: 45,
        criteria: [
          { id: "lang_accuracy", name: "الدقة اللغوية والتحريرية", weightCreative: 15, weightFormal: 15,
            anchors: { "5": "صفر أخطاء إملائية/نحوية، تحرير نظيف دون حاجة لمراجعة تصحيحية",
              "3": "أخطاء طفيفة متفرقة (1-3) لا تحتاج إعادة صياغة", "1": "أخطاء متكررة تستدعي تدقيقًا كاملًا" } },
          { id: "identity_consistency", name: "الاتساق مع الهوية والتوجيهات", weightCreative: 15, weightFormal: 20,
            anchors: { "5": "يطابق دليل الأسلوب/البريف دون أي انحراف",
              "3": "انحراف بسيط في نقطة أو نقطتين يحتاج تصحيح", "1": "خروج عن الهوية يستدعي إعادة كتابة كاملة" } },
          { id: "originality", name: "الأصالة والقيمة الإبداعية", weightCreative: 30, weightFormal: 10,
            anchors: { "5": "زاوية أو فكرة لم تُطرح سابقًا في محتوى مشابه، ملحوظة دون تلقين",
              "3": "تنفيذ سليم ضمن أنماط متوقعة", "1": "إعادة صياغة لأفكار/عبارات سبق استخدامها في مشاريع أخرى للفريق" } },
          { id: "clarity_structure", name: "الوضوح والبنية المنطقية", weightCreative: 5, weightFormal: 15,
            anchors: { "5": "يُفهم من قراءة واحدة، الفكرة الرئيسية واضحة خلال أول 3 جمل",
              "3": "يحتاج قراءة ثانية لفهم الترابط", "1": "لا تسلسل منطقي واضح" } },
          { id: "audience_fit", name: "الملاءمة للجمهور والسياق", weightCreative: 5, weightFormal: 10,
            anchors: { "5": "اللغة والنبرة مطابقة تمامًا لجمهور العميل المستهدف",
              "3": "مناسب عمومًا، يحتاج تعديل بسيط بالنبرة/المستوى", "1": "لا يناسب الجمهور المستهدف إطلاقًا" } },
          { id: "feedback_handling", name: "التعامل مع المراجعة والتوجيه", weightCreative: 10, weightFormal: 10,
            anchors: { "5": "يطبّق الملاحظة بدقة من أول مرة، ولا يكرر نفس نوع الخطأ لاحقًا",
              "3": "يطبّق الملاحظة لكن يحتاج توضيح إضافي أحيانًا", "1": "يقاوم التعديل أو يكرر نفس الخطأ رغم التوجيه السابق" } },
          { id: "work_diversity", name: "تنوع الأعمال ومدى إجادتها", weightCreative: 10, weightFormal: 10,
            anchors: { "5": "ينجز أكثر من نوع/شكل من المحتوى بنفس المستوى العالي من الجودة",
              "3": "يجيد نوعًا واحدًا بعمق، وأداؤه في الأنواع الأخرى مقبول لا أكثر",
              "1": "إنتاجه يقتصر على نمط واحد متكرر، ويضعف أداؤه بشكل ملحوظ عند الخروج عنه" } },
          { id: "attention_to_detail", name: "الانتباه للتفاصيل", weightCreative: 10, weightFormal: 10,
            anchors: { "5": "يلتقط أدق التفاصيل (أرقام، أسماء، تنسيق، اتساق العلامات) دون أي إغفال يستدعي تصحيحًا لاحقًا",
              "3": "يغفل تفاصيل صغيرة متفرقة لا تؤثر على المعنى العام لكنها تحتاج تنبيهًا",
              "1": "إغفال متكرر لتفاصيل جوهرية (أرقام خاطئة، تناقض في المعلومات، تنسيق غير متسق) يستدعي مراجعة كاملة" } },
        ] },
      { id: "engagement", name: "التفاعل والمساهمة الجماعية", type: "rubric_group", category: "behavioral", weightWriter: 10, weightSenior: 5,
        criteria: [
          { id: "brainstorming", name: "المشاركة في العصف الذهني", weight: 34,
            anchors: { "5": "يطرح أفكارًا جديدة بانتظام في جلسات العصف الذهني، ويُبنى على أفكاره من الآخرين",
              "3": "يشارك عند الطرح المباشر عليه، لكن دون مبادرة طرح أفكار من تلقاء نفسه",
              "1": "حضور صامت متكرر أو تغيّب متكرر عن الجلسات" } },
          { id: "knowledge_sharing", name: "مشاركة الفوائد والمعرفة المهنية", weight: 33,
            anchors: { "5": "شارك مورّدًا أو تقنية كتابة مفيدة مرتين أو أكثر هذا الربع",
              "3": "شارك مرة واحدة هذا الربع", "1": "لم يشارك أي فائدة مهنية طوال الربع" } },
          { id: "initiative", name: "المبادرة", weight: 33,
            anchors: { "5": "اقترح تحسينًا أو أنشأ محتوى إبداعيًا دون أن يُطلب منه، ونُفِّذ الاقتراح فعليًا (مرتان فأكثر)",
              "3": "قدّم اقتراحًا واحدًا موثقًا هذا الربع، سواء نُفِّذ أم لا",
              "1": "لم يبادر بأي اقتراح، وينتظر التوجيه الكامل لكل خطوة" } },
        ] },
      { id: "client_satisfaction", name: "رضا العميل (غير مباشر)", type: "rubric_group", category: "technical", weightWriter: 10, weightSenior: 10,
        criteria: [
          { id: "first_draft_acceptance", name: "نسبة القبول من أول مسودة", weight: 50,
            anchors: { "5": "معظم أعمال الربع اعتُمدت من أول مسودة دون أي تعديل جوهري على المحتوى",
              "3": "بعض الأعمال احتاجت جولة تعديل واحدة على المحتوى، لكن الغالبية اعتُمدت مباشرة",
              "1": "معظم الأعمال احتاجت أكثر من جولة تعديل على المحتوى قبل قبولها" } },
          { id: "revision_rounds", name: "جولات تعديل المحتوى لكل مشروع", type: "ratio", metric: "avgContentRevisionRounds",
            unit: "جولة", weight: 50, bands: { "5": 1, "3": 3, "1": 4 }, higherIsBetter: false },
        ] },
      { id: "discipline", name: "الانضباط التشغيلي", type: "rubric_group", category: "behavioral", weightWriter: 10, weightSenior: 10,
        criteria: [
          { id: "on_time_delivery", name: "نسبة التسليم في الموعد", type: "ratio", metric: "onTimeRate",
            unit: "%", weight: 32, bands: { "5": 95, "3": 75, "1": 0 }, higherIsBetter: true },
          { id: "task_completion", name: "نسبة إنجاز المهام الموكلة", type: "ratio", metric: "taskCompletionRate",
            unit: "%", weight: 32, bands: { "5": 100, "3": 80, "1": 0 }, higherIsBetter: true },
          { id: "review_path_adherence", name: "الالتزام بمسار المراجعة (مسودة→مراجعة→تعديل)", type: "rubric", weight: 16,
            anchors: { "5": "يلتزم دائمًا بمسار العمل المتفق عليه دون تجاوز خطوات",
              "3": "التزام جزئي، يحتاج تذكير أحيانًا", "1": "لا يلتزم بمسار المراجعة المتفق عليه" } },
          { id: "task_pressure_management", name: "إدارة المهام والضغط", type: "rubric", weight: 20,
            anchors: { "5": "يدير أكثر من مهمة/موعد متزامن دون تراجع في الجودة، ويرتّب أولوياته بوضوح وقت ضغط العمل",
              "3": "ينجز مهامه لكن يحتاج تذكيرًا أو دعمًا عند تزاحم المواعيد",
              "1": "يتأثر أداؤه بشكل واضح عند ازدحام المهام، ويحتاج إعادة توزيع للعمل عنه" } },
        ] },
      { id: "growth", name: "النمو المهني", type: "rubric_group", category: "behavioral", weightWriter: 10, weightSenior: 10,
        criteria: [
          { id: "growth_courses", name: "النمو المهني (دورات لغوية أو مهنية)", weight: 100,
            anchors: { "5": "أكمل دورتين لغويتين أو مهنيتين أو أكثر هذا الربع مع أثر ملحوظ في عينات المراجعة",
              "3": "أكمل دورة لغوية أو مهنية واحدة هذا الربع دون أثر ملحوظ بعد",
              "1": "لم يكمل أي دورة لغوية أو مهنية هذا الربع" } },
        ] },
      { id: "leadership", name: "القيادة وتطوير الآخرين", type: "rubric_group", category: "behavioral", weightWriter: 0, weightSenior: 20,
        criteria: [
          { id: "review_development", name: "تطوير النفس في مراجعة الأعمال", weight: 50,
            anchors: { "5": "يراجع أعمال الفريق بانتظام ويقدّم ملاحظات دقيقة وبنّاءة تُحسّن جودة الأعمال بشكل ملحوظ",
              "3": "يراجع عند الطلب المباشر فقط، وملاحظاته عامة دون تعمّق كافٍ",
              "1": "لا يشارك في مراجعة أعمال الفريق رغم الحاجة لذلك" } },
          { id: "project_leadership", name: "قيادة المشاريع", weight: 50,
            anchors: { "5": "يقود مشاريع الفريق من التخطيط حتى التسليم بثقة واستقلالية، ويحل العقبات دون تصعيد دائم",
              "3": "يقود مهام محدودة النطاق فقط، ويحتاج توجيهًا في القرارات الأكبر",
              "1": "لم يتولَّ قيادة أي مشروع رغم الفرص المتاحة" } },
        ] },
      // ركيزتان جديدتان — مرحلة 1 (بنية البيانات). وزنهما 0 عمدًا حتى لا تُغيَّر درجات أي كاتب تلقائيًا؛
      // الإدارة تحدّد وزنهما الفعلي (ومن أي ركيزة يُخصَم) من شاشة «المعايير والأوزان»، والنصوص أدناه مسودة أولى قابلة للتعديل من نفس الشاشة.
      { id: "teamwork", name: "العمل الجماعي", type: "rubric_group", category: "behavioral", weightWriter: 0, weightSenior: 0,
        criteria: [
          { id: "teamwork_collab", name: "العمل الجماعي", weight: 100,
            anchors: { "5": "ينسّق بفاعلية مع زملائه على الأعمال المشتركة، يسلّم جزءه في وقته، ويدعم الفريق دون أن يُطلب منه ذلك",
              "3": "يُنجز جزءه في الأعمال المشتركة عند التنسيق المباشر معه، دون مبادرة إضافية بدعم الفريق",
              "1": "يتأخر في تسليم جزءه من الأعمال المشتركة أو يتجنّب التنسيق مع بقية الفريق" } },
        ] },
      { id: "info_accuracy", name: "دقة المعلومات ومصادر موثوقة", type: "rubric_group", category: "technical", weightWriter: 0, weightSenior: 0,
        criteria: [
          { id: "info_accuracy_sources", name: "دقة المعلومات ومصادر موثوقة", weight: 100,
            anchors: { "5": "كل معلومة/رقم/ادعاء في العمل مدعوم بمصدر موثوق يمكن التحقق منه، دون أي خطأ واقعي",
              "3": "المعلومات صحيحة عمومًا لكن بعضها دون مصدر موثّق واضح، أو يحتاج تحققًا إضافيًا",
              "1": "معلومات غير دقيقة أو غير موثّقة تستدعي تصحيحًا قبل النشر" } },
        ] },
    ],
    classification: [
      { min: 4.50, max: 5.00, label: "استثنائي" },
      { min: 3.50, max: 4.49, label: "يتجاوز التوقعات" },
      { min: 2.50, max: 3.49, label: "يواكب التوقعات" },
      { min: 1.50, max: 2.49, label: "يواكب التوقعات جزئيًا" },
      { min: 0.00, max: 1.49, label: "لا يواكب التوقعات" },
    ],
  };
}

// ============================= الأرشفة الفصلية (بند 2.3) =============================
// لا يُثبَّت أي Trigger تلقائي من مجرّد وجود هذا الكود في الملف — التثبيت خطوة يدوية صريحة
// (installQuarterlyArchiveTrigger أدناه) يُنفّذها المستخدم بنفسه من محرر Apps Script،
// تمامًا كخطوة setupInitialData، لأنها تُفعّل جدولة تلقائية تمسّ توفّر البيانات.
//
// "تصفير سجل الأعمال" هنا يعني نقل بيانات الربع السابق إلى ورقة أرشيف منفصلة (WorkLog_Archive،
// BehavioralLog_Archive، EvalScores_Archive) — لا حذفها نهائيًا. الهدف تخفيف حمل الأوراق الحيّة
// عن الخادم، لا فقدان البيانات؛ الأرشيف يبقى مفتوحًا للاطّلاع اليدوي من الشيت نفسه، لكن التطبيق
// (listWork/listEval/...) لا يقرأ إلا من الأوراق الحيّة، فالربع المؤرشَف يختفي فعليًا من الواجهة
// كما هو مطلوب ("لا يمكن الرجوع إليه بعدها").

const ARCHIVE_SUFFIX = "_Archive";
const ARCHIVE_DELAY_DAYS = 21; // 3 أسابيع بعد بداية كل ربع جديد
const ARCHIVABLE_SHEETS = [SHEET_NAMES.WORKLOG, SHEET_NAMES.BEHAVIORAL, SHEET_NAMES.EVAL];

function quarterOf_(date) {
  const q = Math.floor(date.getMonth() / 3) + 1;
  return date.getFullYear() + "-Q" + q;
}

function quarterStartDate_(quarterStr) {
  const parts = quarterStr.split("-Q");
  const y = Number(parts[0]), q = Number(parts[1]);
  return new Date(y, (q - 1) * 3, 1);
}

function previousQuarter_(quarterStr) {
  const parts = quarterStr.split("-Q");
  let year = Number(parts[0]), q = Number(parts[1]) - 1;
  if (q === 0) { q = 4; year -= 1; }
  return year + "-Q" + q;
}

/**
 * دالة الفحص اليومي — مصمَّمة لتُستدعى مرة كل يوم عبر Trigger زمني (لا في تاريخ محدد بالضبط،
 * تجنّبًا لهشاشة توقيت Apps Script)، لكنها لا تُنفّذ أي أرشفة فعلية إلا حين يتحقق الشرطان معًا:
 * (أ) مرّ 21 يومًا على الأقل من بداية الربع الحالي، (ب) الربع السابق لم يُؤرشَف بعد.
 * أي خطأ أثناء الأرشفة يوقف العملية بالكامل قبل حذف أي صف من الورقة الحيّة (انظر archiveQuarterFromSheet_).
 */
function archiveOldQuartersIfDue() {
  const today = new Date();
  const currentQ = quarterOf_(today);
  const daysSinceStart = Math.floor((today - quarterStartDate_(currentQ)) / 86400000);
  if (daysSinceStart < ARCHIVE_DELAY_DAYS) return; // لم يحن الوقت بعد لهذا الربع

  const targetQuarter = previousQuarter_(currentQ);
  const settings = getSettings_();
  const archived = settings.archivedQuarters || [];
  if (archived.indexOf(targetQuarter) !== -1) return; // أُرشف هذا الربع سابقًا — لا تكرار

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ARCHIVABLE_SHEETS.forEach((name) => archiveQuarterFromSheet_(name, targetQuarter));
    settings.archivedQuarters = archived.concat([targetQuarter]);
    setSettings_(settings);
    audit_("system", "أرشفة تلقائية", "أرشفة ربع", "System", targetQuarter, "تم نقل بيانات " + targetQuarter + " إلى أوراق الأرشيف");
  } catch (err) {
    audit_("system", "أرشفة تلقائية", "فشل أرشفة", "System", targetQuarter, String(err));
    throw err; // لا نُخفي الفشل — يظهر في سجل Executions بمحرر Apps Script
  } finally {
    lock.releaseLock();
  }
}

/** ينقل صفوف ربع واحد من ورقة حيّة إلى ورقة أرشيف بنفس الاسم + "_Archive": نسخ فالتحقق فالحذف — بهذا الترتيب فقط. */
function archiveQuarterFromSheet_(sheetName, quarter) {
  const rows = readAll_(sheetName).filter((r) => r.quarter === quarter);
  if (!rows.length) return;

  const archiveName = sheetName + ARCHIVE_SUFFIX;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let archiveSheet = ss.getSheetByName(archiveName);
  if (!archiveSheet) {
    archiveSheet = ss.insertSheet(archiveName);
    archiveSheet.appendRow(HEADERS[sheetName]);
    archiveSheet.setFrozenRows(1);
  }

  const headers = HEADERS[sheetName];

  // 1) نسخ كامل الصفوف إلى الأرشيف أولًا (قبل أي حذف) — نفس objectToRow_ المستخدمة أصلًا في upsertRow_
  rows.forEach((r) => {
    archiveSheet.appendRow(objectToRow_(sheetName, headers, r));
  });

  // 2) تحقق أساسي: عدد صفوف هذا الربع بالأرشيف بعد النسخ >= ما نسخناه فعلًا
  const archivedCountAfter = readAll_(archiveName).filter((r) => r.quarter === quarter).length;
  if (archivedCountAfter < rows.length) {
    throw new Error("فشل التحقق من نسخ " + sheetName + " للربع " + quarter + " إلى الأرشيف — أُوقف الحذف من الورقة الحيّة، لا بيانات فُقدت");
  }

  // 3) الحذف من الورقة الحيّة فقط بعد نجاح النسخ والتحقق أعلاه
  rows.forEach((r) => deleteRow_(sheetName, r.id));
}

/**
 * خطوة تثبيت يدوية صريحة — نفّذيها بنفسك من القائمة المنسدلة بجانب ▶ Run في محرر Apps Script
 * (تمامًا كخطوة setupInitialData)، ولا تُشغَّل تلقائيًا من مجرّد وجودها في الملف.
 * تُثبّت Trigger زمني يوميّ (لا في يوم محدد بالضبط) يستدعي archiveOldQuartersIfDue كل يوم؛
 * الدالة نفسها لا تُنفّذ الأرشفة الفعلية إلا حين يحين وقتها كما هو موضّح أعلاه.
 * شغّليها فقط بعد مراجعتك لآلية archiveOldQuartersIfDue وموافقتك عليها.
 */
function installQuarterlyArchiveTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === "archiveOldQuartersIfDue")
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("archiveOldQuartersIfDue").timeBased().everyDays(1).atHour(3).create();
  Logger.log("تم تثبيت Trigger يومي — سيُنفَّذ archiveOldQuartersIfDue تلقائيًا كل يوم قرابة الساعة 3 صباحًا بتوقيت مشروع Apps Script.");
}
