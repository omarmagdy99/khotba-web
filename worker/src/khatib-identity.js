import { all, one, run } from './db.js';
import { khatibAuth_ } from './khatib-portal.js';
import { randomHex, sha256Hex } from './crypto.js';
import { err_, ok_, isIsoDate_, nowIso_ } from './util.js';

const encoder = new TextEncoder();

export function normalizeNationalId(value) {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/[٠-٩۰-۹]/g, digit => String(digit.charCodeAt(0) & 15)).replace(/\s/g, '');
  return /^[0-9]{14}$/.test(digits) ? digits : '';
}

async function identityKey(secret) {
  if (!/^[a-f0-9]{64}$/.test(secret || '')) throw new Error('Invalid khatib identity encryption key');
  const bytes = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptId(key, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const options = { name: 'AES-GCM', iv, additionalData: encoder.encode(context) };
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(options, key, encoder.encode(value)));
  return btoa(String.fromCharCode(...iv, ...encrypted));
}

async function decryptId(key, value, context) {
  const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
  const options = { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(context) };
  const plaintext = await crypto.subtle.decrypt(options, key, bytes.slice(12));
  return new TextDecoder().decode(plaintext);
}

const invalidNumber = () => err_('BAD_REQUEST', 'الرقم القومي لازم يتكوّن من 14 رقمًا');
const invalidCode = () => err_('BAD_REQUEST', 'رمز التسجيل غير صالح أو انتهت صلاحيته. راجع مسؤول التوزيع.');

export async function prepareKhatibNationalId_(db, secret, region, khatibId, nationalId) {
  const encrypted = await encryptId(await identityKey(secret), nationalId, region + ':' + khatibId);
  return db.prepare(`
    INSERT INTO khatib_identity (khatib_id, national_id_ciphertext)
    SELECT id, ? FROM khatibs WHERE id = ?
    ON CONFLICT(khatib_id) DO UPDATE SET national_id_ciphertext = excluded.national_id_ciphertext,
      code_hash = NULL, code_phone = NULL, code_expires_at = NULL
  `).bind(encrypted, khatibId);
}

export async function issueKhatibIdentityCode_(db, khatibId) {
  if (typeof khatibId !== 'string' || !khatibId.trim()) return err_('BAD_REQUEST', 'حدد الخطيب أولًا.');
  const code = randomHex(12);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const result = await run(db, `
    INSERT INTO khatib_identity (khatib_id, code_hash, code_phone, code_expires_at)
    SELECT id, ?, phone, ? FROM khatibs WHERE id = ? AND active = 1 AND phone IS NOT NULL AND phone <> ''
    ON CONFLICT(khatib_id) DO UPDATE SET
      code_hash = excluded.code_hash, code_phone = excluded.code_phone, code_expires_at = excluded.code_expires_at
  `, sha256Hex(code), expiresAt, khatibId);
  if (!result.meta.changes) return err_('BAD_REQUEST', 'إصدار الرمز يتطلب خطيبًا نشطًا برقم هاتف مسجل.');
  return ok_({ code, expiresAt });
}

export async function submitKhatibNationalId_(db, secret, region, b) {
  const khatib = await khatibAuth_(db, b.token);
  if (!khatib) return err_('UNAUTHENTICATED', 'انتهت الجلسة، سجّل الدخول من جديد.');
  const code = typeof b.code === 'string' ? b.code.trim().toLowerCase() : '';
  if (!/^[a-f0-9]{24}$/.test(code)) return invalidCode();
  const nationalId = normalizeNationalId(b.nationalId);
  if (!nationalId) return invalidNumber();
  const hash = sha256Hex(code);
  const criteria = `khatib_id = ? AND code_hash = ? AND code_phone = ? AND code_expires_at > ?
    AND EXISTS (SELECT 1 FROM khatibs WHERE id = khatib_id AND active = 1 AND phone = code_phone)`;
  if (!await one(db, 'SELECT 1 FROM khatib_identity WHERE ' + criteria, khatib.id, hash, khatib.phone, nowIso_())) return invalidCode();
  const encrypted = await encryptId(await identityKey(secret), nationalId, region + ':' + khatib.id);
  const result = await run(db, `
    UPDATE khatib_identity SET national_id_ciphertext = ?, code_hash = NULL, code_phone = NULL, code_expires_at = NULL
    WHERE ${criteria}
  `, encrypted, khatib.id, hash, khatib.phone, nowIso_());
  return result.meta.changes ? ok_({ saved: true }) : invalidCode();
}

export async function saveKhatibNationalId_(db, secret, region, b) {
  if (typeof b.khatibId !== 'string' || !b.khatibId.trim()) return err_('BAD_REQUEST', 'حدد الخطيب أولًا.');
  const nationalId = normalizeNationalId(b.nationalId);
  if (!nationalId) return invalidNumber();
  const statement = await prepareKhatibNationalId_(db, secret, region, b.khatibId, nationalId);
  const result = await statement.run();
  return result.meta.changes ? ok_({ saved: true }) : err_('NOT_FOUND', 'الخطيب غير موجود.');
}

export async function weeklyNationalIds_(db, secret, region, date) {
  if (!isIsoDate_(date)) return err_('BAD_REQUEST', 'تاريخ غير صحيح');
  const rows = await all(db, `
    SELECT DISTINCT i.khatib_id, i.national_id_ciphertext
    FROM assignments a JOIN khatib_identity i ON i.khatib_id = a.khatib_id
    WHERE a.date = ? AND a.status <> 'excused' AND i.national_id_ciphertext IS NOT NULL
  `, date);
  return ok_({ nationalIds: await decryptNationalIds(rows, secret, region) });
}

export async function khatibPrivateDetails_(db, secret, region, khatibId) {
  if (khatibId === undefined) {
    const rows = await all(db, 'SELECT khatib_id, national_id_ciphertext FROM khatib_identity WHERE national_id_ciphertext IS NOT NULL');
    return ok_({ nationalIds: await decryptNationalIds(rows, secret, region) });
  }
  if (typeof khatibId !== 'string' || !khatibId.trim()) return err_('BAD_REQUEST', 'حدد الخطيب أولًا.');
  const row = await one(db, `
    SELECT k.id AS khatib_id, k.occupation, i.national_id_ciphertext
    FROM khatibs k LEFT JOIN khatib_identity i ON i.khatib_id = k.id WHERE k.id = ?
  `, khatibId);
  if (!row) return err_('NOT_FOUND', 'الخطيب غير موجود.');
  const nationalId = row.national_id_ciphertext
    ? (await decryptNationalIds([row], secret, region))[khatibId] : '';
  return ok_({ nationalId, occupation: row.occupation || '' });
}

export async function decryptNationalIds(rows, secret, region) {
  if (!rows.length) return {};
  const key = await identityKey(secret);
  const entries = await Promise.all(rows.map(async row => [
    row.khatib_id, await decryptId(key, row.national_id_ciphertext, region + ':' + row.khatib_id)
  ]));
  return Object.fromEntries(entries);
}
