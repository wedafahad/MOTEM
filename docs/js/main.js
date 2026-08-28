// نظام «متم» — تطبيق الواجهة الرئيسي (Vanilla JS، بدون أُطر عمل).
"use strict";

const App = {
  session: null,
  settings: null,
  quarter: Store.currentQuarter(),
  view: "dashboard",
  cache: {},
};

const $app = () => document.getElementById("app");

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt1(n) { return n === null || n === undefined ? "—" : (Math.round(n * 100) / 100).toString(); }

// النوع الأب المُجمَّع لمحتوى وسائل التواصل — إنفوجرافيك/تغريدة/كاروسيل/بطاقة رقمية/Gif يندرجون تحته (بند 1.1)
const SOCIAL_PARENT_CATEGORY = "منشورات وسائل التواصل الاجتماعي";
const SOCIAL_SUB_TYPES = ["إنفوجرافيك", "تغريدة", "كاروسيل", "بطاقة رقمية", "Gif"];

/** مؤشرات عددية مرجعية من سجل الأعمال — للاطّلاع فقط، لا تُحتسب ضمن التقييم. مُستخدَمة في سجل الأعمال وفي لوحة الكاتب/التصدير. */
function computeWorkStats(rows) {
  // "مراجعة لعمل سابق" تُحتسب بقيمة مخفَّضة بدل قيمة كاملة مكررة، حتى لا تتضخّم أرقام الإنتاجية بإعادة تسجيل نفس العمل
  const revMult = App.settings?.revisionValueMultiplier ?? 1;
  const revisionsCount = rows.filter((r) => r.isRevision).length;
  const assignedCount = rows.reduce((sum, r) => sum + (r.isRevision ? revMult : 1), 0);
  const projectNames = new Set(rows.map((r) => (r.project || "").trim()).filter(Boolean));
  const projectsCount = projectNames.size || assignedCount;
  const categoryOf = (r) => (r.workCategory === "أخرى" ? r.customCategory : r.workCategory) || "";
  // كل عمل "منشورات وسائل التواصل" يضمّ أكثر من نوع فرعي دفعة واحدة (مثلًا 3 إنفوجرافيك + Gif + كاروسيل لمشروع واحد) —
  // "عدد أنواع النصوص" يعدّ كل نوع فرعي مستخدَم كنوع مستقل، لا العمل كوحدة واحدة.
  const textTypes = new Set();
  rows.forEach((r) => {
    if (r.workCategory === SOCIAL_PARENT_CATEGORY) {
      (r.socialSubTypes || []).forEach((t) => textTypes.add(t));
    } else {
      const c = categoryOf(r);
      if (c) textTypes.add(c);
    }
  });
  const textTypesCount = textTypes.size;
  const counts = {};
  const socialSubCounts = {};
  rows.forEach((r) => {
    const cat = categoryOf(r) || "غير محدد";
    counts[cat] = (counts[cat] || 0) + 1;
    if (cat === SOCIAL_PARENT_CATEGORY) {
      const subs = r.socialSubTypes && r.socialSubTypes.length ? r.socialSubTypes : ["غير محدد"];
      subs.forEach((sub) => { socialSubCounts[sub] = (socialSubCounts[sub] || 0) + 1; });
    }
  });
  const byCategory = Object.entries(counts).map(([name, count]) => ({
    name, count,
    subBreakdown: name === SOCIAL_PARENT_CATEGORY
      ? Object.entries(socialSubCounts).map(([sn, sc]) => ({ name: sn, count: sc })).sort((a, b) => b.count - a.count)
      : null,
  })).sort((a, b) => b.count - a.count);
  const creativeCount = rows.filter((r) => r.workType === "creative").length;
  const formalCount = rows.filter((r) => r.workType === "formal").length;
  // نوع الإجراء (بند 3.1): كتابة / مراجعة وتدقيق / ترجمة — تُعدّ لكل عمل حسب actionType المسجَّل عليه
  const actionCounts = {};
  rows.forEach((r) => {
    const a = r.actionType || "غير محدد";
    actionCounts[a] = (actionCounts[a] || 0) + 1;
  });
  const byActionType = Object.entries(actionCounts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  // عدد الأعمال المشتركة (بند 3.1 — يعتمد على حقل isCollaborative من بند 1.2)
  const collaborativeCount = rows.filter((r) => r.isCollaborative).length;
  return { assignedCount, projectsCount, textTypesCount, byCategory, creativeCount, formalCount, revisionsCount, byActionType, collaborativeCount };
}

function categoryRowHtml(c, maxCount) {
  const bar = `<div class="pillar-row">
      <div class="pillar-label"><span>${esc(c.name)}</span><b>${c.count}</b></div>
      <div class="bar-track"><div class="bar-fill" style="width:${(c.count / maxCount) * 100}%"></div></div>
    </div>`;
  if (!c.subBreakdown || !c.subBreakdown.length) return bar;
  return `<details class="category-expand">
    <summary>${bar}</summary>
    <div class="category-sub-list">
      ${c.subBreakdown.map((s) => `<div class="pillar-row pillar-row-sub">
        <div class="pillar-label"><span>${esc(s.name)}</span><b>${s.count}</b></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(s.count / c.count) * 100}%"></div></div>
      </div>`).join("")}
    </div>
  </details>`;
}

function workSummaryHtml(rows, heading) {
  const stats = computeWorkStats(rows);
  const maxCount = Math.max(1, ...stats.byCategory.map((c) => c.count));
  const actionChipsHtml = stats.byActionType.length
    ? `<div class="chip-row">${stats.byActionType.map((a) => `<span class="chip">${esc(a.name)} <b>${a.count}</b></span>`).join("")}</div>`
    : "";
  return `
  <div class="card">
    <h3>${heading || "ملخص سجل الأعمال"} <span class="small-muted">— ${App.quarter}</span></h3>
    <div class="stat-tiles">
      <div class="stat-tile"><div class="stat-num">${fmt1(stats.assignedCount)}</div><div class="stat-label">عدد الأعمال الموكلة${stats.revisionsCount ? " *" : ""}</div></div>
      <div class="stat-tile"><div class="stat-num">${stats.projectsCount}</div><div class="stat-label">عدد المشاريع</div></div>
      <div class="stat-tile"><div class="stat-num">${stats.textTypesCount}</div><div class="stat-label">عدد أنواع النصوص</div></div>
      <div class="stat-tile"><div class="stat-num">${stats.creativeCount} / ${stats.formalCount}</div><div class="stat-label">نوع الكتابة (إبداعي / رسمي)</div></div>
      <div class="stat-tile"><div class="stat-num">${stats.collaborativeCount}</div><div class="stat-label">عدد الأعمال المشتركة</div></div>
    </div>
    ${actionChipsHtml ? `<p class="small-muted" style="margin:12px 0 4px">نوع الإجراء</p>${actionChipsHtml}` : ""}
    ${stats.revisionsCount ? `<p class="small-muted">* يشمل ${stats.revisionsCount} مراجعة لعمل سابق، محتسَبة بقيمة مخفَّضة بدل قيمة كاملة مكررة.</p>` : ""}
    ${stats.byCategory.length ? `
    <p class="small-muted" style="margin-bottom:8px">التوزيع حسب نوع العمل</p>
    ${stats.byCategory.map((c) => categoryRowHtml(c, maxCount)).join("")}` : `<p class="small-muted">لا توجد أعمال مسجّلة هذا الربع بعد.</p>`}
  </div>`;
}

/* =========================== إقلاع التطبيق =========================== */
async function boot() {
  const session = Store.get();
  if (!session) return renderLogin();
  App.session = session;
  try {
    App.settings = await Api.call("getSettings", { auth: authOf(session) });
  } catch (err) {
    return renderLogin(err.message);
  }
  renderShell();
}

function authOf(session) {
  if (session.role === "admin") return { admin: true, password: session.password };
  return { code: session.code };
}

