const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const KhatibStatus = require(path.join(root, 'assets/khatib-status.js'));

console.log('--- اختبارات حالات وجاهزية الخطباء والتقارير ---');

// =========================================================================
// 1. Read-Only Status & Unknown != Unavailable
// =========================================================================
{
  const khatib = { id: 'K1', name: 'الشيخ أحمد', phone: '01000000001', type: 'primary', active: 1 };

  // Explicit ready reply
  const readySched = { date: '2026-10-23', rows: [], khatibReadiness: { K1: 'ready' } };
  const readyState = KhatibStatus.resolveKhatibState(khatib, readySched);
  assert.equal(readyState.statusKey, 'ready');
  assert.equal(readyState.statusLabel, 'مستعد');
  assert(readyState.statusBadgeHtml.includes('مستعد'));
  assert.equal(readyState.exportStatusText, 'مستعد');

  // Explicit excused reply in readiness
  const excusedSched = { date: '2026-10-23', rows: [], khatibReadiness: { K1: 'excused' } };
  const excusedState = KhatibStatus.resolveKhatibState(khatib, excusedSched);
  assert.equal(excusedState.statusKey, 'excused');
  assert.equal(excusedState.statusLabel, 'معتذر');
  assert(excusedState.statusBadgeHtml.includes('معتذر'));

  // Unknown / no reply: undefined, empty string, or undecided
  for (const emptyReadiness of [undefined, '', 'undecided']) {
    const noReplySched = {
      date: '2026-10-23',
      rows: [],
      khatibReadiness: emptyReadiness !== undefined ? { K1: emptyReadiness } : {}
    };
    const state = KhatibStatus.resolveKhatibState(khatib, noReplySched);
    assert.equal(state.statusKey, 'no_reply', 'empty readiness must be no_reply');
    assert.equal(state.statusLabel, 'لم يرد');
    assert(state.statusBadgeHtml.includes('لم يرد'));
    assert.notEqual(state.statusKey, 'unavailable', 'unknown/no reply MUST NOT equate to unavailable');
    assert.notEqual(state.statusLabel, 'غير متواجد', 'must not label no-reply as unavailable');
  }

  // Structured availability helper: ONLY when provided by helper does unavailable appear
  KhatibStatus.setAvailabilityHelper((k, date) => {
    if (k.id === 'K1' && date === '2026-10-23') return 'unavailable';
    return null;
  });

  // Standing monthly rule mismatch only applies if no explicit current-week reply:
  const unavailSched = { date: '2026-10-23', rows: [], khatibReadiness: {} };
  const unavailState = KhatibStatus.resolveKhatibState(khatib, unavailSched);
  assert.equal(unavailState.statusKey, 'unavailable');
  assert.equal(unavailState.statusLabel, 'غير متواجد');
  assert(unavailState.statusBadgeHtml.includes('غير متواجد'));

  // Precedence tests: current-week explicit response overrides monthly standing schedule
  // 1) Explicit readiness='excused' overrides monthly rule
  const excusedWithHelperSched = { date: '2026-10-23', rows: [], khatibReadiness: { K1: 'excused' } };
  const excusedWithHelperState = KhatibStatus.resolveKhatibState(khatib, excusedWithHelperSched);
  assert.equal(excusedWithHelperState.statusKey, 'excused', 'explicit weekly excuse overrides monthly rule');
  assert.equal(excusedWithHelperState.statusLabel, 'معتذر');

  // 2) Assignment excuse overrides monthly rule
  const assignExcuseWithHelperSched = {
    date: '2026-10-23',
    rows: [{ mosqueId: 'M1', mosque: 'مسجد النور', khatibId: 'K1', status: 'excused' }],
    khatibReadiness: {}
  };
  const assignExcuseWithHelperState = KhatibStatus.resolveKhatibState(khatib, assignExcuseWithHelperSched);
  assert.equal(assignExcuseWithHelperState.statusKey, 'excused', 'explicit assignment excuse overrides monthly rule');
  assert.equal(assignExcuseWithHelperState.statusLabel, 'معتذر');

  // 3) Explicit readiness='ready' overrides monthly rule
  const readyWithHelperSched = { date: '2026-10-23', rows: [], khatibReadiness: { K1: 'ready' } };
  const readyWithHelperState = KhatibStatus.resolveKhatibState(khatib, readyWithHelperSched);
  assert.equal(readyWithHelperState.statusKey, 'ready', 'explicit weekly ready reply overrides monthly rule');
  assert.equal(readyWithHelperState.statusLabel, 'مستعد');

  // Helper error propagation test (no silent catch)
  KhatibStatus.setAvailabilityHelper(() => {
    throw new Error('CALENDAR_SERVICE_FAILURE');
  });
  assert.throws(() => {
    KhatibStatus.resolveKhatibState(khatib, unavailSched);
  }, /CALENDAR_SERVICE_FAILURE/, 'helper error must propagate to callers for proper error UI handling');

  // Reset helper
  KhatibStatus.setAvailabilityHelper(null);
  const resetState = KhatibStatus.resolveKhatibState(khatib, unavailSched);
  assert.equal(resetState.statusKey, 'no_reply', 'after resetting helper, reverts to no_reply');
  assert.equal(resetState.statusLabel, 'لم يرد');

  console.log('PASS 1: read-only status and unknown != unavailable verification');
}

