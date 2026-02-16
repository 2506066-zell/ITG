import { pool } from '../api/_lib.js';

async function run() {
  const client = await pool.connect();
  try {
    console.log('Migrating assignments table...');
    await client.query('BEGIN');
    
    // Add assigned_to column if not exists
    await client.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE assignments ADD COLUMN assigned_to VARCHAR(50);
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column assigned_to already exists in assignments';
        END;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration successful: assigned_to column added to assignments.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
  }
}

run();
