import { withErrorHandling, sendJson, pool } from '../_lib.js';
import { ensureClassNotesSchema, runNotesVaultMaintenance } from '../class_notes.js';

export default withErrorHandling(async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const client = await pool.connect();
  try {
    await ensureClassNotesSchema(client);
    await client.query('BEGIN');
    const stats = await runNotesVaultMaintenance(client);
    await client.query('COMMIT');
    sendJson(res, 200, {
      ok: true,
      cron: 'notes_vault_maintenance',
      ...stats,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});
