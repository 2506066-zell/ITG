import { initProtected } from './main.js';
import { get, post, del } from './api.js';

let pollingInterval;

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

      el.innerHTML = `
        <div class="msg-meta">
          <span>${m.user_id}</span>
          <span>${time}</span>
        </div>
        <div class="bubble-content">
          ${m.message}
        </div>
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
    await post('/chat', { message: text });
    input.value = '';
    loadMessages(); // Immediate refresh
  } catch (err) {
    alert('Failed to send');
  }
  input.disabled = false;
  input.focus();
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
