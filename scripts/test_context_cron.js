import 'dotenv/config';
import http from 'http';

const BASE = process.env.API_URL || 'http://localhost:3000/api';

async function testCron() {
  console.log('Testing Context-Aware Cron Job...');
  try {
    const res = await fetch(`${BASE}/cron/context-checks`, {
      method: 'GET' // or POST/GET depending on how local server routes it (in prod it's GET via cron)
    });
    
    // In local_server.js we map /api/... to files, but api/cron/xxx might need manual mapping 
    // or we can test by importing the handler directly if fetch fails.
    
    if (res.ok) {
      const json = await res.json();
      console.log('Success:', json);
    } else {
      console.log('Fetch status:', res.status);
      const txt = await res.text();
      console.log('Response:', txt);
    }
  } catch (err) {
    console.error('Test failed:', err);
  }
}

// Direct handler test if fetch is tricky with current local_server setup
import handler from '../api/cron/context_checks.js';
import { pool } from '../api/_lib.js';

async function directTest() {
  console.log('Running Direct Handler Test...');
  const req = { method: 'GET', headers: {} };
  const res = {
    status: (code) => ({
      json: (data) => console.log(`[${code}]`, data)
    }),
    setHeader: () => {},
    json: (data) => console.log('[200]', data)
  };
  
  try {
    await handler(req, res);
  } catch (err) {
    console.error('Handler Error:', err);
  } finally {
    // pool.end() might be needed if script hangs, but _lib uses a global pool
    // In a script we might want to force exit
    setTimeout(() => process.exit(0), 1000);
  }
}

directTest();
