import 'dotenv/config';
import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

const hasIntegrationEnv = Boolean(
  process.env.JWT_SECRET
  && (process.env.ZN_DATABASE_URL || process.env.NZ_DATABASE_URL || process.env.DATABASE_URL)
);

function buildAuthHeader(userId) {
  const token = jwt.sign(
    { user: userId },
    process.env.JWT_SECRET,
    {
      audience: 'cute-futura',
      issuer: 'cute-futura',
      expiresIn: '1h',
    }
  );
  return `Bearer ${token}`;
}

function createResCollector() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    headersSent: false,
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = Number(code);
      return this;
    },
    json(data) {
      this.payload = data;
      this.headersSent = true;
      return this;
    },
  };
}

async function invoke(handler, req) {
  const res = createResCollector();
  await handler(req, res);
  return res;
}

async function withApiDeps() {
  const [{ pool }, notificationsMod, pushMetricsMod, actionTokenMod, proactiveMod] = await Promise.all([
    import('../api/_lib.js'),
    import('../api/notifications.js'),
    import('../api/push_metrics.js'),
    import('../api/action_token.js'),
    import('../api/proactive.js'),
  ]);
  return {
    pool,
    notificationsHandler: notificationsMod.default,
    pushMetricsHandler: pushMetricsMod.default,
    createActionToken: actionTokenMod.createActionToken,
    proactiveHandler: proactiveMod.default,
  };
}

