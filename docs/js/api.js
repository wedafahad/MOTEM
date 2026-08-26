// عميل API — يتحدث مع خادم Apps Script عبر نفس العقد.
// رابط الخادم ثابت داخل config.js (API_BASE_URL) — لا يُطلب من المستخدم إدخاله ولا يُخزَّن في localStorage.

const Api = (() => {
  async function call(action, { auth, payload } = {}) {
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
      throw new Error("الخادم أعاد خطأ HTTP " + res.status);
    }
    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new Error("رد الخادم غير صالح (ليس JSON) — تأكدي من رابط النشر الصحيح لـ Apps Script");
    }
    if (!json.ok) {
      throw new Error(json.error || "خطأ غير معروف من الخادم");
    }
    return json.data;
  }

  return { call };
})();
