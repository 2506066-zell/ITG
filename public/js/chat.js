import { initProtected } from './main.js';
import { get, post, del } from './api.js';

let pollingInterval;
let pendingConfirmationToken = '';
let assistantBusy = false;
let lastAssistantPayload = null;
let assistantAlwaysOn = false;
let lastDraftTemplatePattern = '';
let lastDraftPlaceholderIndex = -1;

const ASSISTANT_ALWAYS_ON_KEY = 'assistant_always_on_v1';

const BASE_COMMAND_SUGGESTIONS = [
  { label: 'Template Daily Task', command: 'buat task [judul tugas] deadline [besok 19:00] priority [high/medium/low]' },
  { label: 'Template Tugas Kuliah', command: 'buat assignment [judul tugas kuliah] deskripsi [opsional] deadline [besok 21:00]' },
  { label: 'Risk Deadline 48h', command: 'risk deadline 48 jam ke depan' },
  { label: 'Memory Graph', command: 'tampilkan memory graph hari ini' },
  { label: 'Ringkasan Hari Ini', command: 'ringkasan hari ini' },
  { label: 'Urgent Radar', command: 'task urgent saya hari ini apa', tone: 'urgent' },
  { label: 'Couple Pulse', command: 'lihat couple pulse hari ini' },
  { label: 'Memory Snapshot', command: 'tampilkan memory hari ini' },
  { label: 'Study Plan Besok', command: 'jadwal belajar besok pagi' },
  { label: 'Assignment Pending', command: 'assignment pending' },
  { label: 'Bundle Cepat', command: 'buat task review materi deadline besok 19:00 lalu atur target belajar 180 menit' },
];

function normalizeAssistantInput(raw = '') {
  return String(raw || '')
    .replace(/\uFF0F/g, '/') // fullwidth slash -> slash
    .replace(/\u200B/g, '') // zero-width space
    .trim();
}

function parseAssistantCommand(raw = '') {
  const normalized = normalizeAssistantInput(raw);
  if (!normalized) return null;

  if (/^\/confirm$/i.test(normalized)) {
    return '/confirm';
  }

  if (/^\/ai\b/i.test(normalized)) {
    const prompt = normalized.replace(/^\/ai\b/i, '').trim();
    return prompt ? `/ai ${prompt}` : '/ai';
  }

  if (/^@assistant\b/i.test(normalized)) {
    const prompt = normalized.replace(/^@assistant\b/i, '').trim();
    return prompt ? `@assistant ${prompt}` : '@assistant';
  }

  return null;
}

function parsePlainChatEscape(raw = '') {
  const normalized = normalizeAssistantInput(raw);
  if (!/^\/chat\b/i.test(normalized)) return null;
  return normalized.replace(/^\/chat\b/i, '').trim();
}

function readAssistantAlwaysOnPreference() {
  try {
    return localStorage.getItem(ASSISTANT_ALWAYS_ON_KEY) === '1';
  } catch {
    return false;
  }
}

function writeAssistantAlwaysOnPreference(value) {
  try {
    localStorage.setItem(ASSISTANT_ALWAYS_ON_KEY, value ? '1' : '0');
  } catch {}
}

function syncAssistantModeUI() {
  const toggle = document.getElementById('assistant-always-on');
  const input = document.getElementById('chat-input');
  const indicator = document.getElementById('assistant-mode-indicator');
  const indicatorText = document.getElementById('assistant-mode-indicator-text');
  if (toggle) toggle.checked = assistantAlwaysOn;
  if (indicator) indicator.classList.toggle('assistant-on', assistantAlwaysOn);
  if (indicatorText) indicatorText.textContent = assistantAlwaysOn ? 'AI ON' : 'CHAT';
  if (input) {
    input.placeholder = assistantAlwaysOn
      ? 'Assistant ON: ketik natural. Gunakan /chat ... untuk chat biasa'
      : 'Type message, /ai ..., atau tap suggestion';
  }
}

