import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { pool, readBody, verifyToken, withErrorHandling, sendJson } from './_lib.js';
import { generateStudyPlanSnapshot } from './study_plan.js';

const CHATBOT_ENDPOINT_PATH = '/api/chatbot';
const CHATBOT_MAX_REPLY = 420;
const CHATBOT_MAX_SUGGESTIONS = 4;
const CHATBOT_MAX_RECENT_INTENTS = 6;
const CHATBOT_HYBRID_COMPLEXITY_THRESHOLD = 56;
const ZAI_MAX_ACTIONS = 5;
const FEEDBACK_HISTORY_LIMIT = 12;
const RELIABILITY_SAFE_SCORE = 78;

function parseBooleanEnv(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hasBearerAuth(req) {
  const auth = String(req?.headers?.authorization || '');
  return /^Bearer\s+\S+/i.test(auth);
}

function resolveChatbotUrl(req) {
  const explicit = String(process.env.CHATBOT_PY_URL || '').trim();
  if (explicit) return explicit;

  const host = String(req?.headers?.host || '').trim();
  if (!host) return '';

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}${CHATBOT_ENDPOINT_PATH}`;
}

function resolveChatbotLlmUrl(req) {
  const explicit = String(process.env.CHATBOT_LLM_URL || '').trim();
  if (explicit) return explicit;
  if (!parseBooleanEnv(process.env.CHATBOT_LLM_USE_LOCAL_PATH || '')) return '';

  const host = String(req?.headers?.host || '').trim();
  if (!host) return '';

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').trim().toLowerCase();
  const proto = forwardedProto || (host.includes('localhost') ? 'http' : 'https');
  return `${proto}://${host}/api/chatbot-llm`;
}

function chatbotRouterMode() {
  const mode = String(process.env.CHATBOT_ENGINE_MODE || 'hybrid').trim().toLowerCase();
  if (mode === 'rule' || mode === 'python' || mode === 'llm' || mode === 'hybrid') return mode;
  return 'hybrid';
}

function chatbotLlmEnabled() {
  const mode = String(process.env.CHATBOT_ENGINE_MODE || '').trim().toLowerCase();
  if (mode === 'llm') return true;
  return parseBooleanEnv(process.env.CHATBOT_LLM_ENABLED || '');
}

