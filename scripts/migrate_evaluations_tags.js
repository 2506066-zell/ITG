import { pool } from '../api/_lib.js';

async function run() {
  const client = await pool.connect();
  try {
    console.log('Migrating evaluations table...');
    await client.query('BEGIN');
    
    // Add tags column if not exists
    await client.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE evaluations ADD COLUMN tags TEXT[];
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column tags already exists in evaluations';
        END;
      END $$;
    `);

    await client.query('COMMIT');
    console.log('Migration successful: tags column added to evaluations.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', err);
  } finally {
    client.release();
  }
}

run();
