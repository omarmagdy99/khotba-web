// أوقاف 15 مايو — نقطة التوجيه والاتصال الرئيسية على Cloudflare Workers
//
// مطابقة تامة 100% لعقد Apps Script الأصلي:
// - نفس مسارات العمليات
// - نفس أسماء الحقول (camelCase في JSON)
// - نفس أكواد ورسائل الأخطاء
// - نفس استجابة الـ GET لـ ?ping=1 وللجدول العام
// - كود الحالة HTTP 200 دائماً داخل مغلف { ok: true/false }

import { ok_, err_, jsonResponse } from './util.js';
import { login_, logout_, auth_, whoami_, changePassword_ } from './auth.js';
import { listUsers_, createUser_, updateUser_, resetUserPassword_ } from './users.js';
import { listMosques_, saveMosque_, deactivateMosque_, reorderMosque_ } from './mosques.js';
import { listKhatibs_, saveKhatib_, deactivateKhatib_, setPreferences_ } from './khatibs.js';
import {
  getSchedule_, getKhatibSchedule_, getScheduleHistory_, listDates_, getLoadCounts_,
  generateDate_, regenerateDate_, saveSchedule_, publishRange_, publicSchedule_,
  listExcuseRequests_, reviewExcuseRequest_
} from './schedule.js';
import { getSettings_ } from './settings.js';
import { one } from './db.js';
import { canAccessRegion } from './regions.js';
import { khatibLogin_, khatibWhoami_, khatibGetSchedule_, khatibRespond_ } from './khatib-portal.js';
import {
  mosquePhoneCheck_, mosqueSetPassword_, mosqueLogin_, mosqueWhoami_, mosqueLogout_,
  mosqueGetSchedule_, mosqueRequestReset_, mosqueConfirmReset_, resetMosquePassword_, telegramWebhook_
} from './mosque-portal.js';

const SCRIPT_VERSION = '2026-10-25';

const KNOWN_ACTIONS = [
  'login', 'logout', 'whoami', 'changePassword',
  'listMosques', 'listKhatibs', 'getSchedule', 'getKhatibSchedule', 'listDates',
  'getLoadCounts', 'getSettings', 'getScheduleHistory',
  'createMosque', 'updateMosque', 'deactivateMosque', 'reorderMosque',
  'createKhatib', 'updateKhatib', 'deactivateKhatib', 'setPreferences',
  'generateDate', 'regenerateDate', 'saveSchedule', 'publishRange',
  'listUsers', 'createUser', 'updateUser', 'resetUserPassword',
  'khatibLogin', 'khatibWhoami', 'khatibGetSchedule', 'khatibRespond',
  'mosquePhoneCheck', 'mosqueSetPassword', 'mosqueLogin', 'mosqueWhoami', 'mosqueLogout',
  'mosqueGetSchedule', 'mosqueRequestReset', 'mosqueConfirmReset', 'resetMosquePassword',
  'listExcuseRequests', 'reviewExcuseRequest',
];

// أقل صلاحية مطلوبة لكل إجراء. أي إجراء مش مذكور هنا بيتعامل على إنه للمدير بس،
// عشان إجراء جديد يتنسي هنا ميبقاش مفتوح للمشاهد بالغلط.
const ROLE_RANK = { viewer: 0, coordinator: 1, admin: 2 };
const ACTION_ROLE = {
  whoami: 'viewer', changePassword: 'viewer',
  listMosques: 'viewer', listKhatibs: 'viewer', getSchedule: 'viewer',
  getKhatibSchedule: 'viewer', listDates: 'viewer', getLoadCounts: 'viewer', getSettings: 'viewer',
  getScheduleHistory: 'viewer',
  createMosque: 'coordinator', updateMosque: 'coordinator', deactivateMosque: 'coordinator',
  reorderMosque: 'coordinator', resetMosquePassword: 'coordinator',
  createKhatib: 'coordinator', updateKhatib: 'coordinator', deactivateKhatib: 'coordinator',
  setPreferences: 'coordinator', generateDate: 'coordinator', regenerateDate: 'coordinator',
  saveSchedule: 'coordinator', publishRange: 'coordinator',
  listExcuseRequests: 'coordinator', reviewExcuseRequest: 'coordinator',
  listUsers: 'admin', createUser: 'admin', updateUser: 'admin', resetUserPassword: 'admin',
};