function normalizeChatbotSuggestions(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    let label = '';
    let command = '';
    let tone = 'info';
    if (typeof item === 'string') {
      label = item.trim();
      command = item.trim();
    } else if (item && typeof item === 'object') {
      label = String(item.label || item.text || item.command || '').trim();
      command = String(item.command || item.message || item.prompt || '').trim();
      tone = String(item.tone || 'info').trim() || 'info';
    }
    if (!label || !command) continue;
    const key = `${label.toLowerCase()}::${command.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, command, tone });
    if (out.length >= CHATBOT_MAX_SUGGESTIONS) break;
  }
  return out;
}

function normalizeChatbotContext(input) {
  if (!input || typeof input !== 'object') return null;

  const toneRaw = String(input.tone_mode || input.style || '').trim().toLowerCase();
  const toneMode = ['supportive', 'strict', 'balanced'].includes(toneRaw) ? toneRaw : 'supportive';

  const focusMinutesNum = Number(input.focus_minutes);
  const focusMinutes = Number.isFinite(focusMinutesNum)
    ? Math.max(10, Math.min(180, Math.round(focusMinutesNum)))
    : 25;

  const focusWindowRaw = String(input.focus_window || '').trim().toLowerCase();
  const focusWindow = ['any', 'morning', 'afternoon', 'evening'].includes(focusWindowRaw) ? focusWindowRaw : 'any';

  const recentIntents = Array.isArray(input.recent_intents)
    ? input.recent_intents
        .map((item) => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, CHATBOT_MAX_RECENT_INTENTS)
    : [];

  const preferredCommands = normalizeRecentStrings(input.preferred_commands, 6);
  const avoidCommands = normalizeRecentStrings(input.avoid_commands, 6)
    .filter((item) => !preferredCommands.includes(item));
  const helpfulRatioNum = Number(input.helpful_ratio);
  const helpfulRatio = Number.isFinite(helpfulRatioNum)
    ? Math.max(0, Math.min(1, helpfulRatioNum))
    : 0.5;

  return {
    tone_mode: toneMode,
    focus_minutes: focusMinutes,
    focus_window: focusWindow,
    recent_intents: recentIntents,
    preferred_commands: preferredCommands,
    avoid_commands: avoidCommands,
    helpful_ratio: helpfulRatio,
  };
}

function extractOptionalUser(req) {
  const auth = String(req?.headers?.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return '';

  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) return '';

  try {
    const decoded = jwt.verify(token, secret, { audience: 'cute-futura', issuer: 'cute-futura' });
    return String(decoded?.user || '').trim();
  } catch {
    return '';
  }
}

function safeJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(value || '{}');
  } catch {
    return fallback;
  }
}

function normalizeRecentStrings(list, max = 8) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function extractMessageTopics(message = '') {
  const text = String(message || '').toLowerCase();
  const topics = [];
  const push = (value) => {
    if (!value || topics.includes(value)) return;
    topics.push(value);
  };

  if (/\b(kuliah|assignment|deadline|ujian|quiz|makalah)\b/.test(text)) push('kuliah');
  if (/\b(target|goal|prioritas)\b/.test(text)) push('target');
  if (/\b(reminder|ingat|alarm|notifikasi)\b/.test(text)) push('reminder');
  if (/\b(check-?in|progres|progress|sync)\b/.test(text)) push('checkin');
  if (/\b(evaluasi|review|refleksi)\b/.test(text)) push('evaluation');
  if (/\b(belajar|study|jadwal belajar|study plan|sesi belajar)\b/.test(text)) push('study');
  if (/\b(mood|lelah|burnout|stress)\b/.test(text)) push('mood');
  if (/\b(couple|pasangan|partner)\b/.test(text)) push('couple');
  if (!topics.length) push('general');
  return topics.slice(0, 5);
}

function hasDeadlineSignal(text = '') {
  return /(\bdeadline\b|\bdue\b|\bbesok\b|\blusa\b|\btoday\b|\bhari ini\b|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})/i.test(text);
}

function buildPlannerActions(message = '') {
  const normalized = String(message || '').trim();
  if (!normalized) return [];

  const segments = normalized
    .split(/\s*(?:;|(?:,\s*)?(?:dan|lalu|kemudian|terus|habis itu|setelah itu))\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);

  const sourceSegments = segments.length ? segments : [normalized];
  const actions = [];
  let index = 1;
  for (const segment of sourceSegments) {
    const lower = segment.toLowerCase();
    let kind = '';
    let summary = '';
    const missing = [];
    if (/(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)\b/i.test(lower)) {
      kind = 'create_assignment';
      summary = 'Buat assignment baru';
      if (!hasDeadlineSignal(lower)) missing.push('deadline');
      if (segment.replace(/(?:buat|tambah|add|create)\s+(?:assignment|tugas kuliah)/ig, '').trim().length < 3) missing.push('title');
    } else if (/(?:buat|tambah|add|create)\s+(?:task|tugas)\b/i.test(lower)) {
      kind = 'create_task';
      summary = 'Buat task baru';
      if (!hasDeadlineSignal(lower)) missing.push('deadline');
      if (segment.replace(/(?:buat|tambah|add|create)\s+(?:task|tugas)/ig, '').trim().length < 3) missing.push('title');
    } else if (/(?:ingatkan|reminder|alarm|notifikasi)/i.test(lower)) {
      kind = 'set_reminder';
      summary = 'Atur reminder fokus';
    } else if (/(?:evaluasi|review|refleksi)/i.test(lower)) {
      kind = 'evaluation';
      summary = 'Jalankan evaluasi singkat';
    } else if (/(?:rekomendasi|prioritas|task apa dulu|tugas apa dulu)/i.test(lower)) {
      kind = 'recommendation';
      summary = 'Susun prioritas tugas';
    } else if (/(?:jadwal belajar|study plan|rencana belajar|sesi belajar|waktu kosong|jam kosong|free slot|free time)/i.test(lower)) {
      kind = 'study_plan';
      summary = 'Susun jadwal belajar dari waktu kosong';
    } else if (/(?:target harian|cek target|goal hari ini)/i.test(lower)) {
      kind = 'daily_target';
      summary = 'Cek target harian';
    } else {
      if (segments.length === 1) {
        kind = 'explore';
        summary = 'Klarifikasi kebutuhan utama';
      } else {
        continue;
      }
    }

    actions.push({
      id: `step_${index}`,
      kind,
      summary,
      command: segment,
      status: missing.length ? 'blocked' : 'ready',
      missing,
    });
    index += 1;
    if (actions.length >= ZAI_MAX_ACTIONS) break;
  }

  return actions;
}

function buildPlannerFrame(message = '') {
  const actions = buildPlannerActions(message);
  const clarifications = [];
  actions.forEach((action) => {
    (action.missing || []).forEach((field) => {
      clarifications.push({
        action_id: action.id,
        field,
        question: field === 'deadline'
          ? 'Deadline-nya kapan?'
          : 'Judul/tujuannya apa?',
      });
    });
  });

  const requiresClarification = clarifications.length > 0;
  const planText = actions.map((action, idx) => `${idx + 1}. ${action.summary}`).join(' -> ');
  const confidence = actions.length === 0 ? 'low' : (requiresClarification ? 'medium' : 'high');

  return {
    mode: actions.length > 1 ? 'bundle' : 'single',
    confidence,
    requires_clarification: requiresClarification,
    clarifications,
    actions,
    summary: planText || 'Belum ada rencana eksekusi yang jelas.',
    next_best_action: requiresClarification
      ? 'Lengkapi detail yang kurang dulu.'
      : (actions[0]?.summary ? `Eksekusi: ${actions[0].summary}` : 'Jelaskan kebutuhan utamamu dulu.'),
  };
}

function plannerSuggestionChips(planner = null) {
  if (!planner || typeof planner !== 'object') return [];
  const chips = [];
  if (planner.requires_clarification) {
    for (const item of planner.clarifications || []) {
      if (item?.field === 'deadline') {
        chips.push({ label: 'Isi Deadline', command: 'deadline besok 19:00', tone: 'warning' });
      } else if (item?.field === 'title') {
        chips.push({ label: 'Isi Judul', command: 'judul tugas [isi judulnya]', tone: 'info' });
      }
    }
  } else {
    for (const action of planner.actions || []) {
      const command = String(action?.command || '').trim();
      const summary = String(action?.summary || '').trim();
      if (!command || !summary) continue;
      chips.push({ label: summary.slice(0, 28), command, tone: 'success' });
    }
  }
  return normalizeChatbotSuggestions(chips);
}

function mergeSuggestions(primary = [], secondary = []) {
  return normalizeChatbotSuggestions([...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]);
}

async function ensureZaiMemorySchema() {
  if (global._zaiMemorySchemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_user_memory (
      user_id VARCHAR(60) PRIMARY KEY,
      last_intent VARCHAR(80),
      focus_topic VARCHAR(80),
      memory JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_memory_events (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      message TEXT NOT NULL,
      intent VARCHAR(80),
      reply TEXT,
      planner JSONB NOT NULL DEFAULT '{}'::jsonb,
      context JSONB NOT NULL DEFAULT '{}'::jsonb,
      topics JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_feedback_events (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      response_id VARCHAR(80),
      intent VARCHAR(80),
      helpful BOOLEAN NOT NULL,
      suggestion_command TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_events_user_time ON z_ai_memory_events(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_feedback_user_time ON z_ai_feedback_events(user_id, created_at DESC)');
  global._zaiMemorySchemaReady = true;
}

function normalizeFeedbackProfile(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const byIntent = source.by_intent && typeof source.by_intent === 'object' ? source.by_intent : {};
  const normalizedByIntent = {};
  for (const [key, value] of Object.entries(byIntent)) {
    const intent = String(key || '').trim().toLowerCase();
    if (!intent || !value || typeof value !== 'object') continue;
    normalizedByIntent[intent] = {
      helpful: Math.max(0, Number(value.helpful || 0)),
      not_helpful: Math.max(0, Number(value.not_helpful || 0)),
    };
  }

  const preferredCommands = normalizeRecentStrings(source.preferred_commands, FEEDBACK_HISTORY_LIMIT);
  const avoidCommands = normalizeRecentStrings(source.avoid_commands, FEEDBACK_HISTORY_LIMIT)
    .filter((item) => !preferredCommands.includes(item));

  const total = Math.max(0, Number(source.total || 0));
  const helpful = Math.max(0, Number(source.helpful || 0));
  const notHelpful = Math.max(0, Number(source.not_helpful || 0));
  const ratioRaw = Number(source.helpful_ratio);
  const helpfulRatio = Number.isFinite(ratioRaw)
    ? Math.max(0, Math.min(1, ratioRaw))
    : (total > 0 ? helpful / Math.max(1, helpful + notHelpful) : 0.5);

  return {
    total,
    helpful,
    not_helpful: notHelpful,
    helpful_ratio: helpfulRatio,
    by_intent: normalizedByIntent,
    preferred_commands: preferredCommands,
    avoid_commands: avoidCommands,
  };
}

function normalizeZaiMemory(raw = {}) {
  const memory = raw && typeof raw === 'object' ? raw : {};
  const counters = memory.counters && typeof memory.counters === 'object' ? memory.counters : {};
  const intentsCounter = counters.intents && typeof counters.intents === 'object' ? counters.intents : {};
  return {
    version: 1,
    counters: {
      messages_total: Number(counters.messages_total || 0),
      intents: intentsCounter,
    },
    recent_intents: normalizeRecentStrings(memory.recent_intents, 8),
    recent_topics: normalizeRecentStrings(memory.recent_topics, 10),
    unresolved: Array.isArray(memory.unresolved) ? memory.unresolved.slice(0, 6) : [],
    last_plan: memory.last_plan && typeof memory.last_plan === 'object' ? memory.last_plan : null,
    last_reply: String(memory.last_reply || '').slice(0, 280),
    feedback_profile: normalizeFeedbackProfile(memory.feedback_profile || {}),
  };
}

async function getZaiMemoryBundle(userId = '') {
  if (!userId) return null;
  await ensureZaiMemorySchema();

  const [rowRes, taskRes, assignmentRes, moodRes] = await Promise.all([
    pool.query('SELECT memory, last_intent, focus_topic, updated_at FROM z_ai_user_memory WHERE user_id=$1', [userId]),
    pool.query('SELECT COUNT(*)::int AS cnt FROM tasks WHERE completed = FALSE'),
    pool.query('SELECT COUNT(*)::int AS cnt FROM assignments WHERE completed = FALSE'),
    pool.query(`SELECT COALESCE(AVG(mood), 0)::float AS avg_mood
                FROM evaluations
                WHERE user_id=$1 AND created_at >= NOW() - INTERVAL '7 days'`, [userId]),
  ]);

  const row = rowRes.rowCount ? rowRes.rows[0] : null;
  const memory = normalizeZaiMemory(safeJson(row?.memory || {}, {}));
  return {
    user_id: userId,
    last_intent: String(row?.last_intent || memory.recent_intents[0] || '').toLowerCase(),
    focus_topic: String(row?.focus_topic || memory.recent_topics[0] || 'general').toLowerCase(),
    pending_tasks: Number(taskRes.rows[0]?.cnt || 0),
    pending_assignments: Number(assignmentRes.rows[0]?.cnt || 0),
    avg_mood_7d: Number(moodRes.rows[0]?.avg_mood || 0),
    memory,
  };
}

function normalizeFeedbackPayload(raw = null) {
  if (!raw || typeof raw !== 'object') return null;
  const helpful = raw.helpful === true ? true : (raw.helpful === false ? false : null);
  if (helpful === null) return null;

  const responseId = String(raw.response_id || '').trim().slice(0, 80);
  const intent = String(raw.intent || '').trim().toLowerCase().slice(0, 80);
  const suggestionCommand = String(raw.suggestion_command || raw.command || '').trim().slice(0, 240);
  return {
    response_id: responseId || null,
    intent: intent || null,
    helpful,
    suggestion_command: suggestionCommand || null,
  };
}

function mergeFeedbackIntoMemory(current, feedback) {
  const merged = normalizeZaiMemory(current);
  const profile = normalizeFeedbackProfile(merged.feedback_profile || {});
  profile.total += 1;
  if (feedback.helpful) profile.helpful += 1;
  else profile.not_helpful += 1;
  profile.helpful_ratio = profile.helpful / Math.max(1, profile.helpful + profile.not_helpful);

  const intent = String(feedback.intent || '').trim().toLowerCase();
  if (intent) {
    const row = profile.by_intent[intent] || { helpful: 0, not_helpful: 0 };
    if (feedback.helpful) row.helpful += 1;
    else row.not_helpful += 1;
    profile.by_intent[intent] = row;
  }

  const command = String(feedback.suggestion_command || '').trim().toLowerCase();
  if (command) {
    if (feedback.helpful) {
      profile.preferred_commands = normalizeRecentStrings([command, ...profile.preferred_commands], FEEDBACK_HISTORY_LIMIT);
      profile.avoid_commands = normalizeRecentStrings(profile.avoid_commands.filter((item) => item !== command), FEEDBACK_HISTORY_LIMIT);
    } else {
      profile.avoid_commands = normalizeRecentStrings([command, ...profile.avoid_commands], FEEDBACK_HISTORY_LIMIT);
      profile.preferred_commands = normalizeRecentStrings(profile.preferred_commands.filter((item) => item !== command), FEEDBACK_HISTORY_LIMIT);
    }
  }

  merged.feedback_profile = profile;
  return merged;
}

async function writeZaiFeedback(userId, feedback) {
  if (!userId || !feedback) return null;
  await ensureZaiMemorySchema();

  await pool.query(
    `INSERT INTO z_ai_feedback_events (user_id, response_id, intent, helpful, suggestion_command, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [userId, feedback.response_id, feedback.intent, Boolean(feedback.helpful), feedback.suggestion_command]
  );

  const rowRes = await pool.query('SELECT memory, last_intent, focus_topic FROM z_ai_user_memory WHERE user_id=$1', [userId]);
  const row = rowRes.rowCount ? rowRes.rows[0] : null;
  const current = row ? safeJson(row.memory || {}, {}) : {};
  const merged = mergeFeedbackIntoMemory(current, feedback);
  const lastIntent = String(row?.last_intent || feedback.intent || '').trim().toLowerCase() || null;
  const focusTopic = String(row?.focus_topic || merged.recent_topics?.[0] || 'general').trim().toLowerCase();

  await pool.query(
    `INSERT INTO z_ai_user_memory (user_id, last_intent, focus_topic, memory, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       last_intent=EXCLUDED.last_intent,
       focus_topic=EXCLUDED.focus_topic,
       memory=EXCLUDED.memory,
       updated_at=NOW()`,
    [userId, lastIntent, focusTopic, JSON.stringify(merged)]
  );

  return normalizeFeedbackProfile(merged.feedback_profile || {});
}

