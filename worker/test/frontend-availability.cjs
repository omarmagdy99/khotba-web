const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

console.log('--- اختبارات دمج التوفر الشهري والتقويم الهجري للواجهة الأمامية ---');

// 1. Foundation loader (supports AVAILABILITY_HELPER_PATH env override or local merged asset)
const helperPath = process.env.AVAILABILITY_HELPER_PATH || path.join(root, 'assets/availability.js');
let KhatibAvailability;
if (!fs.existsSync(helperPath)) {
  throw new Error('KhatibAvailability foundation asset not found at: ' + helperPath);
}
KhatibAvailability = require(helperPath);

const SermonCalendar = require(path.join(root, 'assets/sermon-calendar.js'));
SermonCalendar.setFoundation(KhatibAvailability);
const KhatibStatus = require(path.join(root, 'assets/khatib-status.js'));

// =========================================================================
// Scenario 1: Both Calendars (15may & Tebeen) + Special Non-Friday Dates
// =========================================================================
{
  const testFriday = '2026-10-23';

  // 15may: Gregorian date presentation unchanged
  const mayFormatted = SermonCalendar.formatDate(testFriday, '15may');
  assert.equal(mayFormatted, '23 أكتوبر 2026');

  // Tebeen: Hijri date + month + Friday ordinal + Gregorian context
  const tebeenFormatted = SermonCalendar.formatDate(testFriday, 'tebeen');
  assert(tebeenFormatted.includes('الجمعة الثانية'), 'Tebeen Friday must show ordinal: الجمعة الثانية');
  assert(tebeenFormatted.includes('جمادى الأولى'), 'Tebeen Friday must show Hijri month');
  assert(tebeenFormatted.includes('1448'), 'Tebeen Friday must show Hijri year');
  assert(tebeenFormatted.includes('23 أكتوبر 2026'), 'Tebeen Friday must preserve Gregorian context');

  // Special non-Friday date (Wednesday, e.g. historical Eid date 2026-05-27)
  const specialDate = '2026-05-27';
  assert(SermonCalendar.isSpecialDate(specialDate), 'must be identified as special non-Friday date');
  assert(!SermonCalendar.isFriday(specialDate), 'isFriday must return false for Wednesday');

  // Non-Friday MUST NOT throw when formatting in either region
  const specialMay = SermonCalendar.formatDate(specialDate, '15may');
  assert(specialMay.includes('27 مايو 2026'));

  const specialTebeen = SermonCalendar.formatDate(specialDate, 'tebeen');
  assert(specialTebeen.includes('1447'), 'Tebeen special date shows Hijri year');
  assert(specialTebeen.includes('ذو الحجة'), 'Tebeen special date shows Hijri month');
  assert(!specialTebeen.includes('الجمعة'), 'Tebeen special date must NOT include Friday ordinal');
  assert(specialTebeen.includes('27 مايو 2026'), 'Tebeen special date shows Gregorian context');

  // Non-Friday availability check must be neutral/not-applicable and return true without throwing
  const customKhatib = {
    id: 'K1',
    name: 'الشيخ عيسى',
    availability: { mode: 'custom', weeks: [1] } // Only week 1
  };
  assert.equal(SermonCalendar.isKhatibAvailable(customKhatib, specialDate, 'tebeen'), true, 'special date must return true for availability');
  assert.equal(SermonCalendar.isKhatibAvailable(customKhatib, specialDate, '15may'), true, 'special date must return true for availability in 15may');

  console.log('PASS 1: both calendars, Hijri/Gregorian formatting, and non-Friday special dates');
}

