import { pool } from '../api/_lib.js';
async function main() {
  try {
    const r = await pool.query('SELECT 1');
    console.log('OK', r.rows);
  } catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
  }
}
main();