/* =========================== تسجيل الدخول =========================== */
function renderLogin(errorMsg) {
  Store.clear();
  let activeTab = "writer";
  const draw = () => {
    $app().innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo"><img src="assets/img/kenayah-logo-black.png" alt="Kenayah"></div>
        <h2 style="text-align:center;margin-bottom:2px">متم</h2>
        <p style="text-align:center;margin-bottom:18px">نظام تقييم فريق الكتابة — كناية</p>
        ${errorMsg ? `<div class="error-box">${esc(errorMsg)}</div>` : ""}
        <div class="role-tabs">
          <button data-r="writer" class="${activeTab === "writer" ? "active" : ""}">كاتب</button>
          <button data-r="evaluator" class="${activeTab === "evaluator" ? "active" : ""}">مقيّم / مدير</button>
          <button data-r="admin" class="${activeTab === "admin" ? "active" : ""}">إدارة عامة</button>
        </div>
        <div id="loginFields"></div>
        <button class="btn btn-primary" id="loginBtn" style="width:100%">دخول</button>
      </div>
    </div>`;
    const fields = document.getElementById("loginFields");
    if (activeTab === "admin") {
      fields.innerHTML = `<div class="field"><label>كلمة مرور الإدارة</label><input type="password" id="pwd"></div>`;
    } else {
      fields.innerHTML = `<div class="field"><label>الكود الشخصي</label><input type="text" id="code" placeholder="مثال: WAAD-K0TO"></div>
      <p class="hint">${activeTab === "writer" ? "كود الكاتب الشخصي الذي زوّدتك به الإدارة" : "كود المقيّم/المدير المباشر الشخصي"}</p>`;
    }
    document.querySelectorAll(".role-tabs button").forEach((b) => {
      b.onclick = () => { activeTab = b.dataset.r; draw(); };
    });
    document.getElementById("loginBtn").onclick = () => doLogin(activeTab);
  };
  draw();
}

async function doLogin(tab) {
  try {
    if (tab === "admin") {
      const password = document.getElementById("pwd").value;
      await Api.call("adminLogin", { payload: { password } });
      Store.set({ role: "admin", password });
    } else {
      const code = document.getElementById("code").value.trim();
      if (!code) return toast("أدخل الكود");
      const data = await Api.call("login", { payload: { code } });
      const role = tab === "writer" ? "writer" : "evaluator";
      if (role === "writer" && !data.asWriter) return renderLogin("هذا الكود ليس كود كاتب — جرّبي تبويب مقيّم/مدير");
      if (role === "evaluator" && !data.asEvaluator) return renderLogin("هذا الكود ليس كود مقيّم — جرّبي تبويب كاتب");
      Store.set({ role, code, employee: data.employee, asWriter: data.asWriter, asEvaluator: data.asEvaluator });
    }
    boot();
  } catch (err) {
    renderLogin(err.message);
  }
}

function logout() {
  Store.clear();
  App.session = null;
  renderLogin();
}

/* =========================== الهيكل العام =========================== */
function navItemsFor(session) {
  if (session.role === "admin") {
    return [
      ["overview", "نظرة عامة"],
      ["employees", "الموظفون"],
      ["admin-worklog", "سجل أعمال الموظفين"],
      ["settings", "المعايير والأوزان"],
      ["audit", "سجل التعديلات"],
      ["export", "التصدير"],
    ];
  }
  if (session.role === "evaluator") {
    const isTopManager = !session.employee.managerId;
    // "لوحتي" أول عنصر دائمًا لمن يملك صفة كاتب — طلب صريح لتصبح نقطة الدخول الأولى بصريًا لا فقط افتراضيًا
    const items = session.asWriter ? [["dashboard", "لوحتي"]] : [];
    items.push(["team", "فريقي"], ["evaluate", "التقييم"]);
    // "سجل الأعمال" هنا يعرض فريقك المباشر فقط — للمدير (أعلى الهرم) هذا مُتضمَّن بالكامل أصلًا في
    // "سجل أعمال الموظفين" الأشمل بالأسفل (كل الكتّاب)، فيُستبعَد له تحديدًا تفاديًا للتكرار.
    if (!isTopManager) items.push(["worklog", "سجل الأعمال"]);
    // مرحلة ٤ — أي مقيّم (لا فقط المدير) يعتمد مستندات تقاريره المباشرين (نفس صلاحية reviewDocument بالخادم).
    items.push(["team-documents", "مستندات الفريق"]);
    if (session.asWriter) items.push(["my-worklog", "سجل أعمالي"], ["self", "تقييمي الذاتي"], ["documents", "مستنداتي"]);
    // دمج 2.2: "المدير" (أعلى مقيّم بلا مدير فوقه) يكتسب أيضًا شاشات الإدارة العامة التشغيلية.
    if (isTopManager) {
      items.push(["overview", "نظرة عامة"], ["employees", "الموظفون"], ["admin-worklog", "سجل أعمال الموظفين"],
        ["settings", "المعايير والأوزان"], ["audit", "سجل التعديلات"]);
    }
    items.push(["export", "التصدير"]);
    return items;
  }
  return [["dashboard", "لوحتي"], ["worklog", "سجل أعمالي"], ["self", "تقييمي الذاتي"], ["documents", "مستنداتي"]];
}

// شاشات "تفاصيل" صالحة لكن غير مدرَجة في القائمة الجانبية (يُفتَح عليها من زر داخل شاشة أخرى، لا من التنقّل المباشر)
const DETAIL_VIEWS = ["review"];

function renderShell() {
  const s = App.session;
  const nav = navItemsFor(s);
  if (!nav.find((n) => n[0] === App.view) && !DETAIL_VIEWS.includes(App.view)) App.view = nav[0][0];
  const isTopManager = s.role === "evaluator" && !s.employee.managerId;
  const roleLabel = s.role === "admin" ? "الإدارة العامة" : isTopManager ? "المدير (صلاحيات إدارية موسّعة)" : s.role === "evaluator" ? "مقيّم / مدير مباشر" : "كاتب";
  const name = s.role === "admin" ? "الإدارة" : s.employee.name;

  $app().innerHTML = `
  <div class="app-shell">
    <div class="topbar">
      <div class="brand"><img src="assets/img/kenayah-logo-black.png" alt="Kenayah"><span class="app-name">متم</span></div>
      <div class="topbar-right">
        ${s.role !== "admin" ? `<select id="quarterSel"></select>` : ""}
        <div class="who"><b>${esc(name)}</b>${esc(roleLabel)}</div>
        <button class="btn btn-sm" id="logoutBtn">خروج</button>
      </div>
    </div>
    <div class="layout">
      <div class="sidebar">
        ${nav.map(([id, label]) => `<button class="nav-btn ${App.view === id ? "active" : ""}" data-v="${id}">${label}</button>`).join("")}
      </div>
      <div class="main" id="mainArea"></div>
    </div>
  </div>`;

  document.getElementById("logoutBtn").onclick = logout;
  document.querySelectorAll(".nav-btn").forEach((b) => (b.onclick = () => { App.view = b.dataset.v; renderShell(); }));

  const qSel = document.getElementById("quarterSel");
  if (qSel) {
    qSel.innerHTML = Store.quarterOptions().map((q) => `<option ${q === App.quarter ? "selected" : ""}>${q}</option>`).join("");
    qSel.onchange = () => { App.quarter = qSel.value; renderView(); };
  }
  renderView();
}

function renderView() {
  const el = document.getElementById("mainArea");
  el.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;
  const map = {
    dashboard: renderDashboardView,
    worklog: App.session.role === "evaluator" ? renderTeamWorkLogView : renderMyWorkLogView,
    "my-worklog": renderMyWorkLogView,
    self: renderSelfAssessmentView,
    team: renderTeamView,
    review: renderReviewView,
    evaluate: renderEvaluateView,
    overview: renderAdminOverviewView,
    employees: renderEmployeesView,
    "admin-worklog": renderAdminWorkLogView,
    settings: renderSettingsView,
    audit: renderAuditView,
    export: renderExportView,
    documents: renderMyDocumentsView,
    "team-documents": renderTeamDocumentsView,
  };
  (map[App.view] || renderDashboardView)(el).catch((err) => {
    el.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  });
}

/* =========================== سجل الأعمال (كاتب) =========================== */
async function renderTeamWorkLogView(el) {
  const s = App.session;
  const employees = await Api.call("listEmployees", { auth: authOf(s) });
  const reports = employees.filter((e) => e.id !== s.employee.id && e.managerId === s.employee.id);
  if (!reports.length) { el.innerHTML = `<div class="empty-state">لا يوجد أعضاء فريق مباشرين بعد</div>`; return; }
  const targetId = App.workTargetId && reports.find((r) => r.id === App.workTargetId) ? App.workTargetId : reports[0].id;
  App.workTargetId = targetId;
  const target = reports.find((r) => r.id === targetId);
  el.innerHTML = `<div class="pill-select" id="workTargetPicker" style="margin-bottom:16px">
    ${reports.map((r) => `<button data-id="${r.id}" class="${r.id === targetId ? "active" : ""}">${esc(r.name)}</button>`).join("")}
  </div><div id="workTableArea"></div>`;
  el.querySelectorAll("#workTargetPicker button").forEach((b) => (b.onclick = () => { App.workTargetId = b.dataset.id; renderTeamWorkLogView(el); }));
  await renderWorkLogView(document.getElementById("workTableArea"), targetId, `سجل أعمال — ${target.name}`);
}

/** الإدارة: اطّلاع (وتعديل) على سجل أعمال أي موظف — كل الكتّاب. */
async function renderAdminWorkLogView(el) {
  const s = App.session;
  const employees = await Api.call("listEmployees", { auth: authOf(s) });
  const writers = employees.filter((e) => e.isWriter);
  if (!writers.length) { el.innerHTML = `<div class="empty-state">لا يوجد كتّاب مسجَّلون بعد</div>`; return; }
  const targetId = App.adminWorkTargetId && writers.find((r) => r.id === App.adminWorkTargetId) ? App.adminWorkTargetId : writers[0].id;
  App.adminWorkTargetId = targetId;
  const target = writers.find((r) => r.id === targetId);
  el.innerHTML = `
  <h2>سجل أعمال الموظفين</h2>
  <p class="small-muted">اطّلاع الإدارة على سجل أعمال أي موظف بعد انتهاء الربع، مع إمكانية التعديل عند الحاجة.</p>
  <div class="pill-select" id="adminWorkTargetPicker" style="margin-bottom:16px">
    ${writers.map((r) => `<button data-id="${r.id}" class="${r.id === targetId ? "active" : ""}">${esc(r.name)}</button>`).join("")}
  </div><div id="adminWorkTableArea"></div>`;
  el.querySelectorAll("#adminWorkTargetPicker button").forEach((b) => (b.onclick = () => { App.adminWorkTargetId = b.dataset.id; renderAdminWorkLogView(el); }));
  await renderWorkLogView(document.getElementById("adminWorkTableArea"), targetId, `سجل أعمال — ${target.name}`);
}

async function renderWorkLogView(el, forEmployeeId, readOnlyHeader) {
  const s = App.session;
  const empId = forEmployeeId || s.employee.id;
  const rows = await Api.call("listWork", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } });

  const stats = computeWorkStats(rows);

  el.innerHTML = `
  <div class="flex-between">
    <h2>${readOnlyHeader || "سجل الأعمال"} <span class="small-muted">— ${App.quarter}</span></h2>
    <button class="btn btn-primary" id="addWorkBtn">+ إضافة عمل</button>
  </div>
  <div class="stat-tiles">
    <div class="stat-tile"><div class="stat-num">${fmt1(stats.assignedCount)}</div><div class="stat-label">عدد الأعمال الموكلة${stats.revisionsCount ? " *" : ""}</div></div>
    <div class="stat-tile"><div class="stat-num">${stats.projectsCount}</div><div class="stat-label">عدد المشاريع</div></div>
    <div class="stat-tile"><div class="stat-num">${stats.textTypesCount}</div><div class="stat-label">عدد أنواع النصوص</div></div>
  </div>
  <p class="small-muted" style="margin-top:-10px">مؤشرات عددية للاطّلاع فقط — لا تُحتسب ضمن درجة التقييم.${stats.revisionsCount ? ` * يشمل ${stats.revisionsCount} مراجعة لعمل سابق بقيمة مخفَّضة.` : ""}</p>
  <div class="card">
    <div class="table-wrap">
    <table>
      <thead><tr><th>العنوان</th><th>النوع</th><th>تاريخ</th><th>تسليم</th><th>بالموعد</th><th>جولات تعديل (محتوى/نطاق)</th><th></th></tr></thead>
      <tbody>
        ${rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="8" class="empty-state">لا توجد أعمال مسجّلة هذا الربع بعد</td></tr>`}
      </tbody>
    </table>
    </div>
  </div>`;

  function rowHtml(r) {
    const categoryLabel = r.workCategory === "أخرى" ? r.customCategory
      : r.workCategory === SOCIAL_PARENT_CATEGORY && r.socialSubTypes?.length ? `${r.workCategory} — ${r.socialSubTypes.join("، ")}`
      : r.workCategory || "";
    return `<tr data-id="${r.id}">
      <td>${esc(r.title)}${r.isRevision ? ` <span class="badge badge-pending" title="مراجعة/تحديث لعمل سابق">مراجعة</span>` : ""}${r.isCollaborative ? ` <span class="badge badge-general" title="عمل مشترك">مشترك</span>` : ""}
        <div class="small-muted">${esc(categoryLabel)}${r.actionType ? " — " + esc(r.actionType) : ""}</div></td>
      <td><span class="badge ${r.workType === "creative" ? "badge-creative" : "badge-formal"}">${r.workType === "creative" ? "إبداعي" : "رسمي"}</span></td>
      <td>${esc(r.date || "—")}</td>
      <td>${r.delivered ? "✔" : "—"}</td>
      <td>${r.onTime ? "✔" : r.delivered ? "متأخر" : "—"}</td>
      <td>${r.contentRevisionRounds ?? 0} / ${r.scopeRevisionRounds ?? 0}</td>
      <td class="gap-8">
        <button class="icon-btn edit-w" data-id="${r.id}">تعديل</button>
        <button class="icon-btn text-danger del-w" data-id="${r.id}">حذف</button>
      </td>
    </tr>`;
  }

  document.getElementById("addWorkBtn").onclick = () => openWorkModal(empId, null, () => renderWorkLogView(el, forEmployeeId, readOnlyHeader));
  el.querySelectorAll(".edit-w").forEach((b) => (b.onclick = () => {
    const row = rows.find((r) => r.id === b.dataset.id);
    openWorkModal(empId, row, () => renderWorkLogView(el, forEmployeeId, readOnlyHeader));
  }));
  el.querySelectorAll(".del-w").forEach((b) => (b.onclick = async () => {
    if (!confirm("تأكيد حذف هذا العمل نهائيًا؟")) return;
    try {
      await Api.call("deleteWork", { auth: authOf(s), payload: { id: b.dataset.id } });
      toast("تم الحذف");
      renderWorkLogView(el, forEmployeeId, readOnlyHeader);
    } catch (err) { toast(err.message); }
  }));
}

function renderMyWorkLogView(el) { return renderWorkLogView(el, App.session.employee.id, "سجل أعمالي"); }

/* =========================== مرحلة ٤ — مستندات الكاتب (توثيق داعم) =========================== */
const DOCUMENT_TYPES = [
  { id: "course", label: "دورة" },
  { id: "initiative", label: "مبادرة" },
  { id: "interaction", label: "توثيق تفاعل" },
];
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024; // 8MB — يطابق الحد الأقصى على الخادم

function docTypeLabel(id) { return DOCUMENT_TYPES.find((t) => t.id === id)?.label || id; }

function docStatusBadge(status) {
  const map = {
    pending: ["بانتظار المراجعة", "badge-pending"],
    approved: ["مُعتمَد", "badge-approved"],
    rejected: ["مرفوض", "badge-draft"],
  };
  const [label, cls] = map[status] || ["—", "badge-draft"];
  return `<span class="badge ${cls}">${label}</span>`;
}

/** عرض عام لمستندات موظف واحد — تُستخدم لكل من "مستنداتي" (الكاتب لنفسه) و"مستندات الفريق" (المقيّم لأحد تقاريره). */
async function renderDocumentsView(el, forEmployeeId, readOnlyHeader, canReview) {
  const s = App.session;
  const rows = await Api.call("listDocuments", { auth: authOf(s), payload: { employeeId: forEmployeeId } });
  el.innerHTML = `
  <div class="flex-between">
    <h2>${readOnlyHeader || "مستنداتي"}</h2>
    ${canReview ? "" : `<button class="btn btn-primary" id="addDocBtn">+ إضافة مستند</button>`}
  </div>
  <p class="small-muted">توثيق داعم مرتبط بمعايير التقييم (دورات، مبادرات، تفاعل جماعي) — لا يدخل حساب الدرجة تلقائيًا، يراجعه المقيّم يدويًا.</p>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>الملف</th><th>النوع</th><th>الحالة</th><th>تاريخ الرفع</th><th>ملاحظة المراجعة</th><th></th></tr></thead>
    <tbody>${rows.map((d) => `<tr>
      <td><a href="${d.driveUrl}" target="_blank" rel="noopener">${esc(d.fileName)}</a></td>
      <td>${esc(docTypeLabel(d.docType))}</td>
      <td>${docStatusBadge(d.status)}</td>
      <td>${d.uploadedAt ? new Date(d.uploadedAt).toLocaleDateString("ar") : "—"}</td>
      <td>${esc(d.reviewNote || "—")}</td>
      <td class="gap-8">
        ${canReview && d.status === "pending" ? `
          <button class="btn btn-sm btn-primary approve-doc" data-id="${d.id}">اعتماد</button>
          <button class="btn btn-sm btn-ghost reject-doc" data-id="${d.id}">رفض</button>` : ""}
        ${!canReview ? `<button class="icon-btn text-danger del-doc" data-id="${d.id}">حذف</button>` : ""}
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty-state">لا توجد مستندات بعد</td></tr>`}</tbody>
  </table></div></div>`;

  const addBtn = document.getElementById("addDocBtn");
  if (addBtn) addBtn.onclick = () => openDocumentModal(forEmployeeId, () => renderDocumentsView(el, forEmployeeId, readOnlyHeader, canReview));
  el.querySelectorAll(".del-doc").forEach((b) => (b.onclick = async () => {
    if (!confirm("تأكيد حذف هذا المستند؟")) return;
    try {
      await Api.call("deleteDocument", { auth: authOf(s), payload: { id: b.dataset.id } });
      toast("تم الحذف");
      renderDocumentsView(el, forEmployeeId, readOnlyHeader, canReview);
    } catch (err) { toast(err.message); }
  }));
  el.querySelectorAll(".approve-doc").forEach((b) => (b.onclick = async () => {
    try {
      await Api.call("reviewDocument", { auth: authOf(s), payload: { id: b.dataset.id, status: "approved" } });
      toast("تم الاعتماد");
      renderDocumentsView(el, forEmployeeId, readOnlyHeader, canReview);
    } catch (err) { toast(err.message); }
  }));
  el.querySelectorAll(".reject-doc").forEach((b) => (b.onclick = async () => {
    const note = prompt("سبب الرفض (اختياري):") || "";
    try {
      await Api.call("reviewDocument", { auth: authOf(s), payload: { id: b.dataset.id, status: "rejected", note } });
      toast("تم الرفض");
      renderDocumentsView(el, forEmployeeId, readOnlyHeader, canReview);
    } catch (err) { toast(err.message); }
  }));
}

/** الكاتب: مستنداته الخاصة، برفع مباشر. */
function renderMyDocumentsView(el) { return renderDocumentsView(el, App.session.employee.id, "مستنداتي", false); }

/** المقيّم: يختار عضو فريقه المباشر ويرى/يعتمد مستنداته. */
async function renderTeamDocumentsView(el) {
  const s = App.session;
  const employees = await Api.call("listEmployees", { auth: authOf(s) });
  const reports = employees.filter((e) => e.managerId === s.employee.id);
  if (!reports.length) { el.innerHTML = `<div class="empty-state">لا يوجد أعضاء فريق مباشرين مسجّلين بعد</div>`; return; }
  const currentId = App.teamDocsTargetId && reports.some((r) => r.id === App.teamDocsTargetId) ? App.teamDocsTargetId : reports[0].id;
  App.teamDocsTargetId = currentId;
  el.innerHTML = `<div class="flex-between"><h2>مستندات الفريق</h2>
    <select id="teamDocsSel">${reports.map((r) => `<option value="${r.id}" ${r.id === currentId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select>
  </div><div id="teamDocsInner"></div>`;
  const inner = document.getElementById("teamDocsInner");
  await renderDocumentsView(inner, currentId, esc(reports.find((r) => r.id === currentId)?.name || ""), true);
  document.getElementById("teamDocsSel").onchange = (e) => { App.teamDocsTargetId = e.target.value; renderTeamDocumentsView(el); };
}

function fileToBase64_(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",").pop());
    reader.onerror = () => reject(new Error("تعذّرت قراءة الملف"));
    reader.readAsDataURL(file);
  });
}

