const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

if (path.resolve(dist) !== path.resolve(root, 'dist')) {
  throw new Error('Invalid frontend output directory');
}

if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(dist, { recursive: true });

const htmlFiles = [
  'index.html',
  'khatib-portal.html',
  'khatib-schedule.html',
  'free-khatibs.html',
  'khatibs.html',
  'mosques.html',
  'public.html',
  'publish.html',
  'schedule.html',
  'account.html',
  'users.html',
  'config.js',
  '.nojekyll'
];

for (const f of htmlFiles) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) {
    if (f === 'config.js') {
      fs.writeFileSync(path.join(dist, f), fs.readFileSync(src, 'utf8')
        .replace('var FRONTEND_BUILD = false;', 'var FRONTEND_BUILD = true;'));
    } else {
      fs.copyFileSync(src, path.join(dist, f));
    }
    console.log(`Copied ${f} -> dist/`);
  }
}

// نفس الشاشات من مصدر واحد؛ بيانات التبين تختارها config.js من المسار.
const tebeen = path.join(dist, 'tebeen');
fs.mkdirSync(tebeen, { recursive: true });
for (const f of htmlFiles.filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(root, f), 'utf8')
    .replace(/أوقاف 15 مايو/g, 'أوقاف التبين')
    .replace(/— 15 مايو<\/title>/g, '— التبين</title>')
    .replace(/المجاورة/g, 'المنطقة')
    .replace(/(src|href)="(assets\/|config\.js)/g, '$1="../$2');
  fs.writeFileSync(path.join(tebeen, f), html);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

const assetsSrc = path.join(root, 'assets');
if (fs.existsSync(assetsSrc)) {
  copyDir(assetsSrc, path.join(dist, 'assets'));
  console.log('Copied assets/ -> dist/assets/');
}

console.log('Frontend build completed successfully in dist/');
