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
  t += 16;
  drawBackground();
  drawDust(1);
  drawStars(1);
  const now = Date.now();
  if (now > nextMeteor) {
    spawnMeteor();
    nextMeteor = now + Math.floor((Math.random() * (16000 - 8000)) + 8000);
  }
  drawMeteors(1);
  requestAnimationFrame(animate);
}

initParticles();
