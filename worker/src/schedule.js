// أوقاف 15 مايو — إدارة التوزيع والجدول الأسبوعي والنشر العام

import { all, one, run, batch } from './db.js';
import { settingsMap_, setSetting_ } from './settings.js';
import { ok_, err_, isIsoDate_, isFriday_, nowIso_, isTrue_, todayIso_ } from './util.js';

export async function getSchedule_(db, date) {
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');

  const rows = await all(db, `
    SELECT
      a.id,
      a.date,
      a.mosque_id AS mosqueId,
      m.name AS mosque,
      m.mujawra,
      m.sort_order AS sortOrder,
      a.khatib_id AS khatibId,
      k.name AS khatib,
      a.status,
      a.date_type AS dateType,
      a.label,
      a.updated_by AS updatedBy,
      a.updated_at AS updatedAt
    FROM assignments a
    LEFT JOIN mosques m ON a.mosque_id = m.id
    LEFT JOIN khatibs k ON a.khatib_id = k.id
    WHERE a.date = ?
    ORDER BY m.sort_order IS NULL, m.sort_order ASC, a.mosque_id ASC
  `, date);

  let version = '';
  const formatted = rows.map(r => {
    if (r.updatedAt > version) version = r.updatedAt;
    return {
      mosqueId: r.mosqueId,
      mosque: r.mosque || '?',
      mujawra: r.mujawra || '',
      sortOrder: r.sortOrder || 0,
      khatibId: r.khatibId || '',
      khatib: r.khatib || '',
      status: r.status,
      dateType: r.dateType,
      label: r.label || '',
      updatedBy: r.updatedBy || '',
      updatedAt: r.updatedAt || '',
    };
  });

  const readinessRows = await all(db, 'SELECT khatib_id, status FROM khatib_readiness WHERE date = ?', date);
  const khatibReadiness = {};
  for (const rr of readinessRows) {
    khatibReadiness[rr.khatib_id] = rr.status;
  }

  const excuseRequests = await all(db, `
    SELECT er.id, er.date, er.mosque_id AS mosqueId, er.khatib_id AS khatibId, er.assignment_version AS assignmentVersion,
           er.status, er.notes, er.created_at AS createdAt, er.reviewed_by AS reviewedBy, er.reviewed_at AS reviewedAt,
           k.name AS khatibName, m.name AS mosqueName
    FROM excuse_requests er
    JOIN khatibs k ON er.khatib_id = k.id
    JOIN mosques m ON er.mosque_id = m.id
    WHERE er.date = ?
    ORDER BY er.created_at DESC
  `, date);

  const pendingByExactAssignment = new Map();
  for (const er of excuseRequests) {
    if (er.status === 'pending') {
      const key = `${er.mosqueId}_${er.khatibId}_${er.assignmentVersion}`;
      if (!pendingByExactAssignment.has(key)) {
        pendingByExactAssignment.set(key, er);
      }
    }
  }

  for (const f of formatted) {
    const key = `${f.mosqueId}_${f.khatibId}_${f.updatedAt}`;
    const p = (f.status === 'confirmed' && f.khatibId) ? pendingByExactAssignment.get(key) : null;
    f.hasPendingExcuse = !!p;
    f.pendingExcuseRequestId = p ? p.id : null;
  }

  return ok_({
    date,
    exists: formatted.length > 0,
    version,
    rows: formatted,
    khatibReadiness,
    excuseRequests: excuseRequests || []
  });
}

export async function getKhatibSchedule_(db, khatibId, from, to) {
  if (!khatibId) return err_('BAD_REQUEST', 'khatibId مطلوب');

  let sql = `
    SELECT
      a.date,
      a.mosque_id AS mosqueId,
      m.name AS mosque,
      m.mujawra,
      a.status,
      a.label
    FROM assignments a
    LEFT JOIN mosques m ON a.mosque_id = m.id
    WHERE a.khatib_id = ?
  `;
  const params = [khatibId];

  if (from) {
    sql += ' AND a.date >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND a.date <= ?';
    params.push(to);
  }
  sql += ' ORDER BY a.date ASC';

  const rows = await all(db, sql, ...params);
  const formatted = rows.map(r => ({
    date: r.date,
    mosqueId: r.mosqueId,
    mosque: r.mosque || '?',
    mujawra: r.mujawra || '',
    status: r.status,
    label: r.label || '',
  }));

  return ok_({
    khatibId,
    count: formatted.length,
    rows: formatted
  });
}

