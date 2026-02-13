import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};
function send(res, code, body, headers={}) {
  res.writeHead(code, headers);
  res.end(body);
}
function handler(req, res) {
  let reqPath = req.url || '/';
  if (reqPath === '/') reqPath = '/index.html';
  const fp = path.join(publicDir, decodeURIComponent(reqPath));
  if (!fp.startsWith(publicDir)) return send(res, 403, 'Forbidden');
  try {
    const stat = fs.statSync(fp);
    if (stat.isDirectory()) {
      const idx = path.join(fp, 'index.html');
      const buf = fs.readFileSync(idx);
      return send(res, 200, buf, { 'Content-Type': types['.html'] });
    }
    const ext = path.extname(fp).toLowerCase();
    const ct = types[ext] || 'application/octet-stream';
    const buf = fs.readFileSync(fp);
    return send(res, 200, buf, { 'Content-Type': ct });
  } catch {
    return send(res, 404, 'Not Found');
  }
}
const server = http.createServer(handler);
server.listen(PORT, () => {
  console.log(`Static server at http://localhost:${PORT}`);
});
