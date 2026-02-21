import { get } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
  date: localDateText(),
  sessions: [],
  todaySessions: [],
  tomorrowSessions: [],
  nearestSessions: [],
  scheduleRows: [],
  sessionsByDate: {},
  subjectColorMap: {},
  activeSessionId: null,
  enforce: false,
  realtimeTimer: null,
};

const els = {
  dateInput: document.getElementById('notes-date'),
  nearestList: document.getElementById('notes-nearest-list'),
  daySubhead: document.getElementById('notes-day-subhead'),
  sessionList: document.getElementById('notes-session-list'),
  pageSub: document.getElementById('notes-page-sub'),
  gateCard: document.getElementById('notes-gate-card'),
  gateText: document.getElementById('notes-gate-text'),
  gateOpen: document.getElementById('notes-gate-open'),
};

const NOTES_REALTIME_POLL_MS = 30000;

function localDateText() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(dateText, days = 0) {
  const d = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return localDateText();
  d.setDate(d.getDate() + Number(days || 0));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateTextFromDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return localDateText();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function qs() {
  return new URLSearchParams(window.location.search);
}

function parseHmToMinutes(hm = '') {
  const m = String(hm || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function currentMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function toScheduleDayId(date = new Date()) {
  const js = date.getDay();
  return js === 0 ? 7 : js;
}

function isToday(dateText = '') {
  return String(dateText || '').slice(0, 10) === localDateText();
}

function isSessionStarted(session, dateText) {
  if (!session) return false;
  if (!isToday(dateText)) return true;
  const startMin = parseHmToMinutes(session.time_start);
  if (!Number.isFinite(startMin)) return true;
  return startMin <= currentMinutes();
}

function sessionKey(session) {
  if (!session) return '';
  const sid = Number(session.schedule_id || 0);
  const dt = String(session.class_date || '').slice(0, 10);
  return `${sid}:${dt}`;
}

function dedupeSessions(sessions = []) {
  const seen = new Set();
  return (Array.isArray(sessions) ? sessions : []).filter((s) => {
    const key = sessionKey(s);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseStartDate(session) {
  if (!session) return null;
  const dateText = String(session.class_date || '').slice(0, 10);
  const hm = String(session.time_start || '').slice(0, 5);
  const m = hm.match(/^(\d{2}):(\d{2})$/);
  if (!dateText || !m) return null;
  const d = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

function parseEndDate(session) {
  if (!session) return null;
  const dateText = String(session.class_date || '').slice(0, 10);
  const hm = String(session.time_end || '').slice(0, 5);
  const m = hm.match(/^(\d{2}):(\d{2})$/);
  if (!dateText || !m) return null;
  const d = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d;
}

function formatDateLabel(dateText = '') {
  const d = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateText || '').slice(0, 10);
  return d.toLocaleDateString('id-ID', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function dateBadgeLabel(sessionDate = '', todayDate = localDateText(), tomorrowDate = addDays(localDateText(), 1)) {
  const dt = String(sessionDate || '').slice(0, 10);
  if (dt === todayDate) return 'Hari Ini';
  if (dt === tomorrowDate) return 'Besok';
  return formatDateLabel(dt);
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function getSubjectColor(subject = '') {
  const key = String(subject || 'kelas').trim().toLowerCase();
  if (state.subjectColorMap[key]) return state.subjectColorMap[key];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  const color = {
    solid: `hsl(${hue}, 72%, 62%)`,
    soft: `hsla(${hue}, 72%, 62%, 0.16)`,
  };
  state.subjectColorMap[key] = color;
  return color;
}

function allKnownSessions() {
  const fromCache = Object.values(state.sessionsByDate || {})
    .flatMap((rows) => (Array.isArray(rows) ? rows : []));
  return dedupeSessions([...fromCache, ...(state.sessions || [])]);
}

function findSession(scheduleId, classDate = '') {
  const sid = Number(scheduleId || 0);
  const dt = String(classDate || '').slice(0, 10);
  if (!sid) return null;
  const rows = allKnownSessions();
  if (dt) {
    const exact = rows.find((s) => Number(s.schedule_id) === sid && String(s.class_date || '').slice(0, 10) === dt);
    if (exact) return exact;
  }
  return rows.find((s) => Number(s.schedule_id) === sid) || null;
}

function buildNearestSessions(todaySessions = [], tomorrowSessions = [], now = new Date()) {
  const todayDate = localDateText();
  const tomorrowDate = addDays(todayDate, 1);
  const nowMs = now.getTime();
  const mixed = dedupeSessions([...todaySessions, ...tomorrowSessions]).map((session) => {
    const start = parseStartDate(session);
    const end = parseEndDate(session);
    const date = String(session.class_date || '').slice(0, 10);
    let bucket = 3;
    if (date === todayDate) {
      if (end && end.getTime() >= nowMs) bucket = 0;
      else bucket = 2;
    } else if (date === tomorrowDate) {
      bucket = 1;
    }
    return {
      ...session,
      __bucket: bucket,
      __startMs: start ? start.getTime() : Number.MAX_SAFE_INTEGER,
      __distance: start ? Math.abs(start.getTime() - nowMs) : Number.MAX_SAFE_INTEGER,
    };
  });

  mixed.sort((a, b) => {
    if (a.__bucket !== b.__bucket) return a.__bucket - b.__bucket;
    if (a.__bucket === 2) return b.__startMs - a.__startMs;
    if (a.__distance !== b.__distance) return a.__distance - b.__distance;
    return a.__startMs - b.__startMs;
  });

  return mixed.slice(0, 8).map(({ __bucket, __startMs, __distance, ...rest }) => rest);
}

function nextOccurrenceForScheduleRow(row, now = new Date()) {
  const dayId = Number(row?.day_id || 0);
  const start = String(row?.time_start || '').slice(0, 5);
  const end = String(row?.time_end || '').slice(0, 5);
  const startMin = parseHmToMinutes(start);
  const endMin = parseHmToMinutes(end);
  if (!dayId || !Number.isFinite(startMin)) return null;

  const currentDayId = toScheduleDayId(now);
  let deltaDays = (dayId - currentDayId + 7) % 7;
  const base = new Date(now);
  base.setSeconds(0, 0);
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + deltaDays);
  base.setMinutes(startMin, 0, 0);
  if (base.getTime() < now.getTime()) {
    base.setDate(base.getDate() + 7);
    deltaDays += 7;
  }

  const endDate = new Date(base);
  if (Number.isFinite(endMin)) endDate.setMinutes(endMin, 0, 0);
  else endDate.setMinutes(startMin + 90, 0, 0);

  return {
    schedule_id: Number(row?.id || 0),
    day_id: dayId,
    subject: String(row?.subject || '').trim(),
    room: String(row?.room || '').trim(),
    lecturer: String(row?.lecturer || '').trim(),
    time_start: start,
    time_end: end,
    class_date: dateTextFromDate(base),
    __nextStartMs: base.getTime(),
    __nextEndMs: endDate.getTime(),
    __deltaDays: deltaDays,
  };
}

function buildAllSubjectsSortedByNearest(scheduleRows = [], now = new Date()) {
  const rows = Array.isArray(scheduleRows) ? scheduleRows : [];
  const bySubject = new Map();
  rows.forEach((row) => {
    const subject = String(row?.subject || '').trim();
    if (!subject) return;
    const nearest = nextOccurrenceForScheduleRow(row, now);
    if (!nearest) return;
    const key = subject.toLowerCase();
    const prev = bySubject.get(key);
    if (!prev || nearest.__nextStartMs < prev.__nextStartMs) {
      bySubject.set(key, nearest);
    }
  });

  return [...bySubject.values()]
    .sort((a, b) => {
      if (a.__nextStartMs !== b.__nextStartMs) return a.__nextStartMs - b.__nextStartMs;
      return String(a.subject || '').localeCompare(String(b.subject || ''), 'id');
    })
    .map(({ __nextStartMs, __nextEndMs, __deltaDays, ...rest }) => rest);
}

async function fetchScheduleRows() {
  const payload = await get('/schedule');
  return Array.isArray(payload) ? payload : [];
}

function sessionStatusMap() {
  const map = new Map();
  allKnownSessions().forEach((s) => {
    map.set(sessionKey(s), Boolean(s?.is_minimum_completed));
  });
  return map;
}

async function ensureDatesLoaded(dateList = []) {
  const uniqueDates = [...new Set((Array.isArray(dateList) ? dateList : []).map((x) => String(x || '').slice(0, 10)).filter(Boolean))];
  if (!uniqueDates.length) return;
  const missing = uniqueDates.filter((dt) => !Array.isArray(state.sessionsByDate?.[dt]));
  if (!missing.length) return;
  await Promise.all(missing.map((dt) => fetchSessionsByDate(dt)));
}

function openEditor(session, options = {}) {
  const scheduleId = Number(session?.schedule_id || 0);
  if (!scheduleId) return;
  const dateText = String(session?.class_date || state.date || localDateText()).slice(0, 10);
  const subject = String(session?.subject || '').trim();
  const q = new URLSearchParams();
  q.set('schedule_id', String(scheduleId));
  q.set('date', dateText);
  if (subject) q.set('subject', subject);
  if (options.enforce) q.set('enforce', '1');
  if (options.autoOpen) q.set('auto_open', '1');
  const target = `/class-notes-editor?${q.toString()}`;
  window.location.href = target;
}

function renderNearestSubjectList() {
  if (!els.nearestList) return;
  if (!state.nearestSessions.length) {
    els.nearestList.innerHTML = '<div class="notes-empty">Belum ada mata kuliah di jadwal.</div>';
    return;
  }
  const todayDate = localDateText();
  const tomorrowDate = addDays(todayDate, 1);
  els.nearestList.innerHTML = state.nearestSessions.map((s) => {
    const active = Number(s.schedule_id || 0) === Number(state.activeSessionId || 0);
    const color = getSubjectColor(s.subject || 'kelas');
    const statusClass = s.is_minimum_completed ? 'done' : 'pending';
    const statusLabel = s.is_minimum_completed ? 'Sudah tercatat' : 'Perlu catat';
    const dateLabel = dateBadgeLabel(s.class_date, todayDate, tomorrowDate);
    return `
      <article class="notes-nearest-item ${active ? 'active' : ''}" data-session-id="${Number(s.schedule_id)}" data-class-date="${escapeHtml(String(s.class_date || '').slice(0, 10))}" style="--subject-accent:${color.solid};--subject-soft:${color.soft}">
        <div class="notes-nearest-top">
          <h3 class="notes-nearest-subject">${escapeHtml(s.subject || 'Mata kuliah')}</h3>
          <span class="notes-nearest-chip date">${escapeHtml(dateLabel)}</span>
        </div>
        <div class="notes-nearest-meta">
          <span><i class="fa-regular fa-clock"></i> ${escapeHtml(String(s.time_start || '').slice(0, 5))} - ${escapeHtml(String(s.time_end || '').slice(0, 5))}</span>
          <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.room || '-')}</span>
          <span><i class="fa-solid fa-user-graduate"></i> ${escapeHtml(s.lecturer || '-')}</span>
        </div>
        <div class="notes-nearest-meta">
          <span class="notes-nearest-chip ${statusClass}">${statusLabel}</span>
        </div>
        <span class="notes-open"><i class="fa-solid fa-arrow-up-right-from-square"></i> Buka editor</span>
      </article>
    `;
  }).join('');
}

function renderSessions() {
  if (!els.sessionList) return;
  const dateText = String(state.date || '').slice(0, 10);
  if (els.daySubhead) {
    els.daySubhead.innerHTML = `<i class="fa-regular fa-calendar"></i> Sesi ${escapeHtml(formatDateLabel(dateText))}`;
  }
  if (!state.sessions.length) {
    els.sessionList.innerHTML = '<div class="notes-empty">Tidak ada sesi di tanggal ini.</div>';
    return;
  }

  els.sessionList.innerHTML = state.sessions.map((s) => {
    const sid = Number(s.schedule_id || 0);
    const active = sid === Number(state.activeSessionId || 0);
    const color = getSubjectColor(s.subject || 'kelas');
    const statusClass = s.is_minimum_completed ? 'done' : 'pending';
    const statusLabel = s.is_minimum_completed ? 'Sudah tercatat' : 'Perlu catat';
    return `
      <article class="notes-session ${active ? 'active' : ''}" data-session-id="${sid}" data-class-date="${escapeHtml(String(s.class_date || dateText).slice(0, 10))}" style="--subject-accent:${color.solid};--subject-soft:${color.soft}">
        <div class="notes-session-row">
          <h3 class="notes-session-title">${escapeHtml(s.subject || 'Mata kuliah')}</h3>
          <span class="notes-chip ${statusClass}">${statusLabel}</span>
        </div>
        <p class="notes-session-meta">
          <i class="fa-regular fa-clock"></i> ${escapeHtml(String(s.time_start || '').slice(0, 5))} - ${escapeHtml(String(s.time_end || '').slice(0, 5))}
          &nbsp; <i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.room || '-')}
          &nbsp; <i class="fa-solid fa-user-graduate"></i> ${escapeHtml(s.lecturer || '-')}
        </p>
        <span class="notes-open"><i class="fa-solid fa-arrow-up-right-from-square"></i> Buka editor</span>
      </article>
    `;
  }).join('');
}

function getPendingStartedSessions() {
  const rows = allKnownSessions();
  return rows
    .filter((s) => !s.is_minimum_completed && isSessionStarted(s, s.class_date || state.date))
    .sort((a, b) => {
      const aStart = parseHmToMinutes(a.time_start) || 0;
      const bStart = parseHmToMinutes(b.time_start) || 0;
      return aStart - bStart;
    });
}

function renderGate() {
  if (!els.gateCard || !els.gateText) return;
  if (!state.enforce) {
    els.gateCard.classList.remove('show');
    return;
  }

  const pending = getPendingStartedSessions();
  if (!pending.length) {
    els.gateCard.classList.remove('show');
    return;
  }

  const top = pending[0];
  els.gateCard.classList.add('show');
  els.gateText.textContent = `Sesi "${top.subject || 'Kelas'}" (${String(top.time_start || '').slice(0, 5)}-${String(top.time_end || '').slice(0, 5)}) belum punya catatan minimum.`;

  if (els.gateOpen) {
    els.gateOpen.onclick = () => openEditor(top, { enforce: true, autoOpen: true });
  }
}

async function fetchSessionsByDate(dateText) {
  const dt = String(dateText || '').slice(0, 10) || localDateText();
  if (Array.isArray(state.sessionsByDate?.[dt])) return state.sessionsByDate[dt];
  const payload = await get(`/class_notes/session?date=${encodeURIComponent(dateText)}`);
  const safeDate = String(payload?.date || dt || '').slice(0, 10);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  const normalized = sessions.map((s) => ({ ...s, class_date: safeDate }));
  state.sessionsByDate[safeDate] = normalized;
  return normalized;
}

function selectPreferredSession() {
  const q = qs();
  const qId = Number(q.get('schedule_id') || 0);
  const qDate = String(q.get('date') || '').slice(0, 10);
  const queryPreferred = qId > 0 ? findSession(qId, qDate) : null;
  const selectedDatePreferred = state.sessions.find((x) => !x.is_minimum_completed) || state.sessions[0] || null;
  const nearestPreferred = state.nearestSessions[0] || null;
  const chosen = queryPreferred || selectedDatePreferred || nearestPreferred;
  state.activeSessionId = chosen ? Number(chosen.schedule_id || 0) : null;
  return chosen;
}

async function loadSessions() {
  const selectedDate = String(state.date || localDateText()).slice(0, 10);
  const todayDate = localDateText();
  const tomorrowDate = addDays(todayDate, 1);

  const [todaySessions, tomorrowSessions, scheduleRows] = await Promise.all([
    fetchSessionsByDate(todayDate),
    fetchSessionsByDate(tomorrowDate),
    fetchScheduleRows(),
  ]);

  state.todaySessions = todaySessions;
  state.tomorrowSessions = tomorrowSessions;
  state.scheduleRows = scheduleRows;
  state.nearestSessions = buildAllSubjectsSortedByNearest(scheduleRows, new Date());

  const nearestDates = state.nearestSessions.map((s) => String(s.class_date || '').slice(0, 10)).filter(Boolean);
  await ensureDatesLoaded(nearestDates);
  const statusIdx = sessionStatusMap();
  state.nearestSessions = state.nearestSessions.map((s) => ({
    ...s,
    is_minimum_completed: Boolean(statusIdx.get(sessionKey(s))),
  }));

  if (selectedDate === todayDate) {
    state.sessions = [...todaySessions];
  } else if (selectedDate === tomorrowDate) {
    state.sessions = [...tomorrowSessions];
  } else {
    state.sessions = await fetchSessionsByDate(selectedDate);
  }

  selectPreferredSession();
  renderNearestSubjectList();
  renderSessions();
  renderGate();
}

function bindSessionClicks() {
  const onClick = (ev) => {
    const card = ev.target.closest('[data-session-id][data-class-date]');
    if (!card) return;
    const id = Number(card.dataset.sessionId || 0);
    const dateText = String(card.dataset.classDate || '').slice(0, 10);
    const session = findSession(id, dateText);
    if (!session) return;
    openEditor(session, { enforce: state.enforce });
  };

  if (els.sessionList) {
    els.sessionList.addEventListener('click', onClick);
  }
  if (els.nearestList) {
    els.nearestList.addEventListener('click', onClick);
  }
}

function startRealtimeWatcher() {
  if (state.realtimeTimer) {
    clearInterval(state.realtimeTimer);
    state.realtimeTimer = null;
  }
  state.realtimeTimer = setInterval(async () => {
    try {
      await loadSessions();
    } catch {}
  }, NOTES_REALTIME_POLL_MS);
}

function bindEvents() {
  if (els.dateInput) {
    els.dateInput.addEventListener('change', async () => {
      state.date = els.dateInput.value || localDateText();
      await loadSessions();
    });
  }
  bindSessionClicks();
}

async function maybeRedirectFromLegacyQuery() {
  const q = qs();
  const legacyScheduleId = Number(q.get('schedule_id') || 0);
  if (!legacyScheduleId) return false;
  const legacyDate = String(q.get('date') || state.date || localDateText()).slice(0, 10);
  const session = findSession(legacyScheduleId, legacyDate);
  if (!session) return false;
  openEditor(session, {
    enforce: state.enforce,
    autoOpen: q.get('auto_open') === '1',
  });
  return true;
}

async function init() {
  initProtected();
  normalizeLinks();

  const q = qs();
  state.enforce = q.get('enforce') === '1';
  state.date = String(q.get('date') || localDateText()).slice(0, 10);

  if (els.dateInput) {
    els.dateInput.value = state.date;
  }

  bindEvents();
  await loadSessions();

  if (await maybeRedirectFromLegacyQuery()) return;

  startRealtimeWatcher();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadSessions();
  });

  window.addEventListener('beforeunload', () => {
    if (state.realtimeTimer) clearInterval(state.realtimeTimer);
  });

  if (els.pageSub) {
    els.pageSub.textContent = state.enforce
      ? 'Mode wajib aktif: pilih mapel lalu lengkapi catatan minimum di halaman editor.'
      : 'Pilih mata kuliah, lalu masuk ke halaman editor catatan.';
  }
}

init().catch((err) => {
  console.error(err);
  showToast('Gagal memuat list catatan kuliah.', 'error');
});
