// أوقاف 15 مايو — إدارة الإعدادات والعدادات

import { all, run, one } from './db.js';
import { ok_ } from './util.js';

export async function settingsMap_(db) {
  const rows = await all(db, 'SELECT key, value FROM settings');
  const m = {};
  for (const r of rows) {
    m[r.key] = r.value;
  }
  return m;
}

export async function getSettings_(db) {
  const map = await settingsMap_(db);
  return ok_({ settings: map });
}

export async function setSetting_(db, key, value) {
  await run(db, 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, String(value));
}

export async function nextId_(db, seqKey, prefix) {
  const row = await one(db,
    "INSERT INTO settings(key, value) VALUES(?, '2') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1 RETURNING value",
    seqKey
  );
  const n = parseInt(row.value, 10) - 1;
  return prefix + String(n).padStart(3, '0');
}
