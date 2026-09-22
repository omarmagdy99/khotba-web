// أوقاف 15 مايو — إدارة الخطباء والتفضيلات

import { all, one, run, batch } from './db.js';
import { nextId_ } from './settings.js';
import { ok_, err_, norm_, normPhone, isValidPhone, isTrue_, nowIso_, todayIso_ } from './util.js';

export function publicKhatib_(k, prefs = []) {
  return {
    id: k.id,
    name: k.name,
    phone: k.phone || '',
    type: k.type,
    notes: k.notes || '',
    active: isTrue_(k.active),
    preferences: prefs,
  };
}

export async function listKhatibs_(db, includeInactive) {
  const pRows = await all(db, 'SELECT khatib_id, mosque_id FROM preferences');
  const prefsMap = {};
  for (const p of pRows) {
    if (!prefsMap[p.khatib_id]) prefsMap[p.khatib_id] = [];
    prefsMap[p.khatib_id].push(p.mosque_id);
  }

  const sql = includeInactive
    ? 'SELECT * FROM khatibs ORDER BY id ASC'
    : 'SELECT * FROM khatibs WHERE active = 1 ORDER BY id ASC';
  const rows = await all(db, sql);

  return ok_({
    khatibs: rows.map(k => publicKhatib_(k, prefsMap[k.id] || []))
  });
}

export async function saveKhatib_(db, user, b, isNew) {
  const name = String(b.name || '').trim();
  if (!name) return err_('BAD_REQUEST', 'اسم الخطيب مطلوب');

  const rawPhone = b.phone ? normPhone(b.phone) : null;
  if (b.phone && (!rawPhone || !isValidPhone(rawPhone))) {
    return err_('BAD_REQUEST', 'رقم الموبايل لازم يكون 11 رقم ويبدأ بـ 01');
  }

  if (rawPhone) {
    const clash = isNew
      ? await one(db, 'SELECT id, name FROM khatibs WHERE phone = ?', rawPhone)
      : await one(db, 'SELECT id, name FROM khatibs WHERE phone = ? AND id != ?', rawPhone, b.id);
    if (clash) {
      return err_('DUPLICATE', 'رقم الموبايل ده مسجل بالفعل للخطيب: ' + clash.name);
    }
  }

  const type = b.type === 'volunteer' ? 'volunteer' : 'primary';

  if (isNew) {
    const allKhatibs = await all(db, 'SELECT id, name FROM khatibs');
    const id = await nextId_(db, 'next_khatib_seq', 'K');
    const now = nowIso_();
    await run(db,
      'INSERT INTO khatibs (id, name, phone, type, notes, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      id, name, rawPhone, type, b.notes || '', now
    );

    const normName = norm_(name);
    const similar = allKhatibs
      .filter(k => norm_(k.name) === normName)
      .map(k => k.id);

    return ok_({ id, similarTo: similar });
  }

  const existing = await one(db, 'SELECT * FROM khatibs WHERE id = ?', b.id);
  if (!existing) return err_('NOT_FOUND', 'الخطيب غير موجود');

  const active = b.active === false || b.active === 0 || b.active === 'FALSE' ? 0 : 1;
  await run(db,
    'UPDATE khatibs SET name = ?, phone = ?, type = ?, notes = ?, active = ? WHERE id = ?',
    name, rawPhone, type, b.notes || '', active, b.id
  );

  if (isTrue_(existing.active) && !active) {
    await deactivateKhatib_(db, user, b.id);
  }

  return ok_({ id: b.id });
}

export async function deactivateKhatib_(db, user, id) {
  const k = await one(db, 'SELECT * FROM khatibs WHERE id = ?', id);
  if (!k) return err_('NOT_FOUND', 'غير موجود');

  await run(db, 'UPDATE khatibs SET active = 0 WHERE id = ?', id);

  // 1. مسح الخطيب الثابت من أي مسجد
  const mosques = await all(db, 'SELECT id, name, mujawra FROM mosques WHERE permanent_khatib_id = ?', id);
  const clearedPermanent = [];
  if (mosques.length) {
    await run(db, 'UPDATE mosques SET permanent_khatib_id = NULL WHERE permanent_khatib_id = ?', id);
    for (const m of mosques) {
      clearedPermanent.push(m.name + ' ' + m.mujawra);
    }
  }

  // 2. إخلاء الخطب المستقبلية
  const today = todayIso_();
  const future = await all(db, 'SELECT id, date, mosque_id FROM assignments WHERE khatib_id = ? AND date >= ?', id, today);
  const cleared = [];
  const stmts = [];
  const now = nowIso_();

  for (const a of future) {
    stmts.push(db.prepare('UPDATE assignments SET khatib_id = NULL, status = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .bind('unassigned', user.username, now, a.id));
    cleared.push({ date: a.date, mosqueId: a.mosque_id });
  }

  if (stmts.length) {
    await batch(db, stmts);
  }

  return ok_({ clearedAssignments: cleared, clearedPermanentAt: clearedPermanent });
}

export async function setPreferences_(db, khatibId, mosqueIds) {
  if (!khatibId) return err_('BAD_REQUEST', 'khatibId مطلوب');
  const ids = (mosqueIds || []).filter((v, i, arr) => v && arr.indexOf(v) === i);

  const stmts = [
    db.prepare('DELETE FROM preferences WHERE khatib_id = ?').bind(khatibId)
  ];

  for (const mid of ids) {
    stmts.push(db.prepare('INSERT INTO preferences (khatib_id, mosque_id) VALUES (?, ?)').bind(khatibId, mid));
  }

  await batch(db, stmts);
  return ok_({ count: ids.length });
}
