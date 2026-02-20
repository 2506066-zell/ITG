import { initProtected, setTheme, logout, showToast } from './main.js';
import { get, put } from './api.js';

const LMS_URL_KEY = 'college_lms_url';
const DEFAULT_LMS_URL = 'https://elearning.itg.ac.id/student_area/tugas/index';
const SEMESTER_MONTH_LABELS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const ACTIVITY_WINDOW_DAYS = 7;
const ACTIVITY_LIMIT = 300;
const HOURS_PER_DAY = 24;
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDayMs(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKeyFromTs(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseEventTs(event) {
  const raw = event?.server_ts || event?.client_ts || event?.created_at || '';
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function formatCount(value) {
  return new Intl.NumberFormat('id-ID').format(Number(value || 0));
}

function formatDateTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '--';
  return new Date(ts).toLocaleString('id-ID', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDayLabel(dayKey = '') {
  const ts = new Date(`${dayKey}T00:00:00`).getTime();
  if (!Number.isFinite(ts)) return dayKey;
  return new Date(ts).toLocaleDateString('id-ID', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
  });
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = String(value ?? '');
}

function computeCurrentStreak(dailyCounts = new Map()) {
  const todayStart = startOfDayMs(Date.now());
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const key = dayKeyFromTs(todayStart - (i * DAY_MS));
    if (!key) break;
    const count = Number(dailyCounts.get(key) || 0);
    if (count <= 0) break;
    streak += 1;
  }
  return streak;
}

function buildRecentDays() {
  const days = [];
  const todayStart = startOfDayMs(Date.now());
  for (let i = ACTIVITY_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const ts = todayStart - (i * DAY_MS);
    days.push({
      key: dayKeyFromTs(ts),
      ts,
    });
  }
  return days;
}

function analyzeActivity(events = []) {
  const now = Date.now();
  const since = now - (ACTIVITY_WINDOW_DAYS * DAY_MS);
  const filtered = [];
  const eventCounts = new Map();
  const dailyCounts = new Map();
  const hourlyCounts = new Array(HOURS_PER_DAY).fill(0);
  let lastEventAt = 0;

  for (const event of events) {
    const ts = parseEventTs(event);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    if (ts < since) continue;
    filtered.push(event);
    if (ts > lastEventAt) lastEventAt = ts;

    const eventName = String(event?.event_name || '').trim().toLowerCase();
    if (eventName) {
      eventCounts.set(eventName, Number(eventCounts.get(eventName) || 0) + 1);
    }

    const dayKey = dayKeyFromTs(ts);
    if (dayKey) {
      dailyCounts.set(dayKey, Number(dailyCounts.get(dayKey) || 0) + 1);
    }

    const hour = new Date(ts).getHours();
    if (hour >= 0 && hour < HOURS_PER_DAY) {
      hourlyCounts[hour] = Number(hourlyCounts[hour] || 0) + 1;
    }
  }

  const prompts = Number(eventCounts.get('zai_prompt') || 0);
  const replies = Number(eventCounts.get('zai_reply') || 0);
  const feedbacks = Number(eventCounts.get('zai_feedback_saved') || 0);
  const replyRate = prompts > 0 ? Math.min(100, Math.round((replies / prompts) * 100)) : 0;

  const funnel = [
    { label: 'Input Chat', key: 'chat_input_submit', count: Number(eventCounts.get('chat_input_submit') || 0) },
    { label: 'Prompt Z AI', key: 'zai_prompt', count: prompts },
    { label: 'Reply Z AI', key: 'zai_reply', count: replies },
    { label: 'Feedback', key: 'zai_feedback_saved', count: feedbacks },
  ].map((item, idx, arr) => {
    if (idx === 0) return { ...item, conversion: 100 };
    const prev = Number(arr[idx - 1].count || 0);
    const conversion = prev > 0 ? Math.round((item.count / prev) * 100) : 0;
    return { ...item, conversion: Math.max(0, Math.min(100, conversion)) };
  });

  const topEvents = Array.from(eventCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  const recentDays = buildRecentDays().map((entry) => {
    const count = Number(dailyCounts.get(entry.key) || 0);
    return {
      ...entry,
      count,
      active: count > 0,
    };
  });

  const activeDays = recentDays.filter((item) => item.active).length;
  const streak = computeCurrentStreak(dailyCounts);

  return {
    totalEvents: filtered.length,
    activeDays,
    streak,
    replyRate,
    lastEventAt,
    funnel,
    topEvents,
    hourlyCounts,
    recentDays,
  };
}

function renderListWithBars(container, rows, getLabel, getValue, getRatio) {
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = 'Belum ada data.';
    container.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const label = String(getLabel(row) || '-');
    const value = String(getValue(row) || '0');
    const ratio = Math.max(0, Math.min(100, Number(getRatio(row) || 0)));

    const node = document.createElement('div');
    node.className = 'activity-row';
    const head = document.createElement('div');
    head.className = 'activity-row-head';

    const titleEl = document.createElement('span');
    titleEl.className = 'activity-row-title';
    titleEl.textContent = label;

    const valueEl = document.createElement('span');
    valueEl.className = 'activity-row-value';
    valueEl.textContent = value;

    const track = document.createElement('div');
    track.className = 'activity-row-track';

    const fill = document.createElement('div');
    fill.className = 'activity-row-fill';
    fill.style.width = `${ratio}%`;

    head.appendChild(titleEl);
    head.appendChild(valueEl);
    track.appendChild(fill);
    node.appendChild(head);
    node.appendChild(track);
    container.appendChild(node);
  }
}

function renderHourlyHeatmap(container, hourlyCounts = []) {
  if (!container) return;
  container.innerHTML = '';
  const max = Math.max(1, ...hourlyCounts);

  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const count = Number(hourlyCounts[hour] || 0);
    const ratio = count / max;
    const intensity = ratio <= 0
      ? 0
      : ratio < 0.25
        ? 1
        : ratio < 0.5
          ? 2
          : ratio < 0.75
            ? 3
            : 4;

    const cell = document.createElement('div');
    cell.className = `activity-heatmap-cell intensity-${intensity}`;
    cell.title = `${String(hour).padStart(2, '0')}:00 | ${count} events`;
    cell.innerHTML = `
      <span class="hour">${String(hour).padStart(2, '0')}</span>
      <strong>${count}</strong>
    `;
    container.appendChild(cell);
  }
}

function renderRetentionRows(container, recentDays = []) {
  if (!container) return;
  const max = Math.max(1, ...recentDays.map((item) => Number(item.count || 0)));
  renderListWithBars(
    container,
    recentDays,
    (item) => formatDayLabel(item.key),
    (item) => `${formatCount(item.count)}${item.active ? ' active' : ''}`,
    (item) => ((Number(item.count || 0) / max) * 100)
  );
}

function renderActivityAnalytics(metrics) {
  if (!metrics) return;

  setText('activity-total-events', formatCount(metrics.totalEvents));
  setText('activity-active-days', `${metrics.activeDays}/${ACTIVITY_WINDOW_DAYS}`);
  setText('activity-streak-days', `${metrics.streak} hari`);
  setText('activity-reply-rate', `${metrics.replyRate}%`);

  const updatedText = metrics.lastEventAt > 0
    ? `Data 7 hari terakhir. Last event: ${formatDateTime(metrics.lastEventAt)}`
    : 'Data 7 hari terakhir belum tersedia.';
  setText('activity-analytics-updated', updatedText);

  const funnelMax = Math.max(1, ...metrics.funnel.map((item) => Number(item.count || 0)));
  renderListWithBars(
    document.getElementById('activity-funnel-list'),
    metrics.funnel,
    (item) => item.label,
    (item) => `${formatCount(item.count)} | ${item.conversion}%`,
    (item) => ((Number(item.count || 0) / funnelMax) * 100)
  );

  const topMax = Math.max(1, ...metrics.topEvents.map((item) => Number(item.count || 0)));
  renderListWithBars(
    document.getElementById('activity-top-events'),
    metrics.topEvents,
    (item) => item.name,
    (item) => formatCount(item.count),
    (item) => ((Number(item.count || 0) / topMax) * 100)
  );

  renderHourlyHeatmap(document.getElementById('activity-hourly-heatmap'), metrics.hourlyCounts);
  renderRetentionRows(document.getElementById('activity-retention-rows'), metrics.recentDays);
}

function renderKeyValueRows(container, rows = []) {
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(rows) || rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'activity-empty';
    empty.textContent = 'Belum ada data.';
    container.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const node = document.createElement('div');
    node.className = 'activity-row';
    const head = document.createElement('div');
    head.className = 'activity-row-head';

    const titleEl = document.createElement('span');
    titleEl.className = 'activity-row-title';
    titleEl.textContent = String(row.label || '-');

    const valueEl = document.createElement('span');
    valueEl.className = 'activity-row-value';
    valueEl.textContent = String(row.value || '-');

    head.appendChild(titleEl);
    head.appendChild(valueEl);
    node.appendChild(head);
    container.appendChild(node);
  }
}

