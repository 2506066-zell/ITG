const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d');
let mouse = { x: null, y: null };
let stars = [];
let dusts = [];
let layers = [];
let nebulaCanvas = null;
let nebulaCtx = null;
let t = 0;
let scrollOffset = 0;
let meteors = [];
let nextMeteor = Date.now() + Math.floor((Math.random() * (16000 - 8000)) + 8000);
let onResize = null;
let onMouseMove = null;
let onMouseLeave = null;
let onScroll = null;
let rafId = null;
let bgImg = null;
let imgReady = false;
let imgData = null;
let planets = [];
let belt = [];
let focus = { x: 0.5, y: 0.5 };
let palette = ['#a4b8ff', '#8bb0ff', '#ffd1f7', '#ff95e0', '#bda3ff'];
let lastTime = performance.now();

function initParticles() {
  const isMobile = window.innerWidth < 768;
  const isLowPower = navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4;
  if (isMobile || isLowPower) return;
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.zIndex = '-1';
  canvas.style.pointerEvents = 'none';
  document.body.appendChild(canvas);
  resize();
  onResize = resize;
  onMouseMove = e => { mouse.x = e.x; mouse.y = e.y; };
  onMouseLeave = () => { mouse.x = null; mouse.y = null; };
  onScroll = () => { scrollOffset = (window.scrollY / window.innerHeight) * 40; };
  window.addEventListener('resize', onResize);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseleave', onMouseLeave);
  window.addEventListener('scroll', onScroll);
  onScroll();
  setupScene();
  animate();
  window.__galaxyCleanup = destroy;
  window.__galaxyLoaded = 1;
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  buildNebula();
}

function rnd(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function setupScene() {
  const starCounts = [110, 80, 50];
  const dustCount = 60;
  const colors = ['#a4b8ff', '#8bb0ff', '#ffd1f7', '#ff95e0', '#bda3ff'];
  const dustColors = ['rgba(255,149,224,0.15)','rgba(162,140,255,0.15)','rgba(255,190,120,0.12)'];
  layers = [
    { speed: 0.03, parallax: 0.02 },
    { speed: 0.05, parallax: 0.04 },
    { speed: 0.08, parallax: 0.06 }
  ];
  stars = [];
  layers.forEach((layer, li) => {
    for (let i = 0; i < starCounts[li]; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: rnd(-layer.speed, layer.speed),
        vy: rnd(-layer.speed, layer.speed),
        size: rnd(li === 2 ? 1.2 : 0.8, li === 2 ? 2.4 : 1.6),
        base: rnd(0.5, 0.9),
        phase: Math.random() * Math.PI * 2,
        color: pick(colors),
        layer: li
      });
    }
  });
  dusts = [];
  for (let i = 0; i < dustCount; i++) {
    dusts.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      vx: rnd(-0.02, 0.02),
      vy: rnd(-0.02, 0.02),
      r: rnd(6, 16),
      color: pick(dustColors)
    });
  }
}

function buildNebula() {
  nebulaCanvas = document.createElement('canvas');
  nebulaCtx = nebulaCanvas.getContext('2d');
  nebulaCanvas.width = canvas.width;
  nebulaCanvas.height = canvas.height;
  const g1 = nebulaCtx.createRadialGradient(canvas.width * 0.48, canvas.height * 0.38, 20, canvas.width * 0.48, canvas.height * 0.38, Math.max(canvas.width, canvas.height) * 0.6);
  g1.addColorStop(0.0, 'rgba(255,160,90,0.35)');
  g1.addColorStop(0.25, 'rgba(255,115,200,0.28)');
  g1.addColorStop(0.6, 'rgba(62,33,122,0.20)');
  g1.addColorStop(1.0, 'rgba(8,12,30,0)');
  nebulaCtx.fillStyle = g1;
  nebulaCtx.fillRect(0,0,nebulaCanvas.width,nebulaCanvas.height);
  const g2 = nebulaCtx.createRadialGradient(canvas.width * 0.22, canvas.height * 0.65, 10, canvas.width * 0.22, canvas.height * 0.65, Math.max(canvas.width, canvas.height) * 0.4);
  g2.addColorStop(0.0, 'rgba(140,120,255,0.22)');
  g2.addColorStop(0.7, 'rgba(20,24,50,0)');
  nebulaCtx.fillStyle = g2;
  nebulaCtx.fillRect(0,0,nebulaCanvas.width,nebulaCanvas.height);
}

