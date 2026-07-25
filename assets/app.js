/* الأساس المشترك بين كل الصفحات. يُحمَّل بعد config.js. */

// ─────────────────────────────────────────── الاتصال بالسيرفر

/**
 * كل الطلبات POST بـ text/plain وبدون أي header إضافي.
 * ده مقصود: Apps Script مش بيرد على OPTIONS، و application/json
 * بيخلي المتصفح يبعت preflight فالطلب بيفشل خالص. راجع docs/API.md.
 */
async function api(action, payload) {
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
    // Apps Script بيرجّع صفحة HTML لما يحصل خطأ غير ممسوك، والمتصفح
    // مش بيقدر يقراها. مش مشكلة CORS رغم إنها بتبان كده.
    throw new ApiError('INTERNAL', 'رد غير متوقع من السيرفر. راجع سجل Apps Script.');
  }

  if (!json.ok) {
    if (json.error.code === 'UNAUTHENTICATED') { clearToken(); goLogin(); }
    throw new ApiError(json.error.code, json.error.message, json.error.details);
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
function clearToken() { localStorage.removeItem('awqaf_token'); localStorage.removeItem('awqaf_name'); }
function getUserName() { return localStorage.getItem('awqaf_name') || ''; }

function goLogin() {
  if (!/index\.html$|\/$/.test(location.pathname)) location.href = 'index.html';
}

/** تُستدعى في أول كل صفحة محمية. بترجّع false لو اتحوّل للدخول. */
async function requireAuth() {
  if (!getToken()) { goLogin(); return false; }
  try {
    var me = await api('whoami');
    localStorage.setItem('awqaf_name', me.displayName);
    var el = document.getElementById('userName');
    if (el) el.textContent = me.displayName;
    return true;
  } catch (e) {
    goLogin();
    return false;
  }
}

async function logout() {
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

// ─────────────────────────────────────────── تصدير PDF

/**
 * بيصوّر العنصر المعروض حاليًا. المكتبات محمّلة من cdnjs بإصدار مثبّت.
 */
async function exportPdf(node, filename) {
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

// ─────────────────────────────────────────── شريط التنقل

function renderNav(active) {
  var links = [
    ['schedule.html', '📅 التوزيع'],
    ['mosques.html', '🕌 المساجد'],
    ['khatibs.html', '🎙️ الخطباء'],
    ['khatib-schedule.html', '📋 جدول خطيب'],
    ['publish.html', '📢 النشر'],
  ];
  var nav = el('nav');
  if (!nav) return;
  nav.innerHTML =
    '<div class="nav-links">' +
    links.map(function (l) {
      return '<a href="' + l[0] + '"' + (l[0] === active ? ' class="active"' : '') + '>' + l[1] + '</a>';
    }).join('') +
    '</div><div class="nav-user"><span id="userName">' + esc(getUserName()) +
    '</span><button class="btn btn-plain" onclick="logout()">خروج</button></div>';
}
