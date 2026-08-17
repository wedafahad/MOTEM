// حالة الجلسة الحالية (من هو المستخدم المسجّل دخوله الآن) — sessionStorage فقط (تُمسح بإغلاق التبويب/الخروج).
// هذا ليس تخزين بيانات عمل، بل مجرّد "من أنا الآن على هذا التبويب" — كل البيانات الفعلية من الخادم دائمًا.

const Store = (() => {
  const KEY = "motem_session";

  function get() {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function set(session) {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  }
  function clear() {
    sessionStorage.removeItem(KEY);
  }

  function currentQuarter(d = new Date()) {
    const q = Math.floor(d.getMonth() / 3) + 1;
    return `${d.getFullYear()}-Q${q}`;
  }

  function quarterOptions(count = 6) {
    const now = new Date();
    let y = now.getFullYear();
    let q = Math.floor(now.getMonth() / 3) + 1;
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(`${y}-Q${q}`);
      q -= 1;
      if (q === 0) {
        q = 4;
        y -= 1;
      }
    }
    return out;
  }

  return { get, set, clear, currentQuarter, quarterOptions };
})();
