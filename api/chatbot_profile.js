import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

const DEFAULT_PROFILE = Object.freeze({
  tone_mode: 'supportive',
  focus_minutes: 25,
  focus_window: 'any',
  recent_intents: [],
});

function normalizeToneMode(raw = '') {
  const tone = String(raw || '').trim().toLowerCase();
  if (tone === 'strict' || tone === 'balanced' || tone === 'supportive') return tone;
  return DEFAULT_PROFILE.tone_mode;
}

function normalizeFocusMinutes(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_PROFILE.focus_minutes;
  return Math.max(10, Math.min(180, Math.round(value)));
}

function normalizeFocusWindow(raw = '') {
  const windowName = String(raw || '').trim().toLowerCase();
  if (windowName === 'morning' || windowName === 'afternoon' || windowName === 'evening' || windowName === 'any') {
    return windowName;
  }
  return DEFAULT_PROFILE.focus_window;
}

function normalizeRecentIntents(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const value = String(item || '').trim().toLowerCase();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeProfile(raw = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    tone_mode: normalizeToneMode(data.tone_mode),
    focus_minutes: normalizeFocusMinutes(data.focus_minutes),
    focus_window: normalizeFocusWindow(data.focus_window),
    recent_intents: normalizeRecentIntents(data.recent_intents),
  };
}

function toProfilePayload(userId, row = null) {
  const normalized = normalizeProfile(row || DEFAULT_PROFILE);
  return {
    user_id: userId,
    tone_mode: normalized.tone_mode,
    focus_minutes: normalized.focus_minutes,
    focus_window: normalized.focus_window,
    recent_intents: normalized.recent_intents,
    updated_at: row?.updated_at || null,
  };
}

export async function ensureChatbotProfileSchema() {
  if (global._chatbotProfileSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chatbot_profiles (
      user_id VARCHAR(60) PRIMARY KEY,
      tone_mode VARCHAR(20) NOT NULL DEFAULT 'supportive',
      focus_minutes INTEGER NOT NULL DEFAULT 25,
      focus_window VARCHAR(20) NOT NULL DEFAULT 'any',
      recent_intents JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  global._chatbotProfileSchemaReady = true;
}

async function getChatbotProfile(userId) {
  await ensureChatbotProfileSchema();
  const r = await pool.query(
    `SELECT user_id, tone_mode, focus_minutes, focus_window, recent_intents, updated_at
     FROM chatbot_profiles
     WHERE user_id=$1`,
    [userId]
  );
  if (r.rowCount === 0) return toProfilePayload(userId, null);
  return toProfilePayload(userId, r.rows[0]);
}

async function upsertChatbotProfile(userId, patch = {}) {
  await ensureChatbotProfileSchema();
  const current = await getChatbotProfile(userId);
  const merged = normalizeProfile({
    tone_mode: patch.tone_mode !== undefined ? patch.tone_mode : current.tone_mode,
    focus_minutes: patch.focus_minutes !== undefined ? patch.focus_minutes : current.focus_minutes,
    focus_window: patch.focus_window !== undefined ? patch.focus_window : current.focus_window,
    recent_intents: patch.recent_intents !== undefined ? patch.recent_intents : current.recent_intents,
  });

  const r = await pool.query(
    `INSERT INTO chatbot_profiles (user_id, tone_mode, focus_minutes, focus_window, recent_intents, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       tone_mode=EXCLUDED.tone_mode,
       focus_minutes=EXCLUDED.focus_minutes,
       focus_window=EXCLUDED.focus_window,
       recent_intents=EXCLUDED.recent_intents,
       updated_at=NOW()
     RETURNING user_id, tone_mode, focus_minutes, focus_window, recent_intents, updated_at`,
    [userId, merged.tone_mode, merged.focus_minutes, merged.focus_window, JSON.stringify(merged.recent_intents)]
  );

  return toProfilePayload(userId, r.rows[0]);
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const userId = v.user;

  if (req.method === 'GET') {
    const profile = await getChatbotProfile(userId);
    sendJson(res, 200, profile, 10);
    return;
  }

  if (req.method === 'PUT' || req.method === 'POST') {
    const body = req.body || await readBody(req);
    const profile = await upsertChatbotProfile(userId, body || {});
    sendJson(res, 200, profile);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});

