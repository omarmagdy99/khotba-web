/* الأساس المشترك بين كل الصفحات. يُحمَّل بعد config.js. */

// ─────────────────────────────────────────── الاتصال بالسيرفر

var _CLIENT_CACHE_TTL_MS = 60 * 1000; // 60 ثانية
var _CACHEABLE_ACTIONS = ['listKhatibs', 'listMosques', 'getSettings'];
var _INVALIDATING_ACTIONS = [
  'createKhatib', 'updateKhatib', 'deactivateKhatib',
  'createMosque', 'updateMosque', 'deactivateMosque', 'reorderMosque',
  'setPreferences', 'publishRange', 'saveSchedule', 'generateDate', 'regenerateDate',
  'login', 'createUser', 'updateUser', 'resetUserPassword'
];

function clearClientCache() {
  try {
    for (var i = sessionStorage.length - 1; i >= 0; i--) {
      var k = sessionStorage.key(i);
      if (k && k.indexOf('awqaf_cache_') === 0) {
        sessionStorage.removeItem(k);
      }
    }
  } catch (e) {}
}

/**
 * كل الطلبات POST بـ text/plain وبدون أي header إضافي.
 * مع استخدام التخزين المؤقت الذكي (Client-side Caching) للتنقل الفوري.
 */
async function api(action, payload) {
  var isCacheable = _CACHEABLE_ACTIONS.indexOf(action) >= 0;
  var cacheKey = 'awqaf_cache_' + action + '_' + JSON.stringify(payload || {});

  if (isCacheable) {
    try {
      var cachedStr = sessionStorage.getItem(cacheKey);
      if (cachedStr) {
        var cached = JSON.parse(cachedStr);
        if (Date.now() - cached.ts < _CLIENT_CACHE_TTL_MS) {
          return cached.data;
        }
      }
    } catch (e) {}
  }

  var body = Object.assign({ action: action, token: getToken() }, payload || {});
  var res;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError('NETWORK', 'تعذّر الاتصال بالسيرفر. اتأكد من الإنترنت وحاول تاني.');
  }

  var json;
  try {
    json = await res.json();
  } catch (e) {
    throw new ApiError('INTERNAL', 'رد غير متوقع من السيرفر، حاول تاني.');
  }

  if (!json.ok) {
    if (json.error.code === 'UNAUTHENTICATED') { clearToken(); goLogin(); }
    throw new ApiError(json.error.code, json.error.message, json.error.details);
  }

  if (isCacheable) {
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: json.data }));
    } catch (e) {}
  }

  if (_INVALIDATING_ACTIONS.indexOf(action) >= 0) {
    clearClientCache();
  }

  if (action === 'login' && json.data) {
    if (json.data.role) localStorage.setItem('awqaf_role', json.data.role);
    if (json.data.displayName) localStorage.setItem('awqaf_name', json.data.displayName);
    if (json.data.username) localStorage.setItem('awqaf_username', json.data.username);
  }

  return json.data;
}

function ApiError(code, message, details) {
  this.code = code; this.message = message; this.details = details || {};
}
ApiError.prototype = Object.create(Error.prototype);

// ─────────────────────────────────────────── الجلسة

function getToken() { return localStorage.getItem('awqaf_token') || ''; }
function setToken(t) { localStorage.setItem('awqaf_token', t); }
function clearToken() {
  clearClientCache();
  localStorage.removeItem('awqaf_token');
  localStorage.removeItem('awqaf_name');
  localStorage.removeItem('awqaf_username');
  localStorage.removeItem('awqaf_role');
}
function getUserName() { return localStorage.getItem('awqaf_name') || ''; }
function getUsername() { return localStorage.getItem('awqaf_username') || ''; }
function getRole() { return localStorage.getItem('awqaf_role') || ''; }
function setRole(r) {
  if (r) localStorage.setItem('awqaf_role', r);
  else localStorage.removeItem('awqaf_role');
}
function isAdmin() { return getRole() === 'admin'; }
function canEdit() { return isAdmin() || getRole() === 'coordinator'; }

function goLogin() {
  // Cloudflare بيقدّم الصفحات من غير .html (‎/index)، فلازم نتعرّف على الشكلين.
  if (!/(^|\/)(index(\.html)?)?$/.test(location.pathname)) location.href = 'index.html';
}

var _currentNavActive = '';

