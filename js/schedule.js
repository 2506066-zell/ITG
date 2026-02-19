import { initProtected, showToast } from './main.js';
import { get, post, del } from './api.js';

const daysMap = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

let scheduleData = [];
let currentView = 'grid';
let studyPlanData = null;
let studyProgressSummary = null;
let studyNotifyTimers = [];
let studyAutoReplanLock = false;
let notesGatePending = [];
let notesGatePollTimer = null;

const STUDY_TARGET_KEY = 'study_plan_target_min_v1';
const DEFAULT_STUDY_TARGET = 150;
const STUDY_DONE_KEY_PREFIX = 'study_plan_done_v1:';
const STUDY_NOTIFY_KEY_PREFIX = 'study_plan_notify_v1:';
const STUDY_REPLAN_KEY_PREFIX = 'study_plan_replan_v1:';
const STUDY_NOTIFY_PROMPT_KEY = 'study_plan_notif_prompted_v1';
const STUDY_REPLAN_COOLDOWN_MS = 30 * 60 * 1000;
const STUDY_PREP_ALERT_MINUTES = 5;
const NOTES_GATE_AUTO_OPEN_PREFIX = 'notes_gate_auto_open_v1:';
const NOTES_GATE_POLL_MS = 30000;

function notesGateMarker(dateText, scheduleId) {
  return `${NOTES_GATE_AUTO_OPEN_PREFIX}${dateText}:${Number(scheduleId || 0)}`;
}

function hasNotesGateAutoOpened(dateText, scheduleId) {
  try {
    return sessionStorage.getItem(notesGateMarker(dateText, scheduleId)) === '1';
  } catch {
    return false;
  }
}

function markNotesGateAutoOpened(dateText, scheduleId) {
  try {
    sessionStorage.setItem(notesGateMarker(dateText, scheduleId), '1');
  } catch {}
}

function maybeAutoOpenNotesGateSession(session, dateText) {
  if (!session) return;
  if (!isTodayDateText(dateText)) return;
  if (document.visibilityState !== 'visible') return;
  const scheduleId = Number(session.schedule_id || 0);
  if (!scheduleId) return;
  if (hasNotesGateAutoOpened(dateText, scheduleId)) return;
  markNotesGateAutoOpened(dateText, scheduleId);
  showToast('Kelas aktif terdeteksi. Membuka editor catatan...', 'info');
  const target = `/class-notes?enforce=1&date=${encodeURIComponent(dateText)}&schedule_id=${scheduleId}&auto_open=1`;
  setTimeout(() => {
    window.location.href = target;
  }, 420);
}

function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isTodayDateText(text = '') {
  return String(text || '').slice(0, 10) === dateKey();
}

