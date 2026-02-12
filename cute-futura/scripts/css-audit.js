import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function read(file) {
  return fs.readFileSync(file, 'utf8');
}
function getHead(html) {
  const s = html.indexOf('<head');
  const e = html.indexOf('</head>');
  if (s === -1 || e === -1) return '';
  return html.slice(s, e);
}
function extractLinks(head) {
  const rx = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
  return head.match(rx) || [];
}
function hrefFromLink(link) {
  const m = link.match(/href=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
function main() {
  const root = path.join(__dirname, '..');
  const publicDir = path.join(root, 'public');
  const stylePath = path.join(root, 'public', 'css', 'style.css');
  const themePath = path.join(root, 'public', 'css', 'themes.css');
  const errs = [];
  if (!fs.existsSync(stylePath)) errs.push('Missing public/css/style.css');
  if (!fs.existsSync(themePath)) errs.push('Missing public/css/themes.css');
  const pages = fs.readdirSync(publicDir).filter(f => f.endsWith('.html'));
  for (const p of pages) {
    const fp = path.join(publicDir, p);
    const html = read(fp);
    const head = getHead(html);
    if (!head) { errs.push(`${p}: missing <head>`); continue; }
    const links = extractLinks(head);
    if (!links.length) { errs.push(`${p}: no stylesheet links in <head>`); continue; }
    const hrefs = links.map(hrefFromLink);
    const hasStyle = hrefs.find(h => h === 'css/style.css' || h === '/css/style.css' || h === '../src/css/style.css' || h === '../css/style.css');
    const hasThemes = hrefs.find(h => h === 'css/themes.css' || h === '/css/themes.css' || h === '../src/css/themes.css' || h === '../css/themes.css');
    if (!hasStyle) errs.push(`${p}: style.css link missing or wrong path`);
    if (!hasThemes) errs.push(`${p}: themes.css link missing or wrong path`);
  }
  if (errs.length) {
    console.error('CSS audit errors:');
    errs.forEach(e => console.error('- ' + e));
    process.exit(1);
  } else {
    console.log('CSS audit passed');
  }
}
main();