function openDocumentModal(employeeId, onSaved) {
  const s = App.session;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
  <div class="modal">
    <h3>إضافة مستند</h3>
    <div class="field"><label>النوع</label><select id="f_docType">
      ${DOCUMENT_TYPES.map((t) => `<option value="${t.id}">${t.label}</option>`).join("")}
    </select></div>
    <div class="field"><label>الملف</label><input type="file" id="f_docFile"></div>
    <p class="small-muted">الحد الأقصى لحجم الملف 8MB.</p>
    <div class="flex-between">
      <button class="btn btn-ghost" id="cancelModal">إلغاء</button>
      <button class="btn btn-primary" id="saveModal">رفع</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#cancelModal").onclick = () => backdrop.remove();
  backdrop.querySelector("#saveModal").onclick = async () => {
    const fileInput = document.getElementById("f_docFile");
    const file = fileInput.files[0];
    if (!file) return toast("اختر ملفًا أولًا");
    if (file.size > MAX_DOCUMENT_BYTES) return toast("حجم الملف يتجاوز 8MB");
    try {
      const dataBase64 = await fileToBase64_(file);
      await Api.call("uploadDocument", { auth: authOf(s), payload: {
        employeeId, docType: document.getElementById("f_docType").value,
        fileName: file.name, mimeType: file.type, dataBase64,
      } });
      toast("تم الرفع");
      backdrop.remove();
      onSaved();
    } catch (err) { toast(err.message); }
  };
}