/**
 * الخطب اللي قبل تاريخ معيّن — عشان المنسق يشوف مين خطب في المسجد قبل كده
 * وهو بيوزّع. بيرجّع أحدث HISTORY_MAX_DATES تاريخ بس عشان الجدول ميتفرّطش.
 */
const HISTORY_MAX_DATES = 8;

export async function getScheduleHistory_(db, from, before) {
  if (!isIsoDate_(from) || !isIsoDate_(before)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  if (from >= before) return ok_({ dates: [], rows: [] });

  const dateRows = await all(db, `
    SELECT date, MAX(label) AS label
    FROM assignments
    WHERE date >= ? AND date < ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT ?
  `, from, before, HISTORY_MAX_DATES);
  if (!dateRows.length) return ok_({ dates: [], rows: [] });

  const oldest = dateRows[dateRows.length - 1].date;
  const rows = await all(db, `
    SELECT a.date, a.mosque_id AS mosqueId, a.khatib_id AS khatibId, k.name AS khatib, a.status
    FROM assignments a
    LEFT JOIN khatibs k ON a.khatib_id = k.id
    WHERE a.date >= ? AND a.date < ? AND a.khatib_id IS NOT NULL AND a.khatib_id != ''
  `, oldest, before);

  return ok_({
    dates: dateRows.map(r => ({ date: r.date, label: r.label || '' })),
    rows: rows.map(r => ({
      date: r.date,
      mosqueId: r.mosqueId,
      khatibId: r.khatibId,
      khatib: r.khatib || '',
      status: r.status,
    })),
  });
}

export async function listDates_(db) {
  const rows = await all(db, `
    SELECT
      date,
      COUNT(*) AS total,
      SUM(CASE WHEN khatib_id IS NOT NULL AND khatib_id != '' THEN 1 ELSE 0 END) AS filled,
      MAX(label) AS label,
      MAX(date_type) AS dateType
    FROM assignments
    GROUP BY date
    ORDER BY date ASC
  `);

  const dates = rows.map(r => ({
    date: r.date,
    total: r.total,
    filled: r.filled || 0,
    label: r.label || '',
    dateType: r.dateType || 'friday'
  }));

  return ok_({ dates });
}

export async function getLoadCounts_(db, from, to) {
  let sql = 'SELECT khatib_id, COUNT(*) AS cnt FROM assignments WHERE khatib_id IS NOT NULL AND khatib_id != ""';
  const params = [];

  if (from) {
    sql += ' AND date >= ?';
    params.push(from);
  }
  if (to) {
    sql += ' AND date <= ?';
    params.push(to);
  }
  sql += ' GROUP BY khatib_id';

  const rows = await all(db, sql, ...params);
  const counts = {};
  for (const r of rows) {
    counts[r.khatib_id] = r.cnt;
  }
  return ok_({ counts });
}

export async function generateDate_(db, user, b) {
  const date = b.date;
  const dateType = b.dateType === 'special' ? 'special' : 'friday';
  const label = String(b.label || '').trim();

  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  if (dateType === 'friday' && !isFriday_(date)) return err_('BAD_REQUEST', 'اختر يوم جمعة');
  if (dateType === 'special' && !label) return err_('BAD_REQUEST', 'اكتب اسم المناسبة');

  const existing = await all(db, 'SELECT id FROM assignments WHERE date = ?', date);
  if (existing.length) {
    return await getSchedule_(db, date);
  }

  const mosques = await all(db, 'SELECT id, permanent_khatib_id FROM mosques WHERE active = 1 ORDER BY id ASC');
  if (!mosques.length) return err_('BAD_REQUEST', 'لا توجد مساجد نشطة');

  const now = nowIso_();
  const stmts = [];
  let prefilled = 0;

  for (const m of mosques) {
    const id = `${date}_${m.id}`;
    const pk = m.permanent_khatib_id || null;
    const status = 'unassigned';
    if (pk) prefilled++;

    stmts.push(db.prepare(`
      INSERT OR IGNORE INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(id, date, m.id, pk, status, dateType, label, user.username, now));
  }

  await batch(db, stmts);

  const res = await getSchedule_(db, date);
  res.data.created = mosques.length;
  res.data.prefilled = prefilled;
  return res;
}

export async function regenerateDate_(db, user, b) {
  const date = b.date;
  const mode = b.mode === 'reset' ? 'reset' : 'fill';
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');

  const existingRows = await all(db, 'SELECT * FROM assignments WHERE date = ?', date);
  if (!existingRows.length) {
    return err_('NOT_FOUND', 'التاريخ ده لسه متولّدش — استخدم "توليد الجمعة"');
  }

  let dateType = 'friday';
  let label = '';
  const onDate = {};
  for (const r of existingRows) {
    onDate[r.mosque_id] = r;
    if (r.date_type) dateType = r.date_type;
    if (r.label) label = r.label;
  }

  const now = nowIso_();
  const stmts = [];
  let cleared = 0;

  if (mode === 'reset') {
    for (const r of existingRows) {
      if (r.khatib_id) cleared++;
      stmts.push(db.prepare(`
        UPDATE assignments SET khatib_id = NULL, status = 'unassigned', updated_by = ?, updated_at = ?
        WHERE id = ?
      `).bind(user.username, now, r.id));
      onDate[r.mosque_id].khatib_id = null;
    }
  }

  // تتبع المحجوزين حالياً
  const taken = new Set();
  for (const mid in onDate) {
    if (onDate[mid].khatib_id) taken.add(onDate[mid].khatib_id);
  }

  const activeMosques = await all(db, 'SELECT id, name, mujawra, permanent_khatib_id FROM mosques WHERE active = 1 ORDER BY id ASC');
  const added = [];
  const skipped = [];
  let filled = 0;

  for (const m of activeMosques) {
    const pk = m.permanent_khatib_id || null;
    const cur = onDate[m.id];

    if (!cur) {
      // مسجد جديد أُضيف بعد توليد التاريخ
      const assign = (pk && !taken.has(pk)) ? pk : null;
      if (assign) taken.add(assign);
      else if (pk) skipped.push(`${m.name} ${m.mujawra}`);

      const newId = `${date}_${m.id}`;
      stmts.push(db.prepare(`
        INSERT INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(newId, date, m.id, assign, 'unassigned', dateType, label, user.username, now));
      added.push(`${m.name} ${m.mujawra}`);
      continue;
    }

    if (!pk || cur.khatib_id) continue;
    if (taken.has(pk)) {
      skipped.push(`${m.name} ${m.mujawra}`);
      continue;
    }

    stmts.push(db.prepare(`
      UPDATE assignments SET khatib_id = ?, status = 'unassigned', updated_by = ?, updated_at = ?
      WHERE id = ?
    `).bind(pk, user.username, now, cur.id));
    taken.add(pk);
    filled++;
  }

  if (stmts.length) {
    await batch(db, stmts);
  }

  const res = await getSchedule_(db, date);
  res.data.mode = mode;
  res.data.addedMosques = added;
  res.data.filled = filled;
  res.data.cleared = cleared;
  res.data.skipped = skipped;
  return res;
}

export async function saveSchedule_(db, user, b) {
  const date = b.date;
  const changes = b.changes || [];
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  if (!changes.length) return await getSchedule_(db, date);

  // التحقق من صحة الحالة
  const VALID_STATUSES = new Set(['confirmed', 'unassigned', 'excused']);
  for (const c of changes) {
    if (c.status !== undefined && !VALID_STATUSES.has(c.status)) {
      return err_('BAD_REQUEST', 'حالة الخطبة غير صحيحة');
    }
  }

  const existingRows = await all(db, `
    SELECT a.*, m.name AS mosque_name, m.mujawra
    FROM assignments a
    LEFT JOIN mosques m ON a.mosque_id = m.id
    WHERE a.date = ?
  `, date);

  const onDate = {};
  for (const r of existingRows) {
    onDate[r.mosque_id] = r;
  }

  // التحقق من وجود ونشاط الخطيب — فقط للخطباء المختلفين عن الخطيب الحالي للصف
  const khatibIdsToCheck = new Set();
  for (const c of changes) {
    const cur = onDate[c.mosqueId];
    const currentKhatibId = cur ? (cur.khatib_id || null) : null;
    const newKhatibId = c.khatibId !== undefined ? (c.khatibId || null) : currentKhatibId;
    if (newKhatibId && newKhatibId !== currentKhatibId) {
      khatibIdsToCheck.add(newKhatibId);
    }
  }

  if (khatibIdsToCheck.size) {
    const ids = [...khatibIdsToCheck];
    const placeholders = ids.map(() => '?').join(',');
    const foundKhatibs = await all(db, `SELECT id, name, active FROM khatibs WHERE id IN (${placeholders})`, ...ids);
    const foundMap = new Map(foundKhatibs.map(k => [k.id, k]));
    for (const kid of ids) {
      const k = foundMap.get(kid);
      if (!k) {
        return err_('BAD_REQUEST', 'الخطيب غير موجود');
      }
      if (!isTrue_(k.active)) {
        return err_('BAD_REQUEST', 'الخطيب غير نشط: ' + k.name);
      }
    }
  }

  // 1. فحص التعديلات المتزامنة (Stale Write Check)
  if (b.version) {
    const stale = [];
    for (const c of changes) {
      const cur = onDate[c.mosqueId];
      if (cur && cur.updated_at > b.version) {
        stale.push({
          mosqueId: c.mosqueId,
          updatedBy: cur.updated_by,
          updatedAt: cur.updated_at
        });
      }
    }
    if (stale.length) {
      return err_('STALE_WRITE', 'حد تاني عدّل نفس الصفوف دي', { conflicts: stale });
    }
  }

  // 2. التحقق من تكرار نفس الخطيب داخل الطلب نفسه
  const seenInPayload = {};
  for (const c of changes) {
    const cur = onDate[c.mosqueId];
    const k = c.khatibId !== undefined ? (c.khatibId || null) : (cur ? cur.khatib_id : null);
    if (!k) continue;
    if (seenInPayload[k]) {
      return err_('KHATIB_DOUBLE_BOOKED', 'نفس الخطيب متكرر في مسجدين', {
        khatibId: k,
        mosques: [seenInPayload[k], c.mosqueId]
      });
    }
    seenInPayload[k] = c.mosqueId;
  }

  // 3. التحقق من تكرار الخطيب مع باقي المساجد المحفوظة على هذا التاريخ
  const changedMosques = new Set(changes.map(c => c.mosqueId));
  for (const c of changes) {
    const cur = onDate[c.mosqueId];
    const kid = c.khatibId !== undefined ? (c.khatibId || null) : (cur ? cur.khatib_id : null);
    if (!kid) continue;
    for (const mid in onDate) {
      if (mid === c.mosqueId || changedMosques.has(mid)) continue;
      if (onDate[mid].khatib_id === kid) {
        const mLabel = `${onDate[mid].mosque_name || mid} ${onDate[mid].mujawra || ''}`.trim();
        return err_('KHATIB_DOUBLE_BOOKED', 'الخطيب محجوز في: ' + mLabel, {
          khatibId: kid,
          conflictMosqueId: mid
        });
      }
    }
  }

  // 4. كتابة التعديلات داخل معاملة ذرية واحدة
  // الخطوة 4أ: تصفير خطيب الصفوف المعدلة لتجنب خطأ الفهرس الفريد عند التبديل
  // الخطوة 4ب: تطبيق القيم النهائية
  const now = nowIso_();
  const stmts = [];

  for (const c of changes) {
    const cur = onDate[c.mosqueId];
    if (!cur) continue;
    stmts.push(db.prepare(`
      UPDATE assignments
      SET khatib_id = NULL
      WHERE id = ?
    `).bind(cur.id));
  }

  for (const c of changes) {
    const cur = onDate[c.mosqueId];
    if (!cur) continue;
    const kid = c.khatibId !== undefined ? (c.khatibId || null) : (cur ? cur.khatib_id : null);
    // الإسناد الجديد ينتظر التأكيد؛ الحفظ بلا تغيير للخطيب يحافظ على رده الحالي.
    const status = !kid ? 'unassigned' : (c.status || (kid === cur.khatib_id ? cur.status : 'unassigned'));

    stmts.push(db.prepare(`
      UPDATE assignments
      SET khatib_id = ?, status = ?, updated_by = ?, updated_at = ?
      WHERE id = ?
    `).bind(kid, status, user.username, now, cur.id));
  }

  if (stmts.length) {
    try {
      await batch(db, stmts);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (msg.includes('UNIQUE') || msg.includes('idx_assignments_date_khatib')) {
        return err_('KHATIB_DOUBLE_BOOKED', 'الخطيب محجوز بالفعل في مسجد آخر في هذا التاريخ');
      }
      throw err;
    }
  }

  return await getSchedule_(db, date);
}

/**
 * النشر بطريقتين: تواريخ بعينها (dates) من أزرار الجمع، أو فترة from..to.
 * مع التواريخ بنحفظ from/to = أول وآخر تاريخ عشان أي حاجة بتقرا الفترة تفضل شغالة.
 * أو النشر التلقائي للجمعة القادمة عبر mode: 'auto'.
 */
export async function publishRange_(db, b) {
  if (b.mode === 'auto') {
    await setSetting_(db, 'publish_mode', 'auto');
    await setSetting_(db, 'publish_dates', '');
    const hideEmptyVal = isTrue_(b.hideEmpty) ? '1' : '';
    await setSetting_(db, 'publish_hide_empty', hideEmptyVal);
    return ok_({ mode: 'auto', from: '', to: '', dates: [], hideEmpty: hideEmptyVal === '1' });
  }

  // أي نشر يدوي أو إلغاء نشر يعيد publish_mode إلى فارغ
  await setSetting_(db, 'publish_mode', '');

  let from = b.from || '';
  let to = b.to || '';
  let dates = [];

  if (Array.isArray(b.dates)) {
    for (const d of b.dates) {
      if (!isIsoDate_(d)) return err_('BAD_REQUEST', 'تاريخ غير صحيح: ' + d);
    }
    dates = [...new Set(b.dates)].sort();
    from = dates[0] || '';
    to = dates[dates.length - 1] || '';
  } else {
    if (from && !isIsoDate_(from)) return err_('BAD_REQUEST', 'تاريخ البداية غير صحيح');
    if (to && !isIsoDate_(to)) return err_('BAD_REQUEST', 'تاريخ النهاية غير صحيح');
    if (from && to && from > to) return err_('BAD_REQUEST', 'تاريخ البداية بعد تاريخ النهاية');
  }

  await setSetting_(db, 'publish_from', from);
  await setSetting_(db, 'publish_to', to);
  await setSetting_(db, 'publish_dates', dates.join(','));

  const isUnpublish = !from || !to;
  const hideEmptyVal = (!isUnpublish && isTrue_(b.hideEmpty)) ? '1' : '';
  await setSetting_(db, 'publish_hide_empty', hideEmptyVal);

  return ok_({ mode: '', from, to, dates, hideEmpty: hideEmptyVal === '1' });
}

export async function publicSchedule_(db, date) {
  const settings = await settingsMap_(db);

  if (settings.publish_mode === 'auto') {
    const today = todayIso_();
    const nextRow = await one(db, `
      SELECT date, MAX(label) AS label
      FROM assignments
      WHERE date >= ?
      GROUP BY date
      ORDER BY date ASC
      LIMIT 1
    `, today);

    if (!nextRow) {
      return ok_({ published: false, dates: [], rows: [] });
    }

    const target = nextRow.date;
    const targetLabel = nextRow.label || '';

    const targetRowsRaw = await all(db, `
      SELECT
        a.date,
        a.label,
        a.status,
        m.name AS mosque,
        m.mujawra,
        k.name AS khatib
      FROM assignments a
      JOIN mosques m ON a.mosque_id = m.id
      LEFT JOIN khatibs k ON a.khatib_id = k.id
      WHERE a.date = ? AND m.active = 1
      ORDER BY m.sort_order IS NULL, m.sort_order ASC, a.mosque_id ASC
    `, target);

    const hideEmpty = settings.publish_hide_empty === '1';

    let targetRows = targetRowsRaw;
    if (hideEmpty) {
      targetRows = targetRows.filter(r => r.status === 'confirmed' && r.khatib && r.khatib.trim());
    }

    const rows = targetRows.map((r, i) => ({
      no: i + 1,
      mosque: r.mosque,
      mujawra: r.mujawra,
      khatib: r.status === 'confirmed' ? (r.khatib || '') : ''
    }));

    return ok_({
      published: true,
      date: target,
      dates: [{ date: target, label: targetLabel }],
      rows
    });
  }

  const from = settings.publish_from;
  const to = settings.publish_to;

  if (!from || !to) {
    return ok_({ published: false, dates: [], rows: [] });
  }

  // لو النشر بتواريخ بعينها، اللي بين أول وآخر تاريخ ومش مختار مايظهرش
  const picked = new Set(String(settings.publish_dates || '').split(',').filter(Boolean));

  const inWindow = (await all(db, `
    SELECT
      a.date,
      a.label,
      a.status,
      m.name AS mosque,
      m.mujawra,
      k.name AS khatib
    FROM assignments a
    JOIN mosques m ON a.mosque_id = m.id
    LEFT JOIN khatibs k ON a.khatib_id = k.id
    WHERE a.date >= ? AND a.date <= ? AND m.active = 1
    ORDER BY a.date ASC, m.sort_order IS NULL, m.sort_order ASC, a.mosque_id ASC
  `, from, to)).filter(r => !picked.size || picked.has(r.date));

  const datesMap = {};
  for (const r of inWindow) {
    datesMap[r.date] = r.label || '';
  }

  const dateList = Object.keys(datesMap).sort().map(d => ({ date: d, label: datesMap[d] }));
  if (!dateList.length) {
    return ok_({ published: false, dates: [], rows: [] });
  }

  const target = date && datesMap.hasOwnProperty(date) ? date : dateList[0].date;

  const hideEmpty = settings.publish_hide_empty === '1';

  let targetRows = inWindow.filter(r => r.date === target);
  if (hideEmpty) {
    targetRows = targetRows.filter(r => r.status === 'confirmed' && r.khatib && r.khatib.trim());
  }

  // نفس ترتيب شاشة التوزيع، والرقم مسلسل من 1 عشان القائمة العامة متبقاش فيها فجوات
  const rows = targetRows.map((r, i) => ({
    no: i + 1,
    mosque: r.mosque,
    mujawra: r.mujawra,
    khatib: r.status === 'confirmed' ? (r.khatib || '') : ''
  }));

  return ok_({
    published: true,
    date: target,
    dates: dateList,
    rows
  });
}


export async function listExcuseRequests_(db, b = {}) {
  const date = b.date ? String(b.date).trim() : null;
  const status = b.status ? String(b.status).trim() : null;

  let sql = `
    SELECT
      er.id, er.date, er.mosque_id AS mosqueId, er.khatib_id AS khatibId,
      er.assignment_version AS assignmentVersion,
      er.status, er.notes, er.created_at AS createdAt,
      er.reviewed_by AS reviewedBy, er.reviewed_at AS reviewedAt,
      m.name AS mosqueName, m.mujawra,
      k.name AS khatibName, k.phone AS khatibPhone,
      a.status AS currentAssignmentStatus, a.khatib_id AS currentAssignmentKhatibId, a.updated_at AS currentAssignmentVersion
    FROM excuse_requests er
    JOIN mosques m ON er.mosque_id = m.id
    JOIN khatibs k ON er.khatib_id = k.id
    LEFT JOIN assignments a ON a.date = er.date AND a.mosque_id = er.mosque_id
    WHERE 1=1
  `;
  const params = [];
  if (date) {
    sql += ' AND er.date = ?';
    params.push(date);
  }
  if (status) {
    sql += ' AND er.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY er.created_at DESC';

  const rows = await all(db, sql, ...params);
  return ok_({ requests: rows });
}

export async function reviewExcuseRequest_(db, user, b = {}) {
  const requestId = String(b.requestId || '').trim();
  const decision = String(b.decision || '').trim();

  if (!requestId) {
    return err_('BAD_REQUEST', 'معرف الطلب مطلوب');
  }
  if (!['accept', 'reject'].includes(decision)) {
    return err_('BAD_REQUEST', 'القرار يجب أن يكون إما قبول أو رفض');
  }

  const req = await one(db, 'SELECT * FROM excuse_requests WHERE id = ?', requestId);
  if (!req) {
    return err_('NOT_FOUND', 'طلب الاعتذار غير موجود');
  }

  if (req.status !== 'pending') {
    return err_('ALREADY_REVIEWED', 'تمت مراجعة هذا الطلب مسبقاً');
  }

  const now = nowIso_();

  const assignId = `${req.date}_${req.mosque_id}`;

  if (decision === 'reject') {
    const updateRes = await run(db, `
      UPDATE excuse_requests
      SET status = 'rejected', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM assignments
          WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
        )
    `, user.username, now, requestId, assignId, req.khatib_id, req.assignment_version);

    if (!updateRes?.meta?.changes) {
      const freshReq = await one(db, 'SELECT status FROM excuse_requests WHERE id = ?', requestId);
      if (!freshReq || freshReq.status !== 'pending') {
        return err_('ALREADY_REVIEWED', 'تمت مراجعة هذا الطلب مسبقاً من قِبل مستخدم آخر');
      }

      const curAssign = await one(db, 'SELECT khatib_id, status, updated_at FROM assignments WHERE id = ?', assignId);
      return err_('STALE_REQUEST', 'تعذر رفض الطلب: تم تغيير التكليف أو الخطيب المسند للمسجد مسبقاً.', {
        currentKhatibId: curAssign ? curAssign.khatib_id : null,
        currentStatus: curAssign ? curAssign.status : null,
        targetVersion: req.assignment_version,
        currentVersion: curAssign ? curAssign.updated_at : null
      });
    }

    return ok_({
      requestId,
      decision: 'reject',
      status: 'rejected',
      assignmentModified: false,
      date: req.date,
      mosqueId: req.mosque_id,
      khatibId: req.khatib_id
    });
  }

  // decision === 'accept':
  // Atomic CAS in a single batch:
  // Both the request update and the assignment update are predicated on:
  // 1. Request is still pending.
  // 2. Target assignment still matches exactly (mosque, khatib, confirmed status, version).
  const stmts = [
    db.prepare(`
      UPDATE excuse_requests
      SET status = 'accepted', reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND status = 'pending'
        AND EXISTS (
          SELECT 1 FROM assignments
          WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
        )
    `).bind(user.username, now, requestId, assignId, req.khatib_id, req.assignment_version),

    db.prepare(`
      UPDATE assignments
      SET status = 'excused', updated_by = ?, updated_at = ?
      WHERE id = ? AND khatib_id = ? AND status = 'confirmed' AND updated_at = ?
        AND EXISTS (
          SELECT 1 FROM excuse_requests
          WHERE id = ? AND status = 'accepted' AND reviewed_at = ?
        )
    `).bind(user.username, now, assignId, req.khatib_id, req.assignment_version, requestId, now),

    db.prepare(`
      INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
      SELECT ?, ?, 'excused', ?
      WHERE EXISTS (
        SELECT 1 FROM excuse_requests
        WHERE id = ? AND status = 'accepted' AND reviewed_at = ?
      )
      ON CONFLICT(date, khatib_id) DO UPDATE SET status = 'excused', updated_at = excluded.updated_at
    `).bind(req.date, req.khatib_id, now, requestId, now)
  ];

  const results = await batch(db, stmts);

  const reqUpdated = results[0]?.meta?.changes > 0;
  const assignUpdated = results[1]?.meta?.changes > 0;

  if (!reqUpdated || !assignUpdated) {
    const freshReq = await one(db, 'SELECT status FROM excuse_requests WHERE id = ?', requestId);
    if (!freshReq || freshReq.status !== 'pending') {
      return err_('ALREADY_REVIEWED', 'تمت مراجعة هذا الطلب مسبقاً من قِبل مستخدم آخر');
    }

    const curAssign = await one(db, 'SELECT khatib_id, status, updated_at FROM assignments WHERE id = ?', assignId);
    return err_('STALE_REQUEST', 'تعذر قبول الطلب: تم تغيير التكليف أو الخطيب المسند للمسجد مسبقاً.', {
      currentKhatibId: curAssign ? curAssign.khatib_id : null,
      currentStatus: curAssign ? curAssign.status : null,
      targetVersion: req.assignment_version,
      currentVersion: curAssign ? curAssign.updated_at : null
    });
  }

  return ok_({
    requestId,
    decision: 'accept',
    status: 'accepted',
    assignmentModified: true,
    date: req.date,
    mosqueId: req.mosque_id,
    khatibId: req.khatib_id
  });
}
