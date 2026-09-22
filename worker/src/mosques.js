// أوقاف 15 مايو — إدارة المساجد

import { all, one, run, batch } from './db.js';
import { nextId_ } from './settings.js';
import { ok_, err_, norm_, isTrue_, nowIso_, todayIso_ } from './util.js';

export function publicMosque_(m) {
  return {
    id: m.id,
    name: m.name,
    mujawra: m.mujawra,
    address: m.address || '',
    permanentKhatibId: m.permanent_khatib_id || '',
    active: isTrue_(m.active),
  };
}

export async function listMosques_(db, includeInactive) {
  const sql = includeInactive
    ? 'SELECT * FROM mosques ORDER BY id ASC'
    : 'SELECT * FROM mosques WHERE active = 1 ORDER BY id ASC';
  const rows = await all(db, sql);
  return ok_({ mosques: rows.map(publicMosque_) });
}

export async function saveMosque_(db, user, b, isNew) {
  const name = String(b.name || '').trim();
  const mujawra = String(b.mujawra || '').trim();
  if (!name || !mujawra) {
    return err_('BAD_REQUEST', 'اسم المسجد والمجاورة مطلوبان');
  }

  const allMosques = await all(db, 'SELECT * FROM mosques');

  // التحقق من الهوية: (الاسم، المجاورة)
  const normName = norm_(name);
  const normMuj = norm_(mujawra);
  const clash = allMosques.find(m => m.id !== b.id && norm_(m.name) === normName && norm_(m.mujawra) === normMuj);
  if (clash) {
    return err_('DUPLICATE', 'يوجد مسجد بنفس الاسم في نفس المجاورة');
  }

  const pk = String(b.permanentKhatibId || '').trim();
  if (pk) {
    const taken = allMosques.find(m => m.id !== b.id && m.permanent_khatib_id === pk);
    if (taken) {
      return err_('PERMANENT_CONFLICT', 'هذا الخطيب ثابت بالفعل في: ' + taken.name + ' ' + taken.mujawra);
    }
  }

  if (isNew) {
    const id = await nextId_(db, 'next_mosque_seq', 'M');
    const now = nowIso_();
    try {
      await run(db,
        'INSERT INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        id, name, mujawra, b.address || '', pk ? pk : null, now
      );
    } catch (err) {
      const msg = String(err && err.message || err);
      if (msg.includes('UNIQUE') && (msg.includes('idx_mosques_permanent') || msg.includes('permanent_khatib_id'))) {
        const taken = pk ? await one(db, 'SELECT name, mujawra FROM mosques WHERE permanent_khatib_id = ?', pk) : null;
        const msgText = taken ? `هذا الخطيب ثابت بالفعل في: ${taken.name} ${taken.mujawra}` : 'هذا الخطيب ثابت بالفعل في مسجد آخر';
        return err_('PERMANENT_CONFLICT', msgText);
      }
      throw err;
    }
    return ok_({ id });
  }

  const existing = await one(db, 'SELECT * FROM mosques WHERE id = ?', b.id);
  if (!existing) {
    return err_('NOT_FOUND', 'المسجد غير موجود');
  }

  const active = b.active === false || b.active === 0 || b.active === 'FALSE' ? 0 : 1;
  try {
    await run(db,
      'UPDATE mosques SET name = ?, mujawra = ?, address = ?, permanent_khatib_id = ?, active = ? WHERE id = ?',
      name, mujawra, b.address || '', pk ? pk : null, active, b.id
    );
  } catch (err) {
    const msg = String(err && err.message || err);
    if (msg.includes('UNIQUE') && (msg.includes('idx_mosques_permanent') || msg.includes('permanent_khatib_id'))) {
      const taken = pk ? await one(db, 'SELECT name, mujawra FROM mosques WHERE permanent_khatib_id = ? AND id != ?', pk, b.id) : null;
      const msgText = taken ? `هذا الخطيب ثابت بالفعل في: ${taken.name} ${taken.mujawra}` : 'هذا الخطيب ثابت بالفعل في مسجد آخر';
      return err_('PERMANENT_CONFLICT', msgText);
    }
    throw err;
  }

  if (isTrue_(existing.active) && !active) {
    await deactivateMosque_(db, user, b.id);
  }

  return ok_({ id: b.id });
}

export async function deactivateMosque_(db, user, id) {
  const m = await one(db, 'SELECT * FROM mosques WHERE id = ?', id);
  if (!m) return err_('NOT_FOUND', 'غير موجود');

  await run(db, 'UPDATE mosques SET active = 0 WHERE id = ?', id);

  const today = todayIso_();
  const future = await all(db, 'SELECT * FROM assignments WHERE mosque_id = ? AND date >= ?', id, today);

  const cleared = future.map(a => ({
    date: a.date,
    mosqueId: a.mosque_id,
    khatibId: a.khatib_id || null
  }));

  if (future.length) {
    await run(db, 'DELETE FROM assignments WHERE mosque_id = ? AND date >= ?', id, today);
  }

  return ok_({ clearedAssignments: cleared, clearedPermanentAt: [], stillAssigned: 0 });
}
