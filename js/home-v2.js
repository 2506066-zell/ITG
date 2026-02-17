import { initProtected, showToast } from './main.js';
import { get, post } from './api.js';

const USERS = ['Zaldy', 'Nesya'];
const DASH_CACHE_KEY = 'cc_dashboard_snapshot_v1';
const DASH_CACHE_TTL_MS = 10 * 60 * 1000;
const ASSISTANT_REFRESH_MS = 5 * 60 * 1000;
const POLL_DEFAULT_MS = 60 * 1000;
const POLL_SLOW_MS = 2 * 60 * 1000;
const POLL_HIDDEN_MS = 5 * 60 * 1000;

const state = {
  tasks: [],
  assignments: [],
  weekly: null,
  assistant: null,
  proactive: null,
  lastUpdated: null,
};

let dashboardLoadInFlight = null;
let dashboardPollTimer = null;
let lastAssistantFetchAt = 0;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function readCachedDashboardSnapshot() {
  try {
    const raw = localStorage.getItem(DASH_CACHE_KEY);
    if (!raw) return null;
    const parsed = safeJsonParse(raw, null);
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.saved_at || Date.now() - Number(parsed.saved_at) > DASH_CACHE_TTL_MS) return null;
    return parsed.snapshot || null;
  } catch {
    return null;
  }
}

function writeCachedDashboardSnapshot(snapshot) {
  try {
    localStorage.setItem(
      DASH_CACHE_KEY,
      JSON.stringify({
        saved_at: Date.now(),
        snapshot,
      })
    );
  } catch {}
}

function applyDashboardSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  state.tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  state.assignments = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  state.weekly = snapshot.weekly && typeof snapshot.weekly === 'object' ? snapshot.weekly : null;
  state.proactive = snapshot.proactive && typeof snapshot.proactive === 'object' ? snapshot.proactive : null;
  state.assistant = snapshot.assistant && typeof snapshot.assistant === 'object' ? snapshot.assistant : null;
  state.lastUpdated = snapshot.lastUpdated ? new Date(snapshot.lastUpdated) : new Date();
  if (Number.isFinite(Number(snapshot.assistantFetchedAt))) {
    lastAssistantFetchAt = Number(snapshot.assistantFetchedAt);
  }
  return true;
}

function snapshotFromState() {
  return {
    tasks: state.tasks,
    assignments: state.assignments,
    weekly: state.weekly,
    proactive: state.proactive,
    assistant: state.assistant,
    lastUpdated: state.lastUpdated ? state.lastUpdated.toISOString() : new Date().toISOString(),
    assistantFetchedAt: lastAssistantFetchAt,
  };
}

function isConstrainedConnection() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return false;
  const type = String(c.effectiveType || '').toLowerCase();
  return Boolean(c.saveData) || type === 'slow-2g' || type === '2g' || type === '3g';
}

function nextPollIntervalMs() {
  if (document.hidden) return POLL_HIDDEN_MS;
  if (isConstrainedConnection()) return POLL_SLOW_MS;
  return POLL_DEFAULT_MS;
}

function nowLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dayStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function isToday(isoDate) {
  if (!isoDate) return false;
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) return false;
  const start = dayStart(new Date());
  return d.getTime() >= start && d.getTime() < start + 24 * 60 * 60 * 1000;
}

function dueMeta(deadline) {
  if (!deadline) return { dueMs: Number.POSITIVE_INFINITY, badge: 'No deadline', urgency: 'good' };
  const due = new Date(deadline).getTime();
  if (!Number.isFinite(due)) return { dueMs: Number.POSITIVE_INFINITY, badge: 'No deadline', urgency: 'good' };

  const diffMin = Math.round((due - Date.now()) / 60000);
  if (diffMin <= 0) return { dueMs: due, badge: 'Overdue', urgency: 'critical' };
  if (diffMin <= 180) return { dueMs: due, badge: '<3h', urgency: 'critical' };
  if (diffMin <= 720) return { dueMs: due, badge: '<12h', urgency: 'warning' };
  if (diffMin <= 1440) return { dueMs: due, badge: 'Today', urgency: 'warning' };
  return { dueMs: due, badge: `${Math.ceil(diffMin / 1440)}d`, urgency: 'good' };
}

function collectMissionItems() {
  const pendingTasks = (state.tasks || []).filter((t) => !t.completed && !t.is_deleted).map((t) => ({
    type: 'Task',
    icon: 'fa-list-check',
    title: t.title,
    priority: t.priority || 'medium',
    deadline: t.deadline,
    assigned_to: t.assigned_to || '',
  }));

  const pendingAssignments = (state.assignments || []).filter((a) => !a.completed).map((a) => ({
    type: 'Assignment',
    icon: 'fa-graduation-cap',
    title: a.title,
    priority: 'medium',
    deadline: a.deadline,
    assigned_to: a.assigned_to || '',
  }));

  return [...pendingTasks, ...pendingAssignments]
    .map((item) => ({ ...item, ...dueMeta(item.deadline) }))
    .sort((a, b) => a.dueMs - b.dueMs);
}

