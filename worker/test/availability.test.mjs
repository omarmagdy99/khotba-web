// Comprehensive Unit & Database Integration Tests for Khatib Availability Foundation
// Node 18+ built-ins only (node:test, node:assert, node:sqlite, node:vm)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import * as workerAvailability from '../src/availability.js';
import {
  publicKhatib_,
  listKhatibs_,
  saveKhatib_,
  deactivateKhatib_,
} from '../src/khatibs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

// Helper to obtain fresh schema (with availability columns)
function getFreshSchema() {
  return fs.readFileSync(path.join(rootDir, 'worker/schema.sql'), 'utf8');
}

// Helper to construct genuine legacy schema (removing availability columns)
function getLegacySchema() {
  const schema = fs.readFileSync(path.join(rootDir, 'worker/schema.sql'), 'utf8');
  return schema.replace(
    /,\r?\n\s*availability_mode\s+TEXT[^\r\n]*,\r?\n\s*availability_weeks\s+TEXT[^\r\n]*/,
    ''
  );
}

// Load browser helper via vm to verify exact browser/window compatibility
function loadBrowserAvailability() {
  const browserCode = fs.readFileSync(path.join(rootDir, 'assets/availability.js'), 'utf8');
  const context = { window: {}, globalThis: {} };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(browserCode, context);
  return context.KhatibAvailability;
}

const browserAvailability = loadBrowserAvailability();

// ════════════════════════════════════════════════════════════════════
// 1. Calendar Date Parsing & Validation
// ════════════════════════════════════════════════════════════════════

test('parseCivilDate - accepts valid calendar dates', () => {
  const d1 = workerAvailability.parseCivilDate('2026-10-23');
  assert.equal(d1.year, 2026);
  assert.equal(d1.month, 10);
  assert.equal(d1.day, 23);
  assert.equal(d1.utcDate.getUTCDay(), 5); // Friday

  const d2 = workerAvailability.parseCivilDate('2024-02-29'); // Leap year
  assert.equal(d2.year, 2024);
  assert.equal(d2.month, 2);
  assert.equal(d2.day, 29);
});

test('parseCivilDate - rejects impossible ISO dates and malformed strings', () => {
  assert.throws(() => workerAvailability.parseCivilDate('2026-02-29'), /تاريخ تقويمي مستحيل/);
  assert.throws(() => workerAvailability.parseCivilDate('2026-02-30'), /تاريخ تقويمي مستحيل/);
  assert.throws(() => workerAvailability.parseCivilDate('2026-04-31'), /تاريخ تقويمي مستحيل/);
  assert.throws(() => workerAvailability.parseCivilDate('2026-13-01'), /قيم التاريخ خارج النطاق/);
  assert.throws(() => workerAvailability.parseCivilDate('2026-00-10'), /قيم التاريخ خارج النطاق/);
  assert.throws(() => workerAvailability.parseCivilDate('2026-10-32'), /قيم التاريخ خارج النطاق/);
  assert.throws(() => workerAvailability.parseCivilDate('invalid-date'), /صيغة التاريخ غير صحيحة/);
  assert.throws(() => workerAvailability.parseCivilDate(null), /تاريخ غير صالح/);
  assert.throws(() => workerAvailability.parseCivilDate(123), /تاريخ غير صالح/);
});

test('assertFriday - validates Fridays and rejects non-Fridays', () => {
  assert.doesNotThrow(() => workerAvailability.assertFriday('2026-10-23'));
  assert.throws(() => workerAvailability.assertFriday('2026-10-22'), /لا يوافق يوم جمعة/);
  assert.throws(() => workerAvailability.assertFriday('2026-10-24'), /لا يوافق يوم جمعة/);
  assert.throws(() => workerAvailability.assertFriday('2026-10-25'), /لا يوافق يوم جمعة/);
});

// ════════════════════════════════════════════════════════════════════
// 2. Calendar Resolution & Hijri Policy
// ════════════════════════════════════════════════════════════════════

