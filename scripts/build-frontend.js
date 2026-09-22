const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

if (fs.existsSync(dist)) {
  fs.rmSync(dist, { recursive: true, force: true });
}
fs.mkdirSync(dist, { recursive: true });

const htmlFiles = [
  'index.html',
  'khatib-schedule.html',
  'khatibs.html',
  'mosques.html',
  'public.html',
  'publish.html',
  'schedule.html',
  'account.html',
  'config.js',
  '.nojekyll'
];

for (const f of htmlFiles) {
  const src = path.join(root, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(dist, f));
    console.log(`Copied ${f} -> dist/`);
  }
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