function escapeHtml(text = '') {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function appendLocalSystemMessage(author, message, options = {}) {
  const wrap = document.querySelector('#chat-messages');
  if (!wrap) return null;
  const type = options.type === 'system' ? 'system' : 'assistant';

  const el = document.createElement('div');
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.className = type === 'system' ? 'chat-msg system' : 'chat-msg assistant';
  const metaAuthorHtml = type === 'assistant'
    ? `<span class="assistant-author"><i class="fa-solid fa-robot"></i>${escapeHtml(author)}</span>`
    : `<span>${escapeHtml(author)}</span>`;
  el.innerHTML = `
    <div class="msg-meta">
      ${metaAuthorHtml}
      <span>${escapeHtml(now)}</span>
    </div>
    <div class="bubble-content assistant-bubble"></div>
  `;
  const content = el.querySelector('.assistant-bubble');
  content.textContent = message;
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  return content;
}

function formatAssistantReply(payload) {
  const lines = [];
  if (payload.reply) lines.push(payload.reply);

  if (payload.mode === 'confirmation_required') {
    lines.push('Konfirmasi write tidak wajib pada mode terbaru.');
  }

  if (payload.mode === 'clarification_required') {
    const clarifications = Array.isArray(payload.clarifications) ? payload.clarifications : [];
    if (clarifications.length) {
      const q = clarifications.slice(0, 4).map((item, idx) => {
        const question = item && item.question ? item.question : '';
        const example = item && item.example ? ` (contoh: ${item.example})` : '';
        return `${idx + 1}. ${question}${example}`;
      });
      lines.push(q.join('\n'));
    }
  }

  const items = payload.data && Array.isArray(payload.data.items) ? payload.data.items : [];
  if (items.length > 0) {
    const preview = items.slice(0, 5).map((it) => {
      const id = it.id ? `#${it.id} ` : '';
      const title = it.title || it.subject || JSON.stringify(it);
      return `- ${id}${title}`;
    });
    lines.push(preview.join('\n'));
  }

  const explain = payload && payload.explainability && typeof payload.explainability === 'object'
    ? payload.explainability
    : null;
  if (explain) {
    const whyItems = Array.isArray(explain.why) ? explain.why.filter(Boolean) : [];
    if (whyItems.length) lines.push(`Kenapa: ${whyItems.join(' | ')}`);
    if (explain.impact) lines.push(`Dampak: ${explain.impact}`);
    if (explain.risk) lines.push(`Risiko: ${explain.risk}`);
    if (explain.recommended_action) lines.push(`Saran: ${explain.recommended_action}`);
    if (explain.confidence) lines.push(`Confidence: ${explain.confidence}`);
  }

  const frame = payload && payload.execution_frame && typeof payload.execution_frame === 'object'
    ? payload.execution_frame
    : null;
  if (frame && frame.planner && Array.isArray(frame.planner.steps) && frame.planner.steps.length) {
    lines.push(`Plan: ${frame.planner.steps.join(' -> ')}`);
  }
  if (frame && frame.critic) {
    if (frame.critic.quality) lines.push(`Critic: ${String(frame.critic.quality).toUpperCase()}`);
    if (frame.critic.next_best_action) lines.push(`Next: ${frame.critic.next_best_action}`);
  }

  return lines.join('\n');
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

function confidenceTone(level = '') {
  const normalized = String(level || '').toLowerCase();
  if (normalized === 'high') return 'success';
  if (normalized === 'low') return 'warning';
  return 'info';
}

function normalizeAssistantCommand(raw = '') {
  const parsed = parseAssistantCommand(raw);
  if (parsed) return parsed;
  const prompt = normalizeAssistantInput(raw);
  if (!prompt) return '';
  return `/ai ${prompt}`;
}

function buildDraftInputFromCommand(command = '') {
  const normalized = normalizeAssistantInput(command || '');
  if (!normalized) return '';
  if (/^\/confirm$/i.test(normalized)) return normalized;
  if (/^@assistant\b/i.test(normalized)) {
    const prompt = normalized.replace(/^@assistant\b/i, '').trim();
    return assistantAlwaysOn ? prompt : (prompt ? `/ai ${prompt}` : '/ai');
  }
  if (/^\/ai\b/i.test(normalized)) {
    const prompt = normalized.replace(/^\/ai\b/i, '').trim();
    return assistantAlwaysOn ? prompt : normalized;
  }
  return assistantAlwaysOn ? normalized : `/ai ${normalized}`;
}

function extractBracketPlaceholders(value = '') {
  const ranges = [];
  const regex = /\[[^\]]+\]/g;
  let match = regex.exec(value);
  while (match) {
    ranges.push({
      start: match.index + 1,
      end: match.index + match[0].length - 1,
    });
    match = regex.exec(value);
  }
  return ranges;
}

function normalizeTemplatePattern(value = '') {
  return String(value || '')
    .replace(/\[[^\]]+\]/g, '[]')
    .trim()
    .toLowerCase();
}