function drawBackground() {
  if (imgReady) {
    const iw = bgImg.naturalWidth || bgImg.width;
    const ih = bgImg.naturalHeight || bgImg.height;
    const cw = canvas.width;
    const ch = canvas.height;
    const sr = iw / ih;
    const dr = cw / ch;
    let sw, sh, sx, sy;
    if (sr > dr) {
      sh = ih;
      sw = ih * dr;
      sx = (iw - sw) * 0.5;
      sy = 0;
    } else {
      sw = iw;
      sh = iw / dr;
      sx = 0;
      sy = (ih - sh) * 0.5;
    }
    ctx.drawImage(bgImg, sx, sy, sw, sh, 0, 0, cw, ch);
  } else {
    ctx.fillStyle = '#070b1d';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    if (nebulaCanvas) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(nebulaCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

function drawStars(dt) {
  const px = mouse.x != null ? (mouse.x - canvas.width / 2) : 0;
  const py = mouse.y != null ? (mouse.y - canvas.height / 2) : 0;
  stars.forEach(s => {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < -20) s.x = canvas.width + 20;
    if (s.x > canvas.width + 20) s.x = -20;
    if (s.y < -20) s.y = canvas.height + 20;
    if (s.y > canvas.height + 20) s.y = -20;
    const tw = s.base * (0.6 + 0.4 * Math.sin(t * 0.002 + s.phase));
    const ox = px * layers[s.layer].parallax;
    const oy = (py + scrollOffset) * layers[s.layer].parallax;
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 8;
    ctx.fillStyle = s.color;
    ctx.globalAlpha = tw;
    ctx.beginPath();
    ctx.arc(s.x + ox, s.y + oy, s.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  });
}

function drawDust(dt) {
  ctx.globalCompositeOperation = 'lighter';
  dusts.forEach(d => {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    if (d.x < -30) d.x = canvas.width + 30;
    if (d.x > canvas.width + 30) d.x = -30;
    if (d.y < -30) d.y = canvas.height + 30;
    if (d.y > canvas.height + 30) d.y = -30;
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

function buildPlanetsFromConfig(cfg) {
  planets = [];
  const cw = Math.max(1, canvas.width);
  const ch = Math.max(1, canvas.height);
  cfg.forEach((p, idx) => {
    const xNorm = (parseFloat(p.x) || 0);
    const yNorm = (parseFloat(p.y) || 0);
    const zNorm = (parseFloat(p.z) || 0);
    const cx = (xNorm + 1) / 2;
    const cy = (yNorm + 1) / 2;
    const depth = (zNorm + 1) / 2;
    const blur = Math.max(0, depth * 3);
    const par = 0.02 + (1 - depth) * 0.06;
    const baseSize = p.size ? +p.size : 0.08;
    const size = baseSize * (1 - depth * 0.4);
    const speed = 0.02 + idx * 0.01;
    const orbit = p.locked ? 0 : 14 + idx * 10;
    planets.push({
      cx, cy, size, speed,
      rot: Math.random() * Math.PI * 2,
      par, blur,
      glow: 0.3 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
      orbit,
      col: p.color || '#a4b8ff',
      orbitRFrac: 0.06 + idx * 0.03,
      orbitAngle: Math.random() * Math.PI * 2,
      orbitSpeed: 0.35 / Math.pow(0.06 + idx * 0.03, 1.5),
      rotationAngle: Math.random() * Math.PI * 2,
      rotationSpeed: 0.6 + (1 - (0.06 + idx * 0.03)) * 0.8
    });
    if (p.locked) {
      planets[planets.length - 1].orbitSpeed = 0;
      planets[planets.length - 1].rotationSpeed = 0;
    }
  });
}
function loadBackground() {
  bgImg = new Image();
  bgImg.src = 'Space.jpg';
  bgImg.onload = () => {
    imgReady = true;
    analyzeImage();
    const useLocked = localStorage.getItem('use_locked_planets') === 'true';
    const cfgRaw = localStorage.getItem('planet_positions');
    if (useLocked && cfgRaw) {
      try {
        const cfg = JSON.parse(cfgRaw);
        buildPlanetsFromConfig(cfg);
      } catch (_) {
        buildPlanets();
      }
    } else {
      buildPlanets();
    }
    buildBelt();
  };
}

function analyzeImage() {
  const w = Math.max(1, Math.min(1280, canvas.width));
  const h = Math.max(1, Math.min(720, canvas.height));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(bgImg, 0, 0, w, h);
  imgData = tctx.getImageData(0, 0, w, h);
  let maxB = 0;
  let fx = w * 0.5, fy = h * 0.5;
  for (let y = 0; y < h; y += 32) {
    for (let x = 0; x < w; x += 32) {
      const i = (y * w + x) * 4;
      const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2];
      const lum = (r*0.2126 + g*0.7152 + b*0.0722);
      if (lum > maxB) { maxB = lum; fx = x; fy = y; }
    }
  }
  focus = { x: fx / w, y: fy / h };
  const cols = {};
  for (let y = 0; y < h; y += 24) {
    for (let x = 0; x < w; x += 24) {
      const i = (y * w + x) * 4;
      const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2];
      const key = `${Math.round(r/32)}_${Math.round(g/32)}_${Math.round(b/32)}`;
      cols[key] = [r,g,b];
    }
  }
  const keys = Object.keys(cols).slice(0, 5);
  palette = keys.map(k => {
    const c = cols[k];
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  });
}

function buildPlanets() {
  if (!imgData) return;
  const w = imgData.width;
  const h = imgData.height;
  const found = [];
  for (let y = 40; y < h-40; y += 40) {
    for (let x = 40; x < w-40; x += 40) {
      const i = (y * w + x) * 4;
      const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2];
      const lum = (r*0.2126 + g*0.7152 + b*0.0722);
      if (lum > 170) found.push({ x, y, lum });
    }
  }
  found.sort((a,b) => b.lum - a.lum);
  const sel = [];
  found.forEach(p => {
    if (!sel.some(s => Math.hypot(s.x-p.x, s.y-p.y) < 80)) sel.push(p);
  });
  planets = sel.slice(0, 6).map((p, idx) => {
    let r = 30;
    for (let rr = 20; rr < 180; rr += 8) {
      let sum = 0, cnt = 0;
      for (let a = 0; a < 360; a += 45) {
        const xx = Math.round(p.x + Math.cos(a*Math.PI/180)*rr);
        const yy = Math.round(p.y + Math.sin(a*Math.PI/180)*rr);
        if (xx>=0 && yy>=0 && xx<w && yy<h) {
          const ii = (yy*w+xx)*4;
          const rr2 = imgData.data[ii], gg2 = imgData.data[ii+1], bb2 = imgData.data[ii+2];
          sum += (rr2*0.2126 + gg2*0.7152 + bb2*0.0722);
          cnt++;
        }
      }
      const avg = cnt ? sum/cnt : 0;
      if (avg < 90) { r = rr; break; }
    }
    const cx = p.x / w;
    const cy = p.y / h;
    const size = r / Math.max(w,h);
    const speed = 0.02 + idx*0.01;
    const rot = Math.random()*Math.PI*2;
    const par = 0.02 + idx*0.01;
    const blur = idx<2 ? 0 : idx<4 ? 1.5 : 3;
    const glow = 0.3 + Math.random()*0.4;
    const col = palette[idx % palette.length];
    const orbitRFrac = 0.06 + idx * 0.03;
    const orbitAngle = Math.random() * Math.PI * 2;
    const baseOrbitVel = 0.35;
    const orbitSpeed = baseOrbitVel / Math.pow(orbitRFrac, 1.5);
    const rotationAngle = Math.random() * Math.PI * 2;
    const rotationSpeed = 0.6 + (1 - orbitRFrac) * 0.8;
    return { cx, cy, size, speed, rot, par, blur, glow, phase: Math.random()*Math.PI*2, orbit: 20+idx*12, col, orbitRFrac, orbitAngle, orbitSpeed, rotationAngle, rotationSpeed };
  });
}

function buildBelt() {
  belt = [];
  const count = 90;
  const cx = focus.x;
  const cy = focus.y;
  for (let i = 0; i < count; i++) {
    const a = Math.random()*Math.PI*2;
    const r = 0.18 + Math.random()*0.05;
    const s = 0.3 + Math.random()*0.2;
    belt.push({ a, r, s, size: 1+Math.random()*2, phase: Math.random()*Math.PI*2 });
  }
}

function drawPlanets(dt) {
  const cw = canvas.width;
  const ch = canvas.height;
  const px = mouse.x != null ? (mouse.x - cw/2) : 0;
  const py = mouse.y != null ? (mouse.y - ch/2) : 0;
  const cxFocus = focus.x * cw;
  const cyFocus = focus.y * ch;
  planets.forEach((pl, idx) => {
    const minDim = Math.min(cw, ch);
    const rPx = pl.orbitRFrac * minDim;
    const ox = px * pl.par;
    const oy = (py + scrollOffset) * pl.par;
    const x = cxFocus + Math.cos(pl.orbitAngle) * rPx + ox;
    const y = cyFocus + Math.sin(pl.orbitAngle) * rPx + oy;
    const rad = pl.size * minDim * 1.2;
    ctx.save();
    if (pl.blur > 0) ctx.filter = `blur(${pl.blur}px)`;
    const g = ctx.createRadialGradient(x, y, rad*0.1, x, y, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.3, pl.col || palette[idx%palette.length]);
    g.addColorStop(1, 'rgba(10,12,32,0.0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI*2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.restore();
    const glowA = pl.glow * (0.6 + 0.4*Math.sin(t*0.002 + pl.phase));
    ctx.globalAlpha = glowA;
    ctx.strokeStyle = palette[idx%palette.length];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, rad*1.1, 0, Math.PI*2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const markR = rad * 0.85;
    const mx = x + Math.cos(pl.rotationAngle) * markR;
    const my = y + Math.sin(pl.rotationAngle) * markR;
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(mx, my, Math.max(1.5, rad * 0.05), 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawBelt(dt) {
  const cw = canvas.width;
  const ch = canvas.height;
  const cx = focus.x*cw;
  const cy = focus.y*ch;
  ctx.globalCompositeOperation = 'source-over';
  belt.forEach(b => {
    b.a += 0.0006 * (1 + Math.sin(b.phase));
    const rx = b.r * Math.min(cw,ch);
    const ry = rx * 0.6;
    const x = cx + Math.cos(b.a)*rx;
    const y = cy + Math.sin(b.a)*ry;
    ctx.fillStyle = 'rgba(200,180,160,0.6)';
    ctx.beginPath();
    ctx.arc(x, y, b.size, 0, Math.PI*2);
    ctx.fill();
  });
}

function drawFlare(dt) {
  if (!imgReady) return;
  const cw = canvas.width;
  const ch = canvas.height;
  const x = focus.x*cw;
  const y = focus.y*ch;
  const g = ctx.createRadialGradient(x, y, 10, x, y, Math.max(cw,ch)*0.6);
  g.addColorStop(0, 'rgba(255,255,200,0.14)');
  g.addColorStop(0.4, 'rgba(255,180,160,0.08)');
  g.addColorStop(1, 'rgba(10,12,32,0)');
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = g;
  ctx.fillRect(0,0,cw,ch);
  ctx.globalCompositeOperation = 'source-over';
}
function spawnMeteor() {
  const left = Math.random() < 0.5;
  const x = left ? -100 : canvas.width + 100;
  const y = Math.random() * canvas.height * 0.5;
  const speed = 2 + Math.random() * 1.2;
  const vx = left ? speed : -speed;
  const vy = speed * (0.5 + Math.random() * 0.4);
  const len = 40 + Math.random() * 40;
  const life = 1000 + Math.random() * 800;
  meteors.push({ x, y, vx, vy, len, life });
  if (meteors.length > 2) meteors.shift();
}

function drawMeteors(dt) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.life -= 16;
    const ex = m.x - m.vx * m.len;
    const ey = m.y - m.vy * m.len;
    const g = ctx.createLinearGradient(m.x, m.y, ex, ey);
    g.addColorStop(0, 'rgba(255,200,150,0.85)');
    g.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = g;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    if (m.life <= 0) meteors.splice(i, 1);
  }
}

function animate() {
  const now = performance.now();
  const dt = Math.min(33, now - lastTime);
  lastTime = now;
  t += dt;
  drawBackground();
  drawDust(1);
  drawStars(dt * 0.06);
  updatePlanets(dt);
  drawPlanets(dt);
  drawBelt(dt);
  drawFlare(dt);
  const now2 = Date.now();
  if (now2 > nextMeteor) {
    spawnMeteor();
    nextMeteor = now2 + Math.floor((Math.random() * (16000 - 8000)) + 8000);
  }
  drawMeteors(1);
  rafId = requestAnimationFrame(animate);
}

initParticles();

function destroy() {
  try {
    if (onResize) window.removeEventListener('resize', onResize);
    if (onMouseMove) window.removeEventListener('mousemove', onMouseMove);
    if (onMouseLeave) window.removeEventListener('mouseleave', onMouseLeave);
    if (onScroll) window.removeEventListener('scroll', onScroll);
    if (rafId) cancelAnimationFrame(rafId);
    const c = canvas;
    if (c && c.parentNode) c.parentNode.removeChild(c);
  } catch (_) {}
}

function updatePlanets(dt) {
  const step = dt * 0.001;
  planets.forEach(pl => {
    pl.orbitAngle += pl.orbitSpeed * step;
    pl.rotationAngle += pl.rotationSpeed * step;
  });
}