/** تُستدعى في أول كل صفحة محمية. بترجّع false لو اتحوّل للدخول. */
async function requireAuth() {
  if (!getToken()) { goLogin(); return false; }
  try {
    var me = await api('whoami');
    localStorage.setItem('awqaf_name', me.displayName);
    if (me.username) localStorage.setItem('awqaf_username', me.username);
    var oldRole = getRole();
    if (me.role) {
      localStorage.setItem('awqaf_role', me.role);
    }
    var el = document.getElementById('userName');
    if (el) el.textContent = me.displayName;
    if (oldRole !== (me.role || '')) {
      var active = _currentNavActive;
      if (!active) {
        var path = location.pathname.split('/').pop();
        active = path || 'schedule.html';
      }
      renderNav(active);
    }
    return true;
  } catch (e) {
    goLogin();
    return false;
  }
}

async function logout() {
  clearClientCache();
  try { await api('logout'); } catch (e) {}
  clearToken();
  location.href = 'index.html';
}

// ─────────────────────────────────────────── البحث العربي

/**
 * توحيد الهمزات وما شابه عشان البحث يشتغل مهما اختلف الإملاء.
 * للبحث فقط — لا تُخزَّن النتيجة ولا تُستخدم كمفتاح تمييز،
 * لأنها بتدمج ث→س و ذ→ز وده بيخلط أسماء مختلفة فعلاً.
 */
function normalizeText(text) {
  if (!text || text === 'غير محدد') return '';
  return text.toString().toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[ث]/g, 'س')
    .replace(/[ذ]/g, 'ز')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

function matches(haystack, needle) {
  return normalizeText(haystack).includes(normalizeText(needle));
}

// ─────────────────────────────────────────── التواريخ

function isFriday(iso) {
  var p = String(iso).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() === 5;
}

