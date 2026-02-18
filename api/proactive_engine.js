import { pool } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';
import { createActionToken } from './action_token.js';
import { evaluatePushPolicy, logPushEvent, pushFamilyFromEventType } from './push_policy.js';

const DEFAULT_TZ_OFFSET_HOURS = Number(process.env.PROACTIVE_TZ_OFFSET_HOURS || 7);
const COUPLE_USERS = ['Zaldy', 'Nesya'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

export function computeLocalWindow(baseDate = new Date(), offsetHours = DEFAULT_TZ_OFFSET_HOURS) {
  const local = new Date(baseDate.getTime() + offsetHours * 3600000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const localStartUtc = new Date(Date.UTC(y, m, d) - offsetHours * 3600000);
  const localEndUtc = new Date(localStartUtc.getTime() + 24 * 3600000);
  const day = local.getUTCDay();
  const dayId = day === 0 ? 7 : day; // Monday=1 ... Sunday=7
  return {
    offsetHours,
    nowUtc: baseDate,
    localNow: local,
    localDate: `${y}-${pad2(m + 1)}-${pad2(d)}`,
    localHour: local.getUTCHours(),
    dayId,
    startUtc: localStartUtc,
    endUtc: localEndUtc,
  };
}

function partnerFor(user) {
  if (user === 'Zaldy') return 'Nesya';
  if (user === 'Nesya') return 'Zaldy';
  return null;
}

function stageByMinutes(minutesLeft) {
  if (minutesLeft <= 0) return 'overdue';
  if (minutesLeft <= 30) return 'critical';
  if (minutesLeft <= 90) return 'warning';
  return 'info';
}

function levelByStage(stage) {
  if (stage === 'overdue') return 'critical';
  if (stage === 'critical') return 'critical';
  if (stage === 'warning') return 'warning';
  return 'info';
}

function actionsByUrgentStage(stage, source) {
  const routeAction = source === 'task' ? 'Open Task' : 'Open Assignment';
  if (stage === 'warning') {
    return [
      { action: 'open', title: routeAction },
      { action: 'open-replan', title: 'Replan 30m' },
    ];
  }
  if (stage === 'critical') {
    return [
      { action: 'open', title: routeAction },
      { action: 'open-chat', title: 'Request Support' },
    ];
  }
  if (stage === 'overdue') {
    return [
      { action: 'open', title: routeAction },
      { action: 'open-chat', title: 'Check-In Now' },
    ];
  }
  return [{ action: 'open', title: routeAction }];
}

function inferEntityFromEvent(event = {}) {
  const payload = event?.payload || {};
  const source = String(payload?.source || '').toLowerCase();
  if ((source === 'task' || source === 'assignment') && payload?.item_id) {
    return { entityType: source, entityId: String(payload.item_id) };
  }
  if (payload?.entity_type && payload?.entity_id) {
    return { entityType: String(payload.entity_type), entityId: String(payload.entity_id) };
  }
  return null;
}

function buildLockScreenActions(event = {}, token = '') {
  if (!token) return Array.isArray(event.actions) ? event.actions : [];
  return [
    { action: 'start', title: 'Mulai' },
    { action: 'snooze', title: 'Tunda 30m' },
    { action: 'done', title: 'Selesai' },
  ];
}

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function hoursLeftFrom(deadline, nowUtc) {
  if (!deadline) return null;
  const t = new Date(deadline).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - nowUtc.getTime()) / 3600000;
}

function predictiveRiskScore(item = {}, source = 'task', nowUtc = new Date()) {
  const hoursLeft = hoursLeftFrom(item.deadline, nowUtc);
  if (hoursLeft === null) {
    return { riskScore: 24, riskBand: 'low', hoursLeft: null };
  }

  let score = 0;
  if (hoursLeft <= 0) score += 85;
  else if (hoursLeft <= 6) score += 70;
  else if (hoursLeft <= 12) score += 56;
  else if (hoursLeft <= 24) score += 42;
  else if (hoursLeft <= 48) score += 30;
  else score += 18;

  const pr = String(item.priority || '').toLowerCase();
  if (pr === 'high') score += 14;
  else if (pr === 'medium') score += 6;
  if (source === 'assignment') score += 6;

  score = clampInt(Math.round(score), 0, 100);
  let riskBand = 'low';
  if (score >= 75) riskBand = 'critical';
  else if (score >= 55) riskBand = 'high';
  else if (score >= 35) riskBand = 'medium';

  return { riskScore: score, riskBand, hoursLeft: Number(hoursLeft.toFixed(2)) };
}

function levelByRiskBand(riskBand) {
  if (riskBand === 'critical') return 'critical';
  if (riskBand === 'high') return 'warning';
  return 'info';
}

function summarizeBrief({ tasksDueToday, assignmentsDueToday, classesToday, urgentTitle, nextClass }) {
  const parts = [];
  parts.push(`${tasksDueToday} task aktif`);
  parts.push(`${assignmentsDueToday} assignment aktif`);
  parts.push(`${classesToday} agenda kelas`);

  let focus = 'start dari satu quick win 15 menit.';
  if (urgentTitle) {
    focus = `fokus dulu ke "${urgentTitle}".`;
  } else if (nextClass) {
    focus = `siapkan kelas ${nextClass}.`;
  }

  return `Hari ini: ${parts.join(', ')}. Saran Nova: ${focus}`;
}

export async function ensureProactiveTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS proactive_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(50) NOT NULL,
      event_type VARCHAR(50) NOT NULL,
      event_key TEXT NOT NULL,
      level VARCHAR(16) DEFAULT 'info',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      url TEXT DEFAULT '/',
      payload JSONB DEFAULT '{}'::jsonb,
      local_date DATE NOT NULL,
      delivered_push BOOLEAN DEFAULT FALSE,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_proactive_events_unique
    ON proactive_events (user_id, event_type, event_key, local_date)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_proactive_events_recent
    ON proactive_events (user_id, created_at DESC)
  `);
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

async function readSchemaFlags(client) {
  const checks = [
    ['pushSubsUserId', 'push_subscriptions', 'user_id'],
    ['tasksAssignedTo', 'tasks', 'assigned_to'],
    ['tasksCreatedBy', 'tasks', 'created_by'],
    ['tasksCompletedBy', 'tasks', 'completed_by'],
    ['assignmentsAssignedTo', 'assignments', 'assigned_to'],
    ['evaluationsUserId', 'evaluations', 'user_id'],
    ['chatMessagesUserId', 'chat_messages', 'user_id'],
  ];
  const entries = await Promise.all(
    checks.map(async ([key, table, column]) => [key, await hasColumn(client, table, column)])
  );
  return Object.fromEntries(entries);
}

function buildTaskOwnershipClause(schema, user, paramIndex = 1) {
  if (schema.tasksAssignedTo && schema.tasksCreatedBy) {
    return { clause: `(assigned_to = $${paramIndex} OR created_by = $${paramIndex})`, params: [user], nextParam: paramIndex + 1 };
  }
  if (schema.tasksAssignedTo) {
    return { clause: `assigned_to = $${paramIndex}`, params: [user], nextParam: paramIndex + 1 };
  }
  if (schema.tasksCreatedBy) {
    return { clause: `created_by = $${paramIndex}`, params: [user], nextParam: paramIndex + 1 };
  }
  return { clause: 'TRUE', params: [], nextParam: paramIndex };
}

function buildAssignmentOwnershipClause(schema, user, paramIndex = 1) {
  if (schema.assignmentsAssignedTo) {
    return { clause: `(assigned_to = $${paramIndex} OR assigned_to IS NULL)`, params: [user], nextParam: paramIndex + 1 };
  }
  return { clause: 'TRUE', params: [], nextParam: paramIndex };
}

async function discoverUsers(client, schema) {
  const candidates = new Set(COUPLE_USERS);
  const queries = [];
  if (schema.pushSubsUserId) {
    queries.push(`SELECT DISTINCT user_id AS u FROM push_subscriptions WHERE user_id IS NOT NULL`);
  }
  if (schema.tasksAssignedTo) {
    queries.push(`SELECT DISTINCT assigned_to AS u FROM tasks WHERE assigned_to IS NOT NULL`);
  }
  if (schema.tasksCompletedBy) {
    queries.push(`SELECT DISTINCT completed_by AS u FROM tasks WHERE completed_by IS NOT NULL`);
  }
  if (schema.assignmentsAssignedTo) {
    queries.push(`SELECT DISTINCT assigned_to AS u FROM assignments WHERE assigned_to IS NOT NULL`);
  }
  if (schema.evaluationsUserId) {
    queries.push(`SELECT DISTINCT user_id AS u FROM evaluations WHERE user_id IS NOT NULL`);
  }
  if (schema.chatMessagesUserId) {
    queries.push(`SELECT DISTINCT user_id AS u FROM chat_messages WHERE user_id IS NOT NULL AND user_id <> 'System'`);
  }

  for (const sql of queries) {
    const r = await client.query(sql);
    for (const row of r.rows) {
      const user = (row.u || '').toString().trim();
      if (user) candidates.add(user);
    }
  }

  return [...candidates];
}

async function insertEventRow(client, event) {
  const r = await client.query(
    `INSERT INTO proactive_events
      (user_id, event_type, event_key, level, title, body, url, payload, local_date)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::date)
     ON CONFLICT (user_id, event_type, event_key, local_date) DO NOTHING
     RETURNING id`,
    [
      event.userId,
      event.eventType,
      event.eventKey,
      event.level || 'info',
      event.title,
      event.body,
      event.url || '/',
      JSON.stringify(event.payload || {}),
      event.localDate,
    ]
  );
  return r.rows[0]?.id || null;
}

async function emitEvent(client, event, notify = true) {
  const eventId = await insertEventRow(client, event);
  if (!eventId) return { inserted: false, pushed: false };

  if (!notify) return { inserted: true, pushed: false };

  const eventFamily = String(event?.push_meta?.event_family || pushFamilyFromEventType(event.eventType)).trim() || 'general';
  const policyRes = await evaluatePushPolicy(client, {
    userId: event.userId,
    eventType: event.eventType,
    eventFamily,
    dedupKey: String(event?.push_meta?.dedup_key || `${eventFamily}:${event.eventKey}`),
    payload: event.payload || {},
  });
  if (!policyRes.allowed) {
    await logPushEvent(client, event.userId, 'push_ignored', {
      event_type: event.eventType,
      event_family: eventFamily,
      dedup_key: policyRes?.policy?.dedup_key || `${eventFamily}:${event.eventKey}`,
      reason: policyRes.reason,
      route: event.url || '/',
    });
    return { inserted: true, pushed: false, blocked: policyRes.reason };
  }

  const entity = inferEntityFromEvent(event);
  let actionToken = '';
  if (entity) {
    try {
      actionToken = createActionToken({
        user_id: event.userId,
        entity_type: entity.entityType,
        entity_id: entity.entityId,
        route_fallback: event.url || '/',
        event_family: eventFamily,
      });
    } catch {
      actionToken = '';
    }
  }
  const actions = buildLockScreenActions(event, actionToken);

  let pushed = false;
  try {
    await sendNotificationToUser(event.userId, {
      title: event.title,
      body: event.body,
      data: {
        url: event.url || '/',
        route_fallback: event.url || '/',
        event_family: eventFamily,
        dedup_key: policyRes?.policy?.dedup_key || `${eventFamily}:${event.eventKey}`,
        entity_type: entity?.entityType || null,
        entity_id: entity?.entityId || null,
        action_token: actionToken || null,
      },
      url: event.url || '/',
      tag: event.eventType,
      actions,
    });
    pushed = true;
  } catch (err) {
    console.error('Proactive push failed:', err);
  }

  if (pushed) {
    await client.query(
      `UPDATE proactive_events
       SET delivered_push = TRUE, delivered_at = NOW()
       WHERE id = $1`,
      [eventId]
    );
    await logPushEvent(client, event.userId, 'push_sent', {
      event_type: event.eventType,
      event_family: eventFamily,
      dedup_key: policyRes?.policy?.dedup_key || `${eventFamily}:${event.eventKey}`,
      route: event.url || '/',
      entity_type: entity?.entityType || null,
      entity_id: entity?.entityId || null,
      action_ids: actions.map((x) => x.action),
    });
  }

  return { inserted: true, pushed };
}

async function buildMorningBriefContext(client, user, window, schema) {
  const taskOwner = buildTaskOwnershipClause(schema, user, 1);
  const taskDeadlineParam = `$${taskOwner.nextParam}`;
  const taskSql = `SELECT id, title, deadline
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwner.clause}
         AND (deadline IS NULL OR deadline < ${taskDeadlineParam})
       ORDER BY deadline ASC NULLS LAST
       LIMIT 8`;
  const taskParams = [...taskOwner.params, window.endUtc.toISOString()];

  const assignmentOwner = buildAssignmentOwnershipClause(schema, user, 1);
  const assignmentDeadlineParam = `$${assignmentOwner.nextParam}`;
  const assignmentSql = `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND ${assignmentOwner.clause}
         AND (deadline IS NULL OR deadline < ${assignmentDeadlineParam})
       ORDER BY deadline ASC NULLS LAST
       LIMIT 8`;
  const assignmentParams = [...assignmentOwner.params, window.endUtc.toISOString()];

  const [tasksRes, assignmentsRes, scheduleRes] = await Promise.all([
    client.query(taskSql, taskParams),
    client.query(assignmentSql, assignmentParams),
    client.query(
      `SELECT subject, time_start
       FROM schedule
       WHERE day_id = $1
       ORDER BY time_start ASC`,
      [window.dayId]
    ),
  ]);

  const tasks = tasksRes.rows;
  const assignments = assignmentsRes.rows;
  const classes = scheduleRes.rows;
  const urgentTask = tasks.find((t) => t.deadline && new Date(t.deadline).getTime() <= window.startUtc.getTime() + 8 * 3600000);
  const nextClass = classes[0] ? `${classes[0].time_start.slice(0, 5)} ${classes[0].subject}` : '';

  return {
    tasks,
    assignments,
    classes,
    urgentTitle: urgentTask ? urgentTask.title : '',
    nextClass,
  };
}

async function runMorningBrief(client, users, window, notify, schema) {
  const stats = { generated: 0, pushed: 0 };
  const isMorningWindow = window.localHour >= 6 && window.localHour <= 9;
  if (!isMorningWindow) return stats;

  for (const user of users) {
    const ctx = await buildMorningBriefContext(client, user, window, schema);
    const body = summarizeBrief({
      tasksDueToday: ctx.tasks.length,
      assignmentsDueToday: ctx.assignments.length,
      classesToday: ctx.classes.length,
      urgentTitle: ctx.urgentTitle,
      nextClass: ctx.nextClass,
    });

    const result = await emitEvent(
      client,
      {
        userId: user,
        eventType: 'morning_brief',
        eventKey: 'daily-brief',
        level: 'info',
        title: 'Morning Brief',
        body,
        url: '/',
        localDate: window.localDate,
        payload: {
          tasks: ctx.tasks.slice(0, 5),
          assignments: ctx.assignments.slice(0, 5),
          classes: ctx.classes.slice(0, 5),
        },
      },
      notify
    );

    if (result.inserted) stats.generated++;
    if (result.pushed) stats.pushed++;
  }
  return stats;
}

async function runUrgentRadar(client, users, window, notify, schema) {
  const stats = { generated: 0, pushed: 0, partner_ping: 0 };
  const upcomingIso = new Date(window.nowUtc.getTime() + 90 * 60000).toISOString();
  const graceIso = new Date(window.nowUtc.getTime() - 120 * 60000).toISOString();
  const hourBucket = `${window.localDate}-${pad2(window.localHour)}`;
  const targetUsers = Array.isArray(users) && users.length ? users : COUPLE_USERS;
  const taskOwnerColumn = schema.tasksAssignedTo ? 'assigned_to' : schema.tasksCreatedBy ? 'created_by' : null;

  const taskQuery = taskOwnerColumn
    ? client.query(
      `SELECT id, title, deadline, ${taskOwnerColumn} AS owner_user
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwnerColumn} IS NOT NULL
         AND deadline IS NOT NULL
         AND deadline >= $1
         AND deadline <= $2`,
      [graceIso, upcomingIso]
    )
    : Promise.resolve({ rows: [] });

  const assignmentQuery = schema.assignmentsAssignedTo
    ? client.query(
      `SELECT id, title, deadline, assigned_to AS owner_user
       FROM assignments
       WHERE completed = FALSE
         AND assigned_to IS NOT NULL
         AND deadline IS NOT NULL
         AND deadline >= $1
         AND deadline <= $2`,
      [graceIso, upcomingIso]
    )
    : client.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND deadline IS NOT NULL
         AND deadline >= $1
         AND deadline <= $2`,
      [graceIso, upcomingIso]
    );

  const [tasksRes, assignmentsRes] = await Promise.all([taskQuery, assignmentQuery]);

  const rows = [
    ...tasksRes.rows.map((x) => ({
      ...x,
      source: 'task',
      url: '/daily-tasks',
      targets: x.owner_user ? [x.owner_user] : [],
    })),
    ...assignmentsRes.rows.map((x) => ({
      ...x,
      source: 'assignment',
      url: '/college-assignments',
      targets: x.owner_user ? [x.owner_user] : targetUsers,
    })),
  ];

  for (const row of rows) {
    const recipients = Array.isArray(row.targets) ? row.targets.filter(Boolean) : [];
    if (!recipients.length) continue;
    const minutesLeft = Math.round((new Date(row.deadline).getTime() - window.nowUtc.getTime()) / 60000);
    const stage = stageByMinutes(minutesLeft);
    if (stage === 'info') continue;
    const level = levelByStage(stage);
    const sourceLabel = row.source === 'task' ? 'Task' : 'Assignment';
    const body = stage === 'overdue'
      ? `${sourceLabel} "${row.title}" sudah overdue. Tangani sekarang.`
      : stage === 'critical'
        ? `${sourceLabel} "${row.title}" masuk critical window (${minutesLeft} menit lagi).`
        : `${sourceLabel} "${row.title}" due ${minutesLeft} menit lagi. Mulai 1 sprint fokus sekarang.`;
    const eventType = `urgent_radar_${stage}`;
    const eventKey = `${row.source}-${row.id}-${stage}-${hourBucket}`;
    const actions = actionsByUrgentStage(stage, row.source);

    for (const user of recipients) {
      const result = await emitEvent(
        client,
        {
          userId: user,
          eventType,
          eventKey,
          level,
          title: 'Urgent Radar',
          body,
          url: row.url,
          localDate: window.localDate,
          payload: {
            source: row.source,
            item_id: row.id,
            minutes_left: minutesLeft,
            deadline: row.deadline,
            escalation_stage: stage,
          },
          actions,
        },
        notify
      );

      if (result.inserted) stats.generated++;
      if (result.pushed) stats.pushed++;
    }

    const owner = (row.owner_user || '').toString().trim();
    const partner = partnerFor(owner);
    if (partner && (stage === 'critical' || stage === 'overdue')) {
      const supportBody = stage === 'overdue'
        ? `${owner} punya ${sourceLabel} overdue: "${row.title}". Coba check-in cepat sekarang.`
        : `${owner} punya ${sourceLabel} kritis (${Math.max(0, minutesLeft)} menit lagi): "${row.title}". Bantu check-in 2 menit.`;
      const supportRes = await emitEvent(
        client,
        {
          userId: partner,
          eventType: 'urgent_support_ping',
          eventKey: `${row.source}-${row.id}-${stage}-${hourBucket}`,
          level: stage === 'overdue' ? 'critical' : 'warning',
          title: 'Couple Support Ping',
          body: supportBody,
          url: '/chat',
          localDate: window.localDate,
          payload: {
            source: row.source,
            item_id: row.id,
            target: owner,
            escalation_stage: stage,
            minutes_left: minutesLeft,
          },
          actions: [
            { action: 'open-chat', title: 'Open Chat' },
            { action: 'open', title: sourceLabel === 'Task' ? 'Open Task' : 'Open Assignment' },
          ],
        },
        notify
      );
      if (supportRes.inserted) {
        stats.generated++;
        stats.partner_ping++;
      }
      if (supportRes.pushed) stats.pushed++;
    }
  }

  return stats;
}

