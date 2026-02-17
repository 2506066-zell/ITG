(function applyPerformanceMode() {
  const STORAGE_KEY = 'performance_mode';

  function readPref() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value === 'lite' || value === 'full' || value === 'auto') return value;
    } catch {}
    return 'auto';
  }

  function writePref(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {}
  }

  function detectLite() {
    const memory = Number(navigator.deviceMemory || 0);
    const cores = Number(navigator.hardwareConcurrency || 0);
    const saveData = Boolean(navigator.connection && navigator.connection.saveData);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const smallViewport = window.matchMedia('(max-width: 430px)').matches;

    const weakDevice = (memory > 0 && memory <= 4) || (cores > 0 && cores <= 4);
    return reducedMotion || saveData || (smallViewport && weakDevice);
  }

  function decide(pref) {
    if (pref === 'lite') return true;
    if (pref === 'full') return false;
    return detectLite();
  }

  function apply(pref) {
    const lite = decide(pref);
    const root = document.documentElement;

    root.classList.toggle('perf-lite', lite);
    root.classList.toggle('perf-full', !lite);
    root.dataset.performance = lite ? 'lite' : 'full';
    root.dataset.performancePref = pref;

    window.__PERF_MODE__ = { lite, pref };
    return { lite, pref };
  }

  function setMode(nextPref) {
    const pref = nextPref === 'lite' || nextPref === 'full' || nextPref === 'auto' ? nextPref : 'auto';
    writePref(pref);
    const state = apply(pref);
    document.dispatchEvent(new CustomEvent('performance-mode-changed', { detail: state }));
    return state;
  }

  function getModeState() {
    const pref = readPref();
    const lite = decide(pref);
    return { lite, pref };
  }

  window.setPerformanceMode = setMode;
  window.getPerformanceModeState = getModeState;

  apply(readPref());
})();
