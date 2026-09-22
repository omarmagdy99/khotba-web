/**
 * توليد ملف seed.sql للبيانات الابتدائية من context/ و Permanent.gs
 * للاستخدام في تهيئة قاعدة D1 محلياً أو سحابياً.
 */

const fs = require('fs');
const path = require('path');

function escapeSql(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

// 24 زوج دائم مستخرج من Permanent.gs
const PERMANENT_PAIRS = [
  ['M001', 'K072'],
  ['M003', 'K015'],
  ['M005', 'K104'],
  ['M006', 'K079'],
  ['M014', 'K043'],
  ['M016', 'K034'],
  ['M020', 'K041'],
  ['M021', 'K033'],
  ['M023', 'K005'],
  ['M030', 'K073'],
  ['M033', 'K093'],
  ['M035', 'K018'],
  ['M037', 'K076'],
  ['M038', 'K055'],
  ['M041', 'K027'],
  ['M049', 'K010'],
  ['M053', 'K087'],
  ['M056', 'K089'],
  ['M060', 'K045'],
  ['M061', 'K085'],
  ['M075', 'K097'],
  ['M076', 'K017'],
  ['M079', 'K049'],
  ['M080', 'K053'],
];

function main() {
  const root = path.join(__dirname, '..');
  const now = new Date().toISOString();

  const permByMosque = {};
  const isPrimary = {};
  for (const [m, k] of PERMANENT_PAIRS) {
    permByMosque[m] = k;
    isPrimary[k] = true;
  }

  const sql = [];
  sql.push('-- Seed Data for Awqaf 15 May (Cloudflare D1)');
  sql.push('PRAGMA foreign_keys = OFF;');

  // 1. Settings
  sql.push('\n-- 1. settings');
  sql.push("INSERT OR REPLACE INTO settings (key, value) VALUES ('publish_from', '');");
  sql.push("INSERT OR REPLACE INTO settings (key, value) VALUES ('publish_to', '');");
  sql.push("INSERT OR REPLACE INTO settings (key, value) VALUES ('next_mosque_seq', '86');");
  sql.push("INSERT OR REPLACE INTO settings (key, value) VALUES ('next_khatib_seq', '132');");

  // 2. Khatibs
  sql.push('\n-- 2. khatibs');
  const khatibsCsv = fs.readFileSync(path.join(root, 'context', 'khatibs.csv'), 'utf8');
  const khatibLines = khatibsCsv.trim().split('\n').slice(1);
  for (const line of khatibLines) {
    const parts = line.split(',');
    const id = parts[0].trim();
    const name = parts.slice(1).join(',').trim();
    const type = isPrimary[id] ? 'primary' : 'volunteer';
    sql.push(`INSERT OR REPLACE INTO khatibs (id, name, phone, type, notes, active, created_at) VALUES (${escapeSql(id)}, ${escapeSql(name)}, NULL, '${type}', '', 1, '${now}');`);
  }

  // 3. Mosques
  sql.push('\n-- 3. mosques');
  const mosquesCsv = fs.readFileSync(path.join(root, 'context', 'mosques.csv'), 'utf8');
  const mosqueLines = mosquesCsv.trim().split('\n').slice(1);
  for (const line of mosqueLines) {
    const parts = line.split(',');
    const id = parts[0].trim();
    const name = parts[1].trim();
    const mujawra = parts[2].trim();
    const pk = permByMosque[id] ? escapeSql(permByMosque[id]) : 'NULL';
    sql.push(`INSERT OR REPLACE INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at) VALUES (${escapeSql(id)}, ${escapeSql(name)}, ${escapeSql(mujawra)}, '', ${pk}, 1, '${now}');`);
  }

  // 4. Preferences
  sql.push('\n-- 4. preferences');
  const prefsCsv = fs.readFileSync(path.join(root, 'context', 'preferences.csv'), 'utf8');
  const prefLines = prefsCsv.trim().split('\n').slice(1);
  for (const line of prefLines) {
    const parts = line.split(',');
    const kid = parts[0].trim();
    const mid = parts[1].trim();
    if (kid && mid) {
      sql.push(`INSERT OR REPLACE INTO preferences (khatib_id, mosque_id) VALUES (${escapeSql(kid)}, ${escapeSql(mid)});`);
    }
  }

  // 5. Admin user
  const crypto = require('crypto');
  const PBKDF2_ITERATIONS = 10000;
  let adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword) {
    adminPassword = crypto.randomBytes(8).toString('hex');
    process.stderr.write(`Generated random admin password: ${adminPassword}\n`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedHex = crypto.pbkdf2Sync(adminPassword, salt, PBKDF2_ITERATIONS, 32, 'sha256').toString('hex');
  const passHash = `pbkdf2$${PBKDF2_ITERATIONS}$${derivedHex}`;
  sql.push('\n-- 5. admin user');
  sql.push(`INSERT OR REPLACE INTO users (username, display_name, password_hash, salt, active, created_at) VALUES ('admin', 'المشرف', '${passHash}', '${salt}', 1, '${now}');`);

  sql.push('PRAGMA foreign_keys = ON;');

  const outDir = path.join(root, 'worker');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'seed.sql'), sql.join('\n'), 'utf8');
  console.log('worker/seed.sql generated successfully.');
}

main();
