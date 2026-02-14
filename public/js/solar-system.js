/**
 * 🪐 PRECISION SOLAR SYSTEM RENDERER
 * Contract: Non-intrusive 60FPS background animation.
 */

// 1. CALIBRATION CONSTANTS (Center to Sun in reference image)
const SUN_X_RATIO = 0.505;
const SUN_Y_RATIO = 0.44;
const GLOBAL_ELLIPSE = 0.51; // Vertical squash to match image perspective

console.log('🪐 Solar System Layer Initializing...');

const PLANETS = [
    { name: 'mercury', radius: 90, speed: 0.015, size: 6, angle: Math.random() * Math.PI * 2, label: 'Mercury', msg: 'Cepat, setia, selalu kembali.' },
    { name: 'venus', radius: 130, speed: 0.011, size: 10, angle: Math.random() * Math.PI * 2, label: 'Venus', msg: 'Cantik, hangat, penuh cahaya.' },
    { name: 'earth', radius: 180, speed: 0.008, size: 11, angle: Math.random() * Math.PI * 2, label: 'Earth', msg: 'Kamu adalah rumahku.' },
    { name: 'mars', radius: 230, speed: 0.006, size: 8, angle: Math.random() * Math.PI * 2, label: 'Mars', msg: 'Berani, lembut, tak pernah menyerah.' },
    { name: 'jupiter', radius: 310, speed: 0.004, size: 24, angle: Math.random() * Math.PI * 2, label: 'Jupiter', msg: 'Besar, melindungi, selalu hangat.' },
    { name: 'saturn', radius: 390, speed: 0.003, size: 20, angle: Math.random() * Math.PI * 2, label: 'Saturn', msg: 'Elegan, berkelas, ber-cincin cantik.' },
    { name: 'uranus', radius: 470, speed: 0.002, size: 14, angle: Math.random() * Math.PI * 2, label: 'Uranus', msg: 'Tenang, dingin, selalu meneduhkan.' },
    { name: 'neptune', radius: 550, speed: 0.0015, size: 14, angle: Math.random() * Math.PI * 2, label: 'Neptune', msg: 'Dalam, misterius, memikat hati.' }
];

let canvas, ctx;
let centerX, centerY;
let nodes = [];
let mouseX = null, mouseY = null;
let starCanvas, starCtx;
let stars = [];
let milkyCanvas = null, milkyCtx = null;
let constellationAlpha = 0;
let asteroids = [];
let moon = { angle: Math.random() * Math.PI * 2, speed: 0.03, radius: 14, size: 4, el: null };
let lastPositions = {};
let ellipseRatio = GLOBAL_ELLIPSE;
let orbitMaxX = 0;
let orbitMaxY = 0;
let solarNebulaLevel = 0;
let solarNebulaTarget = 0;
const ASTRO = {
    mercury: { radiusKm: 2439.7, rotHours: 1407.6, au: 0.39 },
    venus: { radiusKm: 6051.8, rotHours: -5832, au: 0.72 },
    earth: { radiusKm: 6371, rotHours: 24, au: 1.0 },
    mars: { radiusKm: 3389.5, rotHours: 24.6, au: 1.52 },
    jupiter: { radiusKm: 69911, rotHours: 9.9, au: 5.2 },
    saturn: { radiusKm: 58232, rotHours: 10.7, au: 9.58 },
    uranus: { radiusKm: 25362, rotHours: -17.2, au: 19.2 },
    neptune: { radiusKm: 24622, rotHours: 16.1, au: 30.05 }
};
const COMET = {
    angle: Math.random() * Math.PI * 2,
    radius: 640,
    speed: 0.0056,
    size: 7,
    tail: 180
};

