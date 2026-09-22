/**
 * تصدير قاعدة البيانات كاملة كـ JSON للترحيل إلى Cloudflare D1.
 *
 * الاستخدام في محرر Apps Script:
 *   اختر دالة exportAllJson واضغط Run.
 *   ستطبع النتيجة في سجل التنفيذ (Execution Log) وتنشئ ملفاً في Google Drive باسم:
 *   khotba-snapshot-YYYY-MM-DD.json
 */

function exportAllJson() {
  var ss = SpreadsheetApp.getActive();
  var tabs = ['mosques', 'khatibs', 'preferences', 'assignments', 'users', 'sessions', 'settings'];
  var dump = {
    exported_at: new Date().toISOString(),
    version: SCRIPT_VERSION,
    data: {}
  };

  tabs.forEach(function(tab) {
    var sh = ss.getSheetByName(tab);
    if (!sh) {
      dump.data[tab] = [];
      return;
    }
    var lastRow = sh.getLastRow();
    var lastCol = sh.getLastColumn();
    if (lastRow < 2 || lastCol < 1) {
      dump.data[tab] = [];
      return;
    }

    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
    var rows = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();

    dump.data[tab] = rows.map(function(row) {
      var obj = {};
      headers.forEach(function(h, i) {
        var v = row[i];
        if (v === null || v === undefined) {
          obj[h] = '';
        } else if (v instanceof Date) {
          // تحويل التاريخ إلى صيغة yyyy-MM-dd تفادياً لأي انزياح زمني
          obj[h] = Utilities.formatDate(v, 'Africa/Cairo', 'yyyy-MM-dd');
        } else {
          obj[h] = String(v);
        }
      });
      return obj;
    });
  });

  var jsonStr = JSON.stringify(dump, null, 2);
  Logger.log('تم استخراج البيانات بنجاح: ' + Object.keys(dump.data).map(function(k) {
    return k + ' (' + dump.data[k].length + ')';
  }).join(', '));

  try {
    var fileName = 'khotba-snapshot-' + Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyy-MM-dd') + '.json';
    DriveApp.createFile(fileName, jsonStr, MimeType.PLAIN_TEXT);
    Logger.log('تم حفظ الملف في Google Drive باسم: ' + fileName);
  } catch (e) {
    Logger.log('تعذر حفظ الملف في Drive: ' + e.message);
  }

  return jsonStr;
}
