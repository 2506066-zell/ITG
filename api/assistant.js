import jwt from 'jsonwebtoken';
import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';

const ASSISTANT_ISSUER = 'cute-futura-assistant';
const ASSISTANT_AUDIENCE = 'cute-futura-assistant';
const WRITE_CONFIRM_EXP = '10m';
const ALLOWED_USERS = new Set(['Zaldy', 'Nesya']);

function clampLimit(value, fallback = 8, min = 1, max = 25) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parsePriority(raw = '') {
  const p = raw.toLowerCase();
  if (p === 'high' || p === 'tinggi') return 'high';
  if (p === 'low' || p === 'rendah') return 'low';
  return 'medium';
}

function parseDateFromText(text = '') {
  const msg = text.toLowerCase();
  const now = new Date();

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}))?\b/);
  if (isoDate) {
    const value = new Date(`${isoDate[1]}T${isoDate[2] || '21:00'}:00`);
    if (!Number.isNaN(value.getTime())) return value;
  }

  const dmy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}:\d{2}))?\b/);
  if (dmy) {
    const dd = String(Number(dmy[1])).padStart(2, '0');
    const mm = String(Number(dmy[2])).padStart(2, '0');
    const value = new Date(`${dmy[3]}-${mm}-${dd}T${dmy[4] || '21:00'}:00`);
    if (!Number.isNaN(value.getTime())) return value;
  }

  const timeOnly = text.match(/\b(\d{1,2}:\d{2})\b/);
  const setRelative = (dayDelta) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayDelta);
    const hhmm = timeOnly ? timeOnly[1] : '21:00';
    const [hh, mm] = hhmm.split(':').map(Number);
    d.setHours(Number.isFinite(hh) ? hh : 21, Number.isFinite(mm) ? mm : 0, 0, 0);
    return d;
  };

  if (/(lusa|day after tomorrow)/i.test(msg)) return setRelative(2);
  if (/(besok|tomorrow)/i.test(msg)) return setRelative(1);
  if (/(hari ini|today)/i.test(msg)) return setRelative(0);

  return null;
}

