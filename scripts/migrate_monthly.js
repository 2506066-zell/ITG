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
    console.log('Migrating Monthly Todos tables...');
    
    // 1. monthly_todos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_todos (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL,
        month VARCHAR(7) NOT NULL, -- Format: YYYY-MM
        title TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // 2. monthly_todo_logs
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monthly_todo_logs (
        id SERIAL PRIMARY KEY,
        monthly_todo_id INTEGER REFERENCES monthly_todos(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        completed BOOLEAN DEFAULT TRUE,
        completed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(monthly_todo_id, date)
      );
    `);

    // Indexes for performance
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_todos_month_user ON monthly_todos(month, user_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_monthly_logs_todo_id ON monthly_todo_logs(monthly_todo_id);`);

    console.log('Migration completed.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
