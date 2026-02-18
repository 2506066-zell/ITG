import webpush from 'web-push';
import { pool, verifyToken, readBody, withErrorHandling, sendJson } from './_lib.js';
import { verifyActionToken } from './action_token.js';
import { logPushEvent } from './push_policy.js';

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const DEFAULT_SNOOZE_MINUTES = Math.max(5, Number(process.env.PUSH_DEFAULT_SNOOZE_MIN || 30));

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(vapidSubject, publicVapidKey, privateVapidKey);
}

async function ensureReminderTable(client) {
  if (global._notificationReminderSchemaReady) return;
  await client.query(`
    CREATE TABLE IF NOT EXISTS z_ai_reminders (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      target_user VARCHAR(60),
      reminder_text TEXT NOT NULL,
      remind_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      source_command TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    )
  `);
  await client.query('CREATE INDEX IF NOT EXISTS idx_zai_reminders_due ON z_ai_reminders(status, remind_at ASC)');
  await client.query('CREATE INDEX IF NOT EXISTS idx_zai_reminders_user ON z_ai_reminders(target_user, status, remind_at ASC)');
  global._notificationReminderSchemaReady = true;
}

function normalizePath(req) {
  const u = new URL(req.url, 'http://x');
  const p = String(u.searchParams.get('path') || '').trim().replace(/^\/+|\/+$/g, '');
  return p;
}

function normalizeAction(value = '') {
  const action = String(value || '').trim().toLowerCase();
  if (action === 'start' || action === 'snooze' || action === 'done' || action === 'open') return action;
  return '';
}

async function hasColumn(client, tableName, columnName) {
  const r = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return r.rowCount > 0;
}

async function resolveActor(req, actionToken = '') {
  const maybeAuth = verifyToken(req, { status: () => ({ json: () => null }) });
  if (maybeAuth?.user) {
    return { userId: String(maybeAuth.user), tokenPayload: null };
  }
  const verified = verifyActionToken(actionToken);
  if (!verified.ok) return { userId: '', tokenPayload: verified.payload || null, error: verified.reason };
  return {
    userId: String(verified.payload?.user_id || '').trim(),
    tokenPayload: verified.payload,
    error: '',
  };
}

function updateResult(base = {}) {
  return {
    ok: true,
    status: 'ok',
    entity_type: base.entityType || '',
    entity_id: base.entityId || '',
    action: base.action || '',
    changed: false,
  };
}

async function applyTaskAction(client, action, entityId, userId, payload = {}) {
  const result = updateResult({ entityType: 'task', entityId, action });
  if (action === 'done') {
    const r = await client.query(
      `UPDATE tasks
       SET completed = TRUE,
           completed_at = COALESCE(completed_at, NOW()),
           completed_by = COALESCE(completed_by, $2),
           updated_by = $2,
           version = COALESCE(version, 0) + 1
       WHERE id = $1
         AND is_deleted = FALSE
         AND completed = FALSE
       RETURNING id`,
      [Number(entityId), userId]
    );
    if (r.rowCount === 0) return { ...result, status: 'already_done', changed: false };
    return { ...result, changed: true };
  }

  if (action === 'start') {
    const hasStartedAt = await hasColumn(client, 'tasks', 'started_at');
    if (hasStartedAt) {
      await client.query(
        `UPDATE tasks
         SET started_at = COALESCE(started_at, NOW()),
             updated_by = $2,
             version = COALESCE(version, 0) + 1
         WHERE id = $1
           AND is_deleted = FALSE`,
        [Number(entityId), userId]
      );
    }
    return { ...result, changed: true, status: hasStartedAt ? 'started' : 'started_logged' };
  }

  const snoozeMin = Math.max(5, Number(payload?.snooze_minutes || DEFAULT_SNOOZE_MINUTES));
  await client.query(
    `INSERT INTO z_ai_reminders (
      user_id, target_user, reminder_text, remind_at, status, source_command, payload, created_at
    )
    SELECT
      $2, $2,
      COALESCE(NULLIF(t.title, ''), 'Lanjutkan tugas sekarang'),
      NOW() + ($3::int * INTERVAL '1 minute'),
      'pending',
      'push_action_snooze',
      jsonb_build_object('entity_type','task','entity_id',$1::text,'snooze_minutes',$3::int),
      NOW()
    FROM tasks t
    WHERE t.id = $1`,
    [Number(entityId), userId, snoozeMin]
  );
  return { ...result, changed: true, status: 'snoozed', snooze_minutes: snoozeMin };
}