test('resolveCalendar - maps regions and calendar names correctly', () => {
  assert.equal(workerAvailability.resolveCalendar('15may'), 'gregory');
  assert.equal(workerAvailability.resolveCalendar('gregory'), 'gregory');
  assert.equal(workerAvailability.resolveCalendar('tebeen'), 'islamic-umalqura');
  assert.equal(workerAvailability.resolveCalendar('islamic-umalqura'), 'islamic-umalqura');

  assert.throws(() => workerAvailability.resolveCalendar('cairo'), /منطقة أو تقويم غير مدعوم/);
  assert.throws(() => workerAvailability.resolveCalendar('islamic-civil'), /منطقة أو تقويم غير مدعوم/);
});

test('getCalendarDateParts - Gregorian and Hijri (islamic-umalqura)', () => {
  assert.equal(workerAvailability.HIJRI_CALENDAR_POLICY, 'islamic-umalqura');

  const gregParts = workerAvailability.getCalendarDateParts('2026-10-23', '15may');
  assert.equal(gregParts.calendar, 'gregory');
  assert.equal(gregParts.year, 2026);
  assert.equal(gregParts.month, 10);
  assert.equal(gregParts.day, 23);
  assert.equal(gregParts.dayOfWeek, 5);

  const hijriParts = workerAvailability.getCalendarDateParts('2026-10-23', 'tebeen');
  assert.equal(hijriParts.calendar, 'islamic-umalqura');
  assert.equal(hijriParts.year, 1448);
  assert.equal(hijriParts.month, 5); // Jumada al-Awwal
  assert.equal(hijriParts.day, 12);
  assert.equal(hijriParts.dayOfWeek, 5);
});

// ════════════════════════════════════════════════════════════════════
// 3. Friday Ordinals (1st to 5th) & Gregorian vs Hijri
// ════════════════════════════════════════════════════════════════════

test('getFridayOrdinal - Gregorian calculation for 15 May', () => {
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-02', '15may'), 1);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-09', '15may'), 2);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-16', '15may'), 3);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-23', '15may'), 4);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-30', '15may'), 5);
});

test('getFridayOrdinal - Hijri calculation for Tebeen & Hijri 5th Friday', () => {
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-02', 'tebeen'), 3);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-09', 'tebeen'), 4);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-16', 'tebeen'), 1);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-23', 'tebeen'), 2);
  assert.equal(workerAvailability.getFridayOrdinal('2026-10-30', 'tebeen'), 3);

  // Hijri 5th Friday: 2026-04-17 corresponds to 1447/10/29 (Shawwal) -> 5th Friday
  assert.equal(workerAvailability.getFridayOrdinal('2026-04-17', 'tebeen'), 5);
  // Meanwhile in Gregorian, 2026-04-17 is the 3rd Friday of April
  assert.equal(workerAvailability.getFridayOrdinal('2026-04-17', '15may'), 3);
});

test('getFridayOrdinal - Month and Year boundaries', () => {
  // Gregorian Year boundary
  assert.equal(workerAvailability.getFridayOrdinal('2027-01-01', '15may'), 1);
  assert.equal(workerAvailability.getFridayOrdinal('2027-01-01', 'tebeen'), 4);

  // Hijri Year boundary (1447 to 1448)
  assert.equal(workerAvailability.getFridayOrdinal('2026-06-12', 'tebeen'), 4);
  assert.equal(workerAvailability.getFridayOrdinal('2026-06-19', 'tebeen'), 1);
});

// ════════════════════════════════════════════════════════════════════
// 4. Parity Test: Browser vs Worker over 52+ real Fridays
// ════════════════════════════════════════════════════════════════════

