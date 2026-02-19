import { initProtected, showToast } from './main.js';
import { get, post, put, del } from './api.js';

let timerInterval;
let moodOverlay, moodSheet, moodForm, moodGrid, moodValueEl, moodNoteEl;
let addOverlay, addForm;
let lastArchivedAssignmentId = null;
const OWNER_STORAGE_KEY = 'ownership_active_user';
let activeOwner = 'Zaldy';
const LMS_URL_KEY = 'college_lms_url';
const DEFAULT_LMS_URL = 'https://elearning.itg.ac.id/student_area/tugas/index';
let assignmentIntelMap = new Map();
const SUBJECT_CACHE_TTL_MS = 5 * 60 * 1000;
let scheduleSubjects = [];
let scheduleSubjectsLoadedAt = 0;

function normalizeOwner(value) {
  const v = String(value || '').trim().toLowerCase();
  if (v === 'zaldy') return 'Zaldy';
  if (v === 'nesya') return 'Nesya';
  return '';
}

function normalizeSubject(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function subjectKey(value) {
  return normalizeSubject(value).toLowerCase();
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSubjectColor(subject = '') {
  const key = subjectKey(subject) || 'mata kuliah';
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    solid: `hsl(${hue} 86% 72%)`,
    soft: `hsla(${hue}, 86%, 62%, 0.16)`,
    softBorder: `hsla(${hue}, 86%, 62%, 0.34)`,
  };
}

function parseTimeToMinutes(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 23 * 60 + 59;
  const hh = Math.max(0, Math.min(23, Number(m[1] || 0)));
  const mm = Math.max(0, Math.min(59, Number(m[2] || 0)));
  return hh * 60 + mm;
}

function dayDistanceFromToday(dayId) {
  const today = new Date().getDay() || 7;
  const day = Number(dayId) || 0;
  if (day < 1 || day > 7) return 8;
  return (day - today + 7) % 7;
}

function buildSubjectOptionsFromSchedule(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const subject = normalizeSubject(row?.subject);
    if (!subject) continue;
    const key = subjectKey(subject);
    const rank = (dayDistanceFromToday(row?.day_id) * 24 * 60) + parseTimeToMinutes(row?.time_start);
    const prev = map.get(key);
    if (!prev || rank < prev.rank) {
      map.set(key, { subject, rank });
    }
  }
  return [...map.values()]
    .sort((a, b) => a.rank - b.rank || a.subject.localeCompare(b.subject, 'id'))
    .map((item) => item.subject);
}

function renderSubjectSelect() {
  const select = document.querySelector('#create-assignment select[name="title"]');
  const hint = document.getElementById('assignment-subject-hint');
  if (!select) return;

  const current = normalizeSubject(select.value);
  if (!scheduleSubjects.length) {
    select.innerHTML = '<option value="">Belum ada mata kuliah di jadwal</option>';
    select.disabled = true;
    if (hint) hint.textContent = 'Belum ada mapel di jadwal. Tambah jadwal dulu di halaman Jadwal.';
    return;
  }

  const optionsHtml = scheduleSubjects
    .map((subject) => `<option value="${escapeHtml(subject)}">${escapeHtml(subject)}</option>`)
    .join('');
  select.innerHTML = `<option value="">Pilih mata kuliah...</option>${optionsHtml}`;
  select.disabled = false;
  const fallback = scheduleSubjects[0] || '';
  select.value = scheduleSubjects.includes(current) ? current : fallback;
  if (hint) hint.textContent = `Mapel otomatis dari jadwal kuliah (${scheduleSubjects.length} mapel).`;
}

async function ensureScheduleSubjects(force = false) {
  const now = Date.now();
  if (!force && now - scheduleSubjectsLoadedAt < SUBJECT_CACHE_TTL_MS && scheduleSubjects.length) {
    renderSubjectSelect();
    return scheduleSubjects;
  }

  try {
    const rows = await get('/schedule');
    scheduleSubjects = buildSubjectOptionsFromSchedule(Array.isArray(rows) ? rows : []);
    scheduleSubjectsLoadedAt = now;
  } catch {
    scheduleSubjects = [];
  }
  renderSubjectSelect();
  return scheduleSubjects;
}