function todayIso() {
  var d = new Date();
  return [d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')].join('-');
}

/** أقرب n جمعة من النهاردة (تشمل النهاردة لو كان جمعة). */
function nextFridays(n) {
  var out = [], d = new Date();
  d.setHours(12, 0, 0, 0);
  while (out.length < n) {
    if (d.getDay() === 5) {
      out.push([d.getFullYear(),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')].join('-'));
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

var AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                 'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function formatDate(iso) {
  if (!iso) return '';
  var p = String(iso).split('-');
  return +p[2] + ' ' + AR_MONTHS[+p[1] - 1] + ' ' + p[0];
}

// ─────────────────────────────────────────── واجهة

function el(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var _toastTimer;
function toast(message, kind) {
  var t = el('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.className = 'toast show ' + (kind || 'ok');
  t.textContent = message;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { t.className = 'toast'; }, 4000);
}

function showLoading(container, message) {
  container.innerHTML = '<div class="state"><div class="spinner"></div><p>' +
    esc(message || 'جاري التحميل...') + '</p></div>';
}

function showEmpty(container, message) {
  container.innerHTML = '<div class="state"><span class="state-icon">🔍</span><p>' +
    esc(message) + '</p></div>';
}

/** حالة الخطأ بتعيد المحاولة، مش بتعمل reload — عشان المستخدم ميضيعش شغله. */
function showError(container, message, retryFn) {
  container.innerHTML = '<div class="state error"><span class="state-icon">⚠️</span><p>' +
    esc(message) + '</p><button class="btn" id="retryBtn">إعادة المحاولة</button></div>';
  var b = el('retryBtn');
  if (b && retryFn) b.onclick = retryFn;
}

function confirmBox(message) { return window.confirm(message); }

var _pdfLibrariesPromise = null;

function loadPdfLibraries() {
  if (typeof html2canvas !== 'undefined' && window.jspdf) {
    return Promise.resolve();
  }
  if (_pdfLibrariesPromise) return _pdfLibrariesPromise;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Failed to load: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  _pdfLibrariesPromise = Promise.all([
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js'),
    loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js')
  ]).catch(function (err) {
    _pdfLibrariesPromise = null;
    throw err;
  });

  return _pdfLibrariesPromise;
}

/**
 * بيصوّر العنصر المعروض حاليًا. المكتبات محمّلة من cdnjs بإصدار مثبّت.
 */
async function exportPdf(node, filename) {
  try {
    await loadPdfLibraries();
  } catch (e) {
    toast('مكتبة PDF لم تُحمّل — اتأكد من الإنترنت', 'err');
    return;
  }
  if (typeof html2canvas === 'undefined' || !window.jspdf) {
    toast('مكتبة PDF لم تُحمّل — اتأكد من الإنترنت', 'err');
    return;
  }
  toast('جاري تجهيز الملف...', 'ok');
  try {
    var canvas = await html2canvas(node, { scale: 2, backgroundColor: '#ffffff' });
    var img = canvas.toDataURL('image/png');
    var pdf = new window.jspdf.jsPDF('p', 'mm', 'a4');
    var w = 210, h = canvas.height * w / canvas.width;
    var left = h, y = 0;
    pdf.addImage(img, 'PNG', 0, 0, w, h);
    left -= 297;
    while (left > 0) {
      y -= 297;
      pdf.addPage();
      pdf.addImage(img, 'PNG', 0, y, w, h);
      left -= 297;
    }
    pdf.save(filename + '.pdf');
  } catch (e) {
    toast('تعذّر إنشاء الملف', 'err');
  }
}

// ─────────────────────────────────────────── تصدير الجداول (طباعة / PDF و Word)

/*
 * حسابات تناسب حجم الخط والمسافات (Font size & cell padding arithmetic):
 * - مقاس صفحة A4 رأسي: 297mm ارتفاع × 210mm عرض.
 * - الهوامش المحددة: @page { size: A4; margin: 10mm; } (فوق وتحت 10mm)
 *   -> الارتفاع المتاح للطباعة في الصفحة الواحدة = 297 - 20 = 277mm (~785pt حيث 1mm ≈ 2.83465pt).
 * - صفحتان كحد أقصى: 2 × 785pt = 1570pt إجمالي الارتفاع القابل للاستخدام.
 * - لعدد صفوف واقعي يقارب 85 صفاً:
 *   تتوزع الصفوف على صفحتين: ~43 صفاً في الصفحة الأولى و42 في الصفحة الثانية.
 *   الصفحة الأولى:
 *     - عنوان الصفحة h1: خط 14pt + هامش سفلي 6mm (~17pt) = ~34pt.
 *     - رأس الجدول thead (مكرر): خط 11pt + بادنج 2px فوق وتحت + بوردر = ~19pt.
 *     - الارتفاع المتبقي لصفوف الصفحة الأولى = 785 - (34 + 19) = 732pt.
 *     - الارتفاع المتاح لكل صف = 732pt / 43 صف ≈ 17.02pt.
 *     - عند خط 11pt (line-height: 1.15 = 12.65pt) وبادنج 2px (~1.5pt فوق وتحت = 3pt) وبوردر 1pt:
 *       ارتفاع الصف = 12.65 + 3 + 1 = 16.65pt (أقل من 17.02pt المتاح).
 *       43 صفاً × 16.65pt = 715.95pt + 53pt (العنوان والهيدر) = 768.95pt (< 785pt المتاحة).
 *   الصفحة الثانية:
 *     - رأس الجدول thead يتكرر تلقائياً عبر (display: table-header-group) = ~19pt.
 *     - 42 صفاً × 16.65pt = 699.3pt + 19pt = 718.3pt (< 785pt المتاحة).
 *   النتيجة: 85 صفاً تتسع بدقة تامة في صفحتين دون أن تتسرب إلى صفحة ثالثة نهائياً.
 * - في حالة عدد صفوف أقل:
 *   إذا كان N <= 28: يكبر الخط تدريجياً حتى 16pt وبادنج 5pt ليتسع في صفحة واحدة ممتلئة ومقروءة.
 *   إذا كان N بين 29 و55: خط بين 12pt و14pt ليتسع في صفحتين براحة.
 *   إذا كان N >= 56: خط يتدرج من 12pt وصولاً إلى 11pt عند 85 صفاً (لا يقل عن 11pt أبداً).
 */
function exportTablePrint(title, headers, rows) {
  toast('اختر "حفظ كـ PDF / Save as PDF" من شاشة الطباعة', 'ok');

  var n = rows.length;
  var fontSizePt, padYPt, titleSizePt;
  if (n <= 28) {
    fontSizePt = Math.round((16 - (Math.max(1, n) - 1) * (3 / 27)) * 10) / 10;
    fontSizePt = Math.max(13, Math.min(16, fontSizePt));
    padYPt = 5;
    titleSizePt = 16;
  } else if (n <= 55) {
    fontSizePt = Math.round((14 - (n - 28) * (2 / 27)) * 10) / 10;
    fontSizePt = Math.max(12, Math.min(14, fontSizePt));
    padYPt = 4;
    titleSizePt = 15;
  } else {
    fontSizePt = Math.round((12 - (n - 55) * (1 / 30)) * 10) / 10;
    fontSizePt = Math.max(11, Math.min(12, fontSizePt));
    padYPt = fontSizePt <= 11.2 ? 2 : 3;
    titleSizePt = 14;
  }

  var theadHtml = '<thead><tr>' +
    headers.map(function (h) {
      return '<th>' + esc(h) + '</th>';
    }).join('') +
    '</tr></thead>';

  var tbodyHtml = '<tbody>' +
    rows.map(function (row) {
      return '<tr>' +
        row.map(function (cell) {
          return '<td>' + esc(cell) + '</td>';
        }).join('') +
        '</tr>';
    }).join('') +
    '</tbody>';

  var html = '<!DOCTYPE html>' +
    '<html dir="rtl" lang="ar">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<title>' + esc(title) + '</title>' +
    '<style>' +
    '@page { size: A4; margin: 10mm; }' +
    '@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }' +
    '* { box-sizing: border-box; }' +
    'body { margin: 0; padding: 0; background: #fff; color: #000; font-family: Arial, Tahoma, sans-serif; direction: rtl; }' +
    'h1 { text-align: center; margin: 0 0 6mm 0; font-size: ' + titleSizePt + 'pt; font-weight: bold; color: #000; }' +
    'table { width: 100%; border-collapse: collapse; border-spacing: 0; margin: 0; }' +
    'thead { display: table-header-group; }' +
    'tr { page-break-inside: avoid; break-inside: avoid; }' +
    'th, td { border: 1px solid #000; padding: ' + padYPt + 'pt 6pt; font-size: ' + fontSizePt + 'pt; line-height: 1.15; color: #000; }' +
    'th { font-weight: bold; background: none; text-align: center; }' +
    'td { text-align: right; }' +
    '</style>' +
    '</head>' +
    '<body>' +
    '<h1>' + esc(title) + '</h1>' +
    '<table>' + theadHtml + tbodyHtml + '</table>' +
    '</body></html>';

  var iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.visibility = 'hidden';
  document.body.appendChild(iframe);

  var doc = iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  var cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    setTimeout(function () {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    }, 500);
  }

  iframe.contentWindow.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 60000);

  setTimeout(function () {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, 250);
}

var _docxLibrariesPromise = null;

function loadDocxLibraries() {
  if (typeof docx !== 'undefined' || window.docx) {
    return Promise.resolve();
  }
  if (_docxLibrariesPromise) return _docxLibrariesPromise;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () {
        reject(new Error('Failed to load: ' + src));
      };
      document.head.appendChild(s);
    });
  }

  _docxLibrariesPromise = loadScript('https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.js')
    .catch(function (err) {
      _docxLibrariesPromise = null;
      throw err;
    });

  return _docxLibrariesPromise;
}

async function exportTableWord(title, headers, rows, filename) {
  try {
    await loadDocxLibraries();
  } catch (e) {
    toast('مكتبة Word لم تُحمّل — اتأكد من الإنترنت', 'err');
    return;
  }
  if (!window.docx) {
    toast('مكتبة Word لم تُحمّل — اتأكد من الإنترنت', 'err');
    return;
  }

  toast('جاري تجهيز ملف Word...', 'ok');

  try {
    var docx = window.docx;
    var Document = docx.Document;
    var Packer = docx.Packer;
    var Paragraph = docx.Paragraph;
    var TextRun = docx.TextRun;
    var Table = docx.Table;
    var TableRow = docx.TableRow;
    var TableCell = docx.TableCell;
    var WidthType = docx.WidthType;
    var BorderStyle = docx.BorderStyle;
    var AlignmentType = docx.AlignmentType;

    var borderDef = { style: BorderStyle.SINGLE, size: 1, color: '000000' };
    var borders = {
      top: borderDef,
      bottom: borderDef,
      left: borderDef,
      right: borderDef,
      insideHorizontal: borderDef,
      insideVertical: borderDef
    };

    var headerRow = new TableRow({
      tableHeader: true,
      children: headers.map(function (h) {
        return new TableCell({
          children: [
            new Paragraph({
              bidirectional: true,
              alignment: AlignmentType.CENTER,
              children: [
                new TextRun({
                  text: String(h || ''),
                  bold: true,
                  font: 'Arial',
                  size: 24,
                  rightToLeft: true,
                  color: '000000'
                })
              ]
            })
          ]
        });
      })
    });

    var dataRows = rows.map(function (r) {
      return new TableRow({
        children: r.map(function (c, colIdx) {
          return new TableCell({
            children: [
              new Paragraph({
                bidirectional: true,
                alignment: colIdx === 1 ? AlignmentType.CENTER : AlignmentType.RIGHT,
                children: [
                  new TextRun({
                    text: String(c || ''),
                    font: 'Arial',
                    size: 22,
                    rightToLeft: true,
                    color: '000000'
                  })
                ]
              })
            ]
          });
        })
      });
    });

    var table = new Table({
      visuallyRightToLeft: true,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: borders,
      rows: [headerRow].concat(dataRows)
    });

    var titlePara = new Paragraph({
      bidirectional: true,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: String(title || ''),
          bold: true,
          font: 'Arial',
          size: 30,
          rightToLeft: true,
          color: '000000'
        })
      ]
    });

    var doc = new Document({
      sections: [{
        children: [titlePara, table]
      }]
    });

    var blob = await Packer.toBlob(doc);
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (filename || 'جدول') + '.docx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
    toast('تم تنزيل ملف Word بنجاح', 'ok');
  } catch (err) {
    toast('تعذّر إنشاء ملف Word', 'err');
  }
}

