// أوقاف 15 مايو والتبين — بوابة الخطباء للتحقق وتأكيد الحضور أو الاعتذار
// الدخول برقم الهاتف فقط

import { one, all, run, batch } from './db.js';
import { randomHex } from './crypto.js';
import { ok_, err_, normPhone, isValidPhone, isIsoDate_, nowIso_, todayIso_ } from './util.js';

const KHATIB_SESSION_DAYS = 30;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;

/**
 * تسجيل دخول الخطيب برقم الهاتف فقط
 */
export async function khatibLogin_(db, b, requestOrIp) {
  let ip = '127.0.0.1';
  if (typeof requestOrIp === 'string' && requestOrIp) {
    ip = requestOrIp.trim();
  } else if (requestOrIp && typeof requestOrIp === 'object' && requestOrIp.headers) {
    ip = requestOrIp.headers.get('cf-connecting-ip') ||
         requestOrIp.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         '127.0.0.1';
  }

  const rawPhone = String(b.phone || '').trim();
  const phone = normPhone(rawPhone);

  const ipKey = 'kip:' + ip;
  const pKey = phone ? ('kp:' + phone) : null;
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();

  // فحص حد المحاولات لمنع التخمين العشوائي لأرقام الهواتف
  const keysToCheck = [ipKey];
  if (pKey) keysToCheck.push(pKey);
  const placeholders = keysToCheck.map(() => '?').join(',');
  const attempts = await all(db,
    `SELECT key, count, window_start FROM login_attempts WHERE key IN (${placeholders}) AND window_start >= ?`,
    ...keysToCheck, cutoffIso
  );

  for (const att of attempts) {
    if (att.count >= RATE_LIMIT_MAX_FAILURES) {
      return err_('RATE_LIMITED', 'محاولات دخول كثيرة خاطئة، يرجى الانتظار 15 دقيقة ثم المحاولة مجدداً.');
    }
  }

  if (!phone || !isValidPhone(phone)) {
    await recordKhatibFailure_(db, ipKey, pKey, cutoffIso);
    return err_('BAD_REQUEST', 'يرجى إدخال رقم هاتف محمول صحيح (11 رقماً يبدأ بـ 01)');
  }

  const khatib = await one(db, 'SELECT id, name, phone, type, active FROM khatibs WHERE phone = ?', phone);
  if (!khatib || khatib.active !== 1) {
    await recordKhatibFailure_(db, ipKey, pKey, cutoffIso);
    return err_('NOT_FOUND', 'رقم الهاتف غير مسجل في قائمة خطباء هذه المنطقة. تأكد من الرقم أو تواصل مع إدارة الأوقاف لإضافته.');
  }

  // نجاح: مسح محاولات الفشل للرقم
  if (pKey) {
    await run(db, 'DELETE FROM login_attempts WHERE key = ?', pKey);
  }

  const token = randomHex(32);
  const expires = new Date(nowMs + KHATIB_SESSION_DAYS * 864e5).toISOString();

  await run(db,
    'INSERT INTO khatib_sessions (token, khatib_id, phone, expires_at) VALUES (?, ?, ?, ?)',
    token, khatib.id, khatib.phone, expires
  );

  return ok_({
    token,
    khatib: {
      id: khatib.id,
      name: khatib.name,
      phone: khatib.phone,
      type: khatib.type
    }
  });
}

async function recordKhatibFailure_(db, ipKey, pKey, cutoffIso) {
  const nowIso = nowIso_();
  const stmts = [
    db.prepare(`
      INSERT INTO login_attempts (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
        window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END
    `).bind(ipKey, nowIso, cutoffIso, cutoffIso)
  ];

  if (pKey) {
    stmts.push(
      db.prepare(`
        INSERT INTO login_attempts (key, count, window_start)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
          window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END
      `).bind(pKey, nowIso, cutoffIso, cutoffIso)
    );
  }

  await batch(db, stmts);
}