function getDefaultOwner() {
  const stored = normalizeOwner(localStorage.getItem(OWNER_STORAGE_KEY));
  if (stored) return stored;
  const user = normalizeOwner(localStorage.getItem('user'));
  return user || 'Zaldy';
}

function getAssignmentOwner(item) {
  return normalizeOwner(item?.assigned_to);
}

function isOwnedByActiveUser(item) {
  return getAssignmentOwner(item) === activeOwner;
}

function updateOwnerTabs() {
  document.querySelectorAll('.owner-tab[data-owner]').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.owner === activeOwner);
  });
}

function syncAddOwnerSelect() {
  const select = document.querySelector('#create-assignment select[name="assigned_to"]');
  if (select) select.value = activeOwner;
}

function setActiveOwner(owner, options = {}) {
  const persist = options.persist !== false;
  activeOwner = normalizeOwner(owner) || 'Zaldy';
  if (persist) localStorage.setItem(OWNER_STORAGE_KEY, activeOwner);
  updateOwnerTabs();
  syncAddOwnerSelect();
}

function normalizeLmsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_LMS_URL;
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('invalid protocol');
  return parsed.toString();
}

function openLmsUrl(url) {
  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer');
  } catch {}
  if (opened && typeof opened.focus === 'function') {
    opened.focus();
    return;
  }
  // Fallback for mobile/PWA when popup is blocked.
  window.location.assign(url);
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Lewat deadline';
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((ms % (1000 * 60)) / 1000);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function sendNotification(title, timeLeft) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('Tugas Mendesak!', {
      body: `"${title}" sisa waktu ${timeLeft}`,
      icon: '/icons/192.png'
    });
  }
}