function parseSessionMinutes(value) {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isClassStartedForGate(session, dateText) {
  if (!session) return false;
  if (!isTodayDateText(dateText)) return true;
  const start = parseSessionMinutes(String(session.time_start || '').slice(0, 5));
  if (!Number.isFinite(start)) return true;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return start <= nowMin;
}

function updateNotesGateOverlay(dateText = dateKey()) {
  const overlay = document.getElementById('notes-gate-overlay');
  const textEl = document.getElementById('notes-gate-text');
  const openEl = document.getElementById('notes-gate-open');
  if (!overlay || !textEl || !openEl) return;

  const duePending = notesGatePending.filter((s) => isClassStartedForGate(s, dateText));
  if (!duePending.length) {
    overlay.style.display = 'none';
    return;
  }

  const top = duePending[0];
  const start = String(top.time_start || '').slice(0, 5);
  const end = String(top.time_end || '').slice(0, 5);
  textEl.textContent = `Kelas "${top.subject || 'Kelas'}" (${start}-${end}) belum punya catatan minimum. Lengkapi dulu sebelum lanjut.`;
  openEl.href = `/class-notes?enforce=1&date=${encodeURIComponent(dateText)}&schedule_id=${Number(top.schedule_id || 0)}`;
  overlay.style.display = 'flex';
  maybeAutoOpenNotesGateSession(top, dateText);
}

async function refreshClassNotesGate(dateText = dateKey()) {
  try {
    const payload = await get(`/class_notes/session?date=${encodeURIComponent(dateText)}`);
    const sessions = Array.isArray(payload && payload.sessions) ? payload.sessions : [];
    notesGatePending = sessions.filter((s) => !s.is_minimum_completed);
    updateNotesGateOverlay(dateText);
  } catch {
    notesGatePending = [];
    updateNotesGateOverlay(dateText);
  }
}

function parsePlanDateTime(planDate, hhmm) {
  const dateText = (planDate || '').toString();
  const dateMatch = dateText.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;
  const mins = parseSessionMinutes(hhmm);
  if (!Number.isFinite(mins)) return null;
  const y = Number(dateMatch[1]);
  const mo = Number(dateMatch[2]) - 1;
  const d = Number(dateMatch[3]);
  const parsed = new Date(y, mo, d, Math.floor(mins / 60), mins % 60, 0, 0);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getStudyTargetMinutes() {
  const raw = localStorage.getItem(STUDY_TARGET_KEY);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clamp(n, 90, 240);
}

function setStudyTargetMinutes(value) {
  const normalized = clamp(Number(value || DEFAULT_STUDY_TARGET), 90, 240);
  localStorage.setItem(STUDY_TARGET_KEY, String(normalized));
  return normalized;
}

function getSessionKey(session) {
  const core = `${session.start || ''}-${session.end || ''}-${session.assignment_id || ''}-${session.title || ''}`;
  return core.toLowerCase().replace(/\s+/g, ' ').trim();
}

function getDoneStorageKey(planDate) {
  return `${STUDY_DONE_KEY_PREFIX}${planDate || dateKey()}`;
}

function getDoneSessionSet(planDate) {
  try {
    const raw = localStorage.getItem(getDoneStorageKey(planDate));
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map((x) => String(x)));
  } catch {
    return new Set();
  }
}

function saveDoneSessionSet(planDate, set) {
  try {
    localStorage.setItem(getDoneStorageKey(planDate), JSON.stringify(Array.from(set)));
  } catch {}
}

function clearStudyNotifyTimers() {
  studyNotifyTimers.forEach((id) => clearTimeout(id));
  studyNotifyTimers = [];
}

function markNotificationSent(marker) {
  try {
    localStorage.setItem(`${STUDY_NOTIFY_KEY_PREFIX}${marker}`, String(Date.now()));
  } catch {}
}

function isNotificationSent(marker) {
  try {
    return Boolean(localStorage.getItem(`${STUDY_NOTIFY_KEY_PREFIX}${marker}`));
  } catch {
    return false;
  }
}

async function emitStudyNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    await reg.showNotification(title, {
      body,
      icon: '/icons/192.png',
      badge: '/icons/192.png',
      tag: 'study-scheduler',
      renotify: false,
      data: { url: '/schedule' },
    });
  } catch {
    try {
      new Notification(title, { body, icon: '/icons/192.png' });
    } catch {}
  }
}

function getUrgencyClass(urgency) {
  if (urgency === 'critical') return 'critical';
  if (urgency === 'warning') return 'warning';
  return 'good';
}

function getSessionStatus(session, doneSet, planDate) {
  const key = getSessionKey(session);
  if (doneSet.has(key)) return 'done';
  const now = Date.now();
  const startAt = parsePlanDateTime(planDate, session.start);
  const endAt = parsePlanDateTime(planDate, session.end);
  if (endAt && now > endAt.getTime()) return 'missed';
  if (startAt && endAt && now >= startAt.getTime() && now <= endAt.getTime()) return 'in_progress';
  return 'upcoming';
}

function renderStudyPlanError(message) {
  const listEl = document.getElementById('study-plan-list');
  const summaryEl = document.getElementById('study-plan-summary');
  const chipEl = document.getElementById('study-load-chip');
  if (!listEl || !summaryEl || !chipEl) return;
  chipEl.textContent = 'Unavailable';
  summaryEl.textContent = message || 'Smart scheduler belum bisa dimuat.';
  listEl.innerHTML = '<div class="study-empty">Coba regenerate dalam beberapa detik.</div>';
}

