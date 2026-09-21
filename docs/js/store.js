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

function quarterForWorkDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  const parsed = new Date(dateStr + "T00:00:00Z");
  if (year < 1 || !Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() + 1 !== month || parsed.getUTCDate() !== day) return null;
  return `${dateStr.slice(0, 4)}-Q${Math.ceil(month / 3)}`;
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

  return { get, set, clear, currentQuarter, quarterOptions, quarterForWorkDate };
})();
