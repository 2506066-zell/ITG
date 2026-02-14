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
    { name: 'mercury', radius: 90, speed: 0.015, size: 6, angle: Math.random() * Math.PI * 2 },
    { name: 'venus', radius: 130, speed: 0.011, size: 10, angle: Math.random() * Math.PI * 2 },
    { name: 'earth', radius: 180, speed: 0.008, size: 11, angle: Math.random() * Math.PI * 2 },
    { name: 'mars', radius: 230, speed: 0.006, size: 8, angle: Math.random() * Math.PI * 2 },
    { name: 'jupiter', radius: 310, speed: 0.004, size: 24, angle: Math.random() * Math.PI * 2 },
    { name: 'saturn', radius: 390, speed: 0.003, size: 20, angle: Math.random() * Math.PI * 2 },
    { name: 'uranus', radius: 470, speed: 0.002, size: 14, angle: Math.random() * Math.PI * 2 },
    { name: 'neptune', radius: 550, speed: 0.0015, size: 14, angle: Math.random() * Math.PI * 2 }
];

let canvas, ctx;
let centerX, centerY;
let nodes = [];

function init() {
    console.log('🚀 Solar System Init - Sun at:', SUN_X_RATIO, SUN_Y_RATIO);
    const container = document.getElementById('solar-system-layer');
    if (!container) {
        console.error('❌ Solar System Layer Container NOT found!');
        return;
    }
    canvas = document.getElementById('orbit-canvas');
    ctx = canvas.getContext('2d');

    // Create Planet Nodes
    PLANETS.forEach(p => {
        const el = document.createElement('div');
        el.className = `planet-node ${p.name}`;
        container.appendChild(el);
        nodes.push({ ...p, el });
    });

    handleResize();
    window.addEventListener('resize', handleResize);

    requestAnimationFrame(loop);
}

function handleResize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    centerX = window.innerWidth * SUN_X_RATIO;
    centerY = window.innerHeight * SUN_Y_RATIO;
    drawOrbits();
}

function drawOrbits() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;

    nodes.forEach(p => {
        ctx.beginPath();
        // ctx.ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle)
        ctx.ellipse(centerX, centerY, p.radius, p.radius * GLOBAL_ELLIPSE, 0, 0, Math.PI * 2);
        ctx.stroke();
    });
}

function loop() {
    nodes.forEach(p => {
        // Kinematic Model: Physics based angle increment
        p.angle += p.speed;

        // Calculate Position
        const x = centerX + Math.cos(p.angle) * p.radius;
        const y = centerY + Math.sin(p.angle) * p.radius * GLOBAL_ELLIPSE;

        // Apply Transform: translate3d for 60FPS performance
        p.el.style.transform = `translate3d(${x - p.size / 2}px, ${y - p.size / 2}px, 0)`;
    });

    requestAnimationFrame(loop);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
