import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
function rmDir(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { }
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
  const htmls = fs.readdirSync(root).filter(f => f.endsWith('.html') || f.endsWith('.jpg') || f.endsWith('.svg'));
  for (const h of htmls) {
    const src = path.join(root, h);
    const dst = path.join(publicDir, h);
    cpFile(src, dst);
  }
  const publicHtmls = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
  for (const h of publicHtmls) {
    if (h.toLowerCase() !== 'login.html') continue;
    const p = path.join(publicDir, h);
    let content = fs.readFileSync(p, 'utf8');
    if (!content.includes('css/solar-system.css')) {
      if (content.includes('</head>')) {
        content = content.replace('</head>', `  <link rel="stylesheet" href="css/solar-system.css">\n</head>`);
      } else {
        content = `<link rel="stylesheet" href="css/solar-system.css">\n` + content;
      }
    }
    if (!content.includes('js/solar-system.js')) {
      if (content.includes('</body>')) {
        content = content.replace('</body>', `  <script src="js/solar-system.js"></script>\n</body>`);
      } else {
        content += `\n<script src="js/solar-system.js"></script>\n`;
      }
    }
    fs.writeFileSync(p, content, 'utf8');
  }
  cpFile(path.join(root, 'favicon.ico'), path.join(publicDir, 'favicon.ico'));
  cpFile(path.join(root, 'manifest.json'), path.join(publicDir, 'manifest.json'));
  cpFile(path.join(root, 'sw.js'), path.join(publicDir, 'sw.js'));
  console.log('Built public directory at', publicDir);
}
main();
