import { pool } from './_lib.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function todayDateText() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateText(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const parsed = new Date(y, mo, d);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== y || parsed.getMonth() !== mo || parsed.getDate() !== d) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function toDateText(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayOfWeekId(dateObj) {
  const jsDay = dateObj.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function urgencyFromDeadline(deadline) {
  if (!deadline) return 'normal';
  const due = new Date(deadline).getTime();
  if (!Number.isFinite(due)) return 'normal';
  const diffMs = due - Date.now();
  if (diffMs <= 0) return 'critical';
  if (diffMs <= 6 * 60 * 60 * 1000) return 'critical';
  if (diffMs <= 24 * 60 * 60 * 1000) return 'warning';
  return 'normal';
}

function shiftDateText(dateText, dayDelta) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dayDelta);
  return d.toISOString().slice(0, 10);
}

function computeStreak(dayRows, anchorDate) {
  const daySet = new Set(dayRows);
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
    if (day === shiftDateText(prev, 1)) run += 1;
    else run = 1;
    if (run > best) best = run;
    prev = day;
  });

  return { current_days: current, best_days: best };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function chooseEnergyState(avgMood, doneMinutes) {
  if (avgMood > 0 && avgMood < 2.8) return 'low';
  if (doneMinutes >= 140) return 'high';
  return 'stable';
}

function buildFocusRecommendation(snapshot) {
  const urgent = snapshot.counters.urgent_items;
  const energy = snapshot.assistant_memory.energy_state;
  if (urgent > 0) return 'Prioritaskan 1 item paling urgent lalu sprint 25 menit.';
  if (energy === 'low') return 'Mulai dari quick-win 15 menit untuk bangun momentum.';
  if (snapshot.counters.study_done_minutes < 60) return 'Tambahkan 1 sesi belajar fokus sebelum jam 21:00.';
  return 'Jaga ritme stabil dan lanjutkan topik prioritas besok pagi.';
}

