import { initProtected } from './main.js';
const KEY = 'cf_chat';
function getData() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function setData(d) { localStorage.setItem(KEY, JSON.stringify(d)); }
function render() {
  const msgs = getData();
  const wrap = document.querySelector('#chat-messages');
  wrap.innerHTML = '';
  msgs.forEach(m => {
    const el = document.createElement('div');
    el.className = 'chat-msg me';
    el.textContent = `${new Date(m.ts).toLocaleTimeString()} • ${m.text}`;
    wrap.appendChild(el);
  });
  wrap.scrollTop = wrap.scrollHeight;
}
function send(e) {
  e.preventDefault();
  const input = document.querySelector('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  const msgs = getData();
  msgs.push({ text, ts: Date.now(), me: true });
  setData(msgs);
  input.value = '';
  render();
}
function clearAll() {
  setData([]);
  render();
}
function init() {
  initProtected();
  document.querySelector('#chat-form').addEventListener('submit', send);
  document.querySelector('#chat-clear').addEventListener('click', clearAll);
  render();
}
document.addEventListener('DOMContentLoaded', init);
