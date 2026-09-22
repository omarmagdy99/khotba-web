// أوقاف 15 مايو — إدارة التوزيع والجدول الأسبوعي والنشر العام

import { all, one, run, batch } from './db.js';
import { settingsMap_, setSetting_ } from './settings.js';
import { ok_, err_, isIsoDate_, isFriday_, nowIso_, isTrue_ } from './util.js';

export async function getSchedule_(db, date) {
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');

  const rows = await all(db, `
    SELECT 
      a.id,
      a.date,
      a.mosque_id AS mosqueId,
      m.name AS mosque,
      m.mujawra,
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
    ORDER BY a.mosque_id ASC
  `, date);

  let version = '';
  const formatted = rows.map(r => {
    if (r.updatedAt > version) version = r.updatedAt;
    return {
      mosqueId: r.mosqueId,
      mosque: r.mosque || '?',
      mujawra: r.mujawra || '',
      khatibId: r.khatibId || '',
      khatib: r.khatib || '',
      status: r.status,
      dateType: r.dateType,
      label: r.label || '',
      updatedBy: r.updatedBy || '',
      updatedAt: r.updatedAt || '',
    };
  });

  return ok_({
    date,
    exists: formatted.length > 0,
    version,
    rows: formatted
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
    const status = pk ? 'confirmed' : 'unassigned';
    if (pk) prefilled++;

    stmts.push(db.prepare(`
      INSERT INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
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
      `).bind(newId, date, m.id, assign, assign ? 'confirmed' : 'unassigned', dateType, label, user.username, now));
      added.push(`${m.name} ${m.mujawra}`);
      continue;
    }

    if (!pk || cur.khatib_id) continue;
    if (taken.has(pk)) {
      skipped.push(`${m.name} ${m.mujawra}`);
      continue;
    }

    stmts.push(db.prepare(`
      UPDATE assignments SET khatib_id = ?, status = 'confirmed', updated_by = ?, updated_at = ?
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

  // التحقق من وجود ونشاط الخطيب
  const khatibIdsToCheck = [...new Set(changes.map(c => c.khatibId).filter(Boolean))];
  if (khatibIdsToCheck.length) {
    const placeholders = khatibIdsToCheck.map(() => '?').join(',');
    const foundKhatibs = await all(db, `SELECT id, name, active FROM khatibs WHERE id IN (${placeholders})`, ...khatibIdsToCheck);
    const foundMap = new Map(foundKhatibs.map(k => [k.id, k]));
    for (const kid of khatibIdsToCheck) {
      const k = foundMap.get(kid);
      if (!k) {
        return err_('BAD_REQUEST', 'الخطيب غير موجود');
      }
      if (!isTrue_(k.active)) {
        return err_('BAD_REQUEST', 'الخطيب غير نشط: ' + k.name);
      }
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
    const k = c.khatibId;
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
    const kid = c.khatibId;
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
    const kid = c.khatibId ? c.khatibId : null;
    const status = c.status || (kid ? 'confirmed' : 'unassigned');

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

export async function publishRange_(db, from, to) {
  if (from && !isIsoDate_(from)) return err_('BAD_REQUEST', 'تاريخ البداية غير صحيح');
  if (to && !isIsoDate_(to)) return err_('BAD_REQUEST', 'تاريخ النهاية غير صحيح');
  if (from && to && from > to) return err_('BAD_REQUEST', 'تاريخ البداية بعد تاريخ النهاية');

  await setSetting_(db, 'publish_from', from || '');
  await setSetting_(db, 'publish_to', to || '');

  return ok_({ from: from || '', to: to || '' });
}

export async function publicSchedule_(db, date) {
  const settings = await settingsMap_(db);
  const from = settings.publish_from;
  const to = settings.publish_to;

  if (!from || !to) {
    return ok_({ published: false, dates: [], rows: [] });
  }

  const inWindow = await all(db, `
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
    ORDER BY a.date ASC, m.mujawra ASC, m.name ASC
  `, from, to);

  const datesMap = {};
  for (const r of inWindow) {
    datesMap[r.date] = r.label || '';
  }

  const dateList = Object.keys(datesMap).sort().map(d => ({ date: d, label: datesMap[d] }));
  if (!dateList.length) {
    return ok_({ published: false, dates: [], rows: [] });
  }

  const target = date && datesMap.hasOwnProperty(date) ? date : dateList[0].date;

  const rows = inWindow
    .filter(r => r.date === target)
    .map(r => ({
      mosque: r.mosque,
      mujawra: r.mujawra,
      khatib: r.status === 'confirmed' ? (r.khatib || '') : ''
    }))
    .sort((x, y) => {
      if (x.mujawra === y.mujawra) {
        return x.mosque.localeCompare(y.mosque, 'ar');
      }
      return x.mujawra.localeCompare(y.mujawra, 'ar');
    });

  return ok_({
    published: true,
    date: target,
    dates: dateList,
    rows
  });
}