function animateWidth(el, targetPct) {
  if (!el) return;
  const pct = Math.max(0, Math.min(100, targetPct));
  if (document.body.classList.contains('no-anim')) {
    el.style.width = `${pct}%`;
    return;
  }
  el.style.width = '0%';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.width = `${pct}%`;
    });
  });
}

function renderTodayMission() {
  const list = document.getElementById('today-mission-list');
  if (!list) return;

  const items = collectMissionItems();
  const openCount = items.length;
  const urgentCount = items.filter((i) => i.urgency === 'critical' || i.urgency === 'warning').length;
  const completedToday =
    (state.tasks || []).filter((t) => t.completed && isToday(t.completed_at)).length +
    (state.assignments || []).filter((a) => a.completed && isToday(a.completed_at)).length;

  const scopedToday = items.filter((i) => isToday(i.deadline)).length;
  const denominator = Math.max(scopedToday + completedToday, 1);
  const progress = Math.round((completedToday / denominator) * 100);

  const openEl = document.getElementById('mission-open-count');
  const urgentEl = document.getElementById('mission-urgent-count');
  const doneEl = document.getElementById('mission-completed-count');
  const progressValEl = document.getElementById('today-progress-value');
  const progressFillEl = document.getElementById('today-progress-fill');

  if (openEl) openEl.textContent = String(openCount);
  if (urgentEl) urgentEl.textContent = String(urgentCount);
  if (doneEl) doneEl.textContent = String(completedToday);
  if (progressValEl) progressValEl.textContent = `${progress}%`;
  animateWidth(progressFillEl, progress);

  if (items.length === 0) {
    list.innerHTML = '<div class="cc-empty">Semua clear. Pakai waktu ini untuk recharge bareng.</div>';
    return;
  }

  const html = items.slice(0, 5).map((item) => {
    const subtitle = item.assigned_to ? `${item.type} - ${item.assigned_to}` : item.type;
    const safeTitle = escapeHtml(item.title || 'Untitled');
    const safeSub = escapeHtml(subtitle);
    return `
      <article class="cc-item ${item.urgency}">
        <div class="cc-item-icon"><i class="fa-solid ${item.icon}"></i></div>
        <div class="cc-item-main">
          <p class="cc-item-title">${safeTitle}</p>
          <p class="cc-item-sub">${safeSub}</p>
        </div>
        <span class="cc-item-badge">${escapeHtml(item.badge)}</span>
      </article>
    `;
  }).join('');

  list.innerHTML = html;
}

function renderCouplePulse() {
  const zMoodEl = document.getElementById('pulse-z-mood');
  const nMoodEl = document.getElementById('pulse-n-mood');
  const zActivityEl = document.getElementById('pulse-z-activity');
  const nActivityEl = document.getElementById('pulse-n-activity');
  const syncEl = document.getElementById('pulse-sync-badge');
  const zBarEl = document.getElementById('pulse-z-bar');
  const nBarEl = document.getElementById('pulse-n-bar');

  const usersData = (state.weekly && state.weekly.users) ? state.weekly.users : {};
  const z = usersData.Zaldy || { avg_mood: 0, total_activities: 0, correlation: null };
  const n = usersData.Nesya || { avg_mood: 0, total_activities: 0, correlation: null };

  if (zMoodEl) zMoodEl.textContent = Number(z.avg_mood || 0).toFixed(1);
  if (nMoodEl) nMoodEl.textContent = Number(n.avg_mood || 0).toFixed(1);
  if (zActivityEl) zActivityEl.textContent = String(z.total_activities || 0);
  if (nActivityEl) nActivityEl.textContent = String(n.total_activities || 0);

  const maxActivities = Math.max(1, Number(z.total_activities || 0), Number(n.total_activities || 0));
  animateWidth(zBarEl, Math.round((Number(z.total_activities || 0) / maxActivities) * 100));
  animateWidth(nBarEl, Math.round((Number(n.total_activities || 0) / maxActivities) * 100));

  const sync = state.weekly && state.weekly.combined ? state.weekly.combined.correlation : null;
  if (syncEl) {
    if (sync === null || sync === undefined) {
      syncEl.textContent = 'Sync --';
    } else {
      const pct = Math.round((Number(sync) + 1) * 50);
      syncEl.textContent = `Sync ${pct}%`;
    }
  }
}