function stageAssistantDraft(command = '') {
  const input = document.querySelector('#chat-input');
  if (!input) return;
  const draft = buildDraftInputFromCommand(command);
  if (!draft) return;
  const current = String(input.value || '');
  const currentPattern = normalizeTemplatePattern(current);
  const draftPattern = normalizeTemplatePattern(draft);
  const canReuseCurrent = (
    currentPattern &&
    draftPattern &&
    currentPattern === draftPattern &&
    extractBracketPlaceholders(current).length > 0
  );

  const valueToUse = canReuseCurrent ? current : draft;
  input.value = valueToUse;
  input.focus();

  const placeholders = extractBracketPlaceholders(valueToUse);
  if (placeholders.length > 0) {
    if (lastDraftTemplatePattern !== draftPattern) {
      lastDraftPlaceholderIndex = -1;
    }
    const nextIndex = (lastDraftPlaceholderIndex + 1) % placeholders.length;
    lastDraftTemplatePattern = draftPattern;
    lastDraftPlaceholderIndex = nextIndex;
    const target = placeholders[nextIndex];
    try {
      input.setSelectionRange(target.start, target.end);
      return;
    } catch {}
  }
  lastDraftTemplatePattern = '';
  lastDraftPlaceholderIndex = -1;
  const pos = input.value.length;
  try {
    input.setSelectionRange(pos, pos);
  } catch {}
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

function extractAssistantEvidenceChips(payload) {
  const chips = [];
  const tool = String(payload?.tool || '');
  const mode = String(payload?.mode || '');
  const explain = payload?.explainability || {};
  const data = payload?.data || {};

  if (mode === 'confirmation_required') chips.push({ label: 'Needs Confirm', tone: 'warning', command: '/confirm' });
  if (mode === 'clarification_required') chips.push({ label: 'Need Details', tone: 'warning', command: 'buat task review basis data deadline besok 19:00 priority high' });
  if (mode === 'write_executed') chips.push({ label: 'Write Executed', tone: 'success', command: 'ringkasan hari ini' });

  const toolCallsCount = Array.isArray(payload?.tool_calls) ? payload.tool_calls.length : 0;
  if (toolCallsCount > 1) chips.push({ label: `Bundle x${toolCallsCount}`, tone: 'info', command: 'ringkasan hari ini' });

  if (tool === 'get_tasks' || tool === 'get_assignments') {
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length) {
      chips.push({
        label: `${items.length} Pending`,
        tone: 'info',
        command: tool === 'get_tasks' ? 'task pending saya apa' : 'assignment pending saya apa',
      });
    }
    const risk = summarizeDeadlineRisk(items);
    if (risk.overdue > 0) chips.push({ label: `${risk.overdue} Overdue`, tone: 'critical', command: 'task urgent saya apa' });
    else if (risk.due24h > 0) chips.push({ label: `${risk.due24h} Due <24h`, tone: 'warning', command: 'task urgent saya apa' });
  }

  if (tool === 'get_daily_brief') {
    const taskCount = Array.isArray(data.tasks) ? data.tasks.length : 0;
    const assignmentCount = Array.isArray(data.assignments) ? data.assignments.length : 0;
    const classCount = Array.isArray(data.schedule) ? data.schedule.length : 0;
    chips.push({ label: `Task ${taskCount}`, tone: 'info', command: 'task pending saya apa' });
    chips.push({ label: `Assignment ${assignmentCount}`, tone: 'info', command: 'assignment pending saya apa' });
    chips.push({ label: `Class ${classCount}`, tone: 'info', command: 'jadwal hari ini' });
  }

  if (tool === 'get_unified_memory') {
    const counters = data.counters || {};
    const streak = data.streak || {};
    const urgent = Number(counters.urgent_items || 0);
    if (urgent > 0) chips.push({ label: `Urgent ${urgent}`, tone: 'critical', command: 'task urgent saya apa' });
    const streakDays = Number(streak.current_days || 0);
    if (streakDays > 0) chips.push({ label: `Streak ${streakDays}d`, tone: 'success', command: 'jadwal belajar besok pagi' });
  }

  if (tool === 'get_study_plan') {
    const summary = data.summary || {};
    const sessions = Number(summary.sessions || 0);
    const criticalSessions = Number(summary.critical_sessions || 0);
    if (sessions > 0) chips.push({ label: `${sessions} Sessions`, tone: 'info', command: 'jadwal belajar besok pagi' });
    if (criticalSessions > 0) chips.push({ label: `${criticalSessions} Critical`, tone: 'warning', command: 'geser sesi belajar ke besok pagi' });
  }

  if (tool === 'get_deadline_risk') {
    const summary = data.summary || {};
    const critical = Number(summary.critical || 0);
    const high = Number(summary.high || 0);
    if (critical > 0) chips.push({ label: `Critical ${critical}`, tone: 'critical', command: 'task urgent saya apa' });
    if (high > 0) chips.push({ label: `High ${high}`, tone: 'warning', command: 'risk deadline 48 jam ke depan' });
  }

  if (tool === 'get_memory_graph') {
    const nodes = Array.isArray(data.nodes) ? data.nodes.length : 0;
    const edges = Array.isArray(data.edges) ? data.edges.length : 0;
    chips.push({ label: `Graph ${nodes}/${edges}`, tone: 'info', command: 'tampilkan memory graph hari ini' });
  }

  if (tool === 'get_couple_coordination') {
    const me = data.me || {};
    const partner = data.partner || {};
    const reco = data.recommendation || {};
    if (Number.isFinite(Number(reco.balance_score))) {
      chips.push({ label: `Balance ${Number(reco.balance_score)}`, tone: 'info', command: 'lihat couple pulse hari ini' });
    }
    chips.push({ label: `${me.user || 'Me'} ${Number(me.load_index || 0)}`, tone: 'warning', command: 'task pending saya apa' });
    chips.push({ label: `${partner.user || 'Partner'} ${Number(partner.load_index || 0)}`, tone: 'info', command: 'ingatkan pasangan check-in malam ini' });
  }

  if (explain && explain.confidence) {
    chips.push({
      label: `Confidence ${String(explain.confidence).toUpperCase()}`,
      tone: confidenceTone(explain.confidence),
      command: 'tampilkan memory hari ini',
    });
  }

  return dedupeEvidenceChips(chips);
}

