import { one, all, run, batch } from './db.js';
import { randomHex, hashPasswordPbkdf2, verifyPassword, PBKDF2_ITERATIONS } from './crypto.js';
import { ok_, err_, normPhone, isValidPhone, nowIso_ } from './util.js';
import { currentSermonDate_ } from './khatib-portal.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const badPhone = () => err_('NOT_FOUND', 'رقم الهاتف غير مرتبط بمسجد نشط');
const unauthenticated = () => err_('UNAUTHENTICATED', 'الجلسة غير صالحة');
const badCode = () => err_('BAD_CODE', 'الرمز غير صحيح أو انتهت صلاحيته');
const phoneOf = b => normPhone(b.phone);

function ipOf(request) {
  return request?.headers?.get('cf-connecting-ip') ||
    request?.headers?.get('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
}

async function limited(db, kind, phone, request) {
  const cutoff = new Date(Date.now() - WINDOW_MS).toISOString();
  const keys = [`mp:${kind}:ip:${ipOf(request)}`];
  if (phone) keys.push(`mp:${kind}:phone:${phone}`);
  const rows = await all(db, `SELECT count FROM login_attempts WHERE key IN (${keys.map(() => '?').join(',')}) AND window_start >= ?`, ...keys, cutoff);
  return { keys, cutoff, blocked: rows.some(row => row.count >= MAX_FAILURES) };
}

async function failure(db, limit) {
  await batch(db, limit.keys.map(key => db.prepare(`
    INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN window_start < ? THEN excluded.window_start ELSE window_start END
  `).bind(key, nowIso_(), limit.cutoff, limit.cutoff)));
}

async function clearPhoneLimit(db, limit) {
  if (limit.keys[1]) await run(db, 'DELETE FROM login_attempts WHERE key = ?', limit.keys[1]);
}

const rateError = () => err_('RATE_LIMITED', 'محاولات كثيرة؛ حاول بعد 15 دقيقة');
const validPassword = b => typeof b.password === 'string' && b.password.length >= 8;

async function mosquesFor(db, phone) {
  return await all(db, 'SELECT id, name, mujawra, address, sort_order FROM mosques WHERE active = 1 AND manager_phone = ? ORDER BY sort_order IS NULL, sort_order, id', phone);
}

async function eligible(db, phone) {
  return !!(phone && isValidPhone(phone) && await one(db, 'SELECT id FROM mosques WHERE active = 1 AND manager_phone = ? LIMIT 1', phone));
}

async function session(db, phone) {
  const token = randomHex(32);
  await run(db, 'INSERT INTO mosque_sessions (token, phone, expires_at) VALUES (?, ?, ?)', token, phone, new Date(Date.now() + 30 * 864e5).toISOString());
  const mosques = (await mosquesFor(db, phone)).map(m => ({ id: m.id, name: m.name, mujawra: m.mujawra }));
  return ok_({ token, phone, mosques });
}

async function auth(db, token) {
  if (!token) return null;
  const row = await one(db, `SELECT s.phone FROM mosque_sessions s JOIN mosque_accounts a ON a.phone = s.phone
    WHERE s.token = ? AND s.expires_at > ? AND a.password_hash IS NOT NULL
    AND EXISTS (SELECT 1 FROM mosques m WHERE m.active = 1 AND m.manager_phone = s.phone)`, token, nowIso_());
  return row?.phone || null;
}

export async function mosquePhoneCheck_(db, b, request) {
  const phone = phoneOf(b);
  const limit = await limited(db, 'check', phone, request);
  if (limit.blocked) return rateError();
  if (!await eligible(db, phone)) { await failure(db, limit); return badPhone(); }
  const account = await one(db, 'SELECT password_hash, telegram_chat_id FROM mosque_accounts WHERE phone = ?', phone);
  return ok_({ status: account?.password_hash ? 'has_password' : 'needs_setup', telegramLinked: !!account?.telegram_chat_id });
}

export async function mosqueSetPassword_(db, env, b) {
  const phone = phoneOf(b);
  if (!await eligible(db, phone)) return badPhone();
  if (!validPassword(b)) return err_('BAD_REQUEST', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  const salt = randomHex(16);
  const hash = await hashPasswordPbkdf2(b.password, salt, PBKDF2_ITERATIONS, env.PEPPER);
  const now = nowIso_();
  const result = await run(db, `INSERT INTO mosque_accounts (phone, password_hash, salt, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(phone) DO UPDATE SET password_hash = excluded.password_hash, salt = excluded.salt, updated_at = excluded.updated_at
    WHERE mosque_accounts.password_hash IS NULL`, phone, hash, salt, now, now);
  if (!result.meta?.changes) return err_('ALREADY_SET', 'كلمة المرور محددة بالفعل');
  return await session(db, phone);
}

export async function mosqueLogin_(db, env, b, request) {
  const phone = phoneOf(b);
  const limit = await limited(db, 'login', phone, request);
  if (limit.blocked) return rateError();
  if (!await eligible(db, phone)) { await failure(db, limit); return badPhone(); }
  const account = await one(db, 'SELECT password_hash, salt FROM mosque_accounts WHERE phone = ?', phone);
  const valid = account?.password_hash && (await verifyPassword(String(b.password || ''), account.salt, account.password_hash, env.PEPPER)).valid;
  if (!valid) { await failure(db, limit); return err_('BAD_CREDENTIALS', 'رقم الهاتف أو كلمة المرور غير صحيحة'); }
  await clearPhoneLimit(db, limit);
  return await session(db, phone);
}

export async function mosqueWhoami_(db, b) {
  const phone = await auth(db, b.token);
  if (!phone) return unauthenticated();
  return ok_({ phone, mosques: (await mosquesFor(db, phone)).map(m => ({ id: m.id, name: m.name, mujawra: m.mujawra })) });
}

export async function mosqueLogout_(db, b) {
  if (b.token) await run(db, 'DELETE FROM mosque_sessions WHERE token = ?', b.token);
  return ok_({});
}

export async function mosqueGetSchedule_(db, b) {
  const phone = await auth(db, b.token);
  if (!phone) return unauthenticated();
  const date = currentSermonDate_();
  const rows = await all(db, `SELECT m.id AS mosque_id, m.name, m.mujawra, m.address, m.sort_order,
    a.status, k.name AS khatib_name, k.phone AS khatib_phone
    FROM mosques m LEFT JOIN assignments a ON a.mosque_id = m.id AND a.date = ?
    LEFT JOIN khatibs k ON k.id = a.khatib_id
    WHERE m.active = 1 AND m.manager_phone = ?
    ORDER BY m.sort_order IS NULL, m.sort_order, m.id`, date, phone);
  return ok_({ date, mosques: rows.map(r => ({
    mosqueId: r.mosque_id, name: r.name, mujawra: r.mujawra, address: r.address,
    sortOrder: r.sort_order, khatib: r.khatib_name ? { name: r.khatib_name, phone: r.khatib_phone } : null,
    status: r.status || null
  })) });
}

async function telegramSend(env, chatId, text) {
  const base = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
  const response = await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  if (!response.ok) throw new Error('Telegram sendMessage failed');
  const data = await response.json();
  if (!data.ok) throw new Error('Telegram sendMessage failed');
}

export async function mosqueRequestReset_(db, env, b, request) {
  const phone = phoneOf(b);
  const limit = await limited(db, 'reset-request', phone, request);
  if (limit.blocked) return rateError();
  if (!await eligible(db, phone)) { await failure(db, limit); return badPhone(); }
  if (!env.TELEGRAM_BOT_TOKEN) return err_('TELEGRAM_UNAVAILABLE', 'البوت غير متاح حالياً');
  const account = await one(db, 'SELECT telegram_chat_id FROM mosque_accounts WHERE phone = ?', phone);
  if (!account?.telegram_chat_id) return err_('TELEGRAM_NOT_LINKED', 'اربط رقمك بالبوت أولاً', { botUsername: env.TELEGRAM_BOT_USERNAME || '' });
  const digits = new Uint32Array(1);
  crypto.getRandomValues(digits);
  const code = String(digits[0] % 1000000).padStart(6, '0');
  const salt = randomHex(16);
  const hash = await hashPasswordPbkdf2(code, salt, PBKDF2_ITERATIONS, env.PEPPER);
  await telegramSend(env, account.telegram_chat_id, `رمز إعادة تعيين كلمة المرور: ${code} (صالح لمدة 10 دقائق)`);
  await run(db, `INSERT INTO mosque_reset_codes (phone, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
    phone, `${salt}$${hash}`, new Date(Date.now() + 10 * 60 * 1000).toISOString());
  await failure(db, limit);
  return ok_({ sent: true });
}

export async function mosqueConfirmReset_(db, env, b, request) {
  const phone = phoneOf(b);
  const limit = await limited(db, 'reset-confirm', phone, request);
  if (limit.blocked) return rateError();
  if (!await eligible(db, phone)) { await failure(db, limit); return badPhone(); }
  if (!validPassword(b)) return err_('BAD_REQUEST', 'كلمة المرور يجب أن تكون 8 أحرف على الأقل');
  const row = await one(db, 'SELECT code_hash, expires_at, attempts FROM mosque_reset_codes WHERE phone = ?', phone);
  const [salt, hash] = row?.code_hash?.split('$', 2) || [];
  const storedHash = row ? row.code_hash.slice(salt.length + 1) : '';
  const valid = row && row.expires_at > nowIso_() && row.attempts < 5 &&
    /^\d{6}$/.test(String(b.code || '')) &&
    (await verifyPassword(String(b.code), salt, storedHash, env.PEPPER)).valid;
  if (!valid) {
    if (row) await run(db, 'UPDATE mosque_reset_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
    await failure(db, limit);
    return badCode();
  }
  const newSalt = randomHex(16);
  const newHash = await hashPasswordPbkdf2(b.password, newSalt, PBKDF2_ITERATIONS, env.PEPPER);
  const now = nowIso_();
  await batch(db, [
    db.prepare('UPDATE mosque_accounts SET password_hash = ?, salt = ?, updated_at = ? WHERE phone = ?').bind(newHash, newSalt, now, phone),
    db.prepare('DELETE FROM mosque_sessions WHERE phone = ?').bind(phone),
    db.prepare('DELETE FROM mosque_reset_codes WHERE phone = ?').bind(phone)
  ]);
  await clearPhoneLimit(db, limit);
  return await session(db, phone);
}

export async function resetMosquePassword_(db, b) {
  const phone = phoneOf(b);
  if (!await eligible(db, phone)) return badPhone();
  await batch(db, [
    db.prepare('UPDATE mosque_accounts SET password_hash = NULL, salt = NULL, updated_at = ? WHERE phone = ?').bind(nowIso_(), phone),
    db.prepare('DELETE FROM mosque_sessions WHERE phone = ?').bind(phone),
    db.prepare('DELETE FROM mosque_reset_codes WHERE phone = ?').bind(phone)
  ]);
  return ok_({ ok: true });
}

export async function telegramWebhook_(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) return;
  let update;
  try { update = await request.json(); } catch { return; }
  const message = update?.message;
  const contact = message?.contact;
  const chatId = message?.chat?.id;
  if (!chatId || !env.TELEGRAM_BOT_TOKEN) return;
  if (!contact) {
    if (message?.text === '/start') {
      const base = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
      await fetch(`${base}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: 'أرسل رقم هاتفك من الزر لتفعيل استعادة كلمة المرور.',
          reply_markup: { keyboard: [[{ text: 'مشاركة رقم هاتفي', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true } })
      });
    }
    return;
  }
  if (String(contact.user_id) !== String(message.from?.id)) return;
  const phone = normPhone(contact.phone_number);
  if (!isValidPhone(phone)) return;
  let linked = false;
  for (const db of [env.DB, env.DB_TEBEEN]) {
    if (db && await eligible(db, phone)) {
      const now = nowIso_();
      await run(db, `INSERT INTO mosque_accounts (phone, telegram_chat_id, created_at, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET telegram_chat_id = excluded.telegram_chat_id, updated_at = excluded.updated_at`,
        phone, String(chatId), now, now);
      linked = true;
    }
  }
  await telegramSend(env, chatId, linked ? 'تم ربط رقم هاتفك بحساب مدير المسجد بنجاح.' : 'رقم الهاتف غير مسجل لمدير مسجد نشط.');
}
