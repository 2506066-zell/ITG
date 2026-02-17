import jwt from 'jsonwebtoken';
import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';
import { buildUnifiedMemorySnapshot, normalizeMemoryDate, clampStudyTargetMinutes } from './_unified_memory.js';
import { generateStudyPlanSnapshot, setStudyPreference } from './study_plan.js';

const ASSISTANT_ISSUER = 'cute-futura-assistant';
const ASSISTANT_AUDIENCE = 'cute-futura-assistant';
const WRITE_CONFIRM_EXP = '10m';
const ALLOWED_USERS = new Set(['Zaldy', 'Nesya']);

function clampLimit(value, fallback = 8, min = 1, max = 25) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parsePriority(raw = '') {
  const p = raw.toLowerCase();
  if (p === 'high' || p === 'tinggi') return 'high';
  if (p === 'low' || p === 'rendah') return 'low';
  return 'medium';
}

function parseDateFromText(text = '') {
  const msg = text.toLowerCase();
  const now = new Date();

  const isoDate = text.match(/\b(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}))?\b/);
  if (isoDate) {
    const value = new Date(`${isoDate[1]}T${isoDate[2] || '21:00'}:00`);
    if (!Number.isNaN(value.getTime())) return value;
  }

  const dmy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}:\d{2}))?\b/);
  if (dmy) {
    const dd = String(Number(dmy[1])).padStart(2, '0');
    const mm = String(Number(dmy[2])).padStart(2, '0');
    const value = new Date(`${dmy[3]}-${mm}-${dd}T${dmy[4] || '21:00'}:00`);
    if (!Number.isNaN(value.getTime())) return value;
  }

  const timeOnly = text.match(/\b(\d{1,2}:\d{2})\b/);
  const setRelative = (dayDelta) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayDelta);
    const hhmm = timeOnly ? timeOnly[1] : '21:00';
    const [hh, mm] = hhmm.split(':').map(Number);
    d.setHours(Number.isFinite(hh) ? hh : 21, Number.isFinite(mm) ? mm : 0, 0, 0);
    return d;
  };

  if (/(lusa|day after tomorrow)/i.test(msg)) return setRelative(2);
  if (/(besok|tomorrow)/i.test(msg)) return setRelative(1);
  if (/(hari ini|today)/i.test(msg)) return setRelative(0);

  return null;
}

