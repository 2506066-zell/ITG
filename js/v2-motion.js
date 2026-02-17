const REVEAL_SELECTOR = [
  '.card',
  '.report-card',
  '.goal-card',
  '.todo-card',
  '.day-card',
  '.memory-card',
  '.task-item',
  '.chat-msg',
  '.assistant-advice-box',
  '.filter-tab',
  '.filter-chip',
  '.tab-btn',
  '.user-tab'
].join(',');

const DYNAMIC_CONTAINER_SELECTOR = [
  '#task-list',
  '#goals-list',
  '#evals-list',
  '#memories-list',
  '#assignments-active',
  '#assignments-completed',
  '#schedule-container',
  '#todo-list',
  '#chat-messages',
  '#report-content'
].join(',');

function motionAllowed() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function markReveal(el, index = 0) {
  if (!el || el.dataset.v2Reveal === '1' || el.classList.contains('is-visible')) return;
  el.dataset.v2Reveal = '1';
  el.style.setProperty('--v2-stagger', `${Math.min(index, 14) * 48}ms`);
}

function setupReveals() {
  const candidates = Array.from(document.querySelectorAll(REVEAL_SELECTOR));
  candidates.forEach((el, idx) => markReveal(el, idx));

  if (!motionAllowed()) {
    candidates.forEach(el => el.classList.add('is-visible'));
    return;
  }

  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        obs.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: '0px 0px -8% 0px' }
  );

  candidates.forEach(el => obs.observe(el));

  return obs;
}

function setupDynamicReveal(observer) {
  const hostNodes = document.querySelectorAll(DYNAMIC_CONTAINER_SELECTOR);
  if (!hostNodes.length) return;

  const handleAddedNode = (node) => {
    if (!(node instanceof HTMLElement)) return;

    if (node.matches(REVEAL_SELECTOR)) {
      markReveal(node, 2);
      if (observer && motionAllowed()) observer.observe(node);
      else node.classList.add('is-visible');
    }

    node.querySelectorAll?.(REVEAL_SELECTOR).forEach((child, idx) => {
      markReveal(child, idx + 2);
      if (observer && motionAllowed()) observer.observe(child);
      else child.classList.add('is-visible');
    });
  };

  const mo = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach(handleAddedNode);
    });
  });

  hostNodes.forEach((host) => {
    mo.observe(host, { childList: true, subtree: true });
  });
}

function animateProgressBars() {
  const bars = document.querySelectorAll('.progress-fill, .progress-bar-fill, .cc-progress-fill, .cc-bar-fill');
  bars.forEach((bar) => {
    if (!(bar instanceof HTMLElement)) return;
    const target = bar.style.width;
    if (!target || target === '0%' || target === '0px') return;

    bar.style.width = '0%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        bar.style.width = target;
      });
    });
  });
}

function bindStatePulse() {
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('.btn, .filter-chip, .tab-btn, .user-tab, .nav-item, .task-check, .prio-btn, .tag-chip, .filter-tab') : null;
    if (!target || !(target instanceof HTMLElement)) return;
    target.classList.remove('v2-state-pulse');
    requestAnimationFrame(() => target.classList.add('v2-state-pulse'));
  });
}

function init() {
  const observer = setupReveals();
  setupDynamicReveal(observer);
  animateProgressBars();
  bindStatePulse();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
