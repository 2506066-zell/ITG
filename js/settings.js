import { initProtected, setTheme, logout, showToast } from './main.js';

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
document.addEventListener('DOMContentLoaded', init);
