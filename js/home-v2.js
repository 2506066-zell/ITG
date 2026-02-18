import { initProtected, showToast } from './main.js';
import { get, post } from './api.js';

const USERS = ['Zaldy', 'Nesya'];
const DASH_CACHE_KEY = 'cc_dashboard_snapshot_v1';
const DASH_CACHE_TTL_MS = 10 * 60 * 1000;
const ASSISTANT_REFRESH_MS = 5 * 60 * 1000;
const POLL_DEFAULT_MS = 60 * 1000;
const POLL_SLOW_MS = 2 * 60 * 1000;
const POLL_HIDDEN_MS = 5 * 60 * 1000;
const STUDY_TARGET_KEY = 'study_plan_target_min_v1';
const TASK_REMINDER_SNOOZE_KEY = 'cc_task_reminder_snooze_until_v1';
const TASK_REMINDER_DISMISS_DAY_KEY = 'cc_task_reminder_dismiss_day_v1';
const TASK_REMINDER_SNOOZE_MS = 60 * 60 * 1000;
const DAY_LABEL_ID = {
  1: 'Senin',
  2: 'Selasa',
  3: 'Rabu',
  4: 'Kamis',
  5: 'Jumat',
  6: 'Sabtu',
  7: 'Minggu',
};

const state = {
  tasks: [],
  assignments: [],
  schedule: [],
  weekly: null,
  assistant: null,
  proactive: null,
  studyPlan: null,
  lastUpdated: null,
};

let dashboardLoadInFlight = null;
let dashboardPollTimer = null;
let lastAssistantFetchAt = 0;
let currentReminderItem = null;
let currentZaiFloatPayload = null;

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeExplainability(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? raw : null;
}

function explainabilityText(explainability) {
  const ex = normalizeExplainability(explainability);
  if (!ex) return '';
  const chunks = [];
  const whyItems = Array.isArray(ex.why) ? ex.why.filter(Boolean) : [];
  if (whyItems.length) chunks.push(`Z AI lihat: ${whyItems[0]}`);
  if (ex.impact) chunks.push(`Kalau dieksekusi sekarang: ${ex.impact}`);
  if (ex.risk) chunks.push(`Catatan Z AI: ${ex.risk}`);
  return chunks.join('\n');
}

function proactiveExplainability(item) {
  const eventType = String(item?.event_type || '');
  const payload = normalizeExplainability(item?.payload) || {};

  if (eventType === 'urgent_radar' || eventType.startsWith('urgent_radar_')) {
    const minutesLeft = Number(payload.minutes_left);
    return {
      why: [Number.isFinite(minutesLeft) ? `Deadline tinggal ${minutesLeft} menit.` : 'Deadline item sangat dekat.'],
      impact: 'Eksekusi sekarang mencegah keterlambatan langsung pada item kritis.',
      risk: Number.isFinite(minutesLeft) && minutesLeft <= 0
        ? 'Item sudah overdue.'
        : 'Jika ditunda, risiko telat meningkat signifikan.',
    };
  }

  if (eventType.startsWith('predictive_risk_')) {
    const riskBand = String(payload.risk_band || '').toLowerCase() || eventType.replace('predictive_risk_', '');
    const riskScore = Number(payload.risk_score || 0);
    const hoursLeft = Number(payload.hours_left || 0);
    return {
      why: [riskScore > 0 ? `Model prediktif memberi skor ${riskScore} (${riskBand}).` : `Item terdeteksi berisiko ${riskBand}.`],
      impact: 'Kamu bisa replan lebih awal sebelum masuk zona urgent.',
      risk: Number.isFinite(hoursLeft) && hoursLeft > 0
        ? `Tanpa eksekusi dini, item ini bisa jadi kritis dalam ~${Math.max(1, Math.round(hoursLeft))} jam.`
        : 'Risiko deadline meningkat jika ditunda.',
    };
  }

  if (eventType === 'mood_drop_alert' || eventType === 'mood_drop_self') {
    const recent = Number(payload.recent_avg || 0);
    const prev = Number(payload.prev_avg || 0);
    return {
      why: [prev > 0 ? `Rerata mood turun dari ${prev.toFixed(1)} ke ${recent.toFixed(1)}.` : `Rerata mood terbaru ${recent.toFixed(1)}.`],
      impact: 'Intervensi ringan sekarang bantu menjaga performa tanpa memaksa energi.',
      risk: 'Tanpa penyesuaian, risiko burnout dan miss deadline meningkat.',
    };
  }

  if (eventType === 'checkin_suggestion') {
    const gap = Number(payload.gap_hours || 0);
    return {
      why: [gap > 0 ? `Sudah sekitar ${Math.floor(gap)} jam tanpa check-in.` : 'Ritme check-in menurun.'],
      impact: 'Sync singkat membantu distribusi beban couple lebih seimbang.',
      risk: 'Miskomunikasi dapat menaikkan friksi dan menurunkan produktivitas.',
    };
  }

  if (eventType === 'predictive_support_ping') {
    const target = String(payload.target || 'partner');
    return {
      why: [`Sistem mendeteksi ${target} butuh support untuk item berisiko tinggi.`],
      impact: 'Intervensi lebih awal membantu mencegah eskalasi ke overdue.',
      risk: 'Tanpa support/check-in, risiko miss deadline meningkat.',
    };
  }

  if (eventType === 'morning_brief') {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
    const assignments = Array.isArray(payload.assignments) ? payload.assignments.length : 0;
    const classes = Array.isArray(payload.classes) ? payload.classes.length : 0;
    return {
      why: [`Brief pagi menghitung ${tasks} task, ${assignments} assignment, ${classes} kelas.`],
      impact: 'Rencana lebih jelas dari pagi menurunkan context switching seharian.',
      risk: 'Tanpa prioritas awal, backlog mudah menumpuk di malam hari.',
    };
  }

  return null;
}