test('Parity - Browser (KhatibAvailability) and Worker helpers match 100% over a full year', () => {
  assert.ok(browserAvailability, 'KhatibAvailability exists in browser context');

  // Generate 54 consecutive Fridays starting from 2026-01-02
  const fridays = [];
  let d = new Date('2026-01-02T12:00:00Z');
  for (let i = 0; i < 54; i++) {
    fridays.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 7);
  }

  const testRules = [
    { mode: 'all', weeks: [1, 2, 3, 4, 5] },
    { mode: 'custom', weeks: [1] },
    { mode: 'custom', weeks: [1, 3] },
    { mode: 'custom', weeks: [2, 4] },
    { mode: 'custom', weeks: [5] },
  ];

  for (const fri of fridays) {
    for (const region of ['15may', 'tebeen']) {
      // 1. Date parts parity
      const wParts = workerAvailability.getCalendarDateParts(fri, region);
      const bParts = browserAvailability.getCalendarDateParts(fri, region);
      assert.deepEqual({ ...bParts }, { ...wParts }, `Date parts mismatch for ${fri} in ${region}`);

      // 2. Ordinal parity
      const wOrd = workerAvailability.getFridayOrdinal(fri, region);
      const bOrd = browserAvailability.getFridayOrdinal(fri, region);
      assert.equal(bOrd, wOrd, `Ordinal mismatch for ${fri} in ${region}`);

      // 3. Availability matching parity across rules
      for (const rule of testRules) {
        const wAvail = workerAvailability.isKhatibAvailable(rule, fri, region);
        const bAvail = browserAvailability.isKhatibAvailable(rule, fri, region);
        assert.equal(bAvail, wAvail, `Availability mismatch for rule ${JSON.stringify(rule)} on ${fri} in ${region}`);
      }
    }
  }
});

// ════════════════════════════════════════════════════════════════════
// 5. Availability Validation & Edge Cases
// ════════════════════════════════════════════════════════════════════

test('validateAvailability - rejects explicit null and malformed types', () => {
  // Explicit null must be rejected
  const vNull = workerAvailability.validateAvailability(null);
  assert.equal(vNull.valid, false);
  assert.match(vNull.error, /لا يمكن أن تكون فارغة/);

  // Malformed types
  assert.equal(workerAvailability.validateAvailability('all').valid, false);
  assert.equal(workerAvailability.validateAvailability([]).valid, false);
  assert.equal(workerAvailability.validateAvailability(123).valid, false);

  // Invalid mode
  assert.equal(workerAvailability.validateAvailability({ mode: 'weekly' }).valid, false);
});

test('validateAvailability - rejects malformed weeks in "all" mode', () => {
  // Valid omitted or valid weeks array in all mode is allowed
  assert.equal(workerAvailability.validateAvailability({ mode: 'all' }).valid, true);
  assert.equal(workerAvailability.validateAvailability({ mode: 'all', weeks: [1, 2, 3, 4, 5] }).valid, true);

  // Malformed weeks in all mode MUST be rejected
  assert.equal(workerAvailability.validateAvailability({ mode: 'all', weeks: [0] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'all', weeks: [6] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'all', weeks: [1, 1] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'all', weeks: 'not-array' }).valid, false);
});

test('validateAvailability - validates custom weeks strictly', () => {
  assert.equal(workerAvailability.validateAvailability({ mode: 'custom', weeks: [1, 3] }).valid, true);
  assert.equal(workerAvailability.validateAvailability({ mode: 'custom', weeks: [] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'custom', weeks: [1, 1] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'custom', weeks: [0] }).valid, false);
  assert.equal(workerAvailability.validateAvailability({ mode: 'custom', weeks: [6] }).valid, false);
});

// ════════════════════════════════════════════════════════════════════
// 6. Readable Rule Formatting
// ════════════════════════════════════════════════════════════════════

test('formatAvailabilityRule - formats correctly in Arabic', () => {
  assert.equal(workerAvailability.formatAvailabilityRule({ mode: 'all' }), 'كل جمعة');
  assert.equal(workerAvailability.formatAvailabilityRule({ mode: 'custom', weeks: [1] }), 'الجمعة الأولى من كل شهر');
  assert.equal(workerAvailability.formatAvailabilityRule({ mode: 'custom', weeks: [1, 3] }), 'الجمعة الأولى والثالثة من كل شهر');
  assert.equal(workerAvailability.formatAvailabilityRule({ mode: 'custom', weeks: [1, 3] }, { short: true }), 'الأولى والثالثة');
  assert.equal(workerAvailability.formatAvailabilityRule({ mode: 'invalid' }), 'قاعدة تالفة (غير صالحة)');
});

// ════════════════════════════════════════════════════════════════════
// 7. Stored Rule Parsing & Corrupt State Handling
// ════════════════════════════════════════════════════════════════════

