// عنوان السيرفر المنشور (Cloudflare Worker + D1 على الدومين الجديد)
var APPS_SCRIPT_URL = 'https://khotba-api.daaw.dev';

// يغيّره سكريبت البناء في نسخة dist لتحديد مكان الصفحات المحلية المتولدة.
var FRONTEND_BUILD = false;

// المنطقة مرتبطة بمسار الصفحة، وليست اختيارًا مشتركًا بين تبويبات المتصفح.
var REGION_ID = /\/tebeen(?:\/|$)/.test(location.pathname) ? 'tebeen' : '15may';
var REGION_NAME = REGION_ID === 'tebeen' ? 'التبين' : '15 مايو';
if (REGION_ID === 'tebeen') APPS_SCRIPT_URL += '?region=tebeen';

// العناوين البديلة والاحتياطية:
// var APPS_SCRIPT_URL = 'https://khotba-api.omarmagdy99860.workers.dev';

// للرجوع السريع إلى Apps Script في حال الحاجة:
// var APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzjkKzAdJtC2I-2QCxO6C8MzXhs2kWKnHVdnR4zvvfBsZcbicENfczeptOU-zFwxQ3ciQ/exec';
