import http from 'http';
import https from 'https';
function get(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, res => {
      const status = res.statusCode;
      const ct = res.headers['content-type'] || '';
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status, ct, len: body.length }));
    });
    req.on('error', reject);
  });
}
async function main() {
  const base = process.argv[2] || 'http://localhost:3000';
  const pages = ['/index.html','/login.html','/memories.html','/anniversary.html','/daily-tasks.html','/college-assignments.html','/chat.html','/settings.html'];
  const css = ['/css/style.css','/css/themes.css'];
  const errs = [];
  for (const p of pages) {
    const r = await get(base + p).catch(() => null);
    if (!r || r.status !== 200) errs.push(`Page ${p} status ${r ? r.status : 'error'}`);
  }
  for (const c of css) {
    const r = await get(base + c).catch(() => null);
    if (!r) { errs.push(`CSS ${c} error`); continue; }
    if (r.status !== 200) errs.push(`CSS ${c} status ${r.status}`);
    if (!/text\/css/i.test(r.ct)) errs.push(`CSS ${c} wrong content-type ${r.ct}`);
    if (r.len < 20) errs.push(`CSS ${c} suspicious size ${r.len}`);
  }
  if (errs.length) {
    console.error('CSS fetch check errors:');
    errs.forEach(e => console.error('- ' + e));
    process.exit(1);
  } else {
    console.log('CSS fetch check passed');
  }
}
main();