if (!hasIntegrationEnv) {
  test('push flow integration skipped (missing env)', { skip: true }, () => {});
} else {
  test('integration: push_sent events reflected in /api/push_metrics', async () => {
    const { pool, pushMetricsHandler } = await withApiDeps();
    const userId = `itest_metrics_${Date.now()}`;

    try {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
      await pool.query(
        `INSERT INTO user_activity_events (user_id, event_name, source, payload, server_ts)
         VALUES
          ($1, 'push_sent', 'itest', '{}'::jsonb, NOW() - INTERVAL '10 minutes'),
          ($1, 'push_sent', 'itest', '{}'::jsonb, NOW() - INTERVAL '9 minutes'),
          ($1, 'push_opened', 'itest', '{}'::jsonb, NOW() - INTERVAL '8 minutes'),
          ($1, 'push_action_done', 'itest', '{}'::jsonb, NOW() - INTERVAL '7 minutes'),
          ($1, 'push_ignored', 'itest', '{}'::jsonb, NOW() - INTERVAL '6 minutes')`,
        [userId]
      );

      const req = {
        method: 'GET',
        url: 'http://x/api/router?path=push_metrics&days=1',
        headers: {
          authorization: buildAuthHeader(userId),
        },
      };
      const res = await invoke(pushMetricsHandler, req);
      assert.equal(res.statusCode, 200);
      assert.equal(Number(res.payload.sent_count || 0), 2);
      assert.equal(Number(res.payload.opened_count || 0), 1);
      assert.equal(Number(res.payload.action_done_count || 0), 1);
      assert.equal(Number(res.payload.ignore_count || 0), 1);
    } finally {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
    }
  });

  test('integration: POST /api/notifications/action (done task) updates entity + logs action', async () => {
    const { pool, notificationsHandler, createActionToken } = await withApiDeps();
    const userId = `itest_action_${Date.now()}`;
    let taskId = 0;

    try {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
      const ins = await pool.query(
        `INSERT INTO tasks (title, completed, is_deleted, created_by, updated_by, assigned_to)
         VALUES ($1, FALSE, FALSE, $2, $2, $2)
         RETURNING id`,
        [`ITEST task ${Date.now()}`, userId]
      );
      taskId = Number(ins.rows[0].id);

      const token = createActionToken({
        user_id: userId,
        entity_type: 'task',
        entity_id: String(taskId),
        route_fallback: '/daily-tasks',
        event_family: 'urgent_due',
      }, 3600);

      const req = {
        method: 'POST',
        url: 'http://x/api/router?path=notifications/action',
        headers: {
          authorization: buildAuthHeader(userId),
        },
        body: {
          action: 'done',
          token,
          entity_type: 'task',
          entity_id: String(taskId),
        },
      };
      const res = await invoke(notificationsHandler, req);
      assert.equal(res.statusCode, 200);
      assert.equal(Boolean(res.payload.ok), true);
      assert.equal(String(res.payload.entity_type), 'task');

      const taskRes = await pool.query('SELECT completed, completed_by FROM tasks WHERE id = $1', [taskId]);
      assert.equal(Boolean(taskRes.rows[0].completed), true);
      assert.equal(String(taskRes.rows[0].completed_by || ''), userId);

      const logRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM user_activity_events
         WHERE user_id = $1
           AND event_name = 'push_action_done'
           AND payload->>'entity_type' = 'task'
           AND payload->>'entity_id' = $2`,
        [userId, String(taskId)]
      );
      assert.ok(Number(logRes.rows[0].cnt || 0) >= 1);
    } finally {
      if (taskId) await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
    }
  });

  test('integration: push_sent -> notifications/action -> /api/push_metrics chain', async () => {
    const { pool, notificationsHandler, pushMetricsHandler, createActionToken } = await withApiDeps();
    const userId = `itest_chain_${Date.now()}`;
    let assignmentId = 0;

    try {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
      const ins = await pool.query(
        `INSERT INTO assignments (title, completed, assigned_to)
         VALUES ($1, FALSE, $2)
         RETURNING id`,
        [`ITEST assignment ${Date.now()}`, userId]
      );
      assignmentId = Number(ins.rows[0].id);

      await pool.query(
        `INSERT INTO user_activity_events (user_id, event_name, source, entity_type, entity_id, payload, server_ts)
         VALUES ($1, 'push_sent', 'itest', 'assignment', $2, $3::jsonb, NOW() - INTERVAL '5 minutes')`,
        [userId, String(assignmentId), JSON.stringify({ entity_type: 'assignment', entity_id: String(assignmentId) })]
      );

      const token = createActionToken({
        user_id: userId,
        entity_type: 'assignment',
        entity_id: String(assignmentId),
        route_fallback: '/college-assignments',
        event_family: 'urgent_due',
      }, 3600);

      const actionReq = {
        method: 'POST',
        url: 'http://x/api/router?path=notifications/action',
        headers: {
          authorization: buildAuthHeader(userId),
        },
        body: {
          action: 'done',
          token,
          entity_type: 'assignment',
          entity_id: String(assignmentId),
        },
      };
      const actionRes = await invoke(notificationsHandler, actionReq);
      assert.equal(actionRes.statusCode, 200);

      const metricsReq = {
        method: 'GET',
        url: 'http://x/api/router?path=push_metrics&days=1',
        headers: {
          authorization: buildAuthHeader(userId),
        },
      };
      const metricsRes = await invoke(pushMetricsHandler, metricsReq);
      assert.equal(metricsRes.statusCode, 200);
      assert.ok(Number(metricsRes.payload.sent_count || 0) >= 1);
      assert.ok(Number(metricsRes.payload.action_done_count || 0) >= 1);
      assert.ok(Number(metricsRes.payload.action_rate || 0) > 0);
    } finally {
      if (assignmentId) await pool.query('DELETE FROM assignments WHERE id = $1', [assignmentId]);
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
    }
  });

  test('integration: POST /api/notifications/action (snooze) creates pending reminder', async () => {
    const { pool, notificationsHandler, createActionToken } = await withApiDeps();
    const userId = `itest_snooze_${Date.now()}`;
    let assignmentId = 0;

    try {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM z_ai_reminders WHERE user_id = $1 OR target_user = $1', [userId]);
      const ins = await pool.query(
        `INSERT INTO assignments (title, completed, assigned_to)
         VALUES ($1, FALSE, $2)
         RETURNING id`,
        [`ITEST snooze assignment ${Date.now()}`, userId]
      );
      assignmentId = Number(ins.rows[0].id);

      const token = createActionToken({
        user_id: userId,
        entity_type: 'assignment',
        entity_id: String(assignmentId),
        route_fallback: '/college-assignments',
        event_family: 'urgent_due',
      }, 3600);

      const req = {
        method: 'POST',
        url: 'http://x/api/router?path=notifications/action',
        headers: {
          authorization: buildAuthHeader(userId),
        },
        body: {
          action: 'snooze',
          token,
          snooze_minutes: 30,
          entity_type: 'assignment',
          entity_id: String(assignmentId),
        },
      };
      const res = await invoke(notificationsHandler, req);
      assert.equal(res.statusCode, 200);
      assert.equal(Boolean(res.payload.ok), true);
      assert.equal(String(res.payload.status), 'snoozed');

      const reminderRes = await pool.query(
        `SELECT id, status, remind_at
         FROM z_ai_reminders
         WHERE user_id = $1
           AND payload->>'entity_type' = 'assignment'
           AND payload->>'entity_id' = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, String(assignmentId)]
      );
      assert.equal(reminderRes.rowCount, 1);
      assert.equal(String(reminderRes.rows[0].status || ''), 'pending');

      const remindAt = new Date(reminderRes.rows[0].remind_at).getTime();
      assert.ok(Number.isFinite(remindAt));
      assert.ok(remindAt > Date.now());
    } finally {
      if (assignmentId) await pool.query('DELETE FROM assignments WHERE id = $1', [assignmentId]);
      await pool.query('DELETE FROM z_ai_reminders WHERE user_id = $1 OR target_user = $1', [userId]);
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
    }
  });

  test('integration: POST /api/notifications/action (replan) logs copilot metrics', async () => {
    const { pool, notificationsHandler, pushMetricsHandler, createActionToken } = await withApiDeps();
    const userId = `itest_replan_${Date.now()}`;
    let assignmentId = 0;

    try {
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM z_ai_reminders WHERE user_id = $1 OR target_user = $1', [userId]);
      const ins = await pool.query(
        `INSERT INTO assignments (title, completed, assigned_to)
         VALUES ($1, FALSE, $2)
         RETURNING id`,
        [`ITEST replan assignment ${Date.now()}`, userId]
      );
      assignmentId = Number(ins.rows[0].id);

      const token = createActionToken({
        user_id: userId,
        entity_type: 'assignment',
        entity_id: String(assignmentId),
        route_fallback: '/college-assignments',
        event_family: 'execution_followup',
      }, 3600);

      const req = {
        method: 'POST',
        url: 'http://x/api/router?path=notifications/action',
        headers: {
          authorization: buildAuthHeader(userId),
        },
        body: {
          action: 'replan',
          token,
          snooze_minutes: 15,
          entity_type: 'assignment',
          entity_id: String(assignmentId),
          source: 'home',
        },
      };
      const res = await invoke(notificationsHandler, req);
      assert.equal(res.statusCode, 200);
      assert.equal(Boolean(res.payload.ok), true);
      assert.equal(String(res.payload.status), 'replanned');

      const metricsReq = {
        method: 'GET',
        url: 'http://x/api/router?path=push_metrics&days=1',
        headers: {
          authorization: buildAuthHeader(userId),
        },
      };
      const metricsRes = await invoke(pushMetricsHandler, metricsReq);
      assert.equal(metricsRes.statusCode, 200);
      assert.ok(Number(metricsRes.payload.action_replan_count || 0) >= 1);
      assert.ok(Number(metricsRes.payload.copilot_action_replan || 0) >= 1);
    } finally {
      if (assignmentId) await pool.query('DELETE FROM assignments WHERE id = $1', [assignmentId]);
      await pool.query('DELETE FROM z_ai_reminders WHERE user_id = $1 OR target_user = $1', [userId]);
      await pool.query('DELETE FROM user_activity_events WHERE user_id = $1', [userId]);
    }
  });

  test('integration: GET /api/proactive includes execution_copilot payload', async () => {
    const { proactiveHandler } = await withApiDeps();
    const userId = `itest_proactive_${Date.now()}`;

    const req = {
      method: 'GET',
      url: 'http://x/api/router?path=proactive&limit=5',
      headers: {
        authorization: buildAuthHeader(userId),
      },
    };
    const res = await invoke(proactiveHandler, req);
    assert.equal(res.statusCode, 200);
    assert.equal(Array.isArray(res.payload.items), true);
    assert.equal(typeof res.payload.execution_copilot, 'object');
    assert.equal(Array.isArray(res.payload.execution_copilot.quick_actions), true);
  });

  test('integration: POST /api/notifications/action expired token returns 410', async () => {
    const { notificationsHandler, createActionToken } = await withApiDeps();
    const userId = `itest_expired_${Date.now()}`;

    const token = createActionToken({
      user_id: userId,
      entity_type: 'task',
      entity_id: '999999',
      route_fallback: '/daily-tasks',
      event_family: 'urgent_due',
    }, 1);
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const req = {
      method: 'POST',
      url: 'http://x/api/router?path=notifications/action',
      headers: {},
      body: {
        action: 'done',
        token,
      },
    };
    const res = await invoke(notificationsHandler, req);
    assert.equal(res.statusCode, 410);
    assert.equal(String(res.payload.error || ''), 'Aksi kadaluarsa');
  });
}