// ─────────────────────────────────────────── شاشة التحميل

/**
 * غطاء بيتحط فوق الصفحة كلها لحد ما البيانات تجهز وتتعرض.
 * بينحقن فورًا وقت تحميل السكربت — يعني قبل ما أي محتوى نص ياخد فرصة
 * يبان، فالمستخدم مايشوفش صفحة نص فاضية وهي بتتملي.
 *
 * الصفحة بتنادي appReady() بعد أول رسم فعلي، مش بعد وصول الرد.
 */
(function injectAppLoading() {
  if (document.body && document.body.dataset.noLoader === '1') return;

  var add = function () {
    if (el('appLoading')) return;
    var d = document.createElement('div');
    d.id = 'appLoading';
    d.className = 'app-loading';
    d.innerHTML = '<div class="spinner"></div><p>جاري التحميل...</p>';
    document.body.appendChild(d);
  };

  if (document.body) add();
  else document.addEventListener('DOMContentLoaded', add);

  // شبكة أمان: لو صفحة نسيت تنادي appReady، أو حصل خطأ قبلها،
  // الغطاء بيتشال لوحده بدل ما المستخدم يفضل قاعد قدام دايرة بتلف.
  setTimeout(function () {
    var n = el('appLoading');
    if (n && !n.classList.contains('hide')) {
      appReady();
      toast('التحميل أخد وقت أطول من المتوقع', 'warn');
    }
  }, 25000);
})();

