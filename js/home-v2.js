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
        ? 'Item sudah terlambat.'
        : 'Jika ditunda, risiko telat meningkat signifikan.',
    };
  }

  if (eventType.startsWith('predictive_risk_')) {
    const riskBand = String(payload.risk_band || '').toLowerCase() || eventType.replace('predictive_risk_', '');
    const riskScore = Number(payload.risk_score || 0);
    const hoursLeft = Number(payload.hours_left || 0);
    return {
      why: [riskScore > 0 ? `Model prediktif memberi skor ${riskScore} (${riskBand}).` : `Item terdeteksi berisiko ${riskBand}.`],
      impact: 'Kamu bisa atur ulang lebih awal sebelum masuk zona mendesak.',
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
      impact: 'Sinkronisasi singkat membantu distribusi beban couple lebih seimbang.',
      risk: 'Miskomunikasi dapat menaikkan friksi dan menurunkan produktivitas.',
    };
  }

  if (eventType === 'predictive_support_ping') {
    const target = String(payload.target || 'partner');
    return {
      why: [`Sistem mendeteksi ${target} butuh dukungan untuk item berisiko tinggi.`],
      impact: 'Intervensi lebih awal membantu mencegah eskalasi jadi keterlambatan.',
      risk: 'Tanpa dukungan/check-in, risiko telat deadline meningkat.',
    };
  }

  if (eventType === 'morning_brief') {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
    const assignments = Array.isArray(payload.assignments) ? payload.assignments.length : 0;
    const classes = Array.isArray(payload.classes) ? payload.classes.length : 0;
    return {
      why: [`Brief pagi menghitung ${tasks} tugas, ${assignments} tugas kuliah, ${classes} kelas.`],
      impact: 'Rencana lebih jelas dari pagi menurunkan perpindahan fokus seharian.',
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
    chips.push({ label: `Tugas ${taskCount}`, tone: 'info', command: 'tugas pending saya apa' });
    chips.push({ label: `Tugas Kuliah ${assignmentCount}`, tone: 'info', command: 'tugas kuliah pending saya apa' });
  }

  if (tool === 'get_tasks' || tool === 'get_assignments') {
    const items = Array.isArray(data.items) ? data.items : [];
    const risk = summarizeDeadlineRisk(items);
    if (risk.overdue > 0) chips.push({ label: `${risk.overdue} Terlambat`, tone: 'critical', command: 'tugas paling mendesak saya apa' });
    else if (risk.due24h > 0) chips.push({ label: `${risk.due24h} Deadline <24j`, tone: 'warning', command: 'tugas paling mendesak saya apa' });
    if (items.length > 0) chips.push({
      label: `${items.length} Tertunda`,
      tone: 'info',
      command: tool === 'get_tasks' ? 'tugas pending saya apa' : 'tugas kuliah pending saya apa',
    });
  }

  if (tool === 'get_unified_memory') {
    const counters = data.counters || {};
    const streak = data.streak || {};
    const urgent = Number(counters.urgent_items || 0);
    const streakDays = Number(streak.current_days || 0);
    if (urgent > 0) chips.push({ label: `Mendesak ${urgent}`, tone: 'critical', command: 'tugas paling mendesak saya apa' });
    if (streakDays > 0) chips.push({ label: `Runtun ${streakDays}h`, tone: 'success', command: 'jadwal belajar besok pagi' });
  }

  if (tool === 'get_study_plan') {
    const summary = data.summary || {};
    const criticalSessions = Number(summary.critical_sessions || 0);
    const sessions = Number(summary.sessions || 0);
    if (sessions > 0) chips.push({ label: `${sessions} Sesi`, tone: 'info', command: 'jadwal belajar besok pagi' });
    if (criticalSessions > 0) chips.push({ label: `${criticalSessions} Kritis`, tone: 'warning', command: 'geser sesi belajar ke besok pagi' });
  }

  if (explain.confidence) {
    chips.push({
      label: `Z AI ${String(explain.confidence).toUpperCase()}`,
      tone: confidenceTone(explain.confidence),
      command: 'tampilkan memori hari ini',
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
        label: minutesLeft <= 0 ? 'Terlambat' : `Sisa ${minutesLeft}m`,
        tone: minutesLeft <= 0 ? 'critical' : 'warning',
        command: payload.source === 'assignment' ? 'tugas kuliah pending saya apa' : 'tugas paling mendesak saya apa',
      });
    }
  }

  if (eventType.startsWith('predictive_risk_')) {
    const band = String(payload.risk_band || '').toLowerCase() || eventType.replace('predictive_risk_', '');
    const score = Number(payload.risk_score || 0);
    chips.push({
      label: `Prediksi ${band}`,
      tone: band === 'critical' ? 'critical' : 'warning',
      command: 'risiko deadline 48 jam ke depan',
    });
    if (score > 0) {
      chips.push({
        label: `Skor ${score}`,
        tone: band === 'critical' ? 'critical' : 'warning',
        command: 'risiko deadline 48 jam ke depan',
      });
    }
  }

  if (eventType === 'mood_drop_alert' || eventType === 'mood_drop_self') {
    const recent = Number(payload.recent_avg || 0);
    if (recent > 0) chips.push({ label: `Mood ${recent.toFixed(1)}`, tone: 'warning', command: 'kasih ide check-in singkat malam ini' });
  }

  if (eventType === 'checkin_suggestion') {
    const gap = Number(payload.gap_hours || 0);
    if (gap > 0) chips.push({ label: `Tanpa Check-In ${Math.floor(gap)}j`, tone: 'warning', command: 'bantu buat pesan check-in pasangan sekarang' });
  }

  if (eventType === 'predictive_support_ping') {
    chips.push({ label: 'Butuh Dukungan', tone: 'warning', command: 'ingatkan pasangan check-in malam ini' });
  }

  if (eventType === 'morning_brief') {
    const taskCount = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
    const assignmentCount = Array.isArray(payload.assignments) ? payload.assignments.length : 0;
    chips.push({ label: `Tugas ${taskCount}`, tone: 'info', command: 'tugas pending saya apa' });
    chips.push({ label: `Tugas Kuliah ${assignmentCount}`, tone: 'info', command: 'tugas kuliah pending saya apa' });
  }

  return dedupeEvidenceChips(chips);
}