function mergeFeedTextWithExplain(baseText, explainability) {
  const explain = explainabilityText(explainability);
  if (!explain) return baseText;
  return `${baseText}\n${explain}`;
}

function dedupeEvidenceChips(chips = []) {
  const seen = new Set();
  const out = [];
  for (const chip of chips) {
    if (!chip || !chip.label) continue;
    const tone = chip.tone || 'info';
    const key = `${chip.label}::${tone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: String(chip.label), tone, command: chip.command || '' });
  }
  return out.slice(0, 5);
}

function normalizeChipCommand(raw = '') {
  const cmd = String(raw || '').trim();
  if (!cmd) return '';
  if (/^\/confirm$/i.test(cmd)) return '/confirm';
  return cmd;
}

function openChatWithCommand(command = '') {
  const clean = normalizeChipCommand(command);
  if (!clean) return;
  window.location.href = `/chat?ai=${encodeURIComponent(clean)}`;
}

function encodeChipCommand(command = '') {
  return encodeURIComponent(String(command || ''));
}

function decodeChipCommand(raw = '') {
  try {
    return decodeURIComponent(String(raw || ''));
  } catch {
    return '';
  }
}

function summarizeDeadlineRisk(items = []) {
  let overdue = 0;
  let due24h = 0;
  for (const item of items) {
    if (!item || !item.deadline) continue;
    const due = new Date(item.deadline).getTime();
    if (!Number.isFinite(due)) continue;
    const hours = (due - Date.now()) / 3600000;
    if (hours <= 0) overdue += 1;
    else if (hours <= 24) due24h += 1;
  }
  return { overdue, due24h };
}

function confidenceTone(level = '') {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'high') return 'success';
  if (normalized === 'low') return 'warning';
  return 'info';
}

function buildAssistantEvidenceChips(payload) {
  const chips = [];
  const tool = String(payload?.tool || '');
  const data = payload?.data || {};
  const explain = normalizeExplainability(payload?.explainability) || {};

  if (tool === 'get_daily_brief') {
    const taskCount = Array.isArray(data.tasks) ? data.tasks.length : 0;
    const assignmentCount = Array.isArray(data.assignments) ? data.assignments.length : 0;
    chips.push({ label: `Task ${taskCount}`, tone: 'info', command: 'task pending saya apa' });
    chips.push({ label: `Assignment ${assignmentCount}`, tone: 'info', command: 'assignment pending saya apa' });
  }

  if (tool === 'get_tasks' || tool === 'get_assignments') {
    const items = Array.isArray(data.items) ? data.items : [];
    const risk = summarizeDeadlineRisk(items);
    if (risk.overdue > 0) chips.push({ label: `${risk.overdue} Overdue`, tone: 'critical', command: 'task urgent saya apa' });
    else if (risk.due24h > 0) chips.push({ label: `${risk.due24h} Due <24h`, tone: 'warning', command: 'task urgent saya apa' });
    if (items.length > 0) chips.push({
      label: `${items.length} Pending`,
      tone: 'info',
      command: tool === 'get_tasks' ? 'task pending saya apa' : 'assignment pending saya apa',
    });
  }

  if (tool === 'get_unified_memory') {
    const counters = data.counters || {};
    const streak = data.streak || {};
    const urgent = Number(counters.urgent_items || 0);
    const streakDays = Number(streak.current_days || 0);
    if (urgent > 0) chips.push({ label: `Urgent ${urgent}`, tone: 'critical', command: 'task urgent saya apa' });
    if (streakDays > 0) chips.push({ label: `Streak ${streakDays}d`, tone: 'success', command: 'jadwal belajar besok pagi' });
  }

  if (tool === 'get_study_plan') {
    const summary = data.summary || {};
    const criticalSessions = Number(summary.critical_sessions || 0);
    const sessions = Number(summary.sessions || 0);
    if (sessions > 0) chips.push({ label: `${sessions} Sessions`, tone: 'info', command: 'jadwal belajar besok pagi' });
    if (criticalSessions > 0) chips.push({ label: `${criticalSessions} Critical`, tone: 'warning', command: 'geser sesi belajar ke besok pagi' });
  }

  if (explain.confidence) {
    chips.push({
      label: `Z AI ${String(explain.confidence).toUpperCase()}`,
      tone: confidenceTone(explain.confidence),
      command: 'tampilkan memory hari ini',
    });
  }

  return dedupeEvidenceChips(chips);
}

function buildProactiveEvidenceChips(item) {
  const chips = [];
  const eventType = String(item?.event_type || '');
  const payload = normalizeExplainability(item?.payload) || {};

  if (eventType === 'urgent_radar' || eventType.startsWith('urgent_radar_')) {
    const minutesLeft = Number(payload.minutes_left);
    if (Number.isFinite(minutesLeft)) {
      chips.push({
        label: minutesLeft <= 0 ? 'Overdue' : `Due ${minutesLeft}m`,
        tone: minutesLeft <= 0 ? 'critical' : 'warning',
        command: payload.source === 'assignment' ? 'assignment pending saya apa' : 'task urgent saya apa',
      });
    }
  }

  if (eventType.startsWith('predictive_risk_')) {
    const band = String(payload.risk_band || '').toLowerCase() || eventType.replace('predictive_risk_', '');
    const score = Number(payload.risk_score || 0);
    chips.push({
      label: `Predictive ${band}`,
      tone: band === 'critical' ? 'critical' : 'warning',
      command: 'risk deadline 48 jam ke depan',
    });
    if (score > 0) {
      chips.push({
        label: `Score ${score}`,
        tone: band === 'critical' ? 'critical' : 'warning',
        command: 'risk deadline 48 jam ke depan',
      });
    }
  }

  if (eventType === 'mood_drop_alert' || eventType === 'mood_drop_self') {
    const recent = Number(payload.recent_avg || 0);
    if (recent > 0) chips.push({ label: `Mood ${recent.toFixed(1)}`, tone: 'warning', command: 'kasih ide check-in singkat malam ini' });
  }

  if (eventType === 'checkin_suggestion') {
    const gap = Number(payload.gap_hours || 0);
    if (gap > 0) chips.push({ label: `No Check-In ${Math.floor(gap)}h`, tone: 'warning', command: 'bantu buat pesan check-in pasangan sekarang' });
  }

  if (eventType === 'predictive_support_ping') {
    chips.push({ label: 'Support Needed', tone: 'warning', command: 'ingatkan pasangan check-in malam ini' });
  }

  if (eventType === 'morning_brief') {
    const taskCount = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
    const assignmentCount = Array.isArray(payload.assignments) ? payload.assignments.length : 0;
    chips.push({ label: `Task ${taskCount}`, tone: 'info', command: 'task pending saya apa' });
    chips.push({ label: `Assignment ${assignmentCount}`, tone: 'info', command: 'assignment pending saya apa' });
  }

  return dedupeEvidenceChips(chips);
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
  state.schedule = Array.isArray(snapshot.schedule) ? snapshot.schedule : [];
  state.weekly = snapshot.weekly && typeof snapshot.weekly === 'object' ? snapshot.weekly : null;
  state.proactive = snapshot.proactive && typeof snapshot.proactive === 'object' ? snapshot.proactive : null;
  state.assistant = snapshot.assistant && typeof snapshot.assistant === 'object' ? snapshot.assistant : null;
  state.studyPlan = snapshot.studyPlan && typeof snapshot.studyPlan === 'object' ? snapshot.studyPlan : null;
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
    schedule: state.schedule,
    weekly: state.weekly,
    proactive: state.proactive,
    assistant: state.assistant,
    studyPlan: state.studyPlan,
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

function todayDateText(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayDayId(date = new Date()) {
  const d = date.getDay();
  return d === 0 ? 7 : d;
}

function asHmLabel(value = '') {
  const m = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!m) return '--:--';
  return `${m[1]}:${m[2]}`;
}

function hoursLeftLabel(dueMs = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(dueMs)) return '';
  const diffHours = (dueMs - Date.now()) / 3600000;
  if (diffHours <= 0) return 'sudah lewat deadline';
  if (diffHours < 1) return 'kurang dari 1 jam lagi';
  if (diffHours < 24) return `${Math.ceil(diffHours)} jam lagi`;
  return `${Math.ceil(diffHours / 24)} hari lagi`;
}

function reminderSuppressedNow() {
  try {
    const snoozeUntil = Number(localStorage.getItem(TASK_REMINDER_SNOOZE_KEY) || 0);
    if (Number.isFinite(snoozeUntil) && snoozeUntil > Date.now()) return true;
    const dismissedDay = localStorage.getItem(TASK_REMINDER_DISMISS_DAY_KEY) || '';
    return dismissedDay === todayDateText();
  } catch {
    return false;
  }
}

function getStudyTargetMinutes() {
  const raw = Number(localStorage.getItem(STUDY_TARGET_KEY) || 150);
  if (!Number.isFinite(raw)) return 150;
  return Math.max(90, Math.min(240, raw));
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

function todayClassItems() {
  const dayId = todayDayId();
  const rows = Array.isArray(state.schedule) ? state.schedule : [];
  return rows
    .filter((row) => Number(row?.day_id || 0) === dayId)
    .sort((a, b) => String(a?.time_start || '').localeCompare(String(b?.time_start || '')));
}

function reminderCandidate(items = []) {
  return items.find((item) => item && (item.urgency === 'critical' || item.urgency === 'warning')) || null;
}

function reminderRouteForItem(item) {
  if (!item) return '/daily-tasks';
  return item.type === 'Assignment' ? '/college-assignments' : '/daily-tasks';
}

function formatReminderSub(item) {
  if (!item) return 'Buka planner untuk cek prioritas terbaru.';
  if (item.badge === 'Overdue') return `${item.type} ini sudah lewat deadline. Tangani sekarang.`;
  if (item.badge === '<3h' || item.badge === '<12h') return `${item.type} ini due sangat dekat (${item.badge}).`;
  if (item.badge === 'Today') return `${item.type} ini jatuh tempo hari ini.`;
  return `${item.type} ini perlu progres hari ini.`;
}

function syncHomeScreenBadge(urgentCount) {
  try {
    const n = Number(urgentCount || 0);
    if ('setAppBadge' in navigator) {
      if (n > 0) {
        navigator.setAppBadge(Math.min(n, 99)).catch(() => {});
      } else if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }
    }
  } catch {}
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

function renderTaskReminderBanner() {
  const banner = document.getElementById('task-reminder-banner');
  const titleEl = document.getElementById('task-reminder-title');
  const subEl = document.getElementById('task-reminder-sub');
  if (!banner || !titleEl || !subEl) return;

  const items = collectMissionItems();
  const candidate = reminderCandidate(items);
  const urgentCount = items.filter((i) => i.urgency === 'critical' || i.urgency === 'warning').length;
  syncHomeScreenBadge(urgentCount);

  if (!candidate || reminderSuppressedNow()) {
    banner.hidden = true;
    currentReminderItem = null;
    return;
  }

  currentReminderItem = candidate;
  titleEl.textContent = `${candidate.type}: ${candidate.title || 'Untitled'}`;
  subEl.textContent = formatReminderSub(candidate);
  banner.hidden = false;
}

function buildZaIFloatingMessage() {
  const user = localStorage.getItem('user') || 'Kamu';
  const missionItems = collectMissionItems();
  const urgent = reminderCandidate(missionItems);
  const classesToday = todayClassItems();
  const proactiveSignals = state.proactive && state.proactive.signals ? state.proactive.signals : {};
  const overdueCount = Number(proactiveSignals.overdue_count || 0);
  const predictiveCritical = Number(proactiveSignals.predicted_critical_count || 0);

  if (urgent) {
    const danger = urgent.badge === 'Overdue'
      ? 'sudah melewati deadline'
      : `deadline ${hoursLeftLabel(urgent.dueMs)}`;
    return {
      tone: urgent.urgency === 'critical' ? 'critical' : 'warning',
      title: 'Z AI Reminder',
      message: `Hai ${user}, ${urgent.type.toLowerCase()} "${urgent.title || 'Untitled'}" ${danger}. Prioritaskan sekarang ya.`,
      primary: {
        label: urgent.type === 'Assignment' ? 'Buka Tugas Kuliah' : 'Buka Daily Task',
        route: reminderRouteForItem(urgent),
      },
      secondary: classesToday.length
        ? { label: 'Lihat Jadwal', route: '/schedule' }
        : { label: 'Buka Chat Z AI', route: '/chat?ai=rekomendasi%20task%20urgent%20saya' },
      pulse: true,
    };
  }

  if (classesToday.length > 0) {
    const first = classesToday[0];
    const firstStart = asHmLabel(first.time_start);
    const firstSubject = String(first.subject || 'kuliah').trim();
    const day = DAY_LABEL_ID[todayDayId()] || 'Hari ini';
    return {
      tone: 'info',
      title: 'Z AI Campus Brief',
      message: `Hai ${user}, ${day} ada ${classesToday.length} jadwal kuliah. Mulai ${firstStart} untuk ${firstSubject}.`,
      primary: { label: 'Buka Jadwal', route: '/schedule' },
      secondary: { label: 'Rencana Belajar', route: '/chat?ai=buatkan%20jadwal%20belajar%20di%20waktu%20kosong' },
      pulse: false,
    };
  }

  if (overdueCount > 0 || predictiveCritical > 0) {
    const risky = Math.max(overdueCount, predictiveCritical);
    return {
      tone: 'warning',
      title: 'Z AI Proactive',
      message: `Hai ${user}, ada ${risky} item berisiko tinggi. Cek radar sekarang supaya gak mepet deadline.`,
      primary: { label: 'Buka Urgent Radar', route: '/daily-tasks' },
      secondary: { label: 'Analisis Risiko', route: '/chat?ai=risk%20deadline%2048%20jam%20ke%20depan' },
      pulse: true,
    };
  }

  const pending = missionItems.length;
  if (pending > 0) {
    return {
      tone: 'info',
      title: 'Z AI Focus',
      message: `Hai ${user}, masih ada ${pending} item pending. Ambil 1 item dulu, sprint 25 menit, lalu update progres.`,
      primary: { label: 'Buka Prioritas', route: '/daily-tasks' },
      secondary: { label: 'Minta Rekomendasi', route: '/chat?ai=rekomendasi%20tugas%20kuliah' },
      pulse: false,
    };
  }

  return {
    tone: 'good',
    title: 'Z AI Calm Mode',
    message: `Hai ${user}, kondisi hari ini aman. Kamu bisa lanjut goals jangka panjangmu.`,
    primary: { label: 'Buka Goals', route: '/goals' },
    secondary: { label: 'Chat Z AI', route: '/chat?ai=ringkasan%20hari%20ini' },
    pulse: false,
  };
}

function renderZaIFloatingWidget() {
  const root = document.getElementById('zai-floating-widget');
  const panel = document.getElementById('zai-floating-panel');
  const toneEl = document.getElementById('zai-floating-tone');
  const msgEl = document.getElementById('zai-floating-message');
  const primaryBtn = document.getElementById('zai-floating-primary');
  const secondaryBtn = document.getElementById('zai-floating-secondary');
  const trigger = document.getElementById('zai-floating-trigger');
  if (!root || !panel || !toneEl || !msgEl || !primaryBtn || !secondaryBtn || !trigger) return;

  const payload = buildZaIFloatingMessage();
  currentZaiFloatPayload = payload;

  root.dataset.tone = String(payload.tone || 'info');
  root.classList.toggle('is-urgent', Boolean(payload.pulse));
  toneEl.textContent = payload.title || 'Z AI Reminder';
  msgEl.textContent = payload.message || 'Z AI siap bantu prioritas kamu.';

  primaryBtn.textContent = payload.primary?.label || 'Buka';
  primaryBtn.dataset.route = payload.primary?.route || '/chat';
  secondaryBtn.textContent = payload.secondary?.label || 'Chat';
  secondaryBtn.dataset.route = payload.secondary?.route || '/chat';

  const isOpen = panel.classList.contains('show');
  trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
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

function renderStudyMission() {
  const container = document.getElementById('study-mission-list');
  if (!container) return;

  const plan = state.studyPlan;
  const sessions = plan && Array.isArray(plan.sessions) ? plan.sessions : [];

  if (!sessions.length) {
    container.innerHTML = '<div class="cc-empty">Belum ada jadwal belajar hari ini. Buka Schedule untuk generate Smart Study Plan.</div>';
    return;
  }

  container.innerHTML = sessions.slice(0, 4).map((session) => {
    const urgency = (session.urgency || 'good').toLowerCase();
    const title = escapeHtml(session.title || 'Study Block');
    const reason = escapeHtml(session.reason || 'Progress session');
    const badge = `${escapeHtml(session.start || '--:--')}-${escapeHtml(session.end || '--:--')}`;
    return `
      <article class="cc-item ${urgency}">
        <div class="cc-item-icon"><i class="fa-solid fa-book-open-reader"></i></div>
        <div class="cc-item-main">
          <p class="cc-item-title">${title}</p>
          <p class="cc-item-sub">${reason}</p>
        </div>
        <span class="cc-item-badge">${badge}</span>
      </article>
    `;
  }).join('');
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
    if (eventType === 'urgent_radar' || eventType.startsWith('urgent_radar_')) tag = 'Urgent Radar';
    if (eventType.startsWith('predictive_risk_')) tag = 'Predictive Risk';
    if (eventType === 'predictive_support_ping') tag = 'Support Ping';
    if (eventType === 'mood_drop_alert' || eventType === 'mood_drop_self') tag = 'Mood Alert';
    if (eventType === 'checkin_suggestion') tag = 'Check-In';
    const base = item.body || item.title || 'New proactive update.';
    feed.push({
      tag,
      text: mergeFeedTextWithExplain(base, proactiveExplainability(item)),
      chips: buildProactiveEvidenceChips(item),
      at: item.created_at || null,
    });
  });

  if (state.assistant && state.assistant.reply) {
    feed.push({
      tag: 'Z AI Brief',
      text: mergeFeedTextWithExplain(state.assistant.reply, state.assistant.explainability),
      chips: buildAssistantEvidenceChips(state.assistant),
      at: null,
    });
  }

  if (urgentCount > 0) {
    feed.push({
      tag: 'Focus',
      text: `Ada ${urgentCount} item kritis. Ambil satu item paling atas lalu sprint 25 menit sekarang.`,
      chips: [{ label: `Critical ${urgentCount}`, tone: 'critical', command: 'task urgent saya apa' }],
      at: null,
    });
  }

  const usersData = state.weekly && state.weekly.users ? state.weekly.users : {};
  USERS.forEach((u) => {
    const mood = Number((usersData[u] && usersData[u].avg_mood) || 0);
    if (mood > 0 && mood < 3) {
      feed.push({
        tag: 'Support',
        text: `${u} lagi drop. Switch ke task ringan dan kirim check-in singkat di chat.`,
        chips: [{ label: `${u} Mood ${mood.toFixed(1)}`, tone: 'warning', command: 'buat pesan check-in support pasangan' }],
        at: null,
      });
    }
  });

  const upcoming = missionItems.filter((i) => i.badge === 'Today' || i.badge === '<12h').length;
  if (upcoming > 2) {
    feed.push({
      tag: 'Execution',
      text: 'Gunakan pola 1-1-1: 1 tugas besar, 1 tugas menengah, 1 quick win.',
      chips: [{ label: `Due Soon ${upcoming}`, tone: 'warning', command: 'task urgent saya apa' }],
      at: null,
    });
  }

  const proactiveSignals = state.proactive && state.proactive.signals ? state.proactive.signals : {};
  const proactiveUrgent = Number(proactiveSignals.urgent_count || 0);
  const proactiveCritical = Number(proactiveSignals.critical_count || 0);
  const proactiveOverdue = Number(proactiveSignals.overdue_count || 0);
  const predictiveHigh = Number(proactiveSignals.predicted_high_count || 0);
  const predictiveCritical = Number(proactiveSignals.predicted_critical_count || 0);
  if (proactiveUrgent > 0) {
    const riskLabel = proactiveOverdue > 0
      ? `${proactiveOverdue} overdue`
      : (proactiveCritical > 0 ? `${proactiveCritical} critical` : `${proactiveUrgent} warning`);
    feed.push({
      tag: 'Radar',
      text: `Proactive Engine mendeteksi ${proactiveUrgent} item urgent (${riskLabel}). Reprioritize sekarang.`,
      chips: [{ label: `Urgent ${proactiveUrgent}`, tone: proactiveOverdue > 0 ? 'critical' : 'warning', command: 'task urgent saya apa' }],
      at: null,
    });
  }

  if (predictiveHigh + predictiveCritical > 0) {
    const riskLabel = predictiveCritical > 0
      ? `${predictiveCritical} critical forecast`
      : `${predictiveHigh} high forecast`;
    feed.push({
      tag: 'Predictive',
      text: `Model prediktif membaca ${predictiveHigh + predictiveCritical} item berisiko dalam 72 jam (${riskLabel}).`,
      chips: [{
        label: `Risk ${predictiveHigh + predictiveCritical}`,
        tone: predictiveCritical > 0 ? 'critical' : 'warning',
        command: 'risk deadline 48 jam ke depan',
      }],
      at: null,
    });
  }

  if (feed.length === 0) {
    feed.push({
      tag: 'Calm Mode',
      text: 'Sistem stabil. Pakai momentum ini buat progress goals jangka panjang.',
      chips: [{ label: 'Low Risk', tone: 'success', command: 'ringkasan hari ini' }],
      at: null,
    });
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
      ${Array.isArray(item.chips) && item.chips.length ? `
        <div class="cc-feed-chips">
          ${item.chips.slice(0, 5).map((chip) => `
            <button
              type="button"
              class="cc-evidence-chip ${escapeHtml(chip.tone || 'info')}"
              data-chip-command="${escapeHtml(encodeChipCommand(chip.command || ''))}"
              title="${escapeHtml(chip.command ? `Jalankan: ${chip.command}` : chip.label || '')}"
              ${chip.command ? '' : 'disabled'}
            >${escapeHtml(chip.label || '')}</button>
          `).join('')}
        </div>
      ` : ''}
    </article>
  `).join('');
}

