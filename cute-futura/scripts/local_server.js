import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import fs from 'fs';

// Load .env manually if needed, or rely on dotenv
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// API Route Wrapper
const apiHandler = async (req, res, handlerPath) => {
  try {
    const module = await import(handlerPath);
    await module.default(req, res);
  } catch (err) {
    console.error(`Error in ${handlerPath}:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error', details: err.message });
    }
  }
};

// Define Routes manually to match Vercel structure
const routes = [
  { path: '/api/login', file: '../api/login.js' },
  { path: '/api/tasks', file: '../api/tasks.js' },
  { path: '/api/memories', file: '../api/memories.js' },
  { path: '/api/assignments', file: '../api/assignments.js' },
  { path: '/api/anniversary', file: '../api/anniversary.js' },
  { path: '/api/goals', file: '../api/goals.js' },
  { path: '/api/activity', file: '../api/activity.js' },
  { path: '/api/stats', file: '../api/stats.js' },
  { path: '/api/schedule', file: '../api/schedule.js' },
  { path: '/api/chat', file: '../api/chat.js' },
  { path: '/api/health', file: '../api/health.js' },
  { path: '/api/monthly', file: '../api/monthly.js' },
  { path: '/api/monthly_stats', file: '../api/monthly_stats.js' }
];

routes.forEach(route => {
  app.all(route.path, (req, res) => apiHandler(req, res, route.file));
});

// Fallback to index.html for SPA (if needed) or just 404
app.use((req, res) => {
    if (req.path.startsWith('/api')) {
        res.status(404).json({ error: 'Not Found' });
    } else {
        res.sendFile(path.join(__dirname, '../public/index.html'));
    }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