function isMobileFeedLayout() {
  return Boolean(window.matchMedia && window.matchMedia('(max-width: 460px)').matches);
}

function clampText(text = '', max = 90) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trim()}...`;
}

function normalizeFeedFamily(eventType = '') {
  const e = String(eventType || '');
  if (e === 'urgent_radar' || e.startsWith('urgent_radar_')) return 'urgent_radar';
  if (e.startsWith('predictive_risk_')) return 'predictive_risk';
  if (e === 'mood_drop_alert' || e === 'mood_drop_self') return 'mood';
  if (e === 'checkin_suggestion' || e === 'predictive_support_ping') return 'checkin';
  if (e === 'morning_brief') return 'brief';
  return 'general';
}

function horizonBucket(hoursLeft) {
  if (!Number.isFinite(hoursLeft)) return 'none';
  if (hoursLeft <= 24) return '<=24h';
  if (hoursLeft <= 48) return '<=48h';
  return '>48h';
}

function sourceDomain(payload = {}, eventType = '') {
  const fromPayload = String(payload?.source || payload?.domain || '').toLowerCase();
  if (fromPayload.includes('assignment') || fromPayload.includes('kuliah')) return 'assignment';
  if (fromPayload.includes('task') || fromPayload.includes('tugas')) return 'task';
  const e = String(eventType || '').toLowerCase();
  if (e.includes('assignment')) return 'assignment';
  return 'general';
}

function severityLabel(severity = '') {
  const s = String(severity || '').toLowerCase();
  if (s === 'critical') return 'Critical';
  if (s === 'high') return 'High';
  if (s === 'warning') return 'Warning';
  return 'Info';
}

function horizonLabel(bucket = '') {
  if (bucket === '<=24h') return '<=24j';
  if (bucket === '<=48h') return '<=48j';
  if (bucket === '>48h') return '>48j';
  return 'tanpa horizon';
}

function familyTag(family = '') {
  if (family === 'urgent_radar') return 'Radar Mendesak';
  if (family === 'predictive_risk') return 'Risiko Prediktif';
  if (family === 'mood') return 'Mood';
  if (family === 'checkin') return 'Check-In';
  if (family === 'brief') return 'Brief';
  if (family === 'assistant') return 'Ringkasan Z AI';
  return 'Proaktif';
}

function baseScoreForCandidate(candidate = {}) {
  const family = String(candidate.family || '');
  let score = 20;
  if (family === 'urgent_radar') score = 100;
  else if (family === 'predictive_risk') score = candidate.severity === 'critical' ? 90 : 80;
  else if (family === 'mood' || family === 'checkin') score = 60;
  else if (family === 'brief') score = 50;
  else if (family === 'assistant') score = 40;

  if (candidate.overdue) score += 18;
  if (candidate.horizon === '<=24h') score += 10;
  else if (candidate.horizon === '<=48h') score += 6;
  score += Math.min(20, Number(candidate.risk_score || 0) / 5);
  return score;
}

function buildCandidateFromProactive(item = {}) {
  const eventType = String(item?.event_type || '');
  const payload = normalizeExplainability(item?.payload) || {};
  const family = normalizeFeedFamily(eventType);
  const chips = buildProactiveEvidenceChips(item);
  const primaryCommand = chips.find((c) => c.command)?.command || 'ringkasan hari ini';

  const minutesLeft = Number(payload.minutes_left);
  const payloadHours = Number(payload.hours_left);
  const hoursLeft = Number.isFinite(minutesLeft) ? (minutesLeft / 60) : payloadHours;
  const horizon = horizonBucket(hoursLeft);
  const domain = sourceDomain(payload, eventType);
  const riskBand = String(payload.risk_band || '').toLowerCase();

  const titleRaw = String(payload.title || payload.name || item?.title || item?.body || '').trim();
  const title = clampText(titleRaw || (domain === 'assignment' ? 'tugas kuliah' : 'tugas'), 40);

  let action = 'Lanjutkan prioritas utama sekarang';
  let context = 'Eksekusi kecil sekarang biar ritme tetap jalan.';
  let severity = riskBand || (family === 'urgent_radar' ? 'critical' : 'info');

  if (family === 'urgent_radar') {
    action = `Mulai ${title} 25m sekarang`;
    context = `${severityLabel(severity)}, ${horizonLabel(horizon)}`;
  } else if (family === 'predictive_risk') {
    severity = riskBand || 'high';
    action = `${domain === 'assignment' ? 'Cek tugas kuliah' : 'Cek tugas'} ${title}`;
    context = `${severityLabel(severity)}, ${horizonLabel(horizon)}`;
  } else if (family === 'mood') {
    severity = 'warning';
    action = 'Ambil tugas ringan 15m dulu';
    context = 'Mood menurun, jaga momentum pelan tapi konsisten.';
  } else if (family === 'checkin') {
    severity = 'warning';
    action = 'Kirim check-in singkat ke pasangan';
    context = 'Sinkron 2 menit untuk cegah miskomunikasi.';
  } else if (family === 'brief') {
    const tasks = Array.isArray(payload.tasks) ? payload.tasks.length : 0;
    const assignments = Array.isArray(payload.assignments) ? payload.assignments.length : 0;
    severity = 'info';
    action = 'Review prioritas pagi 2 menit';
    context = `${tasks} tugas, ${assignments} tugas kuliah.`;
  }

  const candidate = {
    id: String(item?.id || `${eventType}-${title}`),
    family,
    horizon,
    domain,
    severity,
    risk_score: Number(payload.risk_score || 0),
    overdue: Number.isFinite(hoursLeft) ? hoursLeft <= 0 : false,
    action: clampText(action, 86),
    context: clampText(context, 64),
    chips,
    command: primaryCommand,
    tag: familyTag(family),
    at: item?.created_at || null,
  };
  candidate.score = baseScoreForCandidate(candidate);
  return candidate;
}

function dedupeFeedCandidates(candidates = []) {
  const grouped = new Map();
  for (const item of candidates) {
    if (!item) continue;
    const key = `${item.family}|${item.horizon}|${item.domain}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { representative: item, count: 1 });
      continue;
    }
    current.count += 1;
    if (Number(item.score || 0) > Number(current.representative.score || 0)) {
      current.representative = item;
    }
  }

  const out = [];
  for (const entry of grouped.values()) {
    const rep = { ...entry.representative };
    const count = Number(entry.count || 1);
    if (count > 1) {
      if (rep.family === 'predictive_risk') {
        rep.context = `${count} item risiko ${rep.severity}. ${horizonLabel(rep.horizon)}`;
      } else if (rep.family === 'urgent_radar') {
        rep.context = `${count} item mendesak. ${horizonLabel(rep.horizon)}`;
      } else {
        rep.context = `${count} sinyal ${rep.tag.toLowerCase()}.`;
      }
    }
    out.push(rep);
  }
  return out.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

