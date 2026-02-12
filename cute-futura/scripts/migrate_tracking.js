import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Manual .env parsing
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

// Use DATABASE_URL only (pooled Neon connection)
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

async function run() {
  try {
    console.log('Starting migration for User Tracking & Activity Logs...');

    // 1. Create activity_logs table
    console.log('Creating activity_logs table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        entity_type VARCHAR(50) NOT NULL,
        entity_id INTEGER NOT NULL,
        action_type VARCHAR(20) NOT NULL,
        user_id VARCHAR(50) NOT NULL,
        changes JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. Add tracking columns to existing tables
    const tables = ['tasks', 'goals', 'memories', 'assignments'];
    
    for (const table of tables) {
      console.log(`Adding tracking columns to ${table}...`);
      
      // created_by
      await pool.query(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE ${table} ADD COLUMN created_by VARCHAR(50);
          EXCEPTION
            WHEN duplicate_column THEN RAISE NOTICE 'column created_by already exists in ${table}';
          END;
        END $$;
      `);

      // updated_by
      await pool.query(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE ${table} ADD COLUMN updated_by VARCHAR(50);
          EXCEPTION
            WHEN duplicate_column THEN RAISE NOTICE 'column updated_by already exists in ${table}';
          END;
        END $$;
      `);

      // deleted_by (Soft Delete support)
      await pool.query(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE ${table} ADD COLUMN deleted_by VARCHAR(50);
          EXCEPTION
            WHEN duplicate_column THEN RAISE NOTICE 'column deleted_by already exists in ${table}';
          END;
        END $$;
      `);

      // deleted_at (Soft Delete support)
      await pool.query(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE ${table} ADD COLUMN deleted_at TIMESTAMP;
          EXCEPTION
            WHEN duplicate_column THEN RAISE NOTICE 'column deleted_at already exists in ${table}';
          END;
        END $$;
      `);
      
      // is_deleted (Soft Delete flag, easier querying)
      await pool.query(`
        DO $$ 
        BEGIN 
          BEGIN
            ALTER TABLE ${table} ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE;
          EXCEPTION
            WHEN duplicate_column THEN RAISE NOTICE 'column is_deleted already exists in ${table}';
          END;
        END $$;
      `);
    }

    console.log('Migration completed successfully!');
    
    // Indexes to keep queries simple & efficient for 2 users
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to) WHERE is_deleted = FALSE;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_tasks_created_by ON tasks(created_by) WHERE is_deleted = FALSE;`);
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