async function runPredictiveRiskRadar(client, users, window, notify, schema) {
  const stats = { generated: 0, pushed: 0, high: 0, critical: 0, partner_ping: 0 };
  const targetUsers = Array.isArray(users) && users.length ? users : COUPLE_USERS;
  const nearIso = new Date(window.nowUtc.getTime() + 90 * 60000).toISOString();
  const horizonIso = new Date(window.nowUtc.getTime() + 72 * 3600000).toISOString();
  const taskOwnerColumn = schema.tasksAssignedTo ? 'assigned_to' : schema.tasksCreatedBy ? 'created_by' : null;
  const maxPerUser = 2;
  const sentPerUser = new Map();

  const taskQuery = taskOwnerColumn
    ? client.query(
      `SELECT id, title, deadline, priority, ${taskOwnerColumn} AS owner_user
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwnerColumn} IS NOT NULL
         AND deadline IS NOT NULL
         AND deadline > $1
         AND deadline <= $2`,
      [nearIso, horizonIso]
    )
    : Promise.resolve({ rows: [] });

  const assignmentQuery = schema.assignmentsAssignedTo
    ? client.query(
      `SELECT id, title, deadline, assigned_to AS owner_user
       FROM assignments
       WHERE completed = FALSE
         AND assigned_to IS NOT NULL
         AND deadline IS NOT NULL
         AND deadline > $1
         AND deadline <= $2`,
      [nearIso, horizonIso]
    )
    : client.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND deadline IS NOT NULL
         AND deadline > $1
         AND deadline <= $2`,
      [nearIso, horizonIso]
    );

  const [tasksRes, assignmentsRes] = await Promise.all([taskQuery, assignmentQuery]);

  const rows = [
    ...tasksRes.rows.map((x) => ({
      ...x,
      source: 'task',
      url: '/daily-tasks',
      targets: x.owner_user ? [x.owner_user] : [],
    })),
    ...assignmentsRes.rows.map((x) => ({
      ...x,
      source: 'assignment',
      url: '/college-assignments',
      targets: x.owner_user ? [x.owner_user] : targetUsers,
      priority: x.priority || 'medium',
    })),
  ]
    .map((row) => {
      const risk = predictiveRiskScore(row, row.source, window.nowUtc);
      return { ...row, ...risk };
    })
    .filter((row) => row.riskBand === 'high' || row.riskBand === 'critical')
    .sort((a, b) => Number(b.riskScore || 0) - Number(a.riskScore || 0));

  for (const row of rows) {
    const sourceLabel = row.source === 'task' ? 'Task' : 'Assignment';
    const recipients = Array.isArray(row.targets) ? row.targets.filter(Boolean) : [];
    if (!recipients.length) continue;

    for (const user of recipients) {
      const currentSent = Number(sentPerUser.get(user) || 0);
      if (currentSent >= maxPerUser) continue;

      const hoursLabel = row.hoursLeft !== null ? `${Math.max(1, Math.round(row.hoursLeft))} jam` : 'horizon aktif';
      const body = `${sourceLabel} "${row.title}" berisiko ${row.riskBand} (score ${row.riskScore}) dalam ${hoursLabel}.`;

      const result = await emitEvent(
        client,
        {
          userId: user,
          eventType: `predictive_risk_${row.riskBand}`,
          eventKey: `${row.source}-${row.id}-${row.riskBand}`,
          level: levelByRiskBand(row.riskBand),
          title: 'Predictive Risk',
          body,
          url: row.url,
          localDate: window.localDate,
          payload: {
            source: row.source,
            item_id: row.id,
            risk_band: row.riskBand,
            risk_score: row.riskScore,
            hours_left: row.hoursLeft,
            deadline: row.deadline,
          },
          actions: [
            { action: 'open', title: sourceLabel === 'task' ? 'Open Task' : 'Open Assignment' },
            { action: 'open-replan', title: 'Replan' },
          ],
        },
        notify
      );

      if (result.inserted) {
        stats.generated++;
        sentPerUser.set(user, currentSent + 1);
        if (row.riskBand === 'critical') stats.critical++;
        else stats.high++;
      }
      if (result.pushed) stats.pushed++;
    }

    const owner = (row.owner_user || '').toString().trim();
    const partner = partnerFor(owner);
    if (partner && row.riskBand === 'critical') {
      const supportRes = await emitEvent(
        client,
        {
          userId: partner,
          eventType: 'predictive_support_ping',
          eventKey: `${row.source}-${row.id}-critical`,
          level: 'warning',
          title: 'Predictive Support',
          body: `${owner} punya ${sourceLabel} berisiko critical: "${row.title}". Bantu sinkron cepat malam ini.`,
          url: '/chat',
          localDate: window.localDate,
          payload: {
            source: row.source,
            item_id: row.id,
            target: owner,
            risk_band: row.riskBand,
            risk_score: row.riskScore,
            hours_left: row.hoursLeft,
          },
          actions: [
            { action: 'open-chat', title: 'Open Chat' },
            { action: 'open', title: sourceLabel === 'task' ? 'Open Task' : 'Open Assignment' },
          ],
        },
        notify
      );
      if (supportRes.inserted) {
        stats.generated++;
        stats.partner_ping++;
      }
      if (supportRes.pushed) stats.pushed++;
    }
  }

  return stats;
}

async function moodWindowAvg(client, user, fromIso, toIso) {
  const r = await client.query(
    `SELECT AVG(mood)::float AS avg_mood, COUNT(*)::int AS cnt
     FROM evaluations
     WHERE user_id = $1
       AND created_at >= $2
       AND created_at < $3`,
    [user, fromIso, toIso]
  );
  return {
    avg: Number(r.rows[0]?.avg_mood || 0),
    cnt: Number(r.rows[0]?.cnt || 0),
  };
}

async function runMoodDropAlerts(client, users, window, notify) {
  const stats = { generated: 0, pushed: 0 };
  if (window.localHour < 7 || window.localHour > 22) return stats;

  const recentStart = new Date(window.nowUtc.getTime() - 2 * 24 * 3600000).toISOString();
  const prevStart = new Date(window.nowUtc.getTime() - 5 * 24 * 3600000).toISOString();
  const nowIso = window.nowUtc.toISOString();

  for (const user of users) {
    const partner = partnerFor(user);
    if (!partner) continue;

    const [recent, prev] = await Promise.all([
      moodWindowAvg(client, user, recentStart, nowIso),
      moodWindowAvg(client, user, prevStart, recentStart),
    ]);

    if (recent.cnt < 2) continue;
    const dropped = prev.cnt >= 2 && recent.avg <= prev.avg - 0.7;
    const lowMood = recent.avg <= 2.6;
    if (!dropped && !lowMood) continue;

    const selfBody = `Trend mood kamu lagi turun (avg ${recent.avg.toFixed(1)}). Ambil 15 menit reset lalu lanjut 1 task ringan.`;
    const partnerBody =
      prev.cnt >= 2
        ? `${user} lagi drop (avg ${recent.avg.toFixed(1)} dari ${prev.avg.toFixed(1)}). Saran: check-in 5 menit malam ini.`
        : `${user} lagi drop (avg ${recent.avg.toFixed(1)}). Saran: kirim check-in singkat malam ini.`;

    const selfResult = await emitEvent(
      client,
      {
        userId: user,
        eventType: 'mood_drop_self',
        eventKey: `${user}-self-${window.localDate}`,
        level: 'warning',
        title: 'Mood Guard',
        body: selfBody,
        url: '/goals',
        localDate: window.localDate,
        payload: { recent_avg: recent.avg, prev_avg: prev.avg, dropped, lowMood },
      },
      notify
    );
    if (selfResult.inserted) stats.generated++;
    if (selfResult.pushed) stats.pushed++;

    const partnerResult = await emitEvent(
      client,
      {
        userId: partner,
        eventType: 'mood_drop_alert',
        eventKey: `${user}-partner-${window.localDate}`,
        level: 'critical',
        title: 'Mood Drop Alert',
        body: partnerBody,
        url: '/chat',
        localDate: window.localDate,
        payload: { target: user, recent_avg: recent.avg, prev_avg: prev.avg, dropped, lowMood },
        actions: [{ action: 'open-chat', title: 'Open Chat' }],
      },
      notify
    );
    if (partnerResult.inserted) stats.generated++;
    if (partnerResult.pushed) stats.pushed++;
  }

  return stats;
}

async function pendingLoad(client, user, schema) {
  const taskOwner = buildTaskOwnershipClause(schema, user, 1);
  const taskSql = `SELECT COUNT(*)::int AS cnt
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwner.clause}`;

  const assignmentOwner = buildAssignmentOwnershipClause(schema, user, 1);
  const assignmentSql = `SELECT COUNT(*)::int AS cnt
       FROM assignments
       WHERE completed = FALSE
         AND ${assignmentOwner.clause}`;

  const [tasks, assignments] = await Promise.all([
    client.query(taskSql, taskOwner.params),
    client.query(assignmentSql, assignmentOwner.params),
  ]);
  return Number(tasks.rows[0]?.cnt || 0) + Number(assignments.rows[0]?.cnt || 0);
}

async function readUserPendingStats(client, user, schema, nowIso) {
  const in6Iso = new Date(new Date(nowIso).getTime() + 6 * 3600000).toISOString();
  const in24Iso = new Date(new Date(nowIso).getTime() + 24 * 3600000).toISOString();
  const in48Iso = new Date(new Date(nowIso).getTime() + 48 * 3600000).toISOString();

  const taskOwner = buildTaskOwnershipClause(schema, user, 1);
  const taskSql = `SELECT
      COUNT(*)::int AS pending_cnt,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= $${taskOwner.nextParam})::int AS due_6h,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $${taskOwner.nextParam} AND deadline <= $${taskOwner.nextParam + 1})::int AS due_24h,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $${taskOwner.nextParam + 1} AND deadline <= $${taskOwner.nextParam + 2})::int AS due_48h
    FROM tasks
    WHERE is_deleted = FALSE
      AND completed = FALSE
      AND ${taskOwner.clause}`;

  const asgOwner = buildAssignmentOwnershipClause(schema, user, 1);
  const asgSql = `SELECT
      COUNT(*)::int AS pending_cnt,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= $${asgOwner.nextParam})::int AS due_6h,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $${asgOwner.nextParam} AND deadline <= $${asgOwner.nextParam + 1})::int AS due_24h,
      COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $${asgOwner.nextParam + 1} AND deadline <= $${asgOwner.nextParam + 2})::int AS due_48h
    FROM assignments
    WHERE completed = FALSE
      AND ${asgOwner.clause}`;

  const [taskRes, asgRes] = await Promise.all([
    client.query(taskSql, [...taskOwner.params, in6Iso, in24Iso, in48Iso]),
    client.query(asgSql, [...asgOwner.params, in6Iso, in24Iso, in48Iso]),
  ]);

  const task = taskRes.rows?.[0] || {};
  const asg = asgRes.rows?.[0] || {};
  return {
    pending: Number(task.pending_cnt || 0) + Number(asg.pending_cnt || 0),
    due_6h: Number(task.due_6h || 0) + Number(asg.due_6h || 0),
    due_24h: Number(task.due_24h || 0) + Number(asg.due_24h || 0),
    due_48h: Number(task.due_48h || 0) + Number(asg.due_48h || 0),
  };
}

async function readUserActivityIntensity(client, user) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM user_activity_events
     WHERE user_id = $1
       AND server_ts >= NOW() - INTERVAL '24 hours'`,
    [user]
  );
  return Number(r.rows?.[0]?.cnt || 0);
}