function buildAssistantFeedCandidates() {
  const pendingAssignments = (state.assignments || []).filter((a) => !a.completed);
  const pendingTasks = (state.tasks || []).filter((t) => !t.completed && !t.is_deleted);
  const missionItems = collectMissionItems();
  const top = missionItems[0] || null;

  if (!top) {
    return [{
      id: 'calm',
      family: 'general',
      horizon: 'none',
      domain: 'general',
      severity: 'info',
      risk_score: 0,
      overdue: false,
      action: 'Semua aman. Lanjutkan progres harianmu pelan tapi konsisten.',
      context: 'Tidak ada item yang mepet sekarang.',
      chips: [{ label: 'Lihat ringkasan', tone: 'success', command: 'ringkasan hari ini' }],
      command: 'ringkasan hari ini',
      tag: 'Mode Tenang',
      at: null,
      score: 1,
    }];
  }

  const assignmentCount = pendingAssignments.length;
  const taskCount = pendingTasks.length;
  const dueHint = top.badge === 'Terlambat'
    ? 'sudah lewat deadline'
    : `paling mepet (${top.badge})`;
  const title = clampText(top.title || 'tanpa judul', 34);
  const command = top.type === 'Tugas Kuliah' ? 'tugas kuliah pending saya apa' : 'tugas paling mendesak saya apa';

  let action = '';
  if (assignmentCount === 0) {
    action = 'kamu tidak memiliki tugas kuliah, cik cek LMS';
  } else if (assignmentCount > 0) {
    action = `Kamu punya ${assignmentCount} tugas kuliah. Kerjakan "${title}" dulu karena ${dueHint}.`;
  } else if (taskCount > 0) {
    action = `Kamu punya ${taskCount} tugas. Kerjakan "${title}" dulu karena ${dueHint}.`;
  } else {
    action = `Kerjakan "${title}" dulu karena ${dueHint}.`;
  }

  const mainCandidate = {
    id: 'ultra-compact-main',
    family: 'assistant',
    horizon: 'none',
    domain: top.type === 'Tugas Kuliah' ? 'assignment' : 'task',
    severity: top.urgency === 'critical' ? 'critical' : (top.urgency === 'warning' ? 'high' : 'info'),
    risk_score: 0,
    overdue: top.badge === 'Terlambat',
    action: clampText(action, 90),
    context: 'Fokus 25 menit sekarang, lalu cek item berikutnya.',
    chips: [{ label: 'Buka aksi', tone: top.urgency === 'critical' ? 'critical' : 'warning', command }],
    command,
    tag: 'Ringkasan Z AI',
    at: null,
    score: top.urgency === 'critical' ? 120 : 90,
  };

  const extra = [];
  if (assignmentCount > 1 && top.type !== 'Tugas Kuliah') {
    extra.push({
      id: 'assignment-focus',
      family: 'assistant',
      horizon: 'none',
      domain: 'assignment',
      severity: 'high',
      risk_score: 0,
      overdue: false,
      action: `Masih ada ${assignmentCount} tugas kuliah aktif.`,
      context: 'Cek urutan deadline tugas kuliah setelah sesi ini.',
      chips: [{ label: 'Cek kuliah', tone: 'warning', command: 'tugas kuliah pending saya apa' }],
      command: 'tugas kuliah pending saya apa',
      tag: 'Tugas Kuliah',
      at: null,
      score: 70,
    });
  }
  if (taskCount > 1 && top.type !== 'Tugas') {
    extra.push({
      id: 'task-focus',
      family: 'assistant',
      horizon: 'none',
      domain: 'task',
      severity: 'warning',
      risk_score: 0,
      overdue: false,
      action: `Masih ada ${taskCount} tugas harian aktif.`,
      context: 'Selesaikan 1 quick win setelah fokus utama.',
      chips: [{ label: 'Cek tugas', tone: 'info', command: 'tugas pending saya apa' }],
      command: 'tugas pending saya apa',
      tag: 'Tugas Harian',
      at: null,
      score: 60,
    });
  }

  return [mainCandidate, ...extra].slice(0, 3);
}