function renderStudyAnalytics() {
  const analyticsEl = document.getElementById('study-plan-analytics');
  if (!analyticsEl) return;

  if (!studyProgressSummary) {
    analyticsEl.textContent = 'Analytics streak belum tersedia.';
    return;
  }

  const sessions = Number(studyProgressSummary.completed_sessions || 0);
  const minutes = Number(studyProgressSummary.completed_minutes || 0);
  const streak = Number(studyProgressSummary.streak_current_days || 0);
  const best = Number(studyProgressSummary.streak_best_days || 0);
  analyticsEl.textContent = `Hari ini ${sessions} sesi (${minutes} menit) | Streak ${streak} hari | Best ${best} hari`;
}

async function loadStudyProgress(planDate) {
  if (!planDate) {
    studyProgressSummary = null;
    renderStudyAnalytics();
    return;
  }
  try {
    const payload = await get(`/study_progress?date=${encodeURIComponent(planDate)}`);
    const keys = Array.isArray(payload && payload.completed_keys) ? payload.completed_keys.map((x) => String(x)) : [];
    saveDoneSessionSet(planDate, new Set(keys));
    studyProgressSummary = payload && payload.summary ? payload.summary : null;
    renderStudyAnalytics();
  } catch {
    studyProgressSummary = null;
    renderStudyAnalytics();
  }
}

async function syncStudySessionStatus(planDate, session, shouldComplete) {
  if (!planDate || !session) return;
  const body = {
    action: shouldComplete ? 'complete' : 'undo',
    plan_date: planDate,
    session_key: getSessionKey(session),
    assignment_id: session.assignment_id || null,
    title: session.title || '',
    minutes: Number(session.minutes) || 0,
    start: session.start || null,
    end: session.end || null,
    method: session.method || null,
    urgency: session.urgency || null,
    reason: session.reason || null,
  };
  const payload = await post('/study_progress', body);
  const keys = Array.isArray(payload && payload.completed_keys) ? payload.completed_keys.map((x) => String(x)) : [];
  saveDoneSessionSet(planDate, new Set(keys));
  studyProgressSummary = payload && payload.summary ? payload.summary : null;
  renderStudyAnalytics();
}

