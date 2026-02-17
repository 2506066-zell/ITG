import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

const MAX_BATCH_EVENTS = 50;
const MAX_EVENT_NAME = 80;
const MAX_SESSION_ID = 80;
const MAX_PAGE_PATH = 200;
const MAX_ENTITY_TEXT = 80;
const MAX_SOURCE = 40;
const MAX_PAYLOAD_CHARS = 6000;

function clampLimit(raw, fallback = 80, min = 1, max = 300) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function trimText(value, maxLen) {
  return String(value || '').trim().slice(0, maxLen);
}

function safePayloadObject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const serialized = JSON.stringify(raw);
  if (serialized.length <= MAX_PAYLOAD_CHARS) return raw;
  return { truncated: true, raw: serialized.slice(0, MAX_PAYLOAD_CHARS) };
}

function parseClientTime(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeEvent(input = {}, fallbackPage = '') {
  if (!input || typeof input !== 'object') return null;
  const eventName = trimText(input.event_name || input.event || input.name, MAX_EVENT_NAME).toLowerCase();
  if (!eventName) return null;

  const pagePath = trimText(input.page_path || input.page || fallbackPage, MAX_PAGE_PATH);
  const source = trimText(input.source || 'web', MAX_SOURCE) || 'web';
  const sessionId = trimText(input.session_id || input.session || '', MAX_SESSION_ID);
  const entityType = trimText(input.entity_type || input.entityType || '', MAX_ENTITY_TEXT);
  const entityId = trimText(input.entity_id || input.entityId || '', MAX_ENTITY_TEXT);
  const payload = safePayloadObject(input.payload || input.meta || {});
  const clientTs = parseClientTime(input.client_ts || input.clientTs || '');

  return {
    event_name: eventName,
    page_path: pagePath || null,
    source,
    session_id: sessionId || null,
    entity_type: entityType || null,
    entity_id: entityId || null,
    payload,
    client_ts: clientTs,
  };
}

async function ensureUserActivitySchema() {
  if (global._userActivitySchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_activity_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      session_id VARCHAR(80),
      event_name VARCHAR(80) NOT NULL,
      page_path VARCHAR(200),
      entity_type VARCHAR(80),
      entity_id VARCHAR(80),
      source VARCHAR(40) NOT NULL DEFAULT 'web',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      client_ts TIMESTAMPTZ,
      server_ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_user_time ON user_activity_events(user_id, server_ts DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_event_name ON user_activity_events(event_name)');
  global._userActivitySchemaReady = true;
}

async function insertActivityEvents(userId, events) {
  if (!Array.isArray(events) || !events.length) return 0;
  await ensureUserActivitySchema();

  const payload = JSON.stringify(events);
  const result = await pool.query(
    `
      INSERT INTO user_activity_events (
        user_id,
        session_id,
        event_name,
        page_path,
        entity_type,
        entity_id,
        source,
        payload,
        client_ts,
        server_ts
      )
      SELECT
        $1::varchar,
        x.session_id,
        x.event_name,
        x.page_path,
        x.entity_type,
        x.entity_id,
        x.source,
        x.payload,
        x.client_ts,
        NOW()
      FROM jsonb_to_recordset($2::jsonb) AS x(
        session_id text,
        event_name text,
        page_path text,
        entity_type text,
        entity_id text,
        source text,
        payload jsonb,
        client_ts timestamptz
      )
    `,
    [userId, payload]
  );
  return Number(result.rowCount || 0);
}

async function readUserActivityEvents(userId, queryUrl) {
  await ensureUserActivitySchema();
  const limit = clampLimit(queryUrl.searchParams.get('limit'), 80, 1, 300);
  const eventName = trimText(queryUrl.searchParams.get('event_name') || '', MAX_EVENT_NAME).toLowerCase();
  const pagePath = trimText(queryUrl.searchParams.get('page_path') || '', MAX_PAGE_PATH);

  const values = [userId];
  const filters = ['user_id=$1'];

  if (eventName) {
    values.push(eventName);
    filters.push(`event_name=$${values.length}`);
  }
  if (pagePath) {
    values.push(pagePath);
    filters.push(`page_path=$${values.length}`);
  }

  values.push(limit);
  const sql = `
    SELECT
      id,
      user_id,
      session_id,
      event_name,
      page_path,
      entity_type,
      entity_id,
      source,
      payload,
      client_ts,
      server_ts
    FROM user_activity_events
    WHERE ${filters.join(' AND ')}
    ORDER BY server_ts DESC
    LIMIT $${values.length}
  `;
  const result = await pool.query(sql, values);
  return result.rows;
}

async function readLegacyEntityActivity(entityType, entityId) {
  const result = await pool.query(
    'SELECT * FROM activity_logs WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC',
    [entityType, entityId]
  );
  return result.rows;
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const userId = String(v.user || '').trim();

  if (req.method === 'POST') {
    const body = req.body || await readBody(req);
    const fallbackPage = trimText(body.page_path || body.page || '', MAX_PAGE_PATH);
    const listRaw = Array.isArray(body.events) ? body.events : [body];
    const normalized = [];

    for (const item of listRaw.slice(0, MAX_BATCH_EVENTS)) {
      const event = normalizeEvent(item, fallbackPage);
      if (!event) continue;
      normalized.push(event);
    }

    if (!normalized.length) {
      res.status(400).json({ error: 'No valid events' });
      return;
    }

    const inserted = await insertActivityEvents(userId, normalized);
    sendJson(res, 200, { ok: true, accepted: inserted });
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const entityType = trimText(url.searchParams.get('entity_type') || '', MAX_ENTITY_TEXT);
    const entityId = trimText(url.searchParams.get('entity_id') || '', MAX_ENTITY_TEXT);

    if (entityType && entityId) {
      const rows = await readLegacyEntityActivity(entityType, entityId);
      sendJson(res, 200, rows, 30);
      return;
    }

    const rows = await readUserActivityEvents(userId, url);
    sendJson(res, 200, rows, 20);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