function renderChatMetrics(payload = {}, pushPayload = null) {
  const summary = payload && typeof payload.summary === 'object' ? payload.summary : {};
  const engines = Array.isArray(payload.engines) ? payload.engines : [];
  const push = pushPayload && typeof pushPayload === 'object' ? pushPayload : null;

  const summaryRows = [
    { label: 'Requests (7d)', value: formatCount(summary.total_requests || 0) },
    { label: 'Fallback Rate', value: `${Number(summary.fallback_rate_pct || 0).toFixed(1)}%` },
    { label: 'Avg Latency', value: `${Math.round(Number(summary.avg_latency_ms || 0))} ms` },
    { label: 'P95 Latency', value: `${Math.round(Number(summary.p95_latency_ms || 0))} ms` },
  ];
  if (push) {
    summaryRows.push(
      { label: 'Copilot Push', value: formatCount(push.copilot_sent || 0) },
      { label: 'Copilot Start', value: formatCount(push.copilot_action_start || 0) },
      { label: 'Copilot Replan', value: formatCount(push.copilot_action_replan || 0) },
      { label: 'Drift Follow-up', value: formatCount(push.copilot_drift_recovered || 0) },
      { label: 'Copilot Ignore Rate', value: `${Math.round(Number(push.copilot_ignore_rate || 0) * 100)}%` },
    );
  }

  renderKeyValueRows(
    document.getElementById('chat-metrics-summary'),
    summaryRows
  );

  const max = Math.max(1, ...engines.map((item) => Number(item.count || 0)));
  renderListWithBars(
    document.getElementById('chat-metrics-engines'),
    engines.slice(0, 6),
    (item) => String(item.engine || 'unknown'),
    (item) => formatCount(item.count || 0),
    (item) => ((Number(item.count || 0) / max) * 100)
  );
}