/**
 * التحقق من توكن جلسة الخطيب
 */
export async function khatibAuth_(db, token) {
  if (!token) return null;
  const nowIso = nowIso_();
  const row = await one(db, `
    SELECT ks.token, ks.khatib_id, ks.expires_at, k.name, k.phone, k.type, k.active
    FROM khatib_sessions ks
    JOIN khatibs k ON ks.khatib_id = k.id
    WHERE ks.token = ? AND ks.expires_at > ?
  `, token, nowIso);

  if (!row || row.active !== 1) return null;

  return {
    id: row.khatib_id,
    name: row.name,
    phone: row.phone,
    type: row.type
  };
}

export async function khatibWhoami_(db, b) {
  const khatib = await khatibAuth_(db, b.token);
  if (!khatib) {
    return err_('UNAUTHENTICATED', 'انتهت الجلسة أو غير صالحة، يرجى إدخال رقم الهاتف من جديد.');
  }
  return ok_({ khatib });
}

/**
 * جلب تفاصيل الخطبة أو السؤال عن الجاهزية للخطيب الحالي
 */
export async function khatibGetSchedule_(db, b) {
  const khatib = await khatibAuth_(db, b.token);
  if (!khatib) {
    return err_('UNAUTHENTICATED', 'انتهت الجلسة أو غير صالحة، يرجى إدخال رقم الهاتف من جديد.');
  }

  // الخطبة الحالية هي أقرب جمعة، بما فيها اليوم إذا كان الجمعة، بتوقيت القاهرة.
  const targetDate = currentSermonDate_();
  if (b.date && b.date !== targetDate) {
    return err_('SERMON_CLOSED', 'الرد متاح للخطبة الحالية فقط. حدّث الصفحة لعرض الجمعة الحالية.');
  }

  // 1. فحص التكليف في هذا التاريخ
  const assignment = await one(db, `
    SELECT
      a.id, a.date, a.status, a.date_type, a.label, a.updated_at,
      m.id AS mosque_id, m.name AS mosque_name, m.mujawra, m.address AS mosque_address, m.sort_order
    FROM assignments a
    JOIN mosques m ON a.mosque_id = m.id
    WHERE a.date = ? AND a.khatib_id = ?
  `, targetDate, khatib.id);

  let excuseRequest = null;
  if (assignment) {
    const latestReq = await one(db, `
      SELECT id, status, notes, created_at, reviewed_by, reviewed_at, assignment_version
      FROM excuse_requests
      WHERE date = ? AND mosque_id = ? AND khatib_id = ?
      ORDER BY created_at DESC LIMIT 1
    `, targetDate, assignment.mosque_id, khatib.id);

    if (latestReq) {
      if (latestReq.status === 'pending' && assignment.status === 'confirmed' && latestReq.assignment_version === assignment.updated_at) {
        excuseRequest = latestReq;
      } else if (latestReq.status === 'rejected' && assignment.status === 'confirmed' && latestReq.assignment_version === assignment.updated_at) {
        excuseRequest = latestReq;
      } else if (latestReq.status === 'accepted' && assignment.status === 'excused' && latestReq.reviewed_at >= assignment.updated_at) {
        excuseRequest = latestReq;
      }
    }
  }

  // 2. فحص الجاهزية المسجلة
  const readinessRow = await one(db,
    'SELECT status, updated_at FROM khatib_readiness WHERE date = ? AND khatib_id = ?',
    targetDate, khatib.id
  );

  const readiness = readinessRow ? readinessRow.status : 'undecided';

  return ok_({
    khatib,
    date: targetDate,
    availableDates: [targetDate],
    hasAssignment: !!assignment,
    assignment: assignment ? {
      id: assignment.id,
      date: assignment.date,
      status: assignment.status, // confirmed, excused, unassigned
      mosqueId: assignment.mosque_id,
      mosqueName: assignment.mosque_name,
      mujawra: assignment.mujawra,
      address: assignment.mosque_address,
      sortOrder: assignment.sort_order,
      label: assignment.label,
      excuseRequest: excuseRequest ? {
        id: excuseRequest.id,
        status: excuseRequest.status,
        notes: excuseRequest.notes,
        createdAt: excuseRequest.created_at,
        reviewedBy: excuseRequest.reviewed_by,
        reviewedAt: excuseRequest.reviewed_at
      } : null
    } : null,
    readiness: readiness // ready, excused, undecided
  });
}