function renderStudyPlan() {
  const listEl = document.getElementById('study-plan-list');
  const summaryEl = document.getElementById('study-plan-summary');
  const chipEl = document.getElementById('study-load-chip');
  if (!listEl || !summaryEl || !chipEl) return;

  if (!studyPlanData || !studyPlanData.summary) {
    renderStudyPlanError('Belum ada data planner. Tekan Regenerate.');
    return;
  }

  const summary = studyPlanData.summary;
  const sessions = Array.isArray(studyPlanData.sessions) ? studyPlanData.sessions : [];
  const planDate = studyPlanData.date || dateKey();
  const doneSet = getDoneSessionSet(planDate);

  chipEl.textContent = `Load: ${String(summary.focus_load || 'light').toUpperCase()}`;
  summaryEl.textContent = `Planned ${summary.planned_minutes || 0}/${studyPlanData.target_minutes || 0} menit | ${summary.sessions || 0} sesi | ${summary.note || ''}`;

  if (!sessions.length) {
    listEl.innerHTML = '<div class="study-empty">Belum ada slot belajar hari ini. Coba target lebih kecil atau cek ulang jadwal kelas.</div>';
    return;
  }

  listEl.innerHTML = '';
  let missedCount = 0;
  let doneCount = 0;

  sessions.forEach((session) => {
    const sessionKey = getSessionKey(session);
    const status = getSessionStatus(session, doneSet, planDate);
    if (status === 'missed') missedCount += 1;
    if (status === 'done') doneCount += 1;

    const item = document.createElement('article');
    item.className = `study-session ${getUrgencyClass(session.urgency)}`;
    if (status === 'done') item.classList.add('done');

    const time = document.createElement('div');
    time.className = 'study-time';
    time.textContent = `${session.start} - ${session.end}`;

    const main = document.createElement('div');
    main.className = 'study-main';

    const title = document.createElement('div');
    title.className = 'study-title';
    title.textContent = session.title || 'Study Block';

    const sub = document.createElement('div');
    sub.className = 'study-sub';
    const minutes = Number(session.minutes) || 0;
    let reason = session.reason || 'Progress session';
    if (status === 'missed') reason = `Missed | ${reason}`;
    if (status === 'in_progress') reason = `In progress | ${reason}`;
    if (status === 'done') reason = `Done | ${reason}`;
    sub.textContent = `${minutes} menit | ${reason}`;

    const method = document.createElement('div');
    method.className = 'study-method';
    method.textContent = session.method || 'Focus';

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = `study-action-btn ${status === 'done' ? 'done' : ''}`;
    actionBtn.textContent = status === 'done' ? 'Done' : 'Mark';
    actionBtn.addEventListener('click', async () => {
      const current = getDoneSessionSet(planDate);
      const wasDone = current.has(sessionKey);
      if (wasDone) current.delete(sessionKey);
      else current.add(sessionKey);
      saveDoneSessionSet(planDate, current);
      renderStudyPlan();
      scheduleStudyNotifications();

      try {
        await syncStudySessionStatus(planDate, session, !wasDone);
        renderStudyPlan();
        scheduleStudyNotifications();
      } catch {
        const rollback = getDoneSessionSet(planDate);
        if (wasDone) rollback.add(sessionKey);
        else rollback.delete(sessionKey);
        saveDoneSessionSet(planDate, rollback);
        renderStudyPlan();
        scheduleStudyNotifications();
        showToast('Gagal sinkron status sesi', 'error');
      }
    });

    main.appendChild(title);
    main.appendChild(sub);
    item.appendChild(time);
    item.appendChild(main);
    item.appendChild(method);
    item.appendChild(actionBtn);
    listEl.appendChild(item);
  });

  if (missedCount > 0) summaryEl.textContent += ` | ${missedCount} missed`;
  if (doneCount > 0) summaryEl.textContent += ` | ${doneCount} done`;
}

function scheduleStudyNotifications() {
  clearStudyNotifyTimers();
  if (!studyPlanData || !Array.isArray(studyPlanData.sessions)) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const planDate = studyPlanData.date || dateKey();
  if (planDate !== dateKey()) return;

  const doneSet = getDoneSessionSet(planDate);
  const upcoming = studyPlanData.sessions
    .filter((s) => !doneSet.has(getSessionKey(s)))
    .map((s) => ({
      session: s,
      startAt: parsePlanDateTime(planDate, s.start),
      endAt: parsePlanDateTime(planDate, s.end),
      key: getSessionKey(s),
    }))
    .filter((x) => x.startAt && x.endAt && x.endAt.getTime() > Date.now())
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const next = upcoming[0];
  if (!next) return;

  const prepAt = new Date(next.startAt.getTime() - STUDY_PREP_ALERT_MINUTES * 60 * 1000);
  const nowMs = Date.now();
  const prepMarker = `${planDate}:${next.key}:prep`;
  const startMarker = `${planDate}:${next.key}:start`;

  if (prepAt.getTime() <= nowMs && next.startAt.getTime() > nowMs && !isNotificationSent(prepMarker)) {
    emitStudyNotification('Study reminder', `5 menit lagi mulai: ${next.session.title || 'Study session'}`);
    markNotificationSent(prepMarker);
  }

  if (next.startAt.getTime() <= nowMs && next.endAt.getTime() > nowMs && !isNotificationSent(startMarker)) {
    emitStudyNotification('Mulai sesi belajar', `${next.session.title || 'Study session'} sedang berjalan sekarang.`);
    markNotificationSent(startMarker);
  }

  const prepDelay = prepAt.getTime() - nowMs;
  if (prepDelay > 0) {
    const prepTimer = setTimeout(async () => {
      const latestDone = getDoneSessionSet(planDate);
      if (latestDone.has(next.key) || isNotificationSent(prepMarker)) return;
      await emitStudyNotification('Study reminder', `5 menit lagi mulai: ${next.session.title || 'Study session'}`);
      markNotificationSent(prepMarker);
    }, prepDelay);
    studyNotifyTimers.push(prepTimer);
  }

  const startDelay = next.startAt.getTime() - nowMs;
  if (startDelay > 0) {
    const startTimer = setTimeout(async () => {
      const latestDone = getDoneSessionSet(planDate);
      if (latestDone.has(next.key) || isNotificationSent(startMarker)) return;
      await emitStudyNotification('Mulai sesi belajar', `${next.session.title || 'Study session'} dimulai sekarang.`);
      markNotificationSent(startMarker);
    }, startDelay);
    studyNotifyTimers.push(startTimer);
  }
}

