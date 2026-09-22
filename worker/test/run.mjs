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

async function api(payload) {
  const res = await fetch(`${BASE_URL}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(payload),
  });
  return await res.json();
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
    test('Scenario 10: login works and bad token returns UNAUTHENTICATED', async () => {
      // Bad login
      const badLogin = await api({ action: 'login', username: 'testadmin', password: 'wrongpassword' });
      assert(!badLogin.ok, 'bad login must fail');
      assert(badLogin.error.code === 'UNAUTHENTICATED', 'code must be UNAUTHENTICATED');

      // Good login
      const goodLogin = await api({ action: 'login', username: 'testadmin', password: 'password123' });
      assert(goodLogin.ok, 'good login must succeed');
      assert(goodLogin.data.token, 'token must be returned');
      assert(goodLogin.data.displayName === 'أدمن التجربة', 'displayName must match');
      token = goodLogin.data.token;

      // Bad token check
      const badTokenRes = await api({ action: 'whoami', token: 'invalid_token_xyz' });
      assert(!badTokenRes.ok, 'bad token must fail');
      assert(badTokenRes.error.code === 'UNAUTHENTICATED', 'code must be UNAUTHENTICATED');

      // Valid token check
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
