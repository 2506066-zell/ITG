import { get, post } from './api.js';
import { initProtected, normalizeLinks, showToast } from './main.js';

const state = {
  date: localDateText(),
  sessions: [],
  todaySessions: [],
  tomorrowSessions: [],
  nearestSessions: [],
  activeSessionId: null,
  activeSessionKey: '',
  subjectColorMap: {},
  activeSession: null,
  activeNote: null,
  enforce: false,
  realtimeTimer: null,
  typingPopupEnabled: false,
  typingPopupRafPending: false,
  typingPopupQueue: [],
  typingPopupLastTs: 0,
  typingPopupHost: null,
  typingPopupComposing: false,
};

const els = {
  dateInput: document.getElementById('notes-date'),
  nearestList: document.getElementById('notes-nearest-list'),
  daySubhead: document.getElementById('notes-day-subhead'),
  sessionList: document.getElementById('notes-session-list'),
  activeSessionCard: document.getElementById('notes-active-session'),
  activeSubject: document.getElementById('notes-active-subject'),
  activeMeta: document.getElementById('notes-active-meta'),
  activeStatus: document.getElementById('notes-active-status'),
  typingPopupLayer: document.getElementById('notes-typing-popup-layer'),
  pageSub: document.getElementById('notes-page-sub'),
  form: document.getElementById('class-note-form'),
  noteId: document.getElementById('note-id'),
  scheduleId: document.getElementById('note-schedule-id'),
  classDate: document.getElementById('note-class-date'),
  keyPoints: document.getElementById('note-key-points'),
  actionItems: document.getElementById('note-action-items'),
  questions: document.getElementById('note-questions'),
  freeText: document.getElementById('note-free-text'),
  moodFocus: document.getElementById('note-mood-focus'),
  confidence: document.getElementById('note-confidence'),
  minimumChip: document.getElementById('notes-minimum-chip'),
  aiSummary: document.getElementById('notes-ai-summary'),
  aiNext: document.getElementById('notes-ai-next'),
  aiRisk: document.getElementById('notes-ai-risk'),
  history: document.getElementById('notes-history-list'),
  chatCta: document.getElementById('notes-chat-cta'),
  gate: document.getElementById('notes-hardgate'),
  gateSub: document.getElementById('notes-hardgate-sub'),
  gateFocus: document.getElementById('notes-hardgate-focus'),
  exportMd: document.getElementById('notes-export-md'),
  exportPdf: document.getElementById('notes-export-pdf'),
};

const NOTES_REALTIME_POLL_MS = 30000;
const NOTES_AUTO_OPEN_PREFIX = 'class_notes_auto_open_v2:';
const TYPING_POPUP_FRAME_MS = 1000 / 30;
const TYPING_POPUP_QUEUE_MAX = 24;
const TYPING_POPUP_ACTIVE_MAX = 8;
const TYPING_POPUP_DURATION_MS = 280;
const TYPING_POPUP_FIELDS = [
  'note-key-points',
  'note-action-items',
  'note-questions',
  'note-free-text',
];

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

