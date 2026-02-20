import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { pool, readBody, verifyToken, withErrorHandling, sendJson, logActivity } from './_lib.js';
import { sendNotificationToUser } from './notifications.js';
import { generateStudyPlanSnapshot } from './study_plan.js';
import { createActionToken } from './action_token.js';
import { evaluatePushPolicy, logPushEvent } from './push_policy.js';

const CHATBOT_ENDPOINT_PATH = '/api/chatbot';
const CHATBOT_MAX_REPLY = 420;
const CHATBOT_MAX_SUGGESTIONS = 4;
const CHATBOT_MAX_RECENT_INTENTS = 6;
const CHATBOT_HYBRID_COMPLEXITY_THRESHOLD = 56;
const ZAI_MAX_ACTIONS = 5;
const FEEDBACK_HISTORY_LIMIT = 12;
const RELIABILITY_SAFE_SCORE = 78;
const ACTION_ENGINE_V2_MAX_WRITES = 4;
const ACTION_EXECUTION_KINDS = new Set(['create_task', 'create_assignment', 'set_reminder']);
const SEMANTIC_MEMORY_MAX_ITEMS = 4;
const SEMANTIC_MEMORY_EVENT_SCAN_LIMIT = 40;
const SEMANTIC_MEMORY_EMBED_BATCH_LIMIT = 14;

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

function chatbotActionEngineEnabled() {
  const raw = process.env.CHATBOT_ACTION_ENGINE_V2;
  if (raw == null || String(raw).trim() === '') return true;
  return parseBooleanEnv(raw);
}

function chatbotDecisionEngineEnabled() {
  const raw = process.env.CHATBOT_DECISION_ENGINE_V2;
  if (raw == null || String(raw).trim() === '') return true;
  return parseBooleanEnv(raw);
}

function semanticMemoryEnabled() {
  const raw = process.env.CHATBOT_SEMANTIC_MEMORY_ENABLED;
  if (raw == null || String(raw).trim() === '') return true;
  return parseBooleanEnv(raw);
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
  const semanticMemory = normalizeSemanticMemoryItems(input.semantic_memory, SEMANTIC_MEMORY_MAX_ITEMS);

  return {
    tone_mode: toneMode,
    focus_minutes: focusMinutes,
    focus_window: focusWindow,
    recent_intents: recentIntents,
    preferred_commands: preferredCommands,
    avoid_commands: avoidCommands,
    helpful_ratio: helpfulRatio,
    semantic_memory: semanticMemory,
  };
}

function resolveSemanticEmbeddingConfig() {
  const apiKey = String(process.env.CHATBOT_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const apiBase = String(process.env.CHATBOT_NEURAL_API_BASE || process.env.OPENAI_API_BASE || 'https://api.openai.com').trim();
  const model = String(process.env.CHATBOT_SEMANTIC_EMBED_MODEL || process.env.CHATBOT_NEURAL_EMBED_MODEL || 'text-embedding-3-small').trim();
  const timeoutMs = Math.max(350, Math.min(3500, Number(process.env.CHATBOT_SEMANTIC_TIMEOUT_MS || 1100)));
  return { apiKey, apiBase, model, timeoutMs };
}

function getSemanticEmbeddingCache() {
  const key = '__zaiSemanticEmbedCacheV1';
  if (!global[key] || typeof global[key] !== 'object') {
    global[key] = { vectors: new Map(), touched: Date.now() };
  }
  return global[key];
}

function buildSemanticEventText(row = {}) {
  const msg = String(row.message || '').replace(/\s+/g, ' ').trim();
  const reply = String(row.reply || '').replace(/\s+/g, ' ').trim();
  const base = [msg, reply].filter(Boolean).join(' || ');
  return base.slice(0, 420);
}

function tokenizeSemanticText(text = '') {
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\u00C0-\u024F]/gi, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 3);
  return tokens.slice(0, 80);
}

function lexicalSemanticScore(query = '', candidate = '') {
  const q = tokenizeSemanticText(query);
  const c = tokenizeSemanticText(candidate);
  if (!q.length || !c.length) return 0;
  const cSet = new Set(c);
  let hit = 0;
  for (const token of q) {
    if (cSet.has(token)) hit += 1;
  }
  const ratioQ = hit / q.length;
  const ratioC = hit / Math.max(1, c.length);
  return Math.max(0, Math.min(1, ratioQ * 0.75 + ratioC * 0.25));
}

function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return -1;
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = Number(a[i] || 0);
    const y = Number(b[i] || 0);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA <= 0 || normB <= 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeEmbedding(vec = []) {
  if (!Array.isArray(vec) || !vec.length) return [];
  let norm = 0;
  for (const value of vec) {
    const n = Number(value || 0);
    norm += n * n;
  }
  norm = Math.sqrt(norm);
  if (!Number.isFinite(norm) || norm <= 0) return [];
  return vec.map((value) => Number(value || 0) / norm);
}

function recencySemanticBonus(createdAt = '') {
  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) return 0;
  const hours = (Date.now() - ts) / 3600000;
  if (hours <= 24) return 0.05;
  if (hours <= 72) return 0.03;
  if (hours <= 168) return 0.015;
  return 0;
}

async function requestEmbeddingsOpenAI(inputs = [], config = null) {
  const list = Array.isArray(inputs) ? inputs.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return null;
  if (!config?.apiKey) return null;

  const endpoint = `${String(config.apiBase || 'https://api.openai.com').replace(/\/+$/, '')}/v1/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.timeoutMs || 1100));
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: String(config.model || 'text-embedding-3-small'),
        input: list,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    const rows = Array.isArray(json?.data) ? json.data : [];
    if (!rows.length) return null;
    const byIdx = new Map();
    for (const row of rows) {
      const idx = Number(row?.index);
      const emb = Array.isArray(row?.embedding) ? row.embedding : null;
      if (!Number.isFinite(idx) || !emb) continue;
      byIdx.set(idx, normalizeEmbedding(emb));
    }
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const vec = byIdx.get(i);
      if (!vec || !vec.length) return null;
      out.push(vec);
    }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSemanticMemoryEvents(userId = '', limit = SEMANTIC_MEMORY_EVENT_SCAN_LIMIT) {
  if (!userId) return [];
  const safeLimit = Math.max(8, Math.min(Number(limit) || SEMANTIC_MEMORY_EVENT_SCAN_LIMIT, 80));
  const res = await pool.query(
    `SELECT id, intent, message, reply, topics, created_at
     FROM z_ai_memory_events
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, safeLimit]
  );
  return Array.isArray(res?.rows) ? res.rows : [];
}

async function retrieveSemanticMemoryHints(userId = '', message = '', maxItems = SEMANTIC_MEMORY_MAX_ITEMS) {
  if (!semanticMemoryEnabled() || !userId || !String(message || '').trim()) return [];
  const events = await fetchSemanticMemoryEvents(userId, SEMANTIC_MEMORY_EVENT_SCAN_LIMIT);
  if (!events.length) return [];

  const scoredLexical = events
    .map((row) => {
      const text = buildSemanticEventText(row);
      return {
        row,
        text,
        lexical: lexicalSemanticScore(message, text),
      };
    })
    .filter((item) => item.text)
    .sort((a, b) => Number(b.lexical || 0) - Number(a.lexical || 0));

  const shortlist = scoredLexical.slice(0, SEMANTIC_MEMORY_EMBED_BATCH_LIMIT);
  if (!shortlist.length) return [];

  const config = resolveSemanticEmbeddingConfig();
  const canEmbed = Boolean(config.apiKey);
  let queryVector = null;
  const cache = getSemanticEmbeddingCache();
  const missingTexts = [];
  const missingMeta = [];
  if (canEmbed) {
    for (const item of shortlist) {
      const cacheKey = `event:${Number(item?.row?.id || 0)}`;
      const cached = cache.vectors.get(cacheKey);
      if (!cached || !Array.isArray(cached) || !cached.length) {
        missingTexts.push(item.text);
        missingMeta.push(cacheKey);
      }
    }
    const embedInput = [String(message || '').slice(0, 420), ...missingTexts];
    const vectors = await requestEmbeddingsOpenAI(embedInput, config);
    if (vectors && vectors.length === embedInput.length) {
      queryVector = vectors[0];
      for (let i = 0; i < missingMeta.length; i += 1) {
        cache.vectors.set(missingMeta[i], vectors[i + 1] || []);
      }
      cache.touched = Date.now();
    } else {
      queryVector = null;
    }
  }

  const ranked = shortlist
    .map((item) => {
      const cacheKey = `event:${Number(item?.row?.id || 0)}`;
      const vec = canEmbed ? cache.vectors.get(cacheKey) : null;
      let neural = null;
      if (canEmbed && queryVector && Array.isArray(vec) && vec.length) {
        const cos = cosineSimilarity(queryVector, vec);
        if (Number.isFinite(cos) && cos > -1) neural = Math.max(0, Math.min(1, (cos + 1) / 2));
      }
      const lexical = Number(item.lexical || 0);
      const hybrid = Number.isFinite(neural)
        ? (lexical * 0.4 + Number(neural || 0) * 0.6)
        : lexical;
      const finalScore = Math.max(0, Math.min(1, hybrid + recencySemanticBonus(item?.row?.created_at)));
      const topics = Array.isArray(item?.row?.topics) ? item.row.topics : [];
      const summary = String(item?.row?.reply || item?.row?.message || '').replace(/\s+/g, ' ').trim().slice(0, 180);
      return {
        id: Number(item?.row?.id || 0) || null,
        intent: String(item?.row?.intent || '').trim().toLowerCase() || null,
        summary,
        score: Number(finalScore.toFixed(4)),
        created_at: item?.row?.created_at || null,
        topics: normalizeRecentStrings(topics, 4),
      };
    })
    .filter((item) => item.summary && Number(item.score || 0) >= 0.18)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));

  return normalizeSemanticMemoryItems(ranked, maxItems);
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