// =========================================================================
// Scenario 2: onKhatibChange outside rule — Cancel vs Confirm & Move Safety
// =========================================================================
{
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', style: {}, classList: { remove() {}, add() {} },
      addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };

  let confirmBoxResult = false;
  let confirmBoxPrompt = '';
  let autosaveCalled = false;

  const context = vm.createContext({
    REGION_ID: '15may',
    renderNav() {},
    el: node,
    sessionStorage: { getItem: () => null },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { location: new URL('https://khotba.daaw.dev/schedule'), addEventListener() {} },
    URL, URLSearchParams,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    esc: value => String(value || ''),
    canEdit: () => true,
    matches: (text, query) => String(text || '').includes(query),
    formatDate: value => value,
    KhatibAvailability: KhatibAvailability,
    SermonCalendar: SermonCalendar,
    confirmBox: msg => { confirmBoxPrompt = msg; return confirmBoxResult; }
  });

  const html = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  script = script.replace(/    \(async function \(\) \{[\s\S]*?    \}\)\(\);/, '');
  vm.runInContext(script, context);

  context.scheduleAutosave = () => { autosaveCalled = true; };
  context.renderSaveStatus = () => {};

  // Setup test date: 2026-10-23 is Week 4 of October in 15may
  context.state.date = '2026-10-23';
  context.state.rows = [
    { mosqueId: 'M1', mosque: 'مسجد النصر', khatibId: 'K1', status: 'confirmed' },
    { mosqueId: 'M2', mosque: 'مسجد الهدى', khatibId: '', status: 'unassigned' }
  ];
  // K1 is only available on weeks 1 and 3 (mismatch on week 4!)
  context.state.khatibs = [
    { id: 'K1', name: 'الشيخ منصور', availability: { mode: 'custom', weeks: [1, 3] } }
  ];

  // Case A: User attempts move from M1 to M2, but CANCELS the warning dialog
  confirmBoxResult = false;
  autosaveCalled = false;
  context.state.dirty = {};

  context.onKhatibChange('M2', 'K1');

  assert(confirmBoxPrompt.includes('غير متاح وفق جدول توفره الشهري'), 'must prompt warning on mismatch');
  assert.equal(autosaveCalled, false, 'autosave must NOT be called on cancel');
  assert.deepEqual(context.state.dirty, {}, 'cancellation must leave state.dirty completely untouched');
  assert.equal(context.effective(context.state.rows[0]).khatibId, 'K1', 'source mosque must remain untouched');
  assert.equal(context.effective(context.state.rows[1]).khatibId, '', 'target mosque must remain empty');

  // Case B: User attempts move and CONFIRMS override
  confirmBoxResult = true;
  autosaveCalled = false;

  context.onKhatibChange('M2', 'K1');

  assert.equal(autosaveCalled, true, 'autosave must be scheduled on confirm');
  assert.equal(context.state.dirty.M1.khatibId, '', 'source mosque must be freed in dirty');
  assert.equal(context.state.dirty.M1.status, 'unassigned');
  assert.equal(context.state.dirty.M2.khatibId, 'K1', 'target mosque must receive khatib in dirty');
  assert.equal(context.state.dirty.M2.status, 'unassigned', 'moved assignment must be pending unassigned, NOT auto-confirmed');

  // Case C: Same-mosque no-op: reselecting K1 at M2 should not trigger confirm dialog
  confirmBoxPrompt = '';
  context.onKhatibChange('M2', 'K1');
  assert.equal(confirmBoxPrompt, '', 'same-mosque selection must not trigger confirmation warning');

  console.log('PASS 2: onKhatibChange rule override confirmation, move safety, and dirty protection');
}

