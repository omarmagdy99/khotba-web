// أوقاف 15 مايو — المصادقة وإدارة الجلسات

import { one, run, batch, all } from './db.js';
import { verifyPassword, hashPasswordPbkdf2, PBKDF2_ITERATIONS, randomHex } from './crypto.js';
import { ok_, err_, isTrue_, nowIso_ } from './util.js';

const SESSION_DAYS = 7;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_FAILURES = 5;

export async function login_(db, env, b, requestOrIp) {
  let ip = '127.0.0.1';
  if (typeof requestOrIp === 'string' && requestOrIp) {
    ip = requestOrIp.trim();
  } else if (requestOrIp && typeof requestOrIp === 'object' && requestOrIp.headers) {
    ip = requestOrIp.headers.get('cf-connecting-ip') ||
         requestOrIp.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         '127.0.0.1';
  }

  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const uKey = username ? ('u:' + username.toLowerCase()) : null;
  const ipKey = 'ip:' + ip;

  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();

  // 1. فحص حد المحاولات قبل التحقق من كلمة المرور
  const keysToCheck = [ipKey];
  if (uKey) keysToCheck.push(uKey);
  const placeholders = keysToCheck.map(() => '?').join(',');
  const attempts = await all(db,
    `SELECT key, count, window_start FROM login_attempts WHERE key IN (${placeholders}) AND window_start >= ?`,
    ...keysToCheck, cutoffIso
  );

  for (const att of attempts) {
    if (att.count >= RATE_LIMIT_MAX_FAILURES) {
      return err_('RATE_LIMITED', 'محاولات كتير غلط، استنى ربع ساعة وحاول تاني');
    }
  }

  const bad = err_('UNAUTHENTICATED', 'اسم المستخدم أو كلمة المرور غير صحيحة');
  if (!username || !password) {
    await recordLoginFailure_(db, ipKey, uKey, cutoffIso);
    return bad;
  }

  const u = await one(db, 'SELECT * FROM users WHERE username = ?', username);
  if (!u || !isTrue_(u.active)) {
    await recordLoginFailure_(db, ipKey, uKey, cutoffIso);
    return bad;
  }

  const { valid, needsUpgrade } = await verifyPassword(password, u.salt, u.password_hash, env.PEPPER);
  if (!valid) {
    await recordLoginFailure_(db, ipKey, uKey, cutoffIso);
    return bad;
  }

  // تسجيل دخول ناجح: مسح مفتاح اسم المستخدم
  if (uKey) {
    await run(db, 'DELETE FROM login_attempts WHERE key = ?', uKey);
  }

  // ترقية تلقائية للهاش إذا كان من النوع القديم
  if (needsUpgrade) {
    const upgradedHash = await hashPasswordPbkdf2(password, u.salt, PBKDF2_ITERATIONS, env.PEPPER);
    await run(db, 'UPDATE users SET password_hash = ? WHERE username = ?', upgradedHash, u.username);
  }

  const token = randomHex(32); // 64 hex characters
  const expires = new Date(nowMs + SESSION_DAYS * 864e5).toISOString();

  await run(db, 'INSERT INTO sessions (token, username, expires_at) VALUES (?, ?, ?)', token, u.username, expires);

  return ok_({ token, displayName: u.display_name, expiresAt: expires });
}

async function recordLoginFailure_(db, ipKey, uKey, cutoffIso) {
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

  if (uKey) {
    stmts.push(
      db.prepare(`
        INSERT INTO login_attempts (key, count, window_start)
        VALUES (?, 1, ?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
          window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END
      `).bind(uKey, nowIso, cutoffIso, cutoffIso)
    );
  }

  await batch(db, stmts);
}

export async function logout_(db, b) {
  if (b.token) {
    await run(db, 'DELETE FROM sessions WHERE token = ?', b.token);
  }
  return ok_({});
}

export async function auth_(db, token) {
  if (!token) return null;

  const row = await one(db, `
    SELECT u.username, u.display_name, u.password_hash, u.salt, u.active, u.created_at, s.expires_at
    FROM sessions s
    JOIN users u ON u.username = s.username
    WHERE s.token = ?
  `, token);
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    // حذف الجلسة المنتهية بشكل غير متزامن
    run(db, 'DELETE FROM sessions WHERE token = ?', token).catch(() => {});
    return null;
  }

  if (!isTrue_(row.active)) return null;

  return {
    username: row.username,
    display_name: row.display_name,
    password_hash: row.password_hash,
    salt: row.salt,
    active: row.active,
    created_at: row.created_at,
  };
}

export function whoami_(user) {
  return ok_({ username: user.username, displayName: user.display_name });
}

export async function changePassword_(db, env, user, token, b) {
  const currentPassword = String(b.currentPassword || '');
  const newPassword = String(b.newPassword || '');

  const { valid } = await verifyPassword(currentPassword, user.salt, user.password_hash, env.PEPPER);
  if (!valid) {
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
  const newHash = await hashPasswordPbkdf2(newPassword, newSalt, PBKDF2_ITERATIONS, env.PEPPER);

  const stmts = [
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?')
      .bind(newHash, newSalt, user.username),
    db.prepare('DELETE FROM sessions WHERE username = ? AND token != ?')
      .bind(user.username, token),
  ];
  await batch(db, stmts);

  return ok_({ changed: true });
}
