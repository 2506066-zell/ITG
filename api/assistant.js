import jwt from 'jsonwebtoken';
import { pool, readBody, verifyToken, logActivity, withErrorHandling, sendJson } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';
import { buildUnifiedMemorySnapshot, normalizeMemoryDate, clampStudyTargetMinutes } from './_unified_memory.js';
import { generateStudyPlanSnapshot, setStudyPreference } from './study_plan.js';

const ASSISTANT_ISSUER = 'cute-futura-assistant';
const ASSISTANT_AUDIENCE = 'cute-futura-assistant';
const WRITE_CONFIRM_EXP = '10m';
const ALLOWED_USERS = new Set(['Zaldy', 'Nesya']);
const PYTHON_ENGINE_ALIASES = new Set(['python', 'py', 'python-v1']);

function parseBooleanEnv(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function isPythonAssistantEngineEnabled() {
  const engine = String(process.env.ASSISTANT_ENGINE || 'js').trim().toLowerCase();
  if (PYTHON_ENGINE_ALIASES.has(engine)) return true;
  return parseBooleanEnv(process.env.ASSISTANT_PYTHON_ENABLED || '');
}

function getPythonBrainEndpoint(req) {
  const explicit = String(process.env.ASSISTANT_BRAIN_URL || '').trim();
  if (explicit) return explicit;

  const host = String(req?.headers?.host || '').trim();
  if (!host) return '';

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api/assistant-brain`;
}

function normalizeBrainClarifications(list = []) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const question = String(item?.question || '').trim();
      if (!question) return null;
      const field = String(item?.field || '').trim().toLowerCase();
      const example = String(item?.example || '').trim();
      return {
        field: field || 'details',
        question,
        example,
      };
    })
    .filter(Boolean)
    .slice(0, 4);
}

function normalizePythonBrainDecision(payload) {
  if (!payload || typeof payload !== 'object' || payload.ok !== true) return null;
  const tool = String(payload.tool || '').trim();
  if (!tool || !Object.prototype.hasOwnProperty.call(TOOLS, tool)) return null;

  const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
  const summary = String(payload.summary || '').trim() || tool;
  const naturalReply = String(payload.natural_reply || payload.reply || '').trim();
  const mode = payload.mode === 'clarification_required' ? 'clarification_required' : TOOLS[tool].mode;

  return {
    tool,
    mode,
    args,
    summary,
    confidence: String(payload.confidence || '').trim().toLowerCase(),
    natural_reply: naturalReply,
    clarifications: normalizeBrainClarifications(payload.clarifications),
  };
}

async function inferIntentWithPythonBrain(req, user, message) {
  if (!isPythonAssistantEngineEnabled()) return null;

  const endpoint = getPythonBrainEndpoint(req);
  if (!endpoint) return null;

  const timeoutMs = Math.max(350, Math.min(2500, Number(process.env.ASSISTANT_BRAIN_TIMEOUT_MS || 1100)));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = { 'Content-Type': 'application/json' };
    const secret = String(process.env.ASSISTANT_BRAIN_SHARED_SECRET || '').trim();
    if (secret) headers['X-Brain-Secret'] = secret;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user: String(user || ''),
        message: String(message || ''),
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json().catch(() => null);
    return normalizePythonBrainDecision(json);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePersonName(raw = '') {
  const name = String(raw || '').trim();
  if (!name) return '';
  const lower = name.toLowerCase();
  return lower[0].toUpperCase() + lower.slice(1);
}

function getPartnerUser(user = '') {
  if (user === 'Zaldy') return 'Nesya';
  if (user === 'Nesya') return 'Zaldy';
  return '';
}

function isPlaceholderTitle(title = '') {
  const clean = String(title || '').trim().toLowerCase();
  if (!clean) return true;
  if (clean.length < 3) return true;
  return /^(task|tugas|todo|to-do|assignment|kuliah|belajar|study)$/i.test(clean);
}

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

function parseNaturalMonthIndex(raw = '') {
  const monthMap = {
    jan: 0, januari: 0, january: 0,
    feb: 1, febr: 1, februari: 1, february: 1, pebruari: 1, febuari: 1,
    mar: 2, maret: 2, march: 2,
    apr: 3, april: 3,
    mei: 4, may: 4,
    jun: 5, juni: 5, june: 5,
    jul: 6, juli: 6, july: 6,
    agu: 7, ags: 7, agt: 7, agustus: 7, august: 7, aug: 7,
    sep: 8, sept: 8, september: 8,
    okt: 9, oktober: 9, october: 9, oct: 9,
    nov: 10, november: 10,
    des: 11, desember: 11, december: 11, dec: 11,
  };
  const key = String(raw || '').trim().toLowerCase().replace(/\.$/, '');
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(monthMap, key) ? monthMap[key] : null;
}

function normalizeYearCandidate(raw = '', fallbackYear = null) {
  if (raw === null || raw === undefined || raw === '') return fallbackYear;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallbackYear;
  if (n < 100) return 2000 + n;
  return n;
}

function buildNaturalDateWithYear(day, monthIndex, explicitYear, now) {
  const d = Number(day);
  const m = Number(monthIndex);
  if (!Number.isFinite(d) || !Number.isFinite(m)) return null;
  if (d < 1 || d > 31 || m < 0 || m > 11) return null;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  let year = Number.isFinite(explicitYear) ? Number(explicitYear) : now.getFullYear();
  let parsed = new Date(year, m, d);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== m || parsed.getDate() !== d) return null;

  if (!Number.isFinite(explicitYear)) {
    const parsedDay = new Date(parsed);
    parsedDay.setHours(0, 0, 0, 0);
    if (parsedDay.getTime() < today.getTime()) {
      year += 1;
      parsed = new Date(year, m, d);
      if (parsed.getFullYear() !== year || parsed.getMonth() !== m || parsed.getDate() !== d) return null;
    }
  }

  return parsed;
}

function parseExplicitTimeParts(text = '') {
  const lower = String(text || '').toLowerCase();
  const colon = lower.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  const word = lower.match(/\b(?:jam|pukul)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b/);
  const picked = word || colon;
  if (!picked) return null;

  let hour = Number(picked[1]);
  let minute = Number(picked[2] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const hasPagi = /\bpagi\b/.test(lower);
  const hasSiang = /\bsiang\b/.test(lower);
  const hasSore = /\b(sore|petang)\b/.test(lower);
  const hasMalam = /\bmalam\b/.test(lower);

  if (hasPagi && hour === 12) hour = 0;
  if ((hasSore || hasMalam) && hour < 12) hour += 12;
  if (hasSiang && hour >= 1 && hour <= 6) hour += 12;

  return { hour, minute };
}

function parseDateFromText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const msg = raw.toLowerCase();
  const now = new Date();
  now.setSeconds(0, 0);
  const explicitTime = parseExplicitTimeParts(msg);
  const fallbackTime = explicitTime || { hour: 21, minute: 0 };
  let base = null;

  const isoDate = msg.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[ t]([01]?\d|2[0-3])[:.]([0-5]\d))?\b/);
  if (isoDate) {
    const y = Number(isoDate[1]);
    const m = Number(isoDate[2]) - 1;
    const d = Number(isoDate[3]);
    const parsed = new Date(y, m, d);
    if (!Number.isNaN(parsed.getTime())) {
      const inlineHour = isoDate[4] !== undefined ? Number(isoDate[4]) : fallbackTime.hour;
      const inlineMinute = isoDate[5] !== undefined ? Number(isoDate[5]) : fallbackTime.minute;
      parsed.setHours(inlineHour, inlineMinute, 0, 0);
      return parsed;
    }
  }

  const taggedYearHint = msg.match(/\b(?:tahun|thn|taun|tahunnya|taunya|year)\s*(20\d{2})\b/);
  const genericYearHint = msg.match(/\b(20\d{2})\b/);
  const yearHint = taggedYearHint
    ? Number(taggedYearHint[1])
    : (genericYearHint ? Number(genericYearHint[1]) : null);

  const dmy = msg.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (dmy) {
    const parsed = buildNaturalDateWithYear(
      Number(dmy[1]),
      Number(dmy[2]) - 1,
      normalizeYearCandidate(dmy[3], yearHint),
      now
    );
    if (parsed && !Number.isNaN(parsed.getTime())) base = parsed;
  }

  if (!base) {
    const dayMonthWord = msg.match(/\b(?:tanggal\s*)?(\d{1,2})\s*(?:[\/.,-]\s*)?([a-z]{3,12})\.?(?:\s*(?:tahun\s*)?(\d{4}))?\b/);
    if (dayMonthWord) {
      const monthIndex = parseNaturalMonthIndex(dayMonthWord[2]);
      if (monthIndex !== null) {
        const parsed = buildNaturalDateWithYear(
          Number(dayMonthWord[1]),
          monthIndex,
          normalizeYearCandidate(dayMonthWord[3], yearHint),
          now
        );
        if (parsed && !Number.isNaN(parsed.getTime())) base = parsed;
      }
    }
  }

  if (!base) {
    const monthDayWord = msg.match(/\b([a-z]{3,12})\.?\s+(\d{1,2})(?:\s*,?\s*(?:tahun\s*)?(\d{4}))?\b/);
    if (monthDayWord) {
      const monthIndex = parseNaturalMonthIndex(monthDayWord[1]);
      if (monthIndex !== null) {
        const parsed = buildNaturalDateWithYear(
          Number(monthDayWord[2]),
          monthIndex,
          normalizeYearCandidate(monthDayWord[3], yearHint),
          now
        );
        if (parsed && !Number.isNaN(parsed.getTime())) base = parsed;
      }
    }
  }

  if (!base) {
    if (/(lusa|day after tomorrow)/i.test(msg)) {
      base = new Date(now);
      base.setDate(base.getDate() + 2);
    } else if (/(besok|tomorrow)/i.test(msg)) {
      base = new Date(now);
      base.setDate(base.getDate() + 1);
    } else if (/(hari ini|today)/i.test(msg)) {
      base = new Date(now);
    }
  }

  if (!base) {
    if (!explicitTime) return null;
    base = new Date(now);
    base.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
    if (base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
    return base;
  }

  base.setHours(fallbackTime.hour, fallbackTime.minute, 0, 0);
  if (Number.isNaN(base.getTime())) return null;
  return base;

}

function parseCreateTaskPayload(message = '') {
  const original = message.trim();
  const priorityMatch = original.match(/(?:priority|prioritas)\s*(high|medium|low|tinggi|sedang|rendah)/i);
  const assignedMatch = original.match(/(?:assign(?:ed)?\s*to|untuk|for)\s*(zaldy|nesya)\b/i);
  const goalMatch = original.match(/(?:goal|tujuan)\s*#?(\d+)/i);
  const deadline = parseDateFromText(original);

  let title = original.replace(/^(?:buat|buatkan|tambah|add|create|catat|ingatin|ingatkan)\s+(?:task|tugas)\s*/i, '').trim();
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
    .replace(/^(?:buat|buatkan|tambah|add|create|catat|ingatin|ingatkan)\s+(?:assignment|tugas kuliah)\s*/i, '')
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

function parseMemoryGraphArgs(message = '') {
  const date = parseDateFromText(message);
  return {
    date: date ? toDateText(date) : null,
  };
}

function parseDeadlineRiskArgs(message = '') {
  const hit = message.match(/(\d{1,3})\s*(?:jam|hours|hour)\b/i);
  const horizonHours = hit ? Math.max(6, Math.min(168, Number(hit[1]))) : 48;
  return { horizon_hours: horizonHours };
}

function parseCoupleCoordinationArgs(message = '') {
  const lower = message.toLowerCase();
  return {
    include_assignments: !/\b(tanpa assignment|tanpa tugas kuliah|no assignment)\b/i.test(lower),
    include_tasks: !/\b(tanpa task|tanpa tugas|no task)\b/i.test(lower),
  };
}

function parseNudgePartnerPayload(message = '', user = '') {
  const original = message.trim();
  const explicitPartner = original.match(/\b(zaldy|nesya)\b/i);
  const normalizedPartner = normalizePersonName(explicitPartner?.[1] || '');
  const fallbackPartner = getPartnerUser(user);
  const partner = ALLOWED_USERS.has(normalizedPartner) ? normalizedPartner : fallbackPartner;
  const urgency = /(urgent|asap|penting|sekarang)/i.test(original) ? 'urgent' : 'normal';

  let topic = original
    .replace(/^(?:tolong|please|pls|bisa|minta|coba|ajak|nudge|ingatkan|ping|remind)\s*/i, '')
    .replace(/\b(check-?in|sync|koordinasi|pasangan|partner|couple)\b/ig, '')
    .replace(/\b(zaldy|nesya)\b/ig, '')
    .replace(/\b(urgent|asap|penting|sekarang)\b/ig, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!topic) topic = 'status hari ini + 1 kebutuhan support';

  return {
    partner,
    topic,
    urgency,
  };
}

function parseReminderTargetUser(message = '', user = '') {
  const lower = String(message || '').toLowerCase();
  if (/\bnesya\b/.test(lower)) return 'Nesya';
  if (/\bzaldy\b/.test(lower)) return 'Zaldy';
  if (/\b(pasangan|partner|couple)\b/.test(lower)) return getPartnerUser(user) || user;
  if (/\b(saya|aku|gue|gw|me)\b/.test(lower)) return user;
  return user;
}

function stripReminderMetaFromText(message = '') {
  let value = String(message || '').trim();
  value = value.replace(/^\/ai\s+/i, '');
  value = value.replace(/^(?:tolong|please|pls|bisa|boleh|minta|coba)\s*/i, '');
  value = value.replace(/^(?:z\s*ai|zai|ai)\s*/i, '');
  value = value.replace(/^(?:(?:buat|buatkan|atur|set|tambah|create)\s+)?(?:pengingat|reminder|alarm|notifikasi|ingatkan|ingetin)\s*/i, '');
  value = value.replace(/\b(?:untuk|ke)\s+(?:saya|aku|gue|gw|me|pasangan|partner|couple|zaldy|nesya)\b/ig, ' ');
  value = value.replace(/\b(?:dalam\s+)?\d{1,3}\s*(?:menit|min|jam|hours?)\s*(?:lagi)?\b/ig, ' ');
  value = value.replace(/\b(?:besok|lusa|hari ini|today|tomorrow|day after tomorrow)\b/ig, ' ');
  value = value.replace(/\b(?:pagi|siang|sore|petang|malam)\b/ig, ' ');
  value = value.replace(/\b(?:pukul|jam)\s*(?:\d{1,2}(?:[:.]\d{2})?)?\b/ig, ' ');
  value = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  value = value.replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, ' ');
  value = value.replace(/\btanggal\s+\d{1,2}\s*[a-z]{3,12}\b/ig, ' ');
  value = value.replace(/[,:-]+/g, ' ');
  value = value.replace(/\s{2,}/g, ' ').trim();
  value = value.replace(/^(?:untuk|soal|tentang)\s+/i, '').trim();
  return value;
}

function parseReminderText(message = '') {
  const direct = String(message || '').match(
    /\b(?:untuk|soal|tentang)\s+(.+?)(?=\s+\b(?:dalam\s+\d{1,3}\s*(?:menit|min|jam)|hari ini|today|besok|tomorrow|lusa|day after tomorrow|pukul|jam|tanggal|\d{1,2}[:.]\d{2}|\d{4}-\d{2}-\d{2})\b|$)/i
  );
  let picked = direct ? String(direct[1] || '') : '';
  picked = picked.replace(/\b(?:saya|aku|gue|gw|me|pasangan|partner|couple|zaldy|nesya)\b/ig, ' ').trim();
  picked = picked.replace(/\s{2,}/g, ' ').trim();
  if (picked) return picked;
  const cleaned = stripReminderMetaFromText(message);
  return cleaned || 'lanjutkan prioritas utama';
}

function parseReminderPayload(message = '', user = '') {
  const date = parseDateFromText(message);
  return {
    reminder_text: parseReminderText(message),
    remind_at: date ? date.toISOString() : null,
    target_user: parseReminderTargetUser(message, user),
  };
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

  if (/(check-?in|sync|koordinasi)/i.test(lower) && /(pasangan|partner|couple)/i.test(lower) && /(ingatkan|nudge|ajak|ping|remind|notif|notifikasi)/i.test(lower)) {
    return {
      tool: 'nudge_partner_checkin',
      mode: 'write',
      args: parseNudgePartnerPayload(msg),
      summary: 'Kirim nudge check-in ke pasangan',
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
  const actionStartRegex = /(?:^|\s)(?:(?:buat|tambah|add|create)\s+(?:task|tugas|assignment|tugas kuliah)\b|(?:selesaikan|complete|done|tandai)\s+(?:task|tugas|assignment|tugas kuliah)\b|(?:ubah|update|ganti|reschedule|geser)\s+(?:deadline|due)\b|(?:geser|pindah|reschedule)\s+(?:sesi belajar|study session|jadwal belajar|study plan)\b|(?:atur|set|ubah|ganti)\s+(?:target belajar|study target|mode belajar|window belajar|atur belajar|set belajar)\b|(?:ingatkan|nudge|ajak|ping|remind)\s+(?:pasangan|partner|couple)\b|(?:task|tugas|assignment|tugas kuliah)\b)/gi;

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
  if (toolName === 'nudge_partner_checkin' && !out.partner) {
    out.partner = getPartnerUser(user);
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

function detectIntent(message = '', user = '') {
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

  if (isLikelyCreateShorthandSegment(msg, 'task')) {
    return {
      tool: 'create_task',
      mode: 'write',
      args: parseCreateTaskPayload(`buat task ${msg}`),
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

  if (isLikelyCreateShorthandSegment(msg, 'assignment')) {
    return {
      tool: 'create_assignment',
      mode: 'write',
      args: parseCreateAssignmentPayload(`buat assignment ${msg}`),
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

  if (/(memory graph|knowledge graph|graph memory|relasi konteks|peta konteks|context graph)/i.test(lower)) {
    return {
      tool: 'get_memory_graph',
      mode: 'read',
      args: parseMemoryGraphArgs(msg),
      summary: 'Lihat unified memory graph',
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

  if (/(check-?in|sync|koordinasi)/i.test(lower) && /(pasangan|partner|couple)/i.test(lower) && /(ingatkan|nudge|ajak|ping|remind|notif|notifikasi)/i.test(lower)) {
    return {
      tool: 'nudge_partner_checkin',
      mode: 'write',
      args: parseNudgePartnerPayload(msg, user),
      summary: 'Kirim nudge check-in ke pasangan',
    };
  }

  if (/(couple|pasangan|partner|berdua)/i.test(lower) && /(pulse|koordinasi|sync|beban|workload|status|radar|balance)/i.test(lower)) {
    return {
      tool: 'get_couple_coordination',
      mode: 'read',
      args: parseCoupleCoordinationArgs(msg),
      summary: 'Lihat koordinasi couple',
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

  if (/(risk|resiko|risiko|prediksi|berisiko|rawan|telat|terlambat|gagal)/i.test(lower) && /(deadline|task|tugas|assignment|kuliah)/i.test(lower)) {
    return {
      tool: 'get_deadline_risk',
      mode: 'read',
      args: parseDeadlineRiskArgs(msg),
      summary: 'Prediksi risiko deadline',
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

  if (/(ingatkan|ingetin|reminder|alarm|notifikasi|jangan lupa)/i.test(lower)) {
    return {
      tool: 'set_reminder',
      mode: 'write',
      args: parseReminderPayload(msg, user),
      summary: 'Atur reminder',
    };
  }

  return {
    tool: 'help',
    mode: 'read',
    args: {},
    summary: 'Bantuan asisten',
  };
}

function buildClarifyIssue(field, question, example = '') {
  return {
    field,
    question,
    example,
  };
}

function validateWriteIntentArgs(toolName, args = {}, opts = {}) {
  const issues = [];
  const prefix = opts.prefix ? `${opts.prefix}: ` : '';

  if (toolName === 'create_task') {
    const title = String(args.title || '').trim();
    if (isPlaceholderTitle(title)) {
      issues.push(buildClarifyIssue('title', `${prefix}Judul task-nya apa?`, 'buat task review basis data deadline besok 19:00 priority high'));
    }
    if (!args.deadline) {
      issues.push(buildClarifyIssue('deadline', `${prefix}Deadline task kapan?`, 'buat task review basis data deadline besok 19:00 priority high'));
    }
    return issues;
  }

  if (toolName === 'create_assignment') {
    const title = String(args.title || '').trim();
    if (isPlaceholderTitle(title)) {
      issues.push(buildClarifyIssue('title', `${prefix}Judul assignment-nya apa?`, 'buat assignment makalah AI deadline 2026-03-01 20:00'));
    }
    if (!args.deadline) {
      issues.push(buildClarifyIssue('deadline', `${prefix}Deadline assignment kapan?`, 'buat assignment makalah AI deadline 2026-03-01 20:00'));
    }
    return issues;
  }

  if (toolName === 'update_task_deadline') {
    if (!Number(args.id)) {
      issues.push(buildClarifyIssue('id', `${prefix}Task mana yang mau diubah deadlinenya?`, 'ubah deadline task 12 besok 20:00'));
    }
    if (!args.deadline) {
      issues.push(buildClarifyIssue('deadline', `${prefix}Deadline barunya kapan?`, 'ubah deadline task 12 besok 20:00'));
    }
    return issues;
  }

  if (toolName === 'complete_task') {
    if (!Number(args.id)) {
      issues.push(buildClarifyIssue('id', `${prefix}Task ID berapa yang mau diselesaikan?`, 'selesaikan task 12'));
    }
    return issues;
  }

  if (toolName === 'complete_assignment') {
    if (!Number(args.id)) {
      issues.push(buildClarifyIssue('id', `${prefix}Assignment ID berapa yang mau diselesaikan?`, 'selesaikan assignment 5'));
    }
    return issues;
  }

  if (toolName === 'set_study_preferences') {
    if (args.target_minutes === undefined && !args.preferred_window) {
      issues.push(buildClarifyIssue('study_preferences', `${prefix}Mau ubah target menit atau window belajar?`, 'atur target belajar 180 menit'));
    }
    return issues;
  }

  if (toolName === 'nudge_partner_checkin') {
    const partner = normalizePersonName(args.partner || '');
    if (!partner || !ALLOWED_USERS.has(partner)) {
      issues.push(buildClarifyIssue('partner', `${prefix}Mau kirim nudge ke siapa, Zaldy atau Nesya?`, 'ingatkan pasangan Nesya check-in malam ini'));
    }
    return issues;
  }

  if (toolName === 'set_reminder') {
    const text = String(args.reminder_text || '').trim();
    if (!text) {
      issues.push(buildClarifyIssue('reminder_text', `${prefix}Apa yang mau diingatkan?`, 'ingatkan aku bayar listrik besok 19:00'));
    }
    if (!args.remind_at) {
      issues.push(buildClarifyIssue('remind_at', `${prefix}Kapan pengingatnya?`, 'ingatkan aku besok 19:00'));
    }
    return issues;
  }

  if (toolName === 'execute_action_bundle') {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (actions.length < 2) {
      issues.push(buildClarifyIssue('actions', 'Bundle minimal berisi 2 aksi write.', 'buat task ... lalu buat assignment ...'));
      return issues;
    }
    actions.forEach((action, idx) => {
      const actionTool = String(action?.tool || '').trim();
      if (!actionTool) {
        issues.push(buildClarifyIssue(`actions[${idx}]`, `Aksi ${idx + 1} belum valid.`, 'buat task ...'));
        return;
      }
      const nested = validateWriteIntentArgs(actionTool, action.args || {}, { prefix: `Aksi ${idx + 1}` });
      issues.push(...nested);
    });
    return issues;
  }

  return issues;
}

function buildClarificationResponse(intent, originalMessage = '') {
  const issues = validateWriteIntentArgs(intent?.tool || '', intent?.args || {});
  if (!issues.length) return null;

  const quick = issues
    .map((item) => item.example)
    .filter(Boolean)
    .slice(0, 4)
    .map((cmd) => `/ai ${cmd}`);
  const firstQuestions = issues.slice(0, 3).map((q, i) => `${i + 1}. ${q.question}`).join(' ');

  return {
    ok: true,
    mode: 'clarification_required',
    tool: intent.tool,
    tool_calls: [{ name: intent.tool, mode: 'write', args: intent.args || {} }],
    reply: `Aku butuh klarifikasi sebelum eksekusi write. ${firstQuestions}`.trim(),
    clarifications: issues,
    suggested_commands: quick,
    preview: {
      summary: intent.summary || intent.tool,
      args: intent.args || {},
      original_message: originalMessage,
    },
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

function clampInt(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function deadlineRiskModel(item = {}, kind = 'task') {
  const hrs = hoursUntil(item.deadline);
  if (hrs === null) {
    return { risk_score: 24, risk_band: 'low', hours_left: null };
  }

  let score = 0;
  if (hrs <= 0) score += 85;
  else if (hrs <= 6) score += 70;
  else if (hrs <= 12) score += 56;
  else if (hrs <= 24) score += 42;
  else if (hrs <= 48) score += 30;
  else score += 18;

  const pr = String(item.priority || '').toLowerCase();
  if (pr === 'high') score += 14;
  else if (pr === 'medium') score += 6;

  if (kind === 'assignment') score += 6;

  score = clampInt(Math.round(score), 0, 100);
  let band = 'low';
  if (score >= 75) band = 'critical';
  else if (score >= 55) band = 'high';
  else if (score >= 35) band = 'medium';

  return {
    risk_score: score,
    risk_band: band,
    hours_left: Number(hrs.toFixed(2)),
  };
}

function enrichItemsWithRisk(items = [], kind = 'task') {
  return (Array.isArray(items) ? items : []).map((item) => ({
    ...item,
    ...deadlineRiskModel(item, kind),
  }));
}

function summarizeRiskBands(items = []) {
  const summary = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const item of items) {
    const band = String(item?.risk_band || 'low').toLowerCase();
    if (summary[band] === undefined) continue;
    summary[band] += 1;
  }
  return summary;
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

  if (toolName === 'get_deadline_risk') {
    const items = Array.isArray(data?.items) ? data.items : [];
    const summary = data?.summary || summarizeRiskBands(items);
    const top = items[0] || null;
    return {
      why: [
        `Model risiko mengevaluasi ${items.length} item dalam horizon ${Number(data?.horizon_hours || 48)} jam.`,
        `Distribusi risiko: critical=${Number(summary.critical || 0)}, high=${Number(summary.high || 0)}, medium=${Number(summary.medium || 0)}.`,
      ],
      impact: 'Deteksi dini risiko deadline membantu replan sebelum telat.',
      risk: Number(summary.critical || 0) > 0
        ? `${Number(summary.critical || 0)} item masuk zona critical.`
        : (Number(summary.high || 0) > 0 ? `${Number(summary.high || 0)} item berisiko tinggi.` : 'Tidak ada risiko kritis pada horizon ini.'),
      recommended_action: top
        ? `Eksekusi "${top.title}" dulu (${top.risk_band}, score ${top.risk_score}).`
        : 'Pertahankan ritme eksekusi dan cek ulang risiko sore ini.',
      confidence: items.length > 0 ? 'high' : 'medium',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_memory_graph') {
    const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const edges = Array.isArray(data?.edges) ? data.edges : [];
    const focus = data?.focus_recommendation || '';
    return {
      why: [
        `Graph memori membentuk ${nodes.length} node dan ${edges.length} edge dari snapshot lintas konteks.`,
        `Signal utama: task=${Number(data?.counters?.tasks_pending || 0)}, assignment=${Number(data?.counters?.assignments_pending || 0)}, mood7d=${Number(data?.mood?.avg_7d || 0).toFixed(2)}.`,
      ],
      impact: 'Relasi konteks membantu assistant melakukan reasoning lintas domain dengan lebih konsisten.',
      risk: Number(data?.counters?.urgent_items || 0) > 0
        ? `Ada ${Number(data?.counters?.urgent_items || 0)} item urgent di graph saat ini.`
        : 'Graph saat ini stabil tanpa lonjakan urgent besar.',
      recommended_action: focus || 'Jalankan fokus rekomendasi dari memory snapshot hari ini.',
      confidence: 'high',
      generated_at: nowIso,
    };
  }

  if (toolName === 'get_couple_coordination') {
    const me = data?.me || {};
    const partner = data?.partner || {};
    const reco = data?.recommendation || {};
    return {
      why: [
        `Load index ${me.user || user}=${Number(me.load_index || 0)} vs ${partner.user || 'partner'}=${Number(partner.load_index || 0)}.`,
        `Signal kritis couple: overdue=${Number(me.overdue || 0) + Number(partner.overdue || 0)}, critical12h=${Number(me.critical_12h || 0) + Number(partner.critical_12h || 0)}.`,
      ],
      impact: 'Koordinasi beban berdua mengurangi bottleneck dan menstabilkan progress harian.',
      risk: Number(me.overdue || 0) + Number(partner.overdue || 0) > 0
        ? 'Ada item overdue pada couple timeline, perlu realokasi segera.'
        : 'Risiko couple flow moderat dan bisa dikendalikan via check-in rutin.',
      recommended_action: reco.suggested_action || 'Jalankan sync 5 menit malam ini.',
      confidence: 'high',
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
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const assignments = Array.isArray(data.assignments) ? data.assignments : [];
    const schedule = Array.isArray(data.schedule) ? data.schedule : [];
    const merged = [...tasks, ...assignments];
    const risk = analyzeDeadlineRisk(merged);
    const top = risk.nearest;

    if (merged.length === 0 && schedule.length === 0) {
      return 'Z AI cek cepat: hari ini relatif longgar. Belum ada tugas atau jadwal yang menekan.';
    }

    const riskText = risk.overdue > 0
      ? `${risk.overdue} item sudah overdue, ini perlu diselamatkan dulu.`
      : (risk.due12h > 0
        ? `${risk.due12h} item due <=12 jam, sebaiknya dieksekusi sekarang.`
        : (risk.due24h > 0 ? `${risk.due24h} item due <=24 jam, jangan ditunda.` : 'Tekanan deadline masih aman.'));

    const nextStep = top && top.title
      ? `Mulai dari "${top.title}" selama 25 menit.`
      : 'Ambil satu prioritas teratas dan jalankan sprint 25 menit.';

    return `Z AI cek cepat: ada ${tasks.length} task, ${assignments.length} assignment, dan ${schedule.length} jadwal hari ini. ${riskText} ${nextStep}`;
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

  if (toolName === 'get_deadline_risk') {
    const s = data.summary || {};
    const top = Array.isArray(data.items) && data.items.length ? data.items[0] : null;
    const topLabel = top ? `Top risk: [${top.source}] ${top.title} (${top.risk_band}/${top.risk_score}).` : 'Tidak ada item berisiko pada horizon ini.';
    return `Risk horizon ${data.horizon_hours || 48} jam -> critical ${s.critical || 0}, high ${s.high || 0}, medium ${s.medium || 0}. ${topLabel}`;
  }

  if (toolName === 'get_memory_graph') {
    const nodes = Array.isArray(data.nodes) ? data.nodes.length : 0;
    const edges = Array.isArray(data.edges) ? data.edges.length : 0;
    return `Memory graph ${data.date}: ${nodes} nodes, ${edges} edges. Focus: ${data.focus_recommendation || 'stabilkan prioritas utama hari ini.'}`;
  }

  if (toolName === 'get_couple_coordination') {
    const me = data.me || {};
    const partner = data.partner || {};
    const reco = data.recommendation || {};
    return `Couple pulse: ${me.user || user} load ${me.load_index || 0} vs ${partner.user || 'partner'} ${partner.load_index || 0}. ${reco.summary || ''} ${reco.suggested_action || ''}`.trim();
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

  const items = enrichItemsWithRisk(r.rows, 'task');
  return { items, risk_summary: summarizeRiskBands(items) };
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
  const items = enrichItemsWithRisk(r.rows, 'assignment');
  return { items, risk_summary: summarizeRiskBands(items) };
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

  const riskItems = enrichItemsWithRisk([
    ...tasks.rows.map((item) => ({ ...item, _kind: 'task' })),
    ...assignments.rows.map((item) => ({ ...item, _kind: 'assignment' })),
  ]);

  return {
    day_id: dayId,
    tasks: enrichItemsWithRisk(tasks.rows, 'task'),
    assignments: enrichItemsWithRisk(assignments.rows, 'assignment'),
    schedule: schedule.rows,
    risk_summary: summarizeRiskBands(riskItems),
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

async function toolGetDeadlineRisk(ctx, args = {}) {
  const horizonHours = clampLimit(args.horizon_hours, 48, 6, 168);
  const horizonIso = new Date(Date.now() + horizonHours * 3600000).toISOString();

  const [tasks, assignments] = await Promise.all([
    pool.query(
      `SELECT id, title, priority, deadline, assigned_to, goal_id
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND (assigned_to = $1 OR created_by = $1)
         AND deadline IS NOT NULL
         AND deadline <= $2
       ORDER BY deadline ASC
       LIMIT 20`,
      [ctx.user, horizonIso]
    ),
    pool.query(
      `SELECT id, title, deadline, assigned_to
       FROM assignments
       WHERE completed = FALSE
         AND (assigned_to = $1 OR assigned_to IS NULL)
         AND deadline IS NOT NULL
         AND deadline <= $2
       ORDER BY deadline ASC
       LIMIT 20`,
      [ctx.user, horizonIso]
    ),
  ]);

  const taskRisk = enrichItemsWithRisk(tasks.rows, 'task')
    .map((item) => ({ ...item, source: 'task' }));
  const assignmentRisk = enrichItemsWithRisk(assignments.rows, 'assignment')
    .map((item) => ({ ...item, source: 'assignment', priority: item.priority || 'medium' }));

  const items = [...taskRisk, ...assignmentRisk]
    .sort((a, b) => Number(b.risk_score || 0) - Number(a.risk_score || 0))
    .slice(0, 20);

  return {
    horizon_hours: horizonHours,
    items,
    summary: summarizeRiskBands(items),
    counts: {
      task: taskRisk.length,
      assignment: assignmentRisk.length,
    },
    generated_at: new Date().toISOString(),
  };
}

async function toolGetMemoryGraph(ctx, args = {}) {
  const date = normalizeMemoryDate(args.date || '');
  const snapshot = await buildUnifiedMemorySnapshot(ctx.user, { date });
  const partner = getPartnerUser(ctx.user);
  const [meLoad, partnerLoad] = await Promise.all([
    readUserWorkload(ctx.user, { includeTasks: true, includeAssignments: true }),
    partner ? readUserWorkload(partner, { includeTasks: true, includeAssignments: true }) : Promise.resolve(null),
  ]);

  const counters = snapshot.counters || {};
  const nodes = [
    { id: `person:${ctx.user}`, type: 'person', label: ctx.user },
    { id: `memory:${snapshot.date}`, type: 'memory', label: `Memory ${snapshot.date}` },
    { id: 'work:tasks', type: 'work', label: `Tasks ${Number(counters.tasks_pending || 0)}` },
    { id: 'work:assignments', type: 'work', label: `Assignments ${Number(counters.assignments_pending || 0)}` },
    { id: 'energy:mood', type: 'energy', label: `Mood ${Number(snapshot.mood?.avg_7d || 0).toFixed(2)}` },
    { id: 'focus:study', type: 'focus', label: `Study ${Number(counters.study_done_minutes || 0)}m` },
  ];
  if (partnerLoad) {
    nodes.push({ id: `person:${partnerLoad.user}`, type: 'person', label: partnerLoad.user });
  }

  const edges = [
    { from: `person:${ctx.user}`, to: `memory:${snapshot.date}`, relation: 'has_snapshot', weight: 1 },
    { from: `memory:${snapshot.date}`, to: 'work:tasks', relation: 'tracks', weight: Number(counters.tasks_pending || 0) },
    { from: `memory:${snapshot.date}`, to: 'work:assignments', relation: 'tracks', weight: Number(counters.assignments_pending || 0) },
    { from: `memory:${snapshot.date}`, to: 'energy:mood', relation: 'tracks', weight: Number(snapshot.mood?.avg_7d || 0) },
    { from: `memory:${snapshot.date}`, to: 'focus:study', relation: 'tracks', weight: Number(counters.study_done_minutes || 0) },
  ];

  if (partnerLoad) {
    edges.push({
      from: `person:${ctx.user}`,
      to: `person:${partnerLoad.user}`,
      relation: 'couple_balance',
      weight: Math.abs(Number(meLoad.pending_total || 0) - Number(partnerLoad.pending_total || 0)),
    });
  }

  return {
    date: snapshot.date,
    nodes,
    edges,
    counters: snapshot.counters || {},
    mood: snapshot.mood || {},
    streak: snapshot.streak || {},
    focus_recommendation: snapshot.assistant_memory?.focus_recommendation || '',
    couple_load: {
      me: meLoad,
      partner: partnerLoad,
    },
    generated_at: new Date().toISOString(),
  };
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

function computeLoadIndex(load = {}) {
  const pending = Number(load.pending_total || 0);
  const warning = Number(load.warning_24h || 0);
  const critical = Number(load.critical_12h || 0);
  const overdue = Number(load.overdue || 0);
  return pending + warning + critical * 2 + overdue * 3;
}

async function readUserWorkload(user, { includeTasks = true, includeAssignments = true } = {}) {
  const nowIso = new Date().toISOString();
  const in24hIso = new Date(Date.now() + 24 * 3600000).toISOString();
  const in12hIso = new Date(Date.now() + 12 * 3600000).toISOString();

  let task = { pending: 0, warning_24h: 0, critical_12h: 0, overdue: 0 };
  let assignment = { pending: 0, warning_24h: 0, critical_12h: 0, overdue: 0 };

  if (includeTasks) {
    const taskRes = await pool.query(
      `SELECT
         COUNT(*)::int AS pending,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $2 AND deadline <= $3)::int AS warning_24h,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $2 AND deadline <= $4)::int AS critical_12h,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= $2)::int AS overdue
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND (assigned_to = $1 OR created_by = $1)`,
      [user, nowIso, in24hIso, in12hIso]
    );
    task = taskRes.rows[0] || task;
  }

  if (includeAssignments) {
    const assignmentRes = await pool.query(
      `SELECT
         COUNT(*)::int AS pending,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $2 AND deadline <= $3)::int AS warning_24h,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline > $2 AND deadline <= $4)::int AS critical_12h,
         COUNT(*) FILTER (WHERE deadline IS NOT NULL AND deadline <= $2)::int AS overdue
       FROM assignments
       WHERE completed = FALSE
         AND assigned_to = $1`,
      [user, nowIso, in24hIso, in12hIso]
    );
    assignment = assignmentRes.rows[0] || assignment;
  }

  return {
    user,
    include_tasks: includeTasks,
    include_assignments: includeAssignments,
    task_pending: Number(task.pending || 0),
    assignment_pending: Number(assignment.pending || 0),
    warning_24h: Number(task.warning_24h || 0) + Number(assignment.warning_24h || 0),
    critical_12h: Number(task.critical_12h || 0) + Number(assignment.critical_12h || 0),
    overdue: Number(task.overdue || 0) + Number(assignment.overdue || 0),
    pending_total: Number(task.pending || 0) + Number(assignment.pending || 0),
  };
}

function buildCoupleRecommendation(me, partner) {
  const meIndex = computeLoadIndex(me);
  const partnerIndex = computeLoadIndex(partner);
  const gap = meIndex - partnerIndex;
  const heavy = gap >= 2 ? me : gap <= -2 ? partner : null;
  const support = heavy && heavy.user === me.user ? partner : heavy ? me : null;

  let summary = 'Beban couple relatif seimbang. Lanjutkan check-in singkat malam ini.';
  let suggestedAction = 'Jalankan sync 5 menit: status + 1 blocker + next action.';

  if (heavy && support) {
    summary = `${heavy.user} sedang lebih padat dari ${support.user}.`;
    suggestedAction = `Minta ${support.user} bantu 1 quick win atau 1 task administratif dari ${heavy.user}.`;
  } else if (Number(me.critical_12h || 0) + Number(partner.critical_12h || 0) > 0) {
    summary = 'Ada deadline kritis <=12 jam pada couple timeline.';
    suggestedAction = 'Pakai mode emergency: kerjakan item kritis dulu, chat singkat setelahnya.';
  }

  const balanceRaw = 100 - Math.min(100, Math.abs(gap) * 12);
  return {
    load_gap: gap,
    balance_score: Math.max(0, Math.round(balanceRaw)),
    summary,
    suggested_action: suggestedAction,
    suggested_supporter: support ? support.user : '',
    suggested_focus_owner: heavy ? heavy.user : '',
  };
}

async function toolGetCoupleCoordination(ctx, args = {}) {
  const partner = getPartnerUser(ctx.user);
  if (!partner) {
    const err = new Error('Partner user tidak terdeteksi untuk akun ini.');
    err.statusCode = 400;
    throw err;
  }

  const includeTasks = args.include_tasks !== false;
  const includeAssignments = args.include_assignments !== false;

  const [meLoad, partnerLoad] = await Promise.all([
    readUserWorkload(ctx.user, { includeTasks, includeAssignments }),
    readUserWorkload(partner, { includeTasks, includeAssignments }),
  ]);

  const recommendation = buildCoupleRecommendation(meLoad, partnerLoad);
  return {
    me: { ...meLoad, load_index: computeLoadIndex(meLoad) },
    partner: { ...partnerLoad, load_index: computeLoadIndex(partnerLoad) },
    recommendation,
    generated_at: new Date().toISOString(),
  };
}

async function toolNudgePartnerCheckin(ctx, args = {}) {
  const fallbackPartner = getPartnerUser(ctx.user);
  const normalizedPartner = normalizePersonName(args.partner || '');
  const partner = ALLOWED_USERS.has(normalizedPartner) ? normalizedPartner : fallbackPartner;
  if (!partner || !ALLOWED_USERS.has(partner) || partner === ctx.user) {
    const err = new Error('Partner check-in target tidak valid.');
    err.statusCode = 400;
    throw err;
  }

  const topic = String(args.topic || '').trim() || 'status hari ini + 1 kebutuhan support';
  const urgency = String(args.urgency || 'normal').toLowerCase() === 'urgent' ? 'urgent' : 'normal';
  const title = urgency === 'urgent' ? 'Couple Check-In Urgent' : 'Couple Check-In';
  const body = `${ctx.user} ngajak check-in: ${topic}.`;

  await sendNotificationToUser(partner, {
    title,
    body,
    data: { url: '/chat' },
    url: '/chat',
    tag: 'couple-checkin',
    actions: [
      { action: 'open-chat', title: 'Open Chat' },
      { action: 'open', title: 'Lihat Detail' },
    ],
  });

  return {
    sender: ctx.user,
    partner,
    topic,
    urgency,
    sent: true,
  };
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

async function toolSetReminder(ctx, args = {}) {
  const reminderText = String(args.reminder_text || '').trim() || 'lanjutkan prioritas utama';
  const targetUserRaw = String(args.target_user || '').trim();
  const targetUser = ALLOWED_USERS.has(targetUserRaw) ? targetUserRaw : ctx.user;
  const remindAt = args.remind_at ? new Date(args.remind_at) : null;
  if (args.remind_at && (!remindAt || Number.isNaN(remindAt.getTime()))) {
    const err = new Error('Format waktu pengingat tidak valid');
    err.statusCode = 400;
    throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO z_ai_reminders (
         user_id, target_user, reminder_text, remind_at, status, source_command, payload, created_at
       ) VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, NOW())
       RETURNING id, user_id, target_user, reminder_text, remind_at, status`,
      [
        ctx.user,
        targetUser,
        reminderText,
        remindAt,
        '',
        JSON.stringify({ source: 'assistant_tool', kind: 'set_reminder' }),
      ]
    );
    const row = inserted.rows[0] || {};
    await logActivity(client, 'reminder', row.id, 'CREATE', ctx.user, {
      reminder_text: row.reminder_text || reminderText,
      remind_at: row.remind_at || (remindAt ? remindAt.toISOString() : null),
      target_user: row.target_user || targetUser,
      source: 'assistant_tool',
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
        'Memory graph: "tampilkan memory graph hari ini"',
        'Study plan: "jadwal belajar besok pagi"',
        'Deadline risk: "risk deadline 48 jam ke depan"',
        'Set target belajar: "atur target belajar 180 menit"',
        'Re-plan study: "geser sesi belajar malam ini ke besok pagi"',
        'Couple coordination: "lihat couple pulse hari ini"',
        'Nudge pasangan: "ingatkan pasangan check-in malam ini"',
        'Bundle multi-aksi: "buat task ... dan buat assignment ... dan atur target belajar 180 menit"',
        'Bundle chat-like: "tolong buat task revisi bab 2 besok 19:00 buat assignment AI minggu depan lalu atur target belajar 200 menit"',
        'Write dieksekusi langsung tanpa /confirm. Jika detail kurang (mis. deadline), assistant akan minta klarifikasi dulu.',
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
  get_memory_graph: { mode: 'read', run: toolGetMemoryGraph },
  get_study_plan: { mode: 'read', run: toolGetStudyPlan },
  get_deadline_risk: { mode: 'read', run: toolGetDeadlineRisk },
  get_couple_coordination: { mode: 'read', run: toolGetCoupleCoordination },
  execute_action_bundle: { mode: 'write', run: toolExecuteActionBundle },
  create_task: { mode: 'write', run: toolCreateTask },
  create_assignment: { mode: 'write', run: toolCreateAssignment },
  set_reminder: { mode: 'write', run: toolSetReminder },
  update_task_deadline: { mode: 'write', run: toolUpdateTaskDeadline },
  complete_task: { mode: 'write', run: toolCompleteTask },
  complete_assignment: { mode: 'write', run: toolCompleteAssignment },
  set_study_preferences: { mode: 'write', run: toolSetStudyPreferences },
  replan_study_window: { mode: 'write', run: toolReplanStudyWindow },
  nudge_partner_checkin: { mode: 'write', run: toolNudgePartnerCheckin },
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

  if (toolName === 'set_reminder') {
    const item = result.item || {};
    const who = item.target_user || item.user_id || '';
    return `Reminder disimpan: #${item.id} "${item.reminder_text || ''}" untuk ${who} pada ${formatDeadline(item.remind_at)}`;
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

  if (toolName === 'nudge_partner_checkin') {
    return `Nudge check-in terkirim ke ${result.partner}: ${result.topic}.`;
  }

  return 'Aksi write berhasil dijalankan.';
}

function buildExecutionFrame({ mode = '', tool = '', summary = '', args = {}, explainability = null, clarifications = [] } = {}) {
  const plan = [];
  if (mode === 'clarification_required') {
    plan.push('Parse intent');
    plan.push('Validate required fields');
    plan.push('Request missing details');
  } else if (mode === 'write_executed') {
    plan.push('Parse intent');
    plan.push('Validate payload');
    plan.push(`Execute ${tool}`);
    plan.push('Return write result');
  } else {
    plan.push('Parse request');
    plan.push(`Run read tool ${tool}`);
    plan.push('Summarize + explain');
  }

  const criticChecks = [];
  if (mode === 'clarification_required') {
    criticChecks.push(`Missing fields: ${clarifications.map((x) => x.field).filter(Boolean).join(', ') || 'unknown'}`);
    criticChecks.push('Execution blocked until required slots are complete');
  } else {
    criticChecks.push('Intent mapped to a valid tool');
    criticChecks.push('Tool execution finished without thrown error');
    if (explainability && explainability.risk) {
      criticChecks.push(`Risk signal: ${explainability.risk}`);
    }
  }

  const quality = mode === 'clarification_required'
    ? 'guarded'
    : (explainability?.confidence ? String(explainability.confidence).toLowerCase() : 'high');

  return {
    planner: {
      summary: summary || tool,
      tool,
      mode,
      args,
      steps: plan,
    },
    critic: {
      quality,
      checks: criticChecks.slice(0, 4),
      next_best_action: explainability?.recommended_action || (mode === 'clarification_required'
        ? 'Lengkapi detail yang diminta lalu kirim ulang.'
        : 'Eksekusi aksi prioritas tertinggi sekarang.'),
    },
  };
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

function buildAssistantToolCalls(toolName = '', args = {}) {
  if (toolName === 'execute_action_bundle') {
    return Array.isArray(args?.actions)
      ? args.actions.map((action) => ({
          name: action.tool,
          mode: 'write',
          args: action.args || {},
        }))
      : [];
  }
  const def = TOOLS[toolName];
  const mode = def ? def.mode : 'read';
  return [{ name: toolName, mode, args: args || {} }];
}

function mergeNaturalReply(prefix = '', fallback = '') {
  const lead = String(prefix || '').trim();
  const tail = String(fallback || '').trim();
  if (!lead) return tail;
  if (!tail) return lead;
  return `${lead}\n\n${tail}`;
}

function buildClarificationPayload(intentWithUser, message, pythonDecision = null) {
  const fallback = buildClarificationResponse(intentWithUser, message);
  const defaultReply = 'Sip, aku butuh detail tambahan dulu supaya hasilnya tepat.';
  const clarifications = pythonDecision?.clarifications?.length
    ? pythonDecision.clarifications
    : (fallback?.clarifications || []);
  const reply = mergeNaturalReply(pythonDecision?.natural_reply || '', fallback?.reply || defaultReply);
  const toolCalls = buildAssistantToolCalls(intentWithUser.tool, intentWithUser.args || {});

  return {
    ok: false,
    mode: 'clarification_required',
    tool: intentWithUser.tool,
    tool_calls: toolCalls,
    reply,
    clarifications,
    preview: {
      summary: intentWithUser.summary,
      args: intentWithUser.args,
    },
    execution_frame: buildExecutionFrame({
      mode: 'clarification_required',
      tool: intentWithUser.tool,
      summary: intentWithUser.summary || intentWithUser.tool,
      args: intentWithUser.args || {},
      clarifications,
    }),
  };
}

async function processAssistantRequest(req, user, body = {}) {
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
    const toolCalls = buildAssistantToolCalls(payload.tool, payload.args || {});

    return {
      ok: true,
      mode: 'write_executed',
      tool: payload.tool,
      tool_calls: toolCalls,
      reply: writeExecutionReply(payload.tool, result),
      data: result,
      execution_frame: buildExecutionFrame({
        mode: 'write_executed',
        tool: payload.tool,
        summary: payload.summary || payload.tool,
        args: payload.args || {},
      }),
    };
  }

  const message = (body.message || '').toString().trim();
  if (!message) {
    throw createError('Message required', 400);
  }

  const pythonDecision = await inferIntentWithPythonBrain(req, user, message);
  const detectedIntent = pythonDecision
    ? {
        tool: pythonDecision.tool,
        mode: TOOLS[pythonDecision.tool]?.mode || pythonDecision.mode,
        args: pythonDecision.args || {},
        summary: pythonDecision.summary || pythonDecision.tool,
      }
    : detectIntent(message, user);

  const intent = detectedIntent;
  if (!intent) {
    throw createError('Unable to detect intent', 400);
  }

  const intentWithUser = normalizeIntentForUser(intent, user);

  const def = TOOLS[intentWithUser.tool];
  if (!def) {
    throw createError('Unknown assistant tool', 400);
  }

  if (def.mode === 'write') {
    if (pythonDecision && pythonDecision.mode === 'clarification_required') {
      return buildClarificationPayload(intentWithUser, message, pythonDecision);
    }

    const clarification = buildClarificationResponse(intentWithUser, message);
    if (clarification) {
      return buildClarificationPayload(intentWithUser, message, pythonDecision);
    }

    const result = await def.run({ user }, intentWithUser.args || {});
    const toolCalls = buildAssistantToolCalls(intentWithUser.tool, intentWithUser.args || {});
    const writeReply = writeExecutionReply(intentWithUser.tool, result);

    return {
      ok: true,
      mode: 'write_executed',
      tool: intentWithUser.tool,
      tool_calls: toolCalls,
      reply: mergeNaturalReply(pythonDecision?.natural_reply || '', writeReply),
      data: result,
      preview: {
        summary: intentWithUser.summary,
        args: intentWithUser.args,
      },
      execution_frame: buildExecutionFrame({
        mode: 'write_executed',
        tool: intentWithUser.tool,
        summary: intentWithUser.summary || intentWithUser.tool,
        args: intentWithUser.args || {},
      }),
    };
  }

  const result = await def.run({ user }, intentWithUser.args || {});
  const explainability = buildExplainability(intentWithUser.tool, result, user);
  const readReply = summarizeRead(intentWithUser.tool, result, user);
  return {
    ok: true,
    mode: 'read',
    tool: intentWithUser.tool,
    tool_calls: [{ name: intentWithUser.tool, mode: 'read', args: intentWithUser.args || {} }],
    reply: mergeNaturalReply(pythonDecision?.natural_reply || '', readReply),
    data: result,
    explainability,
    execution_frame: buildExecutionFrame({
      mode: 'read',
      tool: intentWithUser.tool,
      summary: intentWithUser.summary || intentWithUser.tool,
      args: intentWithUser.args || {},
      explainability,
    }),
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
      assistant: 'phase-2.3-nla',
      engine: isPythonAssistantEngineEnabled() ? 'python+js-fallback' : 'js',
      confirmation_required_for_write: false,
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
    const payload = await processAssistantRequest(req, user, body || {});
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
