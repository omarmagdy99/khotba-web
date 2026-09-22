// أوقاف 15 مايو — الدوال المساعدة العامة وتنسيق الردود

export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function fail(code, message, details = {}) {
  return new AppError(code, message, details);
}

export function ok_(data) {
  return { ok: true, data: data };
}

export function err_(code, message, details = {}) {
  return { ok: false, error: { code, message, details } };
}

export function jsonResponse(obj, status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json;charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(obj), { status: 200, headers });
}

/**
 * تطبيع النصوص العربية لمنع التكرار (نفس دالة norm_ في Code.gs تماماً)
 */
export function norm_(t) {
  return String(t || '').toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/[ى]/g, 'ي')
    .replace(/[ة]/g, 'ه')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * تطبيع رقم الموبايل وإرجاع الصفر البادئ
 */
export function normPhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-()]/g, '');
  if (!p) return null;
  if (/^1\d{9}$/.test(p)) {
    p = '0' + p;
  }
  return p;
}

export function isValidPhone(phone) {
  return /^01\d{9}$/.test(String(phone || ''));
}

export function isIsoDate_(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
}

export function isFriday_(d) {
  if (!isIsoDate_(d)) return false;
  const p = String(d).split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() === 5;
}

export function nowIso_() {
  return new Date().toISOString();
}

export function todayIso_(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

export function isTrue_(v) {
  return v === 1 || v === true || String(v).toUpperCase() === 'TRUE' || v === '1';
}
