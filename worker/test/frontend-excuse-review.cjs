const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function createScheduleContext() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        value: '',
        style: {},
        dataset: {},
        classList: { remove() {}, add() {} },
        addEventListener() {},
        querySelectorAll: () => [],
        querySelector: () => null,
        setAttribute() {},
        removeAttribute() {},
      });
    }
    return nodes.get(id);
  };

  const toasts = [];
  const apiCalls = [];
  let apiHandler = async (action, params) => ({
    ok: true,
    khatibs: [],
    mosques: [],
    counts: {},
    dates: [],
    rows: []
  });
  let confirmResult = true;

  const rawContext = {
    REGION_ID: '15may',
    renderNav() {},
    el: node,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener() {},
    },
    setTimeout: (fn, ms) => {
      if (ms === 0 || !ms) fn();
      return 1;
    },
    clearTimeout() {},
    esc: value => String(value || ''),
    canEdit: () => true,
    addEventListener() {},
    confirmBox: msg => confirmResult,
    toast: (msg, type) => {
      toasts.push({ msg, type });
    },
    api: async (action, params) => {
      apiCalls.push({ action, params });
      const res = await apiHandler(action, params);
      if (action === 'listKhatibs' && res && !res.khatibs) return { ...res, khatibs: [] };
      if (action === 'listMosques' && res && !res.mosques) return { ...res, mosques: [] };
      return res;
    },
    matches: (text, query) => String(text || '').includes(query),
    formatDate: value => value,
    nextFridays: () => ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-13'],
    isFriday: () => true,
    appReady() {},
    showLoading() {},
    showError: (el, msg) => { console.log('LOAD ERROR:', msg); },
    render() {},
    renderGenerate() {},
  };
  rawContext.window = rawContext;
  rawContext.globalThis = rawContext;

  const context = vm.createContext(rawContext);

  const html = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  let script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/availability.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/sermon-calendar.js'), 'utf8'), context);
  // Skip page bootstrapping
  script = script.replace(/    \(async function \(\) \{[\s\S]*?    \}\)\(\);/, '');
  vm.runInContext(script, context);

  // Default state initialization
  context.state.date = '2026-10-23';
  context.state.version = 'v1';
  context.state.rows = [
    {
      mosqueId: 'M1',
      mosque: 'مسجد النور',
      khatibId: 'K1',
      khatib: 'الشيخ أحمد',
      status: 'confirmed',
      hasPendingExcuse: true,
      pendingExcuseRequestId: 'req-1',
    },
    {
      mosqueId: 'M2',
      mosque: 'مسجد التقوى',
      khatibId: 'K2',
      khatib: 'الشيخ محمد',
      status: 'unassigned',
    },
  ];
  context.state.khatibs = [
    { id: 'K1', name: 'الشيخ أحمد', availability: { mode: 'all', weeks: [1, 2, 3, 4, 5] } },
    { id: 'K2', name: 'الشيخ محمد', availability: { mode: 'all', weeks: [1, 2, 3, 4, 5] } },
  ];
  context.state.mosques = {
    M1: { id: 'M1', name: 'مسجد النور' },
    M2: { id: 'M2', name: 'مسجد التقوى' },
  };
  context.state.dirty = {};

  return {
    context,
    node,
    toasts,
    apiCalls,
    setApiHandler: fn => { apiHandler = fn; },
    setConfirmResult: val => { confirmResult = val; },
  };
}

