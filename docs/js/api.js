// عميل API — يتحدث مع خادم Apps Script عبر نفس العقد.
// رابط الخادم ثابت داخل config.js (API_BASE_URL) — لا يُطلب من المستخدم إدخاله ولا يُخزَّن في localStorage.

const Api = (() => {
  const READ_ACTIONS = new Set(["getSettings", "listEmployees", "listWork", "listBehavioral", "listEval", "listDocuments", "listAudit"]);
  const CACHE_MS = 15000;
  // ذاكرة مؤقتة داخل التبويب فقط، منفصلة حسب الحساب والربع وتُمسح عند الحفظ والخروج.
  const cache = new Map();
  const pending = new Map();
  let generation = 0;
  const copy = (data) => data === undefined ? undefined : JSON.parse(JSON.stringify(data));

  function clearCache() {
    generation += 1;
    cache.clear();
    pending.clear();
  }

  async function call(action, options = {}) {
    if (!READ_ACTIONS.has(action)) {
      // فشل النقل لا يضمن عدم حفظ الخادم؛ أبطل الذاكرة حتى عند الخطأ.
      clearCache();
      try { return await request(action, options); }
      finally { clearCache(); }
    }
    const key = JSON.stringify([action, options.auth || {}, options.payload || {}]);
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return copy(hit.data);
    const epoch = generation;
    let promise = pending.get(key);
    if (!promise) {
      promise = request(action, options).then((data) => {
        if (epoch === generation) {
          if (cache.size >= 60) cache.delete(cache.keys().next().value);
          cache.set(key, { data: copy(data), expires: Date.now() + CACHE_MS });
        }
        return data;
      }).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
    }
    return copy(await promise);
  }

  async function request(action, { auth, payload } = {}) {
    let res;
    try {
      res = await fetch(API_BASE_URL, {
        method: "POST",
        // text/plain لتفادي preflight CORS مع Apps Script Web App
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, auth, payload }),
      });
    } catch (err) {
      throw new Error("تعذّر الاتصال بالخادم — تحقّقي من الاتصال بالإنترنت. (" + err.message + ")");
    }
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error("تعذّر الوصول إلى خدمة البيانات (HTTP 404). أعيدي المحاولة؛ إذا استمر الخطأ، يلزم التحقق من رابط نشر الخادم وصلاحية الوصول إليه.");
      }
      throw new Error("الخادم أعاد خطأ HTTP " + res.status);
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new Error("رد الخادم غير صالح (ليس JSON) — تأكد من رابط النشر الصحيح لـ Apps Script");
    }
    if (!json || typeof json !== "object" || typeof json.ok !== "boolean") {
      throw new Error("استجابة الخادم لا تطابق صيغة البيانات المتوقعة");
    }
    if (!json.ok) {
      throw new Error(json.error || "خطأ غير معروف من الخادم");
    }
    // لا نعرض البيانات التالفة كسجل فارغ؛ يجب إبقاء فشل التحميل ظاهرًا للمستخدم.
    if (action.indexOf("list") === 0 && !Array.isArray(json.data)) {
      throw new Error("تعذّر تحميل القائمة: استجابة الخادم غير صالحة. أعيدي المحاولة.");
    }
    return json.data;
  }

  return { call, clearCache };
})();