export default {
  async fetch(request, env, ctx) {
    // 1. معالجة CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
        try { await telegramWebhook_(request, env); } catch (error) { console.error('Telegram webhook error:', error); }
        return new Response('OK', { status: 200 });
      }
      const region = url.searchParams.get('region') || '15may';
      if (!['15may', 'tebeen'].includes(region)) {
        return jsonResponse(err_('BAD_REQUEST', 'المنطقة غير صحيحة'));
      }
      // لا نرجع لقاعدة 15 مايو لو ربط التبين غير متاح.
      const db = region === 'tebeen' ? env.DB_TEBEEN : env.DB;
      if (!db || (region === 'tebeen' && db === env.DB)) {
        return jsonResponse(err_('REGION_UNAVAILABLE', 'بيانات المنطقة غير متاحة حاليًا'));
      }

      // 2. طلبات الـ GET
      if (request.method === 'GET') {
        // فحص الصحة (Health check)
        if (url.pathname === '/health' || url.searchParams.get('health')) {
          let dbOk = false;
          try {
            const check = await one(db, 'SELECT 1 AS alive');
            dbOk = !!(check && check.alive === 1);
          } catch (e) {
            dbOk = false;
          }
          return jsonResponse(ok_({
            status: dbOk ? 'healthy' : 'degraded',
            db: dbOk,
            version: SCRIPT_VERSION,
            region,
          }));
        }

        // فحص الإصدار والأفعال (?ping=1)
        if (url.searchParams.get('ping')) {
          return jsonResponse(ok_({
            version: SCRIPT_VERSION,
            actions: KNOWN_ACTIONS,
          }));
        }

        // قراءة الجدول العام
        const date = url.searchParams.get('date') || '';
        const res = await publicSchedule_(db, date);
        return jsonResponse(res);
      }

      // 3. طلبات الـ POST
      if (request.method === 'POST') {
        const text = await request.text();
        let body = {};
        if (text) {
          try {
            body = JSON.parse(text);
          } catch (e) {
            return jsonResponse(err_('BAD_REQUEST', 'صيغة JSON غير صحيحة'));
          }
        }

        const actionResult = await route_(body, env, request, db, region);
        if (region === 'tebeen' && actionResult.error) {
          actionResult.error.message = actionResult.error.message.replace(/المجاورة/g, 'المنطقة');
        }
        return jsonResponse(actionResult);
      }

      return jsonResponse(err_('BAD_REQUEST', 'طريقة غير مدعومة: ' + request.method));
    } catch (err) {
      console.error('Unhandled Worker Error:', err.stack || String(err));
      return jsonResponse(err_('INTERNAL', 'حصل خطأ غير متوقع في السيرفر، حاول تاني'));
    }
  }
};