function renderAssistantEvidenceChips(contentEl, payload) {
  if (!contentEl) return;
  const prev = contentEl.querySelector('.assistant-evidence-row');
  if (prev) prev.remove();

  const chips = extractAssistantEvidenceChips(payload);
  if (!chips.length) return;

  const row = document.createElement('div');
  row.className = 'assistant-evidence-row';
  chips.forEach((chip) => {
    const node = document.createElement('button');
    const command = normalizeAssistantCommand(chip.command || '');
    node.className = `assistant-evidence-chip tone-${chip.tone || 'info'}`;
    node.type = 'button';
    node.textContent = chip.label;
    if (command) {
      node.dataset.command = command;
      node.title = `Isi draft: ${command}`;
      node.addEventListener('click', () => {
        stageAssistantDraft(command);
      });
    } else {
      node.disabled = true;
    }
    row.appendChild(node);
  });
  contentEl.appendChild(row);
}

function consumePendingAiFromUrl() {
  try {
    const url = new URL(window.location.href);
    const raw = (url.searchParams.get('ai') || '').trim();
    if (!raw) return;
    const command = normalizeAssistantCommand(raw);
    if (!command) return;
    url.searchParams.delete('ai');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    runAssistant(command).catch((err) => {
      appendLocalSystemMessage('Assistant', `Assistant error: ${err.message || 'unknown error'}`);
    });
  } catch {}
}