function fallbackFeedCandidate() {
  return {
    id: 'calm',
    family: 'general',
    horizon: 'none',
    domain: 'general',
    severity: 'info',
    risk_score: 0,
    overdue: false,
    action: 'Sistem stabil. Lanjutkan progres harian.',
    context: 'Mode tenang aktif.',
    chips: [{ label: 'Lihat ringkasan', tone: 'success', command: 'ringkasan hari ini' }],
    command: 'ringkasan hari ini',
    tag: 'Mode Tenang',
    at: null,
    score: 1,
  };
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
  if (!deadline) return { dueMs: Number.POSITIVE_INFINITY, badge: 'Tanpa Deadline', urgency: 'good' };
  const due = new Date(deadline).getTime();
  if (!Number.isFinite(due)) return { dueMs: Number.POSITIVE_INFINITY, badge: 'Tanpa Deadline', urgency: 'good' };

  const diffMin = Math.round((due - Date.now()) / 60000);
  if (diffMin <= 0) return { dueMs: due, badge: 'Terlambat', urgency: 'critical' };
  if (diffMin <= 180) return { dueMs: due, badge: '<3h', urgency: 'critical' };
  if (diffMin <= 720) return { dueMs: due, badge: '<12h', urgency: 'warning' };
  if (diffMin <= 1440) return { dueMs: due, badge: 'Hari Ini', urgency: 'warning' };
  return { dueMs: due, badge: `${Math.ceil(diffMin / 1440)}d`, urgency: 'good' };
}

