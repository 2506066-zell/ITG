import { readBody, withErrorHandling, sendJson } from './_lib.js';

const MAX_MESSAGE_LEN = 700;
const MAX_REPLY_LEN = 420;
const MAX_SUGGESTIONS = 4;
const MAX_HISTORY = 8;

const ALLOWED_INTENTS = new Set([
  'greeting',
  'check_daily_target',
  'reminder_ack',
  'checkin_progress',
  'evaluation',
  'affirmation',
  'recommend_task',
  'study_schedule',
  'toxic_motivation',
  'fallback',
]);

const ALLOWED_TONES = new Set(['info', 'success', 'warning', 'critical']);

function parseBooleanEnv(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function normalizeText(value, maxLen = 280) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeRecentStrings(list, max = MAX_HISTORY) {
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

function normalizeContext(raw = null) {
  if (!raw || typeof raw !== 'object') {
    return {
      tone_mode: 'supportive',
      focus_minutes: 25,
      focus_window: 'any',
      recent_intents: [],
      preferred_commands: [],
      avoid_commands: [],
    };
  }
  const tone = String(raw.tone_mode || '').trim().toLowerCase();
  const focusWindow = String(raw.focus_window || '').trim().toLowerCase();
  return {
    tone_mode: ['supportive', 'strict', 'balanced'].includes(tone) ? tone : 'supportive',
    focus_minutes: Math.max(10, Math.min(180, Number(raw.focus_minutes || 25))),
    focus_window: ['any', 'morning', 'afternoon', 'evening'].includes(focusWindow) ? focusWindow : 'any',
    recent_intents: normalizeRecentStrings(raw.recent_intents, 6),
    preferred_commands: normalizeRecentStrings(raw.preferred_commands, 6),
    avoid_commands: normalizeRecentStrings(raw.avoid_commands, 6),
  };
}

function normalizePlanner(raw = null) {
  const planner = raw && typeof raw === 'object' ? raw : {};
  const actions = Array.isArray(planner.actions)
    ? planner.actions
        .slice(0, 5)
        .map((item) => ({
          kind: normalizeText(item?.kind, 40),
          summary: normalizeText(item?.summary, 120),
          status: normalizeText(item?.status, 20),
          missing: Array.isArray(item?.missing) ? item.missing.slice(0, 3).map((field) => normalizeText(field, 20).toLowerCase()) : [],
        }))
    : [];
  const clarifications = Array.isArray(planner.clarifications)
    ? planner.clarifications
        .slice(0, 4)
        .map((item) => ({
          field: normalizeText(item?.field, 24).toLowerCase(),
          question: normalizeText(item?.question, 120),
        }))
    : [];
  return {
    mode: normalizeText(planner.mode, 24).toLowerCase() || (actions.length > 1 ? 'bundle' : 'single'),
    confidence: normalizeText(planner.confidence, 24).toLowerCase() || (clarifications.length ? 'medium' : 'high'),
    requires_clarification: Boolean(planner.requires_clarification || clarifications.length > 0),
    actions,
    clarifications,
    summary: normalizeText(planner.summary, 220),
    next_best_action: normalizeText(planner.next_best_action, 160),
  };
}

function normalizeMemory(raw = null) {
  const memory = raw && typeof raw === 'object' ? raw : {};
  const nested = memory.memory && typeof memory.memory === 'object' ? memory.memory : {};
  const unresolvedRaw = memory.unresolved_fields ?? memory.unresolved ?? nested.unresolved_fields ?? nested.unresolved;
  const unresolvedFields = Array.isArray(unresolvedRaw)
    ? unresolvedRaw
        .slice(0, 6)
        .map((item) => String(item?.field || item || '').trim().toLowerCase())
        .filter(Boolean)
    : [];

  return {
    focus_topic: normalizeText(memory.focus_topic || nested.focus_topic || 'general', 48).toLowerCase(),
    recent_topics: normalizeRecentStrings(memory.recent_topics || nested.recent_topics || [], 8),
    recent_intents: normalizeRecentStrings(memory.recent_intents || nested.recent_intents || [], 8),
    unresolved_fields: normalizeRecentStrings(unresolvedFields, 6),
    pending_tasks: Math.max(0, Number(memory.pending_tasks || 0)),
    pending_assignments: Math.max(0, Number(memory.pending_assignments || 0)),
    avg_mood_7d: Number(memory.avg_mood_7d || 0),
  };
}

function extractTopics(message = '') {
  const text = String(message || '').toLowerCase();
  const topics = [];
  const push = (value) => {
    if (!value || topics.includes(value)) return;
    topics.push(value);
  };

  if (/\b(kuliah|assignment|deadline|ujian|quiz|makalah|study|belajar)\b/.test(text)) push('kuliah');
  if (/\b(target|goal|prioritas)\b/.test(text)) push('target');
  if (/\b(reminder|ingat|alarm|notifikasi)\b/.test(text)) push('reminder');
  if (/\b(check-?in|progres|progress|sync)\b/.test(text)) push('checkin');
  if (/\b(evaluasi|review|refleksi)\b/.test(text)) push('evaluation');
  if (/\b(mood|lelah|burnout|stress)\b/.test(text)) push('mood');
  if (!topics.length) push('general');
  return topics.slice(0, 5);
}

function inferIntent(message = '', reply = '') {
  const text = `${String(message || '')} ${String(reply || '')}`.toLowerCase();
  if (/\b(halo|hai|hi|hello|hey)\b/.test(text)) return 'greeting';
  if (/\b(target|goal)\b/.test(text)) return 'check_daily_target';
  if (/\b(reminder|ingatkan|alarm|notifikasi|jangan lupa)\b/.test(text)) return 'reminder_ack';
  if (/\b(check-?in|progress|progres|update)\b/.test(text)) return 'checkin_progress';
  if (/\b(evaluasi|review|refleksi)\b/.test(text)) return 'evaluation';
  if (/\b(oke|ok|sip|siap|gas|lanjut)\b/.test(text)) return 'affirmation';
  if (/\b(rekomendasi|prioritas|task apa|tugas apa)\b/.test(text)) return 'recommend_task';
  if (/\b(jadwal belajar|study plan|sesi belajar)\b/.test(text)) return 'study_schedule';
  if (/\b(toxic|tegas|gaspol|no excuse)\b/.test(text)) return 'toxic_motivation';
  return 'fallback';
}

function inferAdaptive(message = '', context = {}, intent = 'fallback') {
  const text = String(message || '').toLowerCase();
  const style = /\b(toxic|tegas|gaspol|no excuse)\b/.test(text)
    ? 'strict'
    : (String(context.tone_mode || 'supportive').toLowerCase() || 'supportive');

  const focusHit = text.match(/(\d{2,3})\s*(?:menit|min|minutes?)\b/i);
  const focusMinutes = focusHit
    ? Math.max(10, Math.min(180, Number(focusHit[1])))
    : Math.max(10, Math.min(180, Number(context.focus_minutes || 25)));

  const urgency = /(\bdeadline\b|\bdue\b|\bbesok\b|\bhari ini\b|\burgent\b|\bsekarang\b)/i.test(text)
    ? 'high'
    : (/(\btarget\b|\breminder\b|\bcheck-?in\b)/i.test(text) ? 'medium' : 'low');

  const energy = /(\bcapek\b|\blelah\b|\bburnout\b|\bdrop\b)/i.test(text)
    ? 'low'
    : (/(\bsemangat\b|\bfokus\b|\bgas\b)/i.test(text) ? 'high' : 'normal');

  const domain = /(\bkuliah\b|\bassignment\b|\bdeadline\b|\bujian\b|\bstudy\b|\bbelajar\b)/i.test(text)
    ? 'kuliah'
    : 'umum';

  if (intent === 'study_schedule') {
    return { style, focus_minutes: focusMinutes, urgency: 'medium', energy, domain: 'kuliah' };
  }

  return { style, focus_minutes: focusMinutes, urgency, energy, domain };
}

function normalizeSuggestions(raw = null) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    let label = '';
    let command = '';
    let tone = 'info';
    if (typeof item === 'string') {
      label = normalizeText(item, 36);
      command = normalizeText(item, 180);
    } else if (item && typeof item === 'object') {
      label = normalizeText(item.label || item.text || item.command, 36);
      command = normalizeText(item.command || item.prompt || item.message, 180);
      const toneRaw = normalizeText(item.tone, 16).toLowerCase();
      tone = ALLOWED_TONES.has(toneRaw) ? toneRaw : 'info';
    }
    if (!label || !command) continue;
    const key = `${label.toLowerCase()}::${command.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, command, tone });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

function defaultSuggestions(intent = 'fallback') {
  if (intent === 'study_schedule') {
    return [
      { label: 'Jadwal Besok Pagi', command: 'jadwal belajar besok pagi 120 menit', tone: 'info' },
      { label: 'Target 180 Menit', command: 'jadwal belajar 180 menit', tone: 'success' },
      { label: 'Mode Malam', command: 'jadwal belajar malam 90 menit', tone: 'warning' },
    ];
  }
  if (intent === 'evaluation') {
    return [
      { label: 'Check-In', command: 'check-in progres hari ini', tone: 'info' },
      { label: 'Rencana Besok', command: 'cek target harian besok', tone: 'success' },
    ];
  }
  if (intent === 'recommend_task') {
    return [
      { label: 'Gas Sekarang', command: 'oke gas sekarang', tone: 'success' },
      { label: 'Check-In', command: 'check-in progres tugas', tone: 'info' },
    ];
  }
  return [
    { label: 'Cek Target', command: 'cek target harian pasangan', tone: 'info' },
    { label: 'Rekomendasi', command: 'rekomendasi tugas kuliah', tone: 'success' },
    { label: 'Evaluasi', command: 'evaluasi hari ini', tone: 'info' },
  ];
}

function extractJsonCandidate(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return '';

  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) return fenced[1].trim();

  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return clean.slice(firstBrace, lastBrace + 1);
  }
  return clean;
}

function parseModelPayload(rawText = '') {
  const candidate = extractJsonCandidate(rawText);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function buildMemoryUpdate(intent, message, memory, planner) {
  const topics = normalizeRecentStrings([...extractTopics(message), ...(memory.recent_topics || [])], 8);
  const intents = normalizeRecentStrings([intent, ...(memory.recent_intents || [])], 8);
  const unresolvedFields = Array.isArray(planner?.clarifications)
    ? planner.clarifications
        .map((item) => String(item?.field || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    focus_topic: topics[0] || memory.focus_topic || 'general',
    recent_topics: topics,
    recent_intents: intents,
    unresolved_fields: unresolvedFields,
    pending_tasks: Number(memory.pending_tasks || 0),
    pending_assignments: Number(memory.pending_assignments || 0),
    avg_mood_7d: Number(memory.avg_mood_7d || 0),
  };
}

function fallbackPayload(message = '', context = {}, planner = {}, memory = {}, rawReply = '') {
  const reply = normalizeText(rawReply, MAX_REPLY_LEN)
    || 'Aku siap bantu produktivitas kalian. Coba arahkan ke target, prioritas tugas, atau evaluasi hari ini.';
  const intent = inferIntent(message, reply);
  return {
    reply,
    intent,
    adaptive: inferAdaptive(message, context, intent),
    planner,
    memory_update: buildMemoryUpdate(intent, message, memory, planner),
    suggestions: defaultSuggestions(intent),
    engine: 'llm-v1-fallback',
  };
}

function buildSystemPrompt() {
  return [
    'Kamu adalah Z AI, asisten couple productivity mobile.',
    'Gaya bahasa natural, hangat, tegas saat perlu, bukan kaku.',
    `Batas reply maksimal ${MAX_REPLY_LEN} karakter.`,
    'Jawab dalam Bahasa Indonesia.',
    'Jika input ambigu, balas dengan 1 pertanyaan klarifikasi paling penting.',
    'Selalu keluarkan JSON valid TANPA markdown dengan schema:',
    '{',
    '  "reply": "string",',
    '  "intent": "greeting|check_daily_target|reminder_ack|checkin_progress|evaluation|affirmation|recommend_task|study_schedule|toxic_motivation|fallback",',
    '  "adaptive": { "style": "supportive|strict|balanced", "focus_minutes": 25, "urgency": "low|medium|high", "energy": "low|normal|high", "domain": "kuliah|habit|umum" },',
    '  "suggestions": [{ "label": "string", "command": "string", "tone": "info|success|warning|critical" }]',
    '}',
    'Gunakan suggestions 2-4 item, actionable, natural.',
  ].join('\n');
}

function buildUserPrompt(message, context, planner, memory) {
  const compact = {
    user_message: message,
    context,
    planner_hint: planner,
    memory_hint: {
      focus_topic: memory.focus_topic,
      recent_topics: memory.recent_topics,
      unresolved_fields: memory.unresolved_fields,
      pending_tasks: memory.pending_tasks,
      pending_assignments: memory.pending_assignments,
      avg_mood_7d: memory.avg_mood_7d,
    },
  };
  return JSON.stringify(compact);
}

function resolveLlmConfig() {
  const apiKey = String(process.env.CHATBOT_LLM_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const apiUrl = String(process.env.CHATBOT_LLM_API_URL || 'https://api.openai.com/v1/chat/completions').trim();
  const model = String(process.env.CHATBOT_LLM_MODEL || 'gpt-4o-mini').trim();
  const timeoutMs = Math.max(500, Math.min(9000, Number(process.env.CHATBOT_LLM_TIMEOUT_MS || 1700)));
  const temperature = Math.max(0, Math.min(1.5, Number(process.env.CHATBOT_LLM_TEMPERATURE || 0.45)));
  const maxTokens = Math.max(100, Math.min(1200, Number(process.env.CHATBOT_LLM_MAX_TOKENS || 380)));
  const authHeader = String(process.env.CHATBOT_LLM_AUTH_HEADER || 'Authorization').trim();
  const authPrefixRaw = String(process.env.CHATBOT_LLM_AUTH_PREFIX || 'Bearer').trim();
  const authPrefix = authPrefixRaw ? `${authPrefixRaw} ` : '';
  const forceJson = parseBooleanEnv(process.env.CHATBOT_LLM_FORCE_JSON || '');
  return {
    apiKey,
    apiUrl,
    model,
    timeoutMs,
    temperature,
    maxTokens,
    authHeader,
    authPrefix,
    forceJson,
  };
}

async function callOpenAiCompatible(config, systemPrompt, userPrompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const headers = {
      'Content-Type': 'application/json',
    };
    headers[config.authHeader] = `${config.authPrefix}${config.apiKey}`;

    const body = {
      model: config.model,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };
    if (config.forceJson) {
      body.response_format = { type: 'json_object' };
    }

    const response = await fetch(config.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        error: normalizeText(text || `LLM provider returned ${response.status}`, 260),
      };
    }

    const data = await response.json().catch(() => ({}));
    const firstChoice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const message = firstChoice?.message || {};
    const rawContent = message?.content;
    const content = Array.isArray(rawContent)
      ? rawContent.map((part) => String(part?.text || '')).join('')
      : String(rawContent || '');

    return {
      ok: true,
      status: 200,
      content,
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: normalizeText(err?.message || 'LLM request failed', 240),
    };
  } finally {
    clearTimeout(timer);
  }
}

export default withErrorHandling(async function handler(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'chatbot-llm',
      mode: 'stateless',
      enabled: Boolean(process.env.CHATBOT_LLM_API_KEY || process.env.OPENAI_API_KEY),
    });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const requiredSecret = String(process.env.CHATBOT_LLM_SHARED_SECRET || '').trim();
  if (requiredSecret) {
    const incoming = String(req.headers['x-chatbot-llm-secret'] || req.headers['x-chatbot-secret'] || '').trim();
    if (incoming !== requiredSecret) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const body = req.body || await readBody(req);
  const message = normalizeText(body?.message, MAX_MESSAGE_LEN);
  if (!message) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const context = normalizeContext(body?.context);
  const planner = normalizePlanner(body?.planner);
  const memory = normalizeMemory(body?.memory);

  const config = resolveLlmConfig();
  if (!config.apiKey) {
    res.status(503).json({ error: 'CHATBOT_LLM_API_KEY is not configured' });
    return;
  }

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(message, context, planner, memory);
  const llm = await callOpenAiCompatible(config, systemPrompt, userPrompt);
  if (!llm.ok) {
    res.status(llm.status || 502).json({ error: llm.error || 'LLM request failed' });
    return;
  }

  const parsed = parseModelPayload(llm.content || '');
  if (!parsed) {
    const fallback = fallbackPayload(message, context, planner, memory, llm.content);
    sendJson(res, 200, fallback);
    return;
  }

  const reply = normalizeText(parsed.reply, MAX_REPLY_LEN);
  const intentRaw = normalizeText(parsed.intent, 48).toLowerCase();
  const intent = ALLOWED_INTENTS.has(intentRaw) ? intentRaw : inferIntent(message, reply);
  const adaptive = parsed.adaptive && typeof parsed.adaptive === 'object'
    ? {
        style: ['supportive', 'strict', 'balanced'].includes(String(parsed.adaptive.style || '').toLowerCase())
          ? String(parsed.adaptive.style).toLowerCase()
          : inferAdaptive(message, context, intent).style,
        focus_minutes: Math.max(10, Math.min(180, Number(parsed.adaptive.focus_minutes || context.focus_minutes || 25))),
        urgency: ['low', 'medium', 'high'].includes(String(parsed.adaptive.urgency || '').toLowerCase())
          ? String(parsed.adaptive.urgency).toLowerCase()
          : inferAdaptive(message, context, intent).urgency,
        energy: ['low', 'normal', 'high'].includes(String(parsed.adaptive.energy || '').toLowerCase())
          ? String(parsed.adaptive.energy).toLowerCase()
          : inferAdaptive(message, context, intent).energy,
        domain: ['kuliah', 'habit', 'umum'].includes(String(parsed.adaptive.domain || '').toLowerCase())
          ? String(parsed.adaptive.domain).toLowerCase()
          : inferAdaptive(message, context, intent).domain,
      }
    : inferAdaptive(message, context, intent);

  const suggestions = normalizeSuggestions(parsed.suggestions);
  const payload = {
    reply: reply || fallbackPayload(message, context, planner, memory).reply,
    intent,
    adaptive,
    planner,
    memory_update: buildMemoryUpdate(intent, message, memory, planner),
    suggestions: suggestions.length ? suggestions : defaultSuggestions(intent),
    engine: 'llm-v1',
  };

  sendJson(res, 200, payload);
});
