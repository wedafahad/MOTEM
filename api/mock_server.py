#!/usr/bin/env python3
"""
خادم اختبار محلي لنظام «متم» — يحاكي عقد Google Apps Script (api/contract.md, api/Code.gs)
بنفس المنطق تمامًا، لكن يخزّن البيانات في api/data/db.json بدل Google Sheets.

هذا الخادم لِلاختبار المحلي فقط قبل نشر Code.gs الحقيقي على Google Apps Script.
تشغيله:  python3 api/mock_server.py  (يستمع على http://localhost:8787)
"""
import json
import os
import uuid
import threading
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
SEED_PATH = os.path.join(BASE, "data", "seed.json")
DB_PATH = os.path.join(BASE, "data", "db.json")
DB_LOCK = threading.Lock()  # الخادم متعدد الخيوط (Threading) — نمنع تسابق القراءة/الكتابة على db.json


def now_iso():
    return datetime.datetime.utcnow().isoformat() + "Z"


def load_db():
    if not os.path.exists(DB_PATH):
        with open(SEED_PATH, "r", encoding="utf-8") as f:
            seed = json.load(f)
        save_db(seed)
        return seed
    with open(DB_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_db(db):
    tmp = DB_PATH + f".{uuid.uuid4().hex}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DB_PATH)


def find_employee_by_code(db, code):
    if not code:
        return None
    for e in db["employees"]:
        if e.get("writerCode") == code or e.get("evaluatorCode") == code:
            return e
    return None


def audit(db, actor_role, actor_name, action, target_type, target_id, details=""):
    db["auditLog"].append({
        "id": str(uuid.uuid4()),
        "timestamp": now_iso(),
        "actorRole": actor_role,
        "actorName": actor_name,
        "action": action,
        "targetType": target_type,
        "targetId": target_id,
        "details": details,
    })


class ApiError(Exception):
    def __init__(self, msg, code=400):
        super().__init__(msg)
        self.code = code


def resolve_actor(db, auth):
    """يعيد (role_info) بعد التحقق من الكود/كلمة المرور."""
    auth = auth or {}
    if auth.get("admin"):
        settings = db["settings"]
        if auth.get("password") != settings.get("adminPassword"):
            raise ApiError("كلمة مرور الإدارة غير صحيحة", 401)
        return {"isAdmin": True, "isOrgAdmin": True, "employee": None}
    code = auth.get("code")
    emp = find_employee_by_code(db, code)
    if not emp or not emp.get("active", True):
        raise ApiError("الكود غير صحيح أو الحساب غير مُفعّل", 401)
    # إصلاح: الصلاحيات تُبنى على صفات الموظف الفعلية (isWriter/isEvaluator)، لا على أي كود بعينه
    # استُخدم للدخول — موظف يحمل الصفتين معًا (كاتب + مقيّم) يحصل على كل صلاحياته بأي من كوديه.
    is_writer = bool(emp.get("isWriter"))
    is_evaluator = bool(emp.get("isEvaluator"))
    # دمج 2.2: أعلى مقيّم في التسلسل الهرمي (بلا مدير فوقه) يكتسب صلاحيات الإدارة العامة
    # التشغيلية، دون أن يصبح isAdmin=True (حتى لا تنكسر خصوصية تفاصيل التقييمات).
    is_top_manager = bool(emp.get("isEvaluator") and not emp.get("managerId"))
    return {"isAdmin": False, "isOrgAdmin": is_top_manager, "employee": emp, "asWriter": is_writer, "asEvaluator": is_evaluator}


def direct_reports(db, evaluator_id):
    return [e for e in db["employees"] if e.get("managerId") == evaluator_id]


def downline_ids(db, root_id):
    """كل من يقع تحت هذا الشخص في التسلسل الهرمي (مباشر وغير مباشر) — لأغراض الاعتماد والتدقيق."""
    ids = set()
    frontier = [root_id]
    while frontier:
        current = frontier.pop()
        for r in direct_reports(db, current):
            if r["id"] not in ids:
                ids.add(r["id"])
                frontier.append(r["id"])
    return ids


def handle_login(db, payload):
    code = payload.get("code")
    emp = find_employee_by_code(db, code)
    if not emp or not emp.get("active", True):
        raise ApiError("الكود غير صحيح", 401)
    as_writer = bool(emp.get("isWriter"))
    as_evaluator = bool(emp.get("isEvaluator"))
    return {
        "employee": {k: v for k, v in emp.items() if k not in ("writerCode", "evaluatorCode")},
        "asWriter": as_writer,
        "asEvaluator": as_evaluator,
    }


def handle_admin_login(db, payload):
    if payload.get("password") != db["settings"].get("adminPassword"):
        raise ApiError("كلمة المرور غير صحيحة", 401)
    return {"ok": True}


def evaluates_employee(db, actor, employee_id):
    """إشراف موسّع (evalScopeAll/evalScopeIds) بمعزل عن التسلسل الهرمي — يطابق evaluatesEmployee_ في Code.gs."""
    if not actor.get("asEvaluator"):
        return False
    me = actor["employee"]
    if me.get("evalScopeAll"):
        return True
    if employee_id in (me.get("evalScopeIds") or []):
        return True
    return any(r["id"] == employee_id for r in direct_reports(db, me["id"]))


def handle_list_employees(db, actor):
    if actor["isAdmin"] or actor.get("isOrgAdmin"):
        rows = db["employees"]
    elif actor["asEvaluator"] and actor["employee"].get("evalScopeAll"):
        rows = db["employees"]  # إشراف موسّع على الجميع
    elif actor["asEvaluator"]:
        me = actor["employee"]
        downline = downline_ids(db, me["id"])
        extra = set(me.get("evalScopeIds") or [])
        rows = [me] + [e for e in db["employees"] if e["id"] in downline or e["id"] in extra]
    else:
        rows = [actor["employee"]]
    return [{k: v for k, v in e.items() if k not in ("writerCode", "evaluatorCode")} |
            ({"writerCode": e.get("writerCode"), "evaluatorCode": e.get("evaluatorCode")}
             if actor["isAdmin"] or actor.get("isOrgAdmin") or (actor["employee"] and actor["employee"]["id"] == e["id"]) else {})
            for e in rows]


def handle_upsert_employee(db, actor, payload):
    if not actor.get("isOrgAdmin"):
        raise ApiError("فقط الإدارة العامة أو المدير تديران الموظفين", 403)
    actor_role = "admin" if actor["isAdmin"] else "manager"
    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    row = payload["row"]
    existing = next((e for e in db["employees"] if e["id"] == row.get("id")), None)
    if existing:
        existing.update(row)
        existing["updatedAt"] = now_iso()
        audit(db, actor_role, actor_name, "تعديل موظف", "Employee", existing["id"], existing["name"])
        return existing
    row["id"] = row.get("id") or str(uuid.uuid4())
    row.setdefault("active", True)
    row["createdAt"] = now_iso()
    row["updatedAt"] = now_iso()
    db["employees"].append(row)
    audit(db, actor_role, actor_name, "إضافة موظف", "Employee", row["id"], row["name"])
    return row


def handle_delete_employee(db, actor, payload):
    if not actor.get("isOrgAdmin"):
        raise ApiError("فقط الإدارة العامة أو المدير يحذفان الموظفين", 403)
    eid = payload["id"]
    emp = next((e for e in db["employees"] if e["id"] == eid), None)
    db["employees"] = [e for e in db["employees"] if e["id"] != eid]
    audit(db, "admin" if actor["isAdmin"] else "manager", "الإدارة" if actor["isAdmin"] else actor["employee"]["name"],
          "حذف موظف", "Employee", eid, emp["name"] if emp else "")
    return {"deleted": eid}


def _owned_work_ids(db, actor):
    """نطاق الكتابة (upsert/delete) — التقارير المباشرة + أي نطاق إشراف موسّع صريح (evalScopeAll/evalScopeIds)."""
    if actor["isAdmin"]:
        return None  # unrestricted metadata only; handled by caller
    me = actor["employee"]
    if actor["asEvaluator"] and me.get("evalScopeAll"):
        return None  # None = بلا قيد (كل الكتّاب)
    ids = set()
    if actor["asWriter"]:
        ids.add(me["id"])
    if actor["asEvaluator"]:
        for r in direct_reports(db, me["id"]):
            ids.add(r["id"])
        ids.update(me.get("evalScopeIds") or [])
    return ids


def _readable_work_ids(db, actor):
    """نطاق القراءة (list) — أوسع من نطاق الكتابة: يشمل كل من تحت المقيّم هرميًا (downline) + أي نطاق
    إشراف موسّع صريح، ليقدر المدير يطّلع على سجل أعمال أي موظف تحت إشرافه غير المباشر أيضًا وقت
    المراجعة/الاعتماد، ويمكّن إشراف "المدير الإبداعي" ونحوه بمعزل عن التسلسل الهرمي."""
    if actor["isAdmin"]:
        return None
    me = actor["employee"]
    if actor["asEvaluator"] and me.get("evalScopeAll"):
        return None  # None = بلا قيد (كل الكتّاب)
    ids = set()
    if actor["asWriter"]:
        ids.add(me["id"])
    if actor["asEvaluator"]:
        ids.update(downline_ids(db, me["id"]))
        ids.update(me.get("evalScopeIds") or [])
    return ids


def handle_list_work(db, actor, payload):
    allowed = _readable_work_ids(db, actor)
    rows = db["workLog"]
    if allowed is not None:
        rows = [r for r in rows if r["employeeId"] in allowed]
    q = payload.get("quarter")
    if q:
        rows = [r for r in rows if r.get("quarter") == q]
    emp_id = payload.get("employeeId")
    if emp_id:
        rows = [r for r in rows if r.get("employeeId") == emp_id]
    return rows


def _reset_work_log_submission_if_needed(db, employee_id, quarter):
    """لو الكاتب سبق وأرسل أعمال هذا الربع، أو كان تقييمه مُرسَلًا/مُعتمَدًا، أي تغيير لاحق على سجل
    أعماله لنفس الربع يُلغي كل ذلك تلقائيًا — يطابق resetWorkLogSubmissionIfNeeded_ في Code.gs."""
    existing = next((r for r in db["evalScores"] if r["employeeId"] == employee_id and r["quarter"] == quarter), None)
    if not existing:
        return
    changed = False
    if existing.get("workLogStatus") == "submitted":
        existing["workLogStatus"] = None
        existing["workLogSubmittedAt"] = None
        changed = True
    if existing.get("status") in ("submitted", "approved"):
        existing["status"] = "draft"
        existing["approvedBy"] = None
        existing["approvedAt"] = None
        changed = True
    if changed:
        existing["updatedAt"] = now_iso()
        audit(db, "-", "-", "إلغاء إرسال/اعتماد التقييم تلقائيًا (تغيّر سجل الأعمال)", "EvalScores", existing["id"], quarter)


def handle_upsert_work(db, actor, payload):
    row = payload["row"]
    allowed = _owned_work_ids(db, actor)
    if allowed is not None and row.get("employeeId") not in allowed:
        raise ApiError("لا تملك صلاحية تعديل أعمال هذا الموظف", 403)
    existing = next((r for r in db["workLog"] if r["id"] == row.get("id")), None)
    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    if existing:
        existing.update(row)
        existing["updatedAt"] = now_iso()
        audit(db, "-", actor_name, "تعديل عمل", "WorkLog", existing["id"], existing.get("title"))
        saved = existing
    else:
        row["id"] = row.get("id") or str(uuid.uuid4())
        row["createdBy"] = actor_name
        row["createdAt"] = now_iso()
        row["updatedAt"] = now_iso()
        db["workLog"].append(row)
        audit(db, "-", actor_name, "إضافة عمل", "WorkLog", row["id"], row.get("title"))
        saved = row
    _reset_work_log_submission_if_needed(db, saved["employeeId"], saved["quarter"])
    return saved


def handle_delete_work(db, actor, payload):
    wid = payload["id"]
    allowed = _owned_work_ids(db, actor)
    row = next((r for r in db["workLog"] if r["id"] == wid), None)
    if not row:
        raise ApiError("العمل غير موجود", 404)
    if allowed is not None and row["employeeId"] not in allowed:
        raise ApiError("لا تملك صلاحية حذف هذا العمل", 403)
    db["workLog"] = [r for r in db["workLog"] if r["id"] != wid]
    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    audit(db, "-", actor_name, "حذف عمل", "WorkLog", wid, row.get("title"))
    _reset_work_log_submission_if_needed(db, row["employeeId"], row["quarter"])
    return {"deleted": wid}


def handle_submit_work_log(db, actor, payload):
    if not actor["asWriter"]:
        raise ApiError("فقط الكاتب يرسل أعمال الربع للاعتماد", 403)
    me = actor["employee"]
    quarter = payload.get("quarter")
    if not quarter:
        raise ApiError("الربع مطلوب", 400)
    work_count = len([w for w in db["workLog"] if w["employeeId"] == me["id"] and w["quarter"] == quarter])
    if not work_count:
        raise ApiError("لا توجد أعمال مسجّلة لهذا الربع بعد — أضيفي عملًا واحدًا على الأقل أولًا", 400)
    existing = next((r for r in db["evalScores"] if r["employeeId"] == me["id"] and r["quarter"] == quarter), None)
    if not existing:
        existing = {
            "id": str(uuid.uuid4()), "employeeId": me["id"], "quarter": quarter,
            "evaluatorId": me.get("managerId"), "status": "draft", "pillarScores": {},
            "selfAssessment": {}, "managerAudit": {}, "totalScore": None, "classification": None,
            "selfAssessmentStatus": "draft", "selfAssessmentSubmittedAt": None,
            "createdAt": now_iso(),
        }
        db["evalScores"].append(existing)
    existing["workLogStatus"] = "submitted"
    existing["workLogSubmittedAt"] = now_iso()
    existing["updatedAt"] = now_iso()
    audit(db, "writer", me["name"], "إرسال أعمال الربع للاعتماد", "EvalScores", existing["id"], quarter)
    return existing


def handle_list_behavioral(db, actor, payload):
    allowed = _readable_work_ids(db, actor)
    rows = db["behavioralLog"]
    if allowed is not None:
        rows = [r for r in rows if r["employeeId"] in allowed]
    q = payload.get("quarter")
    if q:
        rows = [r for r in rows if r.get("quarter") == q]
    emp_id = payload.get("employeeId")
    if emp_id:
        rows = [r for r in rows if r.get("employeeId") == emp_id]
    return rows


def handle_upsert_behavioral(db, actor, payload):
    row = payload["row"]
    allowed = _owned_work_ids(db, actor)
    if allowed is not None and row.get("employeeId") not in allowed:
        raise ApiError("لا تملك صلاحية هذا الإجراء", 403)
    existing = next((r for r in db["behavioralLog"] if r["id"] == row.get("id")), None)
    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    if existing:
        existing.update(row)
        audit(db, "-", actor_name, "تعديل واقعة سلوكية", "BehavioralLog", existing["id"], "")
        return existing
    row["id"] = row.get("id") or str(uuid.uuid4())
    row["loggedBy"] = actor_name
    row["createdAt"] = now_iso()
    db["behavioralLog"].append(row)
    audit(db, "-", actor_name, "إضافة واقعة سلوكية", "BehavioralLog", row["id"], row.get("description", ""))
    return row


def handle_delete_behavioral(db, actor, payload):
    bid = payload["id"]
    allowed = _owned_work_ids(db, actor)
    row = next((r for r in db["behavioralLog"] if r["id"] == bid), None)
    if not row:
        raise ApiError("غير موجود", 404)
    if allowed is not None and row["employeeId"] not in allowed:
        raise ApiError("لا تملك صلاحية الحذف", 403)
    db["behavioralLog"] = [r for r in db["behavioralLog"] if r["id"] != bid]
    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    audit(db, "-", actor_name, "حذف واقعة سلوكية", "BehavioralLog", bid, "")
    return {"deleted": bid}


def _can_see_eval_detail(db, actor, row):
    if actor["isAdmin"]:
        return False  # admin sees status/total only, never detail (privacy rule)
    me = actor["employee"]
    if actor["asWriter"] and row["employeeId"] == me["id"]:
        return row.get("status") == "approved"
    if actor["asEvaluator"] and row.get("evaluatorId") == me["id"]:
        return True
    # skip-level manager (approver) can see detail too — أي مقيّم أعلى هرميًا من صاحب التقييم
    if actor["asEvaluator"] and row.get("evaluatorId") in downline_ids(db, me["id"]):
        return True
    # إشراف موسّع صريح (evalScopeAll/evalScopeIds) — بمعزل عن التسلسل الهرمي ومن دون اشتراط كون
    # المُقيَّم نفسه هو المُقيِّم في هذا الصف تحديدًا.
    if evaluates_employee(db, actor, row["employeeId"]):
        return True
    return False


def _with_self_assessment_visibility(actor, row):
    """الكاتب يرى تقييمه الذاتي دائمًا؛ المقيّم لا يرى تفاصيله إلا بعد أن يعتمده الكاتب
    (selfAssessmentStatus === "submitted") — يطابق withSelfAssessmentVisibility_ في Code.gs."""
    me = actor.get("employee")
    is_owner_writer = actor["asWriter"] and me and row["employeeId"] == me["id"]
    if is_owner_writer:
        return row
    if row.get("selfAssessmentStatus") == "submitted":
        return row
    return {**row, "selfAssessment": {}}


def _redact_for_owner_writer_pending(row):
    """إصلاح: قبل اعتماد التقييم كاملًا، الكاتب يرى دومًا حالة/قيم تقييمه الذاتي هو نفسه — بمعزل عن
    اعتماد المقيّم — ويبقى محجوبًا فقط عن درجات المقيّم/الإجمالي/التصنيف. يطابق redactForOwnerWriterPending_."""
    return {
        "id": row["id"], "employeeId": row["employeeId"], "quarter": row["quarter"],
        "evaluatorId": row.get("evaluatorId"), "status": row.get("status"),
        "selfAssessment": row.get("selfAssessment") or {},
        "selfAssessmentStatus": row.get("selfAssessmentStatus") or "draft",
        "selfAssessmentSubmittedAt": row.get("selfAssessmentSubmittedAt"),
        # نفس المنطق: حالة إرسال أعمال الربع بيانات الكاتب نفسها أيضًا — تظهر لها دومًا بمعزل عن اعتماد التقييم.
        "workLogStatus": row.get("workLogStatus"),
        "workLogSubmittedAt": row.get("workLogSubmittedAt"),
    }


def _redact_eval(row):
    return {
        "id": row["id"], "employeeId": row["employeeId"], "quarter": row["quarter"],
        "evaluatorId": row.get("evaluatorId"), "status": row.get("status"),
        "totalScore": row.get("totalScore"), "classification": row.get("classification"),
    }


def handle_list_eval(db, actor, payload):
    rows = db["evalScores"]
    q = payload.get("quarter")
    if q:
        rows = [r for r in rows if r.get("quarter") == q]
    emp_id = payload.get("employeeId")
    if emp_id:
        rows = [r for r in rows if r.get("employeeId") == emp_id]

    if actor["isAdmin"]:
        return [_redact_eval(r) for r in rows]

    me = actor["employee"]
    my_downline = downline_ids(db, me["id"])
    visible = []
    for r in rows:
        is_owner_writer = actor["asWriter"] and r["employeeId"] == me["id"]
        is_owner_eval = actor["asEvaluator"] and (
            r.get("evaluatorId") == me["id"] or r["employeeId"] in my_downline or evaluates_employee(db, actor, r["employeeId"])
        )
        if not (is_owner_writer or is_owner_eval):
            continue
        if _can_see_eval_detail(db, actor, r):
            visible.append(_with_self_assessment_visibility(actor, r))
        elif is_owner_writer:
            visible.append(_redact_for_owner_writer_pending(r))  # درجات المقيّم محجوبة، تقييمها الذاتي تراه دومًا
        else:
            visible.append(_redact_eval(r))
    return visible


def handle_upsert_eval(db, actor, payload):
    if not actor["asEvaluator"]:
        raise ApiError("فقط المقيّم يسجّل التقييم", 403)
    row = payload["row"]
    me = actor["employee"]
    if not evaluates_employee(db, actor, row.get("employeeId")):
        raise ApiError("لا تقيّم إلا فريقك المباشر أو من ضمن نطاق إشرافك", 403)
    row["evaluatorId"] = me["id"]
    existing = next((r for r in db["evalScores"]
                      if r["employeeId"] == row["employeeId"] and r["quarter"] == row["quarter"]), None)
    if existing:
        existing.update(row)
        existing["updatedAt"] = now_iso()
        audit(db, "evaluator", me["name"], "تحديث تقييم", "EvalScores", existing["id"], row.get("status", ""))
        return existing
    row["id"] = row.get("id") or str(uuid.uuid4())
    row["createdAt"] = now_iso()
    row["updatedAt"] = now_iso()
    db["evalScores"].append(row)
    audit(db, "evaluator", me["name"], "إنشاء تقييم", "EvalScores", row["id"], row.get("status", ""))
    return row


def handle_upsert_self_assessment(db, actor, payload):
    if not actor["asWriter"]:
        raise ApiError("فقط الكاتب يسجّل تقييمه الذاتي", 403)
    me = actor["employee"]
    quarter = payload["quarter"]
    self_scores = payload["selfAssessment"]
    existing = next((r for r in db["evalScores"] if r["employeeId"] == me["id"] and r["quarter"] == quarter), None)
    if existing and existing.get("selfAssessmentStatus") == "submitted":
        raise ApiError("تقييمك الذاتي مُعتمَد بالفعل ولا يمكن تعديله لهذا الربع", 403)
    if not existing:
        existing = {
            "id": str(uuid.uuid4()), "employeeId": me["id"], "quarter": quarter,
            "evaluatorId": me.get("managerId"), "status": "draft", "pillarScores": {},
            "selfAssessment": {}, "managerAudit": {}, "totalScore": None, "classification": None,
            "selfAssessmentStatus": "draft", "selfAssessmentSubmittedAt": None,
            "createdAt": now_iso(),
        }
        db["evalScores"].append(existing)
    existing["selfAssessment"] = self_scores
    existing["updatedAt"] = now_iso()
    audit(db, "writer", me["name"], "تحديث التقييم الذاتي", "EvalScores", existing["id"], "")
    return existing


def handle_submit_self_assessment(db, actor, payload):
    """يقفل التقييم الذاتي نهائيًا لهذا الربع — يطابق handleSubmitSelfAssessment_ في Code.gs."""
    if not actor["asWriter"]:
        raise ApiError("فقط الكاتب يعتمد تقييمه الذاتي", 403)
    me = actor["employee"]
    quarter = payload["quarter"]
    existing = next((r for r in db["evalScores"] if r["employeeId"] == me["id"] and r["quarter"] == quarter), None)
    if not existing or not existing.get("selfAssessment"):
        raise ApiError("سجّلي تقييمك الذاتي أولًا قبل الاعتماد", 400)
    if existing.get("selfAssessmentStatus") == "submitted":
        raise ApiError("تقييمك الذاتي مُعتمَد بالفعل", 400)
    existing["selfAssessmentStatus"] = "submitted"
    existing["selfAssessmentSubmittedAt"] = now_iso()
    existing["updatedAt"] = now_iso()
    audit(db, "writer", me["name"], "اعتماد التقييم الذاتي", "EvalScores", existing["id"], "")
    return existing


def handle_approve_eval(db, actor, payload):
    eid = payload["id"]
    row = next((r for r in db["evalScores"] if r["id"] == eid), None)
    if not row:
        raise ApiError("التقييم غير موجود", 404)
    allowed = False
    actor_name = ""
    if actor["isAdmin"]:
        allowed = True
        actor_name = "الإدارة"
    elif actor.get("isOrgAdmin"):
        # المدير (أعلى الهرم) يعتمد أي تقييم مباشرة — يحل عدم وجود "مدير للمقيّم" فوقه لاعتماد تقييماته هو
        allowed = True
        actor_name = actor["employee"]["name"]
    elif actor["asEvaluator"]:
        me = actor["employee"]
        evaluator = next((e for e in db["employees"] if e["id"] == row.get("evaluatorId")), None)
        if evaluator and evaluator.get("managerId") == me["id"]:
            allowed = True
            actor_name = me["name"]
        elif row.get("evaluatorId") == me["id"] and me.get("canFinalApprove"):
            # تفويض صريح من المدير — مقيّم يعتمد تقييمات فريقه بنفسه
            allowed = True
            actor_name = me["name"]
    if not allowed:
        raise ApiError("لا تملك صلاحية اعتماد هذا التقييم", 403)
    row["status"] = "approved"
    row["approvedBy"] = actor_name
    row["approvedAt"] = now_iso()
    audit(db, "-", actor_name, "اعتماد تقييم", "EvalScores", eid, row.get("employeeId"))
    return row


def handle_reopen_eval(db, actor, payload):
    """يعكس approveEval — نفس نطاق صلاحية الاعتماد بالضبط. يطابق handleReopenEval_ في Code.gs."""
    eid = payload["id"]
    row = next((r for r in db["evalScores"] if r["id"] == eid), None)
    if not row:
        raise ApiError("التقييم غير موجود", 404)
    if row.get("status") != "approved":
        raise ApiError("هذا التقييم غير مُعتمَد أصلًا — لا حاجة لإعادة فتحه", 400)
    allowed = False
    actor_name = ""
    if actor["isAdmin"]:
        allowed = True
        actor_name = "الإدارة"
    elif actor.get("isOrgAdmin"):
        allowed = True
        actor_name = actor["employee"]["name"]
    elif actor["asEvaluator"]:
        me = actor["employee"]
        evaluator = next((e for e in db["employees"] if e["id"] == row.get("evaluatorId")), None)
        if evaluator and evaluator.get("managerId") == me["id"]:
            allowed = True
            actor_name = me["name"]
        elif row.get("evaluatorId") == me["id"] and me.get("canFinalApprove"):
            allowed = True
            actor_name = me["name"]
    if not allowed:
        raise ApiError("لا تملك صلاحية إعادة فتح هذا التقييم", 403)
    row["status"] = "submitted"
    row["approvedBy"] = None
    row["approvedAt"] = None
    row["updatedAt"] = now_iso()
    audit(db, "-", actor_name, "إعادة فتح تقييم مُعتمَد", "EvalScores", eid, row.get("employeeId"))
    return row


def handle_upsert_review_note(db, actor, payload):
    """يسمح لمن يرى تفاصيل التقييم (canSeeEvalDetail) بإضافة "مقترحات" خاصة به هو (managerComments)،
    بمعزل عن مقترحات المقيّم الأساسي — يطابق handleUpsertReviewNote_ في Code.gs."""
    if not actor.get("asEvaluator"):
        raise ApiError("فقط المقيّم/المدير يضيف مقترحات", 403)
    row = next((r for r in db["evalScores"] if r["id"] == payload["id"]), None)
    if not row:
        raise ApiError("التقييم غير موجود", 404)
    if not _can_see_eval_detail(db, actor, row):
        raise ApiError("لا تملك صلاحية الاطّلاع على هذا التقييم", 403)
    row["managerComments"] = (payload.get("managerComments") or "").strip()
    row["updatedAt"] = now_iso()
    audit(db, "-", actor["employee"]["name"], "تحديث مقترحات إضافية على تقييم", "EvalScores", row["id"], row.get("employeeId"))
    return row


def handle_get_settings(db, actor):
    # ترميم دفاعي: pillars/classification مفقودة أو فارغة (خلية فاضية بالشيت الأصلي، JSON تالف جزئيًا)
    # تُستبدل بمصفوفة فارغة بدل كسر كل شاشة تعتمد عليها — لا يوجد DEFAULT_SETTINGS_ محلي هنا لإعادة بذر
    # الركائز الكاملة كما في Code.gs، فهذا ترميم أبسط (تجنّب الانهيار) وليس استرجاعًا كاملًا للقيم الافتراضية.
    settings = db.get("settings") or {}
    settings.setdefault("pillars", [])
    settings.setdefault("classification", [])
    db["settings"] = settings
    return settings


def validate_pillar_weights(pillars):
    """إصلاح: مجموع أوزان الركائز لكل مستوى يجب أن يساوي 100% — calc.js يقسم الدرجة الكلية دائمًا
    على 100 لا على مجموع الأوزان الفعلي، فأي اختلال هنا ينتج درجات كلية غير صحيحة رياضيًا بصمت."""
    eps = 0.05
    labels = {"weightWriter": "الكاتب", "weightSenior": "الكاتب الأول"}
    for key, label in labels.items():
        total = sum((p.get(key) or 0) for p in pillars)
        if abs(total - 100) > eps:
            raise ApiError(
                f"رفض الحفظ: مجموع أوزان {label} = {round(total, 2)}% وليس 100% — صحّحي الأوزان قبل الحفظ", 400
            )


def handle_set_settings(db, actor, payload):
    if not actor.get("isOrgAdmin"):
        raise ApiError("فقط الإدارة العامة أو المدير يعدّلان الإعدادات", 403)
    new_settings = payload.get("settings")
    if not new_settings or not isinstance(new_settings.get("pillars"), list) or not new_settings["pillars"]:
        raise ApiError("رفض الحفظ: الإعدادات المُرسَلة لا تحتوي ركائز تقييم صالحة (pillars فارغة أو مفقودة)", 400)
    validate_pillar_weights(new_settings["pillars"])
    new_settings["adminPassword"] = db["settings"]["adminPassword"]
    db["settings"] = new_settings
    audit(db, "admin" if actor["isAdmin"] else "manager", "الإدارة" if actor["isAdmin"] else actor["employee"]["name"],
          "تحديث إعدادات المعايير", "Settings", "-", "")
    return db["settings"]


def handle_change_admin_password(db, actor, payload):
    if not actor["isAdmin"]:
        raise ApiError("غير مصرّح", 403)
    db["settings"]["adminPassword"] = payload["newPassword"]
    audit(db, "admin", "الإدارة", "تغيير كلمة مرور الإدارة", "Settings", "-", "")
    return {"ok": True}


def handle_list_audit(db, actor):
    if not actor.get("isOrgAdmin"):
        raise ApiError("فقط الإدارة العامة أو المدير يريان سجل التعديلات", 403)
    return list(reversed(db["auditLog"]))


def compute_category_subtotal(row, employee, settings, category):
    """نفس منطق categorySubtotal في docs/js/calc.js — يعمل على بيانات EvalScores الكاملة غير المُصفّاة."""
    if not row or not row.get("pillarScores"):
        return None
    level = "senior" if employee.get("level") == "senior" else "writer"
    weight_key = "weightSenior" if level == "senior" else "weightWriter"
    weighted_sum = 0.0
    weight_total = 0.0
    for p in settings["pillars"]:
        w = p.get(weight_key) or 0
        if w == 0:
            continue
        is_behavioral = p.get("category") == "behavioral"
        if (category == "behavioral") != is_behavioral:
            continue
        pr = row["pillarScores"].get(p["id"])
        score = pr.get("pillarScore") if pr else None
        if score is None:
            continue
        weighted_sum += score * w
        weight_total += w
    return weighted_sum / weight_total if weight_total > 0 else None


DOCUMENT_TYPES = ("course", "initiative", "interaction", "other")
MAX_DOCUMENT_BYTES = 8 * 1024 * 1024  # 8MB بعد فك ترميز base64


def _documents(db):
    db.setdefault("documents", [])
    return db["documents"]


def handle_list_documents(db, actor, payload):
    target_employee_id = (payload or {}).get("employeeId")
    rows = _documents(db)
    if actor["isAdmin"]:
        return [r for r in rows if r["employeeId"] == target_employee_id] if target_employee_id else rows
    me = actor["employee"]
    allowed_ids = set()
    if actor["asWriter"]:
        allowed_ids.add(me["id"])
    if actor["asEvaluator"]:
        if me.get("evalScopeAll"):
            allowed_ids.update(e["id"] for e in db["employees"])
        else:
            allowed_ids.update(r["id"] for r in direct_reports(db, me["id"]))
            allowed_ids.update(me.get("evalScopeIds") or [])
    if target_employee_id and target_employee_id not in allowed_ids:
        raise ApiError("لا تملكين صلاحية الاطّلاع على مستندات هذا الموظف", 403)
    rows = [r for r in rows if r["employeeId"] in allowed_ids]
    return [r for r in rows if r["employeeId"] == target_employee_id] if target_employee_id else rows


def handle_upload_document(db, actor, payload):
    employee_id = payload.get("employeeId")
    if not employee_id:
        raise ApiError("الموظف مطلوب", 400)
    me = actor.get("employee")
    is_self = actor["asWriter"] and me and me["id"] == employee_id
    is_direct_report = evaluates_employee(db, actor, employee_id)
    if not actor["isAdmin"] and not is_self and not is_direct_report:
        raise ApiError("لا تملكين صلاحية الرفع لهذا الموظف", 403)
    if payload.get("docType") not in DOCUMENT_TYPES:
        raise ApiError("نوع مستند غير صالح", 400)
    if payload.get("docType") == "other" and not payload.get("customDocType"):
        raise ApiError("حدّدي نوع المستند في خانة «أخرى»", 400)
    data_b64 = payload.get("dataBase64")
    if not data_b64:
        raise ApiError("الملف مطلوب", 400)
    import base64
    try:
        raw = base64.b64decode(data_b64)
    except Exception:
        raise ApiError("ترميز الملف غير صالح", 400)
    if len(raw) > MAX_DOCUMENT_BYTES:
        raise ApiError("حجم الملف يتجاوز الحد الأقصى (8MB)", 400)
    now = now_iso()
    mime_type = payload.get("mimeType") or "application/octet-stream"
    # للتطوير المحلي فقط: يُخزَّن الملف كـ data: URL بدل رفعه فعليًا لـ Drive (ذلك حصري لـ Code.gs).
    row = {
        "id": str(uuid.uuid4()), "employeeId": employee_id, "docType": payload["docType"],
        "customDocType": payload.get("customDocType") if payload["docType"] == "other" else "",
        "fileName": payload.get("fileName") or "مستند", "mimeType": mime_type,
        "driveFileId": "", "driveUrl": f"data:{mime_type};base64,{data_b64}",
        "status": "pending", "reviewedBy": "", "reviewNote": "",
        "uploadedAt": now, "updatedAt": now,
    }
    _documents(db).append(row)
    actor_role = "admin" if actor["isAdmin"] else ("manager" if actor.get("isOrgAdmin") else "evaluator" if actor["asEvaluator"] else "writer")
    audit(db, actor_role, "الإدارة" if actor["isAdmin"] else actor["employee"]["name"], "رفع مستند", "Documents", row["id"], row["fileName"])
    return row


def handle_delete_document(db, actor, payload):
    rows = _documents(db)
    doc = next((d for d in rows if d["id"] == payload["id"]), None)
    if not doc:
        raise ApiError("المستند غير موجود", 404)
    me = actor.get("employee")
    is_owner = actor["asWriter"] and me and me["id"] == doc["employeeId"]
    is_direct_manager = evaluates_employee(db, actor, doc["employeeId"])
    if not actor["isAdmin"] and not is_owner and not is_direct_manager:
        raise ApiError("لا تملكين صلاحية حذف هذا المستند", 403)
    db["documents"] = [d for d in rows if d["id"] != payload["id"]]
    return {"deleted": payload["id"]}


def handle_review_document(db, actor, payload):
    doc = next((d for d in _documents(db) if d["id"] == payload["id"]), None)
    if not doc:
        raise ApiError("المستند غير موجود", 404)
    emp = next((e for e in db["employees"] if e["id"] == doc["employeeId"]), None)
    me = actor.get("employee")
    is_direct_manager = evaluates_employee(db, actor, doc["employeeId"])
    if not actor.get("isOrgAdmin") and not is_direct_manager:
        raise ApiError("فقط المقيّم المباشر أو الإدارة/المدير يعتمدون المستندات", 403)
    if payload.get("status") not in ("approved", "rejected"):
        raise ApiError("حالة غير صالحة", 400)
    doc["status"] = payload["status"]
    doc["reviewedBy"] = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    doc["reviewNote"] = payload.get("note") or ""
    doc["updatedAt"] = now_iso()
    audit(db, "admin" if actor["isAdmin"] else "manager", "الإدارة" if actor["isAdmin"] else actor["employee"]["name"],
          "اعتماد مستند" if payload["status"] == "approved" else "رفض مستند", "Documents", doc["id"], emp["name"] if emp else doc["employeeId"])
    return doc


def _top_performer_writers_scope(db, actor):
    """الإدارة العامة أو المدير (isOrgAdmin) ينشران على مستوى الشركة كاملة، وأي مقيّم آخر ينشر على
    نطاق فريقه (تسلسله الهرمي/downline) فقط."""
    all_writers = [e for e in db["employees"] if e.get("isWriter")]
    if actor["isAdmin"] or actor.get("isOrgAdmin"):
        return all_writers
    me = actor["employee"]
    if actor.get("asEvaluator") and me.get("evalScopeAll"):
        return all_writers
    downline = downline_ids(db, me["id"])
    extra = set(me.get("evalScopeIds") or [])
    return [e for e in all_writers if e["id"] in downline or e["id"] in extra or e["id"] == me["id"]]


def handle_publish_top_performer(db, actor, payload):
    if not actor.get("isOrgAdmin") and not actor.get("asEvaluator"):
        raise ApiError("فقط الإدارة العامة أو المقيّم/المدير ينشرون هذا القسم", 403)
    quarter = payload.get("quarter")
    if not quarter:
        raise ApiError("الربع مطلوب", 400)
    settings = db["settings"]
    writers_by_id = {e["id"]: e for e in _top_performer_writers_scope(db, actor)}
    eval_rows = [r for r in db["evalScores"] if r.get("quarter") == quarter and r.get("status") == "approved" and r.get("employeeId") in writers_by_id]

    def pick_best(fn):
        best = None
        for r in eval_rows:
            emp = writers_by_id[r["employeeId"]]
            value = fn(r, emp)
            if value is None:
                continue
            if best is None or value > best["value"]:
                best = {"employeeId": emp["id"], "name": emp["name"], "value": value}
        return {"employeeId": best["employeeId"], "name": best["name"]} if best else None  # بالاسم فقط

    actor_name = "الإدارة" if actor["isAdmin"] else actor["employee"]["name"]
    actor_role = "admin" if actor["isAdmin"] else ("manager" if actor.get("isOrgAdmin") else "evaluator")
    result = {
        "quarter": quarter,
        "technical": pick_best(lambda r, e: compute_category_subtotal(r, e, settings, "technical")),
        "behavioral": pick_best(lambda r, e: compute_category_subtotal(r, e, settings, "behavioral")),
        "overall": pick_best(lambda r, e: r.get("totalScore")),
        "publishedBy": actor_name,
        "publishedAt": now_iso(),
    }
    settings["topPerformerPublished"] = result
    audit(db, actor_role, actor_name, "نشر موظف الربع", "System", quarter,
          " / ".join(filter(None, [result["technical"] and result["technical"]["name"],
                                    result["behavioral"] and result["behavioral"]["name"],
                                    result["overall"] and result["overall"]["name"]])))
    return result


def handle_unpublish_top_performer(db, actor):
    if not actor.get("isOrgAdmin") and not actor.get("asEvaluator"):
        raise ApiError("فقط الإدارة العامة أو المقيّم/المدير يلغون النشر", 403)
    db["settings"]["topPerformerPublished"] = None
    actor_role = "admin" if actor["isAdmin"] else ("manager" if actor.get("isOrgAdmin") else "evaluator")
    audit(db, actor_role, "الإدارة" if actor["isAdmin"] else actor["employee"]["name"],
          "إلغاء نشر موظف الربع", "System", "-", "")
    return {"ok": True}


ROUTES_NO_AUTH = {"login", "adminLogin"}


def dispatch(action, auth, payload):
  with DB_LOCK:
    db = load_db()
    try:
        if action == "login":
            result = handle_login(db, payload)
        elif action == "adminLogin":
            result = handle_admin_login(db, payload)
        else:
            actor = resolve_actor(db, auth)
            if action == "listEmployees":
                result = handle_list_employees(db, actor)
            elif action == "upsertEmployee":
                result = handle_upsert_employee(db, actor, payload)
            elif action == "deleteEmployee":
                result = handle_delete_employee(db, actor, payload)
            elif action == "listWork":
                result = handle_list_work(db, actor, payload)
            elif action == "upsertWork":
                result = handle_upsert_work(db, actor, payload)
            elif action == "deleteWork":
                result = handle_delete_work(db, actor, payload)
            elif action == "submitWorkLog":
                result = handle_submit_work_log(db, actor, payload)
            elif action == "listBehavioral":
                result = handle_list_behavioral(db, actor, payload)
            elif action == "upsertBehavioral":
                result = handle_upsert_behavioral(db, actor, payload)
            elif action == "deleteBehavioral":
                result = handle_delete_behavioral(db, actor, payload)
            elif action == "listEval":
                result = handle_list_eval(db, actor, payload)
            elif action == "upsertEval":
                result = handle_upsert_eval(db, actor, payload)
            elif action == "upsertSelfAssessment":
                result = handle_upsert_self_assessment(db, actor, payload)
            elif action == "submitSelfAssessment":
                result = handle_submit_self_assessment(db, actor, payload)
            elif action == "approveEval":
                result = handle_approve_eval(db, actor, payload)
            elif action == "reopenEval":
                result = handle_reopen_eval(db, actor, payload)
            elif action == "upsertReviewNote":
                result = handle_upsert_review_note(db, actor, payload)
            elif action == "getSettings":
                result = handle_get_settings(db, actor)
            elif action == "setSettings":
                result = handle_set_settings(db, actor, payload)
            elif action == "changeAdminPassword":
                result = handle_change_admin_password(db, actor, payload)
            elif action == "listAudit":
                result = handle_list_audit(db, actor)
            elif action == "publishTopPerformer":
                result = handle_publish_top_performer(db, actor, payload)
            elif action == "unpublishTopPerformer":
                result = handle_unpublish_top_performer(db, actor)
            elif action == "listDocuments":
                result = handle_list_documents(db, actor, payload)
            elif action == "uploadDocument":
                result = handle_upload_document(db, actor, payload)
            elif action == "deleteDocument":
                result = handle_delete_document(db, actor, payload)
            elif action == "reviewDocument":
                result = handle_review_document(db, actor, payload)
            else:
                raise ApiError(f"إجراء غير معروف: {action}", 400)
        save_db(db)
        return {"ok": True, "data": result}
    except ApiError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa
        return {"ok": False, "error": f"خطأ غير متوقع بالخادم: {e}"}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps({"ok": True, "data": "mock server up"}).encode("utf-8"))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            body = {}
        action = body.get("action")
        auth = body.get("auth")
        payload = body.get("payload", {})
        result = dispatch(action, auth, payload)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    def log_message(self, fmt, *args):
        print("[mock_server]", fmt % args)


if __name__ == "__main__":
    port = 8787
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"mock server running on http://localhost:{port}")
    server.serve_forever()
