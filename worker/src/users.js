// أوقاف 15 مايو — إدارة المستخدمين والصلاحيات (للمدير فقط)

import { all, one, run, batch } from './db.js';
import { hashPasswordPbkdf2, PBKDF2_ITERATIONS, randomHex } from './crypto.js';
import { passwordPolicyError_ } from './auth.js';
import { ok_, err_, isTrue_, nowIso_ } from './util.js';

export const ROLES = ['admin', 'coordinator', 'viewer'];

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function publicUser_(u) {
  return {
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    active: isTrue_(u.active),
    createdAt: u.created_at,
  };
}

export async function listUsers_(db) {
  const rows = await all(db, 'SELECT username, display_name, role, active, created_at FROM users ORDER BY created_at ASC');
  return ok_({ users: rows.map(publicUser_) });
}

export async function createUser_(db, env, b) {
  const username = String(b.username || '').trim();
  const displayName = String(b.displayName || '').trim();
  const password = String(b.password || '');
  const role = String(b.role || '');

  if (!USERNAME_RE.test(username)) {
    return err_('BAD_REQUEST', 'اسم المستخدم لازم يكون من 3 لـ 32 حرف إنجليزي أو رقم أو (_ . -)');
  }
  if (!displayName) return err_('BAD_REQUEST', 'الاسم الظاهر مطلوب');
  if (ROLES.indexOf(role) < 0) return err_('BAD_REQUEST', 'الصلاحية غير صحيحة');

  const policyError = passwordPolicyError_(username, password);
  if (policyError) return err_('BAD_REQUEST', policyError);

  // مقارنة من غير حساسية لحالة الحروف عشان Ahmed و ahmed ميبقوش حسابين
  const clash = await one(db, 'SELECT username FROM users WHERE lower(username) = lower(?)', username);
  if (clash) return err_('DUPLICATE', 'اسم المستخدم ده موجود');

  const salt = randomHex(16);
  const hash = await hashPasswordPbkdf2(password, salt, PBKDF2_ITERATIONS, env.PEPPER);
  await run(db,
    'INSERT INTO users (username, display_name, password_hash, salt, active, created_at, role) VALUES (?, ?, ?, ?, 1, ?, ?)',
    username, displayName, hash, salt, nowIso_(), role
  );
  return ok_({ username });
}

export async function updateUser_(db, actor, b) {
  const username = String(b.username || '').trim();
  const displayName = String(b.displayName || '').trim();
  const role = String(b.role || '');
  const active = !(b.active === false || b.active === 0 || b.active === 'FALSE');

  const target = await one(db, 'SELECT * FROM users WHERE username = ?', username);
  if (!target) return err_('NOT_FOUND', 'المستخدم غير موجود');
  if (!displayName) return err_('BAD_REQUEST', 'الاسم الظاهر مطلوب');
  if (ROLES.indexOf(role) < 0) return err_('BAD_REQUEST', 'الصلاحية غير صحيحة');

  if (target.username === actor.username && (role !== target.role || !active)) {
    return err_('BAD_REQUEST', 'مينفعش تغيّر صلاحيتك أو تعطّل حسابك بنفسك');
  }

  const losesAdmin = target.role === 'admin' && isTrue_(target.active) && (role !== 'admin' || !active);
  if (losesAdmin) {
    const others = await one(db,
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1 AND username != ?", username);
    if (!others || !others.n) {
      return err_('BAD_REQUEST', 'لازم يفضل مدير نظام واحد نشط على الأقل');
    }
  }

  const stmts = [
    db.prepare('UPDATE users SET display_name = ?, role = ?, active = ? WHERE username = ?')
      .bind(displayName, role, active ? 1 : 0, username),
  ];
  if (!active) {
    // الحساب المعطّل يخرج فوراً من كل الأجهزة
    stmts.push(db.prepare('DELETE FROM sessions WHERE username = ?').bind(username));
  }
  await batch(db, stmts);

  return ok_({ username });
}

export async function resetUserPassword_(db, env, actor, b) {
  const username = String(b.username || '').trim();
  const newPassword = String(b.newPassword || '');

  if (username === actor.username) {
    return err_('BAD_REQUEST', 'لتغيير كلمة المرور بتاعتك استخدم صفحة كلمة المرور');
  }
  const target = await one(db, 'SELECT username FROM users WHERE username = ?', username);
  if (!target) return err_('NOT_FOUND', 'المستخدم غير موجود');

  const policyError = passwordPolicyError_(username, newPassword);
  if (policyError) return err_('BAD_REQUEST', policyError);

  const salt = randomHex(16);
  const hash = await hashPasswordPbkdf2(newPassword, salt, PBKDF2_ITERATIONS, env.PEPPER);
  await batch(db, [
    db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE username = ?').bind(hash, salt, username),
    db.prepare('DELETE FROM sessions WHERE username = ?').bind(username),
    // لو كان مقفول بسبب محاولات غلط، التعيين الجديد بيفك القفل
    db.prepare('DELETE FROM login_attempts WHERE key = ?').bind('u:' + username.toLowerCase()),
  ]);
  return ok_({ reset: true });
}
