import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

if (fs.existsSync(envPath)) {
  const envConfig = fs.readFileSync(envPath, 'utf-8');
  envConfig.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      process.env[key.trim()] = value.trim();
    }
  });
}

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

async function run() {
  try {
    console.log('Migrating Tasks table for Accountability Score...');
    
    // Add goal_id
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN goal_id INTEGER;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column goal_id already exists';
        END;
      END $$;
    `);

    // Add score_awarded
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN score_awarded INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column score_awarded already exists';
        END;
      END $$;
    `);
    
    // Add completed_at index for performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_completed_at ON tasks(completed_at) WHERE completed = TRUE;`);
    // Note: 'deleted_at' is used for soft delete. 'completed' is boolean. 
    // We don't have 'completed_at' column in previous schema? 
    // Let's check schema.
    
    // Wait, previous tasks.js updates 'deleted_at' when deleting.
    // But when completing, we just set 'completed = true'.
    // We need 'completed_at' to filter by week range properly.
    
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN completed_at TIMESTAMP;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column completed_at already exists';
        END;
      END $$;
    `);

    console.log('Migration completed.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
