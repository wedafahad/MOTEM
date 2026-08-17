// عميل API — يتحدث مع خادم Apps Script (أو الخادم المحلي أثناء التطوير) عبر نفس العقد.
// يُخزَّن رابط الخادم فقط (إعداد اتصال) في localStorage تحت مفتاح واحد — لا بيانات عمل هنا إطلاقًا.

const Api = (() => {
  const URL_KEY = "motem_api_url";

  function getApiUrl() {
    return localStorage.getItem(URL_KEY) || "";
  }
  function setApiUrl(url) {
    localStorage.setItem(URL_KEY, url.trim());
  }
  function clearApiUrl() {
    localStorage.removeItem(URL_KEY);
  }

  async function call(action, { auth, payload } = {}) {
    const url = getApiUrl();
    if (!url) throw new Error("لم يتم ضبط رابط الخادم بعد");
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        // text/plain لتفادي preflight CORS مع Apps Script Web App
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action, auth, payload }),
      });
    } catch (err) {
      throw new Error("تعذّر الاتصال بالخادم — تحقّقي من الاتصال بالإنترنت ومن رابط الخادم. (" + err.message + ")");
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

  return { getApiUrl, setApiUrl, clearApiUrl, call };
})();