(async () => {
  // ── Scenario 1: In-Flight Review Locks Mutations, Navigation & Doubleclick ──
  {
    const env = createScheduleContext();
    let resolveReview;
    const reviewPromise = new Promise(resolve => {
      resolveReview = resolve;
    });

    let reviewCallCount = 0;
    env.setApiHandler(async (action, params) => {
      if (action === 'reviewExcuseRequest') {
        reviewCallCount++;
        return reviewPromise;
      }
      if (action === 'getSchedule') {
        return {
          ok: true,
          version: 'v2',
          exists: true,
          rows: [
            {
              mosqueId: 'M1',
              mosque: 'مسجد النور',
              khatibId: 'K1',
              khatib: 'الشيخ أحمد',
              status: 'excused',
              hasPendingExcuse: false,
            },
          ],
        };
      }
      if (action === 'getLoadCounts') return { counts: {} };
      if (action === 'getScheduleHistory') return { dates: [], rows: [] };
      return { ok: true };
    });

    // Start excuse review in background (delayed API)
    const reviewTask = env.context.reviewExcuse('req-1', 'accept');

    // 1. Double click must be ignored
    const duplicateReviewTask = env.context.reviewExcuse('req-1', 'accept');
    await duplicateReviewTask; // Returns immediately
    assert.equal(reviewCallCount, 1, 'double click should not trigger second review API call');

    // 2. Mutations while review is pending must be refused
    assert.deepEqual(env.context.state.dirty, {});
    env.context.onKhatibChange('M1', 'K2');
    assert.deepEqual(env.context.state.dirty, {}, 'onKhatibChange must refuse while review pending');

    env.context.onStatusChange('M1', 'unassigned');
    assert.deepEqual(env.context.state.dirty, {}, 'onStatusChange must refuse while review pending');

    // 3. Navigation while review is pending must be refused
    const origDate = env.context.state.date;
    await env.context.load('2026-10-30');
    assert.equal(env.context.state.date, origDate, 'load/navigation must refuse while review pending');

    // 4. Resolve the in-flight review
    resolveReview({ ok: true });
    await reviewTask;

    // 5. Assert successful resolution and schedule reload
    assert.equal(env.context.state.version, 'v2', 'schedule was reloaded on successful review');
    const successToast = env.toasts.find(t => t.type === 'ok' && t.msg.includes('قبول'));
    assert(successToast, 'success toast shown after successful review');

    console.log('PASS: in-flight excuse review locks mutations, navigation, double-click and reloads schedule on success');
  }

  // ── Scenario 2: Flush Failure Preserves Prior Unsaved Edits ──
  {
    const env = createScheduleContext();
    env.context.state.dirty = {
      M2: { khatibId: 'K1', status: 'confirmed' },
    };

    let reviewCalled = false;
    env.setApiHandler(async (action, params) => {
      if (action === 'saveSchedule') {
        throw new Error('Save schedule failed due to network error');
      }
      if (action === 'reviewExcuseRequest') {
        reviewCalled = true;
        return { ok: true };
      }
      return { ok: true };
    });

    await env.context.reviewExcuse('req-1', 'accept');

    assert.equal(reviewCalled, false, 'review API must NOT be called if autosave flush fails');
    assert.deepEqual(
      { ...env.context.state.dirty },
      { M2: { khatibId: 'K1', status: 'confirmed' } },
      'prior unsaved edits in state.dirty must be preserved on flush failure'
    );
    const errToast = env.toasts.find(t => t.type === 'err' || t.type === 'warn');
    assert(errToast, 'warning/error toast shown on flush failure');

    console.log('PASS: flush failure halts review and preserves prior unsaved edits');
  }

  // ── Scenario 3: Review API Error Preserves State & Unlocks ──
  {
    const env = createScheduleContext();
    env.context.state.dirty = {
      M1: { khatibId: 'K2', status: 'unassigned' },
    };

    let getScheduleCalled = false;
    env.setApiHandler(async (action, params) => {
      if (action === 'saveSchedule') {
        // Mock flush success
        return { version: 'v2', rows: [] };
      }
      if (action === 'reviewExcuseRequest') {
        throw new Error('Internal Server Error 500');
      }
      if (action === 'getSchedule') {
        getScheduleCalled = true;
        return { ok: true, version: 'v3', rows: [] };
      }
      return { ok: true };
    });

    await env.context.reviewExcuse('req-1', 'reject');

    assert.equal(getScheduleCalled, false, 'load/getSchedule must NOT be called if review API fails');
    const errToast = env.toasts.find(t => t.type === 'err' && t.msg.includes('500'));
    assert(errToast, 'error toast shown when review API throws');

    // Controls must be unlocked afterwards
    env.context.onStatusChange('M2', 'confirmed');
    assert.equal(env.context.state.dirty.M2.status, 'confirmed', 'controls must be unlocked after review failure');

    console.log('PASS: review API error preserves state, prevents reload and unlocks controls');
  }

  // ── Scenario 4: User Cancels Confirmation Dialog ──
  {
    const env = createScheduleContext();
    env.setConfirmResult(false);

    let reviewCalled = false;
    env.setApiHandler(async (action) => {
      if (action === 'reviewExcuseRequest') reviewCalled = true;
      return { ok: true };
    });

    await env.context.reviewExcuse('req-1', 'accept');

    assert.equal(reviewCalled, false, 'review API must NOT be called if user cancels confirm dialog');
    // Verify controls not stuck in locked state
    env.context.onStatusChange('M1', 'excused');
    assert.equal(env.context.state.dirty.M1.status, 'excused', 'controls remain active when confirm is cancelled');

    console.log('PASS: cancel confirm dialog cleanly aborts without locking');
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