async function queryStudyProgress(userId, dateText) {
  try {
    const [daySummary, dayList] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::int AS completed_sessions,
           COALESCE(SUM(minutes), 0)::int AS completed_minutes
         FROM study_session_logs
         WHERE user_id=$1 AND plan_date=$2 AND status='done'`,
        [userId, dateText]
      ),
      pool.query(
        `SELECT DISTINCT TO_CHAR(plan_date, 'YYYY-MM-DD') AS day
         FROM study_session_logs
         WHERE user_id=$1 AND status='done'
         ORDER BY day DESC
         LIMIT 400`,
        [userId]
      ),
    ]);

    const summary = daySummary.rows[0] || {};
    const days = dayList.rows.map((r) => r.day).filter(Boolean);
    const streak = computeStreak(days, dateText);
    return {
      completed_sessions: safeNumber(summary.completed_sessions),
      completed_minutes: safeNumber(summary.completed_minutes),
      streak_current_days: streak.current_days,
      streak_best_days: streak.best_days,
    };
  } catch {
    return {
      completed_sessions: 0,
      completed_minutes: 0,
      streak_current_days: 0,
      streak_best_days: 0,
    };
  }
}

export async function buildUnifiedMemorySnapshot(userId, options = {}) {
  const parsed = parseDateText(options.date || '');
  const selectedDate = parsed || new Date();
  selectedDate.setHours(0, 0, 0, 0);

  const dateText = toDateText(selectedDate);
  const dayId = dayOfWeekId(selectedDate);

  const [tasksRes, assignmentsRes, goalsRes, scheduleRes, moodRes, moodLatestRes, partnerRes, studyRes] = await Promise.all([
    pool.query(
      `SELECT id, title, priority, deadline, assigned_to
       FROM tasks
       WHERE is_deleted=FALSE
         AND completed=FALSE
         AND (assigned_to=$1 OR created_by=$1)
       ORDER BY deadline ASC NULLS LAST
       LIMIT 40`,
      [userId]
    ),
    pool.query(
      `SELECT id, title, deadline, assigned_to
       FROM assignments
       WHERE completed=FALSE
         AND (assigned_to=$1 OR assigned_to IS NULL)
       ORDER BY deadline ASC NULLS LAST
       LIMIT 40`,
      [userId]
    ),
    pool.query(
      `SELECT id, title, progress, deadline
       FROM goals
       WHERE is_deleted=FALSE
         AND completed=FALSE
         AND (created_by=$1 OR created_by IS NULL)
       ORDER BY deadline ASC NULLS LAST
       LIMIT 20`,
      [userId]
    ),
    pool.query(
      `SELECT id, subject, time_start, time_end, room
       FROM schedule
       WHERE day_id=$1
       ORDER BY time_start ASC`,
      [dayId]
    ),
    pool.query(
      `SELECT COALESCE(AVG(mood), 0)::float AS avg_mood
       FROM evaluations
       WHERE user_id=$1
         AND created_at >= (NOW() - INTERVAL '7 day')`,
      [userId]
    ),
    pool.query(
      `SELECT mood, note, created_at
       FROM evaluations
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId]
    ),
    pool.query(
      `SELECT user_id, COALESCE(AVG(mood), 0)::float AS avg_mood
       FROM evaluations
       WHERE created_at >= (NOW() - INTERVAL '7 day')
       GROUP BY user_id`,
      []
    ),
    queryStudyProgress(userId, dateText),
  ]);

  const tasks = tasksRes.rows || [];
  const assignments = assignmentsRes.rows || [];
  const goals = goalsRes.rows || [];
  const schedule = scheduleRes.rows || [];
  const avgMood = safeNumber(moodRes.rows?.[0]?.avg_mood, 0);
  const latestMood = moodLatestRes.rows?.[0] || null;
  const partnerPulse = (partnerRes.rows || []).map((r) => ({
    user_id: r.user_id,
    avg_mood_7d: Number(safeNumber(r.avg_mood, 0).toFixed(2)),
  }));

  const mergedDeadlines = [
    ...tasks.map((t) => ({ type: 'task', id: t.id, title: t.title, deadline: t.deadline, urgency: urgencyFromDeadline(t.deadline) })),
    ...assignments.map((a) => ({ type: 'assignment', id: a.id, title: a.title, deadline: a.deadline, urgency: urgencyFromDeadline(a.deadline) })),
  ]
    .sort((a, b) => {
      const da = a.deadline ? new Date(a.deadline).getTime() : Number.POSITIVE_INFINITY;
      const db = b.deadline ? new Date(b.deadline).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    })
    .slice(0, 8);

  const urgentItems = mergedDeadlines.filter((x) => x.urgency === 'critical' || x.urgency === 'warning').length;
  const avgGoalProgress =
    goals.length > 0
      ? Number((goals.reduce((acc, g) => acc + safeNumber(g.progress, 0), 0) / goals.length).toFixed(1))
      : 0;

  const snapshot = {
    date: dateText,
    user: userId,
    counters: {
      tasks_pending: tasks.length,
      assignments_pending: assignments.length,
      goals_active: goals.length,
      today_classes: schedule.length,
      urgent_items: urgentItems,
      study_done_sessions: studyRes.completed_sessions,
      study_done_minutes: studyRes.completed_minutes,
    },
    streak: {
      current_days: studyRes.streak_current_days,
      best_days: studyRes.streak_best_days,
    },
    mood: {
      avg_7d: Number(avgMood.toFixed(2)),
      latest: latestMood
        ? {
            mood: safeNumber(latestMood.mood, 0),
            note: latestMood.note || '',
            at: latestMood.created_at,
          }
        : null,
      partner_pulse: partnerPulse,
    },
    goals: {
      avg_progress: avgGoalProgress,
      items: goals.slice(0, 5),
    },
    deadlines: mergedDeadlines,
    today_schedule: schedule.slice(0, 8),
    assistant_memory: {
      energy_state: chooseEnergyState(avgMood, studyRes.completed_minutes),
      focus_recommendation: '',
    },
    narrative: [],
  };

  snapshot.assistant_memory.focus_recommendation = buildFocusRecommendation(snapshot);

  snapshot.narrative = [
    `Pending: ${snapshot.counters.tasks_pending} task, ${snapshot.counters.assignments_pending} assignment.`,
    `Urgent radar: ${snapshot.counters.urgent_items} item kritis/waspada.`,
    `Study streak: ${snapshot.streak.current_days} hari (best ${snapshot.streak.best_days}).`,
    `Mood 7 hari: ${snapshot.mood.avg_7d}. Energy: ${snapshot.assistant_memory.energy_state}.`,
    snapshot.assistant_memory.focus_recommendation,
  ];

  return snapshot;
}

export function normalizeMemoryDate(rawDate) {
  const parsed = parseDateText(rawDate || '');
  return parsed ? toDateText(parsed) : todayDateText();
}

export function clampStudyTargetMinutes(value, fallback = 150) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), 60, 360);
}

