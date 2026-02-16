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

const SEED_TOPICS = [
  { topic: "Apa tantangan terbesar di kuliah hari ini?", category: "Reflection" },
  { topic: "Jelaskan satu konsep baru yang kamu pelajari hari ini.", category: "Learning" },
  { topic: "Bagaimana progress tugasmu hari ini? Ada yang bisa dibantu?", category: "Productivity" },
  { topic: "Apa target akademikmu minggu ini?", category: "Planning" },
  { topic: "Share satu hal yang bikin kamu semangat kuliah hari ini!", category: "Motivation" },
  { topic: "Menurutmu, skill apa yang paling penting dikuasai dari matkul saat ini?", category: "Insight" },
  { topic: "Kalau bisa mengulang hari ini, apa yang ingin kamu perbaiki?", category: "Reflection" },
  { topic: "Ide project apa yang menarik untuk dikerjakan bersama?", category: "Creativity" },
  { topic: "Siapa dosen yang paling inspiratif hari ini dan kenapa?", category: "Social" },
  { topic: "Apa strategi belajarmu untuk ujian mendatang?", category: "Strategy" }
];

async function run() {
  try {
    console.log('Migrating: Creating discussion_topics table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS discussion_topics (
        id SERIAL PRIMARY KEY,
        topic TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'General',
        is_used BOOLEAN DEFAULT FALSE,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    
    console.log('Seeding initial topics...');
    for (const t of SEED_TOPICS) {
      await pool.query(`
        INSERT INTO discussion_topics (topic, category)
        SELECT $1, $2
        WHERE NOT EXISTS (SELECT 1 FROM discussion_topics WHERE topic = $1)
      `, [t.topic, t.category]);
    }
    
    console.log('Migration completed.');
  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await pool.end();
  }
}

run();
