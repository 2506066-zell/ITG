import { pool, verifyToken, withErrorHandling, sendJson } from './_lib.js';

const DEFAULT_TARGET_MINUTES = 150;
const MIN_TARGET_MINUTES = 60;
const MAX_TARGET_MINUTES = 360;
const STUDY_START_MINUTES = 8 * 60;
const STUDY_END_MINUTES = 22 * 60;
const SESSION_MAX_MINUTES = 50;
const SESSION_MIN_MINUTES = 25;
const SESSION_BREAK_MINUTES = 10;
const MAX_SESSIONS = 8;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseDayParam(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
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

function toDateLabel(day) {
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, '0');
  const d = String(day.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dayOfWeekId(day) {
  const jsDay = day.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function parseTimeMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const part = value.slice(0, 5);
  const m = part.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function toTimeLabel(minutes) {
  const m = clamp(Math.floor(minutes), 0, 1439);
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function keywordBonus(text) {
  if (!text) return 0;
  const value = String(text);
  const hit = /(uts|uas|ujian|quiz|kuis|praktikum|project|proposal|laporan|final|sidang|skripsi)/i.test(value);
  return hit ? 18 : 0;
}

function urgencyFromHours(hoursLeft) {
  if (!Number.isFinite(hoursLeft)) return { score: 26, desiredMinutes: 35, urgency: 'good', reason: 'Backlog progress' };
  if (hoursLeft <= 0) return { score: 128, desiredMinutes: 130, urgency: 'critical', reason: 'Overdue recovery' };
  if (hoursLeft <= 6) return { score: 116, desiredMinutes: 120, urgency: 'critical', reason: 'Deadline < 6h' };
  if (hoursLeft <= 24) return { score: 102, desiredMinutes: 110, urgency: 'critical', reason: 'Deadline < 24h' };
  if (hoursLeft <= 72) return { score: 84, desiredMinutes: 90, urgency: 'warning', reason: 'Deadline < 3 days' };
  if (hoursLeft <= 168) return { score: 62, desiredMinutes: 65, urgency: 'warning', reason: 'Deadline < 7 days' };
  return { score: 38, desiredMinutes: 45, urgency: 'good', reason: 'Long-range progress' };
}

function buildAssignmentSignals(assignments, planningBaseMs) {
  return assignments
    .map((a) => {
      const deadlineMs = a.deadline ? new Date(a.deadline).getTime() : Number.NaN;
      const hoursLeft = Number.isFinite(deadlineMs) ? (deadlineMs - planningBaseMs) / (60 * 60 * 1000) : Number.POSITIVE_INFINITY;
      const urgency = urgencyFromHours(hoursLeft);
      const textBonus = keywordBonus(`${a.title || ''} ${a.description || ''}`);
      const score = urgency.score + textBonus;
      const desiredMinutes = clamp(urgency.desiredMinutes + textBonus, 30, 180);

      return {
        id: a.id,
        title: a.title || 'Untitled Assignment',
        deadline: a.deadline || null,
        urgency: urgency.urgency,
        urgencyReason: urgency.reason,
        score,
        desiredMinutes,
        remainingNeed: desiredMinutes,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

function mergeBusyRanges(ranges) {
  const clean = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start)
    .sort((a, b) => a.start - b.start);
  if (!clean.length) return [];

  const merged = [clean[0]];
  for (let i = 1; i < clean.length; i += 1) {
    const cur = clean[i];
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

function buildFreeRanges(busyRanges) {
  const free = [];
  let cursor = STUDY_START_MINUTES;
  const boundedBusy = mergeBusyRanges(
    busyRanges.map((r) => ({
      start: clamp(r.start, STUDY_START_MINUTES, STUDY_END_MINUTES),
      end: clamp(r.end, STUDY_START_MINUTES, STUDY_END_MINUTES),
    }))
  );

  boundedBusy.forEach((r) => {
    if (r.start > cursor) free.push({ start: cursor, end: r.start });
    cursor = Math.max(cursor, r.end);
  });

  if (cursor < STUDY_END_MINUTES) {
    free.push({ start: cursor, end: STUDY_END_MINUTES });
  }
  return free;
}

function buildSessionSlots(freeRanges) {
  const slots = [];
  for (const range of freeRanges) {
    let cur = range.start;
    while (cur + SESSION_MIN_MINUTES <= range.end && slots.length < MAX_SESSIONS) {
      const slotEnd = Math.min(cur + SESSION_MAX_MINUTES, range.end);
      const slotLen = slotEnd - cur;
      if (slotLen < SESSION_MIN_MINUTES) break;
      slots.push({ start: cur, end: slotEnd, minutes: slotLen });
      cur = slotEnd + SESSION_BREAK_MINUTES;
    }
    if (slots.length >= MAX_SESSIONS) break;
  }
  return slots;
}

function pickAssignment(assignments) {
  const sorted = assignments
    .slice()
    .sort((a, b) => {
      if (b.remainingNeed !== a.remainingNeed) return b.remainingNeed - a.remainingNeed;
      return b.score - a.score;
    });
  return sorted[0] || null;
}

function sessionMethod(index) {
  const methods = ['Active Recall', 'Practice Drill', 'Review Notes', 'Mini Quiz'];
  return methods[index % methods.length];
}

function mapFocusLoad(totalMinutes, criticalCount) {
  if (criticalCount >= 2 || totalMinutes >= 240) return 'high';
  if (criticalCount >= 1 || totalMinutes >= 150) return 'medium';
  return 'light';
}

function normalizeWindow(raw) {
  const value = String(raw || '').toLowerCase().trim();
  if (value === 'morning' || value === 'pagi') return 'morning';
  if (value === 'afternoon' || value === 'siang') return 'afternoon';
  if (value === 'evening' || value === 'malam') return 'evening';
  return 'any';
}

function windowRanges(windowName) {
  if (windowName === 'morning') return [{ start: 5 * 60, end: 12 * 60 }];
  if (windowName === 'afternoon') return [{ start: 12 * 60, end: 17 * 60 }];
  if (windowName === 'evening') return [{ start: 17 * 60, end: 23 * 60 }];
  return [{ start: 0, end: 24 * 60 }];
}

function intersectRanges(a, b) {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  if (end <= start) return null;
  return { start, end };
}

function applyWindowFilter(freeRanges, windowName) {
  const windows = windowRanges(windowName);
  const out = [];
  freeRanges.forEach((fr) => {
    windows.forEach((wr) => {
      const x = intersectRanges(fr, wr);
      if (x) out.push(x);
    });
  });
  return out.sort((x, y) => x.start - y.start);
}

export async function ensureStudyPreferenceSchema() {
  if (global._studyPrefSchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS study_preferences (
      user_id VARCHAR(60) PRIMARY KEY,
      target_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_TARGET_MINUTES},
      preferred_window VARCHAR(20) NOT NULL DEFAULT 'any',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  global._studyPrefSchemaReady = true;
}

export async function getStudyPreference(userId) {
  await ensureStudyPreferenceSchema();
  const r = await pool.query(
    `SELECT user_id, target_minutes, preferred_window, updated_at
     FROM study_preferences
     WHERE user_id=$1`,
    [userId]
  );
  if (r.rowCount === 0) {
    return {
      user_id: userId,
      target_minutes: DEFAULT_TARGET_MINUTES,
      preferred_window: 'any',
      updated_at: null,
    };
  }
  const row = r.rows[0];
  return {
    user_id: row.user_id,
    target_minutes: clamp(Number(row.target_minutes || DEFAULT_TARGET_MINUTES), MIN_TARGET_MINUTES, MAX_TARGET_MINUTES),
    preferred_window: normalizeWindow(row.preferred_window),
    updated_at: row.updated_at,
  };
}

export async function setStudyPreference(userId, patch = {}) {
  await ensureStudyPreferenceSchema();
  const current = await getStudyPreference(userId);

  const target = patch.target_minutes !== undefined
    ? clamp(Number(patch.target_minutes || DEFAULT_TARGET_MINUTES), MIN_TARGET_MINUTES, MAX_TARGET_MINUTES)
    : current.target_minutes;
  const windowName = patch.preferred_window !== undefined
    ? normalizeWindow(patch.preferred_window)
    : current.preferred_window;

  const r = await pool.query(
    `INSERT INTO study_preferences (user_id, target_minutes, preferred_window, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET target_minutes=EXCLUDED.target_minutes, preferred_window=EXCLUDED.preferred_window, updated_at=NOW()
     RETURNING user_id, target_minutes, preferred_window, updated_at`,
    [userId, target, windowName]
  );

  const row = r.rows[0];
  return {
    user_id: row.user_id,
    target_minutes: clamp(Number(row.target_minutes || DEFAULT_TARGET_MINUTES), MIN_TARGET_MINUTES, MAX_TARGET_MINUTES),
    preferred_window: normalizeWindow(row.preferred_window),
    updated_at: row.updated_at,
  };
}

export async function generateStudyPlanSnapshot(userId, options = {}) {
  await ensureStudyPreferenceSchema();

  const queryDay = parseDayParam(options.date || options.dateText || '');
  const selectedDay = queryDay || new Date();
  selectedDay.setHours(0, 0, 0, 0);

  const preference = await getStudyPreference(userId);
  const targetMinutes = options.targetMinutes !== undefined
    ? clamp(Number(options.targetMinutes || DEFAULT_TARGET_MINUTES), MIN_TARGET_MINUTES, MAX_TARGET_MINUTES)
    : preference.target_minutes;
  const preferredWindow = options.preferredWindow !== undefined
    ? normalizeWindow(options.preferredWindow)
    : preference.preferred_window;

  const today = new Date();
  const isToday =
    today.getFullYear() === selectedDay.getFullYear() &&
    today.getMonth() === selectedDay.getMonth() &&
    today.getDate() === selectedDay.getDate();

  const planningBaseMs = isToday
    ? Date.now()
    : new Date(selectedDay.getTime() + STUDY_START_MINUTES * 60000).getTime();
  const dayId = dayOfWeekId(selectedDay);

  const [scheduleRes, assignmentsRes] = await Promise.all([
    pool.query('SELECT id, day_id, time_start, time_end, subject FROM schedule WHERE day_id=$1 ORDER BY time_start', [dayId]),
    pool.query('SELECT id, title, description, deadline FROM assignments WHERE completed=false ORDER BY deadline NULLS LAST, id DESC LIMIT 40'),
  ]);

  const busyRanges = scheduleRes.rows.map((row) => ({
    start: parseTimeMinutes(String(row.time_start || '').slice(0, 8)),
    end: parseTimeMinutes(String(row.time_end || '').slice(0, 8)),
  }));

  if (isToday) {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const blockPastTo = clamp(currentMinutes + 15, STUDY_START_MINUTES, STUDY_END_MINUTES);
    busyRanges.push({ start: STUDY_START_MINUTES, end: blockPastTo });
  }

  const freeRanges = buildFreeRanges(busyRanges);
  const filteredRanges = applyWindowFilter(freeRanges, preferredWindow);
  const slots = buildSessionSlots(filteredRanges);
  const assignments = buildAssignmentSignals(assignmentsRes.rows, planningBaseMs);

  const sessions = [];
  const assignmentsById = new Map(assignments.map((a) => [a.id, a]));

  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const pick = pickAssignment(assignments);
    if (!pick) break;

    const session = {
      index: i + 1,
      start: toTimeLabel(slot.start),
      end: toTimeLabel(slot.end),
      minutes: slot.minutes,
      assignment_id: pick.id,
      title: pick.title,
      urgency: pick.urgency,
      reason: pick.urgencyReason,
      method: sessionMethod(i),
      deadline: pick.deadline,
    };
    sessions.push(session);

    pick.remainingNeed = Math.max(0, pick.remainingNeed - slot.minutes);
  }

  let plannedMinutes = sessions.reduce((acc, s) => acc + s.minutes, 0);

  if (plannedMinutes > targetMinutes) {
    while (sessions.length && plannedMinutes - sessions[sessions.length - 1].minutes >= targetMinutes) {
      const removed = sessions.pop();
      plannedMinutes -= removed.minutes;
    }
  }

  const criticalCount = sessions.filter((s) => s.urgency === 'critical').length;
  const warningCount = sessions.filter((s) => s.urgency === 'warning').length;
  const freeMinutes = filteredRanges.reduce((acc, r) => acc + Math.max(0, r.end - r.start), 0);

  const payload = {
    date: toDateLabel(selectedDay),
    target_minutes: targetMinutes,
    preference: {
      target_minutes: preference.target_minutes,
      preferred_window: preferredWindow,
    },
    summary: {
      free_minutes: freeMinutes,
      planned_minutes: plannedMinutes,
      sessions: sessions.length,
      critical_sessions: criticalCount,
      warning_sessions: warningCount,
      focus_load: mapFocusLoad(plannedMinutes, criticalCount),
      generated_at: new Date().toISOString(),
      note: sessions.length
        ? 'Plan generated from assignment deadlines and available class-free windows.'
        : 'No available study sessions. Try reducing class load or extend study window.',
    },
    sessions,
    assignments_ranked: assignments.map((a) => ({
      id: a.id,
      title: a.title,
      urgency: a.urgency,
      score: a.score,
      desired_minutes: a.desiredMinutes,
      remaining_need: a.remainingNeed,
      deadline: a.deadline,
      reason: a.urgencyReason,
    })),
    free_windows: filteredRanges.map((r) => ({
      start: toTimeLabel(r.start),
      end: toTimeLabel(r.end),
      minutes: r.end - r.start,
    })),
    constraints: {
      study_window: { start: toTimeLabel(STUDY_START_MINUTES), end: toTimeLabel(STUDY_END_MINUTES) },
      session_max_minutes: SESSION_MAX_MINUTES,
      session_break_minutes: SESSION_BREAK_MINUTES,
      max_sessions: MAX_SESSIONS,
      day_id: dayId,
      preferred_window: preferredWindow,
    },
  };

  if (sessions.length === 0 && assignments.length > 0 && freeMinutes > 0) {
    payload.summary.note = 'Assignments found but free windows are too short. Increase target window or reduce breaks.';
  }

  payload.assignments_ranked = payload.assignments_ranked.map((item) => {
    const current = assignmentsById.get(item.id);
    return {
      ...item,
      remaining_need: current ? current.remainingNeed : item.remaining_need,
    };
  });

  return payload;
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const u = new URL(req.url, 'http://x');
  const dateText = u.searchParams.get('date') || '';
  const targetRaw = u.searchParams.get('target_minutes');
  const windowRaw = u.searchParams.get('window');

  const payload = await generateStudyPlanSnapshot(v.user, {
    dateText,
    targetMinutes: targetRaw !== null ? Number(targetRaw) : undefined,
    preferredWindow: windowRaw !== null ? windowRaw : undefined,
  });

  sendJson(res, 200, payload, 60);
});