async function route_(b, env, request, db, region) {
  const a = b.action;

  // إجراءات بوابة الخطباء (تعتمد على الهاتف والتوكن الخاص بالخطيب بدون صلاحيات لوحة التحكم)
  if (a === 'khatibLogin') return await khatibLogin_(db, b, request);
  if (a === 'khatibWhoami') return await khatibWhoami_(db, b);
  if (a === 'khatibGetSchedule') return await khatibGetSchedule_(db, b);
  if (a === 'khatibRespond') return await khatibRespond_(db, b);
  if (a === 'mosquePhoneCheck') return await mosquePhoneCheck_(db, b, request);
  if (a === 'mosqueSetPassword') return await mosqueSetPassword_(db, env, b);
  if (a === 'mosqueLogin') return await mosqueLogin_(db, env, b, request);
  if (a === 'mosqueWhoami') return await mosqueWhoami_(db, b);
  if (a === 'mosqueLogout') return await mosqueLogout_(db, b);
  if (a === 'mosqueGetSchedule') return await mosqueGetSchedule_(db, b);
  if (a === 'mosqueRequestReset') return await mosqueRequestReset_(db, env, b, request);
  if (a === 'mosqueConfirmReset') return await mosqueConfirmReset_(db, env, b, request);

  if (a === 'login') return await login_(env.DB, env, b, request);
  if (a === 'logout') return await logout_(env.DB, b);

  const user = await auth_(env.DB, b.token);
  if (!user) {
    return err_('UNAUTHENTICATED', 'انتهت الجلسة، سجّل الدخول من جديد');
  }

  // Identity/password remain reachable so a valid session can navigate to its allowed region.
  if (!['whoami', 'changePassword'].includes(a) && !canAccessRegion(user.region_access, region)) {
    return err_('REGION_FORBIDDEN', 'حسابك غير مسموح له بدخول هذه المنطقة', { regionAccess: user.region_access });
  }

  const need = ACTION_ROLE[a] || 'admin';
  if ((ROLE_RANK[user.role] ?? -1) < ROLE_RANK[need]) {
    return err_('FORBIDDEN', 'مش مسموح لك تعمل الحركة دي');
  }

  switch (a) {
    case 'whoami':            return whoami_(user);
    case 'changePassword':    return await changePassword_(env.DB, env, user, b.token, b);
    case 'listMosques':       return await listMosques_(db, b.includeInactive);
    case 'listKhatibs':       return await listKhatibs_(db, b.includeInactive);
    case 'getSchedule':       return await getSchedule_(db, b.date);
    case 'getKhatibSchedule': return await getKhatibSchedule_(db, b.khatibId, b.from, b.to);
    case 'getScheduleHistory': return await getScheduleHistory_(db, b.from, b.before);
    case 'listDates':         return await listDates_(db);
    case 'getLoadCounts':     return await getLoadCounts_(db, b.from, b.to);
    case 'createMosque':      return await saveMosque_(db, user, b, true);
    case 'updateMosque':      return await saveMosque_(db, user, b, false);
    case 'deactivateMosque':  return await deactivateMosque_(db, user, b.id);
    case 'reorderMosque':     return await reorderMosque_(db, b);
    case 'resetMosquePassword': return await resetMosquePassword_(db, b);
    case 'createKhatib':      return await saveKhatib_(db, user, b, true);
    case 'updateKhatib':      return await saveKhatib_(db, user, b, false);
    case 'deactivateKhatib':  return await deactivateKhatib_(db, user, b.id);
    case 'setPreferences':    return await setPreferences_(db, b.khatibId, b.mosqueIds);
    case 'generateDate':      return await generateDate_(db, user, b);
    case 'regenerateDate':    return await regenerateDate_(db, user, b);
    case 'saveSchedule':      return await saveSchedule_(db, user, b);
    case 'publishRange':      return await publishRange_(db, b);
    case 'listExcuseRequests': return await listExcuseRequests_(db, b);
    case 'reviewExcuseRequest': return await reviewExcuseRequest_(db, user, b);
    case 'getSettings':       return await getSettings_(db);
    case 'listUsers':         return await listUsers_(env.DB);
    case 'createUser':        return await createUser_(env.DB, env, b);
    case 'updateUser':        return await updateUser_(env.DB, user, b);
    case 'resetUserPassword': return await resetUserPassword_(env.DB, env, user, b);
  }

  const hint = KNOWN_ACTIONS.indexOf(a) >= 0 ? ' — هذا الإجراء معروف لكن لم يتم ربطه بشكل صحيح.' : '';
  return err_('BAD_REQUEST', 'إجراء غير معروف: ' + a + hint);
}