function parseSseFrame(frame) {
  const lines = frame.split('\n');
  let event = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { text: raw };
  }

  return { event, data };
}

async function readAssistantStream(prompt, onDelta) {
  const token = localStorage.getItem('token') || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch('/api/assistant/stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: prompt }),
  });

  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (!type.includes('text/event-stream')) {
    const text = await res.text();
    throw new Error(text || `Assistant stream failed (${res.status})`);
  }

  if (!res.body) {
    throw new Error('Streaming tidak didukung browser ini.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assembled = '';
  let finalPayload = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf('\n\n');

    while (separatorIndex >= 0) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      const parsed = parseSseFrame(frame);
      if (parsed) {
        if (parsed.event === 'delta' && parsed.data && typeof parsed.data.text === 'string') {
          assembled += parsed.data.text;
          onDelta(assembled);
        } else if (parsed.event === 'result') {
          finalPayload = parsed.data;
        } else if (parsed.event === 'error') {
          throw new Error(parsed.data?.error || 'Assistant stream error');
        }
      }

      separatorIndex = buffer.indexOf('\n\n');
    }
  }

  if (finalPayload) return finalPayload;
  return { mode: 'read', reply: assembled, data: {} };
}

function dedupeSuggestions(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || !item.command) continue;
    const key = `${item.label || ''}::${item.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function contextualCommandSuggestions(payload) {
  const suggestions = [];
  const tool = payload?.tool || '';
  const data = payload?.data || {};
  const mode = payload?.mode || '';

  if (mode === 'clarification_required') {
    const quick = Array.isArray(payload?.suggested_commands) ? payload.suggested_commands : [];
    quick.slice(0, 4).forEach((cmd) => {
      if (!cmd) return;
      const clean = String(cmd).trim();
      if (!clean) return;
      const label = clean.replace(/^\/ai\s+/i, '').slice(0, 40) || clean;
      suggestions.push({ label, command: clean, tone: 'urgent' });
    });
  }

  if (tool === 'get_tasks' && Array.isArray(data.items) && data.items.length) {
    const topTask = data.items.find((item) => item && item.id);
    if (topTask) {
      suggestions.push({ label: `Selesaikan Task #${topTask.id}`, command: `selesaikan task ${topTask.id}` });
      suggestions.push({ label: `Geser Deadline #${topTask.id}`, command: `ubah deadline task ${topTask.id} besok 20:00`, tone: 'urgent' });
    }
  }

  if (tool === 'get_assignments' && Array.isArray(data.items) && data.items.length) {
    const topAssignment = data.items.find((item) => item && item.id);
    if (topAssignment) {
      suggestions.push({ label: `Selesaikan Assignment #${topAssignment.id}`, command: `selesaikan assignment ${topAssignment.id}` });
    }
  }

  if (tool === 'get_study_plan') {
    suggestions.push({ label: 'Naikkan Target Belajar', command: 'atur target belajar 200 menit' });
    suggestions.push({ label: 'Replan ke Pagi', command: 'geser sesi belajar ke besok pagi' });
  }

  if (tool === 'get_unified_memory') {
    suggestions.push({ label: 'Lihat Urgent Radar', command: 'task urgent saya apa', tone: 'urgent' });
    suggestions.push({ label: 'Check Assignment', command: 'assignment pending saya apa' });
  }

  if (tool === 'get_deadline_risk') {
    suggestions.push({ label: 'Lihat Risk 24h', command: 'risk deadline 24 jam ke depan', tone: 'urgent' });
    suggestions.push({ label: 'Lihat Task Urgent', command: 'task urgent saya apa', tone: 'urgent' });
  }

  if (tool === 'get_memory_graph') {
    suggestions.push({ label: 'Refresh Memory Graph', command: 'tampilkan memory graph hari ini' });
    suggestions.push({ label: 'Lihat Memory Snapshot', command: 'tampilkan memory hari ini' });
  }

  if (tool === 'get_couple_coordination') {
    suggestions.push({ label: 'Nudge Check-In', command: 'ingatkan pasangan check-in malam ini' });
    suggestions.push({ label: 'Refresh Couple Pulse', command: 'lihat couple pulse hari ini' });
  }

  if (mode === 'write_executed') {
    suggestions.push({ label: 'Refresh Ringkasan', command: 'ringkasan hari ini' });
  }

  return suggestions;
}