function parseHmToMinutes(hm = '') {
  const m = String(hm || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function currentMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
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

function minimumDoneFromForm() {
  return Boolean(
    String(els.keyPoints.value || '').trim() ||
    String(els.actionItems.value || '').trim() ||
    String(els.freeText.value || '').trim()
  );
}

function qs() {
  return new URLSearchParams(window.location.search);
}

function fileSafe(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'catatan';
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

function dateBadgeLabel(sessionDate = '', todayDate = localDateText(), tomorrowDate = addDays(localDateText(), 1)) {
  const dt = String(sessionDate || '').slice(0, 10);
  if (dt === todayDate) return 'Hari Ini';
  if (dt === tomorrowDate) return 'Besok';
  return formatDateLabel(dt);
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
      if (end && end.getTime() >= nowMs) bucket = 0; // in progress or upcoming today
      else bucket = 2; // already passed today
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
    if (a.__bucket === 2) return b.__startMs - a.__startMs; // nearest past first
    if (a.__distance !== b.__distance) return a.__distance - b.__distance;
    return a.__startMs - b.__startMs;
  });

  return mixed.slice(0, 8).map(({ __bucket, __startMs, __distance, ...rest }) => rest);
}

function allKnownSessions() {
  return dedupeSessions([
    ...(state.todaySessions || []),
    ...(state.tomorrowSessions || []),
    ...(state.sessions || []),
  ]);
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

function weekRange(dateText = localDateText()) {
  const base = new Date(`${String(dateText || '').slice(0, 10)}T00:00:00`);
  if (Number.isNaN(base.getTime())) {
    return { from: localDateText(), to: localDateText() };
  }
  const day = base.getDay() === 0 ? 7 : base.getDay();
  base.setDate(base.getDate() - (day - 1));
  const end = new Date(base);
  end.setDate(base.getDate() + 6);
  const fmt = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const date = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${date}`;
  };
  return { from: fmt(base), to: fmt(end) };
}

function downloadText(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function autoOpenMarker(sessionId) {
  return `${NOTES_AUTO_OPEN_PREFIX}${state.date}:${Number(sessionId || 0)}`;
}

function markAutoOpened(sessionId) {
  try {
    sessionStorage.setItem(autoOpenMarker(sessionId), '1');
  } catch {}
}

function hasAutoOpened(sessionId) {
  try {
    return sessionStorage.getItem(autoOpenMarker(sessionId)) === '1';
  } catch {
    return false;
  }
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shouldEnableDesktopTypingPopup() {
  try {
    if (!window.matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)').matches) return false;
    if (document.documentElement.classList.contains('perf-lite')) return false;
    if (document.body.classList.contains('no-anim')) return false;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    return true;
  } catch {
    return false;
  }
}

function typingPopupFields() {
  return TYPING_POPUP_FIELDS
    .map((id) => document.getElementById(id))
    .filter((el) => el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT'));
}

function normalizePopupChars(raw = '') {
  const text = String(raw || '');
  if (!text) return [];
  const items = [];
  for (const ch of text.slice(0, 12)) {
    if (ch === '\r') continue;
    if (ch === '\n') items.push('↵');
    else if (ch === '\t') items.push('⇥');
    else if (ch === ' ') items.push('·');
    else items.push(ch);
  }
  return items;
}

function popupAccentColor() {
  const fromCard = els.activeSessionCard
    ? String(getComputedStyle(els.activeSessionCard).getPropertyValue('--active-accent') || '').trim()
    : '';
  if (fromCard) return fromCard;
  return 'hsl(205 86% 65%)';
}

function estimateCaretPosition(el) {
  const value = String(el.value || '');
  const end = Number(el.selectionStart ?? value.length);
  const before = value.slice(0, Math.max(0, end));
  const lines = before.split('\n');
  const lineCount = lines.length;
  const lastLine = lines[lineCount - 1] || '';
  const style = getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight) || 20;
  const charW = 7;
  const x = 14 + Math.min(lastLine.length, 36) * charW;
  const y = 14 + Math.min(Math.max(0, lineCount - 1), 8) * lineHeight - (el.scrollTop || 0);
  return { x, y };
}

function clampPopupPoint(x, y) {
  const host = state.typingPopupHost;
  if (!host) return { x: 8, y: 8 };
  const rect = host.getBoundingClientRect();
  const clampedX = Math.max(8, Math.min(rect.width - 12, x));
  const clampedY = Math.max(8, Math.min(rect.height - 14, y));
  return { x: clampedX, y: clampedY };
}

function spawnTypingPopup(item) {
  const layer = els.typingPopupLayer;
  const host = state.typingPopupHost;
  const field = item && item.fieldId ? document.getElementById(item.fieldId) : null;
  if (!state.typingPopupEnabled || !layer || !host || !field) return;

  const hostRect = host.getBoundingClientRect();
  const fieldRect = field.getBoundingClientRect();
  const caret = estimateCaretPosition(field);
  const jitterX = (Math.random() * 8) - 4;
  const jitterY = (Math.random() * 4) - 2;
  const x = fieldRect.left - hostRect.left + caret.x + jitterX;
  const y = fieldRect.top - hostRect.top + caret.y + jitterY;
  const point = clampPopupPoint(x, y);

  while (layer.childElementCount >= TYPING_POPUP_ACTIVE_MAX) {
    layer.firstElementChild?.remove();
  }

  const node = document.createElement('span');
  node.className = 'notes-typing-popup-char';
  node.textContent = item.char;
  node.style.left = `${point.x}px`;
  node.style.top = `${point.y}px`;
  node.style.setProperty('--typing-popup-color', popupAccentColor());
  layer.appendChild(node);

  requestAnimationFrame(() => {
    node.classList.add('is-pop');
  });

  window.setTimeout(() => {
    node.remove();
  }, TYPING_POPUP_DURATION_MS + 120);
}

function runTypingPopupFrame(ts) {
  if (!state.typingPopupEnabled) {
    state.typingPopupRafPending = false;
    return;
  }
  if (state.typingPopupQueue.length <= 0) {
    state.typingPopupRafPending = false;
    return;
  }
  if ((ts - state.typingPopupLastTs) < TYPING_POPUP_FRAME_MS) {
    requestAnimationFrame(runTypingPopupFrame);
    return;
  }

  state.typingPopupLastTs = ts;
  const next = state.typingPopupQueue.shift();
  if (next) spawnTypingPopup(next);

  if (state.typingPopupQueue.length > 0) {
    requestAnimationFrame(runTypingPopupFrame);
    return;
  }
  state.typingPopupRafPending = false;
}

function scheduleTypingPopupRender() {
  if (!state.typingPopupEnabled || state.typingPopupRafPending) return;
  state.typingPopupRafPending = true;
  requestAnimationFrame(runTypingPopupFrame);
}

function enqueueTypingPopups(raw = '', field = null) {
  if (!state.typingPopupEnabled || !field || !field.id) return;
  const chars = normalizePopupChars(raw);
  if (!chars.length) return;
  for (const ch of chars) {
    state.typingPopupQueue.push({ char: ch, fieldId: field.id });
  }
  if (state.typingPopupQueue.length > TYPING_POPUP_QUEUE_MAX) {
    state.typingPopupQueue = state.typingPopupQueue.slice(-TYPING_POPUP_QUEUE_MAX);
  }
  scheduleTypingPopupRender();
}

function initTypingPopupEffects() {
  state.typingPopupHost = els.typingPopupLayer ? els.typingPopupLayer.parentElement : null;
  state.typingPopupEnabled = Boolean(els.typingPopupLayer && state.typingPopupHost && shouldEnableDesktopTypingPopup());

  document.body.classList.toggle('typing-popup-enabled', state.typingPopupEnabled);
  if (!state.typingPopupEnabled) {
    state.typingPopupQueue = [];
    state.typingPopupRafPending = false;
    if (els.typingPopupLayer) els.typingPopupLayer.innerHTML = '';
    return;
  }

  const fields = typingPopupFields();
  for (const field of fields) {
    field.addEventListener('compositionstart', () => {
      state.typingPopupComposing = true;
    });
    field.addEventListener('compositionend', (ev) => {
      state.typingPopupComposing = false;
      enqueueTypingPopups(ev && typeof ev.data === 'string' ? ev.data : '', field);
    });
    field.addEventListener('focus', () => {
      field.classList.add('typing-active');
    });
    field.addEventListener('blur', () => {
      field.classList.remove('typing-active');
    });
    field.addEventListener('input', (ev) => {
      if (state.typingPopupComposing) return;
      const inserted = ev && typeof ev.data === 'string' ? ev.data : '';
      enqueueTypingPopups(inserted, field);
    });
  }
}

function setMinimumChip(ok) {
  if (!els.minimumChip) return;
  els.minimumChip.classList.remove('pending', 'done');
  if (ok) {
    els.minimumChip.classList.add('done');
    els.minimumChip.textContent = 'Minimum lengkap';
  } else {
    els.minimumChip.classList.add('pending');
    els.minimumChip.textContent = 'Belum lengkap';
  }
}

function applyAi(note = null) {
  els.aiSummary.textContent = note?.summary_text
    ? `Ringkasan: ${note.summary_text}`
    : 'Z AI akan merangkum setelah catatan sesi disimpan.';
  els.aiNext.textContent = note?.next_action_text
    ? `Aksi berikutnya: ${note.next_action_text}`
    : 'Z AI akan memberi langkah lanjutan setelah catatan disimpan.';
  els.aiRisk.textContent = note?.risk_hint
    ? `Catatan risiko: ${note.risk_hint}`
    : 'Z AI akan menampilkan catatan risiko jika terdeteksi.';
  if (els.chatCta) {
    const prompt = note?.next_action_text
      ? `bantu eksekusi aksi catatan kuliah ini: ${note.next_action_text}`
      : 'bantu saya review catatan kuliah hari ini';
    els.chatCta.href = `/chat?ai=${encodeURIComponent(prompt)}`;
  }
}

function fillForm(note = null, session = null) {
  const noteDate = String(session?.class_date || note?.class_date || state.date || localDateText()).slice(0, 10);
  els.noteId.value = note?.id || '';
  els.scheduleId.value = String(session?.schedule_id || note?.schedule_id || '');
  els.classDate.value = noteDate;
  els.keyPoints.value = note?.key_points || '';
  els.actionItems.value = note?.action_items || '';
  els.questions.value = note?.questions || '';
  els.freeText.value = note?.free_text || '';
  els.moodFocus.value = note?.mood_focus || '';
  els.confidence.value = note?.confidence || '';
  setMinimumChip(Boolean(note?.is_minimum_completed) || minimumDoneFromForm());
  applyAi(note);
  renderActiveSessionContext(note, session || state.activeSession);
}

function renderActiveSessionContext(note = null, session = null) {
  if (!els.activeSessionCard || !els.activeSubject || !els.activeMeta || !els.activeStatus) return;

  const s = session || state.activeSession;
  if (!s) {
    els.activeSubject.textContent = 'Belum ada sesi dipilih';
    els.activeMeta.textContent = 'Kembali ke List Mapel untuk memilih sesi yang ingin dicatat.';
    els.activeStatus.classList.remove('done');
    els.activeStatus.classList.add('pending');
    els.activeStatus.textContent = 'Perlu pilih';
    els.activeSessionCard.style.removeProperty('--active-accent');
    els.activeSessionCard.style.removeProperty('--active-soft');
    return;
  }

  const color = getSubjectColor(s.subject || 'Kelas');
  const dateText = String(s.class_date || state.date || localDateText()).slice(0, 10);
  const started = String(s.time_start || '').slice(0, 5);
  const ended = String(s.time_end || '').slice(0, 5);
  const completed = Boolean(note?.is_minimum_completed ?? s.is_minimum_completed);
  const statusText = completed ? 'Sudah tercatat' : 'Perlu catat';

  els.activeSubject.textContent = s.subject || 'Mata kuliah';
  els.activeMeta.textContent = `${formatDateLabel(dateText)} | ${started}-${ended} | ${s.room || 'TBA'} | ${s.lecturer || 'Dosen belum diisi'}`;
  els.activeStatus.classList.toggle('done', completed);
  els.activeStatus.classList.toggle('pending', !completed);
  els.activeStatus.textContent = statusText;
  els.activeSessionCard.style.setProperty('--active-accent', color.solid);
  els.activeSessionCard.style.setProperty('--active-soft', color.soft);
}

function renderSessions() {
  if (!els.sessionList) return;
  const rows = Array.isArray(state.sessions) ? state.sessions : [];
  if (els.daySubhead) {
    els.daySubhead.innerHTML = `<i class="fa-regular fa-calendar"></i> Sesi ${escapeHtml(formatDateLabel(state.date))}`;
  }
  if (!rows.length) {
    els.sessionList.innerHTML = '<div class="notes-empty">Tidak ada sesi pada tanggal ini.</div>';
    return;
  }

  els.sessionList.innerHTML = rows.map((s) => {
    const active = state.activeSessionKey && state.activeSessionKey === sessionKey(s);
    const statusClass = s.is_minimum_completed ? 'complete' : 'incomplete';
    const chip = s.is_minimum_completed
      ? '<span class="notes-chip done">Sudah Tercatat</span>'
      : '<span class="notes-chip pending">Wajib Catat</span>';
    const color = getSubjectColor(s.subject || 'Kelas');
    return `
      <article class="notes-session ${statusClass} ${active ? 'active' : ''}" data-session-id="${Number(s.schedule_id)}" data-class-date="${escapeHtml(String(s.class_date || state.date).slice(0, 10))}" style="border-left:4px solid ${color.solid}">
        <div class="notes-session-row">
          <p class="notes-session-title">${escapeHtml(s.subject || 'Kelas')}</p>
          ${chip}
        </div>
        <p class="notes-session-meta">
          <i class="fa-regular fa-clock"></i> ${escapeHtml(String(s.time_start || '').slice(0, 5))} - ${escapeHtml(String(s.time_end || '').slice(0, 5))}
          &nbsp;|&nbsp; <i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.room || 'TBA')}
          ${s.lecturer ? `&nbsp;|&nbsp; <i class="fa-solid fa-user-tie"></i> ${escapeHtml(s.lecturer)}` : ''}
        </p>
      </article>
    `;
  }).join('');
}

function renderNearestSubjectList() {
  if (!els.nearestList) return;
  const rows = Array.isArray(state.nearestSessions) ? state.nearestSessions : [];
  if (!rows.length) {
    els.nearestList.innerHTML = '<div class="notes-empty">Belum ada mata kuliah terdekat untuk hari ini dan besok.</div>';
    return;
  }
  const todayDate = localDateText();
  const tomorrowDate = addDays(todayDate, 1);
  els.nearestList.innerHTML = rows.map((s) => {
    const color = getSubjectColor(s.subject || 'Kelas');
    const key = sessionKey(s);
    const active = state.activeSessionKey && state.activeSessionKey === key;
    const statusClass = s.is_minimum_completed ? 'done' : 'pending';
    const statusLabel = s.is_minimum_completed ? 'Sudah Tercatat' : 'Perlu Catat';
    const dateLabel = dateBadgeLabel(s.class_date, todayDate, tomorrowDate);
    return `
      <article class="notes-nearest-item ${active ? 'active' : ''}" data-session-id="${Number(s.schedule_id)}" data-class-date="${escapeHtml(String(s.class_date || '').slice(0, 10))}" style="--subject-accent:${color.solid};--subject-soft:${color.soft}">
        <div class="notes-nearest-top">
          <p class="notes-nearest-subject">${escapeHtml(s.subject || 'Kelas')}</p>
          <span class="notes-nearest-chip date">${escapeHtml(dateLabel)}</span>
        </div>
        <p class="notes-nearest-meta">
          <span><i class="fa-regular fa-clock"></i> ${escapeHtml(String(s.time_start || '').slice(0, 5))} - ${escapeHtml(String(s.time_end || '').slice(0, 5))}</span>
          <span><i class="fa-solid fa-location-dot"></i> ${escapeHtml(s.room || 'TBA')}</span>
          ${s.lecturer ? `<span><i class="fa-solid fa-user-tie"></i> ${escapeHtml(s.lecturer)}</span>` : ''}
        </p>
        <span class="notes-nearest-chip ${statusClass}">${statusLabel}</span>
      </article>
    `;
  }).join('');
}

function getPendingStartedSessions() {
  return (state.todaySessions || []).filter((s) => !s.is_minimum_completed && isSessionStarted(s, localDateText()));
}

async function focusSession(session, opts = {}) {
  if (!session) return;
  const silent = Boolean(opts.silent);
  await setActiveSession(session, { focusEditor: true });
  if (!silent) {
    showToast(`Sesi ${session.subject || 'kelas'} aktif. Lanjut catat sekarang.`, 'info');
  }
}

async function maybeAutoOpenStartedSession(opts = {}) {
  const force = Boolean(opts.force);
  const pending = getPendingStartedSessions();
  if (!pending.length) return;
  const top = pending[0];
  const topId = Number(top.schedule_id || 0);
  const activeId = Number(state.activeSession?.schedule_id || 0);
  if (!force && (activeId === topId || hasAutoOpened(topId))) return;
  markAutoOpened(topId);
  await focusSession(top, { silent: false });
}

async function setActiveSession(session, opts = {}) {
  if (!session) return;
  const focusEditor = opts.focusEditor !== false;
  const dateText = String(session.class_date || state.date || localDateText()).slice(0, 10);
  state.activeSession = { ...session, class_date: dateText };
  state.activeSessionId = Number(state.activeSession.schedule_id || 0) || null;
  state.activeSessionKey = sessionKey(state.activeSession);
  state.date = dateText;
  if (els.dateInput) els.dateInput.value = state.date;
  await loadActiveNote(state.activeSessionId, state.date);
  renderActiveSessionContext(state.activeNote, state.activeSession);
  renderNearestSubjectList();
  renderSessions();
  renderGate();
  if (focusEditor && els.keyPoints) {
    els.keyPoints.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.keyPoints.focus();
  }
}

function renderExportMarkdown(notes = [], from = '', to = '') {
  const lines = [
    '# Ringkasan Catatan Kuliah Mingguan',
    '',
    `Periode: ${from} s/d ${to}`,
    '',
  ];
  if (!notes.length) {
    lines.push('Belum ada catatan untuk periode ini.');
    return lines.join('\n');
  }
  notes.forEach((n) => {
    const date = String(n.class_date || '').slice(0, 10);
    const time = `${String(n.time_start || '').slice(0, 5)}-${String(n.time_end || '').slice(0, 5)}`;
    lines.push(`## ${n.subject || 'Kelas'} - ${date} (${time})`);
    lines.push(`- Ruangan: ${n.room || 'TBA'}`);
    lines.push(`- Dosen: ${n.lecturer || 'TBA'}`);
    if (n.summary_text) lines.push(`- Ringkasan Z AI: ${String(n.summary_text).trim()}`);
    if (n.next_action_text) lines.push(`- Aksi Berikutnya: ${String(n.next_action_text).trim()}`);
    if (n.risk_hint) lines.push(`- Catatan Risiko: ${String(n.risk_hint).trim()}`);
    if (n.key_points) lines.push(`- Poin Penting: ${String(n.key_points).trim()}`);
    if (n.action_items) lines.push(`- Langkah Lanjutan: ${String(n.action_items).trim()}`);
    if (n.questions) lines.push(`- Pertanyaan: ${String(n.questions).trim()}`);
    if (n.free_text) lines.push(`- Catatan Bebas: ${String(n.free_text).trim()}`);
    lines.push('');
  });
  return lines.join('\n');
}