function normalizeSemanticMemoryItems(list, max = SEMANTIC_MEMORY_MAX_ITEMS) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = Number(item.id || 0) || null;
    const intent = String(item.intent || '').trim().toLowerCase().slice(0, 40);
    const summary = String(item.summary || item.snippet || item.message || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const scoreNum = Number(item.score);
    const score = Number.isFinite(scoreNum) ? Math.max(0, Math.min(1, scoreNum)) : null;
    const createdAt = String(item.created_at || '').trim().slice(0, 40);
    const topics = normalizeRecentStrings(item.topics, 4);
    if (!summary) continue;
    const key = `${id || summary.toLowerCase()}::${intent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      intent: intent || null,
      summary,
      score,
      created_at: createdAt || null,
      topics,
    });
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
  if (/(\bdeadline\b|\bdue\b|\bbesok\b|\blusa\b|\btoday\b|\bhari ini\b|\btanggal\b|\d{1,2}[:.]\d{2}|\d{4}-\d{2}-\d{2})/i.test(text)) {
    return true;
  }
  return Boolean(parseNaturalDeadlineIso(text));
}

function hasReminderTimeSignal(text = '') {
  if (/(\b(besok|lusa|hari ini|today|tomorrow)\b|\btanggal\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[:.]\d{2}\b|\b(?:dalam\s+)?\d{1,3}\s*(?:menit|min|jam|hours?)\s*(?:lagi)?\b)/i.test(text)) {
    return true;
  }
  return Boolean(parseNaturalDeadlineIso(text));
}

function isLikelyCreateShorthandSegment(segment = '', kind = 'task') {
  const text = String(segment || '').trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const headPattern = kind === 'assignment'
    ? /^(assignment|tugas kuliah)\b/i
    : /^(task|tugas|todo|to-do)\b/i;
  if (!headPattern.test(text)) return false;

  if (/\b(pending|list|daftar|apa|belum|show|lihat|cek|status|report|ringkasan|summary)\b/i.test(lower)) {
    return false;
  }

  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return false;
  return true;
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
    const explicitCreateAssignment = /(?:buat|buatkan|tambah|add|create|catat|simpan)\s+(?:assignment|tugas kuliah)\b/i.test(lower);
    const shorthandCreateAssignment = isLikelyCreateShorthandSegment(segment, 'assignment');
    const explicitCreateTask = /(?:buat|buatkan|tambah|add|create|catat|simpan)\s+(?:task|tugas|todo|to-do)\b/i.test(lower);
    const shorthandCreateTask = isLikelyCreateShorthandSegment(segment, 'task');

    if (explicitCreateAssignment || shorthandCreateAssignment) {
      kind = 'create_assignment';
      summary = 'Buat tugas kuliah baru';
      if (!hasDeadlineSignal(lower)) missing.push('deadline');
      const titleProbe = explicitCreateAssignment
        ? segment.replace(/(?:buat|buatkan|tambah|add|create|catat|simpan)\s+(?:assignment|tugas kuliah)/ig, '').trim()
        : segment.replace(/^(?:assignment|tugas kuliah)\s*/i, '').trim();
      if (titleProbe.length < 3) missing.push('subject');
    } else if (explicitCreateTask || shorthandCreateTask) {
      kind = 'create_task';
      summary = 'Buat tugas baru';
      if (!hasDeadlineSignal(lower)) missing.push('deadline');
      const titleProbe = explicitCreateTask
        ? segment.replace(/(?:buat|buatkan|tambah|add|create|catat|simpan)\s+(?:task|tugas|todo|to-do)/ig, '').trim()
        : segment.replace(/^(?:task|tugas|todo|to-do)\s*/i, '').trim();
      if (titleProbe.length < 3) missing.push('title');
    } else if (/(?:ingatkan|ingetin|reminder|alarm|notifikasi|jangan lupa)/i.test(lower)) {
      kind = 'set_reminder';
      summary = 'Atur reminder fokus';
      if (!hasReminderTimeSignal(lower)) missing.push('time');
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
          : (field === 'time'
            ? 'Pengingatnya mau kapan? Contoh: besok 19:00 atau 30 menit lagi.'
            : 'Judul/tujuannya apa?'),
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

function normalizeActionText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractActionField(command = '', pattern = null) {
  if (!pattern) return '';
  const match = String(command || '').match(pattern);
  if (!match || !match[1]) return '';
  return normalizeActionText(match[1]);
}

function normalizeActionPriority(raw = '') {
  const lower = String(raw || '').trim().toLowerCase();
  if (!lower) return 'medium';
  if (lower === 'high' || lower === 'tinggi') return 'high';
  if (lower === 'low' || lower === 'rendah') return 'low';
  return 'medium';
}

function normalizeActionAssignee(raw = '', fallbackUser = '') {
  const value = String(raw || '').trim();
  if (!value) return fallbackUser || null;
  const lower = value.toLowerCase();
  if (lower.includes('zaldy')) return 'Zaldy';
  if (lower.includes('nesya')) return 'Nesya';
  return fallbackUser || value;
}

function stripActionMetaFromTitle(command = '') {
  let value = normalizeActionText(command);
  value = value.replace(/^\/ai\s+/i, '');
  value = value.replace(/^(?:tolong\s+|please\s+)?(?:z\s*ai|zai|ai)\s*/i, '');
  value = value.replace(/^(?:buatkan|buat|tambah|add|create|catat|simpan)\s+(?:assignment|tugas kuliah|task|tugas|todo|to-do)\s*/i, '');
  value = value.replace(/^(?:assignment|tugas kuliah|task|tugas|todo|to-do)\s*/i, '');
  value = value.replace(/\bdeadline(?:[\s-]*nya)?\b\s*:?\s+(.+?)(?=\s+\b(?:priority|prioritas|deskripsi|desc|assign(?:ed)?(?:\s*to)?|untuk)\b|$)/ig, '');
  value = value.replace(/\b(?:priority|prioritas)\s+[a-zA-Z]+\b/ig, '');
  value = value.replace(/\b(?:deskripsi|desc)\s+(.+?)(?=\s+\b(?:deadline|priority|prioritas|assign(?:ed)?(?:\s*to)?|untuk)\b|$)/ig, '');
  value = value.replace(/\b(?:assign(?:ed)?(?:\s*to)?|untuk)\s+[a-zA-Z0-9_.-]+\b/ig, '');
  return normalizeActionText(value).replace(/^[\s,:\-]+|[\s,:\-]+$/g, '');
}

function normalizeActionTokens(raw = '') {
  const stop = new Set([
    'buat', 'buatkan', 'tambah', 'add', 'create', 'catat', 'simpan',
    'tugas', 'kuliah', 'assignment', 'deadline', 'prioritas', 'priority',
    'deskripsi', 'desc', 'untuk', 'yang', 'dan', 'atau', 'di', 'ke', 'dari',
    'aku', 'saya', 'gue', 'gw', 'besok', 'lusa', 'hari', 'ini', 'jam', 'pukul',
    'mata', 'kuliah', 'matkul', 'mapel', 'kelas',
  ]);
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s\u00C0-\u024F]/gi, ' ')
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2 && !stop.has(x));
}

function extractAssignmentSubjectHint(command = '') {
  const text = normalizeActionText(command);
  if (!text) return '';
  const patterns = [
    /\b(?:mata\s*kuliah|matkul|mapel|mk|kelas)\s+(.+?)(?=\s+\b(?:deadline|priority|prioritas|deskripsi|desc|assign(?:ed)?(?:\s*to)?|untuk)\b|$)/i,
    /\btugas\s+kuliah\s+(?:untuk\s+)?(.+?)(?=\s+\b(?:deadline|priority|prioritas|deskripsi|desc)\b|$)/i,
  ];
  for (const pattern of patterns) {
    const found = extractActionField(text, pattern);
    if (found) {
      return normalizeActionText(found).replace(/^[,:\-]+|[,:\-]+$/g, '');
    }
  }
  return '';
}

function overlapRatio(subjectTokens = [], queryTokens = []) {
  if (!subjectTokens.length || !queryTokens.length) return 0;
  const querySet = new Set(queryTokens);
  let hit = 0;
  for (const token of subjectTokens) {
    if (querySet.has(token)) hit += 1;
  }
  return hit / subjectTokens.length;
}

function pickBestScheduleSubject(scheduleSubjects = [], candidates = []) {
  if (!Array.isArray(scheduleSubjects) || !scheduleSubjects.length) return null;
  const cleanedCandidates = candidates
    .map((item) => normalizeActionText(item))
    .filter(Boolean)
    .slice(0, 4);
  if (!cleanedCandidates.length) return null;

  const scored = scheduleSubjects.map((entry) => {
    const subject = normalizeActionText(entry?.subject || '');
    const lowerSubject = subject.toLowerCase();
    const subjectTokens = normalizeActionTokens(subject);
    let score = 0;

    cleanedCandidates.forEach((candidate, idx) => {
      const lowerCandidate = candidate.toLowerCase();
      const candidateTokens = normalizeActionTokens(candidate);
      const weight = idx === 0 ? 1.25 : idx === 1 ? 1 : 0.85;
      if (lowerCandidate.includes(lowerSubject)) score += 1.2 * weight;
      if (lowerSubject.includes(lowerCandidate) && lowerCandidate.length >= 4) score += 0.72 * weight;
      score += overlapRatio(subjectTokens, candidateTokens) * (0.92 * weight);
      if (subjectTokens[0] && candidateTokens[0] && subjectTokens[0] === candidateTokens[0]) {
        score += 0.28 * weight;
      }
    });

    return { entry, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  const top = scored[0];
  if (top.score < 0.52) return null;
  return { subject: top.entry.subject, score: top.score };
}

function deriveDescriptionFromSubjectTitle(rawTitle = '', resolvedSubject = '') {
  const title = normalizeActionText(rawTitle);
  const subject = normalizeActionText(resolvedSubject);
  if (!title || !subject) return '';

  const lowerTitle = title.toLowerCase();
  const lowerSubject = subject.toLowerCase();
  if (lowerTitle === lowerSubject) return '';

  let detail = title;
  if (lowerTitle.startsWith(`${lowerSubject} `)) {
    detail = title.slice(subject.length).trim();
  } else if (lowerTitle.startsWith(lowerSubject)) {
    detail = title.slice(subject.length).trim();
  }

  detail = detail.replace(/^[,:\-]+/, '').trim();
  detail = detail.replace(/^(?:tentang|untuk)\s+/i, '').trim();
  if (!detail || detail.toLowerCase() === lowerSubject) return '';
  return detail;
}

async function fetchScheduleSubjects(client) {
  const res = await client.query(
    `SELECT day_id, time_start, subject
     FROM schedule
     WHERE subject IS NOT NULL AND LENGTH(TRIM(subject)) > 0
     ORDER BY day_id ASC, time_start ASC, id ASC
     LIMIT 200`
  );
  const rows = Array.isArray(res?.rows) ? res.rows : [];
  const unique = new Map();
  rows.forEach((row) => {
    const subject = normalizeActionText(row?.subject || '');
    const key = subject.toLowerCase();
    if (!subject || unique.has(key)) return;
    unique.set(key, { subject, day_id: Number(row?.day_id || 0), time_start: String(row?.time_start || '') });
  });
  return [...unique.values()];
}

async function resolveAssignmentDraftWithSchedule(client, draft = {}) {
  if (!draft || String(draft.kind || '').toLowerCase() !== 'create_assignment') return draft;

  const rawTitle = normalizeActionText(draft.raw_title || draft.title || '');
  const explicitHint = extractAssignmentSubjectHint(draft.command || '');
  const scheduleSubjects = await fetchScheduleSubjects(client).catch(() => []);
  if (!scheduleSubjects.length) {
    return {
      ...draft,
      title: rawTitle || draft.title || '',
      description: draft.description || null,
    };
  }

  const best = pickBestScheduleSubject(scheduleSubjects, [explicitHint, rawTitle, draft.command || '']);
  const fallbackSingle = !rawTitle && scheduleSubjects.length === 1 ? scheduleSubjects[0].subject : '';
  const resolvedTitle = normalizeActionText(best?.subject || fallbackSingle || rawTitle || draft.title || '');
  const derivedDescription = draft.description
    ? ''
    : deriveDescriptionFromSubjectTitle(rawTitle, resolvedTitle);

  const mergedMissing = new Set(Array.isArray(draft.missing) ? draft.missing : []);
  if (!resolvedTitle) mergedMissing.add('subject');
  else {
    mergedMissing.delete('subject');
    mergedMissing.delete('title');
  }

  return {
    ...draft,
    title: resolvedTitle,
    description: draft.description || (derivedDescription || null),
    missing: [...mergedMissing],
    subject_source: best ? 'schedule_match' : (fallbackSingle ? 'single_schedule' : 'raw'),
  };
}

function parseNaturalMonthIndex(raw = '') {
  const token = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!token) return null;
  const map = {
    jan: 0, januari: 0, january: 0,
    feb: 1, februari: 1, february: 1, febuari: 1, pebruari: 1,
    mar: 2, maret: 2, march: 2,
    apr: 3, april: 3,
    mei: 4, may: 4,
    jun: 5, juni: 5, june: 5,
    jul: 6, juli: 6, july: 6,
    agu: 7, ags: 7, agt: 7, agustus: 7, aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    okt: 9, october: 9, oktober: 9, oct: 9,
    nov: 10, november: 10,
    des: 11, desember: 11, december: 11, dec: 11,
  };
  return Object.prototype.hasOwnProperty.call(map, token) ? map[token] : null;
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

function parseExplicitTimeParts(lower = '') {
  const text = String(lower || '').toLowerCase();
  const colon = text.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/);
  const word = text.match(/\b(?:jam|pukul)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b/);
  const picked = colon || word;
  if (!picked) return null;

  let hour = Number(picked[1]);
  let minute = Number(picked[2] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const hasPagi = /\bpagi\b/.test(text);
  const hasSiang = /\bsiang\b/.test(text);
  const hasSore = /\b(sore|petang)\b/.test(text);
  const hasMalam = /\bmalam\b/.test(text);

  if (hasPagi && hour === 12) hour = 0;
  if ((hasSore || hasMalam) && hour < 12) hour += 12;
  if (hasSiang && hour >= 1 && hour <= 6) hour += 12;

  return { hour, minute };
}

function parseNaturalDeadlineIso(raw = '') {
  const text = normalizeActionText(raw);
  if (!text) return null;
  const lower = text.toLowerCase();
  const now = new Date();
  now.setSeconds(0, 0);
  const taggedYearHint = lower.match(/\b(?:tahun|thn|taun|tahunnya|taunya|year)\s*(20\d{2})\b/);
  const genericYearHint = lower.match(/\b(20\d{2})\b/);
  const yearHint = taggedYearHint
    ? Number(taggedYearHint[1])
    : (genericYearHint ? Number(genericYearHint[1]) : null);

  let base = null;
  const iso = lower.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]) - 1;
    const d = Number(iso[3]);
    const parsed = new Date(y, m, d);
    if (!Number.isNaN(parsed.getTime())) base = parsed;
  }

  if (!base) {
    const dmy = lower.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
    if (dmy) {
      const parsed = buildNaturalDateWithYear(
        Number(dmy[1]),
        Number(dmy[2]) - 1,
        normalizeYearCandidate(dmy[3], yearHint),
        now
      );
      if (parsed && !Number.isNaN(parsed.getTime())) base = parsed;
    }
  }

  if (!base) {
    const dayMonthWord = lower.match(/\b(?:tanggal\s*)?(\d{1,2})\s*(?:[\/.,-]\s*)?([a-z]{3,12})\.?(?:\s*(?:tahun\s*)?(\d{4}))?\b/);
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
    const monthDayWord = lower.match(/\b([a-z]{3,12})\.?\s+(\d{1,2})(?:\s*,?\s*(?:tahun\s*)?(\d{4}))?\b/);
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
    if (/\b(lusa|day after tomorrow)\b/.test(lower)) {
      base = new Date(now);
      base.setDate(base.getDate() + 2);
    } else if (/\b(besok|tomorrow)\b/.test(lower)) {
      base = new Date(now);
      base.setDate(base.getDate() + 1);
    } else if (/\b(hari ini|today)\b/.test(lower)) {
      base = new Date(now);
    }
  }

  const explicitTime = parseExplicitTimeParts(lower);
  if (!base) {
    const hasCalendarToken = /(\b(?:hari ini|today|besok|tomorrow|lusa|day after tomorrow)\b|\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}|\b(?:jan|januari|january|feb|februari|february|febuari|pebruari|mar|maret|march|apr|april|mei|may|jun|juni|june|jul|juli|july|agu|ags|agt|agustus|aug|august|sep|sept|september|okt|oktober|oct|october|nov|november|des|desember|dec|december)\b)/i.test(lower);
    if (hasCalendarToken) {
      const parsed = new Date(text);
      if (!Number.isNaN(parsed.getTime())) {
        parsed.setSeconds(0, 0);
        return parsed.toISOString();
      }
    }
    if (explicitTime) {
      base = new Date(now);
      base.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
      if (base.getTime() <= now.getTime()) base.setDate(base.getDate() + 1);
      return base.toISOString();
    }
    return null;
  }

  if (explicitTime) {
    base.setHours(explicitTime.hour, explicitTime.minute, 0, 0);
  } else {
    base.setHours(21, 0, 0, 0);
  }

  if (!Number.isFinite(base.getTime())) return null;
  return base.toISOString();
}

function buildActionClarificationQuestion(kind = '', field = '') {
  const actionKind = String(kind || '').toLowerCase();
  const key = String(field || '').toLowerCase();
  if (key === 'subject') {
    return actionKind === 'create_assignment'
      ? 'Mata kuliahnya apa? Contoh: Kalkulus II.'
      : 'Subjeknya apa?';
  }
  if (key === 'time') {
    return 'Pengingatnya mau kapan? Contoh: besok 19:00 atau 30 menit lagi.';
  }
  if (key === 'deadline') {
    return actionKind === 'create_assignment'
      ? 'Deadline tugas kuliah ini kapan? Contoh: besok 19:00.'
      : 'Deadline tugas ini kapan? Contoh: besok 19:00.';
  }
  if (key === 'title') {
    return actionKind === 'create_assignment'
      ? 'Judul tugas kuliahnya apa?'
      : 'Judul tugasnya apa?';
  }
  return 'Boleh lengkapi detail yang kurang dulu?';
}

function parseCreateActionDraft(action = {}, fallbackUser = '') {
  const kind = String(action?.kind || '').trim().toLowerCase();
  const command = normalizeActionText(action?.command || '');
  const deadlineChunk = extractActionField(
    command,
    /\bdeadline(?:[\s-]*nya)?\b\s*:?\s+(.+?)(?=\s+\b(?:priority|prioritas|deskripsi|desc|assign(?:ed)?(?:\s*to)?|untuk)\b|$)/i
  );
  const description = extractActionField(
    command,
    /\b(?:deskripsi|desc)\s+(.+?)(?=\s+\b(?:deadline|priority|prioritas|assign(?:ed)?(?:\s*to)?|untuk)\b|$)/i
  );
  const priority = normalizeActionPriority(
    extractActionField(command, /\b(?:priority|prioritas)\s+([a-zA-Z]+)/i)
  );
  const assignee = normalizeActionAssignee(
    extractActionField(command, /\b(?:assign(?:ed)?(?:\s*to)?|untuk)\s+([a-zA-Z0-9_.-]+)/i),
    fallbackUser
  );
  const strippedTitle = stripActionMetaFromTitle(command);
  const subjectHint = kind === 'create_assignment' ? extractAssignmentSubjectHint(command) : '';
  const title = kind === 'create_assignment'
    ? normalizeActionText(strippedTitle || subjectHint)
    : strippedTitle;
  const deadline = parseNaturalDeadlineIso(deadlineChunk || (hasDeadlineSignal(command) ? command : ''));

  const missing = [];
  if (!title) missing.push(kind === 'create_assignment' ? 'subject' : 'title');
  if (!deadline) missing.push('deadline');

  return {
    action_id: String(action?.id || '').trim(),
    kind,
    command,
    title,
    raw_title: strippedTitle || subjectHint || title,
    deadline,
    priority,
    description: description || null,
    assigned_to: assignee,
    missing,
  };
}

function partnerUser(user = '') {
  const normalized = String(user || '').trim().toLowerCase();
  if (normalized === 'zaldy') return 'Nesya';
  if (normalized === 'nesya') return 'Zaldy';
  return '';
}

function parseReminderAtIso(command = '') {
  const text = normalizeActionText(command);
  if (!text) return null;
  const lower = text.toLowerCase();
  const now = new Date();
  now.setSeconds(0, 0);

  const relativeMinutes = lower.match(/\b(?:dalam\s+)?(\d{1,3})\s*(?:menit|min)\s*(?:lagi)?\b/i);
  if (relativeMinutes) {
    const minutes = Math.max(1, Math.min(720, Number(relativeMinutes[1] || 0)));
    const target = new Date(now.getTime() + minutes * 60000);
    return target.toISOString();
  }

  const relativeHours = lower.match(/\b(?:dalam\s+)?(\d{1,2})\s*(?:jam|hours?)\s*(?:lagi)?\b/i);
  if (relativeHours) {
    const hours = Math.max(1, Math.min(72, Number(relativeHours[1] || 0)));
    const target = new Date(now.getTime() + hours * 3600000);
    return target.toISOString();
  }

  const parsed = parseNaturalDeadlineIso(text);
  if (!parsed) return null;
  const hasExplicitTime = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.test(lower)
    || /\b(?:jam|pukul)\s*([01]?\d|2[0-3])(?:[:.]([0-5]\d))?\b/.test(lower);
  if (hasExplicitTime) return parsed;

  const byWindow = /\bpagi\b/.test(lower)
    ? [8, 0]
    : (/\bsiang\b/.test(lower)
      ? [13, 0]
      : (/\b(sore|petang)\b/.test(lower)
        ? [17, 30]
        : (/\bmalam\b/.test(lower) ? [19, 30] : null)));
  if (!byWindow) return parsed;

  const adjusted = new Date(parsed);
  adjusted.setHours(byWindow[0], byWindow[1], 0, 0);
  return adjusted.toISOString();
}

function parseReminderTargetUser(command = '', fallbackUser = '') {
  const lower = String(command || '').toLowerCase();
  if (/\bnesya\b/.test(lower)) return 'Nesya';
  if (/\bzaldy\b/.test(lower)) return 'Zaldy';
  if (/\b(pasangan|partner|couple)\b/.test(lower)) {
    return partnerUser(fallbackUser) || fallbackUser || null;
  }
  return fallbackUser || null;
}

function stripReminderMetaFromText(command = '') {
  let value = normalizeActionText(command);
  value = value.replace(/^\/ai\s+/i, '');
  value = value.replace(/^(?:tolong\s+|please\s+|pls\s+)?(?:z\s*ai|zai|ai)\s*/i, '');
  value = value.replace(/^(?:ingatkan|ingetin|reminder|alarm|notifikasi)\s*/i, '');
  value = value.replace(/\b(?:aku|saya|gue|gw|me|pasangan|partner|couple|zaldy|nesya)\b/ig, ' ');
  value = value.replace(/\b(?:dalam\s+)?\d{1,3}\s*(?:menit|min|jam|hours?)\s*(?:lagi)?\b/ig, ' ');
  value = value.replace(/\b(?:besok|lusa|hari ini|today|tomorrow|pagi|siang|sore|petang|malam)\b/ig, ' ');
  value = value.replace(/\b(?:pukul|jam)\b/ig, ' ');
  value = value.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ');
  value = value.replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');
  value = value.replace(/\b(?:untuk|soal|tentang)\b/ig, ' ');
  value = value.replace(/^[\s,:\-]+|[\s,:\-]+$/g, '');
  return normalizeActionText(value);
}

function parseReminderText(command = '') {
  const direct = extractActionField(
    command,
    /\b(?:untuk|soal|tentang)\s+(.+?)(?=\s+\b(?:dalam\s+\d{1,3}\s*(?:menit|min|jam)|besok|lusa|hari ini|today|tomorrow|pukul|jam|\d{1,2}[:.]\d{2}|\d{4}-\d{2}-\d{2})\b|$)/i
  );
  const cleaned = direct || stripReminderMetaFromText(command);
  return cleaned || 'lanjutkan prioritas utama';
}

function isGenericReminderText(text = '') {
  const normalized = normalizeActionText(text).toLowerCase();
  if (!normalized) return true;
  const generic = new Set([
    'lanjutkan prioritas utama',
    'ingatkan',
    'reminder',
    'tugas',
    'tugas kuliah',
    'kuliah',
    'belajar',
    'cek tugas',
  ]);
  if (generic.has(normalized)) return true;
  if (/^(?:cek|review|ingatkan)\s+(?:deadline|tugas|kuliah)$/i.test(normalized)) return true;
  return false;
}

function parseReminderActionDraft(action = {}, fallbackUser = '') {
  const command = normalizeActionText(action?.command || '');
  const remindAt = parseReminderAtIso(command);
  const reminderText = parseReminderText(command);
  const targetUser = parseReminderTargetUser(command, fallbackUser);
  const missing = [];
  if (!remindAt) missing.push('time');
  return {
    action_id: String(action?.id || '').trim(),
    kind: 'set_reminder',
    command,
    reminder_text: reminderText,
    remind_at: remindAt,
    target_user: targetUser,
    missing,
  };
}

async function resolveReminderDraftWithSchedule(client, draft = {}) {
  if (!draft || String(draft.kind || '').toLowerCase() !== 'set_reminder') return draft;
  const scheduleSubjects = await fetchScheduleSubjects(client).catch(() => []);
  if (!scheduleSubjects.length) return draft;

  const subjectHint = extractAssignmentSubjectHint(draft.command || '');
  const best = pickBestScheduleSubject(scheduleSubjects, [
    subjectHint,
    draft.reminder_text || '',
    draft.command || '',
  ]);
  const subject = normalizeActionText(best?.subject || '');
  if (!subject) return draft;

  const currentText = normalizeActionText(draft.reminder_text || '');
  if (isGenericReminderText(currentText)) {
    return {
      ...draft,
      reminder_text: `kerjakan tugas kuliah ${subject}`,
      subject_source: 'schedule_match',
    };
  }

  if (/\btugas\s+kuliah\b/i.test(currentText) && !new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(currentText)) {
    return {
      ...draft,
      reminder_text: `${currentText} (${subject})`,
      subject_source: 'schedule_match',
    };
  }

  return draft;
}

function buildActionEnginePlan(planner = null, fallbackUser = '') {
  const actions = Array.isArray(planner?.actions) ? planner.actions : [];
  const drafts = actions
    .filter((item) => ACTION_EXECUTION_KINDS.has(String(item?.kind || '').trim().toLowerCase()))
    .slice(0, ACTION_ENGINE_V2_MAX_WRITES)
    .map((item) => {
      const kind = String(item?.kind || '').trim().toLowerCase();
      if (kind === 'set_reminder') return parseReminderActionDraft(item, fallbackUser);
      return parseCreateActionDraft(item, fallbackUser);
    });

  const clarifications = [];
  for (const draft of drafts) {
    for (const field of draft.missing || []) {
      clarifications.push({
        action_id: draft.action_id,
        field,
        question: buildActionClarificationQuestion(draft.kind, field),
      });
    }
  }

  return {
    has_actions: drafts.length > 0,
    drafts,
    clarifications,
  };
}

function buildActionPlannerResult(basePlanner = null, actionPlan = null, execution = null) {
  const safePlanner = basePlanner && typeof basePlanner === 'object'
    ? { ...basePlanner }
    : { mode: 'single', confidence: 'medium', requires_clarification: false, clarifications: [], actions: [] };
  const baseActions = Array.isArray(safePlanner.actions) ? safePlanner.actions : [];
  const drafts = Array.isArray(actionPlan?.drafts) ? actionPlan.drafts : [];
  const baseClarifications = Array.isArray(safePlanner.clarifications) ? safePlanner.clarifications : [];
  const extraClarifications = Array.isArray(actionPlan?.clarifications) ? actionPlan.clarifications : [];
  const clarifications = [...baseClarifications];
  for (const item of extraClarifications) {
    const key = `${item?.action_id || ''}:${item?.field || ''}`;
    const exists = clarifications.some((c) => `${c?.action_id || ''}:${c?.field || ''}` === key);
    if (!exists) clarifications.push(item);
  }

  const executedById = new Map();
  for (const item of execution?.executed || []) {
    const key = String(item?.action_id || '').trim();
    if (key) executedById.set(key, item);
  }
  const failedById = new Map();
  for (const item of execution?.failed || []) {
    const key = String(item?.action_id || '').trim();
    if (key) failedById.set(key, item);
  }
  const draftById = new Map();
  for (const draft of drafts) {
    const key = String(draft?.action_id || '').trim();
    if (key) draftById.set(key, draft);
  }

  const actions = baseActions.map((action) => {
    const id = String(action?.id || '').trim();
    if (!id) return action;
    const draft = draftById.get(id);
    if (!draft) return action;
    if (executedById.has(id)) {
      return { ...action, status: 'completed', missing: [] };
    }
    if (failedById.has(id)) {
      return { ...action, status: 'failed', missing: [] };
    }
    if (Array.isArray(draft.missing) && draft.missing.length) {
      return { ...action, status: 'blocked', missing: draft.missing.slice(0, 3) };
    }
    return { ...action, status: 'ready', missing: [] };
  });

  const executedCount = Number(execution?.executed?.length || 0);
  const failedCount = Number(execution?.failed?.length || 0);
  const blockedCount = drafts.filter((item) => Array.isArray(item.missing) && item.missing.length).length;
  const requiresClarification = clarifications.length > 0;

  let summary = safePlanner.summary || 'Rencana aksi siap.';
  if (executedCount > 0) {
    summary = `Mesin aksi mengeksekusi ${executedCount} item.`;
  } else if (requiresClarification) {
    summary = 'Mesin aksi butuh detail tambahan sebelum eksekusi.';
  }
  if (failedCount > 0) {
    summary = `${summary} ${failedCount} item gagal disimpan.`;
  }

  return {
    ...safePlanner,
    actions,
    clarifications,
    requires_clarification: requiresClarification,
    confidence: failedCount > 0 ? 'medium' : (requiresClarification ? 'medium' : 'high'),
    summary,
    next_best_action: requiresClarification
      ? (clarifications[0]?.question || 'Lengkapi detail yang kurang.')
      : (failedCount > 0 ? 'Ulangi item yang gagal.' : 'Lanjut ke evaluasi atau radar mendesak.'),
    action_execution: {
      executed_count: executedCount,
      blocked_count: blockedCount,
      failed_count: failedCount,
    },
  };
}

async function insertAssignmentFromAction(client, payload = {}) {
  const title = String(payload.title || '').trim();
  const description = payload.description ? String(payload.description).trim() : null;
  const deadline = payload.deadline ? new Date(payload.deadline) : null;
  const assignedTo = payload.assigned_to ? String(payload.assigned_to).trim() : null;
  try {
    const withAssignee = await client.query(
      'INSERT INTO assignments (title, description, deadline, assigned_to) VALUES ($1, $2, $3, $4) RETURNING *',
      [title, description, deadline, assignedTo]
    );
    return withAssignee.rows[0] || null;
  } catch (err) {
    const message = String(err?.message || '').toLowerCase();
    if (!message.includes('assigned_to')) throw err;
    const fallback = await client.query(
      'INSERT INTO assignments (title, description, deadline) VALUES ($1, $2, $3) RETURNING *',
      [title, description, deadline]
    );
    return fallback.rows[0] || null;
  }
}

async function executeActionEngineWrites(userId = '', actionPlan = null) {
  await ensureZaiMemorySchema();
  const drafts = Array.isArray(actionPlan?.drafts)
    ? actionPlan.drafts.filter((item) => Array.isArray(item?.missing) ? item.missing.length === 0 : false)
    : [];
  if (!drafts.length) {
    return { executed: [], failed: [] };
  }

  const client = await pool.connect();
  const executed = [];
  const failed = [];
  try {
    await client.query('BEGIN');
    for (let idx = 0; idx < drafts.length; idx += 1) {
      const draft = drafts[idx];
      const savepoint = `zai_action_${idx + 1}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        if (draft.kind === 'create_task') {
          const taskRes = await client.query(
            `INSERT INTO tasks (title, created_by, updated_by, deadline, priority, assigned_to)
             VALUES ($1, $2, $2, $3, $4, $5)
             RETURNING id, title, deadline, priority, assigned_to`,
            [
              draft.title,
              userId,
              draft.deadline ? new Date(draft.deadline) : null,
              draft.priority || 'medium',
              draft.assigned_to || userId,
            ]
          );
          const row = taskRes.rows[0] || {};
          await logActivity(client, 'task', row.id, 'CREATE', userId, {
            title: row.title,
            deadline: row.deadline || null,
            priority: row.priority || draft.priority || 'medium',
            assigned_to: row.assigned_to || draft.assigned_to || userId,
            source: 'z_ai_action_v2',
          });
          executed.push({
            action_id: draft.action_id,
            kind: draft.kind,
            entity: 'task',
            id: row.id,
            title: row.title || draft.title,
            deadline: row.deadline || draft.deadline,
          });
        } else if (draft.kind === 'create_assignment') {
          const normalizedDraft = await resolveAssignmentDraftWithSchedule(client, draft);
          if (Array.isArray(normalizedDraft?.missing) && normalizedDraft.missing.length) {
            throw new Error(buildActionClarificationQuestion('create_assignment', normalizedDraft.missing[0]));
          }
          const row = await insertAssignmentFromAction(client, normalizedDraft);
          await logActivity(client, 'assignment', row?.id, 'CREATE', userId, {
            title: row?.title || normalizedDraft.title,
            description: row?.description || normalizedDraft.description || null,
            deadline: row?.deadline || normalizedDraft.deadline || null,
            assigned_to: row?.assigned_to || normalizedDraft.assigned_to || userId,
            source: 'z_ai_action_v2',
            subject_source: normalizedDraft.subject_source || 'raw',
          });
          executed.push({
            action_id: draft.action_id,
            kind: draft.kind,
            entity: 'assignment',
            id: row?.id,
            title: row?.title || normalizedDraft.title,
            deadline: row?.deadline || normalizedDraft.deadline,
          });
        } else if (draft.kind === 'set_reminder') {
          const normalizedReminderDraft = await resolveReminderDraftWithSchedule(client, draft);
          const rowRes = await client.query(
            `INSERT INTO z_ai_reminders (
               user_id,
               target_user,
               reminder_text,
               remind_at,
               status,
               source_command,
               payload,
               created_at
             )
             VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb, NOW())
             RETURNING id, user_id, target_user, reminder_text, remind_at, status`,
            [
              userId,
              normalizedReminderDraft.target_user || userId,
              normalizedReminderDraft.reminder_text || 'lanjutkan prioritas utama',
              normalizedReminderDraft.remind_at ? new Date(normalizedReminderDraft.remind_at) : null,
              normalizedReminderDraft.command || '',
              JSON.stringify({
                source: 'z_ai_action_v2',
                kind: 'set_reminder',
                subject_source: normalizedReminderDraft.subject_source || 'raw',
              }),
            ]
          );
          const row = rowRes.rows[0] || {};
          await logActivity(client, 'reminder', row.id, 'CREATE', userId, {
            reminder_text: row.reminder_text || normalizedReminderDraft.reminder_text || '',
            remind_at: row.remind_at || normalizedReminderDraft.remind_at || null,
            target_user: row.target_user || normalizedReminderDraft.target_user || userId,
            source: 'z_ai_action_v2',
            subject_source: normalizedReminderDraft.subject_source || 'raw',
          });
          executed.push({
            action_id: draft.action_id,
            kind: draft.kind,
            entity: 'reminder',
            id: row.id,
            title: row.reminder_text || normalizedReminderDraft.reminder_text || 'Pengingat',
            deadline: row.remind_at || normalizedReminderDraft.remind_at || null,
            target_user: row.target_user || normalizedReminderDraft.target_user || userId,
          });
        }
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        failed.push({
          action_id: draft.action_id,
          kind: draft.kind,
          reason: normalizeActionText(err?.message || 'gagal').slice(0, 180),
        });
      }
    }
    await client.query('COMMIT');
    return { executed, failed };
  } catch {
    await client.query('ROLLBACK');
    return { executed: [], failed: [] };
  } finally {
    client.release();
  }
}