function init() {
    console.log('🚀 Solar System Init - Sun at:', SUN_X_RATIO, SUN_Y_RATIO);
    const container = document.getElementById('solar-system-layer');
    if (!container) {
        console.error('❌ Solar System Layer Container NOT found!');
        return;
    }
    canvas = document.getElementById('orbit-canvas');
    ctx = canvas.getContext('2d');
    starCanvas = document.getElementById('starfield-canvas');
    starCtx = starCanvas.getContext('2d');

    PLANETS.forEach(p => {
        const el = document.createElement('div');
        el.className = `planet-node ${p.name}`;
        container.appendChild(el);
        const tip = document.createElement('div');
        tip.className = 'planet-tooltip';
        tip.textContent = `${p.label}: ${p.msg}`;
        container.appendChild(tip);
        const surf = document.createElement('div');
        surf.className = 'planet-surface';
        el.appendChild(surf);
        const cloud = document.createElement('div');
        cloud.className = 'cloud-layer';
        el.appendChild(cloud);
        const terminator = document.createElement('div');
        terminator.className = 'terminator-layer';
        el.appendChild(terminator);
        nodes.push({ ...p, el, tip, surf, cloud, terminator, scale: 1, rot: 0, rotSpeed: 0 });
    });
    refineOrbitSpeeds();
    const earth = nodes.find(n => n.name === 'earth');
    if (earth) {
        const mel = document.createElement('div');
        mel.className = 'moon';
        earth.el.appendChild(mel);
        moon.el = mel;
    }
    addSatellites();

    handleResize();
    window.addEventListener('resize', handleResize);
    window.addEventListener('mousemove', (e) => {
        mouseX = e.clientX;
        mouseY = e.clientY;
    });
    window.addEventListener('mouseleave', () => {
        mouseX = null;
        mouseY = null;
    });

    requestAnimationFrame(loop);
}

window.addEventListener('sun-emit', e => {
    const s = (e && e.detail && typeof e.detail.strength === 'number') ? e.detail.strength : 0.8;
    solarNebulaTarget = Math.min(1, 0.25 + 0.75 * s);
});

function handleResize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    starCanvas.width = window.innerWidth;
    starCanvas.height = window.innerHeight;
    const isLogin = document.body && document.body.classList && document.body.classList.contains('login-page');
    const cxRatio = isLogin ? 0.5 : SUN_X_RATIO;
    const cyRatio = isLogin ? 0.5 : SUN_Y_RATIO;
    centerX = window.innerWidth * cxRatio;
    centerY = window.innerHeight * cyRatio;
    if (isLogin) {
        const m = Math.min(window.innerWidth, window.innerHeight) * 0.04;
        orbitMaxX = (window.innerWidth / 2) - m;
        orbitMaxY = (window.innerHeight / 2) - m;
        ellipseRatio = orbitMaxY / orbitMaxX;
    } else {
        orbitMaxX = Math.min(canvas.width, canvas.height) * 0.52;
        orbitMaxY = orbitMaxX * GLOBAL_ELLIPSE;
        ellipseRatio = GLOBAL_ELLIPSE;
    }
    refineSizesAndDistances();
    buildMilkyWayTexture();
    drawOrbits();
    generateStars();
    generateAsteroids();
    generatePlanetTextures();
}

function drawOrbits() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const isLogin = document.body && document.body.classList && document.body.classList.contains('login-page');
    ctx.strokeStyle = isLogin ? 'rgba(255, 255, 255, 0.14)' : 'rgba(255, 255, 255, 0.08)';
    const n = nodes.length;

    nodes.forEach((p, i) => {
        ctx.beginPath();
        if (isLogin) {
            const t = n <= 1 ? 0 : (i / (n - 1));
            const lw = 1.3 - 0.6 * t;
            ctx.lineWidth = Math.max(0.7, lw);
        } else {
            ctx.lineWidth = 1;
        }
        ctx.ellipse(centerX, centerY, p.radius, p.radius * ellipseRatio, 0, 0, Math.PI * 2);
        ctx.stroke();
    });
}

function generateStars() {
    const count = Math.min(900, Math.floor((window.innerWidth * window.innerHeight) / 3000));
    stars = Array.from({ length: count }, () => {
        const t = Math.random();
        let col;
        if (t < 0.45) col = [185 + Math.floor(Math.random()*30), 210 + Math.floor(Math.random()*30), 255];
        else if (t < 0.8) col = [220, 230, 245];
        else col = [255, 240 + Math.floor(Math.random()*10), 200 + Math.floor(Math.random()*25)];
        return {
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            r: 0.2 + Math.random() * 1.2,
            base: 0.12 + Math.random() * 0.32,
            freq: 0.6 + Math.random() * 1.5,
            phase: Math.random() * Math.PI * 2,
            rC: col[0], gC: col[1], bC: col[2]
        };
    });
}

