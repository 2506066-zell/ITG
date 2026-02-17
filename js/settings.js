import { initProtected, setTheme, logout, showToast } from './main.js';

const LMS_URL_KEY = 'college_lms_url';
const DEFAULT_LMS_URL = 'https://elearning.itg.ac.id/student_area/tugas/index';

function init() {
  initProtected();
  const current = localStorage.getItem('theme') || 'dark';
  const select = document.querySelector('#theme-select');
  select.value = current;
  select.addEventListener('change', e => setTheme(e.target.value));
  const perfSelect = document.querySelector('#performance-select');
  const perfNote = document.querySelector('#performance-note');
  const modeLabel = (pref) => {
    if (pref === 'lite') return 'Battery Saver';
    if (pref === 'full') return 'Max Visual';
    return 'Auto';
  };
  const syncPerfUI = (state) => {
    const resolved = state || (window.getPerformanceModeState ? window.getPerformanceModeState() : { pref: 'auto', lite: false });
    if (perfSelect) perfSelect.value = resolved.pref;
    if (perfNote) perfNote.textContent = `Mode: ${modeLabel(resolved.pref)} - Active: ${resolved.lite ? 'Lite' : 'Full'}`;
  };
  syncPerfUI();
  perfSelect?.addEventListener('change', (e) => {
    const pref = e.target.value;
    if (window.setPerformanceMode) {
      const state = window.setPerformanceMode(pref);
      syncPerfUI(state);
      showToast(`Performance set to ${modeLabel(pref)}`, 'success');
    } else {
      showToast('Performance mode engine unavailable', 'error');
    }
  });
  document.addEventListener('performance-mode-changed', (e) => syncPerfUI(e.detail));
  document.querySelector('#logout-btn').addEventListener('click', logout);
  initLmsSettings();

  // Install Button Logic
  const installBtn = document.getElementById('install-btn');
  
  const showInstallBtn = () => {
    if (window.deferredPrompt) {
      installBtn.style.display = 'block';
      console.log('PWA Install Button Shown');
    }
  };

  showInstallBtn();
  document.addEventListener('pwa-installable', showInstallBtn);

  installBtn.addEventListener('click', async () => {
    console.log('Install button clicked');
    if (!window.deferredPrompt) {
      showToast('Installation not available', 'error');
      return;
    }
    
    // Add loading state
    const originalText = installBtn.innerHTML;
    installBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Installing...';
    installBtn.disabled = true;

    try {
      window.deferredPrompt.prompt();
      const { outcome } = await window.deferredPrompt.userChoice;
      console.log(`User response to the install prompt: ${outcome}`);
      
      if (outcome === 'accepted') {
        installBtn.style.display = 'none';
        showToast('App installed successfully!', 'success');
      } else {
        showToast('Installation cancelled', 'info');
      }
    } catch (err) {
      console.error('Install prompt failed:', err);
      showToast('Installation failed. Try from browser menu.', 'error');
    } finally {
      window.deferredPrompt = null;
      installBtn.innerHTML = originalText;
      installBtn.disabled = false;
    }
  });
}

function normalizeLmsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return DEFAULT_LMS_URL;
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('invalid protocol');
  }
  return parsed.toString();
}

function openLmsUrl(url) {
  let opened = null;
  try {
    opened = window.open(url, '_blank', 'noopener,noreferrer');
  } catch {}
  if (opened && typeof opened.focus === 'function') {
    opened.focus();
    return;
  }
  // Fallback for mobile/PWA when popup is blocked.
  window.location.assign(url);
}

function initLmsSettings() {
  const input = document.getElementById('lms-url-input');
  const saveBtn = document.getElementById('save-lms-btn');
  const openBtn = document.getElementById('open-lms-settings-btn');
  if (!input || !saveBtn || !openBtn) return;

  const current = localStorage.getItem(LMS_URL_KEY) || DEFAULT_LMS_URL;
  input.value = current;

  saveBtn.addEventListener('click', () => {
    try {
      const normalized = normalizeLmsUrl(input.value || DEFAULT_LMS_URL);
      localStorage.setItem(LMS_URL_KEY, normalized);
      input.value = normalized;
      showToast('URL LMS tersimpan', 'success');
    } catch {
      showToast('URL LMS tidak valid', 'error');
    }
  });

  openBtn.addEventListener('click', () => {
    try {
      const url = normalizeLmsUrl(input.value || DEFAULT_LMS_URL);
      openLmsUrl(url);
    } catch {
      showToast('URL LMS tidak valid', 'error');
    }
  });
}
document.addEventListener('DOMContentLoaded', init);
