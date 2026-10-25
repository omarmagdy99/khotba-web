// Integration test harness for khotba-api
// Node 18+ built-ins only

import { spawn, execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'node:http';
import { currentSermonDate_ } from '../src/khatib-portal.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerDir = path.resolve(__dirname, '..');
const PORT = Number(process.env.TEST_PORT) || 8787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let devProcess = null;
let telegramServer = null;
const telegramMessages = [];

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
  const out = execSync(`${npxCmd} wrangler d1 execute khotba-db --local --persist-to .wrangler/test-regions --command "${sql.replace(/"/g, '\\"')}" --json`, {
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
  const stateDir = path.join(workerDir, '.wrangler', 'test-regions');
  if (path.resolve(stateDir) !== path.resolve(workerDir, '.wrangler', 'test-regions')) throw new Error('Invalid test state directory');
  if (existsSync(stateDir)) {
    console.log('Deleting local D1 state at:', stateDir);
    rmSync(stateDir, { recursive: true, force: true });
  }

  // 2. Apply schema.sql and test/fixture.sql
  console.log('Applying schema.sql...');
  execSync(`${npxCmd} wrangler d1 execute khotba-db --local --persist-to .wrangler/test-regions --file=schema.sql`, {
    cwd: workerDir,
    stdio: 'pipe',
    shell: true,
  });

  execSync(`${npxCmd} wrangler d1 execute khotba-tebeen-db --local --persist-to .wrangler/test-regions --file=schema.sql`, { cwd: workerDir, stdio: 'pipe', shell: true });

  console.log('Applying test/fixture.sql...');
  execSync(`${npxCmd} wrangler d1 execute khotba-db --local --persist-to .wrangler/test-regions --file=test/fixture.sql`, {
    cwd: workerDir,
    stdio: 'pipe',
    shell: true,
  });

  telegramServer = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    telegramMessages.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
  await new Promise(resolve => telegramServer.listen(0, '127.0.0.1', resolve));
  const telegramBase = `http://127.0.0.1:${telegramServer.address().port}`;

  // 3. Spawn wrangler dev server
  console.log(`Starting wrangler dev on port ${PORT}...`);
  devProcess = spawn(`${npxCmd} wrangler dev --local --persist-to .wrangler/test-regions --port ${PORT} --ip 127.0.0.1 --var TELEGRAM_API_BASE:${telegramBase} --var TELEGRAM_BOT_TOKEN:test-token --var TELEGRAM_WEBHOOK_SECRET:test-secret --var TELEGRAM_BOT_USERNAME:test_bot`, {
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
    if (telegramServer) { telegramServer.close(); telegramServer = null; }
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

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

function getNextFriday(now = new Date()) {
  const day = now.getUTCDay();
  const diff = (5 - day + 7) % 7 || 7;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  return toIsoDate(d);
}

  let token = '';
  const fridayDate = currentSermonDate_();
  const pastDate = addDays(fridayDate, -7);
  const datePlus7 = addDays(fridayDate, 7);
  const datePlus14 = addDays(fridayDate, 14);

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
      assert(m1.status === 'unassigned', 'M001 permanent khatib starts awaiting confirmation');
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

    test('Scenario O: reorderMosque renumbers 1..N and every listing follows the order', async () => {
      const bad = await api({ action: 'reorderMosque', token, id: 'M003', position: 0 });
      assert(!bad.ok && bad.error.code === 'BAD_REQUEST', 'position 0 must be BAD_REQUEST');

      const missing = await api({ action: 'reorderMosque', token, id: 'M999', position: 1 });
      assert(!missing.ok && missing.error.code === 'NOT_FOUND', 'unknown mosque must be NOT_FOUND');

      const toEnd = await api({ action: 'reorderMosque', token, id: 'M001', position: 99 });
      assert(toEnd.ok, `reorder must succeed: ${JSON.stringify(toEnd.error)}`);
      const endIds = toEnd.data.mosques.map(m => m.id).join(',');
      assert(endIds === 'M002,M003,M004,M001', `position past the end clamps to last, got ${endIds}`);

      const res = await api({ action: 'reorderMosque', token, id: 'M003', position: 1 });
      assert(res.ok, 'reorder must succeed');
      const ids = res.data.mosques.map(m => m.id).join(',');
      assert(ids === 'M003,M002,M004,M001', `M003 moves to 1 and pushes the rest, got ${ids}`);
      assert(res.data.mosques.map(m => m.sortOrder).join(',') === '1,2,3,4', 'numbers stay contiguous');

      const list = await api({ action: 'listMosques', token });
      assert(list.data.mosques.map(m => m.id).join(',') === ids, 'listMosques follows sort order');

      const sched = await api({ action: 'getSchedule', token, date: fridayDate });
      assert(sched.data.rows.map(r => r.mosqueId).join(',') === ids, 'getSchedule follows sort order');
      assert(sched.data.rows[0].sortOrder === 1, 'getSchedule rows carry sortOrder');
    }),

    test('Scenario P: getScheduleHistory returns earlier dates only', async () => {
      const hist = await api({ action: 'getScheduleHistory', token, from: addDays(pastDate, -7), before: fridayDate });
      assert(hist.ok, `history must succeed: ${JSON.stringify(hist.error)}`);
      assert(hist.data.dates.map(d => d.date).join(',') === pastDate, 'only the date before is returned');
      const m1 = hist.data.rows.find(r => r.mosqueId === 'M001' && r.date === pastDate);
      assert(m1 && m1.khatibId === 'K005' && m1.status === 'excused', 'history row carries khatib and status');
      assert(!hist.data.rows.some(r => r.date >= fridayDate), 'nothing on or after the current date');

      const none = await api({ action: 'getScheduleHistory', token, from: fridayDate, before: fridayDate });
      assert(none.ok && none.data.dates.length === 0, 'from >= before is empty, not an error');

      const bad = await api({ action: 'getScheduleHistory', token, from: 'x', before: fridayDate });
      assert(!bad.ok && bad.error.code === 'BAD_REQUEST', 'bad date is BAD_REQUEST');
    }),

    test('Scenario Q: publishing picked dates hides the dates in between; public rows are numbered in order', async () => {
      for (const d of [datePlus7, datePlus14]) {
        const g = await api({ action: 'generateDate', token, date: d, dateType: 'friday' });
        assert(g.ok, 'generate ' + d);
      }

      const pub = await api({ action: 'publishRange', token, dates: [datePlus14, fridayDate, fridayDate] });
      assert(pub.ok, `publish dates must succeed: ${JSON.stringify(pub.error)}`);
      assert(pub.data.from === fridayDate && pub.data.to === datePlus14, 'from/to are first and last date');

      const json = await (await fetch(`${BASE_URL}/`)).json();
      assert(json.data.dates.map(d => d.date).join(',') === `${fridayDate},${datePlus14}`, 'only picked dates are public');

      const skipped = await (await fetch(`${BASE_URL}/?date=${datePlus7}`)).json();
      assert(skipped.data.date === fridayDate, 'an unpicked date inside the window is not served');

      assert(json.data.rows[0].mosque === 'مسجد الإيمان' && json.data.rows[0].no === 1, 'public rows follow mosque order');
      assert(json.data.rows.map(r => r.no).join(',') === '1,2,3,4', 'public numbers are 1..N');

      const badDate = await api({ action: 'publishRange', token, dates: ['nope'] });
      assert(!badDate.ok && badDate.error.code === 'BAD_REQUEST', 'bad date in list is rejected');

      // النشر بالفترة (الطريقة القديمة) بيمسح قائمة التواريخ
      const range = await api({ action: 'publishRange', token, from: fridayDate, to: fridayDate });
      assert(range.ok, 'range publish still works');
      const settings = await api({ action: 'getSettings', token });
      assert(settings.data.settings.publish_dates === '', 'range publish clears picked dates');
    }),

    test('Scenario R: publishRange hideEmpty omits unconfirmed mosques with contiguous 1..N numbers', async () => {
      // 1. Publish with hideEmpty: true
      const pubHide = await api({ action: 'publishRange', token, from: fridayDate, to: fridayDate, hideEmpty: true });
      assert(pubHide.ok, 'publishRange with hideEmpty: true must succeed');

      const settingsHide = await api({ action: 'getSettings', token });
      assert(settingsHide.data.settings.publish_hide_empty === '1', 'publish_hide_empty is stored as 1');

      const resHide = await (await fetch(`${BASE_URL}/?date=${fridayDate}`)).json();
      assert(resHide.ok, 'public schedule GET succeeds');
      assert(resHide.data.rows.length < 4, 'unconfirmed/empty mosque is omitted');
      assert(!resHide.data.rows.some(r => !r.khatib), 'no empty khatib rows in public GET');
      const expectedNos = resHide.data.rows.map((_, i) => i + 1).join(',');
      assert(resHide.data.rows.map(r => r.no).join(',') === expectedNos, 'numbers stay 1..N contiguous');

      // 2. Republish with hideEmpty false/absent
      const pubShow = await api({ action: 'publishRange', token, from: fridayDate, to: fridayDate });
      assert(pubShow.ok, 'republish with hideEmpty absent must succeed');

      const settingsShow = await api({ action: 'getSettings', token });
      assert(settingsShow.data.settings.publish_hide_empty === '', 'publish_hide_empty is reset to empty string');

      const resShow = await (await fetch(`${BASE_URL}/?date=${fridayDate}`)).json();
      assert(resShow.ok, 'public schedule GET succeeds after republish');
      assert(resShow.data.rows.length === 4, 'all mosques are back');
      assert(resShow.data.rows.some(r => !r.khatib), 'unconfirmed/empty mosque is back');
      assert(resShow.data.rows.map(r => r.no).join(',') === '1,2,3,4', 'numbers stay 1..4 contiguous');
    }),

    test('Scenario S: automatic publishing mode (publish_mode=auto)', async () => {
      // 1. Publish with mode: 'auto'
      const pubAuto = await api({ action: 'publishRange', token, mode: 'auto' });
      assert(pubAuto.ok, 'publishRange with mode: auto must succeed');
      assert(pubAuto.data.mode === 'auto', 'response returns mode: auto');

      const settingsAuto = await api({ action: 'getSettings', token });
      assert(settingsAuto.data.settings.publish_mode === 'auto', 'publish_mode is stored as auto');
      assert(settingsAuto.data.settings.publish_dates === '', 'publish_dates is cleared in auto mode');

      // 2. Public GET returns exactly one date equal to earliest generated date >= today
      const pubRes = await (await fetch(`${BASE_URL}/`)).json();
      assert(pubRes.ok, 'public schedule GET succeeds in auto mode');
      assert(pubRes.data.published === true, 'published must be true');
      assert(pubRes.data.date === fridayDate, `date must be auto target (${fridayDate}), got ${pubRes.data.date}`);
      assert(pubRes.data.dates.length === 1, 'dates must have exactly one date');
      assert(pubRes.data.dates[0].date === fridayDate, 'dates[0].date must be auto target');
      assert(pubRes.data.rows.length === 4, 'all active mosques present');

      // 3. ?date= parameter is ignored in auto mode and still returns auto target
      const pubWithDate = await (await fetch(`${BASE_URL}/?date=${datePlus14}`)).json();
      assert(pubWithDate.ok, 'public GET with date param succeeds');
      assert(pubWithDate.data.date === fridayDate, '?date param is ignored in auto mode, still returns auto target');
      assert(pubWithDate.data.dates.length === 1 && pubWithDate.data.dates[0].date === fridayDate, 'dates array still contains only auto target');

      // 4. hideEmpty applies in auto mode
      const pubAutoHide = await api({ action: 'publishRange', token, mode: 'auto', hideEmpty: true });
      assert(pubAutoHide.ok, 'publishRange auto with hideEmpty: true must succeed');

      const resAutoHide = await (await fetch(`${BASE_URL}/`)).json();
      assert(resAutoHide.ok, 'public GET succeeds with hideEmpty in auto mode');
      assert(resAutoHide.data.rows.length < 4, 'unconfirmed/empty mosque is omitted in auto mode');
      assert(!resAutoHide.data.rows.some(r => !r.khatib), 'no empty khatib rows in auto mode when hideEmpty is true');
      const expectedNos = resAutoHide.data.rows.map((_, i) => i + 1).join(',');
      assert(resAutoHide.data.rows.map(r => r.no).join(',') === expectedNos, 'numbers stay 1..N contiguous');

      // 5. Later manual publish switches publish_mode back to ''
      const pubManualDates = await api({ action: 'publishRange', token, dates: [fridayDate] });
      assert(pubManualDates.ok, 'manual publish with dates must succeed');

      const settingsManual = await api({ action: 'getSettings', token });
      assert(settingsManual.data.settings.publish_mode === '', 'manual publish resets publish_mode to empty');

      // 6. Reset state compatible with subsequent scenarios (range publish, hideEmpty false)
      const pubReset = await api({ action: 'publishRange', token, from: fridayDate, to: fridayDate });
      assert(pubReset.ok, 're-publish range for subsequent scenarios succeeds');

      const finalSettings = await api({ action: 'getSettings', token });
      assert(finalSettings.data.settings.publish_mode === '', 'final publish_mode is empty');
      assert(finalSettings.data.settings.publish_hide_empty === '', 'final publish_hide_empty is empty');
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

    test('Scenario 13: two public GETs return identical JSON (Item 4)', async () => {
      const publicUrl = `${BASE_URL}/?date=${fridayDate}`;
      const res1 = await fetch(publicUrl);
      const json1 = await res1.json();
      assert(res1.ok && json1.ok, 'first public GET must succeed');

      const res2 = await fetch(publicUrl);
      const json2 = await res2.json();
      assert(res2.ok && json2.ok, 'second public GET must succeed');

      assert(JSON.stringify(json1) === JSON.stringify(json2), 'two public GETs must return identical JSON');
      assert(res1.headers.get('access-control-allow-origin') === '*', 'CORS origin header must be preserved');
      assert(res2.headers.get('access-control-allow-origin') === '*', 'CORS origin header must be preserved on cached response');
    }),

    test('Region isolation: empty Tebeen, overlapping IDs, scheduling, publishing and deactivation', async () => {
      const tebeen = async (payload, region = 'tebeen') => {
        const response = await fetch(`${BASE_URL}/?region=${region}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, ...payload }),
        });
        return response.json();
      };
      const readMay = async () => JSON.stringify(await Promise.all([
        api({ action: 'listMosques', token, includeInactive: true }),
        api({ action: 'listKhatibs', token, includeInactive: true }),
        api({ action: 'listDates', token }), api({ action: 'getSettings', token }),
        api({ action: 'getSchedule', token, date: fridayDate }),
        fetch(BASE_URL).then(r => r.json()),
      ]));
      const before = await readMay();
      assert((await tebeen({ action: 'listMosques' })).data.mosques.length === 0, 'Tebeen starts without mosques');
      assert((await tebeen({ action: 'listKhatibs' })).data.khatibs.length === 0, 'Tebeen starts without khatibs');
      assert((await tebeen({ action: 'listDates' })).data.dates.length === 0, 'Tebeen starts without schedules');
      assert(!(await fetch(`${BASE_URL}/?region=tebeen`).then(r => r.json())).data.published, 'Tebeen starts unpublished');
      assert((await tebeen({ action: 'whoami' })).ok, 'existing account works in Tebeen');
      const missingArea = await tebeen({ action: 'createMosque', name: 'مسجد تجريبي' });
      assert(missingArea.error.message === 'اسم المسجد والمنطقة مطلوبان', 'Tebeen validation uses region terminology');
      assert((await tebeen({ action: 'createKhatib', name: 'خطيب التبين', phone: '01011111111' })).data.id === 'K001', 'IDs and phones can overlap across regions');
      assert((await tebeen({ action: 'createMosque', name: 'مسجد التبين', mujawra: 'التبين', permanentKhatibId: 'K001' })).data.id === 'M001', 'mosque IDs can overlap');
      assert((await tebeen({ action: 'setPreferences', khatibId: 'K001', mosqueIds: ['M001'] })).ok, 'preferences saved in Tebeen');
      const generated = await tebeen({ action: 'generateDate', date: fridayDate });
      assert(generated.ok && generated.data.rows.length === 1 && generated.data.rows[0].khatib === 'خطيب التبين', 'only Tebeen mosque generated');
      const saved = await tebeen({ action: 'saveSchedule', date: fridayDate, version: generated.data.version, changes: [{ mosqueId: 'M001', khatibId: 'K001', status: 'confirmed' }] });
      assert(saved.ok, 'Tebeen schedule saved');
      assert((await tebeen({ action: 'getKhatibSchedule', khatibId: 'K001' })).data.rows.length === 1, 'khatib schedule isolated');
      assert((await tebeen({ action: 'getLoadCounts' })).data.counts.K001 === 1, 'load counts isolated');
      assert((await tebeen({ action: 'publishRange', dates: [fridayDate] })).ok, 'publish Tebeen');
      const pub = await fetch(`${BASE_URL}/?region=tebeen&date=${fridayDate}`).then(r => r.json());
      assert(pub.data.rows.length === 1 && pub.data.rows[0].khatib === 'خطيب التبين', 'public Tebeen contains only Tebeen data');
      assert((await tebeen({ action: 'deactivateKhatib', id: 'K001' })).ok, 'deactivate Tebeen khatib');
      assert((await tebeen({ action: 'deactivateMosque', id: 'M001' })).ok, 'deactivate Tebeen mosque');
      assert(await readMay() === before, 'May data and publication unchanged after all Tebeen writes');
      assert((await tebeen({ action: 'listMosques' }, 'unknown')).error.code === 'BAD_REQUEST', 'invalid region rejected');
      const worker = (await import('../src/index.js')).default;
      const unavailable = await worker.fetch(new Request(`${BASE_URL}/?region=tebeen`), { DB: {} }, {});
      assert((await unavailable.json()).error.code === 'REGION_UNAVAILABLE', 'missing Tebeen binding never falls back to May');
    }),

    test('Scenario 14: roles and user management', async () => {
      const ipHeaders = { 'CF-Connecting-IP': '198.51.100.140' };
      const loginAs = async (username, password) => {
        const r = await api({ action: 'login', username, password }, ipHeaders);
        assert(r.ok, `login as ${username} must succeed: ${JSON.stringify(r.error)}`);
        return r.data;
      };

      // whoami carries the role
      const me = await api({ action: 'whoami', token });
      assert(me.ok && me.data.role === 'admin', `testadmin must be admin, got ${me.data?.role}`);

      // createUser validation
      const badName = await api({ action: 'createUser', token, username: 'ab', displayName: 'x', password: 'longenough1', role: 'viewer' });
      assert(badName.error?.code === 'BAD_REQUEST', 'short username rejected');
      const badRole = await api({ action: 'createUser', token, username: 'someone', displayName: 'x', password: 'longenough1', role: 'root' });
      assert(badRole.error?.code === 'BAD_REQUEST', 'unknown role rejected');
      const shortPw = await api({ action: 'createUser', token, username: 'someone', displayName: 'x', password: 'short', role: 'viewer' });
      assert(shortPw.error?.code === 'BAD_REQUEST', 'short password rejected');

      for (const u of [
        { username: 'coord1', displayName: 'منسق', password: 'coordpass1', role: 'coordinator' },
        { username: 'view1', displayName: 'مشاهد', password: 'viewpass1', role: 'viewer' },
        { username: 'admin2', displayName: 'مدير تاني', password: 'adminpass2', role: 'admin' },
      ]) {
        const r = await api({ action: 'createUser', token, ...u });
        assert(r.ok, `createUser ${u.username} must succeed: ${JSON.stringify(r.error)}`);
      }
      const dup = await api({ action: 'createUser', token, username: 'COORD1', displayName: 'x', password: 'longenough1', role: 'viewer' });
      assert(dup.error?.code === 'DUPLICATE', `case-insensitive duplicate must be DUPLICATE, got ${dup.error?.code}`);

      const list = await api({ action: 'listUsers', token });
      assert(list.ok && list.data.users.length >= 4, 'listUsers returns users');
      assert(list.data.users.every(u => !('password_hash' in u) && !('salt' in u) && !('passwordHash' in u)), 'listUsers must not leak hashes');

      // coordinator: can write schedule data, cannot manage users
      const coord = await loginAs('coord1', 'coordpass1');
      assert(coord.role === 'coordinator', 'login returns role');
      const coordGen = await api({ action: 'generateDate', token: coord.token, date: fridayDate });
      assert(coordGen.ok, `coordinator may call generateDate: ${JSON.stringify(coordGen.error)}`);
      const coordUsers = await api({ action: 'listUsers', token: coord.token });
      assert(coordUsers.error?.code === 'FORBIDDEN', 'coordinator cannot list users');

      // viewer: read only
      const viewer = await loginAs('view1', 'viewpass1');
      const vRead = await api({ action: 'listMosques', token: viewer.token });
      assert(vRead.ok, 'viewer can read');
      for (const action of ['generateDate', 'saveSchedule', 'publishRange', 'createMosque', 'setPreferences', 'createUser', 'someFutureAction']) {
        const r = await api({ action, token: viewer.token, date: fridayDate });
        assert(r.error?.code === 'FORBIDDEN', `viewer ${action} must be FORBIDDEN, got ${JSON.stringify(r)}`);
      }
      const vPw = await api({ action: 'changePassword', token: viewer.token, currentPassword: 'wrong-one', newPassword: 'whatever123' });
      assert(vPw.error?.code === 'BAD_PASSWORD', 'viewer may use changePassword');

      // self-protection
      const selfDemote = await api({ action: 'updateUser', token, username: 'testadmin', displayName: 'أدمن التجربة', role: 'viewer', active: true });
      assert(selfDemote.error?.code === 'BAD_REQUEST', 'cannot change own role');
      const selfOff = await api({ action: 'updateUser', token, username: 'testadmin', displayName: 'أدمن التجربة', role: 'admin', active: false });
      assert(selfOff.error?.code === 'BAD_REQUEST', 'cannot deactivate self');
      const selfReset = await api({ action: 'resetUserPassword', token, username: 'testadmin', newPassword: 'another12345' });
      assert(selfReset.error?.code === 'BAD_REQUEST', 'cannot reset own password here');

      // demote another admin, role takes effect on the existing session
      const admin2 = await loginAs('admin2', 'adminpass2');
      const demote = await api({ action: 'updateUser', token, username: 'admin2', displayName: 'مدير تاني', role: 'viewer', active: true });
      assert(demote.ok, `demote admin2: ${JSON.stringify(demote.error)}`);
      const a2 = await api({ action: 'listUsers', token: admin2.token });
      assert(a2.error?.code === 'FORBIDDEN', 'demoted admin loses access immediately');

      // deactivation logs the user out everywhere
      const off = await api({ action: 'updateUser', token, username: 'view1', displayName: 'مشاهد', role: 'viewer', active: false });
      assert(off.ok, 'deactivate viewer');
      const vAfter = await api({ action: 'whoami', token: viewer.token });
      assert(vAfter.error?.code === 'UNAUTHENTICATED', 'deactivated user session is gone');
      const vLogin = await api({ action: 'login', username: 'view1', password: 'viewpass1' }, ipHeaders);
      assert(!vLogin.ok, 'deactivated user cannot log in');

      // admin password reset kills sessions and the new password works
      const reset = await api({ action: 'resetUserPassword', token, username: 'coord1', newPassword: 'freshpass99' });
      assert(reset.ok, `reset coord1: ${JSON.stringify(reset.error)}`);
      const cAfter = await api({ action: 'whoami', token: coord.token });
      assert(cAfter.error?.code === 'UNAUTHENTICATED', 'reset kills existing sessions');
      await loginAs('coord1', 'freshpass99');
    }),
    test('User regions: create/edit, direct API denial, existing sessions and per-region admin protection', async () => {
      const call = async (region, payload) => fetch(`${BASE_URL}/?region=${region}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      }).then(r => r.json());
      const login = async username => {
        const r = await call('15may', { action: 'login', username, password: 'regionpass123' });
        assert(r.ok, 'regional user can sign in even from the other login page');
        return r.data;
      };
      for (const regionAccess of ['', null, 'unknown', ['both'], true]) {
        const r = await api({ action: 'createUser', token, username: 'badregion', displayName: 'تجربة', role: 'viewer', password: 'regionpass123', regionAccess });
        assert(r.error?.code === 'BAD_REQUEST', 'invalid region access rejected');
      }
      for (const [username, regionAccess, role] of [['rmay', '15may', 'coordinator'], ['rteb', 'tebeen', 'viewer'], ['rboth', 'both', 'coordinator'], ['radmin', 'tebeen', 'admin']]) {
        const r = await api({ action: 'createUser', token, username, regionAccess, role, displayName: username, password: 'regionpass123' });
        assert(r.ok, `create ${regionAccess} account`);
        const u = await login(username);
        assert(u.regionAccess === regionAccess, 'login returns assigned region');
        const me = await call('15may', { action: 'whoami', token: u.token });
        assert(me.data.regionAccess === regionAccess, 'whoami carries live region scope');
        for (const region of ['15may', 'tebeen']) {
          const read = await call(region, { action: 'listMosques', token: u.token });
          assert(regionAccess === 'both' || regionAccess === region ? read.ok : read.error?.code === 'REGION_FORBIDDEN', 'direct API region access enforced');
        }
      }
      const mayUser = await login('rmay');
      for (const action of ['listMosques', 'listKhatibs', 'getSchedule', 'getKhatibSchedule', 'getScheduleHistory', 'getSettings', 'getLoadCounts', 'listDates', 'createMosque', 'updateMosque', 'reorderMosque', 'deactivateMosque', 'createKhatib', 'updateKhatib', 'deactivateKhatib', 'setPreferences', 'generateDate', 'regenerateDate', 'saveSchedule', 'publishRange', 'listUsers', 'createUser', 'updateUser', 'resetUserPassword', 'futureAction']) {
        const r = await call('tebeen', { action, token: mayUser.token, regionAccess: 'both', region: '15may' });
        assert(r.error?.code === 'REGION_FORBIDDEN', `region block precedes payload execution: ${action}`);
      }
      const viewer = await login('rteb');
      assert((await call('tebeen', { action: 'generateDate', token: viewer.token, date: fridayDate })).error?.code === 'FORBIDDEN', 'region scope never grants a stronger role');
      const both = await login('rboth');
      const narrow = await api({ action: 'updateUser', token, username: 'rboth', displayName: 'rboth', role: 'coordinator', active: true, regionAccess: 'tebeen' });
      assert(narrow.ok, 'admin can change region');
      assert((await call('15may', { action: 'listMosques', token: both.token })).error?.code === 'REGION_FORBIDDEN', 'old token loses revoked region immediately');
      assert((await call('tebeen', { action: 'listMosques', token: both.token })).ok, 'same token keeps allowed region');
      const omitted = await api({ action: 'updateUser', token, username: 'rboth', displayName: 'rboth', role: 'coordinator', active: true });
      assert(omitted.ok, 'legacy update preserves region');
      assert((await api({ action: 'whoami', token: both.token })).data.regionAccess === 'tebeen', 'omitted scope does not broaden access');
      const invalidEdit = await api({ action: 'updateUser', token, username: 'rboth', displayName: 'rboth', role: 'coordinator', active: true, regionAccess: '' });
      assert(invalidEdit.error?.code === 'BAD_REQUEST', 'invalid edit region rejected');
      const list = await api({ action: 'listUsers', token });
      assert(list.data.users.find(u => u.username === 'rboth').regionAccess === 'tebeen', 'user list exposes region');
      const admin = await login('radmin');
      const self = await call('tebeen', { action: 'updateUser', token: admin.token, username: 'radmin', displayName: 'radmin', role: 'admin', active: true, regionAccess: 'both' });
      assert(self.error?.code === 'BAD_REQUEST', 'admin cannot broaden their own region');
      const split = await call('tebeen', { action: 'updateUser', token: admin.token, username: 'testadmin', displayName: 'أدمن التجربة', role: 'admin', active: true, regionAccess: '15may' });
      assert(split.ok, 'each region can have its own admin');
      const last = await api({ action: 'updateUser', token, username: 'radmin', displayName: 'radmin', role: 'viewer', active: true, regionAccess: 'tebeen' });
      assert(last.error?.code === 'BAD_REQUEST', 'last admin of a region cannot be removed');
      const restore = await call('tebeen', { action: 'updateUser', token: admin.token, username: 'testadmin', displayName: 'أدمن التجربة', role: 'admin', active: true, regionAccess: 'both' });
      assert(restore.ok, 'restore both-region admin');
    }),
    test('Scenario Khatib Portal: phone login, attendance confirmation, excuse, readiness, and schedule reflection', async () => {
      // 0. Ensure K001 and K002 are active and K001 is assigned to M001 on fridayDate
      await api({ action: 'updateKhatib', token, id: 'K001', name: 'أحمد علي', phone: '01011111111', type: 'primary', active: true });
      await api({ action: 'updateKhatib', token, id: 'K002', name: 'محمد حسن', phone: '01022222222', type: 'primary', active: true });
      await api({ action: 'updateMosque', token, id: 'M001', name: 'مسجد النور', mujawra: 'مجاورة 1', active: true });
      const curSched = await api({ action: 'getSchedule', token, date: fridayDate });
      await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: curSched.data.version,
        changes: [
          { mosqueId: 'M001', khatibId: 'K001', status: 'unassigned' },
          { mosqueId: 'M002', khatibId: '', status: 'unassigned' },
          { mosqueId: 'M003', khatibId: '', status: 'unassigned' }
        ]
      });

      // 1. Phone validation & error handling
      const badPhone = await api({ action: 'khatibLogin', phone: '123' });
      assert(badPhone.error?.code === 'BAD_REQUEST', 'short phone rejected');

      const unknownPhone = await api({ action: 'khatibLogin', phone: '01099999999' });
      assert(unknownPhone.error?.code === 'NOT_FOUND', 'unregistered phone returns NOT_FOUND');

      // 2. Successful login for K001 (assigned as permanent khatib of M001)
      const k1 = await api({ action: 'khatibLogin', phone: '01011111111' });
      assert(k1.ok, 'khatib 1 login ok');
      assert(k1.data.token && k1.data.khatib.id === 'K001', 'token and khatib id returned');

      // 3. khatibWhoami
      const who = await api({ action: 'khatibWhoami', token: k1.data.token });
      assert(who.ok && who.data.khatib.name === 'أحمد علي', 'khatibWhoami returns khatib name');

      // 4. khatibGetSchedule for K001 on fridayDate (which was generated in earlier test)
      const sched1 = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: fridayDate });
      assert(sched1.ok, 'khatibGetSchedule ok');
      assert(sched1.data.hasAssignment === true, 'K001 has assignment at M001');
      assert(sched1.data.assignment.mosqueName === 'مسجد النور', 'mosque name is مسجد النور');
      assert(sched1.data.availableDates.length === 1 && sched1.data.availableDates[0] === fridayDate, 'only current sermon is available');

      // Reject direct requests for past/future sermons, for both response types.
      const beforeRejected = await api({ action: 'getSchedule', token, date: pastDate });
      for (const closedDate of [pastDate, datePlus7, addDays(fridayDate, 1)]) {
        const closedRead = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: closedDate });
        assert(closedRead.error?.code === 'SERMON_CLOSED', 'non-current sermon cannot be opened');
        for (const responseType of ['assignment', 'readiness']) {
          const closedWrite = await api({ action: 'khatibRespond', token: k1.data.token, date: closedDate, responseType, status: 'excused' });
          assert(closedWrite.error?.code === 'SERMON_CLOSED', 'non-current sermon cannot be changed');
        }
      }
      const afterRejected = await api({ action: 'getSchedule', token, date: pastDate });
      assert(JSON.stringify(beforeRejected.data) === JSON.stringify(afterRejected.data), 'rejected requests preserve historical data');
      const crossRegion = await fetch(`${BASE_URL}/?region=tebeen`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'khatibWhoami', token: k1.data.token })
      }).then(r => r.json());
      assert(crossRegion.error?.code === 'UNAUTHENTICATED', 'May khatib session cannot access Tebeen');

      // 5. K001 excuses attendance (اعتذار)
      const excuseRes = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'excused'
      });
      assert(excuseRes.ok && excuseRes.data.status === 'excused', 'K001 excused ok');

      // Verify that getSchedule returns status === 'excused' for M001
      const mainSchedAfterExcuse = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Row = mainSchedAfterExcuse.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Row.status === 'excused', 'assignment status is excused in main schedule');

      // 6. K001 re-confirms attendance (تأكيد الحضور)
      const confirmRes = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'confirmed'
      });
      assert(confirmRes.ok && confirmRes.data.status === 'confirmed', 'K001 confirmed ok');
      const mainSchedAfterConfirm = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Row2 = mainSchedAfterConfirm.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Row2.status === 'confirmed', 'assignment status is confirmed in main schedule');

      // 7. Login for K002 (محمد حسن - not assigned to any mosque on fridayDate)
      const k2 = await api({ action: 'khatibLogin', phone: '01022222222' });
      assert(k2.ok, 'khatib 2 login ok');
      const sched2 = await api({ action: 'khatibGetSchedule', token: k2.data.token, date: fridayDate });
      assert(sched2.ok, 'khatib 2 schedule ok');
      assert(sched2.data.hasAssignment === false, 'K002 has no assignment on fridayDate');
      assert(sched2.data.readiness === 'undecided', 'initial readiness is undecided');

      // 8. K002 marks readiness as 'ready' (مستعد للخطابة)
      const readyRes = await api({
        action: 'khatibRespond',
        token: k2.data.token,
        date: fridayDate,
        responseType: 'readiness',
        status: 'ready'
      });
      assert(readyRes.ok && readyRes.data.status === 'ready', 'readiness marked ready');

      // 9. Verify getSchedule returns K002 as ready in khatibReadiness map
      const mainSchedWithReadiness = await api({ action: 'getSchedule', token, date: fridayDate });
      assert(mainSchedWithReadiness.data.khatibReadiness['K002'] === 'ready', 'khatibReadiness exposes K002 as ready');

      // 10. K002 changes mind to 'excused' (معتذر عن هذه الجمعة)
      const excusedReadinessRes = await api({
        action: 'khatibRespond',
        token: k2.data.token,
        date: fridayDate,
        responseType: 'readiness',
        status: 'excused'
      });
      assert(excusedReadinessRes.ok && excusedReadinessRes.data.status === 'excused', 'readiness updated to excused');
      const mainSchedExcused = await api({ action: 'getSchedule', token, date: fridayDate });
      assert(mainSchedExcused.data.khatibReadiness['K002'] === 'excused', 'khatibReadiness reflects excused');
    }),

    test('Scenario 15: Excuse review after confirmation: workflow, pending state, coordinator accept/reject, bypass defense, role/region checks, concurrent requests, stale reassignment conflict, and coordinator reset', async () => {
      // 0. Setup: Ensure K001 is assigned to M001 on fridayDate and confirmed
      const curSched = await api({ action: 'getSchedule', token, date: fridayDate });
      await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: curSched.data.version,
        changes: [
          { mosqueId: 'M001', khatibId: 'K001', status: 'confirmed' }
        ]
      });

      // Login as K001
      const k1 = await api({ action: 'khatibLogin', phone: '01011111111' });
      assert(k1.ok, 'K001 login ok');

      // Verify portal schedule shows confirmed assignment with no pending request
      let portalSched = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: fridayDate });
      assert(portalSched.ok, 'portal schedule ok');
      assert(portalSched.data.assignment.status === 'confirmed', 'assignment is confirmed');
      assert(!portalSched.data.assignment.excuseRequest || portalSched.data.assignment.excuseRequest.status !== 'pending', 'no pending request initially');

      // 1. K001 attempts excuse after confirmation -> Must become a PENDING REQUEST, not immediate excuse
      const excuseAttempt = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'excused',
        notes: 'عذر صحي طارئ'
      });
      assert(excuseAttempt.ok, 'excuse request submitted');
      assert(excuseAttempt.data.pendingReview === true, 'flagged as pending review');
      assert(excuseAttempt.data.status === 'confirmed', 'assignment remains confirmed while pending');
      const reqId = excuseAttempt.data.requestId;
      assert(reqId, 'request ID generated');

      // Main schedule check: assignment is STILL confirmed, but hasPendingExcuse is true
      const mainAfterReq = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Row = mainAfterReq.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Row.status === 'confirmed', 'main schedule assignment status stays confirmed');
      assert(m1Row.hasPendingExcuse === true, 'main schedule row has pending excuse flag');
      assert(m1Row.pendingExcuseRequestId === reqId, 'main schedule row has matching requestId');

      // Portal check: portal reflects pending review
      portalSched = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: fridayDate });
      assert(portalSched.data.assignment.status === 'confirmed', 'portal assignment stays confirmed');
      assert(portalSched.data.assignment.excuseRequest.status === 'pending', 'portal exposes pending request');

      // 2. Concurrent two-submit test: simultaneous repeated requests must be idempotent without duplicate key / internal error
      const [conc1, conc2] = await Promise.all([
        api({ action: 'khatibRespond', token: k1.data.token, date: fridayDate, responseType: 'assignment', status: 'excused' }),
        api({ action: 'khatibRespond', token: k1.data.token, date: fridayDate, responseType: 'assignment', status: 'excused' })
      ]);
      assert(conc1.ok && conc1.data.pendingReview === true, 'concurrent call 1 succeeds with pending status');
      assert(conc2.ok && conc2.data.pendingReview === true, 'concurrent call 2 succeeds with pending status');
      assert(conc1.data.requestId === reqId && conc2.data.requestId === reqId, 'both concurrent requests return existing pending requestId');

      // 3. Bypass defense: K001 calls responseType: 'readiness', status: 'excused' while assignment is confirmed
      const bypassAttempt = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'readiness',
        status: 'excused'
      });
      assert(bypassAttempt.error?.code === 'BAD_REQUEST', 'readiness excuse bypass attempt is rejected');

      // 4. Role check: Viewer cannot review excuse request
      const viewerLogin = await api({ action: 'createUser', token, username: 'testviewer_excuse', displayName: 'مشاهد', password: 'password123', role: 'viewer', regionAccess: 'both' });
      assert(viewerLogin.ok, 'viewer created');
      const viewerAuth = await api({ action: 'login', username: 'testviewer_excuse', password: 'password123' });
      assert(viewerAuth.ok, 'viewer logged in');
      const viewerReview = await api({
        action: 'reviewExcuseRequest',
        token: viewerAuth.data.token,
        requestId: reqId,
        decision: 'accept'
      });
      assert(viewerReview.error?.code === 'FORBIDDEN', 'viewer role forbidden from reviewing excuse request');

      // 5. Region check: Coordinator with Tebeen-only access cannot review in 15may
      const tebeenCoord = await api({ action: 'createUser', token, username: 'coord_tebeen_only', displayName: 'منسق تبين', password: 'password123', role: 'coordinator', regionAccess: 'tebeen' });
      assert(tebeenCoord.ok, 'tebeen coordinator created');
      const tebeenAuth = await api({ action: 'login', username: 'coord_tebeen_only', password: 'password123' });
      assert(tebeenAuth.ok, 'tebeen coord logged in');
      const wrongRegionReview = await fetch(`${BASE_URL}/?region=15may`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reviewExcuseRequest', token: tebeenAuth.data.token, requestId: reqId, decision: 'accept' })
      }).then(r => r.json());
      assert(wrongRegionReview.error?.code === 'REGION_FORBIDDEN', 'cross-region review attempt is rejected');

      // 6. Rejection workflow: Coordinator rejects request
      const rejectRes = await api({
        action: 'reviewExcuseRequest',
        token,
        requestId: reqId,
        decision: 'reject'
      });
      assert(rejectRes.ok, 'review rejection succeeds');
      assert(rejectRes.data.status === 'rejected', 'request status set to rejected');

      // Main schedule check after rejection: remains confirmed, no pending excuse
      const mainAfterReject = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1AfterReject = mainAfterReject.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1AfterReject.status === 'confirmed', 'assignment remains confirmed after rejection');
      assert(m1AfterReject.hasPendingExcuse === false, 'no pending excuse on row after rejection');

      // Portal check: portal reflects rejection
      portalSched = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: fridayDate });
      assert(portalSched.data.assignment.status === 'confirmed', 'portal assignment still confirmed');
      assert(portalSched.data.assignment.excuseRequest.status === 'rejected', 'portal reflects rejected request');

      // 7. Double review prevention: Calling review again on rejected request fails
      const doubleReview = await api({
        action: 'reviewExcuseRequest',
        token,
        requestId: reqId,
        decision: 'accept'
      });
      assert(doubleReview.error?.code === 'ALREADY_REVIEWED', 'already reviewed request cannot be reviewed again');

      // 8. Deterministic stale reassignment defense:
      // K001 submits a new excuse request
      const secondExcuse = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'excused',
        notes: 'عذر ثانٍ'
      });
      assert(secondExcuse.ok, 'second excuse request submitted');
      const reqId2 = secondExcuse.data.requestId;

      // In the meantime, coordinator reassigns M001 to K002
      const curSched2 = await api({ action: 'getSchedule', token, date: fridayDate });
      await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: curSched2.data.version,
        changes: [{ mosqueId: 'M001', khatibId: 'K002', status: 'confirmed' }]
      });

      // Verify that M001 now has K002 and does NOT display K001's pending excuse badge
      const schedAfterReassign = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1AfterReassign = schedAfterReassign.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1AfterReassign.khatibId === 'K002', 'M001 is now assigned to K002');
      assert(m1AfterReassign.hasPendingExcuse === false, 'stale excuse request is NOT attached to replacement khatib row');

      // Coordinator accepts the old request reqId2 for K001 -> MUST return explicit STALE_REQUEST conflict error!
      const reviewStale = await api({
        action: 'reviewExcuseRequest',
        token,
        requestId: reqId2,
        decision: 'accept'
      });
      assert(reviewStale.error?.code === 'STALE_REQUEST', 'stale reassigned request accept returns explicit STALE_REQUEST conflict');

      // Rejecting the old request reqId2 MUST also return explicit STALE_REQUEST conflict error!
      const reviewStaleReject = await api({
        action: 'reviewExcuseRequest',
        token,
        requestId: reqId2,
        decision: 'reject'
      });
      assert(reviewStaleReject.error?.code === 'STALE_REQUEST', 'stale reassigned request reject returns explicit STALE_REQUEST conflict');

      // Verify M001 assignment for K002 is completely untouched!
      const mainAfterStale = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Stale = mainAfterStale.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Stale.khatibId === 'K002' && m1Stale.status === 'confirmed', 'replacement khatib K002 untouched and confirmed');

      // 9. Clean accept workflow:
      // Reassign K001 to M001 and confirm
      const curSched3 = await api({ action: 'getSchedule', token, date: fridayDate });
      await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: curSched3.data.version,
        changes: [{ mosqueId: 'M001', khatibId: 'K001', status: 'confirmed' }]
      });

      // K001 submits excuse request
      const thirdExcuse = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'excused'
      });
      assert(thirdExcuse.ok, 'third excuse request submitted');
      const reqId3 = thirdExcuse.data.requestId;

      // Coordinator accepts request
      const acceptRes = await api({
        action: 'reviewExcuseRequest',
        token,
        requestId: reqId3,
        decision: 'accept'
      });
      assert(acceptRes.ok, 'review acceptance succeeds');
      assert(acceptRes.data.status === 'accepted', 'request status is accepted');
      assert(acceptRes.data.assignmentModified === true, 'assignment modified to excused');

      // Verify main schedule: M001 is now excused!
      const mainAfterAccept = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Accepted = mainAfterAccept.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Accepted.status === 'excused', 'assignment is excused in main schedule');
      assert(mainAfterAccept.data.khatibReadiness['K001'] === 'excused', 'weekly readiness synchronized to excused');

      // 10. Self-reconfirmation prevention while in accepted excuse cycle:
      // K001 tries to re-confirm via portal -> Forbidden
      const undoAttempt = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'confirmed'
      });
      assert(undoAttempt.error?.code === 'FORBIDDEN', 'self-reconfirmation after accepted excuse is blocked');

      const undoReadinessAttempt = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'readiness',
        status: 'ready'
      });
      assert(undoReadinessAttempt.error?.code === 'FORBIDDEN', 'readiness self-reconfirmation after accepted excuse is blocked');

      // 11. Regression: Coordinator resets assignment to unassigned -> Portal confirmation succeeds!
      const curSched4 = await api({ action: 'getSchedule', token, date: fridayDate });
      const resetRes = await api({
        action: 'saveSchedule',
        token,
        date: fridayDate,
        version: curSched4.data.version,
        changes: [{ mosqueId: 'M001', khatibId: 'K001', status: 'unassigned' }]
      });
      assert(resetRes.ok, 'coordinator reset to unassigned succeeds');

      // Portal schedule now shows unassigned without being locked by accepted excuse
      portalSched = await api({ action: 'khatibGetSchedule', token: k1.data.token, date: fridayDate });
      assert(portalSched.data.assignment.status === 'unassigned', 'portal assignment shows unassigned after reset');
      assert(!portalSched.data.assignment.excuseRequest, 'excuseRequest is not active/locking after reset');

      // Khatib re-confirms attendance from portal -> SUCCEEDS!
      const reConfirmRes = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'confirmed'
      });
      assert(reConfirmRes.ok && reConfirmRes.data.status === 'confirmed', 'portal confirmation succeeds after coordinator reset');

      const mainAfterReconfirm = await api({ action: 'getSchedule', token, date: fridayDate });
      const m1Reconfirmed = mainAfterReconfirm.data.rows.find(r => r.mosqueId === 'M001');
      assert(m1Reconfirmed.status === 'confirmed', 'assignment is confirmed after portal reply');

      // Idempotent confirmation: Confirming already confirmed assignment must not advance version
      const vBefore = (await api({ action: 'getSchedule', token, date: fridayDate })).data.rows.find(r => r.mosqueId === 'M001').updatedAt;
      const reConfirmIdempotent = await api({
        action: 'khatibRespond',
        token: k1.data.token,
        date: fridayDate,
        responseType: 'assignment',
        status: 'confirmed'
      });
      assert(reConfirmIdempotent.ok, 'idempotent confirmation succeeds');
      const vAfter = (await api({ action: 'getSchedule', token, date: fridayDate })).data.rows.find(r => r.mosqueId === 'M001').updatedAt;
      assert(vBefore === vAfter, 'confirming already confirmed assignment does not advance updatedAt version');
    }),
    test('Scenario 16: Forward migration preserves populated legacy schema with 0 lost records and enforces partial index constraints', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const nodeAssert = await import('node:assert/strict');
      const fs = await import('node:fs');
      const path = await import('node:path');

      const dbMem = new DatabaseSync(':memory:');
      const schemaPath = path.resolve(workerDir, 'schema.sql');
      const schemaText = fs.readFileSync(schemaPath, 'utf8');
      const legacySchema = schemaText.split('-- 11. طلبات مراجعة الاعتذار')[0];
      dbMem.exec(legacySchema);

      // Populate populated legacy records across all existing tables
      dbMem.exec(`
        INSERT INTO users (username, display_name, password_hash, salt, active, created_at, role, region_access)
        VALUES ('legacy_admin', 'أدمن سابق', 'hash123', 'salt123', 1, '2026-09-01T00:00:00Z', 'admin', 'both');
        INSERT INTO mosques (id, name, mujawra, address, permanent_khatib_id, active, created_at, sort_order)
        VALUES ('M100', 'مسجد قديم', 'مجاورة 10', 'شارع قديم', 'K100', 1, '2026-09-01T00:00:00Z', 1);
        INSERT INTO khatibs (id, name, phone, type, notes, active, created_at)
        VALUES ('K100', 'خطيب قديم', '01099887766', 'primary', 'ملاحظة', 1, '2026-09-01T00:00:00Z');
        INSERT INTO assignments (id, date, mosque_id, khatib_id, status, date_type, label, updated_by, updated_at)
        VALUES ('2026-10-23_M100', '2026-10-23', 'M100', 'K100', 'confirmed', 'friday', '', 'legacy_admin', '2026-09-01T00:00:00Z');
        INSERT INTO khatib_readiness (date, khatib_id, status, updated_at)
        VALUES ('2026-10-23', 'K100', 'ready', '2026-09-01T00:00:00Z');
        INSERT INTO settings (key, value) VALUES ('legacy_key', 'legacy_val');
      `);

      const usersBefore = dbMem.prepare('SELECT * FROM users').all();
      const mosquesBefore = dbMem.prepare('SELECT * FROM mosques').all();
      const khatibsBefore = dbMem.prepare('SELECT * FROM khatibs').all();
      const assignmentsBefore = dbMem.prepare('SELECT * FROM assignments').all();
      const readinessBefore = dbMem.prepare('SELECT * FROM khatib_readiness').all();
      const settingsBefore = dbMem.prepare('SELECT * FROM settings').all();

      // Apply migration 0005_excuse_requests.sql
      const migrationPath = path.resolve(workerDir, 'migrations', '0005_excuse_requests.sql');
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      dbMem.exec(migrationSql);

      // Verify all legacy rows preserved with 0 lost records (real deep strict equality)
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM users').all(), usersBefore);
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM mosques').all(), mosquesBefore);
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM khatibs').all(), khatibsBefore);
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM assignments').all(), assignmentsBefore);
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM khatib_readiness').all(), readinessBefore);
      nodeAssert.deepStrictEqual(dbMem.prepare('SELECT * FROM settings').all(), settingsBefore);

      // Verify excuse_requests table is created and operational
      dbMem.exec(`
        INSERT INTO excuse_requests (id, date, mosque_id, khatib_id, assignment_version, status, notes, created_at)
        VALUES ('REQ_MIG_1', '2026-10-23', 'M100', 'K100', '2026-09-01T00:00:00Z', 'pending', 'طلب بعد الترقية', '2026-10-22T00:00:00Z');
      `);
      const req = dbMem.prepare('SELECT * FROM excuse_requests WHERE id = ?').get('REQ_MIG_1');
      assert(req.id === 'REQ_MIG_1', 'req id matches');
      assert(req.status === 'pending', 'req status is pending');
      assert(req.assignment_version === '2026-09-01T00:00:00Z', 'assignment_version preserved');

      // Verify partial unique index blocks duplicate pending requests
      let blockedDuplicate = false;
      try {
        dbMem.exec(`
          INSERT INTO excuse_requests (id, date, mosque_id, khatib_id, assignment_version, status, notes, created_at)
          VALUES ('REQ_MIG_2', '2026-10-23', 'M100', 'K100', '2026-09-01T00:00:00Z', 'pending', 'طلب مكرر', '2026-10-22T00:05:00Z');
        `);
      } catch (err) {
        blockedDuplicate = true;
        assert(err.message.includes('UNIQUE'), 'partial index enforces uniqueness');
      }
      assert(blockedDuplicate, 'duplicate pending request was blocked by database index');
    }),
    test('Scenario 17: Deterministic concurrency, barrier interleavings, and atomic CAS race defenses on real handler', async () => {
      const { DatabaseSync } = await import('node:sqlite');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { khatibRespond_, currentSermonDate_ } = await import('../src/khatib-portal.js');

      const schemaPath = path.resolve(workerDir, 'schema.sql');
      const schemaText = fs.readFileSync(schemaPath, 'utf8');

      function setupDb() {
        const s = new DatabaseSync(':memory:');
        s.exec(schemaText);
        const date = currentSermonDate_();
        s.prepare('INSERT INTO khatibs(id,name,phone,type,active,created_at) VALUES (?,?,?,?,?,?)').run('K1','خطيب 1','01012345678','primary',1,'2026-01-01');
        s.prepare('INSERT INTO khatibs(id,name,phone,type,active,created_at) VALUES (?,?,?,?,?,?)').run('K2','خطيب 2','01098765432','primary',1,'2026-01-01');
        s.prepare('INSERT INTO mosques(id,name,mujawra,active,created_at,sort_order) VALUES (?,?,?,?,?,?)').run('M1','مسجد التجربة','Area',1,'2026-01-01',1);
        s.prepare('INSERT INTO khatib_sessions(token,khatib_id,phone,expires_at) VALUES (?,?,?,?)').run('review-token','K1','01012345678','2099-01-01');
        return { s, date, assignId: date + '_M1' };
      }

      function makeAdapter(s, onFirst) {
        return {
          prepare(sql) {
            let binds = [];
            return {
              bind(...args) { binds = args; return this; },
              async first() {
                const row = s.prepare(sql).get(...binds);
                if (onFirst) {
                  onFirst(sql, binds, row);
                }
                return row || null;
              },
              async all() { return { results: s.prepare(sql).all(...binds) }; },
              async run() {
                const meta = s.prepare(sql).run(...binds);
                return { success: true, meta: { changes: meta.changes } };
              }
            };
          },
          async batch(stmts) {
            s.exec('BEGIN');
            try {
              let res = [];
              for (const stmt of stmts) res.push(await stmt.run());
              s.exec('COMMIT');
              return res;
            } catch (e) {
              s.exec('ROLLBACK');
              throw e;
            }
          }
        };
      }

      // Case 1: Interleaved concurrent acceptance during idempotent confirmation (Reviewer reproducer)
      {
        const { s, date, assignId } = setupDb();
        s.prepare('INSERT INTO assignments(id,date,mosque_id,khatib_id,status,date_type,label,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(assignId,date,'M1','K1','confirmed','friday','','admin','v1');
        s.prepare('INSERT INTO khatib_readiness(date,khatib_id,status,updated_at) VALUES (?,?,?,?)').run(date,'K1','ready','v1');

        const db = makeAdapter(s, (sql) => {
          if (/SELECT id, mosque_id, status, updated_at FROM assignments/.test(sql)) {
            s.prepare('UPDATE assignments SET status=?,updated_at=? WHERE id=?').run('excused','v2',assignId);
            s.prepare('UPDATE khatib_readiness SET status=?,updated_at=? WHERE date=? AND khatib_id=?').run('excused','v2',date,'K1');
          }
        });

        const res = await khatibRespond_(db, { token: 'review-token', date, responseType: 'assignment', status: 'confirmed' });
        assert(!res.ok, 'delayed confirm after acceptance returns conflict');
        assert(res.error?.code === 'CONFLICT', 'error code is CONFLICT');
        const readiness = s.prepare('SELECT status FROM khatib_readiness WHERE date=? AND khatib_id=?').get(date, 'K1').status;
        assert(readiness === 'excused', 'readiness is preserved as excused');
      }

      // Case 2: Interleaved concurrent confirmation during delayed initial-excuse
      {
        const { s, date, assignId } = setupDb();
        s.prepare('INSERT INTO assignments(id,date,mosque_id,khatib_id,status,date_type,label,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(assignId,date,'M1','K1','unassigned','friday','','admin','v1');

        const db = makeAdapter(s, (sql) => {
          if (/SELECT id, mosque_id, status, updated_at FROM assignments/.test(sql)) {
            s.prepare('UPDATE assignments SET status=?,updated_at=? WHERE id=?').run('confirmed','v2',assignId);
            s.prepare('INSERT INTO khatib_readiness(date,khatib_id,status,updated_at) VALUES (?,?,?,?)').run(date,'K1','ready','v2');
          }
        });

        const res = await khatibRespond_(db, { token: 'review-token', date, responseType: 'assignment', status: 'excused' });
        assert(!res.ok, 'delayed initial-excuse after concurrent confirmation returns conflict');
        assert(res.error?.code === 'CONFLICT', 'error code is CONFLICT');
        const assignStatus = s.prepare('SELECT status FROM assignments WHERE id=?').get(assignId).status;
        assert(assignStatus === 'confirmed', 'assignment stays confirmed without review bypass');
        const readiness = s.prepare('SELECT status FROM khatib_readiness WHERE date=? AND khatib_id=?').get(date, 'K1').status;
        assert(readiness === 'ready', 'readiness remains ready');
      }

      // Case 3: Interleaved reassignment during pending excuse creation
      {
        const { s, date, assignId } = setupDb();
        s.prepare('INSERT INTO assignments(id,date,mosque_id,khatib_id,status,date_type,label,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(assignId,date,'M1','K1','confirmed','friday','','admin','v1');

        const db = makeAdapter(s, (sql) => {
          if (/SELECT id, mosque_id, status, updated_at FROM assignments/.test(sql)) {
            s.prepare('UPDATE assignments SET khatib_id=?,updated_at=? WHERE id=?').run('K2','v2',assignId);
          }
        });

        const res = await khatibRespond_(db, { token: 'review-token', date, responseType: 'assignment', status: 'excused' });
        assert(!res.ok, 'pending creation after reassignment returns conflict');
        assert(res.error?.code === 'CONFLICT', 'error code is CONFLICT');
        const reqCount = s.prepare('SELECT COUNT(*) as count FROM excuse_requests WHERE khatib_id=?').get('K1').count;
        assert(reqCount === 0, 'stale pending request not created');
      }

      // Case 4: Readiness-only excuse attempt with confirmed assignment
      {
        const { s, date, assignId } = setupDb();
        s.prepare('INSERT INTO assignments(id,date,mosque_id,khatib_id,status,date_type,label,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(assignId,date,'M1','K1','confirmed','friday','','admin','v1');

        const db = makeAdapter(s);
        const res = await khatibRespond_(db, { token: 'review-token', date, responseType: 'readiness', status: 'excused' });
        assert(!res.ok, 'readiness excuse rejected when confirmed assignment exists');
        assert(res.error?.code === 'BAD_REQUEST', 'error code is BAD_REQUEST');
        const readyRow = s.prepare('SELECT * FROM khatib_readiness WHERE date=? AND khatib_id=?').get(date, 'K1');
        assert(readyRow === undefined, 'readiness not inserted');
      }

      // Case 5: Idempotent confirmation when assignment is genuinely confirmed and unchanged
      {
        const { s, date, assignId } = setupDb();
        s.prepare('INSERT INTO assignments(id,date,mosque_id,khatib_id,status,date_type,label,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(assignId,date,'M1','K1','confirmed','friday','','admin','v1');
        s.prepare('INSERT INTO khatib_readiness(date,khatib_id,status,updated_at) VALUES (?,?,?,?)').run(date,'K1','ready','v1');

        const db = makeAdapter(s);
        const res = await khatibRespond_(db, { token: 'review-token', date, responseType: 'assignment', status: 'confirmed' });
        assert(res.ok, 'idempotent confirmation succeeds');
        const assignRow = s.prepare('SELECT status, updated_at FROM assignments WHERE id=?').get(assignId);
        assert(assignRow.status === 'confirmed');
        assert(assignRow.updated_at === 'v1', 'assignment version not bumped on idempotent confirmation');
      }
    }),
    test('New assignments await confirmation; regeneration and omitted statuses preserve intent', async () => {
      const date = addDays(fridayDate, 35);
      assert((await api({ action: 'updateMosque', token, id: 'M001', name: 'مسجد النور', mujawra: 'مجاورة 1', active: true, permanentKhatibId: 'K001' })).ok, 'set permanent khatib for test');
      const gen = await api({ action: 'generateDate', token, date });
      assert(gen.ok && gen.data.rows.find(r => r.mosqueId === 'M001').status === 'unassigned', 'generated permanent assignment awaits confirmation');
      const saved = await api({ action: 'saveSchedule', token, date, changes: [{ mosqueId: 'M001', khatibId: 'K002' }] });
      assert(saved.ok && saved.data.rows.find(r => r.mosqueId === 'M001').status === 'unassigned', 'API assignment without status awaits confirmation');
      const confirmed = await api({ action: 'saveSchedule', token, date, changes: [{ mosqueId: 'M001', status: 'confirmed' }] });
      assert(confirmed.ok, 'explicit confirmation accepted');
      const preserved = await api({ action: 'saveSchedule', token, date, changes: [{ mosqueId: 'M001', khatibId: 'K002' }] });
      assert(preserved.data.rows.find(r => r.mosqueId === 'M001').status === 'confirmed', 'unchanged khatib preserves confirmation');
      const replaced = await api({ action: 'saveSchedule', token, date, changes: [{ mosqueId: 'M001', khatibId: 'K001' }] });
      assert(replaced.data.rows.find(r => r.mosqueId === 'M001').status === 'unassigned', 'replacement resets confirmation');
      const reset = await api({ action: 'regenerateDate', token, date, mode: 'reset' });
      assert(reset.ok && reset.data.rows.every(r => r.status === 'unassigned'), 'reset fills permanent khatibs without confirming them');
      await api({ action: 'saveSchedule', token, date, changes: [{ mosqueId: 'M001', khatibId: '' }] });
      const fill = await api({ action: 'regenerateDate', token, date, mode: 'fill' });
      assert(fill.ok && fill.data.rows.find(r => r.mosqueId === 'M001').khatibId === 'K001' && fill.data.rows.find(r => r.mosqueId === 'M001').status === 'unassigned', 'fill restores permanent khatib as pending');
      const created = await api({ action: 'createMosque', token, name: 'مسجد اختبار انتظار التأكيد', mujawra: 'اختبار', permanentKhatibId: 'K002' });
      assert(created.ok, 'new permanent mosque created');
      const added = await api({ action: 'regenerateDate', token, date, mode: 'fill' });
      const addedRow = added.data.rows.find(r => r.khatibId === 'K002');
      assert(added.ok && addedRow && addedRow.status === 'unassigned', 'new mosque added during regeneration awaits confirmation');
    }),
    test('Region-routed khatib availability CRUD isolation and rule preservation on omitted updates', async () => {
      const tebCall = async (payload) => {
        const response = await fetch(`${BASE_URL}/?region=tebeen`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, ...payload }),
        });
        return response.json();
      };

      // 1. Create in May with custom availability [1, 3]
      const mayCreate = await api({
        action: 'createKhatib',
        token,
        name: 'خطيب 15 مايو المستقل',
        phone: '01034567890',
        type: 'primary',
        availability: { mode: 'custom', weeks: [1, 3] },
      });
      assert(mayCreate.ok, `create May khatib with availability: ${JSON.stringify(mayCreate.error)}`);
      const mayId = mayCreate.data.id;

      // 2. Create in Tebeen with custom availability [2, 4, 5]
      const tebCreate = await tebCall({
        action: 'createKhatib',
        name: 'خطيب التبين المستقل',
        phone: '01098765432',
        type: 'volunteer',
        availability: { mode: 'custom', weeks: [2, 4, 5] },
      });
      assert(tebCreate.ok, `create Tebeen khatib with availability: ${JSON.stringify(tebCreate.error)}`);
      const tebId = tebCreate.data.id;

      // 3. Verify regional DB isolation
      const mayList = await api({ action: 'listKhatibs', token, includeInactive: true });
      const mayK = mayList.data.khatibs.find(k => k.id === mayId);
      assert(mayK && mayK.availability.mode === 'custom' && JSON.stringify(mayK.availability.weeks) === '[1,3]', 'May khatib availability isolated in May DB');
      assert(!mayList.data.khatibs.some(k => k.name === 'خطيب التبين المستقل'), 'Tebeen khatib does not appear in May list');

      const tebList = await tebCall({ action: 'listKhatibs', includeInactive: true });
      const tebK = tebList.data.khatibs.find(k => k.id === tebId);
      assert(tebK && tebK.availability.mode === 'custom' && JSON.stringify(tebK.availability.weeks) === '[2,4,5]', 'Tebeen khatib availability isolated in Tebeen DB');
      assert(!tebList.data.khatibs.some(k => k.name === 'خطيب 15 مايو المستقل'), 'May khatib does not appear in Tebeen list');

      // 4. Update in May omitting availability preserves stored rule [1, 3]
      const mayOmittedUpdate = await api({
        action: 'updateKhatib',
        token,
        id: mayId,
        name: 'خطيب 15 مايو المعدل',
        phone: '01034567890',
        type: 'primary',
        notes: 'ملاحظة تحديث قديم',
        active: true,
      });
      assert(mayOmittedUpdate.ok, 'May update omitting availability succeeds');
      const mayAfterOmitted = await api({ action: 'listKhatibs', token, includeInactive: true });
      const mayKAfter = mayAfterOmitted.data.khatibs.find(k => k.id === mayId);
      assert(mayKAfter.name === 'خطيب 15 مايو المعدل', 'name updated in May');
      assert(mayKAfter.notes === 'ملاحظة تحديث قديم', 'notes updated in May');
      assert(mayKAfter.availability.mode === 'custom' && JSON.stringify(mayKAfter.availability.weeks) === '[1,3]', 'omitted availability preserves stored rule in May');

      // 5. Update in Tebeen omitting availability preserves stored rule [2, 4, 5]
      const tebOmittedUpdate = await tebCall({
        action: 'updateKhatib',
        id: tebId,
        name: 'خطيب التبين المعدل',
        phone: '01098765432',
        type: 'volunteer',
        notes: 'ملاحظة تبين قديمة',
        active: true,
      });
      assert(tebOmittedUpdate.ok, 'Tebeen update omitting availability succeeds');
      const tebAfterOmitted = await tebCall({ action: 'listKhatibs', includeInactive: true });
      const tebKAfter = tebAfterOmitted.data.khatibs.find(k => k.id === tebId);
      assert(tebKAfter.name === 'خطيب التبين المعدل', 'name updated in Tebeen');
      assert(tebKAfter.notes === 'ملاحظة تبين قديمة', 'notes updated in Tebeen');
      assert(tebKAfter.availability.mode === 'custom' && JSON.stringify(tebKAfter.availability.weeks) === '[2,4,5]', 'omitted availability preserves stored rule in Tebeen');

      // 6. Rejected updates (null availability or malformed weeks) return BAD_REQUEST and preserve stored rule
      const badNull = await api({ action: 'updateKhatib', token, id: mayId, name: 'تحديث لاغي', availability: null });
      assert(badNull.error?.code === 'BAD_REQUEST', 'null availability rejected on update');
      const badWeeks = await tebCall({ action: 'updateKhatib', id: tebId, name: 'تحديث لاغي', availability: { mode: 'custom', weeks: [0, 8] } });
      assert(badWeeks.error?.code === 'BAD_REQUEST', 'malformed weeks rejected on update');

      const mayCheck = (await api({ action: 'listKhatibs', token, includeInactive: true })).data.khatibs.find(k => k.id === mayId);
      assert(mayCheck.availability.mode === 'custom' && JSON.stringify(mayCheck.availability.weeks) === '[1,3]', 'rejected update preserved May rule');

      const tebCheck = (await tebCall({ action: 'listKhatibs', includeInactive: true })).data.khatibs.find(k => k.id === tebId);
      assert(tebCheck.availability.mode === 'custom' && JSON.stringify(tebCheck.availability.weeks) === '[2,4,5]', 'rejected update preserved Tebeen rule');

      // 7. Verify weekly schedule assignment statuses remain unchanged
      const currentSched = await api({ action: 'getSchedule', token, date: fridayDate });
      assert(currentSched.ok, 'weekly schedule remains readable and valid');
    }),
    test('Mosque manager account, schedule, Telegram linking, reset and admin reset', async () => {
      const phone = '01033334444';
      const otherPhone = '01033335555';
      assert((await api({ action: 'updateMosque', token, id: 'M001', name: 'مسجد النور', mujawra: 'مجاورة 1', managerPhone: '+201033334444', permanentKhatibId: 'K001' })).ok, 'save manager phone');
      assert((await api({ action: 'updateMosque', token, id: 'M002', name: 'مسجد التقوى', mujawra: 'مجاورة 2', managerPhone: phone })).ok, 'same manager can manage multiple mosques');
      assert((await api({ action: 'updateMosque', token, id: 'M003', name: 'مسجد الإيمان', mujawra: 'مجاورة 3', managerPhone: '123' })).error?.code === 'BAD_REQUEST', 'invalid manager phone rejected');
      assert((await api({ action: 'updateMosque', token, id: 'M003', name: 'مسجد الإيمان', mujawra: 'مجاورة 3', managerPhone: otherPhone })).ok, 'other manager');
      const list = await api({ action: 'listMosques', token });
      assert(list.data.mosques.find(m => m.id === 'M001').managerPhone === phone, 'listed manager phone normalized');
      assert(list.data.mosques.find(m => m.id === 'M001').managerHasPassword === false, 'listed setup status');
      assert((await api({ action: 'mosquePhoneCheck', phone })).data.status === 'needs_setup', 'phone needs setup');
      assert((await api({ action: 'mosquePhoneCheck', phone: '01099999999' })).error?.code === 'NOT_FOUND', 'unknown manager');
      assert((await api({ action: 'mosqueSetPassword', phone, password: 'short' })).error?.code === 'BAD_REQUEST', 'password minimum');
      const setup = await api({ action: 'mosqueSetPassword', phone, password: 'managerpass1' });
      assert(setup.ok && setup.data.mosques.length === 2, 'first password setup');
      assert((await api({ action: 'mosqueSetPassword', phone, password: 'managerpass2' })).error?.code === 'ALREADY_SET', 'second setup rejected');
      assert((await api({ action: 'mosquePhoneCheck', phone })).data.status === 'has_password', 'phone has password');
      assert((await api({ action: 'mosqueLogin', phone, password: 'wrong' })).error?.code === 'BAD_CREDENTIALS', 'bad login');
      const login = await api({ action: 'mosqueLogin', phone, password: 'managerpass1' });
      assert(login.ok, 'manager login');
      assert((await api({ action: 'mosqueWhoami', token: login.data.token })).data.mosques.length === 2, 'whoami');
      const schedule = await api({ action: 'mosqueGetSchedule', token: login.data.token });
      assert(schedule.ok && schedule.data.date === fridayDate && schedule.data.mosques.length === 2, 'only manager mosques in schedule');
      assert(schedule.data.mosques.find(m => m.mosqueId === 'M002').khatib === null, 'unassigned khatib null');
      assert(!schedule.data.mosques.some(m => m.mosqueId === 'M003'), 'other manager mosque hidden');
      const assigned = schedule.data.mosques.find(m => m.mosqueId === 'M001');
      assert(assigned.khatib?.name && assigned.khatib?.phone === '01011111111', 'assigned khatib name and phone');
      assert((await api({ action: 'mosqueRequestReset', phone })).error?.code === 'TELEGRAM_NOT_LINKED', 'unlinked reset');
      const webhook = (secret, contact) => fetch(`${BASE_URL}/telegram-webhook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
        body: JSON.stringify({ message: { from: { id: 123 }, chat: { id: 456 }, contact } })
      });
      await webhook('bad-secret', { user_id: 123, phone_number: '+201033334444' });
      await webhook('test-secret', { user_id: 999, phone_number: '+201033334444' });
      assert((await api({ action: 'mosquePhoneCheck', phone })).data.telegramLinked === false, 'invalid webhook not linked');
      assert((await webhook('test-secret', { user_id: 123, phone_number: '+201033334444' })).status === 200, 'valid webhook accepted');
      assert((await api({ action: 'mosquePhoneCheck', phone })).data.telegramLinked === true, 'contact linked');
      assert((await api({ action: 'listMosques', token })).data.mosques.find(m => m.id === 'M001').managerTelegramLinked, 'admin sees Telegram status');
      const sent = await api({ action: 'mosqueRequestReset', phone });
      assert(sent.ok && sent.data.sent, 'reset code sent');
      const code = telegramMessages.at(-1).text.match(/\b\d{6}\b/)[0];
      assert((await api({ action: 'mosqueConfirmReset', phone, code: '000000', password: 'newmanager1' })).error?.code === 'BAD_CODE', 'wrong reset code');
      const reset = await api({ action: 'mosqueConfirmReset', phone, code, password: 'newmanager1' });
      assert(reset.ok, 'correct reset code');
      assert((await api({ action: 'mosqueWhoami', token: login.data.token })).error?.code === 'UNAUTHENTICATED', 'old session killed');
      assert((await api({ action: 'mosqueConfirmReset', phone, code, password: 'newmanager2' })).error?.code === 'BAD_CODE', 'code single use');
      assert((await api({ action: 'resetMosquePassword', token, phone })).ok, 'admin reset');
      assert((await api({ action: 'mosqueWhoami', token: reset.data.token })).error?.code === 'UNAUTHENTICATED', 'admin reset kills sessions');
      assert((await api({ action: 'mosquePhoneCheck', phone })).data.status === 'needs_setup', 'admin reset clears password');
      assert((await api({ action: 'mosqueRequestReset', phone })).ok, 'linked manager can request after admin reset');
      d1Query(`UPDATE mosque_reset_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE phone = '${phone}'`);
      const expiredCode = telegramMessages.at(-1).text.match(/\b\d{6}\b/)[0];
      assert((await api({ action: 'mosqueConfirmReset', phone, code: expiredCode, password: 'anotherpass1' })).error?.code === 'BAD_CODE', 'expired reset code rejected');
      const reSetup = await api({ action: 'mosqueSetPassword', phone, password: 'anotherpass1' });
      assert(reSetup.ok, 'setup after admin reset');
      await api({ action: 'mosqueLogout', token: reSetup.data.token });
      assert((await api({ action: 'mosqueWhoami', token: reSetup.data.token })).error?.code === 'UNAUTHENTICATED', 'logout invalidates session');
      const loginCodes = [];
      for (let i = 0; i < 6; i++) loginCodes.push((await api({ action: 'mosqueLogin', phone: otherPhone, password: 'wrong' })).error?.code);
      assert(loginCodes.includes('BAD_CREDENTIALS') && loginCodes.at(-1) === 'RATE_LIMITED', 'wrong passwords are rate limited');
      assert((await api({ action: 'updateMosque', token, id: 'M001', name: 'مسجد النور', mujawra: 'مجاورة 1', managerPhone: '' })).ok, 'remove manager from first mosque');
      assert((await api({ action: 'updateMosque', token, id: 'M002', name: 'مسجد التقوى', mujawra: 'مجاورة 2', managerPhone: '' })).ok, 'remove manager from second mosque');
      assert((await api({ action: 'mosqueWhoami', token: setup.data.token })).error?.code === 'UNAUTHENTICATED', 'session stops when no active mosque has phone');
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