async function readDailyCompletionCount(client, user, schema, nowIso) {
  const startIso = new Date(new Date(nowIso).getTime() - 24 * 3600000).toISOString();
  const taskCompletedBy = schema.tasksCompletedBy
    ? client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM tasks
       WHERE completed = TRUE
         AND completed_by = $1
         AND completed_at >= $2`,
      [user, startIso]
    )
    : Promise.resolve({ rows: [{ cnt: 0 }] });
  const asgCompletedBy = schema.assignmentsAssignedTo
    ? client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM assignments
       WHERE completed = TRUE
         AND assigned_to = $1
         AND completed_at >= $2`,
      [user, startIso]
    )
    : client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM assignments
       WHERE completed = TRUE
         AND completed_by = $1
         AND completed_at >= $2`,
      [user, startIso]
    );
  const [taskRes, asgRes] = await Promise.all([taskCompletedBy, asgCompletedBy]);
  return Number(taskRes.rows?.[0]?.cnt || 0) + Number(asgRes.rows?.[0]?.cnt || 0);
}

function computeLoadIndex(stats = {}, activityIntensity = 0, completionToday = 0, ignoredPush = 0) {
  const pending = Number(stats.pending || 0);
  const due6 = Number(stats.due_6h || 0);
  const due24 = Number(stats.due_24h || 0);
  const due48 = Number(stats.due_48h || 0);
  const intensity = Number(activityIntensity || 0);
  const completed = Number(completionToday || 0);
  const ignored = Number(ignoredPush || 0);
  const score = (pending * 4) + (due48 * 6) + (due24 * 12) + (due6 * 18) - (Math.min(8, completed) * 4) - (Math.min(16, intensity) * 1.2) + (Math.min(ignored, 6) * 4);
  return clampInt(Math.round(score), 0, 100);
}

function riskBandFromLoadIndex(loadIndex = 0) {
  if (loadIndex >= 72) return 'critical';
  if (loadIndex >= 40) return 'focus';
  return 'calm';
}

async function readIgnoredPushCount(client, user) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name = 'push_ignored'
       AND server_ts >= NOW() - INTERVAL '24 hours'`,
    [user]
  );
  return Number(r.rows?.[0]?.cnt || 0);
}