function parseCreateTaskPayload(message = '') {
  const original = message.trim();
  const priorityMatch = original.match(/(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)/i);
  const assignedMatch = original.match(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/i);
  const goalMatch = original.match(/(?:goal|tujuan)\s*#?(\d+)/i);
  const deadline = parseDateFromText(original);

  let title = original.replace(/^(?:buat|tambah|add|create)\s+(?:task|tugas)\s*/i, '').trim();
  const deadlineMarker = title.search(/\b(deadline|due)\b/i);
  if (deadlineMarker >= 0) {
    title = title.slice(0, deadlineMarker).trim();
  }
  title = title
    .replace(/(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)/ig, '')
    .replace(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/ig, '')
    .replace(/(?:goal|tujuan)\s*#?\d+/ig, '')
    .replace(/\b(today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b/ig, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) {
    title = original;
  }

  return {
    title,
    priority: parsePriority(priorityMatch?.[1]),
    assigned_to: assignedMatch ? assignedMatch[1][0].toUpperCase() + assignedMatch[1].slice(1).toLowerCase() : null,
    goal_id: goalMatch ? Number(goalMatch[1]) : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseCreateAssignmentPayload(message = '') {
  const original = message.trim();
  const assignedMatch = original.match(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/i);
  const deadline = parseDateFromText(original);

  let title = original
    .replace(/^(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\s*/i, '')
    .trim();
  const deadlineMarker = title.search(/\b(deadline|due)\b/i);
  if (deadlineMarker >= 0) {
    title = title.slice(0, deadlineMarker).trim();
  }
  title = title
    .replace(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/ig, '')
    .replace(/\b(today|hari ini|tomorrow|besok|lusa|day after tomorrow)\b/ig, '')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (!title) {
    title = original;
  }

  return {
    title,
    assigned_to: assignedMatch ? assignedMatch[1][0].toUpperCase() + assignedMatch[1].slice(1).toLowerCase() : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseTaskDeadlineUpdatePayload(message = '') {
  const original = message.trim();
  const taskIdMatch = original.match(/(?:task|tugas)(?:\s*id)?\s*#?(\d+)/i);
  const deadline = parseDateFromText(original);
  return {
    id: taskIdMatch ? Number(taskIdMatch[1]) : null,
    deadline: deadline ? deadline.toISOString() : null,
  };
}

function parseScheduleArgs(message = '') {
  const map = {
    monday: 1, senin: 1,
    tuesday: 2, selasa: 2,
    wednesday: 3, rabu: 3,
    thursday: 4, kamis: 4,
    friday: 5, jumat: 5,
    saturday: 6, sabtu: 6,
    sunday: 7, minggu: 7,
  };

  const lower = message.toLowerCase();
  for (const [key, value] of Object.entries(map)) {
    if (lower.includes(key)) return { day_id: value };
  }

  const now = new Date();
  const plusDays = /(besok|tomorrow)/i.test(lower) ? 1 : /(lusa|day after tomorrow)/i.test(lower) ? 2 : 0;
  now.setDate(now.getDate() + plusDays);
  return { day_id: now.getDay() === 0 ? 7 : now.getDay() };
}

function toDateText(dateObj) {
  if (!dateObj || Number.isNaN(dateObj.getTime())) return null;
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseStudyWindow(message = '') {
  const lower = message.toLowerCase();
  if (/(pagi|morning)/i.test(lower)) return 'morning';
  if (/(siang|afternoon)/i.test(lower)) return 'afternoon';
  if (/(malam|evening|night)/i.test(lower)) return 'evening';
  return 'any';
}

function parseStudyTarget(message = '') {
  const hit = message.match(/(\d{2,3})\s*(?:menit|minutes|min)\b/i);
  if (!hit) return null;
  return clampStudyTargetMinutes(hit[1], 150);
}

function parseStudyPlanArgs(message = '') {
  const date = parseDateFromText(message);
  const target = parseStudyTarget(message);
  const windowName = parseStudyWindow(message);
  const args = {};
  if (date) args.date = toDateText(date);
  if (target !== null) args.target_minutes = target;
  if (windowName !== 'any') args.preferred_window = windowName;
  return args;
}

function parseStudyPreferencePayload(message = '') {
  const target = parseStudyTarget(message);
  const windowName = parseStudyWindow(message);
  const date = parseDateFromText(message);
  const args = {};
  if (target !== null) args.target_minutes = target;
  if (windowName !== 'any') args.preferred_window = windowName;
  if (date) args.preview_date = toDateText(date);
  return args;
}

function parseUnifiedMemoryArgs(message = '') {
  const date = parseDateFromText(message);
  return { date: date ? toDateText(date) : null };
}

function isLikelyCreateShorthandSegment(segment = '', kind = 'task') {
  const text = segment.trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const headPattern = kind === 'assignment' ? /^(assignment|tugas kuliah)\b/i : /^(task|tugas)\b/i;
  if (!headPattern.test(text)) return false;

  if (/\b(pending|list|daftar|apa|belum|show|lihat|cek|status|report|ringkasan|summary)\b/i.test(lower)) {
    return false;
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  return true;
}

function parseBundleActionSegment(segment = '') {
  const msg = segment.trim();
  if (!msg) return null;
  const lower = msg.toLowerCase();

  const explicitCreateTask = /\b(?:buat|tambah|add|create)\s+(?:task|tugas)\b/i.test(lower);
  if (explicitCreateTask || isLikelyCreateShorthandSegment(msg, 'task')) {
    const normalized = explicitCreateTask ? msg : `buat task ${msg}`;
    return {
      tool: 'create_task',
      mode: 'write',
      args: parseCreateTaskPayload(normalized),
      summary: 'Buat task baru',
    };
  }

  const explicitCreateAssignment = /\b(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\b/i.test(lower);
  if (explicitCreateAssignment || isLikelyCreateShorthandSegment(msg, 'assignment')) {
    const normalized = explicitCreateAssignment ? msg : `buat assignment ${msg}`;
    return {
      tool: 'create_assignment',
      mode: 'write',
      args: parseCreateAssignmentPayload(normalized),
      summary: 'Buat assignment baru',
    };
  }

  if (/(ubah|update|ganti|reschedule|geser)/i.test(lower) && /(deadline|due)/i.test(lower) && /(task|tugas)/i.test(lower)) {
    const args = parseTaskDeadlineUpdatePayload(msg);
    return {
      tool: 'update_task_deadline',
      mode: 'write',
      args,
      summary: args.id ? `Ubah deadline task #${args.id}` : 'Ubah deadline task',
    };
  }

  const completeTaskMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:task|tugas)(?:\s*id)?\s*#?(\d+)/i);
  if (completeTaskMatch) {
    return {
      tool: 'complete_task',
      mode: 'write',
      args: { id: Number(completeTaskMatch[1]) },
      summary: `Tandai task #${completeTaskMatch[1]} selesai`,
    };
  }

  const completeAssignmentMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:assignment|tugas kuliah)(?:\s*id)?\s*#?(\d+)/i);
  if (completeAssignmentMatch) {
    return {
      tool: 'complete_assignment',
      mode: 'write',
      args: { id: Number(completeAssignmentMatch[1]) },
      summary: `Tandai assignment #${completeAssignmentMatch[1]} selesai`,
    };
  }

  if (/(geser|pindah|reschedule)/i.test(lower) && /(sesi belajar|study session|jadwal belajar|study plan)/i.test(lower)) {
    return {
      tool: 'replan_study_window',
      mode: 'write',
      args: parseStudyPreferencePayload(msg),
      summary: 'Re-plan sesi belajar',
    };
  }

  if (/(target belajar|study target|mode belajar|window belajar|atur belajar|set belajar)/i.test(lower)) {
    return {
      tool: 'set_study_preferences',
      mode: 'write',
      args: parseStudyPreferencePayload(msg),
      summary: 'Atur preferensi study plan',
    };
  }

  return null;
}

function normalizeChatMessageForBundle(message = '') {
  return message
    .replace(/\r?\n+/g, ' ')
    .replace(/[!?]+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripLeadingChatFiller(text = '') {
  return text
    .replace(/^(?:(?:tolong|please|pls|bisa|boleh|dong|ya|yuk|aku|saya|mau|ingin|minta)\s+)+/i, '')
    .trim();
}

function splitBundleByConnectors(text = '') {
  return text
    .split(/\s*(?:;|\.|(?:,\s*)?(?:dan|and|lalu|kemudian|terus|habis itu|setelah itu))\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractWriteActionChunks(text = '') {
  const starts = [];
  const actionStartRegex = /(?:^|\s)(?:(?:buat|tambah|add|create)\s+(?:task|tugas|assignment|tugas kuliah)\b|(?:selesaikan|complete|done|tandai)\s+(?:task|tugas|assignment|tugas kuliah)\b|(?:ubah|update|ganti|reschedule|geser)\s+(?:deadline|due)\b|(?:geser|pindah|reschedule)\s+(?:sesi belajar|study session|jadwal belajar|study plan)\b|(?:atur|set|ubah|ganti)\s+(?:target belajar|study target|mode belajar|window belajar|atur belajar|set belajar)\b|(?:task|tugas|assignment|tugas kuliah)\b)/gi;

  let match;
  while ((match = actionStartRegex.exec(text)) !== null) {
    let idx = match.index;
    while (idx < text.length && /\s/.test(text[idx])) idx += 1;
    if (idx >= text.length) continue;
    if (!starts.includes(idx)) starts.push(idx);
  }

  if (starts.length < 2) return [];
  starts.sort((a, b) => a - b);

  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function parseActionBundle(message = '') {
  const normalized = stripLeadingChatFiller(normalizeChatMessageForBundle(message));
  if (!normalized) return null;

  const parseSegments = (segments = []) => {
    const actions = [];
    for (const segment of segments) {
      const action = parseBundleActionSegment(segment);
      if (action) actions.push(action);
    }
    return actions;
  };

  const explicitSegments = splitBundleByConnectors(normalized);
  if (explicitSegments.length >= 2) {
    const actions = parseSegments(explicitSegments);
    if (actions.length >= 2) return actions;
  }

  const smartChunks = extractWriteActionChunks(normalized);
  if (smartChunks.length >= 2) {
    const actions = parseSegments(smartChunks);
    if (actions.length >= 2) return actions;
  }

  return null;
}

function normalizeIntentArgsForUser(toolName, args, user) {
  const out = { ...(args || {}) };
  if ((toolName === 'create_task' || toolName === 'create_assignment') && !out.assigned_to) {
    out.assigned_to = user;
  }
  return out;
}

function normalizeIntentForUser(intent, user) {
  if (!intent) return intent;
  if (intent.tool === 'execute_action_bundle') {
    const actions = Array.isArray(intent.args?.actions)
      ? intent.args.actions.map((action) => ({
          ...action,
          args: normalizeIntentArgsForUser(action.tool, action.args || {}, user),
        }))
      : [];
    return {
      ...intent,
      args: { ...(intent.args || {}), actions },
    };
  }
  return {
    ...intent,
    args: normalizeIntentArgsForUser(intent.tool, intent.args || {}, user),
  };
}

function detectIntent(message = '') {
  const msg = message.trim();
  const lower = msg.toLowerCase();

  if (!msg) return null;

  const bundleActions = parseActionBundle(msg);
  if (bundleActions) {
    const summaries = bundleActions.map((x) => x.summary).join(', ');
    return {
      tool: 'execute_action_bundle',
      mode: 'write',
      args: { actions: bundleActions },
      summary: `Jalankan ${bundleActions.length} aksi: ${summaries}`,
    };
  }

  const createTaskMatch = lower.match(/^(buat|tambah|add|create)\s+(task|tugas)\b/);
  if (createTaskMatch) {
    return {
      tool: 'create_task',
      mode: 'write',
      args: parseCreateTaskPayload(msg),
      summary: 'Buat task baru',
    };
  }

  const createAssignmentMatch = lower.match(/^(buat|tambah|add|create)\s+(assignment|tugas kuliah)\b/);
  if (createAssignmentMatch) {
    return {
      tool: 'create_assignment',
      mode: 'write',
      args: parseCreateAssignmentPayload(msg),
      summary: 'Buat assignment baru',
    };
  }

  if (/(ubah|update|ganti|reschedule|geser)/i.test(lower) && /(deadline|due)/i.test(lower) && /(task|tugas)/i.test(lower)) {
    const args = parseTaskDeadlineUpdatePayload(msg);
    return {
      tool: 'update_task_deadline',
      mode: 'write',
      args,
      summary: args.id ? `Ubah deadline task #${args.id}` : 'Ubah deadline task',
    };
  }

  const completeTaskMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:task|tugas)(?:\s*id)?\s*#?(\d+)/i);
  if (completeTaskMatch) {
    return {
      tool: 'complete_task',
      mode: 'write',
      args: { id: Number(completeTaskMatch[1]) },
      summary: `Tandai task #${completeTaskMatch[1]} selesai`,
    };
  }

  const completeAssignmentMatch = lower.match(/(?:selesaikan|complete|done|tandai)\s+(?:assignment|tugas kuliah)(?:\s*id)?\s*#?(\d+)/i);
  if (completeAssignmentMatch) {
    return {
      tool: 'complete_assignment',
      mode: 'write',
      args: { id: Number(completeAssignmentMatch[1]) },
      summary: `Tandai assignment #${completeAssignmentMatch[1]} selesai`,
    };
  }

  if (/(memory|konteks|context|snapshot|status lengkap|ringkasan lengkap)/i.test(lower)) {
    return {
      tool: 'get_unified_memory',
      mode: 'read',
      args: parseUnifiedMemoryArgs(msg),
      summary: 'Ambil unified memory snapshot',
    };
  }

  if (/(study plan|jadwal belajar|rencana belajar|plan belajar)/i.test(lower)) {
    return {
      tool: 'get_study_plan',
      mode: 'read',
      args: parseStudyPlanArgs(msg),
      summary: 'Lihat smart study plan',
    };
  }

  if (/(geser|pindah|reschedule)/i.test(lower) && /(sesi belajar|study session|jadwal belajar|study plan)/i.test(lower)) {
    return {
      tool: 'replan_study_window',
      mode: 'write',
      args: parseStudyPreferencePayload(msg),
      summary: 'Re-plan sesi belajar',
    };
  }

  if (/(target belajar|study target|mode belajar|window belajar|atur belajar|set belajar)/i.test(lower)) {
    return {
      tool: 'set_study_preferences',
      mode: 'write',
      args: parseStudyPreferencePayload(msg),
      summary: 'Atur preferensi study plan',
    };
  }

  if (/(jadwal|schedule|kuliah)/i.test(lower)) {
    return {
      tool: 'get_schedule',
      mode: 'read',
      args: parseScheduleArgs(msg),
      summary: 'Lihat jadwal',
    };
  }

  if (/(assignment|tugas kuliah|kuliah)/i.test(lower) && /(deadline|pending|belum|list|daftar|apa)/i.test(lower)) {
    return {
      tool: 'get_assignments',
      mode: 'read',
      args: { limit: 8, pending_only: true },
      summary: 'Lihat assignment',
    };
  }

  if (/(goal|tujuan|target)/i.test(lower)) {
    return {
      tool: 'get_goals',
      mode: 'read',
      args: { limit: 8, active_only: true },
      summary: 'Lihat goals',
    };
  }

  const reportMonthly = /(report|laporan|ringkasan)/i.test(lower) && /(bulanan|monthly)/i.test(lower);
  const reportWeekly = /(report|laporan|ringkasan)/i.test(lower) && /(mingguan|weekly)/i.test(lower);
  if (reportMonthly || reportWeekly) {
    return {
      tool: 'get_report',
      mode: 'read',
      args: { type: reportMonthly ? 'monthly' : 'weekly' },
      summary: 'Lihat report',
    };
  }

  if (/(task|tugas|todo|to-do|deadline)/i.test(lower)) {
    return {
      tool: 'get_tasks',
      mode: 'read',
      args: { limit: 8, pending_only: true, scope: 'mine' },
      summary: 'Lihat task',
    };
  }

  if (/(brief|ringkas|hari ini|today|summary)/i.test(lower)) {
    return {
      tool: 'get_daily_brief',
      mode: 'read',
      args: { limit: 5 },
      summary: 'Ringkasan hari ini',
    };
  }

  return {
    tool: 'help',
    mode: 'read',
    args: {},
    summary: 'Bantuan asisten',
  };
}

function dayLabel(dayId) {
  const map = {
    1: 'Monday',
    2: 'Tuesday',
    3: 'Wednesday',
    4: 'Thursday',
    5: 'Friday',
    6: 'Saturday',
    7: 'Sunday',
  };
  return map[dayId] || 'Unknown';
}

function formatDeadline(iso) {
  if (!iso) return 'no deadline';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'invalid date';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function hoursUntil(deadline) {
  if (!deadline) return null;
  const t = new Date(deadline).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - Date.now()) / 3600000;
}

function analyzeDeadlineRisk(items = []) {
  let overdue = 0;
  let due12h = 0;
  let due24h = 0;
  let withDeadline = 0;
  let nearest = null;
  for (const item of items) {
    const h = hoursUntil(item?.deadline);
    if (h === null) continue;
    withDeadline += 1;
    if (!nearest || h < nearest.hoursLeft) {
      nearest = {
        id: item.id || null,
        title: item.title || '',
        hoursLeft: h,
      };
    }
    if (h <= 0) overdue += 1;
    else if (h <= 12) due12h += 1;
    else if (h <= 24) due24h += 1;
  }
  return { overdue, due12h, due24h, withDeadline, nearest };
}

function buildExplainability(toolName, data, user) {
  const nowIso = new Date().toISOString();
  const empty = {
    why: [],
    impact: '',
    risk: '',
    recommended_action: '',
    confidence: '',
    generated_at: nowIso,
  };

  if (toolName === 'get_tasks') {
    const items = Array.isArray(data?.items) ? data.items : [];
    const risk = analyzeDeadlineRisk(items);
    const highPriority = items.filter((x) => (x?.priority || '').toLowerCase() === 'high').length;
    const why = [];
    why.push(`Terdeteksi ${items.length} task aktif untuk ${user}.`);
    if (highPriority > 0) why.push(`${highPriority} task berprioritas tinggi perlu diprioritaskan.`);
    if (risk.overdue + risk.due12h + risk.due24h > 0) {
      why.push(`${risk.overdue + risk.due12h + risk.due24h} task memiliki tekanan deadline <=24 jam.`);
    }

    const nearestLabel = risk.nearest
      ? `Fokus ke task #${risk.nearest.id || '?'} "${risk.nearest.title}" dalam sprint 25 menit.`
      : 'Ambil 1 task prioritas tertinggi lalu kerjakan fokus 25 menit.';

    return {
      why: why.slice(0, 3),
      impact: items.length ? 'Eksekusi task teratas sekarang menurunkan beban kritis hari ini.' : 'Tidak ada task aktif, waktu bisa dialihkan ke goals jangka panjang.',
      risk: risk.overdue > 0
        ? `${risk.overdue} task sudah overdue.`
        : (risk.due12h + risk.due24h > 0 ? `${risk.due12h + risk.due24h} task berisiko telat jika ditunda.` : 'Risiko task rendah untuk saat ini.'),
      recommended_action: nearestLabel,
      confidence: risk.withDeadline > 0 ? 'high' : 'medium',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_assignments') {
    const items = Array.isArray(data?.items) ? data.items : [];
    const risk = analyzeDeadlineRisk(items);
    const why = [`Ada ${items.length} assignment pending yang terdeteksi.`];
    if (risk.overdue + risk.due12h + risk.due24h > 0) {
      why.push(`${risk.overdue + risk.due12h + risk.due24h} assignment berada pada zona deadline dekat.`);
    }

    return {
      why: why.slice(0, 3),
      impact: items.length ? 'Menyicil assignment terdekat menjaga konsistensi nilai dan mengurangi stress akhir.' : 'Tidak ada assignment pending, kapasitas belajar lebih longgar.',
      risk: risk.overdue > 0
        ? `${risk.overdue} assignment sudah overdue.`
        : (risk.due12h + risk.due24h > 0 ? `${risk.due12h + risk.due24h} assignment berisiko terlambat <=24 jam.` : 'Risiko assignment rendah.'),
      recommended_action: risk.nearest
        ? `Kerjakan assignment #${risk.nearest.id || '?'} minimal 30 menit sekarang.`
        : 'Review rubrik assignment berikutnya untuk antisipasi beban.',
      confidence: risk.withDeadline > 0 ? 'high' : 'medium',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_daily_brief') {
    const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
    const assignments = Array.isArray(data?.assignments) ? data.assignments : [];
    const schedule = Array.isArray(data?.schedule) ? data.schedule : [];
    const merged = [...tasks, ...assignments];
    const risk = analyzeDeadlineRisk(merged);
    const total = merged.length;

    return {
      why: [
        `Ringkasan menghitung ${tasks.length} task, ${assignments.length} assignment, dan ${schedule.length} jadwal hari ini.`,
        risk.overdue + risk.due12h + risk.due24h > 0
          ? `Ada ${risk.overdue + risk.due12h + risk.due24h} item dengan tekanan deadline.`
          : 'Tidak ada tekanan deadline kritis pada snapshot ini.',
      ],
      impact: total > 0
        ? 'Prioritas yang jelas membantu kamu eksekusi tanpa context-switch berlebih.'
        : 'Beban harian ringan, ini slot bagus untuk deep work atau recovery.',
      risk: risk.overdue > 0
        ? `${risk.overdue} item sudah overdue.`
        : (risk.due12h > 0 ? `${risk.due12h} item due <=12 jam.` : (risk.due24h > 0 ? `${risk.due24h} item due <=24 jam.` : 'Risiko deadline saat ini rendah.')),
      recommended_action: risk.nearest
        ? `Mulai dari "${risk.nearest.title}" lalu lanjut item kedua setelah 25 menit.`
        : 'Pertahankan ritme dengan 1 sesi fokus sebelum malam.',
      confidence: 'high',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_unified_memory') {
    const counters = data?.counters || {};
    const mood = data?.mood || {};
    const streak = data?.streak || {};
    const reco = data?.assistant_memory?.focus_recommendation || '';
    const urgent = Number(counters.urgent_items || 0);
    const moodAvg = Number(mood.avg_7d || 0);
    const streakCurrent = Number(streak.current_days || 0);

    return {
      why: [
        `Snapshot menggabungkan signal task=${Number(counters.tasks_pending || 0)}, assignment=${Number(counters.assignments_pending || 0)}, urgent=${urgent}.`,
        `Mood 7 hari=${moodAvg.toFixed(2)} dan streak belajar=${streakCurrent} hari dipakai sebagai konteks keputusan.`,
      ],
      impact: reco || 'Konteks terpadu membantu assistant memberi prioritas yang lebih presisi.',
      risk: urgent > 0
        ? `${urgent} item ada di zona waspada/kritis.`
        : (moodAvg > 0 && moodAvg < 2.8 ? 'Energi terdeteksi rendah, risiko drop fokus meningkat.' : 'Risiko operasional harian relatif stabil.'),
      recommended_action: reco || 'Jalankan 1 sprint fokus sekarang untuk menjaga momentum.',
      confidence: 'high',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_study_plan') {
    const summary = data?.summary || {};
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    const criticalSessions = Number(summary.critical_sessions || 0);
    const planned = Number(summary.planned_minutes || 0);
    const target = Number(data?.target_minutes || summary.target_minutes || planned || 0);
    const load = String(summary.focus_load || 'light');
    const first = sessions[0] || null;

    return {
      why: [
        `Plan membagi target ${target || planned} menit menjadi ${Number(summary.sessions || sessions.length || 0)} sesi.`,
        `Load terdeteksi ${load} dengan ${criticalSessions} sesi kritis.`,
      ],
      impact: sessions.length
        ? 'Penjadwalan sesi mengurangi keputusan spontan dan meningkatkan konsistensi belajar.'
        : 'Belum ada sesi, jadi kamu bisa menyesuaikan window belajar sebelum hari berjalan.',
      risk: criticalSessions > 0
        ? `${criticalSessions} sesi kritis menandakan tekanan deadline tinggi.`
        : (sessions.length === 0 ? 'Tanpa sesi terjadwal, risiko target belajar meleset meningkat.' : 'Risiko belajar terkontrol selama sesi dijalankan.'),
      recommended_action: first
        ? `Jalankan sesi pertama ${first.start}-${first.end}: ${first.title}.`
        : 'Coba re-plan ke window pagi atau naikkan target menit.',
      confidence: sessions.length > 0 ? 'high' : 'medium',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_report') {
    const taskDone = Number(data?.completed_tasks || 0);
    const assignmentDone = Number(data?.completed_assignments || 0);
    const avgMood = Number(data?.avg_mood || 0);
    const period = String(data?.type || 'weekly');
    return {
      why: [`Report ${period} dihitung dari aktivitas selesai dan evaluasi mood pada periode terpilih.`],
      impact: 'Trend ini membantu kalibrasi target minggu berikutnya agar tetap realistis.',
      risk: avgMood > 0 && avgMood < 2.8
        ? 'Mood rata-rata rendah, risiko burnout meningkat bila beban tidak dikendalikan.'
        : (taskDone + assignmentDone === 0 ? 'Output periode ini rendah, risiko penumpukan backlog meningkat.' : 'Risiko performa moderat.'),
      recommended_action: 'Tentukan 1 prioritas utama untuk periode berikutnya dan lock di awal hari.',
      confidence: 'high',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_schedule') {
    const items = Array.isArray(data?.items) ? data.items : [];
    return {
      why: [`Ada ${items.length} kelas pada ${dayLabel(data?.day_id)}.`],
      impact: 'Mengetahui jadwal lebih awal membantu memblok waktu fokus di sela kelas.',
      risk: items.length >= 5 ? 'Hari cukup padat, risiko kelelahan dan task spillover meningkat.' : 'Risiko jadwal relatif terkendali.',
      recommended_action: items.length ? 'Sisakan minimal 1 slot 25 menit untuk task prioritas.' : 'Gunakan hari kosong untuk progress assignment.',
      confidence: 'high',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_goals') {
    const items = Array.isArray(data?.items) ? data.items : [];
    const avg = items.length
      ? items.reduce((acc, g) => acc + Number(g?.progress || 0), 0) / items.length
      : 0;
    return {
      why: [`Ada ${items.length} goal aktif dengan rata-rata progress ${avg.toFixed(1)}%.`],
      impact: 'Monitoring goal menjaga kerja harian tetap align ke outcome jangka panjang.',
      risk: items.length > 0 && avg < 35 ? 'Progress goal masih rendah, risiko tidak tercapai tepat waktu meningkat.' : 'Risiko goal moderat.',
      recommended_action: 'Pilih 1 goal utama dan kaitkan dengan task hari ini.',
      confidence: items.length ? 'medium' : 'low',
      generated_at: nowIso,
    };
  }

  return empty;
}

function summarizeRead(toolName, data, user) {
  if (toolName === 'get_tasks') {
    if (!data.items.length) return `Tidak ada task aktif untuk ${user}.`;
    const top = data.items.slice(0, 5).map((t) => `#${t.id} ${t.title} (${t.priority})`).join(' | ');
    return `Ada ${data.items.length} task aktif. Prioritas terdekat: ${top}`;
  }

  if (toolName === 'get_schedule') {
    if (!data.items.length) return `Tidak ada jadwal untuk ${dayLabel(data.day_id)}.`;
    const top = data.items.slice(0, 5).map((c) => `${c.time_start.slice(0, 5)} ${c.subject}`).join(' | ');
    return `Jadwal ${dayLabel(data.day_id)}: ${top}`;
  }

  if (toolName === 'get_goals') {
    if (!data.items.length) return 'Belum ada goal aktif.';
    const top = data.items.slice(0, 5).map((g) => `#${g.id} ${g.title} (${g.progress || 0}%)`).join(' | ');
    return `Ada ${data.items.length} goal aktif. ${top}`;
  }

  if (toolName === 'get_assignments') {
    if (!data.items.length) return 'Tidak ada assignment pending.';
    const top = data.items.slice(0, 5).map((a) => `#${a.id} ${a.title}`).join(' | ');
    return `Ada ${data.items.length} assignment pending. ${top}`;
  }

  if (toolName === 'get_report') {
    return `Report ${data.type}: completed tasks=${data.completed_tasks}, completed assignments=${data.completed_assignments}, avg mood=${data.avg_mood}`;
  }

  if (toolName === 'get_daily_brief') {
    const lines = [];
    lines.push(`Task pending: ${data.tasks.length}`);
    lines.push(`Assignment pending: ${data.assignments.length}`);
    lines.push(`Jadwal hari ini: ${data.schedule.length}`);
    return lines.join(' | ');
  }

  if (toolName === 'get_unified_memory') {
    const c = data.counters || {};
    const streak = data.streak || {};
    const mood = data.mood || {};
    const reco = data.assistant_memory?.focus_recommendation || '';
    return `Memory ${data.date}: task ${c.tasks_pending || 0}, assignment ${c.assignments_pending || 0}, urgent ${c.urgent_items || 0}, study ${c.study_done_minutes || 0} menit, streak ${streak.current_days || 0} hari, mood ${mood.avg_7d || 0}. ${reco}`;
  }

  if (toolName === 'get_study_plan') {
    const s = data.summary || {};
    const first = Array.isArray(data.sessions) && data.sessions.length
      ? `${data.sessions[0].start}-${data.sessions[0].end} ${data.sessions[0].title}`
      : 'no session';
    return `Study plan ${data.date}: ${s.sessions || 0} sesi, ${s.planned_minutes || 0} menit, load ${s.focus_load || 'light'}, first ${first}`;
  }

  if (toolName === 'help') {
    return `Perintah yang didukung: ${data.tips.join(' | ')}`;
  }

  return 'Perintah diproses.';
}

async function toolGetTasks(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const values = [ctx.user, limit];
  const pendingSql = args.pending_only !== false ? 'AND completed = FALSE' : '';

  const r = await pool.query(
    `SELECT id, title, priority, deadline, completed, assigned_to, goal_id
     FROM tasks
     WHERE is_deleted = FALSE
       AND (assigned_to = $1 OR created_by = $1 OR completed_by = $1)
       ${pendingSql}
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $2`,
    values
  );

  return { items: r.rows };
}

async function toolGetSchedule(_ctx, args = {}) {
  const dayId = Number(args.day_id) || 1;
  const r = await pool.query(
    `SELECT id, day_id, subject, room, time_start, time_end, lecturer
     FROM schedule
     WHERE day_id = $1
     ORDER BY time_start ASC`,
    [dayId]
  );
  return { day_id: dayId, items: r.rows };
}

async function toolGetGoals(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const r = await pool.query(
    `SELECT id, title, category, deadline, progress, completed, created_by
     FROM goals
     WHERE is_deleted = FALSE
       AND (completed = FALSE OR $2::boolean = FALSE)
       AND (created_by = $1 OR created_by IS NULL)
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $3`,
    [ctx.user, args.active_only !== false, limit]
  );
  return { items: r.rows };
}

async function toolGetAssignments(ctx, args = {}) {
  const limit = clampLimit(args.limit, 8);
  const pendingSql = args.pending_only !== false ? 'AND completed = FALSE' : '';
  const r = await pool.query(
    `SELECT id, title, deadline, completed, assigned_to
     FROM assignments
     WHERE 1=1
       ${pendingSql}
       AND (assigned_to = $1 OR assigned_to IS NULL)
     ORDER BY deadline ASC NULLS LAST, id DESC
     LIMIT $2`,
    [ctx.user, limit]
  );
  return { items: r.rows };
}

function getPeriodRange(type = 'weekly') {
  const now = new Date();
  let start;
  let end;

  if (type === 'monthly') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, type };
  }

  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  start = new Date(now);
  start.setDate(diff);
  start.setHours(0, 0, 0, 0);

  end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end, type: 'weekly' };
}

async function toolGetReport(ctx, args = {}) {
  const range = getPeriodRange(args.type === 'monthly' ? 'monthly' : 'weekly');
  const [tasks, assignments, moods] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM tasks
       WHERE completed = TRUE
         AND is_deleted = FALSE
         AND completed_by = $1
         AND completed_at >= $2
         AND completed_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM assignments
       WHERE completed = TRUE
         AND completed_by = $1
         AND completed_at >= $2
         AND completed_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
    pool.query(
      `SELECT AVG(mood)::float AS avg_mood
       FROM evaluations
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3`,
      [ctx.user, range.start.toISOString(), range.end.toISOString()]
    ),
  ]);

  const avgMoodRaw = Number(moods.rows[0]?.avg_mood ?? 0);

  return {
    type: range.type,
    period: { start: range.start.toISOString(), end: range.end.toISOString() },
    completed_tasks: Number(tasks.rows[0]?.cnt || 0),
    completed_assignments: Number(assignments.rows[0]?.cnt || 0),
    avg_mood: Number(avgMoodRaw.toFixed(2)),
  };
}

async function toolGetDailyBrief(ctx, args = {}) {
  const limit = clampLimit(args.limit, 5);
  const today = new Date();
  const dayId = today.getDay() === 0 ? 7 : today.getDay();

  const [tasks, assignments, schedule] = await Promise.all([
    pool.query(
      `SELECT id, title, priority, deadline
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND (assigned_to = $1 OR created_by = $1)
       ORDER BY deadline ASC NULLS LAST
       LIMIT $2`,
      [ctx.user, limit]
    ),
    pool.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND (assigned_to = $1 OR assigned_to IS NULL)
       ORDER BY deadline ASC NULLS LAST
       LIMIT $2`,
      [ctx.user, limit]
    ),
    pool.query(
      `SELECT id, subject, time_start, time_end, room
       FROM schedule
       WHERE day_id = $1
       ORDER BY time_start ASC
       LIMIT $2`,
      [dayId, limit]
    ),
  ]);

  return {
    day_id: dayId,
    tasks: tasks.rows,
    assignments: assignments.rows,
    schedule: schedule.rows,
  };
}

function tomorrowDateText() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateText(d);
}

async function toolGetUnifiedMemory(ctx, args = {}) {
  const date = normalizeMemoryDate(args.date || '');
  return buildUnifiedMemorySnapshot(ctx.user, { date });
}

async function toolGetStudyPlan(ctx, args = {}) {
  const dateText = args.date ? normalizeMemoryDate(args.date) : '';
  const targetMinutes = args.target_minutes !== undefined
    ? clampStudyTargetMinutes(args.target_minutes, 150)
    : undefined;
  const preferredWindow = args.preferred_window || undefined;
  return generateStudyPlanSnapshot(ctx.user, {
    dateText,
    targetMinutes,
    preferredWindow,
  });
}

async function toolSetStudyPreferences(ctx, args = {}) {
  const patch = {};
  if (args.target_minutes !== undefined) {
    patch.target_minutes = clampStudyTargetMinutes(args.target_minutes, 150);
  }
  if (args.preferred_window !== undefined) {
    patch.preferred_window = args.preferred_window;
  }
  if (Object.keys(patch).length === 0) {
    const err = new Error('Sertakan target menit atau mode window belajar.');
    err.statusCode = 400;
    throw err;
  }

  const preference = await setStudyPreference(ctx.user, patch);
  const previewDate = args.preview_date ? normalizeMemoryDate(args.preview_date) : '';
  let preview = null;
  if (previewDate) {
    preview = await generateStudyPlanSnapshot(ctx.user, {
      dateText: previewDate,
      targetMinutes: preference.target_minutes,
      preferredWindow: preference.preferred_window,
    });
  }
  return { preference, preview };
}

async function toolReplanStudyWindow(ctx, args = {}) {
  const patch = {};
  if (args.preferred_window !== undefined) patch.preferred_window = args.preferred_window;
  if (args.target_minutes !== undefined) patch.target_minutes = clampStudyTargetMinutes(args.target_minutes, 150);
  if (Object.keys(patch).length === 0) patch.preferred_window = 'morning';

  const preference = await setStudyPreference(ctx.user, patch);
  const targetDate = args.preview_date ? normalizeMemoryDate(args.preview_date) : tomorrowDateText();
  const preview = await generateStudyPlanSnapshot(ctx.user, {
    dateText: targetDate,
    targetMinutes: preference.target_minutes,
    preferredWindow: preference.preferred_window,
  });
  return { preference, preview, replan_date: targetDate };
}

async function toolExecuteActionBundle(ctx, args = {}) {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  if (actions.length < 2) {
    const err = new Error('Bundle aksi minimal berisi 2 aksi write.');
    err.statusCode = 400;
    throw err;
  }

  const executed = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i] || {};
    const toolName = String(action.tool || '').trim();
    if (!toolName || toolName === 'execute_action_bundle') {
      const err = new Error(`Tool bundle tidak valid pada aksi ${i + 1}.`);
      err.statusCode = 400;
      throw err;
    }

    const def = TOOLS[toolName];
    if (!def || def.mode !== 'write') {
      const err = new Error(`Aksi ${i + 1} menggunakan tool write yang tidak valid: ${toolName}`);
      err.statusCode = 400;
      throw err;
    }

    const actionArgs = normalizeIntentArgsForUser(toolName, action.args || {}, ctx.user);
    try {
      const result = await def.run({ user: ctx.user }, actionArgs);
      executed.push({
        index: i + 1,
        tool: toolName,
        summary: action.summary || toolName,
        args: actionArgs,
        result,
      });
    } catch (err) {
      const doneLabel = executed.length
        ? `Aksi sebelumnya sudah sukses: ${executed.map((x) => `${x.index}.${x.tool}`).join(', ')}.`
        : 'Belum ada aksi yang dieksekusi.';
      const wrapped = new Error(`Bundle berhenti di aksi ${i + 1} (${toolName}): ${err.message}. ${doneLabel}`);
      wrapped.statusCode = errorStatus(err);
      throw wrapped;
    }
  }

  return { actions: executed, count: executed.length };
}

async function toolCreateTask(ctx, args = {}) {
  const title = (args.title || '').toString().trim();
  if (!title) {
    const err = new Error('Title task tidak boleh kosong');
    err.statusCode = 400;
    throw err;
  }

  const assignedTo = ALLOWED_USERS.has(args.assigned_to) ? args.assigned_to : ctx.user;
  const priority = parsePriority(args.priority || 'medium');
  const goalId = args.goal_id ? Number(args.goal_id) : null;
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (deadline && Number.isNaN(deadline.getTime())) {
    const err = new Error('Format deadline tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO tasks (title, created_by, updated_by, deadline, priority, assigned_to, goal_id)
       VALUES ($1, $2, $2, $3, $4, $5, $6)
       RETURNING *`,
      [title, ctx.user, deadline, priority, assignedTo, goalId]
    );
    const row = inserted.rows[0];
    await logActivity(client, 'task', row.id, 'CREATE', ctx.user, {
      title: row.title,
      priority: row.priority,
      assigned_to: row.assigned_to,
      deadline: row.deadline,
      goal_id: row.goal_id,
    });
    await client.query('COMMIT');
    return { item: row };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCreateAssignment(ctx, args = {}) {
  const title = (args.title || '').toString().trim();
  if (!title) {
    const err = new Error('Title assignment tidak boleh kosong');
    err.statusCode = 400;
    throw err;
  }

  const assignedTo = ALLOWED_USERS.has(args.assigned_to) ? args.assigned_to : ctx.user;
  const description = args.description ? String(args.description).trim() : null;
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (deadline && Number.isNaN(deadline.getTime())) {
    const err = new Error('Format deadline assignment tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO assignments (title, description, deadline, assigned_to)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [title, description, deadline, assignedTo]
    );
    const row = inserted.rows[0];
    await logActivity(client, 'assignment', row.id, 'CREATE', ctx.user, {
      title: row.title,
      description: row.description,
      assigned_to: row.assigned_to,
      deadline: row.deadline,
    });
    await client.query('COMMIT');
    return { item: row };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function computeTaskScore(task) {
  let score = 10;
  const prio = task.priority || 'medium';
  if (prio === 'medium') score = Math.round(score * 1.5);
  if (prio === 'high') score = Math.round(score * 2);

  if (task.deadline) {
    const dl = new Date(task.deadline);
    if (!Number.isNaN(dl.getTime()) && new Date() <= dl) {
      score += 5;
    }
  }

  if (task.goal_id) score += 5;
  return score;
}

async function toolUpdateTaskDeadline(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('Sertakan id task yang valid. Contoh: "ubah deadline task 12 besok 20:00"');
    err.statusCode = 400;
    throw err;
  }
  const deadline = args.deadline ? new Date(args.deadline) : null;
  if (!deadline || Number.isNaN(deadline.getTime())) {
    const err = new Error('Sertakan deadline yang valid. Contoh: "ubah deadline task 12 besok 20:00"');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      const err = new Error('Task tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const task = current.rows[0];
    const isOwner = task.created_by === ctx.user || !task.created_by;
    const isAssigned = task.assigned_to === ctx.user;
    if (!isOwner && !isAssigned) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    const prevDeadline = task.deadline || null;
    const updated = await client.query(
      `UPDATE tasks
       SET deadline = $1,
           updated_by = $2,
           version = COALESCE(version, 0) + 1
       WHERE id = $3
       RETURNING *`,
      [deadline, ctx.user, idNum]
    );

    const row = updated.rows[0];
    await logActivity(client, 'task', idNum, 'UPDATE', ctx.user, {
      deadline_before: prevDeadline,
      deadline_after: row.deadline,
    });
    await client.query('COMMIT');
    return { item: row, previous_deadline: prevDeadline };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCompleteTask(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('ID task tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM tasks WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0 || current.rows[0].is_deleted) {
      const err = new Error('Task tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const task = current.rows[0];
    const isOwner = task.created_by === ctx.user || !task.created_by;
    const isAssigned = task.assigned_to === ctx.user;
    if (!isOwner && !isAssigned) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    if (task.completed) {
      await client.query('COMMIT');
      return { item: task, already_completed: true };
    }

    const score = computeTaskScore(task);
    const updated = await client.query(
      `UPDATE tasks
       SET completed = TRUE,
           score_awarded = $1,
           completed_at = NOW(),
           completed_by = $2,
           updated_by = $2,
           version = COALESCE(version, 0) + 1
       WHERE id = $3
       RETURNING *`,
      [score, ctx.user, idNum]
    );

    const row = updated.rows[0];
    await logActivity(client, 'task', idNum, 'UPDATE', ctx.user, {
      completed: true,
      score_awarded: score,
      completed_by: ctx.user,
    });
    await client.query('COMMIT');
    return { item: row, already_completed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function toolCompleteAssignment(ctx, args = {}) {
  const idNum = Number(args.id);
  if (!idNum) {
    const err = new Error('ID assignment tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM assignments WHERE id = $1 FOR UPDATE', [idNum]);
    if (current.rowCount === 0) {
      const err = new Error('Assignment tidak ditemukan');
      err.statusCode = 404;
      throw err;
    }

    const row = current.rows[0];
    if (row.assigned_to && row.assigned_to !== ctx.user) {
      const err = new Error('Permission denied');
      err.statusCode = 403;
      throw err;
    }

    if (row.completed) {
      await client.query('COMMIT');
      return { item: row, already_completed: true };
    }

    const updated = await client.query(
      `UPDATE assignments
       SET completed = TRUE,
           completed_at = NOW(),
           completed_by = $1
       WHERE id = $2
       RETURNING *`,
      [ctx.user, idNum]
    );

    const item = updated.rows[0];
    await logActivity(client, 'assignment', idNum, 'UPDATE', ctx.user, {
      completed: true,
      completed_by: ctx.user,
    });
    await client.query('COMMIT');

    // Keep partner alert behavior consistent with assignments API
    const partner = ctx.user === 'Zaldy' ? 'Nesya' : (ctx.user === 'Nesya' ? 'Zaldy' : null);
    if (partner) {
      const msg = `${ctx.user} telah menyelesaikan tugas kuliah "${row.title}". Semangat ya! 🎓`;
      sendNotificationToUser(partner, {
        title: 'Assignment Done ✅',
        body: msg,
        url: '/college-assignments'
      }).catch(console.error);
    }

    return { item, already_completed: false };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const TOOLS = {
  help: {
    mode: 'read',
    run: async () => ({
      tips: [
        'Lihat task: "apa task saya hari ini"',
        'Lihat jadwal: "jadwal besok"',
        'Lihat goals: "goal aktif"',
        'Lihat assignment: "assignment pending"',
        'Lihat report: "report mingguan" atau "report bulanan"',
        'Buat task: "buat task belajar basis data deadline besok 19:00 priority high"',
        'Ubah deadline task: "ubah deadline task 12 besok 20:00"',
        'Selesaikan task: "selesaikan task 12"',
        'Buat assignment: "buat assignment makalah AI deadline 2026-03-01 20:00"',
        'Selesaikan assignment: "selesaikan assignment 5"',
        'Unified memory: "tampilkan memory hari ini"',
        'Study plan: "jadwal belajar besok pagi"',
        'Set target belajar: "atur target belajar 180 menit"',
        'Re-plan study: "geser sesi belajar malam ini ke besok pagi"',
        'Bundle multi-aksi: "buat task ... dan buat assignment ... dan atur target belajar 180 menit"',
        'Bundle chat-like: "tolong buat task revisi bab 2 besok 19:00 buat assignment AI minggu depan lalu atur target belajar 200 menit"',
      ],
    }),
  },
  get_tasks: { mode: 'read', run: toolGetTasks },
  get_schedule: { mode: 'read', run: toolGetSchedule },
  get_goals: { mode: 'read', run: toolGetGoals },
  get_assignments: { mode: 'read', run: toolGetAssignments },
  get_report: { mode: 'read', run: toolGetReport },
  get_daily_brief: { mode: 'read', run: toolGetDailyBrief },
  get_unified_memory: { mode: 'read', run: toolGetUnifiedMemory },
  get_study_plan: { mode: 'read', run: toolGetStudyPlan },
  execute_action_bundle: { mode: 'write', run: toolExecuteActionBundle },
  create_task: { mode: 'write', run: toolCreateTask },
  create_assignment: { mode: 'write', run: toolCreateAssignment },
  update_task_deadline: { mode: 'write', run: toolUpdateTaskDeadline },
  complete_task: { mode: 'write', run: toolCompleteTask },
  complete_assignment: { mode: 'write', run: toolCompleteAssignment },
  set_study_preferences: { mode: 'write', run: toolSetStudyPreferences },
  replan_study_window: { mode: 'write', run: toolReplanStudyWindow },
};

function buildConfirmationToken(user, tool, args, summary, originalMessage) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    const err = new Error('Server misconfigured');
    err.statusCode = 500;
    throw err;
  }

  return jwt.sign(
    {
      type: 'assistant_action',
      requested_by: user,
      tool,
      args,
      summary: summary || tool,
      original_message: originalMessage || '',
      requested_at: new Date().toISOString(),
    },
    secret,
    {
      expiresIn: WRITE_CONFIRM_EXP,
      issuer: ASSISTANT_ISSUER,
      audience: ASSISTANT_AUDIENCE,
      algorithm: 'HS256',
    }
  );
}

function readConfirmationToken(token) {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) {
    const err = new Error('Server misconfigured');
    err.statusCode = 500;
    throw err;
  }
  return jwt.verify(token, secret, {
    issuer: ASSISTANT_ISSUER,
    audience: ASSISTANT_AUDIENCE,
    algorithms: ['HS256'],
  });
}

function errorStatus(err) {
  return err && Number.isFinite(err.statusCode) ? err.statusCode : 500;
}

function createError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function writeExecutionReply(toolName, result) {
  if (toolName === 'execute_action_bundle') {
    const actions = Array.isArray(result.actions) ? result.actions : [];
    if (!actions.length) return 'Bundle selesai tanpa aksi.';
    const details = actions
      .map((entry) => `${entry.index}. ${writeExecutionReply(entry.tool, entry.result)}`)
      .join(' | ');
    return `Bundle ${actions.length} aksi berhasil: ${details}`;
  }

  if (toolName === 'create_task') {
    const item = result.item;
    return `Task berhasil dibuat: #${item.id} ${item.title} (priority ${item.priority}, deadline ${formatDeadline(item.deadline)})`;
  }

  if (toolName === 'create_assignment') {
    const item = result.item;
    return `Assignment berhasil dibuat: #${item.id} ${item.title} (deadline ${formatDeadline(item.deadline)})`;
  }

  if (toolName === 'update_task_deadline') {
    const item = result.item;
    return `Deadline task #${item.id} diubah ke ${formatDeadline(item.deadline)}.`;
  }

  if (toolName === 'complete_task') {
    if (result.already_completed) {
      return `Task #${result.item.id} sudah dalam status completed.`;
    }
    return `Task #${result.item.id} ditandai selesai. Score: ${result.item.score_awarded}`;
  }

  if (toolName === 'complete_assignment') {
    if (result.already_completed) {
      return `Assignment #${result.item.id} sudah completed.`;
    }
    return `Assignment #${result.item.id} ditandai selesai.`;
  }

  if (toolName === 'set_study_preferences') {
    const p = result.preference || {};
    const base = `Preferensi belajar disimpan: target ${p.target_minutes || 150} menit, window ${p.preferred_window || 'any'}.`;
    if (result.preview && result.preview.summary) {
      return `${base} Preview ${result.preview.date}: ${result.preview.summary.sessions || 0} sesi, ${result.preview.summary.planned_minutes || 0} menit.`;
    }
    return base;
  }

  if (toolName === 'replan_study_window') {
    const p = result.preference || {};
    const preview = result.preview || {};
    const summary = preview.summary || {};
    return `Study plan direplan ke window ${p.preferred_window || 'any'} untuk ${result.replan_date || preview.date || 'hari target'}. Hasil: ${summary.sessions || 0} sesi, ${summary.planned_minutes || 0} menit.`;
  }

  return 'Aksi write berhasil dijalankan.';
}

function isStreamRequest(req, body) {
  if (body && body.stream === true) return true;
  const u = new URL(req.url, 'http://x');
  const pathQuery = (u.searchParams.get('path') || '').toString().toLowerCase();
  const pathname = (u.pathname || '').toLowerCase();
  return pathQuery.startsWith('assistant/stream') || pathname.endsWith('/assistant/stream');
}

function splitTextChunks(text = '', maxLen = 18) {
  if (!text) return [];
  const out = [];
  let i = 0;
  while (i < text.length) {
    out.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return out;
}

function initSse(res, statusCode = 200) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
}

function sendSseEvent(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamPayload(res, payload) {
  initSse(res, 200);
  sendSseEvent(res, 'start', {
    mode: payload.mode,
    tool: payload.tool || '',
    tool_calls: payload.tool_calls || [],
  });

  const chunks = splitTextChunks(payload.reply || '', 16);
  for (const chunk of chunks) {
    sendSseEvent(res, 'delta', { text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 14));
  }

  sendSseEvent(res, 'result', payload);
  sendSseEvent(res, 'done', { ok: true });
  res.end();
}

function streamError(res, status, message) {
  initSse(res, status);
  sendSseEvent(res, 'error', { error: message, status });
  sendSseEvent(res, 'done', { ok: false });
  res.end();
}

async function processAssistantRequest(user, body = {}) {
  const wantsConfirm = body.confirm === true;

  if (wantsConfirm) {
    const token = (body.confirmation_token || '').toString().trim();
    if (!token) {
      throw createError('Missing confirmation_token', 400);
    }

    let payload;
    try {
      payload = readConfirmationToken(token);
    } catch {
      throw createError('Invalid or expired confirmation token', 401);
    }

    if (!payload || payload.type !== 'assistant_action') {
      throw createError('Invalid confirmation token', 400);
    }
    if (payload.requested_by !== user) {
      throw createError('Token does not belong to current user', 403);
    }

    const def = TOOLS[payload.tool];
    if (!def || def.mode !== 'write') {
      throw createError('Invalid write tool in confirmation token', 400);
    }

    const result = await def.run({ user }, payload.args || {});
    const toolCalls = payload.tool === 'execute_action_bundle'
      ? (Array.isArray(payload.args?.actions)
          ? payload.args.actions.map((action) => ({
              name: action.tool,
              mode: 'write',
              args: action.args || {},
            }))
          : [])
      : [{ name: payload.tool, mode: 'write', args: payload.args || {} }];

    return {
      ok: true,
      mode: 'write_executed',
      tool: payload.tool,
      tool_calls: toolCalls,
      reply: writeExecutionReply(payload.tool, result),
      data: result,
    };
  }

  const message = (body.message || '').toString().trim();
  if (!message) {
    throw createError('Message required', 400);
  }

  const intent = detectIntent(message);
  if (!intent) {
    throw createError('Unable to detect intent', 400);
  }

  const intentWithUser = normalizeIntentForUser(intent, user);

  const def = TOOLS[intentWithUser.tool];
  if (!def) {
    throw createError('Unknown assistant tool', 400);
  }

  if (def.mode === 'write') {
    const previewToolCalls = intentWithUser.tool === 'execute_action_bundle'
      ? (Array.isArray(intentWithUser.args?.actions)
          ? intentWithUser.args.actions.map((action) => ({
              name: action.tool,
              mode: 'write',
              args: action.args || {},
            }))
          : [])
      : [{ name: intentWithUser.tool, mode: 'write', args: intentWithUser.args }];

    const confirmationToken = buildConfirmationToken(
      user,
      intentWithUser.tool,
      intentWithUser.args,
      intentWithUser.summary,
      message
    );

    return {
      ok: true,
      mode: 'confirmation_required',
      tool: intentWithUser.tool,
      tool_calls: previewToolCalls,
      reply: `Konfirmasi diperlukan untuk aksi write: ${intentWithUser.summary}. Kirim ulang dengan /confirm.`,
      confirmation_token: confirmationToken,
      preview: {
        summary: intentWithUser.summary,
        args: intentWithUser.args,
      },
    };
  }

  const result = await def.run({ user }, intentWithUser.args || {});
  const explainability = buildExplainability(intentWithUser.tool, result, user);
  return {
    ok: true,
    mode: 'read',
    tool: intentWithUser.tool,
    tool_calls: [{ name: intentWithUser.tool, mode: 'read', args: intentWithUser.args || {} }],
    reply: summarizeRead(intentWithUser.tool, result, user),
    data: result,
    explainability,
  };
}

export default withErrorHandling(async function handler(req, res) {
  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const tools = Object.entries(TOOLS).map(([name, def]) => ({ name, mode: def.mode }));
    sendJson(res, 200, {
      ok: true,
      assistant: 'phase-2.0-nla',
      confirmation_required_for_write: true,
      stream_endpoint: '/api/assistant/stream',
      tools,
    }, 10);
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || await readBody(req);
  const wantsStream = isStreamRequest(req, body);

  try {
    const payload = await processAssistantRequest(user, body || {});
    if (wantsStream) {
      await streamPayload(res, payload);
      return;
    }

    const cacheSeconds = payload.mode === 'read' ? 5 : 0;
    sendJson(res, 200, payload, cacheSeconds);
  } catch (err) {
    const status = errorStatus(err);
    const message = err.message || 'Failed to process assistant request';
    if (wantsStream) {
      streamError(res, status, message);
      return;
    }
    res.status(status).json({ error: message });
  }
});
