import fs from 'fs';
import path from 'path';

const src = path.resolve('cute-futura', 'public');
const dest = path.resolve('public');

function rmDir(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {}
}

function cpDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

rmDir(dest);
cpDir(src, dest);
console.log('Copied static assets:', src, '->', dest);