function buildCommandSuggestions(payload) {
  const merged = dedupeSuggestions([
    ...contextualCommandSuggestions(payload),
    ...BASE_COMMAND_SUGGESTIONS,
  ]);
  return merged.slice(0, 9);
}

function executeSuggestedCommand(command = '') {
  const normalized = String(command || '').trim();
  if (!normalized) return;
  stageAssistantDraft(normalized);
}

function renderCommandSuggestions(payload) {
  const wrap = document.querySelector('#assistant-suggestions');
  if (!wrap) return;

  const suggestions = buildCommandSuggestions(payload);
  wrap.innerHTML = '';

  for (const item of suggestions) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'assistant-suggestion-chip';
    if (item.tone === 'confirm') chip.classList.add('is-confirm');
    if (item.tone === 'urgent') chip.classList.add('is-urgent');
    chip.textContent = item.label || item.command;
    chip.title = item.command;
    chip.addEventListener('click', () => {
      executeSuggestedCommand(item.command);
    });
    wrap.appendChild(chip);
  }
}

async function runAssistant(promptOrCommand) {
  const trimmed = normalizeAssistantInput(promptOrCommand || '');
  if (!trimmed) return;
  let contentEl = null;

  if (assistantBusy) {
    appendLocalSystemMessage('Assistant', 'Assistant masih memproses request sebelumnya.');
    return;
  }
  assistantBusy = true;

  try {
    if (/^\/confirm$/i.test(trimmed)) {
      appendLocalSystemMessage('Assistant', 'Mode terbaru tidak butuh /confirm. Tulis langsung perintahnya.');
      renderCommandSuggestions(lastAssistantPayload);
      return;
    }

    const prompt = trimmed
      .replace(/^\/ai\b/i, '')
      .replace(/^@assistant\b/i, '')
      .trim();
    if (!prompt) {
      appendLocalSystemMessage('Assistant', 'Format: /ai <pertanyaan>');
      renderCommandSuggestions(lastAssistantPayload);
      return;
    }

    contentEl = appendLocalSystemMessage('Assistant', '');
    if (contentEl) {
      contentEl.textContent = '...';
      contentEl.classList.add('v3-assistant-typing');
    }

    const result = await readAssistantStream(prompt, (partialText) => {
      if (contentEl) contentEl.textContent = partialText;
    });

    if (result.mode === 'confirmation_required' && result.confirmation_token) {
      pendingConfirmationToken = result.confirmation_token;
    } else {
      pendingConfirmationToken = '';
    }
    lastAssistantPayload = result;

    const formatted = formatAssistantReply(result);
    if (contentEl) {
      contentEl.textContent = formatted || result.reply || 'Selesai.';
      contentEl.classList.remove('v3-assistant-typing');
      contentEl.classList.add('v3-assistant-arrived');
      renderAssistantEvidenceChips(contentEl, result);
      setTimeout(() => contentEl.classList.remove('v3-assistant-arrived'), 520);
    }
    renderCommandSuggestions(result);
  } catch (err) {
    if (contentEl) {
      contentEl.classList.remove('v3-assistant-typing');
      contentEl.textContent = `Assistant error: ${err.message || 'unknown error'}`;
    } else {
      appendLocalSystemMessage('Assistant', `Assistant error: ${err.message || 'unknown error'}`);
    }
    renderCommandSuggestions(lastAssistantPayload);
  } finally {
    assistantBusy = false;
  }
}