function buildActionExecutionReply(execution = null, clarifications = [], options = {}) {
  const executed = Array.isArray(execution?.executed) ? execution.executed : [];
  const failed = Array.isArray(execution?.failed) ? execution.failed : [];
  const asks = Array.isArray(clarifications) ? clarifications : [];
  const lines = [];
  const styleRaw = String(options?.style || options?.tone_mode || '').trim().toLowerCase();
  const style = ['supportive', 'strict', 'balanced'].includes(styleRaw) ? styleRaw : 'supportive';
  const focusMinutesRaw = Number(options?.focus_minutes);
  const focusMinutes = Number.isFinite(focusMinutesRaw)
    ? Math.max(10, Math.min(180, Math.round(focusMinutesRaw)))
    : 25;

  const shortTitle = (value = '') => {
    const text = normalizeActionText(value || '');
    if (!text) return 'item';
    return text.length > 52 ? `${text.slice(0, 52).trim()}...` : text;
  };

  const joinLabels = (labels = []) => {
    const list = labels.filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    if (list.length === 2) return `${list[0]} dan ${list[1]}`;
    return `${list.slice(0, -1).join(', ')}, dan ${list[list.length - 1]}`;
  };

  const deadlineHoursLeft = (value = '') => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return (date.getTime() - Date.now()) / 3600000;
  };

  const buildUrgencyReason = (items = []) => {
    let nearest = null;
    for (const item of items) {
      const hours = deadlineHoursLeft(item?.deadline || '');
      if (!Number.isFinite(hours)) continue;
      if (nearest === null || hours < nearest) nearest = hours;
    }
    if (!Number.isFinite(nearest)) return '';
    if (nearest <= 0) return 'karena ada yang sudah lewat deadline.';
    if (nearest <= 12) return 'karena ada deadline kurang dari 12 jam.';
    if (nearest <= 24) return 'karena ada deadline kurang dari 24 jam.';
    if (nearest <= 48) return 'karena ada deadline dalam 2 hari.';
    return '';
  };

  const styleLine = {
    supportive: {
      done: (count, labels) => `Beres, aku sudah masukin ${count} item: ${joinLabels(labels)}.`,
      suggest: (title, reason) => reason
        ? `Biar ringan, mulai dari "${title}" dulu ${reason}`
        : `Biar konsisten, mulai dari "${title}" dulu, lanjut item kedua setelah ${focusMinutes} menit.`,
      reminder: (count, labels) => `Pengingat juga sudah aktif ${count} item: ${joinLabels(labels)}.`,
      ask: (question) => `Biar sisanya langsung jalan, ${question}`,
      fail: (count) => `Ada ${count} item yang belum berhasil kusimpan. Coba kirim ulang sekali lagi, nanti aku lanjutkan otomatis.`,
      idle: 'Aku siap eksekusi otomatis. Kirim perintah tugas, tugas kuliah, atau pengingat, nanti aku proses langsung.',
    },
    balanced: {
      done: (count, labels) => `Siap, ${count} item sudah tersimpan: ${joinLabels(labels)}.`,
      suggest: (title, reason) => reason
        ? `Prioritas berikutnya: kerjakan "${title}" dulu ${reason}`
        : `Prioritas berikutnya: kerjakan "${title}" dulu, lalu lanjut item kedua setelah ${focusMinutes} menit.`,
      reminder: (count, labels) => `Pengingat aktif ${count} item: ${joinLabels(labels)}.`,
      ask: (question) => `Untuk lanjut eksekusi, ${question}`,
      fail: (count) => `${count} item belum berhasil disimpan. Kirim ulang agar aku lanjutkan.`,
      idle: 'Z AI siap eksekusi otomatis. Kirim perintah tugas, tugas kuliah, atau pengingat.',
    },
    strict: {
      done: (count, labels) => `Eksekusi selesai. ${count} item tersimpan: ${joinLabels(labels)}.`,
      suggest: (title, reason) => reason
        ? `Langkah berikutnya: kerjakan "${title}" sekarang ${reason}`
        : `Langkah berikutnya: kerjakan "${title}" sekarang. Sesi fokus ${focusMinutes} menit, tanpa distraksi.`,
      reminder: (count, labels) => `Pengingat aktif ${count} item: ${joinLabels(labels)}.`,
      ask: (question) => `Lengkapi dulu: ${question}`,
      fail: (count) => `${count} item gagal tersimpan. Kirim ulang dengan detail yang jelas.`,
      idle: 'Siap eksekusi. Kirim perintah langsung.',
    },
  }[style];

  if (executed.length > 0) {
    const reminderItems = executed.filter((item) => item?.entity === 'reminder');
    const createdItems = executed.filter((item) => item?.entity !== 'reminder');

    if (createdItems.length > 0) {
      const labels = createdItems
        .slice(0, 3)
        .map((item) => `${item.entity === 'assignment' ? 'tugas kuliah' : 'tugas'} "${shortTitle(item.title)}"`);
      lines.push(styleLine.done(createdItems.length, labels));

      const reason = buildUrgencyReason(createdItems);
      lines.push(styleLine.suggest(shortTitle(createdItems[0]?.title || ''), reason));
    }

    if (reminderItems.length > 0) {
      const reminderLabel = reminderItems
        .slice(0, 2)
        .map((item) => {
          const label = shortTitle(item.title);
          const due = formatReminderDueLabel(item.deadline || '');
          return due ? `"${label}" (${due})` : `"${label}"`;
        });
      lines.push(styleLine.reminder(reminderItems.length, reminderLabel));
    }
  }

  if (asks.length > 0) {
    lines.push(styleLine.ask(asks[0].question));
  }

  if (failed.length > 0) {
    lines.push(styleLine.fail(failed.length));
  }

  if (!lines.length) {
    return styleLine.idle;
  }
  return lines.join(' ').slice(0, CHATBOT_MAX_REPLY);
}