function renderExportHtml(notes = [], from = '', to = '') {
  const rows = notes.map((n) => {
    const date = escapeHtml(String(n.class_date || '').slice(0, 10));
    const time = `${escapeHtml(String(n.time_start || '').slice(0, 5))}-${escapeHtml(String(n.time_end || '').slice(0, 5))}`;
    return `
      <article class="note">
        <h3>${escapeHtml(n.subject || 'Kelas')}</h3>
        <p class="meta">${date} | ${time} | ${escapeHtml(n.room || 'TBA')} | ${escapeHtml(n.lecturer || 'TBA')}</p>
        <p><strong>Ringkasan Z AI:</strong> ${escapeHtml(n.summary_text || '-')}</p>
        <p><strong>Aksi Berikutnya:</strong> ${escapeHtml(n.next_action_text || '-')}</p>
        <p><strong>Catatan Risiko:</strong> ${escapeHtml(n.risk_hint || '-')}</p>
      </article>
    `;
  }).join('');
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <title>Export Catatan Kuliah ${from} s/d ${to}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; margin: 20px; color: #1b1f2a; line-height: 1.4; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    .sub { margin: 0 0 18px; color: #4c5a77; font-size: 13px; }
    .note { border: 1px solid #c9d3ea; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
    .note h3 { margin: 0 0 4px; font-size: 16px; }
    .meta { margin: 0 0 8px; color: #5f6c88; font-size: 12px; }
    p { margin: 4px 0; font-size: 13px; }
    @page { margin: 12mm; }
  </style>
</head>
<body>
  <h1>Ringkasan Catatan Kuliah Mingguan</h1>
  <p class="sub">Periode ${escapeHtml(from)} s/d ${escapeHtml(to)}</p>
  ${rows || '<p>Tidak ada catatan pada periode ini.</p>'}
</body>
</html>`;
}

async function exportWeekly(format = 'md') {
  const { from, to } = weekRange(state.date);
  const rows = await get(`/class_notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const notes = Array.isArray(rows) ? rows : [];
  if (!notes.length) {
    showToast('Belum ada catatan untuk minggu ini.', 'info');
    return;
  }

  const fileLabel = fileSafe(`catatan-kuliah-${from}-sd-${to}`);
  if (format === 'pdf') {
    const html = renderExportHtml(notes, from, to);
    const win = window.open('', '_blank', 'noopener,noreferrer');
    if (!win) {
      showToast('Popup diblokir browser. Izinkan pop-up untuk export PDF.', 'error');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    setTimeout(() => {
      win.focus();
      win.print();
    }, 220);
    showToast('Mode print PDF dibuka. Pilih "Save as PDF".', 'success');
    return;
  }

  const md = renderExportMarkdown(notes, from, to);
  downloadText(`${fileLabel}.md`, md, 'text/markdown;charset=utf-8');
  showToast('Export Markdown selesai.', 'success');
}

function renderGate() {
  if (!els.gate) return;
  if (!state.enforce) {
    els.gate.classList.remove('show');
    return;
  }
  const pending = getPendingStartedSessions();
  if (!pending.length) {
    els.gate.classList.remove('show');
    return;
  }
  const first = pending[0];
  els.gateSub.textContent = `Sesi "${first.subject || 'Kelas'}" (${String(first.time_start || '').slice(0, 5)}-${String(first.time_end || '').slice(0, 5)}) belum punya catatan minimum.`;
  els.gate.classList.add('show');
}

async function fetchSessionsByDate(dateText) {
  const payload = await get(`/class_notes/session?date=${encodeURIComponent(dateText)}`);
  const dt = String(payload?.date || dateText || '').slice(0, 10);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return sessions.map((s) => ({ ...s, class_date: dt }));
}

async function loadSessions(opts = {}) {
  const preserveActive = opts.preserveActive !== false;
  const preferSelectedDate = Boolean(opts.preferSelectedDate);

  const selectedDate = String(state.date || localDateText()).slice(0, 10);
  const todayDate = localDateText();
  const tomorrowDate = addDays(todayDate, 1);

  const [todaySessions, tomorrowSessions] = await Promise.all([
    fetchSessionsByDate(todayDate),
    fetchSessionsByDate(tomorrowDate),
  ]);
  state.todaySessions = todaySessions;
  state.tomorrowSessions = tomorrowSessions;
  state.nearestSessions = buildNearestSessions(todaySessions, tomorrowSessions, new Date());

  if (selectedDate === todayDate) {
    state.sessions = [...todaySessions];
  } else if (selectedDate === tomorrowDate) {
    state.sessions = [...tomorrowSessions];
  } else {
    state.sessions = await fetchSessionsByDate(selectedDate);
  }

  const q = qs();
  const queryScheduleId = Number(q.get('schedule_id') || 0);
  const queryDate = String(q.get('date') || '').slice(0, 10);
  const currentActive = preserveActive && state.activeSession ? findSession(state.activeSession.schedule_id, state.activeSession.class_date || state.date) : null;
  const queryPreferred = queryScheduleId > 0 ? findSession(queryScheduleId, queryDate) : null;
  const nearestPreferred = state.nearestSessions[0] || null;
  const selectedDatePreferred = state.sessions.find((x) => !x.is_minimum_completed) || state.sessions[0] || null;
  const chosen = preferSelectedDate
    ? (selectedDatePreferred || currentActive || queryPreferred || nearestPreferred)
    : (currentActive || queryPreferred || nearestPreferred || selectedDatePreferred);

  if (chosen) {
    await setActiveSession(chosen, { focusEditor: false });
  } else {
    state.activeSession = null;
    state.activeSessionId = null;
    state.activeSessionKey = '';
    renderNearestSubjectList();
    renderSessions();
    renderGate();
    fillForm(null, null);
  }
}

async function loadActiveNote(scheduleId, classDate = state.date) {
  const dateText = String(classDate || state.date || localDateText()).slice(0, 10);
  const rows = await get(`/class_notes?date=${encodeURIComponent(dateText)}&schedule_id=${Number(scheduleId)}`);
  const note = Array.isArray(rows) && rows.length ? rows[0] : null;
  state.activeNote = note;
  fillForm(note, state.activeSession);
}

async function loadHistory() {
  const to = state.date;
  const base = new Date(`${to}T00:00:00`);
  base.setDate(base.getDate() - 7);
  const from = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  const rows = await get(`/class_notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if (!Array.isArray(rows) || !rows.length) {
    els.history.innerHTML = '<div class="notes-empty">Belum ada riwayat catatan 7 hari terakhir.</div>';
    return;
  }
  els.history.innerHTML = rows.slice(0, 12).map((n) => `
    <article class="notes-history-item">
      <h4>${escapeHtml(n.subject || 'Kelas')} | ${escapeHtml(String(n.class_date || '').slice(0, 10))}</h4>
      <p>${escapeHtml(n.summary_text || n.next_action_text || 'Catatan tersimpan.')}</p>
    </article>
  `).join('');
}

async function saveNote(ev) {
  ev.preventDefault();
  const scheduleId = Number(els.scheduleId.value || 0);
  const classDate = String(els.classDate.value || state.date || localDateText()).slice(0, 10);
  if (!scheduleId) {
    showToast('Pilih sesi kelas dulu.', 'error');
    return;
  }
  const body = {
    id: Number(els.noteId.value || 0) || undefined,
    schedule_id: scheduleId,
    class_date: classDate,
    key_points: els.keyPoints.value,
    action_items: els.actionItems.value,
    questions: els.questions.value,
    free_text: els.freeText.value,
    mood_focus: els.moodFocus.value || null,
    confidence: els.confidence.value || null,
  };
  const saved = await post('/class_notes', body);
  state.activeNote = saved;
  if (state.activeSession) {
    state.activeSession.is_minimum_completed = Boolean(saved?.is_minimum_completed);
  }
  fillForm(saved, state.activeSession);
  renderActiveSessionContext(saved, state.activeSession);
  showToast('Catatan sesi berhasil disimpan.', 'success');
  await loadSessions({ preserveActive: true });
  await loadHistory();
}

function bindSessionClicks() {
  const onClick = async (ev) => {
    const card = ev.target.closest('[data-session-id][data-class-date]');
    if (!card) return;
    const id = Number(card.dataset.sessionId || 0);
    const dateText = String(card.dataset.classDate || '').slice(0, 10);
    const session = findSession(id, dateText);
    if (!session) return;
    await setActiveSession(session, { focusEditor: true });
  };
  if (els.sessionList) {
    els.sessionList.addEventListener('click', onClick);
  }
  if (els.nearestList) {
    els.nearestList.addEventListener('click', onClick);
  }
}

function bindLiveMinimumCheck() {
  ['input', 'change'].forEach((evtName) => {
    els.form.addEventListener(evtName, () => {
      setMinimumChip(minimumDoneFromForm());
    });
  });
}

function bindEvents() {
  els.form.addEventListener('submit', saveNote);
  if (els.dateInput) {
    els.dateInput.addEventListener('change', async () => {
      state.date = els.dateInput.value || localDateText();
      await loadSessions({ preserveActive: false, preferSelectedDate: true });
      await loadHistory();
    });
  }
  bindSessionClicks();
  bindLiveMinimumCheck();
  if (els.exportMd) {
    els.exportMd.addEventListener('click', () => {
      exportWeekly('md').catch(() => {
        showToast('Gagal export markdown.', 'error');
      });
    });
  }
  if (els.exportPdf) {
    els.exportPdf.addEventListener('click', () => {
      exportWeekly('pdf').catch(() => {
        showToast('Gagal membuka export PDF.', 'error');
      });
    });
  }
  if (els.gateFocus) {
    els.gateFocus.addEventListener('click', async () => {
      const pending = getPendingStartedSessions();
      if (pending.length) {
        await setActiveSession(pending[0], { focusEditor: true });
      } else {
        els.gate.classList.remove('show');
      }
    });
  }
}

function startRealtimeWatcher() {
  if (state.realtimeTimer) {
    clearInterval(state.realtimeTimer);
    state.realtimeTimer = null;
  }
  state.realtimeTimer = setInterval(async () => {
    try {
      await loadSessions({ preserveActive: true });
      await maybeAutoOpenStartedSession();
    } catch {}
  }, NOTES_REALTIME_POLL_MS);
}

async function init() {
  initProtected();
  normalizeLinks();
  const q = qs();
  state.enforce = q.get('enforce') === '1';
  state.date = String(q.get('date') || localDateText()).slice(0, 10);
  if (els.dateInput) els.dateInput.value = state.date;
  bindEvents();
  initTypingPopupEffects();
  await loadSessions({ preserveActive: true });
  await maybeAutoOpenStartedSession({ force: true });
  await loadHistory();
  renderActiveSessionContext(state.activeNote, state.activeSession);
  startRealtimeWatcher();
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadSessions({ preserveActive: true });
    await maybeAutoOpenStartedSession();
  });
  window.addEventListener('beforeunload', () => {
    if (state.realtimeTimer) clearInterval(state.realtimeTimer);
  });
  if (els.pageSub) {
    els.pageSub.textContent = state.enforce
      ? 'Mode wajib aktif: lengkapi catatan minimum untuk sesi kelas yang sudah berjalan agar Z AI bisa bantu eksekusi.'
      : 'Catat per sesi kuliah hari ini, lalu biarkan Z AI bantu merangkum.';
  }
}

init().catch((err) => {
  console.error(err);
  showToast('Gagal memuat halaman pencatatan.', 'error');
});

