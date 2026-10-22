const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const cache = new Map();
const storage = {
  getItem: key => cache.get(key) || null,
  setItem: (key, value) => cache.set(key, value),
  removeItem: key => cache.delete(key),
  key: index => [...cache.keys()][index],
  get length() { return cache.size; },
};
function page(url, built = false, access = 'both') {
  const nodes = [];
  const calls = [];
  const context = vm.createContext({
    URL, location: new URL(url), localStorage: storage, sessionStorage: storage,
    setTimeout: () => 0, clearTimeout: () => {}, window: {},
    document: {
      body: { dataset: { noLoader: '1' }, insertBefore: node => nodes.push(node) },
      getElementById: id => nodes.flatMap(n => n.children).find(n => n.id === id) || null,
      createElement: tag => ({ tag, children: [], appendChild(node) { this.children.push(node); }, addEventListener() {} }),
    },
    fetch: async (url, options) => {
      const action = JSON.parse(options.body).action;
      calls.push({ url: String(url), action });
      return { json: async () => ({ ok: true, data: { source: String(url), regionAccess: access } }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, built ? 'dist/config.js' : 'config.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8'), context);
  return { context, calls, nodes };
}
(async () => {
  const may = page('https://khotba.daaw.dev/schedule');
  const tebeen = page('https://khotba.daaw.dev/tebeen/schedule');
  assert.equal(may.context.REGION_ID, '15may');
  assert.equal(tebeen.context.REGION_ID, 'tebeen');
  assert.equal(may.nodes[0].children[1].href, 'https://khotba.daaw.dev/tebeen/schedule.html');
  assert.equal(tebeen.nodes[0].children[1].href, 'https://khotba.daaw.dev/schedule.html');
  assert.equal(tebeen.nodes[0].children[0].textContent, '🕌 أوقاف التبين');
  const { pathToFileURL, fileURLToPath } = require('node:url');
  for (const name of ['schedule.html', 'index.html']) {
    const sourcePage = page(pathToFileURL(path.join(root, name)).href);
    const target = sourcePage.nodes[0].children[1].href;
    assert.equal(fileURLToPath(target), path.join(root, 'dist/tebeen', name));
    assert(fs.existsSync(fileURLToPath(target)), 'local switch target must exist');
    const regionalPage = page(target, true);
    const returnTarget = regionalPage.nodes[0].children[1].href;
    assert.equal(fileURLToPath(returnTarget), path.join(root, 'dist', name));
    assert(fs.existsSync(fileURLToPath(returnTarget)), 'local return target must exist');
    const builtMay = page(returnTarget, true);
    assert.equal(builtMay.nodes[0].children[1].href, target, 'built May returns to the same Tebeen page');
    assert.equal(regionalPage.context.REGION_ID, 'tebeen');
    assert.equal(builtMay.context.REGION_ID, '15may');
  }
  const m = await may.context.api('listMosques');
  const t = await tebeen.context.api('listMosques');
  assert.notEqual(m.source, t.source, 'Tebeen must not read the May cached response');
  await may.context.api('listMosques');
  await tebeen.context.api('listMosques');
  assert.equal(may.calls.filter(c => c.action === 'listMosques').length, 1);
  assert.equal(tebeen.calls.filter(c => c.action === 'listMosques').length, 1);
  assert.equal(may.calls.filter(c => c.action === 'whoami').length, 2, 'cache hits revalidate live authorization');
  assert.equal(new URL(tebeen.calls[0].url).searchParams.get('region'), 'tebeen');
  storage.setItem('awqaf_token', 'regional-test-token');
  const limited = page('https://khotba.daaw.dev/schedule', false, 'tebeen');
  await assert.rejects(() => limited.context.api('listMosques'), e => e.code === 'REGION_FORBIDDEN');
  assert(!limited.calls.some(c => c.action === 'listMosques'), 'restricted page cannot display cached reference data');
  assert.equal(limited.context.location.href, 'https://khotba.daaw.dev/tebeen/schedule.html');
  const allowed = page('https://khotba.daaw.dev/tebeen/schedule', false, 'tebeen');
  await allowed.context.api('whoami');
  assert.equal(allowed.nodes[0].children[1].hidden, true, 'single-region user has no private switch link');
  for (const token of ['', 'regional-test-token']) {
    storage.setItem('awqaf_token', token);
    for (const region of ['', 'tebeen/']) {
      for (const suffix of ['public', 'public.html', 'khatib-portal', 'khatib-portal.html']) {
        const publicPage = page('https://khotba.daaw.dev/' + region + suffix, false, 'both');
        assert.equal(publicPage.nodes[0].children.length, 1, 'public page only displays its region label');
        assert.equal(publicPage.context.document.getElementById('regionSwitch'), null, 'public page has no region switch');
      }
    }
  }
  storage.removeItem('awqaf_token');
  const pub = new URL(tebeen.context.APPS_SCRIPT_URL);
  pub.searchParams.set('date', '2026-10-23');
  assert.equal(pub.searchParams.get('region'), 'tebeen');
  assert.equal(pub.searchParams.get('date'), '2026-10-23');
  for (const file of fs.readdirSync(path.join(root, 'dist/tebeen'))) {
    if (!file.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(root, 'dist/tebeen', file), 'utf8');
    assert(!/<title>[^<]*15 مايو/.test(html), `${file} title must display Tebeen`);
    assert(!html.includes('المجاورة'), `${file} must use المنطقة in Tebeen labels, search and exports`);
    assert(html.includes('src="../config.js"'), `${file} must load the shared region configuration`);
    for (const match of html.matchAll(/(?:src|href)="(\.\.\/[^"?#]+)/g)) {
      assert(fs.existsSync(path.resolve(root, 'dist/tebeen', match[1])), `${file}: missing local asset ${match[1]}`);
    }
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
      new vm.Script(match[1], { filename: file });
    }
  }
  assert(fs.readFileSync(path.join(root, 'dist/mosques.html'), 'utf8').includes('المجاورة'), 'May keeps its existing area label');
  const userPage = fs.readFileSync(path.join(root, 'dist/tebeen/users.html'), 'utf8');
  assert(userPage.includes('15 مايو فقط') && userPage.includes('التبين فقط') && userPage.includes('المنطقتان معًا'), 'both user forms show distinct region options');
  console.log('PASS: regional navigation, independent caches, public date URL, and all generated pages');
})().catch(error => { console.error(error); process.exitCode = 1; });