async function maybePromptStudyNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return;
  if (localStorage.getItem(STUDY_NOTIFY_PROMPT_KEY)) return;
  localStorage.setItem(STUDY_NOTIFY_PROMPT_KEY, '1');
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') {
      showToast('Notifikasi sesi belajar aktif', 'success');
      scheduleStudyNotifications();
    }
  } catch {}
}

async function maybeAutoReplanMissedSessions() {
  if (studyAutoReplanLock) return false;
  if (!studyPlanData || !Array.isArray(studyPlanData.sessions) || !studyPlanData.sessions.length) return false;

  const planDate = studyPlanData.date || dateKey();
  if (planDate !== dateKey()) return false;

  const doneSet = getDoneSessionSet(planDate);
  const now = Date.now();
  let missedMinutes = 0;
  let missedCount = 0;

  studyPlanData.sessions.forEach((session) => {
    const key = getSessionKey(session);
    if (doneSet.has(key)) return;
    const endAt = parsePlanDateTime(planDate, session.end);
    if (endAt && endAt.getTime() < now) {
      missedMinutes += Number(session.minutes) || 0;
      missedCount += 1;
    }
  });

  if (missedCount === 0) return false;

  const stampKey = `${STUDY_REPLAN_KEY_PREFIX}${planDate}`;
  const lastStamp = Number(localStorage.getItem(stampKey) || 0);
  if (now - lastStamp < STUDY_REPLAN_COOLDOWN_MS) return false;

  const currentTarget = getStudyTargetMinutes();
  const effectiveCurrent = currentTarget === null ? (Number(studyPlanData?.target_minutes) || DEFAULT_STUDY_TARGET) : currentTarget;
  const bumpedTarget = clamp(effectiveCurrent + Math.min(60, Math.max(20, Math.round(missedMinutes * 0.5))), 90, 240);
  if (bumpedTarget === effectiveCurrent) return false;

  localStorage.setItem(stampKey, String(now));
  studyAutoReplanLock = true;
  try {
    const select = document.getElementById('study-target-select');
    setStudyTargetMinutes(bumpedTarget);
    if (select) select.value = String(bumpedTarget);
    await loadSchedule({ fromAutoReplan: true, targetOverride: bumpedTarget });
    showToast(`Auto re-plan aktif (${missedCount} sesi terlewat)`, 'info');
    return true;
  } finally {
    studyAutoReplanLock = false;
  }
}

