import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Manual .env parsing to avoid dependency
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

async function run() {
  try {
    console.log('Setting up database...');
    
    // 1. Tasks
    console.log('Creating tasks table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        completed BOOLEAN DEFAULT FALSE,
        version INTEGER DEFAULT 0
      );
    `);
    // Ensure version column exists (for migration)
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE tasks ADD COLUMN version INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in tasks';
        END;
      END $$;
    `);

    // 2. Memories
    console.log('Creating memories table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        media_type TEXT,
        media_data TEXT,
        note TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        version INTEGER DEFAULT 0
      );
    `);
    // Ensure version column exists
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE memories ADD COLUMN version INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in memories';
        END;
      END $$;
    `);

    // 3. Assignments
    console.log('Creating assignments table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS assignments (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        deadline TIMESTAMP,
        completed BOOLEAN DEFAULT FALSE
      );
    `);

    // 4. Anniversary
    console.log('Creating anniversary table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anniversary (
        id INTEGER PRIMARY KEY,
        date TIMESTAMP,
        note TEXT
      );
    `);
    // Ensure initial row exists for anniversary
    await pool.query(`
      INSERT INTO anniversary (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

    // 5. Goals
    console.log('Creating goals table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS goals (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        category TEXT,
        deadline TIMESTAMP,
        progress INTEGER DEFAULT 0,
        completed BOOLEAN DEFAULT FALSE,
        version INTEGER DEFAULT 0
      );
    `);
    // Ensure version column exists
    await pool.query(`
      DO $$ 
      BEGIN 
        BEGIN
          ALTER TABLE goals ADD COLUMN version INTEGER DEFAULT 0;
        EXCEPTION
          WHEN duplicate_column THEN RAISE NOTICE 'column version already exists in goals';
        END;
      END $$;
    `);

    console.log('Database setup complete.');
  } catch (err) {
    console.error('Error setting up database:', err);
  } finally {
    await pool.end();
  }
}

run();
