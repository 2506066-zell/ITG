import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf-8');
  envConfig.split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && value && !process.env[key]) process.env[key] = value;
    }
  });
}

const url = process.env.ZN_DATABASE_URL || process.env.NZ_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('No database URL in env');
  process.exit(1);
}
const ssl = url.includes('sslmode=require') ? { rejectUnauthorized: false } : true;
const pool = new Pool({ connectionString: url, ssl });

async function main() {
  try {
    const r = await pool.query('SELECT 1');
    console.log('OK', r.rows);
  } catch (e) {
    console.error('ERR', e.code || '', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
main();
