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

    wrap.innerHTML = '';
    const currentUser = localStorage.getItem('user'); // Basic assumption

    msgs.forEach(m => {
      const el = document.createElement('div');
      const isMe = m.user_id === currentUser;
      el.className = `chat-msg ${isMe ? 'me' : ''}`;

      const time = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.innerHTML = `
        <div style="font-size:10px;opacity:0.6;margin-bottom:2px">${m.user_id} • ${time}</div>
        ${m.message}
      `;
      wrap.appendChild(el);
    });

    // Auto scroll if was at bottom or first load
    if (wasAtBottom || msgs.length && !pollingInterval) {
      wrap.scrollTop = wrap.scrollHeight;
    }
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
