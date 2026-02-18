import { pool } from './_lib.js';

const DEFAULT_DAILY_CAP = Math.max(1, Number(process.env.PUSH_DAILY_CAP_PER_USER || 6));
const COOLDOWN_URGENT_MIN = Math.max(15, Number(process.env.PUSH_COOLDOWN_URGENT_MIN || 90));
const COOLDOWN_PARTNER_MIN = Math.max(30, Number(process.env.PUSH_COOLDOWN_PARTNER_MIN || 180));
const COOLDOWN_STUDY_MIN = Math.max(30, Number(process.env.PUSH_COOLDOWN_STUDY_MIN || 120));
const COOLDOWN_DEFAULT_MIN = Math.max(15, Number(process.env.PUSH_COOLDOWN_DEFAULT_MIN || 90));

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function pushFamilyFromEventType(eventType = '') {
  const key = String(eventType || '').toLowerCase();
  if (!key) return 'general';
  if (key.includes('urgent') || key.includes('overdue') || key.includes('critical')) return 'urgent_due';
  if (key.includes('support') || key.includes('assist') || key.includes('checkin')) return 'partner_assist';
  if (key.includes('study') || key.includes('focus')) return 'study_window';
  if (key.includes('reminder')) return 'reminder';
  return 'general';
}

function cooldownMinutesByFamily(family = '') {
  const key = String(family || '').toLowerCase();
  if (key === 'urgent_due') return COOLDOWN_URGENT_MIN;
  if (key === 'partner_assist') return COOLDOWN_PARTNER_MIN;
  if (key === 'study_window') return COOLDOWN_STUDY_MIN;
  return COOLDOWN_DEFAULT_MIN;
}

function horizonBucketFromPayload(payload = {}) {
  const h = Number(payload?.hours_left);
  const m = Number(payload?.minutes_left);
  if (Number.isFinite(m)) {
    if (m <= 0) return 'overdue';
    if (m <= 24 * 60) return '<=24h';
    if (m <= 48 * 60) return '<=48h';
    return '>48h';
  }
  if (Number.isFinite(h)) {
    if (h <= 0) return 'overdue';
    if (h <= 24) return '<=24h';
    if (h <= 48) return '<=48h';
    return '>48h';
  }
  return 'na';
}

function sourceDomainFromPayload(payload = {}) {
  const source = String(payload?.source || payload?.entity_type || '').toLowerCase();
  if (source.includes('assignment')) return 'assignment';
  if (source.includes('task')) return 'task';
  if (source.includes('study')) return 'study_session';
  return 'general';
}

async function ensureUserActivityEventsTable() {
  if (global._pushPolicyEventSchemaReady) return;
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
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_user_time ON user_activity_events(user_id, server_ts DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_user_activity_event_name ON user_activity_events(event_name)');
  global._pushPolicyEventSchemaReady = true;
}

export async function logPushEvent(client, userId, eventName, payload = {}, extra = {}) {
  if (!userId || !eventName) return;
  const entityType = String(extra.entityType || payload?.entity_type || 'push').slice(0, 80);
  const entityId = String(extra.entityId || payload?.entity_id || payload?.dedup_key || '').slice(0, 80) || null;
  const pagePath = String(extra.pagePath || payload?.route || '').slice(0, 200) || null;
  await client.query(
    `INSERT INTO user_activity_events (user_id, event_name, source, entity_type, entity_id, page_path, payload, client_ts)
     VALUES ($1, $2, 'push-engine', $3, $4, $5, $6::jsonb, NOW())`,
    [userId, eventName, entityType, entityId, pagePath, JSON.stringify(payload || {})]
  );
}

async function readDailySentCount(client, userId) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name = 'push_sent'
       AND server_ts >= NOW() - INTERVAL '24 hours'`,
    [userId]
  );
  return toInt(r.rows?.[0]?.cnt, 0);
}

async function wasDuplicateRecently(client, userId, dedupKey) {
  if (!dedupKey) return false;
  const r = await client.query(
    `SELECT 1
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name = 'push_sent'
       AND payload->>'dedup_key' = $2
       AND server_ts >= NOW() - INTERVAL '48 hours'
     LIMIT 1`,
    [userId, dedupKey]
  );
  return r.rowCount > 0;
}

async function inFamilyCooldown(client, userId, family, cooldownMin) {
  const r = await client.query(
    `SELECT 1
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name = 'push_sent'
       AND payload->>'event_family' = $2
       AND server_ts >= NOW() - ($3::int * INTERVAL '1 minute')
     LIMIT 1`,
    [userId, family, cooldownMin]
  );
  return r.rowCount > 0;
}

async function isUserFatigued(client, userId) {
  const r = await client.query(
    `SELECT event_name
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name IN ('push_sent', 'push_opened', 'push_action_start', 'push_action_snooze', 'push_action_done')
       AND server_ts >= NOW() - INTERVAL '24 hours'
     ORDER BY server_ts DESC
     LIMIT 30`,
    [userId]
  );
  const events = r.rows.map((x) => String(x.event_name || '').trim());
  let sentSinceLastEngage = 0;
  for (const name of events) {
    if (name === 'push_opened' || name === 'push_action_start' || name === 'push_action_snooze' || name === 'push_action_done') break;
    if (name === 'push_sent') sentSinceLastEngage += 1;
  }
  return sentSinceLastEngage >= 3;
}

export async function evaluatePushPolicy(client, {
  userId,
  eventType = '',
  eventFamily = '',
  dedupKey = '',
  payload = {},
} = {}) {
  if (!userId) return { allowed: false, reason: 'missing_user' };
  await ensureUserActivityEventsTable();

  const family = eventFamily || pushFamilyFromEventType(eventType);
  const cooldownMin = cooldownMinutesByFamily(family);
  const horizonBucket = horizonBucketFromPayload(payload);
  const sourceDomain = sourceDomainFromPayload(payload);
  const derivedDedup = dedupKey || `${family}:${sourceDomain}:${horizonBucket}:${String(payload?.item_id || payload?.entity_id || 'none')}`;

  const [dailyCount, duplicate, cooldownHit, fatigued] = await Promise.all([
    readDailySentCount(client, userId),
    wasDuplicateRecently(client, userId, derivedDedup),
    inFamilyCooldown(client, userId, family, cooldownMin),
    isUserFatigued(client, userId),
  ]);

  if (dailyCount >= DEFAULT_DAILY_CAP) {
    return { allowed: false, reason: 'daily_cap', policy: { family, dedup_key: derivedDedup, daily_count: dailyCount } };
  }
  if (duplicate) {
    return { allowed: false, reason: 'duplicate', policy: { family, dedup_key: derivedDedup } };
  }
  if (cooldownHit) {
    return { allowed: false, reason: 'cooldown', policy: { family, dedup_key: derivedDedup, cooldown_min: cooldownMin } };
  }
  if (fatigued && family !== 'urgent_due') {
    return { allowed: false, reason: 'fatigue', policy: { family, dedup_key: derivedDedup } };
  }
  return {
    allowed: true,
    reason: 'ok',
    policy: {
      family,
      dedup_key: derivedDedup,
      source_domain: sourceDomain,
      horizon_bucket: horizonBucket,
      daily_count: dailyCount,
    },
  };
}