function renderUrgentRadar() {
  const container = document.getElementById('urgent-radar-list');
  const countEl = document.getElementById('urgent-count');
  if (!container) return;

  const urgentItems = collectMissionItems().filter((i) => i.urgency === 'critical' || i.urgency === 'warning').slice(0, 6);
  if (countEl) countEl.textContent = `${urgentItems.length} item`;

  if (urgentItems.length === 0) {
    container.innerHTML = '<div class="cc-empty">Radar tenang. Tidak ada item kritis untuk 24 jam ke depan.</div>';
    return;
  }

  container.innerHTML = urgentItems.map((item) => `
    <article class="cc-item ${item.urgency}">
      <div class="cc-item-icon"><i class="fa-solid ${item.icon}"></i></div>
      <div class="cc-item-main">
        <p class="cc-item-title">${escapeHtml(item.title)}</p>
        <p class="cc-item-sub">${escapeHtml(item.type)}</p>
      </div>
      <span class="cc-item-badge">${escapeHtml(item.badge)}</span>
    </article>
  `).join('');
}

function buildAssistantFeedItems() {
  const feed = [];
  const missionItems = collectMissionItems();
  const urgentCount = missionItems.filter((i) => i.urgency === 'critical').length;
  const proactiveItems = state.proactive && Array.isArray(state.proactive.items) ? state.proactive.items : [];

  proactiveItems.slice(0, 3).forEach((item) => {
    const eventType = (item.event_type || '').toString();
    let tag = 'Proactive';
    if (eventType === 'morning_brief') tag = 'Morning Brief';
    if (eventType === 'urgent_radar') tag = 'Urgent Radar';
    if (eventType === 'mood_drop_alert') tag = 'Mood Alert';
    if (eventType === 'checkin_suggestion') tag = 'Check-In';
    feed.push({ tag, text: item.body || item.title || 'New proactive update.', at: item.created_at || null });
  });

  if (state.assistant && state.assistant.reply) {
    feed.push({ tag: 'AI Brief', text: state.assistant.reply, at: null });
  }

  if (urgentCount > 0) {
    feed.push({ tag: 'Focus', text: `Ada ${urgentCount} item kritis. Ambil satu item paling atas lalu sprint 25 menit sekarang.`, at: null });
  }

  const usersData = state.weekly && state.weekly.users ? state.weekly.users : {};
  USERS.forEach((u) => {
    const mood = Number((usersData[u] && usersData[u].avg_mood) || 0);
    if (mood > 0 && mood < 3) {
      feed.push({ tag: 'Support', text: `${u} lagi drop. Switch ke task ringan dan kirim check-in singkat di chat.`, at: null });
    }
  });

  const upcoming = missionItems.filter((i) => i.badge === 'Today' || i.badge === '<12h').length;
  if (upcoming > 2) {
    feed.push({ tag: 'Execution', text: 'Gunakan pola 1-1-1: 1 tugas besar, 1 tugas menengah, 1 quick win.', at: null });
  }

  const proactiveUrgent = Number(state.proactive && state.proactive.signals ? state.proactive.signals.urgent_count : 0);
  if (proactiveUrgent > 0) {
    feed.push({
      tag: 'Radar',
      text: `Proactive Engine mendeteksi ${proactiveUrgent} item due <2 jam. Reprioritize sekarang.`,
      at: null,
    });
  }

  if (feed.length === 0) {
    feed.push({ tag: 'Calm Mode', text: 'Sistem stabil. Pakai momentum ini buat progress goals jangka panjang.', at: null });
  }

  return feed.slice(0, 5);
}

function renderAssistantFeed() {
  const container = document.getElementById('assistant-feed-list');
  if (!container) return;

  const items = buildAssistantFeedItems();
  container.innerHTML = items.map((item) => `
    <article class="cc-feed-item">
      <div class="cc-feed-head">
        <span>${escapeHtml(item.tag)}</span>
        <span>${escapeHtml(item.at ? nowLabel(new Date(item.at)) : nowLabel())}</span>
      </div>
      <p class="cc-feed-text">${escapeHtml(item.text)}</p>
    </article>
  `).join('');
}

function renderUpdatedTimestamp() {
  const el = document.getElementById('cc-updated-at');
  if (!el || !state.lastUpdated) return;
  el.textContent = `Updated ${nowLabel(state.lastUpdated)}`;
}

function renderAll() {
  renderTodayMission();
  renderCouplePulse();
  renderUrgentRadar();
  renderAssistantFeed();
  renderUpdatedTimestamp();
}