function buildLearningHints(memory) {
  const profile = normalizeFeedbackProfile(memory?.memory?.feedback_profile || {});
  const preferredCommands = normalizeRecentStrings(profile.preferred_commands, 6);
  const avoidCommands = normalizeRecentStrings(profile.avoid_commands, 6);
  return {
    helpful_ratio: Number(profile.helpful_ratio || 0.5),
    preferred_commands: preferredCommands,
    avoid_commands: avoidCommands,
  };
}

function applyLearningToSuggestions(suggestions = [], learningHints = null) {
  const base = normalizeChatbotSuggestions(suggestions);
  if (!learningHints || typeof learningHints !== 'object') return base;

  const preferred = normalizeRecentStrings(learningHints.preferred_commands, 6);
  const avoid = new Set(normalizeRecentStrings(learningHints.avoid_commands, 6));

  const filtered = base.filter((item) => {
    const command = String(item?.command || '').trim().toLowerCase();
    if (!command) return false;
    return !avoid.has(command);
  });

  if (!preferred.length) return filtered;
  const preferredSet = new Set(preferred);
  const prioritized = [];
  filtered.forEach((item) => {
    const command = String(item.command || '').trim().toLowerCase();
    if (preferredSet.has(command)) prioritized.unshift(item);
    else prioritized.push(item);
  });
  return normalizeChatbotSuggestions(prioritized);
}