async function loadSchedule(options = {}) {
  const { fromAutoReplan = false, targetOverride = null } = options;
  const container = document.getElementById('schedule-container');
  const orbContainer = document.getElementById('orbital-view');
  const adviceBox = document.getElementById('assistant-box');

  if (currentView === 'grid') {
    container.style.display = 'grid';
    orbContainer.classList.remove('active');
    adviceBox.style.display = 'none';
  } else {
    container.style.display = 'none';
    orbContainer.classList.add('active');
    adviceBox.style.display = 'flex';
  }

  container.innerHTML = '<div class="skeleton" style="height:200px;grid-column:1/-1"></div>';
  renderStudyPlanError('Menghitung jadwal belajar pintar...');
  const analyticsEl = document.getElementById('study-plan-analytics');
  if (analyticsEl) analyticsEl.textContent = 'Menganalisis streak belajar...';

  try {
    const target = targetOverride !== null ? setStudyTargetMinutes(targetOverride) : getStudyTargetMinutes();
    const select = document.getElementById('study-target-select');
    if (select && target !== null && String(select.value) !== String(target)) {
      select.value = String(target);
    }

    const planPath = target === null ? '/study_plan' : `/study_plan?target_minutes=${target}`;

    const [scheduleRes, planRes] = await Promise.allSettled([
      get('/schedule'),
      get(planPath),
    ]);

    if (scheduleRes.status === 'fulfilled' && Array.isArray(scheduleRes.value)) {
      scheduleData = scheduleRes.value;
    } else {
      throw new Error('Failed to load schedule');
    }

    if (planRes.status === 'fulfilled') {
      studyPlanData = planRes.value;
      if (select && studyPlanData && Number.isFinite(Number(studyPlanData.target_minutes))) {
        select.value = String(Number(studyPlanData.target_minutes));
      }
      await loadStudyProgress(studyPlanData.date || dateKey());
      renderStudyPlan();
      if (!fromAutoReplan) {
        const replanned = await maybeAutoReplanMissedSessions();
        if (replanned) return;
      }
      scheduleStudyNotifications();
    } else {
      studyProgressSummary = null;
      renderStudyAnalytics();
      renderStudyPlanError('Gagal memuat Smart Study Scheduler.');
    }

    renderGridView();
    renderOrbitalView();
    updateAssistantAdvice();
    await refreshClassNotesGate(dateKey());
  } catch {
    studyProgressSummary = null;
    renderStudyAnalytics();
    container.innerHTML = '<div class="muted center">Failed to load schedule.</div>';
    notesGatePending = [];
    updateNotesGateOverlay(dateKey());
  }
}

function renderGridView() {
  const container = document.getElementById('schedule-container');
  container.innerHTML = '';
  const today = new Date().getDay() || 7;
  const grouped = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };

  scheduleData.forEach((item) => {
    if (grouped[item.day_id]) grouped[item.day_id].push(item);
  });

  for (let d = 1; d <= 6; d += 1) {
    if (!grouped[d].length && d > 5 && d !== today) continue;
    const card = document.createElement('div');
    card.className = 'day-card';
    if (d === today) card.style.border = '1px solid var(--accent)';

    const header = document.createElement('div');
    header.className = 'day-header';
    header.innerHTML = `<span>${daysMap[d]}</span> ${d === today ? '<span class="today-badge">TODAY</span>' : ''}`;
    card.appendChild(header);

    if (!grouped[d].length) {
      const empty = document.createElement('div');
      empty.className = 'muted small center';
      empty.textContent = 'Belum ada kelas.';
      card.appendChild(empty);
    } else {
      grouped[d].sort((a, b) => a.time_start.localeCompare(b.time_start));
      grouped[d].forEach((c) => {
        const item = document.createElement('div');
        item.className = 'class-item';
        const start = c.time_start.slice(0, 5);
        const end = c.time_end.slice(0, 5);

        const delBtn = document.createElement('button');
        delBtn.className = 'class-del-btn';
        delBtn.innerHTML = '<i class="fa-solid fa-times"></i>';
        delBtn.addEventListener('click', (ev) => ev.stopPropagation());
        delBtn.onclick = async () => {
          if (confirm(`Hapus kelas "${c.subject}"?`)) {
            await del(`/schedule?id=${c.id}`);
            await loadSchedule();
            showToast('Kelas dihapus');
          }
        };

        item.innerHTML = `
          <div class="class-time"><i class="fa-regular fa-clock"></i> ${start} - ${end}</div>
          <div class="class-subject">${c.subject}</div>
          <div class="class-room"><i class="fa-solid fa-location-dot"></i> ${c.room || 'TBA'}</div>
          ${c.lecturer ? `<div class="class-lecturer"><i class="fa-solid fa-user-tie"></i> ${c.lecturer}</div>` : ''}
        `;
        item.addEventListener('click', () => {
          window.location.href = `/class-notes?schedule_id=${Number(c.id)}&date=${encodeURIComponent(dateKey())}`;
        });
        item.appendChild(delBtn);
        card.appendChild(item);
      });
    }
    container.appendChild(card);
  }
}