test('parseStoredAvailability - surfaces invalid state on corrupt custom data', () => {
  // Legacy omitted rule -> mode 'all'
  const leg = workerAvailability.parseStoredAvailability({ availability_mode: null, availability_weeks: null });
  assert.deepEqual(leg, { mode: 'all', weeks: [1, 2, 3, 4, 5] });

  // Valid custom rule
  const validCust = workerAvailability.parseStoredAvailability({ availability_mode: 'custom', availability_weeks: '[1,3]' });
  assert.deepEqual(validCust, { mode: 'custom', weeks: [1, 3] });

  // Corrupt custom rule with out-of-range week -> mode 'invalid'
  const badCust = workerAvailability.parseStoredAvailability({ availability_mode: 'custom', availability_weeks: '[1,99]' });
  assert.equal(badCust.mode, 'invalid');
  assert.ok(badCust.error);

  // Corrupt custom rule with non-JSON text -> mode 'invalid'
  const badJson = workerAvailability.parseStoredAvailability({ availability_mode: 'custom', availability_weeks: 'corrupted' });
  assert.equal(badJson.mode, 'invalid');

  // Corrupt custom rule with missing weeks -> mode 'invalid'
  const noWeeks = workerAvailability.parseStoredAvailability({ availability_mode: 'custom', availability_weeks: null });
  assert.equal(noWeeks.mode, 'invalid');

  // isKhatibAvailable NEVER treats corrupt custom rule as available!
  assert.equal(workerAvailability.isKhatibAvailable(badCust, '2026-10-02', '15may'), false);
  assert.equal(workerAvailability.isKhatibAvailable(badJson, '2026-10-02', '15may'), false);
  assert.equal(workerAvailability.isKhatibAvailable(noWeeks, '2026-10-02', '15may'), false);
});

// ════════════════════════════════════════════════════════════════════
// 8. Database Fixture & Comprehensive Legacy Preservation Test
// ════════════════════════════════════════════════════════════════════

function makeD1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        _sql: sql,
        _binds: [],
        bind(...args) {
          this._binds = args;
          return this;
        },
        async first(col) {
          const stmt = sqlite.prepare(this._sql);
          const row = stmt.get(...this._binds);
          if (!row) return null;
          return col ? row[col] : row;
        },
        async all() {
          const stmt = sqlite.prepare(this._sql);
          const results = stmt.all(...this._binds);
          return { results };
        },
        async run() {
          const stmt = sqlite.prepare(this._sql);
          const info = stmt.run(...this._binds);
          return { success: true, meta: info };
        },
      };
    },
    async batch(stmts) {
      const results = [];
      for (const s of stmts) {
        const stmt = sqlite.prepare(s._sql);
        const info = stmt.run(...s._binds);
        results.push({ success: true, meta: info });
      }
      return results;
    },
  };
}

const mockUser = { username: 'admin', role: 'admin', region_access: 'both' };