// =========================================================================
// 2. Accepted Excuse vs Readiness & Excuse Mosque Detail Preservation
// =========================================================================
{
  const khatib = { id: 'K2', name: 'الشيخ محمود', phone: '01000000002', type: 'volunteer', active: 1 };

  // Case A: Khatib answered 'ready' in general readiness, but excused from assigned mosque
  const schedWithAcceptedExcuse = {
    date: '2026-10-23',
    rows: [
      { mosqueId: 'M1', mosque: 'مسجد النصر', khatibId: 'K2', status: 'excused' }
    ],
    khatibReadiness: { K2: 'ready' } // General readiness was ready
  };

  const state = KhatibStatus.resolveKhatibState(khatib, schedWithAcceptedExcuse);
  assert.equal(state.statusKey, 'excused', 'excuse on assignment must take precedence over ready readiness');
  assert.equal(state.statusLabel, 'معتذر');
  assert.equal(state.excuseDetail, 'معتذر عن مسجد النصر');
  assert(state.exportStatusText.includes('معتذر') && state.exportStatusText.includes('مسجد النصر'), 'export must include excuse and mosque detail');
  assert.equal(state.isFree, true, 'excused khatib with no active assignment is unassigned/free');

  // Case B: Khatib excused from Mosque 1, then got assigned to Mosque 2 (active confirmed)
  const schedReassigned = {
    date: '2026-10-23',
    rows: [
      { mosqueId: 'M1', mosque: 'مسجد النصر', khatibId: 'K2', status: 'excused' },
      { mosqueId: 'M2', mosque: 'مسجد الفردوس', khatibId: 'K2', status: 'confirmed' }
    ],
    khatibReadiness: { K2: 'ready' }
  };
  const reassignedState = KhatibStatus.resolveKhatibState(khatib, schedReassigned);
  assert.equal(reassignedState.isAssigned, true);
  assert.equal(reassignedState.isFree, false, 'reassigned khatib is not free');
  assert.equal(reassignedState.activeMosque, 'مسجد الفردوس');
  assert.equal(reassignedState.assignmentStatus, 'confirmed');

  console.log('PASS 2: accepted excuse vs readiness and mosque detail preservation');
}