async function refreshChatMetrics() {
  const summaryEl = document.getElementById('chat-metrics-summary');
  if (!summaryEl) return;
  try {
    const [payload, pushPayload] = await Promise.all([
      get('/chat_metrics?days=7'),
      get('/push_metrics?days=7'),
    ]);
    renderChatMetrics(payload || {}, pushPayload || null);
  } catch {
    renderKeyValueRows(summaryEl, [{ label: 'Engine Health', value: 'Gagal memuat metrics' }]);
  }
}

async function refreshActivityAnalytics() {
  const refreshBtn = document.getElementById('refresh-activity-analytics-btn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-loading');
  }

  try {
    const result = await get(`/activity?limit=${ACTIVITY_LIMIT}`);
    const events = Array.isArray(result) ? result : [];
    renderActivityAnalytics(analyzeActivity(events));
  } catch (err) {
    const msg = err?.message || 'unknown error';
    setText('activity-analytics-updated', `Gagal load analytics: ${msg}`);
    showToast('Gagal memuat activity analytics', 'error');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-loading');
    }
  }
}

function initActivityAnalytics() {
  const refreshBtn = document.getElementById('refresh-activity-analytics-btn');
  const funnel = document.getElementById('activity-funnel-list');
  if (!refreshBtn || !funnel) return;

  refreshBtn.addEventListener('click', () => {
    refreshActivityAnalytics()
      .then(() => refreshChatMetrics())
      .catch(() => {});
  });

  refreshActivityAnalytics().catch(() => {});
  refreshChatMetrics().catch(() => {});
}

function normalizeLmsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_LMS_URL;
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('invalid protocol');
  }
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

function initLmsSettings() {
  const input = document.getElementById('lms-url-input');
  const saveBtn = document.getElementById('save-lms-btn');
  const openBtn = document.getElementById('open-lms-settings-btn');
  if (!input || !saveBtn || !openBtn) return;

  const current = localStorage.getItem(LMS_URL_KEY) || DEFAULT_LMS_URL;
  input.value = current;

  saveBtn.addEventListener('click', () => {
    try {
      const normalized = normalizeLmsUrl(input.value || DEFAULT_LMS_URL);
      localStorage.setItem(LMS_URL_KEY, normalized);
      input.value = normalized;
      showToast('URL LMS tersimpan', 'success');
    } catch {
      showToast('URL LMS tidak valid', 'error');
    }
  });

  openBtn.addEventListener('click', () => {
    try {
      const url = normalizeLmsUrl(input.value || DEFAULT_LMS_URL);
      openLmsUrl(url);
    } catch {
      showToast('URL LMS tidak valid', 'error');
    }
  });
}

function monthLabel(monthNum = 8) {
  const idx = Math.max(1, Math.min(12, Number(monthNum || 8))) - 1;
  return SEMESTER_MONTH_LABELS[idx] || SEMESTER_MONTH_LABELS[7];
}