function clampRiskScore(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function deriveBehaviorProfile(assignments = []) {
  const list = Array.isArray(assignments) ? assignments : [];
  const completed = list.filter((item) => item && item.completed && item.completed_at && item.deadline);
  if (!completed.length) {
    return {
      onTimeRate: 0.5,
      overdueRate: 0.5,
      avgLateHours: 18,
      consistencyScore: 50,
      confidence: 'low',
    };
  }

  let onTime = 0;
  let overdue = 0;
  let lateHoursSum = 0;

  completed.forEach((item) => {
    const doneAt = new Date(item.completed_at).getTime();
    const deadlineAt = new Date(item.deadline).getTime();
    if (!Number.isFinite(doneAt) || !Number.isFinite(deadlineAt)) return;
    const lateHours = (doneAt - deadlineAt) / 3600000;
    if (lateHours <= 0) onTime += 1;
    else overdue += 1;
    lateHoursSum += Math.max(0, lateHours);
  });

  const total = Math.max(1, onTime + overdue);
  const onTimeRate = onTime / total;
  const overdueRate = overdue / total;
  const avgLateHours = lateHoursSum / total;
  const consistencyScore = clampRiskScore((onTimeRate * 70) + (Math.max(0, 1 - (avgLateHours / 24)) * 30));
  const confidence = total >= 12 ? 'high' : (total >= 5 ? 'medium' : 'low');

  return { onTimeRate, overdueRate, avgLateHours, consistencyScore, confidence };
}

function computeAssignmentRiskModel(item, ownerLoad = 1, profile = null) {
  const now = Date.now();
  const title = String(item?.title || '').toLowerCase();
  const description = String(item?.description || '').toLowerCase();
  const due = item?.deadline ? new Date(item.deadline).getTime() : Number.NaN;
  const hasDeadline = Number.isFinite(due);
  const hoursLeft = hasDeadline ? (due - now) / 3600000 : null;
  const userProfile = profile || {
    onTimeRate: 0.5,
    overdueRate: 0.5,
    avgLateHours: 18,
    consistencyScore: 50,
    confidence: 'low',
  };

  let score = 24;
  if (!hasDeadline) score += 10;
  else if (hoursLeft <= 0) score += 70;
  else if (hoursLeft <= 6) score += 62;
  else if (hoursLeft <= 24) score += 50;
  else if (hoursLeft <= 48) score += 34;
  else if (hoursLeft <= 72) score += 24;
  else score += 12;

  if (/\b(ujian|kuis|quiz|uas|uts|project|laporan|proposal|presentasi|praktikum)\b/.test(`${title} ${description}`)) score += 12;
  if (/\b(final|wajib|utama|penting|urgent)\b/.test(`${title} ${description}`)) score += 8;
  score += Math.min(12, Math.max(0, ownerLoad - 2) * 3);
  score += Math.min(14, Math.round((userProfile.overdueRate || 0) * 16));
  score -= Math.min(10, Math.round((userProfile.onTimeRate || 0) * 10));
  score += Math.min(10, Math.round((userProfile.avgLateHours || 0) / 5));

  const normalized = clampRiskScore(score);
  let band = 'low';
  if (normalized >= 78) band = 'critical';
  else if (normalized >= 62) band = 'high';
  else if (normalized >= 42) band = 'medium';

  const featureConfidence = hasDeadline && String(description).trim().length >= 12 ? 'high' : (hasDeadline ? 'medium' : 'low');
  const confidence = userProfile.confidence === 'high'
    ? featureConfidence
    : (userProfile.confidence === 'medium' ? 'medium' : featureConfidence === 'high' ? 'medium' : featureConfidence);
  return {
    score: normalized,
    band,
    hoursLeft,
    confidence,
    hasDeadline,
  };
}

function buildAssignmentIntelligence(assignments = []) {
  const list = Array.isArray(assignments) ? assignments : [];
  if (!list.length) return { items: [], top: null, profile: deriveBehaviorProfile([]) };
  const profile = deriveBehaviorProfile(list);
  const ownerLoad = list.length;
  const enriched = list.map((item) => {
    const model = computeAssignmentRiskModel(item, ownerLoad, profile);
    return { ...item, _risk: model };
  }).sort((a, b) => Number(b._risk.score || 0) - Number(a._risk.score || 0));
  return { items: enriched, top: enriched[0] || null, profile };
}

function buildAiActionText(top) {
  if (!top) return 'Belum ada sinyal risiko. Pertahankan ritme eksekusi harian.';
  const title = String(top.title || 'tugas ini').trim();
  const risk = top._risk || {};
  if (risk.band === 'critical') return `Mulai "${title}" sekarang 25 menit. Jangan pindah konteks dulu.`;
  if (risk.band === 'high') return `Prioritaskan "${title}" di sesi berikutnya sebelum tugas lain.`;
  if (risk.band === 'medium') return `Siapkan progress awal "${title}" hari ini minimal 15 menit.`;
  return `Kondisi aman. Kamu bisa cicil "${title}" sambil menjaga konsistensi.`;
}

function buildAiWhyText(top, activeCount = 0) {
  if (!top) return 'Data tugas kuliah masih minim untuk analisis risiko.';
  const risk = top._risk || {};
  const timeLabel = Number.isFinite(risk.hoursLeft)
    ? (risk.hoursLeft <= 0 ? 'deadline sudah lewat' : `deadline ~${Math.max(1, Math.round(risk.hoursLeft))} jam lagi`)
    : 'deadline belum diisi';
  return `Model membaca ${activeCount} tugas aktif, dan "${top.title}" punya skor ${risk.score} (${risk.band}) karena ${timeLabel}.`;
}

function renderAssignmentAiEngine(assignments = []) {
  const host = document.getElementById('assignment-ai-engine');
  if (!host) return;
  const { items, top, profile } = buildAssignmentIntelligence(assignments);
  assignmentIntelMap = new Map(items.map((item) => [String(item.id), item._risk]));

  if (!top) {
    host.innerHTML = `
      <div class="assignment-ai-card">
        <div class="assignment-ai-head">
          <span class="assignment-ai-title">Academic Intelligence Engine</span>
          <span class="assignment-ai-confidence medium">Confidence medium</span>
        </div>
        <div class="assignment-ai-main">Belum ada tugas kuliah aktif untuk dianalisis.</div>
        <div class="assignment-ai-sub">Tambahkan tugas baru agar Z AI bisa memprediksi risiko deadline.</div>
      </div>
    `;
    return;
  }

  const risk = top._risk || {};
  const command = encodeURIComponent(`analisis tugas kuliah saya, prioritaskan "${top.title}" dan buat rencana 3 langkah`);
  host.innerHTML = `
    <div class="assignment-ai-card">
      <div class="assignment-ai-head">
        <span class="assignment-ai-title">Academic Intelligence Engine</span>
        <span class="assignment-ai-confidence ${risk.confidence || 'medium'}">Confidence ${risk.confidence || 'medium'}</span>
      </div>
      <div class="assignment-ai-main">${buildAiActionText(top)}</div>
      <div class="assignment-ai-sub">${buildAiWhyText(top, items.length)}</div>
      <div class="assignment-ai-chips">
        <span class="assignment-ai-chip ${risk.band || 'medium'}">Skor ${risk.score || 0}</span>
        <span class="assignment-ai-chip ${risk.band || 'medium'}">Risk ${String(risk.band || 'medium').toUpperCase()}</span>
        <span class="assignment-ai-chip">${Number.isFinite(risk.hoursLeft) ? `Due ${Math.max(0, Math.round(risk.hoursLeft))}j` : 'Tanpa deadline'}</span>
        <span class="assignment-ai-chip">On-time ${Math.round((profile?.onTimeRate || 0) * 100)}%</span>
        <span class="assignment-ai-chip">Konsisten ${profile?.consistencyScore || 0}</span>
      </div>
      <div class="assignment-ai-actions">
        <a class="btn small" href="/chat?ai=${command}"><i class="fa-solid fa-robot"></i> Buka Rencana Z AI</a>
        <a class="btn small secondary" href="/schedule"><i class="fa-solid fa-calendar-day"></i> Atur Slot Belajar</a>
      </div>
    </div>
  `;
}

function summarizeDeadlineShield(assignments = []) {
  const now = Date.now();
  const out = {
    overdue: 0,
    due24h: 0,
    due48h: 0,
    nextItem: null,
    nextDiff: Number.POSITIVE_INFINITY,
  };

  for (const item of assignments) {
    if (!item || !item.deadline) continue;
    const due = new Date(item.deadline).getTime();
    if (!Number.isFinite(due)) continue;
    const diff = due - now;
    if (diff <= 0) out.overdue += 1;
    else if (diff <= 24 * 60 * 60 * 1000) out.due24h += 1;
    else if (diff <= 48 * 60 * 60 * 1000) out.due48h += 1;

    if (diff > 0 && diff < out.nextDiff) {
      out.nextDiff = diff;
      out.nextItem = item;
    }
  }
  return out;
}

function renderDeadlineShield(assignments = []) {
  const host = document.getElementById('assignment-deadline-shield');
  if (!host) return;

  const stats = summarizeDeadlineShield(assignments);
  const watchCount = stats.overdue + stats.due24h + stats.due48h;

  if (watchCount === 0) {
    host.innerHTML = `
      <div class="deadline-shield">
        <div>
          <span class="deadline-shield-title">Pelindung Deadline</span>
          <div class="deadline-shield-main">Semua deadline aman untuk 48 jam ke depan.</div>
          <div class="deadline-shield-sub">Pertahankan ritme ini biar tugas kuliah tidak numpuk.</div>
        </div>
        <div class="deadline-shield-badges">
          <span class="deadline-shield-badge">Tenang</span>
        </div>
      </div>
    `;
    return;
  }

  const levelClass = stats.overdue > 0 ? 'is-critical' : stats.due24h > 0 ? 'is-warning' : 'is-good';
  let mainText = '';
  if (stats.overdue > 0) {
    mainText = `${stats.overdue} tugas kuliah sudah overdue. Tangani sekarang.`;
  } else if (stats.due24h > 0) {
    mainText = `${stats.due24h} tugas kuliah due <24 jam. Prioritaskan hari ini.`;
  } else {
    mainText = `${stats.due48h} tugas kuliah belum masuk 24 jam. Masih aman, tetap jaga progres.`;
  }

  const nextLabel = stats.nextItem
    ? `Terdekat: ${stats.nextItem.title} (${formatCountdown(stats.nextDiff)})`
    : 'Tidak ada deadline aktif berikutnya.';

  host.innerHTML = `
    <div class="deadline-shield ${levelClass}">
      <div>
        <span class="deadline-shield-title">Pelindung Deadline</span>
        <div class="deadline-shield-main">${mainText}</div>
        <div class="deadline-shield-sub">${nextLabel}</div>
      </div>
      <div class="deadline-shield-badges">
        <span class="deadline-shield-badge critical">Lewat ${stats.overdue}</span>
        <span class="deadline-shield-badge warning">24j ${stats.due24h}</span>
        <span class="deadline-shield-badge good">Aman>24j ${stats.due48h}</span>
      </div>
    </div>
  `;
}

function updateTimers() {
  const items = document.querySelectorAll('.countdown-timer');
  const now = Date.now();

  items.forEach(el => {
    const deadline = new Date(el.dataset.deadline).getTime();
    const diff = deadline - now;

    el.textContent = formatCountdown(diff);

    const parent = el.closest('.list-item');
    if (diff <= 0) {
      parent.classList.add('overdue');
      parent.classList.remove('urgent');
      parent.classList.remove('safe');
    } else if (diff <= 86400000) {
      if (!parent.classList.contains('urgent')) {
        parent.classList.add('urgent');
        if (!el.dataset.notified) {
          sendNotification(el.dataset.title, formatCountdown(diff));
          el.dataset.notified = 'true';
        }
      }
      parent.classList.remove('overdue');
      parent.classList.remove('safe');
    } else {
      parent.classList.remove('urgent');
      parent.classList.remove('overdue');
      parent.classList.add('safe');
    }
  });
}

async function load() {
  initProtected();
  await requestNotificationPermission();

  const activeList = document.querySelector('#assignments-active');
  const completedList = document.querySelector('#assignments-completed');
  const archiveTitle = document.getElementById('assignments-archive-title');
  const el1d = document.getElementById('stat-1d');
  const el3d = document.getElementById('stat-3d');
  const el5d = document.getElementById('stat-5d');

  activeList.innerHTML = '';
  completedList.innerHTML = '';

  const data = await get('/assignments');
  const scoped = data.filter(isOwnedByActiveUser);

  if (!scoped.length) {
    renderDeadlineShield([]);
    renderAssignmentAiEngine([]);
    activeList.innerHTML = `<div class="empty center muted">Belum ada tugas kuliah milik ${activeOwner}.</div>`;
    if (el1d) el1d.textContent = '0 tugas';
    if (el3d) el3d.textContent = '0 tugas';
    if (el5d) el5d.textContent = '0 tugas';
    return;
  }

  // Stats
  try {
    const now = Date.now();
    const daysToMs = (d) => d * 24 * 60 * 60 * 1000;
    const done = scoped.filter(a => a.completed && a.completed_at);
    const within = (a, days) => {
      const t = new Date(a.completed_at).getTime();
      return (now - t) <= daysToMs(days);
    };
    const c1 = done.filter(a => within(a, 1)).length;
    const c3 = done.filter(a => within(a, 3)).length;
    const c5 = done.filter(a => within(a, 5)).length;
    if (el1d) el1d.textContent = `${c1} tugas`;
    if (el3d) el3d.textContent = `${c3} tugas`;
    if (el5d) el5d.textContent = `${c5} tugas`;
  } catch (_) { }

  const active = scoped.filter(a => !a.completed).sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  const completed = scoped.filter(a => a.completed).sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  renderDeadlineShield(active);
  renderAssignmentAiEngine(active);

  const createItem = (a, isCompleted) => {
    const owner = getAssignmentOwner(a) || 'Other';
    const ownerClass = owner ? `owner-${owner.toLowerCase()}` : '';
    const subject = normalizeSubject(a?.title) || 'Mata Kuliah';
    const color = getSubjectColor(subject);
    const el = document.createElement('div');
    el.className = `list-item assignment-item ${ownerClass}`.trim();
    el.dataset.assignmentId = String(a.id);
    el.style.setProperty('--subject-accent', color.solid);
    el.style.setProperty('--subject-soft', color.soft);
    el.style.setProperty('--subject-soft-border', color.softBorder);

    el.innerHTML = `
      <div style="flex:1">
        <div style="display:flex; align-items:center; gap:8px">
          <input type="checkbox" ${isCompleted ? 'checked' : ''} data-id="${a.id}" data-action="toggle">
          <strong class="assignment-subject-title" style="font-size:13px">${escapeHtml(subject)}</strong>
          <span class="subject-label-chip">Mapel</span>
          ${!isCompleted ? `<span class="risk-chip ${(assignmentIntelMap.get(String(a.id)) || {}).band || 'low'}">${((assignmentIntelMap.get(String(a.id)) || {}).band || 'low')}</span>` : ''}
          <span class="owner-chip ${ownerClass}">${owner || 'OTHER'}</span>
        </div>
        ${a.description ? `<div class="muted small" style="margin-left:24px; font-size:11px">${escapeHtml(a.description)}</div>` : ''}
        <div class="muted small" style="margin-left:24px; margin-top:4px; display:flex; flex-wrap:wrap; gap:6px; align-items:center">
          ${isCompleted ?
        `<span class="badge success"><i class="fa-solid fa-check"></i> ${new Date(a.completed_at).toLocaleDateString()}</span>` :
        `<span class="badge countdown-timer" data-deadline="${a.deadline}" data-title="${escapeHtml(subject)}">...</span>`
      }
          <span style="font-size:10px; opacity:0.6"><i class="fa-solid fa-user"></i> ${owner || 'Other'}</span>
        </div>
      </div>
      <div class="actions">
        <button class="btn danger small" data-id="${a.id}" data-action="delete" style="padding:4px 8px"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    return el;
  };

  active.forEach(item => activeList.appendChild(createItem(item, false)));
  completed.forEach(item => completedList.appendChild(createItem(item, true)));

  if (!active.length) {
    activeList.innerHTML = `<div class="empty center muted">Tidak ada tugas aktif milik ${activeOwner}.</div>`;
  }
  if (!completed.length) {
    completedList.innerHTML = `<div class="empty center muted">Arsip ${activeOwner} masih kosong. Tugas selesai akan muncul di sini.</div>`;
  }
  if (archiveTitle) {
    archiveTitle.innerHTML = `<i class="fa-solid fa-box-archive"></i> Arsip Selesai (${completed.length})`;
  }

  if (lastArchivedAssignmentId) {
    const target = completedList.querySelector(`[data-assignment-id="${lastArchivedAssignmentId}"]`);
    if (target) {
      target.classList.add('archive-highlight');
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => target.classList.remove('archive-highlight'), 2400);
    }
    lastArchivedAssignmentId = null;
  }

  if (timerInterval) clearInterval(timerInterval);
  updateTimers();
  timerInterval = setInterval(updateTimers, 1000);
}

async function create(e) {
  e.preventDefault();
  const f = new FormData(e.target);
  const subject = normalizeSubject(f.get('title'));
  const deadline = f.get('deadline');

  if (!subject) {
    showToast('Pilih mata kuliah dulu dari jadwal kuliah.', 'error');
    return;
  }

  if (new Date(deadline) < new Date()) {
    showToast('Deadline tidak boleh di masa lalu', 'error');
    return;
  }

  const body = {
    title: subject,
    description: f.get('description'),
    deadline: deadline,
    assigned_to: normalizeOwner(f.get('assigned_to')) || activeOwner
  };

  await post('/assignments', body);
  e.target.reset();
  syncAddOwnerSelect();
  closeAddModal();
  load();
  showToast('Tugas ditambahkan', 'success');
}

async function actions(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const id = btn.dataset.id;
  const act = btn.dataset.action;

  if (act === 'delete') {
    if (!confirm('Hapus tugas ini?')) return;
    await del(`/assignments?id=${id}`);
    showToast('Tugas dihapus', 'success');
  }
  if (act === 'toggle') {
    await post('/assignments', { action: 'toggle', id, completed: btn.checked });
    if (btn.checked) {
      lastArchivedAssignmentId = String(id);
      const title = btn.closest('.list-item')?.querySelector('strong')?.textContent || '';
      openMoodPrompt(`Selesai tugas kuliah: ${title}`);
      showToast('Tugas dipindahkan ke arsip selesai', 'success');
    }
  }
  load();
}

function init() {
  activeOwner = getDefaultOwner();
  setActiveOwner(activeOwner, { persist: false });

  document.querySelector('#create-assignment').addEventListener('submit', create);
  document.querySelector('#assignments-active').addEventListener('change', actions);
  document.querySelector('#assignments-completed').addEventListener('change', actions);
  document.querySelector('#assignments-active').addEventListener('click', actions);
  document.querySelector('#assignments-completed').addEventListener('click', actions);
  document.querySelectorAll('.owner-tab[data-owner]').forEach(tab => {
    tab.addEventListener('click', () => {
      setActiveOwner(tab.dataset.owner);
      load();
    });
  });

  // FAB Modal logic
  addOverlay = document.getElementById('add-overlay');
  document.getElementById('open-add').addEventListener('click', openAddModal);
  document.getElementById('add-cancel').addEventListener('click', closeAddModal);
  setupLmsQuickAccess();
  ensureScheduleSubjects().catch(() => {});

  load();
  moodOverlay = document.getElementById('mood-overlay');
  moodSheet = document.getElementById('mood-sheet');
  moodForm = document.getElementById('mood-form');
  moodGrid = document.getElementById('mood-grid');
  moodValueEl = document.getElementById('mood-value');
  moodNoteEl = document.getElementById('mood-note');
  setupMoodEvents();
}

function getLmsUrl() {
  const stored = (localStorage.getItem(LMS_URL_KEY) || '').trim();
  try {
    const normalized = normalizeLmsUrl(stored || DEFAULT_LMS_URL);
    localStorage.setItem(LMS_URL_KEY, normalized);
    return normalized;
  } catch {
    localStorage.setItem(LMS_URL_KEY, DEFAULT_LMS_URL);
    return DEFAULT_LMS_URL;
  }
}

function setupLmsQuickAccess() {
  const openBtn = document.getElementById('open-lms-btn');
  const label = document.getElementById('lms-url-label');
  if (!openBtn || !label) return;

  const url = getLmsUrl();
  label.textContent = url;

  openBtn.addEventListener('click', () => {
    try {
      const target = normalizeLmsUrl(url);
      openLmsUrl(target);
    } catch {
      showToast('URL LMS tidak valid. Ubah di Pengaturan.', 'error');
    }
  });
}

async function openAddModal() {
  addOverlay.classList.add('active');
  addOverlay.querySelector('.bottom-sheet').classList.add('active');
  await ensureScheduleSubjects();
}

function closeAddModal() {
  addOverlay.classList.remove('active');
  addOverlay.querySelector('.bottom-sheet').classList.remove('active');
}

document.addEventListener('DOMContentLoaded', init);

function setupMoodEvents() {
  if (!moodGrid) return;

  const moodGlows = {
    1: 'radial-gradient(circle at center, hsla(0, 70%, 50%, 0.15), transparent 70%)',
    2: 'radial-gradient(circle at center, hsla(30, 70%, 50%, 0.15), transparent 70%)',
    3: 'radial-gradient(circle at center, hsla(200, 70%, 50%, 0.15), transparent 70%)',
    4: 'radial-gradient(circle at center, hsla(140, 70%, 50%, 0.15), transparent 70%)',
    5: 'radial-gradient(circle at center, hsla(280, 70%, 55%, 0.15), transparent 70%)'
  };

  moodGrid.querySelectorAll('.prio-btn').forEach(b => {
    b.addEventListener('click', () => {
      moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      moodValueEl.value = b.dataset.val;

      const glow = document.getElementById('mood-glow');
      glow.style.background = moodGlows[b.dataset.val];
      glow.style.opacity = '1';
    });
  });

  document.querySelectorAll('.tag-chip-enhanced').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('active'));
  });

  document.getElementById('mood-cancel')?.addEventListener('click', closeMoodPrompt);

  moodForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!moodValueEl.value) { showToast('Pilih mood', 'error'); return; }

    const tags = Array.from(document.querySelectorAll('.tag-chip-enhanced.active'))
      .map(c => c.dataset.val).join(', ');

    const body = {
      mood: moodValueEl.value,
      note: `${tags ? '[' + tags + '] ' : ''}${moodNoteEl.value}`,
      date: new Date().toISOString()
    };

    await post('/evaluations', body);
    showToast('Mood disimpan', 'success');
    closeMoodPrompt();
  });
}

function openMoodPrompt(note) {
  if (!moodOverlay) return;
  moodValueEl.value = '';
  moodNoteEl.value = note || '';
  moodGrid.querySelectorAll('.prio-btn').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.tag-chip-enhanced').forEach(x => x.classList.remove('active'));
  document.getElementById('mood-glow').style.opacity = '0';
  moodOverlay.classList.add('active');
  moodSheet.classList.add('active');
}

function closeMoodPrompt() {
  moodOverlay.classList.remove('active');
  moodSheet.classList.remove('active');
}