test('LEGACY PRESERVATION: Populating rows BEFORE migration0006 preserves all tables and columns', async () => {
  const sqlite = new DatabaseSync(':memory:');

  // Step 1: Apply genuine legacy baseline schema (without availability_mode/availability_weeks)
  const legacySchema = getLegacySchema();
  sqlite.exec(legacySchema);

  // Step 2: Populate real legacy records in multiple tables BEFORE migration
  sqlite.exec(`
    INSERT INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at, sort_order)
    VALUES ('M1', 'مسجد التوحيد', 'مجاورة 1', 'الشارع الرئيسي', 'K1', 1, '2026-08-01T00:00:00Z', 1);

    INSERT INTO khatibs (id, name, phone, type, notes, active, created_at)
    VALUES ('K1', 'الشيخ عبد الرحمن القديم', '01011111111', 'primary', 'ملاحظة قديمة 1', 1, '2026-08-01T00:00:00Z'),
           ('K2', 'الشيخ سامي المتطوع', '01022222222', 'volunteer', 'ملاحظة قديمة 2', 1, '2026-08-02T00:00:00Z');

    INSERT INTO preferences (khatib_id, mosque_id)
    VALUES ('K1', 'M1'), ('K2', 'M1');

    INSERT INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
    VALUES ('2026-10-23_M1', '2026-10-23', 'M1', 'K1', 'confirmed', 'friday', 'خطبة الجمعة', 'admin', '2026-10-20T10:00:00Z');

    INSERT INTO settings (key, value)
    VALUES ('next_khatib_seq', '42'), ('app_title', 'أوقاف 15 مايو');

    INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
    VALUES ('2026-10-23', 'K2', 'ready', '2026-10-21T12:00:00Z');

    INSERT INTO users (username, display_name, password_hash, salt, active, created_at, role, region_access)
    VALUES ('coord1', 'منسق المنطقة', 'hash123', 'salt123', 1, '2026-08-01T00:00:00Z', 'coordinator', '15may');
  `);

  // Step 3: Capture full table snapshots BEFORE migration
  const preMosques = sqlite.prepare('SELECT * FROM mosques ORDER BY id').all();
  const preKhatibs = sqlite.prepare('SELECT id, name, phone, type, notes, active, created_at FROM khatibs ORDER BY id').all();
  const prePrefs = sqlite.prepare('SELECT * FROM preferences ORDER BY khatib_id, mosque_id').all();
  const preAssignments = sqlite.prepare('SELECT * FROM assignments ORDER BY id').all();
  const preSettings = sqlite.prepare('SELECT * FROM settings ORDER BY key').all();
  const preReadiness = sqlite.prepare('SELECT * FROM khatib_readiness ORDER BY date, khatib_id').all();
  const preUsers = sqlite.prepare('SELECT * FROM users ORDER BY username').all();

  // Step 4: Apply migration 0006 to legacy schema
  const migration0006 = fs.readFileSync(path.join(rootDir, 'worker/migrations/0006_khatib_availability.sql'), 'utf8');
  sqlite.exec(migration0006);

  // Step 5: Verify all untouched tables are bit-for-bit identical
  assert.deepEqual(sqlite.prepare('SELECT * FROM mosques ORDER BY id').all(), preMosques);
  assert.deepEqual(sqlite.prepare('SELECT * FROM preferences ORDER BY khatib_id, mosque_id').all(), prePrefs);
  assert.deepEqual(sqlite.prepare('SELECT * FROM assignments ORDER BY id').all(), preAssignments);
  assert.deepEqual(sqlite.prepare('SELECT * FROM settings ORDER BY key').all(), preSettings);
  assert.deepEqual(sqlite.prepare('SELECT * FROM khatib_readiness ORDER BY date, khatib_id').all(), preReadiness);
  assert.deepEqual(sqlite.prepare('SELECT * FROM users ORDER BY username').all(), preUsers);

  // Step 6: Verify all original columns of khatibs are preserved exactly
  const postKhatibsOldCols = sqlite.prepare('SELECT id, name, phone, type, notes, active, created_at FROM khatibs ORDER BY id').all();
  assert.deepEqual(postKhatibsOldCols, preKhatibs);

  // Step 7: Verify new columns defaulted correctly
  const postKhatibsFull = sqlite.prepare('SELECT * FROM khatibs ORDER BY id').all();
  for (const row of postKhatibsFull) {
    assert.equal(row.availability_mode, 'all', 'availability_mode must default to all on legacy rows');
    assert.equal(row.availability_weeks, null, 'availability_weeks must default to null on legacy rows');
  }

  // Step 8: Verify listKhatibs_ returns legacy rows with availability: { mode: 'all', weeks: [1,2,3,4,5] }
  const d1 = makeD1Adapter(sqlite);
  const listRes = await listKhatibs_(d1, true);
  assert.equal(listRes.ok, true);
  assert.equal(listRes.data.khatibs.length, 2);
  for (const k of listRes.data.khatibs) {
    assert.deepEqual(k.availability, { mode: 'all', weeks: [1, 2, 3, 4, 5] });
    assert.ok(k.name.startsWith('الشيخ '));
  }
});

// ════════════════════════════════════════════════════════════════════
// 9. Fresh Schema Contract & CRUD Verification
// ════════════════════════════════════════════════════════════════════

test('FRESH SCHEMA: schema.sql contains availability columns and operates directly without migration', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getFreshSchema());
  const db = makeD1Adapter(sqlite);

  // Direct insert on fresh schema
  const res = await saveKhatib_(db, mockUser, {
    name: 'الشيخ في المخطط الحديث',
    phone: '01066666666',
    availability: { mode: 'custom', weeks: [1, 4] }
  }, true);
  assert.equal(res.ok, true);

  const listRes = await listKhatibs_(db, true);
  const k = listRes.data.khatibs.find(x => x.id === res.data.id);
  assert.deepEqual(k.availability, { mode: 'custom', weeks: [1, 4] });
});