async function applyAssignmentAction(client, action, entityId, userId, payload = {}) {
  const result = updateResult({ entityType: 'assignment', entityId, action });
  if (action === 'done') {
    const r = await client.query(
      `UPDATE assignments
       SET completed = TRUE,
           completed_at = COALESCE(completed_at, NOW()),
           completed_by = COALESCE(completed_by, $2)
       WHERE id = $1
         AND completed = FALSE
       RETURNING id`,
      [Number(entityId), userId]
    );
    if (r.rowCount === 0) return { ...result, status: 'already_done', changed: false };
    return { ...result, changed: true };
  }

  if (action === 'start') {
    const hasStartedAt = await hasColumn(client, 'assignments', 'started_at');
    if (hasStartedAt) {
      await client.query(
        `UPDATE assignments
         SET started_at = COALESCE(started_at, NOW())
         WHERE id = $1`,
        [Number(entityId)]
      );
    }
    return { ...result, changed: true, status: hasStartedAt ? 'started' : 'started_logged' };
  }

  const snoozeMin = Math.max(5, Number(payload?.snooze_minutes || DEFAULT_SNOOZE_MINUTES));
  await client.query(
    `INSERT INTO z_ai_reminders (
      user_id, target_user, reminder_text, remind_at, status, source_command, payload, created_at
    )
    SELECT
      $2, $2,
      COALESCE(NULLIF(a.title, ''), 'Lanjutkan tugas kuliah sekarang'),
      NOW() + ($3::int * INTERVAL '1 minute'),
      'pending',
      'push_action_snooze',
      jsonb_build_object('entity_type','assignment','entity_id',$1::text,'snooze_minutes',$3::int),
      NOW()
    FROM assignments a
    WHERE a.id = $1`,
    [Number(entityId), userId, snoozeMin]
  );
  return { ...result, changed: true, status: 'snoozed', snooze_minutes: snoozeMin };
}

async function applyReminderAction(client, action, entityId, userId, payload = {}) {
  const result = updateResult({ entityType: 'reminder', entityId, action });
  if (action === 'done') {
    await client.query(
      `UPDATE z_ai_reminders
       SET status = 'done', cancelled_at = NOW()
       WHERE id = $1
         AND (target_user = $2 OR user_id = $2)`,
      [Number(entityId), userId]
    );
    return { ...result, changed: true };
  }

  if (action === 'start') {
    await client.query(
      `UPDATE z_ai_reminders
       SET status = 'sent'
       WHERE id = $1
         AND (target_user = $2 OR user_id = $2)`,
      [Number(entityId), userId]
    );
    return { ...result, changed: true, status: 'started_logged' };
  }

  const snoozeMin = Math.max(5, Number(payload?.snooze_minutes || DEFAULT_SNOOZE_MINUTES));
  await client.query(
    `UPDATE z_ai_reminders
     SET status = 'pending',
         remind_at = NOW() + ($3::int * INTERVAL '1 minute'),
         payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object('snooze_minutes', $3::int, 'snoozed_at', NOW())
     WHERE id = $1
       AND (target_user = $2 OR user_id = $2)`,
    [Number(entityId), userId, snoozeMin]
  );
  return { ...result, changed: true, status: 'snoozed', snooze_minutes: snoozeMin };
}

async function applyStudySessionAction(client, action, entityId, userId, payload = {}) {
  const result = updateResult({ entityType: 'study_session', entityId, action });
  const [planDate, sessionKey] = String(entityId || '').split(':');
  if (!planDate || !sessionKey) return { ...result, ok: false, status: 'invalid_session_id', changed: false };
  if (action === 'done') {
    await client.query(
      `UPDATE study_session_logs
       SET status = 'done',
           completed_at = COALESCE(completed_at, NOW())
       WHERE user_id = $1
         AND plan_date = $2
         AND session_key = $3`,
      [userId, planDate, sessionKey]
    );
    return { ...result, changed: true };
  }
  if (action === 'snooze') {
    const snoozeMin = Math.max(5, Number(payload?.snooze_minutes || DEFAULT_SNOOZE_MINUTES));
    await client.query(
      `INSERT INTO z_ai_reminders (
        user_id, target_user, reminder_text, remind_at, status, source_command, payload, created_at
      )
      VALUES ($1, $1, 'Lanjutkan sesi belajar', NOW() + ($2::int * INTERVAL '1 minute'), 'pending', 'push_action_snooze',
        jsonb_build_object('entity_type','study_session','entity_id',$3,'snooze_minutes',$2::int), NOW())`,
      [userId, snoozeMin, `${planDate}:${sessionKey}`]
    );
    return { ...result, changed: true, status: 'snoozed', snooze_minutes: snoozeMin };
  }
  return { ...result, changed: true, status: 'started_logged' };
}