function buildReliabilityAssessment(message = '', planner = null, intent = '') {
  const text = String(message || '').trim().toLowerCase();
  const plan = planner && typeof planner === 'object' ? planner : {};
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  const missingFields = [];
  for (const item of plan.clarifications || []) {
    const field = String(item?.field || '').trim().toLowerCase();
    if (!field || missingFields.includes(field)) continue;
    missingFields.push(field);
  }

  const createSignals = (text.match(/\b(buat|buatkan|tambah|add|create)\b/g) || []).length;
  const ambiguousSignals = /(\bini\b|\bitu\b|\bnanti\b|\baja\b|\bpokoknya\b|\bseperti biasa\b)/i.test(text);
  const multipleCreate = createSignals > 1 || actions.length > 1;
  let score = 92;
  if (!actions.length || String(intent || '').toLowerCase() === 'fallback') score -= 28;
  if (multipleCreate) score -= 10;
  score -= Math.min(45, missingFields.length * 18);
  if (ambiguousSignals) score -= 14;
  score = Math.max(0, Math.min(100, score));

  let status = 'safe';
  if (missingFields.length > 0) status = 'needs_clarification';
  if (status === 'safe' && score < RELIABILITY_SAFE_SCORE) status = 'ambiguous';

  const questions = [];
  for (const item of plan.clarifications || []) {
    const question = String(item?.question || '').trim();
    if (!question || questions.includes(question)) continue;
    questions.push(question);
    if (questions.length >= 3) break;
  }
  if (!questions.length && status !== 'safe') {
    questions.push('Boleh detailkan lagi supaya aku eksekusi tepat?');
  }

  return {
    status,
    score,
    missing_fields: missingFields,
    questions,
    should_execute: status === 'safe',
  };
}

function applyReliabilityFollowup(reply = '', reliability = null) {
  const base = String(reply || '').trim();
  if (!reliability || typeof reliability !== 'object') return base;
  if (reliability.status === 'safe') return base;

  const qs = Array.isArray(reliability.questions) ? reliability.questions.filter(Boolean) : [];
  if (!qs.length) return base;
  const first = qs[0];
  if (!first) return base;
  if (base.toLowerCase().includes(first.toLowerCase())) return base;
  return `${base}\n\nBiar akurat: ${first}`.trim();
}

function mergeMemoryAfterInteraction(current, interaction) {
  const safeCurrent = normalizeZaiMemory(current);
  const intent = String(interaction.intent || '').trim().toLowerCase();
  const topics = normalizeRecentStrings(interaction.topics || [], 5);
  safeCurrent.counters.messages_total += 1;

  if (intent) {
    safeCurrent.counters.intents[intent] = Number(safeCurrent.counters.intents[intent] || 0) + 1;
    safeCurrent.recent_intents = normalizeRecentStrings([intent, ...safeCurrent.recent_intents], 8);
  }

  if (topics.length) {
    safeCurrent.recent_topics = normalizeRecentStrings([...topics, ...safeCurrent.recent_topics], 10);
  }

  safeCurrent.last_reply = String(interaction.reply || '').slice(0, 280);
  safeCurrent.last_plan = interaction.planner && typeof interaction.planner === 'object'
    ? {
        summary: String(interaction.planner.summary || '').slice(0, 200),
        confidence: String(interaction.planner.confidence || '').toLowerCase(),
        requires_clarification: Boolean(interaction.planner.requires_clarification),
      }
    : safeCurrent.last_plan;

  if (interaction.planner?.requires_clarification) {
    const unresolved = [];
    for (const c of interaction.planner.clarifications || []) {
      const field = String(c?.field || '').toLowerCase();
      if (!field) continue;
      unresolved.push({ field, asked_at: new Date().toISOString() });
    }
    safeCurrent.unresolved = unresolved.slice(0, 6);
  } else if (intent && intent !== 'fallback') {
    safeCurrent.unresolved = [];
  }

  return safeCurrent;
}

async function writeZaiMemoryBundle(userId, interaction) {
  if (!userId) return;
  await ensureZaiMemorySchema();
  const nowIso = new Date().toISOString();

  const rowRes = await pool.query('SELECT memory FROM z_ai_user_memory WHERE user_id=$1', [userId]);
  const current = rowRes.rowCount ? safeJson(rowRes.rows[0]?.memory || {}, {}) : {};
  const merged = mergeMemoryAfterInteraction(current, interaction);
  const lastIntent = String(interaction.intent || '').toLowerCase();
  const focusTopic = String((interaction.topics || [])[0] || merged.recent_topics[0] || 'general').toLowerCase();

  await pool.query(
    `INSERT INTO z_ai_user_memory (user_id, last_intent, focus_topic, memory, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET
       last_intent=EXCLUDED.last_intent,
       focus_topic=EXCLUDED.focus_topic,
       memory=EXCLUDED.memory,
       updated_at=NOW()`,
    [userId, lastIntent || null, focusTopic, JSON.stringify(merged)]
  );

  await pool.query(
    `INSERT INTO z_ai_memory_events (user_id, message, intent, reply, planner, context, topics, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8)`,
    [
      userId,
      String(interaction.message || ''),
      lastIntent || null,
      String(interaction.reply || '').slice(0, 500),
      JSON.stringify(interaction.planner || {}),
      JSON.stringify(interaction.context || {}),
      JSON.stringify(interaction.topics || []),
      nowIso,
    ]
  );
}

function plannerTextBlock(planner) {
  if (!planner || typeof planner !== 'object') return '';
  const steps = Array.isArray(planner.actions) ? planner.actions : [];
  if (!steps.length) return '';
  const stepText = steps.slice(0, 4).map((item, idx) => `${idx + 1}) ${item.summary}`).join(' | ');
  if (planner.requires_clarification) {
    const missing = (planner.clarifications || []).map((item) => item?.field).filter(Boolean);
    return `Rencana Z AI: ${stepText}. Perlu detail: ${missing.join(', ') || 'tambahan info'}.`;
  }
  return `Rencana Z AI: ${stepText}.`;
}