function drawStarfield(t) {
    starCtx.clearRect(0, 0, starCanvas.width, starCanvas.height);
    const rx = ((mouseX ?? centerX) / window.innerWidth) - 0.5;
    const ry = ((mouseY ?? centerY) / window.innerHeight) - 0.5;
    const px = -rx * 18;
    const py = -ry * 10;
    starCtx.save();
    starCtx.translate(px, py);
    starCtx.globalCompositeOperation = 'lighter';
    for (const s of stars) {
        const a = s.base + 0.45 * Math.max(0, Math.sin(t * s.freq + s.phase));
        starCtx.fillStyle = `rgba(${s.rC},${s.gC},${s.bC},${a})`;
        starCtx.beginPath();
        starCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        starCtx.fill();
    }
    ['jupiter','saturn'].forEach(name => {
        const pos = lastPositions[name];
        if (pos) {
            const gx = pos.x - px;
            const gy = pos.y - py;
            const r = 50 + pos.size * 2;
            const g = starCtx.createRadialGradient(gx, gy, 0, gx, gy, r);
            g.addColorStop(0, 'rgba(0,0,0,0.08)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            starCtx.fillStyle = g;
            starCtx.beginPath();
            starCtx.arc(gx, gy, r, 0, Math.PI * 2);
            starCtx.fill();
        }
    });
    starCtx.restore();
    starCtx.globalCompositeOperation = 'source-over';
}

function drawSolarNebula(t) {
    const rx = ((mouseX ?? centerX) / window.innerWidth) - 0.5;
    const ry = ((mouseY ?? centerY) / window.innerHeight) - 0.5;
    const px = -rx * 12;
    const py = -ry * 8;
    const sx = centerX - px;
    const sy = centerY - py;
    solarNebulaLevel += (solarNebulaTarget - solarNebulaLevel) * 0.08;
    solarNebulaTarget = Math.max(0.0, solarNebulaTarget * 0.975);
    const L = solarNebulaLevel;
    const R = 220 + 120 * L;
    starCtx.save();
    starCtx.globalCompositeOperation = 'screen';
    starCtx.translate(sx, sy);
    starCtx.scale(1, ellipseRatio);
    const g = starCtx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0.0, `rgba(255,235,180,${0.18 * L})`);
    g.addColorStop(0.35, `rgba(255,205,120,${0.12 * L})`);
    g.addColorStop(0.7, `rgba(255,150,70,${0.08 * L})`);
    g.addColorStop(1.0, 'rgba(255,120,50,0)');
    starCtx.fillStyle = g;
    starCtx.beginPath();
    starCtx.arc(0, 0, R, 0, Math.PI * 2);
    starCtx.fill();
    for (let i = 0; i < 3; i++) {
        const a = (i - 1) * 0.28 + Math.sin(t * 0.3) * 0.12;
        starCtx.save();
        starCtx.rotate(a);
        starCtx.beginPath();
        starCtx.strokeStyle = `rgba(255,180,90,${0.05 * L})`;
        starCtx.lineWidth = 0.8 + 0.6 * L;
        starCtx.ellipse(0, 0, R * (0.42 + i * 0.08), R * ellipseRatio * (0.38 + i * 0.08), 0, 0, Math.PI * 2);
        starCtx.stroke();
        starCtx.restore();
    }
    starCtx.restore();
    starCtx.globalCompositeOperation = 'source-over';
}
function buildMilkyWayTexture() {
    const w = starCanvas.width;
    const h = starCanvas.height;
    const gw = Math.max(w * 0.92, 900);
    const gh = Math.max(h * 0.15, 140);
    milkyCanvas = document.createElement('canvas');
    milkyCanvas.width = Math.floor(gw);
    milkyCanvas.height = Math.floor(gh);
    milkyCtx = milkyCanvas.getContext('2d');
    const img = milkyCtx.createImageData(milkyCanvas.width, milkyCanvas.height);
    const cx = gh * 0.5;
    for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
            const i = (y * gw + x) * 4;
            const v = Math.exp(-Math.pow((y - cx) / (gh * 0.22), 2));
            const n1 = Math.sin(x * 0.012) + Math.cos(y * 0.024) + Math.sin((x + y) * 0.008);
            const n2 = Math.sin(x * 0.06 + y * 0.03);
            const nf = 0.5 + 0.5 * Math.max(-1, Math.min(1, 0.6 * n1 + 0.4 * n2));
            const f = v * (0.65 + 0.35 * nf);
            const warm = 0.4 + 0.6 * Math.exp(-Math.pow((y - cx) / (gh * 0.18), 2));
            const r = Math.min(255, Math.round((120 * warm + 60) * f));
            const g = Math.min(255, Math.round((140 + 20 * warm) * f));
            const b = Math.min(255, Math.round(200 * f));
            const a = Math.round(255 * Math.min(0.32, f * 0.25));
            img.data[i] = r;
            img.data[i + 1] = g;
            img.data[i + 2] = b;
            img.data[i + 3] = a;
        }
    }
    milkyCtx.putImageData(img, 0, 0);
    milkyCtx.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 18; i++) {
        const yy = gh * (0.32 + Math.random() * 0.36);
        const len = gw * (0.12 + Math.random() * 0.22);
        const lw = 6 + Math.random() * 18;
        const x0 = Math.random() * (gw - len);
        milkyCtx.strokeStyle = 'rgba(20,20,30,0.55)';
        milkyCtx.lineWidth = lw;
        milkyCtx.beginPath();
        milkyCtx.moveTo(x0, yy + Math.sin(x0 * 0.01) * 2);
        milkyCtx.lineTo(x0 + len, yy + Math.sin((x0 + len) * 0.01) * 2);
        milkyCtx.stroke();
    }
    milkyCtx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 90; i++) {
        const sx = Math.random() * gw;
        const sy = gh * (0.32 + Math.random() * 0.36) + (Math.random() - 0.5) * 12;
        const sr = 0.6 + Math.random() * 1.6;
        const g = milkyCtx.createRadialGradient(sx, sy, 0, sx, sy, sr * 3);
        const a = 0.18 + Math.random() * 0.35;
        g.addColorStop(0, `rgba(240,240,255,${a})`);
        g.addColorStop(1, 'rgba(240,240,255,0)');
        milkyCtx.fillStyle = g;
        milkyCtx.beginPath();
        milkyCtx.arc(sx, sy, sr * 3, 0, Math.PI * 2);
        milkyCtx.fill();
    }
    milkyCtx.globalCompositeOperation = 'source-over';
}
function drawMilkyWay(t) {
    const rx = ((mouseX ?? centerX) / window.innerWidth) - 0.5;
    const ry = ((mouseY ?? centerY) / window.innerHeight) - 0.5;
    const px = -rx * 6;
    const py = -ry * 4;
    const w = starCanvas.width;
    const h = starCanvas.height;
    if (!milkyCanvas) return;
    starCtx.save();
    starCtx.globalCompositeOperation = 'screen';
    starCtx.translate(w * 0.5 + px, h * 0.6 + py);
    starCtx.rotate(-0.34);
    const alpha = 0.85;
    starCtx.globalAlpha = alpha;
    starCtx.drawImage(milkyCanvas, -milkyCanvas.width / 2, -milkyCanvas.height / 2);
    starCtx.globalAlpha = 1;
    starCtx.restore();
    starCtx.globalCompositeOperation = 'source-over';
}
function generateAsteroids() {
    const count = 650;
    const baseR = 250;
    const span = 70;
    asteroids = Array.from({ length: count }, () => ({
        angle: Math.random() * Math.PI * 2,
        radius: baseR + Math.random() * span,
        size: 0.6 + Math.random() * 1.1,
        phase: Math.random() * Math.PI * 2
    }));
}