async function readNextDueItem(client, user, schema) {
  const taskOwner = buildTaskOwnershipClause(schema, user, 1);
  const taskSql = `SELECT id, title, deadline, 'task'::text AS source
    FROM tasks
    WHERE is_deleted = FALSE
      AND completed = FALSE
      AND ${taskOwner.clause}
      AND deadline IS NOT NULL
    ORDER BY deadline ASC
    LIMIT 1`;
  const asgOwner = buildAssignmentOwnershipClause(schema, user, 1);
  const asgSql = `SELECT id, title, deadline, 'assignment'::text AS source
    FROM assignments
    WHERE completed = FALSE
      AND ${asgOwner.clause}
      AND deadline IS NOT NULL
    ORDER BY deadline ASC
    LIMIT 1`;
  const [taskRes, asgRes] = await Promise.all([
    client.query(taskSql, taskOwner.params),
    client.query(asgSql, asgOwner.params),
  ]);
  const task = taskRes.rows?.[0] || null;
  const asg = asgRes.rows?.[0] || null;
  if (!task && !asg) return null;
  if (!task) return asg;
  if (!asg) return task;
  return new Date(task.deadline).getTime() <= new Date(asg.deadline).getTime() ? task : asg;
}

function buildActionSentence(nextItem, nowUtc = new Date()) {
  if (!nextItem) return 'Lanjutkan 1 sesi fokus 25 menit agar momentum tetap jalan.';
  const sourceLabel = String(nextItem.source || '') === 'assignment' ? 'tugas kuliah' : 'tugas';
  const title = String(nextItem.title || sourceLabel).trim();
  const diffH = Math.round((new Date(nextItem.deadline).getTime() - nowUtc.getTime()) / 3600000);
  const timeText = Number.isFinite(diffH)
    ? (diffH <= 0 ? 'sudah lewat deadline' : `deadline ${Math.max(1, diffH)} jam lagi`)
    : 'deadline aktif';
  return `Mulai ${title} sekarang (${sourceLabel}, ${timeText}).`;
}