function applyRevealMotion() {
  const cards = [...document.querySelectorAll('.cc-reveal')];
  if (!cards.length) return;
  if (document.body.classList.contains('no-anim')) {
    revealCardsImmediately();
    return;
  }
  document.body.classList.add('cc-motion-ready');
  cards.forEach((el, idx) => {
    el.style.setProperty('--reveal-delay', `${idx * 90}ms`);
    requestAnimationFrame(() => {
      el.classList.add('is-visible');
    });
  });
}

function revealCardsImmediately() {
  const cards = [...document.querySelectorAll('.cc-reveal')];
  cards.forEach((el) => {
    el.classList.add('is-visible');
    el.style.opacity = '1';
    el.style.transform = 'none';
  });
}

function renderHeaderMeta() {
  const user = localStorage.getItem('user') || 'NZ';
  const greetingEl = document.getElementById('cc-greeting');
  const dateEl = document.getElementById('cc-date');
  const now = new Date();
  const hour = now.getHours();
  let greet = 'Good Morning';
  if (hour >= 12 && hour < 17) greet = 'Good Afternoon';
  if (hour >= 17 || hour < 4) greet = 'Good Evening';

  if (greetingEl) greetingEl.textContent = `${greet}, ${user}`;
  if (dateEl) {
    dateEl.textContent = now.toLocaleDateString([], {
      weekday: 'long',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
}

async function loadDashboardData({ silent = false, includeAssistant = true, forceAssistant = false } = {}) {
  if (dashboardLoadInFlight) return dashboardLoadInFlight;

  const now = Date.now();
  const shouldFetchAssistant =
    includeAssistant &&
    (forceAssistant || !state.assistant || now - lastAssistantFetchAt >= ASSISTANT_REFRESH_MS);

  dashboardLoadInFlight = (async () => {
    const requests = await Promise.allSettled([
      get('/tasks'),
      get('/assignments'),
      get('/weekly'),
      get('/proactive?limit=12'),
      shouldFetchAssistant ? post('/assistant', { message: 'ringkasan hari ini' }) : Promise.resolve(state.assistant),
    ]);

    const [tasksRes, assignmentsRes, weeklyRes, proactiveRes, assistantRes] = requests;

    state.tasks = tasksRes.status === 'fulfilled' && Array.isArray(tasksRes.value) ? tasksRes.value : [];
    state.assignments = assignmentsRes.status === 'fulfilled' && Array.isArray(assignmentsRes.value) ? assignmentsRes.value : [];
    state.weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
    state.proactive = proactiveRes.status === 'fulfilled' ? proactiveRes.value : null;

    if (assistantRes.status === 'fulfilled' && assistantRes.value) {
      state.assistant = assistantRes.value;
      if (shouldFetchAssistant) lastAssistantFetchAt = now;
    }

    state.lastUpdated = new Date();
    renderAll();
    writeCachedDashboardSnapshot(snapshotFromState());

    if (!silent && requests.some((r) => r.status === 'rejected')) {
      showToast('Sebagian data belum sinkron. Menampilkan data yang tersedia.', 'error', 3000);
    }
  })();

  try {
    await dashboardLoadInFlight;
  } finally {
    dashboardLoadInFlight = null;
  }
}

function initActions() {
  const refreshBtn = document.getElementById('assistant-refresh');
  if (!refreshBtn) return;

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await loadDashboardData({ silent: false, includeAssistant: true, forceAssistant: true });
      showToast('Command Center diperbarui.', 'success', 2000);
    } finally {
      refreshBtn.disabled = false;
    }
  });
}

function stopDashboardPolling() {
  if (dashboardPollTimer) {
    clearTimeout(dashboardPollTimer);
    dashboardPollTimer = null;
  }
}

function scheduleDashboardPolling() {
  stopDashboardPolling();
  dashboardPollTimer = setTimeout(async () => {
    try {
      if (!document.hidden) {
        await loadDashboardData({ silent: true, includeAssistant: false });
      }
    } catch {
      revealCardsImmediately();
    } finally {
      scheduleDashboardPolling();
    }
  }, nextPollIntervalMs());
}

function handleVisibilitySync() {
  if (!document.hidden) {
    loadDashboardData({ silent: true, includeAssistant: false }).catch(() => {});
  }
  scheduleDashboardPolling();
}

async function init() {
  try {
    initProtected();
  } catch (err) {
    console.error('initProtected failed:', err);
  }

  renderHeaderMeta();
  applyRevealMotion();
  initActions();

  const cached = readCachedDashboardSnapshot();
  if (applyDashboardSnapshot(cached)) {
    renderAll();
  }

  try {
    await loadDashboardData({ silent: false, includeAssistant: true, forceAssistant: true });
  } catch (err) {
    console.error('Dashboard init load failed:', err);
    revealCardsImmediately();
  }

  scheduleDashboardPolling();
  document.addEventListener('visibilitychange', handleVisibilitySync, { passive: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
