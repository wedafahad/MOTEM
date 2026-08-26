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
    is_writer = emp.get("isWriter") and emp.get("writerCode") == code
    is_evaluator = emp.get("isEvaluator") and emp.get("evaluatorCode") == code
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
    as_writer = emp.get("writerCode") == code
    as_evaluator = emp.get("evaluatorCode") == code
    return {
        "employee": {k: v for k, v in emp.items() if k not in ("writerCode", "evaluatorCode")},
        "asWriter": as_writer,
        "asEvaluator": as_evaluator,
    }


def handle_admin_login(db, payload):
    if payload.get("password") != db["settings"].get("adminPassword"):
        raise ApiError("كلمة المرور غير صحيحة", 401)
    return {"ok": True}


def handle_list_employees(db, actor):
    if actor["isAdmin"]:
        rows = db["employees"]
    elif actor["asEvaluator"]:
        me = actor["employee"]
        downline = downline_ids(db, me["id"])
        rows = [me] + [e for e in db["employees"] if e["id"] in downline]
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
    """نطاق الكتابة (upsert/delete) — التقارير المباشرة فقط، لا كامل التسلسل الهرمي."""
    if actor["isAdmin"]:
        return None  # unرestricted metadata only; handled by caller
    me = actor["employee"]
    ids = set()
    if actor["asWriter"]:
        ids.add(me["id"])
    if actor["asEvaluator"]:
        for r in direct_reports(db, me["id"]):
            ids.add(r["id"])
    return ids


def _readable_work_ids(db, actor):
    """نطاق القراءة (list) — أوسع من نطاق الكتابة: يشمل كل من تحت المقيّم هرميًا (downline)،
    ليقدر المدير يطّلع على سجل أعمال أي موظف تحت إشرافه غير المباشر أيضًا وقت المراجعة/الاعتماد."""
    if actor["isAdmin"]:
        return None
    me = actor["employee"]
    ids = set()
    if actor["asWriter"]:
        ids.add(me["id"])
    if actor["asEvaluator"]:
        ids.update(downline_ids(db, me["id"]))
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
        return existing
    row["id"] = row.get("id") or str(uuid.uuid4())
    row["createdBy"] = actor_name
    row["createdAt"] = now_iso()
    row["updatedAt"] = now_iso()
    db["workLog"].append(row)
    audit(db, "-", actor_name, "إضافة عمل", "WorkLog", row["id"], row.get("title"))
    return row


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
    return {"deleted": wid}


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
    # skip-level manager (approver) can see detail too
    owner = next((e for e in db["employees"] if e["id"] == row["employeeId"]), None)
    if owner and actor["asEvaluator"]:
        evaluator = next((e for e in db["employees"] if e["id"] == row.get("evaluatorId")), None)
        if evaluator and evaluator.get("managerId") == me["id"]:
            return True
    return False


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
            r.get("evaluatorId") == me["id"] or r["employeeId"] in my_downline
        )
        if not (is_owner_writer or is_owner_eval):
            continue
        if _can_see_eval_detail(db, actor, r):
            visible.append(r)
        elif is_owner_writer:
            pass  # not approved yet -> not visible at all to the writer
        else:
            visible.append(_redact_eval(r))
    return visible


def handle_upsert_eval(db, actor, payload):
    if not actor["asEvaluator"]:
        raise ApiError("فقط المقيّم يسجّل التقييم", 403)
    row = payload["row"]
    me = actor["employee"]
    reports_ids = [d["id"] for d in direct_reports(db, me["id"])]
    if row.get("employeeId") not in reports_ids:
        raise ApiError("لا تقيّم إلا فريقك المباشر", 403)
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
    if not existing:
        existing = {
            "id": str(uuid.uuid4()), "employeeId": me["id"], "quarter": quarter,
            "evaluatorId": me.get("managerId"), "status": "draft", "pillarScores": {},
            "selfAssessment": {}, "managerAudit": {}, "totalScore": None, "classification": None,
            "createdAt": now_iso(),
        }
        db["evalScores"].append(existing)
    existing["selfAssessment"] = self_scores
    existing["updatedAt"] = now_iso()
    audit(db, "writer", me["name"], "تحديث التقييم الذاتي", "EvalScores", existing["id"], "")
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
    elif actor["asEvaluator"]:
        me = actor["employee"]
        evaluator = next((e for e in db["employees"] if e["id"] == row.get("evaluatorId")), None)
        if evaluator and evaluator.get("managerId") == me["id"]:
            allowed = True
            actor_name = me["name"]
    if not allowed:
        raise ApiError("لا تملك صلاحية اعتماد هذا التقييم", 403)
    row["status"] = "approved"
    row["approvedBy"] = actor_name
    row["approvedAt"] = now_iso()
    audit(db, "-", actor_name, "اعتماد تقييم", "EvalScores", eid, row.get("employeeId"))
    return row


def handle_get_settings(db, actor):
    return db["settings"]


def handle_set_settings(db, actor, payload):
    if not actor.get("isOrgAdmin"):
        raise ApiError("فقط الإدارة العامة أو المدير يعدّلان الإعدادات", 403)
    new_settings = payload["settings"]
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
            elif action == "approveEval":
                result = handle_approve_eval(db, actor, payload)
            elif action == "getSettings":
                result = handle_get_settings(db, actor)
            elif action == "setSettings":
                result = handle_set_settings(db, actor, payload)
            elif action == "changeAdminPassword":
                result = handle_change_admin_password(db, actor, payload)
            elif action == "listAudit":
                result = handle_list_audit(db, actor)
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
