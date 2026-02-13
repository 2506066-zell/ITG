import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
function rmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
}
function cpDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}
function cpFile(from, to) {
  if (!fs.existsSync(from)) return;
  const dir = path.dirname(to);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(from, to);
}
function main() {
  rmDir(publicDir);
  fs.mkdirSync(publicDir, { recursive: true });
  cpDir(path.join(root, 'css'), path.join(publicDir, 'css'));
  cpDir(path.join(root, 'js'), path.join(publicDir, 'js'));
  cpDir(path.join(root, 'icons'), path.join(publicDir, 'icons'));
  const htmls = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  for (const h of htmls) {
    cpFile(path.join(root, h), path.join(publicDir, h));
  }
  cpFile(path.join(root, 'favicon.ico'), path.join(publicDir, 'favicon.ico'));
  cpFile(path.join(root, 'manifest.json'), path.join(publicDir, 'manifest.json'));
  cpFile(path.join(root, 'sw.js'), path.join(publicDir, 'sw.js'));
  console.log('Built public directory at', publicDir);
}
main();