test('CRUD - Rejects explicit null on create and update on fresh schema', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getFreshSchema());
  const db = makeD1Adapter(sqlite);

  // create with availability: null -> REJECTED
  const res1 = await saveKhatib_(db, mockUser, {
    name: 'الشيخ فارغ',
    availability: null,
  }, true);
  assert.equal(res1.ok, false);
  assert.equal(res1.error.code, 'BAD_REQUEST');

  // create with availability_mode: null -> REJECTED
  const res2 = await saveKhatib_(db, mockUser, {
    name: 'الشيخ فارغ 2',
    availability_mode: null,
  }, true);
  assert.equal(res2.ok, false);
  assert.equal(res2.error.code, 'BAD_REQUEST');

  // Create valid khatib first
  const createValid = await saveKhatib_(db, mockUser, {
    name: 'الشيخ صالح',
    phone: '01077777777',
    availability: { mode: 'custom', weeks: [1, 3] },
  }, true);
  assert.equal(createValid.ok, true);
  const id = createValid.data.id;

  // update with availability: null -> REJECTED
  const updateNull = await saveKhatib_(db, mockUser, {
    id,
    name: 'الشيخ صالح المحدث',
    availability: null,
  }, false);
  assert.equal(updateNull.ok, false);
  assert.equal(updateNull.error.code, 'BAD_REQUEST');

  // Stored record must NOT have been changed by the rejected update!
  const listRes = await listKhatibs_(db, true);
  const k = listRes.data.khatibs.find(x => x.id === id);
  assert.equal(k.name, 'الشيخ صالح');
  assert.deepEqual(k.availability, { mode: 'custom', weeks: [1, 3] });
});

test('CRUD - Rejects malformed weeks in all mode and preserves rule on rejection on fresh schema', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getFreshSchema());
  const db = makeD1Adapter(sqlite);

  // Create khatib with custom rule [2, 4]
  const createRes = await saveKhatib_(db, mockUser, {
    name: 'الشيخ فاروق',
    phone: '01088888888',
    availability: { mode: 'custom', weeks: [2, 4] },
  }, true);
  assert.equal(createRes.ok, true);
  const id = createRes.data.id;

  // Attempt update with mode: 'all' but malformed weeks: [0, 9] -> REJECTED
  const updateRes = await saveKhatib_(db, mockUser, {
    id,
    name: 'الشيخ فاروق المحدث',
    availability: { mode: 'all', weeks: [0, 9] },
  }, false);
  assert.equal(updateRes.ok, false);
  assert.equal(updateRes.error.code, 'BAD_REQUEST');

  // Verify stored record is preserved
  const listRes = await listKhatibs_(db, true);
  const k = listRes.data.khatibs.find(x => x.id === id);
  assert.equal(k.name, 'الشيخ فاروق');
  assert.deepEqual(k.availability, { mode: 'custom', weeks: [2, 4] });
});

test('CRUD - Omitted availability preserves stored rule on old client updates on fresh schema', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(getFreshSchema());
  const db = makeD1Adapter(sqlite);

  const createRes = await saveKhatib_(db, mockUser, {
    name: 'الشيخ حمزة',
    phone: '01099999999',
    notes: 'ملاحظة أولية',
    availability: { mode: 'custom', weeks: [1, 5] },
  }, true);
  const id = createRes.data.id;

  // Old client update sends name/phone/notes/active but completely omits availability
  const updateRes = await saveKhatib_(db, mockUser, {
    id,
    name: 'الشيخ حمزة بن علي',
    phone: '01099999999',
    notes: 'ملاحظة محدثة من عميل قديم',
    active: true,
  }, false);
  assert.equal(updateRes.ok, true);

  const listRes = await listKhatibs_(db, true);
  const k = listRes.data.khatibs.find(x => x.id === id);
  assert.equal(k.name, 'الشيخ حمزة بن علي');
  assert.equal(k.notes, 'ملاحظة محدثة من عميل قديم');
  assert.deepEqual(k.availability, { mode: 'custom', weeks: [1, 5] });
});

