let nudgeEl = null;
let nudgeTimer = null;

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pulseClass(el, className, duration = 600) {
  if (!el) return;
  el.classList.remove(className);
  requestAnimationFrame(() => {
    el.classList.add(className);
    window.setTimeout(() => el.classList.remove(className), duration);
  });
}

function ensureNudge() {
  if (nudgeEl) return nudgeEl;

  const wrap = document.createElement('div');
  wrap.className = 'v3-assistant-nudge';

  const title = document.createElement('strong');
  title.textContent = 'Assistant';
  wrap.appendChild(title);

  const text = document.createElement('span');
  text.className = 'v3-assistant-nudge-text';
  text.textContent = '';
  wrap.appendChild(text);

  document.body.appendChild(wrap);
  nudgeEl = wrap;
  return nudgeEl;
}

function showNudge(message) {
  if (!message) return;
  const el = ensureNudge();
  const textEl = el.querySelector('.v3-assistant-nudge-text');
  if (!textEl) return;

  textEl.textContent = ` ${message}`;
  el.classList.add('show');

  if (nudgeTimer) window.clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

function isCompletedRow(row) {
  if (!row) return false;
  if (row.classList.contains('task-item')) return row.classList.contains('completed');
  if (row.classList.contains('list-item')) {
    const check = row.querySelector('input[data-action="toggle"]');
    return !!(check && check.checked);
  }
  if (row.classList.contains('day-box')) {
    return row.classList.contains('completed') || row.dataset.completed === 'true';
  }
  return false;
}

function triggerCompletionFx(row, message) {
  if (!row) return;
  pulseClass(row, 'v3-complete-burst', 760);
  showNudge(message || 'Progress tercatat. Pertahankan momentum.');
}

function previewGoalProgress(slider) {
  if (!(slider instanceof HTMLInputElement)) return;
  const card = slider.closest('.goal-card');
  if (!card) return;

  const pct = Math.max(0, Math.min(100, Number(slider.value) || 0));
  const fill = card.querySelector('.progress-fill');
  const primaryMeta = card.querySelector('.goal-meta span');

  if (fill) fill.style.width = `${pct}%`;
  if (primaryMeta) primaryMeta.textContent = `${pct}% Complete`;

  pulseClass(card, 'v3-progress-glow', 540);
}

function bindClicks() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const moodPick = target.closest('#mood-grid .prio-btn, #mood-grid .mood-btn, #mood-grid .mood-btn-enhanced');
    if (moodPick) {
      pulseClass(moodPick, 'v3-mood-pop', 340);
      return;
    }

    const taskCheck = target.closest('.task-check');
    if (taskCheck) {
      const row = taskCheck.closest('.task-item');
      if (row) {
        window.setTimeout(() => {
          if (isCompletedRow(row)) triggerCompletionFx(row, 'Task selesai. Nova merekomendasikan lanjut quick-win.');
        }, 70);
      }
      return;
    }

    const dayBox = target.closest('.day-box.today');
    if (dayBox) {
      const wasDone = isCompletedRow(dayBox);
      window.setTimeout(() => {
        if (!wasDone && isCompletedRow(dayBox)) {
          triggerCompletionFx(dayBox, 'Habit hari ini terkunci. Konsistensi kamu naik.');
        }
      }, 450);
      return;
    }

    const refreshBtn = target.closest('#assistant-refresh');
    if (refreshBtn) {
      const feedCard = document.getElementById('assistant-feed-card');
      pulseClass(feedCard, 'v3-assistant-refresh', 1000);
      showNudge('Nova sedang menyusun briefing terbaru.');
    }
  });
}

function bindChanges() {
  document.addEventListener('change', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    if (target.matches('input[data-action="toggle"]')) {
      const row = target.closest('.list-item');
      if (row && target instanceof HTMLInputElement && target.checked) {
        triggerCompletionFx(row, 'Assignment selesai. Lanjutkan ke item prioritas berikutnya.');
      }
      return;
    }

    if (target.matches('#goals-list input[type="range"]')) {
      previewGoalProgress(target);
    }
  });

  document.addEventListener('input', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.matches('#goals-list input[type="range"]')) {
      previewGoalProgress(target);
    }
  });
}

function bindSubmits() {
  document.addEventListener('submit', (event) => {
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (!form) return;

    if (form.matches('#mood-form, #eval-form')) {
      const sheet = form.closest('.bottom-sheet');
      if (sheet) pulseClass(sheet, 'v3-mood-saved', 680);
      showNudge('Mood tersimpan. Insight akan disegarkan.');
    }
  });
}

function observeAssistantFeed() {
  const feed = document.getElementById('assistant-feed-list');
  if (!feed) return;

  const markItems = () => {
    const items = [...feed.querySelectorAll('.cc-feed-item')];
    items.forEach((item, idx) => {
      if (item.dataset.v3Feed === '1') return;
      item.dataset.v3Feed = '1';
      item.style.setProperty('--v3-feed-delay', `${idx * 65}ms`);
      item.classList.add('v3-feed-in');
    });
  };

  markItems();
  const obs = new MutationObserver(markItems);
  obs.observe(feed, { childList: true, subtree: false });
}

function observeChatAssistant() {
  const chat = document.getElementById('chat-messages');
  if (!chat) return;

  const mark = () => {
    chat.querySelectorAll('.assistant-bubble').forEach((node) => {
      if (node.dataset.v3Seen === '1') return;
      node.dataset.v3Seen = '1';
      pulseClass(node, 'v3-assistant-arrived', 520);
    });
  };

  mark();
  const obs = new MutationObserver(mark);
  obs.observe(chat, { childList: true, subtree: true, characterData: true });
}

function observeScheduleAdvice() {
  const text = document.getElementById('advice-text');
  const box = document.getElementById('assistant-box');
  if (!text || !box) return;

  let last = text.textContent || '';
  const obs = new MutationObserver(() => {
    const current = text.textContent || '';
    if (!current || current === last) return;
    last = current;
    pulseClass(box, 'v3-assistant-pulse', 620);
  });

  obs.observe(text, { childList: true, subtree: true, characterData: true });
}

function init() {
  bindClicks();
  bindChanges();
  bindSubmits();
  observeAssistantFeed();
  observeChatAssistant();
  observeScheduleAdvice();

  if (reducedMotion()) {
    document.documentElement.classList.add('v3-reduced-motion');
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