function renderUpdatedTimestamp() {
  const el = document.getElementById('cc-updated-at');
  if (!el || !state.lastUpdated) return;
  el.textContent = `Updated ${nowLabel(state.lastUpdated)}`;
}

function renderAll() {
  renderTaskReminderBanner();
  renderZaIFloatingWidget();
  renderTodayMission();
  renderCouplePulse();
  renderUrgentRadar();
  renderStudyMission();
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
      get('/schedule'),
      get('/weekly'),
      get('/proactive?limit=12'),
      get(`/study_plan?target_minutes=${getStudyTargetMinutes()}`),
      shouldFetchAssistant ? post('/assistant', { message: 'ringkasan hari ini' }) : Promise.resolve(state.assistant),
    ]);

    const [tasksRes, assignmentsRes, scheduleRes, weeklyRes, proactiveRes, studyPlanRes, assistantRes] = requests;

    state.tasks = tasksRes.status === 'fulfilled' && Array.isArray(tasksRes.value) ? tasksRes.value : [];
    state.assignments = assignmentsRes.status === 'fulfilled' && Array.isArray(assignmentsRes.value) ? assignmentsRes.value : [];
    state.schedule = scheduleRes.status === 'fulfilled' && Array.isArray(scheduleRes.value) ? scheduleRes.value : [];
    state.weekly = weeklyRes.status === 'fulfilled' ? weeklyRes.value : null;
    state.proactive = proactiveRes.status === 'fulfilled' ? proactiveRes.value : null;
    state.studyPlan = studyPlanRes.status === 'fulfilled' ? studyPlanRes.value : null;

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
  const feed = document.getElementById('assistant-feed-list');
  const reminderOpen = document.getElementById('task-reminder-open');
  const reminderSnooze = document.getElementById('task-reminder-snooze');
  const reminderDismiss = document.getElementById('task-reminder-dismiss');
  const zaiTrigger = document.getElementById('zai-floating-trigger');
  const zaiClose = document.getElementById('zai-floating-close');
  const zaiPanel = document.getElementById('zai-floating-panel');
  const zaiPrimary = document.getElementById('zai-floating-primary');
  const zaiSecondary = document.getElementById('zai-floating-secondary');
  if (refreshBtn) {
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

  if (feed) {
    feed.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-chip-command]');
      if (!chip) return;
      const command = normalizeChipCommand(decodeChipCommand(chip.getAttribute('data-chip-command') || ''));
      if (!command) return;
      openChatWithCommand(command);
    });
  }

  if (reminderOpen) {
    reminderOpen.addEventListener('click', () => {
      const route = reminderRouteForItem(currentReminderItem);
      window.location.href = route;
    });
  }

  if (reminderSnooze) {
    reminderSnooze.addEventListener('click', () => {
      localStorage.setItem(TASK_REMINDER_SNOOZE_KEY, String(Date.now() + TASK_REMINDER_SNOOZE_MS));
      renderTaskReminderBanner();
      showToast('Pengingat ditunda 1 jam.', 'success', 1800);
    });
  }

  if (reminderDismiss) {
    reminderDismiss.addEventListener('click', () => {
      localStorage.setItem(TASK_REMINDER_DISMISS_DAY_KEY, todayDateText());
      renderTaskReminderBanner();
      showToast('Banner disembunyikan untuk hari ini.', 'success', 1800);
    });
  }

  if (zaiTrigger && zaiPanel) {
    zaiTrigger.addEventListener('click', () => {
      const opened = zaiPanel.classList.toggle('show');
      zaiTrigger.setAttribute('aria-expanded', opened ? 'true' : 'false');
    });
  }

  if (zaiClose && zaiPanel && zaiTrigger) {
    zaiClose.addEventListener('click', () => {
      zaiPanel.classList.remove('show');
      zaiTrigger.setAttribute('aria-expanded', 'false');
    });
  }

  if (zaiPrimary) {
    zaiPrimary.addEventListener('click', () => {
      const route = String(zaiPrimary.dataset.route || '').trim();
      if (!route) return;
      window.location.href = route;
    });
  }

  if (zaiSecondary) {
    zaiSecondary.addEventListener('click', () => {
      const route = String(zaiSecondary.dataset.route || '').trim();
      if (!route) return;
      window.location.href = route;
    });
  }

  if (zaiPanel && zaiTrigger) {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('#zai-floating-widget')) return;
      zaiPanel.classList.remove('show');
      zaiTrigger.setAttribute('aria-expanded', 'false');
    });
  }
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
