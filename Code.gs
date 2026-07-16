/**
 * متم — خادم تخزين بسيط عبر Google Sheets
 * =========================================
 * الصقي هذا الكود كاملاً في محرر Apps Script (خطوات النشر في README.md)
 * لا تحتاجين تعدّلين أي شي هنا — يشتغل مباشرة على أي Google Sheet جديد.
 */

const SHEET_NAME = 'Storage';

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['key', 'value', 'updated_at']);
  }
  return sheet;
}

function findRow_(sheet, key) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return i + 1; // رقم الصف (يبدأ من 1)
  }
  return -1;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// قراءة قيمة: GET ?action=get&key=xxx
function doGet(e) {
  const action = e.parameter.action;
  const sheet = getSheet_();

  if (action === 'get') {
    const key = e.parameter.key;
    const row = findRow_(sheet, key);
    if (row === -1) return jsonResponse_({ found: false });
    const value = sheet.getRange(row, 2).getValue();
    return jsonResponse_({ found: true, value: String(value) });
  }

  return jsonResponse_({ error: 'unknown action' });
}

// كتابة/تحديث قيمة: POST body = {"action":"set","key":"...","value":"..."}
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // تمنع تضارب الكتابة إذا حفظ شخصان في نفس اللحظة
  try {
    const body = JSON.parse(e.postData.contents);
    const sheet = getSheet_();

    if (body.action === 'set') {
      const row = findRow_(sheet, body.key);
      const now = new Date().toISOString();
      if (row === -1) {
        sheet.appendRow([body.key, body.value, now]);
      } else {
        sheet.getRange(row, 2, 1, 2).setValues([[body.value, now]]);
      }
      return jsonResponse_({ ok: true });
    }

    return jsonResponse_({ error: 'unknown action' });
  } finally {
    lock.releaseLock();
  }
}
