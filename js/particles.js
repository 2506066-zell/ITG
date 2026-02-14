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
let nextMeteor = Date.now() + Math.floor((Math.random() * (3500 - 1500)) + 1500);
let comets = [];
let satellites = [];
let debris = [];
let nextComet = Date.now() + Math.floor((Math.random() * (7000 - 4000)) + 4000);
let nextDebris = Date.now() + Math.floor((Math.random() * (2500 - 1000)) + 1000);
let lastTime = performance.now();
let gas = [];
let pulsar = null;
let blackHole = null;
let shockwaves = [];
let sparks = [];

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
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', e => { mouse.x = e.x; mouse.y = e.y; });
  window.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });
  const updateScroll = () => { scrollOffset = (window.scrollY / window.innerHeight) * 40; };
  window.addEventListener('scroll', updateScroll);
  updateScroll();
  setupScene();
  animate();
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
  satellites = [];
  const nSat = 6;
  const minDim = Math.min(canvas.width, canvas.height);
  for (let i = 0; i < nSat; i++) {
    const r = (0.15 + Math.random() * 0.35) * minDim;
    const a = Math.random() * Math.PI * 2;
    const s = 0.08 / Math.pow(r / minDim, 1.2);
    satellites.push({ r, a, s, size: 2 + Math.random() * 3, phase: Math.random() * Math.PI * 2 });
  }
  gas = [];
  for (let i = 0; i < 5; i++) {
    gas.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      rx: rnd(minDim * 0.15, minDim * 0.35),
      ry: rnd(minDim * 0.12, minDim * 0.30),
      vx: rnd(-0.02, 0.02),
      vy: rnd(-0.02, 0.02),
      hue: Math.floor(Math.random() * 360),
      alpha: rnd(0.12, 0.25),
      pulse: rnd(0.8, 1.2),
      phase: Math.random() * Math.PI * 2,
      sw: 0
    });
  }
  pulsar = {
    x: canvas.width * 0.78,
    y: canvas.height * 0.26,
    phase: 0,
    speed: 0.002,
    beam: 0,
    beamSpeed: 0.003
  };
  blackHole = {
    x: canvas.width * 0.52,
    y: canvas.height * 0.58,
    r: minDim * 0.06,
    diskInner: minDim * 0.09,
    diskOuter: minDim * 0.16,
    spin: Math.random() * Math.PI * 2,
    spinSpeed: 0.0018
  };
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
  ctx.fillStyle = '#070b1d';
  ctx.fillRect(0,0,canvas.width,canvas.height);
  if (nebulaCanvas) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(nebulaCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
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
    const twBase = s.base * (0.6 + 0.4 * Math.sin(t * 0.002 + s.phase));
    const ox = px * layers[s.layer].parallax;
    const oy = (py + scrollOffset) * layers[s.layer].parallax;
    const mx = mouse.x != null ? mouse.x : -99999;
    const my = mouse.y != null ? mouse.y : -99999;
    const dx = (s.x + ox) - mx;
    const dy = (s.y + oy) - my;
    const hv = Math.max(0, 1 - (dx * dx + dy * dy) / (140 * 140));
    const tw = twBase * (1 + hv * 0.9);
    ctx.shadowColor = s.color;
    ctx.shadowBlur = 8 + hv * 10;
    ctx.fillStyle = s.color;
    ctx.globalAlpha = tw;
    ctx.beginPath();
    ctx.arc(s.x + ox, s.y + oy, s.size * (1 + hv * 0.6), 0, Math.PI * 2);
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

function spawnMeteor() {
  const left = Math.random() < 0.5;
  const x = left ? -100 : canvas.width + 100;
  const y = Math.random() * canvas.height * 0.8;
  const speed = 1.6 + Math.random() * 2.0;
  const vx = left ? speed : -speed;
  const vy = speed * (0.4 + Math.random() * 0.8);
  const len = 24 + Math.random() * 64;
  const life = 1200 + Math.random() * 1400;
  meteors.push({ x, y, vx, vy, len, life });
  if (meteors.length > 24) meteors.splice(0, meteors.length - 24);
}

function drawMeteors(dt) {
  for (let i = meteors.length - 1; i >= 0; i--) {
    const m = meteors[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.life -= 16;
    const dx = m.x - blackHole.x;
    const dy = m.y - blackHole.y;
    const d = Math.hypot(dx, dy);
    const warp = Math.max(0, (blackHole.diskOuter * 1.25 - d) / (blackHole.diskOuter * 1.25));
    const mx = mouse.x != null ? mouse.x : -99999;
    const my = mouse.y != null ? mouse.y : -99999;
    const hm = Math.max(0, 1 - Math.hypot(m.x - mx, m.y - my) / 60);
    const ex = m.x - m.vx * m.len * (1 + warp * 0.6);
    const ey = m.y - m.vy * m.len * (1 + warp * 0.6);
    const g = ctx.createLinearGradient(m.x, m.y, ex, ey);
    g.addColorStop(0, `rgba(255,200,150,${0.85 + hm * 0.15})`);
    g.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = g;
    ctx.lineWidth = 2 + warp * 2.2 + hm * 2.2;
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    if (m.life <= 0) meteors.splice(i, 1);
  }
}

function drawGas(dt) {
  gas.forEach(g => {
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.phase += dt * 0.0006;
    if (g.sw > 0) g.sw -= dt;
    const rx = g.rx * (0.9 + 0.1 * Math.sin(g.phase * g.pulse));
    const ry = g.ry * (0.9 + 0.1 * Math.cos(g.phase * g.pulse));
    const mx = mouse.x != null ? mouse.x : -99999;
    const my = mouse.y != null ? mouse.y : -99999;
    const dx = mx - g.x;
    const dy = my - g.y;
    const ed = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry * 0.49);
    const hv = ed <= 1 ? 0.5 : 0;
    if (hv > 0 && g.sw <= 0) {
      shockwaves.push({ x: g.x, y: g.y, r: Math.max(18, Math.min(rx, ry) * 0.3), a: 0.35, v: 0.12 });
      g.sw = 900;
    }
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.scale(1, 0.7);
    const grad = ctx.createRadialGradient(0, 0, Math.min(16, rx * 0.05), 0, 0, Math.max(rx, ry));
    grad.addColorStop(0, `hsla(${g.hue},70%,65%,${g.alpha * (1 + hv)})`);
    grad.addColorStop(0.5, `hsla(${(g.hue+40)%360},70%,55%,${g.alpha * (0.6 + hv * 0.3)})`);
    grad.addColorStop(1, `hsla(${(g.hue+80)%360},70%,45%,0)`);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * (1 + hv * 0.08), ry * (1 + hv * 0.08), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  });
}

function updateSatellites(dt) {
  const s = dt * 0.0008;
  satellites.forEach(sa => sa.a += sa.s * s);
}

function drawSatellites() {
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;
  satellites.forEach(sa => {
    const x = cx + Math.cos(sa.a) * sa.r;
    const y = cy + Math.sin(sa.a) * sa.r * 0.6;
    const mx = mouse.x != null ? mouse.x : -99999;
    const my = mouse.y != null ? mouse.y : -99999;
    const dx = x - mx;
    const dy = y - my;
    const hv = Math.max(0, 1 - (dx * dx + dy * dy) / (64 * 64));
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x, y, sa.size * (1 + hv * 1.0), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  });
}

function drawPulsar(dt) {
  if (!pulsar) return;
  pulsar.phase += dt * pulsar.speed;
  pulsar.beam += dt * pulsar.beamSpeed;
  const baseR = 3.2;
  const pulseR = 24 + 16 * Math.sin(pulsar.phase * 2.3);
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = 'rgba(255,255,240,0.95)';
  ctx.beginPath();
  ctx.arc(pulsar.x, pulsar.y, baseR, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(pulsar.x, pulsar.y, baseR, pulsar.x, pulsar.y, pulseR);
  g.addColorStop(0, 'rgba(255,255,200,0.25)');
  g.addColorStop(1, 'rgba(255,255,200,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(pulsar.x, pulsar.y, pulseR, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.translate(pulsar.x, pulsar.y);
  ctx.rotate(pulsar.beam * 0.02);
  ctx.fillStyle = 'rgba(220,240,255,0.6)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(pulseR * 1.4, -2.2);
  ctx.lineTo(pulseR * 1.4, 2.2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.globalCompositeOperation = 'source-over';
}

function updateGravity(dt) {
  if (!blackHole) return;
  const cx = blackHole.x;
  const cy = blackHole.y;
  const mx = mouse.x != null ? mouse.x : -99999;
  const my = mouse.y != null ? mouse.y : -99999;
  const md = Math.hypot(mx - cx, my - cy);
  const hb = Math.max(0, 1 - md / (blackHole.diskOuter + 28));
  const k = 0.0002 * (1 + hb * 1.6);
  const swirl = 0.00012 * (1 + hb * 1.4);
  const apply = (obj) => {
    const dx = cx - obj.x;
    const dy = cy - obj.y;
    const d2 = dx * dx + dy * dy + 400;
    const a = k / d2;
    const r = Math.sqrt(d2);
    obj.vx += dx * a * dt;
    obj.vy += dy * a * dt;
    const tx = -dy / (r || 1);
    const ty = dx / (r || 1);
    const s = swirl / (1 + r * 0.6);
    obj.vx += tx * s * dt;
    obj.vy += ty * s * dt;
  };
  stars.forEach(s => apply(s));
  dusts.forEach(d => apply(d));
  meteors.forEach(m => apply(m));
  comets.forEach(c => apply(c));
  debris.forEach(d => apply(d));
}

function drawBlackHole(dt) {
  if (!blackHole) return;
  blackHole.spin += blackHole.spinSpeed * dt;
  ctx.save();
  ctx.translate(blackHole.x, blackHole.y);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0,0,0,0.95)';
  ctx.beginPath();
  ctx.arc(0, 0, blackHole.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.rotate(blackHole.spin * 0.002);
  const r1 = blackHole.diskInner;
  const r2 = blackHole.diskOuter;
  for (let i = 0; i < 12; i++) {
    const a0 = (i / 12) * Math.PI * 2 + blackHole.spin * 0.0015;
    ctx.beginPath();
    ctx.arc(0, 0, (r1 + r2) * 0.5, a0, a0 + Math.PI * 0.12);
    ctx.strokeStyle = 'rgba(255,200,140,0.85)';
    ctx.lineWidth = r2 - r1;
    ctx.globalCompositeOperation = 'lighter';
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }
  const ringR = r2 + 14;
  const pulse = 0.5 + 0.5 * Math.sin(t * 0.002);
  const mx = mouse.x != null ? mouse.x : -99999;
  const my = mouse.y != null ? mouse.y : -99999;
  const md = Math.hypot(mx - blackHole.x, my - blackHole.y);
  const hv = Math.max(0, 1 - md / (ringR + 20));
  ctx.beginPath();
  ctx.arc(0, 0, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(210,230,255,${0.18 + 0.14 * pulse + hv * 0.25})`;
  ctx.lineWidth = 12 + hv * 4;
  ctx.globalCompositeOperation = 'lighter';
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
function drawShockwaves(dt) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const w = shockwaves[i];
    w.r += dt * w.v;
    w.a -= dt * 0.0006;
    ctx.save();
    ctx.translate(w.x, w.y);
    ctx.scale(1, 0.7);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(210,230,255,${Math.max(0, w.a)})`;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(0, 0, w.r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
    if (w.a <= 0) shockwaves.splice(i, 1);
  }
}
function spawnComet() {
  const left = Math.random() < 0.5;
  const x = left ? -120 : canvas.width + 120;
  const y = Math.random() * canvas.height * 0.6;
  const speed = 0.6 + Math.random() * 0.6;
  const vx = left ? speed : -speed;
  const vy = speed * (0.2 + Math.random() * 0.4);
  const tail = 90 + Math.random() * 120;
  const life = 4000 + Math.random() * 3000;
  comets.push({ x, y, vx, vy, tail, life, glow: 0.6 + Math.random() * 0.4, sp: 0 });
  if (comets.length > 8) comets.shift();
}

function drawComets(dt) {
  for (let i = comets.length - 1; i >= 0; i--) {
    const c = comets[i];
    c.x += c.vx * dt * 0.6;
    c.y += c.vy * dt * 0.6;
    c.life -= dt;
    const ex = c.x - c.vx * c.tail;
    const ey = c.y - c.vy * c.tail;
    const g = ctx.createLinearGradient(c.x, c.y, ex, ey);
    const mx = mouse.x != null ? mouse.x : -99999;
    const my = mouse.y != null ? mouse.y : -99999;
    const hc = Math.max(0, 1 - Math.hypot(c.x - mx, c.y - my) / 70);
    c.sp += dt * (1 + hc * 2.0);
    while (c.sp > 70) {
      c.sp -= 70;
      const sv = 0.6 + 0.6 * hc;
      const vx = c.vx * sv + rnd(-0.2, 0.2);
      const vy = c.vy * sv + rnd(-0.2, 0.2);
      const life = 500 + 400 * hc;
      const size = 1 + 1.0 * hc;
      sparks.push({ x: c.x, y: c.y, vx, vy, life, size });
      if (sparks.length > 200) sparks.splice(0, sparks.length - 200);
    }
    g.addColorStop(0, `rgba(160,200,255,${0.9 + hc * 0.2})`);
    g.addColorStop(1, 'rgba(160,200,255,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.8 + hc * 2.0;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(200,230,255,${0.9 + hc * 0.1})`;
    ctx.beginPath();
    ctx.arc(c.x, c.y, 2.5 + 1.5 * c.glow + hc * 1.2, 0, Math.PI * 2);
    ctx.fill();
    if (c.life <= 0) comets.splice(i, 1);
  }
}
function drawSparks(dt) {
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;
    const ex = s.x - s.vx * 6;
    const ey = s.y - s.vy * 6;
    const g = ctx.createLinearGradient(s.x, s.y, ex, ey);
    g.addColorStop(0, 'rgba(255,240,200,0.9)');
    g.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(0.8, s.size);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    if (s.life <= 0) sparks.splice(i, 1);
  }
}

function spawnDebris() {
  const x = Math.random() * canvas.width;
  const y = Math.random() * canvas.height;
  const vx = rnd(-0.05, 0.05);
  const vy = rnd(-0.05, 0.05);
  const size = 2 + Math.random() * 4;
  const rot = Math.random() * Math.PI * 2;
  const rv = rnd(-0.002, 0.002);
  const life = 6000 + Math.random() * 4000;
  debris.push({ x, y, vx, vy, size, rot, rv, life });
  if (debris.length > 40) debris.shift();
}

function drawDebris(dt) {
  debris.forEach(d => {
    d.x += d.vx * dt;
    d.y += d.vy * dt;
    d.rot += d.rv * dt;
    d.life -= dt;
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.rot);
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(180,180,200,0.5)';
    const dx = d.x - blackHole.x;
    const dy = d.y - blackHole.y;
    const dR = Math.hypot(dx, dy);
    const warp = Math.max(0, (blackHole.diskOuter * 1.2 - dR) / (blackHole.diskOuter * 1.2));
    ctx.fillRect(-d.size, -d.size * (0.6 + warp * 0.3), d.size * (2 + warp), d.size * (1.2 + warp * 0.5));
    ctx.restore();
  });
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    if (d.life <= 0) debris.splice(i, 1);
  }
}

function updateSatellites(dt) {
  const s = dt * 0.0008;
  satellites.forEach(sa => sa.a += sa.s * s);
}

function drawSatellites() {
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;
  satellites.forEach(sa => {
    const x = cx + Math.cos(sa.a) * sa.r;
    const y = cy + Math.sin(sa.a) * sa.r * 0.6;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.arc(x, y, sa.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  });
}

function animate() {
  const now = performance.now();
  const dt = Math.min(33, now - lastTime);
  lastTime = now;
  t += dt;
  drawBackground();
  drawGas(dt);
  drawShockwaves(dt);
  drawDust(dt);
  drawStars(dt);
  updateGravity(dt);
  updateSatellites(dt);
  drawSatellites();
  drawBlackHole(dt);
  drawPulsar(dt);
  const nowMs = Date.now();
  if (nowMs > nextMeteor) {
    const burst = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < burst; i++) spawnMeteor();
    nextMeteor = nowMs + Math.floor((Math.random() * (3500 - 1500)) + 1500);
  }
  if (nowMs > nextComet) {
    spawnComet();
    nextComet = nowMs + Math.floor((Math.random() * (9000 - 5000)) + 5000);
  }
  if (nowMs > nextDebris) {
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) spawnDebris();
    nextDebris = nowMs + Math.floor((Math.random() * (3500 - 1500)) + 1500);
  }
  drawDebris(dt);
  drawComets(dt);
  drawSparks(dt);
  drawMeteors(dt);
  requestAnimationFrame(animate);
}

initParticles();