function renderOrbitalView() {
  const staticLayer = document.getElementById('orbit-static-layer');
  const segmentLayer = document.getElementById('orbit-segments-layer');
  if (!staticLayer || !segmentLayer) return;

  staticLayer.innerHTML = '';
  segmentLayer.innerHTML = '';

  const CX = 250;
  const CY = 250;
  const R = 180;
  const today = new Date().getDay() || 7;
  const todayClasses = scheduleData.filter((c) => c.day_id === today);

  for (let i = 0; i < 24; i += 1) {
    const angle = (i * 15 - 90) * (Math.PI / 180);
    const x1 = CX + (R - 10) * Math.cos(angle);
    const y1 = CY + (R - 10) * Math.sin(angle);
    const x2 = CX + (R + 10) * Math.cos(angle);
    const y2 = CY + (R + 10) * Math.sin(angle);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    line.setAttribute('class', `orbit-hour-line ${i % 6 === 0 ? 'major' : ''}`);
    staticLayer.appendChild(line);

    if (i % 3 === 0) {
      const tx = CX + (R + 30) * Math.cos(angle);
      const ty = CY + (R + 30) * Math.sin(angle);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', tx);
      text.setAttribute('y', ty);
      text.setAttribute('fill', 'hsla(0,0%,100%,0.3)');
      text.setAttribute('font-size', '10');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.textContent = i;
      staticLayer.appendChild(text);
    }
  }

  todayClasses.forEach((c) => {
    const startHour = parseInt(c.time_start.split(':')[0], 10) + parseInt(c.time_start.split(':')[1], 10) / 60;
    const endHour = parseInt(c.time_end.split(':')[0], 10) + parseInt(c.time_end.split(':')[1], 10) / 60;

    const startAngle = startHour * 15 - 90;
    const endAngle = endHour * 15 - 90;

    const path = describeArc(CX, CY, R, startAngle, endAngle);
    const segment = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    segment.setAttribute('d', path);
    segment.setAttribute('class', 'schedule-segment');

    const isResonant = todayClasses.some((other) => {
      if (other.id === c.id) return false;
      const os = parseInt(other.time_start.split(':')[0], 10) + parseInt(other.time_start.split(':')[1], 10) / 60;
      return os >= startHour && os < endHour;
    });
    if (isResonant) segment.classList.add('resonance-high');

    segment.onclick = () => showToast(`Class: ${c.subject} (${c.time_start.slice(0, 5)})`, 'info');
    segmentLayer.appendChild(segment);
  });

  updateTimeHand(CX, CY, R);
}

function updateTimeHand(cx, cy, r) {
  const now = new Date();
  const hours = now.getHours() + now.getMinutes() / 60;
  const angle = (hours * 15 - 90) * (Math.PI / 180);
  const x2 = cx + (r + 40) * Math.cos(angle);
  const y2 = cy + (r + 40) * Math.sin(angle);

  const hand = document.getElementById('time-hand');
  if (hand) {
    hand.setAttribute('x2', x2);
    hand.setAttribute('y2', y2);
  }
}

