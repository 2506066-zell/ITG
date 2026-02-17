import { initProtected } from './main.js';
import { get } from './api.js';

const POLL_MS = 60 * 1000;
let pollTimer = null;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function nowLabel(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function dueMeta(deadline) {
  if (!deadline) return { dueMs: Number.POSITIVE_INFINITY, badge: 'No deadline', urgency: 'good' };
  const due = new Date(deadline).getTime();
  if (!Number.isFinite(due)) return { dueMs: Number.POSITIVE_INFINITY, badge: 'No deadline', urgency: 'good' };
  const diffMin = Math.round((due - Date.now()) / 60000);
  if (diffMin <= 0) return { dueMs: due, badge: 'Overdue', urgency: 'critical' };
  if (diffMin <= 180) return { dueMs: due, badge: '<3h', urgency: 'critical' };
  if (diffMin <= 1440) return { dueMs: due, badge: '<24h', urgency: 'warning' };
  return { dueMs: due, badge: `${Math.ceil(diffMin / 1440)}d`, urgency: 'good' };
}

function formatDeadline(iso) {
  if (!iso) return 'No deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No deadline';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderStats(items = []) {
  const pendingEl = document.getElementById('widget-pending-count');
  const urgentEl = document.getElementById('widget-urgent-count');
  const overdueEl = document.getElementById('widget-overdue-count');
  if (!pendingEl || !urgentEl || !overdueEl) return;

  const pending = items.length;
  const urgent = items.filter((x) => x.urgency === 'critical' || x.urgency === 'warning').length;
  const overdue = items.filter((x) => x.badge === 'Overdue').length;

  pendingEl.textContent = String(pending);
  urgentEl.textContent = String(urgent);
  overdueEl.textContent = String(overdue);

  if ('setAppBadge' in navigator) {
    if (urgent > 0) navigator.setAppBadge(Math.min(urgent, 99)).catch(() => {});
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
  }
}

function renderList(items = []) {
  const list = document.getElementById('widget-assignment-list');
  if (!list) return;

  if (!items.length) {
    list.innerHTML = '<div class="widget-empty">Tidak ada assignment pending. Nice, tetap konsisten.</div>';
    return;
  }

  list.innerHTML = items.slice(0, 6).map((item) => `
    <article class="widget-item ${escapeHtml(item.urgency)}">
      <div class="widget-item-head">
        <p class="widget-item-title">${escapeHtml(item.title || 'Untitled')}</p>
        <span class="widget-item-badge">${escapeHtml(item.badge)}</span>
      </div>
      <p class="widget-item-sub">${escapeHtml(formatDeadline(item.deadline))}</p>
    </article>
  `).join('');
}

function renderUpdated() {
  const el = document.getElementById('widget-updated-at');
  if (!el) return;
  el.textContent = `Updated ${nowLabel()}`;
}

async function loadWidgetAssignments() {
  const rows = await get('/assignments');
  const items = Array.isArray(rows)
    ? rows.filter((a) => !a.completed).map((a) => ({ ...a, ...dueMeta(a.deadline) }))
      .sort((a, b) => a.dueMs - b.dueMs)
    : [];
  renderStats(items);
  renderList(items);
  renderUpdated();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      if (!document.hidden) {
        await loadWidgetAssignments();
      }
    } finally {
      schedulePoll();
    }
  }, POLL_MS);
}

function initActions() {
  const refreshBtn = document.getElementById('widget-refresh-btn');
  if (!refreshBtn) return;
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      await loadWidgetAssignments();
    } finally {
      refreshBtn.disabled = false;
    }
  });
}

async function init() {
  try {
    initProtected();
  } catch {}

  initActions();
  await loadWidgetAssignments();
  schedulePoll();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadWidgetAssignments().catch(() => {});
  }, { passive: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
