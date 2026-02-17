import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

const CHATBOT_ENDPOINT_PATH = '/api/chatbot';
const CHATBOT_MAX_REPLY = 420;

function parseBooleanEnv(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hasBearerAuth(req) {
  const auth = String(req?.headers?.authorization || '');
  return /^Bearer\s+\S+/i.test(auth);
}

function resolveChatbotUrl(req) {
  const explicit = String(process.env.CHATBOT_PY_URL || '').trim();
  if (explicit) return explicit;

  const host = String(req?.headers?.host || '').trim();
  if (!host) return '';

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}${CHATBOT_ENDPOINT_PATH}`;
}

function localFallbackReply(message = '') {
  const lower = String(message || '').toLowerCase();
  if (/\b(halo|hai|hi|hello|hey)\b/.test(lower)) {
    return 'Hai, tim produktif. Mau mulai dari cek target harian atau rekomendasi tugas?';
  }
  if (/\b(target|goal)\b/.test(lower)) {
    return 'Target harian couple: tuntaskan 1 tugas paling urgent, 1 sesi fokus 30-45 menit, lalu check-in malam.';
  }
  if (/\b(reminder|ingatkan|ingetin|jangan lupa|alarm|notifikasi)\b/.test(lower)) {
    return 'Siap, reminder tercatat. Mulai langkah kecil dulu sekarang, lalu update progres.';
  }
  if (/\b(rekomendasi|saran|prioritas|tugas apa)\b/.test(lower)) {
    return 'Prioritas: 1) deadline terdekat, 2) tugas berdampak tinggi, 3) review singkat lalu update pasangan.';
  }
  if (/\b(toxic|tegas|gaspol|no excuse)\b/.test(lower)) {
    return 'Mode tegas: stop nunda, pilih 1 tugas inti, kerjakan 25 menit tanpa distraksi.';
  }
  return "Aku siap bantu produktivitas couple. Coba: 'cek target harian', 'rekomendasi tugas', atau 'check-in progres'.";
}

function shouldUseStatelessBot(req, body = {}) {
  if (parseBooleanEnv(process.env.CHATBOT_FORCE_STATELESS || '')) return true;
  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode === 'bot' || mode === 'chatbot') return true;
  if (body.stateless === true) return true;
  return !hasBearerAuth(req);
}

async function askPythonChatbot(req, message) {
  const endpoint = resolveChatbotUrl(req);
  if (!endpoint) return localFallbackReply(message);

  const timeoutMs = Math.max(300, Math.min(2500, Number(process.env.CHATBOT_TIMEOUT_MS || 900)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const sharedSecret = String(process.env.CHATBOT_SHARED_SECRET || '').trim();
    if (sharedSecret) headers['X-Chatbot-Secret'] = sharedSecret;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    if (!response.ok) return localFallbackReply(message);

    const data = await response.json().catch(() => ({}));
    const reply = String(data?.reply || '').trim();
    return (reply || localFallbackReply(message)).slice(0, CHATBOT_MAX_REPLY);
  } catch {
    return localFallbackReply(message);
  } finally {
    clearTimeout(timer);
  }
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: 'Message required' });
      return;
    }

    if (shouldUseStatelessBot(req, b)) {
      const reply = await askPythonChatbot(req, message);
      sendJson(res, 200, { reply });
      return;
    }

    const v = verifyToken(req, res);
    if (!v) return;
    const user = v.user;

    const r = await pool.query(
      'INSERT INTO chat_messages (user_id, message) VALUES ($1, $2) RETURNING *',
      [user, message]
    );
    sendJson(res, 200, r.rows[0]);
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 50');
    sendJson(res, 200, r.rows.reverse(), 15);
    return;
  }

  if (req.method === 'DELETE') {
    if (user !== 'Zaldy') {
      res.status(403).json({ error: 'Only admin can clear chat' });
      return;
    }
    await pool.query('DELETE FROM chat_messages');
    sendJson(res, 200, { ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
