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
    console.log('Migrating Tasks table for Planner features...');
    
    // Add deadline
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN deadline TIMESTAMP;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column deadline already exists';
        END;
      END $$;
    `);

    // Add priority (low, medium, high)
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN priority VARCHAR(20) DEFAULT 'medium';
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column priority already exists';
        END;
      END $$;
    `);

    // Add assigned_to (user_id)
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN assigned_to VARCHAR(50);
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column assigned_to already exists';
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
