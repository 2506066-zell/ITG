import { pool } from './_lib.js';
import {
  pushFamilyFromEventType,
  cooldownMinutesByFamily,
  horizonBucketFromPayload,
  sourceDomainFromPayload,
  buildDerivedDedupKey,
} from './push_policy_core.js';
export { pushFamilyFromEventType } from './push_policy_core.js';

const DEFAULT_DAILY_CAP = Math.max(1, Number(process.env.PUSH_DAILY_CAP_PER_USER || 6));

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function shouldAllowWhenFatigued(userId = '', family = '') {
  if (String(family) === 'urgent_due') return true;
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const seed = `${userId}:${family}:${hourBucket}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % 2 === 0; // 50% frequency during fatigue window
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
  const derivedDedup = buildDerivedDedupKey(family, dedupKey, payload);

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
  if (fatigued && !shouldAllowWhenFatigued(userId, family)) {
    return { allowed: false, reason: 'fatigue', policy: { family, dedup_key: derivedDedup, frequency: 'downshift_50' } };
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
