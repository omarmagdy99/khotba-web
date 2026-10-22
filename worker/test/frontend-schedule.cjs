const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const nodes = new Map();
const node = id => {
  if (!nodes.has(id)) nodes.set(id, { value: '', style: {}, classList: { remove() {} },
    addEventListener() {}, querySelectorAll: () => [] });
  return nodes.get(id);
};
let rowElements = [];
const context = vm.createContext({
  REGION_ID: '15may', renderNav() {}, el: node,
  sessionStorage: { getItem: () => null },
  document: { querySelectorAll: () => rowElements, querySelector: () => null, addEventListener() {} },
  window: { addEventListener() {} },
  setTimeout: fn => { fn(); return 0; }, clearTimeout() {},
  esc: value => String(value || ''), canEdit: () => true,
  matches: (text, query) => String(text || '').includes(query), formatDate: value => value,
});
const html = fs.readFileSync(path.join(root, 'schedule.html'), 'utf8');
let script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
// Skip page bootstrapping; exercise the real renderer, filters and edit handlers.
script = script.replace(/    \(async function \(\) \{[\s\S]*?    \}\)\(\);/, '');
vm.runInContext(script, context);
context.scheduleAutosave = () => {};
context.renderSaveStatus = () => {};
context.state.rows = [
  { mosqueId: 'M1', mosque: 'مسجد أ', khatibId: 'K1', status: 'confirmed' },
  { mosqueId: 'M2', mosque: 'مسجد ب', khatibId: 'K2', status: 'excused' },
  { mosqueId: 'M3', mosque: 'مسجد ج', khatibId: 'K3', status: 'unassigned' },
  { mosqueId: 'M4', mosque: 'مسجد د', khatibId: '', status: 'unassigned' },
];
rowElements = context.state.rows.map(r => ({ dataset: { mosque: r.mosqueId }, style: {} }));
const visible = () => rowElements.filter(r => r.style.display !== 'none').map(r => r.dataset.mosque);
for (const [filter, expected] of [['', ['M1', 'M2', 'M3', 'M4']], ['confirmed', ['M1']], ['excused', ['M2']], ['pending', ['M3']], ['empty', ['M4']]]) {
  context.state.statusFilter = filter;
  context.applyFilters();
  assert.deepEqual(visible(), expected);
}
context.state.statusFilter = 'excused';
node('mosqueSearch').value = 'مسجد أ';
context.applyFilters();
assert.deepEqual(visible(), [], 'search combines with status filter');
node('mosqueSearch').value = '';
assert(context.rowHtml(context.state.rows[1]).includes('excused-row'), 'excused rows are styled red');
assert(context.statusHtml({}, { khatibId: 'K3', status: 'unassigned' }).includes('value="unassigned" selected'));
context.canEdit = () => false;
assert(context.statusHtml({}, { khatibId: 'K3', status: 'unassigned' }).includes('لم يتم التأكيد'));
context.canEdit = () => true;
context.onKhatibChange('M2', 'K4');
assert.equal(context.state.dirty.M2.status, 'unassigned', 'replacement does not inherit excuse/confirmation');
assert.deepEqual(visible(), [], 'replaced row leaves active excuse filter immediately');
context.onKhatibChange('M1', 'K1');
assert.equal(context.effective(context.state.rows[0]).status, 'confirmed', 'selecting same khatib preserves reply');
context.onKhatibChange('M4', 'K3');
assert.equal(context.state.dirty.M4.status, 'unassigned', 'moving khatib requires fresh confirmation');
assert.equal(context.state.dirty.M3.khatibId, '', 'moving khatib clears previous mosque');
context.state.statusFilter = 'pending';
context.onStatusChange('M4', 'confirmed');
assert(!visible().includes('M4'), 'confirmed row leaves pending filter immediately');
console.log('PASS: status/search filters, red excuse rows, pending assignment defaults and live filter updates');

context.state.dirty = {};
context.state.rows = [
  { mosqueId: 'M1', khatibId: 'K1', status: 'unassigned' },
  { mosqueId: 'M2', khatibId: 'K4', status: 'excused' },
];
context.state.khatibReadiness = { K2: 'ready', K3: 'excused' };
context.state.prefsByKhatib = { K2: new Set(['M1']), K3: new Set(['M1']) };
const ids = ['', 'K1', 'K2', 'K3', 'K4', 'K5'];
const filtered = filters => ids.filter(id => context.khatibMatchesFilters(id, 'M1', filters));
assert.deepEqual(filtered({ status: 'excused' }), ['', 'K3', 'K4'], 'excuses include readiness and assignment replies');
assert.deepEqual(filtered({ status: 'not-excused', preferred: true }), ['', 'K2'], 'preference and response filters combine');
assert.deepEqual(filtered({ status: 'ready' }), ['', 'K2']);
assert.deepEqual(filtered({ preferred: true }), ['', 'K2', 'K3']);
assert.deepEqual(filtered({ available: true }), ['', 'K1', 'K2', 'K3', 'K5'], 'exclude other mosques while keeping current khatib');
context.state.dirty.M2 = { khatibId: 'K4', status: 'confirmed' };
assert(!filtered({ status: 'excused' }).includes('K4'), 'unsaved edits are reflected in candidate filtering');
context.state.dirty = {};
const events = {};
const bar = { setAttribute() {}, addEventListener: (event, handler) => { events[event] = handler; }, querySelectorAll: () => [] };
context.document.createElement = () => bar;
const cached = { items: ids.map(id => ({ id, score: 1 })), total: ids.length };
const ts = {
  items: ['K1'], dropdown_content: {}, dropdown: { insertBefore() {} },
  search: () => cached, refreshOptions: () => {}, positionDropdown() {},
};
context.attachKhatibFilters(ts, context.state.rows[0]);
function clickFilter(type, value) {
  const button = { dataset: type === 'status' ? { khatibStatus: value } : { khatibToggle: value }, hasAttribute: key => type === 'status' && key === 'data-khatib-status' };
  events.click({ target: { closest: () => button }, preventDefault() {}, stopPropagation() {} });
}
clickFilter('status', 'excused');
assert.deepEqual(Array.from(ts.search('اسم').items, item => item.id), ['', 'K3', 'K4']);
clickFilter('toggle', 'preferred');
assert.deepEqual(Array.from(ts.search('اسم').items, item => item.id), ['', 'K3']);
clickFilter('status', '');
assert.equal(ts.search('اسم').total, ids.length, 'all resets combined filters');
assert.equal(cached.items.length, ids.length, 'cached search results remain intact');
assert.deepEqual(ts.items, ['K1'], 'filter clicks never change selected khatib');
assert.deepEqual(Object.keys(context.state.dirty), [], 'filtering never creates assignment edits');
console.log('PASS: dropdown filter combinations, search cache preservation, current selection and dirty-state safety');