function memoryTextBlock(memory) {
  if (!memory || typeof memory !== 'object') return '';
  const tasks = Number(memory.pending_tasks || 0);
  const assignments = Number(memory.pending_assignments || 0);
  const mood = Number(memory.avg_mood_7d || 0).toFixed(1);
  const topic = String(memory.focus_topic || 'general');
  return `Memory: task ${tasks}, assignment ${assignments}, mood7d ${mood}, fokus ${topic}.`;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toDateLabel(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoDateLabel(raw = '') {
  const m = String(raw || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const parsed = new Date(y, mo, d);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() !== y || parsed.getMonth() !== mo || parsed.getDate() !== d) return null;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function parseStudyDateLabel(message = '') {
  const text = String(message || '').toLowerCase();
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso && iso[1]) {
    const parsed = parseIsoDateLabel(iso[1]);
    if (parsed) return toDateLabel(parsed);
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (/\b(lusa|day after tomorrow)\b/i.test(text)) {
    now.setDate(now.getDate() + 2);
    return toDateLabel(now);
  }
  if (/\b(besok|tomorrow)\b/i.test(text)) {
    now.setDate(now.getDate() + 1);
    return toDateLabel(now);
  }
  if (/\b(hari ini|today)\b/i.test(text)) {
    return toDateLabel(now);
  }
  return null;
}

function parseStudyWindow(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(pagi|morning)\b/i.test(text)) return 'morning';
  if (/\b(siang|afternoon)\b/i.test(text)) return 'afternoon';
  if (/\b(malam|night|evening)\b/i.test(text)) return 'evening';
  return null;
}

function parseStudyTargetMinutes(message = '') {
  const hit = String(message || '').match(/(\d{2,3})\s*(?:menit|min|minutes?)\b/i);
  if (!hit) return null;
  return clampNumber(hit[1], 60, 360);
}

function isStudyPlanCommand(message = '') {
  const text = String(message || '').toLowerCase();
  const hasStudyKeyword = /(jadwal belajar|study plan|rencana belajar|sesi belajar)/i.test(text);
  const hasFreeSlotKeyword = /(waktu kosong|jam kosong|slot kosong|waktu luang|waktu senggang|free slot|free time)/i.test(text);
  const hasActionKeyword = /(buat|buatkan|susun|atur|generate|carikan|rancang|bikinin)/i.test(text);
  if ((hasActionKeyword && hasStudyKeyword) || (hasStudyKeyword && hasFreeSlotKeyword)) return true;
  if (/^(jadwal belajar|study plan)\b/i.test(text)) return true;
  return false;
}

function parseStudyPlanRequest(message = '') {
  if (!isStudyPlanCommand(message)) return null;
  const dateLabel = parseStudyDateLabel(message);
  const targetMinutes = parseStudyTargetMinutes(message);
  const windowName = parseStudyWindow(message);
  return {
    date: dateLabel || undefined,
    targetMinutes: targetMinutes ?? undefined,
    preferredWindow: windowName || undefined,
  };
}

function humanizeDateLabel(dateLabel = '') {
  const base = parseIsoDateLabel(dateLabel);
  if (!base) return dateLabel || 'hari ini';

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(now);
  dayAfter.setDate(dayAfter.getDate() + 2);

  if (toDateLabel(base) === toDateLabel(now)) return 'hari ini';
  if (toDateLabel(base) === toDateLabel(tomorrow)) return 'besok';
  if (toDateLabel(base) === toDateLabel(dayAfter)) return 'lusa';
  return dateLabel;
}

function buildStudyPlanNaturalReply(plan = {}) {
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
  const freeWindows = Array.isArray(plan.free_windows) ? plan.free_windows : [];
  const dayLabel = humanizeDateLabel(String(plan.date || ''));
  const plannedMinutes = Number(plan?.summary?.planned_minutes || 0);
  const freeMinutes = Number(plan?.summary?.free_minutes || 0);
  const targetMinutes = Number(plan?.target_minutes || 0);

  if (!sessions.length) {
    if (!freeWindows.length) {
      return `Aku sudah cek ${dayLabel}, tapi jadwalmu padat. Belum ada slot kosong yang cukup buat sesi belajar. Coba geser ke besok pagi atau turunkan target menit dulu.`;
    }
    const sample = freeWindows.slice(0, 3).map((slot) => `${slot.start}-${slot.end}`).join(', ');
    return `Aku sudah analisis waktu kosong ${dayLabel}. Slot yang kebaca: ${sample}. Belum cukup buat sesi belajar optimal, jadi kita bisa pakai mode malam atau target lebih ringan dulu.`;
  }

  const lines = sessions.slice(0, 4).map((session, idx) => {
    const title = String(session.title || 'Fokus belajar');
    return `${idx + 1}) ${session.start}-${session.end} ${title}`;
  });
  const extra = sessions.length > 4 ? ` (+${sessions.length - 4} sesi lagi)` : '';
  return `Siap, aku sudah bikin jadwal belajar dari waktu kosong ${dayLabel}.\n${lines.join('\n')}\nTotal ${plannedMinutes} menit dari ${freeMinutes} menit slot kosong (target ${targetMinutes} menit).${extra}`;
}

function buildStudyPlanSuggestions(plan = {}) {
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
  const suggestions = [];

  if (sessions.length) {
    suggestions.push({ label: 'Versi Besok Pagi', command: 'jadwal belajar besok pagi', tone: 'info' });
    suggestions.push({ label: 'Target 180 Menit', command: 'jadwal belajar 180 menit', tone: 'success' });
    suggestions.push({ label: 'Mode Malam', command: 'jadwal belajar malam 120 menit', tone: 'warning' });
  } else {
    suggestions.push({ label: 'Coba Besok Pagi', command: 'jadwal belajar besok pagi 120 menit', tone: 'warning' });
    suggestions.push({ label: 'Coba Mode Malam', command: 'jadwal belajar malam 90 menit', tone: 'warning' });
  }

  suggestions.push({ label: 'Rekomendasi Tugas', command: 'rekomendasi tugas kuliah', tone: 'success' });
  return normalizeChatbotSuggestions(suggestions);
}

function buildStatelessMemoryUpdate(memory, intent, message, extraTopics = []) {
  const currentRecentTopics = Array.isArray(memory?.memory?.recent_topics) ? memory.memory.recent_topics : [];
  const currentRecentIntents = Array.isArray(memory?.memory?.recent_intents) ? memory.memory.recent_intents : [];
  const topics = normalizeRecentStrings([...extraTopics, ...extractMessageTopics(message), ...currentRecentTopics], 8);
  const intents = normalizeRecentStrings([intent, ...currentRecentIntents], 8);
  return {
    focus_topic: topics[0] || String(memory?.focus_topic || 'general'),
    recent_topics: topics,
    recent_intents: intents,
    unresolved_fields: [],
    pending_tasks: Number(memory?.pending_tasks || 0),
    pending_assignments: Number(memory?.pending_assignments || 0),
    avg_mood_7d: Number(memory?.avg_mood_7d || 0),
  };
}

function localFallbackPayload(message = '') {
  const lower = String(message || '').toLowerCase();
  if (/\b(halo|hai|hi|hello|hey)\b/.test(lower)) {
    return {
      reply: 'Hai, tim produktif. Mau mulai dari cek target harian atau rekomendasi tugas?',
      intent: 'greeting',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
        { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
        { label: 'Evaluasi', command: 'evaluasi hari ini', tone: 'info' },
      ]),
    };
  }
  if (/\b(target|goal)\b/.test(lower)) {
    return {
      reply: 'Target harian couple: tuntaskan 1 tugas paling urgent, 1 sesi fokus 30-45 menit, lalu check-in malam.',
      intent: 'check_daily_target',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Check-In', command: 'check-in progres hari ini', tone: 'info' },
        { label: 'Reminder 25m', command: 'ingatkan aku fokus 25 menit', tone: 'warning' },
      ]),
    };
  }
  if (/\b(reminder|ingatkan|ingetin|jangan lupa|alarm|notifikasi)\b/.test(lower)) {
    return {
      reply: 'Siap, reminder tercatat. Mulai langkah kecil dulu sekarang, lalu update progres.',
      intent: 'reminder_ack',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Mulai 25m', command: 'oke mulai fokus 25 menit', tone: 'success' },
        { label: 'Evaluasi', command: 'evaluasi singkat', tone: 'info' },
      ]),
    };
  }
  if (/\b(rekomendasi|saran|prioritas|tugas apa)\b/.test(lower)) {
    return {
      reply: 'Prioritas: 1) deadline terdekat, 2) tugas berdampak tinggi, 3) review singkat lalu update pasangan.',
      intent: 'recommend_task',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Gas Sekarang', command: 'oke gas sekarang', tone: 'success' },
        { label: 'Check-In', command: 'check-in progres tugas', tone: 'info' },
      ]),
    };
  }
  if (/\b(toxic|tegas|gaspol|no excuse)\b/.test(lower)) {
    return {
      reply: 'Mode tegas: stop nunda, pilih 1 tugas inti, kerjakan 25 menit tanpa distraksi.',
      intent: 'toxic_motivation',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Gas 25m', command: 'oke gas fokus 25 menit', tone: 'critical' },
        { label: 'Prioritas', command: 'rekomendasi tugas prioritas', tone: 'warning' },
      ]),
    };
  }
  if (/\b(evaluasi|review|refleksi)\b/.test(lower)) {
    return {
      reply: 'Evaluasi cepat 3 poin: apa yang selesai, apa hambatannya, dan aksi utama berikutnya.',
      intent: 'evaluation',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Check-In', command: 'check-in progres hari ini', tone: 'info' },
        { label: 'Rencana Besok', command: 'cek target harian besok', tone: 'success' },
      ]),
    };
  }
  if (/\b(check-?in|progress|progres|update)\b/.test(lower)) {
    return {
      reply: 'Check-in singkat dulu: 1) selesai apa, 2) lagi ngerjain apa, 3) blocker terbesar sekarang.',
      intent: 'checkin_progress',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
        { label: 'Target Hari Ini', command: 'cek target harian pasangan', tone: 'info' },
      ]),
    };
  }
  if (/^(oke|ok|sip|siap|gas|lanjut)\b/i.test(lower)) {
    return {
      reply: 'Sip. Fokus ke 1 item utama dulu 25-30 menit, lalu update progres biar ritme tetap jalan.',
      intent: 'affirmation',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Mulai 25m', command: 'ingatkan aku fokus 25 menit', tone: 'warning' },
        { label: 'Check-In', command: 'check-in progres hari ini', tone: 'info' },
      ]),
    };
  }
  if (/(jadwal belajar|study plan)/i.test(lower)) {
    return {
      reply: 'Bisa. Kasih format ini: "jadwal belajar besok 150 menit pagi" biar aku susun sesi paling realistis.',
      intent: 'study_schedule',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Jadwal Besok Pagi', command: 'jadwal belajar besok pagi 120 menit', tone: 'info' },
        { label: 'Target 180m', command: 'jadwal belajar 180 menit', tone: 'success' },
      ]),
    };
  }
  return {
    reply: "Aku siap bantu produktivitas couple. Coba: 'cek target harian', 'rekomendasi tugas', atau 'check-in progres'.",
    intent: 'fallback',
    suggestions: normalizeChatbotSuggestions([
      { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
      { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
    ]),
  };
}

function fallbackChatbotPayload(message, plannerHint = null, memoryHint = null) {
  const fallback = localFallbackPayload(message);
  return {
    ...fallback,
    planner: plannerHint || null,
    memory: memoryHint || null,
    memory_update: null,
    suggestions: mergeSuggestions(fallback.suggestions, plannerSuggestionChips(plannerHint)),
    engine: 'rule-fallback',
  };
}

function inferRuleAdaptiveProfile(message = '', contextHint = null) {
  const context = normalizeChatbotContext(contextHint) || {};
  const lower = String(message || '').toLowerCase();
  const style = /\b(toxic|tegas|gaspol|no excuse)\b/.test(lower)
    ? 'strict'
    : (context.tone_mode || 'supportive');

  const focusMinutesHit = lower.match(/(\d{2,3})\s*(?:menit|min|minutes?)\b/);
  const focusMinutes = focusMinutesHit
    ? clampNumber(focusMinutesHit[1], 10, 180)
    : clampNumber(context.focus_minutes || 25, 10, 180);

  const urgency = /(\bdeadline\b|\bdue\b|\bbesok\b|\bhari ini\b|\burgent\b|\bsekarang\b)/i.test(lower)
    ? 'high'
    : (/(\btarget\b|\bcheck-?in\b|\breminder\b)/i.test(lower) ? 'medium' : 'low');

  const energy = /(\bcapek\b|\blelah\b|\bburnout\b|\bdrop\b)/i.test(lower)
    ? 'low'
    : (/(\bfokus\b|\bsemangat\b|\bgas\b)/i.test(lower) ? 'high' : 'normal');

  const domain = /(\bkuliah\b|\bassignment\b|\bdeadline\b|\bujian\b|\bstudy\b|\bbelajar\b)/i.test(lower)
    ? 'kuliah'
    : 'umum';

  return {
    style,
    focus_minutes: focusMinutes,
    urgency,
    energy,
    domain,
  };
}

function evaluateHybridComplexity(message = '', planner = null) {
  const text = String(message || '').trim();
  const lower = text.toLowerCase();
  const actions = Array.isArray(planner?.actions) ? planner.actions : [];
  const clarifications = Array.isArray(planner?.clarifications) ? planner.clarifications : [];
  const reasons = [];
  let score = 0;

  if (text.length >= 90) {
    score += 12;
    reasons.push('long_input');
  }
  if (text.length >= 150) {
    score += 12;
    reasons.push('very_long_input');
  }
  if (actions.length > 1) {
    score += 24;
    reasons.push('multi_action');
  }
  if (clarifications.length > 0) {
    score += 18;
    reasons.push('missing_fields');
  }
  if (/(\bdan\b|\blalu\b|\bkemudian\b|\bhabis itu\b|\bsekaligus\b)/i.test(lower)) {
    score += 10;
    reasons.push('multi_step_language');
  }
  if (/(\bkenapa\b|\bjelaskan\b|\bbandingkan\b|\bstrategi\b|\banalisis\b)/i.test(lower)) {
    score += 12;
    reasons.push('reasoning_request');
  }
  if (/(\bini\b|\bitu\b|\baja\b|\bnanti\b|\bseperti biasa\b|\byang tadi\b)/i.test(lower)) {
    score += 8;
    reasons.push('ambiguous_reference');
  }
  if ((text.match(/\?/g) || []).length > 1) {
    score += 6;
    reasons.push('multi_question');
  }

  score = Math.max(0, Math.min(100, score));
  const thresholdEnv = Number(process.env.CHATBOT_COMPLEXITY_THRESHOLD);
  const threshold = Number.isFinite(thresholdEnv)
    ? clampNumber(thresholdEnv, 20, 95)
    : CHATBOT_HYBRID_COMPLEXITY_THRESHOLD;
  return {
    score,
    threshold,
    complex: score >= threshold,
    level: score >= 72 ? 'high' : (score >= threshold ? 'medium' : 'low'),
    reasons,
  };
}

function runRuleEngineChatbot(message, contextHint = null, plannerHint = null, memoryHint = null) {
  const base = fallbackChatbotPayload(message, plannerHint, memoryHint);
  const adaptive = inferRuleAdaptiveProfile(message, contextHint);
  return {
    reply: String(base.reply || '').slice(0, CHATBOT_MAX_REPLY),
    intent: String(base.intent || 'fallback').trim().toLowerCase() || 'fallback',
    adaptive,
    planner: plannerHint || null,
    memory: memoryHint || null,
    memory_update: buildStatelessMemoryUpdate(memoryHint, String(base.intent || 'fallback'), message),
    suggestions: mergeSuggestions(base.suggestions, plannerSuggestionChips(plannerHint)),
    engine: 'rule-engine-v1',
  };
}

function shouldUseStatelessBot(req, body = {}) {
  if (parseBooleanEnv(process.env.CHATBOT_FORCE_STATELESS || '')) return true;
  const mode = String(body.mode || '').trim().toLowerCase();
  if (mode === 'bot' || mode === 'chatbot') return true;
  if (body.stateless === true) return true;
  return !hasBearerAuth(req);
}

async function askPythonChatbot(req, message, contextHint = null, plannerHint = null, memoryHint = null) {
  const endpoint = resolveChatbotUrl(req);
  if (!endpoint) {
    return fallbackChatbotPayload(message, plannerHint, memoryHint);
  }

  const timeoutMs = Math.max(300, Math.min(2500, Number(process.env.CHATBOT_TIMEOUT_MS || 900)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const sharedSecret = String(process.env.CHATBOT_SHARED_SECRET || '').trim();
    if (sharedSecret) headers['X-Chatbot-Secret'] = sharedSecret;

    const context = normalizeChatbotContext(contextHint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        context,
        planner: plannerHint || null,
        memory: memoryHint || null,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return fallbackChatbotPayload(message, plannerHint, memoryHint);
    }

    const data = await response.json().catch(() => ({}));
    const reply = String(data?.reply || '').trim();
    if (!reply) {
      return fallbackChatbotPayload(message, plannerHint, memoryHint);
    }
    return {
      reply: reply.slice(0, CHATBOT_MAX_REPLY),
      intent: String(data?.intent || '').trim().toLowerCase(),
      adaptive: data?.adaptive && typeof data.adaptive === 'object' ? data.adaptive : null,
      planner: data?.planner && typeof data.planner === 'object' ? data.planner : (plannerHint || null),
      memory: memoryHint || null,
      memory_update: data?.memory_update && typeof data.memory_update === 'object' ? data.memory_update : null,
      suggestions: mergeSuggestions(data?.suggestions, plannerSuggestionChips(data?.planner || plannerHint)),
      engine: 'python-v1',
    };
  } catch {
    return fallbackChatbotPayload(message, plannerHint, memoryHint);
  } finally {
    clearTimeout(timer);
  }
}

async function askLlmChatbot(req, message, contextHint = null, plannerHint = null, memoryHint = null) {
  if (!chatbotLlmEnabled()) return null;
  const endpoint = resolveChatbotLlmUrl(req);
  if (!endpoint) return null;

  const timeoutMs = Math.max(400, Math.min(5000, Number(process.env.CHATBOT_LLM_TIMEOUT_MS || 1700)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    const sharedSecret = String(process.env.CHATBOT_LLM_SHARED_SECRET || process.env.CHATBOT_SHARED_SECRET || '').trim();
    if (sharedSecret) headers['X-Chatbot-Llm-Secret'] = sharedSecret;

    const context = normalizeChatbotContext(contextHint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        context,
        planner: plannerHint || null,
        memory: memoryHint || null,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    const reply = String(data?.reply || '').trim();
    if (!reply) return null;

    return {
      reply: reply.slice(0, CHATBOT_MAX_REPLY),
      intent: String(data?.intent || '').trim().toLowerCase(),
      adaptive: data?.adaptive && typeof data.adaptive === 'object' ? data.adaptive : null,
      planner: data?.planner && typeof data.planner === 'object' ? data.planner : (plannerHint || null),
      memory: memoryHint || null,
      memory_update: data?.memory_update && typeof data.memory_update === 'object' ? data.memory_update : null,
      suggestions: mergeSuggestions(data?.suggestions, plannerSuggestionChips(data?.planner || plannerHint)),
      engine: String(data?.engine || 'llm-v1'),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function routeStatelessChatbot(req, message, contextHint = null, plannerHint = null, memoryHint = null) {
  const mode = chatbotRouterMode();
  const complexity = evaluateHybridComplexity(message, plannerHint);
  let payload = null;
  let selectedEngine = 'rule';

  if (mode === 'rule') {
    selectedEngine = 'rule';
    payload = runRuleEngineChatbot(message, contextHint, plannerHint, memoryHint);
  } else if (mode === 'python') {
    selectedEngine = 'python';
    payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
  } else if (mode === 'llm') {
    selectedEngine = 'llm';
    payload = await askLlmChatbot(req, message, contextHint, plannerHint, memoryHint);
    if (!payload) {
      selectedEngine = 'python';
      payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
    }
  } else {
    const allowLlm = chatbotLlmEnabled();
    if (!complexity.complex) {
      selectedEngine = 'rule';
      payload = runRuleEngineChatbot(message, contextHint, plannerHint, memoryHint);
    } else if (allowLlm) {
      selectedEngine = 'llm';
      payload = await askLlmChatbot(req, message, contextHint, plannerHint, memoryHint);
      if (!payload) {
        selectedEngine = 'python';
        payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
      }
    } else {
      selectedEngine = 'python';
      payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
    }
  }

  if (!payload) {
    selectedEngine = 'rule-fallback';
    payload = fallbackChatbotPayload(message, plannerHint, memoryHint);
  }

  return {
    ...payload,
    engine: String(payload.engine || selectedEngine),
    router: {
      mode,
      selected_engine: selectedEngine,
      complexity_score: complexity.score,
      complexity_level: complexity.level,
      complexity_threshold: complexity.threshold,
      reasons: complexity.reasons.slice(0, 6),
    },
  };
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method === 'POST') {
    const b = req.body || await readBody(req);
    const statelessMode = shouldUseStatelessBot(req, b);
    const feedback = statelessMode ? normalizeFeedbackPayload(b.feedback) : null;
    if (feedback) {
      const optionalUser = extractOptionalUser(req);
      if (!optionalUser) {
        res.status(401).json({ error: 'Login required to store feedback' });
        return;
      }
      const feedbackProfile = await writeZaiFeedback(optionalUser, feedback);
      sendJson(res, 200, {
        ok: true,
        feedback_profile: feedbackProfile,
      });
      return;
    }

    const message = typeof b.message === 'string' ? b.message.trim() : '';
    if (!message) {
      res.status(400).json({ error: 'Message required' });
      return;
    }

    if (statelessMode) {
      const optionalUser = extractOptionalUser(req);
      const planner = buildPlannerFrame(message);
      const memory = optionalUser ? await getZaiMemoryBundle(optionalUser).catch(() => null) : null;
      const learningHints = buildLearningHints(memory);
      const contextWithMemory = {
        ...(normalizeChatbotContext(b.context) || {}),
        memory_topics: Array.isArray(memory?.memory?.recent_topics) ? memory.memory.recent_topics.slice(0, 5) : [],
        unresolved_fields: Array.isArray(memory?.memory?.unresolved)
          ? memory.memory.unresolved.map((item) => String(item?.field || '')).filter(Boolean).slice(0, 6)
          : [],
        preferred_commands: learningHints.preferred_commands,
        avoid_commands: learningHints.avoid_commands,
        helpful_ratio: learningHints.helpful_ratio,
      };

      const studyPlanRequest = parseStudyPlanRequest(message);
      if (studyPlanRequest) {
        if (!optionalUser) {
          const reliability = buildReliabilityAssessment(message, planner, 'study_schedule');
          sendJson(res, 200, {
            reply: 'Bisa. Untuk bikin jadwal belajar dari waktu kosong yang akurat, login dulu supaya aku bisa baca jadwal kuliah kamu.',
            intent: 'study_schedule',
            response_id: randomUUID(),
            engine: 'study-plan-native',
            router: { mode: 'native', selected_engine: 'study-plan-native' },
            adaptive: null,
            planner,
            reliability,
            unified_memory: null,
            memory_update: null,
            suggestions: normalizeChatbotSuggestions([
              { label: 'Jadwal Besok Pagi', command: 'jadwal belajar besok pagi 120 menit', tone: 'info' },
              { label: 'Target 180 Menit', command: 'jadwal belajar 180 menit', tone: 'success' },
            ]),
          });
          return;
        }

        try {
          const studyPlan = await generateStudyPlanSnapshot(optionalUser, studyPlanRequest);
          const intent = 'study_schedule';
          const reliability = buildReliabilityAssessment(message, planner, intent);
          const rawReply = buildStudyPlanNaturalReply(studyPlan).slice(0, CHATBOT_MAX_REPLY);
          const reply = applyReliabilityFollowup(rawReply, reliability).slice(0, CHATBOT_MAX_REPLY);
          const memoryUpdate = buildStatelessMemoryUpdate(memory, intent, message, ['study']);
          const suggestions = applyLearningToSuggestions(buildStudyPlanSuggestions(studyPlan), learningHints);
          const responseId = randomUUID();

          const topics = normalizeRecentStrings([...extractMessageTopics(message), 'study'], 5);
          writeZaiMemoryBundle(optionalUser, {
            message,
            intent,
            reply,
            planner,
            context: { ...contextWithMemory, response_id: responseId },
            topics,
          }).catch(() => {});

          sendJson(res, 200, {
            reply,
            intent,
            response_id: responseId,
            engine: 'study-plan-native',
            router: { mode: 'native', selected_engine: 'study-plan-native' },
            adaptive: {
              style: String(contextWithMemory?.tone_mode || 'supportive'),
              focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
              urgency: 'medium',
              energy: 'normal',
              domain: 'kuliah',
            },
            planner,
            reliability,
            unified_memory: memory,
            memory_update: memoryUpdate,
            feedback_profile: normalizeFeedbackProfile(memory?.memory?.feedback_profile || {}),
            suggestions: normalizeChatbotSuggestions(suggestions),
          });
          return;
        } catch {
          // If study plan generation fails, continue to Python fallback.
        }
      }

      const payload = await routeStatelessChatbot(req, message, contextWithMemory, planner, memory);
      const intentOut = String(payload?.intent || '').trim().toLowerCase() || 'fallback';
      const plannerOut = payload?.planner && typeof payload.planner === 'object' ? payload.planner : planner;
      const reliability = buildReliabilityAssessment(message, plannerOut, intentOut);
      const memoryOut = payload?.memory && typeof payload.memory === 'object' ? payload.memory : memory;
      const memoryUpdate = payload?.memory_update && typeof payload.memory_update === 'object'
        ? payload.memory_update
        : buildStatelessMemoryUpdate(memoryOut, intentOut, message);
      const rawReplyCore = String(payload?.reply || '').slice(0, CHATBOT_MAX_REPLY);
      const replyCore = applyReliabilityFollowup(rawReplyCore, reliability).slice(0, CHATBOT_MAX_REPLY);
      const replyParts = [replyCore];
      const plannerInfo = plannerTextBlock(plannerOut);
      if (plannerInfo) replyParts.push(plannerInfo);
      const memoryInfo = memoryTextBlock(memoryOut);
      if (memoryInfo) replyParts.push(memoryInfo);
      const includeMeta = parseBooleanEnv(process.env.CHATBOT_INCLUDE_META || '');
      const finalReply = includeMeta
        ? replyParts.filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY)
        : replyCore;
      const suggestionsOut = applyLearningToSuggestions(payload?.suggestions, learningHints);
      const responseId = randomUUID();

      if (optionalUser) {
        const topics = extractMessageTopics(message);
        writeZaiMemoryBundle(optionalUser, {
          message,
          intent: intentOut,
          reply: finalReply,
          planner: plannerOut,
          context: { ...contextWithMemory, response_id: responseId },
          topics,
        }).catch(() => {});
      }

      sendJson(res, 200, {
        reply: finalReply,
        intent: intentOut,
        response_id: responseId,
        engine: String(payload?.engine || ''),
        router: payload?.router && typeof payload.router === 'object' ? payload.router : null,
        adaptive: payload?.adaptive && typeof payload.adaptive === 'object' ? payload.adaptive : null,
        planner: plannerOut,
        reliability,
        unified_memory: memoryOut,
        memory_update: memoryUpdate,
        feedback_profile: normalizeFeedbackProfile(memoryOut?.memory?.feedback_profile || {}),
        suggestions: normalizeChatbotSuggestions(suggestionsOut),
      });
      return;
    }

    const v = verifyToken(req, res);
    if (!v) return;
    const user = v.user;

    const r = await pool.query(
      'INSERT INTO chat_messages (user_id, message) VALUES ($1, $2) RETURNING *',
      [user, message]
    );
    sendJson(res, 200, r.rows[0]);
    return;
  }

  const v = verifyToken(req, res);
  if (!v) return;
  const user = v.user;

  if (req.method === 'GET') {
    const r = await pool.query('SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT 50');
    sendJson(res, 200, r.rows.reverse(), 15);
    return;
  }

  if (req.method === 'DELETE') {
    if (user !== 'Zaldy') {
      res.status(403).json({ error: 'Only admin can clear chat' });
      return;
    }
    await pool.query('DELETE FROM chat_messages');
    sendJson(res, 200, { ok: true });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