// =========================================================================
// Scenario 3: Warnings on Preassigned / Generated Rows & Persistent Banner
// =========================================================================
{
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', style: {}, innerHTML: '', textContent: '', classList: { remove() {}, add() {} },
      addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };

  const context = vm.createContext({
    REGION_ID: '15may',
    renderNav() {},
    el: node,
    sessionStorage: { getItem: () => null },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: { location: new URL('https://khotba.daaw.dev/schedule'), addEventListener() {} },
    URL, URLSearchParams,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    esc: value => String(value || ''),
    canEdit: () => true,
    matches: (text, query) => String(text || '').includes(query),
    formatDate: value => value,
    KhatibAvailability: KhatibAvailability,
    SermonCalendar: SermonCalendar,
  });

  const html = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
  script = script.replace(/    \(async function \(\) \{[\s\S]*?    \}\)\(\);/, '');
  vm.runInContext(script, context);

  // K1: custom rule [1], on 2026-10-23 (week 4) => Mismatch!
  // K1 has explicit weekly readiness = 'ready'
  context.state.date = '2026-10-23';
  context.state.rows = [
    { mosqueId: 'M1', mosque: 'مسجد النصر', khatibId: 'K1', status: 'confirmed' }
  ];
  context.state.khatibs = [
    { id: 'K1', name: 'الشيخ طارق', availability: { mode: 'custom', weeks: [1] } }
  ];
  context.state.khatibReadiness = { K1: 'ready' };

  // Per-row mark check
  const btnHtml = context.khatibButtonHtml(context.state.rows[0], context.state.rows[0]);
  assert(btnHtml.includes('⚠️ غير متاح شهرياً'), 'must display per-row recurrence warning');
  assert(btnHtml.includes('🟢 مستعد أسبوعياً'), 'must display explicit weekly ready response alongside warning');

  // Persistent banner check
  context.updateAvailabilityBanner();
  const banner = node('availabilityBanner');
  assert.equal(banner.style.display, 'block', 'availability banner must be displayed when mismatches exist');
  assert(banner.innerHTML.includes('1'), 'banner must report correct mismatch count');

  // On special date: banner is hidden and no warnings
  context.state.date = '2026-05-27'; // Wednesday
  context.updateAvailabilityBanner();
  assert.equal(banner.style.display, 'none', 'banner must be hidden on special dates');

  console.log('PASS 3: per-row warnings, explicit response badges, and persistent advisory banner');
}

// =========================================================================
// Scenario 4: KhatibStatus.setAvailabilityHelper Hook Precedence & Filter
// =========================================================================
{
  KhatibStatus.setAvailabilityHelper(function (khatib, date) {
    return SermonCalendar.isKhatibAvailable(khatib, date) ? null : 'unavailable';
  });

  const customKhatib = {
    id: 'K9',
    name: 'الشيخ راشد',
    type: 'primary',
    availability: { mode: 'custom', weeks: [1] } // Not available on 2026-10-23 (week 4)
  };

  // Case A: Khatib outside rule who replied with excuse => MUST BE معتذر (excused)
  const schedExcused = {
    date: '2026-10-23',
    rows: [],
    khatibReadiness: { K9: 'excused' }
  };
  const sExcused = KhatibStatus.resolveKhatibState(customKhatib, schedExcused);
  assert.equal(sExcused.statusKey, 'excused', 'explicit weekly excuse overrides monthly rule');
  assert.equal(sExcused.statusLabel, 'معتذر');

  // Case B: Khatib outside rule who replied ready => MUST BE مستعد (ready)
  const schedReady = {
    date: '2026-10-23',
    rows: [],
    khatibReadiness: { K9: 'ready' }
  };
  const sReady = KhatibStatus.resolveKhatibState(customKhatib, schedReady);
  assert.equal(sReady.statusKey, 'ready', 'explicit weekly ready reply overrides monthly rule');
  assert.equal(sReady.statusLabel, 'مستعد');

  // Case C: Khatib outside rule who did NOT reply => MUST BE غير متواجد (unavailable)
  const schedNoReply = {
    date: '2026-10-23',
    rows: [],
    khatibReadiness: { K9: 'undecided' }
  };
  const sNoReply = KhatibStatus.resolveKhatibState(customKhatib, schedNoReply);
  assert.equal(sNoReply.statusKey, 'unavailable', 'unanswered khatib outside monthly rule is unavailable');
  assert.equal(sNoReply.statusLabel, 'غير متواجد');

  // Case D: Khatib INSIDE rule who did NOT reply => MUST BE لم يرد (no_reply)
  const allWeekKhatib = {
    id: 'K10',
    name: 'الشيخ سامر',
    type: 'primary',
    availability: { mode: 'all' }
  };
  const sInsideNoReply = KhatibStatus.resolveKhatibState(allWeekKhatib, schedNoReply);
  assert.equal(sInsideNoReply.statusKey, 'no_reply', 'unanswered khatib inside rule remains no_reply');
  assert.equal(sInsideNoReply.statusLabel, 'لم يرد');

  // Reset helper
  KhatibStatus.setAvailabilityHelper(null);

  console.log('PASS 4: availability helper integration, hook precedence, and unavailable resolution');
}

