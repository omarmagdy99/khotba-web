// أوقاف 15 مايو — المصادقة وإدارة الجلسات

import { one, run, batch } from './db.js';
import { hashPassword, timingSafeEqual, randomHex } from './crypto.js';
import { ok_, err_, isTrue_ } from './util.js';

const SESSION_DAYS = 7;

export async function login_(db, env, b) {
  const username = String(b.username || '').trim();
  const password = String(b.password || '');

  const bad = err_('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if (!username || !password) return bad;

  const u = await one(db, 'SELECT * FROM users WHERE username = ?', username);
  if (!u || !isTrue_(u.active)) return bad;

  const computed = hashPassword(password, u.salt, env.PEPPER);
  if (!timingSafeEqual(computed, u.password_hash)) return bad;

  const token = randomHex(32); // 64 hex characters
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();

  await run(db, 'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)', token, u.username, expires);

  return ok_({ token, displayName: u.display_name, expiresAt: expires });
}

export async function logout_(db, b) {
  if (b.token) {
    await run(db, 'DELETE FROM sessions WHERE token = ?', b.token);
  }
  return ok_({});
}

export async function auth_(db, token) {
  if (!token) return null;

  const s = await one(db, 'SELECT * FROM sessions WHERE token = ?', token);
  if (!s) return null;

  if (new Date(s.expires_at) < new Date()) {
    // حذف الجلسة المنتهية بشكل غير متزامن
    run(db, 'DELETE FROM sessions WHERE token = ?', token).catch(() => {});
    return null;
  }

  const u = await one(db, 'SELECT * FROM users WHERE username = ?', s.username);
  if (!u || !isTrue_(u.active)) return null;

  return u;
}

export function whoami_(user) {
  return ok_({ username: user.username, displayName: user.display_name });
}

export async function changePassword_(db, env, user, token, b) {
  const currentPassword = String(b.currentPassword || '');
  const newPassword = String(b.newPassword || '');

  const computedCurrent = hashPassword(currentPassword, user.salt, env.PEPPER);
  if (!timingSafeEqual(computedCurrent, user.password_hash)) {
    return err_('BAD_PASSWORD', 'كلمة المرور الحالية غير صحيحة');
  }

  if (newPassword.length < 8) {
    return err_('BAD_REQUEST', 'كلمة المرور الجديدة يجب ألا تقل عن 8 أحرف');
  }

  if (newPassword === user.username) {
    return err_('BAD_REQUEST', 'لا يمكن استخدام اسم المستخدم ككلمة مرور');
  }

  if (newPassword === currentPassword) {
    return err_('BAD_REQUEST', 'كلمة المرور الجديدة مطابقة لكلمة المرور الحالية');
  }

  const newSalt = randomHex(16);
  const newHash = hashPassword(newPassword, newSalt, env.PEPPER);

  const stmts = [
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?')
      .bind(newHash, newSalt, user.username),
    db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?')
      .bind(user.username, token),
  ];
  await batch(db, stmts);

  return ok_({ changed: true });
}
