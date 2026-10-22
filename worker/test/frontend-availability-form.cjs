const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

function createNode(id) {
  return {
    id,
    value: '',
    checked: false,
    style: {},
    classList: {
      _classes: new Set(),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    },
    textContent: '',
    innerHTML: '',
    handlers: {},
    addEventListener(event, handler) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
    },
    dispatchEvent(event) {
      const list = this.handlers[event] || [];
      for (const h of list) h({ target: this, preventDefault() {} });
    },
    reset() { this.value = ''; },
  };
}

const nodes = new Map();
function getNode(id) {
  if (!nodes.has(id)) nodes.set(id, createNode(id));
  return nodes.get(id);
}

// Checkboxes for weeks 1..5
const weekCheckboxes = [1, 2, 3, 4, 5].map(w => {
  const n = createNode(`availWeek_${w}`);
  n.name = 'availWeek';
  n.value = String(w);
  n.checked = false;
  return n;
});

// Radios for mode: all / custom
const modeRadios = [
  { name: 'availabilityMode', value: 'all', checked: true, addEventListener() {} },
  { name: 'availabilityMode', value: 'custom', checked: false, addEventListener() {} },
];

const apiCalls = [];

const context = vm.createContext({
  URL,
  location: new URL('https://khotba.daaw.dev/khatibs.html'),
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 },
  setTimeout: fn => { if (typeof fn === 'function') fn(); return 0; },
  clearTimeout() {},
  window: {},
  document: {
    body: { dataset: { noLoader: '1' }, insertBefore() {} },
    createElement: () => ({ style: {}, className: '', innerHTML: '', textContent: '', appendChild() {}, addEventListener() {} }),
    getElementById: getNode,
    getElementsByName: name => {
      if (name === 'availabilityMode') return modeRadios;
      if (name === 'availWeek') return weekCheckboxes;
      if (name === 'khatibType') return [{ value: 'primary', checked: true }, { value: 'volunteer', checked: false }];
      return [];
    },
    querySelectorAll: selector => {
      if (selector === '#typeTabs .tab-btn') return [];
      if (selector === 'input[name="availWeek"]:checked') {
        return weekCheckboxes.filter(cb => cb.checked);
      }
      return [];
    },
    addEventListener() {},
  },
  el: getNode,
  esc: s => String(s || ''),
  matches: (a, b) => String(a || '').includes(String(b || '')),
  renderNav() {},
  appReady() {},
  showLoading() {},
  toast() {},
  requireAuth: async () => true,
  canEdit: () => true,
  api: async (action, payload) => {
    apiCalls.push({ action, payload });
    if (action === 'listKhatibs') {
      return {
        khatibs: [
          {
            id: 'K1',
            name: 'الشيخ أحمد',
            phone: '01011111111',
            type: 'primary',
            active: true,
            availability: { mode: 'all', weeks: [1, 2, 3, 4, 5] },
          },
          {
            id: 'K2',
            name: 'الشيخ محمود',
            phone: '01022222222',
            type: 'volunteer',
            active: true,
            availability: { mode: 'custom', weeks: [1, 3] },
          },
        ]
      };
    }
    if (action === 'listMosques') return { mosques: [] };
    if (action === 'createKhatib' || action === 'updateKhatib') return { id: 'K9' };
    return {};
  },
});

context.window = context;
context.globalThis = context;

// 1. Load availability.js
vm.runInContext(fs.readFileSync(path.join(root, 'assets/availability.js'), 'utf8'), context);
assert.ok(context.KhatibAvailability, 'KhatibAvailability namespace defined on window');

// 2. Load config.js and app.js
vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), context);

// 3. Load script from khatibs.html
const html = fs.readFileSync(path.join(root, 'khatibs.html'), 'utf8');
const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const lastScript = scriptMatches[scriptMatches.length - 1][1];

// Skip auto-executing loadData/auth on load to control flow
const scriptToRun = lastScript.replace(/\(async function \(\) \{[\s\S]*?\}\)\(\);/, '');
vm.runInContext(scriptToRun, context);

(async () => {
  // Test 1: openAddModal resets availability to 'all'
  context.openAddModal();
  assert.equal(modeRadios[0].checked, true, 'mode "all" checked on add');
  assert.equal(modeRadios[1].checked, false, 'mode "custom" unchecked on add');
  assert.ok(weekCheckboxes.every(cb => cb.checked === false), 'all week checkboxes unchecked on add');
  assert.equal(getNode('availabilitySummary').textContent, 'القاعدة: كل جمعة');

  // Test 2: Switching to custom and checking weeks 1 and 3 updates summary
  modeRadios[0].checked = false;
  modeRadios[1].checked = true;
  weekCheckboxes[0].checked = true; // week 1
  weekCheckboxes[2].checked = true; // week 3
  context.updateAvailabilityUi();
  assert.equal(getNode('customWeeksRow').style.display, 'block');
  assert.equal(getNode('availabilitySummary').textContent, 'القاعدة: الجمعة الأولى والثالثة من كل شهر');

  // Test 3: openEditModal for khatib K2 with custom [1, 3] pre-fills controls
  context.allKhatibs = [
    {
      id: 'K2',
      name: 'الشيخ محمود',
      phone: '01022222222',
      type: 'volunteer',
      active: true,
      availability: { mode: 'custom', weeks: [1, 3] },
    }
  ];
  context.openEditModal('K2');
  assert.equal(modeRadios[1].checked, true, 'mode "custom" selected for K2');
  assert.equal(weekCheckboxes[0].checked, true, 'week 1 checked');
  assert.equal(weekCheckboxes[1].checked, false, 'week 2 unchecked');
  assert.equal(weekCheckboxes[2].checked, true, 'week 3 checked');
  assert.equal(getNode('availabilitySummary').textContent, 'القاعدة: الجمعة الأولى والثالثة من كل شهر');

  console.log('PASS: frontend-availability UI controls and KhatibAvailability namespace verified');
})();
