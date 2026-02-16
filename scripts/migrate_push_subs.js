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

const connectionString = process.env.DATABASE_URL || process.env.ZN_DATABASE_URL;
const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

async function run() {
  try {
    console.log('Migrating: Creating push_subscriptions table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        endpoint TEXT NOT NULL,
        keys JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, endpoint)
      );
    `);
    
    // Add index for fast lookup
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);`);
    
    console.log('Migration completed.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
