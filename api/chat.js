import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

const CHATBOT_ENDPOINT_PATH = '/api/chatbot';
const CHATBOT_MAX_REPLY = 420;
const CHATBOT_MAX_SUGGESTIONS = 4;
const CHATBOT_MAX_RECENT_INTENTS = 6;

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

function normalizeChatbotSuggestions(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    let label = '';
    let command = '';
    let tone = 'info';
    if (typeof item === 'string') {
      label = item.trim();
      command = item.trim();
    } else if (item && typeof item === 'object') {
      label = String(item.label || item.text || item.command || '').trim();
      command = String(item.command || item.message || item.prompt || '').trim();
      tone = String(item.tone || 'info').trim() || 'info';
    }
    if (!label || !command) continue;
    const key = `${label.toLowerCase()}::${command.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, command, tone });
    if (out.length >= CHATBOT_MAX_SUGGESTIONS) break;
  }
  return out;
}

function normalizeChatbotContext(input) {
  if (!input || typeof input !== 'object') return null;

  const toneRaw = String(input.tone_mode || input.style || '').trim().toLowerCase();
  const toneMode = ['supportive', 'strict', 'balanced'].includes(toneRaw) ? toneRaw : 'supportive';

  const focusMinutesNum = Number(input.focus_minutes);
  const focusMinutes = Number.isFinite(focusMinutesNum)
    ? Math.max(10, Math.min(180, Math.round(focusMinutesNum)))
    : 25;

  const focusWindowRaw = String(input.focus_window || '').trim().toLowerCase();
  const focusWindow = ['any', 'morning', 'afternoon', 'evening'].includes(focusWindowRaw) ? focusWindowRaw : 'any';

  const recentIntents = Array.isArray(input.recent_intents)
    ? input.recent_intents
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, CHATBOT_MAX_RECENT_INTENTS)
    : [];

  return {
    tone_mode: toneMode,
    focus_minutes: focusMinutes,
    focus_window: focusWindow,
    recent_intents: recentIntents,
  };
}

function localFallbackPayload(message = '') {
  const lower = String(message || '').toLowerCase();
  if (/\b(halo|hai|hi|hello|hey)\b/.test(lower)) {
    return {
      reply: 'Hai, tim produktif. Mau mulai dari cek target harian atau rekomendasi tugas?',
      intent: 'greeting',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
        { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
        { label: 'Evaluasi', command: 'evaluasi hari ini', tone: 'info' },
      ]),
    };
  }
  if (/\b(target|goal)\b/.test(lower)) {
    return {
      reply: 'Target harian couple: tuntaskan 1 tugas paling urgent, 1 sesi fokus 30-45 menit, lalu check-in malam.',
      intent: 'check_daily_target',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Check-In', command: 'check-in progres hari ini', tone: 'info' },
        { label: 'Reminder 25m', command: 'ingatkan aku fokus 25 menit', tone: 'warning' },
      ]),
    };
  }
  if (/\b(reminder|ingatkan|ingetin|jangan lupa|alarm|notifikasi)\b/.test(lower)) {
    return {
      reply: 'Siap, reminder tercatat. Mulai langkah kecil dulu sekarang, lalu update progres.',
      intent: 'reminder_ack',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Mulai 25m', command: 'oke mulai fokus 25 menit', tone: 'success' },
        { label: 'Evaluasi', command: 'evaluasi singkat', tone: 'info' },
      ]),
    };
  }
  if (/\b(rekomendasi|saran|prioritas|tugas apa)\b/.test(lower)) {
    return {
      reply: 'Prioritas: 1) deadline terdekat, 2) tugas berdampak tinggi, 3) review singkat lalu update pasangan.',
      intent: 'recommend_task',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Gas Sekarang', command: 'oke gas sekarang', tone: 'success' },
        { label: 'Check-In', command: 'check-in progres tugas', tone: 'info' },
      ]),
    };
  }
  if (/\b(toxic|tegas|gaspol|no excuse)\b/.test(lower)) {
    return {
      reply: 'Mode tegas: stop nunda, pilih 1 tugas inti, kerjakan 25 menit tanpa distraksi.',
      intent: 'toxic_motivation',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Gas 25m', command: 'oke gas fokus 25 menit', tone: 'critical' },
        { label: 'Prioritas', command: 'rekomendasi tugas prioritas', tone: 'warning' },
      ]),
    };
  }
  return {
    reply: "Aku siap bantu produktivitas couple. Coba: 'cek target harian', 'rekomendasi tugas', atau 'check-in progres'.",
    intent: 'fallback',
    suggestions: normalizeChatbotSuggestions([
      { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
      { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
    ]),
  };
}

function shouldUseStatelessBot(req, body = {}) {
  if (parseBooleanEnv(process.env.CHATBOT_FORCE_STATELESS || '')) return true;
  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode === 'bot' || mode === 'chatbot') return true;
  if (body.stateless === true) return true;
  return !hasBearerAuth(req);
}

async function askPythonChatbot(req, message, contextHint = null) {
  const endpoint = resolveChatbotUrl(req);
  if (!endpoint) return localFallbackPayload(message);

  const timeoutMs = Math.max(300, Math.min(2500, Number(process.env.CHATBOT_TIMEOUT_MS || 900)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const sharedSecret = String(process.env.CHATBOT_SHARED_SECRET || '').trim();
    if (sharedSecret) headers['X-Chatbot-Secret'] = sharedSecret;

    const context = normalizeChatbotContext(contextHint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, context }),
      signal: controller.signal,
    });
    if (!response.ok) return localFallbackPayload(message);

    const data = await response.json().catch(() => ({}));
    const reply = String(data?.reply || '').trim();
    if (!reply) return localFallbackPayload(message);
    return {
      reply: reply.slice(0, CHATBOT_MAX_REPLY),
      intent: String(data?.intent || '').trim().toLowerCase(),
      adaptive: data?.adaptive && typeof data.adaptive === 'object' ? data.adaptive : null,
      suggestions: normalizeChatbotSuggestions(data?.suggestions),
    };
  } catch {
    return localFallbackPayload(message);
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
      const payload = await askPythonChatbot(req, message, b.context);
      sendJson(res, 200, {
        reply: String(payload?.reply || '').slice(0, CHATBOT_MAX_REPLY),
        intent: String(payload?.intent || '').trim().toLowerCase() || 'fallback',
        adaptive: payload?.adaptive && typeof payload.adaptive === 'object' ? payload.adaptive : null,
        suggestions: normalizeChatbotSuggestions(payload?.suggestions),
      });
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