function formatReminderDueLabel(value = '') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('id-ID', {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function buildDueReminderFollowup(reminders = []) {
  const list = Array.isArray(reminders) ? reminders : [];
  if (!list.length) return '';
  const sample = list.slice(0, 2).map((item) => {
    const title = String(item?.reminder_text || '').trim();
    const time = formatReminderDueLabel(item?.remind_at || '');
    if (!title) return '';
    return time ? `"${title}" (${time})` : `"${title}"`;
  }).filter(Boolean);
  if (!sample.length) return '';
  const suffix = list.length > sample.length ? ` (+${list.length - sample.length} lagi)` : '';
  return `Pengingat jatuh tempo: ${sample.join(', ')}${suffix}.`;
}

function buildActionExecutionSuggestions(execution = null, clarifications = [], scheduleSubjects = [], options = {}) {
  const contextAssignment = Boolean(options?.assignment_context);
  const contextReminder = Boolean(options?.reminder_context);
  const suggestions = [];
  const subjectSuggestions = [];
  const reminderSuggestions = [];
  const executed = Array.isArray(execution?.executed) ? execution.executed : [];
  const hasTask = executed.some((item) => item?.entity === 'task');
  const hasAssignment = executed.some((item) => item?.entity === 'assignment');
  const hasReminder = executed.some((item) => item?.entity === 'reminder');

  if (hasTask) {
    suggestions.push({ label: 'Tugas Tertunda', command: 'tugas pending saya apa', tone: 'info' });
  }
  if (hasAssignment) {
    suggestions.push({ label: 'Tugas Kuliah Tertunda', command: 'tugas kuliah pending saya apa', tone: 'info' });
  }
  if (hasReminder) {
    suggestions.push({ label: 'Setel Pengingat Lagi', command: 'ingatkan aku 30 menit lagi untuk cek progres', tone: 'success' });
  }
  suggestions.push({ label: 'Radar Mendesak', command: 'risiko deadline 48 jam ke depan', tone: 'warning' });

  const asks = Array.isArray(clarifications) ? clarifications : [];
  let shouldSuggestSubjects = false;
  const needsDeadlineHint = asks.some((item) => item?.field === 'deadline');
  for (const item of asks) {
    if (item?.field === 'deadline') {
      suggestions.push({ label: 'Isi Deadline', command: 'deadline besok 19:00', tone: 'warning' });
    } else if (item?.field === 'subject') {
      suggestions.push({ label: 'Isi Mata Kuliah', command: 'mata kuliah Kalkulus II deadline besok 19:00', tone: 'info' });
      shouldSuggestSubjects = true;
    } else if (item?.field === 'title') {
      suggestions.push({ label: 'Isi Judul', command: 'judul [isi judul tugas]', tone: 'info' });
    } else if (item?.field === 'time') {
      suggestions.push({ label: 'Isi Waktu', command: 'besok 19:00', tone: 'warning' });
    }
  }

  const subjectList = Array.isArray(scheduleSubjects) ? scheduleSubjects : [];
  const includeSubjectPresets = shouldSuggestSubjects || hasAssignment || contextAssignment;
  if (includeSubjectPresets && subjectList.length) {
    subjectList.slice(0, 3).forEach((row) => {
      const subject = normalizeActionText(row?.subject || '');
      if (!subject) return;
      const baseCommand = `buat tugas kuliah ${subject}`;
      const command = `${baseCommand} deadline besok 19:00`;
      subjectSuggestions.push({
        label: needsDeadlineHint ? `Buat ${subject} + deadline` : `Buat ${subject}`,
        command,
        tone: 'info',
      });
    });
  }

  const includeReminderPresets = hasReminder || contextReminder;
  if (includeReminderPresets && subjectList.length) {
    subjectList.slice(0, 2).forEach((row) => {
      const subject = normalizeActionText(row?.subject || '');
      if (!subject) return;
      reminderSuggestions.push({
        label: `Ingatkan ${subject}`,
        command: `ingatkan aku besok 19:00 untuk kerjakan tugas kuliah ${subject}`,
        tone: 'success',
      });
    });
  }
  if (includeReminderPresets) {
    reminderSuggestions.push({
      label: 'Ingatkan Pasangan',
      command: 'ingatkan pasangan besok 19:00 untuk cek tugas kuliah',
      tone: 'info',
    });
  }

  return normalizeChatbotSuggestions([...subjectSuggestions, ...reminderSuggestions, ...suggestions]);
}

function buildActionExecutionMemoryUpdate(memory, intent, message, execution = null, clarifications = []) {
  const extraTopics = ['target'];
  const executed = Array.isArray(execution?.executed) ? execution.executed : [];
  if (executed.some((item) => item?.entity === 'reminder')) extraTopics.push('reminder');
  if (executed.some((item) => item?.entity === 'assignment')) extraTopics.push('kuliah');
  const update = buildStatelessMemoryUpdate(memory, intent, message, extraTopics);
  const taskInc = executed.filter((item) => item?.entity === 'task').length;
  const assignmentInc = executed.filter((item) => item?.entity === 'assignment').length;
  update.pending_tasks = Math.max(0, Number(update.pending_tasks || 0) + taskInc);
  update.pending_assignments = Math.max(0, Number(update.pending_assignments || 0) + assignmentInc);
  update.unresolved_fields = normalizeRecentStrings(
    (Array.isArray(clarifications) ? clarifications : []).map((item) => String(item?.field || '').trim().toLowerCase()),
    6
  );
  return update;
}

async function flushDueRemindersForUser(userId = '', maxItems = 4) {
  if (!userId) return { reminders: [], pushed_count: 0 };
  await ensureZaiMemorySchema();
  const safeLimit = Math.max(1, Math.min(Number(maxItems) || 4, 10));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dueRes = await client.query(
      `SELECT id, user_id, target_user, reminder_text, remind_at
       FROM z_ai_reminders
       WHERE status = 'pending'
         AND remind_at <= NOW()
         AND (target_user = $1 OR (target_user IS NULL AND user_id = $1))
       ORDER BY remind_at ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [userId, safeLimit]
    );
    const reminders = dueRes.rows || [];
    if (!reminders.length) {
      await client.query('COMMIT');
      return { reminders: [], pushed_count: 0 };
    }

    let pushedCount = 0;
    const sentAt = new Date().toISOString();
    for (const item of reminders) {
      const targetUser = String(item.target_user || item.user_id || userId).trim() || userId;
      try {
        const policyRes = await evaluatePushPolicy(client, {
          userId: targetUser,
          eventType: 'zai_reminder_due',
          eventFamily: 'reminder',
          dedupKey: `reminder:${item.id}:due`,
          payload: {
            source: 'reminder',
            entity_type: 'reminder',
            entity_id: String(item.id),
            horizon_bucket: '<=24h',
          },
        });
        if (!policyRes.allowed) {
          await logPushEvent(client, targetUser, 'push_ignored', {
            event_type: 'zai_reminder_due',
            event_family: 'reminder',
            dedup_key: `reminder:${item.id}:due`,
            reason: policyRes.reason,
            entity_type: 'reminder',
            entity_id: String(item.id),
            route: '/chat',
          });
          continue;
        }

        const actionToken = createActionToken({
          user_id: targetUser,
          entity_type: 'reminder',
          entity_id: String(item.id),
          route_fallback: '/chat',
          event_family: 'reminder',
        });
        const sent = await sendNotificationToUser(targetUser, {
          title: 'Pengingat Z AI',
          body: String(item.reminder_text || 'Waktunya lanjut fokus.'),
          url: '/chat',
          data: {
            url: '/chat',
            reminder_id: item.id,
            entity_type: 'reminder',
            entity_id: String(item.id),
            event_family: 'reminder',
            dedup_key: `reminder:${item.id}:due`,
            action_token: actionToken,
          },
          tag: `zai-reminder-${item.id}`,
          actions: [
            { action: 'start', title: 'Mulai' },
            { action: 'snooze', title: 'Tunda 30m' },
            { action: 'done', title: 'Selesai' },
          ],
        });
        const didSend = Number(sent || 0) > 0;
        pushedCount += didSend ? 1 : 0;
        if (didSend) {
          await logPushEvent(client, targetUser, 'push_sent', {
            event_type: 'zai_reminder_due',
            event_family: 'reminder',
            dedup_key: `reminder:${item.id}:due`,
            entity_type: 'reminder',
            entity_id: String(item.id),
            route: '/chat',
            action_ids: ['start', 'snooze', 'done'],
          });
        }
      } catch {}
    }

    await client.query(
      `UPDATE z_ai_reminders
       SET status = 'sent',
           sent_at = NOW(),
           payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
       WHERE id = ANY($1::bigint[])`,
      [
        reminders.map((item) => Number(item.id)),
        JSON.stringify({ source: 'chat_stateless_flush', sent_at: sentAt }),
      ]
    );
    await client.query('COMMIT');
    return { reminders, pushed_count: pushedCount };
  } catch {
    await client.query('ROLLBACK');
    return { reminders: [], pushed_count: 0 };
  } finally {
    client.release();
  }
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
      } else if (item?.field === 'time') {
        chips.push({ label: 'Isi Waktu', command: 'besok 19:00', tone: 'warning' });
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_router_events (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60),
      response_id VARCHAR(80),
      status VARCHAR(20) NOT NULL DEFAULT 'ok',
      router_mode VARCHAR(20),
      selected_engine VARCHAR(40),
      engine_final VARCHAR(40),
      fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      complexity_score INTEGER,
      complexity_level VARCHAR(20),
      latency_ms INTEGER,
      intent VARCHAR(80),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS z_ai_reminders (
      id BIGSERIAL PRIMARY KEY,
      user_id VARCHAR(60) NOT NULL,
      target_user VARCHAR(60),
      reminder_text TEXT NOT NULL,
      remind_at TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      source_command TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_events_user_time ON z_ai_memory_events(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_feedback_user_time ON z_ai_feedback_events(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_user_time ON z_ai_router_events(user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_time ON z_ai_router_events(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_router_events_engine ON z_ai_router_events(engine_final, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_reminders_due ON z_ai_reminders(status, remind_at ASC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_zai_reminders_user ON z_ai_reminders(target_user, status, remind_at ASC)');
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

function normalizeUserAlias(value = '') {
  const cleaned = String(value || '')
    .replace(/[^\p{L}\p{N}_\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.slice(0, 24);
}

function extractPreferredNickname(message = '') {
  const text = String(message || '').trim();
  if (!text) return '';
  const patterns = [
    /\b(?:panggil|sebut)\s+aku\s+([a-zA-Z0-9_\-\s]{2,30})/i,
    /\b(?:nama|name)\s+(?:aku|saya|gue|gw)\s+([a-zA-Z0-9_\-\s]{2,30})/i,
    /\bmy name is\s+([a-zA-Z0-9_\-\s]{2,30})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    const alias = normalizeUserAlias(match[1]);
    if (alias.length >= 2) return alias;
  }
  return '';
}

function escapeRegex(text = '') {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvePersonalDisplayName(userId = '', memory = null) {
  const fromMemory = normalizeUserAlias(memory?.memory?.profile?.nickname || memory?.profile?.nickname || '');
  if (fromMemory) return fromMemory;
  const fallback = String(userId || '').trim();
  if (!fallback) return '';
  return `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)}`;
}

function personalizeReplyForUser(reply = '', options = {}) {
  const base = String(reply || '').trim();
  if (!base) return base;

  const userLabel = resolvePersonalDisplayName(options.user_id, options.memory);
  if (!userLabel) return base.slice(0, CHATBOT_MAX_REPLY);

  const intent = String(options.intent || '').trim().toLowerCase();
  const shouldPrefix = ['greeting', 'fallback', 'check_daily_target', 'recommend_task', 'daily_brief', 'study_schedule']
    .includes(intent) || base.length < 180;
  const hasLabel = new RegExp(`\\b${escapeRegex(userLabel)}\\b`, 'i').test(base);
  let text = base;
  if (shouldPrefix && !hasLabel) {
    text = `${userLabel}, ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  }

  const focusTopic = String(options?.memory?.focus_topic || options?.memory?.memory?.recent_topics?.[0] || '')
    .trim()
    .toLowerCase();
  if (
    focusTopic
    && ['greeting', 'fallback'].includes(intent)
    && !new RegExp(`\\b${escapeRegex(focusTopic)}\\b`, 'i').test(text)
  ) {
    text = `${text} Fokus kamu lagi di ${focusTopic}.`;
  }

  return text.slice(0, CHATBOT_MAX_REPLY);
}

