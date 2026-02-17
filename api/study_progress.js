import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';

function isValidDateText(value) {
  if (!value || typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const parsed = new Date(Date.UTC(y, mo, d));
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === mo &&
    parsed.getUTCDate() === d
  );
}

function todayDateText() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDateText(dateText, dayDelta) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayDelta);
  return d.toISOString().slice(0, 10);
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

async function ensureSchema() {
  if (global._studyProgressSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_session_logs (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      plan_date DATE NOT NULL,
      session_key TEXT NOT NULL,
      assignment_id INTEGER,
      title TEXT,
      minutes INTEGER NOT NULL DEFAULT 0,
      start_time TIME,
      end_time TIME,
      method VARCHAR(80),
      status VARCHAR(20) NOT NULL DEFAULT 'done',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, plan_date, session_key)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_study_session_logs_user_date
      ON study_session_logs(user_id, plan_date);
  `);
  global._studyProgressSchemaReady = true;
}

function computeStreak(daysDesc, anchorDate) {
  const daySet = new Set(daysDesc);
  let current = 0;
  let cursor = anchorDate;
  while (daySet.has(cursor)) {
    current += 1;
    cursor = shiftDateText(cursor, -1);
  }

  const asc = [...daySet].sort();
  let best = 0;
  let run = 0;
  let prev = null;
  asc.forEach((day) => {
    if (!prev) {
      run = 1;
      best = 1;
      prev = day;
      return;
    }
    const expected = shiftDateText(prev, 1);
    if (day === expected) {
      run += 1;
    } else {
      run = 1;
    }
    if (run > best) best = run;
    prev = day;
  });

  return {
    current_days: current,
    best_days: best,
    active_days: daySet.size,
  };
}

async function buildPayload(userId, dateText) {
  const [doneRowsRes, daySummaryRes, dayListRes, timelineRes] = await Promise.all([
    pool.query(
      `SELECT session_key
       FROM study_session_logs
       WHERE user_id=$1 AND plan_date=$2 AND status='done'
       ORDER BY completed_at DESC`,
      [userId, dateText]
    ),
    pool.query(
      `SELECT
         COUNT(*)::int AS completed_sessions,
         COALESCE(SUM(minutes), 0)::int AS completed_minutes,
         MAX(completed_at) AS last_completed_at
       FROM study_session_logs
       WHERE user_id=$1 AND plan_date=$2 AND status='done'`,
      [userId, dateText]
    ),
    pool.query(
      `SELECT DISTINCT TO_CHAR(plan_date, 'YYYY-MM-DD') AS day
       FROM study_session_logs
       WHERE user_id=$1 AND status='done'
       ORDER BY day DESC
       LIMIT 450`,
      [userId]
    ),
    pool.query(
      `SELECT
         TO_CHAR(plan_date, 'YYYY-MM-DD') AS day,
         COUNT(*)::int AS sessions,
         COALESCE(SUM(minutes), 0)::int AS minutes
       FROM study_session_logs
       WHERE user_id=$1
         AND status='done'
         AND plan_date >= ($2::date - INTERVAL '6 day')
         AND plan_date <= $2::date
       GROUP BY plan_date
       ORDER BY plan_date`,
      [userId, dateText]
    ),
  ]);

  const daySummary = daySummaryRes.rows[0] || {};
  const daysDesc = dayListRes.rows.map((r) => r.day).filter(Boolean);
  const streak = computeStreak(daysDesc, dateText);

  return {
    date: dateText,
    completed_keys: doneRowsRes.rows.map((r) => r.session_key),
    summary: {
      completed_sessions: toInt(daySummary.completed_sessions),
      completed_minutes: toInt(daySummary.completed_minutes),
      last_completed_at: daySummary.last_completed_at || null,
      streak_current_days: streak.current_days,
      streak_best_days: streak.best_days,
      active_days: streak.active_days,
      timeline_7d: timelineRes.rows.map((r) => ({
        day: r.day,
        sessions: toInt(r.sessions),
        minutes: toInt(r.minutes),
      })),
    },
  };
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  await ensureSchema();
  const userId = v.user;

  if (req.method === 'GET') {
    const u = new URL(req.url, 'http://x');
    const dateText = u.searchParams.get('date') || todayDateText();
    if (!isValidDateText(dateText)) {
      res.status(400).json({ error: 'Invalid date' });
      return;
    }
    const payload = await buildPayload(userId, dateText);
    sendJson(res, 200, payload, 15);
    return;
  }

  if (req.method === 'POST') {
    const b = req.body || (await readBody(req));
    const action = String(b.action || '').toLowerCase();
    const dateText = String(b.plan_date || todayDateText());
    const sessionKey = String(b.session_key || '').trim();

    if (!isValidDateText(dateText)) {
      res.status(400).json({ error: 'Invalid plan_date' });
      return;
    }
    if (!sessionKey) {
      res.status(400).json({ error: 'session_key required' });
      return;
    }
    if (action !== 'complete' && action !== 'undo') {
      res.status(400).json({ error: 'action must be complete or undo' });
      return;
    }

    if (action === 'complete') {
      const minutes = clampMinutes(b.minutes);
      const assignmentId = Number.isFinite(Number(b.assignment_id)) ? Number(b.assignment_id) : null;
      const title = b.title ? String(b.title).slice(0, 250) : null;
      const start = normalizeTimeOrNull(b.start);
      const end = normalizeTimeOrNull(b.end);
      const method = b.method ? String(b.method).slice(0, 80) : null;
      const metadata = JSON.stringify({
        urgency: b.urgency || null,
        reason: b.reason || null,
      });

      await pool.query(
        `INSERT INTO study_session_logs
          (user_id, plan_date, session_key, assignment_id, title, minutes, start_time, end_time, method, status, metadata, completed_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'done', $10::jsonb, NOW())
         ON CONFLICT (user_id, plan_date, session_key)
         DO UPDATE SET
          assignment_id=EXCLUDED.assignment_id,
          title=EXCLUDED.title,
          minutes=EXCLUDED.minutes,
          start_time=EXCLUDED.start_time,
          end_time=EXCLUDED.end_time,
          method=EXCLUDED.method,
          status='done',
          metadata=EXCLUDED.metadata,
          completed_at=NOW()`,
        [userId, dateText, sessionKey, assignmentId, title, minutes, start, end, method, metadata]
      );
    } else {
      await pool.query(
        `DELETE FROM study_session_logs
         WHERE user_id=$1 AND plan_date=$2 AND session_key=$3`,
        [userId, dateText, sessionKey]
      );
    }

    const payload = await buildPayload(userId, dateText);
    sendJson(res, 200, payload);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});

function normalizeTimeOrNull(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${m[1]}:${m[2]}:00`;
}

function clampMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(240, Math.round(n)));
}