function drawAsteroidBelt(t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const a of asteroids) {
        const ax = centerX + Math.cos(a.angle) * a.radius;
        const ay = centerY + Math.sin(a.angle) * a.radius * ellipseRatio;
        const al = 0.08 + 0.12 * Math.max(0, Math.sin(t * 1.3 + a.phase));
        ctx.beginPath();
        ctx.fillStyle = `rgba(200,220,255,${al})`;
        ctx.arc(ax, ay, a.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function buildConstellationPaths() {
    const w = starCanvas.width;
    const h = starCanvas.height;
    const s = Math.max(0.5, Math.min(1.0, w * 0.0006));
    const letterW = 80 * s;
    const letterH = 100 * s;
    const spacing = letterW + 28 * s;
    const startX = w * 0.62;
    const baseY = h * 0.08;
    function map(px, py, ox) {
        return [startX + ox + px * letterW, baseY + py * letterH];
    }
    const paths = [];
    let off = 0;
    paths.push([[0,0],[0,1]].map(([x,y])=>map(x,y,off)));
    paths.push([[0,0],[1,1]].map(([x,y])=>map(x,y,off)));
    paths.push([[1,0],[1,1]].map(([x,y])=>map(x,y,off)));
    off += spacing;
    paths.push([[0,0],[0,1]].map(([x,y])=>map(x,y,off)));
    paths.push([[0,0],[1,0]].map(([x,y])=>map(x,y,off)));
    paths.push([[0,0.5],[0.7,0.5]].map(([x,y])=>map(x,y,off)));
    paths.push([[0,1],[1,1]].map(([x,y])=>map(x,y,off)));
    off += spacing;
    paths.push([[0.1,0],[0.9,0],[0.9,0.5],[0.1,0.5],[0.1,1],[0.9,1]].map(([x,y])=>map(x,y,off)));
    off += spacing;
    paths.push([[0,0],[0.5,0.5]].map(([x,y])=>map(x,y,off)));
    paths.push([[1,0],[0.5,0.5]].map(([x,y])=>map(x,y,off)));
    paths.push([[0.5,0.5],[0.5,1]].map(([x,y])=>map(x,y,off)));
    off += spacing;
    paths.push([[0,1],[0.5,0],[1,1]].map(([x,y])=>map(x,y,off)));
    paths.push([[0.25,0.6],[0.75,0.6]].map(([x,y])=>map(x,y,off)));
    return paths;
}

function drawConstellation(t) {
    constellationAlpha = Math.min(0.25, constellationAlpha + 0.004);
    const paths = buildConstellationPaths();
    starCtx.save();
    const rx = ((mouseX ?? centerX) / window.innerWidth) - 0.5;
    const ry = ((mouseY ?? centerY) / window.innerHeight) - 0.5;
    const px = -rx * 7.5;
    const py = -ry * 4;
    starCtx.translate(px, py);
    starCtx.globalCompositeOperation = 'screen';
    starCtx.lineWidth = 0.8;
    starCtx.setLineDash([2, 12]);
    starCtx.shadowBlur = 2;
    starCtx.shadowColor = `rgba(160,190,255,${0.4 * constellationAlpha})`;
    for (const p of paths) {
        starCtx.strokeStyle = `rgba(180,200,255,${0.1 * constellationAlpha})`;
        starCtx.beginPath();
        starCtx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length; i++) {
            starCtx.lineTo(p[i][0], p[i][1]);
        }
        starCtx.stroke();
        for (const [x,y] of p) {
            starCtx.beginPath();
            starCtx.fillStyle = `rgba(220,235,255,${0.25 * constellationAlpha})`;
            starCtx.arc(x, y, 0.6, 0, Math.PI * 2);
            starCtx.fill();
        }
    }
    starCtx.setLineDash([]);
    starCtx.restore();
}
function drawComet() {
    // Head position
    const hx = centerX + Math.cos(COMET.angle) * COMET.radius;
    const hy = centerY + Math.sin(COMET.angle) * COMET.radius * ellipseRatio;
    const tx = hx - Math.cos(COMET.angle) * COMET.tail;
    const ty = hy - Math.sin(COMET.angle) * COMET.tail * ellipseRatio;
    const near = mouseX == null ? 0 : Math.max(0, 1 - (Math.hypot(mouseX - hx, mouseY - hy) / 160));

    // Clear canvas and redraw orbits
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 1.2;
    nodes.forEach(p => {
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, p.radius, p.radius * ellipseRatio, 0, 0, Math.PI * 2);
        ctx.stroke();
    });
    drawAsteroidBelt(performance.now() * 0.001);

    // Draw comet tail
    const grad = ctx.createLinearGradient(hx, hy, tx, ty);
    grad.addColorStop(0, `rgba(180, 220, 255, ${0.85 + near * 0.1})`);
    grad.addColorStop(1, `rgba(100, 150, 255, 0)`);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.6 + near * 2.2;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = grad;
    ctx.stroke();

    // Draw comet head
    ctx.beginPath();
    ctx.fillStyle = `rgba(200, 230, 255, ${0.9})`;
    ctx.arc(hx, hy, COMET.size + near * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
}

function loop() {
    const t = performance.now() * 0.001;
    drawMilkyWay(t);
    drawConstellation(t);
    drawStarfield(t);
    drawSolarNebula(t);
    nodes.forEach(p => {
        // Kinematic Model: Physics based angle increment
        p.angle += p.speed;

        // Calculate Position
        const x = centerX + Math.cos(p.angle) * p.radius;
        const y = centerY + Math.sin(p.angle) * p.radius * GLOBAL_ELLIPSE;
        lastPositions[p.name] = { x, y, size: p.size };

        // Hover proximity
        let hv = 0;
        if (mouseX != null && mouseY != null) {
            const d = Math.hypot(mouseX - x, mouseY - y);
            const threshold = 60 + p.size;
            hv = Math.max(0, 1 - d / threshold);
        }

        // Pulse term (only when sufficiently hovered)
        const pulse = hv > 0.6 ? (0.06 * (0.5 + 0.5 * Math.sin(t * 6 + p.radius * 0.01))) : 0;

        // Apply Transform: translate3d + scale for 60FPS performance
        const scale = 1 + hv * 0.25 + pulse;
        p.el.style.transform = `translate3d(${x - p.size / 2}px, ${y - p.size / 2}px, 0) scale(${scale})`;
        const blur = 12 + hv * 10 + pulse * 40;
        const alpha = Math.min(0.9, Math.max(0.05, 0.08 + hv * 0.18 + pulse * 0.25));
        p.el.style.filter = `drop-shadow(0 0 ${blur}px rgba(255,255,255,${alpha}))`;
        const dx = centerX - x;
        const dy = centerY - y;
        const m = Math.hypot(dx, dy) || 1;
        const nx = dx / m;
        const ny = dy / m;
        const lx = 50 + nx * 35;
        const ly = 50 + ny * 35;
        p.el.style.setProperty('--light-x', `${lx}%`);
        p.el.style.setProperty('--light-y', `${ly}%`);
        const shade = 0.45 + 0.35 * Math.max(0, (nx*0.5 + ny*0.5));
        p.el.style.setProperty('--shade', `${Math.min(0.85, Math.max(0.2, shade))}`);
        const show = hv > 0.5;
        const tipOpacity = show ? Math.min(1, (hv - 0.5) * 2) : 0;
        const tx = x + p.size * 0.6;
        const ty = y - p.size * 0.6 - 18;
        p.tip.style.opacity = `${tipOpacity}`;
        p.tip.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
        p.rot += p.rotSpeed;
        if (p.surf) p.surf.style.transform = `rotate(${p.rot}deg)`;
        if (p.cloud) p.cloud.style.transform = `rotate(${p.rot * 1.2}deg)`;
        if (p.name === 'earth' && moon.el) {
            moon.angle += moon.speed;
            const mx = Math.cos(moon.angle) * moon.radius;
            const my = Math.sin(moon.angle) * moon.radius * ellipseRatio;
            const ox = (p.size / 2) + mx - (moon.size / 2);
            const oy = (p.size / 2) + my - (moon.size / 2);
            moon.el.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
        }
        if (p.sats) {
            p.sats.forEach(s => {
                s.angle += s.s;
                const mx = Math.cos(s.angle) * s.r;
                const my = Math.sin(s.angle) * s.r * ellipseRatio;
                const ox = (p.size / 2) + mx - (s.size / 2);
                const oy = (p.size / 2) + my - (s.size / 2);
                s.el.style.transform = `translate3d(${ox}px, ${oy}px, 0)`;
            });
        }
    });

    // Advance comet
    COMET.angle += COMET.speed;
    drawComet();

    requestAnimationFrame(loop);
}

function refineOrbitSpeeds() {
    const K = 19.3;
    nodes.forEach(p => {
        const s = K / Math.pow(p.radius, 1.5);
        p.speed = Math.max(0.001, Math.min(0.022, s));
    });
}

function refineSizesAndDistances() {
    // Base orbit computed from viewport to keep linear AU structure intact
    const maxAU = Math.max(...Object.values(ASTRO).map(d => d.au));
    const minAU = Math.min(...Object.values(ASTRO).map(d => d.au));
    const baseSize = 11;
    const earthR = 6371;
    const isLogin = document.body && document.body.classList && document.body.classList.contains('login-page');
    const orbitMult = 1;
    const sizeMult = isLogin ? 2.6 : 1;
    let maxR = isLogin ? orbitMaxX : Math.min(canvas.width, canvas.height) * (0.52);
    const baseOrbit = (maxR / maxAU) * orbitMult;
    const n = nodes.length;
    const minDim = Math.min(canvas.width, canvas.height);
    const minRLogin = Math.max(100, minDim * 0.13);
    const spanLogin = Math.max(40, maxR - minRLogin);
    const outMargin = isLogin ? Math.max(6, Math.min(18, minDim * 0.010)) : 0;
    let compressF = isLogin ? ((maxR - outMargin - minRLogin) / (spanLogin || 1)) : 1;
    compressF = Math.max(0.68, Math.min(1.0, compressF));
    const gamma = 1.22;
    const radii = new Array(n);
    nodes.forEach((p, i) => {
        const d = ASTRO[p.name];
        if (!d) return;
        const k = d.radiusKm / earthR;
        const sizeRaw = baseSize * sizeMult * Math.pow(k, 0.35);
        const maxSize = isLogin ? 54 : 26;
        p.size = Math.max(6, Math.min(maxSize, Math.round(sizeRaw)));
        p.el.style.setProperty('--size', `${p.size}px`);
        const hours = d.rotHours;
        const rotPerSec = 360 / (Math.abs(hours) * 3600);
        p.rotSpeed = rotPerSec * 1200 * (hours < 0 ? -1 : 1);
        if (isLogin) {
            const t = (d.au - minAU) / (maxAU - minAU || 1);
            const r = minRLogin + spanLogin * compressF * Math.max(0, Math.min(1, t));
            radii[i] = Math.min(maxR, r);
        } else {
            const r = baseOrbit * d.au;
            radii[i] = Math.min(maxR, r);
        }
    });
    // Adjust inner planet spacing (Mercury..Mars)
    if (isLogin) {
        const jIndex = nodes.findIndex(p => p.name === 'jupiter');
        const minGapInner = 36;
        const minGapOuter = 26;
        const minGapJupiter = 42;
        for (let i = 1; i <= 3; i++) {
            if (radii[i] < radii[i - 1] + minGapInner) {
                radii[i] = radii[i - 1] + minGapInner;
            }
        }
        for (let i = 4; i < n; i++) {
            const need = (i === jIndex) ? Math.max(minGapOuter, minGapJupiter) : minGapOuter;
            if (radii[i] < radii[i - 1] + need) {
                radii[i] = radii[i - 1] + need;
            }
        }
        const base = radii[3];
        let last = radii[n - 1];
        const targetMax = maxR - outMargin;
        if (last !== targetMax) {
            const span = last - base;
            const targetSpan = Math.max(minGapOuter * (n - 4), targetMax - base);
            const scale = (span === 0) ? 1 : (targetSpan / span);
            for (let i = 4; i < n; i++) {
                radii[i] = base + (radii[i] - base) * scale;
                const need = (i === jIndex) ? Math.max(minGapOuter, minGapJupiter) : minGapOuter;
                if (i > 4 && radii[i] < radii[i - 1] + need) {
                    radii[i] = radii[i - 1] + need;
                }
            }
            const needN = minGapOuter;
            radii[n - 1] = Math.min(targetMax, Math.max(radii[n - 2] + needN, radii[n - 1]));
        }
        for (let i = 4; i < n; i++) {
            const need = (i === jIndex) ? Math.max(minGapOuter, minGapJupiter) : minGapOuter;
            if (radii[i] < radii[i - 1] + need) {
                radii[i] = radii[i - 1] + need;
            }
        }
    }
    // Assign back
    nodes.forEach((p, i) => { p.radius = radii[i]; });
}

function addSatellites() {
    const satData = {
        mars: [{ r: 8, s: 0.06, size: 2 }, { r: 12, s: 0.04, size: 2 }],
        jupiter: [
            { r: 20, s: 0.05, size: 3 },
            { r: 24, s: 0.042, size: 3 },
            { r: 28, s: 0.038, size: 3 },
            { r: 34, s: 0.035, size: 3 }
        ],
        saturn: [{ r: 22, s: 0.045, size: 3 }]
    };
    nodes.forEach(p => {
        if (satData[p.name]) {
            p.sats = satData[p.name].map(d => {
                const el = document.createElement('div');
                el.className = 'sat';
                el.style.width = `${d.size}px`;
                el.style.height = `${d.size}px`;
                p.el.appendChild(el);
                return { el, angle: Math.random()*Math.PI*2, r: d.r, s: d.s, size: d.size };
            });
        }
    });
}

function generatePlanetTextures() {
    nodes.forEach(p => {
        const t = createTextureFor(p.name, p.size);
        if (p.surf) p.surf.style.backgroundImage = `url(${t.base})`;
        if (p.cloud) p.cloud.style.backgroundImage = `url(${t.cloud})`;
    });
}

function createTextureFor(name, size) {
    const dim = Math.max(128, Math.min(256, size*12));
    const base = document.createElement('canvas');
    base.width = dim; base.height = dim;
    const bctx = base.getContext('2d');
    const cloud = document.createElement('canvas');
    cloud.width = dim; cloud.height = dim;
    const cctx = cloud.getContext('2d');
    function noise(ctx, colorA, colorB, bands=0) {
        const img = ctx.createImageData(dim, dim);
        for (let y=0;y<dim;y++){
            for(let x=0;x<dim;x++){
                const i = (y*dim + x)*4;
                const n = Math.sin(x*0.07)+Math.cos(y*0.05)+Math.sin((x+y)*0.03);
                const m = 0.5 + 0.5*Math.sin(x*0.02 + y*0.025);
                const t = Math.max(0, Math.min(1, 0.5 + 0.35*n + 0.15*m));
                img.data[i] = Math.round(colorA[0]*t + colorB[0]*(1-t));
                img.data[i+1] = Math.round(colorA[1]*t + colorB[1]*(1-t));
                img.data[i+2] = Math.round(colorA[2]*t + colorB[2]*(1-t));
                img.data[i+3] = 255;
            }
        }
        ctx.putImageData(img,0,0);
        if (bands>0){
            ctx.globalAlpha = 0.35;
            for(let y=0;y<dim;y+=Math.max(6, Math.floor(dim/bands))){
                ctx.fillStyle = 'rgba(255,255,255,0.08)';
                ctx.fillRect(0,y,dim,Math.max(2, Math.floor(dim/(bands*3))));
            }
            ctx.globalAlpha = 1;
        }
    }
    if (name==='earth'){
        noise(bctx,[40,100,180],[10,50,90],0);
        bctx.globalAlpha=0.35; noise(bctx,[40,160,80],[20,80,40],0); bctx.globalAlpha=1;
        noise(cctx,[255,255,255],[200,200,200],0);
    } else if (name==='jupiter'){
        noise(bctx,[205,165,135],[180,140,115],36);
        bctx.fillStyle='rgba(190,80,60,0.6)';
        bctx.beginPath(); bctx.ellipse(dim*0.65, dim*0.55, dim*0.12, dim*0.08, 0, 0, Math.PI*2); bctx.fill();
        noise(cctx,[255,255,255],[210,210,210],0);
    } else if (name==='saturn'){
        noise(bctx,[200,175,120],[170,145,100],28);
        noise(cctx,[255,255,255],[220,220,220],0);
    } else if (name==='mars'){
        noise(bctx,[200,110,70],[160,80,50],0);
        noise(cctx,[255,255,255],[220,220,220],0);
    } else if (name==='venus'){
        noise(bctx,[230,190,120],[200,170,100],0);
        noise(cctx,[255,255,255],[230,230,230],0);
    } else if (name==='uranus'){
        noise(bctx,[170,220,230],[140,200,210],0);
        noise(cctx,[255,255,255],[230,230,230],0);
    } else if (name==='neptune'){
        noise(bctx,[100,130,255],[80,100,200],0);
        noise(cctx,[255,255,255],[220,220,220],0);
    } else {
        noise(bctx,[180,180,180],[120,120,120],0);
        noise(cctx,[255,255,255],[220,220,220],0);
    }
    return { base: base.toDataURL('image/png'), cloud: cloud.toDataURL('image/png') };
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
