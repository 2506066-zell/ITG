import { initProtected } from './main.js';
import { get, post, del } from './api.js';

let pollingInterval;
let pendingConfirmationToken = '';

function escapeHtml(text = '') {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function appendLocalSystemMessage(author, message) {
  const wrap = document.querySelector('#chat-messages');
  if (!wrap) return null;

  const el = document.createElement('div');
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.className = 'chat-msg system';
  el.innerHTML = `
    <div class="msg-meta">
      <span>${escapeHtml(author)}</span>
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
    lines.push('Ketik /confirm untuk menjalankan aksi write.');
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

  return lines.join('\n');
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

async function runAssistant(promptOrCommand) {
  const trimmed = (promptOrCommand || '').trim();

  if (trimmed === '/confirm') {
    if (!pendingConfirmationToken) {
      appendLocalSystemMessage('Assistant', 'Tidak ada aksi yang menunggu konfirmasi.');
      return;
    }
    const result = await post('/assistant', {
      confirm: true,
      confirmation_token: pendingConfirmationToken,
    });
    pendingConfirmationToken = '';
    appendLocalSystemMessage('Assistant', formatAssistantReply(result));
    return;
  }

  const prompt = trimmed.startsWith('/ai ') ? trimmed.slice(4).trim() : trimmed.replace(/^@assistant\s+/i, '').trim();
  if (!prompt) {
    appendLocalSystemMessage('Assistant', 'Format: /ai <pertanyaan>');
    return;
  }

  const contentEl = appendLocalSystemMessage('Assistant', '');
  if (contentEl) {
    contentEl.textContent = '...';
    contentEl.classList.add('v3-assistant-typing');
  }

  try {
    const result = await readAssistantStream(prompt, (partialText) => {
      if (contentEl) contentEl.textContent = partialText;
    });

    if (result.mode === 'confirmation_required' && result.confirmation_token) {
      pendingConfirmationToken = result.confirmation_token;
    } else {
      pendingConfirmationToken = '';
    }

    const formatted = formatAssistantReply(result);
    if (contentEl) {
      contentEl.textContent = formatted || result.reply || 'Selesai.';
      contentEl.classList.remove('v3-assistant-typing');
      contentEl.classList.add('v3-assistant-arrived');
      setTimeout(() => contentEl.classList.remove('v3-assistant-arrived'), 520);
    }
  } catch (err) {
    if (contentEl) {
      contentEl.classList.remove('v3-assistant-typing');
      contentEl.textContent = `Assistant error: ${err.message || 'unknown error'}`;
    }
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
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  try {
    const isAssistantCommand = text.startsWith('/ai ') || text.toLowerCase().startsWith('@assistant ') || text === '/confirm';
    if (isAssistantCommand) {
      await runAssistant(text);
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

  loadMessages();

  // Poll every 3 seconds
  pollingInterval = setInterval(loadMessages, 3000);
}

document.addEventListener('DOMContentLoaded', init);
// Cleanup poll on page hide? Not necessary for single page simple app