function appLoadingText(msg) {
  var n = el('appLoading');
  if (n) { var p = n.querySelector('p'); if (p) p.textContent = msg; }
}

function appReady() {
  var n = el('appLoading');
  if (!n) return;
  n.classList.add('hide');
  setTimeout(function () { if (n.parentNode) n.parentNode.removeChild(n); }, 250);
}

// ─────────────────────────────────────────── شريط التنقل

function renderNav(active) {
  _currentNavActive = active;
  var links = [
    ['schedule.html', '📅 التوزيع'],
    ['mosques.html', '🕌 المساجد'],
    ['khatibs.html', '🎙️ الخطباء'],
    ['khatib-schedule.html', '📋 جدول خطيب'],
    ['publish.html', '📢 النشر'],
  ];
  if (isAdmin()) {
    links.push(['users.html', '👥 المستخدمين']);
  }
  var nav = el('nav');
  if (!nav) return;
  nav.innerHTML =
    '<div class="nav-links">' +
    links.map(function (l) {
      return '<a href="' + l[0] + '"' + (l[0] === active ? ' class="active"' : '') + '>' + l[1] + '</a>';
    }).join('') +
    '</div><div class="nav-user"><span id="userName">' + esc(getUserName()) +
    '</span><a href="account.html" class="nav-account-link"' + (active === 'account.html' ? ' style="font-weight:bold;color:var(--navy);text-decoration:none;"' : ' style="text-decoration:none;color:inherit;"') + '>🔑 كلمة المرور</a>' +
    '<button class="btn btn-plain" onclick="logout()">خروج</button></div>';
}
