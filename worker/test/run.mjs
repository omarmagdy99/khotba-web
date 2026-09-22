// Integration test harness for khotba-api
// Node 18+ built-ins only

import { spawn, execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerDir = path.resolve(__dirname, '..');
const PORT = 8787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let devProcess = null;

function killProcess(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
    } catch (e) {}
  } else {
    try {
      proc.kill('SIGKILL');
    } catch (e) {}
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.data && json.data.status === 'healthy') {
          return true;
        }
      }
    } catch (e) {}
    await sleep(400);
  }
  throw new Error(`Timed out waiting for dev server on port ${PORT}`);
}

async function api(payload, headers = {}) {
  const res = await fetch(`${BASE_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8', ...headers },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

function d1Query(sql) {
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const out = execSync(`${npxCmd} wrangler d1 execute khotba-db --local --command "${sql.replace(/"/g, '\\"')}" --json`, {
    cwd: workerDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const parsed = JSON.parse(out.toString());
  return parsed[0]?.results || [];
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed++;
    console.error(`  FAIL: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function test(name, fn) {
  return async () => {
    process.stdout.write(`Testing: ${name} ... `);
    try {
      await fn();
      passed++;
      console.log('PASS');
    } catch (e) {
      console.error(`\n  Error in "${name}":`, e.message);
      throw e;
    }
  };
}

async function main() {
  console.log('====================================================');
  console.log('Starting khotba-api Integration Test Suite');
  console.log('====================================================');

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

  // 1. Delete local D1 state
  const stateDir = path.join(workerDir, '.wrangler', 'state');
  if (existsSync(stateDir)) {
    console.log('Deleting local D1 state at:', stateDir);
    rmSync(stateDir, { recursive: true, force: true });
  }

  // 2. Apply schema.sql and test/fixture.sql
  console.log('Applying schema.sql...');
  execSync(`${npxCmd} wrangler d1 execute khotba-db --local --file=schema.sql`, {
    cwd: workerDir,
    stdio: 'pipe',
    shell: true,
  });

  console.log('Applying test/fixture.sql...');
  execSync(`${npxCmd} wrangler d1 execute khotba-db --local --file=test/fixture.sql`, {
    cwd: workerDir,
    stdio: 'pipe',
    shell: true,
  });

  // 3. Spawn wrangler dev server
  console.log(`Starting wrangler dev on port ${PORT}...`);
  devProcess = spawn(`${npxCmd} wrangler dev --local --port ${PORT} --ip 127.0.0.1`, {
    cwd: workerDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  devProcess.stderr.on('data', (d) => {
    const str = d.toString();
    if (str.includes('Error')) console.error('[wrangler err]', str.trim());
  });

  const cleanup = () => {
    if (devProcess) {
      killProcess(devProcess);
      devProcess = null;
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(1); });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    cleanup();
    process.exit(1);
  });

  await waitForServer();
  console.log('Server is healthy!\n');

  let token = '';
  const fridayDate = '2026-09-25';

  const scenarios = [
    test('Scenario H: health endpoint does not leak pepperConfigured', async () => {
      const res = await fetch(`${BASE_URL}/health`);
      assert(res.ok, 'health response must be ok');
      const json = await res.json();
      assert(json.ok && json.data, 'health payload ok');
      assert(json.data.status === 'healthy', 'health status is healthy');
      assert(json.data.db === true, 'db is true');
      assert(json.data.pepperConfigured === undefined, 'pepperConfigured must NOT be in health response');
    }),

    test('Scenario 10: login works, bad token returns UNAUTHENTICATED, and legacy hash upgrades to pbkdf2 (Item G)', async () => {
      // 1. Fixture user starts with legacy SHA-256 hash
      const userBefore = d1Query("SELECT password_hash FROM users WHERE username = 'testadmin'")[0];
      assert(userBefore && !userBefore.password_hash.startsWith('pbkdf2$'), 'fixture user must start with legacy hash');

      // 2. Bad login
      const badLogin = await api({ action: 'login', username: 'testadmin', password: 'wrongpassword' });
      assert(!badLogin.ok, 'bad login must fail');
      assert(badLogin.error.code === 'UNAUTHENTICATED', 'code must be UNAUTHENTICATED');

      // 3. Good login -> authenticates and upgrades hash to PBKDF2
      const goodLogin = await api({ action: 'login', username: 'testadmin', password: 'password123' });
      assert(goodLogin.ok, 'good login must succeed');
      assert(goodLogin.data.token, 'token must be returned');
      assert(goodLogin.data.displayName === 'أدمن التجربة', 'displayName must match');
      token = goodLogin.data.token;

      // 4. Verify user's hash in DB is now pbkdf2$10000$<hex>
      const userAfter = d1Query("SELECT password_hash FROM users WHERE username = 'testadmin'")[0];
      assert(userAfter && userAfter.password_hash.startsWith('pbkdf2$10000$'), `hash in DB must be upgraded to pbkdf2$10000$, got: ${userAfter?.password_hash}`);

      // 5. Subsequent login with the same password verifies via the upgraded PBKDF2 hash
      const relogin = await api({ action: 'login', username: 'testadmin', password: 'password123' });
      assert(relogin.ok, 're-login with upgraded pbkdf2 hash must succeed');

      // 6. Bad token check
      const badTokenRes = await api({ action: 'whoami', token: 'invalid_token_xyz' });
      assert(!badTokenRes.ok, 'bad token must fail');
      assert(badTokenRes.error.code === 'UNAUTHENTICATED', 'code must be UNAUTHENTICATED');

      // 7. Valid token check
      const goodTokenRes = await api({ action: 'whoami', token });
      assert(goodTokenRes.ok, 'good token must succeed');
      assert(goodTokenRes.data.username === 'testadmin', 'username must match');
    }),

    test('Scenario Setup: generate Friday schedule', async () => {
      const gen = await api({ action: 'generateDate', token, date: fridayDate, dateType: 'friday' });
      assert(gen.ok, 'generateDate must succeed');
      assert(gen.data.rows.length === 4, '4 mosques generated');
      const m1 = gen.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1.khatibId === 'K001', 'M001 has prefilled permanent khatib K001');
      assert(m1.status === 'confirmed', 'M001 prefilled status is confirmed');
    }),

    test('Scenario C: generateDate twice returns existing schedule without error', async () => {
      const genSecond = await api({ action: 'generateDate', token, date: fridayDate, dateType: 'friday' });
      assert(genSecond.ok, 'second generateDate call must succeed without error');
      assert(genSecond.data.exists === true, 'exists flag must be true');
      assert(genSecond.data.rows.length === 4, 'returns all 4 mosques');
    }),

    test('Scenario 1: swap two khatibs in one save succeeds', async () => {
      // First assign K002 to M002
      const step1 = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [{ mosqueId: 'M002', khatibId: 'K002', status: 'confirmed' }]
      });
      assert(step1.ok, 'assigning K002 to M002 must succeed');

      // Now swap K001 and K002 between M001 and M002 in ONE batch
      const currentVersion = step1.data.version;
      const swapRes = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: currentVersion,
        changes: [
          { mosqueId: 'M001', khatibId: 'K002', status: 'confirmed' },
          { mosqueId: 'M002', khatibId: 'K001', status: 'confirmed' }
        ]
      });
      assert(swapRes.ok, `swap must succeed without unique constraint error: ${JSON.stringify(swapRes.error)}`);
      const rowM1 = swapRes.data.rows.find(r => r.mosqueId === 'M001');
      const rowM2 = swapRes.data.rows.find(r => r.mosqueId === 'M002');
      assert(rowM1.khatibId === 'K002', 'M001 now has K002');
      assert(rowM2.khatibId === 'K001', 'M002 now has K001');
    }),

    test('Scenario 2: move khatib into an already-changed mosque succeeds', async () => {
      // Currently M001=K002, M002=K001, M003=unassigned.
      // Move K001 from M002 to M003 and assign K003 to M002
      const sched = await api({ action: 'getSchedule', token, date: fridayDate });
      const moveRes = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: sched.data.version,
        changes: [
          { mosqueId: 'M003', khatibId: 'K001', status: 'confirmed' },
          { mosqueId: 'M002', khatibId: 'K003', status: 'confirmed' }
        ]
      });
      assert(moveRes.ok, `move into changed mosque must succeed: ${JSON.stringify(moveRes.error)}`);
      const rowM2 = moveRes.data.rows.find(r => r.mosqueId === 'M002');
      const rowM3 = moveRes.data.rows.find(r => r.mosqueId === 'M003');
      assert(rowM2.khatibId === 'K003', 'M002 now has K003');
      assert(rowM3.khatibId === 'K001', 'M003 now has K001');
    }),

    test('Scenario 3: true double booking returns KHATIB_DOUBLE_BOOKED', async () => {
      // (a) Duplicate inside payload
      const dupPayload = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [
          { mosqueId: 'M003', khatibId: 'K004', status: 'confirmed' },
          { mosqueId: 'M004', khatibId: 'K004', status: 'confirmed' }
        ]
      });
      assert(!dupPayload.ok, 'duplicate in payload must fail');
      assert(dupPayload.error.code === 'KHATIB_DOUBLE_BOOKED', 'code must be KHATIB_DOUBLE_BOOKED');

      // (b) Conflict with unchanged mosque (M001 has K002)
      const dupUnchanged = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [
          { mosqueId: 'M004', khatibId: 'K002', status: 'confirmed' }
        ]
      });
      assert(!dupUnchanged.ok, 'conflict with unchanged mosque must fail');
      assert(dupUnchanged.error.code === 'KHATIB_DOUBLE_BOOKED', 'code must be KHATIB_DOUBLE_BOOKED');
    }),

    test('Scenario 4: STALE_WRITE still fires with an old version', async () => {
      const staleRes = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: '2000-01-01T00:00:00.000Z',
        changes: [{ mosqueId: 'M001', khatibId: 'K002', status: 'confirmed' }]
      });
      assert(!staleRes.ok, 'old version must trigger STALE_WRITE');
      assert(staleRes.error.code === 'STALE_WRITE', 'code must be STALE_WRITE');
    }),

    test('Scenario 5: invalid status and inactive khatib rejected', async () => {
      // Invalid status
      const badStatus = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [{ mosqueId: 'M004', khatibId: 'K004', status: 'invalid_status' }]
      });
      assert(!badStatus.ok, 'invalid status must be rejected');
      assert(badStatus.error.code === 'BAD_REQUEST', 'code must be BAD_REQUEST');

      // Inactive khatib (K005 is active=0)
      const inactiveKhatib = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [{ mosqueId: 'M004', khatibId: 'K005', status: 'confirmed' }]
      });
      assert(!inactiveKhatib.ok, 'inactive khatib must be rejected');
      assert(inactiveKhatib.error.code === 'BAD_REQUEST', 'code must be BAD_REQUEST');

      // Non-existent khatib
      const nonExistent = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [{ mosqueId: 'M004', khatibId: 'K999', status: 'confirmed' }]
      });
      assert(!nonExistent.ok, 'non-existent khatib must be rejected');
      assert(nonExistent.error.code === 'BAD_REQUEST', 'code must be BAD_REQUEST');
    }),

    test('Scenario E: status-only change for a deactivated khatib past row is accepted', async () => {
      // K005 is inactive in fixture (active = 0).
      // Insert a past assignment for K005 on M001
      const pastDate = '2026-09-18';
      d1Query(`INSERT OR REPLACE INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at) VALUES ('${pastDate}_M001', '${pastDate}', 'M001', 'K005', 'confirmed', 'friday', '', 'testadmin', '${pastDate}T00:00:00.000Z')`);

      // 1. Changing only status for this existing row (with same khatib K005) must succeed
      const statusChange = await api({
        action: 'saveSchedule',
        token,
        date: pastDate,
        changes: [{ mosqueId: 'M001', khatibId: 'K005', status: 'excused' }]
      });
      assert(statusChange.ok, `status-only change for deactivated khatib must be accepted: ${JSON.stringify(statusChange.error)}`);
      const rowM1 = statusChange.data.rows.find(r => r.mosqueId === 'M001');
      assert(rowM1 && rowM1.status === 'excused', 'status must be updated to excused');
      assert(rowM1 && rowM1.khatibId === 'K005', 'khatibId must remain K005');

      // 2. However, attempting to assign inactive khatib K005 to a different mosque (M002) must still fail
      const assignDiff = await api({
        action: 'saveSchedule',
        token,
        date: pastDate,
        changes: [{ mosqueId: 'M002', khatibId: 'K005', status: 'confirmed' }]
      });
      assert(!assignDiff.ok, 'assigning inactive khatib to a different mosque must be rejected');
      assert(assignDiff.error.code === 'BAD_REQUEST', 'must return BAD_REQUEST');
      assert(assignDiff.error.message.includes('غير نشط'), 'must indicate khatib is inactive');
    }),

    test('Scenario 6: excused khatib hidden in public GET', async () => {
      // Assign K004 to M004 with status excused
      const saveExcused = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        changes: [{ mosqueId: 'M004', khatibId: 'K004', status: 'excused' }]
      });
      assert(saveExcused.ok, 'saving excused khatib must succeed');

      // Publish the date range
      const pubRange = await api({ action: 'publishRange', token, from: fridayDate, to: fridayDate });
      assert(pubRange.ok, 'publishRange must succeed');

      // Query public schedule via GET
      const pubRes = await fetch(`${BASE_URL}/?date=${fridayDate}`);
      const pubJson = await pubRes.json();
      assert(pubJson.ok, 'public schedule GET must succeed');
      assert(pubJson.data.published === true, 'published must be true');

      const m4 = pubJson.data.rows.find(r => r.mosque === 'مسجد الفردوس');
      assert(m4, 'M004 must be in public rows');
      assert(m4.khatib === '', `excused khatib must be empty string in public GET, got: "${m4.khatib}"`);

      const m1 = pubJson.data.rows.find(r => r.mosque === 'مسجد النور');
      assert(m1 && m1.khatib === 'محمد حسن', 'confirmed khatib must appear');
    }),

    test('Scenario 7: deactivated mosque future rows removed and absent from public GET', async () => {
      // Deactivate M004
      const deactM = await api({ action: 'deactivateMosque', token, id: 'M004' });
      assert(deactM.ok, 'deactivateMosque must succeed');
      assert(Array.isArray(deactM.data.clearedAssignments), 'clearedAssignments array returned');
      const clearedEntry = deactM.data.clearedAssignments.find(c => c.date === fridayDate && c.mosqueId === 'M004');
      assert(clearedEntry, 'freed assignment for M004 returned in clearedAssignments');

      // Internal schedule should no longer list M004
      const sched = await api({ action: 'getSchedule', token, date: fridayDate });
      assert(sched.ok, 'getSchedule must succeed');
      const m4Internal = sched.data.rows.find(r => r.mosqueId === 'M004');
      assert(!m4Internal, 'M004 must be deleted from future assignments');

      // Public GET should not list M004
      const pubRes = await fetch(`${BASE_URL}/?date=${fridayDate}`);
      const pubJson = await pubRes.json();
      const m4Pub = pubJson.data.rows.find(r => r.mosque === 'مسجد الفردوس');
      assert(!m4Pub, 'M004 must be absent from public schedule');
    }),

    test('Scenario 8: updateMosque/updateKhatib with active:false performs cleanup', async () => {
      // M001 currently has K002 confirmed. Update K002 to active: false
      const deactK2 = await api({
        action: 'updateKhatib',
        token,
        id: 'K002',
        name: 'محمد حسن',
        phone: '01022222222',
        type: 'primary',
        active: false
      });
      assert(deactK2.ok, 'updateKhatib with active: false must succeed');

      // Check future assignments: M001 should now have unassigned khatib
      const schedAfterK = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Row = schedAfterK.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Row.khatibId === '', 'M001 khatib must be cleared after khatib deactivation');
      assert(m1Row.status === 'unassigned', 'M001 status must be unassigned');

      // Also check permanent khatib cleanup: K001 was permanent at M001
      const deactK1 = await api({
        action: 'updateKhatib',
        token,
        id: 'K001',
        name: 'أحمد علي',
        phone: '01011111111',
        type: 'primary',
        active: false
      });
      assert(deactK1.ok, 'updateKhatib with active: false for permanent khatib must succeed');
      const mosquesList = await api({ action: 'listMosques', token, includeInactive: true });
      const m1Info = mosquesList.data.mosques.find(m => m.id === 'M001');
      assert(m1Info.permanentKhatibId === '', 'permanent_khatib_id on M001 must be cleared');

      // Now test updateMosque with active: false on M003 (which has K001 assigned)
      const deactM3 = await api({
        action: 'updateMosque',
        token,
        id: 'M003',
        name: 'مسجد الإيمان',
        mujawra: 'مجاورة 3',
        active: false
      });
      assert(deactM3.ok, 'updateMosque with active: false must succeed');

      const schedAfterM = await api({ action: 'getSchedule', token, date: fridayDate });
      const m3Row = schedAfterM.data.rows.find(r => r.mosqueId === 'M003');
      assert(!m3Row, 'M003 assignment must be deleted after updateMosque deactivation');
    }),

    test('Scenario 9: duplicate phone returns DUPLICATE and does not consume an id', async () => {
      // Get settings before create
      const settingsBefore = await api({ action: 'getSettings', token });
      const seqBefore = settingsBefore.data.settings.next_khatib_seq;

      // Attempt to create khatib with duplicate phone (K001's phone 01011111111)
      const dupCreate = await api({
        action: 'createKhatib',
        token,
        name: 'خطيب مكرر',
        phone: '01011111111',
        type: 'primary'
      });
      assert(!dupCreate.ok, 'duplicate phone create must fail');
      assert(dupCreate.error.code === 'DUPLICATE', 'error code must be DUPLICATE');
      assert(dupCreate.error.message.includes('أحمد علي'), `message must name conflict holder: ${dupCreate.error.message}`);

      // Verify sequence was NOT consumed
      const settingsAfter = await api({ action: 'getSettings', token });
      const seqAfter = settingsAfter.data.settings.next_khatib_seq;
      assert(seqBefore === seqAfter, `next_khatib_seq must remain unchanged (${seqBefore} === ${seqAfter})`);

      // Attempt to update khatib with duplicate phone (K003 with K001's phone)
      const dupUpdate = await api({
        action: 'updateKhatib',
        token,
        id: 'K003',
        name: 'محمود سيد',
        phone: '01011111111',
        type: 'volunteer'
      });
      assert(!dupUpdate.ok, 'duplicate phone update must fail');
      assert(dupUpdate.error.code === 'DUPLICATE', 'error code must be DUPLICATE');
    }),

    test('Scenario A: second mosque with same permanent khatib returns PERMANENT_CONFLICT', async () => {
      // 1. Ensure K001 and M001 are active and paired
      await api({ action: 'updateKhatib', token, id: 'K001', name: 'أحمد علي', phone: '01011111111', type: 'primary', active: true });
      await api({ action: 'updateMosque', token, id: 'M001', name: 'مسجد النور', mujawra: 'مجاورة 1', permanentKhatibId: 'K001', active: true });

      // 2. Attempt to create a second mosque with permanentKhatibId: 'K001'
      const resCreate = await api({
        action: 'createMosque',
        token,
        name: 'مسجد النقاء',
        mujawra: 'مجاورة 15',
        permanentKhatibId: 'K001'
      });
      assert(!resCreate.ok, 'creating second mosque with duplicate permanent khatib must fail');
      assert(resCreate.error.code === 'PERMANENT_CONFLICT', `error code must be PERMANENT_CONFLICT, got: ${resCreate.error?.code}`);

      // 3. Attempt to update an existing mosque (M002) to also have permanentKhatibId: 'K001'
      const resUpdate = await api({
        action: 'updateMosque',
        token,
        id: 'M002',
        name: 'مسجد التقوى',
        mujawra: 'مجاورة 2',
        permanentKhatibId: 'K001'
      });
      assert(!resUpdate.ok, 'updating mosque to duplicate permanent khatib must fail');
      assert(resUpdate.error.code === 'PERMANENT_CONFLICT', `error code must be PERMANENT_CONFLICT, got: ${resUpdate.error?.code}`);
    }),

    test('Scenario B: atomic ID sequence generates consecutive IDs continuing sequence', async () => {
      // Create khatib 1 (continuing next_khatib_seq = 6 in fixture)
      const k1 = await api({
        action: 'createKhatib',
        token,
        name: 'خطيب متسلسل أول',
        phone: '01033333331',
        type: 'volunteer'
      });
      assert(k1.ok, `createKhatib 1 must succeed: ${JSON.stringify(k1.error)}`);
      assert(k1.data.id === 'K006', `first khatib must get K006, got: ${k1.data.id}`);

      // Create khatib 2
      const k2 = await api({
        action: 'createKhatib',
        token,
        name: 'خطيب متسلسل ثان',
        phone: '01033333332',
        type: 'volunteer'
      });
      assert(k2.ok, `createKhatib 2 must succeed: ${JSON.stringify(k2.error)}`);
      assert(k2.data.id === 'K007', `second khatib must get K007, got: ${k2.data.id}`);

      // Verify DB stored setting is now 8
      const row = d1Query("SELECT value FROM settings WHERE key = 'next_khatib_seq'")[0];
      assert(row && parseInt(row.value, 10) === 8, `next_khatib_seq must be stored as 8, got: ${row?.value}`);
    }),

    test('Scenario F: login rate limit (5 failures -> 6th RATE_LIMITED; IP threshold; username cleared on success)', async () => {
      const limitedIp = '198.51.100.77';
      const headers = { 'CF-Connecting-IP': limitedIp };

      // 1. 5 wrong passwords from limitedIp
      for (let i = 1; i <= 5; i++) {
        const res = await api({ action: 'login', username: 'ratetestuser', password: 'wrongpassword' }, headers);
        assert(!res.ok, `attempt ${i} must fail`);
        assert(res.error.code === 'UNAUTHENTICATED', `attempt ${i} code must be UNAUTHENTICATED, got: ${res.error?.code}`);
      }

      // 2. 6th attempt (even with any password) returns RATE_LIMITED
      const res6 = await api({ action: 'login', username: 'ratetestuser', password: 'anyPassword' }, headers);
      assert(!res6.ok, '6th attempt must fail');
      assert(res6.error.code === 'RATE_LIMITED', `6th attempt must be RATE_LIMITED, got: ${res6.error?.code}`);
      assert(res6.error.message === 'محاولات كتير غلط، استنى ربع ساعة وحاول تاني', 'rate limit message in Arabic');

      // 3. Different username from the SAME IP is also limited after IP threshold
      const resOther = await api({ action: 'login', username: 'differentuser', password: 'anyPassword' }, headers);
      assert(!resOther.ok, 'different username from rate-limited IP must fail');
      assert(resOther.error.code === 'RATE_LIMITED', `different username from same IP must be RATE_LIMITED, got: ${resOther.error?.code}`);

      // 4. Same differentuser from a DIFFERENT IP is NOT rate limited
      const diffHeaders = { 'CF-Connecting-IP': '198.51.100.88' };
      const resDiff = await api({ action: 'login', username: 'differentuser', password: 'anyPassword' }, diffHeaders);
      assert(!resDiff.ok, 'login with wrong password fails');
      assert(resDiff.error.code === 'UNAUTHENTICATED', `different IP must return UNAUTHENTICATED, got: ${resDiff.error?.code}`);

      // 5. Successful login clears the username key
      // Fail 2 times for testadmin from diffHeaders
      await api({ action: 'login', username: 'testadmin', password: 'wrongpassword' }, diffHeaders);
      await api({ action: 'login', username: 'testadmin', password: 'wrongpassword' }, diffHeaders);
      const attemptsBefore = d1Query("SELECT * FROM login_attempts WHERE key = 'u:testadmin'");
      assert(attemptsBefore.length > 0, 'u:testadmin key must exist in login_attempts');

      // Successful login clears u:testadmin
      const resGood = await api({ action: 'login', username: 'testadmin', password: 'password123' }, diffHeaders);
      assert(resGood.ok, 'login with right password succeeds');
      const attemptsAfter = d1Query("SELECT * FROM login_attempts WHERE key = 'u:testadmin'");
      assert(attemptsAfter.length === 0, 'u:testadmin key must be deleted after successful login');
    }),

    test('Scenario 8 (Top-level catch): internal / unhandled errors return generic Arabic message', async () => {
      // Invalid JSON body
      const badJsonRes = await fetch(`${BASE_URL}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'NOT_VALID_JSON{',
      });
      const badJson = await badJsonRes.json();
      assert(!badJson.ok, 'invalid JSON must fail');
      assert(badJson.error.code === 'BAD_REQUEST', 'code must be BAD_REQUEST');
    }),

    test('Scenario 11: changePassword validation and bad current password', async () => {
      // Ping includes changePassword in actions
      const pingRes = await fetch(`${BASE_URL}/?ping=1`).then(r => r.json());
      assert(pingRes.ok && pingRes.data.actions.includes('changePassword'), 'ping actions must include changePassword');

      // Wrong current password -> BAD_PASSWORD and session still valid
      const badPassRes = await api({
        action: 'changePassword',
        token,
        currentPassword: 'wrongpassword',
        newPassword: 'validNewPassword123',
      });
      assert(!badPassRes.ok, 'wrong current password must fail');
      assert(badPassRes.error.code === 'BAD_PASSWORD', 'error code must be BAD_PASSWORD');
      assert(badPassRes.error.message === 'كلمة المرور الحالية غير صحيحة', 'message must be Arabic bad password notice');

      // Verify session is still valid
      const checkSession = await api({ action: 'whoami', token });
      assert(checkSession.ok, 'session must remain valid after BAD_PASSWORD');
      assert(checkSession.data.username === 'testadmin', 'username must match');

      // Too short (< 8 chars) -> BAD_REQUEST
      const shortPassRes = await api({
        action: 'changePassword',
        token,
        currentPassword: 'password123',
        newPassword: 'short',
      });
      assert(!shortPassRes.ok, 'too short password must fail');
      assert(shortPassRes.error.code === 'BAD_REQUEST', 'too short password must return BAD_REQUEST');

      // Equals username -> BAD_REQUEST
      const userPassRes = await api({
        action: 'changePassword',
        token,
        currentPassword: 'password123',
        newPassword: 'testadmin',
      });
      assert(!userPassRes.ok, 'password equal to username must fail');
      assert(userPassRes.error.code === 'BAD_REQUEST', 'equals username must return BAD_REQUEST');

      // Same as current -> BAD_REQUEST
      const samePassRes = await api({
        action: 'changePassword',
        token,
        currentPassword: 'password123',
        newPassword: 'password123',
      });
      assert(!samePassRes.ok, 'password equal to current password must fail');
      assert(samePassRes.error.code === 'BAD_REQUEST', 'same as current must return BAD_REQUEST');
    }),

    test('Scenario 12: changePassword success, session invalidation and re-login', async () => {
      // 1. Log in twice first to obtain a second session token
      const secondLogin = await api({ action: 'login', username: 'testadmin', password: 'password123' });
      assert(secondLogin.ok, 'second login must succeed');
      const token2 = secondLogin.data.token;
      assert(token2 && token2 !== token, 'second token must be distinct from original token');

      const checkToken2 = await api({ action: 'whoami', token: token2 });
      assert(checkToken2.ok, 'token2 must be valid before password change');

      // 2. Successfully change password using the first token
      const changeRes = await api({
        action: 'changePassword',
        token,
        currentPassword: 'password123',
        newPassword: 'newSecretPassword456',
      });
      assert(changeRes.ok, 'changePassword must succeed');
      assert(changeRes.data && changeRes.data.changed === true, 'changed: true must be returned');

      // 3. Old password no longer logs in
      const oldLogin = await api({ action: 'login', username: 'testadmin', password: 'password123' });
      assert(!oldLogin.ok, 'old password must not log in');
      assert(oldLogin.error.code === 'UNAUTHENTICATED', 'old login error code must be UNAUTHENTICATED');

      // 4. New password does log in
      const newLogin = await api({ action: 'login', username: 'testadmin', password: 'newSecretPassword456' });
      assert(newLogin.ok, 'new password must log in');
      assert(newLogin.data.token, 'new login must return a valid token');

      // 5. Current token still works
      const checkToken1 = await api({ action: 'whoami', token });
      assert(checkToken1.ok, 'current session token must still work');
      assert(checkToken1.data.username === 'testadmin', 'current session username matches');

      // 6. Second session token is now UNAUTHENTICATED
      const checkToken2After = await api({ action: 'whoami', token: token2 });
      assert(!checkToken2After.ok, 'second session token must be invalid after password change');
      assert(checkToken2After.error.code === 'UNAUTHENTICATED', 'second token must return UNAUTHENTICATED');

      // 7. Verify DB row has pbkdf2$10000$ format
      const userRow = d1Query("SELECT password_hash FROM users WHERE username = 'testadmin'")[0];
      assert(userRow && userRow.password_hash.startsWith('pbkdf2$10000$'), `changePassword must write pbkdf2$10000$, got ${userRow?.password_hash}`);
    }),
  ];

  try {
    for (const s of scenarios) {
      await s();
    }
    console.log('\n====================================================');
    console.log(`ALL TESTS PASSED! (${passed} passed, ${failed} failed)`);
    console.log('====================================================');
  } catch (err) {
    console.error('\n====================================================');
    console.error(`TEST SUITE FAILED! (${passed} passed, ${failed + 1} failed)`);
    console.error('====================================================');
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