function renderSemesterPreview(el, payload = null) {
  if (!el) return;
  if (!payload) {
    el.textContent = 'Semester aktif belum tersedia.';
    return;
  }
  const month = Number(payload.academic_year_start_month || 8);
  const semesterLabel = String(payload.current_semester_label || '-');
  el.textContent = `Mulai tahun ajaran: ${monthLabel(month)} | Semester aktif: ${semesterLabel}`;
}

function initSemesterArchiveSettings() {
  const select = document.getElementById('semester-start-month-select');
  const saveBtn = document.getElementById('save-semester-settings-btn');
  const preview = document.getElementById('semester-current-preview');
  if (!select || !saveBtn || !preview) return;

  const loadConfig = async () => {
    try {
      const payload = await get('/academic_semester');
      const month = Number(payload?.academic_year_start_month || 8);
      select.value = String(month);
      renderSemesterPreview(preview, payload);
    } catch {
      select.value = '8';
      renderSemesterPreview(preview, {
        academic_year_start_month: 8,
        current_semester_label: '-',
      });
    }
  };

  saveBtn.addEventListener('click', async () => {
    const month = Number(select.value || 8);
    if (!Number.isFinite(month) || month < 1 || month > 12) {
      showToast('Bulan semester tidak valid.', 'error');
      return;
    }
    try {
      const payload = await put('/academic_semester', {
        academic_year_start_month: month,
      });
      renderSemesterPreview(preview, payload);
      showToast('Pengaturan semester berhasil disimpan.', 'success');
    } catch {
      showToast('Gagal menyimpan pengaturan semester.', 'error');
    }
  });

  loadConfig().catch(() => {});
}

function initThemeAndPerformance() {
  const current = localStorage.getItem('theme') || 'dark';
  const themeSelect = document.querySelector('#theme-select');
  if (themeSelect) {
    themeSelect.value = current;
    themeSelect.addEventListener('change', (e) => setTheme(e.target.value));
  }

  const perfSelect = document.querySelector('#performance-select');
  const perfNote = document.querySelector('#performance-note');
  const modeLabel = (pref) => {
    if (pref === 'lite') return 'Battery Saver';
    if (pref === 'full') return 'Max Visual';
    return 'Auto';
  };
  const syncPerfUI = (state) => {
    const resolved = state || (window.getPerformanceModeState
      ? window.getPerformanceModeState()
      : { pref: 'auto', lite: false });
    if (perfSelect) perfSelect.value = resolved.pref;
    if (perfNote) perfNote.textContent = `Mode: ${modeLabel(resolved.pref)} - Active: ${resolved.lite ? 'Lite' : 'Full'}`;
  };

  syncPerfUI();
  perfSelect?.addEventListener('change', (e) => {
    const pref = e.target.value;
    if (window.setPerformanceMode) {
      const state = window.setPerformanceMode(pref);
      syncPerfUI(state);
      showToast(`Performance set to ${modeLabel(pref)}`, 'success');
    } else {
      showToast('Performance mode engine unavailable', 'error');
    }
  });
  document.addEventListener('performance-mode-changed', (e) => syncPerfUI(e.detail));
}

function initInstallButton() {
  const installBtn = document.getElementById('install-btn');
  if (!installBtn) return;

  const showInstallBtn = () => {
    if (window.deferredPrompt) {
      installBtn.style.display = 'block';
    }
  };

  showInstallBtn();
  document.addEventListener('pwa-installable', showInstallBtn);

  installBtn.addEventListener('click', async () => {
    if (!window.deferredPrompt) {
      showToast('Installation not available', 'error');
      return;
    }

    const originalText = installBtn.innerHTML;
    installBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Installing...';
    installBtn.disabled = true;

    try {
      window.deferredPrompt.prompt();
      const { outcome } = await window.deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        installBtn.style.display = 'none';
        showToast('App installed successfully!', 'success');
      } else {
        showToast('Installation cancelled', 'info');
      }
    } catch (err) {
      console.error('Install prompt failed:', err);
      showToast('Installation failed. Try from browser menu.', 'error');
    } finally {
      window.deferredPrompt = null;
      installBtn.innerHTML = originalText;
      installBtn.disabled = false;
    }
  });
}

function init() {
  initProtected();
  initThemeAndPerformance();
  document.querySelector('#logout-btn')?.addEventListener('click', logout);
  initLmsSettings();
  initSemesterArchiveSettings();
  initActivityAnalytics();
  initInstallButton();
}

document.addEventListener('DOMContentLoaded', init);
