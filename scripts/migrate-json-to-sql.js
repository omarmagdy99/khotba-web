/**
 * تحويل تصدير Google Sheet (ملف JSON) إلى جمل SQL لقاعدة بيانات Cloudflare D1.
 *
 * الاستخدام:
 *   node scripts/migrate-json-to-sql.js [input.json] [output.sql]
 */

const fs = require('fs');
const path = require('path');

function normPhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-()]/g, '');
  if (!p) return null;
  // إذا كان الشيت أكل الصفر البادئ (10 أرقام تبدأ بـ 1)
  if (/^1\d{9}$/.test(p)) {
    p = '0' + p;
  }
  if (/^01\d{9}$/.test(p)) {
    return p;
  }
  return null;
}

function escapeSql(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return val;
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function isTrue(v) {
  return String(v).toUpperCase() === 'TRUE' || v === true || v === 1 || v === '1' ? 1 : 0;
}

function main() {
  const inputFile = process.argv[2] || 'snapshot.json';
  const outputFile = process.argv[3] || 'migration.sql';

  if (!fs.existsSync(inputFile)) {
    console.error('الملف غير موجود: ' + inputFile);
    process.exit(1);
  }

  const raw = fs.readFileSync(inputFile, 'utf8');
  const dump = JSON.parse(raw);
  const data = dump.data || dump;

  const sql = [];
  sql.push('-- ترحيل بيانات خطباء ويب إلى Cloudflare D1');
  sql.push('-- تم التوليد آلياً في: ' + new Date().toISOString());
  sql.push('PRAGMA foreign_keys = OFF;');

  // 1. settings
  if (data.settings && data.settings.length) {
    sql.push('\n-- الإعدادات');
    for (const s of data.settings) {
      if (!s.key) continue;
      sql.push(`INSERT OR REPLACE INTO settings (key, value) VALUES (${escapeSql(s.key)}, ${escapeSql(s.value || '')});`);
    }
  }

  // 2. khatibs
  if (data.khatibs && data.khatibs.length) {
    sql.push('\n-- الخطباء');
    for (const k of data.khatibs) {
      if (!k.id || !k.name) continue;
      const phone = normPhone(k.phone);
      const type = k.type === 'volunteer' ? 'volunteer' : 'primary';
      const active = isTrue(k.active);
      const createdAt = k.created_at || new Date().toISOString();
      sql.push(`INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at) VALUES (${escapeSql(k.id)}, ${escapeSql(k.name)}, ${escapeSql(phone)}, ${escapeSql(type)}, ${escapeSql(k.notes || '')}, ${active}, ${escapeSql(createdAt)});`);
    }
  }

  // 3. mosques
  if (data.mosques && data.mosques.length) {
    sql.push('\n-- المساجد');
    for (const m of data.mosques) {
      if (!m.id || !m.name) continue;
      const pk = m.permanent_khatib_id ? m.permanent_khatib_id : null;
      const active = isTrue(m.active);
      const createdAt = m.created_at || new Date().toISOString();
      sql.push(`INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at) VALUES (${escapeSql(m.id)}, ${escapeSql(m.name)}, ${escapeSql(m.mujawra)}, ${escapeSql(m.address || '')}, ${escapeSql(pk)}, ${active}, ${escapeSql(createdAt)});`);
    }
  }

  // 4. preferences
  if (data.preferences && data.preferences.length) {
    sql.push('\n-- التفضيلات');
    const seen = new Set();
    for (const p of data.preferences) {
      if (!p.khatib_id || !p.mosque_id) continue;
      const key = `${p.khatib_id}_${p.mosque_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sql.push(`INSERT OR REPLACE INTO preferences (khatib_id, mosque_id) VALUES (${escapeSql(p.khatib_id)}, ${escapeSql(p.mosque_id)});`);
    }
  }

  // 5. assignments
  if (data.assignments && data.assignments.length) {
    sql.push('\n-- التكليفات والجمعات');
    for (const a of data.assignments) {
      if (!a.date || !a.mosque_id) continue;
      const id = a.id || `${a.date}_${a.mosque_id}`;
      const kid = a.khatib_id ? a.khatib_id : null;
      const status = a.status || (kid ? 'confirmed' : 'unassigned');
      const dateType = a.date_type === 'special' ? 'special' : 'friday';
      const label = a.label || '';
      const updatedBy = a.updated_by || 'migration';
      const updatedAt = a.updated_at || new Date().toISOString();
      sql.push(`INSERT OR REPLACE INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at) VALUES (${escapeSql(id)}, ${escapeSql(a.date)}, ${escapeSql(a.mosque_id)}, ${escapeSql(kid)}, ${escapeSql(status)}, ${escapeSql(dateType)}, ${escapeSql(label)}, ${escapeSql(updatedBy)}, ${escapeSql(updatedAt)});`);
    }
  }

  // 6. users
  if (data.users && data.users.length) {
    sql.push('\n-- المستخدمون');
    for (const u of data.users) {
      if (!u.username || !u.password_hash) continue;
      const active = isTrue(u.active);
      const createdAt = u.created_at || new Date().toISOString();
      sql.push(`INSERT OR REPLACE INTO users (username, display_name, password_hash, salt, active, created_at) VALUES (${escapeSql(u.username)}, ${escapeSql(u.display_name || u.username)}, ${escapeSql(u.password_hash)}, ${escapeSql(u.salt)}, ${active}, ${escapeSql(createdAt)});`);
    }
  }

  // 7. sessions (ترحيل الجلسات النشطة لعدم طرد المستخدمين)
  if (data.sessions && data.sessions.length) {
    sql.push('\n-- الجلسات النشطة');
    const now = new Date();
    for (const s of data.sessions) {
      if (!s.token || !s.username) continue;
      if (s.expires_at && new Date(s.expires_at) < now) continue; // تخطي المنتهية
      sql.push(`INSERT OR REPLACE INTO sessions (token, username, expires_at) VALUES (${escapeSql(s.token)}, ${escapeSql(s.username)}, ${escapeSql(s.expires_at)});`);
    }
  }

  sql.push('PRAGMA foreign_keys = ON;');

  fs.writeFileSync(outputFile, sql.join('\n'), 'utf8');
  console.log(`تم توليد ملف SQL بنجاح في: ${outputFile}`);
}

main();
