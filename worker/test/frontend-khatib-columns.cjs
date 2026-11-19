const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require.resolve('../../khatibs.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const nodes = new Map();
function el(id) {
  if (!nodes.has(id)) nodes.set(id, {
    value: '', style: {}, handlers: {}, classList: { add() {}, remove() {} },
    addEventListener(event, fn) { this.handlers[event] = fn; }
  });
  return nodes.get(id);
}
let canEdit = true;
const calls = [];
const context = vm.createContext({
  el, renderNav() {}, requireAuth: async () => false, canEdit: () => canEdit,
  document: { querySelectorAll: () => [], getElementsByName: () => [], addEventListener() {} },
  esc: value => String(value).replaceAll('<', '&lt;'), matches: () => false,
  toast: (msg, status) => { if (status === 'err') throw Error(msg); },
  api: async (action, payload) => {
    calls.push([action,payload]);
    if (payload) return { nationalId:'20000000000000', occupation:'مدرس' };
    return { nationalIds:{ K001:'20000000000000' } };
  }
});
vm.runInContext(script, context);
const settle = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  context.allKhatibs = [{ id:'K001', name:'خطيب تجريبي', occupation:'', active:true }];
  context.openEditModal('K001');
  await settle();
  assert.equal(el('staffNationalId').value,'20000000000000');
  assert.equal(el('khatibOccupation').value,'مدرس');
  context.closeModal();
  assert.equal(el('staffNationalId').value,'');

  context.allKhatibs[0].occupation = 'مدرس';
  context.renderColumnOptions();
  context.renderList();
  assert.match(el('results').innerHTML,/مدرس/);
  assert.doesNotMatch(el('results').innerHTML,/20000000000000/);
  const change = (value, checked) => el('columnOptions').handlers.change({target:{value,checked}});
  change('nationalId',true);
  await settle();
  assert.match(el('results').innerHTML,/20000000000000/);
  change('occupation',false);
  assert.doesNotMatch(el('results').innerHTML,/مدرس/);
  change('nationalId',false);
  assert.doesNotMatch(el('results').innerHTML,/20000000000000/);
  canEdit = false;
  context.renderColumnOptions();
  assert.doesNotMatch(el('columnOptions').innerHTML,/nationalId/);
  assert.equal(calls.length,2);
  console.log('PASS: saved details, selectable columns and restricted national ID display');
})().catch(error => { console.error(error); process.exitCode = 1; });