function collectMissionItems() {
  const pendingTasks = (state.tasks || []).filter((t) => !t.completed && !t.is_deleted).map((t) => ({
    type: 'Tugas',
    icon: 'fa-list-check',
    title: t.title,
    priority: t.priority || 'medium',
    deadline: t.deadline,
    assigned_to: t.assigned_to || '',
  }));

  const pendingAssignments = (state.assignments || []).filter((a) => !a.completed).map((a) => ({
    type: 'Tugas Kuliah',
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

function tomorrowClassItems() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const dayId = tomorrowDayIdFromDate(tomorrow);
  const rows = Array.isArray(state.schedule) ? state.schedule : [];
  return rows
    .filter((row) => Number(row?.day_id || 0) === dayId)
    .sort((a, b) => String(a?.time_start || '').localeCompare(String(b?.time_start || '')));
}

function tomorrowDayIdFromDate(d) {
  const raw = d.getDay();
  return raw === 0 ? 7 : raw;
}

function toMinutesFromHm(value = '') {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return Number.POSITIVE_INFINITY;
  return (Number(m[1]) * 60) + Number(m[2]);
}

function nextClassToday() {
  const now = new Date();
  const nowMin = (now.getHours() * 60) + now.getMinutes();
  const rows = todayClassItems();
  return rows.find((row) => toMinutesFromHm(row?.time_start) >= nowMin) || null;
}

function upcomingCollegeAssignment24h() {
  const pending = (state.assignments || []).filter((a) => !a.completed && a.deadline);
  const nowMs = Date.now();
  const candidates = pending
    .map((a) => {
      const dueMs = new Date(a.deadline).getTime();
      if (!Number.isFinite(dueMs)) return null;
      return { ...a, dueMs, diffH: (dueMs - nowMs) / 3600000 };
    })
    .filter(Boolean)
    .filter((a) => a.diffH <= 24);
  candidates.sort((a, b) => a.dueMs - b.dueMs);
  return candidates[0] || null;
}

function reminderCandidate(items = []) {
  return items.find((item) => item && (item.urgency === 'critical' || item.urgency === 'warning')) || null;
}

function reminderRouteForItem(item) {
  if (!item) return '/daily-tasks';
  return item.type === 'Tugas Kuliah' ? '/college-assignments' : '/daily-tasks';
}

function formatReminderSub(item) {
  if (!item) return 'Buka rencana untuk cek prioritas terbaru.';
  if (item.badge === 'Terlambat') return `${item.type} ini sudah lewat deadline. Tangani sekarang.`;
  if (item.badge === '<3h' || item.badge === '<12h') return `${item.type} ini deadline-nya sangat dekat (${item.badge}).`;
  if (item.badge === 'Hari Ini') return `${item.type} ini jatuh tempo hari ini.`;
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
    const safeTitle = escapeHtml(item.title || 'Tanpa Judul');
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
  titleEl.textContent = `${candidate.type}: ${candidate.title || 'Tanpa Judul'}`;
  subEl.textContent = formatReminderSub(candidate);
  banner.hidden = false;
}

function buildZaIFloatingMessage() {
  const user = localStorage.getItem('user') || 'Kamu';
  const missionItems = collectMissionItems();
  const urgent = reminderCandidate(missionItems);
  const urgentCollege = upcomingCollegeAssignment24h();
  const pendingAssignments = (state.assignments || []).filter((a) => !a.completed);
  const classesToday = todayClassItems();
  const nextTodayClass = nextClassToday();
  const classesTomorrow = tomorrowClassItems();
  const proactiveSignals = state.proactive && state.proactive.signals ? state.proactive.signals : {};
  const overdueCount = Number(proactiveSignals.overdue_count || 0);
  const predictiveCritical = Number(proactiveSignals.predicted_critical_count || 0);

  const collegeLine = (() => {
    if (urgentCollege) {
      return `Tugas kuliah: "${urgentCollege.title || 'Tanpa Judul'}" deadline ${hoursLeftLabel(urgentCollege.dueMs)}.`;
    }
    if (pendingAssignments.length > 0) {
      return `Tugas kuliah: ${pendingAssignments.length} aktif, belum ada yang mepet 24 jam.`;
    }
    return 'Tugas kuliah: kamu tidak memiliki tugas kuliah aktif.';
  })();

  const scheduleLine = (() => {
    if (nextTodayClass) {
      const start = asHmLabel(nextTodayClass.time_start);
      const subject = String(nextTodayClass.subject || 'kuliah').trim();
      const room = String(nextTodayClass.room || '').trim();
      const roomText = room ? ` di ruangan ${room}` : '';
      return `Jadwal kuliah: selanjutnya ${subject} jam ${start}${roomText}.`;
    }
    if (classesTomorrow.length > 0) {
      const first = classesTomorrow[0];
      const start = asHmLabel(first.time_start);
      const subject = String(first.subject || 'kuliah').trim();
      const room = String(first.room || '').trim();
      const roomText = room ? ` di ruangan ${room}` : '';
      return `Jadwal kuliah: besok ada ${subject} jam ${start}${roomText}.`;
    }
    return 'Jadwal kuliah: tidak ada jadwal terdekat.';
  })();

  if (urgentCollege) {
    return {
      tone: 'critical',
      title: 'Pengingat Deadline Z AI',
      message: `Hai ${user},\n${collegeLine}\n${scheduleLine}`,
      primary: {
        label: 'Buka Tugas Kuliah',
        route: '/college-assignments',
      },
      secondary: { label: 'Buka Jadwal', route: '/schedule' },
      pulse: true,
    };
  }

  if (nextTodayClass) {
    return {
      tone: 'success',
      title: 'Jadwal Selanjutnya Z AI',
      message: `Hai ${user},\n${collegeLine}\n${scheduleLine}`,
      primary: { label: 'Buka Jadwal', route: '/schedule' },
      secondary: { label: 'Buka Tugas Kuliah', route: '/college-assignments' },
      pulse: false,
    };
  }

  if (classesTomorrow.length > 0) {
    return {
      tone: 'success',
      title: 'Brief Kampus Z AI',
      message: `Hai ${user},\n${collegeLine}\n${scheduleLine}`,
      primary: { label: 'Buka Jadwal', route: '/schedule' },
      secondary: { label: 'Buka Tugas Kuliah', route: '/college-assignments' },
      pulse: false,
    };
  }

  if (urgent) {
    const danger = urgent.badge === 'Terlambat'
      ? 'sudah melewati deadline'
      : `deadline ${hoursLeftLabel(urgent.dueMs)}`;
    return {
      tone: urgent.urgency === 'critical' ? 'critical' : 'warning',
      title: 'Pengingat Z AI',
      message: `Hai ${user}, ${urgent.type.toLowerCase()} "${urgent.title || 'Tanpa Judul'}" ${danger}. Prioritaskan sekarang ya.`,
      primary: {
        label: urgent.type === 'Tugas Kuliah' ? 'Buka Tugas Kuliah' : 'Buka Tugas Harian',
        route: reminderRouteForItem(urgent),
      },
      secondary: classesToday.length
        ? { label: 'Lihat Jadwal', route: '/schedule' }
        : { label: 'Buka Obrolan Z AI', route: '/chat?ai=rekomendasi%20tugas%20paling%20mendesak%20saya' },
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
      title: 'Brief Kampus Z AI',
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
      title: 'Z AI Proaktif',
      message: `Hai ${user}, ada ${risky} item berisiko tinggi. Cek radar sekarang supaya gak mepet deadline.`,
      primary: { label: 'Buka Radar Mendesak', route: '/daily-tasks' },
      secondary: { label: 'Analisis Risiko', route: '/chat?ai=risiko%20deadline%2048%20jam%20ke%20depan' },
      pulse: true,
    };
  }

  const pending = missionItems.length;
  if (pending > 0) {
    return {
      tone: 'info',
      title: 'Z AI Fokus',
      message: `Hai ${user}, masih ada ${pending} item tertunda. Ambil 1 item dulu, fokus 25 menit, lalu update progres.`,
      primary: { label: 'Buka Prioritas', route: '/daily-tasks' },
      secondary: { label: 'Minta Rekomendasi', route: '/chat?ai=rekomendasi%20tugas%20kuliah' },
      pulse: false,
    };
  }

  return {
    tone: 'good',
    title: 'Z AI Mode Tenang',
    message: `Hai ${user}, kondisi hari ini aman. Kamu bisa lanjut goals jangka panjangmu.`,
    primary: { label: 'Buka Tujuan', route: '/goals' },
    secondary: { label: 'Obrolan Z AI', route: '/chat?ai=ringkasan%20hari%20ini' },
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
  toneEl.textContent = payload.title || 'Pengingat Z AI';
  msgEl.textContent = payload.message || 'Z AI siap bantu prioritas kamu.';

  primaryBtn.textContent = payload.primary?.label || 'Buka';
  primaryBtn.dataset.route = payload.primary?.route || '/chat';
  secondaryBtn.textContent = payload.secondary?.label || 'Obrolan';
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
      syncEl.textContent = 'Sinkron --';
    } else {
      const pct = Math.round((Number(sync) + 1) * 50);
      syncEl.textContent = `Sinkron ${pct}%`;
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
    container.innerHTML = '<div class="cc-empty">Belum ada jadwal belajar hari ini. Buka Jadwal untuk bikin rencana belajar pintar.</div>';
    return;
  }

  container.innerHTML = sessions.slice(0, 4).map((session) => {
    const urgency = (session.urgency || 'good').toLowerCase();
    const title = escapeHtml(session.title || 'Sesi Belajar');
    const reason = escapeHtml(session.reason || 'Sesi progres');
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
  return buildAssistantFeedCandidates();
}

function renderAssistantFeedDesktop(container, items) {
  container.innerHTML = items.slice(0, 5).map((item) => `
    <article class="cc-feed-item">
      <div class="cc-feed-head">
        <span>${escapeHtml(item.tag)}</span>
        <span>${escapeHtml(item.at ? nowLabel(new Date(item.at)) : nowLabel())}</span>
      </div>
      <p class="cc-feed-text">${escapeHtml(`${item.action} ${item.context}`)}</p>
      ${Array.isArray(item.chips) && item.chips.length ? `
        <div class="cc-feed-chips">
          ${item.chips.slice(0, 3).map((chip) => `
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

function renderAssistantFeedMobile(container, items) {
  const primary = items[0] || fallbackFeedCandidate();
  const secondary = items.slice(1, 3);
  const primaryChip = primary.chips && primary.chips.length ? primary.chips[0] : { label: 'Buka aksi', tone: 'info', command: primary.command || 'ringkasan hari ini' };
  const secondaryHtml = secondary.map((item) => {
    const chip = item.chips && item.chips.length ? item.chips[0] : { label: 'Buka aksi', tone: 'info', command: item.command || 'ringkasan hari ini' };
    return `
      <article class="cc-feed-item zai-feed-mini">
        <div class="cc-feed-head">
          <span>${escapeHtml(item.tag)}</span>
          <span>${escapeHtml(item.at ? nowLabel(new Date(item.at)) : nowLabel())}</span>
        </div>
        <p class="zai-feed-action">${escapeHtml(item.action)}</p>
        <p class="zai-feed-context">${escapeHtml(item.context)}</p>
        <div class="cc-feed-chips">
          <button
            type="button"
            class="cc-evidence-chip ${escapeHtml(chip.tone || 'info')}"
            data-chip-command="${escapeHtml(encodeChipCommand(chip.command || item.command || 'ringkasan hari ini'))}"
            title="${escapeHtml(chip.command ? `Jalankan: ${chip.command}` : chip.label || '')}"
          >${escapeHtml(chip.label || 'Buka aksi')}</button>
        </div>
      </article>
    `;
  }).join('');

  container.innerHTML = `
    <article class="cc-feed-item zai-feed-primary">
      <div class="cc-feed-head">
        <span>${escapeHtml(primary.tag)}</span>
        <span>${escapeHtml(primary.at ? nowLabel(new Date(primary.at)) : nowLabel())}</span>
      </div>
      <p class="zai-feed-action">${escapeHtml(primary.action)}</p>
      <p class="zai-feed-context">${escapeHtml(primary.context)}</p>
      <div class="cc-feed-chips">
        <button
          type="button"
          class="cc-evidence-chip ${escapeHtml(primaryChip.tone || 'info')}"
          data-chip-command="${escapeHtml(encodeChipCommand(primaryChip.command || primary.command || 'ringkasan hari ini'))}"
          title="${escapeHtml(primaryChip.command ? `Jalankan: ${primaryChip.command}` : primaryChip.label || '')}"
        >${escapeHtml(primaryChip.label || 'Buka aksi')}</button>
      </div>
    </article>
    ${secondary.length ? `<div class="zai-feed-grid">${secondaryHtml}</div>` : ''}
    <div class="zai-feed-footer">
      <a class="btn small secondary" href="/chat?ai=ringkasan%20hari%20ini">Lihat semua</a>
    </div>
  `;
}

function renderAssistantFeed() {
  const container = document.getElementById('assistant-feed-list');
  if (!container) return;
  const items = buildAssistantFeedItems();
  if (isMobileFeedLayout()) {
    renderAssistantFeedMobile(container, items);
    return;
  }
  renderAssistantFeedDesktop(container, items);
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
  let greet = 'Selamat pagi';
  if (hour >= 12 && hour < 17) greet = 'Selamat siang';
  if (hour >= 17 || hour < 4) greet = 'Selamat malam';

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