async function applyNotificationAction(client, action, entityType, entityId, userId, payload = {}) {
  const key = String(entityType || '').trim().toLowerCase();
  if (key === 'task') return applyTaskAction(client, action, entityId, userId, payload);
  if (key === 'assignment') return applyAssignmentAction(client, action, entityId, userId, payload);
  if (key === 'reminder') return applyReminderAction(client, action, entityId, userId, payload);
  if (key === 'study_session') return applyStudySessionAction(client, action, entityId, userId, payload);
  return { ok: false, status: 'unsupported_entity', entity_type: key, entity_id: String(entityId || ''), action, changed: false };
}

async function handleActionRequest(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const body = req.body || await readBody(req);
  const action = normalizeAction(body?.action);
  const token = String(body?.token || '').trim();
  if (!action || !token) {
    res.status(400).json({ error: 'action and token required' });
    return;
  }

  const actor = await resolveActor(req, token);
  if (!actor.userId) {
    const status = actor.error === 'expired' ? 410 : 401;
    res.status(status).json({ error: actor.error === 'expired' ? 'Aksi kadaluarsa' : 'Unauthorized' });
    return;
  }

  const tokenPayload = actor.tokenPayload || {};
  const entityType = String(tokenPayload?.entity_type || body?.entity_type || '').trim().toLowerCase();
  const entityId = String(tokenPayload?.entity_id || body?.entity_id || '').trim();
  if (!entityType || !entityId) {
    res.status(400).json({ error: 'entity_type dan entity_id wajib' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureReminderTable(client);
    if (action === 'open') {
      await logPushEvent(client, actor.userId, 'push_opened', {
        entity_type: entityType,
        entity_id: entityId,
        action: 'open',
        route: String(tokenPayload?.route_fallback || body?.route_fallback || '/'),
        event_family: String(tokenPayload?.event_family || body?.event_family || 'general'),
      });
      await client.query('COMMIT');
      sendJson(res, 200, { ok: true, status: 'opened', action: 'open', entity_type: entityType, entity_id: entityId });
      return;
    }
    const result = await applyNotificationAction(client, action, entityType, entityId, actor.userId, body || {});
    if (!result.ok) {
      await client.query('ROLLBACK');
      res.status(400).json(result);
      return;
    }

    await logPushEvent(client, actor.userId, `push_action_${action}`, {
      entity_type: entityType,
      entity_id: entityId,
      action,
      route: String(tokenPayload?.route_fallback || body?.route_fallback || '/'),
      event_family: String(tokenPayload?.event_family || body?.event_family || 'general'),
    });
    await client.query('COMMIT');
    sendJson(res, 200, {
      ...result,
      route_fallback: String(tokenPayload?.route_fallback || body?.route_fallback || '/'),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function handleSubscribe(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { publicKey: publicVapidKey });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;
  const subscription = req.body || await readBody(req);
  const userId = String(v.user || '').trim();
  if (!subscription?.endpoint) {
    res.status(400).json({ error: 'Invalid subscription payload' });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET keys = EXCLUDED.keys, updated_at = NOW()`,
      [userId, subscription.endpoint, JSON.stringify(subscription.keys || {})]
    );
    sendJson(res, 201, { ok: true });
  } finally {
    client.release();
  }
}

export default withErrorHandling(async function handler(req, res) {
  const path = normalizePath(req);
  if (path.startsWith('notifications/action')) {
    await handleActionRequest(req, res);
    return;
  }
  await handleSubscribe(req, res);
});

export async function sendNotificationToUser(userId, payload) {
  if (!publicVapidKey || !privateVapidKey) return 0;

  const r = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  let sentCount = 0;
  const promises = r.rows.map(async (sub) => {
    let keys = sub.keys;
    if (typeof keys === 'string') {
      try { keys = JSON.parse(keys); } catch { keys = null; }
    }
    if (!keys || !keys.p256dh || !keys.auth) return;

    const pushSubscription = { endpoint: sub.endpoint, keys };
    try {
      await webpush.sendNotification(pushSubscription, JSON.stringify(payload));
      sentCount += 1;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      } else {
        console.error('Push error', err);
      }
    }
  });
  await Promise.all(promises);
  return sentCount;
}
