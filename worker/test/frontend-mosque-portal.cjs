const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');

const values = new Map([
  ['awqaf_token', 'admin-session'],
  ['awqaf_mosque_token_15may', 'may-manager-session'],
  ['awqaf_mosque_token_tebeen', 'tebeen-manager-session'],
]);

const storage = {
  getItem: key => values.get(key) || null,
  setItem: (key, value) => values.set(key, value),
  removeItem: key => values.delete(key),
  key: index => [...values.keys()][index],
  get length() { return values.size; },
};

function portal(region = '15may', options = {}) {
  const nodes = new Map();
  const calls = [];
  const node = id => {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        style: {},
        handlers: {},
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener(event, handler) { this.handlers[event] = handler; },
        focus() {},
        reset() { this.value = ''; },
      });
    }
    return nodes.get(id);
  };

  const url = 'https://khotba.daaw.dev/' + (region === 'tebeen' ? 'tebeen/' : '') + 'mosque-portal';
  const context = vm.createContext({
    URL,
    location: new URL(url),
    localStorage: storage,
    sessionStorage: storage,
    setTimeout: fn => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout() {},
    window: {},
    navigator: { clipboard: { writeText: async () => {} } },
    document: {
      body: { dataset: { noLoader: '1' }, insertBefore() {}, appendChild() {} },
      getElementById: node,
      createElement: () => ({ appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {} } }),
    },
    fetch: async (fetchUrl, fetchOpts) => {
      const body = JSON.parse(fetchOpts.body);
      calls.push({ url: String(fetchUrl), body });
      if (options.handler) {
        return options.handler(body, String(fetchUrl));
      }
      if (options.expired) {
        return {
          json: async () => ({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
        };
      }
      if (body.action === 'mosqueWhoami') {
        return {
          json: async () => ({ ok: true, data: { phone: '01011112222', mosques: [{ id: 'm1', name: 'مسجد النور', mujawra: '1' }] } }),
        };
      }
      if (body.action === 'mosqueGetSchedule') {
        return {
          json: async () => ({
            ok: true,
            data: {
              date: '2026-10-30',
              mosques: [
                {
                  mosqueId: 'm1',
                  name: 'مسجد النور',
                  mujawra: 'المجاورة الأولى',
                  address: 'شارع 1',
                  sortOrder: 1,
                  khatib: { name: 'الشيخ أحمد', phone: '01011112222' },
                  status: 'confirmed',
                },
                {
                  mosqueId: 'm2',
                  name: 'مسجد التقوى',
                  mujawra: 'المجاورة الثانية',
                  address: 'شارع 2',
                  sortOrder: 2,
                  khatib: null,
                  status: 'unassigned',
                },
              ],
            },
          }),
        };
      }
      return { json: async () => ({ ok: true, data: {} }) };
    },
  });

  vm.runInContext(fs.readFileSync(path.join(root, 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), context);
  const html = fs.readFileSync(path.join(root, 'mosque-portal.html'), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(m => m[1].trim());
  const script = scripts.at(-1)[1];
  vm.runInContext(script, context);
  return { context, calls, node, url };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  // ── 1. needs_setup flow ───────────────────────────────────────────────────
  values.delete('awqaf_mosque_token_15may');
  let setupCalls = [];
  const pSetup = portal('15may', {
    handler: async body => {
      setupCalls.push(body.action);
      if (body.action === 'mosquePhoneCheck') {
        return { json: async () => ({ ok: true, data: { status: 'needs_setup', telegramLinked: false } }) };
      }
      if (body.action === 'mosqueSetPassword') {
        assert.equal(body.phone, '01011112222');
        assert.equal(body.password, 'password123');
        return {
          json: async () => ({
            ok: true,
            data: { token: 'token-setup-123', phone: '01011112222', mosques: [{ id: 'm1', name: 'مسجد النور', mujawra: '1' }] },
          }),
        };
      }
      if (body.action === 'mosqueGetSchedule') {
        return {
          json: async () => ({
            ok: true,
            data: {
              date: '2026-10-30',
              mosques: [{ mosqueId: 'm1', name: 'مسجد النور', mujawra: '1', khatib: null, status: 'unassigned' }],
            },
          }),
        };
      }
      return { json: async () => ({ ok: true, data: {} }) };
    },
  });
  await settle();

  // Enter phone
  pSetup.node('phoneNumber').value = '01011112222';
  await pSetup.node('phoneForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(pSetup.node('setupSection').style.display, 'block', 'needs_setup transitions to setupSection');

  // Enter password and confirm
  pSetup.node('setupPassword').value = 'password123';
  pSetup.node('setupConfirmPassword').value = 'password123';
  await pSetup.node('setupForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(values.get('awqaf_mosque_token_15may'), 'token-setup-123', 'token saved to storage after setup');
  assert.equal(pSetup.node('dashboardSection').style.display, 'block', 'dashboard displayed after setup');
  assert(setupCalls.includes('mosquePhoneCheck') && setupCalls.includes('mosqueSetPassword') && setupCalls.includes('mosqueGetSchedule'));

  // ── 2. has_password login flow ───────────────────────────────────────────
  values.delete('awqaf_mosque_token_15may');
  const pLogin = portal('15may', {
    handler: async body => {
      if (body.action === 'mosquePhoneCheck') {
        return { json: async () => ({ ok: true, data: { status: 'has_password', telegramLinked: true } }) };
      }
      if (body.action === 'mosqueLogin') {
        assert.equal(body.phone, '01022223333');
        assert.equal(body.password, 'correct-password');
        return {
          json: async () => ({
            ok: true,
            data: { token: 'token-login-456', phone: '01022223333', mosques: [{ id: 'm1', name: 'مسجد الفردوس', mujawra: '2' }] },
          }),
        };
      }
      if (body.action === 'mosqueGetSchedule') {
        return {
          json: async () => ({
            ok: true,
            data: {
              date: '2026-10-30',
              mosques: [{ mosqueId: 'm1', name: 'مسجد الفردوس', mujawra: '2', khatib: null, status: 'unassigned' }],
            },
          }),
        };
      }
      return { json: async () => ({ ok: true, data: {} }) };
    },
  });
  await settle();

  pLogin.node('phoneNumber').value = '01022223333';
  await pLogin.node('phoneForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(pLogin.node('passwordSection').style.display, 'block', 'has_password transitions to passwordSection');

  pLogin.node('loginPassword').value = 'correct-password';
  await pLogin.node('passwordForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(values.get('awqaf_mosque_token_15may'), 'token-login-456', 'token saved to storage after login');
  assert.equal(pLogin.node('dashboardSection').style.display, 'block', 'dashboard displayed after login');

  // ── 3. wrong password message ────────────────────────────────────────────
  values.delete('awqaf_mosque_token_15may');
  const pWrong = portal('15may', {
    handler: async body => {
      if (body.action === 'mosquePhoneCheck') {
        return { json: async () => ({ ok: true, data: { status: 'has_password', telegramLinked: true } }) };
      }
      if (body.action === 'mosqueLogin') {
        return { json: async () => ({ ok: false, error: { code: 'BAD_CREDENTIALS', message: 'كلمة المرور غير صحيحة' } }) };
      }
      return { json: async () => ({ ok: true, data: {} }) };
    },
  });
  await settle();

  pWrong.node('phoneNumber').value = '01022223333';
  await pWrong.node('phoneForm').handlers.submit({ preventDefault() {} });
  await settle();
  pWrong.node('loginPassword').value = 'wrong-password';
  await pWrong.node('passwordForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(pWrong.node('passwordError').style.display, 'block');
  assert(pWrong.node('passwordError').textContent.includes('كلمة المرور غير صحيحة'));
  assert.equal(values.get('awqaf_mosque_token_15may'), undefined, 'wrong password does not set token');
  assert.notEqual(pWrong.node('dashboardSection').style.display, 'block');

  // ── 4. forgot flow incl. TELEGRAM_NOT_LINKED instructions ────────────────
  let resetRequested = false;
  const pForgot = portal('15may', {
    handler: async body => {
      if (body.action === 'mosquePhoneCheck') {
        return { json: async () => ({ ok: true, data: { status: 'has_password', telegramLinked: false } }) };
      }
      if (body.action === 'mosqueRequestReset') {
        if (!resetRequested) {
          resetRequested = true;
          return {
            json: async () => ({
              ok: false,
              error: {
                code: 'TELEGRAM_NOT_LINKED',
                message: 'telegram not linked',
                details: { botUsername: 'AwqafTestBot' },
              },
            }),
          };
        }
        return { json: async () => ({ ok: true, data: { sent: true } }) };
      }
      if (body.action === 'mosqueConfirmReset') {
        assert.equal(body.code, '123456');
        assert.equal(body.password, 'newpassword888');
        return {
          json: async () => ({
            ok: true,
            data: { token: 'token-reset-888', phone: '01033334444', mosques: [] },
          }),
        };
      }
      if (body.action === 'mosqueGetSchedule') {
        return { json: async () => ({ ok: true, data: { date: '2026-10-30', mosques: [] } }) };
      }
      return { json: async () => ({ ok: true, data: {} }) };
    },
  });
  await settle();

  pForgot.node('phoneNumber').value = '01033334444';
  await pForgot.node('phoneForm').handlers.submit({ preventDefault() {} });
  await settle();

  // Click forgot password link
  await pForgot.node('forgotPasswordLink').handlers.click({ preventDefault() {} });
  await settle();
  assert.equal(pForgot.node('telegramHelpBox').style.display, 'block', 'TELEGRAM_NOT_LINKED displays telegram help box');
  assert(pForgot.node('telegramHelpBox').innerHTML.includes('https://t.me/AwqafTestBot'), 'includes bot link');
  assert(pForgot.node('telegramHelpBox').innerHTML.includes('Start'), 'mentions Start');
  assert(pForgot.node('telegramHelpBox').innerHTML.includes('رقم'), 'mentions sharing phone number');

  // Retry reset after linking
  await pForgot.node('requestResetBtn').handlers.click();
  await settle();
  assert.equal(pForgot.node('resetSection').style.display, 'block', 'successful reset request transitions to resetSection');

  // Confirm reset with code and new password
  pForgot.node('resetCode').value = '123456';
  pForgot.node('resetPassword').value = 'newpassword888';
  pForgot.node('resetConfirmPassword').value = 'newpassword888';
  await pForgot.node('resetConfirmForm').handlers.submit({ preventDefault() {} });
  await settle();
  assert.equal(values.get('awqaf_mosque_token_15may'), 'token-reset-888', 'logged in with new token after reset');
  assert.equal(pForgot.node('dashboardSection').style.display, 'block', 'dashboard displayed after reset');

  // ── 5. logged-in rendering with and without a khatib ─────────────────────
  values.set('awqaf_mosque_token_15may', 'valid-active-session');
  const pRender = portal('15may');
  await settle();
  assert.equal(pRender.node('dashboardSection').style.display, 'block');
  assert(pRender.node('fridayDateText').textContent.includes('30 أكتوبر 2026'), 'displays formatted Friday date');
  const renderedHtml = pRender.node('mosquesContainer').innerHTML;
  assert(renderedHtml.includes('مسجد النور'), 'renders mosque with khatib');
  assert(renderedHtml.includes('الشيخ أحمد'), 'renders khatib name');
  assert(renderedHtml.includes('tel:01011112222'), 'renders tel: tap-to-call link');
  assert(renderedHtml.includes('نسخ الرقم'), 'renders phone copy button');
  assert(renderedHtml.includes('مؤكد الحضور'), 'renders confirmed assignment badge');
  assert(renderedHtml.includes('مسجد التقوى'), 'renders mosque without khatib');
  assert(renderedHtml.includes('لم يتم تعيين خطيب بعد'), 'shows Arabic unassigned placeholder');

  // ── 6. logout ────────────────────────────────────────────────────────────
  await pRender.node('logoutBtn').handlers.click();
  await settle();
  assert.equal(values.get('awqaf_mosque_token_15may'), undefined, 'logout clears mosque token');
  assert.equal(pRender.node('phoneSection').style.display, 'block', 'logout returns to phone section');
  assert.equal(values.get('awqaf_token'), 'admin-session', 'logout preserves admin session');

  // ── 7. session resume and expiry ─────────────────────────────────────────
  values.set('awqaf_mosque_token_tebeen', 'tebeen-manager-session');
  const tebeenPortal = portal('tebeen');
  await settle();
  assert.equal(tebeenPortal.node('dashboardSection').style.display, 'block', 'valid session resumes dashboard');
  assert(tebeenPortal.calls.every(c => c.body.token === 'tebeen-manager-session'));
  assert.equal(new URL(tebeenPortal.calls[0].url).searchParams.get('region'), 'tebeen', 'routes with ?region=tebeen');

  const expired = portal('tebeen', { expired: true });
  await settle();
  assert.equal(values.get('awqaf_mosque_token_tebeen'), undefined, 'expired token removed from storage');
  assert.equal(values.get('awqaf_token'), 'admin-session', 'expired mosque session preserves admin session');
  assert.equal(expired.context.location.href, expired.url, 'expired session stays in its regional portal');
  assert.equal(expired.node('phoneSection').style.display, 'block', 'expired session shows phone section');

  console.log('PASS: needs_setup, has_password, wrong password, forgot Telegram flow, schedule rendering, logout, and session resume/expiry');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
