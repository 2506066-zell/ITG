import { pool } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';

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

function levelByMinutes(minutesLeft) {
  if (minutesLeft <= 0) return 'critical';
  if (minutesLeft <= 30) return 'critical';
  if (minutesLeft <= 90) return 'warning';
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

  let pushed = false;
  try {
    await sendNotificationToUser(event.userId, {
      title: event.title,
      body: event.body,
      data: { url: event.url || '/' },
      url: event.url || '/',
      tag: event.eventType,
      actions: event.actions || [],
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
  const stats = { generated: 0, pushed: 0 };
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
    const level = levelByMinutes(minutesLeft);
    const sourceLabel = row.source === 'task' ? 'Task' : 'Assignment';
    const body =
      minutesLeft > 0
        ? `${sourceLabel} "${row.title}" jatuh tempo ${minutesLeft} menit lagi.`
        : `${sourceLabel} "${row.title}" sudah overdue. Tangani sekarang.`;

    for (const user of recipients) {
      const result = await emitEvent(
        client,
        {
          userId: user,
          eventType: 'urgent_radar',
          eventKey: `${row.source}-${row.id}-${hourBucket}`,
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
          },
          actions: [{ action: 'open', title: 'Open' }],
        },
        notify
      );

      if (result.inserted) stats.generated++;
      if (result.pushed) stats.pushed++;
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
    const mood = await runMoodDropAlerts(client, targets, window, notify);
    const checkin = await runCheckinSuggestion(client, window, notify, schema);

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
        mood_drop: mood,
        checkin: checkin,
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
    const soonIso = new Date(now.getTime() + 2 * 3600000).toISOString();
    const taskOwner = buildTaskOwnershipClause(schema, user, 1);
    const deadlineParam = `$${taskOwner.nextParam}`;
    const urgentRes = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND ${taskOwner.clause}
         AND deadline IS NOT NULL
         AND deadline <= ${deadlineParam}`,
      [...taskOwner.params, soonIso]
    );

    return {
      items: r.rows,
      signals: {
        urgent_count: Number(urgentRes.rows[0]?.cnt || 0),
      },
      generated_at: now.toISOString(),
    };
  } finally {
    client.release();
  }
}