// =========================================================================
// 3. Assignment Context & Pending Assigned Khatibs NOT Counted as Free
// =========================================================================
{
  const kReadyAssigned = { id: 'K1', name: 'الشيخ عادل', type: 'primary', active: 1 };
  const kReadyPending = { id: 'K2', name: 'الشيخ باسم', type: 'volunteer', active: 1 };
  const kReadyFree = { id: 'K3', name: 'الشيخ جميل', type: 'primary', active: 1 };
  const kNoReplyFree = { id: 'K4', name: 'الشيخ شاكر', type: 'volunteer', active: 1 };

  const sched = {
    date: '2026-10-23',
    rows: [
      { mosqueId: 'M1', mosque: 'مسجد النور', khatibId: 'K1', status: 'confirmed' },
      { mosqueId: 'M2', mosque: 'مسجد السلام', khatibId: 'K2', status: 'unassigned' }, // Pending assignment
    ],
    khatibReadiness: {
      K1: 'ready',
      K2: 'ready',
      K3: 'ready',
      K4: 'undecided'
    }
  };

  // K1: Ready + Confirmed
  const s1 = KhatibStatus.resolveKhatibState(kReadyAssigned, sched);
  assert.equal(s1.statusKey, 'ready');
  assert.equal(s1.isAssigned, true);
  assert.equal(s1.isFree, false, 'confirmed assigned khatib cannot be free');
  assert.equal(s1.assignmentContextLabel, 'مسجد النور (مؤكد)');
  assert(!s1.assignmentContextLabel.includes('بديل'), 'assigned ready khatib must NOT be advertised as free replacement');
  assert(!s1.assignmentContextHtml.includes('بديل'));

  // K2: Ready + Pending assignment (status === 'unassigned')
  const s2 = KhatibStatus.resolveKhatibState(kReadyPending, sched);
  assert.equal(s2.statusKey, 'ready');
  assert.equal(s2.isAssigned, true);
  assert.equal(s2.isFree, false, 'CRITICAL: pending assigned khatib must NOT be counted as free');
  assert.equal(s2.assignmentContextLabel, 'مسجد السلام (لم يتم التأكيد)');
  assert(!s2.assignmentContextLabel.includes('بديل'), 'pending assigned khatib must NOT be advertised as free replacement');

  // K3: Ready + Not assigned
  const s3 = KhatibStatus.resolveKhatibState(kReadyFree, sched);
  assert.equal(s3.statusKey, 'ready');
  assert.equal(s3.isAssigned, false);
  assert.equal(s3.isFree, true, 'unassigned ready khatib is free');
  assert(s3.assignmentContextLabel.includes('متاح كبديل'), 'unassigned ready khatib IS advertised as free replacement');
  assert(s3.assignmentContextHtml.includes('badge-volunteer'));

  // K4: No reply + Not assigned
  const s4 = KhatibStatus.resolveKhatibState(kNoReplyFree, sched);
  assert.equal(s4.statusKey, 'no_reply');
  assert.equal(s4.isAssigned, false);
  assert.equal(s4.isFree, true);
  assert.equal(s4.assignmentContextLabel, 'غير مكلف');
  assert(!s4.assignmentContextLabel.includes('بديل'));

  console.log('PASS 3: assignment context and pending assigned khatibs exclusion');
}

// =========================================================================
// 4. Combined Filtering & Export Subsets
// =========================================================================
{
  const testKhatibs = [
    { id: '1', name: 'محمد علي', phone: '01011111111', statusKey: 'ready', type: 'primary', exportStatusText: 'مستعد' },
    { id: '2', name: 'محمد حسن', phone: '01022222222', statusKey: 'excused', type: 'volunteer', exportStatusText: 'معتذر (معتذر عن مسجد التوحيد)' },
    { id: '3', name: 'أحمد محمود', phone: '01033333333', statusKey: 'ready', type: 'primary', exportStatusText: 'مستعد' },
    { id: '4', name: 'إبراهيم سيد', phone: '01044444444', statusKey: 'no_reply', type: 'volunteer', exportStatusText: 'لم يرد' },
  ];

  // A. Filter by status only
  const readyOnly = KhatibStatus.filterKhatibs(testKhatibs, '', 'ready');
  assert.deepEqual(readyOnly.map(k => k.id), ['1', '3']);

  const excusedOnly = KhatibStatus.filterKhatibs(testKhatibs, '', 'excused');
  assert.deepEqual(excusedOnly.map(k => k.id), ['2']);

  const noReplyOnly = KhatibStatus.filterKhatibs(testKhatibs, '', 'no_reply');
  assert.deepEqual(noReplyOnly.map(k => k.id), ['4']);

  // B. Filter by name query only
  const mohameds = KhatibStatus.filterKhatibs(testKhatibs, 'محمد', '');
  assert.deepEqual(mohameds.map(k => k.id), ['1', '2']);

  // C. Combined filter: Name query + status filter
  const mohamedReady = KhatibStatus.filterKhatibs(testKhatibs, 'محمد', 'ready');
  assert.deepEqual(mohamedReady.map(k => k.id), ['1'], 'combined search and status filter intersection');

  const mohamedNoReply = KhatibStatus.filterKhatibs(testKhatibs, 'محمد', 'no_reply');
  assert.deepEqual(mohamedNoReply, [], 'empty when no intersection');

  // D. Export subset contains exact visible rows with read-only status
  const exportRows = mohameds.map(k => [k.name, k.phone, k.type === 'primary' ? 'أساسي' : 'متطوع', k.exportStatusText]);
  assert.equal(exportRows.length, 2);
  assert.deepEqual(exportRows[0], ['محمد علي', '01011111111', 'أساسي', 'مستعد']);
  assert.deepEqual(exportRows[1], ['محمد حسن', '01022222222', 'متطوع', 'معتذر (معتذر عن مسجد التوحيد)']);

  console.log('PASS 4: combined filtering and export subset integrity');
}