async function loadMessages() {
  const wrap = document.querySelector('#chat-messages');
  try {
    const msgs = await get('/chat');

    // Simple render (replace all) - Not efficient but works for small chat
    // Optimization: Diffing or appending new only. 
    // For now, let's just clear and render to ensure sync.
    const wasAtBottom = wrap.scrollHeight - wrap.scrollTop === wrap.clientHeight;

    const currentUser = localStorage.getItem('user');

    msgs.forEach(m => {
      // Avoid duplicates
      if (wrap.querySelector(`[data-id="${m.id}"]`)) return;

      const el = document.createElement('div');
      const isMe = m.user_id === currentUser;
      const isSystem = m.user_id === 'System' || m.message.includes('Daily Topic');

      el.className = `chat-msg ${isMe ? 'me' : ''} ${isSystem ? 'system' : ''}`;
      el.setAttribute('data-id', m.id);

      const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      const safeUser = escapeHtml(String(m.user_id || 'Unknown'));
      const safeTime = escapeHtml(String(time));
      const safeMessage = escapeHtml(String(m.message || ''));
      el.innerHTML = `
        <div class="msg-meta">
          <span>${safeUser}</span>
          <span>${safeTime}</span>
        </div>
        <div class="bubble-content">${safeMessage}</div>
      `;
      wrap.appendChild(el);

      // Auto-scroll on new message
      wrap.scrollTop = wrap.scrollHeight;
    });
  } catch (err) {
    console.error('Chat load failed', err);
  }
}

async function send(e) {
  e.preventDefault();
  const input = document.querySelector('#chat-input');
  const text = normalizeAssistantInput(input.value || '');
  if (!text) return;

  input.disabled = true;
  try {
    const assistantCommand = parseAssistantCommand(text);
    const plainChat = parsePlainChatEscape(text);

    if (assistantAlwaysOn) {
      if (plainChat !== null) {
        if (!plainChat) {
          appendLocalSystemMessage('Assistant', 'Format chat biasa: /chat <pesan>');
          return;
        }
        await post('/chat', { message: plainChat });
        input.value = '';
        loadMessages();
        return;
      }
      const command = assistantCommand || normalizeAssistantCommand(text);
      if (command) {
        await runAssistant(command);
        input.value = '';
        return;
      }
    } else if (assistantCommand) {
      await runAssistant(assistantCommand);
      input.value = '';
      return;
    }

    await post('/chat', { message: text });
    input.value = '';
    loadMessages(); // Immediate refresh
  } catch (err) {
    alert('Failed to send');
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function clearAll() {
  if (!confirm('Clear all chat history? (Admin only)')) return;
  try {
    await del('/chat');
    document.querySelector('#chat-messages').innerHTML = '';
    loadMessages();
  } catch (e) {
    alert(e.error || 'Failed to clear');
  }
}

function init() {
  initProtected();
  document.querySelector('#chat-form').addEventListener('submit', send);
  document.querySelector('#chat-clear').addEventListener('click', clearAll);
  assistantAlwaysOn = readAssistantAlwaysOnPreference();
  syncAssistantModeUI();

  const alwaysOnToggle = document.getElementById('assistant-always-on');
  if (alwaysOnToggle) {
    alwaysOnToggle.addEventListener('change', (event) => {
      assistantAlwaysOn = Boolean(event.target && event.target.checked);
      writeAssistantAlwaysOnPreference(assistantAlwaysOn);
      syncAssistantModeUI();
      appendLocalSystemMessage(
        'Assistant',
        assistantAlwaysOn
          ? 'Assistant Always On aktif. Ketik langsung untuk AI. Gunakan /chat ... untuk chat biasa.'
          : 'Assistant Always On nonaktif. Gunakan /ai ... untuk panggil assistant.'
      );
    });
  }

  renderCommandSuggestions(lastAssistantPayload);
  loadMessages();
  consumePendingAiFromUrl();

  // Poll every 3 seconds
  pollingInterval = setInterval(loadMessages, 3000);
}

document.addEventListener('DOMContentLoaded', init);
// Cleanup poll on page hide? Not necessary for single page simple app