/**
 * تسجيل رد الخطيب: تأكيد حضور، اعتذار عن خطبة، أو إبداء الاستعداد للخطابة
 */
export async function khatibRespond_(db, b) {
  const khatib = await khatibAuth_(db, b.token);
  if (!khatib) {
    return err_('UNAUTHENTICATED', 'انتهت الجلسة أو غير صالحة، يرجى إدخال رقم الهاتف من جديد.');
  }

  const date = String(b.date || '').trim();
  if (!isIsoDate_(date)) {
    return err_('BAD_REQUEST', 'التاريخ غير صحيح');
  }
  if (date !== currentSermonDate_()) {
    return err_('SERMON_CLOSED', 'الرد متاح للخطبة الحالية فقط. حدّث الصفحة لعرض الجمعة الحالية.');
  }

  const responseType = String(b.responseType || ''); // 'assignment' أو 'readiness'
  const status = String(b.status || ''); // confirmed / excused للـ assignment، ready / excused للـ readiness
  const now = nowIso_();

  if (responseType === 'assignment') {
    if (!['confirmed', 'excused'].includes(status)) {
      return err_('BAD_REQUEST', 'الحالة غير صحيحة للتكليف (تأكيد أو اعتذار فقط)');
    }

    const current = await one(db,
      'SELECT id, mosque_id, status, updated_at FROM assignments WHERE date = ? AND khatib_id = ?',
      date, khatib.id
    );

    if (!current) {
      return err_('NOT_FOUND', 'لم يتم العثور على تكليف مسجل لك في هذا التاريخ.');
    }

    if (status === 'confirmed') {
      // 1. تأكيد تكليف مؤكد بالفعل هو عملية خاملة ولا تغير رقم الإصدار، لكنها محكومة بشرط بقاء التكليف وإصداره الحاليين
      if (current.status === 'confirmed') {
        const readyRes = await run(db, `
          INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
          SELECT ?, ?, 'ready', ?
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
          )
          ON CONFLICT(date, khatib_id) DO UPDATE SET
            status = excluded.status,
            updated_at = excluded.updated_at
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
          )
        `, date, khatib.id, now,
           current.id, khatib.id, current.updated_at,
           current.id, khatib.id, current.updated_at);

        if (!readyRes?.meta?.changes) {
          return err_('CONFLICT', 'تعذر تأكيد الحضور: تم تعديل حالة التكليف أو قبول اعتذار أثناء معالجة الطلب.');
        }

        return ok_({
          success: true,
          type: 'assignment',
          status: 'confirmed',
          message: 'تم تأكيد حضورك بنجاح. جزاكم الله خيراً.'
        });
      }

      // 2. إذا كانت الحالة معتذراً ومقبولاً من الإدارة، يمنع إعادة التأكيد ذاتياً
      if (current.status === 'excused') {
        const acceptedReq = await one(db,
          'SELECT id FROM excuse_requests WHERE date = ? AND mosque_id = ? AND khatib_id = ? AND status = "accepted" AND reviewed_at >= ?',
          date, current.mosque_id, khatib.id, current.updated_at || ''
        );
        if (acceptedReq) {
          return err_('FORBIDDEN', 'تم قبول اعتذارك السابق من قِبل إدارة الأوقاف؛ لا يمكن إعادة التأكيد ذاتياً ويجب مراجعة المنسق.');
        }
      }

      // 3. تأكيد التكليف مع حماية ذرية (CAS) تشترط مطابقة الهوية والحالة والإصدار بدقة
      const updatedBy = 'الخطيب: ' + khatib.name;
      const stmts = [
        db.prepare(`
          UPDATE assignments
          SET status = 'confirmed', updated_by = ?, updated_at = ?
          WHERE id = ? AND khatib_id = ? AND status = ? AND updated_at = ?
        `).bind(updatedBy, now, current.id, khatib.id, current.status, current.updated_at),
        db.prepare(`
          INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
          SELECT ?, ?, 'ready', ?
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
          )
          ON CONFLICT(date, khatib_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
        `).bind(date, khatib.id, now, current.id, khatib.id, now)
      ];
      const results = await batch(db, stmts);
      if (!results[0]?.meta?.changes) {
        return err_('CONFLICT', 'تعذر تأكيد الحضور: تم تعديل حالة التكليف أو إعادة إسناده أثناء معالجة الطلب.');
      }

      return ok_({
        success: true,
        type: 'assignment',
        status: 'confirmed',
        message: 'تم تأكيد حضورك بنجاح. جزاكم الله خيراً.'
      });
    }

    if (status === 'excused') {
      if (current.status === 'confirmed') {
        const reqId = 'req_' + randomHex(12);
        const notes = String(b.notes || '').trim();

        // إدراج ذري يشترط مطابقة التكليف المؤكد وإصداره بدقة
        const insertRes = await run(db, `
          INSERT INTO excuse_requests (id, date, mosque_id, khatib_id, assignment_version, status, notes, created_at)
          SELECT ?, ?, ?, ?, ?, 'pending', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
          )
          ON CONFLICT(date, mosque_id, khatib_id) WHERE status = 'pending'
          DO UPDATE SET
            assignment_version = excluded.assignment_version,
            notes = CASE WHEN excluded.notes != '' THEN excluded.notes ELSE excuse_requests.notes END,
            created_at = excluded.created_at
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = excluded.assignment_version
          )
        `, reqId, date, current.mosque_id, khatib.id, current.updated_at || '', notes, now,
           current.id, khatib.id, current.updated_at || '',
           current.id, khatib.id);

        if (!insertRes?.meta?.changes) {
          return err_('CONFLICT', 'تعذر تقديم طلب الاعتذار: تم تعديل حالة التكليف أو إلغاؤه أثناء معالجة الطلب.');
        }

        const pendingReq = await one(db,
          'SELECT id, status, created_at, assignment_version FROM excuse_requests WHERE date = ? AND mosque_id = ? AND khatib_id = ? AND status = "pending"',
          date, current.mosque_id, khatib.id
        );

        return ok_({
          success: true,
          type: 'assignment',
          status: 'confirmed',
          pendingReview: true,
          requestId: pendingReq ? pendingReq.id : reqId,
          message: 'تم إرسال طلب الاعتذار إلى مسؤول التنسيق وهو قيد المراجعة حالياً. يظل التكليف قائماً لحين البت في الطلب.'
        });
      }

      // اعتذار أولي (قبل التأكيد): محمي ذرياً بـ CAS لمنع الالتفاف إذا تم التأكيد بالتزامن
      const updatedBy = 'الخطيب: ' + khatib.name;
      const stmts = [
        db.prepare(`
          UPDATE assignments
          SET status = 'excused', updated_by = ?, updated_at = ?
          WHERE id = ? AND khatib_id = ? AND status = ? AND updated_at = ?
        `).bind(updatedBy, now, current.id, khatib.id, current.status, current.updated_at),
        db.prepare(`
          INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
          SELECT ?, ?, 'excused', ?
          WHERE EXISTS (
            SELECT 1 FROM assignments
            WHERE id = ? AND khatib_id = ? AND status = 'excused' AND updated_at = ?
          )
          ON CONFLICT(date, khatib_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
        `).bind(date, khatib.id, now, current.id, khatib.id, now)
      ];
      const results = await batch(db, stmts);
      if (!results[0]?.meta?.changes) {
        return err_('CONFLICT', 'تعذر تسجيل الاعتذار: تم تعديل حالة التكليف أو تأكيده أثناء معالجة الطلب.');
      }

      return ok_({
        success: true,
        type: 'assignment',
        status: 'excused',
        message: 'تم تسجيل اعتذارك عن الخطبة وسينعكس ذلك على جدول التنسيق.'
      });
    }

  } else if (responseType === 'readiness') {
    if (!['ready', 'excused'].includes(status)) {
      return err_('BAD_REQUEST', 'الحالة غير صحيحة (مستعد أو معتذر فقط)');
    }

    const res = await run(db, `
      INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
      SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM assignments
        WHERE date = ? AND khatib_id = ? AND status = 'confirmed' AND ? = 'excused'
      )
      AND NOT EXISTS (
        SELECT 1 FROM assignments a
        JOIN excuse_requests er ON er.date = a.date AND er.mosque_id = a.mosque_id AND er.khatib_id = a.khatib_id
        WHERE a.date = ? AND a.khatib_id = ? AND a.status = 'excused' AND er.status = 'accepted' AND er.reviewed_at >= a.updated_at
        AND ? = 'ready'
      )
      ON CONFLICT(date, khatib_id) DO UPDATE SET
        status = excluded.status,
        updated_at = excluded.updated_at
      WHERE NOT EXISTS (
        SELECT 1 FROM assignments
        WHERE date = excluded.date AND khatib_id = excluded.khatib_id AND status = 'confirmed' AND excluded.status = 'excused'
      )
      AND NOT EXISTS (
        SELECT 1 FROM assignments a
        JOIN excuse_requests er ON er.date = a.date AND er.mosque_id = a.mosque_id AND er.khatib_id = a.khatib_id
        WHERE a.date = excluded.date AND a.khatib_id = excluded.khatib_id AND a.status = 'excused' AND er.status = 'accepted' AND er.reviewed_at >= a.updated_at
        AND excluded.status = 'ready'
      )
    `, date, khatib.id, status, now,
       date, khatib.id, status,
       date, khatib.id, status);

    if (!res?.meta?.changes) {
      const activeConfirmed = await one(db,
        "SELECT 1 FROM assignments WHERE date = ? AND khatib_id = ? AND status = 'confirmed'",
        date, khatib.id
      );
      if (activeConfirmed && status === 'excused') {
        return err_('BAD_REQUEST', 'لديك تكليف مؤكد بمسجد في هذه الجمعة؛ لا يمكن تسجيل الاعتذار عبر الجاهزية ويجب تقديم طلب اعتذار عن التكليف.');
      }
      return err_('FORBIDDEN', 'تم قبول اعتذارك السابق من قِبل إدارة الأوقاف؛ لا يمكن إعادة تسجيل الجاهزية ذاتياً.');
    }

    return ok_({
      success: true,
      type: 'readiness',
      status: status,
      message: status === 'ready'
        ? 'تم تسجيل استعدادك للخطابة بنجاح، وستظهر كجاهز للخطابة في جدول التوزيع.'
        : 'تم تسجيل اعتذارك عن الخطابة في هذه الجمعة بنجاح.'
    });
  }

  return err_('BAD_REQUEST', 'نوع الاستجابة غير معروف');
}

/**
 * الجمعة الحالية بحسب تاريخ القاهرة؛ يبدأ الأسبوع الجديد يوم السبت.
 */
export function currentSermonDate_(now = new Date()) {
  const startIso = todayIso_(now);
  const parts = startIso.split('-');
  let d = new Date(Date.UTC(+parts[0], +parts[1] - 1, +parts[2]));

  // التحرك حتى يوم الجمعة القادم
  while (d.getUTCDay() !== 5) {
    d.setUTCDate(d.getUTCDate() + 1);
  }

  return d.toISOString().slice(0, 10);
}