// =========================================================================
// 5. Regional Build Paths & Terminology
// =========================================================================
{
  const pages = ['free-khatibs.html', 'khatib-status-report.html'];

  for (const pageName of pages) {
    // 15 May (root dist)
    const mayPath = path.join(root, 'dist', pageName);
    assert(fs.existsSync(mayPath), `dist/${pageName} must exist`);
    const mayHtml = fs.readFileSync(mayPath, 'utf8');
    assert(mayHtml.includes('أوقاف 15 مايو'), `${pageName} root must display 15 May`);
    assert(mayHtml.includes('src="assets/khatib-status.js"'), `${pageName} root loads assets/khatib-status.js`);
    assert(mayHtml.includes('الحالة'), `${pageName} must have column header الحالة`);
    assert(!mayHtml.includes('<div>ملاحظة</div>'), `${pageName} must not have misleading header ملاحظة`);

    // Tebeen (dist/tebeen)
    const tebeenPath = path.join(root, 'dist/tebeen', pageName);
    assert(fs.existsSync(tebeenPath), `dist/tebeen/${pageName} must exist`);
    const tebeenHtml = fs.readFileSync(tebeenPath, 'utf8');
    assert(tebeenHtml.includes('أوقاف التبين'), `${pageName} Tebeen must display Tebeen`);
    assert(!tebeenHtml.includes('15 مايو'), `${pageName} Tebeen must not display 15 May`);
    assert(!tebeenHtml.includes('المجاورة'), `${pageName} Tebeen must not display المجاورة`);
    assert(tebeenHtml.includes('src="../assets/khatib-status.js"'), `${pageName} Tebeen loads ../assets/khatib-status.js`);

    // All local assets referenced in HTML must exist
    for (const match of tebeenHtml.matchAll(/(?:src|href)="(\.\.\/[^"?#]+)/g)) {
      const assetPath = path.resolve(root, 'dist/tebeen', match[1]);
      assert(fs.existsSync(assetPath), `${pageName}: missing local asset in Tebeen: ${match[1]}`);
    }

    // Scripts parse without syntax errors
    for (const match of tebeenHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      new vm.Script(match[1], { filename: `tebeen-${pageName}` });
    }
  }

  // Check asset in dist
  assert(fs.existsSync(path.join(root, 'dist/assets/khatib-status.js')), 'dist/assets/khatib-status.js must exist');

  // Check assignment filter label in khatib-status-report.html
  const reportHtml = fs.readFileSync(path.join(root, 'dist/khatib-status-report.html'), 'utf8');
  assert(reportHtml.includes('<option value="unassigned">غير مكلف</option>'), 'unassigned option must be labeled غير مكلف');
  assert(!reportHtml.includes('غير مكلف (متاح كبديل)'), 'unassigned option must not misleadingly label all as substitutes');

  console.log('PASS 5: regional build paths, asset rewrites, and terminology');
}

// =========================================================================
// 6. End-to-End VM Page Simulation for free-khatibs.html and khatib-status-report.html
// =========================================================================
(async () => {
  // Test free-khatibs.html DOM execution in VM
  {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          value: '',
          textContent: '',
          innerHTML: '',
          style: {},
          classList: { toggle() {}, add() {}, remove() {} },
          addEventListener() {},
          focus() {},
        });
      }
      return nodes.get(id);
    };

    const mockKhatibs = [
      { id: '1', name: 'الشيخ علي', phone: '0101', type: 'primary', active: 1 },
      { id: '2', name: 'الشيخ حسن', phone: '0102', type: 'volunteer', active: 1 },
      { id: '3', name: 'الشيخ يوسف', phone: '0103', type: 'primary', active: 1 },
      { id: '4', name: 'الشيخ عثمان', phone: '0104', type: 'volunteer', active: 1 },
      { id: '5', name: 'الشيخ معطل', phone: '0105', type: 'primary', active: 0 }, // inactive
    ];

    const mockSchedule = {
      exists: true,
      date: '2026-10-23',
      rows: [
        { mosqueId: 'M1', mosque: 'مسجد السلام', khatibId: '1', status: 'confirmed' }, // Ali is confirmed
        { mosqueId: 'M2', mosque: 'مسجد الهدى', khatibId: '2', status: 'unassigned' }, // Hassan is pending
        { mosqueId: 'M3', mosque: 'مسجد النور', khatibId: '3', status: 'excused' }, // Youssef excused from mosque
        // Othman has no assignment
      ],
      khatibReadiness: {
        '1': 'ready',
        '2': 'ready',
        '3': 'ready', // Youssef answered ready, but excused from M3
        '4': 'undecided' // Othman has no reply
      }
    };

    const vmContext = vm.createContext({
      URL, URLSearchParams,
      location: new URL('https://khotba.daaw.dev/free-khatibs?date=2026-10-23'),
      window: { location: new URL('https://khotba.daaw.dev/free-khatibs?date=2026-10-23'), history: { replaceState() {} } },
      document: {
        getElementById: node,
        createElement: tag => ({
          tag, children: [], style: {},
          appendChild(c) { this.children.push(c); },
          addEventListener() {}
        }),
        body: { appendChild() {} },
        head: { appendChild() {} }
      },
      el: node,
      esc: s => String(s || ''),
      formatDate: d => d,
      todayIso: () => '2026-10-23',
      nextFridays: () => ['2026-10-23'],
      requireAuth: async () => true,
      renderNav: () => {},
      appReady: () => {},
      showLoading: () => {},
      showEmpty: (container, msg) => { container.innerHTML = `<div class="empty">${msg}</div>`; },
      showError: () => {},
      matches: (text, q) => String(text || '').includes(q),
      toast: () => {},
      exportTablePrint: () => {},
      exportTableWord: () => {},
      api: async action => {
        if (action === 'listKhatibs') return { khatibs: mockKhatibs };
        if (action === 'getSchedule') return mockSchedule;
        return {};
      }
    });

    // Run shared scripts
    vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), vmContext);
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/khatib-status.js'), 'utf8'), vmContext);

    const freeHtml = fs.readFileSync(path.join(root, 'free-khatibs.html'), 'utf8');
    const freeScript = [...freeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

    vm.runInContext(freeScript, vmContext);

    // Allow async loadData to finish
    await new Promise(resolve => setTimeout(resolve, 50));

    // Ali (1) is confirmed -> excluded
    // Hassan (2) is pending (unassigned status in row) -> excluded (CRITICAL!)
    // Inactive (5) -> excluded
    // Free khatibs must be ONLY Youssef (3) and Othman (4)!
    const freeList = vmContext.allFreeKhatibs;
    assert.equal(freeList.length, 2, 'only unassigned active khatibs must be counted as free');
    const freeIds = freeList.map(k => k.id);
    assert(!freeIds.includes('1'), 'confirmed assigned khatib cannot be in free list');
    assert(!freeIds.includes('2'), 'pending assigned khatib cannot be in free list');
    assert(!freeIds.includes('5'), 'inactive khatib cannot be in free list');
    assert(freeIds.includes('3'), 'excused unassigned khatib is in free list');
    assert(freeIds.includes('4'), 'unassigned no-reply khatib is in free list');

    // Youssef status must be excused with mosque note
    const youssef = freeList.find(k => k.id === '3');
    assert.equal(youssef.statusKey, 'excused');
    assert.equal(youssef.statusLabel, 'معتذر');
    assert.equal(youssef.excuseDetail, 'معتذر عن مسجد النور');

    // Othman status must be no_reply (لم يرد)
    const othman = freeList.find(k => k.id === '4');
    assert.equal(othman.statusKey, 'no_reply');
    assert.equal(othman.statusLabel, 'لم يرد');

    // Verify rendered table contains header 'الحالة' and rendered rows
    assert(node('results').innerHTML.includes('<div>الحالة</div>'));
    assert(node('results').innerHTML.includes('الشيخ يوسف'));
    assert(node('results').innerHTML.includes('الشيخ عثمان'));

    // Verify export data
    const exportData = vmContext.getExportData();
    assert.deepEqual([...exportData.headers], ['الخطيب', 'الموبايل', 'النوع', 'الحالة']);
    assert.equal(exportData.rows.length, 2);
    assert(exportData.rows.some(r => r[0] === 'الشيخ يوسف' && r[3].includes('معتذر')));
    assert(exportData.rows.some(r => r[0] === 'الشيخ عثمان' && r[3] === 'لم يرد'));
  }

  // Test khatib-status-report.html DOM execution in VM
  {
    const nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          value: '',
          textContent: '',
          innerHTML: '',
          style: {},
          classList: { toggle() {}, add() {}, remove() {} },
          addEventListener() {},
          focus() {},
        });
      }
      return nodes.get(id);
    };

    const mockKhatibs = [
      { id: '1', name: 'الشيخ علي', phone: '0101', type: 'primary', active: 1 },
      { id: '2', name: 'الشيخ حسن', phone: '0102', type: 'volunteer', active: 1 },
      { id: '3', name: 'الشيخ يوسف', phone: '0103', type: 'primary', active: 1 },
      { id: '4', name: 'الشيخ عثمان', phone: '0104', type: 'volunteer', active: 1 },
    ];

    const mockSchedule = {
      exists: true,
      date: '2026-10-23',
      rows: [
        { mosqueId: 'M1', mosque: 'مسجد السلام', khatibId: '1', status: 'confirmed' },
        { mosqueId: 'M2', mosque: 'مسجد الهدى', khatibId: '2', status: 'unassigned' },
        { mosqueId: 'M3', mosque: 'مسجد النور', khatibId: '3', status: 'excused' },
      ],
      khatibReadiness: {
        '1': 'ready',
        '2': 'ready',
        '3': 'ready',
        '4': 'ready', // Othman is ready and unassigned!
      }
    };

    const vmContext = vm.createContext({
      URL, URLSearchParams,
      location: new URL('https://khotba.daaw.dev/khatib-status-report?date=2026-10-23'),
      window: { location: new URL('https://khotba.daaw.dev/khatib-status-report?date=2026-10-23'), history: { replaceState() {} } },
      document: {
        getElementById: node,
        createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
        body: { appendChild() {} },
        head: { appendChild() {} }
      },
      el: node,
      esc: s => String(s || ''),
      formatDate: d => d,
      todayIso: () => '2026-10-23',
      nextFridays: () => ['2026-10-23'],
      requireAuth: async () => true,
      renderNav: () => {},
      appReady: () => {},
      showLoading: () => {},
      showEmpty: (container, msg) => { container.innerHTML = `<div class="empty">${msg}</div>`; },
      showError: () => {},
      matches: (text, q) => String(text || '').includes(q),
      toast: () => {},
      exportTablePrint: () => {},
      exportTableWord: () => {},
      api: async action => {
        if (action === 'listKhatibs') return { khatibs: mockKhatibs };
        if (action === 'getSchedule') return mockSchedule;
        return {};
      }
    });

    vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), vmContext);
    vm.runInContext(fs.readFileSync(path.join(root, 'assets/khatib-status.js'), 'utf8'), vmContext);

    const reportHtml = fs.readFileSync(path.join(root, 'khatib-status-report.html'), 'utf8');
    const reportScript = [...reportHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

    vm.runInContext(reportScript, vmContext);

    await new Promise(resolve => setTimeout(resolve, 50));

    // Status report must include ALL 4 active khatibs
    const reports = vmContext.allKhatibReports;
    assert.equal(reports.length, 4, 'report must include all active khatibs');

    // Ali (1): Ready + Assigned Confirmed -> Must NOT be advertised as free replacement
    const rAli = reports.find(k => k.id === '1');
    assert.equal(rAli.statusKey, 'ready');
    assert.equal(rAli.assignmentContextLabel, 'مسجد السلام (مؤكد)');
    assert(!rAli.assignmentContextLabel.includes('بديل'));

    // Hassan (2): Ready + Pending Assigned -> Labeled with mosque, not free replacement
    const rHassan = reports.find(k => k.id === '2');
    assert.equal(rHassan.assignmentContextLabel, 'مسجد الهدى (لم يتم التأكيد)');
    assert(!rHassan.assignmentContextLabel.includes('بديل'));

    // Othman (4): Ready + Unassigned -> Labeled as free replacement
    const rOthman = reports.find(k => k.id === '4');
    assert.equal(rOthman.statusKey, 'ready');
    assert(rOthman.assignmentContextLabel.includes('متاح كبديل'));

    // Export headers and rows
    const exportData = vmContext.getExportData();
    assert.deepEqual([...exportData.headers], ['الخطيب', 'الموبايل', 'النوع', 'الحالة', 'التكليف والمسجد']);
    assert.equal(exportData.rows.length, 4);

    console.log('PASS 6: end-to-end VM DOM simulation for both pages');
  }

  console.log('ALL KHATIB STATUS TESTS PASSED SUCCESSFULLY!');
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
