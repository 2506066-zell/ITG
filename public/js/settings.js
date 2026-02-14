import { initProtected, setTheme, logout, showToast, setGalaxyEnabled } from './main.js';

function init() {
  initProtected();
  const current = localStorage.getItem('theme') || 'dark';
  const select = document.querySelector('#theme-select');
  select.value = current;
  select.addEventListener('change', e => setTheme(e.target.value));
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

  const galaxyToggle = document.getElementById('galaxy-toggle');
  if (galaxyToggle) {
    const pref = localStorage.getItem('galaxy_enabled');
    galaxyToggle.checked = pref === null ? true : pref === 'true';
    galaxyToggle.addEventListener('change', e => {
      const on = e.target.checked;
      setGalaxyEnabled(on);
      showToast(on ? 'Galaxy background aktif' : 'Galaxy background nonaktif', on ? 'success' : 'info');
    });
  }
  
  initSpace3D();
}
document.addEventListener('DOMContentLoaded', init);

function initSpace3D() {
  const wrap = document.getElementById('space3d-wrap');
  const canvas = document.getElementById('space3d-canvas');
  const fpsEl = document.getElementById('space3d-fps');
  const addBtn = document.getElementById('space3d-add');
  const exportBtn = document.getElementById('space3d-export');
  const importBtn = document.getElementById('space3d-import-btn');
  const importInput = document.getElementById('space3d-import');
  const saveBtn = document.getElementById('space3d-save');
  const resetBtn = document.getElementById('space3d-reset');
  const applyToggle = document.getElementById('space3d-apply');
  const listEl = document.getElementById('space3d-list');
  if (!wrap || !canvas || !fpsEl || !addBtn || !exportBtn || !importBtn || !importInput || !listEl) return;
  const ctx = canvas.getContext('2d');
  const state = {
    cam: { yaw: 0, pitch: 0, dist: 2.5, fov: 600 },
    planets: [],
    selected: null,
    dragging: null,
    lastTime: performance.now(),
    fpsTime: 0,
    fpsCount: 0,
    fps: 0,
    bg: null,
    imgReady: false
  };
  function resize() {
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(r.width));
    canvas.height = Math.max(240, Math.floor(r.height));
  }
  function loadBG() {
    const img = new Image();
    img.src = 'Space.jpg';
    img.onload = () => { state.bg = img; state.imgReady = true; };
  }
  function addPlanet() {
    const id = 'p' + Math.random().toString(36).slice(2, 7);
    const p = {
      id,
      name: 'Planet ' + (state.planets.length + 1),
      x: +(Math.random() * 2 - 1).toFixed(6),
      y: +(Math.random() * 2 - 1).toFixed(6),
      z: +(Math.random() * 2 - 1).toFixed(6),
      locked: false,
      color: `hsl(${Math.floor(Math.random()*360)},70%,60%)`,
      size: 0.08,
      orbitAngle: Math.random() * Math.PI * 2,
      rotationAngle: Math.random() * Math.PI * 2,
      orbitRadius: 0.6,
      orbitSpeed: 0.4,
      rotationSpeed: 0.8
    };
    const r = Math.max(0.15, Math.min(1.2, Math.hypot(p.x, p.y)));
    p.orbitRadius = r;
    p.orbitSpeed = 0.7 / Math.pow(r, 1.5);
    p.rotationSpeed = 0.6 + (1.2 - r) * 0.4;
    state.planets.push(p);
    state.selected = p.id;
    renderList();
  }
  function project(x, y, z) {
    const cy = state.cam.yaw;
    const cp = state.cam.pitch;
    const cosY = Math.cos(cy), sinY = Math.sin(cy);
    const x1 = cosY * x + sinY * z;
    const z1 = -sinY * x + cosY * z;
    const cosP = Math.cos(cp), sinP = Math.sin(cp);
    const y2 = cosP * y - sinP * z1;
    const z2 = sinP * y + cosP * z1;
    const d = z2 + state.cam.dist;
    const s = state.cam.fov / Math.max(0.000001, d);
    const cx = canvas.width / 2;
    const cy2 = canvas.height / 2;
    return { x: cx + x1 * s, y: cy2 - y2 * s, s, d };
  }
  function drawBG() {
    if (state.imgReady && state.bg) {
      const iw = state.bg.naturalWidth || state.bg.width;
      const ih = state.bg.naturalHeight || state.bg.height;
      const cw = canvas.width, ch = canvas.height;
      const sr = iw / ih, dr = cw / ch;
      let sw, sh, sx, sy;
      if (sr > dr) { sh = ih; sw = ih * dr; sx = (iw - sw) * 0.5; sy = 0; }
      else { sw = iw; sh = iw / dr; sx = 0; sy = (ih - sh) * 0.5; }
      ctx.drawImage(state.bg, sx, sy, sw, sh, 0, 0, cw, ch);
    } else {
      ctx.fillStyle = '#070b1d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }
  function renderList() {
    listEl.innerHTML = '';
    state.planets.forEach(p => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'auto 80px 100px 100px 100px';
      row.style.gap = '8px';
      const name = document.createElement('div');
      name.textContent = p.name;
      const lock = document.createElement('input');
      lock.type = 'checkbox';
      lock.checked = p.locked;
      lock.addEventListener('change', () => { p.locked = lock.checked; });
      const ix = document.createElement('input');
      ix.type = 'number'; ix.step = '0.000001'; ix.value = p.x.toFixed(6);
      ix.addEventListener('change', () => { p.x = +parseFloat(ix.value).toFixed(6); });
      const iy = document.createElement('input');
      iy.type = 'number'; iy.step = '0.000001'; iy.value = p.y.toFixed(6);
      iy.addEventListener('change', () => { p.y = +parseFloat(iy.value).toFixed(6); });
      const iz = document.createElement('input');
      iz.type = 'number'; iz.step = '0.000001'; iz.value = p.z.toFixed(6);
      iz.addEventListener('change', () => { p.z = +parseFloat(iz.value).toFixed(6); });
      row.appendChild(name);
      row.appendChild(lock);
      row.appendChild(ix);
      row.appendChild(iy);
      row.appendChild(iz);
      row.addEventListener('click', () => { state.selected = p.id; });
      listEl.appendChild(row);
    });
  }
  function exportPlanets() {
    const payload = state.planets.map(p => ({
      id: p.id,
      name: p.name,
      x: p.x.toFixed(6),
      y: p.y.toFixed(6),
      z: p.z.toFixed(6),
      locked: p.locked,
      color: p.color,
      size: p.size
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'planet_positions.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);
  }
  function importPlanets(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data)) return;
        state.planets = data.map(d => ({
          id: d.id || ('p' + Math.random().toString(36).slice(2,7)),
          name: d.name || 'Planet',
          x: +parseFloat(d.x).toFixed(6),
          y: +parseFloat(d.y).toFixed(6),
          z: +parseFloat(d.z).toFixed(6),
          locked: !!d.locked,
          color: d.color || `hsl(${Math.floor(Math.random()*360)},70%,60%)`,
          size: d.size ? +d.size : 0.08
        }));
        renderList();
      } catch (_) {}
    };
    reader.readAsText(file);
  }
  let dragStart = null;
  let dragMode = null;
  canvas.addEventListener('mousedown', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit = null;
    const sorted = [...state.planets].sort((a,b) => (a.z - b.z));
    for (let i = 0; i < sorted.length; i++) {
      const p = sorted[i];
      const pr = project(p.x, p.y, p.z);
      const r = Math.max(6, p.size * pr.s);
      if (Math.hypot(mx - pr.x, my - pr.y) <= r + 4) { hit = p; break; }
    }
    if (hit) {
      state.selected = hit.id;
      dragMode = 'planet';
    } else {
      dragMode = 'cam';
    }
    dragStart = { x: mx, y: my };
  });
  window.addEventListener('mousemove', e => {
    if (!dragStart) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - dragStart.x;
    const dy = my - dragStart.y;
    if (dragMode === 'cam') {
      state.cam.yaw += dx * 0.005;
      state.cam.pitch += dy * 0.005;
      if (state.cam.pitch > Math.PI/2) state.cam.pitch = Math.PI/2;
      if (state.cam.pitch < -Math.PI/2) state.cam.pitch = -Math.PI/2;
    } else if (dragMode === 'planet' && state.selected) {
      const p = state.planets.find(pp => pp.id === state.selected);
      if (p) {
        const scale = 2 / canvas.width;
        p.x = +(p.x + dx * scale).toFixed(6);
        p.y = +(p.y - dy * scale).toFixed(6);
        p.orbitRadius = Math.max(0.15, Math.min(1.2, Math.hypot(p.x, p.y)));
        p.orbitSpeed = 0.7 / Math.pow(p.orbitRadius, 1.5);
        p.rotationSpeed = 0.6 + (1.2 - p.orbitRadius) * 0.4;
      }
    }
    dragStart = { x: mx, y: my };
  });
  window.addEventListener('mouseup', () => { dragStart = null; dragMode = null; });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    state.cam.dist = Math.max(0.5, Math.min(6, state.cam.dist + (e.deltaY > 0 ? 0.1 : -0.1)));
  }, { passive: false });
  addBtn.addEventListener('click', addPlanet);
  exportBtn.addEventListener('click', exportPlanets);
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) importPlanets(f);
  });
  function update(dt) {
    const step = dt * 0.001;
    state.planets.forEach(p => {
      if (!p.locked) {
        p.orbitAngle += p.orbitSpeed * step;
        p.rotationAngle += p.rotationSpeed * step;
        const r = p.orbitRadius;
        const nx = Math.cos(p.orbitAngle) * r;
        const ny = Math.sin(p.orbitAngle) * r;
        p.x = +nx.toFixed(6);
        p.y = +ny.toFixed(6);
      }
    });
  }
  function draw() {
    drawBG();
    const sorted = [...state.planets].sort((a,b) => a.z - b.z);
    sorted.forEach(p => {
      const pr = project(p.x, p.y, p.z);
      const r = Math.max(6, p.size * pr.s);
      ctx.save();
      const blur = Math.max(0, (p.z + state.cam.dist) * 0.1);
      if (blur > 0.1) ctx.filter = `blur(${Math.min(4, blur)}px)`;
      const g = ctx.createRadialGradient(pr.x, pr.y, r*0.2, pr.x, pr.y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.9)');
      g.addColorStop(0.3, p.color);
      g.addColorStop(1, 'rgba(8,10,28,0)');
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, r, 0, Math.PI*2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.filter = 'none';
      if (state.selected === p.id) {
        ctx.strokeStyle = p.locked ? '#34d399' : '#a1b5ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(pr.x, pr.y, r+4, 0, Math.PI*2);
        ctx.stroke();
      }
      ctx.restore();
      const glowA = 0.5 + 0.5*Math.sin(performance.now()*0.002);
      ctx.globalAlpha = glowA;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pr.x, pr.y, r*1.08, 0, Math.PI*2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }
  function loop() {
    const now = performance.now();
    const dt = now - state.lastTime;
    state.lastTime = now;
    update(dt);
    draw();
    state.fpsTime += dt;
    state.fpsCount++;
    if (state.fpsTime >= 500) {
      state.fps = Math.round((state.fpsCount / state.fpsTime) * 1000);
      fpsEl.textContent = 'FPS: ' + state.fps;
      state.fpsTime = 0;
      state.fpsCount = 0;
    }
    requestAnimationFrame(loop);
  }
  resize();
  loadBG();
  const stored = localStorage.getItem('planet_positions');
  if (stored) {
    try {
      const data = JSON.parse(stored);
      if (Array.isArray(data)) {
        state.planets = data.map(d => ({
          id: d.id || ('p' + Math.random().toString(36).slice(2,7)),
          name: d.name || 'Planet',
          x: +parseFloat(d.x).toFixed(6),
          y: +parseFloat(d.y).toFixed(6),
          z: +parseFloat(d.z).toFixed(6),
          locked: !!d.locked,
          color: d.color || `hsl(${Math.floor(Math.random()*360)},70%,60%)`,
          size: d.size ? +d.size : 0.08
        }));
      } else {
        addPlanet(); addPlanet();
      }
    } catch (_) { addPlanet(); addPlanet(); }
  } else {
    addPlanet(); addPlanet();
  }
  renderList();
  const useLocked = localStorage.getItem('use_locked_planets');
  if (applyToggle) applyToggle.checked = useLocked === 'true';
  applyToggle && applyToggle.addEventListener('change', e => {
    localStorage.setItem('use_locked_planets', e.target.checked ? 'true' : 'false');
    showToast(e.target.checked ? 'Menggunakan posisi planet terkunci' : 'Menggunakan scene default', e.target.checked ? 'success' : 'info');
  });
  saveBtn && saveBtn.addEventListener('click', () => {
    const payload = state.planets.map(p => ({
      id: p.id, name: p.name,
      x: p.x.toFixed(6), y: p.y.toFixed(6), z: p.z.toFixed(6),
      locked: p.locked, color: p.color, size: p.size
    }));
    localStorage.setItem('planet_positions', JSON.stringify(payload));
    showToast('Konfigurasi planet disimpan', 'success');
  });
  resetBtn && resetBtn.addEventListener('click', () => {
    state.planets = [];
    addPlanet(); addPlanet();
    renderList();
    showToast('Konfigurasi planet direset', 'info');
  });
  window.addEventListener('resize', resize);
  requestAnimationFrame(loop);
}
