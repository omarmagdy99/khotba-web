// أوقاف 15 مايو — إدارة المساجد

import { all, one, run, batch } from './db.js';
import { nextId_ } from './settings.js';
import { ok_, err_, norm_, normPhone, isValidPhone, isTrue_, nowIso_, todayIso_ } from './util.js';

export function publicMosque_(m) {
  return {
    id: m.id,
    name: m.name,
    mujawra: m.mujawra,
    address: m.address || '',
    permanentKhatibId: m.permanent_khatib_id || '',
    active: isTrue_(m.active),
    sortOrder: m.sort_order || 0,
    managerPhone: m.manager_phone || '',
    managerHasPassword: !!m.manager_password_hash,
    managerTelegramLinked: !!m.manager_telegram_chat_id,
  };
}

// ترتيب المساجد الموحّد في كل الشاشات (رقم المسجد)
const MOSQUE_ORDER = 'sort_order IS NULL, sort_order ASC, id ASC';

export async function listMosques_(db, includeInactive) {
  const sql = includeInactive
    ? `SELECT m.*, a.password_hash AS manager_password_hash, a.telegram_chat_id AS manager_telegram_chat_id FROM mosques m LEFT JOIN mosque_accounts a ON a.phone = m.manager_phone ORDER BY m.active DESC, m.sort_order IS NULL, m.sort_order ASC, m.id ASC`
    : `SELECT m.*, a.password_hash AS manager_password_hash, a.telegram_chat_id AS manager_telegram_chat_id FROM mosques m LEFT JOIN mosque_accounts a ON a.phone = m.manager_phone WHERE m.active = 1 ORDER BY m.sort_order IS NULL, m.sort_order ASC, m.id ASC`;
  const rows = await all(db, sql);
  return ok_({ mosques: rows.map(publicMosque_) });
}

/**
 * بيخلّي أرقام المساجد متصلة 1..N: النشطين الأول بترتيبهم، وبعدهم غير النشطين.
 * لو اتبعت moveId، المسجد ده بيتنقل للرقم position ويزق اللي بعده.
 */
export async function renumberMosques_(db, moveId, position) {
  const list = await all(db, `SELECT id, active, sort_order FROM mosques ORDER BY active DESC, ${MOSQUE_ORDER}`);

  if (moveId) {
    const i = list.findIndex(m => m.id === moveId);
    if (i >= 0) {
      const [moved] = list.splice(i, 1);
      const activeCount = list.filter(m => isTrue_(m.active)).length;
      const pos = Math.min(Math.max(parseInt(position, 10) || 1, 1), activeCount + 1);
      list.splice(pos - 1, 0, moved);
    }
  }

  const stmts = [];
  list.forEach((m, i) => {
    if (m.sort_order !== i + 1) {
      stmts.push(db.prepare('UPDATE mosques SET sort_order = ? WHERE id = ?').bind(i + 1, m.id));
    }
  });
  await batch(db, stmts);
}

export async function reorderMosque_(db, b) {
  const m = await one(db, 'SELECT id, active FROM mosques WHERE id = ?', b.id);
  if (!m) return err_('NOT_FOUND', 'المسجد غير موجود');
  if (!isTrue_(m.active)) return err_('BAD_REQUEST', 'فعّل المسجد الأول قبل ما تغيّر رقمه');
  const pos = parseInt(b.position, 10);
  if (!pos || pos < 1) return err_('BAD_REQUEST', 'رقم المسجد لازم يكون 1 أو أكبر');

  await renumberMosques_(db, b.id, pos);
  return await listMosques_(db, true);
}

export async function saveMosque_(db, user, b, isNew) {
  const name = String(b.name || '').trim();
  const mujawra = String(b.mujawra || '').trim();
  if (!name || !mujawra) {
    return err_('BAD_REQUEST', 'اسم المسجد والمجاورة مطلوبان');
  }
  const managerPhone = b.managerPhone === undefined && !isNew
    ? undefined : normPhone(b.managerPhone);
  if (managerPhone && !isValidPhone(managerPhone)) return err_('BAD_REQUEST', 'رقم هاتف مدير المسجد غير صحيح');

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
        'INSERT INTO mosques (id, name, mujawra, address, permanent_khatib_id, manager_phone, active, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        id, name, mujawra, b.address || '', pk ? pk : null, managerPhone, now
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
    await renumberMosques_(db);
    return ok_({ id });
  }

  const existing = await one(db, 'SELECT * FROM mosques WHERE id = ?', b.id);
  if (!existing) {
    return err_('NOT_FOUND', 'المسجد غير موجود');
  }

  const active = b.active === false || b.active === 0 || b.active === 'FALSE' ? 0 : 1;
  try {
    await run(db,
      'UPDATE mosques SET name = ?, mujawra = ?, address = ?, permanent_khatib_id = ?, manager_phone = ?, active = ? WHERE id = ?',
      name, mujawra, b.address || '', pk ? pk : null, managerPhone === undefined ? existing.manager_phone : managerPhone, active, b.id
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
  } else if (isTrue_(existing.active) !== !!active) {
    await renumberMosques_(db);
  }

  return ok_({ id: b.id });
}

export async function deactivateMosque_(db, user, id) {
  const m = await one(db, 'SELECT * FROM mosques WHERE id = ?', id);
  if (!m) return err_('NOT_FOUND', 'غير موجود');

  await run(db, 'UPDATE mosques SET active = 0 WHERE id = ?', id);
  await renumberMosques_(db);

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