// تصنيف أنواع الأعمال — نوع العمل ← أنواع الإجراء المتاحة له
const WORK_CATEGORIES = [
  { name: "عرض تقديمي", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: SOCIAL_PARENT_CATEGORY, actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"], hasSubType: true },
  { name: "التقرير السنوي", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "الحملات الإعلانية", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "السيرة الذاتية", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "تقرير مشروع + متخصص", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "صفحة الهبوط", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "ملفات PDF التفاعلية", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "نص إعلاني", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "وصف اليوتيوب", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "اسم تجاري", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "الأسئلة الشائعة مع أجوبة", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "الملف التعريفي", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "وصف منتج", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "الشعار اللفظي (Slogan)", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "الموشن جرافيك", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "محتوى الموقع الإلكتروني", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "خطة لمحتوى مواقع التواصل", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "كتابة المقالة (المدونات)", actions: ["كتابة", "مراجعة وتدقيق"] },
  { name: "النشرة البريدية", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
  { name: "أخرى", actions: ["كتابة", "مراجعة وتدقيق", "ترجمة"] },
];

function openWorkModal(employeeId, existing, onSaved) {
  const s = App.session;
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
  <div class="modal">
    <h3>${existing ? "تعديل عمل" : "إضافة عمل جديد"}</h3>
    <div class="field"><label>العنوان</label><input type="text" id="f_title" value="${esc(existing?.title || "")}"></div>
    <div class="grid grid-2">
      <div class="field"><label>نوع الكتابة</label>
        <select id="f_type"><option value="creative" ${existing?.workType === "creative" ? "selected" : ""}>إبداعي</option>
        <option value="formal" ${existing?.workType === "formal" ? "selected" : ""}>مؤسسي/رسمي</option></select></div>
      <div class="field"><label>التاريخ</label><input type="date" id="f_date" value="${existing?.date || new Date().toISOString().slice(0,10)}"></div>
    </div>
    <div class="field"><label>المشروع <span id="f_projectHint" class="small-muted">(اختياري — لعدّ المشاريع في السجل)</span></label><input type="text" id="f_project" value="${esc(existing?.project || "")}"></div>
    <div class="grid grid-2">
      <div class="field"><label>نوع العمل</label>
        <select id="f_workCategory">${WORK_CATEGORIES.map((c) => `<option value="${esc(c.name)}" ${existing?.workCategory === c.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      </div>
      <div class="field"><label>نوع الإجراء</label><select id="f_actionType"></select></div>
    </div>
    <div class="field" id="f_customCategoryWrap" style="display:none">
      <label>حدّدي نوع العمل (أخرى)</label><input type="text" id="f_customCategory" value="${esc(existing?.workCategory === "أخرى" ? existing?.customCategory || "" : "")}">
    </div>
    <div class="field" id="f_socialSubTypeWrap" style="display:none">
      <label>الأنواع الدقيقة المشمولة في هذا العمل (اختر كل ما ينطبق)</label>
      <div class="checkbox-row-group">
        ${SOCIAL_SUB_TYPES.map((t) => `<label class="checkbox-row"><input type="checkbox" class="f_socialSubType" value="${esc(t)}" ${existing?.socialSubTypes?.includes(t) ? "checked" : ""}> ${esc(t)}</label>`).join("")}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="f_isCollaborative" ${existing?.isCollaborative ? "checked" : ""}><label>عمل مشترك (أكثر من كاتب شارك في إنجازه)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="f_isRevision" ${existing?.isRevision ? "checked" : ""}><label>هذا العمل مراجعة/تحديث لعمل سابق (يُحتسب بقيمة مخفَّضة في مؤشرات الكمية)</label></div>
    <div class="field" id="f_revisionOfWrap" style="display:none">
      <label>العمل الأصلي</label><select id="f_revisionOf"><option value="">جارٍ التحميل...</option></select>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="f_delivered" ${existing?.delivered !== false ? "checked" : ""}><label>تم التسليم</label></div>
    <div class="checkbox-row"><input type="checkbox" id="f_ontime" ${existing?.onTime !== false ? "checked" : ""}><label>سُلِّم في الموعد المحدد</label></div>
    <div class="grid grid-2">
      <div class="field"><label>جولات تعديل «محتوى/جودة»</label><input type="number" min="0" id="f_rev_content" value="${existing?.contentRevisionRounds ?? 0}"></div>
      <div class="field"><label>جولات تعديل «بريف/نطاق» (لا تُحتسب على الكاتب)</label><input type="number" min="0" id="f_rev_scope" value="${existing?.scopeRevisionRounds ?? 0}"></div>
    </div>
    <div class="field"><label>رابط العمل *</label><input type="text" id="f_link" value="${esc(existing?.link || "")}" placeholder="https://..."></div>
    <div class="field"><label>ملاحظات</label><textarea id="f_notes" rows="2">${esc(existing?.notes || "")}</textarea></div>
    <div class="flex-between">
      <button class="btn btn-ghost" id="cancelModal">إلغاء</button>
      <button class="btn btn-primary" id="saveModal">حفظ</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#cancelModal").onclick = () => backdrop.remove();

  const categorySelect = backdrop.querySelector("#f_workCategory");
  const actionSelect = backdrop.querySelector("#f_actionType");
  const customWrap = backdrop.querySelector("#f_customCategoryWrap");
  const socialSubTypeWrap = backdrop.querySelector("#f_socialSubTypeWrap");
  const projectHint = backdrop.querySelector("#f_projectHint");
  function refreshActions() {
    const cat = WORK_CATEGORIES.find((c) => c.name === categorySelect.value) || WORK_CATEGORIES[0];
    const prevAction = existing?.actionType;
    actionSelect.innerHTML = cat.actions.map((a) => `<option value="${esc(a)}" ${prevAction === a ? "selected" : ""}>${esc(a)}</option>`).join("");
    customWrap.style.display = categorySelect.value === "أخرى" ? "block" : "none";
    socialSubTypeWrap.style.display = cat.hasSubType ? "block" : "none";
    projectHint.textContent = cat.hasSubType ? "(إجباري لمنشورات وسائل التواصل — يجمع كل الأنواع تحت اسم مشروع واحد)" : "(اختياري — لعدّ المشاريع في السجل)";
  }
  categorySelect.value = existing?.workCategory && WORK_CATEGORIES.some((c) => c.name === existing.workCategory)
    ? existing.workCategory : WORK_CATEGORIES[0].name;
  refreshActions();
  categorySelect.onchange = refreshActions;

  const isRevisionCb = backdrop.querySelector("#f_isRevision");
  const revisionOfWrap = backdrop.querySelector("#f_revisionOfWrap");
  const revisionOfSelect = backdrop.querySelector("#f_revisionOf");
  let priorWorksLoaded = false;
  async function loadPriorWorks() {
    if (priorWorksLoaded) return;
    priorWorksLoaded = true;
    try {
      const allWork = await Api.call("listWork", { auth: authOf(s), payload: { employeeId } });
      const candidates = allWork.filter((w) => w.id !== existing?.id);
      revisionOfSelect.innerHTML = candidates.length
        ? candidates.map((w) => `<option value="${w.id}" ${existing?.revisionOfWorkId === w.id ? "selected" : ""}>${esc(w.title)} — ${esc(w.quarter)}</option>`).join("")
        : `<option value="">لا توجد أعمال سابقة مسجّلة لهذا الموظف</option>`;
    } catch (err) {
      revisionOfSelect.innerHTML = `<option value="">تعذّر تحميل الأعمال السابقة</option>`;
    }
  }
  function refreshRevisionUi() {
    revisionOfWrap.style.display = isRevisionCb.checked ? "block" : "none";
    if (isRevisionCb.checked) loadPriorWorks();
  }
  refreshRevisionUi();
  isRevisionCb.onchange = refreshRevisionUi;

  backdrop.querySelector("#saveModal").onclick = async () => {
    const workCategory = categorySelect.value;
    const customCategory = document.getElementById("f_customCategory").value.trim();
    const cat = WORK_CATEGORIES.find((c) => c.name === workCategory) || WORK_CATEGORIES[0];
    const row = {
      id: existing?.id,
      employeeId,
      quarter: App.quarter,
      title: document.getElementById("f_title").value.trim(),
      workType: document.getElementById("f_type").value,
      date: document.getElementById("f_date").value,
      project: document.getElementById("f_project").value.trim(),
      workCategory,
      customCategory: workCategory === "أخرى" ? customCategory : "",
      socialSubTypes: cat.hasSubType
        ? Array.from(backdrop.querySelectorAll(".f_socialSubType:checked")).map((i) => i.value)
        : [],
      isCollaborative: document.getElementById("f_isCollaborative").checked,
      actionType: actionSelect.value,
      isRevision: isRevisionCb.checked,
      revisionOfWorkId: isRevisionCb.checked ? (revisionOfSelect.value || null) : null,
      delivered: document.getElementById("f_delivered").checked,
      onTime: document.getElementById("f_ontime").checked,
      contentRevisionRounds: Number(document.getElementById("f_rev_content").value) || 0,
      scopeRevisionRounds: Number(document.getElementById("f_rev_scope").value) || 0,
      link: document.getElementById("f_link").value.trim(),
      notes: document.getElementById("f_notes").value.trim(),
      collaborators: existing?.collaborators || [{ employeeId, sharePercent: 100 }],
    };
    if (!row.title) return toast("العنوان مطلوب");
    if (!row.link) return toast("رابط العمل مطلوب");
    if (row.workCategory === "أخرى" && !row.customCategory) return toast("حدّد نوع العمل في خانة «أخرى»");
    if (cat.hasSubType && !row.socialSubTypes.length) return toast("حدّد نوعًا فرعيًا واحدًا على الأقل لمنشورات وسائل التواصل");
    if (cat.hasSubType && !row.project) return toast("اسم المشروع إجباري لمنشورات وسائل التواصل — يجمع كل الأنواع تحت مشروع واحد");
    if (row.isRevision && !row.revisionOfWorkId) return toast("اختر العمل الأصلي الذي رُوجِع");
    try {
      await Api.call("upsertWork", { auth: authOf(s), payload: { row } });
      toast("تم الحفظ");
      backdrop.remove();
      onSaved();
    } catch (err) { toast(err.message); }
  };
}

/* =========================== التقييم الذاتي (كاتب) =========================== */
async function renderSelfAssessmentView(el) {
  const s = App.session;
  const empId = s.employee.id;
  const level = s.employee.level === "senior" ? "senior" : "writer";
  const [evalRows] = await Promise.all([
    Api.call("listEval", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } }),
  ]);
  // كل القسم السلوكي والمهاراتي: كل معيار Rubric (غير المحسوب تلقائيًا من سجل الأعمال) ضمن الركائز السلوكية،
  // مفلترًا حسب مستوى الموظف (مثلًا معيار القيادة يظهر للكاتب الأول فقط).
  const behavioralPillars = App.settings.pillars
    .filter((p) => p.category === "behavioral" && (p[level === "senior" ? "weightSenior" : "weightWriter"] || 0) > 0)
    .map((p) => ({
      ...p,
      criteria: p.criteria.filter((c) => c.type !== "ratio" && (!c.appliesToLevel || c.appliesToLevel === level)),
    }))
    .filter((p) => p.criteria.length > 0);
  const row = evalRows[0] || null;
  const current = (row && row.selfAssessment) || {};
  const isLocked = row?.selfAssessmentStatus === "submitted";

  el.innerHTML = `
  <h2>تقييمي الذاتي — ${App.quarter}</h2>
  <p>هذا تقييمك الشخصي على معايير القسم السلوكي والمهاراتي كاملًا، يراه مقيّمك كمرجع إلى جانب تقييمه. لا يُحتسب مباشرة في الدرجة النهائية.</p>
  ${isLocked ? `<div class="card empty-state"><p style="font-size:16px">✔ تقييمك الذاتي مُعتمَد ولا يمكن تعديله</p><p class="small-muted">اعتُمد بتاريخ ${row.selfAssessmentSubmittedAt ? new Date(row.selfAssessmentSubmittedAt).toLocaleDateString("ar") : "—"}، وأصبح مرئيًا لمقيّمك الآن.</p></div>` : ""}
  ${behavioralPillars.map((p) => `
    <div class="card">
      <h3>${esc(p.name)}</h3>
      ${p.criteria.map((c) => rubricSliderHtml(c, current[c.id], isLocked)).join("")}
    </div>`).join("")}
  ${isLocked ? "" : `
  <div class="gap-8">
    <button class="btn" id="saveSelf">حفظ كمسودة</button>
    <button class="btn btn-primary" id="submitSelf">اعتماد تقييمي الذاتي (نهائي)</button>
  </div>`}
  `;
  attachSliderHandlers(el);

  function collectSelfAssessment() {
    const selfAssessment = {};
    behavioralPillars.forEach((p) => {
      p.criteria.forEach((c) => {
        const inp = el.querySelector(`[data-crit="${c.id}"]`);
        if (inp) selfAssessment[c.id] = Number(inp.value);
      });
    });
    return selfAssessment;
  }

  const saveBtn = document.getElementById("saveSelf");
  if (saveBtn) saveBtn.onclick = async () => {
    try {
      await Api.call("upsertSelfAssessment", { auth: authOf(s), payload: { quarter: App.quarter, selfAssessment: collectSelfAssessment() } });
      toast("تم حفظ تقييمك الذاتي كمسودة");
    } catch (err) { toast(err.message); }
  };
  const submitBtn = document.getElementById("submitSelf");
  if (submitBtn) submitBtn.onclick = async () => {
    if (!confirm("بعد الاعتماد لن تتمكني من تعديل تقييمك الذاتي هذا الربع، وسيصبح مرئيًا لمقيّمك. تأكيد الاعتماد؟")) return;
    try {
      await Api.call("upsertSelfAssessment", { auth: authOf(s), payload: { quarter: App.quarter, selfAssessment: collectSelfAssessment() } });
      await Api.call("submitSelfAssessment", { auth: authOf(s), payload: { quarter: App.quarter } });
      toast("تم اعتماد تقييمك الذاتي");
      renderSelfAssessmentView(el);
    } catch (err) { toast(err.message); }
  };
}

function rubricSliderHtml(crit, value, disabled) {
  const v = value ?? 3;
  return `<div class="rubric-item">
    <div class="rubric-title"><span>${esc(crit.name)}</span><span class="score-pill" data-pill="${crit.id}">${v}</span></div>
    <input type="range" min="1" max="5" step="0.5" value="${v}" data-crit="${crit.id}" ${disabled ? "disabled" : ""}>
    <div class="rubric-anchors">
      <span><b>1</b> — ${esc(crit.anchors?.["1"] || "")}</span>
      <span style="text-align:center"><b>3</b> — ${esc(crit.anchors?.["3"] || "")}</span>
      <span style="text-align:left"><b>5</b> — ${esc(crit.anchors?.["5"] || "")}</span>
    </div>
  </div>`;
}
function attachSliderHandlers(scope) {
  scope.querySelectorAll('input[type="range"]').forEach((inp) => {
    inp.oninput = () => {
      const pill = scope.querySelector(`[data-pill="${inp.dataset.crit}"]`);
      if (pill) pill.textContent = inp.value;
    };
  });
}

/* =========================== لوحة الموظف =========================== */
async function renderDashboardView(el) {
  const s = App.session;
  const empId = s.employee.id;
  const [evalRows, workRows] = await Promise.all([
    Api.call("listEval", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } }),
    Api.call("listWork", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } }),
  ]);
  const row = evalRows[0] || null;
  const revealValues = !!(row && row.status === "approved");
  renderStructuredDashboard(el, { employee: s.employee, row, revealValues, title: "لوحتي", workRows, showTopPerformerBanner: true });
}

/** لوحة موحّدة: تعرض بنية كل الركائز والمعايير دائمًا (قسمين: فني/سلوكي)، وتُظهر الدرجات فقط عند revealValues=true. */
function renderStructuredDashboard(el, { employee, row, revealValues, title, workRows, showTopPerformerBanner }) {
  const settings = App.settings;
  const level = employee.level === "senior" ? "senior" : "writer";
  const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
  const applicablePillars = settings.pillars.filter((p) => (p[weightKey] || 0) > 0);
  const technical = applicablePillars.filter((p) => p.category !== "behavioral");
  const behavioral = applicablePillars.filter((p) => p.category === "behavioral");
  const quarter = row?.quarter || App.quarter;

  const statusNote = !row
    ? `<div class="card empty-state"><p style="font-size:16px">لم يبدأ تقييم هذا الربع بعد</p><p class="small-muted">هذا عرض لبنية التقييم ومعاييره الكاملة فقط للاطّلاع المسبق — ستظهر الدرجات فور اعتماد التقييم.</p></div>`
    : !revealValues
    ? `<div class="card empty-state"><p style="font-size:16px">${statusBadge(row.status)}</p><p class="small-muted">هذا عرض لبنية التقييم ومعاييره الكاملة فقط — ستظهر الدرجات فور اعتماد المدير/الإدارة للتقييم.</p></div>`
    : "";

  el.innerHTML = `
  <div class="flex-between">
    <h2>${title} — ${quarter}</h2>
    <button class="btn" id="exportPdfBtn">🖨️ تصدير PDF</button>
  </div>
  <div class="print-eval-sheet">
    <div class="print-header">
      <img src="assets/img/kenayah-logo-black.png" class="print-logo" alt="Kenayah">
      <div><h2 style="margin:0">${esc(employee.name)} — تقييم ${quarter}</h2>
      <p class="small-muted" style="margin:0">${level === "senior" ? "كاتب أول" : "كاتب"} — ${specialtyLabel(employee.specialty)}</p></div>
    </div>
    ${showTopPerformerBanner ? topPerformerBannerHtml(App.settings) : ""}
    ${revealValues ? totalCardHtml(row) : ""}
    ${statusNote}
    <div class="dash-tabs" id="dashTabs">
      <button class="dash-tab-btn active" data-tab="summary">ملخص الأعمال</button>
      <button class="dash-tab-btn" data-tab="technical">القسم الفني</button>
      <button class="dash-tab-btn" data-tab="behavioral">القسم السلوكي والمهاراتي</button>
    </div>
    <div class="dash-tab-panel active" data-panel="summary">
      ${workRows ? workSummaryHtml(workRows) : ""}
      ${pillarsOverviewChartHtml(technical, weightKey, row, revealValues, "نظرة عامة — القسم الفني")}
      ${pillarsOverviewChartHtml(behavioral, weightKey, row, revealValues, "نظرة عامة — القسم السلوكي والمهاراتي")}
    </div>
    <div class="dash-tab-panel" data-panel="technical">
      <div class="card pillar-detail-card">
        <h3>القسم الفني</h3>
        ${technical.map((p) => pillarStructureHtml(p, weightKey, row, revealValues, level)).join("")}
      </div>
    </div>
    <div class="dash-tab-panel" data-panel="behavioral">
      <div class="card pillar-detail-card">
        <h3>القسم السلوكي والمهاراتي</h3>
        ${behavioral.map((p) => pillarStructureHtml(p, weightKey, row, revealValues, level)).join("")}
      </div>
      ${revealValues && row.comments ? `<div class="card"><h3>ملاحظات المقيّم</h3><p>${esc(row.comments)}</p></div>` : ""}
    </div>
  </div>`;
  // تصدير PDF موجز: شرح الدرجات (١/٣/٥) يبقى مطويًا/مخفيًا في الطباعة، والألوان تُطبع كما هي على الشاشة — بند 3.2
  document.getElementById("exportPdfBtn").onclick = () => window.print();
  const tabsWrap = document.getElementById("dashTabs");
  if (tabsWrap) {
    tabsWrap.querySelectorAll(".dash-tab-btn").forEach((btn) => {
      btn.onclick = () => {
        tabsWrap.querySelectorAll(".dash-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
        el.querySelectorAll(".dash-tab-panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === btn.dataset.tab));
      };
    });
  }
}

/** بانر تقدير للموظفين — بالاسم فقط، بدون أي رقم درجة (نُشر يدويًا من الإدارة/المدير). */
function topPerformerBannerHtml(settings) {
  const t = settings?.topPerformerPublished;
  if (!t || (!t.technical && !t.behavioral && !t.overall)) return "";
  const lines = [];
  if (t.technical) lines.push(`🏆 الأعلى فنيًا: <b>${esc(t.technical.name)}</b>`);
  if (t.behavioral) lines.push(`🏆 الأعلى سلوكيًا: <b>${esc(t.behavioral.name)}</b>`);
  if (t.overall) lines.push(`🏆 الأعلى كمجموع: <b>${esc(t.overall.name)}</b>`);
  return `<div class="card top-performer-banner">
    <h3 style="margin-bottom:8px">تقدير الربع — ${esc(t.quarter)}</h3>
    <p style="margin:4px 0">${lines.join("<br>")}</p>
  </div>`;
}

function totalCardHtml(row) {
  return `<div class="card total-score-card">
    <div class="total-score-num">${fmt1(row.totalScore)}<span class="small-muted" style="font-size:16px"> / 5</span></div>
    <div>
      <div class="total-score-classification">${esc(row.classification || "—")}</div>
      <p class="small-muted" style="margin-top:8px">مُعتمَد بواسطة ${esc(row.approvedBy || "—")} — ${row.approvedAt ? new Date(row.approvedAt).toLocaleDateString("ar") : ""}</p>
    </div>
  </div>`;
}

/** شريط درجة رقمي (1-5) بعلامات مرجعية عند 1/3/5 — رسم بياني بديل عن الأعمدة الجافة (بند 3.2). لون واحد ثابت لأن الطول وحده يحمل القيمة. */
function scoreBarHtml(score, revealValues) {
  const has = revealValues && score !== null && score !== undefined;
  const pct = has ? Math.max(0, Math.min(100, ((score - 1) / 4) * 100)) : 0;
  return `<div class="score-bar">
    <div class="score-bar-track">
      <div class="score-bar-fill" style="width:${pct}%"></div>
      <span class="score-bar-tick" style="inset-inline-start:0"></span>
      <span class="score-bar-tick" style="inset-inline-start:50%"></span>
      <span class="score-bar-tick" style="inset-inline-start:100%"></span>
    </div>
    <span class="score-bar-num ${has ? "score-bar-num-has" : "score-bar-num-empty"}">${has ? fmt1(score) : "—"}</span>
  </div>`;
}

/** نظرة عامة سريعة على كل ركائز القسم (فني/سلوكي) كرسم بياني واحد قبل التفاصيل — بند 3.2. */
function pillarsOverviewChartHtml(pillars, weightKey, row, revealValues, heading) {
  if (!pillars.length) return "";
  return `<div class="card pillar-chart">
    <h3>${esc(heading || "نظرة عامة")}</h3>
    ${pillars.map((p) => {
      const pr = row && row.pillarScores ? row.pillarScores[p.id] : null;
      const pillarScore = revealValues ? pr?.pillarScore : null;
      return `<div class="chart-row">
        <div class="chart-row-label"><span>${esc(p.name)}</span><span class="small-muted">(${p[weightKey]}%)</span></div>
        ${scoreBarHtml(pillarScore, revealValues)}
      </div>`;
    }).join("")}
  </div>`;
}

function pillarStructureHtml(p, weightKey, row, revealValues, level) {
  const pr = row && row.pillarScores ? row.pillarScores[p.id] : null;
  const pillarScore = revealValues ? pr?.pillarScore : null;
  const applicableCriteria = p.criteria.filter((c) => !c.appliesToLevel || c.appliesToLevel === level);
  const selfAssessment = row?.selfAssessment || {};
  // عمود "التقييم الذاتي" يظهر فقط إذا كانت هذه الركيزة السلوكية تحمل تقييمًا ذاتيًا لأحد معاييرها (بند 1.5)
  const hasSelfCol = p.category === "behavioral" && applicableCriteria.some((c) => selfAssessment[c.id] !== undefined);
  return `
  <div class="pillar-block">
    <div class="pillar-block-head">
      <h4>${esc(p.name)} <span class="small-muted">(${p[weightKey]}%)</span></h4>
      <b class="pillar-block-score">${revealValues ? fmt1(pillarScore) : "—"}</b>
    </div>
    <div class="criterion-list">
      ${applicableCriteria.map((c) => {
        let weightLabel, score;
        if (p.id === "quality") {
          weightLabel = `${c.weightCreative}% إبداعي / ${c.weightFormal}% رسمي`;
          score = revealValues ? pr?.criteriaAvg?.[c.id] : null;
        } else {
          weightLabel = `${c.weight ?? "—"}%`;
          score = revealValues ? (pr?.criteriaScores?.[c.id] ?? pr?.resolved?.[c.id]) : null;
        }
        const hasScore = score !== null && score !== undefined;
        const selfScore = revealValues ? selfAssessment[c.id] : null;
        const hasSelfScore = selfScore !== null && selfScore !== undefined;
        return `<div class="criterion-card">
          <div class="criterion-head">
            <span class="criterion-name">${esc(c.name)}</span>
            <span class="small-muted criterion-weight">${weightLabel}</span>
          </div>
          <div class="criterion-scores">
            ${hasSelfCol ? `<div class="criterion-score-line"><span class="small-muted">تقييم الكاتب الذاتي</span>${scoreBarHtml(hasSelfScore ? selfScore : null, revealValues)}</div>` : ""}
            <div class="criterion-score-line"><span class="small-muted">تقييم المقيّم</span>${scoreBarHtml(hasScore ? score : null, revealValues)}</div>
          </div>
          ${c.anchors ? anchorLegendHtml(c.anchors, hasScore ? score : null) : ""}
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

/** أقرب درجة مرجعية (1/3/5) لدرجة فعلية قد تكون كسرية. */
function nearestAnchor(score) {
  const opts = [1, 3, 5];
  return opts.reduce((a, b) => (Math.abs(b - score) < Math.abs(a - score) ? b : a));
}

/** دلالة كل درجة من 1-5 لمعيار معيّن — بنافذة منسدلة تُفتح عند الحاجة بدل عرضها دائمًا لكل معيار (بند 3.2). */
function anchorLegendHtml(anchors, score) {
  const nearest = score !== null && score !== undefined ? nearestAnchor(score) : null;
  return `<details class="anchor-details">
    <summary>معايير الدرجات (١ / ٣ / ٥)</summary>
    <div class="anchor-legend">${[5, 3, 1].map((n) => {
      const selected = nearest === n;
      return `<div class="anchor-chip ${selected ? "chip-selected" : ""}">
        <span class="score-pill" style="${selected ? "" : "background:transparent;color:var(--ink-3);border:1px solid var(--ink-3)"}">${n}</span>
        <span>${esc(anchors[String(n)] || "")}</span>
        ${selected ? `<span class="badge badge-approved" style="margin-inline-start:6px">الاختيار الفعلي</span>` : ""}
      </div>`;
    }).join("")}</div>
  </details>`;
}

/* =========================== فريقي (مقيّم) =========================== */
/** كل من تحت هذا الموظف هرميًا (مباشر وغير مباشر) — نسخة واجهة من downlineIds_ بالخادم. */
function clientDownlineIds(employees, rootId) {
  const ids = new Set();
  const frontier = [rootId];
  while (frontier.length) {
    const current = frontier.pop();
    employees.filter((e) => e.managerId === current).forEach((r) => {
      if (!ids.has(r.id)) { ids.add(r.id); frontier.push(r.id); }
    });
  }
  return ids;
}

async function renderTeamView(el) {
  const s = App.session;
  const [employees, evalRows] = await Promise.all([
    Api.call("listEmployees", { auth: authOf(s) }),
    Api.call("listEval", { auth: authOf(s), payload: { quarter: App.quarter } }),
  ]);
  const reports = employees.filter((e) => e.id !== s.employee.id && e.managerId === s.employee.id);
  // كل من تحتك هرميًا بخلاف تقاريرك المباشرين (المستوى الثاني فأعمق) — للاطّلاع الكامل على الفريق وتقييماته
  const directIds = new Set(reports.map((r) => r.id));
  const extendedTeam = employees.filter((e) => e.isWriter && e.id !== s.employee.id && !directIds.has(e.id));

  // تقييمات فريق تحت إشراف أعضاء فريقي المباشرين (تدقيق/اعتماد على مستوى ثانٍ) بانتظار اعتمادي —
  // مقصورة فعليًا على مقيّمين تحت إشرافي هرميًا (لا أي تقييم مُرسَل بالنظام كله بالخطأ).
  const myDownlineIds = clientDownlineIds(employees, s.employee.id);
  const pendingApprovals = evalRows.filter((e) => e.status === "submitted" && e.evaluatorId && e.evaluatorId !== s.employee.id && myDownlineIds.has(e.evaluatorId));

  // "موظف الربع" — متاح الآن لأي مقيّم (لا فقط الإدارة/المدير)، بنطاق فريقه فعليًا (downline + نفسه إن
  // كان كاتبًا)، مطابقًا تمامًا لنطاق topPerformerWritersScope_ على الخادم — يظهر دائمًا في "فريقي".
  const myWriterScope = employees.filter((e) => e.isWriter && (e.id === s.employee.id || myDownlineIds.has(e.id)));
  const topPerformersHtml = await topPerformerSectionHtml(s, myWriterScope);

  el.innerHTML = `
  <h2>فريقي — ${App.quarter}</h2>
  ${topPerformersHtml}
  ${pendingApprovals.length ? `
  <div class="card">
    <h3>بانتظار اعتمادك</h3>
    <p class="small-muted">تقييمات أرسلها مقيّمون تحت إشرافك، جاهزة للتدقيق والاعتماد.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>الموظف</th><th>المقيّم</th><th>الدرجة</th><th>التصنيف</th><th></th></tr></thead>
      <tbody>${pendingApprovals.map((ev) => {
        const emp = employees.find((e) => e.id === ev.employeeId);
        const evaluator = employees.find((e) => e.id === ev.evaluatorId);
        return `<tr>
          <td>${esc(emp?.name || ev.employeeId)}</td>
          <td>${esc(evaluator?.name || "—")}</td>
          <td>${fmt1(ev.totalScore)}</td>
          <td>${esc(ev.classification || "—")}</td>
          <td class="gap-8">
            <button class="btn btn-sm review-go" data-emp="${ev.employeeId}" data-eval-owner="${ev.evaluatorId}">مراجعة التفاصيل</button>
            <button class="btn btn-sm btn-primary approve-go" data-id="${ev.id}">اعتماد</button>
          </td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>` : ""}
  <div class="card">
    <h3>فريقي المباشر</h3>
    <div class="table-wrap">
    <table>
      <thead><tr><th>الاسم</th><th>المستوى</th><th>التخصص</th><th>حالة تقييم الربع</th><th>الدرجة</th><th></th></tr></thead>
      <tbody>
        ${reports.map((r) => {
          const ev = evalRows.find((e) => e.employeeId === r.id);
          return `<tr>
            <td>${esc(r.name)}</td>
            <td>${r.level === "senior" ? "كاتب أول" : "كاتب"}</td>
            <td>${specialtyLabel(r.specialty)}</td>
            <td>${statusBadge(ev?.status)}</td>
            <td>${fmt1(ev?.totalScore)}</td>
            <td class="gap-8">
              <button class="btn btn-sm eval-go" data-id="${r.id}">فتح التقييم</button>
              <button class="btn btn-sm btn-ghost review-go" data-emp="${r.id}">عرض/تصدير</button>
            </td>
          </tr>`;
        }).join("") || `<tr><td colspan="6" class="empty-state">لا يوجد أعضاء فريق مباشرين مسجّلين بعد</td></tr>`}
      </tbody>
    </table>
    </div>
  </div>
  ${extendedTeam.length ? `
  <div class="card">
    <h3>الفريق الكامل تحت إشرافك</h3>
    <p class="small-muted">كل من هم تحت إشرافك غير المباشر (يُقيَّمهم أحد مقيّميك)، بغض النظر عن حالة تقييمهم — للاطّلاع الكامل على الفريق وتقييماته.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>الاسم</th><th>المستوى</th><th>يُقيَّم من</th><th>حالة تقييم الربع</th><th>الدرجة</th><th></th></tr></thead>
      <tbody>${extendedTeam.map((r) => {
        const ev = evalRows.find((e) => e.employeeId === r.id);
        const evaluator = employees.find((e) => e.id === r.managerId);
        return `<tr>
          <td>${esc(r.name)}</td>
          <td>${r.level === "senior" ? "كاتب أول" : "كاتب"}</td>
          <td>${esc(evaluator?.name || "—")}</td>
          <td>${statusBadge(ev?.status)}</td>
          <td>${fmt1(ev?.totalScore)}</td>
          <td><button class="btn btn-sm review-go" data-emp="${r.id}">عرض التفاصيل</button></td>
        </tr>`;
      }).join("")}</tbody>
    </table></div>
  </div>` : ""}`;
  el.querySelectorAll(".eval-go").forEach((b) => (b.onclick = () => { App.evalTargetId = b.dataset.id; App.view = "evaluate"; renderShell(); }));
  el.querySelectorAll(".approve-go").forEach((b) => (b.onclick = async () => {
    if (!confirm("تأكيد اعتماد هذا التقييم؟ سيصبح مرئيًا للموظف فور الاعتماد.")) return;
    try {
      await Api.call("approveEval", { auth: authOf(s), payload: { id: b.dataset.id } });
      toast("تم الاعتماد");
      renderTeamView(el);
    } catch (err) { toast(err.message); }
  }));
  el.querySelectorAll(".review-go").forEach((b) => (b.onclick = () => {
    App.reviewTargetId = b.dataset.emp;
    App.view = "review";
    renderShell();
  }));
  wireTopPerformerButtons(el, s, () => renderTeamView(el));
}

/* عرض قراءة فقط لتفاصيل تقييم موظف تحت إشراف غير مباشر (للتدقيق قبل الاعتماد) */
async function renderReviewView(el) {
  const s = App.session;
  const empId = App.reviewTargetId;
  if (!empId) { el.innerHTML = `<div class="empty-state">اختر تقييمًا من «فريقي» للمراجعة</div>`; return; }
  const [employees, evalRows, workRows] = await Promise.all([
    Api.call("listEmployees", { auth: authOf(s) }),
    Api.call("listEval", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } }),
    Api.call("listWork", { auth: authOf(s), payload: { employeeId: empId, quarter: App.quarter } }),
  ]);
  const employee = employees.find((e) => e.id === empId);
  const row = evalRows[0];
  if (!row) { el.innerHTML = `<div class="empty-state">لا يوجد تقييم لعرضه</div>`; return; }
  renderStructuredDashboard(el, { employee, row, revealValues: true, title: `مراجعة تقييم — ${employee?.name || ""}`, workRows });
  if (row.status === "submitted") {
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.textContent = "اعتماد التقييم";
    btn.onclick = async () => {
      try {
        await Api.call("approveEval", { auth: authOf(s), payload: { id: row.id } });
        toast("تم الاعتماد");
        App.view = "team";
        renderShell();
      } catch (err) { toast(err.message); }
    };
    el.appendChild(btn);
  }
}

function specialtyLabel(s) { return { creative: "إبداعي", formal: "مؤسسي/رسمي", general: "عام" }[s] || "عام"; }
function statusBadge(st) {
  const map = { draft: ["مسودة", "badge-draft"], submitted: ["مُرسَل للاعتماد", "badge-submitted"], approved: ["مُعتمَد", "badge-approved"] };
  const [label, cls] = map[st] || ["لم يبدأ", "badge-draft"];
  return `<span class="badge ${cls}">${label}</span>`;
}

/* =========================== شاشة التقييم (مقيّم) =========================== */
async function renderEvaluateView(el) {
  const s = App.session;
  const employees = await Api.call("listEmployees", { auth: authOf(s) });
  const reports = employees.filter((e) => e.id !== s.employee.id && e.managerId === s.employee.id);
  if (!reports.length) { el.innerHTML = `<div class="empty-state">لا يوجد أعضاء فريق لتقييمهم</div>`; return; }
  const targetId = App.evalTargetId && reports.find((r) => r.id === App.evalTargetId) ? App.evalTargetId : reports[0].id;
  App.evalTargetId = targetId;
  const employee = reports.find((r) => r.id === targetId);

  el.innerHTML = `
  <div class="flex-between">
    <h2>تقييم — ${App.quarter}</h2>
    <div class="pill-select" id="targetPicker">${reports.map((r) => `<button data-id="${r.id}" class="${r.id === targetId ? "active" : ""}">${esc(r.name)}</button>`).join("")}</div>
  </div>
  <div id="evalBody"><div class="empty-state"><span class="spinner"></span></div></div>`;

  el.querySelectorAll("#targetPicker button").forEach((b) => (b.onclick = () => { App.evalTargetId = b.dataset.id; renderEvaluateView(el); }));

  const [workRows, behavioralRows, evalRows] = await Promise.all([
    Api.call("listWork", { auth: authOf(s), payload: { employeeId: targetId, quarter: App.quarter } }),
    Api.call("listBehavioral", { auth: authOf(s), payload: { employeeId: targetId, quarter: App.quarter } }),
    Api.call("listEval", { auth: authOf(s), payload: { employeeId: targetId, quarter: App.quarter } }),
  ]);
  const existing = evalRows[0] || null;
  renderEvalForm(document.getElementById("evalBody"), employee, workRows, behavioralRows, existing);
}

function renderEvalForm(el, employee, workRows, behavioralRows, existing) {
  const settings = App.settings;
  const level = employee.level === "senior" ? "senior" : "writer";
  const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
  const input = existing?.pillarScores ? JSON.parse(JSON.stringify(existing.pillarScores)) : {};
  const selfAssessment = existing?.selfAssessment || {};
  const metrics = Calc.computeMetrics(workRows);

  const qualityPillar = settings.pillars.find((p) => p.id === "quality");
  // لا عيّنة: يُقيَّم كل عمل مسجَّل هذا الربع بلا استثناء — تُحدَّث القائمة تلقائيًا مع أي عمل يُضاف لاحقًا
  input.quality = input.quality || { sampleWorkIds: [], perSample: {} };
  input.quality.sampleWorkIds = workRows.map((w) => w.id);

  el.innerHTML = `
  <div class="card">
    <div class="flex-between">
      <div><h3>${esc(employee.name)}</h3><p class="small-muted">${level === "senior" ? "كاتب أول" : "كاتب"} — ${specialtyLabel(employee.specialty)} — الحالة: ${statusBadge(existing?.status)}</p></div>
      <div id="liveTotal" style="text-align:end"><div class="total-score-num" style="font-size:32px">—</div></div>
    </div>
  </div>

  <div class="card">
    <h3>١. ${esc(qualityPillar.name)} <span class="small-muted">(${qualityPillar[weightKey]}%)</span></h3>
    <p class="small-muted">${workRows.length
      ? `يُقيَّم كل عمل مسجَّل هذا الربع (${workRows.length} عمل) — بلا استثناء ولا اختيار عيّنة.`
      : `لا توجد أعمال مسجّلة لهذا الربع — أضفها من «سجل الأعمال» أولًا.`}</p>
    <div id="sampleForms"></div>
  </div>

  ${settings.pillars.filter((p) => p.id !== "quality" && (p[weightKey] || 0) > 0).map((p) => pillarFormHtml(p, level, input, metrics, selfAssessment)).join("")}

  <div class="card">
    <h3>ملاحظات المقيّم</h3>
    <textarea id="evalComments" rows="3">${esc(existing?.comments || "")}</textarea>
  </div>

  <div class="flex-between">
    <div class="gap-8">
      <button class="btn" id="saveDraft">حفظ كمسودة</button>
      <button class="btn btn-amber" id="submitEval">إرسال للاعتماد</button>
      ${existing?.status === "submitted" ? `<button class="btn btn-primary" id="approveEval">اعتماد التقييم</button>` : ""}
    </div>
    ${existing?.status === "approved" ? `<span class="badge badge-approved">مُعتمَد ✔ — لا يمكن التعديل إلا عبر إعادة الفتح من الإدارة</span>` : ""}
  </div>`;

  renderSampleForms();
  attachSliderHandlers(el);
  recomputeLive();

  function renderSampleForms() {
    const box = el.querySelector("#sampleForms");
    const ids = input.quality.sampleWorkIds;
    if (!ids.length) { box.innerHTML = `<p class="small-muted">اختر عملًا واحدًا على الأقل من الأعلى.</p>`; return; }
    box.innerHTML = ids.map((wid) => {
      const w = workRows.find((x) => x.id === wid);
      input.quality.perSample[wid] = input.quality.perSample[wid] || {};
      return `<div class="divider"></div><b>${esc(w?.title || wid)}</b>` +
        qualityPillar.criteria.map((c) => rubricSliderHtml(c, input.quality.perSample[wid][c.id])).join("");
    }).join("");
    box.querySelectorAll('input[type="range"]').forEach((inp) => {
      inp.oninput = () => recomputeLive();
      inp.addEventListener("change", () => recomputeLive());
    });
  }

  function collectInput() {
    // quality: read sliders back into perSample
    const ids = input.quality.sampleWorkIds;
    ids.forEach((wid, idx) => {
      const group = el.querySelectorAll("#sampleForms .rubric-item");
    });
    // simpler: query by nested structure using data attributes with work id embedded
    return input;
  }

  function recomputeLive() {
    // sync quality perSample from sliders (each rubric-item block belongs sequentially per sample)
    const box = el.querySelector("#sampleForms");
    const blocks = box.querySelectorAll(".rubric-item");
    let idx = 0;
    input.quality.sampleWorkIds.forEach((wid) => {
      qualityPillar.criteria.forEach((c) => {
        const block = blocks[idx];
        if (block) {
          const slider = block.querySelector(`input[data-crit="${c.id}"]`);
          if (slider) input.quality.perSample[wid][c.id] = Number(slider.value);
        }
        idx++;
      });
    });
    // sync other pillars
    settings.pillars.filter((p) => p.id !== "quality").forEach((p) => {
      input[p.id] = input[p.id] || { criteriaScores: {} };
      p.criteria.forEach((c) => {
        const inp = el.querySelector(`[data-pillar="${p.id}"][data-crit="${c.id}"]`);
        if (inp) {
          const val = inp.value;
          input[p.id].criteriaScores[c.id] = val === "" ? null : Number(val);
        }
      });
    });
    const full = Calc.computeFullEvaluation(settings, employee, input, workRows);
    const liveTotal = document.getElementById("liveTotal");
    if (liveTotal) {
      liveTotal.innerHTML =
        `<div class="total-score-num" style="font-size:32px">${full.totalScore ?? "—"}</div><div class="small-muted">${full.classification || "بيانات ناقصة"}</div>`;
    }
    return full;
  }

  async function persist(status) {
    recomputeLive();
    const full = Calc.computeFullEvaluation(settings, employee, input, workRows);
    // ندمج المدخلات الخام (القابلة لإعادة التحرير) مع النتائج المحسوبة (لعرضها في اللوحات دون إعادة حساب)
    const combined = {};
    for (const p of settings.pillars) {
      if ((p[weightKey] || 0) === 0) continue; // ركيزة لا تنطبق على هذا المستوى — لا تُحفظ بيانات فارغة لها
      combined[p.id] = { ...(input[p.id] || {}), ...(full.pillars[p.id] || {}) };
    }
    const row = {
      id: existing?.id,
      employeeId: employee.id,
      quarter: App.quarter,
      status,
      pillarScores: combined,
      totalScore: full.totalScore,
      classification: full.classification,
      comments: document.getElementById("evalComments").value.trim(),
    };
    try {
      const saved = await Api.call("upsertEval", { auth: authOf(App.session), payload: { row } });
      toast(status === "submitted" ? "أُرسل للاعتماد" : "تم الحفظ كمسودة");
      existing = saved;
      renderEvaluateView(document.getElementById("mainArea"));
    } catch (err) { toast(err.message); }
  }

  document.getElementById("saveDraft").onclick = () => persist("draft");
  document.getElementById("submitEval").onclick = () => persist("submitted");
  const approveBtn = document.getElementById("approveEval");
  if (approveBtn) {
    approveBtn.onclick = async () => {
      try {
        await Api.call("approveEval", { auth: authOf(App.session), payload: { id: existing.id } });
        toast("تم اعتماد التقييم — أصبح مرئيًا للموظف الآن");
        renderEvaluateView(document.getElementById("mainArea"));
      } catch (err) { toast(err.message); }
    };
  }
}

function pillarFormHtml(p, level, input, metrics, selfAssessment) {
  const weightKey = level === "senior" ? "weightSenior" : "weightWriter";
  input[p.id] = input[p.id] || { criteriaScores: {} };
  const applicable = p.criteria.filter((c) => !c.appliesToLevel || c.appliesToLevel === level);
  return `<div class="card">
    <h3>${esc(p.name)} <span class="small-muted">(${p[weightKey]}%)</span></h3>
    ${applicable.map((c) => {
      if (c.type === "ratio") {
        const val = metrics[c.metric];
        const auto = Calc.scoreFromBand(val, c.bands, c.higherIsBetter);
        const current = input[p.id].criteriaScores[c.id];
        return `<div class="rubric-item">
          <div class="rubric-title"><span>${esc(c.name)}</span><span class="small-muted">محسوبة تلقائيًا من سجل الأعمال: ${val === null ? "لا بيانات" : fmt1(val) + c.unit}</span></div>
          <label class="small-muted">الدرجة (${fmt1(auto) || "—"} تلقائيًا — يمكن تعديلها يدويًا عند الحاجة)</label>
          <input type="range" min="1" max="5" step="0.1" value="${current ?? auto ?? 3}" data-pillar="${p.id}" data-crit="${c.id}">
        </div>`;
      }
      const selfVal = selfAssessment[c.id];
      return `<div class="rubric-item">
        <div class="rubric-title"><span>${esc(c.name)}${selfVal ? ` <span class="small-muted">— تقييم الكاتب الذاتي: ${selfVal}</span>` : ""}</span>
        <span class="score-pill" data-pill="${p.id}-${c.id}">${input[p.id].criteriaScores[c.id] ?? 3}</span></div>
        <input type="range" min="1" max="5" step="0.5" value="${input[p.id].criteriaScores[c.id] ?? 3}" data-pillar="${p.id}" data-crit="${c.id}" data-pillslider="${p.id}-${c.id}">
        ${c.anchors ? `<div class="rubric-anchors">
          <span><b>1</b> — ${esc(c.anchors["1"] || "")}</span>
          <span style="text-align:center"><b>3</b> — ${esc(c.anchors["3"] || "")}</span>
          <span style="text-align:left"><b>5</b> — ${esc(c.anchors["5"] || "")}</span></div>` : ""}
      </div>`;
    }).join("")}
  </div>`;
}

// اربط شرائح المعايير غير-الجودة بمؤشر النقطة (score-pill) عند التحريك
document.addEventListener("input", (e) => {
  if (e.target.matches('input[type="range"][data-pillslider]')) {
    const pill = document.querySelector(`[data-pill="${e.target.dataset.pillslider}"]`);
    if (pill) pill.textContent = e.target.value;
  }
});

/* =========================== إدارة: نظرة عامة =========================== */
/** مجموع فرعي مرجّح (فني أو سلوكي فقط) من pillarScores لتقييم واحد — يعيد null إن كانت التفاصيل غير متاحة (تقييم مُصفّى/redacted) أو غير مكتملة. */
function categorySubtotal(row, employee, settings, category) {
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

/** بند 3.3 — "موظف الربع الماضي": الأفضل حسب 3 معايير منفصلة (فني/سلوكي/مجموع)، من تقييمات مُعتمَدة فقط لربع محدَّد. */
function topPerformerCardHtml(label, best) {
  if (!best) return `<div class="top-performer-card"><div class="tp-label">${esc(label)}</div><p class="small-muted" style="margin:0">لا تتوفر بيانات كافية</p></div>`;
  return `<div class="top-performer-card">
    <div class="tp-label">${esc(label)}</div>
    <div class="tp-name">${esc(best.name)}</div>
    <div class="tp-score">${fmt1(best.value)} / 5</div>
  </div>`;
}

/** بطاقة نشر/إلغاء نشر "موظف الربع الماضي" — مشتركة بين نظرة إدارة (كل الكتّاب) وشاشة "فريقي" لأي
 * مقيّم (نطاقه فقط). تظهر دائمًا مع زر النشر، حتى قبل توفر أي تقييمات معتمدة — طلب صريح؛ لا تنتظر
 * "طلوع الدرجات". النطاق الفعلي (من يُرشَّح) يُطبَّق أصلًا على الخادم حسب الفاعل (topPerformerWritersScope_). */
async function topPerformerSectionHtml(s, writers) {
  const prevQuarter = Store.quarterOptions()[1];
  if (!prevQuarter) return "";
  const prevEvalRows = await Api.call("listEval", { auth: authOf(s), payload: { quarter: prevQuarter } });
  const approvedPrev = prevEvalRows.filter((e) => e.status === "approved");
  const withEmployee = approvedPrev.map((ev) => ({ ev, emp: writers.find((w) => w.id === ev.employeeId) })).filter((x) => x.emp);
  const pickBest = (valueFn) => {
    let best = null;
    withEmployee.forEach(({ ev, emp }) => {
      const value = valueFn(ev, emp);
      if (value === null || value === undefined) return;
      if (!best || value > best.value) best = { name: emp.name, value };
    });
    return best;
  };
  const bestTechnical = pickBest((ev, emp) => categorySubtotal(ev, emp, App.settings, "technical"));
  const bestBehavioral = pickBest((ev, emp) => categorySubtotal(ev, emp, App.settings, "behavioral"));
  const bestOverall = pickBest((ev) => (ev.totalScore === null || ev.totalScore === undefined ? null : ev.totalScore));
  const detailUnavailable = withEmployee.length > 0 && !bestTechnical && !bestBehavioral;

  const published = App.settings.topPerformerPublished;
  const isPublished = !!published;
  const isCurrent = isPublished && published.quarter === prevQuarter;
  const isStale = isPublished && !isCurrent;
  const publishControlsHtml = `
    <div class="flex-between" style="margin-top:10px; flex-wrap:wrap; gap:10px">
      ${isCurrent
        ? `<span class="badge badge-approved">منشور بالاسم فقط (بدون درجات)</span>`
        : isStale
        ? `<span class="badge badge-submitted">⚠️ منشور حاليًا لكن من ربع سابق (${esc(published.quarter)}) — حدّثيه أو ألغِه</span>`
        : `<span class="small-muted">غير منشور بعد — يظهر بالاسم فقط دون أي رقم.</span>`}
      <div class="gap-8">
        ${isStale ? `<button class="btn btn-primary" id="topPerfPublishBtn" data-action="publish">تحديث النشر لهذا الربع</button>
        <button class="btn btn-ghost" id="topPerfUnpublishBtn" data-action="unpublish">إلغاء النشر</button>` : ""}
        ${isCurrent ? `<button class="btn btn-ghost" id="topPerfUnpublishBtn" data-action="unpublish">إلغاء النشر</button>` : ""}
        ${!isPublished ? `<button class="btn btn-primary" id="topPerfPublishBtn" data-action="publish">📣 نشر موظف الربع</button>` : ""}
      </div>
    </div>`;

  return `
  <div class="card">
    <h3>موظف الربع الماضي <span class="small-muted">— ${esc(prevQuarter)}</span></h3>
    ${!withEmployee.length
      ? `<p class="small-muted">لا توجد تقييمات مُعتمَدة لهذا الربع بعد ضمن نطاقك — يمكنك النشر لاحقًا حال توفرها.</p>`
      : `<div class="top-performer-grid">
          ${topPerformerCardHtml("الأعلى فنيًا", bestTechnical)}
          ${topPerformerCardHtml("الأعلى سلوكيًا", bestBehavioral)}
          ${topPerformerCardHtml("الأعلى كمجموع", bestOverall)}
        </div>
        ${detailUnavailable ? `<p class="small-muted">تفصيل الفني/السلوكي غير متاح لهذا الحساب — الإدارة العامة ترى الدرجة الإجمالية فقط، حفاظًا على خصوصية التقييم.</p>` : ""}`}
    ${publishControlsHtml}
  </div>`;
}

/** ربط أزرار النشر/إلغاء النشر بعد إدراج topPerformerSectionHtml في innerHTML — لأي شاشة تستخدمها. */
function wireTopPerformerButtons(el, s, rerender) {
  const prevQuarter = Store.quarterOptions()[1];
  const publishBtn = el.querySelector("#topPerfPublishBtn");
  if (publishBtn) publishBtn.onclick = async () => {
    try {
      await Api.call("publishTopPerformer", { auth: authOf(s), payload: { quarter: prevQuarter } });
      toast("نُشر بالاسم فقط");
      App.settings = await Api.call("getSettings", { auth: authOf(s) });
      rerender();
    } catch (err) { toast(err.message); }
  };
  const unpublishBtn = el.querySelector("#topPerfUnpublishBtn");
  if (unpublishBtn) unpublishBtn.onclick = async () => {
    try {
      await Api.call("unpublishTopPerformer", { auth: authOf(s) });
      toast("أُلغي النشر");
      App.settings = await Api.call("getSettings", { auth: authOf(s) });
      rerender();
    } catch (err) { toast(err.message); }
  };
}

async function renderAdminOverviewView(el) {
  const s = App.session;
  const [employees, evalRows] = await Promise.all([
    Api.call("listEmployees", { auth: authOf(s) }),
    Api.call("listEval", { auth: authOf(s), payload: { quarter: App.quarter } }),
  ]);
  const writers = employees.filter((e) => e.isWriter);
  const topPerformersHtml = await topPerformerSectionHtml(s, writers);

  el.innerHTML = `
  <div class="flex-between"><h2>نظرة عامة — ${App.quarter}</h2>
  <select id="qSel2">${Store.quarterOptions().map((q) => `<option ${q === App.quarter ? "selected" : ""}>${q}</option>`).join("")}</select></div>
  ${topPerformersHtml}
  <p class="small-muted">تعرض الإدارة الحالة والدرجة الإجمالية فقط، دون تفاصيل المعايير أو تعليقات المقيّم، حفاظًا على خصوصية التقييم.</p>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>الاسم</th><th>المستوى</th><th>المقيّم</th><th>الحالة</th><th>الدرجة</th><th>التصنيف</th><th></th></tr></thead>
    <tbody>${writers.map((w) => {
      const ev = evalRows.find((e) => e.employeeId === w.id);
      const manager = employees.find((m) => m.id === w.managerId);
      return `<tr><td>${esc(w.name)}</td><td>${w.level === "senior" ? "كاتب أول" : "كاتب"}</td><td>${esc(manager?.name || "—")}</td>
      <td>${statusBadge(ev?.status)}</td><td>${fmt1(ev?.totalScore)}</td><td>${esc(ev?.classification || "—")}</td>
      <td><button class="btn btn-sm review-go" data-emp="${w.id}">عرض/تصدير</button></td></tr>`;
    }).join("")}</tbody>
  </table></div></div>`;
  document.getElementById("qSel2").onchange = (e) => { App.quarter = e.target.value; renderAdminOverviewView(el); };
  // فتح نفس صفحة "لوحتي" (للعرض والتصدير PDF فقط) لأي موظف — الإدارة العامة ترى نسخة مُلخَّصة بحكم إخفاء تفاصيل التقييم عنها من الخادم أصلًا
  el.querySelectorAll(".review-go").forEach((b) => (b.onclick = () => {
    App.reviewTargetId = b.dataset.emp;
    App.view = "review";
    renderShell();
  }));
  wireTopPerformerButtons(el, s, () => renderAdminOverviewView(el));
}

/* =========================== إدارة: الموظفون =========================== */
async function renderEmployeesView(el) {
  const s = App.session;
  const employees = await Api.call("listEmployees", { auth: authOf(s) });
  el.innerHTML = `
  <div class="flex-between"><h2>الموظفون</h2><button class="btn btn-primary" id="addEmp">+ إضافة موظف</button></div>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>الاسم</th><th>الصفات</th><th>المستوى</th><th>التخصص</th><th>يُقيَّم من</th><th>الأكواد</th><th></th></tr></thead>
    <tbody>${employees.map((e) => `<tr>
      <td>${esc(e.name)}</td>
      <td>${e.isWriter ? '<span class="badge badge-general">كاتب</span>' : ""} ${e.isEvaluator ? '<span class="badge badge-formal">مقيّم</span>' : ""}</td>
      <td>${e.level === "senior" ? "أول" : e.level === "writer" ? "كاتب" : "—"}</td>
      <td>${e.specialty ? specialtyLabel(e.specialty) : "—"}</td>
      <td>${esc(employees.find((m) => m.id === e.managerId)?.name || "—")}</td>
      <td>${e.writerCode ? `<div class="mono-code">${e.writerCode}</div>` : ""}${e.evaluatorCode ? `<div class="mono-code">${e.evaluatorCode}</div>` : ""}</td>
      <td class="gap-8"><button class="icon-btn edit-e" data-id="${e.id}">تعديل</button>${e.id !== "manager" ? `<button class="icon-btn text-danger del-e" data-id="${e.id}">حذف</button>` : ""}</td>
    </tr>`).join("")}</tbody>
  </table></div></div>`;

  document.getElementById("addEmp").onclick = () => openEmployeeModal(null, employees, () => renderEmployeesView(el));
  el.querySelectorAll(".edit-e").forEach((b) => (b.onclick = () => openEmployeeModal(employees.find((e) => e.id === b.dataset.id), employees, () => renderEmployeesView(el))));
  el.querySelectorAll(".del-e").forEach((b) => (b.onclick = async () => {
    const emp = employees.find((e) => e.id === b.dataset.id);
    if (!confirm(`تأكيد حذف "${emp.name}"؟ سيبقى سجل أعماله وتقييماته السابقة محفوظًا.`)) return;
    try { await Api.call("deleteEmployee", { auth: authOf(s), payload: { id: emp.id } }); toast("تم الحذف"); renderEmployeesView(el); }
    catch (err) { toast(err.message); }
  }));
}

function genCode(prefix) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 4; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${out}`;
}

function openEmployeeModal(existing, employees, onSaved) {
  const s = App.session;
  const evaluators = employees.filter((e) => e.isEvaluator);
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.innerHTML = `
  <div class="modal">
    <h3>${existing ? "تعديل موظف" : "إضافة موظف"}</h3>
    <div class="field"><label>الاسم</label><input type="text" id="f_name" value="${esc(existing?.name || "")}"></div>
    <div class="checkbox-row"><input type="checkbox" id="f_isw" ${existing?.isWriter !== false ? "checked" : ""}><label>كاتب (له سجل أعمال وتقييم)</label></div>
    <div class="checkbox-row"><input type="checkbox" id="f_ise" ${existing?.isEvaluator ? "checked" : ""}><label>مقيّم / مدير مباشر (له فريق يقيّمه)</label></div>
    <div class="checkbox-row" id="f_cfaWrap" style="display:${existing?.isEvaluator ? "flex" : "none"}">
      <input type="checkbox" id="f_cfa" ${existing?.canFinalApprove ? "checked" : ""}>
      <label>صلاحية الاعتماد النهائي لتقييمات فريقه مباشرة (دون العودة لمديره)</label>
    </div>
    <div class="grid grid-2">
      <div class="field"><label>المستوى</label><select id="f_level">
        <option value="writer" ${existing?.level === "writer" ? "selected" : ""}>كاتب</option>
        <option value="senior" ${existing?.level === "senior" ? "selected" : ""}>كاتب أول</option></select></div>
      <div class="field"><label>نوع التخصص</label><select id="f_spec">
        <option value="creative" ${existing?.specialty === "creative" ? "selected" : ""}>إبداعي</option>
        <option value="formal" ${existing?.specialty === "formal" ? "selected" : ""}>مؤسسي/رسمي</option>
        <option value="general" ${!existing || existing?.specialty === "general" ? "selected" : ""}>عام (أوزان ديناميكية)</option></select></div>
    </div>
    <div class="field"><label>يُقيَّم من (المدير المباشر)</label><select id="f_mgr">
      <option value="">— بدون —</option>
      ${evaluators.filter((ev) => ev.id !== existing?.id).map((ev) => `<option value="${ev.id}" ${existing?.managerId === ev.id ? "selected" : ""}>${esc(ev.name)}</option>`).join("")}
    </select></div>
    <div class="flex-between">
      <button class="btn btn-ghost" id="cancelModal">إلغاء</button>
      <button class="btn btn-primary" id="saveModal">حفظ</button>
    </div>
  </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector("#cancelModal").onclick = () => backdrop.remove();
  document.getElementById("f_ise").onchange = (e) => {
    document.getElementById("f_cfaWrap").style.display = e.target.checked ? "flex" : "none";
  };
  backdrop.querySelector("#saveModal").onclick = async () => {
    const isWriter = document.getElementById("f_isw").checked;
    const isEvaluator = document.getElementById("f_ise").checked;
    const row = {
      id: existing?.id,
      name: document.getElementById("f_name").value.trim(),
      isWriter, isEvaluator,
      canFinalApprove: isEvaluator ? document.getElementById("f_cfa").checked : false,
      level: isWriter ? document.getElementById("f_level").value : null,
      specialty: isWriter ? document.getElementById("f_spec").value : null,
      managerId: document.getElementById("f_mgr").value || null,
      writerCode: existing?.writerCode || (isWriter ? genCode("W") : null),
      evaluatorCode: existing?.evaluatorCode || (isEvaluator ? genCode("EV") : null),
      active: true,
    };
    if (isWriter && !row.writerCode) row.writerCode = genCode("W");
    if (isEvaluator && !row.evaluatorCode) row.evaluatorCode = genCode("EV");
    if (!row.name) return toast("الاسم مطلوب");
    try {
      await Api.call("upsertEmployee", { auth: authOf(s), payload: { row } });
      toast("تم الحفظ");
      backdrop.remove();
      onSaved();
    } catch (err) { toast(err.message); }
  };
}

/* =========================== إدارة: الإعدادات (المعايير والأوزان) =========================== */
async function renderSettingsView(el) {
  const s = App.session;
  const settings = App.settings;
  el.innerHTML = `
  <h2>المعايير والأوزان</h2>
  <p>القيم الابتدائية معتمدة من استراتيجية تطوير فريق الكتابة، وهي قابلة للتعديل الكامل هنا.</p>
  <p class="small-muted">ملاحظة: التقييم يشمل كل الأعمال المسجّلة في سجل الأعمال هذا الربع — بلا عيّنة أو اختيار جزئي.</p>
  <div class="card">
    <div class="field"><label>قيمة المراجعة/التعديل المخفَّضة (0-1)</label><input type="number" step="0.1" id="revMult" value="${settings.revisionValueMultiplier}"></div>
  </div>
  <div id="pillarsBox"></div>
  <div class="card"><h3>تصنيف الدرجة الكلية</h3><div id="classBox"></div>
    <button class="btn btn-sm" id="addClass">+ إضافة نطاق</button></div>
  <div class="flex-between">
    <button class="btn" id="changePwd">تغيير كلمة مرور الإدارة</button>
    <button class="btn btn-primary" id="saveSettings">حفظ كل التعديلات</button>
  </div>`;

  const pillarsBox = document.getElementById("pillarsBox");
  const drawPillars = () => {
    pillarsBox.innerHTML = settings.pillars.map((p, pi) => `
    <div class="card">
      <div class="flex-between">
        <input type="text" value="${esc(p.name)}" data-p="${pi}" class="pName" style="font-weight:700;max-width:320px">
        <button class="icon-btn text-danger delPillar" data-p="${pi}">حذف الركيزة</button>
      </div>
      <div class="grid grid-3">
        <div class="field"><label>وزن (كاتب) %</label><input type="number" class="pW pWriter" data-p="${pi}" value="${p.weightWriter}"></div>
        <div class="field"><label>وزن (كاتب أول) %</label><input type="number" class="pW pSenior" data-p="${pi}" value="${p.weightSenior}"></div>
        <div class="field"><label>القسم في لوحة الكاتب</label><select class="pCategory" data-p="${pi}">
          <option value="technical" ${p.category !== "behavioral" ? "selected" : ""}>القسم الفني</option>
          <option value="behavioral" ${p.category === "behavioral" ? "selected" : ""}>القسم السلوكي والمهاراتي</option>
        </select></div>
      </div>
      <div class="small-muted">مجموع أوزان الكاتب حاليًا: <b id="sumWriter">${sumWeights("weightWriter")}%</b> — مجموع أوزان الكاتب الأول: <b id="sumSenior">${sumWeights("weightSenior")}%</b> (يجب أن يساوي 100%)</div>
      <div class="divider"></div>
      <b>المعايير</b>
      ${p.criteria.map((c, ci) => criterionEditorHtml(p, pi, c, ci)).join("")}
      <button class="btn btn-sm addCrit" data-p="${pi}">+ إضافة معيار</button>
    </div>`).join("") + `<button class="btn" id="addPillar">+ إضافة ركيزة جديدة</button>`;
    attachPillarHandlers();
  };

  function sumWeights(key) { return settings.pillars.reduce((s2, p) => s2 + (Number(p[key]) || 0), 0); }

  function criterionEditorHtml(p, pi, c, ci) {
    const isRatio = c.type === "ratio";
    return `<div class="rubric-item">
      <div class="flex-between">
        <input type="text" value="${esc(c.name)}" data-p="${pi}" data-c="${ci}" class="cName" style="max-width:280px">
        <button class="icon-btn text-danger delCrit" data-p="${pi}" data-c="${ci}">حذف</button>
      </div>
      ${p.id === "quality" ? `
        <div class="grid grid-2">
          <div class="field"><label>وزن (إبداعي) %</label><input type="number" class="cWC" data-p="${pi}" data-c="${ci}" value="${c.weightCreative}"></div>
          <div class="field"><label>وزن (رسمي) %</label><input type="number" class="cWF" data-p="${pi}" data-c="${ci}" value="${c.weightFormal}"></div>
        </div>` : `<div class="field"><label>الوزن داخل الركيزة %</label><input type="number" class="cW" data-p="${pi}" data-c="${ci}" value="${c.weight || 0}"></div>`}
      ${isRatio ? `
        <div class="grid grid-3">
          <div class="field"><label>حد "5" (${c.unit})</label><input type="number" step="0.1" class="band5" data-p="${pi}" data-c="${ci}" value="${c.bands["5"]}"></div>
          <div class="field"><label>حد "3"</label><input type="number" step="0.1" class="band3" data-p="${pi}" data-c="${ci}" value="${c.bands["3"]}"></div>
          <div class="field"><label>حد "1"</label><input type="number" step="0.1" class="band1" data-p="${pi}" data-c="${ci}" value="${c.bands["1"]}"></div>
        </div>
        <button class="btn btn-sm suggestBand" data-p="${pi}" data-c="${ci}">🔄 اقتراح تلقائي من متوسط أداء الفريق</button>
      ` : `
        <div class="grid grid-3">
          <div class="field"><label>وصف الدرجة 5</label><input type="text" class="a5" data-p="${pi}" data-c="${ci}" value="${esc(c.anchors?.["5"] || "")}"></div>
          <div class="field"><label>وصف الدرجة 3</label><input type="text" class="a3" data-p="${pi}" data-c="${ci}" value="${esc(c.anchors?.["3"] || "")}"></div>
          <div class="field"><label>وصف الدرجة 1</label><input type="text" class="a1" data-p="${pi}" data-c="${ci}" value="${esc(c.anchors?.["1"] || "")}"></div>
        </div>`}
    </div>`;
  }

  function attachPillarHandlers() {
    pillarsBox.querySelectorAll(".pName").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].name = i.value; }));
    pillarsBox.querySelectorAll(".pWriter").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].weightWriter = Number(i.value); drawPillars(); }));
    pillarsBox.querySelectorAll(".pSenior").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].weightSenior = Number(i.value); drawPillars(); }));
    pillarsBox.querySelectorAll(".pCategory").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].category = i.value; }));
    pillarsBox.querySelectorAll(".delPillar").forEach((b) => (b.onclick = () => { if (confirm("حذف هذه الركيزة بالكامل؟")) { settings.pillars.splice(b.dataset.p, 1); drawPillars(); } }));
    pillarsBox.querySelectorAll(".cName").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].criteria[i.dataset.c].name = i.value; }));
    pillarsBox.querySelectorAll(".cW").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].criteria[i.dataset.c].weight = Number(i.value); }));
    pillarsBox.querySelectorAll(".cWC").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].criteria[i.dataset.c].weightCreative = Number(i.value); }));
    pillarsBox.querySelectorAll(".cWF").forEach((i) => (i.onchange = () => { settings.pillars[i.dataset.p].criteria[i.dataset.c].weightFormal = Number(i.value); }));
    pillarsBox.querySelectorAll(".band5,.band3,.band1").forEach((i) => (i.onchange = () => {
      const key = i.classList.contains("band5") ? "5" : i.classList.contains("band3") ? "3" : "1";
      settings.pillars[i.dataset.p].criteria[i.dataset.c].bands[key] = Number(i.value);
    }));
    pillarsBox.querySelectorAll(".a5,.a3,.a1").forEach((i) => (i.onchange = () => {
      const key = i.classList.contains("a5") ? "5" : i.classList.contains("a3") ? "3" : "1";
      const c = settings.pillars[i.dataset.p].criteria[i.dataset.c];
      c.anchors = c.anchors || {};
      c.anchors[key] = i.value;
    }));
    pillarsBox.querySelectorAll(".delCrit").forEach((b) => (b.onclick = () => { if (confirm("حذف هذا المعيار؟")) { settings.pillars[b.dataset.p].criteria.splice(b.dataset.c, 1); drawPillars(); } }));
    pillarsBox.querySelectorAll(".addCrit").forEach((b) => (b.onclick = () => {
      settings.pillars[b.dataset.p].criteria.push({ id: "crit_" + Date.now(), name: "معيار جديد", weight: 0, weightCreative: 0, weightFormal: 0, anchors: { "5": "", "3": "", "1": "" } });
      drawPillars();
    }));
    pillarsBox.querySelectorAll(".suggestBand").forEach((b) => (b.onclick = async () => {
      const p = settings.pillars[b.dataset.p], c = p.criteria[b.dataset.c];
      try {
        const [employees, allWork] = await Promise.all([
          Api.call("listEmployees", { auth: authOf(s) }),
          Api.call("listWork", { auth: authOf(s), payload: { quarter: App.quarter } }),
        ]);
        const writers = employees.filter((e) => e.isWriter);
        const workByEmployee = {};
        allWork.forEach((r) => { (workByEmployee[r.employeeId] || (workByEmployee[r.employeeId] = [])).push(r); });
        const values = [];
        writers.forEach((w) => {
          const m = Calc.computeMetrics(workByEmployee[w.id] || []);
          if (m[c.metric] !== null) values.push(m[c.metric]);
        });
        const suggestion = Calc.suggestBands(values, c.higherIsBetter);
        if (!suggestion) return toast("لا توجد بيانات كافية هذا الربع للاقتراح");
        if (confirm(`الاقتراح: 5=${suggestion["5"]} / 3=${suggestion["3"]} / 1=${suggestion["1"]} — تطبيق؟`)) {
          c.bands = suggestion;
          drawPillars();
        }
      } catch (err) { toast(err.message); }
    }));
    document.getElementById("addPillar").onclick = () => {
      settings.pillars.push({ id: "pillar_" + Date.now(), name: "ركيزة جديدة", type: "rubric_group", category: "technical", weightWriter: 0, weightSenior: 0, criteria: [] });
      drawPillars();
    };
  }
  drawPillars();

  const classBox = document.getElementById("classBox");
  const drawClass = () => {
    classBox.innerHTML = settings.classification.map((c, i) => `
      <div class="grid grid-3" style="align-items:end">
        <div class="field"><label>من</label><input type="number" step="0.1" class="clMin" data-i="${i}" value="${c.min}"></div>
        <div class="field"><label>إلى</label><input type="number" step="0.1" class="clMax" data-i="${i}" value="${c.max}"></div>
        <div class="field" style="display:flex;gap:6px"><input type="text" class="clLabel" data-i="${i}" value="${esc(c.label)}"><button class="icon-btn text-danger delClass" data-i="${i}">✕</button></div>
      </div>`).join("");
    classBox.querySelectorAll(".clMin").forEach((i) => (i.onchange = () => (settings.classification[i.dataset.i].min = Number(i.value))));
    classBox.querySelectorAll(".clMax").forEach((i) => (i.onchange = () => (settings.classification[i.dataset.i].max = Number(i.value))));
    classBox.querySelectorAll(".clLabel").forEach((i) => (i.onchange = () => (settings.classification[i.dataset.i].label = i.value)));
    classBox.querySelectorAll(".delClass").forEach((b) => (b.onclick = () => { settings.classification.splice(b.dataset.i, 1); drawClass(); }));
  };
  drawClass();
  document.getElementById("addClass").onclick = () => { settings.classification.push({ min: 0, max: 0, label: "تصنيف جديد" }); drawClass(); };

  document.getElementById("saveSettings").onclick = async () => {
    settings.revisionValueMultiplier = Number(document.getElementById("revMult").value) || 0.5;
    try {
      const saved = await Api.call("setSettings", { auth: authOf(s), payload: { settings } });
      App.settings = saved;
      toast("تم حفظ الإعدادات");
    } catch (err) { toast(err.message); }
  };

  document.getElementById("changePwd").onclick = async () => {
    const np = prompt("كلمة المرور الجديدة للإدارة:");
    if (!np) return;
    try { await Api.call("changeAdminPassword", { auth: authOf(s), payload: { newPassword: np } }); s.password = np; Store.set(s); toast("تم تغيير كلمة المرور"); }
    catch (err) { toast(err.message); }
  };
}