function parseCreateTaskPayload(message = '') {
  const original = message.trim();
  const priorityMatch = original.match(/(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)/i);
  const assignedMatch = original.match(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/i);
  const goalMatch = original.match(/(?:goal|tujuan)\s*#?(\d+)/i);
  const deadline = parseDateFromText(original);

  let title = original.replace(/^(?:buat|tambah|add|create)\s+(?:task|tugas)\s*/i, '').trim();
  const deadlineMarker = title.search(/\b(deadline|due)\b/i);
  if (deadlineMarker >= 0) {
    title = title.slice(0, deadlineMarker).trim();
  }
  title = title
    .replace(/(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)/ig, '')
    .replace(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/ig, '')
    .replace(/(?:goal|tujuan)\s*#?\d+/ig, '')
    .replace(/\b(today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b/ig, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) {
    title = original;
  }

  return {
    title,
    priority: parsePriority(priorityMatch?.[1]),
    assigned_to: assignedMatch ? assignedMatch[1][0].toUpperCase() + assignedMatch[1].slice(1).toLowerCase() : null,
    goal_id: goalMatch ? Number(goalMatch[1]) : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseCreateAssignmentPayload(message = '') {
  const original = message.trim();
  const assignedMatch = original.match(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/i);
  const deadline = parseDateFromText(original);

  let title = original
    .replace(/^(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\s*/i, '')
    .trim();
  const deadlineMarker = title.search(/\b(deadline|due)\b/i);
  if (deadlineMarker >= 0) {
    title = title.slice(0, deadlineMarker).trim();
  }
  title = title
    .replace(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/ig, '')
    .replace(/\b(today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b/ig, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) {
    title = original;
  }

  return {
    title,
    assigned_to: assignedMatch ? assignedMatch[1][0].toUpperCase() + assignedMatch[1].slice(1).toLowerCase() : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseTaskDeadlineUpdatePayload(message = '') {
  const original = message.trim();
  const taskIdMatch = original.match(/(?:task|tugas)(?:\s*id)?\s*#?(\d+)/i);
  const deadline = parseDateFromText(original);
  return {
    id: taskIdMatch ? Number(taskIdMatch[1]) : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseScheduleArgs(message = '') {
  const map = {
    monday: 1, senin: 1,
    tuesday: 2, selasa: 2,
    wednesday: 3, rabu: 3,
    thursday: 4, kamis: 4,
    friday: 5, jumat: 5,
    saturday: 6, sabtu: 6,
    sunday: 7, minggu: 7,
  };

  const lower = message.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (lower.includes(key)) return { day_id: value };
  }

  const now = new Date();
  const plusDays = /(besok|tomorrow)/i.test(lower) ? 1 : /(lusa|day after tomorrow)/i.test(lower) ? 2 : 0;
  now.setDate(now.getDate() + plusDays);
  return { day_id: now.getDay() === 0 ? 7 : now.getDay() };
}

function detectIntent(message = '') {
  const msg = message.trim();
  const lower = msg.toLowerCase();

  if (!msg) return null;

  const createTaskMatch = lower.match(/^(buat|tambah|add|create)\s+(task|tugas)\b/);
  if (createTaskMatch) {
    return {
      tool: 'create_task',
      mode: 'write',
      args: parseCreateTaskPayload(msg),
      summary: 'Buat task baru',
    };
  }

  const createAssignmentMatch = lower.match(/^(buat|tambah|add|create)\s+(assignment|tugas kuliah)\b/);
  if (createAssignmentMatch) {
    return {
      tool: 'create_assignment',
      mode: 'write',
      args: parseCreateAssignmentPayload(msg),
      summary: 'Buat assignment baru',
    };
  }

  if (/(ubah|update|ganti|reschedule|geser)/i.test(lower) && /(deadline|due)/i.test(lower) && /(task|tugas)/i.test(lower)) {
    const args = parseTaskDeadlineUpdatePayload(msg);
    return {
      tool: 'update_task_deadline',
      mode: 'write',
      args,
      summary: args.id ? `Ubah deadline task #${args.id}` : 'Ubah deadline task',
    };
  }

  const completeTaskMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:task|tugas)(?:\s*id)?\s*#?(\d+)/i);
  if (completeTaskMatch) {
    return {
      tool: 'complete_task',
      mode: 'write',
      args: { id: Number(completeTaskMatch[1]) },
      summary: `Tandai task #${completeTaskMatch[1]} selesai`,
    };
  }

  const completeAssignmentMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:assignment|tugas kuliah)(?:\s*id)?\s*#?(\d+)/i);
  if (completeAssignmentMatch) {
    return {
      tool: 'complete_assignment',
      mode: 'write',
      args: { id: Number(completeAssignmentMatch[1]) },
      summary: `Tandai assignment #${completeAssignmentMatch[1]} selesai`,
    };
  }

  if (/(jadwal|schedule|kuliah)/i.test(lower)) {
    return {
      tool: 'get_schedule',
      mode: 'read',
      args: parseScheduleArgs(msg),
      summary: 'Lihat jadwal',
    };
  }

  if (/(assignment|tugas kuliah|kuliah)/i.test(lower) && /(deadline|pending|belum|list|daftar|apa)/i.test(lower)) {
    return {
      tool: 'get_assignments',
      mode: 'read',
      args: { limit: 8, pending_only: true },
      summary: 'Lihat assignment',
    };
  }

  if (/(goal|tujuan|target)/i.test(lower)) {
    return {
      tool: 'get_goals',
      mode: 'read',
      args: { limit: 8, active_only: true },
      summary: 'Lihat goals',
    };
  }

  const reportMonthly = /(report|laporan|ringkasan)/i.test(lower) && /(bulanan|monthly)/i.test(lower);
  const reportWeekly = /(report|laporan|ringkasan)/i.test(lower) && /(mingguan|weekly)/i.test(lower);
  if (reportMonthly || reportWeekly) {
    return {
      tool: 'get_report',
      mode: 'read',
      args: { type: reportMonthly ? 'monthly' : 'weekly' },
      summary: 'Lihat report',
    };
  }

  if (/(task|tugas|todo|to-do|deadline)/i.test(lower)) {
    return {
      tool: 'get_tasks',
      mode: 'read',
      args: { limit: 8, pending_only: true, scope: 'mine' },
      summary: 'Lihat task',
    };
  }

  if (/(brief|ringkas|hari ini|today|summary)/i.test(lower)) {
    return {
      tool: 'get_daily_brief',
      mode: 'read',
      args: { limit: 5 },
      summary: 'Ringkasan hari ini',
    };
  }

  return {
    tool: 'help',
    mode: 'read',
    args: {},
    summary: 'Bantuan asisten',
  };
}

function dayLabel(dayId) {
  const map = {
    1: 'Monday',
    2: 'Tuesday',
    3: 'Wednesday',
    4: 'Thursday',
    5: 'Friday',
    6: 'Saturday',
    7: 'Sunday',
  };
  return map[dayId] || 'Unknown';
}

function formatDeadline(iso) {
  if (!iso) return 'no deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'invalid date';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function summarizeRead(toolName, data, user) {
  if (toolName === 'get_tasks') {
    if (!data.items.length) return `Tidak ada task aktif untuk ${user}.`;
    const top = data.items.slice(0, 5).map((t) => `#${t.id} ${t.title} (${t.priority})`).join(' | ');
    return `Ada ${data.items.length} task aktif. Prioritas terdekat: ${top}`;
  }

  if (toolName === 'get_schedule') {
    if (!data.items.length) return `Tidak ada jadwal untuk ${dayLabel(data.day_id)}.`;
    const top = data.items.slice(0, 5).map((c) => `${c.time_start.slice(0, 5)} ${c.subject}`).join(' | ');
    return `Jadwal ${dayLabel(data.day_id)}: ${top}`;
  }

  if (toolName === 'get_goals') {
    if (!data.items.length) return 'Belum ada goal aktif.';
    const top = data.items.slice(0, 5).map((g) => `#${g.id} ${g.title} (${g.progress || 0}%)`).join(' | ');
    return `Ada ${data.items.length} goal aktif. ${top}`;
  }

  if (toolName === 'get_assignments') {
    if (!data.items.length) return 'Tidak ada assignment pending.';
    const top = data.items.slice(0, 5).map((a) => `#${a.id} ${a.title}`).join(' | ');
    return `Ada ${data.items.length} assignment pending. ${top}`;
  }

  if (toolName === 'get_report') {
    return `Report ${data.type}: completed tasks=${data.completed_tasks}, completed assignments=${data.completed_assignments}, avg mood=${data.avg_mood}`;
  }

  if (toolName === 'get_daily_brief') {
    const lines = [];
    lines.push(`Task pending: ${data.tasks.length}`);
    lines.push(`Assignment pending: ${data.assignments.length}`);
    lines.push(`Jadwal hari ini: ${data.schedule.length}`);
    return lines.join(' | ');
  }

  if (toolName === 'help') {
    return `Perintah yang didukung: ${data.tips.join(' | ')}`;
  }

  return 'Perintah diproses.';
}

async function toolGetTasks(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const values = [ctx.user, limit];
  const pendingSql = args.pending_only !== false ? 'AND completed = FALSE' : '';

  const r = await pool.query(
    `SELECT id, title, priority, deadline, completed, assigned_to, goal_id
     FROM tasks
     WHERE is_deleted = FALSE
       AND (assigned_to = $1 OR created_by = $1 OR completed_by = $1)
       ${pendingSql}
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $2`,
    values
  );

  return { items: r.rows };
}

async function toolGetSchedule(_ctx, args = {}) {
  const dayId = Number(args.day_id) || 1;
  const r = await pool.query(
    `SELECT id, day_id, subject, room, time_start, time_end, lecturer
     FROM schedule
     WHERE day_id = $1
     ORDER BY time_start ASC`,
    [dayId]
  );
  return { day_id: dayId, items: r.rows };
}

async function toolGetGoals(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const r = await pool.query(
    `SELECT id, title, category, deadline, progress, completed, created_by
     FROM goals
     WHERE is_deleted = FALSE
       AND (completed = FALSE OR $2::boolean = FALSE)
       AND (created_by = $1 OR created_by IS NULL)
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $3`,
    [ctx.user, args.active_only !== false, limit]
  );
  return { items: r.rows };
}

async function toolGetAssignments(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const pendingSql = args.pending_only !== false ? 'AND completed = FALSE' : '';
  const r = await pool.query(
    `SELECT id, title, deadline, completed, assigned_to
     FROM assignments
     WHERE 1=1
       ${pendingSql}
       AND (assigned_to = $1 OR assigned_to IS NULL)
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $2`,
    [ctx.user, limit]
  );
  return { items: r.rows };
}

function getPeriodRange(type = 'weekly') {
  const now = new Date();
  let start;
  let end;

  if (type === 'monthly') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, type };
  }

  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  start = new Date(now);
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);

  end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end, type: 'weekly' };
}

async function toolGetReport(ctx, args = {}) {
  const range = getPeriodRange(args.type === 'monthly' ? 'monthly' : 'weekly');
  const [tasks, assignments, moods] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM tasks
       WHERE completed = TRUE
         AND is_deleted = FALSE
         AND completed_by = $1
         AND completed_at >= $2
         AND completed_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM assignments
       WHERE completed = TRUE
         AND completed_by = $1
         AND completed_at >= $2
         AND completed_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
    pool.query(
      `SELECT AVG(mood)::float AS avg_mood
       FROM evaluations
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
  ]);

  const avgMoodRaw = Number(moods.rows[0]?.avg_mood ?? 0);

  return {
    type: range.type,
    period: { start: range.start.toISOString(), end: range.end.toISOString() },
    completed_tasks: Number(tasks.rows[0]?.cnt || 0),
    completed_assignments: Number(assignments.rows[0]?.cnt || 0),
    avg_mood: Number(avgMoodRaw.toFixed(2)),
  };
}

async function toolGetDailyBrief(ctx, args = {}) {
  const limit = clampLimit(args.limit, 5);
  const today = new Date();
  const dayId = today.getDay() === 0 ? 7 : today.getDay();

  const [tasks, assignments, schedule] = await Promise.all([
    pool.query(
      `SELECT id, title, priority, deadline
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND (assigned_to = $1 OR created_by = $1)
       ORDER BY deadline ASC NULLS LAST
       LIMIT $2`,
      [ctx.user, limit]
    ),
    pool.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND (assigned_to = $1 OR assigned_to IS NULL)
       ORDER BY deadline ASC NULLS LAST
       LIMIT $2`,
      [ctx.user, limit]
    ),
    pool.query(
      `SELECT id, subject, time_start, time_end, room
       FROM schedule
       WHERE day_id = $1
       ORDER BY time_start ASC
       LIMIT $2`,
      [dayId, limit]
    ),
  ]);

  return {
    day_id: dayId,
    tasks: tasks.rows,
    assignments: assignments.rows,
    schedule: schedule.rows,
  };
}

async function toolCreateTask(ctx, args = {}) {
  const title = (args.title || '').toString().trim();
  if (!title) {
    const err = new Error('Title task tidak boleh kosong');
    err.statusCode = 400;
    throw err;
  }

  const assignedTo = ALLOWED_USERS.has(args.assigned_to) ? args.assigned_to : ctx.user;
  const priority = parsePriority(args.priority || 'medium');
  const goalId = args.goal_id ? Number(args.goal_id) : null;
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (deadline && Number.isNaN(deadline.getTime())) {
    const err = new Error('Format deadline tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO tasks (title, created_by, updated_by, deadline, priority, assigned_to, goal_id)
       VALUES ($1, $2, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, ctx.user, deadline, priority, assignedTo, goalId]
    );
    const row = inserted.rows[0];
    await logActivity(client, 'task', row.id, 'CREATE', ctx.user, {
      title: row.title,
      priority: row.priority,
      assigned_to: row.assigned_to,
      deadline: row.deadline,
      goal_id: row.goal_id,
    });
    await client.query('COMMIT');
    return { item: row };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCreateAssignment(ctx, args = {}) {
  const title = (args.title || '').toString().trim();
  if (!title) {
    const err = new Error('Title assignment tidak boleh kosong');
    err.statusCode = 400;
    throw err;
  }

  const assignedTo = ALLOWED_USERS.has(args.assigned_to) ? args.assigned_to : ctx.user;
  const description = args.description ? String(args.description).trim() : null;
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (deadline && Number.isNaN(deadline.getTime())) {
    const err = new Error('Format deadline assignment tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO assignments (title, description, deadline, assigned_to)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, description, deadline, assignedTo]
    );
    const row = inserted.rows[0];
    await logActivity(client, 'assignment', row.id, 'CREATE', ctx.user, {
      title: row.title,
      description: row.description,
      assigned_to: row.assigned_to,
      deadline: row.deadline,
    });
    await client.query('COMMIT');
    return { item: row };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function computeTaskScore(task) {
  let score = 10;
  const prio = task.priority || 'medium';
  if (prio === 'medium') score = Math.round(score * 1.5);
  if (prio === 'high') score = Math.round(score * 2);

  if (task.deadline) {
    const dl = new Date(task.deadline);
    if (!Number.isNaN(dl.getTime()) && new Date() <= dl) {
      score += 5;
    }
  }

  if (task.goal_id) score += 5;
  return score;
}

async function toolUpdateTaskDeadline(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('Sertakan id task yang valid. Contoh: "ubah deadline task 12 besok 20:00"');
    err.statusCode = 400;
    throw err;
  }
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) {
    const err = new Error('Sertakan deadline yang valid. Contoh: "ubah deadline task 12 besok 20:00"');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      const err = new Error('Task tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const task = current.rows[0];
    const isOwner = task.created_by === ctx.user || !task.created_by;
    const isAssigned = task.assigned_to === ctx.user;
    if (!isOwner && !isAssigned) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    const prevDeadline = task.deadline || null;
    const updated = await client.query(
      `UPDATE tasks
       SET deadline = $1,
           updated_by = $2,
           version = COALESCE(version, 0) + 1
       WHERE id = $3
       RETURNING *`,
      [deadline, ctx.user, idNum]
    );

    const row = updated.rows[0];
    await logActivity(client, 'task', idNum, 'UPDATE', ctx.user, {
      deadline_before: prevDeadline,
      deadline_after: row.deadline,
    });
    await client.query('COMMIT');
    return { item: row, previous_deadline: prevDeadline };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCompleteTask(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('ID task tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      const err = new Error('Task tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const task = current.rows[0];
    const isOwner = task.created_by === ctx.user || !task.created_by;
    const isAssigned = task.assigned_to === ctx.user;
    if (!isOwner && !isAssigned) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    if (task.completed) {
      await client.query('COMMIT');
      return { item: task, already_completed: true };
    }

    const score = computeTaskScore(task);
    const updated = await client.query(
      `UPDATE tasks
       SET completed = TRUE,
           score_awarded = $1,
           completed_at = NOW(),
           completed_by = $2,
           updated_by = $2,
           version = COALESCE(version, 0) + 1
       WHERE id = $3
       RETURNING *`,
      [score, ctx.user, idNum]
    );

    const row = updated.rows[0];
    await logActivity(client, 'task', idNum, 'UPDATE', ctx.user, {
      completed: true,
      score_awarded: score,
      completed_by: ctx.user,
    });
    await client.query('COMMIT');
    return { item: row, already_completed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCompleteAssignment(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('ID assignment tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM assignments WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0) {
      const err = new Error('Assignment tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const row = current.rows[0];
    if (row.assigned_to && row.assigned_to !== ctx.user) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    if (row.completed) {
      await client.query('COMMIT');
      return { item: row, already_completed: true };
    }

    const updated = await client.query(
      `UPDATE assignments
       SET completed = TRUE,
           completed_at = NOW(),
           completed_by = $1
       WHERE id = $2
       RETURNING *`,
      [ctx.user, idNum]
    );

    const item = updated.rows[0];
    await logActivity(client, 'assignment', idNum, 'UPDATE', ctx.user, {
      completed: true,
      completed_by: ctx.user,
    });
    await client.query('COMMIT');

    // Keep partner alert behavior consistent with assignments API
    const partner = ctx.user === 'Zaldy' ? 'Nesya' : (ctx.user === 'Nesya' ? 'Zaldy' : null);
    if (partner) {
      const msg = `${ctx.user} telah menyelesaikan tugas kuliah "${row.title}". Semangat ya! 🎓`;
      sendNotificationToUser(partner, {
        title: 'Assignment Done ✅',
        body: msg,
        url: '/college-assignments'
      }).catch(console.error);
    }

    return { item, already_completed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const TOOLS = {
  help: {
    mode: 'read',
    run: async () => ({
      tips: [
        'Lihat task: "apa task saya hari ini"',
        'Lihat jadwal: "jadwal besok"',
        'Lihat goals: "goal aktif"',
        'Lihat assignment: "assignment pending"',
        'Lihat report: "report mingguan" atau "report bulanan"',
        'Buat task: "buat task belajar basis data deadline besok 19:00 priority high"',
        'Ubah deadline task: "ubah deadline task 12 besok 20:00"',
        'Selesaikan task: "selesaikan task 12"',
        'Buat assignment: "buat assignment makalah AI deadline 2026-03-01 20:00"',
        'Selesaikan assignment: "selesaikan assignment 5"',
      ],
    }),
  },
  get_tasks: { mode: 'read', run: toolGetTasks },
  get_schedule: { mode: 'read', run: toolGetSchedule },
  get_goals: { mode: 'read', run: toolGetGoals },
  get_assignments: { mode: 'read', run: toolGetAssignments },
  get_report: { mode: 'read', run: toolGetReport },
  get_daily_brief: { mode: 'read', run: toolGetDailyBrief },
  create_task: { mode: 'write', run: toolCreateTask },
  create_assignment: { mode: 'write', run: toolCreateAssignment },
  update_task_deadline: { mode: 'write', run: toolUpdateTaskDeadline },
  complete_task: { mode: 'write', run: toolCompleteTask },
  complete_assignment: { mode: 'write', run: toolCompleteAssignment },
};

function buildConfirmationToken(user, tool, args, summary, originalMessage) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    const err = new Error('Server misconfigured');
    err.statusCode = 500;
    throw err;
  }

  return jwt.sign(
    {
      type: 'assistant_action',
      requested_by: user,
      tool,
      args,
      summary: summary || tool,
      original_message: originalMessage || '',
      requested_at: new Date().toISOString(),
    },
    secret,
    {
      expiresIn: WRITE_CONFIRM_EXP,
      issuer: ASSISTANT_ISSUER,
      audience: ASSISTANT_AUDIENCE,
      algorithm: 'HS256',
    }
  );
}

function readConfirmationToken(token) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    const err = new Error('Server misconfigured');
    err.statusCode = 500;
    throw err;
  }
  return jwt.verify(token, secret, {
    issuer: ASSISTANT_ISSUER,
    audience: ASSISTANT_AUDIENCE,
    algorithms: ['HS256'],
  });
}

function errorStatus(err) {
  return err && Number.isFinite(err.statusCode) ? err.statusCode : 500;
}

function createError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function writeExecutionReply(toolName, result) {
  if (toolName === 'create_task') {
    const item = result.item;
    return `Task berhasil dibuat: #${item.id} ${item.title} (priority ${item.priority}, deadline ${formatDeadline(item.deadline)})`;
  }

  if (toolName === 'create_assignment') {
    const item = result.item;
    return `Assignment berhasil dibuat: #${item.id} ${item.title} (deadline ${formatDeadline(item.deadline)})`;
  }

  if (toolName === 'update_task_deadline') {
    const item = result.item;
    return `Deadline task #${item.id} diubah ke ${formatDeadline(item.deadline)}.`;
  }

  if (toolName === 'complete_task') {
    if (result.already_completed) {
      return `Task #${result.item.id} sudah dalam status completed.`;
    }
    return `Task #${result.item.id} ditandai selesai. Score: ${result.item.score_awarded}`;
  }

  if (toolName === 'complete_assignment') {
    if (result.already_completed) {
      return `Assignment #${result.item.id} sudah completed.`;
    }
    return `Assignment #${result.item.id} ditandai selesai.`;
  }

  return 'Aksi write berhasil dijalankan.';
}

function isStreamRequest(req, body) {
  if (body && body.stream === true) return true;
  const u = new URL(req.url, 'http://x');
  const pathQuery = (u.searchParams.get('path') || '').toString().toLowerCase();
  const pathname = (u.pathname || '').toLowerCase();
  return pathQuery.startsWith('assistant/stream') || pathname.endsWith('/assistant/stream');
}

function splitTextChunks(text = '', maxLen = 18) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

function initSse(res, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function sendSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamPayload(res, payload) {
  initSse(res, 200);
  sendSseEvent(res, 'start', {
    mode: payload.mode,
    tool: payload.tool || '',
    tool_calls: payload.tool_calls || [],
  });

  const chunks = splitTextChunks(payload.reply || '', 16);
  for (const chunk of chunks) {
    sendSseEvent(res, 'delta', { text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 14));
  }

  sendSseEvent(res, 'result', payload);
  sendSseEvent(res, 'done', { ok: true });
  res.end();
}

function streamError(res, status, message) {
  initSse(res, status);
  sendSseEvent(res, 'error', { error: message, status });
  sendSseEvent(res, 'done', { ok: false });
  res.end();
}

async function processAssistantRequest(user, body = {}) {
  const wantsConfirm = body.confirm === true;

  if (wantsConfirm) {
    const token = (body.confirmation_token || '').toString().trim();
    if (!token) {
      throw createError('Missing confirmation_token', 400);
    }

    let payload;
    try {
      payload = readConfirmationToken(token);
    } catch {
      throw createError('Invalid or expired confirmation token', 401);
    }

    if (!payload || payload.type !== 'assistant_action') {
      throw createError('Invalid confirmation token', 400);
    }
    if (payload.requested_by !== user) {
      throw createError('Token does not belong to current user', 403);
    }

    const def = TOOLS[payload.tool];
    if (!def || def.mode !== 'write') {
      throw createError('Invalid write tool in confirmation token', 400);
    }

    const result = await def.run({ user }, payload.args || {});
    return {
      ok: true,
      mode: 'write_executed',
      tool: payload.tool,
      tool_calls: [{ name: payload.tool, mode: 'write', args: payload.args || {} }],
      reply: writeExecutionReply(payload.tool, result),
      data: result,
    };
  }

  const message = (body.message || '').toString().trim();
  if (!message) {
    throw createError('Message required', 400);
  }

  const intent = detectIntent(message);
  if (!intent) {
    throw createError('Unable to detect intent', 400);
  }

  const intentWithUser = {
    ...intent,
    args: {
      ...(intent.args || {}),
      ...(intent.tool === 'create_task' ? { assigned_to: intent.args.assigned_to || user } : {}),
      ...(intent.tool === 'create_assignment' ? { assigned_to: intent.args.assigned_to || user } : {}),
    },
  };

  const def = TOOLS[intentWithUser.tool];
  if (!def) {
    throw createError('Unknown assistant tool', 400);
  }

  if (def.mode === 'write') {
    const confirmationToken = buildConfirmationToken(
      user,
      intentWithUser.tool,
      intentWithUser.args,
      intentWithUser.summary,
      message
    );

    return {
      ok: true,
      mode: 'confirmation_required',
      tool: intentWithUser.tool,
      tool_calls: [{ name: intentWithUser.tool, mode: 'write', args: intentWithUser.args }],
      reply: `Konfirmasi diperlukan untuk aksi write: ${intentWithUser.summary}. Kirim ulang dengan /confirm.`,
      confirmation_token: confirmationToken,
      preview: {
        summary: intentWithUser.summary,
        args: intentWithUser.args,
      },
    };
  }

  const result = await def.run({ user }, intentWithUser.args || {});
  return {
    ok: true,
    mode: 'read',
    tool: intentWithUser.tool,
    tool_calls: [{ name: intentWithUser.tool, mode: 'read', args: intentWithUser.args || {} }],
    reply: summarizeRead(intentWithUser.tool, result, user),
    data: result,
  };
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const tools = Object.entries(TOOLS).map(([name, def]) => ({ name, mode: def.mode }));
    sendJson(res, 200, {
      ok: true,
      assistant: 'phase-2.0-nla',
      confirmation_required_for_write: true,
      stream_endpoint: '/api/assistant/stream',
      tools,
    }, 10);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || await readBody(req);
  const wantsStream = isStreamRequest(req, body);

  try {
    const payload = await processAssistantRequest(user, body || {});
    if (wantsStream) {
      await streamPayload(res, payload);
      return;
    }

    const cacheSeconds = payload.mode === 'read' ? 5 : 0;
    sendJson(res, 200, payload, cacheSeconds);
  } catch (err) {
    const status = errorStatus(err);
    const message = err.message || 'Failed to process assistant request';
    if (wantsStream) {
      streamError(res, status, message);
      return;
    }
    res.status(status).json({ error: message });
  }
});