// ════════════════════════════════════════════════════════════════════
// 10. Chained migrations 0005 -> 0006 on a populated legacy database
// ════════════════════════════════════════════════════════════════════

test('MIGRATION CHAIN: legacy populated DB -> 0005 -> 0006 -> 0007 preserves rows and converges on the fresh schema', () => {
  const legacySchema = getLegacySchema().split('-- 11. طلبات مراجعة الاعتذار')[0]
    .replace(/\r?\n\s*manager_phone TEXT,/, '');
  const migrations = ['0005_excuse_requests.sql', '0006_khatib_availability.sql', '0007_mosque_portal.sql']
    .map((f) => fs.readFileSync(path.join(rootDir, 'worker/migrations', f), 'utf8'));
  const dataTables = ['users', 'mosques', 'preferences', 'assignments', 'settings', 'khatib_readiness'];
  const oldKhatibCols = 'id, name, phone, type, notes, active, created_at';

  // Two independent databases (one per region), each with its own populated legacy rows
  for (const region of ['may', 'tebeen']) {
    const db = new DatabaseSync(':memory:');
    db.exec(legacySchema);
    db.exec(`
      INSERT INTO users (username, display_name, password_hash, salt, active, created_at, role, region_access)
      VALUES ('${region}_admin', 'أدمن ${region}', 'h', 's', 1, '2026-08-01T00:00:00Z', 'admin', '${region === 'may' ? '15may' : 'tebeen'}');
      INSERT INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at, sort_order)
      VALUES ('M1', 'مسجد ${region}', 'مجاورة 1', 'شارع', 'K1', 1, '2026-08-01T00:00:00Z', 1);
      INSERT INTO khatibs (id, name, phone, type, notes, active, created_at)
      VALUES ('K1', 'خطيب 1', '01011111111', 'primary', 'ن1', 1, '2026-08-01T00:00:00Z'),
             ('K2', 'خطيب 2', '01022222222', 'volunteer', 'ن2', 0, '2026-08-02T00:00:00Z');
      INSERT INTO preferences (khatib_id, mosque_id) VALUES ('K1', 'M1'), ('K2', 'M1');
      INSERT INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
      VALUES ('2026-10-23_M1', '2026-10-23', 'M1', 'K1', 'confirmed', 'friday', '', 'a', '2026-10-20T10:00:00Z');
      INSERT INTO settings (key, value) VALUES ('next_khatib_seq', '42');
      INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
      VALUES ('2026-10-23', 'K2', 'ready', '2026-10-21T12:00:00Z');
    `);

    const before = {};
    for (const t of dataTables) before[t] = db.prepare(`SELECT * FROM ${t}`).all();
    const khatibsBefore = db.prepare(`SELECT ${oldKhatibCols} FROM khatibs ORDER BY id`).all();

    for (const sql of migrations) db.exec(sql);

    for (const t of dataTables) {
      const after = db.prepare(`SELECT * FROM ${t}`).all().map((row) => {
        if (t !== 'mosques') return row;
        assert.equal(row.manager_phone, null, `${region}: migration 0007 adds manager_phone as NULL`);
        const { manager_phone, ...rest } = row;
        return Object.assign(Object.create(null), rest);
      });
      assert.deepEqual(after, before[t], `${region}: ${t} unchanged after chain`);
    }
    assert.deepEqual(db.prepare(`SELECT ${oldKhatibCols} FROM khatibs ORDER BY id`).all(), khatibsBefore, `${region}: legacy khatib columns unchanged`);
    for (const k of db.prepare('SELECT * FROM khatibs').all()) {
      assert.equal(k.availability_mode, 'all');
      assert.equal(k.availability_weeks, null);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM excuse_requests').get().c, 0);

    // Migrated structure must match a fresh install of schema.sql
    const fresh = new DatabaseSync(':memory:');
    fresh.exec(fs.readFileSync(path.join(rootDir, 'worker/schema.sql'), 'utf8'));
    const shape = (d) => {
      const out = {};
      for (const { name } of d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        out[name] = d.prepare(`PRAGMA table_info(${name})`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`).sort();
      }
      return out;
    };
    assert.deepEqual(shape(db), shape(fresh), `${region}: migrated schema converges with fresh schema.sql`);
  }
});