// =========================================================================
// Scenario 5: Direct Report Link, Validated URL Date, and Main Schedule Export Table
// =========================================================================
{
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', style: {}, innerHTML: '', textContent: '', classList: { remove() {}, add() {} },
      addEventListener() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };

  let navigatedUrl = '';
  const context = vm.createContext({
    REGION_ID: '15may',
    renderNav() {},
    el: node,
    sessionStorage: { getItem: () => null },
    document: { querySelectorAll: () => [], querySelector: () => null, addEventListener() {} },
    window: {
      location: new URL('https://khotba.daaw.dev/schedule?date=2026-11-06'),
      history: { replaceState() {} },
      addEventListener() {}
    },
    location: {
      set href(val) { navigatedUrl = val; }
    },
    URL, URLSearchParams,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
    esc: value => String(value || ''),
    canEdit: () => true,
    matches: (text, query) => String(text || '').includes(query),
    formatDate: value => value,
    KhatibAvailability: KhatibAvailability,
    SermonCalendar: SermonCalendar,
    confirmBox: () => true
  });

  const html = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
  let script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];

  // Verify schedule initialization honors validated ?date= URL param
  const dateInitMatch = script.includes('var paramDate = params.get(\'date\');');
  assert(dateInitMatch, 'schedule script must extract ?date= parameter from URL');

  script = script.replace(/    \(async function \(\) \{[\s\S]*?    \}\)\(\);/, '');
  vm.runInContext(script, context);

  // Verify render() includes statusReportBtn
  context.state.rows = [
    { mosqueId: 'M1', mosque: 'مسجد النور', mujawra: 'المجاورة الأولى', khatibId: 'K1', status: 'confirmed' }
  ];
  context.state.mosques = {
    M1: { name: 'مسجد النور', mujawra: 'المجاورة الأولى' }
  };
  context.state.khatibs = [
    { id: 'K1', name: 'الشيخ إبراهيم', availability: { mode: 'all', weeks: [1, 2, 3, 4, 5] } }
  ];
  context.state.date = '2026-11-06';

  context.render();

  assert(node('main').innerHTML.includes('id="statusReportBtn"'), 'render must include status report button near exports');
  assert(node('statusReportBtn'), 'status report button element must exist in DOM');

  // Verify wire click navigates to report carrying selected date
  context.wire();
  const reportBtn = node('statusReportBtn');
  assert(reportBtn.onclick, 'reportBtn must have click handler');
  reportBtn.onclick();

  // Allow async flushOrConfirm to finish
  setImmediate(() => {
    assert(navigatedUrl.includes('khatib-status-report.html?date=2026-11-06'), 'report button must navigate to khatib-status-report with selected date');
  });

  // Verify main schedule Word/PDF export table remains ONLY mosque, area, name (NO annotations)
  const exportData = context.getExportData();
  assert.deepEqual([...exportData.headers], ['المسجد', 'المجاورة', 'الخطيب']);
  assert.equal(exportData.rows.length, 1);
  assert.deepEqual([...exportData.rows[0]], ['مسجد النور', 'المجاورة الأولى', 'الشيخ إبراهيم'], 'main schedule export must NOT contain confirmed/pending/excused annotations');

  console.log('PASS 5: validated ?date= URL parameter, report navigation link, and clean main schedule export');
}

console.log('ALL FRONTEND AVAILABILITY & CALENDAR INTEGRATION TESTS PASSED SUCCESSFULLY!');
