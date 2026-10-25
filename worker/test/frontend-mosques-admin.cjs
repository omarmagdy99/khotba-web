const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../../mosques.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)[1];

async function page(editable, failure = false) {
  const nodes = new Map();
  const calls = [];
  const toasts = [];
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id, value: '', textContent: '', innerHTML: '', checked: false, disabled: false,
        style: {}, handlers: {}, dataset: {},
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        addEventListener(event, handler) { this.handlers[event] = handler; },
      });
    }
    return nodes.get(id);
  };
  const mosques = [
    { id: 'M1', name: 'مسجد النور', mujawra: 'الأولى', active: true, managerPhone: '01033334444', managerTelegramLinked: true },
    { id: 'M2', name: 'مسجد آخر', mujawra: 'الثانية', active: true, managerPhone: '01033335555', managerTelegramLinked: false },
    { id: 'M3', name: 'مسجد بلا مسؤول', mujawra: 'الثالثة', active: true },
  ];
  const context = vm.createContext({
    window: {}, navigator: { clipboard: { writeText: async () => {} } },
    renderNav() {}, requireAuth: async () => true, canEdit: () => editable,
    appReady() {}, el: node, esc: value => String(value), matches: (value, query) => String(value || '').includes(query),
    showLoading() {}, showError() {}, showEmpty() {},
    toast: (message, type) => toasts.push({ message, type }),
    confirm: () => true,
    api: async (action, payload) => {
      calls.push({ action, payload });
      if (action === 'listMosques') return { mosques };
      if (action === 'listKhatibs') return { khatibs: [] };
      if (failure) throw new Error('reset failed');
      return { ok: true, temporaryPassword: 'ABCdef2345', telegramSent: true };
    },
  });
  vm.runInContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { node, calls, toasts, context };
}

(async () => {
  const editor = await page(true);
  const markup = editor.node('results').innerHTML;
  assert.equal((markup.match(/🔐 كلمة مرور مؤقتة/g) || []).length, 2, 'button only appears for rows with a phone');
  editor.context.window.openTemporaryPassword('01033334444', true);
  assert.equal(editor.node('sendTemporaryTelegram').checked, true);
  assert.equal(editor.node('sendTemporaryTelegram').disabled, false);
  await editor.node('issueTemporaryPasswordBtn').handlers.click.call(editor.node('issueTemporaryPasswordBtn'));
  assert.equal(editor.node('temporaryPasswordValue').value, 'ABCdef2345', 'password is displayed');
  assert.equal(editor.node('temporaryTelegramStatus').textContent, 'تم إرسالها على تيليجرام.');
  assert.equal(editor.calls.at(-3).payload.sendTelegram, true);
  editor.node('closeTemporaryPasswordBtn').handlers.click();
  assert.equal(editor.node('temporaryPasswordValue').value, '', 'closing removes password');
  assert.equal(editor.node('temporaryPasswordModal').classList.contains('show'), false);
  editor.context.window.openTemporaryPassword('01033335555', false);
  assert.equal(editor.node('sendTemporaryTelegram').disabled, true);
  assert.equal(editor.node('sendTemporaryTelegram').checked, false);
  editor.node('cancelTemporaryPasswordBtn').handlers.click();

  const viewer = await page(false);
  assert(!viewer.node('results').innerHTML.includes('🔐 كلمة مرور مؤقتة'), 'viewer sees no temporary button');
  const error = await page(true, true);
  error.context.window.openTemporaryPassword('01033334444', true);
  await error.node('issueTemporaryPasswordBtn').handlers.click.call(error.node('issueTemporaryPasswordBtn'));
  assert(error.toasts.some(t => t.type === 'err' && t.message === 'reset failed'), 'API errors use toast');
  assert.equal(error.node('temporaryPasswordValue').value, '', 'error displays no password');
  console.log('frontend mosques admin passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
