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

  function isValidSettings(data) {
    return !!data && typeof data === "object" &&
      Array.isArray(data.pillars) && data.pillars.length > 0 &&
      data.pillars.every((pillar) => pillar && typeof pillar.id === "string" && Array.isArray(pillar.criteria)) &&
      Array.isArray(data.classification);
  }

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

  function transient(message) {
    const error = new Error(message);
    error.transient = true;
    return error;
  }

  async function request(action, options) {
    const attempts = READ_ACTIONS.has(action) || action === "login" || action === "adminLogin" ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try { return await requestOnce(action, options); }
      catch (error) {
        if (!error.transient || attempt === attempts - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
      }
    }
  }

  async function requestOnce(action, { auth, payload } = {}) {
    let res;
    try {
      res = await fetch(API_BASE_URL, {
        method: "POST",
        cache: "no-store",
        // text/plain لتفادي preflight CORS مع Apps Script Web App
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, auth, payload }),
      });
    } catch (err) {
      throw transient("تعذّر الاتصال بالخادم مؤقتًا. حاولي مرة أخرى.");
    }
    if (!res.ok) {
      const message = "تعذّر إكمال الاتصال بالخادم (HTTP " + res.status + "). حاولي مرة أخرى.";
      if ([404, 408, 429, 500, 502, 503, 504].includes(res.status)) throw transient(message);
      throw new Error(message);
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw transient("تعذّر قراءة استجابة الخادم. حاولي مرة أخرى.");
    }
    if (!json || typeof json !== "object" || typeof json.ok !== "boolean") {
      throw transient("استجابة الخادم لا تطابق صيغة البيانات المتوقعة");
    }
    if (!json.ok) {
      throw new Error(json.error || "خطأ غير معروف من الخادم");
    }
    // لا نعرض البيانات التالفة كسجل فارغ؛ يجب إبقاء فشل التحميل ظاهرًا للمستخدم.
    if (action.indexOf("list") === 0 && !Array.isArray(json.data)) {
      throw transient("تعذّر تحميل القائمة: استجابة الخادم غير صالحة (" + action + "). أعيدي المحاولة.");
    }
    if (action === "getSettings" && !isValidSettings(json.data)) {
      throw transient("تعذّر تحميل معايير التقييم كاملة من الخادم. أعيدي المحاولة.");
    }
    return json.data;
  }

  return { call, clearCache, isValidSettings };
})();