function copilotRiskBandFromHours(hoursLeft = null) {
  if (!Number.isFinite(hoursLeft)) return 'medium';
  if (hoursLeft <= 0) return 'critical';
  if (hoursLeft <= 6) return 'critical';
  if (hoursLeft <= 24) return 'high';
  if (hoursLeft <= 48) return 'medium';
  return 'low';
}

function copilotState({ drift = false, loadIndex = 0, pending = 0, due24h = 0 } = {}) {
  if (drift) return 'drift';
  if (Number(loadIndex || 0) >= 72) return 'overload';
  if (Number(pending || 0) > 0 || Number(due24h || 0) > 0) return 'on_track';
  return 'calm';
}

async function readCopilotSnoozeCount(client, user, entityType, entityId) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name IN ('push_action_snooze', 'push_action_replan')
       AND payload->>'entity_type' = $2
       AND payload->>'entity_id' = $3
       AND server_ts >= NOW() - INTERVAL '6 hours'`,
    [user, entityType, entityId]
  );
  return Number(r.rows?.[0]?.cnt || 0);
}

async function findDriftCandidate(client, user) {
  const starts = await client.query(
    `SELECT
       payload->>'entity_type' AS entity_type,
       payload->>'entity_id' AS entity_id,
       MAX(server_ts) AS started_at
     FROM user_activity_events
     WHERE user_id = $1
       AND event_name IN ('push_action_start', 'copilot_action_start')
       AND server_ts >= NOW() - INTERVAL '6 hours'
       AND payload->>'entity_type' IS NOT NULL
       AND payload->>'entity_id' IS NOT NULL
     GROUP BY 1, 2
     ORDER BY MAX(server_ts) DESC
     LIMIT 8`,
    [user]
  );
  for (const row of starts.rows || []) {
    const entityType = String(row.entity_type || '').trim().toLowerCase();
    const entityId = String(row.entity_id || '').trim();
    const startedAt = row.started_at ? new Date(row.started_at) : null;
    if (!entityType || !entityId || !startedAt || Number.isNaN(startedAt.getTime())) continue;
    const ageMin = (Date.now() - startedAt.getTime()) / 60000;
    if (ageMin < 40 || ageMin > 6 * 60) continue;

    const [doneRes, followupRes] = await Promise.all([
      client.query(
        `SELECT 1
         FROM user_activity_events
         WHERE user_id = $1
           AND event_name = 'push_action_done'
           AND payload->>'entity_type' = $2
           AND payload->>'entity_id' = $3
           AND server_ts >= $4
         LIMIT 1`,
        [user, entityType, entityId, startedAt.toISOString()]
      ),
      client.query(
        `SELECT 1
         FROM user_activity_events
         WHERE user_id = $1
           AND event_name = 'copilot_drift_followup_sent'
           AND payload->>'entity_type' = $2
           AND payload->>'entity_id' = $3
           AND server_ts >= NOW() - INTERVAL '2 hours'
         LIMIT 1`,
        [user, entityType, entityId]
      ),
    ]);
    if (doneRes.rowCount > 0) continue;
    if (followupRes.rowCount > 0) continue;

    return {
      entity_type: entityType,
      entity_id: entityId,
      started_at: startedAt.toISOString(),
      age_minutes: Math.round(ageMin),
    };
  }
  return null;
}

function summarizeDailyClose(user, completionToday, pending = {}, nextAction = '') {
  const pendingTotal = Number(pending.pending || 0);
  const due24h = Number(pending.due_24h || 0) + Number(pending.due_6h || 0);
  const done = Number(completionToday || 0);
  const firstAction = String(nextAction || '').trim() || 'Mulai 1 sprint fokus 25 menit besok pagi.';

  if (pendingTotal <= 0) {
    return `Hai ${user}, hari ini rapi. Kamu menyelesaikan ${done} item. Besok mulai pelan dari target jangka panjang.`;
  }

  if (due24h > 0) {
    return `Hai ${user}, hari ini selesai ${done} item. Masih ada ${due24h} item mepet <=24 jam. Besok: ${firstAction}`;
  }

  return `Hai ${user}, progres hari ini ${done} item. Pending tersisa ${pendingTotal}. Besok: ${firstAction}`;
}

export async function buildExecutionCopilotSignals(client, schema, user, now = new Date(), opts = {}) {
  const nowIso = now.toISOString();
  const [pending, intensity, completionToday, ignoredPush, nextItem] = await Promise.all([
    readUserPendingStats(client, user, schema, nowIso),
    readUserActivityIntensity(client, user),
    readDailyCompletionCount(client, user, schema, nowIso),
    readIgnoredPushCount(client, user),
    readNextDueItem(client, user, schema),
  ]);
  const drift = opts?.driftCandidate || null;
  const loadIndex = computeLoadIndex(pending, intensity, completionToday, ignoredPush);

  if (!nextItem) {
    return {
      state: copilotState({ drift: Boolean(drift), loadIndex, pending: 0, due24h: 0 }),
      quick_actions: ['start', 'snooze_30', 'replan'],
      updated_at: now.toISOString(),
      next_action: {
        entity_type: '',
        entity_id: '',
        title: 'Mode tenang',
        action_text: 'Tidak ada tugas mepet. Lanjutkan 1 sesi fokus untuk goals jangka panjang.',
        reason_text: 'Semua deadline terdekat masih aman.',
        duration_min: 25,
        risk_band: 'low',
        route_fallback: '/goals',
        action_token: '',
      },
      meta: {
        pending,
        activity_intensity_24h: intensity,
        completion_today: completionToday,
        ignored_push_24h: ignoredPush,
        load_index: loadIndex,
      },
    };
  }

  const source = String(nextItem.source || 'task').toLowerCase();
  const entityType = source === 'assignment' ? 'assignment' : 'task';
  const entityId = String(nextItem.id || '').trim();
  const hoursLeft = hoursLeftFrom(nextItem.deadline, now);
  const riskBand = copilotRiskBandFromHours(hoursLeft);
  const snoozeCount = entityId ? await readCopilotSnoozeCount(client, user, entityType, entityId) : 0;
  const durationMin = snoozeCount >= 2 ? 15 : 25;
  const title = String(nextItem.title || (entityType === 'assignment' ? 'tugas kuliah' : 'tugas')).trim();

  const deadlineLabel = Number.isFinite(hoursLeft)
    ? (hoursLeft <= 0 ? 'deadline sudah lewat' : `deadline ${Math.max(1, Math.round(hoursLeft))} jam lagi`)
    : 'deadline aktif';
  const actionText = durationMin === 15
    ? `Mulai langkah kecil ${durationMin} menit untuk "${title}" sekarang.`
    : `Mulai "${title}" fokus ${durationMin} menit sekarang.`;
  const reasonText = riskBand === 'critical'
    ? `Prioritas kritis, ${deadlineLabel}.`
    : riskBand === 'high'
      ? `Prioritas tinggi, ${deadlineLabel}.`
      : `Jaga momentum eksekusi, ${deadlineLabel}.`;

  let actionToken = '';
  try {
    actionToken = createActionToken({
      user_id: user,
      entity_type: entityType,
      entity_id: entityId,
      route_fallback: entityType === 'assignment' ? '/college-assignments' : '/daily-tasks',
      event_family: 'execution_followup',
    });
  } catch {
    actionToken = '';
  }

  return {
    state: copilotState({
      drift: Boolean(drift),
      loadIndex,
      pending: pending.pending,
      due24h: pending.due_24h,
    }),
    quick_actions: ['start', 'snooze_30', 'replan'],
    updated_at: now.toISOString(),
    next_action: {
      entity_type: entityType,
      entity_id: entityId,
      title,
      action_text: actionText,
      reason_text: reasonText,
      duration_min: durationMin,
      risk_band: riskBand,
      route_fallback: entityType === 'assignment' ? '/college-assignments' : '/daily-tasks',
      action_token: actionToken,
    },
    meta: {
      pending,
      activity_intensity_24h: intensity,
      completion_today: completionToday,
      ignored_push_24h: ignoredPush,
      load_index: loadIndex,
      snooze_count_6h: snoozeCount,
      drift_candidate: drift,
    },
  };
}

export async function buildCoupleSyncSignals(client, schema, now = new Date()) {
  const nowIso = now.toISOString();
  const users = ['Zaldy', 'Nesya'];

  const entries = await Promise.all(users.map(async (user) => {
    const [pending, intensity, completedToday, ignoredPush, nextItem] = await Promise.all([
      readUserPendingStats(client, user, schema, nowIso),
      readUserActivityIntensity(client, user),
      readDailyCompletionCount(client, user, schema, nowIso),
      readIgnoredPushCount(client, user),
      readNextDueItem(client, user, schema),
    ]);
    const loadIndex = computeLoadIndex(pending, intensity, completedToday, ignoredPush);
    return {
      user,
      pending,
      activity_intensity_24h: intensity,
      completion_today: completedToday,
      ignored_push_24h: ignoredPush,
      load_index: loadIndex,
      risk_band: riskBandFromLoadIndex(loadIndex),
      next_best_action: buildActionSentence(nextItem, now),
      next_item: nextItem
        ? {
          source: nextItem.source,
          id: nextItem.id,
          title: nextItem.title,
          deadline: nextItem.deadline,
        }
        : null,
    };
  }));

  const z = entries.find((x) => x.user === 'Zaldy');
  const n = entries.find((x) => x.user === 'Nesya');
  const diff = Math.abs(Number(z?.load_index || 0) - Number(n?.load_index || 0));
  const overloaded = (z?.load_index || 0) >= (n?.load_index || 0) ? z : n;
  const helper = overloaded?.user === 'Zaldy' ? n : z;
  const assistOpportunity = Boolean(overloaded && helper && diff >= 18 && Number(overloaded?.pending?.due_24h || 0) >= 1);
  const riskBand = riskBandFromLoadIndex(Math.max(Number(z?.load_index || 0), Number(n?.load_index || 0)));
  return {
    users: entries.map((item) => ({
      user: item.user,
      load_index: item.load_index,
      risk_band: item.risk_band,
      pending: item.pending,
      activity_intensity_24h: item.activity_intensity_24h,
      completion_today: item.completion_today,
      ignored_push_24h: item.ignored_push_24h,
      next_best_action: item.next_best_action,
      next_item: item.next_item,
    })),
    assist_opportunity: assistOpportunity
      ? {
        active: true,
        target_user: overloaded.user,
        helper_user: helper?.user || null,
        reason: `${overloaded.user} sedang overload. ${helper?.user || 'Partner'} bisa bantu 1 item ringan agar sinkron.`,
      }
      : { active: false },
    next_best_action: overloaded?.next_best_action || 'Lanjutkan 1 sesi fokus bersama malam ini.',
    risk_band: riskBand,
  };
}

async function runCheckinSuggestion(client, window, notify, schema) {
  const stats = { generated: 0, pushed: 0 };
  const users = COUPLE_USERS;
  const chatRes = await client.query(
    `SELECT MAX(created_at) AS last_chat
     FROM chat_messages
     WHERE user_id = ANY($1::text[])
       AND user_id <> 'System'`,
    [users]
  );
  const lastChat = chatRes.rows[0]?.last_chat ? new Date(chatRes.rows[0].last_chat) : null;
  const gapHours = lastChat ? (window.nowUtc.getTime() - lastChat.getTime()) / 3600000 : 999;

  const [zLoad, nLoad] = await Promise.all([
    pendingLoad(client, 'Zaldy', schema),
    pendingLoad(client, 'Nesya', schema),
  ]);
  const highLoad = zLoad >= 4 || nLoad >= 4;
  const shouldSuggest = gapHours >= 16 && (highLoad || window.localHour >= 19);
  if (!shouldSuggest) return stats;

  const body = `Sudah ${Math.floor(gapHours)} jam belum check-in. Saran Nova: 5 menit sync malam ini (status + 1 support request).`;
  for (const user of users) {
    const result = await emitEvent(
      client,
      {
        userId: user,
        eventType: 'checkin_suggestion',
        eventKey: `pair-checkin-${window.localDate}`,
        level: 'info',
        title: 'Couple Check-In',
        body,
        url: '/chat',
        localDate: window.localDate,
        payload: { gap_hours: Number(gapHours.toFixed(2)), z_load: zLoad, n_load: nLoad },
        actions: [{ action: 'open-chat', title: 'Check-In Now' }],
      },
      notify
    );
    if (result.inserted) stats.generated++;
    if (result.pushed) stats.pushed++;
  }

  return stats;
}

async function runCoupleAssistSuggestions(client, window, notify, schema) {
  const stats = { generated: 0, pushed: 0 };
  const couple = await buildCoupleSyncSignals(client, schema, window.nowUtc);
  if (!couple?.assist_opportunity?.active) return stats;
  const helperUser = String(couple.assist_opportunity.helper_user || '').trim();
  const targetUser = String(couple.assist_opportunity.target_user || '').trim();
  if (!helperUser || !targetUser) return stats;

  const helperAction = (couple.users || []).find((x) => x.user === helperUser)?.next_best_action
    || `Bantu ${targetUser} ambil 1 item ringan biar ritme tetap sinkron.`;
  const targetAction = (couple.users || []).find((x) => x.user === targetUser)?.next_best_action
    || 'Ambil 1 sprint fokus 25 menit untuk item paling mepet.';

  const helperRes = await emitEvent(client, {
    userId: helperUser,
    eventType: 'partner_assist_suggestion',
    eventKey: `assist-${targetUser}-${window.localDate}-${window.localHour}`,
    level: 'warning',
    title: 'Sinkron Pasangan',
    body: `${targetUser} lagi overload. ${helperAction}`,
    url: '/chat',
    localDate: window.localDate,
    payload: {
      source: 'general',
      target_user: targetUser,
      helper_user: helperUser,
      suggestion: helperAction,
    },
  }, notify);
  if (helperRes.inserted) stats.generated += 1;
  if (helperRes.pushed) stats.pushed += 1;

  const targetRes = await emitEvent(client, {
    userId: targetUser,
    eventType: 'partner_momentum_prompt',
    eventKey: `momentum-${targetUser}-${window.localDate}-${window.localHour}`,
    level: 'info',
    title: 'Momentum Eksekusi',
    body: targetAction,
    url: '/daily-tasks',
    localDate: window.localDate,
    payload: {
      source: 'task',
      suggestion: targetAction,
    },
  }, notify);
  if (targetRes.inserted) stats.generated += 1;
  if (targetRes.pushed) stats.pushed += 1;

  return stats;
}

async function runExecutionCopilot(client, users, window, notify, schema) {
  const stats = { generated: 0, pushed: 0, drift_followup: 0, daily_close: 0 };
  const targets = Array.isArray(users) && users.length ? users : COUPLE_USERS;
  const localMinute = Number(window.localNow?.getUTCMinutes?.() || 0);
  const shouldDailyClose = window.localHour === 20 && localMinute >= 30 && localMinute <= 50;

  for (const user of targets) {
    const driftCandidate = await findDriftCandidate(client, user);
    const copilot = await buildExecutionCopilotSignals(client, schema, user, window.nowUtc, { driftCandidate });
    const nextAction = copilot?.next_action || {};
    const pending = copilot?.meta?.pending || {};
    const completionToday = Number(copilot?.meta?.completion_today || 0);

    if (driftCandidate && nextAction?.entity_type && nextAction?.entity_id) {
      const followupRes = await emitEvent(client, {
        userId: user,
        eventType: 'execution_followup',
        eventKey: `drift-${nextAction.entity_type}-${nextAction.entity_id}-${window.localDate}-${window.localHour}`,
        level: 'warning',
        title: 'Z AI Follow-up',
        body: `${nextAction.action_text} Kamu sempat mulai, sekarang lanjutkan sampai selesai langkah pertama.`,
        url: nextAction.route_fallback || '/daily-tasks',
        localDate: window.localDate,
        payload: {
          source: nextAction.entity_type,
          entity_type: nextAction.entity_type,
          entity_id: nextAction.entity_id,
          started_at: driftCandidate.started_at,
          age_minutes: driftCandidate.age_minutes,
          risk_band: nextAction.risk_band || 'high',
        },
        push_meta: {
          event_family: 'execution_followup',
          dedup_key: `execution_followup:${nextAction.entity_type}:${nextAction.entity_id}:${window.localDate}`,
        },
      }, notify);
      if (followupRes.inserted) {
        stats.generated += 1;
        stats.drift_followup += 1;
        await logPushEvent(client, user, 'copilot_drift_followup_sent', {
          entity_type: nextAction.entity_type,
          entity_id: nextAction.entity_id,
          event_family: 'execution_followup',
          route: nextAction.route_fallback || '/daily-tasks',
        });
      }
      if (followupRes.pushed) stats.pushed += 1;
    }

    if (shouldDailyClose) {
      const dailyCloseBody = summarizeDailyClose(user, completionToday, pending, nextAction.action_text || '');
      const closeRes = await emitEvent(client, {
        userId: user,
        eventType: 'daily_close_loop',
        eventKey: `daily-close-${user}-${window.localDate}`,
        level: Number(pending.due_6h || 0) > 0 ? 'warning' : 'info',
        title: 'Daily Close Z AI',
        body: dailyCloseBody,
        url: '/chat?ai=ringkasan%20hari%20ini',
        localDate: window.localDate,
        payload: {
          source: 'general',
          completion_today: completionToday,
          pending_total: Number(pending.pending || 0),
          due_24h: Number(pending.due_24h || 0) + Number(pending.due_6h || 0),
          next_action: String(nextAction.action_text || '').trim(),
        },
        push_meta: {
          event_family: 'daily_close',
          dedup_key: `daily_close:${user}:${window.localDate}`,
        },
      }, notify);
      if (closeRes.inserted) {
        stats.generated += 1;
        stats.daily_close += 1;
        await logPushEvent(client, user, 'copilot_daily_close_sent', {
          event_family: 'daily_close',
          route: '/chat?ai=ringkasan%20hari%20ini',
          local_date: window.localDate,
        });
      }
      if (closeRes.pushed) stats.pushed += 1;
    }
  }

  return stats;
}

export async function runProactiveEngine({ now = new Date(), notify = true } = {}) {
  const client = await pool.connect();
  try {
    await ensureProactiveTables(client);
    const schema = await readSchemaFlags(client);
    const window = computeLocalWindow(now);
    const users = await discoverUsers(client, schema);
    const targets = users.length ? users : COUPLE_USERS;

    const morning = await runMorningBrief(client, targets, window, notify, schema);
    const urgent = await runUrgentRadar(client, targets, window, notify, schema);
    const predictive = await runPredictiveRiskRadar(client, targets, window, notify, schema);
    const mood = await runMoodDropAlerts(client, targets, window, notify);
    const checkin = await runCheckinSuggestion(client, window, notify, schema);
    const coupleAssist = await runCoupleAssistSuggestions(client, window, notify, schema);
    const executionCopilot = await runExecutionCopilot(client, targets, window, notify, schema);

    return {
      ok: true,
      window: {
        local_date: window.localDate,
        local_hour: window.localHour,
        offset_hours: window.offsetHours,
      },
      users: targets,
      stats: {
        morning_brief: morning,
        urgent_radar: urgent,
        predictive_risk: predictive,
        mood_drop: mood,
        checkin: checkin,
        couple_assist: coupleAssist,
        execution_copilot: executionCopilot,
      },
    };
  } finally {
    client.release();
  }
}

export async function getProactiveFeedForUser(user, limit = 20) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const client = await pool.connect();
  try {
    await ensureProactiveTables(client);
    const schema = await readSchemaFlags(client);
    const r = await client.query(
      `SELECT id, event_type, level, title, body, url, payload, delivered_push, created_at
       FROM proactive_events
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [user, safeLimit]
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const warningIso = new Date(now.getTime() + 90 * 60000).toISOString();
    const criticalIso = new Date(now.getTime() + 30 * 60000).toISOString();
    const predictiveNearIso = warningIso;
    const predictiveHorizonIso = new Date(now.getTime() + 72 * 3600000).toISOString();

    const taskOwner = buildTaskOwnershipClause(schema, user, 1);
    const taskNowParam = `$${taskOwner.nextParam}`;
    const taskWarningParam = `$${taskOwner.nextParam + 1}`;
    const taskCriticalParam = `$${taskOwner.nextParam + 2}`;
    const taskSignalPromise = client.query(
      `SELECT
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= ${taskNowParam})::int AS overdue_cnt,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > ${taskNowParam} AND deadline <= ${taskCriticalParam})::int AS critical_cnt,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > ${taskCriticalParam} AND deadline <= ${taskWarningParam})::int AS warning_cnt
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwner.clause}`,
      [...taskOwner.params, nowIso, warningIso, criticalIso]
    );

    const assignmentOwner = buildAssignmentOwnershipClause(schema, user, 1);
    const asgNowParam = `$${assignmentOwner.nextParam}`;
    const asgWarningParam = `$${assignmentOwner.nextParam + 1}`;
    const asgCriticalParam = `$${assignmentOwner.nextParam + 2}`;
    const assignmentSignalPromise = client.query(
      `SELECT
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= ${asgNowParam})::int AS overdue_cnt,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > ${asgNowParam} AND deadline <= ${asgCriticalParam})::int AS critical_cnt,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > ${asgCriticalParam} AND deadline <= ${asgWarningParam})::int AS warning_cnt
       FROM assignments
       WHERE completed = FALSE
         AND ${assignmentOwner.clause}`,
      [...assignmentOwner.params, nowIso, warningIso, criticalIso]
    );

    const taskPredictNearParam = `$${taskOwner.nextParam}`;
    const taskPredictHorizonParam = `$${taskOwner.nextParam + 1}`;
    const taskPredictRiskPromise = client.query(
      `SELECT id, title, deadline, priority
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwner.clause}
         AND deadline IS NOT NULL
         AND deadline > ${taskPredictNearParam}
         AND deadline <= ${taskPredictHorizonParam}
       ORDER BY deadline ASC
       LIMIT 40`,
      [...taskOwner.params, predictiveNearIso, predictiveHorizonIso]
    );

    const asgPredictNearParam = `$${assignmentOwner.nextParam}`;
    const asgPredictHorizonParam = `$${assignmentOwner.nextParam + 1}`;
    const assignmentPredictRiskPromise = client.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND ${assignmentOwner.clause}
         AND deadline IS NOT NULL
         AND deadline > ${asgPredictNearParam}
         AND deadline <= ${asgPredictHorizonParam}
       ORDER BY deadline ASC
       LIMIT 40`,
      [...assignmentOwner.params, predictiveNearIso, predictiveHorizonIso]
    );

    const [taskSignals, assignmentSignals, taskPredictRisk, assignmentPredictRisk, coupleSync, executionCopilot] = await Promise.all([
      taskSignalPromise,
      assignmentSignalPromise,
      taskPredictRiskPromise,
      assignmentPredictRiskPromise,
      buildCoupleSyncSignals(client, schema, now),
      buildExecutionCopilotSignals(client, schema, user, now),
    ]);
    const taskRow = taskSignals.rows[0] || {};
    const assignmentRow = assignmentSignals.rows[0] || {};
    const overdueCount = Number(taskRow.overdue_cnt || 0) + Number(assignmentRow.overdue_cnt || 0);
    const criticalCount = Number(taskRow.critical_cnt || 0) + Number(assignmentRow.critical_cnt || 0);
    const warningCount = Number(taskRow.warning_cnt || 0) + Number(assignmentRow.warning_cnt || 0);
    const taskRiskItems = taskPredictRisk.rows.map((item) => predictiveRiskScore(item, 'task', now));
    const assignmentRiskItems = assignmentPredictRisk.rows.map((item) => predictiveRiskScore(item, 'assignment', now));
    const predictiveCriticalCount = [...taskRiskItems, ...assignmentRiskItems].filter((x) => x.riskBand === 'critical').length;
    const predictiveHighCount = [...taskRiskItems, ...assignmentRiskItems].filter((x) => x.riskBand === 'high').length;

    return {
      items: r.rows,
      signals: {
        urgent_count: overdueCount + criticalCount + warningCount,
        warning_count: warningCount,
        critical_count: criticalCount,
        overdue_count: overdueCount,
        predicted_high_count: predictiveHighCount,
        predicted_critical_count: predictiveCriticalCount,
        predicted_total_count: predictiveHighCount + predictiveCriticalCount,
      },
      couple_sync: coupleSync,
      execution_copilot: executionCopilot,
      generated_at: now.toISOString(),
    };
  } finally {
    client.release();
  }
}
