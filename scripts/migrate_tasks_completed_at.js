
import { pool } from '../api/_lib.js';

async function run() {
  const client = await pool.connect();
  try {
    console.log('Migrating tasks table...');
    await client.query('BEGIN');
    
    // Add completed_at column if not exists
    await client.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN completed_at TIMESTAMPTZ;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column completed_at already exists in tasks';
        END;
      END $$;
    `);

    // Backfill completed_at for completed tasks
    // We'll use created_at as a proxy for old tasks
    await client.query(`
      UPDATE tasks 
      SET completed_at = created_at 
      WHERE completed = TRUE AND completed_at IS NULL
    `);

    await client.query('COMMIT');
    console.log('Migration successful: completed_at column added and backfilled.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
  }
}

run();