/* =========================== إدارة: سجل التعديلات =========================== */
async function renderAuditView(el) {
  const s = App.session;
  const rows = await Api.call("listAudit", { auth: authOf(s) });
  el.innerHTML = `<h2>سجل التعديلات</h2>
  <div class="card"><div class="table-wrap"><table>
    <thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>النوع</th><th>التفاصيل</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${new Date(r.timestamp).toLocaleString("ar")}</td><td>${esc(r.actorName)}</td><td>${esc(r.action)}</td><td>${esc(r.targetType)}</td><td>${esc(r.details)}</td></tr>`).join("") || `<tr><td colspan="5" class="empty-state">لا توجد سجلات بعد</td></tr>`}</tbody>
  </table></div></div>`;
}

/* =========================== التصدير Excel =========================== */
async function renderExportView(el) {
  const s = App.session;
  el.innerHTML = `<h2>تصدير Excel</h2>
  <div class="card">
    <p>يُصدَّر ملخص التقييم + سجل الأعمال التفصيلي لكل من تملكين صلاحية الاطلاع عليه (فريقك المباشر فقط إن كنت مقيّمة).</p>
    <div class="field"><label>الربع</label><select id="expQ">${Store.quarterOptions().map((q) => `<option ${q === App.quarter ? "selected" : ""}>${q}</option>`).join("")}</select></div>
    <button class="btn btn-primary" id="doExport">تنزيل ملف Excel</button>
  </div>`;
  const btn = document.getElementById("doExport");
  const originalLabel = btn.textContent;
  btn.onclick = async () => {
    const quarter = document.getElementById("expQ").value;
    btn.disabled = true;
    btn.textContent = "جارٍ التحضير…";
    try {
      await exportExcel(quarter);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  };
}

/** تُحمَّل مكتبة XLSX (~930K) عند الحاجة فقط عند أول تصدير، بدل تحميلها مع كل صفحة — كانت تُحمَّل
 * سابقًا كسكربت ثابت في كل تحميل للموقع رغم استخدامها هنا فقط، وهذا كان يُبطئ ظهور كل صفحة. */
let xlsxLoadPromise = null;
function loadXlsxLib() {
  if (typeof XLSX !== "undefined") return Promise.resolve();
  if (!xlsxLoadPromise) {
    xlsxLoadPromise = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = "vendor/xlsx.full.min.js";
      tag.onload = () => resolve();
      tag.onerror = () => { xlsxLoadPromise = null; reject(new Error("تعذّر تحميل مكتبة التصدير — تحقّقي من الاتصال بالإنترنت")); };
      document.head.appendChild(tag);
    });
  }
  return xlsxLoadPromise;
}

async function exportExcel(quarter) {
  const s = App.session;
  await loadXlsxLib();
  // listEval/listWork بلا employeeId تُعيدان كل صفوف الربع دفعة واحدة (مُقيَّدة من الخادم أصلًا حسب صلاحية
  // العارض)، بدل استعلام منفصل لكل موظف — كانت الحلقة القديمة تفتح عشرات الطلبات المتتالية لخادم Apps Script
  // البطيء أصلًا، فيبدو التصدير معلَّقًا كلما كبر الفريق.
  const [employees, evalRows, workRows] = await Promise.all([
    Api.call("listEmployees", { auth: authOf(s) }),
    Api.call("listEval", { auth: authOf(s), payload: { quarter } }),
    Api.call("listWork", { auth: authOf(s), payload: { quarter } }),
  ]);
  const targets = employees.filter((e) => e.isWriter);
  const evalByEmployee = {};
  evalRows.forEach((ev) => { if (!evalByEmployee[ev.employeeId]) evalByEmployee[ev.employeeId] = ev; });
  const workByEmployee = {};
  workRows.forEach((w) => { (workByEmployee[w.employeeId] || (workByEmployee[w.employeeId] = [])).push(w); });

  const summaryRows = [["الاسم", "المستوى", "التخصص", "الحالة", "الدرجة", "التصنيف"]];
  const workRowsOut = [["الموظف", "العنوان", "نوع الكتابة", "نوع العمل", "نوع الإجراء", "المشروع", "مراجعة لعمل سابق؟", "التاريخ", "تسليم", "بالموعد", "جولات تعديل محتوى", "جولات تعديل نطاق"]];

  targets.forEach((emp) => {
    const ev = evalByEmployee[emp.id];
    summaryRows.push([emp.name, emp.level === "senior" ? "كاتب أول" : "كاتب", specialtyLabel(emp.specialty), ev?.status || "—", ev?.totalScore ?? "—", ev?.classification || "—"]);
    (workByEmployee[emp.id] || []).forEach((w) => workRowsOut.push([
      emp.name, w.title, w.workType === "creative" ? "إبداعي" : "رسمي",
      w.workCategory === "أخرى" ? w.customCategory : (w.workCategory || ""), w.actionType || "", w.project || "",
      w.isRevision ? "نعم" : "لا",
      w.date, w.delivered ? "نعم" : "لا", w.onTime ? "نعم" : "لا",
      w.contentRevisionRounds ?? 0, w.scopeRevisionRounds ?? 0,
    ]));
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), "ملخص التقييم");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(workRowsOut), "سجل الأعمال");
  XLSX.writeFile(wb, `متم-${quarter}.xlsx`);
}

document.addEventListener("DOMContentLoaded", boot);