function normalizeZaiMemory(raw = {}) {
  const memory = raw && typeof raw === 'object' ? raw : {};
  const counters = memory.counters && typeof memory.counters === 'object' ? memory.counters : {};
  const intentsCounter = counters.intents && typeof counters.intents === 'object' ? counters.intents : {};
  const profileRaw = memory.profile && typeof memory.profile === 'object' ? memory.profile : {};
  const profile = {
    nickname: normalizeUserAlias(profileRaw.nickname || profileRaw.display_name || '') || null,
    last_tone_mode: ['supportive', 'strict', 'balanced'].includes(String(profileRaw.last_tone_mode || '').toLowerCase())
      ? String(profileRaw.last_tone_mode || '').toLowerCase()
      : null,
    last_focus_window: ['any', 'morning', 'afternoon', 'evening'].includes(String(profileRaw.last_focus_window || '').toLowerCase())
      ? String(profileRaw.last_focus_window || '').toLowerCase()
      : null,
    updated_at: String(profileRaw.updated_at || '').slice(0, 40) || null,
  };
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
    profile,
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

function chatbotAutoToneEnabled() {
  const raw = process.env.CHATBOT_AUTO_TONE_MODE;
  if (raw == null || String(raw).trim() === '') return true;
  return parseBooleanEnv(raw);
}

function inferBehaviorAdaptiveContext(message = '', contextInput = null, memory = null, planner = null, learningHints = null) {
  const context = normalizeChatbotContext(contextInput) || {
    tone_mode: 'supportive',
    focus_minutes: 25,
    focus_window: 'any',
    recent_intents: [],
    preferred_commands: [],
    avoid_commands: [],
    helpful_ratio: 0.5,
  };
  const lower = String(message || '').toLowerCase();
  const scores = { supportive: 0, balanced: 0, strict: 0 };
  const signals = [];

  const baseTone = String(context.tone_mode || 'supportive');
  if (scores[baseTone] !== undefined) {
    scores[baseTone] += 1;
  }

  const explicitStrict = /\b(toxic|mode tegas|gaspol|no excuse|push keras)\b/.test(lower);
  const explicitSupportive = /\b(lembut|pelan|supportive|santai)\b/.test(lower);
  const explicitBalanced = /\b(balanced|seimbang)\b/.test(lower);
  if (explicitStrict) {
    scores.strict += 5;
    signals.push('explicit_strict');
  }
  if (explicitSupportive) {
    scores.supportive += 5;
    signals.push('explicit_supportive');
  }
  if (explicitBalanced) {
    scores.balanced += 5;
    signals.push('explicit_balanced');
  }

  const pendingTasks = Math.max(0, Number(memory?.pending_tasks || 0));
  const pendingAssignments = Math.max(0, Number(memory?.pending_assignments || 0));
  const pendingTotal = pendingTasks + pendingAssignments;
  const avgMood = Number(memory?.avg_mood_7d || 0);
  const unresolvedMemory = Array.isArray(memory?.memory?.unresolved) ? memory.memory.unresolved.length : 0;
  const unresolvedPlanner = Array.isArray(planner?.clarifications) ? planner.clarifications.length : 0;
  const unresolvedCount = unresolvedMemory + unresolvedPlanner;

  if (pendingTotal >= 10) {
    scores.strict += 3;
    scores.balanced += 1;
    signals.push('heavy_backlog');
  } else if (pendingTotal >= 6) {
    scores.strict += 2;
    scores.balanced += 1;
    signals.push('medium_backlog');
  } else if (pendingTotal >= 3) {
    scores.balanced += 1;
  }

  if (unresolvedCount >= 3) {
    scores.strict += 2;
    scores.balanced += 1;
    signals.push('many_missing_fields');
  } else if (unresolvedCount > 0) {
    scores.balanced += 1;
  }

  if (avgMood > 0 && avgMood <= 2.8) {
    scores.supportive += 3;
    signals.push('low_mood');
  } else if (avgMood > 0 && avgMood <= 3.5) {
    scores.supportive += 1;
  } else if (avgMood >= 4.2 && pendingTotal >= 6) {
    scores.strict += 1;
  }

  if (/\b(lelah|capek|ngantuk|burnout|drop|mager|overwhelmed)\b/.test(lower)) {
    scores.supportive += 3;
    scores.strict -= 1;
    signals.push('low_energy_language');
  }
  if (/\b(urgent|asap|deadline|telat|sekarang juga|hari ini|besok)\b/.test(lower)) {
    scores.strict += 2;
    signals.push('urgent_language');
  }

  const complexity = evaluateHybridComplexity(message, planner);
  if (complexity.complex) {
    scores.balanced += 1;
    if (complexity.score >= 70) scores.strict += 1;
  }

  const helpfulRatio = Number(
    learningHints?.helpful_ratio
    ?? context.helpful_ratio
    ?? 0.5
  );
  if (Number.isFinite(helpfulRatio)) {
    if (helpfulRatio < 0.4) {
      scores.balanced += 2;
      scores.supportive += 1;
      signals.push('low_helpful_ratio');
    } else if (helpfulRatio > 0.78 && pendingTotal >= 5) {
      scores.strict += 1;
      signals.push('high_helpful_ratio');
    }
  }

  const preferred = normalizeRecentStrings(learningHints?.preferred_commands || context.preferred_commands, 8);
  const avoid = normalizeRecentStrings(learningHints?.avoid_commands || context.avoid_commands, 8);
  const strictPattern = /(toxic|mode tegas|gaspol|no excuse|risk deadline|risiko deadline|urgent radar|radar mendesak)/i;
  const softPattern = /(check-?in|evaluasi|couple pulse|mood|break|istirahat)/i;
  if (preferred.some((cmd) => strictPattern.test(cmd))) scores.strict += 2;
  if (preferred.some((cmd) => softPattern.test(cmd))) scores.supportive += 1;
  if (avoid.some((cmd) => strictPattern.test(cmd))) {
    scores.supportive += 2;
    scores.balanced += 1;
    signals.push('avoid_strict_commands');
  }

  const ranking = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topTone = String(ranking[0]?.[0] || 'supportive');
  const topScore = Number(ranking[0]?.[1] || 0);
  const secondScore = Number(ranking[1]?.[1] || 0);

  // Prevent noisy mode switching when confidence between tones is very close.
  let toneMode = topTone;
  if (topScore - secondScore < 2) {
    toneMode = scores[baseTone] !== undefined ? baseTone : 'balanced';
  }

  let focusMinutes = Number(context.focus_minutes || 25);
  if (!Number.isFinite(focusMinutes)) focusMinutes = 25;
  if (toneMode === 'strict') {
    focusMinutes = Math.max(focusMinutes, pendingTotal >= 8 ? 35 : 30);
  } else if (toneMode === 'supportive') {
    if (avgMood > 0 && avgMood <= 2.8) focusMinutes = Math.min(focusMinutes, 20);
    if (/\b(lelah|capek|ngantuk|burnout|drop)\b/.test(lower)) focusMinutes = Math.min(focusMinutes, 20);
  }
  focusMinutes = clampNumber(focusMinutes, 10, 180);

  return {
    ...context,
    tone_mode: toneMode,
    focus_minutes: focusMinutes,
    adaptive_source: 'behavior_auto',
    adaptive_signals: signals.slice(0, 6),
  };
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
  const detectedNickname = extractPreferredNickname(interaction.message || '');
  const toneMode = String(interaction?.context?.tone_mode || '').trim().toLowerCase();
  const focusWindow = String(interaction?.context?.focus_window || '').trim().toLowerCase();
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

  const profile = safeCurrent.profile && typeof safeCurrent.profile === 'object'
    ? { ...safeCurrent.profile }
    : { nickname: null, last_tone_mode: null, last_focus_window: null, updated_at: null };
  if (detectedNickname) {
    profile.nickname = detectedNickname;
    profile.updated_at = new Date().toISOString();
  }
  if (['supportive', 'strict', 'balanced'].includes(toneMode)) {
    profile.last_tone_mode = toneMode;
  }
  if (['any', 'morning', 'afternoon', 'evening'].includes(focusWindow)) {
    profile.last_focus_window = focusWindow;
  }
  safeCurrent.profile = profile;

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

function toSafeInt(value, fallback = null, min = 0, max = 120000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

async function writeRouterMetricEvent(payload = {}) {
  try {
    await ensureZaiMemorySchema();
    const router = payload.router && typeof payload.router === 'object' ? payload.router : {};
    const engineFinal = String(payload.engine || router.engine_final || router.selected_engine || '').trim().slice(0, 40) || null;
    const selectedEngine = String(router.selected_engine || '').trim().slice(0, 40) || null;
    const routerMode = String(router.mode || '').trim().slice(0, 20) || null;
    const complexityScore = toSafeInt(router.complexity_score, null, 0, 100);
    const complexityLevel = String(router.complexity_level || '').trim().toLowerCase().slice(0, 20) || null;
    const latencyMs = toSafeInt(payload.latency_ms, null, 0, 120000);
    const fallbackUsed = Boolean(
      router.fallback_used
      || String(engineFinal || '').includes('fallback')
      || String(selectedEngine || '').includes('fallback')
    );

    const metadata = {
      reasons: Array.isArray(router.reasons) ? router.reasons.slice(0, 8).map((item) => String(item || '').slice(0, 60)) : [],
      complexity_threshold: toSafeInt(router.complexity_threshold, null, 0, 100),
      status: String(payload.status || 'ok').trim().slice(0, 20) || 'ok',
    };

    await pool.query(
      `INSERT INTO z_ai_router_events (
        user_id,
        response_id,
        status,
        router_mode,
        selected_engine,
        engine_final,
        fallback_used,
        complexity_score,
        complexity_level,
        latency_ms,
        intent,
        metadata,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, NOW())`,
      [
        String(payload.user_id || '').trim().slice(0, 60) || null,
        String(payload.response_id || '').trim().slice(0, 80) || null,
        String(payload.status || 'ok').trim().slice(0, 20) || 'ok',
        routerMode,
        selectedEngine,
        engineFinal,
        fallbackUsed,
        complexityScore,
        complexityLevel,
        latencyMs,
        String(payload.intent || '').trim().toLowerCase().slice(0, 80) || null,
        JSON.stringify(metadata),
      ]
    );
  } catch {
    // Telemetry should never break chatbot flow.
  }
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
  const topicRaw = String(memory.focus_topic || 'umum');
  const topic = topicRaw === 'general' ? 'umum' : topicRaw;
  return `Memori: tugas ${tasks}, tugas kuliah ${assignments}, mood 7 hari ${mood}, fokus ${topic}.`;
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

const DAY_ID_LABEL_ID = {
  1: 'Senin',
  2: 'Selasa',
  3: 'Rabu',
  4: 'Kamis',
  5: 'Jumat',
  6: 'Sabtu',
  7: 'Minggu',
};

function toScheduleDayId(dateObj = null) {
  if (!dateObj || Number.isNaN(new Date(dateObj).getTime())) return 1;
  const jsDay = new Date(dateObj).getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function parseScheduleDayIdByName(message = '') {
  const text = String(message || '').toLowerCase();
  if (/\b(senin|monday)\b/.test(text)) return 1;
  if (/\b(selasa|tuesday)\b/.test(text)) return 2;
  if (/\b(rabu|wednesday)\b/.test(text)) return 3;
  if (/\b(kamis|thursday)\b/.test(text)) return 4;
  if (/\b(jumat|jumat|friday)\b/.test(text)) return 5;
  if (/\b(sabtu|saturday)\b/.test(text)) return 6;
  if (/\b(minggu|ahad|sunday)\b/.test(text)) return 7;
  return null;
}

function isCollegeScheduleQuery(message = '') {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;
  if (isStudyPlanCommand(text)) return false;
  if (/(jadwal belajar|study plan|rencana belajar|sesi belajar)/i.test(text)) return false;

  const hasScheduleToken = /(jadwal|schedule|kelas|matkul|mata kuliah|perkuliahan)/i.test(text);
  if (!hasScheduleToken) return false;

  const hasAskToken = /(apa|ada|berapa|cek|lihat|show|daftar|kapan)/i.test(text);
  const hasDayToken = /(\bhari ini\b|\bbesok\b|\blusa\b|\btoday\b|\btomorrow\b|\bday after tomorrow\b|\bsenin\b|\bselasa\b|\brabu\b|\bkamis\b|\bjumat\b|\bsabtu\b|\bminggu\b|\bmonday\b|\btuesday\b|\bwednesday\b|\bthursday\b|\bfriday\b|\bsaturday\b|\bsunday\b)/i.test(text);
  const startsWithSchedule = /^\/?ai?\s*jadwal\b/i.test(text) || /^jadwal\b/i.test(text);
  const forcedCreate = /\b(buat|buatkan|susun|atur|generate|rancang)\b/i.test(text) && !hasAskToken && !hasDayToken;
  if (forcedCreate) return false;
  return hasAskToken || hasDayToken || startsWithSchedule || /\bjadwal\s+kuliah\b/i.test(text);
}

function parseCollegeScheduleRequest(message = '') {
  if (!isCollegeScheduleQuery(message)) return null;

  const dayByName = parseScheduleDayIdByName(message);
  const dateLabel = parseStudyDateLabel(message);
  if (dateLabel) {
    const parsed = parseIsoDateLabel(dateLabel);
    if (parsed) {
      return {
        day_id: toScheduleDayId(parsed),
        date: toDateLabel(parsed),
        phrase: humanizeDateLabel(dateLabel),
      };
    }
  }

  if (dayByName) {
    return {
      day_id: dayByName,
      date: null,
      phrase: `hari ${DAY_ID_LABEL_ID[dayByName] || 'itu'}`,
    };
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return {
    day_id: toScheduleDayId(now),
    date: toDateLabel(now),
    phrase: 'hari ini',
  };
}

async function fetchScheduleByDayId(dayId = 1) {
  const safeDay = Math.max(1, Math.min(7, Number(dayId) || 1));
  const res = await pool.query(
    `SELECT id, day_id, subject, room, time_start, time_end, lecturer
     FROM schedule
     WHERE day_id = $1
     ORDER BY time_start ASC`,
    [safeDay]
  );
  return Array.isArray(res.rows) ? res.rows : [];
}

function parseHmToMinutes(value = '') {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function minutesToHm(totalMinutes = 0) {
  const mins = Math.max(0, Number(totalMinutes) || 0);
  const hh = String(Math.floor(mins / 60)).padStart(2, '0');
  const mm = String(mins % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function buildBetweenClassGaps(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const gaps = [];
  for (let i = 0; i < list.length - 1; i += 1) {
    const current = list[i] || {};
    const next = list[i + 1] || {};
    const endMin = parseHmToMinutes(current.time_end);
    const nextStartMin = parseHmToMinutes(next.time_start);
    if (!Number.isFinite(endMin) || !Number.isFinite(nextStartMin)) continue;
    const diff = nextStartMin - endMin;
    if (diff <= 0) continue;
    gaps.push({
      start: minutesToHm(endMin),
      end: minutesToHm(nextStartMin),
      minutes: diff,
    });
  }
  return gaps;
}

function buildCollegeScheduleNaturalReply(request = null, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const phrase = String(request?.phrase || '').trim() || `hari ${DAY_ID_LABEL_ID[Number(request?.day_id) || 1] || 'ini'}`;

  if (!list.length) {
    if (phrase === 'hari ini' || phrase === 'besok' || phrase === 'lusa') {
      return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} kamu nggak ada jadwal kuliah. Bisa pakai slot ini buat fokus tugas prioritas atau istirahat sebentar.`;
    }
    return `Untuk ${phrase}, kamu nggak ada jadwal kuliah. Cocok buat nyicil tugas atau bikin sesi belajar ringan.`;
  }

  const lines = list.slice(0, 6).map((item, idx) => {
    const start = String(item.time_start || '--:--').slice(0, 5);
    const end = String(item.time_end || '--:--').slice(0, 5);
    const subject = String(item.subject || 'Mata kuliah').trim();
    const room = String(item.room || '').trim();
    const lecturer = String(item.lecturer || '').trim();
    const meta = [room, lecturer].filter(Boolean).join(' - ');
    return `${idx + 1}) ${start}-${end} ${subject}${meta ? ` (${meta})` : ''}`;
  });

  const gaps = buildBetweenClassGaps(list);
  const usefulGaps = gaps.filter((item) => Number(item.minutes) >= 20);
  const gapLine = usefulGaps.length
    ? `\nSlot kosong antar kelas: ${usefulGaps.slice(0, 3).map((item) => `${item.start}-${item.end} (${item.minutes} menit)`).join(', ')}.`
    : '\nSlot kosong antar kelas belum kebaca cukup panjang.';

  const first = list[0] || {};
  const firstStart = String(first.time_start || '--:--').slice(0, 5);
  const firstSubject = String(first.subject || 'mata kuliah pertama').trim();
  const extra = list.length > 6 ? `\n...dan ${list.length - 6} jadwal lainnya.` : '';
  return `Untuk ${phrase}, kamu ada ${list.length} jadwal kuliah.\n${lines.join('\n')}${extra}${gapLine}\nMulai dari ${firstStart} untuk ${firstSubject}.`;
}
function buildCollegeScheduleSuggestions(request = null, rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const phrase = String(request?.phrase || '').toLowerCase();
  const suggestions = [];

  if (phrase !== 'hari ini') {
    suggestions.push({ label: 'Jadwal Hari Ini', command: 'hari ini ada jadwal kuliah apa', tone: 'info' });
  }
  if (phrase !== 'besok') {
    suggestions.push({ label: 'Jadwal Besok', command: 'besok ada jadwal kuliah apa', tone: 'info' });
  }
  if (list.length) {
    suggestions.push({ label: 'Rencana Belajar', command: 'jadwal belajar besok pagi 120 menit', tone: 'success' });
    suggestions.push({ label: 'Tugas Mendesak', command: 'rekomendasi tugas kuliah paling mendesak', tone: 'warning' });
  } else {
    suggestions.push({ label: 'Isi Fokus Hari Ini', command: 'rekomendasi tugas kuliah', tone: 'success' });
    suggestions.push({ label: 'Buat Jadwal Belajar', command: 'jadwal belajar besok pagi 120 menit', tone: 'info' });
  }

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

function shouldRunDecisionEngine(message = '', planner = null) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return false;

  if (isStudyPlanCommand(text)) return false;
  if (/(?:buat|buatkan|tambah|add|create|catat|simpan)\s+(?:task|tugas|todo|to-do|assignment|tugas kuliah)\b/i.test(text)) return false;
  if (/(?:ingatkan|ingetin|reminder|alarm|notifikasi|jangan lupa)\b/i.test(text)) return false;

  const explicit = /(\brekomendasi\b|\bprioritas\b|\btask apa dulu\b|\btugas apa dulu\b|\blangkah berikutnya\b|\bnext step\b|\bfokus apa dulu\b|\bmulai dari mana\b|\bstuck\b|\bbingung\b|\boverwhelmed\b|\bmenunda\b|\bprokrastinasi\b|\bcek target\b|\btarget harian\b|\bapa yang harus dikerjain\b)/i.test(text);
  if (explicit) return true;

  const actions = Array.isArray(planner?.actions) ? planner.actions : [];
  return actions.some((item) => {
    const kind = String(item?.kind || '').trim().toLowerCase();
    return kind === 'recommendation' || kind === 'daily_target';
  });
}

function estimateDecisionEnergy(message = '', context = null, memory = null) {
  const text = String(message || '').toLowerCase();
  if (/\b(lelah|capek|ngantuk|burnout|drop|mager|overwhelmed)\b/.test(text)) return 'low';
  if (/\b(semangat|fokus|gas|mantap|siap)\b/.test(text)) return 'high';
  const mood = Number(memory?.avg_mood_7d || 0);
  if (mood > 0 && mood <= 2.8) return 'low';
  if (mood >= 4.2) return 'high';
  const style = String(context?.tone_mode || '').toLowerCase();
  if (style === 'strict') return 'high';
  return 'normal';
}

function toHoursLeft(iso = '') {
  const value = new Date(iso).getTime();
  if (!Number.isFinite(value)) return null;
  return (value - Date.now()) / 3600000;
}

function deadlinePriorityScore(hoursLeft = null) {
  if (!Number.isFinite(hoursLeft)) return 8;
  if (hoursLeft <= 0) return 52;
  if (hoursLeft <= 6) return 47;
  if (hoursLeft <= 12) return 42;
  if (hoursLeft <= 24) return 36;
  if (hoursLeft <= 48) return 28;
  if (hoursLeft <= 72) return 22;
  if (hoursLeft <= 168) return 14;
  return 8;
}

function formatRelativeDeadline(hoursLeft = null) {
  if (!Number.isFinite(hoursLeft)) return 'tanpa deadline spesifik';
  if (hoursLeft <= 0) return 'sudah melewati deadline';
  if (hoursLeft < 1) return 'kurang dari 1 jam lagi';
  if (hoursLeft <= 24) return `${Math.max(1, Math.round(hoursLeft))} jam lagi`;
  const days = Math.max(1, Math.round(hoursLeft / 24));
  return `${days} hari lagi`;
}

function shortDecisionTitle(value = '') {
  const text = String(value || '').trim();
  if (!text) return 'item prioritas';
  return text.length > 72 ? `${text.slice(0, 72).trim()}...` : text;
}

function normalizeDecisionPriority(priority = '') {
  const lower = String(priority || '').trim().toLowerCase();
  if (lower === 'high' || lower === 'tinggi') return 'high';
  if (lower === 'low' || lower === 'rendah') return 'low';
  return 'medium';
}

function scoreDecisionCandidate(candidate = {}, input = {}) {
  const energy = String(input.energy || 'normal');
  const pendingTotal = Math.max(0, Number(input.pending_total || 0));
  const entity = String(candidate.entity || 'task');
  const priority = normalizeDecisionPriority(candidate.priority);
  const hoursLeft = toHoursLeft(candidate.deadline);

  const deadlineScore = deadlinePriorityScore(hoursLeft);
  const academicImpactScore = entity === 'assignment'
    ? 20
    : (candidate.goal_id ? 16 : 12);
  const priorityScore = priority === 'high' ? 14 : (priority === 'medium' ? 8 : 4);
  const backlogPressureScore = pendingTotal >= 12 ? 8 : (pendingTotal >= 7 ? 6 : (pendingTotal >= 4 ? 4 : 2));

  let energyFitScore = 4;
  if (energy === 'low') {
    if (Number.isFinite(hoursLeft) && hoursLeft <= 24) energyFitScore = 8;
    else if (entity === 'task') energyFitScore = 6;
    else energyFitScore = 3;
  } else if (energy === 'high') {
    energyFitScore = entity === 'assignment' ? 6 : 5;
  } else {
    energyFitScore = entity === 'assignment' ? 5 : 4;
  }

  const totalScore = deadlineScore + academicImpactScore + priorityScore + backlogPressureScore + energyFitScore;
  return {
    ...candidate,
    hours_left: Number.isFinite(hoursLeft) ? Number(hoursLeft.toFixed(2)) : null,
    score_breakdown: {
      deadline: deadlineScore,
      academic_impact: academicImpactScore,
      priority: priorityScore,
      backlog_pressure: backlogPressureScore,
      energy_fit: energyFitScore,
    },
    total_score: totalScore,
  };
}

async function fetchDecisionCandidatesForUser(userId = '', limit = 20) {
  const safeLimit = Math.max(4, Math.min(Number(limit) || 20, 30));
  const [tasksRes, assignmentsRes] = await Promise.all([
    pool.query(
      `SELECT id, title, deadline, priority, goal_id
       FROM tasks
       WHERE is_deleted = FALSE
         AND completed = FALSE
         AND (assigned_to = $1 OR created_by = $1)
       ORDER BY deadline ASC NULLS LAST, id DESC
       LIMIT $2`,
      [userId, safeLimit]
    ),
    pool.query(
      `SELECT id, title, deadline
       FROM assignments
       WHERE completed = FALSE
         AND (assigned_to = $1 OR assigned_to IS NULL)
       ORDER BY deadline ASC NULLS LAST, id DESC
       LIMIT $2`,
      [userId, safeLimit]
    ),
  ]);

  const tasks = (tasksRes.rows || []).map((row) => ({
    entity: 'task',
    id: Number(row.id || 0) || null,
    title: String(row.title || '').trim(),
    deadline: row.deadline || null,
    priority: String(row.priority || 'medium').toLowerCase(),
    goal_id: row.goal_id ? Number(row.goal_id) : null,
  }));
  const assignments = (assignmentsRes.rows || []).map((row) => ({
    entity: 'assignment',
    id: Number(row.id || 0) || null,
    title: String(row.title || '').trim(),
    deadline: row.deadline || null,
    priority: 'medium',
    goal_id: null,
  }));
  return { tasks, assignments };
}

function buildDecisionActionLabel(candidate = {}) {
  const kind = candidate.entity === 'assignment' ? 'tugas kuliah' : 'tugas';
  return `Kerjakan ${kind} "${shortDecisionTitle(candidate.title)}"`;
}

function buildDecisionEngineV2Payload(message = '', context = null, memory = null, data = null) {
  const tasks = Array.isArray(data?.tasks) ? data.tasks : [];
  const assignments = Array.isArray(data?.assignments) ? data.assignments : [];
  const candidatesRaw = [...tasks, ...assignments];
  const pendingTotal = Number(
    (Number(memory?.pending_tasks || 0) + Number(memory?.pending_assignments || 0))
    || candidatesRaw.length
  );
  const energy = estimateDecisionEnergy(message, context, memory);
  const focusMinutes = clampNumber(context?.focus_minutes || 25, 10, 180);

  const scored = candidatesRaw
    .map((item) => scoreDecisionCandidate(item, { energy, pending_total: pendingTotal }))
    .sort((a, b) => {
      const scoreDiff = Number(b.total_score || 0) - Number(a.total_score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const aHours = Number.isFinite(a.hours_left) ? Number(a.hours_left) : Number.POSITIVE_INFINITY;
      const bHours = Number.isFinite(b.hours_left) ? Number(b.hours_left) : Number.POSITIVE_INFINITY;
      if (aHours !== bHours) return aHours - bHours;
      return String(a.title || '').localeCompare(String(b.title || ''));
    });

  const top = scored[0] || null;
  if (!top) {
    return {
      primary_action: {
        label: `Mulai sesi fokus ${focusMinutes} menit untuk backlog kuliah`,
        entity: 'focus_session',
        id: null,
        title: 'Sesi fokus backlog',
        hours_left: null,
        score: 0,
      },
      reason: 'Belum ada item pending yang terbaca, jadi aksi terbaik adalah menjaga ritme eksekusi harian dulu.',
      next_step: `Mulai timer ${focusMinutes} menit, pilih 1 target kecil, lalu kirim update progres.`,
      confidence: 'low',
      energy,
      pending_total: 0,
      due_24h: 0,
      scored_candidates: [],
    };
  }

  const due24h = scored.filter((item) => Number.isFinite(item.hours_left) && item.hours_left <= 24).length;
  const reason = `Dipilih karena ${formatRelativeDeadline(top.hours_left)}, skor prioritas ${top.total_score}, dan cocok untuk energi ${energy}.`;
  const nextFocus = energy === 'low' ? Math.min(20, focusMinutes) : focusMinutes;
  const nextStep = `Mulai sekarang ${nextFocus} menit pada "${shortDecisionTitle(top.title)}", lalu update progres 1 kalimat.`;

  let confidence = 'high';
  if (!Number.isFinite(top.hours_left)) confidence = 'medium';
  if (scored.length < 2) confidence = 'medium';

  return {
    primary_action: {
      label: buildDecisionActionLabel(top),
      entity: top.entity,
      id: top.id,
      title: top.title,
      hours_left: top.hours_left,
      score: top.total_score,
      deadline: top.deadline || null,
    },
    reason,
    next_step: nextStep,
    confidence,
    energy,
    pending_total: pendingTotal,
    due_24h: due24h,
    scored_candidates: scored.slice(0, 5),
  };
}

function buildDecisionEngineReply(decision = null, context = null) {
  if (!decision || typeof decision !== 'object') {
    return 'Aksi utama sekarang: mulai 1 sesi fokus 25 menit, lalu kirim update progres.';
  }
  const tone = String(context?.tone_mode || 'supportive').toLowerCase();
  const action = String(decision?.primary_action?.label || 'Mulai 1 prioritas utama').trim();
  const reason = String(decision?.reason || '').trim();
  const next = String(decision?.next_step || '').trim();

  if (tone === 'strict') {
    return `Aksi utama: ${action}. Alasan: ${reason}. Langkah berikutnya: ${next}`.slice(0, CHATBOT_MAX_REPLY);
  }
  if (tone === 'balanced') {
    return `Fokus utama kamu: ${action}. Kenapa: ${reason} Langkah berikutnya: ${next}`.slice(0, CHATBOT_MAX_REPLY);
  }
  return `Biar ringan tapi tetap maju, fokus utama sekarang: ${action}. Kenapa: ${reason}. Langkah berikutnya: ${next}`.slice(0, CHATBOT_MAX_REPLY);
}

function buildDecisionEngineSuggestions(decision = null, context = null) {
  const focusMinutes = clampNumber(context?.focus_minutes || 25, 10, 180);
  const title = shortDecisionTitle(decision?.primary_action?.title || 'prioritas utama');
  const actionEntity = String(decision?.primary_action?.entity || '').toLowerCase();
  const actionId = Number(decision?.primary_action?.id || 0) || null;
  const suggestions = [
    { label: `Mulai ${focusMinutes}m`, command: `mulai fokus ${focusMinutes} menit untuk ${title}`, tone: 'success' },
    { label: 'Pengingat Lanjutan', command: `ingatkan aku ${focusMinutes} menit lagi untuk update progres ${title}`, tone: 'warning' },
    { label: 'Evaluasi Cepat', command: 'evaluasi singkat progres hari ini', tone: 'info' },
    { label: 'Prioritas Berikutnya', command: 'rekomendasi tugas berikutnya', tone: 'info' },
  ];
  if (actionEntity === 'task' && actionId) {
    suggestions[3] = { label: `Selesai Tugas #${actionId}`, command: `selesaikan tugas ${actionId}`, tone: 'success' };
  } else if (actionEntity === 'assignment' && actionId) {
    suggestions[3] = { label: `Selesai Tugas Kuliah #${actionId}`, command: `selesaikan tugas kuliah ${actionId}`, tone: 'success' };
  }
  return normalizeChatbotSuggestions(suggestions);
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
      reply: 'Target harian kalian: tuntaskan 1 tugas paling mendesak, 1 sesi fokus 30-45 menit, lalu check-in malam.',
      intent: 'check_daily_target',
      suggestions: normalizeChatbotSuggestions([
        { label: 'Check-in', command: 'check-in progres hari ini', tone: 'info' },
        { label: 'Pengingat 25m', command: 'ingatkan aku fokus 25 menit', tone: 'warning' },
      ]),
    };
  }
  if (/\b(reminder|ingatkan|ingetin|jangan lupa|alarm|notifikasi)\b/.test(lower)) {
    return {
      reply: 'Siap, pengingat tercatat. Mulai langkah kecil dulu sekarang, lalu update progres.',
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
        { label: 'Check-in', command: 'check-in progres tugas', tone: 'info' },
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
        { label: 'Check-in', command: 'check-in progres hari ini', tone: 'info' },
        { label: 'Rencana Besok', command: 'cek target harian besok', tone: 'success' },
      ]),
    };
  }
  if (/\b(check-?in|progress|progres|update)\b/.test(lower)) {
    return {
      reply: 'Check-in singkat dulu: 1) selesai apa, 2) lagi ngerjain apa, 3) hambatan terbesar sekarang.',
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
        { label: 'Check-in', command: 'check-in progres hari ini', tone: 'info' },
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
    reply: "Aku siap bantu produktivitas kalian. Coba: 'cek target harian', 'rekomendasi tugas', atau 'check-in progres'.",
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
  const advancedReasoning = /(\bkenapa\b|\bjelaskan\b|\bbandingkan\b|\bstrategi\b|\banalisis\b|\bkomparasi\b|\btrade-?off\b|\broot cause\b)/i.test(lower);
  if (advancedReasoning) {
    score += 12;
    reasons.push('reasoning_request');
  }
  if (advancedReasoning && /(\bbandingkan\b|\banalisis\b|\bstrategi\b)/i.test(lower)) {
    score += 14;
    reasons.push('deep_reasoning');
  }
  if (/(\bini\b|\bitu\b|\baja\b|\bnanti\b|\bseperti biasa\b|\byang tadi\b)/i.test(lower)) {
    score += 22;
    reasons.push('ambiguous_reference');
  }
  if (/(\bminggu ini\b|\bpekan ini\b|\b48 jam\b|\b72 jam\b|\bbulan ini\b|\bhari kerja\b)/i.test(lower)) {
    score += 10;
    reasons.push('time_horizon');
  }
  if (/(\bplan\b|\blangkah\b|\brencana\b|\broadmap\b)/i.test(lower)) {
    score += 8;
    reasons.push('planning_request');
  }
  const domainHits = ['task', 'tugas', 'assignment', 'deadline', 'pasangan', 'couple', 'belajar', 'mood']
    .filter((token) => lower.includes(token))
    .length;
  if (domainHits >= 3) {
    score += 14;
    reasons.push('multi_domain_context');
  } else if (domainHits === 2) {
    score += 8;
    reasons.push('cross_domain_context');
  }
  const connectors = (lower.match(/\b(dan|lalu|kemudian|terus|sekalian|plus)\b/g) || []).length;
  if (connectors >= 2) {
    score += 8;
    reasons.push('many_connectors');
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
  let fallbackUsed = false;

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
      fallbackUsed = true;
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
        fallbackUsed = true;
        selectedEngine = 'python';
        payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
      }
    } else {
      selectedEngine = 'python';
      payload = await askPythonChatbot(req, message, contextHint, plannerHint, memoryHint);
    }
  }

  if (!payload) {
    fallbackUsed = true;
    selectedEngine = 'rule-fallback';
    payload = fallbackChatbotPayload(message, plannerHint, memoryHint);
  }

  const engineFinal = String(payload.engine || selectedEngine);
  if (engineFinal.includes('fallback') && selectedEngine !== 'rule') {
    fallbackUsed = true;
  }

  return {
    ...payload,
    engine: engineFinal,
    router: {
      mode,
      selected_engine: selectedEngine,
      engine_final: engineFinal,
      fallback_used: fallbackUsed,
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
        res.status(401).json({ error: 'Perlu login untuk menyimpan feedback' });
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
      res.status(400).json({ error: 'Pesan wajib diisi' });
      return;
    }

    if (statelessMode) {
      const routeStartedAt = Date.now();
      const optionalUser = extractOptionalUser(req);
      const planner = buildPlannerFrame(message);
      const [memory, semanticMemory, dueReminderState] = optionalUser
        ? await Promise.all([
            getZaiMemoryBundle(optionalUser).catch(() => null),
            retrieveSemanticMemoryHints(optionalUser, message, SEMANTIC_MEMORY_MAX_ITEMS).catch(() => []),
            flushDueRemindersForUser(optionalUser, 4).catch(() => ({ reminders: [], pushed_count: 0 })),
          ])
        : [null, [], { reminders: [], pushed_count: 0 }];
      const learningHints = buildLearningHints(memory);
      const normalizedContext = normalizeChatbotContext(b.context) || {};
      const mergedSemanticMemory = normalizeSemanticMemoryItems(
        [
          ...(Array.isArray(semanticMemory) ? semanticMemory : []),
          ...(Array.isArray(normalizedContext.semantic_memory) ? normalizedContext.semantic_memory : []),
        ],
        SEMANTIC_MEMORY_MAX_ITEMS
      );
      const adaptiveContext = chatbotAutoToneEnabled()
        ? inferBehaviorAdaptiveContext(message, normalizedContext, memory, planner, learningHints)
        : normalizedContext;
      const contextWithMemory = {
        ...adaptiveContext,
        memory_topics: Array.isArray(memory?.memory?.recent_topics) ? memory.memory.recent_topics.slice(0, 5) : [],
        unresolved_fields: Array.isArray(memory?.memory?.unresolved)
          ? memory.memory.unresolved.map((item) => String(item?.field || '')).filter(Boolean).slice(0, 6)
          : [],
        preferred_commands: learningHints.preferred_commands,
        avoid_commands: learningHints.avoid_commands,
        helpful_ratio: learningHints.helpful_ratio,
        semantic_memory: mergedSemanticMemory,
      };
      const dueReminderTail = buildDueReminderFollowup(dueReminderState.reminders);

      const scheduleQuery = parseCollegeScheduleRequest(message);
      if (scheduleQuery) {
        const complexity = evaluateHybridComplexity(message, planner);
        const responseId = randomUUID();
        const intent = 'schedule_query';
        let scheduleItems = [];
        try {
          scheduleItems = await fetchScheduleByDayId(scheduleQuery.day_id);
        } catch {
          scheduleItems = [];
        }

        const phrase = String(scheduleQuery.phrase || 'hari ini');
        const plannerOut = {
          ...planner,
          mode: 'single',
          confidence: 'high',
          requires_clarification: false,
          clarifications: [],
          summary: `1. Cek jadwal kuliah ${phrase}`,
          next_best_action: scheduleItems.length
            ? 'Siapkan fokus sebelum kelas pertama.'
            : 'Pakai slot kosong untuk tugas prioritas.',
          actions: [
            {
              id: 'schedule_1',
              kind: 'schedule_query',
              summary: `Cek jadwal kuliah ${phrase}`,
              status: 'ready',
              command: message,
              missing: [],
            },
          ],
        };

        const reliability = buildReliabilityAssessment(message, plannerOut, intent);
        const rawReply = buildCollegeScheduleNaturalReply(scheduleQuery, scheduleItems).slice(0, CHATBOT_MAX_REPLY);
        const replyWithReminder = [rawReply, dueReminderTail].filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY);
        const reliableReply = applyReliabilityFollowup(replyWithReminder, reliability).slice(0, CHATBOT_MAX_REPLY);
        const reply = optionalUser
          ? personalizeReplyForUser(reliableReply, { user_id: optionalUser, memory, intent }).slice(0, CHATBOT_MAX_REPLY)
          : reliableReply;
        const suggestions = applyLearningToSuggestions(
          buildCollegeScheduleSuggestions(scheduleQuery, scheduleItems),
          learningHints
        );
        const memoryUpdate = buildStatelessMemoryUpdate(memory, intent, message, ['kuliah', 'schedule']);
        const router = {
          mode: 'native',
          selected_engine: 'schedule-native',
          engine_final: 'schedule-native',
          fallback_used: false,
          complexity_score: complexity.score,
          complexity_level: complexity.level,
          complexity_threshold: complexity.threshold,
          reasons: complexity.reasons,
        };

        if (optionalUser) {
          const topics = normalizeRecentStrings([...extractMessageTopics(message), 'kuliah', 'schedule'], 5);
          writeZaiMemoryBundle(optionalUser, {
            message,
            intent,
            reply,
            planner: plannerOut,
            context: {
              ...contextWithMemory,
              response_id: responseId,
              schedule_day_id: scheduleQuery.day_id,
              schedule_date: scheduleQuery.date,
            },
            topics,
          }).catch(() => {});
        }

        writeRouterMetricEvent({
          user_id: optionalUser || null,
          response_id: responseId,
          status: 'ok',
          engine: 'schedule-native',
          intent,
          latency_ms: Date.now() - routeStartedAt,
          router,
        }).catch(() => {});

        sendJson(res, 200, {
          reply,
          intent,
          response_id: responseId,
          engine: 'schedule-native',
          router,
          adaptive: {
            style: String(contextWithMemory?.tone_mode || 'supportive'),
            focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
            urgency: scheduleItems.length > 0 ? 'medium' : 'low',
            energy: 'normal',
            domain: 'kuliah',
          },
          planner: plannerOut,
          reliability,
          unified_memory: optionalUser ? memory : null,
          memory_update: memoryUpdate,
          feedback_profile: normalizeFeedbackProfile(memory?.memory?.feedback_profile || {}),
          suggestions: normalizeChatbotSuggestions(suggestions),
          schedule: {
            day_id: scheduleQuery.day_id,
            date: scheduleQuery.date || null,
            phrase,
            items: scheduleItems,
          },
          due_reminders: Array.isArray(dueReminderState.reminders) ? dueReminderState.reminders : [],
        });
        return;
      }

      const actionPlan = buildActionEnginePlan(planner, optionalUser);
      if (chatbotActionEngineEnabled() && actionPlan.has_actions) {
        const complexity = evaluateHybridComplexity(message, planner);
        const responseId = randomUUID();
        const draftKinds = (actionPlan.drafts || []).map((item) => String(item?.kind || '').toLowerCase());
        const reminderOnly = draftKinds.length > 0 && draftKinds.every((item) => item === 'set_reminder');
        const intent = reminderOnly ? 'reminder_ack' : 'recommend_task';

        if (!optionalUser) {
          const plannerOut = buildActionPlannerResult(planner, actionPlan, { executed: [], failed: [] });
          const reliability = buildReliabilityAssessment(message, plannerOut, intent);
          const router = {
            mode: 'native',
            selected_engine: 'action-engine-v2',
            engine_final: 'action-engine-v2',
            fallback_used: false,
            complexity_score: complexity.score,
            complexity_level: complexity.level,
            complexity_threshold: complexity.threshold,
            reasons: complexity.reasons,
          };
          writeRouterMetricEvent({
            user_id: null,
            response_id: responseId,
            status: 'ok',
            engine: 'action-engine-v2',
            intent,
            latency_ms: Date.now() - routeStartedAt,
            router,
          }).catch(() => {});
          sendJson(res, 200, {
            reply: reminderOnly
              ? 'Aku bisa set reminder otomatis, tapi kamu perlu login dulu supaya pengingatnya bisa kusimpan dan dikirim.'
              : 'Aku bisa eksekusi tugas/tugas kuliah/reminder otomatis, tapi kamu perlu login dulu supaya datanya bisa kusimpan.',
            intent,
            response_id: responseId,
            engine: 'action-engine-v2',
            router,
            adaptive: {
              style: String(contextWithMemory?.tone_mode || 'supportive'),
              focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
              urgency: 'medium',
              energy: 'normal',
              domain: reminderOnly ? 'umum' : 'kuliah',
            },
            planner: plannerOut,
            reliability,
            unified_memory: null,
            memory_update: null,
            suggestions: normalizeChatbotSuggestions([
              { label: 'Login Dulu', command: 'login', tone: 'warning' },
              reminderOnly
                ? { label: 'Template Pengingat', command: 'ingatkan aku besok 19:00 untuk cek deadline kuliah', tone: 'info' }
                : { label: 'Template Tugas Kuliah', command: 'buat tugas kuliah [judul] deadline [besok 19:00]', tone: 'info' },
            ]),
            execution: {
              executed: [],
              failed: [],
            },
          });
          return;
        }

        const execution = await executeActionEngineWrites(optionalUser, actionPlan);
        const plannerOut = buildActionPlannerResult(planner, actionPlan, execution);
        const clarifications = Array.isArray(plannerOut.clarifications) ? plannerOut.clarifications : [];
        const hasAssignmentDraft = Array.isArray(actionPlan?.drafts)
          ? actionPlan.drafts.some((item) => String(item?.kind || '').toLowerCase() === 'create_assignment')
          : false;
        const hasReminderDraft = Array.isArray(actionPlan?.drafts)
          ? actionPlan.drafts.some((item) => String(item?.kind || '').toLowerCase() === 'set_reminder')
          : false;
        const needsSubjectRecommendation = clarifications.some((item) => String(item?.field || '').toLowerCase() === 'subject');
        const subjectRecommendations = (needsSubjectRecommendation || hasAssignmentDraft || hasReminderDraft)
          ? await fetchScheduleSubjects(pool).catch(() => [])
          : [];
        const reliability = buildReliabilityAssessment(message, plannerOut, intent);
        const rawReply = buildActionExecutionReply(execution, clarifications, {
          style: String(contextWithMemory?.tone_mode || 'supportive'),
          focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
        });
        const replyWithReminder = [rawReply, dueReminderTail].filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY);
        const reliableReply = applyReliabilityFollowup(replyWithReminder, reliability).slice(0, CHATBOT_MAX_REPLY);
        const reply = personalizeReplyForUser(reliableReply, {
          user_id: optionalUser,
          memory,
          intent,
        }).slice(0, CHATBOT_MAX_REPLY);
        const suggestions = applyLearningToSuggestions(
          buildActionExecutionSuggestions(execution, clarifications, subjectRecommendations, {
            assignment_context: hasAssignmentDraft,
            reminder_context: hasReminderDraft,
          }),
          learningHints
        );
        const memoryUpdate = buildActionExecutionMemoryUpdate(memory, intent, message, execution, clarifications);
        const router = {
          mode: 'native',
          selected_engine: 'action-engine-v2',
          engine_final: 'action-engine-v2',
          fallback_used: false,
          complexity_score: complexity.score,
          complexity_level: complexity.level,
          complexity_threshold: complexity.threshold,
          reasons: complexity.reasons,
        };
        const actionTopics = ['target'];
        if (reminderOnly) actionTopics.push('reminder');
        else actionTopics.push('kuliah');
        const topics = normalizeRecentStrings([...extractMessageTopics(message), ...actionTopics], 5);

        writeZaiMemoryBundle(optionalUser, {
          message,
          intent,
          reply,
          planner: plannerOut,
          context: {
            ...contextWithMemory,
            response_id: responseId,
            execution: {
              executed_count: Number(execution?.executed?.length || 0),
              failed_count: Number(execution?.failed?.length || 0),
            },
          },
          topics,
        }).catch(() => {});
        writeRouterMetricEvent({
          user_id: optionalUser,
          response_id: responseId,
          status: 'ok',
          engine: 'action-engine-v2',
          intent,
          latency_ms: Date.now() - routeStartedAt,
          router,
        }).catch(() => {});

        sendJson(res, 200, {
          reply,
          intent,
          response_id: responseId,
          engine: 'action-engine-v2',
          router,
          adaptive: {
            style: String(contextWithMemory?.tone_mode || 'supportive'),
            focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
            urgency: reminderOnly ? 'medium' : 'high',
            energy: 'normal',
            domain: reminderOnly ? 'umum' : 'kuliah',
          },
          planner: plannerOut,
          reliability,
          unified_memory: memory,
          memory_update: memoryUpdate,
          feedback_profile: normalizeFeedbackProfile(memory?.memory?.feedback_profile || {}),
          suggestions: normalizeChatbotSuggestions(suggestions),
          execution: {
            executed: Array.isArray(execution?.executed) ? execution.executed : [],
            failed: Array.isArray(execution?.failed) ? execution.failed : [],
          },
          due_reminders: Array.isArray(dueReminderState.reminders) ? dueReminderState.reminders : [],
        });
        return;
      }

      if (chatbotDecisionEngineEnabled() && shouldRunDecisionEngine(message, planner)) {
        const complexity = evaluateHybridComplexity(message, planner);
        const responseId = randomUUID();
        const intent = 'recommend_task';

        if (!optionalUser) {
          const decision = buildDecisionEngineV2Payload(message, contextWithMemory, memory, { tasks: [], assignments: [] });
          const decisionReply = `${buildDecisionEngineReply(decision, contextWithMemory)} Login dulu biar Z AI bisa baca data tugasmu dan kasih prioritas personal.`;
          const plannerOut = {
            ...planner,
            mode: 'single',
            confidence: 'low',
            requires_clarification: false,
            clarifications: [],
            summary: `1. ${decision.primary_action.label}`,
            next_best_action: decision.next_step,
            actions: [
              {
                id: 'decision_1',
                kind: 'recommendation',
                summary: decision.primary_action.label,
                status: 'ready',
                command: decision.next_step,
                missing: [],
              },
            ],
          };
          const reliability = buildReliabilityAssessment(message, plannerOut, intent);
          const router = {
            mode: 'native',
            selected_engine: 'decision-engine-v2',
            engine_final: 'decision-engine-v2',
            fallback_used: false,
            complexity_score: complexity.score,
            complexity_level: complexity.level,
            complexity_threshold: complexity.threshold,
            reasons: complexity.reasons,
          };
          writeRouterMetricEvent({
            user_id: null,
            response_id: responseId,
            status: 'ok',
            engine: 'decision-engine-v2',
            intent,
            latency_ms: Date.now() - routeStartedAt,
            router,
          }).catch(() => {});

          sendJson(res, 200, {
            reply: decisionReply.slice(0, CHATBOT_MAX_REPLY),
            intent,
            response_id: responseId,
            engine: 'decision-engine-v2',
            router,
            adaptive: {
              style: String(contextWithMemory?.tone_mode || 'supportive'),
              focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
              urgency: 'medium',
              energy: String(decision.energy || 'normal'),
              domain: 'kuliah',
            },
            planner: plannerOut,
            reliability,
            unified_memory: null,
            memory_update: null,
            decision,
            suggestions: normalizeChatbotSuggestions([
              { label: 'Login Dulu', command: 'login', tone: 'warning' },
              { label: 'Template Prioritas', command: 'rekomendasi tugas kuliah paling mendesak', tone: 'info' },
              { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
            ]),
            due_reminders: [],
          });
          return;
        }

        const candidates = await fetchDecisionCandidatesForUser(optionalUser, 20).catch(() => ({ tasks: [], assignments: [] }));
        const decision = buildDecisionEngineV2Payload(message, contextWithMemory, memory, candidates);
        const plannerOut = {
          ...planner,
          mode: 'single',
          confidence: String(decision.confidence || 'medium'),
          requires_clarification: false,
          clarifications: [],
          summary: `1. ${decision.primary_action.label}`,
          next_best_action: decision.next_step,
          actions: [
            {
              id: 'decision_1',
              kind: 'recommendation',
              summary: decision.primary_action.label,
              status: 'ready',
              command: decision.next_step,
              missing: [],
            },
          ],
        };

        const reliability = buildReliabilityAssessment(message, plannerOut, intent);
        const rawReply = buildDecisionEngineReply(decision, contextWithMemory);
        const replyWithReminder = [rawReply, dueReminderTail].filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY);
        const reliableReply = applyReliabilityFollowup(replyWithReminder, reliability).slice(0, CHATBOT_MAX_REPLY);
        const reply = personalizeReplyForUser(reliableReply, {
          user_id: optionalUser,
          memory,
          intent,
        }).slice(0, CHATBOT_MAX_REPLY);
        const suggestions = applyLearningToSuggestions(
          buildDecisionEngineSuggestions(decision, contextWithMemory),
          learningHints
        );
        const memoryUpdate = buildStatelessMemoryUpdate(memory, intent, message, ['target', 'kuliah']);
        const router = {
          mode: 'native',
          selected_engine: 'decision-engine-v2',
          engine_final: 'decision-engine-v2',
          fallback_used: false,
          complexity_score: complexity.score,
          complexity_level: complexity.level,
          complexity_threshold: complexity.threshold,
          reasons: complexity.reasons,
        };

        const topics = normalizeRecentStrings([
          ...extractMessageTopics(message),
          'target',
          String(decision?.primary_action?.entity || ''),
        ], 5);

        writeZaiMemoryBundle(optionalUser, {
          message,
          intent,
          reply,
          planner: plannerOut,
          context: {
            ...contextWithMemory,
            response_id: responseId,
            decision: {
              label: String(decision?.primary_action?.label || ''),
              confidence: String(decision?.confidence || 'medium'),
              score: Number(decision?.primary_action?.score || 0),
            },
          },
          topics,
        }).catch(() => {});
        writeRouterMetricEvent({
          user_id: optionalUser || null,
          response_id: responseId,
          status: 'ok',
          engine: 'decision-engine-v2',
          intent,
          latency_ms: Date.now() - routeStartedAt,
          router,
        }).catch(() => {});

        sendJson(res, 200, {
          reply,
          intent,
          response_id: responseId,
          engine: 'decision-engine-v2',
          router,
          adaptive: {
            style: String(contextWithMemory?.tone_mode || 'supportive'),
            focus_minutes: Number(contextWithMemory?.focus_minutes || 25),
            urgency: Number(decision?.due_24h || 0) > 0 ? 'high' : 'medium',
            energy: String(decision.energy || 'normal'),
            domain: 'kuliah',
          },
          planner: plannerOut,
          reliability,
          unified_memory: memory,
          memory_update: memoryUpdate,
          feedback_profile: normalizeFeedbackProfile(memory?.memory?.feedback_profile || {}),
          decision,
          suggestions: normalizeChatbotSuggestions(suggestions),
          due_reminders: Array.isArray(dueReminderState.reminders) ? dueReminderState.reminders : [],
        });
        return;
      }

      const studyPlanRequest = parseStudyPlanRequest(message);
      if (studyPlanRequest) {
        if (!optionalUser) {
          const reliability = buildReliabilityAssessment(message, planner, 'study_schedule');
          const responseId = randomUUID();
          const complexity = evaluateHybridComplexity(message, planner);
          const router = {
            mode: 'native',
            selected_engine: 'study-plan-native',
            engine_final: 'study-plan-native',
            fallback_used: false,
            complexity_score: complexity.score,
            complexity_level: complexity.level,
            complexity_threshold: complexity.threshold,
            reasons: complexity.reasons,
          };
          writeRouterMetricEvent({
            user_id: optionalUser || null,
            response_id: responseId,
            status: 'ok',
            engine: 'study-plan-native',
            intent: 'study_schedule',
            latency_ms: Date.now() - routeStartedAt,
            router,
          }).catch(() => {});
          sendJson(res, 200, {
            reply: 'Bisa. Untuk bikin jadwal belajar dari waktu kosong yang akurat, login dulu supaya aku bisa baca jadwal kuliah kamu.',
            intent: 'study_schedule',
            response_id: responseId,
            engine: 'study-plan-native',
            router,
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
          const replyWithReminder = [rawReply, dueReminderTail].filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY);
          const reliableReply = applyReliabilityFollowup(replyWithReminder, reliability).slice(0, CHATBOT_MAX_REPLY);
          const reply = personalizeReplyForUser(reliableReply, {
            user_id: optionalUser,
            memory,
            intent,
          }).slice(0, CHATBOT_MAX_REPLY);
          const memoryUpdate = buildStatelessMemoryUpdate(memory, intent, message, ['study']);
          const suggestions = applyLearningToSuggestions(buildStudyPlanSuggestions(studyPlan), learningHints);
          const responseId = randomUUID();
          const complexity = evaluateHybridComplexity(message, planner);
          const router = {
            mode: 'native',
            selected_engine: 'study-plan-native',
            engine_final: 'study-plan-native',
            fallback_used: false,
            complexity_score: complexity.score,
            complexity_level: complexity.level,
            complexity_threshold: complexity.threshold,
            reasons: complexity.reasons,
          };

          const topics = normalizeRecentStrings([...extractMessageTopics(message), 'study'], 5);
          writeZaiMemoryBundle(optionalUser, {
            message,
            intent,
            reply,
            planner,
            context: { ...contextWithMemory, response_id: responseId },
            topics,
          }).catch(() => {});
          writeRouterMetricEvent({
            user_id: optionalUser || null,
            response_id: responseId,
            status: 'ok',
            engine: 'study-plan-native',
            intent,
            latency_ms: Date.now() - routeStartedAt,
            router,
          }).catch(() => {});

          sendJson(res, 200, {
            reply,
            intent,
            response_id: responseId,
            engine: 'study-plan-native',
            router,
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
            due_reminders: Array.isArray(dueReminderState.reminders) ? dueReminderState.reminders : [],
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
      const reliableReplyCore = applyReliabilityFollowup(rawReplyCore, reliability).slice(0, CHATBOT_MAX_REPLY);
      const replyCore = personalizeReplyForUser(reliableReplyCore, {
        user_id: optionalUser,
        memory: memoryOut,
        intent: intentOut,
      }).slice(0, CHATBOT_MAX_REPLY);
      const replyParts = [replyCore];
      const plannerInfo = plannerTextBlock(plannerOut);
      if (plannerInfo) replyParts.push(plannerInfo);
      const memoryInfo = memoryTextBlock(memoryOut);
      if (memoryInfo) replyParts.push(memoryInfo);
      const includeMeta = parseBooleanEnv(process.env.CHATBOT_INCLUDE_META || '');
      const finalReply = includeMeta
        ? replyParts.filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY)
        : replyCore;
      const finalReplyWithReminder = [finalReply, dueReminderTail].filter(Boolean).join('\n\n').slice(0, CHATBOT_MAX_REPLY);
      const suggestionsOut = applyLearningToSuggestions(payload?.suggestions, learningHints);
      const responseId = randomUUID();

      if (optionalUser) {
        const topics = extractMessageTopics(message);
        writeZaiMemoryBundle(optionalUser, {
          message,
          intent: intentOut,
          reply: finalReplyWithReminder,
          planner: plannerOut,
          context: { ...contextWithMemory, response_id: responseId },
          topics,
        }).catch(() => {});
      }
      const routerOut = payload?.router && typeof payload.router === 'object' ? payload.router : null;
      writeRouterMetricEvent({
        user_id: optionalUser || null,
        response_id: responseId,
        status: 'ok',
        engine: String(payload?.engine || ''),
        intent: intentOut,
        latency_ms: Date.now() - routeStartedAt,
        router: routerOut || {},
      }).catch(() => {});

      sendJson(res, 200, {
        reply: finalReplyWithReminder,
        intent: intentOut,
        response_id: responseId,
        engine: String(payload?.engine || ''),
        router: routerOut,
        adaptive: payload?.adaptive && typeof payload.adaptive === 'object' ? payload.adaptive : null,
        planner: plannerOut,
        reliability,
        unified_memory: memoryOut,
        memory_update: memoryUpdate,
        feedback_profile: normalizeFeedbackProfile(memoryOut?.memory?.feedback_profile || {}),
        suggestions: normalizeChatbotSuggestions(suggestionsOut),
        due_reminders: Array.isArray(dueReminderState.reminders) ? dueReminderState.reminders : [],
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
      res.status(403).json({ error: 'Hanya admin yang bisa menghapus chat' });
      return;
    }
    await pool.query('DELETE FROM chat_messages');
    sendJson(res, 200, { ok: true });
    return;
  }

  res.status(405).json({ error: 'Metode tidak diizinkan' });
});