function updateAssistantAdvice() {
  const textEl = document.getElementById('advice-text');
  if (!textEl) return;

  const today = new Date().getDay() || 7;
  const todayClasses = scheduleData.filter((c) => c.day_id === today);

  if (todayClasses.length === 0) {
    textEl.textContent = 'Orbit kosong hari ini. Cocok untuk deep work dan sesi belajar fokus.';
    return;
  }

  let resonantCount = 0;
  todayClasses.forEach((c) => {
    const sh = parseInt(c.time_start.split(':')[0], 10);
    const overlap = todayClasses.find((o) => o.id !== c.id && parseInt(o.time_start.split(':')[0], 10) === sh);
    if (overlap) resonantCount += 1;
  });

  if (resonantCount > 0) {
    textEl.innerHTML = 'Ada <strong>resonansi tinggi</strong> di jadwal. Siapkan transisi cepat antar kelas.';
  } else if (todayClasses.length > 4) {
    textEl.textContent = 'Hari padat. Fokus satu prioritas pada tiap blok waktu agar tetap stabil.';
  } else {
    textEl.textContent = 'Jadwal stabil. Gunakan slot kosong untuk mencicil tugas prioritas tinggi.';
  }
}

function polarToCartesian(centerX, centerY, radius, angleInDegrees) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

function describeArc(x, y, radius, startAngle, endAngle) {
  const start = polarToCartesian(x, y, radius, endAngle);
  const end = polarToCartesian(x, y, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return [
    'M', start.x, start.y,
    'A', radius, radius, 0, largeArcFlag, 0, end.x, end.y,
    'L', x, y,
    'Z',
  ].join(' ');
}

function initViewToggle() {
  document.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.toggle-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      loadSchedule();
    };
  });
}

function initStudyPlanControls() {
  const select = document.getElementById('study-target-select');
  const refreshBtn = document.getElementById('study-refresh-btn');

  if (select) {
    const localTarget = getStudyTargetMinutes();
    if (localTarget !== null) select.value = String(localTarget);
    select.addEventListener('change', () => {
      setStudyTargetMinutes(select.value);
      loadSchedule();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      try {
        await loadSchedule();
        showToast('Smart study plan diperbarui', 'success');
      } catch {
        showToast('Gagal regenerate study plan', 'error');
      } finally {
        refreshBtn.disabled = false;
      }
    });
  }
}

function initModal() {
  const modal = document.getElementById('modal');
  const btn = document.getElementById('open-add');
  const close = document.getElementById('close-modal');

  if (btn) btn.onclick = () => modal.classList.add('active');
  if (close) close.onclick = () => modal.classList.remove('active');

  if (modal) {
    modal.onclick = (e) => {
      if (e.target === modal) modal.classList.remove('active');
    };
  }

  const form = document.getElementById('add-class-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await post('/schedule', {
          day: parseInt(f.get('day'), 10),
          start: f.get('start'),
          end: f.get('end'),
          subject: f.get('subject'),
          room: f.get('room'),
          lecturer: f.get('lecturer'),
        });

        e.target.reset();
        modal.classList.remove('active');
        await loadSchedule();
        showToast('Class added!', 'success');
      } catch {
        showToast('Failed to add class', 'error');
      }
    });
  }
}

function init() {
  initProtected();
  initStudyPlanControls();
  initModal();
  initViewToggle();
  maybePromptStudyNotificationPermission();
  const gateRefresh = document.getElementById('notes-gate-refresh');
  if (gateRefresh) {
    gateRefresh.addEventListener('click', async () => {
      await refreshClassNotesGate(dateKey());
      if (notesGatePending.length > 0) {
        showToast('Masih ada kelas aktif yang belum dicatat.', 'error');
      } else {
        showToast('Catatan sesi sudah lengkap.', 'success');
      }
    });
  }
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await refreshClassNotesGate(dateKey());
    }
  });
  if (notesGatePollTimer) {
    clearInterval(notesGatePollTimer);
    notesGatePollTimer = null;
  }
  notesGatePollTimer = setInterval(() => {
    refreshClassNotesGate(dateKey()).catch(() => {});
  }, NOTES_GATE_POLL_MS);
  window.addEventListener('beforeunload', () => {
    if (notesGatePollTimer) clearInterval(notesGatePollTimer);
  });
  loadSchedule();
}

document.addEventListener('DOMContentLoaded', init);
