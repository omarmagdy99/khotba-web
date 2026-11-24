const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const values = new Map([
  ['awqaf_token', 'admin-session'],
  ['awqaf_khatib_token_15may', 'may-session'],
  ['awqaf_khatib_token_tebeen', 'tebeen-session'],
]);
const storage = {
  getItem: key => values.get(key) || null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
  key: index => [...values.keys()][index],
  get length() { return values.size; },
};
function portal(region, expired = false) {
  const nodes = new Map();
  const calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, handlers: {}, classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(event, handler) { this.handlers[event] = handler; }, focus() {},
      reset() { this.resetCalled = true; } });
    return nodes.get(id);
  };
  const url = 'https://khotba.daaw.dev/' + (region === 'tebeen' ? 'tebeen/' : '') + 'khatib-portal';
  const context = vm.createContext({
    URL, location: new URL(url), localStorage: storage, sessionStorage: storage,
    setTimeout: () => 0, clearTimeout() {}, window: {},
    document: {
      body: { dataset: { noLoader: '1' }, insertBefore() {} },
      getElementById: node,
      createElement: () => ({ appendChild() {}, addEventListener() {} }),
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ url: String(url), body });
      let data = { khatib: { name: region, type: 'primary' } };
      if (body.action === 'khatibGetSchedule') {
        data = { date: '2026-10-23', availableDates: ['2026-10-23'], hasAssignment: false, readiness: 'undecided' };
      } else if (body.action === 'khatibLogin') {
        data.token = (body.nationalId ? 'nid_' : '') + 'a'.repeat(64);
      }
      return { json: async () => expired
        ? { ok: false, error: { code: 'UNAUTHENTICATED', message: 'expired' } }
        : { ok: true, data } };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(root, 'khatib-portal.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  vm.runInContext(script, context);
  return { context, calls, node, url };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const may = portal('15may');
  const tebeen = portal('tebeen');
  await settle();
  assert(may.calls.every(c => c.body.token === 'may-session'));
  assert(tebeen.calls.every(c => c.body.token === 'tebeen-session'));
  assert.equal(new URL(tebeen.calls[0].url).searchParams.get('region'), 'tebeen');
  may.node('logoutBtn').handlers.click();
  assert.equal(values.get('awqaf_khatib_token_15may'), undefined);
  assert.equal(values.get('awqaf_khatib_token_tebeen'), 'tebeen-session');
  assert.equal(values.get('awqaf_token'), 'admin-session');
  const expired = portal('tebeen', true);
  await settle();
  assert.equal(values.get('awqaf_khatib_token_tebeen'), undefined);
  assert.equal(values.get('awqaf_token'), 'admin-session', 'expired khatib session preserves admin session');
  assert.equal(expired.context.location.href, expired.url, 'expired session stays in its regional portal');
  const mobile = portal('tebeen');
  const submitLogin = number => {
    mobile.node('loginNumber').value = number;
    return mobile.node('khatibLoginForm').handlers.submit({ preventDefault() {} });
  };
  await submitLogin('123');
  assert.equal(mobile.calls.length, 0);
  assert.equal(mobile.node('loginError').style.display, 'block');
  await submitLogin('٠١٠٠٠٠٠٠٠٠١');
  assert.deepEqual(mobile.calls.find(c => c.body.action === 'khatibLogin').body, {
    action: 'khatibLogin', phone: '01000000001'
  });
  assert.equal(mobile.node('loginNumber').value, '');
  assert.equal(mobile.node('portalIdentityPanel').hidden, false);
  mobile.node('portalIdentityCode').value = 'test-code';
  mobile.node('portalNationalId').value = '20000000000000';
  const form = mobile.node('portalIdentityForm');
  await form.handlers.submit.call(form, { preventDefault() {} });
  assert.equal(form.resetCalled, true);
  assert.equal(mobile.calls.at(-1).body.action, 'khatibSubmitNationalId');
  assert.equal(mobile.calls.at(-1).body.token, 'a'.repeat(64));
  assert.equal(values.get('awqaf_khatib_token_tebeen'), undefined, 'enrollment ends the phone session');
  assert.equal(mobile.node('loginSection').style.display, 'block');
  await submitLogin('٢٠٠٠٠٠٠٠٠٠٠٠٠٠');
  assert.deepEqual(mobile.calls.filter(c => c.body.action === 'khatibLogin').at(-1).body, {
    action: 'khatibLogin', nationalId: '20000000000000'
  });
  assert.equal(mobile.node('portalIdentityPanel').hidden, true);
  assert.equal(values.get('awqaf_khatib_token_tebeen'), 'nid_' + 'a'.repeat(64));
  assert.equal([...values.values()].includes('20000000000000'), false);
  console.log('PASS: both login methods, enrollment, regional routing and independent sessions');
})().catch(error => { console.error(error); process.exitCode = 1; });
