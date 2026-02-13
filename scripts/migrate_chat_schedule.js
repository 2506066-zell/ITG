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
        if (key && value) process.env[key.trim()] = value.trim();
    });
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
});

async function migrate() {
    try {
        console.log('Migrating Chat & Schedule...');

        const chatSql = fs.readFileSync(path.resolve(__dirname, '../db/chat_schema.sql'), 'utf-8');
        await pool.query(chatSql);
        console.log('Chat schema applied.');

        const scheduleSql = fs.readFileSync(path.resolve(__dirname, '../db/schedule_schema.sql'), 'utf-8');
        await pool.query(scheduleSql);
        console.log('Schedule schema applied.');

    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}

migrate();
